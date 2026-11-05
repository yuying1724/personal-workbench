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
  if (opts.initScript) await ctx.addInitScript(opts.initScript);
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(s.url);
  const a = {
    s, page, ctx, errors,
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

test('指紋／臉部登入：設定裡啟用（先驗 PIN 再跳指紋）、重開自動用指紋登入、鎖定後按按鈕登入、變更 PIN 後仍可用、停用後回到 PIN', { skip }, async () => {
  await withApp({}, async (a) => {
    const { page, ctx, s } = a;
    // WebAuthn 要有合法網域（127.0.0.1 不行），改走 localhost；用 Chrome 的虛擬驗證器模擬「有指紋、驗證都通過、支援 PRF」的手機
    await page.goto(s.url.replace('127.0.0.1', 'localhost'));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
    await a.login(); await page.waitForSelector('.page-head h1:has-text("總覽")');
    assert.equal(await page.locator('[data-testid=bio-login]').count(), 0);
    await a.go('settings');
    await page.waitForSelector('[data-testid=bio-enable]');
    await page.click('[data-testid=bio-enable]');
    await page.fill('.sheet input[aria-label="目前的 PIN"]', '000000');
    await page.click('[data-testid=bio-enroll]');
    await page.waitForFunction(() => /PIN 不正確/.test(document.querySelector('.sheet .notice.bad')?.innerText || ''));
    await page.fill('.sheet input[aria-label="目前的 PIN"]', s.pin);
    await page.click('[data-testid=bio-enroll]');
    await page.waitForFunction(() => /已啟用，下次登入可以用指紋/.test(document.body.innerText));
    await page.waitForFunction(() => /已啟用/.test(document.querySelector('[data-testid=bio-status]')?.innerText || ''));
    const rec = await page.evaluate(() => localStorage.getItem('wb.bio'));
    assert.ok(rec && JSON.parse(rec).ct && !rec.includes(s.pin), '加密後的 PIN 存在裝置裡，不能是明文');
    // session 失效後重開：登入頁有指紋按鈕，而且自動跳驗證、不用輸入 PIN 就進去
    await page.evaluate(() => localStorage.removeItem('wb.session'));
    await page.reload();
    await page.waitForSelector('[data-testid=bio-login]');
    await page.waitForSelector('.tabbar'); // 不用輸入 PIN 就登入了
    // 切換分頁不會再問
    await a.go('diary'); await page.waitForSelector('.page-head h1:has-text("日記")');
    await a.go('habits'); await page.waitForSelector('.page-head h1:has-text("習慣")');
    assert.equal(await page.locator('.login').count(), 0);
    // 從設定「鎖定並登出」：不自動跳，按按鈕才驗
    await a.go('settings');
    await page.click('text=鎖定並登出');
    await page.waitForSelector('[data-testid=bio-login]');
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.tabbar').count(), 0, '主動登出後不該自動用指紋登入');
    await page.click('[data-testid=bio-login]');
    await page.waitForSelector('.tabbar');
    // 變更 PIN：指紋登入跟著更新（用新 PIN 重新加密），登出再用指紋登入成功
    await a.go('settings');
    await page.click('text=變更 PIN');
    const inputs = page.locator('.sheet input[type=password]');
    await inputs.nth(0).fill(s.pin); await inputs.nth(1).fill('975310'); await inputs.nth(2).fill('975310');
    await page.click('.sheet-foot .btn-primary');
    await page.waitForFunction(() => /指紋登入已更新/.test(document.body.innerText));
    await page.evaluate(() => localStorage.removeItem('wb.session'));
    await page.reload();
    await page.waitForSelector('.tabbar');
    // 存起來的密文被動過：顯示錯誤，還是可以輸入 PIN 登入
    await page.evaluate(() => { const r = JSON.parse(localStorage.getItem('wb.bio')); r.ct = r.ct.slice(0, -3) + (r.ct.endsWith('AAA') ? 'BBB' : 'AAA'); localStorage.setItem('wb.bio', JSON.stringify(r)); });
    await a.go('settings');
    await page.click('text=鎖定並登出');
    await page.waitForSelector('[data-testid=bio-login]');
    await page.click('[data-testid=bio-login]');
    await page.waitForFunction(() => /解不開存起來的 PIN/.test(document.querySelector('.login .notice.bad')?.innerText || ''));
    await page.fill('input[aria-label="PIN"]', '975310');
    await page.click('button[type=submit]');
    await page.waitForSelector('.tabbar');
    // 停用：登入頁沒有指紋按鈕
    await a.go('settings');
    await page.click('[data-testid=bio-disable]');
    await page.click('.sheet-foot .btn-danger');
    await page.waitForFunction(() => /未啟用/.test(document.body.innerText));
    await page.click('text=鎖定並登出');
    await page.waitForSelector('input[aria-label="PIN"]');
    assert.equal(await page.locator('[data-testid=bio-login]').count(), 0);
  });
});

test('日記進入前驗證：設定裡開啟（預設 5 分鐘）、進日記先驗指紋、幾分鐘內不再問、每次進入都驗、離開 App 就重驗、沒過可改 PIN、鎖著時＋不開表單、關掉後照常', { skip }, async () => {
  await withApp({}, async (a) => {
    const { page, ctx, s } = a;
    await page.goto(s.url.replace('127.0.0.1', 'localhost'));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
    const lockShown = () => page.locator('[data-testid=diary-lock]').count();
    const goDiary = () => page.evaluate(() => { location.hash = '#/diary'; }); // 不等待：要抓到鎖定畫面出現的那一刻（150ms 後才自動跳指紋）
    const expectLockThenAutoUnlock = async (why) => {
      await page.waitForSelector('[data-testid=diary-lock]', { timeout: 3000 }).catch(() => assert.fail(why + '：應該出現鎖定畫面'));
      await page.waitForFunction(() => !document.querySelector('[data-testid=diary-lock]')); // 虛擬指紋驗證通過 → 自動解鎖
    };
    const goHidden = () => page.evaluate(() => { // 模擬切到背景再切回來
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange'));
    });
    await a.login(); await page.waitForSelector('.page-head h1:has-text("總覽")');
    // 先啟用指紋
    await a.go('settings');
    await page.click('[data-testid=bio-enable]');
    await page.fill('.sheet input[aria-label="目前的 PIN"]', s.pin);
    await page.click('[data-testid=bio-enroll]');
    await page.waitForFunction(() => /已啟用/.test(document.querySelector('[data-testid=bio-status]')?.innerText || ''));
    // 還沒開：進日記不會問
    await a.go('diary'); await page.waitForSelector('.page-head h1:has-text("日記")');
    assert.equal(await lockShown(), 0);
    // 開啟：預設「5 分鐘內不再問」
    await a.go('settings');
    await page.click('[data-testid=diary-lock-toggle]');
    await page.waitForSelector('[data-testid=diary-lock-mode]');
    assert.equal(await page.inputValue('[data-testid=diary-lock-mode]'), '5');
    assert.equal(await page.evaluate(() => localStorage.getItem('wb.diaryLock')), '5');
    await goDiary(); await expectLockThenAutoUnlock('開啟後第一次進日記');
    // 5 分鐘內：切出去再回來不問；其他頁面從頭到尾都不會問
    await a.go('habits'); await page.waitForSelector('.page-head h1:has-text("習慣")');
    assert.equal(await lockShown(), 0);
    await a.go('diary'); await page.waitForTimeout(300);
    assert.equal(await lockShown(), 0, '5 分鐘內再進日記不該再問');
    // 重新整理後要再驗（驗證狀態只在記憶體）
    await page.reload(); await page.waitForSelector('.tabbar');
    await goDiary(); await expectLockThenAutoUnlock('重新整理後');
    // 「每次進入都驗」：改設定當下不用重驗；離開日記再回來就問
    await a.go('settings');
    await page.selectOption('[data-testid=diary-lock-mode]', '0');
    await a.go('diary'); await page.waitForTimeout(300);
    assert.equal(await lockShown(), 0, '剛驗過、還沒離開過日記：不問');
    await a.go('habits');
    await goDiary(); await expectLockThenAutoUnlock('每次進入都驗：離開再回來');
    // 「到離開 App 為止」：切分頁不問，切到背景再回來就問
    await a.go('settings');
    await page.selectOption('[data-testid=diary-lock-mode]', 'app');
    await a.go('habits'); await a.go('diary'); await page.waitForTimeout(300);
    assert.equal(await lockShown(), 0, '到離開 App 為止：切分頁不問');
    await goHidden(); await expectLockThenAutoUnlock('到離開 App 為止：切到背景再回來');
    // 指紋沒過（Chrome 的虛擬驗證器一旦設成沒過就改不回來，所以放最後）：鎖定畫面留著；鎖著時按右下角＋不開表單；改用 PIN（錯的會提示）
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
    await goHidden();
    await page.waitForSelector('[data-testid=diary-lock]');
    await page.waitForTimeout(500);
    assert.equal(await lockShown(), 1, '自動驗證沒過，鎖定畫面要留著');
    assert.equal(await page.locator('.sheet').count(), 0);
    await page.click('.fab');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.sheet').count(), 0, '鎖著時不能直接開日記表單');
    await page.click('[data-testid=diary-bio]');
    await page.waitForFunction(() => /沒有通過/.test(document.querySelector('[data-testid=diary-lock] .notice.bad')?.innerText || ''));
    await page.click('text=改用 PIN');
    await page.fill('[data-testid=diary-lock] input[aria-label="PIN"]', '000000');
    await page.click('[data-testid=diary-pin-submit]');
    await page.waitForFunction(() => /PIN 不正確/.test(document.querySelector('[data-testid=diary-lock] .notice.bad')?.innerText || ''));
    await page.fill('[data-testid=diary-lock] input[aria-label="PIN"]', s.pin);
    await page.click('[data-testid=diary-pin-submit]');
    await page.waitForFunction(() => !document.querySelector('[data-testid=diary-lock]'));
    await page.click('.fab'); await page.waitForSelector('.sheet'); await page.click('.sheet [aria-label="關閉"]'); await page.waitForFunction(() => !document.querySelector('.sheet'));
    // 關掉：不再問（指紋還是「沒過」的狀態，所以沒問就代表真的關了）
    await a.go('settings');
    await page.click('[data-testid=diary-lock-toggle]');
    await page.waitForFunction(() => !document.querySelector('[data-testid=diary-lock-mode]'));
    assert.equal(await page.evaluate(() => localStorage.getItem('wb.diaryLock')), null);
    await a.go('diary'); await page.waitForTimeout(300);
    assert.equal(await lockShown(), 0);
  });
});

test('課程列表：右邊的外連按鈕直接在新分頁開課程、點列本身才編輯；沒連結的顯示箭頭；表單裡連結旁有「開啟」並跟著輸入更新', { skip }, async () => {
  await withApp({}, async (a) => {
    const { page, ctx } = a;
    await ctx.route('https://www.udemy.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>udemy</title>ok' }));
    await a.login();
    await a.go('courses');
    await page.waitForSelector('[data-testid=course-row]');
    const withLink = page.locator('[data-testid=course-row]:has-text("Spring Boot 實戰")');
    const noLink = page.locator('[data-testid=course-row]:has-text("系統分析與設計")');
    const open = withLink.locator('[data-testid=course-open]');
    assert.equal(await open.getAttribute('href'), 'https://www.udemy.com/course/spring-boot-demo/');
    assert.equal(await open.getAttribute('target'), '_blank');
    assert.equal(await withLink.locator('.chev').count(), 0);
    assert.equal(await noLink.locator('[data-testid=course-open]').count(), 0);
    assert.equal(await noLink.locator('.chev').count(), 1);
    // 按鈕要夠大好點（44px），而且點它不會打開編輯表單
    const box = await open.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, '外連按鈕至少 44px');
    const [popup] = await Promise.all([ctx.waitForEvent('page'), open.click()]);
    await popup.waitForLoadState();
    assert.equal(popup.url(), 'https://www.udemy.com/course/spring-boot-demo/');
    await popup.close();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.sheet').count(), 0, '點外連按鈕不該開編輯表單');
    // 點列本身：開編輯表單，連結欄位就在名稱下面、旁邊有「開啟」
    await withLink.locator('.course-main').click();
    await page.waitForSelector('.sheet [data-testid=course-form-open]');
    const formOpen = page.locator('.sheet [data-testid=course-form-open]');
    assert.equal(await formOpen.getAttribute('href'), 'https://www.udemy.com/course/spring-boot-demo/');
    const linkInput = page.locator('.sheet input[type=url]');
    await linkInput.fill('');
    assert.equal(await formOpen.isVisible(), false, '沒有連結就不顯示「開啟」');
    await linkInput.fill('https://www.udemy.com/course/other/');
    assert.equal(await formOpen.isVisible(), true);
    assert.equal(await formOpen.getAttribute('href'), 'https://www.udemy.com/course/other/');
    await linkInput.fill('javascript:alert(1)');
    assert.equal(await formOpen.isVisible(), false, '不是 http(s) 的連結不給開');
  });
});

