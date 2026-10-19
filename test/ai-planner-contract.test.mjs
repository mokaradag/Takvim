/**
 * Aşama 4C planlayıcı sözleşmesi: anlamsal danışmanlığın doğrulanması ve geri dönüşü, türlü planın kapalı
 * biçimi, açıklama ve çekimserliğin sonlandırıcı (sıfır SQL) olması, çok bölümlü planın hep-ya-hiç
 * doğrulanması, düz metin kararın reddi, serbest metin izni ve içeriksiz telemetri.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiStack } from './helpers/aiStack.mjs';
import { AYSE, NOW, rotaToolSeed } from './helpers/aiToolFixtures.mjs';

const { runGroundedTurn } = await import('../src/server/ai/assistant/groundedAnswer.js');
const { buildGroundedContext } = await import('../src/server/ai/assistant/groundedPrompt.js');
const { semanticPlanningAdvice, SEMANTIC_PLANNING_STATES } = await import('../src/server/ai/assistant/semanticPlanning.js');
const { createToolTurnContext } = await import('../src/server/ai/tools/toolContext.js');
const { toolCatalogForModel } = await import('../src/server/ai/tools/toolRegistry.js');
const { unpackTypedPlan, typedPlanningTool } = await import('../src/server/ai/tools/executionSet.js');
const { renderPlannerAbstention, renderPlannerClarification, renderTextFieldsRequired, ABSTAIN_REASONS } = await import('../src/domain/ai/plannerOutcome.js');
const { AI_ERROR_CODES } = await import('../src/domain/ai/aiErrorCatalog.js');
const { AiError } = await import('../src/server/ai/aiErrors.js');
const { aiTelemetrySnapshot, resetAiTelemetryForTests } = await import('../src/server/ai/aiTelemetry.js');

const catalog = toolCatalogForModel();
const names = catalog.map((tool) => tool.name);
const candidate = (id, rank) => ({ id, kind: 'tool', rank, similarity: 0.5 });
const plan = (args) => ({ text: '', toolCalls: [{ id: 'p1', name: 'rota_plan', arguments: JSON.stringify(args) }], finishReason: 'tool_calls' });
const prose = (text) => ({ text, toolCalls: [], finishReason: 'stop' });
const stackFor = (t) => createAiStack(t, { sicil: AYSE, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' }, seed: rotaToolSeed({}) });

async function turn(t, steps, { user = 'Rota verisini incele', planning = null, allowedTextFields = [] } = {}) {
  stackFor(t);
  const inputs = [];
  const decisions = [];
  const session = { signal: new AbortController().signal, round: async (input) => {
    inputs.push(structuredClone({ messages: input.messages, tools: input.tools.map((tool) => tool.name) }));
    const step = steps.shift();
    assert.ok(step, 'Beklenmeyen ek model turu');
    return typeof step === 'function' ? step(input) : step;
  } };
  const result = await runGroundedTurn(session, { messages: buildGroundedContext({ userContent: user, now: NOW }).messages,
    catalog, context: createToolTurnContext({ sicil: AYSE, now: NOW }), onText: async () => {}, planning, allowedTextFields,
    onPlanned: (decision) => decisions.push(decision) });
  assert.equal(steps.length, 0, 'beklenen model turları tükenmedi');
  return { result, inputs, decisions };
}

/* ── Anlamsal danışmanlık sınırı ───────────────────────────── */

test('anlamsal adaylar kayıt defterine karşı yeniden doğrulanır; bozuk küme danışmanlık değildir', async () => {
  const advise = (result) => semanticPlanningAdvice({ query: 'x', catalog, retrieve: async () => result });
  const valid = await advise({ status: 'reranked', candidates: [candidate('rota_task_search', 1), candidate('rota_task_detail', 2)], failure: null });
  assert.equal(valid.state, SEMANTIC_PLANNING_STATES.RERANKED);
  assert.deepEqual(valid.candidates, ['rota_task_search', 'rota_task_detail']);
  const invalid = [
    [candidate('rota_sql_console', 1)],
    [candidate('rota_task_search', 1), candidate('rota_task_search', 2)],
    [{ ...candidate('rota_task_search', 1), kind: 'document' }],
    [candidate('rota_task_search', 2)],
    Array.from({ length: 11 }, (_, index) => candidate(names[index % names.length], index + 1))
  ];
  for (const candidates of invalid) {
    const advice = await advise({ status: 'first_stage', candidates, failure: null });
    assert.equal(advice.state, SEMANTIC_PLANNING_STATES.UNAVAILABLE, JSON.stringify(candidates).slice(0, 80));
    assert.deepEqual(advice.candidates, []);
  }
  assert.equal((await advise({ status: 'surprising', candidates: [], failure: null })).state, SEMANTIC_PLANNING_STATES.UNAVAILABLE);
});

