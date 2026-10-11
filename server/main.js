/**
 * Apps Script 進入點：網頁應用程式（doGet / doPost）與試算表選單。
 * 選單函式必須是全域函式，所以放在這裡；登入邏輯在 WbAuth，API 分派在 WbApi。
 */
var WB_MAX_BODY_BYTES = 300000;

function doGet(e) {
  return jsonOut_({ ok: true, data: { name: 'personal-workbench', version: WB_VERSION, message: '後端運作中。請用網頁版登入使用。' } });
}

function doPost(e) {
  var body = null;
  try {
    var raw = e && e.postData ? e.postData.contents : '';
    if (raw && raw.length > WB_MAX_BODY_BYTES) return jsonOut_({ ok: false, error: { code: 'BAD_REQUEST', message: '請求太大' } });
    body = JSON.parse(raw || '{}');
  } catch (err) {
    return jsonOut_({ ok: false, error: { code: 'BAD_REQUEST', message: '請求格式錯誤' } });
  }
  return jsonOut_(WbApi.handle(body));
}

// ---------- 試算表選單 ----------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('個人工作台')
    .addItem('第一次設定（PIN＋第一台裝置）', 'menuFirstTimeSetup')
    .addSeparator()
    .addItem('設定或變更 PIN', 'menuSetPin')
    .addItem('新增裝置授權碼', 'menuAddDevice')
    .addItem('查看或撤銷裝置', 'menuManageDevices')
    .addItem('登出所有裝置', 'menuSignOutAll')
    .addItem('檢查目前狀態', 'menuStatus')
    .addSeparator()
    .addItem('立即備份一次', 'menuBackupNow')
    .addItem('開啟／關閉每週自動備份', 'menuToggleWeeklyBackup')
    .addToUi();
}

function wbUi_() { return SpreadsheetApp.getUi(); }
function wbAlert_(title, msg) { var u = wbUi_(); u.alert(title, msg, u.ButtonSet.OK); }
function wbAsk_(title, msg) {
  var u = wbUi_();
  var res = u.prompt(title, msg, u.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== u.Button.OK) return null;
  return String(res.getResponseText());
}

function wbAskNewPin_() {
  for (var tries = 0; tries < 3; tries++) {
    var pin = wbAsk_('設定 PIN', '請輸入新的 PIN（至少 ' + WbAuth.MIN_PIN_LENGTH + ' 碼，建議用數字；輸入時畫面看得到，請留意旁邊有沒有人）：');
    if (pin === null) return false;
    var bad = WbAuth.pinPolicyError(pin);
    if (bad) { wbAlert_('PIN 不符合規則', bad); continue; }
    var again = wbAsk_('確認 PIN', '請再輸入一次：');
    if (again === null) return false;
    if (again !== pin) { wbAlert_('兩次輸入不一致', '請重新設定。'); continue; }
    WbAuth.setPin(pin);
    return true;
  }
  return false;
}

function wbAddDeviceFlow_() {
  var name = wbAsk_('新增裝置授權碼', '幫這台裝置取個名字（例如：我的手機、公司筆電、家裡電腦）：');
  if (name === null) return null;
  WbAuth.ensureKey();
  var d = WbAuth.addDevice(name);
  wbAlert_('裝置授權碼（只會顯示這一次）',
    '裝置：' + d.name + '\n\n授權碼：\n' + d.token + '\n\n請立刻抄下或存進密碼管理員，再到那台裝置的登入畫面輸入。關掉這個視窗後就看不到了；' +
    '如果忘記，可以在選單「查看或撤銷裝置」撤銷後重新新增。');
  return d;
}

function menuFirstTimeSetup() {
  var u = wbUi_();
  var go = u.alert('第一次設定', '接下來會依序：\n1. 設定 PIN（登入時輸入）\n2. 產生第一組裝置授權碼（每台裝置一組）\n\n資料分頁都不會被更動。要開始嗎？', u.ButtonSet.OK_CANCEL);
  if (go !== u.Button.OK) return;
  WbAuth.ensureKey();
  if (!WbAuth.hasPin() && !wbAskNewPin_()) { wbAlert_('尚未完成', 'PIN 還沒設定。之後可從選單「設定或變更 PIN」繼續。'); return; }
  var device = wbAddDeviceFlow_();
  wbAlert_('設定完成', 'PIN 已設定' + (device ? '，第一台裝置「' + device.name + '」的授權碼也已產生' : '') + '。\n\n' +
    '接著請在 Apps Script 編輯器「部署 → 管理部署作業 → 編輯 → 版本：新版本 → 部署」，網址不會變。\n' +
    '其他裝置（手機、家裡電腦）各自用「新增裝置授權碼」產生一組。');
}

function menuSetPin() {
  WbAuth.ensureKey();
  if (wbAskNewPin_()) wbAlert_('完成', 'PIN 已設定。所有裝置下次登入都要用新的 PIN。');
}

function menuAddDevice() { wbAddDeviceFlow_(); }

