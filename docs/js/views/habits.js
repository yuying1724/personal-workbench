import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { state, subscribe, notify } from '../store.js';
import { write, saveRow, deleteRow, systemName } from '../data.js';
import { openSheet, confirmDialog, withBusy, errorText, toast } from '../ui.js';
import { habitFreqLabel, uniqueValues, HABIT_TIME_OPTIONS, HABIT_TIME_ICON, todayStr, dateLabel, pct } from '../util.js';
import { heatmap, heatLegend, isRequiredDay, valueText, doneDays } from './heatmap.js';
import WbLogic from '../shared-logic.js';
import {
  pageHead, stats, empty, viewState, searchBox, filterSelect, textField, selectField, checkField, segField, weekdayPicker, formFooter, errorBanner,
} from './common.js';

function tierBadge(tier) {
  if (tier === '超標') return h('span', { class: 'badge warn' }, icon('trophy'), ' 超標');
  if (tier === '達標') return h('span', { class: 'badge' }, icon('awardFill'), ' 達標');
  if (tier === '基礎') return h('span', { class: 'badge bronze' }, icon('award'), ' 基礎');
  return null;
}

/** 單一習慣列（今日打卡、首頁、習慣管理共用）。showEdit=true 時點整列開編輯表單 */
export function habitRow(hb, opts = {}) {
  const id = hb['習慣ID'];
  const isCount = hb['類型'] === '計數';
  const isWeekly = hb['頻率類型'] === 'weeklyCount';
  const done = hb['今日已完成'];
  const target = Number(hb['目標值']) || 1;
  const todayVal = Number(hb['今日數值']) || 0;
  const unit = isWeekly ? '週' : '天';

  let control;
  if (isCount) {
    const inp = h('input', { type: 'number', min: 0, class: 'count-input', value: todayVal || '', placeholder: '0', inputmode: 'numeric', 'aria-label': hb['習慣名稱'] + ' 今日數值' });
    inp.addEventListener('input', () => setHabitCount(id, inp.value));
    const step = (n) => h('button', { type: 'button', class: 'step', 'aria-label': n > 0 ? '加一' : '減一', onclick: () => { inp.value = Math.max(0, (Number(inp.value) || 0) + n) || ''; setHabitCount(id, inp.value); } }, n > 0 ? '+' : '−');
    control = h('div', { class: 'stepper' }, step(-1), inp, step(1));
  } else {
    control = h('input', { type: 'checkbox', class: 'big-check', checked: !!done, 'aria-label': hb['習慣名稱'] + ' 今日完成', onchange: (e) => toggleHabit(id, e.target.checked) });
  }

  const meta = [];
  if (hb['分類']) meta.push(hb['分類']);
  meta.push(habitFreqLabel(hb));
  if (isCount) meta.push(`今日 ${todayVal}/${target}${hb['單位'] || ''}`);
  const tb = tierBadge(hb['今日等級']);
  if (tb) meta.push(tb);
  meta.push(h('span', { class: 'streak nowrap' }, icon('fire'), ` 連續 ${hb['連續天數'] || 0} ${unit}`));
  meta.push(`最長 ${hb['最長連續'] || 0} ${unit}`);
  meta.push(`近7天 ${hb['近7天完成率'] || 0}%`);
  const withDots = [];
  meta.forEach((m, i) => { if (i) withDots.push(' · '); withDots.push(m); });

  // 管理頁點整列＝編輯；打卡頁／首頁點名稱＝看打卡月曆（可補打卡）
  const main = h('button', { type: 'button', class: 'grow item-main', onclick: () => (opts.showEdit ? openHabitForm(id) : openHabitHistory(id)) },
    h('div', { class: 't wraptext' }, hb['習慣名稱'] || '', hb['狀態'] === '封存' ? h('span', { class: 'muted' }, '（已封存）') : null),
    h('div', { class: 's wraptext' }, withDots));
  return h('div', { class: 'item habit-row' + (done ? ' done' : '') }, opts.showEdit && hb['狀態'] === '封存' ? null : control, main,
    opts.showEdit ? h('span', { class: 'muted' }, icon('chevronRight')) : null);
}

