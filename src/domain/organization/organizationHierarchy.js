/**
 * Kurumsal hiyerarşinin ortak yol-anahtarı ve seçim ilkeleri.
 *
 * Görünen etiketler kimlik değildir. Aynı adlı müdürlük veya birim farklı üst
 * dallarda bulunabildiği için seçimler bütün kurumsal yolu taşıyan kararlı
 * anahtarlarla saklanır.
 */

export const UNASSIGNED_DIRECTORATE = '__unassigned__';
export const UNASSIGNED_DIRECTORATE_LABEL = 'Direktörlük tanımsız';
export const ORGANIZATION_PATH_SEPARATOR = '\u001F';

/** Kişinin kurumsal alanını boşlukları kırpılmış metin olarak döndürür. */
export function organizationValue(person, field) {
  return String(person?.organization?.[field] || '').trim();
}
export function createEmptyOrgFilter() {
  return { directorate: '', department: '', unit: '' };
}

/** Direktörlüğü olmayan personel de seçilebilir bir kurumsal kapsamdır. */
export function directorateKey(person) {
  return organizationValue(person, 'directorate') || UNASSIGNED_DIRECTORATE;
}

export function departmentKey(person) {
  const department = organizationValue(person, 'department');
  return department ? `${directorateKey(person)}${ORGANIZATION_PATH_SEPARATOR}${department}` : '';
}

export function unitKey(person) {
  const unit = organizationValue(person, 'unit');
  const department = departmentKey(person);
  return unit && department ? `${department}${ORGANIZATION_PATH_SEPARATOR}${unit}` : '';
}

export function orgKeyFor(person, level) {
  if (level === 'directorate') return directorateKey(person);
  if (level === 'department') return departmentKey(person);
  if (level === 'unit') return unitKey(person);
  return '';
}

/** Yol anahtarının son parçası kullanıcıya gösterilen etikettir. */
export function orgKeyLabel(key, level) {
  if (!key) return '';
  if (level === 'directorate') return key === UNASSIGNED_DIRECTORATE ? UNASSIGNED_DIRECTORATE_LABEL : key;
  const parts = String(key).split(ORGANIZATION_PATH_SEPARATOR);
  return parts[parts.length - 1] || '';
}

/** Aynı adlı alt kırılımları ayırt eden üst yol açıklaması. */
export function orgKeyParentLabel(key, level) {
  if (!key || level === 'directorate') return '';
  const parts = String(key).split(ORGANIZATION_PATH_SEPARATOR);
  return parts
    .slice(0, -1)
    .map((part, index) => (index === 0 && part === UNASSIGNED_DIRECTORATE ? UNASSIGNED_DIRECTORATE_LABEL : part))
    .filter(Boolean)
    .join(' / ');
}

function isDescendantKey(childKey, parentKey) {
  if (!parentKey) return true;
  if (!childKey) return false;
  return childKey === parentKey || childKey.startsWith(`${parentKey}${ORGANIZATION_PATH_SEPARATOR}`);
}

/** Seçili kurumsal yol kişiyle eşleşiyor mu? */
export function matchesOrgFilter(person, selection = createEmptyOrgFilter()) {
  if (selection.unit) return unitKey(person) === selection.unit;
  if (selection.department) return departmentKey(person) === selection.department;
  if (selection.directorate) return directorateKey(person) === selection.directorate;
  return true;
}

/** Eski tek direktörlük süzgeci için geriye uyumlu eşleşme. */
export function matchesDirectorateFilter(person, selection) {
  if (!selection) return true;
  return directorateKey(person) === selection;
}

/**
 * Bir düzey seçildiğinde üst yol türetilir; artık o yola ait olmayan alt
 * seçimler temizlenir.
 */
export function applyOrgSelection(selection, level, rawValue) {
  const value = String(rawValue || '');
  const next = { ...createEmptyOrgFilter(), ...selection };

  if (level === 'directorate') {
    next.directorate = value;
  } else if (level === 'department') {
    next.department = value;
    next.directorate = value ? value.split(ORGANIZATION_PATH_SEPARATOR)[0] : next.directorate;
  } else if (level === 'unit') {
    next.unit = value;
    if (value) {
      const parts = value.split(ORGANIZATION_PATH_SEPARATOR);
      next.directorate = parts[0] || '';
      next.department = parts.slice(0, 2).join(ORGANIZATION_PATH_SEPARATOR);
    }
  }
  return pruneOrgSelection(next);
}

/** Üst seçimle çelişen veya üstü temizlenmiş alt seçimleri kaldırır. */
export function pruneOrgSelection(selection = createEmptyOrgFilter()) {
  const next = { ...createEmptyOrgFilter(), ...selection };
  if (next.department && (!next.directorate || !isDescendantKey(next.department, next.directorate))) next.department = '';
  if (next.unit && (!next.department || !isDescendantKey(next.unit, next.department))) next.unit = '';
  return next;
}

export function hasOrgSelection(selection = createEmptyOrgFilter()) {
  return Boolean(selection.directorate || selection.department || selection.unit);
}

export function sameOrgSelection(left = createEmptyOrgFilter(), right = createEmptyOrgFilter()) {
  return left.directorate === right.directorate
    && left.department === right.department
    && left.unit === right.unit;
}

/** Üst seçime göre hiyerarşik olarak daraltılmış seçenek listesi. */
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
  return [...keys.values()].sort((left, right) => (
    left.label.localeCompare(right.label, 'tr') || left.value.localeCompare(right.value, 'tr')
  ));
}

/**
 * Yenilenen projeksiyonda artık bulunmayan seçimi en yakın geçerli üst kapsama
 * indirger. Böylece veri yenilemesi geçerli seçimi korur, geçersiz alt yolu ise
 * görünmez biçimde etkin bırakmaz.
 */
export function pruneOrgSelectionForPeople(selection, people = []) {
  const next = pruneOrgSelection(selection);
  if (!next.directorate) return next;

  const directorates = new Set(people.map(directorateKey));
  if (!directorates.has(next.directorate)) return createEmptyOrgFilter();

  if (next.department) {
    const departments = new Set(people.map(departmentKey).filter(Boolean));
    if (!departments.has(next.department)) return { ...next, department: '', unit: '' };
  }

  if (next.unit) {
    const units = new Set(people.map(unitKey).filter(Boolean));
    if (!units.has(next.unit)) return { ...next, unit: '' };
  }
  return next;
}
