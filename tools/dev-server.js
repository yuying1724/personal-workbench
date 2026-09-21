'use strict';
/**
 * 本機開發伺服器：提供 docs/ 靜態檔案，並在 POST /api 執行「真正打包後的 dist/Api.gs」（搭配記憶體版 Google 服務）。
 * 不必部署到 Google 就能在瀏覽器完整試用、跑端到端測試。資料只存在記憶體，關掉就消失。
 *   node tools/dev-server.js [--port 8788] [--demo]
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadBackend } = require('../tests/helpers/backend.js');

const DOCS = path.join(__dirname, '../docs');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function day(n) {
  const d = new Date(); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function seedDemo(b) {
  const ok = (r) => { if (!r.ok) throw new Error(JSON.stringify(r)); return r.data; };
  const pj = ok(b.call('create_project', { '專案名稱': '搬家計畫', '開始日': day(-10), '結束日': day(20), '狀態': '進行中', '優先級': '高' })).id;
  ok(b.call('create_project', { '專案名稱': 'SD 規格書整理', '開始日': day(-3), '結束日': day(40), '狀態': '規劃中', '優先級': '中' }));
  ok(b.call('create_task', { '任務名稱': '繳房租', '到期日': day(0), '星標': true, '狀態': '待辦', '重複規則': JSON.stringify({ freq: 'month', interval: 1 }), '分類': ['生活'] }));
  ok(b.call('create_task', { '任務名稱': '回覆保單系統需求信', '到期日': day(-1), '狀態': '待辦', '分類': ['工作'], '子任務': [{ '內容': '確認欄位', '完成': true }, { '內容': '寄給 PG', '完成': false }] }));
  ok(b.call('create_task', { '任務名稱': '打包書櫃', '到期日': day(2), '狀態': '待辦', '所屬專案': pj, '分類': ['生活'] }));
  ok(b.call('create_task', { '任務名稱': '叫搬家公司估價', '到期日': day(-3), '狀態': '已完成', '所屬專案': pj }));
  ok(b.call('create_task', { '任務名稱': '讀英文單字', '狀態': '待辦', '分類': ['學習'], '重複規則': '每天自己記得' }));
  const h1 = ok(b.call('create_habit', { '習慣名稱': '喝水', '類型': '計數', '目標值': 8, '單位': '杯', '啟用分級': true, '基礎值': 4, '超標值': 10, '頻率類型': 'daily', '時段': '不限', '分類': '健康' })).id;
  const h2 = ok(b.call('create_habit', { '習慣名稱': '晨間伸展', '類型': '打勾', '頻率類型': 'daily', '時段': '早上', '分類': '健康' })).id;
  ok(b.call('create_habit', { '習慣名稱': '英文聽力', '類型': '打勾', '頻率類型': 'weeklyCount', '每週次數': 3, '時段': '晚上', '分類': '學習' }));
  for (let i = 1; i <= 5; i++) { ok(b.call('set_habit_log', { '習慣ID': h2, '日期': day(-i), '數值': 1 })); ok(b.call('set_habit_log', { '習慣ID': h1, '日期': day(-i), '數值': 6 + i })); }
  ok(b.call('set_habit_log', { '習慣ID': h1, '數值': 3 }));
  ok(b.call('create_diary', { '日期': day(-1), '心情': '🙂', '感恩': '同事幫忙 review 規格', '小故事': '第一次自己主持需求訪談', '發現清單': [{ '類型': '書', '內容': '原子習慣', '狀態': '已整理' }] }));
  ok(b.call('create_diary', { '日期': day(-2), '心情': '😐', '放手': '會議超時就算了' }));
  ok(b.call('create_subscription', { '產品': 'Netflix', '訂閱費': 390, '訂閱週期': '每月', '訂閱開始日': day(-200), '重要性': '可有可無', '分類標籤': ['影音'] }));
  ok(b.call('create_subscription', { '產品': 'Claude Pro', '訂閱費': 20, '訂閱週期': '每月', '訂閱開始日': day(-60), '重要性': '必要', '分類標籤': ['工作', '學習'] }));
  ok(b.call('create_course', { '課程名稱': 'Spring Boot 實戰', '平台': 'Udemy', '講師': 'Tom', '進度': 45, '狀態': '進行中', '分類': ['程式'] }));
  ok(b.call('create_course', { '課程名稱': '系統分析與設計', '平台': 'Hahow', '進度': 100, '狀態': '已完成', '分類': ['程式'] }));
  // 訂閱的計算欄位在真實試算表是公式（自訂函數），這裡直接放幾個結果值方便看畫面
  const sh = b.ss.sheet('訂閱服務');
  [[2, 390, day(9), true, 200, 2600], [3, 640, day(20), false, 60, 1280]].forEach(([r, m, next, soon, days, total]) => {
    sh.formulaResults[`${r},11`] = m; sh.formulaResults[`${r},13`] = next; sh.formulaResults[`${r},14`] = soon; sh.formulaResults[`${r},15`] = days; sh.formulaResults[`${r},16`] = total;
  });
}

function startDevServer({ port = 0, demo = false, pin = '246810' } = {}) {
  const b = loadBackend();
  b.state.clock.now = Date.now();
  b.ctx.WbClock.now = () => Date.now();
  b.setup({ pin, deviceName: '開發用瀏覽器' });
  if (demo) seedDemo(b);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        const out = b.ctx.doPost({ postData: { contents: body } });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(out.getContent());
      });
      return;
    }
    if (url.pathname === '/config.js') { res.writeHead(200, { 'Content-Type': MIME['.js'] }); res.end("window.WB_CONFIG = { apiUrl: '/api' };"); return; }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(DOCS, rel);
    if (!file.startsWith(DOCS) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    resolve({ server, backend: b, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, token: b.token, pin: b.pin, close: () => new Promise((r) => server.close(r)) });
  }));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 8788;
  startDevServer({ port, demo: args.includes('--demo') }).then((s) => {
    console.log(`開發伺服器：${s.url}\n裝置授權碼：${s.token}\nPIN：${s.pin}\n（資料只存在記憶體，關掉就消失）`);
  });
}
module.exports = { startDevServer };
