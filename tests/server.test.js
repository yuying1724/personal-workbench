'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../tools/build-gas.js');
build();
const { loadBackend } = require('./helpers/backend.js');

test('沒登入不能讀資料；授權碼或 PIN 錯誤會被擋；正確登入後可以 bootstrap', () => {
  const b = loadBackend();
  b.setup();
  const anon = b.post({ action: 'bootstrap', params: {} });
  assert.equal(anon.ok, false);
  assert.equal(anon.error.code, 'AUTH_REQUIRED');

  assert.equal(b.post({ action: 'login', params: { token: 'AAAAA-BBBBB-CCCCC-DDDDD', pin: b.pin } }).error.code, 'AUTH_FAILED');
  const wrongPin = b.post({ action: 'login', params: { token: b.token, pin: '111111' } });
  assert.equal(wrongPin.error.code, 'AUTH_FAILED');
  assert.match(wrongPin.error.message, /還可以再試/);

  const r = b.call('bootstrap');
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const k of ['courses', 'subscriptions', 'tasks', 'projects', 'habits', 'diaries', 'options', 'systemIndex', 'meta']) assert.ok(k in r.data, k);
  // optionUsage 只有分類管理頁要用，登入的 bootstrap 不再帶（省一半時間），改由 admin_bundle 提供
  assert.ok(!('optionUsage' in r.data), 'bootstrap 不應該帶 optionUsage');
  assert.equal(r.data.meta.device, '測試手機');
  assert.deepEqual(r.data.options['任務分類'], ['工作', '生活', '學習']);
  const admin = b.call('admin_bundle');
  assert.equal(admin.ok, true, JSON.stringify(admin));
  for (const k of ['options', 'optionUsage', 'systemIndex']) assert.ok(k in admin.data, k);
  assert.equal(typeof admin.data.optionUsage['任務分類'], 'object');
});

test('整包讀取的分頁快取只在唯讀請求內生效：寫入後再讀能拿到新資料，而且每張分頁只讀一次', () => {
  const b = loadBackend();
  b.setup();
  const before = b.call('bootstrap');
  const n0 = before.data.tasks.length;
  const created = b.call('create_task', { '任務名稱': '快取測試任務', '狀態': '待辦', '優先順序': '中', '分類': ['工作'], '子任務': [] });
  assert.equal(created.ok, true, JSON.stringify(created));
  const after = b.call('bootstrap');
  assert.equal(after.data.tasks.length, n0 + 1, '寫入後 bootstrap 要看到新任務');
  assert.equal(after.data.taskStats.total, n0 + 1, 'stats 要跟資料同一份');
  // 同一份資料被引用兩次（tasks 與 projects 內部用的 tasks），JSON 序列化後仍是正常物件
  const bundle = b.call('project_task_bundle');
  assert.equal(bundle.ok, true);
  assert.equal(bundle.data.tasks.length, n0 + 1);

  // 有 Sheets 進階服務時：一次 bootstrap 只打一次 Sheets API、完全不經過 SpreadsheetApp 逐張讀
  const reads = {};
  for (const sh of b.ss.sheets) {
    const orig = sh.getDataRange.bind(sh);
    sh.getDataRange = () => { reads[sh.getName()] = (reads[sh.getName()] || 0) + 1; return orig(); };
  }
  const calls0 = b.state.sheetsApiCalls;
  const viaApi = b.call('bootstrap');
  assert.equal(b.state.sheetsApiCalls - calls0, 1, '一次 bootstrap 應該只呼叫一次 Sheets API');
  assert.deepEqual(reads, {}, '有預載時不該再逐張 getDataRange');

  // 沒有 Sheets 進階服務（沒在專案加入服務）時退回逐張讀：每張分頁最多一次（原本 14 張表會讀 40 幾次），結果要一模一樣
  b.ctx.Sheets = undefined;
  const viaSheets = b.call('bootstrap');
  for (const [name, n] of Object.entries(reads)) assert.equal(n, 1, `分頁「${name}」在一次 bootstrap 裡被讀了 ${n} 次`);
  assert.ok(Object.keys(reads).length >= 10, '應該有讀到主要分頁');
  delete viaApi.data.meta; delete viaSheets.data.meta;
  assert.deepEqual(viaApi.data, viaSheets.data, 'Sheets API 預載與逐張讀取的結果必須完全相同（日期、數字、布林型別）');
});

