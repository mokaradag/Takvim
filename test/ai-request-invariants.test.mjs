/**
 * Rota AI · istek sözleşmesinin değişmezleri (tablo tabanlı).
 *
 * İsteğin anlamı veri okunmadan türlü bildirimdedir: nüfus planın kendi nüfus
 * çağrılarıyla tamamlanır, çelişen ya da aracın ifade edemediği istek SQL'den
 * önce reddedilir. Her açık alan ve varlık bağı bir yükümlülüktür; boş çok
 * değerli alan bir değerdir; tamlık koleksiyona özgüdür; tazelik olgunun
 * sınıfına bağlıdır; satırlarla verilen toplam aynı koleksiyonu saymalıdır.
 * Sunucu seçimi ve model seçiminin doğrulaması aynı kuralları kullanır.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiStack } from './helpers/aiStack.mjs';
import { AYSE, NOW, PROJECTS, TASKS, callRotaTool, callRotaTools, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { parsedRequest, REQUEST_TODAY, verifyRequested } from './helpers/requestScenario.mjs';

const { createEvidenceFacts } = await import('../src/domain/ai/evidenceFacts.js');
const { analyzeGroundedAnswer } = await import('../src/domain/ai/evidenceVerification.js');
const { claimableContract } = await import('../src/domain/ai/claimableEvidence.js');
const { completeRequest } = await import('../src/server/ai/tools/requestPopulation.js');
const { requestEvidence, requestEvidenceReady, requestSelections } = await import('../src/server/ai/tools/requestDeclaration.js');
const { getRotaTool } = await import('../src/server/ai/tools/toolRegistry.js');
const requestDeclarationModule = await import('../src/server/ai/tools/requestDeclaration.js');
const { parseToolArguments } = await import('../src/server/ai/tools/toolArguments.js');

const populationModule = await import('../src/domain/ai/evidencePopulation.js');

const claimableVocabulary = await import('../src/domain/ai/claimableEvidence.js');

const stackFor = (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  return createAiStack(t, { sicil: AYSE, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' }, seed: rotaToolSeed() });
};
const issue = (verdict) => verdict.issues[0]?.code ?? null;

/** Planın ayrıştırılmış çağrıları. */
const planned = (...calls) => calls.map(([name, args]) => ({ name, args: parseToolArguments(getRotaTool(name).parameters, JSON.stringify(args)) }));
const complete = (raw, calls, options = {}) => completeRequest(parsedRequest(raw), planned(...calls), { today: REQUEST_TODAY, allowedTextFields: [], ...options });

/** Sentetik kanıt: zarf, nüfus ve tur bilgisi açıkça verilir. */
function source(tool, data, extra = {}) {
  const id = extra.id || 'R1';
  const { envelope: overrides, ...metadata } = extra;
  const envelope = { ok: true, tool, evidenceId: id, factScope: `0123456789abcdef_${id}`, claimable: claimableContract(tool),
    data, complete: true, truncated: false, totalCount: 0, returnedCount: 0, ...overrides };
  return { id, tool, envelope, ordinal: Number(id.slice(1)), round: Number(id.slice(1)), firstPage: true, facets: {}, declared: {}, unsupported: [], selectors: [],
    populationMatch: true, dimensionsMatch: true, sortMatch: true, snapshotDimensions: {}, facts: createEvidenceFacts(envelope, { prefix: envelope.factScope }), ...metadata };
}

function verify(sources, request, references) {
  return analyzeGroundedAnswer(JSON.stringify({ kind: 'rota', facts: references }), {
    evidenceIds: sources.map((item) => item.id), evidencePayloads: sources.map((item) => ({ id: item.id, payload: JSON.stringify(item.envelope) })),
    request: { entities: [], fields: [], bindings: [], layout: 'auto', ...request }, evidence: new Map(sources.map((item) => [item.id, item]))
  });
}

/* ── Veri okunmadan önce: tamamlama ve yetenek ─────────────── */

