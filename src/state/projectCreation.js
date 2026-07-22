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

export function validateProjectCreationInput(input = {}, { projects = [], people = [], calendars = [] } = {}) {
  const issues = [];
  const name = normalizedName(input.name);

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

  if (!input.calendarId) {
    issues.push({ code: 'PROJECT_CALENDAR_REQUIRED', field: 'calendarId', message: 'Proje takvimi seçilmelidir.' });
  } else if (!calendars.some((calendar) => calendar.id === input.calendarId)) {
    issues.push({ code: 'PROJECT_CALENDAR_NOT_FOUND', field: 'calendarId', message: 'Seçilen proje takvimi bulunamadı.' });
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
  const issues = validateProjectCreationInput(input, { projects, people, calendars });

  if (issues.length) {
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

  const lead = people.find((person) => person.id === input.leadId) || null;
  const project = {
    id: ids.projectId,
    name: normalizedName(input.name),
    color: input.color,
    leadId: input.leadId,
    lead: lead?.name || '',
    calendarId: input.calendarId,
    dataDate: input.dataDate
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
