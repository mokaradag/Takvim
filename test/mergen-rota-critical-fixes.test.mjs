// MERGEN Rota · kritik hata düzeltmeleri için gerileme testleri.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { computePopoverPlacement } from '../src/components/searchableSelectPlacement.js';
import { describeSaveError } from '../src/components/shell/persistenceStatusMessage.js';
import {
  MANUAL_PROJECT_OPTION_VALUE,
  withManualProjectOption
} from '../src/features/simple/simpleModePolicy.js';
import { normalizeActualChanges } from '../src/data/api/createApiRepository.js';
import { appStateReducer, createInitialState } from '../src/state/appState.js';
import { findUpsertIntentIssue } from '../src/server/repository/upsertIntentPolicy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const PROJECT_ID = '2d9f0b82-bf72-4b9d-b44e-21506f486697';
const WBS_ID = '3eaf1c93-c083-4cad-8f3f-32617f597708';
const TASK_ID = '4fb02da4-d194-4dbe-9040-4372806a8819';

function baseState(overrides = {}) {
  return createInitialState({
    calendars: [{ id: '5c0a1e35-1a1a-4a1a-8a1a-1a1a1a1a1a1a', name: 'Standart', workingDays: [1, 2, 3, 4, 5], holidays: [] }],
    projects: [{ id: PROJECT_ID, code: 'PRJ-1', name: 'Proje', color: 'blue', leadId: '100101', dataDate: '2026-01-01', tags: [], version: 'v1' }],
    people: [
      { id: '100101', employeeNo: '100101', name: 'Ahmet Yılmaz' },
      { id: '100102', employeeNo: '100102', name: 'Ahmet Yılmaz' },
      { id: '100103', employeeNo: '100103', name: 'Ayşe Kaya' }
    ],
    wbs: [{ id: WBS_ID, projectId: PROJECT_ID, parentId: null, code: '1', name: 'Proje', sortOrder: 1, version: 'v1' }],
    tasks: [{
      id: TASK_ID,
      projectId: PROJECT_ID,
      wbsId: WBS_ID,
      task: 'Görev',
      keyword: 'Etiket',
      status: 'todo',
      assigneeIds: [],
      sorumlu: [],
      deps: [],
      version: 'v1'
    }],
    baselines: [],
    taskBaselineSnapshots: [],
    ...overrides
  });
}

/* ── #3 · Aktif çalışma alanı açılır listesi ─────────────── */

test('açılır liste paneli tetikleyicinin altına yerleşir ve görünüm alanına sığdırılır', () => {
  const placement = computePopoverPlacement(
    { left: 12, right: 220, top: 100, bottom: 134, width: 208 },
    { width: 1440, height: 900 }
  );

  assert.equal(placement.openUp, false);
  assert.equal(placement.top, 140);
  assert.equal(placement.left, 12);
  assert.equal(placement.width, 280, 'dar tetikleyicide panel okunabilir asgari genişliğe çıkar');
  assert.ok(placement.listMaxHeight > 0 && placement.listMaxHeight <= 360);
});

test('alt kenara sıkışan açılır liste yukarı doğru açılır', () => {
  const placement = computePopoverPlacement(
    { left: 40, right: 300, top: 820, bottom: 854, width: 260 },
    { width: 1440, height: 900 }
  );

  assert.equal(placement.openUp, true);
  assert.equal(placement.top, null);
  assert.equal(placement.bottom, 900 - 820 + 6);
});

test('sağ kenara taşan açılır liste görünüm alanına geri çekilir', () => {
  const placement = computePopoverPlacement(
    { left: 1380, right: 1430, top: 100, bottom: 134, width: 50 },
    { width: 1440, height: 900 }
  );

  assert.ok(placement.left + placement.width <= 1440, 'panel yatay olarak taşmamalıdır');
});

