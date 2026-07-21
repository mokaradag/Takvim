const LEGACY_TO_CANONICAL = Object.freeze({
  baslangicTarihi: 'plannedStart',
  bitisTarihi: 'plannedFinish',
  hedefTarih: 'targetFinish'
});

export function migrateLegacyTaskSchedule(task = {}) {
  const migrated = { ...task };

  for (const [legacyField, canonicalField] of Object.entries(LEGACY_TO_CANONICAL)) {
    if (!Object.prototype.hasOwnProperty.call(migrated, canonicalField)
      && Object.prototype.hasOwnProperty.call(migrated, legacyField)) {
      migrated[canonicalField] = migrated[legacyField];
    }
    delete migrated[legacyField];
  }

  return migrated;
}
