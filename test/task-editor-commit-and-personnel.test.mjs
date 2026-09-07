import assert from 'node:assert/strict';
import test from 'node:test';
import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';
import { executeTaskCreation } from '../src/state/taskCreationPolicy.js';
import { prepareTaskCreationCommit, prepareTaskEditorCommit } from '../src/state/taskEditorCommit.js';
import { taskPersonnelScope } from '../src/state/taskPersonnelScope.js';
import { simpleAssignmentScope } from '../src/features/simple/simpleModePolicy.js';
import { normalizeTaskAssigneePatch } from '../src/domain/identity/taskAssigneePatch.js';
import { resolveTaskAssigneeDisplayRecords, taskAssigneeMutationPatch } from '../src/features/task-detail/taskAssigneeDisplay.js';

const projectId = '81111111-1111-4111-8111-111111111111';
const wbsId = '82222222-2222-4222-8222-222222222222';
const taskId = '83333333-3333-4333-8333-333333333333';
const successorId = '84444444-4444-4444-8444-444444444444';
const manager = 980001;
const employees = [980002, 980003];
const outsider = 980004;
function seed() {
  return {
    calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Takvim', IsDefault: 1, IsActive: 1 }],
    people: [manager, ...employees, outsider].map((Sicil) => ({ Sicil, DisplayName: employees.includes(Sicil) ? 'Aynı Ad Soyad' : `Kişi ${Sicil}`, Username: `u${Sicil}` })),
    executiveScope: employees.map((EmployeeSicil) => ({ ManagerSicil: manager, EmployeeSicil, ScopeType: 'UNIT' })),
    projects: [{ ProjectId: projectId, SourceType: 'MANUAL', ProjectCode: 'EKİP', ProjectName: 'Manuel ekip projesi', LeadSicil: manager, CalendarId: DEFAULT_CALENDAR_ID, IsActive: 1 }],
    wbs: [{ WbsId: wbsId, ProjectId: projectId, ParentWbsId: null, Code: '1', Name: 'Kök', SortOrder: 0 }]
  };
}
async function createTask(stack, id = taskId) {
  const result = await executeTaskCreation({ state: stack.state, id,
    input: { projectId, wbsId, task: 'İlk görev', assigneeIds: [String(employees[0])], status: 'todo', priority: 'medium', plannedStart: '2026-09-07', plannedFinish: '2026-09-08', targetFinish: '2026-09-09' },
    mutate: (operation, action) => stack.persistence.mutate(operation, action) });
  assert.equal(result.result.ok, true, result.result.error?.message);
  return stack.state.tasks.find((task) => task.id === id);
}
function save(stack, edits, options = {}) {
  return stack.persistence.mutate('task/save-draft', (current) => prepareTaskEditorCommit(current, edits, { taskId, ...options }));
}

test('aynı adlı iki çalışan ve görev alanları tek Kaydet isteğinde Sicil ile yazılır', async () => {
  const stack = await createActualStack(seed(), { sicil: manager, corporateWbsSource: false });
  try {
    const task = await createTask(stack);
    const second = await createTask(stack, successorId);
    const patch = taskAssigneeMutationPatch(task, stack.state.people, employees.map(String));
    assert.equal(normalizeTaskAssigneePatch(patch, stack.state.people).ok, true);
    const edits = [{ id: taskId, version: task.version, patch: { ...patch, task: 'Yeni görev', keyword: 'Yeni etiket', description: 'Toplu kayıt', priority: 'high' } },
      { id: successorId, version: second.version, patch: { deps: [{ id: taskId, type: 'FS', lagDays: 0 }] } }];
    const initialRequests = stack.requests.length;
    prepareTaskEditorCommit(stack.state, edits, { taskId, syncKeywordCatalog: true });
    assert.equal(stack.requests.length, initialRequests);
    assert.equal(stack.db.tasks.find((row) => row.TaskId.toLowerCase() === taskId).Title, 'İlk görev');
    const result = await save(stack, edits, { syncKeywordCatalog: true });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(stack.requests.slice(initialRequests).filter((request) => request.path.endsWith('/commit')).length, 1);
    assert.equal(stack.requests.slice(initialRequests).length, 1);
    const updated = stack.state.tasks.find((item) => item.id === taskId);
    assert.deepEqual(updated.assigneeIds.sort(), employees.map(String));
    assert.deepEqual(updated.sorumlu, ['Aynı Ad Soyad', 'Aynı Ad Soyad']);
    assert.equal(updated.task, 'Yeni görev');
    assert.equal(updated.description, 'Toplu kayıt');
    assert.ok(stack.state.projects[0].tags.some((tag) => tag.name === 'Yeni etiket' || tag === 'Yeni etiket'));
    assert.equal(stack.db.taskDependencies.length, 1);
    await stack.reload();
    const restored = stack.state.tasks.find((item) => item.id === taskId);
    assert.deepEqual(restored.assigneeIds.sort(), employees.map(String));
    const removed = await save(stack, [{ id: taskId, version: restored.version, patch: { assigneeIds: [String(employees[1])] } }]);
    assert.equal(removed.ok, true, removed.error?.message);
    assert.deepEqual(stack.state.tasks.find((item) => item.id === taskId).assigneeIds, [String(employees[1])]);
  } finally { await stack.dispose(); }
});

