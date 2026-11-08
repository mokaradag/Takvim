import assert from 'node:assert/strict';
import test from 'node:test';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';
import { analyticalFindings } from '../src/domain/ai/analyticalFindings.js';
import { normalizeAnalysisContext, normalizePendingAnalysis } from '../src/domain/ai/analysisContext.js';
import { answerQuality } from './helpers/answerQuality.mjs';

registerServerOnlyShim();
const { parseAnalysis } = await import('../src/server/ai/tools/analysisPlan.js');
const { unpackTypedPlan, typedPlanningTool, planShapeHints } = await import('../src/server/ai/tools/executionSet.js');
const TODAY = '2026-09-30';
const unpack = (plan, previousAnalysis = null) => unpackTypedPlan({ toolCalls: [{ name: 'rota_plan', arguments: JSON.stringify(plan) }] }, { today: TODAY, previousAnalysis }).plan;

test('eski bekleyen niyet yükseltilmeden önce kendi sürümünün kapalı sözleşmesiyle doğrulanır', () => {
  const pending = { language: 'tr', scope: 'self', focus: ['status'], visual: true, chart: 'bar' };
  assert.deepEqual(normalizeAnalysisContext({ v: 1, pending }).pending, normalizePendingAnalysis(pending));
  for (const change of [{ charts: ['bar', 'donut'] }, { focus: ['status', 'overdue', 'upcoming', 'priority'] },
    { scope: 'person', names: ['Ayşe'], withSelf: false }, { relativeWindow: 'today' }, { act: 'explain' }, { scope: 'previous' }]) {
    assert.equal(normalizeAnalysisContext({ v: 1, pending: { ...pending, ...change } }), null);
    assert.ok(normalizeAnalysisContext({ v: 2, pending: { ...pending, ...change } }));
  }
});

test('geçmiş görünüm gerektiren sınırlılık vakası sıradan güncel durum planıyla geçmez', async () => {
  const { plannerScore } = await import('../scripts/analysis-qualification.mjs');
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/bilgin-analysis-benchmark.json', import.meta.url), 'utf8'));
  const cases = fixture.holdout.filter((row) => row.handling === 'limitation' && row.expect.reason === 'outside_data');
  assert.ok(cases.some((row) => row.id === 'h08'));
  for (const item of cases) {
    const current = { outcome: 'planned', decisions: [], plan: { analysis: { scope: 'self', focus: ['overview'] },
      requests: [{ population: { tool: 'rota_task_analytics' }, filters: { assignee: 'me' }, entities: [], metrics: ['tasks.total'] }] } };
    assert.ok(plannerScore(current, item.expect).length, item.id);
    assert.deepEqual(plannerScore({ outcome: 'abstained', decisions: [{ intent: 'abstain', reason: 'outside_data' }] }, item.expect), [], item.id);
    assert.ok(plannerScore({ outcome: 'abstained', decisions: [{ intent: 'abstain', reason: 'write' }] }, item.expect).length, item.id);
  }
});

test('nitelendirme düzen çağrısındaki altyapı hatasını sonuçta saklar ve sonraki tura geçmez', async (t) => {
  const { conversationCase } = await import('../scripts/analysis-qualification.mjs');
  let calls = 0;
  const turn = { text: 'Görevlerimin durumunu göster', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['status'] } }, expect: { finish: 'stop' } };
  const results = await conversationCase(t, [turn, turn], { plannerModel: false, composeModel: true,
    completeRound: async () => { calls += 1; throw new Error('Sınama altyapı hatası'); } });
  assert.equal(calls, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].infrastructure, 'ADAPTER_INVOCATION_FAILED');
  assert.ok(results[0].failures.some((failure) => failure.startsWith('altyapı ')));
});

