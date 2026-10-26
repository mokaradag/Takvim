import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findCommitProjectWbsIssue } from '../src/server/repository/commitProjectWbsValidation.js';
import { canonicalizeCommitScalars } from '../src/server/repository/commitScalarCanonicalization.js';
import { findDeleteIntentIssue } from '../src/server/repository/deleteIntentPolicy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WBS_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function validChanges() {
  return {
    projectUpserts: [{
      id: PROJECT_ID,
      name: 'Geçerli Proje',
      code: 'PRJ-1',
      leadId: '900002',
      color: 'blue',
      tags: ['Planlama']
    }],
    wbsUpserts: [{
      id: WBS_ID,
      projectId: PROJECT_ID,
      parentId: null,
      code: '1',
      name: 'Geçerli Proje',
      sortOrder: 1
    }]
  };
}

test('delete intent rejects missing targets and unversioned deletes', () => {
  assert.deepEqual(findDeleteIntentIssue({
    exists: false,
    version: 'AAAAAAAAAAA=',
    entityType: 'TASK',
    id: 'task-id'
  }), {
    code: 'DELETE_TARGET_MISSING',
    entityType: 'TASK',
    id: 'task-id',
    message: 'Silinecek kayıt artık bulunamadı. Verileri yeniden yükleyin.'
  });

  assert.equal(findDeleteIntentIssue({
    exists: true,
    version: null,
    entityType: 'WBS',
    id: 'wbs-id'
  })?.code, 'DELETE_VERSION_REQUIRED');

  assert.equal(findDeleteIntentIssue({
    exists: true,
    version: 'AAAAAAAAAAA=',
    entityType: 'TASK',
    id: 'task-id'
  }), null);
});

test('project metadata validation rejects malformed leads and duplicate or oversized tags', () => {
  const malformedLead = validChanges();
  malformedLead.projectUpserts[0].leadId = '900002abc';
  assert.equal(findCommitProjectWbsIssue(malformedLead)?.code, 'PROJECT_LEAD_INVALID');

  const outOfRangeLead = validChanges();
  outOfRangeLead.projectUpserts[0].leadId = '2147483648';
  assert.equal(findCommitProjectWbsIssue(outOfRangeLead)?.code, 'PROJECT_LEAD_INVALID');

  const duplicateTags = validChanges();
  duplicateTags.projectUpserts[0].tags = ['Planlama', 'PLANLAMA'];
  assert.equal(findCommitProjectWbsIssue(duplicateTags)?.code, 'PROJECT_TAG_DUPLICATE');

  const oversizedTag = validChanges();
  oversizedTag.projectUpserts[0].tags = ['x'.repeat(256)];
  assert.equal(findCommitProjectWbsIssue(oversizedTag)?.code, 'COMMIT_TEXT_TOO_LONG');
});

test('project and WBS SQL scalar limits are enforced before repository execution', () => {
  const blankProject = validChanges();
  blankProject.projectUpserts[0].name = '   ';
  assert.equal(findCommitProjectWbsIssue(blankProject)?.path, 'projectUpserts[0].name');

  const oversizedCode = validChanges();
  oversizedCode.projectUpserts[0].code = 'x'.repeat(256);
  assert.equal(findCommitProjectWbsIssue(oversizedCode)?.path, 'projectUpserts[0].code');

  const invalidColor = validChanges();
  invalidColor.projectUpserts[0].color = 'ultraviolet';
  assert.equal(findCommitProjectWbsIssue(invalidColor)?.code, 'PROJECT_COLOR_INVALID');

  const blankWbs = validChanges();
  blankWbs.wbsUpserts[0].name = '';
  assert.equal(findCommitProjectWbsIssue(blankWbs)?.path, 'wbsUpserts[0].name');

  const invalidSort = validChanges();
  invalidSort.wbsUpserts[0].sortOrder = 2147483648;
  assert.equal(findCommitProjectWbsIssue(invalidSort)?.code, 'WBS_SORT_ORDER_INVALID');

  assert.equal(findCommitProjectWbsIssue(validChanges()), null);
});

