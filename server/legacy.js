/*
 * ====================================================================
 * 各模組的資料邏輯（課程／訂閱／任務／專案／習慣／日記／分類管理／系統索引）
 * 取自 2026-09-21 線上版 Api.gs（備份在 backup/Api.gs），內容原封不動，
 * 只把原本的 doGet/doPost 改名成 legacyDoGet_/legacyDoPost_：
 * 新版入口在 server/main.js，會先驗證「裝置授權碼＋PIN」登入的工作階段，
 * 再呼叫這裡的 getXxx_/createXxx_/updateXxx_ 等函式。
 * 舊版 API_TOKEN 入口只在「指令碼屬性」還有 API_TOKEN 時才有效（過渡期用），
 * 新版網站上線後把 API_TOKEN 刪掉，舊入口就自動關閉。
 * ====================================================================
 */
/**
 * 個人工作台 - 後端 API
 * 部署為網頁應用程式（Deploy → New deployment → Web app）後，
 * 前端用 fetch(WEB_APP_URL + "?action=xxx") 就能拿到 JSON 資料。
 *
 * 這個檔案要用「新增檔案」加進同一個 Apps Script 專案，
 * 跟 Code.gs（7 個訂閱計算函數）放在一起，不要覆蓋掉它。
 *
 * 支援的 action：
 *   ?action=courses            全部課程（含分類陣列）
 *   ?action=course_stats       課程統計：整體/依分類/依平台/依狀態
 *   ?action=subscriptions      全部訂閱（含標籤陣列、7 個計算欄位）
 *   ?action=subscription_stats 訂閱統計：每月總支出、即將付款清單、費用提醒清單、依標籤分攤
 *   ?action=tasks              全部任務（含分類陣列、子任務清單、所屬專案）
 *   ?action=task_stats         任務統計：總數/已完成/逾期/3天內到期/星標未完成
 *   ?action=projects           全部專案（含底下任務數/已完成數/逾期數/完成度）
 *   ?action=project_stats      專案統計：總數/依狀態分組
 *   ?action=habits             全部習慣（含今日是否已打卡/連續天數/最長連續/近7天30天完成率）
 *   ?action=habit_stats        習慣統計：總數/今天應打卡數/今天已完成數/平均近7天完成率
 *   ?action=diaries            全部日記（含發現清單，依日期新到舊排序）
 *   ?action=diary_stats        日記統計：總篇數/今天寫了沒/連續寫日記天數
 *   ?action=system_index       系統索引分頁內容（給前端做選單用）
 *   ?action=options            「設定」分頁的下拉選項清單（新增/編輯表單用）
 *   ?action=option_usage       每個選項目前被幾筆課程/訂閱/任務資料用到（分類管理頁用）
 *   ?action=all                上面 courses~system_index 全部包在一個回應裡一次回傳，
 *                              前端首頁載入用這個，不用再同時發一堆平行請求
 *   ?action=course_bundle / sub_bundle / task_bundle / project_bundle / habit_bundle / diary_bundle
 *                              只回傳「該模組的資料＋統計」兩樣，給前端在單一模組
 *                              新增/編輯/刪除後用，不用像 all 一樣把 15 種資料整包重抓
 *   ?action=project_task_bundle 專案＋任務（含各自統計）一起回傳；因為刪除專案會
 *                              連動清空任務的所屬專案欄位，刪除專案後兩邊都要更新
 *   （不帶 action，預設回傳 system_index）
 *
 * 新增／編輯／刪除是用 POST 呼叫（doPost），因為要改動試算表：
 *   body（text/plain，內容是 JSON 字串）：
 *   { "token": "...", "action": "create_course" | "update_course" | "delete_course"
 *              | "create_subscription" | "update_subscription" | "delete_subscription"
 *              | "create_task" | "update_task" | "delete_task" | "skip_task"
 *              | "create_project" | "update_project" | "delete_project"
 *              | "create_habit" | "update_habit" | "delete_habit" | "set_habit_log"
 *              | "create_diary" | "update_diary" | "delete_diary"
 *              | "add_option" | "rename_option" | "delete_option" | "update_system",
 *     "payload": { ...欄位資料... } }
 *   skip_task payload: { 任務ID } —— 這一筆本身標記成「已跳過」（不算完成，
 *   也不會一直卡在逾期清單裡），但如果有看得懂的重複規則，還是會照規則產生
 *   下一輪的待辦任務；只有自訂文字標籤的重複規則（不會自動延續）沒辦法跳過，
 *   呼叫這個 action 會丟出錯誤。
 *   create_diary / update_diary payload 欄位:
 *     日期（yyyy-MM-dd，create 不帶就是今天）, 心情, 感恩, 放手, 今日重要事項, 小故事,
 *     發現清單（[{類型,內容,備註,狀態}, ...] 陣列，內容空白的項目會被忽略；狀態＝""(待整理)/"已整理"/"不需整理"）。
 *     create_diary 是 upsert：如果那天已經寫過日記，會直接改成更新那一篇，不會產生重複日期。
 *   set_habit_log payload: { 習慣ID, 日期（yyyy-MM-dd，不帶就是今天）, 數值 }——
 *   數值不帶（null/undefined/空字串）代表取消打卡，帶數字就新增或更新那一天的紀錄。
 *   create_habit / update_habit payload 欄位:
 *     習慣名稱, 分類, 類型（"打勾"｜"計數"）, 目標值（計數型的「達標」門檻）, 單位,
 *     啟用分級（true/false，只有計數型有意義）, 基礎值, 超標值（啟用分級才會用到，
 *     基礎值必須小於目標值，超標值必須大於目標值）,
 *     頻率類型（"daily"｜"weekday"｜"weeklyCount"）,
 *     星期幾（頻率=weekday 時才用，0~6 的陣列，0=週日），
 *     每週次數（頻率=weeklyCount 時才用，不指定是星期幾，只看一週內完成幾天）,
 *     狀態（"啟用"｜"封存"）,
 *     時段（"早上"｜"中午"｜"晚上"｜"不限"，給「今日待辦」畫面分組排序用，不填預設"不限"）
 *   add_option/delete_option payload: { field, value }
 *   rename_option payload: { field, oldValue, newValue } — 改名字時會自動
 *   連動更新所有已經用到這個選項的課程/訂閱/任務資料，資料不會因為改名而對不起來。
 *   update_system payload: { 主表分頁名稱, 系統名稱, icon } — 改選單上顯示的
 *   名稱跟圖示，不會動到底下的資料結構。
 *   前端用 Content-Type: text/plain 送出（不是 application/json），是刻意的：
 *   Apps Script 的網頁應用程式不支援瀏覽器的 CORS 預檢請求（preflight），
 *   如果用 application/json 當 Content-Type，瀏覽器送出 POST 前會先送一個
 *   OPTIONS 預檢請求，Apps Script 沒辦法正確回應，會直接失敗。改用
 *   text/plain（瀏覽器認定的「單純請求」，不用預檢）就能繞開這個限制，
 *   後端一樣把收到的內容當 JSON 字串解析，資料內容完全不受影響。
 *
 * 存取權限：
 *   部署設定「誰可以存取」要選「任何人」，不能選「只有我自己」——
 *   後者會讓 Google 在回應前先跳轉一次登入驗證頁，那個跳轉頁不會帶
 *   CORS 標頭，瀏覽器的 fetch() 會直接擋下來（在網址列直接貼網址開
 *   沒事，是因為那是「直接導覽」不受 CORS 限制，跟 fetch 是兩回事）。
 *   改用下面這組自訂 token 驗證取代 Google 原生的存取限制，效果一樣
 *   是「只有知道密語的人拿得到資料」。
 *
 * 第一次設定 token（只需要做一次）：
 *   1. 左側選單「專案設定」(齒輪圖示) → 往下捲到「指令碼屬性」
 *   2. 新增屬性：屬性 = API_TOKEN，值 = 你自己想的一串亂碼密語（越長越好）
 *   3. 儲存
 *   前端網頁要記得帶同一組 token 才抓得到資料。
 */

