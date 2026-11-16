import { factSentence, formatCount, formatFactDay, formatPercent, strongFact } from './groundedPropositions.js';
import { englishBucketLabel, comparableWindows, namedWindow, rangeLabel, windowAdverb, windowLength, windowName, windowPhrase, windowPosition, windowsOverlap, monthEnd, shiftDay } from './temporalWindow.js';

/**
 * Aşama H — DÖNEMSEL ve TARİHSEL BULGULAR (saf, belirlenimci).
 *
 * Bu modül turun DOĞRULANMIŞ dönem okumalarından (dönemde tamamlanan ve oluşturulan görevler, kaydedilen hareketler, tamamlanma
 * dizisi, teslim ufukları) yapılandırılmış bulgular ve onların anlatım cümlelerini kurar. Bulgu motorunun (`analyticalFindings`)
 * bir uzantısıdır: aynı kanıt sözleşmesini, aynı cümle kurucusunu ve aynı söylem belleğini kullanır; ayrı bir analiz sistemi değildir.
 *
 * TARİHSEL DOĞRULUK SÖZLEŞMESİ (her bulgu bunu taşır, sunum düşüremez):
 *   - Bir dönemde GÖZLENEN olay ile o dönemde GEÇERLİ olan durum ayrıdır. Bulgular yalnızca olayı söyler: gerçekleşen bitişi
 *     dönemde olan görev, dönemde oluşturulan görev, dönemde kaydedilen hareket. Geçmiş bir günün durumu (gecikme, açık iş)
 *     yeniden kurulmaz ve söylenmez.
 *   - Bilinmeyen değer sıfır değildir: hareket kaydının başlamadığı dönemin sayısı `null`dır; karşılaştırması kurulmaz ve nedeni yazılır.
 *   - Tamlık ölçüleri cümleyle birlikte gelir: gerçekleşen bitişi kayıtlı olmayan tamamlanmış görevler, hareket kaydının ilk günü,
 *     henüz bitmemiş dönem, eşit olmayan ya da örtüşen dönemler, kısmi kovalar.
 *   - Yüzde değişim yalnızca paydası anlamlıysa (önceki dönem değeri yeterli, iki dönem de kapanmış ve aynı türde) söylenir.
 *   - Eğilim yalnızca yeterli sayıda TAM kova varsa yorumlanır; aksi hâlde eğilimin söylenemediği yazılır (tek tük gözlemden
 *     eğilim çizilmez).
 * Her sayı kanıttaki olgudur ya da iki doğrulanmış olgunun sunucuda hesaplanan farkı/toplamıdır. Model bu metni yazmaz ve seçmez.
 */

export const TEMPORAL_FINDING_KINDS = Object.freeze(['periodSummary', 'periodComparison', 'completionTrend', 'activityTrend', 'horizonSpread', 'historyLimit', 'noteDigest']);
/** Yüzde değişimin en küçük paydası ve eğilim yorumunun en az tam kova sayısı (şeffaf, sabit ölçütler). */
export const TEMPORAL_LIMITS = Object.freeze({ minPercentBase: 4, minTrendBuckets: 3, trendSpan: 3 });

const s = strongFact;
const en = (locale) => locale === 'en';
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const n = (value, locale) => s(formatCount(value, locale));
const upper = (text, locale) => `${text.charAt(0).toLocaleUpperCase(en(locale) ? 'en-US' : 'tr-TR')}${text.slice(1)}`;

/** Görev nüfusunun yalnızca kapsam (sahip, düzey, proje, kişi) taşıyan süzgeci; başka daraltması olan okuma dönem bulgusu kurmaz. */
function taskScope(filters) {
  if (!filters || filters.text || filters.wbsId || filters.priorities?.length || filters.deadline || filters.createdByMe || filters.hasDescription || filters.milestone != null || filters.assignee === 'unassigned') return null;
  const owner = filters.assignee === 'me' ? 'self' : filters.assignee === 'team' ? 'team' : 'all';
  return { owner, level: owner === 'team' ? filters.teamLevel || null : null, projectId: filters.projectId || null, project: typeof filters.project === 'string' ? filters.project : null,
    personSicil: filters.personSicil ?? null, person: typeof filters.person === 'string' && filters.person !== 'Seçilen kişi' ? filters.person : null };
}

function activityScope(filters) {
  if (!filters || filters.activityKind || filters.taskId) return null;
  const owner = filters.activityScope === 'mine' ? 'self' : filters.activityScope === 'team' ? 'team' : 'all';
  return { owner, level: owner === 'team' ? filters.teamLevel || null : null, projectId: filters.projectId || null, project: typeof filters.project === 'string' ? filters.project : null,
    personSicil: filters.personSicil ?? null, person: typeof filters.person === 'string' && filters.person !== 'Seçilen kişi' ? filters.person : null };
}

const scopeKey = (scope) => JSON.stringify([scope.owner, scope.level, scope.projectId, scope.personSicil]);
const rangeKey = (range) => `${range.dateFrom}/${range.dateTo}`;

/**
 * Kanıt gruplarından dönem okumaları. Okuma, olgularının süzgeçlerinden tanınır (araç, tarih alanı, görünüm, gruplama); bölüm
 * sırası ya da soru metni kullanılmaz. Tanınmayan ya da ek daraltma taşıyan okuma atlanır (olağan anlatımı sürer).
 */
export function temporalReads(groups) {
  const reads = [];
  for (const group of groups) {
    const sample = group.facts.find((fact) => fact?.semantic?.filters && fact.semantic.provenance?.tool);
    if (!sample) continue;
    const { filters, provenance, groupBy } = sample.semantic;
    const tool = provenance.tool;
    const range = filters.dateFrom && filters.dateTo ? { dateFrom: filters.dateFrom, dateTo: filters.dateTo } : null;
    const metricValue = (metric) => { const fact = group.facts.find((item) => item.semantic?.metric === metric && !item.semantic.row); return fact ? fact.value : undefined; };
    const base = { evidenceId: group.evidenceId, part: group.part, today: provenance.today || null, range };
    // Not okuması (rızayla): açıklaması olan açık görevlerin açıklama satırları; sayım nüfusun tamamı, satırlar okunan örnektir.
    if (tool === 'rota_task_search' && filters.hasDescription === true && filters.statuses?.length && filters.statuses.every((status) => ['todo', 'in_progress'].includes(status))) {
      const scope = taskScope({ ...filters, hasDescription: false });
      const shown = new Set(group.facts.map((fact) => /^data\.tasks\.(\d+)\.description$/.exec(fact.field || '')?.[1]).filter(Boolean)).size;
      const total = group.facts.find((fact) => fact.field === 'totalCount');
      if (scope) reads.push({ ...base, filters, kind: 'notes', scope, shown, total: count(total?.value), clipped: group.facts.some((fact) => /\.descriptionClipped$/.test(fact.field || '') && fact.value === true || /\.description$/.test(fact.field || '') && typeof fact.value === 'string' && fact.value.endsWith('…')) });
      continue;
    }
    if (tool === 'rota_task_analytics') {
      const scope = taskScope(filters);
      if (!scope || !range) continue;
      const rows = group.facts.filter((fact) => fact.semantic?.group && /^data\.groups\.\d+\.count$/.test(fact.field))
        .map((fact) => ({ index: Number(fact.field.split('.')[2]), key: fact.semantic.group.key, label: fact.semantic.group.label, partial: fact.semantic.group.partial === true,
          value: count(fact.value), complete: fact.semantic.complete === true && fact.semantic.row?.collectionSize != null })).sort((a, b) => a.index - b.index);
      if (['date_week', 'date_month'].includes(groupBy) && filters.dateField === 'actualFinish' && rows.length) {
        reads.push({ ...base, kind: 'series', scope, undated: count(sample.semantic.history?.undatedDone), bucket: groupBy === 'date_month' ? 'month' : 'week', rows, collectionComplete: rows.every((row) => row.complete && row.value != null) });
      } else if (groupBy === 'due_horizon' && rows.length === 3) {
        reads.push({ ...base, kind: 'horizons', scope, rows, collectionComplete: rows.every((row) => row.complete && row.value != null) });
      } else if (!groupBy && filters.dateField === 'actualFinish' && filters.statuses?.length === 1 && filters.statuses[0] === 'done' && metricValue('tasks.total') !== undefined) {
        reads.push({ ...base, kind: 'completed', scope, total: count(metricValue('tasks.total')), undated: count(sample.semantic.history?.undatedDone ?? metricValue('tasks.undatedDone')) });
      } else if (!groupBy && filters.dateField === 'createdAt' && !filters.statuses?.length && metricValue('tasks.total') !== undefined) {
        reads.push({ ...base, kind: 'created', scope, total: count(metricValue('tasks.total')), done: count(metricValue('tasks.done')), open: count(metricValue('tasks.open')) });
      }
    } else if (tool === 'rota_activity_search' && filters.activityView) {
      const scope = activityScope(filters);
      if (!scope || !range) continue;
      const coverage = sample.semantic.coverage || null;
      const rows = group.facts.filter((fact) => fact.semantic?.series && /^data\.series\.\d+\.events$/.test(fact.field))
        .map((fact) => ({ index: Number(fact.field.split('.')[2]), key: fact.semantic.series.key, label: fact.semantic.series.label, partial: fact.semantic.series.partial === true,
          recorded: fact.semantic.series.recorded !== false, value: fact.value === null ? null : count(fact.value) })).sort((a, b) => a.index - b.index);
      if (rows.length) reads.push({ ...base, kind: 'activitySeries', scope, bucket: sample.semantic.bucket || filters.activityView, rows, coverage });
      if (metricValue('activity.events') !== undefined) {
        const value = (metric) => { const raw = metricValue(metric); return raw === null || raw === undefined ? null : count(raw); };
        reads.push({ ...base, kind: 'activity', scope, coverage, events: value('activity.events'), tasks: value('activity.tasks'), people: value('activity.people'),
          completed: value('activity.completedTasks'), created: value('activity.createdTasks'), deleted: value('activity.deletedTasks'), updated: value('activity.updatedTasks'),
          reopened: value('activity.reopenedTasks') });
      }
    }
  }
  // Kişi adı yalnızca aynı kişinin görev okumasında çözülmüşse hareket okumasına da taşınır (aynı Sicil; ad kanıttandır).
  for (const read of reads) {
    if (read.scope.personSicil != null && !read.scope.person) read.scope.person = reads.find((other) => other.scope.personSicil === read.scope.personSicil && other.scope.person)?.scope.person || null;
    if (read.scope.projectId && !read.scope.project) read.scope.project = reads.find((other) => other.scope.projectId === read.scope.projectId && other.scope.project)?.scope.project || null;
  }
  return reads;
}

