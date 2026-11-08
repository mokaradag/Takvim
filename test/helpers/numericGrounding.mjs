import { formatCount, formatFactDay } from '../../src/domain/ai/groundedPropositions.js';

/** Numaralı liste işaretleri ve atıf kimlikleri sayı iddiası değildir; diğer bütün sayısal parçalar denetlenir. */
export function unsupportedNumbers(text, values, locale = 'tr') {
  const tokens = (value) => String(value).replace(/(\d{4})-(\d{2})-(\d{2})/g, '$1 $2 $3').match(/[+-]?\d+(?:[.,]\d+)*/g) || [];
  const allowed = new Set(values.flatMap((value) => {
    const formatted = typeof value === 'number' ? formatCount(value, locale)
      : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatFactDay(value, locale) : value;
    return [...tokens(value), ...tokens(formatted)];
  }));
  const plain = String(text).replace(/^\d+\. /gm, '').replace(/【R\d+】/g, '').replaceAll('**', '');
  const invalid = tokens(plain).filter((number) => !allowed.has(number));
  const dates = values.filter((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
  const allowedDates = new Set(dates.flatMap((date) => [date, formatFactDay(date, locale)]));
  const months = Array.from({ length: 12 }, (_, index) => formatFactDay(`2026-${String(index + 1).padStart(2, '0')}-01`, locale).split(' ')[1]).join('|');
  for (const [date] of plain.matchAll(new RegExp(`\\b(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2} (?:${months}) \\d{4})\\b`, 'g'))) {
    if (!allowedDates.has(date) && tokens(date).every((number) => allowed.has(number))) invalid.push(date);
  }
  return invalid;
}
