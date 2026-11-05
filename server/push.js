/**
 * 推播通知（Web Push）：訂閱管理、四個時段的摘要、每小時排程。
 *  - 訂閱（每支手機一筆：推播網址、金鑰、四個時段各自的開關與時間、裝置摘要碼的雜湊）存在 Script Properties（PUSH_SUBS），不進試算表。
 *  - 時段跟習慣的「時段」對齊：早上（預設 8 點）／中午（12 點）／晚上（20 點）／睡前收尾（22 點），各自可關、時間各自可調。
 *  - 每小時排程 pushJob：到了某個時段設定的「幾點」就算一次該時段的摘要，有事才推（每個時段一天最多一則）；推播失效（404／410）就停用該訂閱。
 *  - 推播本身沒有內容：手機的 service worker 收到後拿「裝置摘要碼」向後端（push_summary）取摘要再顯示；
 *    送出前先把「這次是哪個時段」記在訂閱上（pendingSlot），取摘要時就知道要算哪一段。
 */
var WbPush = (function () {
  var SUBS_PROP = 'PUSH_SUBS';
  var MAX_SUBS = 10;
  var TZ = 'Asia/Taipei';
  // 時段順序固定：早上 → 中午 → 晚上 → 睡前
  var SLOTS = ['morning', 'noon', 'evening', 'night'];
  var SLOT_INFO = {
    morning: { label: '早上', hour: 8, habitTime: '早上', url: '#/home' },
    noon: { label: '中午', hour: 12, habitTime: '中午', url: '#/habits' },
    evening: { label: '晚上', hour: 20, habitTime: '晚上', url: '#/habits' },
    night: { label: '睡前', hour: 22, habitTime: '', url: '#/habits' },
  };

  function props() { return PropertiesService.getScriptProperties(); }
  function load() {
    var raw = props().getProperty(SUBS_PROP);
    if (!raw) return [];
    try { var list = JSON.parse(raw); return Array.isArray(list) ? list : []; } catch (e) { return []; }
  }
  function save(list) { props().setProperty(SUBS_PROP, JSON.stringify(list)); }
  function toHex(bytes) { var out = ''; for (var i = 0; i < bytes.length; i++) { var b = bytes[i] & 0xff; out += (b < 16 ? '0' : '') + b.toString(16); } return out; }
  function sha256Hex(str) { return toHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str)); }
  function randomHex(n) { var out = ''; while (out.length < n) out += Utilities.getUuid().replace(/-/g, ''); return out.slice(0, n); }
  function stamp(ms) { return Utilities.formatDate(new Date(ms), TZ, 'yyyy-MM-dd HH:mm:ss'); }
  function dayOf(ms) { return Utilities.formatDate(new Date(ms), TZ, 'yyyy-MM-dd'); }
  function hourOf(ms) { return Number(Utilities.formatDate(new Date(ms), TZ, 'HH')); }
  function isHour(h) { h = Number(h); return isFinite(h) && h >= 0 && h <= 23 && Math.floor(h) === h; }

  function defaultSlots() {
    var out = {};
    SLOTS.forEach(function (k) { out[k] = { on: true, hour: SLOT_INFO[k].hour }; });
    return out;
  }
  /** 把前端送來的時段設定整理成合法的：不認得的欄位忽略、時間不合法就用預設；兩個開著的時段不能同一個小時 */
  function normalizeSlots(input, base) {
    var out = {};
    SLOTS.forEach(function (k) {
      var cur = (base && base[k]) || { on: true, hour: SLOT_INFO[k].hour };
      var p = input && typeof input === 'object' && input[k] && typeof input[k] === 'object' ? input[k] : null;
      out[k] = {
        on: p && p.on !== undefined ? !!p.on : cur.on !== false,
        hour: p && p.hour !== undefined ? (isHour(p.hour) ? Number(p.hour) : SLOT_INFO[k].hour) : (isHour(cur.hour) ? Number(cur.hour) : SLOT_INFO[k].hour),
      };
    });
    var seen = {};
    SLOTS.forEach(function (k) {
      if (!out[k].on) return;
      if (seen[out[k].hour]) throw WbFail('VALIDATION', SLOT_INFO[seen[out[k].hour]].label + '和' + SLOT_INFO[k].label + '不能選同一個時間');
      seen[out[k].hour] = k;
    });
    return out;
  }
  function pub(s) {
    return { id: s.id, label: s.label, slots: normalizeSlots(null, s.slots), createdAt: s.createdAt, last: s.last || {}, lastCode: s.lastCode || null, active: s.active !== false, deviceId: s.deviceId || '',
      lastAt: s.lastAt || '', lastSlot: s.pendingSlot || '', fetchedAt: s.fetchedAt || '' };
  }

  /** 新增（或更新同一個推播網址的）訂閱；回傳給前端的 token 只會出現這一次，後端只存雜湊 */
  function subscribe(p, env) {
    var endpoint = String(p.endpoint || '').trim();
    var keys = p.keys && typeof p.keys === 'object' ? p.keys : {};
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) throw WbFail('VALIDATION', '推播網址不正確');
    if (!keys.p256dh || !keys.auth) throw WbFail('VALIDATION', '缺少推播金鑰');
    var list = load();
    var token = randomHex(48);
    var now = stamp(env.now);
    var existing = list.filter(function (s) { return s.endpoint === endpoint; })[0];
    var sub = existing || { id: 'P' + randomHex(8), createdAt: now };
    sub.endpoint = endpoint; sub.p256dh = String(keys.p256dh).slice(0, 200); sub.auth = String(keys.auth).slice(0, 100);
    sub.label = String(p.label || env.device || '').slice(0, 40);
    sub.deviceId = env.session ? env.session.deviceId || '' : '';
    sub.slots = normalizeSlots(p.slots, existing ? existing.slots : null);
    sub.tokenHash = sha256Hex(token);
    sub.active = true; sub.fails = 0; sub.updatedAt = now; sub.last = sub.last || {};
    if (!existing) {
      if (list.length >= MAX_SUBS) throw WbFail('VALIDATION', '推播裝置最多 ' + MAX_SUBS + ' 個，請先移除用不到的');
      list.push(sub);
    }
    save(list);
    var trigger = ensureTrigger();
    return { id: sub.id, slots: sub.slots, token: token, trigger: trigger };
  }

  function find(list, id) { return list.filter(function (s) { return s.id === String(id || ''); })[0] || null; }

  /** 改時段設定（開關、時間）或名稱 */
  function update(p) {
    var list = load();
    var sub = find(list, p.id);
    if (!sub) throw WbFail('NOT_FOUND', '找不到這個推播訂閱（請重新開啟通知）');
    if (p.slots !== undefined) sub.slots = normalizeSlots(p.slots, sub.slots);
    if (p.label !== undefined) sub.label = String(p.label || '').slice(0, 40);
    save(list);
    return pub(sub);
  }

  function unsubscribe(p) {
    var id = String(p.id || ''), endpoint = String(p.endpoint || '');
    var list = load();
    var next = list.filter(function (s) { return !(s.id === id || (endpoint && s.endpoint === endpoint)); });
    save(next);
    return { removed: list.length - next.length };
  }

  function listAll() { return load().map(pub); }

  /** 手機來拿摘要時記一下時間（設定頁顯示「手機幾點拿到內容」，用來判斷是送不到還是拿不到） */
  function markFetched(id, nowMs) {
    var list = load(), sub = find(list, id);
    if (!sub) return;
    sub.fetchedAt = stamp(nowMs);
    save(list);
  }
  /** 有人拿著不認得的裝置碼來拿摘要（例如手機裡存的碼已經被換掉）：記下時間，設定頁會提示 */
  function markBadToken(nowMs) { try { props().setProperty('PUSH_BAD_TOKEN_AT', stamp(nowMs)); } catch (e) { /* ignore */ } }
  function badTokenAt() { return props().getProperty('PUSH_BAD_TOKEN_AT') || ''; }

  function byToken(token) {
    if (!token) return null;
    var h = sha256Hex(String(token));
    return load().filter(function (s) { return s.tokenHash === h; })[0] || null;
  }

  /** 每小時排程：確保有裝（第一次訂閱時從網頁端呼叫；失敗就回傳 false，讓前端提醒去試算表選單安裝） */
  function ensureTrigger() {
    try {
      var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'pushJob'; });
      if (!has) ScriptApp.newTrigger('pushJob').timeBased().everyHours(1).create();
      return true;
    } catch (e) {
      try { Logger.log('安裝推播排程失敗：' + (e && e.message)); } catch (x) { /* ignore */ }
      return false;
    }
  }
  function hasTrigger() {
    try { return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'pushJob'; }); } catch (e) { return false; }
  }

  /**
   * 送給某個訂閱（測試按鈕／排程共用）。
   * 送出「之前」就把這次的時段和算好的摘要存起來（sub.pending）：手機收到推播後馬上來拿，直接回存好的內容，
   * 不用再讀一次試算表（快很多，手機在省電狀態下給的時間很短）。list 有給就先存檔再送。
   */
  function sendTo(sub, slot, nowMs, list, summary) {
    sub.pendingSlot = SLOTS.indexOf(slot) >= 0 ? slot : 'morning';
    sub.pending = summary ? { slot: sub.pendingSlot, title: summary.title, body: summary.body, count: summary.count, url: summary.url, today: summary.today, at: nowMs } : null;
    sub.lastAt = stamp(nowMs); sub.fetchedAt = '';
    if (list) save(list);
    var r;
    try { r = WbWebPush.send(sub, nowMs, { urgency: 'high' }); }
    catch (e) { r = { code: 0, ok: false, gone: false, body: String(e && e.message || e).slice(0, 200) }; }
    sub.lastCode = r.code;
    if (r.ok) sub.fails = 0; else sub.fails = (sub.fails || 0) + 1;
    if (r.gone) sub.active = false;
    if (list) save(list);
    return r;
  }

  /** 現在這個小時對應哪個時段（測試通知用）：有開的時段裡，取最後一個「時間 ≤ 現在」的；都還沒到就用第一個有開的（都關就早上） */
  function slotForHour(sub, hour) {
    var slots = normalizeSlots(null, sub.slots), pick = null, first = null;
    SLOTS.forEach(function (k) { if (!slots[k].on) return; if (!first) first = k; if (slots[k].hour <= hour) pick = k; });
    return pick || first || 'morning';
  }

  /** 每小時排程進入點：每個訂閱的每個時段，到了設定的時間就算一次摘要（同一時段一天一次），沒事不推 */
  function runHourly(nowMs) {
    var list = load();
    if (!list.length) return { checked: 0, sent: 0 };
    var hour = hourOf(nowMs), today = dayOf(nowMs);
    var summaries = {}, sent = 0, due = 0, error = null;
    function summaryFor(slot) {
      if (!summaries[slot]) {
        try { summaries[slot] = WbApi.pushSummary(slot, nowMs); }
        catch (e) { error = String(e && e.message); try { Logger.log('推播摘要失敗：' + (e && e.stack ? e.stack : e)); } catch (x) { /* ignore */ } summaries[slot] = null; }
      }
      return summaries[slot];
    }
    list.forEach(function (s) {
      if (s.active === false) return;
      var slots = normalizeSlots(null, s.slots);
      s.last = s.last || {};
      SLOTS.forEach(function (k) {
        if (!slots[k].on || slots[k].hour !== hour || s.last[k] === today || s.active === false) return;
        due++;
        var sum = summaryFor(k);
        if (!sum) return; // 摘要算失敗：這一小時不記 last，下一小時不會再來（時間過了），明天再試
        s.last[k] = today;
        if (!sum.count) { s.lastCode = 'skip'; return; }
        var r = sendTo(s, k, nowMs, list, sum);
        if (r.ok) sent++;
      });
    });
    save(list);
    var out = { checked: list.length, due: due, sent: sent };
    if (error) out.error = error;
    return out;
  }

  return { subscribe: subscribe, update: update, unsubscribe: unsubscribe, listAll: listAll, byToken: byToken, find: find, sendTo: sendTo, runHourly: runHourly,
    ensureTrigger: ensureTrigger, hasTrigger: hasTrigger, markFetched: markFetched, markBadToken: markBadToken, badTokenAt: badTokenAt, slotForHour: slotForHour, normalizeSlots: normalizeSlots, defaultSlots: defaultSlots,
    load: load, save: save, SLOTS: SLOTS, SLOT_INFO: SLOT_INFO, SUBS_PROP: SUBS_PROP };
})();
