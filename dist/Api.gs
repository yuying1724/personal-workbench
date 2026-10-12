/**
 * 個人工作台 — Apps Script 後端（自動產生，請勿直接在 Apps Script 編輯器修改）
 * 由 tools/build-gas.js 從 server/ 合併而成；要改程式請改 server/ 再重新 build。
 */

// ==================== shared/logic.js ====================
/**
 * 前後端共用的商業邏輯（唯一正本）。
 * - 後端：tools/build-gas.js 會把這個檔案放在 dist/Api.gs 最前面，legacy.js 透過全域的 WbLogic 呼叫。
 * - 前端：tools/build-web.js 會複製成 docs/js/shared-logic.js（尾端加 export），樂觀更新時用同一套判斷。
 * 規則：只能用 ES5 語法、不能用任何 Apps Script 服務或瀏覽器 API（兩邊都要能跑）；
 * 日期一律用「當地時間」的 getFullYear/getMonth/getDate（Apps Script 的當地時間＝指令碼時區，也就是台北）。
 * 改這裡之後兩邊都要重新 build：npm run build。
 */
var WbLogic = (function () {
  var DAY_MS = 86400000;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /** Date → 'yyyy-MM-dd'（當地時間） */
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  /** 'yyyy-MM-dd' → 當地時間午夜的 Date；格式不對回傳 null */
  function parseYmd(s) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(s || ''));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  function hasNum(v) { return v !== '' && v !== null && v !== undefined; }

  /** 加 N 個月，日數溢位就停在月底（1/31 + 1 個月 = 2/28 或 2/29） */
  function addMonthsSafe(date, months) {
    var day = date.getDate();
    var d = new Date(date.getFullYear(), date.getMonth() + months, 1);
    var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return d;
  }
  /** 那一週的週日（當地時間午夜） */
  function startOfWeek(date) {
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - d.getDay());
    return d;
  }

  // ---------- 任務重複規則 ----------
  // 格式：JSON {"freq":"day|week|month|year","interval":N,"weekdays":[0-6],"lastDayOfMonth":true,"end":{"type":"date","date":"yyyy-MM-dd"}|{"type":"count","count":N},"occurrence":N}
  // 其他文字＝自訂標籤（只是記錄，不會自動產生下一筆）
  /** 看得懂就回傳物件，否則 null */
  function parseRepeatRule(raw) {
    if (!raw) return null;
    var obj;
    try { obj = JSON.parse(raw); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object') return null;
    if (['day', 'week', 'month', 'year'].indexOf(obj.freq) === -1) return null;
    return obj;
  }

  // 從 fromDate 往後找下一個「指定星期幾、每 N 週」的日期（以 fromDate 那週的週日為第 0 週）
  function nextWeekdayOccurrence(fromDate, weekdays, interval) {
    var sorted = weekdays.map(Number).slice().sort(function (a, b) { return a - b; });
    var baseWeekStart = startOfWeek(fromDate);
    var cur = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
    for (var i = 0; i < 7 * interval + 8; i++) {
      cur.setDate(cur.getDate() + 1);
      if (sorted.indexOf(cur.getDay()) !== -1) {
        var weeksDiff = Math.round((startOfWeek(cur).getTime() - baseWeekStart.getTime()) / (7 * DAY_MS));
        if (((weeksDiff % interval) + interval) % interval === 0) return cur;
      }
    }
    return cur;
  }

  /** 依重複規則算下一次的到期日（'yyyy-MM-dd'）；沒有到期日或規則看不懂回傳 '' */
  function nextDueDate(dateStr, ruleRaw) {
    var d = parseYmd(dateStr);
    if (!d) return '';
    var rule = parseRepeatRule(ruleRaw);
    if (!rule) return '';
    var interval = Math.max(1, parseInt(rule.interval, 10) || 1);
    if (rule.freq === 'day') {
      d.setDate(d.getDate() + interval);
    } else if (rule.freq === 'week') {
      if (rule.weekdays && rule.weekdays.length) d = nextWeekdayOccurrence(d, rule.weekdays, interval);
      else d.setDate(d.getDate() + 7 * interval);
    } else if (rule.freq === 'month') {
      if (rule.lastDayOfMonth) d = new Date(d.getFullYear(), d.getMonth() + interval + 1, 0); // 第 0 天＝上個月最後一天
      else d = addMonthsSafe(d, interval);
    } else if (rule.freq === 'year') {
      d = addMonthsSafe(d, 12 * interval); // 2/29 的下一年是 2/28
    } else {
      return '';
    }
    return ymd(d);
  }

  /**
   * 這次完成後是否已經到了截止條件。回傳 { stop, nextRuleRaw }：
   * nextRuleRaw 是下一筆要帶的規則字串（次數限制時 occurrence + 1，其他情況原封不動）
   */
  function applyRepeatEnd(rule, ruleRaw, nextDueStr) {
    if (!rule || !rule.end) return { stop: false, nextRuleRaw: ruleRaw };
    var end = rule.end;
    if (end.type === 'date' && end.date) return { stop: nextDueStr > end.date, nextRuleRaw: ruleRaw };
    if (end.type === 'count' && end.count) {
      var done = rule.occurrence || 1;
      if (done >= end.count) return { stop: true, nextRuleRaw: ruleRaw };
      var next = JSON.parse(JSON.stringify(rule));
      next.occurrence = done + 1;
      return { stop: false, nextRuleRaw: JSON.stringify(next) };
    }
    return { stop: false, nextRuleRaw: ruleRaw };
  }

  // ---------- 習慣 ----------
  /** 這天是不是這個習慣該做的日子：「指定星期」只有清單裡的星期幾要做，其他頻率每天都算（weeklyCount 另外算） */
  function isRequiredDay(habit, dateStr) {
    if (habit['頻率類型'] !== 'weekday') return true;
    var d = parseYmd(dateStr);
    return !!d && (habit['星期幾'] || []).map(Number).indexOf(d.getDay()) !== -1;
  }
  /** 這天算不算完成：打勾型 >=1；計數型有三級制時「基礎」以上就算，否則要達到目標值 */
  function isHabitDoneForDay(habit, value) {
    var v = Number(value) || 0;
    if (habit['類型'] !== '計數') return v >= 1;
    if (habit['啟用分級'] === true && hasNum(habit['基礎值'])) return v >= (Number(habit['基礎值']) || 0);
    return v >= (Number(habit['目標值']) || 1);
  }
  /** 三級制的等級（只有計數型＋開三級制才有）：'基礎' | '達標' | '超標' | null */
  function habitTierForValue(habit, value) {
    if (habit['類型'] !== '計數' || habit['啟用分級'] !== true) return null;
    var v = Number(value) || 0;
    var target = Number(habit['目標值']) || 0;
    if (hasNum(habit['超標值']) && v >= Number(habit['超標值'])) return '超標';
    if (v >= target) return '達標';
    if (hasNum(habit['基礎值']) && v >= Number(habit['基礎值'])) return '基礎';
    return null;
  }

  // ---------- 任務統計 ----------
  /** todayStr／soonStr：'yyyy-MM-dd'（soon＝今天 + 3 天，到期日在這之間算「即將到期」） */
  function taskStats(tasks, todayStr, soonStr) {
    var completed = 0, overdue = 0, dueSoon = 0, starredOpen = 0;
    (tasks || []).forEach(function (t) {
      var isDone = t['狀態'] === '已完成';
      // 已取消／已跳過＝這一筆處理完了，不算逾期／即將到期
      var isClosed = t['狀態'] === '已取消' || t['狀態'] === '已跳過';
      if (isDone) completed++;
      if (t['星標'] === true && !isDone && !isClosed) starredOpen++;
      if (t['到期日'] && !isDone && !isClosed) {
        if (t['到期日'] < todayStr) overdue++;
        else if (t['到期日'] <= soonStr) dueSoon++;
      }
    });
    return { total: (tasks || []).length, completed: completed, overdue: overdue, dueSoon: dueSoon, starredOpen: starredOpen };
  }

  return {
    ymd: ymd, parseYmd: parseYmd, addMonthsSafe: addMonthsSafe, startOfWeek: startOfWeek,
    parseRepeatRule: parseRepeatRule, nextDueDate: nextDueDate, applyRepeatEnd: applyRepeatEnd,
    isRequiredDay: isRequiredDay, isHabitDoneForDay: isHabitDoneForDay, habitTierForValue: habitTierForValue, taskStats: taskStats,
  };
})();

// ==================== server/api.js ====================
/**
 * 新版 API：所有請求都走 POST，body = { action, params, session }（Content-Type 用 text/plain 避開 CORS 預檢）。
 * 回應 { ok: true, data, session? } 或 { ok: false, error: { code, message } }。
 * 除了 ping / login，其他操作都要有效的工作階段碼（裝置授權碼＋PIN 登入後取得）。
 * 各模組的讀寫邏輯沿用 server/legacy.js（原本 Api.gs 的函式），這裡只負責驗證與分派。
 */
var WB_VERSION = '2.7.0';
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

  return { handle: handle, actions: Object.keys(H) };
})();

// ==================== server/auth.js ====================
/**
 * 登入與工作階段：
 *  - 裝置授權碼（每台裝置一組，可個別撤銷）+ PIN，兩者都只存「加鹽雜湊」在 Script Properties
 *  - 授權碼正確但 PIN 錯誤才計入失敗次數（5 次鎖定 15 分鐘）。授權碼錯誤不計次，
 *    這樣不知道授權碼的人無法靠亂試把你鎖在門外。
 *  - 工作階段碼 = 裝置ID.發出時間.到期時間.效期.HMAC簽章；每次請求後若剩餘不到一半效期就自動續期
 */
