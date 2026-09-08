import { ServerPersistenceError } from '../errors.js';

const TIME_ZONE = 'Europe/Istanbul';
const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const parts = (formatter, date) => Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== 'literal').map(({ type, value }) => [type, value]));
const shift = (day, offset) => new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
function validDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1900-01-01'
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function midnightUtc(day) {
  const wallTime = Date.parse(`${day}T00:00:00Z`);
  let instant = wallTime;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const p = parts(clock, new Date(instant));
    const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    instant = wallTime - (local - instant);
  }
  return new Date(instant);
}
export function activityDateRange(input = {}, now = new Date()) {
  const p = parts(calendar, now);
  const today = `${p.year}-${p.month}-${p.day}`;
  const preset = input.period || 'today';
  let from = today, to = today;
  if (preset === 'yesterday') from = to = shift(today, -1);
  else if (preset === 'week') from = shift(today, -6);
  else if (preset === 'custom') { from = input.from; to = input.to || from; }
  else if (preset !== 'today') throw new ServerPersistenceError('MUTATION_FAILED', 'Hareket dönemi geçersiz.');
  if (!validDay(from) || !validDay(to) || from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 365) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'En fazla 366 günlük geçerli bir tarih aralığı seçin.');
  }
  return { from, to, startUtc: midnightUtc(from), endUtc: midnightUtc(shift(to, 1)), timeZone: TIME_ZONE };
}
