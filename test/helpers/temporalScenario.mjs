/**
 * Aşama H senaryo yardımcıları: kıyas kümesinin (`test/fixtures/bilgin-temporal-benchmark.json`) okunması, göreli tarihlerin
 * çözülmesi ve bir turun nesnel beklentilere göre denetimi. Belirlenimci kabul (altın plan) ile canlı nitelendirme (gerçek model)
 * AYNI denetimi kullanır: beklenti dönem, kapsam, bulgu türü, tamlık çekincesi ve izin verilen yanıt türüdür; akıcı ama yanlış
 * yanıt geçmez.
 */
import { readFileSync } from 'node:fs';
import { resolveWindow, previousWindow } from '../../src/domain/ai/temporalWindow.js';
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
    periodSummary: /görev tamamlandı \(gerçekleşen bitiş tarihine göre\)|yeni görev oluşturul(du|madı)|hareket kayde(dildi|tti|ttiniz)|tamamlanan görev yok|hareket kayd(edilmedi|etmedi|etmediniz)|hareket kaydı bulunmuyor/,
    periodComparison: /İki dönem karşılaştırıldığında|karşılaştırma şimdilik geçici|İki dönem örtüştüğü|karşılaştırılamıyor|İki dönemde de/,
    completionTrend: /En yoğun (hafta|ay)|tamamlanma hızı|eğilim söylenemez|eğilim çıkarılmadı|eğilim söylemek için kısa|gerçekleşen bitişi kayıtlı tamamlanan görev yok/,
    activityTrend: /Kaydedilen hareketler en çok|için hareket kaydı yok; bu kovalar bilinmiyor/,
    horizonSpread: /7 gün içinde \*\*\d+\*\*, 14 gün içinde \*\*\d+\*\*, 30 gün içinde \*\*\d+\*\*|önümüzdeki 30 gün içinde .*termini olan açık görev yok/i,
    historyLimit: /yeniden kurulamıyor/,
    noteDigest: /açık görevin notu(?:nun tamamı)?|tanesinin notu okundu|açıklaması olan açık görev yok/
  },
  en: {
    periodSummary: /(tasks? (was|were) completed|new tasks? (was|were) created|(?:you|the selected person|your (?:team|unit|department|directorate)|.{2,80}) recorded (?:\*\*)?\d+(?:\*\*)? (?:task )?activity events?|(?:\*\*)?\d+(?:\*\*)? activity events? (?:was|were) recorded|no task has a recorded completion date|no new task was created|no activity record)/i,
    periodComparison: /Comparing the two periods|comparison is provisional|two periods overlap|cannot be compared|In both periods/,
    completionTrend: /busiest (week|month)|pace of completion|not enough to state a trend|too short a series|no trend is drawn/,
    activityTrend: /Recorded activity peaked|there is no activity record; those are unknown/,
    horizonSpread: /within 7 days, \*\*\d+\*\* within 14 days/,
    historyLimit: /cannot be reconstructed/,
    noteDigest: /descriptions? of (?:the|all)|returned were read|has a description to read/
  }
});

