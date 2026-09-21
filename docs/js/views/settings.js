import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { prefs, state, notify } from '../store.js';
import * as api from '../api.js';
import { openSheet, toast, errorText, withBusy } from '../ui.js';
import { lock } from '../app.js';
import { pageHead } from './common.js';

export function renderSettings(root) {
  const d = state.data;
  const meta = d.meta || {};
  const seg = (options, current, onPick) => h('div', { class: 'seg' }, options.map(([v, t]) => h('button', { type: 'button', class: current === v ? 'on' : '', onclick: () => onPick(v) }, t)));
  mount(root,
    pageHead('設定'),
    h('div', { class: 'stack' },
      h('div', { class: 'card' }, h('h2', null, '顯示'),
        h('div', { class: 'field' }, h('span', { class: 'lbl' }, '外觀'), seg([['auto', '跟隨系統'], ['light', '淺色'], ['dark', '深色']], prefs.theme, (v) => { prefs.theme = v; notify(); }))),
      h('div', { class: 'card' }, h('h2', null, '安全'),
        h('div', { class: 'row-flex wrap' },
          h('button', { class: 'btn btn-sm', onclick: openChangePin }, icon('lock'), '變更 PIN'),
          h('button', { class: 'btn btn-sm', onclick: () => lock('已鎖定') }, icon('logout'), '鎖定並登出')),
        h('p', { class: 'muted small', style: { marginBottom: 0 } }, `這台裝置：${meta.device || '（未命名）'}。要新增或撤銷裝置（例如家裡電腦、新手機），請在試算表選單「個人工作台」操作。`)),
      h('div', { class: 'card' }, h('h2', null, '資料'),
        meta.sheetUrl ? h('a', { class: 'btn btn-sm', href: meta.sheetUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), '開啟試算表') : null,
        h('p', { class: 'muted small', style: { marginBottom: 0 } }, '最後更新：' + (state.loadedAt ? state.loadedAt.toLocaleString('zh-TW') : '—'))),
      h('div', { class: 'card' }, h('h2', null, '關於'),
        h('dl', { class: 'kv' },
          h('dt', null, '版本'), h('dd', null, meta.version || '—'),
          h('dt', null, '後端'), h('dd', { class: 'mono' }, prefs.apiUrl.replace(/^https?:\/\//, '').slice(0, 60) + (prefs.apiUrl.length > 68 ? '…' : ''))),
        h('button', { class: 'btn btn-sm', style: { marginTop: '12px' }, onclick: reloadApp }, icon('refresh'), '清除快取並重新載入'))));
}

async function reloadApp() {
  try {
    if ('serviceWorker' in navigator) (await navigator.serviceWorker.getRegistrations()).forEach((r) => r.unregister());
    if (window.caches) (await caches.keys()).forEach((k) => caches.delete(k));
  } catch (e) { /* 忽略 */ }
  location.reload();
}

function openChangePin() {
  const f = { oldPin: '', newPin: '', again: '' };
  const banner = h('div', { class: 'notice bad', role: 'alert', style: { display: 'none', marginBottom: '10px' } });
  const inp = (label, key) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), h('input', { type: 'password', autocomplete: 'off', inputmode: 'numeric', oninput: (e) => { f[key] = e.target.value; } }));
  const save = h('button', { class: 'btn btn-primary', type: 'button', onclick: async (e) => {
    banner.style.display = 'none';
    if (f.newPin !== f.again) { banner.style.display = ''; mount(banner, '兩次輸入的新 PIN 不一致'); return; }
    await withBusy(e.currentTarget, async () => {
      try { await api.call('changePin', { oldPin: f.oldPin, newPin: f.newPin }); sheet.close(); toast('PIN 已變更，其他裝置下次登入也要用新的 PIN'); }
      catch (err) { banner.style.display = ''; mount(banner, errorText(err)); }
    });
  } }, '變更');
  const sheet = openSheet({ title: '變更 PIN', dismissable: false, body: h('div', null, banner, inp('目前的 PIN', 'oldPin'), inp('新的 PIN（至少 6 碼）', 'newPin'), inp('再輸入一次新的 PIN', 'again')),
    footer: [h('button', { class: 'btn', type: 'button', onclick: () => sheet.close() }, '取消'), save] });
}
