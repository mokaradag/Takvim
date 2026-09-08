import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveTaskMutationAccess } from '../src/state/projectWritePolicy.js';
import { scheduleProposalRows, SCHEDULE_DATE_ROWS } from '../src/features/schedule-change/scheduleChangePresentation.js';
import {
  TASK_TABLE_FACET_KEYS,
  taskTableFacetValues,
  taskTableMatches
} from '../src/features/tasks/taskTableFacets.js';
import {
  allWbsIds,
  expandedIdsForLevel,
  levelForExpandedIds,
  wbsTreeDepth
} from '../src/features/gantt/ganttOutlineLevels.js';
import {
  buildExportSheets,
  buildProjectCsv,
  buildProjectCsvBundle,
  buildProjectWorkbook,
  sheetToCsv
} from '../src/lib/exportProjectData.js';
import {
  buildXlsxWorkbook,
  columnLetter,
  escapeXml,
  excelSerialDate,
  neutralizeCellText,
  normalizeSheetName,
  XLSX_CONTENT_TYPE
} from '../src/lib/xlsx/xlsxWorkbook.js';
import { buildZipArchive, crc32 } from '../src/lib/xlsx/zipArchive.js';
import { createTaskPatchCoalescer } from '../src/state/persistence.js';

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function assertSimpleEntrySavingBoundary(source) {
  const shellStart = source.indexOf('<div className="simple-entry-shell">');
  const formStart = source.indexOf('<form className="simple-entry-card"', shellStart);
  const formTagEnd = source.indexOf('>', formStart);
  const formEnd = source.indexOf('</form>', formTagEnd);
  const overlayStart = source.indexOf('<SavingOverlay active={saving}', formEnd);
  const shellEnd = source.indexOf('</div>', overlayStart);

  assert.ok(shellStart >= 0 && formStart > shellStart, 'etkileşimli form kayıt kabının içinde olmalıdır');
  assert.match(source.slice(formStart, formTagEnd + 1), /inert=\{saving \? '' : undefined\}/);
  assert.ok(formEnd > formTagEnd && overlayStart > formEnd, 'kayıt perdesi inert formdan sonra gelmelidir');
  assert.ok(shellEnd > overlayStart, 'kayıt perdesi aynı kayıt kabının içinde kalmalıdır');
  assert.doesNotMatch(source.slice(formStart, formEnd), /<SavingOverlay/);
}

/* ── 1 · Sorumlu kendi plan ve gerçekleşen tarihlerini yönetir ── */

function assigneeState({ accessLevel = 'PARTIAL', assignable = [] } = {}) {
  return {
    projects: [{ id: 'p1', name: 'Kurumsal Proje', accessLevel }],
    assignableProjects: assignable,
    currentUser: { id: '1001' },
    tasks: [{
      id: 't1',
      projectId: 'p1',
      isCurrentUserAssignee: true,
      isCurrentUserCreator: false,
      createdBySicil: '2002',
      assigneeIds: ['1001'],
      assigneeCount: 1
    }]
  };
}