var WbAuth = (function () {
  var DEVICES_KEY = 'DEVICES', PIN_KEY = 'PIN', HMAC_KEY = 'HMAC_KEY';
  var TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易看錯的 I O 0 1
  var MIN_PIN_LENGTH = 6;

  function props() { return PropertiesService.getScriptProperties(); }

  function toHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i] & 0xff; // Apps Script 回傳有號位元組
      out += (b < 16 ? '0' : '') + b.toString(16);
    }
    return out;
  }
  function sha256Hex(str) { return toHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str)); }
  function hmacHex(message, key) { return toHex(Utilities.computeHmacSha256Signature(message, key)); }

  function constEq(a, b) {
    a = String(a); b = String(b);
    var diff = a.length === b.length ? 0 : 1;
    var n = Math.max(a.length, b.length);
    for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
  }

  function randomHex(n) {
    var out = '';
    while (out.length < n) out += Utilities.getUuid().replace(/-/g, '');
    return out.slice(0, n);
  }

  function generateToken() {
    var hex = randomHex(64), chars = '';
    for (var i = 0; i < 20; i++) chars += TOKEN_ALPHABET.charAt(parseInt(hex.substr(i * 2, 2), 16) & 31);
    return chars.replace(/(.{5})(?=.)/g, '$1-'); // XXXXX-XXXXX-XXXXX-XXXXX
  }
  function normalizeToken(t) { return String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  function loadDevices() {
    var raw = props().getProperty(DEVICES_KEY);
    if (!raw) return [];
    try { return JSON.parse(raw); } catch (e) { return []; }
  }
  function saveDevices(list) { props().setProperty(DEVICES_KEY, JSON.stringify(list)); }

  function hmacKey() {
    var k = props().getProperty(HMAC_KEY);
    if (!k) throw WbFail('NOT_INITIALIZED', '尚未完成登入設定：請在試算表選單「個人工作台 → 第一次設定」');
    return k;
  }

  // ---------- 設定（選單使用） ----------
  function addDevice(name) {
    name = String(name || '').trim().slice(0, 30) || '未命名裝置';
    var list = loadDevices();
    var max = 0;
    list.forEach(function (d) { var n = parseInt(String(d.id).slice(1), 10); if (n > max) max = n; });
    var token = generateToken();
    var salt = randomHex(16);
    var dev = { id: 'D' + (max + 1), name: name, salt: salt, hash: sha256Hex(salt + ':' + normalizeToken(token)), createdAt: wbTimestamp_(WbClock.now()) };
    list.push(dev);
    saveDevices(list);
    return { id: dev.id, name: dev.name, token: token };
  }
  function listDevices() {
    return loadDevices().map(function (d) { return { id: d.id, name: d.name, createdAt: d.createdAt }; });
  }
  function revokeDevice(id) {
    var list = loadDevices();
    var next = list.filter(function (d) { return d.id !== id; });
    if (next.length === list.length) return false;
    saveDevices(next);
    return true;
  }
  function pinPolicyError(pin) {
    pin = String(pin || '');
    if (pin.length < MIN_PIN_LENGTH) return 'PIN 至少要 ' + MIN_PIN_LENGTH + ' 碼';
    if (/^(.)\1+$/.test(pin)) return 'PIN 不能全部是同一個字元';
    return '';
  }
  function setPin(pin) {
    var bad = pinPolicyError(pin);
    if (bad) throw WbFail('WEAK_PIN', bad);
    var salt = randomHex(16);
    props().setProperty(PIN_KEY, JSON.stringify({ salt: salt, hash: sha256Hex(salt + ':' + String(pin)) }));
  }
  function hasPin() { return !!props().getProperty(PIN_KEY); }
  function checkPin(pin) {
    var raw = props().getProperty(PIN_KEY);
    if (!raw) return false;
    var rec = JSON.parse(raw);
    return constEq(sha256Hex(rec.salt + ':' + String(pin === null || pin === undefined ? '' : pin)), rec.hash);
  }
  function signOutAll() { props().setProperty(HMAC_KEY, randomHex(48)); }
  /** 第一次使用時產生簽章金鑰（已存在就不動） */
  function ensureKey() { if (!props().getProperty(HMAC_KEY)) props().setProperty(HMAC_KEY, randomHex(48)); }

  // ---------- 登入 ----------
  function numSetting(settings, key, def, min, max) {
    var n = Number(settings && settings[key]);
    if (!isFinite(n) || n <= 0) n = def;
    return Math.min(max, Math.max(min, n));
  }

  function issueSession(device, ttlMs, nowMs) {
    var payload = [device.id, nowMs, nowMs + ttlMs, ttlMs].join('.');
    return payload + '.' + hmacHex(payload, hmacKey());
  }

  /**
   * 檢查 PIN，並計算連續失敗次數（超過就鎖定一段時間）。登入與變更 PIN 共用同一個計數。
   * 「讀失敗次數 → 判斷 → 寫回」用 LockService 鎖住，同時送很多個請求也不能多猜幾次。
   */
  function guardedPinCheck(deviceId, pin, settings, now, wrongMsg) {
    var cache = CacheService.getScriptCache();
    var maxFails = numSetting(settings, '失敗鎖定次數', 5, 3, 20);
    var lockSec = numSetting(settings, '鎖定分鐘', 15, 1, 360) * 60;
    var lockKey = 'lock:' + deviceId, failKey = 'fail:' + deviceId;
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      var until = Number(cache.get(lockKey) || 0);
      if (until > now) {
        var wait = Math.ceil((until - now) / 60000);
        throw WbFail('LOCKED', '嘗試次數過多，請 ' + wait + ' 分鐘後再試', { retryAfterSec: Math.ceil((until - now) / 1000) });
      }
      if (checkPin(pin)) { cache.remove(failKey); return true; }
      var fails = Number(cache.get(failKey) || 0) + 1;
      if (fails >= maxFails) {
        cache.put(lockKey, String(now + lockSec * 1000), lockSec);
        cache.remove(failKey);
        throw WbFail('LOCKED', '輸入錯誤次數過多，已鎖定 ' + Math.round(lockSec / 60) + ' 分鐘', { retryAfterSec: lockSec });
      }
      cache.put(failKey, String(fails), lockSec);
      throw WbFail('AUTH_FAILED', wrongMsg + '（還可以再試 ' + (maxFails - fails) + ' 次）', { remaining: maxFails - fails });
    } finally {
      lock.releaseLock();
    }
  }

  // 閒置多久要重新輸入 PIN：每台裝置自己選（設定頁），最短 5 分鐘、最長 30 天
  var MAX_TTL_MIN = 30 * 24 * 60;
  /** 已登入的裝置改「閒置多久要重新輸入 PIN」：用同一台裝置的身分換發一張新效期的工作階段碼 */
  function reissue(sess, ttlMinutes, nowMs) {
    var ttlMs = numSetting({ v: ttlMinutes }, 'v', 60, 5, MAX_TTL_MIN) * 60000;
    return { session: issueSession({ id: sess.deviceId }, ttlMs, nowMs), ttlMinutes: Math.round(ttlMs / 60000) };
  }

  function login(token, pin, settings) {
    var now = WbClock.now();
    var tok = normalizeToken(token);
    var match = null;
    loadDevices().forEach(function (d) {
      if (constEq(sha256Hex(d.salt + ':' + tok), d.hash)) match = d;
    });
    if (!match) {
      Utilities.sleep(700); // 拖慢亂猜
      throw WbFail('AUTH_FAILED', '授權碼或 PIN 錯誤');
    }
    if (!hasPin()) throw WbFail('NOT_INITIALIZED', 'PIN 尚未設定：請在試算表選單「個人工作台 → 設定或變更 PIN」');
    guardedPinCheck(match.id, pin, settings, now, '授權碼或 PIN 錯誤');
    var ttlMs = numSetting(settings, '閒置登出分鐘', 60, 5, MAX_TTL_MIN) * 60000;
    return { session: issueSession(match, ttlMs, now), device: { id: match.id, name: match.name }, ttlMinutes: Math.round(ttlMs / 60000) };
  }

  /** 驗證工作階段碼，回傳 {deviceId, deviceName, ttlMs, expMs}；失敗丟出 AUTH_REQUIRED */
  function verifySession(session, nowMs) {
    var fail = function () { return WbFail('AUTH_REQUIRED', '登入已過期，請重新登入'); };
    if (!session || typeof session !== 'string') throw fail();
    var parts = session.split('.');
    if (parts.length !== 5) throw fail();
    var payload = parts.slice(0, 4).join('.');
    var key;
    try { key = hmacKey(); } catch (e) { throw fail(); }
    if (!constEq(hmacHex(payload, key), parts[4])) throw fail();
    var exp = Number(parts[2]), ttl = Number(parts[3]);
    if (!(exp > nowMs)) throw fail();
    var dev = null;
    loadDevices().forEach(function (d) { if (d.id === parts[0]) dev = d; });
    if (!dev) throw fail(); // 裝置已被撤銷
    return { deviceId: dev.id, deviceName: dev.name, ttlMs: ttl, expMs: exp };
  }

  /** 剩餘不到一半效期就換發新的（滑動視窗） */
  function refreshIfNeeded(sess, nowMs) {
    if (sess.expMs - nowMs >= sess.ttlMs / 2) return null;
    return issueSession({ id: sess.deviceId }, sess.ttlMs, nowMs);
  }

  return {
    addDevice: addDevice, listDevices: listDevices, revokeDevice: revokeDevice, setPin: setPin, hasPin: hasPin, checkPin: checkPin,
    pinPolicyError: pinPolicyError, guardedPinCheck: guardedPinCheck, reissue: reissue, MAX_TTL_MIN: MAX_TTL_MIN, signOutAll: signOutAll, ensureKey: ensureKey, login: login, verifySession: verifySession, refreshIfNeeded: refreshIfNeeded,
    randomHex: randomHex, generateToken: generateToken, constEq: constEq, MIN_PIN_LENGTH: MIN_PIN_LENGTH,
  };
})();

// ==================== server/legacy.js ====================
/*
 * ====================================================================
 * 各模組的資料邏輯（課程／訂閱／任務／專案／習慣／日記／分類管理／系統索引）
 * 源自 2026-09-21 的線上版 Api.gs（備份在 backup/Api.gs），之後陸續做了效能與正確性修改。
 * 入口在 server/main.js（doGet/doPost）→ server/api.js（驗證「裝置授權碼＋PIN」的工作階段、分派），
 * 再呼叫這裡的 getXxx_/createXxx_/updateXxx_ 等函式。
 * 2026-10-11：舊版 API_TOKEN 入口（legacyDoGet_/legacyDoPost_）已移除。
 * ====================================================================
 */
function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// 一次把首頁需要的所有資料包在一個回應裡回傳。
// 前端原本一開始要同時發 13 個平行請求（courses/course_stats/subscriptions/...），
// 免費的 Apps Script 網頁應用程式對「同一個使用者同時打好幾個請求」的承受度不高，
// 模組越加越多之後，偶爾會有其中幾個請求被擋下來變成回傳 HTML 錯誤頁（不是 JSON），
// 這就是「載入失敗：Unexpected token '<'」這個錯誤的常見原因。
// 改成前端只發一個 ?action=all，後端一次算完全部再回傳，就不會再有這種平行請求互相搶著跑的問題。
// 2026-09-24 效能調整：
//  1. 整包讀取期間開啟 withReadMemo_()，每張分頁只讀一次（原本各模組的 stats 函式、
//     getProjects_() 裡的 getTasks_() 都會各自重讀分頁，14 張表被讀了 40 幾次）。
//  2. 不再帶 optionUsage（各選項被用幾次）——它只有「分類管理」頁會用到，卻要把
//     課程/訂閱/任務/專案/習慣全部再讀一輪（實測佔了 bootstrap 一半時間）。
//     前端在打開分類管理頁時才用 admin_bundle 抓。
function getAllData_() {
  return withReadMemo_(function () {
    return {
      courses: getCourses_(),
      courseStats: getCourseStats_(),
      subscriptions: getSubscriptions_(),
      subscriptionStats: getSubscriptionStats_(),
      tasks: getTasks_(),
      taskStats: getTaskStats_(),
      projects: getProjects_(),
      projectStats: getProjectStats_(),
      habits: getHabits_(),
      habitStats: getHabitStats_(),
      diaries: getDiaries_(),
      diaryStats: getDiaryStats_(),
      options: getOptions_(),
      systemIndex: sheetToObjects_("系統索引")
    };
  }, true);
}

// 以下「單一模組打包」端點：只給前端在「儲存／刪除單一模組資料後」用，
// 只讀該模組需要的分頁，比 getAllData_() 輕很多，用意是新增/刪除/編輯後
// 不用把全部15種資料重抓一次，減少同時間打到 Apps Script 的執行緒數量。
function getCourseBundle_() {
  return withReadMemo_(function () { return { courses: getCourses_(), courseStats: getCourseStats_() }; });
}
function getSubBundle_() {
  return withReadMemo_(function () { return { subscriptions: getSubscriptions_(), subscriptionStats: getSubscriptionStats_() }; });
}
function getTaskBundle_() {
  return withReadMemo_(function () { return { tasks: getTasks_(), taskStats: getTaskStats_() }; });
}
function getProjectBundle_() {
  return withReadMemo_(function () { return { projects: getProjects_(), projectStats: getProjectStats_() }; });
}
// 刪除專案會連動清空任務的「所屬專案」欄位，所以刪除專案後前端要用這個，
// 一次把專案跟任務兩邊都重新抓回來。
function getProjectTaskBundle_() {
  return withReadMemo_(function () {
    return {
      projects: getProjects_(), projectStats: getProjectStats_(),
      tasks: getTasks_(), taskStats: getTaskStats_()
    };
  });
}
function getHabitBundle_() {
  return withReadMemo_(function () { return { habits: getHabits_(), habitStats: getHabitStats_() }; });
}
function getDiaryBundle_() {
  return withReadMemo_(function () { return { diaries: getDiaries_(), diaryStats: getDiaryStats_() }; });
}

