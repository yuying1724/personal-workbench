'use strict';
/**
 * 端到端測試：真的開瀏覽器操作網頁，後端是「打包後的 dist/Api.gs + 記憶體版 Google 服務」。
 * 需要 Playwright；沒有安裝時整份測試會自動略過。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

let playwright = null;
try { playwright = require('playwright'); } catch (e) {
  try { playwright = require(require('node:child_process').execSync('npm root -g').toString().trim() + '/playwright'); } catch (e2) { /* 沒有 Playwright */ }
}
const skip = playwright ? false : '未安裝 Playwright，略過瀏覽器測試';
const { startDevServer } = require('../tools/dev-server.js');

let browser;
test.before(async () => { if (playwright) browser = await playwright.chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

async function open(opts = {}) {
  const s = await startDevServer({ demo: opts.demo !== false });
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 390, height: 844 }, locale: 'zh-TW', hasTouch: !opts.desktop, isMobile: !opts.desktop, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(s.url);
  const a = {
    s, page, errors,
    async login(pin = s.pin) {
      // 登入畫面 50ms 後會自動把游標移到第一個輸入框；等它移完再填，免得打字打到別的欄位
      await page.waitForFunction(() => document.activeElement && document.activeElement.tagName === 'INPUT');
      await page.fill('input[placeholder^="XXXXX"]', s.token);
      await page.fill('input[aria-label="PIN"]', pin);
      await page.click('button[type=submit]');
      if (pin === s.pin) await page.waitForSelector('.page-head');
    },
    async go(tab) { await page.evaluate((t) => { location.hash = '#/' + t; }, tab); await page.waitForTimeout(150); },
    data() { return s.backend.call('bootstrap').data; },
    toast() { return page.locator('.toast').last(); },
    async close() { await ctx.close(); await s.close(); },
  };
  return a;
}
async function withApp(opts, fn) {
  const a = await open(opts);
  try { await fn(a); assert.deepEqual(a.errors, [], '瀏覽器主控台不該有錯誤'); } finally { await a.close(); }
}

test('登入：錯誤 PIN 顯示訊息；正確後進入總覽；重新整理仍保持登入；鎖定後回到登入畫面', { skip }, async () => {
  await withApp({}, async (a) => {
    const { page } = a;
    await a.login('000000');
    await page.waitForSelector('.notice.bad[role=alert]:not([style*="none"])');
    assert.match(await page.locator('.notice.bad').innerText(), /授權碼或 PIN 錯誤/);
    await page.fill('input[aria-label="PIN"]', a.s.pin);
    await page.click('button[type=submit]');
    await page.waitForSelector('.page-head h1:has-text("總覽")');
    await page.reload();
    await page.waitForSelector('.page-head h1:has-text("總覽")');
    await a.go('more');
    await page.click('.main button:has-text("鎖定")');
    await page.waitForSelector('input[aria-label="PIN"]');
    assert.equal(await page.locator('input[placeholder^="XXXXX"]').isVisible(), false, '授權碼已記住，只要輸入 PIN');
    a.errors.length = 0; // 錯誤 PIN 的 401 以外不應有錯誤
  });
});

test('任務：新增（含子任務、每週重複）、打勾完成會產生下一筆、刪除', { skip }, async () => {
  await withApp({ demo: false }, async (a) => {
    const { page } = a;
    await a.login();
    await a.go('tasks');
    await page.click('.fab');
    await page.waitForSelector('.sheet');
    await page.fill('.sheet .field:has-text("任務名稱") input', '週會準備');
    await page.click('.sheet .chips.quick >> text=明天');
    await page.selectOption('.sheet select >> nth=1', 'week'); // 第 0 個是「所屬專案」
    await page.click('.sheet [data-testid=form-save]');
    await page.waitForSelector('.sheet .notice.bad:has-text("星期幾")');
    await page.click('.sheet .wd-row .wd >> nth=1');
    await page.click('.sheet >> text=新增子任務');
    await page.fill('.sheet .sub-item input[type=text]', '整理議程');
    await page.click('.sheet [data-testid=form-save]');
    await page.waitForSelector('.sheet', { state: 'detached' });
    let tasks = a.data().tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]['子任務'][0]['內容'], '整理議程');
    assert.deepEqual(JSON.parse(tasks[0]['重複規則']), { freq: 'week', interval: 1, weekdays: [1] });

    await page.click('.task-row input.big-check');
    await page.waitForFunction(() => document.querySelectorAll('.task-row').length === 1 && document.querySelector('.group.collapsed'));
    tasks = a.data().tasks;
    assert.equal(tasks.length, 2, '完成重複任務會產生下一筆');
    assert.equal(tasks.filter((t) => t['狀態'] === '已完成').length, 1);

    await page.click('.task-row .item-main');
    await page.click('.sheet button[aria-label=刪除]');
    await page.click('.sheet .btn-danger:has-text("刪除")');
    await page.waitForFunction(() => !document.querySelector('.task-row'));
    assert.equal(a.data().tasks.length, 1);
  });
});

test('習慣打卡、日記撰寫（心情＋發現清單）、分類管理新增選項', { skip }, async () => {
  await withApp({}, async (a) => {
    const { page } = a;
    await a.login();
    await a.go('habits');
    await page.click('.habit-row:has-text("晨間伸展") input.big-check');
    await page.waitForFunction(() => document.querySelector('.habit-row.done'));
    assert.equal(a.data().habits.find((x) => x['習慣名稱'] === '晨間伸展')['今日已完成'], true);

    await page.click('.habit-row:has-text("喝水") button[aria-label=加一]');
    await page.waitForFunction(() => [...document.querySelectorAll('.habit-row')].some((r) => r.textContent.includes('今日 4/8')), null, { timeout: 5000 });
    assert.equal(a.data().habits.find((x) => x['習慣名稱'] === '喝水')['今日等級'], '基礎');

    await a.go('diary');
    await page.click('text=寫今天的日記');
    await page.click('.sheet .mood-btn >> nth=0');
    await page.fill('.sheet .field:has-text("感恩") textarea', '測試順利');
    await page.click('.sheet >> text=新增項目');
    await page.fill('.sheet .find-row input[type=text]', 'Podcast 一集');
    await page.click('.sheet [data-testid=form-save]');
    await page.waitForSelector('.sheet', { state: 'detached' });
    const today = a.data().diaries[0];
    assert.equal(today['心情'], '😄');
    assert.equal(today['感恩'], '測試順利');
    assert.equal(today['發現清單'][0]['內容'], 'Podcast 一集');

    await a.go('admin');
    const card = page.locator('.option-card:has(h3:text-is("任務分類"))');
    await card.locator('input').fill('家庭');
    await card.locator('button:has-text("新增")').click();
    await page.waitForSelector('.option-card:has(h3:text-is("任務分類")) .item:has-text("家庭")');
    assert.ok(a.data().options['任務分類'].includes('家庭'));
  });
});

test('電腦寬度：側邊欄顯示全部模組，底部分頁列隱藏', { skip }, async () => {
  await withApp({ desktop: true, viewport: { width: 1280, height: 800 } }, async (a) => {
    const { page } = a;
    await a.login();
    await page.waitForSelector('.sidebar a[data-tab=courses]');
    assert.equal(await page.locator('.tabbar').isVisible(), false);
    await page.click('.sidebar a[data-tab=projects]');
    await page.waitForSelector('.page-head h1:has-text("專案")');
    await page.click('.item:has-text("搬家計畫")');
    await page.waitForSelector('.sheet:has-text("打包書櫃")');
  });
});
