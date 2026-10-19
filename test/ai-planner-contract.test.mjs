/**
 * Aşama 4C planlayıcı sözleşmesi: anlamsal danışmanlığın doğrulanması ve geri dönüşü, türlü planın kapalı
 * biçimi, açıklama ve çekimserliğin sonlandırıcı (sıfır SQL) olması, çok bölümlü planın hep-ya-hiç
 * doğrulanması, düz metin kararın reddi, serbest metin izni ve içeriksiz telemetri.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiStack } from './helpers/aiStack.mjs';
import { AYSE, NOW, PROJECTS, TASKS, rotaToolSeed } from './helpers/aiToolFixtures.mjs';

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

async function turn(t, steps, { user = 'Rota verisini incele', planning = null, allowedTextFields = [], limits, setup = null } = {}) {
  const stack = stackFor(t);
  setup?.(stack);
  const inputs = [];
  const decisions = [];
  const session = { signal: new AbortController().signal, round: async (input) => {
    inputs.push(structuredClone({ messages: input.messages, tools: input.tools.map((tool) => tool.name) }));
    const step = steps.shift();
    assert.ok(step, `Beklenmeyen ek model turu: ${JSON.stringify(input.messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content)))}`);
    return typeof step === 'function' ? step(input) : step;
  } };
  const result = await runGroundedTurn(session, { messages: buildGroundedContext({ userContent: user, now: NOW }).messages,
    catalog, context: createToolTurnContext({ sicil: AYSE, now: NOW }), onText: async () => {}, planning, allowedTextFields, ...(limits ? { limits } : {}),
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
  await assert.rejects(semanticPlanningAdvice({ query: 'x', catalog, retrieve: async () => { throw new AiError(AI_ERROR_CODES.AI_UNAUTHORIZED); } }), (error) => error.code === AI_ERROR_CODES.AI_UNAUTHORIZED);
});

test('adaylar araç kümesini ve sırasını değiştirmez; yalnızca sistem notunda öneri olarak görünür', async (t) => {
  const planning = { state: 'reranked', candidates: ['rota_notifications', 'rota_task_search'] };
  const { inputs } = await turn(t, [plan({ intent: 'abstain', language: 'tr', abstain: { reason: 'write' } })], { planning });
  assert.deepEqual(inputs[0].tools, ['rota_plan', ...names]);
  const system = inputs[0].messages.at(-2).content;
  assert.ok(!inputs[0].messages[0].content.includes('rota_notifications, rota_task_search'));
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
  assert.deepEqual(unpackTypedPlan(plan({ intent: 'rota', language: 'tr', request, additionalRequests: [], clarify: {}, abstain: {} })).plan, { intent: 'rota', language: 'tr', request });
  rejects({ intent: 'rota', language: 'tr', request, additionalRequests: [request, request, request] }, '$.additionalRequests:count');
  rejects({ intent: 'rota', language: 'tr', request, additionalRequests: ['x'] }, '$.additionalRequests[0]:type');
  rejects({ intent: 'rota', language: 'tr', request, additionalRequests: [request], calls: [{ name: 'rota_task_analytics', arguments: {} }] }, '$.additionalRequests:calls');
  rejects({ intent: 'clarify', language: 'tr', clarify: { reason: 'curious' } }, '$.clarify.reason:enum');
  rejects({ intent: 'clarify', language: 'tr', clarify: { reason: 'ambiguous', topics: ['rota_task_search', 'rota_sql'] } }, '$.clarify.topics:invalid');
  rejects({ intent: 'clarify', language: 'tr', clarify: { reason: 'ambiguous' }, calls: [{ name: 'rota_task_search', arguments: {} }] }, '$.plan:clarify');
  rejects({ intent: 'abstain', language: 'tr', abstain: { reason: 'write' }, request }, '$.plan:abstain');
  rejects({ intent: 'general', language: 'tr', request }, '$.plan:general');
  assert.deepEqual(unpackTypedPlan(plan({ intent: 'general', language: 'tr', request: {}, clarify: {}, abstain: {}, additionalRequests: [] })).plan, { intent: 'general', language: 'tr' });
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
  const { result, inputs } = await turn(t, [plan({ intent: 'rota', language: 'tr', request: good, additionalRequests: [bad] }), abstain, abstain]);
  assert.equal(result.stats.attempted, 0);
  const rejection = inputs[1].messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content)).at(-1);
  assert.ok(rejection.error.details.some((detail) => detail.startsWith('$.additionalRequests[0].metrics[0]')), JSON.stringify(rejection.error.details));
});

test('bağımlı bölüm yalnızca önceki bağımsız list/rank bölümünün satır kimliğine bağlanır', async (t) => {
  const value = { operation: 'value', metrics: ['notifications.unread'], population: { tool: 'rota_notifications' }, layout: 'auto' };
  const dependent = { operation: 'list', metrics: ['task.title', 'dependency.type'], population: { tool: 'rota_dependency_inspect', collection: 'predecessors' },
    entities: [{ type: 'task', from: 0 }], layout: 'auto' };
  const abstain = plan({ intent: 'abstain', language: 'tr', abstain: { reason: 'general' } });
  const { result, inputs } = await turn(t, [plan({ intent: 'rota', language: 'tr', request: value, additionalRequests: [dependent] }), abstain, abstain]);
  assert.equal(result.stats.attempted, 0);
  const rejection = inputs[1].messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content)).at(-1);
  assert.ok(rejection.error.details.includes('$.additionalRequests[0].entities:from'), JSON.stringify(rejection.error.details));
  // Kişi satırı takip kimliği taşımaz: bağımlı kişi bölümü sözleşmede yoktur.
  const person = { ...dependent, entities: [{ type: 'person', from: 0 }] };
  const second = await turn(t, [plan({ intent: 'rota', language: 'tr', request: value, additionalRequests: [person] }), abstain, abstain]);
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
  const english = await turn(t, [plan({ intent: 'rota', language: 'en', request })], { user: 'Show the description of Radar testi.' });
  assert.equal(english.result.text, renderTextFieldsRequired({ locale: 'en' }));
  assert.equal(english.result.stats.attempted, 0);
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

test('general kararı donuktur: sonraki model planı veri erişimini yeniden açamaz', async (t) => {
  const request = { operation: 'value', metrics: ['notifications.unread'], population: { tool: 'rota_notifications' }, layout: 'auto' };
  const { result, inputs, decisions } = await turn(t, [plan({ intent: 'general', language: 'tr' }),
    (input) => { assert.equal(input.toolChoice, 'none'); assert.deepEqual(input.tools, []); return plan({ intent: 'rota', language: 'tr', request }); },
    prose('{"kind":"general","text":"Merhaba"}')], { user: 'Merhaba' });
  assert.equal(result.stats.attempted, 0);
  assert.deepEqual(decisions.map((item) => item.intent), ['general']);
  assert.equal(inputs.length, 3);
});

test('kazara eklenen textFields sınırlı düzeltmeyle kaldırılır; izin açılmaz', async (t) => {
  const request = { operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks' }, layout: 'auto' };
  const { result, inputs } = await turn(t, [plan({ intent: 'rota', language: 'tr', request: { ...request, population: { ...request.population, textFields: ['description'] } } }),
    plan({ intent: 'rota', language: 'tr', request })], { user: 'Görevleri listele' });
  assert.equal(result.outcome, 'grounded');
  assert.equal(inputs.length, 2);
  assert.ok(result.stats.attempted > 0);
});

test('ek bölüm düzeltilirken geçerli adlandırılmış bölüm değiştirilemez', async (t) => {
  const request = { operation: 'value', metrics: ['project.lead'], population: { tool: 'rota_project_search' }, entities: [{ type: 'project', text: 'Anten' }], layout: 'auto' };
  const bad = { operation: 'value', metrics: ['notifications.invalid'], population: { tool: 'rota_notifications' }, layout: 'auto' };
  const fixed = { ...bad, metrics: ['notifications.unread'] };
  const { result, inputs } = await turn(t, [plan({ intent: 'rota', language: 'tr', request, additionalRequests: [bad] }),
    plan({ intent: 'rota', language: 'tr', request: { ...request, entities: [{ type: 'project', text: 'Radar' }] }, additionalRequests: [fixed] }),
    plan({ intent: 'abstain', language: 'tr', abstain: { reason: 'general' } })], { user: 'Anten projesinin liderini ve Radar için değil bildirimlerimi göster' });
  assert.equal(result.stats.attempted, 0);
  assert.match(JSON.stringify(inputs[2].messages), /repairScope/);
  const broken = { operation: 'value', metrics: ['tasks.invalid'], population: { tool: 'rota_task_analytics' }, layout: 'auto' };
  const narrowed = await turn(t, [plan({ intent: 'rota', language: 'tr', request, additionalRequests: [broken] }),
    plan({ intent: 'rota', language: 'tr', request, additionalRequests: [{ ...broken, metrics: ['tasks.total'], filters: { priority: ['critical'] } }] }),
    plan({ intent: 'abstain', language: 'tr', abstain: { reason: 'general' } })], { user: 'Anten projesinin lideri ve görev sayısı' });
  assert.equal(narrowed.result.stats.attempted, 0);
  assert.match(JSON.stringify(narrowed.inputs[2].messages), /repairScope/);
});


const notifications = { operation: 'value', metrics: ['notifications.unread'], population: { tool: 'rota_notifications' }, layout: 'auto' };
const hiddenOutlook = { operation: 'value', metrics: ['subscriptions.active'], population: { tool: 'rota_outlook_status' }, entities: [{ type: 'task', id: TASKS.HIDDEN }], layout: 'auto' };

test('bölüm kanıtı kardeşin NOT_FOUND ya da kullanılamıyor sonucunu gizleyemez; iki sıra da korunur', async (t) => {
  for (const [request, sibling] of [[notifications, hiddenOutlook], [hiddenOutlook, notifications]]) {
    const { result } = await turn(t, [plan({ intent: 'rota', language: 'tr', request, additionalRequests: [sibling] })], { user: `Bildirimlerim ve görevin Outlook durumu ${TASKS.HIDDEN}` });
    assert.equal(result.outcome, 'unavailable');
    assert.match(result.text, /Kayıt bulunamadı/);
    assert.ok(result.evidence.length > 0);
    assert.equal(result.stats.attempted, 2);
  }
  const { result } = await turn(t, [plan({ intent: 'rota', language: 'tr', request: notifications, additionalRequests: [{ ...hiddenOutlook, entities: [{ type: 'task', id: TASKS.OVERDUE }] }] })],
    { user: `Bildirimlerim ve Outlook durumu ${TASKS.OVERDUE}`, setup: ({ db }) => { db.aiToolFailure = { outlook: Object.assign(new Error('özel hata'), { code: 'ESOCKET' }) }; } });
  assert.equal(result.outcome, 'unavailable');
  assert.match(result.text, /ulaşılamıyor|tamamlanamadı/);
  assert.ok(result.evidence.length > 0);
});

test('çok bölümlü okumalar sıralıdır; tur bütçesi biterse doğrulanmış yanıt korunur', async (t) => {
  const { TOOL_LIMITS } = await import('../src/server/ai/tools/toolLimits.js');
  const request = { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' }, layout: 'auto' };
  const parts = [{ ...request, filters: { status: ['done'] } }, { ...request, filters: { priority: ['critical'] } }];
  const completed = await turn(t, [plan({ intent: 'rota', language: 'tr', request, additionalRequests: parts })], { limits: { ...TOOL_LIMITS, maxCallsPerRound: 1 } });
  assert.equal(completed.result.stats.attempted, 3);
  assert.equal(completed.result.stats.toolRounds, 3);
  const bounded = await turn(t, [plan({ intent: 'rota', language: 'tr', request, additionalRequests: parts })], { limits: { ...TOOL_LIMITS, maxToolRounds: 1 } });
  assert.equal(bounded.result.outcome, 'unavailable');
  assert.equal(bounded.result.evidence.length, 1);
  assert.match(bounded.result.text, /tamamlanamadı/);
});

test('proje arama satırlarının tamamı ayrıntı kaynağıdır ve sıfır kaynak sessizce düşmez', async (t) => {
  const request = { operation: 'list', metrics: ['project.name'], population: { tool: 'rota_project_search', collection: 'matches' }, filters: { text: 'Radar Modernizasyonu' }, layout: 'auto' };
  const dependent = { operation: 'value', metrics: ['project.lead'], population: { tool: 'rota_project_detail' }, entities: [{ type: 'project', from: 0 }], layout: 'auto' };
  const { result } = await turn(t, [plan({ intent: 'rota', language: 'tr', request, additionalRequests: [dependent] })], { user: 'Radar Modernizasyonu projelerini ve liderlerini göster' });
  assert.equal(result.outcome, 'grounded');
  assert.equal(result.stats.attempted, 2, 'proje araması ve ayrıntısı');
  const empty = { operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks' }, filters: { text: 'EşleşmeyenKayıt' }, layout: 'auto' };
  const follow = { operation: 'value', metrics: ['task.status'], population: { tool: 'rota_task_detail' }, entities: [{ type: 'task', from: 0 }], layout: 'auto' };
  const noRows = await turn(t, [plan({ intent: 'rota', language: 'tr', request: empty, additionalRequests: [follow] })], { user: 'EşleşmeyenKayıt görevlerini ve durumlarını göster' });
  assert.match(noRows.result.text, /tamamlanamadı/);
  assert.equal(noRows.result.stats.attempted, 1);
});

test('plan açıklaması sonraki turda kayıt adıyla tam soruyu yeniden ister', async (t) => {
  const first = await turn(t, [plan({ intent: 'clarify', language: 'tr', clarify: { reason: 'ambiguous', topics: ['rota_task_search', 'rota_project_search'] } })], { user: 'Radar bilgileri' });
  assert.match(first.result.text, /Kaydın adını veya kodunu.*sorunun tamamını/);
  const second = await turn(t, [plan({ intent: 'rota', language: 'tr', request: { operation: 'value', metrics: ['project.lead'], population: { tool: 'rota_project_search' }, entities: [{ type: 'project', text: 'Radar Modernizasyonu' }], layout: 'auto' } })], { user: 'Radar Modernizasyonu projesinin lideri kim?' });
  assert.equal(second.result.outcome, 'grounded');
});

test('bağımlı bölüm bütün kaynak satırlarını kullanır; satır sınırı ve sonraki bütçe notu korunur', async (t) => {
  const request = { operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks' }, filters: { assignee: 'me' }, layout: 'auto' };
  const detail = { operation: 'value', metrics: ['task.status'], population: { tool: 'rota_task_detail' }, entities: [{ type: 'task', from: 0 }], layout: 'auto' };
  const { result } = await turn(t, [plan({ intent: 'rota', language: 'tr', request, additionalRequests: [detail] })], { user: 'Görevlerimi ve durumlarını göster' });
  assert.equal(result.outcome, 'grounded');
  assert.equal(result.stats.attempted, 4);
  assert.equal(result.evidence.length, 4);
  assert.match(result.text, /ilk 3 kayıt/);
  const named = { ...request, entities: [{ type: 'project', text: 'Radar Modernizasyonu' }] };
  const bounded = await turn(t, [plan({ intent: 'rota', language: 'tr', request: named, additionalRequests: [detail] })], { user: 'Radar Modernizasyonu projesindeki görevlerimi ve durumlarını göster' });
  assert.equal(bounded.result.outcome, 'unavailable');
  assert.equal(bounded.result.stats.toolRounds, 4);
  assert.match(bounded.result.text, /tamamlanamadı/);
  assert.ok(bounded.result.evidence.length >= 2);
});

test('kardeş koleksiyonlu kaynak bağımlı kimlikleriyle kabul edilir; açıklanan bölüm bağımsız yanıtı silmez', async (t) => {
  const request = { operation: 'list', metrics: ['task.title', 'dependency.type'], population: { tool: 'rota_dependency_inspect' }, entities: [{ type: 'task', text: 'Anten kalibrasyonu' }], layout: 'auto' };
  const detail = { operation: 'value', metrics: ['task.status'], population: { tool: 'rota_task_detail' }, entities: [{ type: 'task', from: 0 }], layout: 'auto' };
  const { result } = await turn(t, [plan({ intent: 'rota', language: 'tr', request, additionalRequests: [detail] })], { user: 'Anten kalibrasyonu öncülleri, ardılları ve durumları' });
  assert.equal(result.outcome, 'grounded');
  assert.ok(result.stats.attempted >= 3);
  assert.match(result.text, /Radar test planı/);
  assert.match(result.text, /Dokümantasyon/);
  const ambiguous = { operation: 'value', metrics: ['person.jobTitle'], population: { tool: 'rota_person_search' }, entities: [{ type: 'person', text: 'Ali Veli' }], layout: 'auto' };
  const clarified = await turn(t, [plan({ intent: 'rota', language: 'tr', request: notifications, additionalRequests: [ambiguous] }),
    (input) => { const evidence = JSON.parse(input.messages.filter((message) => message.role === 'tool').at(-1).content); return prose(JSON.stringify({ kind: 'clarification', evidence: evidence.evidenceId })); }], { user: 'Bildirim sayım ve Ali Veli unvanı' });
  assert.equal(clarified.result.outcome, 'clarification');
  assert.ok(clarified.result.evidenceRows.some((row) => JSON.parse(row.evidenceJson).clarificationContext));
  assert.match(clarified.result.text, /okunmamış/);
  assert.match(clarified.result.text, /Ali Veli/);
});

test('bildirim devri tek karar sayar; metin izni uyarısı da tek içeriksiz karar bırakır', async (t) => {
  stackFor(t); resetAiTelemetryForTests();
  const options = { messages: buildGroundedContext({ userContent: 'Görev sayısı?', now: NOW }).messages, catalog,
    context: createToolTurnContext({ sicil: AYSE, now: NOW }), onText: async () => {}, escalation: true };
  const invalid = plan({ intent: 'rota', language: 'tr' });
  const first = await runGroundedTurn({ signal: new AbortController().signal, round: async () => invalid }, options);
  assert.equal(first.outcome, 'escalate');
  assert.equal(Object.values(aiTelemetrySnapshot().planner.decisions).reduce((a, b) => a + b, 0), 0);
  const result = await runGroundedTurn({ signal: new AbortController().signal, round: async () => plan({ intent: 'abstain', language: 'tr', abstain: { reason: 'calculation' } }) }, { ...options, resume: first.resume });
  assert.equal(result.outcome, 'abstained');
  assert.equal(Object.values(aiTelemetrySnapshot().planner.decisions).reduce((a, b) => a + b, 0), 1);
  resetAiTelemetryForTests();
  const textRequest = { operation: 'value', metrics: ['task.description'], population: { tool: 'rota_task_detail' }, entities: [{ type: 'task', text: 'Radar test planı' }], layout: 'auto' };
  await turn(t, [plan({ intent: 'rota', language: 'tr', request: textRequest })], { user: 'Radar test planı açıklaması' });
  assert.equal(aiTelemetrySnapshot().planner.decisions.text_fields, 1);
});

test('danışmanlık bütçe aşımı iptal sayacına yazılmaz', async (t) => {
  const stack = stackFor(t); resetAiTelemetryForTests();
  const { retrieveSemanticCandidates } = await import('../src/server/ai/semanticRetrieval.js');
  stack.provider.enqueue({ kind: 'embeddings', type: 'stall' });
  const advice = await semanticPlanningAdvice({ query: 'Görevler', catalog, budgetMs: 30, retrieve: retrieveSemanticCandidates });
  assert.equal(advice.reason, 'TIMEOUT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aiTelemetrySnapshot().semantic.byStatus.cancelled, 0);
  assert.equal(aiTelemetrySnapshot().semantic.byStatus.unavailable, 1);
});

test('altı bağımsız türetilmiş okuma tek tura yığılmaz; üretim sınırı değişmeden üç bölüm biter', async (t) => {
  const pairs = [['Radar Modernizasyonu', 'Okuma Projesi'], ['Kısmi Proje', 'Ekip Projesi'], ['RDR', 'OKU']];
  const requests = pairs.map((pair) => ({ operation: 'value', metrics: ['project.lead'], population: { tool: 'rota_project_search' }, entities: pair.map((text) => ({ type: 'project', text })), layout: 'auto' }));
  const { result, decisions } = await turn(t, [plan({ intent: 'rota', language: 'tr', request: requests[0], additionalRequests: requests.slice(1) }),
    ...[1, 3, 5].map((i) => prose(JSON.stringify({ kind: 'rota', facts: [`R${i}:data.matches.0.lead`, `R${i + 1}:data.matches.0.lead`] })))],
    { user: pairs.flat().join(' ve ') + ' projelerinin liderleri' });
  assert.equal(result.outcome, 'grounded');
  assert.equal(result.stats.attempted, 6);
  assert.equal(result.stats.toolRounds, 3);
  assert.equal(decisions[0].declarations, 1);
  assert.ok(!result.text.includes('tamamlanamadı'));
});

test('ad çözümü kanıtı başarısız ayrıntı okumasını temellendirilmiş gösteremez', async (t) => {
  const detail = { operation: 'value', metrics: ['task.actualHours'], population: { tool: 'rota_task_detail' }, entities: [{ type: 'task', text: 'Radar test planı' }], layout: 'auto' };
  const { result } = await turn(t, [plan({ intent: 'rota', language: 'tr', request: notifications, additionalRequests: [detail] })], {
    user: 'Bildirimlerim ve Radar test planı gerçekleşen saati', setup: ({ db }) => { db.aiToolFailure = { 'task-detail': Object.assign(new Error('özel'), { code: 'ESOCKET' }) }; }
  });
  assert.equal(result.outcome, 'unavailable');
  assert.match(result.text, /okunmamış/);
  assert.match(result.text, /ulaşılamıyor|tamamlanamadı/);
  assert.doesNotMatch(result.text, /gerçekleşen.*\*\*12\*\*/);
});