/** Kova bitmeden tam gözlem sayılmaz; eski kanıtların tarih anahtarı da denetlenir. */
function endedBucket(row, bucket, today) {
  if (!today || !/^\d{4}-\d{2}(?:-\d{2})?$/.test(row.key)) return false;
  return (bucket === 'month' ? monthEnd(`${row.key.slice(0, 7)}-01`) : shiftDay(row.key, 6)) < today;
}

/** Oluşturulma okuması silinmiş görevleri içermez. */
function createdBasisSentence(locale) {
  return { ...factSentence(en(locale) ? ['Creation counts include only tasks still present today; tasks subsequently deleted are excluded.'] : ['Oluşturulma sayıları yalnızca bugün hâlâ kayıtlı görevleri kapsar; sonradan silinenler sayılmaz.']), caveat: true, states: [] };
}

/* ── Kapsam ve dönem yazımı ─────────────────────────────────────────── */

const TEAM_OF = Object.freeze({ unit: ['biriminizin', "your unit's"], department: ['bölümünüzün', "your department's"], directorate: ['direktörlüğünüzün', "your directorate's"] });

/** Görev nüfusunun yer zarfı: "görebildiğiniz işlerde", "ekibinizin işlerinde", "**X** projesinde". */
function taskPlace(scope, locale) {
  const lang = en(locale) ? 1 : 0;
  const team = (TEAM_OF[scope.level] || ['ekibinizin', "your team's"])[lang];
  if (scope.person) return lang ? [...(scope.project ? ['in the ', s(scope.project), ' project, '] : []), 'in the work assigned to ', s(scope.person)]
    : [...(scope.project ? [s(scope.project), ' projesinde '] : []), s(scope.person), ' sorumluluğundaki işlerde'];
  if (scope.personSicil != null) return lang ? ['in the selected person\'s work'] : ['seçilen kişinin sorumluluğundaki işlerde'];
  if (scope.project) {
    if (scope.owner === 'self') return lang ? ['in your own work in the ', s(scope.project), ' project'] : [s(scope.project), ' projesindeki kendi işlerinizde'];
    if (scope.owner === 'team') return lang ? [`in ${team} work in the `, s(scope.project), ' project'] : [s(scope.project), ` projesindeki ${team} işlerinde`];
    return lang ? ['in the ', s(scope.project), ' project'] : [s(scope.project), ' projesinde'];
  }
  if (scope.owner === 'self') return [lang ? 'in your own work' : 'kendi işlerinizde'];
  if (scope.owner === 'team') return [lang ? `in ${team} work` : `${team} işlerinde`];
  return [lang ? 'in the work you can see' : 'görebildiğiniz işlerde'];
}

/** Hareket nüfusunun yazımı işlem yapanı belirtir; görev sorumluluğu çıkarılmaz. */
function activityPlace(scope, locale) {
  const lang = en(locale) ? 1 : 0;
  if (scope.person) return lang ? [...(scope.project ? ['in the ', s(scope.project), ' project, '] : []), 'in activity recorded by ', s(scope.person)] : [...(scope.project ? [s(scope.project), ' projesinde '] : []), s(scope.person), ' tarafından kaydedilen hareketlerde'];
  if (scope.owner === 'self') return [lang ? 'in activity you recorded' : 'sizin kaydettiğiniz hareketlerde'];
  if (scope.owner === 'team') return [lang ? `in activity recorded by ${(TEAM_SUBJECT[scope.level] || ['ekibiniz', 'your team'])[1]}` : `${(TEAM_OF[scope.level] || ['ekibinizin'])[0]} kaydettiği hareketlerde`];
  return scope.project ? (lang ? ['in activity in the ', s(scope.project), ' project'] : [s(scope.project), ' projesindeki hareketlerde']) : [lang ? 'in visible recorded activity' : 'görebildiğiniz kaydedilmiş hareketlerde'];
}

/**
 * Hareket cümlesinin gövdesi. Hareketlerde kapsam İŞLEMİ YAPANA göredir (görevin sorumlusuna değil); cümle bunu öznesiyle söyler:
 * "siz … hareket kaydettiniz", "ekibiniz … kaydetti", "**X** projesinde … kaydedildi". `counts`: sayı parçaları (`null` → hareket yok).
 */
const TEAM_SUBJECT = Object.freeze({ unit: ['biriminiz', 'your unit'], department: ['bölümünüz', 'your department'], directorate: ['direktörlüğünüz', 'your directorate'] });

function activityClause(scope, locale, counts) {
  const lang = en(locale) ? 1 : 0;
  const inProject = scope.project ? (lang ? [' in the ', s(scope.project), ' project'] : [s(scope.project), ' projesinde ']) : [];
  const subject = scope.person ? [s(scope.person)] : scope.personSicil != null ? [lang ? 'the selected person' : 'seçilen kişi']
    : scope.owner === 'self' ? [lang ? 'you' : 'siz'] : scope.owner === 'team' ? [(TEAM_SUBJECT[scope.level] || ['ekibiniz', 'your team'])[lang]] : null;
  if (lang) {
    if (!counts) return subject ? [...subject, ' recorded no task activity', ...inProject] : ['no task activity was recorded', ...(scope.project ? inProject : [' on the tasks you can see'])];
    return subject ? [...subject, ' recorded ', ...counts, ...inProject] : [...counts, counts.plural ? ' were recorded' : ' was recorded', ...(scope.project ? inProject : [' across the tasks you can see'])];
  }
  const verb = scope.owner === 'self' && !scope.person && scope.personSicil == null ? ['kaydettiniz', 'kaydetmediniz'] : subject ? ['kaydetti', 'kaydetmedi'] : ['kaydedildi', 'kaydedilmedi'];
  const lead = subject ? [...inProject, ...subject, ' '] : scope.project ? inProject : ['görebildiğiniz görevlerde '];
  return counts ? [...lead, ...counts, ` ${verb[0]}`] : [...lead, `hareket ${verb[1]}`];
}

/** Kapsamın kısa adı (çok kapsamlı yanıtta paragraf grubu; olgu değildir). */
function scopeLabel(scope, locale) {
  const lang = en(locale) ? 1 : 0;
  const base = scope.person || (scope.owner === 'self' ? ['Kendi işleriniz', 'Your work'][lang]
    : scope.owner === 'team' ? ({ unit: ['Biriminiz', 'Your unit'], department: ['Bölümünüz', 'Your department'], directorate: ['Direktörlüğünüz', 'Your directorate'] }[scope.level] || ['Ekibiniz', 'Your team'])[lang]
      : scope.project ? null : ['Görebildiğiniz işler', 'Visible work'][lang]);
  return [base, scope.project].filter(Boolean).join(' · ');
}

/** Dönemin zarfı; `open` (bitmemiş dönem) "şu ana kadar" ekini taşır. */
function periodAdverb(range, today, locale, preferred = null, { open = false } = {}) {
  const text = windowAdverb(range, today, locale, preferred);
  return open ? `${text}${en(locale) ? ' so far' : ' şu ana kadar'}` : text;
}

const states = (evidenceId, metrics) => metrics.map((metric) => Object.freeze({ evidenceId, metric }));

/* ── Bulgular ───────────────────────────────────────────────────────── */

/**
 * Dönem okumalarından bulgular. `context`: özetin somut dönemleri ve adları (`{ window, compare, windowName, compareName, defaulted,
 * unsupportedHistory }`); yalnızca adlandırma ve hangi dönemin birincil olduğunu belirlemek içindir, olgu taşımaz.
 */
