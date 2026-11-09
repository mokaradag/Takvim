/**
 * Aşama G — Bilgin yönetici ve proje zekâsı: belirlenimci kabul (model çağrısı yok).
 *
 * Kıyas kümesi (`test/fixtures/bilgin-executive-benchmark.json`, sentetik) altın planlarla ÜRETİMDEKİ asistan hizmetinden geçer:
 * yetki, salt okunur araçlar, kanıt, bulgu motoru ve sunucu düzeni. Ayrıca çok kapsamlı plan, örgütsel kırılım, kadro tamlığı,
 * kilometre taşı bulguları, özet + ek liste birleşimi ve güvenlik değişmezleri (yetkisiz kapsam, karışık kapsam, takipte genişleme,
 * yetki kaybı, yeniden açılış, istem enjeksiyonu) ayrıca sınanır. Gerçek model kabulü değildir (bkz. scripts/analysis-qualification.mjs).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';
import { answerQuality } from './helpers/answerQuality.mjs';
import { G_FINDING_TEXT, phase4eConversation, populationReads, renderedCharts, turnViolations } from './helpers/phase4eScenario.mjs';
import { composer, coveringBlocks } from './helpers/compositionScenario.mjs';
import { EXEC_PEOPLE, EXEC_PROFILES, EXEC_PROJECTS, executiveBenchmarkSeed, P } from './helpers/executiveBenchmarkSeed.mjs';
import { callRotaTool, NOW } from './helpers/aiToolFixtures.mjs';
import { createAiStack, loadAssistantConversation } from './helpers/aiStack.mjs';

registerServerOnlyShim();
const { parseAnalysis, expandAnalysis, ANALYSIS_LIMITS, analysisSchema } = await import('../src/server/ai/tools/analysisPlan.js');
const { unpackTypedPlan, typedPlanningTool } = await import('../src/server/ai/tools/executionSet.js');
const { toolCatalogForModel } = await import('../src/server/ai/tools/toolRegistry.js');
const { analyticalFindings, synthesisNarrative } = await import('../src/domain/ai/analyticalFindings.js');
const { executiveExpectation, plannerScore } = await import('../scripts/analysis-qualification.mjs');

const fixture = JSON.parse(readFileSync(new URL('./fixtures/bilgin-executive-benchmark.json', import.meta.url), 'utf8'));
const TODAY = fixture.today;
const shift = (offset) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const resolve = (plan) => JSON.parse(JSON.stringify(plan).replace(/"T\+(-?\d+)"/g, (_, offset) => `"${shift(Number(offset))}"`));
const unpack = (plan) => unpackTypedPlan({ toolCalls: [{ name: 'rota_plan', arguments: JSON.stringify(plan) }] }, { today: TODAY });
const reject = (plan) => { try { unpack(plan); return null; } catch (error) { return error.details; } };

/** Sentetik veri sabit saatte kurulur; konuşma aynı saatle yürür. */
function conversation(t, profile, options = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = executiveBenchmarkSeed();
  t.mock.timers.reset();
  return phase4eConversation(t, { sicil: EXEC_PROFILES[profile], seed, ...options });
}


/* ── Kıyas kümesinin bütünlüğü ─────────────────────────────────── */

test('G kıyas kümesi en az 40 hedefli ve 20 bağımsız ayrık vaka içerir; kimlikler tekildir, sınıflar tanımlıdır', () => {
  assert.ok(fixture.scenarios.length >= 40, String(fixture.scenarios.length));
  assert.ok(fixture.holdout.length >= 20, String(fixture.holdout.length));
  const ids = [...fixture.scenarios, ...fixture.holdout].map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of fixture.scenarios) {
    assert.ok(Object.hasOwn(fixture.handling, item.handling), item.id);
    assert.ok(EXEC_PROFILES[item.profile], item.id);
    assert.equal(Boolean(item.dependsOn), ['partial', 'limitation'].includes(item.handling), `${item.id}: bağımlılık yalnızca kısmi/sınırlı vakada`);
    assert.ok(item.plan || item.turns || item.handling === 'limitation', item.id);
  }
  // Her persona temsil edilir.
  const personas = new Set(fixture.scenarios.map((item) => item.persona));
  for (const persona of ['executive', 'manager', 'project-manager', 'employee', 'complex', 'adversarial', 'admin']) assert.ok(personas.has(persona), persona);
});

test('G kıyas verisi tamamen sentetiktir: sorulardaki proje ve kişi adları sentetik veri kümesindedir', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = executiveBenchmarkSeed();
  t.mock.timers.reset();
  const known = new Set([...seed.people.map((person) => person.DisplayName), ...seed.projects.map((project) => project.ProjectName)]);
  for (const item of [...fixture.scenarios, ...fixture.holdout]) {
    for (const name of [...(item.plan?.analysis?.names || []), ...(item.expect?.names || [])]) assert.ok(known.has(name), `${item.id}: ${name}`);
  }
});

/* ── Altın planlı kabul ─────────────────────────────────────────── */