test('manuel proje sahibi yönetici kapsam dışı atama yapamaz; tüm işlem geri alınır', async () => {
  const stack = await createActualStack(seed(), { sicil: manager, corporateWbsSource: false });
  try {
    const task = await createTask(stack);
    const result = await save(stack, [{ id: taskId, version: task.version, patch: { assigneeIds: [String(outsider)], task: 'Yazılmamalı', keyword: 'Yazılmamalı' } }], { syncKeywordCatalog: true });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'FORBIDDEN');
    assert.equal(stack.db.tasks[0].Title, 'İlk görev');
    assert.deepEqual(stack.db.taskAssignees.map((row) => row.Sicil), [employees[0]]);
    assert.equal(stack.db.projectTags.length, 0);
  } finally { await stack.dispose(); }
});

test('değişmeyen sorumlular için rehber sorgusu ve atama yazması yapılmaz', async () => {
  const stack = await createActualStack(seed(), { sicil: manager, corporateWbsSource: false });
  try {
    const task = await createTask(stack);
    stack.db.taskAssignees[0].AssignedBySicil = 970000;
    const offset = stack.db.statements.length;
    const result = await save(stack, [{ id: taskId, version: task.version, patch: { description: 'Yalnızca not değişti' } }]);
    assert.equal(result.ok, true, result.error?.message);
    const statements = stack.db.statements.slice(offset).map((entry) => entry.sql).join('\n');
    assert.doesNotMatch(statements, /SELECT TOP \(1\) Sicil FROM dbo.MR_V_PeopleDirectory WHERE Sicil = @sicil/);
    assert.doesNotMatch(statements, /(?:DELETE|INSERT) dbo.MR_TaskAssignees/);
    assert.equal(stack.db.taskAssignees[0].AssignedBySicil, 970000);
  } finally { await stack.dispose(); }
});

test('eski sürüm veya boş başlık taslağı sunucu isteği oluşturmadan reddedilir', async () => {
  const stack = await createActualStack(seed(), { sicil: manager, corporateWbsSource: false });
  try {
    const task = await createTask(stack);
    const offset = stack.requests.length;
    await assert.rejects(save(stack, [{ id: taskId, version: 'old', patch: { description: 'Taslak' } }]), { code: 'CONFLICT' });
    await assert.rejects(save(stack, [{ id: taskId, version: task.version, patch: { task: ' ' } }]), { code: 'TASK_TITLE_REQUIRED' });
    assert.equal(stack.requests.length, offset);
  } finally { await stack.dispose(); }
});

test('mevcut şablon düzenlemesi ve tekrarları aynı istekte kaydedilir', async () => {
  const stack = await createActualStack(seed(), { sicil: manager, corporateWbsSource: false });
  try {
    const task = await createTask(stack);
    const offset = stack.requests.length;
    const result = await save(stack, [{ id: taskId, version: task.version, patch: { task: 'Yeni seri başlığı', recurrence: 'FREQ=WEEKLY;COUNT=3' } }], { generateSeries: true });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(stack.requests.length - offset, 1);
    assert.equal(stack.db.tasks.length, 3);
    assert.ok(stack.db.tasks.every((row) => row.Title === 'Yeni seri başlığı'));
  } finally { await stack.dispose(); }
});

