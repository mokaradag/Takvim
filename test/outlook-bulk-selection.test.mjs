import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyOutlookBulkTasks,
  outlookBulkBlockedReason,
  outlookBulkSkipText,
  selectableOutlookTasks
} from '../src/features/outlook/outlookPresentation.js';

const dated = (id, overrides = {}) => ({ id, task: id, targetFinish: '2026-09-20', status: 'todo', ...overrides });

test('toplu Outlook seçimi atlama nedenlerini birbirinden ayırır', () => {
  const tasks = [
    dated('eligible'),
    dated('completed', { status: 'done' }),
    { id: 'undated', task: 'Terminsiz', status: 'todo' },
    { task: 'Kaydedilmemiş', targetFinish: '2026-09-21', status: 'todo' }
  ];
  const selection = classifyOutlookBulkTasks(tasks);

  assert.deepEqual(selection.eligible.map((task) => task.id), ['eligible']);
  assert.equal(selection.completed, 1);
  assert.equal(selection.unsaved, 1);
  assert.equal(selection.undated, 1);
  assert.deepEqual(selectableOutlookTasks(tasks).map((task) => task.id), ['eligible']);
  assert.equal(
    outlookBulkSkipText(selection),
    '1 tamamlanmış görev atlandı. 1 kaydedilmemiş görev atlandı. 1 görev termini olmadığı için atlandı.'
  );
  assert.equal(outlookBulkBlockedReason(selection), null);
});

test('yalnız tamamlanmış görevler termin hatasıyla etiketlenmez', () => {
  const selection = classifyOutlookBulkTasks([
    dated('done-1', { status: 'done' }),
    dated('done-2', { status: 'done' })
  ]);
  const reason = outlookBulkBlockedReason(selection);

  assert.match(reason, /tamamlanmış/i);
  assert.doesNotMatch(reason, /termin/i);
  assert.equal(outlookBulkSkipText(selection), '2 tamamlanmış görev atlandı.');
});

test('termini olmayan tamamlanmamış seçim mevcut termin açıklamasını korur', () => {
  const selection = classifyOutlookBulkTasks([{ id: 'undated', task: 'Terminsiz', status: 'todo' }]);
  assert.match(outlookBulkBlockedReason(selection), /termini yok/i);
  assert.equal(outlookBulkSkipText(selection), '1 görev termini olmadığı için atlandı.');
});

test('kaydedilmemiş görev ayrı nedenle bildirilir', () => {
  const selection = classifyOutlookBulkTasks([{ task: 'Yeni görev', targetFinish: '2026-09-21', status: 'todo' }]);
  const reason = outlookBulkBlockedReason(selection);
  assert.match(reason, /kaydedilmemiş/i);
  assert.doesNotMatch(reason, /termin/i);
});
