import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { taskActivityQueryViewState } from '../src/features/reports/taskActivityQueryState.js';

test('Demo kipine geçildiğinde Gerçek Sistem görev hareketleri ve süzgeç kimlikleri görünmez', () => {
  const state = {
    key: '{"period":"today"}',
    data: {
      items: [{ id: 'audit-1', actorName: 'Gerçek Kullanıcı' }],
      total: 1,
      page: 0,
      pageSize: 25,
      summary: { tasks: 1, people: 1, completed: 0 },
      filters: { people: [{ sicil: '1001', name: 'Gerçek Kullanıcı' }], projects: [{ id: 'p1', name: 'Gizli Proje' }] },
      scope: 'team',
      canViewTeam: true
    },
    error: 'önceki hata'
  };
  const view = taskActivityQueryViewState(state, state.key, false);
  assert.deepEqual(view.data.items, []);
  assert.deepEqual(view.options, { people: [], projects: [] });
  assert.equal(view.error, null);
  assert.equal(view.data.scope, undefined);
  assert.equal(view.data.canViewTeam, undefined);
});

test('Gerçek Sistemde eşleşen sorgu sonucu korunur', () => {
  const data = { items: [{ id: 'audit-1' }], filters: { people: [], projects: [] }, scope: 'visible' };
  const state = { key: 'same', data, error: null };
  const view = taskActivityQueryViewState(state, 'same', true);
  assert.equal(view.data, data);
  assert.equal(view.options, data.filters);
});

test('talep geçmişi canlı görev/proje künyesi yerine kalıcı snapshotı tercih eder', () => {
  const source = readFileSync(new URL('../src/server/schedule-change/scheduleRequestQueries.js', import.meta.url), 'utf8');
  assert.match(source, /COALESCE\(r\.TaskTitleSnapshot, t\.Title\) AS TaskTitle/);
  assert.match(source, /COALESCE\(r\.ProjectIdSnapshot, t\.ProjectId\) AS ProjectId/);
  assert.match(source, /COALESCE\(r\.ProjectNameSnapshot, p\.ProjectName\) AS ProjectName/);
  assert.match(source, /COALESCE\(r\.ProjectCodeSnapshot, p\.ProjectCode\) AS ProjectCode/);
  assert.match(source, /@projectId IS NULL OR COALESCE\(r\.ProjectIdSnapshot, t\.ProjectId\) = @projectId/);
  assert.match(source, /CONCAT\(COALESCE\(r\.TaskTitleSnapshot, t\.Title\)/);
});
