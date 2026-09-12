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
    code: code == null ? null : String(code).slice(0, 60),
    message: sanitizeText(message),
    correlationId: correlationId || currentCorrelationId(),
    durationMs: Number.isFinite(Number(durationMs)) ? Math.round(Number(durationMs)) : null
  };
  const safeContext = sanitizeContext(context);
  if (safeContext && Object.keys(safeContext).length) record.context = safeContext;
  const safeError = sanitizeError(error);
  if (safeError) record.error = safeError;
  return record;
}

/**
 * Günlüğe yazar.
 *
 * Yazma HİÇBİR KOŞULDA yukarı hata taşımaz: gözlemlenebilirlik, gözlediği
 * uygulamayı düşüremez.
 */
export function logEvent(input = {}) {
  let record;
  try {
    record = buildLogRecord(input);
    const method = CONSOLE_METHOD[record.level] || 'info';
    console[method](`[mergen-rota] ${JSON.stringify(record)}`);
  } catch {
    // Günlükleme hatası yutulur.
  }
  return record ?? null;
}
