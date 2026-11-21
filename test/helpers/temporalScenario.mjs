/**
 * Aşama H senaryo yardımcıları: kıyas kümesinin (`test/fixtures/bilgin-temporal-benchmark.json`) okunması, göreli tarihlerin
 * çözülmesi ve bir turun nesnel beklentilere göre denetimi. Belirlenimci kabul (altın plan) ile canlı nitelendirme (gerçek model)
 * AYNI denetimi kullanır: beklenti dönem, kapsam, bulgu türü, tamlık çekincesi ve izin verilen yanıt türüdür; akıcı ama yanlış
 * yanıt geçmez.
 */
import { readFileSync } from 'node:fs';
import { englishBucketLabel, namedWindow, previousWindow, rangeLabel, resolveWindow, windowAdverb, windowName, windowPosition } from '../../src/domain/ai/temporalWindow.js';
import { answerChartLabel, ANSWER_CHART_LIMITS } from '../../src/domain/ai/answerChart.js';
import { seriesChartTitle } from '../../src/domain/ai/temporalFindings.js';
import { answerQuality } from './answerQuality.mjs';
import { renderedCharts } from './phase4eScenario.mjs';

export const temporalFixture = JSON.parse(readFileSync(new URL('../fixtures/bilgin-temporal-benchmark.json', import.meta.url), 'utf8'));
export const TEMPORAL_TODAY = temporalFixture.today;

const shift = (offset, today = TEMPORAL_TODAY) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
/** `"T"`, `"T-14"`, `"T+3"` → kıyas gününe göre gün. */
export const resolveDay = (value, today = TEMPORAL_TODAY) => (typeof value === 'string' && /^T(?:[+-]\d+)?$/.test(value) ? shift(Number(value.slice(1) || 0), today) : value);
/** Plan ya da beklentideki bütün göreli günleri çözer. */
export const resolveDays = (value) => JSON.parse(JSON.stringify(value ?? null).replace(/"T([+-]\d+)?"/g, (_, offset) => `"${shift(Number(offset || 0))}"`));

/** Aşama H bulgularının sunucu cümlelerinin ayırt edici kalıpları (yalnızca varlık; sayılar kanıttandır). */
export const H_FINDING_TEXT = Object.freeze({
  tr: {
    periodSummary: /görev tamamlandı \(gerçekleşen bitiş tarihine göre\)|yeni görev oluşturul(du|madı)|oluşturulmuş ve bugün kayıtlı yeni görev yok|hareket kayde(dildi|tti|ttiniz)|gerçekleşen bitiş kaydı yok|hareket kayd(edilmedi|etmedi|etmediniz)|hareket kaydı bulunmuyor/,
    periodComparison: /İki dönem karşılaştırıldığında|karşılaştırma şimdilik geçici|İki dönem örtüştüğü|karşılaştırılamıyor|İki dönemde de|bu fark yorumlanmadı|toplam değişim yorumlanmadı/,
    completionTrend: /En yoğun (hafta|ay)|Bitiş tarihi kayıtlı tamamlanma sayısı en yüksek|tamamlanma hızı|eğilim söylenemez|eğilim çıkarılmadı|eğilim söylemek için kısa|gerçekleşen bitiş kaydı yok/,
    activityTrend: /Kaydedilen hareketler en çok|için hareket kaydı yok; bu kovalar bilinmiyor/,
    horizonSpread: /7 gün içinde \*\*\d+\*\*, 14 gün içinde \*\*\d+\*\*, 30 gün içinde \*\*\d+\*\*|önümüzdeki 30 gün içinde .*termini olan açık görev yok/i,
    historyLimit: /yeniden kurulamıyor/,
    // Kesilmiş notların alıntı cümlesi de geçerli not özetidir (okuma ve açıklama doğruysa eksik bulgu sayılmaz).
    noteDigest: /açık görevin notu(?:nun tamamı)?|tanesinin notu okundu|açıklaması olan açık görev yok|not parçası okundu/
  },
  en: {
    periodSummary: /(tasks? (was|were) completed|new tasks? (was|were) created|no task created in this period is (?:currently on record|still present today)|(?:you|the selected person|your (?:team|unit|department|directorate)|.{2,80}) recorded (?:\*\*)?\d+(?:\*\*)? (?:task )?activity events?|(?:\*\*)?\d+(?:\*\*)? activity events?(?: (?:across|on) (?:\*\*)?\d+(?:\*\*)? tasks?)? (?:was|were) recorded|no task currently marked done has a recorded completion date|no new task was created|no activity record)/i,
    periodComparison: /Comparing the two periods|comparison is provisional|two periods overlap|cannot be compared|In both periods|difference is not interpreted|no overall change is interpreted/,
    completionTrend: /busiest (week|month)|highest count of dated completions|pace of completion|not enough to state a trend|too short a series|no trend is drawn|no task currently marked done has a recorded completion date/,
    activityTrend: /Recorded activity peaked|no activity record; those are unknown/,
    horizonSpread: /within 7 days, \*\*\d+\*\* within 14 days|In the next 30 days, no open task is due/,
    historyLimit: /cannot be reconstructed/,
    noteDigest: /The descriptions? of (?:the|all) \*\*\d+\*\* open tasks? that have one .* were read|Returned excerpts from \*\*\d+\*\* open task descriptions? .* were read|open tasks? with a description .*, the \*\*\d+\*\* returned were read|has a description to read/i
  }
});

