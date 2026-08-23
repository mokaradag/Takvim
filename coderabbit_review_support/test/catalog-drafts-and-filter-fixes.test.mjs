// MERGEN Rota · Etiket kataloğu, kaydedilmemiş taslaklar ve süzgeç davranışları.
//
// Bu dosya inceleme sırasında bulunan davranış hatalarını kilitler: kontrollü
// etiket kataloğunun bütünlüğü, reddedilen kayıtların kaybolmaması, sürükle-bırak
// ilkeleri ve süzgeç/gösterim yüzeylerindeki düzeltmeler.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  applyProjectTagPropagation,
  comparableTagName,
  mergeProjectTagAppearance,
  planProjectTagPropagation,
  projectTagCatalog
} from '../src/domain/tags/index.js';
import { createTaskPatchCoalescer } from '../src/state/persistence.js';
import { createWbsDropIndex, resolveWbsDrop } from '../src/features/wbs/wbsDragPolicy.js';
import { matchesOptionQuery } from '../src/components/columnFilterSearch.js';
import { buildExportRows, EXPORT_HEADERS } from '../src/lib/exportProjectData.js';

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

/* ── 1 · Etiket kataloğu bütünlüğü ───────────────────────────── */

test('katalog değişikliği canlı görev anahtar sözcüklerine kurallı yansır', () => {
  const plan = planProjectTagPropagation({
    storedTags: ['Analiz', 'Eski', 'Test'],
    nextTags: [{ name: 'Çözümleme' }, { name: 'Test' }],
    renames: [{ from: 'Analiz', to: 'Çözümleme' }]
  });

  const tasks = [
    { id: 't1', projectId: 'p1', keyword: 'analiz' },   // harf varyantı da taşınır
    { id: 't2', projectId: 'p1', keyword: 'Eski' },     // katalogdan çıkarıldı
    { id: 't3', projectId: 'p1', keyword: 'test' },     // kanonik yazıma çekilir
    { id: 't4', projectId: 'p1', keyword: 'Hiç' },      // hiç katalogda olmamış: korunur
    { id: 't5', projectId: 'p2', keyword: 'Analiz' }    // başka proje: dokunulmaz
  ];

  assert.deepEqual(
    applyProjectTagPropagation(tasks, 'p1', plan).map((task) => [task.id, task.keyword]),
    [['t1', 'Çözümleme'], ['t2', null], ['t3', 'Test'], ['t4', 'Hiç'], ['t5', 'Analiz']]
  );
});

test('yeniden adlandırma kimliği ada değil, girdinin kendisine bağlıdır', () => {
  const view = read('src/features/project/ProjectWorkspaceView.jsx');
  // `A → B` yapıp yeni bir `A` ekleyip onu `C` yapmak, ada dayalı günlükte iki
  // kaydı da `from: A` ile yazıyor ve görevleri yanlış etikete taşıyordu.
  assert.match(view, /function catalogRenames\(entries\)/);
  assert.match(view, /entry\.origin && comparableTagName\(entry\.origin\) !== comparableTagName\(entry\.name\)/);
  // Ayrı bir günlük tutulmaz: formu geri almak eşlemeleri de temizler.
  assert.doesNotMatch(view, /setTagRenames/);
  // Kullanım sayısı girdinin YÜKLENDİĞİ addan sayılır; yeniden adlandırma
  // kullanımı sıfıra düşürüp silmeyi serbest bırakmamalıdır.
  assert.match(view, /const usageFor = \(entry\) => usage\.get\(comparableTagName\(entry\.origin \|\| entry\.name\)\) \|\| 0;/);
});

test('boş katalog yetkilidir; yalnızca alan hiç yoksa anahtar sözcüklerden türetilir', () => {
  assert.deepEqual(projectTagCatalog({ tagCatalog: [] }), []);
  assert.deepEqual(projectTagCatalog({ tags: [] }), []);
  assert.deepEqual(projectTagCatalog({ tagCatalog: [{ name: 'Analiz' }] }).map((tag) => tag.name), ['Analiz']);
  // Eski sözleşme (düz metin) hâlâ okunur.
  assert.deepEqual(projectTagCatalog({ tags: ['Analiz'] }).map((tag) => tag.name), ['Analiz']);

  const view = read('src/features/project/ProjectWorkspaceView.jsx');
  assert.match(view, /Array\.isArray\(project\?\.tagCatalog\) \|\| Array\.isArray\(project\?\.tags\)/);
  const drawer = read('src/features/task-detail/TaskDrawer.jsx');
  assert.match(drawer, /const hasCatalog = Array\.isArray\(project\.tagCatalog\) \|\| Array\.isArray\(project\.tags\);/);
});

