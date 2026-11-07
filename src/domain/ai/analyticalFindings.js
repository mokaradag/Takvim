import { factSentence, formatCount, formatFactDay, formatPercent, locativeCountSuffix, possessiveCount, sharePercent, strongFact } from './groundedPropositions.js';

/**
 * Aşama F — BÖLÜMLER ARASI ANALİTİK BULGULAR ve yanıtın GİRİŞ / SONUÇ anlatımı (saf, belirlenimci).
 *
 * Aşama 4E önermeleri tek bir kanıt bölümünün içindedir; yönetici sorusunun asıl yanıtı ise bölümler arası ilişkidir:
 * hangi proje hem gecikmede hem yakın teslimatta öne çıkıyor, gecikmeler nerede toplanıyor, hangi işler aynı anda birden
 * çok dikkat noktası taşıyor, ilk ne ele alınabilir. Bu modül turun DOĞRULANMIŞ olgularından bu ilişkileri yapılandırılmış
 * bulgular olarak türetir ve yanıtın başına soruyu yanıtlayan bir giriş, sonuna gerekçeli bir öncelik paragrafı yazar.
 *
 * Güven sınırı değişmez:
 *   - Her sayı, ad ve tarih aynı turun doğrulanmış kanıtındaki olgudur; paylar ve toplamlar yalnızca TAM nüfustan (bütün
 *     satırları kanıtta, kesilmemiş tablo ya da liste) sunucuda hesaplanır. Kesik tablodan pay ya da "ilk sırada" denmez.
 *   - Sıralı listenin başı yalnızca sunucunun doğruladığı sıralama (ölçü ve yön) ya da tam liste varsa kullanılır.
 *   - Bileşik risk puanı YOKTUR: "dikkat gerektiriyor" yargısı yalnızca adı verilen göstergelerle açıklanır.
 *   - Kişi düzeyindeki bulgular işlemseldir (atama dağılımı); neden, suç ya da performans yargısı üretilmez. Kişi tablosu
 *     yalnızca iş yükü kanıtı bütün atamaları temsil ettiğini kanıtladıysa (`populationComplete`) kullanılır.
 *   - Model bu metni yazmaz ve seçmez; kullanıcı metni okunmaz (dil yorumu, sözcük tablosu ya da kalıp yoktur).
 *
 * Çıktı: `{ findings, intro, conclusion }`. Her bulgu türünü, varlığını, doğrulanmış ölçülerini, karşılaştırma bağlamını,
 * kanıt kimliklerini, tamlık dayanağını ve izin verilen yorumu taşır. `intro`/`conclusion` `{ markdown, plain, evidenceIds }`
 * ya da bulgu yoksa `null`dır: basit sorulara dolgu paragrafı eklenmez.
 */

export const FINDING_KINDS = Object.freeze(['subjectComparison', 'attentionLeader', 'overdueConcentration', 'simultaneousPressure', 'windowPressure', 'overdueProjectShare', 'longestOverdue',
  'nearestDelivery', 'overdueShare']);
/** İzin verilen yorumlar (kapalı küme): bulgunun anlatımı bu yorumun dışına çıkamaz. */
export const FINDING_INTERPRETATIONS = Object.freeze(['comparison', 'attention', 'concentration', 'simultaneous', 'priority']);
export const FINDING_LIMITS = Object.freeze({ maxNamed: 4, minConcentrationTotal: 3, minListRows: 3, maxPriorities: 3 });

const ROW_INDEX = /^\d+$/;

/**
 * Varlık tablosu kaynakları: tam satırlı portföy projeleri, iş yükü kişileri ve projeye göre görev grupları. Kişiye göre görev
 * grupları kadroyu kanıtlamadığı için (sıfır işli üyeler ve gizli atamalar bilinmez) bulgu kaynağı DEĞİLDİR.
 */
const ENTITY_SOURCES = Object.freeze([
  Object.freeze({ tool: 'rota_portfolio_summary', entity: 'project', pattern: /^data\.projects\.(\d+)\.(name|tasks\.(?:open|overdue|dueNext7Days|done|total))$/,
    fields: Object.freeze({ name: 'name', 'tasks.open': 'open', 'tasks.overdue': 'overdue', 'tasks.dueNext7Days': 'soon', 'tasks.done': 'done', 'tasks.total': 'total' }) }),
  Object.freeze({ tool: 'rota_workload_summary', entity: 'person', pattern: /^data\.people\.(\d+)\.(name|openTasks|overdue|dueNext7Days)$/,
    fields: Object.freeze({ name: 'name', openTasks: 'open', overdue: 'overdue', dueNext7Days: 'soon' }) }),
  Object.freeze({ tool: 'rota_task_analytics', entity: 'project', groupBy: 'project', pattern: /^data\.groups\.(\d+)\.(label|count|open|overdue|done)$/,
    fields: Object.freeze({ label: 'name', count: 'total', open: 'open', overdue: 'overdue', done: 'done' }) })
]);
/** Atanamayan görevlerin özel grupları ve kesik tablonun "diğer" satırı varlık değildir. */
const NON_ENTITY_KEYS = new Set(['other', 'unassigned', 'unresolved', 'undisclosed', 'none']);
const OPEN_STATUSES = new Set(['todo', 'in_progress']);

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

function byEvidence(parts) {
  const groups = [];
  for (const part of parts) {
    const map = new Map();
    for (const item of part.presentation?.facts || []) {
      if (!item?.fact || typeof item.evidenceId !== 'string') continue;
      if (!map.has(item.evidenceId)) map.set(item.evidenceId, []);
      map.get(item.evidenceId).push(item.fact);
    }
    for (const [evidenceId, facts] of map) groups.push({ part: part.index + 1, evidenceId, facts, ranking: part.ranking || null });
  }
  return groups;
}