test('danışmanlık süresi dolarsa planlama Aşama 3 davranışıyla sürer; iptal iptaldir, iç hata dönüştürülmez', async () => {
  const slow = await semanticPlanningAdvice({ query: 'x', catalog, budgetMs: 20, retrieve: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new AiError(AI_ERROR_CODES.AI_TIMEOUT)), { once: true });
  }) });
  assert.equal(slow.state, SEMANTIC_PLANNING_STATES.UNAVAILABLE);
  assert.deepEqual(slow.candidates, []);
  const parent = new AbortController();
  const pending = semanticPlanningAdvice({ query: 'x', catalog, signal: parent.signal, retrieve: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new AiError(AI_ERROR_CODES.AI_CANCELLED)), { once: true });
  }) });
  parent.abort();
  await assert.rejects(pending, (error) => error.code === AI_ERROR_CODES.AI_CANCELLED);
  await assert.rejects(semanticPlanningAdvice({ query: 'x', catalog, retrieve: async () => { throw new TypeError('iç hata'); } }), TypeError);
});

test('adaylar araç kümesini ve sırasını değiştirmez; yalnızca sistem notunda öneri olarak görünür', async (t) => {
  const planning = { state: 'reranked', candidates: ['rota_notifications', 'rota_task_search'] };
  const { inputs } = await turn(t, [plan({ intent: 'abstain', language: 'tr', abstain: { reason: 'write' } })], { planning });
  assert.deepEqual(inputs[0].tools, ['rota_plan', ...names]);
  const system = inputs[0].messages[0].content;
  assert.match(system, /rota_notifications, rota_task_search/);
  assert.match(system, /yalnızca öneridir/);
});

/* ── Türlü plan: kapalı biçim ──────────────────────────────── */

