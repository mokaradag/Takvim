const LEGACY_TO_CANONICAL = Object.freeze({
  baslangicTarihi: 'plannedStart',
  bitisTarihi: 'plannedFinish',
  hedefTarih: 'targetFinish'
});

export function migrateLegacyTaskSchedule(task = {}) {
  const migrated = { ...task };

  for (const [legacyField, canonicalField] of Object.entries(LEGACY_TO_CANONICAL)) {
    // Denetim ANAHTAR varlığına değil DEĞERE bakar: kanonik alanı adıyla taşıyan
    // ama değeri `undefined`/`null` olan bir kayıt (kısmi bir yamanın yayılması)
    // eski alanı devralmıyor, sonraki satırda onu siliyor ve tarih kayboluyordu.
    if (migrated[canonicalField] == null && migrated[legacyField] != null) {
      migrated[canonicalField] = migrated[legacyField];
    }
    delete migrated[legacyField];
  }

  return migrated;
}
