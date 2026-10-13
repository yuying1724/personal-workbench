// 習慣打卡熱力圖（像 GitHub 的綠色格子）：一欄＝一週（週日～週六），顏色深淺＝那天做到的程度。
// 資料來源是後端在每個習慣上附的「打卡紀錄」（近一年、只有打過卡的日子：{ 'yyyy-MM-dd': 數值 }）。
import { h } from '../dom.js';
import { localDateStr, dateLabel } from '../util.js';
import WbLogic from '../shared-logic.js';

const WD = ['日', '一', '二', '三', '四', '五', '六'];

function parse(ds) { const [y, m, d] = String(ds).split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function hasNum(v) { return v !== '' && v != null; }

/** 這天是不是這個習慣該做的日子（跟後端同一份：shared/logic.js） */
export function isRequiredDay(hb, ds) { return WbLogic.isRequiredDay(hb, ds); }

/** 0＝沒做；1～4 越深做得越多。打勾型做了就是 4；三級制：未達基礎 1／基礎 2／達標 3／超標 4 */
export function habitLevel(hb, value) {
  const v = Number(value) || 0;
  if (v <= 0) return 0;
  if (hb['類型'] !== '計數') return 4;
  const target = Number(hb['目標值']) || 1;
  if (hb['啟用分級'] === true) {
    if (hasNum(hb['超標值']) && v >= Number(hb['超標值'])) return 4;
    if (v >= target) return 3;
    if (hasNum(hb['基礎值']) && v >= Number(hb['基礎值'])) return 2;
    return 1;
  }
  if (v >= target) return 4;
  return v / target >= 0.66 ? 3 : v / target >= 0.33 ? 2 : 1;
}

export function valueText(hb, value) {
  const v = Number(value) || 0;
  if (hb['類型'] !== '計數') return v > 0 ? '已完成' : '沒有打卡';
  return v > 0 ? `${v}${hb['單位'] || ''}` : '沒有紀錄';
}

/** 近 N 天（含今天）完成的天數，用跟後端一樣的「完成」判斷 */
export function doneDays(hb, days, doneFor) {
  const log = hb['打卡紀錄'] || {};
  const from = localDateStr(addDays(new Date(), -(days - 1)));
  return Object.keys(log).filter((ds) => ds >= from && doneFor(hb, log[ds])).length;
}

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 一次用字串組出整張格子（比一格一格建 DOM 快好幾倍；21 個習慣 × 371 格在手機上差很多）。文字都有跳脫。 */
function gridHtml(hb, opts, weeks, today) {
  const log = hb['打卡紀錄'] || {};
  const start = addDays(parse(today), -parse(today).getDay() - (weeks - 1) * 7); // 第一欄的週日
  const tag = opts.onPick ? 'button' : 'span';
  let cells = '';
  let months = '';
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const weekStart = addDays(start, w * 7);
    const m = weekStart.getMonth();
    if (opts.labels) months += `<span class="hm-month">${m !== lastMonth && w < weeks - 1 ? m + 1 + '月' : ''}</span>`;
    lastMonth = m;
    for (let d = 0; d < 7; d++) {
      const ds = localDateStr(addDays(weekStart, d));
      if (ds > today) { cells += '<span class="hm-cell future" aria-hidden="true"></span>'; continue; }
      const v = log[ds];
      const level = habitLevel(hb, v);
      const off = !level && !isRequiredDay(hb, ds);
      const cls = 'hm-cell l' + level + (off ? ' off' : '') + (ds === today ? ' today' : '') + (ds === opts.selected ? ' sel' : '');
      const label = esc(`${dateLabel(ds)}：${off ? '不用做的日子' : valueText(hb, v)}`);
      cells += tag === 'button'
        ? `<button type="button" class="${cls}" data-ds="${ds}" title="${label}" aria-label="${label}"></button>`
        : `<span class="${cls}" title="${label}"></span>`;
    }
  }
  return { cells, months };
}

/**
 * 產生熱力圖。
 * opts.weeks：顯示幾週（最後一欄是本週）；opts.size：'sm' | 'lg'
 * opts.labels：顯示月份與星期標籤；opts.selected：被選取的日期；opts.onPick(ds)：點格子（有給才會是按鈕）
 * opts.lazy：先放一個同樣高度的空位，捲到看得見時才畫（習慣很多時，開啟習慣頁不用一次畫幾千格）
 */
export function heatmap(hb, opts = {}) {
  const weeks = opts.weeks || 18;
  const scroller = h('div', { class: 'hm-scroll hm-' + (opts.size || 'sm') });
  const build = () => {
    const today = localDateStr(new Date());
    const { cells, months } = gridHtml(hb, opts, weeks, today);
    const grid = h('div', { class: 'hm-grid' });
    grid.innerHTML = cells; // 只有程式自己組的 class／日期／跳脫過的文字
    if (opts.onPick) grid.addEventListener('click', (e) => { const b = e.target.closest('button[data-ds]'); if (b) opts.onPick(b.dataset.ds); });
    let body = grid;
    if (opts.labels) {
      const monthsEl = h('div', { class: 'hm-months' });
      monthsEl.innerHTML = months;
      body = h('div', { class: 'hm-wrap' },
        h('div', { class: 'hm-wd' }, WD.map((t, i) => h('span', null, i % 2 ? t : ''))),
        h('div', null, monthsEl, grid));
    }
    scroller.replaceChildren(body);
    // 最新的一週在最右邊：畫面出現後捲到最右
    requestAnimationFrame(() => { scroller.scrollLeft = scroller.scrollWidth; });
  };
  if (opts.lazy && 'IntersectionObserver' in window) {
    scroller.appendChild(h('div', { class: 'hm-placeholder' }));
    lazyObserver().observe(scroller);
    scroller._build = build;
  } else build();
  return scroller;
}

let observer = null;
function lazyObserver() {
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting && en.target._build) { en.target._build(); en.target._build = null; observer.unobserve(en.target); } });
    }, { rootMargin: '300px 0px' }); // 快捲到前 300px 就先畫，不會看到空白
  }
  return observer;
}

export function heatLegend() {
  return h('div', { class: 'hm-legend muted small' }, '少',
    [0, 1, 2, 3, 4].map((l) => h('span', { class: 'hm-cell l' + l })), '多',
    h('span', { class: 'hm-cell off', style: { marginLeft: '10px' } }), '不用做');
}
