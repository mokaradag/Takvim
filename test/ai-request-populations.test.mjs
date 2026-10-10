import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvidenceFacts } from '../src/domain/ai/evidenceFacts.js';
import { analyzeGroundedAnswer } from '../src/domain/ai/evidenceVerification.js';
import { claimableContract, metricEntry } from '../src/domain/ai/claimableEvidence.js';
import { concreteCollections, factRow, provesEmptyCollection } from '../src/domain/ai/requestContract.js';

function source(tool, data, extra = {}) {
  const id = extra.id || 'R1';
  const { envelope: overrides, ...metadata } = extra;
  const envelope = { ok: true, tool, evidenceId: id, factScope: `0123456789abcdef_${id}`, claimable: claimableContract(tool),
    data, complete: true, truncated: false, totalCount: 0, returnedCount: 0, ...overrides };
  return { id, tool, envelope, ordinal: Number(id.slice(1)), firstPage: true, facets: {}, declared: {}, unsupported: [], selectors: [],
    populationMatch: true, dimensionsMatch: true, sortMatch: true, facts: createEvidenceFacts(envelope, { prefix: envelope.factScope }), ...metadata };
}

function verify(sources, request, references) {
  return analyzeGroundedAnswer(JSON.stringify({ kind: 'rota', facts: references, layout: request.layout || 'auto' }), {
    evidenceIds: sources.map((item) => item.id), evidencePayloads: sources.map((item) => ({ id: item.id, payload: JSON.stringify(item.envelope) })),
    request, evidence: new Map(sources.map((item) => [item.id, item]))
  });
}

const rows = (metrics, extra = {}) => ({ operation: 'list', metrics, entities: [], ...extra });
const issue = (verdict) => verdict.issues[0]?.code;

test('a row-only empty task list uses its exact collection and a context proof', () => {
  const empty = source('rota_task_search', { tasks: [] }, { collection: 'tasks' });
  assert.equal(verify([empty], rows(['task.title']), ['R1:complete']).ok, true);
  assert.equal(verify([empty], rows(['task.title', 'task.assignees']), ['R1:complete']).ok, true);
  for (const mutation of [{ complete: false }, { truncated: true }, { totalCount: 1 }]) {
    const bad = source('rota_task_search', { tasks: [] }, { collection: 'tasks', envelope: mutation });
    assert.equal(verify([bad], rows(['task.title']), ['R1:complete']).ok, false);
  }
  empty.firstPage = false;
  assert.equal(verify([empty], rows(['task.title']), ['R1:complete']).ok, false);
});

test('an empty sibling never waives a metric on the selected baseline rows', () => {
  const entry = source('rota_baseline_compare', { availableBaselines: [{ baselineId: 'b', name: 'Plan' }], availableBaselinesTruncated: false, mostSlipped: [] });
  assert.equal(issue(verify([entry], rows(['baseline.name', 'task.varianceDays']), ['R1:data.availableBaselines.*.name'])), 'METRIC_MISSING');
  assert.equal(issue(verify([entry], rows(['baseline.name', 'task.varianceDays']), ['R1:complete'])), 'METRIC_MISSING');
});

test('unrelated scalar evidence need not prove that the task population is empty', () => {
  const entities = [{ type: 'project', bound: 'p' }];
  const property = source('rota_project_detail', { access: { level: 'FULL' } }, { selectors: [{ type: 'project', id: 'p' }], envelope: { totalCount: 1 }, populationMatch: false });
  const empty = source('rota_task_search', { tasks: [] }, { id: 'R2', collection: 'tasks', selectors: [{ type: 'project', id: 'p' }] });
  assert.equal(verify([property, empty], rows(['project.access', 'task.targetFinish'], { entities }), ['R1:data.access.level', 'R2:complete']).ok, true);
});

test('dependency direction is bound, and mode-inapplicable collections cannot block zero rows', () => {
  const entry = source('rota_dependency_inspect', { predecessors: [], successors: [] }, { collection: 'predecessors' });
  assert.equal(verify([entry], rows(['task.title', 'dependency.type']), ['R1:complete']).ok, true);
  entry.envelope.data.successors = [{ taskId: 's', title: 'Successor', type: 'FS' }];
  entry.envelope.totalCount = 1;
  assert.equal(verify([entry], rows(['task.title', 'dependency.type']), ['R1:complete']).ok, true);
  assert.equal(issue(verify([entry], rows(['task.title']), ['R1:data.successors.0.title'])), 'POPULATION_MISMATCH');
  entry.collection = null;
  assert.equal(verify([entry], rows(['task.title', 'dependency.type']), ['R1:complete']).ok, false);
});

