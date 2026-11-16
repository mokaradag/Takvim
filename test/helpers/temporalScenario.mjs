/**
 * Aşama H senaryo yardımcıları: kıyas kümesinin (`test/fixtures/bilgin-temporal-benchmark.json`) okunması, göreli tarihlerin
 * çözülmesi ve bir turun nesnel beklentilere göre denetimi. Belirlenimci kabul (altın plan) ile canlı nitelendirme (gerçek model)
 * AYNI denetimi kullanır: beklenti dönem, kapsam, bulgu türü, tamlık çekincesi ve izin verilen yanıt türüdür; akıcı ama yanlış
 * yanıt geçmez.
 */
import { readFileSync } from 'node:fs';
import { rangeLabel, resolveWindow, previousWindow } from '../../src/domain/ai/temporalWindow.js';
import { answerQuality } from './answerQuality.mjs';
import { populationReads, renderedCharts } from './phase4eScenario.mjs';

export const temporalFixture = JSON.parse(readFileSync(new URL('../fixtures/bilgin-temporal-benchmark.json', import.meta.url), 'utf8'));
export const TEMPORAL_TODAY = temporalFixture.today;

const shift = (offset) => new Date(Date.parse(`${TEMPORAL_TODAY}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
/** `"T"`, `"T-14"`, `"T+3"` → kıyas gününe göre gün. */
export const resolveDay = (value) => (typeof value === 'string' && /^T(?:[+-]\d+)?$/.test(value) ? shift(Number(value.slice(1) || 0)) : value);
/** Plan ya da beklentideki bütün göreli günleri çözer. */
export const resolveDays = (value) => JSON.parse(JSON.stringify(value ?? null).replace(/"T([+-]\d+)?"/g, (_, offset) => `"${shift(Number(offset || 0))}"`));

/** Aşama H bulgularının sunucu cümlelerinin ayırt edici kalıpları (yalnızca varlık; sayılar kanıttandır). */
export const H_FINDING_TEXT = Object.freeze({
  tr: {
    periodSummary: /görev tamamlandı \(gerçekleşen bitiş tarihine göre\)|yeni görev oluşturul(du|madı)|hareket kayde(dildi|tti|ttiniz)|tamamlanan görev yok|hareket kayd(edilmedi|etmedi|etmediniz)|hareket kaydı bulunmuyor/,
    periodComparison: /İki dönem karşılaştırıldığında|karşılaştırma şimdilik geçici|İki dönem örtüştüğü|karşılaştırılamıyor|İki dönemde de/,
    completionTrend: /En yoğun (hafta|ay)|tamamlanma hızı|eğilim söylenemez|eğilim çıkarılmadı|eğilim söylemek için kısa|gerçekleşen bitişi kayıtlı tamamlanan görev yok|görev tamamlandı \(gerçekleşen bitiş tarihine göre\)/,
    activityTrend: /Kaydedilen hareketler en çok|için hareket kaydı yok; bu kovalar bilinmiyor/,
    horizonSpread: /7 gün içinde \*\*\d+\*\*, 14 gün içinde \*\*\d+\*\*, 30 gün içinde \*\*\d+\*\*|önümüzdeki 30 gün içinde .*termini olan açık görev yok/i,
    historyLimit: /yeniden kurulamıyor/,
    noteDigest: /açık görevin notu(?:nun tamamı)?|tanesinin notu okundu|açıklaması olan açık görev yok/
  },
  en: {
    periodSummary: /(tasks? (was|were) completed|new tasks? (was|were) created|recorded|no task has a recorded completion date|no new task was created|no activity record)/i,
    periodComparison: /Comparing the two periods|comparison is provisional|two periods overlap|cannot be compared|In both periods/,
    completionTrend: /busiest (week|month)|pace of completion|not enough to state a trend|too short a series|no trend is drawn|by recorded actual finish date/,
    activityTrend: /Recorded activity peaked|there is no activity record; those are unknown/,
    horizonSpread: /within 7 days, \*\*\d+\*\* within 14 days/,
    historyLimit: /cannot be reconstructed/,
    noteDigest: /descriptions? of (?:the|all)|most recently updated were read|has a description to read/
  }
});

const fold = (text) => String(text).replace(/\\([\\`*_{}[\]()#+.!|<>~:/-])/g, '$1');

/**
 * Turun Aşama H beklentileri; ihlal listesi döner (boş: geçti). `live`: canlı modelin planı altın plandan farklı ama eşdeğer
 * okumalarla aynı dönemi ve bulguları üretebilir; yapısal beklentiler aynen uygulanır.
 */
export function temporalViolations(result, expect = {}, { locale = result.locale || 'tr' } = {}) {
  const problems = [];
  const content = fold(result.answer?.content || '');
  const finish = result.answer?.finishReason;
  if (expect.finish ? finish !== expect.finish : finish !== 'stop') problems.push(`bitiş ${finish} ≠ ${expect.finish || 'stop'}`);
  if (expect.finishNot && finish === expect.finishNot) problems.push(`bitiş ${finish} olmamalı`);
  if (finish !== 'stop') {
    for (const pattern of expect.says || []) if (!new RegExp(pattern, 'u').test(content)) problems.push(`beklenen ifade yok: ${pattern}`);
    return problems;
  }
  if (!/【R\d+】/.test(content)) problems.push('yanıt kanıtlı değil');
  const log = result.log || [];
  const windowSeen = (range) => {
    if (!range) return true;
    const [dateFrom, dateTo] = range.map(resolveDay);
    if (content.includes(rangeLabel({ dateFrom, dateTo }, locale))) return true;
    const day = (value) => (value == null ? null : new Date(value).toISOString().slice(0, 10));
    return populationReads(log).some((row) => day(row.params.dateFrom) === dateFrom && day(row.params.dateTo) === dateTo);
  };
  if (!windowSeen(expect.window)) problems.push(`dönem okunmadı ya da söylenmedi: ${JSON.stringify(expect.window)}`);
  if (!windowSeen(expect.compare)) problems.push(`karşılaştırma dönemi okunmadı ya da söylenmedi: ${JSON.stringify(expect.compare)}`);
  for (const kind of expect.findings || []) {
    if (!H_FINDING_TEXT[locale === 'en' ? 'en' : 'tr'][kind]?.test(content)) problems.push(`bulgu yok: ${kind}`);
  }
  for (const pattern of expect.says || []) if (!new RegExp(pattern, 'u').test(content)) problems.push(`beklenen ifade yok: ${pattern}`);
  for (const pattern of expect.notSays || []) if (new RegExp(pattern, 'u').test(content)) problems.push(`yasak ifade var: ${pattern}`);
  const charts = renderedCharts(result.answer?.content || '');
  for (const type of expect.charts || []) if (!charts.some((chart) => chart.type === type)) problems.push(`grafik yok: ${type}`);
  if (expect.noChart && charts.some((chart) => chart.type === expect.noChart)) problems.push(`grafik çizilmemeliydi: ${expect.noChart}`);
  if (expect.chartNote && !/grafik için .+ gerekir|chart needs|requires/u.test(content)) problems.push('grafik türü notu yok');
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
  if (Array.isArray(value)) return value.map(resolveDay);
  const resolved = resolveWindow(value, today);
  return resolved ? [resolved.dateFrom, resolved.dateTo] : null;
}

export function expectedCompare(value, window, today = TEMPORAL_TODAY) {
  if (!value) return null;
  if (value === 'previous') {
    const [dateFrom, dateTo] = expectedRange(window, today) || [];
    // Kayan dönemin ("son N gün") öncesi aynı uzunlukta aralıktır (bkz. analysisWindows).
    const prior = dateFrom ? previousWindow({ dateFrom, dateTo }, { rolling: typeof window === 'string' && /^last_\d+_days$/.test(window) }) : null;
    return prior ? [prior.dateFrom, prior.dateTo] : null;
  }
  return expectedRange(value, today);
}
