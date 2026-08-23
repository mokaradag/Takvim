/**
 * Karşılama ekranı selamlaması — saf yardımcılar.
 *
 * Görünümden ayrı tutulur: saat → selamlama ve tam ad → ilk ad dönüşümleri
 * saf işlevlerdir ve tek başına sınanabilir.
 */

/** Saate göre Türkçe selamlama. */
export function greetingForHour(hour) {
  if (!Number.isFinite(hour)) return 'Hoş geldiniz';
  if (hour < 6) return 'İyi geceler';
  if (hour < 12) return 'Günaydın';
  if (hour < 18) return 'İyi günler';
  return 'İyi akşamlar';
}

/** Selamlamada tam ad yerine yalnızca ilk ad kullanılır. */
export function welcomeFirstName(displayName) {
  return String(displayName || '').trim().split(/\s+/)[0] || '';
}