test('sonraki bölümün geçici sağlayıcı hatası önceki doğrulanmış yanıtı silmez', async (t) => {
  const ambiguous = { operation: 'value', metrics: ['person.jobTitle'], population: { tool: 'rota_person_search' }, entities: [{ type: 'person', text: 'Ali Veli' }], layout: 'auto' };
  const { result } = await turn(t, [plan({ intent: 'rota', language: 'tr', request: notifications, additionalRequests: [ambiguous] }),
    () => { throw new AiError(AI_ERROR_CODES.AI_PROVIDER_UNAVAILABLE); }], { user: 'Bildirim sayım ve Ali Veli unvanı' });
  assert.equal(result.outcome, 'unavailable');
  assert.match(result.text, /okunmamış/);
  assert.match(result.text, /tamamlanamadı/);
});

/* Aynı değişmezleri farklı mutasyonlarla kırmayı deneyen yakınsama matrisi. */
test('4C yerel plan kararı zorunludur; eski rota ve son JSON ilk kararı atlayamaz', async (t) => {
  for (const text of [JSON.stringify({ kind: 'route', intent: 'rota', language: 'tr', request: notifications }),
    JSON.stringify({ kind: 'general', text: 'ok' }), JSON.stringify({ name: 'rota_plan', arguments: { intent: 'general', language: 'tr' } })]) {
    const { result, inputs, decisions } = await turn(t, [prose(text), plan({ intent: 'abstain', language: 'tr', abstain: { reason: 'security' } })]);
    assert.equal(result.stats.attempted, 0);
    assert.deepEqual(decisions.map((d) => d.intent), ['abstain']);
    assert.match(JSON.stringify(inputs[1].messages), /plan:required/);
  }
});