export function temporalFindings(groups, context = null) {
  const reads = temporalReads(groups);
  if (!reads.length && !context?.unsupportedHistory?.length) return [];
  const findings = [];
  const today = reads.find((read) => read.today)?.today || context?.today || null;
  const byScope = new Map();
  for (const read of reads) {
    const key = scopeKey(read.scope);
    if (!byScope.has(key)) byScope.set(key, { scope: read.scope, reads: [] });
    byScope.get(key).reads.push(read);
  }
  const scopes = [...byScope.values()];
  for (const entry of scopes) {
    const periodReads = entry.reads.filter((read) => ['completed', 'created', 'activity'].includes(read.kind));
    const ranges = [...new Map(periodReads.map((read) => [rangeKey(read.range), read.range])).values()].sort((a, b) => a.dateFrom.localeCompare(b.dateFrom) || a.dateTo.localeCompare(b.dateTo));
    const seriesRead = entry.reads.find((read) => read.kind === 'series');
    // Karşılaştırma: aynı kapsamın aynı tür okuması iki ayrı dönemde. Dönemler kronolojik sıradadır (önce → sonra).
    const pairs = ['completed', 'created', 'activity'].map((kind) => {
      const list = periodReads.filter((read) => read.kind === kind);
      const byRange = new Map(list.map((read) => [rangeKey(read.range), read]));
      return byRange.size === 2 && ranges.length === 2 ? { kind, earlier: byRange.get(rangeKey(ranges[0])), later: byRange.get(rangeKey(ranges[1])) } : null;
    }).filter((pair) => pair?.earlier && pair.later);
    if (pairs.length && ranges.length === 2) {
      findings.push({ kind: 'periodComparison', interpretation: 'comparison', scope: entry.scope, filters: {}, today, ranges, pairs,
        position: windowPosition(ranges[1], today), comparable: comparableWindows(ranges[0], ranges[1]) && windowLength(ranges[0]) === windowLength(ranges[1]), overlap: windowsOverlap(ranges[0], ranges[1]),
        evidenceIds: [...new Set(pairs.flatMap((pair) => [pair.earlier.evidenceId, pair.later.evidenceId]))], completeness: completenessOf(pairs.flatMap((pair) => [pair.earlier, pair.later])),
        names: periodNames(ranges, context) });
    } else {
      // Tek dönemli özet: aynı dönemin okumaları tek paragrafta. Eğilim dizisinin toplam okuması dizinin bulgusuna aittir.
      for (const range of ranges) {
        const list = periodReads.filter((read) => rangeKey(read.range) === rangeKey(range) && !(read.kind === 'completed' && seriesRead && rangeKey(seriesRead.range) === rangeKey(range)
          && !periodReads.some((other) => other !== read && rangeKey(other.range) === rangeKey(range))));
        if (!list.length) continue;
        findings.push({ kind: 'periodSummary', interpretation: 'distribution', scope: entry.scope, filters: {}, today, range, reads: list, position: windowPosition(range, today),
          evidenceIds: [...new Set(list.map((read) => read.evidenceId))], completeness: completenessOf(list), names: periodNames([range], context) });
      }
    }
    if (seriesRead) {
      const total = entry.reads.find((read) => read.kind === 'completed' && rangeKey(read.range) === rangeKey(seriesRead.range)) || null;
      findings.push({ kind: 'completionTrend', interpretation: 'distribution', scope: entry.scope, filters: {}, today, range: seriesRead.range, series: seriesRead, total,
        position: windowPosition(seriesRead.range, today), evidenceIds: [...new Set([seriesRead.evidenceId, ...(total ? [total.evidenceId] : [])])],
        completeness: seriesRead.collectionComplete ? ((total?.undated ?? seriesRead.undated) ? 'partial' : 'complete') : 'incomplete', names: periodNames([seriesRead.range], context),
        // Özet paragrafı aynı dönemi zaten anlattıysa dizi cümlesi toplamı yinelemez.
        summarized: findings.some((item) => item.kind === 'periodSummary' && item.scope === entry.scope && rangeKey(item.range) === rangeKey(seriesRead.range)) });
    }
    const activitySeries = entry.reads.find((read) => read.kind === 'activitySeries');
    if (activitySeries) {
      findings.push({ kind: 'activityTrend', interpretation: 'distribution', scope: entry.scope, filters: {}, today, range: activitySeries.range, series: activitySeries,
        position: windowPosition(activitySeries.range, today), evidenceIds: [activitySeries.evidenceId], completeness: activitySeries.coverage?.status === 'complete' ? 'complete' : 'partial',
        names: periodNames([activitySeries.range], context) });
    }
    const notes = entry.reads.find((read) => read.kind === 'notes');
    if (notes) findings.push({ kind: 'noteDigest', interpretation: 'distribution', scope: entry.scope, filters: notes.filters, range: notes.range, today, shown: notes.shown, total: notes.total, clipped: notes.clipped,
      evidenceIds: [notes.evidenceId], completeness: notes.total != null && notes.shown >= notes.total && !notes.clipped ? 'complete' : 'sample' });
    const horizons = entry.reads.find((read) => read.kind === 'horizons');
    if (horizons?.collectionComplete) {
      findings.push({ kind: 'horizonSpread', interpretation: 'distribution', scope: entry.scope, filters: {}, today, bands: horizons.rows.map((row) => row.value),
        evidenceIds: [horizons.evidenceId], completeness: 'complete' });
    }
  }
  // Geçmiş durumu yeniden kurulamayan yönler (sunucunun türlü kararı; bkz. `expandWith`): bulgu olarak taşınır, anlatım düşüremez.
  if (context?.unsupportedHistory?.length && context.compare) {
    findings.push({ kind: 'historyLimit', interpretation: 'comparison', filters: {}, today, aspects: [...context.unsupportedHistory], ranges: [context.compare, context.window].filter(Boolean),
      evidenceIds: [], completeness: 'unsupported', names: periodNames([context.compare, context.window].filter(Boolean), context) });
  }
  const memberships = groups.flatMap((group) => {
    const fact = group.facts.find((item) => item.semantic?.provenance?.tool === 'rota_task_analytics' && ['actualFinish', 'createdAt'].includes(item.semantic?.filters?.dateField) && ['project', 'assignee', 'unit', 'department'].includes(item.semantic?.groupBy));
    const scope = fact && taskScope(fact.semantic.filters);
    return scope ? [scopeKey(scope)] : [];
  });
  const multi = scopes.length > 1;
  return findings.map((finding) => Object.freeze({ ...finding, ...(finding.scope && memberships.includes(scopeKey(finding.scope)) ? { currentMembership: true } : {}), ...(multi && finding.scope ? { group: scopeLabel(finding.scope, 'tr'), multi: true } : {}), defaulted: context?.defaulted === true }));
}

function completenessOf(reads) {
  if (reads.some((read) => read.kind === 'activity' && read.coverage?.status === 'none')) return 'unknown';
  if (reads.some((read) => (read.kind === 'activity' && read.coverage?.status === 'partial') || (read.kind === 'completed' && read.undated > 0))) return 'partial';
  return 'complete';
}

/** Dönemlerin modelin bildirdiği adları (yalnızca aynı günleri gösteriyorsa kullanılır; bkz. `windowAdverb`). */
function periodNames(ranges, context) {
  return ranges.map((range) => (context?.window && rangeKey(context.window) === rangeKey(range) ? context.windowName || null
    : context?.compare && rangeKey(context.compare) === rangeKey(range) ? context.compareName || null : null));
}

/* ── Anlatım ────────────────────────────────────────────────────────── */

const ASPECT_NAMES = Object.freeze({
  overview: ['genel sayılar', 'overall counts'], status: ['durum dağılımı', 'status breakdown'], priority: ['öncelik dağılımı', 'priority breakdown'],
  deadlines: ['termin dağılımı', 'deadline spread'], overdue: ['gecikmeler', 'overdue work'], upcoming: ['yaklaşan teslimatlar', 'upcoming deliveries'],
  workload: ['iş yükü', 'workload'], projects: ['proje dağılımı', 'project spread'], schedule: ['aylara göre terminler', 'deadlines by month'], critical: ['kritik işler', 'critical work'],
  org: ['alt birim dağılımı', 'sub-unit breakdown'], milestones: ['kilometre taşları', 'milestones']
});

function joinList(items, locale) {
  if (items.length <= 1) return items[0] || [];
  return items.flatMap((item, index) => [...(index ? [index === items.length - 1 ? (en(locale) ? ' and ' : ' ve ') : ', '] : []), ...item]);
}

/** Fark ve (paydası anlamlıysa) yüzde: "(**3** görev fazla, **%25** artış)". */
function difference(earlier, later, unit, locale, { percent = false } = {}) {
  if (earlier === later) return [en(locale) ? ' (no change)' : ' (fark yok)'];
  const diff = Math.abs(later - earlier);
  const up = later > earlier;
  const rate = percent && earlier >= TEMPORAL_LIMITS.minPercentBase ? Math.round((diff / earlier) * 100) : null;
  if (en(locale)) return [' (', n(diff, locale), ` ${up ? 'more' : 'fewer'}`, ...(rate != null && rate > 0 ? [', a ', s(formatPercent(rate, locale)), up ? ' increase' : ' decrease'] : []), ')'];
  return [' (', n(diff, locale), ` ${unit} ${up ? 'fazla' : 'az'}`, ...(rate != null && rate > 0 ? [', ', s(formatPercent(rate, locale)), up ? ' artış' : ' azalış'] : []), ')'];
}