test('göreve atanan sıradan kullanıcı plan tarihlerini düzenler, hedef bitişi öneriyle ister', () => {
  const access = resolveTaskMutationAccess(assigneeState(), 't1', {});
  assert.equal(access.ok, true);
  assert.equal(access.canControlSchedule, true);
  assert.equal(access.canEditTargetFinish, false);
  assert.equal(access.canProposeSchedule, true);

  // HEDEF bitiş doğrudan yazılamaz.
  const rejected = resolveTaskMutationAccess(assigneeState(), 't1', { targetFinish: '2026-09-30' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.field, 'targetFinish');

  // Plan ve gerçekleşen tarihler kabul edilir.
  for (const field of ['plannedStart', 'plannedFinish', 'actualStart', 'actualFinish']) {
    const result = resolveTaskMutationAccess(assigneeState(), 't1', { [field]: '2026-09-10' });
    assert.equal(result.ok, true, field);
  }
});

test('atama kapsamı taşıyan sorumlu da kendi plan tarihlerini doğrudan yazabilir', () => {
  // Yönetici/atama kapsamı projeyi yazılabilir yapar; kullanıcı aynı zamanda
  // görevin sorumlusuysa sunucu dar sorumlu yolunu uygular (assigneeWorkOnly).
  // İstemci bayrağı yalnızca `full` değerine baksaydı panel salt okunur açardı.
  const state = assigneeState({ assignable: [{ id: 'p1', name: 'Kurumsal Proje' }] });
  const access = resolveTaskMutationAccess(state, 't1', {});
  assert.equal(access.ok, true);
  assert.equal(access.scope, 'ASSIGNMENT');
  assert.equal(access.canControlSchedule, true);
  assert.equal(access.canEditTargetFinish, false);
});

test('tarih talebi penceresi yalnızca doğrudan yazılamayan alanı sorar', () => {
  const rows = scheduleProposalRows(['targetFinish']);
  assert.deepEqual(rows.map((row) => row.key), ['targetFinish']);
  // Alan verilmezse eski davranış korunur: üç tarih birlikte önerilir.
  assert.deepEqual(scheduleProposalRows(null), SCHEDULE_DATE_ROWS);
  assert.deepEqual(scheduleProposalRows([]), SCHEDULE_DATE_ROWS);
});

test('paneller talep penceresine yalnızca yazılamayan alanı geçirir', () => {
  for (const path of [
    'src/features/task-detail/TaskDrawer.jsx',
    'src/features/task-detail/SimpleTaskDrawer.jsx'
  ]) {
    const source = read(path);
    assert.match(source, /canControlSchedule && !canEditTargetFinish \? \['targetFinish'\] : null/);
    assert.match(source, /fields=\{proposableScheduleFields\}/);
  }
});

/* ── 2 · Kayıt göstergeleri ─────────────────────────────────── */

test('kayıt sürerken dönen halka ve perde gösterilir', () => {
  const loader = read('src/components/Loader.jsx');
  assert.match(loader, /export function Spinner/);
  assert.match(loader, /export function ButtonSpinner/);
  assert.match(loader, /export function SavingOverlay/);

  const panel = read('src/features/simple/SimpleModePanel.jsx');
  assert.match(panel, /<SavingOverlay active=\{saving\}/);
  assert.match(panel, /<ButtonSpinner busy=\{saving\}/);
  assertSimpleEntrySavingBoundary(panel);

  const tasksView = read('src/features/tasks/TasksView.jsx');
  assert.match(tasksView, /beginTaskDraft/);
  assert.doesNotMatch(tasksView, /<ButtonSpinner/);

  const drawer = read('src/features/task-detail/TaskDrawer.jsx');
  assert.match(drawer, /isSaving \? <Spinner size=\{13\} \/> : <Icons.Save size=\{14\} \/>/);

  const status = read('src/components/shell/PersistenceStatus.jsx');
  assert.match(status, /<Spinner size=\{14\} \/> Kaydediliyor…/);

  const css = read('src/app/styles/components.css');
  assert.match(css, /\.app-spinner \{/);
  assert.match(css, /@keyframes app-spin/);
  assert.match(css, /\.saving-overlay \{/);
});

test('kalıcılaştırma kuyruğu yeniden bağlanmada diriltilir', async () => {
  const calls = [];
  const coalescer = createTaskPatchCoalescer(async (id, patch) => {
    calls.push([id, patch]);
    return { ok: true, value: null };
  }, { delayMs: 0 });

  coalescer.dispose();
  const rejected = await coalescer.schedule('t1', { task: 'A' });
  assert.equal(rejected.ok, false);

  // StrictMode sahte sökülmesinden sonra kuyruk yeniden kullanılabilir olmalıdır.
  coalescer.revive();
  const accepted = await coalescer.schedule('t1', { task: 'B' });
  assert.equal(accepted.ok, true);
  assert.deepEqual(calls, [['t1', { task: 'B' }]]);

  const provider = read('src/state/AppStateProvider.jsx');
  assert.match(provider, /persistence\.revive\(\);/);
});

/* ── 3 · Görev künyesi ve avatarlar ─────────────────────────── */

test('görev künyesi oluşturanın adını görev satırından okur', () => {
  const byline = read('src/features/task-detail/TaskCreatorByline.jsx');
  assert.match(byline, /task\?\.createdByName \|\| fallback\?\.name/);
  assert.match(byline, /person\?\.name/);
  assert.match(byline, /Görevi tanımlayan/);

  const repository = read('src/server/repository/sqlAppRepository.js');
  assert.match(repository, /creatorViewerAssignment\.Sicil = @sicil/);
  assert.match(repository, /creatorAuth\.IdentityVisible = 1 THEN t\.CreatedBySicil ELSE NULL END AS VisibleCreatedBySicil/);
  assert.match(repository, /createdBySicil: row\.VisibleCreatedBySicil == null/);
});

test('paneldeki sorumlu kartı görev kapsamlı fotoğraf kimliklerini taşır', () => {
  for (const path of [
    'src/features/task-detail/TaskDrawer.jsx',
    'src/features/task-detail/SimpleTaskDrawer.jsx'
  ]) {
    const source = read(path);
    assert.match(source, /assigneeAvatarIdentities: local\.assigneeAvatarIdentities/);
  }
});

/* ── 4 · Kenar çubuğu hızlı eylemleri ───────────────────────── */

test('kip, tema ve oturum eylemleri kenar çubuğunun altında yer alır', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  assert.doesNotMatch(shell, /QuickActions/);
  assert.match(shell, /const signOutState = useSignOut\(\);/);
  assert.equal((shell.match(/signOutState=\{signOutState\}/g) || []).length, 1);

  const sidebar = read('src/components/shell/SidebarUserPanel.jsx');
  assert.match(sidebar, /signOutState/);
  assert.match(sidebar, /sidebar-mode-toggle/);
  assert.match(sidebar, /role="group" aria-label="Çalışma kipi"/);
  assert.match(sidebar, /aria-pressed=\{simpleMode\}/);
  assert.match(sidebar, /aria-pressed=\{!simpleMode\}/);
  assert.match(sidebar, /onToggleTheme/);
  assert.match(sidebar, /onClick=\{signOut\}/);
  assert.doesNotMatch(sidebar, /useSignOut\(\)/);

  const signOut = read('src/components/shell/useSignOut.js');
  assert.match(signOut, /if \(requestInFlightRef\.current\) return;/);
  assert.match(signOut, /requestInFlightRef\.current = true;/);
  assert.match(signOut, /const controller = new AbortController\(\);/);
  assert.match(signOut, /setTimeout\(\(\) => controller\.abort\(\), SIGN_OUT_TIMEOUT_MS\)/);
  assert.match(signOut, /signal: controller\.signal/);
  assert.match(signOut, /finally \{\s*clearTimeout\(timeoutId\);/);
});

/* ── 5 · Çapraz sütun süzgeç fasetleri ──────────────────────── */

const FACET_TASKS = [
  {
    id: 't1', projectId: 'p1', proje: 'Alfa', keyword: 'Analiz', status: 'todo',
    priority: 'high', assigneeIds: ['1'], sorumlu: ['Ali'], targetFinish: '2026-12-01',
    plannedStart: '2026-09-01', plannedFinish: '2026-09-05', progress: 0
  },
  {
    id: 't2', projectId: 'p2', proje: 'Beta', keyword: 'Tasarım', status: 'done',
    priority: 'low', assigneeIds: ['2'], sorumlu: ['Veli'], targetFinish: '2026-12-02',
    plannedStart: '2026-09-02', plannedFinish: '2026-09-06', progress: 100
  }
];

test('bir sütuna süzgeç uygulandığında öteki sütunlar yalnızca görünen değerleri listeler', () => {
  const state = { search: '', filters: { proje: ['p1'] } };
  assert.deepEqual([...taskTableFacetValues(FACET_TASKS, state, 'sorumlu')], ['1']);
  assert.deepEqual([...taskTableFacetValues(FACET_TASKS, state, 'keyword')], ['Analiz']);
  assert.deepEqual([...taskTableFacetValues(FACET_TASKS, state, 'priority')], ['high']);

  // Sütunun KENDİ süzgeci hesap dışıdır: kullanıcı ikinci bir proje ekleyebilmelidir.
  assert.deepEqual(
    [...taskTableFacetValues(FACET_TASKS, state, 'proje')].sort(),
    ['p1', 'p2']
  );
});

test('faset yüklemi satır süzmesiyle aynı sonucu verir', () => {
  const state = { search: 'beta', filters: { status: ['done'] } };
  assert.equal(taskTableMatches(FACET_TASKS[0], state), false);
  assert.equal(taskTableMatches(FACET_TASKS[1], state), true);
  assert.deepEqual(TASK_TABLE_FACET_KEYS, ['proje', 'keyword', 'sorumlu', 'status', 'priority']);

  const view = read('src/features/tasks/TasksView.jsx');
  assert.match(view, /taskTableMatches\(task, \{ search, filters: colFilter, dateMode: 'effective' \}, null, today_\)/);
});

/* ── 6 · Kilometre taşı ─────────────────────────────────────── */

test('gelişmiş panel kilometre taşı anahtarı sunar ve süreyi sıfırlar', () => {
  const drawer = read('src/features/task-detail/TaskDrawer.jsx');
  assert.match(drawer, /function milestonePatch\(date\)/);
  assert.match(drawer, /\{ milestone: true, isMilestone: true, plannedStart: day, plannedFinish: day \}/);
  assert.match(drawer, /label="Kilometre taşı"/);
  // Anahtar TEK bir düğmedir: `<label>` sarmalayıcısı tıklamayı ikinci kez
  // ileterek değeri geri alıyordu.
  assert.match(drawer, /<button\s+type="button"\s+role="switch"/);
  assert.doesNotMatch(drawer, /<label className=\{`toggle-field/);
  // Yedek günün TEK sahibi `milestonePatch`tir. Çağıran kendi `today()`
  // yedeğini eklerse truthy bir `Date` geçirir, kanonik yedek atlanır ve
  // tarihsiz bir görevde sunucuya ISO metin yerine `Date` giderdi.
  assert.match(drawer, /milestonePatch\(local\.plannedStart \|\| local\.targetFinish\)/);
  assert.doesNotMatch(drawer, /milestonePatch\([^)]*today\(\)/);
  // Anahtar PLAN tarihi yazdığı için yazdığı alanların yetkisine de bakar.
  // Kilit ANAHTARIN kendi etiketinde aranır: aynı dosyadaki planlanan tarih
  // alanları da aynı kilidi taşıyor, çıplak bir arama anahtar kilidini
  // kaybetse bile geçerdi. `[^<>]` eşleşmenin etiket sınırını aşmasını keser.
  assert.match(drawer, /checked=\{milestone\}[^<>]*disabled=\{!canControlSchedule\}/);
});

test('yapı yetkisi takvim yetkisini İMA eder', () => {
  // Kilometre taşı anahtarı yapı yetkisiyle görünür ama plan tarihi yazar. Bu
  // ikisi ayrışsaydı anahtar, kapalı olan takvim denetimini atlardı. Aşağıdaki
  // durumlarda `canManageStructure` yalnızca tam proje yetkisiyle açılır ve o
  // durumda `canControlSchedule` de açıktır.
  const cases = [
    ['tam yetki', { accessLevel: 'FULL' }],
    ['kısmi görünürlük', { accessLevel: 'PARTIAL' }],
    ['atama kapsamı', { accessLevel: 'PARTIAL', assignable: [{ id: 'p1', name: 'Kurumsal Proje' }] }]
  ];
  for (const [label, options] of cases) {
    const access = resolveTaskMutationAccess(assigneeState(options), 't1', {});
    assert.equal(access.ok, true, label);
    if (access.canManageStructure) assert.equal(access.canControlSchedule, true, label);
  }
  // Yapı yetkisi gerçekten açılabiliyor olmalı, yoksa döngü boş doğrular.
  const full = resolveTaskMutationAccess(assigneeState({ accessLevel: 'FULL' }), 't1', {});
  assert.equal(full.canManageStructure, true);
  assert.equal(full.canControlSchedule, true);
});

/* ── 7 · Gantt anahat seviyeleri ────────────────────────────── */

const TREE = [
  { id: 'a', children: [{ id: 'a1', children: [{ id: 'a11', children: [] }] }] },
  { id: 'b', children: [] }
];

test('Gantt anahat seviyeleri açık dal kümesini belirler', () => {
  assert.equal(wbsTreeDepth(TREE), 3);
  assert.deepEqual([...allWbsIds(TREE)].sort(), ['a', 'a1', 'a11', 'b']);
  assert.deepEqual([...expandedIdsForLevel(TREE, 1)], []);
  assert.deepEqual([...expandedIdsForLevel(TREE, 2)].sort(), ['a', 'b']);
  // EN DERİN seviye "tümünü genişlet" ile aynı kümedir; yaprak düğümler de
  // içeridedir, yoksa ağaç tümüyle açıkken hiçbir seviye etkin görünmezdi.
  assert.deepEqual([...expandedIdsForLevel(TREE, 3)].sort(), [...allWbsIds(TREE)].sort());

  assert.equal(levelForExpandedIds(TREE, new Set()), 1);
  assert.equal(levelForExpandedIds(TREE, new Set(['a', 'b'])), 2);
  assert.equal(levelForExpandedIds(TREE, allWbsIds(TREE)), 3);
  // Elle açılmış karışık küme hiçbir seviyeye karşılık gelmez.
  assert.equal(levelForExpandedIds(TREE, new Set(['a1'])), null);
});

test('kimliksiz dal üç yardımcıda da aynı biçimde biter', () => {
  // `buildRows` açık dal kümesini kimlikle sorgular: kimliksiz düğüm hiçbir
  // zaman açılamaz, altındakiler görünemez. Derinlik o dalı sayıp öteki iki
  // yardımcı elediğinde en derin seviye "tümünü genişlet" kümesini
  // tutturamıyor ve hiçbir seviye düğmesi etkin görünmüyordu.
  const tree = [
    { id: 'a', children: [{ children: [{ id: 'gizli', children: [] }] }] },
    { id: 'b', children: [] }
  ];
  assert.equal(wbsTreeDepth(tree), 1);
  assert.deepEqual([...allWbsIds(tree)].sort(), ['a', 'b']);
  assert.deepEqual([...expandedIdsForLevel(tree, 1)].sort(), [...allWbsIds(tree)].sort());
  assert.equal(levelForExpandedIds(tree, allWbsIds(tree)), 1);
});

test('tek seviyeli ağaçta 1. seviye tümünü genişletir', () => {
  // Yalnızca yaprak köklerden oluşan ağaçta açılış kümesi `allWbsIds()`tir.
  // 1. seviyenin erken çıkışı boş küme döndürdüğü sürece bu küme hiçbir
  // seviyeye uymuyor ve düğmelerin hiçbiri etkin görünmüyordu.
  const flat = [{ id: 'a', children: [] }, { id: 'b', children: [] }];
  assert.equal(wbsTreeDepth(flat), 1);
  assert.deepEqual([...expandedIdsForLevel(flat, 1)].sort(), ['a', 'b']);
  assert.equal(levelForExpandedIds(flat, allWbsIds(flat)), 1);
  // Derin ağaçta 1. seviye hâlâ yalnızca kökleri gösterir (hiçbir dal açık değil).
  assert.deepEqual([...expandedIdsForLevel(TREE, 1)], []);
});

test('Gantt denetimleri Türkçedir ve toplu genişlet/daralt sunar', () => {
  const controls = read('src/features/gantt/GanttOutlineControls.jsx');
  assert.match(controls, /Genişlet/);
  assert.match(controls, /Daralt/);
  assert.match(controls, /Seviye/);

  for (const path of ['src/features/gantt/GanttView.jsx', 'src/features/gantt/WbsGanttView.jsx']) {
    const source = read(path);
    assert.match(source, /Yakınlaştırma/);
    assert.match(source, /<GanttOutlineControls/);
    assert.doesNotMatch(source, />Zoom</);
  }
});

/* ── 8 · Dışa aktarma ───────────────────────────────────────── */

const EXPORT_INPUT = {
  project: null,
  projects: [
    { id: 'p1', code: 'PRJ-1', name: 'Alfa', projectTypeName: 'Kurumsal', lead: 'Ali', dataDate: '2026-08-01' }
  ],
  wbs: [{ id: 'w1', projectId: 'p1', parentId: null, code: '1', name: 'Kök' }],
  tasks: [{
    id: 't1', projectId: 'p1', projectCode: 'PRJ-1', proje: 'Alfa', wbsId: 'w1',
    task: 'Analiz', keyword: 'Test', sorumlu: ['Ali'], status: 'in_progress', priority: 'high',
    plannedStart: '2026-07-22', plannedFinish: '2026-07-24', targetFinish: '2026-07-25',
    progress: 25, deps: []
  }]
};

test('Excel çıktısı gerçek bir çalışma kitabıdır ve uyarısız açılır', () => {
  const workbook = buildProjectWorkbook(EXPORT_INPUT);
  const bytes = Buffer.from(workbook);
  // ZIP imzası: dosya artık `.xls` uzantılı HTML değil, gerçek `.xlsx` kabıdır.
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'PK');
  const text = bytes.toString('utf8');
  assert.match(text, /xl\/workbook\.xml/);
  assert.match(text, /xl\/styles\.xml/);
  assert.match(text, /xl\/worksheets\/sheet4\.xml/);
  assert.match(text, /state="frozen"/);
  assert.match(text, /<autoFilter/);
  assert.equal(
    XLSX_CONTENT_TYPE,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );

  const menu = read('src/components/shell/ProjectExportMenu.jsx');
  assert.match(menu, /\$\{baseName\}_Raporu\.xlsx/);
  assert.doesNotMatch(menu, /\.xls'/);
});

test('çalışma kitabı özet, görev, WBS ve portföyde proje sayfalarını taşır', () => {
  const sheets = buildExportSheets(EXPORT_INPUT);
  assert.deepEqual(sheets.map((sheet) => sheet.name), ['Özet', 'Görevler', 'İş Dağılım Ağacı', 'Projeler']);
  // Tek proje çıktısında proje listesi tekrarlanmaz.
  const single = buildExportSheets({ ...EXPORT_INPUT, project: EXPORT_INPUT.projects[0] });
  assert.deepEqual(single.map((sheet) => sheet.name), ['Özet', 'Görevler', 'İş Dağılım Ağacı']);
  // Proje sütunu YALNIZCA portföy çıktısında bulunur.
  assert.equal(sheets[1].columns[0].header, 'Proje');
  assert.equal(single[1].columns[0].header, 'WBS');
  // Tarih ve yüzde sütunları tür taşır: Excel gerçek tarih ve oran hücresi yazar.
  const taskColumns = new Map(sheets[1].columns.map((column) => [column.header, column.type]));
  assert.equal(taskColumns.get('Başlangıç'), 'date');
  assert.equal(taskColumns.get('İlerleme'), 'percent');
});

test('CSV paketi her sayfayı ayrı dosya olarak taşır ve düz CSV korunur', () => {
  const bundle = Buffer.from(buildProjectCsvBundle(EXPORT_INPUT, { baseName: 'Rapor' }));
  const text = bundle.toString('utf8');
  assert.equal(bundle.subarray(0, 2).toString('latin1'), 'PK');
  for (const name of ['01_Özet.csv', '02_Görevler.csv', '03_İş_Dağılım_Ağacı.csv', '04_Projeler.csv']) {
    assert.ok(text.includes(`Rapor/${name}`), name);
  }

  // Eski tek dosyalık CSV sözleşmesi değişmez.
  const csv = buildProjectCsv(EXPORT_INPUT);
  assert.match(csv, /^WBS;Görev;Etiket/);
  assert.match(csv, /22\/07\/2026/);
  assert.match(csv, /25%/);
});

test('sayfa modeli CSV yazımında okunur tarih ve yüzde üretir', () => {
  const [, tasksSheet] = buildExportSheets(EXPORT_INPUT);
  const csv = sheetToCsv(tasksSheet);
  assert.match(csv, /22\/07\/2026/);
  assert.match(csv, /%25/);

  const invalidDateSheet = {
    columns: [{ header: 'Başlangıç', key: 'baslangic', type: 'date' }],
    rows: [{ baslangic: '2026-02-30' }]
  };
  assert.match(sheetToCsv(invalidDateSheet), /2026-02-30/);
  assert.doesNotMatch(sheetToCsv(invalidDateSheet), /02\/03\/2026/);

  const invalidFlatCsv = buildProjectCsv({
    ...EXPORT_INPUT,
    tasks: [{ ...EXPORT_INPUT.tasks[0], plannedStart: '2026-02-30' }]
  });
  assert.match(invalidFlatCsv, /2026-02-30/);
  assert.doesNotMatch(invalidFlatCsv, /02\/03\/2026/);

  const hiddenPredecessorId = 'a1b2c3d4-0000-4000-8000-000000000004';
  const partialDependencyCsv = buildProjectCsv({
    ...EXPORT_INPUT,
    tasks: [{
      ...EXPORT_INPUT.tasks[0],
      deps: [{ predecessorId: hiddenPredecessorId, type: 'SS', lagValue: 2, lagUnit: 'day' }]
    }]
  });
  assert.match(partialDependencyCsv, /Bilinmeyen görev · SS · \+2 gün/);
  assert.doesNotMatch(partialDependencyCsv, new RegExp(hiddenPredecessorId));
});

test('xlsx yardımcıları hücre, sayfa adı ve tarih sözleşmesini korur', () => {
  assert.equal(columnLetter(1), 'A');
  assert.equal(columnLetter(26), 'Z');
  assert.equal(columnLetter(27), 'AA');
  assert.equal(excelSerialDate('1899-12-31'), null);
  assert.equal(excelSerialDate('1900-01-01'), 1);
  assert.equal(excelSerialDate('1900-02-28'), 59);
  assert.equal(excelSerialDate('1900-03-01'), 61);
  assert.equal(excelSerialDate('2026-08-28'), 46262);
  assert.equal(excelSerialDate('gecersiz'), null);
  assert.equal(excelSerialDate('2026-02-28invalid'), null);
  assert.equal(excelSerialDate('0100-01-01'), null);
  assert.equal(excelSerialDate('2024-02-29'), 45351);
  // Takvimde OLMAYAN gün metne düşer. `Date.UTC` taşan alanları sessizce
  // devrediyor, bozuk tarih çıktıda makul görünen BAŞKA bir tarihe
  // dönüşüyordu: 30 Şubat 2 Mart'a, 0. ay bir önceki yıla.
  assert.equal(excelSerialDate('2026-02-30'), null);
  assert.equal(excelSerialDate('2026-02-29'), null);
  assert.equal(excelSerialDate('2026-13-01'), null);
  assert.equal(excelSerialDate('2026-00-10'), null);
  assert.equal(excelSerialDate('2026-01-32'), null);
  // Formül enjeksiyonu nötrlenir.
  assert.equal(neutralizeCellText('=1+1'), "'=1+1");
  assert.equal(neutralizeCellText('@cmd'), "'@cmd");
  assert.equal(neutralizeCellText('Analiz'), 'Analiz');
  assert.equal(escapeXml(`a\u0000b\uFFFEc\uFFFFd`), 'abcd');
  assert.equal(escapeXml('Görev 🚀'), 'Görev 🚀');
  const workbookXml = Buffer.from(buildProjectWorkbook(EXPORT_INPUT)).toString('utf8');
  assert.match(workbookXml, /<color rgb="FF000000"\/>/);
  assert.doesNotMatch(workbookXml, /<color theme=/);
  const fractionalProgressWorkbook = Buffer.from(buildXlsxWorkbook({
    sheets: [{
      name: 'Kesirli İlerleme',
      columns: [{ header: 'İlerleme', key: 'ilerleme', type: 'percent' }],
      rows: [{ ilerleme: 25.5 }]
    }]
  })).toString('utf8');
  assert.match(fractionalProgressWorkbook, /<v>0\.255<\/v>/);
  assert.doesNotMatch(fractionalProgressWorkbook, /<v>0\.26<\/v>/);
  // Sayfa adı yasak karakter taşımaz, 31 karakteri aşmaz ve tekilleşir.
  const used = new Set();
  assert.equal(normalizeSheetName('Rapor/2026', used), 'Rapor 2026');
  assert.equal(normalizeSheetName('Rapor/2026', used), 'Rapor 2026 (2)');
  assert.equal(normalizeSheetName('x'.repeat(40), new Set()).length, 31);
});

test('ZIP arşivi geçerli merkezi dizin taşır', () => {
  const archive = Buffer.from(buildZipArchive([
    { name: 'a.txt', data: new TextEncoder().encode('merhaba') },
    { name: 'klasör/b.txt', data: new TextEncoder().encode('dünya') }
  ]));
  const eocd = archive.lastIndexOf(Buffer.from('PK', 'latin1'));
  assert.ok(eocd > 0);
  const entries = archive.readUInt16LE(eocd + 10);
  const size = archive.readUInt32LE(eocd + 12);
  const offset = archive.readUInt32LE(eocd + 16);
  assert.equal(entries, 2);
  // Merkezi dizinin boyutu ve konumu, sonlandırma kaydının başlangıcıyla
  // TAM örtüşmelidir; aksi hâlde arşiv "bozuk merkezi dizin" hatası verir.
  assert.equal(offset + size, eocd);
  assert.equal(archive.subarray(offset, offset + 4).toString('latin1'), 'PK');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);

  const futureArchive = Buffer.from(buildZipArchive(
    [{ name: 'future.txt', data: new Uint8Array() }],
    { modifiedAt: new Date(2200, 6, 15, 12, 30, 0) }
  ));
  const packedDate = futureArchive.readUInt16LE(12);
  assert.equal(1980 + ((packedDate >>> 9) & 0x7f), 2107);

  assert.throws(
    () => buildZipArchive([{ name: 'a'.repeat(0x10000), data: new Uint8Array() }]),
    /65\.535 baytı aşamaz/
  );

  assert.throws(
    () => buildZipArchive(
      [{ name: 'buyuk.txt', data: new Uint8Array(32) }],
      { maxArchiveBytes: 100 }
    ),
    (error) => error instanceof RangeError
      && error.code === 'ZIP_ARCHIVE_TOO_LARGE'
      && /Daha dar bir kapsam/.test(error.message)
  );
});

/* ── 10 · Görevler tablosunun dar alan davranışı ────────────── */

test('inceleme bulguları: dışa aktarma türleri, yerel gün ve proje sorumlusu', () => {
  const withLead = {
    ...EXPORT_INPUT,
    projects: [{ id: 'p1', code: 'PRJ-1', name: 'Alfa', leadId: '1001', dataDate: '2026-08-01' }],
    people: [{ id: '1001', name: 'Ayşe Kaya' }]
  };
  const sheets = buildExportSheets(withLead);
  const summary = sheets[0];
  // Özet değeri TÜRÜNÜ satır başına taşır; Excel gerçek tarih/yüzde hücresi yazar.
  assert.equal(summary.columns[1].typeKey, 'degerType');
  const byField = new Map(summary.rows.map((row) => [row.alan, row]));
  assert.equal(byField.get('Rapor tarihi').degerType, 'date');
  assert.match(byField.get('Rapor tarihi').deger, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(byField.get('Ortalama ilerleme').degerType, 'percent');
  assert.equal(typeof byField.get('Görev sayısı').deger, 'number');
  // Gerçek Sistem projesinde sorumlu adı `leadId` üzerinden çözülür.
  assert.equal(sheets[3].rows[0].sorumlu, 'Ayşe Kaya');

  const workbook = Buffer.from(buildProjectWorkbook(withLead)).toString('utf8');
  // Özet sayfasındaki tarih METİN değil, seri numaralı tarih hücresidir.
  assert.match(workbook, /<c r="B\d+" s="3"><v>\d+<\/v><\/c>/);

  const source = read('src/lib/exportProjectData.js');
  // Gün YEREL takvimden okunur (UTC dönüşümü bir önceki günü verebiliyordu).
  assert.match(source, /const todayIso = fmtISO\(today\(\)\);/);
  assert.doesNotMatch(source, /new Date\(\)\.toISOString\(\)/);
});

test('inceleme bulguları: dışa aktarma menüsü, kayıt perdesi ve erişilebilirlik', () => {
  const menu = read('src/components/shell/ProjectExportMenu.jsx');
  // Yeniden giriş engellenir ve düğmeler kapanır: iki tıklama iki çalışma
  // kitabı kurup iki indirme başlatıyordu.
  assert.match(menu, /if \(runningRef\.current\) return;/);
  assert.match(menu, /disabled=\{Boolean\(busy\)\}/);
  // Hata yutulmaz.
  assert.match(menu, /catch \(error\)/);
  assert.match(menu, /setFailure\(/);

  // Kayıt sürerken form klavyeye de kapanır.
  const panel = read('src/features/simple/SimpleModePanel.jsx');
  assertSimpleEntrySavingBoundary(panel);

  // Görev tablosunun erişilebilir adı vardır.
  assert.match(read('src/features/tasks/TasksView.jsx'), /aria-label="Görevler"/);

  // Kilometre taşı yedeği kanonik ISO gündür.
  assert.match(read('src/features/task-detail/TaskDrawer.jsx'), /const day = date \|\| fmtISO\(today\(\)\);/);

  // Arama önceliği kimliğiyle ve etiketiyle tarar (Gantt'ın eski davranışı).
  const facets = read('src/features/tasks/taskTableFacets.js');
  assert.match(facets, /resolvePriority\(priority\)\?\.label/);
});

test('görev tablosunun eylem sütunu sağa yapışır ve sütunlar daraltıldı', () => {
  const css = read('src/app/styles/components.css');
  assert.match(css, /\.tasks-actions-col,\s*\n\.tasks-actions-cell \{[^}]*position: sticky/);
  assert.match(css, /\.tasks-actions-col,\s*\n\.tasks-actions-cell \{[^}]*right: 0/);
  assert.match(css, /\.tasks-table thead th \{ white-space: nowrap; \}/);
  assert.match(css, /@container gorevler-tablosu \(max-width: 1150px\)/);

  const view = read('src/features/tasks/TasksView.jsx');
  assert.match(view, /className="tasks-actions-cell"/);
  assert.match(view, /className="tasks-actions-col"/);
  // Tarih sütunları eski 130 piksellik alt sınırı taşımaz.
  assert.doesNotMatch(view, /label="Başlangıç" style=\{\{ minWidth: 130 \}\}/);

  const simple = read('src/features/tasks/SimpleTasksView.jsx');
  assert.match(simple, /className="tasks-actions-cell"/);
});