test('4C bir Rota okuması NOT_FOUND olsa da sonraki terminal plan geçmişi değiştiremez', async (t) => {
  for (const decision of [{ intent: 'clarify', clarify: { reason: 'missing_referent' } }, { intent: 'abstain', abstain: { reason: 'write' } }, { intent: 'general' }]) {
    const { result, decisions } = await turn(t, [plan({ intent: 'rota', language: 'tr', request: hiddenOutlook }),
      plan({ language: 'tr', ...decision }), prose('{"kind":"not_found"}')], { user: `Outlook ${TASKS.HIDDEN}` });
    assert.equal(result.outcome, 'not_found');
    assert.equal(result.stats.attempted, 1);
    assert.deepEqual(decisions.map((d) => d.intent), ['rota']);
  }
  const request = { ...hiddenOutlook, entities: [TASKS.OVERDUE, TASKS.DUE_SOON].map((id) => ({ type: 'task', id })) };
  const laterTimeout = await turn(t, [plan({ intent: 'rota', language: 'tr', request,
    calls: [{ name: 'rota_outlook_status', arguments: { taskId: TASKS.OVERDUE } }] }), prose('{"kind":"unavailable"}')],
  { user: `Outlook ${TASKS.OVERDUE} ${TASKS.DUE_SOON}`, setup: ({ db }) => {
    let accesses = 0;
    db.aiToolFailure = { get outlook() { return Object.assign(new Error('özel'), { code: accesses++ < 2 ? 'NOT_FOUND' : 'ETIMEOUT' }); } };
  } });
  assert.equal(laterTimeout.result.outcome, 'unavailable', 'önceki NOT_FOUND sonraki TIMEOUT sınıfını kirletemez');
  assert.ok(laterTimeout.result.stats.attempted >= 2);
  const failures = laterTimeout.inputs.at(-1).messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content).error?.code);
  assert.equal(failures[0], 'NOT_FOUND');
  assert.equal(failures.at(-1), 'TIMEOUT');
});

