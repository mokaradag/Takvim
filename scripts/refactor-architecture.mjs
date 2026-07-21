import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const resolve = (rel) => path.join(root, rel);
const read = (rel) => fs.readFileSync(resolve(rel), 'utf8');
const write = (rel, content) => {
  fs.mkdirSync(path.dirname(resolve(rel)), { recursive: true });
  fs.writeFileSync(resolve(rel), content.replace(/\r\n/g, '\n').trimEnd() + '\n');
};
const remove = (rel) => fs.rmSync(resolve(rel), { force: true });

function segment(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing start marker: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  if (endMarker && end < 0) throw new Error(`Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function hasToken(source, token) {
  return new RegExp(`\\b${token.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`).test(source);
}

function namedImport(source, symbols, from) {
  const used = symbols.filter((symbol) => hasToken(source, symbol));
  return used.length ? `import { ${used.join(', ')} } from '${from}';` : '';
}

function reactImport(source, family) {
  const aliasSpecs = family === 'a'
    ? [['useState1', 'useState as useState1'], ['useMemo1', 'useMemo as useMemo1']]
    : [['useState2', 'useState as useState2'], ['useMemo2', 'useMemo as useMemo2'], ['useEffect2', 'useEffect as useEffect2'], ['useRef2', 'useRef as useRef2']];
  const specs = aliasSpecs.filter(([token]) => hasToken(source, token)).map(([, spec]) => spec);
  const needsDefault = source.includes('React.');
  if (!needsDefault && !specs.length) return '';
  if (needsDefault && specs.length) return `import React, { ${specs.join(', ')} } from 'react';`;
  if (needsDefault) return `import React from 'react';`;
  return `import { ${specs.join(', ')} } from 'react';`;
}

const DATE_SYMBOLS = [
  'TR_MONTHS', 'TR_MONTHS_LONG', 'TR_DAYS', 'parseDate', 'fmtISO', 'fmt', 'addDays', 'diffDays',
  'startOfMonth', 'endOfMonth', 'startOfWeek', 'endOfWeek', 'isSameDay', 'isWeekend', 'today', 'eachDay'
];
const CALENDAR_SYMBOLS = ['HOLIDAYS', 'holidayFor'];
const DEP_SYMBOLS = ['REL_TYPES', 'depId', 'relTypeOf', 'normalizeDependency'];
const METRIC_SYMBOLS = ['getTaskDateRange', 'getGroupScheduleSummaries', 'taskDurationDays', 'getStatus', 'selectTaskStats'];
const DOMAIN_SYMBOLS = ['PRIORITIES', 'TASK_STATUSES'];
const COLOR_SYMBOLS = ['COLOR_MAP', 'projectColorVar', 'projectColorKey', 'personColorVar', 'personInitials'];
const UI_SYMBOLS = ['Avatar', 'AvatarStack', 'Kw', 'StatusPill', 'StatusIcon', 'HeroHeader', 'Donut', 'BarRows', 'AreaChart'];
const EXTRA_SYMBOLS = ['Tooltip', 'InfoButton', 'CardHead', 'AnimatedNumber', 'FilterableTH', 'HoverListCard', 'ColumnFilter', 'dateMatchesFilter', 'numericMatchesFilter'];
const STATE_SYMBOLS = ['useTasks', 'useProjects', 'usePeople', 'useWbs', 'useTaskActions', 'useSelectedTask', 'useTaskStats'];

function featureFile(body, family = 'a') {
  const imports = [
    reactImport(body, family),
    hasToken(body, 'Icons') ? `import { Icons } from '../../components/icons';` : '',
    namedImport(body, DOMAIN_SYMBOLS, '../../domain/constants'),
    namedImport(body, DATE_SYMBOLS, '../../scheduling/dates'),
    namedImport(body, CALENDAR_SYMBOLS, '../../scheduling/calendars'),
    namedImport(body, DEP_SYMBOLS, '../../scheduling/dependencies'),
    namedImport(body, METRIC_SYMBOLS, '../../scheduling/metrics'),
    namedImport(body, COLOR_SYMBOLS, '../../lib/colors'),
    namedImport(body, UI_SYMBOLS, '../../components/ui'),
    namedImport(body, EXTRA_SYMBOLS, '../../components/ui-extras'),
    hasToken(body, 'appZoom') ? `import { appZoom } from '../../lib/zoom';` : '',
    namedImport(body, STATE_SYMBOLS, '../../state/hooks')
  ].filter(Boolean);
  return `'use client';\n${imports.join('\n')}\n\n${body.trim()}\n`;
}

function replaceMainSignature(body, oldName, replacement) {
  const re = new RegExp(`export function ${oldName}\\([^)]*\\) \\{`);
  if (!re.test(body)) throw new Error(`Could not find component signature for ${oldName}`);
  return body.replace(re, replacement);
}

// -----------------------------------------------------------------------------
// Domain layer
// -----------------------------------------------------------------------------
write('src/domain/models/index.js', `/**
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} name
 * @property {string} color
 * @property {string|null} [leadId]
 * @property {string} [lead] Legacy display field retained for the current UI.
 */

/**
 * @typedef {Object} Person
 * @property {string} id
 * @property {string} name
 * @property {string} role
 * @property {string} team
 * @property {string} color
 */

/**
 * @typedef {Object} WbsNode
 * @property {string} id
 * @property {string} projectId
 * @property {string|null} parentId
 * @property {string} code
 * @property {string} name
 */

/**
 * Canonical dependency shape. The legacy id field is retained by the mock adapter
 * while the UI transition is in progress; predecessorId is the stable relationship key.
 * @typedef {Object} Dependency
 * @property {string} predecessorId
 * @property {'FS'|'SS'|'FF'|'SF'} type
 * @property {number} lagDays
 * @property {string} [id]
 */

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string|null} projectId
 * @property {string[]} assigneeIds
 * @property {string|null} wbsId
 * @property {Dependency[]} deps
 * @property {string} task
 * @property {string} status
 * @property {string} baslangicTarihi
 * @property {string} bitisTarihi
 * @property {string} hedefTarih
 * @property {string} [proje] Legacy display field retained for the current UI.
 * @property {string[]} [sorumlu] Legacy display field retained for the current UI.
 */

export const DOMAIN_MODEL_VERSION = 1;
`);

write('src/domain/constants/index.js', `export const TASK_STATUSES = Object.freeze({
  TODO: 'todo',
  IN_PROGRESS: 'in_progress',
  DONE: 'done'
});

export const PRIORITIES = Object.freeze({
  critical: { id: 'critical', label: 'Kritik', color: 'var(--status-overdue)', order: 0 },
  high: { id: 'high', label: 'Yüksek', color: 'oklch(70% 0.16 50)', order: 1 },
  medium: { id: 'medium', label: 'Orta', color: 'oklch(70% 0.13 200)', order: 2 },
  low: { id: 'low', label: 'Düşük', color: 'var(--text-dim)', order: 3 }
});
`);

write('src/domain/selectors/index.js', `export function selectTaskById(tasks, taskId) {
  return tasks.find((task) => task.id === taskId) || null;
}

export function selectTasksByProject(tasks, projectId) {
  return tasks.filter((task) => task.projectId === projectId);
}

export function selectTasksByPerson(tasks, personId) {
  return tasks.filter((task) => (task.assigneeIds || []).includes(personId));
}

export function selectProjectById(projects, projectId) {
  return projects.find((project) => project.id === projectId) || null;
}

export function selectPersonById(people, personId) {
  return people.find((person) => person.id === personId) || null;
}
`);

write('src/domain/validation/index.js', `function indexByName(items) {
  return new Map(items.map((item) => [item.name, item]));
}

export function normalizeProjectReferences(project, people) {
  const peopleByName = indexByName(people);
  return {
    ...project,
    leadId: project.leadId || peopleByName.get(project.lead)?.id || null
  };
}

export function normalizeTaskReferences(task, { projects, people, wbs }) {
  const project = projects.find((item) => item.id === task.projectId || item.name === task.proje) || null;
  const peopleByName = indexByName(people);
  const peopleById = new Map(people.map((item) => [item.id, item]));

  const assigneeIds = task.assigneeIds?.length
    ? task.assigneeIds.filter((id) => peopleById.has(id))
    : (task.sorumlu || []).map((name) => peopleByName.get(name)?.id).filter(Boolean);
  const assigneeNames = task.sorumlu?.length
    ? task.sorumlu
    : assigneeIds.map((id) => peopleById.get(id)?.name).filter(Boolean);
  const projectWbs = wbs.find((node) => node.projectId === project?.id && node.parentId == null) || null;

  return {
    ...task,
    projectId: project?.id || task.projectId || null,
    proje: task.proje || project?.name || '',
    assigneeIds,
    sorumlu: assigneeNames,
    wbsId: task.wbsId || projectWbs?.id || null,
    deps: task.deps || []
  };
}
`);

// -----------------------------------------------------------------------------
// Scheduling layer
// -----------------------------------------------------------------------------
write('src/scheduling/dates/index.js', `const MS_DAY = 86400000;

export const TR_MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
export const TR_MONTHS_LONG = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
export const TR_DAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];

export function parseDate(value) {
  if (value instanceof Date) return value;
  if (!value) return new Date();
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function fmtISO(value) {
  const date = value instanceof Date ? value : parseDate(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return \`${'${year}'}-${'${month}'}-${'${day}'}\`;
}

export function fmt(value, pattern = 'dd MMM') {
  const date = parseDate(value);
  const day = String(date.getDate()).padStart(2, '0');
  const dayShort = date.getDate();
  if (pattern === 'dd MMM') return \`${'${day}'} ${'${TR_MONTHS[date.getMonth()]}'}\`;
  if (pattern === 'dd MMM yyyy') return \`${'${day}'} ${'${TR_MONTHS[date.getMonth()]}'} ${'${date.getFullYear()}'}\`;
  if (pattern === 'MMM yyyy') return \`${'${TR_MONTHS_LONG[date.getMonth()]}'} ${'${date.getFullYear()}'}\`;
  if (pattern === 'd') return String(dayShort);
  if (pattern === 'EEE d') return \`${'${TR_DAYS[(date.getDay() + 6) % 7]}'} ${'${dayShort}'}\`;
  return date.toLocaleDateString('tr-TR');
}

export function addDays(value, amount) {
  const date = parseDate(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

export function diffDays(a, b) {
  return Math.round((parseDate(a).getTime() - parseDate(b).getTime()) / MS_DAY);
}

export function startOfMonth(value) {
  const date = parseDate(value);
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function endOfMonth(value) {
  const date = parseDate(value);
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

export function startOfWeek(value) {
  const date = parseDate(value);
  return addDays(date, -((date.getDay() + 6) % 7));
}

export function endOfWeek(value) {
  return addDays(startOfWeek(value), 6);
}

export function isSameDay(a, b) {
  const left = parseDate(a);
  const right = parseDate(b);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

export function isWeekend(value) {
  const day = parseDate(value).getDay();
  return day === 0 || day === 6;
}

export function today() {
  const value = new Date();
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function eachDay(start, end) {
  const days = [];
  let current = parseDate(start);
  const last = parseDate(end);
  while (current <= last) {
    days.push(new Date(current));
    current = addDays(current, 1);
  }
  return days;
}
`);

write('src/scheduling/calendars/index.js', `import { isWeekend, parseDate } from '../dates';

export const HOLIDAYS = [
  { date: '01-01', name: 'Yılbaşı', short: 'Yılbaşı' },
  { date: '04-23', name: 'Ulusal Egemenlik ve Çocuk Bayramı', short: '23 Nisan' },
  { date: '05-01', name: 'Emek ve Dayanışma Günü', short: '1 Mayıs' },
  { date: '05-19', name: 'Atatürk’ü Anma, Gençlik ve Spor Bayramı', short: '19 Mayıs' },
  { date: '07-15', name: 'Demokrasi ve Milli Birlik Günü', short: '15 Temmuz' },
  { date: '08-30', name: 'Zafer Bayramı', short: '30 Ağustos' },
  { date: '10-29', name: 'Cumhuriyet Bayramı', short: '29 Ekim' },
  { date: '03-20', name: 'Ramazan Bayramı (1. Gün)', short: 'Ramazan B.' },
  { date: '03-21', name: 'Ramazan Bayramı (2. Gün)', short: 'Ramazan B.' },
  { date: '03-22', name: 'Ramazan Bayramı (3. Gün)', short: 'Ramazan B.' },
  { date: '05-27', name: 'Kurban Bayramı (1. Gün)', short: 'Kurban B.' },
  { date: '05-28', name: 'Kurban Bayramı (2. Gün)', short: 'Kurban B.' },
  { date: '05-29', name: 'Kurban Bayramı (3. Gün)', short: 'Kurban B.' },
  { date: '05-30', name: 'Kurban Bayramı (4. Gün)', short: 'Kurban B.' }
];

export function holidayFor(value) {
  const date = parseDate(value);
  const key = \`${'${String(date.getMonth() + 1).padStart(2, \'0\')}'}-${'${String(date.getDate()).padStart(2, \'0\')}'}\`;
  return HOLIDAYS.find((holiday) => holiday.date === key) || null;
}

export function isWorkingDay(value) {
  return !isWeekend(value) && !holidayFor(value);
}
`);

write('src/scheduling/dependencies/index.js', `export const REL_TYPES = Object.freeze({
  FS: {
    code: 'FS', name: 'Bitiş → Başlangıç', short: 'Finish-to-Start',
    description: 'Önceki görev bitmeden bu görev başlayamaz. En sık kullanılan ilişki türüdür.',
    example: 'Tasarım onaylanmadan kodlama başlatılamaz.'
  },
  SS: {
    code: 'SS', name: 'Başlangıç → Başlangıç', short: 'Start-to-Start',
    description: 'Önceki görev başlamadan bu görev de başlayamaz. Görevler birlikte başlar, paralel ilerler.',
    example: 'Belgeleme, geliştirme ile birlikte başlar.'
  },
  FF: {
    code: 'FF', name: 'Bitiş → Bitiş', short: 'Finish-to-Finish',
    description: 'Önceki görev bitmeden bu görev de bitemez. Görevler birlikte tamamlanır.',
    example: 'Test, geliştirme ile birlikte tamamlanır.'
  },
  SF: {
    code: 'SF', name: 'Başlangıç → Bitiş', short: 'Start-to-Finish',
    description: 'Önceki görev başlamadan bu görev bitemez. Nadiren kullanılır; vardiya/devir senaryolarında görülür.',
    example: 'Yeni sistem devreye girene kadar eski sistem kapatılamaz.'
  }
});

export function depId(dependency) {
  if (typeof dependency === 'string') return dependency;
  return dependency?.predecessorId || dependency?.id || null;
}

export function relTypeOf(dependency) {
  if (typeof dependency === 'string') return 'FS';
  const type = dependency?.type || 'FS';
  return REL_TYPES[type] ? type : 'FS';
}

export function normalizeDependency(dependency) {
  const predecessorId = depId(dependency);
  const type = relTypeOf(dependency);
  const lagDays = typeof dependency === 'object' && Number.isFinite(dependency?.lagDays) ? dependency.lagDays : 0;
  return { id: predecessorId, predecessorId, type, lagDays };
}
`);

write('src/scheduling/metrics/index.js', `import { addDays, diffDays, parseDate, today } from '../dates';

export function taskDurationDays(task) {
  return diffDays(task.bitisTarihi, task.baslangicTarihi) + 1;
}

export function getTaskDateRange(tasks, { paddingDays = 3, fallbackStart = today(), fallbackDays = 30 } = {}) {
  if (!tasks.length) return { start: fallbackStart, end: addDays(fallbackStart, fallbackDays) };
  let min = parseDate(tasks[0].baslangicTarihi);
  let max = parseDate(tasks[0].bitisTarihi);
  tasks.forEach((task) => {
    const start = parseDate(task.baslangicTarihi);
    const end = parseDate(task.bitisTarihi);
    if (start < min) min = start;
    if (end > max) max = end;
  });
  return { start: addDays(min, -paddingDays), end: addDays(max, paddingDays) };
}

export function getGroupScheduleSummaries(groups) {
  const summaries = {};
  groups.forEach(([groupName, items]) => {
    const scheduled = items.filter((task) => !task.milestone);
    if (!scheduled.length) {
      summaries[groupName] = null;
      return;
    }
    let start = parseDate(scheduled[0].baslangicTarihi);
    let end = parseDate(scheduled[0].bitisTarihi);
    let totalDuration = 0;
    let weightedProgress = 0;
    scheduled.forEach((task) => {
      const taskStart = parseDate(task.baslangicTarihi);
      const taskEnd = parseDate(task.bitisTarihi);
      if (taskStart < start) start = taskStart;
      if (taskEnd > end) end = taskEnd;
      const duration = taskDurationDays(task);
      const progress = task.progress != null ? task.progress : (task.status === 'done' ? 100 : 0);
      totalDuration += duration;
      weightedProgress += duration * progress;
    });
    summaries[groupName] = {
      start,
      end,
      progress: totalDuration ? Math.round(weightedProgress / totalDuration) : 0,
      items: items.length,
      done: items.filter((task) => task.status === 'done').length
    };
  });
  return summaries;
}

export function getStatus(task, referenceDate = today()) {
  if (task.status === 'done') return { id: 'done', label: 'Tamamlandı', cls: 'status-done' };
  if (task.hedefTarih && diffDays(task.hedefTarih, referenceDate) < 0) return { id: 'overdue', label: 'Geciken', cls: 'status-overdue' };
  if (task.status === 'in_progress') return { id: 'in_progress', label: 'Devam ediyor', cls: 'status-progress' };
  return { id: 'todo', label: 'Yapılacak', cls: 'status-todo' };
}

export function selectTaskStats(tasks, referenceDate = today()) {
  const done = tasks.filter((task) => task.status === 'done').length;
  const inProgress = tasks.filter((task) => task.status === 'in_progress').length;
  const todo = tasks.filter((task) => !task.status || task.status === 'todo').length;
  const overdue = tasks.filter((task) => task.status !== 'done' && diffDays(task.hedefTarih, referenceDate) < 0).length;
  return {
    total: tasks.length,
    active: inProgress + todo,
    inProgress,
    todo,
    done,
    overdue,
    compRate: tasks.length ? Math.round((done / tasks.length) * 100) : 0
  };
}
`);

// -----------------------------------------------------------------------------
// Presentation-only color helpers. They preserve the current mock palette while
// remaining independent from the data adapter.
// -----------------------------------------------------------------------------
write('src/lib/colors.js', `export const COLOR_MAP = Object.freeze({
  blue: 'var(--c-blue)',
  emerald: 'var(--c-emerald)',
  purple: 'var(--c-purple)',
  amber: 'var(--c-amber)',
  rose: 'var(--c-rose)',
  cyan: 'var(--c-cyan)'
});

const PROJECT_COLOR_KEYS = Object.freeze({
  'Web Sitesi Yenileme': 'blue',
  'Mobil Uygulama': 'purple',
  'Sosyal Medya': 'rose',
  'Veritabanı Göçü': 'amber',
  'Altyapı': 'cyan',
  'Marka Kimliği': 'emerald'
});

const PERSON_COLOR_KEYS = Object.freeze({
  'Ahmet Yılmaz': 'blue',
  'Mehmet Demir': 'purple',
  'Ayşe Kaya': 'emerald',
  'Elif Yıldız': 'rose',
  'Can Özkan': 'amber',
  'Zeynep Aydın': 'cyan',
  'Burak Şahin': 'purple'
});

const FALLBACK_KEYS = Object.keys(COLOR_MAP);
function deterministicColorKey(value) {
  const text = String(value || '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  return FALLBACK_KEYS[Math.abs(hash) % FALLBACK_KEYS.length] || 'blue';
}

export function projectColorKey(name) {
  return PROJECT_COLOR_KEYS[name] || deterministicColorKey(name);
}

export function projectColorVar(name) {
  return COLOR_MAP[projectColorKey(name)] || COLOR_MAP.blue;
}

export function personColorVar(name) {
  return COLOR_MAP[PERSON_COLOR_KEYS[name] || deterministicColorKey(name)] || COLOR_MAP.blue;
}

export function personInitials(name) {
  return String(name || '').split(' ').filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}
`);

// -----------------------------------------------------------------------------
// Data layer: preserve current mock data but normalize stable relationship IDs.
// -----------------------------------------------------------------------------
const oldData = read('src/lib/data.js');
let projectPeople = segment(oldData, 'export const PROJECTS =', '// Helper to build a date around today');
projectPeople = projectPeople
  .replace('export const PROJECTS =', 'const RAW_PROJECTS =')
  .replace('export const PEOPLE =', 'const RAW_PEOPLE =');
let rawTasks = segment(oldData, 'export const TASKS =', '// ── Priority metadata');
rawTasks = rawTasks.replace('export const TASKS =', 'const RAW_TASKS =');

write('src/data/mock/seed.js', `import { normalizeProjectReferences, normalizeTaskReferences } from '../../domain/validation';
import { normalizeDependency } from '../../scheduling/dependencies';
import { addDays, fmtISO, today } from '../../scheduling/dates';

${projectPeople.trim()}

function rel(days) {
  return fmtISO(addDays(today(), days));
}

${rawTasks.trim()}

export const PEOPLE = RAW_PEOPLE.map((person) => ({ ...person }));
export const PROJECTS = RAW_PROJECTS.map((project) => normalizeProjectReferences(project, PEOPLE));
export const WBS = PROJECTS.map((project, index) => ({
  id: \`wbs-${'${project.id}'}-root\`,
  projectId: project.id,
  parentId: null,
  code: String(index + 1),
  name: project.name
}));
export const TASKS = RAW_TASKS.map((task) => normalizeTaskReferences({
  ...task,
  deps: (task.deps || []).map(normalizeDependency)
}, { projects: PROJECTS, people: PEOPLE, wbs: WBS }));
`);

write('src/data/contracts/appRepository.js', `/**
 * @typedef {Object} AppDataSnapshot
 * @property {import('../../domain/models').Project[]} projects
 * @property {import('../../domain/models').Person[]} people
 * @property {import('../../domain/models').WbsNode[]} wbs
 * @property {import('../../domain/models').Task[]} tasks
 */

/**
 * Current repository contract. The mock implementation is synchronous because it
 * is an in-memory seed adapter. A future API/database adapter can replace this at
 * the state boundary without changing feature components.
 *
 * @typedef {Object} AppRepository
 * @property {() => AppDataSnapshot} getSnapshot
 */

export function assertAppRepository(repository) {
  if (!repository || typeof repository.getSnapshot !== 'function') {
    throw new Error('App repository must implement getSnapshot().');
  }
  return repository;
}
`);

write('src/data/mock/createMockRepository.js', `import { PEOPLE, PROJECTS, TASKS, WBS } from './seed';

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function createMockRepository(seed = { projects: PROJECTS, people: PEOPLE, wbs: WBS, tasks: TASKS }) {
  const snapshot = clone(seed);
  return {
    kind: 'mock',
    getSnapshot() {
      return clone(snapshot);
    }
  };
}
`);

write('src/data/index.js', `import { assertAppRepository } from './contracts/appRepository';
import { createMockRepository } from './mock/createMockRepository';

export { createMockRepository } from './mock/createMockRepository';
export const appRepository = assertAppRepository(createMockRepository());
`);

write('src/lib/data.js', `// Compatibility barrel for older imports. New feature code imports from the
// explicit domain, scheduling, data and presentation modules instead.
export { PRIORITIES, TASK_STATUSES } from '../domain/constants';
export * from '../scheduling/dates';
export * from '../scheduling/calendars';
export * from '../scheduling/dependencies';
export { getStatus, getTaskDateRange, getGroupScheduleSummaries, selectTaskStats, taskDurationDays } from '../scheduling/metrics';
export { COLOR_MAP, personColorVar, personInitials, projectColorKey, projectColorVar } from './colors';
export { PEOPLE, PROJECTS, TASKS, WBS } from '../data/mock/seed';
`);

// -----------------------------------------------------------------------------
// State layer
// -----------------------------------------------------------------------------
write('src/state/AppStateProvider.jsx', `'use client';
import { createContext, useCallback, useContext, useMemo, useReducer } from 'react';
import { appRepository } from '../data';
import { normalizeTaskReferences } from '../domain/validation';
import { addDays, fmtISO, today } from '../scheduling/dates';
import { normalizeDependency } from '../scheduling/dependencies';
import { selectTaskStats } from '../scheduling/metrics';

const AppStateContext = createContext(null);

function initState(repository) {
  const snapshot = repository.getSnapshot();
  return { ...snapshot, selectedTaskId: null };
}

function normalizeTask(task, state) {
  return normalizeTaskReferences({
    ...task,
    deps: (task.deps || []).map(normalizeDependency)
  }, state);
}

function reducer(state, action) {
  switch (action.type) {
    case 'task/add':
      return { ...state, tasks: [action.task, ...state.tasks], selectedTaskId: action.task.id };
    case 'task/update':
      return {
        ...state,
        tasks: state.tasks.map((task) => task.id === action.id ? normalizeTask({ ...task, ...action.patch }, state) : task)
      };
    case 'task/delete':
      return {
        ...state,
        tasks: state.tasks.filter((task) => task.id !== action.id),
        selectedTaskId: state.selectedTaskId === action.id ? null : state.selectedTaskId
      };
    case 'task/select':
      return { ...state, selectedTaskId: action.id || null };
    default:
      return state;
  }
}

export function AppStateProvider({ children, repository = appRepository }) {
  const [state, dispatch] = useReducer(reducer, repository, initState);

  const openTask = useCallback((taskOrId) => {
    dispatch({ type: 'task/select', id: typeof taskOrId === 'string' ? taskOrId : taskOrId?.id });
  }, []);
  const closeTask = useCallback(() => dispatch({ type: 'task/select', id: null }), []);
  const updateTask = useCallback((id, patch) => dispatch({ type: 'task/update', id, patch }), []);
  const deleteTask = useCallback((id) => dispatch({ type: 'task/delete', id }), []);
  const addTask = useCallback(() => {
    const project = state.projects[0];
    const person = state.people[0];
    const start = today();
    const task = normalizeTask({
      id: \`n-${'${Date.now()}'}\`,
      projectId: project?.id || null,
      proje: project?.name || '',
      task: 'Yeni görev',
      keyword: 'Yeni',
      assigneeIds: person ? [person.id] : [],
      sorumlu: person ? [person.name] : [],
      status: 'todo',
      baslangicTarihi: fmtISO(start),
      bitisTarihi: fmtISO(addDays(start, 5)),
      hedefTarih: fmtISO(addDays(start, 7)),
      color: project?.color || 'blue',
      deps: []
    }, state);
    dispatch({ type: 'task/add', task });
    return task;
  }, [state]);

  const selectedTask = useMemo(
    () => state.tasks.find((task) => task.id === state.selectedTaskId) || null,
    [state.tasks, state.selectedTaskId]
  );
  const taskStats = useMemo(() => selectTaskStats(state.tasks), [state.tasks]);
  const actions = useMemo(() => ({ openTask, closeTask, updateTask, deleteTask, addTask }), [openTask, closeTask, updateTask, deleteTask, addTask]);
  const value = useMemo(() => ({ ...state, selectedTask, taskStats, actions }), [state, selectedTask, taskStats, actions]);

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const value = useContext(AppStateContext);
  if (!value) throw new Error('useAppState must be used inside AppStateProvider.');
  return value;
}
`);

write('src/state/hooks/index.js', `'use client';
import { useAppState } from '../AppStateProvider';

export function useTasks() { return useAppState().tasks; }
export function useProjects() { return useAppState().projects; }
export function usePeople() { return useAppState().people; }
export function useWbs() { return useAppState().wbs; }
export function useSelectedTask() { return useAppState().selectedTask; }
export function useTaskStats() { return useAppState().taskStats; }
export function useTaskActions() { return useAppState().actions; }
`);

// -----------------------------------------------------------------------------
// Split feature modules from the old mixed view containers.
// -----------------------------------------------------------------------------
const viewsA = read('src/components/views-a.jsx');
const viewsB = read('src/components/views-b.jsx');

let dashboard = segment(viewsA, '/* ── Özet (Dashboard)', '/* ── Veri (Data table)');
dashboard = replaceMainSignature(
  dashboard,
  'OzetView',
  `export function DashboardView({ onNavigate }) {\n  const tasks = useTasks();\n  const { openTask: onOpenTask } = useTaskActions();`
);
write('src/features/dashboard/DashboardView.jsx', featureFile(dashboard, 'a'));

let tasksView = segment(viewsA, '/* ── Veri (Data table)', '/* ── Kişi (People) view');
tasksView = tasksView.replace(/\\bPROJECTS\\b/g, 'projects').replace(/\\bPEOPLE\\b/g, 'people');
tasksView = replaceMainSignature(
  tasksView,
  'VeriView',
  `export function TasksView() {\n  const tasks = useTasks();\n  const projects = useProjects();\n  const people = usePeople();\n  const { openTask: onOpenTask, updateTask: onUpdateTask, addTask: onAddTask, deleteTask: onDeleteTask } = useTaskActions();`
);
write('src/features/tasks/TasksView.jsx', featureFile(tasksView, 'a'));

let team = segment(viewsA, '/* ── Kişi (People) view', null);
team = team.replace(/\\bPEOPLE\\b/g, 'people');
team = replaceMainSignature(
  team,
  'KisiView',
  `export function TeamView() {\n  const tasks = useTasks();\n  const people = usePeople();\n  const { openTask: onOpenTask } = useTaskActions();`
);
write('src/features/team/TeamView.jsx', featureFile(team, 'a'));

let calendar = segment(viewsB, '/* ── Takvim (Calendar)', '/* ── Gantt');
calendar = calendar.replace(/\\bPEOPLE\\b/g, 'people');
calendar = replaceMainSignature(
  calendar,
  'TakvimView',
  `export function CalendarView({ t, setTweak }) {\n  const tasks = useTasks();\n  const { openTask: onOpenTask } = useTaskActions();`
);
write('src/features/calendar/CalendarView.jsx', featureFile(calendar, 'b'));

let gantt = segment(viewsB, '/* ── Gantt', '/* ── Kanban');
gantt = gantt.replace(/\\bPEOPLE\\b/g, 'people');
gantt = gantt.replace('const d = diffDays(t.bitisTarihi, t.baslangicTarihi) + 1;', 'const d = taskDurationDays(t);');
gantt = gantt.replace(
  /  \/\/ Determine date range[\s\S]*?  const days = useMemo2\(\(\) => eachDay\(range\.start, range\.end\), \[range\]\);/,
  `  // Stable task range calculation lives in the scheduling layer.\n  const range = useMemo2(() => getTaskDateRange(tasks, { paddingDays: 3, fallbackStart: today_ }), [tasks]);\n  const days = useMemo2(() => eachDay(range.start, range.end), [range]);`
);
gantt = gantt.replace(
  /  \/\/ Compute summary rollup per group:[\s\S]*?  \}, \[groups\]\);/,
  `  // Schedule rollups are pure and independently testable.\n  const groupSummaries = useMemo2(() => getGroupScheduleSummaries(groups), [groups]);`
);
gantt = replaceMainSignature(
  gantt,
  'GanttView',
  `export function GanttView() {\n  const tasks = useTasks();\n  const people = usePeople();\n  const { openTask: onOpenTask } = useTaskActions();`
);
write('src/features/gantt/GanttView.jsx', featureFile(gantt, 'b'));

let kanban = segment(viewsB, '/* ── Kanban', '/* ── Rapor (Reports)');
kanban = replaceMainSignature(
  kanban,
  'KanbanView',
  `export function KanbanView() {\n  const tasks = useTasks();\n  const { openTask: onOpenTask, updateTask: onUpdateTask } = useTaskActions();`
);
write('src/features/kanban/KanbanView.jsx', featureFile(kanban, 'b'));

let reports = segment(viewsB, '/* ── Rapor (Reports)', null);
reports = replaceMainSignature(
  reports,
  'RaporView',
  `export function ReportsView() {\n  const tasks = useTasks();`
);
write('src/features/reports/ReportsView.jsx', featureFile(reports, 'b'));

// Settings is already cohesive; move it into its feature area and fix relative imports.
const settings = read('src/components/settings.jsx')
  .replace("from './icons'", "from '../../components/icons'")
  .replace("from './ui'", "from '../../components/ui'")
  .replace("from '../lib/tweaks-defaults'", "from '../../lib/tweaks-defaults'");
write('src/features/settings/SettingsView.jsx', settings);

// -----------------------------------------------------------------------------
// Extract shell/detail helpers from the old AppShell and replace the shell itself.
// -----------------------------------------------------------------------------
const oldShell = read('src/components/AppShell.jsx');
let welcome = segment(oldShell, '/* ── Welcome / Onboarding screen', '/* ── App logo');
welcome = welcome.replace('function WelcomeScreen', 'export function WelcomeScreen');
write('src/components/shell/WelcomeScreen.jsx', `'use client';\nimport { Icons } from '../icons';\nimport { AppLogo } from './AppLogo';\n\n${welcome.trim()}\n`);

let logo = segment(oldShell, '/* ── App logo', '/* ── App shell');
logo = logo.replace('function AppLogo', 'export function AppLogo');
write('src/components/shell/AppLogo.jsx', `${logo.trim()}\n`);

let navigation = segment(oldShell, 'const NAV_ITEMS = [', '/* ── Detail drawer');
navigation = navigation.replace('const NAV_ITEMS', 'export const NAV_ITEMS').replace('const PAGE_META', 'export const PAGE_META');
write('src/components/shell/navigation.js', navigation);

let drawer = segment(oldShell, '/* ── Detail drawer', '/* ── Command palette');
drawer = drawer.replace(/\\bPEOPLE\\b/g, 'people').replace('function TaskDrawer', 'export function TaskDrawer');
drawer = drawer.replace(
  'export function TaskDrawer({ task, tasks, onClose, onUpdate, onDelete }) {',
  'export function TaskDrawer({ task, tasks, onClose, onUpdate, onDelete }) {\n  const people = usePeople();'
);
const drawerImports = [
  `import { useEffect, useState } from 'react';`,
  `import { Icons } from '../../components/icons';`,
  `import { REL_TYPES, depId, relTypeOf } from '../../scheduling/dependencies';`,
  `import { diffDays, today } from '../../scheduling/dates';`,
  `import { projectColorVar } from '../../lib/colors';`,
  `import { Avatar, Kw, StatusIcon, statusColorVar } from '../../components/ui';`,
  `import { InfoButton } from '../../components/ui-extras';`,
  `import { usePeople } from '../../state/hooks';`
];
write('src/features/task-detail/TaskDrawer.jsx', `'use client';\n${drawerImports.join('\n')}\n\n${drawer.trim()}\n`);

write('src/features/task-detail/TaskDetailOverlay.jsx', `'use client';
import { useSelectedTask, useTaskActions, useTasks } from '../../state/hooks';
import { TaskDrawer } from './TaskDrawer';

export function TaskDetailOverlay() {
  const task = useSelectedTask();
  const tasks = useTasks();
  const { closeTask, updateTask, deleteTask } = useTaskActions();
  if (!task) return null;
  return <TaskDrawer task={task} tasks={tasks} onClose={closeTask} onUpdate={updateTask} onDelete={deleteTask} />;
}
`);

let command = segment(oldShell, '/* ── Command palette', '/* ── App ─');
command = command.replace('function CmdK', 'export function CommandPalette');
write('src/components/shell/CommandPalette.jsx', `'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from '../icons';
import { NAV_ITEMS, PAGE_META } from './navigation';

${command.trim()}
`);

write('src/hooks/useApplyTweaks.js', `'use client';
import { useEffect } from 'react';

const ACCENT_PRESETS = {
  '#3b82f6': { fg: 'white' },
  '#8b5cf6': { fg: 'white' },
  '#f43f5e': { fg: 'white' },
  '#10b981': { fg: 'white' },
  '#f59e0b': { fg: 'black' },
  '#0ea5e9': { fg: 'white' }
};

export function useApplyTweaks(tweaks) {
  useEffect(() => {
    document.body.className = tweaks.theme === 'light' ? 'theme-light' : 'theme-dark';
  }, [tweaks.theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--accent', tweaks.accent);
    root.style.setProperty('--accent-strong', tweaks.accent);
    root.style.setProperty('--accent-soft', tweaks.accent + '20');
    root.style.setProperty('--accent-fg', (ACCENT_PRESETS[tweaks.accent] || {}).fg || 'white');
  }, [tweaks.accent]);

  useEffect(() => {
    const density = tweaks.density === 'compact' ? 0.85 : tweaks.density === 'spacious' ? 1.15 : 1;
    document.documentElement.style.setProperty('--density', String(density));
  }, [tweaks.density]);

  useEffect(() => {
    document.body.style.zoom = String(tweaks.fontScale || 1);
  }, [tweaks.fontScale]);

  useEffect(() => {
    document.body.classList.toggle('reduce-motion', !!tweaks.reduceMotion);
  }, [tweaks.reduceMotion]);

  useEffect(() => {
    document.body.classList.toggle('no-emblem', !tweaks.showEmblem);
  }, [tweaks.showEmblem]);
}
`);

write('src/components/shell/AppShell.jsx', `'use client';
import { useEffect, useMemo, useState } from 'react';
import { Icons } from '../icons';
import { Avatar, Heptagon } from '../ui';
import { InfoButton } from '../ui-extras';
import { DashboardView } from '../../features/dashboard/DashboardView';
import { TasksView } from '../../features/tasks/TasksView';
import { CalendarView } from '../../features/calendar/CalendarView';
import { GanttView } from '../../features/gantt/GanttView';
import { KanbanView } from '../../features/kanban/KanbanView';
import { ReportsView } from '../../features/reports/ReportsView';
import { TeamView } from '../../features/team/TeamView';
import { SettingsView } from '../../features/settings/SettingsView';
import { TaskDetailOverlay } from '../../features/task-detail/TaskDetailOverlay';
import { usePeople, useTaskActions, useTasks, useTaskStats } from '../../state/hooks';
import { useTweaks } from '../../hooks/useTweaks';
import { useApplyTweaks } from '../../hooks/useApplyTweaks';
import { TWEAK_DEFAULTS } from '../../lib/tweaks-defaults';
import { AppLogo } from './AppLogo';
import { CommandPalette } from './CommandPalette';
import { NAV_ITEMS, PAGE_META } from './navigation';
import { WelcomeScreen } from './WelcomeScreen';

export default function AppShell() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  useApplyTweaks(t);
  const tasks = useTasks();
  const people = usePeople();
  const stats = useTaskStats();
  const { openTask } = useTaskActions();

  const [view, setView] = useState(() => {
    const landing = TWEAK_DEFAULTS.landingView || 'ozet';
    return NAV_ITEMS.some((item) => item.id === landing) ? landing : 'ozet';
  });
  const [cmdOpen, setCmdOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(() => {
    try { return localStorage.getItem('mp_seen_welcome_v2') !== '1'; }
    catch { return true; }
  });
  const [hideWelcome, setHideWelcome] = useState(() => {
    try { return localStorage.getItem('mp_seen_welcome_v2') === '1'; }
    catch { return false; }
  });

  const closeWelcome = () => {
    setWelcomeOpen(false);
    try { if (hideWelcome) localStorage.setItem('mp_seen_welcome_v2', '1'); }
    catch {}
  };

  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCmdOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const totalsByView = useMemo(() => ({
    ozet: tasks.length,
    veri: tasks.length,
    takvim: null,
    gantt: tasks.length,
    kanban: tasks.length,
    rapor: null,
    kisi: people.length,
    ayarlar: null
  }), [tasks.length, people.length]);

  const renderView = () => {
    switch (view) {
      case 'ozet': return <DashboardView onNavigate={setView} />;
      case 'veri': return <TasksView />;
      case 'takvim': return <CalendarView t={t} setTweak={setTweak} />;
      case 'gantt': return <GanttView />;
      case 'kanban': return <KanbanView />;
      case 'rapor': return <ReportsView />;
      case 'kisi': return <TeamView />;
      case 'ayarlar': return <SettingsView t={t} setTweak={setTweak} />;
      default: return null;
    }
  };

  const meta = PAGE_META[view] || PAGE_META.ozet;

  return (
    <div className="app">
      <aside className="sidebar">
        <Heptagon variant="hept-sidebar" />
        <div className="sidebar-header">
          <AppLogo size={34} />
          <div className="col" style={{ gap: 0 }}>
            <div className="brand-name"><span>MERGEN</span><span className="brand-accent">Rota</span><span className="brand-dot" /></div>
            <div className="brand-sub">Proje Yönetimi</div>
          </div>
        </div>
        <button className="cmd-trigger" onClick={() => setCmdOpen(true)}>
          <Icons.Search size={13} />
          <span>Ara veya komut çalıştır...</span>
          <span className="kbd">Ctrl K</span>
        </button>

        <div className="sidebar-section-title">Çalışma alanı</div>
        <nav className="nav">
          {NAV_ITEMS.map((item) => {
            const Icon = Icons[item.icon];
            return (
              <button key={item.id} className={\`nav-item${'${view === item.id ? \' active\' : \'\'}'}\`} onClick={() => setView(item.id)}>
                <Icon className="nav-icon" size={15} />
                <span>{item.label}</span>
                {totalsByView[item.id] != null && <span className="nav-count">{totalsByView[item.id]}</span>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="user-chip">
            <Avatar name="Zeynep Aydın" size="md" />
            <div className="col" style={{ gap: 0, flex: 1, minWidth: 0 }}>
              <div className="name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Zeynep Aydın</div>
              <div className="role">Product Manager</div>
            </div>
          </div>
          <button className="icon-btn" onClick={() => setWelcomeOpen(true)} title="Yardım ve özet"><Icons.Help size={15} /></button>
          <button className="icon-btn" onClick={() => setTweak('theme', t.theme === 'light' ? 'dark' : 'light')} title="Tema">
            {t.theme === 'light' ? <Icons.Moon size={15} /> : <Icons.Sun size={15} />}
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <Heptagon variant="hept-topbar" />
          <div className="col" style={{ gap: 2 }}>
            <h1 className="hero-title">{meta.title}</h1>
            <div className="sub">{meta.sub}</div>
          </div>
          <div className="topbar-spacer" />
          {view === 'veri' && (
            <InfoButton title="Görevler" icon={<Icons.Table size={12} />}>
              <p>Tüm görevleri listele, filtrele ve düzenle. Sütun başlığına tıklayarak o sütuna özel sıralama ve filtre uygulayabilirsiniz.</p>
            </InfoButton>
          )}
        </header>
        <main className="content">{renderView()}</main>
      </div>

      <TaskDetailOverlay />
      {cmdOpen && (
        <CommandPalette
          onClose={() => setCmdOpen(false)}
          onNavigate={setView}
          onOpenTask={openTask}
          onSetTheme={(theme) => setTweak('theme', theme)}
          tasks={tasks}
        />
      )}
      {welcomeOpen && (
        <WelcomeScreen
          stats={stats}
          onClose={closeWelcome}
          onNavigate={setView}
          showAgain={!hideWelcome}
          onShowAgainChange={(show) => setHideWelcome(!show)}
        />
      )}
    </div>
  );
}
`);

write('src/components/shell/ApplicationRoot.jsx', `'use client';
import { AppStateProvider } from '../../state/AppStateProvider';
import AppShell from './AppShell';

export default function ApplicationRoot() {
  return (
    <AppStateProvider>
      <AppShell />
    </AppStateProvider>
  );
}
`);

write('src/app/page.js', `'use client';
import dynamic from 'next/dynamic';

const App = dynamic(() => import('../components/shell/ApplicationRoot'), { ssr: false });

export default function Page() {
  return <App />;
}
`);

// Shared UI imports now point at their actual responsibilities.
write('src/components/ui.jsx', read('src/components/ui.jsx').replace(
  "import { COLOR_MAP, getStatus, personColorVar, personInitials, projectColorVar } from '../lib/data';",
  "import { COLOR_MAP, personColorVar, personInitials, projectColorVar } from '../lib/colors';\nimport { getStatus } from '../scheduling/metrics';"
));
write('src/components/ui-extras.jsx', read('src/components/ui-extras.jsx').replace(
  "import { addDays, diffDays, endOfWeek, parseDate, startOfWeek, today } from '../lib/data';",
  "import { addDays, diffDays, endOfWeek, parseDate, startOfWeek, today } from '../scheduling/dates';"
));

// Remove superseded mixed containers.
remove('src/components/AppShell.jsx');
remove('src/components/views-a.jsx');
remove('src/components/views-b.jsx');
remove('src/components/settings.jsx');

// -----------------------------------------------------------------------------
// Architecture documentation + concise README structure update.
// -----------------------------------------------------------------------------
write('docs/ARCHITECTURE.md', `# MERGEN Rota Architecture

MERGEN Rota is organized so feature UI does not own the global dataset and does not care whether data comes from mock JavaScript, an API, or a future SQL-backed service.

## Dependency direction

The intended direction is:

\`domain <- scheduling <- data <- state <- features <- app/shell\`

Shared visual components are used by features, but they do not import application state or the mock seed.

## Layers

### \`src/domain\`

Business concepts and data-shape rules that are independent from React and the browser. \`models\` documents Project, Task/Activity, Dependency, Person and WBS shapes with JSDoc. Stable relationships use IDs (for example \`projectId\`, \`assigneeIds\`, \`predecessorId\` and \`wbsId\`) while the mock adapter also retains the legacy display fields used by the current UI.

### \`src/scheduling\`

Pure scheduling logic. \`dates\` owns parsing, formatting and date-range helpers; \`calendars\` owns holiday/working-day rules; \`dependencies\` owns FS/SS/FF/SF metadata and normalization; \`metrics\` owns schedule-derived calculations used by Gantt and task status summaries. Future CPM work (forward/backward pass, float, critical path, lag/lead and project calendars) belongs here rather than in React components.

### \`src/data\`

The data-access boundary. \`contracts/appRepository.js\` documents the repository snapshot contract. \`mock/createMockRepository.js\` is the current in-memory adapter and \`mock/seed.js\` contains the normalized sample dataset. No database is implemented in this refactor.

A future API or SQL Server integration should add another adapter under \`src/data\` and supply it to \`AppStateProvider\`. Feature modules should not change when the backing source changes.

### \`src/state\`

\`AppStateProvider\` owns application-level project/task/person/WBS state, task CRUD operations, selected-task synchronization and aggregate task statistics. Focused hooks in \`src/state/hooks\` are the feature-facing API.

### \`src/features\`

Feature-oriented modules: dashboard, tasks, calendar, Gantt, Kanban, reports, team, settings and task detail. Feature components consume state hooks and shared pure logic; they do not import raw mock arrays.

### \`src/components\`

\`components/shell\` contains the application frame, navigation, command palette, welcome screen and logo. \`components/ui.jsx\` and \`components/ui-extras.jsx\` remain reusable visual primitives.

## Adding new work

- Project/Task/WBS business rules: \`src/domain\`
- Date, dependency, calendar or CPM calculations: \`src/scheduling\`
- Mock/API/database adapters: \`src/data\`
- Global client orchestration: \`src/state\`
- Feature UI and feature-only helpers: the relevant \`src/features/<feature>\` folder
- Generic visual primitives: \`src/components/ui*\`
- Sidebar/topbar/global overlays: \`src/components/shell\`

## Database/API migration path

The current application starts from \`appRepository\`, which is the mock adapter. A database-backed implementation should not be imported by feature components. Introduce an adapter in \`src/data\`, perform async loading/persistence in the state layer, and keep the hooks exposed to features stable. This isolates SQL Server, Next.js route handlers, REST clients, Primavera/SAP integration and authorization concerns from the feature UI.
`);

const readme = read('README.md');
const structureStart = readme.indexOf('## Yapı');
const nextStepStart = readme.indexOf('## Sonraki adım');
if (structureStart < 0 || nextStepStart < 0) throw new Error('README structure markers not found');
const readmeBefore = readme.slice(0, structureStart);
write('README.md', `${readmeBefore}## Yapı

- \`src/domain\` — Project, Task/Activity, Dependency, Person ve WBS iş kavramları
- \`src/scheduling\` — tarih, takvim, bağımlılık ve Gantt zamanlama hesapları
- \`src/data\` — veri erişim sözleşmesi ve mevcut mock/in-memory adapter
- \`src/state\` — uygulama düzeyi state, task işlemleri ve odaklı hook'lar
- \`src/features\` — Özet, Görevler, Takvim, Gantt, Kanban, Raporlar, Ekip, Ayarlar ve görev detayı
- \`src/components/shell\` — sidebar, topbar, navigasyon, komut paleti ve global overlay bileşenleri
- \`src/components/ui.jsx\`, \`src/components/ui-extras.jsx\` — yeniden kullanılabilir görsel bileşenler
- \`src/hooks\` — görünüm tercihleri ve bunları DOM'a uygulayan hook'lar

Ayrıntılı bağımlılık kuralları ve yeni kodun nereye eklenmesi gerektiği için \`docs/ARCHITECTURE.md\` dosyasına bakın.

## Sonraki adım

Veriler şu an \`src/data/mock\` altındaki in-memory adapter üzerinden sağlanıyor. Kalıcı depolama için gerçek veritabanı/API adapter'ı daha sonra \`src/data\` sınırında eklenmeli; bu PR gerçek bir veritabanı bağlantısı kurmaz.
`);

console.log('Architecture refactor generated successfully.');
