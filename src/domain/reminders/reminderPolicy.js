/**
 * Otomatik görev hatırlatma ilkesi.
 *
 * Modül SAFTIR: zaman, veritabanı ve ağ bağımlılığı yoktur; referans an dışarıdan
 * verilir. Böylece "pencereye girdi mi", "sıklık doldu mu" ve "bu aralık için
 * zaten gönderildi mi" soruları duvar saatinden bağımsız olarak sınanabilir.
 *
 * Kavramlar:
 *  - **Pencere**: termine ne kadar kala hatırlatmanın BAŞLAYACAĞI süre
 *    (örn. 7 gün). `kalan süre = termin - şimdi`.
 *  - **Sıklık**: pencere içindeyken hatırlatmanın ne sıklıkla YİNELENECEĞİ
 *    (örn. 2 günde bir).
 *  - **Aralık anahtarı (slot)**: pencere içindeki kaçıncı yinelemede
 *    olduğumuzu belirleyen DETERMİNİST anahtar. Zamanlayıcı saatte bir çalışsa
 *    bile aynı aralık için aynı anahtar üretilir; kalıcı gönderim geçmişi bu
 *    anahtarı benzersiz kabul ettiği için kopya ileti oluşamaz.
 *
 * Anahtar; termin, pencere ve sıklık değerlerini de taşır. Yönetici ayarları
 * değiştirdiğinde yeni bir aralık dizisi başlar; eski gönderimler yeni
 * yapılandırmayı susturmaz.
 */

export const REMINDER_UNITS = Object.freeze(['day', 'hour']);
export const REMINDER_UNIT_LABELS = Object.freeze({ day: 'gün', hour: 'saat' });

const MINUTES_PER_UNIT = Object.freeze({ day: 1440, hour: 60 });
const MAX_WINDOW_MINUTES = 365 * 1440;

/** Tamamlanmış/iptal edilmiş sayılan durumlar; hatırlatma DURUR. */
export const CLOSED_TASK_STATUSES = Object.freeze(['done', 'completed', 'cancelled', 'canceled', 'iptal']);

export const DEFAULT_REMINDER_SETTINGS = Object.freeze({
  // Kurulumdan hemen sonra kimseye habersiz posta gitmemesi için otomatik
  // gönderim KAPALI gelir; şablon ve zamanlama varsayılanları hazırdır.
  automaticEnabled: false,
  windowValue: 7,
  windowUnit: 'day',
  frequencyValue: 2,
  frequencyUnit: 'day'
});

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function unit(value, fallback) {
  const text = String(value ?? '').trim().toLowerCase();
  return REMINDER_UNITS.includes(text) ? text : fallback;
}

/** Ayarları kanonik biçime indirger; geçersiz alanlar varsayılana düşer. */
export function normalizeReminderSettings(input = {}) {
  const windowUnit = unit(input.windowUnit, DEFAULT_REMINDER_SETTINGS.windowUnit);
  const frequencyUnit = unit(input.frequencyUnit, DEFAULT_REMINDER_SETTINGS.frequencyUnit);
  const windowValue = positiveInteger(input.windowValue, DEFAULT_REMINDER_SETTINGS.windowValue);
  const frequencyValue = positiveInteger(input.frequencyValue, DEFAULT_REMINDER_SETTINGS.frequencyValue);
  const windowMinutes = Math.min(windowValue * MINUTES_PER_UNIT[windowUnit], MAX_WINDOW_MINUTES);
  return {
    automaticEnabled: Boolean(input.automaticEnabled),
    windowValue,
    windowUnit,
    frequencyValue,
    frequencyUnit,
    windowMinutes,
    frequencyMinutes: Math.max(1, Math.min(frequencyValue * MINUTES_PER_UNIT[frequencyUnit], windowMinutes || MAX_WINDOW_MINUTES))
  };
}

/** Yöneticiye gösterilen okunur özet. */
export function describeReminderSchedule(settings) {
  const normalized = normalizeReminderSettings(settings);
  if (!normalized.automaticEnabled) {
    return 'Otomatik hatırlatma kapalı. Görev panelindeki gönderme düğmesi çalışmaya devam eder.';
  }
  const windowLabel = `${normalized.windowValue} ${REMINDER_UNIT_LABELS[normalized.windowUnit]}`;
  const frequencyLabel = `${normalized.frequencyValue} ${REMINDER_UNIT_LABELS[normalized.frequencyUnit]}`;
  return `Otomatik hatırlatmalar termine ${windowLabel} kala başlar ve ${frequencyLabel}de bir yinelenir. `
    + 'Görev tamamlandığında, iptal edildiğinde ya da termin gününe ulaşıldığında durur.';
}