test('açılır liste gövdeye taşınır; kenar çubuğu kırpması ve yığın bağlamı listeyi etkilemez', () => {
  const source = read('src/components/SearchableSelect.jsx');
  assert.match(source, /import \{ createPortal \} from 'react-dom'/);
  assert.match(source, /createPortal\(/);
  assert.match(source, /document\.body/);
  assert.match(source, /position: 'fixed'/);

  const css = read('src/app/styles/components.css');
  // Panelin arka planı saydam kalmamalıdır; ekran görüntüsündeki "arka planla
  // karışan liste" hatasının ikinci nedeni buydu.
  assert.match(css, /\.searchable-select-panel \{[^}]*background: var\(--bg-elev\)/s);
  assert.match(css, /\.searchable-select-panel \{[^}]*z-index: var\(--z-select-popover\)/s);
  assert.match(read('src/app/globals.css'), /--z-select-popover:\s*\d{3};/);
});

test('çalışma alanı seçimi geri alınabilir', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  assert.match(shell, /allowClear/);
  assert.match(shell, /clearLabel="Portföye dön \(tüm projeler\)"/);
  assert.match(shell, /workspace-back-btn/);
  assert.match(shell, /onClick=\{\(\) => selectWorkspace\(null\)\}/);
});

/* ── #4 · Basit Modda serbest proje tanımlama ────────────── */

test('serbest proje seçeneği kurumsal katalogdan önce listelenir', () => {
  const corporate = Array.from({ length: 500 }, (_, index) => ({ value: `p-${index}`, label: `Proje ${index}` }));
  const options = withManualProjectOption(corporate, true, { value: MANUAL_PROJECT_OPTION_VALUE, label: 'Serbest proje tanımla' });

  assert.equal(options[0].value, MANUAL_PROJECT_OPTION_VALUE);
  assert.equal(options.length, 501);
  // Görünür pencere ilk N sonuçla sınırlıdır: seçenek sona eklenirse hiç görünmez.
  assert.ok(options.slice(0, 70).some((option) => option.value === MANUAL_PROJECT_OPTION_VALUE));
});

test('proje oluşturma yetkisi olmayan oturumda serbest proje seçeneği eklenmez', () => {
  const options = withManualProjectOption([{ value: 'p-1' }], false);
  assert.deepEqual(options.map((option) => option.value), ['p-1']);
});