// ---- 唯讀請求的分頁快取（只活在同一次執行裡） ----
// 只在 withReadMemo_() 包住的區塊裡生效：getCourses_()/getTasks_() 等第一次算完就記住，
// 同一次請求裡再呼叫直接回傳同一份結果。寫入類的 action 不會經過 withReadMemo_，
// 所以「先寫再讀」的函式（updateTask_ 之後重讀對照表等）不受影響、不會讀到舊資料。
var WB_READ_MEMO_ = null;
// preload=true（bootstrap/all、admin_bundle 這種要讀十幾張表的請求）才一次預載整本；
// 只讀 1～3 張表的 bundle 逐張讀反而比較快，不預載。
function withReadMemo_(fn, preload) {
  if (WB_READ_MEMO_) return fn(); // 已經在 memo 區塊裡（巢狀呼叫）就直接沿用
  WB_READ_MEMO_ = {};
  WB_PRELOAD_ = preload && !WB_NO_PRELOAD_ ? wbPreloadAll_() : null; // 沒有 Sheets 進階服務時是 null → 各分頁各自讀
  try { return fn(); } finally { WB_READ_MEMO_ = null; WB_PRELOAD_ = null; }
}

// ---- 一次讀完所有分頁（Sheets 進階服務）----
// 2026-09-24 效能調整：SpreadsheetApp 每張分頁 getSheetByName + getDataRange().getValues() 都是跨網路的服務呼叫，
// 14 張分頁就要 14 趟（bootstrap 光讀表就 10 秒以上）。改用 Sheets API 的 Values.batchGet 一次把所有分頁的
// 值拿回來（只拿值、不拿格式，回應小、快），唯讀請求內的 sheetToObjects_()/wbSheetValues_() 直接用這份。
// 需要在 Apps Script 專案「服務」加入 Google Sheets API（識別碼 Sheets）；沒加的話 typeof Sheets 是 undefined，
// 或 API 呼叫失敗（例如分頁改名），都自動退回原本逐張讀取的方式，功能一樣只是慢。
// 之後新增分頁（例如人員模組）要記得加進 WB_PRELOAD_SHEETS_，不加也能用，只是那幾張會逐張讀。
var WB_PRELOAD_SHEETS_ = ["課程", "課程分類對照", "訂閱服務", "訂閱標籤對照", "任務", "任務分類對照", "子任務", "專案",
  "習慣", "習慣打卡紀錄", "日記", "日記發現清單", "系統索引", "設定"];
var WB_PRELOAD_ = null; // { 分頁名稱: values[][] }，只在 withReadMemo_ 區塊內有值
var WB_NO_PRELOAD_ = false; // 請求帶 params.noPreload=true 可強制逐張讀（用來比對兩條路徑的結果是否一致）
function wbPreloadAll_() {
  if (typeof Sheets === "undefined" || !Sheets || !Sheets.Spreadsheets || !Sheets.Spreadsheets.Values) return null;
  try {
    var id = SpreadsheetApp.getActiveSpreadsheet().getId();
    var res = Sheets.Spreadsheets.Values.batchGet(id, {
      ranges: WB_PRELOAD_SHEETS_.map(function (n) { return "'" + n + "'"; }),
      valueRenderOption: "UNFORMATTED_VALUE",   // 數字就是數字（進度 0.5 不會變 "50%"）、布林就是布林
      dateTimeRenderOption: "FORMATTED_STRING", // 日期依儲存格格式輸出成字串，下面 wbCellValue_ 再統一成 yyyy-MM-dd
    });
    var out = {};
    (res.valueRanges || []).forEach(function (vr, i) {
      var rows = (vr.values || []).map(function (r) { return r.map(wbCellValue_); });
      // getValues() 回的是整齊的矩形（空格為 ""），API 會省略列尾的空格，這裡補齊
      var width = 0;
      rows.forEach(function (r) { if (r.length > width) width = r.length; });
      rows.forEach(function (r) { while (r.length < width) r.push(""); });
      if (!rows.length) rows.push([""]);
      out[WB_PRELOAD_SHEETS_[i]] = rows;
    });
    return out;
  } catch (err) {
    Logger.log("wbPreloadAll_ 失敗，改為逐張讀取：" + err);
    return null;
  }
}
// API 回的值 → 跟 getValues()+normalizeDate_ 一樣的結果：日期／日期時間字串（"2026/9/24"、"2026-09-24 上午 10:43:00"…）
// 統一成 yyyy-MM-dd；其他字串、數字、布林原樣。null（空格）→ ""
var WB_DATE_STR_RE_ = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:\s*(?:上午|下午|AM|PM)?\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:上午|下午|AM|PM)?)?$/;
function wbCellValue_(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    var m = WB_DATE_STR_RE_.exec(v);
    if (m) return m[1] + "-" + (m[2].length < 2 ? "0" : "") + m[2] + "-" + (m[3].length < 2 ? "0" : "") + m[3];
  }
  return v;
}
/** 取分頁全部值：唯讀請求內有預載就直接用（不再呼叫 SpreadsheetApp），否則逐張讀。參數可傳分頁名稱或 Sheet 物件 */
function wbSheetValues_(sheetOrName) {
  var name = typeof sheetOrName === "string" ? sheetOrName : sheetOrName.getName();
  if (WB_PRELOAD_ && Object.prototype.hasOwnProperty.call(WB_PRELOAD_, name)) return WB_PRELOAD_[name];
  var sheet = typeof sheetOrName === "string" ? getSheet_(name) : sheetOrName;
  return sheet.getDataRange().getValues();
}
function wbMemo_(key, fn) {
  if (!WB_READ_MEMO_) return fn();
  if (!Object.prototype.hasOwnProperty.call(WB_READ_MEMO_, key)) WB_READ_MEMO_[key] = fn();
  return WB_READ_MEMO_[key];
}

// ---------------- 內部工具 ----------------

function getSheet_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error("找不到分頁：" + name);
  return sheet;
}

// 把一個分頁（含表頭列）轉成物件陣列，日期欄位轉成 yyyy-MM-dd 字串。參數可傳分頁名稱（唯讀路徑用，能吃到預載）或 Sheet 物件
function sheetToObjects_(sheetOrName) {
  var data = wbSheetValues_(sheetOrName);
  if (data.length < 2) return [];
  var headers = data[0];
  return data.slice(1)
    .filter(function (row) { return row[0] !== "" && row[0] !== null; })
    .map(function (row) {
      var obj = {};
      headers.forEach(function (h, i) {
        obj[h] = normalizeDate_(row[i]);
      });
      return obj;
    });
}

// 日期欄位統一轉成 yyyy-MM-dd 字串。
// 自訂函數（LAST_PAYMENT_DATE 等）算出來、經公式格算過的日期值，
// getValues() 讀回來的型別不太穩定：可能是 Date 物件、可能是 ISO 字串，
// 也可能是「功能上是日期但 instanceof Date 抓不到」的怪物件（Apps Script
// 已知的 realm 問題）。這裡用三層判斷把它們統一處理掉。
// 2026-09-24 效能調整：原本每一格日期都各呼叫一次 Session.getScriptTimeZone() +
// Utilities.formatDate()（兩個都是服務呼叫，資料一多就很慢）。改成：
//  - 時區每次執行只查一次（wbScriptTz_）
//  - 若 JS 執行環境的時區偏移跟指令碼時區一致（Apps Script V8 正常都是），直接用
//    getFullYear/getMonth/getDate 拼出 yyyy-MM-dd，結果跟 formatDate 完全相同但快很多；
//    偏移不一致（例如本機測試環境）就退回原本的 Utilities.formatDate，保證結果不變。
var WB_TZ_ = null;
var WB_FAST_YMD_ = null;
function wbScriptTz_() {
  if (WB_TZ_ === null) WB_TZ_ = Session.getScriptTimeZone();
  return WB_TZ_;
}
function wbLocalYmd_(d) {
  var m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
}
function wbFastYmdOk_() {
  if (WB_FAST_YMD_ === null) {
    var probe = new Date();
    var z = String(Utilities.formatDate(probe, wbScriptTz_(), "Z")); // 例如 +0800
    var m = /^([+-])(\d{2})(\d{2})$/.exec(z);
    var scriptOffsetMin = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : NaN;
    WB_FAST_YMD_ = isFinite(scriptOffsetMin) && scriptOffsetMin === -probe.getTimezoneOffset();
  }
  return WB_FAST_YMD_;
}
function formatYmd_(d) {
  if (wbFastYmdOk_()) return wbLocalYmd_(d);
  return Utilities.formatDate(d, wbScriptTz_(), "yyyy-MM-dd");
}

function normalizeDate_(v) {
  var looksLikeDate =
    v instanceof Date ||
    Object.prototype.toString.call(v) === "[object Date]";

  if (looksLikeDate) {
    return formatYmd_(v);
  }
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    return v.slice(0, 10);
  }
  // 保底：物件功能上像日期（有 getTime），但前面兩種檢查都沒認出來
  if (v && typeof v === "object" && typeof v.getTime === "function") {
    try {
      return formatYmd_(new Date(v.getTime()));
    } catch (err) {
      return v;
    }
  }
  return v;
}

// 把對照表（junction table）轉成 { 主鍵: [值, 值, ...] } 的 map
function groupJunction_(sheet, idField, valueField) {
  var rows = sheetToObjects_(sheet);
  var map = {};
  rows.forEach(function (r) {
    var id = r[idField];
    if (!map[id]) map[id] = [];
    if (r[valueField]) map[id].push(r[valueField]);
  });
  return map;
}

// ---------------- 課程 ----------------

function getCourses_() { return wbMemo_("courses", getCoursesUncached_); }
function getCoursesUncached_() {
  var courses = sheetToObjects_("課程");
  var catMap = groupJunction_("課程分類對照", "課程ID", "分類");
  courses.forEach(function (c) {
    c["分類"] = catMap[c["課程ID"]] || [];
    // 進度存的是 0~1 的小數（例如 0.43），這裡不轉換，前端顯示時自行 *100
  });
  return courses;
}

function getCourseStats_() {
  var courses = getCourses_();
  var byCategory = {};
  var byPlatform = {};
  var byStatus = {};
  var totalProgress = 0;
  var completedCount = 0;

  function bump(map, key, progress, completed) {
    if (!key) return;
    if (!map[key]) map[key] = { count: 0, progressSum: 0, completed: 0 };
    map[key].count++;
    map[key].progressSum += progress;
    if (completed) map[key].completed++;
  }

  courses.forEach(function (c) {
    var progress = Number(c["進度"]) || 0;
    var isDone = c["狀態"] === "已完成";
    totalProgress += progress;
    if (isDone) completedCount++;

    (c["分類"] || []).forEach(function (cat) {
      bump(byCategory, cat, progress, isDone);
    });
    bump(byPlatform, c["平台"], progress, isDone);
    byStatus[c["狀態"]] = (byStatus[c["狀態"]] || 0) + 1;
  });

  function finalize(map) {
    var out = {};
    Object.keys(map).forEach(function (k) {
      var m = map[k];
      out[k] = {
        count: m.count,
        avgProgressPercent: m.count ? round2_((m.progressSum / m.count) * 100) : 0,
        completed: m.completed
      };
    });
    return out;
  }

  return {
    total: courses.length,
    avgProgressPercent: courses.length ? round2_((totalProgress / courses.length) * 100) : 0,
    completed: completedCount,
    byCategory: finalize(byCategory),
    byPlatform: finalize(byPlatform),
    byStatus: byStatus
  };
}

// ---------------- 訂閱服務 ----------------

function getSubscriptions_() { return wbMemo_("subscriptions", getSubscriptionsUncached_); }
function getSubscriptionsUncached_() {
  var subs = sheetToObjects_("訂閱服務");
  var tagMap = groupJunction_("訂閱標籤對照", "訂閱ID", "分類標籤");
  subs.forEach(function (s) {
    s["分類標籤"] = tagMap[s["訂閱ID"]] || [];
    wbComputeSubscription_(s);
  });
  return subs;
}

