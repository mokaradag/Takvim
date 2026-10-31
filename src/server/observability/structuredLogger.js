import 'server-only';
import { sanitizeContext, sanitizeError, sanitizeText } from '../../domain/observability/redaction.js';
import { EVENT_SEVERITIES, normalizeSeverity } from '../../domain/observability/eventModel.js';
import { currentCorrelationId } from './correlation.js';

/**
 * Yapılandırılmış sunucu günlüğü.
 *
 * Her satır aynı alanları taşır: zaman, düzey, bileşen, işlem, olay kodu,
 * ilişkilendirme kimliği, süre ve TEMİZLENMİŞ bağlam. Serbest metin
 * `console.log` çağrıları yerine tek bir kapı kullanılır ki gizli değer
 * günlüğe hiçbir yoldan giremesin (bkz. domain/observability/redaction.js).
 */

const CONSOLE_METHOD = Object.freeze({
  [EVENT_SEVERITIES.INFO]: 'info',
  [EVENT_SEVERITIES.WARNING]: 'warn',
  [EVENT_SEVERITIES.ERROR]: 'error',
  [EVENT_SEVERITIES.CRITICAL]: 'error'
});

/** Günlük satırını üretir; yazma işleminden ayrı tutulur ki sınanabilsin. */
export function buildLogRecord({
  severity = EVENT_SEVERITIES.INFO,
  component,
  operation = null,
  code = null,
  message = '',
  correlationId = null,
  durationMs = null,
  context = null,
  error = null,
  now = new Date()
} = {}) {
  const timestamp = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const record = {
    timestamp: timestamp.toISOString(),
    level: normalizeSeverity(severity),
    component: String(component || 'APPLICATION'),
    operation: operation == null ? null : String(operation).slice(0, 100),
    code: code == null ? null : sanitizeText(code).slice(0, 60),
    message: sanitizeText(message),
    correlationId: correlationId || currentCorrelationId(),
    durationMs: durationMs != null && String(durationMs).trim() !== '' && Number.isFinite(Number(durationMs)) ? Math.round(Number(durationMs)) : null
  };
  const safeContext = sanitizeContext(context);
  if (safeContext && Object.keys(safeContext).length) record.context = safeContext;
  const safeError = sanitizeError(error);
  if (safeError) record.error = safeError;
  return record;
}

export const LOG_FORMATS = Object.freeze(['json', 'summary', 'both']);

/**
 * Konsol biçimi: `MERGEN_ROTA_LOG_FORMAT` = `json` (her olay tek JSON satırı), `summary` (özet satırı olan
 * olaylar için yalnızca kısa insan satırı; diğerleri JSON) ya da `both`. Verilmezse etkileşimli terminalde
 * `summary`, yönlendirilmiş çıktıda (dosya, günlük toplayıcı, test) `json`. Kayıt (`buildLogRecord`) her
 * biçimde aynıdır; biçim yalnızca konsola neyin yazıldığını seçer.
 */
export function consoleLogFormat(env = process.env, stream = process.stdout) {
  const configured = String(env.MERGEN_ROTA_LOG_FORMAT ?? '').trim().toLowerCase();
  if (LOG_FORMATS.includes(configured)) return configured;
  return stream?.isTTY ? 'summary' : 'json';
}

/**
 * Günlüğe yazar. `summary`, olayın içeriksiz bağlamından üretilmiş kısa insan satırıdır (ör. Bilgin turu);
 * aynı temizleyiciden geçer ve JSON kaydının yerine değil, seçilen biçime göre yanında ya da önünde yazılır.
 *
 * Yazma HİÇBİR KOŞULDA yukarı hata taşımaz: gözlemlenebilirlik, gözlediği
 * uygulamayı düşüremez.
 */
export function logEvent(input = {}) {
  let record;
  try {
    record = buildLogRecord(input);
    const method = CONSOLE_METHOD[record.level] || 'info';
    const summary = typeof input.summary === 'string' ? sanitizeText(input.summary) : '';
    // Biçim, olayın gerçekten yazıldığı akışa göre seçilir: console.warn/error stderr'e, console.info stdout'a yazar.
    const format = summary ? consoleLogFormat(process.env, method === 'info' ? process.stdout : process.stderr) : 'json';
    if (format !== 'json') console[method](`[mergen-rota] ${summary}${record.correlationId ? ` | ${String(record.correlationId).slice(0, 8)}` : ''}`);
    if (format !== 'summary') console[method](JSON.stringify(record));
  } catch {
    // Günlükleme hatası yutulur.
  }
  return record ?? null;
}
