/**
 * Sütun tarih süzgeci eşleşmesi.
 *
 * `ui-extras.jsx` içinden AYRI bir modüle alınmıştır: işlev tamamen saftır ve
 * hiç JSX içermez, ama JSX taşıyan bir dosyada durduğu için düz Node ile
 * içe aktarılamıyordu. Davranış bu yüzden yalnızca KAYNAK METNİ üzerinden
 * sınanabiliyordu; öyle bir sınama kuralın kendisini değil, yazılışını
 * sabitler ve ilk yeniden düzenlemede yanlış yerde kırılır.
 */
import { addDays, diffDays, endOfWeek, parseDate, startOfWeek, today } from '../scheduling/dates/index.js';

export function dateMatchesFilter(iso, spec) {
  if (!spec) return true;
  const t = today();
  // EKSİK ya da çözülemeyen tarih hiçbir aralıkla eşleşmez.
  //
  // Ölçüt `parseDate`in SESSİZ YEDEĞİdir: `parseDate(value)` yalancı (falsy)
  // her değerde `new Date()` — yani BUGÜNÜ — döndürür. Elenmezlerse tarihsiz
  // bir Gantt satırı `before`/`after`/`range` süzgeçlerinden geçer ve dahası
  // "bugün" ön ayarıyla eşleşir. `TasksView` bu değerleri çağrı öncesinde
  // zaten eliyor, `GanttView` ise doğrudan veriyordu.
  //
  // `0` da bu kümededir: `!0` doğru olduğu için sayısal dal hiç çalışmaz ve
  // `parseDate(0)` dönem başlangıcını DEĞİL bugünü verir. "Sayısal dönem
  // damgasını koru" biçiminde bir düzeltme bu yüzden yanlıştır; `0` süzgece
  // sokulursa bozuk bir kayıt güncel tarihle eşleşir.
  //
  // Mantıksal değerler ayrıca elenir: `true` yalancı değildir ve
  // `parseDate(true)` 1 Ocak 1970'i verir. Sonlu olmayan sayılar da öyle.
  if (!iso
    || typeof iso === 'boolean'
    || (typeof iso === 'number' && !Number.isFinite(iso))
    || (typeof iso === 'string' && !iso.trim())
  ) return false;
  const d = parseDate(iso);
  if (Number.isNaN(d?.getTime?.())) return false;
  if (spec.mode === 'range') {
    if (spec.from && d < parseDate(spec.from)) return false;
    if (spec.to && d > parseDate(spec.to)) return false;
    return true;
  }
  if (spec.mode === 'before') {
    if (spec.to && d > parseDate(spec.to)) return false;
    return true;
  }
  if (spec.mode === 'after') {
    if (spec.from && d < parseDate(spec.from)) return false;
    return true;
  }
  if (spec.mode === 'preset') {
    const days = diffDays(d, t);
    switch (spec.preset) {
      case 'overdue': return days < 0;
      case 'today': return days === 0;
      case 'tomorrow': return days === 1;
      case 'thisWeek': {
        const ws = startOfWeek(t);
        const we = endOfWeek(t);
        return d >= ws && d <= we;
      }
      case 'nextWeek': {
        const ws = addDays(startOfWeek(t), 7);
        const we = addDays(endOfWeek(t), 7);
        return d >= ws && d <= we;
      }
      case 'thisMonth': {
        return d.getMonth() === t.getMonth() && d.getFullYear() === t.getFullYear();
      }
      case 'nextMonth': {
        const next = new Date(t.getFullYear(), t.getMonth() + 1, 1);
        return d.getMonth() === next.getMonth() && d.getFullYear() === next.getFullYear();
      }
      case 'last7': return days >= -7 && days <= 0;
      case 'last30': return days >= -30 && days <= 0;
      case 'next30': return days >= 0 && days <= 30;
      default: return true;
    }
  }
  return true;
}