/** 模擬手機上的推播環境：假的 service worker 登錄、PushManager、Notification（測試用 context 擋掉了真的 service worker） */
const PUSH_INIT = () => {
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-sub-1', toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'BKxE2E', auth: 'auE2E' } }; }, unsubscribe: async () => { reg.__sub = null; window.__pushUnsub = true; return true; } };
  const reg = { __sub: null, scope: location.origin + '/', update: async () => {}, pushManager: { getSubscription: async () => reg.__sub, subscribe: async (o) => { window.__pushOpts = { userVisibleOnly: o.userVisibleOnly, keyLen: o.applicationServerKey.length, firstByte: o.applicationServerKey[0] }; reg.__sub = sub; return sub; } } };
  Object.defineProperty(navigator, 'serviceWorker', { value: { getRegistration: async () => reg, ready: Promise.resolve(reg), register: async () => reg, addEventListener() {}, controller: null }, configurable: true });
  window.PushManager = function PushManager() {};
  window.__notifPerm = 'granted';
  window.Notification = { get permission() { return window.__notifPerm; }, requestPermission: async () => window.__notifPerm };
};

test('推播通知：設定頁先選好時段再開啟（要求權限、向瀏覽器登記、交給後端）、改時間與開關、同時間擋下、測試推播、關閉；權限被拒時不能開', { skip }, async () => {
  await withApp({ initScript: PUSH_INIT }, async (a) => {
    const { page, s } = a;
    const be = s.backend;
    await a.login();
    await a.go('settings');
    await page.waitForFunction(() => /未開啟/.test(document.querySelector('[data-testid=push-status]')?.innerText || ''));
    assert.equal(await page.locator('[data-testid=push-slots] .push-slot').count(), 4);
    // 開啟前先把中午關掉、晚上改 19 點
    await page.uncheck('[data-testid=push-on-noon]');
    await page.selectOption('[data-testid=push-hour-evening]', '19');
    await page.click('[data-testid=push-enable]');
    await page.waitForFunction(() => /已開啟/.test(document.querySelector('[data-testid=push-status]')?.innerText || ''));
    const opts = await page.evaluate(() => window.__pushOpts);
    assert.deepEqual(opts, { userVisibleOnly: true, keyLen: 65, firstByte: 4 }, '向瀏覽器登記時用了後端的 VAPID 公鑰');
    const subs = be.call('push_info').data.subscriptions;
    assert.equal(subs.length, 1); assert.equal(subs[0].label, '開發用瀏覽器');
    assert.deepEqual(subs[0].slots, { morning: { on: true, hour: 8 }, noon: { on: false, hour: 12 }, evening: { on: true, hour: 19 }, night: { on: true, hour: 22 } });
    assert.ok(be.state.triggers.some((t) => t.getHandlerFunction() === 'pushJob'));
    const meta = await page.evaluate(async () => { const c = await caches.open('wb-push'); const t = await c.match('./push-token'); const u = await c.match('./push-api'); return { token: t ? (await t.text()).length : 0, api: u ? await u.text() : '' }; });
    assert.equal(meta.token, 48); assert.ok(meta.api.startsWith('http'));
    // 開啟後畫面顯示剛才的設定
    assert.equal(await page.locator('[data-testid=push-on-noon]').isChecked(), false);
    assert.equal(await page.locator('[data-testid=push-hour-evening]').inputValue(), '19');
    // 改時間／開關會立刻送後端
    await page.selectOption('[data-testid=push-hour-morning]', '7');
    await page.waitForFunction(() => /早上改成 7 點/.test(document.querySelector('.toast')?.innerText || ''));
    await page.check('[data-testid=push-on-noon]');
    await page.waitForFunction(() => /已開啟中午/.test(document.querySelector('.toast')?.innerText || ''));
    const s2 = be.call('push_info').data.subscriptions[0].slots;
    assert.equal(s2.morning.hour, 7); assert.equal(s2.noon.on, true);
    // 睡前改成跟晚上同一個時間：後端擋下、畫面退回
    await page.selectOption('[data-testid=push-hour-night]', '19');
    await page.waitForFunction(() => /不能選同一個時間/.test(document.querySelector('.toast')?.innerText || ''));
    assert.equal(await page.locator('[data-testid=push-hour-night]').inputValue(), '22');
    assert.equal(be.call('push_info').data.subscriptions[0].slots.night.hour, 22);
    // 測試推播：後端真的對推播網址送出（模擬推播服務回 201）
    const sent = [];
    be.state.urlFetch.handler = (url, o) => { sent.push({ url, o }); return { code: 201, body: '' }; };
    await page.click('[data-testid=push-test]');
    await page.waitForFunction(() => /已送出測試通知/.test(document.querySelector('.toast')?.innerText || ''));
    assert.equal(sent.length, 1); assert.equal(sent[0].url, 'https://fcm.googleapis.com/fcm/send/e2e-sub-1');
    assert.match(sent[0].o.headers.Authorization, /^vapid t=/);
    // 裝置摘要碼被清掉（例如按過「清除快取並重新載入」）：再進設定頁會自動重新登記、換新的摘要碼，不用關掉再開
    const tokenBefore = await page.evaluate(async () => (await (await caches.open('wb-push')).match('./push-token')).text());
    await page.evaluate(() => caches.delete('wb-push'));
    await a.go('home'); await a.go('settings');
    await page.waitForFunction(async () => { const c = await caches.open('wb-push'); return !!(await c.match('./push-token')); });
    const tokenAfter = await page.evaluate(async () => (await (await caches.open('wb-push')).match('./push-token')).text());
    assert.notEqual(tokenAfter, tokenBefore); assert.equal(tokenAfter.length, 48);
    assert.equal(be.call('push_info').data.subscriptions.length, 1, '同一支手機還是一筆');
    assert.equal(be.post({ action: 'push_summary', params: { token: tokenAfter } }).ok, true, '新摘要碼可以拿摘要');
    assert.equal(be.post({ action: 'push_summary', params: { token: tokenBefore } }).error.code, 'AUTH_FAILED', '舊的作廢');
    // 關閉：瀏覽器取消登記、後端移除、快取清掉
    await page.click('[data-testid=push-disable]');
    await page.waitForFunction(() => /未開啟/.test(document.querySelector('[data-testid=push-status]')?.innerText || ''));
    assert.equal(be.call('push_info').data.subscriptions.length, 0);
    assert.equal(await page.evaluate(() => window.__pushUnsub), true);
    assert.equal(await page.evaluate(() => caches.has('wb-push')), false);
    // 權限被拒：按鈕停用、說明怎麼解
    await page.evaluate(() => { window.__notifPerm = 'denied'; });
    await a.go('home'); await a.go('settings');
    await page.waitForFunction(() => /被封鎖/.test(document.querySelector('[data-testid=push-status]')?.innerText || ''));
    assert.equal(await page.locator('[data-testid=push-enable]').isDisabled(), true);
  });
});

