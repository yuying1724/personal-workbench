/**
 * 推播通知（Web Push）：每支手機自己開啟，跟習慣的時段對齊，一天最多四則（早上／中午／晚上／睡前），各自可關、時間各自可調；沒事就不推。
 *  - 開啟：要求通知權限 → 向瀏覽器登記推播（用後端的 VAPID 公鑰）→ 把訂閱交給後端（push_subscribe）
 *  - 後端回的「裝置摘要碼」和後端網址放進 Cache Storage（service worker 收到推播時用它拿摘要）；訂閱編號與時段設定存 localStorage（wb.push）
 *  - 推播本身由後端每小時排程發出
 */
import * as api from './api.js';
import { prefs, state } from './store.js';

const LS = 'wb.push';
const PUSH_CACHE = 'wb-push';
export const SLOTS = ['morning', 'noon', 'evening', 'night'];
export const SLOT_INFO = {
  morning: { label: '早上', hour: 8, hint: '早上的習慣、今天到期的任務、逾期、3 天內要付款的訂閱' },
  noon: { label: '中午', hour: 12, hint: '中午的習慣、早上還沒打卡的' },
  evening: { label: '晚上', hour: 20, hint: '晚上的習慣、今天還沒完成的任務' },
  night: { label: '睡前', hour: 22, hint: '今天還沒打卡的全部習慣（含「不限」時段）' },
};
export const HOURS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
export function defaultSlots() { const o = {}; SLOTS.forEach((k) => { o[k] = { on: true, hour: SLOT_INFO[k].hour }; }); return o; }

export function isSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && typeof caches !== 'undefined';
}
/** iPhone／iPad 的 Safari：要先「加入主畫面」才有推播 */
export function needsHomeScreen() {
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return ios && !standalone;
}
export function local() { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) { return null; } }
function saveLocal(v) { try { if (v) localStorage.setItem(LS, JSON.stringify(v)); else localStorage.removeItem(LS); } catch (e) { /* 忽略 */ } }
export function permission() { try { return Notification.permission; } catch (e) { return 'default'; } }

function b64ToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
async function registration() {
  const reg = await navigator.serviceWorker.getRegistration();
  if (reg) return reg;
  return navigator.serviceWorker.ready;
}
async function putMeta(token) {
  const c = await caches.open(PUSH_CACHE);
  await c.put('./push-token', new Response(token, { headers: { 'Content-Type': 'text/plain' } }));
  await c.put('./push-api', new Response(new URL(prefs.apiUrl, location.href).href, { headers: { 'Content-Type': 'text/plain' } })); // 存絕對網址（service worker 裡沒有頁面網址可以相對）
}
async function clearMeta() { try { await caches.delete(PUSH_CACHE); } catch (e) { /* 忽略 */ } }

async function hasMeta() {
  try { const c = await caches.open(PUSH_CACHE); const [t, a] = await Promise.all([c.match('./push-token'), c.match('./push-api')]); return !!(t && a); } catch (e) { return false; }
}
/**
 * 自我修復：這台裝置有開通知、瀏覽器的推播登記也在，但 Cache Storage 裡的裝置摘要碼不見了（例如按過「清除快取並重新載入」、瀏覽器清資料）
 * → 收到推播時 service worker 拿不到摘要，只會顯示「有事要處理，點開查看」。這裡用同一個推播網址重新向後端登記一次（後端會換發新的摘要碼）。
 * App 啟動與設定頁都會呼叫；沒事就什麼都不做。回傳 true 代表有修過。
 */
export async function ensureMeta() {
  if (!isSupported()) return false;
  const l = local();
  if (!l || !l.id) return false;
  if (await hasMeta()) return false;
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return false;
  const j = sub.toJSON();
  const r = await api.call('push_subscribe', { endpoint: j.endpoint, keys: j.keys, slots: l.slots || defaultSlots(), label: (state.data && state.data.meta && state.data.meta.device) || '' });
  await putMeta(r.token);
  saveLocal(Object.assign({}, l, { id: r.id, slots: r.slots }));
  return true;
}

/** 這台裝置目前的狀態：{ supported, permission, enabled, slots, id } */
export async function status() {
  if (!isSupported()) return { supported: false, enabled: false, permission: permission(), slots: defaultSlots() };
  try { await ensureMeta(); } catch (e) { /* 修不好就維持現狀，設定頁仍可關閉再開啟 */ }
  const l = local();
  let sub = null;
  try { const reg = await registration(); sub = reg ? await reg.pushManager.getSubscription() : null; } catch (e) { sub = null; }
  return { supported: true, permission: permission(), enabled: !!(l && l.id && sub), slots: (l && l.slots) || defaultSlots(), id: l ? l.id : '' };
}

/** 開啟：回傳 { id, slots, trigger }；trigger=false 代表後端沒辦法自己裝排程（要到試算表選單安裝） */
export async function enable(slots) {
  if (!isSupported()) throw new Error('這個瀏覽器不支援推播通知');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? '通知權限被拒絕了，請到瀏覽器或手機的網站設定裡允許通知' : '沒有允許通知');
  const info = await api.call('push_info');
  const reg = await registration();
  if (!reg) throw new Error('App 還沒安裝完成（service worker 未就緒），請重新整理後再試');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(info.publicKey) });
  const j = sub.toJSON();
  const r = await api.call('push_subscribe', { endpoint: j.endpoint, keys: j.keys, slots: slots || defaultSlots(), label: (state.data && state.data.meta && state.data.meta.device) || '' });
  await putMeta(r.token);
  saveLocal({ id: r.id, slots: r.slots, at: new Date().toISOString().slice(0, 10) });
  return r;
}

export async function disable() {
  const l = local();
  let endpoint = '';
  try { const reg = await registration(); const sub = reg ? await reg.pushManager.getSubscription() : null; if (sub) { endpoint = sub.endpoint; await sub.unsubscribe(); } } catch (e) { /* 忽略 */ }
  try { await api.call('push_unsubscribe', { id: l ? l.id : '', endpoint }); } catch (e) { /* 後端那筆留著也沒關係：推不到會自動停用 */ }
  await clearMeta();
  saveLocal(null);
}

/** 改某個時段的開關或時間（只送有變的欄位）；回傳後端整理過的四個時段設定 */
export async function setSlot(slot, patch) {
  const l = local();
  if (!l || !l.id) throw new Error('還沒開啟通知');
  const r = await api.call('push_update', { id: l.id, slots: { [slot]: patch } });
  saveLocal(Object.assign({}, l, { slots: r.slots }));
  return r.slots;
}

/** 立刻推一則測試通知（後端送出；幾秒內手機應該會跳）；slot 不給就依現在幾點挑 */
export async function sendTest(slot) {
  const l = local();
  if (!l || !l.id) throw new Error('還沒開啟通知');
  return api.call('push_test', { id: l.id, slot });
}
