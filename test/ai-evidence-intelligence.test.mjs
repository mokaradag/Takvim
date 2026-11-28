/**
 * Bilgin ICE-2 — gelişmiş kanıt zekâsı: sözleşme, kart kurucusu, canlı nüfus kaydı ve güvenlik sınırları.
 *
 * Sınananlar:
 *   - v2 tanımlayıcısının yeni kart türleri (kişi, proje, birim, koleksiyonlar, hesap, karşılaştırma) katı doğrulanır; her bozuk
 *     alan bütün tanımlayıcıyı düşürür.
 *   - Kart kurucusu her bağı kanıt yükünden ve canlı nüfus kaydından yeniden doğrular (üçlü tutarlılık: yükteki sayı = bağın
 *     sayısı = kaydın büyüklüğü); hesap ve karşılaştırma sunucunun kuralıyla yeniden hesaplanır; tutarsızlık kapalı reddedilir.
 *   - Aynı sayının farklı anlamları farklı kartlara bağlanır; prototip zinciri ve kötü niyetli alan yolları okunmaz.
 *   - Araçların canlı nüfus kaydı sayılarla birebir eşittir, model zarfına ve kalıcı kanıta girmez; portföy iki okuma arasında
 *     değişen projenin kümesini kaydetmez.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiStack } from './helpers/aiStack.mjs';
import { ALI_1, AYSE, TASKS, ZEYNEP, callRotaTool, rotaToolSeed } from './helpers/aiToolFixtures.mjs';

const { EVIDENCE_CARD_LIMITS, EVIDENCE_CARD_VERSION, bindingMark, normalizeEvidenceCards } = await import('../src/domain/ai/evidenceCards.js');
const { buildEvidenceCards, evidencePercent, settleEvidenceBindings } = await import('../src/server/ai/assistant/evidenceCards.js');
const bindings = await import('../src/domain/ai/evidenceBindings.js');

const GENERATED_AT = '2026-11-27T08:00:00.000Z';
const taskId = (n) => `21000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const summary = (id, partial = false) => ({ id, kind: 'task-analytics', label: 'Görev özeti', generatedAt: GENERATED_AT, complete: true, truncated: false, partial, counts: { returned: 1, total: 1 }, highlights: [] });

/** Görev özeti yükündeki satır biçimi (taskItem izdüşümü). */
const row = (n, overrides = {}) => ({ taskId: taskId(n), title: `Görev ${n}`, project: { projectId: '30000000-0000-4000-8000-000000000001', name: 'Altyapı' }, status: 'in_progress',
  overdue: true, overdueDays: 5, targetFinish: '2026-11-10', assignees: [{ name: 'Ayşe Demir', sicil: 900100 }], assignment: 'visible', ...overrides });

/** Canlı nüfus kaydı ve yükü taşıyan sentetik görev özeti kanıtı. */
function analyticsEntry(id, { totals = { overdue: 3, open: 5, done: 2, total: 7 }, groups = [], groupBy = null, sets = {}, rows = [] } = {}) {
  const population = {
    sets: new Map(Object.entries(sets).map(([field, set]) => [field, Object.freeze({ size: set.size, ids: set.ids, ...(set.rowKey != null ? { rowKey: set.rowKey } : {}) })])),
    rows: new Map(rows.map((item) => [item.taskId, item])),
    assignments: new Map()
  };
  return { id, tool: 'rota_task_analytics', args: {}, round: 1, cardPopulation: population,
    payload: { tool: 'rota_task_analytics', data: { totals, ...(groupBy ? { groupBy, groups } : {}) }, complete: true, truncated: false, returnedCount: totals.total, totalCount: totals.total } };
}

/** Bağları işaretli metinden çıkarıp kart kurucusuna verir (yanıt düzeninin yaptığı gibi). */
function build(parts, entries) {
  const list = parts.map(([, bind]) => bind);
  const text = parts.map(([shown], index) => `**${bindingMark(index + 1)}${shown}**`).join(' ve ');
  const settled = settleEvidenceBindings({ normalized: `${text}.` }, list);
  return buildEvidenceCards({ evidenceBindings: settled.evidenceBindings, finalText: settled.normalized, entries, summaries: entries.map((entry) => summary(entry.id)), citedIds: entries.map((entry) => entry.id) });
}

const set = (ids, extra = {}) => ({ size: ids.length, ids: ids.map(taskId), ...extra });
const overdueRows = [1, 2, 3].map((n) => row(n));

/* ── Kart kurucusu: canlı nüfus kaydı ─────────────────────── */

