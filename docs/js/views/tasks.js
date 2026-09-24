import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { state } from '../store.js';
import { write, saveRow, deleteRow, systemName } from '../data.js';
import { openSheet, confirmDialog, withBusy, errorText, toast } from '../ui.js';
import {
  todayStr, thisSundayStr, dateLabel, decodeRepeatRule, encodeRepeatRule, repeatRuleLabel, canSkipTask, uniqueValues, TASK_CLOSED,
} from '../util.js';
import {
  pageHead, stats, empty, viewState, searchBox, filterSelect, textField, selectField, checkField, multiChips, field, weekdayPicker, formFooter, errorBanner, badge,
} from './common.js';

const GROUPS = [
  { key: 'overdue', label: '以前的' },
  { key: 'today', label: '今天' },
  { key: 'future', label: '未來' },
  { key: 'noDue', label: '沒有到期日' },
  { key: 'done', label: '已完成／已取消／已跳過' },
];

export function projectNameById(id) {
  const p = (state.data.projects || []).find((x) => x['專案ID'] === id);
  return p ? p['專案名稱'] || '' : '';
}

export function renderTasks(root) {
  const d = state.data;
  const tasks = d.tasks || [];
  const vs = viewState('tasks', { q: '', status: '', priority: '', project: '', cats: [], collapsed: { done: true } }, () => renderTasks(root));
  const f = vs.v;
  const s = d.taskStats || {};

  const cats = uniqueValues(tasks, '分類', true);
  const catSet = new Set((f.cats || []).filter((c) => cats.includes(c)));
  const rows = tasks.filter((t) => {
    if (f.q && !(t['任務名稱'] || '').toLowerCase().includes(f.q.toLowerCase())) return false;
    if (f.status && t['狀態'] !== f.status) return false;
    if (f.priority && t['優先順序'] !== f.priority) return false;
    if (f.project && t['所屬專案'] !== f.project) return false;
    if (catSet.size && !(t['分類'] || []).some((c) => catSet.has(c))) return false;
    return true;
  });

  const today = todayStr(0);
  const groups = { overdue: [], today: [], future: [], noDue: [], done: [] };
  rows.forEach((t) => {
    if (TASK_CLOSED.includes(t['狀態'] || '')) { groups.done.push(t); return; }
    const due = t['到期日'] || '';
    if (!due) groups.noDue.push(t);
    else if (due < today) groups.overdue.push(t);
    else if (due === today) groups.today.push(t);
    else groups.future.push(t);
  });
  ['overdue', 'today', 'future'].forEach((k) => groups[k].sort((a, b) => (a['到期日'] || '').localeCompare(b['到期日'] || '') || (b['星標'] === true) - (a['星標'] === true)));
  groups.noDue.sort((a, b) => (b['星標'] === true) - (a['星標'] === true) || (a['任務名稱'] || '').localeCompare(b['任務名稱'] || '', 'zh-Hant'));
  groups.done.sort((a, b) => (b['到期日'] || '').localeCompare(a['到期日'] || ''));

  const collapsed = f.collapsed || {};
  const chips = h('div', { class: 'chips chip-filter' },
    h('button', { type: 'button', class: 'chip' + (catSet.size ? '' : ' on'), onclick: () => vs.set({ cats: [] }) }, '全部分類'),
    cats.map((c) => h('button', { type: 'button', class: 'chip' + (catSet.has(c) ? ' on' : ''), onclick: () => {
      const next = new Set(catSet); if (next.has(c)) next.delete(c); else next.add(c); vs.set({ cats: [...next] });
    } }, c)));

  mount(root,
    pageHead(systemName('任務', '任務')),
    stats([['總任務數', s.total ?? 0], ['已完成', s.completed ?? 0, ` / ${s.total ?? 0}`], ['逾期', s.overdue ?? 0], ['3 天內到期', s.dueSoon ?? 0], ['星標未完成', s.starredOpen ?? 0]]),
    h('div', { class: 'toolbar' },
      searchBox(f.q, '搜尋任務名稱…', (q) => vs.set({ q })),
      h('div', { class: 'filters' },
        filterSelect(f.status, '全部狀態', uniqueValues(tasks, '狀態'), (v) => vs.set({ status: v })),
        filterSelect(f.priority, '全部優先順序', uniqueValues(tasks, '優先順序'), (v) => vs.set({ priority: v })),
        filterSelect(f.project, '全部專案', (d.projects || []).map((p) => [p['專案ID'], p['專案名稱'] || p['專案ID']]), (v) => vs.set({ project: v }))),
      cats.length ? chips : null,
      h('div', { class: 'count muted small' }, `共 ${rows.length} / ${tasks.length} 筆`)),
    rows.length ? GROUPS.filter((g) => groups[g.key].length).map((g) => {
      const isCollapsed = !!collapsed[g.key];
      return h('div', { class: 'card group' + (isCollapsed ? ' collapsed' : '') },
        h('button', { class: 'group-head', type: 'button', 'aria-expanded': String(!isCollapsed), onclick: () => vs.set({ collapsed: Object.assign({}, collapsed, { [g.key]: !isCollapsed }) }) },
          icon('chevronDown', 'caret'), h('span', { class: g.key === 'overdue' ? 'bad-text' : '' }, g.label), h('span', { class: 'muted' }, `（${groups[g.key].length}）`)),
        isCollapsed ? null : h('ul', { class: 'list' }, groups[g.key].map((t) => h('li', null, taskRow(t, g.key)))));
    }) : h('div', { class: 'card' }, empty(tasks.length ? '沒有符合條件的任務' : '還沒有任務，按右下角 + 新增', tasks.length ? null : '✅')));
}

