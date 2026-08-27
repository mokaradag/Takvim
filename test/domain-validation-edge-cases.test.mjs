import test from 'node:test';
import assert from 'node:assert/strict';

import { DOMAIN_MODEL_VERSION } from '../src/domain/models/index.js';
import {
  normalizeProjectReferences,
  normalizeTaskReferences,
  normalizeTaskScheduleFields,
  validateTaskBaselineSnapshot,
  validateTaskSchedule,
  validateTaskWbsAssignment,
  validateTaskWbsMove,
  validateWbsDeletion,
  validateWbsReparent,
  validateWbsStructure
} from '../src/domain/validation/index.js';

const people = [
  { id: 'u1', name: 'Ayşe' },
  { id: 'u2', name: 'Bora' }
];
const projects = [
  { id: 'p1', name: 'One' },
  { id: 'p2', name: 'Two' }
];
const wbs = [
  { id: 'p1-root', projectId: 'p1', parentId: null, code: '1', name: 'One', sortOrder: 1 },
  { id: 'p1-a', projectId: 'p1', parentId: 'p1-root', code: '1.1', name: 'A', sortOrder: 1 },
  { id: 'p1-b', projectId: 'p1', parentId: 'p1-root', code: '1.2', name: 'B', sortOrder: 2 },
  { id: 'p1-a1', projectId: 'p1', parentId: 'p1-a', code: '1.1.1', name: 'A1', sortOrder: 1 },
  { id: 'p2-root', projectId: 'p2', parentId: null, code: '2', name: 'Two', sortOrder: 1 }
];

function codes(issues) {
  return issues.map((item) => item.code);
}

test('domain model version stays at the current canonical schema version', () => {
  assert.equal(DOMAIN_MODEL_VERSION, 5);
});

test('project normalization preserves an explicit leadId over a legacy display lead', () => {
  const result = normalizeProjectReferences({ id: 'p1', leadId: 'u2', lead: 'Ayşe' }, people);
  assert.equal(result.leadId, 'u2');
});

test('project normalization resolves a legacy lead name to a stable ID', () => {
  assert.equal(normalizeProjectReferences({ id: 'p1', lead: 'Ayşe' }, people).leadId, 'u1');
});

test('project normalization uses null for an unknown lead', () => {
  assert.equal(normalizeProjectReferences({ id: 'p1', lead: 'Unknown' }, people).leadId, null);
});

test('project normalization preserves an explicit data date', () => {
  assert.equal(normalizeProjectReferences({ id: 'p1', dataDate: '2026-07-22' }, people).dataDate, '2026-07-22');
});

test('project normalization fills a missing data date with null', () => {
  assert.equal(normalizeProjectReferences({ id: 'p1' }, people).dataDate, null);
});

test('task schedule normalization converts empty date strings to null', () => {
  const result = normalizeTaskScheduleFields({
    plannedStart: '', plannedFinish: '', targetFinish: '', actualStart: '', actualFinish: ''
  });
  assert.equal(result.plannedStart, null);
  assert.equal(result.plannedFinish, null);
  assert.equal(result.targetFinish, null);
  assert.equal(result.actualStart, null);
  assert.equal(result.actualFinish, null);
});

test('task schedule normalization preserves valid schedule values', () => {
  const result = normalizeTaskScheduleFields({
    plannedStart: '2026-07-20',
    plannedFinish: '2026-07-24',
    targetFinish: '2026-07-27',
    actualStart: '2026-07-21',
    actualFinish: '2026-07-23',
    plannedDurationDays: 5,
    remainingDurationDays: 2
  });
  assert.equal(result.plannedStart, '2026-07-20');
  assert.equal(result.plannedFinish, '2026-07-24');
  assert.equal(result.targetFinish, '2026-07-27');
  assert.equal(result.actualStart, '2026-07-21');
  assert.equal(result.actualFinish, '2026-07-23');
  assert.equal(result.plannedDurationDays, 5);
  assert.equal(result.remainingDurationDays, 2);
});

