/** Ortak nüfus, kanonik niyet ve görünür kanıt sınırlarının gerileme sınamaları. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { AYSE, ALI_1, ZEYNEP, NOW, PROJECTS, TASKS, rotaToolSeed, callRotaTool } from './helpers/aiToolFixtures.mjs';
import { phase4eConversation, populationReads } from './helpers/phase4eScenario.mjs';
import { composer, coveringBlocks } from './helpers/compositionScenario.mjs';
const { parseAnalysis, expandAnalysis, resolveAnalysisBrief } = await import('../src/server/ai/tools/analysisPlan.js');
const { normalizeAnalysisContext, normalizePendingAnalysis } = await import('../src/domain/ai/analysisContext.js');
const { unpackTypedPlan } = await import('../src/server/ai/tools/executionSet.js');
const { buildComposition, defaultComposition, validateComposition, renderComposition, ensureChart } = await import('../src/domain/ai/groundedComposition.js');
const { decodeAuthorizationPopulation } = await import('../src/server/ai/tools/evidenceAuthorization.js');
const { verifyRequested } = await import('./helpers/requestScenario.mjs');
const { createAiStack } = await import('./helpers/aiStack.mjs');
const window = { dateFrom: '2026-10-01', dateTo: '2026-10-31' };
const plan = (analysis, presentation = {}) => ({ intent: 'rota', language: 'tr', ...presentation, analysis });
const unpack = (value, options = {}) => unpackTypedPlan({ toolCalls: [{ name: 'rota_plan', arguments: JSON.stringify(value) }] }, { today: '2026-09-30', ...options }).plan;
const context = (extra = {}) => normalizeAnalysisContext({ v: 2, scope: 'self', subjects: [], focus: ['status'], rows: [{ type: 'project', id: PROJECTS.FULL }], ...window, ...extra });
const charts = (text) => [...text.matchAll(/```rota-chart\n([^`]+)```/gu)].map((match) => JSON.parse(match[1]));

for (const [name, analysis, chart, detail] of [
  ['kendi genel görünümü', { scope: 'self', focus: ['overview', 'overdue', 'upcoming'] }],
  ['iki kişinin durum karşılaştırması', { scope: 'person', names: ['Ali Veli', 'Zeynep Kaya'], focus: ['status'] }],
  ['kendiyle karşılaştırma', { scope: 'person', names: ['Zeynep Kaya'], withSelf: true, focus: ['workload', 'status'] }],
  ['ekip bütünleyici iş yükü', { scope: 'team', focus: ['status'] }, null, 'detailed'],
  ['portföy proje kırılımı', { scope: 'projects', focus: ['overview'] }, 'stacked'],
  ['iki kişide yığılmış grafik', { scope: 'person', names: ['Ali Veli', 'Zeynep Kaya'], focus: ['status'] }, 'stacked'],
  ['iki projede halka', { scope: 'project', names: ['Radar Modernizasyonu', 'Okuma Projesi'], focus: ['status'] }, 'donut']
]) test(`tüm katkı okumaları aynı tarih aralığındadır: ${name}`, () => {
  const parts = expandAnalysis(parseAnalysis({ ...analysis, ...window }), { today: '2026-09-30', chart, detail });
  assert.ok(parts.length && parts.length <= 4);
  for (const part of parts) {
    assert.equal(part.filters.dateFrom, window.dateFrom);
    assert.equal(part.filters.dateTo, window.dateTo);
    assert.notEqual(part.population.tool, 'rota_portfolio_summary', 'dönemsiz portföy okuması eklenmez');
    assert.notEqual(part.population.tool, 'rota_workload_summary', 'dönem desteklemeyen iş yükü aracı eklenmez');
  }
  if (chart === 'stacked' && analysis.scope === 'person') assert.equal(parts.filter((part) => part.population.groupBy === 'project').length, 2);
  if (chart === 'donut') assert.equal(parts.filter((part) => part.population.groupBy === 'status').length, 2);
});

test('önceki ve satır takiplerinde her eksik sınır bağımsız devralınır', () => {
  for (const scope of ['previous', 'row']) for (const override of [{}, { dateFrom: '2026-10-03' }, { dateTo: '2026-10-29' }, { dateFrom: '2026-10-03', dateTo: '2026-10-29' }]) {
    const brief = resolveAnalysisBrief(parseAnalysis({ scope, ...(scope === 'row' ? { rows: [1] } : {}), focus: ['status'], ...override }), { previous: context() });
    assert.equal(brief.dateFrom, override.dateFrom || window.dateFrom);
    assert.equal(brief.dateTo, override.dateTo || window.dateTo);
    for (const read of expandAnalysis(brief, { previous: context(), today: '2026-09-30' })) {
      assert.equal(read.filters.dateFrom, brief.dateFrom);
      assert.equal(read.filters.dateTo, brief.dateTo);
    }
  }
});

test('genişletilmiş yönler ve sürümlü bağlam kapalı biçimde saklanır; bozuk durum reddedilir', () => {
  const value = context({ scope: 'projects', focus: ['overview', 'overdue', 'upcoming', 'projects'] });
  assert.equal(value.v, 2);
  assert.equal(value.focus.length, 4);
  for (const bad of [{ ...value, v: 3 }, { ...value, futureScope: true }, { ...value, withSelf: true }, { ...value, focus: [...value.focus, 'status'] }, { ...value, rows: [{ type: 'project', id: 'bozuk' }] }]) assert.equal(normalizeAnalysisContext(bad), null);
  assert.equal(normalizePendingAnalysis({ language: 'tr', scope: 'person', names: ['Ali'], focus: ['status'], withSelf: true, unknown: true }), null);
});

test('satır boşluğu ve yinelenen proje konumsaldır; sonraki kayıt öne kaymaz', () => {
  const prior = context({ scope: 'projects', rows: [null, { type: 'project', id: PROJECTS.READ }, { type: 'project', id: PROJECTS.READ }] });
  assert.deepEqual(prior.rows.map((item) => item?.id || null), [null, PROJECTS.READ, PROJECTS.READ]);
  assert.throws(() => expandAnalysis(parseAnalysis({ scope: 'row', rows: [1], focus: ['status'] }), { previous: prior }), (error) => error.details.includes('$.analysis.rows:unavailable'));
  for (const ordinal of [2, 3]) assert.deepEqual(expandAnalysis(parseAnalysis({ scope: 'row', rows: [ordinal], focus: ['status'] }), { previous: prior })[0].entities, [{ type: 'project', id: PROJECTS.READ }]);
});

test('görsel ret türden ve üst düzey görsel tercihinden önce gelir', () => {
  for (const value of [{ intent: 'rota', language: 'tr', visual: false, chart: 'donut', request: { operation: 'list', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy: 'status' } } }, plan({ scope: 'self', focus: ['status'], visual: false }, { visual: true, chart: 'donut' }), plan({ scope: 'self', focus: ['status'] }, { visual: false, chart: 'donut' })]) {
    const parsed = unpack(value);
    assert.equal(parsed.visual, false);
    assert.equal(parsed.chart, undefined);
  }
});

test('kişiyle kendini karşılaştırma açıklama seçimi ve önceki takipte aynı özneyi, projeyi ve pencereyi korur', async (t) => {
  const seed = rotaToolSeed();
  seed.taskAssignees.push({ TaskId: TASKS.DUE_SOON, Sicil: ALI_1 }, { TaskId: TASKS.OVERDUE, Sicil: ALI_1 });
  const { ask } = phase4eConversation(t, { seed });
  const first = await ask({ text: 'Radar Modernizasyonu projesinde Ali Veli ile beni karşılaştır', plan: plan({ scope: 'person', names: ['Ali Veli'], withSelf: true, within: 'Radar Modernizasyonu', focus: ['status'], ...window }) });
  assert.equal(first.answer.finishReason, 'clarification', first.answer.content);
  const selected = await ask({ text: '1' });
  assert.equal(selected.inputs.length, 0, 'seçim modeli yeniden çağırmaz');
  assert.equal(selected.answer.finishReason, 'stop', selected.answer.content);
  for (const result of [selected, await ask({ text: 'neden', plan: plan({ scope: 'previous' }) })]) {
    const reads = populationReads(result.log);
    assert.ok(reads.some(({ params }) => params.personSicil === ALI_1));
    assert.ok(reads.some(({ params }) => params.assigneeMode === 'me'));
    assert.ok(reads.every(({ params }) => params.projectId === PROJECTS.FULL && params.dateFrom === window.dateFrom && params.dateTo === window.dateTo));
    assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  }
});

for (const relativeWindow of ['today', 'next_7_days']) test(`açıklama ertesi gün seçildiğinde bağıl pencere yeniden hesaplanır: ${relativeWindow === 'today' ? 'bugün' : 'gelecek yedi gün'}`, async (t) => {
  const { ask } = phase4eConversation(t);
  const first = await ask({ text: 'Ali Veli bugün ve yakın dönemde ne durumda', plan: plan({ scope: 'person', names: ['Ali Veli'], focus: ['status'], relativeWindow }) });
  assert.equal(first.answer.finishReason, 'clarification');
  t.mock.timers.setTime(Number(NOW) + 86400000);
  const next = await ask({ text: '1' });
  assert.equal(next.inputs.length, 0);
  assert.equal(next.answer.finishReason, 'stop', next.answer.content);
  const reads = populationReads(next.log);
  assert.ok(reads.length && reads.every(({ params }) => params.dateFrom === '2026-10-01' && params.dateTo === (relativeWindow === 'today' ? '2026-10-01' : '2026-10-07')));
});

test('önceki takip projesi açıklamaya düştüğünde kabul edilmiş yön ve pencere yeniden planlanmaz', async (t) => {
  const { ask, stack } = phase4eConversation(t);
  await ask({ text: 'işlerimin durumunu incele', plan: plan({ scope: 'self', focus: ['status'], ...window }) });
  const ambiguous = await ask({ text: 'bunu Proje kapsamında incele', plan: plan({ scope: 'previous', within: 'Proje', act: 'certainty' }) });
  assert.equal(ambiguous.answer.finishReason, 'clarification', ambiguous.answer.content);
  const pending = stack.db.aiMessageEvidence.map((row) => JSON.parse(row.EvidenceJson)).findLast((row) => row.clarificationContext)?.clarificationContext;
  const expected = pending[0].projectId;
  const selected = await ask({ text: '1' });
  assert.equal(selected.inputs.length, 0, 'önceki özet aynen yeniden yürütülür');
  assert.equal(selected.answer.finishReason, 'stop', selected.answer.content);
  assert.ok(populationReads(selected.log).length && populationReads(selected.log).every(({ params }) => params.projectId === expected && params.dateFrom === window.dateFrom && params.dateTo === window.dateTo), JSON.stringify({ expected, pending, reads: populationReads(selected.log) }));
});

test('skaler kanıtta açık tablo isteğinin karşılanamaması kullanıcıya söylenir', async (t) => {
  const { ask } = phase4eConversation(t);
  const result = await ask({ text: 'genel durumumu tabloyla göster', plan: plan({ scope: 'self', focus: ['overview'] }, { table: true }) });
  assert.equal(result.answer.finishReason, 'stop');
  assert.match(result.answer.content, /tablo olarak gösterilebilecek satır koleksiyonu yok/u);
});

test('desteklenmeyen grafik türü grafiksiz yanıtta türe özgü tek açıklama alır', async (t) => {
  const { ask } = phase4eConversation(t);
  const result = await ask({ text: 'işlerimi çizgi grafikle göster', plan: plan({ scope: 'self', focus: ['status'], dateFrom: '2026-10-01', dateTo: '2026-10-01' }, { chart: 'line' }) });
  assert.equal(result.answer.finishReason, 'stop');
  assert.equal(charts(result.answer.content).length, 0);
  assert.match(result.answer.content, /[Çç]izgi grafik/u);
  assert.doesNotMatch(result.answer.content, /güvenle grafik çizilemedi/u);
});

test('yazıyla sayı ve çoğunluk iddiası görünür yanıta giremez; sunucu olguları kalır', async (t) => {
  for (const [label, unsafe] of [['yazıyla sayı', 'There are fifty overdue tasks'], ['çoğunluk', 'Çoğu görev tamamlandı'], ['tarih', 'Mayıs ayının ilk günü her iş biter']]) await t.test(label, async (t) => {
    const { ask } = phase4eConversation(t, { compose: () => composer((view) => ({ blocks: [{ type: 'say', text: `${unsafe}: {${view.propositions[0].id}}.` }, ...view.tables.map((table) => ({ type: 'rows', source: table.id }))] })) });
    const result = await ask({ text: 'durumumu değerlendir', plan: plan({ scope: 'self', focus: ['status'] }) });
    assert.equal(result.answer.finishReason, 'stop');
    assert.equal(result.answer.content.includes(unsafe), false);
    assert.match(result.answer.content, /【R\d+】/u);
  });
});

test('iş yükü kesinliği sayfa tam olsa da eksik nüfusu tam göstermez', async (t) => {
  const pages = [];
  const seed = rotaToolSeed({ executiveScope: [{ ManagerSicil: AYSE, EmployeeSicil: ZEYNEP }, { ManagerSicil: AYSE, EmployeeSicil: ALI_1 }] });
  seed.taskAssignees.push({ TaskId: TASKS.OVERDUE, Sicil: ALI_1 }, { TaskId: TASKS.LITERAL, Sicil: ALI_1 });
  const { ask } = phase4eConversation(t, { seed, compose: () => composer((view) => { pages.push(view); return coveringBlocks(view); }) });
  await ask({ text: 'ekibimin iş yükü', plan: plan({ scope: 'team', focus: ['workload'] }) });
  const result = await ask({ text: 'ne kadar eminsin', plan: plan({ scope: 'previous', act: 'certainty' }) });
  const certainty = pages.at(-1).propositions.filter((item) => item.kind === 'certainty');
  assert.ok(certainty.length && certainty.every((item) => item.required));
  assert.ok(certainty.every((item) => /yalnızca bir kısmını/u.test(item.text)));
  assert.match(result.answer.content, /yalnızca bir kısmını/u);
  assert.match(result.answer.content, /kesin olarak söylenemez/u);
  assert.doesNotMatch(result.answer.content, /kayıtların tamamına dayanıyor/u);
});

test('satır-yalnız bağlam kanıt sınırında yetki nüfusuyla saklanır ve yeniden okunabilir', async (t) => {
  const stack = createAiStack(t, { sicil: AYSE, seed: rotaToolSeed(), env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_search', { assignee: 'me' });
  const [entry] = ledger.authorizationEntries();
  const payload = JSON.parse(entry.payload);
  payload.data.padding = '';
  entry.payload = JSON.stringify(payload);
  const size = ledger.persistable(['R1'])[0].evidenceJson.length;
  payload.data.padding = 'x'.repeat(31990 - size);
  entry.payload = JSON.stringify(payload);
  const rowsOnly = context({ rowsOnly: true, focus: [] });
  const saved = JSON.parse(ledger.persistable(['R1'], { analysisContext: rowsOnly })[0].evidenceJson);
  assert.deepEqual(normalizeAnalysisContext(saved.analysisContext), rowsOnly);
  assert.ok(decodeAuthorizationPopulation(saved.authorizationPopulation).length);
  const [read] = expandAnalysis(parseAnalysis({ scope: 'row', rows: [1], focus: ['status'] }), { previous: saved.analysisContext, today: '2026-09-30' });
  assert.deepEqual(read.entities, [{ type: 'project', id: PROJECTS.FULL }]);
});

/** Gerçek araç ve doğrulayıcı üzerinden gruplu bir olgu sayfası kurar. */
async function groupedPage(t, options = {}) {
  const stack = createAiStack(t, { sicil: AYSE, seed: rotaToolSeed(), env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_analytics', { assignee: 'me', groupBy: 'priority' });
  const verdict = verifyRequested(ledger, ['data.groups.*.label', 'data.groups.*.count'], { operation: 'list', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy: 'priority' }, filters: { assignee: 'me' } });
  assert.equal(verdict.ok, true);
  const parts = [0, 1].map((index) => ({ index, presentation: verdict.presentation }));
  return { parts, page: buildComposition({ parts, ...options }) };
}

test('başlığın altına karışık bölüm önermeleri yerleştirilemez', async (t) => {
  const { page } = await groupedPage(t, { detail: 'detailed' });
  const ids = [1, 2].map((part) => page.view.propositions.find((item) => item.part === part).id);
  const result = validateComposition(page, { blocks: [{ type: 'say', text: `{${ids[0]}}. Ayrıca {${ids[1]}}.` }, ...page.view.tables.map((table) => ({ type: 'rows', source: table.id }))] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues, ['PART_MIXED']);
});

test('istenen grafik eklenirken önceki grafikler bütçeyi doldursa da son çizimde istenen tür kalır', async (t) => {
  const { page } = await groupedPage(t, { visual: true, chartType: 'donut', detail: 'balanced' });
  const props = page.view.propositions.filter((item) => item.part === 1).map((item) => item.id);
  const raw = { blocks: [{ type: 'say', text: props.map((id) => `{${id}}.`).join(' ') }, { type: 'chart', source: page.view.charts[0].id, style: 'bar' },
    { type: 'say', text: page.view.propositions.filter((item) => item.part === 2).map((item) => `{${item.id}}.`).join(' ') },
    { type: 'chart', source: page.view.charts[1].id, style: 'bar' }, ...page.view.tables.map((table) => ({ type: 'rows', source: table.id }))] };
  // Mevcut çubuk adaylarının türü yalnızca çubuktur; istenen tür sonda ayrı adayda bulunur.
  for (const chart of page.render.charts.values()) page.render.charts.set(chart.id, { ...chart, types: ['bar'] });
  const original = page.render.charts.get(page.view.charts[0].id);
  page.render.charts.set('G7', { ...original, id: 'G7', types: ['donut'] });
  const checked = validateComposition(page, raw);
  assert.equal(checked.ok, true, JSON.stringify(checked.issues));
  const ensured = ensureChart(page, checked);
  assert.equal(ensured.chartInserted, true);
  assert.ok(charts(renderComposition(page, ensured).text).some((chart) => chart.type === 'donut'));
});

test('zorunlu çekinceler ve kesinlik ifadeleri sayfa bütçesi dolsa da görünür yanıtta kalır', async (t) => {
  const seed = rotaToolSeed({ executiveScope: [{ ManagerSicil: AYSE, EmployeeSicil: ZEYNEP }, { ManagerSicil: AYSE, EmployeeSicil: ALI_1 }] });
  seed.taskAssignees.push({ TaskId: TASKS.OVERDUE, Sicil: ALI_1 });
  const stack = createAiStack(t, { sicil: AYSE, seed, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_workload_summary', { assignee: 'team' });
  const verdict = verifyRequested(ledger, ['data.people.*.name', 'data.people.*.openTasks'], { operation: 'list', metrics: ['person.name', 'tasks.open'], population: { tool: 'rota_workload_summary', collection: 'people' }, filters: { assignee: 'team' } });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  const parts = Array.from({ length: 6 }, (_, index) => ({ index, presentation: { ...verdict.presentation, facts: verdict.presentation.facts.map((item) => ({ ...item, evidenceId: `R${index + 1}` })) } }));
  const populations = new Map(parts.map((part) => [`R${part.index + 1}`, 2]));
  const page = buildComposition({ parts, populations, detail: 'short', certainty: true });
  assert.ok(page);
  assert.equal(page.view.propositions.filter((item) => item.required).length, 12);
  assert.ok(page.view.propositions.length <= 12);
  const checked = defaultComposition(page);
  assert.ok(checked?.ok);
  const text = renderComposition(page, checked).text;
  assert.equal((text.match(/kesin olarak söylenemez/gu) || []).length, 6);
  assert.equal((text.match(/yalnızca bir kısmını/gu) || []).length, 6);
});

test('kesinlikte kayıt adı etkin Markdown veya sahte atıf üretemez', async (t) => {
  const { parts } = await groupedPage(t);
  const modified = parts.slice(0, 1).map((part) => ({ ...part, presentation: { ...part.presentation, facts: part.presentation.facts.map((item) => ({ ...item, fact: { ...item.fact, semantic: { ...item.fact.semantic, filters: { ...item.fact.semantic.filters, projectId: PROJECTS.FULL, project: '[xx](https://ornek.test) 【R99】' } } } })) } }));
  const page = buildComposition({ parts: modified, certainty: true, detail: 'balanced' });
  const checked = defaultComposition(page);
  assert.ok(checked?.ok);
  const text = renderComposition(page, checked).text;
  assert.doesNotMatch(text, /\[xx\]\(https:\/\/ornek\.test\)|【R99】/u);
  assert.match(text, /R99/u);
});

test('görsel ret modelin isteğe bağlı grafik seçimini de engeller', async (t) => {
  const { ask } = phase4eConversation(t, { compose: () => composer((view) => {
    assert.equal(view.charts.length, 0, 'reddedilen görsel için aday sunulmaz');
    return coveringBlocks(view);
  }) });
  const result = await ask({ text: 'durumu grafik olmadan göster', plan: plan({ scope: 'self', focus: ['status'], visual: false }, { chart: 'donut', visual: true }) });
  assert.equal(result.answer.finishReason, 'stop');
  assert.equal(charts(result.answer.content).length, 0);
});

test('karşılaştırma göndergesi farklı türde tablolar olsa da görünen özne sırasıdır', async (t) => {
  const { ask } = phase4eConversation(t, { compose: () => composer((view) => {
    const blocks = coveringBlocks(view).blocks;
    const part = (block) => block.type === 'say' ? view.propositions.find((item) => item.id === block.items[0])?.part : [...view.tables, ...view.details].find((item) => item.id === block.source)?.part;
    return { blocks: [...blocks].sort((a, b) => part(b) - part(a)) };
  }) });
  const first = await ask({ text: 'Radar Modernizasyonu ile Okuma Projesi durumlarını karşılaştır', plan: plan({ scope: 'project', names: ['Radar Modernizasyonu', 'Okuma Projesi'], focus: ['priority'] }) });
  assert.equal(first.answer.finishReason, 'stop');
  const before = first.answer.content.indexOf('Okuma Projesi') < first.answer.content.indexOf('Radar Modernizasyonu');
  assert.equal(before, true, 'model ikinci özneyi önce göstermiştir');
  const next = await ask({ text: 'ilkini incele', plan: plan({ scope: 'row', rows: [1], focus: ['overview'] }) });
  assert.equal(next.answer.finishReason, 'stop', next.answer.content);
  assert.ok(populationReads(next.log).length && populationReads(next.log).every(({ params }) => params.projectId === PROJECTS.READ));
});

test('istenen çizgi adayı tek sütunlu aday sınırının arkasında kaybolmaz', async (t) => {
  const stack = createAiStack(t, { sicil: AYSE, seed: rotaToolSeed(), env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' } });
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_analytics', { assignee: 'me', groupBy: 'priority' });
  const verdict = verifyRequested(ledger, ['data.groups.*.label', 'data.groups.*.count', 'data.groups.*.open', 'data.groups.*.overdue'], { operation: 'list', metrics: ['tasks.total', 'tasks.open', 'tasks.overdue'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy: 'priority' }, filters: { assignee: 'me' } });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  const parts = [0, 1, 2].map((index) => ({ index, presentation: { ...verdict.presentation, facts: verdict.presentation.facts.map((item) => {
    const label = /data\.groups\.(\d+)\.label/u.exec(item.fact.field);
    const row = /data\.groups\.(\d+)\./u.exec(item.fact.field);
    return { ...item, evidenceId: `R${index + 1}`, fact: { ...item.fact, ...(index === 2 && label ? { value: `2026-${String(7 + Number(label[1])).padStart(2, '0')}` } : {}),
      subject: index === 2 && label ? `2026-${String(7 + Number(label[1])).padStart(2, '0')}` : item.fact.subject, semantic: { ...item.fact.semantic, ...(index === 2 ? { groupBy: 'target_month', row: { ...item.fact.semantic.row, name: `2026-${String(7 + Number(row[1])).padStart(2, '0')}` } } : {}) } } };
  }) } }));
  const page = buildComposition({ parts, visual: true, chartType: 'line', detail: 'detailed' });
  assert.ok(page);
  assert.ok(page.view.charts.length > 6, JSON.stringify({ charts: page.view.charts, facts: parts[2].presentation.facts.map((item) => [item.fact.field, item.fact.value, item.fact.semantic.groupBy, item.fact.semantic.complete]) }));
  assert.ok(page.view.charts.some((chart) => chart.part === 3 && chart.types.includes('line')));
});

test('onarım sıralı alt kümeyi iki tarafta kanonik yönlerle karşılaştırır', async (t) => {
  const queue = [plan({ scope: 'self', focus: ['overview', 'deadline', 'priority', 'status'] }), plan({ scope: 'self', focus: ['deadlines', 'status'] })];
  const { ask } = phase4eConversation(t, { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: queue.shift() }] }) });
  const result = await ask({ text: 'işlerimin termin ve durum dağılımı' });
  assert.equal(result.inputs.length, 2);
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
});

test('güvenilmeyen başka ad özne sayısı eşit diye önceki özneyle değiştirilmez', async (t) => {
  const { ask } = phase4eConversation(t);
  await ask({ text: 'Radar Modernizasyonu projesi', plan: plan({ scope: 'project', names: ['Radar Modernizasyonu'], focus: ['overview'] }) });
  const result = await ask({ text: 'sadece gecikmeler', plan: plan({ scope: 'project', names: ['Okuma Projesi'], focus: ['overdue'] }) });
  assert.equal(populationReads(result.log).length, 0, 'güvenilmeyen adla ya da yerine konan eski özneyle görev okunmaz');
  assert.equal(result.answer.finishReason, 'grounding_failed');
});

test('dört etkin yön taşıyan önceki analiz açıklamadan sonra yön kaybetmeden yeniden yürür', async (t) => {
  const { ask } = phase4eConversation(t);
  const first = await ask({ text: 'projelerimin durumunu genel görünüm gecikme ve yaklaşan işler olarak incele', plan: plan({ scope: 'projects', focus: ['overview', 'overdue', 'upcoming'] }) });
  assert.equal(first.answer.finishReason, 'stop');
  const ambiguous = await ask({ text: 'bunu Proje ile daralt', plan: plan({ scope: 'previous', within: 'Proje' }) });
  assert.equal(ambiguous.answer.finishReason, 'clarification', ambiguous.answer.content);
  const selected = await ask({ text: '1' });
  assert.equal(selected.inputs.length, 0);
  assert.equal(selected.answer.finishReason, 'stop', selected.answer.content);
  assert.ok(populationReads(selected.log).length >= 3, 'genel görünüm, gecikme, yaklaşan ve proje kırılımı korunur');
});

test('açıkça kapatılan kendiyle karşılaştırma açıklama yeniden yürütmesinde geri gelmez', async (t) => {
  const { ask } = phase4eConversation(t);
  const first = await ask({ text: 'Zeynep Kaya ile beni karşılaştır', plan: plan({ scope: 'person', names: ['Zeynep Kaya'], withSelf: true, focus: ['status'] }) });
  assert.equal(first.answer.finishReason, 'stop');
  const ambiguous = await ask({ text: 'yalnızca onu Proje kapsamında incele', plan: plan({ scope: 'previous', withSelf: false, within: 'Proje' }) });
  assert.equal(ambiguous.answer.finishReason, 'clarification', ambiguous.answer.content);
  const selected = await ask({ text: '1' });
  assert.equal(selected.inputs.length, 0);
  assert.equal(selected.answer.finishReason, 'stop', selected.answer.content);
  assert.ok(populationReads(selected.log).length && populationReads(selected.log).every(({ params }) => params.personSicil === ZEYNEP), JSON.stringify(populationReads(selected.log).map(({ params }) => ({person:params.personSicil,assignee:params.assigneeMode}))) );
  assert.equal(populationReads(selected.log).some(({ params }) => params.assigneeMode === 'me'), false);
});
