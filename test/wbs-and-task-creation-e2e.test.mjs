// MERGEN Rota · İş Dağılım Ağacı ve görev oluşturma akışları için uçtan uca testler.
//
// Her test uygulama durumundan başlar, gerçek istemci deposunu, gerçek API rota
// gövdelerini ve gerçek SQL depo sarmalayıcılarını kullanır; yalnızca SQL Server
// bellek içi bir ikizle değiştirilir. Böylece ekran görüntülerinde bildirilen
// hatalar (ACTUAL_ID_INVALID, "Üst WBS aynı projede bulunmalıdır",
// "Görev WBS kaydı aynı projede olmalıdır") gerileme testleriyle kilitlenir.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CORPORATE_PROJECT_ID,
  CORPORATE_ROOT_WBS_ID,
  DEFAULT_CALENDAR_ID,
  corporateSeed,
  createActualStack
} from './helpers/actualStack.mjs';
import { createNewTask } from '../src/state/appState.js';
import { prepareProjectUpdateChanges } from '../src/state/projectCreation.js';
import { resolveWbsMutationAccess } from '../src/state/projectWritePolicy.js';

/* ── 1 · Kurumsal proje kimlikleri (SAP GUID biçimi) ─────────── */

test('kurumsal projenin rengi Gerçek Sistem kimliğiyle güncellenebilir', async () => {
  const stack = await createActualStack(corporateSeed());
  try {
    const project = stack.project('P4417041');
    assert.ok(project, 'kurumsal proje anlık görüntüde bulunmalıdır');
    // Anlık görüntü kimlikleri kanonik (küçük harf) döner; SAP GUID deseni reddedilmez.
    assert.equal(project.id, CORPORATE_PROJECT_ID.toLowerCase());

    const prepared = prepareProjectUpdateChanges(project.id, { ...project, color: 'rose' }, {
      projects: stack.state.projects,
      people: stack.state.people,
      calendars: stack.state.calendars,
      tasks: stack.state.tasks,
      wbs: stack.state.wbs
    });
    assert.equal(prepared.ok, true, prepared.error?.message);

    const result = await stack.persistence.commitChanges('project/update', prepared.changes);
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.value.projectUpserts[0].color, 'rose');
    assert.equal(stack.db.projects[0].ColorToken, 'rose');
    // Kurumsal proje sorumlusu kaynak sistemin sorumluluğundadır ve korunur.
    assert.equal(stack.db.projects[0].LeadSicil, 900010);
  } finally {
    await stack.dispose();
  }
});

test('kurumsal projede veri tarihi girilmeden proje güncellemesi tamamlanır', async () => {
  const stack = await createActualStack(corporateSeed());
  try {
    const project = stack.project('P4417041');
    assert.equal(project.dataDate, null);

    const prepared = prepareProjectUpdateChanges(project.id, {
      code: project.code,
      name: project.name,
      leadId: '',
      dataDate: '',
      color: 'cyan',
      tags: []
    }, {
      projects: stack.state.projects,
      people: stack.state.people,
      calendars: stack.state.calendars,
      tasks: stack.state.tasks,
      wbs: stack.state.wbs
    });
    assert.equal(prepared.ok, true, prepared.error?.message);

    const result = await stack.persistence.commitChanges('project/update', prepared.changes);
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(stack.db.projects[0].ColorToken, 'cyan');
    assert.equal(stack.db.projects[0].DataDate, null);
  } finally {
    await stack.dispose();
  }
});

/* ── 2 · Kurumsal projede görev oluşturma ────────────────────── */

test('kurumsal projede yeni görev kök WBS düğümüne bağlı olarak kaydedilir', async () => {
  const stack = await createActualStack(corporateSeed());
  try {
    const project = stack.project('P4417041');
    const root = stack.rootWbs(project.id);
    assert.equal(root.id, CORPORATE_ROOT_WBS_ID.toLowerCase());

    const task = createNewTask({
      ...stack.state,
      workspaceMode: 'project',
      selectedProjectId: project.id
    }, undefined, 'task-1abcde11-2f22-4a33-8b44-5c6d7e8f9a0b');
    assert.equal(task.projectId, project.id);
    assert.equal(task.wbsId, root.id);

    const result = await stack.persistence.mutate('task/create', { type: 'task/add', task });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(stack.db.tasks.length, 1);
    assert.equal(stack.db.tasks[0].ProjectId, CORPORATE_PROJECT_ID);
    assert.equal(stack.db.tasks[0].WbsId, CORPORATE_ROOT_WBS_ID);
    assert.equal(result.value.taskUpserts[0].wbsId, root.id);
  } finally {
    await stack.dispose();
  }
});