// 2026-10-11：K～Q 欄（每月金額、上次／下次付款日、即將付款、累積訂閱日、總計花費、負擔提示）
// 原本直接讀試算表自訂函數算出來的值，但 Google 只有在「參數改變」時才會重算自訂函數，
// 裡面用到的 new Date()（今天）不會每天更新 → 下次付款日會停在最後一次編輯那天。
// 改成每次讀取時用同一套函數（個人工作台-計算函數.gs）以「今天」重新計算；
// 試算表裡的公式保留給直接開試算表看的時候用。任何一列算失敗就沿用試算表原本的值。
function wbParseYmd_(v) {
  if (!v) return null;
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
function wbComputeSubscription_(s) {
  if (typeof MONTHLY_AMOUNT !== "function") return;
  try {
    var cycle = s["訂閱週期"];
    var start = wbParseYmd_(s["訂閱開始日"]);
    var cancel = wbParseYmd_(s["取消訂閱日"]);
    var canceled = s["取消訂閱"] === true;
    var monthly = MONTHLY_AMOUNT(s["訂閱費"], cycle);
    var last = start ? LAST_PAYMENT_DATE(start, cycle) : "";
    var next = start ? NEXT_PAYMENT_DATE(start, cycle, canceled) : "";
    s["每月金額"] = monthly;
    s["上次付款日"] = last ? formatYmd_(new Date(last)) : "";
    s["下次付款日"] = next ? formatYmd_(new Date(next)) : "";
    s["即將付款"] = next ? UPCOMING_PAYMENT(next) : false;
    s["累積訂閱日"] = start ? SUBSCRIBED_DAYS(start, cancel) : "";
    s["總計花費"] = start ? TOTAL_SPENT(s["訂閱費"], cycle, start, cancel) : 0;
    s["訂閱費負擔提示"] = COST_WARNING(monthly);
  } catch (err) {
    // 保留試算表原本的值
  }
}

function getSubscriptionStats_() {
  var subs = getSubscriptions_();
  var active = subs.filter(function (s) { return s["取消訂閱"] !== true; });

  var totalMonthly = 0;
  var byTag = {};
  active.forEach(function (s) {
    var monthly = Number(s["每月金額"]) || 0;
    totalMonthly += monthly;
    (s["分類標籤"] || []).forEach(function (tag) {
      byTag[tag] = round2_((byTag[tag] || 0) + monthly);
    });
  });

  var upcomingPayments = active.filter(function (s) { return s["即將付款"] === true; });
  var costWarnings = active.filter(function (s) { return !!s["訂閱費負擔提示"]; });

  return {
    activeCount: active.length,
    canceledCount: subs.length - active.length,
    totalMonthlySpend: round2_(totalMonthly),
    upcomingPayments: upcomingPayments,
    costWarnings: costWarnings,
    monthlySpendByTag: byTag
  };
}

// ---------------- 任務 ----------------

// 「重複規則」欄位存兩種格式：
//   1. 結構化 JSON 字串（前端「重複」選擇器產生），例如：
//        {"freq":"day","interval":1}                        → 每天
//        {"freq":"week","interval":2,"weekdays":[1,3]}      → 每兩週的週一、週三
//        {"freq":"month","interval":1}                      → 每月（跟原本到期日同一號）
//        {"freq":"month","interval":2,"lastDayOfMonth":true} → 每兩個月的最後一天
//        {"freq":"year","interval":1}                        → 每年
//      另外還可以加一個 "end" 欄位控制重複到什麼時候停止（不加就是一直重複）：
//        {"type":"date","date":"2027-01-01"} → 重複到某個日期為止（超過這天就不再自動產生下一筆）
//        {"type":"count","count":5}          → 只重複產生 N 次（用 "occurrence" 記錄目前是第幾次）
//   2. 一般文字（自訂標籤，例如「牌照稅」）→ 只是記錄用，不會自動產生下一筆。
// weekdays 用 0=週日～6=週六。
function nextDueDate_(dateStr, ruleRaw) { return WbLogic.nextDueDate(dateStr, ruleRaw); } // 邏輯在 shared/logic.js（前後端共用）

// 判斷這次完成後，重複規則的「截止條件」是否已經到了（到了就不再自動產生下一筆）。
// 回傳 { stop: boolean, nextRuleRaw: string } —— nextRuleRaw 是下一筆任務要繼續帶著的重複規則字串
// （次數限制的情況，裡面的 occurrence 會 +1；沒有截止條件或用日期限制的情況，規則字串原封不動）。
function applyRepeatEnd_(rule, ruleRaw, nextDueStr) { return WbLogic.applyRepeatEnd(rule, ruleRaw, nextDueStr); }

// 把「重複規則」欄位解析成結構化物件；不是看得懂的 JSON 就回傳 null（代表自訂文字，不自動產生下一筆）
function parseRepeatRule_(raw) { return WbLogic.parseRepeatRule(raw); }

// 某日期所在那一週的週日（當地時間，時分秒歸零）
function startOfWeek_(date) { return WbLogic.startOfWeek(date); }

// 把「子任務」分頁（任務ID、內容、完成）轉成 { 任務ID: [{內容,完成}, ...] }
// 排列順序就是試算表裡的列順序，因為每次儲存都是整批刪除再依照
// 使用者畫面上的順序重新寫入，不需要額外的排序欄位。
function groupSubtasks_(sheet) {
  var rows = sheetToObjects_(sheet);
  var map = {};
  rows.forEach(function (r) {
    var id = r["任務ID"];
    if (!map[id]) map[id] = [];
    map[id].push({ "內容": r["內容"] || "", "完成": r["完成"] === true });
  });
  return map;
}

function subtaskRows_(id, subtasks) {
  var rows = [];
  (subtasks || []).forEach(function (st) {
    var content = ((st && st["內容"]) || "").toString().trim();
    if (content) rows.push([id, content, st["完成"] === true]);
  });
  return rows;
}
function appendSubtaskRows_(sheet, id, subtasks) { wbAppendRows_(sheet, subtaskRows_(id, subtasks)); }
function replaceSubtaskRows_(sheet, id, subtasks) { wbReplaceRowsById_(sheet, id, subtaskRows_(id, subtasks)); }

function getTasks_() { return wbMemo_("tasks", getTasksUncached_); }
function getTasksUncached_() {
  var tasks = sheetToObjects_("任務");
  var catMap = groupJunction_("任務分類對照", "任務ID", "分類");
  var subMap = groupSubtasks_("子任務");
  tasks.forEach(function (t) {
    t["分類"] = catMap[t["任務ID"]] || [];
    t["子任務"] = subMap[t["任務ID"]] || [];
  });
  return tasks;
}

function getTaskStats_() {
  var now = new Date();
  var soon = new Date(now.getTime());
  soon.setDate(soon.getDate() + 3);
  return WbLogic.taskStats(getTasks_(), formatYmd_(now), formatYmd_(soon)); // 規則在 shared/logic.js（前端樂觀更新用同一套）
}

function createTask_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("任務");
  var id = nextId_(sheet, "T");
  var now = new Date();
  sheet.appendRow(wbSafeRow_([
    id,
    wbText_(p["任務名稱"]),
    p["優先順序"] || "",
    p["狀態"] || "",
    p["到期日"] || "",
    p["星標"] === true,
    p["重複規則"] || "",
    wbText_(p["備註"]),
    now,                   // I 建立時間
    now,                   // J 更新時間
    p["所屬專案"] || ""     // K 所屬專案（存專案ID，可留空）
  ]));
  appendJunctionRows_(ss.getSheetByName("任務分類對照"), id, p["分類"]);
  appendSubtaskRows_(ss.getSheetByName("子任務"), id, p["子任務"]);
  return { success: true, id: id };
}

function updateTask_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("任務");
  var id = p["任務ID"];
  if (!id) throw new Error("缺少任務ID");
  var row = findRowByIdText_(sheet, id);
  if (row === -1) throw new Error("找不到任務：" + id);

  var existing = sheet.getRange(row, 1, 1, 11).getValues()[0]; // A-K
  var previousStatus = existing[3]; // D欄：狀態（修改前的值）
  var createdAt = existing[8]; // I欄：建立時間，保留原值（之前這裡曾被誤寫成 now，已修正）
  var newStatus = p["狀態"] || "";
  var now = new Date();

  sheet.getRange(row, 2, 1, 10).setValues([wbSafeRow_([
    wbText_(p["任務名稱"]),
    p["優先順序"] || "",
    newStatus,
    p["到期日"] || "",
    p["星標"] === true,
    p["重複規則"] || "",
    wbText_(p["備註"]),
    createdAt,            // I 建立時間：保留
    now,                  // J 更新時間：這次才是真的更新時間
    p["所屬專案"] || ""     // K 所屬專案
  ])]);
  replaceJunctionRows_(ss.getSheetByName("任務分類對照"), id, p["分類"]);
  replaceSubtaskRows_(ss.getSheetByName("子任務"), id, p["子任務"]);

  // 剛從「非已完成」改成「已完成」，且設定了看得懂的重複規則（每天/每週/每月/每年）時，
  // 自動產生下一筆任務（狀態重設為待辦、到期日往後推、子任務全部重設成未完成）。
  // 如果重複規則有設定截止條件（到某個日期為止／只重複 N 次），到了就不再產生下一筆。
  var nextTaskCreated = false;
  if (newStatus === "已完成" && previousStatus !== "已完成" && p["重複規則"]) {
    nextTaskCreated = createNextOccurrence_(p, p["重複規則"], p["到期日"]);
  }

  return { success: true, id: id, nextTaskCreated: nextTaskCreated };
}

// 產生「這個重複任務的下一輪」：算出下一個到期日、確認還沒到截止條件（到某個
// 日期為止／只重複N次），是的話就用同樣的內容（名稱/優先順序/星標/分類/
// 所屬專案/子任務——子任務全部重設成未完成）新增一筆待辦任務。
// updateTask_（標記完成時）跟 skipTask_（跳過本次時）共用同一套邏輯，
// 差別只在「這一筆本身」最後被標成「已完成」還是「已跳過」。
function createNextOccurrence_(base, repeatRuleRaw, dueDate) {
  if (!repeatRuleRaw) return false;
  var nextDue = nextDueDate_(dueDate, repeatRuleRaw);
  if (!nextDue) return false;
  var rule = parseRepeatRule_(repeatRuleRaw);
  var endCheck = applyRepeatEnd_(rule, repeatRuleRaw, nextDue);
  if (endCheck.stop) return false;
  // 防止重複產生：打勾 → 取消 → 再打勾時，下一輪那筆已經存在了，就不要再產生一次
  var name = base["任務名稱"] || "";
  var pid = base["所屬專案"] || "";
  var dup = sheetToObjects_("任務").some(function (t) {
    return (t["任務名稱"] || "") === name && t["到期日"] === nextDue && (t["所屬專案"] || "") === pid &&
      t["狀態"] !== "已取消";
  });
  if (dup) return false;
  var nextSubtasks = (base["子任務"] || []).map(function (st) {
    return { "內容": st["內容"], "完成": false };
  });
  createTask_({
    "任務名稱": base["任務名稱"] || "",
    "優先順序": base["優先順序"] || "",
    "狀態": "待辦",
    "到期日": nextDue,
    "星標": base["星標"] === true,
    "重複規則": endCheck.nextRuleRaw || "",
    "備註": base["備註"] || "",
    "分類": base["分類"] || [],
    "所屬專案": base["所屬專案"] || "",
    "子任務": nextSubtasks
  });
  return true;
}

// 跳過這一次：不算完成，但還是照重複規則往後推一筆下一輪的待辦任務——
// 用在「這次剛好不用做／來不及做，但下一輪還是要繼續」的情況，跟「已取消」
// 那種整個系列都不要了的意思不一樣。只有看得懂的重複規則（每天/每週/每月/每年）
// 才能跳過；自訂文字標籤本來就不會自動延續，沒有「下一輪」可以跳過去。
function skipTask_(p) {
  var id = p["任務ID"];
  if (!id) throw new Error("缺少任務ID");
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("任務");
  var row = findRowByIdText_(sheet, id);
  if (row === -1) throw new Error("找不到任務：" + id);

  var existing = sheet.getRange(row, 1, 1, 11).getValues()[0]; // A~K
  var repeatRuleRaw = existing[6]; // G欄：重複規則
  var dueDate = normalizeDate_(existing[4]); // E欄：到期日
  if (!parseRepeatRule_(repeatRuleRaw)) {
    throw new Error("這筆任務沒有看得懂的重複規則（自訂文字標籤不會自動產生下一筆），沒辦法跳過本次");
  }

  var catMap = groupJunction_(ss.getSheetByName("任務分類對照"), "任務ID", "分類");
  var subMap = groupSubtasks_(ss.getSheetByName("子任務"));
  var nextTaskCreated = createNextOccurrence_({
    "任務名稱": existing[1],
    "優先順序": existing[2],
    "星標": existing[5],
    "備註": existing[7],
    "分類": catMap[id] || [],
    "所屬專案": existing[10],
    "子任務": subMap[id] || []
  }, repeatRuleRaw, dueDate);

  sheet.getRange(row, 4).setValue("已跳過");    // D欄：狀態
  sheet.getRange(row, 10).setValue(new Date()); // J欄：更新時間
  return { success: true, id: id, nextTaskCreated: nextTaskCreated };
}