/** Bir kanıtın varlık tablosu (proje ya da kişi satırları) ve tamlığı. */
function entityTables(groups) {
  const tables = [];
  for (const { part, evidenceId, facts } of groups) {
    for (const source of ENTITY_SOURCES) {
      const rows = new Map();
      for (const fact of facts) {
        const semantic = fact.semantic;
        if (semantic?.provenance?.tool !== source.tool || (source.groupBy && semantic.groupBy !== source.groupBy)) continue;
        const match = source.pattern.exec(fact.field);
        if (!match) continue;
        const row = rows.get(match[1]) || { key: null, name: null, size: null, complete: true };
        rows.set(match[1], row);
        row.key ??= semantic.group?.key ?? semantic.row?.identity ?? null;
        row.size ??= semantic.row?.collectionSize ?? null;
        if (semantic.complete !== true) row.complete = false;
        const field = source.fields[match[2]];
        if (field === 'name') row.name = typeof fact.value === 'string' && fact.value.trim() ? fact.value : row.name;
        else row[field] = count(fact.value);
        if (source.groupBy && !row.name && typeof semantic.group?.label === 'string') row.name = semantic.group.label;
      }
      if (!rows.size) continue;
      const list = [...rows.values()];
      const population = source.tool !== 'rota_workload_summary' || facts.some((fact) => fact.field === 'data.populationComplete' && fact.value === true);
      const complete = population && list.length >= 2 && list.every((row) => row.complete && row.name && row.key != null && !NON_ENTITY_KEYS.has(String(row.key))
        && row.size === list.length) && new Set(list.map((row) => String(row.key))).size === list.length;
      const sample = facts.find((fact) => fact.semantic?.provenance?.tool === source.tool)?.semantic;
      tables.push({ part, evidenceId, entity: source.entity, tool: source.tool, rows: list, complete, filters: sample?.filters || {}, today: sample?.provenance?.today || null });
    }
  }
  return tables;
}

/** Görev listesi kanıtı (gecikmiş ya da yaklaşan işler): satırlar, kesin toplam, tamlık ve sunucunun doğruladığı sıralama. */
function taskLists(groups) {
  const lists = [];
  for (const { part, evidenceId, facts, ranking } of groups) {
    const sample = facts.find((fact) => fact.semantic?.provenance?.tool === 'rota_task_search');
    if (!sample) continue;
    const filters = sample.semantic.filters || {};
    const statuses = Array.isArray(filters.statuses) ? filters.statuses : [];
    const today = sample.semantic.provenance?.today;
    const future = !filters.dateField || filters.dateField === 'targetFinish';
    const upcoming = future && (String(filters.deadline || '').startsWith('due_') || today && filters.dateFrom >= today);
    const kind = filters.deadline === 'overdue' ? 'overdue'
      : statuses.length && statuses.every((status) => OPEN_STATUSES.has(status)) && upcoming ? 'upcoming' : null;
    if (!kind) continue;
    const rows = new Map();
    let complete = true;
    for (const fact of facts) {
      if (fact.semantic?.provenance?.tool !== 'rota_task_search') continue;
      if (fact.semantic.complete !== true) complete = false;
      const match = /^data\.tasks\.(\d+)\.(title|overdueDays|targetFinish|project\.name)$/.exec(fact.field);
      if (!match) continue;
      const row = rows.get(match[1]) || { index: Number(match[1]), projectId: fact.semantic.row?.projectId ?? null };
      rows.set(match[1], row);
      row[{ title: 'title', overdueDays: 'days', targetFinish: 'due', 'project.name': 'project' }[match[2]]] = fact.value;
    }
    const list = [...rows.values()].filter((row) => typeof row.title === 'string').sort((left, right) => left.index - right.index);
    if (!list.length) continue;
    const total = count(facts.find((fact) => fact.field === 'totalCount')?.value);
    const whole = complete && total != null && total === list.length && rows.size === list.length;
    lists.push({ part, evidenceId, kind, rows: list, total, complete: whole, ranking, filters, today, self: filters.assignee === 'me' });
  }
  return lists;
}

/** Tekil en büyük satır (değer > 0); eşitlikte `null`. */
function uniqueTop(rows, field) {
  const valued = rows.filter((row) => count(row[field]) != null);
  if (valued.length !== rows.length || !valued.length) return null;
  const sorted = [...valued].sort((left, right) => right[field] - left[field]);
  if (sorted[0][field] <= 0 || (sorted[1] && sorted[1][field] === sorted[0][field])) return null;
  return sorted[0];
}

const INDICATORS = Object.freeze({
  overdue: ['gecikmiş', 'overdue'],
  soon: ['önümüzdeki yedi günde terminli', 'due-within-seven-days'],
  open: ['açık', 'open']
});

function tableFindings(table) {
  const findings = [];
  if (!table.complete) return findings;
  const { rows } = table;
  const leader = uniqueTop(rows, 'overdue');
  if (leader) {
    const indicators = ['overdue', ...['soon', 'open'].filter((field) => uniqueTop(rows, field) === leader)];
    if (indicators.length >= 2) {
      findings.push({ kind: 'attentionLeader', interpretation: 'attention', entity: { type: table.entity, name: leader.name, key: String(leader.key) },
        metrics: Object.fromEntries(indicators.map((field) => [field, leader[field]])), comparison: { population: rows.length, basis: 'complete-table' },
        evidenceIds: [table.evidenceId], completeness: 'complete' });
    }
    const total = rows.reduce((sum, row) => sum + row.overdue, 0);
    // Gecikme yoğunlaşması yalnızca proje tablosunda: kişi yoğunlaşması bölümün kendi analist önermesidir (yineleme yok).
    if (table.entity === 'project' && total >= FINDING_LIMITS.minConcentrationTotal && leader.overdue * 2 >= total) {
      findings.push({ kind: 'overdueConcentration', interpretation: 'concentration', entity: { type: 'project', name: leader.name, key: String(leader.key) },
        metrics: { overdue: leader.overdue, total, share: sharePercent(leader.overdue, total) }, comparison: { population: rows.length, basis: 'complete-table' },
        evidenceIds: [table.evidenceId], completeness: 'complete' });
    }
  }
  if (rows.every((row) => count(row.overdue) != null && count(row.soon) != null)) {
    const both = rows.filter((row) => row.overdue > 0 && row.soon > 0);
    if (both.length >= 2 || (both.length === 1 && both[0] !== leader)) {
      findings.push({ kind: 'simultaneousPressure', interpretation: 'simultaneous', entity: null,
        metrics: { entities: both.length, population: rows.length }, names: both.slice(0, FINDING_LIMITS.maxNamed).map((row) => row.name), entityType: table.entity,
        comparison: { population: rows.length, basis: 'complete-table' }, evidenceIds: [table.evidenceId], completeness: 'complete' });
    }
  }
  return findings;
}

