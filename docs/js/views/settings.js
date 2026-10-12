import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { prefs, state, notify, wipeDeviceData } from '../store.js';
import * as api from '../api.js';
import { openSheet, toast, errorText, withBusy, confirmDialog } from '../ui.js';
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
          h('button', { class: 'btn btn-sm', onclick: () => lock('已鎖定') }, icon('logout'), '鎖定並登出'),
          h('button', { class: 'btn btn-sm btn-danger', onclick: wipeThisDevice }, icon('trash'), '清除這台裝置的資料')),
        h('div', { class: 'field', style: { marginTop: '12px' } }, h('span', { class: 'lbl' }, '這台裝置閒置多久要重新輸入 PIN'),
          seg(TTL_OPTIONS, prefs.ttlMinutes, (v) => setTtl(v))),
        h('p', { class: 'muted small' }, '時間越長越方便，但手機或電腦被別人拿到時，對方也能直接看到資料。公司或共用電腦建議選「1 小時」。'),
        h('p', { class: 'muted small', style: { marginBottom: 0 } }, `這台裝置：${meta.device || '（未命名）'}。要新增或撤銷裝置（例如家裡電腦、新手機），請在試算表選單「個人工作台」操作。`),
        h('p', { class: 'muted small', style: { marginBottom: 0 } }, '「鎖定並登出」之後，資料快取和裝置授權碼還留在這台裝置（下次只要輸入 PIN、而且秒開）。在公司或別人的電腦上用完，建議按「清除這台裝置的資料」。')),
      h('div', { class: 'card' }, h('h2', null, '資料'),
        meta.sheetUrl ? h('a', { class: 'btn btn-sm', href: meta.sheetUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), '開啟試算表') : null,
        h('p', { class: 'muted small', style: { marginBottom: 0 } }, '最後更新：' + (state.loadedAt ? state.loadedAt.toLocaleString('zh-TW') : '—'))),
      h('div', { class: 'card' }, h('h2', null, '關於'),
        h('dl', { class: 'kv' },
          h('dt', null, '版本'), h('dd', null, meta.version || '—'),
          h('dt', null, '後端'), h('dd', { class: 'mono' }, prefs.apiUrl.replace(/^https?:\/\//, '').slice(0, 60) + (prefs.apiUrl.length > 68 ? '…' : ''))),
        h('button', { class: 'btn btn-sm', style: { marginTop: '12px' }, onclick: reloadApp }, icon('refresh'), '清除快取並重新載入'))));
}

const TTL_OPTIONS = [[60, '1 小時'], [24 * 60, '1 天'], [7 * 24 * 60, '7 天'], [30 * 24 * 60, '30 天']];

async function setTtl(minutes) {
  const prev = prefs.ttlMinutes;
  prefs.ttlMinutes = minutes;
  notify();
  try {
    await api.call('set_session_ttl', { ttlMinutes: minutes });
    const label = (TTL_OPTIONS.find(([v]) => v === minutes) || [0, minutes + ' 分鐘'])[1];
    toast(`已設定：閒置 ${label}才需要重新輸入 PIN`);
  } catch (e) {
    prefs.ttlMinutes = prev;
    notify();
    if (e.code !== 'AUTH_REQUIRED') toast(errorText(e), { kind: 'bad' });
  }
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

async function wipeThisDevice() {
  const ok = await confirmDialog({ title: '清除這台裝置的資料', message: '會刪除這台裝置上的裝置授權碼、登入狀態、資料快取、日記草稿與畫面設定，然後回到登入畫面。試算表裡的資料不受影響；之後要再用這台裝置，需要重新輸入裝置授權碼和 PIN。確定要清除嗎？', confirmText: '清除', danger: true });
  if (!ok) return;
  wipeDeviceData();
  try { if (window.caches) (await caches.keys()).forEach((k) => caches.delete(k)); } catch (e) { /* 忽略 */ }
  location.reload();
}
