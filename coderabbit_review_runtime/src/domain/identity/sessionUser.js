/**
 * Oturum kullanıcısı: kurumsal rehber kaydı + doğrulanmış kimlik claim'leri.
 *
 * ÖNEMLİ AYRIM — iki farklı "departman" kaynağı vardır:
 *
 *   - `currentUser.organization.department`: HR02 `mudurluk` alanından türetilen
 *     KURUMSAL rehber değeri (MR_V_PeopleDirectory `Department` sütunu).
 *   - `currentUser.department`: Keycloak `department` claim'i. Kenar çubuğunda
 *     kullanıcının altında GÖRÜNEN değer budur.
 *
 * Bu modül saftır: React, Next.js, SQL veya environment bağımlılığı yoktur ve
 * hem sunucu (oturum yanıtı) hem istemci (kenar çubuğu) tarafından kullanılır.
 * Buradaki hiçbir alan YETKİLENDİRME kararında kullanılmaz; yetki yalnızca
 * Sicil üzerinden MR_UserRoles / proje erişim modelinden gelir.
 */

export const USER_DEPARTMENT_FALLBACK = 'Departman bilgisi yok';

function text(value) {
  if (value == null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? value.trim() : '';
}

function firstText(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return '';
}

/**
 * Kurumsal rehber kaydı ile doğrulanmış kimlik alanlarını birleştirir.
 * Kurumsal rehber görüntüleme alanlarında önceliklidir; claim'ler yalnızca
 * rehberde boş olan alanları tamamlar.
 */
export function buildSessionCurrentUser(directoryPerson = null, identity = null) {
  const sicil = directoryPerson?.employeeNo ?? directoryPerson?.id ?? identity?.sicil ?? null;
  const employeeNo = text(sicil);
  return {
    ...(directoryPerson || {}),
    id: text(directoryPerson?.id) || employeeNo || null,
    employeeNo: employeeNo || null,
    sicil: identity?.sicil ?? (/^\d+$/.test(employeeNo) ? Number(employeeNo) : null),
    name: firstText(directoryPerson?.name, identity?.name, employeeNo) || null,
    username: firstText(directoryPerson?.username, identity?.username) || null,
    givenName: text(identity?.firstName) || null,
    familyName: text(identity?.lastName) || null,
    email: text(identity?.email) || null,
    // Keycloak claim'leri — kenar çubuğu ve profil gösterimi içindir.
    department: text(identity?.department) || null,
    sector: text(identity?.sector) || null,
    managementUnit: text(identity?.mudurluk) || null,
    subject: text(identity?.subject) || null
  };
}

/**
 * Kenar çubuğunda gösterilecek departman metni.
 * Sıra: Keycloak `department` → kurumsal müdürlük → direktörlük → yedek metin.
 */
export function resolveUserDepartmentLabel(currentUser, { fallback = USER_DEPARTMENT_FALLBACK } = {}) {
  return firstText(
    currentUser?.department,
    currentUser?.organization?.department,
    currentUser?.organization?.directorate
  ) || fallback;
}

/** Kenar çubuğu ad satırı; ad yoksa kullanıcı adına, sonra Sicil'e düşer. */
export function resolveUserDisplayName(currentUser, { fallback = 'Kullanıcı' } = {}) {
  return firstText(currentUser?.name, currentUser?.username, currentUser?.employeeNo) || fallback;
}
