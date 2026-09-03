import { createHash } from 'node:crypto';

/**
 * Kurumsal WBS eşitlemesinin "değişmeyeni atla" katmanı.
 *
 * CN43N kaynağı proje başına binlerce satır döndürür. Eski akış her anlık
 * görüntü isteğinde bu satırların tamamını MR_WBS ile birleştiriyordu; 38 bin
 * satırlık kurulumda tek bir açılış isteği otuz saniyeden uzun sürüyordu.
 * Oysa kaynak veri günler boyunca değişmez. Bu modül proje başına içerik
 * parmak izi (SHA-256) üretir; parmak izi ve depodaki düğüm sayısı aynıysa
 * birleştirme adımı tümüyle atlanır.
 *
 * Modül saf JavaScript'tir: veritabanına dokunmaz, bu yüzden tek başına
 * sınanabilir.
 */

const SEPARATOR = String.fromCharCode(31);
const RECORD_SEPARATOR = String.fromCharCode(30);

/** Düğüm planından alan sırasından bağımsız, kararlı bir parmak izi üretir. */
export function corporateWbsContentHash(nodes = []) {
  const hash = createHash('sha256');
  const ordered = [...nodes].sort((left, right) => String(left?.sourceKey || '').localeCompare(String(right?.sourceKey || '')));
  for (const node of ordered) {
    // Alanlar birim ayırıcı ile birleştirilir; böylece bitişik alanların
    // kayması aynı parmak izini üretemez.
    hash.update([
      node?.sourceKey ?? '',
      node?.name ?? '',
      node?.level ?? '',
      node?.outlineCode ?? '',
      node?.statusCode ?? '',
      node?.elementTypeCode ?? '',
      node?.parentSourceKey ?? '',
      node?.sortOrder ?? ''
    ].join(SEPARATOR));
    hash.update(RECORD_SEPARATOR);
  }
  return hash.digest('hex');
}

/** Veritabanından okunan eşitleme durumu satırlarını haritaya çevirir. */
export function indexCorporateWbsSyncState(rows = []) {
  const state = new Map();
  for (const row of rows || []) {
    const code = String(row?.ProjectCode || '').trim().toUpperCase();
    if (!code) continue;
    state.set(code, {
      contentHash: String(row.ContentHash || ''),
      nodeCount: Number(row.NodeCount ?? 0),
      storedNodeCount: row.StoredNodeCount == null ? null : Number(row.StoredNodeCount)
    });
  }
  return state;
}

/**
 * Bir projenin birleştirme adımının atlanıp atlanamayacağına karar verir.
 *
 * Parmak izi eşleşmesi tek başına yetmez: MR_WBS satırları elle silinmiş ya da
 * betikle sıfırlanmış olabilir. Bu yüzden depoda gerçekten duran kurumsal düğüm
 * sayısı da beklenen sayı ile karşılaştırılır.
 */
export function canSkipCorporateWbsMerge(previous, contentHash, nodeCount) {
  if (!previous || !contentHash) return false;
  if (previous.contentHash !== contentHash) return false;
  if (previous.nodeCount !== nodeCount) return false;
  if (previous.storedNodeCount != null && previous.storedNodeCount !== nodeCount) return false;
  return true;
}

/**
 * Bir toplu iş (batch) için hangi projelerin birleştirileceğini planlar.
 *
 * @returns {{ merges: Array, skipped: string[] }}
 */
export function planCorporateWbsSyncBatch(projectCodes, plannedByCode, syncState) {
  const merges = [];
  const skipped = [];

  for (const projectCode of projectCodes) {
    const nodes = plannedByCode.get(projectCode) || [];
    // BOŞ küme birleştirilmez ve bu BİLİNÇLİDİR. Birleştirme SQL'i kaynakta
    // bulunmayan düğümleri (alt düğümü ve görevi olmayanları) siler; kaynağın
    // geçici olarak sıfır satır döndürmesi — CN43N kesintisi, yetki değişimi,
    // besleme gecikmesi — böylece o projenin kurumsal WBS yapraklarını kalıcı
    // olarak silerdi. Kaynak gerçekten boşaldığında düğümler bir sonraki
    // gerçek turda değil, elle temizlemeyle kaldırılır; veri kaybı riski
    // bayat düğüm riskinden ağır basar.
    if (!nodes.length) continue;
    const contentHash = corporateWbsContentHash(nodes);
    if (canSkipCorporateWbsMerge(syncState.get(projectCode), contentHash, nodes.length)) {
      skipped.push(projectCode);
      continue;
    }
    merges.push({ projectCode, nodes, contentHash });
  }

  return { merges, skipped };
}