test('Basit Modda serbest proje tanımından kurumsal listeye dönüş vardır', () => {
  const source = read('src/features/simple/SimpleModePanel.jsx');
  assert.match(source, /Kurumsal proje listesine dön/);
  assert.match(source, /const returnToProjectList = \(\) => \{/);
});

test('Basit Modda proje oluşturmak hızlı görev formunu yeniden monte etmez', () => {
  const panel = read('src/features/simple/SimpleModePanel.jsx');
  const provider = read('src/state/AppStateProvider.jsx');

  assert.match(panel, /\{ focusWorkspace: false \}/);
  assert.doesNotMatch(panel, /selectWorkspace\(null\)/, 'çalışma alanı gidip gelmesi formu sıfırlıyordu');
  assert.match(provider, /async \(input, \{ focusWorkspace = true \} = \{\}\)/);
  assert.match(provider, /if \(focusWorkspace\) \{/);
});

/* ── #7, #8 · Sürüm anahtarı ve "Kayıt kimliği zaten kullanılıyor" ── */

test('yetkili proje yanıtı duruma uygulanır ve eski sürüm anahtarı tazelenir', () => {
  const state = baseState();
  const next = appStateReducer(state, {
    type: 'persistence/success',
    changes: { projectUpserts: [{ ...state.projects[0], color: 'rose', version: 'v2' }] },
    savedAt: '2026-07-25T00:00:00.000Z'
  });

  assert.equal(next.projects[0].version, 'v2');
  assert.equal(next.projects[0].color, 'rose');
});

test('sürümü tazelenmeyen proje ikinci güncellemede oluşturma çakışmasına düşer', () => {
  // Sunucu sözleşmesi: sürümsüz upsert = oluşturma niyeti. Durumda sürüm
  // anahtarı güncellenmezse ikinci kaydetme "Kayıt kimliği zaten kullanılıyor"
  // hatasıyla reddedilir; bu testin koruduğu davranış budur.
  assert.equal(findUpsertIntentIssue({ exists: true, version: null, entityType: 'PROJECT' }).code, 'UPSERT_CREATE_COLLISION');
  assert.equal(findUpsertIntentIssue({ exists: true, version: 'v2', entityType: 'PROJECT' }), null);

  const state = baseState();
  const committed = appStateReducer(state, {
    type: 'persistence/success',
    changes: { projectUpserts: [{ ...state.projects[0], version: 'v2' }] },
    savedAt: null
  });
  assert.equal(
    findUpsertIntentIssue({ exists: true, version: committed.projects[0].version, entityType: 'PROJECT' }),
    null
  );
});

test('proje silme yanıtı da duruma uygulanır', () => {
  const state = baseState();
  const next = appStateReducer(state, {
    type: 'data/apply-changes',
    changes: { projectDeletes: [PROJECT_ID] }
  });
  assert.deepEqual(next.projects, []);
});

/* ── #2 · Çalışanlara görev atama ────────────────────────── */

test('açık Sicil kimlikleri taşıyan yama adlardan yeniden türetilmez', () => {
  const state = baseState();
  const next = appStateReducer(state, {
    type: 'task/update',
    id: TASK_ID,
    patch: { assigneeIds: ['100102'], sorumlu: ['Ahmet Yılmaz'] }
  });

  // Aynı ada sahip iki çalışan varsa ad eşlemesi her ikisini de eler ve atama
  // sessizce kaybolurdu. Kimlik gönderildiğinde kimlik esas alınmalıdır.
  assert.deepEqual(next.tasks[0].assigneeIds, ['100102']);
  assert.deepEqual(next.tasks[0].sorumlu, ['Ahmet Yılmaz']);
});

test('yalnızca ad listesi gönderildiğinde kimlikler adlardan türetilmeye devam eder', () => {
  const state = baseState();
  const next = appStateReducer(state, {
    type: 'task/update',
    id: TASK_ID,
    patch: { sorumlu: ['Ayşe Kaya'] }
  });

  assert.deepEqual(next.tasks[0].assigneeIds, ['100103']);
});

test('son sorumlu kaldırıldığında atama listesi boşalır', () => {
  const assigned = appStateReducer(baseState(), {
    type: 'task/update',
    id: TASK_ID,
    patch: { assigneeIds: ['100101'], sorumlu: ['Ahmet Yılmaz'] }
  });
  const cleared = appStateReducer(assigned, {
    type: 'task/update',
    id: TASK_ID,
    patch: { assigneeIds: [], sorumlu: [] }
  });

  assert.deepEqual(cleared.tasks[0].assigneeIds, []);
  assert.deepEqual(cleared.tasks[0].sorumlu, []);
});

test('görev çekmecesi aynı adlı ikinci çalışanı seçenek listesinden düşürmez', () => {
  const source = read('src/features/task-detail/TaskDrawer.jsx');
  assert.match(source, /const legacyNames = new Set\(selectedAssignees\.filter\(\(record\) => !record\.person\)/);
  assert.doesNotMatch(source, /!selectedNames\.has\(person\.name\)/);
});

/* ── #1 · Kaydetme hatasının görünürlüğü ─────────────────── */

test('kaydetme hatası sunucu iletisini ve çözüm eylemini gösterir', () => {
  const described = describeSaveError({
    code: 'CONFLICT',
    message: 'Kayıt kimliği zaten kullanılıyor. Verileri yeniden yükleyin.',
    operation: 'project/update',
    details: { code: 'UPSERT_CREATE_COLLISION', entityType: 'PROJECT' }
  });

  assert.equal(described.message, 'Kayıt kimliği zaten kullanılıyor. Verileri yeniden yükleyin.');
  assert.equal(described.code, 'UPSERT_CREATE_COLLISION');
  assert.equal(described.canReload, true);
});

test('doğrulama hataları yeniden yükleme önerisi olmadan alan bilgisiyle sunulur', () => {
  const described = describeSaveError({
    code: 'MUTATION_FAILED',
    message: 'Görev başlığı gereklidir.',
    details: { code: 'TASK_TITLE_REQUIRED', path: 'taskUpserts[0].task' }
  });

  assert.equal(described.canReload, false);
  assert.equal(described.path, 'taskUpserts[0].task');
});

test('kaydetme bildirimi sabit hata metni yerine gerçek iletiyi render eder', () => {
  const source = read('src/components/shell/PersistenceStatus.jsx');
  assert.match(source, /\{details\.message\}/);
  assert.match(source, /Verileri yeniden yükle/);
});

/* ── Gerçek Sistem kimlik doğrulaması ────────────────────── */

test('Gerçek Sistem kimlik hatası hangi kaydın hatalı olduğunu söyler', () => {
  assert.throws(
    () => normalizeActualChanges({ taskUpserts: [{ id: 'gecersiz', projectId: PROJECT_ID }] }),
    /Görev kimliği geçerli bir Gerçek Sistem kimliği \(UUID\) değil\. Alınan değer: "gecersiz"/
  );
  assert.throws(
    () => normalizeActualChanges({ projectUpserts: [{ id: null }] }),
    /Alınan değer: boş/
  );
});

/* ── #9 · Veri modu anahtarının konumu ───────────────────── */

test('veri modu anahtarı sağ alt köşeyi kaydetme bildirimine bırakır', () => {
  const indicator = read('src/components/shell/DataModeIndicator.jsx');
  assert.match(indicator, /variant = 'sidebar'/);
  assert.match(indicator, /data-mode-variant-\$\{variant\}/);
});

/* ── #10 · Proje yapısı sayfasında geri dönüş ────────────── */

test('proje seçildikten sonra proje listesine dönülebilir', () => {
  const source = read('src/features/project/ProjectWorkspaceView.jsx');
  assert.match(source, /const backToProjectList = \(\) => \{\s*setTab\('definition'\);\s*workspace\.selectWorkspace\(null\);/s);
  assert.match(source, /Proje listesi/);
});

test('manuel proje oluşturma yetkisi arayüzde uygulanır', () => {
  const source = read('src/features/project/ProjectWorkspaceView.jsx');
  assert.match(source, /disabled=\{!canCreateProjects\}/);
});

/* ── #6 · Uzun listelerde canlı arama ────────────────────── */

test('proje, personel, WBS ve öncül görev seçimleri canlı arama kullanır', () => {
  const drawer = read('src/features/task-detail/TaskDrawer.jsx');
  const wbsView = read('src/features/wbs/WbsView.jsx');

  // Görev çekmecesinde proje/personel/WBS/etiket/öncül görev seçimlerinin
  // hiçbiri artık ham <select> değildir; kalan <select> alanları yalnızca
  // sabit ve kısa numaralandırmalardır (ilişki türü, gecikme birimi).
  assert.doesNotMatch(drawer, /value=\{local\.wbsId \|\| ''\}\s*\n\s*onChange[\s\S]{0,40}<option/);
  assert.match(drawer, /options=\{wbsOptions\}/);
  assert.match(drawer, /options=\{predecessorOptions\}/);
  assert.match(drawer, /options=\{projectTags\.map/);
  assert.match(wbsView, /options=\{wbsOptions\}/);
  assert.match(wbsView, /import \{ SearchableSelect \}/);
});

/* ── Üretim derlemesi ────────────────────────────────────── */

test('yerel SQL sürücüsü yalnızca çalışma zamanında yüklenir', () => {
  const source = read('src/server/db/pool.js');
  // Modül düzeyindeki `mssql/msnodesqlv8.js` içe aktarımı, yerel ikili dosya
  // derlenmemiş ortamlarda `next build` sırasında rota toplamayı çökertiyordu.
  assert.doesNotMatch(source, /^import .*mssql\/msnodesqlv8\.js.*$/m);
  assert.match(source, /import\('mssql\/msnodesqlv8\.js'\)/);
  assert.match(source, /import sql from 'mssql';/);
  assert.match(source, /DATABASE_UNAVAILABLE/);
});

test('paket kilidi yerel SQL sürücüsünü içerir', () => {
  const lock = JSON.parse(read('package-lock.json'));
  const manifest = JSON.parse(read('package.json'));

  // Kilit dosyasında sürücü yoksa `npm ci` doğrudan başarısız olur.
  assert.equal(lock.packages[''].dependencies.msnodesqlv8, manifest.dependencies.msnodesqlv8);
  assert.ok(lock.packages['node_modules/msnodesqlv8'], 'msnodesqlv8 kilit dosyasında çözülmelidir');
});
