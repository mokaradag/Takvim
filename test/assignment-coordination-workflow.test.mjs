import assert from 'node:assert/strict';
import test from 'node:test';

import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

/**
 * Kurum dışı atama koordinasyonunun uçtan uca gerilemeleri.
 *
 * Sözleşmenin değişmezi tektir: TALEP EDİLEN sorumlu onaylanana kadar
 * `MR_TaskAssignees` satırı yazılmaz. Bütün yetki kararları sunucuda yeniden
 * doğrulanır; istemci anahtarları yalnızca arayüzdür.
 */

const PROJECT_ID = '44444444-4444-4444-8444-000000000001';
const ROOT_WBS_ID = '44444444-4444-4444-8444-000000000002';
const TASK_ID = '44444444-4444-4444-8444-000000000003';
const OTHER_TASK_ID = '44444444-4444-4444-8444-000000000004';

const ORDINARY = 950001;
const EXTERNAL = 950002;
const UNIT_MANAGER = 950003;
const DEPARTMENT_MANAGER = 950004;
const DIRECTORATE_MANAGER = 950005;
const DUAL_MANAGER = 950006;
const DUAL_EMPLOYEE = 950007;
const SAME_NAME_A = 950008;
const SAME_NAME_B = 950009;
const EXECUTIVE = 950010;
const TEAM_MEMBER = 950011;
const PROJECT_MANAGER = 950012;

const OWN_ORG = { Directorate: 'Yazılım Direktörlüğü', Department: 'Gömülü Müdürlüğü', Unit: 'Doğrulama Birimi' };
const OTHER_ORG = { Directorate: 'Üretim Direktörlüğü', Department: 'Montaj Müdürlüğü', Unit: 'Hat 1 Birimi' };

function directory() {
  return [
    { Sicil: ORDINARY, DisplayName: 'Olağan Kullanıcı', Username: 'u950001', ...OWN_ORG },
    { Sicil: EXTERNAL, DisplayName: 'Dış Birim Personeli', Username: 'u950002', ...OTHER_ORG },
    { Sicil: UNIT_MANAGER, DisplayName: 'Birim Yöneticisi', Username: 'u950003', ...OTHER_ORG },
    { Sicil: DEPARTMENT_MANAGER, DisplayName: 'Müdürlük Yöneticisi', Username: 'u950004', ...OTHER_ORG },
    { Sicil: DIRECTORATE_MANAGER, DisplayName: 'Direktörlük Yöneticisi', Username: 'u950005', ...OTHER_ORG },
    { Sicil: DUAL_MANAGER, DisplayName: 'Çift Rollü Yönetici', Username: 'u950006', ...OTHER_ORG },
    { Sicil: DUAL_EMPLOYEE, DisplayName: 'Çift Rollü Astı', Username: 'u950007', ...OTHER_ORG },
    { Sicil: SAME_NAME_A, DisplayName: 'Aynı Ad', Username: 'u950008', ...OWN_ORG },
    { Sicil: SAME_NAME_B, DisplayName: 'Aynı Ad', Username: 'u950009', ...OTHER_ORG },
    { Sicil: EXECUTIVE, DisplayName: 'Yönetici Kullanıcı', Username: 'u950010', ...OWN_ORG },
    { Sicil: TEAM_MEMBER, DisplayName: 'Ekip Üyesi', Username: 'u950011', ...OWN_ORG },
    { Sicil: PROJECT_MANAGER, DisplayName: 'Proje Yöneticisi', Username: 'u950012', ...OWN_ORG }
  ];
}

function executiveScope() {
  return [
    { ManagerSicil: UNIT_MANAGER, EmployeeSicil: EXTERNAL, ScopeType: 'UNIT' },
    { ManagerSicil: DEPARTMENT_MANAGER, EmployeeSicil: EXTERNAL, ScopeType: 'DEPARTMENT' },
    // Direktörlük zinciri BİLİNÇLİ olarak bildirim kapsamının dışındadır.
    { ManagerSicil: DIRECTORATE_MANAGER, EmployeeSicil: EXTERNAL, ScopeType: 'DIRECTORATE' },
    // Aynı kişi iki rolü birden taşır: alıcı kümesinde TEK kez görünmelidir.
    { ManagerSicil: DUAL_MANAGER, EmployeeSicil: DUAL_EMPLOYEE, ScopeType: 'UNIT' },
    { ManagerSicil: DUAL_MANAGER, EmployeeSicil: DUAL_EMPLOYEE, ScopeType: 'DEPARTMENT' },
    { ManagerSicil: EXECUTIVE, EmployeeSicil: TEAM_MEMBER, ScopeType: 'UNIT' },
    { ManagerSicil: UNIT_MANAGER, EmployeeSicil: SAME_NAME_B, ScopeType: 'UNIT' }
  ];
}

