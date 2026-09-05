/**
 * Proje Yapısı, Ekip ve uygulama kabuğu arayüz düzeltmeleri.
 *
 * Saf davranış (hiyerarşi derinliği, direktörlük süzgeci, toplulaştırma) gerçek
 * modüller çağrılarak; yalnızca CSS/JSX ile ifade edilebilen sözleşmeler (donuk
 * başlıklar, düzen sınıfları) kaynak metni üzerinden sınanır.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildWbsTree, flattenWbsTree, selectWbsRollupIndex, selectWbsTaskRollup } from '../src/domain/selectors/index.js';
import { DEFAULT_WBS_DEPTH, WBS_DEPTH_OPTIONS, expandedIdsForDepth } from '../src/features/wbs/wbsTreeViewPolicy.js';
import {
  UNASSIGNED_DIRECTORATE,
  UNASSIGNED_DIRECTORATE_LABEL,
  matchesDirectorateFilter
} from '../src/features/team/teamDirectoryPolicy.js';

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function sampleWbs() {
  return [
    { id: 'root', projectId: 'p1', parentId: null, code: '1', name: 'Proje', sortOrder: 0 },
    { id: 'a', projectId: 'p1', parentId: 'root', code: '1.1', name: 'Paket A', sortOrder: 1 },
    { id: 'a1', projectId: 'p1', parentId: 'a', code: '1.1.1', name: 'Aktivite A1', sortOrder: 1 },
    { id: 'a1x', projectId: 'p1', parentId: 'a1', code: '1.1.1.1', name: 'Alt A1', sortOrder: 1 },
    { id: 'b', projectId: 'p1', parentId: 'root', code: '1.2', name: 'Paket B', sortOrder: 2 }
  ];
}

/* ── Proje Yapısı · hiyerarşi denetimleri ────────────────────────── */

test('dağılım ağacı açılışta tüm ağacı değil, ilk iki seviyeyi gösterir', () => {
  const rows = flattenWbsTree(buildWbsTree(sampleWbs()));
  const expanded = expandedIdsForDepth(rows, DEFAULT_WBS_DEPTH);

  // Yalnızca kök açık: kökün çocukları görünür, torunlar görünmez.
  assert.deepEqual([...expanded], ['root']);
  assert.equal(expanded.has('a'), false, 'ikinci seviye düğüm açık olmamalıdır');
});

test('hiyerarşi seçimi istenen derinliğe kadar açar', () => {
  const rows = flattenWbsTree(buildWbsTree(sampleWbs()));

  assert.deepEqual([...expandedIdsForDepth(rows, 1)], [], 'seviye 1 hiçbir düğümü açmaz');
  assert.deepEqual([...expandedIdsForDepth(rows, 3)].sort(), ['a', 'root']);
  assert.deepEqual([...expandedIdsForDepth(rows, 4)].sort(), ['a', 'a1', 'root']);
  // Yaprak düğümler (çocuğu olmayan 'b', 'a1x') kümede yer tutmaz.
  assert.equal(expandedIdsForDepth(rows, 9).has('b'), false);
  assert.equal(expandedIdsForDepth(rows, 9).has('a1x'), false);
});

test('hiyerarşi seçici tüm seviyeleri de sunar', () => {
  const values = WBS_DEPTH_OPTIONS.map((option) => option.value);
  assert.equal(values.includes(1), true);
  assert.equal(values.includes(DEFAULT_WBS_DEPTH), true);
  assert.equal(values.includes(Number.POSITIVE_INFINITY), true, '"Tüm seviyeler" seçeneği bulunmalıdır');
});

