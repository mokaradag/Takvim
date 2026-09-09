import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeDatabase, createFakeSqlServerDriver } from './helpers/fakeSqlServer.mjs';
import { findElement, mountComponent } from './helpers/clientComponentHarness.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const { outlookApplicationLink } = await import('../src/server/outlook/outlookConfig.js');
const { DataModeContext } = await import('../src/components/shell/DataModeContext.jsx');
const { OutlookCalendarAction } = await import('../src/features/outlook/OutlookCalendarAction.jsx');
const outlookStore = await import('../src/features/outlook/outlookSubscriptionStore.js');

const PROJECT_ID = 'A1A1A1A1-1111-4111-8111-111111111111';
const TASK_ID = 'C3C3C3C3-3333-4333-8333-333333333333';
const CALENDAR_ID = 'E5E5E5E5-5555-4555-8555-555555555555';
const OWNER = 900001;

const TASK = Object.freeze({
  id: TASK_ID,
  task: 'Takvim regresyon görevi',
  projectCode: 'P4417041',
  targetFinish: '2026-09-15'
});

function buttonWithLabel(tree, text) {
  return findElement(tree, (node) => node.type === 'button'
    && JSON.stringify(node.props?.children ?? '').includes(text));
}

async function withActualDataMode(run) {
  const previous = DataModeContext._currentValue;
  DataModeContext._currentValue = { dataMode: 'actual', async setDataMode() {} };
  try {
    return await run();
  } finally {
    DataModeContext._currentValue = previous;
  }
}

async function prepareStore(overrides = {}) {
  outlookStore.resetOutlookStore();
  await outlookStore.ensureOutlookState({
    load: async () => ({
      ok: true,
      enabled: true,
      mailConfigured: true,
      schemaReady: true,
      bulkLimit: 25,
      tasks: [],
      ...overrides
    })
  });
}

function restoreEnvironment(name, previous) {
  if (previous == null) delete process.env[name];
  else process.env[name] = previous;
}

test('geçersiz genel Outlook kökeni HTTP(S) istek kökenine düşer ve null bağlantı üretmez', () => {
  const previous = process.env.MERGEN_ROTA_PUBLIC_ORIGIN;
  try {
    process.env.MERGEN_ROTA_PUBLIC_ORIGIN = 'rota.local:3000';
    const fallback = outlookApplicationLink('https://request.example.internal/api/mergen-rota/outlook/tasks');
    assert.equal(new URL(fallback).origin, 'https://request.example.internal');

    process.env.MERGEN_ROTA_PUBLIC_ORIGIN = 'ftp://rota.example.internal';
    assert.equal(outlookApplicationLink(null), null);
  } finally {
    restoreEnvironment('MERGEN_ROTA_PUBLIC_ORIGIN', previous);
  }
});

test('termini veya SMTP yapılandırması olmayan Outlook eylemi gerçekten disabled çizilir', async () => {
  await prepareStore();
  await withActualDataMode(async () => {
    const undated = mountComponent(OutlookCalendarAction, {
      task: { ...TASK, targetFinish: null },
      actions: {}
    });
    try {
      const button = buttonWithLabel(undated.output, "Outlook'a Ekle");
      assert.equal(button.props.disabled, true);
      assert.match(button.props.title, /termin/);
    } finally {
      undated.unmount();
    }
  });

  await prepareStore({ mailConfigured: false });
  await withActualDataMode(async () => {
    const noMail = mountComponent(OutlookCalendarAction, { task: TASK, actions: {} });
    try {
      const button = buttonWithLabel(noMail.output, "Outlook'a Ekle");
      assert.equal(button.props.disabled, true);
      assert.match(button.props.title, /e-posta gönderimi yapılandırılmadığı/);
    } finally {
      noMail.unmount();
      outlookStore.resetOutlookStore();
    }
  });
});

test('kullanıcının açık Outlook ekleme eylemi tükenmiş deneme sayacını SMTP başlamadan sıfırlar', async () => {
  const previous = new Map([
    ['MERGEN_ROTA_DB_SERVER', process.env.MERGEN_ROTA_DB_SERVER],
    ['MERGEN_ROTA_DB_DATABASE', process.env.MERGEN_ROTA_DB_DATABASE],
    ['SMTP_HOST', process.env.SMTP_HOST],
    ['SMTP_FROM', process.env.SMTP_FROM],
    ['SMTP_FROM_NAME', process.env.SMTP_FROM_NAME]
  ]);

  process.env.MERGEN_ROTA_DB_SERVER = 'sqlserver.test.internal';
  process.env.MERGEN_ROTA_DB_DATABASE = 'MERGEN_Rota';
  process.env.SMTP_HOST = 'smtp.test.internal';
  process.env.SMTP_FROM = 'mergen-rota@example.internal';
  process.env.SMTP_FROM_NAME = 'MERGEN Rota';

  const db = createFakeDatabase({
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
    tasks: [{
      TaskId: TASK_ID,
      ProjectId: PROJECT_ID,
      Title: 'Takvim regresyon görevi',
      Status: 'in-progress',
      TargetFinish: '2026-09-15'
    }],
    taskAssignees: [{ TaskId: TASK_ID, Sicil: OWNER }]
  });

  const { setSqlDriverForTests, resetSqlPoolForTests, getSqlPool } = await import('../src/server/db/pool.js');
  setSqlDriverForTests(createFakeSqlServerDriver(db));
  resetSqlPoolForTests();
  try {
    const pool = await getSqlPool();
    const { addTaskToOutlook } = await import('../src/server/outlook/outlookCalendarService.js');
    const failed = await addTaskToOutlook(pool, {
      taskId: TASK_ID,
      sicil: OWNER,
      send: async () => ({
        ok: false,
        code: 'SMTP_CONNECTION_FAILED',
        deliveryMayHaveEscaped: false,
        message: 'E-posta gönderilemedi.'
      })
    });
    assert.equal(failed.status, 'FAILED');

    const row = db.taskOutlookSubscriptions[0];
    row.AttemptCount = 6;
    row.NextAttemptAt = null;
    let attemptDuringSend = null;
    let sent = 0;
    const retried = await addTaskToOutlook(pool, {
      taskId: TASK_ID,
      sicil: OWNER,
      send: async (message) => {
        attemptDuringSend = row.AttemptCount;
        sent += 1;
        return { ok: true, accepted: message.to, rejected: [], messageId: 'retry-1' };
      }
    });

    assert.equal(attemptDuringSend, 1, 'sahiplenme sırasında sayaç yeni deneme için 1 olmalıdır');
    assert.equal(retried.status, 'ADDED');
    assert.equal(sent, 1);
    assert.equal(row.AttemptCount, 0, 'başarılı teslimat sayacı yeniden sıfırlar');
  } finally {
    setSqlDriverForTests(null);
    resetSqlPoolForTests();
    for (const [name, value] of previous) restoreEnvironment(name, value);
  }
});
