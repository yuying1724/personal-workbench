import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { state } from '../store.js';
import { write, reload } from '../data.js';
import { confirmDialog, promptDialog, withBusy, toast } from '../ui.js';
import { pageHead } from './common.js';

const GROUPS = [
  { title: '課程', icon: 'book', fields: ['平台', '分類', '狀態', '優先順序'] },
  { title: '訂閱', icon: 'cash', fields: ['訂閱週期', '重要性', '分類標籤'] },
  { title: '任務', icon: 'tasks', fields: ['任務分類', '任務優先順序', '任務狀態', '重複頻率'] },
  { title: '專案', icon: 'folder', fields: ['專案狀態', '專案優先級'] },
  { title: '習慣', icon: 'fire', fields: ['習慣分類'] },
];

export function renderAdmin(root) {
  const d = state.data;
  // 「使用中筆數」（optionUsage）登入時不會一起載入（後端算它很慢，只有這頁要用），
  // 第一次進來、或其他頁面新增／修改資料後（adminStale），用 admin_bundle 抓一次
  if ((state.adminStale || !d.optionUsage) && !state.adminLoading) {
    state.adminStale = false; state.adminLoading = true;
    reload('admin_bundle').catch(() => {}).finally(() => { state.adminLoading = false; });
  }

  const systems = (d.systemIndex || []).map((s) => {
    const name = h('input', { type: 'text', value: s['系統名稱'] || '', 'aria-label': s['主表分頁名稱'] + ' 顯示名稱' });
    const save = h('button', { class: 'btn btn-sm', type: 'button' }, '儲存');
    save.addEventListener('click', () => withBusy(save, async () => {
      const v = name.value.trim();
      if (!v) { toast('名稱不能空白', { kind: 'bad' }); return; }
      await write('update_system', { '主表分頁名稱': s['主表分頁名稱'], '系統名稱': v, 'icon': s['icon'] || '' }, { toast: '已更新名稱' });
    }));
    return h('li', null, h('div', { class: 'item' }, h('div', { class: 'muted small nowrap', style: { width: '64px' } }, s['主表分頁名稱']), h('div', { class: 'grow' }, name), save));
  });

  mount(root,
    pageHead('分類管理'),
    h('p', { class: 'muted small' }, '管理各模組的下拉選項。改名會自動同步更新所有用到這個選項的資料；刪除選項只是讓它以後不出現在選單，不會動到既有資料。'),
    h('div', { class: 'card' }, h('h2', null, icon('compass'), ' 選單名稱'),
      h('p', { class: 'muted small', style: { marginTop: 0 } }, '改這裡的名稱，選單與頁面標題會跟著變，不會動到資料結構。'),
      h('ul', { class: 'list' }, systems)),
    GROUPS.map((g) => h('div', { class: 'stack section' },
      h('h2', { class: 'section-title' }, icon(g.icon), ' ', g.title),
      h('div', { class: 'option-grid' }, g.fields.map((f) => optionCard(f))))));
}

function optionCard(fieldName) {
  const d = state.data;
  const opts = (d.options && d.options[fieldName]) || [];
  const usage = (d.optionUsage && d.optionUsage[fieldName]) || {};
  const input = h('input', { type: 'text', placeholder: '新增選項…', 'aria-label': fieldName + ' 新增選項' });
  const add = h('button', { class: 'btn btn-sm', type: 'button' }, icon('plus'), '新增');
  const doAdd = () => withBusy(add, async () => {
    const value = input.value.trim();
    if (!value) return;
    if (await write('add_option', { field: fieldName, value }, { toast: `已新增「${value}」` })) input.value = '';
  });
  add.addEventListener('click', doAdd);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });

  return h('div', { class: 'card option-card' },
    h('h3', null, fieldName),
    opts.length ? h('ul', { class: 'list' }, opts.map((v) => h('li', null, h('div', { class: 'item compact' },
      h('div', { class: 'grow t' }, String(v)),
      h('span', { class: 'muted small nowrap' }, d.optionUsage ? `${usage[v] || 0} 筆` : '計算中…'),
      h('button', { class: 'icon-btn', type: 'button', title: '重新命名', 'aria-label': `重新命名 ${v}`, onclick: () => renameOption(fieldName, v) }, icon('edit')),
      h('button', { class: 'icon-btn', type: 'button', title: '刪除', 'aria-label': `刪除 ${v}`, onclick: () => deleteOption(fieldName, v, usage[v] || 0) }, icon('trash'))))))
      : h('div', { class: 'muted small' }, '目前沒有選項'),
    h('div', { class: 'row-flex', style: { marginTop: '8px' } }, input, add));
}

async function renameOption(fieldName, value) {
  const input = await promptDialog({ title: '重新命名', label: `${fieldName}（原本：${value}）`, value: String(value) });
  if (input === null) return;
  const newValue = input.trim();
  if (!newValue || newValue === value) return;
  await write('rename_option', { field: fieldName, oldValue: value, newValue }, { toast: '已改名，用到的資料也一起更新了' });
}

async function deleteOption(fieldName, value, count) {
  const msg = count > 0
    ? `「${value}」目前有 ${count} 筆資料在用。刪除後這些資料不會被清掉，只是這個選項以後不會出現在下拉選單。確定要刪除嗎？`
    : `確定要刪除「${value}」這個選項嗎？`;
  if (!(await confirmDialog({ title: '刪除選項', message: msg, confirmText: '刪除', danger: true }))) return;
  await write('delete_option', { field: fieldName, value }, { toast: '已刪除選項' });
}
