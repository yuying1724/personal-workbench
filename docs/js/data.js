import { state, notify, prefs } from './store.js';
import * as api from './api.js';
import { toast, errorText } from './ui.js';

// ---------- 本機快取（開頁先畫上次的資料，背景再更新） ----------
// 存在 localStorage 的 wb.cache：{ device, loadedAt, data }。device 取自工作階段碼（D4.… 的 D4），
// 換了授權碼（不同裝置身分）就不用舊快取。鎖定／閒置後重新輸入 PIN 仍會用快取，才有「秒開」的效果。
const CACHE_KEY = 'wb.cache';
function sessionDevice() { const s = prefs.session; return s && s.session ? String(s.session).split('.')[0] : ''; }
export function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!c || !c.data || c.device !== sessionDevice()) return null;
    return { data: c.data, loadedAt: new Date(c.loadedAt) };
  } catch (e) { return null; }
}
function saveCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ device: sessionDevice(), loadedAt: state.loadedAt, data: state.data })); } catch (e) { /* 空間不足或被封鎖就算了 */ }
}
export function clearCache() { try { localStorage.removeItem(CACHE_KEY); } catch (e) { /* 忽略 */ } }

// ---------- 讀寫的先後順序 ----------
// 背景讀取（refresh／reload）如果比使用者的寫入「早出發、晚回來」，帶回來的是寫入前的舊資料，
// 直接套用會把剛剛的樂觀更新蓋掉（例如剛打的卡又消失）。所以：
//   - 讀取出發後有新的寫入（或還有寫入在路上）→ 這份讀取結果丟掉，等寫入都完成後再補抓
//   - 寫入成功時後端會順便帶回該模組的最新資料（reload），沒有其他寫入在路上才套用
state.pendingWrites = 0;
state.lastWriteAt = 0;
const deferred = new Set(); // 等寫入都完成後要補抓的 bundle（'bootstrap' 代表整包）
function writesSince(started) { return state.pendingWrites > 0 || state.lastWriteAt >= started; }
function applyBundle(data) {
  Object.assign(state.data, data);
  state.loadedAt = new Date();
  saveCache();
  notify();
}
function flushDeferred() {
  if (state.pendingWrites > 0 || !deferred.size) return Promise.resolve();
  const list = [...deferred];
  deferred.clear();
  return list.includes('bootstrap') ? refresh() : reload(...list);
}

/** 重新載入全部資料（登入後第一次、或按「重新整理」） */
export async function refresh() {
  const started = Date.now();
  state.refreshing = true;
  notify();
  try {
    const data = await api.call('bootstrap');
    if (state.data && writesSince(started)) { deferred.add('bootstrap'); return; }
    state.data = data;
    state.loadedAt = new Date();
    state.adminStale = false;
    saveCache();
  } finally {
    state.refreshing = false;
    notify();
    if (state.pendingWrites === 0 && deferred.has('bootstrap')) setTimeout(() => flushDeferred().catch(() => {}), 0);
  }
}

/** 只重抓某個模組（例如 'task_bundle'），合併回 state.data；bundle 回傳的欄位名稱跟 bootstrap 一樣 */
export async function reload(...bundles) {
  const started = Date.now();
  const results = await Promise.all(bundles.map((b) => api.call(b)));
  if (writesSince(started)) { bundles.forEach((b) => deferred.add(b)); flushDeferred().catch(() => {}); return; }
  const merged = Object.assign({}, ...results);
  applyBundle(merged);
}

// 每個寫入動作儲存後要重抓哪些資料（後端也有同一張表，會直接把資料附在寫入的回應裡）
const RELOAD_AFTER = {
  course: ['course_bundle'], subscription: ['sub_bundle'], task: ['project_task_bundle'], task_status: ['project_task_bundle'], project: ['project_task_bundle'],
  habit: ['habit_bundle'], habit_log: ['habit_bundle'], diary: ['diary_bundle'], option: ['admin_bundle'], system: ['admin_bundle'],
};

/**
 * 寫入並重新整理相關資料。失敗時顯示錯誤訊息並回傳 null（呼叫端可以不用 try/catch）。
 * opts.quiet：成功時不跳提示；opts.throw：失敗時把錯誤丟回給呼叫端（表單要顯示在表單裡時用）
 * opts.optimistic：樂觀更新——先在本機 state.data 改好並立刻重畫，背景送出；失敗就呼叫它回傳的還原函式並提示。
 *   這種情況下 write 在後端回應後就 resolve，相關資料的更新在背景進行，不會卡住畫面。
 */