test('nested recurrence emptiness counts occurrences rather than series', () => {
  const entry = source('rota_recurrence_inspect', { series: { upcomingCount: 0, nextTruncated: false, next: [] } }, { collection: 'series.next', envelope: { totalCount: 1 } });
  assert.equal(verify([entry], rows(['recurrence.occurrenceDate', 'task.status']), ['R1:complete']).ok, true);
  const nested = source('rota_recurrence_inspect', { series: [{ upcomingCount: 0, nextTruncated: false, next: [] }] }, { collection: 'series.*.next', envelope: { totalCount: 1 } });
  assert.equal(concreteCollections(nested.envelope, 'series.*.next')[0].collection, 'data.series.0.next');
  assert.equal(provesEmptyCollection(nested, 'series.*.next'), true);
  assert.equal(verify([nested], rows(['recurrence.occurrenceDate']), ['R1:complete']).ok, true);
  nested.envelope.data.series[0].upcomingCount = 1;
  assert.equal(provesEmptyCollection(nested, 'series.*.next'), false);
});

test('an empty analytics grouping is proved by its group population rather than a task count', () => {
  const entry = source('rota_task_analytics', { groups: [], groupBy: 'assignee', groupCount: 0 }, { collection: 'groups' });
  assert.equal(verify([entry], rows(['tasks.open']), ['R1:complete']).ok, true);
  delete entry.envelope.data.groupBy;
  assert.equal(verify([entry], rows(['tasks.open']), ['R1:complete']).ok, false);
});

test('dependency row properties are bound to the focal task population without impersonating it', () => {
  const entry = source('rota_dependency_inspect', { predecessors: [{ taskId: 'predecessor', title: 'Predecessor', status: 'todo', type: 'FS' }] },
    { collection: 'predecessors', selectors: [{ type: 'task', id: 'focal' }], envelope: { totalCount: 1 } });
  const request = rows(['task.title', 'dependency.type'], { entities: [{ type: 'task', bound: 'focal' }] });
  assert.equal(verify([entry], request, ['R1:data.predecessors.*.title', 'R1:data.predecessors.*.type']).ok, true);
  assert.equal(verify([entry], { ...request, operation: 'value', metrics: ['task.title'] }, ['R1:data.predecessors.0.title']).ok, false);
});

test('nested collections use the occurrence row for completeness and rendering', () => {
  const entry = source('rota_recurrence_inspect', { series: [{ title: 'Series', next: [{ occurrenceDate: '2026-10-08', status: 'todo' }] }, { next: [] }] },
    { collection: 'series.*.next', envelope: { totalCount: 2 } });
  assert.equal(factRow(entry.tool, 'data.series.0.next.0.status').collection, 'data.series.0.next');
  assert.equal(verify([entry], rows(['recurrence.occurrenceDate', 'task.status']), ['R1:data.series.*.next.*.occurrenceDate', 'R1:data.series.*.next.*.status']).ok, true);
});

test('an empty rank is valid without inventing row facts', () => {
  const entry = source('rota_task_search', { tasks: [] }, { collection: 'tasks' });
  assert.equal(verify([entry], { ...rows(['task.overdueDays']), operation: 'rank', rank: { metric: 'task.overdueDays', order: 'desc', limit: 3 } }, ['R1:complete']).ok, true);
});

test('a newer partial metric snapshot invalidates the older total while allowing disjoint metadata', () => {
  const selectors = [{ type: 'project', id: 'p' }];
  const old = source('rota_project_detail', { project: { name: 'Project' }, visibleTasks: { total: 3 } }, { selectors, envelope: { totalCount: 1 } });
  const fresh = source('rota_task_analytics', { totals: { total: 4 } }, { id: 'R2', selectors, envelope: { totalCount: 4 } });
  const request = { operation: 'value', metrics: ['project.name', 'tasks.total'], entities: [{ type: 'project', bound: 'p' }] };
  assert.equal(issue(verify([old, fresh], request, ['R1:data.project.name', 'R1:data.visibleTasks.total'])), 'STALE_EVIDENCE');
  assert.equal(verify([old, fresh], request, ['R1:data.project.name', 'R2:data.totals.total']).ok, true);
  assert.equal(issue(verify([old, fresh], request, ['R1:data.project.name', 'R1:data.visibleTasks.total', 'R2:data.totals.total'])), 'STALE_EVIDENCE');
});

