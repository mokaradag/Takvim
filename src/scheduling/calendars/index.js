import { isWeekend, parseDate } from '../dates/index.js';

export const HOLIDAYS = [
  { date: '01-01', name: 'Yılbaşı', short: 'Yılbaşı' },
  { date: '04-23', name: 'Ulusal Egemenlik ve Çocuk Bayramı', short: '23 Nisan' },
  { date: '05-01', name: 'Emek ve Dayanışma Günü', short: '1 Mayıs' },
  { date: '05-19', name: 'Atatürk’ü Anma, Gençlik ve Spor Bayramı', short: '19 Mayıs' },
  { date: '07-15', name: 'Demokrasi ve Milli Birlik Günü', short: '15 Temmuz' },
  { date: '08-30', name: 'Zafer Bayramı', short: '30 Ağustos' },
  { date: '10-29', name: 'Cumhuriyet Bayramı', short: '29 Ekim' },
  { date: '03-20', name: 'Ramazan Bayramı (1. Gün)', short: 'Ramazan B.' },
  { date: '03-21', name: 'Ramazan Bayramı (2. Gün)', short: 'Ramazan B.' },
  { date: '03-22', name: 'Ramazan Bayramı (3. Gün)', short: 'Ramazan B.' },
  { date: '05-27', name: 'Kurban Bayramı (1. Gün)', short: 'Kurban B.' },
  { date: '05-28', name: 'Kurban Bayramı (2. Gün)', short: 'Kurban B.' },
  { date: '05-29', name: 'Kurban Bayramı (3. Gün)', short: 'Kurban B.' },
  { date: '05-30', name: 'Kurban Bayramı (4. Gün)', short: 'Kurban B.' }
];

export function holidayFor(value) {
  const date = parseDate(value);
  const key = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return HOLIDAYS.find((holiday) => holiday.date === key) || null;
}

export function isWorkingDay(value) {
  return !isWeekend(value) && !holidayFor(value);
}
