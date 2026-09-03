import 'server-only';

/**
 * Sorgu metnine GÖMÜLEN tablo/sütun adlarının doğrulaması.
 *
 * Bu adlar yalnızca modül içi sabitlerden gelir; hiçbir istek gövdesi ya da
 * sorgu parametresi buraya ulaşmaz. Yine de doğrulama AÇIKÇA yapılır: kural bir
 * yorumda değil, çalışan kodda durduğunda ileride eklenen bir çağrı yeri
 * yanlışlıkla dışarıdan gelen bir değeri geçiremez ve statik çözümleyiciler de
 * dizge birleştirmenin sınırlı olduğunu görebilir. Değerler her zaman
 * parametre olarak bağlanır (`request.input`); yalnızca TANIMLAYICILAR gömülür.
 */
const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * @param {string} value doğrulanacak tanımlayıcı
 * @param {string} [label] hata iletisinde geçecek alan adı
 * @returns {string} doğrulanmış tanımlayıcı
 */
export function sqlIdentifier(value, label = 'identifier') {
  const name = String(value ?? '');
  if (!SQL_IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`Unsafe SQL ${label}: only plain identifiers may be embedded in a query.`);
  }
  return name;
}
