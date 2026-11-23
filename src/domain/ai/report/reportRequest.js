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
  maxIdentifierLength: 160
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
// eslint-disable-next-line no-control-regex
const FORBIDDEN_GENERAL_CONTROL = /[\u0000-\u001F\u007F]/u;
// eslint-disable-next-line no-control-regex
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

/** Verilen anı Europe/Istanbul saat diliminde saat farkıyla ISO-8601 metnine çevirir. */
export function formatIstanbulTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_REQUEST,
      'Geçerli bir veri anı zaman damgası gereklidir.',
      ['$.now:invalid']
    );
  }
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
  const offsetMinutes = Math.round((localUtcMs - wholeSecUtcMs) / 60000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(offsetMinutes);
  const offH = String(Math.floor(absMinutes / 60)).padStart(2, '0');
  const offM = String(absMinutes % 60).padStart(2, '0');
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}${sign}${offH}:${offM}`;
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
  const { baslangic, bitis } = raw;
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
function resolveReportPeriod(raporTuru, rawDonem, today) {
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

  const position = windowPosition(range, today);
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
  const { tur, kimlikler } = rawKapsam;
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
    if (!trimmed || trimmed.length > REPORT_REQUEST_LIMITS.maxIdentifierLength || forbiddenControl.test(trimmed)) {
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
    if (!prev || !comparableWindows(prev, reportRange)) {
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
export function validateExecutiveReportRequest(input, { now = new Date(), today = null } = {}) {
  if (!isPlainObject(input)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_REQUEST,
      'Rapor isteği geçerli bir nesne olmalıdır.',
      ['$:object_required']
    );
  }
  rejectUnknownFields(input, ALLOWED_REQUEST_FIELDS, '$');

  const resolvedToday = today ?? businessDate(now);
  if (!isIsoDay(resolvedToday)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_REQUEST,
      'Geçerli bir Türkiye iş günü çözümlenemedi.',
      ['$.today:invalid']
    );
  }

  const { rapor_turu: raporTuru } = input;
  if (typeof raporTuru !== 'string' || !REPORT_PERIOD_TYPES.includes(raporTuru)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_REQUEST,
      'Rapor türü haftalik, aylik veya ozel olmalıdır.',
      ['$.rapor_turu:invalid']
    );
  }

  const ayrinti = input.ayrinti === undefined ? 'standart' : input.ayrinti;
  if (typeof ayrinti !== 'string' || !REPORT_DETAIL_LEVELS.includes(ayrinti)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_REQUEST,
      'Ayrıntı düzeyi kisa, standart veya kapsamli olmalıdır.',
      ['$.ayrinti:invalid']
    );
  }

  const odak = input.odak === undefined ? 'dengeli' : input.odak;
  if (typeof odak !== 'string' || !REPORT_FOCUS_OPTIONS.includes(odak)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_REQUEST,
      'Yönetim odağı desteklenmeyen bir değer taşıyor.',
      ['$.odak:invalid']
    );
  }

  // Açık not rızası yoksa varsayılan her zaman hariçtir; beklenmeyen türler kapalı reddedilir.
  const notlar = input.notlar === undefined ? 'haric' : input.notlar;
  if (typeof notlar !== 'string' || !REPORT_NOTE_CONSENT.includes(notlar)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_CONSENT,
      'Görev notları tercihi açıkça "dahil" veya "haric" olmalıdır.',
      ['$.notlar:invalid']
    );
  }

  const karsilastirma = input.karsilastirma === undefined ? 'yok' : input.karsilastirma;
  if (typeof karsilastirma !== 'string' || !REPORT_COMPARISON_MODES.includes(karsilastirma)) {
    throw new ReportRequestError(
      REPORT_REQUEST_ERROR_CODES.INVALID_COMPARISON,
      'Karşılaştırma kipi onceki_donem, ozel_donem veya yok olmalıdır.',
      ['$.karsilastirma:invalid']
    );
  }

  const kapsam = validateScope(input.kapsam);
  const reportRange = resolveReportPeriod(raporTuru, input.donem, resolvedToday);
  const comparisonRange = resolveComparison(karsilastirma, input.karsilastirma_donemi, reportRange, resolvedToday);

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

const PROTECTED_TEXT_KEYS = Object.freeze(['degisiklik_metni', 'once_metin', 'sonra_metin', 'not_metni']);
const ALLOWED_EVIDENCE_TYPES = new Set(['olcu', 'gorev', 'not', 'hareket', 'belge']);
const ALLOWED_SOURCES_BY_TYPE = Object.freeze({
  olcu: new Set(['rota_task_analytics', 'rota_activity_search']),
  gorev: new Set(['rota_task_search']),
  not: new Set(['MR_AuditLog', 'MR_Tasks']),
  hareket: new Set(['rota_activity_search']),
  belge: new Set(['gecici_yukleme'])
});

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
  if (pkg.sema !== REPORT_EVIDENCE_SCHEMA) problems.push('sema:gecersiz');
  if (!isPlainObject(pkg.istek)) problems.push('istek:eksik');
  if (typeof pkg.veri_ani !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(pkg.veri_ani)) {
    problems.push('veri_ani:gecersiz');
  }
  if (!Array.isArray(pkg.kanitlar)) problems.push('kanitlar:dizi_degil');
  if (!Array.isArray(pkg.turetilmis)) problems.push('turetilmis:dizi_degil');
  if (!isPlainObject(pkg.tamlik)) problems.push('tamlik:eksik');
  if (!Array.isArray(pkg.celiskiler)) problems.push('celiskiler:dizi_degil');
  if (!isPlainObject(pkg.sinirlar)) problems.push('sinirlar:eksik');

  const maxItems = pkg.sinirlar?.kanit_sayisi_en_fazla ?? REPORT_EVIDENCE_LIMITS.maxEvidenceItems;
  const maxChars = pkg.sinirlar?.karakter_en_fazla ?? REPORT_EVIDENCE_LIMITS.maxPackageChars;
  const maxNoteChars = pkg.sinirlar?.not_karakter_en_fazla ?? REPORT_EVIDENCE_LIMITS.maxNoteChars;

  const evidenceIds = new Set();
  const consentEnabled = pkg.istek?.notlar === 'dahil';
  const cutOffMs = typeof pkg.veri_ani === 'string' ? Date.parse(pkg.veri_ani) : Number.NaN;

  for (const item of pkg.kanitlar || []) {
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

    if (item.tur === 'not') {
      if (item.guvenilmez_veri !== true) problems.push(`not:guvenilmez_veri_eksik:${item.id}`);
      if (typeof item.metin !== 'string' || !item.metin.trim()) {
        problems.push(`not:metin_bos:${item.id}`);
      } else if (Array.from(item.metin).length > maxNoteChars) {
        problems.push(`not:karakter_siniri_asildi:${item.id}`);
      }
      if (item.kaynak === 'MR_Tasks' && (item.kayit_zamani !== null || item.kayit_zamani_durumu !== 'bilinmiyor')) {
        problems.push(`not:mr_tasks_kayit_zamani_uydurulmus:${item.id}`);
      }
      if (item.kayit_zamani === null && item.kayit_zamani_durumu !== 'bilinmiyor') {
        problems.push(`not:bilinmiyor_durumu_eksik:${item.id}`);
      }
      if (typeof item.kayit_zamani === 'string') {
        const ts = Date.parse(item.kayit_zamani);
        if (!Number.isFinite(ts) || (Number.isFinite(cutOffMs) && ts > cutOffMs)) {
          problems.push(`not:kayit_zamani_kesiti_asiyor:${item.id}`);
        }
      }
    }
  }

  const findingIds = new Set();
  for (const finding of pkg.turetilmis || []) {
    if (!isPlainObject(finding) || typeof finding.id !== 'string' || !/^F[1-9]\d*$/u.test(finding.id)) {
      problems.push('turetilmis:kimlik_gecersiz');
      continue;
    }
    if (findingIds.has(finding.id)) problems.push(`turetilmis:yinelenen_kimlik:${finding.id}`);
    findingIds.add(finding.id);
    if (!Array.isArray(finding.girdiler) || finding.girdiler.some((ref) => !evidenceIds.has(ref))) {
      problems.push(`turetilmis:gecersiz_kanit_gondergesi:${finding.id}`);
    }
  }

  for (const conflict of pkg.celiskiler || []) {
    if (!isPlainObject(conflict) || !Array.isArray(conflict.kanitlar) || conflict.kanitlar.length < 2
      || conflict.kanitlar.some((ref) => !evidenceIds.has(ref))) {
      problems.push('celiski:gecersiz_kanit_gondergesi');
    }
  }

  if ((pkg.kanitlar || []).length > maxItems) problems.push('sinir:kanit_sayisi_asildi');
  const serializedChars = JSON.stringify(pkg).length;
  if (serializedChars > maxChars) problems.push('sinir:karakter_sayisi_asildi');

  return { ok: problems.length === 0, problems, serializedChars };
}
