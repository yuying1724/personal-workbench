'use strict';
/** 載入「打包後的」dist/Api.gs（真正要貼進 Apps Script 的那份）到隔離環境，搭配 Google 服務模擬與一份仿真的試算表 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createMocks } = require('./gas-mocks.js');

const CODE = path.join(__dirname, '../../dist/Api.gs');
// Apps Script 專案裡的另一個檔案（訂閱計算的自訂函數，addMonthsSafe_ 等也在這裡），線上兩個檔案共用同一個全域範圍
const CALC = path.join(__dirname, '../../backup/計算函數.gs');

// 與線上「個人工作台」試算表相同的分頁與表頭（欄位順序很重要：legacy.js 用 appendRow 依序寫入）
const SHEETS = {
  '課程': ['課程ID', '課程名稱', '平台', '講師', '進度', '狀態', '優先順序', '課程連結', '開始日期', '目標完成日', '費用', '心得筆記', '建立時間', '更新時間'],
  '課程分類對照': ['課程ID', '分類'],
  '訂閱服務': ['訂閱ID', '產品', '訂閱費', '訂閱週期', '訂閱開始日', '取消訂閱', '取消訂閱日', '重要性', '備註', '付款URL', '每月金額', '上次付款日', '下次付款日', '即將付款', '累積訂閱日', '總計花費', '訂閱費負擔提示'],
  '訂閱標籤對照': ['訂閱ID', '分類標籤'],
  '任務': ['任務ID', '任務名稱', '優先順序', '狀態', '到期日', '星標', '重複規則', '備註', '建立時間', '更新時間', '所屬專案'],
  '任務分類對照': ['任務ID', '分類'],
  '子任務': ['任務ID', '內容', '完成'],
  '專案': ['專案ID', '專案名稱', '開始日', '結束日', '狀態', '優先級', '備註', '建立時間', '更新時間'],
  '習慣': ['習慣ID', '習慣名稱', '類型', '目標值', '單位', '分類', '頻率類型', '星期幾', '每週次數', '啟用分級', '基礎值', '超標值', '狀態', '建立時間', '更新時間', '時段'],
  '習慣打卡紀錄': ['紀錄ID', '習慣ID', '日期', '數值', '建立時間'],
  '日記': ['日記ID', '日期', '心情', '感恩', '放手', '今日重要事項', '小故事', '建立時間', '更新時間'],
  '日記發現清單': ['日記ID', '類型', '內容', '備註', '狀態'],
  '系統索引': ['系統名稱', 'icon', '主表分頁名稱'],
};
const OPTIONS = {
  '平台': ['Hahow', 'Udemy', 'YouTube'], '分類': ['程式', '英文', '理財'], '狀態': ['未開始', '進行中', '已完成'], '優先順序': ['高', '中', '低'],
  '訂閱週期': ['每月', '每年'], '重要性': ['必要', '可有可無'], '分類標籤': ['影音', '工作', '學習'],
  '任務分類': ['工作', '生活', '學習'], '任務優先順序': ['高', '中', '低'], '任務狀態': ['待辦', '進行中', '已完成', '已取消'], '重複頻率': [],
  '專案狀態': ['規劃中', '進行中', '已完成'], '專案優先級': ['高', '中', '低'], '習慣分類': ['健康', '學習', '生活'],
};
const SYSTEMS = [['課程', '📚', '課程'], ['訂閱', '💳', '訂閱服務'], ['任務', '✅', '任務'], ['專案', '📁', '專案'], ['習慣', '🔥', '習慣'], ['日記', '📔', '日記']];

function seedSheets(ss) {
  ss.sheets = [];
  for (const [name, headers] of Object.entries(SHEETS)) {
    const sh = ss.insertSheet(name, ss.sheets.length);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  const opt = ss.insertSheet('設定', ss.sheets.length);
  const keys = Object.keys(OPTIONS);
  opt.getRange(1, 1, 1, keys.length).setValues([keys]);
  keys.forEach((k, j) => OPTIONS[k].forEach((v, i) => opt.getRange(i + 2, j + 1).setValue(v)));
  const sys = ss.sheet('系統索引');
  SYSTEMS.forEach((row, i) => sys.getRange(i + 2, 1, 1, 3).setValues([row]));
}

function loadBackend() {
  const mock = createMocks();
  const ctx = vm.createContext(Object.assign({ console }, mock.globals));
  vm.runInContext(fs.readFileSync(CALC, 'utf8'), ctx, { filename: '計算函數.gs' });
  vm.runInContext(fs.readFileSync(CODE, 'utf8'), ctx, { filename: 'Api.gs' });
  ctx.WbClock.now = () => mock.state.clock.now;
  const ss = mock.state.spreadsheets.SS_MAIN;
  seedSheets(ss);

  function post(body) { return JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent()); }
  function get(params) { return JSON.parse(ctx.doGet({ parameter: params }).getContent()); }

  const backend = { ctx, mock, state: mock.state, ss, post, get, session: null, token: null };
  backend.setup = function setup(opts = {}) {
    const pin = opts.pin || '246810';
    ctx.WbAuth.ensureKey();
    ctx.WbAuth.setPin(pin);
    const dev = ctx.WbAuth.addDevice(opts.deviceName || '測試手機');
    backend.token = dev.token; backend.pin = pin; backend.deviceId = dev.id;
    backend.login();
    return backend;
  };
  backend.login = function login(token = backend.token, pin = backend.pin) {
    const r = post({ action: 'login', params: { token, pin } });
    if (r.ok) backend.session = r.data.session;
    return r;
  };
  backend.call = function call(action, params = {}) {
    const r = post({ action, params, session: backend.session });
    if (r.session) backend.session = r.session;
    return r;
  };
  backend.advance = (ms) => { mock.state.clock.now += ms; };
  return backend;
}

module.exports = { loadBackend, SHEETS, OPTIONS };