test('PIN 連錯 5 次會鎖定；撤銷裝置後工作階段立即失效', () => {
  const b = loadBackend();
  b.setup();
  for (let i = 0; i < 4; i++) b.post({ action: 'login', params: { token: b.token, pin: '000000' } });
  const locked = b.post({ action: 'login', params: { token: b.token, pin: '000000' } });
  assert.equal(locked.error.code, 'LOCKED');
  assert.equal(b.post({ action: 'login', params: { token: b.token, pin: b.pin } }).error.code, 'LOCKED');

  const b2 = loadBackend();
  b2.setup();
  assert.equal(b2.call('tasks').ok, true);
  b2.ctx.WbAuth.revokeDevice(b2.deviceId);
  assert.equal(b2.call('tasks').error.code, 'AUTH_REQUIRED');
});

test('工作階段過期要重新登入；快過期時自動換發', () => {
  const b = loadBackend();
  b.setup();
  const first = b.session;
  b.advance(35 * 60000);
  const r = b.call('tasks');
  assert.equal(r.ok, true);
  assert.notEqual(b.session, first, '剩不到一半效期應該換發新的');
  b.advance(61 * 60000);
  assert.equal(b.call('tasks').error.code, 'AUTH_REQUIRED');
});

test('任務：新增、完成重複任務會自動產生下一筆、跳過本次、刪除', () => {
  const b = loadBackend();
  b.setup();
  const add = b.call('create_task', { '任務名稱': '繳房租', '狀態': '待辦', '到期日': '2026-09-30', '星標': true, '重複規則': JSON.stringify({ freq: 'month', interval: 1 }), '分類': ['生活'], '子任務': [{ '內容': '轉帳', '完成': false }] });
  assert.equal(add.ok, true, JSON.stringify(add));
  const id = add.data.id;
  let tasks = b.call('tasks').data;
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0]['分類'], ['生活']);
  assert.equal(tasks[0]['子任務'][0]['內容'], '轉帳');
  assert.equal(tasks[0]['到期日'], '2026-09-30');

  const t = tasks[0];
  const done = b.call('update_task', Object.assign({}, t, { '狀態': '已完成' }));
  assert.equal(done.data.nextTaskCreated, true);
  tasks = b.call('tasks').data;
  assert.equal(tasks.length, 2);
  const next = tasks.find((x) => x['任務ID'] !== id);
  assert.equal(next['到期日'], '2026-10-30');
  assert.equal(next['狀態'], '待辦');
  assert.equal(next['子任務'][0]['完成'], false);

  const skip = b.call('skip_task', { '任務ID': next['任務ID'] });
  assert.equal(skip.ok, true);
  tasks = b.call('tasks').data;
  assert.equal(tasks.find((x) => x['任務ID'] === next['任務ID'])['狀態'], '已跳過');
  assert.equal(tasks.length, 3);

  assert.equal(b.call('delete_task', { '任務ID': id }).ok, true);
  assert.equal(b.call('tasks').data.length, 2);
  const bad = b.call('update_task', { '任務ID': 'T9999', '任務名稱': 'x' });
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /找不到任務/);
});

test('專案：刪除專案會清掉任務的所屬專案，project_task_bundle 兩邊都回傳', () => {
  const b = loadBackend();
  b.setup();
  const pj = b.call('create_project', { '專案名稱': '搬家', '狀態': '進行中' }).data.id;
  b.call('create_task', { '任務名稱': '打包', '所屬專案': pj, '狀態': '已完成' });
  b.call('create_task', { '任務名稱': '叫車', '所屬專案': pj });
  const p = b.call('projects').data[0];
  assert.equal(p['任務數'], 2);
  assert.equal(p['完成度Percent'], 50);
  b.call('delete_project', { '專案ID': pj });
  const bundle = b.call('project_task_bundle').data;
  assert.equal(bundle.projects.length, 0);
  assert.ok(bundle.tasks.every((t) => t['所屬專案'] === ''));
});