for (const shape of ['plan', 'düzen']) test(`nitelendirme ilk altyapı hatasında sonraki vakayı başlatmaz: ${shape}`, async () => {
  const { spawnSync } = await import('node:child_process');
  const url = new URL('../scripts/analysis-qualification.mjs', import.meta.url).href;
  for (const infrastructure of [true, false]) {
    const source = `import {runQualificationCases} from ${JSON.stringify(url)};
      const calls = [];
      await runQualificationCases([{id:'bir'},{id:'iki'}], async (_t,item) => {
        calls.push(item.id);
        const failed = item.id === 'bir';
        const marker = failed && ${infrastructure} ? 'MODEL_STREAM_FAILED' : null;
        return {id:item.id, failures: failed ? ['beklenen sınama hatası'] : [], ${shape === 'plan' ? 'infrastructure:marker' : 'turns:[{infrastructure:marker}]'}};
      });
      console.log('SONUC '+JSON.stringify(calls));`;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env, timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    const calls = JSON.parse(result.stdout.match(/SONUC (\[[^\n]+\])/)?.[1] || 'null');
    assert.deepEqual(calls, infrastructure ? ['bir'] : ['bir', 'iki']);
    assert.match(result.stderr, /\[bir\] FAIL/);
  }
});

test('iki grafik türü şemada, takipte ve kapalı bağlamda korunur', () => {
  assert.equal(typedPlanningTool([]).parameters.properties.charts.maxItems, 2);
  const plan = unpack({ intent: 'rota', language: 'tr', charts: ['bar', 'donut'], analysis: { scope: 'self', focus: ['status'] } });
  assert.deepEqual(plan.charts, ['bar', 'donut']);
  const context = normalizeAnalysisContext({ v: 2, scope: 'self', focus: ['status'], visual: true, chart: 'bar', charts: ['bar', 'donut'] });
  assert.deepEqual(context.charts, ['bar', 'donut']);
  assert.deepEqual(normalizePendingAnalysis({ language: 'tr', scope: 'self', focus: ['status'], visual: true, chart: 'bar', charts: ['bar', 'donut'] }).charts, ['bar', 'donut']);
  assert.deepEqual(unpack({ intent: 'rota', language: 'tr', analysis: { scope: 'previous' } }, context).charts, ['bar', 'donut']);
  assert.equal(unpack({ intent: 'rota', language: 'tr', visual: false, analysis: { scope: 'previous' } }, context).charts, undefined);
  assert.equal(normalizeAnalysisContext({ ...context, charts: ['bar', 'bar'] }), null);
  assert.equal(normalizeAnalysisContext({ ...context, v: 1 }), null, 'ikinci sürüm alanı eski sürüme sızamaz');
});

test('çoğul grafik alanının onarım ipucu dizi sözleşmesini tekil türden ayırır', async () => {
  const { analysisDetails } = await import('../src/server/ai/tools/analysisPlan.js');
  assert.match(planShapeHints(['$.charts:enum'])[0], /^charts:.*1.*2.*farklı/);
  assert.match(planShapeHints(['$.chart:enum'])[0], /^chart:/);
  assert.deepEqual(analysisDetails(['$.charts:enum']), ['$.charts:enum']);
});

test('all_time açık tarihlerle çelişirse doğrulama dönemi sessizce daraltmaz', () => {
  assert.throws(() => parseAnalysis({ scope: 'self', focus: ['status'], relativeWindow: 'all_time', dateFrom: TODAY }),
    (error) => error.details.includes('$.analysis.relativeWindow:conflict'));
});

test('özetin bildirmediği kişi ve proje aramaları kapsamı sessizce genişletemez', () => {
  for (const [analysis, call] of [
    [{ scope: 'self', focus: ['overview'] }, { name: 'rota_project_search', arguments: { text: 'Radar' } }],
    [{ scope: 'person', names: ['Ayşe Yılmaz'], focus: ['overview'] }, { name: 'rota_person_search', arguments: { text: 'Zeynep Kaya' } }]
  ]) assert.throws(() => unpack({ intent: 'rota', language: 'tr', analysis, calls: [call] }));
});

const fact = (field, value, filters, tool, extra = {}) => ({ evidenceId: 'R1', fact: { field, value,
  semantic: { complete: true, provenance: { tool, today: TODAY }, filters, ...extra } } });

