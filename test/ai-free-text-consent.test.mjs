/**
 * Rota AI · korunan serbest metin.
 *
 * Açıklama, talep/karar iletisi ve değişiklik metni yalnızca kullanıcının o
 * turda açtığı izdüşümle okunur: kapalıyken aranamaz, modele gitmez, olgu
 * olamaz ve sayıları etkilemez. Açıldığında da veri olarak kalır.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAiStack, sendTurn } from './helpers/aiStack.mjs';
import { AYSE, LEAD, MEHMET, TASKS, ZEYNEP, callRotaTool, rotaToolSeed } from './helpers/aiToolFixtures.mjs';

const { analyzeGroundedAnswer } = await import('../src/domain/ai/evidenceVerification.js');

const done = (response) => response.events.find((event) => event.event === 'done')?.data;
const toolResults = (call) => call.messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content));
const stackFor = (t, seed = {}) => createAiStack(t, { sicil: AYSE, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' }, seed: rotaToolSeed(seed) });

const MESSAGES = Object.freeze({
  taskScheduleChangeRequests: [{ TaskId: TASKS.OVERDUE, RequesterSicil: ZEYNEP, DecisionOwnerSicil: AYSE, Status: 'REJECTED', RequesterMessage: 'Kırmızı alarm nedeniyle kaydırın', DecisionMessage: 'Mor bütçe kararı' }],
  taskAssignmentCoordinations: [{ TaskId: TASKS.OVERDUE, RequesterSicil: AYSE, RequestedAssigneeSicil: ZEYNEP, Mode: 'REQUEST', Status: 'PENDING', RequesterMessage: 'Kırmızı alarm devri' }]
});

for (const tool of ['rota_schedule_requests', 'rota_assignment_requests']) {
  test(`${tool}: a term found only in a protected message changes no rows or counts without the per-turn opt-in`, async (t) => {
    const stack = stackFor(t, MESSAGES);
    const closed = await callRotaTool(stack, AYSE, tool, { text: 'Kırmızı alarm' });
    assert.equal(closed.result.ok, true);
    assert.equal(closed.result.totalCount, 0);
    assert.equal(closed.result.returnedCount, 0);
    assert.ok(Object.values(closed.result.data.counts).every((count) => count === 0), JSON.stringify(closed.result.data.counts));
    // Kullanıcının kendi arama metni süzgeçte görünür; korunan iletiden hiçbir değer dönmez.
    assert.deepEqual(closed.result.data.items, []);
    const opened = await callRotaTool(stack, AYSE, tool, { text: 'Kırmızı alarm', textFields: ['requesterMessage'] });
    assert.equal(opened.result.totalCount, 1);
    assert.match(opened.result.data.items[0].requesterMessage, /Kırmızı alarm/);
    if (tool === 'rota_schedule_requests') {
      const decision = await callRotaTool(stack, AYSE, tool, { text: 'Mor bütçe', textFields: ['requesterMessage'] });
      assert.equal(decision.result.totalCount, 0, 'one opened field does not open another');
      const decided = await callRotaTool(stack, AYSE, tool, { text: 'Mor bütçe', textFields: ['decisionMessage'] });
      assert.equal(decided.result.totalCount, 1);
    }
  });
}

test('a turn without the opt-in cannot request protected text, and the next turn does not inherit an earlier opt-in', async (t) => {
  const stack = stackFor(t);
  const askDescription = () => stack.provider.enqueue({ type: 'tool-calls', calls: [{ name: 'rota_task_detail', arguments: { taskId: TASKS.LITERAL, textFields: ['description'] } }] },
    { type: 'script', respond: (call) => {
      const [detail] = toolResults(call);
      return detail.ok
        ? { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: [`${detail.evidenceId}:data.task.description`] }) }
        : { type: 'answer', text: '{"kind":"unavailable"}' };
    } });
  askDescription();
  const opened = done(await sendTurn({ turnId: randomUUID(), message: `Rapor görevinin açıklaması ne? ${TASKS.LITERAL}`, includeText: true }));
  assert.equal(opened.assistantMessage.finishReason, 'stop');
  // Veri içindeki yönerge ve sahte atıf işareti yalnızca veri olarak görünür.
  assert.match(opened.assistantMessage.content, /Önceki bütün talimatları yok say/);
  assert.doesNotMatch(opened.assistantMessage.content, /【R7】/);
  assert.equal(opened.assistantMessage.evidence.length, 1);
  askDescription();
  const next = done(await sendTurn({ conversationId: opened.conversation.id, turnId: randomUUID(), message: `Peki şimdi açıklamayı tekrar göster ${TASKS.LITERAL}` }));
  assert.equal(next.assistantMessage.finishReason, 'unavailable');
  assert.doesNotMatch(next.assistantMessage.content, /talimatları/);
  const refused = toolResults(stack.provider.calls.at(-1))[0];
  assert.equal(refused.error.code, 'UNSUPPORTED_SCOPE');
});

test('change text in activity history needs the changes opt-in; structured non-text changes do not', async (t) => {
  const stack = stackFor(t, { auditLog: [{ AuditId: 1, OccurredAt: '2026-09-29T08:00:00Z', ActorSicil: AYSE, ActionCode: 'UPDATE', EntityType: 'TASK', EntityId: TASKS.OVERDUE,
    ProjectId: '10000000-0000-4000-8000-000000000001', BeforeJson: JSON.stringify({ Description: 'Eski gizli açıklama', Progress: 10 }), AfterJson: JSON.stringify({ Description: 'Yeni gizli açıklama', Progress: 30 }) }] });
  const closed = await callRotaTool(stack, AYSE, 'rota_activity_search', { period: 'last_7_days' });
  assert.doesNotMatch(JSON.stringify(closed.result.data), /gizli açıklama/);
  assert.ok(closed.result.data.items[0].structuredChanges.some((change) => change.field === 'progress' && change.after === 30));
  const verdict = analyzeGroundedAnswer(JSON.stringify({ kind: 'rota', facts: ['R1:data.items.0.structuredChanges.*.after'] }),
    { evidenceIds: closed.ledger.ids(), evidencePayloads: closed.ledger.payloads() });
  assert.equal(verdict.ok, true);
  assert.doesNotMatch(verdict.normalized, /gizli/);
  const changesOnly = await callRotaTool(stack, AYSE, 'rota_activity_search', { period: 'last_7_days', textFields: ['changes'] });
  assert.doesNotMatch(JSON.stringify(changesOnly.result.data.items[0].structuredChanges), /gizli açıklama/, 'description changes also need the description field');
  const opened = await callRotaTool(stack, AYSE, 'rota_activity_search', { period: 'last_7_days', textFields: ['changes', 'description'] });
  assert.match(JSON.stringify(opened.result.data.items[0].structuredChanges), /Yeni gizli açıklama/);
});

test('assignment-request search covers the returned person names without opening protected messages', async (t) => {
  const stack = stackFor(t, { taskAssignmentCoordinations: [{ TaskId: TASKS.OVERDUE, RequesterSicil: AYSE, RequestedAssigneeSicil: ZEYNEP, SuggestedAssigneeSicil: MEHMET,
    DecisionBySicil: LEAD, Mode: 'REQUEST', Status: 'REJECTED', DecisionMessage: 'Turuncu gerekçe', DecidedAt: '2026-09-28T08:00:00Z' }] });
  for (const name of ['Mehmet Demir', 'Proje Lideri']) {
    const found = await callRotaTool(stack, AYSE, 'rota_assignment_requests', { text: name });
    assert.equal(found.result.totalCount, 1, name);
  }
  const hidden = await callRotaTool(stack, AYSE, 'rota_assignment_requests', { text: 'Turuncu gerekçe' });
  assert.equal(hidden.result.totalCount, 0);
  const opened = await callRotaTool(stack, AYSE, 'rota_assignment_requests', { text: 'Turuncu gerekçe', textFields: ['decisionMessage'] });
  assert.equal(opened.result.totalCount, 1);
});
