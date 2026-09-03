import { PRIORITIES, normalizePriorityId } from '../constants/index.js';
import { describeRemainingDuration } from './reminderPolicy.js';

/**
 * Görev kaydından ŞABLON DEĞERLERİNİ üretir.
 *
 * Zaman bağımlı alanlar (kalan gün/süre) gönderim anında YETKİLİ görev
 * verisinden hesaplanır; hiçbir yerde saklanmaz. Aksi hâlde bir kez üretilen
 * "3 gün kaldı" metni sonraki gönderimlerde de aynen tekrarlanırdı.
 *
 * Eksik alanlar UYDURULMAZ: değeri olmayan yer tutucu, şablon katmanında nötr
 * işaretle (—) gösterilir.
 */

const STATUS_LABELS = Object.freeze({
  todo: 'Yapılacak',
  planned: 'Yapılacak',
  'not-started': 'Yapılacak',
  in_progress: 'Devam ediyor',
  'in-progress': 'Devam ediyor',
  blocked: 'Beklemede',
  done: 'Tamamlandı',
  completed: 'Tamamlandı',
  cancelled: 'İptal edildi'
});

const MINUTES_PER_DAY = 1440;

/**
 * Hatırlatmaların yorumlandığı SAAT DİLİMİ.
 *
 * Termin tarihi bir TAKVİM GÜNÜDÜR; onu sunucu sürecinin yerel saatinde gece
 * yarısı saymak, kalan gün sayısını sunucunun nerede çalıştığına bağlı hâle
 * getiriyordu: 2 Eylül'e terminli bir görev için, Istanbul saatiyle 00:30'da
 * UTC'de çalışan bir sunucu "1 gün kaldı", Istanbul'da çalışan bir sunucu
 * "0 gün" diyordu. Dilim açıkça verilir ve `context.timeZone` ile geçersiz
 * kılınabilir; varsayılan, kurulumun çalışma takvimiyle aynı dilimdir.
 */
export const DEFAULT_REMINDER_TIME_ZONE = 'Europe/Istanbul';

/** Verilen değer geçerli bir IANA saat dilimi adı mı? */
function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Bir anın verilen saat dilimindeki ofseti (ms). */
function zoneOffsetMs(instant, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(instant).map((part) => [part.type, part.value])
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - instant.getTime();
}

/** Verilen takvim gününün, o saat dilimindeki gece yarısına karşılık gelen an. */
function zonedMidnight(year, month, day, timeZone) {
  const naive = Date.UTC(year, month - 1, day);
  // İki geçiş: yaz saati sınırında ilk tahminin ofseti yanlış olabilir.
  let instant = naive - zoneOffsetMs(new Date(naive), timeZone);
  instant = naive - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** Bir anın verilen saat dilimindeki takvim günü bileşenleri. */
function zonedCalendarParts(instant, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(instant).map((part) => [part.type, part.value])
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

export function reminderStatusLabel(status) {
  const key = String(status ?? '').trim().toLowerCase();
  return STATUS_LABELS[key] || (key ? key : '');
}

/**
 * Takvimde GERÇEKTEN var olan bir güne çözülen ISO tarihi ayrıştırır.
 *
 * Biçim denetimi tek başına yetmiyordu: `2026-02-30` her iki desenden de
 * geçiyor, `formatDate` bunu `30.02.2026` diye yazarken `new Date(2026, 1, 30)`
 * 2 Mart'a taşıyordu. Hatırlatma böylece BİR tarihi gösterip BAŞKA bir tarihe
 * göre kalan gün hesaplıyordu. Çözülen bileşenler geri karşılaştırılarak
 * imkânsız günler elenir.
 */
function parseCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { date, year, month, day };
}

function formatDate(value) {
  const parsed = parseCalendarDate(value);
  if (!parsed) return '';
  const { year, month, day } = parsed;
  return `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`;
}

function dueDateAtMidnight(value, timeZone) {
  const parsed = parseCalendarDate(value);
  if (!parsed) return null;
  // Gece yarısı, HATIRLATMA saat diliminde çözülür; sunucunun yerel dilimi
  // sonucu etkilemez.
  return zonedMidnight(parsed.year, parsed.month, parsed.day, timeZone);
}

/**
 * @param {object} task hatırlatma görevi
 * @param {{assigneeNames?: string[], appName?: string, now?: Date,
 *   timeZone?: string}} [context] `timeZone` verilmezse
 *   `DEFAULT_REMINDER_TIME_ZONE` kullanılır.
 * @returns {Record<string, string>} yer tutucu değerleri
 */
export function buildReminderValues(task, {
  assigneeNames = [],
  appName = 'MERGEN Rota',
  now = new Date(),
  timeZone: requestedTimeZone = DEFAULT_REMINDER_TIME_ZONE
} = {}) {
  // Saat dilimi KULLANILMADAN ÖNCE doğrulanır. ECMA-402 uyarınca
  // `Intl.DateTimeFormat` geçersiz bir IANA adı için `RangeError` yükseltir;
  // geçersiz bir değer hem `dueDateAtMidnight` hem de HER ÇAĞRIDA çalışan
  // `today` hesabını düşürüyordu — `targetFinish` boş olsa bile.
  const timeZone = isValidTimeZone(requestedTimeZone) ? requestedTimeZone : DEFAULT_REMINDER_TIME_ZONE;
  const due = dueDateAtMidnight(task?.targetFinish, timeZone);
  const remainingMinutes = due ? Math.floor((due.getTime() - now.getTime()) / 60000) : null;
  const remainingDays = remainingMinutes == null ? null : Math.ceil(remainingMinutes / MINUTES_PER_DAY);
  const priority = PRIORITIES[normalizePriorityId(task?.priority)];

  return {
    task_name: task?.task || task?.title || '',
    project_name: task?.projectName || task?.proje || '',
    project_code: task?.projectCode || '',
    description: task?.description || '',
    keyword: task?.keyword || '',
    assignees: assigneeNames.filter(Boolean).join(', '),
    due_date: formatDate(task?.targetFinish),
    remaining_days: remainingDays == null ? '' : String(remainingDays),
    // Gün farkı BİRLİKTE verilir: termin günü içindeki gönderim "geçti" diye
    // anlatılmaz, `remaining_days` ile `remaining_duration` aynı günü söyler.
    remaining_duration: remainingMinutes == null ? '' : describeRemainingDuration(remainingMinutes, { remainingDays }),
    priority: priority?.label || '',
    status: reminderStatusLabel(task?.status),
    app_name: appName,
    // Bugün de AYNI dilimde okunur; aksi hâlde ileti gövdesindeki tarih ile
    // kalan gün sayısı farklı günlere dayanabilirdi.
    today: (() => {
      const parts = zonedCalendarParts(now, timeZone);
      return formatDate(
        `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
      );
    })()
  };
}
