import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { scheduleRequestItems } from '../src/features/schedule-change/scheduleRequestQueryState.js';

test('görev tarih talebi sorgulanırken mevcut bildirim önizlemesi korunur', () => {
  const preview = [{ id: 'preview-request', taskId: 'task-1', status: 'PENDING', isRequester: true }];
  const authoritative = [{ id: 'authoritative-request', taskId: 'task-1', status: 'PENDING', isRequester: true }];

  assert.equal(scheduleRequestItems(preview, { actual: false, data: { items: [] } }), preview);
  assert.equal(scheduleRequestItems(preview, { actual: true, loading: true, data: { items: [] } }), preview);
  assert.equal(scheduleRequestItems(preview, { actual: true, loading: false, error: 'Ağ hatası', data: { items: [] } }), preview);
  assert.equal(scheduleRequestItems(preview, { actual: true, loading: false, error: null, data: { items: authoritative } }), authoritative);
  assert.deepEqual(scheduleRequestItems(preview, { actual: true, loading: false, error: null, data: { items: [] } }), []);
});

test('ortak sayfalama denetimi bulunduğu ekranı doğru anons eder', () => {
  const source = readFileSync(new URL('../src/features/tasks/TaskTablePagination.jsx', import.meta.url), 'utf8');
  assert.match(source, /label === 'Talep sayfaları'[\s\S]*'talep sayfası'/);
  assert.match(source, /label === 'Hareket sayfaları'[\s\S]*'hareket sayfası'/);
  assert.match(source, /aria-label=\{`Önceki \$\{pageLabel\}`\}/);
  assert.match(source, /aria-label=\{`Sonraki \$\{pageLabel\}`\}/);
});

test('talep tarih süzgeci UTC tarihini değil Türkiye takvim gününü kullanır', () => {
  const source = readFileSync(new URL('../src/server/schedule-change/scheduleRequestQueries.js', import.meta.url), 'utf8');
  assert.match(source, /activityDateRange/);
  assert.match(source, /r\.CreatedAt >= @fromUtc/);
  assert.match(source, /r\.CreatedAt < @toUtc/);
  assert.doesNotMatch(source, /CAST\(r\.CreatedAt AS date\)/);
});

test('talep eşlemesi canlı görev yerine kalıcı tarihsel künyeyi tercih eder', () => {
  const queries = readFileSync(new URL('../src/server/schedule-change/scheduleRequestQueries.js', import.meta.url), 'utf8');
  const mapping = readFileSync(new URL('../src/server/schedule-change/scheduleRequestMapping.js', import.meta.url), 'utf8');
  assert.match(queries, /COALESCE\(r\.TaskTitleSnapshot, t\.Title\) AS TaskTitle/);
  assert.match(queries, /COALESCE\(r\.ProjectIdSnapshot, t\.ProjectId\) AS ProjectId/);
  assert.match(mapping, /row\.TaskTitleSnapshot \?\? row\.TaskTitle/);
  assert.match(mapping, /row\.ProjectIdSnapshot \?\? row\.ProjectId/);
  assert.match(mapping, /row\.ProjectNameSnapshot \?\? row\.ProjectName/);
  assert.match(mapping, /row\.ProjectCodeSnapshot \?\? row\.ProjectCode/);
});
