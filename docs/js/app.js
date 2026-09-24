import { h, mount } from './dom.js';
import { icon } from './icons.js';
import { prefs, state, subscribe, applyTheme } from './store.js';
import { refresh, loadCache, systemName } from './data.js';
import * as api from './api.js';
import { closeAllSheets, toast, errorText } from './ui.js';
import { renderLogin } from './views/login.js';
import { renderHome } from './views/home.js';
import { renderTasks, openTaskForm } from './views/tasks.js';
import { renderHabits, renderHabitAdmin, openHabitForm } from './views/habits.js';
import { renderDiary, openDiaryForm } from './views/diary.js';
import { renderProjects, openProjectForm } from './views/projects.js';
import { renderSubs, openSubForm } from './views/subs.js';
import { renderCourses, openCourseForm } from './views/courses.js';
import { renderAdmin } from './views/admin.js';
import { renderSettings } from './views/settings.js';
import { renderMore } from './views/more.js';
import { todayStr } from './util.js';

const app = document.getElementById('app');
// sys：對應「系統索引」分頁的主表分頁名稱，名稱會照使用者在分類管理改的顯示
export const TABS = [
  { id: 'home', label: '總覽', icon: 'home', render: renderHome, mobile: true, fab: () => openTaskForm(null) },
  { id: 'tasks', label: '任務', sys: '任務', icon: 'tasks', render: renderTasks, mobile: true, fab: () => openTaskForm(null) },
  { id: 'habits', label: '習慣', sys: '習慣', icon: 'fire', render: renderHabits, mobile: true },
  { id: 'diary', label: '日記', sys: '日記', icon: 'journal', render: renderDiary, mobile: true, fab: () => openDiaryForm(todayStr(0)) },
  { id: 'projects', label: '專案', sys: '專案', icon: 'folder', render: renderProjects, fab: () => openProjectForm(null) },
  { id: 'subs', label: '訂閱', sys: '訂閱服務', icon: 'cash', render: renderSubs, fab: () => openSubForm(null) },
  { id: 'courses', label: '課程', sys: '課程', icon: 'book', render: renderCourses, fab: () => openCourseForm(null) },
  { id: 'admin', label: '分類管理', icon: 'tags', render: renderAdmin, group: '後台管理' },
  { id: 'habit-admin', label: '習慣管理', icon: 'tools', render: renderHabitAdmin, group: '後台管理', fab: () => openHabitForm(null) },
  { id: 'settings', label: '設定', icon: 'gear', render: renderSettings },
  { id: 'more', label: '更多', icon: 'grid', render: renderMore, mobileOnly: true },
];

export function tabLabel(t) { return t.sys ? systemName(t.sys, t.label) : t.label; }

let viewRoot = null;
let fabBtn = null;
let lastActive = Date.now();

export function parseRoute() {
  const raw = (location.hash || '#/home').replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/');
  return { tab: TABS.some((t) => t.id === parts[0]) ? parts[0] : 'home', sub: parts[1] || '', params: Object.fromEntries(new URLSearchParams(query)) };
}

function renderView() {
  if (!viewRoot || !state.data) return;
  const r = parseRoute();
  const tab = TABS.find((t) => t.id === r.tab);
  const mobileActive = tab.mobile || tab.mobileOnly ? tab.id : 'more';
  document.querySelectorAll('.sidebar [data-tab]').forEach((el) => el.classList.toggle('active', el.dataset.tab === r.tab));
  document.querySelectorAll('.tabbar [data-tab]').forEach((el) => el.classList.toggle('active', el.dataset.tab === mobileActive));
  document.querySelectorAll('[data-tab-label]').forEach((el) => { const t = TABS.find((x) => x.id === el.dataset.tabLabel); el.textContent = tabLabel(t); });
  fabBtn.style.display = tab.fab ? '' : 'none';
  fabBtn.onclick = tab.fab || null;
  try {
    tab.render(viewRoot, r);
  } catch (e) {
    console.error(e);
    mount(viewRoot, h('div', { class: 'notice bad' }, '畫面發生錯誤：' + e.message));
  }
}