test('ICE-2 görev özeti sayımı kayıtlı nüfusa bağlanır: yük, bağ ve kayıt büyüklüğü eşitse görev kartı kurulur', () => {
  const entry = analyticsEntry('R1', { sets: { 'data.totals.overdue': set([1, 2, 3]) }, rows: overdueRows });
  const built = build([['3', { type: 'tasks', evidenceId: 'R1', field: 'data.totals.overdue', count: 3, title: 'Gecikmiş görevler', tone: 'overdue' }]], [entry]);
  assert.ok(built);
  const [card] = built.descriptor.cards;
  assert.equal(card.kind, 'tasks');
  assert.equal(card.total, 3);
  assert.deepEqual(card.items.map((item) => item.id), [1, 2, 3].map(taskId));
  assert.deepEqual(built.evidenceIds, ['R1']);
  assert.doesNotMatch(JSON.stringify(built.descriptor), /sicil|cardPopulation|data\.totals/i);
});

for (const [name, mutate] of [
  ['yükteki sayı bağdan farklı', (entry) => { entry.payload.data.totals.overdue = 4; }],
  ['kayıt büyüklüğü bağdan farklı', (entry) => { entry.cardPopulation.sets.set('data.totals.overdue', Object.freeze({ size: 4, ids: [1, 2, 3].map(taskId) })); }],
  ['önizleme satırı kayıtta yok', (entry) => { entry.cardPopulation.rows.delete(taskId(2)); }],
  ['kayıt yok', (entry) => { entry.cardPopulation = null; }],
  ['alan kayıtlı değil', (entry) => { entry.cardPopulation.sets.delete('data.totals.overdue'); }]
]) {
  test(`ICE-2 tutarsız nüfus kartı kapalı reddedilir: ${name}`, () => {
    const entry = analyticsEntry('R1', { sets: { 'data.totals.overdue': set([1, 2, 3]) }, rows: overdueRows });
    mutate(entry);
    assert.equal(build([['3', { type: 'tasks', evidenceId: 'R1', field: 'data.totals.overdue', count: 3, title: 'Gecikmiş', tone: 'overdue' }]], [entry]), null);
  });
}

test('ICE-2 satır yolundaki kümenin satır kimliği yükteki satırla aynı değilse kart üretilmez', () => {
  const groups = [{ key: 'p1', label: 'Altyapı', count: 3, open: 3, overdue: 3, done: 0 }];
  const ok = analyticsEntry('R1', { groupBy: 'project', groups, sets: { 'data.groups.0.overdue': set([1, 2, 3], { rowKey: 'p1' }) }, rows: overdueRows });
  const bind = { type: 'tasks', evidenceId: 'R1', field: 'data.groups.0.overdue', count: 3, title: 'Altyapı · Gecikmiş', tone: 'overdue' };
  assert.ok(build([['3', bind]], [ok]));
  const moved = analyticsEntry('R1', { groupBy: 'project', groups, sets: { 'data.groups.0.overdue': set([1, 2, 3], { rowKey: 'p2' }) }, rows: overdueRows });
  assert.equal(build([['3', bind]], [moved]), null, 'kayıt başka satıra ait');
});

test('ICE-2 aynı sayı farklı anlamlarda (8 gecikmiş, 8 kişi, 8 tamamlanmış) ayrı ve doğru kartlara bağlanır', () => {
  const people = Array.from({ length: 8 }, (_, index) => ({ sicil: 900200 + index, name: `Kişi ${index + 1}`, openTasks: 1, inProgress: 0, overdue: 1, dueNext7Days: 0 }));
  const late = Array.from({ length: 8 }, (_, index) => row(index + 1));
  const done = Array.from({ length: 8 }, (_, index) => row(index + 11, { status: 'done', overdue: false, overdueDays: undefined, actualFinish: '2026-11-01' }));
  const analytics = analyticsEntry('R1', { totals: { overdue: 8, done: 8, open: 8, total: 16 }, sets: { 'data.totals.overdue': set([1, 2, 3, 4, 5, 6, 7, 8]), 'data.totals.done': set([11, 12, 13, 14, 15, 16, 17, 18]) }, rows: [...late, ...done] });
  const workload = { id: 'R2', tool: 'rota_workload_summary', args: {}, round: 1, payload: { tool: 'rota_workload_summary', data: { people, populationComplete: true }, complete: true, truncated: false, returnedCount: 8, totalCount: 8 } };
  const built = build([
    ['8', { type: 'tasks', evidenceId: 'R1', field: 'data.totals.overdue', count: 8, title: 'Gecikmiş görevler', tone: 'overdue' }],
    ['8', bindings.entitiesBind({ tool: 'rota_workload_summary', evidenceId: 'R2', rows: people.map((_, index) => `data.people.${index}`), title: 'Kişiler' })],
    ['8', { type: 'tasks', evidenceId: 'R1', field: 'data.totals.done', count: 8, title: 'Tamamlanan görevler', tone: 'done' }]
  ], [analytics, workload]);
  const kinds = built.descriptor.anchors.map((anchor) => built.descriptor.cards.find((card) => card.id === anchor.card));
  assert.deepEqual(kinds.map((card) => card.kind), ['tasks', 'people', 'tasks']);
  assert.ok(kinds[0].items.every((item) => item.overdue));
  assert.ok(kinds[2].items.every((item) => item.status === 'done'));
  assert.notEqual(kinds[0].id, kinds[2].id);
  assert.equal(kinds[1].total, 8);
  assert.doesNotMatch(JSON.stringify(built.descriptor), /9002\d\d|sicil/);
});

