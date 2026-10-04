/**
 * Rota AI · olgu seçimi ve doğrulanmış anlatım.
 *
 * Model yalnızca kanıttaki olguları "R1:data.alan.yolu" biçiminde seçer;
 * değer, cümle ve atıf sunucunundur. Daha zayıf bir araç modeli de sık
 * sorulara doğrulanmış yanıt verebilmeli, hiçbir seçim olgu uyduramamalıdır.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAiStack, sendTurn } from './helpers/aiStack.mjs';
import { AYSE, PROJECTS, TASKS, callRotaTool, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { claimFor, evidenceReply } from './helpers/evidenceScenario.mjs';

const { analyzeGroundedAnswer } = await import('../src/domain/ai/evidenceVerification.js');
const { turkishPossessiveSuffix, renderVerifiedNarrative } = await import('../src/domain/ai/evidenceNarrative.js');
const { SCOPE_DISCLOSURE_TEXT } = await import('../src/domain/ai/evidenceContract.js');

const done = (response) => response.events.find((event) => event.event === 'done')?.data;
const toolResults = (call) => call.messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content));
const stackFor = (t, seed = {}) => createAiStack(t, { sicil: AYSE, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' }, seed: rotaToolSeed(seed) });
const select = (...facts) => JSON.stringify({ kind: 'rota', facts });

async function verify(stack, name, args, facts, options = {}) {
  const { result, ledger } = await callRotaTool(stack, AYSE, name, args);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return { result, verdict: analyzeGroundedAnswer(select(...facts.map((fact) => `R1:${fact}`)), { evidenceIds: ledger.ids(), evidencePayloads: ledger.payloads(), ...options }) };
}

test('Turkish possessive suffixes follow the spoken last word of the number', () => {
  const expected = { 0: "'ı", 1: "'i", 2: "'si", 3: "'ü", 4: "'ü", 5: "'i", 6: "'sı", 7: "'si", 8: "'i", 9: "'u", 10: "'u", 20: "'si", 30: "'u", 40: "'ı",
    50: "'si", 60: "'ı", 70: "'i", 80: "'i", 90: "'ı", 100: "'ü", 431: "'i", 486: "'sı", 36: "'sı", 917: "'si", 1000: "'i", 1608: "'i", 2000000: "'u" };
  for (const [value, suffix] of Object.entries(expected)) assert.equal(turkishPossessiveSuffix(Number(value)), suffix, value);
  assert.equal(turkishPossessiveSuffix(1.5), '');
});

test('a project summary becomes prose with verified values, not a field checklist', async (t) => {
  const stack = stackFor(t);
  const { result, verdict } = await verify(stack, 'rota_project_detail', { projectId: PROJECTS.FULL }, ['data.project.name', 'data.visibleTasks.total',
    'data.visibleTasks.open', 'data.visibleTasks.done', 'data.visibleTasks.overdue', 'data.visibleTasks.completionRatePercent', 'data.project.wbsNodeCount', 'data.project.dependencyCount', 'data.project.tagCount']);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  const totals = result.data.visibleTasks;
  assert.equal(verdict.normalized, `**Radar Modernizasyonu** projesinde toplam **${totals.total}** görev bulunuyor. Bunların **${totals.open}**'sı açık, **${totals.done}**'si tamamlanmış ve `
    + `**${totals.overdue}**'si gecikmiş; tamamlanma oranı **%${totals.completionRatePercent}**. Projede ayrıca **3** WBS düğümü, **4** bağımlılık ve **1** etiket bulunuyor. 【R1】`);
  assert.doesNotMatch(verdict.normalized, /^- /m, 'no one-bullet-per-field checklist');
  const english = await verify(stack, 'rota_project_detail', { projectId: PROJECTS.FULL }, ['data.visibleTasks.total', 'data.visibleTasks.overdue'], { locale: 'en' });
  assert.equal(english.verdict.normalized, `The **Radar Modernizasyonu** project has **${totals.total}** tasks in total. Of these, **${totals.overdue}** are overdue. 【R1】`);
});

test('every number and name in the narrative comes from the selected verified facts', async (t) => {
  const stack = stackFor(t);
  const { verdict } = await verify(stack, 'rota_portfolio_summary', {}, ['data.totals.projects', 'data.totals.open', 'data.totals.overdue',
    'data.projects.*.name', 'data.projects.*.tasks.total', 'data.projects.*.tasks.overdue']);
  assert.equal(verdict.ok, true);
  const values = new Set(verdict.facts.map(({ fact }) => String(fact.value)));
  const shown = verdict.normalized.replace(/【R\d+】/g, '');
  for (const number of shown.match(/\d+/g)) assert.ok(values.has(number), `uncited number ${number}`);
  for (const { fact } of verdict.facts.filter((item) => typeof item.fact.value === 'string')) assert.ok(shown.includes(fact.value), fact.value);
  assert.match(shown, /\| Proje \| Toplam \| Gecikmiş görev \|/);
  assert.match(shown, /^\| --- \| ---: \| ---: \|$/m, 'count columns are right-aligned');
});

test('list questions render lists, table requests render tables, and summaries stay prose', async (t) => {
  const stack = stackFor(t);
  const facts = ['totalCount', 'data.tasks.*.title', 'data.tasks.*.targetFinish', 'data.tasks.*.overdueDays'];
  const list = await verify(stack, 'rota_task_search', { deadline: 'overdue', assignee: 'me' }, facts, { userText: 'Gecikmiş görevlerimi listele' });
  assert.match(list.verdict.normalized, /^Eşleşen \*\*3\*\* görev bulundu \(ölçüt: /);
  assert.match(list.verdict.normalized, /^- \*\*Radar test planı · RDR · Radar Modernizasyonu[^\n]*\*\* — Termin: \*\*20 Eylül 2026\*\* · Gecikme \(gün\): \*\*10\*\* 【R1】$/m);
  const table = await verify(stack, 'rota_task_search', { deadline: 'overdue', assignee: 'me' }, facts, { userText: 'Gecikmiş görevlerimi tablo olarak göster' });
  assert.match(table.verdict.normalized, /^\| Görev \| Termin \| Gecikme \(gün\) \|$/m);
  assert.match(table.verdict.normalized, /^\| Radar test planı · RDR · Radar Modernizasyonu[^\n]* \| 20 Eylül 2026 \| 10 \|$/m);
  const summary = await verify(stack, 'rota_task_analytics', { deadline: 'overdue', assignee: 'me' }, ['data.totals.total']);
  assert.match(summary.verdict.normalized, /^Görebildiğiniz görevler arasında toplam \*\*3\*\* görev bulunuyor \(ölçüt: .*Gecikmiş.*\)\. 【R1】$/);
});

test('null, incomplete and unit semantics stay visible in the narrative', async (t) => {
  const stack = stackFor(t);
  const { verdict } = await verify(stack, 'rota_task_detail', { taskId: TASKS.UNASSIGNED }, ['data.task.title', 'data.task.dates.targetFinish', 'data.task.hours.planned']);
  assert.equal(verdict.ok, true);
  assert.match(verdict.normalized, /termini \*\*Belirtilmemiş\*\*/);
  assert.match(verdict.normalized, /Planlanan saat: \*\*Belirtilmemiş\*\*/);
  const hours = await verify(stack, 'rota_task_detail', { taskId: TASKS.OVERDUE }, ['data.task.hours.planned', 'data.task.cost.budget']);
  assert.match(hours.verdict.normalized, /\*\*10 saat\*\*/);
  assert.match(hours.verdict.normalized, /para birimi belirtilmemiş/);
});