const COMPARED = Object.freeze({
  completed: { noun: ['tamamlanan iş', 'completed work'], unit: 'görev', past: 'görev tamamlanmıştı', now: 'görev tamamlandı', count: 'completed tasks', none: ['tamamlanan görev yok', 'no task was completed'],
    states: ['tasks.total', 'tasks.undatedDone'] },
  created: { noun: ['oluşturulan iş', 'newly created work'], unit: 'görev', past: 'yeni görev oluşturulmuştu ve bugün hâlâ kayıtlı', now: 'yeni görev oluşturuldu ve bugün hâlâ kayıtlı', count: 'newly created tasks still present today',
    none: ['bu dönemde oluşturulmuş ve bugün kayıtlı yeni görev yok', 'no task created in this period is still present today'], states: ['tasks.total', 'tasks.open', 'tasks.done'] },
  activity: { noun: ['kaydedilen hareket', 'recorded activity'], unit: 'hareket', past: 'hareket kaydedilmişti', now: 'hareket kaydedildi', count: 'recorded activity events',
    none: ['hareket kaydedilmedi', 'no activity was recorded'], states: null }
});

const valueOf = (read) => (read.kind === 'activity' ? read.events : read.total);

function comparisonSentences(finding, locale) {
  const lang = en(locale) ? 1 : 0;
  const out = [];
  const [earlier, later] = finding.ranges;
  const open = finding.position?.position === 'current' && finding.position.open;
  const adverb = (range, index, options) => periodAdverb(range, finding.today, locale, finding.names?.[index] || null, options);
  // Hareket kaydı dönemlerden birinin yalnızca bir bölümünü kapsıyorsa o dönemin sayısı alt sınırdır: yön ve yüzde söylenmez.
  const partial = (pair) => pair.kind === 'activity' && [pair.earlier, pair.later].some((read) => read.coverage?.status === 'partial');
  const measured = finding.pairs.filter((pair) => valueOf(pair.earlier) != null && valueOf(pair.later) != null);
  const known = measured.filter((pair) => !partial(pair));
  const unknown = finding.pairs.filter((pair) => !measured.includes(pair));
  const eligible = finding.comparable && windowLength(earlier) === windowLength(later) && !finding.overlap && finding.ranges.every((range) => windowPosition(range, finding.today)?.position === 'past');
  const openNow = open && !finding.overlap;
  // Karşılaştırmanın kendisi önce söylenir (yön); sayılar ardından gelir.
  if (known.length && finding.overlap) {
    // Örtüşen dönemlerde yön söylenmez (aynı iş iki sayıda da yer alabilir); sayılar yan yana verilir.
    out.push({ ...factSentence(lang ? ['The two periods overlap, so they are shown side by side rather than as a change over time.']
      : ['İki dönem örtüştüğü için sayılar bir değişim olarak değil, yan yana veriliyor.']), states: [] });
  } else if (known.length && eligible) {
    const direction = (pair) => Math.sign(valueOf(pair.later) - valueOf(pair.earlier));
    const groups = [[1, lang ? 'rose' : 'arttı'], [-1, lang ? 'fell' : 'azaldı'], [0, lang ? 'did not change' : 'değişmedi']]
      .map(([sign, verb]) => ({ verb, nouns: known.filter((pair) => direction(pair) === sign).map((pair) => COMPARED[pair.kind].noun[lang]) })).filter((group) => group.nouns.length);
    const clause = (group) => `${joinList(group.nouns.map((noun) => [noun]), locale).join('')} ${group.verb}`;
    const body = groups.map(clause).join(lang ? '; ' : '; ');
    const place = known.every((pair) => pair.kind === 'activity') ? activityPlace(finding.scope, locale) : taskPlace(finding.scope, locale);
    // Bitmemiş dönem adıyla anılır ("Bu hafta henüz bitmediği için"); adı yoksa "Sonraki dönem".
    const laterName = windowName(namedWindow(later, finding.today), locale);
    const subject = laterName ? laterName.charAt(0).toLocaleUpperCase(lang ? 'en' : 'tr-TR') + laterName.slice(1) : (lang ? 'The later period' : 'Sonraki dönem');
    const lead = open
      ? (lang ? [subject, ' is still in progress, so the comparison is provisional: ', ...place, ', ', body, ' so far.']
        : [subject, ' henüz bitmediği için karşılaştırma şimdilik geçici: ', ...place, ' şu ana kadar ', body, '.'])
      : (lang ? ['Comparing the two periods ', ...place, ', ', body, '.'] : ['İki dönem karşılaştırıldığında ', ...place, ' ', body, '.']);
    out.push({ ...factSentence(lead), states: [] });
  }
  if (known.length && !eligible && !finding.overlap) out.push({ ...factSentence(open ? (lang ? ['Comparing the two periods, the later period is still in progress; the comparison is provisional and counts are shown side by side.'] : ['İki dönem karşılaştırıldığında ', ...(known.every((pair) => pair.kind === 'activity') ? activityPlace(finding.scope, locale) : taskPlace(finding.scope, locale)), ' sonraki dönem henüz bitmediği için karşılaştırma şimdilik geçici; sayılar yan yana veriliyor.']) : (lang ? ['Comparing the two periods, observation lengths differ; counts are shown side by side.'] : ['İki dönem karşılaştırıldığında gözlem süreleri farklı; sayılar yan yana veriliyor.'])), states: [] });
  for (const pair of known) {
    const spec = COMPARED[pair.kind];
    const a = valueOf(pair.earlier);
    const b = valueOf(pair.later);
    const pairStates = [pair.earlier, pair.later].flatMap((read) => states(read.evidenceId, spec.states || ACTIVITY_STATES));
    // Eşit değerde iki ayrı cümle yerine tek doğal cümle ("İki dönemde de …").
    if (a === b) {
      out.push({ ...factSentence(lang ? ['In both periods, ', ...(a === 0 ? [spec.none[1]] : [`${spec.count} numbered `, n(a, locale)]), '.']
        : ['İki dönemde de ', ...(a === 0 ? [spec.none[0]] : [n(a, locale), ` ${spec.now}`]), '.']), states: pairStates });
      continue;
    }
    out.push({ ...factSentence(lang
      ? [upper(adverb(earlier, 0), locale), `, ${spec.count} numbered `, n(a, locale), '; ', adverb(later, 1, { open }), ', ', n(b, locale), ...(eligible ? difference(a, b, spec.unit, locale, { percent: true }) : []), '.']
      : [upper(adverb(earlier, 0), locale), ' ', n(a, locale), ` ${spec.past}; `, adverb(later, 1, { open }), ' ', n(b, locale), ` ${spec.now}`, ...(eligible ? difference(a, b, spec.unit, locale, { percent: true }) : []), '.']),
    states: pairStates });
  }
  for (const pair of measured.filter(partial)) {
    out.push({ ...factSentence(lang
      ? [upper(adverb(earlier, 0), locale), ', recorded activity events numbered ', n(valueOf(pair.earlier), locale), '; ', adverb(later, 1, { open }), ', ', n(valueOf(pair.later), locale),
        '. The activity record does not cover the whole of the earlier period, so the difference is not interpreted.']
      : [upper(adverb(earlier, 0), locale), ' ', n(valueOf(pair.earlier), locale), ' hareket kaydedilmişti; ', adverb(later, 1, { open }), ' ', n(valueOf(pair.later), locale),
        ' hareket kaydedildi. Hareket kaydı önceki dönemin tamamını kapsamadığından bu fark yorumlanmadı.']),
    states: [pair.earlier, pair.later].flatMap((read) => states(read.evidenceId, ACTIVITY_STATES)) });
  }
  for (const pair of unknown) {
    const both = valueOf(pair.earlier) == null && valueOf(pair.later) == null;
    const missing = valueOf(pair.earlier) == null ? [earlier, 0] : [later, 1];
    const other = both ? null : valueOf(pair.earlier) == null ? valueOf(pair.later) : valueOf(pair.earlier);
    const first = (pair.earlier.coverage || pair.later.coverage)?.firstRecordedDay || null;
    const begins = first ? (lang ? [' (records begin on ', s(formatFactDay(first, locale)), ')'] : [' (kayıtlar ', s(formatFactDay(first, locale)), ' tarihinde başlıyor)']) : [];
    out.push({ ...factSentence(both
      ? (lang ? ['Recorded activity cannot be compared: there is no activity record for either period', ...begins, '. Both are unknown, not zero.']
        : ['Kaydedilen hareketler karşılaştırılamıyor: iki dönem için de hareket kaydı yok', ...begins, '. Bu dönemler bilinmiyor; sıfır sayılmadı.'])
      : lang
      ? ['Recorded activity cannot be compared: there is no activity record for ', windowPhrase(missing[0], finding.today, locale), ...begins, '. That period is unknown, not zero',
        ...(other != null ? ['; in the other period ', n(other, locale), other === 1 ? ' activity event was recorded' : ' activity events were recorded'] : []), '.']
      : ['Kaydedilen hareketler karşılaştırılamıyor: ', windowPhrase(missing[0], finding.today, locale), ' için hareket kaydı yok', ...begins, '. Bu dönem bilinmiyor; sıfır sayılmadı',
        ...(other != null ? ['; öteki dönemde ', n(other, locale), ' hareket kaydedildi'] : []), '.']), caveat: true,
    states: [...states(pair.earlier.evidenceId, ACTIVITY_STATES), ...states(pair.later.evidenceId, ACTIVITY_STATES)] });
  }
  if (finding.pairs.some((pair) => pair.kind === 'activity')) out.push({ ...factSentence(en(locale) ? ['Activity counts refer to actions by ', ...(finding.scope.owner === 'self' ? ['you'] : finding.scope.owner === 'team' ? [(TEAM_SUBJECT[finding.scope.level] || ['ekibiniz', 'your team'])[1]] : [finding.scope.person || 'the selected visible actors']), ', independently of task assignment.'] : ['Hareket sayıları görev sorumluluğuna göre değil, ', ...(finding.scope.owner === 'self' ? ['sizin'] : finding.scope.owner === 'team' ? [(TEAM_OF[finding.scope.level] || ['ekibinizin'])[0]] : [finding.scope.person || 'görünür işlem yapanların']), ' kaydettiği işlemlere göredir.']), caveat: true, states: [] });
  if (finding.pairs.some((pair) => pair.kind === 'created')) out.push(createdBasisSentence(locale));
  for (const item of comparisonCaveats(finding, locale, { open })) out.push(item);
  return out;
}