test('習慣：打卡、計數型三級制、取消打卡；日記一天一篇（upsert）', () => {
  const b = loadBackend();
  b.setup();
  const hid = b.call('create_habit', { '習慣名稱': '喝水', '類型': '計數', '目標值': 8, '單位': '杯', '啟用分級': true, '基礎值': 4, '超標值': 10, '頻率類型': 'daily', '時段': '早上' }).data.id;
  b.call('set_habit_log', { '習慣ID': hid, '數值': 5 });
  let h = b.call('habits').data[0];
  assert.equal(h['今日數值'], 5);
  assert.equal(h['今日已完成'], true);
  assert.equal(h['今日等級'], '基礎');
  b.call('set_habit_log', { '習慣ID': hid, '數值': 11 });
  h = b.call('habits').data[0];
  assert.equal(h['今日等級'], '超標');
  assert.equal(b.ss.sheet('習慣打卡紀錄').getLastRow(), 2, '同一天只有一列');
  b.call('set_habit_log', { '習慣ID': hid, '數值': null });
  assert.equal(b.call('habits').data[0]['今日已完成'], false);

  const d1 = b.call('create_diary', { '日期': '2026-09-20', '心情': '🙂', '感恩': '天氣好', '發現清單': [{ '類型': '書', '內容': '原子習慣', '狀態': '' }] });
  const d2 = b.call('create_diary', { '日期': '2026-09-20', '心情': '😄', '感恩': '改一下' });
  assert.equal(d1.data.id, d2.data.id);
  const diaries = b.call('diaries').data;
  assert.equal(diaries.length, 1);
  assert.equal(diaries[0]['心情'], '😄');
  assert.equal(diaries[0]['發現清單'].length, 0, '第二次儲存沒帶發現清單 → 清空');
});

test('分類管理：新增、改名會連動資料、刪除選項；系統名稱可改', () => {
  const b = loadBackend();
  b.setup();
  b.call('create_task', { '任務名稱': 'A', '分類': ['工作'] });
  assert.equal(b.call('add_option', { field: '任務分類', value: '家庭' }).ok, true);
  assert.equal(b.call('add_option', { field: '任務分類', value: '家庭' }).ok, false);
  assert.equal(b.call('rename_option', { field: '任務分類', oldValue: '工作', newValue: '公司' }).ok, true);
  const admin = b.call('admin_bundle').data;
  assert.ok(admin.options['任務分類'].includes('公司'));
  assert.equal(admin.optionUsage['任務分類']['公司'], 1);
  assert.deepEqual(b.call('tasks').data[0]['分類'], ['公司']);
  assert.equal(b.call('delete_option', { field: '任務分類', value: '家庭' }).ok, true);
  assert.equal(b.call('update_system', { '主表分頁名稱': '任務', '系統名稱': '待辦事項', 'icon': '✅' }).ok, true);
  assert.equal(b.call('admin_bundle').data.systemIndex.find((s) => s['主表分頁名稱'] === '任務')['系統名稱'], '待辦事項');
});

test('課程與訂閱：新增／編輯／刪除', () => {
  const b = loadBackend();
  b.setup();
  const c = b.call('create_course', { '課程名稱': 'JS 入門', '平台': 'Hahow', '進度': 40, '分類': ['程式'] });
  assert.equal(c.ok, true);
  let course = b.call('courses').data[0];
  assert.equal(course['進度'], 0.4);
  b.call('update_course', Object.assign({}, course, { '進度': 100, '狀態': '已完成' }));
  course = b.call('courses').data[0];
  assert.equal(course['進度'], 1);
  assert.equal(b.call('course_stats').data.completed, 1);

  const s = b.call('create_subscription', { '產品': 'Netflix', '訂閱費': 390, '訂閱週期': '每月', '分類標籤': ['影音'] });
  assert.equal(s.ok, true);
  const sheet = b.ss.sheet('訂閱服務');
  assert.equal(sheet.getRange(2, 11).getFormulas()[0][0], '=MONTHLY_AMOUNT(C2,D2)');
  assert.equal(b.call('delete_subscription', { '訂閱ID': s.data.id }).ok, true);
  assert.equal(b.call('subscriptions').data.length, 0);
});