/** 依時段（早上／中午／晚上／不限）分組輸出 */
export function habitsByTime(rows, opts) {
  const groups = {};
  HABIT_TIME_OPTIONS.forEach((t) => { groups[t] = []; });
  rows.forEach((hb) => groups[HABIT_TIME_OPTIONS.includes(hb['時段']) ? hb['時段'] : '不限'].push(hb));
  return HABIT_TIME_OPTIONS.filter((t) => groups[t].length).map((t) => h('div', { class: 'card group' },
    h('div', { class: 'group-head static' }, icon(HABIT_TIME_ICON[t]), ' ', t),
    h('ul', { class: 'list' }, groups[t].map((hb) => h('li', null, habitRow(hb, opts))))));
}

// ---------- 樂觀更新：打卡先改畫面、背景送出 ----------
function habitById(id) { return (state.data.habits || []).find((x) => x['習慣ID'] === id); }
// 完成／等級的判斷跟後端是同一份程式（shared/logic.js）
const habitDoneFor = (hb, value) => WbLogic.isHabitDoneForDay(hb, value);
const habitTierFor = (hb, value) => WbLogic.habitTierForValue(hb, value);
/** 把今日數值套到本機資料（含今日完成／等級／統計的今日完成數），回傳還原函式 */
function applyHabitValue(hb, value) {
  const stats = state.data.habitStats || (state.data.habitStats = {});
  const prev = { v: hb['今日數值'], done: hb['今日已完成'], tier: hb['今日等級'], doneToday: stats.doneTodayCount };
  const done = habitDoneFor(hb, value);
  hb['今日數值'] = Number(value) || 0;
  hb['今日已完成'] = done;
  hb['今日等級'] = habitTierFor(hb, value);
  if (hb['今日應做'] && hb['狀態'] !== '封存' && done !== !!prev.done) stats.doneTodayCount = Math.max(0, (stats.doneTodayCount || 0) + (done ? 1 : -1));
  return () => { hb['今日數值'] = prev.v; hb['今日已完成'] = prev.done; hb['今日等級'] = prev.tier; stats.doneTodayCount = prev.doneToday; };
}

function pendingHabit(id) {
  if (!String(id).startsWith('tmp-')) return false;
  toast('這個習慣還在儲存中，請等幾秒再打卡');
  notify();
  return true;
}

function toggleHabit(id, checked) {
  const hb = habitById(id);
  if (!hb || pendingHabit(id)) return;
  write('set_habit_log', { '習慣ID': id, '日期': todayStr(), '數值': checked ? 1 : null }, { toast: checked ? '打卡完成' : '已取消打卡', optimistic: () => applyHabitValue(hb, checked ? 1 : 0) });
}

// 數字連續輸入／連點 +：同一個習慣 600ms 內只送最後一次，避免重複寫入（送出時才更新畫面，打字中不會被重畫打斷）
const timers = {};
function setHabitCount(id, value) {
  clearTimeout(timers[id]);
  timers[id] = setTimeout(() => {
    delete timers[id];
    const hb = habitById(id);
    if (!hb || pendingHabit(id)) return;
    write('set_habit_log', { '習慣ID': id, '日期': todayStr(), '數值': value === '' ? null : Number(value) }, { toast: '已記錄', optimistic: () => applyHabitValue(hb, value === '' ? 0 : Number(value)) });
  }, 600);
}

export function renderHabits(root) {
  const d = state.data;
  const s = d.habitStats || {};
  const today = (d.habits || []).filter((hb) => hb['狀態'] !== '封存' && hb['今日應做']);
  const sorted = [...today].sort((a, b) => Number(a['今日已完成']) - Number(b['今日已完成']));
  mount(root,
    pageHead(systemName('習慣', '習慣'), h('a', { class: 'btn btn-sm', href: '#/habit-admin' }, icon('tools'), '管理')),
    stats([['總習慣數', s.total ?? 0], ['今日進度', s.doneTodayCount ?? 0, ` / ${s.dueTodayCount ?? 0}`], ['近7天平均完成率', s.avgRate7 ?? 0, '%']]),
    h('h2', { class: 'section-title' }, '今日打卡'),
    sorted.length ? habitsByTime(sorted, {}) : h('div', { class: 'card' }, empty((d.habits || []).length ? '今天沒有排定要做的習慣' : '還沒有習慣，到「習慣管理」新增', '🌱')),
    heatSection(d.habits || []));
}

