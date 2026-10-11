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
