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
  const createProject = (id) => probe({ projectUpserts: [{ ...projectCreate(null).projectUpserts[0], id }] }, id);
  return {
    // Var olmayan, ardılı olan ve ardılı olmayan korunan görev ayırt edilemez.
    taskDeletes: [await del('taskDeletes', MISSING_TASK_ID), await del('taskDeletes', HIDDEN_TASK_ID), await del('taskDeletes', LONE_TASK_ID)],
    taskUpdates: [await update(MISSING_TASK_ID), await update(HIDDEN_TASK_ID)],
    wbsDeletes: [await del('wbsDeletes', MISSING_WBS_ID), await del('wbsDeletes', HIDDEN_WBS_ID)],
    // Kullanılmayan, kurumsal ayrılmış ve başka projede kullanılan kod ayırt edilemez.
    projectCodes: [await probe(projectCreate('BOS-KOD')), await probe(projectCreate('P4417041')), await probe(projectCreate('GIZLI-KOD'))],
    projectCreates: [await createProject(PROJECT_ID), await createProject(MANUAL_PROJECT_ID)]
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
    assert.match(authenticated.projectCreates[0], /^403 /);

    setCurrentUserProvider({ getCurrentSicil: async () => { throw new ServerPersistenceError('SESSION_REQUIRED', 'Oturum bulunamadı.'); } });
    const anonymous = await oracleProbes();
    assertUniform(anonymous, 'kimliksiz');
    for (const responses of Object.values(anonymous)) assert.match(responses[0], /^401 /);
  } finally {
    setCurrentUserProvider(null);
    await plain.dispose();
  }
});

test('yönetici görev atama istisnasıyla gizli WBS hedef projesinin varlığını öğrenemez', async () => {
  const manager = await disclosureStack(MANAGER_SICIL);
  try {
    const { CORPORATE_PROJECT_ID } = await import('./helpers/actualStack.mjs');
    manager.db.tasks.length = 0;
    manager.db.taskAssignees.length = 0;
    manager.db.taskDependencies.length = 0;
    assert.equal((await manager.repository.loadSessionContext()).projectAccess.length, 0);
    for (const includeTask of [false, true]) {
      const attempt = (projectId) => probe({
        wbsUpserts: [{ id: WBS_ID, projectId, parentId: null, name: 'Yoklama', code: '1' }],
        ...(includeTask ? { taskUpserts: [{ id: MISSING_TASK_ID, projectId, task: 'Yoklama', status: 'planned', priority: 'medium', assigneeIds: [String(SUBORDINATE_SICIL)] }] } : {})
      }, projectId);
      const hidden = await attempt(CORPORATE_PROJECT_ID.toLowerCase());
      assert.equal(hidden, await attempt(PROJECT_ID), 'gizli ve eksik proje aynı yanıtı alır; karma görev/WBS isteği istisna sağlamaz');
      assert.match(hidden, /^400 .*MUTATION_FAILED/);
    }
    assert.equal(manager.db.wbs.some((row) => row.WbsId === WBS_ID), false);
  } finally {
    await manager.dispose();
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

    // Var olan projenin SÜRÜMLÜ, kodsuz güncellemesi niyet denetimini geçer (READ hibesiyle görünür); 409
    // çakışmasına değil yetki kapısına ulaşır. Oluşturma muafiyeti yalnızca kaydı olmayan projeye aittir ve
    // var olan proje temel deponun FULL yazma kuralıyla, bağımlılık planından önce reddedilir.
    manager.db.projectAccess.push({ ProjectId: MANUAL_PROJECT_ID.toUpperCase(), Sicil: MANAGER_SICIL, AccessLevel: 'READ', GrantSource: 'MANUAL_GRANT', IsActive: 1 });
    const stored = (await manager.repository.loadSnapshot()).projects.find((project) => String(project.id).toLowerCase() === MANUAL_PROJECT_ID);
    assert.ok(stored?.version, 'proje READ hibesiyle görünür');
    const dependent = task('c1c1c1c1-0000-4000-8000-0000000000b3', 'Gizli projede', [{ predecessorId: first, type: 'FS', lagDays: 0 }]);
    const existing = { taskUpserts: [{ ...dependent, projectId: MANUAL_PROJECT_ID, wbsId: MANUAL_ROOT_WBS_ID }], projectUpserts: [{ ...stored, code: null }] };
    assert.equal(await probe(existing, MANUAL_PROJECT_ID),
      `403 ${JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Bu proje için tam yazma yetkiniz yok.', details: null } })}`,
      'var olan projeye oluşturma muafiyeti uygulanmaz');
    // Proje satırı gönderilmeden de aynı görev bağımlılık kapısında durur.
    assert.equal(await probe({ taskUpserts: existing.taskUpserts }, MANUAL_PROJECT_ID),
      `403 ${JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Görev bağımlılıkları yalnızca tam proje yetkisiyle düzenlenebilir.', details: null } })}`);
    assert.equal(manager.db.tasks.some((row) => String(row.TaskId).toLowerCase() === dependent.id), false);
  } finally {
    await manager.dispose();
  }
});

