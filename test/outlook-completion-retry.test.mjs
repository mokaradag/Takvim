import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { outlookCompletionNeedsCancellation } from '../src/domain/outlook/outlookCompletion.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function completedSubscription(overrides = {}) {
  return {
    deliveredMethod: 'REQUEST',
    deliveredSequence: 1,
    deliveredDate: '2026-09-15',
    pendingSequence: null,
    pendingPayloadHash: null,
    pendingDate: null,
    deliveryMayHaveEscaped: false,
    lastCancellationReason: null,
    completionDate: '2026-09-10',
    ...overrides
  };
}

test('tamamlanma iptali kalıcı tamamlanma gününü kullanır', () => {
  const subscription = completedSubscription();
  assert.equal(outlookCompletionNeedsCancellation(subscription, '2026-09-15'), true);
  assert.equal(outlookCompletionNeedsCancellation({ ...subscription, completionDate: '2026-09-16' }, '2026-09-15'), false);
});

test('tamamlanma günü yoksa hareketli sistem gününe düşülmez', () => {
  const subscription = completedSubscription({ completionDate: null });
  assert.equal(outlookCompletionNeedsCancellation(subscription, '2026-09-15'), false);
  assert.equal(outlookCompletionNeedsCancellation({
    ...subscription,
    lastCancellationReason: 'TASK_COMPLETED',
    pendingSequence: 2,
    pendingPayloadHash: 'cancel-hash'
  }, '2026-09-15'), true, 'ayrılmış CANCEL yeniden denemede korunmalı');
});

test('0011 eski tamamlanmış abonelikleri tek UPDATE ile UTC ilk gözlem gününe taşır', () => {
  const migration = fs.readFileSync(path.join(ROOT, 'database/MR_Upgrade_0011_Outlook_Completion_Lifecycle.sql'), 'utf8');
  assert.match(migration, /UPDATE s\s+SET CompletionSuspended = 1,\s+CompletionDate = COALESCE\(s\.CompletionDate, CONVERT\(date, SYSUTCDATETIME\(\)\)\),\s+LastCancellationReason = COALESCE\(s\.LastCancellationReason, ''TASK_COMPLETED''\)\s+FROM dbo\.MR_TaskOutlookSubscriptions s\s+JOIN dbo\.MR_Tasks t ON t\.TaskId = s\.TaskId\s+WHERE s\.IsActive = 1 AND t\.Status = ''done'';/s);
  assert.doesNotMatch(migration, /CompletionDate = COALESCE\(s\.CompletionDate, CONVERT\(date, SYSDATETIMEOFFSET\(\)\)\)/);
});