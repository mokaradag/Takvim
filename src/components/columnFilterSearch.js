/**
 * Sütun süzgeci seçenek araması — saf mantık.
 *
 * Sorumlu, proje ve etiket gibi sütunların süzgeç listesi binlerce seçenek
 * taşıyabiliyor; arama olmadan listeyi kaydırarak seçenek bulmak tek yoldu ve
 * pratikte kullanılamıyordu. Eşleştirme kuralı görünümden ayrı tutulur, böylece
 * tek başına sınanabilir ve her süzgeç aynı davranışı gösterir.
 */

/** Bu sayıdan fazla seçenek olduğunda süzgeç listesine canlı arama eklenir. */
export const OPTION_SEARCH_THRESHOLD = 7;

/**
 * Seçenek etiketi, değeri, açıklaması ve varsa anahtar sözcükleri üzerinde arar.
 *
 * Arama Türkçe küçük harfe indirgenerek yapılır: "İ/ı" ayrımı yüzünden
 * `toLowerCase()` kurumsal adlarda yanlış sonuç verirdi.
 */
export function matchesOptionQuery(option, query) {
  const needle = String(query || '').trim().toLocaleLowerCase('tr-TR');
  if (!needle) return true;
  return [option?.label, option?.value, option?.description, ...(option?.keywords || [])]
    .filter((value) => value != null && value !== '')
    .some((value) => String(value).toLocaleLowerCase('tr-TR').includes(needle));
}
