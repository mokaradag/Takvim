/**
 * Proje etiket kataloğu — TEK doğruluk kaynağı.
 *
 * Etiket artık düz bir metin değil, `{ name, color, icon }` üçlüsüdür. Eski
 * anlık görüntülerde (ve Temel Kip'un hızlı girişinde) etiketler düz metin
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

/**
 * Saklanan görünümü koruyarak gelen katalogu birleştirir.
 *
 * Eski istemci paketleri `project.tags` alanını DÜZ METİN dizisi olarak geri
 * gönderir. Renk/simge taşımayan böyle bir yazma doğrudan kanonikleştirilirse,
 * yeni bir istemcinin kaydettiği özel renk ve simgeler sessizce varsayılana
 * döner — sürüm geçişi sırasında kalıcı veri kaybı. Ad eşleşen etiketlerde
 * eksik görünüm alanları saklanan değerden tamamlanır.
 */
export function mergeProjectTagAppearance(values, storedTags = []) {
  const stored = new Map(normalizeProjectTags(storedTags).map((tag) => [comparableTagName(tag.name), tag]));
  return normalizeProjectTags((Array.isArray(values) ? values : []).map((value) => {
    const incoming = typeof value === 'string' ? { name: value } : (value || {});
    const previous = stored.get(comparableTagName(incoming.name ?? incoming.tagName ?? incoming.label));
    if (!previous) return incoming;
    return {
      ...incoming,
      color: isTagColorKey(incoming.color) ? incoming.color : previous.color,
      icon: isTagIconKey(incoming.icon) ? incoming.icon : previous.icon
    };
  }));
}

/**
 * Projenin etiket kataloğu.
 *
 * Anlık görüntü iki alan taşır: `tags` eski sözleşmedeki DÜZ METİN listesidir
 * (sürüm geçişinde açık kalan eski paketler bozulmasın diye korunur),
 * `tagCatalog` ise renk ve simgeyi taşıyan kanonik katalogdur. Yeni arayüz
 * kataloğu okur, yoksa düz metin listesine düşer.
 */
export function projectTagCatalog(project) {
  const catalog = Array.isArray(project?.tagCatalog) ? project.tagCatalog : null;
  return normalizeProjectTags(catalog ?? (Array.isArray(project?.tags) ? project.tags : []));
}

/** Katalogda verilen ada karşılık gelen etiketi bulur (harf duyarsız). */
export function findProjectTag(tags, name) {
  const key = comparableTagName(name);
  if (!key) return null;
  return (tags || []).map(normalizeProjectTag).find((tag) => tag && comparableTagName(tag.name) === key) || null;
}

/**
 * Katalog değişikliğinin görev anahtar sözcüklerine nasıl yansıyacağını planlar.
 *
 * Plan bilinçli olarak SAF ve konumdan bağımsızdır: aynı plan hem SQL Server
 * sınırında (canlı `MR_Tasks` satırlarına, katalog yazmasıyla AYNI işlemde) hem
 * de Demo deposunda uygulanır. Yayılım istemcinin gördüğü görev kümesine
 * bırakılırsa, eşzamanlı bir kullanıcının aynı anda oluşturduğu görev katalog
 * dışında kalır — kalıcı bir öksüz kayıt.
 *
 * Üç kural vardır:
 *  1. **Yeniden adlandırma** – açıkça bildirilen eski→yeni eşlemesi uygulanır.
 *  2. **Ad düzeltme** – katalogdaki adın harf varyantları kanonik yazıma çekilir.
 *  3. **Kaldırma** – yalnızca BU yazmada katalogdan çıkarılan ad temizlenir.
 *     Hiç katalogda olmamış eski anahtar sözcükler korunur: aksi hâlde boş
 *     kataloglu eski bir projeyi kaydetmek bütün etiketleri silerdi.
 *
 * @returns {Array<{from: string, to: string|null}>} `to === null` → temizle
 */
export function planProjectTagPropagation({ storedTags = [], nextTags = [], renames = [] } = {}) {
  const next = normalizeProjectTags(nextTags);
  const nextByKey = new Map(next.map((tag) => [comparableTagName(tag.name), tag.name]));
  const plan = [];
  const renamedSources = new Set();

  for (const entry of Array.isArray(renames) ? renames : []) {
    const from = tagName(entry?.from);
    const to = nextByKey.get(comparableTagName(entry?.to));
    if (!from || !to || comparableTagName(from) === comparableTagName(to)) continue;
    renamedSources.add(comparableTagName(from));
    plan.push({ from, to });
  }

  for (const tag of next) plan.push({ from: tag.name, to: tag.name });

  for (const tag of normalizeProjectTags(storedTags)) {
    const key = comparableTagName(tag.name);
    if (nextByKey.has(key) || renamedSources.has(key)) continue;
    plan.push({ from: tag.name, to: null });
  }

  return plan;
}

/** Planı bir görev listesine uygular (Demo deposu ve testler için). */
export function applyProjectTagPropagation(tasks, projectId, plan = []) {
  if (!plan.length) return tasks || [];
  const byKey = new Map(plan.map((entry) => [comparableTagName(entry.from), entry.to]));
  return (tasks || []).map((task) => {
    if (task?.projectId !== projectId || !task?.keyword) return task;
    const key = comparableTagName(task.keyword);
    if (!byKey.has(key)) return task;
    const next = byKey.get(key);
    return next === task.keyword ? task : { ...task, keyword: next };
  });
}

/** Etiket adlarının düz listesi (eski çağrı yerleri ve dışa aktarım için). */
export function projectTagNames(tags) {
  return normalizeProjectTags(tags).map((tag) => tag.name);
}