/* ── 3 · Serbest projede iş dağılım ağacı düzenleme ──────────── */

test('serbest proje oluşturulur ve kök düğümün altına alt düğüm eklenebilir', async () => {
  const stack = await createActualStack(corporateSeed());
  try {
    const projectId = 'project-2bcdef22-3a33-4b44-8c55-6d6e6f7a8b9c';
    const rootWbsId = 'wbs-3cdefa33-4b44-4c55-8d66-7e7f8a9b0c1d';
    const created = await stack.persistence.commitChanges('project/create', {
      projectUpserts: [{
        id: projectId,
        code: 'GEL-1',
        name: 'Deneme gelişmiş proje 1',
        source: 'manual',
        color: 'blue',
        leadId: '900001',
        calendarId: DEFAULT_CALENDAR_ID,
        dataDate: '2026-07-25',
        tags: []
      }],
      wbsUpserts: [{ id: rootWbsId, projectId, parentId: null, code: '1', name: 'Deneme gelişmiş proje 1', sortOrder: 1 }]
    });
    assert.equal(created.ok, true, created.error?.message);
    // Proje oluşturma anlık görüntüyü yeniden yüklemez: kabuk sökülmediği için
    // karşılama ekranı geri gelmez ve kullanıcı bulunduğu yerde kalır.
    assert.equal(stack.requests.filter((entry) => entry.path.endsWith('/snapshot')).length, 1);

    const storedProject = stack.state.projects.find((entry) => entry.id === projectId);
    assert.ok(storedProject, 'yeni proje istemci kimliğiyle duruma yazılmalıdır');
    assert.ok(storedProject.version, 'sunucunun sürüm anahtarı yerel kayda uygulanmalıdır');

    const storedRoot = stack.state.wbs.find((node) => node.id === rootWbsId);
    assert.ok(storedRoot, 'kök düğüm istemci kimliğiyle duruma yazılmalıdır');
    assert.equal(storedRoot.source, 'manual');

    // "Alt ekle" akışı: kök düğümün altına yeni bir dağılım düğümü.
    const childId = 'wbs-4defab44-5c55-4d66-8e77-8f9a0b1c2d3e';
    const childResult = await stack.persistence.mutate('wbs/create', {
      type: 'wbs/add-child',
      id: childId,
      parentId: rootWbsId,
      name: 'Tasarım'
    });
    assert.equal(childResult.ok, true, childResult.error?.message);

    const child = stack.state.wbs.find((node) => node.id === childId);
    assert.ok(child, 'alt düğüm duruma uygulanmalıdır');
    assert.equal(child.parentId, rootWbsId);
    assert.equal(child.code, '1.1');
    assert.equal(stack.db.wbs.filter((node) => node.SourceType === 'MANUAL').length, 2);

    // Aynı proje içinde ikinci bir kök düğüm oluşmadığı doğrulanır.
    const manualProject = stack.state.projects.find((entry) => entry.code === 'GEL-1');
    const roots = stack.projectWbs(manualProject.id).filter((node) => node.parentId == null);
    assert.equal(roots.length, 1);
  } finally {
    await stack.dispose();
  }
});

