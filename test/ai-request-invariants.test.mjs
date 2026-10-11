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
    { raw: { operation: 'list', metrics: ['wbs.name'], population: { tool: 'rota_wbs_inspect', collection: 'nodes' }, entities: [{ type: 'project', id: PROJECTS.FULL }] },
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
  const other = source('rota_task_search', { tasks: [] }, { id: 'R2', round: 1, collection: 'tasks', envelope: { totalCount: 7 } });
  assert.equal(issue(verify([tasks, other], { operation: 'list', metrics: ['tasks.total', 'task.title'] }, ['R2:totalCount', 'R1:data.tasks.*.title'])), 'POPULATION_MISMATCH',
    'başka kanıtın toplamı bu satırların sayısı değildir');
});

/* ── Tazelik ──────────────────────────────────────────────── */

test('freshness follows the carrier class and the canonical population, never the ordinal alone', () => {
  const rows = (id, round, extra = {}) => source('rota_task_search', { tasks: [{ taskId: `t${id}`, title: `Görev ${id}`, overdueDays: 10 - id }] },
    { id: `R${id}`, round, collection: 'tasks', snapshotDimensions: { sort: 'overdue_days_desc', textFields: [] }, envelope: { totalCount: 1 }, ...extra });
  const list = { operation: 'list', metrics: ['task.title'] };
  const table = [
    // Daha yeni bir sayfa (imleç) tam satır kümesini eskitmez (#2, #19).
    { name: 'later partial page', sources: [rows(1, 1), rows(2, 2, { firstPage: false, envelope: { totalCount: 5, complete: false } })], refs: ['R1:data.tasks.*.title'], expected: null },
    // Aynı nüfusun daha yeni tam okuması eskisinin yerine geçer.
    { name: 'later complete snapshot', sources: [rows(1, 1), rows(2, 2)], refs: ['R1:data.tasks.*.title'], expected: 'STALE_EVIDENCE' },
    // Farklı sırayla okunan tam liste başka bir satır nüfusudur (#22).
    { name: 'later complete with another sort', sources: [rows(1, 1), rows(2, 2, { snapshotDimensions: { sort: 'updated_desc', textFields: [] } })], refs: ['R1:data.tasks.*.title'], expected: null },
    // Aynı turdaki eşdeğer okumalar aynı andır.
    { name: 'same round equivalent', sources: [rows(1, 1), rows(2, 1)], refs: ['R1:data.tasks.*.title'], expected: null }
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
  const sorted = await callRotaTool(stack, AYSE, 'rota_task_search', { sort: 'updated_desc' });
  const list = parsedRequest({ operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks', sort: 'target_finish_asc' } });
  assert.equal(requestEvidenceReady(list, sorted.ledger.requestEntries(), REQUEST_TODAY), false);
  assert.equal(requestEvidenceReady({ ...list, population: { ...list.population, sort: 'updated_desc' } }, sorted.ledger.requestEntries(), REQUEST_TODAY), true);
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
  assert.deepEqual(derive(overdueMine, []), [['rota_task_search', { deadline: 'overdue', assignee: 'me', sort: 'overdue_days_desc' }]]);
  // Aynı nüfus farklı yazımla okunduysa yinelenmez; küçük sayfa eksik okumadır ve bir kez tam okunur.
  assert.deepEqual(derive(overdueMine, [], [['rota_task_search', { assignee: 'me', deadline: 'overdue' }]]), []);
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

test('a depth-limited WBS listing is the complete population of that depth and its total counts that depth', async (t) => {
  const stack = stackFor(t);
  const { ledger } = await callRotaTools(stack, AYSE, [['rota_wbs_inspect', { projectId: PROJECTS.FULL, depth: 2 }]]);
  const [entry] = ledger.requestEntries();
  assert.deepEqual([entry.payload.complete, entry.payload.totalCount, entry.payload.data.nodeCount, entry.payload.data.deeperNodes], [true, 2, 2, true],
    'derinlik nüfusun boyutudur; daha derin düğümler yalnızca not edilir');
  const counted = { operation: 'list', metrics: ['wbs.nodes', 'wbs.name'], population: { tool: 'rota_wbs_inspect', collection: 'nodes', depth: 2 },
    entities: [{ type: 'project', id: PROJECTS.FULL }] };
  const verdict = verifyRequested(ledger, ['R1:data.nodeCount', 'R1:data.nodes.*.name', 'R1:data.nodes.*.code'], counted);
  assert.equal(issue(verdict), null);
  assert.match(verdict.normalized, /^Düğüm sayısı: \*\*2\*\* \(ölçüt: Derinlik: 2 düzey\)/);
  // Derinlikle sınırlı listede tek ad eşleşmesi bütün ağaçta tek olduğunu kanıtlamaz.
  const named = parsedRequest({ operation: 'value', metrics: ['wbs.subtreeTasks'], population: { tool: 'rota_wbs_inspect' }, entities: [{ type: 'wbs', text: 'Tasarım' }] });
  const { bindRequestEntities } = await import('../src/server/ai/tools/requestDeclaration.js');
  assert.equal(bindRequestEntities(named, ledger.requestEntries())[0].bound, null);
  const deep = await callRotaTools(stack, AYSE, [['rota_wbs_inspect', { projectId: PROJECTS.FULL, depth: 4 }]]);
  assert.deepEqual([deep.ledger.requestEntries()[0].payload.totalCount, deep.ledger.requestEntries()[0].payload.data.deeperNodes], [3, false]);
  assert.notEqual(bindRequestEntities(named, deep.ledger.requestEntries())[0].bound, null);
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
  const ruled = { ...raw, metrics: ['recurrence.occurrenceDate', 'recurrence.rule'] };
  const [ruledFacts] = requestSelections(parsedRequest(ruled), ledger.requestEntries(), null, '2026-10-11').map((item) => JSON.parse(item).facts);
  assert.deepEqual(ruledFacts, ['R1:data.series.rule', 'R1:data.series.ruleDescription', 'R1:complete']);
  const ruledVerdict = verifyRequested(ledger, ruledFacts, ruled, { today: '2026-10-11' });
  assert.equal(ruledVerdict.ok, true, JSON.stringify(ruledVerdict.issues));
  assert.match(ruledVerdict.normalized, /Her hafta[\s\S]*bulunmadı/);
  assert.equal(ruledVerdict.normalized.match(/Her hafta/g).length, 1, 'kural ve açıklaması aynı okunuyorsa bir kez yazılır');
  // Seri sayımları (açık yineleme) üst kaydın özelliği değildir: satırlarla birlikte sayı olamaz.
  assert.ok(complete({ ...raw, metrics: ['recurrence.occurrenceDate', 'recurrence.openOccurrences'] }, []).problems.includes('$.metrics[1]:not-row-total'));
  const upcoming = await callRotaTools(stack, AYSE, [['rota_recurrence_inspect', { taskId: TASKS.SERIES }]]);
  const [withRows] = requestSelections(parsedRequest(ruled), upcoming.ledger.requestEntries(), null, REQUEST_TODAY).map((item) => JSON.parse(item).facts);
  assert.ok(withRows.includes('R1:data.series.next.*.occurrenceDate') && withRows.includes('R1:data.series.rule'), withRows.join());
  assert.equal(issue(verifyRequested(upcoming.ledger, withRows, ruled)), null);
});

test('a list column whose carriers are representations of one value (project name and code) is server-selected; a value question keeps model selection', async (t) => {
  const stack = stackFor(t);
  const { ledger } = await callRotaTools(stack, AYSE, [['rota_task_search', { deadline: 'overdue', assignee: 'me' }]]);
  const list = parsedRequest({ operation: 'list', metrics: ['task.title', 'task.project'], population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' },
    filters: { deadline: 'overdue', assignee: 'me' } });
  const [candidate] = requestSelections(list, ledger.requestEntries(), null, REQUEST_TODAY);
  assert.ok(JSON.parse(candidate).facts.includes('R1:data.tasks.*.project.name'));
  assert.ok(JSON.parse(candidate).facts.includes('R1:data.tasks.*.project.code'));
  assert.equal(issue(verifyRequested(ledger, JSON.parse(candidate).facts, list)), null);
  const wbs = await callRotaTool(stack, AYSE, 'rota_wbs_inspect', { projectId: PROJECTS.FULL, depth: 4 });
  const nodes = parsedRequest({ operation: 'list', metrics: ['wbs.name'], population: { tool: 'rota_wbs_inspect', collection: 'nodes', depth: 4 } });
  assert.deepEqual(requestSelections(nodes, wbs.ledger.requestEntries(), null, REQUEST_TODAY).map((item) => JSON.parse(item).facts),
    [['R1:data.nodes.*.name', 'R1:data.nodes.*.code']], 'düğüm adı ve kodu aynı sütundur');
});