test('anlık görüntü etiketleri hem eski hem yeni istemciye uygun döner', () => {
  const repository = read('src/server/repository/sqlAppRepository.js');
  // Sürüm geçişinde açık kalan eski paket etiketi metin sanar ve nesne
  // aldığında proje ekranı çökerdi.
  assert.match(repository, /tags: projectTagNames\(tags\.get\(id\(row\.ProjectId\)\) \|\| \[\]\),/);
  assert.match(repository, /tagCatalog: tags\.get\(id\(row\.ProjectId\)\) \|\| \[\],/);
});

test('düz metin etiket yazması saklanan renk ve simgeyi silmez', () => {
  const merged = mergeProjectTagAppearance(['Analiz', 'Test'], [
    { name: 'analiz', color: 'rose', icon: 'Target' }
  ]);
  assert.equal(merged.find((tag) => tag.name === 'Analiz').color, 'rose');
  assert.equal(merged.find((tag) => tag.name === 'Analiz').icon, 'Target');
  // Açıkça gönderilen görünüm saklanana göre önceliklidir.
  const explicit = mergeProjectTagAppearance([{ name: 'Analiz', color: 'cyan' }], [
    { name: 'Analiz', color: 'rose', icon: 'Target' }
  ]);
  assert.equal(explicit[0].color, 'cyan');
  assert.equal(explicit[0].icon, 'Target');
});

test('hızlı giriş kataloğun kanonik adını kullanır ve öksüz etiket bırakmaz', () => {
  const panel = read('src/features/simple/SimpleModePanel.jsx');
  assert.match(panel, /if \(existing\) return \{ ok: true, project, keyword: existing\.name \};/);
  // Kataloğa ekleme başarısızsa görev etiketsiz oluşturulur; aksi hâlde
  // katalogda karşılığı olmayan kalıcı bir anahtar sözcük doğardı.
  assert.match(panel, /taskKeyword = '';/);
  assert.match(panel, /keyword: taskKeyword,/);
});

test('etiketin rengi ve simgesi görev rozetlerinde de kullanılır', () => {
  const badge = read('src/components/TaskKeyword.jsx');
  assert.match(badge, /findProjectTag\(projectTagCatalog\(project\), task\.keyword\)/);
  for (const view of [
    'src/features/tasks/TasksView.jsx',
    'src/features/kanban/KanbanView.jsx',
    'src/features/calendar/CalendarView.jsx',
    'src/features/dashboard/DashboardView.jsx',
    'src/features/task-detail/TaskDrawer.jsx',
    'src/features/task-detail/ReadOnlyTaskDrawer.jsx'
  ]) {
    const source = read(view);
    assert.match(source, /<TaskKeyword task=/, view);
    assert.doesNotMatch(source, /<Kw color=\{[^}]*\}>\{[^}]*keyword\}<\/Kw>/, view);
  }
});

/* ── 2 · Kaydedilmemiş taslaklar ─────────────────────────────── */

test('reddedilen yama saklanır, yeni düzenlemeyle birleşir ve yeniden denenebilir', async () => {
  const sent = [];
  let failNext = true;
  const coalescer = createTaskPatchCoalescer(async (taskId, patch) => {
    sent.push({ taskId, patch });
    if (failNext) {
      failNext = false;
      return { ok: false, error: { message: 'reddedildi' } };
    }
    return { ok: true, value: null };
  }, { delayMs: 1 });

  const first = coalescer.schedule('t1', { progress: 50 });
  assert.equal((await first).ok, false);
  // Panel kapansa ve taslak sökülse bile düzenleme kaybolmaz.
  assert.equal(coalescer.hasPending(), false);
  assert.equal(coalescer.hasUnsavedChanges(), true);

  // Kullanıcı yazmaya devam ederse reddedilen alanlar da birlikte gönderilir.
  const second = coalescer.schedule('t1', { task: 'Yeni başlık' });
  assert.equal((await second).ok, true);
  assert.deepEqual(sent.at(-1).patch, { progress: 50, task: 'Yeni başlık' });
  assert.equal(coalescer.hasUnsavedChanges(), false);
});