const fold = (text) => String(text).replace(/\\([\\`*_{}[\]()#+.!|<>~:/-])/g, '$1');

// Termin ve durum denetimlerinde nüfusu daraltan ek süzgeçler kanıt ve SQL için aynı şekilde yorumlanır.
const narrowsTasks = (filters) => Boolean(filters.deadline || filters.priorityCsv || filters.priorities?.length || filters.milestone != null
  || filters.text || filters.wbsId || filters.seriesId || filters.recurringOnly || filters.createdByMe || filters.hasDescription
  || filters.assigneeMode === 'unassigned' || filters.assignee === 'unassigned' || filters.previousResult);
const openStatuses = (statuses) => statuses?.length === 2 && ['todo', 'in_progress'].every((status) => statuses.includes(status));

const day = (value) => value == null || !Number.isFinite(new Date(value).getTime()) ? null : new Date(value).toISOString().slice(0, 10);

/** SQL günlüğünde dönem ve olay ölçüsü birlikte eşleşir; termin okuması tamamlanma kanıtı değildir. */
function temporalLogMatches(row, range, measure = null) {
  if (row.ok !== true || !['task-facts', 'activity'].includes(row.query)) return false;
  const p = row.params;
  const from = row.query === 'activity' ? day(new Date(p.startUtc).getTime() + 10800000) : day(p.dateFrom);
  const to = row.query === 'activity' ? day(new Date(p.endUtc).getTime() + 10800000 - 86400000) : day(p.dateTo);
  if (range && (from !== range[0] || to !== range[1])) return false;
  // Hareket okumasının sınırları tam İstanbul gece yarısıdır (başlangıç dâhil, bitiş hariç); gün kesmesi saat kaymasını gizlemez.
  const midnight = (value) => Date.parse(`${value}T00:00:00Z`) - 10800000;
  if (row.query === 'activity' && range && (new Date(p.startUtc).getTime() !== midnight(range[0]) || new Date(p.endUtc).getTime() !== midnight(range[1]) + 86400000)) return false;
  if (!measure) return true;
  if (measure === 'activity') return row.query === 'activity' && p.teamLevel !== undefined;
  // Tamamlanan kilometre taşı: gerçekleşen bitişe göre, yalnızca tamamlanmış kilometre taşı görevleri (daraltılmış liste geçmez).
  if (measure === 'milestone') {
    if (p.priorityCsv || p.priorities?.length || p.text || p.wbsId || p.seriesId || p.recurringOnly || p.assigneeMode === 'unassigned'
      || p.createdByMe || p.hasDescription || p.openOnly || p.deadline || p.targetFrom || p.targetTo) return false;
    const done = (p.statusCsv || '').split(',').filter(Boolean);
    return row.query === 'task-facts' && !p.taskIds && (p.milestone === true || p.milestone === 1) && p.dateField === 'actualFinish' && done.length === 1 && done[0] === 'done';
  }
  // Yaklaşan teslim: hedef bitişe göre açık görevler (tamamlanan iş okuması bu kanıtın yerine geçmez).
  if (measure === 'upcoming') {
    const open = (p.statusCsv || '').split(',').filter(Boolean);
    // Pencereyi daraltan ek süzgeç (ör. yalnızca bugün teslim, öncelik, kilometre taşı, metin) teslim penceresinin tamamını okumaz.
    return row.query === 'task-facts' && !p.taskIds && !narrowsTasks(p) && (!p.targetFrom || day(p.targetFrom) === from) && (!p.targetTo || day(p.targetTo) === to) && (p.dateField == null || p.dateField === 'targetFinish') && openStatuses(open);
  }
  if (p.priorityCsv || p.milestone != null || p.text || p.wbsId || p.seriesId || p.recurringOnly || p.assigneeMode === 'unassigned'
    || p.createdByMe || p.hasDescription || p.openOnly || p.deadline || p.targetFrom || p.targetTo) return false;
  const statuses = (p.statusCsv || '').split(',').filter(Boolean);
  return row.query === 'task-facts' && !p.taskIds && p.dateField === (measure === 'created' ? 'createdAt' : 'actualFinish')
    // Üç durumun tamamı nüfusu daraltmaz: oluşturulma okumasında süzgeçsiz okumayla eşdeğerdir.
    && (measure === 'created' ? !statuses.length || statuses.length === 3 && ['todo', 'in_progress', 'done'].every((status) => statuses.includes(status)) : statuses.length === 1 && statuses[0] === 'done');
}

/** Beklenen katmanın okuması: kimlik ve yönetim düzeyi aynı istekte korunur. */
export function temporalRequestMatches(request, layer) {
  const filters = request.filters || {};
  const entities = request.entities || [];
  const owner = filters.assignee === 'me' || filters.activityScope === 'mine' ? 'self' : filters.assignee === 'team' || filters.activityScope === 'team' ? 'team'
    : entities.some((entity) => entity.type === 'person') ? 'person' : layer.scope === 'project' && entities.some((entity) => entity.type === 'project') ? 'project' : 'all';
  const scopes = layer.scopeAny || [layer.scope];
  if (!scopes.some((scope) => scope === owner || scope === 'projects' && owner === 'all')) return false;
  if ((filters.teamLevel || '') !== (layer.level || '')) return false;
  const names = (type) => entities.filter((entity) => entity.type === type).map((entity) => String(entity.query ?? entity.text ?? '').toLocaleLowerCase('tr-TR')).sort();
  const wanted = (values) => (values || []).map((name) => String(name).toLocaleLowerCase('tr-TR')).sort();
  const subject = layer.scope === 'person' ? 'person' : layer.scope === 'project' ? 'project' : null;
  if (JSON.stringify(subject ? names(subject) : []) !== JSON.stringify(wanted(layer.names))) return false;
  if (subject !== 'person' && names('person').length) return false;
  return subject === 'project' || JSON.stringify(names('project')) === JSON.stringify(wanted(layer.within ? [layer.within] : []));
}

/** Altın plan yalnızca kapsam beklentisidir; modelin her başarılı nüfus okuması ayrıca denetlenir. */
export function temporalPopulationViolations(result, analysis, seed, expect = {}) {
  // Açıkça yazılan "tüm zamanlar" tarihsel yönde desteklenmez: sınırlı bir dönemle verilen başarılı yanıt geçmez (dönemsizlikten ayrıdır).
  if (analysis?.relativeWindow === 'all_time' && [analysis, ...(analysis.also || [])].some((layer) => (layer.focus || analysis.focus || []).some((focus) => ['completed', 'created', 'activity', 'trend'].includes(focus)))
    && result.answer?.finishReason === 'stop') return ['tüm zamanlar tarihsel isteği sınırlı dönemle yanıtlandı'];
  if (!analysis || result.answer?.finishReason !== 'stop') return [];
  // Kendiyle karşılaştırma (`withSelf`) iki nüfustur: adlı kişinin yanında kullanıcının kendi katmanı aynı dönem, yön ve daraltmayla puanlanır.
  const selfLayer = analysis.withSelf ? [{ scope: 'self', focus: analysis.focus, ...(analysis.within ? { within: analysis.within } : {}) }] : [];
  const layers = [analysis, ...selfLayer, ...(analysis.also || [])].map((layer) => ({ ...layer, focus: layer.focus || analysis.focus })).flatMap((layer) => (layer.names?.length ? layer.names.map((name) => ({ ...layer, names: [name] })) : [layer]));
  const reads = (result.log || []).filter((row) => row.ok === true && (row.query === 'activity' || row.query === 'task-facts' && !row.params.taskIds));
  const matches = (row, layer) => {
    const p = row.params;
    const activity = row.query === 'activity';
    const owner = activity ? p.scope === 'mine' ? 'self' : p.scope === 'team' ? 'team' : 'all' : p.assigneeMode === 'me' ? 'self' : p.assigneeMode === 'team' ? 'team' : 'all';
    if (String(p.teamLevel || '').toUpperCase() !== (layer.level || '').toUpperCase()) return false;
    if (activity ? p.kind || p.taskIdText || p.directorate || p.department || p.unit
      : p.priorityCsv || p.priorities?.length || p.milestone != null && !layer.focus?.includes('milestones') || p.text || p.wbsId || p.seriesId || p.recurringOnly
        || p.assigneeMode === 'unassigned' || p.createdByMe
        || p.hasDescription && !layer.focus?.includes('notes')) return false;
    const person = activity ? p.person : p.personSicil;
    const wantedPerson = layer.scope === 'person' ? seed.people.find((item) => item.DisplayName === layer.names[0])?.Sicil : null;
    const projectName = layer.scope === 'project' ? layer.names[0] : layer.within;
    const wantedProject = projectName ? seed.projects.find((item) => item.ProjectName === projectName)?.ProjectId : null;
    if (layer.scope === 'person' && wantedPerson == null || projectName && !wantedProject) return false;
    if (Number(person || 0) !== Number(wantedPerson || 0) || String(p.projectId || '').toLowerCase() !== String(wantedProject || '').toLowerCase()) return false;
    return ['self', 'team'].includes(layer.scope) ? owner === layer.scope : owner === 'all';
  };
  const problems = [];
  for (const read of reads) if (!layers.some((layer) => matches(read, layer))) problems.push('beklenmeyen nüfus okundu');
  for (const layer of layers) if (!reads.some((read) => matches(read, layer))) problems.push(`kapsam okunmadı: ${layer.scope}/${layer.level || ''}`);
  // Her katmanın her olay ölçüsü her istenen dönemde okunur; çapraz iki okuma dört birleşimi karşılayamaz.
  // Yalnızca başı verilen geçmiş dönem bugüne kadar okunur (sunucunun `analysisWindows` kuralı); göreli başlangıç önce çözülür.
  const resolvedFrom = analysis.dateFrom ? resolveDay(analysis.dateFrom) : null;
  const window = analysis.relativeWindow && analysis.relativeWindow !== 'all_time' ? expectedRange(analysis.relativeWindow)
    : resolvedFrom ? expectedRange([resolvedFrom, analysis.dateTo || (resolvedFrom > TEMPORAL_TODAY ? resolvedFrom : TEMPORAL_TODAY)]) : null;
  const defaultRange = [shift(layers.some((layer) => layer.focus?.includes('trend')) ? -89 : -29), TEMPORAL_TODAY];
  const effectiveWindow = window || defaultRange;
  const prior = analysis.compare ? expectedCompare(analysis.compare, analysis.relativeWindow || effectiveWindow, TEMPORAL_TODAY, !window)
    : analysis.compareFrom && analysis.compareTo ? expectedRange([analysis.compareFrom, analysis.compareTo]) : null;
  for (const layer of layers) {
    const measures = [...new Set((layer.focus || analysis.focus || []).filter((focus) => ['completed', 'created', 'activity', 'trend'].includes(focus)))];
    const windowedMilestones = Boolean(window && layer.focus?.includes('milestones'));
    if (windowedMilestones && !expect.measures?.includes('milestone')) problems.push('dönemli kilometre taşı ölçüsü açıkça bildirilmedi');
    if (windowedMilestones && expect.measures?.includes('milestone')
      && !reads.some((read) => matches(read, layer) && temporalLogMatches(read, window, 'milestone'))) problems.push(`kapsamın dönem ölçüsü okunmadı: ${layer.scope}/milestone/${window.join('..')}`);
    const range = measures.length ? effectiveWindow : null;
    for (const measure of measures) for (const period of [range, ...(measure === 'trend' ? [] : [prior])].filter(Boolean)) {
      if (!reads.some((read) => matches(read, layer) && temporalLogMatches(read, period, measure))) problems.push(`kapsamın dönem ölçüsü okunmadı: ${layer.scope}/${measure}/${period.join('..')}`);
      if (measure === 'trend') {
        // Aynı SQL olguları hem toplamı hem diziyi besler; dizi gerçekten üretilmiş kanıt zarfıyla ayrıca doğrulanır.
        const evidence = (result.evidence || []).filter((item) => {
          const filters = item.data?.filters || {};
          // Kesik (tam olmayan) analiz kanıtı diziyi karşılamaz.
          return item.ok === true && item.complete === true && item.tool === 'rota_task_analytics' && !narrowsTasks(filters)
            && matches({ query: 'task-facts', params: { ...filters, assigneeMode: filters.assignee } }, layer)
            && filters.dateField === 'actualFinish' && filters.statuses?.join() === 'done' && filters.dateFrom === period[0] && filters.dateTo === period[1];
        });
        const bucket = layer.bucket || analysis.bucket;
        if (!evidence.some((item) => bucket ? item.data.groupBy === `date_${bucket}` : ['date_week', 'date_month'].includes(item.data.groupBy)) || !evidence.some((item) => !item.data.groupBy
          && (item.data.history?.undatedDone === null || Number.isSafeInteger(item.data.history?.undatedDone) && item.data.history.undatedDone >= 0))) problems.push(`eğilim dizisi ya da toplamı okunmadı: ${layer.scope}`);
      }
    }
    // Dönemli yaklaşan teslim istendiyse açık görevlerin hedef bitiş okuması zorunludur (bugünden başlar).
    // Yalnızca sonu verilen yaklaşan iş ufku da bugünden o güne okunur (sunucunun `upcomingFrom` kuralı); varsayılan yedi günlük okuma geçmez.
    const upcomingWindow = window || (analysis.dateTo && !analysis.dateFrom ? expectedRange([TEMPORAL_TODAY, analysis.dateTo]) : null);
    if (layer.focus?.includes('upcoming') && upcomingWindow) {
      const upcoming = [upcomingWindow[0] < TEMPORAL_TODAY ? TEMPORAL_TODAY : upcomingWindow[0], upcomingWindow[1]];
      if (!reads.some((read) => matches(read, layer) && temporalLogMatches(read, upcoming, 'upcoming'))) problems.push(`yaklaşan teslim okunmadı: ${layer.scope}/${upcoming.join('..')}`);
    }
    for (const kind of ['notes', 'horizons'].filter((kind) => layer.focus?.includes(kind))) {
      const evidence = (result.evidence || []).filter((item) => {
        const filters = item.data?.filters || {};
        return matches({ query: 'task-facts', params: { ...filters, assigneeMode: filters.assignee } }, layer);
      });
      const open = (filters) => openStatuses(filters.statuses);
      const noteIds = new Set((result.log || []).filter((row) => row.query === 'task-notes' && row.ok === true).flatMap((row) => String(row.params.taskIds || '').toLowerCase().split(',')));
      // Not okuması açık görev notlarının tamamıdır: tarih ya da termin süzgeci taşıyan not araması (kanıtta ya da okumada) nüfusu daraltır ve geçmez.
      // Okunan not boş olmayan metindir (yalnızca boşluk dönen açıklama okunmuş not sayılmaz).
      const unrestrictedNotes = (filters) => !filters?.dateFrom && !filters?.dateTo && !filters?.deadline && !filters?.targetFrom && !filters?.targetTo
        && !filters?.priorityCsv && !filters?.priorities?.length && filters?.milestone == null && !filters?.text && !filters?.wbsId && !filters?.createdByMe;
      const seen = kind === 'notes' ? evidence.some((item) => item.ok === true && item.tool === 'rota_task_search' && item.data.filters.hasDescription && open(item.data.filters) && unrestrictedNotes(item.data.filters)
        && reads.some((read) => matches(read, layer) && read.params.hasDescription && unrestrictedNotes(read.params)
          && openStatuses((read.params.statusCsv || '').split(',').filter(Boolean)))
        && (item.complete === true && item.totalCount === 0 && item.data.tasks?.length === 0 || item.data.tasks?.length > 0
          && item.data.tasks.every((task) => typeof task.description === 'string' && task.description.trim() && noteIds.has(String(task.taskId).toLowerCase()))))
        : evidence.some((item) => item.ok === true && item.complete === true && item.tool === 'rota_task_analytics' && item.data.groupBy === 'due_horizon' && open(item.data.filters) && !narrowsTasks(item.data.filters)
          && item.data.filters.dateField === 'targetFinish' && item.data.filters.dateFrom === TEMPORAL_TODAY && item.data.filters.dateTo === shift(29)
          && ['days_0_6', 'days_7_13', 'days_14_29'].every((key) => item.data.groups?.some((group) => group.key === key && Number.isSafeInteger(group.count) && group.count >= 0))
          && reads.some((read) => matches(read, layer) && temporalLogMatches(read, [TEMPORAL_TODAY, shift(29)], 'upcoming')));
      if (!seen) problems.push(`${kind === 'notes' ? 'not' : 'teslim ufku'} kanıtı okunmadı: ${layer.scope}`);
    }
    // Gecikme riski (`overdue`) istendiyse o katman için güncel gecikme okuması da yapılmış olmalıdır.
    if (layer.focus?.includes('overdue')) {
      const hasOverdueRead = reads.some((read) => {
        if (!matches(read, layer) || read.query !== 'task-facts') return false;
        const p = read.params;
        const statuses = (p.statusCsv || '').split(',').filter(Boolean);
        const fullOpenPopulation = !statuses.length || ['todo', 'in_progress'].every((status) => statuses.includes(status));
        if (!fullOpenPopulation || narrowsTasks({ ...p, deadline: null }) || p.dateField && p.dateField !== 'targetFinish') return false;
        if (p.deadline === 'overdue') {
          const beforeToday = shift(-1);
          const from = day(p.dateFrom);
          const to = day(p.dateTo);
          const expectedEnd = to && to < beforeToday ? to : beforeToday;
          return (!from || from === window?.[0]) && (!to || to === window?.[1] || to === analysis.dateTo)
            && (!p.targetFrom || day(p.targetFrom) === from) && (!p.targetTo || day(p.targetTo) === expectedEnd);
        }
        return !p.deadline && !p.dateFrom && !p.dateTo && !p.targetFrom && !p.targetTo;
      });
      if (!hasOverdueRead) problems.push(`gecikme okuması yok: ${layer.scope}`);
    }
  }
  return problems;
}

/**
 * Turun Aşama H beklentileri; ihlal listesi döner (boş: geçti). `live`: canlı modelin planı altın plandan farklı ama eşdeğer
 * okumalarla aynı dönemi ve bulguları üretebilir; yapısal beklentiler aynen uygulanır.
 */
export function temporalViolations(result, expect = {}, { locale = result.locale || 'tr', includeText = null } = {}) {
  const problems = [];
  const content = fold(result.answer?.content || '');
  const finish = result.answer?.finishReason;
  for (const pattern of expect.notSays || []) if (new RegExp(pattern, 'u').test(content)) problems.push(`yasak ifade var: ${pattern}`);
  if (includeText === false && (result.log || []).some((row) => row.query === 'task-notes')) problems.push('rıza olmadan korumalı metin okundu');
  if (expect.finish ? finish !== expect.finish : !expect.finishNot && finish !== 'stop') problems.push(`bitiş ${finish} ≠ ${expect.finish || 'stop'}`);
  if (expect.finishNot && finish === expect.finishNot) problems.push(`bitiş ${finish} olmamalı`);
  if (finish !== 'stop') {
    for (const pattern of expect.says || []) if (!new RegExp(pattern, 'u').test(content)) problems.push(`beklenen ifade yok: ${pattern}`);
    return problems;
  }
  if (!/【R\d+】/.test(content)) problems.push('yanıt kanıtlı değil');
  const prose = content.replace(/\*\*/g, '');
  if (expect.noCombinedTotal) {
    // İki ayrı kapsam etiketiyle verilen sayılar geçerlidir; örtüşen kapsamlara tek bir sayı atfedilemez.
    const lines = prose.split(/[.!?;\n]/u);
    const combined = /(?:birim\p{L}*\s+(?:ve|ile)\s+bölüm\p{L}*|bölüm\p{L}*\s+(?:ve|ile)\s+birim\p{L}*|\b(?:iki kapsam\p{L}*|birlikte|birleşik toplam)\b)/iu;
    const taskCount = /\d[\d.,]*\s+(?:görev|iş)\b|(?:görev|iş)\s+sayısı\s*:?\s*\d|toplam\p{L}*\s*:?\s+\d/iu;
    const standaloneTotal = /^\s*toplam\s+\d[\d.,]*(?:\s+(?:görev|iş)\b|\s*$)/iu;
    if (lines.some((line) => combined.test(line) && taskCount.test(line) || standaloneTotal.test(line))) {
      problems.push('örtüşen kapsamlar için birleşik toplam verildi');
    }
  }
  for (const project of expect.citedActivityProjects || []) {
    const ids = (result.evidence || []).filter((item) => item.ok === true && item.tool === 'rota_activity_search'
      && item.data?.filters?.project === project).map((item) => item.evidenceId);
    const statement = prose.split(/\n\s*\n/u).some((block) => block.includes(project)
      && ids.some((id) => block.includes(`【${id}】`))
      && /\d[\d.,]*\s+hareket|hareket (?:kaydı (?:yok|bulunmuyor)|sayısı bilinmiyor)|no (?:activity|recorded activity)|activity (?:count|is unknown)|\d[\d.,]*\s+(?:recorded )?(?:activity )?events?/iu.test(block));
    if (!statement) problems.push(`projeye ait kaynaklı hareket sonucu yok: ${project}`);
  }
  const log = result.log || [];
  const windowSeen = (range) => {
    if (!range) return true;
    const resolved = range.map((value) => resolveDay(value));
    return (expect.measures?.length ? expect.measures : [null]).every((measure) => log.some((row) => temporalLogMatches(row, resolved, measure)));
  };
  if (!windowSeen(expect.window)) problems.push(`dönem okunmadı ya da söylenmedi: ${JSON.stringify(expect.window)}`);
  if (!windowSeen(expect.compare)) problems.push(`karşılaştırma dönemi okunmadı ya da söylenmedi: ${JSON.stringify(expect.compare)}`);
  for (const kind of expect.findings || []) {
    if (!H_FINDING_TEXT[locale === 'en' ? 'en' : 'tr'][kind]?.test(content)) problems.push(`bulgu yok: ${kind}`);
  }
  for (const pattern of expect.says || []) if (!new RegExp(pattern, 'u').test(content)) problems.push(`beklenen ifade yok: ${pattern}`);
  if (expect.historyLimitPeriod) {
    const [dateFrom, dateTo] = expect.historyLimitPeriod.map((value) => resolveDay(value));
    const label = windowAdverb({ dateFrom, dateTo }, TEMPORAL_TODAY, locale);
    const phrase = H_FINDING_TEXT[locale === 'en' ? 'en' : 'tr'].historyLimit;
    if (!content.split(/[.!?\n]/u).some((sentence) => sentence.includes(label) && phrase.test(sentence))) {
      problems.push('geçmiş durum sınırı istenen dönemi belirtmiyor');
    }
  }
  if (expect.completionCount) {
    const range = expect.window.map((value) => resolveDay(value));
    const visible = content.replace(/\*\*/g, '');
    const count = (result.evidence || []).find((item) => item.ok === true && item.tool === 'rota_task_analytics' && !item.data?.groupBy
      && item.data?.filters?.dateField === 'actualFinish' && item.data.filters.dateFrom === range[0] && item.data.filters.dateTo === range[1])?.data?.totals?.total;
    const matches = count === 0 ? /gerçekleşen bitiş kaydı yok|no task currently marked done has a recorded completion date/iu.test(visible)
      : Number.isSafeInteger(count) && new RegExp('(?:^|[^0-9])' + count + ' (?:görev tamamlandı|tasks? (?:was|were) completed)', 'iu').test(visible);
    if (!matches) problems.push('tamamlanma sayısı aynı dönemin kanıtıyla eşleşmiyor');
  }
  // Satırlı tablo ve sunum sınırı ayrı kabul sonuçlarıdır.
  if (expect.table && !/(?:^|\n)\|[^\n]+\|\n\|(?:\s*:?-+:?\s*\|)+\n\|[^\n]+\|/u.test(content)) problems.push('beklenen tablo yok');
  if (expect.tableNotice === 'noRows' && !/tablo olarak gösterilebilecek satır koleksiyonu yok|no row collection to display as a table/iu.test(content)) {
    problems.push('tabloya uygun satır koleksiyonu olmadığı bildirilmedi');
  }
  // Toplam, tarihsel proje veya kişi kırılımını karşılamaz; proje etiketleri görünen yanıta da ulaşmalıdır.
  if (expect.groupBy) {
    const wanted = expect.window?.map((value) => resolveDay(value));
    const breakdowns = (result.evidence || []).filter((item) => {
      const filters = item.data?.filters || {};
      return item.ok === true && item.tool === 'rota_task_analytics' && item.data?.groupBy === expect.groupBy
        && (!wanted || filters.dateFrom === wanted[0] && filters.dateTo === wanted[1])
        && (!expect.measures?.includes('completed') || filters.dateField === 'actualFinish' && filters.statuses?.length === 1 && filters.statuses[0] === 'done');
    });
    if (!breakdowns.length) problems.push(`beklenen kırılım okunmadı: ${expect.groupBy}`);
    const labels = breakdowns.flatMap((item) => (item.data.groups || []).filter((group) => group.count > 0).map((group) => group.label)).filter(Boolean);
    if (expect.groupBy === 'project' && labels.length && !labels.some((label) => content.includes(label))) problems.push('proje kırılımı yanıtta gösterilmedi');
  }
  // "Hangileri devam ediyor" sorusu bugünkü durum okumasını ister (durum dağılımı kanıtı): yalnızca tamamlanma özeti geçmez.
  if (expect.statusRead && !(result.evidence || []).some((item) => {
    const filters = item.data?.filters;
    const wanted = expect.window?.map((value) => resolveDay(value));
    const current = filters && (!filters.dateField && !filters.dateFrom && !filters.dateTo
      || filters.dateField === 'targetFinish' && wanted && filters.dateFrom === wanted[0] && filters.dateTo === wanted[1]);
    return item.ok === true && item.tool === 'rota_task_analytics' && item.data?.groupBy === 'status' && current
      && !filters.statuses?.length && !narrowsTasks(filters)
      && !filters.personSicil && !filters.projectId && (!filters.assignee || filters.assignee === 'any');
  })) problems.push('durum okuması yok');

  const charts = renderedCharts(result.answer?.content || '');
  for (const type of expect.charts || []) if (!charts.some((chart) => chart.type === type)) problems.push(`grafik yok: ${type}`);
  if (expect.noChart && charts.some((chart) => chart.type === expect.noChart)) problems.push(`grafik çizilmemeliydi: ${expect.noChart}`);
  if (expect.chartNote && !/(?:grafik|zaman çizelgesi|gösterge kartları) için .+ gerekir|(?:chart|KPI card set|timeline) (?:needs|requires)\b|kayıt kapsamı doğrulanamadığı için çizgi grafik çizilemedi|recording coverage for the activity series could not be verified/iu.test(content)) problems.push('grafik türü notu yok');
  // Dönem karşılaştırması çubukları: her çubuk kendi döneminin ve KENDİ nüfusunun kanıttaki sayısıdır (önce → sonra); yer değiştirmiş
  // ya da başka kapsamdan kopyalanmış sayılar geçmez. Her çubuğun etiketi açık dönemde kısmi işaretini de taşır.
  if (expect.window && expect.compare) {
    const periods = [expect.compare, expect.window].map((range) => range.map((value) => resolveDay(value)))
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    const english = locale === 'en';
    const names = periods.map((range) => windowName(namedWindow({ dateFrom: range[0], dateTo: range[1] }, TEMPORAL_TODAY), english ? 'en' : 'tr'));
    const labels = periods.map((range, index) => {
      const base = names.every(Boolean) ? names[index] : rangeLabel({ dateFrom: range[0], dateTo: range[1] }, english ? 'en' : 'tr');
      const open = windowPosition({ dateFrom: range[0], dateTo: range[1] }, TEMPORAL_TODAY)?.open;
      return `${base}${open ? ` (${english ? 'partial' : 'kısmi'})` : ''}`.toLocaleLowerCase('tr');
    });
    const specs = { completed: ['actualFinish', /^(Tamamlanan görev|Completed tasks)/], created: ['createdAt', /^(Oluşturulan görev|Created tasks)/] };
    for (const [measure, [dateField, title]] of Object.entries(specs).filter(([measure]) => (expect.measures || []).includes(measure))) {
      // Aynı dönem çifti birden çok kapsam/proje için okunduysa her nüfusun kendi [önce, sonra] toplam çifti çıkarılır.
      const readsFor = (result.evidence || []).filter((item) => item.ok === true && item.tool === 'rota_task_analytics' && !item.data?.groupBy
        && item.data?.filters?.dateField === dateField
        && (measure === 'completed'
          ? item.data?.filters?.statuses?.length === 1 && item.data.filters.statuses[0] === 'done'
          : !item.data?.filters?.statuses?.length));
      const popKey = (item) => {
        const f = item.data?.filters || {};
        return JSON.stringify([f.assignee || null, f.teamLevel || null, f.personSicil || null, f.projectId || null]);
      };
      const byPop = new Map();
      for (const item of readsFor) {
        const key = popKey(item);
        if (!byPop.has(key)) byPop.set(key, []);
        byPop.get(key).push(item);
      }
      const populationPairs = [...byPop.values()].map((items) => {
        const pair = periods.map((range) => items.find((item) => item.data.filters.dateFrom === range[0] && item.data.filters.dateTo === range[1]));
        if (pair.some((item) => !item || !Number.isFinite(item.data?.totals?.total))) return null;
        const sample = pair[0].data.filters;
        const level = String(sample.teamLevel || '').toUpperCase();
        const teamPart = level === 'UNIT' ? (english ? 'Your unit' : 'Biriminiz')
          : level === 'DEPARTMENT' ? (english ? 'Your department' : 'Bölümünüz')
            : level === 'DIRECTORATE' ? (english ? 'Your directorate' : 'Direktörlüğünüz')
              : (english ? 'Your team' : 'Ekibiniz');
        const ownerLabel = !sample.person && sample.personSicil == null
          ? (sample.assignee === 'me' ? (english ? 'Your work' : 'Kendi işleriniz') : sample.assignee === 'team' ? teamPart : '')
          : '';
        // Çizici sırası: kapsam sahibi, proje, kişi (`comparisonCharts` ile birebir aynı).
        const suffix = [ownerLabel, sample.project, sample.person].filter((name) => typeof name === 'string' && name.trim()).join(' — ');
        return { suffix, counts: pair.map((item) => item.data.totals.total) };
      }).filter(Boolean);
      const matching = charts.filter((item) => item.type === 'bar' && title.test(String(item.title || '')));
      if (expect.charts?.includes('bar') && !matching.length) problems.push(`karşılaştırma grafiği yok: ${measure}`);
      const usedPops = new Set();
      for (const chart of matching) {
        if (chart.items?.length !== 2) { problems.push('karşılaştırma grafiği iki dönem çubuğu taşımıyor'); continue; }
        const chartSuffix = String(chart.title || '').includes(' — ') ? String(chart.title).split(' — ').slice(1).join(' — ').trim() : '';
        const candidatePops = chartSuffix || populationPairs.some((pop) => pop.suffix)
          ? populationPairs.filter((pop) => pop.suffix === chartSuffix)
          : populationPairs.filter((_, index) => !usedPops.has(index));
        const values = chart.items.map((item) => item.value).join();
        const matchedIndex = populationPairs.findIndex((pop, index) => candidatePops.includes(pop) && !usedPops.has(index) && pop.counts.join() === values);
        if (matchedIndex < 0) problems.push('karşılaştırma çubukları dönem sayılarıyla eşleşmiyor');
        else usedPops.add(matchedIndex);
        if (chart.items.some((item, index) => String(item.label || '').toLocaleLowerCase('tr') !== labels[index])) problems.push('karşılaştırma çubuğunun etiketi dönemiyle eşleşmiyor');
      }
    }
  }
  // Grafik değerleri sayı, etiketleri boş olmayan metindir; çizgi grafiğin en az üç noktası vardır (tek tük gözlemden eğilim çizilmez).
  for (const chart of charts) {
    if (chart.type === 'line' && expect.measures?.includes('trend')) {
      const localeKey = locale === 'en' ? 'en' : 'tr';
      const ranges = expect.window?.map((value) => resolveDay(value));
      const matching = (result.evidence || []).some((item) => {
        const groupBy = item.data?.groupBy;
        const filters = item.data?.filters;
        if (!item.ok || item.tool !== 'rota_task_analytics' || !['date_week', 'date_month'].includes(groupBy)
          || filters?.dateField !== 'actualFinish' || ranges && (filters.dateFrom !== ranges[0] || filters.dateTo !== ranges[1])) return false;
        if (!chart.evidence?.includes(item.evidenceId)) return false;
        const title = seriesChartTitle({ kind: 'series', bucket: groupBy === 'date_week' ? 'week' : 'month' }, localeKey, filters);
        if (chart.title !== answerChartLabel(title, ANSWER_CHART_LIMITS.maxTitleChars)) return false;
        const groups = [...(item.data.groups || [])].filter((group) => group.dateFrom <= (item.today || TEMPORAL_TODAY))
          .sort((a, b) => a.key.localeCompare(b.key));
        return chart.items?.length === groups.length && groups.every((group, index) => {
          const label = rangeLabel({ dateFrom: group.dateFrom, dateTo: group.dateTo }, localeKey);
          const localized = localeKey === 'en' ? englishBucketLabel(group.label) : group.label;
          const suffix = group.partial ? (localeKey === 'en' ? ' (partial)' : ' (kısmi)') : '';
          return chart.items[index].value === group.count && [label, localized].some((name) => chart.items[index].label === name + suffix);
        });
      });
      if (!matching) problems.push('çizgi grafik noktaları kova kanıtıyla eşleşmiyor');
    }
    if (chart.type === 'line' && (chart.items || []).length < 3) problems.push('çizgi grafik üçten az noktayla çizildi');
    if (['bar', 'line', 'pie'].includes(chart.type) && (chart.items || []).some((item) => !Number.isFinite(item.value) || item.value < 0)) problems.push('grafikte geçersiz değer');
  }
  // Tarihsel doğruluk: bilinmeyen dönem sıfır olarak yazılmaz; düzyazı mekanik kalıp ve yinelenen cümle içermez.
  const quality = answerQuality(result.answer?.content || '');
  if (quality.mechanical.length) problems.push(`mekanik kalıp: ${quality.mechanical.join(' ')}`);
  if (quality.duplicates) problems.push(`yinelenen cümle: ${quality.duplicates}`);
  return problems;
}

/** Planlayıcı beklentisinin (ayrık küme) somut dönemleri: adlı dönem ya da tarih çifti → `[dateFrom, dateTo]`. */
export function expectedRange(value, today = TEMPORAL_TODAY) {
  if (!value) return null;
  if (Array.isArray(value)) return value.map((day) => resolveDay(day, today));
  const resolved = resolveWindow(value, today);
  return resolved ? [resolved.dateFrom, resolved.dateTo] : null;
}

export function expectedCompare(value, window, today = TEMPORAL_TODAY, rolling = false) {
  if (!value) return null;
  if (value === 'previous') {
    const [dateFrom, dateTo] = expectedRange(window, today) || [];
    // Kayan dönemin ("son/önümüzdeki N gün") öncesi aynı uzunlukta aralıktır (bkz. analysisWindows).
    const prior = dateFrom ? previousWindow({ dateFrom, dateTo }, { rolling: rolling || typeof window === 'string' && /^(?:last|next)_\d+_days$/.test(window) }) : null;
    return prior ? [prior.dateFrom, prior.dateTo] : null;
  }
  return expectedRange(value, today);
}