test('變更 PIN：舊 PIN 錯誤會拒絕；成功後要用新 PIN 登入', () => {
  const b = loadBackend();
  b.setup();
  assert.equal(b.call('changePin', { oldPin: '999999', newPin: '135790' }).ok, false);
  assert.equal(b.call('changePin', { oldPin: b.pin, newPin: '12' }).ok, false);
  assert.equal(b.call('changePin', { oldPin: b.pin, newPin: '135790' }).ok, true);
  assert.equal(b.post({ action: 'login', params: { token: b.token, pin: b.pin } }).ok, false);
  assert.equal(b.post({ action: 'login', params: { token: b.token, pin: '135790' } }).ok, true);
});

test('舊版 API_TOKEN 入口已移除：就算屬性還在，帶 token 的請求也拿不到資料、不能寫入', () => {
  const b = loadBackend();
  b.setup();
  b.state.props.API_TOKEN = 'old-secret';
  const oldGet = b.get({ action: 'tasks', token: 'old-secret' });
  assert.equal(oldGet.ok, true);
  assert.ok(!('data' in oldGet && Array.isArray(oldGet.data)), '只回健康檢查，不回資料');
  const oldPost = JSON.parse(b.ctx.doPost({ postData: { contents: JSON.stringify({ token: 'old-secret', action: 'create_task', payload: { '任務名稱': '舊版新增' } }) } }).getContent());
  assert.equal(oldPost.ok, false);
  assert.equal(b.call('tasks').data.length, 0);
});

test('不支援的 action、壞掉的 body 都回傳錯誤而不是丟例外', () => {
  const b = loadBackend();
  b.setup();
  assert.equal(b.call('drop_everything').error.code, 'BAD_ACTION');
  assert.equal(JSON.parse(b.ctx.doPost({ postData: { contents: '{bad json' } }).getContent()).error.code, 'BAD_REQUEST');
  assert.equal(b.post([1, 2]).error.code, 'BAD_REQUEST');
});

test('備份：複製到「個人工作台備份」資料夾、只保留最近 8 份；每週自動備份可開關', () => {
  const b = loadBackend();
  b.setup();
  const drive = b.state.drive;
  const active = () => drive.files.filter((f) => !f.trashed);

  for (let i = 0; i < 10; i++) b.ctx.wbBackupNow_();
  assert.equal(drive.folders.length, 1, '資料夾只建一次');
  assert.equal(drive.folders[0].getName(), '個人工作台備份');
  assert.equal(active().length, 8, '只保留 8 份');
  assert.equal(drive.files.length - active().length, 2, '多的 2 份丟垃圾桶');
  assert.ok(active().every((f) => f.folder === drive.folders[0] && / 備份 \d{4}-\d{2}-\d{2} \d{4}$/.test(f.getName())));
  // 丟掉的是最舊的
  const newest = drive.files.slice().sort((a, c) => c.created - a.created).slice(0, 8);
  assert.deepEqual(active().map((f) => f.id).sort(), newest.map((f) => f.id).sort());
  assert.match(b.state.props.BACKUP_LAST, /備份/);

  // 選單：開啟 → 建觸發器（每週日 3 點）並立刻備份一次；再按一次確認 → 關閉
  const before = drive.files.length;
  b.ctx.menuToggleWeeklyBackup();
  const trig = b.state.triggers.filter((t) => t.getHandlerFunction() === 'wbWeeklyBackup');
  assert.equal(trig.length, 1);
  assert.deepEqual([trig[0].spec.weekDay, trig[0].spec.hour], ['SUNDAY', 3]);
  assert.equal(drive.files.length, before + 1);
  assert.equal(typeof b.ctx.wbWeeklyBackup, 'function', '觸發器要呼叫得到全域函式');

  b.state.ui.queue('CANCEL');
  b.ctx.menuToggleWeeklyBackup();
  assert.equal(b.state.triggers.length, 1, '按取消不關閉');
  b.ctx.menuToggleWeeklyBackup();
  assert.equal(b.state.triggers.length, 0, '確認後關閉');

  // 選單項目有加上
  b.ctx.onOpen();
  const items = b.state.ui.menus.at(-1).items.map((x) => x[1]);
  assert.ok(items.includes('menuBackupNow') && items.includes('menuToggleWeeklyBackup'));
});

