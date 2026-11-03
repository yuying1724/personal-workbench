'use strict';
/** 推播通知：VAPID 簽章（用 Node 的 WebCrypto 驗證我們自己算的 P-256／ECDSA）、訂閱與四個時段的設定、每小時排程、各時段摘要 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadBackend } = require('./helpers/backend.js');

// 後端讀習慣／任務時的「今天」用的是真實時間（台北），所以測試資料的日期也用真實的今天
const tw = (offset) => { const d = new Date(Date.now() + 8 * 3600000); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const TODAY = tw(0);
const atHour = (b, hm, day = TODAY) => { b.state.clock.now = new Date(day + 'T' + hm + ':00+08:00').getTime(); };
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: 'BPx', auth: 'au' } };
const b64urlToBuf = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function fresh() {
  const b = loadBackend().setup();
  atHour(b, '09:00'); b.login();
  return b;
}
/** 她實際的習慣樣貌：早上／中午／晚上／不限各幾個 */
function seedHabits(b) {
  const mk = (name, time, extra) => b.call('create_habit', Object.assign({ '習慣名稱': name, '類型': '打勾', '頻率類型': 'daily', '時段': time }, extra || {})).data.id;
  const ids = {
    water: mk('喝水700cc', '早上'), cal: mk('確認行事曆', '早上'), focus: mk('確認每日焦點任務', '早上'),
    noonWater: mk('喝水700cc（午）', '中午'), vitamin: mk('營養補充品', '中午'),
    diary: mk('填寫日記', '晚上'), ledger: mk('記帳', '晚上'),
    read: mk('閱讀', '不限'), walk: mk('運動-步行', '不限', { '頻率類型': 'weeklyCount', '每週次數': 3 }),
    archived: mk('舊習慣', '早上'),
  };
  b.call('update_habit', { '習慣ID': ids.archived, '習慣名稱': '舊習慣', '類型': '打勾', '頻率類型': 'daily', '時段': '早上', '狀態': '封存' });
  return ids;
}

test('P-256／ECDSA：自己算的公鑰跟 Node 一致，簽章能用 Node 驗證（RFC 6979 決定性簽章）', () => {
  const b = loadBackend();
  const W = b.ctx.WbWebPush;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const d = b64urlToBuf(jwk.d).toString('hex');
  const pub = W.pubFromPriv(BigInt('0x' + d));
  assert.equal(W.hex(W.bigToBytes(pub.x, 32)), b64urlToBuf(jwk.x).toString('hex'));
  assert.equal(W.hex(W.bigToBytes(pub.y, 32)), b64urlToBuf(jwk.y).toString('hex'));
  const msg = W.utf8('eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL2ZjbS5nb29nbGVhcGlzLmNvbSJ9');
  const sig1 = W.sign(msg, d), sig2 = W.sign(msg, d);
  assert.equal(sig1.length, 64);
  assert.deepEqual(sig1, sig2, '決定性簽章');
  assert.ok(crypto.verify('sha256', Buffer.from(msg), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig1)), 'Node 驗證通過');
  const bad = sig1.slice(); bad[5] ^= 1;
  assert.ok(!crypto.verify('sha256', Buffer.from(msg), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(bad)));
  // RFC 6979 測試向量（P-256, SHA-256, "sample"）
  const x = 'C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721'.toLowerCase();
  const sig = W.sign(W.utf8('sample'), x);
  assert.equal(W.hex(sig.slice(0, 32)), 'efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716');
  const N = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
  assert.equal(BigInt('0x' + W.hex(sig.slice(32))), N - BigInt('0xf7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8'));
});

