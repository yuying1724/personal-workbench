import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { prefs } from '../store.js';
import * as api from '../api.js';
import * as bio from '../biometric.js';
import { withBusy, errorText } from '../ui.js';

/**
 * 登入畫面。第一次需要裝置授權碼；之後這台裝置只要輸入 PIN。
 * 設定裡啟用過指紋／臉部登入的裝置，會多一顆「用指紋／臉部登入」，打開畫面時也會自動跳一次驗證（autoBio 為 false 時不自動跳）。
 */
export function renderLogin(root, { onSuccess, message, autoBio = true }) {
  let changeToken = !prefs.token;
  let textPin = false;
  // 「閒置太久、已鎖定」這類例行訊息用一般提示色；真的出錯（PIN 錯、連不上）才用紅色
  const errBox = h('div', { class: 'notice', role: 'alert', style: { display: message ? '' : 'none', marginBottom: '12px' } }, message || '');

  function showError(msg, routine) { errBox.style.display = msg ? '' : 'none'; errBox.classList.toggle('bad', !!msg && !routine); mount(errBox, msg || ''); }

  const tokenInput = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX', 'aria-label': '裝置授權碼' });
  const pinInput = h('input', { type: 'password', class: 'pin-input', inputmode: 'numeric', enterkeyhint: 'go', autocomplete: 'off', 'aria-label': 'PIN', placeholder: '••••••' });
  const urlInput = h('input', { type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://script.google.com/macros/s/…/exec', value: prefs.apiUrl });
  const bioOn = bio.isEnabled() && bio.isSupported();
  const submit = h('button', { class: 'btn btn-block' + (bioOn ? '' : ' btn-primary'), type: 'submit' }, '登入');

  const tokenField = h('label', { class: 'field' }, h('span', { class: 'lbl' }, '裝置授權碼'), tokenInput,
    h('div', { class: 'hint' }, '這台裝置第一次使用時輸入一次就好。授權碼在試算表選單「個人工作台 → 新增裝置授權碼」產生。'));
  const savedNote = h('div', { class: 'muted small center', style: { marginBottom: '10px' } },
    '這台裝置已授權。', h('button', { type: 'button', class: 'link-btn', onclick: () => { changeToken = true; sync(); } }, '更換授權碼'));
  const pinToggle = h('button', { type: 'button', class: 'link-btn small', onclick: () => { textPin = !textPin; pinInput.setAttribute('inputmode', textPin ? 'text' : 'numeric'); pinInput.blur(); pinInput.focus(); } }, 'PIN 含英文字母？切換鍵盤');

  async function doLogin(token, pin, { fromBio } = {}) {
    const url = urlInput.value.trim();
    if (!url) { showError('請先展開「連線設定」，填入後端網址'); return false; }
    if (!/^https:\/\/|^\//.test(url)) { showError('後端網址必須以 https:// 開頭'); return false; }
    if (!token) { showError('請輸入裝置授權碼'); return false; }
    if (!pin) { showError('請輸入 PIN'); return false; }
    prefs.apiUrl = url;
    try {
      const r = await api.call('login', { token, pin, ttlMinutes: prefs.ttlMinutes });
      prefs.token = token;
      api.setSession(r.session, r.ttlMinutes);
      pinInput.value = '';
      onSuccess();
      return true;
    } catch (err) {
      if (fromBio && err && err.code === 'AUTH_FAILED') {
        bio.disable();
        showError('PIN 已經變更，指紋／臉部登入已停用；請輸入新的 PIN 登入，之後可到「設定」重新啟用');
      } else showError(errorText(err));
      pinInput.value = '';
      return false;
    }
  }

  // 指紋／臉部登入（這台裝置啟用過才顯示）
  const bioBtn = bioOn ? h('button', { class: 'btn btn-primary btn-block bio-btn', type: 'button', 'data-testid': 'bio-login' }, icon('fingerprint'), '用指紋／臉部登入') : null;
  async function bioLogin(auto) {
    if (!bioOn || !prefs.token || changeToken) return;
    await withBusy(bioBtn, async () => {
      let pin;
      try { pin = await bio.unlock(); } catch (e) {
        if (!(auto && e && e.name === 'NotAllowedError')) showError(bio.friendly(e)); // 自動跳的被取消就不報錯
        return;
      }
      await doLogin(prefs.token, pin, { fromBio: true });
    });
  }
  if (bioBtn) bioBtn.onclick = () => bioLogin(false);

  function sync() {
    tokenField.style.display = changeToken ? '' : 'none';
    savedNote.style.display = changeToken ? 'none' : '';
    if (bioBtn) bioBtn.parentElement.style.display = changeToken ? 'none' : '';
  }

  const form = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      showError('');
      const token = changeToken ? tokenInput.value.trim() : prefs.token;
      await withBusy(submit, () => doLogin(token, pinInput.value));
    },
  },
  errBox, tokenField, savedNote,
  bioBtn ? h('div', { class: 'bio-block' }, bioBtn, h('div', { class: 'or' }, '或輸入 PIN')) : null,
  h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'PIN'), pinInput, h('div', { style: { textAlign: 'right' } }, pinToggle)),
  submit,
  h('details', { class: 'adv', open: !prefs.apiUrl }, h('summary', null, '連線設定'),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, '後端網址（Apps Script 網頁應用程式）'), urlInput)));
  sync();

  mount(root, h('div', { class: 'login' }, h('div', { class: 'panel' },
    h('div', { class: 'logo' }, icon('clipboard')),
    h('h1', null, '個人工作台'),
    h('div', { class: 'sub' }, '請登入'),
    h('div', { class: 'card' }, form))));
  if (bioOn && !changeToken && autoBio) setTimeout(() => bioLogin(true), 150);
  else setTimeout(() => (changeToken ? tokenInput : pinInput).focus(), 50);
}
