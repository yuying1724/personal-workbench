import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { state, subscribe } from '../store.js';
import { write, systemName } from '../data.js';
import { openSheet, confirmDialog, withBusy, errorText } from '../ui.js';
import { uniqueValues, sortRows, dateLabel, TASK_CLOSED } from '../util.js';
import { pageHead, stats, empty, viewState, searchBox, filterSelect, textField, selectField, formFooter, errorBanner, progress, badge } from './common.js';
import { taskRow, openTaskForm } from './tasks.js';

export function projectSummary() {
  const list = state.data.projects || [];
  const total = list.length;
  const avgPct = total ? Math.round(list.reduce((s, p) => s + (Number(p['完成度Percent']) || 0), 0) / total) : 0;
  const overdueTasks = list.reduce((s, p) => s + (Number(p['逾期數']) || 0), 0);
  const ps = state.data.projectStats || {};
  const doneCount = (ps.byStatus && ps.byStatus['已完成']) || 0;
  return { total, avgPct, overdueTasks, doneCount };
}

const SORTS = [['', '預設順序'], ['結束日', '結束日'], ['開始日', '開始日'], ['完成度Percent', '完成度'], ['專案名稱', '名稱']];

export function renderProjects(root) {
  const d = state.data;
  const list = d.projects || [];
  const vs = viewState('projects', { q: '', status: '', pri: '', sort: '' }, () => renderProjects(root));
  const f = vs.v;
  let rows = list.filter((p) => {
    if (f.q && !(p['專案名稱'] || '').toLowerCase().includes(f.q.toLowerCase())) return false;
    if (f.status && p['狀態'] !== f.status) return false;
    if (f.pri && p['優先級'] !== f.pri) return false;
    return true;
  });
  rows = sortRows(rows, f.sort, f.sort === '完成度Percent' ? -1 : 1);
  const ps = projectSummary();

  mount(root,
    pageHead(systemName('專案', '專案')),
    stats([['總專案數', ps.total], ['平均完成度', ps.avgPct, '%'], ['已完成', ps.doneCount, ` / ${ps.total}`], ['含逾期任務', ps.overdueTasks]]),
    h('div', { class: 'toolbar' },
      searchBox(f.q, '搜尋專案名稱…', (q) => vs.set({ q })),
      h('div', { class: 'filters three' },
        filterSelect(f.status, '全部狀態', uniqueValues(list, '狀態'), (v) => vs.set({ status: v })),
        filterSelect(f.pri, '全部優先級', uniqueValues(list, '優先級'), (v) => vs.set({ pri: v })),
        filterSelect(f.sort, '排序', SORTS.slice(1), (v) => vs.set({ sort: v }))),
      h('div', { class: 'count muted small' }, `共 ${rows.length} / ${list.length} 筆`)),
    rows.length ? h('div', { class: 'card' }, h('ul', { class: 'list' }, rows.map((p) => h('li', null, projectItem(p)))))
      : h('div', { class: 'card' }, empty(list.length ? '沒有符合條件的專案' : '還沒有專案，按右下角 + 新增', list.length ? null : '📁')));
}

function projectItem(p) {
  const meta = [];
  if (p['開始日'] || p['結束日']) meta.push(`${p['開始日'] ? dateLabel(p['開始日']) : '？'} ～ ${p['結束日'] ? dateLabel(p['結束日']) : '？'}`);
  if (p['優先級']) meta.push('優先 ' + p['優先級']);
  if (Number(p['逾期數'])) meta.push(h('span', { class: 'bad-text' }, `逾期 ${p['逾期數']}`));
  const withDots = [];
  meta.forEach((m, i) => { if (i) withDots.push(' · '); withDots.push(m); });
  return h('button', { type: 'button', class: 'item', onclick: () => openProjectDetail(p['專案ID']) },
    h('div', { class: 'ico' }, icon('folder')),
    h('div', { class: 'grow' },
      h('div', { class: 'row-flex' }, h('div', { class: 't grow' }, p['專案名稱'] || ''), p['狀態'] ? badge(p['狀態']) : null),
      withDots.length ? h('div', { class: 's' }, withDots) : null,
      progress(p['完成度Percent'], `${Math.round(Number(p['完成度Percent']) || 0)}%（${p['已完成數'] || 0}/${p['任務數'] || 0}）`)));
}

