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
  for (const [label, unsafe] of [['yazıyla sayı', 'There are fifty overdue tasks'], ['çoğunluk', 'Çoğu görev tamamlandı'], ['tarih', 'Mayıs ayının ilk günü her iş biter']]) await t.test(`davranış durumu: ${label}`, async (t) => {
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
  const rows = page.view.tables.map((table) => ({ type: 'rows', source: table.id }));
  // Kimlik paragrafı karışık bölümü reddeder.
  const listed = validateComposition(page, { blocks: [{ type: 'say', items: ids }, ...rows] });
  assert.equal(listed.ok, false);
  assert.deepEqual(listed.issues, ['PART_MIXED']);
  // Modelin düzyazısı bölüm sınırında bölünür: her paragraf tek bölümdür ve her başlığın altındaki bloklar yalnızca o bölümündür.
  const result = validateComposition(page, { blocks: [{ type: 'say', text: `{${ids[0]}}. Ayrıca {${ids[1]}}.` }, ...rows] });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  const { render } = page;
  const partOf = (block) => (block.type === 'say' || block.type === 'note' ? render.propositions.get(block.items.find((id) => render.propositions.has(id)))?.part
    : block.type === 'rows' ? render.tables.get(block.source).part : block.type === 'chart' ? render.charts.get(block.source).part : render.details.get(block.source)?.part);
  const itemPart = (id) => render.propositions.get(id)?.part ?? render.tables.get(id)?.part ?? render.charts.get(id)?.part;
  const says = result.blocks.filter((block) => block.type === 'say');
  for (const block of says) assert.equal(new Set(block.items.map(itemPart)).size, 1, `karışık paragraf: ${JSON.stringify(block.items)}`);
  assert.ok(says.some((block) => block.items.includes(ids[0])) && says.some((block) => block.items.includes(ids[1])));
  let titled = null;
  for (const block of result.blocks) {
    if (block.type === 'title') titled = render.titles.get(block.source).part;
    else if (titled != null) assert.equal(partOf(block), titled, `başlığın altında başka bölüm: ${JSON.stringify(block)}`);
  }
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

for (const scope of ['previous', 'row']) test(`onarım devralınan pencere ve görsel tercihini yeniden bildirmeden uygulanır: ${scope === 'previous' ? 'önceki özne' : 'görünen satır'}`, async (t) => {
  const queue = [];
  const { ask } = phase4eConversation(t, { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: queue.shift() }] }) });
  const acceptedWindow = { dateFrom: '2026-09-01', dateTo: '2026-10-31' };
  queue.push(plan({ scope: 'projects', focus: ['projects'], ...acceptedWindow }, { visual: true, chart: 'bar' }));
  assert.equal((await ask({ text: 'projeleri bu aralıkta grafikle göster' })).answer.finishReason, 'stop');
  const follow = { scope, ...(scope === 'row' ? { rows: [1] } : {}), focus: ['status'] };
  queue.push(plan({ ...follow, act: 'certainty' }, { chart: 'geçersiz' }), plan({ ...follow, act: 'certainty' }, { chart: 'donut' }));
  const result = await ask({ text: 'aynı aralığı halka grafikle göster, ne kadar kesin?' });
  assert.equal(result.inputs.length, 2);
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  const reads = populationReads(result.log);
  assert.ok(reads.length && reads.every(({ params }) => params.dateFrom === acceptedWindow.dateFrom && params.dateTo === acceptedWindow.dateTo));
  if (scope === 'row') assert.ok(reads.every(({ params }) => params.projectId === PROJECTS.FULL));
  assert.ok(charts(result.answer.content).some((chart) => chart.type === 'donut'), result.answer.content);
  assert.match(result.answer.content, /görebildiğiniz kayıtların tamamına|yalnızca bir kısmını/u);
});

