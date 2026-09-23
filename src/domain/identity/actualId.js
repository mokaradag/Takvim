/**
 * Gerçek Sistem kimlikleri (SQL Server `uniqueidentifier`) için tek kanonik kaynak.
 *
 * İki kural bu modülde toplanır:
 *
 * 1. Desen RFC 4122 sürüm/varyant bitlerini ZORLAMAZ. Kurumsal kaynak sistemler
 *    (SAP vb.) `D5D70AEC-0A88-F111-9136-00505699BACD` gibi sürüm dörtlüsü "F"
 *    olan GUID üretir; bunlar SQL Server için tamamen geçerlidir. Eski `[1-5]`
 *    ve `[89ab]` kısıtları bu kimlikleri reddettiği için kurumsal projelerde
 *    proje güncelleme, görev ve WBS yazma işlemleri "geçerli bir Gerçek Sistem
 *    kimliği (UUID) değil" hatasıyla çöküyordu.
 * 2. Kanonik biçim KÜÇÜK HARFtir. SQL Server GUID değerlerini büyük harf metin
 *    olarak döndürür; istemci ise kimlikleri küçük harfe indiriyordu. Sunucudaki
 *    `!==` karşılaştırmaları bu yüzden aynı kaydı farklı sanıyor ve "Üst WBS aynı
 *    projede bulunmalıdır" / "Görev WBS kaydı aynı projede olmalıdır" gibi
 *    yanlış hatalar üretiyordu. Tüm katmanlar kimlikleri bu modülden geçirir.
 */

export const ACTUAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTUAL_ID_SUFFIX_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const TASK_REFERENCE_PATTERN = /^(?:task-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function text(value) {
  return value == null ? '' : String(value).trim();
}

/** Değer geçerli bir Gerçek Sistem kimliği mi? */
export function isActualId(value) {
  return ACTUAL_ID_PATTERN.test(text(value));
}

/**
 * Kimliği kanonik (küçük harf) biçime indirir. Geçerli bir GUID değilse
 * `null` döner; çağıran taraf hatayı kendi bağlamına göre raporlar.
 */
export function canonicalActualId(value) {
  const normalized = text(value);
  return ACTUAL_ID_PATTERN.test(normalized) ? normalized.toLowerCase() : null;
}

/**
 * Kanonikleştirir; GUID değilse değeri olduğu gibi geri verir. Doğrulama
 * yapmadan yalnızca büyük/küçük harf farkını gidermek isteyen katmanlar
 * (kanonikleştirme adımları) bunu kullanır.
 */
export function canonicalActualIdOrValue(value) {
  if (value == null || value === '') return value;
  return canonicalActualId(value) ?? value;
}

/**
 * İstemci önekli kimliklerden (`task-<uuid>`, `wbs-<uuid>`) Gerçek Sistem
 * kimliğini ayıklar ve kanonikleştirir. Önek yoksa değerin kendisi denenir.
 */
export function extractActualId(value) {
  if (value == null || value === '') return null;
  const normalized = text(value);
  const match = normalized.match(ACTUAL_ID_SUFFIX_PATTERN);
  return canonicalActualId(match ? match[1] : normalized);
}

/**
 * Sunucudan gelen çıplak UUID ile istemcide korunan önekli kimliği aynı kayıt
 * olarak karşılaştırır. Demo/yerel kimliklerde ise olağan metin eşitliği korunur.
 */
export function sameActualReference(left, right) {
  const firstMatch = text(left).match(TASK_REFERENCE_PATTERN);
  const secondMatch = text(right).match(TASK_REFERENCE_PATTERN);
  const first = firstMatch ? canonicalActualId(firstMatch[1]) : null;
  const second = secondMatch ? canonicalActualId(secondMatch[1]) : null;
  if (first && second) return first === second;
  const leftText = text(left);
  const rightText = text(right);
  if (!leftText || !rightText) return false;
  return leftText === rightText;
}

/**
 * İki kimlik aynı kaydı mı gösteriyor? (büyük/küçük harf duyarsız)
 *
 * YOKLUK eşitlik saymaz. `text()` hem `null` hem `undefined` hem de `''`
 * değerini `''` üretir; yedek karşılaştırma bu yüzden iki taraf da BOŞKEN
 * `true` dönüyordu, oysa hiçbiri bir kaydı göstermiyor. `sameNullableId`
 * açık null-null davranışını korur ve bu değişiklikten etkilenmez.
 */
export function sameActualId(left, right) {
  const first = canonicalActualId(left);
  const second = canonicalActualId(right);
  if (first && second) return first === second;
  const leftText = text(left);
  const rightText = text(right);
  // YOKLUK kimlik saymaz: bu işlev NOT NULL sütunlar içindir ve iki boş değeri
  // "aynı proje" saymak, kapsam denetimini sessizce gevşetirdi. Boş değerin
  // anlamlı olduğu NULL yapılabilir sütunlar için `sameNullableId` kullanılır.
  if (!leftText || !rightText) return false;
  return leftText.toLowerCase() === rightText.toLowerCase();
}