/** 專案詳情：看專案底下的任務、直接新增任務到這個專案 */
function openProjectDetail(id) {
  const ref = {};
  const draw = () => {
    const p = (state.data.projects || []).find((x) => x['專案ID'] === id);
    if (!p) { if (ref.sheet) ref.sheet.close(); return null; }
    const tasks = (state.data.tasks || []).filter((t) => t['所屬專案'] === id)
      .sort((a, b) => TASK_CLOSED.includes(a['狀態']) - TASK_CLOSED.includes(b['狀態']) || (a['到期日'] || '9').localeCompare(b['到期日'] || '9'));
    return h('div', null,
      progress(p['完成度Percent'], `${Math.round(Number(p['完成度Percent']) || 0)}%（${p['已完成數'] || 0}/${p['任務數'] || 0}）`),
      h('dl', { class: 'kv', style: { margin: '12px 0' } },
        h('dt', null, '期間'), h('dd', null, `${p['開始日'] || '？'} ～ ${p['結束日'] || '？'}`),
        h('dt', null, '狀態'), h('dd', null, p['狀態'] || '—'),
        h('dt', null, '優先級'), h('dd', null, p['優先級'] || '—'),
        p['備註'] ? [h('dt', null, '備註'), h('dd', { class: 'prewrap' }, p['備註'])] : null),
      h('div', { class: 'row-flex between' }, h('h3', null, `任務（${tasks.length}）`),
        h('button', { class: 'btn btn-sm', onclick: () => openTaskForm(null, { '所屬專案': id }) }, icon('plus'), '新增任務')),
      tasks.length ? h('ul', { class: 'list' }, tasks.map((t) => h('li', null, taskRow(t)))) : h('div', { class: 'muted small' }, '這個專案還沒有任務'));
  };
  const body = h('div', null, draw());
  // 專案底下的任務被勾選／新增後，詳情畫面跟著更新
  const unsub = subscribe(() => { const next = draw(); if (next) mount(body, next); });
  const p = (state.data.projects || []).find((x) => x['專案ID'] === id);
  ref.sheet = openSheet({
    title: p['專案名稱'] || '專案', body,
    footer: [h('button', { class: 'btn', type: 'button', onclick: () => ref.sheet.close() }, '關閉'), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openProjectForm(id) }, icon('edit'), '編輯專案')],
    onClose: unsub,
  });
}

export function openProjectForm(id) {
  const d = state.data;
  const p = id ? (d.projects || []).find((x) => x['專案ID'] === id) : null;
  const ref = {};
  const err = errorBanner();
  const name = textField('專案名稱', p ? p['專案名稱'] : '');
  const start = textField('開始日', p ? p['開始日'] : '', { type: 'date' });
  const end = textField('結束日', p ? p['結束日'] : '', { type: 'date' });
  const status = selectField('狀態', d.options['專案狀態'], p ? p['狀態'] : '');
  const pri = selectField('優先級', d.options['專案優先級'], p ? p['優先級'] : '');
  const notes = textField('備註', p ? p['備註'] : '', { multiline: true, rows: 3 });
  const body = h('div', null, err.el, name.el, h('div', { class: 'grid-2' }, start.el, end.el), h('div', { class: 'grid-2' }, status.el, pri.el), notes.el);
  async function save(btn) {
    err.show('');
    const payload = { '專案名稱': name.value.trim(), '開始日': start.value, '結束日': end.value, '狀態': status.value, '優先級': pri.value, '備註': notes.value };
    if (!payload['專案名稱']) return err.show('請填專案名稱');
    if (payload['開始日'] && payload['結束日'] && payload['結束日'] < payload['開始日']) return err.show('結束日不能早於開始日');
    await withBusy(btn, async () => {
      try {
        if (p) await write('update_project', Object.assign(payload, { '專案ID': p['專案ID'] }), { throw: true, toast: '已儲存' });
        else await write('create_project', payload, { throw: true, toast: '已新增專案' });
        ref.sheet.close();
      } catch (e) { err.show(errorText(e)); }
    });
  }
  const extra = p ? [h('button', { class: 'btn btn-danger', type: 'button', 'aria-label': '刪除', onclick: async () => {
    const ok = await confirmDialog({ title: '刪除專案', message: `確定要刪除「${p['專案名稱']}」嗎？底下的任務不會被刪除，只會變回「沒有專案」。`, confirmText: '刪除', danger: true });
    if (ok && await write('delete_project', { '專案ID': p['專案ID'] }, { toast: '已刪除' })) ref.sheet.close();
  } }, icon('trash'))] : [];
  ref.sheet = openSheet({ title: p ? '編輯專案' : '新增專案', body, footer: formFooter(ref, save, { extra }) });
}
