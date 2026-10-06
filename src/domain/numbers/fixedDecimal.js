export function scaledDecimal(value, scale) {
  if (value == null || value === '') return null;
  const text = typeof value === 'number' ? value.toFixed(scale) : String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[3]?.length || 0) > scale) return null;
  return BigInt(`${match[1]}${match[2]}${(match[3] || '').padEnd(scale, '0')}`);
}

export function decimalFromScaled(value, scale) {
  if (value == null) return null;
  const digits = (value < 0n ? -value : value).toString().padStart(scale + 1, '0');
  const text = scale === 0 ? `${value < 0n ? '-' : ''}${digits}` : `${value < 0n ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  const number = Number(text);
  return Number.isSafeInteger(Number(value)) && scaledDecimal(number, scale) === value ? number : text;
}

export function fixedDecimal(value, scale) {
  return decimalFromScaled(scaledDecimal(value, scale), scale);
}