test('proje oluşturamayan aktör kodsuz sahte projeyle gizli öncül kimliği yoklayamaz', async () => {
  const plain = await disclosureStack(PLAIN_SICIL);
  try {
    const attempt = async (predecessorId) => {
      const changes = projectCreate(null);
      const projectId = changes.projectUpserts[0].id;
      changes.taskUpserts = [{
        id: 'c1c1c1c1-0000-4000-8000-0000000000c1', projectId, wbsId: changes.wbsUpserts[0].id, calendarId: null, task: 'Yoklama',
        description: null, keyword: null, status: 'planned', priority: 'medium', isMilestone: false, plannedStart: null,
        plannedFinish: null, plannedDurationDays: null, targetFinish: null, actualStart: null, actualFinish: null,
        remainingDurationDays: null, progress: 0, sortOrder: null, assigneeIds: [String(PLAIN_SICIL)],
        deps: [{ predecessorId, type: 'FS', lagDays: 0 }]
      }];
      return probe(changes, predecessorId);
    };
    const hidden = await attempt(HIDDEN_TASK_ID);
    const missing = await attempt(MISSING_TASK_ID);
    assert.equal(hidden, missing, 'gizli öncül var olmayanla aynı yanıtı alır');
    assert.match(hidden, /^403 .*manuel proje oluşturabilir/, 'oluşturma yetkisi bağımlılık planından önce reddeder');
    assert.equal(plain.db.projects.some((project) => String(project.ProjectId).toLowerCase() === 'c1c1c1c1-0000-4000-8000-0000000000aa'), false);
  } finally {
    await plain.dispose();
  }
});

test('yönetim kapsamıyla görünen WBS atası niyet denetiminde var sayılır; gizli düğüm var olmayanla aynı kalır', async () => {
  const manager = await disclosureStack(MANAGER_SICIL);
  try {
    const { CORPORATE_PROJECT_ID, CORPORATE_ROOT_WBS_ID } = await import('./helpers/actualStack.mjs');
    const SCOPED_WBS_ID = 'c1c1c1c1-0000-4000-8000-000000000008';
    manager.db.wbs.push({ WbsId: SCOPED_WBS_ID.toUpperCase(), ProjectId: CORPORATE_PROJECT_ID, ParentWbsId: CORPORATE_ROOT_WBS_ID, Code: 'K', Name: 'Kapsam düğümü', SortOrder: 3, RowVersion: Buffer.from([0, 0, 0, 0, 0, 0, 0, 9]) });
    manager.db.tasks.find((row) => String(row.TaskId).toLowerCase() === LONE_TASK_ID).WbsId = SCOPED_WBS_ID.toUpperCase();
    const snapshot = await manager.repository.loadSnapshot();
    const visibleIds = snapshot.wbs.map((node) => String(node.id).toLowerCase());
    const scoped = snapshot.wbs.find((node) => String(node.id).toLowerCase() === SCOPED_WBS_ID);
    assert.ok(scoped && visibleIds.includes(CORPORATE_ROOT_WBS_ID.toLowerCase()), 'anlık görüntü astın görevinin WBS zincirini döndürür');
    assert.equal(visibleIds.includes(HIDDEN_WBS_ID), false, 'kapsam dışı düğüm anlık görüntüde yoktur');

    // Görünen düğüm yetki denetimine ulaşır (KISMİ proje WBS yazamaz); 409 "bulunamadı" almaz.
    assert.equal(await probe({ wbsDeletes: [{ id: scoped.id, version: scoped.version }] }, scoped.id),
      `403 ${JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Bu proje için tam yazma yetkiniz yok.', details: null } })}`);
    const root = snapshot.wbs.find(node => String(node.id).toLowerCase() === CORPORATE_ROOT_WBS_ID.toLowerCase());
    assert.match(await probe({ wbsUpserts: [{ ...root, name: 'Görünür ata' }] }, root.id), /^403 /, 'görünür ata da yetki sınırına ulaşır');
    // Görünmeyen ve var olmayan düğüm aynı yanıtı alır.
    const hidden = await probe({ wbsDeletes: [{ id: HIDDEN_WBS_ID, version: STALE_VERSION }] }, HIDDEN_WBS_ID);
    assert.equal(hidden, await probe({ wbsDeletes: [{ id: MISSING_WBS_ID, version: STALE_VERSION }] }, MISSING_WBS_ID));
    assert.match(hidden, /^409 .*DELETE_TARGET_MISSING/);
    const update = id => probe({ wbsUpserts: [{ id, projectId: CORPORATE_PROJECT_ID, parentId: CORPORATE_ROOT_WBS_ID, name: 'Düğüm', code: 'X', version: STALE_VERSION }] }, id);
    assert.equal(await update(HIDDEN_WBS_ID), await update(MISSING_WBS_ID));
    manager.db.executiveScope.forEach((row) => { row.ManagerSicil = String(row.ManagerSicil); row.EmployeeSicil = String(row.EmployeeSicil); });
    manager.db.taskAssignees.forEach((row) => { row.Sicil = String(row.Sicil); });
    const request = new manager.driver.ConnectionPool({}).request();
    request.input('sicil', null, MANAGER_SICIL);
    request.input('projectId', null, CORPORATE_PROJECT_ID);
    request.input('wbsId', null, root.id);
    assert.equal((await request.query(';WITH ScopedWbsChain AS')).recordset.length, 1, 'SQL Int eşitliği metin Sicil fixture değerlerinde de WBS atasını korur');
  } finally {
    await manager.dispose();
  }
});