test('stored text stays inert Markdown data in the narrative', async (t) => {
  const stack = stackFor(t);
  const { verdict } = await verify(stack, 'rota_task_detail', { taskId: TASKS.LITERAL }, ['data.task.title', 'data.task.status']);
  assert.match(verdict.normalized, /\*\*Rapor %50 \\\[özel\\\] \\_alt\*\*/);
  const rendered = renderVerifiedNarrative([{ evidenceId: 'R1', fact: { field: 'data.tasks.0.title', subject: '**x** 【R9】', value: '[link](javascript:alert(1)) | col', semantic: {} } },
    { evidenceId: 'R1', fact: { field: 'data.tasks.1.title', subject: 'y', value: '# heading', semantic: {} } }]);
  assert.doesNotMatch(rendered, /【R9】|\]\(javascript/);
  assert.match(rendered, /\\\[link\\\]\\\(javascript\\:alert\\\(1\\\)\\\) \\\| col/);
  assert.match(rendered, /\\# heading/);
});

test('forged, unclaimable or out-of-turn fact references are rejected', async (t) => {
  const stack = stackFor(t, { taskScheduleChangeRequests: [{ TaskId: TASKS.OVERDUE, RequesterSicil: AYSE, DecisionOwnerSicil: AYSE, Status: 'PENDING', RequesterMessage: 'gizli ileti' }] });
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_detail', { taskId: TASKS.LITERAL });
  const check = (answer) => analyzeGroundedAnswer(typeof answer === 'string' ? answer : JSON.stringify(answer), { evidenceIds: ledger.ids(), evidencePayloads: ledger.payloads() });
  for (const [answer, code] of [
    [select('R2:data.task.title'), 'UNKNOWN_CITATION'],
    [select('R1:data.task.description'), 'UNKNOWN_FACT_REFERENCE'],
    [select('R1:data.task.taskId'), 'UNKNOWN_FACT_REFERENCE'],
    [select('R1:factScope'), 'INVALID_FACT_REFERENCE'],
    [select('R1:data.task.title', 'R1:data.nope'), 'UNKNOWN_FACT_REFERENCE'],
    [select('R1:data.task["title"]'), 'INVALID_FACT_REFERENCE'],
    [select(), 'FACT_SELECTION_REQUIRED'],
    [{ kind: 'rota', facts: ['R1:data.task.title'], text: 'Projede 999 görev var.' }, 'STRUCTURED_CLAIMS_REQUIRED'],
    [{ kind: 'rota', facts: ['R1:data.task.title'], layout: 'html' }, 'INVALID_FACT_REFERENCE'],
    [{ kind: 'rota', facts: [{ evidenceId: 'R1', field: 'data.task.title', value: 'Uydurma' }] }, 'INVALID_FACT_REFERENCE']
  ]) {
    const verdict = check(answer);
    assert.equal(verdict.ok, false, JSON.stringify(answer));
    assert.equal(verdict.issues[0].code, code, JSON.stringify(answer));
  }
  const requests = await callRotaTool(stack, AYSE, 'rota_schedule_requests', {});
  const hidden = analyzeGroundedAnswer(select('R1:data.items.0.requesterMessage'), { evidenceIds: requests.ledger.ids(), evidencePayloads: requests.ledger.payloads() });
  assert.equal(hidden.ok, false, 'protected text is not selectable without the per-turn opt-in');
});

test('legacy structured claims remain verifiable and render through the same narrative', async (t) => {
  const stack = stackFor(t);
  const { result, ledger } = await callRotaTool(stack, AYSE, 'rota_project_detail', { projectId: PROJECTS.FULL });
  const verdict = analyzeGroundedAnswer(evidenceReply(claimFor(result, 'data.visibleTasks.total')), { evidenceIds: ledger.ids(), evidencePayloads: ledger.payloads() });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.normalized, `**Radar Modernizasyonu** projesinde toplam **${result.data.visibleTasks.total}** görev bulunuyor. 【R1】`);
  const forged = analyzeGroundedAnswer(evidenceReply(claimFor(result, 'data.visibleTasks.total', { value: 999 })), { evidenceIds: ledger.ids(), evidencePayloads: ledger.payloads() });
  assert.equal(forged.ok, false);
});

