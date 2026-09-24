/* Service Worker（由 tools/build-web.js 自動產生，請勿直接編輯）
 * 讓網站可以安裝成 App，離線時至少能開啟外殼。
 * 策略：同網域的檔案「網路優先、失敗才用快取」，更新程式後不會被舊快取卡住；呼叫後端 API（跨網域 POST）完全不經過快取。 */
const VERSION = 'wb-ef37a8ca91';
const SHELL = [
  "./",
  "config.js",
  "css/app.css",
  "icons/icon-192.png",
  "icons/icon.svg",
  "index.html",
  "js/api.js",
  "js/app.js",
  "js/data.js",
  "js/dom.js",
  "js/icons.js",
  "js/store.js",
  "js/ui.js",
  "js/util.js",
  "js/views/admin.js",
  "js/views/common.js",
  "js/views/courses.js",
  "js/views/diary.js",
  "js/views/habits.js",
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
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    // cache: 'no-cache'：每次都跟 GitHub 確認有沒有新版（不然瀏覽器可能拿 10 分鐘內的舊檔）
    fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