function seed(overrides = {}) {
  return {
    calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Kurumsal Takvim', IsDefault: 1, IsActive: 1 }],
    people: directory(),
    executiveScope: executiveScope(),
    corporateProjects: [{ ProjectCode: 'P9000001', ProjectName: 'Koordinasyon Projesi', ProjectTypeCode: 'GD', ProjectTypeName: 'Garanti dışı' }],
    corporateProjectAccess: [{ ProjectCode: 'P9000001', Sicil: PROJECT_MANAGER, RoleCode: 'PROJECT_MANAGER' }],
    projects: [{
      ProjectId: PROJECT_ID,
      SourceType: 'CORPORATE',
      ProjectCode: 'P9000001',
      ProjectName: 'Koordinasyon Projesi',
      ProjectTypeCode: 'GD',
      ProjectTypeName: 'Garanti dışı',
      LeadSicil: PROJECT_MANAGER,
      CalendarId: DEFAULT_CALENDAR_ID,
      IsActive: 1
    }],
    wbs: [{ WbsId: ROOT_WBS_ID, ProjectId: PROJECT_ID, ParentWbsId: null, Code: 'P9000001', Name: 'Kök', SortOrder: 0, SourceType: 'CORPORATE' }],
    tasks: [
      {
        TaskId: TASK_ID,
        ProjectId: PROJECT_ID,
        WbsId: ROOT_WBS_ID,
        CalendarId: DEFAULT_CALENDAR_ID,
        Title: 'Saha kurulum hazırlığı',
        Status: 'in_progress',
        Priority: 'high',
        PlannedStart: '2026-09-01',
        PlannedFinish: '2026-09-10',
        PlannedDurationDays: 8,
        TargetFinish: '2026-09-12',
        CreatedBySicil: ORDINARY
      },
      {
        TaskId: OTHER_TASK_ID,
        ProjectId: PROJECT_ID,
        WbsId: ROOT_WBS_ID,
        CalendarId: DEFAULT_CALENDAR_ID,
        Title: 'Yönetici görevi',
        Status: 'todo',
        Priority: 'normal',
        TargetFinish: '2026-10-01',
        CreatedBySicil: EXECUTIVE
      }
    ],
    taskAssignees: [
      { TaskId: TASK_ID, Sicil: ORDINARY },
      { TaskId: OTHER_TASK_ID, Sicil: TEAM_MEMBER }
    ],
    ...overrides
  };
}

async function asUser(sicil, run) {
  const previous = process.env.MERGEN_ROTA_DEV_SICIL;
  process.env.MERGEN_ROTA_DEV_SICIL = String(sicil);
  try { return await run(); }
  finally { process.env.MERGEN_ROTA_DEV_SICIL = previous; }
}

const store = await import('../src/server/assignment/assignmentCoordinationStore.js');
const queries = await import('../src/server/assignment/assignmentCoordinationQueries.js');
const directorySearch = await import('../src/server/directory/directorySearch.js');

function assigneesOf(stack, taskId) {
  return stack.db.taskAssignees
    .filter((row) => row.TaskId.toUpperCase() === taskId.toUpperCase())
    .map((row) => Number(row.Sicil))
    .sort((left, right) => left - right);
}

function recipientsOf(stack, coordinationId) {
  return stack.db.assignmentCoordinationRecipients
    .filter((row) => row.CoordinationId.toUpperCase() === coordinationId.toUpperCase());
}

test('sıradan kullanıcı kendini atayabilir; başkasını doğrudan atayamaz', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const task = stack.state.tasks.find((entry) => entry.id === TASK_ID);

    // Kendine atama bugünkü davranışla aynıdır: yeni görev yazılır.
    const created = await stack.repository.commitChanges({
      taskUpserts: [{
        id: '44444444-4444-4444-8444-00000000000a',
        projectId: PROJECT_ID,
        wbsId: ROOT_WBS_ID,
        task: 'Kendi görevim',
        status: 'todo',
        priority: 'normal',
        targetFinish: '2026-09-20',
        assigneeIds: [String(ORDINARY)],
        assigneeMutation: true,
        plannedHours: null, actualHours: null, budget: null, spent: null
      }]
    });
    assert.equal(created.taskUpserts.length, 1);

    // Başkasını doğrudan atamaya çalışan (sahte) istek reddedilir ve kalıcı
    // sorumlu listesi DEĞİŞMEZ.
    await assert.rejects(
      stack.repository.commitChanges({
        taskUpserts: [{ ...task, assigneeIds: [String(ORDINARY), String(EXTERNAL)], assigneeMutation: true }]
      }),
      (error) => error.code === 'FORBIDDEN'
    );
    assert.deepEqual(assigneesOf(stack, TASK_ID), [ORDINARY]);

    // Yeni görevde de dar kapsam yalnızca kişinin kendisini kabul eder.
    await assert.rejects(
      stack.repository.commitChanges({
        taskUpserts: [{
          id: '44444444-4444-4444-8444-00000000000b',
          projectId: PROJECT_ID, wbsId: ROOT_WBS_ID, task: 'Başkasına görev', status: 'todo',
          priority: 'normal', targetFinish: '2026-09-20',
          assigneeIds: [String(EXTERNAL)], assigneeMutation: true,
          plannedHours: null, actualHours: null, budget: null, spent: null
        }]
      }),
      (error) => error.code === 'FORBIDDEN'
    );
  } finally { await stack.dispose(); }
});

