import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';
import { appStateReducer } from '../src/state/appState.js';

const CREATOR = 920001;
const LEAD = 920002;
const NEXT_LEAD = 920003;
const OUTSIDER = 920004;
const SELF_PROJECT_ID = '41111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '42222222-2222-4222-8222-222222222222';
const SELF_WBS_ID = '51111111-1111-4111-8111-111111111111';
const OTHER_WBS_ID = '52222222-2222-4222-8222-222222222222';
const TASK_ID = '63333333-3333-4333-8333-333333333333';
const UNKNOWN_PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const originalDevSicil = process.env.MERGEN_ROTA_DEV_SICIL;

test.afterEach(() => {
  if (originalDevSicil == null) delete process.env.MERGEN_ROTA_DEV_SICIL;
  else process.env.MERGEN_ROTA_DEV_SICIL = originalDevSicil;
});

function baseSeed(overrides = {}) {
  return {
    calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Takvim', IsDefault: 1, IsActive: 1 }],
    people: [CREATOR, LEAD, NEXT_LEAD, OUTSIDER].map((Sicil) => ({ Sicil, DisplayName: `Kullanıcı ${Sicil}`, Username: `u${Sicil}` })),
    systemAdminSicils: [CREATOR],
    ...overrides
  };
}

function projectInput(id, name, leadId) {
  return {
    id, source: 'manual', code: null, name, leadId: String(leadId), dataDate: null,
    color: 'blue', calendarId: DEFAULT_CALENDAR_ID.toLowerCase(), tags: []
  };
}

function rootInput(id, projectId, name) {
  return { id, projectId, parentId: null, code: '1', name, sortOrder: 1 };
}

function seedRoot(id, projectId, name) {
  return { WbsId: id, ProjectId: projectId, ParentWbsId: null, Code: '1', Name: name, SortOrder: 1 };
}

test('manuel proje oluşturucusu OWNER kalır, seçilen proje sorumlusu da FULL erişim alır', async () => {
  const stack = await createActualStack(baseSeed(), { sicil: CREATOR, corporateWbsSource: false });
  try {
    await stack.repository.commitChanges({
      projectUpserts: [
        projectInput(SELF_PROJECT_ID, 'Kendi Projesi', CREATOR),
        projectInput(OTHER_PROJECT_ID, 'Başka Liderli Proje', LEAD)
      ],
      wbsUpserts: [
        rootInput(SELF_WBS_ID, SELF_PROJECT_ID, 'Kendi Projesi'),
        rootInput(OTHER_WBS_ID, OTHER_PROJECT_ID, 'Başka Liderli Proje')
      ]
    });
    assert.equal(stack.db.projectAccess.filter((row) => row.Sicil === CREATOR).length, 2);
    assert.equal(stack.db.projectAccess.filter((row) => row.Sicil === LEAD).length, 0, 'lider erişimi bağımsız bağış satırına karıştırılmaz');

    process.env.MERGEN_ROTA_DEV_SICIL = String(LEAD);
    await stack.reload();
    const project = stack.state.projects.find((entry) => entry.id === OTHER_PROJECT_ID);
    assert.equal(project.accessLevel, 'FULL');
    assert.equal(stack.state.projects.some((entry) => entry.id === SELF_PROJECT_ID), false);
    const root = stack.state.wbs.find((entry) => entry.projectId === OTHER_PROJECT_ID);
    const renamed = await stack.repository.commitChanges({ wbsUpserts: [{ ...root, name: 'Liderin yönettiği ağaç' }] });
    assert.equal(renamed.wbsUpserts[0].name, 'Liderin yönettiği ağaç');

    const transferred = await stack.repository.commitChanges({
      projectUpserts: [{ ...project, leadId: String(NEXT_LEAD) }]
    });
    assert.deepEqual(transferred.projectUpserts, []);
    assert.deepEqual(transferred.projectDeletes, [OTHER_PROJECT_ID], 'eski liderin istemcisinde yetkisiz proje bırakılmaz');
    const scrubbed = appStateReducer(stack.state, { type: 'data/apply-changes', changes: transferred });
    assert.equal(scrubbed.projects.some((entry) => entry.id === OTHER_PROJECT_ID), false);
    assert.equal(scrubbed.wbs.some((entry) => entry.projectId === OTHER_PROJECT_ID), false);
    await stack.reload();
    assert.equal(stack.state.projects.length, 0);

    process.env.MERGEN_ROTA_DEV_SICIL = String(NEXT_LEAD);
    await stack.reload();
    assert.equal(stack.state.projects[0].accessLevel, 'FULL');

    process.env.MERGEN_ROTA_DEV_SICIL = String(OUTSIDER);
    await stack.reload();
    assert.equal(stack.state.projects.length, 0);

    process.env.MERGEN_ROTA_DEV_SICIL = String(CREATOR);
    await stack.reload();
    assert.equal(stack.state.projects.filter((entry) => [SELF_PROJECT_ID, OTHER_PROJECT_ID].includes(entry.id)).length, 2);
  } finally {
    await stack.dispose();
  }
});

