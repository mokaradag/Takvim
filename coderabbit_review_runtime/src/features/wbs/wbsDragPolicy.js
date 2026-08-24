import { compareWbsNodes } from '../../domain/selectors/wbsSelectors.js';

/**
 * İş dağılım ağacı sürükle-bırak ilkeleri.
 *
 * Görünümden ayrı tutulur: bir bırakmanın geçerli olup olmadığı ve hangi
 * taşıma isteğine karşılık geldiği saf bir dönüşümdür, tek başına sınanabilir.
 *
 * Üç bırakma konumu vardır:
 *  - `inside` → düğüm hedefin ALTINA alınır (üst değişikliği).
 *  - `before` / `after` → düğüm hedefin KARDEŞİ yapılır ve sıraya yerleşir.
 */

export const WBS_DROP_POSITIONS = Object.freeze(['before', 'inside', 'after']);

const MESSAGES = Object.freeze({
  WBS_NODE_NOT_FOUND: 'Taşınacak dağılım düğümü bulunamadı.',
  WBS_TARGET_NOT_FOUND: 'Hedef dağılım düğümü bulunamadı.',
  WBS_DROP_ON_SELF: 'Bir düğüm kendi üzerine bırakılamaz.',
  WBS_ROOT_REPARENT_FORBIDDEN: 'Proje kök düğümü taşınamaz.',
  WBS_ROOT_SIBLING_FORBIDDEN: 'Proje kök düğümünün kardeşi oluşturulamaz.',
  CROSS_PROJECT_WBS_PARENT: 'Düğümler farklı projeler arasında taşınamaz.',
  WBS_REPARENT_TO_DESCENDANT: 'Bir düğüm kendi alt ağacının içine taşınamaz.',
  WBS_DROP_NO_CHANGE: 'Düğüm zaten bu konumda.'
});

function reject(code) {
  return { ok: false, code, message: MESSAGES[code] || 'Taşıma doğrulanamadı.' };
}

/** Aynı üst düğüme bağlı kardeşler, ağaçtaki görüntü sırasıyla döner. */
export function wbsSiblings(wbs, parentId) {
  return (wbs || [])
    .filter((node) => node.parentId === parentId)
    .slice()
    .sort(compareWbsNodes);
}

/**
 * Sürükleme oturumu için bir kez kurulan arama dizini.
 *
 * `dragover` işaretçi her kıpırdadığında tetiklenir. Dizin olmadan her olayda
 * bütün ağaç için üst→çocuk haritası kuruluyor ve her kardeş kümesi yeniden
 * sıralanıyordu; 38 bin düğümlük kurumsal ağaçta bu, sürüklemeyi kilitler.
 * Alt ağaç kimlikleri de düğüm başına bir kez hesaplanıp saklanır.
 */
export function createWbsDropIndex(wbs) {
  const byId = new Map();
  const childrenByParent = new Map();
  for (const node of wbs || []) {
    byId.set(node.id, node);
    const key = node.parentId ?? null;
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(node);
  }
  for (const list of childrenByParent.values()) list.sort(compareWbsNodes);
  return { byId, childrenByParent, descendants: new Map() };
}

/** Dizinden bir üst düğümün SIRALI çocuk listesi (O(1) arama). */
export function wbsIndexChildren(index, parentId) {
  return index?.childrenByParent?.get(parentId ?? null) || [];
}

function indexChildren(index, parentId) {
  return wbsIndexChildren(index, parentId);
}

/**
 * Düğümün kardeşleri arasındaki sırası ve kardeş sayısı.
 *
 * Satır çizimi bunu dizinden okur. `wbsSiblings` her çağrıda bütün ağacı
 * süzüp sıralar; 38 bin düğümlük kurumsal ağaçta satır başına iki kez
 * çağrılması "Tümünü aç" sonrasında çizimi fiilen O(n²) yapıyor ve sayfayı
 * donmuş gösteriyordu.
 */
export function wbsSiblingPlacement(index, node) {
  if (!node || node.parentId == null) return { index: -1, count: 0 };
  const siblings = indexChildren(index, node.parentId);
  return { index: siblings.findIndex((sibling) => sibling.id === node.id), count: siblings.length };
}

function indexDescendantIds(index, nodeId) {
  const cached = index.descendants.get(nodeId);
  if (cached) return cached;
  const ids = new Set();
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.pop();
    for (const child of indexChildren(index, current)) {
      if (ids.has(child.id)) continue;
      ids.add(child.id);
      queue.push(child.id);
    }
  }
  index.descendants.set(nodeId, ids);
  return ids;
}

/**
 * Bırakma isteğini doğrular ve uygulanacak taşımayı üretir.
 *
 * @param {Array<object>} wbs tüm dağılım düğümleri
 * @param {{dragId: string, targetId: string, position: 'before'|'inside'|'after'}} drop
 * @param {{index?: object}} options sürükleme oturumu boyunca paylaşılan dizin
 * @returns {{ok: true, move: {id: string, parentId: string, index: number}} | {ok: false, code: string, message: string}}
 */
export function resolveWbsDrop(wbs, { dragId, targetId, position = 'inside' } = {}, options = {}) {
  const lookup = options.index || createWbsDropIndex(wbs);
  const node = lookup.byId.get(dragId) || null;
  const target = lookup.byId.get(targetId) || null;

  if (!node) return reject('WBS_NODE_NOT_FOUND');
  if (!target) return reject('WBS_TARGET_NOT_FOUND');
  if (node.id === target.id) return reject('WBS_DROP_ON_SELF');
  if (node.parentId == null) return reject('WBS_ROOT_REPARENT_FORBIDDEN');
  if (node.projectId !== target.projectId) return reject('CROSS_PROJECT_WBS_PARENT');

  if (indexDescendantIds(lookup, node.id).has(target.id)) return reject('WBS_REPARENT_TO_DESCENDANT');

  const inside = position === 'inside';
  // Kök düğümün kardeşi olamaz: proje başına tek kök vardır.
  if (!inside && target.parentId == null) return reject('WBS_ROOT_SIBLING_FORBIDDEN');

  const parentId = inside ? target.id : target.parentId;
  const siblings = indexChildren(lookup, parentId).filter((sibling) => sibling.id !== node.id);

  let index;
  if (inside) {
    // `inside` yalnızca ÜST değişikliğidir; kardeş sırası before/after ile
    // denetlenir. Düğüm zaten bu üstün altındaysa ortaya bırakmak onu listenin
    // sonuna atardı — belgelenen anlamın dışında, sessiz bir sıra değişikliği.
    if (node.parentId === target.id) return reject('WBS_DROP_NO_CHANGE');
    index = siblings.length;
  } else {
    const targetIndex = siblings.findIndex((sibling) => sibling.id === target.id);
    index = targetIndex < 0 ? siblings.length : targetIndex + (position === 'after' ? 1 : 0);
  }

  // Sonuç sırası mevcut sırayla birebir aynıysa taşıma boşuna kayıt üretmesin.
  if (node.parentId === parentId) {
    const next = siblings.map((sibling) => sibling.id);
    next.splice(index, 0, node.id);
    const current = indexChildren(lookup, node.parentId).map((sibling) => sibling.id);
    if (next.length === current.length && next.every((value, at) => value === current[at])) {
      return reject('WBS_DROP_NO_CHANGE');
    }
  }

  return { ok: true, move: { id: node.id, parentId, index } };
}