function menuManageDevices() {
  var list = WbAuth.listDevices();
  if (!list.length) { wbAlert_('裝置', '目前沒有任何裝置授權碼。'); return; }
  var text = list.map(function (d) { return d.id + '：' + d.name + '（' + d.createdAt + '）'; }).join('\n');
  var id = wbAsk_('查看或撤銷裝置', text + '\n\n要撤銷哪一台？請輸入代號（例如 D1）；不撤銷請按取消：');
  if (id === null || !String(id).trim()) return;
  if (WbAuth.revokeDevice(String(id).trim().toUpperCase())) wbAlert_('已撤銷', '該裝置的授權碼與登入狀態已失效。');
  else wbAlert_('找不到', '沒有代號為「' + id + '」的裝置。');
}

function menuSignOutAll() {
  WbAuth.signOutAll();
  wbAlert_('已登出所有裝置', '所有裝置都需要重新輸入 PIN。');
}

function menuStatus() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('API_TOKEN')) props.deleteProperty('API_TOKEN'); // 舊版入口已移除，殘留的屬性順手清掉
  var devices = WbAuth.listDevices();
  wbWarmUp_();
  wbAlert_('目前狀態', [
    '版本：' + WB_VERSION,
    'PIN：' + (WbAuth.hasPin() ? '已設定' : '尚未設定'),
    '裝置：' + (devices.length ? devices.map(function (d) { return d.id + ' ' + d.name; }).join('、') : '無'),
    '每週自動備份：' + (wbBackupTrigger_() ? '已開啟（每週日凌晨 3～4 點）' : '未開啟'),
    '最近一次備份：' + (props.getProperty('BACKUP_LAST') || '還沒有'),
  ].join('\n'));
}

/** 檢查所有分頁讀得到（缺分頁會直接丟出錯誤訊息，方便排查） */
function wbWarmUp_() { getAllData_(); }

// ---------- 備份 ----------
// 把整份試算表複製到雲端硬碟「個人工作台備份」資料夾，只保留最近 WB_BACKUP_KEEP 份；
// 更舊的移到垃圾桶（Google 雲端硬碟垃圾桶保留 30 天，誤刪還救得回來）。
var WB_BACKUP_FOLDER_NAME = '個人工作台備份';
var WB_BACKUP_KEEP = 8;
var WB_BACKUP_HANDLER = 'wbWeeklyBackup';
var WB_BACKUP_TAG = ' 備份 ';

function wbBackupFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('BACKUP_FOLDER_ID');
  if (id) {
    try {
      var f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (err) { /* 資料夾被刪掉或沒權限 → 重新找／建立 */ }
  }
  var it = DriveApp.getFoldersByName(WB_BACKUP_FOLDER_NAME);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(WB_BACKUP_FOLDER_NAME);
  props.setProperty('BACKUP_FOLDER_ID', folder.getId());
  return folder;
}

/** 建立一份備份並清掉多餘的舊備份。回傳 { name, url, removed } */
function wbBackupNow_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var folder = wbBackupFolder_();
  var stamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HHmm');
  var copy = DriveApp.getFileById(ss.getId()).makeCopy(ss.getName() + WB_BACKUP_TAG + stamp, folder);
  var backups = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.getName().indexOf(WB_BACKUP_TAG) >= 0) backups.push(f);
  }
  backups.sort(function (a, b) { return b.getDateCreated().getTime() - a.getDateCreated().getTime(); });
  var old = backups.slice(WB_BACKUP_KEEP);
  old.forEach(function (f) { f.setTrashed(true); });
  PropertiesService.getScriptProperties().setProperty('BACKUP_LAST', stamp + '（' + copy.getName() + '）');
  return { name: copy.getName(), url: copy.getUrl(), removed: old.length };
}

/** 每週觸發器呼叫的函式（觸發器只能呼叫結尾沒有底線的全域函式）。失敗時 Google 會自動寄信通知。 */
function wbWeeklyBackup() { wbBackupNow_(); }

function wbBackupTrigger_() {
  var list = ScriptApp.getProjectTriggers();
  for (var i = 0; i < list.length; i++) if (list[i].getHandlerFunction() === WB_BACKUP_HANDLER) return list[i];
  return null;
}

function menuBackupNow() {
  var r = wbBackupNow_();
  wbAlert_('備份完成', '已建立：' + r.name + '\n位置：雲端硬碟「' + WB_BACKUP_FOLDER_NAME + '」資料夾\n' +
    (r.removed ? '已把 ' + r.removed + ' 份較舊的備份移到垃圾桶（只保留最近 ' + WB_BACKUP_KEEP + ' 份）。' : '目前保留最近 ' + WB_BACKUP_KEEP + ' 份。'));
}

function menuToggleWeeklyBackup() {
  var u = wbUi_();
  var t = wbBackupTrigger_();
  if (t) {
    if (u.alert('每週自動備份', '目前已開啟（每週日凌晨 3～4 點）。要關閉嗎？\n已經建立的備份不會被刪除。', u.ButtonSet.OK_CANCEL) !== u.Button.OK) return;
    ScriptApp.deleteTrigger(t);
    wbAlert_('已關閉', '每週自動備份已關閉。需要時可以用「立即備份一次」。');
    return;
  }
  ScriptApp.newTrigger(WB_BACKUP_HANDLER).timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create();
  var r = wbBackupNow_();
  wbAlert_('已開啟每週自動備份', '之後每週日凌晨 3～4 點會自動備份到雲端硬碟「' + WB_BACKUP_FOLDER_NAME + '」資料夾，只保留最近 ' + WB_BACKUP_KEEP + ' 份。\n\n' +
    '剛剛也先備份了一份：' + r.name);
}
