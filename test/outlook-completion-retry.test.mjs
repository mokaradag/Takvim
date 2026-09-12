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
  assert.match(migration, /CompletionDate = COALESCE\(s\.CompletionDate, CONVERT\(date, SYSUTCDATETIME\(\)\)\)/);
  assert.match(migration, /PendingMethod = COALESCE\(s\.PendingMethod, ''REQUEST''\)/);
  assert.match(migration, /QueueSeq = CASE WHEN s\.PendingMethod IS NULL THEN s\.QueueSeq \+ 1 ELSE s\.QueueSeq END/);
  for (const [field, reset] of [['AttemptCount', '0'], ['NextAttemptAt', 'NULL'], ['LastFailureCode', 'NULL']]) {
    assert.ok(migration.includes(`${field} = CASE WHEN s.PendingMethod IS NULL THEN ${reset} ELSE s.${field} END`));
  }
  assert.match(migration, /WHERE s\.IsActive = 1 AND s\.CancelRequested = 0\s+AND s\.CompletionSuspended = 0 AND t\.Status = ''done'';/);
  assert.doesNotMatch(migration, /CompletionDate = COALESCE\(s\.CompletionDate, CONVERT\(date, SYSDATETIMEOFFSET\(\)\)\)/);
});