for (const scope of ['previous', 'row']) test(`devralınan sınırla ters dönen pencere okumadan önce reddedilip aynı niyetle onarılır: ${scope === 'previous' ? 'önceki özne' : 'görünen satır'}`, async (t) => {
  const queue = [];
  const { ask } = phase4eConversation(t, { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: queue.shift() }] }) });
  queue.push(plan({ scope: 'projects', focus: ['projects'], dateFrom: '2026-10-01', dateTo: '2026-10-07' }));
  assert.equal((await ask({ text: 'projeleri bir ve yedi ekim arasında incele' })).answer.finishReason, 'stop');
  const follow = { scope, ...(scope === 'row' ? { rows: [1] } : {}), focus: ['status'] };
  queue.push(plan({ ...follow, dateFrom: '2026-10-10' }), plan({ ...follow, dateFrom: '2026-10-03' }));
  const result = await ask({ text: 'aralığın başlangıcını değiştir' });
  assert.equal(result.inputs.length, 2);
  const notes = result.inputs[1].messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
  assert.match(notes, /analysis\.dateFrom:reversed/u);
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  const reads = populationReads(result.log);
  assert.ok(reads.length && reads.every(({ params }) => params.dateFrom === '2026-10-03' && params.dateTo === '2026-10-07'));
  assert.match(result.answer.content, /3 Ekim 2026/u);
});

test('bir sınırın değiştirilmesiyle ters dönen her pencere analiz alanında reddedilir', () => {
  for (const scope of ['previous', 'row']) for (const bound of [{ dateFrom: '2026-11-01' }, { dateTo: '2026-09-30' }]) {
    assert.throws(() => resolveAnalysisBrief(parseAnalysis({ scope, ...(scope === 'row' ? { rows: [1] } : {}), ...bound }), { previous: context() }),
      (error) => error.details.includes('$.analysis.dateFrom:reversed'));
  }
});

test('kesinlikte kayıt adının harfleri cümle başında ve bağlaçtan sonra aynen kalır', async (t) => {
  const { parts } = await groupedPage(t);
  for (const name of ['IBM', 'iOS', 'İK', 'xx', '[Ad](bağ) 【R99】']) {
    const modified = parts.slice(0, 1).map((part) => ({ ...part, presentation: { ...part.presentation, facts: part.presentation.facts.map((item) => ({ ...item, fact: { ...item.fact, semantic: { ...item.fact.semantic, filters: { ...item.fact.semantic.filters, projectId: PROJECTS.FULL, project: name } } } })) } }));
    const page = buildComposition({ parts: modified, certainty: true });
    const certainty = page.view.propositions.find((item) => item.kind === 'certainty');
    for (const connector of ['', 'Ayrıca ']) {
      const checked = validateComposition(page, { blocks: [{ type: 'say', text: `${connector}{${certainty.id}}.` }, ...page.view.tables.map((table) => ({ type: 'rows', source: table.id }))] });
      assert.equal(checked.ok, true, JSON.stringify(checked.issues));
      const content = renderComposition(page, checked).text;
      // Modelin bağlacı çizilmez; kayıt adı cümle başında harfleri değişmeden kalır.
      assert.doesNotMatch(content, /Ayrıca/u);
      if (name === '[Ad](bağ) 【R99】') assert.doesNotMatch(content, /\[Ad\]\(bağ\)|【R99】/u);
      else assert.ok(content.includes(`${name} projesindeki`), content);
    }
  }
});

test('farklı güvenilmeyen adın önceki özneye onarılması veri okunmadan reddedilir', async (t) => {
  const queue = [plan({ scope: 'project', names: ['Radar Modernizasyonu'], focus: ['overview'] }),
    plan({ scope: 'project', names: ['Okuma Projesi'], focus: ['status'] }), plan({ scope: 'previous', focus: ['status'] }),
    { intent: 'clarify', language: 'tr', clarify: { reason: 'missing_referent' } }];
  const { ask } = phase4eConversation(t, { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: queue.shift() }] }) });
  await ask({ text: 'Radar Modernizasyonu projesini incele' });
  const result = await ask({ text: 'sadece durumunu göster' });
  assert.equal(result.inputs.length, 3);
  assert.equal(result.log.length, 0);
  assert.equal(result.answer.finishReason, 'clarification');
  assert.match(result.answer.content, /adını veya kodunu/u);
});

