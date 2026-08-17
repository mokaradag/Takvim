import { isCorporateProject } from '../domain/projectTypes.js';
import { comparableTagName, normalizeProjectTags } from '../domain/tags/index.js';

const PROJECT_COLOR_KEYS = new Set(['blue', 'emerald', 'purple', 'amber', 'rose', 'cyan']);

function normalizedName(value) {
  return String(value || '').trim();
}

function comparableName(value) {
  return normalizedName(value).toLocaleLowerCase('tr-TR');
}

function normalizedProjectCode(value) {
  return normalizedName(value).toUpperCase();
}

// Etiket kataloğu artık alan modelinde yaşar: renk ve simge de etiketin
// parçasıdır. Eski çağrı yerleri için yeniden dışa aktarılır.
export { normalizeProjectTags };

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return !Number.isNaN(date.getTime())
    && date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day;
}

function resolveCalendarId(input = {}, calendars = []) {
  const requested = String(input.calendarId || '').trim();
  return requested || calendars[0]?.id || '';
}

function validationError(issues) {
  const first = issues[0];
  return {
    ok: false,
    error: {
      kind: 'domain',
      code: first.code,
      field: first.field,
      message: first.message,
      issues
    }
  };
}

export function validateProjectCreationInput(input = {}, { projects = [], people = [], calendars = [] } = {}) {
  const issues = [];
  const name = normalizedName(input.name || input.ProjeAdi);
  const code = normalizedProjectCode(input.code || input.ProjeKodu);
  const calendarId = resolveCalendarId(input, calendars);

  if (!name) {
    issues.push({ code: 'PROJECT_NAME_REQUIRED', field: 'name', message: 'Proje adı boş bırakılamaz.' });
  } else if (projects.some((project) => comparableName(project.name) === comparableName(name))) {
    issues.push({ code: 'PROJECT_NAME_DUPLICATE', field: 'name', message: 'Bu adda bir proje zaten bulunuyor.' });
  }

  if (code && projects.some((project) => normalizedProjectCode(project.code || project.ProjeKodu) === code)) {
    issues.push({ code: 'PROJECT_CODE_DUPLICATE', field: 'code', message: 'Bu proje kodu zaten kullanılıyor.' });
  }

  if (!input.leadId) {
    issues.push({ code: 'PROJECT_LEAD_REQUIRED', field: 'leadId', message: 'Proje sorumlusu seçilmelidir.' });
  } else if (!people.some((person) => person.id === input.leadId)) {
    issues.push({ code: 'PROJECT_LEAD_NOT_FOUND', field: 'leadId', message: 'Seçilen proje sorumlusu bulunamadı.' });
  }

  if (!calendarId || !calendars.some((calendar) => calendar.id === calendarId)) {
    issues.push({ code: 'PROJECT_CALENDAR_NOT_FOUND', field: 'calendarId', message: 'Kurumsal çalışma takvimi bulunamadı.' });
  }

  // Veri tarihi (ilerleme kesim tarihi) isteğe bağlıdır: proje, kesim tarihi
  // belirlenmeden de açılabilir ve daha sonra Proje Tanımı ekranından girilebilir.
  // Verildiğinde geçerli bir takvim tarihi olması beklenir.
  if (input.dataDate && !isValidIsoDate(input.dataDate)) {
    issues.push({ code: 'PROJECT_DATA_DATE_INVALID', field: 'dataDate', message: 'Veri tarihi geçerli bir tarih olmalıdır.' });
  }

  if (!PROJECT_COLOR_KEYS.has(input.color)) {
    issues.push({ code: 'PROJECT_COLOR_INVALID', field: 'color', message: 'Geçerli bir proje rengi seçilmelidir.' });
  }

  return issues;
}

export function prepareProjectCreation(input, context = {}, ids = {}) {
  if (context.canCreateProjects === false) {
    return validationError([{
      code: 'PROJECT_CREATE_FORBIDDEN',
      field: 'project',
      message: 'Bu oturumda manuel proje oluşturma yetkiniz bulunmuyor.'
    }]);
  }

  const projects = context.projects || [];
  const people = context.people || [];
  const calendars = context.calendars || [];
  const calendarId = resolveCalendarId(input, calendars);
  const normalizedInput = {
    ...input,
    name: normalizedName(input.name || input.ProjeAdi),
    code: normalizedProjectCode(input.code || input.ProjeKodu),
    calendarId
  };
  const issues = validateProjectCreationInput(normalizedInput, { projects, people, calendars });

  if (issues.length) return validationError(issues);

  const lead = people.find((person) => person.id === normalizedInput.leadId) || null;
  const project = {
    id: ids.projectId,
    code: normalizedInput.code,
    name: normalizedInput.name,
    source: normalizedInput.source || 'manual',
    color: normalizedInput.color,
    leadId: normalizedInput.leadId,
    lead: lead?.name || '',
    calendarId,
    dataDate: normalizedInput.dataDate,
    tags: normalizeProjectTags(normalizedInput.tags)
  };
  const rootWbs = {
    id: ids.rootWbsId,
    projectId: project.id,
    parentId: null,
    code: '1',
    name: project.name,
    sortOrder: 1
  };

  return {
    ok: true,
    project,
    rootWbs,
    changes: {
      projectUpserts: [project],
      wbsUpserts: [rootWbs]
    }
  };
}