export async function write(action, payload, opts = {}) {
  let undo = null;
  state.pendingWrites++;
  state.lastWriteAt = Date.now();
  if (opts.optimistic) {
    try { undo = opts.optimistic() || null; } catch (e) { console.error(e); undo = null; }
    if (opts.toast) toast(opts.toast); // 樂觀更新：畫面已經改了就先提示，失敗再另外提示
  }
  notify();
  let res;
  try {
    res = await api.call(action, payload, { meta: true });
  } catch (e) {
    state.pendingWrites--;
    if (undo) { try { undo(); } catch (e2) { console.error(e2); } }
    notify();
    flushDeferred().catch(() => {});
    if (e.code === 'AUTH_REQUIRED') return null;
    if (opts.throw) throw e;
    const prefix = opts.optimistic ? (action.startsWith('delete_') ? '刪除失敗，已還原：' : '儲存失敗，已還原：') : '';
    toast(prefix + errorText(e), { kind: 'bad', ms: opts.retry ? 10000 : undefined, action: opts.retry ? { label: '重試', fn: opts.retry } : undefined });
    return null;
  }
  state.pendingWrites--;
  state.adminStale = true;
  const kind = action.replace(/^(create|update|delete|skip|set|add|rename)_/, '');
  // 改選項名稱會連動改到各模組的資料，所以整包重抓
  const wanted = action === 'rename_option' ? ['bootstrap'] : RELOAD_AFTER[kind] || ['bootstrap'];
  const got = res.reload && wanted.length === 1 && res.reload.name === wanted[0] ? res.reload : null;
  if (got && state.pendingWrites === 0) applyBundle(got.data);
  else { wanted.forEach((b) => deferred.add(b)); notify(); }
  const sync = flushDeferred();
  if (opts.optimistic) sync.catch((e) => { if (e.code !== 'AUTH_REQUIRED') console.error(e); });
  else {
    try { await sync; } catch (e) { if (e.code !== 'AUTH_REQUIRED') console.error(e); }
    if (opts.toast) toast(opts.toast);
  }
  return res.data || {};
}

// ---------- 表單的樂觀新增／修改／刪除（按下儲存立刻關視窗、清單立刻反應，背景送出） ----------
/** 修改（id 找得到）或新增（用暫時 ID 先放進清單）一筆本機資料，回傳 { row, undo } */
export function upsertLocal(listKey, idField, id, fields) {
  const list = state.data[listKey] || (state.data[listKey] = []);
  const row = id ? list.find((r) => r[idField] === id) : null;
  if (row) {
    const snap = Object.assign({}, row);
    Object.assign(row, fields);
    return { row, undo: () => { Object.keys(row).forEach((k) => delete row[k]); Object.assign(row, snap); } };
  }
  const fresh = Object.assign({ [idField]: 'tmp-' + Date.now().toString(36), __pending: true }, fields);
  list.push(fresh);
  return { row: fresh, undo: () => { const i = list.indexOf(fresh); if (i >= 0) list.splice(i, 1); } };
}
/** 從本機清單移除一筆，回傳還原函式（找不到回傳 null） */
export function removeLocal(listKey, idField, id) {
  const list = state.data[listKey] || [];
  const i = list.findIndex((r) => r[idField] === id);
  if (i < 0) return null;
  const [row] = list.splice(i, 1);
  return () => { list.splice(Math.min(i, list.length), 0, row); };
}
/**
 * 樂觀新增／修改：spec = { list, idField, id?（修改時）, fields?（要寫進本機資料的欄位，預設＝payload）, recalc?（重算統計，回傳還原函式）, toast }
 * 新增成功後會把暫時 ID 換成後端給的正式 ID；背景重抓 bundle 後整份資料會被正式版取代。
 */
// 剛新增、還在等後端給正式 ID 的資料：暫時 ID → Promise<正式 ID 或 null>
// 新增後 2～4 秒內馬上編輯／刪除時，先等新增完成、換成正式 ID 再送出（不然後端找不到 tmp- 開頭的 ID）
const pendingCreates = new Map();
function waitForRealId(spec, run) {
  const tmp = spec.id;
  toast('剛新增的資料還在儲存中，完成後會自動送出這次的修改');
  return pendingCreates.get(tmp).then((realId) => {
    if (!realId) { toast('這筆資料新增失敗，這次的修改沒有送出', { kind: 'bad' }); return null; }
    return run(realId);
  });
}

export function saveRow(action, payload, spec) {
  if (spec.id && pendingCreates.has(spec.id)) {
    return waitForRealId(spec, (realId) => saveRow(action, Object.assign({}, payload, { [spec.idField]: realId }), Object.assign({}, spec, { id: realId })));
  }
  let created = null;
  const p = write(action, payload, {
    toast: spec.toast,
    optimistic: () => {
      const { row, undo } = upsertLocal(spec.list, spec.idField, spec.id, spec.fields || payload);
      if (!spec.id) created = row;
      const undoCalc = spec.recalc ? spec.recalc() : null;
      return () => { undo(); if (undoCalc) undoCalc(); };
    },
    retry: () => saveRow(action, payload, spec),
  });
  if (created) {
    const tmp = created[spec.idField];
    pendingCreates.set(tmp, p.then((r) => (r && r.id) || null, () => null));
    p.finally(() => setTimeout(() => pendingCreates.delete(tmp), 0));
  }
  p.then((r) => { if (r && r.id && created) { created[spec.idField] = r.id; delete created.__pending; } });
  return p;
}
/** 樂觀刪除：spec = { list, idField, id, recalc?, toast } */
export function deleteRow(action, payload, spec) {
  if (spec.id && pendingCreates.has(spec.id)) {
    return waitForRealId(spec, (realId) => deleteRow(action, Object.assign({}, payload, { [spec.idField]: realId }), Object.assign({}, spec, { id: realId })));
  }
  return write(action, payload, {
    toast: spec.toast,
    optimistic: () => {
      const undo = removeLocal(spec.list, spec.idField, spec.id);
      const undoCalc = spec.recalc ? spec.recalc() : null;
      return () => { if (undo) undo(); if (undoCalc) undoCalc(); };
    },
    retry: () => deleteRow(action, payload, spec),
  });
}

/** 依「系統索引」分頁的名稱（使用者可在分類管理改名）取得模組顯示名稱 */
export function systemName(sheetKey, fallback) {
  const list = (state.data && state.data.systemIndex) || [];
  const s = list.find((x) => x['主表分頁名稱'] === sheetKey);
  return (s && s['系統名稱']) || fallback;
}
