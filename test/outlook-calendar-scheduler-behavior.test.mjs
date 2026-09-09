import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeDatabase, createFakeSqlServerDriver } from './helpers/fakeSqlServer.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const PROJECT_ID = 'A1A1A1A1-1111-4111-8111-111111111111';
const WBS_ID = 'B2B2B2B2-2222-4222-8222-222222222222';
const TASK_ID = 'C3C3C3C3-3333-4333-8333-333333333333';
const CALENDAR_ID = 'E5E5E5E5-5555-4555-8555-555555555555';
const SICIL = 900001;

function seed() {
  return {
    calendars: [{ CalendarId: CALENDAR_ID, Name: 'Takvim', IsDefault: 1, IsActive: 1 }],
    people: [{ Sicil: SICIL, DisplayName: 'Ayşe Yılmaz', Username: 'ayilmaz' }],
    corporateUsers: [{ Name: 'ayilmaz', EmailAddress: 'ayse.yilmaz@example.internal' }],
    projects: [{
      ProjectId: PROJECT_ID,
      SourceType: 'CORPORATE',
      ProjectCode: 'P4417041',
      ProjectName: 'İHA Projesi',
      CalendarId: CALENDAR_ID,
      IsActive: 1
    }],
    corporateProjectAccess: [{ ProjectCode: 'P4417041', Sicil: SICIL, RoleCode: 'PROJECT_MANAGER' }],
    wbs: [{ WbsId: WBS_ID, ProjectId: PROJECT_ID, ParentWbsId: null, Code: 'P4417041', Name: 'Kök' }],
    tasks: [{
      TaskId: TASK_ID,
      ProjectId: PROJECT_ID,
      WbsId: WBS_ID,
      Title: 'Teklif dosyasının hazırlanması',
      Status: 'in-progress',
      TargetFinish: '2026-09-15'
    }],
    taskAssignees: [{ TaskId: TASK_ID, Sicil: SICIL }]
  };
}

test('zamanlanmış Outlook teslimatı genel kökeni iCalendar URL alanına taşır', async () => {
  const previous = {
    origin: process.env.MERGEN_ROTA_PUBLIC_ORIGIN,
    host: process.env.SMTP_HOST,
    from: process.env.SMTP_FROM,
    fromName: process.env.SMTP_FROM_NAME,
    dbServer: process.env.MERGEN_ROTA_DB_SERVER,
    dbDatabase: process.env.MERGEN_ROTA_DB_DATABASE
  };
  const { outlookApplicationLink } = await import('../src/server/outlook/outlookConfig.js');
  const { setSqlDriverForTests, resetSqlPoolForTests, getSqlPool } = await import('../src/server/db/pool.js');
  const db = createFakeDatabase(seed());

  delete process.env.MERGEN_ROTA_PUBLIC_ORIGIN;
  assert.equal(outlookApplicationLink(), null);
  process.env.MERGEN_ROTA_PUBLIC_ORIGIN = 'https://rota.example.internal';
  process.env.MERGEN_ROTA_DB_SERVER = 'sqlserver.test.internal';
  process.env.MERGEN_ROTA_DB_DATABASE = 'MERGEN_Rota';
  process.env.SMTP_HOST = 'smtp.test.internal';
  process.env.SMTP_FROM = 'mergen-rota@example.internal';
  process.env.SMTP_FROM_NAME = 'MERGEN Rota';

  setSqlDriverForTests(createFakeSqlServerDriver(db));
  resetSqlPoolForTests();
  try {
    const pool = await getSqlPool();
    const { addTasksToOutlook, runOutlookCalendarOutbox } = await import('../src/server/outlook/outlookCalendarService.js');
    const queued = await addTasksToOutlook(pool, { taskIds: [TASK_ID], sicil: SICIL });
    assert.equal(queued.results[0].status, 'QUEUED');

    const sent = [];
    const link = outlookApplicationLink();
    const summary = await runOutlookCalendarOutbox(pool, {
      link,
      send: async (message) => {
        sent.push(message);
        return { ok: true, accepted: message.to, rejected: [], messageId: 'scheduler-test' };
      }
    });

    assert.equal(summary.sent, 1);
    assert.equal(sent.length, 1);
    const unfolded = sent[0].calendar.content.replace(/\r\n /g, '');
    assert.equal(/\r\nURL:(.+)\r\n/.exec(unfolded)?.[1], link);
    assert.ok(link.startsWith('https://rota.example.internal/'));
  } finally {
    setSqlDriverForTests(null);
    resetSqlPoolForTests();
    for (const [key, value] of Object.entries({
      MERGEN_ROTA_PUBLIC_ORIGIN: previous.origin,
      SMTP_HOST: previous.host,
      SMTP_FROM: previous.from,
      SMTP_FROM_NAME: previous.fromName,
      MERGEN_ROTA_DB_SERVER: previous.dbServer,
      MERGEN_ROTA_DB_DATABASE: previous.dbDatabase
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