test('metric/entity associations require explicit bindings and reject extra pairings', () => {
  const a = source('rota_project_detail', { visibleTasks: { open: 2, total: 3 } }, { selectors: [{ type: 'project', id: 'a' }] });
  const b = source('rota_project_detail', { visibleTasks: { open: 4, total: 5 } }, { id: 'R2', selectors: [{ type: 'project', id: 'b' }] });
  const request = { operation: 'value', metrics: ['tasks.open', 'tasks.total'], entities: [{ type: 'project', bound: 'a' }, { type: 'project', bound: 'b' }] };
  const references = ['R1:data.visibleTasks.open', 'R2:data.visibleTasks.total'];
  assert.equal(issue(verify([a, b], request, references)), 'ENTITY_METRIC_AMBIGUOUS');
  request.bindings = [{ metric: 'tasks.open', entity: 0 }, { metric: 'tasks.total', entity: 1 }];
  assert.equal(verify([a, b], request, references).ok, true);
  assert.equal(verify([a, b], request, [...references, 'R1:data.visibleTasks.total']).ok, false);
  assert.equal(verify([a, b], request, ['R1:data.visibleTasks.total', 'R2:data.visibleTasks.open']).ok, false);
});

test('field, grouping, ordering and tool-population mismatches remain deterministic failures', () => {
  const entry = source('rota_wbs_inspect', { nodes: [{ name: 'Name', code: '1' }] }, { collection: 'nodes' });
  const request = rows(['wbs.name'], { fields: [{ metric: 'wbs.name', tool: entry.tool, path: 'data.nodes.*.code' }] });
  assert.equal(verify([entry], request, ['R1:data.nodes.*.code']).ok, true);
  assert.equal(verify([entry], request, ['R1:data.nodes.*.name']).ok, false);
  for (const key of ['populationMatch', 'dimensionsMatch', 'sortMatch']) {
    entry[key] = false;
    assert.equal(verify([entry], rows(['wbs.name']), ['R1:data.nodes.*.name']).ok, false);
    entry[key] = true;
  }
});

test('baseline totalCount represents all comparable rows rather than slipped rows', () => {
  assert.equal(metricEntry('rota_baseline_compare', 'totalCount').metric, 'baseline.compared');
});

test('equal metric IDs in distinct populations do not supersede each other', () => {
  const projects = source('rota_portfolio_summary', { projects: [{ name: 'Project', tasks: { open: 2 } }] }, { collection: 'projects', envelope: { totalCount: 1 } });
  const people = source('rota_workload_summary', { people: [{ name: 'Person', openTasks: 3 }] }, { id: 'R2', collection: 'people', envelope: { totalCount: 1 } });
  assert.equal(verify([projects, people], rows(['tasks.open']), ['R1:data.projects.*.tasks.open']).ok, true);
});

test('same-metric concrete carriers and snapshot dimensions remain distinct', () => {
  const first = source('rota_dependency_inspect', { coverage: { byType: { FS: 2 } } });
  const second = source('rota_dependency_inspect', { coverage: { byType: { SS: 3 } } }, { id: 'R2' });
  const request = { operation: 'value', metrics: ['dependencies.byType'], entities: [] };
  assert.equal(verify([first, second], request, ['R1:data.coverage.byType.FS']).ok, true);
  const grouped = source('rota_task_analytics', { groups: [{ key: 'todo', open: 2 }] }, { collection: 'groups', snapshotDimensions: { groupBy: 'status' }, envelope: { totalCount: 1 } });
  const byProject = source('rota_task_analytics', { groups: [{ key: 'p', open: 3 }] }, { id: 'R2', collection: 'groups', snapshotDimensions: { groupBy: 'project' }, envelope: { totalCount: 1 } });
  assert.equal(verify([grouped, byProject], rows(['tasks.open']), ['R1:data.groups.*.open']).ok, true);
});
