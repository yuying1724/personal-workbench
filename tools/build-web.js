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

function build() {
  const files = walk(DOCS).map((p) => path.relative(DOCS, p).split(path.sep).join('/'))
    .filter((f) => f !== 'sw.js' && !f.endsWith('.png') || f === 'icons/icon-192.png').sort();
  const hash = crypto.createHash('sha256');
  files.forEach((f) => hash.update(f).update(fs.readFileSync(path.join(DOCS, f))));
  const version = 'wb-' + hash.digest('hex').slice(0, 10);
  const shell = ['./'].concat(files);
  const src = `/* Service Worker（由 tools/build-web.js 自動產生，請勿直接編輯）
 * 讓網站可以安裝成 App，離線時至少能開啟外殼。
 * 策略：同網域的檔案「網路優先、失敗才用快取」，更新程式後不會被舊快取卡住；呼叫後端 API（跨網域 POST）完全不經過快取。 */
const VERSION = '${version}';
const SHELL = ${JSON.stringify(shell, null, 2)};

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
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
`;
  fs.writeFileSync(path.join(DOCS, 'sw.js'), src);
  return { version, files: shell };
}

if (require.main === module) { const r = build(); console.log(`docs/sw.js 已產生（${r.version}，${r.files.length} 個檔案）`); }
module.exports = { build };
