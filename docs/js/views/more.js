import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { TABS, tabLabel, lock } from '../app.js';
import { pageHead } from './common.js';

/** 手機「更多」頁：底部分頁列放不下的模組都在這裡 */
export function renderMore(root) {
  const item = (t) => h('li', null, h('a', { class: 'item', href: '#/' + t.id },
    h('div', { class: 'ico' }, icon(t.icon)), h('div', { class: 'grow t' }, tabLabel(t)), h('span', { class: 'muted' }, icon('chevronRight'))));
  const modules = TABS.filter((t) => !t.mobile && !t.mobileOnly && !t.group && t.id !== 'settings');
  const admin = TABS.filter((t) => t.group);
  mount(root,
    pageHead('更多'),
    h('div', { class: 'stack' },
      h('div', { class: 'card' }, h('ul', { class: 'list' }, modules.map(item))),
      h('div', { class: 'card' }, h('h2', null, '後台管理'), h('ul', { class: 'list' }, admin.map(item))),
      h('div', { class: 'card' }, h('ul', { class: 'list' }, item(TABS.find((t) => t.id === 'settings')),
        h('li', null, h('button', { class: 'item', type: 'button', onclick: () => lock('已鎖定') }, h('div', { class: 'ico' }, icon('lock')), h('div', { class: 'grow t' }, '鎖定')))))));
}
