import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AYSE, MEHMET, ZEYNEP, LEAD, PROJECTS, TASKS, callRotaTool, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { createAiStack } from './helpers/aiStack.mjs';
import { phase4eConversation, populationReads } from './helpers/phase4eScenario.mjs';
import { verifyRequested } from './helpers/requestScenario.mjs';

const { analysisSchema, ANALYSIS_LIMITS, analysisSuggestion, expandAnalysis, parseAnalysis } = await import('../src/server/ai/tools/analysisPlan.js');
const { buildComposition, defaultComposition, renderComposition, validateComposition, COMPOSITION_LIMITS } = await import('../src/domain/ai/groundedComposition.js');
const { analystPropositions } = await import('../src/domain/ai/groundedPropositions.js');
const { ANSWER_DETAIL_CONTRACT } = await import('../src/domain/ai/answerDetail.js');
const plan = (analysis) => ({ intent: 'rota', language: 'tr', analysis });
const call = (arguments_) => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: arguments_ }] });

test('109: comparison analyst figures retain both subject names and their own values', async (t) => {
  const { ask } = phase4eConversation(t, { composition: false });
  const result = await ask({ text: 'Ayşe Yılmaz ve Zeynep Kaya durumlarını karşılaştır', plan: plan({ scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'], focus: ['overview'] }) });
  assert.equal(result.answer.finishReason, 'stop');
  assert.match(result.answer.content, /\*\*Ayşe Yılmaz\*\*:[^\n]*\*\*6\*\*/);
  assert.match(result.answer.content, /\*\*Zeynep Kaya\*\*:[^\n]*\*\*2\*\*/);
});

test('109: mixed analysis and additional requests reject the entire declaration before any read', async (t) => {
  const plans = [{ ...plan({ scope: 'self', focus: ['overview'] }), additionalRequests: [{ operation: 'value', metrics: ['tasks.total'] }] },
    { intent: 'clarify', language: 'tr', clarify: { reason: 'ambiguous' } }];
  const { ask } = phase4eConversation(t, { planner: () => call(plans.shift()) });
  const result = await ask({ text: 'durumumu ve proje toplamını göster' });
  assert.equal(result.answer.finishReason, 'clarification');
  assert.deepEqual(result.log, []);
  assert.ok(result.inputs[1].messages.some((message) => String(message.content).includes('$.analysis:request')));
});

test('109: row follow-up retains the project intersection in every actual population read', async (t) => {
  const { ask } = phase4eConversation(t, { composition: false });
  const first = await ask({ text: 'Radar Modernizasyonu projesinde ekibimin iş yükü', plan: plan({ scope: 'team', within: 'Radar Modernizasyonu', focus: ['workload'] }) });
  assert.equal(first.answer.finishReason, 'stop', first.answer.content);
  const result = await ask({ text: 'ilk kişinin bu projedeki durumunu değerlendir', plan: plan({ scope: 'row', rows: [1], focus: ['overview', 'priority'] }) });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  const reads = populationReads(result.log);
  assert.ok(reads.length >= 2);
  assert.ok(reads.every(({ params }) => params.assigneeMode === 'person' && params.personSicil === ZEYNEP && params.projectId.toLowerCase() === PROJECTS.FULL));
});

test('109: partial grouped comparison cannot persist a one-subject previous scope', async (t) => {
  const { stack, ask } = phase4eConversation(t, { composition: false });
  stack.db.aiToolFailure = { get 'task-facts'() {
    return stack.db.aiToolLog.at(-1)?.params.personSicil === ZEYNEP ? new Error('fixture unavailable') : null;
  } };
  const first = await ask({ text: 'Ayşe Yılmaz ve Zeynep Kaya önceliklerini karşılaştır', plan: plan({ scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'], focus: ['priority'] }) });
  assert.equal(first.answer.finishReason, 'unavailable', first.answer.content);
  assert.ok(populationReads(first.log).some(({ params }) => params.personSicil === AYSE));
  assert.ok(populationReads(first.log).some(({ params }) => params.personSicil === ZEYNEP));
  stack.db.aiToolFailure = null;
  const next = await ask({ text: 'aynı kişilerin genel durumu', plan: plan({ scope: 'previous', focus: ['overview'] }) });
  assert.equal(next.answer.finishReason, 'clarification');
  assert.deepEqual(next.log, []);
});

test('109: workload completeness never signals whether hidden assignments exist', async (t) => {
  for (const hidden of ['unnamed', 'named', 'sql-omitted', 'none']) await t.test(hidden, async (t) => {
    const seed = rotaToolSeed();
    const own = hidden !== 'sql-omitted';
    seed.tasks = seed.tasks.filter((task) => task.TaskId === (own ? TASKS.PARTIAL_SHARED : TASKS.TEAM_VISIBLE));
    seed.taskAssignees = [{ TaskId: seed.tasks[0].TaskId, Sicil: own ? AYSE : ZEYNEP },
      ...(hidden !== 'none' ? [{ TaskId: seed.tasks[0].TaskId, Sicil: MEHMET }] : [])];
    if (hidden === 'unnamed') seed.people = seed.people.filter((person) => person.Sicil !== MEHMET);
    const stack = createAiStack(t, { sicil: AYSE, seed });
    const { result } = await callRotaTool(stack, AYSE, 'rota_workload_summary', {});
    assert.equal(result.ok, true);
    assert.equal(result.data.populationComplete, false);
    assert.equal(result.data.unrepresentedOpenTasks, 0, 'the disclosed person still represents the task');
    assert.equal(JSON.stringify(result.data).includes(String(MEHMET)), false);
    assert.equal(JSON.stringify(result.data).includes('Mehmet Demir'), false);
    assert.equal(result.data.people.length, 1);
  });
});

function completeWorkloadSeed(loads = [2, 2, 2]) {
  const seed = rotaToolSeed();
  const original = seed.tasks.find((task) => task.TaskId === TASKS.OVERDUE);
  seed.tasks = loads.flatMap((count, person) => Array.from({ length: count }, (_, index) => ({ ...original,
    TaskId: `20000000-0000-4000-8000-${String(100 + person * 30 + index).padStart(12, '0')}`, Status: 'planned',
    TargetFinish: person === 2 ? '2026-09-01' : '2026-10-05' })));
  seed.taskAssignees = seed.tasks.map((task) => ({ TaskId: task.TaskId, Sicil: [AYSE, ZEYNEP, LEAD][Math.floor((Number(task.TaskId.slice(-12)) - 100) / 30)] }));
  return seed;
}

async function workloadSheet(t, { loads, limit = 25 } = {}) {
  const stack = createAiStack(t, { sicil: AYSE, seed: completeWorkloadSeed(loads) });
  const { result, ledger } = await callRotaTool(stack, AYSE, 'rota_workload_summary', { projectId: PROJECTS.FULL, limit });
  const verdict = verifyRequested(ledger, ['data.people.*.name', 'data.people.*.openTasks', 'data.people.*.overdue'], {
    operation: limit < 25 ? 'rank' : 'list', ...(limit < 25 ? { rank: { metric: 'tasks.open', order: 'desc', limit } } : {}), metrics: ['person.name', 'tasks.open', 'tasks.overdue'], population: { tool: 'rota_workload_summary', collection: 'people' },
    entities: [{ type: 'project', id: PROJECTS.FULL }]
  });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  return { result, verdict, ledger, sheet: buildComposition({ parts: [{ index: 0, presentation: verdict.presentation }], analyst: true }) };
}

test('109: canonical verified workload context supports complete balance and grounds unrepresented counts', async (t) => {
  const { result, verdict, sheet } = await workloadSheet(t);
  assert.equal(result.data.populationComplete, true);
  assert.ok(verdict.presentation.facts.some(({ fact }) => fact.field === 'data.populationComplete' && fact.value === true));
  assert.ok(verdict.presentation.facts.some(({ fact }) => fact.field === 'data.unrepresentedOpenTasks' && fact.value === 0));
  assert.ok(sheet.view.propositions.some((item) => item.kind === 'balance'));
  assert.match(renderComposition(sheet, defaultComposition(sheet)).text, /görece dengeli/);
});

test('109: complete workload permits concentration; incomplete assignment coverage suppresses it through verified evidence', async (t) => {
  for (const incomplete of [false, true]) await t.test(String(incomplete), async (t) => {
    const seed = completeWorkloadSeed([8, 2, 2]);
    if (incomplete) seed.people = seed.people.filter((person) => person.Sicil !== LEAD);
    const stack = createAiStack(t, { sicil: AYSE, seed });
    const { ledger, result } = await callRotaTool(stack, AYSE, 'rota_workload_summary', { projectId: PROJECTS.FULL });
    const verdict = verifyRequested(ledger, ['data.people.*.name', 'data.people.*.openTasks', 'data.populationComplete', 'data.unrepresentedOpenTasks'], {
      operation: 'list', metrics: ['person.name', 'tasks.open'], population: { tool: 'rota_workload_summary', collection: 'people' }, entities: [{ type: 'project', id: PROJECTS.FULL }]
    });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
    const conclusions = analystPropositions([{ index: 0, presentation: verdict.presentation }]);
    assert.equal(conclusions.some((item) => item.proposition.kind === 'concentration'), !incomplete);
    assert.equal(result.data.unrepresentedOpenTasks, incomplete ? 2 : 0);
    assert.ok(verdict.facts.some(({ fact }) => fact.field === 'data.unrepresentedOpenTasks' && fact.value === (incomplete ? 2 : 0)));
    if (incomplete) assert.equal(JSON.stringify(result.data).includes(String(LEAD)), false);
  });
});

test('109: truncated workload cannot name a leader when the real overdue leader is outside returned rows', async (t) => {
  const { result, sheet } = await workloadSheet(t, { loads: [12, 11, 10], limit: 2 });
  assert.equal(result.truncated, true);
  assert.equal(result.data.populationComplete, false);
  assert.equal(result.data.people.some((person) => person.sicil === LEAD), false);
  assert.ok(!sheet.view.propositions.some((item) => ['leader', 'balance', 'concentration', 'overdueConcentration'].includes(item.kind)));
  assert.doesNotMatch(renderComposition(sheet, defaultComposition(sheet)).text, /en üstte|görece dengeli|bu kişide yoğunlaşıyor/);
});

test('109: focus schema and parser expose the same shared maximum', () => {
  assert.equal(analysisSchema().properties.focus.maxItems, ANALYSIS_LIMITS.maxFocus);
  assert.throws(() => parseAnalysis({ scope: 'self', focus: ['overview', 'status', 'priority', 'workload'] }));
});

test('109: repair suggestions neither add nor drop population filters, including comparison expansions', () => {
  for (const entities of [[], [{ type: 'person', text: 'Ayşe Yılmaz' }, { type: 'person', text: 'Zeynep Kaya' }]]) {
    for (const groupBy of ['priority', 'deadline', 'target_month']) {
      const request = { population: { tool: 'rota_task_analytics', groupBy }, entities };
      assert.equal(analysisSuggestion(request), null, groupBy);
      assert.ok(analysisSuggestion({ ...request, filters: { status: ['todo', 'in_progress'] } }), groupBy);
    }
    if (!entities.length) assert.ok(analysisSuggestion({ population: { tool: 'rota_task_search' }, entities, filters: { deadline: 'overdue' } }));
  }
});

test('109: short dependency rendering preserves predecessor and successor evidence with at most one table/chart', async (t) => {
  const seed = rotaToolSeed();
  const ids = [TASKS.OVERDUE, TASKS.DUE_SOON, TASKS.DONE, TASKS.LITERAL];
  seed.taskDependencies = ids.map((id, index) => ({ ProjectId: PROJECTS.FULL, PredecessorTaskId: index < 2 ? id : TASKS.UNASSIGNED,
    TaskId: index < 2 ? TASKS.UNASSIGNED : id, DependencyType: 'FS', LagValue: 0, LagUnit: 'day' }));
  const stack = createAiStack(t, { sicil: AYSE, seed });
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_dependency_inspect', { taskId: TASKS.UNASSIGNED });
  const verdict = verifyRequested(ledger, ['data.predecessors.*.title', 'data.successors.*.title'], {
    operation: 'list', metrics: ['task.title'], population: { tool: 'rota_dependency_inspect' }, entities: [{ type: 'task', id: TASKS.UNASSIGNED }]
  });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  const sheet = buildComposition({ parts: [{ index: 0, presentation: verdict.presentation }], detail: 'short' });
  assert.equal(sheet.render.tables.size, 2);
  const layout = defaultComposition(sheet);
  assert.ok(layout?.ok);
  assert.ok(layout.blocks.filter((block) => block.type === 'chart' || (block.type === 'rows' && block.style === 'table')).length <= 1);
  const rendered = renderComposition(sheet, layout).text;
  for (const id of ids) assert.ok(rendered.replaceAll('\\', '').includes(seed.tasks.find((task) => task.TaskId === id).Title), rendered);
  assert.equal(ANSWER_DETAIL_CONTRACT.short.maxNarrated, 2);
});

test('109: English project-filtered open partition explicitly retains the open task noun', async (t) => {
  const stack = createAiStack(t, { sicil: AYSE, seed: rotaToolSeed() });
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_analytics', { projectId: PROJECTS.FULL, groupBy: 'priority' });
  const verdict = verifyRequested(ledger, ['data.groups.*.label', 'data.groups.*.open', 'data.groups.*.done'], {
    operation: 'list', metrics: ['tasks.open', 'tasks.done'], population: { tool: 'rota_task_analytics', groupBy: 'priority', collection: 'groups' }, entities: [{ type: 'project', id: PROJECTS.FULL }]
  }, { locale: 'en' });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  const sheet = buildComposition({ parts: [{ index: 0, presentation: verdict.presentation }], locale: 'en' });
  const partition = sheet.view.propositions.find((item) => ['majority', 'largest'].includes(item.kind));
  assert.ok(partition);
  assert.match(partition.text, /open tasks in the Radar Modernizasyonu project/);
});

test('109: optional analyst propositions cannot invalidate a layout near its hard limit', async (t) => {
  const stack = createAiStack(t, { sicil: AYSE, seed: rotaToolSeed() });
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_search', { assignee: 'me', deadline: 'overdue' });
  const verdict = verifyRequested(ledger, ['totalCount', 'data.tasks.*.title', 'data.tasks.*.overdueDays', 'data.tasks.*.targetFinish'], {
    operation: 'list', metrics: ['tasks.total', 'task.title', 'task.overdueDays', 'task.targetFinish'], filters: { assignee: 'me', deadline: 'overdue' }
  });
  assert.equal(verdict.ok, true);
  const parts = [0, 1].map((index) => ({ index, presentation: verdict.presentation }));
  const basic = buildComposition({ parts });
  assert.ok(basic);
  const enriched = buildComposition({ parts, analyst: true });
  assert.ok(enriched);
  assert.ok(enriched.view.propositions.length <= COMPOSITION_LIMITS.maxPropositions);
  assert.ok(defaultComposition(enriched)?.ok);
  assert.ok(validateComposition(enriched, { blocks: defaultComposition(enriched).blocks }).ok);
});

test('109: trace persistence strips sensitive values and restricts new and existing files', async () => {
  const { appendPrivateDiagnostic } = await import('../scripts/private-diagnostic-trace.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'pr109-trace-'));
  try {
    for (const existing of [false, true]) {
      const path = join(directory, existing ? 'existing.jsonl' : 'new.jsonl');
      if (existing) { writeFileSync(path, ''); chmodSync(path, 0o666); }
      appendPrivateDiagnostic(path, { text: 'PRIVATE ANSWER', turn: 'PRIVATE QUERY', answer: 'PRIVATE RESPONSE', failures: ['PRIVATE FAILURE'],
        toolCalls: [{ name: 'rota_plan', arguments: { analysis: { names: ['PRIVATE PERSON'] }, token: 'PRIVATE SECRET' } }],
        reads: [{ query: 'task-facts', personSicil: 'PRIVATE ID', projectId: 'PRIVATE PROJECT', assigneeMode: 'team', teamLevel: 'UNIT' }],
        trail: [{ role: 'assistant', content: 'PRIVATE TRAIL', calls: ['PRIVATE CALL'] }] });
      const persisted = readFileSync(path, 'utf8');
      assert.equal(persisted.includes('PRIVATE'), false);
      const metadata = JSON.parse(persisted);
      assert.equal(metadata.toolCalls[0].kind, 'rota_plan');
      assert.equal(metadata.failureCount, 1);
      assert.equal(metadata.reads[0].assigneeMode, 'team');
      if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