const fold = (text) => String(text).replace(/\\([\\`*_{}[\]()#+.!|<>~:/-])/g, '$1');

/** SQL günlüğünde dönem ve olay ölçüsü birlikte eşleşir; termin okuması tamamlanma kanıtı değildir. */
function temporalLogMatches(row, range, measure = null) {
  if (row.ok !== true || !['task-facts', 'activity'].includes(row.query)) return false;
  const p = row.params;
  const day = (value) => value == null || !Number.isFinite(new Date(value).getTime()) ? null : new Date(value).toISOString().slice(0, 10);
  const from = row.query === 'activity' ? day(new Date(p.startUtc).getTime() + 10800000) : day(p.dateFrom);
  const to = row.query === 'activity' ? day(new Date(p.endUtc).getTime() + 10800000 - 86400000) : day(p.dateTo);
  if (range && (from !== range[0] || to !== range[1])) return false;
  if (!measure) return true;
  if (measure === 'activity') return row.query === 'activity' && p.teamLevel !== undefined;
  const statuses = (p.statusCsv || '').split(',').filter(Boolean);
  return row.query === 'task-facts' && !p.taskIds && p.dateField === (measure === 'created' ? 'createdAt' : 'actualFinish')
    && (measure === 'created' ? !statuses.length : statuses.length === 1 && statuses[0] === 'done');
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
export function temporalPopulationViolations(result, analysis, seed) {
  if (!analysis || result.answer?.finishReason !== 'stop') return [];
  const layers = [analysis, ...(analysis.also || [])].map((layer) => ({ ...layer, focus: layer.focus || analysis.focus })).flatMap((layer) => (layer.names?.length ? layer.names.map((name) => ({ ...layer, names: [name] })) : [layer]));
  const reads = (result.log || []).filter((row) => row.ok === true && (row.query === 'activity' || row.query === 'task-facts' && !row.params.taskIds));
  const matches = (row, layer) => {
    const p = row.params;
    const activity = row.query === 'activity';
    const owner = activity ? p.scope === 'mine' ? 'self' : p.scope === 'team' ? 'team' : 'all' : p.assigneeMode === 'me' ? 'self' : p.assigneeMode === 'team' ? 'team' : 'all';
    if ((p.teamLevel || '') !== (layer.level || '').toUpperCase()) return false;
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
  const window = analysis.relativeWindow && analysis.relativeWindow !== 'all_time' ? expectedRange(analysis.relativeWindow)
    : analysis.dateFrom && analysis.dateTo ? expectedRange([analysis.dateFrom, analysis.dateTo]) : null;
  const defaultRange = [shift(layers.some((layer) => layer.focus?.includes('trend')) ? -89 : -29), TEMPORAL_TODAY];
  const effectiveWindow = window || defaultRange;
  const prior = analysis.compare ? expectedCompare(analysis.compare, analysis.relativeWindow || effectiveWindow, TEMPORAL_TODAY, !window)
    : analysis.compareFrom && analysis.compareTo ? expectedRange([analysis.compareFrom, analysis.compareTo]) : null;
  for (const layer of layers) {
    const measures = [...new Set((layer.focus || analysis.focus || []).filter((focus) => ['completed', 'created', 'activity', 'trend'].includes(focus)))];
    const range = measures.length ? effectiveWindow : null;
    for (const measure of measures) for (const period of [range, ...(measure === 'trend' ? [] : [prior])].filter(Boolean)) {
      if (!reads.some((read) => matches(read, layer) && temporalLogMatches(read, period, measure))) problems.push(`kapsamın dönem ölçüsü okunmadı: ${layer.scope}/${measure}/${period.join('..')}`);
      if (measure === 'trend') {
        // Aynı SQL olguları hem toplamı hem diziyi besler; dizi gerçekten üretilmiş kanıt zarfıyla ayrıca doğrulanır.
        const evidence = (result.evidence || []).filter((item) => {
          const filters = item.data?.filters || {};
          return item.tool === 'rota_task_analytics' && matches({ query: 'task-facts', params: { ...filters, assigneeMode: filters.assignee } }, layer)
            && filters.dateField === 'actualFinish' && filters.statuses?.join() === 'done' && filters.dateFrom === period[0] && filters.dateTo === period[1];
        });
        if (!evidence.some((item) => ['date_week', 'date_month'].includes(item.data.groupBy)) || !evidence.some((item) => !item.data.groupBy)) problems.push(`eğilim dizisi ya da toplamı okunmadı: ${layer.scope}`);
      }
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

  const charts = renderedCharts(result.answer?.content || '');
  for (const type of expect.charts || []) if (!charts.some((chart) => chart.type === type)) problems.push(`grafik yok: ${type}`);
  if (expect.noChart && charts.some((chart) => chart.type === expect.noChart)) problems.push(`grafik çizilmemeliydi: ${expect.noChart}`);
  if (expect.chartNote && !/(?:grafik|zaman çizelgesi|gösterge kartları) için .+ gerekir|(?:chart|KPI card set|timeline) (?:needs|requires)\b/iu.test(content)) problems.push('grafik türü notu yok');
  // Grafik değerleri sayı, etiketleri boş olmayan metindir; çizgi grafiğin en az üç noktası vardır (tek tük gözlemden eğilim çizilmez).
  for (const chart of charts) {
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
    // Kayan dönemin ("son N gün") öncesi aynı uzunlukta aralıktır (bkz. analysisWindows).
    const prior = dateFrom ? previousWindow({ dateFrom, dateTo }, { rolling: rolling || typeof window === 'string' && /^last_\d+_days$/.test(window) }) : null;
    return prior ? [prior.dateFrom, prior.dateTo] : null;
  }
  return expectedRange(value, today);
}