test('task schedule normalization forces milestones to zero duration', () => {
  assert.equal(normalizeTaskScheduleFields({ milestone: true, plannedDurationDays: 99 }).plannedDurationDays, 0);
});

test('task schedule normalization preserves zero duration for non-milestones', () => {
  assert.equal(normalizeTaskScheduleFields({ milestone: false, plannedDurationDays: 0 }).plannedDurationDays, 0);
});

test('task schedule normalization fills absent durations with null', () => {
  const result = normalizeTaskScheduleFields({});
  assert.equal(result.plannedDurationDays, null);
  assert.equal(result.remainingDurationDays, null);
});

test('task reference normalization resolves project identity by canonical projectId', () => {
  const result = normalizeTaskReferences({ id: 't1', projectId: 'p2', proje: 'One' }, { projects, people, wbs });
  assert.equal(result.projectId, 'p2');
  assert.equal(result.proje, 'Two');
  assert.equal(result.wbsId, 'p2-root');
});

test('task reference normalization falls back to the legacy project display name', () => {
  const result = normalizeTaskReferences({ id: 't1', proje: 'One' }, { projects, people, wbs });
  assert.equal(result.projectId, 'p1');
  assert.equal(result.proje, 'One');
});

test('task reference normalization preserves an unknown canonical projectId when no project resolves', () => {
  const result = normalizeTaskReferences({ id: 't1', projectId: 'missing', proje: 'Legacy' }, { projects, people, wbs });
  assert.equal(result.projectId, 'missing');
  assert.equal(result.proje, 'Legacy');
  assert.equal(result.wbsId, null);
});

test('task reference normalization filters unknown canonical assignee IDs', () => {
  const result = normalizeTaskReferences({ id: 't1', projectId: 'p1', assigneeIds: ['u1', 'missing'] }, { projects, people, wbs });
  assert.deepEqual(result.assigneeIds, ['u1']);
  assert.deepEqual(result.sorumlu, ['Ayşe']);
});

test('task reference normalization preserves scoped display names when a canonical ID is absent from the directory', () => {
  const result = normalizeTaskReferences({
    id: 't1',
    projectId: 'p1',
    assigneeIds: ['u1', 'missing'],
    assigneeCount: 2,
    assigneeDisplayNames: ['Ayşe', 'Rehber Dışı Görevli']
  }, { projects, people, wbs });

  assert.deepEqual(result.assigneeIds, ['u1']);
  assert.deepEqual(result.sorumlu, ['Ayşe', 'Rehber Dışı Görevli']);
});

test('task reference normalization derives canonical assignee IDs from legacy names', () => {
  const result = normalizeTaskReferences({ id: 't1', projectId: 'p1', sorumlu: ['Bora', 'Unknown', 'Ayşe'] }, { projects, people, wbs });
  assert.deepEqual(result.assigneeIds, ['u2', 'u1']);
  assert.deepEqual(result.sorumlu, ['Bora', 'Ayşe']);
});

test('task reference normalization keeps valid explicit display names when canonical IDs are also supplied', () => {
  const result = normalizeTaskReferences({
    id: 't1', projectId: 'p1', assigneeIds: ['u1'], sorumlu: ['Bora']
  }, { projects, people, wbs });
  assert.deepEqual(result.assigneeIds, ['u1']);
  assert.deepEqual(result.sorumlu, ['Bora']);
});

test('task reference normalization preserves a valid same-project WBS assignment', () => {
  const result = normalizeTaskReferences({ id: 't1', projectId: 'p1', wbsId: 'p1-a' }, { projects, people, wbs });
  assert.equal(result.wbsId, 'p1-a');
});

test('task reference normalization replaces a cross-project WBS with the project default', () => {
  const result = normalizeTaskReferences({ id: 't1', projectId: 'p1', wbsId: 'p2-root' }, { projects, people, wbs });
  assert.equal(result.wbsId, 'p1-root');
});

