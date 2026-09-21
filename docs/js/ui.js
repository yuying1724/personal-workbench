import { h, mount } from './dom.js';
import { icon } from './icons.js';

// ---------- Toast ----------
export function toast(message, opts = {}) {
  let root = document.getElementById('toast-root');
  let wrap = root.querySelector('.toast-wrap');
  if (!wrap) { wrap = h('div', { class: 'toast-wrap' }); root.appendChild(wrap); }
  const el = h('div', { class: 'toast' + (opts.kind === 'bad' ? ' bad' : ''), role: 'status' }, h('span', null, message));
  if (opts.action) el.appendChild(h('button', { onclick: () => { remove(); opts.action.fn(); } }, opts.action.label));
  wrap.appendChild(el);
  const timer = setTimeout(remove, opts.ms || (opts.action ? 6000 : opts.kind === 'bad' ? 5000 : 2800));
  function remove() { clearTimeout(timer); el.remove(); }
  return remove;
}

// ---------- 底部彈出視窗（手機）／置中對話框（電腦） ----------
const stack = [];
let seq = 0;
let marker = false; // 目前是否有一筆「視窗開啟中」的歷史紀錄
let selfBack = false; // 我們自己呼叫的 history.back() 還沒完成（此時不能再 pushState，否則順序會亂）
let selfBackTimer = null;

function pushMarker() { history.pushState({ sheetMarker: true }, ''); marker = true; }
function ensureMarker() { if (!marker && !selfBack) pushMarker(); }
function releaseMarker() {
  // 下一個 tick 如果沒有新的視窗接著開，才把那筆歷史紀錄退掉（連續開關視窗時不會亂）
  setTimeout(() => {
    if (stack.length || !marker) return;
    marker = false; selfBack = true;
    selfBackTimer = setTimeout(finishSelfBack, 500); // 萬一 popstate 沒有觸發，不要永遠卡住
    history.back();
  }, 0);
}
function finishSelfBack() {
  clearTimeout(selfBackTimer);
  if (!selfBack) return;
  selfBack = false;
  if (stack.length) pushMarker(); // 退歷史期間又開了新視窗：現在補上它的紀錄
}

window.addEventListener('popstate', () => {
  if (selfBack) { finishSelfBack(); return; }
  // 手機按「上一頁」：先關掉最上層的視窗，而不是離開 App
  if (!marker) return;
  marker = false;
  const top = stack[stack.length - 1];
  if (top) top.close({ fromPop: true });
  if (stack.length) ensureMarker();
});

export function openSheet({ title, body, footer, dismissable = true, onClose }) {
  const id = ++seq;
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': '關閉', onclick: () => api.close() }, icon('x'));
  const sheet = h('div', { class: 'sheet' + (footer ? ' has-foot' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' },
    h('div', { class: 'grab' }),
    title ? h('div', { class: 'sheet-head' }, h('h2', null, title), closeBtn) : null,
    body,
    footer ? h('div', { class: 'sheet-foot' }, footer) : null);
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay && dismissable) api.close(); } }, sheet);
  const onKey = (e) => { if (e.key === 'Escape' && stack[stack.length - 1] === api && dismissable) api.close(); };
  document.addEventListener('keydown', onKey);
  document.getElementById('modal-root').appendChild(overlay);
  ensureMarker();
  const api = {
    id, el: sheet, overlay,
    close(opts = {}) {
      if (!overlay.isConnected) return;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      const i = stack.indexOf(api); if (i >= 0) stack.splice(i, 1);
      if (!opts.fromPop && !stack.length) releaseMarker();
      if (onClose) onClose();
    },
  };
  stack.push(api);
  const first = sheet.querySelector('input:not([type=hidden]), select, textarea');
  if (first && window.matchMedia('(min-width: 700px)').matches) first.focus();
  return api;
}

export function closeAllSheets() {
  const wasMarker = marker;
  [...stack].reverse().forEach((s) => s.close({ fromPop: true }));
  marker = false; // 換頁時不需要退歷史紀錄
  void wasMarker;
}

export function confirmDialog({ title, message, confirmText = '確定', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const sheet = openSheet({
      title,
      body: h('p', { style: { margin: '0 0 12px' } }, message),
      footer: [
        h('button', { class: 'btn', onclick: () => { done(false); sheet.close(); } }, '取消'),
        h('button', { class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), onclick: () => { done(true); sheet.close(); } }, confirmText),
      ],
      onClose: () => done(false),
    });
  });
}

/** 執行非同步動作時鎖住按鈕、顯示轉圈；動作失敗時回傳 false 並顯示錯誤 */
export async function withBusy(button, fn) {
  const original = [...button.childNodes];
  button.disabled = true;
  mount(button, h('span', { class: 'spinner' }));
  try { return await fn(); } finally { button.disabled = false; mount(button, ...original); }
}

export function errorText(e) { return e && e.message ? e.message : '發生未知錯誤'; }

/** 取代 prompt()：回傳 Promise<string|null>（取消是 null） */
export function promptDialog({ title, label = '', value = '', confirmText = '確定' }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const input = h('input', { type: 'text', value, onkeydown: (e) => { if (e.key === 'Enter') { done(input.value); sheet.close(); } } });
    const sheet = openSheet({
      title,
      body: h('label', { class: 'field' }, label ? h('span', { class: 'lbl' }, label) : null, input),
      footer: [
        h('button', { class: 'btn', onclick: () => { done(null); sheet.close(); } }, '取消'),
        h('button', { class: 'btn btn-primary', onclick: () => { done(input.value); sheet.close(); } }, confirmText),
      ],
      onClose: () => done(null),
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}
