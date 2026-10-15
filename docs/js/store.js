// 狀態與偏好設定。localStorage 可能被封鎖（隱私模式），所以每次存取都包 try/catch，失敗就退回記憶體。
const mem = {};
function get(key) { try { const v = localStorage.getItem(key); return v === null ? (mem[key] ?? null) : v; } catch (e) { return mem[key] ?? null; } }
function set(key, value) {
  mem[key] = value;
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) { /* 忽略 */ }
}

export const prefs = {
  get token() { return get('wb.token'); }, set token(v) { set('wb.token', v); },
  get apiUrl() { return get('wb.apiUrl') || (window.WB_CONFIG && window.WB_CONFIG.apiUrl) || ''; }, set apiUrl(v) { set('wb.apiUrl', v); },
  // 預設淺色；選「跟隨系統」也會記下來（存成 'auto'）
  // 閒置多久要重新輸入 PIN（分鐘，這台裝置自己的設定；預設 7 天）
  get ttlMinutes() { return Number(get('wb.ttlMinutes')) || 7 * 24 * 60; }, set ttlMinutes(v) { set('wb.ttlMinutes', String(v)); },
  // 日記進入前驗證：'off' | '0' | '5' | '15' | 'app'（見 views/diarylock.js）
  get diaryLock() { return get('wb.diaryLock') || 'off'; }, set diaryLock(v) { set('wb.diaryLock', v); },
  get theme() { return get('wb.theme') || 'light'; },
  set theme(v) { set('wb.theme', v); applyTheme(); },
  get session() { try { return JSON.parse(get('wb.session') || 'null'); } catch (e) { return null; } },
  set session(v) { set('wb.session', v ? JSON.stringify(v) : null); },
  // 各頁面的篩選／收合狀態（只存在這台裝置）
  getView(key, def) { try { return JSON.parse(get('wb.view.' + key) || 'null') ?? def; } catch (e) { return def; } },
  setView(key, v) { set('wb.view.' + key, JSON.stringify(v)); },
};

export function applyTheme() {
  const root = document.documentElement;
  if (prefs.theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', prefs.theme);
  // 手機狀態列顏色跟著 App 的主題（不是只跟系統設定）
  const dark = prefs.theme === 'dark' || (prefs.theme === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m, i) => {
    if (i > 0) { m.remove(); return; }
    m.removeAttribute('media');
    m.setAttribute('content', dark ? '#221c15' : '#f6efdd');
  });
}

/** 清除這台裝置上所有工作台的資料（授權碼、登入狀態、資料快取、草稿、畫面設定） */
export function wipeDeviceData() {
  try {
    Object.keys(localStorage).filter((k) => k.startsWith('wb.')).forEach((k) => localStorage.removeItem(k));
  } catch (e) { /* 忽略 */ }
  Object.keys(mem).forEach((k) => delete mem[k]);
}

// 全域狀態：state.data = bootstrap 回傳的整包資料（courses、tasks、habits…）
export const state = { data: null, listeners: new Set(), dataVersion: 0 };
export function subscribe(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); }
/** 通知畫面更新。dataChanged=false 代表只是「同步中／更新中」這類狀態變了、資料本身沒變（畫面可以不用整個重畫） */
export function notify(dataChanged = true) { if (dataChanged) state.dataVersion++; state.listeners.forEach((fn) => fn()); }