test('VAPID：金鑰只產生一次存 Script Properties；JWT 有 aud／exp／sub、簽章可驗；Authorization 標頭格式正確', () => {
  const b = loadBackend();
  const W = b.ctx.WbWebPush;
  const k1 = W.loadKeys(), k2 = W.loadKeys();
  assert.deepEqual(k1, k2);
  assert.ok(b.state.props[W.KEYS_PROP]);
  const pk = W.publicKey();
  const raw = b64urlToBuf(pk);
  assert.equal(raw.length, 65); assert.equal(raw[0], 4);
  const now = new Date('2026-11-04T08:00:00+08:00').getTime();
  const auth = W.authorization(SUB.endpoint, now);
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
  assert.ok(m, auth);
  assert.equal(m[2], pk);
  const [h, c, s] = m[1].split('.');
  assert.deepEqual(JSON.parse(b64urlToBuf(h).toString()), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(b64urlToBuf(c).toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.exp, Math.floor(now / 1000) + 12 * 3600);
  assert.match(claims.sub, /^mailto:|^https:/);
  const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(k1.x, 'hex').toString('base64url'), y: Buffer.from(k1.y, 'hex').toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + c), { key: pubKey, dsaEncoding: 'ieee-p1363' }, b64urlToBuf(s)));
});

