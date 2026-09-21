/**
 * 新版 API：所有請求都走 POST，body = { action, params, session }（Content-Type 用 text/plain 避開 CORS 預檢）。
 * 回應 { ok: true, data, session? } 或 { ok: false, error: { code, message } }。
 * 除了 ping / login，其他操作都要有效的工作階段碼（裝置授權碼＋PIN 登入後取得）。
 * 各模組的讀寫邏輯沿用 server/legacy.js（原本 Api.gs 的函式），這裡只負責驗證與分派。
 */
var WB_VERSION = '2.0.0';
var WbClock = { now: function () { return Date.now(); } };

function WbFail(code, message, extra) {
  var e = new Error(message);
  e.wbCode = code;
  e.extra = extra || null;
  return e;
}

function wbTimestamp_(ms) {
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

var WbApi = (function () {
  // 讀取：action → 產生資料的函式（都在 legacy.js）
  var READS = {
    courses: getCourses_, course_stats: getCourseStats_,
    subscriptions: getSubscriptions_, subscription_stats: getSubscriptionStats_,
    tasks: getTasks_, task_stats: getTaskStats_,
    projects: getProjects_, project_stats: getProjectStats_,
    habits: getHabits_, habit_stats: getHabitStats_,
    diaries: getDiaries_, diary_stats: getDiaryStats_,
    system_index: function () { return sheetToObjects_(getSheet_('系統索引')); },
    options: getOptions_, option_usage: getOptionUsage_,
    all: getAllData_,
    course_bundle: getCourseBundle_, sub_bundle: getSubBundle_, task_bundle: getTaskBundle_,
    project_bundle: getProjectBundle_, project_task_bundle: getProjectTaskBundle_,
    habit_bundle: getHabitBundle_, diary_bundle: getDiaryBundle_,
    // 分類管理頁：選項＋使用次數＋系統索引（改名/新增/刪除選項後只重抓這些，不必整包 all）
    admin_bundle: function () {
      return { options: getOptions_(), optionUsage: getOptionUsage_(), systemIndex: sheetToObjects_(getSheet_('系統索引')) };
    },
  };

  // 寫入：action → 函式(payload)。寫入一律加鎖，避免兩台裝置同時改到同一份資料時互相覆蓋。
  var WRITES = {
    create_course: createCourse_, update_course: updateCourse_, delete_course: deleteCourse_,
    create_subscription: createSubscription_, update_subscription: updateSubscription_, delete_subscription: deleteSubscription_,
    create_task: createTask_, update_task: updateTask_, delete_task: deleteTask_, skip_task: skipTask_,
    create_project: createProject_, update_project: updateProject_, delete_project: deleteProject_,
    create_habit: createHabit_, update_habit: updateHabit_, delete_habit: deleteHabit_,
    create_diary: createDiary_, update_diary: updateDiary_, delete_diary: deleteDiary_,
    add_option: addOption_, rename_option: renameOption_, delete_option: deleteOption_,
    update_system: updateSystemIndex_,
  };
  // 這幾個函式內部自己已經用 LockService 鎖住了，外層不能再鎖一次（同一把鎖重複 waitLock 會卡住）
  var SELF_LOCKING = { set_habit_log: setHabitLog_, create_diary: createDiary_ };

  function sheetUrl() { try { return SpreadsheetApp.getActiveSpreadsheet().getUrl(); } catch (e) { return ''; } }

  function withLock(fn) {
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try { return fn(); } finally { lock.releaseLock(); }
  }

  var H = {};
  H.ping = { auth: false, fn: function () { return { name: 'personal-workbench', version: WB_VERSION }; } };
  H.login = { auth: false, fn: function (p) { return WbAuth.login(p.token, p.pin, {}); } };
  H.bootstrap = {
    fn: function (p, env) {
      var all = getAllData_();
      all.meta = { version: WB_VERSION, device: env.device, sheetUrl: sheetUrl(), today: Utilities.formatDate(new Date(env.now), Session.getScriptTimeZone(), 'yyyy-MM-dd') };
      return all;
    },
  };
  H.changePin = {
    fn: function (p) {
      if (!WbAuth.checkPin(p.oldPin)) throw WbFail('AUTH_FAILED', '目前的 PIN 不正確');
      WbAuth.setPin(p.newPin);
      return { success: true };
    },
  };
  Object.keys(READS).forEach(function (k) { H[k] = { fn: function () { return READS[k](); } }; });
  Object.keys(WRITES).forEach(function (k) {
    if (SELF_LOCKING[k]) return;
    H[k] = { fn: function (p) { return withLock(function () { return WRITES[k](p); }); } };
  });
  Object.keys(SELF_LOCKING).forEach(function (k) { H[k] = { fn: function (p) { return SELF_LOCKING[k](p); } }; });

  function errorResponse(e) {
    if (e && e.wbCode) return { ok: false, error: { code: e.wbCode, message: e.message, details: e.extra || undefined } };
    var msg = e && e.message ? e.message : String(e);
    if (/Lock timeout|鎖定逾時|timed out/i.test(msg)) return { ok: false, error: { code: 'BUSY', message: '系統忙碌中（可能另一台裝置正在儲存），請稍後再試' } };
    // 業務邏輯的錯誤（legacy.js 丟出的 Error，例如「找不到任務」）直接把訊息給使用者看
    return { ok: false, error: { code: 'ERROR', message: msg } };
  }

  function handle(body) {
    var now = WbClock.now();
    try {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw WbFail('BAD_REQUEST', '請求格式錯誤');
      var h = Object.prototype.hasOwnProperty.call(H, body.action) ? H[body.action] : null;
      if (!h) throw WbFail('BAD_ACTION', '不支援的操作：' + body.action);
      var sess = null;
      if (h.auth !== false) sess = WbAuth.verifySession(body.session, now);
      var env = { device: sess ? sess.deviceName : '', session: sess, now: now };
      var params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {};
      var data = h.fn(params, env);
      var out = { ok: true, data: data === undefined ? null : data };
      if (sess) { var ns = WbAuth.refreshIfNeeded(sess, now); if (ns) out.session = ns; }
      return out;
    } catch (e) {
      return errorResponse(e);
    }
  }

  return { handle: handle, actions: Object.keys(H) };
})();
