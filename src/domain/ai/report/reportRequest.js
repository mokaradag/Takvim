import { isIsoDay } from '../isoDay.js';
import {
  comparableWindows,
  namedWindow,
  previousWindow,
  rangeLabel,
  resolveWindow,
  windowKind,
  windowLength,
  windowName,
  windowPosition
} from '../temporalWindow.js';
import { businessDate } from '../../calendar/businessDate.js';

/**
 * Bilgin Aşama 4I-A — Yönetici raporu istek sözleşmesi ve kanıt paketi şema doğrulaması (saf).
 *
 * Bu modül yalnızca istek biçimini, takvim/dönem tutarlılığını, özel karşılaştırma kurallarını,
 * kanonik kapsam temsilini ve açık not rızasını belirlenimci olarak doğrular. Yetki kararı
 * vermez; kapsam kimliklerinden erişim hakkı türetmez.
 */

export const REPORT_EVIDENCE_SCHEMA = '4i-kanit-1';
export const REPORT_PERIOD_TYPES = Object.freeze(['haftalik', 'aylik', 'ozel']);
export const REPORT_SCOPE_TYPES = Object.freeze(['kisi', 'proje', 'projeler', 'ekip', 'birim', 'mudurluk', 'direktorluk']);
export const REPORT_DETAIL_LEVELS = Object.freeze(['kisa', 'standart', 'kapsamli']);
export const REPORT_FOCUS_OPTIONS = Object.freeze(['dengeli', 'basarilar', 'riskler', 'stratejik_oncelikler']);
export const REPORT_NOTE_CONSENT = Object.freeze(['dahil', 'haric']);
export const REPORT_COMPARISON_MODES = Object.freeze(['onceki_donem', 'ozel_donem', 'yok']);

export const REPORT_REQUEST_LIMITS = Object.freeze({
  maxProjectIds: 25,
  maxRangeDays: 366,
  maxIdentifierLength: 160,
  maxOrgPathLength: 500
});

export const REPORT_EVIDENCE_LIMITS = Object.freeze({
  maxEvidenceItems: 120,
  maxPackageChars: 120000,
  maxNoteChars: 1600,
  maxNoteAuditEvents: 250,
  maxSelectedTasks: 60,
  maxSelectedNotes: 40
});

export const REPORT_REQUEST_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'REPORT_INVALID_REQUEST',
  UNKNOWN_FIELD: 'REPORT_UNKNOWN_FIELD',
  INVALID_PERIOD: 'REPORT_INVALID_PERIOD',
  INCOMPLETE_PERIOD: 'REPORT_INCOMPLETE_PERIOD',
  INVALID_COMPARISON: 'REPORT_INVALID_COMPARISON',
  INVALID_SCOPE: 'REPORT_INVALID_SCOPE',
  INVALID_CONSENT: 'REPORT_INVALID_CONSENT'
});

const ALLOWED_REQUEST_FIELDS = new Set([
  'rapor_turu',
  'donem',
  'kapsam',
  'ayrinti',
  'odak',
  'notlar',
  'karsilastirma',
  'karsilastirma_donemi'
]);

const ALLOWED_RANGE_FIELDS = new Set(['baslangic', 'bitis']);
const ALLOWED_SCOPE_FIELDS = new Set(['tur', 'kimlikler']);
const ORG_SCOPE_TYPES = new Set(['birim', 'mudurluk', 'direktorluk']);
// Kurumsal hiyerarşi yol anahtarları 0x1F ayırıcısını kullanır; diğer denetim karakterleri yasaktır.
// eslint-disable-next-line no-control-regex -- genel kapsam kimliklerinde yasak denetim karakterleri bilinçli olarak eşleştirilir
const FORBIDDEN_GENERAL_CONTROL = /[\u0000-\u001F\u007F]/u;
// eslint-disable-next-line no-control-regex -- kurumsal yol anahtarı 0x1F ayırıcısını koruyarak diğer denetim karakterlerini reddeder
const FORBIDDEN_ORG_CONTROL = /[\u0000-\u001E\u007F]/u;

const ISTANBUL_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Istanbul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

/** Yönetici raporu isteği doğrulama hatası (ham korunan içerik taşımaz). */
export class ReportRequestError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = 'ReportRequestError';
    this.code = code;
    this.details = Object.freeze([...details]);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ownProp(obj, key) {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

const ISO_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/u;

/** Geçerli ISO-8601 zaman damgasını milisaniye altı (nanosaniye) kesinlikte UTC BigInt değerine çevirir. */
function parseIsoTimestampNanos(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_TIMESTAMP_RE.exec(value);
  if (!match) return null;
  const [, datePart, hourStr, minStr, secStr, fracStr = '', tzPart, tzSign, offHStr, offMStr] = match;
  if (!isIsoDay(datePart)) return null;
  const hour = Number(hourStr);
  const minute = Number(minStr);
  const second = Number(secStr);
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  if (tzPart !== 'Z') {
    const offH = Number(offHStr);
    const offM = Number(offMStr);
    if (offH > 23 || offM > 59) return null;
    offsetMinutes = (tzSign === '-' ? -1 : 1) * (offH * 60 + offM);
  }
  const [year, month, day] = datePart.split('-').map(Number);
  const baseMs = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(baseMs)) return null;
  const utcSec = BigInt(Math.trunc(baseMs / 1000) - offsetMinutes * 60);
  const nanos = BigInt(fracStr.padEnd(9, '0'));
  return utcSec * 1000000000n + nanos;
}

function rejectUnknownFields(obj, allowed, prefix) {
  const unknown = Object.keys(obj).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.UNKNOWN_FIELD,
      'Rapor isteğinde desteklenmeyen alan bulundu.',
      unknown.map((key) => `${prefix}.${key}:unsupported`)
    );
  }
}

export const MAX_PACKAGE_NESTING_DEPTH = 40;

