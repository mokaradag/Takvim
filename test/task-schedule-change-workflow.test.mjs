import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';
import { decideScheduleChangeRequest, submitScheduleChangeRequest } from '../src/data/api/scheduleChangeClient.js';
import { reconcileScheduleProposal } from '../src/features/schedule-change/scheduleChangePresentation.js';

const PROJECT_ID = '11111111-1111-4111-8111-777777777777';
const ROOT_WBS_ID = '22222222-2222-4222-8222-777777777777';
const CHILD_WBS_ID = '22222222-2222-4222-8222-777777777778';
const TASK_ID = '33333333-3333-4333-8333-777777777777';
const PREDECESSOR_ID = '33333333-3333-4333-8333-777777777778';
const CREATOR = 940001;
const ASSIGNEE = 940002;
const MANAGER = 940003;
const OUTSIDER = 940004;

function seed(overrides = {}) {
  return {
    calendars: [{
      CalendarId: DEFAULT_CALENDAR_ID,
      Name: 'Kurumsal Takvim',
      IsDefault: 1,
      IsActive: 1,
      WorkingDays: [1, 2, 3, 4, 5]
    }],
    people: [CREATOR, ASSIGNEE, MANAGER, OUTSIDER].map((Sicil) => ({
      Sicil,
      DisplayName: `Kullanıcı ${Sicil}`,
      Username: `u${Sicil}`
    })),
    projects: [{
      ProjectId: PROJECT_ID,
      SourceType: 'MANUAL',
      ProjectCode: 'TALEP',
      ProjectName: 'Tarih Talebi Projesi',
      LeadSicil: MANAGER,
      CalendarId: DEFAULT_CALENDAR_ID,
      IsActive: 1
    }],
    projectAccess: [{ ProjectId: PROJECT_ID, Sicil: MANAGER, AccessLevel: 'FULL', GrantSource: 'OWNER' }],
    wbs: [
      { WbsId: ROOT_WBS_ID, ProjectId: PROJECT_ID, ParentWbsId: null, Code: '1', Name: 'Kök', SortOrder: 1 },
      { WbsId: CHILD_WBS_ID, ProjectId: PROJECT_ID, ParentWbsId: ROOT_WBS_ID, Code: '1.1', Name: 'Doğrulama', SortOrder: 2 }
    ],
    tasks: [{
      TaskId: TASK_ID,
      ProjectId: PROJECT_ID,
      WbsId: ROOT_WBS_ID,
      CalendarId: DEFAULT_CALENDAR_ID,
      Title: 'Radar yazılım doğrulaması',
      Status: 'in_progress',
      Priority: 'medium',
      PlannedStart: '2026-09-01',
      PlannedFinish: '2026-09-02',
      PlannedDurationDays: 2,
      TargetFinish: '2026-09-02',
      Progress: 20,
      CreatedBySicil: CREATOR
    }],
    taskAssignees: [{ TaskId: TASK_ID, Sicil: ASSIGNEE }],
    ...overrides
  };
}

function proposal(targetFinish = '2026-09-03') {
  return {
    taskId: TASK_ID,
    proposedDates: { targetFinish },
    message: 'Doğrulama ortamı bir gün sonra hazır olacak.'
  };
}

test('başkasının görevindeki sorumlu doğrudan planı değiştiremez, talep oluşturabilir ve önceki talep değiştirilir', async () => {
  const stack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    const task = stack.state.tasks[0];
    assert.equal(task.createdBySicil, String(CREATOR), 'görev sorumlusu görevi tanımlayan kişiyi görmelidir');
    assert.equal(task.createdByName, `Kullanıcı ${CREATOR}`);
    assert.equal(task.isCurrentUserCreator, false);
    await assert.rejects(
      stack.repository.commitChanges({ taskUpserts: [{ ...task, targetFinish: '2026-09-03', assigneeMutation: false }] }),
      (error) => error.code === 'FORBIDDEN'
    );
    assert.equal(stack.db.tasks[0].TargetFinish, '2026-09-02');

    const first = await submitScheduleChangeRequest(proposal());
    assert.equal(first.ok, true);
    assert.equal(first.value.status, 'PENDING');
    assert.equal(first.value.decisionOwnerSicil, String(CREATOR));
    assert.equal(stack.db.tasks[0].TargetFinish, '2026-09-02', 'talep görevi geçici olarak değiştirmemelidir');

    const replacement = await submitScheduleChangeRequest(proposal('2026-09-04'));
    assert.equal(replacement.ok, true);
    assert.equal(stack.db.taskScheduleChangeRequests.length, 2);
    assert.deepEqual(stack.db.taskScheduleChangeRequests.map((entry) => entry.Status), ['CANCELLED', 'PENDING']);
    assert.ok(stack.db.auditLog.some((entry) => entry.ActionCode === 'UPDATE'
      && entry.EntityType === 'TASK_SCHEDULE_REQUEST'
      && String(entry.EntityId).toLowerCase() === first.value.id));
  } finally {
    await stack.dispose();
  }
});

