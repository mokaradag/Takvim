/**
 * Rota AI · olguların seçicileri.
 *
 * Her kesin sayı, onu tanımlayan nüfusla (proje, kişi, görev, tarih
 * penceresi, süzgeç) birlikte yazılır; seçiciler kimlikle değil adla
 * görünür. Sınırı aşan sayı kesin sayı gibi sunulmaz; eksik tarih satır
 * eksilmesi sayılmaz.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiStack } from './helpers/aiStack.mjs';
import { ALI_1, AYSE, PROJECTS, TASKS, ZEYNEP, callRotaTool, callRotaTools, rotaToolSeed } from './helpers/aiToolFixtures.mjs';

const { analyzeGroundedAnswer } = await import('../src/domain/ai/evidenceVerification.js');

const stackFor = (t, seed = {}) => createAiStack(t, { sicil: AYSE, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' }, seed: rotaToolSeed(seed) });
const render = (ledger, facts, locale = 'tr') => analyzeGroundedAnswer(JSON.stringify({ kind: 'rota', facts }), { evidenceIds: ledger.ids(), evidencePayloads: ledger.payloads(), locale });
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test('workload counts keep their project and person selectors, so two selections stay distinguishable', async (t) => {
  const stack = stackFor(t);
  const { ledger } = await callRotaTools(stack, AYSE, [['rota_workload_summary', { projectId: PROJECTS.FULL }], ['rota_workload_summary', { projectId: PROJECTS.READ }],
    ['rota_workload_summary', { personSicil: ZEYNEP }]]);
  const verdict = render(ledger, ['R1:data.openTaskCount', 'R2:data.openTaskCount', 'R3:data.openTaskCount']);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  const [first, second, third] = verdict.normalized.split('\n\n');
  assert.match(first, /Radar Modernizasyonu/);
  assert.match(second, /Okuma Projesi/);
  assert.match(third, /Kişi: Zeynep Kaya/);
  assert.doesNotMatch(verdict.normalized, GUID);
});

test('working-day counts always carry their date window', async (t) => {
  const stack = stackFor(t);
  const { ledger } = await callRotaTools(stack, AYSE, [['rota_calendar_inspect', { dateFrom: '2026-10-01', dateTo: '2026-10-31' }],
    ['rota_calendar_inspect', { dateFrom: '2026-11-01', dateTo: '2026-11-30' }]]);
  const verdict = render(ledger, ['R1:data.workingDayCount', 'R2:data.workingDayCount']);
  assert.match(verdict.normalized, /^\*\*1 Ekim 2026\*\* – \*\*31 Ekim 2026\*\* aralığında \*\*21\*\* çalışma günü bulunuyor\. 【R1】$/m);
  assert.match(verdict.normalized, /^\*\*1 Kasım 2026\*\* – \*\*30 Kasım 2026\*\* aralığında \*\*\d+\*\* çalışma günü bulunuyor\. 【R2】$/m);
  const english = render(ledger, ['R1:data.workingDayCount'], 'en');
  assert.match(english.normalized, /Between \*\*1 October 2026\*\* and \*\*31 October 2026\*\* there are \*\*21\*\* working days/);
});

test('data-quality metrics keep the inspected project', async (t) => {
  const stack = stackFor(t);
  const { ledger } = await callRotaTools(stack, AYSE, [['rota_data_quality', { projectId: PROJECTS.FULL }], ['rota_data_quality', { projectId: PROJECTS.READ }]]);
  const verdict = render(ledger, ['R1:data.openTaskCount', 'R2:data.openTaskCount']);
  const [first, second] = verdict.normalized.split('\n\n');
  assert.match(first, /Proje: Radar Modernizasyonu/);
  assert.match(second, /Proje: Okuma Projesi/);
});

test('a task-scoped Outlook zero stays tied to its task', async (t) => {
  const stack = stackFor(t);
  const { result, ledger } = await callRotaTool(stack, AYSE, 'rota_outlook_status', { taskId: TASKS.LITERAL });
  assert.equal(result.data.activeSubscriptions, 0);
  const verdict = render(ledger, ['R1:data.activeSubscriptions']);
  assert.match(verdict.normalized, /\*\*0\*\*/);
  assert.match(verdict.normalized, /Görev: Rapor %50 \\\[özel\\\] \\_alt/);
});

test('workflow selectors render names instead of record identifiers', async (t) => {
  const stack = stackFor(t, { taskScheduleChangeRequests: [{ TaskId: TASKS.OVERDUE, RequesterSicil: ZEYNEP, DecisionOwnerSicil: AYSE, Status: 'PENDING' }] });
  const { result, ledger } = await callRotaTool(stack, AYSE, 'rota_schedule_requests', { projectId: PROJECTS.FULL, taskId: TASKS.OVERDUE });
  assert.equal(result.data.filters.project, 'Radar Modernizasyonu');
  assert.equal(result.data.filters.task, 'Radar test planı');
  const verdict = render(ledger, ['R1:data.counts.awaitingYourDecision']);
  assert.match(verdict.normalized, /Proje: Radar Modernizasyonu; Görev: Radar test planı/);
  assert.doesNotMatch(verdict.normalized, GUID);
  const activity = await callRotaTool(stack, AYSE, 'rota_activity_search', { projectId: PROJECTS.FULL, period: 'last_7_days' });
  const summary = render(activity.ledger, ['R1:data.summary.events']);
  assert.match(summary.normalized, /İlk tarih: 24 Eylül 2026; Son tarih: 30 Eylül 2026/);
  assert.doesNotMatch(summary.normalized, GUID);
});

test('a person\'s organization unit renders the stored unit name, not a lag-unit enum', async (t) => {
  const stack = stackFor(t);
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_person_search', { text: String(ALI_1) });
  const verdict = render(ledger, ['R1:data.people.0.organization.unit']);
  assert.match(verdict.normalized, /K1/);
  assert.doesNotMatch(verdict.normalized, /Bilinmeyen değer/);
});

test('a completed occurrence without an actual finish is incomplete evidence, not a truncated result', async (t) => {
  const stack = stackFor(t);
  stack.db.tasks.find((task) => task.TaskId === TASKS.OCCURRENCE_DONE).ActualFinish = null;
  const { result, ledger } = await callRotaTool(stack, AYSE, 'rota_recurrence_inspect', { taskId: TASKS.SERIES });
  assert.equal(result.data.series.completionDatesComplete, false);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, false);
  assert.ok(ledger.summaries()[0].highlights.length > 0, 'highlights survive when no row was removed');
});

test('highlights are cleared only when the size limit removed rows', async (t) => {
  const stack = stackFor(t);
  const paged = await callRotaTool(stack, AYSE, 'rota_task_search', { projectId: PROJECTS.FULL, status: ['todo'], limit: 1 });
  assert.ok(paged.result.nextCursor);
  assert.ok(paged.ledger.summaries()[0].highlights.length > 0);
  const notifications = await callRotaTool(stack, AYSE, 'rota_notifications');
  assert.equal(notifications.result.truncated, true);
  assert.ok(notifications.ledger.summaries()[0].highlights.length > 0);
});
