/**
 * Rota AI · Aşama 4E — doğal analist, güvenilir planlama, kapsam bilinçli analiz ve zengin sunum (deterministik, Tier A).
 *
 * Model belirteci harcamadan sınanır: 150+ doğal dil sorusunun altın planı ilk bildirimde sunucu doğrulamasından geçer ve
 * doğru kapsamı (kendi, kişi, ekip/birim/bölüm, proje, portföy) taşır; analitik özetin her kapsam × yön açılımı geçerlidir;
 * ekip kapsamı yetki bağlamından gelir ve yetkisiz kullanıcıda kapalı ret verir; takip zincirleri sunucunun kanonik analiz
 * bağlamıyla kapsamı korur, daraltır, değiştirir ve genişletmeyi yeniden yetkilendirir; açık görselleştirme isteği geçerli
 * aday varken grafiği garanti eder; görselleştirme dilbilgisi kapalıdır; yanıt ayrıntısı sunum sözleşmesini değiştirir.
 * Gerçek "bu hafta işlerim açısından durumumu değerlendir" (REQUEST_DECLARATION) ve "görevlerimin dağılımını grafik olarak
 * göster" (POINTER_TARGET) hataları burada yeniden üretilip kapatılır.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AYSE, LEAD, MEHMET, PROJECTS, TASKS, ZEYNEP, callRotaTool, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { phase4eConversation, populationReads, turnViolations } from './helpers/phase4eScenario.mjs';
import { findElement, mountComponent } from './helpers/clientComponentHarness.mjs';
import { systemText } from './helpers/evidenceScenario.mjs';
import { captureConsole, createAiStack } from './helpers/aiStack.mjs';
import { composer, coveringBlocks } from './helpers/compositionScenario.mjs';

const { unpackTypedPlan, typedPlanningTool } = await import('../src/server/ai/tools/executionSet.js');
const { parseRequestDeclaration } = await import('../src/server/ai/tools/requestDeclaration.js');
const { completeRequest } = await import('../src/server/ai/tools/requestPopulation.js');
const { expandAnalysis, effectiveFocus, parseAnalysis, analysisDetails, analysisHints, analysisSuggestion, ANALYSIS_FOCUS, ANALYSIS_SCOPES } = await import('../src/server/ai/tools/analysisPlan.js');
const { containmentText, createToolScope } = await import('../src/server/ai/tools/toolScope.js');
const { decodeAuthorizationPopulation } = await import('../src/server/ai/tools/evidenceAuthorization.js');
const { toolCatalogForModel } = await import('../src/server/ai/tools/toolRegistry.js');
const { normalizeAnalysisContext, analysisContextSummary } = await import('../src/domain/ai/analysisContext.js');
const { normalizeAnswerChart, answerChartText, answerChartFence } = await import('../src/domain/ai/answerChart.js');
const { analystPropositions, fluentParagraph, pointerSentence } = await import('../src/domain/ai/groundedPropositions.js');
const { buildComposition, defaultComposition, ensureChart, validateComposition, renderComposition } = await import('../src/domain/ai/groundedComposition.js');
const { ANSWER_DETAILS, ANSWER_DETAIL_CONTRACT, normalizeAnswerDetail } = await import('../src/domain/ai/answerDetail.js');
const { AnswerChart } = await import('../src/features/ai/assistant/AnswerChart.jsx');

const corpus = JSON.parse(readFileSync(new URL('./fixtures/ai-phase4e-corpus.json', import.meta.url), 'utf8'));
const followups = JSON.parse(readFileSync(new URL('./fixtures/ai-phase4e-followups.json', import.meta.url), 'utf8'));
const planCall = (plan) => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plan }] });
const planResult = (plan) => ({ text: '', toolCalls: [{ id: 'p1', name: 'rota_plan', arguments: JSON.stringify(plan) }] });

/**
 * Kabul edilen isteklerden kapsam (sunucunun gözünden): sorumlu koşulu, adlı varlıklar ve nüfus aracı. HER istek sınıflanır:
 * bir bölüm kapsamını kaybedip genişlerse sonuç karışıktır ve sınama düşer. Portföy kapsamında süzgeçsiz görev okuması
 * görünür projelerin görevleridir (portföyün nüfusu); portföy olarak sayılır.
 */
function scopeOf(requests) {
  const one = (request) => {
    if (request.filters?.assignee === 'me') return 'self';
    if (request.filters?.assignee === 'team') return 'team';
    if (request.entities.some((entity) => entity.type === 'person')) return 'person';
    if (request.entities.some((entity) => entity.type === 'project')) return 'project';
    if (request.population?.tool === 'rota_portfolio_summary') return 'projects';
    return 'all';
  };
  const scopes = new Set(requests.map(one));
  if (scopes.has('projects') && [...scopes].every((scope) => ['projects', 'all'].includes(scope))) return 'projects';
  return scopes.size === 1 ? [...scopes][0] : `mixed:${[...scopes].join(',')}`;
}

/** Altın planın sunucu kabulü: plan biçimi, analitik açılım, her bölümün bildirimi ve nüfus tamamlaması (veri okunmaz). */
function acceptPlan(text, plan, today = corpus.today) {
  const scope = createToolScope({ today, userText: text });
  const unpacked = unpackTypedPlan(planResult(plan));
  if (unpacked.plan.intent !== 'rota') return { unpacked, requests: [] };
  const raws = [unpacked.plan.request, ...(unpacked.plan.additionalRequests || [])];
  const requests = raws.map((raw, index) => {
    const parsed = parseRequestDeclaration(raw, { textTrusted: scope.textTrusted, identityTrusted: scope.identityTrusted, referent: scope.referent, today, priorParts: index });
    const completed = completeRequest(parsed, [], { today });
    assert.deepEqual(completed.problems, [], `${text}: ${JSON.stringify(completed.hints)}`);
    return completed.request;
  });
  return { unpacked, requests };
}

/* ── Tier A: doğal dil kıyas kümesi ─────────────────────────────────── */

test('Aşama 4E kıyas kümesi 150+ doğal soruyu ve bütün kapsam ailelerini kapsar', () => {
  assert.ok(corpus.cases.length >= 150, String(corpus.cases.length));
  assert.equal(new Set(corpus.cases.map((item) => item.id)).size, corpus.cases.length);
  const families = new Set(corpus.cases.map((item) => item.expect.scope).filter(Boolean));
  for (const scope of ['self', 'team', 'person', 'project', 'projects', 'all']) assert.ok(families.has(scope), scope);
  assert.ok(corpus.cases.some((item) => item.expect.level === 'department'));
  assert.ok(corpus.cases.some((item) => item.expect.visual === true));
  const tierB = corpus.cases.filter((item) => item.tierB);
  assert.ok(tierB.length >= 40 && tierB.length <= 50, String(tierB.length));
  // Zorunlu açık uçlu sorular canlı kapıdadır.
  for (const text of ['bu hafta işlerim açısından durumumu değerlendir', 'ekibimin bu haftaki durumunu değerlendir', 'PAYKDM projesinin genel durumunu değerlendir',
    'görevlerimin dağılımını grafik olarak göster', 'ekibimin iş yükünü grafik olarak göster']) {
    assert.ok(tierB.some((item) => item.text === text), text);
  }
});

test('sınama yardımcıları boş geçmez: genişleyen tek bölüm, süzülmüş veri okuması ve karışık kapsam yakalanır', () => {
  const read = (params) => ({ query: 'task-facts', params: { taskIds: '', ...params } });
  const answer = { finishReason: 'stop', content: '' };
  assert.deepEqual(turnViolations({ answer, log: [read({ assigneeMode: 'team' }), read({ assigneeMode: 'team', withAssignees: 1 })] }, { assignee: 'team' }), []);
  assert.deepEqual(turnViolations({ answer, log: [read({ assigneeMode: 'team' }), read({ assigneeMode: 'any' })] }, { assignee: 'team' }), ['assignee team her okumada değil']);
  assert.deepEqual(turnViolations({ answer, log: [read({ projectId: 'p' }), read({})] }, { project: true }), ['proje kapsamı her okumada değil']);
  assert.deepEqual(turnViolations({ answer: { finishReason: 'clarification', content: '' }, log: [read({ taskIds: 't1' })] }, { noData: true }), ['veri okundu: task-facts']);
  assert.deepEqual(turnViolations({ answer: { finishReason: 'clarification', content: '' }, log: [{ query: 'portfolio', params: {} }] }, { noData: true }), ['veri okundu: portfolio']);
  const self = { filters: { assignee: 'me' }, entities: [], population: { tool: 'rota_task_analytics' } };
  assert.equal(scopeOf([self, { ...self, filters: {} }]), 'mixed:self,all', 'genişleyen ikinci bölüm');
  assert.equal(scopeOf([{ filters: {}, entities: [], population: { tool: 'rota_portfolio_summary' } }, { filters: {}, entities: [], population: { tool: 'rota_task_search' } }]), 'projects');
});

test('nitelendirme boş geçmez: ufuk, etkin yön, her istek kapsamı, sunucu yedeği, vaka seçimi, kayıt ve kullanım bu koşunundur', async (t) => {
  const { plannerScore, pickCases, record, composedProblem, usageTotals } = await import('../scripts/analysis-qualification.mjs');
  const { responseProblem } = await import('../scripts/planner-model-adapter.mjs');
  const self = (filters = {}) => ({ filters: { assignee: 'me', ...filters }, entities: [], population: { tool: 'rota_task_search' } });
  const planned = (requests, analysis = null) => ({ outcome: 'planned', decisions: [{ intent: 'rota' }], plan: { requests, ...(analysis ? { analysis } : {}) } });
  const expect = { intent: 'rota', scope: 'self', focusAny: ['upcoming'], window: ['2026-10-26', '2026-11-01'] };
  const analysis = { scope: 'self', focus: ['overview', 'upcoming'] };
  assert.deepEqual(plannerScore(planned([self(), self({ dateFrom: '2026-10-26', dateTo: '2026-11-01' })], analysis), expect), []);
  assert.deepEqual(plannerScore(planned([self(), self({ dateFrom: '2026-11-02', dateTo: '2026-11-08' })], analysis), expect), ['ufuk 2026-10-26..2026-11-01 okunmuyor'], 'yanlış hafta');
  assert.deepEqual(plannerScore(planned([self(), { ...self(), filters: { dateFrom: '2026-10-26', dateTo: '2026-11-01' } }], analysis), expect), ['kapsam mixed:self,all ≠ self'], 'genişleyen bölüm');
  // Bildirilen ama sunucunun okumadığı yön sayılmaz: etkin yön (sunucudan) puanlanır.
  assert.deepEqual(plannerScore(planned([self()], { scope: 'self', focus: ['status', 'priority', 'deadlines'] }), { intent: 'rota', scope: 'self', focusAny: ['workload'] }),
    ['yön status|priority|deadlines beklenenlerle kesişmiyor']);
  // Özetsiz ayrıntılı istekte de yön denetlenir (eşdeğer yön): gecikme listesi "yaklaşan" sayılmaz.
  const overdue = { ...self({ deadline: 'overdue' }) };
  assert.deepEqual(plannerScore(planned([overdue]), { intent: 'rota', scope: 'self', focusAny: ['upcoming'] }), ['yön overdue beklenenlerle kesişmiyor']);
  assert.deepEqual(plannerScore(planned([overdue]), { intent: 'rota', scope: 'self', focusAny: ['overdue'] }), []);
  const team = (teamLevel) => ({ ...self(), filters: { assignee: 'team', ...(teamLevel ? { teamLevel } : {}) } });
  for (const other of [undefined, 'unit']) assert.deepEqual(plannerScore(planned([team('department'), team(other)]), { intent: 'rota', scope: 'team', level: 'department' }),
    ['düzey department her ekip isteğinde değil']);
  assert.deepEqual(plannerScore(planned([team('department'), team('department')]), { intent: 'rota', scope: 'team', level: 'department' }), []);
  // Vaka seçimi, kayıt ve düzen.
  assert.throws(() => pickCases([{ id: 's01' }], ['s0l']), /bulunmayan vaka: s0l/);
  assert.deepEqual(pickCases([{ id: 's01' }, { id: 's02' }], ['s02']), [{ id: 's02' }]);
  assert.throws(() => record({ id: 'x', failures: ['kapsam all ≠ self'] }), /kapsam all ≠ self/, 'kaydedilen başarısızlık sınamayı düşürür');
  assert.doesNotThrow(() => record({ id: 'y', failures: [] }));
  assert.equal(composedProblem({ mode: 'composed', server: false }), null);
  assert.match(composedProblem({ mode: 'composed', server: true, reason: 'INVALID', issue: 'PART_MIXED' }), /sunucu/, 'sunucu yedeği model düzeni değildir');
  // Kullanım yalnızca bu koşunun satırları; ilk zorunlu yanıt da düşünme/model denetiminden geçer.
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'phase4e-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.jsonl');
  const row = (runId, model, output) => JSON.stringify({ runId, models: [model], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output, output_tokens_details: { thinking_tokens: 0 } } });
  writeFileSync(log, [row('prior', 'claude-sonnet-old', 50), JSON.stringify({ runId: 'current', reserved: true }),
    row('current', 'claude-haiku-4-5-20251001', 7), row('foreign-concurrent', 'claude-opus-x', 90)].join('\n') + '\n');
  const usage = usageTotals({ log, runId: 'current' });
  assert.deepEqual([usage.calls, usage.output, usage.models], [1, 7, ['claude-haiku-4-5-20251001']]);
  const haiku = 'claude-haiku-4-5-20251001';
  assert.equal(responseProblem({ models: [haiku], thinking: 'on' }, haiku), 'PLANNER_THINKING_ON');
  assert.equal(responseProblem({ models: ['claude-opus-x'], thinking: 'off' }, haiku), 'PLANNER_MODEL_MISMATCH');
  assert.equal(responseProblem({ models: [haiku], thinking: 'off' }, haiku), null);
});

test('kıyas kümesinin her altın planı ilk bildirimde kabul edilir ve sorulan kapsamı taşır (kendini varsaymaz)', () => {
  for (const item of corpus.cases) {
    const { unpacked, requests } = acceptPlan(item.text, item.plan);
    assert.equal(unpacked.plan.intent, item.expect.intent, item.id);
    if (item.expect.intent !== 'rota') continue;
    assert.ok(requests.length >= 1 && requests.length <= 3, item.id);
    assert.equal(scopeOf(requests), item.expect.scope, `${item.id}: ${item.text}`);
    if (item.expect.level) assert.ok(requests.every((request) => request.filters.teamLevel === item.expect.level), item.id);
    if (item.expect.visual) assert.equal(unpacked.plan.visual, true, item.id);
    for (const name of item.expect.names || []) {
      assert.ok(requests.some((request) => request.entities.some((entity) => entity.query === name)), `${item.id}: ${name}`);
    }
  }
});