/** Sıralı listenin başı geçerli mi: tam liste ya da sunucunun doğruladığı sıralama (ölçü + yön). */
const rankedBy = (list, metric, order) => list.complete || (list.ranking?.metric === metric && list.ranking?.order === order);

function listFindings(list) {
  const findings = [];
  if (list.kind === 'overdue' && rankedBy(list, 'task.overdueDays', 'desc')) {
    const valued = list.rows.filter((row) => count(row.days) != null);
    const head = valued.length === list.rows.length ? [...valued].sort((left, right) => right.days - left.days)[0] : null;
    const tied = head && valued.filter((row) => row.days === head.days).length > 1;
    // Tek satırlı kesik sayfada başın tekilliği bilinmez.
    if (head && head.days >= 1 && !tied && (list.complete || valued.length >= 2)) {
      findings.push({ kind: 'longestOverdue', interpretation: 'priority', entity: { type: 'task', name: head.title }, project: typeof head.project === 'string' ? head.project : null,
        metrics: { days: head.days }, comparison: { population: list.total, basis: list.complete ? 'complete-list' : 'ranking-head' },
        evidenceIds: [list.evidenceId], completeness: list.complete ? 'complete' : 'ranking-head' });
    }
  }
  // Tam gecikmiş listeden proje payı (proje kimliğiyle; aynı adlı projeler karışmaz).
  if (list.kind === 'overdue' && list.complete && list.rows.length >= FINDING_LIMITS.minListRows && list.rows.every((row) => row.projectId && typeof row.project === 'string')) {
    const projects = new Map();
    for (const row of list.rows) projects.set(row.projectId, { name: row.project, count: (projects.get(row.projectId)?.count || 0) + 1 });
    const sorted = [...projects.values()].sort((left, right) => right.count - left.count);
    if (projects.size >= 2 && sorted.filter((row) => row.name === sorted[0].name).length === 1
      && sorted[0].count >= 2 && sorted[0].count > sorted[1].count && sorted[0].count * 2 >= list.rows.length) {
      findings.push({ kind: 'overdueProjectShare', interpretation: 'concentration', entity: { type: 'project', name: sorted[0].name },
        metrics: { overdue: sorted[0].count, total: list.rows.length, share: sharePercent(sorted[0].count, list.rows.length) },
        comparison: { population: list.rows.length, basis: 'complete-list' }, evidenceIds: [list.evidenceId], completeness: 'complete' });
    }
  }
  if (list.kind === 'upcoming' && rankedBy(list, 'task.targetFinish', 'asc')) {
    const dated = list.rows.filter((row) => typeof row.due === 'string' && list.today && row.due >= list.today);
    if (dated.length === list.rows.length) {
      const first = [...dated].sort((left, right) => left.due.localeCompare(right.due) || left.index - right.index)[0];
      const same = dated.filter((row) => row.due === first.due);
      // Tekillik: tam listede ya da sayfada aynı günden başka satır yoksa ve sayfa o günde bitmiyorsa.
      const sole = same.length === 1 && (list.complete || dated.some((row) => row.due > first.due));
      findings.push({ kind: 'nearestDelivery', interpretation: 'priority', entity: { type: 'task', name: first.title }, project: typeof first.project === 'string' ? first.project : null,
        metrics: { due: first.due, sole }, comparison: { population: list.total, basis: list.complete ? 'complete-list' : 'ranking-head' },
        evidenceIds: [list.evidenceId], completeness: list.complete ? 'complete' : 'ranking-head' });
    }
  }
  return findings;
}

/** Değeri olmayan (koşul koymayan) süzgeç alanı. */
const neutral = (value) => value == null || value === '' || value === 'any' || value === false || (Array.isArray(value) && !value.length);
const COMPARED_TOTALS = Object.freeze(['overdue', 'open', 'dueNext7Days', 'done']);
const SUBJECT_KEYS = new Set(['person', 'personSicil', 'project', 'projectId', 'assignee']);

/** Değer okumasının öznesi: kişi (sunucunun çözdüğü ad), oturum sahibinin kendisi ya da proje. Özne yoksa `null`. */
function subjectOf(filters) {
  if (filters.assignee === 'person' && filters.personSicil != null && typeof filters.person === 'string' && filters.person.trim() && filters.person.trim() !== 'Seçilen kişi') {
    return { type: 'person', key: `person:${filters.personSicil}`, name: filters.person.trim(), own: ['person', 'personSicil', 'assignee'] };
  }
  if (filters.assignee === 'me') return { type: 'self', key: 'self', name: null, own: ['assignee'] };
  if (filters.projectId && typeof filters.project === 'string') return { type: 'project', key: `project:${String(filters.projectId).toLowerCase()}`, name: filters.project, own: ['project', 'projectId'] };
  return null;
}

/**
 * İki öznenin (kişi, kendisi ya da proje) AYNI nüfus tanımıyla okunmuş toplamlarının karşılaştırması. Yalnızca özne dışında
 * koşul taşımayan (dönemsiz, durumsuz) toplamlar karşılaştırılır; öznelerin ortak kesişimi (ör. aynı proje) eşit olmalıdır.
 */
