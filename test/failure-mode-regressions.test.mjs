import assert from 'node:assert/strict';
import test from 'node:test';

import { requestJson } from '../src/features/shared/jsonRequest.js';
import { corporateSeed, createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ROOT_WBS_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_ID = '33333333-3333-4333-8333-333333333333';
const CHILD_ID = '44444444-4444-4444-8444-444444444444';
const TASK_ID = '55555555-5555-4555-8555-555555555555';

function projectChanges() {
  return {
    projectUpserts: [{
      id: PROJECT_ID,
      code: 'EDGE-1',
      name: 'Kenar durum projesi',
      source: 'manual',
      color: 'blue',
      leadId: '900001',
      calendarId: DEFAULT_CALENDAR_ID,
      dataDate: '2026-09-01',
      tags: []
    }],
    wbsUpserts: [{
      id: ROOT_WBS_ID,
      projectId: PROJECT_ID,
      parentId: null,
      code: '1',
      name: 'Kenar durum projesi',
      sortOrder: 1
    }]
  };
}

function taskValue(id, overrides = {}) {
  return {
    id,
    projectId: PROJECT_ID,
    wbsId: ROOT_WBS_ID,
    task: 'Kenar durum görevi',
    description: '',
    keyword: '',
    status: 'todo',
    priority: 'medium',
    isMilestone: false,
    milestone: false,
    plannedStart: '2026-09-07',
    plannedFinish: '2026-09-07',
    plannedDurationDays: 1,
    targetFinish: '2026-09-07',
    actualStart: null,
    actualFinish: null,
    remainingDurationDays: null,
    progress: 0,
    plannedHours: null,
    actualHours: null,
    budget: null,
    spent: null,
    recurrence: null,
    recurrenceParentId: null,
    recurrenceOccurrenceDate: null,
    sortOrder: 1,
    assigneeIds: ['900001'],
    deps: [],
    ...overrides
  };
}

async function createProject(stack) {
  const created = await stack.persistence.commitChanges('project/create', projectChanges());
  assert.equal(created.ok, true, created.error?.message);
}

test('bozuk JSON gövdesi eşzamanlı iptal yüzünden REQUEST_CANCELLED sayılmaz', async () => {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  globalThis.fetch = async () => ({
    ok: false,
    async json() {
      caller.abort();
      throw new SyntaxError('Geçersiz JSON');
    }
  });
  try {
    const result = await requestJson('/api/mergen-rota/test', { method: 'GET' }, {
      signal: caller.signal,
      timeoutMs: 1000
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'REQUEST_FAILED');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('karışık harfli yeni tekrar şablonu çocuktan sonra gelse de önce kilitlenir ve yazılır', async () => {
  const stack = await createActualStack(corporateSeed(), { corporateWbsSource: false });
  try {
    await createProject(stack);

    const trace = [];
    const originalRequest = stack.driver.Transaction.prototype.request;
    stack.driver.Transaction.prototype.request = function tracedRequest() {
      const req = originalRequest.call(this);
      const originalQuery = req.query.bind(req);
      req.query = async (statement) => {
        trace.push({ sql: String(statement), params: { ...req.params } });
        return originalQuery(statement);
      };
      return req;
    };
    stack.db.statements.length = 0;
    stack.db.transactions.length = 0;

    const parent = taskValue(PARENT_ID, {
      task: 'Haftalık şablon',
      recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=2'
    });
    const child = taskValue(CHILD_ID, {
      task: 'Haftalık yineleme',
      plannedStart: '2026-09-14',
      plannedFinish: '2026-09-14',
      targetFinish: '2026-09-14',
      recurrenceParentId: PARENT_ID.toUpperCase(),
      recurrenceOccurrenceDate: '2026-09-14',
      sortOrder: 2
    });

    const committed = await stack.persistence.commitChanges('task/series', {
      taskUpserts: [child, parent]
    });
    assert.equal(committed.ok, true, committed.error?.message);
    assert.equal(stack.db.tasks.length, 2);
    assert.equal(String(stack.db.tasks[1].RecurrenceParentTaskId).toLowerCase(), PARENT_ID);

    assert.equal(stack.db.transactions.length, 1);
    assert.equal(stack.db.transactions[0].statementIndex, 0);
    const parentLockIndex = trace.findIndex((entry) => (
      /FROM dbo\.MR_Tasks WITH \(UPDLOCK, HOLDLOCK\)/.test(entry.sql)
      && String(entry.params.entityId || '').toLowerCase() === PARENT_ID
    ));
    const firstTaskInsertIndex = trace.findIndex((entry) => /INSERT dbo\.MR_Tasks\(/.test(entry.sql));
    assert.ok(parentLockIndex >= 0, 'tekrar şablonu sertleştirilmiş işlem içinde kilitlenmelidir');
    assert.ok(firstTaskInsertIndex > parentLockIndex, 'şablon kilidi ilk görev eklemesinden önce alınmalıdır');
  } finally {
    await stack.dispose();
  }
});

test('normal görevden kilometre taşına dar yaşam döngüsü geçişi eski ilerlemeyi taşımaz', async () => {
  const stack = await createActualStack(corporateSeed(), { corporateWbsSource: false });
  try {
    await createProject(stack);
    const created = await stack.persistence.commitChanges('task/create', {
      taskUpserts: [taskValue(TASK_ID, {
        status: 'in_progress',
        progress: 30,
        actualStart: '2026-09-09',
        plannedDurationDays: 0
      })]
    });
    assert.equal(created.ok, true, created.error?.message);

    const current = stack.state.tasks.find((task) => task.id === TASK_ID);
    const {
      status: _status,
      progress: _progress,
      actualStart: _actualStart,
      actualFinish: _actualFinish,
      ...withoutLifecycle
    } = current;
    await stack.repository.commitChanges({
      taskUpserts: [{
        ...withoutLifecycle,
        isMilestone: true,
        milestone: true,
        plannedDurationDays: 0
      }]
    });

    const stored = stack.db.tasks.find((row) => String(row.TaskId).toLowerCase() === TASK_ID);
    assert.equal(stored.IsMilestone, 1);
    assert.equal(stored.Status, 'planned');
    assert.equal(stored.Progress, 0);
    assert.equal(stored.ActualStart, null);
    assert.equal(stored.ActualFinish, null);
  } finally {
    await stack.dispose();
  }
});

test('tamamlanan görevde otomatik gerçek başlangıç ve bitiş tam iş gününe sabitlenir', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-10T12:00:00Z') });
  const stack = await createActualStack(corporateSeed(), { corporateWbsSource: false });
  try {
    await createProject(stack);
    const created = await stack.persistence.commitChanges('task/create', {
      taskUpserts: [taskValue(TASK_ID)]
    });
    assert.equal(created.ok, true, created.error?.message);

    const current = stack.state.tasks.find((task) => task.id === TASK_ID);
    await stack.repository.commitChanges({
      taskUpserts: [{ ...current, status: 'done' }]
    });

    const stored = stack.db.tasks.find((row) => String(row.TaskId).toLowerCase() === TASK_ID);
    assert.equal(stored.Status, 'done');
    assert.equal(stored.Progress, 100);
    assert.equal(stored.ActualStart, '2026-09-10');
    assert.equal(stored.ActualFinish, '2026-09-10');
  } finally {
    await stack.dispose();
  }
});
