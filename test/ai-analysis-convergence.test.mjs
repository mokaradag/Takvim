import assert from 'node:assert/strict';
import test from 'node:test';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';
import { analyticalFindings, synthesisNarrative } from '../src/domain/ai/analyticalFindings.js';
import { answerQuality } from './helpers/answerQuality.mjs';
import { unsupportedNumbers } from './helpers/numericGrounding.mjs';
registerServerOnlyShim();
const { typedPlanningTool, unpackTypedPlan } = await import('../src/server/ai/tools/executionSet.js');
const { expandAnalysis, parseAnalysis } = await import('../src/server/ai/tools/analysisPlan.js');
const TODAY = '2026-09-30';
const unpack = (plan, previousAnalysis = null, onDecoded = () => {}) => unpackTypedPlan({ toolCalls: [{ name: 'rota_plan', arguments: JSON.stringify(plan) }] }, { today: TODAY, previousAnalysis, onDecoded }).plan;
const expand = (analysis, options = {}) => expandAnalysis(parseAnalysis(analysis), { today: TODAY, ...options });
const part = (facts, index = 0) => ({ index, presentation: { facts } });
const total = (id, personSicil, metric, value, extra = {}) => ({ evidenceId: id, fact: { field: `data.totals.${metric}`, value, semantic: {
  complete: true, provenance: { tool: 'rota_task_analytics', today: TODAY }, filters: { assignee: 'person', personSicil, person: `Kişi ${personSicil}`, ...extra }
} } });

test('planlayıcı sözleşmesindeki yönler (Aşama G: en çok 6) kabulden yürütme isteklerine eksiksiz ulaşır', () => {
  const schema = typedPlanningTool([]).parameters.properties.analysis;
  assert.equal(schema.properties.focus.maxItems, 6);
  const analysis = { scope: 'all', focus: ['status', 'overdue', 'workload', 'upcoming'] };
  const plan = unpack({ intent: 'rota', language: 'tr', analysis });
  assert.equal([plan.request, ...plan.additionalRequests].length, 4);
});

test('birincil türü yineleyen takip ikinci grafiği korur; yeni tür ve açık ret devralmayı sonlandırır', () => {
  const previous = { v: 2, scope: 'self', subjects: [], rows: [], focus: ['status'], visual: true, chart: 'bar', charts: ['bar', 'donut'] };
  const follow = (extra) => unpack({ intent: 'rota', language: 'tr', analysis: { scope: 'previous' }, ...extra }, previous);
  assert.deepEqual(follow({ chart: 'bar' }).charts, ['bar', 'donut']);
  assert.equal(follow({ chart: 'line' }).charts, undefined);
  assert.equal(follow({ visual: false }).charts, undefined);
});

test('grafik dizisi reddedilmeden analiz onarım için sabitlenir', () => {
  const analysis = { scope: 'self', focus: ['status'], dateFrom: TODAY, dateTo: '2026-10-13' };
  let decoded;
  assert.throws(() => unpack({ intent: 'rota', language: 'tr', charts: ['pie'], analysis }, null, (plan) => { decoded = plan; }));
  assert.deepEqual(decoded?.analysis, analysis);
});

test('gelecek dönem zaman çizelgesi dönem dışı gecikme listesiyle karşılanmaz', () => {
  const parts = expand({ scope: 'self', focus: ['status', 'overdue'], dateFrom: TODAY, dateTo: '2026-10-13' }, { chart: 'timeline' });
  assert.ok(parts.some((p) => p.population.tool === 'rota_task_search' && p.filters.dateFrom === TODAY && p.filters.dateTo === '2026-10-13' && p.rank.metric === 'task.targetFinish'));
});

