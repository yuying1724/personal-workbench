import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { prefs, notify } from '../store.js';
import * as api from '../api.js';
import * as bio from '../biometric.js';
import { withBusy, errorText } from '../ui.js';

/**
 * 日記的「進入前驗證」：其他頁面照常，只有打開日記（分頁、總覽的「寫今天的日記」、右下角＋）時先驗指紋／臉部，
 * 也可以改輸入 PIN（用這台裝置存的授權碼向後端驗，跟登入一樣）。
 * 只在這台裝置生效（localStorage wb.diaryLock）：'off' 不用；'0' 每次進入都驗；'5' / '15' 驗過後幾分鐘內不再問；'app' 驗過後到離開 App 為止。
 * 驗證通過的狀態只放在記憶體：重新載入 App 就要再驗一次。
 */
export const DIARY_LOCK_OPTIONS = [['0', '每次進入都驗'], ['5', '5 分鐘內不再問'], ['15', '15 分鐘內不再問'], ['app', '到離開 App 為止']];
export const DIARY_LOCK_DEFAULT = '5';

let unlockedAt = 0; // 0 = 還沒驗（或已經過期）

export function diaryLockMode() { return prefs.diaryLock || 'off'; }
export function isDiaryLockOn() { return diaryLockMode() !== 'off'; }

/** 現在進日記要不要先驗 */
export function diaryLocked() {
  const mode = diaryLockMode();
  if (mode === 'off') return false;
  if (!unlockedAt) return true;
  if (mode === 'app' || mode === '0') return false; // 這兩種靠 markHidden／markLeftDiary 清掉
  return Date.now() - unlockedAt > Number(mode) * 60000;
}
export function markDiaryUnlocked() { unlockedAt = Date.now(); }
export function relockDiary() { unlockedAt = 0; }
/** App 切到背景：「到離開 App 為止」的要重新驗 */
export function onAppHidden() { if (diaryLockMode() === 'app') unlockedAt = 0; }
/** 離開日記分頁：「每次進入都驗」的要重新驗 */
export function onLeaveDiary() { if (diaryLockMode() === '0') unlockedAt = 0; }

/**
 * 日記頁的鎖定面板：指紋（有啟用才有）＋改用 PIN。onUnlock 之後由呼叫端重畫。
 * autoBio：一進來就自動跳指紋（手動按鎖定／取消過就不自動跳，免得一直彈）
 */
export function diaryLockPanel({ onUnlock, autoBio = true }) {
  const err = h('div', { class: 'notice bad', role: 'alert', style: { display: 'none', marginBottom: '10px' } });
  const bioOn = bio.isEnabled() && bio.isSupported();
  const pinInput = h('input', { type: 'password', class: 'pin-input', inputmode: 'numeric', enterkeyhint: 'go', autocomplete: 'off', 'aria-label': 'PIN', placeholder: '••••••' });
  const pinBtn = h('button', { class: 'btn btn-block' + (bioOn ? '' : ' btn-primary'), type: 'submit', 'data-testid': 'diary-pin-submit' }, '用 PIN 解鎖');
  const pinForm = h('form', { novalidate: true, style: { display: bioOn ? 'none' : '' }, onsubmit: async (e) => {
    e.preventDefault();
    const pin = pinInput.value;
    if (!pin) { show('請輸入 PIN'); return; }
    await withBusy(pinBtn, async () => {
      try {
        // 跟登入一樣向後端驗 PIN（也順便換發工作階段碼，效期照這台裝置的設定）
        const r = await api.call('login', { token: prefs.token, pin, ttlMinutes: prefs.ttlMinutes });
        api.setSession(r.session, r.ttlMinutes);
        done();
      } catch (e2) { show(e2 && e2.code === 'AUTH_FAILED' ? 'PIN 不正確' : errorText(e2)); pinInput.value = ''; }
    });
  } }, h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'PIN'), pinInput), pinBtn);
  const bioBtn = bioOn ? h('button', { class: 'btn btn-primary btn-block bio-btn', type: 'button', 'data-testid': 'diary-bio' }, icon('fingerprint'), '用指紋／臉部解鎖') : null;
  const usePin = bioOn ? h('button', { type: 'button', class: 'link-btn', onclick: () => { pinForm.style.display = ''; pinInput.focus(); } }, '改用 PIN') : null;
  let finished = false;
  function show(msg) { err.style.display = msg ? '' : 'none'; mount(err, msg || ''); }
  function done() { if (finished) return; finished = true; markDiaryUnlocked(); onUnlock(); }
  async function tryBio(auto) {
    if (finished) return;
    await withBusy(bioBtn, async () => {
      try { await bio.unlock(); } catch (e) {
        if (!(auto && e && e.name === 'NotAllowedError')) show(bio.friendly(e)); // 自動跳的被取消就不報錯
        return;
      }
      done();
    });
  }
  if (bioBtn) bioBtn.onclick = () => tryBio(false);
  const el = h('div', { class: 'card diary-lock', 'data-testid': 'diary-lock' },
    h('div', { class: 'diary-lock-icon' }, icon('lock')),
    h('h2', null, '日記已鎖定'),
    h('p', { class: 'muted small' }, bioOn ? '驗證指紋／臉部後才會顯示內容。' : '輸入 PIN 後才會顯示內容。'),
    err, bioBtn, usePin ? h('div', { class: 'center', style: { marginTop: '6px' } }, usePin) : null, pinForm);
  if (bioOn && autoBio) setTimeout(() => tryBio(true), 150);
  else if (!bioOn) setTimeout(() => pinInput.focus(), 50);
  return el;
}

/** 從別的頁面要打開日記（例如總覽的「寫今天的日記」）：鎖著就先帶到日記頁驗證，回傳 false */
export function ensureDiaryAccess() {
  if (!diaryLocked()) return true;
  location.hash = '#/diary';
  return false;
}

/** 設定頁用：改模式（關掉時順便清掉已驗狀態） */
export function setDiaryLockMode(mode) {
  prefs.diaryLock = mode === 'off' ? null : mode;
  if (mode === 'off') unlockedAt = 0;
  notify();
}