test('analitik özetin her kapsam × yön × ad × ufuk açılımı sunucu doğrulamasından geçer', () => {
  let count = 0;
  for (const scope of ANALYSIS_SCOPES.filter((item) => !['previous', 'row'].includes(item))) {
    for (const focus of ANALYSIS_FOCUS) {
      for (const names of ['person', 'project'].includes(scope) ? [['Ahmet Kaya'], ['Ahmet Kaya', 'Ayşe Demir']] : [undefined]) {
        for (const window of [null, { dateFrom: '2026-10-26', dateTo: '2026-11-01' }]) {
          const analysis = parseAnalysis({ scope, focus: [focus], ...(names ? { names } : {}), ...(window || {}) });
          if (scope === 'project' && focus === 'projects') {
            assert.throws(() => expandAnalysis(analysis), (error) => error.details.includes('$.analysis.focus:unsupported'));
            continue;
          }
          for (const [index, raw] of expandAnalysis(analysis).entries()) {
            const parsed = parseRequestDeclaration(raw, { textTrusted: () => true, identityTrusted: () => true, today: '2026-10-31', priorParts: index });
            assert.deepEqual(completeRequest(parsed, [], { today: '2026-10-31' }).problems, [], `${scope}/${focus}/${names?.length}`);
            count += 1;
          }
        }
      }
    }
  }
  assert.ok(count >= 150, String(count));
});

test('açılım kabul edilen özetin nüfusunu hiçbir zaman genişletmez: karşılaştırma yönü ve ufku, within, portföy, yaklaşan iş, takvim günü', async (t) => {
  const expand = (raw, options) => expandAnalysis(parseAnalysis(raw), options);
  const reject = (raw, options) => { try { expand(raw, options); return null; } catch (error) { return error.details; } };
  const people = { scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'] };
  // Karşılaştırma istenen yönü ve ufku okur (sabit genel sayılar değil).
  const [december] = expand({ ...people, focus: ['upcoming'], dateFrom: '2026-12-01', dateTo: '2026-12-31' });
  assert.deepEqual([december.operation, december.metrics, december.filters], ['value', ['tasks.total'], { status: ['todo', 'in_progress'], dateFrom: '2026-12-01', dateTo: '2026-12-31' }]);
  assert.equal(december.bindings.length, 2);
  assert.deepEqual(expand({ ...people, focus: ['overdue'] })[0].metrics, ['tasks.overdue']);
  const priority = expand({ ...people, focus: ['priority'] });
  assert.deepEqual(priority.map((item) => [item.population.groupBy, item.entities.map((entity) => entity.text)]), [['priority', ['Ayşe Yılmaz']], ['priority', ['Zeynep Kaya']]],
    'dağılım yönü her kayıt için aynı gruplamadır');
  // Aşama F: fiziksel okuma üst sınırı (4) bildirilen yönlere de açıktır; sığan karşılaştırma bütünüyle okunur, aşan reddedilir.
  assert.equal(expand({ ...people, focus: ['overview', 'priority', 'critical'] }).length, 4, 'dört okumalı karşılaştırma bütünüyle kabul edilir');
  assert.deepEqual(reject({ ...people, focus: ['priority', 'deadlines', 'critical'] }), ['$.analysis.focus:requestBudget', '$.analysis.focus:narrowable'], 'fazla fiziksel istek kısmi başarı değildir');
  // Daraltılmış kapsamda portföy özeti okunmaz (aracın proje seçicisi yoktur): yön daraltılmış görev nüfusundan okunur.
  const within = expand({ scope: 'all', within: 'Radar Modernizasyonu', focus: ['projects', 'overview'] });
  assert.ok(within.every((item) => item.population.tool !== 'rota_portfolio_summary' && item.entities?.some((entity) => entity.text === 'Radar Modernizasyonu')), JSON.stringify(within));
  const portfolio = normalizeAnalysisContext({ v: 1, scope: 'projects', subjects: [], focus: ['projects'] });
  const narrowed = expand({ scope: 'previous', within: 'Radar Modernizasyonu', focus: ['overview', 'projects'] }, { previous: portfolio });
  assert.ok(narrowed.every((item) => item.population.tool !== 'rota_portfolio_summary' && item.entities?.length), JSON.stringify(narrowed));
  assert.ok(expand({ scope: 'projects', focus: ['overview', 'projects'] }).every((item) => item.population.tool === 'rota_portfolio_summary'), 'bütün portföyde portföy özeti');
  // within kesişimdir: kapsam zaten bir projeyle sınırlıysa ikinci proje onun yerine geçmez.
  const project = normalizeAnalysisContext({ v: 1, scope: 'project', subjects: [{ type: 'project', id: PROJECTS.FULL }], focus: ['overview'] });
  const teamInProject = normalizeAnalysisContext({ v: 1, scope: 'team', subjects: [], within: { type: 'project', id: PROJECTS.FULL }, focus: ['workload'] });
  for (const previous of [project, teamInProject]) {
    assert.deepEqual(reject({ scope: 'previous', within: 'Kısmi Proje', focus: ['overview'] }, { previous }), ['$.analysis.within:conflict']);
  }
  assert.ok(analysisHints(['$.analysis.within:conflict'])[0].includes('within verilmez'));
  // Yalnızca üst sınırı verilen yaklaşan iş bugünden başlar: gecikmiş iş "yaklaşan" sayılmaz.
  const [upcoming] = expand({ scope: 'self', focus: ['upcoming'], dateTo: '2026-11-30' }, { today: '2026-09-30' });
  assert.deepEqual([upcoming.filters.dateFrom, upcoming.filters.dateTo], ['2026-09-30', '2026-11-30']);
  assert.deepEqual(reject({ scope: 'self', focus: ['upcoming'], dateTo: '2026-09-01' }, { today: '2026-09-30' }), ['$.analysis.dateTo:past']);
  assert.deepEqual(reject({ scope: 'self', focus: ['upcoming'], dateTo: '2026-11-30' }), ['$.analysis.dateFrom:required'], 'bugün bilinmiyorsa sınırsız okunmaz');
  // Takvimde olmayan gün SQL'e ulaşmaz.
  for (const day of ['2026-02-31', '2026-04-31', '2026-13-01']) assert.deepEqual(reject({ scope: 'self', focus: ['upcoming'], dateFrom: day, dateTo: '2026-12-31' }), ['$.analysis.dateFrom:date'], day);
  // Uçtan uca: iki kişinin aralık karşılaştırması her okumada aralığı taşır.
  const { ask } = phase4eConversation(t);
  const result = await ask({ text: "Ayşe Yılmaz ile Zeynep Kaya'nın aralıktaki işlerini karşılaştır", plan: { intent: 'rota', language: 'tr', analysis: { ...people, focus: ['upcoming'], dateFrom: '2026-12-01', dateTo: '2026-12-31' } } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  const reads = populationReads(result.log);
  assert.ok(reads.length && reads.every((row) => String(row.params.dateFrom).startsWith('2026-12-01') && String(row.params.dateTo).startsWith('2026-12-31')), JSON.stringify(reads.map((row) => row.params)));
});

test('düzeltme önerisi ve tanıları isteği değiştirmez: öncelik eşdeğeri ve plan düzeyi sorunların adı korunur', () => {
  const brief = (request) => { const text = analysisSuggestion(request); return text && JSON.parse(/\{.*\}/.exec(text)[0]).analysis; };
  assert.equal(analysisSuggestion({ population: { tool: 'rota_task_search' }, filters: { priority: ['low'] } }), null, 'düşük öncelik kritik işe dönüşmez');
  assert.equal(analysisSuggestion({ population: { tool: 'rota_task_search' }, filters: { priority: ['medium', 'high'] } }), null);
  assert.deepEqual(brief({ population: { tool: 'rota_task_search' }, filters: { priority: ['critical', 'high'], status: ['todo', 'in_progress'] } }).focus, ['critical']);
  assert.deepEqual(analysisDetails(['$.language:required', '$.plan:unknownField', '$.visual:type', '$.intent:enum', '$.analysis:request', '$.analysis.within:conflict', '$.metrics[0]:population']),
    ['$.language:required', '$.plan:unknownField', '$.visual:type', '$.intent:enum', '$.analysis:request', '$.analysis.within:conflict', '$.analysis:invalid']);
  assert.ok(analysisHints(analysisDetails(['$.analysis:request'])).some((hint) => hint.includes('request/additionalRequests/calls birlikte verilmez')));
});

test('özet biçim hataları özetin kendi alanlarıyla bildirilir; istek ile birlikte verilemez', () => {
  const reject = (plan) => { try { unpackTypedPlan(planResult(plan)); return null; } catch (error) { return error.details; } };
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'project', focus: ['overview'] } }), ['$.analysis.names:required']);
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'], names: ['XY'] } }), ['$.analysis.names:scope']);
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'], level: 'unit' } }), ['$.analysis.level:scope']);
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['nope'] } }), ['$.analysis.focus[0]:enum']);
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'] }, request: { operation: 'value', metrics: ['tasks.total'] } }), ['$.analysis:request']);
  assert.deepEqual(reject({ intent: 'rota', language: 'tr', analysis: { scope: 'previous', focus: ['overview'] } }), ['$.analysis.scope:unavailable']);
  // Açılımın istek sorunları modelin yazdığı özet alanlarına çevrilir.
  assert.deepEqual(analysisDetails(['$.entities[0].text:untrusted', '$.filters.dateFrom:date', '$.metrics[0]:population']),
    ['$.analysis.names:untrusted', '$.analysis.dateFrom:invalid', '$.analysis:invalid']);
  // Model rota_plan şeması özet alanını taşır ve belirteç bütçesi içinde kalır.
  const tool = typedPlanningTool(toolCatalogForModel());
  assert.ok(tool.parameters.properties.analysis && tool.parameters.properties.visual);
  assert.ok(JSON.stringify(tool).length < 32000);
});

test('bütçe aşılırsa hiçbir yön sessizce düşmez; geçmiş ufuk yaklaşan iş değildir', () => {
  const week = { dateFrom: '2026-10-05', dateTo: '2026-10-11' };
  const focus = (raw, today = '2026-09-30') => effectiveFocus(parseAnalysis(raw), today);
  for (const raw of [
    // Aşama F: fiziksel sınıra (4) sığan dört yön kabul edilir; beşinci yön şema sınırını aşar.
    { scope: 'self', focus: ['overview', 'status', 'overdue', 'upcoming', 'priority'], ...week },
    // Kayıt başına dağılım yönleri (2 proje × 3 yön) okuma bölümü sınırını aşar: yön sessizce düşmez, plan reddedilir.
    { scope: 'project', names: ['Radar', 'Okuma'], focus: ['priority', 'deadlines', 'schedule'] }
  ]) assert.throws(() => expandAnalysis(parseAnalysis(raw), { today: '2026-09-30' }), (error) => error.details.includes(raw.focus.length > 4 ? '$.analysis.focus:maxItems' : '$.analysis.focus:requestBudget'));
  assert.equal(expandAnalysis(parseAnalysis({ scope: 'self', focus: ['overview', 'status', 'overdue', 'upcoming'], ...week }), { today: '2026-09-30' }).length, 4,
    'dört yönün her biri okunur; hiçbiri sessizce düşmez');
  // Sunucunun zorunlu eklediği okuma (portföyde projelere göre satırlar, ufuk yönü) modelin üç yönlük bütçesinden düşmez.
  for (const raw of [{ scope: 'projects', focus: ['overview', 'overdue', 'upcoming'] }, { scope: 'team', focus: ['overview', 'workload', 'overdue'], ...week }]) {
    assert.equal(expandAnalysis(parseAnalysis(raw), { today: '2026-09-30' }).length, 4, JSON.stringify(raw));
  }
  assert.deepEqual(focus({ scope: 'self', focus: ['overview'], ...week }), ['overview', 'upcoming']);
  assert.deepEqual(focus({ scope: 'self', focus: ['overview'], ...week }, '2026-11-01'), ['overview', 'schedule']);
  assert.deepEqual(focus({ scope: 'self', focus: ['overdue'], dateTo: '2026-09-01' }), ['overdue', 'schedule']);
  assert.deepEqual(focus({ scope: 'self', focus: ['upcoming'], ...week }), ['upcoming']);
  assert.deepEqual(focus({ scope: 'self', focus: ['overview'], dateTo: '2026-09-30' }), ['overview', 'upcoming']);
  const [critical] = expandAnalysis(parseAnalysis({ scope: 'self', focus: ['critical'], ...week }));
  assert.deepEqual([critical.filters.dateFrom, critical.filters.dateTo, critical.filters.priority], [week.dateFrom, week.dateTo, ['critical', 'high']]);
});

