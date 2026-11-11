import { factSentence, formatCount, formatFactDay, formatPercent, locativeCountSuffix, possessiveCount, sharePercent, strongFact } from './groundedPropositions.js';
import { turkishPossessiveSuffix } from './evidenceNarrative.js';

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

export const FINDING_KINDS = Object.freeze(['subjectComparison', 'levelComparison', 'attentionLeader', 'openWorkLeader', 'overdueConcentration', 'simultaneousPressure', 'windowPressure',
  'overdueProjectShare', 'longestOverdue', 'nearestDelivery', 'overdueShare', 'workloadSpread', 'overdueLeader', 'overdueRateLeader', 'completionDespiteOverdue', 'volumeVsDelay',
  'milestoneStatus', 'orgSpread']);
/** İzin verilen yorumlar (kapalı küme): bulgunun anlatımı bu yorumun dışına çıkamaz. */
export const FINDING_INTERPRETATIONS = Object.freeze(['comparison', 'attention', 'concentration', 'simultaneous', 'priority', 'distribution', 'tradeoff', 'milestone']);
/**
 * `minRateOpen`: oran karşılaştırmasına giren varlığın en az açık görev sayısı (çok küçük paydalarda yüzde yanıltıcıdır).
 * `minCompletionTotal`: "tamamlanma yüksek" yargısı için en az görev sayısı; `maxTied`: eşitlikte adı yazılan en çok varlık.
 */
export const FINDING_LIMITS = Object.freeze({ maxNamed: 4, minConcentrationTotal: 3, minListRows: 3, maxPriorities: 3, minRateOpen: 3, minCompletionTotal: 4, maxTied: 3,
  maxParagraphSentences: 4 });

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
    fields: Object.freeze({ label: 'name', count: 'total', open: 'open', overdue: 'overdue', done: 'done' }) }),
  // Aşama G: sorumluların bölüm/birim grupları. Bir görev farklı birimlerde ayrı sayılabildiğinden pay ve yoğunlaşma
  // kurulmaz; yalnızca grup içi sayılar ve grup içi oranlar karşılaştırılır.
  ...['department', 'unit'].map((groupBy) => Object.freeze({ tool: 'rota_task_analytics', entity: groupBy, groupBy, pattern: /^data\.groups\.(\d+)\.(label|count|open|overdue|done)$/,
    fields: Object.freeze({ label: 'name', count: 'total', open: 'open', overdue: 'overdue', done: 'done' }) }))
]);
/** Atanamayan görevlerin özel grupları ve kesik tablonun "diğer" satırı varlık değildir. */
const NON_ENTITY_KEYS = new Set(['other', 'unassigned', 'unresolved', 'undisclosed', 'none', 'no_unit']);
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
        row.code ??= semantic.row?.projectCode || null;
        if (semantic.complete !== true) row.complete = false;
        const field = source.fields[match[2]];
        if (field === 'name') row.name = typeof fact.value === 'string' && fact.value.trim() ? fact.value : row.name;
        else row[field] = count(fact.value);
        if (source.groupBy && !row.name && typeof semantic.group?.label === 'string') row.name = semantic.group.label;
      }
      if (!rows.size) continue;
      const list = [...rows.values()];
      // Adaş varlık adı tek başına özne olamaz; doğrulanmış kod yoksa adlandırılmış bulgu kurulmaz.
      const ambiguous = list.filter((row) => list.some((other) => other !== row && other.name === row.name));
      for (const row of ambiguous) row.name = row.name && row.code && ambiguous.every((other) => other === row || other.code !== row.code) ? `${row.code} · ${row.name}` : null;
      const population = source.tool !== 'rota_workload_summary' || facts.some((fact) => fact.field === 'data.populationComplete' && fact.value === true);
      const complete = population && list.length >= 2 && list.every((row) => row.complete && row.name && row.key != null && !NON_ENTITY_KEYS.has(String(row.key))
        && row.size === list.length) && new Set(list.map((row) => String(row.key))).size === list.length;
      const sample = facts.find((fact) => fact.semantic?.provenance?.tool === source.tool)?.semantic;
      // Aşama G: örgütsel grupların nüfus toplamı (aynı kanıtın doğrulanmış toplamı); grup sayılarının toplamı bunu aşarsa gruplar örtüşür.
      const total = ['department', 'unit'].includes(source.entity) ? count(facts.find((fact) => fact.field === 'data.totals.total' && fact.semantic?.complete === true)?.value) : null;
      tables.push({ part, evidenceId, entity: source.entity, tool: source.tool, rows: list, complete, total, filters: sample?.filters || {}, today: sample?.provenance?.today || null });
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
    // Aşama G: açık kilometre taşları listesi (termine göre artan; gecikmişler önce) ayrı bir liste türüdür.
    const milestone = filters.milestone === true && statuses.length && statuses.every((status) => OPEN_STATUSES.has(status))
      && !filters.deadline && !filters.dateFrom && !filters.dateTo;
    const kind = milestone ? 'milestone' : filters.deadline === 'overdue' ? 'overdue'
      : statuses.length && statuses.every((status) => OPEN_STATUSES.has(status)) && upcoming ? 'upcoming' : null;
    if (!kind) continue;
    const rows = new Map();
    let complete = true;
    let size = null;
    for (const fact of facts) {
      if (fact.semantic?.provenance?.tool !== 'rota_task_search') continue;
      if (fact.semantic.complete !== true) complete = false;
      size ??= count(fact.semantic.row?.collectionSize);
      const match = /^data\.tasks\.(\d+)\.(title|overdueDays|targetFinish|project\.name)$/.exec(fact.field);
      if (!match) continue;
      const row = rows.get(match[1]) || { index: Number(match[1]), key: fact.semantic.row?.identity ?? null, projectId: fact.semantic.row?.projectId ?? null,
        projectCode: typeof fact.semantic.row?.projectCode === 'string' ? fact.semantic.row.projectCode.trim() : null };
      rows.set(match[1], row);
      row[{ title: 'title', overdueDays: 'days', targetFinish: 'due', 'project.name': 'project' }[match[2]]] = fact.value;
    }
    const list = [...rows.values()].filter((row) => typeof row.title === 'string').sort((left, right) => left.index - right.index);
    if (!list.length) continue;
    const total = count(facts.find((fact) => fact.field === 'totalCount')?.value);
    const whole = complete && total != null && total === list.length && rows.size === list.length;
    lists.push({ part, evidenceId, kind, rows: list, total, size, complete: whole, ranking, filters, today, self: filters.assignee === 'me' });
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
    if (both.length >= 2 || (both.length === 1 && !findings.some((item) => item.kind === 'attentionLeader' && item.entity.key === String(both[0].key)))) {
      findings.push({ kind: 'simultaneousPressure', interpretation: 'simultaneous', entity: null,
        metrics: { entities: both.length, population: rows.length }, names: both.slice(0, FINDING_LIMITS.maxNamed).map((row) => row.name), entityType: table.entity,
        comparison: { population: rows.length, basis: 'complete-table' }, evidenceIds: [table.evidenceId], completeness: 'complete' });
    }
  }
  const openLeader = uniqueTop(rows, 'open');
  if (openLeader && !findings.some((item) => item.kind === 'attentionLeader')) {
    findings.push({ kind: 'openWorkLeader', interpretation: 'priority', entity: { type: table.entity, name: openLeader.name, key: String(openLeader.key) },
      metrics: { open: openLeader.open }, comparison: { population: rows.length, basis: 'complete-table' }, evidenceIds: [table.evidenceId], completeness: 'complete' });
  }
  findings.push(...gTableFindings(table, findings));
  return findings.map((item) => ({ ...item, filters: table.filters, today: table.today }));
}

/** Eşitlikte en büyük değeri taşıyan satırlar (değer > 0, en çok `maxTied`); bütün satırlar değerliyse. */
function topRows(rows, field) {
  if (!rows.length || !rows.every((row) => count(row[field]) != null)) return [];
  const best = Math.max(...rows.map((row) => row[field]));
  if (best <= 0) return [];
  const top = rows.filter((row) => row[field] === best);
  return top.length <= FINDING_LIMITS.maxTied ? top : [];
}

/** Aşama G'nin tablo bulguları: aynı nüfusun yinelenen tablosundan bir kez kurulur. */
const G_TABLE_KINDS = new Set(['workloadSpread', 'overdueLeader', 'overdueRateLeader', 'completionDespiteOverdue', 'volumeVsDelay', 'orgSpread']);

/** a/b ile c/d'nin tam karşılaştırması (kayan nokta yok): pozitif → a/b büyük. */
const compareRatio = (a, b, c, d) => a * d - c * b;

/**
 * Aşama G — tam varlık tablosundan yönetim bulguları (bileşik puan yok; her bulgu adı verilen göstergelerle):
 *   - iş yükü yayılımı (tam ekip kadrosu): kişi başına açık görev aralığı ve görünür açık görevi olmayan üye sayısı; görev
 *     adedinin emek, büyüklük ya da boş kapasite olmadığı her zaman söylenir;
 *   - gecikmede ilk sıradaki kişi(ler): eşitlikte adlar birlikte, işlemsel dille (performans yargısı değil);
 *   - oran ile sayının ayrışması: en çok gecikmiş işi taşıyan varlık ile açık işine göre gecikme oranı en yüksek varlık farklıysa;
 *   - yüksek tamamlanmaya karşın süren gecikme (proje): görevlerin en az yarısı tamamlanmış ve gecikmiş işi olan projeler;
 *   - görev sayısı ≠ baskı (proje): daha çok açık işi olan projenin daha az gecikmesi (en belirgin çift).
 */
