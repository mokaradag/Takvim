/**
 * Rota AI · model turu bütçesi ve sunucu seçimi.
 *
 * Bildirilen istek kanıttaki olguları tek anlamlı belirliyorsa yanıtı sunucu
 * seçer: "Kaç gecikmiş görevim var ve hangileri?" Standart ve Derin kipte tek
 * model turuyla biter; seçim, düzeltme ya da devir turu yoktur. Hızlı yol
 * doğrulamayı, güncel yetki yoklamasını ve kapsam notunu atlamaz; birden çok
 * doğrulanan seçimde model yoluna döner. Sınamalar duvar saatini değil, model
 * turlarını, araç çağrılarını ve içeriksiz tur izini ölçer.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { captureConsole, createAiStack, DEFAULT_KEY, sendTurn } from './helpers/aiStack.mjs';
import { AYSE, callRotaTool, LEAD, NOW, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { declared } from './helpers/evidenceScenario.mjs';
import { verifyRequested } from './helpers/requestScenario.mjs';

const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
const { aiTelemetrySnapshot } = await import('../src/server/ai/aiTelemetry.js');
const { groundedSystemPrompt } = await import('../src/server/ai/assistant/groundedPrompt.js');
const { SCOPE_DISCLOSURE_TEXT } = await import('../src/domain/ai/evidenceContract.js');

const PROFILES = { standard: 'chat.tools', deep: 'chat.tools.reasoning' };
const QUESTION = 'Kaç gecikmiş görevim var ve hangileri?';
// İstemdeki örnek bildirim ve araç çağrısı: model bunu izler, sunucu tek turda yanıtlar.
const example = groundedSystemPrompt(new Date(NOW)).match(/örn\. (\{.*\}) ve rota_task_search (\{.*?\})\./);
const OVERDUE_LIST = JSON.parse(example[1]);
const OVERDUE_MINE = JSON.parse(example[2]);

const doneOf = (response) => response.events.find((event) => event.event === 'done')?.data;
const searchOverdue = (preface = [declared(OVERDUE_LIST)], args = OVERDUE_MINE) => ({ type: 'tool-calls', preface, calls: [{ name: 'rota_task_search', arguments: args }] });
const turnTraces = (lines) => lines.filter((line) => line.includes('"operation":"ai.grounded.turn"')).map((line) => JSON.parse(line.slice(line.indexOf('{'))));
const visibilityReads = (stack) => stack.db.aiToolLog.filter((entry) => entry.query === 'task-visibility').length;
const issue = (verdict) => verdict.issues[0]?.code ?? null;

function stackFor(t, sicil = AYSE) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  return createAiStack(t, { sicil, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' }, seed: rotaToolSeed() });
}

for (const mode of ['standard', 'deep']) {
  test(`"${QUESTION}" ends in one ${mode} model round: the server selects the declared facts and keeps every check`, async (t) => {
    const stack = stackFor(t);
    const logs = captureConsole(t);
    const profile = DEFAULT_AI_MODEL_REGISTRY.profiles[PROFILES[mode]];
    stack.provider.enqueue(searchOverdue());
    const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION, mode })).assistantMessage;
    assert.deepEqual(stack.provider.calls.map((call) => [call.model, call.maxOutputTokens]), [[profile.model, profile.maxOutputTokens]],
      'tek model turu; seçim, düzeltme ya da devir turu yok');
    assert.equal(answer.finishReason, 'stop');
    assert.equal(answer.mode, mode);
    assert.match(answer.content, /^Eşleşen \*\*3\*\* görev bulundu \(ölçüt: Termin: Gecikmiş; Sorumlu: Ben\)\. 【R1】/);
    assert.equal(answer.content.split('\n').filter((line) => /^- \*\*.+\*\* — Termin: \*\*.+\*\* 【R1】$/.test(line)).length, 3);
    assert.ok(answer.content.endsWith(`\n\n${SCOPE_DISCLOSURE_TEXT}`), 'kısmi kapsam notu sunucu seçiminde de eklenir');
    assert.deepEqual(answer.evidence.map((item) => item.id), ['R1']);
    assert.equal(stack.db.aiMessageEvidence.length, 1);
    assert.equal(visibilityReads(stack), 2, 'güncel görünürlük çizimden önce ve kayıttan sonra yeniden okunur');

    const [trace] = turnTraces(logs);
    const { rounds, ...counters } = trace.context;
    assert.deepEqual(Object.keys(counters).sort(), ['code', 'declarations', 'escalated', 'modelRounds', 'outcome', 'repairs', 'resultBytes', 'revalidationMs',
      'scopeLoads', 'selectedBy', 'sqlMs', 'sqlQueries', 'toolCalls', 'toolFailures', 'toolRounds', 'verificationMs']);
    assert.deepEqual({ outcome: counters.outcome, selectedBy: counters.selectedBy, escalated: counters.escalated, modelRounds: counters.modelRounds,
      toolRounds: counters.toolRounds, toolCalls: counters.toolCalls, declarations: counters.declarations, repairs: counters.repairs },
    { outcome: 'grounded', selectedBy: 'server', escalated: false, modelRounds: 1, toolRounds: 1, toolCalls: 1, declarations: 1, repairs: 0 });
    assert.deepEqual(rounds.map(({ purpose, profile: name, model, budget, finish, calls }) => ({ purpose, name, model, budget, finish, calls })),
      [{ purpose: 'plan', name: PROFILES[mode], model: profile.model, budget: profile.maxOutputTokens, finish: 'tool_calls', calls: 1 }]);
    // İz yalnızca sayaç, süre ve profil adı taşır: soru, kayıt, kimlik ya da anahtar yazılmaz.
    const line = logs.find((text) => text.includes('"operation":"ai.grounded.turn"'));
    for (const secret of [QUESTION, 'Radar test planı', 'Haftalık durum toplantısı', 'Kısmi kendi görevim', String(AYSE), DEFAULT_KEY, '【R1】', 'overdue']) {
      assert.equal(line.includes(secret), false, `tur izi içerik taşımaz: ${secret}`);
    }
    const { grounding } = aiTelemetrySnapshot();
    assert.equal(grounding.serverSelected, 1);
    assert.equal(grounding.repaired, 0);
    assert.equal(grounding.escalations.total, 0);
  });
}

test('a separate or a missing declaration costs one extra model round, never a selection round', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  // Ayrı bildirim: bildirim turu ve araç turu.
  stack.provider.enqueue({ type: 'answer', text: declared(OVERDUE_LIST) }, searchOverdue([]));
  assert.equal(doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION })).assistantMessage.finishReason, 'stop');
  // Bildirimsiz çağrı çalışmaz; düzeltmeden sonra çağrı bildirimle yinelenir.
  stack.provider.enqueue(searchOverdue([]), searchOverdue());
  assert.equal(doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION })).assistantMessage.finishReason, 'stop');
  assert.equal(stack.provider.calls.length, 4);
  assert.deepEqual(turnTraces(logs).map(({ context }) => [context.selectedBy, context.toolCalls, context.rounds.map((round) => round.purpose)]),
    [['server', 1, ['plan', 'tools']], ['server', 1, ['plan', 'declaration']]]);
});

test('an empty overdue population is answered from its complete first page in one model round', async (t) => {
  const stack = stackFor(t, LEAD);
  stack.provider.enqueue(searchOverdue());
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION })).assistantMessage;
  assert.equal(stack.provider.calls.length, 1);
  assert.equal(answer.finishReason, 'stop');
  assert.match(answer.content, /^Eşleşen \*\*0\*\* görev bulundu/);
  assert.equal(answer.content.includes('\n- '), false, 'boş nüfusta satır yazılmaz');
});

test('an empty population satisfies the listed row field only through its declared, complete count', async (t) => {
  const stack = stackFor(t, LEAD);
  const { ledger, result } = await callRotaTool(stack, LEAD, 'rota_task_search', OVERDUE_MINE);
  assert.deepEqual([result.totalCount, result.data.tasks.length, result.complete, result.truncated], [0, 0, true, false]);
  assert.equal(issue(verifyRequested(ledger, ['R1:totalCount'], OVERDUE_LIST)), null);
  assert.equal(issue(verifyRequested(ledger, ['R1:complete'], OVERDUE_LIST)), 'METRIC_MISSING', 'sayım olgusu olmadan boşluk iddia edilemez');
  assert.equal(issue(verifyRequested(ledger, ['R1:totalCount'], { ...OVERDUE_LIST, metrics: ['tasks.total'] })), 'LIST_ROWS_REQUIRED',
    'satır alanı bildirilmeyen liste yine satır ister');
  assert.equal(issue(verifyRequested(ledger, ['R1:totalCount'], { ...OVERDUE_LIST, filters: { assignee: 'me' } })), 'POPULATION_MISMATCH');
  // Boş olmayan nüfusta sayım satırların yerine geçmez.
  const overdue = { deadline: 'overdue' };
  const filled = await callRotaTool(stack, LEAD, 'rota_task_search', overdue);
  assert.ok(filled.result.data.tasks.length > 0);
  assert.equal(issue(verifyRequested(filled.ledger, ['R1:totalCount'], { ...OVERDUE_LIST, filters: overdue })), 'METRIC_MISSING');
  assert.equal(issue(verifyRequested(filled.ledger, ['R1:totalCount', 'R1:data.tasks.*.title', 'R1:data.tasks.*.targetFinish'], { ...OVERDUE_LIST, filters: overdue })), null);
});

test('the server never chooses between two verifying selections: the model selects in the next round', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  stack.provider.enqueue({ type: 'tool-calls', preface: [declared(OVERDUE_LIST)], calls: [{ name: 'rota_task_search', arguments: OVERDUE_MINE },
    { name: 'rota_task_search', arguments: { ...OVERDUE_MINE, limit: 25 } }] },
  { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: ['R2:totalCount', 'R2:data.tasks.*.title', 'R2:data.tasks.*.targetFinish'] }) });
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION })).assistantMessage;
  assert.equal(stack.provider.calls.length, 2);
  assert.equal(stack.provider.calls[1].messages.filter((message) => message.role === 'tool').length, 2, 'model seçimden önce iki kanıtı da görür');
  assert.equal(answer.finishReason, 'stop');
  assert.deepEqual(answer.evidence.map((item) => item.id), ['R2']);
  const [trace] = turnTraces(logs);
  assert.deepEqual([trace.context.selectedBy, trace.context.rounds.map((round) => round.purpose)], ['model', ['plan', 'follow-up']]);
  assert.equal(aiTelemetrySnapshot().grounding.serverSelected, 0);
});
