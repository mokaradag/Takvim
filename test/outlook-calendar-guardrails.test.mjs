import assert from 'node:assert/strict';
import test from 'node:test';

import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const { renderOutlookInvitationMail } = await import('../src/domain/outlook/outlookMailContent.js');
const { outlookApplicationLink } = await import('../src/server/outlook/outlookConfig.js');
const { enqueueOutlookTaskChange } = await import('../src/server/outlook/outlookCommitHooks.js');
const { OUTLOOK_COMPLETE_SQL } = await import('../src/server/outlook/outlookQueries.js');

function restoreEnvironment(name, previous) {
  if (previous == null) delete process.env[name];
  else process.env[name] = previous;
}

test('Outlook bağlantısı dağıtılmış ortamda HTTPS ister; düz HTTP yalnız yerel geliştirmede kabul edilir', () => {
  const previous = process.env.MERGEN_ROTA_PUBLIC_ORIGIN;
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    process.env.MERGEN_ROTA_PUBLIC_ORIGIN = 'http://rota.example.internal';
    assert.equal(outlookApplicationLink(), null);
    assert.equal(new URL(outlookApplicationLink('https://request.example.internal/api/mergen-rota/outlook/tasks')).origin,
      'https://request.example.internal');
    assert.equal(errors.length, 1, 'geçersiz üretim kökeni açıkça raporlanmalı ve yinelenmemeli');
    assert.equal(errors[0][1]?.code, 'OUTLOOK_PUBLIC_ORIGIN_INVALID');

    process.env.MERGEN_ROTA_PUBLIC_ORIGIN = 'http://localhost:3000';
    assert.equal(new URL(outlookApplicationLink()).origin, 'http://localhost:3000');

    process.env.MERGEN_ROTA_PUBLIC_ORIGIN = 'http://127.0.0.1:3000';
    assert.equal(new URL(outlookApplicationLink()).origin, 'http://127.0.0.1:3000');

    process.env.MERGEN_ROTA_PUBLIC_ORIGIN = 'http://[::1]:3000';
    assert.equal(new URL(outlookApplicationLink()).origin, 'http://[::1]:3000');

    process.env.MERGEN_ROTA_PUBLIC_ORIGIN = 'https://rota.example.internal';
    assert.equal(new URL(outlookApplicationLink()).origin, 'https://rota.example.internal');
    assert.equal(errors.length, 1, 'geçerli kökenler yeni yapılandırma hatası üretmemeli');
  } finally {
    console.error = originalError;
    restoreEnvironment('MERGEN_ROTA_PUBLIC_ORIGIN', previous);
  }
});

test('başarılı Outlook teslimatı kirayı bırakırken daha yeni QueueSeq niyetini korur', () => {
  assert.match(
    OUTLOOK_COMPLETE_SQL,
    /WHERE SubscriptionId = @subscriptionId AND LeaseToken = @leaseToken;/
  );
  assert.match(
    OUTLOOK_COMPLETE_SQL,
    /LastCancellationReason = CASE\s+WHEN QueueSeq <> @queueSeq THEN LastCancellationReason\s+WHEN @completionSuspended = 0 AND @cancellationReason IS NULL AND LastCancellationReason = 'TASK_COMPLETED' THEN NULL\s+ELSE COALESCE\(@cancellationReason, LastCancellationReason\) END/
  );
  assert.match(
    OUTLOOK_COMPLETE_SQL,
    /PendingMethod = CASE\s+WHEN QueueSeq = @queueSeq THEN NULL ELSE PendingMethod END/
  );
  assert.match(
    OUTLOOK_COMPLETE_SQL,
    /IsActive = CASE WHEN @method = 'CANCEL' AND @completionSuspended = 0 AND QueueSeq = @queueSeq/
  );
});

test('tamamlanma günü sunucu saat diliminden değil görevin Rota takviminden hesaplanır', async () => {
  const captured = [];
  const executor = {
    request() {
      const params = {};
      return {
        input(name, _type, value) {
          params[name] = value;
          return this;
        },
        async query(statement) {
          const text = String(statement);
          if (text.includes('AS PlanCalendarId')) {
            return { recordset: [{ PlanCalendarId: 'CAL', TimeZone: 'Europe/Istanbul' }] };
          }
          captured.push({ text, params: { ...params } });
          return { recordset: [] };
        }
      };
    }
  };

  const changed = await enqueueOutlookTaskChange(executor, 'TASK', {
    Status: 'in-progress', ProjectId: 'PROJECT', CalendarId: 'CAL'
  }, {
    Status: 'done', ProjectId: 'PROJECT', CalendarId: 'CAL'
  }, { now: new Date('2026-09-10T22:30:00.000Z') });

  assert.equal(changed, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].params.suspendCompletion, true);
  assert.equal(captured[0].params.completionDate, '2026-09-11');
});

test('REQUEST ve CANCEL HTML gövdeleri kullanıcıya gösterilen teslimat metinlerini ayrı ayrı taşır', () => {
  const payload = {
    summary: 'MERGEN Rota · Teklif',
    date: '2026-09-15',
    fields: { title: 'Teklif', project: 'P4417041' }
  };
  const request = renderOutlookInvitationMail({ method: 'REQUEST', payload });
  const cancel = renderOutlookInvitationMail({ method: 'CANCEL', payload });

  assert.match(request.text, /Outlook daveti gönderildi/);
  assert.match(request.html, /Bu görev için Outlook daveti gönderildi\./);
  assert.match(cancel.text, /Outlook takvim iptali gönderildi/);
  assert.match(cancel.html, /Bu görev için Outlook takvim iptali gönderildi\./);
  assert.doesNotMatch(request.text + request.html + cancel.text + cancel.html, /takviminize eklendi|takviminizden kaldırıldı/);
});