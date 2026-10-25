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
export const ANSWER_CHART_TYPES = Object.freeze(['bar', 'donut']);
export const ANSWER_CHART_UNITS = Object.freeze(['count', 'days', 'hours', 'percent', 'number']);
export const ANSWER_CHART_LIMITS = Object.freeze({
  minItems: 2,
  maxBarItems: 12,
  maxDonutItems: 6,
  maxTitleChars: 80,
  maxLabelChars: 80,
  maxEvidence: 4,
  maxValue: 1e12,
  maxSpecChars: 4096
});

const SPEC_KEYS = ['version', 'type', 'locale', 'title', 'unit', 'evidence', 'items'];
const UNSAFE_TEXT = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

/** Üretici ve doğrulayıcı aynı metin güvenliği sözleşmesini kullanır. */
export function answerChartLabel(value, max = ANSWER_CHART_LIMITS.maxLabelChars) {
  const text = String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').replace(new RegExp(UNSAFE_TEXT.source, 'g'), '').replace(/ +/g, ' ').trim() || '—';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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

/** Kapalı biçimli grafik tanımı; uymuyorsa `null`. Dönen değer donmuş kopyadır. */
export function normalizeAnswerChart(value) {
  try {
    if (!exactKeys(value, SPEC_KEYS) || value.version !== 1) return null;
    if (!ANSWER_CHART_TYPES.includes(value.type) || !ANSWER_CHART_UNITS.includes(value.unit) || !['tr', 'en'].includes(value.locale)) return null;
    if (!boundedText(value.title, ANSWER_CHART_LIMITS.maxTitleChars)) return null;
    const evidence = denseArray(value.evidence, 1, ANSWER_CHART_LIMITS.maxEvidence);
    if (!evidence || !evidence.every(isEvidenceId) || new Set(evidence).size !== evidence.length) return null;
    const max = value.type === 'donut' ? ANSWER_CHART_LIMITS.maxDonutItems : ANSWER_CHART_LIMITS.maxBarItems;
    const items = denseArray(value.items, ANSWER_CHART_LIMITS.minItems, max);
    if (!items) return null;
    const normalized = [];
    for (const item of items) {
      if (!exactKeys(item, ['label', 'value']) || !boundedText(item.label, ANSWER_CHART_LIMITS.maxLabelChars)) return null;
      const amount = item.value;
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > ANSWER_CHART_LIMITS.maxValue) return null;
      if (value.unit === 'count' && !Number.isSafeInteger(amount)) return null;
      normalized.push(Object.freeze({ label: item.label, value: amount }));
    }
    // Pasta dilimleri bir bütünün parçalarıdır: toplamı sıfır olan dağılım çizilmez.
    if (value.type === 'donut' && !normalized.some((item) => item.value > 0)) return null;
    return Object.freeze({ version: 1, type: value.type, locale: value.locale, title: value.title, unit: value.unit, evidence: Object.freeze([...evidence]), items: Object.freeze(normalized) });
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
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'tr-TR', { maximumFractionDigits: 2 }).format(value);
  if (unit === 'percent') return locale === 'en' ? `${number}%` : `%${number}`;
  if (unit === 'days') return `${number} ${locale === 'en' ? 'days' : 'gün'}`;
  if (unit === 'hours') return `${number} ${locale === 'en' ? 'h' : 'sa'}`;
  return number;
}

/** Grafiğin düz metin karşılığı (kopyalama ve erişilebilir özet). */
export function answerChartText(spec) {
  const normalized = normalizeAnswerChart(spec);
  if (!normalized) return '';
  return [normalized.title, ...normalized.items.map((item) => `${item.label}\t${answerChartValue(item.value, normalized.unit, normalized.locale)}`)].join('\n');
}