test('service worker 收到推播：用裝置摘要碼向後端拿內容顯示完整通知；拿不到（碼被換掉）就顯示一般提醒並記下原因、設定頁看得到', { skip }, async () => {
  const s = await startDevServer({ demo: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-TW' });
  try {
    const origin = s.url.replace('127.0.0.1', 'localhost');
    await ctx.grantPermissions(['notifications'], { origin });
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(origin);
    await page.waitForFunction(() => document.activeElement && document.activeElement.tagName === 'INPUT');
    await page.fill('input[placeholder^="XXXXX"]', s.token); await page.fill('input[aria-label="PIN"]', s.pin); await page.click('button[type=submit]');
    await page.waitForSelector('.page-head');
    await page.evaluate(() => navigator.serviceWorker.ready);
    const be = s.backend;
    // 這個測試瀏覽器沒有真的推播服務：直接向後端登記一筆訂閱，把摘要碼放進 service worker 用的小倉庫
    const sub = be.call('push_subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/sw-test', keys: { p256dh: 'x', auth: 'y' } }).data;
    be.state.urlFetch.handler = () => ({ code: 201, body: '' });
    assert.ok(be.call('push_test', { id: sub.id, slot: 'morning' }).ok);
    await page.evaluate(async ({ token }) => {
      const c = await caches.open('wb-push');
      await c.put('./push-token', new Response(token)); await c.put('./push-api', new Response(new URL('/api', location.href).href));
      localStorage.setItem('wb.push', JSON.stringify({ id: 'x', slots: null }));
    }, { token: sub.token });
    const reg = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return r.scope; });
    const cdp = await ctx.newCDPSession(page);
    let regId = null;
    const seen = [];
    cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => { for (const r of e.registrations) { seen.push(r.scopeURL); if (r.scopeURL === reg) regId = r.registrationId; } });
    cdp.on('ServiceWorker.workerVersionUpdated', (e) => { for (const v of e.versions) if (!regId && v.scriptURL.startsWith(reg)) regId = v.registrationId; });
    await cdp.send('ServiceWorker.enable');
    for (let i = 0; i < 30 && !regId; i++) await page.waitForTimeout(100);
    if (!regId) console.log('scopes seen', seen, reg);
    assert.ok(regId, '找得到 service worker');
    // 無頭瀏覽器不會保留通知，所以看 service worker 記下的結果（顯示的標題、內文、有沒有拿到）
    const lastOf = () => page.evaluate(async () => { const r = await (await caches.open('wb-push')).match('./push-last'); return r ? r.json() : null; });
    const push = async () => {
      await page.evaluate(async () => (await caches.open('wb-push')).delete('./push-last'));
      await cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(origin).origin, registrationId: regId, data: '' });
      for (let i = 0; i < 150; i++) { const v = await lastOf(); if (v) return v; await page.waitForTimeout(200); }
      return null;
    };
    let last = await push();
    assert.equal(last.ok, true, JSON.stringify(last));
    assert.equal(last.title, '早上提醒'); assert.match(last.body, /^📌|^✅|^⏰/);
    assert.ok(be.call('push_info').data.subscriptions[0].fetchedAt, '後端記下手機來拿的時間');
    // 摘要碼被換掉（例如另一個地方重新登記）：顯示一般提醒，記下原因；設定頁看得到
    be.call('push_subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/sw-test', keys: { p256dh: 'x', auth: 'y' } });
    last = await push();
    assert.equal(last.ok, false); assert.equal(last.title, '個人工作台'); assert.equal(last.body, '有事要處理，點開查看');
    assert.match(last.error, /裝置碼無效/);
    assert.ok(be.call('push_info').data.badTokenAt);
  } finally { await ctx.close(); await s.close(); }
});
