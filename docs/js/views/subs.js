import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { state } from '../store.js';
import { write, systemName } from '../data.js';
import { openSheet, confirmDialog, withBusy, errorText } from '../ui.js';
import { uniqueValues, sortRows, daysUntilLabel, dateLabel, money } from '../util.js';
import { pageHead, stats, empty, viewState, searchBox, filterSelect, textField, selectField, checkField, multiChips, formFooter, errorBanner, badge } from './common.js';

const SORTS = [['下次付款日', '下次付款日'], ['每月金額', '每月金額（高→低）'], ['總計花費', '總計花費（高→低）'], ['產品', '名稱']];

export function renderSubs(root) {
  const d = state.data;
  const list = d.subscriptions || [];
  const s = d.subscriptionStats || {};
  const vs = viewState('subs', { q: '', tag: '', st: '', sort: '' }, () => renderSubs(root));
  const f = vs.v;
  let rows = list.filter((x) => {
    if (f.q && !(x['產品'] || '').toLowerCase().includes(f.q.toLowerCase())) return false;
    if (f.tag && !(x['分類標籤'] || []).includes(f.tag)) return false;
    if (f.st === 'active' && x['取消訂閱'] === true) return false;
    if (f.st === 'canceled' && x['取消訂閱'] !== true) return false;
    return true;
  });
  rows = sortRows(rows, f.sort, ['每月金額', '總計花費'].includes(f.sort) ? -1 : 1);
  const upcoming = s.upcomingPayments || [];

  mount(root,
    pageHead(systemName('訂閱服務', '訂閱')),
    stats([['每月總支出', money(s.totalMonthlySpend)], ['使用中', s.activeCount ?? 0], ['已取消', s.canceledCount ?? 0], ['即將付款', upcoming.length], ['費用偏高提醒', (s.costWarnings || []).length]]),
    h('div', { class: 'card' }, h('h2', null, '14 天內即將付款'),
      upcoming.length ? h('ul', { class: 'list' }, upcoming.map((u) => h('li', null, h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('div', { class: 't' }, u['產品'] || ''), h('div', { class: 's' }, '下次付款：' + dateLabel(u['下次付款日']))),
        badge(daysUntilLabel(u['下次付款日'])), h('div', { class: 'amt' }, money(u['每月金額']))))))
        : h('div', { class: 'muted small' }, '近期沒有即將到期的付款')),
    h('div', { class: 'toolbar' },
      searchBox(f.q, '搜尋產品名稱…', (q) => vs.set({ q })),
      h('div', { class: 'filters three' },
        filterSelect(f.tag, '全部標籤', uniqueValues(list, '分類標籤', true), (v) => vs.set({ tag: v })),
        filterSelect(f.st, '全部（含已取消）', [['active', '僅使用中'], ['canceled', '僅已取消']], (v) => vs.set({ st: v })),
        filterSelect(f.sort, '排序', SORTS, (v) => vs.set({ sort: v }))),
      h('div', { class: 'count muted small' }, `共 ${rows.length} / ${list.length} 筆`)),
    rows.length ? h('div', { class: 'card' }, h('ul', { class: 'list' }, rows.map((x) => h('li', null, subItem(x)))))
      : h('div', { class: 'card' }, empty(list.length ? '沒有符合條件的訂閱' : '還沒有訂閱，按右下角 + 新增', list.length ? null : '💳')));
}

function subItem(x) {
  const meta = [];
  if (x['訂閱週期']) meta.push(x['訂閱週期']);
  if (x['下次付款日'] && x['取消訂閱'] !== true) meta.push('下次 ' + dateLabel(x['下次付款日']));
  if (x['累積訂閱日'] !== '' && x['累積訂閱日'] != null) meta.push(`已訂 ${x['累積訂閱日']} 天`);
  meta.push('累計 ' + money(x['總計花費']));
  if ((x['分類標籤'] || []).length) meta.push(x['分類標籤'].join('、'));
  return h('button', { type: 'button', class: 'item' + (x['取消訂閱'] === true ? ' voided-soft' : ''), onclick: () => openSubForm(x['訂閱ID']) },
    h('div', { class: 'grow' },
      h('div', { class: 'row-flex' }, h('div', { class: 't' }, x['產品'] || ''),
        x['取消訂閱'] === true ? badge('已取消', 'mute') : null,
        x['即將付款'] === true && x['取消訂閱'] !== true ? badge(daysUntilLabel(x['下次付款日'])) : null,
        x['訂閱費負擔提示'] ? badge('費用偏高', 'warn') : null),
      h('div', { class: 's wraptext' }, meta.join(' · '))),
    h('div', { class: 'amt' }, money(x['每月金額']), h('div', { class: 's' }, '/ 月')));
}