test('commit işlemi yetkiyi bir kez yükler; kilitlenme kurbanı baştan yinelenir', async (t) => {
  const lead = await disclosureStack(900010);
  try {
    const snapshot = await lead.repository.loadSnapshot();
    const lone = snapshot.tasks.find((task) => String(task.id).toLowerCase() === LONE_TASK_ID);
    const firstStatement = lead.db.statements.length;
    const firstTransaction = lead.db.transactions.length;
    const { resetTelemetryRegistryForTests, snapshotOperations } = await import('../src/server/observability/telemetryRegistry.js');
    resetTelemetryRegistryForTests();
    let clock = 1800000000000;
    t.mock.method(Date, 'now', () => clock);
    lead.db.queryBarrier = { match(statement) {
      if (statement.includes('FROM dbo.MR_V_PeopleDirectory WHERE Sicil = @sicil')) clock += 250;
      return false;
    } };
    let deadlocks = 0;
    lead.db.commitHook = () => {
      if (deadlocks++ === 0) throw Object.assign(new Error('Transaction was deadlocked'), { number: 1205 });
    };
    await lead.repository.commitChanges({ taskUpserts: [{ ...lone, task: 'Yinelenen kayıt' }] });
    lead.db.commitHook = null;

    const attempts = lead.db.transactions.slice(firstTransaction);
    assert.deepEqual(attempts.map((attempt) => [attempt.rollbackStatementIndex != null, attempt.commitStatementIndex != null]),
      [[true, false], [false, true]], 'kurban geri alınır, yeni işlem tamamlanır');
    for (const attempt of attempts) {
      const end = attempt.commitStatementIndex ?? attempt.rollbackStatementIndex;
      const authorizationReads = lead.db.statements.slice(attempt.statementIndex, end)
        .filter((statement) => statement.sql.includes('FROM dbo.MR_V_PeopleDirectory WHERE Sicil = @sicil'));
      assert.equal(authorizationReads.length, 1, 'yetki bağlamı işlem başına bir kez yüklenir');
    }
    const metrics = snapshotOperations();
    const authorization = metrics.find(row => row.operation === 'phase.commit.authorization');
    assert.equal(authorization.count, 2, 'her denemenin ilk yetki yüklemesi bir kez ölçülür');
    assert.equal(authorization.avgMs, 250, 'asıl sorgu yetki fazında ölçülür');
    assert.equal(metrics.find(row => row.operation === 'phase.commit.intent-validation').avgMs, 0, 'niyet fazı yetki sorgusunu içermez');
    assert.ok(attempts[0].statementIndex >= firstStatement);
    assert.equal(lead.db.tasks.find((row) => String(row.TaskId).toLowerCase() === LONE_TASK_ID).Title, 'Yinelenen kayıt');
  } finally {
    await lead.dispose();
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
    const statementStart = lead.db.statements.length;
    const response = await fetch('http://localhost/api/mergen-rota/commit', {
      method: 'POST', body: JSON.stringify({ changes: { taskDeletes: [{ id: HIDDEN_TASK_ID, version: predecessor.version }] } })
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error.details.code, 'TASK_DEPENDENCY_RECONCILIATION_REQUIRED');
    assert.deepEqual(body.error.details.taskIds, [SUCCESSOR_TASK_ID], 'FULL yetkili ardılları zaten görür');
    assert.equal(lead.db.statements.slice(statementStart).filter(({ sql }) => sql.includes('SELECT TOP (1) ProjectId') && sql.includes('FROM dbo.MR_Tasks WITH (UPDLOCK, HOLDLOCK)')).length,
      1, 'uzlaştırma niyet denetimindeki kilitli proje sonucunu yeniden sorgulamadan kullanır');
    // Görünürlük süzgeci aktörsüz çağrıda her öncülü düşürürdü; denetim sessizce atlanmaz, çağrı reddedilir.
    const { assertTaskDependencyReconciliationCovered } = await import('../src/server/repository/dependencyReconciliationValidation.js');
    const executor = { request: () => ({ input() {}, query: async () => ({ recordset: [] }) }) };
    await assert.rejects(assertTaskDependencyReconciliationCovered(executor, { taskDeletes: [{ id: HIDDEN_TASK_ID, version: predecessor.version }] }), TypeError);
  } finally {
    await lead.dispose();
  }
});


test('FULL kaynak proje yetkisi gizli öncülleri açmaz; görünür öncüller ayrıntılı çapraz proje kuralını korur', async () => {
  const lead = await disclosureStack(900010);
  try {
    const { CORPORATE_PROJECT_ID, CORPORATE_ROOT_WBS_ID } = await import('./helpers/actualStack.mjs');
    const hidden = lead.db.tasks.find(row => String(row.TaskId).toLowerCase() === HIDDEN_TASK_ID);
    hidden.CreatedBySicil = MANAGER_SICIL;
    hidden.ProjectId = MANUAL_PROJECT_ID.toUpperCase();
    hidden.WbsId = MANUAL_ROOT_WBS_ID.toUpperCase();
    lead.db.projects.find(row => String(row.ProjectId).toLowerCase() === MANUAL_PROJECT_ID).LeadSicil = MANAGER_SICIL;
    const taskId = 'c1c1c1c1-0000-4000-8000-0000000000d1';
    const task = (predecessorId) => ({ id: taskId, projectId: CORPORATE_PROJECT_ID, wbsId: CORPORATE_ROOT_WBS_ID,
      task: 'Öncül yoklama', status: 'planned', priority: 'medium', assigneeIds: [],
      deps: [{ predecessorId, type: 'FS', lagDays: 0 }] });
    const attempt = predecessor => probe({ taskUpserts: [task(predecessor)] }, predecessor);
    const missing = await attempt(MISSING_TASK_ID);
    assert.equal(await attempt(HIDDEN_TASK_ID), missing, 'yanıtın tamamı aynı olmalıdır');
    const raw = await probe({ taskUpserts: [task(HIDDEN_TASK_ID)] });
    const saved = structuredClone(lead.db.tasks);
    lead.db.tasks = lead.db.tasks.filter(row => String(row.TaskId).toLowerCase() !== HIDDEN_TASK_ID);
    assert.equal(await probe({ taskUpserts: [task(HIDDEN_TASK_ID)] }), raw, 'aynı gönderilen kimlikte gizli-var ve yok yanıtları bayt bayt aynıdır');
    lead.db.tasks = saved;
    assert.match(missing, /DEPENDENCY_TARGET_NOT_FOUND/);
    assert.doesNotMatch(missing, new RegExp(MANUAL_PROJECT_ID));
    assert.equal(lead.db.tasks.some(row => String(row.TaskId).toLowerCase() === taskId), false);
    lead.db.projectAccess.push({ ProjectId: MANUAL_PROJECT_ID.toUpperCase(), Sicil: 900010, AccessLevel: 'READ', GrantSource: 'MANUAL_GRANT', IsActive: 1 });
    assert.match(await attempt(HIDDEN_TASK_ID), /CROSS_PROJECT_DEPENDENCY/);
    assert.match(await attempt(LONE_TASK_ID), /^200 /, 'aynı projedeki görünür öncül kabul edilir');
  } finally { await lead.dispose(); }
});

test('kısmi oluşturucunun silme yetkisi gizli bağımlılık varlığından bağımsızdır; FULL silme atomiktir', async () => {
  const manager = await disclosureStack(MANAGER_SICIL);
  try {
    const { CORPORATE_PROJECT_ID } = await import('./helpers/actualStack.mjs');
    for (const task of manager.db.tasks) task.CreatedBySicil = MANAGER_SICIL;
    const snapshot = await manager.repository.loadSnapshot();
    const get = id => snapshot.tasks.find(task => String(task.id).toLowerCase() === id);
    const attempt = id => probe({ taskDeletes: [{ id, version: get(id).version }] }, id);
    const firstStatement = manager.db.statements.length;
    const withDependencies = await attempt(HIDDEN_TASK_ID);
    assert.equal(withDependencies, await attempt(LONE_TASK_ID));
    assert.match(withDependencies, /^403 .*Görev silme işlemi tam proje yetkisi/);
    assert.doesNotMatch(withDependencies, new RegExp(SUCCESSOR_TASK_ID));
    assert.equal(manager.db.tasks.length, 3);
    assert.equal(manager.db.taskDependencies.length, 1);
    assert.equal(manager.db.statements.slice(firstStatement).some(statement => statement.sql.includes('MR_TaskDependencies')), false, 'ret ilişki sorgusu çalıştırmaz');
    // Var olmayan ilişki ve gizli ilişki aynı kararı verir; silme ilişkileri okumaz.
    manager.db.taskDependencies = [];
    assert.equal(await attempt(HIDDEN_TASK_ID), withDependencies);
    manager.db.taskDependencies.push({ ProjectId: CORPORATE_PROJECT_ID, TaskId: SUCCESSOR_TASK_ID, PredecessorTaskId: HIDDEN_TASK_ID, DependencyType: 'FS', LagDays: 0 });
    manager.db.corporateProjectAccess.push({ ProjectCode: 'P4417041', Sicil: MANAGER_SICIL, RoleCode: 'PROJECT_MANAGER' });
    const full = await manager.repository.loadSnapshot();
    const predecessor = full.tasks.find(task => String(task.id).toLowerCase() === HIDDEN_TASK_ID);
    const successor = full.tasks.find(task => String(task.id).toLowerCase() === SUCCESSOR_TASK_ID);
    manager.db.commitHook = () => { throw new Error('rollback-test'); };
    await assert.rejects(manager.repository.commitChanges({ taskDeletes: [{ id: predecessor.id, version: predecessor.version }], taskUpserts: [{ ...successor, deps: [] }] }));
    assert.equal(manager.db.tasks.length, 3);
    assert.equal(manager.db.taskDependencies.length, 1, 'başarısız silme ilişkiyi de geri alır');
    manager.db.commitHook = null;
    await manager.repository.commitChanges({ taskDeletes: [{ id: predecessor.id, version: predecessor.version }], taskUpserts: [{ ...successor, deps: [] }] });
    assert.equal(manager.db.tasks.length, 2);
    assert.equal(manager.db.taskDependencies.length, 0);
  } finally { await manager.dispose(); }
});

test('FULL yönetici sorumlusuz veya kapsam dışı sorumlulu görevi silebilir; denetim ve geri alma korunur', async () => {
  for (const assignees of [[], [PLAIN_SICIL]]) {
    const stack = await disclosureStack(MANAGER_SICIL);
    try {
      stack.db.corporateProjectAccess.push({ ProjectCode: 'P4417041', Sicil: MANAGER_SICIL, RoleCode: 'PROJECT_MANAGER' });
      stack.db.taskAssignees = stack.db.taskAssignees.filter(row => String(row.TaskId).toLowerCase() !== LONE_TASK_ID);
      stack.db.taskAssignees.push(...assignees.map(Sicil => ({ TaskId: LONE_TASK_ID.toUpperCase(), Sicil })));
      const snapshot = await stack.repository.loadSnapshot();
      const task = snapshot.tasks.find(task => String(task.id).toLowerCase() === LONE_TASK_ID);
      assert.ok(task?.version, 'FULL görüntü, atama kapsamı dışındaki görevi de gösterir');
      const changes = { taskDeletes: [{ id: task.id, version: task.version }] };
      const before = JSON.stringify({ tasks: stack.db.tasks, assignees: stack.db.taskAssignees, dependencies: stack.db.taskDependencies, audit: stack.db.auditLog });
      let reachedCommit = false;
      stack.db.commitHook = () => { reachedCommit = true; throw new Error('delete-rollback'); };
      await assert.rejects(stack.repository.commitChanges(changes));
      assert.equal(reachedCommit, true, 'silme commit aşamasına ulaşır');
      assert.equal(JSON.stringify({ tasks: stack.db.tasks, assignees: stack.db.taskAssignees, dependencies: stack.db.taskDependencies, audit: stack.db.auditLog }), before);
      stack.db.commitHook = null;
      await stack.repository.commitChanges(changes);
      assert.equal(stack.db.tasks.some(row => String(row.TaskId).toLowerCase() === LONE_TASK_ID), false);
      assert.equal(stack.db.taskAssignees.some(row => String(row.TaskId).toLowerCase() === LONE_TASK_ID), false);
      assert.equal(stack.db.taskDependencies.length, 1, 'ilgisiz bağımlılıklar korunur');
      const deletion = stack.db.auditLog.find(row => row.ActionCode === 'DELETE' && String(row.EntityId).toLowerCase() === LONE_TASK_ID);
      assert.deepEqual(JSON.parse(deletion.BeforeJson).assigneeIds, assignees, 'kilitli sorumlu okuması silme denetim kaydında korunur');
    } finally { await stack.dispose(); }
  }
});

test('FULL silme düzeltmesi etkin olmayan proje kapısını aşamaz', async () => {
  const stack = await disclosureStack(MANAGER_SICIL);
  try {
    const { createSqlAppRepository } = await import('../src/server/repository/sqlAppRepository.js');
    // Sistem yöneticisi FULL kapısını geçse bile temel depoda etkinlik denetlenir.
    stack.db.systemAdminSicils.push(MANAGER_SICIL);
    const snapshot = await stack.repository.loadSnapshot();
    const task = snapshot.tasks.find(task => String(task.id).toLowerCase() === LONE_TASK_ID);
    for (const project of stack.db.projects) project.IsActive = 0;
    await assert.rejects(createSqlAppRepository().commitChanges({ taskDeletes: [{ id: task.id, version: task.version }] }), {
      code: 'FORBIDDEN', message: 'Etkin olmayan bir projede görev yazılamaz.'
    });
    assert.equal(stack.db.tasks.length, 3);
    assert.equal(stack.db.taskDependencies.length, 1);
  } finally { await stack.dispose(); }
});

test('gizli ve olmayan hedef projeler aynı tam yanıtı verir; görünür ve kurumsal atama korunur', async () => {
  const { CORPORATE_PROJECT_ID, CORPORATE_ROOT_WBS_ID } = await import('./helpers/actualStack.mjs');
  for (const sicil of [PLAIN_SICIL, MANAGER_SICIL]) {
    const stack = await disclosureStack(sicil);
    try {
      const taskId = 'c1c1c1c1-0000-4000-8000-0000000000d1';
      const task = (projectId, wbsId = null) => ({
        id: taskId, projectId, wbsId, task: 'Yeni görev', status: 'planned', priority: 'medium',
        assigneeIds: [String(sicil === MANAGER_SICIL ? SUBORDINATE_SICIL : sicil)], deps: []
      });
      const attempt = async (projectId) => {
        const start = stack.db.statements.length;
        const response = await fetch('http://localhost/api/mergen-rota/commit', { method: 'POST',
          body: JSON.stringify({ changes: { taskUpserts: [task(projectId)] } }) });
        return { status: response.status, body: await response.text(), headers: [...response.headers].map(([name, value]) => [name, name === 'x-mergen-rota-correlation-id' ? '<correlation>' : value]),
          queries: stack.db.statements.slice(start).map(entry => entry.sql) };
      };
      const before = JSON.stringify(stack.db.tasks);
      const hidden = await attempt(MANUAL_PROJECT_ID);
      const missing = await attempt('c1c1c1c1-0000-4000-8000-0000000000d2');
      // İstemcinin bildiği hedef kimliği ve istek başına rastgele korelasyon değeri dışında yanıt bütünüyle aynıdır.
      assert.deepEqual({ ...hidden, body: hidden.body.replaceAll(MANUAL_PROJECT_ID, '<id>') },
        { ...missing, body: missing.body.replaceAll('c1c1c1c1-0000-4000-8000-0000000000d2', '<id>') });
      assert.equal(hidden.status, 400);
      assert.equal(JSON.stringify(stack.db.tasks), before, 'her iki ret de hiçbir görev yazmaz');
      // Aynı istek kimliğiyle satırın varlığı değiştirildiğinde de ham yanıt aynıdır.
      const row = stack.db.projects.findIndex(item => String(item.ProjectId).toLowerCase() === MANUAL_PROJECT_ID);
      const [removed] = stack.db.projects.splice(row, 1);
      assert.deepEqual(await attempt(MANUAL_PROJECT_ID), hidden);
      stack.db.projects.push(removed);
      if (sicil === MANAGER_SICIL) {
        stack.db.taskAssignees = []; // Kurumsal hedef artık PARTIAL görünürlük de sağlamaz.
        assert.match(await probe({ taskUpserts: [task(CORPORATE_PROJECT_ID, CORPORATE_ROOT_WBS_ID)] }, taskId), /^200 /,
          'görünür olmayan kurumsal projeye mevcut yönetici atama kapsamı korunur');
      } else {
        stack.db.projectAccess.push({ ProjectId: MANUAL_PROJECT_ID, Sicil: sicil, AccessLevel: 'FULL', GrantSource: 'MANUAL_GRANT', IsActive: 1 });
        assert.match(await probe({ taskUpserts: [task(MANUAL_PROJECT_ID, MANUAL_ROOT_WBS_ID)] }, taskId), /^200 /);
      }
      assert.equal(stack.db.tasks.length, JSON.parse(before).length + 1);
    } finally { await stack.dispose(); }
  }
});

test('assignment-only creation rejects personnel scope before inspecting directory membership', async () => {
  const { CORPORATE_PROJECT_ID, CORPORATE_ROOT_WBS_ID } = await import('./helpers/actualStack.mjs');
  const stack = await disclosureStack(MANAGER_SICIL);
  try {
    const task = { id: MISSING_TASK_ID, projectId: CORPORATE_PROJECT_ID, wbsId: CORPORATE_ROOT_WBS_ID, calendarId: null, task: 'New assignment', status: 'planned', priority: 'medium', milestone: false,
      plannedStart: null, plannedFinish: null, plannedDurationDays: null, targetFinish: null, actualStart: null, actualFinish: null, remainingDurationDays: null, progress: 0,
      description: null, keyword: null, plannedHours: null, actualHours: null, budget: null, spent: null, assigneeIds: ['900010'], deps: [] };
    const existing = await probe({ taskUpserts: [task] }, MISSING_TASK_ID);
    stack.db.people = stack.db.people.filter((person) => person.Sicil !== 900010);
    assert.equal(await probe({ taskUpserts: [task] }, MISSING_TASK_ID), existing); assert.match(existing, /^403 .*FORBIDDEN/);
    task.assigneeIds = [String(SUBORDINATE_SICIL)]; assert.match(await probe({ taskUpserts: [task] }, MISSING_TASK_ID), /^200 /);
  } finally { await stack.dispose(); }
});

test('creation collision checks cannot disclose hidden task/WBS IDs to an unauthorized destination writer', async () => {
  const { CORPORATE_PROJECT_ID } = await import('./helpers/actualStack.mjs');
  const stack = await disclosureStack(PLAIN_SICIL);
  try {
    for (const [collection, id, table, key] of [['taskUpserts', HIDDEN_TASK_ID, 'tasks', 'TaskId'], ['wbsUpserts', HIDDEN_WBS_ID, 'wbs', 'WbsId']]) {
      const entry = collection === 'taskUpserts' ? { id, projectId: CORPORATE_PROJECT_ID, task: 'new', assigneeIds: [String(PLAIN_SICIL)], deps: [] } : { id, projectId: CORPORATE_PROJECT_ID, parentId: null, code: 'new', name: 'new', sortOrder: 0 };
      const existing = await probe({ [collection]: [entry] }, id);
      stack.db[table] = stack.db[table].filter(row => String(row[key]).toLowerCase() !== id);
      assert.equal(await probe({ [collection]: [entry] }, id), existing); assert.doesNotMatch(existing, /UPSERT_CREATE_COLLISION/); assert.match(existing, /^400 .*MUTATION_FAILED/);
    }
  } finally { await stack.dispose(); }
});

for (const scenario of ['corporate-wbs', 'narrow-assignees', 'narrow-fields', 'assignment-wbs', 'missing-dependency', 'hidden-dependency', 'missing-parent']) {
  test(`invalid create has identical hidden/unused candidate-ID rejection (${scenario})`, async () => {
    const { CORPORATE_PROJECT_ID, CORPORATE_ROOT_WBS_ID } = await import('./helpers/actualStack.mjs');
    const narrow = scenario.startsWith('narrow');
    const stack = await disclosureStack(narrow ? PLAIN_SICIL : MANAGER_SICIL);
    try {
      // The probed ID is truly hidden, in another project, with no direct grant.
      const hidden = stack.db.tasks.find((row) => row.TaskId.toLowerCase() === HIDDEN_TASK_ID);
      hidden.ProjectId = MANUAL_PROJECT_ID; hidden.WbsId = MANUAL_ROOT_WBS_ID;
      if (narrow) stack.db.taskAssignees.find((row) => row.TaskId.toLowerCase() === LONE_TASK_ID).Sicil = PLAIN_SICIL;
      if (['corporate-wbs', 'missing-dependency', 'hidden-dependency', 'missing-parent'].includes(scenario)) {
        stack.db.projectAccess.push({ ProjectId: CORPORATE_PROJECT_ID, Sicil: MANAGER_SICIL, AccessLevel: 'FULL', IsActive: 1 });
      }
      const task = { id: HIDDEN_TASK_ID, projectId: CORPORATE_PROJECT_ID, wbsId: CORPORATE_ROOT_WBS_ID,
        task: 'Candidate', status: 'planned', priority: 'medium', assigneeIds: [String(narrow ? PLAIN_SICIL : SUBORDINATE_SICIL)], deps: [] };
      if (scenario === 'narrow-assignees') task.assigneeIds = [String(SUBORDINATE_SICIL)];
      if (scenario === 'narrow-fields') task.isMilestone = true;
      if (scenario === 'assignment-wbs') task.wbsId = HIDDEN_WBS_ID;
      if (scenario.endsWith('dependency')) task.deps = [{ predecessorId: scenario === 'hidden-dependency' ? SUCCESSOR_TASK_ID : MISSING_TASK_ID, type: 'FS', lagDays: 0 }];
      if (scenario === 'missing-parent') { task.recurrenceParentId = MISSING_TASK_ID; task.recurrenceOccurrenceDate = '2026-08-24'; }
      const collection = scenario === 'corporate-wbs' ? 'wbsUpserts' : 'taskUpserts';
      const entry = collection === 'wbsUpserts' ? { id: HIDDEN_WBS_ID, projectId: CORPORATE_PROJECT_ID, parentId: CORPORATE_ROOT_WBS_ID, code: 'new', name: 'new' } : task;
      if (scenario === 'hidden-dependency') {
        const predecessor = stack.db.tasks.find((row) => row.TaskId.toLowerCase() === SUCCESSOR_TASK_ID);
        predecessor.ProjectId = MANUAL_PROJECT_ID; predecessor.WbsId = MANUAL_ROOT_WBS_ID;
        stack.db.taskAssignees = stack.db.taskAssignees.filter((row) => row.TaskId.toLowerCase() !== SUCCESSOR_TASK_ID);
      }
      const existingId = entry.id;
      const before = JSON.stringify(stack.db.tasks);
      const existing = await probe({ [collection]: [entry] }, existingId);
      const compare = async (id) => probe({ [collection]: [{ ...entry, id }] }, id);
      const first = existing;
      const missing = await compare(collection === 'wbsUpserts' ? MISSING_WBS_ID : 'c1c1c1c1-0000-4000-8000-0000000000fd');
      assert.equal(first, missing); assert.doesNotMatch(first, /UPSERT_CREATE_COLLISION/);
      entry.version = ' ';
      assert.equal(await compare(existingId), await compare(collection === 'wbsUpserts' ? MISSING_WBS_ID : 'c1c1c1c1-0000-4000-8000-0000000000fd'), 'blank versions retain create intent at every boundary');
      assert.match(first, scenario.endsWith('dependency') ? /DEPENDENCY_TARGET_NOT_FOUND/ : scenario === 'missing-parent' ? /Tekrar şablonu bulunamadı/ : /FORBIDDEN/);
      assert.equal(JSON.stringify(stack.db.tasks), before);
    } finally { await stack.dispose(); }
  });
}

test('otherwise authorized creation retains the narrow F-024 collision residual without overwrite', async () => {
  const { CORPORATE_PROJECT_ID, CORPORATE_ROOT_WBS_ID } = await import('./helpers/actualStack.mjs');
  const stack = await disclosureStack(PLAIN_SICIL);
  try {
    const hidden = stack.db.tasks.find((row) => row.TaskId.toLowerCase() === HIDDEN_TASK_ID);
    hidden.ProjectId = MANUAL_PROJECT_ID; hidden.WbsId = MANUAL_ROOT_WBS_ID;
    stack.db.projectAccess.push({ ProjectId: CORPORATE_PROJECT_ID, Sicil: PLAIN_SICIL, AccessLevel: 'FULL', IsActive: 1 });
    const task = { projectId: CORPORATE_PROJECT_ID, wbsId: CORPORATE_ROOT_WBS_ID, task: 'Authorized create', status: 'planned', priority: 'medium', assigneeIds: [String(PLAIN_SICIL)], deps: [] };
    const before = JSON.stringify(hidden);
    assert.match(await probe({ taskUpserts: [{ ...task, id: HIDDEN_TASK_ID }] }, HIDDEN_TASK_ID), /^409 .*UPSERT_CREATE_COLLISION/);
    assert.equal(JSON.stringify(stack.db.tasks.find((row) => row.TaskId.toLowerCase() === HIDDEN_TASK_ID)), before);
    assert.match(await probe({ taskUpserts: [{ ...task, id: MISSING_TASK_ID }] }, MISSING_TASK_ID), /^200 /);
  } finally { await stack.dispose(); }
});