var API_TOKEN_PROPERTY = "API_TOKEN";

function checkToken_(e) {
  // 還沒設定指令碼屬性 API_TOKEN 的話，required 會是 null，一律視為驗證失敗，
  // 避免忘記設定 token 就變成任何人都能拿到資料
  var required = PropertiesService.getScriptProperties().getProperty(API_TOKEN_PROPERTY);
  var provided = (e && e.parameter && e.parameter.token) || "";
  return !!required && provided === required;
}

function legacyDoGet_(e) {
  if (!checkToken_(e)) {
    return jsonOut_({ error: "unauthorized：token 不對或沒帶 token" });
  }
  var action = (e && e.parameter && e.parameter.action) || "system_index";
  var result;
  try {
    switch (action) {
      case "courses":
        result = getCourses_();
        break;
      case "course_stats":
        result = getCourseStats_();
        break;
      case "subscriptions":
        result = getSubscriptions_();
        break;
      case "subscription_stats":
        result = getSubscriptionStats_();
        break;
      case "tasks":
        result = getTasks_();
        break;
      case "task_stats":
        result = getTaskStats_();
        break;
      case "projects":
        result = getProjects_();
        break;
      case "project_stats":
        result = getProjectStats_();
        break;
      case "habits":
        result = getHabits_();
        break;
      case "habit_stats":
        result = getHabitStats_();
        break;
      case "diaries":
        result = getDiaries_();
        break;
      case "diary_stats":
        result = getDiaryStats_();
        break;
      case "system_index":
        result = sheetToObjects_("系統索引");
        break;
      case "options":
        result = getOptions_();
        break;
      case "option_usage":
        result = getOptionUsage_();
        break;
      case "all":
        result = getAllData_();
        break;
      case "course_bundle":
        result = getCourseBundle_();
        break;
      case "sub_bundle":
        result = getSubBundle_();
        break;
      case "task_bundle":
        result = getTaskBundle_();
        break;
      case "project_bundle":
        result = getProjectBundle_();
        break;
      case "project_task_bundle":
        result = getProjectTaskBundle_();
        break;
      case "habit_bundle":
        result = getHabitBundle_();
        break;
      case "diary_bundle":
        result = getDiaryBundle_();
        break;
      default:
        result = { error: "unknown action: " + action };
    }
  } catch (err) {
    result = { error: err.message };
  }
  return jsonOut_(result);
}

