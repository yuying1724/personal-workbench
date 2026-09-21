'use strict';
/**
 * Google Apps Script 服務的記憶體模擬（SpreadsheetApp、PropertiesService、CacheService、LockService、Utilities…）。
 * 刻意模擬幾個真實 Sheets 會踩到的行為，讓測試能抓到問題：
 *  - 寫入超出工作表列數會丟例外（必須先 insertRowsAfter）
 *  - 非「純文字」格式的儲存格：'2026-03-04' 會被轉成日期、'123' 會變數字、'=…' 會變公式
 *  - Utilities.computeDigest / computeHmacSha256Signature 回傳「有號」位元組
 */
const crypto = require('node:crypto');

function toSigned(buf) { return Array.from(buf).map((b) => (b > 127 ? b - 256 : b)); }
const TZ_MS = 8 * 3600 * 1000;

class MockRange {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); sheet._check(r, c, nr, nc); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) row.push(this.sheet._read(this.r + i, this.c + j));
      out.push(row);
    }
    return out;
  }
  getValue() { return this.sheet._read(this.r, this.c); }
  getFormulas() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) row.push(this.sheet._cell(this.r + i, this.c + j).f || '');
      out.push(row);
    }
    return out;
  }
  setValues(vals) {
    if (vals.length !== this.nr || vals.some((row) => row.length !== this.nc)) {
      throw new Error(`The number of rows/columns in the data does not match the range. Expected ${this.nr}x${this.nc}`);
    }
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet._write(this.r + i, this.c + j, vals[i][j]);
    this.sheet.ss.writes += 1;
    return this;
  }
  setValue(v) {
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet._write(this.r + i, this.c + j, v);
    this.sheet.ss.writes += 1;
    return this;
  }
  setNumberFormat(fmt) {
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet._cell(this.r + i, this.c + j).fmt = fmt;
    return this;
  }
  setFormula(f) { const c = this.sheet._cell(this.r, this.c); c.f = f; c.v = ''; return this; }
  createTextFinder(text) {
    const range = this; let entire = false;
    const finder = {
      matchEntireCell(b) { entire = !!b; return finder; },
      replaceAllWith(nv) {
        let n = 0;
        for (let i = 0; i < range.nr; i++) for (let j = 0; j < range.nc; j++) {
          const cell = range.sheet._cell(range.r + i, range.c + j);
          if (cell.f) continue;
          const v = cell.v === null || cell.v === undefined ? '' : String(cell.v);
          if (entire ? v === text : v.includes(text)) { cell.v = entire ? nv : v.split(text).join(nv); n++; }
        }
        return n;
      },
    };
    return finder;
  }
  setFontWeight() { return this; }
  setBackground() { return this; }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet._write(this.r + i, this.c + j, ''); return this; }
}