test('習慣熱力圖：habits 帶近一年的「打卡紀錄」，可以補記過去的日子，太舊的不帶', () => {
  const b = loadBackend();
  b.setup();
  const hid = b.call('create_habit', { '習慣名稱': '閱讀', '類型': '打勾', '頻率類型': 'daily' }).data.id;
  const tw = (offset) => { const d = new Date(Date.now() + 8 * 3600000); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
  b.call('set_habit_log', { '習慣ID': hid, '數值': 1 }); // 今天
  b.call('set_habit_log', { '習慣ID': hid, '日期': tw(-1), '數值': 1 }); // 補打卡：昨天
  b.call('set_habit_log', { '習慣ID': hid, '日期': tw(-3), '數值': 1 });
  b.call('set_habit_log', { '習慣ID': hid, '日期': tw(-400), '數值': 1 }); // 超過一年，不帶
  let h = b.call('habits').data[0];
  assert.deepEqual(Object.keys(h['打卡紀錄']).sort(), [tw(-3), tw(-1), tw(0)]);
  assert.equal(h['連續天數'], 2, '補記昨天後連續 2 天（前天沒做）');
  b.call('set_habit_log', { '習慣ID': hid, '日期': tw(-2), '數值': 1 }); // 補前天 → 連起來
  h = b.call('habits').data[0];
  assert.equal(h['連續天數'], 4);
  b.call('set_habit_log', { '習慣ID': hid, '日期': tw(-1), '數值': null }); // 取消昨天
  h = b.call('habits').data[0];
  assert.ok(!(tw(-1) in h['打卡紀錄']));
  // bootstrap 也帶（前端快取秒開要用）
  assert.ok('打卡紀錄' in b.call('bootstrap').data.habits[0]);
});

test('訂閱：下次付款日等欄位每次讀取都用「今天」重算，不靠試算表公式的快取值', () => {
  const b = loadBackend();
  b.setup();
  const tw = (offset) => { const d = new Date(Date.now() + 8 * 3600000); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
  // 開始日 = 40 天前、每月 → 上次付款 ≈ 9～10 天前，下次付款 ≈ 20～21 天後（不在 14 天內）
  b.call('create_subscription', { '產品': 'A', '訂閱費': 300, '訂閱週期': '每月', '訂閱開始日': tw(-40) });
  // 開始日 = 25 天前、每月 → 下次付款約 5～6 天後（14 天內）
  b.call('create_subscription', { '產品': 'B', '訂閱費': 1200, '訂閱週期': '每年', '訂閱開始日': tw(-360) });
  b.call('create_subscription', { '產品': 'C', '訂閱費': 600, '訂閱週期': '每月', '訂閱開始日': tw(-100), '取消訂閱': true, '取消訂閱日': tw(-10) });
  // 試算表裡的公式快取值是舊的（模擬 Google 沒重算）
  const sh = b.ss.sheet('訂閱服務');
  [2, 3, 4].forEach((r) => { sh.formulaResults[`${r},13`] = '2020-01-01'; sh.formulaResults[`${r},14`] = true; sh.formulaResults[`${r},11`] = 999; });
  const subs = b.call('subscriptions').data;
  const by = (n) => subs.find((x) => x['產品'] === n);
  const a = by('A');
  assert.equal(a['每月金額'], 300);
  assert.ok(a['下次付款日'] > tw(14) && a['下次付款日'] <= tw(22), a['下次付款日']);
  assert.ok(a['上次付款日'] <= tw(0) && a['上次付款日'] >= tw(-11), a['上次付款日']);
  assert.equal(a['即將付款'], false);
  assert.equal(a['總計花費'], 600, '開始日＋一個月後各付一次');
  assert.ok(a['累積訂閱日'] >= 39 && a['累積訂閱日'] <= 41);
  const bb = by('B');
  assert.equal(bb['每月金額'], 100);
  assert.equal(bb['即將付款'], true, '年繳 360 天前開始 → 5 天內要付');
  assert.equal(by('C')['下次付款日'], '', '已取消沒有下次付款');
  assert.equal(by('C')['即將付款'], false);
  const st = b.call('subscription_stats').data;
  assert.equal(st.totalMonthlySpend, 400);
  assert.deepEqual(st.upcomingPayments.map((x) => x['產品']), ['B']);
});

test('任務：set_task_status 只改狀態（不蓋掉其他欄位）；重複任務 打勾→取消→再打勾 只產生一筆下一次', () => {
  const b = loadBackend();
  b.setup();
  const id = b.call('create_task', { '任務名稱': '繳費', '狀態': '待辦', '到期日': '2026-03-10', '重複規則': JSON.stringify({ freq: 'month', interval: 1 }), '備註': '原本', '分類': ['生活'], '子任務': [{ '內容': 'a', '完成': true }] }).data.id;
  // 另一台裝置改了備註
  const t0 = b.call('tasks').data.find((x) => x['任務ID'] === id);
  b.call('update_task', Object.assign({}, t0, { '備註': '別台改的' }));
  // 這台用舊資料打勾 → 只送狀態
  let r = b.call('set_task_status', { '任務ID': id, '狀態': '已完成' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.nextTaskCreated, true);
  let tasks = b.call('tasks').data;
  const t1 = tasks.find((x) => x['任務ID'] === id);
  assert.equal(t1['狀態'], '已完成');
  assert.equal(t1['備註'], '別台改的', '備註不能被蓋掉');
  const next = tasks.filter((x) => x['任務名稱'] === '繳費' && x['到期日'] === '2026-04-10');
  assert.equal(next.length, 1);
  assert.deepEqual(next[0]['分類'], ['生活']);
  assert.equal(next[0]['子任務'][0]['完成'], false);
  // 取消再打勾 → 不會多一筆
  b.call('set_task_status', { '任務ID': id, '狀態': '待辦' });
  r = b.call('set_task_status', { '任務ID': id, '狀態': '已完成' });
  assert.equal(r.data.nextTaskCreated, false);
  tasks = b.call('tasks').data;
  assert.equal(tasks.filter((x) => x['到期日'] === '2026-04-10').length, 1, '下一次只能有一筆');
  assert.equal(b.call('set_task_status', { '任務ID': 'T999', '狀態': '已完成' }).ok, false);
});

test('寫入的回應直接附上該模組最新資料（reload），前端不用再打一次 bundle', () => {
  const b = loadBackend();
  b.setup();
  const r = b.call('create_task', { '任務名稱': '附資料測試', '狀態': '待辦' });
  assert.equal(r.ok, true);
  assert.equal(r.reload.name, 'project_task_bundle');
  assert.ok(r.reload.data.tasks.some((t) => t['任務名稱'] === '附資料測試'));
  assert.ok('projects' in r.reload.data);
  const hid = b.call('create_habit', { '習慣名稱': 'x', '類型': '打勾', '頻率類型': 'daily' }).data.id;
  const r2 = b.call('set_habit_log', { '習慣ID': hid, '數值': 1 });
  assert.equal(r2.reload.name, 'habit_bundle');
  assert.equal(r2.reload.data.habits[0]['今日已完成'], true);
  assert.equal(b.call('rename_option', { '欄位': '任務分類', '舊名稱': '工作', '新名稱': '公事' }).reload, undefined, '改名不附（前端整包重抓）');
  assert.equal(b.call('bootstrap').reload, undefined, '讀取不附');
});

test('文字保護：= 開頭不會變公式、007／1/2 不會被改成數字或日期（主表與子任務、分類對照都一樣）', () => {
  const b = loadBackend();
  b.setup();
  const id = b.call('create_task', { '任務名稱': '=SUM(A1)', '狀態': '待辦', '備註': '007', '分類': ['工作'], '子任務': [{ '內容': '1/2', '完成': false }, { '內容': '+886', '完成': true }] }).data.id;
  const sheet = b.ss.sheet('任務');
  assert.equal(sheet.getRange(2, 2).getFormulas()[0][0], '', '不能變成公式');
  let t = b.call('tasks').data.find((x) => x['任務ID'] === id);
  assert.equal(t['任務名稱'], '=SUM(A1)');
  assert.equal(t['備註'], '007');
  assert.deepEqual(t['子任務'].map((x) => x['內容']), ['1/2', '+886']);
  // 再存一次（子任務表整批重寫）也不會跑掉
  b.call('update_task', Object.assign({}, t, { '子任務': t['子任務'].concat([{ '內容': '2026-01-01', '完成': false }]) }));
  b.call('create_task', { '任務名稱': '另一筆', '狀態': '待辦', '子任務': [{ '內容': 'x', '完成': false }] }); // 觸發附屬表整批重寫
  t = b.call('tasks').data.find((x) => x['任務ID'] === id);
  assert.deepEqual(t['子任務'].map((x) => x['內容']), ['1/2', '+886', '2026-01-01']);
  // 數字欄、日期欄仍然是數字／日期
  const hid = b.call('create_habit', { '習慣名稱': '2026', '類型': '計數', '目標值': '8', '頻率類型': 'daily' }).data.id;
  const hb = b.call('habits').data.find((x) => x['習慣ID'] === hid);
  assert.equal(hb['習慣名稱'], '2026');
  assert.equal(Number(hb['目標值']), 8);
});

test('變更 PIN 跟登入共用失敗次數：一直猜舊 PIN 會被鎖定', () => {
  const b = loadBackend();
  b.setup();
  let last;
  for (let i = 0; i < 5; i++) last = b.call('changePin', { oldPin: '000000', newPin: '135790' });
  assert.equal(last.error.code, 'LOCKED');
  assert.equal(b.call('changePin', { oldPin: b.pin, newPin: '135790' }).error.code, 'LOCKED', '鎖定期間就算對也不行');
});

test('ID 不重複使用：刪掉最新一筆後，下一筆拿新號碼（不同分頁、不同前綴各自計數）', () => {
  const b = loadBackend();
  b.setup();
  const a = b.call('create_task', { '任務名稱': 'a', '狀態': '待辦' }).data.id;
  const c = b.call('create_task', { '任務名稱': 'c', '狀態': '待辦' }).data.id;
  b.call('delete_task', { '任務ID': c });
  const d = b.call('create_task', { '任務名稱': 'd', '狀態': '待辦' }).data.id;
  assert.notEqual(d, c, '刪掉的 ' + c + ' 不能再發一次');
  assert.ok(Number(d.slice(1)) > Number(c.slice(1)));
  assert.ok(a < c);
  const h1 = b.call('create_habit', { '習慣名稱': 'x', '類型': '打勾', '頻率類型': 'daily' }).data.id;
  assert.match(h1, /^H0*1$/);
});

test('閒置多久要重新輸入 PIN：登入時可指定（5 分鐘～30 天），登入後可用 set_session_ttl 換發', () => {
  const b = loadBackend();
  b.setup();
  const ttlOf = (sess) => Number(String(sess).split('.')[3]) / 60000;
  const r = b.post({ action: 'login', params: { token: b.token, pin: b.pin, ttlMinutes: 7 * 24 * 60 } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.ttlMinutes, 10080);
  assert.equal(ttlOf(r.data.session), 10080);
  assert.equal(b.post({ action: 'login', params: { token: b.token, pin: b.pin, ttlMinutes: 999999 } }).data.ttlMinutes, 43200, '最長 30 天');
  assert.equal(b.post({ action: 'login', params: { token: b.token, pin: b.pin } }).data.ttlMinutes, 60, '沒指定就是 1 小時');
  b.session = r.data.session;
  const s2 = b.post({ action: 'set_session_ttl', params: { ttlMinutes: 1 }, session: r.data.session });
  assert.equal(s2.ok, true, JSON.stringify(s2));
  assert.equal(s2.data.ttlMinutes, 5, '最短 5 分鐘');
  assert.equal(ttlOf(s2.session), 5);
  const s3 = b.post({ action: 'set_session_ttl', params: { ttlMinutes: 43200 }, session: s2.session });
  assert.equal(ttlOf(s3.session), 43200);
  assert.equal(b.post({ action: 'bootstrap', params: {}, session: s3.session }).ok, true, '換發的新碼可以用');
  assert.equal(b.post({ action: 'set_session_ttl', params: { ttlMinutes: 60 } }).error.code, 'AUTH_REQUIRED', '沒登入不能換發');
});
