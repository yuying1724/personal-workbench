import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { state, prefs } from '../store.js';
import { write, systemName } from '../data.js';
import { openSheet, confirmDialog, withBusy, errorText } from '../ui.js';
import { todayStr, dateLabel, MOOD_OPTIONS, FIND_TYPE_OPTIONS, FIND_STATUS_CYCLE } from '../util.js';
import { pageHead, stats, empty, textField, field, formFooter, errorBanner } from './common.js';
import { taskPayload } from './tasks.js';

const findStatusIcon = (s) => icon(s === '已整理' ? 'checkCircle' : s === '不需整理' ? 'dashCircle' : 'circle');
const findStatusLabel = (s) => (s === '已整理' ? '已整理' : s === '不需整理' ? '不需整理' : '待整理') + '（點一下切換）';

/** 某天到期、有打星標的任務（日記裡的「今天最重要的任務」） */
function starredTasksOn(dateStr) {
  return (state.data.tasks || []).filter((t) => t['到期日'] === dateStr && t['星標'] === true);
}

function entryCard(dy) {
  const finds = dy['發現清單'] || [];
  const starred = starredTasksOn(dy['日期']);
  const parts = [];
  if (starred.length) parts.push(h('div', null, h('b', null, icon('starFill', 'star'), ' 重要任務 '),
    starred.map((t) => h('span', { class: 'nowrap' }, icon(t['狀態'] === '已完成' ? 'checkCircle' : 'circle'), ' ', t['任務名稱'] || '', '　'))));
  if (dy['感恩']) parts.push(h('div', null, h('b', null, '感恩　'), dy['感恩']));
  if (dy['放手']) parts.push(h('div', null, h('b', null, '放手　'), dy['放手']));
  if (dy['今日重要事項']) parts.push(h('div', null, h('b', null, '重要事項　'), dy['今日重要事項']));
  if (dy['小故事']) parts.push(h('div', null, h('b', null, '小故事　'), dy['小故事']));
  if (finds.length) parts.push(h('div', null, h('b', null, '發現　'), finds.map((f) => h('span', { class: 'nowrap-soft' }, findStatusIcon(f['狀態'] || ''), ' ', `${f['類型']}：${f['內容']}`, '　'))));
  return h('button', { type: 'button', class: 'card diary-card', onclick: () => openDiaryForm(dy['日期']) },
    h('div', { class: 'row-flex between' }, h('div', { class: 'diary-date' }, dateLabel(dy['日期'])), dy['心情'] ? h('span', { class: 'mood' }, dy['心情']) : null),
    parts.length ? h('div', { class: 'diary-snippet' }, parts) : h('div', { class: 'muted small' }, '（這篇還沒寫內容）'));
}

export function renderDiary(root) {
  const d = state.data;
  const s = d.diaryStats || {};
  const today = todayStr(0);
  const entry = (d.diaries || []).find((x) => x['日期'] === today);
  const past = (d.diaries || []).filter((x) => x['日期'] !== today);
  const limit = prefs.getView('diary-limit', 20);
  const backfill = h('input', { type: 'date', value: todayStr(-1), max: today, 'aria-label': '補寫日期' });

  mount(root,
    pageHead(systemName('日記', '日記')),
    stats([['連續寫日記', s.streak ?? 0, ' 天'], ['總篇數', s.total ?? 0]]),
    h('h2', { class: 'section-title' }, '今天'),
    entry ? entryCard(entry) : h('div', { class: 'card center prompt' }, h('div', { class: 'muted' }, '今天還沒寫日記'),
      h('button', { class: 'btn btn-primary', style: { marginTop: '10px' }, onclick: () => openDiaryForm(today) }, icon('edit'), '寫今天的日記')),
    h('div', { class: 'card backfill' },
      h('div', { class: 'row-flex wrap' }, backfill, h('button', { class: 'btn btn-sm', onclick: () => openDiaryForm(backfill.value || todayStr(-1)) }, icon('edit'), '補寫日記')),
      h('div', { class: 'muted small', style: { marginTop: '6px' } }, '忘記寫的日子，選日期補上（那天已經有日記的話會變成編輯）')),
    h('h2', { class: 'section-title' }, '過去的日記'),
    past.length ? h('div', { class: 'stack' }, past.slice(0, limit).map(entryCard),
      past.length > limit ? h('button', { class: 'btn btn-block', onclick: () => { prefs.setView('diary-limit', limit + 30); renderDiary(root); } }, `顯示更多（還有 ${past.length - limit} 篇）`) : null)
      : h('div', { class: 'card' }, empty('還沒有其他日記')));
}