/** Veri anı zaman damgasını doğrulanmış Date nesnesine çevirir; saat dilimi eksik, milisaniye altı kesinlik taşıyan veya geçersiz girdi fırlatır. */
export function normalizeReportNow(value = new Date()) {
  let date = null;
  if (value instanceof Date) {
    date = new Date(value.getTime());
  } else if (typeof value === 'string') {
    const nanos = parseIsoTimestampNanos(value);
    // SQL DateTime2 kesit sınırı JS Date (milisaniye) üzerinden taşındığından milisaniye altı kesirli anlar sessizce yuvarlanmaz.
    if (nanos !== null && nanos % 1000000n === 0n) {
      const ms = nanos / 1000000n;
      date = new Date(Number(ms));
    }
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    date = new Date(value);
  }
  if (!date || !Number.isFinite(date.getTime())) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_REQUEST,
      'Geçerli, milisaniye hassasiyetinde ve saat dilimi açık bir veri anı zaman damgası gereklidir.',
      ['$.now:invalid']
    );
  }
  return date;
}

/** Veri anı ISO zaman damgasının Europe/Istanbul takvim gününü (YYYY-AA-GG) döndürür; geçersizse null. */
export function snapshotBusinessDay(value) {
  const nanos = parseIsoTimestampNanos(value);
  if (nanos === null) return null;
  const ms = Number(nanos >= 0n ? nanos / 1000000n : -((-nanos + 999999n) / 1000000n));
  return businessDate(new Date(ms));
}

