function hasVersion(value) {
  return value != null && String(value).trim() !== '';
}

export function findUpsertIntentIssue({
  exists = false,
  version = null,
  entityType = 'record',
  id = null
} = {}) {
  const updateIntent = hasVersion(version);

  if (updateIntent && !exists) {
    return {
      code: 'UPSERT_TARGET_MISSING',
      entityType,
      id,
      message: 'Kayıt artık bulunamadı. Verileri yeniden yükleyin.'
    };
  }

  if (!updateIntent && exists) {
    return {
      code: 'UPSERT_CREATE_COLLISION',
      entityType,
      id,
      message: 'Kayıt kimliği zaten kullanılıyor. Verileri yeniden yükleyin.'
    };
  }

  return null;
}