/** Görev kapalı mı (tamamlandı/iptal)? */
export function isClosedTaskStatus(status) {
  return CLOSED_TASK_STATUSES.includes(String(status ?? '').trim().toLowerCase());
}

function parseDueDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (match) {
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Kalan süreyi insan okunur biçimde anlatır. */
export function describeRemainingDuration(remainingMinutes) {
  if (remainingMinutes == null) return 'termin tarihi belirtilmemiş';
  if (remainingMinutes < 0) {
    const lateDays = Math.ceil(Math.abs(remainingMinutes) / MINUTES_PER_UNIT.day);
    return `${lateDays} gün geçti`;
  }
  const days = Math.floor(remainingMinutes / MINUTES_PER_UNIT.day);
  if (days >= 1) return `${days} gün kaldı`;
  const hours = Math.floor(remainingMinutes / MINUTES_PER_UNIT.hour);
  if (hours >= 1) return `${hours} saat kaldı`;
  return 'bugün son gün';
}

/**
 * Bir görevin OTOMATİK hatırlatma uygunluğunu değerlendirir.
 *
 * @param {object} task görev kaydı (`targetFinish`, `status`)
 * @param {object} settings yönetici ayarları
 * @param {Date} now referans an
 * @returns {{eligible: boolean, reason: string, slotKey: string|null,
 *   remainingMinutes: number|null, remainingDays: number|null,
 *   dueDate: string|null, slotIndex: number|null}}
 */
export function evaluateReminderEligibility(task, settings, now = new Date()) {
  const normalized = normalizeReminderSettings(settings);
  const base = {
    eligible: false,
    reason: 'NOT_ELIGIBLE',
    slotKey: null,
    slotIndex: null,
    remainingMinutes: null,
    remainingDays: null,
    dueDate: null
  };

  if (!normalized.automaticEnabled) return { ...base, reason: 'AUTOMATIC_DISABLED' };
  if (!task) return { ...base, reason: 'TASK_NOT_FOUND' };
  if (isClosedTaskStatus(task.status)) return { ...base, reason: 'TASK_CLOSED' };

  const due = parseDueDate(task.targetFinish);
  if (!due) return { ...base, reason: 'NO_DUE_DATE' };

  const dueDate = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
  const remainingMinutes = Math.floor((due.getTime() - now.getTime()) / 60000);
  const remainingDays = Math.ceil(remainingMinutes / MINUTES_PER_UNIT.day);
  const withTiming = { ...base, remainingMinutes, remainingDays, dueDate };

  // Termin gününe ulaşıldıktan SONRA otomatik hatırlatma durur. Gecikme
  // hatırlatması ayrı bir ilkedir ve bu sürümde bilinçli olarak yoktur:
  // sınırsız gecikme postası göndermek, kullanıcıyı hatırlatmalara tümüyle
  // sağırlaştırırdı.
  if (remainingMinutes < 0) return { ...withTiming, reason: 'PAST_DUE' };
  if (remainingMinutes > normalized.windowMinutes) return { ...withTiming, reason: 'OUTSIDE_WINDOW' };

  const elapsedInWindow = normalized.windowMinutes - remainingMinutes;
  const slotIndex = Math.floor(elapsedInWindow / normalized.frequencyMinutes);
  return {
    ...withTiming,
    eligible: true,
    reason: 'DUE',
    slotIndex,
    // Anahtar termini, pencereyi ve sıklığı taşır: bunlardan biri değiştiğinde
    // yeni bir aralık dizisi başlar ve geçmiş gönderimler yeni planı susturmaz.
    slotKey: `${dueDate}|w${normalized.windowMinutes}|f${normalized.frequencyMinutes}|s${slotIndex}`
  };
}

/**
 * Bir görev kümesinden otomatik gönderime UYGUN olanları seçer.
 *
 * Her görev bağımsız değerlendirilir: biri elenirse ötekiler etkilenmez.
 */
export function selectDueReminders(tasks = [], settings, now = new Date()) {
  const due = [];
  for (const task of tasks) {
    const evaluation = evaluateReminderEligibility(task, settings, now);
    if (evaluation.eligible) due.push({ task, ...evaluation });
  }
  return due;
}
