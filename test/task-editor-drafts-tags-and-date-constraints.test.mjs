import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  TURKISH_CALENDAR_WEEKDAYS,
  buildCalendarMonth,
  calendarMonthLabel,
  isDateWithinLimits
} from '../src/components/datePickerCalendar.js';
import { parseDisplayDate } from '../src/components/dateInputFormat.js';
import { resolveTaskTagForProject } from '../src/domain/tags/index.js';
import { validateTaskSchedule } from '../src/domain/validation/index.js';
import { createNewTask } from '../src/state/appState.js';
import { finalTaskFieldPatch } from '../src/features/task-detail/taskDraft.js';

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('uygulama takvimi Türkçe ve her zaman Pazartesiyle başlar', () => {
  assert.deepEqual(TURKISH_CALENDAR_WEEKDAYS, ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz']);
  const august = buildCalendarMonth('2026-08-01');
  assert.equal(august.length, 42);
  assert.equal(august[0].iso, '2026-07-27');
  assert.equal(august[5].iso, '2026-08-01');
  assert.equal(august[6].iso, '2026-08-02');
  assert.equal(calendarMonthLabel('2026-08-01'), 'Ağustos 2026');
  assert.equal(august[5].label, '1 Ağustos 2026');
});

test('takvim ve elle yazılan tarihler aynı kapsayıcı alt/üst sınırları uygular', () => {
  const limits = { minDate: '2026-08-20', maxDate: '2026-08-25' };
  assert.equal(isDateWithinLimits('2026-08-19', limits), false);
  assert.equal(isDateWithinLimits('2026-08-20', limits), true);
  assert.equal(isDateWithinLimits('2026-08-25', limits), true);
  assert.equal(isDateWithinLimits('2026-08-26', limits), false);

  const typedBefore = parseDisplayDate('19/08/2026');
  const typedSameDay = parseDisplayDate('20 Ağu 2026');
  assert.equal(isDateWithinLimits(typedBefore, limits), false);
  assert.equal(isDateWithinLimits(typedSameDay, limits), true);
});

test('görev tarih alanları imkânsız plan ve gerçekleşen aralıklarını daha arayüzde engeller', () => {
  const drawer = read('src/features/task-detail/TaskDrawer.jsx');
  assert.match(drawer, /Planlanan başlangıç[\s\S]*maxDate=\{local\.plannedFinish\}/);
  assert.match(drawer, /Planlanan bitiş[\s\S]*minDate=\{local\.plannedStart\}/);
  assert.match(drawer, /Gerçekleşen başlangıç[\s\S]*maxDate=\{local\.actualFinish\}/);
  assert.match(drawer, /Gerçekleşen bitiş[\s\S]*minDate=\{local\.actualStart\}/);
  assert.match(drawer, /Gerçekleşen bitiş[\s\S]*disabled=\{!local\.actualStart\}/);

  assert.ok(validateTaskSchedule({
    plannedStart: '2026-08-25', plannedFinish: '2026-08-20'
  }).some((issue) => issue.code === 'PLANNED_FINISH_BEFORE_START'));
  assert.ok(validateTaskSchedule({
    actualFinish: '2026-08-25'
  }).some((issue) => issue.code === 'ACTUAL_FINISH_WITHOUT_START'));
  assert.ok(validateTaskSchedule({
    actualStart: '2026-08-25', actualFinish: '2026-08-20'
  }).some((issue) => issue.code === 'ACTUAL_FINISH_BEFORE_START'));
  assert.deepEqual(validateTaskSchedule({
    plannedStart: '2026-08-25', plannedFinish: '2026-08-25',
    actualStart: '2026-08-25', actualFinish: '2026-08-25'
  }), []);
});

test('tarih seçici yerel takvim kullanır ve tarayıcının yerel date girişine dayanmaz', () => {
  const input = read('src/components/DateInput.jsx');
  assert.match(input, /TURKISH_CALENDAR_WEEKDAYS/);
  assert.match(input, /calendarMonthLabel\(month\)/);
  assert.match(input, /dateLimitMessage\(iso, \{ minDate, maxDate, formatDate: formatEditableDate \}\)/);
  assert.doesNotMatch(input, /type="date"/);
  assert.doesNotMatch(input, /showPicker/);
  assert.doesNotMatch(read('src/components/ui-extras.jsx'), /type="date"/);
  assert.doesNotMatch(read('src/hooks/useApplyTweaks.js'), /input\[type="date"\]|en-GB/);
});

test('uzun Notlar metni yalnızca yerel taslak olur ve kapanışta tek yama üretir', () => {
  const drawer = read('src/features/task-detail/TaskDrawer.jsx');
  assert.match(drawer, /onChange=\{\(e\) => changeDescription\(e\.target\.value\)\}/);
  assert.doesNotMatch(drawer, /save\(\{ description: e\.target\.value \}\)/);
  assert.match(drawer, /if \(patch\) await onUpdate\(task\.id, patch\);/);
  assert.match(drawer, /return onClose\(\);/);

  const longNote = 'Uzun not '.repeat(10000);
  const patch = finalTaskFieldPatch({ description: 'Eski' }, { description: longNote }, 'description');
  assert.deepEqual(patch, { description: longNote });
  assert.equal(finalTaskFieldPatch({ description: longNote }, { description: longNote }, 'description'), null);
});

test('proje değişiminde yalnızca aynı geçerli etiket korunur, ilk etiket seçilmez', () => {
  const tags = [{ name: 'Analiz' }, { name: 'Test' }];
  assert.equal(resolveTaskTagForProject('analiz', tags), 'Analiz');
  assert.equal(resolveTaskTagForProject('Eski', tags), '');
  assert.equal(resolveTaskTagForProject('', tags), '');

  const drawer = read('src/features/task-detail/TaskDrawer.jsx');
  assert.doesNotMatch(drawer, /tags\[0\]/);
});

test('yeni görev açık seçim olmadan etiketsiz ve yapay kalan süresiz başlar', () => {
  const task = createNewTask({
    workspaceMode: 'project',
    selectedProjectId: 'p1',
    projects: [{ id: 'p1', name: 'Proje', color: 'blue' }],
    people: [{ id: 'u1', name: 'Sorumlu' }],
    wbs: [{ id: 'w1', projectId: 'p1', parentId: null, code: '1', name: 'Proje' }],
    calendars: []
  }, '2026-08-24', 'new-task');

  assert.equal(task.keyword, '');
  assert.equal(task.remainingDurationDays, null);
  const drawer = read('src/features/task-detail/TaskDrawer.jsx');
  assert.doesNotMatch(drawer, /Kalan süre/);
});

test('Basit Mod boş etiketi zorunlu tutmaz ve göreve açıkça boş değer yollar', () => {
  const panel = read('src/features/simple/SimpleModePanel.jsx');
  assert.match(panel, /if \(!task\.trim\(\) \|\| !dueDate \|\| assigneeIds\.length === 0\)/);
  assert.match(panel, /tags: keyword\.trim\(\) \? \[keyword\.trim\(\)\] : \[\]/);
  assert.match(panel, /keyword: taskKeyword/);
  assert.match(panel, /isteğe bağlı/);
});