function comparisonFindings(groups) {
  const metrics = new Map();
  for (const { evidenceId, facts } of groups) {
    for (const fact of facts) {
      if (fact.semantic?.provenance?.tool !== 'rota_task_analytics' || fact.semantic.complete !== true) continue;
      const match = /^data\.totals\.([A-Za-z0-9]+)$/.exec(fact.field);
      if (!match || !COMPARED_TOTALS.includes(match[1]) || count(fact.value) == null) continue;
      const filters = fact.semantic.filters || {};
      const subject = subjectOf(filters);
      if (!subject) continue;
      const common = Object.entries(filters).filter(([key, value]) => !subject.own.includes(key) && !neutral(value) && !(key === 'project' && subject.type !== 'project'));
      // Dönem, durum, öncelik, termin ya da metin koşulu taşıyan toplam bu karşılaştırmanın konusu değildir (etiketi kesin değil).
      if (common.some(([key]) => !['projectId', 'project', 'assignee', 'teamLevel'].includes(key))) continue;
      const base = JSON.stringify(common.filter(([key]) => key !== 'project').sort(([left], [right]) => left.localeCompare(right)));
      const key = `${match[1]}|${base}`;
      if (!metrics.has(key)) metrics.set(key, { metric: match[1], subjects: new Map() });
      const entry = metrics.get(key);
      if (!entry.subjects.has(subject.key)) entry.subjects.set(subject.key, { ...subject, value: fact.value, evidenceId });
    }
  }
  const compared = [...metrics.values()].filter((entry) => entry.subjects.size === 2);
  if (!compared.length) return [];
  // Bütün ölçüler aynı iki özneye ait olmalı (tek karşılaştırma); sıra ilk okunan öznedir.
  const pair = [...compared[0].subjects.keys()];
  const rows = compared.filter((entry) => pair.every((key) => entry.subjects.has(key)));
  const subjects = pair.map((key) => compared[0].subjects.get(key));
  if (subjects.some((subject) => subject.type === 'project') && subjects.some((subject) => subject.type !== 'project')) return [];
  return [{ kind: 'subjectComparison', interpretation: 'comparison', entity: null, subjects: subjects.map(({ type, name }) => ({ type, name })),
    metrics: Object.fromEntries(rows.map((entry) => [entry.metric, pair.map((key) => entry.subjects.get(key).value)])),
    comparison: { population: 2, basis: 'same-population' }, evidenceIds: [...new Set(rows.flatMap((entry) => pair.map((key) => entry.subjects.get(key).evidenceId)))],
    completeness: 'complete' }];
}

/**
 * Gelecekteki bir dönemde terminli işi olan projelerden hangilerinde AYNI ANDA bugün gecikmiş iş de var? Proje grupları dönemle
 * (başlangıcı bugün ya da sonrası) okunmuşsa açık sayısı o dönemde terminli açık iştir; gecikmiş iş tam gecikmiş listesinden
 * proje kimliğiyle eşlenir (aynı adlı projeler karışmaz). İki kanıt da tam olmalıdır.
 */
function windowPressureFindings(tables, lists) {
  // Kesik gecikmiş listesi (sıralamanın başı) alt sınır verir: listede görünen projede gecikmiş iş KESİNLİKLE vardır; görünmeyende
  // olup olmadığı bilinmez. Bu yüzden kesik listede sayı "en az" olarak söylenir; tam listede kesindir.
  // Yalnızca termin koşulları farklı olabilir; diğer bütün nüfus koşulları birebir aynı kalır.
  const population = (filters) => JSON.stringify(Object.entries(filters).filter(([key, value]) =>
    !['dateFrom', 'dateTo', 'dateField', 'deadline'].includes(key) && !neutral(value)).sort(([a], [b]) => a.localeCompare(b)));
  const findings = [];
  for (const table of tables) {
    const { dateFrom, dateTo, dateField, statuses } = table.filters;
    if (table.tool !== 'rota_task_analytics' || table.entity !== 'project' || !table.complete || !table.today || !dateFrom || !dateTo || dateFrom < table.today
      || (dateField && dateField !== 'targetFinish') || (Array.isArray(statuses) && statuses.length) || !table.rows.every((row) => count(row.open) != null)) continue;
    const overdue = lists.find((list) => list.kind === 'overdue' && list.today === table.today && !list.filters.dateFrom && !list.filters.dateTo
      && population(list.filters) === population(table.filters) && list.rows.every((row) => row.projectId));
    if (!overdue) continue;
    const late = new Set(overdue.rows.map((row) => String(row.projectId).toLowerCase()));
    const names = new Map(overdue.rows.filter((row) => typeof row.project === 'string').map((row) => [String(row.projectId).toLowerCase(), row.project]));
    const due = table.rows.filter((row) => row.open > 0);
    const both = due.filter((row) => late.has(String(row.key).toLowerCase()));
    if (!both.length || due.length < 2) continue;
    findings.push({ kind: 'windowPressure', interpretation: 'simultaneous', entity: null, entityType: 'project',
      names: both.slice(0, FINDING_LIMITS.maxNamed).map((row) => names.get(String(row.key).toLowerCase()) || row.name),
      metrics: { entities: both.length, population: due.length, dateFrom, dateTo, atLeast: !overdue.complete, shown: overdue.rows.length },
      comparison: { population: due.length, basis: overdue.complete ? 'complete-table+complete-list' : 'complete-table+ranking-head' },
      evidenceIds: [table.evidenceId, overdue.evidenceId], completeness: overdue.complete ? 'complete' : 'lower-bound' });
  }
  return findings.slice(0, 1);
}

/**
 * Tek nüfusun açık işlerinde gecikmiş payı: aynı kanıtın kesin açık ve gecikmiş toplamları (iki öznenin karşılaştırmasında
 * kullanılmaz; o durumda karşılaştırma bulgusu konuşur). Pay yalnızca bu iki doğrulanmış sayıdan hesaplanır.
 */
function overdueShareFindings(groups) {
  for (const { evidenceId, facts } of groups) {
    const total = (key) => facts.find((fact) => new RegExp(`^data\\.(?:totals|visibleTasks)\\.${key}$`).test(fact.field) && fact.semantic?.complete === true && count(fact.value) != null);
    const open = total('open');
    const overdue = total('overdue');
    if (!open || !overdue || overdue.value === 0 || open.value === 0 || overdue.value > open.value) continue;
    return [{ kind: 'overdueShare', interpretation: 'priority', entity: null, metrics: { overdue: overdue.value, open: open.value, share: sharePercent(overdue.value, open.value) },
      evidenceIds: [evidenceId], completeness: 'complete' }];
  }
  return [];
}