test('yalnızca hedef bitiş önerisi gizli plan tarihlerini geri almaz', async () => {
  const stack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    // Pencere açıkken planı BAŞKASI ilerletir: istemcinin elindeki plan artık
    // bayattır. Hedef bitiş talebi yalnızca kendi alanını taşımalıdır.
    stack.db.tasks[0].PlannedStart = '2026-09-05';
    stack.db.tasks[0].PlannedFinish = '2026-09-06';

    const created = await submitScheduleChangeRequest({
      taskId: TASK_ID,
      proposedDates: { targetFinish: '2026-09-10' },
      message: 'Yalnızca hedef bitiş için onay istiyorum.'
    });
    assert.equal(created.ok, true);

    const request = stack.db.taskScheduleChangeRequests.at(-1);
    // Gönderilmeyen alanlar KİLİTLİ görev satırından tamamlanır; istemcinin
    // eski değerleri talebe hiç girmez.
    assert.equal(request.ProposedPlannedStart, '2026-09-05');
    assert.equal(request.ProposedPlannedFinish, '2026-09-06');
    assert.equal(request.ProposedTargetFinish, '2026-09-10');

    process.env.MERGEN_ROTA_DEV_SICIL = String(CREATOR);
    await stack.reload();
    const decided = await decideScheduleChangeRequest(created.value.id, 'ACCEPT', 'Uygundur.');
    assert.equal(decided.ok, true);
    assert.equal(decided.value.outcome, 'ACCEPTED');
    // Kabul yalnızca hedef bitişi yazar; güncel plan korunur.
    assert.equal(stack.db.tasks[0].PlannedStart, '2026-09-05');
    assert.equal(stack.db.tasks[0].PlannedFinish, '2026-09-06');
    assert.equal(stack.db.tasks[0].TargetFinish, '2026-09-10');
    process.env.MERGEN_ROTA_DEV_SICIL = String(ASSIGNEE);
  } finally {
    await stack.dispose();
  }
});

test('hiç tarih taşımayan talep reddedilir', async () => {
  const stack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    const result = await submitScheduleChangeRequest({
      taskId: TASK_ID,
      proposedDates: {},
      message: 'Boş talep.'
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /en az bir plan tarihi/i);
    // Reddedilen talep ARKASINDA kayıt bırakmamalıdır: doğrulama, satır
    // yazıldıktan sonra çalışırsa karar bekleyen boş bir talep birikirdi.
    assert.equal(stack.db.taskScheduleChangeRequests.length, 0);
  } finally {
    await stack.dispose();
  }
});

test('sorumlu plan tarihlerini hedef bitiş talebine ekleyemez', async () => {
  const stack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    for (const field of ['plannedStart', 'plannedFinish']) {
      const result = await submitScheduleChangeRequest({
        taskId: TASK_ID,
        proposedDates: { targetFinish: '2026-09-10', [field]: '2026-09-09' },
        message: 'Yetki sınırı doğrulaması.'
      });
      assert.equal(result.ok, false, field);
      assert.equal(result.code, 'MUTATION_FAILED', field);
      assert.match(result.message, /yalnızca hedef bitiş/i, field);
    }
    assert.equal(stack.db.taskScheduleChangeRequests.length, 0);
  } finally {
    await stack.dispose();
  }
});

test('göreve atanmamış kullanıcı talep oluşturamaz ve sorumlu karar sahibinin yerine karar veremez', async () => {
  const stack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    const created = await submitScheduleChangeRequest(proposal());
    assert.equal(created.ok, true);

    const ownDecision = await decideScheduleChangeRequest(created.value.id, 'ACCEPT');
    assert.equal(ownDecision.ok, false);
    assert.equal(ownDecision.code, 'FORBIDDEN');

    process.env.MERGEN_ROTA_DEV_SICIL = String(OUTSIDER);
    const forged = await submitScheduleChangeRequest(proposal('2026-09-05'));
    assert.equal(forged.ok, false);
    assert.equal(forged.code, 'FORBIDDEN');
    const forgedDecision = await decideScheduleChangeRequest(created.value.id, 'REJECT');
    assert.equal(forgedDecision.ok, false);
    assert.equal(forgedDecision.code, 'FORBIDDEN');
    await stack.reload();
    assert.deepEqual(stack.state.scheduleRequests, []);
  } finally {
    await stack.dispose();
  }
});

test('oluşturucu kabul ettiğinde yalnız hedef bitiş güncellenir, talep iki tarafa kalıcı görünür', async () => {
  const stack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    const created = await submitScheduleChangeRequest(proposal());
    assert.equal(created.ok, true);

    process.env.MERGEN_ROTA_DEV_SICIL = String(CREATOR);
    await stack.reload();
    assert.equal(stack.state.scheduleRequests[0].isDecisionOwner, true);
    const decided = await decideScheduleChangeRequest(created.value.id, 'ACCEPT', 'Uygundur.');
    assert.equal(decided.ok, true);
    assert.equal(decided.value.outcome, 'ACCEPTED');
    assert.equal(stack.db.tasks[0].PlannedStart, '2026-09-01');
    assert.equal(stack.db.tasks[0].PlannedFinish, '2026-09-02');
    assert.equal(stack.db.tasks[0].TargetFinish, '2026-09-03');
    assert.equal(stack.db.tasks[0].PlannedDurationDays, 2);
    assert.equal(stack.db.taskScheduleChangeRequests[0].Status, 'ACCEPTED');

    process.env.MERGEN_ROTA_DEV_SICIL = String(ASSIGNEE);
    await stack.reload();
    assert.equal(stack.state.scheduleRequests[0].status, 'ACCEPTED');
    assert.equal(stack.state.scheduleRequests[0].decisionMessage, 'Uygundur.');
    assert.ok(stack.db.auditLog.some((entry) => entry.EntityType === 'TASK'));
    assert.ok(stack.db.auditLog.some((entry) => entry.EntityType === 'TASK_SCHEDULE_REQUEST'));
  } finally {
    await stack.dispose();
  }
});