for (const item of fixture.scenarios.filter((entry) => entry.plan || entry.turns)) {
  test(`G kıyas ${item.id} (${item.persona}, ${item.handling}): ${item.capabilities.join(', ')}`, async (t) => {
    const { ask } = conversation(t, item.profile);
    const turns = item.turns || [{ text: item.text, plan: item.plan }];
    let result = null;
    for (const turn of turns) result = await ask({ text: turn.text, plan: resolve(turn.plan) });
    const content = String(result.answer.content || '');
    // Canlı nitelendirmenin beklentisinin aynısı: altın davranış onu karşılamalıdır (beklenti ulaşılamaz değildir).
    const expect = executiveExpectation(item);
    assert.deepEqual(turnViolations(result, expect), [], content);
    if (expect.finish === 'stop') {
      assert.ok(/【R\d+】/.test(content), 'yanıt kanıtlı olmalı');
      const quality = answerQuality(content);
      assert.deepEqual(quality.mechanical, [], `mekanik kalıp:\n${content}`);
      assert.equal(quality.duplicates, 0, `yinelenen cümle:\n${content}`);
      if (quality.multi) assert.ok(quality.opening && quality.ending, `açılış ve kapanış:\n${content}`);
    }
    // Yetkisiz kapsamın verisi hiçbir koşulda okunmuş kanıt olarak yanıta girmez.
    if (expect.noTeamRead) assert.equal(result.evidence.some((row) => row.data?.filters?.assignee === 'team'), false, 'ekip kanıtı yok');
    if (expect.noDepartmentRead) assert.equal(result.evidence.some((row) => row.data?.filters?.teamLevel === 'department'), false, 'bölüm kanıtı yok');
    // Bileşik risk puanı, kapasite yüzdesi ya da kişi performans yargısı hiçbir yanıtta üretilmez.
    assert.doesNotMatch(content, /risk puanı \*\*|kapasite(?:si)? \*\*%|performansı (?:düşük|zayıf)/u);
  });
}

test('ayrık küme puanı: çok kapsamlı beklentide her kapsam bildirilmelidir; birden çok doğru karar kabul edilir', () => {
  const planned = (analysis) => ({ outcome: 'planned', decisions: [{ intent: 'rota' }], plan: { analysis, requests: [] } });
  const expect = { intent: 'rota', layers: [{ scope: 'self' }, { scope: 'team', level: 'unit' }] };
  assert.deepEqual(plannerScore(planned({ scope: 'self', focus: ['overview'], also: [{ scope: 'team', level: 'unit', focus: ['overview'] }] }), expect), []);
  assert.deepEqual(plannerScore(planned({ scope: 'self', focus: ['overview'] }), expect), ['kapsam team/unit bildirilmedi']);
  // Kabul edilen kararın özeti kapsamları `layers` olarak taşır.
  assert.deepEqual(plannerScore(planned({ scope: 'self', focus: ['overview'], layers: [{ scope: 'self', focus: ['overview'] }, { scope: 'team', level: 'unit', focus: ['overview'] }] }), expect), []);
  assert.deepEqual(plannerScore(planned({ scope: 'team', level: 'department', focus: ['overview'], also: [{ scope: 'self', focus: ['overview'] }] }), expect), ['kapsam team/unit bildirilmedi'],
    'düzey farklıysa kapsam aynı değildir');
  const abstained = { outcome: 'abstained', decisions: [{ intent: 'abstain', reason: 'outside_data' }], plan: null };
  assert.deepEqual(plannerScore(abstained, { intentAny: ['abstain', 'rota'] }), []);
  assert.deepEqual(plannerScore(abstained, { intentAny: ['rota', 'clarify'] }), ['karar abstain ≠ rota|clarify']);
});

test('sonraki aşamaya bağlı G vakaları açık bağımlılıkla kayıtlıdır', () => {
  assert.deepEqual(fixture.scenarios.filter((item) => item.handling === 'limitation').map((item) => [item.id, item.dependsOn]), [['g23', 'H']]);
});

/* ── Çok kapsamlı plan ─────────────────────────────────────────── */

test('çok kapsamlı özet: dizi yazımı ek kapsamlara çevrilir; her kapsam kendi nüfusuyla okunur, kapsamlar arası toplam yoktur', () => {
  const array = unpack({ intent: 'rota', language: 'tr', analysis: JSON.stringify([{ scope: 'self', focus: ['overview'] }, { scope: 'team', level: 'unit', focus: ['workload'] },
    { scope: 'team', level: 'department', focus: ['org'] }]) }).plan;
  assert.deepEqual(array.analysis.also.map((layer) => [layer.scope, layer.level]), [['team', 'unit'], ['team', 'department']]);
  const parts = [array.request, ...array.additionalRequests];
  const filters = parts.map((part) => JSON.stringify([part.filters?.assignee || null, part.filters?.teamLevel || null]));
  assert.deepEqual([...new Set(filters)], ['["me",null]', '["team","unit"]', '["team","department"]'], 'kapsam sırası korunur');
  // Her kapsamın özeti aynı tanımlı ölçülerle okunur (karşılaştırma bunların üzerindedir).
  const summaries = parts.filter((part) => part.operation === 'value');
  assert.equal(summaries.length, 3);
  assert.ok(summaries.every((part) => JSON.stringify(part.metrics) === JSON.stringify(summaries[0].metrics)));
  assert.ok(parts.length <= ANALYSIS_LIMITS.maxParts);
  // Farklı dönemli kapsamlar tek pencerede temsil edilemez: dönem sessizce düşmez, plan reddedilir.
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis: [{ scope: 'self', focus: ['overview'], dateFrom: shift(0), dateTo: shift(6) }, { scope: 'team', focus: ['overview'] }] }),
    ['$.analysis.also:window']);
  // Dört kapsam (birincil + 3) bütçeyi aşar; kapsam düşürülmez.
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis: [{ scope: 'self', focus: ['overview'] }, { scope: 'team', level: 'unit' }, { scope: 'team', level: 'department' },
    { scope: 'team', level: 'directorate' }] }), ['$.analysis:type']);
});

