import { organizationValue } from '../../domain/organization/organizationHierarchy.js';

export {
  applyOrgSelection,
  createEmptyOrgFilter,
  departmentKey,
  directorateKey,
  hasOrgSelection,
  matchesOrgFilter,
  orgKeyFor,
  orgKeyLabel,
  orgKeyParentLabel,
  orgLevelOptions,
  pruneOrgSelection,
  unitKey
} from '../../domain/organization/organizationHierarchy.js';

/**
 * Ekip sayfası süzgeç/sıralama ilkeleri — SAF fonksiyonlar.
 *
 * "Kurumsal ekip dizini" açılır listeleri ile tablo başlığı süzgeçleri TEK bir
 * durumu paylaşır:
 *
 *   { directorate: '', department: '', unit: '' }
 *
 * Her düzey yalnızca TEK değer taşır. Müdürlük ve birim değerleri farklı
 * üst kırılımlarda aynı ada sahip olabileceği için seçim, etiket değil KARARLI
 * BİR YOL ANAHTARI ile tutulur (`direktörlük > müdürlük > birim`). Böylece
 * iki farklı direktörlükteki aynı adlı müdürlük birbirine karışmaz.
 */

/* ── Sıralama ───────────────────────────────────────────── */

const TEXT_SORT_KEYS = new Set(['name', 'role', 'directorate', 'department', 'unit', 'upcoming']);

export function teamSortValue(row, key) {
  switch (key) {
    case 'name': return row.person?.name || '';
    case 'role': return row.person?.role || '';
    case 'directorate': return organizationValue(row.person, 'directorate');
    case 'department': return organizationValue(row.person, 'department');
    case 'unit': return organizationValue(row.person, 'unit');
    case 'upcoming': return row.upcomingSortValue || '';
    case 'total': return row.total;
    case 'active': return row.active;
    case 'late': return row.late;
    default: return null;
  }
}

/**
 * Türkçe yerel ayarla sıralama. Boş değerler yön ne olursa olsun SONA gider;
 * eşitlikte ad, sonra Sicil ile kararlı ikincil sıralama uygulanır.
 */
export function sortTeamRows(rows = [], sort = null) {
  const direction = sort?.dir === 'desc' ? -1 : 1;
  const key = sort?.key || 'name';
  const isText = TEXT_SORT_KEYS.has(key);

  return [...rows].sort((left, right) => {
    const a = teamSortValue(left, key);
    const b = teamSortValue(right, key);
    const aMissing = a == null || a === '';
    const bMissing = b == null || b === '';
    if (aMissing && !bMissing) return 1;
    if (!aMissing && bMissing) return -1;
    if (!aMissing && !bMissing) {
      const compared = isText
        ? String(a).localeCompare(String(b), 'tr')
        : (Number(a) - Number(b));
      if (compared !== 0) return compared * direction;
    }
    // Kararlı ikincil sıra: aynı değere sahip satırlar sıçramaz.
    const byName = String(left.person?.name || '').localeCompare(String(right.person?.name || ''), 'tr');
    if (byName !== 0) return byName;
    return String(left.person?.employeeNo || left.person?.id || '').localeCompare(String(right.person?.employeeNo || right.person?.id || ''), 'tr');
  });
}