for (const composition of [true, false]) test(`tarihli kişi kırılımı tam görev sayfasını tam ekip kadrosu saymaz: ${composition ? 'model düzeni' : 'sunucu düzeni'}`, async (t) => {
  const pages = [];
  const seed = rotaToolSeed();
  seed.executiveScope = [ALI_1, ZEYNEP, 910098].map((EmployeeSicil) => ({ ManagerSicil: AYSE, EmployeeSicil }));
  seed.taskAssignees.push({ TaskId: TASKS.DUE_SOON, Sicil: ALI_1 });
  const { ask } = phase4eConversation(t, { seed, composition, compose: () => composer((view) => { pages.push(view); return coveringBlocks(view); }) });
  const interval = { dateFrom: '2026-09-30', dateTo: '2026-10-31' };
  const first = await ask({ text: 'bu dönemde ekibimin iş yükü dengeli mi, tablo ve grafikle göster', plan: plan({ scope: 'team', focus: ['workload'], ...interval }, { table: true, chart: 'bar' }) });
  const next = await ask({ text: 'ne kadar eminsin', plan: plan({ scope: 'previous', act: 'certainty' }) });
  for (const result of [first, next]) {
    assert.equal(result.answer.finishReason, 'stop', result.answer.content);
    const reads = populationReads(result.log);
    assert.ok(reads.length && reads.every(({ params }) => params.assigneeMode === 'team' && params.dateFrom === interval.dateFrom && params.dateTo === interval.dateTo), JSON.stringify(reads));
    assert.match(result.answer.content, /kadronun tamamını kanıtlamaz/u);
    assert.match(result.answer.content, /eşleşen işi olmayan/u);
    assert.match(result.answer.content, /kesin olarak söylenemez/u);
    assert.doesNotMatch(result.answer.content, /Grup tablosu görebildiğiniz kayıtların tamamına dayanıyor|görece dengeli/u);
  }
  assert.match(next.answer.content, /yalnızca bir kısmını/u);
  assert.ok(charts(first.answer.content).some((chart) => chart.type === 'bar'));
  if (composition) { assert.ok(pages.length > 0); assert.ok(pages.every((page) => page.tables[0].complete === false)); }
});

for (const [label, change] of [['grafik türü', { chart: 'bar' }], ['tablo isteği', { table: false }], ['yanıt dili', { language: 'en' }]]) test(`analiz onarımı geçerli plan düzeyi anlamı değiştiremez: ${label}`, async (t) => {
  const presentation = { chart: 'donut', table: true };
  const queue = [plan({ scope: 'self', focus: ['status', 'priority', 'projects', 'overview'] }, presentation),
    { ...plan({ scope: 'self', focus: ['status', 'priority'] }, presentation), ...change }, { intent: 'clarify', language: 'tr', clarify: { reason: 'ambiguous' } }];
  const { ask } = phase4eConversation(t, { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: queue.shift() }] }) });
  const result = await ask({ text: 'görevlerimi halka grafik ve tablo ile Türkçe değerlendir' });
  assert.equal(result.inputs.length, 3);
  assert.equal(result.log.length, 0);
  assert.equal(result.answer.finishReason, 'clarification');
});

test('analiz onarımı yalnızca hatalı sunum alanını düzeltir ve geçerli tür ile tabloyu çizer', async (t) => {
  const queue = [plan({ scope: 'self', focus: ['status'] }, { chart: 'donut', table: 'bozuk' }), plan({ scope: 'self', focus: ['status'] }, { chart: 'donut', table: true })];
  const { ask } = phase4eConversation(t, { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: queue.shift() }] }) });
  const result = await ask({ text: 'durumumu halka grafik ve tabloyla göster' });
  assert.equal(result.inputs.length, 2);
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.ok(charts(result.answer.content).some((chart) => chart.type === 'donut'));
  assert.match(result.answer.content, /\n\|[^\n]+\|\n\|[- :|]+\|/u);
});

test('tarihli kişi satırı sicil grup anahtarından çözülür ve aynı pencereyle yetkili nüfusta okunur', async (t) => {
  const seed = rotaToolSeed();
  seed.executiveScope = [ALI_1, ZEYNEP].map((EmployeeSicil) => ({ ManagerSicil: AYSE, EmployeeSicil }));
  seed.taskAssignees.push({ TaskId: TASKS.OVERDUE, Sicil: ALI_1 }, { TaskId: TASKS.LITERAL, Sicil: ALI_1 });
  const { ask, stack } = phase4eConversation(t, { seed });
  const interval = { dateFrom: '2026-09-01', dateTo: '2026-10-31' };
  const first = await ask({ text: 'ekibimin dönemli iş yükünü tabloyla göster', plan: plan({ scope: 'team', focus: ['workload'], ...interval }, { table: true }) });
  assert.equal(first.answer.finishReason, 'stop', first.answer.content);
  const saved = stack.db.aiMessageEvidence.map((row) => JSON.parse(row.EvidenceJson)).findLast((row) => row.analysisContext)?.analysisContext;
  assert.equal(saved.rows[0].type, 'person');
  assert.equal(saved.rows[0].id, String(ALI_1));
  const next = await ask({ text: 'ilk kişiyi incele', plan: plan({ scope: 'row', rows: [1], focus: ['status'] }) });
  assert.equal(next.answer.finishReason, 'stop', next.answer.content);
  const reads = populationReads(next.log);
  assert.ok(reads.length && reads.every(({ params }) => params.personSicil === ALI_1 && params.dateFrom === interval.dateFrom && params.dateTo === interval.dateTo));
  assert.ok(reads.every(({ params }) => params.isAdmin === 0 && params.sicil === AYSE));
});