/** Turun doğrulanmış bölümlerinden yapılandırılmış bulgular (sıra: karşılaştırma, tablo, dönem baskısı, liste bulguları). */
export function analyticalFindings(parts) {
  const groups = byEvidence(Array.isArray(parts) ? parts : []);
  const tables = entityTables(groups);
  const lists = taskLists(groups);
  const compared = comparisonFindings(groups);
  const findings = [...compared, ...tables.flatMap(tableFindings), ...windowPressureFindings(tables, lists), ...lists.flatMap(listFindings),
    ...(compared.length ? [] : overdueShareFindings(groups))];
  // Aynı varlığın aynı gecikme payı tablo ve listeden iki kez söylenmez.
  const tablePlace = findings.find((item) => item.kind === 'overdueConcentration');
  return Object.freeze(findings.filter((item) => !(item.kind === 'overdueProjectShare' && tablePlace)).map((item) => Object.freeze(item)));
}

/* ── Anlatım ───────────────────────────────────────────────────────── */

const en = (locale) => locale === 'en';
const s = strongFact;

/** Göstergelerin adları (sayılar gövdenin tablosunda ve önermesinde söylenir; giriş aynı değerleri yinelemez). */
function indicatorList(metrics, locale) {
  const items = Object.keys(metrics).map((field) => INDICATORS[field][en(locale) ? 1 : 0]);
  return items.flatMap((item, index) => [...(index ? [index === items.length - 1 ? (en(locale) ? ' and ' : ' ve ') : ', '] : []), item]);
}
const ALL_OF = Object.freeze({ 2: 'ikisinde', 3: 'üçünde' });

/** Ad listesi; adı yazılmayan kalan varlıklar "ve N proje/kişi daha" ile söylenir. */
function namesList(names, locale, rest = 0, noun = ['proje', 'projects']) {
  const remainder = rest === 1 ? (noun[1] === 'people' ? 'person' : 'project') : noun[1];
  const items = [...names.map((name) => [s(name)]), ...(rest > 0 ? [en(locale) ? [s(formatCount(rest, locale)), ` more ${remainder}`] : [s(formatCount(rest, locale)), ` ${noun[0]} daha`]] : [])];
  return items.flatMap((item, index) => [...(index ? [index === items.length - 1 ? (en(locale) ? ' and ' : ' ve ') : ', '] : []), ...item]);
}

const COMPARED_LABELS = Object.freeze({
  overdue: { tr: ['gecikmiş görevlerde', 'gecikmiş görev', 'gecikmiş'], en: ['overdue tasks', 'overdue tasks', 'overdue'] },
  open: { tr: ['açık görevlerde', 'açık görev', 'açık'], en: ['open tasks', 'open tasks', 'open'] },
  dueNext7Days: { tr: ['önümüzdeki yedi günün teslimatlarında', 'önümüzdeki yedi günde terminli görev', 'önümüzdeki yedi günde terminli'],
    en: ['work due within seven days', 'tasks due within seven days', 'due-within-seven-days'] },
  done: { tr: ['tamamlanan görevlerde', 'tamamlanmış görev', 'tamamlanmış'], en: ['completed tasks', 'completed tasks', 'completed'] }
});

/** Karşılaştırılan öznenin yeri: "**X** projesinde", "**X** sorumluluğunda", "sizin sorumluluğunuzda" (ada ek getirilmez). */
function subjectPlace(subject, locale) {
  if (en(locale)) return subject.type === 'self' ? ['you have '] : subject.type === 'project' ? ['the ', s(subject.name), ' project has '] : [s(subject.name), ' has '];
  return subject.type === 'self' ? ['sizin sorumluluğunuzda '] : subject.type === 'project' ? [s(subject.name), ' projesinde '] : [s(subject.name), ' sorumluluğunda '];
}

/**
 * İki öznenin karşılaştırması: en büyük mutlak fark önce ve tam cümleyle ("… **A** projesinde **4**, **B** projesinde **6** açık görev
 * var."); en çok bir puanlık fark "birbirine yakın", sıfır fark "aynı" sayılır (sabit kural).
 */
function comparisonSentences(finding, locale) {
  const ordered = Object.entries(finding.metrics).map(([metric, values]) => ({ metric, values, gap: Math.abs(values[0] - values[1]) }))
    .sort((left, right) => right.gap - left.gap || COMPARED_TOTALS.indexOf(left.metric) - COMPARED_TOTALS.indexOf(right.metric));
  const label = (metric, form) => COMPARED_LABELS[metric][en(locale) ? 'en' : 'tr'][form];
  const people = finding.subjects.every((subject) => subject.type !== 'project');
  const [first, second] = finding.subjects;
  const withStates = (items, built) => ({ ...built, states: states(items) });
  const pair = (item) => en(locale)
    ? [...subjectPlace(first, locale), s(formatCount(item.values[0], locale)), ' and ', ...subjectPlace(second, locale), s(formatCount(item.values[1], locale)), ` ${label(item.metric, 1)}`]
    : [...subjectPlace(first, locale), s(formatCount(item.values[0], locale)), ', ', ...subjectPlace(second, locale), s(formatCount(item.values[1], locale)), ` ${label(item.metric, 1)} var`];
  const sentences = [];
  // Her cümle söylediği ölçüleri bildirir (iki öznenin kanıtı × ölçü): düzen aynı değeri ayrıntıda yinelemez.
  const states = (items) => Object.freeze(finding.evidenceIds.flatMap((evidenceId) => items.map((item) => Object.freeze({ evidenceId, metric: `tasks.${item.metric}` }))));
  const leads = ordered[0].gap > 0;
  if (leads) {
    sentences.push(withStates([ordered[0]], factSentence(en(locale)
      ? [`The clearest difference between the two ${people ? 'people' : 'projects'} is in ${label(ordered[0].metric, 0)}: `, ...pair(ordered[0]), '.']
      : [`İki ${people ? 'kişi' : 'proje'} arasındaki en belirgin fark ${label(ordered[0].metric, 0)}: `, ...pair(ordered[0]), '.'])));
  }
  const rest = leads ? ordered.slice(1, 3) : ordered.slice(0, 3);
  for (const item of rest.filter((entry) => entry.gap > 1)) {
    // "de/da" ünlü uyumu yerin son ünlüsünden (sabit sözlük değerleri; ad değil).
    const also = /[aıou][^aeıioöuü]*$/.test(label(item.metric, 0)) ? 'da' : 'de';
    sentences.push(withStates([item], factSentence(en(locale) ? [`There is also a clear gap in ${label(item.metric, 0)}: `, ...pair(item), '.'] : [`${label(item.metric, 0)} ${also} fark belirgin: `, ...pair(item), '.'])));
  }
  const close = rest.filter((item) => item.gap <= 1);
  if (close.length) {
    const clauses = close.flatMap((item, index) => [...(index ? [index === close.length - 1 ? (en(locale) ? ' and ' : ' ve ') : ', '] : []), label(item.metric, 2), ' (',
      s(formatCount(item.values[0], locale)), en(locale) ? ' and ' : ' ve ', s(formatCount(item.values[1], locale)), ')']);
    const same = close.every((item) => item.gap === 0);
    sentences.push(withStates(close, factSentence(en(locale)
      ? ['The ', ...clauses, ` task counts are ${same ? 'the same' : 'close'}.`]
      : [...clauses, ` görev sayıları ${leads ? 'ise ' : ''}${same ? `iki ${people ? 'kişide' : 'projede'} aynı` : 'birbirine yakın'}.`])));
  }
  return sentences;
}

