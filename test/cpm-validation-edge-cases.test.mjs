import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CpmValidationError,
  buildDependencyGraph,
  calculateCpm
} from '../src/scheduling/cpm/index.js';

function activity(id, extra = {}) {
  return {
    id,
    task: id,
    plannedStart: '2026-06-01',
    plannedFinish: '2026-06-01',
    plannedDurationDays: 1,
    deps: [],
    ...extra
  };
}

function expectCpmError(fn, code, details = {}) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof CpmValidationError, true);
    assert.equal(error.code, code);
    for (const [key, value] of Object.entries(details)) assert.deepEqual(error.details[key], value);
    return true;
  });
}

test('CpmValidationError preserves code, message, details, and Error semantics', () => {
  const error = new CpmValidationError('TEST', 'Message', { taskId: 't1' });
  assert.equal(error instanceof Error, true);
  assert.equal(error.name, 'CpmValidationError');
  assert.equal(error.code, 'TEST');
  assert.equal(error.message, 'Message');
  assert.deepEqual(error.details, { taskId: 't1' });
});

test('buildDependencyGraph returns empty canonical graph structures for no tasks', () => {
  const graph = buildDependencyGraph();
  assert.equal(graph.tasksById.size, 0);
  assert.equal(graph.incoming.size, 0);
  assert.equal(graph.outgoing.size, 0);
  assert.deepEqual(graph.edges, []);
  assert.deepEqual(graph.topologicalOrder, []);
});

test('buildDependencyGraph rejects activities without stable IDs', () => {
  expectCpmError(() => buildDependencyGraph([{ task: 'Missing ID' }]), 'MISSING_TASK_ID');
});

test('buildDependencyGraph rejects duplicate activity IDs with details', () => {
  expectCpmError(
    () => buildDependencyGraph([activity('A'), activity('A')]),
    'DUPLICATE_TASK_ID',
    { taskId: 'A' }
  );
});

test('buildDependencyGraph rejects references to missing predecessors', () => {
  expectCpmError(
    () => buildDependencyGraph([activity('A', { deps: ['missing'] })]),
    'MISSING_PREDECESSOR',
    { taskId: 'A', predecessorId: 'missing' }
  );
});

test('buildDependencyGraph reports empty predecessor references explicitly', () => {
  expectCpmError(
    () => buildDependencyGraph([activity('A', { deps: [{}] })]),
    'MISSING_PREDECESSOR',
    { taskId: 'A', predecessorId: null }
  );
});

test('buildDependencyGraph rejects self dependencies', () => {
  expectCpmError(
    () => buildDependencyGraph([activity('A', { deps: ['A'] })]),
    'SELF_DEPENDENCY',
    { taskId: 'A' }
  );
});

test('buildDependencyGraph reports all tasks blocked by a dependency cycle', () => {
  expectCpmError(
    () => buildDependencyGraph([
      activity('A', { deps: ['C'] }),
      activity('B', { deps: ['A'] }),
      activity('C', { deps: ['B'] })
    ]),
    'DEPENDENCY_CYCLE',
    { taskIds: ['A', 'B', 'C'] }
  );
});

test('buildDependencyGraph keeps disconnected zero-indegree activities in input order', () => {
  const graph = buildDependencyGraph([activity('B'), activity('A'), activity('C')]);
  assert.deepEqual(graph.topologicalOrder, ['B', 'A', 'C']);
});

test('buildDependencyGraph produces stable topological order for a dependency chain', () => {
  const graph = buildDependencyGraph([
    activity('A'),
    activity('B', { deps: ['A'] }),
    activity('C', { deps: ['B'] })
  ]);
  assert.deepEqual(graph.topologicalOrder, ['A', 'B', 'C']);
});

test('buildDependencyGraph normalizes legacy dependency fields without mutating the source', () => {
  const raw = { id: 'A', type: 'UNKNOWN', lagDays: 2 };
  const graph = buildDependencyGraph([activity('A'), activity('B', { deps: [raw] })]);
  assert.deepEqual(graph.edges[0].dependency, {
    id: 'A',
    predecessorId: 'A',
    type: 'FS',
    lagDays: 2
  });
  assert.deepEqual(raw, { id: 'A', type: 'UNKNOWN', lagDays: 2 });
});