test('atama talebi kalıcıdır, sorumlu yazmaz ve yönetim zincirini Sicil ile çözer', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const result = await store.createAssignmentCoordination({
      taskId: TASK_ID,
      assigneeSicils: [EXTERNAL],
      message: 'Saha kurulumunda montaj desteği gerekiyor.'
    });
    assert.equal(result.ok, true);
    assert.equal(result.items.length, 1);
    const record = result.items[0];
    assert.equal(record.status, 'PENDING');
    assert.equal(record.mode, 'REQUEST');
    assert.equal(record.assigneeSicil, String(EXTERNAL));
    assert.equal(record.assigneeOrganization, 'Üretim Direktörlüğü / Montaj Müdürlüğü / Hat 1 Birimi');

    // Onaylanmadan hiçbir sorumlu satırı yazılmaz.
    assert.deepEqual(assigneesOf(stack, TASK_ID), [ORDINARY]);

    // Alıcılar birim ve müdürlük yöneticisidir; direktörlük zinciri dışarıdadır.
    const recipients = recipientsOf(stack, record.id);
    assert.deepEqual(
      recipients.filter((row) => row.RecipientRole === 'MANAGER').map((row) => row.Sicil).sort((a, b) => a - b),
      [UNIT_MANAGER, DEPARTMENT_MANAGER].sort((a, b) => a - b)
    );
    assert.equal(recipients.some((row) => row.Sicil === DIRECTORATE_MANAGER), false);
    assert.equal(recipients.filter((row) => row.RecipientRole === 'REQUESTER')[0].Sicil, ORDINARY);
    // Talep edilen kişi onay öncesinde ALICI değildir.
    assert.equal(recipients.some((row) => row.Sicil === EXTERNAL), false);
  } finally { await stack.dispose(); }
});

test('aynı yönetici iki rolü taşısa da tek alıcı satırı üretilir', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const result = await store.createAssignmentCoordination({
      taskId: TASK_ID, assigneeSicils: [DUAL_EMPLOYEE], message: 'Destek'
    });
    const managers = recipientsOf(stack, result.items[0].id).filter((row) => row.RecipientRole === 'MANAGER');
    assert.deepEqual(managers.map((row) => row.Sicil), [DUAL_MANAGER]);
  } finally { await stack.dispose(); }
});

test('yetkili yönetici onayı atamayı atomik yazar; ret ve iptal sorumluyu değiştirmez', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const first = await store.createAssignmentCoordination({ taskId: TASK_ID, assigneeSicils: [EXTERNAL], message: 'Destek' });
    const reject = await asUser(UNIT_MANAGER, () => store.decideAssignmentCoordination(first.items[0].id, {
      decision: 'REJECT', message: 'Bu dönem uygun değil.'
    }));
    assert.equal(reject.outcome, 'REJECTED');
    assert.deepEqual(assigneesOf(stack, TASK_ID), [ORDINARY]);

    const second = await store.createAssignmentCoordination({ taskId: TASK_ID, assigneeSicils: [EXTERNAL], message: 'Yeniden' });
    const approve = await asUser(UNIT_MANAGER, () => store.decideAssignmentCoordination(second.items[0].id, {
      decision: 'APPROVE', message: 'Uygundur.'
    }));
    assert.equal(approve.outcome, 'APPROVED');
    assert.deepEqual(assigneesOf(stack, TASK_ID), [ORDINARY, EXTERNAL].sort((a, b) => a - b));

    // Atanan kişi zil bildirimi alır; atayan kendine bildirim almaz.
    const notified = stack.db.taskNotifications.filter((row) => row.Kind === 'TASK_ASSIGNED');
    assert.deepEqual(notified.map((row) => row.RecipientSicil), [EXTERNAL]);
    assert.equal(notified[0].ReadAt, null);

    // Yürürlükteki atama için yönetici kaldırılma isteyebilir; talep sahibi reddederse atama kalır.
    const cancellation = await asUser(UNIT_MANAGER, () => store.decideAssignmentCoordination(second.items[0].id, {
      decision: 'REQUEST_CANCELLATION', message: 'Kapasite doldu.'
    }));
    assert.equal(cancellation.outcome, 'CANCELLATION_REQUESTED');
    const keep = await store.decideAssignmentCoordination(second.items[0].id, { decision: 'REJECT' });
    assert.equal(keep.outcome, 'APPROVED');
    assert.deepEqual(assigneesOf(stack, TASK_ID), [ORDINARY, EXTERNAL].sort((a, b) => a - b));
  } finally { await stack.dispose(); }
});

test('kaldırma onayı yalnızca tek Sicil siler; gizli eş sorumlular korunur', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const request = await store.createAssignmentCoordination({ taskId: TASK_ID, assigneeSicils: [EXTERNAL], message: 'Destek' });
    await asUser(UNIT_MANAGER, () => store.decideAssignmentCoordination(request.items[0].id, { decision: 'APPROVE' }));
    await asUser(UNIT_MANAGER, () => store.decideAssignmentCoordination(request.items[0].id, {
      decision: 'REQUEST_CANCELLATION', message: 'Geri çekiliyor.'
    }));
    const removed = await store.decideAssignmentCoordination(request.items[0].id, { decision: 'APPROVE' });
    assert.equal(removed.outcome, 'CANCELLED');
    // Görevin öteki sorumlusu DOKUNULMADAN kalır.
    assert.deepEqual(assigneesOf(stack, TASK_ID), [ORDINARY]);
    assert.equal(stack.db.taskNotifications.some((row) => row.Kind === 'TASK_UNASSIGNED'
      && Number(row.RecipientSicil) === EXTERNAL), true);
  } finally { await stack.dispose(); }
});