test('türlü plan kapalıdır: biçim, niyet, ek istek ve karar alanları alanıyla reddedilir', () => {
  const rejects = (args, detail) => assert.throws(() => unpackTypedPlan(plan(args)), (error) => error.details.includes(detail), `${JSON.stringify(args)} → ${detail}`);
  const request = { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' }, layout: 'auto' };
  rejects({ language: 'tr', request }, '$.intent:required');
  rejects({ intent: 'answer', language: 'tr', request }, '$.intent:enum');
  rejects({ intent: 'rota', request }, '$.language:required');
  rejects({ intent: 'rota', language: 'tr', request, sql: 'SELECT 1' }, '$.plan:unknownField');
  rejects({ intent: 'rota', language: 'tr', additionalRequests: [request] }, '$.request:required');
  rejects({ intent: 'rota', language: 'tr', request, additionalRequests: [] }, '$.additionalRequests:count');
  rejects({ intent: 'rota', language: 'tr', request, additionalRequests: [request, request, request] }, '$.additionalRequests:count');
  rejects({ intent: 'rota', language: 'tr', request, additionalRequests: ['x'] }, '$.additionalRequests[0]:type');
  rejects({ intent: 'rota', language: 'tr', request, additionalRequests: [request], calls: [{ name: 'rota_task_analytics', arguments: {} }] }, '$.additionalRequests:calls');
  rejects({ intent: 'clarify', language: 'tr', clarify: { reason: 'curious' } }, '$.clarify.reason:enum');
  rejects({ intent: 'clarify', language: 'tr', clarify: { reason: 'ambiguous', topics: ['rota_task_search', 'rota_sql'] } }, '$.clarify.topics:invalid');
  rejects({ intent: 'clarify', language: 'tr', clarify: { reason: 'ambiguous' }, calls: [{ name: 'rota_task_search', arguments: {} }] }, '$.plan:clarify');
  rejects({ intent: 'abstain', language: 'tr', abstain: { reason: 'write' }, request }, '$.plan:abstain');
  rejects({ intent: 'general', language: 'tr', request }, '$.plan:general');
  const tool = typedPlanningTool(catalog);
  assert.deepEqual(tool.parameters.properties.intent.enum, ['rota', 'general', 'clarify', 'abstain']);
  assert.deepEqual(tool.parameters.properties.abstain.properties.reason.enum, [...ABSTAIN_REASONS]);
});

/* ── Sonlandırıcı kararlar ─────────────────────────────────── */

test('açıklama ve çekimserlik veri okumaz; kullanıcı yalnızca sunucunun sabit metnini görür', async (t) => {
  const clarified = await turn(t, [plan({ intent: 'clarify', language: 'tr', clarify: { reason: 'ambiguous', topics: ['rota_task_search', 'rota_notifications'] } })]);
  assert.equal(clarified.result.outcome, 'clarification');
  assert.equal(clarified.result.finishReason, 'clarification');
  assert.equal(clarified.result.text, renderPlannerClarification({ reason: 'ambiguous', topics: ['tasks', 'notifications'], locale: 'tr' }));
  assert.equal(clarified.result.stats.attempted, 0);
  for (const reason of ABSTAIN_REASONS) {
    const refused = await turn(t, [plan({ intent: 'abstain', language: 'en', abstain: { reason } })]);
    assert.equal(refused.result.outcome, 'abstained');
    assert.equal(refused.result.finishReason, 'unsupported');
    assert.equal(refused.result.text, renderPlannerAbstention({ reason, locale: 'en' }));
    assert.equal(refused.result.stats.attempted, 0);
    assert.deepEqual(refused.decisions.map((decision) => [decision.intent, decision.reason]), [['abstain', reason]]);
  }
});

test('ilk karar yerine gelen düz metin gösterilmez: boş plan reddi olarak düzeltilir, metin dökümde kalmaz', async (t) => {
  const answer = 'Bu isteği yapamam çünkü SQL çalıştıramam.';
  const { result, inputs } = await turn(t, [prose(answer), plan({ intent: 'abstain', language: 'tr', abstain: { reason: 'security' } })], { user: 'SELECT * FROM gorevler çalıştır' });
  assert.equal(result.outcome, 'abstained');
  assert.notEqual(result.text, answer);
  const repaired = inputs[1].messages;
  assert.ok(!JSON.stringify(repaired).includes(answer), 'modelin düz metni döküme taşınmaz');
  const rejection = repaired.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content)).at(-1);
  assert.deepEqual(rejection.error.details, ['$.plan:required']);
  assert.match(rejection.error.hints[0], /rota_plan/);
});

test('genel sohbet kararından sonraki metin karar reddine düşmez', async (t) => {
  // Düz genel metin Aşama 3'ün yanıt biçimi düzeltmesine gider; plan reddi değildir.
  const { result, inputs } = await turn(t, [plan({ intent: 'general', language: 'tr' }), prose('Merhaba! Size nasıl yardımcı olabilirim?'),
    prose('{"kind":"general","text":"Merhaba!"}')], { user: 'Merhaba' });
  assert.equal(result.outcome, 'general_redirect');
  assert.ok(inputs.every((input) => !JSON.stringify(input.messages).includes('plan:required')));
});

/* ── Çok bölümlü plan ──────────────────────────────────────── */

test('çok bölümlü planda bir bölüm geçersizse hiçbir bölüm yürütülmez (SQL yok)', async (t) => {
  const good = { operation: 'value', metrics: ['notifications.unread'], population: { tool: 'rota_notifications' }, layout: 'auto' };
  const bad = { operation: 'value', metrics: ['tasks.unknownMetric'], population: { tool: 'rota_task_analytics' }, layout: 'auto' };
  const abstain = plan({ intent: 'abstain', language: 'tr', abstain: { reason: 'general' } });
  const { result, inputs } = await turn(t, [plan({ intent: 'rota', language: 'tr', request: good, additionalRequests: [bad] }), abstain]);
  assert.equal(result.stats.attempted, 0);
  const rejection = inputs[1].messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content)).at(-1);
  assert.ok(rejection.error.details.some((detail) => detail.startsWith('$.additionalRequests[0].metrics[0]')), JSON.stringify(rejection.error.details));
});