test('serbest projede görev, oluşturulan alt düğüme atanabilir', async () => {
  const stack = await createActualStack(corporateSeed());
  try {
    const projectId = 'project-5efabc55-6d66-4e77-8f88-9a0b1c2d3e4f';
    const rootWbsId = 'wbs-6fabcd66-7e77-4f88-8a99-0b1c2d3e4f5a';
    const created = await stack.persistence.commitChanges('project/create', {
      projectUpserts: [{
        id: projectId,
        code: 'BAS-1',
        name: 'Temel kip projesi',
        source: 'manual',
        color: 'emerald',
        leadId: '900001',
        calendarId: DEFAULT_CALENDAR_ID,
        dataDate: '2026-07-25',
        tags: ['Teklif']
      }],
      wbsUpserts: [{ id: rootWbsId, projectId, parentId: null, code: '1', name: 'Temel kip projesi', sortOrder: 1 }]
    });
    assert.equal(created.ok, true, created.error?.message);

    const storedProject = stack.state.projects.find((entry) => entry.code === 'BAS-1');
    const root = stack.rootWbs(storedProject.id);
    const taskId = 'task-7abcde77-8f88-4a99-8b0a-1c2d3e4f5a6b';
    const result = await stack.persistence.mutate('task/create', () => ({
      type: 'task/add',
      task: {
        ...createNewTask({ ...stack.state, workspaceMode: 'project', selectedProjectId: storedProject.id }, undefined, taskId),
        wbsId: root.id,
        task: 'Teklif hazırla',
        keyword: 'Teklif',
        assigneeIds: ['900001'],
        sorumlu: ['Test Kullanıcı']
      }
    }));
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(stack.db.tasks.length, 1);
    assert.equal(stack.db.taskAssignees.length, 1);
    assert.equal(stack.db.tasks[0].Title, 'Teklif hazırla');
  } finally {
    await stack.dispose();
  }
});

/* ── 4 · Kurumsal WBS salt okunurluğu ────────────────────────── */

test('kurumsal projenin dağılım ağacına istemciden düğüm eklenemez', async () => {
  const stack = await createActualStack(corporateSeed());
  try {
    const project = stack.project('P4417041');
    const root = stack.rootWbs(project.id);

    // Arayüz katmanı eylemi hiç göndermez.
    const access = resolveWbsMutationAccess(stack.state, root.id);
    assert.equal(access.ok, false);
    assert.equal(access.code, 'CORPORATE_WBS_READ_ONLY');
    assert.match(access.message, /CN43N/);

    // Sunucu da bağımsız olarak reddeder.
    const result = await stack.persistence.commitChanges('wbs/create', {
      wbsUpserts: [{
        id: 'wbs-8bcdef88-9a99-4b0a-8c1b-2d3e4f5a6b7c',
        projectId: project.id,
        parentId: root.id,
        code: 'P4417041.99',
        name: 'Elle eklenen düğüm',
        sortOrder: 99
      }]
    });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /CN43N/);
    assert.equal(stack.projectWbs(project.id).length, 1);
  } finally {
    await stack.dispose();
  }
});

/* ── 5 · CN43N eşitlemesi ────────────────────────────────────── */

function cn43nRows() {
  return [
    { 'Proje tanımı': 'P4417041', 'WBS element': 'P4417041.01', Name: 'Sistem Tasarımı', Level: 1, Status: 'REL', 'PYP kodu': '1', 'Proj.type': 'GD' },
    { 'Proje tanımı': 'P4417041', 'WBS element': 'P4417041.01.01', Name: 'Gereksinim Analizi', Level: 2, Status: 'REL', 'PYP kodu': '1.1', 'Proj.type': 'GD' },
    { 'Proje tanımı': 'P4417041', 'WBS element': 'P4417041.01.02', Name: 'Mimari Tasarım', Level: 2, Status: 'CRTD', 'PYP kodu': '1.2', 'Proj.type': 'GD' },
    { 'Proje tanımı': 'P4417041', 'WBS element': 'P4417041.02', Name: 'Üretim', Level: 1, Status: 'CRTD', 'PYP kodu': '2', 'Proj.type': 'GD' },
    { 'Proje tanımı': 'P4417041', 'WBS element': 'P4417041.02.01', Name: 'Montaj', Level: 2, Status: 'CRTD', 'PYP kodu': '2.1', 'Proj.type': 'GD' }
  ];
}