test('sorumlu kümesi arada değişirse onay uygulanmaz ve kayıt güncelliğini yitirir', async () => {
  const stack = await createActualStack(seed(), { sicil: PROJECT_MANAGER, corporateWbsSource: false });
  try {
    const request = await asUser(ORDINARY, () => store.createAssignmentCoordination({
      taskId: TASK_ID, assigneeSicils: [EXTERNAL], message: 'Destek'
    }));

    // Tam yetkili proje yöneticisi arada sorumlu kümesini değiştirir.
    const task = stack.state.tasks.find((entry) => entry.id === TASK_ID);
    await stack.repository.commitChanges({
      taskUpserts: [{ ...task, assigneeIds: [String(ORDINARY), String(SAME_NAME_A)], assigneeMutation: true }]
    });
    assert.deepEqual(assigneesOf(stack, TASK_ID), [ORDINARY, SAME_NAME_A].sort((a, b) => a - b));

    const decision = await asUser(UNIT_MANAGER, () =>
      store.decideAssignmentCoordination(request.items[0].id, { decision: 'APPROVE' }));
    assert.equal(decision.outcome, 'STALE');
    assert.equal(assigneesOf(stack, TASK_ID).includes(EXTERNAL), false);
  } finally { await stack.dispose(); }
});

test('tek gönderimdeki KARDEŞ talepler birbirini bayatlatmaz', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    // Aynı gönderimde iki kişi istenir; her iki satır da aynı ön-talep
    // sorumlu künyesini taşır.
    const request = await store.createAssignmentCoordination({
      taskId: TASK_ID, assigneeSicils: [EXTERNAL, SAME_NAME_B], message: 'İki kişilik destek'
    });
    assert.equal(request.items.length, 2);
    const byAssignee = new Map(request.items.map((item) => [item.assigneeSicil, item.id]));

    const first = await asUser(UNIT_MANAGER, () =>
      store.decideAssignmentCoordination(byAssignee.get(String(EXTERNAL)), { decision: 'APPROVE' }));
    assert.equal(first.outcome, 'APPROVED');

    // İkinci satır yalnızca kardeşinin onayı yüzünden bayat sayılmamalıdır.
    const second = await asUser(UNIT_MANAGER, () =>
      store.decideAssignmentCoordination(byAssignee.get(String(SAME_NAME_B)), { decision: 'APPROVE' }));
    assert.equal(second.outcome, 'APPROVED');
    assert.deepEqual(assigneesOf(stack, TASK_ID), [ORDINARY, EXTERNAL, SAME_NAME_B].sort((a, b) => a - b));
  } finally { await stack.dispose(); }
});

test('onay görev SÜRÜMÜNÜ ilerletir; açık duran düzenleyici sorumluyu silemez', async () => {
  const stack = await createActualStack(seed(), { sicil: PROJECT_MANAGER, corporateWbsSource: false });
  try {
    // Düzenleyici görevi ONAYDAN ÖNCE yükler: elindeki sürüm ve sorumlu listesi
    // eskiyecektir.
    const staleTask = stack.state.tasks.find((entry) => entry.id === TASK_ID);

    const request = await asUser(ORDINARY, () => store.createAssignmentCoordination({
      taskId: TASK_ID, assigneeSicils: [EXTERNAL], message: 'Destek'
    }));
    const approved = await asUser(UNIT_MANAGER, () =>
      store.decideAssignmentCoordination(request.items[0].id, { decision: 'APPROVE' }));
    assert.equal(approved.outcome, 'APPROVED');
    assert.deepEqual(assigneesOf(stack, TASK_ID), [ORDINARY, EXTERNAL].sort((a, b) => a - b));

    // Bayat sürümle yapılan kayıt reddedilir; onaylanan sorumlu yerinde kalır.
    await assert.rejects(
      stack.repository.commitChanges({
        taskUpserts: [{ ...staleTask, task: 'Yeniden adlandırıldı', assigneeIds: [String(ORDINARY)], assigneeMutation: true }]
      }),
      (error) => error.code === 'CONFLICT'
    );
    assert.deepEqual(assigneesOf(stack, TASK_ID), [ORDINARY, EXTERNAL].sort((a, b) => a - b));
  } finally { await stack.dispose(); }
});

test('okuma yüzeyi karar yetkisini CANLI veriden türetir', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  const inboxOf = async (sicil) => asUser(sicil, async () => {
    const { withSqlTransaction } = await import('../src/server/db/pool.js');
    const { loadAuthorizationContext } = await import('../src/server/authorization/loadAuthorizationContext.js');
    return withSqlTransaction(async (transaction) =>
      queries.readCoordinationInbox(transaction, await loadAuthorizationContext(transaction)));
  });
  try {
    const request = await store.createAssignmentCoordination({
      taskId: TASK_ID, assigneeSicils: [EXTERNAL], message: 'Destek'
    });
    const coordinationId = request.items[0].id;

    // Personel başka bir birime geçer: eski birim yöneticisinin alıcı satırı
    // durur ama karar yetkisi kalmaz.
    stack.db.executiveScope = stack.db.executiveScope
      .filter((scope) => Number(scope.ManagerSicil) !== UNIT_MANAGER
        || Number(scope.EmployeeSicil) !== EXTERNAL);
    stack.db.executiveScope.push({ ManagerSicil: DUAL_MANAGER, EmployeeSicil: EXTERNAL, ScopeType: 'UNIT' });

    const stale = await inboxOf(UNIT_MANAGER);
    const staleItem = stale.items.find((item) => item.id === coordinationId);
    assert.ok(staleItem, 'eski alıcı kaydı geçmişte görmeyi sürdürür');
    assert.equal(staleItem.isManager, false);
    assert.equal(staleItem.actionable, false);
    assert.deepEqual(staleItem.allowedDecisions, []);
    await asUser(UNIT_MANAGER, () => assert.rejects(
      store.decideAssignmentCoordination(coordinationId, { decision: 'APPROVE' }),
      (error) => error.code === 'FORBIDDEN'
    ));

    // Yeni YETKİLİ yönetici alıcı satırı olmadan da kaydı bulur ve karar verir.
    const fresh = await inboxOf(DUAL_MANAGER);
    const freshItem = fresh.items.find((item) => item.id === coordinationId);
    assert.ok(freshItem, 'güncel yetkili kaydı bulabilmelidir');
    assert.equal(freshItem.actionable, true);
    assert.equal(fresh.pendingCount, 1);

    const decision = await asUser(DUAL_MANAGER, () =>
      store.decideAssignmentCoordination(coordinationId, { decision: 'APPROVE' }));
    assert.equal(decision.outcome, 'APPROVED');
    // Karar veren aktör kendi kararını OKUYABİLMELİDİR.
    assert.ok(decision.record, 'karar yanıtı kaydı taşımalıdır');
    assert.equal(decision.record.status, 'APPROVED');
    assert.equal(decision.record.isManager, true, 'canlı karar yetkisi tek kayıt okumasında korunmalıdır');
  } finally { await stack.dispose(); }
});