test('saklanan yama açık yeniden deneme ya da vazgeçmeyle temizlenir', async () => {
  let failNext = true;
  const coalescer = createTaskPatchCoalescer(async () => {
    if (failNext) {
      failNext = false;
      return { ok: false, error: { message: 'reddedildi' } };
    }
    return { ok: true, value: null };
  }, { delayMs: 1 });

  await coalescer.schedule('t1', { progress: 10 });
  assert.equal(coalescer.hasUnsavedChanges(), true);
  const retried = await coalescer.retryFailed();
  assert.ok(retried.every((result) => result.ok));
  assert.equal(coalescer.hasUnsavedChanges(), false);

  failNext = true;
  await coalescer.schedule('t2', { progress: 20 });
  assert.equal(coalescer.hasUnsavedChanges(), true);
  coalescer.discardFailed();
  assert.equal(coalescer.hasUnsavedChanges(), false);
});

test('geçersiz kılınan alan bekleyen yamadan da düşürülür', async () => {
  const sent = [];
  const coalescer = createTaskPatchCoalescer(async (taskId, patch) => {
    sent.push(patch);
    return { ok: true, value: null };
  }, { delayMs: 30 });

  coalescer.schedule('t1', { task: 'A', progress: 40 });
  // Başlık boşaldı: kuyruktaki `A` ön eki kalıcılaşmamalıdır.
  coalescer.cancelFields('t1', ['task']);
  await coalescer.flush('t1');
  assert.deepEqual(sent, [{ progress: 40 }]);

  // Yamada başka alan kalmadıysa kuyruk kaydı tümüyle düşer.
  coalescer.schedule('t2', { task: 'B' });
  coalescer.cancelFields('t2', ['task']);
  assert.equal(coalescer.hasUnsavedChanges(), false);
});

test('boşaltma seçenekleri depoya iletilir (sekme kapanırken keepalive)', async () => {
  const seen = [];
  const coalescer = createTaskPatchCoalescer(async (taskId, patch, options) => {
    seen.push(options);
    return { ok: true, value: null };
  }, { delayMs: 30 });

  coalescer.schedule('t1', { progress: 10 });
  await coalescer.flush('t1', { keepalive: true });
  assert.deepEqual(seen, [{ keepalive: true }]);
});

/* ── 3 · Sürükle-bırak ilkeleri ──────────────────────────────── */

const TREE = [
  { id: 'root', projectId: 'p1', parentId: null, code: '1', name: 'Kök', sortOrder: 0 },
  { id: 'a', projectId: 'p1', parentId: 'root', code: '1.1', name: 'A', sortOrder: 1 },
  { id: 'b', projectId: 'p1', parentId: 'root', code: '1.2', name: 'B', sortOrder: 2 },
  { id: 'c', projectId: 'p1', parentId: 'root', code: '1.3', name: 'C', sortOrder: 3 }
];

test('mevcut üstün ortasına bırakmak sıra değiştirmez', () => {
  // `inside` yalnızca ÜST değişikliğidir; sıra before/after ile denetlenir.
  // Eski davranış düğümü sessizce listenin sonuna atıyordu.
  const resolution = resolveWbsDrop(TREE, { dragId: 'a', targetId: 'root', position: 'inside' });
  assert.equal(resolution.ok, false);
  assert.equal(resolution.code, 'WBS_DROP_NO_CHANGE');
});

test('sürükleme oturumu tek bir arama dizinini paylaşır', () => {
  const index = createWbsDropIndex(TREE);
  const first = resolveWbsDrop(TREE, { dragId: 'c', targetId: 'a', position: 'before' }, { index });
  const second = resolveWbsDrop(TREE, { dragId: 'c', targetId: 'a', position: 'after' }, { index });
  assert.deepEqual(first.move, { id: 'c', parentId: 'root', index: 0 });
  assert.deepEqual(second.move, { id: 'c', parentId: 'root', index: 1 });
  // Alt ağaç kimlikleri düğüm başına bir kez hesaplanıp saklanır.
  assert.ok(index.descendants.has('c'));
});

