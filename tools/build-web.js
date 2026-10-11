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

function build() {
  buildShared();
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
`;
  fs.writeFileSync(path.join(DOCS, 'sw.js'), src);
  return { version, files: shell };
}

if (require.main === module) { const r = build(); console.log(`docs/sw.js 已產生（${r.version}，${r.files.length} 個檔案）`); }
module.exports = { build };
