// Yeniden yükleme ile giderilebilecek eşzamanlılık/sürüm hataları.
export const RELOADABLE_SAVE_ERROR_CODES = Object.freeze([
  'CONFLICT',
  'UPSERT_CREATE_COLLISION',
  'UPSERT_TARGET_MISSING'
]);

const RELOADABLE = new Set(RELOADABLE_SAVE_ERROR_CODES);

/**
 * Kaydetme hatasını kullanıcıya gösterilebilir alanlara ayırır. Arayüz eskiden
 * yalnızca sabit "Kaydetme hatası" metnini gösteriyor, sunucunun gerçek gerekçesi
 * hiçbir yerde görünmüyordu; bu da sorunun kullanıcı tarafından çözülmesini
 * imkânsız kılıyordu.
 */
export function describeSaveError(error) {
  if (!error) return null;
  const detailCode = error.details?.code || null;
  return {
    message: error.message || 'Değişiklik kaydedilemedi.',
    code: detailCode || error.code || null,
    path: error.details?.path || null,
    field: error.field || error.details?.field || null,
    operation: error.operation || null,
    canReload: RELOADABLE.has(error.code) || RELOADABLE.has(detailCode)
  };
}