test('task reference normalization defaults missing dependencies to an empty array', () => {
  assert.deepEqual(normalizeTaskReferences({ id: 't1', projectId: 'p1' }, { projects, people, wbs }).deps, []);
});

for (const [name, task, expectedCode, expectedField] of [
  ['invalid planned-start format', { plannedStart: '22-07-2026' }, 'INVALID_PLANNED_START', 'plannedStart'],
  ['impossible planned-start date', { plannedStart: '2026-02-30' }, 'INVALID_PLANNED_START', 'plannedStart'],
  ['invalid planned-finish format', { plannedFinish: '2026/07/22' }, 'INVALID_PLANNED_FINISH', 'plannedFinish'],
  ['impossible planned-finish date', { plannedFinish: '2026-13-01' }, 'INVALID_PLANNED_FINISH', 'plannedFinish'],
  ['invalid actual-start format', { actualStart: 'July 22, 2026' }, 'INVALID_ACTUAL_START', 'actualStart'],
  ['invalid actual-finish format', { actualStart: '2026-07-20', actualFinish: 'bad' }, 'INVALID_ACTUAL_FINISH', 'actualFinish'],
  ['negative planned duration', { plannedDurationDays: -1 }, 'NEGATIVE_OR_INVALID_DURATION', 'plannedDurationDays'],
  ['NaN planned duration', { plannedDurationDays: Number.NaN }, 'NEGATIVE_OR_INVALID_DURATION', 'plannedDurationDays'],
  ['infinite remaining duration', { remainingDurationDays: Infinity }, 'NEGATIVE_OR_INVALID_DURATION', 'remainingDurationDays'],
  ['negative remaining duration', { remainingDurationDays: -0.5 }, 'NEGATIVE_OR_INVALID_DURATION', 'remainingDurationDays'],
  ['non-zero milestone duration', { milestone: true, plannedDurationDays: 1 }, 'MILESTONE_NON_ZERO_DURATION', 'plannedDurationDays']
]) {
  test(`task schedule validation reports ${name}`, () => {
    const issue = validateTaskSchedule(task).find((item) => item.code === expectedCode);
    assert.ok(issue);
    assert.equal(issue.field, expectedField);
  });
}

test('task schedule validation accepts leap-day schedule dates', () => {
  assert.deepEqual(validateTaskSchedule({
    plannedStart: '2028-02-29',
    plannedFinish: '2028-02-29',
    plannedDurationDays: 1
  }), []);
});

test('task schedule validation reports planned finish before planned start', () => {
  assert.deepEqual(codes(validateTaskSchedule({
    plannedStart: '2026-07-23', plannedFinish: '2026-07-22'
  })), ['PLANNED_FINISH_BEFORE_START']);
});

test('task schedule validation reports actual finish without actual start', () => {
  assert.ok(codes(validateTaskSchedule({ actualFinish: '2026-07-22' })).includes('ACTUAL_FINISH_WITHOUT_START'));
});

test('task schedule validation reports actual finish before actual start', () => {
  assert.ok(codes(validateTaskSchedule({
    actualStart: '2026-07-23', actualFinish: '2026-07-22'
  })).includes('ACTUAL_FINISH_BEFORE_START'));
});

test('task schedule validation can report multiple independent issues together', () => {
  const result = validateTaskSchedule({
    plannedStart: 'bad',
    plannedFinish: 'also-bad',
    actualFinish: '2026-07-22',
    plannedDurationDays: -1,
    milestone: true
  });
  assert.deepEqual(codes(result), [
    'INVALID_PLANNED_START',
    'INVALID_PLANNED_FINISH',
    'ACTUAL_FINISH_WITHOUT_START',
    'NEGATIVE_OR_INVALID_DURATION',
    'MILESTONE_NON_ZERO_DURATION'
  ]);
});

test('task schedule validation accepts an empty schedule record', () => {
  assert.deepEqual(validateTaskSchedule({}), []);
});

test('task schedule validation accepts a zero-duration milestone', () => {
  assert.deepEqual(validateTaskSchedule({ milestone: true, plannedDurationDays: 0 }), []);
});