test('buildDependencyGraph shares each edge consistently between incoming and outgoing indexes', () => {
  const graph = buildDependencyGraph([activity('A'), activity('B', { deps: ['A'] })]);
  assert.equal(graph.edges.length, 1);
  assert.strictEqual(graph.incoming.get('B')[0], graph.edges[0]);
  assert.strictEqual(graph.outgoing.get('A')[0], graph.edges[0]);
  assert.equal(graph.incoming.get('A').length, 0);
  assert.equal(graph.outgoing.get('B').length, 0);
});

test('buildDependencyGraph handles repeated dependency edges deterministically', () => {
  const graph = buildDependencyGraph([
    activity('A'),
    activity('B', { deps: ['A', { predecessorId: 'A', type: 'SS' }] })
  ]);
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.incoming.get('B').length, 2);
  assert.equal(graph.outgoing.get('A').length, 2);
  assert.deepEqual(graph.topologicalOrder, ['A', 'B']);
});

test('calculateCpm returns a canonical empty result for an empty portfolio', () => {
  assert.deepEqual(calculateCpm([]), {
    projectStart: null,
    projectFinish: null,
    orderedTaskIds: [],
    criticalTaskIds: [],
    criticalPaths: [],
    criticalPathsTruncated: false,
    tasks: {}
  });
});

test('calculateCpm requires either an explicit project start or a task planned start', () => {
  expectCpmError(
    () => calculateCpm([activity('A', { plannedStart: null, plannedFinish: null, plannedDurationDays: 1 })]),
    'MISSING_PROJECT_START'
  );
});

test('calculateCpm accepts an explicit project start for duration-only activities', () => {
  const result = calculateCpm([
    activity('A', { plannedStart: null, plannedFinish: null, plannedDurationDays: 2 })
  ], { projectStart: '2026-06-01' });
  assert.equal(result.projectStart, '2026-06-01');
  assert.equal(result.projectFinish, '2026-06-02');
  assert.equal(result.tasks.A.durationDays, 2);
});

test('calculateCpm rejects invalid explicit project start values', () => {
  expectCpmError(
    () => calculateCpm([activity('A')], { projectStart: 'not-a-date' }),
    'INVALID_PROJECT_START',
    { projectStart: 'not-a-date' }
  );
});

test('calculateCpm reports missing finish dates when duration cannot be inferred', () => {
  expectCpmError(
    () => calculateCpm([activity('A', { plannedDurationDays: null, plannedFinish: null })]),
    'MISSING_TASK_DATE',
    { taskId: 'A', field: 'plannedFinish' }
  );
});

test('calculateCpm reports invalid task date values', () => {
  expectCpmError(
    () => calculateCpm([activity('A', { plannedDurationDays: null, plannedFinish: 'not-a-date' })]),
    'INVALID_TASK_DATE',
    { taskId: 'A', field: 'plannedFinish', value: 'not-a-date' }
  );
});

test('calculateCpm rejects inferred activity ranges that finish before they start', () => {
  expectCpmError(
    () => calculateCpm([activity('A', {
      plannedStart: '2026-06-10',
      plannedFinish: '2026-06-01',
      plannedDurationDays: null
    })]),
    'INVALID_TASK_DATES',
    { taskId: 'A', start: '2026-06-10', end: '2026-06-01' }
  );
});

test('calculateCpm clamps negative numeric durations to zero', () => {
  const result = calculateCpm([activity('A', { plannedDurationDays: -4 })]);
  assert.equal(result.tasks.A.durationDays, 0);
  assert.equal(result.tasks.A.earlyStart, result.tasks.A.earlyFinish);
});

test('calculateCpm truncates fractional numeric durations', () => {
  const result = calculateCpm([activity('A', { plannedDurationDays: 2.9 })]);
  assert.equal(result.tasks.A.durationDays, 2);
  assert.equal(result.projectFinish, '2026-06-02');
});

test('calculateCpm aligns an explicit weekend start to the next working day', () => {
  const result = calculateCpm([
    activity('A', { plannedStart: null, plannedFinish: null, plannedDurationDays: 1 })
  ], { projectStart: '2026-06-07' });
  assert.equal(result.projectStart, '2026-06-08');
  assert.equal(result.projectFinish, '2026-06-08');
});