test('alıcı satırı olmayan tam proje yetkilisi kararını okuyabilir', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const request = await store.createAssignmentCoordination({
      taskId: TASK_ID, assigneeSicils: [EXTERNAL], message: 'Destek'
    });
    const coordinationId = request.items[0].id;
    // Tam proje yetkilisi alıcı kümesinde YOKTUR: alıcılar yönetim zinciridir.
    assert.equal(recipientsOf(stack, coordinationId).some((row) => row.Sicil === PROJECT_MANAGER), false);

    const decision = await asUser(PROJECT_MANAGER, () =>
      store.decideAssignmentCoordination(coordinationId, { decision: 'APPROVE' }));
    assert.equal(decision.outcome, 'APPROVED');
    assert.ok(decision.record, 'karar veren kaydı okuyamıyorsa istemci sonucu çizemez');
    assert.equal(decision.record.status, 'APPROVED');
    assert.equal(decision.record.isManager, true, 'tam proje yetkisi tek kayıt okumasında korunmalıdır');
    // Kararla birlikte posta kutusu satırı açılır.
    assert.equal(recipientsOf(stack, coordinationId).some((row) => row.Sicil === PROJECT_MANAGER), true);
  } finally { await stack.dispose(); }
});

test('yönetici zinciri boşken karar YALNIZCA tam proje yetkilisine düşer', async () => {
  // Talep edilen kişinin yönetim zinciri yoktur; projede görev oluşturmuş
  // sıradan bir kullanıcı da vardır ve aday OLMAMALIDIR.
  const stack = await createActualStack(seed({
    executiveScope: executiveScope().filter((scope) => Number(scope.EmployeeSicil) !== SAME_NAME_A)
  }), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const request = await store.createAssignmentCoordination({
      taskId: TASK_ID, assigneeSicils: [SAME_NAME_A], message: 'Destek'
    });
    const coordinationId = request.items[0].id;
    const managers = recipientsOf(stack, coordinationId)
      .filter((row) => row.RecipientRole === 'MANAGER').map((row) => row.Sicil);

    // Yalnızca tam proje yetkilisi; görev oluşturan TEAM_MEMBER/EXECUTIVE değil.
    assert.deepEqual(managers.sort((a, b) => a - b), [PROJECT_MANAGER]);
    assert.equal(managers.includes(EXECUTIVE), false);

    // Aday gerçekten karar verebilir: sunucu onu reddetmez.
    const decision = await asUser(PROJECT_MANAGER, () =>
      store.decideAssignmentCoordination(coordinationId, { decision: 'APPROVE' }));
    assert.equal(decision.outcome, 'APPROVED');
    assert.ok(decision.record);
  } finally { await stack.dispose(); }
});

test('yönetici değişiklik isteyebilir; alternatif öneri yalnızca kendi personelinden olur', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const request = await store.createAssignmentCoordination({ taskId: TASK_ID, assigneeSicils: [EXTERNAL], message: 'Destek' });
    const coordinationId = request.items[0].id;

    await asUser(UNIT_MANAGER, async () => {
      await assert.rejects(
        store.decideAssignmentCoordination(coordinationId, {
          decision: 'REQUEST_CHANGE', message: 'Başkası uygun.', suggestedAssigneeSicil: TEAM_MEMBER
        }),
        (error) => error.code === 'FORBIDDEN'
      );
      const changed = await store.decideAssignmentCoordination(coordinationId, {
        decision: 'REQUEST_CHANGE', message: 'Onun yerine bu kişi uygundur.', suggestedAssigneeSicil: SAME_NAME_B
      });
      assert.equal(changed.outcome, 'CHANGE_REQUESTED');
      assert.equal(changed.record.suggestedAssigneeSicil, String(SAME_NAME_B));
    });

    // Talep eden kişi kaydı okunmamış olarak zilinde görür.
    const inbox = await asUser(ORDINARY, async () => {
      const { withSqlTransaction } = await import('../src/server/db/pool.js');
      const { loadAuthorizationContext } = await import('../src/server/authorization/loadAuthorizationContext.js');
      return withSqlTransaction(async (transaction) =>
        queries.readCoordinationInbox(transaction, await loadAuthorizationContext(transaction)));
    });
    assert.equal(inbox.items.some((item) => item.id === coordinationId && item.unread), true);
    assert.deepEqual(assigneesOf(stack, TASK_ID), [ORDINARY]);
  } finally { await stack.dispose(); }
});

