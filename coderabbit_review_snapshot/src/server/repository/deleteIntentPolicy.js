function text(value) {
  return value == null ? '' : String(value).trim();
}

export function findDeleteIntentIssue({
  exists,
  version,
  entityType = 'ENTITY',
  id = null
} = {}) {
  if (!exists) {
    return {
      code: 'DELETE_TARGET_MISSING',
      entityType,
      id,
      message: 'Silinecek kayıt artık bulunamadı. Verileri yeniden yükleyin.'
    };
  }

  if (!text(version)) {
    return {
      code: 'DELETE_VERSION_REQUIRED',
      entityType,
      id,
      message: 'Kayıt sürümü eksik. Verileri yeniden yükleyin.'
    };
  }

  return null;
}