test('çok kapsamlı özet: yinelenen kapsam, takip göndergesi, kendiyle karşılaştırma ve iki adlı karşılaştırma ile birleşmez', () => {
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'projects', focus: ['overview'], also: [{ scope: 'all' }] } }), ['$.analysis.also:duplicate']);
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'person', names: ['Elif Arslan'], withSelf: true, focus: ['overview'], also: [{ scope: 'team' }] } }),
    ['$.analysis.also:scope']);
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'project', names: ['KAP TOOL', 'BGS Şube Çalışmaları'], focus: ['overview'], also: [{ scope: 'team' }] } }), ['$.analysis.also:scope']);
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'], also: [{ scope: 'person' }] } }), ['$.analysis.also[0].names:required']);
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'], also: [{ scope: 'self', level: 'unit' }] } }), ['$.analysis.also[0].level:scope']);
  // Birincil kapsamın birebir aynısı yapısal olarak tekilleşir (kapsam düşmez, yeni kapsam da eklenmez).
  assert.equal(unpack({ intent: 'rota', language: 'tr', analysis: { scope: 'team', focus: ['overview'], also: [{ scope: 'team' }] } }).plan.analysis.also, undefined);
  // Kendi + tek adlı kişi ek kapsamı "kendimi X ile karşılaştır"dır: kişi kapsamı + kendiyle karşılaştırma (yönler birleşir).
  for (const analysis of [{ scope: 'self', focus: ['overdue'], also: [{ scope: 'person', names: ['Elif Arslan'], focus: ['overview'] }] },
    { scope: 'person', names: ['Elif Arslan'], focus: ['overdue'], also: [{ scope: 'self', focus: ['overview'] }] }]) {
    const paired = unpack({ intent: 'rota', language: 'tr', analysis }).plan.analysis;
    assert.deepEqual([paired.scope, paired.names, paired.withSelf, paired.also, [...paired.focus].sort()], ['person', ['Elif Arslan'], true, undefined, ['overdue', 'overview']]);
  }
});

test('çok kapsamlı özet bütçeye sığmayan dağılım yönünü sessizce düşürmez: hangi kapsamın hangi yönü okunmadıysa adıyla söylenir', async (t) => {
  const item = fixture.scenarios.find((entry) => entry.id === 'g48');
  const { plan } = unpack(resolve(item.plan));
  assert.ok(plan.analysis.omitted.length > 0, 'okunmayan yön kaydı');
  assert.ok([plan.request, ...plan.additionalRequests].length <= ANALYSIS_LIMITS.maxParts);
  const { ask } = conversation(t, 'B');
  const result = await ask({ text: item.text, plan: resolve(item.plan) });
  assert.match(result.answer.content, /tek yanıtın okuma sınırına sığmadığı için ayrıca gösterilmedi/);
  // Her kapsamın özet ölçüleri her durumda okunur.
  for (const level of [null, 'UNIT', 'DEPARTMENT']) assert.ok(populationReads(result.log).some((row) => (row.params.teamLevel || null) === level));
});

test('çok kapsamlı yanıtın takibi yalnızca birincil kapsamı güncel yetkiyle yeniden okur; başka kapsamın kimliği daraltma sayılmaz', async (t) => {
  const { ask, stack } = conversation(t, 'B');
  const item = fixture.scenarios.find((entry) => entry.id === 'g12');
  const first = await ask({ text: item.text, plan: resolve(item.plan) });
  assert.equal(first.answer.finishReason, 'stop');
  const context = stack.db.aiMessageEvidence.map((row) => JSON.parse(row.EvidenceJson)).findLast((row) => row.analysisContext)?.analysisContext;
  assert.deepEqual([context.scope, context.subjects, context.within, context.rows], ['self', [], undefined, []]);
  const next = await ask({ text: 'neden', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous', act: 'explain' } } });
  assert.equal(next.answer.finishReason, 'stop', next.answer.content);
  assert.ok(populationReads(next.log).every((row) => row.params.assigneeMode === 'me'), 'takip ekip ya da bölüm kapsamına genişlemez');
});

/* ── Özet + ek liste (G6, Q38) ─────────────────────────────────── */

test('özet ve ek liste birlikte planlanır: özetin zaten okuduğu liste ikinci kez okunmaz, farklı liste ayrı bölüm olur', () => {
  const combined = fixture.scenarios.find((entry) => entry.id === 'g51');
  const { plan } = unpack(resolve(combined.plan));
  const parts = [plan.request, ...(plan.additionalRequests || [])];
  assert.equal(parts.filter((part) => part.population.tool === 'rota_task_search').length, 1, 'kapsanan liste yinelenmez');
  const distinct = fixture.scenarios.find((entry) => entry.id === 'g52');
  const other = unpack(resolve(distinct.plan)).plan;
  const reads = [other.request, ...(other.additionalRequests || [])];
  assert.ok(reads.some((part) => part.population.tool === 'rota_task_search' && part.filters?.priority?.includes('critical')), 'açık istek ayrı bölüm');
  assert.ok(reads.some((part) => part.population.tool === 'rota_workload_summary'), 'özetin okumaları korunur');
});

test('özetin yanındaki açık isteğin sorunu modelin yazdığı istek yoluyla döner; özetin genel "geçersiz" ayrıntısına dönüşmez', async (t) => {
  // Canlı ayrık vaka (Haiku): özet + sıralama alanı olmayan "rank" isteği iki kez "$.analysis:invalid" aldı ve plan geçersiz kaldı.
  const request = { operation: 'rank', metrics: ['task.title', 'task.overdueDays', 'task.targetFinish'], population: { tool: 'rota_task_search' },
    filters: { assignee: 'me', deadline: 'overdue' }, layout: 'list' };
  const analysis = { scope: 'self', focus: ['schedule'], dateFrom: shift(1), dateTo: shift(30) };
  const plans = [{ intent: 'rota', language: 'tr', visual: true, analysis, request },
    { intent: 'rota', language: 'tr', visual: true, analysis, request: { ...request, rank: { metric: 'task.overdueDays', order: 'desc', limit: 8 } } }];
  const planCall = (plan) => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plan }] });
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = executiveBenchmarkSeed();
  t.mock.timers.reset();
  const { ask } = phase4eConversation(t, { sicil: P.B, seed, planner: () => planCall(plans.shift()) });
  const result = await ask({ text: 'Önce bu ayın kendi teslimatlarımı grafikle göster, sonra gecikmiş işlerimi tek tek sırala.' });
  assert.equal(result.inputs.length, 2);
  const repair = result.inputs[1].messages.filter((message) => message.role !== 'user').map((message) => String(message.content)).join('\n');
  assert.match(repair, /\$\.request\.rank/, 'sorun açık isteğin kendi yolunda');
  assert.doesNotMatch(repair, /\$\.analysis:invalid/);
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
});