// 只改狀態（任務清單打勾／取消打勾用）：不帶整筆任務過來，避免用某台裝置的舊資料
// 蓋掉另一台裝置剛改過的名稱、備註、子任務、分類。
// 從「非已完成」改成「已完成」且有重複規則時，跟 updateTask_ 一樣自動產生下一輪。
function setTaskStatus_(p) {
  var id = p["任務ID"];
  if (!id) throw new Error("缺少任務ID");
  var newStatus = p["狀態"] || "";
  if (!newStatus) throw new Error("缺少狀態");
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("任務");
  var row = findRowByIdText_(sheet, id);
  if (row === -1) throw new Error("找不到任務：" + id);
  var existing = sheet.getRange(row, 1, 1, 11).getValues()[0]; // A~K
  var previousStatus = existing[3];
  sheet.getRange(row, 4).setValue(newStatus);   // D欄：狀態
  sheet.getRange(row, 10).setValue(new Date()); // J欄：更新時間
  var nextTaskCreated = false;
  var repeatRuleRaw = existing[6];
  if (newStatus === "已完成" && previousStatus !== "已完成" && repeatRuleRaw) {
    var catMap = groupJunction_(ss.getSheetByName("任務分類對照"), "任務ID", "分類");
    var subMap = groupSubtasks_(ss.getSheetByName("子任務"));
    nextTaskCreated = createNextOccurrence_({
      "任務名稱": existing[1],
      "優先順序": existing[2],
      "星標": existing[5],
      "備註": existing[7],
      "分類": catMap[id] || [],
      "所屬專案": existing[10],
      "子任務": subMap[id] || []
    }, repeatRuleRaw, normalizeDate_(existing[4]));
  }
  return { success: true, id: id, nextTaskCreated: nextTaskCreated };
}

function deleteTask_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var id = p["任務ID"];
  if (!id) throw new Error("缺少任務ID");
  deleteRowsWhereIdEquals_(ss.getSheetByName("任務"), id);
  deleteRowsWhereIdEquals_(ss.getSheetByName("任務分類對照"), id);
  deleteRowsWhereIdEquals_(ss.getSheetByName("子任務"), id);
  return { success: true, id: id };
}

// ---------------- 專案 ----------------
// 「專案」是比「任務」高一層的容器，有自己的期間（開始日～結束日），
// 底下可以掛很多筆「任務」（任務用「所屬專案」欄位存專案ID，一個任務最多屬於一個專案）。
// 跟「子任務」不一樣：子任務是單一任務底下的小勾選清單，專案底下掛的是完整的任務。
// 對應「專案」分頁欄位：A專案ID B專案名稱 C開始日 D結束日 E狀態 F優先級 G備註 H建立時間 I更新時間

function getProjects_() { return wbMemo_("projects", getProjectsUncached_); }
function getProjectsUncached_() {
  var projects = sheetToObjects_("專案");
  var tasks = getTasks_();
  var statsMap = {};
  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  tasks.forEach(function (t) {
    var pid = t["所屬專案"];
    if (!pid) return;
    if (!statsMap[pid]) statsMap[pid] = { taskCount: 0, completedCount: 0, overdueCount: 0 };
    var s = statsMap[pid];
    s.taskCount++;
    var isDone = t["狀態"] === "已完成";
    var isClosed = t["狀態"] === "已取消" || t["狀態"] === "已跳過";
    if (isDone) s.completedCount++;
    if (t["到期日"] && !isDone && !isClosed && t["到期日"] < todayStr) s.overdueCount++;
  });
  projects.forEach(function (proj) {
    var s = statsMap[proj["專案ID"]] || { taskCount: 0, completedCount: 0, overdueCount: 0 };
    proj["任務數"] = s.taskCount;
    proj["已完成數"] = s.completedCount;
    proj["逾期數"] = s.overdueCount;
    proj["完成度Percent"] = s.taskCount ? round2_((s.completedCount / s.taskCount) * 100) : 0;
  });
  return projects;
}

function getProjectStats_() {
  var projects = getProjects_();
  var byStatus = {};
  projects.forEach(function (p) {
    byStatus[p["狀態"]] = (byStatus[p["狀態"]] || 0) + 1;
  });
  return {
    total: projects.length,
    byStatus: byStatus
  };
}

function createProject_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("專案");
  var id = nextId_(sheet, "PJ");
  var now = new Date();
  sheet.appendRow(wbSafeRow_([
    id,
    wbText_(p["專案名稱"]),
    p["開始日"] || "",
    p["結束日"] || "",
    p["狀態"] || "",
    p["優先級"] || "",
    wbText_(p["備註"]),
    now,
    now
  ]));
  return { success: true, id: id };
}

function updateProject_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("專案");
  var id = p["專案ID"];
  if (!id) throw new Error("缺少專案ID");
  var row = findRowByIdText_(sheet, id);
  if (row === -1) throw new Error("找不到專案：" + id);
  var existing = sheet.getRange(row, 1, 1, 9).getValues()[0];
  var now = new Date();
  sheet.getRange(row, 2, 1, 8).setValues([wbSafeRow_([
    wbText_(p["專案名稱"]),
    p["開始日"] || "",
    p["結束日"] || "",
    p["狀態"] || "",
    p["優先級"] || "",
    wbText_(p["備註"]),
    existing[7], // 建立時間：保留
    now          // 更新時間
  ])]);
  return { success: true, id: id };
}

function deleteProject_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var id = p["專案ID"];
  if (!id) throw new Error("缺少專案ID");
  deleteRowsWhereIdEquals_(ss.getSheetByName("專案"), id);
  clearTaskProjectRef_(ss.getSheetByName("任務"), id);
  return { success: true, id: id };
}

// 專案被刪除時，把原本掛在這個專案底下的任務「所屬專案」欄位清空，
// 任務本身不會被刪掉，只是變回「沒有專案」的狀態。
function clearTaskProjectRef_(taskSheet, projectId) {
  var data = taskSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][10] === projectId) { // K欄：所屬專案
      taskSheet.getRange(i + 1, 11).setValue("");
    }
  }
}

// ---------------- 習慣追蹤 ----------------
// 「習慣」分頁存習慣本身的設定（名稱/類型/頻率規則...），
// 「習慣打卡紀錄」分頁存「哪個習慣、哪一天、打了多少」的紀錄——
// 這張是「日誌表」，只有真的有打卡的那天才會有一列，沒打卡的日子不會佔資料。
// 這跟課程/訂閱/任務/專案那種「一筆資料對一筆資料」的結構不一樣，
// 因為同一個習慣本來就會每天重複產生新的紀錄。

// yyyy-MM-dd 字串 <-> Date 物件的轉換小工具（習慣的連續天數/完成率計算要逐日比較，
// 直接用字串比較容易在跨月/跨年時出錯，所以都先轉成 Date 物件再算）
function parseDateStr_(s) {
  var parts = String(s).split("-");
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}
function formatDateStr_(d) {
  return formatYmd_(d); // 走本地 getter 的快速路徑（連續天數計算每天都會呼叫，避免每次跨服務呼叫）
}

// 「星期幾」欄位存的是 JSON 字串（例如 "[1,3,5]"），這裡轉回陣列給計算邏輯用
function parseWeekdaysField_(raw) {
  if (!raw) return [];
  try {
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(Number) : [];
  } catch (e) {
    return [];
  }
}

// 判斷某一天是不是這個習慣「該做」的日子（只適用 daily／weekday 兩種頻率）：
// 頻率類型="daily" → 每天都算；頻率類型="weekday" → 只有星期幾清單裡的那幾天算
// （星期幾用 0=週日～6=週六，跟任務重複規則的星期編碼一致）
function isRequiredDay_(habit, dateStr) { return WbLogic.isRequiredDay(habit, dateStr); } // shared/logic.js

// 「今天算不算這個習慣該做的一天」——daily/weekday 沿用 isRequiredDay_；
// weeklyCount（每週N次，不指定星期幾）則是「這週的次數還沒集滿」就算今天還該做，
// 一旦這週已經達標，接下來幾天就不會再被提醒。
function isDueToday_(habit, dateStr, logMap) {
  if (habit["頻率類型"] === "weeklyCount") {
    var weekStart = startOfWeek_(parseDateStr_(dateStr));
    var target = Number(habit["每週次數"]) || 1;
    return countDoneDaysInWeek_(habit, logMap, weekStart) < target;
  }
  return isRequiredDay_(habit, dateStr);
}

// 判斷某一天算不算「完成」：
// 打勾型只要有紀錄（數值>=1）就算；
// 計數型如果有開三級制，「基礎」以上就算完成（達標/超標當然也算，基礎是最低門檻）；
// 計數型沒開三級制，維持原本邏輯：數值要達到目標值才算完成。
function isHabitDoneForDay_(habit, value) { return WbLogic.isHabitDoneForDay(habit, value); } // shared/logic.js

// 算某一天達到「基礎／達標／超標」哪一級（只有計數型 + 有開三級制才會回傳非 null）。
// 給前端顯示用的徽章，不影響「今日已完成」的判斷（那個固定認基礎以上）。
function habitTierForValue_(habit, value) { return WbLogic.habitTierForValue(habit, value); } // shared/logic.js

function getHabitLogs_() {
  return sheetToObjects_("習慣打卡紀錄");
}

// 算某一週（從 weekStart 這天算起的 7 天）裡，這個習慣「完成」了幾天——
// weeklyCount 頻率的習慣是拿這個數字跟「每週次數」比，跟指定星期幾完全無關，哪幾天做都可以。
function countDoneDaysInWeek_(habit, logMap, weekStart) {
  var count = 0;
  for (var i = 0; i < 7; i++) {
    var d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    if (isHabitDoneForDay_(habit, logMap[formatDateStr_(d)] || 0)) count++;
  }
  return count;
}