test('bağımlı bölüm yalnızca önceki bağımsız list/rank bölümünün satır kimliğine bağlanır', async (t) => {
  const value = { operation: 'value', metrics: ['notifications.unread'], population: { tool: 'rota_notifications' }, layout: 'auto' };
  const dependent = { operation: 'list', metrics: ['task.title', 'dependency.type'], population: { tool: 'rota_dependency_inspect', collection: 'predecessors' },
    entities: [{ type: 'task', from: 0 }], layout: 'auto' };
  const abstain = plan({ intent: 'abstain', language: 'tr', abstain: { reason: 'general' } });
  const { result, inputs } = await turn(t, [plan({ intent: 'rota', language: 'tr', request: value, additionalRequests: [dependent] }), abstain]);
  assert.equal(result.stats.attempted, 0);
  const rejection = inputs[1].messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content)).at(-1);
  assert.ok(rejection.error.details.includes('$.additionalRequests[0].entities:from'), JSON.stringify(rejection.error.details));
  // Kişi satırı takip kimliği taşımaz: bağımlı kişi bölümü sözleşmede yoktur.
  const person = { ...dependent, entities: [{ type: 'person', from: 0 }] };
  const second = await turn(t, [plan({ intent: 'rota', language: 'tr', request: value, additionalRequests: [person] }), abstain]);
  assert.equal(second.result.stats.attempted, 0);
});

/* ── Serbest metin izni ────────────────────────────────────── */

test('yalnızca açılmamış serbest metin gerektiren plan düzeltilmez; sunucu anahtarı açmayı ister, veri okunmaz', async (t) => {
  const request = { operation: 'value', metrics: ['task.description'], population: { tool: 'rota_task_detail' }, entities: [{ type: 'task', text: 'Radar testi' }], layout: 'auto' };
  const { result, inputs } = await turn(t, [plan({ intent: 'rota', language: 'tr', request })], { user: 'Radar testi görevinin açıklaması ne?' });
  assert.equal(inputs.length, 1);
  assert.equal(result.outcome, 'clarification');
  assert.equal(result.text, renderTextFieldsRequired({ locale: 'tr' }));
  assert.equal(result.stats.attempted, 0);
});

/* ── Düzeltme ipuçları ve çelişkili plan ───────────────────── */

test('çelişkili termin penceresi SQL öncesinde reddedilir ve ipucu modelin gördüğü araç sonucundadır', async (t) => {
  const request = { operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks' }, layout: 'auto',
    filters: { deadline: 'due_next_7_days', dateFrom: '2026-10-14', dateTo: '2026-10-28' } };
  const abstain = plan({ intent: 'abstain', language: 'tr', abstain: { reason: 'general' } });
  const { result, inputs } = await turn(t, [plan({ intent: 'rota', language: 'tr', request }), abstain]);
  assert.equal(result.stats.attempted, 0);
  const rejection = inputs[1].messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content)).at(-1);
  assert.deepEqual(rejection.error.details, ['$.filters.deadline:conflict']);
  assert.ok(rejection.error.hints.some((hint) => hint.includes('deadline')));
});

test('proje aramasının kendi varlığı adla bildirildiğinde sunucunun kurduğu arama reddedilmez', async (t) => {
  const request = { operation: 'value', metrics: ['project.lead'], population: { tool: 'rota_project_search' }, entities: [{ type: 'project', text: 'Radar Modernizasyonu' }], layout: 'auto' };
  const { result, decisions } = await turn(t, [plan({ intent: 'rota', language: 'tr', request })], { user: 'Radar Modernizasyonu projesinin lideri kim?' });
  assert.equal(decisions[0]?.intent, 'rota', 'plan ilk bildirimde kabul edilir');
  assert.equal(decisions[0].declarations, 1);
  assert.equal(result.outcome, 'grounded');
  assert.equal(result.stats.attempted, 1);
});

/* ── Telemetri ─────────────────────────────────────────────── */

test('planlayıcı telemetrisi içeriksizdir: soru, aday metni, gerekçe ya da Sicil yazılmaz', async (t) => {
  resetAiTelemetryForTests();
  const user = 'Gizli proje Zümrüt için maaş bordrosunu göster';
  await turn(t, [prose('Gerekçe: bordro Rota dışında.'), plan({ intent: 'abstain', language: 'tr', abstain: { reason: 'outside_data' } })],
    { user, planning: { state: 'first_stage', candidates: ['rota_task_search'] } });
  const snapshot = JSON.stringify(aiTelemetrySnapshot());
  for (const secret of ['Zümrüt', 'bordro', 'Gerekçe', String(AYSE), 'rota_task_search']) assert.ok(!snapshot.includes(secret), secret);
  assert.match(snapshot, /"abstain"/);
});