test('kurumsal iş dağılım ağacı CN43N kaynağından hiyerarşiyle eşitlenir', async () => {
  const stack = await createActualStack(corporateSeed({ corporateWbsRows: cn43nRows() }));
  try {
    const project = stack.project('P4417041');
    const nodes = stack.projectWbs(project.id);
    assert.equal(nodes.length, 6, 'kök düğüm ve beş CN43N elemanı beklenir');

    const byCode = new Map(nodes.map((node) => [node.code, node]));
    const root = stack.rootWbs(project.id);
    assert.equal(root.code, 'P4417041');

    // Seviye 1 elemanları proje kök düğümünün altındadır.
    assert.equal(byCode.get('P4417041.01').parentId, root.id);
    assert.equal(byCode.get('P4417041.02').parentId, root.id);
    // Seviye 2 elemanları PYP kodundaki üst anahat koduna bağlanır.
    assert.equal(byCode.get('P4417041.01.01').parentId, byCode.get('P4417041.01').id);
    assert.equal(byCode.get('P4417041.01.02').parentId, byCode.get('P4417041.01').id);
    assert.equal(byCode.get('P4417041.02.01').parentId, byCode.get('P4417041.02').id);

    // CN43N üstverisi arayüze taşınır.
    assert.equal(byCode.get('P4417041.01.02').source, 'corporate');
    assert.equal(byCode.get('P4417041.01.02').outlineCode, '1.2');
    assert.equal(byCode.get('P4417041.01.02').statusCode, 'CRTD');
    assert.equal(byCode.get('P4417041.01.02').level, 2);
    assert.equal(byCode.get('P4417041.01.02').elementTypeCode, 'GD');

    // Her projede tek kök düğüm değişmezi korunur.
    assert.equal(nodes.filter((node) => node.parentId == null).length, 1);
  } finally {
    await stack.dispose();
  }
});

test('CN43N eşitlemesi yinelenen yüklemelerde düğüm çoğaltmaz ve kaynaktan düşenleri kaldırır', async () => {
  const seed = corporateSeed({ corporateWbsRows: cn43nRows() });
  const stack = await createActualStack(seed);
  try {
    await stack.reload();
    const project = stack.project('P4417041');
    assert.equal(stack.projectWbs(project.id).length, 6, 'ikinci yükleme düğümleri çoğaltmamalıdır');

    // Kaynaktan bir eleman düşerse (görev veya alt düğüm bağı yoksa) kaldırılır.
    stack.db.corporateWbsRows = cn43nRows().filter((row) => row['WBS element'] !== 'P4417041.02.01');
    await stack.reload();
    const codes = stack.projectWbs(project.id).map((node) => node.code);
    assert.equal(codes.includes('P4417041.02.01'), false);
    assert.equal(codes.length, 5);
  } finally {
    await stack.dispose();
  }
});

test('CN43N kaynağına atanmış görev bulunan düğüm eşitlemede silinmez', async () => {
  const stack = await createActualStack(corporateSeed({ corporateWbsRows: cn43nRows() }));
  try {
    const project = stack.project('P4417041');
    const target = stack.projectWbs(project.id).find((node) => node.code === 'P4417041.02.01');
    const taskId = 'task-9cdefa99-0b0a-4c1b-8d2c-3e4f5a6b7c8d';
    const result = await stack.persistence.mutate('task/create', () => ({
      type: 'task/add',
      task: {
        ...createNewTask({ ...stack.state, workspaceMode: 'project', selectedProjectId: project.id }, undefined, taskId),
        wbsId: target.id,
        task: 'Montaj hazırlığı'
      }
    }));
    assert.equal(result.ok, true, result.error?.message);

    stack.db.corporateWbsRows = cn43nRows().filter((row) => row['WBS element'] !== 'P4417041.02.01');
    await stack.reload();

    const stillThere = stack.projectWbs(project.id).find((node) => node.code === 'P4417041.02.01');
    assert.ok(stillThere, 'görev bağı bulunan kurumsal düğüm korunmalıdır');
    assert.equal(stack.state.tasks.length, 1);
  } finally {
    await stack.dispose();
  }
});

test('CN43N kaynağı yapılandırılmadığında kurumsal proje yalnızca kök düğümle yüklenir', async () => {
  const stack = await createActualStack(corporateSeed({ corporateWbsRows: cn43nRows() }), { corporateWbsSource: false });
  try {
    const project = stack.project('P4417041');
    assert.equal(stack.projectWbs(project.id).length, 1);
  } finally {
    await stack.dispose();
  }
});
