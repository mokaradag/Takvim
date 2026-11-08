import { formatCount, formatFactDay } from '../../src/domain/ai/groundedPropositions.js';

/** Numaralı liste işaretleri ve atıf kimlikleri sayı iddiası değildir; diğer bütün sayısal parçalar denetlenir. */
export function unsupportedNumbers(text, values, locale = 'tr') {
  const tokens = (value) => String(value).replace(/(\d{4})-(\d{2})-(\d{2})/g, '$1 $2 $3').match(/[+-]?\d+(?:[.,]\d+)*/g) || [];
  const allowed = new Set(values.flatMap((value) => {
    const formatted = typeof value === 'number' ? formatCount(value, locale)
      : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatFactDay(value, locale) : value;
    return [...tokens(value), ...tokens(formatted)];
  }));
  return tokens(String(text).replace(/^\d+\. /gm, '').replace(/【R\d+】/g, '')).filter((number) => !allowed.has(number));
}