/* ── Birleşim ve koşul bağları ─────────────────────────────── */

test('ICE-2 ayrık grupların birleşimi yalnızca birbirini dışlayan gruplamada ve toplam tutarsa kurulur', () => {
  const groups = [{ key: 'days_0_6', label: 'Önümüzdeki 7 gün', count: 2, open: 2 }, { key: 'days_7_13', label: '8–14. gün', count: 1, open: 1 }];
  const make = (groupBy) => analyticsEntry('R1', { groupBy, groups, sets: { 'data.groups.0.count': set([1, 2], { rowKey: 'days_0_6' }), 'data.groups.1.count': set([3], { rowKey: 'days_7_13' }) }, rows: overdueRows });
  const bind = { type: 'tasks', evidenceId: 'R1', fields: ['data.groups.0.count', 'data.groups.1.count'], count: 3, title: '14 gün içinde', tone: 'due' };
  assert.equal(build([['3', bind]], [make('due_horizon')]).descriptor.cards[0].total, 3);
  assert.equal(build([['3', bind]], [make('assignee')]), null, 'örtüşebilen gruplama');
  assert.equal(build([['4', { ...bind, count: 4 }]], [make('due_horizon')]), null, 'toplam tutmuyor');
});

test('ICE-2 görev listesinde koşullu alt küme yalnızca bütün nüfus yükteyse ve sayı tutuyorsa kurulur', () => {
  const rows = [row(1), row(2, { overdue: false, overdueDays: undefined, targetFinish: null }), row(3)];
  const entry = (complete, totalCount = 3) => ({ id: 'R1', tool: 'rota_task_search', args: {}, round: 1,
    payload: { tool: 'rota_task_search', data: { tasks: rows }, complete, truncated: false, returnedCount: 3, totalCount } });
  const late = { type: 'tasks', evidenceId: 'R1', predicate: 'overdue', count: 2, title: 'Gecikmiş kilometre taşları', tone: 'overdue' };
  assert.equal(build([['2', late]], [entry(true)]).descriptor.cards[0].total, 2);
  assert.equal(build([['2', late]], [entry(false, 9)]), null, 'nüfus yükte değil');
  assert.equal(build([['3', { ...late, count: 3 }]], [entry(true)]), null, 'sayı tutmuyor');
  assert.equal(build([['1', { ...late, predicate: 'withoutTargetFinish', count: 1 }]], [entry(true)]).descriptor.cards[0].items[0].id, taskId(2));
  assert.equal(build([['1', { ...late, predicate: 'constructor', count: 1 }]], [entry(true)]), null, 'bilinmeyen koşul');
});

/* ── Varlık, hesap ve karşılaştırma kartları ───────────────── */

const workloadEntry = (people) => ({ id: 'R2', tool: 'rota_workload_summary', args: {}, round: 1, cardPopulation: { sets: new Map([['data.people.0.overdue', Object.freeze({ size: 2, ids: [taskId(1), taskId(2)], rowKey: '900100' })]]), rows: new Map(overdueRows.map((item) => [item.taskId, item])), assignments: new Map() },
  payload: { tool: 'rota_workload_summary', data: { people, populationComplete: true }, complete: true, truncated: false, returnedCount: people.length, totalCount: people.length } });

