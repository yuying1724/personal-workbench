import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { prefs } from '../store.js';
import * as api from '../api.js';
import { withBusy, errorText } from '../ui.js';

/** 登入畫面。第一次需要裝置授權碼；之後這台裝置只要輸入 PIN。 */
export function renderLogin(root, { onSuccess, message }) {
  let changeToken = !prefs.token;
  let textPin = false;
  const errBox = h('div', { class: 'notice bad', role: 'alert', style: { display: message ? '' : 'none', marginBottom: '12px' } }, message || '');

  function showError(msg) { errBox.style.display = msg ? '' : 'none'; mount(errBox, msg || ''); }

  const tokenInput = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX', 'aria-label': '裝置授權碼' });
  const pinInput = h('input', { type: 'password', class: 'pin-input', inputmode: 'numeric', autocomplete: 'off', 'aria-label': 'PIN', placeholder: '••••••' });
  const urlInput = h('input', { type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://script.google.com/macros/s/…/exec', value: prefs.apiUrl });
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, '登入');

  const tokenField = h('label', { class: 'field' }, h('span', { class: 'lbl' }, '裝置授權碼（這台裝置第一次使用時輸入，在試算表選單「個人工作台 → 新增裝置授權碼」產生）'), tokenInput);
  const savedNote = h('div', { class: 'muted small center', style: { marginBottom: '10px' } },
    '這台裝置已授權。', h('button', { type: 'button', class: 'link-btn', onclick: () => { changeToken = true; sync(); } }, '更換授權碼'));
  const pinToggle = h('button', { type: 'button', class: 'link-btn small', onclick: () => { textPin = !textPin; pinInput.setAttribute('inputmode', textPin ? 'text' : 'numeric'); pinInput.blur(); pinInput.focus(); } }, 'PIN 含英文字母？切換鍵盤');

  function sync() {
    tokenField.style.display = changeToken ? '' : 'none';
    savedNote.style.display = changeToken ? 'none' : '';
  }
  sync();

  const form = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      showError('');
      const token = changeToken ? tokenInput.value.trim() : prefs.token;
      const pin = pinInput.value;
      const url = urlInput.value.trim();
      if (!url) { showError('請先展開「連線設定」，填入後端網址'); return; }
      if (!/^https:\/\/|^\//.test(url)) { showError('後端網址必須以 https:// 開頭'); return; }
      if (!token) { showError('請輸入裝置授權碼'); return; }
      if (!pin) { showError('請輸入 PIN'); return; }
      prefs.apiUrl = url;
      await withBusy(submit, async () => {
        try {
          const r = await api.call('login', { token, pin });
          prefs.token = token;
          api.setSession(r.session, r.ttlMinutes);
          pinInput.value = '';
          onSuccess();
        } catch (err) {
          showError(errorText(err));
          pinInput.value = '';
        }
      });
    },
  },
  errBox, tokenField, savedNote,
  h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'PIN'), pinInput, h('div', { style: { textAlign: 'right' } }, pinToggle)),
  submit,
  h('details', { class: 'adv', open: !prefs.apiUrl }, h('summary', null, '連線設定'),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, '後端網址（Apps Script 網頁應用程式）'), urlInput)));

  mount(root, h('div', { class: 'login' }, h('div', { class: 'panel' },
    h('div', { class: 'logo' }, icon('clipboard')),
    h('h1', null, '個人工作台'),
    h('div', { class: 'sub' }, '請登入'),
    h('div', { class: 'card' }, form))));
  setTimeout(() => (changeToken ? tokenInput : pinInput).focus(), 50);
}
