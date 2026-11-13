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
const { parseAnalysis, expandAnalysis, analysisLayers, ANALYSIS_LIMITS, analysisSchema } = await import('../src/server/ai/tools/analysisPlan.js');
const { renderLayerOmissions } = await import('../src/domain/ai/plannerOutcome.js');
const { unpackTypedPlan, typedPlanningTool } = await import('../src/server/ai/tools/executionSet.js');
const { toolCatalogForModel } = await import('../src/server/ai/tools/toolRegistry.js');
const { analyticalFindings, synthesisNarrative } = await import('../src/domain/ai/analyticalFindings.js');
const { executiveExpectation, executiveTurnExpectation, plannerScore } = await import('../scripts/analysis-qualification.mjs');
const { parseRequestDeclaration } = await import('../src/server/ai/tools/requestDeclaration.js');
const { completeRequest } = await import('../src/server/ai/tools/requestPopulation.js');

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
  // Birincil kapsam, ek kapsamlar ve açık isteklerin adlı varlıkları da sentetik olmalıdır (her turda).
  const named = (plan) => [...(plan?.analysis?.names || []), ...(plan?.analysis?.also || []).flatMap((layer) => layer.names || []),
    ...[plan?.request, ...(plan?.additionalRequests || [])].flatMap((request) => (request?.entities || []).map((entity) => entity.text).filter(Boolean))];
  for (const item of [...fixture.scenarios, ...fixture.holdout]) {
    const plans = (item.turns || [{ plan: item.plan }]).map((turn) => turn.plan);
    for (const name of [...plans.flatMap(named), ...(item.expect?.names || [])]) assert.ok(known.has(name), `${item.id}: ${name}`);
  }
});

/* ── Altın planlı kabul ─────────────────────────────────────────── */

for (const item of fixture.scenarios.filter((entry) => entry.plan || entry.turns)) {
  test(`G kıyas ${item.id} (${item.persona}, ${item.handling}): ${item.capabilities.join(', ')}`, async (t) => {
    const { ask } = conversation(t, item.profile);
    const turns = item.turns || [{ text: item.text, plan: item.plan }];
    let result = null;
    for (const [index, turn] of turns.entries()) {
      result = await ask({ text: turn.text, plan: resolve(turn.plan) });
      // Son turdan önceki turlar (ör. yetki reddinden önceki birim okuması) kendi altın planlarının kapsamıyla başarılı olmalıdır
      // (canlı nitelendirmeyle aynı ara tur beklentisi).
      if (index < turns.length - 1) assert.deepEqual(turnViolations(result, executiveTurnExpectation(item, index)), [], `${item.id} tur ${index + 1}: ${result.answer.content}`);
    }
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
    // Yetkisiz kapsamın kanıtı ve başarılı okuması `turnViolations` içinde denetlenir (canlı nitelendirmeyle aynı denetim).
    // Bileşik risk puanı, kapasite yüzdesi ya da kişi performans yargısı hiçbir yanıtta üretilmez.
    assert.doesNotMatch(content, /risk puanı \*\*|kapasite(?:si)? \*\*%|performansı (?:düşük|zayıf)/u);
  });
}

test('ayrık küme puanı: çok kapsamlı beklentide her kapsam bildirilmelidir; birden çok doğru karar kabul edilir', () => {
  const read = (filters) => ({ operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' }, filters });
  const self = read({ assignee: 'me' });
  const unit = read({ assignee: 'team', teamLevel: 'unit' });
  const planned = (analysis, requests = [self, unit]) => ({ outcome: 'planned', decisions: [{ intent: 'rota' }], plan: { analysis, requests } });
  const expect = { intent: 'rota', layers: [{ scope: 'self' }, { scope: 'team', level: 'unit' }] };
  assert.deepEqual(plannerScore(planned({ scope: 'self', focus: ['overview'], also: [{ scope: 'team', level: 'unit', focus: ['overview'] }] }), expect), []);
  assert.deepEqual(plannerScore(planned({ scope: 'self', focus: ['overview'] }, [self]), expect), ['kapsam team/unit bildirilmedi', 'kapsam team/unit okunmadı']);
  // x09: özetsiz açık plan (istek + ek istek) kapsamlarını okumalarıyla karşılar; bildirim denetimi uygulanmaz, okuma denetimi uygulanır.
  assert.deepEqual(plannerScore(planned(undefined), expect), [], 'özetsiz açık plan bildirilmedi diye reddedilmemeli');
  assert.deepEqual(plannerScore(planned(undefined, [self]), expect), ['kapsam team/unit okunmadı'], 'özetsiz planda eksik kapsam okuması yine yakalanmalı');
  // Kabul edilen kararın özeti kapsamları `layers` olarak taşır.
  assert.deepEqual(plannerScore(planned({ scope: 'self', focus: ['overview'], layers: [{ scope: 'self', focus: ['overview'] }, { scope: 'team', level: 'unit', focus: ['overview'] }] }), expect), []);
  assert.deepEqual(plannerScore(planned({ scope: 'team', level: 'department', focus: ['overview'], also: [{ scope: 'self', focus: ['overview'] }] }, [self, read({ assignee: 'team', teamLevel: 'department' })]), expect),
    ['kapsam team/unit bildirilmedi', 'kapsam team/unit okunmadı', 'beklenmeyen kapsam team/department bildirildi', 'beklenmeyen kapsam okundu'], 'düzey farklıysa kapsam aynı değildir; farklı düzey beklenmeyen kapsamdır');
  // Kapsam listede bildirilmiş ama açılımı o kapsamın nüfusunu okumuyorsa geçmez.
  assert.deepEqual(plannerScore(planned({ scope: 'self', focus: ['overview'], also: [{ scope: 'team', level: 'unit', focus: ['overview'] }] }, [self]), expect), ['kapsam team/unit okunmadı']);
  // Birden çok doğru kararlı vakada planlanmış sonuç da kapsamıyla puanlanır.
  assert.deepEqual(plannerScore(planned({ scope: 'team', level: 'unit', focus: ['overview'] }, [unit]), { intentAny: ['rota', 'abstain'], scope: 'self' }), ['kapsam team ≠ self']);
  // Adlı kapsam kimliğiyle eşleşir: aynı türden başka kişi/proje okuması karşılamaz; portföy kapsamı koşulsuz görev okumasıyla geçmez.
  const named = (text) => ({ operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' }, entities: [{ type: 'person', query: text }] });
  const personExpect = { intent: 'rota', layers: [{ scope: 'self' }, { scope: 'person', names: ['Elif Arslan'] }] };
  const personPlan = (name) => planned({ scope: 'self', focus: ['overview'], also: [{ scope: 'person', names: [name], focus: ['overview'] }] }, [self, named(name)]);
  assert.deepEqual(plannerScore(personPlan('Elif Arslan'), personExpect), []);
  assert.deepEqual(plannerScore(personPlan('Can Demir'), personExpect), ['kapsam person bildirilmedi', 'kapsam person okunmadı', 'beklenmeyen kapsam person bildirildi', 'beklenmeyen kapsam okundu']);
  const portfolioExpect = { intent: 'rota', layers: [{ scope: 'self' }, { scope: 'projects' }] };
  const all = { ...read({}), entities: [] };
  assert.deepEqual(plannerScore(planned({ scope: 'self', focus: ['overview'], also: [{ scope: 'projects', focus: ['overview'] }] }, [self, all]), portfolioExpect), ['kapsam projects okunmadı']);
  const list = { operation: 'list', metrics: ['project.name'], population: { tool: 'rota_portfolio_summary', collection: 'projects' }, entities: [] };
  assert.deepEqual(plannerScore(planned({ scope: 'self', focus: ['overview'], also: [{ scope: 'projects', focus: ['overview'] }] }, [self, all, list]), portfolioExpect), []);
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
  // Kendi + tek adlı kişi ek kapsamı, yönleri satır istemiyorsa ve AYNIYSA "kendimi X ile karşılaştır"dır: kişi kapsamı + kendiyle karşılaştırma.
  for (const analysis of [{ scope: 'self', focus: ['workload', 'overview'], also: [{ scope: 'person', names: ['Elif Arslan'], focus: ['overview', 'workload'] }] },
    { scope: 'person', names: ['Elif Arslan'], focus: ['workload'], also: [{ scope: 'self' }] }]) {
    const paired = unpack({ intent: 'rota', language: 'tr', analysis }).plan.analysis;
    assert.deepEqual([paired.scope, paired.names, paired.withSelf, paired.also, [...paired.focus].sort()], ['person', ['Elif Arslan'], true, undefined, [...analysis.focus].sort()]);
  }
  // Yönleri farklı kapsamlar katlanmaz: her kapsam yalnızca kendi yönleriyle okunur (bir kapsamın yönü öbür özneye uygulanmaz).
  for (const analysis of [{ scope: 'self', focus: ['overdue'], also: [{ scope: 'person', names: ['Elif Arslan'], focus: ['overview'] }] },
    { scope: 'person', names: ['Elif Arslan'], focus: ['overdue'], also: [{ scope: 'self', focus: ['overview'] }] }]) {
    const layered = unpack({ intent: 'rota', language: 'tr', analysis }).plan.analysis;
    assert.equal(layered.withSelf, undefined);
    assert.deepEqual([layered.scope, [...layered.focus], layered.also.map((layer) => [layer.scope, [...layer.focus]])],
      [analysis.scope, ['overdue'], [[analysis.also[0].scope, ['overview']]]]);
  }
  // Bulgunun kendisi: kendi genel görünümü + kişinin üç termin yönü katlanınca sekiz okumaya büyüyüp reddediliyordu; ayrı kapsamlar sığar.
  const separate = unpack({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'], also: [{ scope: 'person', names: ['Elif Arslan'], focus: ['priority', 'deadlines', 'schedule'] }] } }).plan;
  assert.ok([separate.request, ...(separate.additionalRequests || [])].length <= ANALYSIS_LIMITS.maxParts);
  assert.equal(separate.analysis.omitted, undefined, 'bildirilen hiçbir yön düşmez');
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

test('özetin yanındaki ad araması atılır; adlı kapsamda boş seçicili okuma, bildirilmemiş ad ya da başka seçici planı reddeder', () => {
  const analysis = { scope: 'person', names: ['Nehir SÜRMELİOĞLU'], withSelf: true, focus: ['overview', 'workload'] };
  const accepted = unpack({ intent: 'rota', language: 'tr', analysis: { ...analysis, scope: 'self' },
    calls: [{ name: 'rota_person_search', arguments: { text: 'Nehir SÜRMELİOĞLU' } }] });
  assert.equal(accepted.plan.analysis.scope, 'person', 'kendi + tek ad + kendiyle karşılaştırma kişi kapsamıdır');
  assert.deepEqual(accepted.calls, []);
  // Boş seçici adlı kişinin nüfusu değil görünür bütün kişilerdir: kişi kapsamıyla eşdeğer sayılıp sessizce atılmaz.
  for (const call of [{ name: 'rota_workload_summary', arguments: { limit: 10 } }, { name: 'rota_task_search', arguments: {} }]) {
    assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis, calls: [{ name: 'rota_person_search', arguments: { text: 'Nehir SÜRMELİOĞLU' } }, call] }), ['$.analysis:request'], call.name);
  }
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'project', names: ['BGS Şube Çalışmaları'], focus: ['overview'] },
    calls: [{ name: 'rota_task_search', arguments: {} }] }), ['$.analysis:request'], 'adlı proje kapsamı da boş seçiciyle eşleşmez');
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis, calls: [{ name: 'rota_task_search', arguments: { projectId: EXEC_PROJECTS.BGS } }] }), ['$.analysis:request']);
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis, calls: [{ name: 'rota_person_search', arguments: { text: 'Elif Arslan' } }] }), ['$.analysis:request']);
});

test('özetin yanındaki çağrı yalnızca özetin bir kapsamından başka koşul taşımıyorsa atılır; süzgeç, gruplama ya da iç içe seçici planı reddeder', () => {
  const self = { scope: 'self', focus: ['overview'] };
  const call = (name, args) => ({ intent: 'rota', language: 'tr', analysis: self, calls: [{ name, arguments: args }] });
  // Özetin kapsamının aynısı (kendi işleri) özetin okumasıdır: yürütülmeden atılır.
  assert.deepEqual(unpack(call('rota_task_analytics', { assignee: 'me', limit: 5 })).calls, []);
  // Özetin ifade etmediği koşul (gecikmiş liste, gruplama, iç içe süzgeç, başka kapsam) ayrı bir istektir: sessizce düşmez.
  for (const args of [{ assignee: 'me', deadline: 'overdue' }, { assignee: 'me', groupBy: 'status' }, { filters: { assignee: 'me', priority: ['high'] } },
    { entities: [{ type: 'project', text: 'BGS Şube Çalışmaları' }] }, { assignee: 'team' }]) {
    assert.deepEqual(reject(call('rota_task_search', args)), ['$.analysis:request'], JSON.stringify(args));
  }
  // Ek kapsamın adı da özetin adıdır: onun ad araması gereksizdir ve atılır.
  const layered = unpack({ intent: 'rota', language: 'tr', analysis: { ...self, also: [{ scope: 'project', names: ['BGS Şube Çalışmaları'] }] },
    calls: [{ name: 'rota_project_search', arguments: { text: 'BGS Şube Çalışmaları' } }] });
  assert.deepEqual(layered.calls, []);
});

test('çok kapsamlı özet: aynı kapsamın farklı yönleri birleşir, devralınan yön ve düzey yalnızca kendi kapsamına uygulanır', () => {
  // Birincille aynı kapsamın yönleri birincile katılır; yönü yazılmamış öbür kapsam özgün birincil yönleri korur.
  const merged = parseAnalysis({ scope: 'team', level: 'unit', focus: ['overview'], also: [{ scope: 'team', level: 'unit', focus: ['milestones'] }, { scope: 'self' }] });
  assert.deepEqual([...merged.focus], ['overview', 'milestones']);
  assert.deepEqual(merged.also.map((layer) => [layer.scope, [...(layer.focus || [])]]), [['self', ['overview']]]);
  // Ek kapsamlar arasında yinelenen kapsamın yönleri de birleşir (hiçbir yön düşmez).
  const twice = parseAnalysis({ scope: 'self', focus: ['overview'], also: [{ scope: 'team', level: 'unit', focus: ['org'] }, { scope: 'team', level: 'unit', focus: ['milestones'] }] });
  assert.deepEqual(twice.also.map((layer) => [...layer.focus]), [['org', 'milestones']]);
  // Ek kapsam birincilin düzeyini devralmaz: düzeysiz ekip kapsamının alt birim kırılımı bölümlerdir (birincil birimse kişiler değil).
  const sections = expandAnalysis(parseAnalysis({ scope: 'team', level: 'unit', focus: ['org'], also: [{ scope: 'team' }] }), { today: TODAY });
  const orgReads = sections.filter((part, index) => sections.sections[index].focus === 'org');
  assert.deepEqual(orgReads.map((part) => part.population.groupBy || part.population.tool), ['rota_workload_summary', 'department']);
  assert.equal(orgReads[1].filters.teamLevel, undefined);
  // Devralınan yön kapsamda anlamsızsa (kendi işlerinde alt birim kırılımı) yalnızca o kapsam için okunmaz; açıkça yazılmışsa reddedilir.
  const inherited = expandAnalysis(parseAnalysis({ scope: 'team', level: 'department', focus: ['org'], also: [{ scope: 'self' }] }), { today: TODAY });
  assert.deepEqual(inherited.sections.map((item) => [item.layer, item.focus]), [[0, null], [0, 'org'], [1, null]]);
  assert.throws(() => expandAnalysis(parseAnalysis({ scope: 'team', level: 'department', focus: ['org'], also: [{ scope: 'self', focus: ['org'] }] }), { today: TODAY }),
    (error) => error.details.includes('$.analysis.focus:unsupported'));
});

test('çok kapsamlı özet: dönemli durum ve gecikme her kapsam için o dönemle okunur; tamamen gelecekteki dönemde gecikme özettedir', () => {
  const window = { dateFrom: shift(-30), dateTo: shift(-1) };
  const reads = expandAnalysis(parseAnalysis({ scope: 'team', level: 'department', focus: ['status', 'overdue'], ...window, also: [{ scope: 'team', level: 'directorate' }] }), { today: TODAY });
  for (const level of ['department', 'directorate']) {
    const status = reads.find((part) => part.population.groupBy === 'status' && part.filters.teamLevel === level);
    assert.deepEqual([status?.filters.dateFrom, status?.filters.dateTo], [window.dateFrom, window.dateTo], `${level}: dönemli durum okunur`);
    assert.ok(reads.some((part) => part.filters?.deadline === 'overdue' && part.filters.teamLevel === level && part.filters.dateFrom === window.dateFrom), `${level}: dönemli gecikme okunur`);
  }
  // Dönemsiz durum özetle karşılanır; gecikme satır yönelimlidir: her kapsamın gecikmiş iş listesi okunur (sayı listeyi karşılamaz).
  const plain = expandAnalysis(parseAnalysis({ scope: 'self', focus: ['status', 'overdue'], also: [{ scope: 'team', level: 'unit' }] }), { today: TODAY });
  assert.equal(plain.filter((part) => part.population.groupBy === 'status').length, 0, 'dönemsiz durum özettedir');
  assert.deepEqual(plain.filter((part) => part.filters?.deadline === 'overdue').map((part) => part.filters.assignee), ['me', 'team']);
  const future = expandAnalysis(parseAnalysis({ scope: 'self', focus: ['overdue'], dateFrom: shift(0), dateTo: shift(13), also: [{ scope: 'team', level: 'unit' }] }), { today: TODAY });
  const overdue = future.filter((part) => part.filters?.deadline === 'overdue');
  assert.equal(overdue.length, 2, 'her kapsamın gecikmiş listesi okunur');
  assert.ok(overdue.every((part) => part.filters.dateFrom == null && part.filters.dateTo == null), 'gelecek dönem gecikme okumasından çıkar');
});

test('çok kapsamlı özet: gecikme ve yaklaşan iş listeleri sayılarla karşılanmış sayılmaz; bütçeye sığmayan liste adıyla bildirilir', () => {
  const sections = expandAnalysis(parseAnalysis({ scope: 'self', focus: ['overdue', 'upcoming'], also: [{ scope: 'team', level: 'unit', focus: ['overdue', 'upcoming'] }] }), { today: TODAY });
  const rows = sections.filter((part) => part.population.tool === 'rota_task_search');
  assert.deepEqual(rows.map((part) => [part.filters.assignee, part.filters.deadline]),
    [['me', 'overdue'], ['me', 'due_next_7_days'], ['team', 'overdue'], ['team', 'due_next_7_days']], 'her kapsamın sıralı listeleri');
  assert.deepEqual(sections.omitted, []);
  // Üç kapsam × iki liste + üç özet okuma tavanını aşar: birincilin listeleri okunur, sığmayanlar adıyla döner.
  const tight = expandAnalysis(parseAnalysis({ scope: 'self', focus: ['overdue', 'upcoming'], also: [{ scope: 'team', level: 'unit' }, { scope: 'team', level: 'department' }] }), { today: TODAY });
  assert.ok(tight.length <= ANALYSIS_LIMITS.maxParts);
  assert.ok(tight.omitted.length >= 1);
  const note = renderLayerOmissions({ omitted: tight.omitted, layers: analysisLayers(parseAnalysis({ scope: 'self', focus: ['overdue', 'upcoming'], also: [{ scope: 'team', level: 'unit' }, { scope: 'team', level: 'department' }] })) });
  assert.match(note, /gecikmiş işlerin listesi|yaklaşan teslimatların listesi/);
  // Dönemli durum ve gecikme yönlerinin okunmayan bölümleri de adıyla söylenir (sessiz düşürme yok).
  const windowed = renderLayerOmissions({ omitted: [{ layer: 0, focus: 'status' }, { layer: 0, focus: 'overdue' }], layers: [{ scope: 'self' }] });
  assert.match(windowed, /dönemdeki durum dağılımı ve gecikmiş işlerin listesi/);
});

test('çok kapsamlı özet: istenen grafiğin okuması birincil kapsamdan, bütçe kaldıysa eklenir; ek liste için yer ayrılır ve sığmayan yön adıyla bildirilir', () => {
  const donut = unpack({ intent: 'rota', language: 'tr', visual: true, chart: 'donut', analysis: { scope: 'self', focus: ['overview'], also: [{ scope: 'team', level: 'unit' }] } });
  const parts = [donut.plan.request, ...(donut.plan.additionalRequests || [])];
  const status = parts.findIndex((part) => part.population.groupBy === 'status');
  assert.ok(status >= 0, 'halka grafiği için durum dağılımı okunur');
  assert.equal(parts[status].filters.assignee, 'me', 'grafik birincil kapsamın tek nüfusundandır');
  assert.equal(donut.plan.analysis.sections[status].layer, 0);
  // Çok kapsamlı özet + açık liste: liste düşmez; sığmayan dağılım yönü `omitted` ile adıyla döner.
  const list = { operation: 'rank', metrics: ['task.title', 'task.targetFinish'], population: { tool: 'rota_task_search', collection: 'tasks' }, layout: 'list',
    filters: { assignee: 'me', priority: ['critical'] }, rank: { metric: 'task.targetFinish', order: 'asc', limit: 5 } };
  const combined = unpack({ intent: 'rota', language: 'tr', request: list, analysis: { scope: 'self', focus: ['overview', 'workload', 'milestones'],
    also: [{ scope: 'team', level: 'unit', focus: ['workload', 'projects'] }, { scope: 'team', level: 'department', focus: ['org'] }] } });
  const sectionsOf = [combined.plan.request, ...(combined.plan.additionalRequests || [])];
  assert.ok(sectionsOf.length <= ANALYSIS_LIMITS.maxParts);
  assert.ok(sectionsOf.some((part) => part.filters?.priority?.includes('critical')), 'açık liste okunur');
  assert.ok(combined.plan.analysis.omitted.length >= 1, 'sığmayan yön bildirilir');
  assert.equal(combined.plan.analysis.analysisParts, sectionsOf.length - 1, 'açık liste özetin bölümü değildir');
});

test('açık istek, özetin aynı okumasıysa ikinci kez okunmaz; satır sınırı ve biçim o okumaya taşınır, farklı sıralama ya da önceki sonuç ayrı tutulur', () => {
  const analysis = { scope: 'projects', focus: ['overview', 'projects'] };
  const portfolio = { operation: 'list', metrics: ['project.name', 'tasks.overdue'], population: { tool: 'rota_portfolio_summary', collection: 'projects' } };
  const base = unpack({ intent: 'rota', language: 'tr', analysis });
  const count = (plan) => [plan.request, ...(plan.additionalRequests || [])].filter((part) => part.population.tool === 'rota_portfolio_summary' && part.operation === 'list').length;
  assert.equal(count(base.plan), 1);
  // Aynı okuma + tablo biçimi: okunmaz, tercih taşınır.
  const table = unpack({ intent: 'rota', language: 'tr', analysis, request: { ...portfolio, layout: 'table' } }).plan;
  assert.equal(count(table), 1);
  assert.equal([table.request, ...(table.additionalRequests || [])].find((part) => part.population.tool === 'rota_portfolio_summary' && part.operation === 'list').layout, 'table');
  // Farklı sıralama düzeni ayrı okumadır (özetin gecikme sırası açık isteğin ad sırasının yerine geçmez).
  const sorted = unpack({ intent: 'rota', language: 'tr', analysis, request: { ...portfolio, population: { ...portfolio.population, sort: 'name_asc' } } }).plan;
  assert.equal(count(sorted), 2);
  // Görev sıralamasında açık satır sınırı korunur: beş satır istendiyse beş satır okunur (sekiz değil), ek okuma da yapılmaz.
  const upcoming = unpack(resolve(fixture.scenarios.find((entry) => entry.id === 'g51').plan)).plan;
  const lists = [upcoming.request, ...(upcoming.additionalRequests || [])].filter((part) => part.population.tool === 'rota_task_search');
  assert.deepEqual(lists.map((part) => [part.rank.limit, part.layout]), [[5, 'list']]);
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis, request: { ...portfolio, previousResult: true } }), ['$.analysis:request']);
});