test('geçmiş veya başka tarih alanıyla süzülen liste yaklaşan teslimat bulgusu üretmez', () => {
  for (const filters of [
    { dateField: 'targetFinish', dateFrom: '2026-09-01', dateTo: '2026-09-20' },
    { dateField: 'start', dateFrom: TODAY, dateTo: '2026-10-10' }
  ]) {
    const f = { statuses: ['todo', 'in_progress'], ...filters };
    const facts = [fact('totalCount', 1, f, 'rota_task_search'), fact('data.tasks.0.title', 'Eski iş', f, 'rota_task_search'),
      fact('data.tasks.0.targetFinish', '2026-09-10', f, 'rota_task_search')];
    assert.equal(analyticalFindings([{ index: 0, presentation: { facts } }]).some((item) => item.kind === 'nearestDelivery'), false);
  }
});

test('çözülememiş kişi etiketi karşılaştırmanın öznesi olamaz', () => {
  const facts = ['Seçilen kişi', 'Ayşe'].map((person, index) => ({ ...fact('data.totals.open', index + 1,
    { person, personSicil: index + 1, assignee: 'person' }, 'rota_task_analytics'), evidenceId: `R${index + 1}` }));
  assert.equal(analyticalFindings([{ index: 0, presentation: { facts } }]).some((item) => item.kind === 'subjectComparison'), false);
});

test('kalite kapısı erken sonuç başlığını, cümlesiz açılışı ve kısa yinelemeyi reddeder', () => {
  assert.equal(answerQuality('Genel durum\n\nAçıklama. 【R1】【R2】').opening, false);
  assert.equal(answerQuality('Bir değerlendirme.\n\n#### Öncelikli konular\n\n1. Bir iş. 【R1】\n\n#### Görevler\n\n| Görev |\n| --- |\n| İş | 【R2】').ending, false);
  assert.equal(answerQuality('Veri yok.\n\nVeri yok.').duplicates, 1);
});

