import { buildPortfolioSchedule } from '../../src/state/selectors/scheduleSelectors.js';

export const people = [
  { id: '100001', employeeNo: '100001', name: 'Ayşe Ak' },
  { id: '100002', employeeNo: '100002', name: 'Bora Bir' }
];
export const projects = [
  { id: 'p1', name: 'Proje A', plannedStart: '2026-09-01' },
  { id: 'p2', name: 'Proje B', accessLevel: 'PARTIAL' }
];
export const tasks = [
  {
    id: 'a',
    projectId: 'p1',
    proje: 'Proje A',
    task: 'Alfa görevi',
    keyword: 'Alfa',
    assigneeIds: ['100001'],
    sorumlu: ['Ayşe Ak'],
    priority: 'high',
    status: 'todo',
    progress: 0,
    plannedStart: '2026-09-01',
    plannedFinish: '2026-09-02',
    targetFinish: '2026-09-10',
    plannedDurationDays: 2,
    deps: []
  },
  {
    id: 'b',
    projectId: 'p1',
    proje: 'Proje A',
    task: 'Beta görevi',
    keyword: 'Beta',
    assigneeIds: ['100002'],
    sorumlu: ['Bora Bir'],
    priority: 'low',
    status: 'in_progress',
    progress: 50,
    plannedStart: '2026-09-03',
    plannedFinish: '2026-09-06',
    targetFinish: '2026-09-20',
    plannedDurationDays: 4,
    deps: [{ id: 'a', type: 'FS' }]
  },
  {
    id: 'c',
    projectId: 'p1',
    proje: 'Proje A',
    task: 'Gama görevi',
    keyword: 'Gama',
    assigneeIds: ['100001'],
    sorumlu: ['Ayşe Ak'],
    priority: 'high',
    status: 'done',
    plannedStart: '2026-09-07',
    plannedFinish: '2026-09-16',
    targetFinish: '2026-09-30',
    plannedDurationDays: 10,
    deps: []
  },
  {
    id: 'd',
    projectId: 'p1',
    proje: 'Proje A',
    task: 'Sıfır süreli görev',
    keyword: 'Sıfır',
    assigneeIds: ['100002'],
    sorumlu: ['Bora Bir'],
    priority: 'medium',
    status: 'todo',
    plannedStart: '2026-09-20',
    plannedFinish: '2026-09-20',
    targetFinish: '2026-09-20',
    plannedDurationDays: 0,
    deps: []
  },
  {
    id: 'e',
    projectId: 'p2',
    proje: 'Proje B',
    task: 'Çizelgesiz görev',
    keyword: 'Eksik',
    assigneeIds: ['100001'],
    sorumlu: ['Ayşe Ak'],
    priority: 'low',
    status: 'todo',
    plannedStart: '2026-09-10',
    plannedFinish: '2026-09-11',
    targetFinish: '2026-09-15',
    deps: []
  }
];
export function filterState(data = tasks) {
  return {
    tasks: data,
    projects,
    people,
    selectedTask: null,
    workspace: { tasks: data, projects, people, wbs: [] },
    currentUser: { id: '100001', employeeNo: '100001', role: 'admin' },
    session: { dataMode: 'demo' },
    actions: { openTask() {} },
    schedule: buildPortfolioSchedule({ tasks: data, projects })
  };
}

const calendarDates = {
  a: ['2026-10-01', '2026-10-01', '2026-11-05'],
  b: ['2026-10-26', '2026-10-31', '2026-11-06'],
  c: ['2026-10-31', '2026-10-31', '2026-10-31'],
  d: ['2026-11-01', '2026-11-01', '2026-11-01'],
  e: ['2026-11-05', '2026-11-05', '2026-11-05']
};
export const calendarTasks = tasks.map((task) => {
  const [plannedStart, plannedFinish, targetFinish] = calendarDates[task.id];
  const result = { ...task, plannedStart, plannedFinish, targetFinish };
  // Bu veri kümesi yalnızca takvim dönemlerini sınar; eski süreyi taşımaz.
  delete result.plannedDurationDays;
  return result;
});