test('dizi biçimli çok kapsamlı özet: ek öğenin taşıyamadığı alan ya da birincildeki ek kapsam sessizce düşmez, plan reddedilir', () => {
  const plan = (analysis) => ({ intent: 'rota', language: 'tr', analysis });
  assert.deepEqual(reject(plan([{ scope: 'self', focus: ['overview'] }, { scope: 'team', level: 'unit', within: 'BGS Şube Çalışmaları' }])), ['$.analysis.also[0].within:unknown']);
  assert.deepEqual(reject(plan([{ scope: 'self', focus: ['overview'] }, { scope: 'person', names: ['Nehir SÜRMELİOĞLU'], withSelf: true }])), ['$.analysis.also[0].withSelf:unknown']);
  assert.deepEqual(reject(plan([{ scope: 'self', focus: ['overview'], also: [{ scope: 'all' }] }, { scope: 'team', level: 'unit' }])), ['$.analysis.also:scope']);
  // Kendi + kişi yazımı, birincil daraltma (within) ya da ek kapsamda ayrı dönem taşıyorsa kişiyle karşılaştırmaya çevrilmez.
  assert.ok(reject(plan({ scope: 'self', within: 'BGS Şube Çalışmaları', focus: ['overview'], also: [{ scope: 'person', names: ['Nehir SÜRMELİOĞLU'] }] })).includes('$.analysis.also:scope'));
  assert.ok(reject(plan({ scope: 'self', focus: ['overview'], also: [{ scope: 'person', names: ['Nehir SÜRMELİOĞLU'], dateFrom: shift(0) }] })).some((detail) => detail.startsWith('$.analysis.also[0]')));
  assert.equal(unpack(plan([{ scope: 'self', focus: ['overview'] }, { scope: 'team', level: 'unit', focus: ['workload'] }])).plan.analysis.also.length, 1);
});

test('özet onarımı açık isteği koruyamazsa kabul edilmez: reddedilen yol dışındaki açık istek alanları ve istek sayısı aynı kalır', async (t) => {
  const request = { operation: 'rank', metrics: ['task.title', 'task.overdueDays'], population: { tool: 'rota_task_search' }, filters: { assignee: 'me', deadline: 'overdue' }, layout: 'list' };
  const analysis = { scope: 'self', focus: ['schedule'], dateFrom: shift(1), dateTo: shift(30) };
  const fixed = { ...request, rank: { metric: 'task.overdueDays', order: 'desc', limit: 8 } };
  // İlk plan geçersiz (sıralama alanı yok); onarım açık listeyi düşürür (kabul edilmez); sonraki onarım yalnızca reddedilen yolu düzeltir.
  const plans = [{ intent: 'rota', language: 'tr', analysis, request }, { intent: 'rota', language: 'tr', analysis }, { intent: 'rota', language: 'tr', analysis, request: fixed }];
  const planCall = (plan) => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plan }] });
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = executiveBenchmarkSeed();
  t.mock.timers.reset();
  const { ask } = phase4eConversation(t, { sicil: P.B, seed, planner: () => planCall(plans.shift() || plans.at(-1)) });
  const result = await ask({ text: 'Bu ayın terminlerini göster, sonra gecikmiş işlerimi sırala.' });
  assert.ok(result.inputs.length >= 3, 'açık listeyi düşüren onarım kabul edilmedi');
  assert.ok(populationReads(result.log).some((row) => row.params.deadline === 'overdue' || /overdue/i.test(JSON.stringify(row.params))), 'açık liste okundu');
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

