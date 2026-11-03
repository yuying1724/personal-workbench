/* Service Worker（由 tools/build-web.js 自動產生，請勿直接編輯）
 * 讓網站可以安裝成 App，離線時至少能開啟外殼。
 * 策略：同網域的檔案「快取優先」（安裝時整批存好這一版），改版時整批換新；呼叫後端 API（跨網域 POST）完全不經過快取。 */
const VERSION = 'wb-e9dd32a33a';
const SHELL = [
  "./",
  "config.js",
  "css/app.css",
  "icons/icon-192.png",
  "icons/icon.svg",
  "index.html",
  "js/api.js",
  "js/app.js",
  "js/biometric.js",
  "js/data.js",
  "js/dom.js",
  "js/icons.js",
  "js/push.js",
  "js/shared-logic.js",
  "js/store.js",
  "js/theme-boot.js",
  "js/ui.js",
  "js/util.js",
  "js/views/admin.js",
  "js/views/common.js",
  "js/views/courses.js",
  "js/views/diary.js",
  "js/views/diarylock.js",
  "js/views/habits.js",
  "js/views/heatmap.js",
  "js/views/home.js",
  "js/views/login.js",
  "js/views/more.js",
  "js/views/projects.js",
  "js/views/settings.js",
  "js/views/subs.js",
  "js/views/tasks.js",
  "manifest.webmanifest"
];
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
// 後端送來的推播沒有內容（省掉加密），收到後用裝置摘要碼向後端拿「這個時段」的摘要再顯示；拿不到就顯示一般提醒。
async function pushSummary() {
  const c = await caches.open(PUSH_CACHE);
  const [tok, api] = await Promise.all([c.match('./push-token'), c.match('./push-api')]);
  if (!tok || !api) return null;
  const token = await tok.text(), apiUrl = await api.text();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(apiUrl, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'push_summary', params: { token } }) });
    const body = await res.json();
    if (body && body.via === 'GET') continue; // 被 Google 轉址成 GET，再試一次
    return body && body.ok ? body.data : null;
  }
  return null;
}
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let title = '個人工作台', body = '有事要處理，點開查看', url = '#/home', tag = 'wb-todo';
    try { const s = await pushSummary(); if (s && s.title) { title = s.title; body = s.body || ''; url = s.url || url; tag = 'wb-' + (s.slot || 'todo'); } } catch (err) { /* 顯示一般提醒 */ }
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
