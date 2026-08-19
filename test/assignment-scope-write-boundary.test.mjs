/**
 * Görev atama kapsamının YAZMA sınırı ve plan bütünlüğü.
 *
 * Zincir gerçek kodla kurulur: istemci deposu → rota gövdeleri → sertleştirilmiş
 * SQL deposu → bellek içi SQL Server ikizi.
 *
 * Sınanan davranışlar:
 *   1. Atama kapsamı iş dağılım ağacına, gizli bağımlılıklara ve kapsam dışı
 *      ilişkili görevlere DOKUNAMAZ.
 *   2. Sistem yöneticisi de etkin olmayan projeye görev yazamaz.
 *   3. Yetki, kurumsal rehber yoklamasından ÖNCE denetlenir.
 *   4. Basit Mod düzenlemesi Gelişmiş Modda kurulmuş planı ezmez.
 *   5. Tarih girişi imkânsız takvim gününü kabul etmez.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CORPORATE_PROJECT_ID,
  CORPORATE_ROOT_WBS_ID,
  corporateSeed,
  createActualStack
} from './helpers/actualStack.mjs';

import { parseDisplayDate } from '../src/components/dateInputFormat.js';
import { ownsSimpleModePlan } from '../src/features/task-detail/simpleTaskPlan.js';
import { plainTextToHtml } from '../src/features/reminders/plainTextHtml.js';
import { planTemplateStartAlignment } from '../src/features/task-detail/recurrenceTemplateAlignment.js';
import { resolveTaskCreationProject } from '../src/state/projectWritePolicy.js';
import { canResolveTaskAssignee } from '../src/state/appState.js';

const MANAGER_SICIL = 900500;
const SUBORDINATE_SICIL = 900501;
const OUTSIDER_SICIL = 900502;
const PLAIN_SICIL = 900503;
const NEW_TASK_ID = 'aa11bb22-cc33-4d44-8e55-ff6677889900';
const HIDDEN_WBS_ID = 'bb22cc33-dd44-4e55-8f66-001122334455';

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
    systemAdminSicils: [],
    corporateProjectAccess: [],
    executiveScope: [{ ManagerSicil: MANAGER_SICIL, EmployeeSicil: SUBORDINATE_SICIL, ScopeType: 'UNIT' }],
    ...overrides
  };
}

function taskChanges(overrides = {}) {
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
      assigneeIds: [String(SUBORDINATE_SICIL)],
      deps: [],
      ...overrides
    }]
  };
}

/* ── 1. İş dağılım ağacı yerleşimi ──────────────────────────────── */

test('atama kapsamıyla yazılan görev GİZLİ bir WBS düğümüne bağlanamaz', async () => {
  const seed = assignmentSeed();
  // Kök dışında, istemciye hiç bildirilmeyen ikinci bir düğüm.
  seed.wbs = [...seed.wbs, {
    WbsId: HIDDEN_WBS_ID,
    ProjectId: CORPORATE_PROJECT_ID,
    ParentWbsId: CORPORATE_ROOT_WBS_ID,
    Code: 'GIZLI',
    Name: 'Gizli düğüm',
    SortOrder: 2
  }];

  const stack = await createActualStack(seed, { sicil: MANAGER_SICIL });
  try {
    await assert.rejects(
      stack.repository.commitChanges(taskChanges({ wbsId: HIDDEN_WBS_ID })),
      (error) => {
        assert.equal(error.code, 'FORBIDDEN');
        assert.match(error.message, /iş dağılım ağacı düğümü seçilemez/);
        return true;
      }
    );
    // Kök düğüm kabul edilir: kapsam kaydıyla istemciye bildirilen tek düğümdür.
    const committed = await stack.repository.commitChanges(taskChanges());
    assert.equal(committed.taskUpserts.length, 1);
  } finally {
    await stack.dispose();
  }
});

/* ── 2. Gizli bağımlılıklar ─────────────────────────────────────── */

