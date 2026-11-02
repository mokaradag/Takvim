import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AYSE, MEHMET, ZEYNEP, LEAD, PROJECTS, TASKS, callRotaTool, callRotaTools, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { createAiStack } from './helpers/aiStack.mjs';
import { phase4eConversation, populationReads, turnViolations } from './helpers/phase4eScenario.mjs';
import { verifyRequested } from './helpers/requestScenario.mjs';
import { compositionView, coveringBlocks } from './helpers/compositionScenario.mjs';

const { analysisSchema, ANALYSIS_LIMITS, analysisSuggestion, expandAnalysis, parseAnalysis } = await import('../src/server/ai/tools/analysisPlan.js');
const { buildComposition, defaultComposition, renderComposition, validateComposition, COMPOSITION_LIMITS } = await import('../src/domain/ai/groundedComposition.js');
const { analystPropositions } = await import('../src/domain/ai/groundedPropositions.js');
const { ANSWER_DETAIL_CONTRACT } = await import('../src/domain/ai/answerDetail.js');
const { renderVerifiedNarrative } = await import('../src/domain/ai/evidenceNarrative.js');
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

test('109: zero totals never refer to completion subsets; positive totals retain natural none-completed prose', async (t) => {
  for (const total of [0, 1]) for (const locale of ['tr', 'en']) for (const generic of [false, true]) {
    await t.test(`${total}/${locale}/${generic}`, async (t) => {
      const seed = completeWorkloadSeed([total, 0, 0]);
      const stack = createAiStack(t, { sicil: AYSE, seed });
      const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_analytics', {});
      const verdict = verifyRequested(ledger, ['data.totals.total', 'data.totals.done', ...(generic ? ['data.totals.open'] : [])], {
        operation: 'value', metrics: ['tasks.total', 'tasks.done', ...(generic ? ['tasks.open'] : [])]
      }, { locale });
      assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
      assert.match(verdict.normalized, new RegExp(`\\*\\*${total}\\*\\*`));
      if (!total) assert.doesNotMatch(verdict.normalized, /None of them|Of these|Bunların/);
      else if (!generic) assert.match(verdict.normalized, locale === 'en' ? /None of them is completed yet/ : /Bunların hiçbiri henüz tamamlanmamış/);
      else assert.match(verdict.normalized, locale === 'en' ? /Of these/ : /Bunların/);
    });
  }
});

test('109: every English overdue narrative path realizes 0/1/2 days correctly', async (t) => {
  for (const days of [0, 1, 2]) for (const project of [false, true]) await t.test(`${days}/${project}`, async (t) => {
    const seed = rotaToolSeed();
    seed.tasks.find((task) => task.TaskId === TASKS.OVERDUE).TargetFinish = `2026-09-${30 - Math.max(1, days)}`;
    const stack = createAiStack(t, { sicil: AYSE, seed });
    const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_detail', { taskId: TASKS.OVERDUE });
    const verdict = verifyRequested(ledger, ['data.task.title', 'data.task.overdueDays', ...(project ? ['data.task.project.name'] : [])], {
      operation: 'value', metrics: ['task.title', 'task.overdueDays'], entities: [{ type: 'task', id: TASKS.OVERDUE }]
    }, { locale: 'en' });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
    // The tool omits overdueDays for an on-time task; zero exercises the renderer's numeric boundary directly.
    const text = renderVerifiedNarrative(verdict.facts.map((item) => item.fact.field === 'data.task.overdueDays'
      ? { ...item, fact: { ...item.fact, value: days } } : item), { locale: 'en' });
    assert.ok(text.includes(`**${days}** ${days === 1 ? 'day' : 'days'} overdue.`), text);
    assert.match(text, project ? /task in the .* project is/ : /It is/);
  });
});

