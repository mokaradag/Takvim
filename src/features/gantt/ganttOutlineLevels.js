/**
 * Gantt anahat (hiyerarşi) seviyeleri — saf yardımcılar.
 *
 * WBS Gantt'ında dallar tek tek açılıp kapanabiliyordu; derin bir ağaçta
 * "yalnızca ilk iki seviyeyi göster" gibi sıradan bir istek onlarca tıklama
 * gerektiriyordu. Aşağıdaki işlevler açık dal kümesini seviyeden türetir ve
 * bileşenden bağımsız olarak sınanabilir.
 *
 * Seviye sayımı 1 TABANLIDIR: "Seviye 1" yalnızca kök satırlarını gösterir,
 * "Seviye 2" köklerin altındaki bir kuşağı açar. Seviye, ağacın derinliğinden
 * büyük verildiğinde bütün dallar açılır.
 */

/**
 * Ağacın en derin dalının seviye sayısı (kökler 1. seviyedir).
 *
 * KİMLİKSİZ düğüm dalı bitirir. `buildRows` açık dal kümesini kimlikle
 * sorguladığı için böyle bir düğüm hiçbir zaman açılamaz; altındakiler de
 * görünemez. Derinlik onları sayarken `allWbsIds` ve `expandedIdsForLevel`
 * elediğinde en derin seviye "tümünü genişlet" kümesini tutturamıyor ve
 * hiçbir seviye düğmesi etkin görünmüyordu.
 */
export function wbsTreeDepth(tree = []) {
  let deepest = 0;
  const visit = (nodes, depth) => {
    for (const node of nodes || []) {
      if (!node?.id) continue;
      if (depth > deepest) deepest = depth;
      visit(node.children, depth + 1);
    }
  };
  visit(tree, 1);
  return deepest;
}

/** Ağacın bütün düğüm kimlikleri (tümünü genişlet). */
export function allWbsIds(tree = []) {
  const ids = new Set();
  const visit = (nodes) => {
    for (const node of nodes || []) {
      if (!node?.id) continue;
      ids.add(node.id);
      visit(node.children);
    }
  };
  visit(tree);
  return ids;
}

/**
 * Verilen seviyeye kadar AÇIK kalması gereken düğümler.
 *
 * Bir düğüm, çocukları görünsün diye açılır: `Seviye 2` istendiğinde yalnızca
 * kökler açılır (derinlik 1), torunlar kapalı kalır.
 */
export function expandedIdsForLevel(tree = [], level = 1) {
  const target = Number(level);
  const ids = new Set();
  if (!Number.isFinite(target)) return ids;
  // EN DERİN seviye "tümünü genişlet" ile aynı kümeyi verir. Yaprak düğümler
  // dışarıda bırakıldığında küme `allWbsIds()` ile eşleşmiyor ve ağaç tümüyle
  // açıkken hiçbir seviye düğmesi etkin görünmüyordu.
  const expandAll = target >= wbsTreeDepth(tree);
  // Tek seviyeli ağaçta 1. seviye ZATEN tümünü gösterir; erken çıkış bu ağaçta
  // boş küme döndürüyor, açılışta gelen `allWbsIds()` hiçbir seviyeye
  // uymadığı için seviye düğmeleri yine sönük kalıyordu.
  if (!expandAll && target <= 1) return ids;
  const visit = (nodes, depth) => {
    for (const node of nodes || []) {
      if (!node?.id) continue;
      if (expandAll || depth < target) {
        ids.add(node.id);
        visit(node.children, depth + 1);
      }
    }
  };
  visit(tree, 1);
  return ids;
}

/**
 * Açık dal kümesinin karşılığı olan seviye. Küme hiçbir seviyeye tam
 * uymuyorsa (kullanıcı dalları tek tek açtıysa) `null` döner ve seviye
 * düğmelerinden hiçbiri etkin görünmez.
 */
export function levelForExpandedIds(tree = [], expanded = new Set()) {
  const depth = wbsTreeDepth(tree);
  for (let level = 1; level <= Math.max(1, depth); level += 1) {
    const candidate = expandedIdsForLevel(tree, level);
    if (candidate.size !== expanded.size) continue;
    let same = true;
    for (const id of candidate) {
      if (!expanded.has(id)) { same = false; break; }
    }
    if (same) return level;
  }
  return null;
}