function gTableFindings(table, prior) {
  const findings = [];
  const { rows } = table;
  const base = { comparison: { population: rows.length, basis: 'complete-table' }, evidenceIds: [table.evidenceId], completeness: 'complete' };
  if (table.entity === 'person' && table.tool === 'rota_workload_summary' && rows.every((row) => count(row.open) != null)) {
    const opens = rows.map((row) => row.open);
    findings.push({ kind: 'workloadSpread', interpretation: 'distribution', entity: null, entityType: 'person', team: table.filters?.assignee === 'team', level: table.filters?.teamLevel || null,
      keys: rows.map((row) => String(row.key)).sort(),
      metrics: { people: rows.length, min: Math.min(...opens), max: Math.max(...opens), zero: opens.filter((value) => value === 0).length }, ...base });
  }
  // Gecikmede ilk sıradaki kişi(ler) ya da proje(ler): eşitlikte adlar birlikte. Projede dikkat önceliği (birden çok gösterge)
  // zaten kurulduysa yinelenmez; o zaman "en çok açık iş" bir öncelik gerekçesi olarak da kullanılmaz (görev adedi baskı değildir).
  const people = table.entity === 'person' && table.tool === 'rota_workload_summary';
  if ((people || table.entity === 'project') && rows.every((row) => count(row.overdue) != null)) {
    const leader = prior.find((item) => item.kind === 'attentionLeader');
    const top = topRows(rows, 'overdue');
    if (top.length && !(leader && (table.entity === 'project' || top.length === 1 && leader.entity.key === String(top[0].key)))) {
      findings.push({ kind: 'overdueLeader', interpretation: 'distribution', entityType: table.entity,
        entity: top.length === 1 ? { type: table.entity, name: top[0].name, key: String(top[0].key) } : null,
        names: top.map((row) => row.name), keys: top.map((row) => String(row.key).toLowerCase()), metrics: { overdue: top[0].overdue, tied: top.length }, ...base });
    }
  }
  if (['department', 'unit'].includes(table.entity) && rows.length >= 2 && rows.every((row) => count(row.open) != null && count(row.overdue) != null)) {
    // Örgütsel kırılımın özeti: grup sayısı, en çok açık ve en çok gecikmiş işi taşıyan grup(lar). Bir görev farklı birimlerdeki
    // sorumlularında ayrı sayılabildiğinden grup sayıları toplanmaz; bu kural her örgütsel kırılımda söylenir (`overlap` kanıtlanmış örtüşme).
    const open = topRows(rows, 'open');
    const late = topRows(rows, 'overdue');
    const totals = rows.map((row) => count(row.total) ?? (count(row.done) != null ? row.open + row.done : null));
    const overlap = table.total != null && totals.every((value) => value != null) && totals.reduce((sum, value) => sum + value, 0) > table.total;
    findings.push({ kind: 'orgSpread', interpretation: 'distribution', entity: null, entityType: table.entity, keys: rows.map((row) => String(row.key)).sort(),
      metrics: { groups: rows.length, open: open.length ? { names: open.map((row) => row.name), value: open[0].open } : null,
        overdue: late.length ? { names: late.map((row) => row.name), value: late[0].overdue } : null, overlap }, ...base });
  }
  if (['project', 'department', 'unit'].includes(table.entity) && rows.length >= 2 && rows.every((row) => count(row.open) != null && count(row.overdue) != null)) {
    // Oran karşılaştırması yalnızca en az `minRateOpen` açık görevi olan varlıklar arasındadır (küçük paydada yüzde yanıltıcıdır):
    // en çok gecikmiş işi taşıyan varlık da bu eşiği geçmelidir; eşiğin altında kalan varlık varsa anlatım bunu söyler.
    const eligible = rows.filter((row) => row.open >= FINDING_LIMITS.minRateOpen);
    const countLeader = uniqueTop(rows, 'overdue');
    if (eligible.length >= 2 && countLeader && countLeader.open >= FINDING_LIMITS.minRateOpen) {
      const best = eligible.reduce((top, row) => (compareRatio(row.overdue, row.open, top.overdue, top.open) > 0 ? row : top), eligible[0]);
      const top = eligible.filter((row) => compareRatio(row.overdue, row.open, best.overdue, best.open) === 0);
      if (best.overdue > 0 && top.length <= FINDING_LIMITS.maxTied && !top.some((row) => row.key === countLeader.key)) {
        findings.push({ kind: 'overdueRateLeader', interpretation: 'tradeoff', entity: null, entityType: table.entity, names: top.map((row) => row.name),
          keys: [...top.map((row) => String(row.key).toLowerCase()), String(countLeader.key).toLowerCase()],
          metrics: { overdue: best.overdue, open: best.open, share: sharePercent(best.overdue, best.open), tied: top.length, excluded: rows.length - eligible.length, minOpen: FINDING_LIMITS.minRateOpen,
            leader: { name: countLeader.name, overdue: countLeader.overdue, open: countLeader.open, share: countLeader.open ? sharePercent(countLeader.overdue, countLeader.open) : null } }, ...base });
      }
    }
  }
  if (table.entity === 'project' && rows.every((row) => count(row.open) != null && count(row.overdue) != null)) {
    if (rows.every((row) => count(row.done) != null)) {
      const despite = rows.filter((row) => row.open + row.done >= FINDING_LIMITS.minCompletionTotal && row.done * 2 >= row.open + row.done && row.overdue > 0)
        .map((row) => ({ name: row.name, key: String(row.key).toLowerCase(), overdue: row.overdue, share: sharePercent(row.done, row.open + row.done) }))
        .sort((left, right) => right.share - left.share || right.overdue - left.overdue || left.name.localeCompare(right.name, 'tr'));
      if (despite.length) {
        findings.push({ kind: 'completionDespiteOverdue', interpretation: 'tradeoff', entity: null, entityType: 'project', items: despite.slice(0, 2),
          keys: despite.map((item) => item.key), metrics: { entities: despite.length, values: despite.map((item) => [item.share, item.overdue]) }, ...base });
      }
    }
    if (rows.length >= 3) {
      let pair = null;
      for (const many of rows) for (const few of rows) {
        if (!(many.open > few.open && many.overdue < few.overdue)) continue;
        const score = [few.overdue - many.overdue, many.open - few.open];
        if (!pair || score[0] > pair.score[0] || score[0] === pair.score[0] && (score[1] > pair.score[1]
          || score[1] === pair.score[1] && `${many.name}|${few.name}`.localeCompare(`${pair.many.name}|${pair.few.name}`, 'tr') < 0)) pair = { many, few, score };
      }
      if (pair) {
        findings.push({ kind: 'volumeVsDelay', interpretation: 'tradeoff', entity: null, entityType: 'project', keys: [String(pair.many.key).toLowerCase(), String(pair.few.key).toLowerCase()],
          pair: [{ name: pair.many.name, open: pair.many.open, overdue: pair.many.overdue }, { name: pair.few.name, open: pair.few.open, overdue: pair.few.overdue }],
          metrics: { gap: pair.score[0] }, ...base });
      }
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
      findings.push({ kind: 'longestOverdue', interpretation: 'priority', entity: { type: 'task', name: head.title, ...(head.key != null ? { key: String(head.key) } : {}) },
        project: typeof head.project === 'string' ? head.project : null, projectId: head.projectId,
        duplicateTitle: list.rows.some((row) => row !== head && row.title === head.title),
        metrics: { days: head.days }, comparison: { population: list.total, basis: list.complete ? 'complete-list' : 'ranking-head' },
        evidenceIds: [list.evidenceId], completeness: list.complete ? 'complete' : 'ranking-head' });
    }
  }
  // Pay kimlikle hesaplanır; gecikmesiz adaş proje listede bulunmayabileceğinden anlatım doğrulanmış kodu da gerektirir.
  if (list.kind === 'overdue' && list.complete && list.rows.length >= FINDING_LIMITS.minListRows && list.rows.every((row) => row.projectId && typeof row.project === 'string')) {
    const projects = new Map();
    for (const row of list.rows) projects.set(row.projectId, { key: String(row.projectId).toLowerCase(), name: row.project, code: row.projectCode, count: (projects.get(row.projectId)?.count || 0) + 1 });
    const sorted = [...projects.values()].sort((left, right) => right.count - left.count);
    if (projects.size >= 2 && sorted[0].code && sorted.filter((row) => row.name === sorted[0].name && row.code === sorted[0].code).length === 1
      && sorted[0].count >= 2 && sorted[0].count > sorted[1].count && sorted[0].count * 2 >= list.rows.length) {
      findings.push({ kind: 'overdueProjectShare', interpretation: 'concentration', entity: { type: 'project', key: sorted[0].key, name: `${sorted[0].code} · ${sorted[0].name}` },
        metrics: { overdue: sorted[0].count, total: list.rows.length, share: sharePercent(sorted[0].count, list.rows.length) },
        comparison: { population: list.rows.length, basis: 'complete-list' }, evidenceIds: [list.evidenceId], completeness: 'complete' });
    }
  }
  if (list.kind === 'milestone' && rankedBy(list, 'task.targetFinish', 'asc') && list.today) {
    // Durum yalnızca TERMİNİ OLAN kilometre taşlarından kurulur; termini olmayan satır yargıya girmez ama durumu da gizlemez.
    // Sıra artan termindir ve termini olmayanlar sonda gelir: sayfada termini olmayan bir satır görünüyorsa ya da termini bugün
    // veya sonrası olan bir satır varsa, gecikmiş kilometre taşlarının tamamı sayfadadır (gecikmiş sayısı kesindir).
    const dated = list.rows.filter((row) => typeof row.due === 'string').sort((left, right) => left.due.localeCompare(right.due) || left.index - right.index);
    const shownUndated = list.rows.length - dated.length;
    const late = dated.filter((row) => row.due < list.today);
    const upcoming = dated.filter((row) => row.due >= list.today);
    const next = upcoming[0] || null;
    const exactLate = list.complete || Boolean(next) || shownUndated > 0;
    const worst = late.length && late.every((row) => count(row.days) != null) ? late.reduce((top, row) => (row.days > top.days ? row : top), late[0]) : null;
    // Termini olmayanların sayısı yalnızca kesinse söylenir: tam listede görünenler; ya da araç bütün açık kilometre taşlarını
    // döndürdüğü (sayfa = kesin toplam) ve sıralama sınırı dolmadığı hâlde termin sıralamasının bıraktığı satırlar.
    const fits = list.total != null && list.size === list.total && list.rows.length < Math.min(list.size, list.ranking?.limit ?? 0);
    const undated = list.complete ? shownUndated : fits ? list.size - dated.length : 0;
    if (dated.length || undated) {
      findings.push({ kind: 'milestoneStatus', interpretation: 'milestone', entity: null, project: null,
        metrics: { open: list.complete || fits ? list.total : null, dated: list.complete || fits ? list.total - undated : null, overdue: late.length, overdueExact: exactLate, shown: list.rows.length, undated,
          worst: worst ? { title: worst.title, days: worst.days, key: worst.key ?? null, projectId: worst.projectId ?? null, project: typeof worst.project === 'string' ? worst.project : null } : null,
          next: next ? { title: next.title, due: next.due, project: typeof next.project === 'string' ? next.project : null,
            sole: upcoming.filter((row) => row.due === next.due).length === 1 } : null },
        comparison: { population: list.total, basis: list.complete ? 'complete-list' : 'ranking-head' }, evidenceIds: [list.evidenceId],
        completeness: list.complete ? 'complete' : 'ranking-head' });
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
  return findings.map((item) => ({ ...item, filters: list.filters, today: list.today }));
}

/** Değeri olmayan (koşul koymayan) süzgeç alanı. */
const neutral = (value, key) => value == null || value === '' || value === 'any' || (value === false && key !== 'milestone') || (Array.isArray(value) && !value.length);
const COMPARED_TOTALS = Object.freeze(['overdue', 'open', 'dueNext7Days', 'done', 'total', 'critical']);
const SUBJECT_KEYS = new Set(['person', 'personSicil', 'project', 'projectId', 'assignee']);

/** Değer okumasının öznesi: kişi (sunucunun çözdüğü ad), oturum sahibinin kendisi ya da proje. Özne yoksa `null`. */
function subjectOf(filters) {
  if (filters.assignee === 'person' && filters.personSicil != null && typeof filters.person === 'string' && filters.person.trim() && filters.person.trim() !== 'Seçilen kişi') {
    return { type: 'person', key: `person:${filters.personSicil}`, name: filters.person.trim(), own: ['person', 'personSicil', 'assignee'] };
  }
  if (filters.assignee === 'me') return { type: 'self', key: 'self', name: null, own: ['assignee'] };
  if (filters.personSicil != null) return null;
  if (filters.projectId && typeof filters.project === 'string') return { type: 'project', key: `project:${String(filters.projectId).toLowerCase()}`, name: filters.project, own: ['project', 'projectId'] };
  return null;
}

/**
 * İki öznenin (kişi, kendisi ya da proje) AYNI nüfus tanımıyla okunmuş toplamlarının karşılaştırması. Yalnızca özne dışında
 * koşul taşımayan toplamlar ve aynı tarih/durum koşullarıyla okunan dönemli açık görev toplamları karşılaştırılır.
 * Ortak proje, gün ve bütün nüfus koşulları aynı kalmadan ölçüler birleşmez.
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
      const common = Object.entries(filters).filter(([key, value]) => !subject.own.includes(key) && !neutral(value, key) && key !== 'project');
      const windowed = match[1] === 'total' && (filters.dateFrom || filters.dateTo)
        && (!filters.dateField || filters.dateField === 'targetFinish')
        && filters.statuses?.length === 2 && filters.statuses.every((status) => OPEN_STATUSES.has(status));
      const critical = match[1] === 'total' && filters.statuses?.length === 2 && new Set(filters.statuses).size === 2
        && filters.statuses.every((status) => OPEN_STATUSES.has(status)) && filters.priorities?.length === 2
        && new Set(filters.priorities).size === 2 && filters.priorities.every((priority) => ['critical', 'high'].includes(priority))
        && (!filters.dateField || filters.dateField === 'targetFinish');
      const allowed = ['projectId', 'assignee', 'teamLevel', ...(windowed || critical ? ['dateFrom', 'dateTo', 'dateField', 'statuses'] : []), ...(critical ? ['priorities'] : [])];
      if (match[1] === 'total' && !windowed && !critical || common.some(([key]) => !allowed.includes(key))) continue;
      const base = JSON.stringify([fact.semantic.provenance.today, common.map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value])
        .sort(([left], [right]) => left.localeCompare(right))]);
      const metric = critical ? 'critical' : match[1];
      const key = `${metric}|${base}`;
      if (!metrics.has(key)) metrics.set(key, { metric, base, filters: Object.fromEntries(common), project: filters.project, subjects: new Map() });
      const entry = metrics.get(key);
      if (!entry.subjects.has(subject.key)) entry.subjects.set(subject.key, { ...subject, value: fact.value, evidenceId });
    }
  }
  const findings = new Map();
  for (const entry of [...metrics.values()].filter((item) => item.subjects.size === 2)) {
    const subjects = [...entry.subjects.values()];
    if (subjects.some((subject) => subject.type === 'project') && subjects.some((subject) => subject.type !== 'project')) continue;
    if (subjects[0].name && subjects[0].name === subjects[1].name) continue;
    const key = `${entry.base}|${subjects.map((subject) => subject.key).sort().join('|')}`;
    if (!findings.has(key)) findings.set(key, { kind: 'subjectComparison', interpretation: 'comparison', entity: null,
      subjects: subjects.map(({ type, name, key }) => ({ type, name, key })), metrics: {},
      filters: { ...entry.filters, ...(entry.filters.projectId && entry.project ? { project: entry.project } : {}) },
      comparison: { population: 2, basis: 'same-population' }, evidenceIds: [], completeness: 'complete' });
    const finding = findings.get(key);
    const pair = finding.subjects.map((subject) => entry.subjects.get(subject.key));
    finding.metrics[entry.metric] = pair.map((subject) => subject.value);
    finding.evidenceIds = [...new Set([...finding.evidenceIds, ...pair.map((subject) => subject.evidenceId)])];
  }
  return [...findings.values()];
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
    !['dateFrom', 'dateTo', 'dateField', 'deadline'].includes(key) && !neutral(value, key)).sort(([a], [b]) => a.localeCompare(b)));
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
      names: both.slice(0, FINDING_LIMITS.maxNamed).map((row) => {
        const name = names.get(String(row.key).toLowerCase());
        return name && table.rows.filter((other) => other.name === name || other.name.endsWith(` · ${name}`)).length === 1 ? name : row.name;
      }),
      filters: table.filters, today: table.today,
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
      filters: open.semantic.filters || {}, today: open.semantic.provenance?.today || null, evidenceIds: [evidenceId], completeness: 'complete' }];
  }
  return [];
}

/**
 * Aşama G — değer okumasının kurumsal kapsamı (çok kapsamlı özetin "katmanı"): kendi işleri, ekip (düzeyiyle), görünür bütün
 * işler, adlı kişi ya da adlı proje. Kapsam dışında hiçbir nüfus koşulu taşımayan okumalar katmandır; dönemli/süzgeçli okuma değildir.
 */
function layerOf(filters) {
  const extra = Object.entries(filters || {}).filter(([key, value]) => !['assignee', 'teamLevel', 'person', 'personSicil', 'project', 'projectId'].includes(key) && !neutral(value, key));
  if (extra.length) return null;
  // "any" sorumlu süzgeci değildir: görünür bütün işler.
  if (filters.assignee === 'any') return layerOf({ ...filters, assignee: undefined });
  if (filters.assignee === 'me' && !filters.projectId) return { key: 'self', type: 'self' };
  if (filters.assignee === 'team' && !filters.projectId) return { key: `team:${filters.teamLevel || ''}`, type: 'team', level: filters.teamLevel || null };
  if (filters.assignee === 'person' && filters.personSicil != null && typeof filters.person === 'string' && filters.person.trim() && filters.person.trim() !== 'Seçilen kişi' && !filters.projectId) {
    return { key: `person:${filters.personSicil}`, type: 'person', name: filters.person.trim() };
  }
  if (!filters.assignee && filters.personSicil == null && filters.projectId && typeof filters.project === 'string') return { key: `project:${String(filters.projectId).toLowerCase()}`, type: 'project', name: filters.project };
  if (!filters.assignee && filters.personSicil == null && !filters.projectId) return { key: 'all', type: 'all' };
  return null;
}

/**
 * Aşama G — çok kapsamlı karşılaştırma: aynı turda AYNI ölçülerle okunmuş en az iki kurumsal kapsam (en az biri ekip ya da
 * görünür bütün işler; iki kişinin/projenin karşılaştırması `subjectComparison`dır). Kapsamlar iç içe olabilir (birim ⊂ bölüm):
 * sayılar toplanmaz ve kapsamlar arası pay kurulmaz; yalnızca her kapsamın KENDİ nüfusundaki oranlar (açık işlerde gecikme,
 * doğrulanmış tamamlanma oranı) yan yana konur.
 */
function levelFindings(groups) {
  const layers = new Map();
  for (const { evidenceId, facts } of groups) {
    const totals = new Map();
    let filters = null;
    let today = null;
    for (const fact of facts) {
      if (fact.semantic?.provenance?.tool !== 'rota_task_analytics' || fact.semantic.complete !== true) continue;
      const match = /^data\.totals\.(open|overdue|done|total|completionRatePercent)$/.exec(fact.field);
      if (!match || (match[1] !== 'completionRatePercent' && count(fact.value) == null)) continue;
      totals.set(match[1], fact.value);
      filters ??= fact.semantic.filters || {};
      today ??= fact.semantic.provenance.today || null;
    }
    if (!totals.has('open') || !totals.has('overdue') || !filters) continue;
    const layer = layerOf(filters);
    if (!layer || layers.has(layer.key)) continue;
    // Görevi olmayan kapsamda tamamlanma oranı tanımsızdır ("%0" söylenmez).
    const empty = totals.get('total') === 0;
    layers.set(layer.key, { ...layer, evidenceId, today, open: totals.get('open'), overdue: totals.get('overdue'), done: totals.get('done') ?? null,
      completion: !empty && typeof totals.get('completionRatePercent') === 'number' && Number.isFinite(totals.get('completionRatePercent')) ? totals.get('completionRatePercent') : null });
  }
  const list = [...layers.values()];
  // İki adlı kişinin/projenin karşılaştırması `subjectComparison`dır; üç adlı kapsam (ör. üç kişi ya da üç proje) o yolla
  // karşılaştırılamaz: kapsam karşılaştırması olarak aynı tanımlı oranlarla kurulur (karşılaştırma sessizce düşmez).
  // İki kapsamdan biri adlı proje, diğeri kendi işleri ya da adlı kişi ise `subjectComparison` bu çifti karşılaştırmaz (proje ile
  // kişi nüfusları ayrı türdür): karşılaştırma burada aynı tanımlı oranlarla kurulur, sessizce düşmez.
  const mixed = list.length === 2 && list.some((layer) => layer.type === 'project') && list.some((layer) => ['self', 'person'].includes(layer.type));
  if (list.length < 2 || !(list.some((layer) => ['team', 'all'].includes(layer.type)) || list.length >= 3 || mixed) || new Set(list.map((layer) => layer.today)).size !== 1) return [];
  return [{ kind: 'levelComparison', interpretation: 'comparison', entity: null, layers: list, filters: {}, today: list[0].today,
    metrics: { layers: list.length }, comparison: { population: list.length, basis: 'same-definition' }, evidenceIds: list.map((layer) => layer.evidenceId), completeness: 'complete' }];
}

/** Turun doğrulanmış bölümlerinden yapılandırılmış bulgular (sıra: karşılaştırma, tablo, dönem baskısı, liste bulguları). */
export function analyticalFindings(parts) {
  const groups = byEvidence(Array.isArray(parts) ? parts : []);
  const tables = entityTables(groups);
  const lists = taskLists(groups);
  const leveled = levelFindings(groups);
  const compared = leveled.length ? [] : comparisonFindings(groups);
  const findings = [...leveled, ...compared, ...tables.flatMap(tableFindings), ...windowPressureFindings(tables, lists), ...lists.flatMap(listFindings),
    ...(compared.length || leveled.length ? [] : overdueShareFindings(groups))];
  // Aynı varlığın aynı gecikme payı tablo ve listeden iki kez söylenmez.
  const tablePlaces = findings.filter((item) => item.kind === 'overdueConcentration');
  const population = (filters) => JSON.stringify(Object.entries(filters || {}).filter(([key, value]) => key !== 'deadline' && !neutral(value, key))
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]).sort(([a], [b]) => a.localeCompare(b)));
  // Aşama G: aynı nüfusun iki tam tablosu (ör. portföy sıralaması ve projelere göre kırılım) aynı yönetim bulgusunu iki kez
  // üretemez; ilk tablonun (bildirim sırası) bulgusu kalır.
  const seenG = new Set();
  const unique = findings.filter((item) => {
    if (!G_TABLE_KINDS.has(item.kind)) return true;
    // Aynı varlıklar (görünen ad değil kimlik) ve aynı sayılar aynı iddiadır; farklı nüfusun farklı sayıları ayrı bulgudur.
    const key = JSON.stringify([item.kind, item.entityType || item.entity?.type || null, item.today, item.keys || null,
      JSON.parse(JSON.stringify(item.metrics || {}, (field, value) => (field === 'name' || field === 'title' ? undefined : value)))]);
    if (seenG.has(key)) return false;
    seenG.add(key);
    return true;
  });
  return Object.freeze(unique.filter((item) => !(item.kind === 'overdueProjectShare' && tablePlaces.some((place) => place.entity.key === item.entity.key
    && place.today === item.today && population(place.filters) === population(item.filters)))).map((item) => Object.freeze(item)));
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
  critical: { tr: ['kritik veya yüksek öncelikli açık görevlerde', 'kritik veya yüksek öncelikli açık görev', 'kritik veya yüksek öncelikli açık'],
    en: ['critical or high-priority open tasks', 'critical or high-priority open tasks', 'critical or high-priority open'] },
  total: { tr: ['dönemde terminli açık görevlerde', 'dönemde terminli açık görev', 'dönemde terminli açık'], en: ['open tasks due in the period', 'open tasks due in the period', 'open due in the period'] },
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

/** Bulgunun doğrulanmış kişi, proje ve dönem kısıtları; boşsa genel nüfus. */
export function findingScope(finding, locale = 'tr') {
  const filters = finding.filters || {};
  const parts = [filters.assignee === 'me' ? (en(locale) ? 'your work' : 'kendi işleriniz')
    : filters.assignee === 'team' ? (TEAM_WORK[filters.teamLevel] || ['ekibinizin işleri', "your team's work"])[en(locale) ? 1 : 0]
    : filters.person && filters.person !== 'Seçilen kişi' ? filters.person : null,
    filters.projectId ? filters.project : null,
    filters.priorities?.length ? (en(locale) ? 'priority: ' : 'öncelik: ') + filters.priorities.map((priority) =>
      ({ critical: ['kritik', 'critical'], high: ['yüksek', 'high'], medium: ['orta', 'medium'], low: ['düşük', 'low'] })[priority]?.[en(locale) ? 1 : 0] || priority).join(', ') : null,
    finding.kind !== 'windowPressure' && (filters.dateFrom || filters.dateTo) ? [filters.dateFrom ? formatFactDay(filters.dateFrom, locale) : '…', filters.dateTo ? formatFactDay(filters.dateTo, locale) : '…'].join(' – ') : null].filter(Boolean);
  return parts.join(' · ');
}

/**
 * Aşama G: girişi açan bulgu, modelin bildirdiği analitik yönlerden (türlü karar, cümle yorumu değil) gelir: durum dağılımı
 * soruluyorsa "tamamlanmaya karşın gecikme", kilometre taşları soruluyorsa kilometre taşı durumu, iş yükü soruluyorsa yayılım.
 * Bulgu kümesi değişmez; yalnızca sıra.
 */
const LEADING_KINDS = Object.freeze({ milestones: ['milestoneStatus'], status: ['completionDespiteOverdue'], workload: ['workloadSpread', 'overdueLeader'], org: ['orgSpread', 'attentionLeader', 'overdueRateLeader'],
  projects: ['attentionLeader', 'overdueLeader', 'overdueConcentration'] });

/**
 * Girişi açan bulgu öne alınır. Çok kapsamlı yanıtta asıl soru kapsamların karşılaştırmasıdır: kapsam karşılaştırması her zaman
 * açar. Sıra, kapsam gruplamasından ÖNCE kurulur; böylece açan bulgunun kapsamı ilk grup olur ve kendi doğal girişini taşır.
 */
function leadFirst(out, findings, focus) {
  // Karşılaştırma sorusunda (iki özne ya da birden çok kapsam) asıl yanıt karşılaştırmanın kendisidir; diğer bulgular onu izler.
  const compared = ['levelComparison', 'subjectComparison'].find((kind) => findings.some((item) => item.kind === kind));
  const leading = compared ? [compared] : focus.flatMap((item) => LEADING_KINDS[item] || []);
  const first = leading.map((kind) => out.find((item) => item.finding.kind === kind)).find(Boolean);
  if (!first) return out;
  return [...out.filter((item) => item.finding === first.finding), ...out.filter((item) => item.finding !== first.finding)];
}

function introSentences(findings, locale, focus = []) {
  return introOrder(findings, locale, focus);
}

function introOrder(findings, locale, focus = []) {
  let out = [];
  for (const compared of findings.filter((item) => item.kind === 'subjectComparison')) {
    for (const built of comparisonSentences(compared, locale)) out.push({ finding: compared, ...built });
  }
  for (const level of findings.filter((item) => item.kind === 'levelComparison')) {
    for (const built of levelSentences(level, locale)) out.push({ finding: level, ...built });
  }
  const leader = findings.find((item) => item.kind === 'attentionLeader');
  // Aşama G: dikkat önceliğindeki projede gecikme yoğunlaşması da varsa aynı cümlenin devamıdır ("…ilk sırada; gecikmiş **10**
  // görevin **5'i** (**%50**) de bu projede toplanıyor."); "bu projede" ayrı kısa cümleye düşmez.
  const sameAsLeader = (concentration) => leader && leader.entity.type === 'project' && leader.entity.key === concentration.entity.key && leader.evidenceIds[0] === concentration.evidenceIds[0];
  const joined = leader && findings.find((item) => item.kind === 'overdueConcentration' && sameAsLeader(item));
  if (leader) {
    const project = leader.entity.type === 'project';
    const org = ORG_WORDS[leader.entity.type];
    const all = ALL_OF[Object.keys(leader.metrics).length] || 'hepsinde';
    const many = Object.keys(leader.metrics).length > 1;
    const tail = joined ? (en(locale)
      ? [', and ', s(formatCount(joined.metrics.overdue, locale)), ' of the ', s(formatCount(joined.metrics.total, locale)), ' overdue tasks (', s(formatPercent(joined.metrics.share, locale)), ') are concentrated there']
      : ['; gecikmiş ', s(formatCount(joined.metrics.total, locale)), ' görevin ', s(possessiveCount(joined.metrics.overdue, locale)), ' (', s(formatPercent(joined.metrics.share, locale)), ') de bu projede toplanıyor']) : [];
    out.push({ finding: leader, ...factSentence(en(locale)
      ? ['On the current indicators, ', ...(project ? [s(leader.entity.name), ' needs management attention first: it ranks first among the projects on ']
        : org ? [s(leader.entity.name), ` (${org.en}) needs management attention first: it ranks first among the ${org.enPlural} on `] : ['the work assigned to ', s(leader.entity.name),
          ' needs attention first: it ranks first among the listed people on ']), ...indicatorList(leader.metrics, locale), ' task counts', ...tail, project || org ? '.' : ' (an assignment distribution, not a performance judgement).']
      : ['mevcut göstergelere göre yönetim dikkatini en çok ', s(leader.entity.name), project ? ' projesi gerektiriyor: ' : org ? ` ${org.one} gerektiriyor: ` : ' üzerindeki işler gerektiriyor: ',
        ...indicatorList(leader.metrics, locale), many ? ` iş sayılarının ${all} de ` : ' iş sayısında ',
        project ? 'projeler arasında ilk sırada' : org ? `${org.among} arasında ilk sırada` : 'listelenen kişiler arasında ilk sırada (bu bir atama dağılımıdır; performans yargısı değildir)', ...tail, '.']) });
  }
  for (const concentration of findings.filter((item) => item.kind === 'overdueConcentration' || item.kind === 'overdueProjectShare')) {
    if (concentration === joined) continue;
    const same = sameAsLeader(concentration);
    const { overdue, total, share } = concentration.metrics;
    out.push({ finding: concentration, ...factSentence(en(locale)
      ? [s(formatCount(overdue, locale)), ' of the ', s(formatCount(total, locale)), ' overdue tasks (', s(formatPercent(share, locale)), ') are concentrated in ', ...(same ? ['this project'] : [s(concentration.entity.name)]), '.']
      : ['Gecikmiş ', s(formatCount(total, locale)), ' görevin ', s(possessiveCount(overdue, locale)), ' (', s(formatPercent(share, locale)), ') ',
        ...(same ? ['bu projede toplanıyor.'] : [s(concentration.entity.name), ' projesinde toplanıyor.'])]) });
  }
  out.push(...gIntroSentences(findings, locale));
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
  out = leadFirst(out, findings, focus);
  // Aşama G: bütün bulgular tek kapsamı paylaşıyorsa kapsam bir kez, ilk cümlenin doğal girişiyle söylenir ("Ekibinizin işlerine
  // bakıldığında, …"); her cümlenin başına aynı "**X**:" etiketi yazılmaz. Karışık kapsamda her cümle kendi kapsamını taşır.
  if (sharedScopeLead(findings, locale)) return out;
  // Aşama G: karışık kapsamda aynı kapsamın cümleleri ardışık gelir ve kapsam bir kez, ilk cümlenin doğal girişiyle söylenir
  // ("Bölümünüzün işlerine bakıldığında, …"); doğal girişi kurulamayan kapsam "**X**:" etiketini ilk cümlede taşır.
  const order = [];
  for (const item of out) {
    const scope = findingScope(item.finding, locale);
    if (!order.includes(scope)) order.push(scope);
  }
  const grouped = order.flatMap((scope) => out.filter((item) => findingScope(item.finding, locale) === scope));
  let previous = null;
  return grouped.map((item) => {
    const scope = findingScope(item.finding, locale);
    const first = scope !== previous;
    previous = scope;
    // Kapsam grubu ayrı analiz paragrafıdır (anlatımda kapsamlar birbirine karışmaz).
    if (!scope || !first) return { ...item, group: scope || '' };
    const lead = sharedScopeLead([item.finding], locale);
    return { ...item, group: scope, ...(lead ? factSentence([...lead, ...lowerFirst(item.parts, locale)]) : factSentence([s(scope), ': ', ...item.parts])) };
  });
}

/** Ortak kapsamın doğal girişi sıralanmış ilk cümleye eklenir. */
function withScopeLead(sentences, findings, locale) {
  const lead = sharedScopeLead(findings, locale);
  if (!lead || !sentences.length) return sentences;
  return sentences.map((item, index) => (index === 0 ? { ...item, ...factSentence([...lead, ...lowerFirst(item.parts, locale)]) } : item));
}

/** Sunucu metniyle başlayan cümle parçalarının ilk harfi girişten sonra küçülür (veri adı değişmez). */
function lowerFirst(parts, locale) {
  const [head, ...rest] = parts;
  return typeof head === 'string' && head ? [`${head.charAt(0).toLocaleLowerCase(en(locale) ? 'en-US' : 'tr-TR')}${head.slice(1)}`, ...rest] : parts;
}

const OWNER_PLACES = Object.freeze({ me: ['Kendi işlerinizde', 'In your own work'], team: ['Ekibinizde', 'In your team'], unit: ['Biriminizde', 'In your unit'],
  department: ['Bölümünüzde', 'In your department'], directorate: ['Direktörlüğünüzde', 'In your directorate'] });

/** Yalnızca sahip (kendi/ekip düzeyi) kapsamının doğal yer adı; proje, kişi, dönem ya da öncelik taşıyan kapsamda `null`. */
function ownerPlace(filters, locale) {
  if (filters.projectId || filters.personSicil != null || filters.dateFrom || filters.dateTo || filters.priorities?.length) return null;
  const owner = filters.assignee === 'me' ? OWNER_PLACES.me : filters.assignee === 'team' ? OWNER_PLACES[filters.teamLevel] || OWNER_PLACES.team : null;
  return owner ? owner[en(locale) ? 1 : 0] : null;
}

const OWNER_LEADS = Object.freeze({ me: ['Kendi işlerinize', 'In your own work'], team: ['Ekibinizin işlerine', "In your team's work"], unit: ['Biriminizin işlerine', "In your unit's work"],
  department: ['Bölümünüzün işlerine', "In your department's work"], directorate: ['Direktörlüğünüzün işlerine', "In your directorate's work"] });

/**
 * Bütün bulguların ortak ve yalnızca sahip/proje/dönem içeren kapsamının doğal girişi; ortak kapsam yoksa ya da öncelik gibi başka
 * koşul taşıyorsa `null` (eski etiketli biçim kalır). Giriş olgu değildir; kapsamı adlandırır.
 */
function sharedScopeLead(findings, locale) {
  if (!findings.length) return null;
  const scopes = new Set(findings.map((finding) => findingScope(finding, locale)));
  if (scopes.size !== 1 || ![...scopes][0]) return null;
  const filters = findings.find((finding) => finding.kind !== 'windowPressure')?.filters || findings[0].filters || {};
  if (filters.priorities?.length) return null;
  const lang = en(locale) ? 1 : 0;
  const owner = filters.assignee === 'me' ? OWNER_LEADS.me : filters.assignee === 'team' ? OWNER_LEADS[filters.teamLevel] || OWNER_LEADS.team : null;
  const person = !owner && filters.person && filters.person !== 'Seçilen kişi' ? filters.person : null;
  const project = filters.projectId && typeof filters.project === 'string' ? filters.project : null;
  const windowed = findings.some((finding) => finding.kind !== 'windowPressure') && (filters.dateFrom || filters.dateTo)
    ? [filters.dateFrom ? formatFactDay(filters.dateFrom, locale) : '…', filters.dateTo ? formatFactDay(filters.dateTo, locale) : '…'].join(' – ') : null;
  const inProject = project && (owner || person);
  const tail = lang ? [...(inProject ? [' in ', s(project)] : []), ...(windowed ? [' (', s(windowed), ')'] : [])]
    : inProject || windowed ? [' (', ...(inProject ? [s(project), ' projesi'] : []), ...(inProject && windowed ? [', '] : []), ...(windowed ? [s(windowed)] : []), ')'] : [];
  if (owner) return lang ? [owner[1], ...tail, ', '] : [owner[0], ...tail, ' bakıldığında, '];
  if (person) return lang ? ['In ', s(person), "'s work", ...tail, ', '] : [s(person), ' sorumluluğundaki işlere', ...tail, ' bakıldığında, '];
  if (project) return lang ? ['In the ', s(project), ' project', ...(windowed ? [' (', s(windowed), ')'] : []), ', '] : [s(project), ' projesine', ...(windowed ? [' (', s(windowed), ')'] : []), ' bakıldığında, '];
  return null;
}

const TEAM_IN = Object.freeze({ unit: 'Biriminizdeki', department: 'Bölümünüzdeki', directorate: 'Direktörlüğünüzdeki' });
const ORG_WORDS = Object.freeze({ department: { one: 'bölümü', noun: 'bölüm', inside: 'bölümündeki', among: 'bölümler', en: 'department', enPlural: 'departments' },
  unit: { one: 'birimi', noun: 'birim', inside: 'birimindeki', among: 'birimler', en: 'unit', enPlural: 'units' } });
/** Varlık türünün yer eki ("projesinde", "bölümünde", "biriminde"); ada ek getirilmez. */
const entityPlace = (type, locale) => (en(locale) ? { project: ' project', department: ' department', unit: ' unit' }[type] || ''
  : { project: ' projesinde', department: ' bölümünde', unit: ' biriminde' }[type] || '');
/** Çoğul yer eki ("projelerinde", "bölümlerinde", "birimlerinde"). */
const entityPlaces = (type) => ({ project: ' projelerinde', department: ' bölümlerinde', unit: ' birimlerinde' }[type] || '');
/** "%60'ı": yüzde ve iyelik eki (sayının okunuşuna göre). */
const percentOf = (value, locale) => (en(locale) ? formatPercent(value, locale) : `${formatPercent(value, locale)}${Number.isInteger(value) ? turkishPossessiveSuffix(value) : "'i"}`);
const LEVEL_PLACES = Object.freeze({ self: ['kendi işlerinizde', 'in your own work'], 'team:': ['ekibinizde', 'in your team'], 'team:unit': ['biriminizde', 'in your unit'],
  'team:department': ['bölümünüzde', 'in your department'], 'team:directorate': ['direktörlüğünüzde', 'in your directorate'], all: ['görebildiğiniz bütün işlerde', 'across all the work you can see'] });
const LEVEL_LABELS = Object.freeze({ self: ['Kendi işleriniz', 'Your work'], 'team:': ['Ekibiniz', 'Your team'], 'team:unit': ['Biriminiz', 'Your unit'], 'team:department': ['Bölümünüz', 'Your department'],
  'team:directorate': ['Direktörlüğünüz', 'Your directorate'], all: ['Bütün görünür işler', 'All visible work'] });

/** Katmanın yer adı: "biriminizde", "**X** projesinde", "**X** sorumluluğundaki işlerde". */
function layerPlace(layer, locale) {
  if (layer.type === 'person') return en(locale) ? ['in ', s(layer.name), "'s work"] : [s(layer.name), ' sorumluluğundaki işlerde'];
  if (layer.type === 'project') return en(locale) ? ['in the ', s(layer.name), ' project'] : [s(layer.name), ' projesinde'];
  return [(LEVEL_PLACES[layer.key] || LEVEL_PLACES.all)[en(locale) ? 1 : 0]];
}

/** Grafik ve öncelik için katmanın kısa adı (veri adı ya da sunucu adı). */
export function layerLabel(layer, locale = 'tr') {
  if (layer.type === 'person' || layer.type === 'project') return layer.name;
  return (LEVEL_LABELS[layer.key] || LEVEL_LABELS.all)[en(locale) ? 1 : 0];
}

const joinParts = (items, locale) => items.flatMap((item, index) => [...(index ? [index === items.length - 1 ? (en(locale) ? ' and ' : ' ve ') : ', '] : []), ...item]);

/** Çok kapsamlı karşılaştırmanın cümleleri: gecikme oranı, doğrulanmış tamamlanma oranı ve iç içe kapsam uyarısı. */
function levelSentences(finding, locale) {
  const out = [];
  const rated = finding.layers.filter((layer) => layer.open > 0).map((layer) => ({ layer, share: sharePercent(layer.overdue, layer.open) }));
  if (rated.length >= 2) {
    const best = rated.reduce((top, item) => (compareRatio(item.layer.overdue, item.layer.open, top.layer.overdue, top.layer.open) > 0 ? item : top), rated[0]);
    const top = rated.filter((item) => compareRatio(item.layer.overdue, item.layer.open, best.layer.overdue, best.layer.open) === 0);
    const rest = rated.filter((item) => !top.includes(item));
    if (!rest.length) {
      const places = joinParts(rated.map((item) => layerPlace(item.layer, locale)), locale);
      out.push(factSentence(en(locale) ? ['The share of open work that is overdue is the same ', ...places, ' (', s(formatPercent(best.share, locale)), ').']
        : ['Açık işlerde gecikme oranı ', ...places, ' aynı (', s(formatPercent(best.share, locale)), ').']));
    } else if (best.layer.overdue === 0) {
      out.push(factSentence(en(locale) ? ['None of the compared scopes has overdue open work.'] : ['Karşılaştırılan kapsamların hiçbirinde gecikmiş açık iş yok.']));
    } else {
      // Giriş kapsamları ORANLA karşılaştırır; açık ve gecikmiş sayıları her kapsamın kendi bölümünde bir kez söylenir (yinelenmez).
      const head = top.length === 1
        ? (en(locale) ? ['The share of open work that is overdue is highest ', ...layerPlace(best.layer, locale), ' (', s(formatPercent(best.share, locale)), ')']
          : ['Açık işlerde gecikme oranı en yüksek ', ...layerPlace(best.layer, locale), ' (', s(formatPercent(best.share, locale)), ')'])
        : (en(locale) ? ['The share of open work that is overdue is highest, at ', s(formatPercent(best.share, locale)), ', ', ...joinParts(top.map((item) => layerPlace(item.layer, locale)), locale)]
          : ['Açık işlerde gecikme oranı en yüksek ', ...joinParts(top.map((item) => layerPlace(item.layer, locale)), locale), ' (', s(formatPercent(best.share, locale)), ')']);
      const tail = rest.map((item) => [...layerPlace(item.layer, locale), ' ', s(formatPercent(item.share, locale))]);
      out.push(factSentence([...head, en(locale) ? '; it is ' : '; bu oran ', ...joinParts(tail, locale), '.']));
    }
  }
  // Açık işi olmayan kapsamda gecikme oranı tanımsızdır: yüzdeye katılmaz ama karşılaştırmadan sessizce de düşmez.
  const unrated = finding.layers.filter((layer) => layer.open === 0);
  if (unrated.length && finding.layers.length > unrated.length) {
    const places = joinParts(unrated.map((layer) => layerPlace(layer, locale)), locale);
    out.push(factSentence(en(locale) ? ['There is no open work ', ...places, ', so no overdue share is compared there.']
      : [...places, ' açık iş olmadığından gecikme oranı karşılaştırılmadı.']));
  } else if (unrated.length) {
    // Bütün kapsamlarda açık iş yoksa karşılaştırmanın tek sonucu budur; söylenmezse yanıt durumu hiç bildirmez.
    out.push(factSentence(en(locale) ? ['None of the compared scopes has open work, so no overdue share is compared.']
      : ['Karşılaştırılan kapsamların hiçbirinde açık iş olmadığından gecikme oranı karşılaştırılmadı.']));
  }
  const completed = finding.layers.filter((layer) => layer.completion != null);
  if (completed.length >= 2) {
    // Söylem belleği: kapsamların tamamlanma oranı girişte söylendi; kapsam bölümlerinin toplam ayrıntısında yinelenmez.
    out.push({ ...factSentence([en(locale) ? 'The completion rate is ' : 'Tamamlanma oranı ', ...joinParts(completed.map((layer) => [...layerPlace(layer, locale), ' ', s(formatPercent(Math.round(layer.completion), locale))]), locale), '.']),
      states: Object.freeze(completed.map((layer) => Object.freeze({ evidenceId: layer.evidenceId, metric: 'tasks.completionRatePercent' }))) });
  }
  // Her sayı kendi kapsamının doğrulanmış olgusudur; kapsamlar iç içe olabildiğinden toplanmaz (olgu taşımayan sunucu cümlesi).
  // Örnek, karşılaştırılan kapsamların kendisinden kurulur (dar kapsam geniş kapsamın içinde); iç içe çift yoksa ortak sorumluluk.
  out.push(factSentence([overlapNote(finding.layers, locale)]));
  return out;
}

const SCOPE_RANK = Object.freeze({ self: 0, 'team:unit': 1, 'team:department': 2, 'team:directorate': 3, 'team:': 3, all: 4 });
const SCOPE_WORK = Object.freeze({ self: ['kendi işleriniz', 'your own work'], 'team:unit': ['biriminizin işleri', "your unit's work"], 'team:department': ['bölümünüzün işleri', "your department's work"],
  'team:directorate': ['direktörlüğünüzün işleri', "your directorate's work"], 'team:': ['ekibinizin işleri', "your team's work"] });
const SCOPE_WITHIN = Object.freeze({ 'team:department': ['bölümünüzün sayılarında da', 'your department'], 'team:directorate': ['direktörlüğünüzün sayılarında da', 'your directorate'],
  'team:': ['ekibinizin sayılarında da', 'your team'], all: ['görebildiğiniz bütün işlerin içinde de', 'all the work you can see'] });

/** İç içe kapsam uyarısı: karşılaştırılan en dar ve en geniş kapsamdan kurulan örnekle. */
function overlapNote(layers, locale) {
  const lang0 = en(locale) ? 1 : 0;
  // Kendi işleri ya da adlı kişi ile adlı proje (ekip/bütün işler yok): kişinin işleri projede de yer alabilir. Bu dal yalnızca
  // kişi/proje dalından ÖNCE gelir; yoksa kişi + proje karşılaştırması ortak sorumlu çekincesiyle açıklanırdı.
  if (layers.some((layer) => layer.type === 'project') && layers.some((layer) => layer.type !== 'project') && !layers.some((layer) => ['team', 'all'].includes(layer.type))) {
    return ['These scopes can overlap (a task can belong to both the person\'s work and the project), so their counts are not added together; only rates computed the same way are compared.',
      'Bu kapsamlar örtüşebildiğinden (bir görev hem kişinin işlerinde hem projede yer alabilir) sayılar toplanmaz; yalnızca aynı tanımla hesaplanan oranlar yan yana konur.'][en(locale) ? 0 : 1];
  }
  // Yalnızca adlı kişi/proje kapsamları: kişiler ortak sorumlu oldukları görevde ayrı sayılır; projeler ayrıktır ama yine yalnızca oranlar yan yana konur.
  if (layers.every((layer) => ['person', 'project'].includes(layer.type))) {
    return layers.some((layer) => layer.type === 'person')
      ? ['A task with several assignees is counted for each of them, so these counts are not added together; only rates computed the same way are compared.',
        'Birden çok sorumlusu olan bir görev her kişide ayrı sayılabildiğinden sayılar toplanmaz; yalnızca aynı tanımla hesaplanan oranlar yan yana konur.'][lang0 ? 0 : 1]
      : ['Only rates computed the same way are compared; the scopes are not combined into a total.', 'Yalnızca aynı tanımla hesaplanan oranlar yan yana konur; kapsamlar tek bir toplamda birleştirilmez.'][lang0 ? 0 : 1];
  }
  const ranked = layers.filter((layer) => Object.hasOwn(SCOPE_RANK, layer.key)).sort((left, right) => SCOPE_RANK[left.key] - SCOPE_RANK[right.key]);
  const wide = ranked.at(-1);
  // Kendi işleri ekip kapsamının parçası değildir (ekip okuması kullanıcının kendisini dışlar); bu çiftte örtüşme ortak sorumluluktur.
  const narrow = ranked.find((layer) => layer !== wide && SCOPE_RANK[layer.key] < SCOPE_RANK[wide.key] && (layer.key !== 'self' || wide.key === 'all'));
  const lang = en(locale) ? 1 : 0;
  if (narrow && SCOPE_WITHIN[wide.key]) {
    return lang ? `These scopes can overlap (for example, ${SCOPE_WORK[narrow.key][1]} is also counted in ${SCOPE_WITHIN[wide.key][1]}), so their counts are not added together; only rates computed the same way are compared.`
      : `Bu kapsamlar iç içe olabildiğinden (ör. ${SCOPE_WORK[narrow.key][0]} ${SCOPE_WITHIN[wide.key][0]} yer alır) sayılar toplanmaz; yalnızca aynı tanımla hesaplanan oranlar yan yana konur.`;
  }
  return lang ? 'A task you share with a team member can be counted in both scopes, so their counts are not added together; only rates computed the same way are compared.'
    : 'Ekibinizden biriyle ortak sorumlu olduğunuz bir görev iki kapsamda da sayılabildiğinden sayılar toplanmaz; yalnızca aynı tanımla hesaplanan oranlar yan yana konur.';
}

/** Aşama G bulgularının giriş cümleleri (her sayı bulgunun doğrulanmış ölçüsüdür). */
function gIntroSentences(findings, locale) {
  const out = [];
  // `caveat`: bulgunun ayrılmaz çekincesi (görev adedi ≠ emek, kritik yol hesaplanmaz, örtüşen birimler); kısa yanıtta da bulguyla kalır.
  const add = (finding, parts, { caveat = false } = {}) => out.push({ finding, ...factSentence(parts), ...(caveat ? { caveat: true } : {}) });
  for (const spread of findings.filter((item) => item.kind === 'workloadSpread')) {
    const { people, min, max, zero } = spread.metrics;
    add(spread, en(locale)
      ? [spread.team ? 'Across the ' : 'Across the listed ', s(formatCount(people, locale)), ' people', ', open tasks per person range from ', s(formatCount(min, locale)), ' to ', s(formatCount(max, locale)),
        ...(zero ? ['; ', s(formatCount(zero, locale)), zero === 1 ? ' person has' : ' people have', ' no visible open task, which does not mean they are idle'] : []), '.']
      : [spread.team ? '' : 'Listelenen ', s(formatCount(people, locale)), ' kişinin açık görev sayısı ', s(formatCount(min, locale)), ' ile ', s(formatCount(max, locale)), ' arasında değişiyor',
        ...(zero ? ['; ', s(formatCount(zero, locale)), ` kişinin görünür açık görevi yok, bu ${zero === 1 ? 'boşta olduğu' : 'boşta oldukları'} anlamına gelmiyor`] : []), '.']);
    add(spread, en(locale) ? ['These are task counts: they do not measure task size, effort or spare capacity, which Rota does not record.']
      : ['Bu sayılar görev adedidir; işin büyüklüğünü, harcanan emeği ya da boş kapasiteyi göstermez (Rota kapasite tutmaz).'], { caveat: true });
  }
  for (const spread of findings.filter((item) => item.kind === 'orgSpread')) {
    const { groups, open, overdue, overlap } = spread.metrics;
    const org = ORG_WORDS[spread.entityType];
    const names = (items) => joinParts(items.names.map((name) => [s(name)]), locale);
    const same = open && overdue && open.names.length === overdue.names.length && open.names.every((name) => overdue.names.includes(name));
    add(spread, en(locale)
      ? ['The work is spread across ', s(formatCount(groups, locale)), ` ${org.enPlural}`, ...(open ? ['; the most open work is in ', ...names(open), ' (', s(formatCount(open.value, locale)), ')'] : []),
        ...(overdue ? [same ? ', which also carries the most overdue work (' : '; the most overdue work is in ', ...(same ? [] : names(overdue)), ...(same ? [] : [' (']), s(formatCount(overdue.value, locale)), ')'] : []), '.']
      : ['İşler ', s(formatCount(groups, locale)), ` ${org.noun}e dağılıyor`,
        ...(open ? ['; en çok açık iş ', ...names(open), open.names.length > 1 ? ` ${org.noun}lerinde (` : ` ${org.noun}${org.noun === 'bölüm' ? 'ünde' : 'inde'} (`, s(formatCount(open.value, locale)), ')'] : []),
        ...(overdue ? [same ? ', gecikmiş işler de en çok burada (' : '; en çok gecikmiş iş ', ...(same ? [] : names(overdue)),
          ...(same ? [] : [overdue.names.length > 1 ? ` ${org.noun}lerinde (` : ` ${org.noun}${org.noun === 'bölüm' ? 'ünde' : 'inde'} (`]), s(formatCount(overdue.value, locale)), ')'] : []), '.']);
    add(spread, en(locale) ? [overlap ? `Some tasks have assignees in more than one ${org.en}, so the ${org.enPlural}' counts overlap and are not added together.`
      : `A task with assignees in different ${org.enPlural} is counted in each of them, so the ${org.enPlural}' counts are not added together.`]
      : [overlap ? `Sorumluları farklı ${org.noun}lerde olan görevler her ${org.noun}de ayrı sayıldığından ${org.noun} sayıları toplanmaz.`
        : `Sorumluları farklı ${org.noun}lerde olan bir görev her ${org.noun}de ayrı sayılabildiğinden ${org.noun} sayıları toplanmaz.`], { caveat: true });
  }
  for (const leader of findings.filter((item) => item.kind === 'overdueLeader')) {
    const names = joinParts(leader.names.map((name) => [s(name)]), locale);
    const tied = leader.metrics.tied > 1;
    if (leader.entityType === 'project') {
      add(leader, en(locale)
        ? ['The most overdue work is in ', ...names, ' (', s(formatCount(leader.metrics.overdue, locale)), tied ? ' overdue tasks each).' : ' overdue tasks).']
        : ['En çok gecikmiş görev ', ...names, tied ? ' projelerinde (' : ' projesinde (', ...(tied ? [`${ALL_OF[leader.metrics.tied] || 'hepsinde'} de `] : []),
          s(formatCount(leader.metrics.overdue, locale)), ' gecikmiş görev).']);
      continue;
    }
    add(leader, en(locale)
      ? ['Overdue work sits most with ', ...names, ' (', s(formatCount(leader.metrics.overdue, locale)), tied ? ' each' : '', '); this is an assignment distribution, not a performance judgement.']
      : ['Gecikmiş görevler en çok ', ...names, ' üzerinde (', ...(tied ? [`${ALL_OF[leader.metrics.tied] || 'hepsinde'} de `] : []),
        s(formatCount(leader.metrics.overdue, locale)), ' gecikmiş görev); bu bir atama dağılımıdır, performans yargısı değildir.']);
  }
  for (const rate of findings.filter((item) => item.kind === 'overdueRateLeader')) {
    const { overdue, open, share, tied, leader, excluded, minOpen } = rate.metrics;
    const names = joinParts(rate.names.map((name) => [s(name)]), locale);
    // Eşiğin altında kalan varlık varsa karşılaştırmanın nüfusu açıkça söylenir (yüzde küçük paydalarda yanıltıcıdır).
    const among = excluded > 0 ? (en(locale) ? [' (among those with at least ', s(formatCount(minOpen, locale)), ' open tasks)'] : [' (en az ', s(formatCount(minOpen, locale)), ' açık görevi olanlar arasında)']) : [];
    add(rate, en(locale)
      ? ['Relative to open work the picture changes', ...among, ': ', ...names, tied > 1 ? ' have the highest overdue share (' : ' has the highest overdue share (', s(formatPercent(share, locale)), ...(tied > 1 ? [] : [', ', s(formatCount(overdue, locale)), ' of ', s(formatCount(open, locale))]),
        '), while ', s(leader.name), ', with the most overdue tasks (', s(formatCount(leader.overdue, locale)), '), is at ', s(formatPercent(leader.share, locale)), '.']
      : ['Açık işe oranla bakıldığında tablo değişiyor', ...among, ': gecikme oranı en yüksek ', ...names, tied > 1 ? entityPlaces(rate.entityType) : entityPlace(rate.entityType, locale), ' (', s(formatPercent(share, locale)),
        ...(tied > 1 ? [] : [', ', s(formatCount(open, locale)), ' açık görevin ', s(possessiveCount(overdue, locale))]), '); en çok gecikmiş işi taşıyan ', s(leader.name),
        entityPlace(rate.entityType, locale), ' ise bu oran ', s(formatPercent(leader.share, locale)), '.']);
  }
  for (const despite of findings.filter((item) => item.kind === 'completionDespiteOverdue')) {
    const [first, second] = despite.items;
    const extra = despite.metrics.entities - despite.items.length;
    add(despite, en(locale)
      ? [s(first.name), ' has completed ', s(formatPercent(first.share, locale)), ' of its tasks yet still has ', s(formatCount(first.overdue, locale)), ' overdue',
        ...(second ? ['; ', s(second.name), ' is similar (', s(formatPercent(second.share, locale)), ' completed, ', s(formatCount(second.overdue, locale)), ' overdue)'] : []),
        ...(extra > 0 ? [' and ', s(formatCount(extra, locale)), ' more project', extra === 1 ? '' : 's', ' show the same pattern'] : []), '; a high completion rate does not mean delivery pressure has ended.']
      : [s(first.name), ' projesinde görevlerin ', s(percentOf(first.share, locale)), ' tamamlanmış olsa da ', s(formatCount(first.overdue, locale)), ' gecikmiş görev bulunuyor',
        ...(second ? ['; ', s(second.name), ' projesinde de durum benzer (', s(formatPercent(second.share, locale)), ' tamamlanmış, ', s(formatCount(second.overdue, locale)), ' gecikmiş)'] : []),
        ...(extra > 0 ? ['; aynı örüntü ', s(formatCount(extra, locale)), ' projede daha var'] : []), '; yani yüksek tamamlanma oranı teslimat baskısının bittiği anlamına gelmiyor.']);
  }
  for (const contrast of findings.filter((item) => item.kind === 'volumeVsDelay')) {
    const [many, few] = contrast.pair;
    add(contrast, en(locale)
      ? ['Task volume alone does not show pressure: ', s(many.name), ' has ', s(formatCount(many.open, locale)), ' open tasks', many.overdue ? [' but only ', s(formatCount(many.overdue, locale)), ' overdue'].flat() : [' and none overdue'],
        ', while ', s(few.name), ' has fewer open tasks (', s(formatCount(few.open, locale)), ') and ', s(formatCount(few.overdue, locale)), ' overdue.'].flat()
      : ['Görev sayısı tek başına baskıyı göstermiyor: ', s(many.name), ' projesinde ', s(formatCount(many.open, locale)), ' açık görev var',
        ...(many.overdue ? [' ve yalnızca ', s(possessiveCount(many.overdue, locale)), ' gecikmiş'] : [' ama hiçbiri gecikmiş değil']), '; ', s(few.name), ' projesinde ise daha az açık görev (',
        s(formatCount(few.open, locale)), ') varken ', s(formatCount(few.overdue, locale)), ' gecikmiş görev bulunuyor.']);
  }
  // Kritik yol çekincesi yanıtta bir kez söylenir (iki projenin kilometre taşlarında yinelenmez).
  let pathCaveat = false;
  for (const status of findings.filter((item) => item.kind === 'milestoneStatus')) {
    const { open, overdue, overdueExact, worst, next } = status.metrics;
    // Aşama G: durum, en uzun gecikme ve sıradaki kilometre taşı tek cümledir ("Açık **2** kilometre taşından **1'i** gecikmiş: en uzun
    // süredir geciken **X** (**9** gün), sıradaki ise **Y** (**21 Kasım 2026**)."); sıradaki ayrı bir kısa cümle olarak kalmaz.
    const nextDay = next ? s(formatFactDay(next.due, locale)) : null;
    if (overdue > 0) {
      add(status, en(locale)
        ? [...(open != null ? [s(formatCount(overdue, locale)), ' of the ', s(formatCount(open, locale)), ' open milestones ', overdue === 1 ? 'is' : 'are'] : [overdueExact ? '' : 'At least ', s(formatCount(overdue, locale)), overdue === 1 ? ' milestone is' : ' milestones are']),
          ' overdue', ...(worst ? ['; the longest-overdue is ', s(worst.title), ' (', s(formatCount(worst.days, locale)), worst.days === 1 ? ' day' : ' days', ')'] : []),
          ...(next ? [worst ? ', and the next is ' : '; the next is ', s(next.title), ' (', nextDay, ')'] : []), '.']
        : [...(open != null ? ['Açık ', s(formatCount(open, locale)), ' kilometre taşından ', s(possessiveCount(overdue, locale)), ' gecikmiş'] : [overdueExact ? '' : 'En az ', s(formatCount(overdue, locale)), ' kilometre taşı gecikmiş']),
          ...(worst ? [': en uzun süredir geciken ', s(worst.title), ' (', s(formatCount(worst.days, locale)), ' gün)'] : []),
          ...(next ? [worst ? ', sıradaki ise ' : '; sıradaki kilometre taşı ', s(next.title), ' (', nextDay, ')'] : []), '.']);
      if (!pathCaveat) {
        add(status, en(locale) ? ['An overdue milestone does not by itself prove that the project end date will slip, because Rota does not compute the critical path.']
          : ['Gecikmiş bir kilometre taşı projenin bitişinin kayacağını tek başına kanıtlamaz, çünkü Rota kritik yolu hesaplamaz.'], { caveat: true });
        pathCaveat = true;
      }
    } else if (open != null && status.metrics.dated > 0) {
      // Termini olmayan kilometre taşı için gecikme yargısı kurulmaz: "hiçbiri gecikmiş değil" yalnızca termini olanlar için söylenir.
      const { dated } = status.metrics;
      const some = dated !== open;
      add(status, en(locale) ? ['None of the ', s(formatCount(dated, locale)), some ? ' open milestones with a target date is overdue' : ' open milestones is overdue', ...(next ? ['; the next is ', s(next.title), ' (', nextDay, ')'] : []), '.']
        : [some ? 'Termini olan açık ' : 'Açık ', s(formatCount(dated, locale)), ' kilometre taşının hiçbiri gecikmiş değil', ...(next ? ['; sıradaki ', s(next.title), ' (', nextDay, ')'] : []), '.']);
    } else if (next) {
      add(status, en(locale) ? [next.sole ? 'The next milestone is ' : 'The next milestone date is ', s(next.title), ' (', nextDay, ').']
        : ['Sıradaki kilometre taşı ', s(next.title), ' (', nextDay, ').']);
    }
    if (status.metrics.undated > 0) {
      const { undated } = status.metrics;
      add(status, en(locale) ? [s(formatCount(undated, locale)), undated === 1 ? ' open milestone has no target date, so it is not in the date order and no delay can be judged for it.'
        : ' open milestones have no target date, so they are not in the date order and no delay can be judged for them.']
        : ['Termini olmayan ', s(formatCount(undated, locale)), ' açık kilometre taşı termin sırasında yer almıyor; ', undated === 1 ? 'bu kilometre taşı' : 'bunlar', ' için gecikme yargısı kurulamaz.']);
    }
  }
  return out;
}

function priorityItems(findings, locale, said, { scopeStated = true } = {}) {
  const items = [];
  // Aşama G: gecikmiş kilometre taşı yönetim açısından en öncelikli dikkat noktasıdır (adı ve gecikme günü doğrulanmış olgudur).
  for (const status of findings.filter((item) => item.kind === 'milestoneStatus' && item.metrics.worst)) {
    const { worst } = status.metrics;
    items.push({ finding: status, parts: en(locale) ? [s(worst.title), ' — an overdue milestone (', s(formatCount(worst.days, locale)), worst.days === 1 ? ' day)' : ' days)']
      : [s(worst.title), ' — gecikmiş kilometre taşı (', s(formatCount(worst.days, locale)), ' gün)'] });
  }
  const level = findings.find((item) => item.kind === 'levelComparison');
  const levelTop = level ? level.layers.filter((layer) => layer.open > 0 && layer.overdue > 0)
    .reduce((top, layer) => (!top || compareRatio(layer.overdue, layer.open, top.overdue, top.open) > 0 ? layer : top), null) : null;
  if (levelTop && level.layers.filter((layer) => layer.open > 0 && compareRatio(layer.overdue, layer.open, levelTop.overdue, levelTop.open) === 0).length === 1) {
    items.push({ finding: level, parts: en(locale) ? [layerLabel(levelTop, locale), ' — the scope with the highest overdue share (', s(formatPercent(sharePercent(levelTop.overdue, levelTop.open), locale)), ')']
      : [layerLabel(levelTop, locale), ' — açık işlerde gecikme oranının en yüksek olduğu kapsam (', s(formatPercent(sharePercent(levelTop.overdue, levelTop.open), locale)), ')'] });
  }
  // Aşama G: en uzun geciken görev zaten gecikmiş kilometre taşı olarak yazıldıysa ikinci kez öncelik olmaz.
  // Aynılık görev kimliğiyle (yoksa başlık + proje kimliğiyle) belirlenir: aynı adlı başka bir gecikmiş görev öncelikten düşmez.
  const worstMilestones = findings.filter((item) => item.kind === 'milestoneStatus' && item.metrics.worst).map((item) => item.metrics.worst);
  const sameTask = (longest, worst) => (longest.entity.key != null && worst.key != null ? String(worst.key) === longest.entity.key
    : worst.title === longest.entity.name && worst.projectId != null && String(worst.projectId) === String(longest.projectId ?? ''));
  const longestItems = findings.filter((item) => item.kind === 'longestOverdue' && !worstMilestones.some((worst) => sameTask(item, worst))).sort((a, b) => b.metrics.days - a.metrics.days);
  const longest = longestItems[0];
  for (const longest of longestItems) {
    // Adaş görevlerde gün ve proje ayırt edicidir; gövdede söylenmiş olsalar da sonuçta korunurlar.
    const detail = said(longest) && !longest.duplicateTitle ? [] : [' (', s(formatCount(longest.metrics.days, locale)), en(locale) ? ' days' : ' gün', ...(longest.project ? [', ', s(longest.project)] : []), ')'];
    items.push({ finding: longest, parts: [s(longest.entity.name), en(locale) ? ' — the longest-overdue task' : ' — en uzun süredir geciken görev', ...detail] });
  }
  // Aşama G: kişinin en çok açık işi taşıması bir öncelik gerekçesi değildir (görev adedi emek ya da kapasite değildir).
  const attention = findings.find((item) => item.kind === 'attentionLeader') || findings.find((item) => item.kind === 'overdueConcentration' || item.kind === 'overdueProjectShare');
  // Projede tek gösterge önceliği gecikmedir: en çok gecikmiş işi taşıyan proje(ler), en çok açık işi olan projenin önündedir.
  const lateProjects = !attention && findings.find((item) => item.kind === 'overdueLeader' && item.entityType === 'project');
  if (lateProjects) {
    const tied = lateProjects.metrics.tied > 1;
    const names = joinParts(lateProjects.names.map((name) => [s(name)]), locale);
    items.push({ finding: lateProjects, parts: en(locale)
      ? ['Overdue work in ', ...names, tied ? ' — the projects with the most overdue work' : ' — the project with the most overdue work']
      : [...names, tied ? ' projelerindeki gecikmeler — en çok gecikmiş işi olan projeler' : ' projesindeki gecikmeler — en çok gecikmiş işi olan proje'] });
  }
  const focus = attention || (!lateProjects && findings.find((item) => item.kind === 'openWorkLeader' && item.entity.type !== 'person'));
  if (focus) {
    const project = focus.entity.type === 'project';
    const org = ORG_WORDS[focus.entity.type];
    const leader = focus.kind === 'attentionLeader';
    const open = focus.kind === 'openWorkLeader';
    items.push({ finding: focus, parts: en(locale)
      ? [project ? 'Open work in ' : org ? `Open work in the ${org.en} ` : 'Open work assigned to ', s(focus.entity.name), leader ? ' — where the indicators are highest together' : open ? ' — with the most open tasks' : ' — where the overdue work is concentrated']
      : [s(focus.entity.name), project ? ' projesindeki ' : org ? ` ${org.inside} ` : ' üzerindeki ',
        leader ? 'açık işler — göstergelerin birlikte en yüksek olduğu ' : open ? 'açık işler — en çok açık işin bulunduğu ' : 'gecikmeler — gecikmiş işlerin toplandığı ',
        project ? 'proje' : org ? org.noun : 'kişi'] });
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
  for (const nearest of findings.filter((item) => item.kind === 'nearestDelivery').sort((a, b) => a.metrics.due.localeCompare(b.metrics.due))) {
    const date = s(formatFactDay(nearest.metrics.due, locale));
    items.push({ finding: nearest, parts: en(locale)
      ? (nearest.metrics.sole ? [s(nearest.entity.name), ' — the nearest delivery (', date, ')'] : [date, ' — the nearest due date (including ', s(nearest.entity.name), ')'])
      : (nearest.metrics.sole ? [s(nearest.entity.name), ' — en yakın teslim (', date, ')'] : [date, ' — en yakın teslim tarihi (', s(nearest.entity.name), ' dahil)']) });
  }
  // Ortak kapsam girişte söylendiyse öncelik satırları etiketsizdir; karışık kapsamda her satır kendi kapsamını taşır (sahip
  // kapsamında doğal biçimde: "Bölümünüzde: …").
  // Ortak kapsam yalnızca giriş onu gerçekten söylediyse satırlardan düşer (girişsiz öncelik kapsamını kendisi taşır).
  const shared = scopeStated && sharedScopeLead(findings, locale);
  return items.slice(0, FINDING_LIMITS.maxPriorities).map((item) => {
    const scope = shared ? null : findingScope(item.finding, locale);
    if (!scope) return item;
    const filters = item.finding.filters || {};
    const place = ownerPlace(filters, locale);
    if (place) return { ...item, parts: [place, ': ', ...item.parts] };
    // Aşama G: sahip kapsamı + dönem doğal yer adıyla yazılır ("Kendi işlerinizde (9 Kasım 2026 – 8 Aralık 2026): …"), etiket dizisiyle değil.
    const windowed = ownerPlace({ ...filters, dateFrom: null, dateTo: null }, locale);
    if (windowed && (filters.dateFrom || filters.dateTo) && !filters.projectId && filters.personSicil == null && !filters.priorities?.length) {
      const span = [filters.dateFrom ? formatFactDay(filters.dateFrom, locale) : '…', filters.dateTo ? formatFactDay(filters.dateTo, locale) : '…'].join(' – ');
      return { ...item, parts: [windowed, ' (', s(span), '): ', ...item.parts] };
    }
    return { ...item, parts: [s(scope), ': ', ...item.parts] };
  });
}

const evidenceOrder = (left, right) => Number(String(left).replace(/\D/g, '')) - Number(String(right).replace(/\D/g, '')) || String(left).localeCompare(String(right));
const evidenceOf = (entries) => [...new Set(entries.flatMap((entry) => entry.finding.evidenceIds))].sort(evidenceOrder);

/**
 * Bulguların anlatımı: giriş ve sonuç (en az bir kanıtlı öncelik).
 * Kısa yanıtta yalnızca girişin ilk cümlesi ve en önemli tek öncelik kalır. Bulgu yoksa ikisi de `null`dır.
 */
export function synthesisNarrative(findings, { locale = 'tr', detail = 'balanced', said = () => false, focus = [] } = {}) {
  const sentences = withScopeLead(introSentences(findings, locale, focus), findings, locale);
  const short = detail === 'short';
  // Aşama G: giriş sorunun asıl yanıtıdır (ilk bulgunun bütün cümleleri); diğer bölümler arası bulgular ayrı bir analiz
  // paragrafıdır. Kısa yanıtta yalnızca girişin ilk cümlesi kalır; analiz paragrafı yazılmaz.
  const leadFinding = sentences[0]?.finding;
  // Kısa yanıtta da açan bulgunun ayrılmaz çekincesi (ör. görev adedi ≠ kapasite, kritik yol) bulguyla birlikte kalır.
  const lead = short ? sentences.filter((item, index) => index === 0 || item.finding === leadFinding && item.caveat) : sentences.filter((item) => item.finding === leadFinding);
  const rest = short ? [] : sentences.filter((item) => !lead.includes(item));
  const block = (items) => (items.length ? Object.freeze({ markdown: items.map((item) => item.markdown).join(' '), plain: items.map((item) => item.plain).join(' '),
    evidenceIds: Object.freeze(evidenceOf(items)), states: Object.freeze(items.flatMap((item) => item.states || [])) }) : null);
  const leadBlock = block(lead);
  const restBlock = block(rest);
  // Karışık kapsamda her kapsamın bulguları kendi paragrafıdır; tek kapsamda analiz tek paragraftır.
  // Okunabilirlik: bir paragraf en çok dört cümledir; uzun grup yalnızca bulgu sınırında bölünür (bir bulgunun cümleleri ayrılmaz).
  // Her anlatım öğesi yapısı gereği tek cümledir (bulgu cümleleri tek tek kurulur): paragraf uzunluğu öğe sayısıdır.
  const groups = [];
  // Bulgunun bütün cümleleri birlikte değerlendirilir: sığmayan bulgu yeni paragrafta başlar.
  const findingSize = (index) => {
    let total = 0;
    while (index + total < rest.length && rest[index + total].finding === rest[index].finding && (rest[index + total].group ?? null) === (rest[index].group ?? null)) total += 1;
    return total;
  };
  rest.forEach((item, index) => {
    const last = groups.at(-1);
    const sameGroup = last && last.group === (item.group ?? null);
    const starts = !last || last.items.at(-1).finding !== item.finding;
    if (sameGroup && !(starts && last.items.length + findingSize(index) > FINDING_LIMITS.maxParagraphSentences)) last.items.push(item);
    else groups.push({ group: item.group ?? null, items: [item] });
  });
  const paragraphs = groups.length > 1 ? Object.freeze(groups.map((group) => block(group.items))) : null;
  const intro = leadBlock ? Object.freeze({ ...leadBlock, ...(restBlock ? { insights: paragraphs ? Object.freeze({ ...restBlock, paragraphs }) : restBlock } : {}),
    // Söylem belleği için girişin ve analiz paragrafının bütün ölçüleri.
    states: Object.freeze([...leadBlock.states, ...(restBlock?.states || [])]) }) : null;
  // Kısa yanıt da kapanır: yalnızca en önemli tek öncelikle.
  const scopeStated = sentences.length > 0;
  const items = short ? priorityItems(findings, locale, said, { scopeStated }).slice(0, 1) : priorityItems(findings, locale, said, { scopeStated });
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
  workload: ['iş yükü', 'workload'], projects: ['proje dağılımı', 'project spread'], schedule: ['aylara göre terminler', 'deadlines by month'], critical: ['kritik işler', 'critical work'],
  org: ['alt birimlere göre dağılım', 'breakdown by sub-unit'], milestones: ['kilometre taşları', 'milestones']
});
/** Analitik yönün sunucu adı, başlıkta kullanılmak üzere büyük harfle ("Kilometre taşları"); bilinmeyen yönde `null`. */
export function aspectTitle(focus, locale = 'tr') {
  const name = ASPECTS[focus]?.[en(locale) ? 1 : 0];
  return name ? `${name.charAt(0).toLocaleUpperCase(en(locale) ? 'en-US' : 'tr-TR')}${name.slice(1)}` : null;
}
const TEAM_WORK = Object.freeze({ unit: ['biriminizin işleri', "your unit's work"], department: ['bölümünüzün işleri', "your department's work"],
  directorate: ['direktörlüğünüzün işleri', "your directorate's work"] });

/**
 * Bölümler arası bulgu girişi kurulamayan çok bölümlü özetin çerçeve cümlesi: neyin hangi açılardan ele alındığını söyler,
 * OLGU taşımaz (sayı, sıralama ya da yargı yoktur). Kapsam özetin kapsamından, adlar sunucunun çözdüğü öznelerdendir.
 */
export function framingSentence({ scope, level = null, focus = [], projects = [], people = [], withSelf = false, within = false, locale = 'tr' } = {}) {
  const lang = en(locale) ? 1 : 0;
  const join = (names) => names.flatMap((name, index) => [...(index ? [index === names.length - 1 ? (lang ? ' and ' : ' ve ') : ', '] : []), s(name)]);
  const owner = scope === 'self' ? [lang ? 'your own work' : 'kendi işleriniz']
    : scope === 'team' ? [(TEAM_WORK[level] || ['ekibinizin işleri', "your team's work"])[lang]]
      // İki özne adıyla değil sayısıyla anılır: gövdenin gösterdiği özne sırası (takipteki "ilki") çerçeveyle çelişmez.
      : ['project', 'projects'].includes(scope) && projects.length > 1 ? [lang ? 'the work in the two projects' : 'iki projedeki işler']
        : ['project', 'projects'].includes(scope) && projects.length ? (lang ? ['the work in ', ...join(projects)] : [...join(projects), ' projesindeki işler'])
        : scope === 'projects' ? [lang ? 'the work in the projects you can see' : 'erişebildiğiniz projelerdeki işler']
          : scope === 'person' && (people.length > 1 || withSelf) ? [lang ? "the two people's work" : 'iki kişinin işleri']
            : scope === 'person' && people.length ? (lang ? [...join(people), "'s work"] : [...join(people), ' sorumluluğundaki işler'])
            : scope === 'all' ? [lang ? 'all the work you can see' : 'görebildiğiniz bütün işler'] : null;
  const aspects = [...new Set(focus)].map((item) => ASPECTS[item]?.[lang]).filter(Boolean);
  if (!owner || !aspects.length) return null;
  const listed = aspects.flatMap((item, index) => [...(index ? [index === aspects.length - 1 ? (lang ? ' and ' : ' ve ') : ', '] : []), item]);
  const compared = !within && projects.length > 1 || people.length > 1 || withSelf;
  if (within && projects.length) owner?.push(lang ? " within " : " · proje: ", ...join(projects));
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
export function analyticalSynthesis(parts, { locale = 'tr', detail = 'balanced', focus = [] } = {}) {
  const findings = analyticalFindings(parts);
  return Object.freeze({ findings, ...synthesisNarrative(findings, { locale, detail, focus }) });
}