// ---------- 打卡月曆（熱力圖） ----------
function heatSection(habits) {
  const active = habits.filter((hb) => hb['狀態'] !== '封存');
  if (!active.length) return null;
  return [
    h('h2', { class: 'section-title' }, icon('calendar'), ' 打卡月曆', h('span', { class: 'muted small', style: { fontWeight: 400 } }, '（點一下看整年、補打卡）')),
    h('div', { class: 'card' }, active.map((hb) => h('button', { type: 'button', class: 'hm-item', onclick: () => openHabitHistory(hb['習慣ID']) },
      h('div', { class: 'hm-title' }, h('span', { class: 't wraptext' }, hb['習慣名稱'] || ''),
        h('span', { class: 'muted small nowrap' }, `近30天 ${pct(hb['近30天完成率'])}%`)),
      heatmap(hb, { weeks: compactWeeks(hb) })))),
  ];
}

/** 小圖顯示幾週：從建立習慣（或最早一筆打卡）那週開始，至少 12 週、最多 53 週，剛開始的習慣不會一大片空格 */
function compactWeeks(hb) {
  const days = Object.keys(hb['打卡紀錄'] || {});
  const created = String(hb['建立時間'] || '').slice(0, 10);
  const first = [created, ...days].filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort()[0];
  if (!first) return 12;
  const [y, m, d] = first.split('-').map(Number);
  const weeks = Math.ceil((Date.now() - new Date(y, m - 1, d).getTime()) / (7 * 86400000)) + 1;
  return Math.max(12, Math.min(53, weeks));
}

/** 單一習慣的整年熱力圖＋點某一天補打卡／修改 */
export function openHabitHistory(id) {
  let selected = todayStr();
  const body = h('div');
  const render = () => {
    const hb = habitById(id);
    if (!hb) { ref.close(); return; }
    const old = body.querySelector('.hm-scroll');
    const keepScroll = old ? old.scrollLeft : null; // 重畫時維持捲動位置（點了很久以前的格子不要跳回最右邊）
    const isWeekly = hb['頻率類型'] === 'weeklyCount';
    const unit = isWeekly ? '週' : '天';
    mount(body,
      h('p', { class: 'muted small', style: { margin: '-6px 0 10px' } }, [hb['分類'], habitFreqLabel(hb)].filter(Boolean).join(' · ')),
      h('div', { class: 'hm-stats' }, stats([['目前連續', hb['連續天數'] || 0, ' ' + unit], ['最長連續', hb['最長連續'] || 0, ' ' + unit],
        ['近30天完成率', pct(hb['近30天完成率']), '%'], ['近一年完成', doneDays(hb, 365, habitDoneFor), ' 天']])),
      heatmap(hb, { weeks: 53, size: 'lg', labels: true, selected, onPick: (ds) => { selected = ds; render(); } }),
      heatLegend(),
      dayPanel(hb, selected, render));
    if (keepScroll !== null) requestAnimationFrame(() => { const sc = body.querySelector('.hm-scroll'); if (sc) sc.scrollLeft = keepScroll; });
  };
  const ref = openSheet({ title: (habitById(id) || {})['習慣名稱'] || '打卡月曆', body, onClose: () => unsub() });
  // 背景重抓資料後（連續天數等統計由後端重算）自動更新這個視窗
  const unsub = subscribe(() => {
    if (!body.isConnected) return;
    const a = document.activeElement;
    if (a && body.contains(a) && a.tagName === 'INPUT') return; // 正在輸入數值時不重畫
    render();
  });
  render();
}