test('manuel proje sorumlusu değişince türetilmiş FULL erişim yeni lidere geçer, bağımsız bağış korunur', async () => {
  const seed = baseSeed({
    projects: [{ ProjectId: OTHER_PROJECT_ID, SourceType: 'MANUAL', ProjectName: 'Lider Devri', LeadSicil: LEAD, CalendarId: DEFAULT_CALENDAR_ID }],
    projectAccess: [
      { ProjectId: OTHER_PROJECT_ID, Sicil: CREATOR, AccessLevel: 'FULL', GrantSource: 'OWNER' },
      { ProjectId: OTHER_PROJECT_ID, Sicil: LEAD, AccessLevel: 'READ', GrantSource: 'MANUAL_GRANT' }
    ],
    wbs: [seedRoot(OTHER_WBS_ID, OTHER_PROJECT_ID, 'Lider Devri')]
  });
  const stack = await createActualStack(seed, { sicil: LEAD, corporateWbsSource: false });
  try {
    const project = stack.state.projects[0];
    assert.equal(project.accessLevel, 'FULL');
    const transferResult = await stack.repository.commitChanges({ projectUpserts: [{ ...project, leadId: String(NEXT_LEAD) }] });
    assert.equal(transferResult.projectUpserts[0].accessLevel, 'PARTIAL');
    assert.equal(transferResult.projectUpserts[0].schedulingCapability, 'SUPPRESSED_PARTIAL');
    const downgraded = appStateReducer(stack.state, { type: 'data/apply-changes', changes: transferResult });
    assert.equal(downgraded.projects[0].accessLevel, 'PARTIAL');
    assert.equal(downgraded.wbs.length, 0, 'FULL görünümden kalan WBS yetkili PARTIAL yükleme öncesi temizlenir');

    process.env.MERGEN_ROTA_DEV_SICIL = String(NEXT_LEAD);
    await stack.reload();
    assert.equal(stack.state.projects[0].accessLevel, 'FULL');

    process.env.MERGEN_ROTA_DEV_SICIL = String(LEAD);
    await stack.reload();
    assert.equal(stack.state.projects[0].accessLevel, 'PARTIAL', 'eski liderin bağımsız READ bağışı silinmez');
    assert.equal(stack.db.projectAccess.some((row) => row.Sicil === CREATOR && row.GrantSource === 'OWNER' && row.IsActive), true);
  } finally {
    await stack.dispose();
  }
});