for (const composition of [false, true]) test(`açık tablo isteği liste ve tek satırda da tablo olur: ${composition ? 'bozuk model düzeninden dönüş' : 'model düzeni kapalı'}`, async (t) => {
  const { ask } = phase4eConversation(t, { composition, compose: () => ({ type: 'text', text: 'geçersiz düzen' }) });
  const result = await ask({ text: 'görevlerimi tablo halinde göster', plan: { intent: 'rota', language: 'tr', table: true, request: {
    operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks' }, filters: { assignee: 'me', status: ['done'] }, layout: 'list'
  } } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.match(result.answer.content, /\n\|[^\n]+\|\n\|[- :|]+\|/u);
  assert.doesNotMatch(result.answer.content, /satır koleksiyonu yok/u);
});

test('desteklenen tür çizimde kalmadığında veri yokluğu iddiası yerine gerçek sunum sonucu söylenir', async (t) => {
  const { chartTypeNote } = await import('../src/server/ai/assistant/groundedAnswer.js');
  const { page } = await groupedPage(t, { visual: true, chartType: 'donut' });
  for (const chart of [null, 'bar']) {
    const notes = chartTypeNote({ locale: 'tr', trace: {} }, page, { chart, chartTypes: chart ? [chart] : [] });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /güvenle çizilemedi|güvenle grafik çizilemedi/u);
    assert.doesNotMatch(notes[0], /bu veri yok|gerektir|gerekir/u);
    if (chart) assert.match(notes[0], /çubuk grafik olarak gösterildi/u);
  }
});

for (const [start, end] of [
  [{ dateFrom: '2026-10-01', dateTo: '2026-10-31' }, { dateFrom: '2026-08-01', dateTo: '2026-08-31' }],
  [{ dateFrom: '2026-08-01', dateTo: '2026-08-31' }, { dateFrom: '2026-10-01', dateTo: '2026-10-31' }]
]) test(`tarih değişen takip örtük yönü son pencereden yeniden hesaplar: ${start.dateTo < '2026-09-30' ? 'geçmişten geleceğe' : 'gelecekten geçmişe'}`, async (t) => {
  const { ask } = phase4eConversation(t);
  const first = await ask({ text: 'işlerimin genel durumunu bu dönemde değerlendir', plan: plan({ scope: 'self', focus: ['overview'], ...start }) });
  assert.equal(first.answer.finishReason, 'stop', first.answer.content);
  const second = await ask({ text: 'peki bu diğer dönemde', plan: plan({ scope: 'previous', ...end }) });
  assert.equal(second.answer.finishReason, 'stop', second.answer.content);
  const reads = populationReads(second.log);
  assert.ok(reads.length >= 2, 'genel görünüm ve son pencerenin zorunlu yönü gerçekten okunur');
  assert.ok(reads.every(({ params }) => params.dateFrom === end.dateFrom && params.dateTo === end.dateTo));
  assert.match(second.inputs[0].messages.map((item) => item.content).join('\n'), /"focus":\["overview"\]/u);
  const expanded = expandAnalysis(parseAnalysis({ scope: 'self', focus: ['overview'], ...end }), { today: '2026-09-30' });
  assert.equal(expanded[1].population.groupBy === 'target_month', end.dateTo < '2026-09-30');
});

test('satır daraltması uyumlu yön sırasını korur ve yalnızca hepsi geçersizse genel görünüme döner', () => {
  const person = context({ scope: 'team', focus: ['workload', 'status'], rows: [{ type: 'person', id: String(ALI_1) }] });
  assert.deepEqual(resolveAnalysisBrief(parseAnalysis({ scope: 'row', rows: [1] }), { previous: person }).focus, ['workload', 'status']);
  const project = context({ focus: ['projects'], rows: [{ type: 'project', id: PROJECTS.FULL }] });
  assert.deepEqual(resolveAnalysisBrief(parseAnalysis({ scope: 'row', rows: [1] }), { previous: project }).focus, ['overview', 'overdue', 'upcoming']);
  const explicit = context({ focus: ['upcoming'] });
  assert.throws(() => expandAnalysis(parseAnalysis({ scope: 'previous', dateFrom: '2026-08-01', dateTo: '2026-08-31' }), { previous: explicit, today: '2026-09-30' }), (error) => error.details.includes('$.analysis.dateTo:past'));
});

test('dönemli kişi iş yükü ortak görevde yalnızca seçilen kişiyi özne yapar', async (t) => {
  const seed = rotaToolSeed();
  seed.taskAssignees.push({ TaskId: TASKS.DUE_SOON, Sicil: ALI_1 });
  const { ask } = phase4eConversation(t, { seed });
  const interval = { dateFrom: '2026-09-30', dateTo: '2026-10-31' };
  const result = await ask({ text: `${ALI_1} sicilli kişinin iş yükünü bu dönemde değerlendir`, plan: plan({ scope: 'person', names: [String(ALI_1)], focus: ['workload'], ...interval }) });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  const reads = populationReads(result.log);
  assert.ok(reads.length > 0);
  assert.ok(reads.every(({ params }) => params.personSicil === ALI_1 && params.dateFrom === interval.dateFrom && params.dateTo === interval.dateTo), JSON.stringify(reads));
  assert.doesNotMatch(result.answer.content, /Ayşe Yılmaz|Zeynep Kaya/u);
  const requests = expandAnalysis(parseAnalysis({ scope: 'person', names: ['Ali Veli'], focus: ['workload'], ...interval }), { today: '2026-09-30' });
  assert.equal(requests[0].operation, 'value');
  assert.equal(requests.some((request) => request.population.groupBy === 'assignee'), false);
});

test('uzun düzyazı paragrafı düşerken geçerli komşu paragraf ve düzen korunur', async (t) => {
  const { PROSE_LIMITS } = await import('../src/domain/ai/groundedProse.js');
  const { COMPOSITION_LIMITS } = await import('../src/domain/ai/groundedComposition.js');
  const { page } = await groupedPage(t);
  assert.equal(PROSE_LIMITS.maxSentences, COMPOSITION_LIMITS.maxSayItems);
  const first = page.view.propositions[0];
  const extra = Array.from({ length: PROSE_LIMITS.maxSentences + 1 }, (_, index) => ({ ...page.render.propositions.get(first.id), id: `P${40 + index}`, required: false }));
  for (const item of extra) page.render.propositions.set(item.id, item);
  const checked = validateComposition(page, { blocks: [{ type: 'say', text: extra.map((item) => `{${item.id}}.`).join(' ') }, { type: 'say', text: `{${first.id}}.` }, ...page.view.tables.map((table) => ({ type: 'rows', source: table.id }))] });
  assert.equal(checked.ok, true, JSON.stringify(checked.issues));
  assert.equal(checked.prose.rejected, 1);
  const rendered = renderComposition(page, checked);
  assert.ok(rendered.text.includes(page.render.propositions.get(first.id).markdown));
  assert.ok(checked.blocks.some((block) => block.type === 'say' && block.items.includes(first.id)));
});

for (const scope of ['self', 'team']) test(`İngilizce kesinlik iyelik başlığına fazladan tanımlık eklemez: ${scope === 'self' ? 'kendi işleri' : 'ekip işleri'}`, async (t) => {
  const { ask } = phase4eConversation(t);
  const result = await ask({ text: 'show overdue tasks certainty', plan: { intent: 'rota', language: 'en', analysis: { scope, focus: ['overdue'], act: 'certainty' }, table: true } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.doesNotMatch(result.answer.content, /the your/iu);
  assert.match(result.answer.content, /Your (?:team's )?.*table (?:covers|shows)/u);
});

test('kısa kayıt adı ilgisiz başlık önekini kayıt başlığı saymaz', async (t) => {
  const { parts } = await groupedPage(t);
  const own = parts.slice(0, 1).map((part) => ({ ...part, presentation: { ...part.presentation, facts: part.presentation.facts.map((item) => ({ ...item, fact: { ...item.fact, semantic: { ...item.fact.semantic, filters: { ...item.fact.semantic.filters, statuses: ['todo', 'in_progress'] }, entity: { name: 'A' } } } })) } }));
  const page = buildComposition({ parts: own, certainty: true });
  const certainty = page.view.propositions.find((item) => item.kind === 'certainty');
  assert.match(certainty.text, /^Açık görevlerinizin/u);
  const checked = validateComposition(page, { blocks: [{ type: 'say', text: `Ayrıca {${certainty.id}}.` }, ...page.view.tables.map((table) => ({ type: 'rows', source: table.id }))] });
  assert.equal(checked.ok, true, JSON.stringify(checked.issues));
  assert.doesNotMatch(renderComposition(page, checked).text, /Ayrıca [A-ZÇĞİÖŞÜ]/u);
});

test('görevsiz kabul profili rastlantısal sıfır yerine sunucunun boş nüfus ifadesini üretir', async (t) => {
  const { uiSeed, P } = await import('../scripts/ui-acceptance/uiSeed.mjs');
  const { semanticFailures } = (await import('../scripts/ui-acceptance/expectations.cjs')).default;
  const { readFileSync } = await import('node:fs');
  const expected = JSON.parse(readFileSync('scripts/ui-acceptance/scenarios/G.json', 'utf8')).conversations[0].expectedTurns[0];
  const { ask } = phase4eConversation(t, { seed: uiSeed(), sicil: P.G });
  const result = await ask({ text: 'şu anda en çok neye dikkat etmeliyim', plan: plan({ scope: 'self', focus: ['overview', 'overdue', 'upcoming'] }) });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.deepEqual(semanticFailures(expected, { text: result.answer.content }, { outcome: 'grounded' }), [], result.answer.content);
  assert.ok(populationReads(result.log).length > 0);
});

test('açık tablo isteğinde ilk çıktı tablosu yanlış kullanılamama notu almaz', async (t) => {
  const { ask } = phase4eConversation(t, { compose: () => composer((view) => {
    const { blocks } = coveringBlocks(view);
    return { blocks: [...blocks.filter((block) => block.type === 'rows'), ...blocks.filter((block) => !['rows', 'title'].includes(block.type))] };
  }) });
  const request = (status) => ({ operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks' }, ...(status ? { filters: { status: [status] } } : {}), layout: 'table' });
  const result = await ask({ text: 'görebildiğim bütün görevleri tek tabloda göster', plan: { intent: 'rota', language: 'tr', table: true, request: request(null) } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.match(result.answer.content, /^\|/u);
  assert.equal((result.answer.content.match(/\| Görev \|/gu) || []).length, 1);
  assert.doesNotMatch(result.answer.content, /tablo güvenle hazırlanamadı|satır koleksiyonu yok/u);
});

test('dönemli ekip satırına yön belirtmeden inmek seçilen kişinin iş yükünü korur', async (t) => {
  const seed = rotaToolSeed();
  seed.executiveScope = [ALI_1, ZEYNEP].map((EmployeeSicil) => ({ ManagerSicil: AYSE, EmployeeSicil }));
  seed.taskAssignees.push({ TaskId: TASKS.DUE_SOON, Sicil: ALI_1 });
  const { ask, stack } = phase4eConversation(t, { seed });
  const interval = { dateFrom: '2026-09-30', dateTo: '2026-10-31' };
  const first = await ask({ text: 'ekibimin dönemli iş yükünü tabloyla göster', plan: plan({ scope: 'team', focus: ['workload'], ...interval }, { table: true }) });
  assert.equal(first.answer.finishReason, 'stop', first.answer.content);
  const prior = stack.db.aiMessageEvidence.map((row) => JSON.parse(row.EvidenceJson)).findLast((row) => row.analysisContext)?.analysisContext;
  assert.ok(prior?.rows.length > 0);
  assert.equal(prior.rows[0].type, 'person');
  const next = await ask({ text: 'sadece ilk kişiyi göster', plan: plan({ scope: 'row', rows: [1] }) });
  assert.equal(next.answer.finishReason, 'stop', next.answer.content);
  const reads = populationReads(next.log);
  assert.ok(reads.length > 0);
  assert.ok(reads.every(({ params }) => params.personSicil === Number(prior.rows[0].id) && params.dateFrom === interval.dateFrom && params.dateTo === interval.dateTo));
  const saved = stack.db.aiMessageEvidence.map((row) => JSON.parse(row.EvidenceJson)).findLast((row) => row.analysisContext)?.analysisContext;
  assert.deepEqual(saved.focus, ['workload']);
});

test('tek kişi satırı kendimle karşılaştırmayı güncel yetki ve proje kesişimiyle başlatır ve sürdürür', async (t) => {
  const seed = rotaToolSeed();
  seed.executiveScope = [ALI_1, ZEYNEP].map((EmployeeSicil) => ({ ManagerSicil: AYSE, EmployeeSicil }));
  seed.taskAssignees.push({ TaskId: TASKS.OVERDUE, Sicil: ALI_1 });
  const { ask, stack } = phase4eConversation(t, { seed });
  const first = await ask({ text: 'Radar Modernizasyonu projesindeki ekip iş yükümü göster', plan: plan({ scope: 'team', focus: ['workload'], within: 'Radar Modernizasyonu' }, { table: true }) });
  assert.equal(first.answer.finishReason, 'stop', first.answer.content);
  const saved = () => stack.db.aiMessageEvidence.map((row) => JSON.parse(row.EvidenceJson)).findLast((row) => row.analysisContext)?.analysisContext;
  const prior = saved();
  assert.ok(prior.rows.length > 0);
  assert.equal(prior.rows[0].type, 'person');
  const selected = Number(prior.rows[0].id);
  for (const [text, analysis] of [['ilk kişiyi benimle karşılaştır', { scope: 'row', rows: [1], withSelf: true }], ['aynı karşılaştırmayı sürdür', { scope: 'previous' }]]) {
    const result = await ask({ text, plan: plan(analysis) });
    assert.equal(result.answer.finishReason, 'stop', result.answer.content);
    const reads = populationReads(result.log);
    assert.ok(reads.length >= 2);
    assert.ok(reads.some(({ params }) => params.personSicil === selected));
    assert.ok(reads.some(({ params }) => params.assigneeMode === 'me'));
    assert.ok(reads.every(({ params }) => params.projectId === PROJECTS.FULL && params.sicil === AYSE && params.isAdmin === 0 && (params.personSicil === selected || params.assigneeMode === 'me')), JSON.stringify(reads));
    assert.equal(saved().withSelf, true);
    assert.deepEqual(saved().subjects, [{ type: 'person', id: String(selected) }]);
    assert.equal(saved().within.id, PROJECTS.FULL);
    assert.match(result.answer.content, /Siz · Radar Modernizasyonu/u);
  }
});

test('kendimle karşılaştırmada proje çoklu boş ve olmayan satır veri okunmadan reddedilir', () => {
  const person = { type: 'person', id: String(ALI_1) }, other = { type: 'person', id: String(ZEYNEP) }, project = { type: 'project', id: PROJECTS.FULL };
  const cases = [
    { rows: [project], selected: [1] },
    { rows: [person, other], selected: [1, 2] },
    { rows: [null, person], selected: [1] },
    { rows: [person], selected: [2] },
    { scope: 'person', subjects: [person], rows: [project], selected: [1], rowPopulation: { scope: 'person', subjects: [person] } }
  ];
  for (const item of cases) {
    const prior = context({ scope: item.scope || 'team', subjects: item.subjects || [], focus: ['workload'], rows: item.rows, ...(item.rowPopulation ? { rowPopulation: item.rowPopulation } : {}) });
    assert.ok(prior);
    const brief = parseAnalysis({ scope: 'row', rows: item.selected, withSelf: true });
    assert.throws(() => expandAnalysis(brief, { previous: prior, today: '2026-09-30' }), (error) => error.details.some((detail) => ['$.analysis.rows:unavailable', '$.analysis.withSelf:scope'].includes(detail)));
  }
  assert.equal(normalizePendingAnalysis({ language: 'tr', scope: 'row', rows: [1], withSelf: true }).withSelf, true);
  assert.equal(normalizePendingAnalysis({ language: 'tr', scope: 'row', rows: [1, 2], withSelf: true }), null);
});

for (const [label, analysis, identity] of [
  ['kişi', { scope: 'person', names: [String(ZEYNEP)], focus: ['status'] }, ({ personSicil }) => personSicil === ZEYNEP],
  ['proje', { scope: 'project', names: ['Radar Modernizasyonu'], focus: ['status'] }, ({ projectId }) => projectId === PROJECTS.FULL]
]) test(`tüm zamanlar takibi dönemi kaldırır ve sunucunun bağlı öznesini korur: ${label}`, async (t) => {
  const { ask, stack } = phase4eConversation(t);
  const first = await ask({ text: label === 'kişi' ? `${ZEYNEP} sicilli kişinin dönem durumunu göster` : 'Radar Modernizasyonu dönem durumunu göster', plan: plan({ ...analysis, ...window }) });
  assert.equal(first.answer.finishReason, 'stop', first.answer.content);
  const result = await ask({ text: 'peki genel olarak tüm zamanlarda', plan: plan({ scope: 'previous', relativeWindow: 'all_time' }) });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  const reads = populationReads(result.log);
  assert.ok(reads.length > 0);
  assert.ok(reads.every(({ params }) => identity(params) && params.dateFrom == null && params.dateTo == null), JSON.stringify(reads));
  const saved = stack.db.aiMessageEvidence.map((row) => JSON.parse(row.EvidenceJson)).findLast((row) => row.analysisContext)?.analysisContext;
  assert.equal(saved.relativeWindow, 'all_time');
  assert.equal(saved.dateFrom, undefined);
  assert.equal(saved.dateTo, undefined);
  t.mock.timers.tick(86400000);
  const next = await ask({ text: 'aynı kapsamı biraz daha aç', plan: plan({ scope: 'previous' }) });
  assert.equal(next.answer.finishReason, 'stop', next.answer.content);
  const nextReads = populationReads(next.log);
  assert.ok(nextReads.length > 0);
  assert.ok(nextReads.every(({ params }) => identity(params) && params.dateFrom == null && params.dateTo == null));
});

test('tüm zamanlar seçimi bağıl dönemi kaldırır ve yeni mutlak sınıra eski sınır eklemez', () => {
  for (const relativeWindow of ['today', 'next_7_days']) {
    const prior = context({ dateFrom: undefined, dateTo: undefined, relativeWindow });
    assert.ok(prior);
    const resolved = resolveAnalysisBrief(parseAnalysis({ scope: 'previous', relativeWindow: 'all_time' }), { previous: prior, today: '2026-10-02' });
    assert.equal(resolved.dateFrom, undefined);
    assert.equal(resolved.dateTo, undefined);
    const requests = expandAnalysis(resolved, { previous: prior, today: '2026-10-02' });
    assert.ok(requests.length > 0);
    assert.ok(requests.every((request) => !request.filters.dateFrom && !request.filters.dateTo));
  }
  const all = context({ dateFrom: undefined, dateTo: undefined, relativeWindow: 'all_time' });
  assert.ok(all);
  const next = resolveAnalysisBrief(parseAnalysis({ scope: 'previous', dateFrom: '2026-11-01' }), { previous: all, today: '2026-10-02' });
  assert.equal(next.dateFrom, '2026-11-01');
  assert.equal(next.dateTo, undefined);
  assert.equal(next.relativeWindow, undefined);
  assert.throws(() => parseAnalysis({ scope: 'previous', relativeWindow: 'all_time', dateTo: '2026-11-01' }));
  assert.equal(normalizePendingAnalysis({ language: 'tr', scope: 'previous', relativeWindow: 'all_time', dateTo: '2026-11-01' }), null);
  assert.equal(normalizeAnalysisContext({ ...all, dateTo: '2026-11-01' }), null);
});

test('dönemi kaldıran proje açıklaması seçilince eski tarihler geri gelmez', async (t) => {
  const { ask } = phase4eConversation(t);
  const first = await ask({ text: `${ZEYNEP} sicilli kişinin dönem durumunu göster`, plan: plan({ scope: 'person', names: [String(ZEYNEP)], focus: ['status'], ...window }) });
  assert.equal(first.answer.finishReason, 'stop');
  const clarification = await ask({ text: 'tüm zamanları Proje ile daralt', plan: plan({ scope: 'previous', relativeWindow: 'all_time', within: 'Proje' }) });
  assert.equal(clarification.answer.finishReason, 'clarification', clarification.answer.content);
  const result = await ask({ text: '1' });
  assert.equal(result.inputs.length, 0);
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  const reads = populationReads(result.log);
  assert.ok(reads.length > 0);
  assert.ok(reads.every(({ params }) => params.personSicil === ZEYNEP && params.projectId && params.dateFrom == null && params.dateTo == null));
});