/** 單一任務列（任務頁、首頁、專案頁共用） */
export function taskRow(t, groupKey) {
  const status = t['狀態'] || '';
  const isDone = TASK_CLOSED.includes(status);
  const subs = t['子任務'] || [];
  const meta = [];
  if (t['到期日']) meta.push(h('span', { class: groupKey === 'overdue' ? 'bad-text' : '' }, dateLabel(t['到期日'])));
  if (t['優先順序']) meta.push(t['優先順序']);
  if ((t['分類'] || []).length) meta.push(t['分類'].join('、'));
  if (t['所屬專案']) { const n = projectNameById(t['所屬專案']); if (n) meta.push(h('span', { class: 'nowrap' }, icon('folder'), ' ', n)); }
  if (subs.length) meta.push(`子任務 ${subs.filter((x) => x['完成']).length}/${subs.length}`);
  if (status && status !== '已完成' && status !== '待辦') meta.push(badge(status));
  const withDots = [];
  meta.forEach((m, i) => { if (i) withDots.push(' · '); withDots.push(m); });

  const check = h('input', { type: 'checkbox', class: 'big-check', checked: isDone, 'aria-label': '完成', onchange: (e) => toggleTaskDone(t, e.target.checked) });
  return h('div', { class: 'item task-row' + (isDone ? ' done' : '') },
    check,
    h('button', { type: 'button', class: 'grow item-main', onclick: () => openTaskForm(t['任務ID']) },
      h('div', { class: 't wraptext' }, t['星標'] ? icon('starFill', 'star') : null, t['星標'] ? ' ' : null, t['任務名稱'] || '（未命名）',
        t['重複規則'] ? h('span', { class: 'muted', title: '重複：' + repeatRuleLabel(t['重複規則']) }, ' ', icon('repeat')) : null),
      withDots.length ? h('div', { class: 's wraptext' }, withDots) : null),
    canSkipTask(t) ? h('button', { type: 'button', class: 'icon-btn', title: '跳過本次', 'aria-label': '跳過本次', onclick: () => skipTask(t) }, icon('skip')) : null);
}

/** 跟後端 getTaskStats_ 同一套算法，樂觀更新時在本機重算統計 */
export function computeTaskStats(tasks) {
  const today = todayStr(0), soon = todayStr(3);
  let completed = 0, overdue = 0, dueSoon = 0, starredOpen = 0;
  (tasks || []).forEach((t) => {
    const isDone = t['狀態'] === '已完成';
    const isClosed = t['狀態'] === '已取消' || t['狀態'] === '已跳過';
    if (isDone) completed++;
    if (t['星標'] === true && !isDone && !isClosed) starredOpen++;
    if (t['到期日'] && !isDone && !isClosed) {
      if (t['到期日'] < today) overdue++;
      else if (t['到期日'] <= soon) dueSoon++;
    }
  });
  return { total: (tasks || []).length, completed, overdue, dueSoon, starredOpen };
}

/** 用本機資料重算任務統計，回傳還原函式 */
export function recalcTaskStats() {
  const prev = state.data.taskStats;
  state.data.taskStats = computeTaskStats(state.data.tasks);
  return () => { state.data.taskStats = prev; };
}

