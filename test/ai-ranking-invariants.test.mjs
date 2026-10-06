import assert from 'node:assert/strict';
import test from 'node:test';
import { claimableContract } from '../src/domain/ai/claimableEvidence.js';
import { analyzeGroundedAnswer } from '../src/domain/ai/evidenceVerification.js';
import { decimalFromScaled } from '../src/domain/numbers/fixedDecimal.js';
import { ASSISTANT_AVAILABILITY_META } from '../src/domain/ai/assistantContract.js';
import { assistantEnabledInDocument, RUNTIME_FEATURES_COOKIE } from '../src/lib/runtimeFeatures.js';
import { assistantEnabledInDocument as interactionEnablement } from '../src/features/ai/assistant/assistantInteraction.js';

function verify(tool, data, fields, request, options = {}) {
  const envelope = { ok: true, tool, data, evidenceId: 'R1', factScope: '0123456789abcdef_R1',
    claimable: claimableContract(tool), today: '2026-09-30', generatedAt: '2026-09-30T00:00:00Z',
    complete: true, truncated: false, ...options.envelope };
  const source = { tool, envelope, facets: {}, declared: {}, unsupported: [], selectors: [], firstPage: true,
    ...options.source };
  return analyzeGroundedAnswer(JSON.stringify({ kind: 'rota', facts: fields.map((field) => `R1:${field}`) }), {
    evidenceIds: ['R1'], evidencePayloads: [{ id: 'R1', payload: JSON.stringify(envelope) }],
    request: { entities: [], ...request }, evidence: new Map([['R1', source]])
  });
}

const issue = (result) => result.issues[0]?.code ?? null;
const rank = (metric, order = 'desc', limit = 1) => ({ operation: 'rank', metrics: [metric], rank: { metric, order, limit } });

test('a singleton preview cannot replace the requested population total', () => {
  const tool = 'rota_portfolio_summary';
  const data = { projects: [{ projectId: 'one', name: 'Bir', tasks: { overdue: 2 } }], totals: { overdue: 7 } };
  const request = { operation: 'value', metrics: ['tasks.overdue'] };
  const preview = { envelope: { complete: false, truncated: true, totalCount: 3 } };
  assert.equal(issue(verify(tool, data, ['data.projects.0.tasks.overdue'], request, preview)), 'ROW_SELECTION_UNBOUND');
  assert.equal(issue(verify(tool, data, ['data.totals.overdue'], request, preview)), null);
  assert.equal(issue(verify(tool, data, ['data.projects.0.tasks.overdue'], {
    ...request, entities: [{ type: 'project', bound: 'one' }]
  }, preview)), null);
  assert.equal(issue(verify(tool, data, ['data.projects.0.tasks.overdue'], request, {
    envelope: { complete: true, truncated: false, totalCount: 1 }
  })), null);
  assert.equal(issue(verify(tool, data, ['data.projects.0.tasks.overdue'], request, { source: { firstPage: false } })), 'ROW_SELECTION_UNBOUND');
});

test('nested recurrence occurrences are rows while nested primitive values remain indivisible', () => {
  const series = { templateTaskId: 'series', title: 'Toplantı', next: [
    { taskId: 'first', occurrenceDate: '2026-10-01', targetFinish: '2026-10-01', status: 'todo' },
    { taskId: 'second', occurrenceDate: '2026-10-08', targetFinish: '2026-10-08', status: 'todo' }
  ] };
  const request = { operation: 'value', metrics: ['recurrence.occurrenceDate'], entities: [{ type: 'task', bound: 'first' }] };
  assert.equal(issue(verify('rota_recurrence_inspect', { series: [series] }, ['data.series.0.next.0.occurrenceDate'], request)), null);
  assert.equal(issue(verify('rota_recurrence_inspect', { series: [series] }, ['data.series.0.next.1.occurrenceDate'], request)), 'ENTITY_MISSING');
  assert.equal(issue(verify('rota_recurrence_inspect', { series: [series] }, ['data.series.0.next.0.occurrenceDate'],
    { ...request, entities: [] })), 'ROW_SELECTION_UNBOUND');
  const list = { ...request, operation: 'list' };
  assert.equal(issue(verify('rota_recurrence_inspect', { series: [series] }, ['data.series.0.next.0.occurrenceDate'], list)), 'LIST_INCOMPLETE');
  assert.equal(issue(verify('rota_calendar_inspect', { calendar: { workingWeekdays: [1, 2] } },
    ['data.calendar.workingWeekdays.0'], { operation: 'value', metrics: ['calendar.workingWeekdays'] })), 'PARTIAL_VALUE_LIST');
});