test('4C semantik onarım: eşdeğer biçim ve bölüm sırası korunur; niyet ve soru sayısı sabittir', async (t) => {
  const good = { ...notifications, filters: {} };
  const bad = { operation: 'value', metrics: ['tasks.invalid'], population: { tool: 'rota_task_analytics' }, layout: 'auto' };
  const fixed = { ...bad, metrics: ['tasks.total'] };
  const original = plan({ intent: 'rota', language: 'tr', request: good, additionalRequests: [bad] });
  const equivalent = { ...notifications, reasoning: 'deterministic', fields: [], entities: [], bindings: [], filters: null };
  const accepted = await turn(t, [original, plan({ intent: 'rota', language: 'tr', request: equivalent, additionalRequests: [fixed] })]);
  assert.equal(accepted.result.outcome, 'grounded');
  const reordered = await turn(t, [original, plan({ intent: 'rota', language: 'tr', request: fixed, additionalRequests: [equivalent] })]);
  assert.equal(reordered.result.outcome, 'grounded');
  const source = { operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks' }, layout: 'auto' };
  const detail = { operation: 'value', metrics: ['task.status'], population: { tool: 'rota_task_detail' }, entities: [{ type: 'task', from: 0 }], layout: 'auto' };
  const dependencyReorder = await turn(t, [plan({ intent: 'rota', language: 'tr', request: source, additionalRequests: [detail, bad] }),
    plan({ intent: 'rota', language: 'tr', request: fixed, additionalRequests: [source, { ...detail, entities: [{ type: 'task', from: 1 }] }] })]);
  assert.equal(dependencyReorder.decisions[0].intent, 'rota');
  assert.equal(dependencyReorder.decisions[0].declarations, 2, 'from aynı kaynak bölümün anlamına bağlanır; indis değişebilir');
  for (const mutation of [
    { intent: 'general', language: 'tr' },
    { intent: 'clarify', language: 'tr', clarify: { reason: 'missing_referent' } },
    { intent: 'rota', language: 'tr', request: fixed },
    { intent: 'rota', language: 'tr', request: good, additionalRequests: [fixed, fixed] },
    { intent: 'rota', language: 'tr', request: good, additionalRequests: [{ ...fixed, filters: { priority: ['critical'] } }] }
  ]) {
    const refused = await turn(t, [original, plan(mutation), plan(mutation)]);
    assert.equal(refused.result.stats.attempted, 0);
    assert.match(JSON.stringify(refused.inputs[2].messages), /repairScope/);
  }
});

test('4C çağrıdan türeyen nüfus onarımda korunur; taşıyıcı düzeltmesi ilgisiz kapsam açmaz', async (t) => {
  const calls = [{ name: 'rota_task_analytics', arguments: { assignee: 'me' } }, { name: 'rota_notifications', arguments: {} }];
  const request = { operation: 'value', metrics: ['tasks.total'], layout: 'auto' };
  const original = plan({ intent: 'rota', language: 'tr', request, calls });
  const changed = plan({ intent: 'rota', language: 'tr', request: { ...request, population: { tool: 'rota_task_analytics' }, filters: { priority: ['critical'] } } });
  const rejected = await turn(t, [original, changed, changed]);
  assert.equal(rejected.result.stats.attempted, 0);
  assert.match(JSON.stringify(rejected.inputs[2].messages), /repairScope/);
  const mixed = plan({ intent: 'rota', language: 'tr', request: { ...notifications, metrics: ['notifications.unread', 'notifications.typo'] } });
  const dropsMetric = plan({ intent: 'rota', language: 'tr', request: { ...notifications, metrics: ['notifications.total'] } });
  const preserved = await turn(t, [mixed, dropsMetric, dropsMetric]);
  assert.equal(preserved.result.stats.attempted, 0, 'geçerli ölçü onarımda silinmez');
  const invalidMetric = { operation: 'value', metrics: ['notifications.typo'], population: { tool: 'rota_task_analytics' }, layout: 'auto' };
  const repaired = await turn(t, [plan({ intent: 'rota', language: 'tr', request: invalidMetric }), plan({ intent: 'rota', language: 'tr', request: notifications })]);
  assert.equal(repaired.result.outcome, 'grounded');
});

test('4C karma hata korumalı metni düşürerek onarılamaz ve iç bölüm ipucu bölümü silmez', async (t) => {
  const mixed = { operation: 'value', metrics: ['task.description', 'notifications.unread'], population: { tool: 'rota_task_detail' },
    entities: [{ type: 'task', text: 'Anten kalibrasyonu' }], layout: 'auto' };
  for (const request of [mixed, { ...mixed, fields: 'invalid' }, { ...mixed, metrics: ['task.description', 'notifications.typo'] }]) {
    const { result } = await turn(t, [plan({ intent: 'rota', language: 'tr', request })], { user: 'Anten kalibrasyonu açıklaması ve okunmamış bildirim sayım' });
    assert.equal(result.stats.attempted, 0);
    assert.equal(result.text, renderTextFieldsRequired({ locale: 'tr' }));
  }
  const { planShapeHints } = await import('../src/server/ai/tools/executionSet.js');
  assert.deepEqual(planShapeHints(['$.additionalRequests[0].metrics[0]:enum']), []);
  assert.ok(planShapeHints(['$.additionalRequests:count']).length);
  assert.equal(unpackTypedPlan(plan({ intent: 'clarify', language: 'tr', clarify: { reason: 'missing_referent', topics: [] } })).plan.intent, 'clarify');
});

test('4C Deep devri önceki onarım kapsamını temizler; etkin karar gözlemciye gider ve tek sayılır', async (t) => {
  stackFor(t); resetAiTelemetryForTests();
  const decisions = [];
  const options = { messages: buildGroundedContext({ userContent: 'Bildirim ve görev sayım', now: NOW }).messages, catalog,
    context: createToolTurnContext({ sicil: AYSE, now: NOW }), onText: async () => {}, escalation: true, onPlanned: (d) => decisions.push(d.intent) };
  const bad = plan({ intent: 'rota', language: 'tr', request: notifications, additionalRequests: [{ ...notifications, metrics: ['tasks.bad'] }] });
  const standard = await runGroundedTurn({ signal: new AbortController().signal, round: async () => bad }, options);
  assert.equal(standard.outcome, 'escalate');
  assert.equal(standard.resume.repairPins.size, 0);
  const deep = await runGroundedTurn({ signal: new AbortController().signal, round: async () => plan({ intent: 'rota', language: 'tr', request: {
    operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' } } }) }, { ...options, resume: standard.resume });
  assert.equal(deep.outcome, 'grounded');
  assert.deepEqual(decisions, ['rota']);
  assert.equal(Object.values(aiTelemetrySnapshot().planner.decisions).reduce((a, b) => a + b, 0), 1);
  resetAiTelemetryForTests(); decisions.length = 0;
  const retry = await runGroundedTurn({ signal: new AbortController().signal, round: async () => bad }, options);
  let rounds = 0;
  const general = await runGroundedTurn({ signal: new AbortController().signal, round: async (input) => {
    if (!rounds++) return plan({ intent: 'general', language: 'tr' });
    assert.deepEqual(input.tools, []);
    assert.equal(input.toolChoice, 'none');
    return { ...prose('{"kind":"general","text":"Merhaba"}'), toolCalls: [{ id: 'forbidden', name: 'rota_notifications', arguments: '{}' }] };
  } }, { ...options, resume: retry.resume });
  assert.equal(general.outcome, 'general_redirect');
  assert.equal(general.stats.attempted, 0);
  assert.deepEqual(decisions, ['general']);
  assert.equal(Object.values(aiTelemetrySnapshot().planner.decisions).reduce((a, b) => a + b, 0), 1);
});

test('4C son okuma turundaki sentez kanıtı korunur ve başarısız kardeşten sonra bağımsız bölüm okunur', async (t) => {
  const { TOOL_LIMITS } = await import('../src/server/ai/tools/toolLimits.js');
  const request = { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' }, layout: 'auto' };
  const last = { ...request, reasoning: 'synthesis', filters: { priority: ['critical'] } };
  const { result } = await turn(t, [plan({ intent: 'rota', language: 'tr', request: notifications, additionalRequests: [request, last] }),
    prose('{"kind":"rota","facts":["R3:data.totals.total"]}')], { limits: { ...TOOL_LIMITS, maxToolRounds: 3 } });
  assert.equal(result.outcome, 'grounded');
  assert.equal(result.stats.attempted, 3);
  const continued = await turn(t, [plan({ intent: 'rota', language: 'tr', request: notifications, additionalRequests: [hiddenOutlook, request] })],
    { user: `Bildirimlerim, Outlook ${TASKS.HIDDEN} ve görev sayım` });
  assert.equal(continued.result.stats.attempted, 3);
  assert.equal(continued.result.outcome, 'unavailable');
  assert.equal(continued.result.evidence.length, 2);
});

test('4C bağımlı kapsam yalnızca doğrulanmış sonuç satırlarına ve rank sınırına bağlanır', async (t) => {
  for (const [tool, collection, metric, type, text] of [['rota_project_search', 'matches', 'project.name', 'project', 'Radar'], ['rota_task_search', 'tasks', 'task.title', 'task', 'Radar']]) {
    const request = { operation: 'list', metrics: [metric], population: { tool, collection }, filters: { text }, layout: 'auto' };
    const detail = { operation: 'value', metrics: [type === 'task' ? 'task.status' : 'project.lead'], population: { tool: `rota_${type}_detail` }, entities: [{ type, from: 0 }], layout: 'auto' };
    const { result } = await turn(t, [plan({ intent: 'rota', language: 'tr', request, additionalRequests: [detail] })], { user: 'Radar kayıtlarını ve ayrıntılarını listele' });
    assert.ok(result.stats.attempted > 1, `${tool}: seçili sonuçlar ayrıntıda okunmalı`);
    assert.equal(result.stats.failures, 0);
  }
  const ranked = { operation: 'rank', metrics: ['project.name', 'tasks.overdue'], population: { tool: 'rota_portfolio_summary', collection: 'projects' }, rank: { metric: 'tasks.overdue', order: 'desc', limit: 1 }, layout: 'auto' };
  const detail = { operation: 'value', metrics: ['project.lead'], population: { tool: 'rota_project_detail' }, entities: [{ type: 'project', from: 0 }], layout: 'auto' };
  const { result } = await turn(t, [plan({ intent: 'rota', language: 'tr', request: ranked, additionalRequests: [detail] })]);
  assert.equal(result.stats.attempted, 2, 'top-1 tek ayrıntı kimliği açar');
});