function introSentences(findings, locale) {
  const out = [];
  const compared = findings.find((item) => item.kind === 'subjectComparison');
  if (compared) for (const built of comparisonSentences(compared, locale)) out.push({ finding: compared, ...built });
  const leader = findings.find((item) => item.kind === 'attentionLeader');
  if (leader) {
    const project = leader.entity.type === 'project';
    const all = ALL_OF[Object.keys(leader.metrics).length] || 'hepsinde';
    const many = Object.keys(leader.metrics).length > 1;
    out.push({ finding: leader, ...factSentence(en(locale)
      ? ['On the current indicators, ', ...(project ? [s(leader.entity.name), ' needs management attention first: it ranks first among the projects on '] : ['the work assigned to ', s(leader.entity.name),
        ' needs attention first: it ranks first among the listed people on ']), ...indicatorList(leader.metrics, locale), ' task counts', project ? '.' : ' (an assignment distribution, not a performance judgement).']
      : ['mevcut göstergelere göre yönetim dikkatini en çok ', s(leader.entity.name), project ? ' projesi gerektiriyor: ' : ' üzerindeki işler gerektiriyor: ', ...indicatorList(leader.metrics, locale),
        many ? ` iş sayılarının ${all} de ` : ' iş sayısında ', project ? 'projeler arasında ilk sırada.' : 'listelenen kişiler arasında ilk sırada (bu bir atama dağılımıdır; performans yargısı değildir).']) });
  }
  const concentration = findings.find((item) => item.kind === 'overdueConcentration' || item.kind === 'overdueProjectShare');
  if (concentration) {
    const same = leader && leader.entity.type === 'project' && leader.entity.key === concentration.entity.key;
    const { overdue, total, share } = concentration.metrics;
    out.push({ finding: concentration, ...factSentence(en(locale)
      ? [s(formatCount(overdue, locale)), ' of the ', s(formatCount(total, locale)), ' overdue tasks (', s(formatPercent(share, locale)), ') are concentrated in ', ...(same ? ['this project'] : [s(concentration.entity.name)]), '.']
      : ['Gecikmiş ', s(formatCount(total, locale)), ' görevin ', s(possessiveCount(overdue, locale)), ' (', s(formatPercent(share, locale)), ') ',
        ...(same ? ['bu projede toplanıyor.'] : [s(concentration.entity.name), ' projesinde toplanıyor.'])]) });
  }
  const both = findings.find((item) => item.kind === 'simultaneousPressure');
  if (both) {
    const { entities, population } = both.metrics;
    const project = both.entityType === 'project';
    const named = namesList(both.names, locale, entities - both.names.length, project ? ['proje', 'projects'] : ['kişi', 'people']);
    const subject = entities === population ? [project ? 'Every project carries' : 'Every listed person carries']
      : [s(formatCount(entities, locale)), project ? (entities === 1 ? ' project carries' : ' projects carry') : (entities === 1 ? ' person carries' : ' people carry')];
    out.push({ finding: both, ...factSentence(en(locale)
      ? [...subject, ' both overdue work and work due within seven days at the same time: ', ...named, '.']
      : [...(entities === population ? [project ? 'Projelerin tamamında' : 'Listelenen kişilerin tamamında'] : [s(formatCount(entities, locale)), project ? ' projede' : ' kişide']),
        ' hem gecikmiş hem de yedi gün içinde terminli iş aynı anda bulunuyor: ', ...named, '.']) });
  }
  const window = findings.find((item) => item.kind === 'windowPressure');
  if (window) {
    const { entities, population, dateFrom, dateTo, atLeast, shown } = window.metrics;
    const named = namesList(window.names, locale, entities - window.names.length);
    const from = s(formatFactDay(dateFrom, locale));
    const to = s(formatFactDay(dateTo, locale));
    out.push({ finding: window, ...factSentence(en(locale)
      ? [...(entities === population && !atLeast ? ['Every one of the ', s(formatCount(population, locale)), ' projects'] : [...(atLeast ? ['At least '] : []), s(formatCount(entities, locale)), ' of the ', s(formatCount(population, locale)), ' projects']),
        ' with deliveries between ', from, ' and ', to, ' also ', entities === 1 ? 'has' : 'have', ' overdue work today: ', ...named, '.']
      : [from, ' ile ', to, ' arasında teslimatı olan ', s(formatCount(population, locale)), ' projenin ', ...(atLeast ? ['en az '] : []),
        ...(entities === population && !atLeast ? ['tamamında'] : [s(`${formatCount(entities, locale)}${locativeCountSuffix(entities)}`)]), ' bugün gecikmiş iş de var: ', ...named, '.']) });
    // Kesik gecikmiş listesinin alt sınırı ayrı ve açıklayıcı bir cümledir (parantez içi teknik not değil).
    if (atLeast) {
      out.push({ finding: window, ...factSentence(en(locale)
        ? ['The overdue list is limited to the first ', s(formatCount(shown, locale)), ' tasks, so the real number may be higher.']
        : ['Gecikmiş listesi ilk ', s(formatCount(shown, locale)), ' görevle sınırlı olduğundan gerçek sayı daha yüksek olabilir.']) });
    }
  }
  return out;
}