/** Verilen anı Europe/Istanbul saat diliminde (tam dakika farkı yoksa UTC olarak) ISO-8601 metnine çevirir. */
export function formatIstanbulTimestamp(value = new Date()) {
  const date = normalizeReportNow(value);
  const map = Object.fromEntries(
    ISTANBUL_PARTS.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map(({ type, value: partValue }) => [type, partValue])
  );
  const localUtcMs = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  const wholeSecUtcMs = Math.floor(date.getTime() / 1000) * 1000;
  const offsetMs = localUtcMs - wholeSecUtcMs;
  // Kesirli milisaniyeler sıfırdan farklıysa yayımlanan veri kesitinde korunur; tam saniyelerde eski biçim değişmez.
  const ms = ((date.getTime() % 1000) + 1000) % 1000;
  // Tarihsel saat dilimi farkı saniye bileşeni taşıyorsa tam anı korumak için UTC olarak yayımlanır.
  if (offsetMs % 60000 !== 0) {
    const iso = date.toISOString();
    return ms === 0 ? iso.replace(/\.000Z$/u, 'Z') : iso;
  }
  const offsetMinutes = offsetMs / 60000;
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(offsetMinutes);
  const offH = String(Math.floor(absMinutes / 60)).padStart(2, '0');
  const offM = String(absMinutes % 60).padStart(2, '0');
  const fraction = ms === 0 ? '' : `.${String(ms).padStart(3, '0')}`;
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}${fraction}${sign}${offH}:${offM}`;
}

/** Dönem aralığı nesnesini doğrular ve `dateFrom`/`dateTo` çiftine çevirir. */
function parseExplicitRange(raw, fieldName, errorCode) {
  if (!isPlainObject(raw)) {
    throw new ReportRequestError(
      errorCode,
      'Dönem aralığı başlangıç ve bitiş tarihlerini içeren bir nesne olmalıdır.',
      [`$.${fieldName}:object_required`]
    );
  }
  rejectUnknownFields(raw, ALLOWED_RANGE_FIELDS, `$.${fieldName}`);
  const baslangic = ownProp(raw, 'baslangic');
  const bitis = ownProp(raw, 'bitis');
  if (!isIsoDay(baslangic) || !isIsoDay(bitis)) {
    throw new ReportRequestError(
      errorCode,
      'Başlangıç ve bitiş tarihleri geçerli ISO takvim günü (YYYY-AA-GG) olmalıdır.',
      [`$.${fieldName}:invalid_iso_day`]
    );
  }
  if (baslangic > bitis) {
    throw new ReportRequestError(
      errorCode,
      'Dönem başlangıç tarihi bitiş tarihinden sonra olamaz.',
      [`$.${fieldName}:reversed`]
    );
  }
  const range = { dateFrom: baslangic, dateTo: bitis };
  if (windowLength(range) > REPORT_REQUEST_LIMITS.maxRangeDays) {
    throw new ReportRequestError(
      errorCode,
      `Raporlama dönemi en fazla ${REPORT_REQUEST_LIMITS.maxRangeDays} takvim günü olabilir.`,
      [`$.${fieldName}:max_range_exceeded`]
    );
  }
  return range;
}

/** Dönem aralığını okunur Türkçe adla kalıcı nesneye dönüştürür. */
function finalizePeriod(range, today) {
  const named = namedWindow(range, today);
  const ad = (named && windowName(named, 'tr')) || rangeLabel(range, 'tr');
  return Object.freeze({
    baslangic: range.dateFrom,
    bitis: range.dateTo,
    ad,
    gun_sayisi: windowLength(range)
  });
}

/** Rapor dönemini tür ve kapanmış dönem kurallarıyla çözer. */
function resolveReportPeriod(raporTuru, rawDonem, today, closureDay = today) {
  let range = null;
  if (rawDonem === undefined) {
    if (raporTuru === 'haftalik') {
      range = resolveWindow('last_week', today);
    } else if (raporTuru === 'aylik') {
      range = resolveWindow('last_month', today);
    } else {
      throw new ReportRequestError(
        REPORT_REQUEST_ERROR_CODES.INVALID_PERIOD,
        'Özel rapor türü için açık başlangıç ve bitiş tarihleri zorunludur.',
        ['$.donem:required']
      );
    }
  } else if (typeof rawDonem === 'string') {
    if (raporTuru === 'ozel') {
      throw new ReportRequestError(
        REPORT_REQUEST_ERROR_CODES.INVALID_PERIOD,
        'Özel rapor türünde adlandırılmış pencere yerine açık tarih çifti verilmelidir.',
        ['$.donem:explicit_range_required']
      );
    }
    range = resolveWindow(rawDonem, today);
    if (!range) {
      throw new ReportRequestError(
        REPORT_REQUEST_ERROR_CODES.INVALID_PERIOD,
        'Desteklenmeyen dönem penceresi adı.',
        ['$.donem:unknown_window']
      );
    }
  } else {
    range = parseExplicitRange(rawDonem, 'donem', REPORT_REQUEST_ERROR_CODES.INVALID_PERIOD);
  }

  if (!isIsoDay(range.dateFrom) || !isIsoDay(range.dateTo)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_PERIOD,
      'Rapor dönemi 1900–2100 takvim aralığında olmalıdır.',
      ['$.donem:outside_supported_calendar']
    );
  }

  const effectiveClosureDay = closureDay && closureDay < today ? closureDay : today;
  const position = windowPosition(range, effectiveClosureDay);
  if (!position || position.position !== 'past' || position.open) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INCOMPLETE_PERIOD,
      'Yönetici raporu yalnızca tamamlanmış geçmiş dönemler için hazırlanabilir; açık veya gelecek dönem kabul edilmez.',
      [`$.donem:${position?.position || 'invalid'}`]
    );
  }

  const length = windowLength(range);
  if (raporTuru === 'haftalik' && length !== 7) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_PERIOD,
      'Haftalık rapor dönemi tam 7 takvim günü olmalıdır.',
      ['$.donem:weekly_length_mismatch']
    );
  }
  if (raporTuru === 'aylik' && windowKind(range) !== 'month') {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_PERIOD,
      'Aylık rapor dönemi tam bir takvim ayı (ilk günden son güne) olmalıdır.',
      ['$.donem:monthly_boundary_mismatch']
    );
  }

  return range;
}

/** Kanonik kapsam nesnesini doğrular; eski paralel alanları ve yinelenen kimlikleri reddeder. */
function validateScope(rawKapsam) {
  if (!isPlainObject(rawKapsam)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_SCOPE,
      'Rapor kapsamı { tur, kimlikler } nesnesi olmalıdır.',
      ['$.kapsam:object_required']
    );
  }
  rejectUnknownFields(rawKapsam, ALLOWED_SCOPE_FIELDS, '$.kapsam');
  const tur = ownProp(rawKapsam, 'tur');
  const kimlikler = ownProp(rawKapsam, 'kimlikler');
  if (typeof tur !== 'string' || !REPORT_SCOPE_TYPES.includes(tur)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_SCOPE,
      'Desteklenmeyen rapor kapsam türü.',
      ['$.kapsam.tur:invalid']
    );
  }
  if (!Array.isArray(kimlikler) || kimlikler.length === 0) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_SCOPE,
      'Kapsam kimlikleri boş olmayan bir dizi olmalıdır.',
      ['$.kapsam.kimlikler:empty']
    );
  }
  if (tur !== 'projeler' && kimlikler.length !== 1) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_SCOPE,
      'Tekil kapsam türlerinde tam olarak bir kapsam kimliği verilmelidir.',
      ['$.kapsam.kimlikler:single_required']
    );
  }
  if (tur === 'projeler' && kimlikler.length > REPORT_REQUEST_LIMITS.maxProjectIds) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_SCOPE,
      `Çok projeli raporda en fazla ${REPORT_REQUEST_LIMITS.maxProjectIds} proje seçilebilir.`,
      ['$.kapsam.kimlikler:max_exceeded']
    );
  }

  const forbiddenControl = ORG_SCOPE_TYPES.has(tur) ? FORBIDDEN_ORG_CONTROL : FORBIDDEN_GENERAL_CONTROL;
  const maxIdLen = ORG_SCOPE_TYPES.has(tur) ? REPORT_REQUEST_LIMITS.maxOrgPathLength : REPORT_REQUEST_LIMITS.maxIdentifierLength;
  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < kimlikler.length; index += 1) {
    const raw = kimlikler[index];
    if (typeof raw !== 'string') {
      throw new ReportRequestError(
        REPORT_REQUEST_ERROR_CODES.INVALID_SCOPE,
        'Her kapsam kimliği metin olmalıdır.',
        [`$.kapsam.kimlikler[${index}]:type`]
      );
    }
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > maxIdLen || forbiddenControl.test(trimmed)) {
      throw new ReportRequestError(
        REPORT_REQUEST_ERROR_CODES.INVALID_SCOPE,
        'Geçersiz veya sınır dışı kapsam kimliği.',
        [`$.kapsam.kimlikler[${index}]:format`]
      );
    }
    const dedupeKey = trimmed.toLocaleLowerCase('tr-TR');
    if (seen.has(dedupeKey)) {
      throw new ReportRequestError(
        REPORT_REQUEST_ERROR_CODES.INVALID_SCOPE,
        'Kapsam kimlikleri yinelenemez.',
        [`$.kapsam.kimlikler[${index}]:duplicate`]
      );
    }
    seen.add(dedupeKey);
    normalized.push(trimmed);
  }

  return Object.freeze({ tur, kimlikler: Object.freeze(normalized) });
}

/** Karşılaştırma kipi ve dönemini doğrular; uyumsuz veya eksik özel aralıkları reddeder. */
function resolveComparison(karsilastirma, rawCustomRange, reportRange, today) {
  if (karsilastirma !== 'ozel_donem' && rawCustomRange !== undefined) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_COMPARISON,
      'Özel karşılaştırma aralığı yalnızca karsilastirma="ozel_donem" seçildiğinde verilebilir.',
      ['$.karsilastirma_donemi:unexpected']
    );
  }
  if (karsilastirma === 'yok') return null;

  if (karsilastirma === 'onceki_donem') {
    const prev = previousWindow(reportRange);
    if (!prev || !isIsoDay(prev.dateFrom) || !isIsoDay(prev.dateTo) || !comparableWindows(prev, reportRange)) {
      throw new ReportRequestError(
        REPORT_REQUEST_ERROR_CODES.INVALID_COMPARISON,
        'Önceki dönem bu rapor aralığıyla karşılaştırılabilir değil.',
        ['$.karsilastirma:incomparable']
      );
    }
    const prevPos = windowPosition(prev, today);
    if (!prevPos || prevPos.position !== 'past' || prev.dateTo >= reportRange.dateFrom) {
      throw new ReportRequestError(
        REPORT_REQUEST_ERROR_CODES.INVALID_COMPARISON,
        'Karşılaştırma dönemi rapor döneminden önce bitmiş olmalıdır.',
        ['$.karsilastirma:not_prior_completed']
      );
    }
    return prev;
  }

  if (rawCustomRange === undefined) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_COMPARISON,
      'Özel karşılaştırma için başlangıç ve bitiş tarihleri zorunludur.',
      ['$.karsilastirma_donemi:required']
    );
  }
  const compRange = parseExplicitRange(rawCustomRange, 'karsilastirma_donemi', REPORT_REQUEST_ERROR_CODES.INVALID_COMPARISON);
  const compPos = windowPosition(compRange, today);
  if (!compPos || compPos.position !== 'past' || compPos.open) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_COMPARISON,
      'Özel karşılaştırma dönemi tamamlanmış geçmiş bir dönem olmalıdır.',
      ['$.karsilastirma_donemi:not_completed']
    );
  }
  if (compRange.dateTo >= reportRange.dateFrom) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_COMPARISON,
      'Karşılaştırma dönemi rapor dönemi başlamadan önce bitmelidir; örtüşen veya sonraki dönem kabul edilmez.',
      ['$.karsilastirma_donemi:not_before_report']
    );
  }
  if (windowLength(compRange) !== windowLength(reportRange)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_COMPARISON,
      'Özel karşılaştırma dönemi ile rapor döneminin kapsayıcı takvim günü uzunlukları eşit olmalıdır.',
      ['$.karsilastirma_donemi:unequal_length']
    );
  }
  return compRange;
}

/**
 * Yönetici raporu isteğini kanonik 4I-A sözleşmesine göre doğrular ve normalleştirir.
 *
 * @param {object} input - Ham rapor isteği.
 * @param {{ now?: Date, today?: string | null }} [options] - Türkiye iş günü çözüm bağlamı.
 * @returns {object} Değişmez, doğrulanmış rapor isteği.
 */
export function validateExecutiveReportRequest(input, { now = undefined, today = null } = {}) {
  if (!isPlainObject(input)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_REQUEST,
      'Rapor isteği geçerli bir nesne olmalıdır.',
      ['$:object_required']
    );
  }
  rejectUnknownFields(input, ALLOWED_REQUEST_FIELDS, '$');

  const normalizedNow = now === undefined ? null : normalizeReportNow(now);
  const cutoffDay = normalizedNow ? businessDate(normalizedNow) : (today == null ? businessDate(new Date()) : null);
  const resolvedToday = today ?? cutoffDay;
  if (!isIsoDay(resolvedToday)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_REQUEST,
      'Geçerli bir Türkiye iş günü çözümlenemedi.',
      ['$.today:invalid']
    );
  }
  const closureDay = cutoffDay && cutoffDay < resolvedToday ? cutoffDay : resolvedToday;

  const raporTuru = ownProp(input, 'rapor_turu');
  if (typeof raporTuru !== 'string' || !REPORT_PERIOD_TYPES.includes(raporTuru)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_REQUEST,
      'Rapor türü haftalik, aylik veya ozel olmalıdır.',
      ['$.rapor_turu:invalid']
    );
  }

  const rawAyrinti = ownProp(input, 'ayrinti');
  const ayrinti = rawAyrinti === undefined ? 'standart' : rawAyrinti;
  if (typeof ayrinti !== 'string' || !REPORT_DETAIL_LEVELS.includes(ayrinti)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_REQUEST,
      'Ayrıntı düzeyi kisa, standart veya kapsamli olmalıdır.',
      ['$.ayrinti:invalid']
    );
  }

  const rawOdak = ownProp(input, 'odak');
  const odak = rawOdak === undefined ? 'dengeli' : rawOdak;
  if (typeof odak !== 'string' || !REPORT_FOCUS_OPTIONS.includes(odak)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_REQUEST,
      'Yönetim odağı desteklenmeyen bir değer taşıyor.',
      ['$.odak:invalid']
    );
  }

  // Açık not rızası yalnızca kendi özelliğinden okunur; yoksa varsayılan her zaman hariçtir.
  const rawNotlar = ownProp(input, 'notlar');
  const notlar = rawNotlar === undefined ? 'haric' : rawNotlar;
  if (typeof notlar !== 'string' || !REPORT_NOTE_CONSENT.includes(notlar)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_CONSENT,
      'Görev notları tercihi açıkça "dahil" veya "haric" olmalıdır.',
      ['$.notlar:invalid']
    );
  }

  const rawKarsilastirma = ownProp(input, 'karsilastirma');
  const karsilastirma = rawKarsilastirma === undefined ? 'yok' : rawKarsilastirma;
  if (typeof karsilastirma !== 'string' || !REPORT_COMPARISON_MODES.includes(karsilastirma)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_COMPARISON,
      'Karşılaştırma kipi onceki_donem, ozel_donem veya yok olmalıdır.',
      ['$.karsilastirma:invalid']
    );
  }

  const kapsam = validateScope(ownProp(input, 'kapsam'));
  const reportRange = resolveReportPeriod(raporTuru, ownProp(input, 'donem'), resolvedToday, closureDay);
  const comparisonRange = resolveComparison(karsilastirma, ownProp(input, 'karsilastirma_donemi'), reportRange, closureDay);

  return Object.freeze({
    rapor_turu: raporTuru,
    donem: finalizePeriod(reportRange, resolvedToday),
    kapsam,
    ayrinti,
    odak,
    notlar,
    karsilastirma,
    ...(comparisonRange ? { karsilastirma_donemi: finalizePeriod(comparisonRange, resolvedToday) } : {})
  });
}

export const PROTECTED_TEXT_KEYS = Object.freeze(['degisiklik_metni', 'once_metin', 'sonra_metin', 'not_metni', 'metin']);
const ALLOWED_EVIDENCE_TYPES = new Set(['olcu', 'gorev', 'not', 'hareket', 'belge']);
const ALLOWED_SOURCES_BY_TYPE = Object.freeze({
  olcu: new Set(['rota_task_analytics', 'rota_activity_search']),
  gorev: new Set(['rota_task_search']),
  not: new Set(['MR_AuditLog', 'MR_Tasks']),
  hareket: new Set(['rota_activity_search']),
  belge: new Set(['gecici_yukleme'])
});
const PERIOD_MEASURE_NAMES = new Set(['tamamlanan', 'hareket']);
const SNAPSHOT_MEASURE_NAMES = new Set(['acik', 'geciken', 'yaklasan_7_gun', 'history.undatedDone']);

/** Geçerli takvim günü, saat ve saat dilimi farkı taşıyan ISO-8601 zaman damgasını doğrular. */
export function isValidIsoTimestamp(value) {
  return parseIsoTimestampNanos(value) !== null;
}

function samePeriodRange(left, right) {
  return Boolean(left && right && left.baslangic === right.baslangic && left.bitis === right.bitis);
}

const PROTECTED_TEXT_KEY_SET = new Set(PROTECTED_TEXT_KEYS);

function hasSparseHole(arr) {
  for (let index = 0; index < arr.length; index += 1) {
    if (!Object.hasOwn(arr, index)) return true;
  }
  return false;
}

function exceedsMaxNestingDepth(value, maxDepth = MAX_PACKAGE_NESTING_DEPTH, ancestors = new WeakSet(), safeAtDepth = new WeakMap(), depth = 0) {
  if (!value || typeof value !== 'object') return false;
  if (depth > maxDepth) return true;
  if (ancestors.has(value)) return false;
  const prevSafeDepth = safeAtDepth.get(value);
  if (prevSafeDepth !== undefined && prevSafeDepth >= depth) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) continue;
        if (exceedsMaxNestingDepth(value[index], maxDepth, ancestors, safeAtDepth, depth + 1)) return true;
      }
    } else {
      for (const key of Object.keys(value)) {
        if (exceedsMaxNestingDepth(value[key], maxDepth, ancestors, safeAtDepth, depth + 1)) return true;
      }
    }
    safeAtDepth.set(value, depth);
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function findProtectedTextKeyPaths(value, prefix, out, visited = new Set(), depth = 0) {
  if (!value || typeof value !== 'object') return;
  if (depth > MAX_PACKAGE_NESTING_DEPTH) return;
  if (visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) continue;
      findProtectedTextKeyPaths(value[index], `${prefix}[${index}]`, out, visited, depth + 1);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    const nextPath = prefix ? `${prefix}.${key}` : key;
    if (PROTECTED_TEXT_KEY_SET.has(key)) {
      out.push(nextPath);
    } else {
      findProtectedTextKeyPaths(value[key], nextPath, out, visited, depth + 1);
    }
  }
}

/**
 * Kurulmuş bir `4i-kanit-1` kanıt paketinin yapısal bütünlüğünü, kimlik tutarlılığını,
 * rıza sınırını ve serileştirilmiş boyut sınırlarını doğrular.
 *
 * @param {object} pkg - Kanıt paketi nesnesi.
 * @returns {{ ok: boolean, problems: string[], serializedChars: number }} Doğrulama sonucu.
 */
export function validateEvidencePackageContract(pkg) {
  const problems = [];
  if (!isPlainObject(pkg)) return { ok: false, problems: ['paket:nesne_degil'], serializedChars: 0 };
  const tooDeep = exceedsMaxNestingDepth(pkg, MAX_PACKAGE_NESTING_DEPTH);
  if (tooDeep) {
    problems.push('paket:derinlik_siniri_asildi');
  }
  if (pkg.sema !== REPORT_EVIDENCE_SCHEMA) problems.push('sema:gecersiz');

  // İstek üstverisinin temel alanları, rapor türü sınırları, karşılaştırma kipi ve kanonik kapsam yapısı doğrulanır.
  let reportPeriod = null;
  let comparisonPeriod = null;
  if (!isPlainObject(pkg.istek)) {
    problems.push('istek:eksik');
  } else {
    const raporTuru = ownProp(pkg.istek, 'rapor_turu');
    const validRaporTuru = typeof raporTuru === 'string' && REPORT_PERIOD_TYPES.includes(raporTuru);
    if (!validRaporTuru) {
      problems.push('istek:rapor_turu_gecersiz');
    }

    const rawAyrinti = ownProp(pkg.istek, 'ayrinti');
    if (rawAyrinti !== undefined && (typeof rawAyrinti !== 'string' || !REPORT_DETAIL_LEVELS.includes(rawAyrinti))) {
      problems.push('istek:ayrinti_gecersiz');
    }

    const rawOdak = ownProp(pkg.istek, 'odak');
    if (rawOdak !== undefined && (typeof rawOdak !== 'string' || !REPORT_FOCUS_OPTIONS.includes(rawOdak))) {
      problems.push('istek:odak_gecersiz');
    }

    const rawDonem = ownProp(pkg.istek, 'donem');
    const donemBaslangic = isPlainObject(rawDonem) ? ownProp(rawDonem, 'baslangic') : undefined;
    const donemBitis = isPlainObject(rawDonem) ? ownProp(rawDonem, 'bitis') : undefined;
    if (!isPlainObject(rawDonem) || !isIsoDay(donemBaslangic) || !isIsoDay(donemBitis)
      || donemBaslangic > donemBitis) {
      problems.push('istek:donem_gecersiz');
    } else {
      const reportRange = { dateFrom: donemBaslangic, dateTo: donemBitis };
      const reportLen = windowLength(reportRange);
      const donemGunSayisi = ownProp(rawDonem, 'gun_sayisi');
      const gunSayisiOk = donemGunSayisi === undefined
        || (Number.isSafeInteger(donemGunSayisi) && donemGunSayisi === reportLen);
      const periodMatchesType = gunSayisiOk
        && reportLen <= REPORT_REQUEST_LIMITS.maxRangeDays
        && (raporTuru !== 'haftalik' || reportLen === 7)
        && (raporTuru !== 'aylik' || windowKind(reportRange) === 'month');
      if (!periodMatchesType) {
        problems.push('istek:donem_gecersiz');
      } else {
        reportPeriod = { baslangic: donemBaslangic, bitis: donemBitis };
      }
      const donemAd = ownProp(rawDonem, 'ad');
      if (donemAd !== undefined && typeof donemAd !== 'string') {
        problems.push('istek:donem_ad_gecersiz');
      }
    }

    const rawKarsilastirma = ownProp(pkg.istek, 'karsilastirma');
    const karsilastirma = rawKarsilastirma === undefined ? 'yok' : rawKarsilastirma;
    if (typeof karsilastirma !== 'string' || !REPORT_COMPARISON_MODES.includes(karsilastirma)) {
      problems.push('istek:karsilastirma_gecersiz');
    } else if (karsilastirma === 'yok') {
      if (ownProp(pkg.istek, 'karsilastirma_donemi') !== undefined) {
        problems.push('istek:karsilastirma_donemi_gecersiz');
      }
    } else {
      const compObj = ownProp(pkg.istek, 'karsilastirma_donemi');
      const compBaslangic = isPlainObject(compObj) ? ownProp(compObj, 'baslangic') : undefined;
      const compBitis = isPlainObject(compObj) ? ownProp(compObj, 'bitis') : undefined;
      const compFormatOk = isPlainObject(compObj)
        && isIsoDay(compBaslangic)
        && isIsoDay(compBitis)
        && compBaslangic <= compBitis;
      if (!compFormatOk) {
        problems.push('istek:karsilastirma_donemi_gecersiz');
      } else {
        const compAd = ownProp(compObj, 'ad');
        if (compAd !== undefined && typeof compAd !== 'string') {
          problems.push('istek:karsilastirma_donemi_ad_gecersiz');
        }
        const compRange = { dateFrom: compBaslangic, dateTo: compBitis };
        const compLen = windowLength(compRange);
        const compGunSayisi = ownProp(compObj, 'gun_sayisi');
        const compGunSayisiOk = compGunSayisi === undefined
          || (Number.isSafeInteger(compGunSayisi) && compGunSayisi === compLen);
        let compValid = compGunSayisiOk && compLen <= REPORT_REQUEST_LIMITS.maxRangeDays;
        if (compValid && reportPeriod) {
          const repRange = { dateFrom: reportPeriod.baslangic, dateTo: reportPeriod.bitis };
          if (compRange.dateTo >= repRange.dateFrom) {
            compValid = false;
          } else if (karsilastirma === 'onceki_donem') {
            const expectedPrev = previousWindow(repRange);
            compValid = Boolean(expectedPrev
              && expectedPrev.dateFrom === compRange.dateFrom
              && expectedPrev.dateTo === compRange.dateTo
              && comparableWindows(compRange, repRange));
          } else if (karsilastirma === 'ozel_donem') {
            compValid = compLen === windowLength(repRange);
          }
        }
        if (compValid) {
          comparisonPeriod = { baslangic: compBaslangic, bitis: compBitis };
        } else {
          problems.push('istek:karsilastirma_donemi_gecersiz');
        }
      }
    }

    const scopeObj = ownProp(pkg.istek, 'kapsam');
    const scopeValid = (() => {
      if (!isPlainObject(scopeObj)) return false;
      if (Object.keys(scopeObj).some((key) => !ALLOWED_SCOPE_FIELDS.has(key))) return false;
      const scopeTur = ownProp(scopeObj, 'tur');
      const scopeIds = ownProp(scopeObj, 'kimlikler');
      if (typeof scopeTur !== 'string' || !REPORT_SCOPE_TYPES.includes(scopeTur)) return false;
      if (!Array.isArray(scopeIds) || scopeIds.length === 0 || hasSparseHole(scopeIds)) return false;
      if (scopeTur !== 'projeler' && scopeIds.length !== 1) return false;
      if (scopeTur === 'projeler' && scopeIds.length > REPORT_REQUEST_LIMITS.maxProjectIds) return false;
      const forbiddenControl = ORG_SCOPE_TYPES.has(scopeTur) ? FORBIDDEN_ORG_CONTROL : FORBIDDEN_GENERAL_CONTROL;
      const maxIdLen = ORG_SCOPE_TYPES.has(scopeTur)
        ? REPORT_REQUEST_LIMITS.maxOrgPathLength
        : REPORT_REQUEST_LIMITS.maxIdentifierLength;
      const seen = new Set();
      for (const rawId of scopeIds) {
        if (typeof rawId !== 'string') return false;
        const trimmed = rawId.trim();
        if (!trimmed || trimmed.length > maxIdLen || forbiddenControl.test(trimmed)) return false;
        const key = trimmed.toLocaleLowerCase('tr-TR');
        if (seen.has(key)) return false;
        seen.add(key);
      }
      return true;
    })();
    if (!scopeValid) {
      problems.push('istek:kapsam_gecersiz');
    }
    const rawNotlar = ownProp(pkg.istek, 'notlar');
    if (typeof rawNotlar !== 'string' || !REPORT_NOTE_CONSENT.includes(rawNotlar)) {
      problems.push('istek:notlar_gecersiz');
    }
  }

  const cutOffNanos = parseIsoTimestampNanos(pkg.veri_ani);
  const cutOffBusinessDay = snapshotBusinessDay(pkg.veri_ani);
  const validVeriAni = cutOffNanos !== null && cutOffBusinessDay !== null;
  if (!validVeriAni) {
    problems.push('veri_ani:gecersiz');
  } else if (reportPeriod) {
    // Rapor dönemi veri anındaki İstanbul iş gününden önce kapanmış olmalıdır.
    const periodPos = windowPosition({ dateFrom: reportPeriod.baslangic, dateTo: reportPeriod.bitis }, cutOffBusinessDay);
    if (!periodPos || periodPos.position !== 'past' || periodPos.open) {
      problems.push('istek:donem_acik');
    }
  }

  const kanitlar = Array.isArray(pkg.kanitlar) ? pkg.kanitlar : null;
  const turetilmis = Array.isArray(pkg.turetilmis) ? pkg.turetilmis : null;
  const celiskiler = Array.isArray(pkg.celiskiler) ? pkg.celiskiler : null;
  if (!kanitlar) problems.push('kanitlar:dizi_degil');
  if (!turetilmis) problems.push('turetilmis:dizi_degil');
  if (!isPlainObject(pkg.tamlik)) problems.push('tamlik:eksik');
  if (!celiskiler) problems.push('celiskiler:dizi_degil');
  if (!isPlainObject(pkg.sinirlar)) problems.push('sinirlar:eksik');

  // Paket sınırları negatif olmayan güvenli tam sayı olmalı ve şema tavanını aşamamalıdır.
  const resolveBoundLimit = (rawValue, ceiling, keyName) => {
    if (rawValue === undefined) return ceiling;
    if (!Number.isSafeInteger(rawValue) || rawValue < 0) {
      problems.push(`sinirlar:gecersiz:${keyName}`);
      return ceiling;
    }
    if (rawValue > ceiling) {
      problems.push(`sinirlar:tavan_asildi:${keyName}`);
      return ceiling;
    }
    return rawValue;
  };
  const limitsObj = isPlainObject(pkg.sinirlar) ? pkg.sinirlar : {};
  const maxItems = resolveBoundLimit(limitsObj.kanit_sayisi_en_fazla, REPORT_EVIDENCE_LIMITS.maxEvidenceItems, 'kanit_sayisi_en_fazla');
  const maxChars = resolveBoundLimit(limitsObj.karakter_en_fazla, REPORT_EVIDENCE_LIMITS.maxPackageChars, 'karakter_en_fazla');
  const maxNoteChars = resolveBoundLimit(limitsObj.not_karakter_en_fazla, REPORT_EVIDENCE_LIMITS.maxNoteChars, 'not_karakter_en_fazla');

  const evidenceIds = new Set();
  const noteEvidenceIds = new Set();
  const noteItems = [];
  const consentEnabled = isPlainObject(pkg.istek) && ownProp(pkg.istek, 'notlar') === 'dahil';
  const matchesAllowedPeriod = (periodObj) => {
    if (!isPlainObject(periodObj)) return false;
    const start = ownProp(periodObj, 'baslangic');
    const end = ownProp(periodObj, 'bitis');
    if (!isIsoDay(start) || !isIsoDay(end) || start > end) {
      return false;
    }
    if (!reportPeriod) return false;
    const ownPeriod = { baslangic: start, bitis: end };
    return samePeriodRange(ownPeriod, reportPeriod) || samePeriodRange(ownPeriod, comparisonPeriod);
  };

  for (const item of kanitlar || []) {
    if (!isPlainObject(item) || typeof item.id !== 'string' || !/^E[1-9]\d*$/u.test(item.id)) {
      problems.push('kanit:kimlik_gecersiz');
      continue;
    }
    if (evidenceIds.has(item.id)) problems.push(`kanit:yinelenen_kimlik:${item.id}`);
    evidenceIds.add(item.id);

    if (!ALLOWED_EVIDENCE_TYPES.has(item.tur)) {
      problems.push(`kanit:tur_gecersiz:${item.id}`);
    } else if (!ALLOWED_SOURCES_BY_TYPE[item.tur].has(item.kaynak)) {
      problems.push(`kanit:kaynak_uyumsuz:${item.id}`);
    }

    if (!consentEnabled) {
      if (item.tur === 'not' || item.kaynak === 'MR_AuditLog') {
        problems.push(`riza:not_kaniti_yasak:${item.id}`);
      }
      for (const key of PROTECTED_TEXT_KEYS) {
        if (Object.hasOwn(item, key)) problems.push(`riza:korunan_metin_yasak:${item.id}.${key}`);
      }
    }

    // Ölçülerde dönem ve anlık kesit zaman kökenleri birbirine karışamaz; sayım değerleri negatif olmayan güvenli tam sayı veya açık null olmalıdır.
    if (item.tur === 'olcu') {
      const validMeasureValue = item.deger === null
        || (typeof item.deger === 'number' && Number.isSafeInteger(item.deger) && item.deger >= 0);
      if (!validMeasureValue) {
        problems.push(`olcu:deger_gecersiz:${item.id}`);
      }
      const hasDonem = Object.hasOwn(item, 'donem') && item.donem !== undefined;
      const hasVeriAni = Object.hasOwn(item, 'veri_ani') && item.veri_ani !== undefined;
      if (hasDonem && hasVeriAni) {
        problems.push(`olcu:zaman_kokeni_celiskili:${item.id}`);
      }
      if (PERIOD_MEASURE_NAMES.has(item.olcu)) {
        if (hasVeriAni || !matchesAllowedPeriod(item.donem)) {
          problems.push(`olcu:donem_gecersiz:${item.id}`);
        }
      } else if (SNAPSHOT_MEASURE_NAMES.has(item.olcu)) {
        const snapNanos = parseIsoTimestampNanos(item.veri_ani);
        if (hasDonem || snapNanos === null || (validVeriAni && snapNanos !== cutOffNanos)) {
          problems.push(`olcu:veri_ani_gecersiz:${item.id}`);
        }
      } else {
        problems.push(`olcu:bilinmeyen_olcu:${item.id}`);
      }
    }

    // Hareket kanıtı rapor/karşılaştırma dönemini taşımalı ve anlık kesit damgası almamalıdır.
    if (item.tur === 'hareket') {
      const hasVeriAni = Object.hasOwn(item, 'veri_ani') && item.veri_ani !== undefined;
      if (hasVeriAni || !matchesAllowedPeriod(item.donem)) {
        problems.push(`hareket:donem_gecersiz:${item.id}`);
      }
    }

    if (item.tur === 'not') {
      noteEvidenceIds.add(item.id);
      noteItems.push(item);
      if (item.guvenilmez_veri !== true) problems.push(`not:guvenilmez_veri_eksik:${item.id}`);
      if (typeof item.metin !== 'string' || !item.metin.trim()) {
        problems.push(`not:metin_bos:${item.id}`);
      } else if (Array.from(item.metin).length > maxNoteChars) {
        problems.push(`not:karakter_siniri_asildi:${item.id}`);
      }
      if (item.kaynak === 'MR_Tasks' && (item.kayit_zamani !== null || item.kayit_zamani_durumu !== 'bilinmiyor')) {
        problems.push(`not:mr_tasks_kayit_zamani_uydurulmus:${item.id}`);
      }
      let noteWriteNanos = null;
      if (item.kayit_zamani === null) {
        if (item.kayit_zamani_durumu !== 'bilinmiyor') {
          problems.push(`not:bilinmiyor_durumu_eksik:${item.id}`);
        }
      } else if (typeof item.kayit_zamani === 'string') {
        if (item.kayit_zamani_durumu !== 'biliniyor') {
          problems.push(`not:biliniyor_durumu_uyumsuz:${item.id}`);
        }
        const tsNanos = parseIsoTimestampNanos(item.kayit_zamani);
        if (tsNanos === null) {
          problems.push(`not:kayit_zamani_gecersiz:${item.id}`);
        } else {
          noteWriteNanos = tsNanos;
          if (validVeriAni && tsNanos > cutOffNanos) {
            problems.push(`not:kayit_zamani_kesiti_asiyor:${item.id}`);
          }
        }
      } else {
        problems.push(`not:kayit_zamani_gecersiz:${item.id}`);
      }
      if (Object.hasOwn(item, 'sonraki_degisiklik_zamani') && item.sonraki_degisiklik_zamani !== undefined && item.sonraki_degisiklik_zamani !== null) {
        const nextChangeNanos = parseIsoTimestampNanos(item.sonraki_degisiklik_zamani);
        if (nextChangeNanos === null) {
          problems.push(`not:sonraki_degisiklik_zamani_gecersiz:${item.id}`);
        } else if (validVeriAni && nextChangeNanos > cutOffNanos) {
          problems.push(`not:sonraki_degisiklik_zamani_kesiti_asiyor:${item.id}`);
        } else if (noteWriteNanos !== null && nextChangeNanos < noteWriteNanos) {
          problems.push(`not:sonraki_degisiklik_zamani_not_oncesi:${item.id}`);
        }
      }
    }
  }

  // Rıza kapalıyken paketin herhangi bir iç içe alanında (türetilmiş, çelişki, tamlık dâhil) korunan metin anahtarı bulunamaz.
  if (!consentEnabled && !tooDeep) {
    const leakedPaths = [];
    findProtectedTextKeyPaths(pkg, '', leakedPaths);
    for (const leakedPath of leakedPaths) {
      const problemTag = `riza:korunan_metin_yasak:${leakedPath}`;
      if (!problems.includes(problemTag)) problems.push(problemTag);
    }
  }

  // Not yineleme göndergeleri yalnızca pakette kalan diğer not kimliklerine işaret edebilir (seyrek dizi delikleri yasaktır).
  for (const note of noteItems) {
    if (Object.hasOwn(note, 'yinelenen_kanitlar')) {
      const refs = note.yinelenen_kanitlar;
      if (!Array.isArray(refs) || refs.length === 0 || hasSparseHole(refs)
        || refs.some((ref) => typeof ref !== 'string' || ref === note.id || !noteEvidenceIds.has(ref))) {
        problems.push(`not:gecersiz_yineleme_gondergesi:${note.id}`);
      }
    }
  }

  const findingIds = new Set();
  for (const finding of turetilmis || []) {
    if (!isPlainObject(finding) || typeof finding.id !== 'string' || !/^F[1-9]\d*$/u.test(finding.id)) {
      problems.push('turetilmis:kimlik_gecersiz');
      continue;
    }
    if (findingIds.has(finding.id)) problems.push(`turetilmis:yinelenen_kimlik:${finding.id}`);
    findingIds.add(finding.id);
    if (!Array.isArray(finding.girdiler) || finding.girdiler.length === 0 || hasSparseHole(finding.girdiler)
      || finding.girdiler.some((ref) => typeof ref !== 'string' || !evidenceIds.has(ref))) {
      problems.push(`turetilmis:gecersiz_kanit_gondergesi:${finding.id}`);
    }
  }

  for (const conflict of celiskiler || []) {
    if (!isPlainObject(conflict) || !Array.isArray(conflict.kanitlar) || conflict.kanitlar.length < 2
      || hasSparseHole(conflict.kanitlar)
      || conflict.kanitlar.some((ref) => typeof ref !== 'string' || !evidenceIds.has(ref))
      || new Set(conflict.kanitlar).size < 2) {
      problems.push('celiski:gecersiz_kanit_gondergesi');
    }
  }

  if ((kanitlar || []).length > maxItems) problems.push('sinir:kanit_sayisi_asildi');
  let serializedChars = 0;
  let serializable = !tooDeep;
  if (!tooDeep) {
    try {
      const serialized = JSON.stringify(pkg);
      if (typeof serialized !== 'string') {
        serializable = false;
      } else {
        serializedChars = serialized.length;
      }
    } catch {
      serializable = false;
    }
  }
  if (!tooDeep && !serializable) {
    problems.push('paket:serilestirilemiyor');
  } else if (!tooDeep) {
    if (serializedChars > maxChars) problems.push('sinir:karakter_sayisi_asildi');
    if (isPlainObject(pkg.tamlik) && Object.hasOwn(pkg.tamlik, 'karakter_sayisi') && pkg.tamlik.karakter_sayisi !== undefined) {
      if (!Number.isSafeInteger(pkg.tamlik.karakter_sayisi) || pkg.tamlik.karakter_sayisi !== serializedChars) {
        problems.push('tamlik:karakter_sayisi_uyumsuz');
      }
    }
  }

  return { ok: problems.length === 0, problems, serializedChars };
}
