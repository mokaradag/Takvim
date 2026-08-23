/**
 * Kurumsal ekip dizini süzgeç ilkeleri.
 *
 * Kurumsal rehberde herkesin direktörlüğü tanımlı değildir; bir bölüm çalışanın
 * yalnızca yöneticisi bilinir. Ekip sayfası önceden yalnızca direktörlük değeri
 * dolu olan personeli gruplayıp listelediği için bu kişiler hiç görünmüyordu.
 * Sentinel değer, "direktörlüğü tanımsız" kümesini birinci sınıf bir süzgeç
 * seçeneği hâline getirir.
 */

export const UNASSIGNED_DIRECTORATE = '__unassigned__';
export const UNASSIGNED_DIRECTORATE_LABEL = 'Direktörlük tanımsız';

/** Kişinin kurumsal alanını (boşluklar kırpılmış) döndürür. */
export function organizationValue(person, field) {
  return String(person?.organization?.[field] || '').trim();
}

/** Seçili direktörlük süzgeci kişiyle eşleşiyor mu? */
export function matchesDirectorateFilter(person, selection) {
  if (!selection) return true;
  const value = organizationValue(person, 'directorate');
  return selection === UNASSIGNED_DIRECTORATE ? value === '' : value === selection;
}
