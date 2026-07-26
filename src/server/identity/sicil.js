/**
 * Sicil, MERGEN Rota'nın güvenilir kullanıcı anahtarıdır. Ayrıştırma kuralı tek
 * yerde tanımlanır: hem geçici geliştirme kimliği hem de Keycloak claim'i aynı
 * katı kuralı kullanır. Kısmi ("900001abc"), ondalık, sıfır, negatif, boş veya
 * SQL `int` sınırını aşan değerler kimlik üretmez.
 */
export function parseSicil(value) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const sicil = Number(raw);
  return Number.isSafeInteger(sicil) && sicil <= 2147483647 ? sicil : null;
}