// 新增／編輯／刪除：改動試算表內容，所以用 POST
function legacyDoPost_(e) {
  var body;
  try {
    body = JSON.parse(e && e.postData && e.postData.contents);
  } catch (err) {
    return jsonOut_({ error: "無法解析請求內容" });
  }
  if (!checkToken_({ parameter: { token: body && body.token } })) {
    return jsonOut_({ error: "unauthorized：token 不對或沒帶 token" });
  }
  var action = body.action;
  var payload = body.payload || {};
  var result;
  try {
    switch (action) {
      case "create_course":
        result = createCourse_(payload);
        break;
      case "update_course":
        result = updateCourse_(payload);
        break;
      case "delete_course":
        result = deleteCourse_(payload);
        break;
      case "create_subscription":
        result = createSubscription_(payload);
        break;
      case "update_subscription":
        result = updateSubscription_(payload);
        break;
      case "delete_subscription":
        result = deleteSubscription_(payload);
        break;
      case "create_task":
        result = createTask_(payload);
        break;
      case "update_task":
        result = updateTask_(payload);
        break;
      case "delete_task":
        result = deleteTask_(payload);
        break;
      case "skip_task":
        result = skipTask_(payload);
        break;
      case "create_project":
        result = createProject_(payload);
        break;
      case "update_project":
        result = updateProject_(payload);
        break;
      case "delete_project":
        result = deleteProject_(payload);
        break;
      case "create_habit":
        result = createHabit_(payload);
        break;
      case "update_habit":
        result = updateHabit_(payload);
        break;
      case "delete_habit":
        result = deleteHabit_(payload);
        break;
      case "set_habit_log":
        result = setHabitLog_(payload);
        break;
      case "create_diary":
        result = createDiary_(payload);
        break;
      case "update_diary":
        result = updateDiary_(payload);
        break;
      case "delete_diary":
        result = deleteDiary_(payload);
        break;
      case "add_option":
        result = addOption_(payload);
        break;
      case "rename_option":
        result = renameOption_(payload);
        break;
      case "delete_option":
        result = deleteOption_(payload);
        break;
      case "update_system":
        result = updateSystemIndex_(payload);
        break;
      default:
        result = { error: "unknown action: " + action };
    }
  } catch (err) {
    result = { error: err.message };
  }
  return jsonOut_(result);
}

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
  });
  return subs;
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
function nextDueDate_(dateStr, ruleRaw) {
  if (!dateStr) return "";
  var d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  var rule = parseRepeatRule_(ruleRaw);
  if (!rule) return "";
  var interval = Math.max(1, parseInt(rule.interval, 10) || 1);

  if (rule.freq === "day") {
    d.setDate(d.getDate() + interval);
  } else if (rule.freq === "month") {
    if (rule.lastDayOfMonth) {
      var totalMonths = d.getFullYear() * 12 + d.getMonth() + interval;
      var targetYear = Math.floor(totalMonths / 12);
      var targetMonth0 = totalMonths % 12;
      d = new Date(targetYear, targetMonth0 + 1, 0); // 第 0 天 = 上個月的最後一天
    } else {
      d = addMonthsSafe_(d, interval);
    }
  } else if (rule.freq === "year") {
    d.setFullYear(d.getFullYear() + interval);
  } else if (rule.freq === "week") {
    if (rule.weekdays && rule.weekdays.length) {
      d = nextWeekdayOccurrence_(d, rule.weekdays, interval);
    } else {
      d.setDate(d.getDate() + 7 * interval);
    }
  } else {
    return "";
  }
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

// 判斷這次完成後，重複規則的「截止條件」是否已經到了（到了就不再自動產生下一筆）。
// 回傳 { stop: boolean, nextRuleRaw: string } —— nextRuleRaw 是下一筆任務要繼續帶著的重複規則字串
// （次數限制的情況，裡面的 occurrence 會 +1；沒有截止條件或用日期限制的情況，規則字串原封不動）。
function applyRepeatEnd_(rule, ruleRaw, nextDueStr) {
  if (!rule || !rule.end) return { stop: false, nextRuleRaw: ruleRaw };
  var end = rule.end;
  if (end.type === "date" && end.date) {
    if (nextDueStr > end.date) return { stop: true, nextRuleRaw: ruleRaw };
    return { stop: false, nextRuleRaw: ruleRaw };
  }
  if (end.type === "count" && end.count) {
    var doneCount = rule.occurrence || 1;
    if (doneCount >= end.count) return { stop: true, nextRuleRaw: ruleRaw };
    var nextRule = JSON.parse(JSON.stringify(rule));
    nextRule.occurrence = doneCount + 1;
    return { stop: false, nextRuleRaw: JSON.stringify(nextRule) };
  }
  return { stop: false, nextRuleRaw: ruleRaw };
}

// 把「重複規則」欄位解析成結構化物件；不是看得懂的 JSON 就回傳 null（代表自訂文字，不自動產生下一筆）
function parseRepeatRule_(raw) {
  if (!raw) return null;
  var obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  if (["day", "week", "month", "year"].indexOf(obj.freq) === -1) return null;
  return obj;
}

// 從某個日期往後找，下一個符合「指定星期幾、每 N 週」規則的日期
// （用「當週週日」當基準點來判斷第幾週，確保「每兩週」這種間隔算得準）
function nextWeekdayOccurrence_(fromDate, weekdays, interval) {
  var sorted = weekdays.slice().sort(function (a, b) { return a - b; });
  var baseWeekStart = startOfWeek_(fromDate);
  var cur = new Date(fromDate.getTime());
  for (var i = 0; i < 370; i++) {
    cur.setDate(cur.getDate() + 1);
    if (sorted.indexOf(cur.getDay()) !== -1) {
      var curWeekStart = startOfWeek_(cur);
      var weeksDiff = Math.round((curWeekStart.getTime() - baseWeekStart.getTime()) / (7 * 86400000));
      if (((weeksDiff % interval) + interval) % interval === 0) return cur;
    }
  }
  return cur; // 理論上不會走到這（保底）
}

// 某日期所在那一週的週日（當地時間，時分秒歸零）
function startOfWeek_(date) {
  var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - d.getDay());
  return d;
}

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
  var tasks = getTasks_();
  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  var soonLimit = new Date();
  soonLimit.setDate(soonLimit.getDate() + 3);
  var soonStr = Utilities.formatDate(soonLimit, Session.getScriptTimeZone(), "yyyy-MM-dd");

  var completed = 0, overdue = 0, dueSoon = 0, starredOpen = 0;

  tasks.forEach(function (t) {
    var isDone = t["狀態"] === "已完成";
    // 已取消／已跳過都算「這一筆已經處理完、不再需要關注」，不列入逾期／即將到期，
    // 差別只在「已跳過」還會自動產生下一輪待辦（見 skipTask_），這裡純粹算統計不用管那個。
    var isClosed = t["狀態"] === "已取消" || t["狀態"] === "已跳過";
    if (isDone) completed++;
    if (t["星標"] === true && !isDone && !isClosed) starredOpen++;
    if (t["到期日"] && !isDone && !isClosed) {
      if (t["到期日"] < todayStr) overdue++;
      else if (t["到期日"] <= soonStr) dueSoon++;
    }
  });

  return {
    total: tasks.length,
    completed: completed,
    overdue: overdue,
    dueSoon: dueSoon,
    starredOpen: starredOpen
  };
}

