/**
 * 指紋／臉部登入（WebAuthn 的平台驗證器 + PRF 擴充）。
 *
 * 做法：啟用時手機驗一次指紋（或臉），驗證器回一把「只有驗證通過才拿得到」的 32 bytes 秘密（PRF），
 * 用它衍生 AES 金鑰把 PIN 加密後存在這台裝置的瀏覽器（localStorage wb.bio）。
 * 之後登入：再驗一次指紋 → 同一把秘密 → 解開 PIN → 走原本的 login（後端完全不用改，PIN 不會明文存）。
 * 指紋本身由作業系統保管，網頁拿不到；加密後的 PIN 沒有通過指紋驗證也解不開。
 *
 * 支援：Android Chrome、iOS 18+ 的 Safari／主畫面 PWA、Windows Hello、macOS Touch ID；
 * 瀏覽器不支援 PRF 時啟用會失敗並說明，照舊輸入 PIN。
 */
const LS_KEY = 'wb.bio';
const RP_NAME = '個人工作台';
const INFO = 'wb.bio.pin';

const b64u = {
  enc(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(s) { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/')); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; },
};
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

/** 這個瀏覽器有沒有 WebAuthn（還不代表裝置有指紋） */
export function isSupported() {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!window.isSecureContext && !!(crypto && crypto.subtle);
}
/** 裝置有沒有可用的指紋／臉部／PIN 之類的本機驗證 */
export async function isAvailable() {
  if (!isSupported()) return false;
  try { return !!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch (e) { return false; }
}
export function record() {
  try { const r = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); return r && r.id && r.ct && r.salt && r.iv ? r : null; } catch (e) { return null; }
}
export function isEnabled() { return !!record(); }
export function disable() { try { localStorage.removeItem(LS_KEY); } catch (e) { /* 忽略 */ } }

/** 啟用：建立平台憑證（跳指紋）、拿 PRF 秘密、把 PIN 加密存起來 */
export async function enroll(pin) {
  if (!isSupported()) throw new Error('這個瀏覽器不支援指紋／臉部登入');
  const salt = rand(32);
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { name: RP_NAME },
    user: { id: rand(16), name: RP_NAME, displayName: RP_NAME },
    challenge: rand(32),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    timeout: 60000,
    extensions: { prf: { eval: { first: salt } } },
  } });
  const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
  if (!ext.prf || !ext.prf.enabled) throw new Error('這支裝置的指紋功能不支援產生加密金鑰（PRF），無法啟用指紋登入；請更新系統或瀏覽器後再試');
  const id = b64u.enc(cred.rawId);
  let secret = ext.prf.results && ext.prf.results.first;
  if (!secret) secret = await assertSecret(id, salt); // 有些瀏覽器建立憑證時不給金鑰，要再驗一次才拿得到
  const rec = await sealPin(pin, secret, { id, salt: b64u.enc(salt) });
  localStorage.setItem(LS_KEY, JSON.stringify(rec));
  return rec;
}

/** 登入：驗指紋 → 解開 PIN */
export async function unlock() {
  const rec = record();
  if (!rec) throw new Error('這台裝置還沒啟用指紋登入');
  const secret = await assertSecret(rec.id, b64u.dec(rec.salt));
  return openPin(rec, secret);
}

/** PIN 變更後用同一個憑證重新加密（跳一次指紋）；失敗就停用，讓使用者重新啟用 */
export async function reseal(pin) {
  const rec = record();
  if (!rec) return null;
  try {
    const secret = await assertSecret(rec.id, b64u.dec(rec.salt));
    const next = await sealPin(pin, secret, { id: rec.id, salt: rec.salt, at: rec.at });
    localStorage.setItem(LS_KEY, JSON.stringify(next));
    return next;
  } catch (e) { disable(); throw e; }
}

async function assertSecret(id, salt) {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: rand(32),
    allowCredentials: [{ type: 'public-key', id: b64u.dec(id), transports: ['internal'] }],
    userVerification: 'required',
    timeout: 60000,
    extensions: { prf: { eval: { first: salt } } },
  } });
  const ext = a.getClientExtensionResults ? a.getClientExtensionResults() : {};
  const s = ext.prf && ext.prf.results && ext.prf.results.first;
  if (!s) throw new Error('這次驗證沒有拿到加密金鑰，無法解開 PIN');
  return s;
}

/** 把 WebAuthn 的錯誤翻成看得懂的話 */
export function friendly(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError') return '已取消，或這次指紋／臉部驗證沒有通過';
  if (name === 'InvalidStateError') return '這支裝置已經註冊過，請先停用再重新啟用';
  if (name === 'NotSupportedError') return '這個瀏覽器不支援指紋／臉部登入';
  if (name === 'SecurityError') return '這個網址不能使用指紋登入（需要 https）';
  if (name === 'OperationError') return '解不開存起來的 PIN，請停用後重新啟用指紋登入';
  return e && e.message ? e.message : '指紋／臉部驗證失敗';
}

// ---------- 純加密的部分（跟 WebAuthn 無關，方便測試） ----------
async function deriveKey(secret, saltBytes) {
  const km = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: new TextEncoder().encode(INFO) }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
/** 用 PRF 秘密把 PIN 加密成可以存的紀錄 */
export async function sealPin(pin, secret, { id, salt, at }) {
  const key = await deriveKey(secret, b64u.dec(salt));
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(pin)));
  return { v: 1, id, salt, iv: b64u.enc(iv), ct: b64u.enc(ct), at: at || new Date().toISOString().slice(0, 10) };
}
/** 用 PRF 秘密解開紀錄裡的 PIN；秘密不對會丟 OperationError */
export async function openPin(rec, secret) {
  const key = await deriveKey(secret, b64u.dec(rec.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(rec.iv) }, key, b64u.dec(rec.ct));
  return new TextDecoder().decode(pt);
}
