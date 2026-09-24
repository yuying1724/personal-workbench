import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { state } from '../store.js';
import { write, systemName } from '../data.js';
import { openSheet, confirmDialog, withBusy, errorText } from '../ui.js';
import { habitFreqLabel, uniqueValues, HABIT_TIME_OPTIONS, HABIT_TIME_ICON } from '../util.js';
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

  const main = h(opts.showEdit ? 'button' : 'div', { type: opts.showEdit ? 'button' : null, class: 'grow item-main', onclick: opts.showEdit ? () => openHabitForm(id) : null },
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

// ---------- 樂觀更新：打卡先改畫面、背景送出，跟後端 isHabitDoneForDay_／habitTierForValue_ 同一套判斷 ----------
function habitById(id) { return (state.data.habits || []).find((x) => x['習慣ID'] === id); }
function hasNum(v) { return v !== '' && v != null; }
function habitDoneFor(hb, value) {
  const v = Number(value) || 0;
  if (hb['類型'] !== '計數') return v >= 1;
  if (hb['啟用分級'] === true && hasNum(hb['基礎值'])) return v >= (Number(hb['基礎值']) || 0);
  return v >= (Number(hb['目標值']) || 1);
}
function habitTierFor(hb, value) {
  if (hb['類型'] !== '計數' || hb['啟用分級'] !== true) return null;
  const v = Number(value) || 0;
  const target = Number(hb['目標值']) || 0;
  if (hasNum(hb['超標值']) && v >= Number(hb['超標值'])) return '超標';
  if (v >= target) return '達標';
  if (hasNum(hb['基礎值']) && v >= Number(hb['基礎值'])) return '基礎';
  return null;
}
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

function toggleHabit(id, checked) {
  const hb = habitById(id);
  if (!hb) return;
  write('set_habit_log', { '習慣ID': id, '數值': checked ? 1 : null }, { toast: checked ? '打卡完成' : '已取消打卡', optimistic: () => applyHabitValue(hb, checked ? 1 : 0) });
}

// 數字連續輸入／連點 +：同一個習慣 600ms 內只送最後一次，避免重複寫入（送出時才更新畫面，打字中不會被重畫打斷）
const timers = {};
function setHabitCount(id, value) {
  clearTimeout(timers[id]);
  timers[id] = setTimeout(() => {
    delete timers[id];
    const hb = habitById(id);
    if (!hb) return;
    write('set_habit_log', { '習慣ID': id, '數值': value === '' ? null : Number(value) }, { toast: '已記錄', optimistic: () => applyHabitValue(hb, value === '' ? 0 : Number(value)) });
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
    sorted.length ? habitsByTime(sorted, {}) : h('div', { class: 'card' }, empty((d.habits || []).length ? '今天沒有排定要做的習慣' : '還沒有習慣，到「習慣管理」新增', '🌱')));
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
    await withBusy(btn, async () => {
      try {
        if (hb) await write('update_habit', Object.assign(payload, { '習慣ID': hb['習慣ID'] }), { throw: true, toast: '已儲存' });
        else await write('create_habit', payload, { throw: true, toast: '已新增習慣' });
        ref.sheet.close();
      } catch (e) { err.show(errorText(e)); }
    });
  }
  const extra = hb ? [h('button', { class: 'btn btn-danger', type: 'button', 'aria-label': '刪除', onclick: async () => {
    const ok = await confirmDialog({ title: '刪除習慣', message: `確定要刪除「${hb['習慣名稱']}」嗎？底下所有打卡紀錄也會一起刪除，無法復原。（只是暫停的話，可以改用「封存」）`, confirmText: '刪除', danger: true });
    if (ok && await write('delete_habit', { '習慣ID': hb['習慣ID'] }, { toast: '已刪除' })) ref.sheet.close();
  } }, icon('trash'))] : [];
  ref.sheet = openSheet({ title: hb ? '編輯習慣' : '新增習慣', body, footer: formFooter(ref, save, { extra }) });
}