const ACTIVITY_STATES = Object.freeze(['activity.events', 'activity.tasks', 'activity.people', 'activity.completedTasks', 'activity.createdTasks', 'activity.deletedTasks',
  'activity.updatedTasks', 'activity.reopenedTasks']);

function comparisonCaveats(finding, locale, { open }) {
  const lang = en(locale) ? 1 : 0;
  const out = [];
  const add = (parts, extra = {}) => out.push({ ...factSentence(parts), caveat: true, states: [], ...extra });
  const [earlier, later] = finding.ranges;
  if (finding.overlap) {
    add(lang ? ['Because the periods share some days, the same work can be counted in both; no percentage change is given.']
      : ['Dönemler bazı günleri paylaştığından aynı iş iki sayıda da yer alabilir; yüzde değişim verilmedi.']);
  } else if (open) {
    // Açılış cümlesi dönemin bitmediğini söylemiştir: çekince yalnızca konumu ve yüzde değişimin neden verilmediğini ekler.
    add(lang ? ['Today is day ', n(finding.position.elapsedDays, locale), ' of ', n(finding.position.length, locale), '; a percentage change is given only once the period has ended.']
      : ['Bugün ', n(finding.position.length, locale), ' günlük dönemin ', n(finding.position.elapsedDays, locale), '. günü; yüzde değişim dönem bitmeden verilmez.']);
  } else if (!finding.comparable) {
    add(lang ? ['The periods differ in length (', n(windowLength(earlier), locale), ' and ', n(windowLength(later), locale), ' days), so the counts are shown side by side without a percentage change.']
      : ['Dönemlerin uzunluğu farklı (', n(windowLength(earlier), locale), ' ve ', n(windowLength(later), locale), ' gün) olduğundan sayılar yan yana verildi, yüzde değişim hesaplanmadı.']);
  }
  const completed = finding.pairs.find((pair) => pair.kind === 'completed');
  const undated = completed ? Math.max(completed.earlier.undated || 0, completed.later.undated || 0) : 0;
  if (undated > 0) out.push(undatedSentence(undated, locale, [completed.earlier.evidenceId, completed.later.evidenceId]));
  const partial = finding.pairs.filter((pair) => pair.kind === 'activity').flatMap((pair) => [pair.earlier, pair.later]).find((read) => read.coverage?.status === 'partial');
  if (partial) out.push(coverageSentence(partial, locale));
  const reopened = finding.pairs.filter((pair) => pair.kind === 'activity').map((pair) => pair.later).find((read) => read.reopened > 0);
  if (reopened) out.push(reopenedSentence(reopened, locale));
  return out;
}

function undatedSentence(undated, locale, evidenceIds) {
  return { ...factSentence(en(locale)
    ? [n(undated, locale), undated === 1 ? ' completed task has' : ' completed tasks have', ' no recorded actual finish date, so ', undated === 1 ? 'it' : 'they', ' could not be placed in any period and ',
      undated === 1 ? 'is' : 'are', ' not in these counts.']
    : ['Tamamlanmış ', n(undated, locale), ' görevin gerçekleşen bitiş tarihi kayıtlı olmadığından bu görevler hiçbir döneme yerleştirilemedi ve sayılara girmedi.']),
  caveat: true, states: evidenceIds.flatMap((id) => states(id, ['tasks.undatedDone'])) };
}

function coverageSentence(read, locale) {
  const first = read.coverage.firstRecordedDay;
  return { ...factSentence(en(locale)
    ? ['Activity records begin on ', s(formatFactDay(first, locale)), ', so the part of the period before that date is not reflected in these counts.']
    : ['Hareket kaydı ', s(formatFactDay(first, locale)), ' tarihinde başladığından dönemin bu tarihten önceki bölümü sayılara yansımıyor.']), caveat: true, states: [] };
}

function reopenedSentence(read, locale) {
  return { ...factSentence(en(locale)
    ? [n(read.reopened, locale), read.reopened === 1 ? ' task was' : ' tasks were', ' reopened in this period after an earlier completion; a completion event does not mean the task is complete today.']
    : ['Bu dönemde ', n(read.reopened, locale), ' görev önceki tamamlanmasının ardından yeniden açıldı; tamamlama hareketi görevin bugün tamamlanmış olduğu anlamına gelmez.']),
  caveat: true, states: states(read.evidenceId, ['activity.reopenedTasks']) };
}

/** Tek dönemin özeti: tamamlanan, oluşturulan ve kaydedilen hareketler bağlantılı cümlelerle. */
function summarySentences(finding, locale) {
  const lang = en(locale) ? 1 : 0;
  const out = [];
  const open = finding.position?.position === 'current' && finding.position.open;
  const adverb = upper(periodAdverb(finding.range, finding.today, locale, finding.names?.[0] || null, { open }), locale);
  const place = taskPlace(finding.scope, locale);
  const same = lang ? 'In the same period' : 'Aynı dönemde';
  let opened = false;
  const lead = (taskBased = true) => {
    const first = !opened;
    opened = true;
    if (!first) return [same, lang ? ', ' : ' '];
    return taskBased ? (lang ? [adverb, ', ', ...place, ', '] : [adverb, ' ', ...place, ' ']) : (lang ? [adverb, ', '] : [adverb, ' ']);
  };
  const completed = finding.reads.find((read) => read.kind === 'completed');
  const created = finding.reads.find((read) => read.kind === 'created');
  const activity = finding.reads.find((read) => read.kind === 'activity');
  if (completed && completed.total != null) {
    out.push({ ...factSentence(completed.total === 0
      ? (lang ? [...lead(), 'no task has a recorded completion date.'] : [...lead(), 'gerçekleşen bitişi kayıtlı tamamlanan görev yok.'])
      : (lang ? [...lead(), n(completed.total, locale), completed.total === 1 ? ' task was completed' : ' tasks were completed', ' (by recorded actual finish date).']
        : [...lead(), n(completed.total, locale), ' görev tamamlandı (gerçekleşen bitiş tarihine göre).'])), states: states(completed.evidenceId, ['tasks.total']) });
  }
  if (created && created.total != null) {
    const tail = created.total > 0 && created.done > 0
      ? (lang ? ['; ', n(created.done, locale), ' of them ', created.done === 1 ? 'is' : 'are', ' already complete'] : ['; bunların ', n(created.done, locale), ' tanesi şimdiden tamamlandı']) : [];
    out.push({ ...factSentence(created.total === 0
      ? (lang ? [...lead(), 'no task created in this period is still present today.'] : [...lead(), 'bu dönemde oluşturulmuş ve bugün kayıtlı yeni görev yok.'])
      : (lang ? [...lead(), n(created.total, locale), created.total === 1 ? ' new task was created and is still present today' : ' new tasks were created and are still present today', ...tail, '.']
        : [...lead(), n(created.total, locale), ' yeni görev oluşturuldu ve bugün hâlâ kayıtlı', ...tail, '.'])), states: states(created.evidenceId, ['tasks.total', 'tasks.done', 'tasks.open']) });
  }
  if (created) out.push(createdBasisSentence(locale));
  if (activity) {
    if (activity.events == null) {
      const first = activity.coverage?.firstRecordedDay || null;
      const period = periodAdverb(finding.range, finding.today, locale, finding.names?.[0] || null);
      out.push({ ...factSentence(lang
        ? ['There is no activity record ', period, ...(first ? [' (records begin on ', s(formatFactDay(first, locale)), ')'] : []), '. The activity count for this period is unknown, not zero.']
        : [upper(period, locale), ' için hareket kaydı bulunmuyor', ...(first ? [' (hareket kaydı ', s(formatFactDay(first, locale)), ' tarihinde başlıyor)'] : []),
          '. Bu dönemin hareket sayısı bilinmiyor; sıfır kabul edilmedi.']), caveat: true, states: states(activity.evidenceId, ACTIVITY_STATES) });
      opened = true;
    } else if (activity.events === 0) {
      out.push({ ...factSentence([...lead(false), ...activityClause(finding.scope, locale, null), '.']), states: states(activity.evidenceId, ACTIVITY_STATES) });
    } else {
      const kinds = [[activity.completed, lang ? ['task completed', 'tasks completed'] : 'görev tamamlandı'], [activity.created, lang ? ['task created', 'tasks created'] : 'görev oluşturuldu'],
        [activity.deleted, lang ? ['task deleted', 'tasks deleted'] : 'görev silindi'], [activity.updated, lang ? ['task only updated', 'tasks only updated'] : 'görev yalnızca güncellendi']]
        .filter(([value]) => value > 0).map(([value, label]) => [n(value, locale), ` ${Array.isArray(label) ? label[value === 1 ? 0 : 1] : label}`]);
      const counts = Object.assign(lang
        ? [n(activity.events, locale), activity.events === 1 ? ' activity event on ' : ' activity events on ', n(activity.tasks, locale), activity.tasks === 1 ? ' task' : ' tasks']
        : [n(activity.tasks, locale), ' görev üzerinde ', n(activity.events, locale), ' hareket'], { plural: activity.events !== 1 });
      // Kaç kişinin kaydettiği yalnızca birden çok kişinin olabildiği kapsamda (görünür işler, ekip, proje) bilgi taşır.
      const people = activity.people > 0 && !(finding.scope.owner === 'self' || finding.scope.personSicil != null)
        ? (lang ? ['; ', n(activity.people, locale), activity.people === 1 ? ' person' : ' people', ' recorded them'] : ['; hareketleri ', n(activity.people, locale), ' kişi kaydetti']) : [];
      out.push({ ...factSentence([...lead(false), ...activityClause(finding.scope, locale, counts), ...(kinds.length ? [': ', ...joinList(kinds, locale)] : []), ...people, '.']),
        states: states(activity.evidenceId, ACTIVITY_STATES) });
      if (activity.reopened > 0) out.push(reopenedSentence(activity, locale));
    }
    if (activity.events != null && activity.coverage?.status === 'partial') out.push(coverageSentence(activity, locale));
  }
  if (completed?.undated > 0) out.push(undatedSentence(completed.undated, locale, [completed.evidenceId]));
  else if (completed && out.length) out[0] = { ...out[0], states: [...(out[0].states || []), ...states(completed.evidenceId, ['tasks.undatedDone'])] };
  if (open && out.length) {
    out.push({ ...factSentence(lang ? ['The period has not ended yet, so these counts can still change.'] : ['Dönem henüz bitmediğinden bu sayılar değişebilir.']), caveat: true, states: [] });
  }
  return out;
}