test('sorumlu gerçekleşen tarihleri yazar; ters sıralı çift REDDEDİLİR', async () => {
  // 1) Sorumlu KENDİ görevinin gerçekleşen tarihlerini doğrudan yazabilmelidir.
  //    Bu alanlar önceden oluşturucuya kilitliydi ve sorumlu, yürüttüğü işin
  //    fiilî tarihlerini hiç giremiyordu.
  // 2) Çift SIRALI olmalıdır. Denetim yalnızca "bitiş varken başlangıç yok"
  //    durumunu kapatıyordu; başlangıcından ÖNCE biten bir kayıt, planlanan
  //    tarihlerde aynı kural uygulanmasına rağmen sunucudan geçiyordu.
  const stack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    const task = stack.state.tasks[0];
    assert.equal(task.createdBySicil, String(CREATOR), 'sorumlu görev oluşturucusunu görmelidir');
    assert.equal(task.isCurrentUserCreator, false, 'görevi başkası oluşturmuş olmalıdır');

    const written = await stack.repository.commitChanges({
      taskUpserts: [{ ...task, actualStart: '2026-09-01', actualFinish: '2026-09-05', assigneeMutation: false }]
    });
    assert.equal(written.taskUpserts[0].actualFinish, '2026-09-05');
    assert.equal(stack.db.tasks[0].ActualStart, '2026-09-01');
    assert.equal(stack.db.tasks[0].ActualFinish, '2026-09-05');

    await assert.rejects(
      stack.repository.commitChanges({
        taskUpserts: [{
          ...written.taskUpserts[0],
          actualStart: '2026-09-09',
          actualFinish: '2026-09-05',
          assigneeMutation: false
        }]
      }),
      (error) => error.code === 'MUTATION_FAILED' && /başlangıçtan önce/.test(error.message)
    );
    assert.equal(stack.db.tasks[0].ActualStart, '2026-09-01', 'reddedilen istek kaydı değiştirmemelidir');
  } finally {
    await stack.dispose();
  }
});

test('ret görevin tarihlerini korur ve karar bilgisi kalıcılaşır', async () => {
  const stack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    const created = await submitScheduleChangeRequest(proposal());
    process.env.MERGEN_ROTA_DEV_SICIL = String(CREATOR);
    const decided = await decideScheduleChangeRequest(created.value.id, 'REJECT', 'Mevcut plan korunmalı.');
    assert.equal(decided.ok, true);
    assert.equal(decided.value.outcome, 'REJECTED');
    assert.equal(stack.db.tasks[0].TargetFinish, '2026-09-02');
    assert.equal(stack.db.taskScheduleChangeRequests[0].Status, 'REJECTED');
    assert.equal(stack.db.taskScheduleChangeRequests[0].DecisionMessage, 'Mevcut plan korunmalı.');
  } finally {
    await stack.dispose();
  }
});

test('proje pasifleştirildikten sonra bekleyen tarih talebi görevi güncelleyemez', async () => {
  const stack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    const created = await submitScheduleChangeRequest(proposal('2026-09-05'));
    assert.equal(created.ok, true);
    stack.db.projects[0].IsActive = 0;
    process.env.MERGEN_ROTA_DEV_SICIL = String(CREATOR);

    const decided = await decideScheduleChangeRequest(created.value.id, 'ACCEPT');
    assert.equal(decided.ok, false);
    assert.equal(decided.code, 'FORBIDDEN');
    assert.equal(stack.db.tasks[0].TargetFinish, '2026-09-02');
    assert.equal(stack.db.taskScheduleChangeRequests[0].Status, 'PENDING');
    await stack.reload();
    assert.deepEqual(stack.state.scheduleRequests, []);
  } finally {
    await stack.dispose();
  }
});

test('talep sonrasında görev planı değişirse kabul yeni planı ezmez ve talebi stale yapar', async () => {
  const stack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    const created = await submitScheduleChangeRequest(proposal('2026-09-05'));
    process.env.MERGEN_ROTA_DEV_SICIL = String(CREATOR);
    await stack.reload();
    const task = stack.state.tasks[0];
    await stack.repository.commitChanges({
      taskUpserts: [{ ...task, plannedFinish: '2026-09-04', targetFinish: '2026-09-04', assigneeMutation: false }]
    });

    const decided = await decideScheduleChangeRequest(created.value.id, 'ACCEPT');
    assert.equal(decided.ok, true);
    assert.equal(decided.value.outcome, 'STALE');
    assert.match(decided.value.message, /güncel plan/);
    assert.equal(stack.db.tasks[0].TargetFinish, '2026-09-04');
    assert.equal(stack.db.taskScheduleChangeRequests[0].Status, 'STALE');
  } finally {
    await stack.dispose();
  }
});

test('geçersiz takvim günü sunucuda reddedilir', async () => {
  const stack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    const invalid = await submitScheduleChangeRequest(proposal('2026-02-30'));
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'MUTATION_FAILED');
    assert.equal(stack.db.taskScheduleChangeRequests.length, 0);
  } finally {
    await stack.dispose();
  }
});

