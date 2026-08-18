/**
 * Ekip personel penceresi, Özet tutarlılığı ve düzeltilen P0–P2 hataları.
 *
 * Kapsanan konular:
 *   1. Personel ayrıntı penceresi: aciliyet tonlaması ve açılış davranışı
 *   2. Özet rozetleri ile halka grafiğinin AYNI kovalardan beslenmesi
 *   3. Kanban: aynı sütuna bırakmak yazma isteği üretmez, zamanlayıcı sızmaz
 *   4. Bağımlılık riski kartı yalnızca BEKLEYEN öncülleri sayar
 *   5. Tarihe duyarlı hesaplar gece yarısında eskimez
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { dueTone } from '../src/features/team/upcomingTaskPolicy.js';
import { selectStatusDistribution } from '../src/features/dashboard/statusDistribution.js';

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const TODAY = new Date(2026, 7, 18);

/* ── 1. Personel penceresi ──────────────────────────────────────── */

test('yakın görev aciliyeti hedef tarihe kalan güne göre tonlanır', () => {
  assert.equal(dueTone({ targetFinish: '2026-08-15' }, TODAY).text, '3 gün gecikti');
  assert.equal(dueTone({ targetFinish: '2026-08-18' }, TODAY).text, 'Bugün');
  assert.equal(dueTone({ targetFinish: '2026-08-19' }, TODAY).text, 'Yarın');
  assert.equal(dueTone({ targetFinish: '2026-08-23' }, TODAY).text, '5 gün');
  assert.equal(dueTone({ targetFinish: '2026-09-30' }, TODAY).text, '43 gün');
});

test('hedef tarihi olmayan görev planlanan bitişe düşer, o da yoksa tarihsiz sayılır', () => {
  assert.equal(dueTone({ plannedFinish: '2026-08-20' }, TODAY).due, '2026-08-20');
  const undated = dueTone({}, TODAY);
  assert.equal(undated.due, null);
  assert.equal(undated.days, null);
  assert.equal(undated.text, 'Tarih yok');
});

test('geciken ve bugün biten görevler gecikme rengini alır, uzak görevler nötr kalır', () => {
  assert.equal(dueTone({ targetFinish: '2026-08-10' }, TODAY).tone.color, 'var(--status-overdue)');
  assert.equal(dueTone({ targetFinish: '2026-08-18' }, TODAY).tone.color, 'var(--status-overdue)');
  assert.equal(dueTone({ targetFinish: '2026-08-22' }, TODAY).tone.color, 'var(--c-amber)');
  assert.equal(dueTone({ targetFinish: '2026-10-01' }, TODAY).tone.color, 'var(--text-muted)');
});

test('personel penceresi kimlikle açılır: süzgeç değişince eski satır ekranda kalmaz', () => {
  const view = read('src/features/team/TeamView.jsx');
  assert.match(view, /const \[openPersonId, setOpenPersonId\] = useState\(null\)/);
  assert.match(view, /stats\.find\(\(row\) => row\.person\.id === openPersonId\) \|\| null/);
  assert.match(view, /onClick=\{\(\) => setOpenPersonId\(member\.person\.id\)\}/);
});

test('personel penceresi yalnızca AÇIK görevleri listeler ve Esc ile kapanır', () => {
  const dialog = read('src/features/team/PersonDetailDialog.jsx');
  assert.match(dialog, /\(member\?\.tasks \|\| \[\]\)\.filter\(\(task\) => task\.status !== 'done'\)/);
  assert.match(dialog, /if \(event\.key === 'Escape'\) onClose\(\)/);
  assert.match(dialog, /window\.removeEventListener\('keydown', onKey\)/);
  assert.match(dialog, /aria-modal="true"/);
});

