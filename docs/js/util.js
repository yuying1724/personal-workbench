// 共用工具：日期、重複規則、習慣頻率、篩選排序（邏輯與舊版工作台相同）

/** 用本機時區組出 yyyy-MM-dd（不要用 toISOString，那是 UTC，台灣午夜~早上8點會差一天） */
export function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return localDateStr(d);
}
export function thisSundayStr() {
  const d = new Date();
  d.setDate(d.getDate() + (d.getDay() === 0 ? 0 : 7 - d.getDay()));
  return localDateStr(d);
}
export function daysUntilLabel(dateStr) {
  if (!dateStr) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const diff = Math.round((new Date(y, m - 1, d) - today) / 86400000);
  if (diff < 0) return '已過期';
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  return diff + ' 天後';
}
const WD_SHORT = ['日', '一', '二', '三', '四', '五', '六'];
export function dateLabel(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const sameYear = y === new Date().getFullYear();
  return `${sameYear ? '' : y + '/'}${m}/${d}（${WD_SHORT[dt.getDay()]}）`;
}

export const WEEKDAY_LABELS = WD_SHORT;
export const MOOD_OPTIONS = ['😄', '🙂', '😐', '😔', '😢'];
export const FIND_TYPE_OPTIONS = ['文章', 'Podcast', '書', 'YouTube影片', '實體物品', '課題', '其他'];
export const FIND_STATUS_CYCLE = ['', '已整理', '不需整理'];
export const HABIT_TIME_OPTIONS = ['早上', '中午', '晚上', '不限'];
export const HABIT_TIME_ICON = { '早上': 'sun', '中午': 'noon', '晚上': 'moon', '不限': 'clock' };
export const TASK_CLOSED = ['已完成', '已取消', '已跳過'];

// ---------- 任務重複規則 ----------
// 存成兩種格式：結構化 JSON {"freq":"day|week|month|year","interval":N,"weekdays":[0-6],"lastDayOfMonth":true,"end":{...},"occurrence":N}
// 或一般文字（自訂標籤，只是記錄用，後端不會自動產生下一筆）
export function decodeRepeatRule(raw) {
  const base = { freq: 'none', interval: 1, weekdays: [], lastDayOfMonth: false, end: { type: 'never' }, occurrence: 1 };
  if (!raw) return base;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && ['day', 'week', 'month', 'year'].includes(obj.freq)) {
      return {
        freq: obj.freq, interval: obj.interval || 1, weekdays: Array.isArray(obj.weekdays) ? obj.weekdays : [],
        lastDayOfMonth: !!obj.lastDayOfMonth, end: (obj.end && obj.end.type) ? obj.end : { type: 'never' }, occurrence: obj.occurrence || 1,
      };
    }
  } catch (e) { /* 不是 JSON，當自訂文字 */ }
  return Object.assign(base, { freq: 'custom', label: String(raw) });
}

export function encodeRepeatRule({ freq, interval, weekdays, customLabel, lastDayOfMonth, end, occurrence }) {
  if (freq === 'none') return '';
  if (freq === 'custom') return (customLabel || '').trim();
  const obj = { freq, interval: Math.max(1, parseInt(interval, 10) || 1) };
  if (freq === 'week' && weekdays && weekdays.length) obj.weekdays = weekdays.slice().sort((a, b) => a - b);
  if (freq === 'month' && lastDayOfMonth) obj.lastDayOfMonth = true;
  if (end) {
    if (end.type === 'date' && end.date) obj.end = { type: 'date', date: end.date };
    else if (end.type === 'count' && end.count) {
      obj.end = { type: 'count', count: Math.max(1, parseInt(end.count, 10) || 1) };
      if (occurrence && occurrence > 1) obj.occurrence = occurrence; // 編輯既有重複任務時保留目前是第幾次
    }
  }
  return JSON.stringify(obj);
}

export function repeatRuleLabel(raw) {
  const r = decodeRepeatRule(raw);
  if (r.freq === 'none') return '';
  if (r.freq === 'custom') return r.label;
  const unit = { day: '天', week: '週', month: '個月', year: '年' }[r.freq];
  let s;
  if (r.freq === 'month' && r.lastDayOfMonth) s = r.interval > 1 ? `每 ${r.interval} 個月的最後一天` : '每月最後一天';
  else s = r.interval > 1 ? `每 ${r.interval} ${unit}` : `每${r.freq === 'month' ? '月' : unit}`;
  if (r.freq === 'week' && r.weekdays.length) s += '（' + r.weekdays.map((w) => '週' + WD_SHORT[w]).join('、') + '）';
  if (r.end.type === 'date') s += `，到 ${r.end.date} 為止`;
  else if (r.end.type === 'count') s += `，共 ${r.end.count} 次（目前第 ${r.occurrence} 次）`;
  return s;
}

/** 能不能「跳過本次」：要有看得懂的重複規則，而且還沒結案 */
export function canSkipTask(t) {
  if (!t || TASK_CLOSED.includes(t['狀態'] || '')) return false;
  return ['day', 'week', 'month', 'year'].includes(decodeRepeatRule(t['重複規則']).freq);
}

// ---------- 習慣 ----------
export function habitFreqLabel(h) {
  if (h['頻率類型'] === 'weekday') {
    const wd = (h['星期幾'] || []).slice().sort((a, b) => a - b).map((w) => WD_SHORT[w]);
    return wd.length ? `每週${wd.join('、')}` : '指定星期（未選）';
  }
  if (h['頻率類型'] === 'weeklyCount') return `每週 ${Number(h['每週次數']) || 1} 次`;
  return '每天';
}

// ---------- 篩選／排序 ----------
export function uniqueValues(rows, key, isArray) {
  const set = new Set();
  rows.forEach((r) => {
    const v = r[key];
    if (isArray) (v || []).forEach((x) => x && set.add(x));
    else if (v) set.add(v);
  });
  return [...set].sort((a, b) => String(a).localeCompare(String(b), 'zh-Hant'));
}

export function sortRows(rows, key, dir = 1) {
  if (!key) return rows;
  return [...rows].sort((a, b) => {
    let va = a[key], vb = b[key];
    if (Array.isArray(va)) va = va.join('、');
    if (Array.isArray(vb)) vb = vb.join('、');
    if (typeof va === 'number' || typeof vb === 'number') return ((Number(va) || 0) - (Number(vb) || 0)) * dir;
    va = (va ?? '').toString(); vb = (vb ?? '').toString();
    if (!va && vb) return 1; // 空值永遠排最後
    if (va && !vb) return -1;
    return va.localeCompare(vb, 'zh-Hant') * dir;
  });
}

export const money = (n) => '$' + (Number(n) || 0).toLocaleString('zh-TW', { maximumFractionDigits: 2 });
export const pct = (n) => Math.round(Number(n) || 0);