function deletionSeed({ source = 'MANUAL', withTask = false, admin = true } = {}) {
  return baseSeed({
    systemAdminSicils: admin ? [CREATOR] : [],
    projects: [{
      ProjectId: OTHER_PROJECT_ID, SourceType: source, ProjectCode: source === 'CORPORATE' ? 'CN43N-X' : null,
      ProjectName: 'Silme Adayı', LeadSicil: LEAD, CalendarId: DEFAULT_CALENDAR_ID, IsActive: 1
    }],
    projectAccess: [{ ProjectId: OTHER_PROJECT_ID, Sicil: CREATOR, AccessLevel: 'FULL', GrantSource: 'OWNER' }],
    wbs: [seedRoot(OTHER_WBS_ID, OTHER_PROJECT_ID, 'Silme Adayı')],
    tasks: withTask ? [{ TaskId: TASK_ID, ProjectId: OTHER_PROJECT_ID, WbsId: OTHER_WBS_ID, Title: 'Tek görev', Status: 'todo' }] : [],
    taskAssignees: withTask ? [{ TaskId: TASK_ID, Sicil: CREATOR }] : []
  });
}

test('sistem yöneticisi boş manuel projeyi denetim izini koruyarak pasifleştirir', async () => {
  const stack = await createActualStack(deletionSeed(), { sicil: CREATOR, corporateWbsSource: false });
  try {
    const project = stack.state.projects[0];
    const result = await stack.repository.commitChanges({ projectDeletes: [{ id: project.id, version: project.version }] });
    assert.deepEqual(result.projectDeletes, [OTHER_PROJECT_ID]);
    assert.equal(stack.db.projects[0].IsActive, 0);
    assert.equal(stack.db.wbs.length, 1, 'tarihsel WBS fiziksel olarak korunur');
    assert.equal(stack.db.projectAccess[0].IsActive, 0);
    assert.equal(stack.db.auditLog.some((row) => row.ActionCode === 'DEACTIVATE' && row.EntityType === 'PROJECT'), true);
    assert.equal(stack.db.auditLog.some((row) => row.ActionCode === 'DEACTIVATE' && row.EntityType === 'PROJECT_ACCESS'), true);
  } finally {
    await stack.dispose();
  }
});

test('kalıcı denetim şeması proje pasifleştirme eylemini kabul eder', () => {
  const createSql = fs.readFileSync(new URL('../database/MR_Create_Durable_Persistence.sql', import.meta.url), 'utf8');
  const upgradeSql = fs.readFileSync(new URL('../database/MR_Upgrade_0006_Audit_Deactivation.sql', import.meta.url), 'utf8');
  assert.match(createSql, /ActionCode IN \('CREATE','UPDATE','DELETE','DEACTIVATE'\)/);
  assert.match(upgradeSql, /DROP CONSTRAINT CK_MR_AuditLog_Action/);
  assert.match(upgradeSql, /ActionCode IN \('CREATE','UPDATE','DELETE','DEACTIVATE'\)/);
});

test('manuel proje silme tekrarları idempotenttir ve eski sürüm erişim bağışlarını kapatmaz', async (t) => {
  await t.test('yanıtı kaybolan başarılı silme aynı istekle yeniden denenebilir', async () => {
    const stack = await createActualStack(deletionSeed(), { sicil: CREATOR, corporateWbsSource: false });
    try {
      const project = stack.state.projects[0];
      const deletion = { id: project.id, version: project.version };
      const first = await stack.repository.commitChanges({ projectDeletes: [deletion] });
      const retry = await stack.repository.commitChanges({ projectDeletes: [deletion] });

      assert.deepEqual(first.projectDeletes, [OTHER_PROJECT_ID]);
      assert.deepEqual(retry.projectDeletes, [OTHER_PROJECT_ID]);
      assert.equal(stack.db.projects[0].IsActive, 0);
      assert.equal(stack.db.auditLog.filter((row) => row.EntityType === 'PROJECT').length, 1);
    } finally { await stack.dispose(); }
  });

  await t.test('eski sürümle silme projeyi ve erişimleri etkin bırakır', async () => {
    const stack = await createActualStack(deletionSeed(), { sicil: CREATOR, corporateWbsSource: false });
    try {
      await assert.rejects(
        stack.repository.commitChanges({
          projectDeletes: [{ id: OTHER_PROJECT_ID, version: Buffer.alloc(8, 255).toString('base64') }]
        }),
        (error) => error.code === 'CONFLICT'
      );
      assert.equal(stack.db.projects[0].IsActive, 1);
      assert.equal(stack.db.projectAccess[0].IsActive, 1);
      assert.equal(stack.db.auditLog.length, 0);
    } finally { await stack.dispose(); }
  });
});

