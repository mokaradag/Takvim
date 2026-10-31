import { isEvidenceId } from './evidenceContract.js';

/**
 * Kanıta dayalı yanıttaki grafik sözleşmesi — sunucu ile tarayıcının ORTAK, saf kuralları.
 *
 * Grafiği model ÇİZMEZ ve verisini yazmaz: sunucu doğrulanmış bir satır kümesinin sayısal sütunundan
 * kapalı biçimli bir tanım kurar, model yalnızca sunucunun sunduğu adaylardan birini seçebilir. Tanım
 * yanıt metninde `rota-chart` çitli bloğu olarak saklanır; tarayıcı onu yeniden doğrular ve yalnızca
 * yanıtın kendi kanıtlarına bağlıysa uygulamanın kendi bileşeniyle çizer. HTML, SVG, betik, renk,
 * bağlantı ya da kitaplık yapılandırması taşınmaz.
 */

export const ANSWER_CHART_FENCE = 'rota-chart';
/**
 * Kapalı görselleştirme dilbilgisi (Aşama 4E): her tür kanıt biçimiyle belirlenir, model yalnızca sunucunun
 * sunduğu adaylardan seçer. bar = kategorik karşılaştırma; donut = küçük ve tam dağılım; line = zaman dizisi
 * (sıralı dönemler); stacked = kategori × bölüm (birbirini dışlayan ve toplamı veren bölümler); kpi = başlık
 * ölçüleri (kart); timeline = yaklaşan tarihler (sıralı kayıt/tarih). Isı haritası ve süs grafikleri yoktur.
 */
export const ANSWER_CHART_TYPES = Object.freeze(['bar', 'donut', 'line', 'stacked', 'kpi', 'timeline']);
export const ANSWER_CHART_UNITS = Object.freeze(['count', 'days', 'hours', 'percent', 'number']);
export const ANSWER_CHART_LIMITS = Object.freeze({
  minItems: 2,
  maxBarItems: 12,
  maxDonutItems: 6,
  maxLineItems: 24,
  maxStackedItems: 10,
  maxSeries: 3,
  maxKpiItems: 6,
  maxTimelineItems: 10,
  maxTitleChars: 80,
  maxLabelChars: 80,
  maxEvidence: 4,
  maxValue: 1e12,
  maxSpecChars: 4096
});

const SPEC_KEYS = ['version', 'type', 'locale', 'title', 'unit', 'evidence', 'items'];
const UNSAFE_TEXT = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Üretici ve doğrulayıcı aynı metin güvenliği sözleşmesini kullanır. */
export function answerChartLabel(value, max = ANSWER_CHART_LIMITS.maxLabelChars) {
  const text = String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').replace(new RegExp(UNSAFE_TEXT.source, 'g'), '').replace(/ +/g, ' ').trim() || '—';
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function boundedText(value, max) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !UNSAFE_TEXT.test(value);
}

/** Bir dizinin uzunluğu bir kez okunur; seyrek ya da sınırsız dizi kabul edilmez. */
function denseArray(value, min, max) {
  if (!Array.isArray(value)) return null;
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < min || length > max) return null;
  const copy = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) return null;
    copy.push(value[index]);
  }
  return copy;
}

function amountOf(amount, unit) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > ANSWER_CHART_LIMITS.maxValue) return null;
  if (unit === 'count' && !Number.isSafeInteger(amount)) return null;
  return amount;
}

const ITEM_LIMITS = Object.freeze({ bar: 'maxBarItems', donut: 'maxDonutItems', line: 'maxLineItems', stacked: 'maxStackedItems', kpi: 'maxKpiItems', timeline: 'maxTimelineItems' });

/** Türün kapalı öğe biçimi; uymuyorsa `null`. */
function normalizeItem(type, item, spec, seriesCount) {
  if (type === 'stacked') {
    if (!exactKeys(item, ['label', 'values']) || !boundedText(item.label, ANSWER_CHART_LIMITS.maxLabelChars)) return null;
    const values = denseArray(item.values, seriesCount, seriesCount);
    if (!values) return null;
    const amounts = values.map((value) => amountOf(value, spec.unit));
    return amounts.some((value) => value == null) ? null : Object.freeze({ label: item.label, values: Object.freeze(amounts) });
  }
  if (type === 'kpi') {
    if (!exactKeys(item, ['label', 'value', 'unit']) || !boundedText(item.label, ANSWER_CHART_LIMITS.maxLabelChars) || !ANSWER_CHART_UNITS.includes(item.unit)) return null;
    const amount = amountOf(item.value, item.unit);
    return amount == null ? null : Object.freeze({ label: item.label, value: amount, unit: item.unit });
  }
  if (type === 'timeline') {
    if (!exactKeys(item, ['label', 'date']) || !boundedText(item.label, ANSWER_CHART_LIMITS.maxLabelChars) || typeof item.date !== 'string' || !DAY.test(item.date)) return null;
    return Object.freeze({ label: item.label, date: item.date });
  }
  if (!exactKeys(item, ['label', 'value']) || !boundedText(item.label, ANSWER_CHART_LIMITS.maxLabelChars)) return null;
  const amount = amountOf(item.value, spec.unit);
  return amount == null ? null : Object.freeze({ label: item.label, value: amount });
}