export function openSubForm(id) {
  const d = state.data;
  const x = id ? (d.subscriptions || []).find((r) => r['訂閱ID'] === id) : null;
  const ref = {};
  const err = errorBanner();
  const product = textField('產品', x ? x['產品'] : '');
  const fee = textField('訂閱費', x && x['訂閱費'] !== '' && x['訂閱費'] != null ? x['訂閱費'] : '', { type: 'number', min: 0, inputmode: 'decimal' });
  const cycle = selectField('訂閱週期', d.options['訂閱週期'], x ? x['訂閱週期'] : '');
  const start = textField('訂閱開始日', x ? x['訂閱開始日'] : '', { type: 'date' });
  const cancelDate = textField('取消訂閱日', x ? x['取消訂閱日'] : '', { type: 'date' });
  const canceled = checkField('已取消訂閱', x && x['取消訂閱'] === true, () => { cancelDate.el.style.display = canceled.checked ? '' : 'none'; });
  cancelDate.el.style.display = x && x['取消訂閱'] === true ? '' : 'none';
  const importance = selectField('重要性', d.options['重要性'], x ? x['重要性'] : '');
  const memo = textField('備註', x ? x['備註'] : '', { multiline: true, rows: 2 });
  const url = textField('付款網址', x ? x['付款URL'] : '', { type: 'url', placeholder: 'https://…' });
  const tags = multiChips('分類標籤', d.options['分類標籤'], x ? x['分類標籤'] : []);
  const body = h('div', null, err.el, product.el, h('div', { class: 'grid-2' }, fee.el, cycle.el), start.el, canceled.el, cancelDate.el, importance.el, tags.el, memo.el, url.el,
    x && x['付款URL'] ? h('a', { class: 'btn btn-sm', href: x['付款URL'], target: '_blank', rel: 'noopener noreferrer' }, icon('external'), '開啟付款頁面') : null);

  async function save(btn) {
    err.show('');
    const payload = {
      '產品': product.value.trim(), '訂閱費': fee.value, '訂閱週期': cycle.value, '訂閱開始日': start.value,
      '取消訂閱': canceled.checked, '取消訂閱日': cancelDate.value, '重要性': importance.value,
      '備註': memo.value, '付款URL': url.value.trim(), '分類標籤': tags.value,
    };
    if (!payload['產品']) return err.show('請填產品名稱');
    await withBusy(btn, async () => {
      try {
        if (x) await write('update_subscription', Object.assign(payload, { '訂閱ID': x['訂閱ID'] }), { throw: true, toast: '已儲存' });
        else await write('create_subscription', payload, { throw: true, toast: '已新增訂閱' });
        ref.sheet.close();
      } catch (e) { err.show(errorText(e)); }
    });
  }
  const extra = x ? [h('button', { class: 'btn btn-danger', type: 'button', 'aria-label': '刪除', onclick: async () => {
    const ok = await confirmDialog({ title: '刪除訂閱', message: `確定要刪除「${x['產品']}」嗎？此動作無法復原。（只是不再使用的話，可以勾「已取消訂閱」保留紀錄）`, confirmText: '刪除', danger: true });
    if (ok && await write('delete_subscription', { '訂閱ID': x['訂閱ID'] }, { toast: '已刪除' })) ref.sheet.close();
  } }, icon('trash'))] : [];
  ref.sheet = openSheet({ title: x ? '編輯訂閱' : '新增訂閱', body, footer: formFooter(ref, save, { extra }) });
}
