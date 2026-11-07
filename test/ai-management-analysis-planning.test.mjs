/**
 * Aşama F — planlama sözleşmesinin kök neden düzeltmeleri (belirlenimci, model çağrısı yok).
 *
 *   - Gecikme bugüne göre ölçülür: tamamen gelecekteki dönem gecikmiş iş okumasını boşaltmaz (VM soru 3 ve 16 sınıfı).
 *   - Fiziksel okuma sınırına (4) sığan dört yön düzeltme turu açmadan kabul edilir; model görünür şema 1-3 yön önerir.
 *   - Tek özneli planın bütçe aşımı daraltılabilir (`narrowable`); karşılaştırmanınki daraltılamaz.
 *   - İki grafik türü (dizi) kabul edilir ve her türün okuması bütçeye sığdığı ölçüde eklenir; geçersiz dizi reddedilir.
 *   - Boş tamamlamanın günlük satırı sağlayıcının bildirdiği çıktı belirteci sayısını taşır (içeriksiz tanı).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();
const { expandAnalysis, parseAnalysis, analysisHints, analysisSchema, ANALYSIS_LIMITS, futureWindow } = await import('../src/server/ai/tools/analysisPlan.js');
const { unpackTypedPlan } = await import('../src/server/ai/tools/executionSet.js');
const { recordEmptyCompletion } = await import('../src/server/ai/aiTelemetry.js');
const { captureConsole } = await import('./helpers/aiStack.mjs');

const TODAY = '2026-09-30';
const expand = (raw, options = {}) => expandAnalysis(parseAnalysis(raw), { today: TODAY, ...options });
const reject = (raw, options = {}) => { try { expand(raw, options); return null; } catch (error) { return error.details; } };
const unpack = (plan) => unpackTypedPlan({ toolCalls: [{ name: 'rota_plan', arguments: JSON.stringify(plan) }] }, { today: TODAY });

test('gelecekteki dönem gecikmiş iş okumasını daraltmaz; geçmişi kapsayan dönem daraltmayı korur', () => {
  const ahead = expand({ scope: 'all', focus: ['projects', 'overdue', 'upcoming'], dateFrom: '2026-09-30', dateTo: '2026-10-13' });
  const overdue = ahead.find((part) => part.filters.deadline === 'overdue');
  assert.equal(overdue.filters.dateFrom, undefined, 'gecikme bugüne göre: dönem uygulanmaz');
  assert.equal(overdue.filters.dateTo, undefined);
  for (const part of ahead.filter((item) => item !== overdue)) assert.deepEqual([part.filters.dateFrom, part.filters.dateTo], ['2026-09-30', '2026-10-13'], 'diğer yönler dönemi korur');
  // Bugün göreli penceresi de tamamen gelecektir: "bugün öncelik" sorusunda gecikmiş işler okunur.
  const todayWindow = expand({ scope: 'self', focus: ['overdue', 'upcoming'], relativeWindow: 'today' });
  assert.equal(todayWindow.find((part) => part.filters.deadline === 'overdue').filters.dateFrom, undefined);
  // Geçmişi kapsayan dönemde (bu hafta) dönem içinde gecikmiş iş anlamlıdır ve korunur.
  const week = expand({ scope: 'self', focus: ['overdue'], dateFrom: '2026-09-28', dateTo: '2026-10-04' });
  assert.deepEqual([week[0].filters.dateFrom, week[0].filters.dateTo], ['2026-09-28', '2026-10-04']);
  // Karşılaştırmanın gecikme değeri de bugüne göredir; kişi kapsamı korunur.
  const people = expand({ scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'], focus: ['overdue'], dateFrom: '2026-10-01', dateTo: '2026-10-31' });
  assert.equal(people[0].filters?.dateFrom, undefined);
  assert.equal(people[0].entities.length, 2);
  assert.equal(futureWindow({ dateFrom: '2026-09-29' }, TODAY), false);
  assert.equal(futureWindow({ dateFrom: '2026-09-30' }, null), false, 'bugün bilinmiyorsa kural uygulanmaz');
});

test('dört yön fiziksel sınıra sığarsa doğrudan kabul edilir; model görünür şema değişmez', () => {
  assert.equal(analysisSchema().properties.focus.maxItems, 3);
  const parts = expand({ scope: 'all', focus: ['status', 'overdue', 'workload', 'upcoming'] });
  assert.equal(parts.length, ANALYSIS_LIMITS.maxParts);
  assert.deepEqual(parts.map((item) => [item.population.tool, item.population.groupBy || item.filters?.deadline]),
    [['rota_task_analytics', 'status'], ['rota_task_search', 'overdue'], ['rota_workload_summary', undefined], ['rota_task_search', 'due_next_7_days']]);
  // Portföy kapsamı zorunlu proje okumasını ekler: dört yön + zorunlu okuma sınırı aşar, daraltma onarımı önerilir.
  assert.deepEqual(reject({ scope: 'projects', focus: ['status', 'overdue', 'workload', 'upcoming'] }), ['$.analysis.focus:requestBudget']);
  assert.ok(analysisHints(['$.analysis.focus:requestBudget']).some((hint) => hint.includes('açıklamasını iste')));
  // Karşılaştırmada da yön daraltılır (özne değil); tek yönlü sığmayan plan kullanıcıya sorulur.
  assert.deepEqual(reject({ scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'], focus: ['priority', 'deadlines', 'critical'] }), ['$.analysis.focus:requestBudget']);
  assert.ok(analysisHints(['$.analysis.focus:requestBudget']).some((hint) => hint.includes('açıklamasını iste')));
  // İki kişinin proje dağılımı, gecikmesi ve yaklaşanı (4 okuma) bütünüyle okunur.
  const comparison = expand({ scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'], focus: ['projects', 'overdue', 'upcoming'] });
  assert.deepEqual(comparison.filter((item) => item.population.groupBy === 'project').map((item) => item.entities[0].text), ['Ayşe Yılmaz', 'Zeynep Kaya']);
  const values = comparison.find((item) => item.operation === 'value');
  assert.deepEqual(values.metrics, ['tasks.overdue', 'tasks.dueNext7Days']);
  assert.deepEqual(values.entities.map((item) => item.text), ['Ayşe Yılmaz', 'Zeynep Kaya']);
});

test('iki grafik türü dizisi kabul edilir ve her türün okuması eklenir; geçersiz dizi reddedilir', () => {
  const { plan } = unpack({ intent: 'rota', language: 'tr', chart: ['donut', 'stacked'], analysis: { scope: 'self', focus: ['status'] } });
  assert.equal(plan.chart, 'donut');
  assert.deepEqual(plan.charts, ['donut', 'stacked']);
  assert.equal(plan.visual, true);
  const reads = [plan.request, ...(plan.additionalRequests || [])];
  assert.ok(reads.some((part) => part.population.groupBy === 'status'), 'halka için durum dağılımı');
  assert.ok(reads.some((part) => part.population.groupBy === 'project' && part.metrics.includes('tasks.done')), 'yığılmış için proje başına açık/tamamlanan');
  for (const chart of [['donut', 'donut'], ['donut', 'pie'], ['bar', 'donut', 'line'], []]) {
    assert.throws(() => unpack({ intent: 'rota', language: 'tr', chart, analysis: { scope: 'self', focus: ['status'] } }), (error) => error.details.includes('$.chart:enum'), JSON.stringify(chart));
  }
  // Zayıf modelin JSON metni olarak yazdığı dizi (canlı Haiku gözlemi) aynı kurallarla çözülür; geçersiz metin reddedilir.
  assert.deepEqual(unpack({ intent: 'rota', language: 'tr', chart: '["donut", "stacked"]', analysis: { scope: 'self', focus: ['status'] } }).plan.charts, ['donut', 'stacked']);
  for (const chart of ['["donut", "pie"]', '[donut, stacked]', '{"type":"donut"}']) {
    assert.throws(() => unpack({ intent: 'rota', language: 'tr', chart, analysis: { scope: 'self', focus: ['status'] } }), (error) => error.details.includes('$.chart:enum'), chart);
  }
  // Tek öğeli dizi tek türdür; açık görselleştirme reddi grafik türünden önce gelir.
  assert.equal(unpack({ intent: 'rota', language: 'tr', chart: ['bar'], analysis: { scope: 'self', focus: ['status'] } }).plan.charts, undefined);
  const declined = unpack({ intent: 'rota', language: 'tr', visual: false, chart: ['donut', 'stacked'], analysis: { scope: 'self', focus: ['status'] } }).plan;
  assert.equal(declined.chart, undefined);
  assert.equal(declined.charts, undefined);
});

test('boş tamamlama satırı çıktı belirteci sayısını içeriksiz olarak yazar (VM tanısı)', (t) => {
  // İnsan okunur satır (VM konsolu) metin biçimindedir.
  const format = process.env.MERGEN_ROTA_LOG_FORMAT;
  process.env.MERGEN_ROTA_LOG_FORMAT = 'both';
  t.after(() => { if (format == null) delete process.env.MERGEN_ROTA_LOG_FORMAT; else process.env.MERGEN_ROTA_LOG_FORMAT = format; });
  const logs = captureConsole(t);
  recordEmptyCompletion({ profile: 'chat.tools', model: 'Qwen3-Next-80B-A3B-Instruct', diagnostics: { finishReason: 'stop', providerMs: 700, usage: { completion: 42 } } });
  recordEmptyCompletion({ profile: 'chat.tools', model: 'Qwen3-Next-80B-A3B-Instruct', diagnostics: { finishReason: 'stop', providerMs: 600, usage: {} } });
  const lines = logs.filter((line) => line.includes('AI WARN empty completion'));
  assert.match(lines[0], /finish stop \| out 42 tok \| 0\.7s/);
  assert.match(lines[1], /out \? tok/, 'bildirilmeyen sayı sıfır gibi yazılmaz');
});

test('özetin yanındaki yalnızca ad çözümü çağrıları yürütülmeden atılır; başka araç çağrısı reddedilir', () => {
  const brief = { scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'], focus: ['overview'] };
  const lookups = [{ name: 'rota_person_search', arguments: { text: 'Ayşe Yılmaz' } }, { name: 'rota_person_search', arguments: { text: 'Zeynep Kaya' } }];
  const accepted = unpack({ intent: 'rota', language: 'tr', analysis: brief, calls: lookups });
  assert.deepEqual(accepted.calls, [], 'çağrılar yürütülmez; adları sunucu özetten çözer');
  assert.equal(accepted.plan.analysis.scope, 'person');
  assert.throws(() => unpack({ intent: 'rota', language: 'tr', analysis: brief, calls: [...lookups, { name: 'rota_task_search', arguments: {} }] }),
    (error) => error.details.includes('$.analysis:request'));
  assert.throws(() => unpack({ intent: 'rota', language: 'tr', analysis: brief, request: { operation: 'value', metrics: ['tasks.total'] } }), (error) => error.details.includes('$.analysis:request'));
});

test('takip dışındaki özette "all_time" dönemsizliktir: alanın düşmesi onarımda kapsam değişikliği sayılmaz', () => {
  assert.equal(parseAnalysis({ scope: 'projects', focus: ['overview'], relativeWindow: 'all_time' }).relativeWindow, undefined);
  // Takipte devralınan dönemi kaldırma anlamı korunur.
  assert.equal(parseAnalysis({ scope: 'previous', relativeWindow: 'all_time' }).relativeWindow, 'all_time');
});

test('zayıf modelin geçerli onarımları kabul edilir: kendi yönlerini daraltma ve göreli pencere çakışmasını giderme', async (t) => {
  const { phase4eConversation } = await import('./helpers/phase4eScenario.mjs');
  const plan = (analysis) => ({ intent: 'rota', language: 'tr', analysis });
  for (const [name, queue] of [
    ['şema sınırını aşan model yönlerinin sıralı alt kümesi (all_time eşdeğer yazımı düşse de)',
      [plan({ scope: 'self', focus: ['overview', 'overdue', 'upcoming', 'workload', 'status'], relativeWindow: 'all_time' }), plan({ scope: 'self', focus: ['overview', 'overdue', 'upcoming'] })]],
    ['göreli pencere ile tarih çakışmasında birinin kaldırılması',
      [plan({ scope: 'self', focus: ['overview', 'upcoming'], relativeWindow: 'next_7_days', dateFrom: '2026-09-30', dateTo: '2026-10-29' }),
        plan({ scope: 'self', focus: ['overview', 'upcoming'], dateFrom: '2026-09-30', dateTo: '2026-10-29' })]]
  ]) {
    await t.test(name, async (t) => {
      const { ask } = phase4eConversation(t, { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: queue.shift() }] }) });
      const result = await ask({ text: 'projelerimi ve işlerimi değerlendir' });
      assert.equal(result.inputs.length, 2, 'tek düzeltme turu');
      assert.equal(result.answer.finishReason, 'stop', result.answer.content);
    });
  }
});

test('karşılaştırmanın eşdeğer skaler okumaları birleşir; istenen hiçbir yön ve özne düşmez', async (t) => {
  const { phase4eConversation, populationReads } = await import('./helpers/phase4eScenario.mjs');
  const analysis = { scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'], focus: ['workload', 'projects', 'overdue', 'upcoming'] };
  const { ask } = phase4eConversation(t);
  const result = await ask({ text: 'Ayşe Yılmaz ile Zeynep Kaya adlı kişileri iş yükü, projeler, gecikme ve yaklaşan işler açısından karşılaştır',
    plan: { intent: 'rota', language: 'tr', analysis } });
  assert.equal(result.inputs.length, 1, 'yön düşürmek için model turu açılmaz');
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.deepEqual(result.analysisContext.focus, analysis.focus);
  const { AYSE, ZEYNEP } = await import('./helpers/aiToolFixtures.mjs');
  assert.deepEqual([...new Set(populationReads(result.log).map((row) => row.params.personSicil))].sort(), [AYSE, ZEYNEP].sort());
  const parts = expand(analysis);
  for (const name of analysis.names) assert.ok(parts.some((item) => item.population.groupBy === 'project' && item.entities.some((entity) => entity.text === name)));
  assert.ok(parts.some((item) => ['tasks.open', 'tasks.overdue', 'tasks.dueNext7Days'].every((metric) => item.metrics.includes(metric))));
});

test('dört bölümlü iki proje karşılaştırması sunucu düzenine sığar; aynı kanıtın sayısı bölümlerde yinelenmez', async (t) => {
  const { phase4eConversation } = await import('./helpers/phase4eScenario.mjs');
  const { analysisBenchmarkSeed, BENCH_PROFILES } = await import('./helpers/analysisBenchmarkSeed.mjs');
  const { NOW } = await import('./helpers/aiToolFixtures.mjs');
  const analysis = { scope: 'projects', names: ['BGS Şube Çalışmaları', 'KAP TOOL'], focus: ['overview', 'status', 'overdue', 'upcoming'] };
  for (const detail of ['short', 'balanced', 'detailed']) {
    await t.test(detail, async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: NOW });
      const seed = analysisBenchmarkSeed();
      t.mock.timers.reset();
      const { ask } = phase4eConversation(t, { sicil: BENCH_PROFILES.B, seed });
      const result = await ask({ text: 'BGS Şube Çalışmaları ile KAP TOOL projelerini görev sayıları, gecikme, tamamlanma ve yaklaşan teslimatlar açısından karşılaştır.',
        plan: { intent: 'rota', language: 'tr', analysis } }, { detail });
      const content = String(result.answer.content);
      assert.equal(result.answer.finishReason, 'stop', content);
      // Sayfa sınırı dört bölüm × iki özneyi taşımazsa yanıt girişsiz, bölüm bölüm tekrarlanan anlatıma düşüyordu.
      assert.match(content, /^İki proje arasındaki en belirgin fark/, content);
      // KAP TOOL'un gecikmiş sayısı (3) genel görünümde söylendiyse gecikme bölümünde yeniden yazılmaz.
      assert.ok((content.match(/\*\*3\*\* gecikmiş/g) || []).length <= 1, content);
      assert.doesNotMatch(content, /projesinde \*\*\d+\*\* gecikmiş görev bulunuyor/, content);
    });
  }
});

test('yönetici özetinde "gecikmiş görevi olan proje" toplamı kapsama cümlesiyle aynı değerse bir kez söylenir', async (t) => {
  const { phase4eConversation } = await import('./helpers/phase4eScenario.mjs');
  const { analysisBenchmarkSeed, BENCH_PROFILES } = await import('./helpers/analysisBenchmarkSeed.mjs');
  const { NOW } = await import('./helpers/aiToolFixtures.mjs');
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = analysisBenchmarkSeed();
  t.mock.timers.reset();
  const { ask } = phase4eConversation(t, { sicil: BENCH_PROFILES.B, seed });
  const result = await ask({ text: 'Erişebildiğim projeleri gecikme, yaklaşan teslimat ve proje dağılımı açısından değerlendir.',
    plan: { intent: 'rota', language: 'tr', analysis: { scope: 'projects', focus: ['overview', 'overdue', 'upcoming', 'projects'] } } }, { detail: 'balanced' });
  const content = String(result.answer.content);
  assert.equal(result.answer.finishReason, 'stop', content);
  assert.match(content, /\*\*9\*\* projenin \*\*8\*\*'inde gecikmiş görev var/, content);
  assert.doesNotMatch(content, /Gecikmiş görevi olan proje sayısı/, content);
});

test('gelecekteki dönemde proje grupları yapısal olarak sıfır olan gecikmiş sütununu taşımaz', () => {
  const future = expand({ scope: 'projects', focus: ['projects'], dateFrom: TODAY, dateTo: '2026-10-13' });
  const grouped = future.find((part) => part.population.groupBy === 'project');
  assert.deepEqual(grouped.metrics, ['tasks.open', 'tasks.done']);
  const past = expand({ scope: 'projects', focus: ['projects'], dateFrom: '2026-09-01', dateTo: '2026-09-30' });
  assert.ok(past.find((part) => part.population.groupBy === 'project').metrics.includes('tasks.overdue'));
});

test('karşılaştırma paragrafı özneler arasında gidip gelmez; tek öznenin gösterge kartı sunulmaz', async (t) => {
  const { phase4eConversation } = await import('./helpers/phase4eScenario.mjs');
  const { composer } = await import('./helpers/compositionScenario.mjs');
  const { analysisBenchmarkSeed, BENCH_PROFILES } = await import('./helpers/analysisBenchmarkSeed.mjs');
  const { NOW } = await import('./helpers/aiToolFixtures.mjs');
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = analysisBenchmarkSeed();
  t.mock.timers.reset();
  let charts = null;
  // Model düzeni önermeleri iki öznenin kaynakları arasında dönüşümlü sıralar (canlı Haiku gözlemi).
  const interleaved = (view) => {
    charts = view.charts;
    const bySource = new Map();
    for (const item of view.propositions) bySource.set(item.evidenceId, [...(bySource.get(item.evidenceId) || []), item.id]);
    const [left = [], right = []] = [...bySource.values()];
    const items = left.flatMap((id, index) => [id, ...(right[index] ? [right[index]] : [])]).concat(right.slice(left.length)).slice(0, 4);
    return { blocks: [{ type: 'say', items }] };
  };
  const { ask } = phase4eConversation(t, { sicil: BENCH_PROFILES.B, seed, compose: () => composer(interleaved) });
  for (const name of ['BGS Şube Çalışmaları', 'KAP TOOL']) {
    const eligible = await ask({ text: `${name} projesinin açık, gecikmiş ve yedi gün içinde terminli iş sayılarını göster`, plan: {
      intent: 'rota', language: 'tr', chart: 'kpi', request: { operation: 'value', metrics: ['tasks.open', 'tasks.overdue', 'tasks.dueNext7Days'],
        population: { tool: 'rota_task_analytics' }, entities: [{ type: 'project', text: name }] }
    } });
    assert.equal(eligible.answer.finishReason, 'stop', eligible.answer.content);
    assert.ok(charts.some((chart) => chart.types.includes('kpi')), `${name}: tek başına üç ayrı gösterge eşiğini karşılamalı`);
  }
  const result = await ask({ text: 'BGS Şube Çalışmaları ile KAP TOOL projelerini gecikme ve yaklaşan teslimatlar açısından karşılaştır.',
    plan: { intent: 'rota', language: 'tr', analysis: { scope: 'projects', names: ['BGS Şube Çalışmaları', 'KAP TOOL'], focus: ['workload', 'overdue'] } } }, { detail: 'balanced' });
  const content = String(result.answer.content);
  assert.equal(result.answer.finishReason, 'stop', content);
  assert.ok(charts.every((chart) => !chart.types.includes('kpi')), JSON.stringify(charts));
  for (const paragraph of content.split('\n\n')) {
    const labels = [...paragraph.matchAll(/\*\*(BGS Şube Çalışmaları|KAP TOOL)\*\*: /g)].map((match) => match[1]);
    assert.deepEqual(labels, [...new Set(labels)], paragraph);
  }
});

test('tek satırlı liste doğal sayımla açılır; ölçüt parantezi düşer, satırın projesi korunur', async (t) => {
  const { phase4eConversation } = await import('./helpers/phase4eScenario.mjs');
  const { analysisBenchmarkSeed, BENCH_PROFILES } = await import('./helpers/analysisBenchmarkSeed.mjs');
  const { NOW } = await import('./helpers/aiToolFixtures.mjs');
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = analysisBenchmarkSeed();
  t.mock.timers.reset();
  const { ask } = phase4eConversation(t, { sicil: BENCH_PROFILES.B, seed, composition: false });
  const result = await ask({ text: 'Gecikmiş görevlerim neler?', plan: { intent: 'rota', language: 'tr', request: { operation: 'list',
    metrics: ['tasks.total', 'task.title', 'task.overdueDays', 'task.targetFinish'], population: { tool: 'rota_task_search', collection: 'tasks' }, filters: { deadline: 'overdue', assignee: 'me' } } } });
  const content = String(result.answer.content);
  assert.match(content, /^Şu anda \*\*1\*\* gecikmiş göreviniz var\./, content);
  assert.match(content, /\(\*\*[^*]+\*\* projesi\)/, content);
  assert.doesNotMatch(content, /ölçüt|Eşleşen/, content);
});