function showShell() {
  const link = (t) => h('a', { href: '#/' + t.id, 'data-tab': t.id }, icon(t.icon), h('span', { 'data-tab-label': t.id }, tabLabel(t)));
  const side = [];
  let lastGroup = null;
  TABS.filter((t) => !t.mobileOnly).forEach((t) => {
    if (t.group && t.group !== lastGroup) side.push(h('div', { class: 'nav-group' }, t.group));
    lastGroup = t.group || null;
    if (t.id === 'settings') side.push(h('div', { class: 'spacer' }));
    side.push(link(t));
  });
  viewRoot = h('main', { class: 'main', id: 'view' });
  fabBtn = h('button', { class: 'fab', 'aria-label': '新增' }, icon('plus'));
  const shell = h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, icon('clipboard'), '個人工作台'),
      side,
      h('button', { class: 'navlike', onclick: () => lock('已鎖定') }, icon('lock'), '鎖定')),
    viewRoot,
    h('nav', { class: 'tabbar', 'aria-label': '主選單' }, TABS.filter((t) => t.mobile || t.mobileOnly).map(link)),
    fabBtn);
  mount(app, shell);
  renderView();
}

export function lock(message) {
  api.clearSession();
  state.data = null;
  closeAllSheets();
  viewRoot = null;
  renderLogin(app, { message, onSuccess: start });
}

/** 重新整理全部資料（頁首的重新整理按鈕用） */
export async function reloadAll(btn) {
  if (btn) btn.classList.add('spinning');
  try { await refresh(); toast('已更新'); } catch (e) { if (e.code !== 'AUTH_REQUIRED') toast(errorText(e), { kind: 'bad' }); }
  finally { if (btn) btn.classList.remove('spinning'); }
}

async function start() {
  applyTheme();
  if (!api.hasValidSession()) { renderLogin(app, { onSuccess: start }); return; }
  // 有上次的快取就先畫出來（秒開），背景再抓最新資料；抓失敗就維持舊資料並提示
  const cached = loadCache();
  if (cached) {
    state.data = cached.data;
    state.loadedAt = cached.loadedAt;
    showShell();
    refresh().catch((e) => {
      if (e.code === 'AUTH_REQUIRED') return;
      toast('無法更新資料，目前顯示的是 ' + cached.loadedAt.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) + ' 的資料', { kind: 'bad' });
    });
    return;
  }
  mount(app, h('div', { class: 'boot' }, '載入中…'));
  try {
    await refresh();
    showShell();
  } catch (e) {
    if (e.code === 'AUTH_REQUIRED') return; // 已由 authLost 處理
    mount(app, h('div', { class: 'login' }, h('div', { class: 'panel card center' },
      h('h2', null, '無法載入資料'), h('p', { class: 'muted' }, e.message),
      h('button', { class: 'btn btn-primary btn-block', onclick: start }, '重試'),
      h('button', { class: 'btn btn-ghost btn-block', style: { marginTop: '8px' }, onclick: () => lock() }, '重新登入'))));
  }
}

api.setAuthLostHandler(() => { if (state.data || viewRoot) lock('登入已過期，請重新輸入 PIN'); });
subscribe(renderView);
window.addEventListener('hashchange', () => { closeAllSheets(); renderView(); window.scrollTo(0, 0); });

// 閒置太久自動鎖定（時間取自後端的工作階段效期）
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true }));
setInterval(() => {
  const s = prefs.session;
  if (!s || !viewRoot) return;
  if (Date.now() - lastActive > (s.ttl || 60) * 60000) lock('閒置太久，已自動鎖定');
}, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !viewRoot) return;
  if (!api.hasValidSession()) lock('登入已過期，請重新輸入 PIN');
  // 從背景切回來超過 5 分鐘：可能在別台裝置改過資料，自動重新整理一次
  else if (state.loadedAt && Date.now() - state.loadedAt > 5 * 60000) refresh().catch(() => {});
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); });

start();
