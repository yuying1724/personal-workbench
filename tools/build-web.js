'use strict';
/**
 * 產生 docs/sw.js：把前端所有檔案列進快取清單，版本號用檔案內容的雜湊，
 * 這樣每次改完程式推上 GitHub，手機上的 App 一定會抓到新版（不會被舊快取卡住）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DOCS = path.join(__dirname, '../docs');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// shared/logic.js（前後端共用邏輯的唯一正本）→ docs/js/shared-logic.js（加上 ES module 的 export）
function buildShared() {
  const src = fs.readFileSync(path.join(__dirname, '../shared/logic.js'), 'utf8');
  const out = '// 由 tools/build-web.js 從 shared/logic.js 自動產生，請勿直接編輯（要改請改 shared/logic.js 再 npm run build）\n' +
    src + '\nexport default WbLogic;\n';
  fs.writeFileSync(path.join(DOCS, 'js/shared-logic.js'), out);
}

// index.html 裡的 <link rel="modulepreload">：列出 js/ 底下所有模組，瀏覽器一開始就平行下載，
// 不用等 app.js → views → common → dom 一層一層發現（每一層都要多等一趟網路來回）
function injectModulePreload() {
  const p = path.join(DOCS, 'index.html');
  const html = fs.readFileSync(p, 'utf8');
  const mods = walk(path.join(DOCS, 'js')).map((f) => path.relative(DOCS, f).split(path.sep).join('/'))
    .filter((f) => f.endsWith('.js') && f !== 'js/theme-boot.js').sort();
  const links = mods.map((m) => `  <link rel="modulepreload" href="${m}">`).join('\n');
  const out = html.replace(/<!-- modulepreload:start -->[\s\S]*?<!-- modulepreload:end -->/, `<!-- modulepreload:start -->\n${links}\n  <!-- modulepreload:end -->`);
  if (out !== html) fs.writeFileSync(p, out);
}

function build() {
  buildShared();
  injectModulePreload();
  const files = walk(DOCS).map((p) => path.relative(DOCS, p).split(path.sep).join('/'))
    .filter((f) => f !== 'sw.js' && !f.endsWith('.png') || f === 'icons/icon-192.png').sort();
  const hash = crypto.createHash('sha256');
  files.forEach((f) => hash.update(f).update(fs.readFileSync(path.join(DOCS, f))));
  const version = 'wb-' + hash.digest('hex').slice(0, 10);
  const shell = ['./'].concat(files);
  const src = `/* Service Worker（由 tools/build-web.js 自動產生，請勿直接編輯）
 * 讓網站可以安裝成 App，離線時至少能開啟外殼。
 * 策略：同網域的檔案「快取優先」（安裝時整批存好這一版），改版時整批換新；呼叫後端 API（跨網域 POST）完全不經過快取。 */
const VERSION = '${version}';
const SHELL = ${JSON.stringify(shell, null, 2)};
// 推播通知用的小倉庫（跟版本無關、改版不清掉）：頁面在開啟通知時把「後端網址」和「裝置摘要碼」放進來，收到推播時用它去拿摘要
const PUSH_CACHE = 'wb-push';

self.addEventListener('install', (e) => {
  // cache: 'reload'：略過瀏覽器的 HTTP 快取，確保存進來的是這一版的檔案
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== PUSH_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// 快取優先：這一版的所有檔案在安裝時就整批存好（VERSION＝檔案內容雜湊，改版就整批換新），
// 所以訊號差、離線也能秒開；不在快取裡的才走網路。有新版時瀏覽器會自動抓新的 sw.js、裝好新的一批，
// 畫面會提示「已更新到新版本」，重新載入就是新版。
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(caches.open(VERSION).then((c) => c.match(req, { ignoreSearch: true }).then((hit) => {
    if (hit) return hit;
    return fetch(req).then((res) => {
      if (res.ok) c.put(req, res.clone());
      return res;
    }).catch((err) => (req.mode === 'navigate' ? c.match('./').then((x) => x || c.match('index.html')) : Promise.reject(err)));
  })));
});

// ---------- 推播通知 ----------
// 後端送來的推播沒有內容（省掉加密），收到後用裝置摘要碼向後端拿「這個時段」的摘要再顯示。
// 手機剛被叫醒時網路可能還沒好：每次最多等 12 秒、失敗就隔一下再試，總共 3 次；都失敗才顯示一般提醒，並把原因記下來（設定頁會顯示）。
async function pushSummary() {
  const c = await caches.open(PUSH_CACHE);
  const [tok, api] = await Promise.all([c.match('./push-token'), c.match('./push-api')]);
  if (!tok || !api) throw new Error('這支裝置沒有存裝置摘要碼');
  const token = await tok.text(), apiUrl = await api.text();
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 2000));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetch(apiUrl, { method: 'POST', redirect: 'follow', signal: ctl.signal, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'push_summary', params: { token } }) });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch (e) { throw new Error('後端回應不是 JSON（' + res.status + '）'); }
      if (body && body.via === 'GET') throw new Error('請求被轉成 GET');
      if (body && body.ok) return body.data;
      const err = new Error((body && body.error && body.error.message) || '後端回應錯誤');
      if (body && body.error && body.error.code === 'AUTH_FAILED') { err.fatal = true; throw err; }
      throw err;
    } catch (e) {
      lastErr = e && e.name === 'AbortError' ? new Error('等後端超過 12 秒') : e;
      if (lastErr.fatal) break;
    } finally { clearTimeout(timer); }
  }
  throw lastErr || new Error('拿不到內容');
}
async function notePushResult(err, title, body) {
  try {
    const c = await caches.open(PUSH_CACHE);
    const v = { at: new Date().toISOString(), ok: !err, error: err ? String((err && err.message) || err).slice(0, 120) : '', title, body: String(body || '').slice(0, 300) };
    await c.put('./push-last', new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) { /* 忽略 */ }
}
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let title = '個人工作台', body = '有事要處理，點開查看', url = '#/home', tag = 'wb-todo', err = null;
    try { const s = await pushSummary(); if (s && s.title) { title = s.title; body = s.body || ''; url = s.url || url; tag = 'wb-' + (s.slot || 'todo'); } } catch (x) { err = x; }
    await notePushResult(err, title, body);
    await self.registration.showNotification(title, { body, icon: './icons/icon-192.png', badge: './icons/icon-192.png', tag, renotify: true, data: { url: self.registration.scope + url } });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.indexOf(self.registration.scope) === 0);
    if (open) { try { open.navigate(url); } catch (err) { /* 舊瀏覽器沒有 navigate */ } return open.focus(); }
    return self.clients.openWindow(url);
  }));
});
`;
  fs.writeFileSync(path.join(DOCS, 'sw.js'), src);
  return { version, files: shell };
}

if (require.main === module) { const r = build(); console.log(`docs/sw.js 已產生（${r.version}，${r.files.length} 個檔案）`); }
module.exports = { build };