test('ICE-2 kişi kartı doğrulanmış ölçüleri ve kişinin kayıtlı gecikmiş görevlerini taşır; Sicil taşınmaz', () => {
  const people = [{ sicil: 900100, name: 'Ayşe Demir', openTasks: 4, inProgress: 1, overdue: 2, dueNext7Days: 1 }];
  const built = build([['Ayşe Demir', bindings.entityBind({ tool: 'rota_workload_summary', evidenceId: 'R2', row: 'data.people.0' })]], [workloadEntry(people)]);
  const [card] = built.descriptor.cards;
  assert.equal(card.kind, 'person');
  assert.equal(card.title, 'Ayşe Demir');
  assert.deepEqual(card.metrics.map((metric) => [metric.label, metric.value]), [['Açık görev', '4'], ['Devam eden', '1'], ['Gecikmiş', '2'], ['7 gün içinde terminli', '1']]);
  assert.equal(card.listLabel, 'Gecikmiş görevler');
  assert.equal(card.total, 2);
  assert.equal(card.items.length, 2);
  assert.doesNotMatch(JSON.stringify(card), /900100|sicil/i);
});

test('ICE-2 varlık olmayan satır (sorumlusuz, diğer) ve yolu bozuk satır varlık kartı üretmez', () => {
  const groups = [{ key: 'unassigned', label: 'Sorumlusuz', count: 2, open: 2, overdue: 1, done: 0 }];
  const entry = analyticsEntry('R1', { groupBy: 'project', groups });
  assert.equal(bindings.entityBind({ tool: 'rota_task_analytics', evidenceId: 'R1', row: 'data.groups.0', groupBy: 'project', key: 'unassigned' }), null);
  assert.equal(build([['Sorumlusuz', { type: 'entity', evidenceId: 'R1', row: 'data.groups.0', entity: 'project' }]], [entry]), null);
  assert.equal(build([['X', { type: 'entity', evidenceId: 'R1', row: 'data.groups.__proto__', entity: 'project' }]], [entry]), null);
  assert.equal(bindings.entityBind({ tool: 'rota_task_search', evidenceId: 'R1', row: 'data.tasks.0' }), null, 'görev listesi varlık kaynağı değil');
});

test('ICE-2 hesap kartı sunucunun kuralıyla yeniden hesaplanır: 12 / 40 × 100 = %30', () => {
  const entry = analyticsEntry('R1', { totals: { open: 40, overdue: 12, done: 0, total: 40 } });
  const calc = bindings.calcBind({ numerator: bindings.operand({ evidenceId: 'R1', field: 'data.totals.overdue', value: 12, label: 'Gecikmiş görev' }),
    denominator: bindings.operand({ evidenceId: 'R1', field: 'data.totals.open', value: 40, label: 'Açık görev' }), shown: 30, title: 'Açık işlerde gecikme oranı' });
  const [card] = build([['%30', calc]], [entry]).descriptor.cards;
  assert.equal(card.kind, 'calc');
  assert.equal(card.result, '%30');
  assert.equal(card.formula, '12 / 40 × 100 = %30');
  assert.deepEqual(card.metrics, [{ label: 'Gecikmiş görev', value: '12' }, { label: 'Açık görev', value: '40' }]);
  assert.equal(card.note, undefined);
  assert.equal(build([['%31', { ...calc, shown: 31 }]], [entry]), null, 'yanıttaki yüzde hesapla aynı değil');
});

for (const [name, numerator, denominator, rule, expected] of [
  ['yuvarlanan pay', 1, 3, 'share', 33], ['küçük pay kesri korunur', 1, 300, 'share', (1 / 300) * 100], ['tamamı olmayan pay %100 olmaz', 199, 200, 'share', 99],
  ['çoğunluk %50 değil ondalıkla', 1001, 2000, 'majority', 50.05], ['tamamlanma oranı', 18, 75, 'round', 24], ['tamamlanma %0 olmaz', 1, 300, 'round', 1],
  ['payda sıfır', 0, 0, 'share', null], ['pay paydadan büyük', 5, 4, 'share', null], ['yarıyı aşmayan çoğunluk', 5, 10, 'majority', null]
]) {
  test(`ICE-2 yüzde kuralı: ${name}`, () => assert.equal(evidencePercent(numerator, denominator, rule), expected));
}

test('ICE-2 yanıtın yazmadığı payda yükten okunur; değer yükte yoksa hesap kartı yoktur', () => {
  const entry = analyticsEntry('R1', { totals: { open: 56, overdue: 5, done: 18, total: 74 } });
  const calc = bindings.calcBind({ numerator: bindings.operand({ evidenceId: 'R1', field: 'data.totals.done', value: null, label: 'Tamamlanan' }),
    denominator: bindings.operand({ evidenceId: 'R1', field: 'data.totals.total', value: null, label: 'Bütün görevler' }), shown: 24, rule: 'round', title: 'Tamamlanma oranı' });
  const [card] = build([['%24', calc]], [entry]).descriptor.cards;
  assert.equal(card.formula, '18 / 74 × 100 ≈ %24');
  assert.equal(card.note, 'Sonuç tam sayıya yuvarlanmıştır.');
  delete entry.payload.data.totals.total;
  assert.equal(build([['%24', calc]], [entry]), null);
});