test('the plan completes undeclared population dimensions and filters from its own population call', () => {
  const cases = [
    { raw: { operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search' } }, calls: [['rota_task_search', { deadline: 'overdue', assignee: 'me' }]],
      expect: (request) => assert.deepEqual([request.filters, request.population.collection, request.population.sort], [{ deadline: 'overdue', assignee: 'me' }, 'tasks', 'overdue_days_desc']) },
    { raw: { operation: 'list', metrics: ['wbs.name'], fields: [{ metric: 'wbs.name', tool: 'rota_wbs_inspect', path: 'data.nodes.*.name' }], population: { tool: 'rota_wbs_inspect', collection: 'nodes' }, entities: [{ type: 'project', id: PROJECTS.FULL }] },
      calls: [['rota_wbs_inspect', { projectId: PROJECTS.FULL }]], expect: (request) => assert.equal(request.population.depth, 2, 'varsayılan derinlik açık değer olur') },
    { raw: { operation: 'list', metrics: ['tasks.open'], population: { tool: 'rota_task_analytics', collection: 'groups' } }, calls: [['rota_task_analytics', { groupBy: 'priority' }]],
      expect: (request) => assert.equal(request.population.groupBy, 'priority') },
    // Nüfus aracı verilmemişse planın tek taşıyıcı çağrısıdır; koşulu ifade edemeyen araç aday olamaz.
    { raw: { operation: 'value', metrics: ['tasks.total', 'task.status'], entities: [{ type: 'task', id: '20000000-0000-4000-8000-000000000001' }], filters: { text: 'Radar' } },
      calls: [['rota_task_search', { text: 'Radar' }], ['rota_task_detail', { taskId: '20000000-0000-4000-8000-000000000001' }]],
      expect: (request) => assert.equal(request.population.tool, 'rota_task_search') },
    // Nüfus çağrısındaki kimlik seçicisi bildirilen varlık olur.
    { raw: { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_search' } }, calls: [['rota_task_search', { projectId: PROJECTS.FULL }]],
      expect: (request) => assert.deepEqual(request.entities.map(({ type, id }) => [type, id]), [['project', PROJECTS.FULL]]) },
    // Görev varlık olarak bildirilirse aynı arama satırı onun özelliğini taşır.
    { raw: { operation: 'value', metrics: ['task.status'], population: { tool: 'rota_task_search' }, entities: [{ type: 'task', text: 'Radar test planı' }] },
      calls: [['rota_task_search', { text: 'Radar test planı' }]], expect: (request) => assert.equal(request.population.tool, 'rota_task_search') },
    // Bildirilen varlığı çözen arama (ad kısaltılmış da olsa) plana uygundur.
    { raw: { operation: 'value', metrics: ['tasks.inProgress'], population: { tool: 'rota_task_analytics' }, entities: [{ type: 'project', text: 'Radar Modernizasyonu' }] },
      calls: [['rota_project_search', { text: 'radar' }]], expect: (request) => assert.deepEqual(request.entities.map(({ type }) => type), ['project']) }
  ];
  for (const { raw, calls, expect } of cases) {
    const { request, problems } = complete(raw, calls);
    assert.deepEqual(problems, [], JSON.stringify(raw));
    expect(request);
  }
});

test('ambiguous, conflicting or inexpressible declarations are refused before SQL with registry hints', () => {
  const cases = [
    // Bildirilen koşul nüfus çağrısıyla çelişir.
    [{ operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_search' }, filters: { deadline: 'overdue' } }, [['rota_task_search', { deadline: 'due_today' }]], '$.filters.deadline:conflict'],
    // İki nüfus çağrısı farklı gruplama kullanır ve hiçbiri varsayılan değildir.
    [{ operation: 'list', metrics: ['tasks.open'], population: { tool: 'rota_task_analytics', collection: 'groups' } }, [['rota_task_analytics', { groupBy: 'status' }], ['rota_task_analytics', { groupBy: 'priority' }]], '$.population.groupBy:ambiguous'],
    // Bildirilen derinlik çağrıyla çelişir.
    [{ operation: 'list', metrics: ['wbs.name'], population: { tool: 'rota_wbs_inspect', collection: 'nodes', depth: 3 }, entities: [{ type: 'project', id: PROJECTS.FULL }] }, [['rota_wbs_inspect', { projectId: PROJECTS.FULL }]], '$.population.depth:conflict'],
    // Proje ayrıntısı görev durumu koşulunu ifade edemez (#15).
    [{ operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_project_detail' }, filters: { status: ['in_progress'] }, entities: [{ type: 'project', id: PROJECTS.FULL }] }, [['rota_project_detail', { projectId: PROJECTS.FULL }]], '$.filters.status:unsupported'],
    // Korumalı metin alanı kullanıcı açmadan nüfus boyutu olamaz.
    [{ operation: 'value', metrics: ['requests.total'], population: { tool: 'rota_schedule_requests', textFields: ['requesterMessage'] } }, [['rota_schedule_requests', {}]], '$.population.textFields:not-authorized'],
    // Nüfus aracının taşımadığı ölçü ve bağlanacak varlığı olmayan özellik reddedilir (#9).
    [{ operation: 'value', metrics: ['wbs.name'], population: { tool: 'rota_task_search' } }, [['rota_task_search', {}]], '$.metrics[0]:population'],
    [{ operation: 'value', metrics: ['person.jobTitle'], population: { tool: 'rota_task_search' } }, [['rota_task_search', {}]], '$.metrics[0]:population'],
    // Liste satırın alanı ya da koleksiyonun kendi sayısı olmayan toplam taşıyamaz (#12).
    [{ operation: 'list', metrics: ['tasks.overdue', 'task.title'], population: { tool: 'rota_task_search', collection: 'tasks' } }, [['rota_task_search', {}]], '$.metrics[0]:not-row-total'],
    [{ operation: 'list', metrics: ['recurrence.entries', 'recurrence.occurrenceDate'], population: { tool: 'rota_recurrence_inspect', collection: 'series.*.next' } }, [['rota_recurrence_inspect', {}]], '$.metrics[0]:not-row-total'],
    // Satır ölçüsü bildirilmeyen liste ve satırı olmayan sıralama ölçüsü.
    [{ operation: 'list', metrics: ['tasks.total'], population: { tool: 'rota_task_search', collection: 'tasks' } }, [['rota_task_search', {}]], '$.metrics:rows'],
    // Sıralama tek koleksiyondadır; kayıtlı kardeş olmayan koleksiyonlar (seri ve yinelemeleri, yaşlanma ve gruplar) birlikte örtük liste olamaz.
    [{ operation: 'rank', metrics: ['task.title', 'task.plannedFinish'], rank: { metric: 'task.plannedFinish', order: 'asc' }, population: { tool: 'rota_dependency_inspect' },
      entities: [{ type: 'task', id: '20000000-0000-4000-8000-000000000001' }] }, [['rota_dependency_inspect', { taskId: '20000000-0000-4000-8000-000000000001' }]], '$.population.collection:required'],
    [{ operation: 'list', metrics: ['recurrence.occurrenceDate'], population: { tool: 'rota_recurrence_inspect' } }, [['rota_recurrence_inspect', {}]], '$.population.collection:required'],
    [{ operation: 'list', metrics: ['tasks.overdue'], population: { tool: 'rota_task_analytics' } }, [['rota_task_analytics', {}]], '$.population.collection:required'],
    [{ operation: 'list', metrics: ['task.title'], population: { tool: 'rota_dependency_inspect' }, entities: [{ type: 'task', id: '20000000-0000-4000-8000-000000000001' }] },
      [['rota_dependency_inspect', { taskId: '20000000-0000-4000-8000-000000000001' }]], '$.population.collection:required'],
    // Birden çok koleksiyonlu liste yalnızca satır alanlarıdır.
    [{ operation: 'list', metrics: ['task.title', 'dependency.type', 'dependencies.total'], population: { tool: 'rota_dependency_inspect' },
      entities: [{ type: 'task', id: '20000000-0000-4000-8000-000000000001' }] }, [['rota_dependency_inspect', { taskId: '20000000-0000-4000-8000-000000000001' }]], '$.metrics[2]:not-row-total'],
    // İki proje ve iki ölçü: her ölçünün projesi açıkça bağlanmalıdır.
    [{ operation: 'value', metrics: ['tasks.open', 'tasks.total'], population: { tool: 'rota_project_detail' }, entities: [{ type: 'project', id: PROJECTS.FULL }, { type: 'project', id: PROJECTS.READ }] }, [['rota_project_detail', { projectId: PROJECTS.FULL }]], '$.bindings:required'],
    // Planın tek nüfus adayı yoksa nüfus açıkça bildirilmelidir.
    [{ operation: 'value', metrics: ['tasks.open'], entities: [{ type: 'person', text: 'Ali' }] }, [['rota_person_search', { text: 'Ali' }]], '$.population:required'],
    // Adla çözülen proje bildirilmemişse onun kimliğiyle okunan veri bildirilen nüfus olamaz: veri okunmadan düzeltilir.
    [{ operation: 'value', metrics: ['tasks.inProgress'], population: { tool: 'rota_task_analytics' } }, [['rota_project_search', { text: 'Radar Modernizasyonu' }]], '$.entities:undeclared'],
    // Aynı ad hem proje varlığı hem görev başlığı araması olamaz.
    [{ operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks' }, entities: [{ type: 'project', text: 'Radar Modernizasyonu' }],
      filters: { text: 'Radar Modernizasyonu' } }, [['rota_project_search', { text: 'Radar Modernizasyonu' }]], '$.filters.text:entity'],
    // Görevin kendi özelliği, görev bildirilmeden arama satırından değer olarak okunamaz.
    [{ operation: 'value', metrics: ['task.status'], population: { tool: 'rota_task_search' }, filters: { text: 'Radar test planı' } }, [['rota_task_search', { text: 'Radar test planı' }]], '$.metrics[0]:entity'],
    // İş dağılım listesinde derinlik açıkça bildirilir (planın kendi okuması yoksa varsayılan sessizce ağacı kesmez).
    [{ operation: 'list', metrics: ['wbs.name'], population: { tool: 'rota_wbs_inspect', collection: 'nodes' }, entities: [{ type: 'project', text: 'Radar Modernizasyonu' }] },
      [['rota_project_search', { text: 'Radar Modernizasyonu' }]], '$.population.depth:required'],
    // Seçicisiz okunamayan nüfus aracı bir görev ya da proje varlığı ister.
    [{ operation: 'list', metrics: ['task.title', 'dependency.type'], population: { tool: 'rota_dependency_inspect' } }, [['rota_task_search', { text: 'Anten kalibrasyonu' }]], '$.entities:required'],
    // Kişinin görevleri kişi seçicisiyle okunur; "benim" koşulu onunla çelişir.
    [{ operation: 'value', metrics: ['tasks.open'], population: { tool: 'rota_task_analytics' }, entities: [{ type: 'person', text: 'Zeynep Kaya' }], filters: { assignee: 'me' } },
      [['rota_person_search', { text: 'Zeynep Kaya' }]], '$.filters.assignee:entity'],
    // Yalnızca satırlarda bulunan (varlık özelliği olmayan) ölçünün tek değeri yoktur: liste istenir.
    [{ operation: 'value', metrics: ['dependency.type'], population: { tool: 'rota_dependency_inspect' }, entities: [{ type: 'task', id: '20000000-0000-4000-8000-000000000002' }] },
      [['rota_dependency_inspect', { taskId: '20000000-0000-4000-8000-000000000002' }]], '$.metrics[0]:rows'],
    // Korumalı metin ölçüsü kendi alanını nüfus boyutu yapar; kullanıcı açmadıysa veri okunmadan reddedilir.
    [{ operation: 'value', metrics: ['task.description'], population: { tool: 'rota_task_detail' }, entities: [{ type: 'task', text: 'Radar test planı' }] }, [], '$.population.textFields:not-authorized']
  ];
  for (const [raw, calls, expected] of cases) {
    const { problems, hints } = complete(raw, calls);
    assert.ok(problems.includes(expected), `${JSON.stringify(raw)} → ${expected}; got ${problems}`);
    assert.ok(hints.every((hint) => !hint.includes('Radar')), 'ipuçları serbest metin yansıtmaz');
  }
});

test('a naming metric does not make several entities ambiguous; two measuring metrics still need bindings', () => {
  const projects = [{ type: 'project', id: PROJECTS.FULL }, { type: 'project', id: PROJECTS.READ }];
  const named = complete({ operation: 'value', metrics: ['project.name', 'tasks.total'], population: { tool: 'rota_project_detail' }, entities: projects }, []);
  assert.deepEqual(named.problems, []);
  const measured = complete({ operation: 'value', metrics: ['tasks.open', 'tasks.total'], population: { tool: 'rota_project_detail' }, entities: projects }, []);
  assert.ok(measured.problems.includes('$.bindings:required'));
});

test('the grouped dimension is the group label, not a separate metric', () => {
  const grouped = complete({ operation: 'list', metrics: ['tasks.total', 'task.priority'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy: 'priority' },
    filters: { assignee: 'me' } }, []);
  assert.deepEqual([grouped.problems, grouped.request.metrics], [[], ['tasks.total']]);
  assert.ok(complete({ operation: 'list', metrics: ['tasks.total', 'task.priority'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy: 'status' } }, [])
    .problems.includes('$.metrics[1]:population'), 'başka boyutla gruplamada öncelik satır ölçüsü değildir');
  // Görev aramasında bildirilen gruplama, aynı koşullarla analizin grup satırlarıdır.
  const searched = complete({ operation: 'list', metrics: ['task.priority', 'tasks.total'], population: { tool: 'rota_task_search', collection: 'tasks', groupBy: 'priority', sort: 'title_asc' },
    filters: { assignee: 'me' } }, []);
  assert.deepEqual([searched.problems, searched.request.population, searched.request.metrics],
    [[], { tool: 'rota_task_analytics', groupBy: 'priority', collection: 'groups' }, ['tasks.total']]);
});

test('grouping by the type of the named records is their own totals: a per-record value, the record name is the subject', () => {
  const projects = [{ type: 'project', text: 'Radar Modernizasyonu' }, { type: 'project', text: 'Okuma Projesi' }];
  const perProject = complete({ operation: 'list', metrics: ['project.name', 'tasks.total'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy: 'project' },
    entities: projects }, []);
  assert.deepEqual([perProject.problems, perProject.request.operation, perProject.request.population, perProject.request.metrics],
    [[], 'value', { tool: 'rota_task_analytics' }, ['tasks.total']]);
  const people = complete({ operation: 'list', metrics: ['tasks.open'], population: { tool: 'rota_task_search', groupBy: 'assignee' },
    entities: [{ type: 'person', text: 'Zeynep Kaya' }] }, []);
  assert.deepEqual([people.problems, people.request.operation, people.request.population], [[], 'value', { tool: 'rota_task_analytics' }]);
  // Adı geçen kayıt yoksa ya da başka boyutla gruplanıyorsa gruplama satır listesidir.
  assert.equal(complete({ operation: 'list', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics', groupBy: 'project' } }, []).request.population.collection, 'groups');
  const byStatus = complete({ operation: 'list', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics', groupBy: 'status' }, entities: [projects[0]] }, []);
  assert.deepEqual([byStatus.request.operation, byStatus.request.population.collection], ['list', 'groups']);
});

test('a protected text metric opens its own field; an entity property names the selecting tool and the entity to declare', () => {
  const described = complete({ operation: 'value', metrics: ['task.description'], population: { tool: 'rota_task_detail' }, entities: [{ type: 'task', text: 'Radar test planı' }] }, [],
    { allowedTextFields: ['description'] });
  assert.deepEqual([described.problems, described.request.population.textFields], [[], ['description']]);
  const searched = complete({ operation: 'value', metrics: ['task.description'], population: { tool: 'rota_task_search' }, filters: { text: 'Radar test planı' } },
    [['rota_task_search', { text: 'Radar test planı' }]], { allowedTextFields: ['description'] });
  assert.ok(searched.problems.includes('$.metrics[0]:population'));
  assert.ok(searched.hints.includes('task.description: task özelliği; population.tool rota_task_detail ve request.entities: [{"type":"task","text":"<kullanıcının yazdığı ad>"}] bildir (ölçüyü SİLME; kimliği sunucu bulur)'));
});

test('a selector-dependent collection follows the read shape: a task-selected recurrence is one series, otherwise a series list', () => {
  const task = [{ type: 'task', text: 'Haftalık durum toplantısı' }];
  const shape = (population, entities = []) => complete({ operation: 'list', metrics: ['recurrence.occurrenceDate'], population: { tool: 'rota_recurrence_inspect', ...population }, entities }, []);
  assert.equal(shape({}, task).request.population.collection, 'series.next');
  assert.equal(shape({ collection: 'series.*.next' }, task).request.population.collection, 'series.next', 'aynı nüfusun öteki biçimi');
  assert.equal(shape({ collection: 'series.next' }).request.population.collection, 'series.*.next');
  assert.ok(shape({ collection: 'series' }, task).problems.includes('$.population.collection:shape'));
});

test('an unregistered metric id is answered with the registered metrics of the same prefix, never with the written text', () => {
  const { metricIdHints } = requestDeclarationModule;
  assert.deepEqual(metricIdHints(['$.metrics[1]:enum'], { metrics: ['recurrence.rule', 'recurrence.nextOccurrences'] }).map((hint) => hint.includes('recurrence.occurrenceDate')), [true]);
  assert.ok(!metricIdHints(['$.metrics[1]:enum'], { metrics: ['recurrence.rule', 'recurrence.nextOccurrences'] })[0].includes('nextOccurrences'));
  assert.deepEqual(metricIdHints(['$.metrics[0]:enum'], { metrics: ['bilinmeyen.olcu'] }), []);
});

test('equivalent defaults canonicalize to one population identity, and omitted dimensions are defaults, never wildcards', async (t) => {
  const stack = stackFor(t);
  const { ledger } = await callRotaTools(stack, AYSE, [['rota_wbs_inspect', { projectId: PROJECTS.FULL }], ['rota_wbs_inspect', { projectId: PROJECTS.FULL, depth: 2 }],
    ['rota_task_analytics', { groupBy: 'status' }], ['rota_task_search', { deadline: 'overdue' }], ['rota_task_search', { deadline: 'overdue', sort: 'overdue_days_desc' }]]);
  const request = parsedRequest({ operation: 'list', metrics: ['wbs.name'], population: { tool: 'rota_wbs_inspect', collection: 'nodes', depth: 2 } });
  const index = requestEvidence(request, ledger.requestEntries(), REQUEST_TODAY);
  assert.deepEqual(index.get('R1').snapshotDimensions, index.get('R2').snapshotDimensions, 'verilmeyen derinlik varsayılan 2 ile aynı kimliktir (#14)');
  assert.equal(index.get('R1').rowDimensionsMatch, true);
  const sorted = requestEvidence(parsedRequest({ operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks' }, filters: { deadline: 'overdue' } }),
    ledger.requestEntries(), REQUEST_TODAY);
  assert.deepEqual(sorted.get('R4').snapshotDimensions, sorted.get('R5').snapshotDimensions, 'varsayılan sıra açık sırayla aynıdır');
  assert.equal(sorted.get('R4').sortMatch, true);
  // Gruplama bildirilmemişse grup satırları bildirilen nüfus değildir (#13); toplamlar gruplamadan bağımsızdır.
  const grouped = requestEvidence(parsedRequest({ operation: 'list', metrics: ['tasks.open'], population: { tool: 'rota_task_analytics', collection: 'groups' } }),
    ledger.requestEntries(), REQUEST_TODAY).get('R3');
  assert.deepEqual([grouped.rowDimensionsMatch, grouped.dimensionsMatch], [false, true]);
  assert.equal(issue(verifyRequested(ledger, ['R3:data.groups.*.label', 'R3:data.groups.*.open'], { operation: 'list', metrics: ['tasks.open'],
    population: { tool: 'rota_task_analytics', collection: 'groups' } })), 'POPULATION_MISMATCH');
});

/* ── Yükümlülükler ────────────────────────────────────────── */

test('every declared field binding is an obligation; one matching carrier does not satisfy the others (#3)', () => {
  const entry = source('rota_workload_summary', { openTaskCount: 5, people: [{ sicil: 1, name: 'Ayşe', openTasks: 3 }, { sicil: 2, name: 'Ali', openTasks: 2 }] }, { collection: 'people', envelope: { totalCount: 2 } });
  const request = { operation: 'value', metrics: ['tasks.open'], fields: [{ metric: 'tasks.open', tool: 'rota_workload_summary', path: 'data.openTaskCount' },
    { metric: 'tasks.open', tool: 'rota_workload_summary', path: 'data.people.*.openTasks' }] };
  const list = { ...request, operation: 'list' };
  assert.equal(issue(verify([entry], list, ['R1:data.people.*.name', 'R1:data.people.*.openTasks'])), 'METRIC_MISSING');
  assert.equal(issue(verify([entry], list, ['R1:data.openTaskCount'])), 'METRIC_MISSING');
  assert.equal(issue(verify([entry], { ...list, fields: [request.fields[1]] }, ['R1:data.people.*.name', 'R1:data.people.*.openTasks'])), null);
});

test('explicit metric/entity bindings are enforced even for a single metric (#4)', () => {
  const a = source('rota_project_detail', { visibleTasks: { open: 2 } }, { selectors: [{ type: 'project', id: 'a' }] });
  const b = source('rota_project_detail', { visibleTasks: { open: 4 } }, { id: 'R2', selectors: [{ type: 'project', id: 'b' }] });
  const request = { operation: 'value', metrics: ['tasks.open'], entities: [{ type: 'project', bound: 'a' }, { type: 'project', bound: 'b' }] };
  assert.equal(issue(verify([a, b], request, ['R1:data.visibleTasks.open', 'R2:data.visibleTasks.open'])), null, 'bağsız tek ölçü iki varlık için de istenir');
  const bound = { ...request, entities: [...request.entities, { type: 'project', bound: 'c' }], bindings: [{ metric: 'tasks.open', entity: 0 }, { metric: 'tasks.open', entity: 2 }] };
  const c = source('rota_project_detail', { visibleTasks: { open: 7 } }, { id: 'R3', selectors: [{ type: 'project', id: 'c' }] });
  assert.equal(issue(verify([a, b, c], bound, ['R1:data.visibleTasks.open', 'R2:data.visibleTasks.open', 'R3:data.visibleTasks.open'])), 'ENTITY_MISMATCH');
  assert.equal(issue(verify([a, b, c], bound, ['R1:data.visibleTasks.open'])), 'ENTITY_MISSING');
});

test('an empty nested multivalue is a value; an absent or trimmed one is not (#7)', () => {
  const rows = [{ taskId: 't1', title: 'Bir', assignees: [{ name: 'Ayşe' }] }, { taskId: 't2', title: 'İki', assignees: [] }];
  const entry = source('rota_task_search', { tasks: rows }, { collection: 'tasks', envelope: { totalCount: 2 } });
  const request = { operation: 'list', metrics: ['task.title', 'task.assignees'] };
  assert.equal(issue(verify([entry], request, ['R1:data.tasks.*.title', 'R1:data.tasks.*.assignees.*.name'])), null);
  const noAssignees = source('rota_task_search', { tasks: rows.map((row) => ({ ...row, assignees: [] })) }, { collection: 'tasks', envelope: { totalCount: 2 } });
  assert.equal(issue(verify([noAssignees], request, ['R1:data.tasks.*.title', 'R1:data.tasks.*.assignees.*.name'])), null, 'her satırda boş olan alanın deseni olgu seçmeden kabul edilir');
  const absent = source('rota_task_search', { tasks: [{ taskId: 't1', title: 'Bir' }] }, { collection: 'tasks', envelope: { totalCount: 1 } });
  assert.equal(issue(verify([absent], request, ['R1:data.tasks.*.title'])), 'METRIC_MISSING');
  const trimmed = source('rota_task_search', { tasks: rows, sizeNote: 'kısaltıldı' }, { collection: 'tasks', envelope: { totalCount: 2 } });
  assert.notEqual(issue(verify([trimmed], { ...request, operation: 'rank', rank: { metric: 'task.title', order: 'asc' } }, ['R1:data.tasks.0.title', 'R1:data.tasks.0.assignees.*.name'])), null);
});

test('an unwritten single entity property is an empty value; an unwritten counter is missing', () => {
  const tasks = source('rota_task_search', { tasks: [{ taskId: 't1', title: 'Bir', targetFinish: '2026-10-20' }, { taskId: 't2', title: 'İki' }] },
    { collection: 'tasks', envelope: { totalCount: 2 } });
  const dates = { operation: 'list', metrics: ['task.title', 'task.targetFinish'] };
  assert.equal(issue(verify([tasks], dates, ['R1:data.tasks.*.title', 'R1:data.tasks.*.targetFinish'])), null, 'hedef bitişi olmayan görev boş değeriyle listelenir');
  const trimmed = source('rota_task_search', { tasks: [{ taskId: 't2', title: 'İki' }], sizeNote: 'kısaltıldı' }, { collection: 'tasks', envelope: { totalCount: 1 } });
  assert.equal(issue(verify([trimmed], dates, ['R1:data.tasks.*.title'])), 'METRIC_MISSING', 'kısaltılmış satırda yazılmamış alan boş sayılmaz');
  const people = source('rota_workload_summary', { people: [{ personId: 'p1', name: 'Ayşe', openTasks: 3 }, { personId: 'p2', name: 'Mehmet' }] },
    { collection: 'people', envelope: { totalCount: 2 } });
  assert.equal(issue(verify([people], { operation: 'list', metrics: ['person.name', 'tasks.open'] }, ['R1:data.people.*.name', 'R1:data.people.*.openTasks'])),
    'METRIC_MISSING', 'sayaç her satıra yazılır; yazılmamışsa ölçü yoktur');
});

test('a value retained in a size-trimmed newer read still supersedes the older read of the same property', () => {
  const taskId = '20000000-0000-4000-8000-000000000009';
  const search = source('rota_task_search', { tasks: [{ taskId, title: 'Radar', status: 'todo' }], titleResolution: 'unique', resolvedTask: { taskId } },
    { args: { text: 'Radar' }, envelope: { totalCount: 1, returnedCount: 1 } });
  const detail = (data = {}) => source('rota_task_detail', { task: { taskId, title: 'Radar', status: 'in_progress', hours: { planned: 12 }, assignees: [] }, ...data },
    { id: 'R2', selectors: [{ type: 'task', id: taskId }] });
  const request = { operation: 'value', metrics: ['task.status', 'task.plannedHours'], entities: [{ type: 'task', bound: taskId }] };
  const stale = ['R1:data.tasks.0.status', 'R2:data.task.hours.planned'];
  assert.equal(issue(verify([search, detail()], request, stale)), 'STALE_EVIDENCE');
  // Büyük yük kısaltıldı (sizeNote): kalan durum değeri yine günceldir; eski durum güncel gibi gösterilmez.
  assert.equal(issue(verify([search, detail({ sizeNote: 'kısaltıldı' })], request, stale)), 'STALE_EVIDENCE');
  assert.equal(issue(verify([search, detail({ sizeNote: 'kısaltıldı' })], request, ['R2:data.task.status', 'R2:data.task.hours.planned'])), null);
});

test('a multivalue field is complete per requested metric: one metric element never fills another metric gap', () => {
  const changes = [{ field: 'progress', before: 20, after: 30 }, { field: 'milestone', before: false, after: true }];
  const entry = source('rota_activity_search', { items: [{ actor: 'A', kind: 'updated', structuredChanges: changes }] },
    { collection: 'items', envelope: { totalCount: 1, returnedCount: 1 } });
  const request = { operation: 'list', metrics: ['activity.changeBefore', 'activity.changeAfter'] };
  const path = (index, side) => `R1:data.items.0.structuredChanges.${index}.${side}`;
  assert.equal(issue(verify([entry], request, [path(0, 'before'), path(1, 'after')])), 'PARTIAL_VALUE_LIST', 'eski ilerleme ve yeni kilometre taşı değeri eksik');
  assert.equal(issue(verify([entry], request, [path(0, 'before'), path(1, 'before'), path(0, 'after'), path(1, 'after')])), null);
});

test('multivalue completeness is checked on the whole collection, not on the capped fact index', () => {
  // 20 olay × 6 değişiklik: kanıt sınır içindedir, ama olgu dizini 256 olguda kesilir.
  const items = Array.from({ length: 20 }, (_, item) => ({ actor: 'A', kind: 'updated',
    structuredChanges: Array.from({ length: 6 }, (_, index) => ({ field: 'progress', before: item * 10 + index, after: item * 10 + index + 1 })) }));
  const entry = source('rota_activity_search', { items }, { collection: 'items', envelope: { totalCount: 20, returnedCount: 20 } });
  assert.ok(entry.facts.length <= 256 && !entry.facts.some((fact) => fact.field.startsWith('data.items.19.')), 'son olaylar olgu dizininde yok');
  const request = { operation: 'list', metrics: ['activity.changeBefore', 'activity.changeAfter'] };
  // Her "sonra" değeri seçildi; dizinin dışındaki son olayın "önce" değerlerinden yalnızca biri: beş istenen değer düşerdi.
  const before = [...Array.from({ length: 19 }, (_, item) => `R1:data.items.${item}.structuredChanges.*.before`), 'R1:data.items.19.structuredChanges.0.before'];
  assert.equal(issue(verify([entry], request, ['R1:data.items.*.structuredChanges.*.after', ...before])), 'PARTIAL_VALUE_LIST');
  assert.equal(issue(verify([entry], request, ['R1:data.items.*.structuredChanges.*.after', 'R1:data.items.*.structuredChanges.*.before'])), null);
});

test('a verified fact renders under its own owner and label, and a verified selection never renders empty', async (t) => {
  const { ledger } = await callRotaTools(stackFor(t), AYSE, [['rota_task_detail', { taskId: TASKS.OVERDUE }], ['rota_project_search', { text: 'Radar Modernizasyonu' }]]);
  // Görevin projesi görevi adlandırmaz ("Radar Modernizasyonu görevi" yanlış kayıttır).
  const project = verifyRequested(ledger, ['R1:data.task.project.name'], { operation: 'value', metrics: ['task.project'], population: { tool: 'rota_task_detail' },
    fields: [{ metric: 'task.project', tool: 'rota_task_detail', path: 'data.task.project.name' }], entities: [{ type: 'task', id: TASKS.OVERDUE }] });
  assert.equal(issue(project), null);
  assert.doesNotMatch(project.normalized, /Radar Modernizasyonu\*\* görevi/);
  assert.match(project.normalized, /\*\*Radar Modernizasyonu\*\* projesindedir/);
  // Yalnızca çok değerli alanı olan kayıt da seçilen adını taşır.
  const assignees = verifyRequested(ledger, ['R1:data.task.title', 'R1:data.task.assignees.0.name'], { operation: 'value', metrics: ['task.title', 'task.assignees'],
    population: { tool: 'rota_task_detail' }, entities: [{ type: 'task', id: TASKS.OVERDUE }] });
  assert.match(assignees.normalized, /Radar test planı.*Ayşe Yılmaz/);
  // Yalnızca kodu seçilen kayıt boş yanıt değildir.
  const code = verifyRequested(ledger, ['R2:data.matches.0.code'], { operation: 'value', metrics: ['project.code'], population: { tool: 'rota_project_detail' },
    entities: [{ type: 'project', text: 'Radar Modernizasyonu' }] });
  assert.equal(issue(code), null);
  assert.match(code.normalized, /RDR/);
  // Her değişiklik değeri kendi değişen alanının etiketiyle yazılır.
  const changes = [{ field: 'progress', before: 20, after: 30 }, { field: 'milestone', before: false, after: true }];
  const activity = source('rota_activity_search', { items: [{ actor: 'A', kind: 'updated', structuredChanges: changes }] },
    { collection: 'items', envelope: { totalCount: 1, returnedCount: 1 } });
  const rendered = verify([activity], { operation: 'list', metrics: ['activity.changeBefore', 'activity.changeAfter'] },
    [0, 1].flatMap((index) => ['before', 'after'].map((side) => `R1:data.items.0.structuredChanges.${index}.${side}`)));
  assert.equal(issue(rendered), null);
  assert.match(rendered.normalized, /İlerleme[^.\n]*20/);
  assert.doesNotMatch(rendered.normalized, /İlerleme[^.\n]*(Hayır|Evet)/, 'kilometre taşı değeri ilerlemeye atfedilmez');
  // Açık tablo da her değeri kendi alanının sütununa yazar.
  const table = verify([activity], { operation: 'list', metrics: ['activity.changeBefore', 'activity.changeAfter'], layout: 'table' },
    [0, 1].flatMap((index) => ['before', 'after'].map((side) => `R1:data.items.0.structuredChanges.${index}.${side}`)));
  assert.equal(issue(table), null);
  assert.match(table.normalized, /\| İlerleme[^|]*Önceki[^|]*\| İlerleme[^|]*Sonraki[^|]*\| Kilometre taşı[^|]*Önceki[^|]*\| Kilometre taşı[^|]*Sonraki[^|]*\|/);
  assert.match(table.normalized, /\| Rota \| 20 \| 30 \| Hayır \| Evet \|/);
  // Yalnızca adlardan oluşan açık tablo da tablodur.
  const names = source('rota_portfolio_summary', { projects: [{ projectId: PROJECTS.FULL, name: 'Radar', code: 'RDR' }, { projectId: PROJECTS.READ, name: 'Okuma', code: 'OKU' }] },
    { envelope: { totalCount: 2, returnedCount: 2 } });
  assert.match(verify([names], { operation: 'list', metrics: ['project.name'], layout: 'table' }, ['R1:data.projects.*.name']).normalized, /^\| Proje \|\n\| --- \|\n\| Radar \|\n\| Okuma \|/);
  assert.match(rendered.normalized, /Hayır/);
});

test('a list renders in the tool row order of its verified sort, whatever order the facts were selected in', () => {
  const tasks = source('rota_task_search', { tasks: [{ taskId: 't1', title: 'Eylül işi', targetFinish: '2026-09-05' }, { taskId: 't2', title: 'Ekim işi', targetFinish: '2026-10-20' }] },
    { collection: 'tasks', envelope: { totalCount: 2, returnedCount: 2 } });
  const request = { operation: 'list', metrics: ['task.title', 'task.targetFinish'], population: { tool: 'rota_task_search', collection: 'tasks', sort: 'target_finish_asc' } };
  const reversed = verify([tasks], request, ['R1:data.tasks.1.title', 'R1:data.tasks.1.targetFinish', 'R1:data.tasks.0.title', 'R1:data.tasks.0.targetFinish']);
  assert.equal(issue(reversed), null);
  assert.ok(reversed.normalized.indexOf('Eylül işi') < reversed.normalized.indexOf('Ekim işi'), reversed.normalized);
  // Açıkça bildirilen tablo düzeni tek satırda da uygulanır.
  const single = source('rota_task_search', { tasks: [{ taskId: 't1', title: 'Eylül işi', targetFinish: '2026-09-05' }] },
    { collection: 'tasks', envelope: { totalCount: 1, returnedCount: 1 } });
  const table = verify([single], { ...request, layout: 'table' }, ['R1:data.tasks.0.title', 'R1:data.tasks.0.targetFinish']);
  assert.equal(issue(table), null);
  assert.match(table.normalized, /^\|/m, table.normalized);
});

/* ── Koleksiyona özgü tamlık ve toplamlar ─────────────────── */

test('completeness follows the requested collection: incomplete history cannot hide a proven empty upcoming population (#8)', () => {
  const series = [{ title: 'Seri', nextTruncated: false, upcomingCount: 0, completionDatesComplete: false, next: [] }];
  const entry = source('rota_recurrence_inspect', { series }, { collection: 'series.*.next', envelope: { complete: false, totalCount: 1 } });
  const request = { operation: 'list', metrics: ['recurrence.occurrenceDate'] };
  assert.equal(issue(verify([entry], request, ['R1:complete'])), null);
  for (const change of [{ nextTruncated: true }, { upcomingCount: 2 }]) {
    const broken = source('rota_recurrence_inspect', { series: [{ ...series[0], ...change }] }, { collection: 'series.*.next', envelope: { complete: false, totalCount: 1 } });
    assert.notEqual(issue(verify([broken], request, ['R1:complete'])), null, JSON.stringify(change));
  }
});

test('a list covers every concrete collection of a nested population, including parents without selected rows (#18)', () => {
  const entry = source('rota_recurrence_inspect', { series: [
    { title: 'A', nextTruncated: false, next: [{ taskId: 'a1', occurrenceDate: '2026-10-01', status: 'todo' }] },
    { title: 'B', nextTruncated: false, next: [{ taskId: 'b1', occurrenceDate: '2026-10-02', status: 'todo' }] }
  ] }, { collection: 'series.*.next', envelope: { totalCount: 2 } });
  const request = { operation: 'list', metrics: ['recurrence.occurrenceDate'] };
  assert.equal(issue(verify([entry], request, ['R1:data.series.0.next.*.occurrenceDate'])), 'LIST_INCOMPLETE');
  assert.equal(issue(verify([entry], request, ['R1:data.series.*.next.*.occurrenceDate'])), null);
});

test('a scalar combined with rows must count that exact row collection in the same evidence (#12)', () => {
  const series = source('rota_recurrence_inspect', { series: [{ title: 'A', nextTruncated: false, next: [{ taskId: 'a1', occurrenceDate: '2026-10-01' }] }] },
    { collection: 'series.*.next', envelope: { totalCount: 1 } });
  assert.equal(issue(verify([series], { operation: 'list', metrics: ['recurrence.entries', 'recurrence.occurrenceDate'] },
    ['R1:totalCount', 'R1:data.series.*.next.*.occurrenceDate'])), 'POPULATION_MISMATCH', 'seri sayısı yineleme satırlarının sayısı değildir');
  const tasks = source('rota_task_search', { tasks: [{ taskId: 't1', title: 'Bir' }] }, { collection: 'tasks', envelope: { totalCount: 1 } });
  assert.equal(issue(verify([tasks], { operation: 'list', metrics: ['tasks.total', 'task.title'] }, ['R1:totalCount', 'R1:data.tasks.*.title'])), null);
  // Aynı turdaki eşdeğer okuma: tazelik değil, sayımın hangi satırlara ait olduğu belirleyicidir.
  const other = source('rota_task_search', { tasks: [] }, { id: 'R2', round: 0, facets: { text: 'başka' }, collection: 'tasks', envelope: { totalCount: 7 } });
  assert.equal(issue(verify([tasks, other], { operation: 'list', metrics: ['tasks.total', 'task.title'] }, ['R2:totalCount', 'R1:data.tasks.*.title'])), 'POPULATION_MISMATCH',
    'başka kanıtın toplamı bu satırların sayısı değildir');
});

/* ── Tazelik ──────────────────────────────────────────────── */

test('freshness follows the carrier class and the canonical population, never the ordinal alone', () => {
  const rows = (id, round, extra = {}) => source('rota_task_search', { tasks: [{ taskId: `t${id}`, title: `Görev ${id}`, overdueDays: 10 - id }] },
    { id: `R${id}`, round, collection: 'tasks', snapshotDimensions: { sort: 'overdue_days_desc', textFields: [] }, envelope: { totalCount: 1 }, ...extra });
  const list = { operation: 'list', metrics: ['task.title'] };
  const table = [
    // Aynı nüfusun daha sonraki her okuması (kısmi sayfa da) eski satırları eskitir; okumalar karşılaştırılmaz.
    { name: 'later partial read of the same population', sources: [rows(1, 1), rows(2, 2, { firstPage: false, envelope: { totalCount: 5, complete: false } })], refs: ['R1:data.tasks.*.title'], expected: 'STALE_EVIDENCE' },
    // Aynı nüfusun daha yeni tam okuması eskisinin yerine geçer.
    { name: 'later complete snapshot', sources: [rows(1, 1), rows(2, 2)], refs: ['R1:data.tasks.*.title'], expected: 'STALE_EVIDENCE' },
    // Farklı sırayla okunan tam liste başka bir satır nüfusudur (#22).
    { name: 'later complete with another sort', sources: [rows(1, 1), rows(2, 2, { snapshotDimensions: { sort: 'updated_desc', textFields: [] } })], refs: ['R1:data.tasks.*.title'], expected: null },
    // Aynı turdaki okumalar aynı andır; biri diğerinin yerine geçmez.
    { name: 'same round reads', sources: [rows(1, 1), rows(2, 1)], refs: ['R1:data.tasks.*.title'], expected: null }
  ];
  for (const { name, sources, refs, expected } of table) assert.equal(issue(verify(sources, list, refs)), expected, name);
  // Toplam her sayfada kesindir: daha yeni (kısmi de olsa) okuma eski toplamın yerine geçer.
  const count = { operation: 'value', metrics: ['tasks.total'] };
  assert.equal(issue(verify([rows(1, 1), rows(2, 2, { firstPage: false, envelope: { totalCount: 5, complete: false } })], count, ['R1:totalCount'])), 'STALE_EVIDENCE');
  // Boş nüfus kanıtı bir sayımdır: aynı nüfus daha sonra satırlarla okunduysa eskimiştir (#20).
  const empty = source('rota_task_search', { tasks: [] }, { collection: 'tasks', snapshotDimensions: { sort: 'overdue_days_desc', textFields: [] } });
  assert.equal(issue(verify([empty], list, ['R1:complete'])), null);
  assert.equal(issue(verify([empty, rows(2, 2, { firstPage: false, envelope: { totalCount: 5, complete: false } })], list, ['R1:complete'])), 'STALE_EVIDENCE');
});

test('count carriers are tool-scoped; only the declared task-count class crosses tools', () => {
  // Takvim talepleri ile atama talepleri aynı ölçü kimliğini taşır ama farklı kayıtları sayar.
  const schedule = source('rota_schedule_requests', { counts: { sent: 2 } }, { envelope: { totalCount: 4 } });
  const assignment = source('rota_assignment_requests', { counts: { sent: 7 } }, { id: 'R2', envelope: { totalCount: 9 } });
  for (const [metric, reference] of [['requests.total', 'R1:totalCount'], ['requests.sent', 'R1:data.counts.sent']]) {
    assert.equal(issue(verify([schedule, assignment], { operation: 'value', metrics: [metric] }, [reference])), null, metric);
  }
  const reread = source('rota_schedule_requests', { counts: { sent: 3 } }, { id: 'R2', envelope: { totalCount: 5 } });
  assert.equal(issue(verify([schedule, reread], { operation: 'value', metrics: ['requests.total'] }, ['R1:totalCount'])), 'STALE_EVIDENCE');
  const analytics = source('rota_task_analytics', { totals: { total: 2 } });
  const search = source('rota_task_search', { tasks: [] }, { id: 'R2', envelope: { totalCount: 3 } });
  assert.equal(issue(verify([analytics, search], { operation: 'value', metrics: ['tasks.total'] }, ['R1:data.totals.total'])), 'STALE_EVIDENCE');
});

test('a declared layout binds the answer; a selection may omit it but cannot contradict it (#1)', () => {
  const entry = source('rota_task_search', { tasks: [{ taskId: 't1', title: 'Bir', targetFinish: '2026-10-01' }, { taskId: 't2', title: 'İki', targetFinish: '2026-10-02' }] },
    { collection: 'tasks', envelope: { totalCount: 2 } });
  const request = { operation: 'list', metrics: ['task.targetFinish'], layout: 'table' };
  const omitted = verify([entry], request, ['R1:data.tasks.*.title', 'R1:data.tasks.*.targetFinish']);
  assert.equal(issue(omitted), null);
  assert.match(omitted.normalized, /\|/, 'bildirilen tablo düzeni uygulanır');
  const conflict = analyzeGroundedAnswer(JSON.stringify({ kind: 'rota', facts: ['R1:data.tasks.*.title', 'R1:data.tasks.*.targetFinish'], layout: 'list' }), {
    evidenceIds: ['R1'], evidencePayloads: [{ id: 'R1', payload: JSON.stringify(entry.envelope) }],
    request: { entities: [], fields: [], bindings: [], ...request }, evidence: new Map([['R1', entry]]) });
  assert.equal(issue(conflict), 'LAYOUT_MISMATCH');
  // "auto" sunucunun kararıdır: bildirilen düzenle çelişmez, bildirilen düzen uygulanır.
  const auto = analyzeGroundedAnswer(JSON.stringify({ kind: 'rota', facts: ['R1:data.tasks.*.title', 'R1:data.tasks.*.targetFinish'], layout: 'auto' }), {
    evidenceIds: ['R1'], evidencePayloads: [{ id: 'R1', payload: JSON.stringify(entry.envelope) }],
    request: { entities: [], fields: [], bindings: [], ...request }, evidence: new Map([['R1', entry]]) });
  assert.equal(issue(auto), null);
  assert.match(auto.normalized, /\|/);
});

/* ── Sunucu seçimi ve devir kararı aynı kuralları kullanır ── */

test('server selection honors bindings and the indexed arguments; Deep readiness uses the verifier eligibility (#5, #21, #24)', async (t) => {
  const stack = stackFor(t);
  const { ledger } = await callRotaTools(stack, AYSE, [['rota_project_detail', { projectId: PROJECTS.FULL }], ['rota_project_detail', { projectId: PROJECTS.READ }]]);
  const request = parsedRequest({ operation: 'value', metrics: ['tasks.open', 'tasks.total'], population: { tool: 'rota_project_detail' },
    entities: [{ type: 'project', id: PROJECTS.FULL }, { type: 'project', id: PROJECTS.READ }], bindings: [{ metric: 'tasks.open', entity: 0 }, { metric: 'tasks.total', entity: 1 }] });
  const [candidate, ...others] = requestSelections(request, ledger.requestEntries(), null, REQUEST_TODAY);
  assert.equal(others.length, 0);
  assert.deepEqual(JSON.parse(candidate).facts, ['R1:data.visibleTasks.open', 'R2:data.visibleTasks.total'], 'her ölçü yalnızca bağlı varlığından seçilir');
  assert.equal(issue(verifyRequested(ledger, JSON.parse(candidate).facts, request)), null);
  // Sıra uyuşmayan liste kanıtı doğrulanamaz: Derin düşünme turu harcanmaz.
  stack.db.tasks.forEach((task, index) => { task.UpdatedAt = new Date(Date.UTC(2026, 8, 1 + index)); });
  const sorted = await callRotaTool(stack, AYSE, 'rota_task_search', { sort: 'updated_desc' });
  const list = parsedRequest({ operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks', sort: 'target_finish_asc' } });
  assert.equal(requestEvidenceReady(list, sorted.ledger.requestEntries(), REQUEST_TODAY), false);
  assert.equal(requestEvidenceReady({ ...list, population: { ...list.population, sort: 'updated_desc' } }, sorted.ledger.requestEntries(), REQUEST_TODAY), true);
  const rank = parsedRequest({ operation: 'rank', metrics: ['task.updatedAt', 'task.title'],
    population: { tool: 'rota_task_search', collection: 'tasks', sort: 'updated_desc' }, rank: { metric: 'task.updatedAt', order: 'desc', limit: 1 } });
  assert.deepEqual(complete(rank, []).problems, []);
  assert.equal(requestEvidenceReady(rank, sorted.ledger.requestEntries(), REQUEST_TODAY), true);
  const [ranked] = requestSelections(rank, sorted.ledger.requestEntries(), null, REQUEST_TODAY);
  assert.equal(issue(verifyRequested(sorted.ledger, JSON.parse(ranked).facts, rank)), null);
  const flags = parsedRequest({ operation: 'list', metrics: ['task.milestone', 'task.overdue'],
    population: { tool: 'rota_task_search', collection: 'tasks', sort: 'updated_desc' } });
  const [selected] = requestSelections(flags, sorted.ledger.requestEntries(), null, REQUEST_TODAY);
  const rendered = verifyRequested(sorted.ledger, JSON.parse(selected).facts, flags);
  assert.equal(issue(rendered), null);
  assert.doesNotMatch(rendered.normalized, /Belirtilmemiş/);
});

/* ── Zayıf model protokolü: biçim toleransı ve sunucu seçimi ── */

test('a single structured value is extracted from surrounding prose; ambiguous or prose-only text is not', async () => {
  const { parseEvidenceResponse } = await import('../src/domain/ai/evidenceVerification.js');
  const selection = { kind: 'rota', facts: ['R1:data.totals.overdue'] };
  const fence = (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
  const table = [
    [JSON.stringify(selection), selection],
    [fence(selection), selection],
    [`${JSON.stringify(selection)}\n\nToplam 4 gecikmiş görev var.`, selection],
    [`Seçimim:\n${fence(selection)}\nAçıklama`, selection],
    [JSON.stringify({ kind: 'rota', facts: ['R1:a}b'] }) + ' not', { kind: 'rota', facts: ['R1:a}b'] }],
    [`${fence({ a: 1 })} ve ${fence({ b: 2 })}`, null],
    ['Toplam 4 görev {"kind":"rota"}', null],
    ['Yalnızca metin', null]
  ];
  for (const [text, expected] of table) assert.deepEqual(parseEvidenceResponse(text), expected, text);
});

test('a population dimension written at request level belongs to the population; a conflicting or population-less one is still refused', () => {
  const moved = parsedRequest({ operation: 'value', metrics: ['task.description'], population: { tool: 'rota_task_detail' }, textFields: ['description'],
    entities: [{ type: 'task', id: '20000000-0000-4000-8000-000000000005' }] });
  assert.deepEqual(moved.population, { tool: 'rota_task_detail', textFields: ['description'] });
  assert.throws(() => parsedRequest({ operation: 'list', metrics: ['wbs.name'], population: { tool: 'rota_wbs_inspect', depth: 2 }, depth: 3 }), (error) => error.details.includes('$.depth:unknown'));
  assert.throws(() => parsedRequest({ operation: 'list', metrics: ['task.title'], collection: 'tasks' }), (error) => error.details.includes('$.collection:unknown'));
});

test('the plan language repeated in a selection is harmless; an unknown language or key is not', () => {
  const entry = source('rota_task_analytics', { totals: { overdue: 4 } });
  const request = { entities: [], fields: [], bindings: [], layout: 'auto', operation: 'value', metrics: ['tasks.overdue'] };
  const run = (answer) => analyzeGroundedAnswer(JSON.stringify(answer), { evidenceIds: ['R1'], evidencePayloads: [{ id: 'R1', payload: JSON.stringify(entry.envelope) }],
    request, evidence: new Map([['R1', entry]]) });
  assert.equal(issue(run({ kind: 'rota', language: 'tr', facts: ['R1:data.totals.overdue'] })), null);
  assert.notEqual(issue(run({ kind: 'rota', language: 'de', facts: ['R1:data.totals.overdue'] })), null);
  assert.notEqual(issue(run({ kind: 'rota', note: 'x', facts: ['R1:data.totals.overdue'] })), null);
});

test('a total whose only other registry path is a group/project row is server-selected for a value request; meaningful alternatives stay with the model', async (t) => {
  const stack = stackFor(t);
  const analytics = await callRotaTools(stack, AYSE, [['rota_task_analytics', { assignee: 'me' }]]);
  const total = parsedRequest({ operation: 'value', metrics: ['tasks.overdue'], population: { tool: 'rota_task_analytics' }, filters: { assignee: 'me' } });
  const [candidate] = requestSelections(total, analytics.ledger.requestEntries(), null, REQUEST_TODAY);
  assert.deepEqual(JSON.parse(candidate).facts, ['R1:data.totals.overdue']);
  assert.equal(issue(verifyRequested(analytics.ledger, JSON.parse(candidate).facts, total)), null);
  // Proje adı ve kodu aynı ölçünün iki anlamlı taşıyıcısıdır: sunucu birini seçmez.
  const detail = await callRotaTools(stack, AYSE, [['rota_task_detail', { taskId: '20000000-0000-4000-8000-000000000001' }]]);
  const project = parsedRequest({ operation: 'value', metrics: ['task.project'], population: { tool: 'rota_task_detail' }, entities: [{ type: 'task', id: '20000000-0000-4000-8000-000000000001' }] });
  assert.deepEqual(requestSelections(project, detail.ledger.requestEntries(), null, REQUEST_TODAY), []);
});

test('nested plan fields written as JSON text are decoded before the unchanged schema checks; invalid text is still refused', async () => {
  const { unpackTypedPlan } = await import('../src/server/ai/tools/executionSet.js');
  const request = { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_search' }, layout: 'auto', entities: [{ type: 'project', text: 'Radar' }] };
  const calls = [{ name: 'rota_task_search', arguments: { deadline: 'overdue' } }];
  const unpack = (args) => unpackTypedPlan({ toolCalls: [{ id: 'p', name: 'rota_plan', arguments: JSON.stringify(args) }] });
  const table = [
    { intent: 'rota', language: 'tr', request: JSON.stringify(request), calls },
    { intent: 'rota', language: 'tr', request, calls: JSON.stringify(calls) },
    { intent: 'rota', language: 'tr', request: { ...request, entities: JSON.stringify(request.entities) }, calls },
    { intent: 'rota', language: 'tr', request, calls: [{ name: 'rota_task_search', arguments: JSON.stringify(calls[0].arguments) }] }
  ];
  for (const args of table) {
    const { plan, calls: unpacked } = unpack(args);
    assert.deepEqual(plan.request, request);
    assert.deepEqual(unpacked.map((call) => [call.name, JSON.parse(call.arguments)]), [['rota_task_search', { deadline: 'overdue' }]]);
  }
  assert.throws(() => unpack({ intent: 'rota', language: 'tr', request, calls: '[{"name":' }), (error) => error.details.includes('$.plan:shape'));
});

/* ── Bildirimden türetilen okumalar ve kayıtlı kimlikler ──── */

test('every registered breakdown count equals the total of the task population restricted by its defining filter (property)', async (t) => {
  const { BREAKDOWN_FILTERS } = await import('../src/server/ai/tools/requestPopulation.js');
  const stack = stackFor(t);
  for (const scope of [{}, { projectId: PROJECTS.FULL }, { assignee: 'me' }]) {
    const analytics = (await callRotaTool(stack, AYSE, 'rota_task_analytics', scope)).result.data.totals;
    for (const [metric, filter] of Object.entries(BREAKDOWN_FILTERS)) {
      const search = (await callRotaTool(stack, AYSE, 'rota_task_search', { ...scope, ...filter })).result;
      assert.equal(search.totalCount, analytics[metric.slice('tasks.'.length)], `${metric} ${JSON.stringify(scope)}`);
    }
  }
  // Kırılım, tanımlayan koşulu taşıyan nüfusta toplamdır; koşul yoksa yeniden adlandırılmaz.
  assert.deepEqual(complete({ operation: 'value', metrics: ['tasks.overdue'], population: { tool: 'rota_task_search' } }, [['rota_task_search', { deadline: 'overdue', assignee: 'me' }]]).request.metrics, ['tasks.total']);
  assert.ok(complete({ operation: 'value', metrics: ['tasks.overdue'], population: { tool: 'rota_task_search' } }, [['rota_task_search', { assignee: 'me' }]]).problems.includes('$.metrics[0]:population'));
});

test('analytics carriers registered as the same value are equal on real tool output (property)', async (t) => {
  const { SAME_VALUE_PATHS } = await import('../src/server/ai/tools/requestDeclaration.js');
  const stack = stackFor(t);
  for (const args of [{}, { projectId: PROJECTS.FULL }, { assignee: 'me', groupBy: 'status' }]) {
    const { result } = await callRotaTool(stack, AYSE, 'rota_task_analytics', args);
    const values = SAME_VALUE_PATHS.rota_task_analytics['tasks.total'].map((path) => path.split('.').reduce((value, key) => value?.[key], { data: result.data, totalCount: result.totalCount }));
    assert.equal(new Set(values).size, 1, JSON.stringify({ args, values }));
  }
});

test('reads derived from the declaration: name resolution first, then the population read with the bound identities; nothing the declaration cannot express', async () => {
  const { derivedReads, readKey } = await import('../src/server/ai/tools/requestPopulation.js');
  const derive = (raw, bound, attempted = []) => {
    const request = parsedRequest(raw);
    const entities = request.entities.map((entity, index) => ({ ...entity, bound: bound[index] ?? entity.id ?? null }));
    return derivedReads(request, entities, { today: REQUEST_TODAY, attempted: new Set(attempted.map(([name, args]) => readKey(name, args, REQUEST_TODAY))) })
      .map(({ name, args }) => [name, args]);
  };
  const overdueMine = { operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' }, filters: { deadline: 'overdue', assignee: 'me' } };
  // Çağrısız istek: nüfus okuması bildirimden kurulur.
  // Liste nüfusun bütün satırlarıdır: aracın en büyük sayfasıyla bir kez okunur.
  assert.deepEqual(derive(overdueMine, []), [['rota_task_search', { deadline: 'overdue', assignee: 'me', sort: 'overdue_days_desc', limit: 50 }]]);
  // Aynı nüfus farklı yazımla okunduysa yinelenmez; küçük sayfa eksik okumadır ve bir kez tam okunur.
  assert.deepEqual(derive(overdueMine, [], [['rota_task_search', { assignee: 'me', deadline: 'overdue', limit: 50 }]]), []);
  assert.equal(derive(overdueMine, [], [['rota_task_search', { assignee: 'me', deadline: 'overdue' }]]).length, 1);
  assert.equal(derive(overdueMine, [], [['rota_task_search', { assignee: 'me', deadline: 'overdue', limit: 1 }]]).length, 1);
  // Adla bildirilen varlık önce çözülür; çözülünce nüfus okuması bağlı kimlikle yapılır.
  const inProject = { operation: 'value', metrics: ['tasks.inProgress'], population: { tool: 'rota_task_analytics' }, entities: [{ type: 'project', text: 'Radar Modernizasyonu' }] };
  assert.deepEqual(derive(inProject, []), [['rota_project_search', { text: 'Radar Modernizasyonu' }]]);
  // Ad araması kullanıcının yazdığı biçimle yapılır (noktasız ı katlanmış karşılaştırma metnine dönüşmez).
  assert.deepEqual(derive({ operation: 'value', metrics: ['task.status'], population: { tool: 'rota_task_search' }, entities: [{ type: 'task', text: 'Radar test planı' }] }, []),
    [['rota_task_search', { text: 'Radar test planı' }]]);
  assert.deepEqual(derive(inProject, [PROJECTS.FULL]), [['rota_task_analytics', { projectId: PROJECTS.FULL }]]);
  // Aynı türde birden çok varlık: varlık başına bir okuma.
  const two = { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_project_detail' },
    entities: [{ type: 'project', id: PROJECTS.FULL }, { type: 'project', id: PROJECTS.READ }], bindings: [{ metric: 'tasks.total', entity: 0 }, { metric: 'tasks.total', entity: 1 }] };
  assert.deepEqual(derive(two, []), [['rota_project_detail', { projectId: PROJECTS.FULL }], ['rota_project_detail', { projectId: PROJECTS.READ }]]);
  // Aracın gerekli seçicisi bağlanamıyorsa ya da koşulu ifade edemiyorsa okuma kurulmaz.
  assert.deepEqual(derive({ operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_project_detail' } }, []), []);
  assert.deepEqual(derive({ operation: 'value', metrics: ['projects.total'], population: { tool: 'rota_portfolio_summary' }, filters: { deadline: 'overdue' } }, []), []);
  // Seçiciyle çelişen koşul (kişi seçicisi ile "assignee: me") okuma kurmaz ve turu hataya düşürmez.
  assert.deepEqual(derive({ operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' },
    entities: [{ type: 'person', text: 'Zeynep Kaya' }], filters: { assignee: 'me' } }, ['910003']), []);
});

test('derived reads stay inside the declared population: shared comparison context is never dropped and names resolve inside the one declared project', async () => {
  const { derivedReads } = await import('../src/server/ai/tools/requestPopulation.js');
  const derive = (raw, bound) => {
    const request = parsedRequest(raw);
    return derivedReads(request, request.entities.map((entity, index) => ({ ...entity, bound: bound[index] ?? entity.id ?? null })), { today: REQUEST_TODAY })
      .map(({ name, args }) => [name, args]);
  };
  // Karşılaştırmanın her öznesi kendi okumasıdır; hiçbir ölçüye bağlanmayan proje ortak bağlamdır ve düşürülemez.
  const people = [{ type: 'person', id: String(AYSE) }, { type: 'person', id: String(AYSE + 1) }];
  const compare = { operation: 'value', metrics: ['tasks.open'], population: { tool: 'rota_task_analytics' }, entities: people,
    bindings: [{ metric: 'tasks.open', entity: 0 }, { metric: 'tasks.open', entity: 1 }] };
  assert.deepEqual(derive(compare, []), [['rota_task_analytics', { personSicil: AYSE }], ['rota_task_analytics', { personSicil: AYSE + 1 }]]);
  assert.deepEqual(derive({ ...compare, entities: [...people, { type: 'project', id: PROJECTS.FULL }] }, []), [],
    'proje seçicisiz kişi okuması bildirilen nüfustan geniştir');
  // Tek bildirilen projenin görev, WBS ve baz plan adı o projede, proje bağlandıktan sonra çözülür.
  const task = { operation: 'value', metrics: ['task.status'], population: { tool: 'rota_task_search' },
    entities: [{ type: 'project', text: 'Radar Modernizasyonu' }, { type: 'task', text: 'Radar test planı' }] };
  assert.deepEqual(derive(task, []), [['rota_project_search', { text: 'Radar Modernizasyonu' }]]);
  assert.deepEqual(derive(task, [PROJECTS.FULL]), [['rota_task_search', { text: 'Radar test planı', projectId: PROJECTS.FULL }]]);
  const separate = { ...task, metrics: ['task.status', 'tasks.open'], bindings: [{ metric: 'tasks.open', entity: 0 }, { metric: 'task.status', entity: 1 }] };
  assert.deepEqual(derive(separate, [PROJECTS.FULL]), [['rota_task_search', { text: 'Radar test planı' }]], 'karşılaştırmada görev projeye bağlı değildir');
  const wbs = { operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks' },
    entities: [{ type: 'project', text: 'Radar Modernizasyonu' }, { type: 'wbs', text: 'Tasarım' }] };
  assert.deepEqual(derive(wbs, []), [['rota_project_search', { text: 'Radar Modernizasyonu' }]]);
  assert.deepEqual(derive(wbs, [PROJECTS.FULL]), [['rota_wbs_inspect', { projectId: PROJECTS.FULL, depth: 4, limit: 60 }]]);
  assert.deepEqual(derive({ ...wbs, entities: [{ type: 'wbs', text: 'Tasarım' }] }, []), [], 'proje olmadan WBS adı çözülmez');
  const baseline = { operation: 'value', metrics: ['baseline.finishSlipped'], population: { tool: 'rota_baseline_compare' },
    entities: [{ type: 'project', id: PROJECTS.FULL }, { type: 'baseline', text: 'İlk plan' }] };
  assert.deepEqual(derive(baseline, []), [['rota_baseline_compare', { projectId: PROJECTS.FULL, limit: 25 }]]);
});

test('a depth-limited WBS listing is the complete population of that depth and its total counts that depth', async (t) => {
  const stack = stackFor(t);
  const { ledger } = await callRotaTools(stack, AYSE, [['rota_wbs_inspect', { projectId: PROJECTS.FULL, depth: 2 }]]);
  const [entry] = ledger.requestEntries();
  assert.deepEqual([entry.payload.complete, entry.payload.totalCount, entry.payload.data.nodeCount, entry.payload.data.deeperNodes], [true, 2, 2, true],
    'derinlik nüfusun boyutudur; daha derin düğümler yalnızca not edilir');
  const counted = { operation: 'list', metrics: ['wbs.nodes', 'wbs.name'], fields: ['name', 'code'].map((field) => ({ metric: 'wbs.name', tool: 'rota_wbs_inspect', path: `data.nodes.*.${field}` })), population: { tool: 'rota_wbs_inspect', collection: 'nodes', depth: 2 },
    entities: [{ type: 'project', id: PROJECTS.FULL }] };
  const verdict = verifyRequested(ledger, ['R1:data.nodeCount', 'R1:data.nodes.*.name', 'R1:data.nodes.*.code'], counted);
  assert.equal(issue(verdict), null);
  assert.match(verdict.normalized, /^Düğüm sayısı: \*\*2\*\* \(ölçüt: Derinlik: 2 düzey\)/);
  // Derinlikle sınırlı listede tek ad eşleşmesi bütün ağaçta tek olduğunu kanıtlamaz.
  const named = parsedRequest({ operation: 'value', metrics: ['wbs.subtreeTasks'], population: { tool: 'rota_wbs_inspect' },
    entities: [{ type: 'project', id: PROJECTS.FULL }, { type: 'wbs', text: 'Tasarım' }] });
  const { bindRequestEntities } = await import('../src/server/ai/tools/requestDeclaration.js');
  assert.equal(bindRequestEntities(named, ledger.requestEntries())[1].bound, null);
  const deep = await callRotaTools(stack, AYSE, [['rota_wbs_inspect', { projectId: PROJECTS.FULL, depth: 4 }]]);
  assert.deepEqual([deep.ledger.requestEntries()[0].payload.totalCount, deep.ledger.requestEntries()[0].payload.data.deeperNodes], [3, false]);
  assert.notEqual(bindRequestEntities(named, deep.ledger.requestEntries())[1].bound, null);
});

test('a list without a declared collection is every sibling collection carrying its row metrics, each listed completely', async (t) => {
  const stack = stackFor(t);
  const task = '20000000-0000-4000-8000-000000000002';
  const { ledger } = await callRotaTools(stack, AYSE, [['rota_dependency_inspect', { taskId: task }]]);
  const raw = { operation: 'list', metrics: ['task.title', 'dependency.type'], population: { tool: 'rota_dependency_inspect' }, entities: [{ type: 'task', id: task }] };
  const completed = complete(raw, [['rota_dependency_inspect', { taskId: task }]]);
  assert.deepEqual([completed.problems, completed.request.population.collection], [[], undefined]);
  const request = parsedRequest(raw);
  const [candidate] = requestSelections(request, ledger.requestEntries(), null, REQUEST_TODAY);
  const facts = JSON.parse(candidate).facts;
  assert.ok(['R1:data.predecessors.*.title', 'R1:data.successors.*.title', 'R1:data.predecessors.*.type', 'R1:data.successors.*.type'].every((fact) => facts.includes(fact)), facts.join());
  assert.equal(issue(verifyRequested(ledger, facts, raw)), null);
  assert.equal(issue(verifyRequested(ledger, ['R1:data.predecessors.*.title', 'R1:data.predecessors.*.type'], raw)), 'LIST_INCOMPLETE', 'ardıllar da listelenmelidir');
  assert.equal(issue(verifyRequested(ledger, facts, { ...raw, population: { tool: 'rota_dependency_inspect', collection: 'predecessors' } })), 'POPULATION_MISMATCH',
    'tek koleksiyon bildirilince diğeri yanıt olamaz');
});

test('a registered row carrier the rows do not write is not an ambiguity: a priority distribution is server-selected', async (t) => {
  const stack = stackFor(t);
  const { ledger } = await callRotaTools(stack, AYSE, [['rota_task_analytics', { assignee: 'me', groupBy: 'priority' }]]);
  const raw = { operation: 'list', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy: 'priority' }, filters: { assignee: 'me' } };
  const [candidate] = requestSelections(parsedRequest(raw), ledger.requestEntries(), null, REQUEST_TODAY);
  assert.deepEqual(JSON.parse(candidate).facts.filter((fact) => fact.includes('groups')), ['R1:data.groups.*.label', 'R1:data.groups.*.count']);
  assert.equal(issue(verifyRequested(ledger, JSON.parse(candidate).facts, raw)), null);
  // Bildirilen koleksiyonun satırları listenin yanıtıdır; aynı ölçünün genel toplamı yalnızca bağlamdır.
  const workload = await callRotaTools(stack, AYSE, [['rota_workload_summary', {}]]);
  const people = { operation: 'list', metrics: ['tasks.open'], population: { tool: 'rota_workload_summary', collection: 'people' } };
  assert.deepEqual(requestSelections(parsedRequest(people), workload.ledger.requestEntries(), null, REQUEST_TODAY).map((item) => JSON.parse(item).facts),
    [['R1:data.people.*.name', 'R1:data.people.*.openTasks']]);
});

test('a task-selected series counts its own occurrences: an empty upcoming list is answered by the series count', async (t) => {
  const stack = stackFor(t);
  const { ledger } = await callRotaTools(stack, AYSE, [['rota_recurrence_inspect', { taskId: TASKS.SERIES }]], { now: new Date('2026-10-10T21:30:00.000Z') });
  const raw = { operation: 'list', metrics: ['recurrence.occurrenceDate', 'recurrence.upcomingOccurrences'], population: { tool: 'rota_recurrence_inspect', collection: 'series.next' },
    entities: [{ type: 'task', id: TASKS.SERIES }] };
  const selections = requestSelections(parsedRequest(raw), ledger.requestEntries(), null, '2026-10-11').map((item) => JSON.parse(item).facts);
  assert.deepEqual(selections, [['R1:data.series.upcomingCount']]);
  assert.match(verifyRequested(ledger, selections[0], raw, { today: '2026-10-11' }).normalized, /^Yaklaşan yineleme: \*\*0\*\*/);
  // Serinin kendi özelliği (kural) yinelemelerinin listesinde üst kaydı anlatır; boş listede boşluk ayrıca söylenir.
  const ruled = { ...raw, metrics: ['recurrence.occurrenceDate', 'recurrence.rule'], fields: ['rule', 'ruleDescription'].map((field) => ({ metric: 'recurrence.rule', tool: 'rota_recurrence_inspect', path: `data.series.${field}` })) };
  const [ruledFacts] = requestSelections(parsedRequest(ruled), ledger.requestEntries(), null, '2026-10-11').map((item) => JSON.parse(item).facts);
  assert.deepEqual(ruledFacts, ['R1:data.series.rule', 'R1:data.series.ruleDescription', 'R1:complete']);
  const ruledVerdict = verifyRequested(ledger, ruledFacts, ruled, { today: '2026-10-11' });
  assert.equal(ruledVerdict.ok, true, JSON.stringify(ruledVerdict.issues));
  assert.match(ruledVerdict.normalized, /Her hafta[\s\S]*bulunmadı/);
  assert.equal(ruledVerdict.normalized.match(/Her hafta/g).length, 2, 'kural ve açıklama ayrı alanlardır; eşit değerler onları birleştirmez');
  // Seri sayımları (açık yineleme) üst kaydın özelliği değildir: satırlarla birlikte sayı olamaz.
  assert.ok(complete({ ...raw, metrics: ['recurrence.occurrenceDate', 'recurrence.openOccurrences'] }, []).problems.includes('$.metrics[1]:not-row-total'));
  const upcoming = await callRotaTools(stack, AYSE, [['rota_recurrence_inspect', { taskId: TASKS.SERIES }]]);
  const [withRows] = requestSelections(parsedRequest(ruled), upcoming.ledger.requestEntries(), null, REQUEST_TODAY).map((item) => JSON.parse(item).facts);
  assert.ok(withRows.includes('R1:data.series.next.*.occurrenceDate') && withRows.includes('R1:data.series.rule'), withRows.join());
  assert.equal(issue(verifyRequested(upcoming.ledger, withRows, ruled)), null);
});

test('distinct name and code carriers are server-selected when explicitly bound; ambiguous fields stay with the model', async (t) => {
  const stack = stackFor(t);
  const { ledger } = await callRotaTools(stack, AYSE, [['rota_task_search', { deadline: 'overdue', assignee: 'me' }]]);
  const list = parsedRequest({ operation: 'list', metrics: ['task.title', 'task.project'], population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' },
    filters: { deadline: 'overdue', assignee: 'me' }, fields: ['name', 'code'].map((field) => ({ metric: 'task.project', tool: 'rota_task_search', path: `data.tasks.*.project.${field}` })) });
  assert.deepEqual(requestSelections({ ...list, fields: [] }, ledger.requestEntries(), null, REQUEST_TODAY), []);
  assert.ok(complete({ ...list, fields: [] }, []).problems.includes('$.fields:required'));
  const [candidate] = requestSelections(list, ledger.requestEntries(), null, REQUEST_TODAY);
  assert.ok(JSON.parse(candidate).facts.includes('R1:data.tasks.*.project.name'));
  assert.ok(JSON.parse(candidate).facts.includes('R1:data.tasks.*.project.code'));
  assert.equal(issue(verifyRequested(ledger, JSON.parse(candidate).facts, list)), null);
  const wbs = await callRotaTool(stack, AYSE, 'rota_wbs_inspect', { projectId: PROJECTS.FULL, depth: 4 });
  const nodes = parsedRequest({ operation: 'list', metrics: ['wbs.name'], entities: [{ type: 'project', id: PROJECTS.FULL }], population: { tool: 'rota_wbs_inspect', collection: 'nodes', depth: 4 }, fields: ['name', 'code'].map((field) => ({ metric: 'wbs.name', tool: 'rota_wbs_inspect', path: `data.nodes.*.${field}` })) });
  assert.deepEqual(requestSelections({ ...nodes, fields: [] }, wbs.ledger.requestEntries(), null, REQUEST_TODAY), []);
  assert.ok(complete({ ...nodes, fields: [] }, []).problems.includes('$.fields:required'));
  assert.deepEqual(requestSelections(nodes, wbs.ledger.requestEntries(), null, REQUEST_TODAY).map((item) => JSON.parse(item).facts),
    [['R1:data.nodes.*.name', 'R1:data.nodes.*.code']], 'düğüm adı ve kodu ayrı açık alanlardır');
});

const entriesOf = (sources) => sources.map((item) => ({ id: item.id, tool: item.tool, args: item.args || {}, payload: item.envelope, round: item.round, snapshot: item.snapshot }));

test('a synthesized empty actor uses its own canonical metadata, not the sibling change metadata', () => {
  const entry = source('rota_activity_search', { items: [{ kind: 'updated', actor: null,
    structuredChanges: [{ field: 'progress', after: 30 }] }] },
  { collection: 'items', envelope: { totalCount: 1, returnedCount: 1 } });
  const request = { operation: 'list', metrics: ['activity.changeAfter', 'activity.actor'], layout: 'table',
    population: { tool: 'rota_activity_search', collection: 'items' } };
  const answer = verify([entry], request, ['R1:data.items.0.structuredChanges.0.after']);
  assert.equal(answer.ok, true, JSON.stringify(answer.issues));
  assert.match(answer.normalized, /\| İşlemi yapan \|/);
  assert.match(answer.normalized, /Belirtilmemiş/);
  assert.doesNotMatch(answer.normalized, /İlerleme \(%\) \/ İşlemi yapan/);
});

function agreement(raw, sources, expected, references = null) {
  const request = parsedRequest(raw);
  const entries = entriesOf(sources);
  const boundRequest = { ...request, entities: requestDeclarationModule.bindRequestEntities(request, entries) };
  const evidence = requestEvidence(boundRequest, entries, REQUEST_TODAY);
  const selected = requestSelections(request, entries, null, REQUEST_TODAY);
  assert.equal(selected.length > 0, expected, 'sunucu seçimi');
  assert.equal(requestEvidenceReady(request, entries, REQUEST_TODAY), expected, 'Derin hazırlık');
  for (const candidate of selected) {
    assert.equal(analyzeGroundedAnswer(candidate, { request: boundRequest, evidence, evidenceIds: sources.map((item) => item.id),
      evidencePayloads: sources.map((item) => ({ id: item.id, payload: JSON.stringify(item.envelope) })) }).ok, true, 'aynı seçim doğrulanır');
  }
  if (references) assert.equal(verify([...evidence.values()], boundRequest, references).ok, expected, 'aynı kanıt doğrulanır');
  return selected.map((candidate) => analyzeGroundedAnswer(candidate, { request: boundRequest, evidence, evidenceIds: sources.map((item) => item.id),
    evidencePayloads: sources.map((item) => ({ id: item.id, payload: JSON.stringify(item.envelope) })) }));
}

test('population identity matrix distinguishes membership from projection, scalar grouping and row order', () => {
  const { scalarKey, rowKey } = populationModule;
  for (const text of [null, 'aranan']) {
    const a = source('rota_schedule_requests', { items: [] }, { facets: text ? { text } : {}, snapshotDimensions: { textFields: ['requesterMessage'] } });
    const b = { ...a, snapshotDimensions: { textFields: ['decisionMessage'] } };
    assert.equal(scalarKey(a) === scalarKey(b), !text, 'talep sayımı');
    assert.equal(rowKey(a, 'items') === rowKey(b, 'items'), !text, 'talep satırları');
  }
  const grouped = source('rota_task_analytics', {}, { snapshotDimensions: { groupBy: 'status' } });
  const priority = { ...grouped, snapshotDimensions: { groupBy: 'priority' } };
  assert.equal(scalarKey(grouped, 'tasks.total'), scalarKey(priority, 'tasks.total'));
  assert.notEqual(scalarKey(grouped, 'tasks.groupCount'), scalarKey(priority, 'tasks.groupCount'));
  assert.notEqual(rowKey(grouped, 'groups'), rowKey(priority, 'groups'));
  const wbs = source('rota_wbs_inspect', {});
  assert.equal(rowKey(wbs, 'nodes'), rowKey({ ...wbs, snapshotDimensions: { depth: 2 } }, 'nodes'));
  assert.notEqual(rowKey(wbs, 'nodes'), rowKey({ ...wbs, snapshotDimensions: { depth: 3 } }, 'nodes'));
  const tasks = source('rota_task_search', {});
  assert.equal(scalarKey(tasks), scalarKey({ ...tasks, snapshotDimensions: { sort: 'updated_desc' } }));
  assert.notEqual(rowKey(tasks, 'tasks'), rowKey({ ...tasks, snapshotDimensions: { sort: 'updated_desc' } }, 'tasks'));
});


test('workflow freshness and empty proofs use the same text membership matrix', () => {
  for (const searched of [false, true]) {
    const args = { ...(searched ? { text: 'aranan' } : {}), textFields: ['requesterMessage'] };
    const first = source('rota_schedule_requests', { items: [] }, { args, collection: 'items' });
    const later = source('rota_schedule_requests', { items: [] }, { id: 'R2', args: { ...args, textFields: ['decisionMessage'] }, collection: 'items' });
    const raw = { operation: 'list', metrics: ['request.status'], filters: searched ? { text: 'aranan' } : {},
      population: { tool: first.tool, collection: 'items', textFields: ['requesterMessage'] } };
    const request = parsedRequest(raw);
    const indexed = requestEvidence(request, entriesOf([first, later]), REQUEST_TODAY);
    const old = verify([...indexed.values()], request, ['R1:complete']);
    assert.equal(old.ok, searched);
    if (!searched) assert.equal(issue(old), 'STALE_EVIDENCE');
    agreement(raw, [first, later], true);
  }
});

for (const field of ['assignees', 'targetFinish']) {
  test(`selection, verifier, readiness and rendering agree on all-empty ${field}`, () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({ taskId: String(index), title: `Görev ${index}`, ...(field === 'assignees' ? { assignees: [] } : {}) }));
    const metric = field === 'assignees' ? 'task.assignees' : 'task.targetFinish';
    const raw = { operation: 'list', metrics: ['task.title', metric], layout: 'table', population: { tool: 'rota_task_search', collection: 'tasks' } };
    const item = source('rota_task_search', { tasks: rows }, { envelope: { totalCount: 3, returnedCount: 3 } });
    const [answer] = agreement(raw, [item], true, ['R1:data.tasks.*.title']);
    assert.match(answer.normalized, field === 'assignees' ? /Sorumlular/ : /Termin/);
    assert.equal((answer.normalized.match(/Belirtilmemiş/g) || []).length, 3);
    const absent = source('rota_task_search', { tasks: rows.map(({ assignees, ...row }) => row) }, { envelope: { totalCount: 3, returnedCount: 3 } });
    if (field === 'assignees') agreement(raw, [absent], false, ['R1:data.tasks.*.title']);
    item.envelope.data.sizeNote = 'kısaltıldı';
    agreement(raw, [item], false, ['R1:data.tasks.*.title']);
  });
}

test('a rank with no rank value fails closed; it is neither an empty population nor a top-N', () => {
  const raw = { operation: 'rank', metrics: ['task.title', 'task.targetFinish', 'tasks.total'], rank: { metric: 'task.targetFinish', order: 'asc', limit: 3 },
    population: { tool: 'rota_task_search', collection: 'tasks' } };
  const item = source('rota_task_search', { tasks: [{ title: 'Tarihsiz' }, { title: 'Yine tarihsiz', targetFinish: null }] }, { envelope: { totalCount: 2, returnedCount: 2 } });
  agreement(raw, [item], false, ['R1:totalCount', 'R1:complete']);
  assert.equal(issue(verify([item], raw, ['R1:totalCount', 'R1:data.tasks.*.title', 'R1:data.tasks.*.targetFinish'])), 'RANK_MISMATCH');
  agreement({ operation: 'rank', metrics: ['tasks.open'], rank: { metric: 'tasks.open', order: 'desc', limit: 1 },
    population: { tool: 'rota_workload_summary', collection: 'people' } }, [source('rota_workload_summary', { people: [{ name: 'Sayaç yok' }] })], false);
});

test('collection completeness is independent of historical dates and unrelated baseline catalogs', () => {
  const series = source('rota_recurrence_inspect', { series: [{ title: 'Seri', completionDatesComplete: false, open: 1, nextTruncated: true, next: [] }] },
    { envelope: { totalCount: 1, returnedCount: 1, complete: false, truncated: true } });
  agreement({ operation: 'list', metrics: ['task.title', 'recurrence.openOccurrences'], population: { tool: series.tool, collection: 'series' } }, [series], true);
  agreement({ operation: 'list', metrics: ['recurrence.occurrenceDate'], population: { tool: series.tool, collection: 'series.*.next' } }, [series], false);
  const baseline = source('rota_baseline_compare', { mostSlipped: [{ title: 'Görev', varianceDays: 2 }], availableBaselines: [], availableBaselinesTruncated: true },
    { envelope: { totalCount: 1, returnedCount: 1, complete: false, truncated: true } });
  agreement({ operation: 'list', metrics: ['task.varianceDays'], population: { tool: baseline.tool, collection: 'mostSlipped' } }, [baseline], true);
  baseline.envelope.returnedCount = 0;
  agreement({ operation: 'list', metrics: ['task.varianceDays'], population: { tool: baseline.tool, collection: 'mostSlipped' } }, [baseline], false);
});

test('a rank across nested child collections is not stitched and fails closed; a nested list keeps collection order', () => {
  const raw = { operation: 'rank', metrics: ['recurrence.occurrenceDate'], rank: { metric: 'recurrence.occurrenceDate', order: 'asc', limit: 1 },
    population: { tool: 'rota_recurrence_inspect', collection: 'series.*.next' } };
  const item = source('rota_recurrence_inspect', { series: [
    { nextTruncated: false, next: [{ occurrenceDate: '2026-10-01' }, { occurrenceDate: '2026-10-03' }] },
    { nextTruncated: false, next: [{ occurrenceDate: '2026-10-02' }] }
  ] }, { envelope: { totalCount: 2, returnedCount: 2 } });
  agreement(raw, [item], false);
  assert.equal(issue(verify([item], raw, ['R1:data.series.0.next.0.occurrenceDate'])), 'RANK_MISMATCH');
  const { rank: _rank, ...list } = raw;
  const [all] = agreement({ ...list, operation: 'list' }, [item], true);
  assert.deepEqual(all.facts.filter((item) => item.fact.semantic.metric === 'recurrence.occurrenceDate').map((item) => item.fact.value), ['2026-10-01', '2026-10-03', '2026-10-02']);
});

test('a boundary tie larger than one page never verifies, even beside its continuation page', () => {
  const raw = { operation: 'rank', metrics: ['task.title', 'task.overdueDays', 'tasks.total'], rank: { metric: 'task.overdueDays', order: 'desc', limit: 1 },
    population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' } };
  const rows = Array.from({ length: 70 }, (_, index) => ({ taskId: `t${index}`, title: `Eşit ${index}`, overdueDays: 7 }));
  const args = { sort: 'overdue_days_desc', limit: 20 };
  const first = source('rota_task_search', { tasks: rows.slice(0, 20) }, { args, envelope: { totalCount: 70, returnedCount: 20, complete: false, nextCursor: 'devam',
    rankingBoundary: { collection: 'tasks', metric: 'task.overdueDays', order: 'desc', returnedCount: 20, nextValue: 7 } } });
  const last = source('rota_task_search', { tasks: rows.slice(20) }, { id: 'R2', args: { ...args, cursor: 'devam', limit: 50 },
    envelope: { totalCount: 70, returnedCount: 50, nextCursor: null } });
  agreement(raw, [first], false);
  agreement(raw, [first, last], false);
  assert.equal(verify([first, last], raw, ['R1:totalCount', 'R1:data.tasks.*.overdueDays', 'R2:data.tasks.*.overdueDays']).ok, false);
});

test('readiness preserves a complete rank beside a partial page in the same round', async (t) => {
  const { ledger } = await callRotaTools(stackFor(t), AYSE, [['rota_person_search', { text: 'Ayşe Yılmaz' }], ['rota_task_search', { personSicil: AYSE }], ['rota_task_search', { personSicil: AYSE, limit: 5 }]]);
  const raw = { operation: 'rank', metrics: ['task.targetFinish', 'task.status'], rank: { metric: 'task.targetFinish', order: 'asc', limit: 1 },
    population: { tool: 'rota_task_search', collection: 'tasks' }, entities: [{ type: 'person', text: 'Ayşe Yılmaz' }] };
  const verdict = verifyRequested(ledger, ['R2:data.tasks.0.targetFinish', 'R2:data.tasks.0.status'], raw);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  assert.equal(requestEvidenceReady(parsedRequest(raw), ledger.requestEntries(), REQUEST_TODAY), true);
  assert.equal(requestSelections(parsedRequest(raw), ledger.requestEntries(), null, REQUEST_TODAY).length > 0, true);
});

test('selector promotion precedes recurrence and entity grouping shapes; completion remains idempotent', () => {
  const calls = [['rota_recurrence_inspect', { taskId: TASKS.SERIES }]];
  const result = complete({ operation: 'list', metrics: ['recurrence.occurrenceDate'], population: { tool: 'rota_recurrence_inspect', collection: 'series.*.next' } }, calls);
  assert.deepEqual(result.problems, []);
  assert.equal(result.request.population.collection, 'series.next');
  assert.deepEqual(result.request.entities.map((entity) => [entity.type, entity.id]), [['task', TASKS.SERIES]]);
  const repeated = completeRequest(result.request, planned(...calls), { today: REQUEST_TODAY });
  assert.deepEqual(repeated.request, result.request);
  assert.deepEqual(repeated.problems, []);
  const grouped = complete({ operation: 'list', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics', groupBy: 'project' } },
    [['rota_task_analytics', { projectId: PROJECTS.FULL }]]);
  assert.deepEqual(grouped.problems, []);
  assert.equal(grouped.request.operation, 'value');
  assert.equal(grouped.request.population.groupBy, undefined);
  assert.equal(complete({ operation: 'list', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics', groupBy: 'project' } }, []).request.operation, 'list');
});

test('breakdown canonicalization rewrites metric and registered carrier together before capability validation', () => {
  const raw = { operation: 'value', metrics: ['tasks.overdue'], filters: { deadline: 'overdue' }, population: { tool: 'rota_task_search' },
    fields: [{ metric: 'tasks.overdue', tool: 'rota_task_analytics', path: 'data.totals.overdue' }] };
  const result = complete(raw, [['rota_task_search', { deadline: 'overdue' }]]);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.request.fields, [{ metric: 'tasks.total', tool: 'rota_task_search', path: 'totalCount' }]);
  assert.deepEqual(completeRequest(result.request, planned(['rota_task_search', { deadline: 'overdue' }]), { today: REQUEST_TODAY }).problems, []);
  const bad = { ...result.request, fields: [{ ...result.request.fields[0], path: 'data.totals.overdue', tool: 'rota_task_analytics' }] };
  assert.ok(completeRequest(bad, [], { today: REQUEST_TODAY }).problems.includes('$.fields:metric'));
});

test('row-only value declarations reject even one collection or an explicit row field, while list and entity values remain legal', () => {
  for (const [metric, tool, collection, entities, args] of [
    ['dependency.type', 'rota_dependency_inspect', 'predecessors', [{ type: 'task', id: TASKS.OVERDUE }], { taskId: TASKS.OVERDUE }],
    ['activity.kind', 'rota_activity_search', 'items', [], {}],
    ['wbs.name', 'rota_wbs_inspect', 'nodes', [{ type: 'project', id: PROJECTS.FULL }], { projectId: PROJECTS.FULL }],
    ['task.title', 'rota_task_search', 'tasks', [], {}]
  ]) {
    const raw = { operation: 'value', metrics: [metric], population: { tool, collection, ...(tool === 'rota_wbs_inspect' ? { depth: 2 } : {}) }, entities };
    const result = complete(raw, [[tool, args]]);
    assert.ok(result.problems.some((problem) => /:rows|:entity/.test(problem)), metric);
    const path = claimableVocabulary.metricPaths(tool, metric).find((candidate) => candidate.startsWith(`data.${collection}.`));
    assert.ok(complete({ ...raw, fields: [{ metric, tool, path }] }, [[tool, args]]).problems.some((problem) => /:rows|:entity/.test(problem)), `${metric} bound row`);
    assert.deepEqual(complete({ ...raw, operation: 'list', fields: [{ metric, tool, path }] }, [[tool, args]]).problems, [], `${metric} list`);
  }
  assert.deepEqual(complete({ operation: 'value', metrics: ['task.title'], population: { tool: 'rota_task_search' }, entities: [{ type: 'task', text: 'Radar test planı' }] }, []).problems, []);
});

test('canonical executions apply the unique cap after deduplication and retain a separate atomic raw abuse bound', async () => {
  const { createCallIds, prepareExecutionSet, unpackTypedPlan } = await import('../src/server/ai/tools/executionSet.js');
  const catalog = ['rota_task_search', 'rota_task_analytics', 'rota_workload_summary'].map(getRotaTool);
  const calls = catalog.flatMap((tool) => [{ name: tool.name, arguments: '{}' }, { name: tool.name, arguments: '{}' }]);
  const request = { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_search' } };
  const unpacked = unpackTypedPlan({ toolCalls: [{ name: 'rota_plan', arguments: JSON.stringify({ intent: 'rota', language: 'tr', request,
    calls: calls.map((call) => ({ ...call, arguments: JSON.parse(call.arguments) })) }) }] });
  const prepare = (raw, attempted = 0) => prepareExecutionSet(raw, { catalog, attempted, callId: createCallIds() });
  const result = prepare(unpacked.calls);
  assert.equal(result.ok, true);
  assert.equal(result.calls.length, 3);
  assert.equal(new Set(result.calls.map((call) => call.id)).size, 3);
  const defaults = prepare([{ name: 'rota_task_search', arguments: '{}' }, { name: 'rota_task_search', arguments: '{"sort":"target_finish_asc"}' }]);
  assert.equal(defaults.calls.length, 1, 'eşdeğer varsayılan sıra tek yürütmedir');
  for (const raw of [Array(11).fill(calls[0]), [...calls, { ...calls[0], arguments: '{"status":"broken"}' }],
    Array.from({ length: 6 }, (_, index) => ({ name: 'rota_task_search', arguments: JSON.stringify({ limit: index + 1 }) }))]) {
    const refused = prepare(raw);
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.calls, [], 'geçersiz kardeş ya da sınır ihlali sıfır yürütmedir');
  }
  assert.equal(prepare(calls, 12).ok, false, 'tur bütçesi de tekil yürütmelere uygulanır');
  // Kanonik kimliğin anlam denetimi (aralıksız tarih alanı) çağrının reddidir; iç hata olarak kaçmaz, plan onarılabilir kalır.
  const semantic = prepare([calls[0], { name: 'rota_task_search', arguments: '{"dateField":"actualFinish"}' }]);
  assert.equal(semantic.ok, false);
  assert.deepEqual(semantic.calls, []);
  assert.deepEqual(semantic.problems.map(({ index, error }) => [index, error.code, error.details]),
    [[1, 'INVALID_ARGUMENTS', ['$.calls[1].rota_task_search.dateField:range']]]);
  // Doğrulayıcının programlama hatası modelin düzeltebileceği girdi değildir: reddedilmiş çağrı olarak dönmez, tur onunla biter.
  const defect = () => prepareExecutionSet([calls[0]], { catalog, callId: createCallIds(), validateCall: () => { throw new TypeError('defect'); } });
  assert.throws(defect, TypeError);
});

test('a subscription property is a unique task-bound value, while an account-wide row property requires a list', async (t) => {
  const raw = { operation: 'value', metrics: ['subscription.state'], population: { tool: 'rota_outlook_status' } };
  assert.ok(complete(raw, []).problems.includes('$.metrics[0]:entity'));
  const bound = { ...raw, entities: [{ type: 'task', id: TASKS.DUE_SOON }] };
  assert.deepEqual(complete(bound, [['rota_outlook_status', { taskId: TASKS.DUE_SOON }]]).problems, []);
  const stack = stackFor(t);
  const entries = (await callRotaTools(stack, AYSE, [['rota_outlook_status', { taskId: TASKS.DUE_SOON }]])).ledger.requestEntries();
  const request = parsedRequest(bound);
  const [selection] = requestSelections(request, entries, null, REQUEST_TODAY);
  assert.ok(selection);
  assert.equal(requestEvidenceReady(request, entries, REQUEST_TODAY), true);
  const sources = [...requestEvidence(request, entries, REQUEST_TODAY).values()];
  const entities = requestDeclarationModule.bindRequestEntities(request, entries);
  assert.equal(verify(sources, { ...request, entities }, JSON.parse(selection).facts).ok, true);
  assert.equal(verify(sources, { ...request, entities: [{ type: 'task', bound: TASKS.OVERDUE }] }, JSON.parse(selection).facts).ok, false);
});


test('semantic carrier matrix preserves equal-valued subdimensions and collapses only true aliases', () => {
  const cases = [
    ['rota_dependency_inspect', 'dependencies.byType', { coverage: { byType: { FS: 2, SS: 2, FF: 2, SF: 2 } } }, ['data.coverage.byType.FS', 'data.coverage.byType.SS', 'data.coverage.byType.FF', 'data.coverage.byType.SF'], ['Bitiş-başlangıç', 'Başlangıç-başlangıç', 'Bitiş-bitiş', 'Başlangıç-bitiş']],
    ['rota_person_search', 'person.organization', { people: [{ name: 'Kişi', organization: { directorate: 'Aynı', department: 'Aynı', unit: 'Aynı' } }] },
      ['data.people.*.organization.directorate', 'data.people.*.organization.department', 'data.people.*.organization.unit'], ['Başkanlık', 'Müdürlük', 'Birim']],
    ['rota_wbs_inspect', 'wbs.name', { nodes: [{ name: 'Aynı', code: 'Aynı' }] }, ['data.nodes.*.name', 'data.nodes.*.code'], ['Aynı']],
    ['rota_recurrence_inspect', 'recurrence.rule', { series: [{ title: 'Seri', rule: 'Aynı', ruleDescription: 'Aynı' }] }, ['data.series.*.rule', 'data.series.*.ruleDescription'], ['Aynı']]
  ];
  for (const [tool, metric, data, paths, labels] of cases) {
    const item = source(tool, data, { envelope: { totalCount: 1, returnedCount: 1 } });
    const refs = paths.map((path) => `R1:${path}`);
    const request = { operation: tool === 'rota_dependency_inspect' ? 'value' : 'list', metrics: [metric], fields: paths.map((path) => ({ tool, metric, path })) };
    const verdict = verify([item], request, refs);
    assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
    for (const label of labels) assert.ok(verdict.normalized.includes(label), `${tool}: ${label}`);
    assert.equal(new Set(paths.map((path) => claimableVocabulary.semanticCarrierKey(tool, path))).size, paths.length);
    if (tool !== 'rota_dependency_inspect') assert.equal(verify([item], request, refs.slice(0, -1)).ok, false, 'alan yükümlülüğü düşmez');
  }
  assert.equal(claimableVocabulary.equivalentCarriers('rota_task_analytics', ['data.totals.total', 'data.hours.taskCount', 'totalCount']), true);
  assert.equal(claimableVocabulary.equivalentCarriers('rota_task_detail', ['data.task.targetFinish', 'data.task.dates.targetFinish']), true);
});

test('explicit sibling fields are obligations on each row, even when their metrics and values coincide', () => {
  const item = source('rota_wbs_inspect', { nodes: [{ name: 'N1', code: 'C1' }, { name: 'N2', code: 'C2' }] }, { envelope: { totalCount: 2, returnedCount: 2 } });
  const request = { operation: 'list', metrics: ['wbs.name'], fields: ['name', 'code'].map((field) => ({ metric: 'wbs.name', tool: item.tool, path: `data.nodes.*.${field}` })) };
  assert.equal(verify([item], request, ['R1:data.nodes.0.name', 'R1:data.nodes.1.code']).ok, false);
  assert.equal(verify([item], request, ['R1:data.nodes.*.name', 'R1:data.nodes.*.code']).ok, true);
});

test('cross-tool own-property freshness compares semantic property and owner, preserving neighboring subfields', () => {
  const old = source('rota_portfolio_summary', { projects: [{ projectId: 'p', name: 'Proje', access: 'FULL' }] });
  const later = source('rota_project_detail', { access: { level: 'READ' } }, { id: 'R2', selectors: [{ type: 'project', id: 'p' }] });
  const request = { operation: 'value', metrics: ['project.access'], entities: [{ type: 'project', bound: 'p' }] };
  assert.equal(issue(verify([old, later], request, ['R1:data.projects.0.access'])), 'STALE_EVIDENCE');
  later.selectors = [{ type: 'project', id: 'other' }];
  assert.equal(verify([old, later], request, ['R1:data.projects.0.access']).ok, true);
  const organization = source('rota_person_search', { people: [{ sicil: 1, organization: { department: 'A' } }] });
  // Kişi araması üç düzeyi de yazar (boşsa açık null): daha yeni okumanın açık boşluğu eski değeri eskitir.
  const unit = source('rota_person_search', { people: [{ sicil: 1, organization: { directorate: null, department: null, unit: 'A' } }] }, { id: 'R2' });
  const department = { operation: 'value', metrics: ['person.organization'], population: { tool: 'rota_person_search' }, fields: [{ metric: 'person.organization', tool: 'rota_person_search', path: 'data.people.*.organization.department' }], entities: [{ type: 'person', bound: '1' }] };
  assert.equal(issue(verify([organization, unit], department, ['R1:data.people.0.organization.department'])), 'STALE_EVIDENCE', 'açıkça boş düzey daha yeni boşluktur');
  unit.envelope.data.people[0].organization = { unit: 'A' };
  assert.equal(verify([organization, unit], department, ['R1:data.people.0.organization.department']).ok, true, 'yazılmamış düzey okunmamıştır, boş değildir');
  delete unit.envelope.data.people[0].organization;
  assert.equal(verify([organization, unit], department, ['R1:data.people.0.organization.department']).ok, true, 'organizasyon nesnesinin yokluğu boş düzey değildir');
});

test('later pages preserve exact scalar selection while metric-aware grouping controls freshness', () => {
  const first = source('rota_task_search', { tasks: [] }, { envelope: { totalCount: 2 } });
  const last = source('rota_task_search', { tasks: [{ title: 'Son' }] }, { id: 'R2', args: { cursor: 'son' }, envelope: { totalCount: 3, returnedCount: 1, complete: false, truncated: true } });
  const [answer] = agreement({ operation: 'value', metrics: ['tasks.total'], population: { tool: first.tool } }, [first, last], true, ['R2:totalCount']);
  assert.deepEqual(answer.facts.map((fact) => fact.evidenceId), ['R2']);
  const status = source('rota_task_analytics', { totals: { total: 2 }, groupCount: 1, groupBy: 'status' }, { args: { groupBy: 'status' } });
  const priority = source('rota_task_analytics', { totals: { total: 3 }, groupCount: 2, groupBy: 'priority' }, { id: 'R2', args: { groupBy: 'priority' } });
  const raw = { operation: 'value', metrics: ['tasks.groupCount'], population: { tool: status.tool, groupBy: 'status' } };
  agreement(raw, [status, priority], true, ['R1:data.groupCount']);
  const request = parsedRequest({ ...raw, metrics: ['tasks.total'] });
  const indexed = requestEvidence(request, entriesOf([status, priority]), REQUEST_TODAY);
  assert.equal(issue(verify([...indexed.values()], request, ['R1:data.totals.total'])), 'STALE_EVIDENCE');
});

test('historical incompleteness invalidates completion properties without invalidating series membership', () => {
  const item = source('rota_recurrence_inspect', { series: [{ title: 'Seri', completionDatesComplete: false, lastCompleted: { actualFinish: '2026-09-20', occurrenceDate: '2026-09-19' }, open: 1 }] },
    { envelope: { totalCount: 1, returnedCount: 1, complete: false, truncated: true } });
  agreement({ operation: 'list', metrics: ['recurrence.openOccurrences'], population: { tool: item.tool, collection: 'series' } }, [item], true);
  agreement({ operation: 'list', metrics: ['recurrence.lastCompletedFinish'], population: { tool: item.tool, collection: 'series' } }, [item], false, ['R1:data.series.*.lastCompleted.actualFinish']);
  item.envelope.data.series[0].completionDatesComplete = true;
  agreement({ operation: 'list', metrics: ['recurrence.lastCompletedFinish'], population: { tool: item.tool, collection: 'series' } }, [item], true);
});

/* Aynı arıza ve komşu karşı örnek: ortak değişmezler. */
test('partial rereads stale only the same stable row and semantic property, including explicit empty values', () => {
  const old = source('rota_task_search', { tasks: [{ taskId: 'a', title: 'A', status: 'todo', assignees: [{ name: 'Alice' }] },
    { taskId: 'b', title: 'B', status: 'todo', assignees: [{ name: 'Bob' }] }] }, { envelope: { totalCount: 2 } });
  const latest = source('rota_task_search', { tasks: [{ taskId: 'a', title: 'A', status: 'in_progress', assignees: [] }] },
    { id: 'R2', firstPage: false, envelope: { complete: false, truncated: true, totalCount: 2 } });
  const request = { operation: 'value', metrics: ['task.status'], entities: [{ type: 'task', bound: 'a' }] };
  assert.equal(issue(verify([old, latest], request, ['R1:data.tasks.0.status'])), 'STALE_EVIDENCE');
  assert.equal(verify([old, latest], { ...request, entities: [{ type: 'task', bound: 'b' }] }, ['R1:data.tasks.1.status']).ok, true);
  assert.equal(verify([old, latest], request, ['R2:data.tasks.0.status']).ok, true);
  assert.equal(issue(verify([old, latest], { ...request, metrics: ['task.assignees'] }, ['R1:data.tasks.0.assignees.0.name'])), 'STALE_EVIDENCE');
  delete latest.envelope.data.tasks[0].assignees;
  assert.equal(verify([old, latest], { ...request, metrics: ['task.assignees'] }, ['R1:data.tasks.0.assignees.0.name']).ok, true, 'yokluk açık boşluk değildir');
  latest.envelope.data.tasks[0].status = 'todo';
  assert.equal(issue(verify([old, latest], request, ['R1:data.tasks.0.status'])), 'STALE_EVIDENCE', 'değişmeyen yetkili tekrar da eski kaydı yeniler');
});

test('same-round reads are simultaneous; only a later round supersedes, and reads are never compared', () => {
  const a = source('rota_task_analytics', { totals: { total: 2 } }, { round: 1 });
  const b = source('rota_task_analytics', { totals: { total: 3 } }, { id: 'R2', round: 1 });
  const request = { operation: 'value', metrics: ['tasks.total'] };
  assert.equal(verify([a, b], request, ['R1:data.totals.total']).ok, true);
  b.round = 2;
  assert.equal(issue(verify([a, b], request, ['R1:data.totals.total'])), 'STALE_EVIDENCE');
});

test('semantic aliases share the owner while project code and recurrence description remain separate', () => {
  const old = source('rota_task_detail', { task: { project: { name: 'Eski', code: 'K1' }, recurrence: { rule: 'R1', ruleDescription: 'D1' } } },
    { selectors: [{ type: 'task', id: 'a' }] });
  const search = source('rota_recurrence_inspect', { series: [{ templateTaskId: 'a', project: 'Yeni' }] }, { id: 'R2' });
  const request = { operation: 'value', metrics: ['task.project'], entities: [{ type: 'task', bound: 'a' }],
    fields: [{ metric: 'task.project', tool: old.tool, path: 'data.task.project.name' }] };
  assert.equal(issue(verify([old, search], request, ['R1:data.task.project.name'])), 'STALE_EVIDENCE');
  assert.equal(verify([old, search], { ...request, fields: [{ ...request.fields[0], path: 'data.task.project.code' }] }, ['R1:data.task.project.code']).ok, true);
  const series = source('rota_recurrence_inspect', { series: { templateTaskId: 'a', rule: 'R2' } }, { id: 'R3', selectors: [{ type: 'task', id: 'a' }] });
  const recurring = { operation: 'value', metrics: ['recurrence.rule'], entities: request.entities,
    fields: [{ metric: 'recurrence.rule', tool: old.tool, path: 'data.task.recurrence.rule' }] };
  assert.equal(issue(verify([old, series], recurring, ['R1:data.task.recurrence.rule'])), 'STALE_EVIDENCE');
  assert.equal(verify([old, series], { ...recurring, fields: [{ ...recurring.fields[0], path: 'data.task.recurrence.ruleDescription' }] }, ['R1:data.task.recurrence.ruleDescription']).ok, true);
  series.selectors = [{ type: 'task', id: 'occurrence' }];
  assert.equal(issue(verify([old, series], recurring, ['R1:data.task.recurrence.rule'])), 'STALE_EVIDENCE', 'yineleme seçicisi şablonun sahibi değildir');
  series.selectors = [{ type: 'task', id: 'a' }];
  series.envelope.data.series.templateTaskId = 'other-template';
  assert.equal(verify([old, series], recurring, ['R1:data.task.recurrence.rule']).ok, true, 'başka şablon aynı seçiciyle eski özelliği eskiltmez');
});

test('preflight does not predict data size or order; a rank the tool cannot sort verifies only from a complete collection', () => {
  const rank = { operation: 'rank', metrics: ['task.progressPercent'], rank: { metric: 'task.progressPercent', order: 'desc', limit: 1 },
    population: { tool: 'rota_task_search', collection: 'tasks' } };
  assert.deepEqual(complete(rank, []).problems, []);
  const rows = [{ taskId: 't1', progressPercent: 10 }, { taskId: 't2', progressPercent: 90 }];
  const whole = source('rota_task_search', { tasks: rows }, { envelope: { totalCount: 2, returnedCount: 2 } });
  assert.equal(issue(verify([whole], rank, ['R1:data.tasks.1.progressPercent'])), null);
  const page = source('rota_task_search', { tasks: rows }, { envelope: { totalCount: 9, returnedCount: 2, complete: false, nextCursor: 'devam' } });
  assert.equal(issue(verify([page], rank, ['R1:data.tasks.1.progressPercent'])), 'RANK_MISMATCH');
  assert.deepEqual(complete({ operation: 'list', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy: 'assignee' } }, []).problems, []);
  assert.deepEqual(complete({ operation: 'list', metrics: ['tasks.open'], population: { tool: 'rota_workload_summary', collection: 'people' } }, []).problems, []);
});

test('project and person are conjunctive selectors; repeated project owners remain a bound comparison', async (t) => {
  const request = { operation: 'value', metrics: ['tasks.total', 'tasks.plannedHours'], population: { tool: 'rota_task_analytics' },
    entities: [{ type: 'project', id: PROJECTS.FULL }, { type: 'person', id: String(AYSE) }] };
  assert.deepEqual(complete(request, [['rota_task_analytics', { projectId: PROJECTS.FULL, personSicil: AYSE }]]).problems, []);
  const read = await callRotaTool(stackFor(t), AYSE, 'rota_task_analytics', { projectId: PROJECTS.FULL, personSicil: AYSE });
  assert.equal(verifyRequested(read.ledger, ['R1:data.totals.total', 'R1:data.hours.plannedHours.total'], request).ok, true);
  const comparison = { ...request, entities: [{ type: 'project', id: PROJECTS.FULL }, { type: 'project', id: PROJECTS.READ }] };
  assert.ok(complete(comparison, []).problems.includes('$.bindings:required'));
});

test('own project properties accompany filtered lists and ranks without inheriting task filters', () => {
  for (const operation of ['list', 'rank']) {
    const request = { operation, metrics: ['task.status', 'project.access'], filters: { status: ['todo'] },
      entities: [{ type: 'project', id: PROJECTS.FULL }], population: { tool: 'rota_task_search', collection: 'tasks' },
      fields: [{ metric: 'project.access', tool: 'rota_project_detail', path: 'data.access.level' }],
      ...(operation === 'rank' ? { metrics: ['task.targetFinish', 'project.access'], rank: { metric: 'task.targetFinish', order: 'asc', limit: 1 } } : {}) };
    assert.deepEqual(complete(request, []).problems, []);
  }
});

test('list pages are never stitched; every declared sibling and every nested child collection is required', () => {
  const rows = [{ taskId: TASKS.OVERDUE, title: 'A', targetFinish: '2026-10-01' }, { taskId: TASKS.DUE_SOON, title: 'B', targetFinish: '2026-10-02' }];
  const first = source('rota_task_search', { tasks: rows.slice(0, 1) }, { args: { limit: 1 },
    envelope: { totalCount: 2, returnedCount: 1, complete: false, truncated: true, nextCursor: 'next' } });
  const last = source('rota_task_search', { tasks: rows.slice(1) }, { id: 'R2', args: { limit: 1, cursor: 'next' },
    envelope: { totalCount: 2, returnedCount: 1, nextCursor: null } });
  const raw = { operation: 'list', metrics: ['task.title', 'task.targetFinish'], population: { tool: first.tool, collection: 'tasks' } };
  agreement(raw, [first, last], false);
  assert.equal(verify([first, last], raw, ['R1:data.tasks.*.title', 'R1:data.tasks.*.targetFinish', 'R2:data.tasks.*.title', 'R2:data.tasks.*.targetFinish']).ok, false);
  const missing = source('rota_dependency_inspect', { predecessors: [{ taskId: TASKS.OVERDUE, title: 'A', type: 'FS' }] },
    { args: { taskId: TASKS.DUE_SOON }, envelope: { totalCount: 1, returnedCount: 1 } });
  const siblings = { operation: 'list', metrics: ['task.title', 'dependency.type'], entities: [{ type: 'task', id: TASKS.DUE_SOON }], population: { tool: missing.tool } };
  agreement(siblings, [missing], false);
  missing.envelope.data.successors = [];
  agreement(siblings, [missing], true);
  const nested = { tool: 'rota_recurrence_inspect', firstPage: true,
    envelope: { complete: true, totalCount: 2, data: { series: [{ next: [], nextTruncated: false }, { nextTruncated: false }] } } };
  assert.equal(populationModule.collectionComplete(nested, 'series.*.next'), false);
  nested.envelope.data.series[1].next = [];
  assert.equal(populationModule.collectionComplete(nested, 'series.*.next'), true);
});

test('all-empty meaningful alternatives require field bindings before SQL and remain distinct in all four layers', () => {
  const item = source('rota_person_search', { people: [{ sicil: AYSE, name: 'Ayşe Yılmaz', organization: { directorate: null, department: null, unit: null } }] },
    { args: { text: 'Ayşe Yılmaz' }, envelope: { totalCount: 1, returnedCount: 1 } });
  const raw = { operation: 'list', metrics: ['person.name', 'person.organization'], filters: { text: 'Ayşe Yılmaz' }, population: { tool: item.tool, collection: 'people' } };
  assert.ok(complete(raw, [[item.tool, item.args]]).problems.includes('$.fields:required'));
  agreement(raw, [item], false);
  const bound = { ...raw, fields: [{ metric: 'person.organization', tool: item.tool, path: 'data.people.*.organization.department' }] };
  assert.deepEqual(complete(bound, [[item.tool, item.args]]).problems, []);
  const [answer] = agreement(bound, [item], true);
  assert.match(answer.normalized, /Müdürlük.*Belirtilmemiş/);
  assert.doesNotMatch(answer.normalized, /Direktörlük|Birim/);
  // Üreticinin yazmadığı düzey okunmamıştır: "Belirtilmemiş" olarak kanıtlanamaz.
  item.envelope.data.people[0].organization = {};
  agreement(bound, [item], false);
});

test('generated name probes obey the directory schema and skip one-letter first tokens', () => {
  const request = parsedRequest({ operation: 'value', metrics: ['project.name'], entities: [{ type: 'project', text: 'A Projesi' }], population: { tool: 'rota_project_detail' } });
  const item = source('rota_project_search', { matches: [], resolution: 'none' }, { args: { text: 'A Projesi' } });
  assert.deepEqual(requestDeclarationModule.nameProbes(request, entriesOf([item])), []);
  assert.equal(requestDeclarationModule.unmatchedEntities(request, entriesOf([item])).length, 1);
  const safe = parsedRequest({ ...request, entities: [{ type: 'project', text: 'Radar Projesi' }] });
  item.args.text = 'Radar Projesi';
  assert.deepEqual(requestDeclarationModule.nameProbes(safe, entriesOf([item])), [{ name: 'rota_project_search', args: { text: 'Radar' } }]);
});

test('canonical execution identity uses the frozen turn date across Türkiye midnight and deduplicates effective default pages', async (t) => {
  const { readKey } = await import('../src/server/ai/tools/requestPopulation.js');
  const { prepareExecutionSet } = await import('../src/server/ai/tools/executionSet.js');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-29T20:59:59Z') });
  const args = { deadline: 'due_today' };
  const calls = [{ name: 'rota_task_search', arguments: JSON.stringify(args) }];
  const options = { catalog: [getRotaTool('rota_task_search')], today: '2026-09-29', callId: () => 'call' };
  const first = prepareExecutionSet(calls, options);
  const before = readKey('rota_task_search', first.calls[0].args, options.today);
  t.mock.timers.tick(2000);
  assert.equal(new Date().toISOString().slice(11, 19), '21:00:01');
  const second = prepareExecutionSet(calls, options);
  assert.equal(readKey('rota_task_search', second.calls[0].args, options.today), before);
  assert.equal(readKey('rota_task_search', { ...args, limit: 20 }, options.today), before);
  const request = parsedRequest({ operation: 'rank', metrics: ['task.targetFinish'], population: { tool: 'rota_task_search', collection: 'tasks' },
    rank: { metric: 'task.targetFinish', order: 'asc', limit: 1 } });
  const trimmed = source('rota_task_search', { tasks: [], sizeNote: 'kısaltıldı' }, { envelope: { returnedCount: 0, totalCount: 50, complete: false, truncated: true } });
  // Boyutla kısaltılmış sayfa sıralama kanıtı değildir; daha küçük sayfa türetilmez, istek kapalı kalır.
  assert.deepEqual(requestSelections(request, entriesOf([trimmed]), null, options.today), []);
  assert.notEqual(readKey('rota_task_search', args, '2026-09-30'), before);
});

test('empty synthesis honors metric/entity bindings; a rank across sibling collections is never merged', async () => {
  const item = source('rota_task_search', { tasks: [{ taskId: TASKS.OVERDUE, title: 'A', targetFinish: '2026-10-01', assignees: [] },
    { taskId: TASKS.DUE_SOON, title: 'B', targetFinish: '2026-10-02', assignees: [] }] }, { envelope: { totalCount: 2, returnedCount: 2 } });
  const request = { operation: 'list', metrics: ['task.targetFinish', 'task.assignees'], entities: [{ type: 'task', bound: TASKS.OVERDUE }, { type: 'task', bound: TASKS.DUE_SOON }],
    bindings: [{ metric: 'task.targetFinish', entity: 0 }, { metric: 'task.assignees', entity: 1 }] };
  const answer = verify([item], request, ['R1:data.tasks.*.title', 'R1:data.tasks.0.targetFinish']);
  assert.equal(answer.ok, true, JSON.stringify(answer.issues));
  assert.doesNotMatch(answer.normalized.split('\n').find((line) => line.includes('**A**')), /Sorumlu/);
  assert.match(answer.normalized.split('\n').find((line) => line.includes('**B**')), /Sorumlular.*Belirtilmemiş/);
  const detail = source('rota_task_detail', { task: { taskId: TASKS.DUE_SOON, assignees: [{ name: 'Ayşe' }] } },
    { id: 'R2', args: { taskId: TASKS.DUE_SOON }, selectors: [{ type: 'task', id: TASKS.DUE_SOON }] });
  const explicitlyBound = { ...request, fields: [{ metric: 'task.assignees', tool: detail.tool, path: 'data.task.assignees.*.name' }] };
  const withDetail = verify([item, detail], explicitlyBound, ['R1:data.tasks.*.title', 'R1:data.tasks.0.targetFinish', 'R2:data.task.assignees.*.name']);
  assert.equal(withDetail.ok, true, JSON.stringify(withDetail.issues));
  assert.match(withDetail.normalized, /Ayşe/);
  assert.doesNotMatch(withDetail.normalized, /Belirtilmemiş/);
  const links = source('rota_dependency_inspect', { predecessors: [{ taskId: TASKS.OVERDUE, title: 'Önce', targetFinish: '2026-10-01' }],
    successors: [{ taskId: TASKS.DUE_SOON, title: 'Sonra', targetFinish: '2026-10-02' }] }, { envelope: { totalCount: 2, returnedCount: 2 } });
  const rank = { operation: 'rank', metrics: ['task.targetFinish'], rank: { metric: 'task.targetFinish', order: 'asc', limit: 1 }, population: { tool: links.tool } };
  assert.equal(issue(verify([links], rank, ['R1:data.predecessors.0.targetFinish', 'R1:data.successors.0.targetFinish'])), 'RANK_MISMATCH');
});

test('semantic scalar freshness covers every registered root count carrier, while grouping stays distinct', () => {
  const workload = source('rota_workload_summary', { openTaskCount: 5 });
  const analytics = source('rota_task_analytics', { totals: { open: 6 } }, { id: 'R2' });
  const fact = workload.facts.find((item) => item.field === 'data.openTaskCount');
  const { factSuperseded } = claimableRequest;
  assert.equal(factSuperseded(new Map([['R1', workload], ['R2', analytics]]), workload, fact), true);
  analytics.facets = { status: ['in_progress', 'todo'] };
  assert.equal(factSuperseded(new Map([['R1', workload], ['R2', analytics]]), workload, fact), true);
  analytics.facets = { priority: ['high'] };
  assert.equal(factSuperseded(new Map([['R1', workload], ['R2', analytics]]), workload, fact), false);
});

const claimableRequest = await import('../src/domain/ai/requestContract.js');

test('old empty lists expire across semantic count tools, with another population as counterexample', () => {
  const old = source('rota_task_search', { tasks: [] }, { collection: 'tasks' });
  const newer = source('rota_task_analytics', { totals: { total: 5 } }, { id: 'R2', envelope: { totalCount: 5 } });
  const request = { operation: 'list', metrics: ['task.title'], population: { tool: old.tool, collection: 'tasks' } };
  assert.equal(issue(verify([old, newer], request, ['R1:complete'])), 'STALE_EVIDENCE');
  newer.facets = { priority: ['high'] };
  assert.equal(verify([old, newer], request, ['R1:complete']).ok, true);
});

test('any later read of the same row population stales the older rows; another row order is another population', () => {
  const older = source('rota_task_search', { tasks: [{ taskId: 'a', title: 'A' }, { taskId: 'b', title: 'B' }] }, { envelope: { totalCount: 2 } });
  const later = source('rota_task_search', { tasks: [{ taskId: 'c', title: 'C' }] }, { id: 'R2', envelope: { totalCount: 3, complete: false } });
  const evidence = new Map([['R1', older], ['R2', later]]);
  const fact = older.facts.find((item) => item.field === 'data.tasks.0.title');
  assert.equal(claimableRequest.factSuperseded(evidence, older, fact, { rows: true }), true);
  later.snapshotDimensions = { sort: 'updated_desc' };
  assert.equal(claimableRequest.factSuperseded(evidence, older, fact, { rows: true }), false);
});

test('collection membership ignores unrelated detail clipping, but clipped detail carriers remain unavailable', () => {
  const activity = source('rota_activity_search', { items: [{ actor: 'A', kind: 'updated', detailsLimited: true, structuredChanges: [] }] },
    { envelope: { complete: false, truncated: true, totalCount: 1, returnedCount: 1 } });
  assert.equal(populationModule.collectionComplete(activity, 'items'), true);
  assert.equal(populationModule.carrierAvailable(activity, 'data.items.0.structuredChanges.0.before'), false);
  const quality = source('rota_data_quality', { checks: [{ id: 'dates', count: 50, examples: [] }], completedWithoutActualFinish: { count: 3, examples: [] } },
    { envelope: { complete: false, truncated: true } });
  assert.equal(populationModule.collectionComplete(quality, 'checks'), true);
  assert.equal(populationModule.carrierAvailable(quality, 'data.checks.0.examples.0.title'), false);
  quality.envelope.data.checks[0].count = 0;
  assert.equal(populationModule.carrierAvailable(quality, 'data.checks.0.examples.0.title'), true);
  assert.equal(populationModule.collectionComplete(quality, 'completedWithoutActualFinish.examples'), false);
});

test('value name/code ambiguity is rejected before reading; an explicit carrier is accepted', () => {
  const raw = { operation: 'value', metrics: ['task.project'], population: { tool: 'rota_task_detail' }, entities: [{ type: 'task', id: TASKS.OVERDUE }] };
  assert.ok(complete(raw, []).problems.includes('$.fields:required'));
  assert.ok(complete(raw, []).hints.some((hint) => hint.includes('data.task.project.name') && hint.includes('data.task.project.code')));
  assert.deepEqual(complete({ ...raw, fields: [{ metric: 'task.project', tool: 'rota_task_detail', path: 'data.task.project.code' }] }, []).problems, []);
});

test('comparison reads keep each metric subject separate from conjunctive selectors', () => {
  const { derivedReads, requestBoundCall } = populationServer;
  const raw = { operation: 'value', metrics: ['tasks.open', 'tasks.total'], population: { tool: 'rota_task_analytics' },
    entities: [{ type: 'project', id: PROJECTS.FULL }, { type: 'person', id: String(AYSE) }],
    bindings: [{ metric: 'tasks.open', entity: 0 }, { metric: 'tasks.total', entity: 1 }] };
  const request = complete(raw, []).request;
  const bound = request.entities.map((entity) => ({ ...entity, bound: entity.id }));
  const reads = derivedReads(request, bound, { today: REQUEST_TODAY });
  assert.deepEqual(reads.map((read) => read.args), [{ projectId: PROJECTS.FULL }, { personSicil: AYSE }]);
  assert.equal(requestBoundCall(request, 'rota_task_analytics', { projectId: PROJECTS.FULL, personSicil: AYSE }, { today: REQUEST_TODAY, bound }), null);
  const joint = complete({ ...raw, bindings: [] }, []).request;
  assert.deepEqual(derivedReads(joint, bound, { today: REQUEST_TODAY }).map((read) => read.args), [{ projectId: PROJECTS.FULL, personSicil: AYSE }]);
  const repeated = complete({ ...raw,
    entities: [...raw.entities, { type: 'project', id: PROJECTS.READ }, { type: 'person', id: '910003' }],
    bindings: [...raw.bindings, { metric: 'tasks.open', entity: 2 }, { metric: 'tasks.total', entity: 3 }] }, []).request;
  assert.deepEqual(derivedReads(repeated, repeated.entities.map((entity) => ({ ...entity, bound: entity.id })), { today: REQUEST_TODAY }).map((read) => read.args),
    [{ projectId: PROJECTS.FULL }, { personSicil: AYSE }, { projectId: PROJECTS.READ }, { personSicil: 910003 }]);
});

const populationServer = await import('../src/server/ai/tools/requestPopulation.js');

test('a capped preview certifies a list only when it is objectively complete; preflight does not predict it', () => {
  const preview = { operation: 'list', metrics: ['notification.at'], population: { tool: 'rota_notifications', collection: 'taskEvents.latest' } };
  assert.deepEqual(populationServer.requestCapabilityProblems({ ...preview, filters: {}, fields: [], entities: [], bindings: [] }).problems, []);
  const latest = source('rota_notifications', { taskEvents: { latest: [{ at: '2026-09-29T08:00:00Z' }] } }, { envelope: { complete: false } });
  assert.equal(issue(verify([latest], preview, ['R1:data.taskEvents.latest.*.at'])), 'LIST_INCOMPLETE');
  const matches = source('rota_project_search', { matches: [{ projectId: PROJECTS.FULL, name: 'A' }] }, { envelope: { totalCount: 4, returnedCount: 1, complete: false } });
  assert.equal(issue(verify([matches], { operation: 'list', metrics: ['project.name'], population: { tool: matches.tool, collection: 'matches' } }, ['R1:data.matches.*.name'])), 'LIST_INCOMPLETE');
});

const toolCatalog = (await import('../src/server/ai/tools/toolRegistry.js')).toolCatalogForModel();

test('a request-bound read runs with at most the server-derived page; a smaller page is kept and nothing is refused for size', async () => {
  const { prepareExecutionSet } = await import('../src/server/ai/tools/executionSet.js');
  const { requestBoundCall } = populationServer;
  const options = { today: REQUEST_TODAY };
  // Değer: sunucu aracın varsayılan sayfasını türetir; daha büyük sayfa ona indirilir, küçüğü korunur.
  const value = complete({ operation: 'value', metrics: ['tasks.overdue'], population: { tool: 'rota_task_search' }, filters: { deadline: 'overdue' } }, []).request;
  assert.deepEqual(requestBoundCall(value, 'rota_task_search', { deadline: 'overdue', limit: 50 }, options), { deadline: 'overdue', limit: 20 });
  assert.deepEqual(requestBoundCall(value, 'rota_task_search', { deadline: 'overdue', limit: 3 }, options), { deadline: 'overdue', limit: 3 });
  assert.equal(requestBoundCall(value, 'rota_task_search', { deadline: 'due_today', limit: 3 }, options), null);
  // Liste nüfusun bütün satırlarıdır: aracın en büyük sayfasına kadar kabul edilir.
  const list = complete({ operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks' } }, []).request;
  assert.deepEqual(requestBoundCall(list, 'rota_task_search', { limit: 50 }, options), { limit: 50 });
  // Ad araması: model daha büyük sayfa isterse reddedilmez, sunucunun sayfasıyla yürür.
  const named = complete({ operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics' }, entities: [{ type: 'project', text: 'Radar Modernizasyonu' }] }, []).request;
  const bound = named.entities.map((entity) => ({ ...entity, bound: null }));
  const validateCall = (name, args) => requestBoundCall(named, name, args, { ...options, bound });
  const set = prepareExecutionSet([{ name: 'rota_project_search', arguments: JSON.stringify({ text: 'Radar Modernizasyonu', limit: 10 }) }],
    { catalog: toolCatalog, validateCall, callId: () => 'call', today: REQUEST_TODAY });
  assert.equal(set.ok, true, JSON.stringify(set.problems));
  assert.deepEqual([set.calls[0].args, JSON.parse(set.calls[0].arguments)], [{ text: 'Radar Modernizasyonu', limit: 5 }, { text: 'Radar Modernizasyonu', limit: 5 }]);
});

test('required continuations reject a detached first page and comparison properties read only their bound subject', () => {
  const request = complete({ operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks' } }, []).request;
  const options = { today: REQUEST_TODAY, reads: [{ name: 'rota_task_search', args: { cursor: 'next', limit: 20 } }] };
  assert.deepEqual(populationServer.requestBoundCall(request, 'rota_task_search', { cursor: 'next', limit: 5 }, options), { cursor: 'next', limit: 5 });
  assert.equal(populationServer.requestBoundCall(request, 'rota_task_search', {}, options), null);
  const comparison = complete({ operation: 'value', metrics: ['tasks.total', 'task.status'], population: { tool: 'rota_task_analytics' },
    entities: [{ type: 'project', id: PROJECTS.FULL }, { type: 'task', id: TASKS.OVERDUE }, { type: 'task', id: TASKS.DUE_SOON }],
    bindings: [{ metric: 'tasks.total', entity: 0 }, { metric: 'task.status', entity: 1 }] }, []).request;
  const bound = comparison.entities.map((entity) => ({ ...entity, bound: entity.id }));
  assert.deepEqual(populationServer.derivedReads(comparison, bound, { today: REQUEST_TODAY }).map(({ name, args }) => [name, args]),
    [['rota_task_analytics', { projectId: PROJECTS.FULL }], ['rota_task_detail', { taskId: TASKS.OVERDUE }]]);
});

test('an ID and resolved text can bind the same record, while two distinct names cannot silently collapse', () => {
  const item = source('rota_project_search', { resolution: 'unique', resolvedProject: { projectId: PROJECTS.FULL, name: 'Radar' }, matches: [] }, { args: { text: 'Radar' } });
  const request = parsedRequest({ operation: 'value', metrics: ['project.name'], entities: [{ type: 'project', id: PROJECTS.FULL }, { type: 'project', text: 'Radar' }] });
  assert.deepEqual(requestDeclarationModule.bindRequestEntities(request, entriesOf([item])).map((entity) => entity.bound), [PROJECTS.FULL, PROJECTS.FULL]);
  const second = { ...item, id: 'R2', args: { text: 'Başka' } };
  const distinct = parsedRequest({ operation: 'value', metrics: ['project.name'], entities: [{ type: 'project', text: 'Radar' }, { type: 'project', text: 'Başka' }] });
  assert.deepEqual(requestDeclarationModule.bindRequestEntities(distinct, entriesOf([item, second])).map((entity) => entity.bound), [null, null]);
});

/* ── Aşama 3 yakınsaması: alan durumu, tazelik ve nüfus kapsamı ── */

test('field state is value, explicitly empty or unread; an unread field is never certified or rendered as empty', async (t) => {
  const { rowFieldState } = claimableRequest;
  // Görev araması boş terminini yazmaz (okunmuş, boş); bağımlılık satırı termini hiç okumaz.
  assert.equal(rowFieldState('rota_task_search', 'tasks', { title: 'A' }, 'targetFinish'), 'empty');
  assert.equal(rowFieldState('rota_task_search', 'tasks', { title: 'A', targetFinish: '2026-10-01' }, 'targetFinish'), 'value');
  assert.equal(rowFieldState('rota_task_search', 'tasks', { title: 'A' }, 'project.lead'), 'absent');
  assert.equal(rowFieldState('rota_dependency_inspect', 'predecessors', { title: 'A' }, 'targetFinish'), 'absent');
  assert.equal(rowFieldState('rota_dependency_inspect', 'predecessors', { title: 'A', plannedStart: null }, 'plannedStart'), 'empty');
  assert.equal(rowFieldState('rota_dependency_inspect', 'predecessors', { title: 'A' }, 'plannedStart'), 'absent');
  // Kişi araması unvanı okur ve boşken yazmaz: unvansız kişinin unvanı boştur, okunmamış değildir.
  assert.equal(rowFieldState('rota_person_search', 'people', { sicil: 1, name: 'A' }, 'jobTitle'), 'empty');
  const stack = stackFor(t);
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_dependency_inspect', { taskId: TASKS.DONE });
  const entries = ledger.requestEntries();
  const raw = (metric) => ({ operation: 'list', metrics: ['task.title', metric], population: { tool: 'rota_dependency_inspect', collection: 'predecessors' },
    entities: [{ type: 'task', id: TASKS.DONE }] });
  // Okunan öncülün boş planlanan başlangıcı açık boşluktur: hazırlık, seçim ve doğrulama birlikte kabul eder.
  const planned = parsedRequest(raw('task.plannedStart'));
  assert.equal(requestEvidenceReady(planned, entries, REQUEST_TODAY), true);
  const [candidate] = requestSelections(planned, entries, null, REQUEST_TODAY);
  const rendered = verifyRequested(ledger, JSON.parse(candidate).facts, raw('task.plannedStart'));
  assert.equal(issue(rendered), null);
  assert.match(rendered.normalized, /Dokümantasyon.*Belirtilmemiş/s);
  // Öncülün termini bu araçta okunmaz: hazırlık ve doğrulama birlikte reddeder; "Belirtilmemiş" yazılmaz.
  const target = parsedRequest(raw('task.targetFinish'));
  assert.equal(requestEvidenceReady(target, entries, REQUEST_TODAY), false);
  assert.deepEqual(requestSelections(target, entries, null, REQUEST_TODAY), []);
  assert.equal(issue(verifyRequested(ledger, ['R1:data.predecessors.*.title'], raw('task.targetFinish'))), 'METRIC_MISSING');
});

test('an explicitly empty record property of a bound entity is a value; an unwritten one is not', async (t) => {
  const stack = stackFor(t);
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_detail', { taskId: TASKS.UNASSIGNED });
  const entries = ledger.requestEntries();
  const raw = { operation: 'value', metrics: ['task.assignees'], population: { tool: 'rota_task_detail' }, entities: [{ type: 'task', id: TASKS.UNASSIGNED }] };
  const request = parsedRequest(raw);
  assert.equal(requestEvidenceReady(request, entries, REQUEST_TODAY), true);
  const [candidate] = requestSelections(request, entries, null, REQUEST_TODAY);
  assert.deepEqual(JSON.parse(candidate).facts, ['R1:data.task.title']);
  const rendered = verifyRequested(ledger, JSON.parse(candidate).facts, raw);
  assert.equal(issue(rendered), null);
  assert.match(rendered.normalized, /Sorumlu.*Belirtilmemiş/);
  // Başka bir görevin boş özelliği bu görevin değeri değildir; yazılmamış özellik okunmamıştır.
  const other = { ...raw, entities: [{ type: 'task', id: TASKS.OVERDUE }] };
  assert.equal(issue(verifyRequested(ledger, ['R1:data.task.title'], other)), 'ENTITY_MISMATCH');
  const unread = source('rota_task_detail', { task: { taskId: TASKS.UNASSIGNED, title: 'Dokümantasyon' } }, { selectors: [{ type: 'task', id: TASKS.UNASSIGNED }] });
  assert.equal(issue(verify([unread], { ...raw, entities: [{ type: 'task', bound: TASKS.UNASSIGNED }] }, ['R1:data.task.title'])), 'METRIC_MISSING');
});

test('explicit-empty state obeys the single freshness rule in verification and rendering', () => {
  const task = TASKS.OVERDUE;
  const request = { operation: 'value', metrics: ['task.targetFinish'], entities: [{ type: 'task', bound: task }] };
  const searched = (id) => source('rota_task_search', { tasks: [{ taskId: task, title: 'Radar test planı' }] }, { id, envelope: { totalCount: 1, returnedCount: 1 } });
  const detailed = (id, targetFinish) => source('rota_task_detail', { task: { taskId: task, dates: { targetFinish } } }, { id, selectors: [{ type: 'task', id: task }] });
  // Eski açık boşluk, aynı görevin daha yeni değeriyle eskir: ne doğrulanır ne çizilir.
  assert.equal(issue(verify([searched('R1')], request, ['R1:data.tasks.0.title'])), null);
  const newer = detailed('R2', '2026-10-01');
  assert.equal(issue(verify([searched('R1'), newer], request, ['R1:data.tasks.0.title'])), 'METRIC_MISSING');
  const both = verify([searched('R1'), newer], request, ['R1:data.tasks.0.title', 'R2:data.task.dates.targetFinish']);
  assert.equal(issue(both), null);
  assert.doesNotMatch(both.normalized, /Belirtilmemiş/);
  // Eski değer, aynı görevin daha yeni açık boşluğuyla eskir; okumayan araç (bağımlılık satırı) eskitmez.
  assert.equal(issue(verify([detailed('R1', '2026-10-01'), searched('R2')], request, ['R1:data.task.dates.targetFinish'])), 'STALE_EVIDENCE');
  const dependency = source('rota_dependency_inspect', { task: { taskId: TASKS.DUE_SOON, title: 'Anten' }, predecessors: [{ taskId: task, title: 'Radar test planı' }], successors: [] }, { id: 'R2' });
  assert.equal(issue(verify([detailed('R1', '2026-10-01'), dependency], request, ['R1:data.task.dates.targetFinish'])), null);
});

test('a later read whose carrier is unavailable does not supersede an older available value', () => {
  const task = TASKS.SERIES;
  const read = (id, complete, actualFinish) => source('rota_recurrence_inspect', { series: { templateTaskId: task, title: 'Haftalık durum toplantısı',
    completionDatesComplete: complete, lastCompleted: { taskId: TASKS.OCCURRENCE_DONE, occurrenceDate: actualFinish, actualFinish } } },
  { id, selectors: [{ type: 'task', id: task }] });
  const request = { operation: 'value', metrics: ['recurrence.lastCompletedFinish'], entities: [{ type: 'task', bound: task }] };
  // R2'nin geçmiş bitiş tarihleri eksiktir: değeri geçici olduğundan R1'in doğru değerini eskitemez.
  assert.equal(issue(verify([read('R1', true, '2026-09-21'), read('R2', false, '2026-09-14')], request, ['R1:data.series.lastCompleted.actualFinish'])), null);
  // Tam olan daha yeni okuma eskitir.
  assert.equal(issue(verify([read('R1', true, '2026-09-21'), read('R2', true, '2026-09-28')], request, ['R1:data.series.lastCompleted.actualFinish'])), 'STALE_EVIDENCE');
});

test('a selected naming context obeys the same freshness rule as the requested metric', () => {
  const task = TASKS.OVERDUE;
  const searched = source('rota_task_search', { tasks: [{ taskId: task, title: 'Eski ad' }] }, { envelope: { totalCount: 1, returnedCount: 1 } });
  const detail = source('rota_task_detail', { task: { taskId: task, title: 'Yeni ad', hours: { planned: 5 } } }, { id: 'R2', selectors: [{ type: 'task', id: task }] });
  const request = { operation: 'value', metrics: ['task.plannedHours'], entities: [{ type: 'task', bound: task }], reasoning: 'synthesis' };
  assert.equal(issue(verify([searched, detail], request, ['R1:data.tasks.0.title', 'R2:data.task.hours.planned'])), 'STALE_EVIDENCE');
  assert.equal(issue(verify([searched, detail], request, ['R2:data.task.title', 'R2:data.task.hours.planned'])), null);
});

test('a list or rank cannot silently drop a declared entity its population tool cannot select', () => {
  const raw = { operation: 'list', metrics: ['task.title', 'task.status'], population: { tool: 'rota_task_search', collection: 'tasks' },
    entities: [{ type: 'project', id: PROJECTS.FULL }, { type: 'task', id: TASKS.OVERDUE }] };
  assert.ok(complete(raw, []).problems.includes('$.entities[1]:population'), 'görev bağı düşerse projenin bütün görevleri listelenirdi');
  assert.ok(!complete(raw, []).problems.includes('$.entities[0]:population'));
  // Varlığın kendi özelliğini seçen başka bir okuma (görev ayrıntısı) varlığı taşır.
  assert.deepEqual(complete({ ...raw, metrics: ['task.title', 'task.description'], entities: [{ type: 'task', id: TASKS.OVERDUE }] }, [], { allowedTextFields: ['description'] })
    .problems.filter((problem) => problem.startsWith('$.entities')), []);
  assert.ok(complete({ operation: 'list', metrics: ['project.name'], population: { tool: 'rota_portfolio_summary', collection: 'projects' },
    entities: [{ type: 'project', id: PROJECTS.FULL }] }, []).problems.includes('$.entities[0]:population'));
});

test('search identity is the tool search predicate, not a looser folding', () => {
  const { canonicalFacets } = populationServer;
  assert.notDeepEqual(canonicalFacets('task', { text: 'A-B' }, REQUEST_TODAY), canonicalFacets('task', { text: 'A B' }, REQUEST_TODAY));
  assert.notDeepEqual(canonicalFacets('task', { text: 'Kısım' }, REQUEST_TODAY), canonicalFacets('task', { text: 'Kisim' }, REQUEST_TODAY));
  assert.deepEqual(canonicalFacets('task', { text: 'RAPOR-2' }, REQUEST_TODAY), canonicalFacets('task', { text: 'rapor-2' }, REQUEST_TODAY));
  const raw = { operation: 'list', metrics: ['task.title'], filters: { text: 'A-B' }, population: { tool: 'rota_task_search', collection: 'tasks' } };
  assert.ok(complete(raw, [['rota_task_search', { text: 'A B' }]]).problems.includes('$.filters.text:conflict'));
  const request = complete(raw, []).request;
  assert.equal(populationServer.requestBoundCall(request, 'rota_task_search', { text: 'A B', limit: 50 }, { today: REQUEST_TODAY }), null);
  assert.ok(populationServer.requestBoundCall(request, 'rota_task_search', { text: 'a-b', limit: 50 }, { today: REQUEST_TODAY }));
});

test('an absence proof and a binding use the same search predicate as the read that acquired them', () => {
  const miss = (args, id) => source('rota_project_search', { matches: [], resolution: 'none' }, { id, args });
  const request = parsedRequest({ operation: 'value', metrics: ['project.name'], population: { tool: 'rota_project_detail' }, entities: [{ type: 'project', text: 'Radar-B' }] });
  // "Radar B" ve "Kisim" aramalarının boşluğu "Radar-B" ve "Kısım" adlarının yokluğu değildir: araç onları ayrı arar.
  const other = [miss({ text: 'Radar B' }, 'R1'), miss({ text: 'Radar' }, 'R2')];
  assert.deepEqual(requestDeclarationModule.nameProbes(request, entriesOf(other)), []);
  assert.equal(requestDeclarationModule.unmatchedEntities(request, entriesOf(other)).length, 0, 'görünür kayıt yanlış "bulunamadı" ile bitmez');
  assert.deepEqual(populationServer.derivedReads(request, requestDeclarationModule.bindRequestEntities(request, entriesOf(other)), { today: REQUEST_TODAY })
    .map(({ name, args }) => [name, args]), [['rota_project_search', { text: 'Radar-B' }]], 'sunucu adı kullanıcının yazdığı biçimle arar');
  const dotless = parsedRequest({ operation: 'value', metrics: ['task.status'], population: { tool: 'rota_task_detail' }, entities: [{ type: 'task', text: 'Kısım raporu' }] });
  const taskMiss = (text, id) => source('rota_task_search', { tasks: [], titleResolution: 'none' }, { id, args: { text } });
  assert.equal(requestDeclarationModule.unmatchedEntities(dotless, entriesOf([taskMiss('Kisim raporu', 'R1'), taskMiss('Kisim', 'R2')])).length, 0);
  // Aynı aramanın boşluğu (büyük/küçük harf aracın yüklemiyle aynıdır) yokluk kanıtıdır.
  assert.equal(requestDeclarationModule.unmatchedEntities(request, entriesOf([miss({ text: 'radar-b' }, 'R1')])).length, 1);
  assert.equal(requestDeclarationModule.unmatchedEntities(dotless, entriesOf([taskMiss('kısım raporu', 'R1'), taskMiss('KISIM', 'R2')])).length, 1);
  // Bağlama da aynı yüklemi kullanır: "Radar-A" aramasının tek sonucu ayrı yazılmış "Radar A" kaydı değildir.
  const hit = source('rota_task_search', { tasks: [], titleResolution: 'unique', resolvedTask: { taskId: TASKS.OVERDUE } }, { args: { text: 'Radar-A' } });
  const pair = parsedRequest({ operation: 'value', metrics: ['task.title', 'task.status'], population: { tool: 'rota_task_detail' },
    entities: [{ type: 'task', text: 'Radar-A' }, { type: 'task', text: 'Radar A' }] });
  assert.deepEqual(requestDeclarationModule.bindRequestEntities(pair, entriesOf([hit])).map((entity) => entity.bound), [TASKS.OVERDUE, null]);
});

test('a name resolution binds only an entity of the same project scope; a task identity never crosses projects', () => {
  const hit = (args, id = 'R1') => source('rota_task_search', { tasks: [], titleResolution: 'unique', resolvedTask: { taskId: TASKS.OVERDUE } }, { id, args });
  const bind = (raw, entries, selection = null) => requestDeclarationModule.bindRequestEntities(parsedRequest(raw), entriesOf(entries), selection).map((entity) => entity.bound);
  const task = { type: 'task', text: 'Radar test' };
  const value = (entities) => ({ operation: 'value', metrics: ['task.status'], population: { tool: 'rota_task_detail' }, entities });
  const inRead = value([{ type: 'project', id: PROJECTS.READ }, task]);
  // Aynı ad başka projede (ya da koşulsuz) tek çözülmüştür: bildirilen projenin görevi değildir.
  assert.deepEqual(bind(inRead, [hit({ text: 'Radar test', projectId: PROJECTS.FULL })]), [PROJECTS.READ, null]);
  assert.deepEqual(bind(inRead, [hit({ text: 'Radar test' })]), [PROJECTS.READ, null]);
  // Sunucu adı yalnızca bildirilen projede arar; başka projenin görevini okumaz.
  const bound = requestDeclarationModule.bindRequestEntities(parsedRequest(inRead), entriesOf([hit({ text: 'Radar test', projectId: PROJECTS.FULL })]));
  assert.deepEqual(populationServer.derivedReads(parsedRequest(inRead), bound, { today: REQUEST_TODAY }).map(({ name, args }) => [name, args]),
    [['rota_task_search', { text: 'Radar test', projectId: PROJECTS.READ }]]);
  // Projede tek olan ad koşulsuz tek değildir; aynı projenin araması bağlar.
  assert.deepEqual(bind(value([task]), [hit({ text: 'Radar test', projectId: PROJECTS.FULL })]), [null]);
  assert.deepEqual(bind(value([{ type: 'project', id: PROJECTS.FULL }, task]), [hit({ text: 'Radar test', projectId: PROJECTS.FULL })]), [PROJECTS.FULL, TASKS.OVERDUE]);
  // Adla bildirilen proje bağlanmadan projedeki ad bağlanmaz.
  assert.deepEqual(bind(value([{ type: 'project', text: 'Radar' }, task]), [hit({ text: 'Radar test' })]), [null, null]);
  // Kapsamın bağladığı kısmi aday da aramasının projesini taşır.
  const named = { named: [{ type: 'task', text: 'radar test', query: 'radar test', title: 'radar test planı', id: TASKS.OVERDUE, projectId: PROJECTS.FULL }] };
  assert.deepEqual(bind(inRead, [], named), [PROJECTS.READ, null]);
  assert.deepEqual(bind(value([{ type: 'project', id: PROJECTS.FULL }, task]), [], named), [PROJECTS.FULL, TASKS.OVERDUE]);
});

test('another record\'s name and a per-entity count are measured for every bound entity, not satisfied by naming it', async (t) => {
  const { ledger } = await callRotaTools(stackFor(t), AYSE, [['rota_task_detail', { taskId: TASKS.OVERDUE }], ['rota_task_detail', { taskId: TASKS.DUE_SOON }],
    ['rota_recurrence_inspect', { projectId: PROJECTS.FULL }], ['rota_recurrence_inspect', { projectId: PROJECTS.READ }], ['rota_project_detail', { projectId: PROJECTS.READ }]]);
  // Görevin projesi görevin adı değildir: ikinci görevin projesi düşerse yanıt eksiktir.
  const projects = { operation: 'value', metrics: ['task.project', 'task.status'], population: { tool: 'rota_task_detail' },
    fields: [{ metric: 'task.project', tool: 'rota_task_detail', path: 'data.task.project.name' }],
    entities: [{ type: 'task', id: TASKS.OVERDUE }, { type: 'task', id: TASKS.DUE_SOON }] };
  assert.equal(issue(verifyRequested(ledger, ['R1:data.task.project.name', 'R1:data.task.status', 'R2:data.task.status'], projects)), 'ENTITY_MISSING');
  assert.equal(issue(verifyRequested(ledger, ['R1:data.task.project.name', 'R1:data.task.status', 'R2:data.task.project.name', 'R2:data.task.status'], projects)), null);
  // Kendi adı kaydın anılmasıyla verilir: ikinci görevin başlığı ayrıca seçilmez.
  assert.equal(issue(verifyRequested(ledger, ['R1:data.task.title', 'R1:data.task.status', 'R2:data.task.status'], { ...projects, metrics: ['task.title', 'task.status'], fields: [] })), null);
  // Tekrar kaydı sayısı projenin sayımıdır: ikinci projenin adı onun sayısının yerine geçmez.
  const entries = { operation: 'value', metrics: ['recurrence.entries', 'project.name'], population: { tool: 'rota_recurrence_inspect' },
    entities: [{ type: 'project', id: PROJECTS.FULL }, { type: 'project', id: PROJECTS.READ }] };
  assert.equal(issue(verifyRequested(ledger, ['R3:data.visibleEntryCount', 'R5:data.project.name'], entries)), 'ENTITY_MISSING');
  const both = verifyRequested(ledger, ['R3:data.visibleEntryCount', 'R4:data.visibleEntryCount', 'R5:data.project.name'], entries);
  assert.equal(issue(both), null);
  assert.match(both.normalized, /\*\*0\*\* \(ölçüt: Proje: Okuma Projesi\)/);
});

test('each bound owner carries every requested measuring metric: one owner value or emptiness never stands in for another', async (t) => {
  const { ledger } = await callRotaTools(stackFor(t), AYSE, [['rota_task_detail', { taskId: TASKS.OVERDUE }], ['rota_task_detail', { taskId: TASKS.UNASSIGNED }],
    ['rota_project_detail', { projectId: PROJECTS.FULL }], ['rota_project_detail', { projectId: PROJECTS.READ }]]);
  const raw = { operation: 'value', metrics: ['task.title', 'task.assignees'], population: { tool: 'rota_task_detail' },
    entities: [{ type: 'task', id: TASKS.OVERDUE }, { type: 'task', id: TASKS.UNASSIGNED }] };
  // R1: Ayşe atanmış; R2: sorumlusu yok (assignees: []).
  const both = verifyRequested(ledger, ['R1:data.task.title', 'R1:data.task.assignees.0.name', 'R2:data.task.title'], raw);
  assert.equal(issue(both), null);
  assert.match(both.normalized, /Ayşe Yılmaz/);
  assert.match(both.normalized, /Sorumlu[^\n]*Belirtilmemiş/, 'ikinci görevin boşluğu da yanıttadır');
  assert.equal(issue(verifyRequested(ledger, ['R1:data.task.title', 'R2:data.task.title'], raw)), 'ENTITY_MISSING', 'boşluk dolu değerin yerini tutmaz');
  const request = parsedRequest(raw);
  const [candidate] = requestSelections(request, ledger.requestEntries(), null, REQUEST_TODAY);
  assert.equal(issue(verifyRequested(ledger, JSON.parse(candidate).facts, raw)), null);
  // Ölçen ölçü her varlıkta verilir; ikinci projenin adı onun açık görev sayısının yerine geçmez.
  const projects = { operation: 'value', metrics: ['project.name', 'tasks.open'], population: { tool: 'rota_project_detail' },
    entities: [{ type: 'project', id: PROJECTS.FULL }, { type: 'project', id: PROJECTS.READ }] };
  assert.equal(issue(verifyRequested(ledger, ['R3:data.project.name', 'R3:data.visibleTasks.open', 'R4:data.project.name'], projects)), 'ENTITY_MISSING');
  assert.equal(issue(verifyRequested(ledger, ['R3:data.visibleTasks.open', 'R4:data.project.name', 'R4:data.visibleTasks.open'], projects)), null);
});

test('a zero-hit task name scoped to the declared project probes and ends inside that project only', async () => {
  const { createToolScope } = await import('../src/server/ai/tools/toolScope.js');
  const request = parsedRequest({ operation: 'value', metrics: ['task.status'], population: { tool: 'rota_task_detail' },
    entities: [{ type: 'project', id: PROJECTS.FULL }, { type: 'task', text: 'Olmayan görev' }] });
  const miss = (args, id = 'R1') => source('rota_task_search', { tasks: [], titleResolution: 'none' }, { id, args });
  const scoped = miss({ text: 'Olmayan görev', projectId: PROJECTS.FULL });
  assert.deepEqual(requestDeclarationModule.nameProbes(request, entriesOf([scoped])),
    [{ name: 'rota_task_search', args: { text: 'Olmayan', projectId: PROJECTS.FULL } }], 'yoklama projede kalır');
  assert.equal(requestDeclarationModule.unmatchedEntities(request, entriesOf([scoped])).length, 0);
  const probed = [scoped, miss({ text: 'Olmayan', projectId: PROJECTS.FULL }, 'R2')];
  assert.equal(requestDeclarationModule.unmatchedEntities(request, entriesOf(probed)).length, 1, 'projede bulunmayan ad "bulunamadı" ile biter');
  // Başka projedeki boşluk bu projenin kanıtı değildir; projesiz istekte projedeki boşluk genel boşluk değildir.
  const elsewhere = [miss({ text: 'Olmayan görev', projectId: PROJECTS.READ }), miss({ text: 'Olmayan', projectId: PROJECTS.READ }, 'R2')];
  assert.equal(requestDeclarationModule.unmatchedEntities(request, entriesOf(elsewhere)).length, 0);
  const unscoped = parsedRequest({ operation: 'value', metrics: ['task.status'], population: { tool: 'rota_task_detail' }, entities: [{ type: 'task', text: 'Olmayan görev' }] });
  assert.deepEqual(requestDeclarationModule.nameProbes(unscoped, entriesOf([scoped])), []);
  assert.equal(requestDeclarationModule.unmatchedEntities(unscoped, entriesOf(probed)).length, 0);
  // Kapsam sınırı: projedeki boşluğun yoklaması aynı projede kalır; projesiz yoklamaya dönüşemez.
  const scope = createToolScope({ today: REQUEST_TODAY, userText: `${PROJECTS.FULL} projesinde Olmayan görev durumu` });
  scope.establish([{ name: 'rota_task_search', arguments: JSON.stringify({ text: 'Olmayan görev', projectId: PROJECTS.FULL }) }],
    [{ content: JSON.stringify({ ok: true, complete: true, data: { tasks: [], titleResolution: 'none' } }) }]);
  assert.doesNotThrow(() => scope.validate('rota_task_search', { text: 'Olmayan', projectId: PROJECTS.FULL }));
  assert.throws(() => scope.validate('rota_task_search', { text: 'Olmayan' }), { code: 'UNSUPPORTED_SCOPE' });
});

test('grouping by the named records type drops the naming metric together with its field and entity bindings', () => {
  const raw = { operation: 'list', metrics: ['project.name', 'tasks.total'], population: { tool: 'rota_task_analytics', groupBy: 'project' },
    entities: [{ type: 'project', id: PROJECTS.FULL }], fields: [{ metric: 'project.name', tool: 'rota_project_detail', path: 'data.project.name' }] };
  const { request, problems } = complete(raw, []);
  assert.deepEqual(problems, []);
  assert.deepEqual([request.operation, request.metrics, request.fields], ['value', ['tasks.total'], []]);
});

test('a list and a bound entity whose own multivalue property is explicitly empty agree in readiness, selection and verification', async (t) => {
  const raw = { operation: 'list', metrics: ['task.title', 'project.tags'], population: { tool: 'rota_task_search', collection: 'tasks' },
    entities: [{ type: 'project', id: PROJECTS.READ }] };
  const { request, problems } = complete(raw, []);
  assert.deepEqual(problems, []);
  const reads = populationServer.derivedReads(request, request.entities.map((entity) => ({ ...entity, bound: entity.id })), { today: REQUEST_TODAY });
  assert.deepEqual(reads.map(({ name }) => name), ['rota_task_search', 'rota_project_detail']);
  const stack = stackFor(t);
  const { ledger } = await callRotaTools(stack, AYSE, reads.map(({ name, args }) => [name, args]));
  const entries = ledger.requestEntries();
  assert.equal(requestEvidenceReady(request, entries, REQUEST_TODAY), true);
  const [candidate] = requestSelections(request, entries, null, REQUEST_TODAY);
  assert.ok(JSON.parse(candidate).facts.includes('R2:data.project.name'));
  const rendered = verifyRequested(ledger, JSON.parse(candidate).facts, raw);
  assert.equal(issue(rendered), null);
  assert.match(rendered.normalized, /Proje etiketleri: \*\*Belirtilmemiş\*\*/);
  // Aynı sözleşme özellik doluyken de geçerlidir: projenin etiketleri satır değil, bağlı kaydın kendi özelliğidir.
  const tagged = { ...raw, entities: [{ type: 'project', id: PROJECTS.FULL }] };
  const taggedRequest = complete(tagged, []).request;
  const full = populationServer.derivedReads(taggedRequest, taggedRequest.entities.map((entity) => ({ ...entity, bound: entity.id })), { today: REQUEST_TODAY });
  const { ledger: fullLedger } = await callRotaTools(stack, AYSE, full.map(({ name, args }) => [name, args]));
  assert.equal(requestEvidenceReady(taggedRequest, fullLedger.requestEntries(), REQUEST_TODAY), true);
  const [fullCandidate] = requestSelections(taggedRequest, fullLedger.requestEntries(), null, REQUEST_TODAY);
  assert.ok(fullCandidate, 'sunucu seçimi dolu etiketle de kurulur');
  const withTags = verifyRequested(fullLedger, JSON.parse(fullCandidate).facts, tagged);
  assert.equal(issue(withTags), null);
  assert.match(withTags.normalized, /Savunma/);
});