test('zaman çizelgesi için iki adlı öznenin tarihli görevleri birlikte okunur', () => {
  const parts = expand({ scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'], focus: ['upcoming'], dateFrom: TODAY, dateTo: '2026-10-13' }, { chart: 'timeline' });
  const dated = parts.filter((p) => p.population.tool === 'rota_task_search');
  assert.deepEqual(dated.map((p) => p.entities[0].text), ['Ayşe Yılmaz', 'Zeynep Kaya']);
  for (const request of dated) {
    assert.deepEqual([request.filters.dateFrom, request.filters.dateTo], [TODAY, '2026-10-13']);
    assert.deepEqual([request.rank.metric, request.rank.order], ['task.targetFinish', 'asc']);
    assert.ok(request.metrics.includes('task.targetFinish'));
  }
});

test('birleşebilen beş etkin yön dört fiziksel okuma bütçesinde kalır', () => {
  const parts = expand({ scope: 'person', names: ['Ayşe Yılmaz'], focus: ['overview', 'workload', 'overdue', 'priority'], dateFrom: TODAY, dateTo: '2026-10-13' });
  const totals = parts.find((p) => p.operation === 'value');
  assert.ok(['tasks.total', 'tasks.open', 'tasks.done', 'tasks.overdue', 'tasks.dueNext7Days', 'tasks.completionRatePercent'].every((metric) => totals.metrics.includes(metric)));
  assert.equal(parts.length, 4);
  assert.ok(parts.some((p) => p.filters.deadline === 'overdue'));
  assert.ok(parts.some((p) => p.population.groupBy === 'priority'));
});

test('gelecekteki kendi iş yükü tablosunda yapısal sıfır gecikme sütunu bulunmaz', () => {
  const parts = expand({ scope: 'self', focus: ['workload'], dateFrom: TODAY, dateTo: '2026-10-13' });
  assert.ok(!parts.find((p) => p.population.groupBy === 'project').metrics.includes('tasks.overdue'));
});

test('aynı iki kişinin farklı proje nüfuslarındaki ölçüleri birleşmez', () => {
  const facts = [total('R1', 1, 'overdue', 4, { projectId: 'a', project: 'Alfa' }), total('R2', 2, 'overdue', 1, { projectId: 'a', project: 'Alfa' }),
    total('R3', 1, 'open', 8, { projectId: 'b', project: 'Beta' }), total('R4', 2, 'open', 2, { projectId: 'b', project: 'Beta' })];
  const findings = analyticalFindings([part(facts)]).filter((f) => f.kind === 'subjectComparison');
  assert.equal(findings.length, 2);
  for (const f of findings) assert.equal(Object.keys(f.metrics).length, 1);
});

test('aynı dönem ve açık durum nüfusu karşılaştırılır; farklı dönem reddedilir', () => {
  const window = { dateFrom: TODAY, dateTo: '2026-10-13', statuses: ['todo', 'in_progress'], dateField: 'targetFinish' };
  const compare = (other) => analyticalFindings([part([total('R1', 1, 'total', 8, window), total('R2', 2, 'total', 3, other)])]).filter((f) => f.kind === 'subjectComparison');
  const [finding] = compare({ ...window, statuses: [...window.statuses].reverse() });
  assert.deepEqual(finding?.metrics.total, [8, 3]);
  assert.match(synthesisNarrative([finding]).intro.markdown, /13 Ekim 2026/);
  assert.equal(compare({ ...window, dateTo: '2026-10-14' }).length, 0);
});

test('karşılaştırmanın öncelikleri ilk bölüm yerine her öznenin kendi kapsamıyla sunulur', () => {
  const findings = [2, 45].map((days, index) => ({ kind: 'longestOverdue', entity: { name: `İş ${index}` }, metrics: { days },
    filters: { assignee: index ? 'me' : 'person', person: index ? undefined : 'Ayşe Yılmaz', personSicil: index ? undefined : 1 }, evidenceIds: [`R${index + 1}`] }));
  const text = synthesisNarrative(findings).conclusion.markdown;
  const lines = text.split('\n').filter((line) => /^\d+\. /.test(line));
  // Aşama G: sahip kapsamı doğal yer adıyla ("Kendi işlerinizde:"), adlı kişi kendi adıyla söylenir.
  assert.match(lines[0], /^1\. Kendi işlerinizde: \*\*İş 1\*\*/);
  assert.match(lines[1], /^2\. \*\*Ayşe Yılmaz\*\*: \*\*İş 0\*\*/);
});

test('kalite ve sayısal dayanak kapıları ilgisiz kapanış ve birleşik sayıları kabul etmez', () => {
  assert.equal(answerQuality('Açılış cümlesi.\n\nBu sayı yeterli.').ending, false);
  assert.equal(answerQuality('Opening.\n\n**Key point:** Verified result. 【R1】\n\n_Note: Access scope._').ending, true);
  assert.deepEqual(unsupportedNumbers('-3 ve 3,5', [3, 5]), ['-3', '3,5']);
});

const tableFacts = (rows, filters = {}, evidenceId = 'R1') => rows.flatMap(([name, open, overdue, soon, code], index) => Object.entries({ name, 'tasks.open': open, 'tasks.overdue': overdue, 'tasks.dueNext7Days': soon }).map(([key, value]) => ({ evidenceId,
  fact: { field: `data.projects.${index}.${key}`, value, semantic: { complete: true, provenance: { tool: 'rota_portfolio_summary', today: TODAY }, filters,
    row: { identity: `p${index + 1}`, collectionSize: rows.length, projectCode: code } } } })));

test('tek eşzamanlı baskı gerçek dikkat lideri yoksa korunur; adaş projeler kodla ayrılır', () => {
  const rows = [['Ortak', 5, 3, 1, 'ORT-A'], ['Ortak', 8, 0, 3, 'ORT-B']];
  const findings = analyticalFindings([part(tableFacts(rows, { dateFrom: '2026-09-01', dateTo: '2026-09-29' }))]);
  const both = findings.find((f) => f.kind === 'simultaneousPressure');
  assert.deepEqual(both.names, ['ORT-A · Ortak']);
  assert.equal(findings.some((f) => f.kind === 'attentionLeader'), false);
  assert.match(synthesisNarrative(findings).intro.markdown, /1 Eylül 2026/);
  const uncoded = analyticalFindings([part(tableFacts(rows.map((row) => row.slice(0, 4))))]);
  assert.equal(uncoded.some((f) => f.kind === 'overdueConcentration'), false);
});

test('farklı öznenin tablo yoğunlaşması bağımsız liste yoğunlaşmasını bastırmaz', () => {
  const filters = { assignee: 'me', deadline: 'overdue', statuses: [] };
  const rows = [['Birinci', 5, 'Ortak', 'p1', 'ORT-A'], ['İkinci', 3, 'Ortak', 'p1', 'ORT-A'], ['Üçüncü', 1, 'Ortak', 'p2', 'ORT-B'], ['Dördüncü', 1, 'Diğer', 'p3', 'DIG']];
  const facts = [{ evidenceId: 'R2', fact: { field: 'totalCount', value: 4, semantic: { complete: true, provenance: { tool: 'rota_task_search', today: TODAY }, filters } } },
    ...rows.flatMap(([title, days, project, projectId, projectCode], index) => Object.entries({ title, overdueDays: days, 'project.name': project }).map(([key, value]) => ({ evidenceId: 'R2', fact: { field: `data.tasks.${index}.${key}`, value,
      semantic: { complete: true, provenance: { tool: 'rota_task_search', today: TODAY }, filters, row: { projectId, projectCode, collectionSize: rows.length } } } })))];
  const findings = analyticalFindings([part(tableFacts([['Alfa', 9, 4, 3], ['Beta', 3, 1, 1]], { assignee: 'person', personSicil: 1, person: 'Ayşe' })), part(facts, 1)]);
  const list = findings.find((f) => f.kind === 'overdueProjectShare');
  assert.deepEqual(list.metrics, { overdue: 2, total: 4, share: 50 });
  // Aşama G: giriş asıl yanıt, diğer bölümler arası bulgular analiz paragrafıdır; ikisi birlikte bütün bulguları taşır.
  const narrative = synthesisNarrative(findings).intro;
  const intro = [narrative.plain, narrative.insights?.plain].filter(Boolean).join(' ');
  assert.match(intro, /ORT-A · Ortak/);
  assert.match(intro, /Kendi işlerinize bakıldığında/);
});

test('çözülemeyen kişi analist öznesi olmaz ve adaş projeler tek özne sayılmaz', async () => {
  const { analystPropositions, singleSubjectPropositions } = await import('../src/domain/ai/groundedPropositions.js');
  const facts = [total('R1', 1, 'open', 10), total('R1', 1, 'overdue', 4)].map((item) => ({ ...item, fact: { ...item.fact,
    semantic: { ...item.fact.semantic, metric: `tasks.${item.fact.field.split('.').at(-1)}`, filters: { assignee: 'person', personSicil: 1, person: 'Seçilen kişi', projectId: 'p1', project: 'Proje' } } } }));
  assert.deepEqual(analystPropositions([part(facts)]), []);
  const conclusions = [{ bare: { markdown: 'Çıplak' }, proposition: { markdown: 'Etiketli' } }];
  const projects = ['p1', 'p2'].map((projectId, index) => part([total(`R${index + 1}`, undefined, 'open', 1, { assignee: 'any', person: null, projectId, project: 'Ortak' })], index));
  assert.equal(singleSubjectPropositions(conclusions, projects)[0].proposition.markdown, 'Etiketli');
});

test('gövdenin sayıları söylemesi anlatılmamış yüzdeyi sonuçtan düşürmez', async () => {
  const { buildComposition, defaultComposition, renderComposition } = await import('../src/domain/ai/groundedComposition.js');
  const facts = Object.entries({ total: 20, open: 10, overdue: 4, done: 10, completionRatePercent: 60 }).map(([key, value]) => {
    const item = total('R1', 1, key, value);
    item.fact.semantic.metric = `tasks.${key}`;
    return item;
  });
  const composition = buildComposition({ parts: [part(facts)], analyst: true, detail: 'balanced', outline: { scope: 'person', focus: ['overview'] } });
  const result = renderComposition(composition, defaultComposition(composition));
  assert.match(result.text, /%40/);
});

test('takip eylemleri ve proje daraltması kanıtlı açılış ve uygun kapanışla sunulur', async (t) => {
  const { phase4eConversation } = await import('./helpers/phase4eScenario.mjs');
  const { ask } = phase4eConversation(t);
  const initial = await ask({ text: 'Radar Modernizasyonu projesindeki işlerimin durum dağılımı', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', within: 'Radar Modernizasyonu', focus: ['status'] } } });
  assert.match(initial.answer.content.split('\n\n')[0], /Radar Modernizasyonu/);
  for (const act of ['certainty', 'expand', 'summarize']) {
    const result = await ask({ text: 'Önceki değerlendirmeyi sürdür', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous', act } } });
    assert.equal(result.answer.finishReason, 'stop', result.answer.content);
    assert.ok(answerQuality(result.answer.content).opening, result.answer.content);
    assert.ok(answerQuality(result.answer.content).ending, result.answer.content);
  }
});

test('kişiyle kendini karşılaştırma açılışı iki kişiyi kapsar ve çizgi uyarısı kapanıştan önce gelir', async (t) => {
  const { phase4eConversation } = await import('./helpers/phase4eScenario.mjs');
  const { rotaToolSeed } = await import('./helpers/aiToolFixtures.mjs');
  const seed = rotaToolSeed();
  // Tek ayın dağılımı çizgi için yeterli değildir; durum dağılımları geçerli kalır.
  for (const task of seed.tasks) task.TargetFinish = TODAY;
  const { ask } = phase4eConversation(t, { seed });
  const result = await ask({ text: 'Zeynep Kaya ile kendimin durum dağılımını halka ve çizgi grafikle karşılaştır', plan: { intent: 'rota', language: 'tr', chart: 'donut', charts: ['donut', 'line'], analysis: { scope: 'person', names: ['Zeynep Kaya'], withSelf: true, focus: ['status'] } } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.match(result.answer.content.split('\n\n')[0], /iki kişinin işleri/);
  assert.ok(answerQuality(result.answer.content).ending, result.answer.content);
  assert.match(result.answer.content, /[Çç]izgi/);
});

test('karşılaştırma çubuğu ilk kişinin proje grafiğinden önce seçilir', async (t) => {
  const { phase4eConversation, renderedCharts } = await import('./helpers/phase4eScenario.mjs');
  const { ask } = phase4eConversation(t);
  const result = await ask({ text: 'Ayşe Yılmaz ile Zeynep Kaya için önce projeleri sonra iş yükünü çubuk grafikle karşılaştır', plan: { intent: 'rota', language: 'tr', chart: 'bar', analysis: { scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'], focus: ['projects', 'workload'] } } });
  const charts = renderedCharts(result.answer.content);
  assert.ok(charts.length, result.answer.content);
  assert.deepEqual(charts[0].items.map((item) => item.label), ['Ayşe Yılmaz', 'Zeynep Kaya']);
});

test('çıplak tür metni veya bozuk grafik çiti grafik türü kapısını geçemez', async () => {
  const { renderedCharts, turnViolations } = await import('./helpers/phase4eScenario.mjs');
  for (const content of ['{"type":"bar"}', '```rota-chart\n{"type":"bar"}\n```']) {
    assert.deepEqual(renderedCharts(content), []);
    assert.ok(turnViolations({ answer: { content }, log: [] }, { chartTypes: ['bar'] }).includes('bar grafiği yok'));
  }
});

test('İngilizce karma sıfır kategoriler fiillerini korur', async () => {
  const { narrativeGroups, renderGroupDetails } = await import('../src/domain/ai/evidenceNarrative.js');
  const facts = Object.entries({ total: 5, open: 5, done: 0, dueNext7Days: 0 }).map(([key, value]) => total('R1', 1, key, value));
  const text = renderGroupDetails(narrativeGroups(facts)[0], { locale: 'en' });
  assert.match(text, /none are completed or are due/);
});

test('noktalı virgüllü proje adı tek görev anlatımında bölünmez', async (t) => {
  const { phase4eConversation } = await import('./helpers/phase4eScenario.mjs');
  const { rotaToolSeed, TASKS, PROJECTS } = await import('./helpers/aiToolFixtures.mjs');
  const seed = rotaToolSeed();
  seed.tasks = seed.tasks.filter((task) => task.TaskId === TASKS.OVERDUE);
  seed.projects.find((project) => project.ProjectId === PROJECTS.FULL).ProjectName = 'Finance; Phase 2';
  const { ask } = phase4eConversation(t, { seed });
  const result = await ask({ text: 'Geciken işlerimi göster', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overdue'] } } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.match(result.answer.content, /Finance; Phase 2/);
  assert.doesNotMatch(result.answer.content, /\*\*Finance\*\*/);
});

test('çoğul proje yazımı eşdeğer ad çözümünü reddetmez; ek çağrı yasağı şemada görünür', () => {
  const plan = unpack({ intent: 'rota', language: 'tr', analysis: { scope: 'projects', names: ['Radar Modernizasyonu'], focus: ['status'] },
    calls: [{ name: 'rota_project_search', arguments: { text: 'Radar Modernizasyonu' } }] });
  assert.equal(plan.analysis.scope, 'project');
  assert.match(typedPlanningTool([]).parameters.properties.additionalRequests.description, /calls verilmez/);
});

test('kendiyle kıyas puanı yalnızca açıkça beklenen kişi ve kendi kapsamını kabul eder', async () => {
  const { plannerScore } = await import('../scripts/analysis-qualification.mjs');
  const requests = [{ filters: {}, entities: [{ type: 'person', query: 'Ayşe' }] }, { filters: { assignee: 'me' }, entities: [] }];
  const result = { outcome: 'planned', decisions: [], plan: { analysis: { withSelf: true, focus: ['workload'] }, requests } };
  assert.deepEqual(plannerScore(result, { intent: 'rota', scope: 'person', withSelf: true }), []);
  assert.ok(plannerScore(result, { intent: 'rota', scope: 'person' }).length);
  assert.ok(plannerScore({ ...result, plan: { ...result.plan, requests: [requests[0]] } }, { intent: 'rota', scope: 'person', withSelf: true }).length);
  assert.ok(plannerScore({ ...result, plan: { ...result.plan, requests: [requests[0]], analysis: { focus: ['workload'] } } }, { intent: 'rota', scope: 'person', withSelf: true }).length);
});

test('kıyas beklentisi tabloyu ve ayrıntı ayarını gerçek düzen sayfasında denetler', async () => {
  const { benchmarkExpectation } = await import('../scripts/analysis-qualification.mjs');
  const { turnViolations } = await import('./helpers/phase4eScenario.mjs');
  const expect = benchmarkExpectation({ handling: 'full', plan: { table: true }, expect: { detail: 'detailed' } });
  assert.equal(expect.table, true);
  const violations = turnViolations({ answer: { content: 'Yanıt.', finishReason: 'stop' }, log: [{ query: 'task-facts', params: {} }], compositionViews: [{ detail: 'balanced' }] }, expect);
  assert.ok(violations.includes('istenen tablo yok'));
  assert.ok(violations.includes('yanıt ayrıntısı beklenenle aynı değil'));
});

test('aynı kaynağın çubuk ve çizgi rehberi ilk çizilen türü anlatır; kısa dökümün anlatımı kaybolmaz', async (t) => {
  const { createAiStack } = await import('./helpers/aiStack.mjs');
  const { AYSE, NOW, callRotaTool, rotaToolSeed } = await import('./helpers/aiToolFixtures.mjs');
  const { verifyRequested } = await import('./helpers/requestScenario.mjs');
  const { buildComposition, validateComposition, renderComposition } = await import('../src/domain/ai/groundedComposition.js');
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const stack = createAiStack(t, { sicil: AYSE, seed: rotaToolSeed() });
  for (const groupBy of ['target_month', 'status']) {
    const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_analytics', { assignee: 'me', groupBy });
    const verdict = verifyRequested(ledger, ['data.groups.*.count'], { operation: 'list', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy }, filters: { assignee: 'me' } });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
    const c = buildComposition({ parts: [{ index: 0, presentation: verdict.presentation }], detail: 'short', visual: true,
      chartType: 'bar', chartTypes: groupBy === 'target_month' ? ['bar', 'line'] : ['bar', 'donut'] });
    const source = [...c.render.charts.values()].find((chart) => chart.types.includes(groupBy === 'target_month' ? 'line' : 'donut'));
    const breakdown = [...c.render.propositions.values()].find((p) => p.kind === 'breakdown');
    assert.ok(source && breakdown);
    const blocks = [{ type: 'say', items: [breakdown.id, ...(groupBy === 'target_month' ? [source.id] : [])] },
      ...[...c.render.tables.keys()].map((id) => ({ type: 'rows', source: id, style: 'table' })),
      { type: 'chart', source: source.id, style: 'bar' },
      { type: 'chart', source: source.id, style: groupBy === 'target_month' ? 'line' : 'donut' }];
    if (groupBy === 'status') {
      const defaultStyle = validateComposition(c, { blocks: [...blocks.slice(0, -2),
        { type: 'chart', source: source.id, style: 'donut' }, { type: 'chart', source: source.id }] });
      assert.equal(defaultStyle.ok, true, JSON.stringify(defaultStyle.issues));
      assert.deepEqual(defaultStyle.blocks.filter((block) => block.type === 'chart').map((block) => block.style), ['donut', 'bar']);
    }
    const validated = validateComposition(c, { blocks });
    assert.equal(validated.ok, true, JSON.stringify(validated.issues));
    const result = renderComposition(c, validated);
    assert.ok(result.said >= 1, result.text);
    if (groupBy === 'target_month') {
      assert.match(result.text, /Değerleri aşağıdaki grafikte karşılaştırabilirsiniz/);
      assert.doesNotMatch(result.text, /Zaman içindeki değişimi aşağıdaki/);
    }
  }
});

test('düzen kurulamadığında istenen her grafik türü ayrı bildirilir', async () => {
  const { presentVerdict } = await import('../src/server/ai/assistant/groundedAnswer.js');
  const turn = { presentationIntent: { visual: true, chart: 'bar', charts: ['bar', 'line'] }, locale: 'tr',
    session: { signal: new AbortController().signal }, ledger: { revoked: () => false }, partCount: 1, answers: [], trace: {} };
  const verdict = { kind: 'grounded', normalized: 'Kanıtlı yanıt.', citedIds: ['R1'] };
  const rendered = await presentVerdict(turn, verdict, false);
  assert.match(rendered.normalized, /[Çç]ubuk/);
  assert.match(rendered.normalized, /[Çç]izgi/);
});

test('gelecek dönem çizelgesinin gerçek çiziminde geçmiş terminler bulunmaz', async (t) => {
  const { phase4eConversation, renderedCharts } = await import('./helpers/phase4eScenario.mjs');
  const { rotaToolSeed, TASKS, AYSE, PROJECTS } = await import('./helpers/aiToolFixtures.mjs');
  const seed = rotaToolSeed();
  const template = seed.tasks.find((task) => task.TaskId === TASKS.OVERDUE);
  for (const [index, TargetFinish] of ['2026-10-02', '2026-10-03'].entries()) {
    const TaskId = `20000000-0000-4000-8000-00000000090${index}`;
    seed.tasks.push({ ...template, TaskId, TargetFinish, ProjectId: PROJECTS.FULL, Title: `Gelecek iş ${index}` });
    seed.taskAssignees.push({ TaskId, Sicil: AYSE });
  }
  const { ask } = phase4eConversation(t, { seed });
  const result = await ask({ text: 'Önümüzdeki iki haftanın durumunu ve mevcut gecikmeleri değerlendir; gelecek işleri zaman çizelgesinde göster', plan: {
    intent: 'rota', language: 'tr', chart: 'timeline', analysis: { scope: 'self', focus: ['status', 'overdue'], dateFrom: TODAY, dateTo: '2026-10-13' }
  } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  const timeline = renderedCharts(result.answer.content).find((chart) => chart.type === 'timeline');
  assert.ok(timeline, result.answer.content);
  assert.ok(timeline.items.every((item) => item.date >= TODAY && item.date <= '2026-10-13'), JSON.stringify(timeline));
});

test('eşit karşılaştırma ve açık sınırlılık nitelendirmesi doğru sonucu tanır', async () => {
  const { turnViolations } = await import('./helpers/phase4eScenario.mjs');
  const { benchmarkExpectation } = await import('../scripts/analysis-qualification.mjs');
  const content = synthesisNarrative(analyticalFindings([part([total('R1', 1, 'open', 3), total('R2', 2, 'open', 3)])])).intro.markdown;
  assert.deepEqual(turnViolations({ answer: { content }, log: [] }, { findings: ['subjectComparison'] }), []);
  const expect = benchmarkExpectation({ handling: 'limitation', expect: {} });
  assert.deepEqual(turnViolations({ answer: { content: 'Desteklenmiyor.', finishReason: 'unsupported' }, log: [] }, expect), []);
  assert.ok(turnViolations({ answer: { content: 'Güncel durum.', finishReason: 'stop' }, log: [{ query: 'task-facts', params: {} }] }, expect).length >= 2);
});

test('kesik ama doğrulanmış gecikme sıralaması zaman çizelgesi olarak çizilebilir', async (t) => {
  const { phase4eConversation, renderedCharts } = await import('./helpers/phase4eScenario.mjs');
  const { rotaToolSeed, TASKS, AYSE } = await import('./helpers/aiToolFixtures.mjs');
  const seed = rotaToolSeed();
  const template = seed.tasks.find((task) => task.TaskId === TASKS.OVERDUE);
  seed.tasks = Array.from({ length: 30 }, (_, index) => ({ ...template, Title: `Geciken iş ${index}`, TaskId: `20000000-0000-4000-8000-${String(index + 500).padStart(12, '0')}`,
    TargetFinish: new Date(Date.parse(`${TODAY}T00:00:00Z`) - (index + 1) * 86400000).toISOString().slice(0, 10) }));
  seed.taskAssignees = seed.tasks.map((task) => ({ TaskId: task.TaskId, Sicil: AYSE }));
  const { ask } = phase4eConversation(t, { seed });
  const result = await ask({ text: 'Gecikmelerimi zaman çizelgesinde göster', plan: { intent: 'rota', language: 'tr', chart: 'timeline', analysis: { scope: 'self', focus: ['overdue'] } } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  const timeline = renderedCharts(result.answer.content).find((chart) => chart.type === 'timeline');
  assert.ok(timeline, result.answer.content);
  assert.equal(timeline.items.length, 8);
  assert.match(timeline.title, /En erken 8 termin/);
});

test('eksik varlık adı kodla gerçek ada dönüşmez; bitiş penceresi termin karşılaştırması sayılmaz', () => {
  assert.deepEqual(analyticalFindings([part(tableFacts([[null, 8, 4, 2, 'A'], [null, 3, 1, 1, 'B']]))]), []);
  const filters = { dateFrom: TODAY, dateTo: '2026-10-13', dateField: 'actualFinish', statuses: ['todo', 'in_progress'] };
  assert.deepEqual(analyticalFindings([part([total('R1', 1, 'total', 4, filters), total('R2', 2, 'total', 2, filters)])]), []);
});

test('grafik kapısı istemcinin uzun ve tildeli çitlerini, JSON içindeki ters tırnağı kabul eder', async () => {
  const { renderedCharts } = await import('./helpers/phase4eScenario.mjs');
  const { answerChartFence } = await import('../src/domain/ai/answerChart.js');
  const fence = answerChartFence({ version: 1, type: 'bar', locale: 'tr', title: 'Kıyas `A`', unit: 'count', evidence: ['R1'], items: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] });
  assert.ok(fence);
  for (const content of [fence, fence.replaceAll('```', '````'), fence.replaceAll('```', '~~~')]) assert.equal(renderedCharts(content)[0]?.title, 'Kıyas `A`');
});

test('eşdeğer tekil ve çoğul grafik yazımı analiz onarımını engellemez', async (t) => {
  const { phase4eConversation } = await import('./helpers/phase4eScenario.mjs');
  const fixed = { scope: 'self', focus: ['status'], dateFrom: TODAY, dateTo: '2026-10-13' };
  const queue = [{ intent: 'rota', language: 'tr', chart: ['bar', 'donut'], analysis: { ...fixed, relativeWindow: 'next_7_days' } },
    { intent: 'rota', language: 'tr', charts: ['bar', 'donut'], analysis: fixed }];
  const { ask } = phase4eConversation(t, { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: queue.shift() }] }) });
  const result = await ask({ text: 'İşlerimin durumunu çubuk ve halka grafikle göster' });
  assert.equal(result.inputs.length, 2);
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
});

test('yeni ekip analizi önceki bölüm düzeyini devralmaz', async (t) => {
  const { phase4eConversation, populationReads } = await import('./helpers/phase4eScenario.mjs');
  const { analysisBenchmarkSeed, BENCH_PROFILES } = await import('./helpers/analysisBenchmarkSeed.mjs');
  const { NOW } = await import('./helpers/aiToolFixtures.mjs');
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = analysisBenchmarkSeed();
  t.mock.timers.reset();
  const { ask } = phase4eConversation(t, { seed, sicil: BENCH_PROFILES.B });
  const first = await ask({ text: 'Bölümümün durum dağılımı', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'team', level: 'department', focus: ['status'] } } });
  assert.equal(first.analysisContext.level, 'department');
  const next = await ask({ text: 'Ekibimin durum dağılımı', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'team', focus: ['status'] } } });
  assert.equal(next.answer.finishReason, 'stop', next.answer.content);
  assert.match(next.answer.content.split('\n\n')[0], /ekibinizin işleri/);
  assert.doesNotMatch(next.answer.content.split('\n\n')[0], /bölümünüzün/);
  const reads = populationReads(next.log);
  assert.ok(reads.length);
  assert.ok(reads.every(({ params }) => params.assigneeMode === 'team' && params.teamLevel === ''));
});

test('proje satırı takibi üst nüfusu ve tek proje sınırlamasını korur', async (t) => {
  const { phase4eConversation } = await import('./helpers/phase4eScenario.mjs');
  const { ask } = phase4eConversation(t);
  const first = await ask({ text: 'İşlerimin projelere dağılımı', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['projects'] } } });
  assert.ok(first.analysisContext.rows.length);
  const next = await ask({ text: 'İlk projenin durum dağılımı', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'row', rows: [1], focus: ['status'] } } });
  assert.equal(next.answer.finishReason, 'stop', next.answer.content);
  const opening = next.answer.content.split('\n\n')[0];
  assert.match(opening, /kendi işleriniz/);
  assert.equal(opening.match(/· proje:/g)?.length, 1);
  const reads = next.log.filter((row) => row.query === 'task-facts');
  assert.ok(reads.length && reads.every((row) => row.params.assigneeMode === 'me' && row.params.projectId));
});

test('türü belirtilmeyen çizilemez grafik notu da kapanıştan önce gelir', async (t) => {
  const { phase4eConversation } = await import('./helpers/phase4eScenario.mjs');
  const { rotaToolSeed, TASKS } = await import('./helpers/aiToolFixtures.mjs');
  const seed = rotaToolSeed();
  seed.tasks = seed.tasks.filter((task) => task.TaskId === TASKS.OVERDUE);
  const { ask } = phase4eConversation(t, { seed });
  const result = await ask({ text: 'İşlerimin durumunu grafikle göster', plan: { intent: 'rota', language: 'tr', visual: true, analysis: { scope: 'self', focus: ['status'] } } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.match(result.answer.content, /güvenle grafik çizilemedi/);
  assert.equal(answerQuality(result.answer.content).ending, true, result.answer.content);
});


test('açık tek öğeli grafik listesi önceki ikinci türü devralmaz', () => {
  const previous = { v: 2, scope: 'self', subjects: [], rows: [], focus: ['status'], visual: true, chart: 'bar', charts: ['bar', 'donut'] };
  const plan = unpack({ intent: 'rota', language: 'tr', charts: ['bar'], analysis: { scope: 'previous' } }, previous);
  assert.equal(plan.chart, 'bar');
  assert.equal(plan.charts, undefined);
});

test('kodsuz adaş proje toplamlarından belirsiz karşılaştırma kurulmaz ve iki proje tek sayılmaz', async () => {
  const { buildComposition } = await import('../src/domain/ai/groundedComposition.js');
  const facts = [1, 2].map((id) => total(`R${id}`, null, 'open', id * 3, { assignee: 'any', person: null, projectId: `p${id}`, project: 'Ortak' }));
  assert.equal(analyticalFindings([part(facts)]).some((finding) => finding.kind === 'subjectComparison'), false);
  const composition = buildComposition({ parts: [part(facts)], analyst: true, outline: { scope: 'project', focus: ['workload'] } });
  assert.match(composition.render.framing.plain, /iki projedeki işler/);
});

test('durum yönü yalnızca bağlamda yazılıysa ya da kanıtı gövdeden eksikse kıyas geçmez', async () => {
  const { turnViolations } = await import('./helpers/phase4eScenario.mjs');
  const result = { answer: { content: 'Genel görünüm.' }, log: [], analysisContext: { focus: ['status'] }, evidence: [] };
  assert.ok(turnViolations(result, { focus: ['status'] }).includes('durum grubu kanıtı yok'));
  result.evidence = [{ evidenceId: 'R1', tool: 'rota_task_analytics', data: { groupBy: 'status', groups: [{ label: 'Yapılacak', count: 38 }] } }];
  assert.ok(turnViolations(result, { focus: ['status'] }).includes('durum dağılımı yanıtta eksik'));
  result.answer.content = '- **Yapılacak** — **38** görev 【R1】';
  assert.deepEqual(turnViolations(result, { focus: ['status'] }), []);
});

test('iki öznenin gecikme zaman çizelgesi yaklaşan işleri okumaz', () => {
  for (const scope of ['person', 'project']) {
    const parts = expand({ scope, names: ['Birinci', 'İkinci'], focus: ['overdue'] }, { chart: 'timeline' });
    const tasks = parts.filter((request) => request.population.tool === 'rota_task_search');
    assert.equal(tasks.length, 2);
    assert.deepEqual(tasks.map((request) => request.entities[0].text), ['Birinci', 'İkinci']);
    for (const request of tasks) {
      assert.equal(request.filters.deadline, 'overdue');
      assert.deepEqual([request.rank.metric, request.rank.order], ['task.overdueDays', 'desc']);
      assert.ok(request.metrics.includes('task.targetFinish'));
    }
  }
});

test('bağıl gelecek dönemin zaman çizelgesi mevcut gecikmeleri çizmez ve bağlam bağıl kalır', async (t) => {
  const { phase4eConversation, renderedCharts } = await import('./helpers/phase4eScenario.mjs');
  const { rotaToolSeed, TASKS, AYSE, PROJECTS } = await import('./helpers/aiToolFixtures.mjs');
  const seed = rotaToolSeed();
  const template = seed.tasks.find((task) => task.TaskId === TASKS.OVERDUE);
  for (const [index, TargetFinish] of ['2026-10-02', '2026-10-03'].entries()) {
    const TaskId = `20000000-0000-4000-8000-00000000090${index}`;
    seed.tasks.push({ ...template, TaskId, TargetFinish, ProjectId: PROJECTS.FULL, Title: `Bağıl gelecek iş ${index}` });
    seed.taskAssignees.push({ TaskId, Sicil: AYSE });
  }
  const { ask } = phase4eConversation(t, { seed });
  const result = await ask({ text: 'Önümüzdeki yedi günün durumu ve mevcut gecikmeler; gelecek işleri zaman çizelgesinde göster', plan: {
    intent: 'rota', language: 'tr', chart: 'timeline', analysis: { scope: 'self', focus: ['status', 'overdue'], relativeWindow: 'next_7_days' }
  } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  const timeline = renderedCharts(result.answer.content).find((chart) => chart.type === 'timeline');
  assert.ok(timeline, result.answer.content);
  assert.ok(timeline.items.every((item) => item.date >= TODAY && item.date <= '2026-10-06'), JSON.stringify(timeline));
  assert.equal(result.analysisContext.relativeWindow, 'next_7_days');
  assert.equal(result.analysisContext.dateFrom, undefined);
  assert.equal(result.analysisContext.dateTo, undefined);
});

test('kişi ve kendi yaklaşan iş kıyası zaman çizelgesi eklenince kesin toplamlarını korur', () => {
  const parts = expand({ scope: 'person', names: ['Ayşe Yılmaz'], withSelf: true, focus: ['upcoming'] }, { chart: 'timeline' });
  const totals = parts.filter((request) => request.operation === 'value');
  assert.equal(totals.length, 2);
  assert.ok(totals.every((request) => request.metrics.includes('tasks.dueNext7Days')));
  assert.equal(parts.filter((request) => request.population.tool === 'rota_task_search').length, 2);
  assert.equal(parts.length, 4);
});

test('kritik iş karşılaştırmasının ek zaman çizelgesi aynı öncelik ve açık durum nüfusunu okur', () => {
  for (const scope of ['person', 'project']) {
    const parts = expand({ scope, names: ['Birinci', 'İkinci'], focus: ['critical'] }, { chart: 'timeline' });
    const tasks = parts.filter((request) => request.population.tool === 'rota_task_search');
    assert.equal(tasks.length, 2);
    for (const request of tasks) {
      assert.deepEqual(request.filters.priority, ['critical', 'high']);
      assert.deepEqual(request.filters.status, ['todo', 'in_progress']);
      assert.equal(request.filters.deadline, undefined);
    }
  }
});

test('kritik açık toplamlar yalnızca eşit öncelik ve durum nüfusuyla karşılaştırılır', () => {
  const filters = { statuses: ['todo', 'in_progress'], priorities: ['critical', 'high'] };
  const compare = (other) => analyticalFindings([part([total('R1', 1, 'total', 2, filters), total('R2', 2, 'total', 15, other)])]).filter((finding) => finding.kind === 'subjectComparison');
  const [finding] = compare({ statuses: [...filters.statuses].reverse(), priorities: [...filters.priorities].reverse() });
  assert.deepEqual(finding?.metrics.critical, [2, 15]);
  assert.match(synthesisNarrative([finding]).intro.plain, /kritik veya yüksek öncelikli açık görev/);
  assert.deepEqual(compare({ ...filters, priorities: ['high'] }), []);
  assert.deepEqual(compare({ ...filters, statuses: ['done'] }), []);
  assert.deepEqual(compare({ ...filters, priorities: ['critical', 'high'], createdByMe: true }), []);
});

test('aynı adlı farklı siciller belirsiz karşılaştırma ve grafik üretmez', async () => {
  const { buildComposition } = await import('../src/domain/ai/groundedComposition.js');
  const facts = [1, 2].map((sicil) => total(`R${sicil}`, sicil, 'overdue', sicil * 7, { person: 'Ali Yılmaz' }));
  assert.equal(analyticalFindings([part(facts)]).some((finding) => finding.kind === 'subjectComparison'), false);
  const composition = buildComposition({ parts: [part(facts)], analyst: true, visual: true, chartType: 'bar' });
  assert.ok(![...composition.render.charts.values()].some((chart) => chart.comparison));
});

test('gecikme payı ve görev önceliği kişi proje tarih ve öncelik kısıtını sonuçta korur', async () => {
  const { findingScope } = await import('../src/domain/ai/analyticalFindings.js');
  const filters = { projectId: 'p1', project: 'Alfa', dateFrom: '2026-09-01', dateTo: '2026-09-29' };
  const [share] = analyticalFindings([part([total('R1', 1, 'open', 10, filters), total('R1', 1, 'overdue', 4, filters)])]);
  assert.deepEqual(share.filters, { assignee: 'person', personSicil: 1, person: 'Kişi 1', ...filters });
  assert.equal(share.today, TODAY);
  assert.match(synthesisNarrative([share]).conclusion.plain, /Kişi 1 · Alfa · 1 Eylül 2026 – 29 Eylül 2026/);
  assert.equal(findingScope({ kind: 'longestOverdue', filters: { projectId: 'p1', project: 'Alfa' } }), 'Alfa');
  assert.match(findingScope({ kind: 'nearestDelivery', filters: { priorities: ['critical', 'high'] } }), /kritik, yüksek/);
});

test('dağılımlar aday bütçesini doldursa da karşılaştırma ve ölçü adı korunur', async () => {
  const { buildComposition, preferredChart, COMPOSITION_LIMITS } = await import('../src/domain/ai/groundedComposition.js');
  const rows = [['Alfa', 9, 4, 3], ['Beta', 3, 1, 1]];
  const groups = [1, 2].map((sicil, index) => part(tableFacts(rows, { assignee: 'person', personSicil: sicil, person: `Kişi ${sicil}` }, `R${sicil}`), index));
  const project = 'Uzun proje '.repeat(10);
  const totals = part([total('R3', 1, 'open', 8, { projectId: 'p3', project }), total('R4', 2, 'open', 2, { projectId: 'p3', project })], 2);
  const composition = buildComposition({ parts: [...groups, totals], analyst: true, visual: true });
  const selected = composition.render.charts.get(preferredChart(composition.render).id);
  assert.equal(selected.comparison, true);
  assert.ok(selected.title.startsWith('Açık görev · '), selected.title);
  assert.ok(selected.title.includes('Uzun proje'));
  assert.ok(composition.render.charts.size <= COMPOSITION_LIMITS.maxCharts);
});

for (const composition of [true, false]) for (const detail of ['short', 'balanced', 'detailed']) test(`iki kişinin gecikme zaman çizelgesi her iki yetkili nüfusu da gösterir: ${composition ? 'model' : 'sunucu'}, ${{ short: 'kısa', balanced: 'dengeli', detailed: 'ayrıntılı' }[detail]}`, async (t) => {
  const { phase4eConversation, renderedCharts } = await import('./helpers/phase4eScenario.mjs');
  const { rotaToolSeed, TASKS, AYSE, ZEYNEP } = await import('./helpers/aiToolFixtures.mjs');
  const seed = rotaToolSeed();
  const template = seed.tasks.find((task) => task.TaskId === TASKS.OVERDUE);
  seed.tasks = Array.from({ length: 4 }, (_, index) => ({ ...template, TaskId: `20000000-0000-4000-8000-${String(index + 700).padStart(12, '0')}`,
    Title: `Kıyas görevi ${index}`, TargetFinish: `2026-09-${String(20 + index).padStart(2, '0')}` }));
  seed.taskAssignees = seed.tasks.map((task, index) => ({ TaskId: task.TaskId, Sicil: index < 2 ? AYSE : ZEYNEP }));
  const { ask } = phase4eConversation(t, { seed, composition });
  const result = await ask({ text: 'Ayşe Yılmaz ile Zeynep Kaya gecikmelerini zaman çizelgesiyle karşılaştır', plan: { intent: 'rota', language: 'tr', chart: 'timeline', analysis: { scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'], focus: ['overdue'] } } }, { detail });
  const charts = renderedCharts(result.answer.content).filter((chart) => chart.type === 'timeline');
  assert.equal(charts.length, 2, result.answer.content);
  assert.deepEqual(new Set(charts.flatMap((chart) => chart.items.map((item) => item.label))), new Set(seed.tasks.map((task) => task.Title)));
  assert.ok(charts.every((chart) => chart.evidence.length && chart.items.length === 2));
  for (const chart of charts) {
    const evidence = result.evidence.find((row) => chart.evidence.includes(row.evidenceId) && row.tool === 'rota_task_search');
    const sicil = evidence?.data.filters.personSicil;
    assert.ok([AYSE, ZEYNEP].includes(sicil));
    const expected = seed.tasks.filter((task) => seed.taskAssignees.some((assignment) => assignment.TaskId === task.TaskId && assignment.Sicil === sicil));
    assert.deepEqual(chart.items.map((item) => item.label).sort(), expected.map((task) => task.Title).sort());
  }
  assert.doesNotMatch(result.answer.content, /zaman çizelgesi gösterilmedi/);
});

test('tarih biçimli kanıt etiketleri birebir kabul edilir; yeni tarih ve sayılar reddedilir', () => {
  for (const [locale, label, other] of [['tr', '1 Ekim 2026', '1 Kasım 2026'], ['en', '1 October 2026', '1 November 2026'], ['tr', '2026-10-01', '2026-11-01']]) {
    assert.deepEqual(unsupportedNumbers(`**${label}** 【R1】`, [label], locale), []);
    assert.ok(unsupportedNumbers(other, [label], locale).length);
    assert.deepEqual(unsupportedNumbers(`${label}: 999 görev`, [label], locale), ['999']);
  }
});

test('kilometre taşı dışlaması farklı nüfusları karşılaştırılabilir yapmaz', () => {
  for (const milestone of [false, true]) {
    const facts = [total('R1', 1, 'open', 8, { milestone }), total('R2', 2, 'open', 2)];
    assert.equal(analyticalFindings([part(facts)]).some((item) => item.kind === 'subjectComparison'), false);
  }
  const facts = [total('R1', 1, 'open', 8, { createdByMe: false }), total('R2', 2, 'open', 2, { milestone: null })];
  assert.ok(analyticalFindings([part(facts)]).some((item) => item.kind === 'subjectComparison'));
});

for (const locale of ['tr', 'en']) test(`durum nitelendirmesi büyük sayıları yanıtın diliyle doğrular: ${locale}`, async () => {
  const { turnViolations } = await import('./helpers/phase4eScenario.mjs');
  const label = locale === 'en' ? 'To do' : 'Yapılacak';
  const formatted = locale === 'en' ? '1,234,567' : '1.234.567';
  const wrong = locale === 'en' ? '1.234.567' : '1,234,567';
  const result = { locale, log: [], analysisContext: { focus: ['status'] }, evidence: [{ evidenceId: 'R1', tool: 'rota_task_analytics', data: { groupBy: 'status', groups: [{ label, count: 1234567 }] } }], answer: {} };
  for (const table of [false, true]) {
    const render = (count) => table ? `| Grup | Kayıt sayısı |\n| --- | ---: |\n| ${label} | ${count} |\n\n_Kaynak:_ 【R1】` : `- ${label} — ${count} ${locale === 'en' ? 'tasks' : 'görev'} 【R1】`;
    result.answer.content = render(formatted);
    assert.deepEqual(turnViolations(result, { focus: ['status'] }), []);
    result.answer.content = render(wrong);
    assert.ok(turnViolations(result, { focus: ['status'] }).includes('durum dağılımı yanıtta eksik'));
  }
});

for (const composition of [true, false]) test(`İngilizce durum yanıtının dili nitelendirmeye taşınır: ${composition ? 'model' : 'sunucu'}`, async (t) => {
  const { phase4eConversation, turnViolations } = await import('./helpers/phase4eScenario.mjs');
  const { rotaToolSeed, TASKS, AYSE } = await import('./helpers/aiToolFixtures.mjs');
  const seed = rotaToolSeed();
  const template = seed.tasks.find((task) => task.TaskId === TASKS.OVERDUE);
  seed.tasks = Array.from({ length: 1201 }, (_, index) => ({ ...template, TaskId: `20000000-0000-4000-8000-${String(index + 2000).padStart(12, '0')}`,
    Title: `Durum görevi ${index}`, Status: index === 1200 ? 'done' : 'todo' }));
  seed.taskAssignees = seed.tasks.map((task) => ({ TaskId: task.TaskId, Sicil: AYSE }));
  const { ask } = phase4eConversation(t, { seed, composition });
  const result = await ask({ text: 'Show the status of my tasks', plan: { intent: 'rota', language: 'en', analysis: { scope: 'self', focus: ['status'] } } });
  assert.equal(result.locale, 'en');
  assert.match(result.answer.content, /1,200/);
  assert.deepEqual(turnViolations(result, { focus: ['status'], finish: 'stop' }), [], result.answer.content);
});

for (const charts of [['bar', 'pie'], JSON.stringify(['bar', 'pie'])]) test(`birincil alanı olmayan grafik listesinin onarımı geçerli ilk türü korur: ${Array.isArray(charts) ? 'dizi' : 'JSON metni'}`, async (t) => {
  const { phase4eConversation, renderedCharts } = await import('./helpers/phase4eScenario.mjs');
  const analysis = { scope: 'self', focus: ['status'] };
  const queue = [{ intent: 'rota', language: 'tr', charts, analysis }, { intent: 'rota', language: 'tr', charts: ['bar', 'donut'], analysis }];
  const { ask } = phase4eConversation(t, { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: queue.shift() }] }) });
  const result = await ask({ text: 'görev durumumu çubuk ve halka grafikle göster' });
  assert.equal(result.inputs.length, 2);
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.deepEqual(new Set(renderedCharts(result.answer.content).map((chart) => chart.type)), new Set(['bar', 'donut']));
  assert.deepEqual(result.analysisContext.charts, ['bar', 'donut']);
});

for (const change of [{ chart: 'line', charts: ['line', 'donut'] }, { analysis: { scope: 'all', focus: ['status'] } }]) test(`grafik listesi onarımı geçerli türü veya kapsamı değiştiremez: ${change.chart ? 'tür' : 'kapsam'}`, async (t) => {
  const { phase4eConversation } = await import('./helpers/phase4eScenario.mjs');
  const analysis = { scope: 'self', focus: ['status'] };
  const queue = [{ intent: 'rota', language: 'tr', charts: ['bar', 'pie'], analysis }, { intent: 'rota', language: 'tr', charts: ['bar', 'donut'], analysis, ...change }, { intent: 'clarify', language: 'tr', clarify: { reason: 'ambiguous' } }];
  const { ask } = phase4eConversation(t, { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: queue.shift() }] }) });
  const result = await ask({ text: 'görev durumumu çubuk ve halka grafikle göster' });
  assert.equal(result.inputs.length, 3);
  assert.equal(result.answer.finishReason, 'clarification');
  assert.deepEqual(result.log, []);
});

test('durum tablosundan türetilebilir olması söylenmemiş tamamlanma oranını düşürmez', async (t) => {
  const { phase4eConversation } = await import('./helpers/phase4eScenario.mjs');
  const { rotaToolSeed, TASKS, AYSE } = await import('./helpers/aiToolFixtures.mjs');
  const seed = rotaToolSeed();
  const template = seed.tasks.find((task) => task.TaskId === TASKS.OVERDUE);
  seed.tasks = Array.from({ length: 10 }, (_, index) => ({ ...template, TaskId: `20000000-0000-4000-8000-${String(index + 800).padStart(12, '0')}`,
    Title: `Durum görevi ${index}`, Status: index < 5 ? 'todo' : index < 8 ? 'in_progress' : 'done' }));
  seed.taskAssignees = seed.tasks.map((task) => ({ TaskId: task.TaskId, Sicil: AYSE }));
  const { ask } = phase4eConversation(t, { seed });
  const result = await ask({ text: 'Tamamlanma oranımı ve durum tablosunu göster', plan: { intent: 'rota', language: 'tr', table: true, analysis: { scope: 'self', focus: ['overview', 'status'] } } }, { detail: 'short' });
  assert.match(result.answer.content, /%20/, result.answer.content);
});

test('nitelendirme boş ve biçimlenmiş durumu kabul eder; yüzdeyi görev sayısı yerine geçirmez', async () => {
  const { turnViolations } = await import('./helpers/phase4eScenario.mjs');
  const result = { answer: { content: '- Yapılacak — 99 görev (%5) 【R1】' }, log: [], analysisContext: { focus: ['status'] }, evidence: [{ evidenceId: 'R1', tool: 'rota_task_analytics', data: { groupBy: 'status', groups: [{ label: 'Yapılacak', count: 5 }] } }] };
  assert.ok(turnViolations(result, { focus: ['status'] }).includes('durum dağılımı yanıtta eksik'));
  result.evidence[0].data.groups[0].count = 1200;
  result.answer.content = '- Yapılacak — 1.200 görev 【R1】';
  assert.deepEqual(turnViolations(result, { focus: ['status'] }), []);
  result.answer.content = '| Grup | Kayıt sayısı |\n| --- | ---: |\n| Yapılacak | 1.200 |\n\n_Kaynak:_ 【R1】';
  assert.deepEqual(turnViolations(result, { focus: ['status'] }), []);
  result.evidence[0].data.groups = [];
  result.answer.content = 'Göreviniz yok. 【R1】';
  assert.deepEqual(turnViolations(result, { focus: ['status'] }), []);
  result.answer.content = 'Genel görünüm. 【R1】';
  assert.ok(turnViolations(result, { focus: ['status'] }).includes('durum dağılımı yanıtta eksik'));
});

test('nitelendirme tüm kapsamı daraltan okumayı ve eksik kanıtlı önceliği reddeder', async () => {
  const { turnViolations } = await import('./helpers/phase4eScenario.mjs');
  const result = { answer: { content: 'Açılış.\n\nBelirli bir kişinin işlerini ayrıntılı görmek isterseniz adını yazmanız yeterli.' }, log: [{ query: 'task-facts', params: { assigneeMode: 'me' } }], analysisContext: { scope: 'all' } };
  const problems = turnViolations(result, { scope: 'all', priorities: 3 });
  assert.ok(problems.includes('tüm kapsam okumada daraltıldı'));
  assert.ok(problems.includes('istenen kanıtlı öncelik sayısı eksik'));
  result.log[0].params = { assigneeMode: 'any' };
  assert.deepEqual(turnViolations(result, { scope: 'all' }), []);
});

test('kalite kapısı numaralı yinelemeyi ve yanlış ayı doğru sayılardan ayırt eder', () => {
  assert.equal(answerQuality('Açılış.\n\n**Öncelikli konular**\n\n1. Aynı gerekçe. 【R1】\n2. Aynı gerekçe. 【R2】').duplicates, 1);
  assert.deepEqual(unsupportedNumbers('1 Kasım 2026', ['2026-10-01']), ['1 Kasım 2026']);
  assert.deepEqual(unsupportedNumbers('1 October 2026', ['2026-10-01'], 'en'), []);
  assert.deepEqual(unsupportedNumbers('1 November 2026', ['2026-10-01'], 'en'), ['1 November 2026']);
});

test('iki haftalık ayrık vaka gecikme ve yaklaşan teslimat okumalarını ayrı gerektirir', async () => {
  const { plannerScore } = await import('../scripts/analysis-qualification.mjs');
  const expect = { intent: 'rota', overdueUnwindowed: true, upcomingWindow: ['2026-09-30', '2026-10-13'] };
  const overdue = { population: { tool: 'rota_task_search' }, filters: { deadline: 'overdue' }, entities: [] };
  const upcoming = { population: { tool: 'rota_task_search' }, filters: { status: ['todo', 'in_progress'], dateFrom: TODAY, dateTo: '2026-10-13' }, entities: [] };
  const score = (requests) => plannerScore({ outcome: 'planned', decisions: [], plan: { requests } }, expect);
  assert.ok(score([overdue]).includes('yaklaşan teslimat ufku okunmadı'));
  assert.ok(score([upcoming]).includes('mevcut gecikme ayrı okunmadı'));
  assert.deepEqual(score([overdue, upcoming]), []);
  assert.ok(score([overdue, { ...upcoming, filters: { ...upcoming.filters, dateTo: '2026-10-06' } }]).length);
});