/** 打勾／取消：先改畫面、背景送出；其他欄位原封不動送回去，只改狀態（有重複規則的話後端會自動產生下一筆，重抓後才會出現） */
export async function toggleTaskDone(t, checked) {
  const r = await write('update_task', taskPayload(t, { '狀態': checked ? '已完成' : '待辦' }), {
    toast: checked ? '已完成' : '已改回待辦',
    optimistic: () => {
      const prev = t['狀態'], prevStats = state.data.taskStats;
      t['狀態'] = checked ? '已完成' : '待辦';
      state.data.taskStats = computeTaskStats(state.data.tasks);
      return () => { t['狀態'] = prev; state.data.taskStats = prevStats; };
    },
  });
  if (r && r.nextTaskCreated) setTimeout(() => toast('已自動產生下一次的任務'), 400);
}

export function taskPayload(t, patch) {
  return Object.assign({
    '任務ID': t['任務ID'], '任務名稱': t['任務名稱'], '優先順序': t['優先順序'], '狀態': t['狀態'], '到期日': t['到期日'], '星標': t['星標'],
    '重複規則': t['重複規則'], '備註': t['備註'], '分類': t['分類'], '所屬專案': t['所屬專案'], '子任務': t['子任務'],
  }, patch || {});
}

async function skipTask(t, sheet) {
  const ok = await confirmDialog({ title: '跳過本次', message: '這一次先不做，但下一輪的待辦任務還是會照重複規則自動產生。確定要跳過嗎？', confirmText: '跳過本次' });
  if (!ok) return;
  const r = await write('skip_task', { '任務ID': t['任務ID'] }, { toast: '已跳過本次' });
  if (r && sheet) sheet.close();
}

