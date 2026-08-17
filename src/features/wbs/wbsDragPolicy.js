import { compareWbsNodes, selectWbsDescendantIds } from '../../domain/selectors/wbsSelectors.js';

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
 * Bırakma isteğini doğrular ve uygulanacak taşımayı üretir.
 *
 * @param {Array<object>} wbs tüm dağılım düğümleri
 * @param {{dragId: string, targetId: string, position: 'before'|'inside'|'after'}} drop
 * @returns {{ok: true, move: {id: string, parentId: string, index: number}} | {ok: false, code: string, message: string}}
 */
export function resolveWbsDrop(wbs, { dragId, targetId, position = 'inside' } = {}) {
  const nodes = wbs || [];
  const node = nodes.find((item) => item.id === dragId) || null;
  const target = nodes.find((item) => item.id === targetId) || null;

  if (!node) return reject('WBS_NODE_NOT_FOUND');
  if (!target) return reject('WBS_TARGET_NOT_FOUND');
  if (node.id === target.id) return reject('WBS_DROP_ON_SELF');
  if (node.parentId == null) return reject('WBS_ROOT_REPARENT_FORBIDDEN');
  if (node.projectId !== target.projectId) return reject('CROSS_PROJECT_WBS_PARENT');

  const blocked = new Set(selectWbsDescendantIds(nodes, node.id));
  if (blocked.has(target.id)) return reject('WBS_REPARENT_TO_DESCENDANT');

  const inside = position === 'inside';
  // Kök düğümün kardeşi olamaz: proje başına tek kök vardır.
  if (!inside && target.parentId == null) return reject('WBS_ROOT_SIBLING_FORBIDDEN');

  const parentId = inside ? target.id : target.parentId;
  const siblings = wbsSiblings(nodes, parentId).filter((sibling) => sibling.id !== node.id);

  let index;
  if (inside) {
    index = siblings.length;
  } else {
    const targetIndex = siblings.findIndex((sibling) => sibling.id === target.id);
    index = targetIndex < 0 ? siblings.length : targetIndex + (position === 'after' ? 1 : 0);
  }

  // Sonuç sırası mevcut sırayla birebir aynıysa taşıma boşuna kayıt üretmesin.
  if (node.parentId === parentId) {
    const next = siblings.map((sibling) => sibling.id);
    next.splice(index, 0, node.id);
    const current = wbsSiblings(nodes, node.parentId).map((sibling) => sibling.id);
    if (next.length === current.length && next.every((value, at) => value === current[at])) {
      return reject('WBS_DROP_NO_CHANGE');
    }
  }

  return { ok: true, move: { id: node.id, parentId, index } };
}