test('baseline validation reports finish before start', () => {
  assert.deepEqual(codes(validateTaskBaselineSnapshot({
    plannedStart: '2026-07-23', plannedFinish: '2026-07-22'
  })), ['BASELINE_FINISH_BEFORE_START']);
});

for (const value of [-1, Number.NaN, Infinity]) {
  test(`baseline validation rejects invalid duration ${String(value)}`, () => {
    assert.deepEqual(codes(validateTaskBaselineSnapshot({ plannedDurationDays: value })), [
      'NEGATIVE_OR_INVALID_BASELINE_DURATION'
    ]);
  });
}

test('baseline validation accepts zero duration', () => {
  assert.deepEqual(validateTaskBaselineSnapshot({ plannedDurationDays: 0 }), []);
});

test('WBS structure validation ignores records without IDs', () => {
  assert.deepEqual(validateWbsStructure([null, {}, { name: 'No ID' }]), []);
});

test('WBS structure validation reports duplicate IDs deterministically', () => {
  const result = validateWbsStructure([
    { id: 'x', projectId: 'p1', parentId: null },
    { id: 'x', projectId: 'p1', parentId: null }
  ]);
  assert.deepEqual(codes(result), ['DUPLICATE_WBS_ID']);
  assert.equal(result[0].nodeId, 'x');
});

test('WBS structure validation reports self-parenting', () => {
  const result = validateWbsStructure([{ id: 'x', projectId: 'p1', parentId: 'x' }]);
  assert.equal(result[0].code, 'WBS_SELF_PARENT');
  assert.equal(result[0].details.parentId, 'x');
});

test('WBS structure validation reports a missing parent', () => {
  const result = validateWbsStructure([{ id: 'x', projectId: 'p1', parentId: 'missing' }]);
  assert.equal(result[0].code, 'MISSING_WBS_PARENT');
  assert.equal(result[0].details.parentId, 'missing');
});

test('WBS structure validation reports cross-project parent details', () => {
  const result = validateWbsStructure([
    { id: 'a', projectId: 'p1', parentId: null },
    { id: 'b', projectId: 'p2', parentId: 'a' }
  ]);
  const issue = result.find((item) => item.code === 'CROSS_PROJECT_WBS_PARENT');
  assert.deepEqual(issue.details, { parentId: 'a', projectId: 'p2', parentProjectId: 'p1' });
});

test('WBS structure validation emits one canonical issue per disconnected cycle', () => {
  const result = validateWbsStructure([
    { id: 'b', projectId: 'p1', parentId: 'a' },
    { id: 'a', projectId: 'p1', parentId: 'b' },
    { id: 'd', projectId: 'p1', parentId: 'c' },
    { id: 'c', projectId: 'p1', parentId: 'd' }
  ]).filter((item) => item.code === 'WBS_CYCLE');
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((item) => item.nodeId), ['a', 'c']);
  assert.deepEqual(result.map((item) => item.details.nodeIds), [['a', 'b'], ['c', 'd']]);
});

test('task WBS assignment accepts tasks without a WBS', () => {
  assert.deepEqual(validateTaskWbsAssignment({ id: 't1', projectId: 'p1', wbsId: null }, wbs), []);
});

test('task WBS assignment rejects an unknown WBS', () => {
  const result = validateTaskWbsAssignment({ id: 't1', projectId: 'p1', wbsId: 'missing' }, wbs);
  assert.equal(result[0].code, 'UNKNOWN_TASK_WBS');
  assert.equal(result[0].nodeId, 't1');
});

test('task WBS assignment rejects a WBS from another project', () => {
  const result = validateTaskWbsAssignment({ id: 't1', projectId: 'p1', wbsId: 'p2-root' }, wbs);
  assert.equal(result[0].code, 'CROSS_PROJECT_TASK_WBS');
  assert.equal(result[0].details.wbsProjectId, 'p2');
});

test('task WBS assignment accepts a same-project WBS', () => {
  assert.deepEqual(validateTaskWbsAssignment({ id: 't1', projectId: 'p1', wbsId: 'p1-a' }, wbs), []);
});