async function twoWorkloads(t) {
  const first = completeWorkloadSeed([8, 2, 2]);
  const second = completeWorkloadSeed([2, 2, 2]);
  second.tasks = second.tasks.map((task) => ({ ...task, TaskId: task.TaskId.replace('20000000', '21000000'), ProjectId: PROJECTS.READ }));
  second.taskAssignees = second.taskAssignees.map((row) => ({ ...row, TaskId: row.TaskId.replace('20000000', '21000000') }));
  const seed = { ...first, tasks: [...first.tasks, ...second.tasks], taskAssignees: [...first.taskAssignees, ...second.taskAssignees] };
  const stack = createAiStack(t, { sicil: AYSE, seed });
  const { ledger, results } = await callRotaTools(stack, AYSE, [PROJECTS.FULL, PROJECTS.READ].map((projectId) => ['rota_workload_summary', { projectId }]));
  const facts = results.flatMap((result, index) => {
    assert.equal(result.ok, true);
    assert.equal(result.data.populationComplete, true);
    const evidence = `R${index + 1}`;
    const verdict = verifyRequested(ledger, ['data.people.*.name', 'data.people.*.openTasks', 'data.people.*.overdue'].map((field) => `${evidence}:${field}`), {
      operation: 'list', metrics: ['person.name', 'tasks.open', 'tasks.overdue'], population: { tool: 'rota_workload_summary', collection: 'people' },
      entities: [{ type: 'project', id: [PROJECTS.FULL, PROJECTS.READ][index] }]
    });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
    return verdict.presentation.facts;
  });
  return facts;
}

test('109: overlapping workload row indices produce independent conclusions with their own evidence', async (t) => {
  const facts = await twoWorkloads(t);
  assert.deepEqual(facts.filter(({ fact }) => fact.field === 'data.people.0.openTasks').map(({ evidenceId, fact }) => [evidenceId, fact.value]), [['R1', 8], ['R2', 2]]);
  const conclude = (items) => analystPropositions([{ index: 0, presentation: { facts: items } }]).map(({ proposition }) => ({
    evidenceId: proposition.evidenceId, kind: proposition.kind, text: proposition.markdown
  }));
  const separate = ['R1', 'R2'].flatMap((id) => conclude(facts.filter(({ evidenceId }) => evidenceId === id)));
  assert.ok(separate.some((item) => item.evidenceId === 'R1' && item.kind === 'concentration'));
  assert.ok(separate.some((item) => item.evidenceId === 'R2' && item.kind === 'balance'));
  assert.deepEqual(conclude(facts), separate, 'combining a part cannot overwrite fields or conclusions from either evidence population');
  const incomplete = facts.map((item) => item.evidenceId === 'R2' && item.fact.field === 'data.populationComplete' ? { ...item, fact: { ...item.fact, value: false } } : item);
  assert.ok(!conclude(incomplete).some((item) => item.evidenceId === 'R2'));
});

test('109: overdue attention selects within each evidence population and never borrows another population row', async (t) => {
  const stack = createAiStack(t, { sicil: AYSE, seed: rotaToolSeed() });
  const { ledger } = await callRotaTools(stack, AYSE, [
    ['rota_task_search', { assignee: 'me', deadline: 'overdue' }], ['rota_task_search', { projectId: PROJECTS.FULL, deadline: 'overdue' }]
  ]);
  const populations = ['R1', 'R2'].map((id, index) => {
    const verdict = verifyRequested(ledger, ['data.tasks.*.title', 'data.tasks.*.overdueDays'].map((field) => `${id}:${field}`), {
      operation: 'list', metrics: ['task.title', 'task.overdueDays'], filters: { ...(index === 0 ? { assignee: 'me' } : {}), deadline: 'overdue' },
      ...(index === 1 ? { entities: [{ type: 'project', id: PROJECTS.FULL }] } : {})
    });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
    return verdict.presentation.facts;
  });
  const [first, second] = populations;
  const conclude = (facts) => analystPropositions([{ index: 0, presentation: { facts } }]).filter(({ proposition }) => proposition.kind === 'attention');
  assert.equal(conclude(first).length, 1);
  assert.deepEqual(conclude([...first, ...second]), [...conclude(first), ...conclude(second)], 'equal delays across populations are not ties');
  const row0 = (facts) => facts.filter(({ fact }) => fact.field.startsWith('data.tasks.0.'));
  assert.deepEqual(conclude([...row0(first), ...row0(second)]), [], 'one row in each population is not two rows in either population');
});

