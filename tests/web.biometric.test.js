'use strict';
/** 指紋登入的加密部分：用 PRF 秘密加密／解開 PIN（WebAuthn 本身在 e2e 測） */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

async function load() {
  // 瀏覽器模組：Node 20+ 有 globalThis.crypto／btoa／atob，isSupported 用到的 window 沒有也沒關係
  return import(path.join(__dirname, '..', 'docs', 'js', 'biometric.js'));
}
const b64u = (buf) => Buffer.from(buf).toString('base64url');

test('sealPin／openPin：同一把秘密解得開、不同秘密或改過的密文解不開', async () => {
  const bio = await load();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const salt = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const rec = await bio.sealPin('135790', secret, { id: 'cred-1', salt });
  assert.equal(rec.v, 1); assert.equal(rec.id, 'cred-1'); assert.equal(rec.salt, salt);
  assert.match(rec.at, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!JSON.stringify(rec).includes('135790'), 'PIN 不能明文出現在紀錄裡');
  assert.equal(await bio.openPin(rec, secret), '135790');
  // 另一把秘密（例如別的憑證）解不開
  await assert.rejects(bio.openPin(rec, crypto.getRandomValues(new Uint8Array(32))));
  // 密文被動過也解不開
  const tampered = { ...rec, ct: rec.ct.slice(0, -2) + (rec.ct.endsWith('AA') ? 'BB' : 'AA') };
  await assert.rejects(bio.openPin(tampered, secret));
  // 同一個 PIN 每次加密的結果都不一樣（隨機 iv）
  const rec2 = await bio.sealPin('135790', secret, { id: 'cred-1', salt, at: rec.at });
  assert.notEqual(rec2.ct, rec.ct); assert.equal(rec2.at, rec.at);
});

test('PIN 含英文字母與中文也能加解密', async () => {
  const bio = await load();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));
  for (const pin of ['abc123', 'A1b2C3d4', '密碼123456']) {
    const rec = await bio.sealPin(pin, secret, { id: 'x', salt });
    assert.equal(await bio.openPin(rec, secret), pin);
  }
});