function priorityItems(findings, locale, said) {
  const items = [];
  const longest = findings.find((item) => item.kind === 'longestOverdue');
  if (longest) {
    // Gövde en uzun gecikmeli görevi gün sayısıyla zaten söylediyse öncelik yalnızca adıyla anılır (değer yinelenmez).
    const detail = said(longest) ? [] : [' (', s(formatCount(longest.metrics.days, locale)), en(locale) ? ' days' : ' gün', ...(longest.project ? [', ', s(longest.project)] : []), ')'];
    items.push({ finding: longest, parts: [s(longest.entity.name), en(locale) ? ' — the longest-overdue task' : ' — en uzun süredir geciken görev', ...detail] });
  }
  const focus = findings.find((item) => item.kind === 'attentionLeader') || findings.find((item) => item.kind === 'overdueConcentration' || item.kind === 'overdueProjectShare');
  if (focus) {
    const project = focus.entity.type === 'project';
    const leader = focus.kind === 'attentionLeader';
    items.push({ finding: focus, parts: en(locale)
      ? [project ? 'Open work in ' : 'Open work assigned to ', s(focus.entity.name), leader ? ' — where the indicators are highest together' : ' — where the overdue work is concentrated']
      : [s(focus.entity.name), project ? ' projesindeki ' : ' üzerindeki ', leader ? 'açık işler — göstergelerin birlikte en yüksek olduğu ' : 'gecikmeler — gecikmiş işlerin toplandığı ',
        project ? 'proje' : 'kişi'] });
  }
  // Gecikmiş işin payı (en uzun gecikme yoksa): açık işlerin ne kadarının geciktiği.
  // Gövde aynı kanıtın açık ve gecikmiş sayısını zaten söylediyse pay öncelik olarak yinelenmez.
  const share = !longest && findings.find((item) => item.kind === 'overdueShare' && !said(item));
  if (share) {
    const { overdue, open, share: percent } = share.metrics;
    items.push({ finding: share, parts: en(locale)
      ? ['Overdue work — ', s(formatCount(overdue, locale)), ' of the ', s(formatCount(open, locale)), ' open tasks (', s(formatPercent(percent, locale)), ') are overdue']
      : ['Gecikmiş işler — açık ', s(formatCount(open, locale)), ' görevin ', s(possessiveCount(overdue, locale)), ' (', s(formatPercent(percent, locale)), ') gecikmiş'] });
  }
  // İki PROJENİN karşılaştırmasında gecikmiş işi daha fazla olan proje (fark varsa). Kişiler için yazılmaz: sayı farkı bir
  // kişiyi işaret eden yargı değildir (ilişki ≠ suçlama).
  const compared = !focus && findings.find((item) => item.kind === 'subjectComparison');
  if (compared && compared.subjects.every((subject) => subject.type === 'project') && compared.metrics.overdue && compared.metrics.overdue[0] !== compared.metrics.overdue[1]) {
    const index = compared.metrics.overdue[0] > compared.metrics.overdue[1] ? 0 : 1;
    // Gövde bu projenin gecikmiş sayısını söylediyse öncelik sayıyı yinelemez.
    const repeated = said({ kind: 'subjectOverdue', evidenceIds: [compared.evidenceIds[index]] });
    const count = repeated ? [] : [' (', s(formatCount(compared.metrics.overdue[index], locale)), en(locale) ? ' overdue tasks)' : ' gecikmiş görev)'];
    items.push({ finding: compared, parts: en(locale)
      ? [s(compared.subjects[index].name), ' — the project with more overdue work', ...count]
      : [s(compared.subjects[index].name), ' — gecikmiş işi daha fazla olan proje', ...count] });
  }
  const nearest = findings.find((item) => item.kind === 'nearestDelivery');
  if (nearest) {
    const date = s(formatFactDay(nearest.metrics.due, locale));
    items.push({ finding: nearest, parts: en(locale)
      ? (nearest.metrics.sole ? [s(nearest.entity.name), ' — the nearest delivery (', date, ')'] : [date, ' — the nearest due date (including ', s(nearest.entity.name), ')'])
      : (nearest.metrics.sole ? [s(nearest.entity.name), ' — en yakın teslim (', date, ')'] : [date, ' — en yakın teslim tarihi (', s(nearest.entity.name), ' dahil)']) });
  }
  return items.slice(0, FINDING_LIMITS.maxPriorities);
}

const evidenceOrder = (left, right) => Number(String(left).replace(/\D/g, '')) - Number(String(right).replace(/\D/g, '')) || String(left).localeCompare(String(right));
const evidenceOf = (entries) => [...new Set(entries.flatMap((entry) => entry.finding.evidenceIds))].sort(evidenceOrder);

/**
 * Bulguların anlatımı: giriş ve sonuç (en az bir kanıtlı öncelik).
 * Kısa yanıtta yalnızca girişin ilk cümlesi ve en önemli tek öncelik kalır. Bulgu yoksa ikisi de `null`dır.
 */
export function synthesisNarrative(findings, { locale = 'tr', detail = 'balanced', said = () => false } = {}) {
  const sentences = introSentences(findings, locale);
  const short = detail === 'short';
  const introShown = short ? sentences.slice(0, 1) : sentences;
  const intro = introShown.length ? Object.freeze({ markdown: introShown.map((item) => item.markdown).join(' '), plain: introShown.map((item) => item.plain).join(' '),
    evidenceIds: Object.freeze(evidenceOf(introShown)), states: Object.freeze(introShown.flatMap((item) => item.states || [])) }) : null;
  // Kısa yanıt da kapanır: yalnızca en önemli tek öncelikle.
  const items = short ? priorityItems(findings, locale, said).slice(0, 1) : priorityItems(findings, locale, said);
  // Sonuç, taranabilir numaralı bir öncelik listesidir ("konu — gerekçe"); her madde kendi kanıtını taşır.
  // Tek kanıtlı öncelik de sonuçtur (dolgu değildir): "Öne çıkan konu" satırı olarak yazılır.
  let conclusion = null;
  if (items.length >= 1) {
    const built = items.map((item) => Object.freeze({ ...factSentence(item.parts), evidenceIds: Object.freeze(evidenceOf([item])) }));
    const heading = items.length === 1 ? (en(locale) ? 'Key point' : 'Öne çıkan konu') : (en(locale) ? 'Priorities' : 'Öncelikli konular');
    conclusion = Object.freeze({ heading, items: Object.freeze(built),
      markdown: `**${heading}**\n\n${built.map((item, index) => `${index + 1}. ${item.markdown}`).join('\n')}`,
      plain: `${heading}: ${built.map((item) => item.plain).join('; ')}`, evidenceIds: Object.freeze(evidenceOf(items)) });
  }
  return Object.freeze({ intro, conclusion });
}