test('aynı kanıttan istenen iki güvenli grafik her ayrıntıda birlikte çizilir ve takipte sürer', async (t) => {
  const { phase4eConversation } = await import('./helpers/phase4eScenario.mjs');
  for (const detail of ['short', 'balanced', 'detailed']) await t.test({ short: 'Kısa', balanced: 'Dengeli', detailed: 'Ayrıntılı' }[detail], async (t) => {
    const { ask } = phase4eConversation(t);
    const first = await ask({ text: 'İşlerimin durum dağılımını çubuk ve halka grafikle göster', plan: { intent: 'rota', language: 'tr',
      chart: ['bar', 'donut'], analysis: { scope: 'self', focus: ['status'] } } }, { detail });
    for (const result of [first, await ask({ text: 'Aynı analizi açıkla', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous' } } }, { detail })]) {
      assert.equal(result.answer.finishReason, 'stop', result.answer.content);
      const charts = [...result.answer.content.matchAll(/```rota-chart\n([^`]+)\n```/g)].map((match) => JSON.parse(match[1]));
      assert.deepEqual([...new Set(charts.map((item) => item.type))].sort(), ['bar', 'donut']);
      assert.ok(charts.every((item) => item.evidence.length > 0));
    }
  });
});

test('dönem baskısı yalnızca aynı özne, proje ve nüfusun bugünkü gecikmesiyle kurulur', () => {
  const population = { assignee: 'person', person: 'Ayşe', personSicil: 1, projectId: 'ortak', project: 'Ortak proje' };
  const groups = (filters) => [0, 1].flatMap((index) => ['label', 'open', 'done'].map((key) => fact(`data.groups.${index}.${key}`,
    key === 'label' ? `Proje ${index}` : key === 'open' ? 2 : 0,
    { ...filters, dateFrom: TODAY, dateTo: '2026-10-10' }, 'rota_task_analytics',
    { groupBy: 'project', group: { key: `p${index}` }, row: { identity: `p${index}`, collectionSize: 2 } })));
  const overdue = (filters) => [fact('totalCount', 1, { ...filters, deadline: 'overdue' }, 'rota_task_search'),
    fact('data.tasks.0.title', 'Eski iş', { ...filters, deadline: 'overdue' }, 'rota_task_search', { row: { projectId: 'p0' } })]
    .map((item) => ({ ...item, evidenceId: 'R2' }));
  const finding = (filters) => analyticalFindings([{ index: 0, presentation: { facts: groups(population) } },
    { index: 1, presentation: { facts: overdue(filters) } }]).find((item) => item.kind === 'windowPressure');
  assert.deepEqual(finding(population).evidenceIds, ['R1', 'R2']);
  for (const filters of [{ ...population, person: 'Başka kişi', personSicil: 2 }, { ...population, assignee: 'me' },
    { ...population, projectId: 'başka' }, { ...population, priorities: ['high'] }, { ...population, dateFrom: '2026-09-01' }]) assert.equal(finding(filters), undefined);
});

test('çakışan tarih onarımı kalan gösterimi değiştiremez; yön ve grafik kaybı da onarım sayılmaz', async (t) => {
  const { phase4eConversation, populationReads } = await import('./helpers/phase4eScenario.mjs');
  const original = { scope: 'self', focus: ['overview', 'upcoming'], relativeWindow: 'next_7_days', dateFrom: TODAY, dateTo: '2026-10-29' };
  const corrected = { scope: 'self', focus: original.focus, dateFrom: TODAY, dateTo: original.dateTo };
  const plans = [original, { ...corrected, dateTo: '2026-11-29' }, corrected];
  const { ask } = phase4eConversation(t, { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: { intent: 'rota', language: 'tr', analysis: plans.shift() } }] }) });
  const result = await ask({ text: 'İşlerimi önümüzdeki dönemde değerlendir' });
  assert.equal(result.inputs.length, 3, 'tarihi değiştiren ara onarım reddedilir');
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.ok(populationReads(result.log).some((row) => row.params.dateTo === original.dateTo));
  assert.ok(populationReads(result.log).every((row) => row.params.dateTo !== '2026-11-29'));
});

test('bütçe onarımı bildirilen yönü sessizce düşüremez', async (t) => {
  const { phase4eConversation, populationReads } = await import('./helpers/phase4eScenario.mjs');
  const analysis = { scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'], focus: ['priority', 'deadlines', 'critical'] };
  const queue = [{ intent: 'rota', language: 'tr', analysis }, { intent: 'rota', language: 'tr', analysis: { ...analysis, focus: ['priority'] } },
    { intent: 'clarify', language: 'tr', clarify: { reason: 'ambiguous', topics: ['rota_task_search', 'rota_task_analytics'] } }];
  const { ask } = phase4eConversation(t, { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: queue.shift() }] }) });
  const result = await ask({ text: 'Ayşe Yılmaz ile Zeynep Kaya kişilerini öncelik, termin ve kritik işler bakımından karşılaştır' });
  assert.equal(result.inputs.length, 1);
  assert.equal(result.answer.finishReason, 'clarification');
  assert.match(result.answer.content, /Hangi analiz yönlerine öncelik/);
  assert.equal(populationReads(result.log).length, 0);
});

test('analiz biçim onarımı ikinci grafik türünü düşüremez', async (t) => {
  const { phase4eConversation } = await import('./helpers/phase4eScenario.mjs');
  const analysis = { scope: 'self', focus: ['status'], relativeWindow: 'next_7_days', dateFrom: TODAY, dateTo: '2026-10-10' };
  const fixed = { scope: 'self', focus: ['status'], dateFrom: TODAY, dateTo: '2026-10-10' };
  const queue = [{ intent: 'rota', language: 'tr', chart: ['bar', 'donut'], analysis },
    { intent: 'rota', language: 'tr', chart: 'bar', analysis: fixed },
    { intent: 'rota', language: 'tr', chart: ['bar', 'donut'], analysis: fixed }];
  const { ask } = phase4eConversation(t, { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: queue.shift() }] }) });
  const result = await ask({ text: 'İşlerimin durumunu çubuk ve halka grafiklerle göster' });
  assert.equal(result.inputs.length, 3);
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.deepEqual(result.analysisContext.charts, ['bar', 'donut']);
});

test('nitelendirme yanlış düzeyi, özneyi, eksik yönü, grafiği ve erken sonucu başarı saymaz', async () => {
  const { benchmarkExpectation } = await import('../scripts/analysis-qualification.mjs');
  const { turnViolations } = await import('./helpers/phase4eScenario.mjs');
  const expect = benchmarkExpectation({ handling: 'full', plan: { analysis: { scope: 'team', level: 'department', focus: ['status', 'overdue'] } }, expect: { chartTypes: ['bar', 'donut'], conclusion: true } });
  const result = { answer: { finishReason: 'stop', content: 'Bir değerlendirme. 【R1】\n\n**Öncelikli konular**\n\n1. İş.\n\nSonraki gövde.' },
    log: [{ query: 'task-facts', params: { assigneeMode: 'team', teamLevel: 'UNIT' } }], analysisContext: { focus: ['status'] } };
  const violations = turnViolations(result, expect);
  for (const label of ['düzey', 'yönler', 'bar', 'donut', 'sonuç']) assert.ok(violations.some((item) => item.includes(label)), violations.join('; '));
});

test('başlık ve tablo ölçütleri kişi, proje ve satıra özgü nüfusu korur', async () => {
  const { titleCandidate } = await import('../src/domain/ai/groundedPropositions.js');
  const { narrativeGroups, renderGroupRows } = await import('../src/domain/ai/evidenceNarrative.js');
  const base = { assignee: 'person', personSicil: 1, person: 'Ayşe', projectId: 'p1', project: 'Radar', dateFrom: TODAY, dateTo: TODAY };
  const title = (filters) => titleCandidate({ tool: 'rota_task_analytics', filters, groupBy: 'project', locale: 'tr' });
  assert.match(title(base), /Radar.+Ayşe/);
  assert.notEqual(title(base), title({ ...base, person: 'Zeynep', personSicil: 2 }));
  assert.equal(title({ ...base, person: 'Seçilen kişi' }), null);
  const rows = (filters) => filters.map((filter, index) => ({ ...fact(`data.groups.${index}.count`, index + 1, filter, 'rota_task_analytics',
    { groupBy: 'project', group: { key: `p${index}`, label: `Proje ${index}` }, row: { identity: `p${index}`, collectionSize: filters.length } }), subject: `Proje ${index}` }));
  const render = (filters, locale = 'tr') => {
    const [group] = narrativeGroups(rows(filters));
    return renderGroupRows(group, 'data.groups', { locale, layout: 'table' });
  };
  assert.match(render([{ assignee: 'person', personSicil: 1, person: 'Seçilen kişi' }]), /Ölçüt:/);
  const mixed = render([{ assignee: 'me', statuses: ['todo', 'in_progress'] }, { assignee: 'me', statuses: ['todo', 'in_progress'], projectId: 'p1', project: 'Radar' }]);
  assert.match(mixed, /Radar/);
  const dated = render([{ assignee: 'me', dateFrom: TODAY, dateTo: TODAY }], 'en');
  assert.match(dated, /due on 30 September 2026/);
  assert.doesNotMatch(dated, /due between/);
});

test('sıfır toplamlar, tek İngilizce görev ve atama çekincesi kanıtın sınırında kalır', async () => {
  const { caveatPropositions } = await import('../src/domain/ai/groundedPropositions.js');
  const { narrativeGroups, renderGroupDetails, renderGroupRows } = await import('../src/domain/ai/evidenceNarrative.js');
  const totals = ['open', 'done'].map((key) => fact(`data.totals.${key}`, 0, {}, 'rota_task_analytics'));
  for (const locale of ['tr', 'en']) {
    const text = renderGroupDetails(narrativeGroups(totals)[0], { locale });
    assert.doesNotMatch(text, /bulunuyor|have tasks|has tasks/);
    assert.match(text, locale === 'en' ? /no open or completed tasks/ : /açık ya da tamamlanmış görev yok/);
    const assignment = fact('data.groups.0.count', 1, {}, 'rota_task_analytics', { groupBy: 'assignee' });
    const caveat = caveatPropositions([{ index: 0, presentation: { facts: [assignment] } }], locale)[0].proposition.markdown;
    assert.doesNotMatch(caveat, /görünmeyen|çözümlenemeyen|hidden|unresolved/);
    assert.match(caveat, locale === 'en' ? /no matching tasks/ : /eşleşen işi olmayan/);
  }
  const group = narrativeGroups([fact('data.groups.0.count', 1, {}, 'rota_task_analytics', { groupBy: 'project', group: { key: 'p1', label: 'Radar' } })])[0];
  assert.match(renderGroupRows(group, 'data.groups', { locale: 'en' }), /1\*\* task/);
  assert.doesNotMatch(renderGroupRows(group, 'data.groups', { locale: 'en' }), /1\*\* tasks/);
});

test('gelecek dönemli karşılaştırma ve ikincil yığılmış grafik sıfır gecikme sütunu okumaz', async () => {
  const { expandAnalysis } = await import('../src/server/ai/tools/analysisPlan.js');
  for (const analysis of [{ scope: 'person', names: ['Ayşe', 'Zeynep'], focus: ['projects'] }, { scope: 'all', focus: ['overview'] }]) {
    const parts = expandAnalysis({ ...analysis, dateFrom: TODAY, dateTo: '2026-10-10' }, { today: TODAY, chart: 'stacked' });
    const groups = parts.filter((part) => part.population.groupBy === 'project');
    assert.ok(groups.length);
    assert.ok(groups.every((part) => !part.metrics.includes('tasks.overdue')));
  }
});

test('kişi ile kendini karşılaştırmada ikincil zaman çizelgesi her iki öznenin tarihli satırlarını okur', async () => {
  const { expandAnalysis } = await import('../src/server/ai/tools/analysisPlan.js');
  const parts = expandAnalysis({ scope: 'person', names: ['Ayşe'], withSelf: true, focus: ['overdue'] }, { today: TODAY, chart: 'bar', charts: ['bar', 'timeline'] });
  const lists = parts.filter((part) => part.population.tool === 'rota_task_search' && part.metrics.includes('task.targetFinish'));
  assert.equal(lists.length, 2);
  assert.ok(lists.some((part) => part.entities?.some((entity) => entity.text === 'Ayşe')));
  assert.ok(lists.some((part) => part.filters.assignee === 'me'));
});

test('yeniden başlangıçtaki ilk analitik plan yalnızca bir kez ek hak alır; önceki turlar toplamdan düşer', async (t) => {
  for (const limitedBudget of [true, false]) await t.test(limitedBudget ? 'kalan çağrılar bütün plana yetmez' : 'önceki harcama toplam bütçeden düşer', async (t) => {
    const { createAiStack } = await import('./helpers/aiStack.mjs');
    const { AYSE, NOW, PROJECTS, TASKS, rotaToolSeed } = await import('./helpers/aiToolFixtures.mjs');
    const { runGroundedTurn } = await import('../src/server/ai/assistant/groundedAnswer.js');
    const { buildGroundedContext } = await import('../src/server/ai/assistant/groundedPrompt.js');
    const { createToolTurnContext } = await import('../src/server/ai/tools/toolContext.js');
    const { toolCatalogForModel } = await import('../src/server/ai/tools/toolRegistry.js');
    const { TOOL_LIMITS } = await import('../src/server/ai/tools/toolLimits.js');
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const seed = rotaToolSeed();
    const template = seed.tasks.find((task) => task.TaskId === TASKS.OVERDUE);
    // Tekil gecikmeler sıralama başını doğrulanabilir kılar; bütçe sınaması eşitlik çözümü nedeniyle durmamalı.
    seed.tasks = Array.from({ length: 180 }, (_, index) => ({ ...template, TaskId: `20000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
      TargetFinish: new Date(Date.parse(`${TODAY}T00:00:00Z`) - (index + 1) * 86400000).toISOString().slice(0, 10) }));
    createAiStack(t, { sicil: AYSE, seed });
    const toolPlan = (plan) => ({ text: '', toolCalls: [{ id: 'p1', name: 'rota_plan', arguments: JSON.stringify(plan) }], finishReason: 'tool_calls' });
    const request = { operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks' }, entities: [{ type: 'project', id: PROJECTS.FULL }] };
    let rounds = 0;
    const options = { messages: buildGroundedContext({ userContent: `Bütün görevler ${PROJECTS.FULL}`, now: NOW }).messages,
      catalog: toolCatalogForModel(), context: createToolTurnContext({ sicil: AYSE, now: NOW }), limits: { ...TOOL_LIMITS, maxRepairRounds: 0 }, onText: async () => {} };
    const initial = await runGroundedTurn({ signal: new AbortController().signal, round: async () => ++rounds === 1
      ? toolPlan({ intent: 'rota', language: 'tr', request, calls: [{ name: 'rota_task_search', arguments: { projectId: PROJECTS.FULL, limit: 1 } }] })
      : { text: JSON.stringify({ kind: 'rota', facts: ['R1:data.tasks.*.title'] }), toolCalls: [], finishReason: 'stop' } }, { ...options, escalation: true });
    assert.equal(initial.outcome, 'escalate');
    assert.equal(initial.kind, 'plan');
    if (limitedBudget) {
      initial.resume.limits = { ...initial.resume.limits, maxTotalCalls: 3 };
      const limited = await runGroundedTurn({ signal: new AbortController().signal, round: async () => toolPlan({ intent: 'rota', language: 'tr',
        analysis: { scope: 'all', focus: ['status', 'overdue', 'workload', 'upcoming'] } }) }, { ...options, resume: initial.resume });
      assert.equal(limited.finishReason, 'clarification', limited.text);
      assert.match(limited.text, /Hangi analiz yönlerine öncelik/);
      assert.equal(initial.resume.executor.stats().attempted, 0, 'üç çağrı kalmışken dört bölümlü planın ilk okuması bile başlamaz');
      return;
    }
    const result = await runGroundedTurn({ signal: new AbortController().signal, round: async () => toolPlan({ intent: 'rota', language: 'tr',
      analysis: { scope: 'all', focus: ['status', 'overdue', 'workload', 'upcoming'] } }) }, { ...options, resume: initial.resume });
    assert.ok(result.stats.toolRounds > TOOL_LIMITS.maxToolRounds, 'dört bölümün okuması önceki temel sınırda kesilemez');
    assert.equal(initial.resume.toolRoundBudget, 8);
    assert.equal(initial.resume.analyticalRoundsGranted, true);
    assert.ok(result.stats.toolRounds <= 8, `yeniden başlangıç toplam ${result.stats.toolRounds} tur tüketti`);
    assert.ok(initial.resume.toolRounds <= 8 - initial.resume.priorToolRounds, 'önceki harcama yeni planın kalan hakkından düşer');
    assert.ok(result.stats.attempted <= TOOL_LIMITS.maxTotalCalls);
    assert.equal(result.finishReason, 'stop', result.text);
    assert.equal(result.evidenceRows.length, 4);
    assert.deepEqual(result.evidenceRows.map((row) => row.toolName), ['rota_task_analytics', 'rota_task_search', 'rota_workload_summary', 'rota_task_search']);
  });
});

test('aynı adlı iki projenin ayrı tabloları aynı ölçüt metnini kaybetmez', async () => {
  const { buildComposition, defaultComposition, renderComposition } = await import('../src/domain/ai/groundedComposition.js');
  const parts = ['p1', 'p2'].map((projectId, index) => ({ index, presentation: { layout: 'table', facts: [0, 1].map((row) => ({
    ...fact(`data.groups.${row}.count`, row + 1, { projectId, project: 'Radar' }, 'rota_task_analytics', {
      metric: 'tasks.total', groupBy: 'priority', group: { key: row ? 'high' : 'low', label: row ? 'Yüksek' : 'Düşük' },
      row: { identity: String(row), collectionSize: 2 }
    }), evidenceId: `R${index + 1}`
  })) } }));
  const composition = buildComposition({ parts });
  assert.ok(composition);
  const layout = defaultComposition(composition);
  assert.ok(layout?.ok);
  const text = renderComposition(composition, layout).text;
  assert.equal((text.match(/_Ölçüt: Proje: Radar_/g) || []).length, 2, text);
});