test('sınırlı oluşturucu kendi görevinde plan, hedef ve gerçekleşen tarihlerle mevcut WBS seçer; yapıyı değiştiremez ve solo görevi silebilir', async () => {
  const original = seed();
  const creatorSeed = seed({
    tasks: [{ ...original.tasks[0], ActualStart: '2026-09-01', ActualFinish: '2026-09-02' }],
    taskAssignees: [{ TaskId: TASK_ID, Sicil: CREATOR }]
  });
  const stack = await createActualStack(creatorSeed, { sicil: CREATOR, corporateWbsSource: false });
  try {
    assert.equal(stack.state.projects[0].accessLevel, 'PARTIAL');
    assert.equal(stack.state.wbs.length, 2, 'oluşturucu mevcut WBS kataloğunu okuyabilmelidir');
    const task = stack.state.tasks[0];
    const updated = await stack.repository.commitChanges({
      taskUpserts: [{
        ...task,
        wbsId: CHILD_WBS_ID,
        plannedFinish: '2026-09-03',
        targetFinish: '2026-09-03',
        assigneeMutation: false
      }]
    });
    assert.equal(updated.taskUpserts[0].wbsId, CHILD_WBS_ID);
    assert.equal(stack.db.tasks[0].TargetFinish, '2026-09-03');
    assert.equal(stack.db.tasks[0].PlannedDurationDays, 3);
    // GERÇEKLEŞEN tarihler artık oluşturucuya açıktır: görevi açan kişi
    // çoğunlukla onu yürüten kişidir. Yapısal alanlar (proje, sorumlu, tekrar,
    // bağımlılık) kapalı kalır.
    const withActual = await stack.repository.commitChanges({
      taskUpserts: [{ ...updated.taskUpserts[0], actualStart: '2026-08-31', assigneeMutation: false }]
    });
    assert.equal(withActual.taskUpserts[0].actualStart, '2026-08-31');
    assert.equal(stack.db.tasks[0].ActualStart, '2026-08-31');
    await assert.rejects(
      stack.repository.commitChanges({
        taskUpserts: [{ ...withActual.taskUpserts[0], sortOrder: 999, assigneeMutation: false }]
      }),
      (error) => error.code === 'FORBIDDEN'
    );

    // Sürüm, gerçekleşen tarih yazmasıyla ilerledi: sonraki yazma GÜNCEL satırı
    // temel almalıdır, aksi hâlde iyimser kilit çakışma bildirir.
    const directTask = { ...withActual.taskUpserts[0], targetFinish: '2026-09-04', assigneeMutation: false };
    delete directTask.wbsId;
    const { createSqlAppRepository } = await import('../src/server/repository/sqlAppRepository.js');
    const directlyUpdated = await createSqlAppRepository().commitChanges({ taskUpserts: [directTask] });
    assert.equal(directlyUpdated.taskUpserts[0].wbsId, CHILD_WBS_ID);
    assert.equal(String(stack.db.tasks[0].WbsId).toLowerCase(), CHILD_WBS_ID);
    await assert.rejects(
      stack.repository.commitChanges({ wbsUpserts: [{ ...stack.state.wbs[1], name: 'Yetkisiz değişiklik' }] }),
      (error) => error.code === 'FORBIDDEN'
    );

    const visible = directlyUpdated.taskUpserts[0];
    const deleted = await stack.repository.commitChanges({ taskDeletes: [{ id: TASK_ID, version: visible.version }] });
    assert.deepEqual(deleted.taskDeletes, [TASK_ID]);
    assert.equal(stack.db.tasks.length, 0);
  } finally {
    await stack.dispose();
  }
});

test('oluşturucu başka sorumlu bulunduğunda ve oluşturucu olmayan sorumlu her durumda silemez; FULL yetki korunur', async () => {
  const shared = seed({ taskAssignees: [{ TaskId: TASK_ID, Sicil: CREATOR }, { TaskId: TASK_ID, Sicil: ASSIGNEE }] });
  const creatorStack = await createActualStack(shared, { sicil: CREATOR, corporateWbsSource: false });
  try {
    await assert.rejects(
      creatorStack.repository.commitChanges({ taskDeletes: [{ id: TASK_ID, version: creatorStack.state.tasks[0].version }] }),
      (error) => error.code === 'FORBIDDEN' && /başka sorumlular/.test(error.message)
    );
  } finally {
    await creatorStack.dispose();
  }

  const assigneeStack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    await assert.rejects(
      assigneeStack.repository.commitChanges({ taskDeletes: [{ id: TASK_ID, version: assigneeStack.state.tasks[0].version }] }),
      (error) => error.code === 'FORBIDDEN' && /kendi oluşturduğunuz/.test(error.message)
    );
  } finally {
    await assigneeStack.dispose();
  }

  const managerStack = await createActualStack(seed(), { sicil: MANAGER, corporateWbsSource: false });
  try {
    const managerTask = managerStack.state.tasks[0];
    const updated = await managerStack.repository.commitChanges({
      taskUpserts: [{ ...managerTask, targetFinish: '2026-09-06', assigneeMutation: false }]
    });
    assert.equal(updated.taskUpserts[0].targetFinish, '2026-09-06');
    await managerStack.repository.commitChanges({ taskDeletes: [{ id: TASK_ID, version: updated.taskUpserts[0].version }] });
    assert.equal(managerStack.db.tasks.length, 0);
  } finally {
    await managerStack.dispose();
  }
});

test('kalıcı şema talep sürümü, durum kısıtı ve tek bekleyen talep dizinini içerir', () => {
  const schema = readFileSync(new URL('../database/MR_Upgrade_0007_Task_Schedule_Change_Requests.sql', import.meta.url), 'utf8');
  const freshSchema = readFileSync(new URL('../database/MR_Create_Durable_Persistence.sql', import.meta.url), 'utf8');
  assert.match(schema, /CreatedAgainstTaskVersion binary\(8\) NOT NULL/);
  assert.match(schema, /PENDING.*ACCEPTED.*REJECTED.*CANCELLED.*STALE/s);
  const pendingIndex = schema.match(/CREATE UNIQUE INDEX UX_MR_TaskScheduleChangeRequests_RequesterPending[\s\S]*?WHERE Status = 'PENDING';/)?.[0];
  assert.ok(pendingIndex, 'bekleyen talep dizini bulunmalıdır');
  assert.match(pendingIndex, /ON dbo\.MR_TaskScheduleChangeRequests\(TaskId,\s*RequesterSicil\)/);
  assert.match(schema, /SET QUOTED_IDENTIFIER ON/);
  assert.match(schema, /SET ANSI_NULLS ON/);
  assert.match(freshSchema, /0006_audit_deactivation/);
});