test('訂閱：push_info 給公鑰與時段預設；push_subscribe 存訂閱（token 只回傳一次）並裝每小時排程；四個時段各自開關／時間；同時間擋下；取消', () => {
  const b = fresh();
  const info = b.call('push_info').data;
  assert.ok(info.publicKey && info.subscriptions.length === 0);
  assert.deepEqual(info.order, ['morning', 'noon', 'evening', 'night']);
  assert.deepEqual([info.slots.morning.hour, info.slots.noon.hour, info.slots.evening.hour, info.slots.night.hour], [8, 12, 20, 22]);
  const r = b.call('push_subscribe', Object.assign({}, SUB, { label: '我的手機' }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(r.data.id, /^P[0-9a-f]{8}$/); assert.equal(r.data.token.length, 48); assert.equal(r.data.trigger, true);
  assert.deepEqual(r.data.slots, { morning: { on: true, hour: 8 }, noon: { on: true, hour: 12 }, evening: { on: true, hour: 20 }, night: { on: true, hour: 22 } }, '預設四個時段都開');
  assert.ok(b.state.triggers.some((t) => t.getHandlerFunction() === 'pushJob' && t.spec.hours === 1), '裝了每小時排程');
  const stored = JSON.parse(b.state.props.PUSH_SUBS);
  assert.equal(stored.length, 1); assert.ok(!('token' in stored[0])); assert.equal(stored[0].tokenHash.length, 64); assert.equal(stored[0].deviceId, b.deviceId);
  // 同網址再訂閱：同一筆、換 token、不重複裝排程、保留原本的時段設定
  b.call('push_update', { id: r.data.id, slots: { noon: { on: false } } });
  const r2 = b.call('push_subscribe', SUB);
  assert.equal(r2.data.id, r.data.id); assert.notEqual(r2.data.token, r.data.token);
  assert.equal(JSON.parse(b.state.props.PUSH_SUBS).length, 1);
  assert.equal(b.state.triggers.filter((t) => t.getHandlerFunction() === 'pushJob').length, 1);
  assert.equal(r2.data.slots.noon.on, false, '重新訂閱不會把設定洗掉');
  // 改時間／開關：只動有給的欄位
  const u = b.call('push_update', { id: r.data.id, slots: { morning: { hour: 7 }, night: { on: false } } }).data;
  assert.deepEqual(u.slots, { morning: { on: true, hour: 7 }, noon: { on: false, hour: 12 }, evening: { on: true, hour: 20 }, night: { on: false, hour: 22 } });
  assert.equal(b.call('push_update', { id: r.data.id, slots: { morning: { hour: 99 } } }).data.slots.morning.hour, 8, '不合法的時間退回預設');
  const dup = b.call('push_update', { id: r.data.id, slots: { evening: { hour: 8 } } });
  assert.equal(dup.error.code, 'VALIDATION'); assert.match(dup.error.message, /不能選同一個時間/);
  assert.equal(b.call('push_update', { id: r.data.id, slots: { noon: { hour: 8 } } }).ok, true, '關掉的時段跟別人同一時間沒關係');
  // 驗證
  assert.equal(b.call('push_subscribe', { endpoint: 'http://x', keys: SUB.keys }).error.code, 'VALIDATION');
  assert.equal(b.call('push_subscribe', { endpoint: SUB.endpoint, keys: {} }).error.code, 'VALIDATION');
  // 取消
  assert.equal(b.call('push_unsubscribe', { id: r.data.id }).data.removed, 1);
  assert.equal(b.call('push_info').data.subscriptions.length, 0);
  // 沒登入不能訂閱
  assert.equal(b.post({ action: 'push_subscribe', params: SUB }).error.code, 'AUTH_REQUIRED');
});

test('四個時段的摘要：早上＝早上習慣＋今天任務（星標優先）＋逾期＋3 天內付款的訂閱；中午＝中午習慣＋早上沒補的；晚上＝晚上習慣＋任務剩幾筆；睡前＝全部沒打卡的（含不限）', () => {
  const b = fresh();
  const H = seedHabits(b);
  b.call('set_habit_log', { '習慣ID': H.water, '數值': 1 }); // 早上喝水已打卡
  b.call('create_task', { '任務名稱': '[LOMA 301]第 2 章', '狀態': '待辦', '到期日': TODAY, '星標': true, '分類': ['工作'] });
  b.call('create_task', { '任務名稱': '繳水費', '狀態': '待辦', '到期日': TODAY, '分類': ['生活'] });
  b.call('create_task', { '任務名稱': '做完的', '狀態': '已完成', '到期日': TODAY });
  b.call('create_task', { '任務名稱': '過期的', '狀態': '待辦', '到期日': tw(-3) });
  b.call('create_task', { '任務名稱': '明天的', '狀態': '待辦', '到期日': tw(1) });
  b.call('create_task', { '任務名稱': '沒日期', '狀態': '待辦' });
  b.call('create_subscription', { '產品': 'Netflix', '訂閱費': 390, '訂閱週期': '每月', '訂閱開始日': tw(-29) });
  b.call('create_subscription', { '產品': 'Claude', '訂閱費': 20, '訂閱週期': '每月', '訂閱開始日': tw(-10) });
  const subs = b.call('subscriptions').data;
  const soonSubs = subs.filter((s) => s['下次付款日'] >= TODAY && s['下次付款日'] <= tw(3)).map((s) => s['產品']);
  const S = (slot) => JSON.parse(JSON.stringify(b.ctx.WbApi.pushSummary(slot, b.state.clock.now))); // 跨 vm 的陣列要先轉成本地物件才能 deepEqual

  const am = S('morning');
  assert.equal(am.count, 2 + 2 + 1 + soonSubs.length, JSON.stringify(am));
  assert.equal(am.url, '#/home');
  assert.equal(am.title, '早上提醒', '標題要短，手機最多顯示兩行');
  const expectCounts = ['2 個習慣', '2 筆任務', '逾期 1 筆'].concat(soonSubs.length ? [soonSubs.length + ' 筆訂閱要付款'] : []).join('、');
  assert.equal(am.lines[0], expectCounts, '數字放內文第一行');
  assert.equal(am.lines[1], '習慣：確認行事曆、確認每日焦點任務', '打卡過的不列、封存的不列');
  assert.equal(am.lines[2], '★ [LOMA 301]第 2 章', '星標排前面');
  assert.equal(am.lines[3], '繳水費');
  if (soonSubs.length) assert.match(am.lines[4], /^\d+\/\d+ Netflix 付款$/);
  assert.equal(am.body, am.lines.join('\n'), '沒超過 10 行就全部列出來');

  const noon = S('noon');
  assert.equal(noon.title, '中午提醒');
  assert.equal(noon.count, 4); assert.equal(noon.url, '#/habits');
  assert.deepEqual(noon.lines, ['2 個習慣、早上還有 2 個沒打卡', '習慣：喝水700cc（午）、營養補充品', '早上沒打卡：確認行事曆、確認每日焦點任務']);

  const pm = S('evening');
  assert.equal(pm.title, '晚上提醒');
  assert.deepEqual(pm.lines, ['2 個習慣、任務還剩 2 筆', '習慣：填寫日記、記帳', '★ [LOMA 301]第 2 章', '繳水費']);

  const night = S('night');
  assert.equal(night.count, 8, '早上 2＋中午 2＋晚上 2＋不限 2（每週 3 次的這週還沒做滿也算）');
  assert.equal(night.title, '睡前提醒');
  assert.equal(night.lines[0], '還有 8 個習慣沒打卡');
  assert.equal(night.lines[1], '確認行事曆、確認每日焦點任務、喝水700cc（午）、營養補充品、填寫日記、記帳、閱讀、運動-步行', '8 個全部列出來');

  // 全部打卡、任務做完：各時段都沒事
  Object.keys(H).forEach((k) => { if (k !== 'archived') b.call('set_habit_log', { '習慣ID': H[k], '數值': 1 }); });
  ['[LOMA 301]第 2 章', '繳水費', '過期的'].forEach((n) => { const t = b.call('tasks').data.find((x) => x['任務名稱'] === n); b.call('set_task_status', { '任務ID': t['任務ID'], '狀態': '已完成' }); });
  subs.forEach((s) => b.call('delete_subscription', { '訂閱ID': s['訂閱ID'] }));
  ['morning', 'noon', 'evening', 'night'].forEach((slot) => { const s = S(slot); assert.equal(s.count, 0, slot); assert.match(s.title, /今天沒有要處理的事$/); });
  // 任務很多：列 6 筆＋「…還有 N 筆任務」，內文不超過 10 行
  for (let i = 1; i <= 10; i++) b.call('create_task', { '任務名稱': '雜事 ' + i, '狀態': '待辦', '到期日': TODAY });
  const big = S('morning');
  assert.equal(big.lines[0], '10 筆任務');
  assert.equal(big.lines.filter((l) => /^雜事/.test(l)).length, 6);
  assert.ok(big.lines.includes('…還有 4 筆任務'));
  assert.ok(big.body.split('\n').length <= 10);
});

test('每小時排程：每個時段到了設定的時間才推、同時段一天一次、沒事不推、關掉的時段不推；push_summary 用裝置碼拿「這次時段」的摘要；push_test 立刻推；410 就停用', () => {
  const b = fresh();
  const H = seedHabits(b);
  const sub = b.call('push_subscribe', Object.assign({}, SUB, { slots: { noon: { on: false } } })).data;
  const sent = [];
  b.state.urlFetch.handler = (url, opts) => { sent.push({ url, opts }); return { code: 201, body: '' }; };
  const P = b.ctx.WbPush;
  atHour(b, '07:23'); assert.equal(P.runHourly(b.state.clock.now).sent, 0, '還沒到 8 點');
  atHour(b, '08:23');
  const r = P.runHourly(b.state.clock.now);
  assert.equal(r.sent, 1, JSON.stringify(r)); assert.equal(r.due, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, SUB.endpoint);
  assert.equal(sent[0].opts.method, 'post'); assert.equal(sent[0].opts.payload, '');
  assert.match(sent[0].opts.headers.Authorization, /^vapid t=.+, k=.+$/);
  // 手機收到後來拿摘要：知道這次是早上
  const sm = b.post({ action: 'push_summary', params: { token: sub.token } });
  assert.ok(sm.ok, JSON.stringify(sm)); assert.equal(sm.data.slot, 'morning'); assert.equal(sm.data.url, '#/home'); assert.equal(sm.data.title, '早上提醒'); assert.match(sm.data.body, /^3 個習慣\n習慣：/);
  assert.equal(b.post({ action: 'push_summary', params: { token: 'nope' } }).error.code, 'AUTH_FAILED');
  atHour(b, '08:50'); assert.equal(P.runHourly(b.state.clock.now).sent, 0, '同一時段同一天不再推');
  atHour(b, '12:10'); assert.equal(P.runHourly(b.state.clock.now).due, 0, '中午關掉了');
  // 晚上：把晚上的習慣都打卡 → 沒事不推（但算過了，lastCode=skip）
  b.login(); // 時鐘跳了幾小時，登入已過期
  b.call('set_habit_log', { '習慣ID': H.diary, '數值': 1 }); b.call('set_habit_log', { '習慣ID': H.ledger, '數值': 1 });
  atHour(b, '20:05');
  const r2 = P.runHourly(b.state.clock.now);
  assert.equal(r2.due, 1); assert.equal(r2.sent, 0);
  let st = JSON.parse(b.state.props.PUSH_SUBS)[0];
  assert.equal(st.lastCode, 'skip'); assert.equal(st.last.evening, TODAY); assert.equal(st.last.morning, TODAY);
  // 睡前：早上／中午／不限的還沒打卡 → 推，摘要是睡前的
  atHour(b, '22:30');
  assert.equal(P.runHourly(b.state.clock.now).sent, 1);
  assert.equal(b.post({ action: 'push_summary', params: { token: sub.token } }).data.slot, 'night');
  assert.equal(sent.length, 2);
  // 隔天早上又會推
  atHour(b, '08:01', tw(1));
  assert.equal(P.runHourly(b.state.clock.now).sent, 1);
  // 測試推播：不管時間；指定時段或依現在幾點挑
  b.login();
  atHour(b, '13:00');
  const t = b.call('push_test', { id: sub.id });
  assert.ok(t.ok, JSON.stringify(t)); assert.equal(t.data.code, 201); assert.equal(t.data.slot, 'morning', '13 點：中午關著，最近的是早上');
  assert.equal(b.call('push_test', { id: sub.id, slot: 'night' }).data.slot, 'night');
  // 推播服務說訂閱失效 → 停用，摘要也拿不到；之後排程跳過它
  b.state.urlFetch.handler = () => ({ code: 410, body: 'gone' });
  const t2 = b.call('push_test', { id: sub.id });
  assert.equal(t2.error.code, 'PUSH_FAILED'); assert.match(t2.error.message, /重新開啟通知/);
  assert.equal(JSON.parse(b.state.props.PUSH_SUBS)[0].active, false);
  assert.equal(b.post({ action: 'push_summary', params: { token: sub.token } }).error.code, 'AUTH_FAILED');
  atHour(b, '08:01', tw(2));
  assert.equal(P.runHourly(b.state.clock.now).due, 0);
  // 還沒授權 external_request（UrlFetchApp 丟例外）：測試通知回清楚的錯誤、不會整個掛掉
  const c = fresh();
  const s2 = c.call('push_subscribe', SUB).data;
  const t3 = c.call('push_test', { id: s2.id });
  assert.equal(t3.error.code, 'PUSH_FAILED'); assert.match(t3.error.message, /permission|external_request/);
});

test('試算表選單：推播設定項目會裝排程並顯示狀態；狀態檢查也列出推播', () => {
  const b = fresh();
  b.ctx.onOpen();
  const items = b.state.ui.menus.at(-1).items.map((x) => x[1]);
  assert.ok(items.includes('menuPushSetup'));
  b.ctx.menuPushSetup();
  assert.ok(b.state.triggers.some((t) => t.getHandlerFunction() === 'pushJob'));
  assert.match(JSON.stringify(b.state.ui.log.at(-1)), /每小時排程：已安裝[\s\S]*連到推播伺服器：沒有權限/, '還沒授權連外時會說沒有權限');
  b.state.urlFetch.handler = () => ({ code: 404, body: '' });
  b.ctx.menuPushSetup();
  assert.match(JSON.stringify(b.state.ui.log.at(-1)), /連到推播伺服器：可以（回應 404）/);
  assert.match(b.ctx.pushAuthCheck(), /^每小時排程：已安裝；連到推播伺服器：可以（回應 404）$/);
  b.ctx.menuStatus();
  assert.match(JSON.stringify(b.state.ui.log.at(-1)), /推播通知：排程已安裝，裝置 0 個/);
});