test('hour ranks compare exact decimals, mixed representations and numeric ties', () => {
  const large = decimalFromScaled(10000000000000000n, 2);
  const smaller = decimalFromScaled(9999999999999999n, 2);
  assert.equal(typeof large, 'string');
  const people = [large, smaller].map((hours, index) => ({ sicil: index + 1, name: `Kişi ${index}`, plannedHoursOnAssignedTasks: hours }));
  for (const [order, index] of [['desc', 0], ['asc', 1]]) {
    assert.equal(issue(verify('rota_workload_summary', { people }, [`data.people.${index}.plannedHoursOnAssignedTasks`], rank('tasks.plannedHours', order))), null);
    assert.equal(issue(verify('rota_workload_summary', { people }, [`data.people.${1 - index}.plannedHoursOnAssignedTasks`], rank('tasks.plannedHours', order))), 'RANK_MISMATCH');
  }
  const largePreview = { source: { sortedBy: { metric: 'tasks.plannedHours', order: 'desc' } },
    envelope: { complete: false, truncated: true, rankingBoundary: { collection: 'people', metric: 'tasks.plannedHours',
      order: 'desc', returnedCount: 1, nextValue: smaller } } };
  assert.equal(issue(verify('rota_workload_summary', { people: people.slice(0, 1) }, ['data.people.0.plannedHoursOnAssignedTasks'], rank('tasks.plannedHours'), largePreview)), null);
  people[0].plannedHoursOnAssignedTasks = 2;
  people[1].plannedHoursOnAssignedTasks = '2.00';
  assert.equal(issue(verify('rota_workload_summary', { people }, ['data.people.0.plannedHoursOnAssignedTasks'], rank('tasks.plannedHours'))), 'RANK_MISMATCH');
  assert.equal(issue(verify('rota_workload_summary', { people }, ['data.people.*.plannedHoursOnAssignedTasks'], rank('tasks.plannedHours'))), null);
  const source = { sortedBy: { metric: 'tasks.plannedHours', order: 'desc' } };
  const boundary = { collection: 'people', metric: 'tasks.plannedHours', order: 'desc', returnedCount: 1, nextValue: '1.99' };
  const preview = { source, envelope: { complete: false, truncated: true, rankingBoundary: boundary } };
  assert.equal(issue(verify('rota_workload_summary', { people: people.slice(0, 1) }, ['data.people.0.plannedHoursOnAssignedTasks'], rank('tasks.plannedHours'), preview)), null);
  boundary.nextValue = '2.00';
  assert.equal(issue(verify('rota_workload_summary', { people: people.slice(0, 1) }, ['data.people.0.plannedHoursOnAssignedTasks'], rank('tasks.plannedHours'), preview)), 'RANK_MISMATCH');
});

test('dependency previews reject missing ties, undersized ranks, ascending ranks and complete lists', () => {
  const mostConnected = Array.from({ length: 5 }, (_, index) => ({ taskId: String(index), title: `Görev ${index}`, relationCount: 2 }));
  const options = { source: { sortedBy: { metric: 'dependencies.relationCount', order: 'desc' } },
    envelope: { complete: false, truncated: true, rankingBoundary: { collection: 'mostConnected',
      metric: 'dependencies.relationCount', order: 'desc', returnedCount: 5, nextValue: 2 } } };
  for (const [order, limit] of [['desc', 1], ['desc', 10], ['asc', 1]]) {
    assert.equal(issue(verify('rota_dependency_inspect', { mostConnected }, ['data.mostConnected.*.relationCount'], rank('dependencies.relationCount', order, limit), options)), 'RANK_MISMATCH');
  }
  assert.equal(issue(verify('rota_dependency_inspect', { mostConnected }, ['data.mostConnected.*.relationCount'],
    { operation: 'list', metrics: ['dependencies.relationCount'] }, options)), 'LIST_INCOMPLETE');
  options.envelope.rankingBoundary.nextValue = 1;
  assert.equal(issue(verify('rota_dependency_inspect', { mostConnected }, ['data.mostConnected.*.relationCount'], rank('dependencies.relationCount'), options)), null);
});

test('the shell and assistant share enablement policy for missing cookies and explicit disabled markers', () => {
  assert.equal(assistantEnabledInDocument, interactionEnablement);
  const documentWith = (cookie, meta) => ({ cookie, querySelector(selector) {
    assert.equal(selector, `meta[name="${ASSISTANT_AVAILABILITY_META}"]`);
    return meta == null ? null : { getAttribute: () => meta };
  } });
  assert.equal(assistantEnabledInDocument(documentWith('', null), null), true);
  assert.equal(assistantEnabledInDocument(documentWith('', 'disabled'), null), false);
  assert.equal(assistantEnabledInDocument(documentWith(`${RUNTIME_FEATURES_COOKIE}=disabled`, 'enabled')), false);
  assert.equal(assistantEnabledInDocument(documentWith(`${RUNTIME_FEATURES_COOKIE}=enabled`, 'disabled')), true);
  assert.equal(assistantEnabledInDocument(documentWith('', 'enabled'), { assistant: false }), false);
});

test('a population total cannot supply a missing per-row metric', () => {
  const data = { openTaskCount: 7, people: [{ sicil: 1, name: 'Birinci', openTasks: 2 }, { sicil: 2, name: 'İkinci' }] };
  const fields = ['data.openTaskCount', 'data.people.*.name', 'data.people.0.openTasks'];
  for (const operation of ['list', 'rank']) {
    const request = operation === 'rank' ? rank('tasks.open') : { operation, metrics: ['tasks.open'] };
    assert.equal(issue(verify('rota_workload_summary', data, fields, request)), 'METRIC_MISSING');
  }
});