test('açık tarih penceresi güncel planı düzenlenmemiş alanlara taşır ve kullanıcı taslağını korur', () => {
  const current = {
    plannedStart: '2026-09-02',
    plannedFinish: '2026-09-04',
    targetFinish: '2026-09-04'
  };
  const proposed = {
    plannedStart: '2026-09-01',
    plannedFinish: '2026-09-03',
    targetFinish: '2026-09-06'
  };
  assert.deepEqual(
    reconcileScheduleProposal(current, proposed, new Set(['targetFinish'])),
    {
      plannedStart: '2026-09-02',
      plannedFinish: '2026-09-04',
      targetFinish: '2026-09-06'
    }
  );
});

test('ilgili olmayan görev güncellemesi tarih talebini stale yapmaz', async () => {
  const stack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    const created = await submitScheduleChangeRequest(proposal('2026-09-05'));
    process.env.MERGEN_ROTA_DEV_SICIL = String(CREATOR);
    await stack.reload();
    const task = stack.state.tasks[0];
    await stack.repository.commitChanges({
      taskUpserts: [{ ...task, progress: 35, assigneeMutation: false }]
    });

    const decided = await decideScheduleChangeRequest(created.value.id, 'ACCEPT');
    assert.equal(decided.ok, true);
    assert.equal(decided.value.outcome, 'ACCEPTED');
    assert.equal(stack.db.tasks[0].TargetFinish, '2026-09-05');
  } finally {
    await stack.dispose();
  }
});