test('sürükleme yalnızca tutamaktan başlar ve bekleyen taşıma sırasında kapalıdır', () => {
  const view = read('src/features/wbs/WbsView.jsx');
  assert.match(view, /draggable=\{draggable && dragHandleNodeId === node\.id\}/);
  assert.match(view, /onPointerDown=\{\(\) => draggable && setDragHandleNodeId\(node\.id\)\}/);
  // Kötümser kalıcılaştırma sırasında yeni sürükleme, eski ağaçtan hesaplanmış
  // mutlak bir sıra numarası kuyruğa alırdı. Kilit artık TEK bir yapısal yazma
  // kilididir: ekleme/ad değiştirme/silme/taşıma da aynı kapıdan geçer.
  assert.match(view, /runStructuralWrite\(\(\) => moveWbsNode\(/);
  assert.match(view, /runStructuralWrite\(\(\) => deleteWbs\(/);
  assert.match(view, /runStructuralWrite\(\(\) => reparentWbs\(/);
  assert.match(view, /runStructuralWrite\(\(\) => \(current\.mode === 'add'/);
  assert.match(view, /if \(structuralWritePending\) return Promise\.resolve\(\{ ok: false/);
});

test('satırdan gerçekten çıkıldığında bekleyen açma zamanlayıcısı iptal edilir', () => {
  const view = read('src/features/wbs/WbsView.jsx');
  assert.match(view, /if \(event\.currentTarget\.contains\(event\.relatedTarget\)\) return;/);
  assert.match(view, /if \(hoverExpandRef\.current\.nodeId === node\.id\) cancelHoverExpand\(\);/);
});

test('başarılı `inside` bırakmasında hedef açılır ve düğüm görünür kalır', () => {
  const view = read('src/features/wbs/WbsView.jsx');
  assert.match(view, /if \(position === 'inside'\) setExpanded\(\(current\) => new Set\(current\)\.add\(node\.id\)\);/);
});

test('kardeş sırası klavye ile de değiştirilebilir', () => {
  const view = read('src/features/wbs/WbsView.jsx');
  assert.match(view, /const moveSibling = \(node, offset\) => \{/);
  assert.match(view, /aria-label="Bir sıra yukarı taşı"/);
  assert.match(view, /aria-label="Bir sıra aşağı taşı"/);
});

test('satır içi ad taslağı yalnızca kayıt başarılıysa kapanır', () => {
  const view = read('src/features/wbs/WbsView.jsx');
  assert.match(view, /if \(result && result\.ok === false\) \{\s*\n\s*setEditing\(\{ \.\.\.current, busy: false \}\);/);
});

/* ── 4 · Süzgeçler ve gösterim yüzeyleri ─────────────────────── */

test('seçenek araması hem Türkçe hem değişmez katlamayla eşleşir', () => {
  // Kurumsal ad: Türkçe katlama gerekir.
  assert.equal(matchesOptionQuery({ label: 'İzmir Projesi' }, 'izmir'), true);
  // ASCII tanımlayıcı: `MIR` Türkçe katlamada `mır` olur ve `mir` eşleşmezdi.
  assert.equal(matchesOptionQuery({ label: 'Proje', keywords: ['MIR'] }, 'mir'), true);
  assert.equal(matchesOptionQuery({ label: 'Proje', keywords: ['MIR'] }, 'xyz'), false);
  assert.equal(matchesOptionQuery({ label: 'Proje' }, '   '), true);
});

test('süzgeç değerleri kararlı kimliktir', () => {
  const tasksView = read('src/features/tasks/TasksView.jsx');
  // Aynı ada sahip iki proje ya da iki çalışan tek seçenekte birleşmemelidir.
  assert.match(tasksView, /value: p\.id,/);
  assert.match(tasksView, /colFilter\.proje\.includes\(t\.projectId\)/);
  assert.match(tasksView, /\(t\.assigneeIds \|\| \[\]\)\.some\(id => colFilter\.sorumlu\.includes\(String\(id\)\)\)/);

  const gantt = read('src/features/gantt/GanttView.jsx');
  assert.match(gantt, /\(t\.assigneeIds \|\| \[\]\)\.some\(id => colFilters\.sorumlu\.includes\(String\(id\)\)\)/);
});

test('tek seçimli süzgeçte Enter aranan seçeneği uygular', () => {
  const extras = read('src/components/ui-extras.jsx');
  // Genel `apply()` çağrısı ARANAN değil, önceden seçili radyo değerini
  // uyguluyordu: kullanıcı arayıp Enter'a bastığında süzgeç eskisi gibi kalıyordu.
  assert.match(extras, /if \(type !== 'single'\) \{ apply\(\); return; \}/);
  assert.match(extras, /if \(searchableOptions\.length !== 1\) return;/);
});

test('kişi ölçüm tablosu satırları ızgara öğesi olarak kalır ve uzun adlar sarar', () => {
  const table = read('src/components/PeopleMetricTable.jsx');
  assert.match(table, /asChild/);
  const css = read('src/app/styles/dashboard.css');
  assert.match(css, /\.pm-name \{[^}]*overflow-wrap: anywhere;/s);
  assert.doesNotMatch(css, /\.pm-name \{[^}]*text-overflow: ellipsis;/s);
});

test('haftalık tamamlama gerçekleşen bitişten sayılır ve gün değişimini izler', () => {
  const dashboard = read('src/features/dashboard/DashboardView.jsx');
  assert.match(dashboard, /if \(t\.status !== 'done' \|\| !t\.actualFinish\) return false;/);
  // Referans gün kararlıdır: memo her çizimde yeniden hesaplanmaz. Gün sınırı
  // ayrıca İZLENİR; hiçbir görev değişmese bile gece yarısında yeniden çizim
  // planlanır (bkz. hooks/useTodayKey.js).
  assert.match(dashboard, /const todayKey = useTodayKey\(\);/);
  assert.match(dashboard, /selectStatusDistribution\(tasks, today_\), \[tasks, today_\]/);
});

test('haftalık yük yalnızca altı haftalık ufka düşen işi sayar', () => {
  const reports = read('src/features/reports/ReportsView.jsx');
  assert.match(reports, /const horizonShare = \(task, horizonStart, horizonEnd\) => \{/);
  assert.match(reports, /\* share;/);
  assert.match(reports, /weekly: Math\.round\(v\.hours \/ REPORT_HORIZON_WEEKS\)/);
});

test('karşılama ekranı portföyü özetler, saati tarayıcıdan okur ve ağacı açar', () => {
  const welcome = read('src/components/shell/WelcomeScreen.jsx');
  // Sunucu ön-render'ı farklı saat diliminde çalışır: selamlama bağlanana kadar
  // dilimden bağımsızdır.
  assert.match(welcome, /const \[browserNow, setBrowserNow\] = useState\(now\);/);
  assert.match(welcome, /browserNow \? greetingForHour\(browserNow\.getHours\(\)\) : 'Hoş geldiniz'/);
  assert.match(welcome, /intent: 'tree'/);
  assert.match(welcome, /onNavigate\(f\.view, f\.intent \|\| null\)/);

  const shell = read('src/components/shell/AppShell.jsx');
  assert.match(shell, /stats=\{portfolioStats\}/);
  assert.match(shell, /initialTab=\{viewIntent\}/);
  const workspace = read('src/features/project/ProjectWorkspaceView.jsx');
  assert.match(workspace, /useState\(initialTab === 'tree' \? 'tree' : 'definition'\)/);
});

test('dışa aktarım tekrar kuralını ve seri ilişkisini taşır', () => {
  const rows = buildExportRows({
    tasks: [
      { id: 't1', task: 'Haftalık bakım', recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3' },
      { id: 't2', task: 'Haftalık bakım', recurrenceParentId: 't1', recurrenceOccurrenceDate: '2026-08-24' }
    ]
  });
  assert.equal(rows[0].tekrarKurali, 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3');
  assert.equal(rows[1].tekrarKurali, '');
  assert.equal(rows[1].seri, 'Haftalık bakım');
  assert.equal(rows[1].seriGunu, '24/08/2026');
  assert.ok(EXPORT_HEADERS.includes('Tekrar Kuralı'));
  assert.ok(EXPORT_HEADERS.includes('Seri Günü'));
});

test('tekrar önizlemesi üretimle aynı planlayıcıyı kullanır', () => {
  const drawer = read('src/features/task-detail/TaskDrawer.jsx');
  // Ham açılım hafta sonunu gösterirken üretim iş gününe kaydırıp
  // tekilleştiriyordu: onay ekranı oluşacak görevlerle çelişiyordu. Özet de
  // aynı planlayıcıyı çağırır (bkz. summarizeRecurrencePlan).
  assert.match(drawer, /summarizeRecurrencePlan\(task, rule, \{ calendar, previewLimit: 8 \}\)/);
  assert.doesNotMatch(drawer, /expandRecurrence\(/);
  // Başlangıç günü artık ZORLA seçili tutulmaz: kullanıcı haftanın başka
  // günlerini tanımlamak istediğinde bulunduğu günü listeden çıkarabilmelidir.
  assert.doesNotMatch(drawer, /days\.includes\(startWeekday\) \? days :/);
  assert.doesNotMatch(drawer, /disabled=\{locked\}/);
  // Üretilmiş yinelemeler dururken kural kaldırılamaz.
  assert.match(drawer, /if \(occurrenceCount > 0\) \{/);
});

test('kanonik etiket kimliği harf duyarsızdır', () => {
  assert.equal(comparableTagName(' ANALİZ '), comparableTagName('analiz'));
  assert.notEqual(comparableTagName('Analiz'), comparableTagName('Analız'));
});
