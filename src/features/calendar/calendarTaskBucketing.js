import { taskCalendarDate } from '../../domain/calendar/taskCalendarDate.js';
import { fmtISO, isValidDate, parseDate } from '../../scheduling/dates/index.js';

// Tarih kuralı ALAN MODELİNDEDİR: Outlook takvim daveti de aynı işlevi çağırır
// (bkz. domain/calendar/taskCalendarDate.js). Burada yalnızca yeniden yayımlanır
// ki mevcut Takvim çağrıları olduğu gibi çalışsın.
export { taskCalendarDate };

/**
 * Görevleri takvim GÜNÜNE göre kovalar.
 *
 * Kova anahtarı `YYYY-MM-DD` biçimine indirgenir. `normalizeTaskScheduleFields`
 * saat taşıyan `targetFinish`/`plannedFinish` değerlerini olduğu gibi korur;
 * ham değer anahtar yapıldığında `CalendarView` aramasını `fmtISO(d)` ile
 * yaptığı için `2026-04-02T00:00:00` taşıyan bir görev ne ızgarada ne de gün
 * penceresinde görünüyordu.
 */
export function bucketCalendarTasks(tasks = []) {
  const buckets = {};
  for (const task of tasks || []) {
    const value = taskCalendarDate(task);
    if (!value) continue;
    const parsed = parseDate(value);
    const key = isValidDate(parsed) ? fmtISO(parsed) : null;
    if (!key) continue;
    // TAŞAN takvim tarihleri elenir. `parseDate('2026-02-30')` 2 Mart 2026
    // üretir ve `isValidDate` bunu geçerli sayar; görev sessizce `2026-03-02`
    // kovasına düşüyordu. Biçimlenmiş sonucun verilen gün bölümüyle birebir
    // eşleşmesi istenerek gerçek tarih ile normalleştirilmiş tarih ayrılır.
    const supplied = typeof value === 'string' ? value.slice(0, 10) : null;
    if (supplied && /^\d{4}-\d{2}-\d{2}$/.test(supplied) && supplied !== key) continue;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(task);
  }
  return buckets;
}
