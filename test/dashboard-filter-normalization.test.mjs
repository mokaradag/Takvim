import test from 'node:test';
import assert from 'node:assert/strict';

import { taskTableFacetValues, taskTableMatches } from '../src/features/tasks/taskTableFacets.js';
import { resolveDashboardVariant } from '../src/features/dashboard/dashboardVariant.js';

test('proje sütun süzgeci sayısal projectId değerini string seçenekle eşleştirir', () => {
  const task = { id: 't1', projectId: 42, task: 'Görev', status: 'todo' };
  const state = { filters: {} };

  assert.deepEqual([...taskTableFacetValues([task], state, 'proje')], ['42']);
  assert.equal(taskTableMatches(task, { filters: { proje: ['42'] } }), true);
  assert.equal(taskTableMatches(task, { filters: { proje: ['7'] } }), false);
});

test('Temel Görev kalitesi açıklaması sorumlu ve termin etkilerini ayrı anlatır', () => {
  assert.equal(
    resolveDashboardVariant('simple').hygieneDetail,
    'Sorumlusu olmayan görev ekip iş yükünde görünmez. Termini olmayan görev gecikme ve yaklaşan teslim hesaplarına girmez.'
  );
});
