import { UNASSIGNED_DIRECTORATE, UNASSIGNED_DIRECTORATE_LABEL, organizationValue } from './teamDirectoryPolicy.js';

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

const PATH_SEPARATOR = '\u001F';

export function createEmptyOrgFilter() {
  return { directorate: '', department: '', unit: '' };
}

/** Direktörlüğü olmayan personel birinci sınıf bir seçenektir. */
export function directorateKey(person) {
  return organizationValue(person, 'directorate') || UNASSIGNED_DIRECTORATE;
}

export function departmentKey(person) {
  const department = organizationValue(person, 'department');
  return department ? `${directorateKey(person)}${PATH_SEPARATOR}${department}` : '';
}

export function unitKey(person) {
  const unit = organizationValue(person, 'unit');
  const department = departmentKey(person);
  return unit && department ? `${department}${PATH_SEPARATOR}${unit}` : '';
}

export function orgKeyFor(person, level) {
  if (level === 'directorate') return directorateKey(person);
  if (level === 'department') return departmentKey(person);
  if (level === 'unit') return unitKey(person);
  return '';
}

/** Yol anahtarının son parçası görüntülenecek etikettir. */
export function orgKeyLabel(key, level) {
  if (!key) return '';
  if (level === 'directorate') return key === UNASSIGNED_DIRECTORATE ? UNASSIGNED_DIRECTORATE_LABEL : key;
  const parts = String(key).split(PATH_SEPARATOR);
  return parts[parts.length - 1] || '';
}

/** Seçeneğin hangi üst kırılıma ait olduğunu açıklayan ikincil metin. */
export function orgKeyParentLabel(key, level) {
  if (!key || level === 'directorate') return '';
  const parts = String(key).split(PATH_SEPARATOR);
  const parents = parts.slice(0, -1).map((part, index) => (index === 0 && part === UNASSIGNED_DIRECTORATE ? UNASSIGNED_DIRECTORATE_LABEL : part));
  return parents.filter(Boolean).join(' / ');
}

function isDescendantKey(childKey, parentKey) {
  if (!parentKey) return true;
  if (!childKey) return false;
  return childKey === parentKey || childKey.startsWith(`${parentKey}${PATH_SEPARATOR}`);
}

/** Seçili kırılım yolu kişiyle eşleşiyor mu? */
export function matchesOrgFilter(person, selection = createEmptyOrgFilter()) {
  if (selection.unit) return unitKey(person) === selection.unit;
  if (selection.department) return departmentKey(person) === selection.department;
  if (selection.directorate) return directorateKey(person) === selection.directorate;
  return true;
}

/**
 * Bir düzeyde seçim yapıldığında hiyerarşi bütünlüğü korunur:
 * üst düzeyler otomatik doldurulur, artık geçersiz kalan alt düzeyler temizlenir.
 */
export function applyOrgSelection(selection, level, rawValue) {
  const value = String(rawValue || '');
  const next = { ...createEmptyOrgFilter(), ...selection };

  if (level === 'directorate') {
    next.directorate = value;
  } else if (level === 'department') {
    next.department = value;
    // Müdürlük yol anahtarı üst direktörlüğü zaten taşır: üstteki açılır liste
    // de bu seçimi yansıtmalıdır.
    next.directorate = value ? value.split(PATH_SEPARATOR)[0] : next.directorate;
  } else if (level === 'unit') {
    next.unit = value;
    if (value) {
      const parts = value.split(PATH_SEPARATOR);
      next.directorate = parts[0] || '';
      next.department = parts.slice(0, 2).join(PATH_SEPARATOR);
    }
  }
  return pruneOrgSelection(next);
}

/**
 * Üst düzeyle uyumsuz kalan alt düzey seçimleri sessizce açık kalmaz.
 *
 * Bir üst düzey TEMİZLENDİĞİNDE alt düzey de temizlenir: "tüm müdürlükler"
 * seçiliyken tek bir birimin gizlice açık kalması çelişkili bir durumdur.
 */
export function pruneOrgSelection(selection = createEmptyOrgFilter()) {
  const next = { ...createEmptyOrgFilter(), ...selection };
  if (next.department && (!next.directorate || !isDescendantKey(next.department, next.directorate))) next.department = '';
  if (next.unit && (!next.department || !isDescendantKey(next.unit, next.department))) next.unit = '';
  return next;
}

export function hasOrgSelection(selection = createEmptyOrgFilter()) {
  return Boolean(selection.directorate || selection.department || selection.unit);
}

/**
 * Bir düzeydeki seçilebilir değerler. Üst düzey seçiliyse yalnızca o dalın
 * altındaki değerler listelenir (hiyerarşik daraltma).
 */
export function orgLevelOptions(people = [], level, selection = createEmptyOrgFilter()) {
  const parentSelection = level === 'directorate'
    ? createEmptyOrgFilter()
    : level === 'department'
      ? { ...createEmptyOrgFilter(), directorate: selection.directorate }
      : { ...createEmptyOrgFilter(), directorate: selection.directorate, department: selection.department };

  const keys = new Map();
  for (const person of people) {
    if (!matchesOrgFilter(person, parentSelection)) continue;
    const key = orgKeyFor(person, level);
    if (!key || keys.has(key)) continue;
    keys.set(key, { value: key, label: orgKeyLabel(key, level), description: orgKeyParentLabel(key, level) });
  }
  return [...keys.values()].sort((left, right) => left.label.localeCompare(right.label, 'tr'));
}

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