// daily／weekday 頻率的連續天數/完成率計算。
// 連續天數只看「這個習慣該做的那幾天」，不算的日子（例如週二對一個只在一三五要做的習慣）
// 不會打斷連續紀錄；今天如果還沒打卡，也不會直接判定斷掉（今天還沒過完）。
function computeDailyStreak_(habit, logMap, todayStr) {
  var today = parseDateStr_(todayStr);

  var currentStreak = 0;
  var d = new Date(today);
  var safetyLimit = 3 * 365; // 最多往回找3年，避免資料異常時無窮迴圈
  for (var guard = 0; guard < safetyLimit; guard++) {
    var ds = formatDateStr_(d);
    if (isRequiredDay_(habit, ds)) {
      var done = isHabitDoneForDay_(habit, logMap[ds] || 0);
      if (ds === todayStr && !done) {
        // 今天還沒打卡：先跳過，不算破功也不算連續，繼續往前一天看
      } else if (done) {
        currentStreak++;
      } else {
        break;
      }
    }
    d.setDate(d.getDate() - 1);
  }

  var dates = Object.keys(logMap);
  var longestStreak = currentStreak;
  if (dates.length) {
    var minDate = dates.reduce(function (a, b) { return a < b ? a : b; });
    var cursor = parseDateStr_(minDate);
    var running = 0;
    while (cursor.getTime() <= today.getTime()) {
      var cs = formatDateStr_(cursor);
      if (isRequiredDay_(habit, cs)) {
        if (isHabitDoneForDay_(habit, logMap[cs] || 0)) {
          running++;
          if (running > longestStreak) longestStreak = running;
        } else if (cs !== todayStr) {
          running = 0;
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  function rateInWindow(days) {
    var required = 0, doneCount = 0;
    var dd = new Date(today);
    for (var i = 0; i < days; i++) {
      var dsw = formatDateStr_(dd);
      if (isRequiredDay_(habit, dsw)) {
        required++;
        if (isHabitDoneForDay_(habit, logMap[dsw] || 0)) doneCount++;
      }
      dd.setDate(dd.getDate() - 1);
    }
    return required ? round2_((doneCount / required) * 100) : 0;
  }

  return {
    currentStreak: currentStreak,
    longestStreak: longestStreak,
    rate7: rateInWindow(7),
    rate30: rateInWindow(30)
  };
}

// weeklyCount 頻率（每週N次，不指定星期幾）的連續「週數」/完成率計算。
// 邏輯跟 computeDailyStreak_ 是同一套精神，只是把「天」換成「週」：
// 本週還沒結束、次數還沒集滿，不算破功也不算連續；已經結束的週沒集滿次數，連續中斷。
function computeWeeklyStreak_(habit, logMap, todayStr) {
  var today = parseDateStr_(todayStr);
  var target = Number(habit["每週次數"]) || 1;
  var thisWeekStart = startOfWeek_(today);

  var currentStreak = 0;
  var wStart = new Date(thisWeekStart);
  var isThisWeek = true;
  var safetyLimit = 260; // 最多往回抓5年份的週數，避免資料異常時無窮迴圈
  for (var guard = 0; guard < safetyLimit; guard++) {
    var met = countDoneDaysInWeek_(habit, logMap, wStart) >= target;
    if (isThisWeek && !met) {
      // 本週還沒結束，次數還沒集滿先不算破功也不算連續
    } else if (met) {
      currentStreak++;
    } else {
      break;
    }
    isThisWeek = false;
    wStart.setDate(wStart.getDate() - 7);
  }

  var dates = Object.keys(logMap);
  var longestStreak = currentStreak;
  if (dates.length) {
    var minDate = dates.reduce(function (a, b) { return a < b ? a : b; });
    var cursor = startOfWeek_(parseDateStr_(minDate));
    var running = 0;
    while (cursor.getTime() <= thisWeekStart.getTime()) {
      var isCurrentWeek = cursor.getTime() === thisWeekStart.getTime();
      var met2 = countDoneDaysInWeek_(habit, logMap, cursor) >= target;
      if (met2) {
        running++;
        if (running > longestStreak) longestStreak = running;
      } else if (!isCurrentWeek) {
        running = 0;
      }
      cursor.setDate(cursor.getDate() + 7);
    }
  }

  // 完成率改成「這段期間內，完成天數 ÷ 依每週次數換算出來的期望天數」，上限100%，
  // 概念上等於「這段時間你達成了目標的幾成」
  function rateForDays(days) {
    var doneCount = 0;
    var dd = new Date(today);
    for (var i = 0; i < days; i++) {
      if (isHabitDoneForDay_(habit, logMap[formatDateStr_(dd)] || 0)) doneCount++;
      dd.setDate(dd.getDate() - 1);
    }
    var expected = target * (days / 7);
    return expected ? Math.min(100, round2_((doneCount / expected) * 100)) : 0;
  }

  return {
    currentStreak: currentStreak,
    longestStreak: longestStreak,
    rate7: rateForDays(7),
    rate30: rateForDays(30)
  };
}

function getHabits_() { return wbMemo_("habits", getHabitsUncached_); }
function getHabitsUncached_() {
  var habits = sheetToObjects_("習慣");
  var logs = getHabitLogs_();
  var logsByHabit = {};
  logs.forEach(function (l) {
    var hid = l["習慣ID"];
    if (!logsByHabit[hid]) logsByHabit[hid] = {};
    logsByHabit[hid][l["日期"]] = Number(l["數值"]) || 0;
  });
  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  // 前端熱力圖用：近一年（371 天，剛好涵蓋 53 週的格子）有打卡的日子 { 'yyyy-MM-dd': 數值 }
  var histFromDate = parseDateStr_(todayStr);
  histFromDate.setDate(histFromDate.getDate() - 371);
  var histFrom = formatDateStr_(histFromDate);

  habits.forEach(function (h) {
    h["星期幾"] = parseWeekdaysField_(h["星期幾"]);
    h["時段"] = h["時段"] || "不限"; // 舊資料還沒補這欄、或忘了填的話，一律當「不限」
    var logMap = logsByHabit[h["習慣ID"]] || {};
    var stats = h["頻率類型"] === "weeklyCount"
      ? computeWeeklyStreak_(h, logMap, todayStr)
      : computeDailyStreak_(h, logMap, todayStr);
    h["今日數值"] = logMap[todayStr] || 0;
    h["今日應做"] = isDueToday_(h, todayStr, logMap);
    h["今日已完成"] = isHabitDoneForDay_(h, h["今日數值"]);
    h["今日等級"] = habitTierForValue_(h, h["今日數值"]);
    h["連續天數"] = stats.currentStreak;
    h["最長連續"] = stats.longestStreak;
    h["近7天完成率"] = stats.rate7;
    h["近30天完成率"] = stats.rate30;
    var hist = {};
    Object.keys(logMap).forEach(function (ds) { if (ds >= histFrom && ds <= todayStr) hist[ds] = logMap[ds]; });
    h["打卡紀錄"] = hist;
  });
  return habits;
}

function getHabitStats_() {
  var habits = getHabits_();
  var active = habits.filter(function (h) { return h["狀態"] !== "封存"; });
  var dueToday = active.filter(function (h) { return h["今日應做"]; });
  var doneToday = dueToday.filter(function (h) { return h["今日已完成"]; });
  var avgRate7 = active.length
    ? round2_(active.reduce(function (s, h) { return s + (h["近7天完成率"] || 0); }, 0) / active.length)
    : 0;
  return {
    total: active.length,
    dueTodayCount: dueToday.length,
    doneTodayCount: doneToday.length,
    avgRate7: avgRate7
  };
}

function createHabit_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("習慣");
  var id = nextId_(sheet, "H");
  var now = new Date();
  var tiered = p["啟用分級"] === true;
  sheet.appendRow(wbSafeRow_([
    id,
    wbText_(p["習慣名稱"]),
    p["類型"] || "打勾",
    p["目標值"] || "",
    wbText_(p["單位"]),
    p["分類"] || "",
    p["頻率類型"] || "daily",
    p["頻率類型"] === "weekday" ? JSON.stringify(p["星期幾"] || []) : "",
    p["頻率類型"] === "weeklyCount" ? (p["每週次數"] || "") : "",
    tiered,
    tiered ? (p["基礎值"] || "") : "",
    tiered ? (p["超標值"] || "") : "",
    p["狀態"] || "啟用",
    now,
    now,
    p["時段"] || "不限" // P欄：時段（早上／中午／晚上／不限），給「今日待辦」分組排序用
  ]));
  return { success: true, id: id };
}

function updateHabit_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("習慣");
  var id = p["習慣ID"];
  if (!id) throw new Error("缺少習慣ID");
  var row = findRowByIdText_(sheet, id);
  if (row === -1) throw new Error("找不到習慣：" + id);
  var existing = sheet.getRange(row, 1, 1, 16).getValues()[0];
  var now = new Date();
  var tiered = p["啟用分級"] === true;
  sheet.getRange(row, 2, 1, 15).setValues([wbSafeRow_([
    wbText_(p["習慣名稱"]),
    p["類型"] || "打勾",
    p["目標值"] || "",
    wbText_(p["單位"]),
    p["分類"] || "",
    p["頻率類型"] || "daily",
    p["頻率類型"] === "weekday" ? JSON.stringify(p["星期幾"] || []) : "",
    p["頻率類型"] === "weeklyCount" ? (p["每週次數"] || "") : "",
    tiered,
    tiered ? (p["基礎值"] || "") : "",
    tiered ? (p["超標值"] || "") : "",
    p["狀態"] || "啟用",
    existing[13], // N欄：建立時間，保留原值
    now,          // O欄：更新時間
    p["時段"] || "不限" // P欄：時段
  ])]);
  return { success: true, id: id };
}

function deleteHabit_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var id = p["習慣ID"];
  if (!id) throw new Error("缺少習慣ID");
  deleteRowsWhereIdEquals_(ss.getSheetByName("習慣"), id);
  deleteHabitLogsForHabit_(ss.getSheetByName("習慣打卡紀錄"), id);
  return { success: true, id: id };
}

// 習慣被刪除時，連同底下所有打卡紀錄一起清掉（打卡紀錄的 A 欄是紀錄自己的ID，
// 習慣ID存在 B 欄，所以不能用 deleteRowsWhereIdEquals_，要另外用 B 欄比對）
function deleteHabitLogsForHabit_(logSheet, habitId) {
  var data = logSheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][1] === habitId) logSheet.deleteRow(i + 1);
  }
}

// 新增／更新／取消 一天的打卡紀錄。
// payload 沒帶「數值」（null/undefined/空字串）代表「取消打卡」，把那天的紀錄整列刪掉；
// 有帶數值就新增一列，或者更新已經存在的那一列——打勾型永遠傳 1，計數型傳實際數字。
// 這個函數是「先讀（有沒有今天的紀錄）→ 再決定要新增還是更新」，如果短時間內
// 連續打進來兩次請求（例如數字輸入框的上下箭頭連續點好幾下、或網路延遲讓使用者
// 又點了一次），有可能兩次都在「還沒寫入」的空檔讀到「今天還沒有紀錄」，結果兩次
// 都變成新增，同一天就出現兩列重複紀錄——用 LockService 把整段「讀→寫」鎖起來，
// 同一時間只會有一個請求在處理，後面的請求會等前一個寫完再讀，就不會再重複。
function setHabitLog_(p) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000); // 最多等10秒，避免真的卡住時整個請求無限期掛著
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("習慣打卡紀錄");
    var habitId = p["習慣ID"];
    if (!habitId) throw new Error("缺少習慣ID");
    var dateStr = p["日期"] || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");

    var data = sheet.getDataRange().getValues();
    var foundRow = -1;
    for (var i = 1; i < data.length; i++) {
      if (data[i][1] === habitId && normalizeDate_(data[i][2]) === dateStr) { foundRow = i + 1; break; }
    }

    var hasValue = p["數值"] !== null && p["數值"] !== undefined && p["數值"] !== "";
    if (!hasValue) {
      if (foundRow !== -1) sheet.deleteRow(foundRow);
      return { success: true };
    }

    var value = Number(p["數值"]) || 0;
    if (foundRow !== -1) {
      sheet.getRange(foundRow, 3, 1, 2).setValues([wbSafeRow_([dateStr, value])]); // C日期 D數值（保留原本的紀錄ID跟建立時間）
    } else {
      var id = nextId_(sheet, "HL");
      sheet.appendRow(wbSafeRow_([id, habitId, dateStr, value, new Date()]));
    }
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------------- 日記 ----------------
// 「日記」分頁一天一列（用「日期」當自然的唯一鍵，不是使用者自己選的），
// 「日記發現清單」存「今天發現的有趣東西」，一篇日記可以有好幾筆，結構跟
// 任務的「子任務」一樣：不另外存自己的ID，A欄直接是日記ID，整批刪除再整批
// 重新寫入，不用逐筆比對誰改了誰沒改。
// 發現清單的「類型」是固定的六選一（文章/Podcast/書/YouTube影片/實體物品/課題/其他），
// 不像其他模組的分類選項是「設定」分頁可以自訂的，所以不用登記進 CASCADE_TARGETS_。
// 「狀態」欄記錄這則發現有沒有整理過：空字串＝待整理（預設）、"已整理"、"不需整理"。

function groupDiaryFinds_(sheet) {
  var rows = sheetToObjects_(sheet);
  var map = {};
  rows.forEach(function (r) {
    var id = r["日記ID"];
    if (!map[id]) map[id] = [];
    map[id].push({ "類型": r["類型"] || "", "內容": r["內容"] || "", "備註": r["備註"] || "", "狀態": r["狀態"] || "" });
  });
  return map;
}