test('ICE-2 karşılaştırma kartı iki dönemin değerini, farkı ve doğrulanmış değişim oranını taşır; iki kanıta da bağımlıdır', () => {
  const earlier = analyticsEntry('R1', { totals: { total: 8, open: 0, done: 8, overdue: 0 } });
  const later = analyticsEntry('R2', { totals: { total: 6, open: 0, done: 6, overdue: 0 } });
  const items = [bindings.operand({ evidenceId: 'R1', field: 'data.totals.total', value: 8, label: 'Ağustos 2026' }), bindings.operand({ evidenceId: 'R2', field: 'data.totals.total', value: 6, label: 'Eylül 2026' })];
  const built = build([['%25', bindings.compareBind({ items, title: 'Dönem karşılaştırması', rate: 25 })]], [earlier, later]);
  const [card] = built.descriptor.cards;
  assert.equal(card.kind, 'compare');
  assert.equal(card.result, 'Fark: −2 (azalış %25)');
  assert.deepEqual(built.evidenceIds.sort(), ['R1', 'R2']);
  assert.equal(build([['%30', bindings.compareBind({ items, title: 'X', rate: 30 })]], [earlier, later]), null, 'oran tutmuyor');
  assert.equal(build([['%25', bindings.compareBind({ items, title: 'X', rate: 25 })]], [earlier]), null, 'ikinci kanıt atfedilmedi');
});

/* ── Sözleşme ve güvenlik ───────────────────────────────────── */

const validFactCard = () => ({ id: 'c1', kind: 'calc', title: 'Oran', tone: 'overdue', generatedAt: GENERATED_AT, scopePartial: false,
  metrics: [{ label: 'Gecikmiş', value: '12' }, { label: 'Açık', value: '40' }], result: '%30', formula: '12 / 40 × 100 = %30' });
const validCollection = () => ({ id: 'c2', kind: 'projects', title: 'Projeler', tone: 'neutral', generatedAt: GENERATED_AT, scopePartial: true, total: 2,
  columns: ['Açık', 'Gecikmiş'], rows: [{ name: 'Altyapı', values: [12, 5] }, { name: 'Mobil', values: [9, null] }] });
const validEntity = () => ({ id: 'c3', kind: 'person', title: 'Ayşe Demir', tone: 'neutral', generatedAt: GENERATED_AT, scopePartial: false, metrics: [{ label: 'Açık görev', value: '4' }], total: 0, items: [] });
const descriptor = () => ({ v: EVIDENCE_CARD_VERSION, cards: [validFactCard(), validCollection(), validEntity()],
  anchors: [{ strong: 0, text: '%30', card: 'c1' }, { strong: 1, text: '2', card: 'c2' }, { strong: 2, text: 'Ayşe Demir', card: 'c3' }] });

test('uzun başlık kendi çapasını düşürür ve sonraki geçerli çapayı korur', () => {
  const text = `**${bindingMark(1)}${'Birim '.repeat(35)}sonu** ve **${bindingMark(2)}3** görev.`;
  const settled = settleEvidenceBindings({ normalized: text }, [{}, {}]);
  assert.deepEqual(settled.evidenceBindings.anchors.map(({ key, strong, text }) => [key, strong, text]), [[2, 1, '3']]);
});

test('varlık koleksiyonu satırları da yanıtın ortak bütçesine girer', () => {
  const sample = validCollection();
  const rows = Array.from({ length: 30 }, (_, index) => ({ name: `Proje ${index}`, values: [1, 0] }));
  const cards = Array.from({ length: 13 }, (_, index) => ({ ...sample, id: `c${index + 1}`, rows, total: rows.length }));
  const anchors = cards.map(({ id }, strong) => ({ strong, text: '30', card: id }));
  assert.ok(normalizeEvidenceCards({ v: EVIDENCE_CARD_VERSION, cards: cards.slice(0, 12), anchors: anchors.slice(0, 12) }));
  assert.equal(normalizeEvidenceCards({ v: EVIDENCE_CARD_VERSION, cards, anchors }), null);
});

test('ICE-2 v2 tanımlayıcısı hesap, koleksiyon ve kişi kartlarını katı doğrular', () => {
  const normalized = normalizeEvidenceCards(descriptor());
  assert.ok(normalized);
  assert.deepEqual(normalized.cards.map((card) => card.kind), ['calc', 'projects', 'person']);
  assert.equal(normalizeEvidenceCards({ ...descriptor(), v: 1 }), null, 'eski sürüm istemcide düşer');
});