test('commit scalar canonicalization trims values before validation and SQL binding', () => {
  const canonical = canonicalizeCommitScalars({
    projectUpserts: [{
      name: '  Proje  ',
      source: ' manual ',
      color: ' blue ',
      dataDate: ' 2026-07-24 ',
      tags: [' Planlama ']
    }],
    wbsUpserts: [{ code: ' 1 ', name: ' Kök ' }],
    taskUpserts: [{
      task: ' Görev ',
      status: ' planned ',
      priority: ' high ',
      plannedStart: ' 2026-07-24 ',
      assigneeIds: [' 900002 '],
      deps: [{ type: ' FS ', lagUnit: ' day ' }]
    }]
  });

  assert.equal(canonical.projectUpserts[0].name, 'Proje');
  assert.equal(canonical.projectUpserts[0].source, 'manual');
  assert.equal(canonical.projectUpserts[0].color, 'blue');
  assert.equal(canonical.projectUpserts[0].dataDate, '2026-07-24');
  assert.deepEqual(canonical.projectUpserts[0].tags, ['Planlama']);
  assert.deepEqual(canonical.wbsUpserts[0], { code: '1', name: 'Kök' });
  assert.equal(canonical.taskUpserts[0].status, 'planned');
  assert.equal(canonical.taskUpserts[0].priority, 'high');
  assert.equal(canonical.taskUpserts[0].plannedStart, '2026-07-24');
  assert.deepEqual(canonical.taskUpserts[0].assigneeIds, ['900002']);
  assert.equal(canonical.taskUpserts[0].deps[0].type, 'FS');
  assert.equal(canonical.taskUpserts[0].deps[0].lagUnit, 'day');
});