class MockSheet {
  constructor(ss, name) {
    this.ss = ss; this.name = name; this.maxRows = 1000; this.maxCols = 26; this.rows = []; this.frozen = 0;
    this.formulaResults = {}; // 'r,c' -> 公式的計算結果（測試自行設定）
  }
  getName() { return this.name; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  _check(r, c, nr, nc) {
    if (r < 1 || c < 1 || nr < 1 || nc < 1 || r + nr - 1 > this.maxRows || c + nc - 1 > this.maxCols) {
      throw new Error('The coordinates or dimensions of the range are invalid / outside the dimensions of the sheet.');
    }
  }
  _cell(r, c) {
    this._check(r, c, 1, 1);
    if (!this.rows[r - 1]) this.rows[r - 1] = [];
    if (!this.rows[r - 1][c - 1]) this.rows[r - 1][c - 1] = { v: '', f: null, fmt: '' };
    return this.rows[r - 1][c - 1];
  }
  _read(r, c) {
    const cell = this._cell(r, c);
    if (cell.f) { const res = this.formulaResults[`${r},${c}`]; return res === undefined ? '' : res; }
    return cell.v;
  }
  _write(r, c, val) {
    const cell = this._cell(r, c);
    cell.f = null;
    if (val === null || val === undefined || val === '') { cell.v = ''; return; }
    if (typeof val === 'string' && cell.fmt !== '@') {
      if (val.startsWith('=')) { cell.f = val; cell.v = ''; return; }
      let m;
      if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val))) { cell.v = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - TZ_MS); return; }
      if ((m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(val))) { cell.v = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - TZ_MS); return; }
      if (/^-?\d+(\.\d+)?$/.test(val)) { cell.v = Number(val); return; }
    }
    cell.v = val;
  }
  getLastRow() {
    for (let r = this.rows.length; r >= 1; r--) {
      const row = this.rows[r - 1];
      if (row && row.some((c) => c && (c.v !== '' || c.f))) return r;
    }
    return 0;
  }
  getLastColumn() {
    let last = 0;
    this.rows.forEach((row) => { if (row) row.forEach((c, i) => { if (c && (c.v !== '' || c.f)) last = Math.max(last, i + 1); }); });
    return last;
  }
  getRange(r, c, nr = 1, nc = 1) {
    if (typeof r === 'string') { // 只支援 "B2:B" 這種整欄 A1 寫法（legacy renameOption_ 用到）
      const m = /^([A-Z])(\d+):([A-Z])$/.exec(r);
      if (!m) throw new Error('mock 不支援的 A1：' + r);
      const col = m[1].charCodeAt(0) - 64;
      return new MockRange(this, +m[2], col, this.maxRows - +m[2] + 1, 1);
    }
    return new MockRange(this, r, c, nr, nc);
  }
  getDataRange() { return new MockRange(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  appendRow(values) {
    const r = this.getLastRow() + 1;
    if (r > this.maxRows) this.maxRows = r; // 真實 appendRow 會自動加列
    if (values.length > this.maxCols) this.maxCols = values.length;
    values.forEach((v, j) => this._write(r, j + 1, v instanceof Date ? v : v));
    this.ss.writes += 1;
    return this;
  }
  deleteRow(r) { this.rows.splice(r - 1, 1); this.ss.writes += 1; }
  insertRowsAfter(after, n) {
    this.maxRows += n; // 新增的列沒有任何格式（比真實更嚴格：不繼承上一列）
    this.ss.insertedRows += n;
  }
  setFrozenRows(n) { this.frozen = n; }
  // 測試輔助：直接改儲存格（繞過格式轉換），模擬使用者手動編輯
  poke(r, c, v) { this._cell(r, c).v = v; this._cell(r, c).f = null; }
  dump() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())).getValues(); }
}

