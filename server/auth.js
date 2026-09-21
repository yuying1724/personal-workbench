/**
 * 登入與工作階段：
 *  - 裝置授權碼（每台裝置一組，可個別撤銷）+ PIN，兩者都只存「加鹽雜湊」在 Script Properties
 *  - 授權碼正確但 PIN 錯誤才計入失敗次數（5 次鎖定 15 分鐘）。授權碼錯誤不計次，
 *    這樣不知道授權碼的人無法靠亂試把你鎖在門外。
 *  - 工作階段碼 = 裝置ID.發出時間.到期時間.效期.HMAC簽章；每次請求後若剩餘不到一半效期就自動續期
 */
var WbAuth = (function () {
  var DEVICES_KEY = 'DEVICES', PIN_KEY = 'PIN', HMAC_KEY = 'HMAC_KEY';
  var TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易看錯的 I O 0 1
  var MIN_PIN_LENGTH = 6;

  function props() { return PropertiesService.getScriptProperties(); }

  function toHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i] & 0xff; // Apps Script 回傳有號位元組
      out += (b < 16 ? '0' : '') + b.toString(16);
    }
    return out;
  }
  function sha256Hex(str) { return toHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str)); }
  function hmacHex(message, key) { return toHex(Utilities.computeHmacSha256Signature(message, key)); }

  function constEq(a, b) {
    a = String(a); b = String(b);
    var diff = a.length === b.length ? 0 : 1;
    var n = Math.max(a.length, b.length);
    for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
  }

  function randomHex(n) {
    var out = '';
    while (out.length < n) out += Utilities.getUuid().replace(/-/g, '');
    return out.slice(0, n);
  }

  function generateToken() {
    var hex = randomHex(64), chars = '';
    for (var i = 0; i < 20; i++) chars += TOKEN_ALPHABET.charAt(parseInt(hex.substr(i * 2, 2), 16) & 31);
    return chars.replace(/(.{5})(?=.)/g, '$1-'); // XXXXX-XXXXX-XXXXX-XXXXX
  }
  function normalizeToken(t) { return String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  function loadDevices() {
    var raw = props().getProperty(DEVICES_KEY);
    if (!raw) return [];
    try { return JSON.parse(raw); } catch (e) { return []; }
  }
  function saveDevices(list) { props().setProperty(DEVICES_KEY, JSON.stringify(list)); }

  function hmacKey() {
    var k = props().getProperty(HMAC_KEY);
    if (!k) throw WbFail('NOT_INITIALIZED', '尚未完成登入設定：請在試算表選單「個人工作台 → 第一次設定」');
    return k;
  }

  // ---------- 設定（選單使用） ----------
  function addDevice(name) {
    name = String(name || '').trim().slice(0, 30) || '未命名裝置';
    var list = loadDevices();
    var max = 0;
    list.forEach(function (d) { var n = parseInt(String(d.id).slice(1), 10); if (n > max) max = n; });
    var token = generateToken();
    var salt = randomHex(16);
    var dev = { id: 'D' + (max + 1), name: name, salt: salt, hash: sha256Hex(salt + ':' + normalizeToken(token)), createdAt: wbTimestamp_(WbClock.now()) };
    list.push(dev);
    saveDevices(list);
    return { id: dev.id, name: dev.name, token: token };
  }
  function listDevices() {
    return loadDevices().map(function (d) { return { id: d.id, name: d.name, createdAt: d.createdAt }; });
  }
  function revokeDevice(id) {
    var list = loadDevices();
    var next = list.filter(function (d) { return d.id !== id; });
    if (next.length === list.length) return false;
    saveDevices(next);
    return true;
  }
  function pinPolicyError(pin) {
    pin = String(pin || '');
    if (pin.length < MIN_PIN_LENGTH) return 'PIN 至少要 ' + MIN_PIN_LENGTH + ' 碼';
    if (/^(.)\1+$/.test(pin)) return 'PIN 不能全部是同一個字元';
    return '';
  }
  function setPin(pin) {
    var bad = pinPolicyError(pin);
    if (bad) throw WbFail('WEAK_PIN', bad);
    var salt = randomHex(16);
    props().setProperty(PIN_KEY, JSON.stringify({ salt: salt, hash: sha256Hex(salt + ':' + String(pin)) }));
  }
  function hasPin() { return !!props().getProperty(PIN_KEY); }
  function checkPin(pin) {
    var raw = props().getProperty(PIN_KEY);
    if (!raw) return false;
    var rec = JSON.parse(raw);
    return constEq(sha256Hex(rec.salt + ':' + String(pin === null || pin === undefined ? '' : pin)), rec.hash);
  }
  function signOutAll() { props().setProperty(HMAC_KEY, randomHex(48)); }
  /** 第一次使用時產生簽章金鑰（已存在就不動） */
  function ensureKey() { if (!props().getProperty(HMAC_KEY)) props().setProperty(HMAC_KEY, randomHex(48)); }

  // ---------- 登入 ----------
  function numSetting(settings, key, def, min, max) {
    var n = Number(settings && settings[key]);
    if (!isFinite(n) || n <= 0) n = def;
    return Math.min(max, Math.max(min, n));
  }

  function issueSession(device, ttlMs, nowMs) {
    var payload = [device.id, nowMs, nowMs + ttlMs, ttlMs].join('.');
    return payload + '.' + hmacHex(payload, hmacKey());
  }

  function login(token, pin, settings) {
    var now = WbClock.now();
    var tok = normalizeToken(token);
    var match = null;
    loadDevices().forEach(function (d) {
      if (constEq(sha256Hex(d.salt + ':' + tok), d.hash)) match = d;
    });
    if (!match) {
      Utilities.sleep(700); // 拖慢亂猜
      throw WbFail('AUTH_FAILED', '授權碼或 PIN 錯誤');
    }
    var cache = CacheService.getScriptCache();
    var maxFails = numSetting(settings, '失敗鎖定次數', 5, 3, 20);
    var lockSec = numSetting(settings, '鎖定分鐘', 15, 1, 360) * 60;
    var lockKey = 'lock:' + match.id, failKey = 'fail:' + match.id;
    var until = Number(cache.get(lockKey) || 0);
    if (until > now) {
      var wait = Math.ceil((until - now) / 60000);
      throw WbFail('LOCKED', '嘗試次數過多，請 ' + wait + ' 分鐘後再試', { retryAfterSec: Math.ceil((until - now) / 1000) });
    }
    if (!hasPin()) throw WbFail('NOT_INITIALIZED', 'PIN 尚未設定：請在試算表選單「個人工作台 → 設定或變更 PIN」');
    if (!checkPin(pin)) {
      var fails = Number(cache.get(failKey) || 0) + 1;
      if (fails >= maxFails) {
        cache.put(lockKey, String(now + lockSec * 1000), lockSec);
        cache.remove(failKey);
        throw WbFail('LOCKED', '輸入錯誤次數過多，已鎖定 ' + Math.round(lockSec / 60) + ' 分鐘', { retryAfterSec: lockSec });
      }
      cache.put(failKey, String(fails), lockSec);
      throw WbFail('AUTH_FAILED', '授權碼或 PIN 錯誤（還可以再試 ' + (maxFails - fails) + ' 次）', { remaining: maxFails - fails });
    }
    cache.remove(failKey);
    var ttlMs = numSetting(settings, '閒置登出分鐘', 60, 5, 720) * 60000;
    return { session: issueSession(match, ttlMs, now), device: { id: match.id, name: match.name }, ttlMinutes: Math.round(ttlMs / 60000) };
  }

  /** 驗證工作階段碼，回傳 {deviceId, deviceName, ttlMs, expMs}；失敗丟出 AUTH_REQUIRED */
  function verifySession(session, nowMs) {
    var fail = function () { return WbFail('AUTH_REQUIRED', '登入已過期，請重新登入'); };
    if (!session || typeof session !== 'string') throw fail();
    var parts = session.split('.');
    if (parts.length !== 5) throw fail();
    var payload = parts.slice(0, 4).join('.');
    var key;
    try { key = hmacKey(); } catch (e) { throw fail(); }
    if (!constEq(hmacHex(payload, key), parts[4])) throw fail();
    var exp = Number(parts[2]), ttl = Number(parts[3]);
    if (!(exp > nowMs)) throw fail();
    var dev = null;
    loadDevices().forEach(function (d) { if (d.id === parts[0]) dev = d; });
    if (!dev) throw fail(); // 裝置已被撤銷
    return { deviceId: dev.id, deviceName: dev.name, ttlMs: ttl, expMs: exp };
  }

  /** 剩餘不到一半效期就換發新的（滑動視窗） */
  function refreshIfNeeded(sess, nowMs) {
    if (sess.expMs - nowMs >= sess.ttlMs / 2) return null;
    return issueSession({ id: sess.deviceId }, sess.ttlMs, nowMs);
  }

  return {
    addDevice: addDevice, listDevices: listDevices, revokeDevice: revokeDevice, setPin: setPin, hasPin: hasPin, checkPin: checkPin,
    pinPolicyError: pinPolicyError, signOutAll: signOutAll, ensureKey: ensureKey, login: login, verifySession: verifySession, refreshIfNeeded: refreshIfNeeded,
    randomHex: randomHex, generateToken: generateToken, constEq: constEq, MIN_PIN_LENGTH: MIN_PIN_LENGTH,
  };
})();
