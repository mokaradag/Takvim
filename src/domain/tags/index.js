/**
 * Proje etiket kataloğu — TEK doğruluk kaynağı.
 *
 * Etiket artık düz bir metin değil, `{ name, color, icon }` üçlüsüdür. Eski
 * anlık görüntülerde (ve Basit Mod'un hızlı girişinde) etiketler düz metin
 * olarak geldiği için normalleştirme her iki biçimi de kabul eder.
 *
 * Modül saftır: React, Next.js veya SQL bağımlılığı yoktur; hem istemci hem
 * sunucu doğrulaması aynı listeleri kullanır.
 */

/** Etiket renkleri, proje renk anahtarlarıyla aynı paletten seçilir. */
export const TAG_COLOR_KEYS = Object.freeze(['blue', 'emerald', 'purple', 'amber', 'rose', 'cyan']);

/**
 * Etiket simgeleri. Değerler `Icons` sözlüğündeki adlardır; kapalı bir küme
 * olmasının nedeni hem doğrulanabilir olması hem de arayüzde bilinmeyen bir
 * simge adının boş kutu bırakmamasıdır.
 */
export const TAG_ICON_KEYS = Object.freeze([
  'Flag', 'Target', 'Sparkle', 'Alert', 'Check', 'Clock',
  'Diamond', 'Layers', 'Link', 'Briefcase', 'Coin', 'Hours',
  'Database', 'Wand', 'Gift', 'Compass'
]);

export const DEFAULT_TAG_COLOR = 'blue';
export const DEFAULT_TAG_ICON = 'Flag';

/** Görüntülenecek ad; boşluklar kırpılır. */
function tagName(value) {
  return String(value ?? '').trim();
}

/** Ad karşılaştırması Türkçe küçük harfe indirilerek yapılır. */
export function comparableTagName(value) {
  return tagName(value).normalize('NFKC').toLocaleLowerCase('tr-TR');
}

export function isTagColorKey(value) {
  return TAG_COLOR_KEYS.includes(String(value ?? ''));
}

export function isTagIconKey(value) {
  return TAG_ICON_KEYS.includes(String(value ?? ''));
}

/**
 * Etiket adına göre kararlı bir varsayılan renk seçer.
 *
 * Renk seçilmemiş etiketlerin hepsinin aynı renge düşmesi kataloğu okunmaz
 * kılıyordu; ada bağlı deterministik seçim, yeniden yüklemeler arasında da
 * aynı rengi verir.
 */
export function defaultTagColor(name) {
  const text = tagName(name);
  if (!text) return DEFAULT_TAG_COLOR;
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  return TAG_COLOR_KEYS[Math.abs(hash) % TAG_COLOR_KEYS.length];
}

/**
 * Tek bir etiketi kanonik biçime getirir.
 *
 * @param {string|{name?: string, color?: string, icon?: string}} value
 * @returns {{name: string, color: string, icon: string}|null} ad boşsa `null`
 */
export function normalizeProjectTag(value) {
  const source = typeof value === 'string' ? { name: value } : (value || {});
  const name = tagName(source.name ?? source.tagName ?? source.label);
  if (!name) return null;
  return {
    name,
    color: isTagColorKey(source.color) ? source.color : defaultTagColor(name),
    icon: isTagIconKey(source.icon) ? source.icon : DEFAULT_TAG_ICON
  };
}

/**
 * Etiket kataloğunu kanonikleştirir: boş adlar atılır, aynı ada sahip ikinci
 * kayıt yok sayılır, sıralama Türkçe alfabetiktir.
 */
export function normalizeProjectTags(values = []) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map(normalizeProjectTag)
    .filter(Boolean)
    .filter((tag) => {
      const key = comparableTagName(tag.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'tr'));
}

/** Katalogda verilen ada karşılık gelen etiketi bulur (harf duyarsız). */
export function findProjectTag(tags, name) {
  const key = comparableTagName(name);
  if (!key) return null;
  return (tags || []).map(normalizeProjectTag).find((tag) => tag && comparableTagName(tag.name) === key) || null;
}

/** Etiket adlarının düz listesi (eski çağrı yerleri ve dışa aktarım için). */
export function projectTagNames(tags) {
  return normalizeProjectTags(tags).map((tag) => tag.name);
}