test('manuel proje silme matrisi görev, rol ve kurumsal kaynak sınırlarını korur', async (t) => {
  await t.test('admin + görevli manuel proje reddedilir', async () => {
    const stack = await createActualStack(deletionSeed({ withTask: true }), { sicil: CREATOR, corporateWbsSource: false });
    try {
      const project = stack.state.projects[0];
      await assert.rejects(
        stack.repository.commitChanges({ projectDeletes: [{ id: project.id, version: project.version }] }),
        (error) => error.code === 'MUTATION_FAILED' && /görev içerdiği/.test(error.message)
      );
    } finally { await stack.dispose(); }
  });

  await t.test('yönetici olmayan + boş manuel proje reddedilir', async () => {
    const stack = await createActualStack(deletionSeed({ admin: false }), { sicil: CREATOR, corporateWbsSource: false });
    try {
      const project = stack.state.projects[0];
      await assert.rejects(
        stack.repository.commitChanges({ projectDeletes: [{ id: project.id, version: project.version }] }),
        (error) => error.code === 'FORBIDDEN'
      );
    } finally { await stack.dispose(); }
  });

  await t.test('yönetici olmayan kullanıcı bilinmeyen proje kimliğinde de aynı FORBIDDEN sonucunu alır', async () => {
    const stack = await createActualStack(deletionSeed({ admin: false }), { sicil: CREATOR, corporateWbsSource: false });
    try {
      await assert.rejects(
        stack.repository.commitChanges({
          projectDeletes: [{ id: UNKNOWN_PROJECT_ID, version: Buffer.alloc(8, 1).toString('base64') }]
        }),
        (error) => error.code === 'FORBIDDEN'
      );
    } finally { await stack.dispose(); }
  });

  await t.test('admin + kurumsal proje reddedilir', async () => {
    const stack = await createActualStack(deletionSeed({ source: 'CORPORATE' }), { sicil: CREATOR, corporateWbsSource: false });
    try {
      const project = stack.state.projects[0];
      await assert.rejects(
        stack.repository.commitChanges({ projectDeletes: [{ id: project.id, version: project.version }] }),
        (error) => error.code === 'FORBIDDEN' && /Kurumsal\/CN43N/.test(error.message)
      );
      assert.equal(stack.db.projects[0].IsActive, 1);
    } finally { await stack.dispose(); }
  });
});

test('kurumsal lider alanı manuel lider türetmesini ve CN43N WBS korumasını değiştirmez', async () => {
  const corporateSeed = deletionSeed({ source: 'CORPORATE', admin: false });
  const stack = await createActualStack(corporateSeed, { sicil: LEAD, corporateWbsSource: false });
  try {
    assert.equal(stack.state.projects.length, 0, 'kurumsal LeadSicil tek başına görünürlük vermez');
  } finally {
    await stack.dispose();
  }

  const adminStack = await createActualStack(
    { ...corporateSeed, systemAdminSicils: [CREATOR] },
    { sicil: CREATOR, corporateWbsSource: false }
  );
  try {
    const node = adminStack.state.wbs[0];
    await assert.rejects(
      adminStack.repository.commitChanges({ wbsUpserts: [{ ...node, name: 'Yetkisiz CN43N adı' }] }),
      (error) => error.code === 'FORBIDDEN' && /CN43N/.test(error.message)
    );
  } finally {
    await adminStack.dispose();
  }
});