function createTask_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("任務");
  var id = nextId_(sheet, "T");
  var now = new Date();
  sheet.appendRow([
    id,
    p["任務名稱"] || "",
    p["優先順序"] || "",
    p["狀態"] || "",
    p["到期日"] || "",
    p["星標"] === true,
    p["重複規則"] || "",
    p["備註"] || "",
    now,                   // I 建立時間
    now,                   // J 更新時間
    p["所屬專案"] || ""     // K 所屬專案（存專案ID，可留空）
  ]);
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

  sheet.getRange(row, 2, 1, 10).setValues([[
    p["任務名稱"] || "",
    p["優先順序"] || "",
    newStatus,
    p["到期日"] || "",
    p["星標"] === true,
    p["重複規則"] || "",
    p["備註"] || "",
    createdAt,            // I 建立時間：保留
    now,                  // J 更新時間：這次才是真的更新時間
    p["所屬專案"] || ""     // K 所屬專案
  ]]);
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
  sheet.appendRow([
    id,
    p["專案名稱"] || "",
    p["開始日"] || "",
    p["結束日"] || "",
    p["狀態"] || "",
    p["優先級"] || "",
    p["備註"] || "",
    now,
    now
  ]);
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
  sheet.getRange(row, 2, 1, 8).setValues([[
    p["專案名稱"] || "",
    p["開始日"] || "",
    p["結束日"] || "",
    p["狀態"] || "",
    p["優先級"] || "",
    p["備註"] || "",
    existing[7], // 建立時間：保留
    now          // 更新時間
  ]]);
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
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
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
function isRequiredDay_(habit, dateStr) {
  if (habit["頻率類型"] === "weekday") {
    var dow = parseDateStr_(dateStr).getDay();
    return (habit["星期幾"] || []).indexOf(dow) !== -1;
  }
  return true;
}

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
function isHabitDoneForDay_(habit, value) {
  var v = Number(value) || 0;
  if (habit["類型"] !== "計數") return v >= 1;
  if (habit["啟用分級"] === true && habit["基礎值"] !== "" && habit["基礎值"] != null) {
    var base = Number(habit["基礎值"]) || 0;
    return v >= base;
  }
  var target = Number(habit["目標值"]) || 1;
  return v >= target;
}