test('tüm seçiciler FULL manuel proje ve yeni serbest proje için yönetici kapsamını korur', () => {
  for (const project of [null, { accessLevel: 'FULL', source: 'manual' }, { accessLevel: 'FULL', source: 'corporate' }]) {
    const options = { isExecutive: true, assignmentScopeSicils: employees.map(String) };
    assert.deepEqual([...taskPersonnelScope({ ...options, project })], employees.map(String));
    assert.deepEqual([...simpleAssignmentScope({ ...options, selectedProject: project, creationScope: 'FULL' })], employees.map(String));
    assert.equal(taskPersonnelScope({ ...options, project, isSystemAdmin: true }), null);
  }
});

test('aynı adlı görünür ve görev kapsamlı sorumluların fotoğraf kimlikleri karışmaz', () => {
  const task = { assigneeIds: ['1'], assigneeDisplayNames: ['Aynı Ad', 'Aynı Ad'], assigneeAvatarIdentities: [{ name: 'Aynı Ad', employeeNo: '1' }, { name: 'Aynı Ad', employeeNo: '2' }] };
  const records = resolveTaskAssigneeDisplayRecords(task, [{ id: '1', employeeNo: '1', name: 'Aynı Ad' }], true);
  assert.deepEqual(records.map((record) => record.person.employeeNo), ['1', '2']);
});


test('yeni görev, öncülü, ardılı ve etiketi aynı Kaydet işleminde oluşturulur', async () => {
  const stack = await createActualStack(seed(), { sicil: manager, corporateWbsSource: false });
  try {
    const predecessor = await createTask(stack);
    const successor = await createTask(stack, successorId);
    const newId = '85555555-5555-4555-8555-555555555555';
    const offset = stack.requests.length;
    const input = { ...predecessor, id: newId, version: undefined, task: 'Yeni bağlantılı görev', keyword: 'Yeni görev etiketi', deps: [{ id: taskId, type: 'FS', lagDays: 0 }] };
    const relatedEdits = [{ id: successorId, version: successor.version, patch: { deps: [{ id: newId, type: 'SS', lagValue: 2, lagUnit: 'day', lagDays: 2 }] } }];
    const result = await executeTaskCreation({ state: stack.state, id: newId, input,
      mutate: (operation, factory) => stack.persistence.mutate(operation, (current) => prepareTaskCreationCommit(current, factory(current), { relatedEdits, syncKeywordCatalog: true })) });
    assert.equal(result.result.ok, true, result.result.error?.message);
    assert.equal(result.created.id, newId);
    assert.equal(stack.requests.length - offset, 1);
    await stack.reload();
    assert.equal(stack.state.tasks.find((task) => task.id === newId).deps[0].predecessorId, taskId);
    const dependency = stack.state.tasks.find((task) => task.id === successorId).deps[0];
    assert.equal(dependency.predecessorId, newId);
    assert.equal(dependency.type, 'SS');
    assert.equal(dependency.lagDays, 2);
    assert.ok(stack.state.projects[0].tags.some((tag) => (tag.name || tag) === 'Yeni görev etiketi'));
  } finally { await stack.dispose(); }
});

test('yeni görevin ardılında döngü veya eski sürüm varsa hiçbir değişiklik yazılmaz', async () => {
  const stack = await createActualStack(seed(), { sicil: manager, corporateWbsSource: false });
  try {
    const successor = await createTask(stack, successorId);
    const newId = '85555555-5555-4555-8555-555555555555';
    const input = { ...successor, id: newId, version: undefined, task: 'Oluşmamalı', deps: [{ id: successorId, type: 'FS', lagDays: 0 }] };
    const relatedEdits = [{ id: successorId, version: successor.version, patch: { deps: [{ id: newId, type: 'FS', lagDays: 0 }] } }];
    const create = () => executeTaskCreation({ state: stack.state, id: newId, input,
      mutate: (operation, factory) => stack.persistence.mutate(operation, (current) => prepareTaskCreationCommit(current, factory(current), { relatedEdits })) });
    const cycle = await create();
    assert.equal(cycle.result.ok, false);
    assert.equal(stack.db.tasks.length, 1);
    assert.equal(stack.db.taskDependencies.length, 0);
    relatedEdits[0].version = 'eski';
    await assert.rejects(create(), { code: 'CONFLICT' });
    assert.equal(stack.db.tasks.length, 1);
    assert.equal(stack.db.taskDependencies.length, 0);
  } finally { await stack.dispose(); }
});
