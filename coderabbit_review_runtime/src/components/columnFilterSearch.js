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
 * İKİ katlama birden uygulanır. Türkçe katlama insan adları için doğrudur:
 * "İ/ı" ayrımı yüzünden `toLowerCase()` kurumsal adlarda yanlış sonuç verir.
 * Ama aynı yardımcı proje kodu, Sicil ve kullanıcı adı gibi ASCII tanımlayıcıları
 * da arar: `MIR` kodu Türkçe katlamada `mır` olur ve kullanıcı `mir` yazdığında
 * hiç eşleşmezdi. Bu yüzden her iki katlama da denenir.
 */
function folds(value) {
  const text = String(value);
  return [text.toLocaleLowerCase('tr-TR'), text.toLowerCase()];
}

export function matchesOptionQuery(option, query) {
  const raw = String(query || '').trim();
  if (!raw) return true;
  const [turkishNeedle, invariantNeedle] = folds(raw);
  return [option?.label, option?.value, option?.description, ...(option?.keywords || [])]
    .filter((value) => value != null && value !== '')
    .some((value) => {
      const [turkish, invariant] = folds(value);
      return turkish.includes(turkishNeedle) || invariant.includes(invariantNeedle);
    });
}
