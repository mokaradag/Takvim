import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeDatabase, createFakeSqlServerDriver } from './helpers/fakeSqlServer.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

const PROJECT_ID = 'A1A1A1A1-1111-4111-8111-111111111111';
const WBS_ID = 'B2B2B2B2-2222-4222-8222-222222222222';
const TASK_ID = 'C3C3C3C3-3333-4333-8333-333333333333';
const CALENDAR_ID = 'E5E5E5E5-5555-4555-8555-555555555555';
const OWNER = 900001;

function seed() {
  return {
    calendars: [{ CalendarId: CALENDAR_ID, Name: 'Takvim', IsDefault: 1, IsActive: 1 }],
    people: [{ Sicil: OWNER, DisplayName: 'Ayşe Yılmaz', Username: 'ayilmaz' }],
    corporateUsers: [{ Name: 'ayilmaz', EmailAddress: 'ayse.yilmaz@example.internal' }],
    projects: [{
      ProjectId: PROJECT_ID,
      SourceType: 'CORPORATE',
      ProjectCode: 'P4417041',
      ProjectName: 'İHA Projesi',
      CalendarId: CALENDAR_ID,
      IsActive: 1
    }],
    corporateProjectAccess: [{ ProjectCode: 'P4417041', Sicil: OWNER, RoleCode: 'PROJECT_MANAGER' }],
    wbs: [{ WbsId: WBS_ID, ProjectId: PROJECT_ID, ParentWbsId: null, Code: 'P4417041', Name: 'Kök' }],
    tasks: [{
      TaskId: TASK_ID,
      ProjectId: PROJECT_ID,
      WbsId: WBS_ID,
      Title: 'Teklif dosyasının hazırlanması',
      Status: 'in-progress',
      TargetFinish: '2026-09-15'
    }],
    taskAssignees: [{ TaskId: TASK_ID, Sicil: OWNER }]
  };
}

function calendarStart(message) {
  return /\r\nDTSTART;VALUE=DATE:(\d+)\r\n/.exec(message.calendar.content)?.[1];
}

async function withStack(run) {
  registerServerOnlyShim();
  process.env.MERGEN_ROTA_DB_SERVER = 'sqlserver.test.internal';
  process.env.MERGEN_ROTA_DB_DATABASE = 'MERGEN_Rota';
  process.env.MERGEN_ROTA_AUTH_MODE = 'development';
  process.env.MERGEN_ROTA_DEV_IDENTITY_ENABLED = 'true';
  process.env.MERGEN_ROTA_DEV_SICIL = String(OWNER);
  process.env.SMTP_HOST = 'smtp.test.internal';
  process.env.SMTP_FROM = 'mergen-rota@example.internal';
  process.env.SMTP_FROM_NAME = 'MERGEN Rota';

  const db = createFakeDatabase(seed());
  const { setSqlDriverForTests, resetSqlPoolForTests, getSqlPool } = await import('../src/server/db/pool.js');
  const { setCurrentUserProvider } = await import('../src/server/identity/currentUserProvider.js');
  setCurrentUserProvider(null);
  setSqlDriverForTests(createFakeSqlServerDriver(db));
  resetSqlPoolForTests();
  try {
    return await run({ db, pool: await getSqlPool() });
  } finally {
    setSqlDriverForTests(null);
    resetSqlPoolForTests();
  }
}

test('yeni kuyruk nesli eski teslimat hatası temizlenirken korunur', async () => {
  await withStack(async ({ db, pool }) => {
    const api = await import('../src/server/outlook/outlookCalendarService.js');
    const store = await import('../src/server/outlook/outlookStore.js');
    const sent = [];
    const send = async (message) => {
      sent.push(message);
      return { ok: true, accepted: message.to, rejected: [], messageId: `id-${sent.length}` };
    };

    await api.addTaskToOutlook(pool, { taskId: TASK_ID, sicil: OWNER, send });
    const row = db.taskOutlookSubscriptions[0];
    assert.equal(row.DeliveredDate, '2026-09-15');

    db.tasks[0].TargetFinish = '2026-09-21';
    await store.enqueueOutlookTaskUpdate(pool, TASK_ID);
    const failedQueueSeq = row.QueueSeq;

    const failed = await api.runOutlookCalendarOutbox(pool, {
      limit: 1,
      send: async () => {
        db.tasks[0].TargetFinish = '2026-09-22';
        await store.enqueueOutlookTaskUpdate(pool, TASK_ID);
        return { ok: false, code: 'SMTP_NO_RECIPIENTS', deliveryMayHaveEscaped: false };
      }
    });

    assert.equal(failed.failed, 1);
    assert.equal(row.QueueSeq, failedQueueSeq + 1);
    assert.equal(row.PendingMethod, 'REQUEST');
    assert.equal(row.AttemptCount, 0);
    assert.equal(row.LastFailureCode, null);
    assert.equal(row.LeaseToken, null);

    const retried = await api.runOutlookCalendarOutbox(pool, { limit: 1, send });
    assert.equal(retried.sent, 1);
    assert.equal(row.DeliveredDate, '2026-09-22');
    assert.equal(row.PendingMethod, null);
    assert.equal(calendarStart(sent.at(-1)), '20260922');
  });
});