test('atama kapsamı düzenlemesi GÖRÜNMEYEN öncülleri silmez', async () => {
  const predecessorId = 'cc33dd44-ee55-4f66-8a77-112233445566';
  const seed = assignmentSeed();
  seed.tasks = [
    {
      TaskId: predecessorId,
      ProjectId: CORPORATE_PROJECT_ID,
      WbsId: CORPORATE_ROOT_WBS_ID,
      Title: 'Görünmeyen öncül',
      Status: 'planned',
      Priority: 'medium',
      TargetFinish: '2026-08-10'
    },
    {
      TaskId: NEW_TASK_ID,
      ProjectId: CORPORATE_PROJECT_ID,
      WbsId: CORPORATE_ROOT_WBS_ID,
      Title: 'Astın görevi',
      Status: 'planned',
      Priority: 'medium',
      TargetFinish: '2026-08-20'
    }
  ];
  seed.taskAssignees = [{ TaskId: NEW_TASK_ID, Sicil: SUBORDINATE_SICIL }];
  seed.taskDependencies = [{
    TaskDependencyId: 'dd44ee55-ff66-4a77-8b88-223344556677',
    ProjectId: CORPORATE_PROJECT_ID,
    TaskId: NEW_TASK_ID,
    PredecessorTaskId: predecessorId,
    DependencyType: 'FS',
    LagDays: 0
  }];

  const stack = await createActualStack(seed, { sicil: MANAGER_SICIL });
  try {
    // PARTIAL anlık görüntü bağımlılık yüklemez: istemci `deps: []` taşır.
    const snapshot = await stack.repository.loadSnapshot();
    const visible = snapshot.tasks.find((task) => String(task.id).toLowerCase().includes('aa11bb22'));
    assert.ok(visible, 'astın görevi yöneticiye görünmelidir');
    assert.deepEqual(visible.deps, []);

    // Yalnızca başlık düzenlenir; bağımlılık satırı KORUNUR.
    await stack.repository.commitChanges({
      taskUpserts: [{ ...visible, task: 'Yeni başlık', version: visible.version }]
    });
    assert.equal(stack.db.taskDependencies.length, 1, 'görünmeyen öncül silinmemelidir');
    assert.equal(stack.db.tasks.find((row) => String(row.TaskId).toLowerCase().includes('aa11bb22')).Title, 'Yeni başlık');
  } finally {
    await stack.dispose();
  }
});

/* ── 3. Kapsam dışı ilişkili görevler ───────────────────────────── */

test('atama kapsamı silmesi KAPSAM DIŞI yinelemeye dokunamaz', async () => {
  // Görev silindiğinde yinelemeleri AYRILIR (`RecurrenceParentTaskId = NULL`).
  // Bu yinelemeler görünmez ve yöneticinin kapsamı dışında olabilir; kapsam içi
  // bir görevi silmek onlara yazmamalıdır.
  const occurrenceId = 'ee55ff66-aa77-4b88-8c99-334455667788';
  const seed = assignmentSeed();
  seed.tasks = [
    {
      TaskId: NEW_TASK_ID,
      ProjectId: CORPORATE_PROJECT_ID,
      WbsId: CORPORATE_ROOT_WBS_ID,
      Title: 'Astın seri şablonu',
      Status: 'planned',
      Priority: 'medium',
      TargetFinish: '2026-08-20',
      RecurrenceRule: 'FREQ=WEEKLY;BYDAY=MO'
    },
    {
      TaskId: occurrenceId,
      ProjectId: CORPORATE_PROJECT_ID,
      WbsId: CORPORATE_ROOT_WBS_ID,
      Title: 'Başka birime düşen yineleme',
      Status: 'planned',
      Priority: 'medium',
      TargetFinish: '2026-08-27',
      RecurrenceParentTaskId: NEW_TASK_ID,
      RecurrenceOccurrenceDate: '2026-08-24'
    }
  ];
  seed.taskAssignees = [
    { TaskId: NEW_TASK_ID, Sicil: SUBORDINATE_SICIL },
    { TaskId: occurrenceId, Sicil: OUTSIDER_SICIL }
  ];

  const stack = await createActualStack(seed, { sicil: MANAGER_SICIL });
  try {
    const snapshot = await stack.repository.loadSnapshot();
    const visible = snapshot.tasks.find((task) => String(task.id).toLowerCase().includes('aa11bb22'));
    assert.ok(visible, 'şablon yöneticiye görünmelidir');

    await assert.rejects(
      stack.repository.commitChanges({ taskDeletes: [{ id: visible.id, version: visible.version }] }),
      (error) => {
        assert.equal(error.code, 'FORBIDDEN');
        assert.match(error.message, /yetki alanınız dışındaki görevlerle ilişkili/i);
        return true;
      }
    );

    // Kapsam dışı yineleme DOKUNULMADAN durur: seri bağı da silinmemiştir.
    const occurrence = stack.db.tasks.find((row) => String(row.TaskId).toLowerCase().includes('ee55ff66'));
    assert.ok(occurrence.RecurrenceParentTaskId, 'kapsam dışı yinelemenin seri bağı korunmalıdır');
    assert.equal(stack.db.tasks.some((row) => String(row.TaskId).toLowerCase().includes('aa11bb22')), true);
  } finally {
    await stack.dispose();
  }
});

