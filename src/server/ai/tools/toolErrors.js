import 'server-only';
import { AI_ERROR_CODES } from '../../../domain/ai/aiErrorCatalog.js';

/**
 * Alan aracı hataları: modele verilen GÜVENLİ sınıflar.
 *
 * İleti ve ayrıntı sabittir ya da yalnızca doğrulama yolunu (`limit`,
 * `dateFrom` gibi alan adları) taşır; SQL metni, sürücü hatası, bağlantı dizesi,
 * yığın izi ya da yetki ayrıntısı hiçbir zaman modele gitmez. "Bulunamadı" ile
 * "yetkiniz yok" aynı sınıftır: var olmayan kayıt ile görülemeyen kayıt ayırt
 * edilemez.
 */

export const TOOL_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  NOT_FOUND: 'NOT_FOUND',
  UNSUPPORTED_SCOPE: 'UNSUPPORTED_SCOPE',
  UNSUPPORTED: 'UNSUPPORTED',
  RESULT_TOO_LARGE: 'RESULT_TOO_LARGE',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  TIMEOUT: 'TIMEOUT',
  BUSY: 'BUSY',
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
  INTERNAL: 'INTERNAL'
});

const MESSAGES = Object.freeze({
  INVALID_ARGUMENTS: 'Araç bağımsız değişkenleri geçersiz. Şemaya uygun değerlerle yeniden deneyin.',
  UNKNOWN_TOOL: 'Böyle bir araç yok. Yalnızca tanımlı Rota araçlarını kullanın.',
  NOT_FOUND: 'Kayıt bulunamadı ya da bu kaydı görüntüleme yetkiniz yok.',
  UNSUPPORTED_SCOPE: 'Bu bilgi yalnızca projede tam yetkisi olan kullanıcılara açıktır; mevcut erişim düzeyinizle gösterilemez.',
  UNSUPPORTED: 'Bu istek araç tarafından desteklenmiyor.',
  RESULT_TOO_LARGE: 'Sonuç kümesi güvenli sınırı aşıyor. Süzgeçleri daraltın (ör. proje ya da tarih aralığı verin).',
  LIMIT_EXCEEDED: 'Bu yanıt için araç çağrısı sınırına ulaşıldı. Eldeki kanıtla yanıtlayın ya da kullanıcıdan soruyu daraltmasını isteyin.',
  TIMEOUT: 'Veri süre sınırında alınamadı. Daha dar bir sorguyla yeniden deneyin.',
  BUSY: 'Rota verisi şu anda yoğun. Kısa bir süre sonra yeniden deneyin.',
  DATABASE_UNAVAILABLE: 'Rota verisine şu anda ulaşılamıyor.',
  INTERNAL: 'Veri alınırken beklenmeyen bir sorun oluştu.'
});

const DETAIL_TEXT = /^[$A-Za-z0-9_.[\]:, -]{1,120}$/;
/** Sürücünün bağlantı düzeyindeki hata kodları (sorgu hatası değil). */
const CONNECTION_CODES = new Set(['ESOCKET', 'ECONNCLOSED', 'ECONNRESET', 'ECONNREFUSED', 'ELOGIN', 'ENOTOPEN', 'ENOCONN', 'EINSTLOOKUP']);

export class ToolError extends Error {
  constructor(code, { message = null, details = null } = {}) {
    const known = Object.hasOwn(MESSAGES, code) ? code : TOOL_ERROR_CODES.INTERNAL;
    super(message || MESSAGES[known]);
    this.name = 'ToolError';
    this.code = known;
    this.details = Array.isArray(details)
      ? details.filter((item) => DETAIL_TEXT.test(String(item))).slice(0, 8).map(String)
      : [];
  }
}

export function isToolError(error) {
  return error instanceof ToolError;
}

export function invalidArguments(details = []) {
  return new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details });
}

/**
 * Yürütme sırasında oluşan her hatayı güvenli sınıfa indirir. Oturum ve iptal
 * hataları araç sonucu DEĞİLDİR: tur sonlandırılır (çağıran yeniden fırlatır).
 */
export function toToolError(error) {
  if (error instanceof ToolError) return error;
  if (error?.number === 51001 || error?.originalError?.info?.number === 51001) return new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
  const code = String(error?.code || '');
  if (code === AI_ERROR_CODES.AI_BUSY || code === AI_ERROR_CODES.AI_QUEUE_TIMEOUT) return new ToolError(TOOL_ERROR_CODES.BUSY);
  if (code === AI_ERROR_CODES.AI_TIMEOUT || code === 'ETIMEOUT') return new ToolError(TOOL_ERROR_CODES.TIMEOUT);
  if (code === 'DATABASE_UNAVAILABLE' || CONNECTION_CODES.has(code)) return new ToolError(TOOL_ERROR_CODES.DATABASE_UNAVAILABLE);
  if (code === 'FORBIDDEN' || code === 'NOT_FOUND') return new ToolError(TOOL_ERROR_CODES.NOT_FOUND);
  if (code === 'MUTATION_FAILED') return new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS);
  // Rehber aramasının oturum başına hız sınırı (429) kullanıcıya "yoğun" olarak döner.
  if (code === 'CONFLICT' && Number(error?.status) === 429) return new ToolError(TOOL_ERROR_CODES.BUSY);
  return new ToolError(TOOL_ERROR_CODES.INTERNAL);
}

/** Turu sonlandıran (araç sonucu olarak modele verilmeyen) hata mı? */
export function isTurnFatal(error) {
  const code = String(error?.code || '');
  return code === AI_ERROR_CODES.AI_CANCELLED || code === 'UNAUTHORIZED' || code === 'SESSION_REQUIRED';
}