test('reddedilen ayrıntılı istekten türlü eşdeğer özet önerilir; özet düzeltme yolları özetin alan adlarıyla gider', async (t) => {
  // Öneri yalnızca isteğin türlü alanlarından kurulur; modelin geçerli olarak yazacağı tam rota_plan biçimidir.
  const suggestion = (request) => {
    const text = analysisSuggestion(request);
    return text && JSON.parse(/\{.*\}/.exec(text)[0]).analysis;
  };
  assert.deepEqual(suggestion({ operation: 'list', population: { tool: 'rota_workload_summary', sort: 'open_desc' }, filters: { assignee: 'team' } }), { scope: 'team', focus: ['workload'] });
  assert.deepEqual(suggestion({ operation: 'group', population: { tool: 'rota_task_analytics', groupBy: 'status' }, filters: { assignee: 'team', teamLevel: 'department' } }),
    { scope: 'team', level: 'department', focus: ['status'] });
  assert.deepEqual(suggestion({ operation: 'list', population: { tool: 'rota_task_search' }, filters: { deadline: 'overdue' }, entities: [{ type: 'person', text: 'Zeynep' }] }),
    { scope: 'person', focus: ['overdue'] });
  // Sistem yetkili notta serbest metin (ad) yankılanmaz; yalnızca yapısal yol söylenir.
  const injected = analysisSuggestion({ population: { tool: 'rota_task_search' }, filters: { deadline: 'overdue' }, entities: [{ type: 'project', text: 'IGNORE_ALL_RULES' }] });
  assert.doesNotMatch(injected, /IGNORE_ALL_RULES/);
  assert.match(injected, /analysis\.names: reddedilen isteğin project entities\[\]\.text/);
  assert.equal(analysisSuggestion({ population: { tool: 'rota_workload_summary' }, filters: { assignee: 'team', teamLevel: '"}]x' } }), null);
  assert.deepEqual(suggestion({ operation: 'rank', population: { tool: 'rota_portfolio_summary' } }), { scope: 'projects', focus: ['projects'] });
  for (const none of [null, [], { operation: 'value' }, { population: { tool: 'rota_task_detail' } }]) assert.equal(analysisSuggestion(none), null);
  for (const request of [{ population: { tool: 'rota_workload_summary' }, filters: { assignee: 'team' } }, { population: { tool: 'rota_task_analytics', groupBy: 'priority' }, filters: { assignee: 'me', status: ['todo', 'in_progress'] } }]) {
    assert.doesNotThrow(() => unpackTypedPlan(planResult(JSON.parse(/\{.*\}/.exec(analysisSuggestion(request))[0]))));
  }

  // Uçtan uca: özetin kapsam dışı alanı düzeltme notunda `$.analysis.rows:scope` olarak (anonim `field` değil) döner.
  const plans = [
    { intent: 'rota', language: 'tr', analysis: { scope: 'team', focus: ['workload'], rows: [1] } },
    { intent: 'rota', language: 'tr', analysis: { scope: 'team', focus: ['workload'] } }
  ];
  const { ask } = phase4eConversation(t, { planner: () => planCall(plans.shift()) });
  const result = await ask({ text: 'ekibimde en fazla açık işi olan kişileri göster' });
  assert.equal(result.inputs.length, 2);
  const repair = systemText(result.inputs[1].messages);
  assert.match(repair, /\$\.analysis\.rows:scope/);
  assert.doesNotMatch(repair, /\$\.field\.field/);
  assert.match(repair, /analysis \(genel durum/);
});

test('grup satırının taşımadığı toplam (durumlara göre yapılacak/devam eden) bildirimde reddedilir; eşdeğer özet önerilir', async (t) => {
  // Kayıt defteri grup satırına yalnızca aracın ürettiği sayıları (count, open, overdue, done) bağlar: aksi hâlde istek kabul
  // edilip sunucu seçemez ve zayıf model seçim turunda takılır (canlı nitelendirmede "görevlerimin dağılımını grafik olarak göster").
  const request = { operation: 'list', metrics: ['tasks.total', 'tasks.todo', 'tasks.inProgress', 'tasks.done'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy: 'status' }, filters: { assignee: 'me' } };
  const plans = [{ intent: 'rota', language: 'tr', request, visual: true }, { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['status'] }, visual: true }];
  const { ask } = phase4eConversation(t, { planner: () => planCall(plans.shift()) });
  const result = await ask({ text: 'görevlerimin dağılımını grafik olarak göster' });
  const repair = systemText(result.inputs[1].messages);
  assert.match(repair, /\$\.metrics\[1\]:not-row-total/);
  assert.match(repair, /"analysis":\{"scope":"self","focus":\["status"\]\}/);
  assert.equal(result.answer.finishReason, 'stop');
  assert.match(result.answer.content, /```rota-chart/);
});

/* ── Takip bağlamı ve ekip kapsamı (yakınsama) ─────────────────────── */

test('takip bağlamını yalnızca kabul edilmiş analiz yazar; kapsam kabul edilen özetten gelir, proje grupları satırdır', async (t) => {
  const systemNotes = (input) => input.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
  await t.test('olağan istek analiz bağlamı yazmaz', async (t) => {
    const { ask } = phase4eConversation(t);
    await ask({ text: 'gecikmiş işlerim', plan: { intent: 'rota', language: 'tr', request: { operation: 'list', metrics: ['task.title', 'task.overdueDays'],
      population: { tool: 'rota_task_search', collection: 'tasks' }, filters: { assignee: 'me', deadline: 'overdue' } } } });
    const followup = await ask({ text: 'bunları değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous', focus: ['overview'] } } });
    assert.equal(systemNotes(followup.inputs[0]).includes('Önceki doğrulanmış analiz bağlamı'), false, 'görev kümesi takibi analiz bağlamı değildir');
    assert.equal(followup.answer.finishReason, 'clarification');
    assert.equal(populationReads(followup.log).length, 0);
  });
  await t.test('portföy analizi görev yönüyle başlasa da kapsamı portföy kalır', async (t) => {
    const { ask } = phase4eConversation(t);
    const first = await ask({ text: 'projelerimdeki gecikmeleri değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'projects', focus: ['overdue', 'projects'] } } });
    assert.equal(first.answer.finishReason, 'stop');
    const followup = await ask({ text: 'peki gelecek hafta?', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous', focus: ['upcoming'], dateFrom: '2026-10-05', dateTo: '2026-10-11' } } });
    assert.match(systemNotes(followup.inputs[0]), /"scope":"projects"/, 'saklanan kapsam kabul edilen özetin kapsamıdır (all değil)');
    const reads = populationReads(followup.log);
    assert.ok(reads.length > 0, 'takip en az bir görev nüfusu okur');
    assert.ok(reads.every(({ params }) => params.dateFrom === '2026-10-05' && params.dateTo === '2026-10-11'), 'portföyün dönemli proje kırılımı aynı pencereyi korur');
    assert.equal(followup.log.some((row) => row.query === 'portfolio'), false, 'dönemsiz portföy aracı kullanılmaz');
    assert.equal(followup.answer.finishReason, 'stop');
  });
  await t.test('projelere göre gruplar satır göndergesidir', async (t) => {
    const { ask } = phase4eConversation(t);
    const first = await ask({ text: 'projelerime göre iş yükümü göster', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['projects'] } } });
    assert.equal(first.answer.finishReason, 'stop');
    const [firstProject] = first.answer.content.match(/RDR · Radar Modernizasyonu|PRT · Kısmi Proje/) || [];
    assert.ok(firstProject, first.answer.content);
    const row = await ask({ text: 'ilk projenin durumunu değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'row', rows: [1], focus: ['overview'] } } });
    assert.equal(row.answer.finishReason, 'stop', row.answer.content);
    const expected = firstProject.startsWith('RDR') ? PROJECTS.FULL : PROJECTS.PARTIAL;
    const reads = populationReads(row.log);
    assert.ok(reads.length && reads.every((read) => String(read.params.projectId).toLowerCase() === expected), JSON.stringify(reads.map((read) => read.params.projectId)));
  });
});

test('küçük takip bağlamı büyük kanıtın sıkıştırılması yüzünden kaybolmaz', async (t) => {
  const stack = createAiStack(t, { sicil: AYSE, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' }, seed: rotaToolSeed() });
  const first = await callRotaTool(stack, AYSE, 'rota_task_search', { assignee: 'me' });
  const [entry] = first.ledger.authorizationEntries();
  const payload = JSON.parse(entry.payload);
  payload.data.padding = '';
  entry.payload = JSON.stringify(payload);
  const unpadded = first.ledger.persistable(['R1'])[0].evidenceJson.length;
  payload.data.padding = 'x'.repeat(31990 - unpadded);
  entry.payload = JSON.stringify(payload);
  assert.equal(JSON.parse(first.ledger.persistable(['R1'])[0].evidenceJson).dataOmitted, undefined, 'bağlamsız kanıt tam biçimde sığar');
  const analysisContext = normalizeAnalysisContext({ v: 1, scope: 'self', subjects: [], focus: ['overview', 'overdue', 'upcoming'], dateFrom: '2026-09-28', dateTo: '2026-10-04' });
  const [row] = first.ledger.persistable(['R1'], { analysisContext });
  const stored = JSON.parse(row.evidenceJson);
  assert.deepEqual(stored.analysisContext, JSON.parse(JSON.stringify(analysisContext)));
  assert.ok(decodeAuthorizationPopulation(stored.authorizationPopulation), 'yetki nüfusu korunur');
});

test('ekip kapsamı: düzey yalnızca ekip nüfusuyla bildirilir, sorumlu gruplaması kapsam dışını adlandırmaz, ret düzeye özgüdür', async (t) => {
  await t.test('teamLevel ekip sorumlusu olmadan bildirimde reddedilir', async (t) => {
    for (const request of [
      { operation: 'list', metrics: ['person.name', 'tasks.open'], population: { tool: 'rota_workload_summary', collection: 'people' }, filters: { teamLevel: 'unit' } },
      { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' }, filters: { teamLevel: 'department' } }
    ]) {
      await t.test(`davranış durumu: ${request.population.tool}`, async (t) => {
        const plans = [{ intent: 'rota', language: 'tr', request }, { intent: 'clarify', language: 'tr', clarify: { reason: 'missing_scope' } }];
        const { ask } = phase4eConversation(t, { planner: () => planCall(plans.shift()) });
        const result = await ask({ text: 'birimimin iş yükü' });
        assert.match(systemText(result.inputs[1].messages), /\$\.filters\.teamLevel:assignee/, 'yürütmede araç hatası ya da sessiz genişleme değil');
        assert.equal(result.log.filter((row) => row.query === 'task-facts').length, 0, 'veri okunmadı');
      });
    }
  });
  await t.test('ekip sorumlu gruplaması kapsam dışı eş sorumluyu saymaz', async (t) => {
    const seed = rotaToolSeed();
    seed.taskAssignees.push({ TaskId: TASKS.TEAM_VISIBLE, Sicil: AYSE });
    const stack = createAiStack(t, { sicil: AYSE, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' }, seed });
    const all = await callRotaTool(stack, AYSE, 'rota_task_analytics', { groupBy: 'assignee', projectId: PROJECTS.TEAM });
    assert.ok(all.result.data.groups.some((group) => group.key === `sicil:${AYSE}`), 'sınama verisi: kapsam dışı eş sorumlu kimliği görünür');
    const team = await callRotaTool(stack, AYSE, 'rota_task_analytics', { assignee: 'team', groupBy: 'assignee' });
    assert.deepEqual(team.result.data.groups.map((group) => group.key), [`sicil:${ZEYNEP}`]);
  });
  await t.test('birim reddi bölüm bölümünü düşürmez', async (t) => {
    const seed = rotaToolSeed();
    seed.executiveScope = [{ ManagerSicil: AYSE, EmployeeSicil: ZEYNEP, ScopeType: 'DEPARTMENT' }];
    const team = (teamLevel) => ({ operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' }, filters: { assignee: 'team', teamLevel } });
    const { ask } = phase4eConversation(t, { seed });
    const result = await ask({ text: 'birimimin ve bölümümün görev sayısı',
      plan: { intent: 'rota', language: 'tr', request: team('unit'), additionalRequests: [team('department')] } });
    assert.match(result.answer.content, /yönetim kapsamınız bulunmuyor/, 'birim reddi söylenir');
    assert.ok(populationReads(result.log).some((row) => row.params.assigneeMode === 'team' && String(row.params.teamLevel).toUpperCase() === 'DEPARTMENT'), 'bölüm ayrıca yetkilendirilip okunur');
    assert.match(result.answer.content, /Bölümünüzde toplam \*\*2\*\* görev bulunuyor/);
  });
});

/* ── Kanonik takip bağlamı ──────────────────────────────────────────── */

test('analiz bağlamı kapalı biçimlidir; model kimlik görmez; önceki özne ve satırlar yalnızca sunucu açılımıyla okunur', () => {
  const context = normalizeAnalysisContext({ v: 1, scope: 'project', subjects: [{ type: 'project', id: PROJECTS.FULL }], focus: ['overview'], rows: [{ type: 'person', id: String(ZEYNEP) }] });
  assert.ok(context);
  for (const invalid of [{ ...context, v: 3 }, { ...context, scope: 'everyone' }, { ...context, subjects: [] }, { ...context, subjects: [{ type: 'project', id: 'x' }] },
    { ...context, rows: [{ type: 'person', id: '-1' }] }, { ...context, focus: ['x'] }, { ...context, extra: true }, { v: 1, scope: 'self', subjects: [{ type: 'project', id: PROJECTS.FULL }] }]) {
    assert.equal(normalizeAnalysisContext(invalid), null, JSON.stringify(invalid));
  }
  const summary = JSON.stringify(analysisContextSummary(context));
  assert.equal(summary.includes(PROJECTS.FULL) || summary.includes(String(ZEYNEP)), false, 'planlayıcı notu kimlik taşımaz');
  const previous = expandAnalysis(parseAnalysis({ scope: 'previous', focus: ['overdue'] }), { previous: context });
  assert.deepEqual(previous[0].entities, [{ type: 'project', id: PROJECTS.FULL }]);
  const row = expandAnalysis(parseAnalysis({ scope: 'row', rows: [1], focus: ['overview'] }), { previous: context });
  assert.deepEqual(row[0].entities, [{ type: 'person', id: String(ZEYNEP) }, { type: 'project', id: PROJECTS.FULL }]);
  assert.throws(() => expandAnalysis(parseAnalysis({ scope: 'row', rows: [2], focus: ['overview'] }), { previous: context }), (error) => error.details[0] === '$.analysis.rows:unavailable');
  // Önceki kimlik yalnızca bu bağlamın kimliği olarak güvenilirdir; başka kimlik değildir.
  const scope = createToolScope({ userText: 'sadece gecikmişler', analysisReferents: [...context.subjects, ...context.rows] });
  assert.equal(scope.identityTrusted('projects', PROJECTS.FULL), true);
  assert.equal(scope.identityTrusted('people', String(ZEYNEP)), true);
  assert.equal(scope.identityTrusted('projects', PROJECTS.HIDDEN), false);
  assert.equal(containmentText('Radar'), containmentText('radar'));
});

/* ── Uçtan uca: zorunlu açık uçlu sorular ───────────────────────────── */

test('gerçek REQUEST_DECLARATION hatası: "bu hafta işlerim açısından durumumu değerlendir" tek planla araç okur, kanıt üretir ve doğrulanır', async (t) => {
  const { ask } = phase4eConversation(t);
  const result = await ask({ text: 'bu hafta işlerim açısından durumumu değerlendir',
    plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'overdue', 'upcoming'], dateFrom: '2026-09-28', dateTo: '2026-10-04' } } });
  assert.equal(result.answer.finishReason, 'stop');
  assert.equal(result.inputs.length, 1, 'tek planlayıcı turu: bildirim düzeltmesi ya da Derin devri yok');
  assert.ok(populationReads(result.log).length >= 3, 'üç bölümün okuması');
  assert.ok(populationReads(result.log).every((row) => row.params.assigneeMode === 'me'));
  assert.match(result.answer.content, /gecikmiş/);
  assert.match(result.answer.content, /【R\d+】/);
});

test('ekip, bölüm ve proje analizi kendi kapsamında okur; yönetim kapsamı olmayan kullanıcı veri okumadan kapalı ret alır', async (t) => {
  await t.test('ekip', async (t) => {
    const { ask } = phase4eConversation(t);
    const result = await ask({ text: 'ekibimin bu haftaki durumunu değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'team', focus: ['overview', 'workload', 'overdue'] } } });
    assert.deepEqual(turnViolations(result, { assignee: 'team', workload: true, finish: 'stop' }), []);
    assert.match(result.answer.content, /Ekibinizde toplam \*\*2\*\* görev bulunuyor/);
    assert.match(result.answer.content, /Zeynep Kaya/);
    assert.equal(/Kısmi kendi görevim/.test(result.answer.content), false, 'kullanıcının kendi görevleri ekip analizine karışmaz');
  });
  await t.test('yönetim kapsamı olmayan kullanıcı', async (t) => {
    const { ask } = phase4eConversation(t, { sicil: MEHMET });
    const result = await ask({ text: 'ekibimin durumunu değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'team', focus: ['overview', 'workload'] } } });
    assert.equal(result.answer.finishReason, 'unavailable');
    assert.match(result.answer.content, /yönetim kapsamınız bulunmuyor/);
    assert.equal(populationReads(result.log).length, 0, 'kapsam yetki bağlamında olmadığı için hiçbir görev okunmaz');
  });
  await t.test('yetkisi olmayan kurumsal düzey', async (t) => {
    const { ask } = phase4eConversation(t, { seed: rotaToolSeed({ executiveScope: [{ ManagerSicil: AYSE, EmployeeSicil: ZEYNEP, ScopeType: 'UNIT' }] }) });
    const result = await ask({ text: 'bölümümüzün genel durumunu değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'team', level: 'department', focus: ['overview'] } } });
    assert.equal(result.answer.finishReason, 'unavailable');
    assert.match(result.answer.content, /yönetim kapsamınız bulunmuyor/);
    const unit = await ask({ text: 'birimimin genel durumunu değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'team', level: 'unit', focus: ['overview'] } } });
    assert.equal(unit.answer.finishReason, 'stop');
  });
  await t.test('proje', async (t) => {
    const { ask } = phase4eConversation(t);
    const result = await ask({ text: 'Radar Modernizasyonu projesinin genel durumunu değerlendir',
      plan: { intent: 'rota', language: 'tr', analysis: { scope: 'project', names: ['Radar Modernizasyonu'], focus: ['overview', 'overdue', 'workload'] } } });
    assert.deepEqual(turnViolations(result, { project: true, finish: 'stop' }), []);
    assert.ok(populationReads(result.log).every((row) => row.params.projectId), 'bütün bölümler aynı projeyle sınırlıdır');
    assert.match(result.answer.content, /En uzun süredir beklediği için ilk ele alınabilecek iş \*\*Haftalık durum toplantısı\*\* görünüyor|en uzun gecikme onda/,
      'öncelik önerisi kanıta dayalı gerekçesini söyler');
  });
  await t.test('belirsiz proje adı sunucunun açıklaması', async (t) => {
    const { ask } = phase4eConversation(t);
    const result = await ask({ text: 'Radar projesini değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'project', names: ['Radar'], focus: ['overview', 'overdue'] } } });
    assert.equal(result.answer.finishReason, 'clarification');
    assert.match(result.answer.content, /Radar Modernizasyonu/);
    assert.equal(populationReads(result.log).length, 0, 'ad tek kayda çözülmeden nüfus okunmaz');
  });
});

/* ── Görselleştirme ─────────────────────────────────────────────────── */

test('açık görselleştirme isteği + geçerli aday → grafik zorunlu (model atlasa da, model düzeni kapalı olsa da)', async (t) => {
  const plan = { intent: 'rota', language: 'tr', visual: true, analysis: { scope: 'self', focus: ['status'] } };
  await t.test('model düzeni grafiği atladı', async (t) => {
    const { ask } = phase4eConversation(t);
    const result = await ask({ text: 'görevlerimin dağılımını grafik olarak göster', plan });
    assert.match(result.answer.content, /```rota-chart\n\{"version":1,"type":"donut"/);
    assert.match(result.answer.content, /"title":"Görevlerinizin durum dağılımı"/);
  });
  await t.test('model düzeni kapalı', async (t) => {
    const { ask } = phase4eConversation(t, { composition: false });
    const result = await ask({ text: 'görevlerimin dağılımını grafik olarak göster', plan });
    assert.match(result.answer.content, /```rota-chart/);
  });
  await t.test('grafiğe uygun aday yoksa kısa açıklama', async (t) => {
    const { ask } = phase4eConversation(t);
    const result = await ask({ text: 'kaç gecikmiş görevim var grafikle göster',
      plan: { intent: 'rota', language: 'tr', visual: true, request: { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' }, layout: 'auto', filters: { deadline: 'overdue', assignee: 'me' } } } });
    assert.equal(result.answer.content.includes('```rota-chart'), false);
    assert.match(result.answer.content, /güvenle grafik çizilemedi/);
  });
});