test('kadro tamlığı: sayfa sınırla kesilince "bütün üyeler" denmez; toplu iş sırasında üyelik değiştiyse tamlık iddiası kurulmaz; kişi süzgecinde kadro okunmaz', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const stack = createAiStack(t, { sicil: P.B, seed: executiveBenchmarkSeed(), env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  const page = await callRotaTool(stack, P.B, 'rota_workload_summary', { assignee: 'team', teamLevel: 'unit', limit: 2 });
  assert.equal(page.result.data.notes.some((note) => /bütün ekip üyelerini içerir/.test(note)), false, 'kesik sayfa bütün üyeleri içermez');
  assert.ok(page.result.data.notes.some((note) => /ilk 2 üyeyle sınırlı/.test(note)));
  // Görev olguları ile kadro arasında üyelik değişti: kadro görev sayılarıyla aynı anı göstermez.
  stack.db.rosterMembershipChanged = true;
  const drift = await callRotaTool(stack, P.B, 'rota_workload_summary', { assignee: 'team', teamLevel: 'unit', limit: 25 });
  assert.equal(drift.result.data.populationComplete, false);
  assert.equal(drift.result.data.people.some((person) => person.sicil === EXEC_PEOPLE.ILGAZ), false, 'sıfır satır eklenmez');
  stack.db.rosterMembershipChanged = false;
  // Boş anlık görüntü değişim işaretini satırsız sonuçta taşıyamaz: boş kadro hiçbir zaman tam sayılmaz.
  // Ekibin tek üyesi görevsizdir: görev satırı da kadro satırı da yoktur; boş sonuç "bütün üyeler (0)" diye sunulmaz.
  const idleSeed = executiveBenchmarkSeed();
  idleSeed.executiveScope = idleSeed.executiveScope.filter((entry) => entry.ManagerSicil !== P.B).concat([{ ManagerSicil: P.B, EmployeeSicil: EXEC_PEOPLE.ILGAZ, ScopeType: 'UNIT' }]);
  const idle = createAiStack(t, { sicil: P.B, seed: idleSeed, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  idle.db.rosterSnapshotEmpty = true;
  const empty = await callRotaTool(idle, P.B, 'rota_workload_summary', { assignee: 'team', teamLevel: 'unit', limit: 25 });
  assert.equal(empty.result.ok, true, JSON.stringify(empty.result));
  assert.deepEqual([empty.result.data.people.length, empty.result.data.populationComplete], [0, false], 'boş kadro tamlık kanıtı değildir');
  assert.equal(empty.result.data.notes.some((note) => /bütün ekip üyelerini içerir/.test(note)), false);
  // Kişi süzgeci (ekip süzgeci yok): kadro okunmaz, yalnızca seçilen kişi döner.
  const person = await callRotaTool(stack, P.B, 'rota_workload_summary', { personSicil: EXEC_PEOPLE.SURMELIOGLU });
  assert.deepEqual(person.result.data.people.map((row) => row.sicil), [EXEC_PEOPLE.SURMELIOGLU]);
  assert.equal((stack.db.aiToolLog || []).some((row) => row.query === 'task-facts' && Number(row.params.withRoster) === 1 && Number(row.params.personSicil) === EXEC_PEOPLE.SURMELIOGLU), false);
});

test('kadrodan çıkan görevsiz üyenin adı kayıtlı ekip yanıtı yeniden açılınca gösterilmez (ekip kanıtı yalnızca aynı yetki döneminde açılır)', async (t) => {
  const { ask, stack } = conversation(t, 'B');
  const result = await ask({ text: 'Birimimin iş yükü dengeli mi?', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'team', level: 'unit', focus: ['workload'] } } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.ok(String(result.answer.content).includes('Ilgaz TAN'), 'görevsiz üye kadrodan eklenir');
  stack.db.executiveScope = stack.db.executiveScope.filter((entry) => Number(entry.EmployeeSicil) !== EXEC_PEOPLE.ILGAZ);
  const reopened = (await loadAssistantConversation(result.done.conversation.id)).body.messages.find((message) => message.role === 'assistant');
  assert.equal(String(reopened.content).includes('Ilgaz TAN'), false);
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
  // Birimler ve sayıları tam olarak beklenendir (her görev her birimde sayılsaydı ya da birim düşseydi bu eşitlik bozulurdu).
  assert.deepEqual(result.data.groups.map((group) => [group.label, group.count]), [['Uygulama Geliştirme', 28], ['Dijital Kanallar', 20], ['Altyapı Operasyon', 17]]);
  assert.equal(result.data.totals.total, 63);
  const sum = result.data.groups.reduce((total, group) => total + group.count, 0);
  assert.ok(sum > result.data.totals.total, 'ortak sorumlu iki birimde sayılır (örtüşme)');
  assert.ok(result.data.definitions.organization.includes('toplanmaz'));
  // Kişi düzeyinde kimliği kapalı ortak sorumlunun birimi açıklanmaz: çalışan profili kısmi görünümde başka birim görmez.
  const employee = createAiStack(t, { sicil: P.A, seed: executiveBenchmarkSeed(), env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  const own = await callRotaTool(employee, P.A, 'rota_task_analytics', { assignee: 'me', groupBy: 'department' });
  assert.equal(own.result.ok, true);
  assert.deepEqual(own.result.data.groups.map((group) => [group.label, group.count]), [['Yazılım', 12]],
    'çalışanın kendi görevlerinde yalnızca kendi ve kimliği açık eş sorumluların birimleri');
});

test('örgütsel kimlik hiyerarşik yoldur: farklı bölümlerdeki aynı adlı birimler birleşmez; birimi belirsiz sorumlu çözülemeyen sorumluyla karışmaz; sınırı aşan gruplar toplanmaz', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = executiveBenchmarkSeed();
  // Teknoloji Altyapısı bölümündeki bir kişinin birimi Yazılım bölümündeki birimle aynı adı taşır.
  Object.assign(seed.people.find((person) => person.Sicil === P.MEHMET_KAYA), { Unit: 'Uygulama Geliştirme' });
  // Birimi dizinde yazılmamış görünür sorumlu.
  Object.assign(seed.people.find((person) => person.Sicil === P.SELIN), { Unit: null });
  const stack = createAiStack(t, { sicil: P.B, seed, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  const { result } = await callRotaTool(stack, P.B, 'rota_task_analytics', { assignee: 'team', teamLevel: 'directorate', groupBy: 'unit', limit: 25 });
  const labels = result.data.groups.map((group) => group.label);
  assert.ok(labels.includes('Uygulama Geliştirme · Yazılım') && labels.includes('Uygulama Geliştirme · Teknoloji Altyapısı'), labels.join(' | '));
  assert.equal(new Set(result.data.groups.map((group) => group.key)).size, result.data.groups.length);
  const unknown = result.data.groups.find((group) => group.label === 'Birimi belirtilmemiş');
  assert.equal(unknown?.key, 'no_unit', 'birimi belirsiz grup çözülemeyen sorumlu grubundan ayrı anahtardır');
  // Sınırı aşan örgütsel gruplar toplanmış bir "diğer" satırına katılmaz (örtüşen sayıların toplamı yanlıştır); kesiklik bildirilir.
  const limited = await callRotaTool(stack, P.B, 'rota_task_analytics', { assignee: 'team', teamLevel: 'directorate', groupBy: 'unit', limit: 2 });
  assert.deepEqual([limited.result.data.groups.length, limited.result.data.groups.some((group) => group.key === 'other'), limited.result.truncated], [2, false, true]);
});

test('örgütsel gruplar: aynı adlı birim ve bölüm farklı direktörlüklerde bütün yolla ayrışır; yalnızca aksanı farklı birimler birleşmez; eksik bölüm ve çözülemeyen kayıt ayrı adlandırılır', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = executiveBenchmarkSeed();
  // Aynı birim ve bölüm adı, farklı direktörlükte (ad zinciri direktörlüğe kadar aynı değil).
  Object.assign(seed.people.find((person) => person.Sicil === P.MEHMET_KAYA), { Unit: 'Uygulama Geliştirme', Department: 'Yazılım', Directorate: 'Operasyon' });
  // Yalnızca aksanı farklı ayrı birim adı.
  const accentVariant = 'Dijital Kanallar'.replace('i', 'ı');
  assert.notEqual(accentVariant, 'Dijital Kanallar', 'aksan değişkesi gerçekten farklı bir addır');
  Object.assign(seed.people.find((person) => person.Sicil === P.BURAK), { Unit: accentVariant });
  const stack = createAiStack(t, { sicil: P.B, seed, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  const { result } = await callRotaTool(stack, P.B, 'rota_task_analytics', { assignee: 'team', teamLevel: 'directorate', groupBy: 'unit', limit: 25 });
  const labels = result.data.groups.map((group) => group.label);
  assert.ok(labels.includes('Uygulama Geliştirme · Bilgi Sistemleri › Yazılım') && labels.includes('Uygulama Geliştirme · Operasyon › Yazılım'), labels.join(' | '));
  assert.equal(new Set(labels).size, labels.length, 'görünen etiketler de tekildir');
  assert.ok(labels.includes('Dijital Kanallar') && labels.includes(accentVariant), `aksanı farklı birimler ayrı gruptur: ${labels.join(' | ')}`);
  // Bölüm kırılımında bölümü yazılmamış sorumlu "Bölümü belirtilmemiş"tir; dizin kaydı çözülemeyen sorumlu ayrı (çözülemeyen) gruptadır.
  Object.assign(stack.db.people.find((person) => person.Sicil === P.SELIN), { Department: null });
  stack.db.people = stack.db.people.filter((person) => person.Sicil !== P.MEHMET_YILDIZ);
  const departments = await callRotaTool(stack, P.B, 'rota_task_analytics', { assignee: 'team', teamLevel: 'directorate', groupBy: 'department', limit: 25 });
  const byKey = new Map(departments.result.data.groups.map((group) => [group.key, group.label]));
  assert.equal(byKey.get('no_unit'), 'Bölümü belirtilmemiş');
  assert.equal(byKey.get('unresolved'), 'Sorumlu kaydı çözülemiyor');
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
  // Adaş projelerden biri bulguda adlandırılır (gecikmede ilk sırada): adı doğrulanmış koduyla yazılır, kodsuz yazılmaz.
  const twins = analyticalFindings([part(0, projectGroups([['OPA · Ortak Platform', 9, 6, 0], ['OPB · Ortak Platform', 1, 0, 0], ['KAP · KAP TOOL', 4, 1, 1]]))]);
  const names = twins.flatMap((item) => [item.entity?.name, ...(item.names || []), ...(item.pair || []).map((row) => row.name)]).filter(Boolean);
  assert.ok(names.length > 0 && names.some((name) => /^OP[AB] · Ortak Platform$/.test(name)), `adaş proje bulguda kodla anılır: ${names.join(', ')}`);
  assert.ok(names.every((name) => name !== 'Ortak Platform'), 'adaş proje kodsuz anılmaz');
  // Uzun analiz paragrafı bulgu sınırında bölünür; hiçbir paragraf dört cümleyi aşmaz.
  const many = analyticalFindings([part(0, portfolio([['Alfa', 12, 5, 4, 2], ['Beta', 3, 2, 0, 7], ['Gama', 7, 0, 3, 3], ['Delta', 4, 3, 1, 1]])),
    part(1, milestones([['Faz 1', shift(-9), 9], ['Pilot', shift(12), null]]), { metric: 'task.targetFinish', order: 'asc', limit: 8 })]);
  const insights = synthesisNarrative(many).intro.insights;
  for (const paragraph of insights.paragraphs || [insights]) assert.ok(paragraph.plain.split(/(?<=\.)\s+(?=[A-ZÇĞİÖŞÜ*0-9])/u).length <= 4, paragraph.plain);
  // Bir bulgunun cümleleri (kilometre taşı durumu, çekincesi ve sıradaki) aynı paragraftadır.
  assert.ok((insights.paragraphs || [insights]).some((paragraph) => /kilometre taşından[\s\S]*sıradaki ise[\s\S]*kritik yolu hesaplamaz/.test(paragraph.plain)));
});

// Termini olmayan satır doğrulanmış boş değer (null) taşır; `selected: false` termin sütununun hiç seçilmediği okumadır.
function milestones(rows, { total = rows.length, complete = true, size = rows.length, statuses = ['todo', 'in_progress'], selected = true } = {}) {
  const filters = { statuses, milestone: true, projectId: 'p1', project: 'Alfa' };
  return [fact('R3', 'totalCount', total, { tool: 'rota_task_search', filters, complete }),
    ...rows.flatMap(([title, due, days], index) => {
      const semantic = { tool: 'rota_task_search', filters, complete, row: { identity: `t${index}`, collectionSize: size, projectId: 'p1' } };
      return [fact('R3', `data.tasks.${index}.title`, title, semantic), ...(selected ? [fact('R3', `data.tasks.${index}.targetFinish`, due ?? null, semantic)] : []),
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
  // Termini olmayan açık kilometre taşı durumu gizlemez: durum termini olanlardan kurulur; termini olmayan için gecikme yargısı
  // kurulmaz ve "hiçbiri gecikmiş değil" yalnızca termini olanlar için söylenir.
  const undated = analyticalFindings([part(0, milestones([['Faz 1', shift(3), null], ['İmza', null, null]]), ranking)]);
  const mixed = undated.find((item) => item.kind === 'milestoneStatus');
  assert.deepEqual([mixed.metrics.open, mixed.metrics.dated, mixed.metrics.overdue, mixed.metrics.undated, mixed.metrics.next.title], [2, 1, 0, 1, 'Faz 1']);
  const mixedText = synthesisNarrative(undated).intro.plain;
  assert.match(mixedText, /[Tt]ermini olan açık 1 kilometre taşının hiçbiri gecikmiş değil; sıradaki Faz 1/);
  assert.match(mixedText, /Termini olmayan 1 açık kilometre taşı termin sırasında yer almıyor; bu kilometre taşı için gecikme yargısı kurulamaz/);
  assert.doesNotMatch(mixedText, /Açık 2 kilometre taşının hiçbiri/);
  // Termini olmayanların hepsiyse "hiçbiri gecikmiş değil" denmez; yalnızca yargı kurulamadığı söylenir.
  const allUndated = synthesisNarrative(analyticalFindings([part(0, milestones([['İmza', null, null], ['Kabul', null, null]]), ranking)])).intro.plain;
  assert.doesNotMatch(allUndated, /hiçbiri gecikmiş değil/);
  assert.match(allUndated, /[Tt]ermini olmayan 2 açık kilometre taşı/);
  // Sıralamanın bıraktığı termini olmayan satır (sayfa = kesin toplam, sınır dolmadı) sayıyla açıklanır.
  const ranked = analyticalFindings([part(0, milestones([['Faz 1', shift(4), null]], { total: 2, size: 2, complete: false }), { ...ranking, limit: 8 })]);
  assert.deepEqual([ranked.find((item) => item.kind === 'milestoneStatus').metrics.undated, ranked.find((item) => item.kind === 'milestoneStatus').metrics.open], [1, 2]);
  // Tam listede sıradaki kilometre taşı, satır sırasından bağımsız olarak en erken gelecek terminli olandır.
  const reversed = analyticalFindings([part(0, milestones([['Son', shift(30), null], ['İlk', shift(5), null], ['Geç', shift(-2), 2]]), { metric: 'task.targetFinish', order: 'desc' })]);
  assert.equal(reversed.find((item) => item.kind === 'milestoneStatus').metrics.next.title, 'İlk');
  // Kesik listede (başı) gecikmiş sayısı ancak sıradaki tarih ya da termini olmayan bir satır görünürse kesindir.
  const head = analyticalFindings([part(0, milestones([['A', shift(-5), 5], ['B', shift(-3), 3]], { total: 6, complete: false }), ranking)]);
  assert.equal(head.find((item) => item.kind === 'milestoneStatus').metrics.overdueExact, false);
  const tail = analyticalFindings([part(0, milestones([['A', shift(-5), 5], ['B', null, null]], { total: 6, complete: false }), ranking)]);
  assert.equal(tail.find((item) => item.kind === 'milestoneStatus').metrics.overdueExact, true);
});

test('kilometre taşı bulgusu: sıralama sınırında biten sayfada sıradaki kilometre taşı tekil sayılmaz', () => {
  const ranking = { metric: 'task.targetFinish', order: 'asc', limit: 8 };
  // Yedi gecikmiş + ilk gelecek tarih: sınır dolu (8/9), aynı günü paylaşan dokuzuncu satır sayfada yok.
  const late = Array.from({ length: 7 }, (_, index) => [`Geç ${index + 1}`, shift(-10 + index), 10 - index]);
  const boundary = analyticalFindings([part(0, milestones([...late, ['Pilot', shift(5), null]], { total: 9, size: 9, complete: false }), ranking)]);
  const next = boundary.find((item) => item.kind === 'milestoneStatus').metrics.next;
  assert.equal(next.title, 'Pilot');
  assert.equal(next.sole, false, 'bırakılmış aynı günlü kilometre taşı olabilir; tekil denmemeli');
  assert.doesNotMatch(synthesisNarrative(boundary).intro.plain, /sıradaki ise Pilot/, 'anlatım Pilot\'u tek sıradaki diye sunmamalı');
  // Sayfada daha geç terminli satır varsa ya da liste tamsa tekillik kesindir.
  const later = analyticalFindings([part(0, milestones([...late.slice(1), ['Pilot', shift(5), null], ['Kabul', shift(9), null]], { total: 9, size: 9, complete: false }), ranking)]);
  assert.equal(later.find((item) => item.kind === 'milestoneStatus').metrics.next.sole, true);
  const complete = analyticalFindings([part(0, milestones([...late, ['Pilot', shift(5), null]]), ranking)]);
  assert.equal(complete.find((item) => item.kind === 'milestoneStatus').metrics.next.sole, true);
});

test('kilometre taşı bulgusu: seçilmemiş termin "termini yok" sayılmaz; tek açık durumla daraltılmış liste açık kilometre taşları olarak anlatılmaz', () => {
  const ranking = { metric: 'task.targetFinish', order: 'asc' };
  // Termin sütunu seçilmemiş tam liste: satırların termini bilinmez; termini olmayan kilometre taşı iddiası kurulmaz.
  const unselected = analyticalFindings([part(0, milestones([['Faz 1', shift(3), null], ['İmza', shift(9), null]], { selected: false }), ranking)]);
  assert.equal(unselected.find((item) => item.kind === 'milestoneStatus'), undefined);
  assert.doesNotMatch(synthesisNarrative(unselected).intro?.plain || '', /[Tt]ermini olmayan/);
  // Yalnızca "yapılacak" durumuyla daraltılmış liste: devam eden gecikmiş kilometre taşı dışarıda olabilir; açık kilometre taşı durumu kurulmaz.
  const todoOnly = analyticalFindings([part(0, milestones([['Faz 1', shift(4), null]], { statuses: ['todo'] }), ranking)]);
  assert.equal(todoOnly.find((item) => item.kind === 'milestoneStatus'), undefined);
  assert.doesNotMatch(synthesisNarrative(todoOnly).intro?.plain || '', /kilometre taşının hiçbiri gecikmiş değil/);
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
  // Denetleyici kalıpları gerçek bulgu anlatımına uygulanır: her bulgu türü kendi kalıbıyla yakalanır.
  const findings = analyticalFindings([part(0, portfolio([['Alfa', 12, 5, 4, 2], ['Beta', 3, 2, 0, 7], ['Gama', 7, 0, 3, 3], ['Delta', 4, 3, 1, 1]])),
    part(1, milestones([['Faz 1', shift(-9), 9], ['Pilot', shift(12), null]]), { metric: 'task.targetFinish', order: 'asc', limit: 8 })]);
  const narrative = synthesisNarrative(findings);
  const markdown = [narrative.intro.markdown, ...((narrative.intro.insights?.paragraphs || [narrative.intro.insights]).filter(Boolean).map((item) => item.markdown))].join('\n\n');
  const produced = new Set(findings.map((item) => item.kind));
  for (const kind of ['milestoneStatus', 'completionDespiteOverdue', 'volumeVsDelay'].filter((item) => produced.has(item))) assert.match(markdown, G_FINDING_TEXT[kind], kind);
  assert.ok(produced.has('milestoneStatus'), 'temsilî veriden kilometre taşı bulgusu üretilir');
  // Denetleyicinin HER kalıbı, o bulguyu üreten temsilî kanıtın anlatımında yakalanır; üretilmeyen ya da kalıbı tutmayan tür sınamayı bozar.
  const layer = (evidenceId, filters, open, overdue) => [['open', open], ['overdue', overdue]].map(([key, value]) => fact(evidenceId, `data.totals.${key}`, value, { tool: 'rota_task_analytics', filters }));
  const units = [['org:a', 'Birim A', 6, 3], ['org:b', 'Birim B', 4, 1]].flatMap(([key, label, open, overdue], index) => {
    const semantic = { tool: 'rota_task_analytics', filters: { assignee: 'team', teamLevel: 'department' }, groupBy: 'unit', group: { key, label }, row: { identity: key, collectionSize: 2 } };
    return [fact('R1', `data.groups.${index}.label`, label, semantic), fact('R1', `data.groups.${index}.open`, open, semantic), fact('R1', `data.groups.${index}.overdue`, overdue, semantic)];
  });
  const samples = [findings, analyticalFindings([part(0, people([['Ayşe', 6, 3, 1], ['Burak', 4, 3, 0], ['Can', 0, 0, 0]]))]),
    analyticalFindings([part(0, layer('R1', { assignee: 'me' }, 5, 1)), part(1, layer('R2', { assignee: 'team', teamLevel: 'unit' }, 37, 14))]), analyticalFindings([part(0, units)])];
  // Örgütsel tablonun toplanmama kuralı zorunlu çekincedir (bulgudan bağımsız); denetleyici bulguyu ve kuralı birlikte arar.
  const unitCaveats = caveatPropositions([part(0, units)]).map((item) => item.proposition.markdown);
  const covered = new Set();
  for (const [index, sample] of samples.entries()) {
    const story = synthesisNarrative(sample);
    const text = [story.intro.markdown, ...((story.intro.insights?.paragraphs || [story.intro.insights]).filter(Boolean).map((item) => item.markdown)),
      ...(index === samples.length - 1 ? unitCaveats : [])].join('\n\n');
    for (const kind of new Set(sample.map((item) => item.kind))) {
      if (!G_FINDING_TEXT[kind]) continue;
      assert.match(text, G_FINDING_TEXT[kind], kind);
      covered.add(kind);
    }
  }
  assert.deepEqual([...covered].sort(), Object.keys(G_FINDING_TEXT).sort(), 'her G bulgu kalıbı sınanır');
  // Genel bir kilometre taşı başlığı ya da liste metni durum bulgusu sayılmaz.
  assert.doesNotMatch('#### Kilometre taşları\n\nKAP TOOL projesindeki kilometre taşları aşağıda listeleniyor.', G_FINDING_TEXT.milestoneStatus);
  assert.ok(renderedCharts('').length === 0);
});

test('aracın sayfasından büyük ekipte iş yükü bölümü düşmez: aynı kanıttan sınırlı sıralama başı olarak gösterilir, tamlık ve yayılım iddiası kurulmaz', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = executiveBenchmarkSeed();
  t.mock.timers.reset();
  // B'nin birim kadrosuna 1–3 açık görevli 30 sentetik üye eklenir (kişi sayfası en çok 25 satırdır).
  const template = seed.tasks.find((task) => task.ProjectId === EXEC_PROJECTS.BGS && task.Status !== 'done');
  let next = 0;
  for (let index = 0; index < 30; index += 1) {
    const sicil = 930000 + index;
    seed.people.push({ Sicil: sicil, DisplayName: `Sentetik Üye ${index + 1}`, Username: `su${index}`, Unit: 'Uygulama Geliştirme', Department: 'Yazılım', Directorate: 'Bilgi Sistemleri' });
    seed.executiveScope.push({ ManagerSicil: P.B, EmployeeSicil: sicil, ScopeType: 'UNIT' });
    for (let copy = 0; copy <= index % 3; copy += 1) {
      next += 1;
      const taskId = `24000000-0000-4000-8000-${String(next).padStart(12, '0')}`;
      seed.tasks.push({ ...template, TaskId: taskId, Title: `Sentetik iş ${next}` });
      seed.taskAssignees.push({ TaskId: taskId, Sicil: sicil });
    }
  }
  const { ask } = phase4eConversation(t, { sicil: P.B, seed });
  const result = await ask({ text: 'Birimimin iş yükü nasıl?', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'team', level: 'unit', focus: ['workload'] } } });
  const content = String(result.answer.content);
  assert.equal(result.answer.finishReason, 'stop', content);
  const rows = content.split('\n').filter((line) => /^\| (?!Kişi|---)/.test(line));
  // Sıralama başı (ilk 10 ve sınırdaki eşitler) gösterilir; 37 kişilik ekibin tamamı değil.
  assert.ok(rows.length >= 10 && rows.length < 25, `sıralama başı: ${rows.length}`);
  assert.match(rows[0], /Mehmet Kaya/);
  assert.doesNotMatch(content, /bütün kişileri \(görünür açık görevi olmayanlar dahil\)/, 'kesik sayfada tam kadro denmez');
  assert.doesNotMatch(content, G_FINDING_TEXT.workloadSpread, 'kesik nüfusta yayılım bulgusu kurulmaz');
});

/* ── Kök neden regresyonları: bulgu ve sunum ayrıntıları ──────── */

const { caveatPropositions, tableLeadSentence, titleCandidate } = await import('../src/domain/ai/groundedPropositions.js');
const { evidenceSemantic } = await import('../src/domain/ai/claimableEvidence.js');

test('oran karşılaştırması küçük paydalı varlığı açıkça dışlar; en çok gecikmiş varlık eşiğin altındaysa oran ayrışması kurulmaz', () => {
  // 1/1 (%100) eşiğin altında: anlatım "en az 3 açık görevi olanlar arasında" der; %75 en yüksek oran olarak sunulur.
  const eligible = analyticalFindings([part(0, projectGroups([['Küçük', 1, 1, 0], ['Orta', 4, 3, 1], ['Büyük', 12, 5, 2]]))]);
  const rate = eligible.find((item) => item.kind === 'overdueRateLeader');
  assert.equal(rate.metrics.excluded, 1);
  // Oran önderi eşiği geçenler arasında en yüksek orandır (Orta 3/4 = %75), sayı önderi (Büyük 5/12) değil.
  assert.deepEqual([rate.names, rate.metrics.share, rate.metrics.leader.name], [['Orta'], 75, 'Büyük']);
  assert.match(synthesisNarrative(eligible).intro.insights?.plain || synthesisNarrative(eligible).intro.plain, /en az 3 açık görevi olanlar arasında/);
  // En çok gecikmiş varlık eşiğin altındaysa (2/2) onun oranı karşılaştırmaya girmez: bulgu yok.
  const tiny = analyticalFindings([part(0, projectGroups([['Mini', 2, 2, 0], ['Orta', 4, 1, 1], ['Büyük', 12, 1, 2]]))]);
  assert.equal(tiny.some((item) => item.kind === 'overdueRateLeader'), false);
});

test('görevi olmayan kapsamın tamamlanma oranı karşılaştırmada söylenmez; kısa yanıtta açan bulgunun çekincesi bulguyla kalır', () => {
  const layer = (evidenceId, filters, total, open, overdue, completion) => [['total', total], ['open', open], ['overdue', overdue], ['completionRatePercent', completion]]
    .map(([key, value]) => fact(evidenceId, `data.totals.${key}`, value, { tool: 'rota_task_analytics', filters }));
  const findings = analyticalFindings([part(0, layer('R1', { assignee: 'me' }, 0, 0, 0, 0)), part(1, layer('R2', { assignee: 'team', teamLevel: 'unit' }, 20, 10, 2, 50)),
    part(2, layer('R3', { assignee: 'team', teamLevel: 'department' }, 40, 20, 5, 50))]);
  const text = synthesisNarrative(findings).intro.plain;
  assert.doesNotMatch(text, /kendi işlerinizde %0/, 'boş kapsamda oran uydurulmaz');
  // Kısa yanıt: iş yükü yayılımı açıyorsa kapasite çekincesi düşmez.
  const spread = analyticalFindings([part(0, people([['Ali', 3, 1, 0], ['Can', 0, 0, 0], ['Ece', 5, 2, 1]]))]);
  const short = synthesisNarrative(spread, { detail: 'short', focus: ['workload'] }).intro.plain;
  assert.match(short, /açık görev sayısı 0 ile 5 arasında/);
  assert.match(short, /boş kapasiteyi göstermez/);
});

test('örgütsel kırılım sorusunda giriş örgütsel yayılımla açılır; aynı adlı başka görev kilometre taşıyla karıştırılıp öncelikten düşmez', () => {
  const org = (rows) => rows.flatMap(([label, open, overdue, done], index) => {
    const semantic = { tool: 'rota_task_analytics', filters: { assignee: 'team', teamLevel: 'department' }, groupBy: 'unit', group: { key: `org:u${index}`, label }, row: { identity: `u${index}`, collectionSize: rows.length } };
    return [fact('R1', `data.groups.${index}.label`, label, semantic), fact('R1', `data.groups.${index}.open`, open, semantic), fact('R1', `data.groups.${index}.overdue`, overdue, semantic),
      fact('R1', `data.groups.${index}.done`, done, semantic)];
  });
  const findings = analyticalFindings([part(0, org([['Birim A', 9, 6, 1], ['Birim B', 5, 1, 2], ['Birim C', 4, 2, 1]]))]);
  assert.match(synthesisNarrative(findings, { focus: ['org'] }).intro.plain, /^Bölümünüzün işlerine bakıldığında, işler 3 birime dağılıyor/);
  // Kilometre taşı "Kabul" (p1) ile başka projedeki aynı adlı gecikmiş görev "Kabul" (p2) ayrı işlerdir.
  const overdueList = (() => {
    const filters = { deadline: 'overdue', statuses: ['todo', 'in_progress'] };
    return [fact('R5', 'totalCount', 2, { tool: 'rota_task_search', filters }), ...[['Kabul', 'p2', 30, 't9'], ['Rapor', 'p3', 4, 't8']].flatMap(([title, projectId, days, identity], index) => {
      const semantic = { tool: 'rota_task_search', filters, row: { identity, collectionSize: 2, projectId } };
      return [fact('R5', `data.tasks.${index}.title`, title, semantic), fact('R5', `data.tasks.${index}.overdueDays`, days, semantic)];
    })];
  })();
  const both = analyticalFindings([part(0, milestones([['Kabul', shift(-9), 9]])), part(1, overdueList, { metric: 'task.overdueDays', order: 'desc' })]);
  const conclusion = synthesisNarrative(both).conclusion.plain;
  assert.match(conclusion, /Kabul — gecikmiş kilometre taşı/);
  assert.match(conclusion, /Kabul — en uzun süredir geciken görev/, 'farklı görev öncelikten düşmez');
});

test('sunum: tamamlanmış ya da termini olmayan görevde gecikme günü "gecikmemiş" sayılmaz; termin kovası tablosu "termin durumları"dır; gruplu kilometre taşı görevler diye adlandırılmaz', () => {
  const envelope = { data: { tasks: [{ overdue: false, status: 'done', targetFinish: TODAY }, { overdue: false, status: 'todo', targetFinish: TODAY }, { overdue: false, status: 'in_progress' }] } };
  assert.equal(evidenceSemantic(envelope, 'data.tasks.0.overdueDays', null, null)?.nullMeaning, 'unknown');
  assert.equal(evidenceSemantic(envelope, 'data.tasks.1.overdueDays', null, null)?.nullMeaning, 'not-overdue');
  // Termini olmayan açık görevde gecikme yargısı kurulamaz: hücre "Gecikmemiş" değil "Belirtilmemiş"tir.
  assert.equal(evidenceSemantic(envelope, 'data.tasks.2.overdueDays', null, null)?.nullMeaning, 'unknown');
  assert.match(tableLeadSentence({ collection: 'data.groups', groupBy: 'deadline', columns: [] }, 'tr'), /termin durumlarına göre/);
  const milestone = { statuses: ['todo', 'in_progress'], milestone: true, projectId: 'p1', project: 'Alfa' };
  assert.equal(titleCandidate({ tool: 'rota_task_analytics', filters: milestone, groupBy: 'status', locale: 'tr' }), null);
  assert.match(titleCandidate({ tool: 'rota_task_search', filters: milestone, locale: 'tr' }) || '', /kilometre taşları/);
});

test('örgütsel kırılımın toplanmama kuralı her tabloda zorunlu çekincedir (tam, eksik, düz istek); bölümler arası bulgu kuralı yinelemez', () => {
  const groupsOf = (rows) => rows.flatMap(([key, label, open, overdue], index) => {
    const semantic = { tool: 'rota_task_analytics', filters: { assignee: 'team', teamLevel: 'department' }, groupBy: 'unit', group: { key, label }, row: { identity: key, collectionSize: rows.length } };
    return [fact('R1', `data.groups.${index}.label`, label, semantic), fact('R1', `data.groups.${index}.open`, open, semantic), fact('R1', `data.groups.${index}.overdue`, overdue, semantic)];
  });
  const rule = /birimde ayrı sayılabildiğinden birim sayıları toplanmaz/;
  const partial = caveatPropositions([part(0, groupsOf([['org:a', 'Birim A', 5, 2], ['no_unit', 'Birimi belirtilmemiş', 2, 1]]))]);
  assert.ok(partial.some((item) => rule.test(item.proposition.plain)));
  // Tam tablo: bulgu (örgütsel yayılım) düz istekte, kısa yanıtta ya da başka tamlık ölçütüyle kurulmayabilir; çekince yine söylenir.
  const wholeParts = [part(0, groupsOf([['org:a', 'Birim A', 5, 2], ['org:b', 'Birim B', 3, 1]]))];
  assert.equal(caveatPropositions(wholeParts).filter((item) => rule.test(item.proposition.plain)).length, 1);
  // Aynı adlı iki birim tabloyu bulgu açısından eksik yapar (bulgu kurulmaz); kural yine çekincedir.
  const homonym = [part(0, groupsOf([['org:a', 'Birim A', 5, 2], ['org:b', 'Birim A', 3, 1]]))];
  assert.equal(analyticalFindings(homonym).some((item) => item.kind === 'orgSpread'), false);
  assert.ok(caveatPropositions(homonym).some((item) => rule.test(item.proposition.plain)));
  // Bulgunun kendisi kuralı yinelemez (çekinceyle aynı cümle iki kez yazılmaz).
  const story = synthesisNarrative(analyticalFindings(wholeParts));
  const told = [story.intro.plain, ...((story.intro.insights?.paragraphs || [story.intro.insights]).filter(Boolean).map((item) => item.plain))].join('\n');
  assert.match(told, /İşler 2 birime dağılıyor/);
  assert.doesNotMatch(told, /toplanmaz/);
});

test('çok kapsamlı yanıt: adlı birincil kapsamın takip bağlamı saklanır (ek kapsamın kimliği girmez); aynı türden iki adlı kapsam kendi başlığını alır', async (t) => {
  const { ask } = conversation(t, 'B');
  const result = await ask({ text: 'KAP TOOL projesini birimimle karşılaştır.', plan: { intent: 'rota', language: 'tr', visual: true, chart: 'bar',
    analysis: { scope: 'project', names: ['KAP TOOL'], focus: ['overview'], also: [{ scope: 'team', level: 'unit' }] } } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.equal(result.analysisContext?.scope, 'project');
  assert.deepEqual(result.analysisContext.subjects.map((subject) => subject.id.toLowerCase()), [EXEC_PROJECTS.KAP.toLowerCase()]);
  assert.equal(result.analysisContext.visual, true, 'sunum tercihi takipte sürer');
  // Takip birincil kapsamı güncel yetkiyle yeniden okur; ek kapsam (birim) okunmaz.
  const follow = await ask({ text: 'Peki gecikmeler?', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous', focus: ['overdue'] } } });
  assert.equal(follow.answer.finishReason, 'stop', follow.answer.content);
  assert.ok(populationReads(follow.log).every((row) => String(row.params.projectId || '').toLowerCase() === EXEC_PROJECTS.KAP.toLowerCase() && row.params.assigneeMode !== 'team'));
  // İki adlı proje kapsamı: her bölüm kendi projesinin başlığını alır (ilk kapsama yığılmaz).
  const pair = await ask({ text: 'KAP TOOL ile BGS Şube Çalışmaları projelerini ayrı ayrı özetle.', plan: { intent: 'rota', language: 'tr',
    analysis: { scope: 'project', names: ['KAP TOOL'], focus: ['overview'], also: [{ scope: 'project', names: ['BGS Şube Çalışmaları'] }] } } });
  assert.match(pair.answer.content, /#### KAP TOOL/);
  assert.match(pair.answer.content, /#### BGS Şube Çalışmaları/);
});

test('özetin yanındaki adlı proje listesi özetin daraltması (within) olarak saklanmaz', async (t) => {
  const { ask } = conversation(t, 'B');
  const list = { operation: 'list', metrics: ['task.title', 'task.targetFinish'], population: { tool: 'rota_task_search', collection: 'tasks' }, layout: 'list',
    entities: [{ type: 'project', text: 'Mevzuat Uyum' }], filters: { assignee: 'me', status: ['todo', 'in_progress'] } };
  const result = await ask({ text: 'Durumumu özetle, ayrıca Mevzuat Uyum projesindeki açık işlerimi listele.', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'] }, request: list } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.equal(result.analysisContext?.scope, 'self');
  assert.equal(result.analysisContext.within, undefined, 'açık listenin projesi özetin öznesini daraltmaz');
});

test('kapsamlardan biri yetkisizse okunmayan yön notu kalır ama "her kapsamın göstergeleri okundu" denmez', async (t) => {
  const { ask } = conversation(t, 'F');
  const result = await ask({ text: 'Kendimi, birimimi ve bölümümü ayrıntılı analiz et.', plan: { intent: 'rota', language: 'tr',
    analysis: { scope: 'self', focus: ['overview', 'workload', 'milestones', 'projects'], also: [{ scope: 'team', level: 'unit', focus: ['workload', 'projects', 'milestones'] }, { scope: 'team', level: 'department' }] } } });
  const content = String(result.answer.content);
  assert.match(content, /okuma sınırına sığmadığı için ayrıca gösterilmedi/, content);
  assert.doesNotMatch(content, /Her kapsamın temel göstergeleri okundu/);
});

test('üç adlı kişinin (ya da projenin) çok kapsamlı karşılaştırması sessizce düşmez: aynı tanımlı oranlarla kapsam karşılaştırması kurulur', () => {
  const person = (evidenceId, sicil, name, open, overdue) => [['open', open], ['overdue', overdue]].map(([key, value]) => fact(evidenceId, `data.totals.${key}`, value,
    { tool: 'rota_task_analytics', filters: { assignee: 'person', personSicil: sicil, person: name } }));
  const findings = analyticalFindings([part(0, person('R1', 1, 'Ayşe', 10, 5)), part(1, person('R2', 2, 'Can', 8, 2)), part(2, person('R3', 3, 'Ece', 4, 1))]);
  const level = findings.find((item) => item.kind === 'levelComparison');
  assert.equal(level?.layers.length, 3);
  const text = synthesisNarrative(findings).intro.plain;
  assert.match(text, /Açık işlerde gecikme oranı en yüksek Ayşe sorumluluğundaki işlerde \(%50\); bu oran Can sorumluluğundaki işlerde %25 ve Ece sorumluluğundaki işlerde %25/,
    'karşılaştırılan öbür kişiler ve oranları da söylenir');
  assert.match(text, /her kişide ayrı sayılabildiğinden sayılar toplanmaz/);
  // İki adlı kişi kapsam karşılaştırması değildir (iki öznenin karşılaştırma yolu kalır).
  assert.equal(analyticalFindings([part(0, person('R1', 1, 'Ayşe', 10, 5)), part(1, person('R2', 2, 'Can', 8, 2))]).some((item) => item.kind === 'levelComparison'), false);
});

/* ── Kök neden regresyonları: çok kapsamlı plan, grafik ve karşılaştırma ── */

test('çok kapsamlı özette grafik birincil kapsamdandır: ek kapsamın uygun okuması birincilin grafiğini karşılamaz', () => {
  // Ek kapsamın öncelik dağılımı halka grafiğine uygundur; birincil kapsamın okuması yine eklenir.
  const donut = unpack({ intent: 'rota', language: 'tr', visual: true, chart: 'donut', analysis: { scope: 'self', focus: ['overview'], also: [{ scope: 'team', level: 'unit', focus: ['priority'] }] } });
  const parts = [donut.plan.request, ...(donut.plan.additionalRequests || [])];
  const primary = parts.filter((part, index) => donut.plan.analysis.sections[index]?.layer === 0);
  assert.ok(primary.some((part) => ['status', 'priority', 'deadline', 'project'].includes(part.population.groupBy) && part.filters.assignee === 'me'), 'birincilin dağılımı okunur');
  // Gelecek dönem istenen zaman çizelgesi dönemsiz kilometre taşı listesiyle karşılanmaz: birincilin dönemli satırları okunur.
  const window = { dateFrom: shift(0), dateTo: shift(13) };
  const timeline = unpack({ intent: 'rota', language: 'tr', visual: true, chart: 'timeline', analysis: { scope: 'self', focus: ['milestones'], ...window, also: [{ scope: 'team', level: 'unit', focus: ['overview'] }] } });
  const reads = [timeline.plan.request, ...(timeline.plan.additionalRequests || [])];
  assert.ok(reads.some((part) => part.population.tool === 'rota_task_search' && part.filters.assignee === 'me' && part.filters.dateFrom === window.dateFrom && part.filters.dateTo === window.dateTo),
    'dönemli satır okuması eklenir');
});

test('yinelenen kapsam birleşirken devralınan yön davranışı korunur: kapsamda anlamı olmayan yön açık yazıma dönüşüp planı reddettirmez', () => {
  const merged = parseAnalysis({ scope: 'team', level: 'department', focus: ['org'], also: [{ scope: 'self' }, { scope: 'team', level: 'department', focus: ['milestones'] }] });
  assert.deepEqual([...merged.focus], ['org', 'milestones']);
  assert.deepEqual([...merged.also[0].focus], ['overview'], 'kendi işlerinde alt birim kırılımı atlanır; genişletilmiş birincil yön devralınmaz');
  const sections = expandAnalysis(merged, { today: TODAY });
  assert.ok(sections.sections.some((item) => item.layer === 1), 'kendi kapsamının özeti okunur');
  assert.equal(sections.sections.some((item) => item.layer === 1 && item.focus === 'milestones'), false);
});

test('ek kapsamlar arasında yinelenen kapsam birleşirken devralınan yön kapsamın süzgecinden geçer: anlamı olmayan yön kapsamın kendi yönü olmaz', () => {
  const merged = parseAnalysis({ scope: 'team', level: 'department', focus: ['org'], also: [{ scope: 'self' }, { scope: 'self', focus: ['milestones'] }] });
  assert.equal(merged.also.length, 1);
  assert.deepEqual([...merged.also[0].focus], ['overview', 'milestones'], 'alt birim kırılımı kendi işlerine yazılmaz; yazılan yön düşmez');
  const expanded = expandAnalysis(merged, { today: TODAY });
  assert.ok(expanded.sections.some((item) => item.layer === 1 && item.focus === 'milestones'));
  // Yinelenen kapsam olmadan da aynı sonuç: kendi kapsamı alt birim kırılımını atlar.
  assert.doesNotThrow(() => expandAnalysis(parseAnalysis({ scope: 'team', level: 'department', focus: ['org'], also: [{ scope: 'self' }] }), { today: TODAY }));
  // Devralınan yön kapsamda anlamlıysa korunur.
  const kept = parseAnalysis({ scope: 'team', level: 'department', focus: ['overdue'], also: [{ scope: 'self' }, { scope: 'self', focus: ['upcoming'] }] });
  assert.deepEqual([...kept.also[0].focus], ['overdue', 'upcoming']);
});

test('tek öğeli özet dizisi çok öğeli yazımla aynı dil kuralını izler: öğedeki dil plana taşınır, çelişki reddedilir', () => {
  const accepted = unpack({ intent: 'rota', analysis: [{ scope: 'self', focus: ['overview'], language: 'tr' }] }).plan;
  assert.equal(accepted.language, 'tr');
  assert.equal(Object.hasOwn(accepted.analysis, 'language'), false);
  assert.equal(unpack({ intent: 'rota', language: 'tr', analysis: [{ scope: 'self', focus: ['overview'], language: 'tr' }] }).plan.language, 'tr');
  assert.deepEqual(reject({ intent: 'rota', language: 'en', analysis: [{ scope: 'self', focus: ['overview'], language: 'tr' }] }), ['$.analysis.also:scope']);
  assert.equal(unpack({ intent: 'rota', language: 'tr', analysis: [{ scope: 'self', focus: ['overview'] }] }).plan.analysis.scope, 'self');
});

test('kapsam karşılaştırması: bütün kapsamlarda açık iş yoksa bu durum söylenir; adlı kişi ile adlı proje örtüşme çekincesiyle açıklanır', () => {
  const layer = (evidenceId, filters, open, overdue) => [['open', open], ['overdue', overdue]].map(([key, value]) => fact(evidenceId, `data.totals.${key}`, value, { tool: 'rota_task_analytics', filters }));
  const idle = analyticalFindings([part(0, layer('R1', { assignee: 'me' }, 0, 0)), part(1, layer('R2', { assignee: 'team', teamLevel: 'unit' }, 0, 0)),
    part(2, layer('R3', { assignee: 'team', teamLevel: 'department' }, 0, 0))]);
  assert.equal(idle.find((item) => item.kind === 'levelComparison')?.layers.length, 3);
  const text = synthesisNarrative(idle).intro.plain;
  assert.match(text, /Karşılaştırılan kapsamların hiçbirinde açık iş olmadığından gecikme oranı karşılaştırılmadı\./);
  assert.doesNotMatch(text, /%/u, 'tanımsız oran yazılmaz');
  assert.match(synthesisNarrative(idle, { locale: 'en' }).intro.plain, /None of the compared scopes has open work/);
  // Adlı kişi + adlı proje + kendi işleri: çekince kapsamların örtüşmesidir, yalnızca ortak sorumluluk değil.
  const mixed = synthesisNarrative(analyticalFindings([part(0, layer('R1', { assignee: 'person', personSicil: 7, person: 'Ayşe' }, 10, 5)),
    part(1, layer('R2', { projectId: 'p-1', project: 'Alfa' }, 8, 2)), part(2, layer('R3', { assignee: 'me' }, 4, 1))])).intro.plain;
  assert.match(mixed, /bir görev hem kişinin işlerinde hem projede yer alabilir/);
  assert.doesNotMatch(mixed, /her kişide ayrı sayılabildiğinden/);
});

/* ── Zayıf model güvenilirliği: eşdeğer yazımlar onarım turu harcamadan kabul edilir ── */

test('portföy kapsamında dönem (yedi günlük dahil) sayıları daraltır: dönemli soru dönemli proje gruplamasından okunur; dönemsiz portföy özetten', () => {
  const parts = (analysis) => { const { plan } = unpack({ intent: 'rota', language: 'tr', analysis }); return [plan.request, ...(plan.additionalRequests || [])]; };
  const tools = (analysis) => parts(analysis).map((part) => part.population.tool);
  // Portföy özetinin açık/tamamlanan/gecikmiş sayıları bütün görünür görevlerdendir; yalnızca yaklaşan sütunu yedi gündür.
  for (const analysis of [{ scope: 'projects', focus: ['projects'], dateFrom: TODAY, dateTo: shift(6) },
    { scope: 'projects', focus: ['overview', 'projects'], relativeWindow: 'next_7_days' }, { scope: 'projects', focus: ['projects'], dateFrom: TODAY, dateTo: shift(13) }]) {
    assert.equal(tools(analysis).includes('rota_portfolio_summary'), false, JSON.stringify(analysis));
    const projects = parts(analysis).find((part) => part.population.groupBy === 'project');
    assert.ok(projects, 'proje gruplaması okunur');
    assert.deepEqual([projects.filters.dateFrom, projects.filters.dateTo], [TODAY, analysis.dateTo || shift(6)], 'istenen dönem okumada kalır');
  }
  assert.ok(tools({ scope: 'projects', focus: ['projects'] }).includes('rota_portfolio_summary'), 'dönemsiz portföy özetten okunur');
});

test('bölüm ve direktörlük düzeyindeki ekip özetine alt birim kırılımı sunucuca eklenir; birim düzeyinde, yer yokken ve yazılmışken eklenmez', () => {
  const groupings = (analysis) => { const { plan } = unpack({ intent: 'rota', language: 'tr', analysis }); return [plan.request, ...(plan.additionalRequests || [])].map((part) => part.population.groupBy || null); };
  assert.ok(groupings({ scope: 'team', level: 'directorate', focus: ['overview', 'overdue'] }).includes('department'));
  assert.ok(groupings({ scope: 'team', level: 'department', focus: ['workload'] }).includes('unit'));
  assert.equal(groupings({ scope: 'team', level: 'unit', focus: ['overview'] }).some((groupBy) => ['unit', 'department'].includes(groupBy)), false, 'birimin altı kişilerdir');
  assert.equal(groupings({ scope: 'team', focus: ['overview'] }).some((groupBy) => ['unit', 'department'].includes(groupBy)), false, 'düzeysiz ekipte eklenmez');
  assert.equal(groupings({ scope: 'team', level: 'department', focus: ['org', 'overview'] }).filter((groupBy) => groupBy === 'unit').length, 1, 'yazılmış yön yinelenmez');
  // Okuma tavanı doluysa eklenmez; bildirilen altı yön aynen okunur (plan reddedilmez).
  const full = groupings({ scope: 'team', level: 'department', focus: ['overview', 'overdue', 'upcoming', 'critical', 'status', 'priority'] });
  assert.deepEqual([full.length, full.includes('unit')], [ANALYSIS_LIMITS.maxParts, false]);
});

test('özetin eşdeğer yazımları onarım turu harcamaz: analysis kararı, özetteki reasoning ve aynı günleri gösteren dönem çifti', () => {
  const accepted = unpack({ intent: 'analysis', language: 'tr', analysis: { scope: 'self', focus: ['overview'], reasoning: 'synthesis' } }).plan;
  assert.deepEqual([accepted.intent, Object.hasOwn(accepted.analysis, 'reasoning')], ['rota', false]);
  // Özetsiz "analysis" kararı geçerli bir karar değildir.
  assert.deepEqual(reject({ intent: 'analysis', language: 'tr', request: { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' } } }), ['$.intent:enum']);
  const same = unpack({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['upcoming'], relativeWindow: 'next_7_days', dateFrom: TODAY, dateTo: shift(6) } }).plan.analysis;
  assert.deepEqual([same.relativeWindow, same.dateFrom ?? null, same.dateTo ?? null], ['next_7_days', null, null], 'göreli dönem kalır; yinelenen tarih çifti düşer');
  const dated = unpack({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['upcoming'], relativeWindow: 'all_time', dateFrom: TODAY, dateTo: shift(13) } }).plan.analysis;
  assert.deepEqual([dated.relativeWindow ?? null, dated.dateTo], [null, shift(13)]);
  // Farklı günleri gösteren göreli dönem ve tarih çifti çelişkidir.
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['upcoming'], relativeWindow: 'next_7_days', dateFrom: TODAY, dateTo: shift(13) } }), ['$.analysis.relativeWindow:conflict']);
});

test('istek yazımının yapısal eşdeğerleri ilk bildirimde kabul edilir: dizi biçimli istek, null süzgeç, sorumlu "any" ve süzgeçteki proje adı', () => {
  const list = { operation: 'list', metrics: ['task.title', 'task.targetFinish'], population: { tool: 'rota_task_search', collection: 'tasks' }, layout: 'list' };
  // İstekler tek dizi (JSON metni olarak da): ilk öğe istek, kalanı ek istek.
  const pair = [{ ...list, filters: { assignee: 'me', deadline: 'overdue' } }, { ...list, filters: { assignee: 'me', deadline: 'due_next_7_days' } }];
  for (const request of [pair, JSON.stringify(pair)]) {
    const { plan } = unpack({ intent: 'rota', language: 'tr', request });
    assert.deepEqual([plan.request.filters.deadline, plan.additionalRequests.map((item) => item.filters.deadline)], ['overdue', ['due_next_7_days']]);
  }
  // Ayrıca ek istek de yazılmışsa dizi sessizce seçilmez: tür denetimi reddeder.
  assert.ok(Array.isArray(unpack({ intent: 'rota', language: 'tr', request: pair, additionalRequests: [pair[1]] }).plan.request), 'dizi olduğu gibi kalır; bildirim doğrulaması reddeder');
  // null süzgeç ve "any" sorumlu yazılmamış süzgeçtir.
  const cleaned = unpack({ intent: 'rota', language: 'tr', request: { ...list, filters: { assignee: 'any', projectId: null, deadline: 'overdue' } } }).plan.request;
  assert.deepEqual(cleaned.filters, { deadline: 'overdue' });
  // Süzgeçteki proje adı varlık bildirimidir; ad güvenilir metin denetiminden ve aramadan aynen geçer.
  const named = unpack({ intent: 'rota', language: 'tr', request: { ...list, filters: { projectId: 'KAP TOOL', milestone: true } } }).plan.request;
  assert.deepEqual([named.filters, named.entities], [{ milestone: true }, [{ type: 'project', text: 'KAP TOOL' }]]);
  const same = unpack({ intent: 'rota', language: 'tr', request: { ...list, filters: { project: 'KAP TOOL' }, entities: [{ type: 'project', text: 'KAP TOOL' }] } }).plan.request;
  assert.deepEqual([same.filters, same.entities], [{}, [{ type: 'project', text: 'KAP TOOL' }]]);
  // İsteğin içine yazılan sunum tercihleri plan düzeyine taşınır; özetteki null alan yazılmamış alandır.
  const hoisted = unpack({ intent: 'rota', language: 'tr', request: { ...list, filters: { assignee: 'me' }, visual: true, chart: 'bar' } }).plan;
  assert.deepEqual([hoisted.visual, hoisted.chart, Object.hasOwn(hoisted.request, 'chart')], [true, 'bar', false]);
  assert.equal(Object.hasOwn(parseAnalysis({ scope: 'self', focus: ['overview'], relativeWindow: null, dateFrom: null }), 'relativeWindow'), false);
  // Başka bir proje varlığıyla çelişen süzgeç çevrilmez (iki seçiciden biri sessizce seçilmez).
  const conflict = unpack({ intent: 'rota', language: 'tr', request: { ...list, filters: { projectId: 'KAP TOOL' }, entities: [{ type: 'project', text: 'Mobil Uygulama' }] } }).plan.request;
  assert.equal(conflict.filters.projectId, 'KAP TOOL');
});

test('süzgeçteki proje adı bildirilmemiş adı güvenilir kılmaz; sorudaki ad ise onarım turu olmadan okunur', async (t) => {
  const request = { operation: 'list', metrics: ['task.title', 'task.targetFinish'], population: { tool: 'rota_task_search', collection: 'tasks', sort: 'target_finish_asc' }, layout: 'list',
    filters: { projectId: 'KAP TOOL', milestone: true, status: ['todo', 'in_progress'] } };
  await t.test('sorudaki ad', async (st) => {
    const { ask } = conversation(st, 'B');
    const result = await ask({ text: 'KAP TOOL kilometre taşlarında geciken var mı, sıradaki hangisi?', plan: { intent: 'rota', language: 'tr', request } });
    assert.equal(result.inputs.length, 1, 'onarım turu açılmaz');
    assert.equal(result.answer.finishReason, 'stop', result.answer.content);
    assert.ok(populationReads(result.log).length > 0 && populationReads(result.log).every((row) => row.params.projectId), 'okuma projeyle sınırlı');
  });
  await t.test('soruda geçmeyen ad', async (st) => {
    const { ask } = conversation(st, 'B');
    const untrusted = await ask({ text: 'Kilometre taşlarında geciken var mı?', plan: { intent: 'rota', language: 'tr', request } });
    assert.notEqual(untrusted.answer.finishReason, 'stop', 'soruda geçmeyen ad süzgeç yoluyla da güvenilir olmaz');
    assert.equal(populationReads(untrusted.log).length, 0);
  });
});

test('satırı adlandıran çok yollu ölçü (task.project) bağ yazılmadan ad alanına bağlanır; açık bağ korunur', () => {
  const request = (extra = {}) => ({ operation: 'list', metrics: ['task.title', 'task.project'], population: { tool: 'rota_task_search', collection: 'tasks' }, layout: 'auto', filters: { assignee: 'me' }, ...extra });
  const parsed = (value) => completeRequest(parseRequestDeclaration(value, { textTrusted: () => true, identityTrusted: () => true, today: TODAY }), [], { today: TODAY });
  const defaulted = parsed(request());
  assert.deepEqual(defaulted.problems, []);
  assert.deepEqual(defaulted.request.fields.map((field) => [field.metric, field.path]), [['task.project', 'data.tasks.*.project.name']]);
  const explicit = parsed(request({ fields: [{ metric: 'task.project', tool: 'rota_task_search', path: 'data.tasks.*.project.code' }] }));
  assert.deepEqual(explicit.request.fields.map((field) => field.path), ['data.tasks.*.project.code'], 'modelin seçtiği yol değişmez');
});

test('özetin ekip düzeyi yanındaki bağımsız düzeysiz ekip isteğine kopyalanmaz: istek bütün yönetim kapsamını korur; açık düzeye dokunulmaz', () => {
  const list = { operation: 'list', metrics: ['task.title', 'task.targetFinish'], population: { tool: 'rota_task_search', collection: 'tasks' }, layout: 'table', filters: { assignee: 'team', status: ['todo', 'in_progress'], priority: ['critical'] } };
  const levels = (analysis, request = list) => { const { plan } = unpack({ intent: 'rota', language: 'tr', analysis, request });
    return [plan.request, ...(plan.additionalRequests || [])].filter((part) => part.filters?.priority?.includes('critical')).map((part) => part.filters.teamLevel ?? null); };
  assert.deepEqual(levels({ scope: 'team', level: 'unit', focus: ['overview'] }), [null], 'düzeysiz ekip koşulu bütün yönetim kapsamıdır');
  assert.deepEqual(levels({ scope: 'team', level: 'department', focus: ['overview'] }), [null], 'bölüm özeti bağımsız listeyi bölüm ilişkisine daraltmaz');
  // Bağımsız iş yükü listesi de özetin düzeyini almaz.
  const workload = { operation: 'list', metrics: ['person.name', 'tasks.open'], population: { tool: 'rota_workload_summary', collection: 'people' }, filters: { assignee: 'team' } };
  const { plan: workloadPlan } = unpack({ intent: 'rota', language: 'tr', analysis: { scope: 'team', level: 'department', focus: ['overview'] }, request: workload });
  const independent = [workloadPlan.request, ...(workloadPlan.additionalRequests || [])].filter((part) => part.population?.tool === 'rota_workload_summary');
  assert.deepEqual(independent.map((part) => part.filters.teamLevel ?? null), [null]);
  assert.deepEqual(levels({ scope: 'team', level: 'unit', focus: ['overview'], also: [{ scope: 'team', level: 'department' }] }), [null], 'iki ekip düzeyinde hangisi olduğu belirsizdir');
  assert.deepEqual(levels({ scope: 'team', level: 'unit', focus: ['overview'] }, { ...list, filters: { ...list.filters, teamLevel: 'department' } }), ['department']);
  assert.deepEqual(levels({ scope: 'team', focus: ['overview'] }), [null], 'düzeysiz özet düzey eklemez');
});

test('ek kapsamdaki "dönem yok" yazımı dönemsiz özette anlam taşımaz; dönemli özette ayrı dönem reddedilir', () => {
  const merged = parseAnalysis({ scope: 'self', focus: ['overview'], relativeWindow: 'all_time', also: [{ scope: 'team', level: 'unit', relativeWindow: 'all_time' }] });
  assert.deepEqual(merged.also.map((layer) => Object.keys(layer).sort()), [['level', 'scope']]);
  assert.throws(() => parseAnalysis({ scope: 'self', focus: ['upcoming'], relativeWindow: 'next_7_days', also: [{ scope: 'team', level: 'unit', relativeWindow: 'all_time' }] }),
    (error) => error.details.includes('$.analysis.also[0].relativeWindow:unknown'));
});

test('ek kapsamda reddedilen dönem kaldırılarak onarılır: özetin geçerli dönemi sabit kalır, aynı kapsam ve yönlerle Derin devir olmadan yanıtlanır', async (t) => {
  const first = { intent: 'rota', language: 'tr', analysis: { scope: 'team', level: 'unit', focus: ['upcoming', 'overdue'], dateFrom: shift(0), dateTo: shift(13),
    also: [{ scope: 'team', level: 'unit', focus: ['overdue'], relativeWindow: 'all_time' }] } };
  const repaired = { intent: 'rota', language: 'tr', analysis: { scope: 'team', level: 'unit', focus: ['upcoming', 'overdue'], dateFrom: shift(0), dateTo: shift(13) } };
  const planCall = (plan) => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plan }] });
  const run = async (st, plans) => {
    st.mock.timers.enable({ apis: ['Date'], now: NOW });
    const seed = executiveBenchmarkSeed();
    st.mock.timers.reset();
    let standard = null;
    let escalated = false;
    const { ask } = phase4eConversation(st, { sicil: P.B, seed, planner: (input) => {
      standard ??= input.model;
      if (input.model !== standard) { escalated = true; return { type: 'status', status: 503 }; }
      return planCall(plans.shift() || plans.at(-1));
    } });
    const result = await ask({ text: 'Birimimin önümüzdeki 14 günlük teslimatlarını göster; mevcut gecikmeleri de ayrı değerlendir.' });
    return { result, escalated };
  };
  await t.test('geçerli onarım', async (st) => {
    const fixed = await run(st, [first, repaired]);
    assert.equal(fixed.escalated, false, 'geçerli onarım Derin modele devredilmez');
    assert.equal(fixed.result.answer.finishReason, 'stop', fixed.result.answer.content);
    assert.deepEqual(turnViolations(fixed.result, { assignee: 'team', level: 'unit', windowDays: 14 }), []);
  });
  // Onarım kapsamı değiştiremez: başka düzey ya da düşen yön eskisi gibi reddedilir.
  await t.test('düzey değişemez', async (st) => {
    const widened = await run(st, [first, { ...repaired, analysis: { ...repaired.analysis, level: 'department' } }]);
    assert.notEqual(widened.result.answer.finishReason, 'stop');
    assert.equal(populationReads(widened.result.log).some((row) => row.params.teamLevel === 'DEPARTMENT'), false, 'genişleyen kapsam okunmaz');
  });
  await t.test('yön düşemez', async (st) => {
    const dropped = await run(st, [first, { ...repaired, analysis: { ...repaired.analysis, focus: ['upcoming'] } }]);
    assert.notEqual(dropped.result.answer.finishReason, 'stop');
  });
  // Ek kapsamın geçersiz dönemi, birincil kapsamın geçerli sınırlarını değiştirme izni değildir.
  await t.test('birincil dönem değişemez', async (st) => {
    const moved = await run(st, [first, { ...repaired, analysis: { ...repaired.analysis, dateTo: shift(40) } }]);
    assert.notEqual(moved.result.answer.finishReason, 'stop');
    assert.equal(populationReads(moved.result.log).some((row) => row.params.dateTo === shift(40)), false, 'değişen dönem okunmaz');
  });
});

test('ek kapsamın konumsal onarım yolu, normalleştirme diziyi kaydırdığında başka kapsamın geçerli düzeyini açmaz', async (t) => {
  // also[0] birincille aynı kapsama iner (geçersiz düzey maskelenince); also[1] kendi geçerli düzeyini (unit) korumalıdır.
  const first = { intent: 'rota', language: 'tr', analysis: { scope: 'team', focus: ['overview'], also: [{ scope: 'team', level: 'branch' }, { scope: 'team', level: 'unit' }] } };
  const widened = { intent: 'rota', language: 'tr', analysis: { scope: 'team', focus: ['overview'], also: [{ scope: 'team', level: 'department' }, { scope: 'team', level: 'directorate' }] } };
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = executiveBenchmarkSeed();
  t.mock.timers.reset();
  const plans = [first, widened];
  let standard = null;
  const { ask } = phase4eConversation(t, { sicil: P.B, seed, planner: (input) => {
    standard ??= input.model;
    if (input.model !== standard) return { type: 'status', status: 503 };
    return { type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plans.shift() || widened }] };
  } });
  const result = await ask({ text: 'Ekibimi birimimle karşılaştır.' });
  assert.notEqual(result.answer.finishReason, 'stop', result.answer.content);
  assert.equal(populationReads(result.log).some((row) => row.params.teamLevel === 'DIRECTORATE'), false, 'dokunulmamış kapsamın düzeyi değişmez');
});

test('çok kapsamlı dizi yazımında öğelerdeki dil plan düzeyine taşınır; çelişen dil reddedilir', () => {
  const accepted = unpack({ intent: 'rota', analysis: [{ scope: 'self', focus: ['overview'], language: 'tr' }, { scope: 'team', level: 'unit', language: 'tr' }] }).plan;
  assert.equal(accepted.language, 'tr');
  assert.equal(Object.hasOwn(accepted.analysis, 'language'), false);
  assert.deepEqual(reject({ intent: 'rota', language: 'en', analysis: [{ scope: 'self', focus: ['overview'], language: 'tr' }, { scope: 'team', level: 'unit' }] }), ['$.analysis.also:scope']);
  assert.deepEqual(reject({ intent: 'rota', analysis: [{ scope: 'self', focus: ['overview'], language: 'tr' }, { scope: 'team', level: 'unit', language: 'en' }] }), ['$.analysis.also:scope']);
});

test('kendi işleri ile adlı projenin iki kapsamlı karşılaştırması sessizce düşmez; açık işi olmayan kapsam adıyla belirtilir', () => {
  const layer = (evidenceId, filters, open, overdue) => [['open', open], ['overdue', overdue]].map(([key, value]) => fact(evidenceId, `data.totals.${key}`, value, { tool: 'rota_task_analytics', filters }));
  const mixed = analyticalFindings([part(0, layer('R1', { assignee: 'me' }, 4, 1)), part(1, layer('R2', { projectId: 'p-1', project: 'Alfa' }, 10, 5))]);
  assert.equal(mixed.find((item) => item.kind === 'levelComparison')?.layers.length, 2);
  const text = synthesisNarrative(mixed).intro.plain;
  assert.match(text, /Açık işlerde gecikme oranı en yüksek Alfa projesinde \(%50\); bu oran kendi işlerinizde %25/);
  // Adlı kişi yoktur: örtüşme kullanıcının kendi işleridir ("kişinin işleri" denmez).
  assert.match(text, /bir görev hem kendi işlerinizde hem projede yer alabilir/);
  assert.doesNotMatch(text, /kişinin işlerinde/);
  assert.match(synthesisNarrative(mixed, { locale: 'en' }).intro.plain, /both your own work and the project/);
  // İki adlı kişi ya da iki proje öznelerin karşılaştırma yolunda kalır.
  assert.equal(analyticalFindings([part(0, layer('R1', { projectId: 'p-1', project: 'Alfa' }, 4, 1)), part(1, layer('R2', { projectId: 'p-2', project: 'Beta' }, 10, 5))])
    .some((item) => item.kind === 'levelComparison'), false);
  // Açık işi olmayan kapsam yüzdeye katılmaz ama karşılaştırmadan sessizce de düşmez.
  const empty = synthesisNarrative(analyticalFindings([part(0, layer('R1', { assignee: 'me' }, 0, 0)), part(1, layer('R2', { assignee: 'team', teamLevel: 'unit' }, 10, 2)),
    part(2, layer('R3', { assignee: 'team', teamLevel: 'department' }, 20, 8))])).intro.plain;
  assert.match(empty, /Kendi işlerinizde açık iş olmadığından gecikme oranı karşılaştırılmadı/);
});

test('kesik ya da varlık dışı grup içeren tablo nüfus geneli önder, aralık, oran ya da yayılım bulgusu üretmez', () => {
  const groups = (rows, size = rows.length) => rows.flatMap(([key, label, open, overdue], index) => {
    const semantic = { tool: 'rota_task_analytics', filters: { assignee: 'team', teamLevel: 'department' }, groupBy: 'unit', group: { key, label }, row: { identity: key, collectionSize: size } };
    return [fact('R1', `data.groups.${index}.label`, label, semantic), fact('R1', `data.groups.${index}.open`, open, semantic), fact('R1', `data.groups.${index}.overdue`, overdue, semantic)];
  });
  const G = new Set(['workloadSpread', 'overdueLeader', 'overdueRateLeader', 'orgSpread', 'attentionLeader', 'openWorkLeader']);
  const kinds = (facts) => analyticalFindings([part(0, facts)]).map((item) => item.kind).filter((kind) => G.has(kind));
  assert.ok(kinds(groups([['org:a', 'Birim A', 12, 6], ['org:b', 'Birim B', 8, 1], ['org:c', 'Birim C', 5, 1]])).includes('orgSpread'), 'tam tablo bulgu üretir');
  assert.deepEqual(kinds(groups([['org:a', 'Birim A', 12, 6], ['no_unit', 'Birimi belirtilmemiş', 8, 1], ['org:c', 'Birim C', 5, 1]])), [], 'varlık dışı grup');
  assert.deepEqual(kinds(groups([['org:a', 'Birim A', 12, 6], ['unresolved', 'Sorumlu kaydı çözülemiyor', 8, 1], ['org:c', 'Birim C', 5, 1]])), [], 'çözülemeyen kayıt grubu');
  assert.deepEqual(kinds(groups([['org:a', 'Birim A', 12, 6], ['org:b', 'Birim B', 8, 1]], 5)), [], 'kesik tablo (5 gruptan 2 satır)');
  assert.deepEqual(analyticalFindings([part(0, people([['Ayşe', 6, 3, 1], ['Burak', 4, 3, 0]], { complete: false }))]).map((item) => item.kind).filter((kind) => G.has(kind)), [], 'eksik kadro');
});

test('özet + açık istek onarımı: sonraki reddin açık istek yolu önceki sabitlemeye katılır (birikir); onarım kapsam reddine düşmez', async (t) => {
  const request = { operation: 'rank', metrics: ['task.title', 'task.overdueDays', 'task.targetFinish'], population: { tool: 'rota_task_search' },
    filters: { assignee: 'me', deadline: 'overdue' }, layout: 'list' };
  const analysis = { scope: 'self', focus: ['overview'] };
  // 1) yalnızca özet reddedilir, 2) özet düzelir ama açık isteğin sıralaması reddedilir, 3) yalnızca reddedilen sıralama düzelir.
  const plans = [{ intent: 'rota', language: 'tr', analysis: { ...analysis, focus: ['bilinmeyen'] }, request },
    { intent: 'rota', language: 'tr', analysis, request },
    { intent: 'rota', language: 'tr', analysis, request: { ...request, rank: { metric: 'task.overdueDays', order: 'desc', limit: 8 } } }];
  const planCall = (plan) => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plan }] });
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = executiveBenchmarkSeed();
  t.mock.timers.reset();
  const { ask } = phase4eConversation(t, { sicil: P.B, seed, planner: () => planCall(plans.shift()) });
  // Derin kipte devir yoktur: iki onarım turu da aynı sabitlemeyle denetlenir.
  const result = await ask({ text: 'Durumumu özetle ve gecikmiş işlerimi tek tek sırala.' }, { mode: 'deep' });
  assert.equal(result.inputs.length, 3, 'iki onarım turu');
  const repairs = result.inputs.slice(1).map((input) => input.messages.filter((message) => message.role !== 'user').map((message) => String(message.content)).join('\n'));
  assert.equal(repairs.some((text) => /\$\.plan:repairScope/.test(text)), false, repairs.join('\n---\n'));
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
});

test('kapsamlar arası dönem çakışmasının onarımı kapsamı silemez; yalnızca dönem alanları değişebilir', async (t) => {
  const own = { scope: 'self', focus: ['overview'] };
  const unit = { scope: 'team', level: 'unit', focus: ['overview'] };
  const first = { dateFrom: shift(1), dateTo: shift(10) };
  const second = { dateFrom: shift(20), dateTo: shift(30) };
  // 1) farklı dönemli dizi yazımı (also:window), 2) birim kapsamını silen "onarım", 3) iki kapsamı da koruyan ortak dönem.
  const plans = [{ intent: 'rota', language: 'tr', analysis: [{ ...own, ...first }, { ...unit, ...second }] },
    { intent: 'rota', language: 'tr', analysis: { ...own, ...first } },
    { intent: 'rota', language: 'tr', analysis: { ...own, ...first, also: [unit] } }];
  const planCall = (plan) => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plan }] });
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = executiveBenchmarkSeed();
  t.mock.timers.reset();
  const { ask } = phase4eConversation(t, { sicil: P.B, seed, planner: () => planCall(plans.shift()) });
  const result = await ask({ text: 'Önümüzdeki dönemde benim ve birimimin durumunu karşılaştır.' }, { mode: 'deep' });
  assert.equal(result.inputs.length, 3, 'iki onarım turu beklenir');
  const repairText = (input) => input.messages.filter((message) => message.role !== 'user').map((message) => String(message.content)).join('\n');
  assert.match(repairText(result.inputs[2]), /\$\.plan:repairScope/, 'kapsamı silen onarım reddedilmeli');
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
});