for (const [name, mutate] of [
  ['hesapta tek işlenen', (value) => { value.cards[0].metrics.pop(); }],
  ['ölçü değeri çok uzun', (value) => { value.cards[0].metrics[0].value = '9'.repeat(EVIDENCE_CARD_LIMITS.maxValueChars + 1); }],
  ['ölçü etiketinde denetim karakteri', (value) => { value.cards[0].metrics[0].label = 'Ge\u0000cikmiş'; }],
  ['ölçü etiketinde yön karakteri', (value) => { value.cards[0].metrics[0].label = '‮ters'; }],
  ['sonuç eksik', (value) => { delete value.cards[0].result; }],
  ['koleksiyon satırı toplamdan fazla', (value) => { value.cards[1].total = 1; }],
  ['koleksiyon sütun sayısı tutmuyor', (value) => { value.cards[1].rows[0].values = [12]; }],
  ['koleksiyon değeri negatif', (value) => { value.cards[1].rows[0].values = [-1, 5]; }],
  ['koleksiyon değeri kesirli', (value) => { value.cards[1].rows[0].values = [1.5, 5]; }],
  ['koleksiyon sütunu çok', (value) => { value.cards[1].columns = ['a', 'b', 'c', 'd', 'e']; value.cards[1].rows.forEach((item) => { item.values = [1, 2, 3, 4, 5]; }); }],
  ['koleksiyon boş', (value) => { value.cards[1].rows = []; }],
  ['kişi kartında önizleme toplamdan fazla', (value) => { value.cards[2].items = [{ id: taskId(1), title: 'A', project: null, status: 'todo', overdue: false, overdueDays: null, due: null, finished: null, progress: null, assignees: [], hiddenAssignees: 0, assignment: 'unassigned' }]; }],
  ['kişi kartında ölçü yok', (value) => { value.cards[2].metrics = []; }],
  ['bilinmeyen tür', (value) => { value.cards[0].kind = 'html'; }],
  ['düz olmayan ölçü', (value) => { value.cards[0].metrics[0] = Object.assign(Object.create({ label: 'X' }), { value: '1' }); }],
  ['bağ bilinmeyen karta', (value) => { value.anchors[0].card = 'c9'; }]
]) {
  test(`ICE-2 bozuk v2 tanımlayıcısı bütünüyle düşer: ${name}`, () => {
    const value = descriptor();
    mutate(value);
    assert.equal(normalizeEvidenceCards(value), null);
    assert.equal(Object.prototype.polluted, undefined);
  });
}