test('task WBS move rejects an empty selection', () => {
  assert.equal(validateTaskWbsMove([], wbs, [], 'p1-root')[0].code, 'TASK_MOVE_SELECTION_EMPTY');
});

test('task WBS move rejects a missing target', () => {
  assert.equal(validateTaskWbsMove([], wbs, ['t1'], 'missing')[0].code, 'WBS_TARGET_NOT_FOUND');
});

test('task WBS move reports missing selected tasks', () => {
  assert.equal(validateTaskWbsMove([], wbs, ['missing'], 'p1-root')[0].code, 'TASK_NOT_FOUND');
});

test('task WBS move rejects cross-project target assignment', () => {
  const result = validateTaskWbsMove([{ id: 't1', projectId: 'p1' }], wbs, ['t1'], 'p2-root');
  assert.equal(result[0].code, 'CROSS_PROJECT_TASK_WBS_MOVE');
});

test('task WBS move deduplicates selected task IDs', () => {
  const result = validateTaskWbsMove([{ id: 't1', projectId: 'p2' }], wbs, ['t1', 't1'], 'p1-root');
  assert.equal(result.length, 1);
});

test('task WBS move accepts multiple same-project tasks', () => {
  const tasks = [{ id: 't1', projectId: 'p1' }, { id: 't2', projectId: 'p1' }];
  assert.deepEqual(validateTaskWbsMove(tasks, wbs, ['t1', 't2'], 'p1-b'), []);
});

for (const [name, args, expected] of [
  ['missing source node', ['missing', 'p1-root'], 'WBS_NODE_NOT_FOUND'],
  ['missing target parent', ['p1-a', 'missing'], 'WBS_PARENT_NOT_FOUND'],
  ['root movement', ['p1-root', 'p1-a'], 'WBS_ROOT_REPARENT_FORBIDDEN'],
  ['self-parenting', ['p1-a', 'p1-a'], 'WBS_SELF_PARENT'],
  ['cross-project movement', ['p1-a', 'p2-root'], 'CROSS_PROJECT_WBS_PARENT'],
  ['movement below a descendant', ['p1-a', 'p1-a1'], 'WBS_REPARENT_TO_DESCENDANT']
]) {
  test(`WBS reparent validation rejects ${name}`, () => {
    assert.equal(validateWbsReparent(wbs, ...args)[0].code, expected);
  });
}

test('WBS reparent validation accepts movement to a same-project sibling branch', () => {
  assert.deepEqual(validateWbsReparent(wbs, 'p1-a1', 'p1-b'), []);
});

test('WBS deletion validation accepts an unused leaf node', () => {
  assert.deepEqual(validateWbsDeletion(wbs, [], 'p1-a1'), []);
});

test('WBS deletion validation reports direct children', () => {
  const result = validateWbsDeletion(wbs, [], 'p1-a');
  assert.equal(result[0].code, 'WBS_HAS_CHILDREN');
  assert.deepEqual(result[0].details.childIds, ['p1-a1']);
});

test('WBS deletion validation reports directly assigned tasks', () => {
  const result = validateWbsDeletion(wbs, [{ id: 't1', wbsId: 'p1-a1' }], 'p1-a1');
  assert.equal(result[0].code, 'WBS_HAS_TASKS');
  assert.deepEqual(result[0].details.taskIds, ['t1']);
});

test('WBS deletion validation reports children before tasks when both block deletion', () => {
  const result = validateWbsDeletion(wbs, [{ id: 't1', wbsId: 'p1-a' }], 'p1-a');
  assert.deepEqual(codes(result), ['WBS_HAS_CHILDREN', 'WBS_HAS_TASKS']);
});


test('WBS deletion validation rejects a project root even when it is empty', () => {
  const result = validateWbsDeletion(wbs, [], 'p2-root');
  assert.equal(result[0].code, 'WBS_ROOT_DELETE_FORBIDDEN');
});
