/**
 * 網頁推播（Web Push）用的 VAPID 簽章（RFC 8292）。
 * Apps Script 沒有 WebCrypto，所以 P-256 橢圓曲線與 ECDSA 用 BigInt 自己算（V8 執行環境支援）；
 * HMAC / SHA-256 用 Utilities。簽章用 RFC 6979 的「決定性 k」，不需要亂數來源。
 * 推播本身不帶內容（省掉 RFC 8291 的加密）：手機收到推播後由 service worker 自己向後端拿當天的待辦摘要。
 * 金鑰只產生一次，存在 Script Properties（VAPID_KEYS）；換金鑰的話所有裝置都要重新訂閱。
 */
var WbWebPush = (function () {
  var P = BigInt('0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF');
  var A = P - BigInt(3);
  var B = BigInt('0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B');
  var N = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
  var GX = BigInt('0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296');
  var GY = BigInt('0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5');
  var ZERO = BigInt(0), ONE = BigInt(1), TWO = BigInt(2), THREE = BigInt(3), FOUR = BigInt(4), EIGHT = BigInt(8);
  var KEYS_PROP = 'VAPID_KEYS';

  // ---------- 位元組／編碼 ----------
  function mod(a, m) { var r = a % m; return r < ZERO ? r + m : r; }
  function modPow(b, e, m) {
    var r = ONE; b = mod(b, m);
    while (e > ZERO) { if (e & ONE) r = (r * b) % m; e >>= ONE; b = (b * b) % m; }
    return r;
  }
  function modInv(a, m) { return modPow(mod(a, m), m - TWO, m); } // m 是質數（費馬小定理）
  function bytesToBig(bytes) { var h = ''; for (var i = 0; i < bytes.length; i++) { var b = bytes[i] & 0xff; h += (b < 16 ? '0' : '') + b.toString(16); } return BigInt('0x' + (h || '0')); }
  function bigToBytes(x, len) {
    var h = x.toString(16); while (h.length < len * 2) h = '0' + h;
    var out = []; for (var i = 0; i < len; i++) out.push(parseInt(h.substr(i * 2, 2), 16));
    return out;
  }
  function signed(bytes) { return bytes.map(function (b) { b = b & 0xff; return b > 127 ? b - 256 : b; }); } // Apps Script 的 Byte[] 是有號的
  function unsigned(bytes) { var out = []; for (var i = 0; i < bytes.length; i++) out.push(bytes[i] & 0xff); return out; }
  function utf8(str) { return unsigned(Utilities.newBlob(str).getBytes()); }
  function sha256(bytes) { return unsigned(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, signed(bytes))); }
  function hmac(key, msg) { return unsigned(Utilities.computeHmacSha256Signature(signed(msg), signed(key))); }
  function b64url(bytes) { return Utilities.base64EncodeWebSafe(signed(bytes)).replace(/=+$/, ''); }
  function b64urlDecode(str) { var s = String(str || '').replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return unsigned(Utilities.base64Decode(s)); }
  function hex(bytes) { var h = ''; for (var i = 0; i < bytes.length; i++) { var b = bytes[i] & 0xff; h += (b < 16 ? '0' : '') + b.toString(16); } return h; }
  function fromHex(h) { var out = []; for (var i = 0; i < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16)); return out; }

  // ---------- P-256 點運算（Jacobian 座標，最後才做一次反元素）----------
  function jDouble(p) {
    if (p[2] === ZERO) return p;
    var X = p[0], Y = p[1], Z = p[2];
    var S = mod(FOUR * X * Y * Y, P);
    var Z2 = Z * Z, M = mod(THREE * X * X + A * Z2 * Z2, P);
    var X2 = mod(M * M - TWO * S, P);
    var Y2 = mod(M * (S - X2) - EIGHT * Y * Y * Y * Y, P);
    var Z3 = mod(TWO * Y * Z, P);
    return [X2, Y2, Z3];
  }
  function jAdd(p, q) {
    if (p[2] === ZERO) return q;
    if (q[2] === ZERO) return p;
    var Z1Z1 = p[2] * p[2], Z2Z2 = q[2] * q[2];
    var U1 = mod(p[0] * Z2Z2, P), U2 = mod(q[0] * Z1Z1, P);
    var S1 = mod(p[1] * q[2] * Z2Z2, P), S2 = mod(q[1] * p[2] * Z1Z1, P);
    if (U1 === U2) { if (S1 !== S2) return [ZERO, ONE, ZERO]; return jDouble(p); }
    var H = mod(U2 - U1, P), R = mod(S2 - S1, P);
    var HH = H * H, HHH = HH * H;
    var X3 = mod(R * R - HHH - TWO * U1 * HH, P);
    var Y3 = mod(R * (U1 * HH - X3) - S1 * HHH, P);
    var Z3 = mod(H * p[2] * q[2], P);
    return [X3, Y3, Z3];
  }
  function jMul(k, pt) {
    var r = [ZERO, ONE, ZERO], q = pt;
    while (k > ZERO) { if (k & ONE) r = jAdd(r, q); q = jDouble(q); k >>= ONE; }
    return r;
  }
  function toAffine(p) {
    if (p[2] === ZERO) return null;
    var zi = modInv(p[2], P), zi2 = zi * zi;
    return { x: mod(p[0] * zi2, P), y: mod(p[1] * zi2 * zi, P) };
  }
  function pubFromPriv(d) { return toAffine(jMul(d, [GX, GY, ONE])); }

  // ---------- ECDSA（RFC 6979 決定性 k）----------
  function deterministicK(d, h1) {
    var x = bigToBytes(d, 32);
    var V = [], K = [];
    for (var i = 0; i < 32; i++) { V.push(1); K.push(0); }
    K = hmac(K, V.concat([0], x, h1)); V = hmac(K, V);
    K = hmac(K, V.concat([1], x, h1)); V = hmac(K, V);
    for (var tries = 0; tries < 100; tries++) {
      V = hmac(K, V);
      var k = bytesToBig(V);
      if (k >= ONE && k < N) return k;
      K = hmac(K, V.concat([0])); V = hmac(K, V);
    }
    throw new Error('無法產生簽章用的 k');
  }
  /** 回傳 64 位元組 r‖s（JWT ES256 用的格式） */
  function sign(msgBytes, dHex) {
    var d = BigInt('0x' + dHex);
    var h1 = sha256(msgBytes);
    var z = bytesToBig(h1);
    for (var attempt = 0; attempt < 10; attempt++) {
      var k = deterministicK(d, attempt ? sha256(h1.concat([attempt])) : h1);
      var pt = toAffine(jMul(k, [GX, GY, ONE]));
      var r = mod(pt.x, N);
      if (r === ZERO) continue;
      var s = mod(modInv(k, N) * (z + r * d), N);
      if (s === ZERO) continue;
      if (s > N / TWO) s = N - s; // 低 s，各家驗證器都接受
      return bigToBytes(r, 32).concat(bigToBytes(s, 32));
    }
    throw new Error('簽章失敗');
  }

  // ---------- VAPID 金鑰 ----------
  function generateKeys() {
    // 熵：幾個 UUID（Java SecureRandom）＋時間，雜湊後取 256 位元；再縮到 [1, n-1]
    var seed = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid() + Date.now();
    var d = mod(bytesToBig(sha256(utf8(seed))), N - ONE) + ONE;
    var pub = pubFromPriv(d);
    return { d: hex(bigToBytes(d, 32)), x: hex(bigToBytes(pub.x, 32)), y: hex(bigToBytes(pub.y, 32)) };
  }
  function loadKeys() {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty(KEYS_PROP);
    if (raw) { try { var k = JSON.parse(raw); if (k && k.d && k.x && k.y) return k; } catch (e) { /* 重新產生 */ } }
    var keys = generateKeys();
    props.setProperty(KEYS_PROP, JSON.stringify(keys));
    return keys;
  }
  /** 給前端 pushManager.subscribe 用的 applicationServerKey（未壓縮公鑰 65 位元組，base64url） */
  function publicKey(keys) { keys = keys || loadKeys(); return b64url([4].concat(fromHex(keys.x), fromHex(keys.y))); }

  // ---------- VAPID 授權標頭 ----------
  function originOf(url) { var m = /^(https?:\/\/[^/]+)/.exec(String(url || '')); return m ? m[1] : ''; }
  function subject() {
    try { var email = Session.getEffectiveUser().getEmail(); if (email) return 'mailto:' + email; } catch (e) { /* 沒有權限就用網址 */ }
    return 'https://github.com/yuying1724/personal-workbench';
  }
  function jwt(audience, nowMs, keys) {
    keys = keys || loadKeys();
    var header = b64url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    var claims = b64url(utf8(JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject() })));
    var signingInput = header + '.' + claims;
    return signingInput + '.' + b64url(sign(utf8(signingInput), keys.d));
  }
  function authorization(endpoint, nowMs, keys) {
    keys = keys || loadKeys();
    return 'vapid t=' + jwt(originOf(endpoint), nowMs, keys) + ', k=' + publicKey(keys);
  }

  /**
   * 送一則「沒有內容」的推播（手機端會自己去拿摘要）。回傳 { code, ok, gone }：gone＝訂閱已失效（404／410），呼叫端應移除。
   * 需要 appsscript.json 的 script.external_request 權限。
   */
  function send(subscription, nowMs, opts) {
    opts = opts || {};
    var res = UrlFetchApp.fetch(subscription.endpoint, {
      method: 'post', payload: '', muteHttpExceptions: true,
      headers: { Authorization: authorization(subscription.endpoint, nowMs), TTL: String(opts.ttl || 86400), Urgency: opts.urgency || 'normal' },
    });
    var code = res.getResponseCode();
    return { code: code, ok: code >= 200 && code < 300, gone: code === 404 || code === 410, body: code >= 300 ? String(res.getContentText() || '').slice(0, 200) : '' };
  }

  return { sign: sign, pubFromPriv: pubFromPriv, generateKeys: generateKeys, loadKeys: loadKeys, publicKey: publicKey, jwt: jwt, authorization: authorization, send: send,
    b64url: b64url, b64urlDecode: b64urlDecode, sha256: sha256, utf8: utf8, hex: hex, bigToBytes: bigToBytes, KEYS_PROP: KEYS_PROP };
})();
