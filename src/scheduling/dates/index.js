const MS_DAY = 86400000;
let appDateDisplayFormat = 'pattern';

export const TR_MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
export const TR_MONTHS_LONG = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
export const TR_DAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];

export function setAppDateDisplayFormat(format = 'pattern') {
  appDateDisplayFormat = format === 'dd/mm/yyyy' ? 'dd/mm/yyyy' : 'pattern';
}

export function parseDate(value) {
  if (value instanceof Date) return value;
  if (!value) return new Date();
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function fmtISO(value) {
  const date = value instanceof Date ? value : parseDate(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function fmtDisplayDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : parseDate(value);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()}`;
}

export function fmt(value, pattern = 'dd MMM') {
  const date = parseDate(value);
  const day = String(date.getDate()).padStart(2, '0');
  const dayShort = date.getDate();
  if (pattern === 'd') return String(dayShort);
  if (pattern === 'EEE d') return `${TR_DAYS[(date.getDay() + 6) % 7]} ${dayShort}`;
  if (pattern === 'MMM yyyy') return `${TR_MONTHS_LONG[date.getMonth()]} ${date.getFullYear()}`;
  if (pattern === 'dd/mm/yyyy') return fmtDisplayDate(date);
  if (appDateDisplayFormat === 'dd/mm/yyyy' && (pattern === 'dd MMM' || pattern === 'dd MMM yyyy')) return fmtDisplayDate(date);
  if (pattern === 'dd MMM') return `${day} ${TR_MONTHS[date.getMonth()]}`;
  if (pattern === 'dd MMM yyyy') return `${day} ${TR_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  return appDateDisplayFormat === 'dd/mm/yyyy' ? fmtDisplayDate(date) : date.toLocaleDateString('tr-TR');
}

export function addDays(value, amount) {
  const date = parseDate(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

export function diffDays(a, b) {
  return Math.round((parseDate(a).getTime() - parseDate(b).getTime()) / MS_DAY);
}

export function startOfMonth(value) {
  const date = parseDate(value);
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function endOfMonth(value) {
  const date = parseDate(value);
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

export function startOfWeek(value) {
  const date = parseDate(value);
  return addDays(date, -((date.getDay() + 6) % 7));
}

export function endOfWeek(value) {
  return addDays(startOfWeek(value), 6);
}

export function isSameDay(a, b) {
  const left = parseDate(a);
  const right = parseDate(b);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

export function isWeekend(value) {
  const day = parseDate(value).getDay();
  return day === 0 || day === 6;
}

export function today() {
  const value = new Date();
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function eachDay(start, end) {
  const days = [];
  let current = parseDate(start);
  const last = parseDate(end);
  while (current <= last) {
    days.push(new Date(current));
    current = addDays(current, 1);
  }
  return days;
}
