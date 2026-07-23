export function parseDevelopmentSicil(value) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const sicil = Number(raw);
  return Number.isSafeInteger(sicil) && sicil <= 2147483647 ? sicil : null;
}
