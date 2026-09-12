import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeDatabase, createFakeSqlServerDriver } from './helpers/fakeSqlServer.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

const PROJECT_ID = 'A1A1A1A1-1111-4111-8111-111111111111';
const WBS_ID = 'B2B2B2B2-2222-4222-8222-222222222222';
const FIRST_TASK_ID = 'C3C3C3C3-3333-4333-8333-333333333333';
const SECOND_TASK_ID = 'D4D4D4D4-4444-4444-8444-444444444444';
const CALENDAR_ID = 'E5E5E5E5-5555-4555-8555-555555555555';
const OWNER = 900001;

function seed() {
  const parent = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  return {
    calendars: [{ CalendarId: CALENDAR_ID, Name: 'Takvim', TimeZone: 'Europe/Istanbul', IsDefault: 1, IsActive: 1 }],
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
    tasks: [
      {
        TaskId: FIRST_TASK_ID,
        ProjectId: PROJECT_ID,
        WbsId: WBS_ID,
        Title: 'Birinci tekrar',
        Status: 'todo',
        TargetFinish: '2026-09-15',
        PlannedStart: '2026-01-01',
        RecurrenceParentTaskId: parent,
        RecurrenceOccurrenceDate: '2026-09-15',
        RecurrenceRule: null
      },
      {
        TaskId: SECOND_TASK_ID,
        ProjectId: PROJECT_ID,
        WbsId: WBS_ID,
        Title: 'İkinci tekrar',
        Status: 'todo',
        TargetFinish: '2026-09-20',
        PlannedStart: '2026-01-01',
        RecurrenceParentTaskId: parent,
        RecurrenceOccurrenceDate: '2026-09-20',
        RecurrenceRule: null
      }
    ]
  };
}

function unfoldedCalendar(message) {
  return message.calendar.content.replace(/\r\n /g, '');
}

function calendarStart(message) {
  return /\r\nDTSTART;VALUE=DATE:(\d{8})\r\n/.exec(unfoldedCalendar(message))?.[1] || null;
}

function calendarSummary(message) {
  return /\r\nSUMMARY:([^\r\n]*)\r\n/.exec(unfoldedCalendar(message))?.[1] || null;
}

test('tekrar oluşumları kendi kesin termin günleriyle gönderilir', async () => {
  registerServerOnlyShim();
  process.env.MERGEN_ROTA_DB_SERVER = 'sqlserver.test.internal';
  process.env.MERGEN_ROTA_DB_DATABASE = 'MERGEN_Rota';
  process.env.MERGEN_ROTA_AUTH_MODE = 'development';
  process.env.MERGEN_ROTA_DEV_IDENTITY_ENABLED = 'true';
  process.env.MERGEN_ROTA_DEV_SICIL = String(OWNER);
  process.env.MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED = 'true';
  process.env.SMTP_HOST = 'smtp.test.internal';
  process.env.SMTP_FROM = 'mergen-rota@example.internal';

  const db = createFakeDatabase(seed());
  const { setSqlDriverForTests, resetSqlPoolForTests, getSqlPool } = await import('../src/server/db/pool.js');
  const { setCurrentUserProvider } = await import('../src/server/identity/currentUserProvider.js');
  setCurrentUserProvider(null);
  setSqlDriverForTests(createFakeSqlServerDriver(db));
  resetSqlPoolForTests();
  try {
    const pool = await getSqlPool();
    const api = await import('../src/server/outlook/outlookCalendarService.js');
    const sent = [];
    const send = async (message) => {
      sent.push(message);
      return { ok: true, accepted: message.to, rejected: [], messageId: `exact-${sent.length}` };
    };

    await api.addTasksToOutlook(pool, { taskIds: [FIRST_TASK_ID, SECOND_TASK_ID], sicil: OWNER });
    await api.runOutlookCalendarOutbox(pool, { send });

    assert.equal(sent.length, 2);
    assert.deepEqual(Object.fromEntries(sent.map((message) => [calendarSummary(message), calendarStart(message)])), {
      'MERGEN Rota · Birinci tekrar': '20260915',
      'MERGEN Rota · İkinci tekrar': '20260920'
    });
    for (const message of sent) {
      assert.match(message.calendar.content, /TRANSP:TRANSPARENT/);
      assert.match(message.calendar.content, /X-MICROSOFT-CDO-BUSYSTATUS:FREE/);
      assert.doesNotMatch(message.calendar.content, /RRULE|RECURRENCE-ID|VALARM|DTSTART.*T[0-9]/);
    }
  } finally {
    setSqlDriverForTests(null);
    resetSqlPoolForTests();
  }
});