test('commit route and ordered repository enforce all new boundaries', () => {
  const route = read('src/app/api/mergen-rota/commit/route.js');
  const ordered = read('src/server/repository/orderedSqlAppRepository.js');
  const intent = read('src/server/repository/upsertIntentValidation.js');

  assert.match(route, /canonicalizeCommitScalars\(canonicalizeCommitChanges\(body\.changes\)\)/);
  assert.match(route, /findCommitProjectWbsIssue\(changes\)/);
  assert.match(ordered, /canonicalizeCommitScalars\(canonicalizeCommitChanges\(changes\)\)/);
  assert.match(ordered, /await assertDeleteIntentMatchesPersistence\(transaction, orderedChanges, actor\);/);
  assert.match(intent, /collection: 'wbsDeletes'/);
  assert.match(intent, /collection: 'taskDeletes'/);
  assert.match(intent, /WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(ordered, /isolationLevel: sql\.ISOLATION_LEVEL\.SERIALIZABLE/);
});

/* ── Yetki öncesi açıklama: kimliksiz ve yetkisiz yoklama ────────── */

const HIDDEN_TASK_ID = 'c1c1c1c1-0000-4000-8000-000000000001';
const SUCCESSOR_TASK_ID = 'c1c1c1c1-0000-4000-8000-000000000002';
const LONE_TASK_ID = 'c1c1c1c1-0000-4000-8000-000000000003';
const HIDDEN_WBS_ID = 'c1c1c1c1-0000-4000-8000-000000000004';
const MANUAL_PROJECT_ID = 'c1c1c1c1-0000-4000-8000-000000000005';
const MANUAL_ROOT_WBS_ID = 'c1c1c1c1-0000-4000-8000-000000000006';
const MISSING_TASK_ID = 'c1c1c1c1-0000-4000-8000-0000000000ff';
const MISSING_WBS_ID = 'c1c1c1c1-0000-4000-8000-0000000000fe';
const PLAIN_SICIL = 900503;
const MANAGER_SICIL = 900500;
const SUBORDINATE_SICIL = 900501;
const STALE_VERSION = 'AAAAAAAAB9E=';

async function disclosureStack(sicil) {
  const { CORPORATE_PROJECT_ID, CORPORATE_ROOT_WBS_ID, DEFAULT_CALENDAR_ID, corporateSeed, createActualStack } = await import('./helpers/actualStack.mjs');
  const base = corporateSeed();
  const task = (TaskId, Title) => ({ TaskId, ProjectId: CORPORATE_PROJECT_ID, WbsId: CORPORATE_ROOT_WBS_ID, Title, Status: 'planned', Priority: 'medium', CreatedBySicil: 900010 });
  return createActualStack({
    ...base,
    people: [...base.people,
      { Sicil: PLAIN_SICIL, DisplayName: 'Sıradan Kullanıcı', Username: 'siradan' },
      { Sicil: MANAGER_SICIL, DisplayName: 'Birim Yöneticisi', Username: 'byonetici' },
      { Sicil: SUBORDINATE_SICIL, DisplayName: 'Ast Personel', Username: 'astpersonel' }],
    systemAdminSicils: [],
    executiveScope: [{ ManagerSicil: MANAGER_SICIL, EmployeeSicil: SUBORDINATE_SICIL, ScopeType: 'UNIT' }],
    projects: [...base.projects, {
      ProjectId: MANUAL_PROJECT_ID, SourceType: 'MANUAL', ProjectCode: 'GIZLI-KOD', ProjectName: 'Gizli manuel proje',
      LeadSicil: 900010, ColorToken: 'blue', CalendarId: DEFAULT_CALENDAR_ID
    }],
    wbs: [...base.wbs,
      { WbsId: HIDDEN_WBS_ID, ProjectId: CORPORATE_PROJECT_ID, ParentWbsId: CORPORATE_ROOT_WBS_ID, Code: 'G', Name: 'Gizli düğüm', SortOrder: 2 },
      { WbsId: MANUAL_ROOT_WBS_ID, ProjectId: MANUAL_PROJECT_ID, ParentWbsId: null, Code: '1', Name: 'Gizli manuel proje', SortOrder: 1 }],
    tasks: [task(HIDDEN_TASK_ID, 'Ardıllı gizli görev'), task(SUCCESSOR_TASK_ID, 'Gizli ardıl'), task(LONE_TASK_ID, 'Ardılsız gizli görev')],
    taskAssignees: [HIDDEN_TASK_ID, SUCCESSOR_TASK_ID, LONE_TASK_ID].map((TaskId) => ({ TaskId, Sicil: SUBORDINATE_SICIL })),
    taskDependencies: [{
      TaskDependencyId: 'c1c1c1c1-0000-4000-8000-000000000007', ProjectId: CORPORATE_PROJECT_ID,
      TaskId: SUCCESSOR_TASK_ID, PredecessorTaskId: HIDDEN_TASK_ID, DependencyType: 'FS', LagDays: 0
    }]
  }, { sicil });
}

/** Commit ucunun gözlenebilir yanıtı; çağıranın kendi gönderdiği kimlik maskelenir. */
async function probe(changes, submittedId) {
  const response = await fetch('http://localhost/api/mergen-rota/commit', { method: 'POST', body: JSON.stringify({ changes }) });
  return `${response.status} ${JSON.stringify(await response.json()).replaceAll(submittedId, '<id>')}`;
}

function projectCreate(code) {
  const changes = validChanges();
  changes.projectUpserts[0] = {
    ...changes.projectUpserts[0], id: 'c1c1c1c1-0000-4000-8000-0000000000aa', code,
    source: 'manual', leadId: String(MANAGER_SICIL), calendarId: 'c0a80101-1111-4111-8111-111111111111'
  };
  changes.wbsUpserts[0] = { ...changes.wbsUpserts[0], id: 'c1c1c1c1-0000-4000-8000-0000000000ab', projectId: 'c1c1c1c1-0000-4000-8000-0000000000aa' };
  return changes;
}

async function oracleProbes() {
  const del = (collection, id) => probe({ [collection]: [{ id, version: STALE_VERSION }] }, id);
  const update = (id) => probe({ taskUpserts: [{
    id, projectId: 'd5d70aec-0a88-f111-9136-00505699bacd', wbsId: null, calendarId: null, task: 'x', description: null,
    keyword: null, status: 'planned', priority: 'medium', isMilestone: false, plannedStart: null, plannedFinish: null,
    plannedDurationDays: null, targetFinish: null, actualStart: null, actualFinish: null, remainingDurationDays: null,
    progress: 0, sortOrder: null, assigneeIds: [], deps: [], version: STALE_VERSION
  }] }, id);
  return {
    // Var olmayan, ardılı olan ve ardılı olmayan korunan görev ayırt edilemez.
    taskDeletes: [await del('taskDeletes', MISSING_TASK_ID), await del('taskDeletes', HIDDEN_TASK_ID), await del('taskDeletes', LONE_TASK_ID)],
    taskUpdates: [await update(MISSING_TASK_ID), await update(HIDDEN_TASK_ID)],
    wbsDeletes: [await del('wbsDeletes', MISSING_WBS_ID), await del('wbsDeletes', HIDDEN_WBS_ID)],
    // Kullanılmayan, kurumsal ayrılmış ve başka projede kullanılan kod ayırt edilemez.
    projectCodes: [await probe(projectCreate('BOS-KOD')), await probe(projectCreate('P4417041')), await probe(projectCreate('GIZLI-KOD'))]
  };
}

function assertUniform(probes, label) {
  for (const [name, responses] of Object.entries(probes)) {
    assert.equal(new Set(responses).size, 1, `${label} · ${name}: ${responses.join(' | ')}`);
    assert.doesNotMatch(responses[0], new RegExp(`${SUCCESSOR_TASK_ID}|${MANUAL_PROJECT_ID}|GIZLI-KOD|PROJECT_CODE_`), `${label} · ${name}`);
  }
}

test('kimliksiz ve yetkisiz çağıran korunan kayıt, kod ve ardıl varlığını commit yanıtından öğrenemez', async () => {
  const plain = await disclosureStack(PLAIN_SICIL);
  const { setCurrentUserProvider } = await import('../src/server/identity/currentUserProvider.js');
  const { ServerPersistenceError } = await import('../src/server/errors.js');
  try {
    const authenticated = await oracleProbes();
    assertUniform(authenticated, 'yetkisiz');
    assert.match(authenticated.taskDeletes[0], /^409 .*DELETE_TARGET_MISSING/);
    assert.match(authenticated.taskUpdates[0], /^409 .*UPSERT_TARGET_MISSING/);
    assert.match(authenticated.wbsDeletes[0], /^409 .*DELETE_TARGET_MISSING/);
    assert.match(authenticated.projectCodes[0], /^403 /);

    setCurrentUserProvider({ getCurrentSicil: async () => { throw new ServerPersistenceError('SESSION_REQUIRED', 'Oturum bulunamadı.'); } });
    const anonymous = await oracleProbes();
    assertUniform(anonymous, 'kimliksiz');
    for (const responses of Object.values(anonymous)) assert.match(responses[0], /^401 /);
  } finally {
    setCurrentUserProvider(null);
    await plain.dispose();
  }
});

test('aynı kümede oluşturulan projedeki bağımlı görevler oluşturanın FULL sahipliğiyle kabul edilir', async () => {
  // Bağımlılık kapısı yetki bağlamını proje yazılmadan önce okur; oluşturulacak projede bağımlılık ilk commit'te
  // reddedilmemelidir. Var olan ama FULL yetkisi olmayan projede ise kapı aynen uygulanır.
  const manager = await disclosureStack(MANAGER_SICIL);
  try {
    const changes = projectCreate('YENI-KOD');
    const projectId = changes.projectUpserts[0].id;
    const first = 'c1c1c1c1-0000-4000-8000-0000000000b1';
    const second = 'c1c1c1c1-0000-4000-8000-0000000000b2';
    const task = (id, title, deps) => ({
      id, projectId, wbsId: changes.wbsUpserts[0].id, calendarId: null, task: title, description: null, keyword: null,
      status: 'planned', priority: 'medium', isMilestone: false, plannedStart: null, plannedFinish: null, plannedDurationDays: null,
      targetFinish: null, actualStart: null, actualFinish: null, remainingDurationDays: null, progress: 0, sortOrder: null,
      assigneeIds: [String(SUBORDINATE_SICIL)], deps
    });
    changes.taskUpserts = [task(first, 'Öncül', []), task(second, 'Ardıl', [{ predecessorId: first, type: 'FS', lagDays: 0 }])];
    assert.match(await probe(changes, projectId), /^200 /);
    assert.ok(manager.db.taskDependencies.some((row) => String(row.TaskId).toLowerCase() === second
      && String(row.PredecessorTaskId).toLowerCase() === first), 'bağımlılık yazılır');

    const existing = { taskUpserts: [{ ...task('c1c1c1c1-0000-4000-8000-0000000000b3', 'Gizli projede', [{ predecessorId: first, type: 'FS', lagDays: 0 }]),
      projectId: MANUAL_PROJECT_ID, wbsId: MANUAL_ROOT_WBS_ID }], projectUpserts: [{ id: MANUAL_PROJECT_ID }] };
    assert.doesNotMatch(await probe(existing, MANUAL_PROJECT_ID), /^200 /, 'var olan projeye oluşturma muafiyeti uygulanmaz');
  } finally {
    await manager.dispose();
  }
});

test('görevi görebilen ama silemeyen aktör gizli ardıl ilişkisini öğrenemez; yetkili aktörler ayrıntılı hatayı korur', async () => {
  const manager = await disclosureStack(MANAGER_SICIL);
  try {
    const snapshot = await manager.repository.loadSnapshot();
    const visible = (id) => snapshot.tasks.find((task) => String(task.id).toLowerCase().includes(id.slice(-12)));
    assert.ok(visible(HIDDEN_TASK_ID) && visible(LONE_TASK_ID), 'yönetici astının görevlerini görür');
    const withSuccessor = await probe({ taskDeletes: [{ id: HIDDEN_TASK_ID, version: visible(HIDDEN_TASK_ID).version }] }, HIDDEN_TASK_ID);
    const lone = await probe({ taskDeletes: [{ id: LONE_TASK_ID, version: visible(LONE_TASK_ID).version }] }, LONE_TASK_ID);
    assert.equal(withSuccessor, lone);
    assert.match(lone, /^403 /);
    assert.doesNotMatch(withSuccessor, new RegExp(SUCCESSOR_TASK_ID));

    // Proje oluşturabilen yönetici kod çakışmasının nedenini görmeye devam eder.
    assert.match(await probe(projectCreate('P4417041')), /^409 .*PROJECT_CODE_RESERVED/);
    assert.match(await probe(projectCreate('GIZLI-KOD')), /^409 .*PROJECT_CODE_CONFLICT/);
  } finally {
    await manager.dispose();
  }

  const lead = await disclosureStack(900010);
  try {
    const snapshot = await lead.repository.loadSnapshot();
    const predecessor = snapshot.tasks.find((task) => String(task.id).toLowerCase().includes(HIDDEN_TASK_ID.slice(-12)));
    const response = await fetch('http://localhost/api/mergen-rota/commit', {
      method: 'POST', body: JSON.stringify({ changes: { taskDeletes: [{ id: HIDDEN_TASK_ID, version: predecessor.version }] } })
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error.details.code, 'TASK_DEPENDENCY_RECONCILIATION_REQUIRED');
    assert.deepEqual(body.error.details.taskIds, [SUCCESSOR_TASK_ID], 'FULL yetkili ardılları zaten görür');
    // Görünürlük süzgeci aktörsüz çağrıda her öncülü düşürürdü; denetim sessizce atlanmaz, çağrı reddedilir.
    const { assertTaskDependencyReconciliationCovered } = await import('../src/server/repository/dependencyReconciliationValidation.js');
    const executor = { request: () => ({ input() {}, query: async () => ({ recordset: [] }) }) };
    await assert.rejects(assertTaskDependencyReconciliationCovered(executor, { taskDeletes: [{ id: HIDDEN_TASK_ID, version: predecessor.version }] }), TypeError);
  } finally {
    await lead.dispose();
  }
});