for (const [label, corrected, accepted] of [['geçerli düzeltme kabul edilir', ['tasks.overdue', 'tasks.open'], true], ['geçerli ölçüyü silen onarım reddedilir', ['tasks.overdue'], false]]) {
  test(`açık isteğin konumsal ölçü onarımı sıralamadan önce maskelenir: ${label}`, async (t) => {
    const request = { operation: 'value', metrics: ['zzz', 'tasks.open'], population: { tool: 'rota_task_analytics' }, filters: { assignee: 'me' } };
    const analysis = { scope: 'self', focus: ['overview'] };
    // 1) yalnızca `metrics[0]` reddedilir (sıralamada ikinci konuma geçen değer), 2) yalnızca o konum düzeltilir.
    const plans = [{ intent: 'rota', language: 'tr', analysis, request }, { intent: 'rota', language: 'tr', analysis, request: { ...request, metrics: corrected } },
      { intent: 'rota', language: 'tr', analysis, request: { ...request, metrics: ['tasks.overdue', 'tasks.open'] } }];
    const planCall = (plan) => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plan }] });
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const seed = executiveBenchmarkSeed();
    t.mock.timers.reset();
    const { ask } = phase4eConversation(t, { sicil: P.B, seed, planner: () => planCall(plans.shift()) });
    const result = await ask({ text: 'Durumumu özetle ve gecikmiş işlerimi say.' }, { mode: 'deep' });
    const repairs = result.inputs.slice(1).map((input) => JSON.stringify(input.messages.slice(-1)));
    assert.match(repairs[0], /\$\.request\.metrics\[0\]:enum/, 'ilk tur yalnızca reddedilen konumu bildirmeli');
    if (accepted) {
      assert.equal(result.inputs.length, 2, 'geçerli düzeltme ikinci onarım turu gerektirmemeli');
      assert.equal(result.answer.finishReason, 'stop', result.answer.content);
    } else assert.match(repairs[1] || '', /\$\.plan:repairScope/, 'geçerli ölçüyü silen onarım kapsam reddi almalı');
  });
}

