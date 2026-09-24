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

  // 數一次 bootstrap 讀了幾次分頁：每張分頁最多一次（原本 14 張表會讀 40 幾次）
  const reads = {};
  for (const sh of b.ss.sheets) {
    const orig = sh.getDataRange.bind(sh);
    sh.getDataRange = () => { reads[sh.getName()] = (reads[sh.getName()] || 0) + 1; return orig(); };
  }
  b.call('bootstrap');
  for (const [name, n] of Object.entries(reads)) assert.equal(n, 1, `分頁「${name}」在一次 bootstrap 裡被讀了 ${n} 次`);
  assert.ok(Object.keys(reads).length >= 10, '應該有讀到主要分頁');
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

test('過渡期：舊版 API_TOKEN 入口在屬性存在時可用，刪掉後失效；新版入口不受影響', () => {
  const b = loadBackend();
  b.setup();
  b.state.props.API_TOKEN = 'old-secret';
  const oldGet = b.get({ action: 'task_stats', token: 'old-secret' });
  assert.equal(oldGet.total, 0);
  const oldPost = JSON.parse(b.ctx.doPost({ postData: { contents: JSON.stringify({ token: 'old-secret', action: 'create_task', payload: { '任務名稱': '舊版新增' } }) } }).getContent());
  assert.equal(oldPost.success, true);
  delete b.state.props.API_TOKEN;
  assert.match(b.get({ action: 'tasks', token: 'old-secret' }).error, /unauthorized/);
  assert.equal(b.get({}).ok, true, '不帶 token 的 GET 是健康檢查');
  assert.equal(b.call('tasks').data.length, 1);
});

test('不支援的 action、壞掉的 body 都回傳錯誤而不是丟例外', () => {
  const b = loadBackend();
  b.setup();
  assert.equal(b.call('drop_everything').error.code, 'BAD_ACTION');
  assert.equal(JSON.parse(b.ctx.doPost({ postData: { contents: '{bad json' } }).getContent()).error.code, 'BAD_REQUEST');
  assert.equal(b.post([1, 2]).error.code, 'BAD_REQUEST');
});