// 算某一天達到「基礎／達標／超標」哪一級（只有計數型 + 有開三級制才會回傳非 null）。
// 給前端顯示用的徽章，不影響「今日已完成」的判斷（那個固定認基礎以上）。
function habitTierForValue_(habit, value) {
  if (habit["類型"] !== "計數" || habit["啟用分級"] !== true) return null;
  var v = Number(value) || 0;
  var base = habit["基礎值"] !== "" && habit["基礎值"] != null ? Number(habit["基礎值"]) : null;
  var target = Number(habit["目標值"]) || 0;
  var over = habit["超標值"] !== "" && habit["超標值"] != null ? Number(habit["超標值"]) : null;
  if (over !== null && v >= over) return "超標";
  if (v >= target) return "達標";
  if (base !== null && v >= base) return "基礎";
  return null;
}

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
  sheet.appendRow([
    id,
    p["習慣名稱"] || "",
    p["類型"] || "打勾",
    p["目標值"] || "",
    p["單位"] || "",
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
  ]);
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
  sheet.getRange(row, 2, 1, 15).setValues([[
    p["習慣名稱"] || "",
    p["類型"] || "打勾",
    p["目標值"] || "",
    p["單位"] || "",
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
  ]]);
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
      sheet.getRange(foundRow, 3, 1, 2).setValues([[dateStr, value]]); // C日期 D數值（保留原本的紀錄ID跟建立時間）
    } else {
      var id = nextId_(sheet, "HL");
      sheet.appendRow([id, habitId, dateStr, value, new Date()]);
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
      sheet.getRange(row, 2, 1, 8).setValues([[
        dateStr, p["心情"] || "", p["感恩"] || "", p["放手"] || "",
        p["今日重要事項"] || "", p["小故事"] || "", createdAt, now
      ]]);
      replaceDiaryFindRows_(ss.getSheetByName("日記發現清單"), id, p["發現清單"]);
      return { success: true, id: id };
    }

    var newId = nextId_(sheet, "J");
    sheet.appendRow([
      newId, dateStr, p["心情"] || "", p["感恩"] || "", p["放手"] || "",
      p["今日重要事項"] || "", p["小故事"] || "", now, now
    ]);
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
  sheet.getRange(row, 2, 1, 8).setValues([[
    dateStr, p["心情"] || "", p["感恩"] || "", p["放手"] || "",
    p["今日重要事項"] || "", p["小故事"] || "", existing[7], now
  ]]);
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
  var padded = String(max + 1);
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
  sheet.appendRow([
    id,
    p["課程名稱"] || "",
    p["平台"] || "",
    p["講師"] || "",
    progressToFraction_(p["進度"]),
    p["狀態"] || "",
    p["優先順序"] || "",
    p["課程連結"] || "",
    p["開始日期"] || "",
    "", // 目標完成日：前端不管理，留空（要設定的話仍可直接在試算表填）
    "", // 費用：前端不管理，留空
    p["心得筆記"] || "",
    now,
    now
  ]);
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
  sheet.getRange(row, 2, 1, 13).setValues([[
    p["課程名稱"] || "",
    p["平台"] || "",
    p["講師"] || "",
    progressToFraction_(p["進度"]),
    p["狀態"] || "",
    p["優先順序"] || "",
    p["課程連結"] || "",
    p["開始日期"] || "",
    existing[9],  // 目標完成日
    existing[10], // 費用
    p["心得筆記"] || "",
    existing[12], // 建立時間
    now           // 更新時間
  ]]);
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
  sheet.appendRow([
    id,
    p["產品"] || "",
    p["訂閱費"] === "" || p["訂閱費"] == null ? "" : Number(p["訂閱費"]),
    p["訂閱週期"] || "",
    p["訂閱開始日"] || "",
    p["取消訂閱"] === true,
    p["取消訂閱日"] || "",
    p["重要性"] || "",
    p["備註"] || "",
    p["付款URL"] || "",
    "", "", "", "", "", "", "" // K~Q 先留空，緊接著補上公式（flag 欄已刪除，欄位往前移一格）
  ]);
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
  sheet.getRange(row, 2, 1, 9).setValues([[
    p["產品"] || "",
    p["訂閱費"] === "" || p["訂閱費"] == null ? "" : Number(p["訂閱費"]),
    p["訂閱週期"] || "",
    p["訂閱開始日"] || "",
    p["取消訂閱"] === true,
    p["取消訂閱日"] || "",
    p["重要性"] || "",
    p["備註"] || "",
    p["付款URL"] || ""
  ]]);
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
function wbAppendRows_(sheet, rows) {
  if (!rows || !rows.length) return;
  var start = sheet.getLastRow() + 1;
  var need = start + rows.length - 1 - sheet.getMaxRows();
  if (need > 0) sheet.insertRowsAfter(sheet.getMaxRows(), need);
  sheet.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
}
function wbReplaceRowsById_(sheet, id, newRows) {
  var data = sheet.getDataRange().getValues();
  var width = Math.max(data[0] ? data[0].length : 0, newRows.length ? newRows[0].length : 0);
  var kept = data.slice(1).filter(function (r) { return r[0] !== id && r[0] !== "" && r[0] !== null && r[0] !== undefined; });
  var rows = kept.concat(newRows).map(function (r) { r = r.slice(0, width); while (r.length < width) r.push(""); return r; });
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
  sheet.getRange(targetRow, col).setValue(value);
  return { success: true };
}

function deleteOption_(p) {
  var field = p["field"];
  var value = (p["value"] || "").toString().trim();
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

function renameOption_(p) {
  var field = p["field"];
  var oldValue = (p["oldValue"] || "").toString().trim();
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
      sheet.getRange(i + 2, col).setValue(newValue);
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