test('karar yetkisi güncel İK ilişkisinden gelir; talep eden ve ilgisiz kullanıcı karar veremez', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const request = await store.createAssignmentCoordination({ taskId: TASK_ID, assigneeSicils: [EXTERNAL], message: 'Destek' });
    const coordinationId = request.items[0].id;

    // Talep eden kendi talebini ONAYLAYAMAZ; yalnızca geri çekebilir.
    await assert.rejects(
      store.decideAssignmentCoordination(coordinationId, { decision: 'APPROVE' }),
      (error) => error.code === 'CONFLICT'
    );
    // İlgisiz kullanıcı kayda hiç dokunamaz.
    await asUser(TEAM_MEMBER, async () => {
      await assert.rejects(
        store.decideAssignmentCoordination(coordinationId, { decision: 'APPROVE' }),
        (error) => error.code === 'FORBIDDEN'
      );
    });
    assert.deepEqual(assigneesOf(stack, TASK_ID), [ORDINARY]);

    // Bildirim zinciri birim+müdürlük ile sınırlıdır; KARAR yetkisi ise
    // çalışanın yetkili yönetici ilişkisinin tamamından gelir.
    const decision = await asUser(DIRECTORATE_MANAGER, () =>
      store.decideAssignmentCoordination(coordinationId, { decision: 'APPROVE' }));
    assert.equal(decision.outcome, 'APPROVED');
    assert.deepEqual(assigneesOf(stack, TASK_ID), [ORDINARY, EXTERNAL].sort((a, b) => a - b));
  } finally { await stack.dispose(); }
});

test('koordinasyon geçmişi göreve erişim VERMEZ', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    await store.createAssignmentCoordination({ taskId: TASK_ID, assigneeSicils: [EXTERNAL], message: 'Destek' });
  } finally { await stack.dispose(); }

  const managerStack = await createActualStack(seed({
    taskAssignees: [{ TaskId: TASK_ID, Sicil: ORDINARY }, { TaskId: OTHER_TASK_ID, Sicil: TEAM_MEMBER }]
  }), { sicil: UNIT_MANAGER, corporateWbsSource: false });
  try {
    // Yönetici alıcı olabilir ama görev anlık görüntüsünde görünmez.
    assert.equal(managerStack.state.tasks.some((task) => task.id === TASK_ID), false);
  } finally { await managerStack.dispose(); }
});

test('yönetici kapsamındaki doğrudan atama değişmez; kapsam dışı için talep açılır', async () => {
  const stack = await createActualStack(seed(), { sicil: EXECUTIVE, corporateWbsSource: false });
  try {
    const task = stack.state.tasks.find((entry) => entry.id === OTHER_TASK_ID);
    assert.ok(task, 'yönetici kendi personelinin görevini görmelidir');

    // Kapsam İÇİ doğrudan atama bugünkü gibi çalışır.
    const saved = await stack.repository.commitChanges({
      taskUpserts: [{ ...task, assigneeIds: [String(TEAM_MEMBER)], assigneeMutation: true }]
    });
    assert.equal(saved.taskUpserts.length, 1);

    // Kapsam DIŞI doğrudan atama hâlâ reddedilir.
    await assert.rejects(
      stack.repository.commitChanges({
        taskUpserts: [{ ...task, assigneeIds: [String(TEAM_MEMBER), String(EXTERNAL)], assigneeMutation: true }]
      }),
      (error) => error.code === 'FORBIDDEN'
    );

    // Koordinasyon yolu açıktır ve onay bekleyen bir kayıt üretir.
    const request = await store.createAssignmentCoordination({
      taskId: OTHER_TASK_ID, assigneeSicils: [EXTERNAL], message: 'Montaj desteği'
    });
    assert.equal(request.items[0].status, 'PENDING');
    assert.deepEqual(assigneesOf(stack, OTHER_TASK_ID), [TEAM_MEMBER]);
  } finally { await stack.dispose(); }
});

test('tam proje yetkilisinin kurum dışı ataması yürürlüğe girer ve koordinasyon kaydı üretir', async () => {
  const stack = await createActualStack(seed(), { sicil: PROJECT_MANAGER, corporateWbsSource: false });
  try {
    const task = stack.state.tasks.find((entry) => entry.id === TASK_ID);
    await stack.repository.commitChanges({
      taskUpserts: [{ ...task, assigneeIds: [String(ORDINARY), String(EXTERNAL)], assigneeMutation: true }]
    });
    assert.deepEqual(assigneesOf(stack, TASK_ID), [ORDINARY, EXTERNAL].sort((a, b) => a - b));

    const notices = stack.db.taskAssignmentCoordinations.filter((row) => row.Mode === 'NOTICE');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].Status, 'APPROVED');
    assert.equal(Number(notices[0].RequestedAssigneeSicil), EXTERNAL);
    const managers = recipientsOf(stack, notices[0].CoordinationId)
      .filter((row) => row.RecipientRole === 'MANAGER').map((row) => row.Sicil).sort((a, b) => a - b);
    assert.deepEqual(managers, [UNIT_MANAGER, DEPARTMENT_MANAGER].sort((a, b) => a - b));
    // Atanan kişi de alıcıdır: atama yürürlüktedir.
    assert.equal(recipientsOf(stack, notices[0].CoordinationId)
      .some((row) => row.Sicil === EXTERNAL && row.RecipientRole === 'ASSIGNEE'), true);
    // Kendi biriminden sorumlu için koordinasyon kaydı üretilmez.
    assert.equal(stack.db.taskAssignmentCoordinations.some((row) => Number(row.RequestedAssigneeSicil) === ORDINARY), false);
  } finally { await stack.dispose(); }
});

