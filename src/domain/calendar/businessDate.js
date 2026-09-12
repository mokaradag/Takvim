import { DEFAULT_CALENDAR } from '../../scheduling/calendars/index.js';

export function businessDate(now = new Date(), timeZone = DEFAULT_CALENDAR.timezone) {
  for (const zone of [timeZone, DEFAULT_CALENDAR.timezone]) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(now);
      const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
      return `${values.year}-${values.month}-${values.day}`;
    } catch {
      // Geçersiz özel dilimde Rota takvimi kullanılır.
    }
  }
  throw new RangeError('Geçerli bir takvim günü hesaplanamadı.');
}
