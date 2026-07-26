/**
 * İş dağılım ağacı görünüm ilkeleri.
 *
 * Görünümden ayrı tutulur: derinlik hesabı saf bir dönüşümdür ve tek başına
 * sınanabilir.
 */

/**
 * Açılışta kaç hiyerarşi seviyesinin görüneceği.
 *
 * Önceden ağacın tamamı açık başlıyordu. Kurumsal projelerde CN43N kaynağı on
 * binlerce düğüm getirdiği için bu, ilk çizimde tüm satırların oluşturulması
 * demekti ve sayfa yanıt veremez hâle geliyordu. İlk iki seviye hem hızlı hem
 * de anlamlı bir başlangıç verir; kullanıcı üstteki denetimlerle derinliği
 * dilediği gibi değiştirebilir.
 */
export const DEFAULT_WBS_DEPTH = 2;

/** Hiyerarşi seçici seçenekleri (derinlik = görünen seviye sayısı). */
export const WBS_DEPTH_OPTIONS = Object.freeze([
  { value: 1, label: 'Seviye 1 · yalnızca kök' },
  { value: 2, label: 'Seviye 2' },
  { value: 3, label: 'Seviye 3' },
  { value: 4, label: 'Seviye 4' },
  { value: 5, label: 'Seviye 5' },
  { value: Number.POSITIVE_INFINITY, label: 'Tüm seviyeler' }
]);

/**
 * Verilen derinliğe kadar açık kalacak düğüm kimliklerini üretir.
 *
 * `depth`, görünecek seviye sayısıdır: 1 yalnızca kökleri gösterir (hiçbir
 * düğüm açılmaz), 2 köklerin çocuklarını da gösterir.
 *
 * @param {Array<{node: {id: string}, depth: number}>} rows `flattenWbsTree` çıktısı
 * @param {number} depth görünecek seviye sayısı
 * @returns {Set<string>}
 */
export function expandedIdsForDepth(rows, depth) {
  const expanded = new Set();
  for (const { node, depth: rowDepth } of rows || []) {
    // Yaprak düğümleri kümede tutmanın anlamı yok; büyük ağaçlarda küme
    // gereksiz büyümesin diye yalnızca çocuğu olanlar eklenir.
    if (rowDepth + 1 < depth && (node.children || []).length > 0) expanded.add(node.id);
  }
  return expanded;
}
