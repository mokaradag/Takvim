export const ARCHIVED_PROJECT_TYPE_CODES = new Set(['KF', 'KG', 'KP', 'KT', 'TF', 'TG', 'TP']);

export const PROJECT_TYPE_META = Object.freeze({
  GA: { name: 'Gruplararası Destek Faaliyetleri', icon: 'Users', order: 10 },
  GD: { name: 'Garanti dışı faaliyetler', icon: 'Alert', order: 20 },
  GI: { name: 'Garanti Dönemi İçindeki Proje', icon: 'Clock', order: 30 },
  GP: { name: 'Geliştirme projesi', icon: 'Sparkle', order: 40 },
  ID: { name: 'İdari faaliyetler', icon: 'Briefcase', order: 50 },
  KF: { name: 'Kapatılan Faaliyet', icon: 'Trash', order: 210 },
  KG: { name: 'Kapatılan Geliştirme Projesi', icon: 'Trash', order: 220 },
  KP: { name: 'Kapatılan Proje', icon: 'Trash', order: 230 },
  KT: { name: 'Kapatılan Tohum Projesi', icon: 'Trash', order: 240 },
  MG: { name: 'Muhtemel Geliştirme Projeleri', icon: 'TrendUp', order: 60 },
  MP: { name: 'Muhtemel Projeler', icon: 'TrendUp', order: 70 },
  SK: { name: 'Genel sabit kıymet tasarım ve üretim faaliyetleri', icon: 'Database', order: 80 },
  SP: { name: 'Sözleşmeli proje', icon: 'Briefcase', order: 90 },
  TF: { name: 'Tamamlanan Faaliyet', icon: 'Check', order: 250 },
  TG: { name: 'Tamamlanan Geliştirme Projesi', icon: 'Check', order: 260 },
  TH: { name: 'Tohum Projesi', icon: 'Sparkle', order: 100 },
  TP: { name: 'Tamamlanan Proje', icon: 'Check', order: 270 },
  TT: { name: 'TT', icon: 'Layers', order: 110 },
  UR: { name: 'Mevcut ürün/sistem idame faaliyetleri', icon: 'Settings', order: 120 }
});

const UNKNOWN_PROJECT_TYPE = Object.freeze({
  name: 'Diğer / sınıflandırılmamış',
  icon: 'Layers',
  order: 900
});

export function normalizeProjectTypeCode(value) {
  return String(value || '').trim().toUpperCase();
}

export function projectTypeMeta(code, fallbackName = '') {
  const normalized = normalizeProjectTypeCode(code);
  const known = PROJECT_TYPE_META[normalized];
  if (known) return { code: normalized, ...known, archived: ARCHIVED_PROJECT_TYPE_CODES.has(normalized) };
  return {
    code: normalized || 'DİĞER',
    ...UNKNOWN_PROJECT_TYPE,
    name: String(fallbackName || '').trim() || UNKNOWN_PROJECT_TYPE.name,
    archived: false
  };
}

/**
 * Kurumsal (kaynak sistemden beslenen) proje mi? Kurumsal projelerin adı, kodu,
 * sorumlusu ve iş dağılım ağacı MERGEN Rota üzerinden değiştirilemez.
 */
export function isCorporateProject(project) {
  return String(project?.source || project?.sourceType || '').toLowerCase() === 'corporate';
}

/** İş dağılım ağacı MERGEN Rota içinde düzenlenebilen proje mi? */
export function supportsManualWbsEditing(project) {
  return Boolean(project) && !isCorporateProject(project);
}

export function isArchivedProject(project) {
  return ARCHIVED_PROJECT_TYPE_CODES.has(normalizeProjectTypeCode(project?.projectTypeCode));
}

export function projectSearchText(project) {
  const type = projectTypeMeta(project?.projectTypeCode, project?.projectTypeName);
  return [project?.code, project?.name, type.code, type.name]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('tr-TR');
}

export function compareProjects(left, right) {
  const leftType = projectTypeMeta(left?.projectTypeCode, left?.projectTypeName);
  const rightType = projectTypeMeta(right?.projectTypeCode, right?.projectTypeName);
  return leftType.order - rightType.order
    || leftType.name.localeCompare(rightType.name, 'tr')
    || String(left?.code || '').localeCompare(String(right?.code || ''), 'tr', { numeric: true })
    || String(left?.name || '').localeCompare(String(right?.name || ''), 'tr');
}

export function visibleProjects(projects = [], { showArchived = false, query = '' } = {}) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase('tr-TR');
  return projects
    .filter((project) => showArchived || !isArchivedProject(project))
    .filter((project) => !normalizedQuery || projectSearchText(project).includes(normalizedQuery))
    .slice()
    .sort(compareProjects);
}

export function groupProjectsByType(projects = []) {
  const groups = new Map();
  for (const project of projects) {
    const meta = projectTypeMeta(project?.projectTypeCode, project?.projectTypeName);
    if (!groups.has(meta.code)) groups.set(meta.code, { ...meta, projects: [] });
    groups.get(meta.code).projects.push(project);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, projects: group.projects.slice().sort(compareProjects) }))
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name, 'tr'));
}