function diaryFindRows_(id, finds) {
  var rows = [];
  (finds || []).forEach(function (f) {
    var content = ((f && f["內容"]) || "").toString().trim();
    if (content) rows.push([id, f["類型"] || "", content, f["備註"] || "", f["狀態"] || ""]);
  });
  return rows;
}
function appendDiaryFindRows_(sheet, id, finds) { wbAppendRows_(sheet, diaryFindRows_(id, finds)); }
function replaceDiaryFindRows_(sheet, id, finds) { wbReplaceRowsById_(sheet, id, diaryFindRows_(id, finds)); }

function getDiaries_() { return wbMemo_("diaries", getDiariesUncached_); }
function getDiariesUncached_() {
  var diaries = sheetToObjects_("日記");
  var findMap = groupDiaryFinds_("日記發現清單");
  diaries.forEach(function (d) {
    d["發現清單"] = findMap[d["日記ID"]] || [];
  });
  diaries.sort(function (a, b) { return (b["日期"] || "").localeCompare(a["日期"] || ""); });
  return diaries;
}

function getDiaryStats_() {
  var diaries = getDiaries_();
  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  var dateSet = {};
  diaries.forEach(function (d) { dateSet[d["日期"]] = true; });
  var hasToday = !!dateSet[todayStr];

  // 連續寫日記天數：從今天（如果今天還沒寫，就從昨天）開始往回數，
  // 中間只要斷一天就停止，是最單純的「有寫/沒寫」連續天數，跟習慣那套分級邏輯無關。
  var streak = 0;
  var cursor = parseDateStr_(todayStr);
  if (!hasToday) cursor.setDate(cursor.getDate() - 1);
  var safetyLimit = 3 * 365;
  for (var guard = 0; guard < safetyLimit; guard++) {
    if (!dateSet[formatDateStr_(cursor)]) break;
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  return {
    total: diaries.length,
    hasToday: hasToday,
    streak: streak
  };
}

// 找出「日記」分頁裡某個日期對應的列號（找不到回傳 -1），給新增時的 upsert 邏輯用
function findDiaryRowByDate_(sheet, dateStr) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (normalizeDate_(data[i][1]) === dateStr) return i + 1;
  }
  return -1;
}

// 新增日記：一天只能一篇，如果這天已經寫過了就直接改成更新那一篇，不會生出
// 同一天兩篇的重複日記。跟習慣打卡紀錄同樣的道理，這裡也用 LockService 鎖住，
// 避免連續快速送出時，兩個請求都讀到「今天還沒寫」而各自新增一篇出來。
function createDiary_(p) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("日記");
    var dateStr = p["日期"] || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
    var row = findDiaryRowByDate_(sheet, dateStr);
    var now = new Date();

    if (row !== -1) {
      var id = sheet.getRange(row, 1).getValue();
      var createdAt = sheet.getRange(row, 8).getValue();
      sheet.getRange(row, 2, 1, 8).setValues([wbSafeRow_([
        dateStr, p["心情"] || "", wbText_(p["感恩"]), wbText_(p["放手"]),
        wbText_(p["今日重要事項"]), wbText_(p["小故事"]), createdAt, now
      ])]);
      replaceDiaryFindRows_(ss.getSheetByName("日記發現清單"), id, p["發現清單"]);
      return { success: true, id: id };
    }

    var newId = nextId_(sheet, "J");
    sheet.appendRow(wbSafeRow_([
      newId, dateStr, p["心情"] || "", wbText_(p["感恩"]), wbText_(p["放手"]),
      wbText_(p["今日重要事項"]), wbText_(p["小故事"]), now, now
    ]));
    replaceDiaryFindRows_(ss.getSheetByName("日記發現清單"), newId, p["發現清單"]);
    return { success: true, id: newId };
  } finally {
    lock.releaseLock();
  }
}

function updateDiary_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("日記");
  var id = p["日記ID"];
  if (!id) throw new Error("缺少日記ID");
  var row = findRowByIdText_(sheet, id);
  if (row === -1) throw new Error("找不到日記：" + id);
  var existing = sheet.getRange(row, 1, 1, 9).getValues()[0];
  var dateStr = p["日期"] || existing[1];
  var now = new Date();
  sheet.getRange(row, 2, 1, 8).setValues([wbSafeRow_([
    dateStr, p["心情"] || "", wbText_(p["感恩"]), wbText_(p["放手"]),
    wbText_(p["今日重要事項"]), wbText_(p["小故事"]), existing[7], now
  ])]);
  replaceDiaryFindRows_(ss.getSheetByName("日記發現清單"), id, p["發現清單"]);
  return { success: true, id: id };
}

function deleteDiary_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var id = p["日記ID"];
  if (!id) throw new Error("缺少日記ID");
  deleteRowsWhereIdEquals_(ss.getSheetByName("日記"), id);
  deleteRowsWhereIdEquals_(ss.getSheetByName("日記發現清單"), id);
  return { success: true, id: id };
}

// ---------------- 設定（下拉選項） ----------------

// 把「設定」分頁每一欄轉成 { 欄名: [選項, 選項, ...] }，給前端的新增/編輯表單用
function getOptions_() {
  var data = wbSheetValues_("設定");
  var headers = data[0];
  var result = {};
  headers.forEach(function (h, colIdx) {
    var values = [];
    for (var r = 1; r < data.length; r++) {
      var v = data[r][colIdx];
      if (v !== "" && v !== null && v !== undefined) values.push(v);
    }
    result[h] = values;
  });
  return result;
}

// ---------------- 新增／編輯／刪除共用工具 ----------------

// 依前綴（"C"／"S"／"T"）找出目前最大的編號，產生下一個 ID（例如 C0218、T0001）
function nextId_(sheet, prefix) {
  var data = sheet.getDataRange().getValues();
  var max = 0;
  for (var i = 1; i < data.length; i++) {
    var id = data[i][0];
    if (typeof id === "string" && id.indexOf(prefix) === 0) {
      var n = parseInt(id.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  // 2026-10-11：只看「表裡目前最大的 ID」的話，刪掉最新一筆後那個 ID 會被下一筆重用——
  // 別台裝置如果還拿著舊資料去改那個 ID，就會改到另一筆。所以另外把「發過的最大號碼」記在指令碼屬性，
  // 號碼只會往上加。（呼叫端都在 LockService 鎖裡，不會兩個請求拿到同一號）
  var props = PropertiesService.getScriptProperties();
  var key = "SEQ_" + sheet.getName() + "_" + prefix;
  var issued = Number(props.getProperty(key) || 0) || 0;
  var n = Math.max(max, issued) + 1;
  props.setProperty(key, String(n));
  var padded = String(n);
  while (padded.length < 4) padded = "0" + padded;
  return prefix + padded;
}

// 找出 A 欄等於 id 的那一列，回傳列號（1-indexed，含表頭），找不到回傳 -1
function findRowByIdText_(sheet, id) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === id) return i + 1;
  }
  return -1;
}

// 刪掉 A 欄等於 id 的所有列（主表通常剛好 1 筆，對照表可能有好幾筆）
function deleteRowsWhereIdEquals_(sheet, id) {
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === id) sheet.deleteRow(i + 1);
  }
}

// ---------------- 課程：新增／編輯／刪除 ----------------

function createCourse_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("課程");
  var id = nextId_(sheet, "C");
  var now = new Date();
  sheet.appendRow(wbSafeRow_([
    id,
    wbText_(p["課程名稱"]),
    wbText_(p["平台"]),
    wbText_(p["講師"]),
    progressToFraction_(p["進度"]),
    p["狀態"] || "",
    p["優先順序"] || "",
    wbText_(p["課程連結"]),
    p["開始日期"] || "",
    "", // 目標完成日：前端不管理，留空（要設定的話仍可直接在試算表填）
    "", // 費用：前端不管理，留空
    wbText_(p["心得筆記"]),
    now,
    now
  ]));
  var row = sheet.getLastRow();
  sheet.getRange(row, 5).setNumberFormat("0%");
  appendJunctionRows_(ss.getSheetByName("課程分類對照"), id, p["分類"]);
  return { success: true, id: id };
}

function updateCourse_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("課程");
  var id = p["課程ID"];
  if (!id) throw new Error("缺少課程ID");
  var row = findRowByIdText_(sheet, id);
  if (row === -1) throw new Error("找不到課程：" + id);
  var now = new Date();
  // 目標完成日／費用／建立時間 前端不編輯，讀出原值原封不動寫回去
  var existing = sheet.getRange(row, 1, 1, 14).getValues()[0];
  sheet.getRange(row, 2, 1, 13).setValues([wbSafeRow_([
    wbText_(p["課程名稱"]),
    wbText_(p["平台"]),
    wbText_(p["講師"]),
    progressToFraction_(p["進度"]),
    p["狀態"] || "",
    p["優先順序"] || "",
    wbText_(p["課程連結"]),
    p["開始日期"] || "",
    existing[9],  // 目標完成日
    existing[10], // 費用
    wbText_(p["心得筆記"]),
    existing[12], // 建立時間
    now           // 更新時間
  ])]);
  sheet.getRange(row, 5).setNumberFormat("0%");
  replaceJunctionRows_(ss.getSheetByName("課程分類對照"), id, p["分類"]);
  return { success: true, id: id };
}

function deleteCourse_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var id = p["課程ID"];
  if (!id) throw new Error("缺少課程ID");
  deleteRowsWhereIdEquals_(ss.getSheetByName("課程"), id);
  deleteRowsWhereIdEquals_(ss.getSheetByName("課程分類對照"), id);
  return { success: true, id: id };
}

// 前端送來的進度是 0~100 的數字，試算表存的是 0~1 的小數
function progressToFraction_(v) {
  if (v === "" || v === null || v === undefined) return "";
  var n = Number(v);
  if (isNaN(n)) return "";
  return n / 100;
}

// ---------------- 訂閱服務：新增／編輯／刪除 ----------------

function createSubscription_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("訂閱服務");
  var id = nextId_(sheet, "S");
  sheet.appendRow(wbSafeRow_([
    id,
    wbText_(p["產品"]),
    p["訂閱費"] === "" || p["訂閱費"] == null ? "" : Number(p["訂閱費"]),
    p["訂閱週期"] || "",
    p["訂閱開始日"] || "",
    p["取消訂閱"] === true,
    p["取消訂閱日"] || "",
    p["重要性"] || "",
    wbText_(p["備註"]),
    wbText_(p["付款URL"]),
    "", "", "", "", "", "", "" // K~Q 先留空，緊接著補上公式（flag 欄已刪除，欄位往前移一格）
  ]));
  var row = sheet.getLastRow();
  setSubscriptionFormulas_(sheet, row);
  appendJunctionRows_(ss.getSheetByName("訂閱標籤對照"), id, p["分類標籤"]);
  return { success: true, id: id };
}

function updateSubscription_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("訂閱服務");
  var id = p["訂閱ID"];
  if (!id) throw new Error("缺少訂閱ID");
  var row = findRowByIdText_(sheet, id);
  if (row === -1) throw new Error("找不到訂閱：" + id);
  sheet.getRange(row, 2, 1, 9).setValues([wbSafeRow_([
    wbText_(p["產品"]),
    p["訂閱費"] === "" || p["訂閱費"] == null ? "" : Number(p["訂閱費"]),
    p["訂閱週期"] || "",
    p["訂閱開始日"] || "",
    p["取消訂閱"] === true,
    p["取消訂閱日"] || "",
    p["重要性"] || "",
    wbText_(p["備註"]),
    wbText_(p["付款URL"])
  ])]);
  // K~Q（每月金額等 7 個計算欄）是公式，欄位值一改公式會自動重新計算，不用動它
  replaceJunctionRows_(ss.getSheetByName("訂閱標籤對照"), id, p["分類標籤"]);
  return { success: true, id: id };
}

function deleteSubscription_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var id = p["訂閱ID"];
  if (!id) throw new Error("缺少訂閱ID");
  deleteRowsWhereIdEquals_(ss.getSheetByName("訂閱服務"), id);
  deleteRowsWhereIdEquals_(ss.getSheetByName("訂閱標籤對照"), id);
  return { success: true, id: id };
}