test('ICE-2 tanımlayıcıdaki prototip anahtarı taşınmaz ve küresel nesneyi kirletmez', () => {
  const value = descriptor();
  value.cards[0] = JSON.parse(JSON.stringify(value.cards[0]).replace('"metrics"', '"__proto__":{"polluted":true},"metrics"'));
  value.cards[0].metrics[0] = JSON.parse('{"__proto__":{"polluted":true},"label":"Gecikmiş","value":"12"}');
  const normalized = normalizeEvidenceCards(value);
  assert.ok(normalized, 'bilinmeyen alan yok sayılır; kart yeni nesne olarak kurulur');
  assert.equal(Object.hasOwn(normalized.cards[0], '__proto__'), false);
  assert.equal(Object.hasOwn(normalized.cards[0].metrics[0], '__proto__'), false);
  assert.equal(normalized.cards[0].polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('ICE-2 bağ kurucuları kayıtlı olmayan alanı, olmayan kanıtı ve pozitif olmayan sayıyı reddeder', () => {
  assert.equal(bindings.taskSetBind({ tool: 'rota_task_analytics', evidenceId: 'R1', field: 'data.totals.completionRatePercent', count: 3 }), null);
  assert.equal(bindings.taskSetBind({ tool: 'rota_task_analytics', evidenceId: 'R1', field: 'data.totals.overdue', count: 0 }), null);
  assert.equal(bindings.taskSetBind({ tool: 'rota_task_analytics', evidenceId: null, field: 'data.totals.overdue', count: 3 }), null);
  assert.equal(bindings.taskSetBind({ tool: 'rota_activity_search', evidenceId: 'R1', field: 'data.summary.tasks', count: 3 }), null, 'hareket sayıları görev nüfusu değildir');
  assert.equal(bindings.factEvidenceId({ factId: '0123456789abcdef_R7:data.totals.open' }), 'R7');
  assert.equal(bindings.factEvidenceId({ factId: 'R7:data.totals.open' }), null);
  assert.equal(bindings.compareBind({ items: [null, null], title: 'X' }), null);
});

/* ── Araçların canlı nüfus kaydı ───────────────────────────── */

function stackFor(t, overrides = {}, sicil = AYSE) {
  return createAiStack(t, { sicil, seed: rotaToolSeed(overrides) });
}

test('ICE-2 görev özeti kaydı her toplam ve grup sayısıyla birebir eşittir; kayıt model zarfına ve kalıcı kanıta girmez', async (t) => {
  const stack = stackFor(t);
  for (const groupBy of [null, 'status', 'project', 'deadline']) {
    const { result, ledger } = await callRotaTool(stack, AYSE, 'rota_task_analytics', groupBy ? { groupBy } : {});
    assert.equal(result.ok, true, JSON.stringify(result));
    const [entry] = ledger.requestEntries({ forCards: true });
    const population = entry.cardPopulation;
    assert.ok(population, 'canlı nüfus kaydı olmalı');
    for (const [field, item] of population.sets) {
      const value = field === 'totalCount' ? entry.payload.totalCount : field.split('.').reduce((node, key) => node?.[key], entry.payload);
      assert.equal(item.size, value, `${groupBy}:${field}`);
      assert.ok(item.ids.length <= Math.min(item.size, 30));
      for (const id of item.ids) assert.ok(population.rows.has(id));
    }
    assert.doesNotMatch(JSON.stringify(result), /cardPopulation/);
    assert.equal(ledger.requestEntries()[0].cardPopulation, undefined, 'kart dışı okuyucular kaydı görmez');
    assert.doesNotMatch(JSON.stringify(ledger.persistable(ledger.ids())), /cardPopulation|"ids"/);
  }
});

test('ICE-2 iş yükü kaydı kişi satırlarının açık, gecikmiş ve yakın terminli sayılarıyla eşittir', async (t) => {
  const seed = rotaToolSeed({ executiveScope: [{ ManagerSicil: AYSE, EmployeeSicil: ZEYNEP }, { ManagerSicil: AYSE, EmployeeSicil: ALI_1 }] });
  seed.taskAssignees.push({ TaskId: TASKS.OVERDUE, Sicil: ALI_1 });
  const stack = createAiStack(t, { sicil: AYSE, seed });
  const { result, ledger } = await callRotaTool(stack, AYSE, 'rota_workload_summary', { assignee: 'team' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const [entry] = ledger.requestEntries({ forCards: true });
  const people = entry.payload.data.people;
  assert.ok(people.length >= 2);
  for (const [index, person] of people.entries()) {
    for (const metric of ['openTasks', 'inProgress', 'overdue', 'dueNext7Days']) {
      const item = entry.cardPopulation?.sets.get(`data.people.${index}.${metric}`);
      assert.equal(item?.size ?? 0, person[metric], `${person.name}:${metric}`);
    }
  }
});

test('ICE-2 portföy kaydı SQL toplamlarıyla birebir aynıdır; iki okuma arasında değişen projenin kümesi kaydedilmez', async (t) => {
  const stack = stackFor(t);
  const { result, ledger } = await callRotaTool(stack, AYSE, 'rota_portfolio_summary', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  const [entry] = ledger.requestEntries({ forCards: true });
  const projects = entry.payload.data.projects;
  assert.ok(projects.length);
  for (const [index, project] of projects.entries()) {
    for (const metric of ['total', 'open', 'overdue', 'done']) assert.equal(entry.cardPopulation.sets.get(`data.projects.${index}.tasks.${metric}`)?.size ?? 0, project.tasks[metric]);
  }
  // Eşzamanlı değişiklik: toplam sorgusundan sonra, olgu okumasından önce bir görev tamamlanır.
  const changed = stackFor(t);
  let mutatedProject = null;
  changed.db.queryBarrier = { entered: 0, released: Promise.resolve(), match(sql) {
    if (!mutatedProject && /rota-ai-tool:task-facts/.test(sql)) {
      const open = changed.db.tasks.find((task) => task.Status !== 'done');
      mutatedProject = open.ProjectId.toLowerCase();
      open.Status = 'done';
    }
    return false;
  } };
  const second = await callRotaTool(changed, AYSE, 'rota_portfolio_summary', {});
  const [after] = second.ledger.requestEntries({ forCards: true });
  assert.ok(mutatedProject);
  const recorded = [...(after.cardPopulation?.sets.keys() || [])].filter((field) => field.startsWith('data.projects.'));
  const affected = after.payload.data.projects.findIndex(project => project.projectId === mutatedProject);
  assert.ok(affected >= 0 && !recorded.some(field => field.startsWith(`data.projects.${affected}.`)), 'değişen projenin kümeleri kaydedilmemeli');
  assert.ok(after.payload.data.projects.some((project, index) => project.projectId !== mutatedProject && project.tasks.total > 0
    && recorded.includes(`data.projects.${index}.tasks.total`)), 'etkilenmeyen projenin nüfusu korunmalı');
  assert.equal([...(after.cardPopulation?.sets.keys() || [])].some((field) => field.startsWith('data.totals.')), false, 'toplam kümeleri yalnızca bütün projeler uyumluysa');
});

test('ICE-2 portföyde sayılar değişmese de gecikmiş ve yakın terminli görevlerin değişen üyeliği kartı düşürür', async (t) => {
  const stack = stackFor(t);
  const first = stack.db.tasks.find(task => task.TaskId === TASKS.OVERDUE);
  const second = stack.db.tasks.find(task => task.TaskId === TASKS.DUE_SOON);
  assert.equal(first.ProjectId, second.ProjectId);
  let swapped = false;
  stack.db.queryBarrier = { entered: 0, released: Promise.resolve(), match(sql) {
    if (!swapped && /rota-ai-tool:task-facts/.test(sql)) {
      swapped = true;
      [first.TargetFinish, second.TargetFinish] = [second.TargetFinish, first.TargetFinish];
    }
    return false;
  } };
  const { result, ledger } = await callRotaTool(stack, AYSE, 'rota_portfolio_summary', {});
  assert.ok(swapped && result.ok);
  const [entry] = ledger.requestEntries({ forCards: true });
  const index = result.data.projects.findIndex(project => project.projectId === first.ProjectId.toLowerCase());
  assert.ok(index >= 0);
  assert.ok(result.data.projects[index].tasks.overdue > 0 && result.data.projects[index].tasks.dueNext7Days > 0);
  assert.equal(entry.cardPopulation?.sets.has(`data.projects.${index}.tasks.overdue`), false);
  assert.equal(entry.cardPopulation?.sets.has(`data.projects.${index}.tasks.dueNext7Days`), false);
  assert.ok(result.data.projects.some((project, position) => position !== index && project.tasks.total > 0
    && entry.cardPopulation?.sets.has(`data.projects.${position}.tasks.total`)));
});

test('ICE-2 isteğe bağlı kart okuması başarısız olursa araç sonucu bozulmaz; yalnızca kart nüfusu kaydedilmez', async (t) => {
  const stack = stackFor(t);
  let reads = 0;
  stack.db.queryBarrier = { entered: 0, get released() { return Promise.reject(new Error('önizleme okuması başarısız')); }, match(sql) {
    // İlk görev olgusu okuması nüfustur; ikincisi kart önizlemesinin sorumlu okumasıdır ve başarısız olur.
    if (!/rota-ai-tool:task-facts/.test(sql)) return false;
    reads += 1;
    return reads === 2;
  } };
  const { result, ledger } = await callRotaTool(stack, AYSE, 'rota_task_analytics', {});
  assert.equal(reads >= 2, true, 'önizleme okuması denenmeli');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(Number.isSafeInteger(result.data?.totals?.total), true);
  assert.equal(ledger.requestEntries({ forCards: true })[0].cardPopulation, undefined);
});

test('küçük payın formülü gösterilen ondalığın kesinliğini kullanır', () => {
  const create = (denominator, label) => {
    const entry = analyticsEntry('R1', { totals: { total: denominator, overdue: 1 } });
    const numerator = bindings.operand({ evidenceId: 'R1', field: 'data.totals.overdue', value: 1, label: 'Pay' });
    const total = bindings.operand({ evidenceId: 'R1', field: 'data.totals.total', value: denominator, label: 'Payda' });
    const binding = bindings.calcBind({ numerator, denominator: total, shown: (1 / denominator) * 100, title: 'Pay' });
    return build([[label, binding]], [entry]).descriptor.cards[0].formula;
  };
  assert.equal(create(300, '%0,333'), '1 / 300 × 100 ≈ %0,333');
  assert.equal(create(400, '%0,25'), '1 / 400 × 100 = %0,25');
});

test('İngilizce not girişi gerçekten dönen tek notu tekil olarak bildirir', async () => {
  const { noteListLead } = await import('../src/domain/ai/temporalFindings.js');
  assert.match(noteListLead('en', { shown: 1, total: 3 }).plain, /1 returned note is quoted/u);
  assert.match(noteListLead('en', { shown: 2, total: 3 }).plain, /2 returned notes are quoted/u);
});
