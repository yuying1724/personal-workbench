import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { prefs, state, notify, wipeDeviceData } from '../store.js';
import * as api from '../api.js';
import * as bio from '../biometric.js';
import * as push from '../push.js';
import { DIARY_LOCK_OPTIONS, DIARY_LOCK_DEFAULT, diaryLockMode, setDiaryLockMode } from './diarylock.js';
import { openSheet, toast, errorText, withBusy, confirmDialog } from '../ui.js';
import { lock } from '../app.js';
import { pageHead } from './common.js';

export function renderSettings(root) {
  const d = state.data;
  const meta = d.meta || {};
  const seg = (options, current, onPick) => h('div', { class: 'seg' }, options.map(([v, t]) => h('button', { type: 'button', class: current === v ? 'on' : '', onclick: () => onPick(v) }, t)));
  mount(root,
    pageHead('設定'),
    h('div', { class: 'stack' },
      h('div', { class: 'card' }, h('h2', null, '顯示'),
        h('div', { class: 'field' }, h('span', { class: 'lbl' }, '外觀'), seg([['auto', '跟隨系統'], ['light', '淺色'], ['dark', '深色']], prefs.theme, (v) => { prefs.theme = v; notify(); }))),
      h('div', { class: 'card' }, h('h2', null, '安全'),
        h('div', { class: 'row-flex wrap' },
          h('button', { class: 'btn btn-sm', onclick: openChangePin }, icon('lock'), '變更 PIN'),
          h('button', { class: 'btn btn-sm', onclick: () => lock('已鎖定', { autoBio: false }) }, icon('logout'), '鎖定並登出'),
          h('button', { class: 'btn btn-sm btn-danger', onclick: wipeThisDevice }, icon('trash'), '清除這台裝置的資料')),
        bioBlock(),
        diaryLockBlock(),
        h('div', { class: 'field', style: { marginTop: '12px' } }, h('span', { class: 'lbl' }, '這台裝置閒置多久要重新輸入 PIN'),
          seg(TTL_OPTIONS, prefs.ttlMinutes, (v) => setTtl(v))),
        h('p', { class: 'muted small' }, '時間越長越方便，但手機或電腦被別人拿到時，對方也能直接看到資料。公司或共用電腦建議選「1 小時」。'),
        h('p', { class: 'muted small', style: { marginBottom: 0 } }, `這台裝置：${meta.device || '（未命名）'}。要新增或撤銷裝置（例如家裡電腦、新手機），請在試算表選單「個人工作台」操作。`),
        h('p', { class: 'muted small', style: { marginBottom: 0 } }, '「鎖定並登出」之後，資料快取和裝置授權碼還留在這台裝置（下次只要輸入 PIN、而且秒開）。在公司或別人的電腦上用完，建議按「清除這台裝置的資料」。')),
      pushCard(),
      h('div', { class: 'card' }, h('h2', null, '資料'),
        meta.sheetUrl ? h('a', { class: 'btn btn-sm', href: meta.sheetUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), '開啟試算表') : null,
        h('p', { class: 'muted small', style: { marginBottom: 0 } }, '最後更新：' + (state.loadedAt ? state.loadedAt.toLocaleString('zh-TW') : '—'))),
      h('div', { class: 'card' }, h('h2', null, '關於'),
        h('dl', { class: 'kv' },
          h('dt', null, '版本'), h('dd', null, meta.version || '—'),
          h('dt', null, '後端'), h('dd', { class: 'mono' }, prefs.apiUrl.replace(/^https?:\/\//, '').slice(0, 60) + (prefs.apiUrl.length > 68 ? '…' : ''))),
        h('button', { class: 'btn btn-sm', style: { marginTop: '12px' }, onclick: reloadApp }, icon('refresh'), '清除快取並重新載入'))));
}

const TTL_OPTIONS = [[60, '1 小時'], [24 * 60, '1 天'], [7 * 24 * 60, '7 天'], [30 * 24 * 60, '30 天']];

async function setTtl(minutes) {
  const prev = prefs.ttlMinutes;
  prefs.ttlMinutes = minutes;
  notify();
  try {
    await api.call('set_session_ttl', { ttlMinutes: minutes });
    const label = (TTL_OPTIONS.find(([v]) => v === minutes) || [0, minutes + ' 分鐘'])[1];
    toast(`已設定：閒置 ${label}才需要重新輸入 PIN`);
  } catch (e) {
    prefs.ttlMinutes = prev;
    notify();
    if (e.code !== 'AUTH_REQUIRED') toast(errorText(e), { kind: 'bad' });
  }
}

async function reloadApp() {
  try {
    if ('serviceWorker' in navigator) (await navigator.serviceWorker.getRegistrations()).forEach((r) => r.unregister());
    if (window.caches) (await caches.keys()).forEach((k) => caches.delete(k));
  } catch (e) { /* 忽略 */ }
  location.reload();
}

function openChangePin() {
  const f = { oldPin: '', newPin: '', again: '' };
  const banner = h('div', { class: 'notice bad', role: 'alert', style: { display: 'none', marginBottom: '10px' } });
  const inp = (label, key) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), h('input', { type: 'password', autocomplete: 'off', inputmode: 'numeric', oninput: (e) => { f[key] = e.target.value; } }));
  const save = h('button', { class: 'btn btn-primary', type: 'button', onclick: async (e) => {
    banner.style.display = 'none';
    if (f.newPin !== f.again) { banner.style.display = ''; mount(banner, '兩次輸入的新 PIN 不一致'); return; }
    await withBusy(e.currentTarget, async () => {
      try { await api.call('changePin', { oldPin: f.oldPin, newPin: f.newPin }); }
      catch (err) { banner.style.display = ''; mount(banner, errorText(err)); return; }
      sheet.close();
      if (!bio.isEnabled()) { toast('PIN 已變更，其他裝置下次登入也要用新的 PIN'); return; }
      // 這台裝置有指紋登入：用新 PIN 重新加密（跳一次指紋）；失敗就停用，請使用者重新啟用
      try { await bio.reseal(f.newPin); toast('PIN 已變更，指紋登入已更新'); }
      catch (e2) { toast('PIN 已變更；指紋／臉部登入已停用，請到設定重新啟用'); }
      notify();
    });
  } }, '變更');
  const sheet = openSheet({ title: '變更 PIN', dismissable: false, body: h('div', null, banner, inp('目前的 PIN', 'oldPin'), inp('新的 PIN（至少 6 碼）', 'newPin'), inp('再輸入一次新的 PIN', 'again')),
    footer: [h('button', { class: 'btn', type: 'button', onclick: () => sheet.close() }, '取消'), save] });
}

// ---------- 推播通知（每支手機自己開；跟習慣的時段對齊，早上／中午／晚上／睡前各一則，沒事不推） ----------
let pushState = { loaded: false, loading: false, st: null };
// 每次畫設定頁都重新查一次（權限可能在瀏覽器設定裡改了）；查到的跟上次一樣就不重畫，避免一直循環
function reloadPush() {
  if (pushState.loading) return;
  pushState.loading = true;
  push.status().then((st) => {
    const changed = JSON.stringify(st) !== JSON.stringify(pushState.st);
    pushState = { loaded: true, loading: false, st };
    if (changed) notify();
  }).catch(() => { pushState.loading = false; });
}
function pushCard() {
  const title = h('h2', null, '通知');
  if (!push.isSupported()) {
    return h('div', { class: 'card', 'data-testid': 'push-card' }, title,
      h('p', { class: 'muted small', style: { margin: 0 } }, push.needsHomeScreen()
        ? 'iPhone 要先把這個網站「加入主畫面」（Safari 的分享鈕 › 加入主畫面），再從主畫面打開 App，這裡才會出現開啟通知的按鈕。'
        : '這個瀏覽器不支援推播通知。手機請用 Chrome（Android）或 Safari「加入主畫面」（iPhone）安裝成 App，再到這裡開啟。'));
  }
  reloadPush();
  const st = pushState.st;
  const hourSel = (cur, onchange) => h('select', { 'aria-label': '幾點推播', 'data-testid': 'push-hour', onchange }, push.HOURS.map((hh) => h('option', { value: String(hh), selected: hh === cur }, `${hh}:00`)));
  /** 四個時段各一列：開關＋時間（live=true 才真的送後端；還沒開啟時只是先選好） */
  const slotRows = (slots, live) => h('div', { class: 'push-slots', 'data-testid': 'push-slots' }, push.SLOTS.map((k) => {
    const cur = slots[k] || { on: true, hour: push.SLOT_INFO[k].hour };
    const chk = h('input', { type: 'checkbox', checked: cur.on !== false, 'data-testid': 'push-on-' + k, onchange: async (e) => {
      if (!live) { slots[k] = Object.assign({}, cur, { on: e.target.checked }); return; }
      try { await push.setSlot(k, { on: e.target.checked }); toast(e.target.checked ? `已開啟${push.SLOT_INFO[k].label}的提醒` : `已關閉${push.SLOT_INFO[k].label}的提醒`); }
      catch (err) { e.target.checked = !e.target.checked; toast(errorText(err), { kind: 'bad' }); }
      reloadPush();
    } });
    const sel = hourSel(cur.hour, async (e) => {
      if (!live) { slots[k] = Object.assign({}, cur, { hour: Number(e.target.value) }); return; }
      try { await push.setSlot(k, { hour: Number(e.target.value) }); toast(`${push.SLOT_INFO[k].label}改成 ${e.target.value} 點左右推播`); }
      catch (err) { e.target.value = String(cur.hour); toast(errorText(err), { kind: 'bad' }); }
      reloadPush();
    });
    sel.setAttribute('data-testid', 'push-hour-' + k);
    return h('div', { class: 'push-slot' },
      h('label', { class: 'check grow' }, chk, h('span', { class: 'grow' }, h('div', null, push.SLOT_INFO[k].label), h('div', { class: 'muted small' }, push.SLOT_INFO[k].hint))),
      sel);
  }));
  let body;
  if (!st) body = h('p', { class: 'muted small', style: { margin: 0 } }, '檢查中…');
  else if (st.enabled) {
    body = h('div', null,
      h('div', { class: 'bio-status', 'data-testid': 'push-status' }, icon('bell'), h('span', { class: 'grow small' }, '推播通知：已開啟（這支裝置）'),
        h('button', { class: 'btn btn-sm', 'data-testid': 'push-disable', onclick: async (e) => { await withBusy(e.currentTarget, async () => { await push.disable(); toast('已關閉推播通知'); reloadPush(); }); } }, '關閉')),
      slotRows(Object.assign({}, st.slots), true),
      h('div', { class: 'row-flex wrap', style: { marginTop: '8px' } },
        h('button', { class: 'btn btn-sm', 'data-testid': 'push-test', onclick: async (e) => {
          await withBusy(e.currentTarget, async () => {
            try { const r = await push.sendTest(); toast(`已送出測試通知（${r.summary.title}）`); }
            catch (err) { toast(errorText(err), { kind: 'bad' }); reloadPush(); }
          });
        } }, '發送測試通知')),
      h('p', { class: 'muted small', style: { margin: '6px 0 0' } }, '每個時段到了設定的時間檢查一次，那個時段有事才推一則；全部打卡完、任務做完就不推。點通知會直接打開 App。只在這支裝置生效；換手機要重新開啟。'));
  } else {
    const draft = Object.assign({}, st.slots);
    body = h('div', null,
      h('div', { class: 'bio-status', 'data-testid': 'push-status' }, icon('bell'), h('span', { class: 'grow small' }, st.permission === 'denied' ? '推播通知：這個網站的通知被封鎖了，請到瀏覽器的網站設定允許通知後再開啟' : '推播通知：未開啟'),
        h('button', { class: 'btn btn-sm btn-primary', 'data-testid': 'push-enable', disabled: st.permission === 'denied', onclick: async (e) => {
          await withBusy(e.currentTarget, async () => {
            try {
              const r = await push.enable(draft);
              toast(r.trigger === false ? '已開啟，但後端沒辦法自動安裝排程：請到試算表「個人工作台」選單執行「推播通知：安裝排程／授權」' : '已開啟，之後在設定的時段有事就會收到提醒');
            } catch (err) { toast(err && err.code ? errorText(err) : (err && err.message) || String(err), { kind: 'bad' }); }
            reloadPush();
          });
        } }, '開啟')),
      slotRows(draft, false),
      h('p', { class: 'muted small', style: { margin: '6px 0 0' } }, '開啟後，各時段到了設定的時間、那個時段有事（習慣還沒打卡、任務到期、訂閱要付款）才會推一則；沒事就不推。只在這支裝置生效；換手機要重新開啟。'));
  }
  return h('div', { class: 'card', 'data-testid': 'push-card' }, title, body);
}

// ---------- 指紋／臉部登入（只在這台裝置生效；PIN 用指紋驗證才拿得到的金鑰加密後存在瀏覽器裡） ----------
let bioAvail = null; // null = 還沒查
function bioBlock() {
  if (!bio.isSupported()) return null;
  if (bioAvail === null) { bioAvail = false; bio.isAvailable().then((ok) => { bioAvail = ok; notify(); }); }
  const rec = bio.record();
  if (rec) {
    return h('div', { class: 'bio-status', 'data-testid': 'bio-status' },
      icon('fingerprint'), h('span', { class: 'grow small' }, `指紋／臉部登入：已啟用（${rec.at}）`),
      h('button', { class: 'btn btn-sm', 'data-testid': 'bio-disable', onclick: async () => {
        if (!(await confirmDialog({ title: '停用指紋／臉部登入', message: '之後在這台裝置登入就要輸入 PIN。要停用嗎？', confirmText: '停用', danger: true }))) return;
        bio.disable(); toast('已停用指紋／臉部登入'); notify();
      } }, '停用'));
  }
  if (!bioAvail) return h('p', { class: 'muted small', style: { marginTop: '10px', marginBottom: 0 } }, '這台裝置沒有可用的指紋／臉部驗證，無法啟用指紋登入。');
  return h('div', { class: 'bio-status' },
    icon('fingerprint'), h('span', { class: 'grow small' }, '指紋／臉部登入：未啟用'),
    h('button', { class: 'btn btn-sm btn-primary', 'data-testid': 'bio-enable', onclick: openEnableBio }, '啟用'));
}

// ---------- 日記進入前驗證（只在這台裝置生效） ----------
function diaryLockBlock() {
  const mode = diaryLockMode();
  const on = mode !== 'off';
  const toggle = h('input', { type: 'checkbox', checked: on, 'data-testid': 'diary-lock-toggle', onchange: (e) => {
    setDiaryLockMode(e.target.checked ? DIARY_LOCK_DEFAULT : 'off');
    toast(e.target.checked ? '之後打開日記會先驗證指紋／臉部（或 PIN）' : '日記不再需要額外驗證');
  } });
  const sel = h('select', { 'aria-label': '驗證過後多久內不再問', 'data-testid': 'diary-lock-mode', onchange: (e) => { setDiaryLockMode(e.target.value); toast('已更新'); } },
    DIARY_LOCK_OPTIONS.map(([v, t]) => h('option', { value: v, selected: v === mode }, t)));
  return h('div', { class: 'diary-lock-setting' },
    h('label', { class: 'check', style: { marginTop: '10px' } }, toggle, h('span', { class: 'grow small' }, '打開日記前要先驗證指紋／臉部（或 PIN）')),
    on ? h('div', { class: 'row-flex', style: { marginTop: '6px' } }, h('span', { class: 'small muted nowrap' }, '驗證過後'), sel) : null,
    h('p', { class: 'muted small', style: { margin: '6px 0 0' } }, on
      ? '只擋這台裝置的畫面：任務、習慣等其他頁面照常，不會多問。試算表本身還是看得到日記。'
      : '開啟後，點「日記」分頁或「寫今天的日記」會先驗證；其他頁面不受影響。'));
}

function openEnableBio() {
  const banner = h('div', { class: 'notice bad', role: 'alert', style: { display: 'none', marginBottom: '10px' } });
  const pinInput = h('input', { type: 'password', autocomplete: 'off', inputmode: 'numeric', 'aria-label': '目前的 PIN' });
  const go = h('button', { class: 'btn btn-primary', type: 'button', 'data-testid': 'bio-enroll', onclick: async (e) => {
    banner.style.display = 'none';
    const pin = pinInput.value;
    if (!pin) { banner.style.display = ''; mount(banner, '請輸入目前的 PIN'); return; }
    await withBusy(e.currentTarget, async () => {
      try {
        const r = await api.call('login', { token: prefs.token, pin, ttlMinutes: prefs.ttlMinutes }); // 先確認 PIN 是對的，才拿去加密
        api.setSession(r.session, r.ttlMinutes);
      } catch (err) { banner.style.display = ''; mount(banner, err && err.code === 'AUTH_FAILED' ? 'PIN 不正確' : errorText(err)); return; }
      try { await bio.enroll(pin); }
      catch (err) { banner.style.display = ''; mount(banner, bio.friendly(err)); return; }
      sheet.close(); toast('已啟用，下次登入可以用指紋／臉部'); notify();
    });
  } }, '驗證並啟用');
  const sheet = openSheet({ title: '啟用指紋／臉部登入', body: h('div', null, banner,
    h('p', { class: 'muted small' }, '只在這台裝置生效。按「驗證並啟用」後手機會跳指紋／臉部驗證；PIN 會用驗證通過才拿得到的金鑰加密後存在這台裝置，沒有通過驗證解不開。之後登入時驗指紋就好，PIN 照舊可以用。'),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, '目前的 PIN'), pinInput)),
    footer: [h('button', { class: 'btn', type: 'button', onclick: () => sheet.close() }, '取消'), go] });
}

async function wipeThisDevice() {
  const ok = await confirmDialog({ title: '清除這台裝置的資料', message: '會刪除這台裝置上的裝置授權碼、登入狀態、資料快取、日記草稿與畫面設定，然後回到登入畫面。試算表裡的資料不受影響；之後要再用這台裝置，需要重新輸入裝置授權碼和 PIN。確定要清除嗎？', confirmText: '清除', danger: true });
  if (!ok) return;
  wipeDeviceData();
  try { if (window.caches) (await caches.keys()).forEach((k) => caches.delete(k)); } catch (e) { /* 忽略 */ }
  location.reload();
}