test('yinelenen kapsam onarımında bozuk ek kapsam değeri turu çökertmez; bildirim düzeltme yoluna döner', async (t) => {
  const brief = { scope: 'all', focus: ['overview'] };
  // 1) `all` + `projects` yinelemesi (also:duplicate sabitlemesi), 2) bozuk ek kapsam (`also: [null]`), 3) geçerli tek kapsam.
  const plans = [{ intent: 'rota', language: 'tr', analysis: { ...brief, also: [{ scope: 'projects' }] } },
    { intent: 'rota', language: 'tr', analysis: { ...brief, also: [null] } }, { intent: 'rota', language: 'tr', analysis: brief }];
  const planCall = (plan) => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plan }] });
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = executiveBenchmarkSeed();
  t.mock.timers.reset();
  const { ask } = phase4eConversation(t, { sicil: P.B, seed, planner: () => planCall(plans.shift()) });
  const result = await ask({ text: 'Bütün işlerin ve projelerin durumunu özetle.' }, { mode: 'deep' });
  assert.equal(result.inputs.length, 3, 'bozuk değer bir düzeltme turuyla karşılanmalı');
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
});

test('nitelendirme puanı: yetkisiz kapsamın kanıtı ya da başarılı okuması ihlaldir; reddedilen okuma kaydı ihlal değildir; dönem beklenen kapsamda okunmalıdır', () => {
  const base = { answer: { content: '', finishReason: 'unavailable' }, analysisContext: null };
  const teamRead = (ok) => ({ query: 'task-facts', params: { assigneeMode: 'team', teamLevel: 'DIRECTORATE' }, ok });
  assert.deepEqual(turnViolations({ ...base, log: [teamRead(false)], evidence: [] }, { noTeamRead: true }), [], 'yetki reddiyle kapanan okuma');
  assert.ok(turnViolations({ ...base, log: [teamRead(true)], evidence: [] }, { noTeamRead: true }).length, 'başarılı yetkisiz okuma');
  assert.ok(turnViolations({ ...base, log: [], evidence: [{ data: { filters: { assignee: 'team', teamLevel: 'department' } } }] }, { noDepartmentRead: true }).length, 'yetkisiz bölüm kanıtı');
  // İki haftalık dönem başka kapsamın (ekip) okumasında değil, beklenen kapsamın (kendi) okumasında olmalıdır.
  const windowRead = (assigneeMode) => ({ query: 'task-facts', params: { assigneeMode, dateFrom: shift(0), dateTo: shift(13) }, ok: true });
  assert.ok(turnViolations({ ...base, log: [windowRead('team'), { query: 'task-facts', params: { assigneeMode: 'me' }, ok: true }], evidence: [] }, { assignee: 'me', windowDays: 14 })
    .some((problem) => /14 günlük dönem okunmadı/.test(problem)));
  assert.deepEqual(turnViolations({ ...base, log: [windowRead('me')], evidence: [] }, { assignee: 'me', windowDays: 14 }), []);
});

test('kilometre taşlarının hiçbirinin termini yoksa özet bölümü düşmez: aynı kanıt tam liste olarak gösterilir ve gecikme yargısı kurulmaz', async (t) => {
  const { stack, ask } = conversation(t, 'B');
  const open = stack.db.tasks.filter((task) => task.ProjectId === EXEC_PROJECTS.KAP && task.IsMilestone && task.Status !== 'done');
  assert.ok(open.length >= 2, 'temsilî veri en az iki açık kilometre taşı içerir');
  for (const task of open) Object.assign(task, { TargetFinish: null, PlannedFinish: null, PlannedStart: null });
  const result = await ask({ text: 'KAP TOOL projesinin kilometre taşlarının durumu nedir?', plan: { intent: 'rota', language: 'tr',
    analysis: { scope: 'project', names: ['KAP TOOL'], focus: ['milestones'] } } });
  const content = String(result.answer.content || '');
  assert.equal(result.answer.finishReason, 'stop', content);
  for (const task of open) assert.match(content, new RegExp(task.Title), 'termini olmayan kilometre taşı satırı gösterilir');
  assert.match(content, new RegExp(`[Tt]ermini olmayan \\*\\*${open.length}\\*\\* açık kilometre taşı`));
  assert.doesNotMatch(content, /kilometre taşının hiçbiri gecikmiş değil|kilometre taşı gecikmiş/);
  // Yedek doğrulama aynı kanıttandır: kilometre taşı yönü tek görev okumasıdır (ek okuma yok).
  assert.equal(populationReads(result.log).length, 1);
});

test('kadro tamlığı: üye atama okumaları sırasında kapsamdan çıkıp dönerse (kadro ve son üyelik aynı) sıfır satır ve tamlık iddiası kurulmaz', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = executiveBenchmarkSeed();
  const members = seed.executiveScope.filter((entry) => entry.ManagerSicil === P.B && (entry.ScopeType || 'UNIT') === 'UNIT').map((entry) => entry.EmployeeSicil);
  const [left, stays] = members.filter((sicil) => sicil !== EXEC_PEOPLE.ILGAZ);
  // B'nin tam erişimi olmayan projede iki birim üyesinin ortak görevi: kimlik tabanı yoktur, ataması yalnızca yönetim kapsamıyla görünür.
  const projectId = '30000000-0000-4000-8000-0000000000aa';
  const taskId = '30000000-0000-4000-8000-0000000000ab';
  seed.projects.push({ ProjectId: projectId, SourceType: 'MANUAL', ProjectCode: 'YRT', ProjectName: 'Yarış Projesi', LeadSicil: P.E, CalendarId: seed.tasks[0].CalendarId });
  seed.tasks.push({ ...seed.tasks.find((task) => task.Status !== 'done'), TaskId: taskId, ProjectId: projectId, Title: 'Ortak yarış görevi', CreatedBySicil: P.E });
  seed.taskAssignees.push({ TaskId: taskId, Sicil: left }, { TaskId: taskId, Sicil: stays });
  // Ayrılan üyenin başka görünür açık görevi yoktur: yanlış okumada sıfır satırla "boşta" görünürdü.
  seed.taskAssignees = seed.taskAssignees.filter((row) => row.Sicil !== left || row.TaskId === taskId);
  const stack = createAiStack(t, { sicil: P.B, seed, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  const before = await callRotaTool(stack, P.B, 'rota_workload_summary', { assignee: 'team', teamLevel: 'unit', limit: 25 });
  const counted = before.result.data.people.find((person) => person.sicil === left);
  assert.ok(counted && counted.openTasks >= 1, 'tutarlı okumada ortak görev üyenin satırında sayılır');
  // Üye atama okumaları sırasında kapsam dışındadır; kadro anlık görüntüsü ve toplu işin sonundaki üyelik değişmez.
  stack.db.assignmentScopeExcluded = [left];
  const race = await callRotaTool(stack, P.B, 'rota_workload_summary', { assignee: 'team', teamLevel: 'unit', limit: 25 });
  assert.equal(race.result.ok, true, JSON.stringify(race.result));
  assert.equal(race.result.data.populationComplete, false, 'tutarsız okumada tamlık iddiası yok');
  assert.equal(race.result.data.people.some((person) => person.sicil === left && person.openTasks === 0), false, 'yanlış sıfır satır eklenmez');
  // Üretim sorgusu aynı denetimi kadronun değişim işaretine katar.
  const { AI_TOOL_TASK_FACTS_SQL } = await import('../src/server/ai/tools/rota/rotaToolQueries.js');
  assert.match(AI_TOOL_TASK_FACTS_SQL, /JOIN #AiRosterStart r ON r\.EmployeeSicil = ta\.Sicil\s+WHERE NOT EXISTS \(SELECT 1 FROM #AiAssignees a WHERE a\.TaskId = ta\.TaskId AND a\.Sicil = ta\.Sicil AND a\.IdentityVisible = 1\)/);
});

/* ── Kök neden regresyonları: plan birleşimi, okuma bütçesi ve onarım ── */

const unpackWith = (plan, options = {}) => unpackTypedPlan({ toolCalls: [{ name: 'rota_plan', arguments: JSON.stringify(plan) }] }, { today: TODAY, ...options });
const sectionsOf = (result) => [result.plan.request, ...(result.plan.additionalRequests || [])];

test('tek kapsamlı Ayrıntılı özette açık istek için yer ayrılır: isteğe bağlı okumalar düşer, bildirilen yönler ve açık sayım okunur', () => {
  const count = { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' }, filters: { assignee: 'team', teamLevel: 'department', status: ['todo', 'in_progress'], priority: ['critical'] } };
  const result = unpackWith({ intent: 'rota', language: 'tr', analysis: { scope: 'team', level: 'department', focus: ['overview', 'overdue', 'upcoming', 'priority'] }, request: count }, { detail: 'detailed' });
  const sections = sectionsOf(result);
  assert.ok(sections.length <= ANALYSIS_LIMITS.maxParts);
  assert.ok(sections.some((part) => part.filters?.priority?.includes('critical') && part.operation === 'value'), 'açık sayım okunur');
  for (const groupBy of ['priority']) assert.ok(sections.some((part) => part.population.groupBy === groupBy));
  assert.ok(sections.some((part) => part.filters?.deadline === 'overdue') && sections.some((part) => part.filters?.deadline === 'due_next_7_days'));
});

test('ayrılan yer kapsamayı değiştirince yeniden hesaplanır: iki açık istek altı bölüme sığar', () => {
  const workload = { operation: 'list', metrics: ['person.name', 'tasks.open', 'tasks.overdue', 'tasks.dueNext7Days'], population: { tool: 'rota_workload_summary', collection: 'people' }, filters: { assignee: 'team' } };
  const count = { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' }, filters: { assignee: 'me', priority: ['critical'] } };
  const result = unpackWith({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'overdue', 'upcoming'], also: [{ scope: 'team', focus: ['overview', 'milestones', 'workload'] }] },
    request: workload, additionalRequests: [count] });
  const sections = sectionsOf(result);
  assert.ok(sections.length <= ANALYSIS_LIMITS.maxParts, String(sections.length));
  assert.ok(sections.some((part) => part.population.tool === 'rota_workload_summary'), 'iş yükü listesi okunur');
  assert.ok(sections.some((part) => part.filters?.priority?.includes('critical')), 'açık sayım okunur');
});

test('açık isteğin yazılmış sırası, özetin aynı okumasının etkin varsayılan sırasıyla eşleşir: aynı okuma ikinci kez okunmaz', () => {
  const rank = { operation: 'rank', metrics: ['task.title', 'task.overdueDays'], rank: { metric: 'task.overdueDays', order: 'desc', limit: 8 },
    population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' }, filters: { assignee: 'me', deadline: 'overdue' } };
  const result = unpackWith({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'status', 'priority', 'deadlines', 'overdue', 'upcoming'] }, request: rank });
  assert.equal(sectionsOf(result).length, 6);
  assert.equal(result.explicitPaths, undefined, 'açık istek özetin okumasına birleşti');
});

test('geçersiz sunum tercihi taşıyan açık istek özetin okumasına birleştirilmez: sorunu kendi yoluyla bildirilir', () => {
  const rank = { operation: 'rank', metrics: ['task.title', 'task.overdueDays'], rank: { metric: 'task.overdueDays', order: 'desc', limit: 8 },
    population: { tool: 'rota_task_search', collection: 'tasks' }, layout: 'grid', filters: { assignee: 'me', deadline: 'overdue' } };
  const result = unpackWith({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overdue'] }, request: rank });
  assert.ok(Object.values(result.explicitPaths || {}).includes('$.request'), 'isteğin kendi yolu korunur');
  assert.ok(sectionsOf(result).every((part) => part.layout !== 'grid' || part === sectionsOf(result).at(-1)), 'özetin okuması geçersiz düzeni almaz');
});

test('çok kapsamlı özette bölüm yöneticisinin kapsamına alt birim kırılımı da eklenir; projeler kapsamının portföy okuması dağılımlardan önce yer alır', () => {
  const org = sectionsOf(unpackWith({ intent: 'rota', language: 'tr', analysis: { scope: 'team', level: 'department', focus: ['overview'], also: [{ scope: 'self', focus: ['overview'] }] } }));
  assert.ok(org.some((part) => part.population.groupBy === 'unit' && part.filters?.teamLevel === 'department'));
  const portfolio = unpackWith({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['priority', 'deadlines', 'schedule'], also: [{ scope: 'team' }, { scope: 'projects' }] } });
  assert.ok(sectionsOf(portfolio).some((part) => part.population.tool === 'rota_portfolio_summary' && part.population.collection === 'projects'), 'projeler kapsamının zorunlu okuması');
  assert.equal((portfolio.plan.analysis.omitted || []).some((item) => item.focus === 'projects'), false);
});

test('örgütsel takip önceki ekip düzeyinin bir alt düzeyine açılır (bölüm → birim); GUID proje kimliği ad aramasına çevrilmez', () => {
  const follow = expandAnalysis({ scope: 'previous', focus: ['org'] }, { previous: { scope: 'team', level: 'department', focus: ['org'] }, today: TODAY });
  assert.ok(follow.some((part) => part.population.groupBy === 'unit'), JSON.stringify(follow.map((part) => part.population.groupBy)));
  assert.equal(follow.some((part) => part.population.groupBy === 'department'), false);
  const guid = '10000000-0000-4000-8000-000000000001';
  const { plan } = unpackWith({ intent: 'rota', language: 'tr', request: { operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks' }, filters: { projectId: guid } } });
  assert.equal(plan.request.filters.projectId, guid);
  assert.equal((plan.request.entities || []).some((entity) => entity.text === guid), false);
});

test('özet onarımı: boş istek nesnesi onarım yuvası değildir; açık isteğin nüfus reddi nüfus aracını değiştirerek onarılır', async (t) => {
  const run = async (st, plans, text) => {
    st.mock.timers.enable({ apis: ['Date'], now: NOW });
    const seed = executiveBenchmarkSeed();
    st.mock.timers.reset();
    let standard = null;
    let escalated = false;
    const { ask } = phase4eConversation(st, { sicil: P.B, seed, planner: (input) => {
      standard ??= input.model;
      if (input.model !== standard) { escalated = true; return { type: 'status', status: 503 }; }
      return { type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plans.shift() || plans.at(-1) || null }] };
    } });
    return { result: await ask({ text }), escalated };
  };
  await t.test('boş istek', async (st) => {
    const first = { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'upcoming'], dateFrom: '2026-02-31', dateTo: shift(6) }, request: {} };
    const fixed = { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'upcoming'], dateFrom: shift(0), dateTo: shift(6) } };
    const { result, escalated } = await run(st, [first, fixed], 'Durumumu özetle.');
    assert.equal(escalated, false);
    assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  });
  await t.test('açık isteğin nüfusu', async (st) => {
    const request = (tool) => ({ operation: 'value', metrics: ['tasks.overdue'], population: { tool, ...(tool === 'rota_task_search' ? { collection: 'tasks' } : {}) }, filters: { assignee: 'me', priority: ['critical'] } });
    const first = { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'] }, request: request('rota_task_search') };
    const fixed = { ...first, request: request('rota_task_analytics') };
    const { result, escalated } = await run(st, [first, fixed], 'Durumumu özetle; ayrıca kritik gecikmiş işlerimin sayısını ver.');
    assert.equal(escalated, false);
    assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  });
});