test('oluşturucu kaydı olmayan eski görev güvenli karar sahibine tarih talebi gönderebilir', async () => {
  const legacy = seed({
    tasks: [{
      ...seed().tasks[0],
      CreatedBySicil: null,
      UpdatedBySicil: null
    }],
    taskAssignees: [{ TaskId: TASK_ID, Sicil: ASSIGNEE, AssignedBySicil: OUTSIDER }]
  });
  const stack = await createActualStack(legacy, { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    assert.equal(stack.state.tasks[0].createdBySicil, null);
    const created = await submitScheduleChangeRequest(proposal('2026-09-05'));
    assert.equal(created.ok, true);
    assert.equal(created.value.decisionOwnerSicil, String(MANAGER));

    process.env.MERGEN_ROTA_DEV_SICIL = String(MANAGER);
    const decided = await decideScheduleChangeRequest(created.value.id, 'ACCEPT');
    assert.equal(decided.ok, true);
    assert.equal(decided.value.outcome, 'ACCEPTED');
  } finally {
    await stack.dispose();
  }
});

test('aynı öncelikteki karar sahipleri Sicil sırasıyla belirlenir', async () => {
  const base = seed();
  const legacy = seed({
    projects: [{ ...base.projects[0], SourceType: 'CORPORATE', LeadSicil: null }],
    projectAccess: [
      { ProjectId: PROJECT_ID, Sicil: OUTSIDER, AccessLevel: 'FULL', GrantSource: 'MANUAL' },
      { ProjectId: PROJECT_ID, Sicil: MANAGER, AccessLevel: 'FULL', GrantSource: 'MANUAL' }
    ],
    tasks: [{ ...base.tasks[0], CreatedBySicil: null, UpdatedBySicil: null }],
    taskAssignees: [{ TaskId: TASK_ID, Sicil: ASSIGNEE, AssignedBySicil: OUTSIDER }]
  });
  const stack = await createActualStack(legacy, { sicil: ASSIGNEE, corporateWbsSource: false });
  try {
    const created = await submitScheduleChangeRequest(proposal('2026-09-05'));
    assert.equal(created.ok, true);
    assert.equal(created.value.decisionOwnerSicil, String(MANAGER));
  } finally {
    await stack.dispose();
  }
});

test('anlık görüntü tüm bekleyenleri ve yalnızca en yeni 100 sonuçlanmış talebi döndürür', async () => {
  const historical = Array.from({ length: 105 }, (_, index) => ({
    RequestId: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
    TaskId: TASK_ID,
    RequesterSicil: ASSIGNEE,
    DecisionOwnerSicil: CREATOR,
    Status: 'REJECTED',
    CreatedAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString()
  }));
  historical.push({
    RequestId: '55555555-5555-4555-8555-555555555555',
    TaskId: TASK_ID,
    RequesterSicil: ASSIGNEE,
    DecisionOwnerSicil: CREATOR,
    Status: 'PENDING',
    CreatedAt: '2026-08-29T10:00:00.000Z'
  });
  historical.push({
    RequestId: '66666666-6666-4666-8666-666666666666',
    TaskId: TASK_ID,
    RequesterSicil: OUTSIDER,
    DecisionOwnerSicil: ASSIGNEE,
    Status: 'PENDING',
    CreatedAt: '2026-08-29T11:00:00.000Z'
  });
  const stack = await createActualStack(seed({ taskScheduleChangeRequests: historical }), {
    sicil: ASSIGNEE,
    corporateWbsSource: false
  });
  try {
    const requestIds = new Set(stack.state.scheduleRequests.map((request) => request.id));
    assert.equal(stack.state.scheduleRequests.length, 102);
    assert.equal(stack.state.scheduleRequests.filter((request) => request.status === 'PENDING').length, 2);
    assert.equal(requestIds.has('55555555-5555-4555-8555-555555555555'), true);
    assert.equal(requestIds.has('66666666-6666-4666-8666-666666666666'), true);
    assert.equal(requestIds.has('44444444-4444-4444-8444-000000000104'), true);
    assert.equal(requestIds.has('44444444-4444-4444-8444-000000000000'), false);
  } finally {
    await stack.dispose();
  }
});

test('tarih talebi okumaları yalnızca etkin projeleri ve belirlenimli sıralamayı kullanır', () => {
  const source = readFileSync(new URL('../src/server/schedule-change/scheduleChangeStore.js', import.meta.url), 'utf8');
  const listStart = source.indexOf('export async function listScheduleChanges');
  const readStart = source.indexOf('async function readScheduleChange');
  const createStart = source.indexOf('export async function createScheduleChange');
  assert.ok(listStart >= 0 && readStart > listStart && createStart > readStart);
  const listBody = source.slice(listStart, readStart);
  const readBody = source.slice(readStart, createStart);
  assert.match(listBody, /JOIN dbo\.MR_Projects p ON p\.ProjectId = t\.ProjectId AND p\.IsActive = 1/);
  assert.match(readBody, /JOIN dbo\.MR_Projects p ON p\.ProjectId = t\.ProjectId AND p\.IsActive = 1/);
  assert.match(listBody, /ORDER BY CASE WHEN r\.Status = 'PENDING' THEN 0 ELSE 1 END, r\.CreatedAt DESC, r\.RequestId DESC/);
});

test('0007 göçü henüz çalışmamışsa uygulama boş tarih talebi listesiyle açılır', async () => {
  const missingRequestId = '77777777-7777-4777-8777-777777777777';
  const stack = await createActualStack(seed({
    scheduleChangeSchemaMissing: true,
    taskScheduleChangeRequests: [{
      RequestId: missingRequestId,
      TaskId: TASK_ID,
      RequesterSicil: ASSIGNEE,
      DecisionOwnerSicil: CREATOR,
      Status: 'PENDING'
    }]
  }), {
    sicil: ASSIGNEE,
    corporateWbsSource: false
  });
  try {
    assert.deepEqual(stack.state.scheduleRequests, []);
    const created = await submitScheduleChangeRequest(proposal('2026-09-06'));
    assert.equal(created.ok, false);
    assert.equal(stack.db.taskScheduleChangeRequests.length, 1);

    process.env.MERGEN_ROTA_DEV_SICIL = String(CREATOR);
    const decided = await decideScheduleChangeRequest(missingRequestId, 'ACCEPT');
    assert.equal(decided.ok, false);
    assert.equal(stack.db.taskScheduleChangeRequests[0].Status, 'PENDING');
  } finally {
    await stack.dispose();
  }
});

test('sınırlı oluşturucu kapsam dışı öncül bağı olan görevi silemez', async () => {
  const related = seed({
    tasks: [
      seed().tasks[0],
      {
        TaskId: PREDECESSOR_ID,
        ProjectId: PROJECT_ID,
        WbsId: ROOT_WBS_ID,
        Title: 'Kapsam dışı öncül',
        Status: 'planned',
        Priority: 'medium',
        CreatedBySicil: OUTSIDER
      }
    ],
    taskAssignees: [
      { TaskId: TASK_ID, Sicil: CREATOR },
      { TaskId: PREDECESSOR_ID, Sicil: OUTSIDER }
    ],
    taskDependencies: [{
      ProjectId: PROJECT_ID,
      TaskId: TASK_ID,
      PredecessorTaskId: PREDECESSOR_ID,
      DependencyType: 'FS'
    }]
  });
  const stack = await createActualStack(related, { sicil: CREATOR, corporateWbsSource: false });
  try {
    const task = stack.state.tasks.find((entry) => entry.id === TASK_ID);
    await assert.rejects(
      stack.repository.commitChanges({ taskDeletes: [{ id: TASK_ID, version: task.version }] }),
      (error) => error.code === 'FORBIDDEN' && /yetki alanınız dışındaki/.test(error.message)
    );
    assert.equal(stack.db.tasks.some((entry) => String(entry.TaskId).toLowerCase() === TASK_ID), true);
    assert.equal(stack.db.taskDependencies.length, 1);
  } finally {
    await stack.dispose();
  }
});

test('sınırlı oluşturucu kendi oluşturduğu sorumlusuz yinelemeyi ayırarak şablonu silebilir', async () => {
  const childId = '33333333-3333-4333-8333-777777777779';
  const base = seed();
  const stack = await createActualStack(seed({
    tasks: [
      base.tasks[0],
      {
        ...base.tasks[0],
        TaskId: childId,
        Title: 'Oluşturucuya ait yineleme',
        RecurrenceParentTaskId: TASK_ID,
        RecurrenceOccurrenceDate: '2026-09-08',
        CreatedBySicil: CREATOR
      }
    ],
    taskAssignees: [{ TaskId: TASK_ID, Sicil: CREATOR }]
  }), { sicil: CREATOR, corporateWbsSource: false });
  try {
    const template = stack.state.tasks.find((entry) => entry.id === TASK_ID);
    const deleted = await stack.repository.commitChanges({
      taskDeletes: [{ id: TASK_ID, version: template.version }]
    });
    assert.deepEqual(deleted.taskDeletes, [TASK_ID]);
    assert.equal(stack.db.tasks.length, 1);
    assert.equal(String(stack.db.tasks[0].TaskId).toLowerCase(), childId);
    assert.equal(stack.db.tasks[0].RecurrenceParentTaskId, null);
  } finally {
    await stack.dispose();
  }
});

test('görev silme, yıkıcı deyimlerden önce görev ve ilişki aralıklarını kilitler', () => {
  const source = readFileSync(new URL('../src/server/repository/sqlAppRepository.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function deleteTask');
  const end = source.indexOf('async function deleteWbs');
  assert.ok(start >= 0, 'deleteTask gövdesi bulunmalıdır');
  assert.ok(end > start, 'deleteWbs işareti deleteTask sonrasında bulunmalıdır');
  const body = source.slice(start, end);
  const scopeStart = source.indexOf('async function hasRelatedTasksOutsideScope');
  const scopeEnd = source.indexOf('async function taskAssigneeSicils', scopeStart);
  assert.ok(scopeStart >= 0, 'ilişkili görev kapsam denetimi bulunmalıdır');
  assert.ok(scopeEnd > scopeStart, 'sorumlu okuma işareti kapsam denetiminden sonra bulunmalıdır');
  const scopeBody = source.slice(scopeStart, scopeEnd);
  assert.match(body, /taskRowForUpdate\(executor, taskId\)/);
  assert.match(body, /taskAssigneeSicilsForUpdate\(executor, taskId\)/);
  assert.match(body, /hasRelatedTasksOutsideScope\(executor, actor, taskId\)/);
  assert.match(scopeBody, /MR_TaskDependencies WITH \(UPDLOCK, HOLDLOCK\).*PredecessorTaskId = @taskId/s);
  assert.match(scopeBody, /MR_TaskDependencies WITH \(UPDLOCK, HOLDLOCK\)[\s\S]*WHERE TaskId = @taskId/);
  assert.match(scopeBody, /MR_Tasks WITH \(UPDLOCK, HOLDLOCK\).*RecurrenceParentTaskId = @taskId/s);
});

test('WBS kataloğu görev kapsamlı projeleri satır başına görev sorgulamadan önceden hesaplar', () => {
  const source = readFileSync(new URL('../src/server/repository/sqlAppRepository.js', import.meta.url), 'utf8');
  const start = source.indexOf('DECLARE @TaskScopedWbsProjects TABLE(ProjectId uniqueidentifier PRIMARY KEY)');
  const end = source.indexOf('-- Sorumlu SAYISI');
  assert.ok(start >= 0, 'WBS seçim sorgusu bulunmalıdır');
  assert.ok(end > start, 'görev seçim sorgusu WBS sorgusundan sonra bulunmalıdır');
  const wbsBody = source.slice(start, end);
  assert.match(wbsBody, /DECLARE @TaskScopedWbsProjects TABLE\(ProjectId uniqueidentifier PRIMARY KEY\)/);
  assert.match(wbsBody, /INSERT @TaskScopedWbsProjects\(ProjectId\)/);
  assert.match(wbsBody, /@TaskScopedWbsProjects scopedProject/);
  assert.doesNotMatch(wbsBody, /FROM dbo\.MR_Tasks scopedTask/);
});

test('Temel Kip tarih talebi eylemini ve ortak modal erişilebilirlik sınırını kullanır', () => {
  const overlay = readFileSync(new URL('../src/features/task-detail/TaskDetailOverlay.jsx', import.meta.url), 'utf8');
  const simpleDrawer = readFileSync(new URL('../src/features/task-detail/SimpleTaskDrawer.jsx', import.meta.url), 'utf8');
  const advancedDrawer = readFileSync(new URL('../src/features/task-detail/TaskDrawer.jsx', import.meta.url), 'utf8');
  // Odak tuzağı PAYLAŞIMLI kancaya taşındı: aynı davranışı karşılama ekranı ve
  // veri kipi seçici de kullanır (`src/features/schedule-change/useModalFocusTrap.js`
  // artık yalnızca yeniden dışa aktarır).
  const focusTrap = readFileSync(new URL('../src/hooks/useModalFocusTrap.js', import.meta.url), 'utf8');
  const focusTrapReExport = readFileSync(new URL('../src/features/schedule-change/useModalFocusTrap.js', import.meta.url), 'utf8');
  assert.match(focusTrapReExport, /export \{ useModalFocusTrap \} from '\.\.\/\.\.\/hooks\/useModalFocusTrap\.js'/);
  const provider = readFileSync(new URL('../src/state/AppStateProvider.jsx', import.meta.url), 'utf8');
  const dialog = readFileSync(new URL('../src/features/schedule-change/ScheduleChangeDialog.jsx', import.meta.url), 'utf8');
  const requestCenter = readFileSync(new URL('../src/features/schedule-change/ScheduleRequestCenter.jsx', import.meta.url), 'utf8');

  assert.match(overlay, /<SimpleTaskDrawer[\s\S]*canProposeSchedule=\{initialAccess\.canProposeSchedule\}/);
  assert.match(simpleDrawer, /<ScheduleChangeDialog/);
  assert.match(advancedDrawer, /request\.status === 'PENDING' && request\.isRequester/);
  assert.match(focusTrap, /event\.key !== 'Tab'/);
  assert.match(focusTrap, /restoreFocusRef/);
  assert.match(focusTrap, /useEffect\(\(\) => \{\s*closeRef\.current = onClose;\s*blockedRef\.current = blocked;\s*\}, \[onClose, blocked\]\);/);
  assert.match(dialog, /<DateInput[\s\S]*?disabled=\{busy\}/);
  assert.match(dialog, /name="scheduleChangeReason"[\s\S]*?disabled=\{busy\}/);
  assert.match(requestCenter, /name="scheduleDecisionNote"[\s\S]*?disabled=\{busy\}/);
  assert.match(dialog, /<table className="schedule-compare">[\s\S]*<thead>[\s\S]*<tbody>/);
  assert.match(requestCenter, /<table className="schedule-compare">[\s\S]*<thead>[\s\S]*<tbody>/);
  assert.doesNotMatch(dialog, /role="table"/);
  assert.doesNotMatch(requestCenter, /role="table"/);
  const styles = readFileSync(new URL('../src/app/styles/features.css', import.meta.url), 'utf8');
  assert.match(styles, /\.schedule-status\.modified/);
  assert.match(provider, /refreshError: reloadResult\.error \|\| reloadResult/);
  assert.match(provider, /projectWriteFailure\('schedule-change\/decide',[\s\S]*ACTUAL_MODE_REQUIRED/);
  const decideStart = provider.indexOf('const decideScheduleChange');
  const decideEnd = provider.indexOf('const addTask');
  assert.ok(decideStart >= 0, 'decideScheduleChange gövdesi bulunmalıdır');
  assert.ok(decideEnd > decideStart, 'addTask işareti karar gövdesinden sonra bulunmalıdır');
  const decideBody = provider.slice(decideStart, decideEnd);
  const guardPosition = decideBody.indexOf('ACTUAL_MODE_REQUIRED');
  const flushPosition = decideBody.indexOf('persistence.flush()');
  assert.ok(guardPosition >= 0, 'Gerçek Sistem koruması bulunmalıdır');
  assert.ok(flushPosition >= 0, 'kalıcılaştırma boşaltımı bulunmalıdır');
  assert.ok(guardPosition < flushPosition);

  const submitStart = provider.indexOf('const submitScheduleChange');
  assert.ok(submitStart >= 0, 'submitScheduleChange gövdesi bulunmalıdır');
  assert.ok(decideStart > submitStart, 'karar gövdesi gönderim gövdesinden sonra bulunmalıdır');
  const submitBody = provider.slice(submitStart, decideStart);
  const submitGuardPosition = submitBody.indexOf('ACTUAL_MODE_REQUIRED');
  const submitFlushPosition = submitBody.indexOf('persistence.flush()');
  assert.ok(submitGuardPosition >= 0, 'gönderim Gerçek Sistem koruması bulunmalıdır');
  assert.ok(submitFlushPosition >= 0, 'gönderim boşaltımı bulunmalıdır');
  assert.ok(submitGuardPosition < submitFlushPosition);
});

test('tarih önerisi SQL 1205 sonrasında tüm işlemi yeniden yürütür, tek talep ve denetim kaydı üretir', async () => {
  const stack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  const { setSqlDriverForTests, sql } = await import('../src/server/db/pool.js');
  let attempts = 0;
  class DeadlockTransaction extends stack.driver.Transaction {
    async begin(level) {
      attempts += 1;
      this.requestsBefore = stack.db.taskScheduleChangeRequests.map((row) => ({ ...row }));
      this.auditBefore = stack.db.auditLog.map((row) => ({ ...row }));
      return super.begin(level);
    }
    request() {
      const request = super.request();
      const query = request.query.bind(request);
      request.query = async (statement) => {
        if (attempts === 1 && statement.includes('INSERT dbo.MR_AuditLog')) {
          throw Object.assign(new Error('deadlock victim'), { code: 'EREQUEST', originalError: { info: { number: 1205 } } });
        }
        return query(statement);
      };
      return request;
    }
    async rollback() {
      stack.db.taskScheduleChangeRequests = this.requestsBefore;
      stack.db.auditLog = this.auditBefore;
      return super.rollback();
    }
  }
  setSqlDriverForTests({ ...stack.driver, Transaction: DeadlockTransaction });
  try {
    const result = await submitScheduleChangeRequest(proposal());
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(attempts, 2);
    assert.equal(stack.db.taskScheduleChangeRequests.length, 1);
    assert.equal(stack.db.taskScheduleChangeRequests[0].Status, 'PENDING');
    assert.equal(stack.db.auditLog.filter((row) => row.EntityType === 'TASK_SCHEDULE_REQUEST').length, 1);
    assert.equal(stack.db.transactions.at(-1).isolationLevel, sql.ISOLATION_LEVEL.READ_COMMITTED);
  } finally { await stack.dispose(); }
});

test('SQL işlemi yalnızca 1205 için ve sınırlı sayıda yeniden denenir', async () => {
  const stack = await createActualStack(seed(), { sicil: ASSIGNEE, corporateWbsSource: false });
  const { withSqlTransaction } = await import('../src/server/db/pool.js');
  try {
    for (const [error, expected] of [[{ number: 1205 }, 3], [{ code: 'ETIMEOUT' }, 1], [{ number: 2627 }, 1]]) {
      let calls = 0;
      await assert.rejects(withSqlTransaction(async () => { calls += 1; throw error; }, { deadlockRetries: 2 }));
      assert.equal(calls, expected);
    }
    let outer = 0;
    let inner = 0;
    await withSqlTransaction(async () => {
      outer += 1;
      await withSqlTransaction(async () => { inner += 1; if (inner === 1) throw { number: 1205 }; });
    }, { deadlockRetries: 2 });
    assert.equal(outer, 2);
    assert.equal(inner, 2);
  } finally { await stack.dispose(); }
});