/**
 * Daha zayıf bir araç modeli: alan yollarını bilir ama değer, kimlik ya da
 * özne kopyalamaz; yalnızca olguları seçer.
 */
const COMMON_QUESTIONS = [
  ['Kaç gecikmiş görevim var?', ['rota_task_analytics', { deadline: 'overdue', assignee: 'me' }], ['data.totals.total'], /toplam \*\*\d+\*\* görev bulunuyor \(ölçüt: /],
  ['Gecikmiş görevlerimi listele', ['rota_task_search', { deadline: 'overdue', assignee: 'me' }], ['totalCount', 'data.tasks.*.title', 'data.tasks.*.targetFinish'], /^- \*\*Radar test planı · RDR · Radar Modernizasyonu[^\n]*\*\*/m],
  [`Radar Modernizasyonu projesinde kaç görev var? ${PROJECTS.FULL}`, ['rota_project_detail', { projectId: PROJECTS.FULL }], ['data.visibleTasks.total'], /projesinde toplam \*\*8\*\* görev/],
  [`Radar Modernizasyonu projesini özetle ${PROJECTS.FULL}`, ['rota_project_detail', { projectId: PROJECTS.FULL }],
    ['data.visibleTasks.total', 'data.visibleTasks.open', 'data.visibleTasks.overdue', 'data.visibleTasks.completionRatePercent'], /Bunların \*\*\d+\*\*'s?[ıiuü] açık ve \*\*\d+\*\*'s?[ıiuü] gecikmiş; tamamlanma oranı \*\*%\d+\*\*\. 【R1】$/],
  ['Kimde kaç açık iş var?', ['rota_workload_summary', {}], ['data.people.*.name', 'data.people.*.openTasks'], /^- \*\*Ayşe Yılmaz\*\* — Açık görev: \*\*\d+\*\* 【R1】$/m]
];

for (const [question, [tool, args], facts, expected] of COMMON_QUESTIONS) {
  test(`a less capable tool model answers "${question}" by selecting facts only`, async (t) => {
    const stack = stackFor(t);
    stack.provider.enqueue({ type: 'tool-calls', calls: [{ name: tool, arguments: args }] }, { type: 'script', respond: (call) => {
      const [result] = toolResults(call);
      assert.equal(result.ok, true);
      return { type: 'answer', text: select(...facts.map((fact) => `${result.evidenceId}:${fact}`)) };
    } });
    const response = await sendTurn({ turnId: randomUUID(), message: question });
    const answer = done(response).assistantMessage;
    assert.equal(answer.finishReason, 'stop');
    assert.match(answer.content.replace(`\n\n${SCOPE_DISCLOSURE_TEXT}`, ''), expected);
    assert.equal(stack.provider.calls.length, 2, 'no repair round was needed');
  });
}