test('109: diagnostic persistence failures at file validation, chmod and write remain nonfatal and privacy-safe', async (t) => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { appendPrivateDiagnostic } = await import('../scripts/private-diagnostic-trace.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'pr109-trace-failure-'));
  try {
    for (const method of ['fstatSync', 'fchmodSync', 'writeSync']) {
      let stderr = '';
      t.mock.method(process.stderr, 'write', (chunk) => { stderr += chunk; return true; });
      t.mock.method(fs, method, () => { throw new Error('PRIVATE FAILURE'); });
      syncBuiltinESMExports();
      assert.equal(appendPrivateDiagnostic(join(directory, method), { text: 'PRIVATE RESPONSE' }), false);
      assert.equal(stderr, 'PRIVATE_DIAGNOSTIC_WRITE_FAILED\n');
      assert.equal(readFileSync(join(directory, method), 'utf8'), '');
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(directory, { recursive: true, force: true }); }
});

test('109: chain F requires a real chart and its expectation rejects an answer without one', () => {
  const followups = JSON.parse(readFileSync(new URL('./fixtures/ai-phase4e-followups.json', import.meta.url), 'utf8'));
  const turn = followups.chains.find((chain) => chain.id === 'F').turns.at(-1);
  assert.equal(turn.plan.visual, true);
  assert.equal(turn.expect.chart, true);
  const withoutChart = { answer: { finishReason: 'stop', content: 'verified results' }, log: [{ query: 'task-facts', params: { projectId: PROJECTS.FULL } }] };
  assert.deepEqual(turnViolations(withoutChart, turn.expect), ['grafik yok']);
});

test('109: structurally valid compositions outside verdict citation scope retain the safe visual fallback', async (t) => {
  const { presentVerdict } = await import('../src/server/ai/assistant/groundedAnswer.js');
  const { composeGroundedAnswer } = await import('../src/server/ai/assistant/answerComposition.js');
  for (const foreign of [false, true]) await t.test(String(foreign), async (t) => {
    const stack = createAiStack(t, { sicil: AYSE, seed: rotaToolSeed() });
    const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_analytics', { assignee: 'me' });
    const verified = verifyRequested(ledger, ['total', 'open', 'done', 'overdue'].map((key) => `data.totals.${key}`), {
      operation: 'value', metrics: ['tasks.total', 'tasks.open', 'tasks.done', 'tasks.overdue'], filters: { assignee: 'me' }
    });
    assert.equal(verified.ok, true, JSON.stringify(verified.issues));
    // Defensive boundary fixture: a composition sheet contains extra, otherwise valid evidence, outside the final verdict.
    const facts = [...verified.presentation.facts, ...(foreign ? verified.presentation.facts.map((item) => ({ ...item, evidenceId: 'R2' })) : [])];
    const verdict = { ...verified, kind: 'grounded', presentation: { ...verified.presentation, facts } };
    const session = { signal: new AbortController().signal, remainingMs: () => 120000, model: 'fixture', maxOutputTokens: 4096,
      async round(input) { return { text: JSON.stringify(coveringBlocks(compositionView(input))), finishReason: 'stop' }; } };
    const sheet = buildComposition({ parts: [{ index: 0, presentation: verdict.presentation }], visual: true });
    assert.ok(sheet.render.charts.size > 0);
    const composed = await composeGroundedAnswer({ session, composition: sheet });
    assert.equal(composed.ok, true, JSON.stringify(composed));
    assert.equal(composed.citedIds.includes('R2'), foreign, 'the real composition validator accepts the structure before the outer citation boundary');
    const turn = { presentationIntent: { visual: true }, composeAnswers: true, session, ledger, partCount: 1, answers: [],
      partEvidence: new Set(ledger.ids()), question: { text: 'grafikle göster' }, context: { today: '2026-09-30' },
      trace: { rounds: [] }, models: [], modelRounds: 0, work: 0, revalidatedAt: 0, status() {}, progress() {} };
    const answer = await presentVerdict(turn, verdict, true);
    assert.deepEqual(answer.citedIds, verified.citedIds);
    assert.doesNotMatch(answer.normalized, /【R2】/);
    if (foreign) {
      assert.equal(turn.trace.presentation.reason, 'CITATION_SCOPE');
      assert.match(answer.normalized, /güvenle grafik çizilemedi/);
    } else {
      assert.equal(turn.trace.presentation.mode, 'composed');
      assert.notEqual(turn.trace.presentation.server, true, 'passing model compositions retain their original path');
      assert.match(answer.normalized, /```rota-chart/);
    }
  });
});

test('109 final: incomplete workload cannot claim overdue coverage of the whole population', async (t) => {
  for (const incomplete of [false, true]) await t.test(String(incomplete), async (t) => {
    const seed = completeWorkloadSeed([12, 11, 10]);
    if (incomplete) {
      const task = { ...seed.tasks[0], TaskId: '20000000-0000-4000-8000-000000000999' };
      seed.tasks.push(task);
      seed.taskAssignees.push({ TaskId: task.TaskId, Sicil: 999999 });
    }
    const stack = createAiStack(t, { sicil: AYSE, seed });
    const { ledger, result } = await callRotaTool(stack, AYSE, 'rota_workload_summary', { projectId: PROJECTS.FULL });
    const verdict = verifyRequested(ledger, ['totalCount', 'data.people.*.name', 'data.people.*.overdue'], {
      operation: 'list', metrics: ['people.total', 'person.name', 'tasks.overdue'], population: { tool: 'rota_workload_summary', collection: 'people' }, entities: [{ type: 'project', id: PROJECTS.FULL }]
    });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
    const sheet = buildComposition({ parts: [{ index: 0, presentation: verdict.presentation }] });
    assert.equal(result.data.populationComplete, !incomplete);
    assert.equal(sheet.view.propositions.some((item) => item.kind === 'coverage'), !incomplete);
  });
});

test('109 final: employees with the same display name never acquire false narrative coreference', async (t) => {
  const seed = completeWorkloadSeed([8, 2, 2]);
  for (const person of seed.people) if ([AYSE, LEAD].includes(person.Sicil)) person.DisplayName = 'Ali Yılmaz';
  seed.projects = seed.projects.filter((row) => row.ProjectId === PROJECTS.FULL);
  const stack = createAiStack(t, { sicil: AYSE, seed });
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_workload_summary', {});
  const verdict = verifyRequested(ledger, ['data.people.*.name', 'data.people.*.openTasks', 'data.people.*.overdue'], {
    operation: 'list', metrics: ['person.name', 'tasks.open', 'tasks.overdue'], population: { tool: 'rota_workload_summary', collection: 'people' }
  });
  assert.equal(verdict.ok, true);
  const selected = analystPropositions([{ index: 0, presentation: verdict.presentation }]).map((item) => item.proposition)
    .filter((item) => ['concentration', 'overdueConcentration'].includes(item.kind));
  assert.equal(selected.length, 2);
  const { fluentParagraph } = await import('../src/domain/ai/groundedPropositions.js');
  const joined = fluentParagraph(selected.map((proposition) => ({ proposition })), 'tr');
  assert.doesNotMatch(JSON.stringify(joined), /de onda|also on this person/);
  assert.notEqual(selected[0].fluent.host, selected[1].fluent.follow.key);
  const same = { ...selected[1], fluent: { follow: { ...selected[1].fluent.follow, key: selected[0].fluent.host } } };
  assert.match(JSON.stringify(fluentParagraph([selected[0], same].map((proposition) => ({ proposition })), 'tr')), /de onda/, 'positive control for the real fluent joining path');
});

test('109 final: bookkeeping stays available for composition but out of fallback prose', async (t) => {
  const { verdict } = await workloadSheet(t);
  const fields = ['data.populationComplete', 'data.unrepresentedOpenTasks', 'data.unassignedOpenTasks'];
  assert.ok(fields.every((field) => verdict.presentation.facts.some((item) => item.fact.field === field)));
  const narrated = verdict.presentation.facts.filter((item) => !fields.includes(item.fact.field));
  assert.equal(verdict.normalized, renderVerifiedNarrative(narrated, { locale: 'tr', layout: null, operation: 'list', empty: [] }));
  assert.doesNotMatch(verdict.normalized, /Değer:|tamlığı:|temsil edilmeyen|sorumlusuz açık/i);
});

test('109 final: link preflight protects diagnostic files on platforms without nofollow', async (t) => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { appendPrivateDiagnostic } = await import('../scripts/private-diagnostic-trace.mjs');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  let opens = 0;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  t.mock.method(fs, 'lstatSync', () => ({ isSymbolicLink: () => true }));
  t.mock.method(fs, 'openSync', () => { opens += 1; throw new Error('must not open target'); });
  t.mock.method(process.stderr, 'write', () => true);
  syncBuiltinESMExports();
  try {
    assert.equal(appendPrivateDiagnostic('private-destination', {}), false);
    assert.equal(opens, 0, 'reject link/junction before following or chmodding it');
  } finally { Object.defineProperty(process, 'platform', platform); t.mock.restoreAll(); syncBuiltinESMExports(); }
});
