/* Service Worker（由 tools/build-web.js 自動產生，請勿直接編輯）
 * 讓網站可以安裝成 App，離線時至少能開啟外殼。
 * 策略：同網域的檔案「快取優先」（安裝時整批存好這一版），改版時整批換新；呼叫後端 API（跨網域 POST）完全不經過快取。 */
const VERSION = 'wb-6ebf364371';
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
  "js/shared-logic.js",
  "js/store.js",
  "js/theme-boot.js",
  "js/ui.js",
  "js/util.js",
  "js/views/admin.js",
  "js/views/common.js",
  "js/views/courses.js",
  "js/views/diary.js",
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

self.addEventListener('install', (e) => {
  // cache: 'reload'：略過瀏覽器的 HTTP 快取，確保存進來的是這一版的檔案
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
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