test('özetin yanındaki seçicisiz okuma çağrıları atılır; bildirilmemiş ada ya da seçiciye yazılmış çağrı planı reddeder', () => {
  const analysis = { scope: 'person', names: ['Nehir SÜRMELİOĞLU'], withSelf: true, focus: ['overview', 'workload'] };
  const accepted = unpack({ intent: 'rota', language: 'tr', analysis: { ...analysis, scope: 'self' },
    calls: [{ name: 'rota_person_search', arguments: { text: 'Nehir SÜRMELİOĞLU' } }, { name: 'rota_workload_summary', arguments: { limit: 10 } }] });
  assert.equal(accepted.plan.analysis.scope, 'person', 'kendi + tek ad + kendiyle karşılaştırma kişi kapsamıdır');
  assert.deepEqual(accepted.calls, []);
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis, calls: [{ name: 'rota_task_search', arguments: { projectId: EXEC_PROJECTS.BGS } }] }), ['$.analysis:request']);
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis, calls: [{ name: 'rota_person_search', arguments: { text: 'Elif Arslan' } }] }), ['$.analysis:request']);
});

/* ── Kadro tamlığı ve iş yükü ──────────────────────────────────── */

test('ekip iş yükü kadroyu okur: görünür açık görevi olmayan üye sıfır satırla eklenir; kesik ya da çözülemeyen kadro tamlık iddiası kurmaz', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = executiveBenchmarkSeed();
  const stack = createAiStack(t, { sicil: P.B, seed, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  const { result } = await callRotaTool(stack, P.B, 'rota_workload_summary', { assignee: 'team', teamLevel: 'unit', limit: 25 });
  assert.equal(result.data.populationComplete, true);
  const zero = result.data.people.find((person) => person.sicil === EXEC_PEOPLE.ILGAZ);
  assert.deepEqual([zero?.openTasks, zero?.overdue], [0, 0]);
  assert.ok(result.data.notes.some((note) => /boşta olduğunu göstermez/.test(note)));
  // Kişi süzgecinde kadro okunmaz; kadro dışındaki görünür kişi tamlığı bozar.
  const person = await callRotaTool(stack, P.B, 'rota_workload_summary', { assignee: 'team', teamLevel: 'unit', limit: 2 });
  assert.equal(person.result.data.populationComplete, false, 'sayfa kesikse tamlık yok');
  stack.db.people = stack.db.people.filter((row) => row.Sicil !== EXEC_PEOPLE.ILGAZ);
  const unresolved = await callRotaTool(stack, P.B, 'rota_workload_summary', { assignee: 'team', teamLevel: 'unit', limit: 25 });
  assert.equal(unresolved.result.data.populationComplete, false, 'adı çözülemeyen kadro üyesi');
  assert.equal(JSON.stringify(unresolved.result.data).includes(String(EXEC_PEOPLE.ILGAZ)), false, 'çözülemeyen kimlik açılmaz');
});

test('yalnızca birim kapsamlı yönetici bölüm kadrosunu ve bölüm iş yükünü göremez', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const stack = createAiStack(t, { sicil: P.F, seed: executiveBenchmarkSeed(), env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  const denied = await callRotaTool(stack, P.F, 'rota_workload_summary', { assignee: 'team', teamLevel: 'department' });
  assert.equal(denied.result.ok, false);
  assert.equal(JSON.stringify(denied.result).includes('Yazılım'), false);
});

/* ── Örgütsel kırılım ─────────────────────────────────────────── */

test('örgütsel kırılım yalnızca kimliği açık sorumluların birimini kullanır; farklı birimlerdeki ortak sorumlu örtüşmeyi görünür kılar', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = executiveBenchmarkSeed();
  const stack = createAiStack(t, { sicil: P.B, seed, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  const { result } = await callRotaTool(stack, P.B, 'rota_task_analytics', { assignee: 'team', teamLevel: 'department', groupBy: 'unit' });
  assert.equal(result.ok, true);
  const sum = result.data.groups.reduce((total, group) => total + group.count, 0);
  assert.ok(sum > result.data.totals.total, 'ortak sorumlu iki birimde sayılır (örtüşme)');
  assert.ok(result.data.definitions.organization.includes('toplanmaz'));
  // Kişi düzeyinde kimliği kapalı ortak sorumlunun birimi açıklanmaz: çalışan profili kısmi görünümde başka birim görmez.
  const employee = createAiStack(t, { sicil: P.A, seed: executiveBenchmarkSeed(), env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  const own = await callRotaTool(employee, P.A, 'rota_task_analytics', { assignee: 'me', groupBy: 'department' });
  assert.equal(own.result.ok, true);
  assert.deepEqual(own.result.data.groups.map((group) => group.label).filter((label) => !['Yazılım', 'Birimi belirtilmemiş', 'Sorumlu bilgisi gösterilemiyor'].includes(label)), [],
    'çalışanın kendi görevlerinde yalnızca kendi ve kimliği açık eş sorumluların birimleri');
});

test('örgütsel gruplar kalıcı kanıtta kimlik kökenini taşır; yeniden açılışta yönetim kapsamı kaybı birim etiketini gizler', async (t) => {
  const { ask, stack } = conversation(t, 'B');
  const item = fixture.scenarios.find((entry) => entry.id === 'g43');
  const result = await ask({ text: item.text, plan: resolve(item.plan) });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  const conversationId = result.done.conversation.id;
  // Yetki kaybı: bölüm yönetim kapsamı kaldırılır; kayıtlı yanıt güncel yetkiyle yeniden doğrulanır.
  stack.db.executiveScope = stack.db.executiveScope.filter((entry) => !(entry.ManagerSicil === P.B && entry.ScopeType === 'DEPARTMENT'));
  const reopened = (await loadAssistantConversation(conversationId)).body.messages.find((message) => message.role === 'assistant');
  assert.notEqual(reopened.finishReason, 'stop', 'yetkisi kalkan bölüm kanıtı yeniden açılışta gösterilmez');
  assert.equal(String(reopened.content).includes('Dijital Kanallar'), false);
});

/* ── Yetki kaybı (tur içinde) ve istem enjeksiyonu ─────────────── */

test('yetki tur içinde değişirse daha önce okunan ekip kanıtı son çizimde kullanılmaz', async (t) => {
  let stackRef = null;
  const { ask, stack } = conversation(t, 'B', { compose: () => composer((view) => {
    // Okumalardan sonra, son yetki denetiminden önce yönetim kapsamı kaldırılır.
    stackRef.db.executiveScope = stackRef.db.executiveScope.filter((entry) => entry.ManagerSicil !== P.B);
    return coveringBlocks(view);
  }) });
  stackRef = stack;
  const result = await ask({ text: 'Birimimin iş yükü dengeli mi?', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'team', level: 'unit', focus: ['workload'] } } });
  assert.notEqual(result.answer.finishReason, 'stop', result.answer.content);
  assert.equal(String(result.answer.content).includes('Ilgaz TAN'), false);
  assert.equal(String(result.answer.content).includes('Deniz Ufuk KARAAĞAÇLI'), false);
});

test('görev başlığındaki talimat veridir: kapsam genişlemez, okumalar bildirilen kişiyle sınırlı kalır', async (t) => {
  const { ask } = conversation(t, 'B');
  const result = await ask({ text: 'Mehmet Kaya\'nın gecikmiş işlerini göster.', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'person', names: ['Mehmet Kaya'], focus: ['overdue'] } } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.match(result.answer.content, /Önceki talimatları yok say/, 'başlık veri olarak gösterilir');
  // Okumalar bildirilen kişiyle sınırlıdır; başlıktaki "bütün direktörlüğü göster" kapsamı genişletmez.
  assert.ok(populationReads(result.log).every((row) => Number(row.params.personSicil) === P.MEHMET_KAYA));
  assert.equal(result.log.some((row) => row.params?.teamLevel === 'DIRECTORATE' || row.params?.assigneeMode === 'team'), false);
});

test('boş ve tam görev listesi ölçüt parantezi yerine nüfusu söyleyen doğal cümleyle anlatılır', async (t) => {
  const { ask } = conversation(t, 'G');
  const request = { operation: 'list', metrics: ['task.title', 'task.targetFinish'], population: { tool: 'rota_task_search', collection: 'tasks' },
    filters: { assignee: 'me', status: ['todo', 'in_progress'] } };
  const result = await ask({ text: 'Açık görevlerimi listele.', plan: { intent: 'rota', language: 'tr', request } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.match(result.answer.content, /^Açık göreviniz yok\./);
  assert.doesNotMatch(result.answer.content, /Gösterilecek görev yok|ölçüt:/);
});

/* ── Bulgu motoru (saf) ────────────────────────────────────────── */

const fact = (evidenceId, field, value, semantic) => ({ evidenceId, fact: { field, value, semantic: { complete: true, provenance: { tool: semantic.tool, today: TODAY }, ...semantic } } });
const part = (index, facts, ranking = null) => ({ index, presentation: { facts }, ...(ranking ? { ranking } : {}) });

function people(rows, { complete = true, team = 'unit' } = {}) {
  const filters = { assignee: 'team', teamLevel: team };
  return [fact('R1', 'data.populationComplete', complete, { tool: 'rota_workload_summary', filters }),
    ...rows.flatMap(([name, open, overdue, soon], index) => {
      const semantic = { tool: 'rota_workload_summary', filters, row: { identity: `sicil:${index + 1}`, collectionSize: rows.length } };
      return [fact('R1', `data.people.${index}.name`, name, semantic), fact('R1', `data.people.${index}.openTasks`, open, semantic),
        fact('R1', `data.people.${index}.overdue`, overdue, semantic), fact('R1', `data.people.${index}.dueNext7Days`, soon, semantic)];
    })];
}

test('iş yükü yayılımı yalnızca tam kadroda kurulur; eşit gecikmede adlar birlikte, işlemsel dille söylenir', () => {
  const rows = [['Ayşe', 6, 3, 1], ['Burak', 4, 3, 0], ['Can', 0, 0, 0]];
  const findings = analyticalFindings([part(0, people(rows))]);
  const spread = findings.find((item) => item.kind === 'workloadSpread');
  assert.deepEqual(spread.metrics, { people: 3, min: 0, max: 6, zero: 1 });
  const leader = findings.find((item) => item.kind === 'overdueLeader');
  assert.deepEqual(leader.names, ['Ayşe', 'Burak']);
  const intro = synthesisNarrative(findings).intro;
  const text = [intro.plain, intro.insights?.plain].join(' ');
  assert.match(text, /3 kişinin açık görev sayısı 0 ile 6 arasında değişiyor; 1 kişinin görünür açık görevi yok, bu boşta olduğu anlamına gelmiyor/);
  assert.match(text, /görev adedidir; işin büyüklüğünü, harcanan emeği ya da boş kapasiteyi göstermez/);
  assert.match(text, /Ayşe ve Burak üzerinde \(ikisinde de 3 gecikmiş görev\); bu bir atama dağılımıdır, performans yargısı değildir/);
  assert.equal(analyticalFindings([part(0, people(rows, { complete: false }))]).some((item) => ['workloadSpread', 'overdueLeader'].includes(item.kind)), false, 'eksik kadroda yok');
  // Kişinin en çok açık işi taşıması bir öncelik gerekçesi değildir.
  assert.equal(synthesisNarrative(findings).conclusion?.plain?.includes('en çok açık işi olan kişi') ?? false, false);
});

function portfolio(rows) {
  return rows.flatMap(([name, open, overdue, soon, done], index) => {
    const semantic = { tool: 'rota_portfolio_summary', filters: {}, row: { identity: `p${index + 1}`, collectionSize: rows.length } };
    return [fact('R1', `data.projects.${index}.name`, name, semantic), fact('R1', `data.projects.${index}.tasks.open`, open, semantic),
      fact('R1', `data.projects.${index}.tasks.overdue`, overdue, semantic), fact('R1', `data.projects.${index}.tasks.dueNext7Days`, soon, semantic),
      ...(done == null ? [] : [fact('R1', `data.projects.${index}.tasks.done`, done, semantic)])];
  });
}

test('tamamlanmaya karşın gecikme, görev sayısı ≠ baskı ve oran ile sayının ayrışması tam tablodan sunucuda hesaplanır', () => {
  const findings = analyticalFindings([part(0, portfolio([['Alfa', 12, 5, 4, 2], ['Beta', 3, 2, 0, 7], ['Gama', 7, 0, 3, 3], ['Delta', 4, 3, 1, 1]]))]);
  const despite = findings.find((item) => item.kind === 'completionDespiteOverdue');
  assert.deepEqual(despite.items.map((item) => [item.name, item.share, item.overdue]), [['Beta', 70, 2]]);
  const contrast = findings.find((item) => item.kind === 'volumeVsDelay');
  assert.deepEqual(contrast.pair.map((item) => item.name), ['Gama', 'Delta']);
  const rate = findings.find((item) => item.kind === 'overdueRateLeader');
  assert.deepEqual([rate.names, rate.metrics.share, rate.metrics.leader.name], [['Delta'], 75, 'Alfa']);
  // Küçük paydalar oran karşılaştırmasına girmez; tamamlanma için en az görev sayısı gerekir.
  const small = analyticalFindings([part(0, portfolio([['Alfa', 12, 5, 4, 2], ['Beta', 1, 1, 0, 2], ['Gama', 7, 0, 3, 3]]))]);
  assert.equal(small.some((item) => item.kind === 'overdueRateLeader'), false);
  assert.equal(small.some((item) => item.kind === 'completionDespiteOverdue'), false);
  // Tamamlanan sütunu yoksa tamamlanma yargısı kurulmaz.
  assert.equal(analyticalFindings([part(0, portfolio([['Alfa', 12, 5, 4], ['Beta', 3, 2, 0], ['Gama', 7, 0, 3]]))]).some((item) => item.kind === 'completionDespiteOverdue'), false);
});

function projectGroups(rows, filters = { assignee: 'team', teamLevel: 'unit' }) {
  return rows.flatMap(([label, open, overdue, done], index) => {
    const semantic = { tool: 'rota_task_analytics', filters, groupBy: 'project', group: { key: `p${index + 1}`, label }, row: { identity: `p${index + 1}`, collectionSize: rows.length } };
    return [fact('R1', `data.groups.${index}.label`, label, semantic), fact('R1', `data.groups.${index}.open`, open, semantic),
      fact('R1', `data.groups.${index}.overdue`, overdue, semantic), fact('R1', `data.groups.${index}.done`, done, semantic)];
  });
}

test('proje grubunun adı doğrulanmış koduyla anılır (listede görünmeyen adaş proje dışlanamaz); analiz paragrafı en çok dört cümledir', () => {
  const unique = analyticalFindings([part(0, projectGroups([['KAP · KAP TOOL', 8, 4, 1], ['MPO · Müşteri Portalı', 5, 0, 2], ['ALT · Altyapı Yenileme', 5, 3, 1], ['BGS · BGS Şube Çalışmaları', 6, 3, 7]]))]);
  const text = [synthesisNarrative(unique).intro.plain, synthesisNarrative(unique).intro.insights?.plain].join(' ');
  assert.match(text, /KAP · KAP TOOL projesi/, 'grup listesi adın tekilliğini kanıtlamaz: kod korunur');
  const twins = analyticalFindings([part(0, projectGroups([['OPA · Ortak Platform', 2, 1, 0], ['OPB · Ortak Platform', 1, 0, 0], ['KAP · KAP TOOL', 8, 4, 1]]))]);
  const names = twins.flatMap((item) => [item.entity?.name, ...(item.names || []), ...(item.pair || []).map((row) => row.name)]).filter(Boolean);
  assert.ok(names.every((name) => name !== 'Ortak Platform'), 'adaş proje kodsuz anılmaz');
  // Uzun analiz paragrafı bulgu sınırında bölünür; hiçbir paragraf dört cümleyi aşmaz.
  const many = analyticalFindings([part(0, portfolio([['Alfa', 12, 5, 4, 2], ['Beta', 3, 2, 0, 7], ['Gama', 7, 0, 3, 3], ['Delta', 4, 3, 1, 1]])),
    part(1, milestones([['Faz 1', shift(-9), 9], ['Pilot', shift(12), null]]), { metric: 'task.targetFinish', order: 'asc', limit: 8 })]);
  const insights = synthesisNarrative(many).intro.insights;
  for (const paragraph of insights.paragraphs || [insights]) assert.ok(paragraph.plain.split(/(?<=\.)\s+(?=[A-ZÇĞİÖŞÜ*0-9])/u).length <= 4, paragraph.plain);
  // Bir bulgunun cümleleri (kilometre taşı durumu, çekincesi ve sıradaki) aynı paragraftadır.
  assert.ok((insights.paragraphs || [insights]).some((paragraph) => /kilometre taşından[\s\S]*sıradaki ise[\s\S]*kritik yolu hesaplamaz/.test(paragraph.plain)));
});

function milestones(rows, { total = rows.length, complete = true } = {}) {
  const filters = { statuses: ['todo', 'in_progress'], milestone: true, projectId: 'p1', project: 'Alfa' };
  return [fact('R3', 'totalCount', total, { tool: 'rota_task_search', filters, complete }),
    ...rows.flatMap(([title, due, days], index) => {
      const semantic = { tool: 'rota_task_search', filters, complete, row: { identity: `t${index}`, collectionSize: rows.length, projectId: 'p1' } };
      return [fact('R3', `data.tasks.${index}.title`, title, semantic), ...(due ? [fact('R3', `data.tasks.${index}.targetFinish`, due, semantic)] : []),
        ...(days != null ? [fact('R3', `data.tasks.${index}.overdueDays`, days, semantic)] : [])];
    })];
}

test('kilometre taşı durumu: gecikmiş sayısı, en uzun gecikme ve sıradaki kilometre taşı; termini olmayan satırda yargı kurulmaz', () => {
  const ranking = { metric: 'task.targetFinish', order: 'asc' };
  const findings = analyticalFindings([part(0, milestones([['Faz 1', shift(-9), 9], ['Pilot', shift(12), null]]), ranking)]);
  const status = findings.find((item) => item.kind === 'milestoneStatus');
  assert.deepEqual([status.metrics.open, status.metrics.overdue, status.metrics.worst.title, status.metrics.next.title], [2, 1, 'Faz 1', 'Pilot']);
  const narrative = synthesisNarrative(findings);
  assert.match(narrative.intro.plain, /tek başına kanıtlamaz, çünkü Rota kritik yolu hesaplamaz/);
  assert.match(narrative.conclusion.plain, /Faz 1 — gecikmiş kilometre taşı/);
  // Termini olmayan açık kilometre taşı varsa "hiçbiri gecikmiş değil" ya da sayım yargısı kurulmaz.
  const undated = analyticalFindings([part(0, milestones([['Faz 1', shift(3), null], ['İmza', null, null]]), ranking)]);
  assert.equal(undated.some((item) => item.kind === 'milestoneStatus'), false);
  // Kesik listede (başı) gecikmiş sayısı ancak sıradaki tarih görünürse kesindir.
  const head = analyticalFindings([part(0, milestones([['A', shift(-5), 5], ['B', shift(-3), 3]], { total: 6, complete: false }), ranking)]);
  assert.equal(head.find((item) => item.kind === 'milestoneStatus').metrics.overdueExact, false);
});

test('kapsamlar arası karşılaştırma yalnızca aynı tanımlı oranları yan yana koyar ve iç içe kapsamı açıkça söyler', () => {
  const layer = (evidenceId, filters, open, overdue, completion) => ['open', 'overdue', 'completionRatePercent'].map((key, index) => fact(evidenceId, `data.totals.${key}`,
    [open, overdue, completion][index], { tool: 'rota_task_analytics', filters }));
  const findings = analyticalFindings([part(0, layer('R1', { assignee: 'me' }, 5, 1, 17)), part(1, layer('R2', { assignee: 'team', teamLevel: 'unit' }, 37, 14, 27)),
    part(2, layer('R3', { assignee: 'team', teamLevel: 'department' }, 46, 17, 27))]);
  const level = findings.find((item) => item.kind === 'levelComparison');
  assert.equal(level.layers.length, 3);
  const text = synthesisNarrative(findings).intro.plain;
  // Giriş kapsamları oranla karşılaştırır; sayılar her kapsamın kendi bölümündedir (yinelenmez).
  assert.match(text, /Açık işlerde gecikme oranı en yüksek biriminizde \(%38\); bu oran kendi işlerinizde %20 ve bölümünüzde %37/);
  assert.doesNotMatch(text, /37 açık görevin 14'ü/);
  // İç içe kapsam örneği karşılaştırılan kapsamlardan kurulur (en dar ekip düzeyi en geniş düzeyin içinde).
  assert.match(text, /iç içe olabildiğinden \(ör\. biriminizin işleri bölümünüzün sayılarında da yer alır\) sayılar toplanmaz/);
  const portfolio = synthesisNarrative(analyticalFindings([part(0, layer('R1', { assignee: 'any' }, 67, 25, 23)), part(1, layer('R2', { assignee: 'team', teamLevel: 'unit' }, 37, 14, 27))])).intro.plain;
  assert.match(portfolio, /ör\. biriminizin işleri görebildiğiniz bütün işlerin içinde de yer alır/, 'görünür bütün işler ("any") de bir kapsamdır');
  const pair = synthesisNarrative(analyticalFindings([part(0, layer('R1', { assignee: 'me' }, 5, 1, 17)), part(1, layer('R2', { assignee: 'team' }, 37, 14, 27))])).intro.plain;
  assert.match(pair, /ortak sorumlu olduğunuz bir görev iki kapsamda da sayılabildiğinden/, 'kendi işleri ekip okumasının parçası değildir');
  assert.doesNotMatch(text, /\b88\b|\b97\b/, 'kapsam sayıları toplanmaz');
  // İki kişinin karşılaştırması kapsam karşılaştırması değildir.
  const people = analyticalFindings([part(0, layer('R1', { assignee: 'person', personSicil: 1, person: 'Ayşe' }, 5, 1, 17)), part(1, layer('R2', { assignee: 'me' }, 3, 1, 10))]);
  assert.equal(people.some((item) => item.kind === 'levelComparison'), false);
});

/* ── Model görünür şema ve sınırlar ────────────────────────────── */

test('model görünür plan şeması küçük kalır; yeni yönler ve ek kapsamlar şemada, yinelenen açıklamalar ek isteklerde yok', () => {
  const tool = typedPlanningTool(toolCatalogForModel());
  assert.ok(JSON.stringify(tool).length < 32000, String(JSON.stringify(tool).length));
  assert.ok(analysisSchema().properties.focus.items.enum.includes('org') && analysisSchema().properties.focus.items.enum.includes('milestones'));
  assert.equal(analysisSchema().properties.also.maxItems, ANALYSIS_LIMITS.maxLayers - 1);
  const additional = JSON.stringify(tool.parameters.properties.additionalRequests.items);
  // Açıklama anahtarı (metin) yoktur; "description" yalnızca textFields seçeneği olarak geçebilir.
  assert.equal(/"description":"/.test(additional), false);
  // Doğrulama tam şemayladır: model görünür sadeleştirme kabulü genişletmez.
  assert.throws(() => parseAnalysis({ scope: 'team', level: 'sector', focus: ['overview'] }), (error) => error.details.some((detail) => detail.startsWith('$.analysis.level')));
});

test('örgütsel kırılım kapsamın bir alt düzeyidir; birim düzeyinin altı kişilerdir; kendi işlerinde reddedilir', () => {
  const groupBy = (raw) => expandAnalysis(parseAnalysis(raw), { today: TODAY }).map((item) => item.population.groupBy || item.population.tool);
  assert.deepEqual(groupBy({ scope: 'team', level: 'directorate', focus: ['org'] }), ['department']);
  assert.deepEqual(groupBy({ scope: 'team', level: 'department', focus: ['org'] }), ['unit']);
  assert.deepEqual(groupBy({ scope: 'team', level: 'unit', focus: ['org'] }), ['rota_workload_summary']);
  assert.throws(() => expandAnalysis(parseAnalysis({ scope: 'self', focus: ['org'] }), { today: TODAY }), (error) => error.details.includes('$.analysis.focus:unsupported'));
});

test('G bulgularının ayırt edici cümleleri kıyas denetleyicisiyle uyumludur', () => {
  for (const [kind, pattern] of Object.entries(G_FINDING_TEXT)) assert.ok(pattern instanceof RegExp, kind);
  assert.ok(renderedCharts('').length === 0);
});