/** Tamamlanma dizisinin okuması: toplam, en yoğun kova ve (yeterli tam kova varsa) dönem sonuna doğru yön. */
function trendSentences(finding, locale) {
  const lang = en(locale) ? 1 : 0;
  const out = [];
  const { series, total } = finding;
  const week = series.bucket === 'week';
  const unit = lang ? (week ? 'week' : 'month') : (week ? 'hafta' : 'ay');
  const label = (row) => s(lang ? englishBucketLabel(row.label) : row.label);
  const adverb = upper(periodAdverb(finding.range, finding.today, locale, finding.names?.[0] || null), locale);
  const place = taskPlace(finding.scope, locale);
  const sum = series.rows.reduce((acc, row) => acc + (row.value || 0), 0);
  const seriesStates = states(series.evidenceId, ['tasks.total', 'tasks.groupCount']);
  if (!series.collectionComplete) {
    out.push({ ...factSentence(lang ? ['The completion series could not be read in full, so no trend is stated.'] : ['Tamamlanma dizisi eksiksiz okunamadığından eğilim söylenmedi.']), caveat: true, states: [] });
    return out;
  }
  if (!finding.summarized) {
    out.push({ ...factSentence(sum === 0
      ? (lang ? [adverb, ', ', ...place, ', no task has a recorded completion date.'] : [adverb, ' ', ...place, ' gerçekleşen bitişi kayıtlı tamamlanan görev yok.'])
      : (lang ? [adverb, ', ', ...place, ', ', n(sum, locale), sum === 1 ? ' task was completed' : ' tasks were completed', ' (by recorded actual finish date).']
        : [adverb, ' ', ...place, ' ', n(sum, locale), ' görev tamamlandı (gerçekleşen bitiş tarihine göre).'])),
    states: [...seriesStates, ...(total ? states(total.evidenceId, ['tasks.total']) : [])] });
  }
  const undated = total?.undated ?? series.undated ?? 0;
  const full = series.rows.filter((row) => !row.partial && endedBucket(row, series.bucket, finding.today));
  if (sum > 0) {
    const max = Math.max(...full.map((row) => row.value));
    const peaks = full.filter((row) => row.value === max);
    if (full.length >= 2 && peaks.length === 1) {
      out.push({ ...factSentence(lang ? [`The busiest ${unit} was `, label(peaks[0]), ' with ', n(max, locale), max === 1 ? ' task.' : ' tasks.']
        : [`En yoğun ${unit} `, label(peaks[0]), ' oldu (', n(max, locale), ' görev).']), states: seriesStates });
    }
    // Yön: son üç TAM kovanın toplamı ile ondan önceki üç tam kovanın toplamı (şeffaf ölçüt; kısmi uç kovalar kullanılmaz).
    const span = TEMPORAL_LIMITS.trendSpan;
    // Kısa dizide eğilim zaten söylenemez; tarihi kayıtlı olmayan görevlerin ağırlığı yalnızca eğilim yorumlanabilecekken engeldir.
    if (undated > sum && full.length >= TEMPORAL_LIMITS.minTrendBuckets) {
      out.push({ ...factSentence(lang
        ? ['More completed tasks lack a recorded finish date than have one, so the series does not represent completed work as a whole and no trend is drawn from it.']
        : ['Gerçekleşen bitişi kayıtlı olmayan tamamlanmış görevler kayıtlı olanlardan fazla olduğundan dizi tamamlanan işin bütününü temsil etmiyor; bu diziden eğilim çıkarılmadı.']),
      caveat: true, states: [] });
    } else if (full.length >= span * 2) {
      const recent = full.slice(-span).reduce((acc, row) => acc + row.value, 0);
      const prior = full.slice(-span * 2, -span).reduce((acc, row) => acc + row.value, 0);
      const verdict = recent > prior ? (lang ? 'the pace of completion picked up towards the end of the period' : 'tamamlanma hızı dönemin sonuna doğru arttı')
        : recent < prior ? (lang ? 'the pace of completion slowed towards the end of the period' : 'tamamlanma hızı dönemin sonuna doğru yavaşladı')
          : (lang ? 'the pace of completion stayed level' : 'tamamlanma hızı aynı düzeyde kaldı');
      out.push({ ...factSentence(lang
        ? ['The last ', n(span, locale), ` full ${unit}s saw `, n(recent, locale), ' completions against ', n(prior, locale), ` in the ${span} before them: ${verdict}.`]
        : ['Son ', n(span, locale), ` tam ${unit}da toplam `, n(recent, locale), ` görev tamamlandı; önceki ${span} ${unit}da bu sayı `, n(prior, locale), ` idi: ${verdict}.`]),
      states: seriesStates, interpretive: true });
    } else if (full.length >= TEMPORAL_LIMITS.minTrendBuckets) {
      const [previous, last] = full.slice(-2);
      out.push({ ...factSentence(lang
        ? [`In the last full ${unit} (`, label(last), '), ', n(last.value, locale), last.value === 1 ? ' task was' : ' tasks were', ` completed; in the ${unit} before, `, n(previous.value, locale),
          `. With only `, n(full.length, locale), ` full ${unit}s, this is too short a series to call a trend.`]
        : [`Son tam ${unit}da (`, label(last), ') ', n(last.value, locale), ` görev, bir önceki ${unit}da `, n(previous.value, locale), ' görev tamamlandı. Yalnızca ', n(full.length, locale),
          ` tam ${unit} olduğundan bu dizi eğilim söylemek için kısa.`]), states: seriesStates });
    } else {
      out.push({ ...factSentence(lang
        ? ['The range contains only ', n(full.length, locale), ` full ${unit}${full.length === 1 ? '' : 's'}, which is not enough to state a trend; a longer period is needed.`]
        : ['Bu aralık yalnızca ', n(full.length, locale), ` tam ${unit} içerdiğinden eğilim söylenemez; bunun için daha uzun bir dönem gerekir.`]), caveat: true, states: seriesStates });
    }
  }
  if (undated > 0) out.push(undatedSentence(undated, locale, [total?.evidenceId || series.evidenceId]));
  else if (total && out.length) out.at(-1).states = [...(out.at(-1).states || []), ...states(total.evidenceId, ['tasks.total', 'tasks.undatedDone'])];
  if (series.rows.some((row) => row.partial) && full.length >= TEMPORAL_LIMITS.minTrendBuckets && sum > 0) {
    out.push({ ...factSentence(lang ? [`The first or last ${unit} of the range is not a full ${unit} and is left out of this reading.`]
      : [`Aralığın ilk ya da son ${week ? 'haftası' : 'ayı'} tam ${unit} olmadığından bu okumaya katılmadı.`]), caveat: true, states: [] });
  }
  return out;
}