const ASPECTS = Object.freeze({
  overview: ['genel durum', 'overall status'], status: ['durum dağılımı', 'status breakdown'], priority: ['öncelikler', 'priorities'],
  deadlines: ['termin dağılımı', 'deadline spread'], overdue: ['gecikmeler', 'overdue work'], upcoming: ['yaklaşan teslimatlar', 'upcoming deliveries'],
  workload: ['iş yükü', 'workload'], projects: ['proje dağılımı', 'project spread'], schedule: ['aylara göre terminler', 'deadlines by month'], critical: ['kritik işler', 'critical work']
});
const TEAM_WORK = Object.freeze({ unit: ['biriminizin işleri', "your unit's work"], department: ['bölümünüzün işleri', "your department's work"],
  directorate: ['direktörlüğünüzün işleri', "your directorate's work"] });

/**
 * Bölümler arası bulgu girişi kurulamayan çok bölümlü özetin çerçeve cümlesi: neyin hangi açılardan ele alındığını söyler,
 * OLGU taşımaz (sayı, sıralama ya da yargı yoktur). Kapsam özetin kapsamından, adlar sunucunun çözdüğü öznelerdendir.
 */
export function framingSentence({ scope, level = null, focus = [], projects = [], people = [], locale = 'tr' } = {}) {
  const lang = en(locale) ? 1 : 0;
  const join = (names) => names.flatMap((name, index) => [...(index ? [index === names.length - 1 ? (lang ? ' and ' : ' ve ') : ', '] : []), s(name)]);
  const owner = scope === 'self' ? [lang ? 'your own work' : 'kendi işleriniz']
    : scope === 'team' ? [(TEAM_WORK[level] || ['ekibinizin işleri', "your team's work"])[lang]]
      // İki özne adıyla değil sayısıyla anılır: gövdenin gösterdiği özne sırası (takipteki "ilki") çerçeveyle çelişmez.
      : ['project', 'projects'].includes(scope) && projects.length > 1 ? [lang ? 'the work in the two projects' : 'iki projedeki işler']
        : ['project', 'projects'].includes(scope) && projects.length ? (lang ? ['the work in ', ...join(projects)] : [...join(projects), ' projesindeki işler'])
        : scope === 'projects' ? [lang ? 'the work in the projects you can see' : 'erişebildiğiniz projelerdeki işler']
          : scope === 'person' && people.length > 1 ? [lang ? "the two people's work" : 'iki kişinin işleri']
            : scope === 'person' && people.length ? (lang ? [...join(people), "'s work"] : [...join(people), ' sorumluluğundaki işler'])
            : scope === 'all' ? [lang ? 'all the work you can see' : 'görebildiğiniz bütün işler'] : null;
  const aspects = [...new Set(focus)].map((item) => ASPECTS[item]?.[lang]).filter(Boolean);
  if (!owner || !aspects.length) return null;
  const listed = aspects.flatMap((item, index) => [...(index ? [index === aspects.length - 1 ? (lang ? ' and ' : ' ve ') : ', '] : []), item]);
  const compared = projects.length > 1 || people.length > 1;
  return factSentence(lang ? ['Below, ', ...owner, compared ? ' is compared by ' : ' is summarised by ', ...listed, '.']
    : ['Aşağıda ', ...owner, ' ', ...listed, compared ? ' açısından karşılaştırılıyor.' : ' açısından özetleniyor.']);
}

const NEXT_STEPS = Object.freeze({
  workload: ['Belirli bir kişinin işlerini ayrıntılı görmek isterseniz adını yazmanız yeterli.', "If you want one person's work in detail, just name them."],
  projects: ['Bir projeyi ayrıntılı incelemek isterseniz adını yazmanız yeterli.', 'If you want to look at one project in detail, just name it.'],
  status: ['Belirli bir durumdaki görevleri listelememi isterseniz durumu yazmanız yeterli.', 'If you want the tasks in a given status listed, just name the status.'],
  deadlines: ['Gecikmiş ya da yaklaşan görevleri tek tek görmek isterseniz listeleyebilirim.', 'I can list the overdue or upcoming tasks one by one if you want.'],
  priority: ['Yüksek öncelikli görevleri tek tek görmek isterseniz listeleyebilirim.', 'I can list the high-priority tasks one by one if you want.'],
  critical: ['Kritik açık işleri tek tek görmek isterseniz listeleyebilirim.', 'I can list the critical open tasks one by one if you want.'],
  schedule: ['Belirli bir ayın teslimatlarını görmek isterseniz ayı yazmanız yeterli.', "If you want one month's deliveries, just name the month."]
});

/**
 * Kanıtlı öncelik kurulamayan çok bölümlü özetin kapanışı: ele alınan yönlerden birine uygun bir sonraki adım önerisi.
 * OLGU taşımaz; önerilen takip Bilgin'in mevcut okumalarıyla yanıtlanabilir (kişi/proje adı, durum, liste).
 */
export function nextStepSentence(focus = [], locale = 'tr') {
  const key = [...focus].reverse().find((item) => NEXT_STEPS[item]);
  const text = key ? NEXT_STEPS[key][en(locale) ? 1 : 0]
    : (en(locale) ? 'If you want any part of this in more detail, just ask.' : 'Herhangi bir bölümü daha ayrıntılı görmek isterseniz söylemeniz yeterli.');
  return Object.freeze({ markdown: text, plain: text });
}

/** Tek giriş noktası: bulgular ve anlatımları. */
export function analyticalSynthesis(parts, { locale = 'tr', detail = 'balanced' } = {}) {
  const findings = analyticalFindings(parts);
  return Object.freeze({ findings, ...synthesisNarrative(findings, { locale, detail }) });
}