/* ── 4. Sistem yöneticisi ve etkin proje ────────────────────────── */

test('sistem yöneticisi ETKİN OLMAYAN projeye görev yazamaz', async () => {
  const stack = await createActualStack(corporateSeed());
  try {
    // Proje yığın kurulduktan SONRA pasifleştirilir: kurumsal katalog eşitlemesi
    // tohumdaki projeyi yeniden etkinleştirdiği için tohumda kapatmak yetmez.
    for (const project of stack.db.projects) project.IsActive = 0;

    await assert.rejects(
      stack.repository.commitChanges(taskChanges({ assigneeIds: [] })),
      (error) => {
        // Sertleştirme katmanı da aynı sınırı korur; her iki katman da yazmayı
        // reddeder ve görev etkin olmayan projeye düşmez.
        assert.ok(
          /Etkin olmayan bir projede görev yazılamaz|Hedef proje bulunamadı veya etkin değil/.test(error.message),
          `beklenmeyen ileti: ${error.message}`
        );
        return true;
      }
    );
    assert.equal(stack.db.tasks.some((row) => String(row.TaskId).toLowerCase().includes('aa11bb22')), false);
  } finally {
    await stack.dispose();
  }
});

/* ── 5. Rehber yoklaması ────────────────────────────────────────── */

test('yetki, kurumsal rehber yoklamasından ÖNCE denetlenir', async () => {
  // Sıradan kullanıcı: ne kurumsal proje erişimi ne de atama kapsamı vardır.
  const stack = await createActualStack(assignmentSeed(), { sicil: PLAIN_SICIL });
  try {
    // Var olmayan bir Sicil ile de yanıt aynı yetki hatasıdır: geçerli ve
    // geçersiz sicillerin farklı hata üretmesi rehberi yoklamaya yarardı.
    const unknown = await stack.repository
      .commitChanges({
        taskUpserts: [{
          ...taskChanges().taskUpserts[0],
          projectId: CORPORATE_PROJECT_ID,
          assigneeIds: ['999999']
        }]
      })
      .then(() => null, (error) => error);
    const known = await stack.repository
      .commitChanges(taskChanges({ assigneeIds: [String(OUTSIDER_SICIL)] }))
      .then(() => null, (error) => error);

    assert.ok(unknown && known, 'iki istek de reddedilmelidir');
    // İkisi de AYNI yetki hatasıdır: bilinmeyen Sicil için "geçersiz çalışan",
    // gerçek Sicil için FORBIDDEN dönseydi bu fark rehberi yoklamaya yarardı.
    assert.equal(unknown.code, 'FORBIDDEN');
    assert.equal(known.code, 'FORBIDDEN');
    assert.equal(unknown.message, known.message);
    assert.equal(/Geçersiz çalışan Sicil/.test(unknown.message), false);
  } finally {
    await stack.dispose();
  }
});

/* ── 6. Basit Mod planı ─────────────────────────────────────────── */

test('Basit Mod düzenlemesi Gelişmiş Modda kurulmuş planın sahibi değildir', () => {
  // Üç tarih eşitse plan Basit Modda kurulmuştur ve birlikte taşınabilir.
  assert.equal(ownsSimpleModePlan({ plannedStart: '2026-08-20', plannedFinish: '2026-08-20', targetFinish: '2026-08-20' }), true);
  // Plan tarihleri ayrıştıysa Gelişmiş Moda aittir; Basit Mod onu ezmemelidir.
  assert.equal(ownsSimpleModePlan({ plannedStart: '2026-08-10', plannedFinish: '2026-08-18', targetFinish: '2026-08-20' }), false);
  // Hiç plan tarihi yoksa Basit Mod alanı serbestçe kurabilir.
  assert.equal(ownsSimpleModePlan({ targetFinish: '2026-08-20' }), true);
});

/* ── 7. Tarih girişi ────────────────────────────────────────────── */

test('imkânsız ISO takvim günü kabul edilmez', () => {
  // Tireli metin maskeyi atladığı için doğrulanmadan geçiyor, `parseDate()`
  // onu mart ayına yuvarlıyordu.
  assert.equal(parseDisplayDate('2026-02-31'), null);
  assert.equal(parseDisplayDate('2026-13-01'), null);
  assert.equal(parseDisplayDate('2026-02-28'), '2026-02-28');
  // Artık yıl gerçek takvimle doğrulanır.
  assert.equal(parseDisplayDate('2024-02-29'), '2024-02-29');
  assert.equal(parseDisplayDate('2026-02-29'), null);
});