/** Kaydedilen hareketlerin dizisi: yalnızca kaydı olan kovalar; kayıt başlangıcından önceki kova bilinmeyendir. */
function activityTrendSentences(finding, locale) {
  const lang = en(locale) ? 1 : 0;
  const { series } = finding;
  const week = series.bucket === 'week';
  const unit = lang ? (week ? 'week' : 'month') : (week ? 'hafta' : 'ay');
  const label = (row) => s(lang ? englishBucketLabel(row.label) : row.label);
  const recorded = series.rows.filter((row) => row.recorded && row.value != null && !row.partial && endedBucket(row, series.bucket, finding.today));
  const out = [];
  const seriesStates = states(series.evidenceId, ['activity.events', 'activity.completionEvents']);
  const missing = series.rows.filter((row) => !row.recorded || row.value == null).length;
  if (missing > 0) out.push({ ...factSentence(lang ? ['Some earlier periods have no activity record; those are unknown, not zero.'] : ['Önceki dönemler için hareket kaydı yok; bu kovalar bilinmiyor, sıfır sayılmadı.']), caveat: true, states: seriesStates });
  if (series.rows.some((row) => row.partial)) out.push({ ...factSentence(lang ? ['Partially recorded or unfinished buckets are excluded from the peak comparison.'] : ['Kısmen kayıtlı ya da bitmemiş kovalar en yoğun dönem karşılaştırmasına katılmadı.']), caveat: true, states: seriesStates });
  if (!recorded.length) return out;
  const max = Math.max(...recorded.map((row) => row.value));
  const peaks = recorded.filter((row) => row.value === max);
  if (max > 0 && recorded.length >= 2 && peaks.length === 1) {
    out.push({ ...factSentence(lang ? [`Recorded activity peaked in the ${unit} of `, label(peaks[0]), ' (', n(max, locale), max === 1 ? ' event).' : ' events).']
      : [`Kaydedilen hareketler en çok `, label(peaks[0]), ` ${unit === 'hafta' ? 'haftasında' : 'ayında'} yoğunlaştı (`, n(max, locale), ' hareket).']), states: seriesStates });
  }
  return out;
}

function horizonSentences(finding, locale) {
  const lang = en(locale) ? 1 : 0;
  const [first, second, third] = finding.bands;
  const seven = first;
  const fourteen = first + second;
  const thirty = first + second + third;
  const out = [];
  const place = taskPlace(finding.scope, locale);
  const horizonStates = states(finding.evidenceIds[0], ['tasks.total', 'tasks.groupCount']);
  if (thirty === 0) {
    out.push({ ...factSentence(lang ? ['In the next 30 days, no open task is due ', ...place, '.'] : ['Önümüzdeki 30 gün içinde ', ...place, ' termini olan açık görev yok.']), states: horizonStates });
    return out;
  }
  out.push({ ...factSentence(lang
    ? ['Counting from today, ', ...place, ', ', n(seven, locale), ' open tasks are due within 7 days, ', n(fourteen, locale), ' within 14 days and ', n(thirty, locale),
      ' within 30 days; the counts are cumulative.']
    : ['Bugünden itibaren ', ...place, ' 7 gün içinde ', n(seven, locale), ', 14 gün içinde ', n(fourteen, locale), ', 30 gün içinde ', n(thirty, locale),
      ' açık görevin termini var; sayılar birikimlidir.']), states: horizonStates });
  if (seven * 2 > thirty) {
    out.push({ ...factSentence(lang ? ['More than half of the next 30 days’ deliveries fall in the first week.'] : ['Önümüzdeki 30 günün teslimatlarının yarısından fazlası ilk haftada toplanıyor.']),
      states: [], interpretive: true });
  } else if (third * 2 > thirty) {
    out.push({ ...factSentence(lang ? ['More than half of the next 30 days’ deliveries fall after the second week.'] : ['Önümüzdeki 30 günün teslimatlarının yarısından fazlası ikinci haftadan sonraya düşüyor.']),
      states: [], interpretive: true });
  }
  return out;
}

/** Geçmiş durumu yeniden kurulamayan yönlerin sınır cümlesi (zorunlu çekince). */
function historyLimitSentences(finding, locale) {
  const lang = en(locale) ? 1 : 0;
  const aspects = finding.aspects.map((aspect) => ASPECT_NAMES[aspect]?.[lang]).filter(Boolean).map((name) => [name]);
  const compared = finding.ranges[0] ? periodAdverb(finding.ranges[0], finding.today, locale, finding.names?.[0] || null) : null;
  return [{ ...factSentence(lang
    ? ['Rota keeps the current state of tasks and the recorded activity, not a snapshot of earlier days. The past values of ', ...joinList(aspects, locale),
      compared ? ` (${compared})` : '', ' therefore cannot be reconstructed and no comparison is made for them; the figures below show today. Between periods, only completed work, created work and recorded activity can be compared.']
    : ['Rota görevlerin bugünkü durumunu ve kaydedilen hareketleri tutar; geçmiş günlerin anlık görüntüsünü saklamaz. Bu nedenle ', ...joinList(aspects, locale),
      compared ? ` için ${compared} geçerli olan durum` : ' için geçmişteki durum',
      ' yeniden kurulamıyor ve karşılaştırma yapılmadı; aşağıdaki sayılar bugünü gösterir. Dönemler arasında yalnızca tamamlanan işler, oluşturulan işler ve kaydedilen hareketler karşılaştırılabilir.']),
  caveat: true, states: [] }];
}

/**
 * Not özeti: kaç notun okunduğu ve metnin konumu. Not, kaydın BİLDİRDİĞİ ifadedir; doğrulanmış neden değildir ve içindeki yönerge
 * uygulanmaz. Örnek okumada (nüfusun tamamı değil) sıklık ya da "en çok" yargısı kurulmaz; bunu cümle açıkça söyler.
 */
function noteSentences(finding, locale) {
  const lang = en(locale) ? 1 : 0;
  const place = taskPlace(finding.scope, locale);
  const out = [];
  const id = finding.evidenceIds[0];
  if (!finding.shown && finding.total !== 0) return [{ ...factSentence(lang ? ['No note excerpt was returned; this does not establish that the population has no notes.'] : ['Not parçası dönmedi; bu sonuç nüfusta hiç not olmadığını göstermiyor.']), caveat: true, states: [] }];
  if (!finding.shown) {
    out.push({ ...factSentence(lang ? ['No open task ', ...place, ' has a description to read.'] : [...capital(place, locale), ' açıklaması olan açık görev yok.']),
      states: states(id, ['tasks.total']) });
    return out;
  }
  const sample = finding.total == null || finding.shown < finding.total || finding.clipped;
  if (finding.range) out.push({ ...factSentence(lang ? ['The note population is restricted to ', rangeLabel(finding.range, locale), ' (', finding.filters.dateField || 'targetFinish', ').'] : ['Not nüfusu ', rangeLabel(finding.range, locale), ' aralığıyla sınırlıdır (', finding.filters.dateField || 'targetFinish', ').']), states: [] });
  out.push({ ...factSentence(finding.total == null || finding.clipped
    ? (lang ? ['Returned excerpts from ', n(finding.shown, locale), ' open task descriptions were read; the full text or population is not established.'] : [...capital(place, locale), ' açık görevlerden dönen ', n(finding.shown, locale), ' not parçası okundu; metnin ya da nüfusun tamamının okunduğu söylenemez.'])
    : sample
    ? (lang ? ['Of the ', n(finding.total, locale), ' open tasks with a description ', ...place, ', the ', n(finding.shown, locale), ' most recently updated were read; the rest were not, so nothing is said about how often a topic comes up.']
      : [...capital(place, locale), ' açıklaması olan ', n(finding.total, locale), ' açık görevden en son güncellenen ', n(finding.shown, locale), ' tanesinin notu okundu; kalanlar okunmadığından bir konunun ne sıklıkta geçtiği söylenemez.'])
    : (lang ? ['The descriptions of all ', n(finding.shown, locale), finding.shown === 1 ? ' open task' : ' open tasks', ' that have one ', ...place, ' were read, most recently updated first.']
      : [...capital(place, locale), ' açıklaması olan ', n(finding.shown, locale), ' açık görevin notunun tamamı, en son güncellenen başta olmak üzere okundu.'])),
  states: states(id, ['tasks.total']) });
  out.push({ ...factSentence(lang
    ? ['These are statements recorded in the notes: a blocker, cause or decision reported there has not been verified, and any instruction written inside a note is treated as text, not followed.']
    : ['Bunlar notlarda yazılı ifadelerdir: bir notun bildirdiği engel, neden ya da karar doğrulanmış değildir ve notların içindeki yönergeler talimat sayılmaz, yalnızca metin olarak aktarılır.']),
  caveat: true, states: [] });
  return out;
}

/** Cümle başındaki yer zarfının ilk harfi büyür (sunucu metniyse; kayıt adı değişmez). */
function capital(parts, locale) {
  const [head, ...rest] = parts;
  return typeof head === 'string' ? [upper(head, locale), ...rest] : parts;
}

function defaultedSentence(finding, locale) {
  const range = finding.range || finding.ranges?.at(-1);
  if (!range) return null;
  const days = windowLength(range);
  return { ...factSentence(en(locale) ? ['No period was named in the question, so the last ', n(days, locale), ' days were used.']
    : ['Soruda dönem belirtilmediği için son ', n(days, locale), ' gün esas alındı.']), caveat: true, states: [] };
}