class MockSpreadsheet {
  constructor(id) { this.id = id; this.sheets = [new MockSheet(this, '工作表1')]; this.writes = 0; this.insertedRows = 0; }
  getId() { return this.id; }
  getUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}/edit`; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n, index) {
    if (this.getSheetByName(n)) throw new Error('A sheet with the name "' + n + '" already exists.');
    const s = new MockSheet(this, n);
    if (index === undefined) this.sheets.unshift(s); else this.sheets.splice(index, 0, s); // 沒指定位置時（真實行為不確定）放最前面，逼我們明確指定
    return s;
  }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
  sheet(n) { const s = this.getSheetByName(n); if (!s) throw new Error('沒有分頁 ' + n); return s; }
}

class MockUi {
  constructor() {
    this.Button = { OK: 'OK', CANCEL: 'CANCEL', CLOSE: 'CLOSE' };
    this.ButtonSet = { OK: 'OK', OK_CANCEL: 'OK_CANCEL' };
    this.log = []; this.answers = []; this.menus = [];
  }
  queue(...answers) { this.answers.push(...answers); return this; }
  alert(title, msg) { this.log.push({ kind: 'alert', title, msg }); const a = this.answers.length && this.answers[0] === 'CANCEL' ? this.answers.shift() : 'OK'; return a; }
  prompt(title, msg) {
    this.log.push({ kind: 'prompt', title, msg });
    const a = this.answers.shift();
    const cancelled = a === null || a === undefined;
    return { getSelectedButton: () => (cancelled ? 'CANCEL' : 'OK'), getResponseText: () => (cancelled ? '' : String(a)) };
  }
  createMenu(name) {
    const menu = { name, items: [] };
    const b = { addItem: (label, fn) => { menu.items.push([label, fn]); return b; }, addSeparator: () => b, addToUi: () => { this.menus.push(menu); } };
    return b;
  }
}

function createMocks() {
  const state = {
    clock: { now: Date.UTC(2026, 2, 10, 4, 0, 0) }, // 台灣時間 2026-03-10 12:00
    spreadsheets: {}, props: {}, cache: {}, triggers: [], sleptMs: 0, lockHeld: false, lockCalls: 0, logs: [], ui: new MockUi(), mail: [],
  };
  let active = null;
  const newSheet = (id) => { const ss = new MockSpreadsheet(id || 'sheet-' + Object.keys(state.spreadsheets).length); state.spreadsheets[ss.id] = ss; return ss; };
  active = newSheet('SS_MAIN');

  const SpreadsheetApp = {
    getActiveSpreadsheet: () => active,
    openById: (id) => { if (!state.spreadsheets[id]) throw new Error('No item with the given ID could be found'); return state.spreadsheets[id]; },
    getUi: () => state.ui,
  };
  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (Object.prototype.hasOwnProperty.call(state.props, k) ? state.props[k] : null),
      setProperty(k, v) { state.props[k] = String(v); return this; },
      deleteProperty(k) { delete state.props[k]; return this; },
      getProperties: () => Object.assign({}, state.props),
    }),
  };
  const CacheService = {
    getScriptCache: () => ({
      get: (k) => { const e = state.cache[k]; if (!e) return null; if (e.exp <= state.clock.now) { delete state.cache[k]; return null; } return e.v; },
      put: (k, v, sec = 600) => { if (sec > 21600) throw new Error('TTL too long'); state.cache[k] = { v: String(v), exp: state.clock.now + sec * 1000 }; },
      remove: (k) => { delete state.cache[k]; },
    }),
  };
  const LockService = {
    getScriptLock: () => ({
      waitLock() { if (state.lockHeld) throw new Error('Lock timeout'); state.lockHeld = true; state.lockCalls += 1; },
      releaseLock() { state.lockHeld = false; },
    }),
  };
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    computeDigest: (alg, s) => toSigned(crypto.createHash('sha256').update(String(s), 'utf8').digest()),
    computeHmacSha256Signature: (msg, key) => toSigned(crypto.createHmac('sha256', String(key)).update(String(msg), 'utf8').digest()),
    getUuid: () => crypto.randomUUID(),
    sleep: (ms) => { state.sleptMs += ms; },
    formatDate: (d, tz, fmt) => {
      const t = new Date(new Date(d.getTime()).getTime() + TZ_MS); // 只模擬 Asia/Taipei
      const p = (n) => String(n).padStart(2, '0');
      return fmt.replace('yyyy', t.getUTCFullYear()).replace('MM', p(t.getUTCMonth() + 1)).replace('dd', p(t.getUTCDate()))
        .replace('HH', p(t.getUTCHours())).replace('mm', p(t.getUTCMinutes())).replace('ss', p(t.getUTCSeconds()));
    },
  };
  const ContentService = {
    MimeType: { JSON: 'JSON' },
    createTextOutput: (s) => ({ content: s, setMimeType() { return this; }, getContent() { return this.content; } }),
  };
  const ScriptApp = {
    getProjectTriggers: () => state.triggers.slice(),
    deleteTrigger: (t) => { state.triggers = state.triggers.filter((x) => x !== t); },
    newTrigger: (fn) => {
      const spec = { fn };
      const b = { timeBased: () => b, everyDays: (n) => { spec.days = n; return b; }, atHour: (h) => { spec.hour = h; return b; },
        create: () => { const t = { getHandlerFunction: () => fn, spec }; state.triggers.push(t); return t; } };
      return b;
    },
  };
  const Logger = { log: (m) => state.logs.push(String(m)) };
  const MailApp = { sendEmail: (to, subject, body) => { state.mail.push({ to, subject, body }); } };
  const Session = { getScriptTimeZone: () => 'Asia/Taipei', getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }), getActiveUser: () => ({ getEmail: () => 'owner@example.com' }) };
  return { state, newSheet, setActive: (ss) => { active = ss; }, globals: { SpreadsheetApp, PropertiesService, CacheService, LockService, Utilities, ContentService, ScriptApp, Logger, MailApp, Session } };
}

module.exports = { createMocks, MockSheet, MockSpreadsheet };
