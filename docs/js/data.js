import { state, notify } from './store.js';
import * as api from './api.js';
import { toast, errorText } from './ui.js';

/** 重新載入全部資料（登入後第一次、或按「重新整理」） */
export async function refresh() {
  state.data = await api.call('bootstrap');
  state.loadedAt = new Date();
  state.adminStale = false;
  notify();
}

/** 只重抓某個模組（例如 'task_bundle'），合併回 state.data；bundle 回傳的欄位名稱跟 bootstrap 一樣 */
export async function reload(...bundles) {
  const results = await Promise.all(bundles.map((b) => api.call(b)));
  results.forEach((r) => Object.assign(state.data, r));
  state.loadedAt = new Date();
  notify();
}

// 每個寫入動作儲存後要重抓哪些資料
const RELOAD_AFTER = {
  course: ['course_bundle'], subscription: ['sub_bundle'], task: ['project_task_bundle'], project: ['project_task_bundle'],
  habit: ['habit_bundle'], habit_log: ['habit_bundle'], diary: ['diary_bundle'], option: ['admin_bundle'], system: ['admin_bundle'],
};

/**
 * 寫入並重新整理相關資料。失敗時顯示錯誤訊息並回傳 null（呼叫端可以不用 try/catch）。
 * opts.quiet：成功時不跳提示；opts.throw：失敗時把錯誤丟回給呼叫端（表單要顯示在表單裡時用）
 */
export async function write(action, payload, opts = {}) {
  try {
    const result = await api.call(action, payload);
    const kind = action.replace(/^(create|update|delete|skip|set|add|rename)_/, '');
    // 改選項名稱會連動改到各模組的資料，所以整包重抓
    const bundles = action === 'rename_option' ? ['bootstrap'] : RELOAD_AFTER[kind] || ['bootstrap'];
    state.adminStale = true;
    if (bundles[0] === 'bootstrap') await refresh(); else await reload(...bundles);
    if (opts.toast) toast(opts.toast);
    return result || {};
  } catch (e) {
    if (e.code === 'AUTH_REQUIRED') return null;
    if (opts.throw) throw e;
    toast(errorText(e), { kind: 'bad' });
    return null;
  }
}

/** 依「系統索引」分頁的名稱（使用者可在分類管理改名）取得模組顯示名稱 */
export function systemName(sheetKey, fallback) {
  const list = (state.data && state.data.systemIndex) || [];
  const s = list.find((x) => x['主表分頁名稱'] === sheetKey);
  return (s && s['系統名稱']) || fallback;
}
