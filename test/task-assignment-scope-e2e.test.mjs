/**
 * Görev atama kapsamının SUNUCU tarafındaki sınırı.
 *
 * Zincir gerçek kodla kurulur: istemci deposu → gerçek rota gövdeleri → sıralı
 * ve sertleştirilmiş SQL deposu → bellek içi SQL Server ikizi. İstemci
 * denetimlerini atlayan bir istek de aynı yanıtı alır: yetki kararı yalnızca
 * sunucuda verilir.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CORPORATE_PROJECT_ID, CORPORATE_ROOT_WBS_ID, corporateSeed, createActualStack } from './helpers/actualStack.mjs';

const MANAGER_SICIL = 900500;
const SUBORDINATE_SICIL = 900501;
const OUTSIDER_SICIL = 900502;
const PLAIN_SICIL = 900503;
const NEW_TASK_ID = 'aa11bb22-cc33-4d44-8e55-ff6677889900';

/**
 * Tohum: kurumsal proje, hiç kimseye "corporateprojectaccess" vermez.
 * Yönetici yalnızca `MR_V_ExecutiveScope` üzerinden astına sahiptir.
 */
function assignmentSeed(overrides = {}) {
  const base = corporateSeed();
  return {
    ...base,
    people: [
      ...base.people,
      { Sicil: MANAGER_SICIL, DisplayName: 'Birim Yöneticisi', Username: 'byonetici' },
      { Sicil: SUBORDINATE_SICIL, DisplayName: 'Ast Personel', Username: 'astpersonel' },
      { Sicil: OUTSIDER_SICIL, DisplayName: 'Başka Birim', Username: 'baskabirim' },
      { Sicil: PLAIN_SICIL, DisplayName: 'Sıradan Kullanıcı', Username: 'siradan' }
    ],
    // Tohumdaki SYSTEM_ADMIN kaldırılır: kapsam denetimi rol karışmadan sınanır.
    systemAdminSicils: [],
    corporateProjectAccess: [],
    executiveScope: [
      { ManagerSicil: MANAGER_SICIL, EmployeeSicil: SUBORDINATE_SICIL, ScopeType: 'UNIT' }
    ],
    ...overrides
  };
}

function taskChanges({ assigneeIds }) {
  return {
    taskUpserts: [{
      id: NEW_TASK_ID,
      projectId: CORPORATE_PROJECT_ID,
      wbsId: CORPORATE_ROOT_WBS_ID,
      task: 'Yöneticinin atadığı iş',
      keyword: 'Atama',
      status: 'todo',
      priority: 'medium',
      plannedStart: '2026-08-17',
      plannedFinish: '2026-08-20',
      targetFinish: '2026-08-20',
      assigneeIds,
      deps: []
    }]
  };
}

test('yönetici, erişimi olmayan CN43N projesinde kendi personeline görev tanımlayabilir', async () => {
  const stack = await createActualStack(assignmentSeed(), { sicil: MANAGER_SICIL });
  try {
    const session = await stack.repository.loadSessionContext();
    assert.equal(session.isExecutive, true);
    assert.equal(session.isSystemAdmin, false);
    // Proje seçicisi bütün etkin CN43N projelerini taşır…
    const snapshot = await stack.repository.loadSnapshot();
    assert.deepEqual(snapshot.assignableProjects.map((project) => project.code), ['P4417041']);
    assert.equal(snapshot.assignableProjects[0].rootWbsId != null, true);
    // …ama proje GÖRÜNÜR listede yoktur: çalışma alanı ve raporlar değişmez.
    assert.deepEqual(snapshot.projects, []);
    assert.deepEqual(snapshot.tasks, []);

    const committed = await stack.repository.commitChanges(taskChanges({ assigneeIds: [String(SUBORDINATE_SICIL)] }));
    assert.equal(committed.taskUpserts.length, 1);
    assert.equal(committed.taskUpserts[0].task, 'Yöneticinin atadığı iş');
  } finally {
    await stack.dispose();
  }
});

test('yönetici kendi personeli olmayan birine görev atayamaz', async () => {
  const stack = await createActualStack(assignmentSeed(), { sicil: MANAGER_SICIL });
  try {
    await assert.rejects(
      stack.repository.commitChanges(taskChanges({ assigneeIds: [String(OUTSIDER_SICIL)] })),
      (error) => {
        assert.equal(error.code, 'FORBIDDEN');
        assert.match(error.message, /yalnızca kendi personelinize atanabilir/);
        return true;
      }
    );
  } finally {
    await stack.dispose();
  }
});

test('sorumlusuz görev atama kapsamıyla oluşturulamaz', async () => {
  const stack = await createActualStack(assignmentSeed(), { sicil: MANAGER_SICIL });
  try {
    await assert.rejects(
      stack.repository.commitChanges(taskChanges({ assigneeIds: [] })),
      (error) => {
        assert.equal(error.code, 'FORBIDDEN');
        assert.match(error.message, /en az bir sorumlusu olmalıdır/);
        return true;
      }
    );
  } finally {
    await stack.dispose();
  }
});