export function openTaskForm(id, defaults = {}) {
  const d = state.data;
  const t = id ? (d.tasks || []).find((x) => x['任務ID'] === id) : null;
  const rep = decodeRepeatRule(t ? t['重複規則'] : '');
  const ref = {};
  const err = errorBanner();

  const name = textField('任務名稱', t ? t['任務名稱'] : defaults['任務名稱'] || '');
  const cats = multiChips('分類', d.options['任務分類'], t ? t['分類'] : defaults['分類']);
  const project = selectField('所屬專案', (d.projects || []).map((p) => [p['專案ID'], p['專案名稱'] || p['專案ID']]), t ? t['所屬專案'] : defaults['所屬專案'] || '', { emptyLabel: '（無）' });
  const due = h('input', { type: 'date', value: t ? t['到期日'] || '' : defaults['到期日'] || '' });
  const quick = (label, fn) => h('button', { type: 'button', class: 'chip', onclick: () => { due.value = fn(); } }, label);
  const star = checkField('星標（重要）', t ? t['星標'] === true : !!defaults['星標']);
  const notes = textField('備註', t ? t['備註'] : '', { multiline: true, rows: 2 });

  // ---- 重複 ----
  const freq = h('select', null, [['none', '不重複'], ['day', '每天'], ['week', '每週'], ['month', '每月'], ['year', '每年'], ['custom', '自訂文字（只記錄，不自動產生）']]
    .map(([v, l]) => h('option', { value: v, selected: rep.freq === v }, l)));
  const interval = h('input', { type: 'number', min: 1, value: rep.interval || 1, class: 'narrow', inputmode: 'numeric' });
  const unit = h('span');
  const intervalRow = h('div', { class: 'row-flex sub-row' }, '每', interval, unit);
  const wd = weekdayPicker(rep.weekdays);
  const lastDay = checkField('每月最後一天（大月小月都算到月底）', rep.lastDayOfMonth);
  const custom = h('input', { type: 'text', placeholder: '例如：牌照稅', value: rep.freq === 'custom' ? rep.label || '' : '' });
  let endType = rep.end.type || 'never';
  const endDate = h('input', { type: 'date', value: rep.end.type === 'date' ? rep.end.date : '' });
  const endCount = h('input', { type: 'number', min: 1, class: 'narrow', value: rep.end.type === 'count' ? rep.end.count : 5, inputmode: 'numeric' });
  const endRadio = (v, label, extra) => h('label', { class: 'check' },
    h('input', { type: 'radio', name: 'repeatEnd', value: v, checked: endType === v, onchange: () => { endType = v; syncRepeat(); } }), label, extra || null);
  const endBox = h('div', { class: 'sub-box' }, h('div', { class: 'lbl' }, '重複截止'),
    endRadio('never', '一直重複'), endRadio('date', '到日期', endDate), endRadio('count', '重複次數', h('span', { class: 'row-flex' }, endCount, '次')));
  function syncRepeat() {
    const v = freq.value;
    const structured = ['day', 'week', 'month', 'year'].includes(v);
    unit.textContent = { day: '天', week: '週', month: '個月', year: '年' }[v] || '';
    intervalRow.style.display = structured ? '' : 'none';
    wd.el.style.display = v === 'week' ? '' : 'none';
    lastDay.el.style.display = v === 'month' ? '' : 'none';
    custom.style.display = v === 'custom' ? '' : 'none';
    endBox.style.display = structured ? '' : 'none';
    endDate.disabled = endType !== 'date';
    endCount.disabled = endType !== 'count';
  }
  freq.addEventListener('change', syncRepeat);

  // ---- 子任務 ----
  const subList = h('div', { class: 'sub-editor' });
  const addSubRow = (content, done) => {
    const row = h('div', { class: 'row-flex sub-item' },
      h('input', { type: 'checkbox', class: 'big-check', checked: !!done, 'aria-label': '子任務完成' }),
      h('input', { type: 'text', value: content || '', placeholder: '子任務內容' }),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': '刪除子任務', onclick: () => row.remove() }, icon('trash')));
    subList.appendChild(row);
    return row;
  };
  (t ? t['子任務'] : []).forEach((st) => addSubRow(st['內容'], st['完成']));

  const body = h('div', null, err.el,
    name.el, cats.el, project.el,
    field('到期日', h('div', null, due, h('div', { class: 'chips quick' }, quick('今天', () => todayStr(0)), quick('明天', () => todayStr(1)), quick('3 天後', () => todayStr(3)), quick('這週日', thisSundayStr), quick('無日期', () => '')))),
    star.el,
    field('重複（完成時自動產生下一筆）', h('div', { class: 'stack-sm' }, freq, intervalRow, wd.el, lastDay.el, custom, endBox)),
    notes.el,
    field('子任務', h('div', null, subList, h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { const r = addSubRow('', false); r.querySelector('input[type=text]').focus(); } }, icon('plus'), '新增子任務'))));
  syncRepeat();

  async function save(btn) {
    err.show('');
    const payload = {
      '任務名稱': name.value.trim(),
      '優先順序': t ? t['優先順序'] || '' : '', // 表單沒有這兩欄，但要原封不動送回去，不然會被清空
      '狀態': t ? t['狀態'] || '' : '待辦',
      '到期日': due.value,
      '星標': star.checked,
      '重複規則': encodeRepeatRule({
        freq: freq.value, interval: interval.value, weekdays: wd.value, customLabel: custom.value, lastDayOfMonth: lastDay.checked,
        end: { type: endType, date: endDate.value, count: endCount.value }, occurrence: rep.occurrence,
      }),
      '備註': notes.value,
      '分類': cats.value,
      '所屬專案': project.value,
      '子任務': [...subList.children].map((row) => ({ '內容': row.querySelector('input[type=text]').value.trim(), '完成': row.querySelector('input[type=checkbox]').checked })).filter((x) => x['內容']),
    };
    if (!payload['任務名稱']) { err.show('請填任務名稱'); return; }
    if (freq.value === 'week' && !wd.value.length) { err.show('每週重複請至少選一個星期幾，或改選「不重複」'); return; }
    const spec = { list: 'tasks', idField: '任務ID', recalc: recalcTaskStats };
    if (t) saveRow('update_task', Object.assign(payload, { '任務ID': t['任務ID'] }), Object.assign(spec, { id: t['任務ID'], toast: '已儲存' }));
    else saveRow('create_task', payload, Object.assign(spec, { toast: '已新增任務' }));
    ref.sheet.close();
  }

  const extra = [];
  if (t) extra.push(h('button', { class: 'btn btn-danger', type: 'button', 'aria-label': '刪除', onclick: async () => {
    const ok = await confirmDialog({ title: '刪除任務', message: `確定要刪除「${t['任務名稱']}」嗎？此動作無法復原。`, confirmText: '刪除', danger: true });
    if (!ok) return;
    deleteRow('delete_task', { '任務ID': t['任務ID'] }, { list: 'tasks', idField: '任務ID', id: t['任務ID'], recalc: recalcTaskStats, toast: '已刪除' });
    ref.sheet.close();
  } }, icon('trash')));
  if (canSkipTask(t)) extra.push(h('button', { class: 'btn', type: 'button', title: '跳過本次', onclick: () => skipTask(t, ref.sheet) }, icon('skip')));
  ref.sheet = openSheet({ title: t ? '編輯任務' : '新增任務', body, footer: formFooter(ref, save, { extra }) });
}