function dayPanel(hb, ds, rerender) {
  const id = hb['習慣ID'];
  const log = hb['打卡紀錄'] || {};
  const v = Number(log[ds]) || 0;
  const isToday = ds === todayStr();
  const head = h('div', null, h('b', null, isToday ? '今天 ' + dateLabel(ds) : dateLabel(ds)), '　',
    h('span', { class: 'muted' }, !v && !isRequiredDay(hb, ds) ? '不用做的日子' : valueText(hb, v)));
  const save = (value) => {
    write('set_habit_log', { '習慣ID': id, '日期': ds, '數值': value ? value : null }, {
      toast: value ? (isToday ? '已記錄' : `已補記 ${dateLabel(ds)}`) : '已取消打卡',
      optimistic: () => {
        const cur = habitById(id);
        if (!cur) return null;
        const map = cur['打卡紀錄'] = Object.assign({}, cur['打卡紀錄'] || {});
        const prev = map[ds];
        if (value) map[ds] = value; else delete map[ds];
        const undoToday = isToday ? applyHabitValue(cur, value || 0) : null;
        return () => { if (prev === undefined) delete map[ds]; else map[ds] = prev; if (undoToday) undoToday(); };
      },
    });
    rerender();
  };
  let control;
  if (hb['類型'] === '計數') {
    const inp = h('input', { type: 'number', min: 0, class: 'count-input', value: v || '', placeholder: '0', inputmode: 'numeric', 'aria-label': '數值' });
    const step = (n) => h('button', { type: 'button', class: 'step', 'aria-label': n > 0 ? '加一' : '減一', onclick: () => { inp.value = Math.max(0, (Number(inp.value) || 0) + n) || ''; } }, n > 0 ? '+' : '−');
    control = [h('div', { class: 'stepper' }, step(-1), inp, step(1)), hb['單位'] ? h('span', { class: 'muted' }, hb['單位']) : null,
      h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => save(Number(inp.value) || 0) }, '儲存')];
  } else {
    control = v
      ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => save(0) }, '取消打卡')
      : h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => save(1) }, icon('check'), isToday ? ' 打卡' : ' 補打卡');
  }
  return h('div', { class: 'hm-day' }, head, h('div', { class: 'row-flex' }, control),
    h('div', { class: 'muted small', style: { marginTop: '6px' } }, '點上面任何一格可以查看或補記那一天。'));
}

export function renderHabitAdmin(root) {
  const d = state.data;
  const habits = d.habits || [];
  const vs = viewState('habit-admin', { q: '', cat: '', st: '' }, () => renderHabitAdmin(root));
  const f = vs.v;
  const rows = habits.filter((hb) => {
    if (f.q && !(hb['習慣名稱'] || '').toLowerCase().includes(f.q.toLowerCase())) return false;
    if (f.cat && hb['分類'] !== f.cat) return false;
    if (f.st === 'active' && hb['狀態'] === '封存') return false;
    if (f.st === 'archived' && hb['狀態'] !== '封存') return false;
    return true;
  });
  mount(root,
    pageHead('習慣管理'),
    h('p', { class: 'muted small' }, '新增、編輯、封存習慣。設定好之後，回到「習慣」頁每天打卡就好。'),
    h('div', { class: 'toolbar' },
      searchBox(f.q, '搜尋習慣名稱…', (q) => vs.set({ q })),
      h('div', { class: 'filters' },
        filterSelect(f.cat, '全部分類', uniqueValues(habits, '分類'), (v) => vs.set({ cat: v })),
        filterSelect(f.st, '全部（含封存）', [['active', '僅啟用'], ['archived', '僅封存']], (v) => vs.set({ st: v }))),
      h('div', { class: 'count muted small' }, `共 ${rows.length} / ${habits.length} 筆`)),
    rows.length ? habitsByTime(rows, { showEdit: true }) : h('div', { class: 'card' }, empty('沒有符合條件的習慣')));
}

