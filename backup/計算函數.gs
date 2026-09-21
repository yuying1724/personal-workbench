/**
 * 個人工作台 - 訂閱服務計算欄位
 * 對應「訂閱服務」分頁欄位：
 * A訂閱ID B產品 C訂閱費 D訂閱週期 E訂閱開始日 F取消訂閱 G取消訂閱日 H重要性
 * I備註 J付款URL
 * K每月金額 L上次付款日 M下次付款日 N即將付款 O累積訂閱日 P總計花費 Q訂閱費負擔提示
 *
 * 安裝方式：開啟 Google Sheets → 擴充功能 (Extensions) → Apps Script
 * 把這個檔案的內容整個貼進去（覆蓋預設的 myFunction()），存檔即可。
 * 回到 Sheet 後，在「訂閱服務」分頁 K2:Q2 依下方【使用方式】貼公式，再往下拖曳套用到所有列（若用 webapp.gs 的 setSubscriptionFormulas_ 自動寫入則不需手動貼）。
 */

// ---- 內部工具：安全地把月份加到日期上（處理 1/31 + 1個月 這種日數溢位問題）----
function addMonthsSafe_(date, months) {
  var d = new Date(date.getTime());
  var day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  var lastDayOfTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDayOfTargetMonth));
  return d;
}

// ---- 內部工具：依訂閱週期，從某個日期推算「下一次」發生的日期 ----
// 買斷（Credit）沒有下一次，回傳 null
function addPeriod_(date, cycle) {
  switch (cycle) {
    case "每月":
      return addMonthsSafe_(date, 1);
    case "每季":
      return addMonthsSafe_(date, 3);
    case "每年":
      return addMonthsSafe_(date, 12);
    case "每兩年":
      return addMonthsSafe_(date, 24);
    case "月訂閱 (31天)":
      var d = new Date(date.getTime());
      d.setDate(d.getDate() + 31);
      return d;
    case "買斷（Credit）":
      return null;
    default:
      return null;
  }
}

/**
 * 每月金額：把不同週期的訂閱費換算成月支出，方便互相比較。
 * 買斷（Credit）不是持續扣款，算 0（但仍計入總計花費）。
 * @param {number} fee 訂閱費
 * @param {string} cycle 訂閱週期
 * @customfunction
 */
function MONTHLY_AMOUNT(fee, cycle) {
  if (fee === "" || fee === null || fee === undefined) return "";
  fee = Number(fee);
  switch (cycle) {
    case "每月": return fee;
    case "每季": return fee / 3;
    case "每年": return fee / 12;
    case "每兩年": return fee / 24;
    case "月訂閱 (31天)": return fee;
    case "買斷（Credit）": return 0;
    default: return "";
  }
}

/**
 * 上次付款日：從訂閱開始日往後推算，找出最近一次（今天以前）的付款日。
 * 買斷（Credit）視為一次性付款，直接回傳訂閱開始日。
 * @param {Date} startDate 訂閱開始日
 * @param {string} cycle 訂閱週期
 * @customfunction
 */
function LAST_PAYMENT_DATE(startDate, cycle) {
  if (!startDate) return "";
  if (cycle === "買斷（Credit）") return startDate;
  var today = new Date();
  var current = new Date(startDate);
  if (current > today) return "";
  var next = addPeriod_(current, cycle);
  var guard = 0;
  while (next && next <= today && guard < 2000) {
    current = next;
    next = addPeriod_(current, cycle);
    guard++;
  }
  return current;
}

/**
 * 下次付款日：上次付款日之後的下一個週期。
 * 已取消訂閱、或買斷（Credit）沒有下一次付款，回傳空白。
 * @param {Date} startDate 訂閱開始日
 * @param {string} cycle 訂閱週期
 * @param {boolean} canceled 取消訂閱
 * @customfunction
 */
function NEXT_PAYMENT_DATE(startDate, cycle, canceled) {
  if (canceled === true) return "";
  if (cycle === "買斷（Credit）") return "";
  var last = LAST_PAYMENT_DATE(startDate, cycle);
  if (!last) return "";
  var next = addPeriod_(new Date(last), cycle);
  return next || "";
}

/**
 * 即將付款：下次付款日在 14 天內（含當天）就回傳 TRUE。
 * @param {Date} nextPaymentDate 下次付款日
 * @customfunction
 */
function UPCOMING_PAYMENT(nextPaymentDate) {
  if (!nextPaymentDate) return false;
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var next = new Date(nextPaymentDate);
  next.setHours(0, 0, 0, 0);
  var diffDays = Math.round((next - today) / 86400000);
  return diffDays >= 0 && diffDays <= 14;
}

/**
 * 累積訂閱日：從訂閱開始日到現在（或取消日）經過幾天。
 * @param {Date} startDate 訂閱開始日
 * @param {Date} cancelDate 取消訂閱日（可留空）
 * @customfunction
 */
function SUBSCRIBED_DAYS(startDate, cancelDate) {
  if (!startDate) return "";
  var end = cancelDate ? new Date(cancelDate) : new Date();
  var start = new Date(startDate);
  var diff = Math.floor((end - start) / 86400000);
  return diff < 0 ? 0 : diff;
}

/**
 * 總計花費：把訂閱開始至今（或取消日）已經發生的每一次付款加總。
 * 買斷（Credit）只算一次（就是那筆費用本身）。
 * @param {number} fee 訂閱費
 * @param {string} cycle 訂閱週期
 * @param {Date} startDate 訂閱開始日
 * @param {Date} cancelDate 取消訂閱日（可留空）
 * @customfunction
 */
function TOTAL_SPENT(fee, cycle, startDate, cancelDate) {
  if (!fee || !startDate) return 0;
  fee = Number(fee);
  if (cycle === "買斷（Credit）") return fee;
  var end = cancelDate ? new Date(cancelDate) : new Date();
  var current = new Date(startDate);
  var count = 0;
  var guard = 0;
  while (current <= end && guard < 2000) {
    count++;
    var next = addPeriod_(current, cycle);
    if (!next) break;
    current = next;
    guard++;
  }
  return count * fee;
}

/**
 * 訂閱費負擔提示：每月金額超過 500 元時顯示提醒（沿用原本 Notion 的規則）。
 * @param {number} monthlyAmount 每月金額
 * @customfunction
 */
function COST_WARNING(monthlyAmount) {
  if (monthlyAmount === "" || monthlyAmount === null || monthlyAmount === undefined) return "";
  return Number(monthlyAmount) > 500 ? "⚠️ 較高" : "";
}