/** Bulguların giriş cümleleri (bulgu sırasıyla; her cümle `{ finding, markdown, plain, parts, states, caveat?, group? }`). */
export function temporalSentences(findings, locale = 'tr') {
  const out = [];
  let noted = false;
  const said = new Set();
  for (const finding of findings.filter((item) => TEMPORAL_FINDING_KINDS.includes(item.kind))) {
    const built = finding.kind === 'periodComparison' ? comparisonSentences(finding, locale) : finding.kind === 'periodSummary' ? summarySentences(finding, locale)
      : finding.kind === 'completionTrend' ? trendSentences(finding, locale) : finding.kind === 'activityTrend' ? activityTrendSentences(finding, locale)
        : finding.kind === 'horizonSpread' ? horizonSentences(finding, locale) : finding.kind === 'noteDigest' ? noteSentences(finding, locale) : historyLimitSentences(finding, locale);
    if (finding.currentMembership) built.push({ ...factSentence(en(locale) ? ['Groups reflect current project, assignee or organizational membership; membership during the historical period is unknown.'] : ['Gruplar görevlerin bugünkü proje, sorumlu ya da birim üyeliğine göredir; geçmiş dönemdeki üyelik bilinmiyor.']), caveat: true, states: [] });
    if (finding.defaulted && !noted && built.length && !['horizonSpread', 'historyLimit', 'noteDigest'].includes(finding.kind)) {
      const note = defaultedSentence(finding, locale);
      if (note) built.push(note);
      noted = true;
    }
    const group = finding.multi ? scopeLabel(finding.scope, locale) : null;
    for (const original of built) {
      const item = original.caveat && group ? { ...original, ...factSentence([group, ': ', ...original.parts]) } : original;
      // Aynı çekince (tarihi kayıtlı olmayan görevler, kayıt başlangıcı, yeniden açma) yanıtta bir kez söylenir.
      const caveatKey = JSON.stringify([finding.scope ? scopeKey(finding.scope) : null, item.markdown]);
      if (item.caveat && said.has(caveatKey)) continue;
      if (item.caveat) said.add(caveatKey);
      out.push({ finding, ...item, states: Object.freeze([...(item.states || [])]), ...(group != null ? { group } : {}) });
    }
  }
  // Çok kapsamlı dönem yanıtında kapsamlar iç içe olabilir (ekibin hareketleri kullanıcının kendi hareketlerini de içerir): toplanmaz.
  const scoped = findings.filter((item) => item.multi && item.scope);
  // İç içelik yalnızca kişi/proje daraltması taşımayan kapsamlar arasında kesindir: kendi ⊂ ekip ⊂ görünen işler; birim ⊂ bölüm.
  const plain = scoped.filter((item) => !item.scope.projectId && item.scope.personSicil == null);
  const owners = new Set(plain.map((item) => item.scope.owner));
  const levels = new Set(plain.filter((item) => item.scope.owner === 'team').map((item) => item.scope.level));
  if (plain.length > 1 && (owners.size > 1 || levels.size > 1)) {
    const last = scoped.at(-1);
    out.push({ finding: last, ...factSentence(en(locale) ? ['Scope overlap is not established; counts are shown separately and no combined total is inferred.']
      : ['Kapsamların örtüşmesi belirlenmiş değildir; sayılar ayrı okunur, birleşik toplam için doğrudan toplanmaz.']), caveat: true, states: Object.freeze([]), group: scopeLabel(last.scope, locale) });
  }
  return out;
}

/** Dönem karşılaştırmasının çubuk grafik adayları: her ölçü için iki dönemin doğrulanmış değeri (bilinmeyen değerle grafik kurulmaz). */
export function comparisonCharts(finding, locale = 'tr') {
  if (finding.kind !== 'periodComparison') return [];
  const lang = en(locale) ? 1 : 0;
  const titles = { completed: ['Tamamlanan görev', 'Completed tasks'], created: ['Oluşturulan görev', 'Created tasks'], activity: ['Kaydedilen hareket', 'Recorded activity'] };
  // İki çubuk aynı biçimde adlandırılır: iki dönemin de adı varsa adlar ("Geçen ay", "Bu ay"), biri adsızsa ikisi de tarih aralığı.
  const named = finding.ranges.every((range, index) => finding.names?.[index] || namedWindow(range, finding.today));
  const label = (range, index) => (named ? upper(windowAdverb(range, finding.today, locale, finding.names?.[index] || null).replace(/ \(.*\)$/u, '').replace(/ döneminde$| günü$|^in |^on /u, ''), locale)
    : rangeLabel(range, locale));
  return finding.pairs.filter((pair) => valueOf(pair.earlier) != null && valueOf(pair.later) != null && (pair.kind !== 'activity' || [pair.earlier, pair.later].every((read) => read.coverage?.status === 'complete'))).map((pair) => ({
    kind: pair.kind, title: titles[pair.kind][lang], evidenceIds: [pair.earlier.evidenceId, pair.later.evidenceId],
    items: [{ label: label(finding.ranges[0], 0), value: valueOf(pair.earlier) }, { label: label(finding.ranges[1], 1), value: valueOf(pair.later) }],
    change: Math.abs(valueOf(pair.later) - valueOf(pair.earlier)) }));
}

/* ── Gövde sunumu için kapsama ──────────────────────────────────────── */

/**
 * Dönem bulgularının ANLATTIĞI kanıtlar: gövdede bu kanıtların sayım ve "en büyük grup" önermeleri yinelenmez (giriş paragrafı
 * aynı sayıları söylemiştir); tablo ve grafik kalır. Dönemde tamamlananların satır listesi, aynı nüfusun sayım okuması varsa
 * kapsanmış sayılır. Dönüş: `evidenceId → { kind, total?, bucket? }`.
 */
export function temporalCoverage(parts) {
  const groups = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    const map = new Map();
    for (const item of part.presentation?.facts || []) {
      if (!item?.fact || typeof item.evidenceId !== 'string') continue;
      if (!map.has(item.evidenceId)) map.set(item.evidenceId, []);
      map.get(item.evidenceId).push(item.fact);
    }
    for (const [evidenceId, facts] of map) groups.push({ part: part.index + 1, evidenceId, facts });
  }
  const covered = new Map();
  const reads = temporalReads(groups);
  for (const read of reads) {
    if (read.kind === 'series') covered.set(read.evidenceId, { kind: 'series', bucket: read.bucket, basis: 'completed' });
    else if (read.kind === 'activitySeries') covered.set(read.evidenceId, { kind: 'activitySeries', bucket: read.bucket });
    else if (read.kind === 'horizons') covered.set(read.evidenceId, { kind: 'horizons' });
    else if (read.kind === 'notes') covered.set(read.evidenceId, { kind: 'notes' });
  }
  const completed = reads.filter((read) => read.kind === 'completed');
  for (const group of groups) {
    if (covered.has(group.evidenceId)) continue;
    const sample = group.facts.find((fact) => fact?.semantic?.filters && fact.semantic.provenance?.tool);
    const filters = sample?.semantic.filters;
    if (sample?.semantic.provenance.tool !== 'rota_task_search' || filters?.dateField !== 'actualFinish' || filters.statuses?.length !== 1 || filters.statuses[0] !== 'done') continue;
    const scope = taskScope(filters);
    const peer = scope && completed.find((read) => scopeKey(read.scope) === scopeKey(scope) && read.range?.dateFrom === filters.dateFrom && read.range?.dateTo === filters.dateTo);
    if (peer) covered.set(group.evidenceId, { kind: 'completedList', total: peer.total });
  }
  return covered;
}

/** Dönemde tamamlananların listesinin giriş cümlesi: gösterilen satır sayısı ve (liste kısaysa) nüfusun tamamı. Olgular aynı kanıttandır. */
export function completedListLead(shown, total, locale = 'tr') {
  const lang = en(locale) ? 1 : 0;
  if (total != null && shown >= total) return factSentence(lang ? ['The completed tasks are listed below, most recent first.'] : ['Tamamlanan görevler, en yenisi başta olmak üzere aşağıda listeleniyor.']);
  return factSentence(lang ? ['The ', n(shown, locale), ' most recently completed tasks are listed below.'] : ['En son tamamlanan ', n(shown, locale), ' görev aşağıda listeleniyor.']);
}

/** Not tablosunun giriş cümlesi (olgu taşımaz). */
export function noteListLead(locale = 'tr') {
  return factSentence(en(locale) ? ['The notes are quoted as recorded.'] : ['Notlar kayıtlardaki hâliyle aşağıdadır.']);
}

/** Dizi grafiğinin başlığı (sunucu metni). */
export function seriesChartTitle(coverage, locale = 'tr') {
  const lang = en(locale) ? 1 : 0;
  const week = coverage.bucket === 'week';
  if (coverage.kind === 'activitySeries') return week ? ['Haftalara göre kaydedilen hareket', 'Recorded activity by week'][lang] : ['Aylara göre kaydedilen hareket', 'Recorded activity by month'][lang];
  return week ? ['Haftalara göre tamamlanan görev', 'Completed tasks by week'][lang] : ['Aylara göre tamamlanan görev', 'Completed tasks by month'][lang];
}

/** Tek satırlı dönem listesinin (tamamlanan görev ya da not) satırını tanıtan cümle; sayı taşımaz (sayım giriştedir). */
export function singleRowLead(kind, locale = 'tr') {
  const lang = en(locale) ? 1 : 0;
  return kind === 'notes' ? ['Notu okunan görev şudur.', 'This is the task whose note was read.'][lang] : ['Tamamlanan görev şudur.', 'This is the completed task.'][lang];
}