test('özetin yanındaki açık tam liste, aracın sayfasından büyük nüfusta sınırlı sıralama başıyla yanıtlanmış sayılmaz', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = executiveBenchmarkSeed();
  t.mock.timers.reset();
  const template = seed.tasks.find((task) => task.ProjectId === EXEC_PROJECTS.BGS && task.Status !== 'done');
  for (let index = 0; index < 30; index += 1) {
    const sicil = 940000 + index;
    seed.people.push({ Sicil: sicil, DisplayName: `Liste Üyesi ${index + 1}`, Username: `lu${index}`, Unit: 'Uygulama Geliştirme', Department: 'Yazılım', Directorate: 'Bilgi Sistemleri' });
    seed.executiveScope.push({ ManagerSicil: P.B, EmployeeSicil: sicil, ScopeType: 'UNIT' });
    const taskId = `25000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    seed.tasks.push({ ...template, TaskId: taskId, Title: `Liste işi ${index + 1}` });
    seed.taskAssignees.push({ TaskId: taskId, Sicil: sicil });
  }
  const { ask } = phase4eConversation(t, { sicil: P.B, seed });
  const list = { operation: 'list', metrics: ['person.name', 'tasks.open', 'tasks.overdue', 'tasks.dueNext7Days'], population: { tool: 'rota_workload_summary', collection: 'people' }, filters: { assignee: 'team', teamLevel: 'unit' } };
  const result = await ask({ text: 'Durumumu özetle; ayrıca birimimdeki herkesin açık görev sayısının tam listesini ver.', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'] }, request: list } });
  const content = String(result.answer.content);
  // Tam liste istendi: sıralama başı (ilk N kişi) tam listenin yerine geçmez. Gösterilen üyeler düzenden bağımsız sayılır (tablo
  // satırı, madde işareti ya da düz metin): ya otuz eklenen üyenin hepsi görünür ya da hiçbiri görünmez ve eksiklik açıkça söylenir.
  const shown = new Set([...content.matchAll(/Liste Üyesi (\d+)\b/g)].map((match) => match[1]));
  if (shown.size) assert.ok(shown.size >= 30, `sıralama başı tam liste diye sunuldu: ${shown.size} üye`);
  else assert.match(content, /güvenle tamamlanamadı/, 'liste verilmediyse eksiklik açıkça bildirilmeli');
});

test('özetin çerçevesi yalnızca özetin bölümlerinden kurulur: yanındaki adlı proje listesi kendi işlerini o projeyle sınırlı göstermez', async (t) => {
  const { ask } = conversation(t, 'B');
  const list = { operation: 'list', metrics: ['task.title', 'task.targetFinish'], population: { tool: 'rota_task_search', collection: 'tasks' }, layout: 'list',
    entities: [{ type: 'project', text: 'Mevzuat Uyum' }], filters: { assignee: 'me', status: ['todo', 'in_progress'] } };
  const result = await ask({ text: 'Durumumu özetle, ayrıca Mevzuat Uyum projesindeki açık işlerimi listele.', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'] }, request: list } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.doesNotMatch(String(result.answer.content).split('\n')[0], /proje: \*\*Mevzuat Uyum\*\*|Mevzuat Uyum/, 'özetin çerçevesi açık listenin projesini almaz');
});

/* ── Kök neden regresyonları: kanıt ve anlatım ─────────────────── */

const { closingSentence } = await import('../src/domain/ai/groundedComposition.js');
const { renderVerifiedNarrative } = await import('../src/domain/ai/evidenceNarrative.js');

test('öncelik kapanışı: sunucu metniyle başlayan öğe cümle ortasında küçük harfle sürer; kalın veri adı ve kısaltma korunur', () => {
  const text = closingSentence(['Gecikmiş işler — açık işlerin yarısı', '**Faz 1** — gecikmiş kilometre taşı', 'WBS düğümü — eksik', 'İmza süreci — termin yok'], 'tr');
  assert.match(text, /önce gecikmiş işler — /);
  assert.match(text, /ardından \*\*Faz 1\*\* — /);
  assert.match(text, /ardından WBS düğümü — /);
  assert.match(text, /son olarak imza süreci — /, 'Türkçe büyük İ küçük i olur');
  assert.match(closingSentence(['Overdue work in your unit', 'Open work in your team'], 'en'), /first overdue work in your unit; then open work/);
});

test('kapsam karşılaştırması: adlı kişi ile ekip örtüşmesi kişinin işleriyle anlatılır; toplam seçilmeden boş kapsamın oranı söylenmez; adlı katman önceliği veri parçasıdır', () => {
  const layer = (evidenceId, filters, values) => Object.entries(values).map(([key, value]) => fact(evidenceId, `data.totals.${key}`, value, { tool: 'rota_task_analytics', filters }));
  const person = { assignee: 'person', personSicil: 910001, person: 'Ali **Kalın**【R9】' };
  const findings = analyticalFindings([part(0, layer('R1', person, { open: 4, overdue: 3, completionRatePercent: 20 })),
    part(1, layer('R2', { assignee: 'team', teamLevel: 'unit' }, { open: 10, overdue: 1, completionRatePercent: 50 }))]);
  const story = synthesisNarrative(findings);
  const told = [story.intro.plain, ...((story.intro.insights?.paragraphs || [story.intro.insights]).filter(Boolean).map((item) => item.plain))].join('\n');
  assert.equal(findings.some((item) => item.kind === 'levelComparison'), true);
  assert.match(told, /adı geçen kişinin işleri diğer kapsamda da sayılabilir/);
  assert.doesNotMatch(told, /Ekibinizden biriyle ortak sorumlu olduğunuz/);
  // Adlı katman öncelikte veri olarak (kaçışlı) yazılır: biçim ya da kaynak rozeti oluşturmaz.
  if (story.conclusion) assert.doesNotMatch(story.conclusion.markdown, /【R9】|\*\*Kalın\*\*(?!\*)/);
  // Toplam seçilmedi; açık ve tamamlanan sıfır: kapsam boştur, tamamlanma oranı (%0) söylenmez.
  const empty = analyticalFindings([part(0, layer('R1', { assignee: 'me' }, { open: 0, overdue: 0, done: 0, completionRatePercent: 0 })),
    part(1, layer('R2', { assignee: 'team', teamLevel: 'unit' }, { open: 10, overdue: 1, done: 10, completionRatePercent: 50 }))]);
  const level = empty.find((item) => item.kind === 'levelComparison');
  assert.equal(level.layers.find((item) => item.type === 'self').completion, null);
});

test('proje süzgeçli tek satırlık örgütsel kırılım bölüm olarak anlatılır (proje adı sayılmaz); atama durumu grubu örgütsel birim gibi anlatılmaz', () => {
  const row = (key, label) => {
    const semantic = { tool: 'rota_task_analytics', filters: { projectId: 'p1', project: 'Alfa' }, groupBy: 'department', group: { key, label }, row: { identity: key, collectionSize: 1 } };
    // Gerçek kanıtta satır olgusu öznesini (grubun adı) taşır.
    return [fact('R1', 'data.groups.0.label', label, semantic), fact('R1', 'data.groups.0.open', 3, semantic)]
      .map((item) => ({ ...item, fact: { ...item.fact, subject: label, subjectId: 'data.groups.0' } }));
  };
  const department = renderVerifiedNarrative(row('org:kalite', 'Kalite'));
  assert.doesNotMatch(department, /\*\*Kalite\*\* projesinde/);
  assert.match(department, /\*\*Kalite\*\* bölümündeki sorumlularda/);
  assert.match(department, /Proje: Alfa/, 'seçilen proje ayrı niteleyici olarak kalır');
  const unassigned = renderVerifiedNarrative(row('unassigned', 'Sorumlusuz'));
  assert.doesNotMatch(unassigned, /Sorumlusuz\*\* bölümündeki/);
});

test('tablo girişi atamasız ya da birimi belirsiz satırı kişi/birim diye adlandırmaz; iş yükü önderine oran sütunu katılmaz', () => {
  const columns = [{ label: 'Açık görev', numeric: true }, { label: 'Gecikmiş görev', numeric: true }];
  assert.match(tableLeadSentence({ collection: 'data.groups', groupBy: 'unit', columns, groupKeys: ['org:a', 'org:b'] }, 'tr'), /^Birimlerin açık ve gecikmiş görev sayıları/);
  assert.doesNotMatch(tableLeadSentence({ collection: 'data.groups', groupBy: 'unit', columns, groupKeys: ['org:a', 'no_unit'] }, 'tr'), /^Birimlerin/);
  assert.doesNotMatch(tableLeadSentence({ collection: 'data.groups', groupBy: 'assignee', columns, groupKeys: ['p:1', 'unassigned'] }, 'tr'), /^Kişilerin/);
});

test('ekip dağılımının tamlık cümlesi yalnızca gösterilen satırlar bütün ekipse kurulur; tek kişilik sıralama başında kurulmaz', () => {
  const filters = { assignee: 'team', teamLevel: 'unit' };
  const peopleRows = (shown, size) => [fact('R1', 'data.populationComplete', true, { tool: 'rota_workload_summary', filters }),
    ...shown.flatMap(([name, open], index) => {
      const semantic = { tool: 'rota_workload_summary', filters, row: { identity: `p${index}`, collectionSize: size } };
      return [fact('R1', `data.people.${index}.name`, name, semantic), fact('R1', `data.people.${index}.openTasks`, open, semantic)];
    })];
  const everyone = /bütün kişileri \(görünür açık görevi olmayanlar dahil\)/;
  assert.doesNotMatch(renderVerifiedNarrative(peopleRows([['Ali', 3]], 5), { layout: 'table' }), everyone, 'beş kişilik ekipte tek satır bütün ekip değildir');
  assert.match(renderVerifiedNarrative(peopleRows([['Ali', 3], ['Can', 0]], 2), { layout: 'table' }), everyone);
});

test('çok kapsamlı dönemli dağılımda kapsam başlığı dönemi söylemez: tablonun dönem ölçütü bastırılmaz', async (t) => {
  // Model dönem taşıyan sayım önermesini seçmez (yalnızca dönemsiz önermeler ve tablolar): dönem ölçütü tabloda kalmalıdır.
  const dated = (item) => /Ağustos|Eylül|ölçüt/.test(JSON.stringify(item));
  const { ask } = conversation(t, 'B', { compose: () => composer((view) => {
    const blocks = coveringBlocks(view).blocks.map((block) => (block.type === 'say' ? { ...block, items: block.items.filter((id) => !dated(view.propositions.find((item) => item.id === id))) } : block))
      .filter((block) => block.type !== 'say' || block.items.length);
    return { blocks };
  }) });
  const result = await ask({ text: 'Son bir ayda terminli işlerimin ve birimimin durum dağılımını karşılaştır.', plan: { intent: 'rota', language: 'tr',
    analysis: { scope: 'self', focus: ['status'], dateFrom: shift(-30), dateTo: shift(0), also: [{ scope: 'team', level: 'unit' }] } } });
  const content = String(result.answer.content);
  assert.equal(result.answer.finishReason, 'stop', content);
  // Dönemli bölümün sayıları dönem koşuluyla birlikte görünür (başlık yalnızca kapsamı ve konuyu adlandırır).
  assert.match(content, /31 Ağustos 2026|30 Ağustos 2026/, content);
});

/* ── Kök neden regresyonları: nitelendirme denetleyicisi ───────── */

test('nitelendirme denetleyicisi: başarısız, proje kısıtlı ya da bildirilmemiş (portföy) okuma kapsamı karşılamaz; kapsamın yönü kendi kanıtıyla denetlenir', () => {
  const read = (params, ok = true) => ({ query: 'task-facts', params, ok });
  const answer = { content: 'Yanıt 【R1】', finishReason: 'stop' };
  const layers = [{ scope: 'self', focus: ['overview'] }, { scope: 'team', level: 'unit', focus: ['overview'] }, { scope: 'team', level: 'department', focus: ['overview'] }];
  const good = [read({ assigneeMode: 'me' }), read({ assigneeMode: 'team', teamLevel: 'UNIT' }), read({ assigneeMode: 'team', teamLevel: 'DEPARTMENT' })];
  assert.deepEqual(turnViolations({ answer, log: good, evidence: [] }, { layers }), []);
  // Başarısız bölüm okuması bölüm kapsamını okunmuş saymaz.
  assert.ok(turnViolations({ answer, log: [good[0], good[1], read({ assigneeMode: 'team', teamLevel: 'DEPARTMENT' }, false)], evidence: [] }, { layers })
    .includes('kapsam okunmadı: team/department'));
  // Tek projeyle daraltılmış okumalar kısıtsız kapsamların okuması değildir.
  const narrowed = good.map((row) => ({ ...row, params: { ...row.params, projectId: EXEC_PROJECTS.KAP } }));
  assert.ok(turnViolations({ answer, log: narrowed, evidence: [] }, { layers }).includes('bildirilmeyen kapsam okundu'));
  // Bildirilmemiş portföy okuması da yakalanır.
  assert.ok(turnViolations({ answer, log: [...good, { query: 'portfolio', params: {}, ok: true }], evidence: [] }, { layers }).includes('bildirilmeyen kapsam okundu'));
  // Ek kapsamın yönü (ekip iş yükü) yalnızca özet okumasıyla karşılanmaz; kendi kanıtı gerekir.
  const withWorkload = [{ scope: 'self', focus: ['overview'] }, { scope: 'team', level: 'unit', focus: ['workload'] }];
  const reads = good.slice(0, 2);
  assert.ok(turnViolations({ answer, log: reads, evidence: [] }, { layers: withWorkload }).includes('kapsamın yönü okunmadı: team/unit/workload'));
  const workloadEvidence = { evidenceId: 'R1', tool: 'rota_workload_summary', data: { filters: { assignee: 'team', teamLevel: 'unit' } } };
  assert.deepEqual(turnViolations({ answer, log: reads, evidence: [workloadEvidence] }, { layers: withWorkload }), []);
});

test('nitelendirme denetleyicisi: sunucunun eklediği alt birim kırılımı yalnızca okunduysa yön sayılır; açıklama vakası nüfus okuyamaz; açık liste kendi kanıtıyla teslim edilmelidir', () => {
  const answer = { content: 'Yanıt 【R1】', finishReason: 'stop' };
  const log = [{ query: 'task-facts', params: { assigneeMode: 'team', teamLevel: 'DEPARTMENT' }, ok: true }];
  const context = { scope: 'team', level: 'department', focus: ['overview'] };
  assert.ok(turnViolations({ answer, log, evidence: [], analysisContext: context }, { focus: ['overview', 'org'] }).includes('analitik yönler eksik'));
  const org = { evidenceId: 'R1', tool: 'rota_task_analytics', data: { groupBy: 'unit', filters: { assignee: 'team', teamLevel: 'department' } } };
  assert.deepEqual(turnViolations({ answer, log, evidence: [org], analysisContext: context }, { focus: ['overview', 'org'] }), []);
  // Açıklama bitişi görev nüfusu okumasını örtmez; ad çözümü serbesttir.
  const clarification = { content: 'Hangisi?', finishReason: 'clarification' };
  assert.ok(turnViolations({ answer: clarification, log, evidence: [] }, { finish: 'clarification', noPopulation: true }).includes('açıklama vakasında görev nüfusu okundu'));
  assert.deepEqual(turnViolations({ answer: clarification, log: [{ query: 'project-search', params: {}, ok: true }], evidence: [] }, { finish: 'clarification', noPopulation: true }), []);
  // Açık kritik iş listesi: özetin kişi tablosu yetmez; isteğin süzgeçleriyle okunmuş ve kaynağıyla teslim edilmiş liste gerekir.
  const wanted = [{ tool: 'rota_task_search', filters: { assignee: 'team', teamLevel: 'unit', status: ['todo', 'in_progress'], priority: ['critical'] } }];
  const people = { evidenceId: 'R1', tool: 'rota_workload_summary', data: { filters: { assignee: 'team', teamLevel: 'unit' } } };
  assert.ok(turnViolations({ answer, log, evidence: [people] }, { explicitRequests: wanted }).some((problem) => problem.startsWith('açık istek teslim edilmedi')));
  const critical = { evidenceId: 'R2', tool: 'rota_task_search', data: { filters: { assignee: 'team', teamLevel: 'UNIT', statuses: ['in_progress', 'todo'], priorities: ['critical'] } } };
  assert.deepEqual(turnViolations({ answer: { ...answer, content: 'Liste 【R2】' }, log, evidence: [critical] }, { explicitRequests: wanted }), []);
  // Tek proje gecikme önderi ("projesinde") kalıpla yakalanır.
  assert.match('En çok gecikmiş görev **KAP TOOL** projesinde (**3**).', G_FINDING_TEXT.overdueLeader);
});

test('nitelendirme beklentisi: çok turlu vakanın ara turu kendi altın planının kapsamıyla puanlanır; açık istek ve kapsam yönleri beklentiye girer', () => {
  const g49 = fixture.scenarios.find((item) => item.id === 'g49');
  const first = executiveTurnExpectation(g49, 0);
  assert.deepEqual([first.finish, first.assignee, first.level], ['stop', 'team', 'unit']);
  assert.ok(turnViolations({ answer: { content: 'Yanıt 【R1】', finishReason: 'stop' }, log: [{ query: 'task-facts', params: { assigneeMode: 'me' }, ok: true }], evidence: [] }, first).length > 0,
    'kendi kapsamı birim iş yükünün yerine geçmez');
  assert.equal(executiveTurnExpectation(g49, 1).noTeamRead, true);
  const g52 = executiveExpectation(fixture.scenarios.find((item) => item.id === 'g52'));
  assert.equal(g52.explicitRequests?.[0]?.tool, 'rota_task_search');
  const g12 = executiveExpectation(fixture.scenarios.find((item) => item.id === 'g12'));
  assert.ok(g12.layers.every((layer) => Array.isArray(layer.focus) && layer.focus.length));
  assert.equal(executiveExpectation(fixture.scenarios.find((item) => item.id === 'g42')).noPopulation, true);
});

/* ── Yakınsama turu kök neden regresyonları ─────────────────────── */

test('kilometre taşı: sıralı önekten başlıksız satır düştüyse kesin gecikmiş sayısı ve en uzun gecikme kurulmaz', () => {
  const ranking = { metric: 'task.targetFinish', order: 'asc', limit: 8 };
  // İkinci satırın başlığı yoktur (düşer); ardından gelen yaklaşan satır öneki "tam" göstermez.
  const facts = milestones([['A', shift(-3), 3], ['B', shift(-9), 9], ['C', shift(5), null]], { total: 5, size: 5, complete: false })
    .filter((item) => item.fact.field !== 'data.tasks.1.title');
  // Kesik önek sıralama başı değildir: kesin sayı da en uzun gecikme de (A, oysa düşen B daha uzun gecikmiş) kurulmaz.
  const findings = analyticalFindings([part(0, facts, ranking)]);
  assert.equal(findings.some((item) => item.kind === 'milestoneStatus'), false);
  assert.doesNotMatch(synthesisNarrative(findings).intro?.plain || '', /kilometre taşından|en uzun süredir geciken A/);
  // Satır düşmediyse aynı sayfa kesin sayıyı ve en uzun gecikmeyi verir.
  const intact = analyticalFindings([part(0, milestones([['B', shift(-9), 9], ['A', shift(-3), 3], ['C', shift(5), null]], { total: 5, size: 5, complete: false }), ranking)])
    .find((item) => item.kind === 'milestoneStatus');
  assert.deepEqual([intact.metrics.overdueExact, intact.metrics.overdue, intact.metrics.worst.title], [true, 2, 'B']);
});

test('gecikmiş liste: sıralı önekten satır düştüyse sıralama başı (en uzun gecikme) kurulmaz', () => {
  const filters = { deadline: 'overdue', assignee: 'me' };
  const rows = [['X', 20], ['Y', 15], ['Z', 4]];
  const list = (drop) => [fact('R1', 'totalCount', 9, { tool: 'rota_task_search', filters, complete: false }),
    ...rows.flatMap(([title, days], index) => {
      const semantic = { tool: 'rota_task_search', filters, complete: false, row: { identity: `t${index}`, collectionSize: 9 } };
      return [...(index === drop ? [] : [fact('R1', `data.tasks.${index}.title`, title, semantic)]), fact('R1', `data.tasks.${index}.overdueDays`, days, semantic)];
    })];
  const ranking = { metric: 'task.overdueDays', order: 'desc' };
  assert.equal(analyticalFindings([part(0, list(-1), ranking)]).find((item) => item.kind === 'longestOverdue')?.entity.name, 'X');
  assert.equal(analyticalFindings([part(0, list(0), ranking)]).some((item) => item.kind === 'longestOverdue'), false, 'ilk satır düştüyse Y en uzun gecikme sayılmaz');
});

test('kilometre taşı: metin, iş dağılımı düğümü, öncelik ya da oluşturan koşuluyla daraltılmış liste açık kilometre taşı nüfusu sayılmaz', () => {
  const ranking = { metric: 'task.targetFinish', order: 'asc' };
  for (const [key, value] of [['text', 'Radar'], ['wbsId', 'w-1'], ['priorities', ['critical']], ['createdByMe', true]]) {
    const facts = milestones([['Faz 1', shift(-9), 9], ['Pilot', shift(12), null]]);
    facts[0].fact.semantic.filters[key] = value;
    const findings = analyticalFindings([part(0, facts, ranking)]);
    assert.equal(findings.some((item) => item.kind === 'milestoneStatus'), false, key);
    assert.doesNotMatch(synthesisNarrative(findings).intro?.plain || '', /kilometre taşından/, key);
  }
});

test('kilometre taşı: farklı projelerdeki adaş kilometre taşları durum cümlesinde ve öncelikte proje adıyla ayrılır', () => {
  const filters = { statuses: ['todo', 'in_progress'], milestone: true };
  const rows = [['Faz 1 kabulü', shift(-9), 9, 'p1', 'Alfa'], ['Faz 1 kabulü', shift(-4), 4, 'p2', 'Beta'], ['Pilot', shift(6), null, 'p1', 'Alfa']];
  const facts = [fact('R3', 'totalCount', rows.length, { tool: 'rota_task_search', filters }),
    ...rows.flatMap(([title, due, days, projectId, project], index) => {
      const semantic = { tool: 'rota_task_search', filters, row: { identity: `t${index}`, collectionSize: rows.length, projectId } };
      return [fact('R3', `data.tasks.${index}.title`, title, semantic), fact('R3', `data.tasks.${index}.targetFinish`, due, semantic),
        fact('R3', `data.tasks.${index}.project.name`, project, semantic), ...(days != null ? [fact('R3', `data.tasks.${index}.overdueDays`, days, semantic)] : [])];
    })];
  const findings = analyticalFindings([part(0, facts, { metric: 'task.targetFinish', order: 'asc' })]);
  const narrative = synthesisNarrative(findings);
  assert.match(narrative.intro.plain, /en uzun süredir geciken Faz 1 kabulü \(9 gün, Alfa\)/);
  assert.match(narrative.conclusion.plain, /Faz 1 kabulü — gecikmiş kilometre taşı \(9 gün, Alfa\)/);
  // Adı tekil olan kilometre taşında proje eklenmez.
  assert.match(narrative.intro.plain, /sıradaki ise Pilot \(/);
  assert.doesNotMatch(narrative.intro.plain, /Pilot \([^)]*Alfa/);
});

test('tamamlanmaya karşın gecikme: durumla daraltılmış tablodan tamamlanma payı kurulmaz', () => {
  const rows = [['Alfa', 2, 1, 8], ['Beta', 6, 3, 2], ['Gama', 4, 0, 1]];
  assert.equal(analyticalFindings([part(0, projectGroups(rows))]).some((item) => item.kind === 'completionDespiteOverdue'), true);
  const restricted = projectGroups(rows, { assignee: 'team', teamLevel: 'unit', statuses: ['done', 'in_progress'] });
  assert.equal(analyticalFindings([part(0, restricted)]).some((item) => item.kind === 'completionDespiteOverdue'), false);
  const all = projectGroups(rows, { assignee: 'team', teamLevel: 'unit', statuses: ['todo', 'in_progress', 'done'] });
  assert.equal(analyticalFindings([part(0, all)]).some((item) => item.kind === 'completionDespiteOverdue'), true, 'bütün durumlar daraltma değildir');
});

test('bulgu yinelemesi: aynı proje çiftinin farklı sayıları ayrı bulgudur; eşit önderlerin satır sırası anahtarı değiştirmez', () => {
  const keyed = (rows, evidenceId) => rows.flatMap(([key, label, open, overdue, done], index) => {
    const semantic = { tool: 'rota_task_analytics', filters: {}, groupBy: 'project', group: { key, label }, row: { identity: key, collectionSize: rows.length } };
    return [fact(evidenceId, `data.groups.${index}.label`, label, semantic), fact(evidenceId, `data.groups.${index}.open`, open, semantic),
      fact(evidenceId, `data.groups.${index}.overdue`, overdue, semantic), fact(evidenceId, `data.groups.${index}.done`, done, semantic)];
  });
  const first = keyed([['p1', 'KAP · Alfa', 4, 0, 1], ['p2', 'MPO · Beta', 3, 2, 1], ['p3', 'ALT · Gama', 1, 0, 1]], 'R1');
  const second = keyed([['p1', 'KAP · Alfa', 10, 1, 1], ['p2', 'MPO · Beta', 5, 3, 1], ['p3', 'ALT · Gama', 2, 1, 1]], 'R2');
  const contrasts = analyticalFindings([part(0, first), part(1, second)]).filter((item) => item.kind === 'volumeVsDelay');
  assert.equal(contrasts.length, 2, 'aynı fark (2) ama farklı sayılar');
  assert.deepEqual(contrasts.map((item) => item.metrics.gap), [2, 2]);
  const tiedA = keyed([['p1', 'KAP · Alfa', 5, 3, 1], ['p2', 'MPO · Beta', 4, 3, 1], ['p3', 'ALT · Gama', 2, 0, 1]], 'R1');
  const tiedB = keyed([['p2', 'MPO · Beta', 4, 3, 1], ['p1', 'KAP · Alfa', 5, 3, 1], ['p3', 'ALT · Gama', 2, 0, 1]], 'R2');
  const leaders = analyticalFindings([part(0, tiedA), part(1, tiedB)]).filter((item) => item.kind === 'overdueLeader');
  assert.equal(leaders.length, 1, 'aynı eşit önderler iki kez söylenmez');
});

test('anlatım: daraltılmış sıfır sayımda "boşta değil" çekincesi eklenmez; örgütsel satırda sorumlu kapsamı ölçütte kalır', () => {
  const total = (filters) => renderVerifiedNarrative([fact('R1', 'data.totals.total', 0, { tool: 'rota_task_analytics', filters })]);
  assert.match(total({ assignee: 'me' }), /boşta olduğunuz anlamına gelmez/);
  assert.match(total({ assignee: 'me', statuses: ['todo', 'in_progress'] }), /boşta olduğunuz anlamına gelmez/, 'bütün açık işler kişinin bütün açık işidir');
  for (const narrowed of [{ deadline: 'overdue' }, { statuses: ['done'] }, { dateField: 'targetFinish', dateFrom: shift(0), dateTo: shift(7) }, { projectId: 'p1', project: 'Alfa' }]) {
    assert.doesNotMatch(total({ assignee: 'me', ...narrowed }), /boşta/, JSON.stringify(narrowed));
  }
  const row = (filters) => {
    const semantic = { tool: 'rota_task_analytics', filters, groupBy: 'department', group: { key: 'org:kalite', label: 'Kalite' }, row: { identity: 'org:kalite', collectionSize: 1 } };
    return [fact('R1', 'data.groups.0.label', 'Kalite', semantic), fact('R1', 'data.groups.0.open', 3, semantic)]
      .map((item) => ({ ...item, fact: { ...item.fact, subject: 'Kalite', subjectId: 'data.groups.0' } }));
  };
  const scoped = renderVerifiedNarrative(row({ assignee: 'team', teamLevel: 'unit' }));
  assert.match(scoped, /\*\*Kalite\*\* bölümündeki sorumlularda/);
  assert.match(scoped, /Sorumlu: Ekibiniz/, 'birim kısıtı bölüm geneli sayılmaz');
});

test('çok kapsamlı özette tek yönü tamamlanamayan kapsam: eksik bölüm yönüyle adlandırılır, okunmayan yön notu kısmi yanıtta korunur', async (t) => {
  const { stack, ask } = conversation(t, 'B');
  // Beşinci görev olgusu okuması (birimin yaklaşan teslimatları) geçici olarak başarısız olur; birimin özeti ve diğer yönleri okunur.
  let calls = 0;
  const failures = {};
  Object.defineProperty(failures, 'task-facts', { get() { calls += 1; return calls === 5 ? Object.assign(new Error('geçici okuma hatası'), { code: 'DATABASE_UNAVAILABLE' }) : undefined; } });
  stack.db.aiToolFailure = failures;
  const plan = { intent: 'rota', language: 'tr', analysis: { scope: 'team', level: 'unit', focus: ['overview', 'overdue', 'upcoming', 'milestones', 'critical'],
    also: [{ scope: 'self', focus: ['overview'] }, { scope: 'team', level: 'department', focus: ['overview'] }] } };
  const result = await ask({ text: 'Birimimin, kendimin ve bölümümün durumunu değerlendir.', plan }, { detail: 'balanced' });
  const content = String(result.answer.content);
  assert.match(content, /\*\*Biriminiz · yaklaşan teslimatların listesi:\*\*/, content);
  assert.match(content, /Biriminizin işleri için kritik işler tek yanıtın okuma sınırına sığmadığı için ayrıca gösterilmedi/, content);
  assert.doesNotMatch(content, /Her kapsamın temel göstergeleri okundu/, 'kısmi yanıtta bütün kapsamlar okundu denmez');
});

test('çok kapsamlı özetin yanındaki açık istek bölümü başlığını korur; bölüm başlıkları toptan kaldırılmaz', async (t) => {
  const { ask } = conversation(t, 'B');
  const result = await ask({ text: 'Benim ve birimimin durumunu değerlendir; KAP TOOL projesinde kaç görev var?', plan: { intent: 'rota', language: 'tr',
    analysis: { scope: 'self', focus: ['overview'], also: [{ scope: 'team', level: 'unit' }] },
    request: { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_project_detail' }, entities: [{ type: 'project', text: 'KAP TOOL' }] } } }, { detail: 'balanced' });
  const content = String(result.answer.content);
  assert.equal(result.answer.finishReason, 'stop', content);
  assert.match(content, /^#### Kendi işleriniz$/m);
  assert.match(content, /^#### Biriminiz$/m);
  // Açık istek bölümü (proje ayrıntısı) kendi başlığının altındadır: kapsam başlığının altına karışmaz.
  const blocks = content.split('\n\n');
  const project = blocks.findIndex((block) => /KAP TOOL\*\* projesinde toplam/.test(block));
  assert.ok(project > 0 && /^#### (?!Biriminiz$|Kendi işleriniz$)/.test(blocks[project - 1]), content);
});

test('özet normalleştirmesi: daraltılmış birincilin ek yinelemesi birleşmez; dizi olmayan yön katlanmaz; kendiyle karşılaştırmada anlamsız yön reddedilir', () => {
  // "Alfa'daki işlerim ve bütün işlerim": ek kapsam birincilin daraltmasını sessizce almaz; plan reddedilir.
  assert.ok(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'self', within: 'Alfa', focus: ['overview'], also: [{ scope: 'self', focus: ['overdue'] }] } }));
  // Yalnızca yazılmamış yön devralınır: metin yön ("milestones") katlanmaz, şema reddeder (yön sessizce düşmez).
  assert.ok(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'], also: [{ scope: 'person', names: ['Zeynep Kaya'], focus: 'milestones' }] } }));
  assert.ok(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'], also: [{ scope: 'self', focus: 'milestones' }] } }), 'birincilin yinelemesi de silinmez');
  // Kişi ile kendinin karşılaştırmasında alt birim kırılımı anlamsızdır: boş okumaya dönüşmez, onarım istenir.
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'person', names: ['Zeynep Kaya'], withSelf: true, focus: ['overview', 'org'] } }), ['$.analysis.focus:unsupported']);
  // Geçerli yazımlar eskisi gibi kabul edilir.
  assert.equal(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'], also: [{ scope: 'self', focus: ['overdue'] }] } }), null);
  assert.equal(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'person', names: ['Zeynep Kaya'], withSelf: true, focus: ['overview', 'overdue'] } }), null);
});

test('açık istekler: fazla ek istek kısaltılmadan reddedilir; yazılmamış koleksiyon etkin koleksiyonla eşleşir; birleşen tam liste ve yerine okunan yön işaretlenir', () => {
  const count = (priority) => ({ operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' }, filters: { assignee: 'me', priority: [priority] } });
  // Dört bağımsız ek istek: dördüncüsü sessizce düşmez.
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'] }, additionalRequests: ['critical', 'high', 'medium', 'low'].map(count) }), ['$.analysis:request']);
  assert.equal(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'] }, additionalRequests: ['critical', 'high', 'medium'].map(count) }), null);
  // Koleksiyonu yazılmamış aynı sıralama özetin okumasıdır: yedinci bölüm açılmaz, bütçe reddi yoktur.
  const rank = { operation: 'rank', metrics: ['tasks.total', 'task.title', 'task.overdueDays'], rank: { metric: 'task.overdueDays', order: 'desc' },
    population: { tool: 'rota_task_search' }, layout: 'auto', filters: { deadline: 'overdue', assignee: 'me' } };
  const merged = unpackWith({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'status', 'priority', 'deadlines', 'overdue', 'upcoming'] }, request: rank });
  assert.equal(sectionsOf(merged).length, 6);
  assert.equal(merged.explicitPaths, undefined);
  assert.equal(merged.plan.analysis.explicitParts.length, 1, 'birleşen açık isteğin bölümü işaretlenir');
  // Ekip iş yükü özetiyle aynı açık tam liste birleşir; bölüm açık isteğin tam liste koşulunu taşır.
  const people = { operation: 'list', metrics: ['person.name', 'tasks.open', 'tasks.overdue', 'tasks.dueNext7Days'], population: { tool: 'rota_workload_summary', collection: 'people' }, filters: { assignee: 'team', teamLevel: 'unit' } };
  const workload = unpackWith({ intent: 'rota', language: 'tr', analysis: { scope: 'team', level: 'unit', focus: ['workload'] }, request: people });
  const index = sectionsOf(workload).findIndex((part) => part.population.tool === 'rota_workload_summary');
  assert.deepEqual(workload.plan.analysis.explicitParts, [index]);
  // Ayrılan yer yüzünden özetin iş yükü okuması düşse de eşdeğer açık liste ayrı bölümde okunuyorsa "gösterilmedi" denmez.
  const reserved = unpackWith({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'overdue', 'upcoming'], also: [{ scope: 'team', focus: ['overview', 'milestones', 'workload'] }] },
    request: { ...people, filters: { assignee: 'team' } }, additionalRequests: [count('critical')] });
  assert.ok(sectionsOf(reserved).some((part) => part.population.tool === 'rota_workload_summary'), 'iş yükü açık istekle okunur');
  assert.equal((reserved.plan.analysis.omitted || []).some((item) => item.layer === 1 && item.focus === 'workload'), false);
});

test('proje süzgeçli kadroda sıfır satır yalnızca seçilen projedeki görünür açık görevin yokluğudur', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const stack = createAiStack(t, { sicil: P.B, seed: executiveBenchmarkSeed(), env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  const all = await callRotaTool(stack, P.B, 'rota_workload_summary', { assignee: 'team', teamLevel: 'unit', limit: 25 });
  assert.ok(all.result.data.notes.some((note) => /\d+ üyenin görünür açık görevi yok\./.test(note)));
  const scoped = await callRotaTool(stack, P.B, 'rota_workload_summary', { assignee: 'team', teamLevel: 'unit', projectId: EXEC_PROJECTS.KAP, limit: 25 });
  const note = scoped.result.data.notes.find((item) => /bütün ekip üyelerini içerir/.test(item));
  if (note) {
    assert.match(note, /üyenin seçilen projede görünür açık görevi yok \(başka projelerdeki görevleri bu sayıya girmez\)/, note);
    assert.doesNotMatch(note, /\d+ üyenin görünür açık görevi yok/);
  } else assert.equal(scoped.result.data.populationComplete, false, 'tam kadro değilse not da yoktur');
});

test('özet onarımı: boş ek istekten sonraki isteğin yolu kendi yuvasına bağlanır; nüfus reddi ölçüyü değiştirme izni değildir', async (t) => {
  const run = async (st, plans, text) => {
    st.mock.timers.enable({ apis: ['Date'], now: NOW });
    const seed = executiveBenchmarkSeed();
    st.mock.timers.reset();
    let standard = null;
    let escalated = false;
    const { ask } = phase4eConversation(st, { sicil: P.B, seed, planner: (input) => {
      standard ??= input.model;
      if (input.model !== standard) { escalated = true; return { type: 'status', status: 503 }; }
      return { type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plans.shift() || plans.at(-1) || null }] };
    } });
    return { result: await ask({ text }), escalated };
  };
  await t.test('boş ek istekten sonraki sıralama onarımı', async (st) => {
    const rank = (limit) => ({ operation: 'rank', metrics: ['task.title', 'task.targetFinish'], rank: { metric: 'task.targetFinish', order: 'asc', limit },
      population: { tool: 'rota_task_search', collection: 'tasks' }, filters: { assignee: 'me', priority: ['critical'], status: ['todo', 'in_progress'] } });
    const first = { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'] }, additionalRequests: [{}, rank(500)] };
    const fixed = { ...first, additionalRequests: [rank(3)] };
    const { result, escalated } = await run(st, [first, fixed], 'Durumumu özetle; ayrıca en yakın üç kritik işimi sırala.');
    assert.equal(escalated, false, 'reddedilen sıralama sınırı kendi yuvasında onarılır');
    assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  });
  await t.test('nüfus reddinde ölçü korunur', async (st) => {
    const request = (tool, metric) => ({ operation: 'value', metrics: [metric], population: { tool, ...(tool === 'rota_task_search' ? { collection: 'tasks' } : {}) }, filters: { assignee: 'me', priority: ['critical'] } });
    const first = { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'] }, request: request('rota_task_search', 'tasks.overdue') };
    const changed = { ...first, request: request('rota_task_analytics', 'tasks.total') };
    const { result, escalated } = await run(st, [first, changed], 'Durumumu özetle; ayrıca kritik gecikmiş işlerimin sayısını ver.');
    // Toplam sayı istenen gecikmiş sayısının yerine geçmez: onarım reddedilir (doğrulanmış yanıt bu ölçüyle kurulmaz).
    assert.ok(escalated || result.answer.finishReason !== 'stop', result.answer.content);
  });
});

test('yalnızca açık istek tamamlanamadıysa tamamlanan özet takip bağlamını kurar', async (t) => {
  // F profilinin yalnızca birim kapsamı vardır: bölüm iş yükü listesi yetki nedeniyle tamamlanamaz; birim özeti tamamlanır.
  const { ask } = conversation(t, 'F');
  const department = { operation: 'list', metrics: ['person.name', 'tasks.open'], population: { tool: 'rota_workload_summary', collection: 'people' }, filters: { assignee: 'team', teamLevel: 'department' } };
  const result = await ask({ text: 'Birimimin durumunu özetle; ayrıca bölümümün iş yükünü listele.', plan: { intent: 'rota', language: 'tr',
    analysis: { scope: 'team', level: 'unit', focus: ['overview'] }, request: department } });
  assert.match(String(result.answer.content), /【R\d+】/, result.answer.content);
  assert.deepEqual([result.analysisContext?.scope, result.analysisContext?.level], ['team', 'unit'], JSON.stringify(result.analysisContext));
});


test('nitelendirme denetleyicisi: başarısız dönem okuması, yalnızca tamamlananlar ve daraltılmış proje kırılımı yönü karşılamaz', () => {
  const answer = { content: 'Yanıt 【R1】', finishReason: 'stop' };
  // g15: 14 günlük okuma başarısızsa dönem okunmuş sayılmaz.
  const window = (ok) => [{ query: 'task-facts', params: { assigneeMode: 'team', teamLevel: 'UNIT', dateFrom: shift(0), dateTo: shift(13) }, ok }];
  assert.ok(turnViolations({ answer, log: window(false), evidence: [] }, { windowDays: 14 }).includes('14 günlük dönem okunmadı'));
  assert.equal(turnViolations({ answer, log: window(true), evidence: [] }, { windowDays: 14 }).includes('14 günlük dönem okunmadı'), false);
  const reads = [{ query: 'task-facts', params: { assigneeMode: 'team', teamLevel: 'UNIT' }, ok: true }];
  const layers = (focus) => [{ scope: 'team', level: 'unit', focus: [focus] }];
  const evidence = (data, tool = 'rota_task_search') => [{ evidenceId: 'R1', tool, data: { ...data, filters: { assignee: 'team', teamLevel: 'unit', ...data.filters } } }];
  // g31: yalnızca tamamlanan kilometre taşları açık kilometre taşı yönü değildir.
  assert.ok(turnViolations({ answer, log: reads, evidence: evidence({ filters: { milestone: true, statuses: ['done'] } }) }, { layers: layers('milestones') }).includes('kapsamın yönü okunmadı: team/unit/milestones'));
  assert.deepEqual(turnViolations({ answer, log: reads, evidence: evidence({ filters: { milestone: true, statuses: ['todo', 'in_progress'] } }) }, { layers: layers('milestones') }), []);
  // g48: yalnızca tamamlananlarla daraltılmış proje kırılımı yönü karşılamaz.
  const projects = (filters) => evidence({ groupBy: 'project', filters }, 'rota_task_analytics');
  assert.ok(turnViolations({ answer, log: reads, evidence: projects({ statuses: ['done'] }) }, { layers: layers('projects') }).includes('kapsamın yönü okunmadı: team/unit/projects'));
  assert.deepEqual(turnViolations({ answer, log: reads, evidence: projects({ statuses: [] }) }, { layers: layers('projects') }), []);
});

test('nitelendirme denetleyicisi: adlı iki projenin kıyasında her yön her projenin kendi kanıtıyla karşılanır', () => {
  const g20 = executiveExpectation(fixture.scenarios.find((item) => item.id === 'g20'));
  assert.deepEqual(g20.scopeFocus, ['overview', 'milestones', 'overdue'], 'iki projeli kıyasın yönleri beklentide taşınmalı');
  const [first, second] = g20.projectIds;
  const answer = { content: 'Yanıt 【R1】', finishReason: 'stop' };
  const log = [first, second].map((projectId) => ({ query: 'task-facts', params: { projectId }, ok: true }));
  const totals = (projectId) => ({ evidenceId: 'R1', tool: 'rota_task_analytics', data: { totals: { open: 4, overdue: 1, dueNext7Days: 1 }, filters: { projectId } } });
  const milestones = (projectId) => ({ evidenceId: 'R2', tool: 'rota_task_search', data: { filters: { projectId, milestone: true, statuses: ['todo', 'in_progress'] } } });
  const turn = (evidence) => turnViolations({ answer, log, evidence, analysisContext: { scope: 'project' } }, { scope: 'project', projectIds: g20.projectIds, scopeFocus: g20.scopeFocus });
  assert.ok(turn([totals(first), totals(second), milestones(first)]).includes('yön kanıtı yok: milestones'), 'tek projenin kilometre taşı okuması iki projeyi karşılamamalı');
  assert.ok(turn([totals(first), milestones(first), milestones(second)]).includes('yön kanıtı yok: overdue'), 'bir projenin gecikme değeri eksikse yakalanmalı');
  assert.deepEqual(turn([totals(first), totals(second), milestones(first), milestones(second)]), []);
});

test('nitelendirme denetleyicisi: gecikmiş kovası yaklaşan termini, tamamlanmış ya da kritik daraltılmış dağılım iş yükü ve örgüt yönünü karşılamaz', () => {
  const answer = { content: 'Yanıt 【R1】', finishReason: 'stop' };
  const open = ['todo', 'in_progress'];
  const read = (level) => [{ query: 'task-facts', params: { assigneeMode: 'team', teamLevel: level.toUpperCase() }, ok: true }];
  const evidence = (level, data, tool) => [{ evidenceId: 'R1', tool, data: { ...data, filters: { assignee: 'team', teamLevel: level, ...data.filters } } }];
  const missing = (level, focus, data, tool) => turnViolations({ answer, log: read(level), evidence: evidence(level, data, tool) }, { layers: [{ scope: 'team', level, focus: [focus] }] })
    .includes(`kapsamın yönü okunmadı: team/${level}/${focus}`);
  // g15: doğru gelecek dönemli ama gecikmiş kovalı okuma yaklaşan teslimleri karşılamaz; kovasız dönem ve yaklaşan kova karşılar.
  const ahead = { statuses: open, dateFrom: shift(0), dateTo: shift(13) };
  assert.ok(missing('unit', 'upcoming', { filters: { ...ahead, deadline: 'overdue' } }, 'rota_task_search'), 'gecikmiş kovası yaklaşan yön sayılmamalı');
  assert.equal(missing('unit', 'upcoming', { filters: ahead }, 'rota_task_search'), false);
  assert.equal(missing('unit', 'upcoming', { filters: { statuses: open, deadline: 'due_next_7_days' } }, 'rota_task_search'), false);
  // g48: yalnızca tamamlananların kişi dağılımı açık iş yükü değildir; durumsuz ya da açık dağılım iş yüküdür.
  assert.ok(missing('unit', 'workload', { groupBy: 'assignee', filters: { statuses: ['done'] } }, 'rota_task_analytics'), 'tamamlananlar iş yükü sayılmamalı');
  assert.equal(missing('unit', 'workload', { groupBy: 'assignee', filters: { statuses: open } }, 'rota_task_analytics'), false);
  assert.equal(missing('unit', 'workload', { filters: {} }, 'rota_workload_summary'), false);
  // g43: yalnızca kritik işlerle daraltılmış birim kırılımı örgütsel nüfusu karşılamaz.
  assert.ok(missing('department', 'org', { groupBy: 'unit', filters: { priorities: ['critical'] } }, 'rota_task_analytics'), 'kritik daraltılmış kırılım örgüt yönü sayılmamalı');
  assert.equal(missing('department', 'org', { groupBy: 'unit', filters: {} }, 'rota_task_analytics'), false);
});

test('nitelendirme denetleyicisi: atlanan yön notu yalnızca adını verdiği kapsamın yönünü mazur gösterir', () => {
  const log = [{ query: 'task-facts', params: { assigneeMode: 'team', teamLevel: 'UNIT' }, ok: true }, { query: 'task-facts', params: { assigneeMode: 'team', teamLevel: 'DEPARTMENT' }, ok: true }];
  const layers = [{ scope: 'team', level: 'unit', focus: ['projects'] }, { scope: 'team', level: 'department', focus: ['milestones'] }];
  const note = renderLayerOmissions({ omitted: [{ layer: 1, focus: 'milestones' }], layers: [{ scope: 'team', level: 'unit', focus: ['projects'] }, { scope: 'team', level: 'department', focus: ['milestones'] }] });
  const answer = { content: `Yanıt 【R1】\n\n${note}`, finishReason: 'stop' };
  // Bölümün kilometre taşı notu birimin eksik proje kırılımını örtmez.
  const problems = turnViolations({ answer, log, evidence: [] }, { layers });
  assert.ok(problems.includes('kapsamın yönü okunmadı: team/unit/projects'), problems.join('; '));
  assert.equal(problems.includes('kapsamın yönü okunmadı: team/department/milestones'), false, 'adı verilen atlanan yön mazurdur');
  // İki kapsamın yönleri birlikte not edildiyse ikisi de mazurdur.
  const both = renderLayerOmissions({ omitted: [{ layer: 0, focus: 'projects' }, { layer: 1, focus: 'milestones' }], layers: [{ scope: 'team', level: 'unit', focus: ['projects'] }, { scope: 'team', level: 'department', focus: ['milestones'] }] });
  assert.deepEqual(turnViolations({ answer: { content: `Yanıt 【R1】\n\n${both}`, finishReason: 'stop' }, log, evidence: [] }, { layers }), []);
});

test('nitelendirme denetleyicisi: açık liste ek daraltmasız, istenen sırayla ve satırlarıyla teslim edilmelidir', () => {
  const log = [{ query: 'task-facts', params: { assigneeMode: 'team', teamLevel: 'UNIT' }, ok: true }];
  const wanted = [{ tool: 'rota_task_search', filters: { assignee: 'team', teamLevel: 'unit', priority: ['critical'] } }];
  const row = (filters, tasks = [{ title: 'Kritik iş' }], sort = 'target_finish_asc') => ({ evidenceId: 'R2', tool: 'rota_task_search', data: { sort, tasks, filters: { assignee: 'team', teamLevel: 'unit', priorities: ['critical'], ...filters } } });
  const content = 'Liste 【R2】\n\n- **Kritik iş** 【R2】';
  assert.deepEqual(turnViolations({ answer: { content, finishReason: 'stop' }, log, evidence: [row({})] }, { explicitRequests: wanted }), []);
  // g52: tek projeyle daraltılmış liste tam birim listesi değildir.
  assert.ok(turnViolations({ answer: { content, finishReason: 'stop' }, log, evidence: [row({ projectId: 'p1' })] }, { explicitRequests: wanted }).some((problem) => problem.startsWith('açık istek teslim edilmedi')));
  // Atıf tek başına teslim değildir: satır yanıtta görünmelidir.
  assert.ok(turnViolations({ answer: { content: 'Sayım 【R2】', finishReason: 'stop' }, log, evidence: [row({})] }, { explicitRequests: wanted }).some((problem) => problem.startsWith('açık istek teslim edilmedi')));
  // g51: en yakın teslimatlar beklenirken en uzak teslimatlar ya da fazla satır geçmez.
  const ranked = [{ ...wanted[0], rank: { metric: 'task.targetFinish', order: 'asc', limit: 1 } }];
  assert.deepEqual(turnViolations({ answer: { content, finishReason: 'stop' }, log, evidence: [row({})] }, { explicitRequests: ranked }), []);
  assert.ok(turnViolations({ answer: { content, finishReason: 'stop' }, log, evidence: [row({}, undefined, 'target_finish_desc')] }, { explicitRequests: ranked }).some((problem) => problem.startsWith('açık istek teslim edilmedi')));
  assert.ok(turnViolations({ answer: { content: `${content}\n- **İkinci** 【R2】`, finishReason: 'stop' }, log, evidence: [row({}, [{ title: 'Kritik iş' }, { title: 'İkinci' }])] }, { explicitRequests: ranked })
    .some((problem) => problem.startsWith('açık istek teslim edilmedi')));
});

test('nitelendirme denetleyicisi: eksik kadro çekincesi yalnızca iş yükü kanıtına bağlıysa ihlaldir', () => {
  const log = [{ query: 'task-facts', params: { assigneeMode: 'team', teamLevel: 'UNIT' }, ok: true }];
  const capacity = 'Bu sayılar görev adedidir; işin büyüklüğünü, harcanan emeği ya da boş kapasiteyi göstermez (Rota kapasite tutmaz). 【R1】';
  const evidence = [{ evidenceId: 'R1', tool: 'rota_workload_summary', data: { filters: { assignee: 'team' } } }, { evidenceId: 'R2', tool: 'rota_task_analytics', data: { groupBy: 'assignee', filters: { assignee: 'team' } } }];
  const breakdown = `${capacity}\n\nKişilere göre dağılımın tamlığı kesin olarak söylenemez. 【R2】`;
  assert.deepEqual(turnViolations({ answer: { content: breakdown, finishReason: 'stop' }, log, evidence }, { capacityCaveat: true }), []);
  const staffing = `${capacity}\n\nEkip dengesi kesin olarak söylenemez. 【R1】`;
  assert.ok(turnViolations({ answer: { content: staffing, finishReason: 'stop' }, log, evidence }, { capacityCaveat: true }).includes('tam kadroda eksik kadro çekincesi'));
});

test('nitelendirme beklentisi: dönem, tek kapsamlı yönler, adlı birincilin katmanı ve sıralamalı açık istek beklentiye girer', () => {
  // g27: gelecek takvim haftası beklenir; varsayılan yedi günlük okuma pencereyi karşılamaz.
  const g27 = executiveExpectation(fixture.scenarios.find((item) => item.id === 'g27'));
  assert.deepEqual(g27.window, [shift(5), shift(11)]);
  const answer = { content: 'Yanıt 【R1】', finishReason: 'stop' };
  const seven = [{ query: 'task-facts', params: { assigneeMode: 'me', dateFrom: shift(0), dateTo: shift(6) }, ok: true }, { query: 'task-facts', params: { assigneeMode: 'me', deadline: 'overdue' }, ok: true }];
  assert.ok(turnViolations({ answer, log: seven, evidence: [], analysisContext: { scope: 'self', focus: ['upcoming', 'overdue'] } }, { window: g27.window }).some((problem) => problem.startsWith('ufuk')));
  // g49 ilk tur: birim iş yükü yerine birim genel görünümü geçmez.
  const first = executiveTurnExpectation(fixture.scenarios.find((item) => item.id === 'g49'), 0);
  assert.deepEqual(first.scopeFocus, ['workload']);
  const unit = [{ query: 'task-facts', params: { assigneeMode: 'team', teamLevel: 'UNIT' }, ok: true }];
  const overview = [{ evidenceId: 'R1', tool: 'rota_task_analytics', data: { filters: { assignee: 'team', teamLevel: 'unit' } } }];
  assert.ok(turnViolations({ answer, log: unit, evidence: overview, analysisContext: { scope: 'team', level: 'unit', focus: ['workload'] } }, first).includes('yön kanıtı yok: workload'));
  // Adlı proje birincil + ekip katmanı: proje kimliği her okumaya uygulanmaz (katman denetimi uygulanır).
  const mixed = executiveExpectation({ id: 'q', profile: 'B', handling: 'full', text: 'x', expect: {},
    plan: { intent: 'rota', language: 'tr', analysis: { scope: 'project', names: ['KAP TOOL'], focus: ['overview'], also: [{ scope: 'team', level: 'unit' }] } } });
  assert.equal(mixed.project, undefined);
  assert.equal(mixed.projectIds, undefined);
  assert.ok(mixed.layers.some((layer) => layer.scope === 'project' && layer.projectId === EXEC_PROJECTS.KAP));
});

test('planlayıcı puanı: beklenen kapsamlara eklenen kapsam, kadrosuz iş yükü ve kapsamı boş ret dışı plan geçmez', () => {
  const planned = (analysis, requests) => ({ outcome: 'planned', decisions: [{ intent: 'rota' }], plan: { analysis, requests } });
  const read = (filters, tool = 'rota_task_analytics') => ({ operation: 'value', metrics: ['tasks.total'], population: { tool }, entities: [], filters });
  // x09: kendi + birim beklenir; bölüm kapsamının eklenmesi başarısızdır.
  const x09 = fixture.holdout.find((item) => item.id === 'x09').expect;
  const exact = planned({ scope: 'self', focus: ['overview'], layers: [{ scope: 'self' }, { scope: 'team', level: 'unit' }] }, [read({ assignee: 'me' }), read({ assignee: 'team', teamLevel: 'unit' })]);
  assert.deepEqual(plannerScore(exact, x09), []);
  const extra = planned({ scope: 'self', focus: ['overview'], layers: [{ scope: 'self' }, { scope: 'team', level: 'unit' }, { scope: 'team', level: 'department' }] },
    [read({ assignee: 'me' }), read({ assignee: 'team', teamLevel: 'unit' }), read({ assignee: 'team', teamLevel: 'department' })]);
  assert.ok(plannerScore(extra, x09).some((failure) => /beklenmeyen kapsam/.test(failure)));
  // x04: görevi olmayan üyeleri soran soru kadroyla okunan iş yükü ister; kişilere göre görev kırılımı yetmez.
  const x04 = fixture.holdout.find((item) => item.id === 'x04').expect;
  const breakdown = { operation: 'list', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy: 'assignee' }, entities: [], filters: { assignee: 'team', teamLevel: 'unit' } };
  assert.ok(plannerScore(planned(null, [breakdown]), x04).includes('kadroyla okunan iş yükü yok'));
  const roster = { operation: 'list', metrics: ['person.name', 'tasks.open'], population: { tool: 'rota_workload_summary', collection: 'people' }, entities: [], filters: { assignee: 'team', teamLevel: 'unit' } };
  assert.equal(plannerScore(planned({ scope: 'team', level: 'unit', focus: ['workload'] }, [roster]), x04).includes('kadroyla okunan iş yükü yok'), false);
  // x20: planlanan yanıt birimin nüfusunu okumalıdır; kendi işleri geçmez (ret serbesttir).
  const x20 = fixture.holdout.find((item) => item.id === 'x20').expect;
  assert.ok(plannerScore(planned({ scope: 'self', focus: ['overview'] }, [read({ assignee: 'me' })]), x20).length > 0);
  assert.deepEqual(plannerScore({ outcome: 'abstained', decisions: [{ intent: 'abstain' }], plan: null }, x20), []);
});

test('örtüşen seri notu: yalnızca iş yükü tablosundan çizilen grafik yerine geçen grafik olarak adlandırılır', async () => {
  const { chartTypeNote } = await import('../src/server/ai/assistant/groundedAnswer.js');
  const table = (tool) => ({ group: { tool, collections: new Map() }, collection: null });
  const composition = { render: { chartType: 'stacked', chartTypes: null, visual: true, tables: new Map([['T1', table('rota_workload_summary')], ['T2', table('rota_portfolio_summary')]]) } };
  const note = (chartTables) => chartTypeNote({ trace: {}, locale: 'tr' }, composition, { chartTypes: ['bar'], chart: 'bar', chartTables }).join('\n');
  // Başka kapsamın çubuk grafiği iş yükü sayılarını göstermez: sayılar tabloda kalır.
  assert.match(note(['T2']), /sayılar tabloda gösterildi/);
  assert.doesNotMatch(note(['T2']), /olarak gösterildi/);
  // İş yükü tablosundan çizilen grafik yerine geçen grafiktir.
  assert.doesNotMatch(note(['T1']), /sayılar tabloda gösterildi/);
  assert.match(note(['T1']), /sayılar .+ olarak gösterildi/);
});

test('planlayıcı yönergesi: sayı verilen sıralama sınırını taşır; adlı projelerin karşılaştırması projeler yönüne yönlendirilmez', async () => {
  const { groundedSystemPrompt } = await import('../src/server/ai/assistant/groundedPrompt.js');
  const prompt = groundedSystemPrompt(new Date(NOW));
  assert.match(prompt, /en çok geciken 3 görevim": request operation rank ve rank\.limit 3/);
  assert.match(prompt, /Adı verilen projelerin karşılaştırmasında \(scope project, names\) projects yazma/);
  // Yönergenin önerdiği yazım sunucuda kabul edilir; projeler yönü adlı proje karşılaştırmasında desteklenmez.
  assert.equal(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'project', names: ['KAP TOOL', 'BGS Şube Çalışmaları'], focus: ['overview', 'status'] } }), null);
  assert.ok(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'project', names: ['KAP TOOL', 'BGS Şube Çalışmaları'], focus: ['projects'] } }));
});

test('kapsam kıyası bağımsız iki projenin kritik iş kıyasını bastırmaz', () => {
  const totals = (id, filters, values) => Object.entries(values).map(([key, value]) => fact(id, `data.totals.${key}`, value, { tool: 'rota_task_analytics', filters }));
  const findings = analyticalFindings([
    part(0, totals('R1', { assignee: 'me' }, { open: 5, overdue: 1 })),
    part(1, totals('R2', { assignee: 'team', teamLevel: 'unit' }, { open: 20, overdue: 8 })),
    part(2, totals('R3', { projectId: 'a', project: 'Alfa', statuses: ['todo', 'in_progress'], priorities: ['critical', 'high'] }, { total: 3 })),
    part(3, totals('R4', { projectId: 'b', project: 'Beta', statuses: ['todo', 'in_progress'], priorities: ['critical', 'high'] }, { total: 7 }))
  ]);
  assert.ok(findings.some((item) => item.kind === 'levelComparison'));
  assert.deepEqual(findings.find((item) => item.kind === 'subjectComparison')?.metrics.critical, [3, 7]);
});

test('kapsam kıyası dönemle süzülmüş ayrı kişi kıyasını bastırmaz; aynı kanıtın yinelemesini bastırır', () => {
  const totals = (id, filters, values) => Object.entries(values).map(([key, value]) => fact(id, `data.totals.${key}`, value, { tool: 'rota_task_analytics', filters }));
  const person = { assignee: 'person', personSicil: 9, person: 'Elif Arslan' };
  const windowed = { dateFrom: shift(1), dateTo: shift(30), dateField: 'targetFinish', statuses: ['todo', 'in_progress'] };
  const unfiltered = [part(0, totals('R1', { assignee: 'me' }, { open: 5, overdue: 1 })), part(1, totals('R2', person, { open: 8, overdue: 4 })),
    part(2, totals('R3', {}, { open: 40, overdue: 9 }))];
  const findings = analyticalFindings([...unfiltered, part(3, totals('R4', { assignee: 'me', ...windowed }, { total: 2 })),
    part(4, totals('R5', { ...person, ...windowed }, { total: 6 }))]);
  assert.ok(findings.some((item) => item.kind === 'levelComparison'), 'süzülmemiş kapsam kıyası kurulmalı');
  assert.deepEqual(findings.find((item) => item.kind === 'subjectComparison')?.metrics.total, [2, 6], 'dönem kıyası bağımsız bulgu olarak kalmalı');
  // Aynı süzülmemiş kanıttan doğan kişi kıyası kapsam kıyasının yinelemesidir.
  assert.equal(analyticalFindings(unfiltered).some((item) => item.kind === 'subjectComparison'), false, 'aynı kanıtın kıyası yinelenmemeli');
});

test('farklı kapsamlardaki dikkat ve eşzamanlı baskı bulguları girişte ayrı ayrı teslim edilir', () => {
  const unit = people([['Birim lideri', 10, 5, 4], ['Birim üyesi', 3, 1, 1]], { team: 'unit' });
  const department = people([['Bölüm lideri', 14, 8, 6], ['Bölüm üyesi', 4, 2, 2]], { team: 'department' }).map((item) => ({ ...item, evidenceId: 'R2' }));
  const findings = analyticalFindings([part(0, unit), part(1, department)]);
  assert.equal(findings.filter((item) => item.kind === 'attentionLeader').length, 2);
  assert.equal(findings.filter((item) => item.kind === 'simultaneousPressure').length, 2);
  const intro = synthesisNarrative(findings).intro;
  const text = [intro.plain, intro.insights?.plain].join(' ');
  assert.match(text, /Birim lideri/); assert.match(text, /Bölüm lideri/);
  const conclusion = synthesisNarrative(findings).conclusion.plain;
  assert.match(conclusion, /Birim lideri/); assert.match(conclusion, /Bölüm lideri/);
});

test('kilometre taşlarında en uzun gecikme ve en yakın termin eşitliği iki dilde saklanır', () => {
  for (const rows of [[['A', shift(-10), 10], ['B', shift(-10), 10], ['C', shift(2), null], ['D', shift(2), null]],
    [['A', shift(2), null], ['B', shift(2), null]]]) {
    const findings = analyticalFindings([part(0, milestones(rows), { metric: 'task.targetFinish', order: 'asc' })]);
    for (const locale of ['tr', 'en']) {
      const intro = synthesisNarrative(findings, { locale }).intro;
      const text = [intro.plain, intro.insights?.plain].join(' ');
      assert.match(text, locale === 'tr' ? /aynı en yakın termindeki/i : /one of the next milestones/);
      if (rows.length === 4) assert.match(text, locale === 'tr' ? /gecikenlerden biri/ : /one of the longest-overdue/);
    }
  }
});

test('doğrulanmış sıralamanın kaynak dizinleri önek olmasa da kilometre taşı bulgusu korunur', () => {
  const facts = milestones([['Geç', shift(10), null], ['Yakın', shift(2), null], ['En yakın', shift(1), null]], { total: 3, complete: false });
  const selected = facts.filter((item) => !item.fact.field.startsWith('data.tasks.0.'));
  const findings = analyticalFindings([part(0, selected, { metric: 'task.targetFinish', order: 'asc', limit: 2, indexes: [2, 1] })]);
  assert.equal(findings.find((item) => item.kind === 'milestoneStatus')?.metrics.next.title, 'En yakın');
});

test('farklı katmanların ters yönlü varlık değerleri aynı bulgu diye silinmez', () => {
  const a = portfolio([['A', 10, 1, 1], ['B', 5, 3, 1], ['C', 4, 0, 0]]);
  const b = portfolio([['B', 10, 1, 1], ['A', 5, 3, 1], ['C', 4, 0, 0]]).map((item) => {
    const name = /data.projects.(\d+)./.exec(item.fact.field)?.[1];
    const old = item.fact.semantic.row.identity;
    return { ...item, evidenceId: 'R2', fact: { ...item.fact, semantic: { ...item.fact.semantic, row: { ...item.fact.semantic.row,
      identity: name === '0' ? 'p2' : name === '1' ? 'p1' : old } } } };
  });
  const findings = analyticalFindings([part(0, a), part(1, b)]);
  assert.equal(findings.filter((item) => item.kind === 'volumeVsDelay').length, 2);
});

test('örgütsel üyelik değişimi tam grup kanıtı olarak sunulmaz', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const stack = createAiStack(t, { sicil: P.B, seed: executiveBenchmarkSeed(), env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  stack.db.rosterMembershipChanged = true;
  const { result } = await callRotaTool(stack, P.B, 'rota_task_analytics', { assignee: 'team', teamLevel: 'department', groupBy: 'unit', limit: 25 });
  assert.equal(result.complete, false); assert.equal(result.truncated, true);
});

test('açıklama seçiminden sonra açık kritik iş isteği özetle birlikte yeniden doğrulanır', async (t) => {
  const { ask } = conversation(t, 'B');
  const first = await ask({ text: 'Ortak Platform projesini özetle ve ayrıca kendi kritik açık görevlerimin sayısını ver.', plan: {
    intent: 'rota', language: 'tr', analysis: { scope: 'project', names: ['Ortak Platform'], focus: ['overview'] },
    request: { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' }, filters: { assignee: 'me', status: ['todo', 'in_progress'], priority: ['critical'] } }
  } });
  assert.equal(first.answer.finishReason, 'clarification', first.answer.content);
  const next = await ask({ text: '1' });
  assert.equal(next.answer.finishReason, 'stop', next.answer.content);
  assert.ok(populationReads(next.log).some((row) => row.ok === true && row.params.assigneeMode === 'me' && row.params.priorityCsv === 'critical'), JSON.stringify(next.log));
  assert.ok(next.evidence.some((row) => row.tool === 'rota_task_analytics' && row.data.filters.assignee === 'me'));
});

test('erken dizi reddinden sonra onarım geçerli ekip katmanını düşüremez', async (t) => {
  const analysis = [{ scope: 'self', focus: ['overview'] }, { scope: 'team', level: 'unit', focus: ['overview'], withSelf: true }];
  const fixed = { scope: 'self', focus: ['overview'], also: [{ scope: 'team', level: 'unit', focus: ['overview'] }] };
  const plans = [{ intent: 'rota', language: 'tr', analysis }, { intent: 'rota', language: 'tr', analysis: fixed }];
  const { ask } = conversation(t, 'B', { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plans.shift() }] }) });
  const result = await ask({ text: 'Kendi durumumu birimimin durumuyla karşılaştır.' });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.ok(populationReads(result.log).some((row) => row.params.assigneeMode === 'team' && row.ok === true));
});

test('ek katmanın güvenilmeyen adı kendi yolundan onarılır', async (t) => {
  const analysis = (name) => ({ scope: 'self', focus: ['overview'], also: [{ scope: 'project', names: [name], focus: ['overview'] }] });
  const plans = ['Müşteri Portalı', 'KAP TOOL'].map((name) => ({ intent: 'rota', language: 'tr', analysis: analysis(name) }));
  const { ask } = conversation(t, 'B', { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plans.shift() }] }) });
  const result = await ask({ text: 'Kendi işlerimle KAP TOOL projesinin durumunu karşılaştır.' });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.ok(result.inputs.some((input) => JSON.stringify(input).includes('$.analysis.also[0].names:untrusted')));
});

test('yalnızca çağrı reddedildiğinde açık kritik iş sayımı onarımda düşürülemez', async (t) => {
  const analysis = { scope: 'self', focus: ['overview'] };
  const request = { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' }, filters: { assignee: 'me', priority: ['critical'] } };
  const plans = [
    { intent: 'rota', language: 'tr', analysis, request, calls: [{ name: 'rota_task_search', arguments: { assignee: 'me', deadline: 'overdue' } }] },
    { intent: 'rota', language: 'tr', analysis },
    { intent: 'rota', language: 'tr', analysis, request }
  ];
  const { ask } = conversation(t, 'B', { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plans.shift() }] }) });
  const result = await ask({ text: 'Durumumu özetle ve kritik işlerimin sayısını ver.' });
  assert.equal(plans.length, 0, 'açık isteği düşüren onarımın ardından doğru plan yeniden istenir');
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.ok(populationReads(result.log).some((row) => row.params.priorityCsv === 'critical' && row.ok === true));
});

test('açık istek onarımında ölçü kümesinin sırası değişebilir, yinelenen ölçü başka ölçüye dönüşemez', async (t) => {
  const request = { operation: 'value', metrics: ['tasks.open', 'tasks.overdue'], population: { tool: 'rota_task_analytics' }, filters: { assignee: 'me' } };
  const plans = [
    { intent: 'rota', language: 'tr', analysis: { scope: 'self', level: 'unit', focus: ['overview'] }, request },
    { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'] }, request: { ...request, metrics: [...request.metrics].reverse() } }
  ];
  const { ask } = conversation(t, 'B', { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plans.shift() }] }) });
  const result = await ask({ text: 'Kendi işlerimi özetle; açık ve gecikmiş sayısını da göster.' });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.equal(result.inputs.some((input) => JSON.stringify(input).includes('repairScope')), false);
});