export function prepareProjectUpdate(projectId, input, context = {}) {
  const projects = context.projects || [];
  const people = context.people || [];
  const calendars = context.calendars || [];
  const existing = projects.find((project) => project.id === projectId) || null;

  if (!existing) {
    return validationError([{ code: 'PROJECT_NOT_FOUND', field: 'projectId', message: 'Güncellenecek proje bulunamadı.' }]);
  }
  if (existing.accessLevel && existing.accessLevel !== 'FULL') {
    return validationError([{ code: 'PROJECT_WRITE_FORBIDDEN', field: 'projectId', message: 'Bu proje salt okunur görünürlükle açıldı ve değiştirilemez.' }]);
  }

  const sourceControlled = isCorporateProject(existing);
  const calendarId = input.calendarId === undefined
    ? existing.calendarId || resolveCalendarId(input, calendars)
    : String(input.calendarId || '').trim();
  const normalizedInput = {
    ...input,
    name: sourceControlled
      ? existing.name
      : normalizedName(input.name === undefined ? existing.name : input.name),
    code: sourceControlled
      ? normalizedProjectCode(existing.code)
      : normalizedProjectCode(input.code === undefined ? existing.code : input.code),
    source: sourceControlled ? existing.source : (input.source === undefined ? existing.source : input.source),
    // Kurumsal projenin sorumlusu kaynak sistemden (PROJECT_MANAGER rolü) gelir;
    // arayüzden gönderilen değer yok sayılır, sunucu da bu alanı korur.
    leadId: sourceControlled
      ? existing.leadId
      : (input.leadId === undefined ? existing.leadId : input.leadId),
    dataDate: input.dataDate === undefined ? existing.dataDate : input.dataDate,
    color: input.color === undefined ? existing.color : input.color,
    calendarId
  };
  const issues = validateProjectCreationInput(normalizedInput, {
    projects: projects.filter((project) => project.id !== projectId),
    people,
    calendars
  }).filter((issue) => {
    // Kurumsal projelerde sorumlu bilgisi kaynak sistemin sorumluluğundadır:
    // sorumlu tanımlı olmasa bile renk/etiket gibi MERGEN Rota alanları güncellenebilir.
    if (sourceControlled && (issue.code === 'PROJECT_LEAD_REQUIRED' || issue.code === 'PROJECT_LEAD_NOT_FOUND')) return false;
    if (input.leadId === undefined && !existing.leadId && issue.code === 'PROJECT_LEAD_REQUIRED') return false;
    return true;
  });

  if (issues.length) return validationError(issues);

  const lead = people.find((person) => person.id === normalizedInput.leadId) || null;
  return {
    ok: true,
    project: {
      ...existing,
      code: normalizedInput.code,
      name: normalizedInput.name,
      source: normalizedInput.source || existing.source || 'manual',
      color: normalizedInput.color,
      leadId: normalizedInput.leadId,
      lead: lead?.name || (input.leadId === undefined ? existing.lead || '' : ''),
      calendarId,
      dataDate: normalizedInput.dataDate,
      tags: normalizeProjectTags(normalizedInput.tags === undefined ? existing.tags : normalizedInput.tags)
    }
  };
}

export function prepareProjectUpdateChanges(projectId, input, context = {}) {
  const prepared = prepareProjectUpdate(projectId, input, context);
  if (!prepared.ok) return prepared;

  const projects = context.projects || [];
  const tasks = context.tasks || [];
  const wbs = context.wbs || [];
  const existing = projects.find((project) => project.id === projectId);
  const canonicalTags = new Map(
    (prepared.project.tags || []).map((tag) => [comparableTagName(tag.name), tag.name])
  );
  // Yeniden adlandırma çıkarımla bulunamaz (etiketin kalıcı bir kimliği yoktur);
  // arayüz eski→yeni eşlemesini açıkça gönderir ve görev etiketleri buna göre
  // taşınır. Aksi hâlde ad değiştirmek görevleri katalog dışında bırakırdı.
  const renames = new Map();
  for (const entry of Array.isArray(input.tagRenames) ? input.tagRenames : []) {
    const from = comparableTagName(entry?.from);
    const to = canonicalTags.get(comparableTagName(entry?.to));
    if (from && to && from !== comparableTagName(to)) renames.set(from, to);
  }

  const taskUpserts = tasks
    .filter((task) => task.projectId === projectId)
    .map((task) => {
      const key = comparableTagName(task.keyword);
      const nextKeyword = renames.get(key) || canonicalTags.get(key);
      const keywordChanged = Boolean(nextKeyword) && task.keyword !== nextKeyword;
      return keywordChanged ? { ...task, keyword: nextKeyword } : null;
    })
    .filter(Boolean);

  const rootWbs = wbs.find((node) => node.projectId === projectId && node.parentId == null) || null;
  const projectNameChanged = existing.name !== prepared.project.name;
  const rootTracksProjectName = rootWbs?.name === existing.name;
  const wbsUpserts = projectNameChanged && rootTracksProjectName
    ? [{ ...rootWbs, name: prepared.project.name }]
    : [];

  return {
    ...prepared,
    changes: {
      projectUpserts: [prepared.project],
      taskUpserts,
      wbsUpserts
    }
  };
}