export function openHabitForm(id) {
  const d = state.data;
  const hb = id ? (d.habits || []).find((x) => x['習慣ID'] === id) : null;
  const ref = {};
  const err = errorBanner();
  const name = textField('習慣名稱', hb ? hb['習慣名稱'] : '');
  const cat = selectField('分類', d.options['習慣分類'], hb ? hb['分類'] : '');
  const time = segField('時段', HABIT_TIME_OPTIONS.map((t) => [t, t]), hb ? hb['時段'] || '不限' : '不限');

  const target = textField('目標值（達標門檻）', hb ? hb['目標值'] : '', { type: 'number', min: 1, inputmode: 'numeric' });
  const unit = textField('單位', hb ? hb['單位'] : '', { placeholder: '例如：杯、頁' });
  const base = textField('基礎值（做到這個數字以上就算今天有達成，連續天數不會斷）', hb ? hb['基礎值'] : '', { type: 'number', min: 0, inputmode: 'numeric' });
  const over = textField('超標值（做到這個數字以上會標示「超標」）', hb ? hb['超標值'] : '', { type: 'number', min: 0, inputmode: 'numeric' });
  const tierBox = h('div', { class: 'sub-box' }, base.el, over.el);
  const tiered = checkField('開啟三級制（基礎／達標／超標）', hb && hb['啟用分級'] === true, () => sync());
  const countBox = h('div', { class: 'sub-box' }, target.el, unit.el, tiered.el, tierBox);
  const type = segField('打卡方式', [['打勾', '打勾（有做／沒做）'], ['計數', '計數（杯數、頁數…）']], hb && hb['類型'] === '計數' ? '計數' : '打勾', () => sync());

  const wd = weekdayPicker(hb ? hb['星期幾'] : []);
  const weekly = h('input', { type: 'number', min: 1, class: 'narrow', value: hb && hb['每週次數'] ? hb['每週次數'] : 3, inputmode: 'numeric' });
  const weeklyRow = h('div', { class: 'row-flex sub-row' }, '每週', weekly, '次，哪幾天做都可以');
  const freqVal = hb && (hb['頻率類型'] === 'weekday' || hb['頻率類型'] === 'weeklyCount') ? hb['頻率類型'] : 'daily';
  const freq = segField('頻率', [['daily', '每天'], ['weekday', '指定星期'], ['weeklyCount', '每週 N 次']], freqVal, () => sync());
  const archived = checkField('封存（先不追蹤，但保留歷史紀錄）', hb && hb['狀態'] === '封存');

  function sync() {
    countBox.style.display = type.value === '計數' ? '' : 'none';
    tierBox.style.display = tiered.checked ? '' : 'none';
    wd.el.style.display = freq.value === 'weekday' ? '' : 'none';
    weeklyRow.style.display = freq.value === 'weeklyCount' ? '' : 'none';
  }

  const body = h('div', null, err.el, name.el, cat.el, time.el, type.el, countBox, freq.el, wd.el, weeklyRow, archived.el);
  sync();

  async function save(btn) {
    err.show('');
    const isTiered = type.value === '計數' && tiered.checked;
    const payload = {
      '習慣名稱': name.value.trim(), '分類': cat.value, '時段': time.value, '類型': type.value,
      '目標值': target.value, '單位': unit.value.trim(), '啟用分級': isTiered,
      '基礎值': isTiered ? base.value : '', '超標值': isTiered ? over.value : '',
      '頻率類型': freq.value, '星期幾': wd.value, '每週次數': weekly.value,
      '狀態': archived.checked ? '封存' : '啟用',
    };
    if (!payload['習慣名稱']) return err.show('請填習慣名稱');
    if (freq.value === 'weekday' && !wd.value.length) return err.show('請至少選一個星期幾，或改選「每天」');
    if (isTiered && payload['基礎值'] && payload['目標值'] && Number(payload['基礎值']) >= Number(payload['目標值'])) return err.show('基礎值要小於目標值（達標門檻）');
    if (isTiered && payload['超標值'] && payload['目標值'] && Number(payload['超標值']) <= Number(payload['目標值'])) return err.show('超標值要大於目標值（達標門檻）');
    if (freq.value === 'weeklyCount' && !(Number(payload['每週次數']) >= 1)) return err.show('請填每週要做幾次（至少 1 次）');
    // 新習慣的今日／連續統計要等背景重抓，先給合理的初始值
    const dow = new Date().getDay();
    const dueToday = freq.value === 'weekday' ? wd.value.includes(dow) : true;
    const fields = Object.assign({}, payload, hb ? {} : {
      '今日數值': 0, '今日應做': dueToday, '今日已完成': false, '今日等級': null, '連續天數': 0, '最長連續': 0, '近7天完成率': 0, '近30天完成率': 0, '打卡紀錄': {},
    });
    if (hb) saveRow('update_habit', Object.assign(payload, { '習慣ID': hb['習慣ID'] }), { list: 'habits', idField: '習慣ID', id: hb['習慣ID'], fields, toast: '已儲存' });
    else saveRow('create_habit', payload, { list: 'habits', idField: '習慣ID', fields, toast: '已新增習慣' });
    ref.sheet.close();
  }
  const extra = hb ? [h('button', { class: 'btn btn-danger', type: 'button', 'aria-label': '刪除', onclick: async () => {
    const ok = await confirmDialog({ title: '刪除習慣', message: `確定要刪除「${hb['習慣名稱']}」嗎？底下所有打卡紀錄也會一起刪除，無法復原。（只是暫停的話，可以改用「封存」）`, confirmText: '刪除', danger: true });
    if (!ok) return;
    deleteRow('delete_habit', { '習慣ID': hb['習慣ID'] }, { list: 'habits', idField: '習慣ID', id: hb['習慣ID'], toast: '已刪除' });
    ref.sheet.close();
  } }, icon('trash'))] : [];
  ref.sheet = openSheet({ title: hb ? '編輯習慣' : '新增習慣', body, footer: formFooter(ref, save, { extra }) });
}
