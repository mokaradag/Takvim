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

test('planlayıcı sözleşmesindeki dört yön kabulden yürütme isteklerine eksiksiz ulaşır', () => {
  const schema = typedPlanningTool([]).parameters.properties.analysis;
  assert.equal(schema.properties.focus.maxItems, 4);
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
  const parts = expand({ scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'], focus: ['upcoming'] }, { chart: 'timeline' });
  const dated = parts.filter((p) => p.population.tool === 'rota_task_search');
  assert.deepEqual(dated.map((p) => p.entities[0].text), ['Ayşe Yılmaz', 'Zeynep Kaya']);
});

test('birleşebilen beş etkin yön dört fiziksel okuma bütçesinde kalır', () => {
  const parts = expand({ scope: 'person', names: ['Ayşe Yılmaz'], focus: ['overview', 'workload', 'overdue', 'priority'], dateFrom: TODAY, dateTo: '2026-10-13' });
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
  assert.match(text, /İş 1/);
  assert.match(text, /45/);
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
  const intro = synthesisNarrative(findings).intro.plain;
  assert.match(intro, /ORT-A · Ortak/);
  assert.match(intro, /kendi işleriniz/);
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
