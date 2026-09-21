'use strict';
/**
 * 把 server/ 的檔案合併成單一 dist/Api.gs，整份貼進 Apps Script 的「Api.gs」即可。
 * （「個人工作台-計算函數.gs」是試算表公式用的自訂函數，跟這裡無關，不用動它。）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ORDER = ['server/api.js', 'server/auth.js', 'server/legacy.js', 'server/main.js'];

function build() {
  const parts = ['/**\n * 個人工作台 — Apps Script 後端（自動產生，請勿直接在 Apps Script 編輯器修改）\n * 由 tools/build-gas.js 從 server/ 合併而成；要改程式請改 server/ 再重新 build。\n */\n'];
  for (const rel of ORDER) {
    parts.push(`\n// ==================== ${rel} ====================\n`);
    parts.push(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  }
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  const out = parts.join('');
  fs.writeFileSync(path.join(ROOT, 'dist/Api.gs'), out);
  return out;
}

if (require.main === module) {
  const out = build();
  console.log(`dist/Api.gs 已產生（${out.length} 字元）`);
}
module.exports = { build, ORDER };
