import { prefs } from './store.js';

export class ApiError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details || null; }
}

let onAuthLost = () => {};
export function setAuthLostHandler(fn) { onAuthLost = fn; }

function parseExp(session) { const p = String(session || '').split('.'); return Number(p[2]) || 0; }
export function setSession(session, ttlMinutes) {
  if (!session) { prefs.session = null; return; }
  const prev = prefs.session || {};
  prefs.session = { session, exp: parseExp(session), ttl: ttlMinutes || prev.ttl || 60 };
}
export function hasValidSession() { const s = prefs.session; return !!(s && s.session && s.exp > Date.now()); }
export function clearSession() { prefs.session = null; }

// 讀取類的操作可以安全重試（再問一次而已）；「覆寫同一筆」或「upsert」的寫入重送結果也一樣，所以也可以重試。
// 單純「新增一筆」的動作不重試：萬一第一次其實已經寫進去、只是回應沒送到，重試會多出一筆重複資料。
const RETRYABLE = new Set([
  'bootstrap', 'all', 'admin_bundle', 'course_bundle', 'sub_bundle', 'task_bundle', 'project_bundle', 'project_task_bundle', 'habit_bundle', 'diary_bundle',
  'update_course', 'delete_course', 'update_subscription', 'delete_subscription', 'update_task', 'delete_task',
  'update_project', 'delete_project', 'update_habit', 'delete_habit', 'set_habit_log',
  'create_diary', 'update_diary', 'delete_diary', 'delete_option', 'update_system',
]);

/** 呼叫後端。Apps Script 網頁應用程式用 text/plain 送 JSON（避免瀏覽器的 CORS 預檢）。 */
export async function call(action, params = {}, opts = {}) {
  const url = prefs.apiUrl;
  if (!url) throw new ApiError('NO_URL', '還沒有設定後端網址，請在登入畫面展開「連線設定」填寫');
  const maxAttempts = RETRYABLE.has(action) ? 3 : 1;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await once(url, action, params, opts);
    } catch (e) {
      lastErr = e;
      // 只有「連線問題／回應不是 JSON」才重試；後端明確回的業務錯誤（找不到資料等）重送也不會變好
      if (!(e.code === 'NETWORK' || e.code === 'BAD_RESPONSE' || e.code === 'TIMEOUT') || attempt === maxAttempts) break;
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
  if (lastErr && (lastErr.code === 'NETWORK' || lastErr.code === 'BAD_RESPONSE') && !RETRYABLE.has(action)) {
    lastErr.message += '。請按「重新整理」確認資料有沒有存進去，再決定要不要重新送出';
  }
  throw lastErr;
}

async function once(url, action, params, opts) {
  const sess = prefs.session;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 45000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST', redirect: 'follow', signal: ctrl.signal, cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, params, session: sess ? sess.session : undefined }),
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new ApiError('TIMEOUT', '連線逾時，請稍後再試');
    throw new ApiError('NETWORK', navigator.onLine === false ? '目前沒有網路連線' : '無法連到後端，請檢查網路或後端網址');
  } finally {
    clearTimeout(timer);
  }
  let body;
  try { body = await res.json(); } catch (e) { throw new ApiError('BAD_RESPONSE', '後端暫時沒有正確回應（網址是否填成 Apps Script 的「網頁應用程式」網址？）'); }
  if (body.session) setSession(body.session);
  if (!body.ok) {
    const err = body.error || {};
    if (err.code === 'AUTH_REQUIRED') { clearSession(); onAuthLost(); }
    throw new ApiError(err.code || 'ERROR', err.message || (typeof body.error === 'string' ? body.error : '發生錯誤'), err.details);
  }
  return body.data;
}
