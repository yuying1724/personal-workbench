import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { state } from '../store.js';
import { systemName } from '../data.js';
import { todayStr, dateLabel, money, TASK_CLOSED } from '../util.js';
import { pageHead, stats } from './common.js';
import { taskRow } from './tasks.js';
import { habitsByTime } from './habits.js';
import { openDiaryForm } from './diary.js';
import { projectSummary } from './projects.js';

function sectionHead(title, ic, href) {
  return h('a', { class: 'section-link', href }, icon(ic), h('span', { class: 'grow' }, title), icon('chevronRight'));
}

export function renderHome(root) {
  const d = state.data;
  const today = todayStr(0);
  const ts = d.taskStats || {}, hs = d.habitStats || {}, ds = d.diaryStats || {}, ss = d.subscriptionStats || {}, cs = d.courseStats || {};

  // 今天與逾期、還沒做完的任務（星標優先）
  const focus = (d.tasks || []).filter((t) => !TASK_CLOSED.includes(t['狀態'] || '') && t['到期日'] && t['到期日'] <= today)
    .sort((a, b) => (b['星標'] === true) - (a['星標'] === true) || (a['到期日'] || '').localeCompare(b['到期日'] || ''));
  const dueHabits = (d.habits || []).filter((hb) => hb['狀態'] !== '封存' && hb['今日應做'] && !hb['今日已完成']);
  const ps = projectSummary();

  mount(root,
    pageHead('總覽'),
    h('p', { class: 'muted small', style: { marginTop: '-6px' } }, dateLabel(today) + (state.loadedAt ? '　·　更新於 ' + state.loadedAt.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '')),

    h('section', { class: 'section' },
      sectionHead(systemName('任務', '任務'), 'tasks', '#/tasks'),
      stats([['總任務數', ts.total ?? 0], ['已完成', ts.completed ?? 0, ` / ${ts.total ?? 0}`], ['逾期', ts.overdue ?? 0], ['3 天內到期', ts.dueSoon ?? 0]]),
      focus.length ? h('div', { class: 'card' }, h('h3', null, '今天要做'),
        h('ul', { class: 'list' }, focus.slice(0, 8).map((t) => h('li', null, taskRow(t, t['到期日'] < today ? 'overdue' : 'today')))),
        focus.length > 8 ? h('a', { class: 'link-btn', href: '#/tasks' }, `還有 ${focus.length - 8} 項，看全部`) : null)
        : h('div', { class: 'card muted small' }, '今天沒有到期的任務 🎉')),

    h('section', { class: 'section' },
      sectionHead(systemName('習慣', '習慣'), 'fire', '#/habits'),
      stats([['今日進度', hs.doneTodayCount ?? 0, ` / ${hs.dueTodayCount ?? 0}`], ['近7天平均完成率', hs.avgRate7 ?? 0, '%']]),
      dueHabits.length ? habitsByTime(dueHabits, {}) : h('div', { class: 'card muted small' }, '今天的習慣都打卡完了 🎉')),

    h('section', { class: 'section' },
      sectionHead(systemName('日記', '日記'), 'journal', '#/diary'),
      stats([['連續寫日記', ds.streak ?? 0, ' 天'], ['總篇數', ds.total ?? 0]]),
      ds.hasToday ? h('div', { class: 'card muted small' }, '今天寫過日記了 📔')
        : h('div', { class: 'card row-flex between' }, h('span', { class: 'muted' }, '今天還沒寫日記'),
          h('button', { class: 'btn btn-primary btn-sm', onclick: () => openDiaryForm(today) }, icon('edit'), '寫今天的日記'))),

    h('section', { class: 'section' },
      sectionHead(systemName('專案', '專案'), 'folder', '#/projects'),
      stats([['總專案數', ps.total], ['平均完成度', ps.avgPct, '%'], ['已完成', ps.doneCount, ` / ${ps.total}`], ['含逾期任務', ps.overdueTasks]])),

    h('section', { class: 'section' },
      sectionHead(systemName('訂閱服務', '訂閱'), 'cash', '#/subs'),
      stats([['每月總支出', money(ss.totalMonthlySpend)], ['使用中', ss.activeCount ?? 0], ['即將付款', (ss.upcomingPayments || []).length], ['費用偏高提醒', (ss.costWarnings || []).length]])),

    h('section', { class: 'section' },
      sectionHead(systemName('課程', '課程'), 'book', '#/courses'),
      stats([['總課程數', cs.total ?? 0], ['平均進度', cs.avgProgressPercent ?? 0, '%'], ['已完成', cs.completed ?? 0, ` / ${cs.total ?? 0}`]])));
}
