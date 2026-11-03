/**
 * 新版 API：所有請求都走 POST，body = { action, params, session }（Content-Type 用 text/plain 避開 CORS 預檢）。
 * 回應 { ok: true, data, session? } 或 { ok: false, error: { code, message } }。
 * 除了 ping / login，其他操作都要有效的工作階段碼（裝置授權碼＋PIN 登入後取得）。
 * 各模組的讀寫邏輯沿用 server/legacy.js（原本 Api.gs 的函式），這裡只負責驗證與分派。
 */
var WB_VERSION = '2.9.0';
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
    system_index: function () { return sheetToObjects_('系統索引'); },
    options: getOptions_, option_usage: getOptionUsage_,
    all: getAllData_,
    course_bundle: getCourseBundle_, sub_bundle: getSubBundle_, task_bundle: getTaskBundle_,
    project_bundle: getProjectBundle_, project_task_bundle: getProjectTaskBundle_,
    habit_bundle: getHabitBundle_, diary_bundle: getDiaryBundle_,
    // 分類管理頁：選項＋使用次數＋系統索引（改名/新增/刪除選項後只重抓這些，不必整包 all）
    admin_bundle: function () {
      // optionUsage 要讀課程/訂閱/任務/專案/習慣，用 withReadMemo_ 讓每張表只讀一次
      return withReadMemo_(function () {
        return { options: getOptions_(), optionUsage: getOptionUsage_(), systemIndex: sheetToObjects_('系統索引') };
      }, true);
    },
  };

  // 寫入：action → 函式(payload)。寫入一律加鎖，避免兩台裝置同時改到同一份資料時互相覆蓋。
  var WRITES = {
    create_course: createCourse_, update_course: updateCourse_, delete_course: deleteCourse_,
    create_subscription: createSubscription_, update_subscription: updateSubscription_, delete_subscription: deleteSubscription_,
    create_task: createTask_, update_task: updateTask_, delete_task: deleteTask_, skip_task: skipTask_, set_task_status: setTaskStatus_,
    create_project: createProject_, update_project: updateProject_, delete_project: deleteProject_,
    create_habit: createHabit_, update_habit: updateHabit_, delete_habit: deleteHabit_,
    create_diary: createDiary_, update_diary: updateDiary_, delete_diary: deleteDiary_,
    add_option: addOption_, rename_option: renameOption_, delete_option: deleteOption_,
    update_system: updateSystemIndex_,
  };
  // 這幾個函式內部自己已經用 LockService 鎖住了，外層不能再鎖一次（同一把鎖重複 waitLock 會卡住）
  var SELF_LOCKING = { set_habit_log: setHabitLog_, create_diary: createDiary_ };

  // 寫入成功後順便回傳該模組的最新資料（前端就不用再打一次 *_bundle，省一次約 1.4 秒的請求）
  var RELOAD_AFTER = {
    course: 'course_bundle', subscription: 'sub_bundle', task: 'project_task_bundle', task_status: 'project_task_bundle',
    project: 'project_task_bundle', habit: 'habit_bundle', habit_log: 'habit_bundle', diary: 'diary_bundle',
    option: 'admin_bundle', system: 'admin_bundle',
  };
  function reloadFor(action) {
    if (action === 'rename_option') return null; // 改選項名稱會連動各模組，前端自己整包重抓
    if (!Object.prototype.hasOwnProperty.call(WRITES, action) && !Object.prototype.hasOwnProperty.call(SELF_LOCKING, action)) return null;
    return RELOAD_AFTER[action.replace(/^(create|update|delete|skip|set|add|rename)_/, '')] || null;
  }

  // 試算表網址不會變：第一次查到就存在指令碼屬性，之後每次登入載入都省一次服務呼叫
  function sheetUrl() {
    try {
      var props = PropertiesService.getScriptProperties();
      var u = props.getProperty('SHEET_URL');
      if (!u) { u = SpreadsheetApp.getActiveSpreadsheet().getUrl(); props.setProperty('SHEET_URL', u); }
      return u;
    } catch (e) { return ''; }
  }

  function withLock(fn) {
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try { return fn(); } finally { lock.releaseLock(); }
  }

  var H = {};
  H.ping = { auth: false, fn: function () { return { name: 'personal-workbench', version: WB_VERSION }; } };
  // ttlMinutes：這台裝置在設定頁選的「閒置多久要重新輸入 PIN」（後端會限制在 5 分鐘～30 天）
  H.login = { auth: false, fn: function (p) { return WbAuth.login(p.token, p.pin, { '閒置登出分鐘': p.ttlMinutes }); } };
  H.set_session_ttl = {
    fn: function (p, env) {
      var r = WbAuth.reissue(env.session, p.ttlMinutes, env.now);
      env.newSession = r.session; // 由 handle() 放進回應的 session，前端自動換上
      return { ttlMinutes: r.ttlMinutes };
    },
  };
  H.bootstrap = {
    fn: function (p, env) {
      WB_NO_PRELOAD_ = !!(p && p.noPreload);
      var all;
      try { all = getAllData_(); } finally { WB_NO_PRELOAD_ = false; }
      all.meta = { version: WB_VERSION, device: env.device, sheetUrl: sheetUrl(), today: Utilities.formatDate(new Date(env.now), Session.getScriptTimeZone(), 'yyyy-MM-dd') };
      return all;
    },
  };
  H.changePin = {
    fn: function (p, env) {
      // 跟登入共用失敗次數與鎖定（不然可以用變更 PIN 這條路無限次猜 PIN）
      WbAuth.guardedPinCheck(env.session.deviceId, p.oldPin, {}, env.now, '目前的 PIN 不正確');
      WbAuth.setPin(p.newPin);
      return { success: true };
    },
  };
  // params.noPreload=true：強制不用 Sheets API 預載、逐張讀（比對兩條路徑結果用）
  Object.keys(READS).forEach(function (k) { H[k] = { fn: function (p) { WB_NO_PRELOAD_ = !!(p && p.noPreload); try { return READS[k](); } finally { WB_NO_PRELOAD_ = false; } } }; });
  Object.keys(WRITES).forEach(function (k) {
    if (SELF_LOCKING[k]) return;
    H[k] = { fn: function (p) { return withLock(function () { return WRITES[k](p); }); } };
  });
  Object.keys(SELF_LOCKING).forEach(function (k) { H[k] = { fn: function (p) { return SELF_LOCKING[k](p); } }; });

  // ---------- 推播通知 ----------
  var TASK_CLOSED_ = ['已完成', '已取消', '已跳過'];
  function ymdOf_(ms) { return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
  function addDaysYmd_(ymd, n) { var d = WbLogic.parseYmd(ymd); d.setDate(d.getDate() + n); return WbLogic.ymd(d); }
  function mdOf_(ymd) { return ymd ? Number(ymd.slice(5, 7)) + '/' + Number(ymd.slice(8, 10)) : ''; }
  function names_(rows, field, max) {
    var list = rows.map(function (r) { return r[field]; });
    return list.slice(0, max).join('、') + (list.length > max ? '…等 ' + list.length + ' 個' : '');
  }
  /**
   * 推播用的摘要，依時段不同：
   *  - morning（早上）：早上時段還沒打卡的習慣＋今天到期的任務（星標優先）＋逾期筆數＋3 天內要付款的訂閱
   *  - noon（中午）：中午時段還沒打卡的習慣＋早上還沒補的
   *  - evening（晚上）：晚上時段還沒打卡的習慣＋今天到期還沒完成的任務
   *  - night（睡前）：今天該做但還沒打卡的全部習慣（含「不限」時段）
   * count＝件數（0 就不推）；title／body 是通知的標題與內文（內文最多 4 行）；url 是點通知要開的頁面。
   */
  function pushSummary(slot, nowMs) {
    var info = WbPush.SLOT_INFO[slot] || WbPush.SLOT_INFO.morning;
    slot = WbPush.SLOT_INFO[slot] ? slot : 'morning';
    var today = ymdOf_(nowMs);
    var MAX_LINES = 10; // 手機展開後大約能看到這麼多行；再多就寫「…還有 N 項」
    return withReadMemo_(function () {
      var habits = getHabits_().filter(function (h) { return h['狀態'] !== '封存' && h['今日應做'] && !h['今日已完成']; });
      var byTime = function (t) { return habits.filter(function (h) { return (h['時段'] || '不限') === t; }); };
      var tasks = getTasks_().filter(function (t) { return TASK_CLOSED_.indexOf(t['狀態'] || '') < 0 && t['到期日']; });
      var dueToday = tasks.filter(function (t) { return t['到期日'] === today; })
        .sort(function (a, b) { return (b['星標'] === true) - (a['星標'] === true); });
      var overdue = tasks.filter(function (t) { return t['到期日'] < today; });
      var parts = [], lines = [], count = 0;
      var taskLine = function (t) { return (t['星標'] === true ? '★ ' : '') + t['任務名稱']; };
      var listTasks = function (rows, max) { rows.slice(0, max).forEach(function (t) { lines.push(taskLine(t)); }); if (rows.length > max) lines.push('…還有 ' + (rows.length - max) + ' 筆任務'); };
      if (slot === 'morning') {
        var am = byTime('早上');
        if (am.length) { count += am.length; parts.push(am.length + ' 個習慣'); lines.push('習慣：' + names_(am, '習慣名稱', 6)); }
        if (dueToday.length) { count += dueToday.length; parts.push(dueToday.length + ' 筆任務'); listTasks(dueToday, 6); }
        if (overdue.length) { count += overdue.length; parts.push('逾期 ' + overdue.length + ' 筆'); }
        var soon = addDaysYmd_(today, 3);
        var subs = getSubscriptions_().filter(function (x) { return x['取消訂閱'] !== true && x['下次付款日'] && x['下次付款日'] >= today && x['下次付款日'] <= soon; });
        if (subs.length) { count += subs.length; parts.push(subs.length + ' 筆訂閱要付款'); subs.slice(0, 3).forEach(function (x) { lines.push(mdOf_(x['下次付款日']) + ' ' + x['產品'] + ' 付款'); }); }
      } else if (slot === 'noon') {
        var noon = byTime('中午'), amLeft = byTime('早上');
        if (noon.length) { count += noon.length; parts.push(noon.length + ' 個習慣'); lines.push('習慣：' + names_(noon, '習慣名稱', 6)); }
        if (amLeft.length) { count += amLeft.length; parts.push('早上還有 ' + amLeft.length + ' 個沒打卡'); lines.push('早上沒打卡：' + names_(amLeft, '習慣名稱', 6)); }
      } else if (slot === 'evening') {
        var pm = byTime('晚上');
        if (pm.length) { count += pm.length; parts.push(pm.length + ' 個習慣'); lines.push('習慣：' + names_(pm, '習慣名稱', 6)); }
        if (dueToday.length) { count += dueToday.length; parts.push('任務還剩 ' + dueToday.length + ' 筆'); listTasks(dueToday, 5); }
      } else {
        if (habits.length) { count += habits.length; parts.push('還有 ' + habits.length + ' 個習慣沒打卡'); lines.push(names_(habits, '習慣名稱', 10)); }
      }
      // 標題短短的（手機最多顯示兩行），數字放內文第一行，後面把項目列出來
      var title = count ? info.label + '提醒' : (info.label + '：今天沒有要處理的事');
      if (count) lines.unshift(parts.join('、'));
      var body = lines.slice(0, MAX_LINES).join('\n') + (lines.length > MAX_LINES ? '\n…還有 ' + (lines.length - MAX_LINES) + ' 項' : '');
      return { slot: slot, count: count, title: title, body: body, lines: lines, today: today, url: info.url };
    }, true);
  }

  /** 推播：前端 pushManager.subscribe 需要的公鑰、這個帳號目前訂閱的裝置、時段預設 */
  H.push_info = { fn: function () { return { publicKey: WbWebPush.publicKey(), subscriptions: WbPush.listAll(), slots: WbPush.SLOT_INFO, order: WbPush.SLOTS, trigger: WbPush.hasTrigger() }; } };
  H.push_subscribe = { fn: function (p, env) { return WbPush.subscribe(p, env); } };
  H.push_update = { fn: function (p) { return WbPush.update(p); } };
  H.push_unsubscribe = { fn: function (p) { return WbPush.unsubscribe(p); } };
  /** 立刻推一則（測試用）：不管時間、也不管有沒有事；p.slot 指定用哪個時段的摘要，沒給就看現在幾點 */
  H.push_test = {
    fn: function (p, env) {
      var list = WbPush.load();
      var sub = WbPush.find(list, p.id);
      if (!sub) throw WbFail('NOT_FOUND', '找不到這個推播訂閱（請重新開啟通知）');
      var slot = WbPush.SLOT_INFO[p.slot] ? p.slot : WbPush.slotForHour(sub, Number(Utilities.formatDate(new Date(env.now), 'Asia/Taipei', 'HH')));
      var r = WbPush.sendTo(sub, slot, env.now, list);
      if (!r.ok) throw WbFail('PUSH_FAILED', '推播送出失敗（' + (r.code || '連線錯誤') + '）' + (r.gone ? '：這支手機的訂閱已失效，請關閉後重新開啟通知' : r.body ? '：' + r.body : ''));
      return { code: r.code, slot: slot, summary: pushSummary(slot, env.now) };
    },
  };
  /** 手機的 service worker 收到推播後來拿摘要：用訂閱時發給它的裝置摘要碼，不用登入 */
  H.push_summary = {
    auth: false,
    fn: function (p, env) {
      var sub = WbPush.byToken(p.token);
      if (!sub || sub.active === false) throw WbFail('AUTH_FAILED', '推播裝置碼無效，請重新開啟通知');
      var s = pushSummary(sub.pendingSlot || 'morning', env.now);
      return { slot: s.slot, title: s.title, body: s.body, count: s.count, today: s.today, url: s.url };
    },
  };

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
      var rb = reloadFor(body.action);
      if (rb && params.reload !== false) {
        try { out.reload = { name: rb, data: H[rb].fn({}, env) }; } catch (e2) { /* 讀不到就讓前端自己重抓 */ }
      }
      if (env.newSession) out.session = env.newSession;
      else if (sess) { var ns = WbAuth.refreshIfNeeded(sess, now); if (ns) out.session = ns; }
      return out;
    } catch (e) {
      return errorResponse(e);
    }
  }

  return { handle: handle, actions: Object.keys(H), pushSummary: pushSummary };
})();