// 幫新訂閱那一列的 K~Q 補上跟 Code.gs 公式函數一致的公式（不是寫死的值）
// （flag 欄刪除後，原本 L~R 整段往前移一欄，變成 K~Q）
function setSubscriptionFormulas_(sheet, row) {
  sheet.getRange(row, 11).setFormula("=MONTHLY_AMOUNT(C" + row + ",D" + row + ")");
  sheet.getRange(row, 12).setFormula("=LAST_PAYMENT_DATE(E" + row + ",D" + row + ")");
  sheet.getRange(row, 13).setFormula("=NEXT_PAYMENT_DATE(E" + row + ",D" + row + ",F" + row + ")");
  sheet.getRange(row, 14).setFormula("=UPCOMING_PAYMENT(M" + row + ")");
  sheet.getRange(row, 15).setFormula("=SUBSCRIBED_DAYS(E" + row + ",G" + row + ")");
  sheet.getRange(row, 16).setFormula("=TOTAL_SPENT(C" + row + ",D" + row + ",E" + row + ",G" + row + ")");
  sheet.getRange(row, 17).setFormula("=COST_WARNING(K" + row + ")");
}

// ---------------- 對照表（junction table）共用工具 ----------------

function junctionRows_(id, values) {
  return (values || []).filter(function (v) { return !!v; }).map(function (v) { return [id, v]; });
}
function appendJunctionRows_(sheet, id, values) { wbAppendRows_(sheet, junctionRows_(id, values)); }
function replaceJunctionRows_(sheet, id, values) { wbReplaceRowsById_(sheet, id, junctionRows_(id, values)); }

// ---- 附屬表（對照表／子任務／發現清單）的批次寫入 ----
// 2026-09-24 效能調整：原本一列一列 appendRow／deleteRow，每列都是一次跨網路呼叫，一個任務存一次要 5～10 次。
// 改成：新增＝一次 setValues 寫到表尾；取代＝讀整表一次 → 濾掉該 ID 的列、接上新列 → 清掉舊區域、一次寫回，固定 3 次呼叫。
// 只用在沒有公式、沒有日期欄的小表（主表仍用 appendRow／deleteRow，避免把公式格覆蓋掉）。
// ---- 寫進試算表前的文字保護 ----
// 試算表會「猜」字串的型別：= + @ 開頭變公式、1/2 變日期、007 變 7。
// 前面加一個單引號 ' 就會原樣當成文字存（試算表不會顯示這個單引號，讀回來也沒有）。
// wbText_：自由文字欄位（名稱、備註、內容…）——公式開頭、或整串看起來像數字／日期，都當文字存。
// wbSafeRow_／wbSafeRows_：整列寫入時，任何欄位只要是 = + @ 開頭的字串就當文字（數字、日期欄不受影響）。
function wbText_(v) {
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") return v;
  var t = v.trim();
  if (/^[=+\-@]/.test(v) || (t !== "" && /^[\d\s.,\/:%$+\-]+$/.test(t))) return "'" + v;
  return v;
}
function wbFormulaSafe_(v) { return typeof v === "string" && /^[=+@]/.test(v) ? "'" + v : v; }
function wbSafeRow_(row) { return row.map(wbFormulaSafe_); }
function wbSafeRows_(rows) { return rows.map(wbSafeRow_); }
// 附屬表（對照表／子任務／發現清單）都是文字欄（加上布林），字串一律用 wbText_
function wbTextRows_(rows) { return rows.map(function (r) { return r.map(function (v) { return typeof v === "string" ? wbText_(v) : v; }); }); }

function wbAppendRows_(sheet, rows) {
  if (!rows || !rows.length) return;
  rows = wbTextRows_(rows);
  var start = sheet.getLastRow() + 1;
  var need = start + rows.length - 1 - sheet.getMaxRows();
  if (need > 0) sheet.insertRowsAfter(sheet.getMaxRows(), need);
  sheet.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
}
function wbReplaceRowsById_(sheet, id, newRows) {
  var data = sheet.getDataRange().getValues();
  var width = Math.max(data[0] ? data[0].length : 0, newRows.length ? newRows[0].length : 0);
  var kept = data.slice(1).filter(function (r) { return r[0] !== id && r[0] !== "" && r[0] !== null && r[0] !== undefined; });
  var rows = wbTextRows_(kept.concat(newRows).map(function (r) { r = r.slice(0, width); while (r.length < width) r.push(""); return r; }));
  var oldCount = data.length - 1;
  if (oldCount > 0) sheet.getRange(2, 1, oldCount, width).clearContent();
  if (rows.length) {
    var need = rows.length + 1 - sheet.getMaxRows();
    if (need > 0) sheet.insertRowsAfter(sheet.getMaxRows(), need);
    sheet.getRange(2, 1, rows.length, width).setValues(rows);
  }
}

// ---------------- 分類管理（設定分頁的下拉選項：增/改名/刪） ----------------

// 每個選項欄位改名時，要連動更新到哪個分頁的哪一欄（主表欄位用字母，
// 對照表一律是 B 欄）。找不到對應設定的欄位就不做連動。
var CASCADE_TARGETS_ = {
  "平台": [{ sheet: "課程", col: "C" }],
  "狀態": [{ sheet: "課程", col: "F" }],
  "優先順序": [{ sheet: "課程", col: "G" }],
  "分類": [{ sheet: "課程分類對照", col: "B" }],
  "訂閱週期": [{ sheet: "訂閱服務", col: "D" }],
  "重要性": [{ sheet: "訂閱服務", col: "H" }],
  "分類標籤": [{ sheet: "訂閱標籤對照", col: "B" }],
  "任務分類": [{ sheet: "任務分類對照", col: "B" }],
  "任務優先順序": [{ sheet: "任務", col: "C" }],
  "任務狀態": [{ sheet: "任務", col: "D" }],
  "重複頻率": [{ sheet: "任務", col: "G" }],
  "專案狀態": [{ sheet: "專案", col: "E" }],
  "專案優先級": [{ sheet: "專案", col: "F" }],
  "習慣分類": [{ sheet: "習慣", col: "F" }]
};

// 依欄位名稱（例如「平台」）找出它在「設定」分頁是第幾欄
function findSettingsColumn_(sheet, fieldName) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var idx = headers.indexOf(fieldName);
  if (idx === -1) throw new Error("設定分頁找不到欄位：" + fieldName);
  return idx + 1;
}

// 統計每個選項目前被幾筆課程／訂閱／任務資料用到，管理畫面顯示用
function getOptionUsage_() {
  var courses = getCourses_();
  var subs = getSubscriptions_();
  var tasks = getTasks_();
  var projects = getProjects_();
  var habits = getHabits_();

  function count(list, key, isArray) {
    var map = {};
    list.forEach(function (row) {
      var v = row[key];
      if (isArray) {
        (v || []).forEach(function (x) { if (x) map[x] = (map[x] || 0) + 1; });
      } else if (v) {
        map[v] = (map[v] || 0) + 1;
      }
    });
    return map;
  }

  return {
    "平台": count(courses, "平台", false),
    "分類": count(courses, "分類", true),
    "狀態": count(courses, "狀態", false),
    "優先順序": count(courses, "優先順序", false),
    "訂閱週期": count(subs, "訂閱週期", false),
    "重要性": count(subs, "重要性", false),
    "分類標籤": count(subs, "分類標籤", true),
    "任務分類": count(tasks, "分類", true),
    "任務優先順序": count(tasks, "優先順序", false),
    "任務狀態": count(tasks, "狀態", false),
    "重複頻率": count(tasks, "重複規則", false),
    "專案狀態": count(projects, "狀態", false),
    "專案優先級": count(projects, "優先級", false),
    "習慣分類": count(habits, "分類", false)
  };
}

function addOption_(p) {
  var field = p["field"];
  var value = (p["value"] || "").toString().trim();
  if (!field || !value) throw new Error("缺少欄位名稱或選項內容");

  var sheet = getSheet_("設定");
  var col = findSettingsColumn_(sheet, field);
  var lastRow = sheet.getLastRow();
  var colValues = sheet.getRange(2, col, Math.max(lastRow - 1, 1), 1).getValues().map(function (r) { return r[0]; });

  if (colValues.indexOf(value) !== -1) throw new Error("「" + value + "」已經存在於" + field);

  var targetRow = 2;
  for (var i = 0; i < colValues.length; i++) {
    if (colValues[i] !== "" && colValues[i] !== null && colValues[i] !== undefined) targetRow = i + 3;
  }
  if (targetRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 1);
  sheet.getRange(targetRow, col).setValue(wbText_(value));
  return { success: true };
}

function deleteOption_(p) {
  var field = p["field"];
  var value = (p["value"] || "").toString().trim();
  wbAssertNotReserved_(p["field"], value);
  if (!field || !value) throw new Error("缺少欄位名稱或選項內容");

  var sheet = getSheet_("設定");
  var col = findSettingsColumn_(sheet, field);
  var lastRow = sheet.getLastRow();
  var range = sheet.getRange(2, col, Math.max(lastRow - 1, 1), 1);
  var values = range.getValues();

  var found = false;
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === value) {
      sheet.getRange(i + 2, col).setValue("");
      found = true;
      break;
    }
  }
  if (!found) throw new Error("找不到選項：" + value);
  // 注意：只是把這個選項從清單拿掉，已經用到這個值的課程／訂閱／任務資料不會被清掉，
  // 只是以後在下拉選單裡不會再出現。
  return { success: true };
}

// 程式靠這幾個值判斷（完成統計、逾期、重複任務…），不能改名或刪除
var WB_RESERVED_OPTIONS_ = { "任務狀態": ["待辦", "已完成", "已取消", "已跳過"], "狀態": ["已完成"], "專案狀態": ["已完成"] };
function wbAssertNotReserved_(field, value) {
  if ((WB_RESERVED_OPTIONS_[field] || []).indexOf(String(value)) !== -1) throw new Error("「" + value + "」是系統保留的選項，不能改名或刪除");
}

function renameOption_(p) {
  var field = p["field"];
  var oldValue = (p["oldValue"] || "").toString().trim();
  wbAssertNotReserved_(field, oldValue);
  var newValue = (p["newValue"] || "").toString().trim();
  if (!field || !oldValue || !newValue) throw new Error("缺少必要參數");
  if (oldValue === newValue) return { success: true };

  var sheet = getSheet_("設定");
  var col = findSettingsColumn_(sheet, field);
  var lastRow = sheet.getLastRow();
  var range = sheet.getRange(2, col, Math.max(lastRow - 1, 1), 1);
  var values = range.getValues();

  var alreadyExists = values.some(function (r) { return r[0] === newValue; });
  if (alreadyExists) throw new Error("「" + newValue + "」已經存在，不能重複");

  var found = false;
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === oldValue) {
      sheet.getRange(i + 2, col).setValue(wbText_(newValue));
      found = true;
      break;
    }
  }
  if (!found) throw new Error("找不到選項：" + oldValue);

  // 連動更新所有已經用到這個選項的課程／訂閱／任務資料，保持資料一致
  var targets = CASCADE_TARGETS_[field] || [];
  targets.forEach(function (t) {
    var s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(t.sheet);
    if (!s) return;
    var colRange = s.getRange(t.col + "2:" + t.col);
    colRange.createTextFinder(oldValue).matchEntireCell(true).replaceAllWith(newValue);
  });

  return { success: true };
}

// ---------------- 系統索引：選單圖示／名稱編輯 ----------------

// 依「主表分頁名稱」（"課程"／"訂閱服務"／"任務"，就是分頁名字，是固定不變的識別鍵）
// 找到那一列，更新「系統名稱」跟「icon」——這兩個是顯示用的，改了不會動到
// 底下的資料結構，前端選單/頁面標題會照這裡顯示。
function updateSystemIndex_(p) {
  var key = p["主表分頁名稱"];
  if (!key) throw new Error("缺少主表分頁名稱");
  var sheet = getSheet_("系統索引");
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][2] === key) {
      var row = i + 1;
      if (p["系統名稱"] !== undefined && p["系統名稱"] !== "") sheet.getRange(row, 1).setValue(p["系統名稱"]);
      if (p["icon"] !== undefined && p["icon"] !== "") sheet.getRange(row, 2).setValue(p["icon"]);
      return { success: true };
    }
  }
  throw new Error("找不到系統：" + key);
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

// ==================== server/main.js ====================
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