/* ── 8. Tekrar şablonu hizalaması ───────────────────────────────── */

test('DTSTART hizalaması ÇALIŞMA GÜNÜ süresini korur', () => {
  // Pzt–Cum takvimi: Cuma–Pazartesi 2 iş günüdür. Ham takvim farkıyla (3 gün)
  // kaydırıldığında bitiş Perşembeye taşınıyor ve süre 4 iş gününe çıkıyordu.
  const calendar = { workingWeekdays: [1, 2, 3, 4, 5], holidays: [] };
  const task = { plannedStart: '2026-08-14', plannedFinish: '2026-08-17', targetFinish: '2026-08-17' };
  const aligned = planTemplateStartAlignment(task, 'FREQ=WEEKLY;BYDAY=MO', { calendar });

  assert.ok(aligned, 'kural Pazartesi istediği için hizalama gerekir');
  assert.equal(aligned.plannedStart, '2026-08-17');
  // Başlangıç Pazartesi ise 2 iş günlük görev SALI biter.
  assert.equal(aligned.plannedFinish, '2026-08-18');
  // Termin bir taahhüt tarihidir; takvim günü farkıyla kayar.
  assert.equal(aligned.targetFinish, '2026-08-20');
});

/* ── 9. Yeni görev varsayılan sorumlusu ─────────────────────────── */

test('atama kapsamı projesinde varsayılan sorumlu KAPSAM İÇİNDEN seçilir', () => {
  const state = {
    session: { dataMode: 'actual' },
    currentUser: { id: String(MANAGER_SICIL), name: 'Birim Yöneticisi' },
    people: [
      { id: String(MANAGER_SICIL), name: 'Birim Yöneticisi' },
      { id: String(SUBORDINATE_SICIL), name: 'Ast Personel' }
    ],
    assignmentScopeSicils: [String(SUBORDINATE_SICIL)]
  };
  const assignProject = { id: 'p1', name: 'CN43N', accessLevel: 'ASSIGN' };
  const fullProject = { id: 'p2', name: 'Tam yetki', accessLevel: 'FULL' };

  // Kapsam projesinde oturum sahibi kapsam dışıdır; astı seçilir.
  assert.equal(canResolveTaskAssignee(state, assignProject), true);
  // Tam yetkili projede davranış DEĞİŞMEZ: varsayılan yine oturum sahibidir.
  assert.equal(canResolveTaskAssignee(state, fullProject), true);
  // Kapsam oturum sahibini ve rehberdeki hiç kimseyi içermiyorsa oluşturma
  // düğmesi etkinleşmemelidir: istek zaten reddedilirdi.
  const unreachable = {
    ...state,
    assignmentScopeSicils: ['999999'],
    people: [{ id: String(MANAGER_SICIL), name: 'Birim Yöneticisi' }]
  };
  assert.equal(canResolveTaskAssignee(unreachable, assignProject), false);
  // Tam yetkili projede aynı durum oluşturmayı ENGELLEMEZ.
  assert.equal(canResolveTaskAssignee(unreachable, fullProject), true);
});

test('proje çalışma alanında atama kapsamı da görev oluşturmaya yeter', () => {
  const state = {
    workspaceMode: 'project',
    selectedProjectId: 'p1',
    // Proje PARTIAL görünür (ast görevi üzerinden) ama atama kapsamındadır.
    projects: [{ id: 'p1', name: 'CN43N', accessLevel: 'PARTIAL' }],
    assignableProjects: [{ id: 'p1', name: 'CN43N', accessLevel: 'ASSIGN' }]
  };
  const resolved = resolveTaskCreationProject(state);
  assert.ok(resolved, 'atama kapsamındaki seçili proje çözülmelidir');
  assert.equal(resolved.id, 'p1');
});

/* ── 10. Zengin metin yapıştırması ──────────────────────────────── */

test('düz metin yapıştırması satır yapısını korur', () => {
  const html = plainTextToHtml('Birinci satır\nİkinci satır\n\nYeni paragraf');
  assert.equal(html, '<p>Birinci satır<br />İkinci satır</p><p>Yeni paragraf</p>');
  // Yapıştırılan metin KAÇIRILIR: `<script>` yalnızca metin üretir.
  assert.equal(plainTextToHtml('<script>x</script>'), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
});