export function openDiaryForm(dateStr) {
  const d = state.data;
  const dy = (d.diaries || []).find((x) => x['日期'] === dateStr) || null;
  const ref = {};
  const err = errorBanner();
  let mood = dy ? dy['心情'] || '' : '';
  const moodBtns = MOOD_OPTIONS.map((m) => h('button', { type: 'button', class: 'mood-btn' + (m === mood ? ' on' : ''), 'aria-label': '心情 ' + m, onclick: () => {
    mood = mood === m ? '' : m;
    moodBtns.forEach((b, i) => b.classList.toggle('on', MOOD_OPTIONS[i] === mood));
  } }, m));

  // 今天最重要的任務：勾選會直接把「任務」標記完成（資料只有一份，不另外存）
  const refTasks = h('div', { class: 'sub-box' });
  function drawRefTasks() {
    const list = starredTasksOn(dateStr);
    mount(refTasks, list.length
      ? [h('div', { class: 'lbl' }, '今天最重要的任務（打星標的任務，勾選會直接標記完成）'), list.map((t) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: t['狀態'] === '已完成', onchange: async (e) => {
          e.target.disabled = true;
          await write('update_task', taskPayload(t, { '狀態': e.target.checked ? '已完成' : '待辦' }), { toast: e.target.checked ? '任務已完成' : '已改回待辦' });
          drawRefTasks();
        } }), icon('starFill', 'star'), t['任務名稱'] || ''))]
      : h('div', { class: 'muted small' }, '這天沒有打星標的重要任務。想在這裡追蹤，可以先到「任務」把該做的事打上星標。'));
  }
  drawRefTasks();

  const gratitude = textField('感恩', dy ? dy['感恩'] : '', { multiline: true, rows: 2, placeholder: '今天有什麼值得感謝的事？' });
  const letGo = textField('放手', dy ? dy['放手'] : '', { multiline: true, rows: 2, placeholder: '有什麼想放下、原諒自己的事？' });
  const story = textField('值得紀錄的小故事', dy ? dy['小故事'] : '', { multiline: true, rows: 3, placeholder: '今天的第一次、最後一次、最開心、最難過…' });

  const findList = h('div', { class: 'stack-sm' });
  const addFind = (f = {}) => {
    let st = f['狀態'] || '';
    const stBtn = h('button', { type: 'button', class: 'icon-btn', title: findStatusLabel(st), 'aria-label': findStatusLabel(st) }, findStatusIcon(st));
    stBtn.addEventListener('click', () => {
      st = FIND_STATUS_CYCLE[(FIND_STATUS_CYCLE.indexOf(st) + 1) % FIND_STATUS_CYCLE.length];
      mount(stBtn, findStatusIcon(st)); stBtn.title = findStatusLabel(st); stBtn.setAttribute('aria-label', findStatusLabel(st));
    });
    const type = h('select', { class: 'find-type' }, FIND_TYPE_OPTIONS.map((t) => h('option', { value: t, selected: f['類型'] === t }, t)));
    const content = h('input', { type: 'text', value: f['內容'] || '', placeholder: '內容／標題，例如：原子習慣' });
    const note = h('textarea', { rows: 2, placeholder: '備註（選填）：為什麼有趣、學到什麼、連結…' }, f['備註'] || '');
    const row = h('div', { class: 'find-row' },
      h('div', { class: 'row-flex' }, type, stBtn, h('button', { type: 'button', class: 'icon-btn', 'aria-label': '刪除項目', onclick: () => row.remove() }, icon('trash'))),
      content, note);
    row._get = () => ({ '類型': type.value, '內容': content.value.trim(), '備註': note.value.trim(), '狀態': st });
    findList.appendChild(row);
    return row;
  };
  (dy ? dy['發現清單'] : []).forEach(addFind);

  const body = h('div', null, err.el,
    field('心情', h('div', { class: 'mood-row' }, moodBtns)),
    refTasks, gratitude.el, letGo.el, story.el,
    field('發現有趣的東西', h('div', null, findList, h('button', { type: 'button', class: 'btn btn-sm', style: { marginTop: '8px' }, onclick: () => addFind({}).querySelector('input').focus() }, icon('plus'), '新增項目'))));

  async function save(btn) {
    err.show('');
    const payload = {
      '日期': dateStr, '心情': mood, '感恩': gratitude.value, '放手': letGo.value, '小故事': story.value,
      '今日重要事項': dy ? dy['今日重要事項'] || '' : '', // 這欄表單沒有，但舊資料要原封不動保留
      '發現清單': [...findList.children].map((r) => r._get()).filter((f) => f['內容']),
    };
    await withBusy(btn, async () => {
      try { await write('create_diary', payload, { throw: true, toast: '日記已儲存' }); ref.sheet.close(); } catch (e) { err.show(errorText(e)); }
    });
  }
  const extra = dy ? [h('button', { class: 'btn btn-danger', type: 'button', 'aria-label': '刪除', onclick: async () => {
    const ok = await confirmDialog({ title: '刪除日記', message: `確定要刪除 ${dateStr} 的日記嗎？此動作無法復原。`, confirmText: '刪除', danger: true });
    if (ok && await write('delete_diary', { '日記ID': dy['日記ID'] }, { toast: '已刪除' })) ref.sheet.close();
  } }, icon('trash'))] : [];
  ref.sheet = openSheet({ title: (dy ? '編輯日記：' : '寫日記：') + dateLabel(dateStr), body, footer: formFooter(ref, save, { extra }), dismissable: false });
}
