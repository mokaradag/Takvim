const PROJECT_COLOR_KEYS = new Set(['blue', 'emerald', 'purple', 'amber', 'rose', 'cyan']);

function normalizedName(value) {
  return String(value || '').trim();
}

function comparableName(value) {
  return normalizedName(value).toLocaleLowerCase('tr-TR');
}

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
  const name = normalizedName(input.name);
  const calendarId = resolveCalendarId(input, calendars);

  if (!name) {
    issues.push({ code: 'PROJECT_NAME_REQUIRED', field: 'name', message: 'Proje adı boş bırakılamaz.' });
  } else if (projects.some((project) => comparableName(project.name) === comparableName(name))) {
    issues.push({ code: 'PROJECT_NAME_DUPLICATE', field: 'name', message: 'Bu adda bir proje zaten bulunuyor.' });
  }

  if (!input.leadId) {
    issues.push({ code: 'PROJECT_LEAD_REQUIRED', field: 'leadId', message: 'Proje sorumlusu seçilmelidir.' });
  } else if (!people.some((person) => person.id === input.leadId)) {
    issues.push({ code: 'PROJECT_LEAD_NOT_FOUND', field: 'leadId', message: 'Seçilen proje sorumlusu bulunamadı.' });
  }

  if (!calendarId || !calendars.some((calendar) => calendar.id === calendarId)) {
    issues.push({ code: 'PROJECT_CALENDAR_NOT_FOUND', field: 'calendarId', message: 'Kurumsal çalışma takvimi bulunamadı.' });
  }

  if (!input.dataDate) {
    issues.push({ code: 'PROJECT_DATA_DATE_REQUIRED', field: 'dataDate', message: 'Veri tarihi seçilmelidir.' });
  } else if (!isValidIsoDate(input.dataDate)) {
    issues.push({ code: 'PROJECT_DATA_DATE_INVALID', field: 'dataDate', message: 'Veri tarihi geçerli bir tarih olmalıdır.' });
  }

  if (!PROJECT_COLOR_KEYS.has(input.color)) {
    issues.push({ code: 'PROJECT_COLOR_INVALID', field: 'color', message: 'Geçerli bir proje rengi seçilmelidir.' });
  }

  return issues;
}

function nextRootCode(wbs = []) {
  const max = wbs
    .filter((node) => node.parentId == null)
    .reduce((current, node) => {
      const numeric = Number.parseInt(String(node.code || ''), 10);
      return Number.isFinite(numeric) ? Math.max(current, numeric) : current;
    }, 0);
  return String(max + 1);
}

export function prepareProjectCreation(input, context = {}, ids = {}) {
  const projects = context.projects || [];
  const people = context.people || [];
  const calendars = context.calendars || [];
  const wbs = context.wbs || [];
  const calendarId = resolveCalendarId(input, calendars);
  const normalizedInput = { ...input, calendarId };
  const issues = validateProjectCreationInput(normalizedInput, { projects, people, calendars });

  if (issues.length) return validationError(issues);

  const lead = people.find((person) => person.id === normalizedInput.leadId) || null;
  const project = {
    id: ids.projectId,
    name: normalizedName(normalizedInput.name),
    color: normalizedInput.color,
    leadId: normalizedInput.leadId,
    lead: lead?.name || '',
    calendarId,
    dataDate: normalizedInput.dataDate
  };
  const rootWbs = {
    id: ids.rootWbsId,
    projectId: project.id,
    parentId: null,
    code: nextRootCode(wbs),
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

  const calendarId = existing.calendarId || resolveCalendarId(input, calendars);
  const normalizedInput = { ...input, calendarId };
  const issues = validateProjectCreationInput(normalizedInput, {
    projects: projects.filter((project) => project.id !== projectId),
    people,
    calendars
  });

  if (issues.length) return validationError(issues);

  const lead = people.find((person) => person.id === normalizedInput.leadId) || null;
  return {
    ok: true,
    project: {
      ...existing,
      name: normalizedName(normalizedInput.name),
      color: normalizedInput.color,
      leadId: normalizedInput.leadId,
      lead: lead?.name || '',
      calendarId,
      dataDate: normalizedInput.dataDate
    }
  };
}