test('sıradan kullanıcı erişimi olmayan projeye görev yazamaz', async () => {
  const stack = await createActualStack(assignmentSeed(), { sicil: PLAIN_SICIL });
  try {
    const snapshot = await stack.repository.loadSnapshot();
    // Kurumsal katalog seçiciye AÇILMAZ.
    assert.deepEqual(snapshot.assignableProjects, []);
    const session = await stack.repository.loadSessionContext();
    assert.equal(session.canAssignAllCorporateProjects, false);

    await assert.rejects(
      stack.repository.commitChanges(taskChanges({ assigneeIds: [String(PLAIN_SICIL)] })),
      (error) => {
        assert.equal(error.code, 'FORBIDDEN');
        assert.match(error.message, /tam yazma yetkiniz yok/);
        return true;
      }
    );
  } finally {
    await stack.dispose();
  }
});

test('atama kapsamı proje üst verisi ya da iş dağılım ağacı yazmasına açılmaz', async () => {
  const stack = await createActualStack(assignmentSeed(), { sicil: MANAGER_SICIL });
  try {
    // Proje güncellemesi hâlâ TAM yetki ister; yazma hiçbir biçimde geçmez.
    await assert.rejects(stack.repository.commitChanges({
      projectUpserts: [{
        id: CORPORATE_PROJECT_ID,
        source: 'corporate',
        code: 'P4417041',
        name: 'Değiştirilmiş ad',
        color: 'red'
      }]
    }));
    assert.equal(stack.db.projects[0].ProjectName, 'İHA Hava Savunma Sistemi ELDD Projesi');

    // İş dağılım ağacına düğüm eklemek de reddedilir.
    await assert.rejects(
      stack.repository.commitChanges({
        wbsUpserts: [{
          id: 'bb22cc33-dd44-4e55-8f66-778899001122',
          projectId: CORPORATE_PROJECT_ID,
          parentId: CORPORATE_ROOT_WBS_ID,
          code: 'P4417041.1',
          name: 'Yeni düğüm',
          sortOrder: 1
        }]
      }),
      (error) => {
        assert.equal(error.code, 'FORBIDDEN');
        return true;
      }
    );
    assert.equal(stack.db.wbs.length, 1, 'yeni düğüm yazılmamalıdır');
  } finally {
    await stack.dispose();
  }
});

test('kurumsal erişimi olan kullanıcı için davranış değişmez', async () => {
  const seed = assignmentSeed({
    corporateProjectAccess: [{ ProjectCode: 'P4417041', Sicil: PLAIN_SICIL, RoleCode: 'PROJECT_MANAGER' }]
  });
  const stack = await createActualStack(seed, { sicil: PLAIN_SICIL });
  try {
    const snapshot = await stack.repository.loadSnapshot();
    // Proje GÖRÜNÜR listede ve tam yetkilidir; ek seçilebilir liste boştur.
    assert.deepEqual(snapshot.projects.map((project) => project.accessLevel), ['FULL']);
    assert.deepEqual(snapshot.assignableProjects, []);
    const committed = await stack.repository.commitChanges(taskChanges({ assigneeIds: [String(PLAIN_SICIL)] }));
    assert.equal(committed.taskUpserts.length, 1);
  } finally {
    await stack.dispose();
  }
});

test('yönetici, astına atanmış görevi görmeye devam eder', async () => {
  const seed = assignmentSeed({
    tasks: [{
      TaskId: 'cc33dd44-ee55-4f66-8071-8899aabbccdd',
      ProjectId: CORPORATE_PROJECT_ID,
      WbsId: CORPORATE_ROOT_WBS_ID,
      Title: 'Astın görevi',
      Status: 'planned',
      Priority: 'medium',
      TargetFinish: '2026-08-25'
    }, {
      TaskId: 'dd44ee55-ff66-4071-8899-aabbccddeeff',
      ProjectId: CORPORATE_PROJECT_ID,
      WbsId: CORPORATE_ROOT_WBS_ID,
      Title: 'İlgisiz görev',
      Status: 'planned',
      Priority: 'medium',
      TargetFinish: '2026-08-25'
    }],
    taskAssignees: [
      { TaskId: 'cc33dd44-ee55-4f66-8071-8899aabbccdd', Sicil: SUBORDINATE_SICIL },
      { TaskId: 'dd44ee55-ff66-4071-8899-aabbccddeeff', Sicil: OUTSIDER_SICIL }
    ]
  });
  const stack = await createActualStack(seed, { sicil: MANAGER_SICIL });
  try {
    const snapshot = await stack.repository.loadSnapshot();
    // Görev görünürlüğü DEĞİŞMEZ: yalnızca astın görevi gelir, projedeki
    // öteki görevler gelmez.
    assert.deepEqual(snapshot.tasks.map((task) => task.task), ['Astın görevi']);
  } finally {
    await stack.dispose();
  }
});