test('aynı adlı iki çalışan Sicil ile ayrılır ve arama kimliği adla çözmez', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    directorySearch.resetDirectorySearchRateForTests();
    const found = await directorySearch.searchCorporateDirectory({ query: 'Aynı Ad' });
    assert.deepEqual(found.items.map((person) => person.sicil).sort((a, b) => a - b), [SAME_NAME_A, SAME_NAME_B]);
    // Kurumsal künye ayrımı gösterilir; kullanıcı adı ve e-posta DÖNMEZ.
    for (const person of found.items) {
      assert.deepEqual(Object.keys(person).sort(), ['jobTitle', 'name', 'organization', 'sicil']);
      assert.deepEqual(Object.keys(person.organization).sort(), ['department', 'directorate', 'unit']);
    }

    const request = await store.createAssignmentCoordination({
      taskId: TASK_ID, assigneeSicils: [SAME_NAME_B], message: 'Ad değil sicil'
    });
    assert.equal(request.items[0].assigneeSicil, String(SAME_NAME_B));
    assert.equal(stack.db.taskAssignmentCoordinations.some((row) => Number(row.RequestedAssigneeSicil) === SAME_NAME_A), false);
  } finally { await stack.dispose(); }
});

test('dizin araması kısa sorguyu, sınırsız listeyi ve aşırı hızı reddeder', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    directorySearch.resetDirectorySearchRateForTests();
    await assert.rejects(
      directorySearch.searchCorporateDirectory({ query: 'A' }),
      (error) => error.code === 'MUTATION_FAILED' && error.status === 400
    );
    await assert.rejects(
      directorySearch.searchCorporateDirectory({ query: '' }),
      (error) => error.code === 'MUTATION_FAILED'
    );
    const bounded = await directorySearch.searchCorporateDirectory({ query: 'Yöneticisi' });
    assert.ok(bounded.items.length <= directorySearch.DIRECTORY_SEARCH_LIMIT);
    assert.equal(bounded.limit, directorySearch.DIRECTORY_SEARCH_LIMIT);

    // Yoklamaya karşı hız sınırı: aynı oturumun aşırı isteği reddedilir.
    directorySearch.resetDirectorySearchRateForTests();
    for (let index = 0; index < 30; index += 1) {
      await directorySearch.searchCorporateDirectory({ query: 'Kullanıcı' });
    }
    await assert.rejects(
      directorySearch.searchCorporateDirectory({ query: 'Kullanıcı' }),
      (error) => error.status === 429
    );
    directorySearch.resetDirectorySearchRateForTests();
  } finally { await stack.dispose(); }
});

test('görevle yetkili ilişkisi olmayan kullanıcı talep açamaz', async () => {
  const stack = await createActualStack(seed(), { sicil: DIRECTORATE_MANAGER, corporateWbsSource: false });
  try {
    await assert.rejects(
      store.createAssignmentCoordination({ taskId: TASK_ID, assigneeSicils: [EXTERNAL], message: 'Yetkisiz' }),
      (error) => error.code === 'FORBIDDEN'
    );
    // Var olmayan görev de AYNI iletiyle reddedilir: kayıt varlığı sızdırılmaz.
    await assert.rejects(
      store.createAssignmentCoordination({
        taskId: '44444444-4444-4444-8444-0000000000ff', assigneeSicils: [EXTERNAL], message: 'Yetkisiz'
      }),
      (error) => error.code === 'FORBIDDEN'
    );
    assert.equal(stack.db.taskAssignmentCoordinations.length, 0);
  } finally { await stack.dispose(); }
});

test('kendine talep açılamaz ve bilinmeyen sicil reddedilir', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    await assert.rejects(
      store.createAssignmentCoordination({ taskId: TASK_ID, assigneeSicils: [ORDINARY], message: 'Kendim' }),
      (error) => error.code === 'MUTATION_FAILED'
    );
    await assert.rejects(
      store.createAssignmentCoordination({ taskId: TASK_ID, assigneeSicils: [999999], message: 'Bilinmeyen' }),
      (error) => error.code === 'MUTATION_FAILED'
    );
    assert.equal(stack.db.taskAssignmentCoordinations.length, 0);
  } finally { await stack.dispose(); }
});

test('aynı görev ve kişi için yeni talep öncekini iptal eder, geçmişi silmez', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const first = await store.createAssignmentCoordination({ taskId: TASK_ID, assigneeSicils: [EXTERNAL], message: 'İlk' });
    const second = await store.createAssignmentCoordination({ taskId: TASK_ID, assigneeSicils: [EXTERNAL], message: 'İkinci' });
    assert.notEqual(first.items[0].id, second.items[0].id);
    assert.equal(stack.db.taskAssignmentCoordinations.length, 2);
    const previous = stack.db.taskAssignmentCoordinations
      .find((row) => row.CoordinationId.toLowerCase() === first.items[0].id);
    assert.equal(previous.Status, 'CANCELLED');
  } finally { await stack.dispose(); }
});