test('Proje Yapısı sayfası tümünü aç, tümünü kapat ve hiyerarşi denetimlerini sunar', () => {
  const source = read('src/features/wbs/WbsView.jsx');
  for (const label of ['Tümünü aç', 'Tümünü kapat', 'Hiyerarşi']) {
    assert.ok(source.includes(label), label);
  }
  assert.match(source, /const collapseAll = \(\) => \{/);
  assert.match(source, /const expandAll = \(\) => \{/);
  assert.match(source, /className="wbs-tree-btn/);
});

test('dağılım ağacı tablosu kendi kaydırma kabuğunu kullanır ve başlığı donuk kalır', () => {
  const source = read('src/features/wbs/WbsView.jsx');
  assert.match(source, /className="wbs-tree-scroll"/);
  assert.match(source, /className="wbs-tree-grid wbs-tree-head"/);

  const css = read('src/app/styles/features.css');
  assert.match(css, /\.wbs-page \{[^}]*height: 100%/s);
  assert.match(css, /\.wbs-tree-scroll \{[^}]*overflow: auto/s);
  assert.match(css, /\.wbs-tree-head \{\s*position: sticky;\s*top: 0;/);
  // Üst kartlar ince bir başlık çubuğuna indirgenir; tablo kalan alanı alır.
  assert.match(css, /\.wbs-tree-table \{[^}]*flex: 1 1 0/s);
  assert.match(css, /\.wbs-toolbar \{/);
});

test('görev taşıma paneli varsayılan olarak kapalıdır ve dikey alanı boşaltır', () => {
  const source = read('src/features/wbs/WbsView.jsx');
  assert.match(source, /const \[moveOpen, setMoveOpen\] = useState\(false\);/);
  assert.match(source, /canMoveTasks && wbs\.length > 0 && moveOpen &&/);
});

/* ── Proje Yapısı · toplulaştırma başarımı ───────────────────────── */

test('toplulaştırma indeksi düğüm başına yeniden tarama yapmadan aynı sonucu verir', () => {
  const wbs = sampleWbs();
  const tasks = [
    { id: 't1', projectId: 'p1', wbsId: 'a1', status: 'done', progress: 100, plannedDurationDays: 2, plannedStart: '2026-01-05', plannedFinish: '2026-01-06' },
    { id: 't2', projectId: 'p1', wbsId: 'a1x', status: 'in_progress', progress: 50, plannedDurationDays: 2, plannedStart: '2026-01-07', plannedFinish: '2026-01-09' },
    { id: 't3', projectId: 'p1', wbsId: 'b', status: 'todo', progress: 0, plannedDurationDays: 1, plannedStart: '2026-01-02', plannedFinish: '2026-01-03' }
  ];
  const schedules = { t2: { isCritical: true } };
  const index = selectWbsRollupIndex(wbs, tasks, schedules);

  for (const node of wbs) {
    const expected = selectWbsTaskRollup(wbs, tasks, node.id, schedules);
    const actual = index.get(node.id);
    assert.ok(actual, `${node.id} için toplulaştırma bulunmalıdır`);
    for (const key of ['taskCount', 'directTaskCount', 'completedTaskCount', 'criticalTaskCount', 'progress', 'plannedStart', 'plannedFinish']) {
      assert.deepEqual(actual[key], expected[key], `${node.id}.${key}`);
    }
  }

  assert.equal(index.get('root').taskCount, 3);
  assert.equal(index.get('a').taskCount, 2);
  assert.equal(index.get('a').criticalTaskCount, 1);
  assert.equal(index.get('root').plannedStart, '2026-01-02');
  assert.equal(index.get('root').plannedFinish, '2026-01-09');
});

/* ── Ekip · direktörlüğü tanımsız personel ───────────────────────── */

function person(id, directorate) {
  return { id, name: `Kişi ${id}`, organization: { directorate, department: null, unit: null } };
}

test('direktörlüğü olmayan personel kendi süzgeç kümesinde görünür', () => {
  const withDirectorate = person('1', 'Yazılım Direktörlüğü');
  const withoutDirectorate = person('2', null);
  const blankDirectorate = person('3', '   ');

  // Süzgeç seçilmediğinde herkes listelenir.
  assert.equal(matchesDirectorateFilter(withDirectorate, ''), true);
  assert.equal(matchesDirectorateFilter(withoutDirectorate, ''), true);

  // "Direktörlük tanımsız" seçildiğinde yalnızca tanımsızlar kalır.
  assert.equal(matchesDirectorateFilter(withoutDirectorate, UNASSIGNED_DIRECTORATE), true);
  assert.equal(matchesDirectorateFilter(blankDirectorate, UNASSIGNED_DIRECTORATE), true);
  assert.equal(matchesDirectorateFilter(withDirectorate, UNASSIGNED_DIRECTORATE), false);

  // Adlandırılmış direktörlük seçimi tanımsızları dışarıda bırakır.
  assert.equal(matchesDirectorateFilter(withDirectorate, 'Yazılım Direktörlüğü'), true);
  assert.equal(matchesDirectorateFilter(withoutDirectorate, 'Yazılım Direktörlüğü'), false);
});

test('Ekip dizini tanımsız direktörlük için özet kartı ve süzgeç seçeneği üretir', async () => {
  const policy = read('src/features/team/teamDirectoryPolicy.js');
  assert.match(policy, /export const UNASSIGNED_DIRECTORATE_LABEL = 'Direktörlük tanımsız';/);

  // Tanımsız direktörlük kümesi artık paylaşılan süzgeç ilkesinden üretilir:
  // hem üstteki dizin açılır listesi hem de tablo başlığı aynı seçeneği görür.
  const { orgLevelOptions, matchesOrgFilter, createEmptyOrgFilter } =
    await import('../src/features/team/teamFilterPolicy.js');
  const people = [
    { id: '900001', name: 'Ada Yılmaz', organization: { directorate: 'Yazılım Direktörlüğü' } },
    { id: '900002', name: 'Bora Demir', organization: {} }
  ];
  const options = orgLevelOptions(people, 'directorate', createEmptyOrgFilter());
  const unassigned = options.find((option) => option.value === UNASSIGNED_DIRECTORATE);
  assert.ok(unassigned, 'tanımsız direktörlük seçeneği üretilmelidir');
  assert.equal(unassigned.label, UNASSIGNED_DIRECTORATE_LABEL);

  const selection = { ...createEmptyOrgFilter(), directorate: UNASSIGNED_DIRECTORATE };
  assert.equal(matchesOrgFilter(people[1], selection), true);
  assert.equal(matchesOrgFilter(people[0], selection), false);

  const source = read('src/features/team/TeamView.jsx');
  assert.match(source, /directorateSummaries\.map/);
  assert.match(source, /summary\.key === UNASSIGNED_DIRECTORATE/);
});

test('Ekip tablosunun başlığı ve dizin kartı kaydırmada görünür kalır', () => {
  const source = read('src/features/team/TeamView.jsx');
  assert.match(source, /className="team-page col"/);
  assert.match(source, /className="card team-directory-card"/);
  assert.match(source, /className="team-table-scroll"/);

  const css = read('src/app/styles/features.css');
  assert.match(css, /\.team-page \{[^}]*height: 100%/s);
  assert.match(css, /\.team-directory-card \{ flex: 0 0 auto; \}/);
  assert.match(css, /\.team-table-scroll \{[^}]*overflow: auto/s);
  assert.match(css, /\.team-table-scroll \.tbl thead th \{[^}]*background: var\(--bg-elev\)/s);
});

/* ── Kabuk · açılış perdesi, Temel Kip Gantt, vurgu rengi ────────── */

test('açılış perdesi kabuk ızgarasını kullanmaz ve ekranın ortasında durur', () => {
  const source = read('src/components/shell/AppDataBoundary.jsx');
  assert.match(source, /className="app-boot"/);
  assert.match(source, /className="app-boot-card"/);
  assert.equal(/<div className="app">/.test(source), false, 'perde iki sütunlu kabuk ızgarasını kullanmamalıdır');

  const css = read('src/app/styles/shell.css');
  assert.match(css, /\.app-boot \{[^}]*position: fixed;[^}]*place-items: center/s);
  assert.match(css, /\.app-boot-card \{/);
  assert.match(css, /@keyframes app-boot-sweep/);
});

test('Temel Kip gezinmesi Görevler ve Gantt sayfalarını da içerir', () => {
  const source = read('src/components/shell/AppShell.jsx');
  assert.match(source, /const SIMPLE_NAV_IDS = new Set\(\['veri', 'takvim', 'gantt', 'yardim', 'ayarlar'\]\);/);
  // Gantt görünümü her iki kipte de aynı bileşenle çizilir.
  assert.match(source, /case 'gantt': return <WorkspaceGanttView \/>;/);
  // Görevler sayfası Temel Kipte SADE sürümle açılır; Kapsamlı Kip tablosu değişmez.
  const tasksCase = source.match(/case 'veri':([\s\S]*?)(?=\n\s*case 'wbs':)/)?.[1] || '';
  assert.match(tasksCase, /return\s+simpleMode\s*\?\s*<SimpleTasksView\b[^>]*onNewTask=/);
  assert.match(tasksCase, /:\s*<TasksView\s*\/>/);
});

test('vurgu rengi kataloğu Türkçe "Kehribar" adını kullanır', () => {
  const source = read('src/features/settings/SettingsView.jsx');
  assert.match(source, /\['#f59e0b', 'Kehribar'\]/);
  assert.equal(source.includes("'Amber'"), false, 'İngilizce ad kalmamalıdır');
});
