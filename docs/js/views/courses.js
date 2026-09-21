import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { state } from '../store.js';
import { write, systemName } from '../data.js';
import { openSheet, confirmDialog, withBusy, errorText } from '../ui.js';
import { uniqueValues, sortRows } from '../util.js';
import { pageHead, stats, empty, viewState, searchBox, filterSelect, textField, selectField, multiChips, formFooter, errorBanner, progress, badge } from './common.js';

const SORTS = [['進度', '進度（高→低）'], ['優先順序', '優先順序'], ['開始日期', '開始日期'], ['課程名稱', '名稱']];

export function renderCourses(root) {
  const d = state.data;
  const list = d.courses || [];
  const s = d.courseStats || {};
  const vs = viewState('courses', { q: '', status: '', cat: '', platform: '', sort: '' }, () => renderCourses(root));
  const f = vs.v;
  let rows = list.filter((c) => {
    if (f.q && !((c['課程名稱'] || '') + (c['講師'] || '')).toLowerCase().includes(f.q.toLowerCase())) return false;
    if (f.status && c['狀態'] !== f.status) return false;
    if (f.cat && !(c['分類'] || []).includes(f.cat)) return false;
    if (f.platform && c['平台'] !== f.platform) return false;
    return true;
  });
  rows = sortRows(rows, f.sort, f.sort === '進度' ? -1 : 1);

  mount(root,
    pageHead(systemName('課程', '課程')),
    stats([['總課程數', s.total ?? 0], ['平均進度', s.avgProgressPercent ?? 0, '%'], ['已完成', s.completed ?? 0, ` / ${s.total ?? 0}`]]),
    h('div', { class: 'toolbar' },
      searchBox(f.q, '搜尋課程名稱／講師…', (q) => vs.set({ q })),
      h('div', { class: 'filters' },
        filterSelect(f.status, '全部狀態', uniqueValues(list, '狀態'), (v) => vs.set({ status: v })),
        filterSelect(f.cat, '全部分類', uniqueValues(list, '分類', true), (v) => vs.set({ cat: v })),
        filterSelect(f.platform, '全部平台', uniqueValues(list, '平台'), (v) => vs.set({ platform: v })),
        filterSelect(f.sort, '排序', SORTS, (v) => vs.set({ sort: v }))),
      h('div', { class: 'count muted small' }, `共 ${rows.length} / ${list.length} 筆`)),
    rows.length ? h('div', { class: 'card' }, h('ul', { class: 'list' }, rows.map((c) => h('li', null, courseItem(c)))))
      : h('div', { class: 'card' }, empty(list.length ? '沒有符合條件的課程' : '還沒有課程，按右下角 + 新增', list.length ? null : '📚')));
}

function courseItem(c) {
  const p = Math.round((Number(c['進度']) || 0) * 100);
  const meta = [c['平台'], c['講師'], (c['分類'] || []).join('、'), c['優先順序'] ? '優先 ' + c['優先順序'] : ''].filter(Boolean);
  return h('button', { type: 'button', class: 'item', onclick: () => openCourseForm(c['課程ID']) },
    h('div', { class: 'ico' }, icon('book')),
    h('div', { class: 'grow' },
      h('div', { class: 'row-flex' }, h('div', { class: 't grow' }, c['課程名稱'] || ''), c['狀態'] ? badge(c['狀態'], c['狀態'] === '已完成' ? '' : 'mute') : null),
      meta.length ? h('div', { class: 's' }, meta.join(' · ')) : null,
      progress(p)));
}

export function openCourseForm(id) {
  const d = state.data;
  const c = id ? (d.courses || []).find((x) => x['課程ID'] === id) : null;
  const ref = {};
  const err = errorBanner();
  const name = textField('課程名稱', c ? c['課程名稱'] : '');
  const platform = selectField('平台', d.options['平台'], c ? c['平台'] : '');
  const teacher = textField('講師', c ? c['講師'] : '');
  const prog = textField('進度（%）', c ? Math.round((Number(c['進度']) || 0) * 100) : 0, { type: 'number', min: 0, max: 100, inputmode: 'numeric' });
  const status = selectField('狀態', d.options['狀態'], c ? c['狀態'] : '');
  const pri = selectField('優先順序', d.options['優先順序'], c ? c['優先順序'] : '');
  const link = textField('課程連結', c ? c['課程連結'] : '', { type: 'url', placeholder: 'https://…' });
  const start = textField('開始日期', c ? c['開始日期'] : '', { type: 'date' });
  const notes = textField('心得筆記', c ? c['心得筆記'] : '', { multiline: true, rows: 3 });
  const cats = multiChips('分類', d.options['分類'], c ? c['分類'] : []);
  const body = h('div', null, err.el, name.el, h('div', { class: 'grid-2' }, platform.el, teacher.el), h('div', { class: 'grid-2' }, prog.el, status.el),
    h('div', { class: 'grid-2' }, pri.el, start.el), cats.el, link.el, notes.el,
    c && c['課程連結'] ? h('a', { class: 'btn btn-sm', href: c['課程連結'], target: '_blank', rel: 'noopener noreferrer' }, icon('external'), '開啟課程') : null);

  async function save(btn) {
    err.show('');
    const payload = {
      '課程名稱': name.value.trim(), '平台': platform.value, '講師': teacher.value.trim(), '進度': prog.value, '狀態': status.value,
      '優先順序': pri.value, '課程連結': link.value.trim(), '開始日期': start.value, '心得筆記': notes.value, '分類': cats.value,
    };
    if (!payload['課程名稱']) return err.show('請填課程名稱');
    const n = Number(payload['進度']);
    if (payload['進度'] !== '' && (isNaN(n) || n < 0 || n > 100)) return err.show('進度請填 0～100');
    await withBusy(btn, async () => {
      try {
        if (c) await write('update_course', Object.assign(payload, { '課程ID': c['課程ID'] }), { throw: true, toast: '已儲存' });
        else await write('create_course', payload, { throw: true, toast: '已新增課程' });
        ref.sheet.close();
      } catch (e) { err.show(errorText(e)); }
    });
  }
  const extra = c ? [h('button', { class: 'btn btn-danger', type: 'button', 'aria-label': '刪除', onclick: async () => {
    const ok = await confirmDialog({ title: '刪除課程', message: `確定要刪除「${c['課程名稱']}」嗎？此動作無法復原。`, confirmText: '刪除', danger: true });
    if (ok && await write('delete_course', { '課程ID': c['課程ID'] }, { toast: '已刪除' })) ref.sheet.close();
  } }, icon('trash'))] : [];
  ref.sheet = openSheet({ title: c ? '編輯課程' : '新增課程', body, footer: formFooter(ref, save, { extra }) });
}