test('Talepler · Atama Koordinasyonu sunucuda süzer ve sayfalar', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    await store.createAssignmentCoordination({ taskId: TASK_ID, assigneeSicils: [EXTERNAL], message: 'Montaj desteği' });
    await store.createAssignmentCoordination({ taskId: TASK_ID, assigneeSicils: [DUAL_EMPLOYEE], message: 'Başka destek' });

    const all = await queries.queryAssignmentCoordinations({ tab: 'all' });
    assert.equal(all.total, 2);
    assert.equal(all.counts.sent, 2);
    assert.equal(all.pageSize, 25);

    // Görevlendirilen, birim ve arama süzgeçleri sunucuda uygulanır.
    assert.equal((await queries.queryAssignmentCoordinations({ tab: 'all', assignee: String(EXTERNAL) })).total, 1);
    assert.equal((await queries.queryAssignmentCoordinations({ tab: 'all', organization: 'Hat 1' })).total, 2);
    assert.equal((await queries.queryAssignmentCoordinations({ tab: 'all', search: 'Montaj desteği' })).total, 1);
    assert.equal((await queries.queryAssignmentCoordinations({ tab: 'all', status: 'PENDING' })).total, 2);
    assert.equal((await queries.queryAssignmentCoordinations({ tab: 'all', status: 'REJECTED' })).total, 0);
    assert.equal((await queries.queryAssignmentCoordinations({ tab: 'all', projectId: PROJECT_ID })).total, 2);

    // Sayfa boyutu sunucuda sınırlanır ve taşan sayfa son geçerli sayfaya çekilir.
    const paged = await queries.queryAssignmentCoordinations({ tab: 'all', pageSize: 1, page: 9 });
    assert.equal(paged.page, 1);
    assert.equal(paged.items.length, 1);
    await assert.rejects(
      queries.queryAssignmentCoordinations({ tab: 'all', pageSize: 500 }),
      (error) => error.code === 'MUTATION_FAILED'
    );
    await assert.rejects(
      queries.queryAssignmentCoordinations({ tab: 'bilinmeyen' }),
      (error) => error.code === 'MUTATION_FAILED'
    );

    // Yönetici yalnızca kendi alıcı olduğu kayıtları görür.
    const managerView = await asUser(UNIT_MANAGER, () => queries.queryAssignmentCoordinations({ tab: 'all' }));
    assert.equal(managerView.total, 1);
    assert.equal(managerView.items[0].assigneeSicil, String(EXTERNAL));
    assert.equal(managerView.items[0].isManager, true);
    assert.deepEqual(managerView.items[0].allowedDecisions, ['APPROVE', 'REQUEST_CHANGE', 'REJECT']);

    // İlgisiz kullanıcı hiçbir kayıt görmez.
    const outsiderView = await asUser(TEAM_MEMBER, () => queries.queryAssignmentCoordinations({ tab: 'all' }));
    assert.equal(outsiderView.total, 0);
  } finally { await stack.dispose(); }
});

test('zil önizlemesi sınırlıdır ve tam geçmiş anlık görüntüye yüklenmez', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    await store.createAssignmentCoordination({ taskId: TASK_ID, assigneeSicils: [EXTERNAL], message: 'Destek' });
    const statementStart = stack.db.statements.length;
    await stack.reload();
    const statements = stack.db.statements.slice(statementStart).map((entry) => entry.sql);

    // Koordinasyon ve görev bildirimi TEK ek sorguda okunur.
    const inboxQueries = statements.filter((sql) =>
      sql.includes('FROM dbo.MR_TaskAssignmentCoordinations c') || sql.includes('FROM dbo.MR_TaskNotifications n'));
    assert.equal(inboxQueries.length, 1, 'birleşik zil okuması tek gidiş-dönüş olmalıdır');
    assert.match(inboxQueries[0], /SELECT TOP \(@limit\)/);

    // Anlık görüntü yalnızca önizleme ve sayaç taşır; kurumsal dizin girmez.
    assert.equal(stack.state.assignmentCoordinations.length, 1);
    assert.equal(stack.state.notificationSummary.pendingCount, 0, 'talep eden kendi talebini karara bağlamaz');
    assert.equal(stack.state.notificationSummary.unreadCount >= 0, true);
    assert.equal(statements.some((sql) => sql.includes('AS MatchRank')), false, 'dizin araması anlık görüntüde çalışmaz');
  } finally { await stack.dispose(); }
});

test('göç uygulanmamış kurulumda uygulama zil olmadan açılır', async () => {
  const stack = await createActualStack(seed({ assignmentCoordinationSchemaMissing: true }), {
    sicil: ORDINARY, corporateWbsSource: false
  });
  try {
    await stack.reload();
    assert.deepEqual(stack.state.assignmentCoordinations, []);
    assert.deepEqual(stack.state.taskNotifications, []);
    assert.deepEqual(stack.state.notificationSummary, { unreadCount: 0, pendingCount: 0 });
    // Görev yazması da etkilenmez.
    const task = stack.state.tasks.find((entry) => entry.id === TASK_ID);
    assert.ok(task);
  } finally { await stack.dispose(); }
});
