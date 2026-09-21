// 各頁共用的小元件
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { prefs } from '../store.js';
import { reloadAll } from '../app.js';

export function pageHead(title, ...extra) {
  const btn = h('button', { class: 'icon-btn', 'aria-label': '重新整理', title: '重新整理', onclick: (e) => reloadAll(e.currentTarget) }, icon('refresh'));
  return h('div', { class: 'page-head' }, h('h1', null, title), ...extra, btn);
}

/** 統計數字卡：[[標題, 數值, 小字?], ...] */
export function stats(items) {
  return h('div', { class: 'stat-grid' }, items.map(([k, v, small]) => h('div', { class: 'stat card' },
    h('div', { class: 'k' }, k), h('div', { class: 'v' }, String(v), small ? h('small', null, small) : null))));
}

export function section(title, ...children) {
  return h('section', { class: 'section' }, title ? h('h2', { class: 'section-title' }, title) : null, ...children);
}

export function empty(text, big) {
  return h('div', { class: 'empty' }, big ? h('div', { class: 'big' }, big) : null, text);
}

export function progress(pctValue, label) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pctValue) || 0)));
  return h('div', { class: 'progress' }, h('div', { class: 'bar' }, h('div', { class: 'fill', style: { width: p + '%' } })), h('span', { class: 'num' }, label || p + '%'));
}

export function badge(text, kind) { return h('span', { class: 'badge' + (kind ? ' ' + kind : '') }, text); }

/**
 * 篩選列的狀態記在這台裝置（下次打開同一頁還在）。
 * key：頁面代號；defaults：預設值。回傳 { get, set, reset }，set 後自動呼叫 rerender。
 */
export function viewState(key, defaults, rerender) {
  const cur = Object.assign({}, defaults, prefs.getView(key, {}));
  return {
    v: cur,
    set(patch) { Object.assign(cur, patch); prefs.setView(key, cur); rerender(); },
  };
}

export function searchBox(value, placeholder, onInput) {
  const inp = h('input', { type: 'search', value: value || '', placeholder, 'aria-label': placeholder });
  let t = null;
  inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => onInput(inp.value), 250); });
  return h('div', { class: 'search' }, icon('search'), inp);
}

/** 下拉篩選：options 是字串陣列或 [value, label] */
export function filterSelect(value, allLabel, options, onChange) {
  const opts = options.map((o) => (Array.isArray(o) ? o : [o, o]));
  if (value && !opts.some(([v]) => v === value)) opts.push([value, value]); // 目前選的值已不在清單時仍然保留
  return h('select', { onchange: (e) => onChange(e.target.value), 'aria-label': allLabel },
    h('option', { value: '' }, allLabel), opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
}

/** 表單用：下拉選單（第一個選項是「（未選）」） */
export function selectField(label, options, value, opts = {}) {
  const list = (options || []).map((o) => (Array.isArray(o) ? o : [o, o]));
  if (value && !list.some(([v]) => v === value)) list.push([value, value]);
  const sel = h('select', null, opts.noEmpty ? null : h('option', { value: '' }, opts.emptyLabel || '（未選）'), list.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  return { el: field(label, sel), get value() { return sel.value; }, input: sel };
}

export function textField(label, value, opts = {}) {
  const inp = opts.multiline
    ? h('textarea', { rows: opts.rows || 3, placeholder: opts.placeholder || '' }, value || '')
    : h('input', { type: opts.type || 'text', value: value ?? '', placeholder: opts.placeholder || '', min: opts.min, max: opts.max, inputmode: opts.inputmode });
  return { el: field(label, inp, opts.hint), get value() { return inp.value; }, input: inp };
}

export function field(label, control, hint) {
  // 只有單一輸入框才用 <label> 包起來；裡面是一排按鈕時用 <div>，免得點到空白處誤觸第一顆按鈕
  const tag = /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName) ? 'label' : 'div';
  return h(tag, { class: 'field' }, label ? h('span', { class: 'lbl' }, label) : null, control, hint ? h('div', { class: 'hint' }, hint) : null);
}

export function checkField(label, checked, onchange) {
  const inp = h('input', { type: 'checkbox', checked: !!checked, onchange });
  return { el: h('label', { class: 'check field' }, inp, h('span', null, label)), get checked() { return inp.checked; }, input: inp };
}

/** 多選（分類、標籤）：用可以點的膠囊按鈕 */
export function multiChips(label, options, selected) {
  const set = new Set(selected || []);
  const all = [...(options || [])];
  (selected || []).forEach((v) => { if (!all.includes(v)) all.push(v); });
  const wrap = h('div', { class: 'chips' }, all.length ? all.map((v) => {
    const b = h('button', { type: 'button', class: 'chip' + (set.has(v) ? ' on' : ''), onclick: () => { if (set.has(v)) set.delete(v); else set.add(v); b.classList.toggle('on', set.has(v)); } }, v);
    return b;
  }) : h('span', { class: 'muted small' }, '還沒有選項，可到「分類管理」新增'));
  return { el: field(label, wrap), get value() { return all.filter((v) => set.has(v)); } };
}

/** 單選膠囊（例如打卡方式、時段） */
export function segField(label, options, value, onPick) {
  let cur = value;
  const btns = options.map(([v, t]) => h('button', { type: 'button', class: v === cur ? 'on' : '', onclick: () => { cur = v; btns.forEach((b, i) => b.classList.toggle('on', options[i][0] === v)); if (onPick) onPick(v); } }, t));
  return { el: field(label, h('div', { class: 'seg' }, btns)), get value() { return cur; } };
}

/** 星期幾選擇器（0=週日） */
export function weekdayPicker(selected) {
  const set = new Set(selected || []);
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  const el = h('div', { class: 'wd-row' }, names.map((n, w) => {
    const b = h('button', { type: 'button', class: 'wd' + (set.has(w) ? ' on' : ''), onclick: () => { if (set.has(w)) set.delete(w); else set.add(w); b.classList.toggle('on', set.has(w)); } }, n);
    return b;
  }));
  return { el, get value() { return [...set].sort((a, b) => a - b); } };
}

/** 表單底部按鈕列 */
export function formFooter(sheetRef, onSave, opts = {}) {
  const save = h('button', { class: 'btn btn-primary', type: 'button', 'data-testid': 'form-save' }, opts.saveText || '儲存');
  save.addEventListener('click', () => onSave(save));
  const btns = [];
  if (opts.extra) btns.push(...opts.extra);
  btns.push(h('button', { class: 'btn', type: 'button', onclick: () => sheetRef.sheet.close() }, '取消'), save);
  return btns;
}

export function errorBanner() {
  const el = h('div', { class: 'notice bad', role: 'alert', style: { display: 'none', marginBottom: '10px' } });
  return { el, show(msg) { el.textContent = msg; el.style.display = msg ? '' : 'none'; if (msg) el.scrollIntoView({ block: 'nearest' }); } };
}