test('personel penceresi görünüm alanına sığar ve içeriği kendi içinde kayar', () => {
  const css = read('src/app/styles/features.css');
  assert.match(css, /\.person-dialog\s*\{[^}]*max-height:\s*calc\(var\(--app-viewport-h, 100vh\) - 48px\);/s);
  assert.match(css, /\.person-dialog-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
});

/* ── 2. Özet tutarlılığı ────────────────────────────────────────── */

function board() {
  return [
    { id: '1', status: 'done', targetFinish: '2026-08-01' },
    { id: '2', status: 'in_progress', targetFinish: '2026-09-01' },
    { id: '3', status: 'in_progress', targetFinish: '2026-08-01' },
    { id: '4', status: 'todo', targetFinish: '2026-09-01' },
    { id: '5', status: 'todo', targetFinish: '2026-08-01' }
  ];
}

test('rozetler ve halka aynı kovalardan beslenir: hiçbir görev iki kez sayılmaz', () => {
  // Kart "6 devam eden" derken halka aynı anda "3" gösteriyordu: kartlar durum
  // alanını doğrudan okuyor, halka ise ayrıştırılmış kovaları kullanıyordu.
  const distribution = selectStatusDistribution(board(), TODAY);
  const byId = new Map(distribution.segments.map((segment) => [segment.id, segment.value]));
  assert.equal(byId.get('done'), 1);
  assert.equal(byId.get('in_progress'), 1, 'hedefi geçmiş devam eden görev "Geciken" kovasındadır');
  assert.equal(byId.get('todo'), 1);
  assert.equal(byId.get('overdue'), 2);
  assert.equal(distribution.segments.reduce((sum, segment) => sum + segment.value, 0), distribution.total);
});

test('Özet rozetleri kova listelerinden türetilir', () => {
  const dashboard = read('src/features/dashboard/DashboardView.jsx');
  assert.match(dashboard, /const bucketItems = useMemo1\(/);
  assert.match(dashboard, /const progressTasks = bucketItems\.get\('in_progress'\) \|\| \[\]/);
  assert.match(dashboard, /const overdueTasks = bucketItems\.get\('overdue'\) \|\| \[\]/);
  // Durum alanını doğrudan okuyan eski süzgeçler geri dönmemeli.
  assert.doesNotMatch(dashboard, /tasks\.filter\(t => t\.status === 'in_progress'\)/);
});

/* ── 3. Kanban ──────────────────────────────────────────────────── */

test('aynı sütuna bırakmak yazma isteği üretmez', () => {
  // Aynı sütuna bırakmak bir değişiklik değildir; yama gönderilirse sunucuya
  // boşuna istek gider ve kayıt sürümü sebepsiz ilerler.
  const kanban = read('src/features/kanban/KanbanView.jsx');
  assert.match(kanban, /const unchanged = current && \(current\.status \|\| 'todo'\) === colId;/);
  assert.match(kanban, /if \(unchanged\) return;/);
});

test('Kanban vurgu zamanlayıcısı sökülmede temizlenir', () => {
  const kanban = read('src/features/kanban/KanbanView.jsx');
  assert.match(kanban, /useEffect2\(\(\) => \(\) => clearTimeout\(flashTimer\.current\), \[\]\)/);
  assert.match(kanban, /clearTimeout\(flashTimer\.current\);\s*\n\s*flashTimer\.current = setTimeout/);
});

/* ── 4. Bağımlılık riski ────────────────────────────────────────── */

test('risk kartı yalnızca BEKLEYEN öncülleri sayar', () => {
  // Kart daha önce `deps.length` yazıyordu: tamamlanmış öncülleri de sayan bir
  // rakamdı, "3 bekleyen bağımlılık" derken yalnızca biri bekliyor olabiliyordu.
  const dashboard = read('src/features/dashboard/DashboardView.jsx');
  assert.match(dashboard, /const blocking = \(task\.deps \|\| \[\]\)\.filter/);
  assert.match(dashboard, /\{blockingCount\} bekleyen bağımlılık/);
  assert.doesNotMatch(dashboard, /\{t\.deps\.length\} bekleyen bağımlılık/);
});

/* ── 5. Tarihe duyarlı hesaplar ─────────────────────────────────── */

test('tarihe duyarlı memolar referans günü bağımlılık olarak taşır', () => {
  // Bağımlılıktan çıkarıldığında pano gece yarısını açık geçtiğinde dünün
  // sınıflandırmasında kalıyordu.
  for (const file of ['src/features/dashboard/DashboardView.jsx', 'src/features/reports/ReportsView.jsx']) {
    const source = read(file);
    assert.match(source, /const todayKey = fmtISO\(today\(\)\)/, `${file} kararlı referans gün kullanmalı`);
    assert.match(source, /parseDate\(todayKey\), \[todayKey\]\)/, `${file} referans günü memolamalı`);
  }
});

test('tamamlanma eğrisi görevleri GERÇEKLEŞEN bitişte sayar', () => {
  // Planlanan bitişe bakmak, planı ileri bir tarihte olan ama bugün bitirilen
  // görevi eğriye hiç sokmuyordu.
  for (const file of ['src/features/dashboard/DashboardView.jsx', 'src/features/reports/ReportsView.jsx']) {
    assert.match(read(file), /t\.actualFinish \|\| t\.plannedFinish/, `${file} gerçekleşen bitişi önceliklendirmeli`);
  }
});

/* ── 6. İş dağılım ağacı sürükleme durumu ───────────────────────── */

test('sürükleme tutamağı işaretçi bırakıldığında her koşulda serbest bırakılır', () => {
  // Tutamağa basıp başka bir yerde bırakmak `dragHandleNodeId` değerini asılı
  // bırakıyor, satır sürükleme başlatmadan `draggable` kalıyordu.
  const view = read('src/features/wbs/WbsView.jsx');
  assert.match(view, /window\.addEventListener\('pointerup', releaseHandle\)/);
  assert.match(view, /window\.addEventListener\('pointercancel', releaseHandle\)/);
  assert.match(view, /window\.removeEventListener\('pointerup', releaseHandle\)/);
});