test('görselleştirme dilbilgisi kapalıdır: çizgi, yığılmış çubuk, gösterge kartı ve zaman çizelgesi biçim dışı tanımı reddeder', async () => {
  const base = { version: 1, locale: 'tr', title: 'T', unit: 'count', evidence: ['R1'] };
  const valid = [
    { ...base, type: 'line', items: [{ label: 'Eki 2026', value: 3 }, { label: 'Kas 2026', value: 5 }] },
    { ...base, type: 'stacked', series: ['Yapılacak', 'Devam ediyor'], items: [{ label: 'A', values: [2, 1] }, { label: 'B', values: [0, 4] }] },
    { ...base, type: 'kpi', unit: 'number', items: [{ label: 'Açık', value: 6, unit: 'count' }, { label: 'Gecikmiş', value: 3, unit: 'count' }, { label: 'Tamamlanma', value: 14, unit: 'percent' }] },
    { ...base, type: 'timeline', unit: 'number', items: [{ label: 'X', date: '2026-10-01' }, { label: 'Y', date: '2026-10-05' }] }
  ];
  for (const spec of valid) assert.ok(normalizeAnswerChart(spec), spec.type);
  const invalid = [
    { ...valid[1], series: ['A'] }, { ...valid[1], items: [{ label: 'A', values: [1] }, { label: 'B', values: [1] }] }, { ...valid[1], series: ['A', 'A'] },
    { ...valid[2], items: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] }, { ...valid[2], items: [{ label: 'A', value: 1, unit: 'eur' }, { label: 'B', value: 1, unit: 'count' }] },
    { ...valid[3], items: [{ label: 'X', date: '2026-10-05' }, { label: 'Y', date: '2026-10-01' }] }, { ...valid[3], items: [{ label: 'X', date: '1 Ekim' }, { label: 'Y', date: '2026-10-02' }] },
    // Biçime uyan ama takvimde olmayan gün başka bir güne yuvarlanmaz.
    { ...valid[3], items: [{ label: 'X', date: '2026-02-30' }, { label: 'Y', date: '2026-03-02' }] }, { ...valid[3], items: [{ label: 'X', date: '2026-04-01' }, { label: 'Y', date: '2026-04-31' }] },
    { ...valid[0], items: [{ label: '<svg onload=x>', value: -1 }, { label: 'b', value: 1 }] }, { ...valid[0], color: 'red' }, { ...base, type: 'heatmap', items: [] }
  ];
  for (const spec of invalid) assert.equal(normalizeAnswerChart(spec), null, JSON.stringify(spec));
  // Kopyalanan metin çizimle aynı doğrulanmış değerleri taşır.
  assert.equal(answerChartText(valid[1]), 'T\n\tYapılacak\tDevam ediyor\nA\t2\t1\nB\t0\t4');
  assert.match(answerChartText(valid[3]), /^T\n1 Ekim 2026\tX\n5 Ekim 2026\tY$/);
  assert.match(answerChartText(valid[2]), /Tamamlanma\t%14/);
  // Gerçek çocuk bileşenler SSR ile çalışır: ortak figure tek başına türün çizildiğini kanıtlamaz.
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  for (const spec of [...valid, ...['bar', 'donut'].map((type) => ({ ...base, type, items: [{ label: 'A', value: 3 }, { label: 'B', value: 5 }] }))]) {
    const figure = mountComponent(AnswerChart, { spec: normalizeAnswerChart(spec) }).output;
    assert.equal(figure.type, 'figure');
    assert.equal(figure.props.className, `assistant-chart is-${spec.type}`);
    assert.equal(JSON.stringify(figure).includes('dangerouslySetInnerHTML'), false);
    const html = renderToStaticMarkup(createElement(AnswerChart, { spec: normalizeAnswerChart(spec) }));
    if (spec.type === 'line') {
      assert.match(html, /<polyline class="assistant-chart-line-path" points="10,50 310,10"/);
      assert.match(html, /Eki 2026: 3/);
    } else if (spec.type === 'stacked') {
      assert.equal((html.match(/class="assistant-chart-stack-part /g) || []).length, 4);
      assert.match(html, /aria-label="A: Yapılacak 2, Devam ediyor 1"/);
      assert.match(html, /flex-grow:1/);
    } else if (spec.type === 'kpi') {
      assert.equal((html.match(/class="assistant-chart-kpi"/g) || []).length, 3);
      assert.match(html, /Tamamlanma: %14/);
    } else if (spec.type === 'timeline') {
      assert.match(html, /<time[^>]+dateTime="2026-10-01"[^>]*>1 Ekim 2026<\/time>/);
      assert.match(html, /<time[^>]+dateTime="2026-10-05"[^>]*>5 Ekim 2026<\/time>/);
    } else if (spec.type === 'bar') {
      assert.match(html, /class="assistant-chart-fill" style="--chart-ratio:0.6"/);
      assert.match(html, /aria-label="B: 5"/);
    } else {
      assert.match(html, /<svg class="assistant-chart-ring"/);
      assert.equal((html.match(/class="assistant-chart-slice /g) || []).length, 2);
      assert.match(html, /class="assistant-chart-ring-total"[^>]*>8<\/text>/);
    }
  }
});

test('yığılmış çubuk, zaman çizelgesi ve gösterge adayları yalnızca doğrulanmış tam kanıttan kurulur', async (t) => {
  const { ask } = phase4eConversation(t, { composition: false });
  const workload = await ask({ text: 'iş yükümü grafikle göster', plan: { intent: 'rota', language: 'tr', visual: true, analysis: { scope: 'self', focus: ['workload'] } } });
  assert.match(workload.answer.content, /"type":"stacked"/, 'projelere göre açık iş: yapılacak + devam eden bölümleri');
  const upcoming = await ask({ text: 'yaklaşan terminlerimi zaman çizelgesinde göster',
    plan: { intent: 'rota', language: 'tr', visual: true, analysis: { scope: 'self', focus: ['overdue'] } } });
  assert.match(upcoming.answer.content, /```rota-chart/);
  const overview = await ask({ text: 'durumumu göstergelerle özetle', plan: { intent: 'rota', language: 'tr', visual: true, analysis: { scope: 'self', focus: ['overview'] } } });
  assert.match(overview.answer.content, /"type":"kpi"/);
  const trend = await ask({ text: 'açık işlerimin aylara göre dağılımını göster', plan: { intent: 'rota', language: 'tr', visual: true, analysis: { scope: 'self', focus: ['schedule'] } } });
  assert.match(trend.answer.content, /"type":"line"/);
});

test('grafik adayı eklenmesi doğrulayıcıdan geçer; tablo grafikten önce çizilse de yönlendirme geçerlidir', () => {
  const fact = (field, value, extra = {}) => ({ evidenceId: 'R1', fact: { field, value, subject: 'x', semantic: { metric: 'tasks.total', measure: 'tasks', complete: true, groupBy: 'status',
    provenance: { tool: 'rota_task_analytics' }, filters: { assignee: 'me' }, row: { collectionSize: 2 }, group: { key: extra.key }, ...extra.semantic } } });
  const presentation = { layout: 'auto', empty: [], facts: [fact('data.groups.0.label', 'Yapılacak', { key: 'todo' }), fact('data.groups.0.count', 6, { key: 'todo' }),
    fact('data.groups.1.label', 'Tamamlandı', { key: 'done' }), fact('data.groups.1.count', 1, { key: 'done' })] };
  const sheet = buildComposition({ parts: [{ index: 0, presentation }], visual: true });
  // Sınama boş geçemez: sayfa kurulur ve bir grafik adayı vardır (aday üretimi bozulursa sınama düşer).
  assert.ok(sheet, 'sayfa kurulur');
  assert.ok(sheet.render.charts.size >= 1, 'grafik adayı vardır');
  const table = [...sheet.render.tables.keys()][0];
  const said = [...sheet.render.propositions.keys()].slice(0, 3);
  const validated = validateComposition(sheet, { blocks: [{ type: 'say', items: said }, { type: 'rows', source: table }] });
  assert.equal(validated.ok, true, JSON.stringify(validated.issues));
  const ensured = ensureChart(sheet, validated);
  assert.equal(ensured.chartInserted, true);
  assert.equal(renderComposition(sheet, ensured).charts, 1);
  assert.ok(defaultComposition(sheet).ok);
});

test('paragrafa yazılan D# sunucu ayrıntısını paragrafın ardına koyar; bölüm karışımı ve yineleme yine reddedilir', async (t) => {
  const plan = { intent: 'rota', language: 'tr', analysis: { scope: 'team', focus: ['overview', 'workload', 'overdue'] } };
  const run = async (t, layout) => {
    const logs = captureConsole(t);
    const { ask } = phase4eConversation(t, { compose: () => composer((view) => layout(view)) });
    const result = await ask({ text: 'ekibimin durumunu değerlendir', plan });
    const line = logs.map((row) => (row.includes('"operation":"ai.grounded.turn"') ? JSON.parse(row.slice(row.indexOf('{'))) : null)).filter(Boolean).at(-1);
    return { result, presentation: line.context.presentation };
  };
  const ids = (view, kind, part) => view[kind].filter((item) => item.part === part).map((item) => item.id);
  // Zayıf modelin gerçek düzeni (Haiku): bölümün önermeleri ve ayrıntısı aynı paragrafta, ardından gösterge grafiği.
  const sub = async (name, layout) => { let out = null; await t.test(`davranış: ${name}`, async (t) => { out = await run(t, layout); }); return out; };
  const accepted = await sub('kabul', (view) => {
    assert.ok(ids(view, 'propositions', 1).length && ids(view, 'details', 1).length && ids(view, 'charts', 1).length, 'sınama sayfası bölüm 1 önerme, ayrıntı ve grafik taşır');
    // Ekip iş yükünün tamlığı kanıtlanmadığı için sunucu çekincesi (required) sayfadadır ve kendi bölümünde söylenir.
    const required = view.propositions.filter((item) => item.required);
    assert.ok(required.length, 'ekip iş yükü çekincesi sayfada');
    return { blocks: [{ type: 'say', items: [...ids(view, 'propositions', 1), ids(view, 'details', 1)[0], ids(view, 'charts', 1)[0]] },
      { type: 'chart', source: ids(view, 'charts', 1)[0], style: 'kpi' }, { type: 'say', items: required.map((item) => item.id) }] };
  });
  assert.equal(accepted.presentation.mode, 'composed');
  assert.notEqual(accepted.presentation.server, true, `modelin düzeni kabul edildi (sunucu yedeği değil): ${JSON.stringify(accepted.presentation)}`);
  const content = accepted.result.answer.content;
  const paragraph = content.indexOf('Açık **2** görevin');
  const detail = content.indexOf('Ekibinizde toplam **2** görev bulunuyor');
  // Aşama F: bölümlü özette ilk paragraftan önce yalnızca sunucunun bölüm başlığı gelebilir.
  assert.ok(paragraph >= 0 && /^(Aşağıda [^\n]+\n\n)?(#### [^\n]+\n\n)?$/.test(content.slice(0, paragraph)) && detail > paragraph && detail < content.indexOf('```rota-chart'), `ayrıntı paragrafın ardında, grafikten önce:\n${content}`);
  assert.equal(content.split('Ekibinizde toplam').length - 1, 1, 'ayrıntı bir kez');
  // Başka bölümün ayrıntısı paragrafa karışamaz; aynı ayrıntı iki kez kullanılamaz.
  const mixed = await sub('bölüm karışımı', (view) => ({ blocks: [{ type: 'say', items: [...ids(view, 'propositions', 1), ids(view, 'details', 2)[0]] }] }));
  assert.equal(mixed.presentation.issue, 'PART_MIXED');
  const twice = await sub('yineleme', (view) => ({ blocks: [{ type: 'say', items: ids(view, 'propositions', 1) }, { type: 'details', source: ids(view, 'details', 1)[0] },
    { type: 'say', items: [ids(view, 'details', 1)[0]] }] }));
  assert.equal(twice.presentation.issue, 'DUPLICATE_SOURCE');
});

test('yanıt düzyazısı akıcıdır: aynı nüfusun önermeleri bağlanır, ayrıntı kendi bölümündedir, ölçüt yinelenmez', async (t) => {
  await t.test('genel değerlendirme', async (t) => {
    const { ask } = phase4eConversation(t, { composition: false });
    const { answer } = await ask({ text: 'bu hafta işlerim açısından durumumu değerlendir',
      plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'overdue', 'upcoming'], dateFrom: '2026-09-28', dateTo: '2026-10-04' } } });
    // Aşama F: üç bölümlü analitik özet bölüm başlıklıdır; anlatım sırası başlıklar dışında denetlenir.
    assert.ok((answer.content.match(/^#### /gm) || []).length >= 2, answer.content);
    // Bulgu girişi kurulamayan özet çerçeve cümlesiyle açılır ve bir sonraki adım önerisiyle kapanır (olgu taşımazlar).
    assert.match(answer.content, /^Aşağıda kendi işleriniz genel durum, gecikmeler ve yaklaşan teslimatlar açısından özetleniyor\./);
    const paragraphs = answer.content.split('\n\n').filter((paragraph) => !paragraph.startsWith('#### ') && !paragraph.startsWith('Aşağıda '));
    // Gecikme payından sonra yakın termin aynı cümlede; genel görünümün ayrıntısı hemen ardından (yanıtın sonunda değil).
    assert.equal(paragraphs[0], "Açık **1** görevin **1'i** (**%100**) gecikmiş durumda. 【R1】");
    assert.equal(paragraphs[1], "Sorumlusu olduğunuz toplam **1** görev bulunuyor (ölçüt: Termin: 28 Eylül 2026 – 4 Ekim 2026). Bunların hiçbiri tamamlanmış ya da yedi gün içinde terminli değil. 【R1】",
      'analist cümlesinin söylediği açık/gecikmiş sayısı ayrıntıda yinelenmez; "Sorumlu: Ben" öznede');
    // Gecikmiş bölüm yalnızca dönem içindeki görevi gösterir; eski toplamlar ve ortalamalar taşınmaz.
    assert.equal(paragraphs[2], "Şu anda **28 Eylül 2026** ile **4 Ekim 2026** arasında terminli **1** gecikmiş göreviniz var. **Kısmi Proje** projesindeki **Kısmi kendi görevim** görevinin termini **29 Eylül 2026**. Görev **1** gündür gecikmiş. 【R2】");
    assert.match(answer.content, /30 Eylül 2026.*4 Ekim 2026.*terminli açık göreviniz yok\./, 'yaklaşan pencere gecikmiş işi tekrar saymaz');
    assert.doesNotMatch(answer.content, /Eşleşen \*\*1\*\* görev bulundu/);
    for (const paragraph of paragraphs) assert.ok(paragraph.split('(ölçüt:').length <= 2, `ölçüt paragrafta en çok bir kez: ${paragraph}`);
  });
  await t.test('portföy karşılaştırması', async (t) => {
    const { ask } = phase4eConversation(t, { composition: false });
    const { answer } = await ask({ text: 'projelerimi karşılaştır', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'projects', focus: ['projects'] } } });
    // Aşama F: yanıt, sunucunun bölümler arası yönetim sonucuyla açılır; sayıları yinelemez (gövde ve tablo taşır).
    const [lead, body] = answer.content.split('\n\n');
    assert.match(lead, /^Mevcut göstergelere göre yönetim dikkatini en çok \*\*Radar Modernizasyonu\*\* projesi gerektiriyor: gecikmiş, önümüzdeki yedi günde terminli ve açık iş sayılarının üçünde de projeler arasında ilk sırada\. 【R1】$/);
    assert.doesNotMatch(lead, /\*\*\d/, 'giriş gövdenin sayılarını yinelemez');
    // Tablo tek başına kalmaz: kapsama ve öndeki proje (sütun sütun istatistik listesi değil).
    assert.match(body, /^Listedeki \*\*4\*\* projenin hepsinde gecikmiş görev var\. \*\*Radar Modernizasyonu\*\*, \*\*6\*\* açık, \*\*2\*\* gecikmiş ve \*\*2\*\* yedi gün içinde terminli görevle projeler arasında ilk sırada\. 【R1】/);
    assert.doesNotMatch(answer.content, /ortalaması|sütununda en/);
  });
  // Bağlaç yalnızca aynı kanıtın önermeleri arasındadır; başka kanıtın önermesi kendi cümlesiyle kalır.
  const pressure = { kind: 'pressure', tone: 'warning', evidenceId: 'R1', markdown: 'A.', parts: ['a.'], fluent: { host: 'totals' } };
  const urgency = { kind: 'urgency', tone: 'info', evidenceId: 'R2', markdown: 'B.', parts: ['b.'], fluent: { follow: { key: 'totals', also: ['; c'], plain: ['; c'] } } };
  assert.equal(fluentParagraph([{ proposition: pressure }, { proposition: urgency }]), 'A. B.');
  assert.equal(fluentParagraph([{ proposition: pressure }, { proposition: { ...urgency, evidenceId: 'R1' } }]), 'A; c.');
});

test('grafik ve düzen kanıttan güçlü anlam iddia etmez; sunucu düzeni ve ayrıntı sözleşmesi uygulanır', async (t) => {
  const row = (tool, field, value, metric, size, extra = {}) => ({ evidenceId: 'R1', fact: { field, value, subject: 'x', semantic: { metric, measure: 'tasks', complete: true,
    provenance: { tool }, row: { collectionSize: size }, ...extra } } });
  const sheetOf = (facts, options = {}) => buildComposition({ parts: [{ index: 0, presentation: { layout: 'auto', empty: [], facts } }], visual: true, ...options });
  const months = (keys) => sheetOf(keys.flatMap((key, index) => [
    row('rota_task_analytics', `data.groups.${index}.label`, key, 'tasks.total', keys.length, { groupBy: 'target_month', filters: { assignee: 'me' }, group: { key } }),
    row('rota_task_analytics', `data.groups.${index}.count`, index + 1, 'tasks.total', keys.length, { groupBy: 'target_month', filters: { assignee: 'me' }, group: { key } })]));
  const types = (sheet) => [...sheet.render.charts.values()].flatMap((chart) => chart.types);
  // Aylar boşluksuzsa çizgi; boşluklu dizi eşit aralıklı zaman çizgisi gibi çizilmez.
  assert.ok(types(months(['2026-09', '2026-10', '2026-11'])).includes('line'));
  assert.equal(types(months(['2026-09', '2026-11', '2026-12'])).includes('line'), false, 'boşluklu aylar');
  const year = Array.from({ length: 14 }, (_, index) => `${2026 + Math.floor((8 + index) / 12)}-${String(((8 + index) % 12) + 1).padStart(2, '0')}`);
  assert.deepEqual(types(months(year)), ['line'], '13–24 ay çizgi adayıdır (çubuk sınırı 12)');
  // Yapılacak + devam eden yalnızca açık nüfusta tam durum kırılımıdır.
  const portfolio = (filters) => sheetOf([0, 1, 2].flatMap((index) => [
    row('rota_portfolio_summary', `data.projects.${index}.name`, `Proje ${index + 1}`, 'project.name', 3, { measure: 'text', filters }),
    row('rota_portfolio_summary', `data.projects.${index}.tasks.todo`, index + 2, 'tasks.todo', 3, { filters }),
    row('rota_portfolio_summary', `data.projects.${index}.tasks.inProgress`, index + 1, 'tasks.inProgress', 3, { filters })]));
  assert.equal(types(portfolio({})).includes('stacked'), false, 'tamamlananlar okunmadan "durum kırılımı" çizilmez');
  assert.ok(types(portfolio({ statuses: ['todo', 'in_progress'] })).includes('stacked'), 'açık nüfusta tam kırılım');
  // Yalnızca gösterge kartı olan bölüm: sunucu düzeni ayrıntıyla başlar ve kartı çizer (açık grafik isteği düşmez).
  const kpi = sheetOf(['total', 'open', 'done'].map((key, index) => ({ evidenceId: 'R1', fact: { field: `data.totals.${key}`, value: [7, 6, 1][index], subject: 'Rota',
    semantic: { metric: `tasks.${key}`, measure: 'tasks', complete: true, provenance: { tool: 'rota_task_analytics' }, filters: { assignee: 'me' } } } })));
  assert.ok([...kpi.render.charts.values()].some((chart) => chart.types[0] === 'kpi'));
  const layout = defaultComposition(kpi);
  assert.ok(layout?.ok, 'sunucu düzeni kurulur');
  assert.deepEqual(layout.blocks.map((block) => block.type), ['details', 'chart']);
  // Zaman çizelgesi gecikmiş terminleri de gösterebilir; çizgi noktaları geniş kapsayıcıda elipse dönüşmez.
  assert.doesNotMatch(pointerSentence({ type: 'chart', chartType: 'timeline' }, 'en'), /upcoming/);
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const line = renderToStaticMarkup(createElement(AnswerChart, { spec: normalizeAnswerChart({ version: 1, type: 'line', locale: 'tr', title: 'T', unit: 'count', evidence: ['R1'],
    items: [{ label: 'Eki 2026', value: 3 }, { label: 'Kas 2026', value: 5 }] }) }));
  assert.equal(line.includes('<circle'), false, 'esnetilen çizimde daire elipse dönüşür');
  assert.equal((line.match(/assistant-chart-line-point-ring/g) || []).length, 2);
  // Kısa yanıtın üst sınırı uygulanır; sunucu düzeni bütçeyi önce analist sonucuna ayırır.
  await t.test('kısa yanıt', async (t) => {
    const logs = captureConsole(t);
    const { ask } = phase4eConversation(t, { compose: () => composer((view) => ({ blocks: [{ type: 'say', items: view.propositions.filter((item) => item.part === 1).map((item) => item.id) },
      ...view.tables.map((table) => ({ type: 'rows', source: table.id }))] })) });
    const result = await ask({ text: 'gecikmiş işlerimi değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overdue'] } } }, { detail: 'short' });
    const presentation = logs.map((entry) => (entry.includes('"operation":"ai.grounded.turn"') ? JSON.parse(entry.slice(entry.indexOf('{'))) : null)).filter(Boolean).at(-1).context.presentation;
    assert.equal(presentation.issue, 'NARRATION_LIMIT', 'bütün önermeleri anlatan kısa düzen reddedilir');
    assert.deepEqual([presentation.mode, presentation.server], ['composed', true], 'sunucu düzeni');
    assert.ok(presentation.said <= ANSWER_DETAIL_CONTRACT.short.maxNarrated, JSON.stringify(presentation));
    assert.match(result.answer.content, /[İi]lk ele alınabilecek iş/, 'analist sonucu kısa bütçede de söylenir');
  });
});

/* ── Analist önermeleri ─────────────────────────────────────────────── */

test('analist önermeleri önkoşuluyla vardır; kişi hakkında yargı değil işlemsel dil kullanır', () => {
  const total = (metric, value) => ({ evidenceId: 'R1', fact: { field: `data.totals.${metric.split('.')[1]}`, value, semantic: { metric, complete: true, provenance: { tool: 'rota_task_analytics' } } } });
  const kinds = (facts) => analystPropositions([{ index: 0, presentation: { facts } }], 'tr').map((item) => [item.proposition.kind, item.proposition.tone, item.proposition.plain]);
  const contrast = kinds([total('tasks.open', 6), total('tasks.overdue', 2), total('tasks.dueNext7Days', 1), total('tasks.completionRatePercent', 70)]);
  assert.deepEqual(contrast[0], ['contrast', 'warning', 'Tamamlanma görünümü olumlu (%70); buna karşılık 2 gecikmiş görev dikkat gerektiriyor.']);
  assert.deepEqual(contrast[1], ['urgency', 'info', 'Bugün başlayan yedi günlük dönemde 1 açık görevin termini var.']);
  assert.deepEqual(kinds([total('tasks.open', 6), total('tasks.overdue', 3), total('tasks.completionRatePercent', 14)])[0],
    ['pressure', 'warning', "Açık 6 görevin 3'ü (%50) gecikmiş durumda."]);
  assert.deepEqual(kinds([total('tasks.open', 4), total('tasks.overdue', 0)])[0], ['positive', 'success', 'Açık 4 görev arasında şu anda gecikmiş görev yok.']);
  assert.deepEqual(kinds([total('tasks.open', 0), total('tasks.overdue', 0)]), [], 'açık iş yoksa ilişki yok');
  assert.deepEqual(kinds([{ ...total('tasks.open', 6), fact: { ...total('tasks.open', 6).fact, semantic: { ...total('tasks.open', 6).fact.semantic, complete: false } } }, total('tasks.overdue', 3)]), [], 'eksik kanıttan ilişki kurulmaz');
  const person = (index, name, open, overdue, size = 3) => [
    { evidenceId: 'R2', fact: { field: `data.people.${index}.name`, value: name, semantic: { complete: true, provenance: { tool: 'rota_workload_summary' }, row: { collectionSize: size } } } },
    { evidenceId: 'R2', fact: { field: `data.people.${index}.openTasks`, value: open, semantic: { complete: true, provenance: { tool: 'rota_workload_summary' }, row: { collectionSize: size } } } },
    { evidenceId: 'R2', fact: { field: `data.people.${index}.overdue`, value: overdue, semantic: { complete: true, provenance: { tool: 'rota_workload_summary' }, row: { collectionSize: size } } } }];
  const complete = { evidenceId: 'R2', fact: { field: 'data.populationComplete', value: true, semantic: { complete: true, provenance: { tool: 'rota_workload_summary' } } } };
  const concentrated = kinds([complete, ...person(0, 'A Kişi', 8, 4), ...person(1, 'B Kişi', 2, 1), ...person(2, 'C Kişi', 2, 0)]);
  assert.deepEqual(concentrated.map(([kind]) => kind), ['concentration', 'overdueConcentration']);
  assert.match(concentrated[0][2], /^Açık iş atamalarının %67'si A Kişi üzerinde; iş yükü bu kişide yoğunlaşıyor\.$/);
  // Denge yargısı sorumlusuz açık işin büyüklüğü bilinmeden ve o iş bir kişinin ortalama yükünü aşarken söylenmez.
  const unassigned = (value) => ({ evidenceId: 'R2', fact: { field: 'data.unassignedOpenTasks', value, semantic: { complete: true, provenance: { tool: 'rota_workload_summary' } } } });
  const even = [complete, ...person(0, 'A', 4, 0), ...person(1, 'B', 3, 0), ...person(2, 'C', 3, 0)];
  assert.deepEqual(kinds([...even, unassigned(2)]).map(([kind]) => kind), ['balance']);
  assert.deepEqual(kinds(even).map(([kind]) => kind), [], 'sorumlusuz iş bilinmiyor');
  assert.deepEqual(kinds([...even, unassigned(100)]).map(([kind]) => kind), [], 'açık işin çoğu atanmamış');
  assert.deepEqual(kinds([...person(0, 'A', 8, 4, 5), ...person(1, 'B', 2, 1, 5), ...person(2, 'C', 2, 0, 5)]), [], 'kesilmiş kişi listesinden pay söylenmez');
  for (const [, , plain] of [...contrast, ...concentrated]) assert.doesNotMatch(plain, /başarısız|verimsiz|yetersiz|tembel|kötü/);
});

/* ── Takip zincirleri ───────────────────────────────────────────────── */

for (const chain of followups.chains) {
  test(`takip zinciri ${chain.id}: ${chain.title}`, async (t) => {
    const { ask } = phase4eConversation(t);
    for (const [index, turn] of chain.turns.entries()) {
      const result = await ask(turn);
      assert.deepEqual(turnViolations(result, turn.expect), [], `${chain.id}${index + 1}: ${turn.text}\n${result.answer.content.slice(0, 300)}`);
    }
  });
}

test('takip yeniden yetkilendirilir: önceki projenin erişimi kalkınca aynı özne okunamaz ve veri açılmaz', async (t) => {
  const { stack, ask } = phase4eConversation(t);
  const first = await ask({ text: 'Radar Modernizasyonu projesini değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'project', names: ['Radar Modernizasyonu'], focus: ['overview'] } } });
  assert.equal(first.answer.finishReason, 'stop');
  // Proje etkinlikten kalkar: kullanıcının bu projedeki hiçbir kaynaktan erişimi kalmaz (lider, sorumlu, oluşturan).
  stack.db.projects.find((project) => project.ProjectId === PROJECTS.FULL).IsActive = 0;
  const second = await ask({ text: 'sadece gecikmiş işleri göster', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous', focus: ['overdue'] } } });
  // Yeniden yetkilendirme gerçekten sınandı: bağlam taşındı, önceki projenin kimliği BU turda okunmaya çalışıldı ve erişim
  // olmadığından kanıtsız "ulaşılamıyor" sonucu döndü (başka bir açıklama ya da bağlam kaybı değil).
  const notes = second.inputs[0].messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
  assert.ok(notes.includes('Önceki doğrulanmış analiz bağlamı'), 'önceki analiz bağlamı taşındı');
  assert.ok(populationReads(second.log).some((row) => String(row.params.projectId).toLowerCase() === PROJECTS.FULL), 'önceki özne güncel yetkiyle okunmaya çalışıldı');
  assert.equal(second.answer.finishReason, 'unavailable');
  assert.deepEqual(second.answer.evidence || [], []);
  assert.doesNotMatch(second.answer.content, /Radar test planı|Haftalık durum toplantısı/);
});

test('göndergesiz takip (önceki analiz yok) veri okumadan açıklama ister', async (t) => {
  const { ask } = phase4eConversation(t);
  const result = await ask({ text: 'sadece gecikmişleri göster', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous', focus: ['overdue'] } } });
  assert.equal(result.answer.finishReason, 'clarification');
  assert.equal(result.log.length, 0);
});

test('olmayan satır göndergesi onarımla silinmez: önceki analizde satır yoksa veri okumadan açıklama istenir', async (t) => {
  const { ask } = phase4eConversation(t);
  await ask({ text: 'durumumu özetle', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'] } } });
  const result = await ask({ text: 'ilk kişiyi göster', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'row', rows: [1], focus: ['overview'] } } });
  assert.equal(result.answer.finishReason, 'clarification');
  assert.equal(result.inputs.length, 1, 'onarım turu yok');
  assert.equal(result.log.length, 0);
});

test('güvenilmeyen ad onarımı önceki özneye çevrilmez ve kaydı açıklatır', async (t) => {
  const plans = [
    { intent: 'rota', language: 'tr', analysis: { scope: 'project', names: ['Radar Modernizasyonu'], focus: ['overview'] } },
    { intent: 'rota', language: 'tr', analysis: { scope: 'project', names: ['Radar Modernizasyonu'], focus: ['workload'] }, visual: true },
    { intent: 'rota', language: 'tr', analysis: { scope: 'previous', focus: ['workload'] }, visual: true },
    { intent: 'clarify', language: 'tr', clarify: { reason: 'missing_referent' } }
  ];
  const { ask } = phase4eConversation(t, { planner: () => planCall(plans.shift()) });
  await ask({ text: 'Radar Modernizasyonu projesini özetle' });
  const result = await ask({ text: 'bunu grafikle göster' });
  // Öncekiyle aynı yazılan ad bile güvenilir kimlik eşlemesi olmadan özne değişimine izin vermez.
  assert.equal(result.inputs.length, 3);
  assert.match(systemText(result.inputs[1].messages), /untrusted/u, 'güvenilmeyen ad onarıma gider');
  assert.equal(result.answer.finishReason, 'clarification');
  assert.equal(result.log.length, 0);
  assert.match(result.answer.content, /adını veya kodunu/u);
});

test('analitik özette açık grafik isteği aday yoksa sessizce düşmez: sunucu düzeni kısa not ekler', async (t) => {
  const { ask } = phase4eConversation(t, { composition: false });
  const result = await ask({ text: 'bu haftaki kritik işlerimi grafikle göster',
    plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['critical'], dateFrom: '2026-09-28', dateTo: '2026-10-04' }, visual: true } });
  assert.equal(result.answer.finishReason, 'stop');
  const charted = result.answer.content.includes('```rota-chart');
  const noted = result.answer.content.includes('güvenle grafik çizilemedi');
  assert.ok(charted !== noted, 'ya grafik ya da kısa açıklama (ikisi birden değil)');
});

/* ── Yanıt ayrıntısı ────────────────────────────────────────────────── */

test('yanıt ayrıntısı kapalı sözlüktür ve sunum sözleşmesini değiştirir (çıktı belirteci sınırı değildir)', async (t) => {
  assert.deepEqual(ANSWER_DETAILS, ['short', 'balanced', 'detailed']);
  assert.equal(normalizeAnswerDetail('x'), 'balanced');
  assert.ok(ANSWER_DETAIL_CONTRACT.short.minNarrated < ANSWER_DETAIL_CONTRACT.balanced.minNarrated);
  assert.ok(ANSWER_DETAIL_CONTRACT.balanced.minNarrated < ANSWER_DETAIL_CONTRACT.detailed.minNarrated);
  const { sendTurn } = await import('./helpers/aiStack.mjs');
  const { ask } = phase4eConversation(t, { composition: false });
  const plan = { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'overdue'] } };
  const short = await ask({ text: 'durumumu değerlendir', plan }, { detail: 'short' });
  const detailed = await ask({ text: 'durumumu ayrıntılı değerlendir', plan }, { detail: 'detailed' });
  assert.equal(short.answer.finishReason, 'stop');
  assert.equal(detailed.answer.finishReason, 'stop');
  assert.ok(detailed.answer.content.length > short.answer.content.length, 'ayrıntılı yanıt daha fazla doğrulanmış gözlem taşır');
  assert.match(detailed.answer.content, /"type":"kpi"/, 'ayrıntılı genel görünümde gösterge kartları');
  const invalid = await sendTurn({ turnId: '00000000-0000-4000-8000-0000000000aa', message: 'x', mode: 'standard', detail: 'verbose' });
  assert.equal(invalid.status, 400);
  assert.match(invalid.text, /DETAIL_INVALID/);
});

test('Ayarlar: Bilgin yanıt ayrıntısı yalnızca Bilgin açıkken görünür ve görünüm tercihine yazılır', async (t) => {
  const { SettingsView } = await import('../src/features/settings/SettingsView.jsx');
  const { TWEAK_DEFAULTS } = await import('../src/lib/tweaks-defaults.js');
  assert.equal(TWEAK_DEFAULTS.assistantDetail, 'balanced');
  const previous = globalThis.__MERGEN_ROTA_FEATURES__;
  t.after(() => { globalThis.__MERGEN_ROTA_FEATURES__ = previous; });
  const card = (tree) => findElement(tree, (node) => typeof node?.type === 'function' && node.type.name === 'AssistantAnswerSettings');
  const edits = [];
  globalThis.__MERGEN_ROTA_FEATURES__ = { assistant: true };
  const enabled = mountComponent(SettingsView, { t: { ...TWEAK_DEFAULTS, assistantDetail: 'detailed' }, setTweak: (key, value) => edits.push([key, value]) }).output;
  const found = card(enabled);
  assert.ok(found);
  assert.equal(found.props.value, 'detailed');
  found.props.onChange('short');
  assert.deepEqual(edits, [['assistantDetail', 'short']]);
  globalThis.__MERGEN_ROTA_FEATURES__ = { assistant: false };
  assert.equal(card(mountComponent(SettingsView, { t: TWEAK_DEFAULTS, setTweak: () => {} }).output), null);
});

/* ── Mimari: anlamsal yönlendirme yok ───────────────────────────────── */

test('analitik özet açılımı ve analist önermeleri kullanıcı metnini yorumlamaz (anahtar sözcük/düzenli ifade yönlendirmesi yok)', () => {
  const source = readFileSync(new URL('../src/server/ai/tools/analysisPlan.js', import.meta.url), 'utf8');
  for (const forbidden of ['userText', 'question', 'message', 'content', 'toLowerCase', '.match(', 'RegExp']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  const context = readFileSync(new URL('../src/domain/ai/analysisContext.js', import.meta.url), 'utf8');
  assert.equal(/userText|question|message/.test(context), false);
  // Planlayıcı notları ve yönergesi sunucunun sabit metnidir; Türkçe sözcük tablosu ya da eşanlam sözlüğü yoktur.
  const plan = readFileSync(new URL('../src/server/ai/assistant/groundedAnswer.js', import.meta.url), 'utf8');
  // Yorumlar ve modele giden sabit not metni dışında kod, kullanıcı ifadesine göre dallanmaz.
  const executable = plan.replace(/`Önceki doğrulanmış analiz[\s\S]*?`;/, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  assert.equal(/değerlendir|bu hafta|ekibim/.test(executable), false, 'sunucu dönüşü sözcüğe göre dallanmaz');
});

/* PR #109: fiziksel okuma, kalıcılık ve nihai çizim sınırları. */
test('karşılaştırma bütçesi tüm fiziksel okumaları kabul eder veya SQL öncesinde tüm planı reddeder', async (t) => {
  const people = { scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'] };
  const window = { dateFrom: '2026-10-01', dateTo: '2026-10-31' };
  // Aşama F: iki kişi × iki dağılım yönü (4 okuma) fiziksel sınıra sığar; üçüncü dağılım yönü (6 okuma) sığmaz.
  for (const focus of [['priority', 'schedule', 'deadlines'], ['schedule', 'deadlines', 'priority']]) {
    const rejected = { ...people, focus, ...window };
    assert.throws(() => expandAnalysis(parseAnalysis(rejected), { today: '2026-09-30' }), (error) => error.details.includes('$.analysis.focus:requestBudget'));
  }
  assert.equal(expandAnalysis(parseAnalysis({ ...people, focus: ['priority', 'schedule'], ...window }), { today: '2026-09-30' }).length, 4);
  await t.test('reddedilen plan kısmi okuma yapmaz', async (t) => {
    const plans = [{ intent: 'rota', language: 'tr', analysis: { ...people, focus: ['priority', 'schedule', 'deadlines'], ...window } },
      { intent: 'clarify', language: 'tr', clarify: { reason: 'ambiguous' } }];
    const { ask } = phase4eConversation(t, { planner: () => planCall(plans.shift()) });
    const result = await ask({ text: 'Ayşe Yılmaz ve Zeynep Kaya için ekim önceliklerini ve aylık terminlerini karşılaştır' });
    assert.equal(result.answer.finishReason, 'clarification');
    assert.equal(result.log.length, 0);
    assert.match(systemText(result.inputs[1].messages), /analysis\.focus:requestBudget/);
  });
  await t.test('sığan karşılaştırmanın ufku gerçekten okunur', async (t) => {
    const { ask } = phase4eConversation(t);
    const result = await ask({ text: 'Ayşe Yılmaz ve Zeynep Kaya için ekim genel durumunu ve aylık terminlerini karşılaştır',
      plan: { intent: 'rota', language: 'tr', analysis: { ...people, focus: ['overview', 'schedule'], ...window } } });
    assert.equal(result.answer.finishReason, 'stop', result.answer.content);
    const reads = populationReads(result.log);
    for (const person of [AYSE, ZEYNEP]) assert.ok(reads.some(({ params }) => params.personSicil === person
      && params.dateFrom === window.dateFrom && params.dateTo === window.dateTo));
  });
});

test('önceki kişi karşılaştırması within ile daralınca her üretim okuması kişi ∩ proje olur', async (t) => {
  for (const focus of ['overview', 'priority', 'schedule']) await t.test(`analiz yönü: ${focus}`, async (t) => {
    const { ask } = phase4eConversation(t);
    const first = await ask({ text: 'Ayşe Yılmaz ve Zeynep Kaya durumlarını karşılaştır',
      plan: { intent: 'rota', language: 'tr', analysis: { scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'], focus: ['overview'] } } });
    assert.equal(first.answer.finishReason, 'stop');
    const result = await ask({ text: 'yalnızca Radar Modernizasyonu projesinde',
      plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous', within: 'Radar Modernizasyonu', focus: [focus],
        ...(focus === 'schedule' ? { dateFrom: '2026-09-01', dateTo: '2026-12-31' } : {}) } } });
    assert.equal(result.answer.finishReason, 'stop', result.answer.content);
    const reads = populationReads(result.log);
    assert.ok(reads.length >= 2);
    assert.deepEqual(new Set(reads.map(({ params }) => params.personSicil)), new Set([AYSE, ZEYNEP]));
    assert.ok(reads.every(({ params }) => params.assigneeMode === 'person' && String(params.projectId).toLowerCase() === PROJECTS.FULL));
    if (focus === 'schedule') assert.ok(reads.every(({ params }) => params.dateFrom === '2026-09-01' && params.dateTo === '2026-12-31'));
  });
});

test('analiz onarım önerisi temsil edemediği hiçbir süzgeci düşürmez', () => {
  const request = (filters) => ({ population: { tool: 'rota_task_analytics', groupBy: 'status' }, filters });
  for (const extra of [{ previousResult: { type: 'task', from: 1 } }, { entities: [null] }, { filters: 'invalid' }]) {
    assert.equal(analysisSuggestion({ ...request({}), ...extra }), null);
  }
  // Dönemli durum dağılımı artık özetle birebir temsil edilir (status yönü ufku taşır); öneri tarihleri korur.
  assert.match(analysisSuggestion(request({ dateFrom: '2026-09-01', dateTo: '2026-09-30' })), /"focus":\["status"\],"dateFrom":"2026-09-01","dateTo":"2026-09-30"/);
  for (const filters of [{ status: ['done'] }, { priority: ['high'] },
    { milestone: true }, { createdByMe: true }, { text: 'görev' }, { period: 'last_7_days' }, { assignee: 'unassigned' }]) {
    assert.equal(analysisSuggestion(request(filters)), null, JSON.stringify(filters));
  }
  for (const filters of [{ priority: ['high'] }, { status: ['done'], dateFrom: '2026-10-01' }, { deadline: 'due_next_30_days' },
    { deadline: 'overdue', dateTo: '2026-09-01' }, { dateFrom: '2026-02-31' }]) {
    assert.equal(analysisSuggestion({ population: { tool: 'rota_task_search' }, filters }), null, JSON.stringify(filters));
  }
  const filters = { assignee: 'me', status: ['todo', 'in_progress'], dateFrom: '2026-10-01', dateTo: '2026-10-31' };
  const suggested = analysisSuggestion({ population: { tool: 'rota_task_search' }, filters });
  assert.ok(suggested);
  const brief = JSON.parse(/\{.*\}/.exec(suggested)[0]).analysis;
  const [expanded] = expandAnalysis(parseAnalysis(brief), { today: '2026-09-30' });
  assert.deepEqual(expanded.filters, filters);
});

test('geçmiş ufuklu analiz üretim akışında yaklaşan iş okumaz ve kalıcı bağlamı aynı yönü taşır', async (t) => {
  for (const focus of ['overview', 'overdue']) await t.test(`analiz yönü: ${focus}`, async (t) => {
    const { ask } = phase4eConversation(t);
    const result = await ask({ text: 'geçen hafta durumumu değerlendir',
      plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: [focus], dateTo: '2026-09-28' } } });
    assert.equal(result.answer.finishReason, 'stop', result.answer.content);
    assert.doesNotMatch(result.answer.content, /Yaklaşan görevler/);
    const reads = populationReads(result.log);
    assert.ok(reads.some(({ params }) => params.dateTo === '2026-09-28'));
    assert.ok(reads.every(({ params }) => !params.dateFrom || params.dateFrom <= '2026-09-28'));
    const next = await ask({ text: 'aynı kapsamın genel durumu', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous', focus: ['overview'] } } });
    assert.match(systemText(next.inputs[0].messages), /"focus":\["(?:overview|overdue)"\]/);
  });
});

test('ekip iş yükü sıfır yüklü kadroyu veya çözümlenmeyen atamayı tam saymaz', async (t) => {
  for (const unresolved of [false, true]) await t.test(`davranış durumu: ${unresolved ? 'çözümlenmeyen üye' : 'sıfır yüklü üye'}`, async (t) => {
    const seed = rotaToolSeed();
    const members = [MEHMET, ZEYNEP, LEAD];
    seed.executiveScope = [...members, 910004].map((EmployeeSicil) => ({ ManagerSicil: AYSE, EmployeeSicil, ScopeType: 'UNIT' }));
    seed.tasks = seed.tasks.filter((task) => task.ProjectId === PROJECTS.FULL).slice(0, 6).map((task) => ({ ...task, Status: 'planned' }));
    assert.equal(seed.tasks.length, 6);
    seed.taskAssignees = seed.tasks.map((task, index) => ({ TaskId: task.TaskId, Sicil: members[Math.floor(index / 2)] }));
    // Kapsam dışı ama FULL projede kimliği görünür eş sorumlu kişi satırlarına giremez.
    seed.taskAssignees.push({ TaskId: seed.tasks[0].TaskId, Sicil: AYSE });
    if (unresolved) seed.people = seed.people.filter((person) => person.Sicil !== LEAD);
    const { stack, ask } = phase4eConversation(t, { seed, composition: false });
    const result = await ask({ text: 'ekibimin iş yükü dengeli mi', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'team', focus: ['workload'] } } });
    assert.equal(result.answer.finishReason, 'stop', result.answer.content);
    assert.doesNotMatch(result.answer.content, /görece dengeli|bu kişide yoğunlaşıyor/);
    const { result: workload } = await callRotaTool(stack, AYSE, 'rota_workload_summary', { assignee: 'team' });
    assert.equal(workload.ok, true);
    const data = workload.data;
    assert.equal(data.populationComplete, false);
    assert.equal(data.openTaskCount, 6);
    assert.equal(data.unrepresentedOpenTasks, unresolved ? 2 : 0);
    assert.equal(data.representedOpenTasks + data.unrepresentedOpenTasks + data.unassignedOpenTasks, data.openTaskCount);
    assert.equal(data.people.some((person) => person.sicil === AYSE || person.sicil === 910004), false);
    if (unresolved) assert.equal(JSON.stringify(data).includes(String(LEAD)), false, 'çözümlenmeyen kimlik açılmaz');
    assert.ok(populationReads(result.log).every(({ params }) => params.assigneeMode === 'team'));
  });
});

test('satır takibi yürütme sırası yerine doğrulanmış görünür bölüm sırasını kullanır', async (t) => {
  const logs = captureConsole(t);
  const { ask } = phase4eConversation(t, { compose: () => composer((view) => {
    const blocks = coveringBlocks(view).blocks;
    const parts = [...new Set(view.tables.map((table) => table.part))].reverse();
    const lead = blocks.find((block) => block.type === 'say');
    assert.ok(lead);
    return { blocks: [lead, ...parts.flatMap((part) => [
      ...(view.titles || []).filter((title) => title.part === part).map((title) => ({ type: 'title', source: title.id })),
      ...blocks.filter((block) => block !== lead).filter((block) => block.type === 'say' ? view.propositions.some((item) => item.id === block.items[0] && item.part === part)
        : view.tables.some((item) => item.id === block.source && item.part === part) || view.details.some((item) => item.id === block.source && item.part === part))
    ])] };
  }) });
  const first = await ask({ text: 'görebildiğim işlerin kişilere ve projelere dağılımını değerlendir',
    plan: { intent: 'rota', language: 'tr', analysis: { scope: 'all', focus: ['workload', 'projects'] } } });
  assert.equal(first.answer.finishReason, 'stop');
  const presentation = logs.filter((row) => row.includes('"operation":"ai.grounded.turn"')).map((row) => JSON.parse(row.slice(row.indexOf('{')))).at(-1).context.presentation;
  assert.equal(presentation.server, false, `yeniden sıralanan MODEL düzeni kabul edildi: ${JSON.stringify(presentation)}`);
  assert.ok(first.answer.content.indexOf('| Proje |') < first.answer.content.indexOf('| Kişi |'), 'proje satırları gerçekten önce çizildi');
  const projectName = first.answer.content.match(/\| (Radar Modernizasyonu|Kısmi Proje|Ekip Projesi|Okuma Projesi) \|/)?.[1];
  assert.ok(projectName, first.answer.content);
  const expected = { 'Radar Modernizasyonu': PROJECTS.FULL, 'Kısmi Proje': PROJECTS.PARTIAL, 'Ekip Projesi': PROJECTS.TEAM, 'Okuma Projesi': PROJECTS.READ }[projectName];
  const next = await ask({ text: 'ilk projenin durumunu değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'row', rows: [1], focus: ['overview'] } } });
  assert.equal(next.answer.finishReason, 'stop', next.answer.content);
  const reads = populationReads(next.log);
  assert.ok(reads.length && reads.every(({ params }) => String(params.projectId).toLowerCase() === expected && params.personSicil == null));
});

test('kanonik bütün grafik türleri sunum telemetrisinde korunur', async (t) => {
  const { ANSWER_CHART_TYPES } = await import('../src/domain/ai/answerChart.js');
  const { recordGroundedTurn } = await import('../src/server/ai/aiTelemetry.js');
  const logs = captureConsole(t);
  for (const chart of ANSWER_CHART_TYPES) recordGroundedTurn({ outcome: 'grounded', presentation: { mode: 'composed', chart, charts: 1 } });
  const charts = logs.filter((row) => row.includes('"operation":"ai.grounded.turn"')).map((row) => JSON.parse(row.slice(row.indexOf('{')))).map((row) => row.context.presentation.chart);
  assert.deepEqual(charts, ANSWER_CHART_TYPES);
});

test('kalıcı analiz tarihi gerçek takvim günüdür ve plan doğrulamasıyla aynıdır', async () => {
  const { isIsoDay } = await import('../src/server/ai/tools/toolArguments.js');
  const base = { v: 1, scope: 'self', subjects: [], focus: ['overview'] };
  for (const day of ['2024-02-29', '2026-02-28', '1900-01-01', '2100-12-31']) {
    assert.ok(isIsoDay(day));
    for (const key of ['dateFrom', 'dateTo']) assert.ok(normalizeAnalysisContext({ ...base, [key]: day }), day);
  }
  for (const day of ['2026-02-29', '2026-02-30', '2026-02-31', '2026-04-31', '1900-02-29', '1899-12-31', '2101-01-01']) {
    assert.equal(isIsoDay(day), false);
    for (const key of ['dateFrom', 'dateTo']) assert.equal(normalizeAnalysisContext({ ...base, [key]: day }), null, day);
  }
});

test('planlayıcı filtre özeti ekip sözleşmesini tek ve tutarlı biçimde tanımlar', async () => {
  const { groundedSystemPrompt } = await import('../src/server/ai/assistant/groundedPrompt.js');
  const summary = groundedSystemPrompt(new Date('2026-09-30T09:00:00Z')).split('\n').filter((line) => line.startsWith('- filters:'));
  assert.equal(summary.length, 1);
  assert.match(summary[0], /assignee: me\|unassigned\|team/);
  assert.match(summary[0], /teamLevel: unit\|department\|directorate \(yalnızca assignee team ile\)/);
});

test('yedi günlük aciliyetin bağımsız ve birleşik tüm biçimleri bugünü içerdiğini söyler', () => {
  const total = (metric, value) => ({ evidenceId: 'R1', fact: { field: `data.totals.${metric.split('.')[1]}`, value,
    semantic: { metric, complete: true, provenance: { tool: 'rota_task_analytics' } } } });
  for (const locale of ['tr', 'en']) {
    const propositions = analystPropositions([{ index: 0, presentation: { facts: [total('tasks.open', 6), total('tasks.overdue', 3), total('tasks.dueNext7Days', 2)] } }], locale);
    const urgency = propositions.find((item) => item.proposition.kind === 'urgency').proposition;
    const wording = locale === 'tr' ? /[Bb]ugün başlayan yedi günlük dönemde/ : /in the seven-day period starting today/;
    assert.match(urgency.plain, wording);
    for (const form of ['also', 'plain', 'contrast']) assert.match(urgency.fluent.follow[form].filter((item) => typeof item === 'string').join(''), wording);
    assert.match(fluentParagraph(propositions.map(({ proposition }) => ({ proposition })), locale), wording);
  }
});

test('109 son: proje satırı takibi kendi ve bölüm nüfuslarını korur ve yeniden yetkilendirir', async (t) => {
  for (const scope of ['self', 'team']) await t.test(`davranış durumu: ${scope === 'self' ? 'kendi nüfusu' : 'ekip nüfusu'}`, async (t) => {
    const seed = rotaToolSeed();
    seed.executiveScope = [{ ManagerSicil: AYSE, EmployeeSicil: ZEYNEP, ScopeType: 'DEPARTMENT' }];
    const { ask, stack } = phase4eConversation(t, { seed, composition: false });
    const first = await ask({ text: 'projelerdeki işlerimiz', plan: { intent: 'rota', language: 'tr', analysis: { scope, ...(scope === 'team' ? { level: 'department' } : {}), focus: ['projects'] } } });
    assert.equal(first.answer.finishReason, 'stop');
    const follow = () => ask({ text: 'ilk projenin durumu', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'row', rows: [1], focus: ['overview'] } } });
    const next = await follow();
    assert.equal(next.answer.finishReason, 'stop', next.answer.content);
    const reads = populationReads(next.log);
    assert.ok(reads.length);
    assert.ok(reads.every(({ params }) => params.projectId && params.assigneeMode === (scope === 'self' ? 'me' : 'team') && (scope === 'self' || params.teamLevel === 'DEPARTMENT')));
    if (scope === 'team') {
      stack.db.executiveScope = [];
      const denied = await ask({ text: 'aynı nüfusun durumu', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous', focus: ['overview'] } } });
      assert.notEqual(denied.answer.finishReason, 'stop');
      assert.match(denied.answer.content, /yönetim kapsamınız bulunmuyor/);
    }
  });
});

test('109 son: numaralı açıklama seçimi kanonik analiz öznesini geri yükler ve yeniden yetkilendirir', async (t) => {
  for (const revoke of [false, true]) await t.test(`davranış durumu: ${revoke ? 'yetki kaldırılmış' : 'yetki geçerli'}`, async (t) => {
    const { ask, stack } = phase4eConversation(t, { composition: false });
    const first = await ask({ text: 'Zeynep Kaya durumunu değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'person', names: ['Zeynep Kaya'], focus: ['overview'] } } });
    assert.equal(first.answer.finishReason, 'stop');
    stack.db.projects.find((row) => String(row.ProjectId).toLowerCase() === PROJECTS.READ).ProjectName = 'Radar Denemesi';
    const narrow = { intent: 'rota', language: 'tr', analysis: { scope: 'previous', within: 'Radar', focus: ['overview'] } };
    const ambiguous = await ask({ text: 'Radar projesinde değerlendir', plan: narrow });
    assert.equal(ambiguous.answer.finishReason, 'clarification', ambiguous.answer.content);
    assert.equal(populationReads(ambiguous.log).length, 0);
    if (revoke) {
      stack.db.executiveScope = [];
      stack.db.tasks = stack.db.tasks.filter((row) => String(row.ProjectId).toLowerCase() !== PROJECTS.FULL);
    }
    const selected = await ask({ text: '1', plan: narrow });
    if (revoke) {
      // Adaylar eşdeğer güncel erişimle doğrulanabilir; seçilen özne yine yalnızca güncel (kaldırılmış) kapsamla okunur.
      assert.doesNotMatch(selected.answer.content, /Anten kalibrasyonu/);
      // Seçilen özne yeniden okunmalıdır: okuma yoksa boş küme üzerinde `every` hiçbir şey kanıtlamaz.
      const reads = populationReads(selected.log);
      assert.ok(reads.length > 0, 'seçilen özne güncel kapsamla yeniden okunmalı');
      assert.ok(reads.every(({ params }) => params.assigneeMode === 'person' && params.personSicil === ZEYNEP
        && !String(params.scopeTasks).toLowerCase().includes(TASKS.TEAM_VISIBLE)));
    } else {
      assert.equal(selected.answer.finishReason, 'stop', selected.answer.content);
      const reads = populationReads(selected.log);
      assert.ok(reads.length);
      assert.ok(reads.every(({ params }) => params.assigneeMode === 'person' && params.personSicil === ZEYNEP && params.projectId));
    }
  });
});

test('109 son: analiz onarımı etkilenmeyen kapsamı odağı adları ufku veya görsel isteğini değiştiremez', async (t) => {
  for (const changed of ['scope', 'focus', 'names', 'dateFrom', 'visual', 'level', 'within']) await t.test(`davranış durumu: ${({ scope: 'kapsam', focus: 'odak', names: 'adlar', dateFrom: 'başlangıç tarihi', visual: 'görsel istek', level: 'ekip düzeyi', within: 'proje daraltması' })[changed]}`, async (t) => {
    const analysis = changed === 'names' ? { scope: 'person', names: ['Zeynep Kaya'], focus: ['overview'] }
      : { scope: 'team', level: 'department', within: 'Radar', focus: ['workload'], dateFrom: '2026-10-01', dateTo: '2026-10-31', visual: true };
    const alternative = { ...analysis, [changed]: { scope: 'all', focus: ['overview'], names: ['Ayşe Yılmaz'], dateFrom: '2026-10-02', visual: false, level: 'unit', within: 'Okuma' }[changed] };
    if (changed === 'scope') { delete alternative.level; delete alternative.within; }
    const plans = [{ intent: 'rota', analysis }, { intent: 'rota', language: 'tr', analysis: alternative }, { intent: 'clarify', language: 'tr', clarify: { reason: 'ambiguous' } }];
    const { ask } = phase4eConversation(t, { planner: () => planCall(plans.shift()) });
    const answer = await ask({ text: 'Radar ve Okuma; Zeynep Kaya ve Ayşe Yılmaz durumları' });
    assert.equal(answer.answer.finishReason, 'clarification');
    assert.equal(answer.log.length, 0, 'anlamı değiştirilen özet korumalı okumaya ulaşamaz');
    assert.ok(answer.inputs.length >= 3, 'anlam değişikliği için yeni bir karar gerekir');
  });
  await t.test('yalnızca eksik dil alanı onarılır', async (t) => {
    const analysis = { scope: 'self', focus: ['overview'] };
    const plans = [{ intent: 'rota', analysis }, { intent: 'rota', language: 'tr', analysis }];
    const { ask } = phase4eConversation(t, { planner: () => planCall(plans.shift()) });
    assert.equal((await ask({ text: 'durumum' })).answer.finishReason, 'stop');
  });
});

test('109 son: desteklenmeyen proje odağı başarılı genel görünüme dönüştürülmez', async (t) => {
  const plans = [{ intent: 'rota', language: 'tr', analysis: { scope: 'project', names: ['Radar'], focus: ['projects'] } },
    { intent: 'rota', language: 'tr', analysis: { scope: 'project', names: ['Radar'], focus: ['overview'] } },
    { intent: 'clarify', language: 'tr', clarify: { reason: 'ambiguous' } }];
  const { ask } = phase4eConversation(t, { planner: () => planCall(plans.shift()) });
  const result = await ask({ text: 'Radar projelerine göre' });
  assert.equal(result.answer.finishReason, 'clarification');
  assert.equal(result.log.length, 0);
});

test('109 son: kendi iş yükü kabul edilen iki tarih sınırını da korur', () => {
  const analysis = parseAnalysis({ scope: 'self', focus: ['workload'], dateFrom: '2026-10-01', dateTo: '2026-10-31' });
  const [workload] = expandAnalysis(analysis, { today: '2026-10-15' });
  assert.equal(workload.filters.dateFrom, '2026-10-01');
  assert.equal(workload.filters.dateTo, '2026-10-31');
});

test('109 son: yaklaşan işler kanonik ufku değiştirmeden geçmiş terminleri dışarıda bırakır', () => {
  const analysis = parseAnalysis({ scope: 'self', focus: ['overdue', 'upcoming'], dateFrom: '2026-10-01', dateTo: '2026-10-31' });
  const [overdue, upcoming] = expandAnalysis(analysis, { today: '2026-10-15' });
  assert.equal(overdue.filters.deadline, 'overdue');
  assert.equal(upcoming.filters.dateFrom, '2026-10-15');
  assert.equal(upcoming.filters.dateTo, '2026-10-31');
  assert.equal(analysis.dateFrom, '2026-10-01');
  assert.equal(expandAnalysis(analysis, { today: null })[1].filters.dateFrom, '2026-10-01');
  assert.equal(expandAnalysis(parseAnalysis({ scope: 'self', focus: ['upcoming'], dateTo: '2026-10-31' }), { today: '2026-10-15' })[0].filters.dateFrom, '2026-10-15');
});

test('109 son: sorumlu analizi onarımı iş yükünün açık görev nüfusuyla tam eşleşmelidir', () => {
  const base = { operation: 'list', metrics: ['person.name', 'tasks.open'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy: 'assignee' } };
  assert.equal(analysisSuggestion(base), null);
  for (const status of [[], ['todo'], ['todo', 'in_progress', 'done']]) assert.equal(analysisSuggestion({ ...base, filters: { status } }), null);
  assert.match(analysisSuggestion({ ...base, filters: { status: ['in_progress', 'todo'] } }), /workload/);
});

test('109 son: nitelendirme Türkçe kurallarla normalleştirilmiş ad kümesini tam olarak ister', async () => {
  const { plannerScore } = await import('../scripts/analysis-qualification.mjs');
  const score = (names) => plannerScore({ outcome: 'planned', decisions: [{ intent: 'rota' }], plan: { requests: names.map((query) => ({ entities: [{ type: 'project', query }], filters: {}, population: { tool: 'rota_task_search' } })) } }, { intent: 'rota', scope: 'project', names: ['PAYKDM'] });
  assert.deepEqual(score(['paykdm']), []);
  assert.ok(score(['PAYKDM', 'PAY']).length);
  assert.ok(score(['PAY']).length);
});

test('109 son: nitelendirme doğru aralıklı okumanın yanındaki yanlış tarih aralığını reddeder', async () => {
  const { plannerScore } = await import('../scripts/analysis-qualification.mjs');
  const request = (filters) => ({ entities: [], filters: { assignee: 'me', ...filters }, population: { tool: 'rota_task_search' } });
  const score = (requests) => plannerScore({ outcome: 'planned', decisions: [{ intent: 'rota' }], plan: { requests } }, { intent: 'rota', scope: 'self', window: ['2026-10-01', '2026-10-31'] });
  const correct = request({ dateFrom: '2026-10-01', dateTo: '2026-10-31' });
  assert.deepEqual(score([request({}), correct]), []);
  assert.ok(score([correct, request({ dateFrom: '2026-11-01', dateTo: '2026-11-30' })]).length);
});

test('109 son: karşılaştırma sınamaları eksik ikinci kişiyi ve ek kişiyi reddeder', () => {
  const reads = (people) => ({ answer: { finishReason: 'stop' }, log: people.map((personSicil) => ({ query: 'task-facts', params: { personSicil, assigneeMode: 'person' } })) });
  const comparison = followups.chains.find((chain) => chain.id === 'H').turns[0].expect;
  assert.deepEqual(comparison.people, [AYSE, ZEYNEP]);
  assert.deepEqual(turnViolations(reads([ZEYNEP, AYSE, AYSE]), comparison), []);
  assert.ok(turnViolations(reads([AYSE, AYSE]), comparison).length);
  assert.ok(turnViolations(reads([AYSE, ZEYNEP, MEHMET]), comparison).length);
});

test('109 son: boş planlayıcı veya düzenleyici davranışı sahte sağlayıcının boş davranış sözleşmesine uyar', async (t) => {
  for (const mode of ['planner', 'compose']) await t.test(`davranış durumu: ${mode === 'planner' ? 'planlayıcı' : 'düzenleyici'}`, async (t) => {
    const { ask } = phase4eConversation(t, mode === 'planner' ? { planner: () => null } : { compose: () => null });
    const result = await ask({ text: 'durumumu değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview'] } } });
    assert.notEqual(result.answer.finishReason, 'error', result.answer.content);
    if (mode === 'compose') assert.equal(result.answer.finishReason, 'stop');
  });
});

test('109 son: kesirli yığılmış satırlar gösterilen değerleri değiştirmeden çubuğu doldurur', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const spec = normalizeAnswerChart({ version: 1, type: 'stacked', title: 'Fractions', locale: 'en', evidence: ['R1'], unit: 'number', series: ['A', 'B'],
    items: [{ label: 'Fraction', values: [0.2, 0.3] }, { label: 'Zero', values: [0, 0] }] });
  assert.ok(spec);
  const html = renderToStaticMarkup(createElement(AnswerChart, { spec }));
  const grows = [...html.matchAll(/flex-grow:([\d.]+)/g)].map((match) => Number(match[1]));
  assert.deepEqual(grows, [0.4, 0.6, 0, 0]);
  assert.match(html, /Fraction: A 0.2, B 0.3/);
  assert.equal(answerChartText(spec).includes('0.2\t0.3'), true);
});

test('109 son: bölümlü ayarlar etiketli grup ve tam bir basılı seçenek bildirir', async (t) => {
  const { SettingsView } = await import('../src/features/settings/SettingsView.jsx');
  const { TWEAK_DEFAULTS } = await import('../src/lib/tweaks-defaults.js');
  const previous = globalThis.__MERGEN_ROTA_FEATURES__;
  t.after(() => { globalThis.__MERGEN_ROTA_FEATURES__ = previous; });
  globalThis.__MERGEN_ROTA_FEATURES__ = { assistant: true };
  const edits = [];
  const tree = mountComponent(SettingsView, { t: { ...TWEAK_DEFAULTS, assistantDetail: 'detailed' }, setTweak: (key, value) => edits.push([key, value]) }).output;
  const visit = (node, result = []) => {
    if (Array.isArray(node)) { node.forEach((child) => visit(child, result)); return result; }
    if (!node || typeof node !== 'object') return result;
    if (typeof node.type === 'function') return ['Segmented', 'AssistantAnswerSettings', 'SettingsRow'].includes(node.type.name) ? visit(mountComponent(node.type, node.props).output, result) : visit(node.props?.children, result);
    if (node.props?.className === 'seg' && node.props.role === 'group') result.push(node);
    visit(node.props?.children, result);
    return result;
  };
  const groups = visit(tree);
  assert.deepEqual(groups.map((node) => node.props['aria-label']).sort(), ['Tema', 'Yoğunluk', 'Tarih biçimi', 'Yanıt ayrıntısı'].sort());
  for (const group of groups) {
    const buttons = group.props.children;
    assert.equal(buttons.filter((button) => button.props['aria-pressed'] === true).length, 1);
    assert.ok(buttons.every((button) => typeof button.props['aria-pressed'] === 'boolean'));
  }
  groups.find((node) => node.props['aria-label'] === 'Yanıt ayrıntısı').props.children[0].props.onClick();
  assert.deepEqual(edits, [['assistantDetail', 'short']]);
});

test('109 son: kısa kip açık tablo ve grafik isteğini korurken modelin seçtiği tabloları sadeleştirir', async (t) => {
  const { verifyRequested } = await import('./helpers/requestScenario.mjs');
  const stack = createAiStack(t, { sicil: AYSE, seed: rotaToolSeed() });
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_analytics', { groupBy: 'status' });
  for (const explicit of [false, true]) {
    const verdict = verifyRequested(ledger, ['data.groups.*.label', 'data.groups.*.count'], {
      operation: 'list', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy: 'status' }, layout: explicit ? 'table' : 'auto'
    }, { layout: 'table' });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
    const sheet = buildComposition({ parts: [{ index: 0, presentation: verdict.presentation }], detail: 'short', visual: true });
    assert.ok(sheet?.render.charts.size);
    const checked = defaultComposition(sheet);
    assert.equal(checked?.ok, true);
    const rendered = renderComposition(sheet, checked);
    assert.equal(rendered.charts, 1);
    assert.equal(checked.blocks.find((block) => block.type === 'rows').style, explicit ? 'table' : 'list');
    assert.equal(rendered.text.includes('| '), explicit);
  }
});

test('109 son: yedek grafik seçiminde analiz bölümü grafik türünden önce gelir', async () => {
  const { preferredChart } = await import('../src/domain/ai/groundedComposition.js');
  for (const first of ['bar', 'timeline', 'kpi']) {
    const charts = new Map([['G1', { id: 'G1', part: 1, types: [first] }], ['G2', { id: 'G2', part: 2, types: ['stacked'] }]]);
    // Gösterge kartları (KPI) veri grafiği değildir: açık grafik isteğinde başka bölümde veri grafiği varsa o seçilir.
    assert.deepEqual(preferredChart({ charts }), first === 'kpi' ? { id: 'G2', style: 'stacked' } : { id: 'G1', style: first });
    charts.set('G3', { id: 'G3', part: 1, types: ['donut'] });
    assert.deepEqual(preferredChart({ charts }), { id: 'G3', style: 'donut' });
  }
});

test('109 son: kanıtlı kısmi kullanılamaz yanıt karşılanamayan grafik isteğini açıklar ancak kanıtsız yanıt açıklamaz', async (t) => {
  for (const noEvidence of [false, true]) await t.test(`davranış durumu: ${noEvidence ? 'kanıt yok' : 'kısmi kanıt var'}`, async (t) => {
    const { stack, ask } = phase4eConversation(t, { composition: false });
    stack.db.aiToolFailure = { get 'task-facts'() {
      return noEvidence || !stack.db.aiToolLog.at(-1)?.params.priorityCsv ? new Error('fixture unavailable') : null;
    } };
    const result = await ask({ text: 'kritik işlerim ve önceliklerim grafikle', plan: { intent: 'rota', language: 'tr', visual: true,
      analysis: { scope: 'self', focus: ['critical', 'priority'], dateFrom: '2027-01-01', dateTo: '2027-01-31' } } });
    assert.equal(result.answer.finishReason, 'unavailable');
    assert.equal(/【R\d+】/.test(result.answer.content), !noEvidence);
    assert.equal(result.answer.content.includes('güvenle grafik çizilemedi'), !noEvidence, result.answer.content);
    assert.equal(result.answer.content.includes('```rota-chart'), false);
  });
});

test('109 takip: bütünüyle geçmiş yaklaşan iş ufku doğrudan önceki ve karşılaştırmalı nüfuslarda reddedilir', () => {
  const window = { dateFrom: '2026-09-21', dateTo: '2026-09-27' };
  const previous = normalizeAnalysisContext({ v: 1, scope: 'self', subjects: [], focus: ['upcoming'] });
  for (const subject of [{ scope: 'self' }, { scope: 'previous' }, { scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'] },
    { scope: 'project', names: ['Radar', 'Okuma'] }]) {
    const analysis = parseAnalysis({ ...subject, focus: ['upcoming'], ...window });
    assert.throws(() => expandAnalysis(analysis, { today: '2026-09-30', previous }),
      (error) => error.details?.includes('$.analysis.dateTo:past'), JSON.stringify(subject));
    assert.ok(expandAnalysis(analysis, { today: null, previous }).every((request) => request.filters.dateFrom === window.dateFrom && request.filters.dateTo === window.dateTo));
  }
  const [pastSchedule] = expandAnalysis(parseAnalysis({ scope: 'self', focus: ['schedule'], ...window }), { today: '2026-09-30' });
  assert.equal(pastSchedule.filters.dateFrom, window.dateFrom, 'açıkça istenen geçmiş takvim gösterimi temsil edilebilir durumda kalır');
  assert.equal(pastSchedule.filters.dateTo, window.dateTo);
  const [current] = expandAnalysis(parseAnalysis({ scope: 'self', focus: ['upcoming'], dateFrom: window.dateFrom, dateTo: '2026-10-04' }), { today: '2026-09-30' });
  assert.deepEqual([current.filters.dateFrom, current.filters.dateTo], ['2026-09-30', '2026-10-04']);
});

test('109 takip: geçmiş haftaya yönelik önceki yaklaşan iş bildirimi korumalı okuma yapamaz', async (t) => {
  const plans = [{ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['upcoming'] } },
    { intent: 'rota', language: 'tr', analysis: { scope: 'previous', focus: ['upcoming'], dateFrom: '2026-09-21', dateTo: '2026-09-27' } },
    { intent: 'clarify', language: 'tr', clarify: { reason: 'ambiguous' } }];
  const { ask } = phase4eConversation(t, { composition: false, planner: () => planCall(plans.shift()) });
  assert.equal((await ask({ text: 'yaklaşan işlerim' })).answer.finishReason, 'stop');
  const result = await ask({ text: 'peki geçen hafta?' });
  assert.equal(result.answer.finishReason, 'clarification');
  assert.deepEqual(result.log, []);
  assert.match(systemText(result.inputs[1].messages), /\$\.analysis\.dateTo:past/);
});

test('109 takip: konuşma nitelendirmesi aralığı uyuşmayan her sınırlı okumayı reddeder', () => {
  const read = (params) => ({ query: 'task-facts', params });
  const result = (log) => ({ log, answer: { finishReason: 'stop', content: '' } });
  const expect = { window: ['2026-10-01', '2026-10-07'] };
  const good = read({ dateFrom: '2026-10-01', dateTo: '2026-10-07' });
  assert.deepEqual(turnViolations(result([read({}), good, good]), expect), [], 'aralıksız genel görünüm ve yinelenen doğru okumalar geçerlidir');
  for (const wrong of [{ dateFrom: '2026-10-08', dateTo: '2026-10-14' }, { dateFrom: '2026-10-01' }, { dateTo: '2026-10-07' }]) {
    assert.deepEqual(turnViolations(result([good, read(wrong)]), expect), ['ufuk 2026-10-01..2026-10-07 okunmadı']);
  }
  assert.deepEqual(turnViolations(result([read({})]), expect), ['ufuk 2026-10-01..2026-10-07 okunmadı']);
});