/** Kapalı biçimli grafik tanımı; uymuyorsa `null`. Dönen değer donmuş kopyadır. */
export function normalizeAnswerChart(value) {
  try {
    const type = value?.type;
    if (!ANSWER_CHART_TYPES.includes(type)) return null;
    if (!exactKeys(value, type === 'stacked' ? [...SPEC_KEYS, 'series'] : SPEC_KEYS) || value.version !== 1) return null;
    if (!ANSWER_CHART_UNITS.includes(value.unit) || !['tr', 'en'].includes(value.locale)) return null;
    if (!boundedText(value.title, ANSWER_CHART_LIMITS.maxTitleChars)) return null;
    const evidence = denseArray(value.evidence, 1, ANSWER_CHART_LIMITS.maxEvidence);
    if (!evidence || !evidence.every(isEvidenceId) || new Set(evidence).size !== evidence.length) return null;
    let series = null;
    if (type === 'stacked') {
      series = denseArray(value.series, 2, ANSWER_CHART_LIMITS.maxSeries);
      if (!series || !series.every((label) => boundedText(label, ANSWER_CHART_LIMITS.maxLabelChars)) || new Set(series).size !== series.length) return null;
    }
    const items = denseArray(value.items, ANSWER_CHART_LIMITS.minItems, ANSWER_CHART_LIMITS[ITEM_LIMITS[type]]);
    if (!items) return null;
    const normalized = [];
    for (const item of items) {
      const next = normalizeItem(type, item, value, series?.length || 0);
      if (!next) return null;
      normalized.push(next);
    }
    // Pasta dilimleri bir bütünün parçalarıdır: toplamı sıfır olan dağılım çizilmez.
    if (type === 'donut' && !normalized.some((item) => item.value > 0)) return null;
    // Zaman çizelgesi tarih sırasındadır (sunucu sıralar; bozuk sıra bir başka anlam taşıyamaz).
    if (type === 'timeline' && normalized.some((item, index) => index && item.date < normalized[index - 1].date)) return null;
    return Object.freeze({ version: 1, type, locale: value.locale, title: value.title, unit: value.unit, evidence: Object.freeze([...evidence]),
      ...(series ? { series: Object.freeze([...series]) } : {}), items: Object.freeze(normalized) });
  } catch {
    // Okunurken fırlayan erişimci (getter/Proxy) doğrulamadan kaçamaz.
    return null;
  }
}

/** Çitli bloğun gövdesi → doğrulanmış tanım ya da `null`. */
export function parseAnswerChart(text) {
  if (typeof text !== 'string' || text.length > ANSWER_CHART_LIMITS.maxSpecChars) return null;
  try {
    return normalizeAnswerChart(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Yanıta yazılacak çitli blok. JSON tek satırdır: çit içinde satır başlayamaz, dolayısıyla etiket metni
 * bloğu erken kapatamaz.
 */
export function answerChartFence(spec) {
  const normalized = normalizeAnswerChart(spec);
  if (!normalized) return null;
  const body = JSON.stringify(normalized);
  return body.length <= ANSWER_CHART_LIMITS.maxSpecChars ? `\`\`\`${ANSWER_CHART_FENCE}\n${body}\n\`\`\`` : null;
}

/** Sayının yerel yazımı ve birimi; grafik etiketi ve kopyalanan metin aynı biçimi kullanır. */
export function answerChartValue(value, unit, locale = 'tr') {
  // Küçük değerler sıfıra yuvarlanmaz; üç anlamlı basamak kayan nokta gürültüsünü sınırlar.
  const precision = value !== 0 && Math.abs(value) < 0.01 ? { maximumSignificantDigits: 3, notation: Math.abs(value) < 0.000001 ? 'scientific' : 'standard' } : { maximumFractionDigits: 2 };
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'tr-TR', precision).format(value);
  if (unit === 'percent') return locale === 'en' ? `${number}%` : `%${number}`;
  if (unit === 'days') return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'tr-TR', { ...precision, style: 'unit', unit: 'day', unitDisplay: 'long' }).format(value);
  if (unit === 'hours') return `${number} ${locale === 'en' ? 'h' : 'sa'}`;
  return number;
}

/** Takvim gününün yerel yazımı (zaman çizelgesi; saat dilimi kaydırması yoktur). */
export function answerChartDate(day, locale = 'tr') {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'tr-TR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${day}T00:00:00Z`));
}

/** Grafiğin düz metin karşılığı (kopyalama ve erişilebilir özet). */
export function answerChartText(spec) {
  const normalized = normalizeAnswerChart(spec);
  if (!normalized) return '';
  const { locale, unit } = normalized;
  const lines = normalized.type === 'stacked'
    ? [['', ...normalized.series].join('\t'), ...normalized.items.map((item) => [item.label, ...item.values.map((value) => answerChartValue(value, unit, locale))].join('\t'))]
    : normalized.type === 'kpi' ? normalized.items.map((item) => `${item.label}\t${answerChartValue(item.value, item.unit, locale)}`)
      : normalized.type === 'timeline' ? normalized.items.map((item) => `${answerChartDate(item.date, locale)}\t${item.label}`)
        : normalized.items.map((item) => `${item.label}\t${answerChartValue(item.value, unit, locale)}`);
  return [normalized.title, ...lines].join('\n');
}
