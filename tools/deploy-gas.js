'use strict';
/**
 * 一鍵部署 Apps Script 後端（網址不變）：
 *   1. server/ → dist/Api.gs（build-gas）
 *   2. 複製成 gas/Api.js（gas/ 是 Apps Script 專案的本機鏡像，由 .clasp.json 指定）
 *   3. clasp push：上傳 gas/ 全部檔案（Api、個人工作台-計算函數、appsscript.json）
 *   4. clasp deploy -i：建立新版本並更新「同一個」網頁應用程式部署
 * 用法：node tools/deploy-gas.js "這次改了什麼"
 * 需要專案根目錄的 .clasprc.json（Google 授權，已列入 .gitignore，不會上傳）。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEPLOYMENT_ID = 'AKfycbxlJ4rIFUT0RiDrnAwq2E2ah_7ERs43Zg09-vlvv221h6268-IxvLXENNmA3mAriKpW';
const CLASP = process.env.CLASP || 'npx -y @google/clasp@3';
const desc = process.argv.slice(2).join(' ') || `deploy ${new Date().toISOString()}`;

if (!fs.existsSync(path.join(ROOT, '.clasprc.json'))) {
  console.error('找不到 .clasprc.json（Google 授權檔），請先完成 clasp 登入。');
  process.exit(1);
}
require('./build-gas').build();
fs.copyFileSync(path.join(ROOT, 'dist/Api.gs'), path.join(ROOT, 'gas/Api.js'));
const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
run(`${CLASP} -A .clasprc.json push --force`);
run(`${CLASP} -A .clasprc.json deploy -i ${DEPLOYMENT_ID} -d ${JSON.stringify(desc)}`);
console.log('後端部署完成，網址不變。');
