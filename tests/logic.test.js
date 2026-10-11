'use strict';
/** shared/logic.js（前後端共用邏輯）的單元測試：重複規則的邊界日期、習慣判斷、任務統計 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/logic.js'), 'utf8') + '\nthis.WbLogic = WbLogic;', ctx);
const L = ctx.WbLogic;
const rule = (o) => JSON.stringify(o);

test('重複規則：每天／每 N 天、跨月跨年', () => {
  assert.equal(L.nextDueDate('2026-12-31', rule({ freq: 'day', interval: 1 })), '2027-01-01');
  assert.equal(L.nextDueDate('2026-02-27', rule({ freq: 'day', interval: 3 })), '2026-03-02');
});

test('重複規則：每月遇到月底（1/31 → 2/28、閏年 2/29）、每月最後一天', () => {
  assert.equal(L.nextDueDate('2026-01-31', rule({ freq: 'month', interval: 1 })), '2026-02-28');
  assert.equal(L.nextDueDate('2028-01-31', rule({ freq: 'month', interval: 1 })), '2028-02-29');
  assert.equal(L.nextDueDate('2026-03-31', rule({ freq: 'month', interval: 1 })), '2026-04-30');
  assert.equal(L.nextDueDate('2026-11-15', rule({ freq: 'month', interval: 2 })), '2027-01-15');
  assert.equal(L.nextDueDate('2026-01-31', rule({ freq: 'month', interval: 1, lastDayOfMonth: true })), '2026-02-28');
  assert.equal(L.nextDueDate('2026-02-28', rule({ freq: 'month', interval: 1, lastDayOfMonth: true })), '2026-03-31');
  assert.equal(L.nextDueDate('2026-12-31', rule({ freq: 'month', interval: 2, lastDayOfMonth: true })), '2027-02-28');
});

test('重複規則：每年（閏日 2/29 的下一年是 2/28）', () => {
  assert.equal(L.nextDueDate('2028-02-29', rule({ freq: 'year', interval: 1 })), '2029-02-28');
  assert.equal(L.nextDueDate('2026-10-11', rule({ freq: 'year', interval: 2 })), '2028-10-11');
});

test('重複規則：每週指定星期、每兩週、跨年', () => {
  // 2026-10-12 是週一
  assert.equal(L.nextDueDate('2026-10-12', rule({ freq: 'week', interval: 1, weekdays: [1, 3] })), '2026-10-14');
  assert.equal(L.nextDueDate('2026-10-14', rule({ freq: 'week', interval: 1, weekdays: [1, 3] })), '2026-10-19');
  assert.equal(L.nextDueDate('2026-10-14', rule({ freq: 'week', interval: 2, weekdays: [1, 3] })), '2026-10-26', '每兩週：跳過下一週');
  // 2026-12-30 週三 → 每兩週的週一、週三 → 2027-01-11（週一）
  assert.equal(L.nextDueDate('2026-12-30', rule({ freq: 'week', interval: 2, weekdays: [1, 3] })), '2027-01-11');
  assert.equal(L.nextDueDate('2026-12-28', rule({ freq: 'week', interval: 1 })), '2027-01-04', '沒指定星期＝7 天後');
});

test('重複規則：自訂文字、空的、沒到期日都不產生下一次', () => {
  assert.equal(L.nextDueDate('2026-10-11', '牌照稅'), '');
  assert.equal(L.nextDueDate('2026-10-11', ''), '');
  assert.equal(L.nextDueDate('', rule({ freq: 'day', interval: 1 })), '');
  assert.equal(L.parseRepeatRule('{"freq":"hour"}'), null);
});

test('重複規則：截止日期、次數限制', () => {
  const byDate = { freq: 'day', interval: 1, end: { type: 'date', date: '2026-10-12' } };
  assert.equal(L.applyRepeatEnd(byDate, rule(byDate), '2026-10-12').stop, false);
  assert.equal(L.applyRepeatEnd(byDate, rule(byDate), '2026-10-13').stop, true);
  const byCount = { freq: 'day', interval: 1, end: { type: 'count', count: 3 }, occurrence: 2 };
  const r = L.applyRepeatEnd(byCount, rule(byCount), '2026-10-12');
  assert.equal(r.stop, false);
  assert.equal(JSON.parse(r.nextRuleRaw).occurrence, 3);
  const last = Object.assign({}, byCount, { occurrence: 3 });
  assert.equal(L.applyRepeatEnd(last, rule(last), '2026-10-12').stop, true);
});

test('習慣：完成判斷與三級制等級；指定星期', () => {
  const tick = { '類型': '打勾' };
  assert.equal(L.isHabitDoneForDay(tick, 1), true);
  assert.equal(L.isHabitDoneForDay(tick, 0), false);
  const count = { '類型': '計數', '目標值': 8 };
  assert.equal(L.isHabitDoneForDay(count, 7), false);
  assert.equal(L.isHabitDoneForDay(count, 8), true);
  assert.equal(L.habitTierForValue(count, 8), null, '沒開三級制沒有等級');
  const tier = { '類型': '計數', '目標值': 8, '啟用分級': true, '基礎值': 4, '超標值': 10 };
  assert.equal(L.isHabitDoneForDay(tier, 4), true, '基礎以上就算完成');
  assert.deepEqual([3, 4, 8, 10].map((v) => L.habitTierForValue(tier, v)), [null, '基礎', '達標', '超標']);
  const wd = { '頻率類型': 'weekday', '星期幾': [1, 3] };
  assert.equal(L.isRequiredDay(wd, '2026-10-12'), true);
  assert.equal(L.isRequiredDay(wd, '2026-10-13'), false);
  assert.equal(L.isRequiredDay({ '頻率類型': 'daily' }, '2026-10-13'), true);
});

test('任務統計：逾期、即將到期、星標、已取消／已跳過不算', () => {
  const tasks = [
    { '狀態': '待辦', '到期日': '2026-10-10' }, // 逾期
    { '狀態': '待辦', '到期日': '2026-10-14', '星標': true }, // 即將到期＋星標
    { '狀態': '已完成', '到期日': '2026-10-01', '星標': true },
    { '狀態': '已取消', '到期日': '2026-10-01' },
    { '狀態': '已跳過', '到期日': '2026-10-12' },
    { '狀態': '待辦', '到期日': '2026-10-20' },
    { '狀態': '待辦' },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(L.taskStats(tasks, '2026-10-11', '2026-10-14'))), { total: 7, completed: 1, overdue: 1, dueSoon: 1, starredOpen: 1 });
});
