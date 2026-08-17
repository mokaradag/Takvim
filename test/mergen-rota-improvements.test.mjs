/**
 * MERGEN Rota iyileştirmeleri — davranış testleri.
 *
 * Kapsanan konular:
 *   1. Özet halkasının birbirini dışlayan durum kovaları
 *   2. İş dağılım ağacı sürükle-bırak ilkeleri ve taşıma indirgemesi
 *   3. Karşılama ekranı kimliği
 *   4. Açılış yolu: anlık görüntü + oturum sıralaması ve tek gidiş-dönüş
 *   5. Etiket kataloğu (ad, renk, simge, yeniden adlandırma)
 *   6. Tekrarlayan görevler (RFC 5545 RRULE altkümesi)
 *   7. Düzeltilen P0–P2 hataları
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { selectStatusDistribution } from '../src/features/dashboard/statusDistribution.js';
import { resolveWbsDrop, wbsSiblings } from '../src/features/wbs/wbsDragPolicy.js';
import { appStateReducer } from '../src/state/appState.js';
import {
  TAG_COLOR_KEYS,
  TAG_ICON_KEYS,
  defaultTagColor,
  findProjectTag,
  normalizeProjectTag,
  normalizeProjectTags,
  projectTagNames
} from '../src/domain/tags/index.js';
import {
  MAX_RECURRENCE_OCCURRENCES,
  describeRecurrenceRule,
  expandRecurrence,
  formatRecurrenceRule,
  normalizeRecurrenceRule,
  parseRecurrenceRule,
  planRecurringOccurrences
} from '../src/scheduling/recurrence/index.js';
import { greetingForHour, welcomeFirstName } from '../src/components/shell/welcomeGreeting.js';
import { prepareProjectUpdateChanges } from '../src/state/projectCreation.js';
import { loadApplicationData } from '../src/state/persistence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const TODAY = new Date(2026, 7, 17); // 17 Ağustos 2026, Pazartesi

/* ── 1. Özet · durum dağılımı ─────────────────────────────────── */

test('durum halkasının kovaları birbirini dışlar ve toplamı görev sayısına eşittir', () => {
  // Geciken bir görev daha önce hem "Yapılacak" hem "Geciken" sayılıyordu:
  // dilimlerin toplamı görev sayısını aşıyor, halka 360 dereceyi geçip kendi
  // üzerine biniyordu (ekran görüntüsündeki bozuk halka).
  const tasks = [
    { id: '1', status: 'done', targetFinish: '2026-08-01' },
    { id: '2', status: 'in_progress', targetFinish: '2026-08-30' },
    { id: '3', status: 'in_progress', targetFinish: '2026-08-01' },
    { id: '4', status: 'todo', targetFinish: '2026-08-30' },
    { id: '5', status: 'todo', targetFinish: '2026-08-01' },
    { id: '6', status: 'todo', targetFinish: null }
  ];

  const distribution = selectStatusDistribution(tasks, TODAY);
  const sum = distribution.segments.reduce((total, segment) => total + segment.value, 0);

  assert.equal(distribution.total, tasks.length);
  assert.equal(sum, tasks.length, 'dilimlerin toplamı görev sayısını aşamaz');
  assert.deepEqual(
    distribution.segments.map((segment) => [segment.id, segment.value]),
    [['done', 1], ['in_progress', 1], ['todo', 2], ['overdue', 2]]
  );
  assert.equal(distribution.completionRate, Math.round((1 / 6) * 100));
});

test('durum dağılımı boş listede çökmez ve sıfır değerli kovaları gizler', () => {
  const empty = selectStatusDistribution([], TODAY);
  assert.deepEqual(empty.segments, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.completionRate, 0);

  const onlyDone = selectStatusDistribution([{ id: '1', status: 'done' }], TODAY);
  assert.deepEqual(onlyDone.segments.map((segment) => segment.id), ['done']);
  assert.equal(onlyDone.completionRate, 100);
});

test('her dilim kimlik taşır: seçim dilim sırasına göre saklanmaz', () => {
  // Sıra numarası saklandığında görev listesi kısaldıkça seçim boşa düşüyor ve
  // merkez etiket `undefined.color` okumasıyla çöküyordu.
  const dashboard = read('src/features/dashboard/DashboardView.jsx');
  assert.match(dashboard, /statusDonut\.findIndex\(\(segment\) => segment\.id === donutSel\)/);
  assert.match(dashboard, /const toggleSegment = \(id\)/);
  assert.doesNotMatch(dashboard, /statusDonut\[donutSel\]/);
});

test('halka çizimi dilim toplamını çevre ile sınırlar ve seçim payını viewBox\'a yansıtır', () => {
  const ui = read('src/components/ui.jsx');
  assert.match(ui, /const pad = DONUT_LIFT \+ DONUT_EMPHASIS \+ 2;/);
  assert.match(ui, /const len = total > 0 \? \(values\[i\] \/ total\) \* c : 0;/);
  assert.match(ui, /Number\.isFinite\(d\?\.value\) && d\.value > 0 \? d\.value : 0/);
});

test('tamamlanan görev rozetindeki haftalık değer uydurulmaz', () => {
  const dashboard = read('src/features/dashboard/DashboardView.jsx');
  assert.doesNotMatch(dashboard, /Math\.max\(0, done - 4\)/);
  assert.match(dashboard, /trend=\{`\+\$\{weeklyDelta\.thisWeekDone\} bu hafta`\}/);
});

/* ── 2. İş dağılım ağacı · sürükle-bırak ──────────────────────── */

function treeFixture() {
  return [
    { id: 'r', projectId: 'p', parentId: null, code: '1', name: 'Kök', sortOrder: 1 },
    { id: 'a', projectId: 'p', parentId: 'r', code: '1.1', name: 'A', sortOrder: 1 },
    { id: 'b', projectId: 'p', parentId: 'r', code: '1.2', name: 'B', sortOrder: 2 },
    { id: 'c', projectId: 'p', parentId: 'r', code: '1.3', name: 'C', sortOrder: 3 },
    { id: 'a1', projectId: 'p', parentId: 'a', code: '1.1.1', name: 'A1', sortOrder: 1 },
    { id: 'x', projectId: 'q', parentId: null, code: '1', name: 'Başka proje', sortOrder: 1 }
  ];
}

function treeState(wbs = treeFixture()) {
  return { wbs, tasks: [], projects: [{ id: 'p' }, { id: 'q' }], people: [], calendars: [], wbsActionError: null };
}

test('satır ortasına bırakmak düğümü alt düğüm yapar', () => {
  const wbs = treeFixture();
  const drop = resolveWbsDrop(wbs, { dragId: 'b', targetId: 'a', position: 'inside' });

  assert.equal(drop.ok, true);
  assert.deepEqual(drop.move, { id: 'b', parentId: 'a', index: 1 });

  const next = appStateReducer(treeState(wbs), { type: 'wbs/move', ...drop.move });
  const moved = next.wbs.find((node) => node.id === 'b');
  assert.equal(next.wbsActionError, null);
  assert.equal(moved.parentId, 'a');
  assert.equal(moved.code, '1.1.2', 'taşınan düğümün kodu yeni üstüne göre yeniden türetilir');
});

test('satır kenarına bırakmak kardeş sırasını değiştirir ve kodları yeniden yazmaz', () => {
  const wbs = treeFixture();
  const drop = resolveWbsDrop(wbs, { dragId: 'c', targetId: 'a', position: 'before' });

  assert.equal(drop.ok, true);
  assert.deepEqual(drop.move, { id: 'c', parentId: 'r', index: 0 });

  const next = appStateReducer(treeState(wbs), { type: 'wbs/move', ...drop.move });
  const byId = new Map(next.wbs.map((node) => [node.id, node]));
  assert.equal(next.wbsActionError, null);
  assert.equal(byId.get('c').sortOrder, 1);
  assert.equal(byId.get('a').sortOrder, 2);
  assert.equal(byId.get('b').sortOrder, 3);
  // Sıralama kodları yeniden yazmaz: tek bir sürükleme yüzlerce kaydı
  // güncellemek zorunda kalmaz.
  assert.equal(byId.get('c').code, '1.3');
});

test('sıralama yalnızca gerçekten değişen kardeşler için yeni kayıt üretir', () => {
  const wbs = treeFixture();
  const state = treeState(wbs);
  const next = appStateReducer(state, { type: 'wbs/move', id: 'c', parentId: 'r', index: 0 });

  const unchanged = next.wbs.filter((node, index) => node === state.wbs[index]);
  assert.ok(unchanged.some((node) => node.id === 'r'), 'kök düğüm aynı referansta kalmalıdır');
  assert.ok(unchanged.some((node) => node.id === 'a1'), 'kardeş olmayan düğümler dokunulmadan kalmalıdır');
  assert.ok(unchanged.some((node) => node.id === 'x'), 'başka projenin düğümü hiç değişmemelidir');
});

test('geçersiz bırakmalar açık gerekçeyle reddedilir', () => {
  const wbs = treeFixture();
  const cases = [
    [{ dragId: 'a', targetId: 'a1', position: 'inside' }, 'WBS_REPARENT_TO_DESCENDANT'],
    [{ dragId: 'r', targetId: 'a', position: 'inside' }, 'WBS_ROOT_REPARENT_FORBIDDEN'],
    [{ dragId: 'a', targetId: 'a', position: 'inside' }, 'WBS_DROP_ON_SELF'],
    [{ dragId: 'a', targetId: 'x', position: 'inside' }, 'CROSS_PROJECT_WBS_PARENT'],
    [{ dragId: 'a', targetId: 'r', position: 'before' }, 'WBS_ROOT_SIBLING_FORBIDDEN'],
    [{ dragId: 'b', targetId: 'a', position: 'after' }, 'WBS_DROP_NO_CHANGE'],
    [{ dragId: 'yok', targetId: 'a', position: 'inside' }, 'WBS_NODE_NOT_FOUND'],
    [{ dragId: 'a', targetId: 'yok', position: 'inside' }, 'WBS_TARGET_NOT_FOUND']
  ];

  for (const [drop, code] of cases) {
    const resolution = resolveWbsDrop(wbs, drop);
    assert.equal(resolution.ok, false, `${code} reddedilmelidir`);
    assert.equal(resolution.code, code);
    assert.ok(resolution.message.length > 0, 'kullanıcıya gösterilecek bir gerekçe bulunmalıdır');
  }
});

test('kardeş listesi ağaçtaki görüntü sırasını verir', () => {
  assert.deepEqual(wbsSiblings(treeFixture(), 'r').map((node) => node.id), ['a', 'b', 'c']);
});

test('ağaç görünümü yalnızca proje değiştiğinde sıfırlanır', () => {
  // Etki daha önce `orderedRows` bağımlılığıyla çalışıyordu: her düğüm ekleme
  // ve taşıma yeni bir satır dizisi ürettiği için ağaç varsayılan derinliğe
  // kapanıyor, açık paneller ve seçimler kayboluyordu.
  const view = read('src/features/wbs/WbsView.jsx');
  assert.match(view, /initialised\.projectId === projectId && \(initialised\.rows > 0 \|\| !orderedRows\.length\)/);
  assert.match(view, /\}, \[workspace\.selectedProjectId, orderedRows\]\);/);
});

test('dağılım ağacı düzenlemesi engelleyici tarayıcı pencereleri kullanmaz', () => {
  // Açıklama satırları eski akışa atıfta bulunabilir; aranan şey GERÇEK çağrılardır.
  const code = read('src/features/wbs/WbsView.jsx')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.doesNotMatch(code, /\bprompt\(/);
  assert.doesNotMatch(code, /(?<![A-Za-z])confirm\(/);
  const view = read('src/features/wbs/WbsView.jsx');
  assert.match(view, /const \[editing, setEditing\] = useState\(null\);/);
  assert.match(view, /const \[pendingDelete, setPendingDelete\] = useState\(null\);/);
  assert.match(view, /Evet, sil/);
});

test('kurumsal ve salt okunur ağaçlarda satırlar sürüklenemez', () => {
  const view = read('src/features/wbs/WbsView.jsx');
  assert.match(view, /const draggable = canEdit && node\.parentId != null;/);
  assert.match(view, /if \(!canEdit \|\| node\.parentId == null\) return;/);
});

/* ── 3. Karşılama ekranı ──────────────────────────────────────── */

test('karşılama selamlaması saate göre değişir ve yalnızca ilk adı kullanır', () => {
  assert.equal(greetingForHour(3), 'İyi geceler');
  assert.equal(greetingForHour(9), 'Günaydın');
  assert.equal(greetingForHour(14), 'İyi günler');
  assert.equal(greetingForHour(21), 'İyi akşamlar');
  assert.equal(greetingForHour(Number.NaN), 'Hoş geldiniz');

  assert.equal(welcomeFirstName('Mehmet Onur Karadağ'), 'Mehmet');
  assert.equal(welcomeFirstName('   '), '');
  assert.equal(welcomeFirstName(null), '');
});

test('karşılama ekranı doğrulanmış oturum kimliğini gösterir', () => {
  const welcome = read('src/components/shell/WelcomeScreen.jsx');
  const shell = read('src/components/shell/AppShell.jsx');

  assert.match(welcome, /<Avatar name=\{displayName \|\| 'Kullanıcı'\} employeeNo=\{employeeNo\}/);
  assert.match(welcome, /resolveUserDisplayName\(currentUser/);
  assert.match(welcome, /resolveUserDepartmentLabel\(currentUser/);
  assert.match(welcome, /role="dialog"/);
  assert.match(welcome, /aria-modal="true"/);
  // Esc modalı kapatır.
  assert.match(welcome, /event\.key === 'Escape'/);
  assert.match(shell, /currentUser=\{currentUser\}/);
});

/* ── 4. Açılış yolu ───────────────────────────────────────────── */

test('oturum bağlamı anlık görüntüden SONRA okunur (kurumsal eşitleme sırası)', async () => {
  const events = [];
  const session = { dataMode: 'actual', currentUser: null, projectAccess: [] };
  const result = await loadApplicationData({
    kind: 'actual-api',
    async loadSnapshot() {
      events.push('snapshot:start');
      await new Promise((resolve) => setTimeout(resolve, 0));
      events.push('snapshot:end');
      return { calendars: [], projects: [], people: [], wbs: [], tasks: [], baselines: [], taskBaselineSnapshots: [] };
    },
    async loadSessionContext() {
      events.push('session');
      return session;
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(events, ['snapshot:start', 'snapshot:end', 'session']);
  assert.deepEqual(result.snapshot.session, session);
});

test('anlık görüntü yanıtındaki oturum ikinci bir ağ isteği yapılmadan kullanılır', async () => {
  const { createApiRepository } = await import('../src/data/api/createApiRepository.js');
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          calendars: [], projects: [], people: [], wbs: [], tasks: [], baselines: [], taskBaselineSnapshots: [],
          session: { dataMode: 'actual', projectAccess: [] }
        };
      }
    };
  };

  try {
    const repository = createApiRepository({ basePath: '/test-api' });
    const snapshot = await repository.loadSnapshot();
    assert.equal(snapshot.session, undefined, 'oturum anlık görüntü gövdesinden ayrılmalıdır');

    const session = await repository.loadSessionContext();
    assert.equal(session.dataMode, 'actual');
    assert.deepEqual(requests, ['/test-api/snapshot'], 'açılışta yalnızca tek istek yapılmalıdır');

    // İkinci okuma (oturum tazeleme) yine sunucuya gider.
    await repository.loadSessionContext();
    assert.deepEqual(requests, ['/test-api/snapshot', '/test-api/session']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('anlık görüntü ucu oturumu aynı istek içinde ve eşitlemeden sonra döndürür', () => {
  const route = read('src/app/api/mergen-rota/snapshot/route.js');
  assert.match(route, /const snapshot = await repository\.loadSnapshot\(\);\s*const session = await repository\.loadSessionContext\(\);/);
  assert.match(route, /Response\.json\(\{ \.\.\.snapshot, session \}/);
});

test('kurumsal katalog ilk kurulumdan sonra arka planda tazelenir', async () => {
  const schedule = await import('../src/server/repository/corporateWbsSyncSchedule.js');
  schedule.resetCorporateWbsSyncScheduleForTests();
  process.env.MERGEN_ROTA_WBS_SYNC_TTL_MS = '1';

  try {
    let running = 0;
    let completed = 0;
    const slowSync = async () => {
      running += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      running -= 1;
      completed += 1;
      return { synchronized: true };
    };

    // İlk tur BEKLENİR: depoda henüz ağaç olmayabilir.
    const first = await schedule.runCorporateWbsSync(slowSync);
    assert.equal(first.synchronized, true);
    assert.equal(completed, 1);
    assert.equal(schedule.hasCorporateWbsSyncedOnce(), true);

    await new Promise((resolve) => setTimeout(resolve, 5));

    // Sonraki tur BEKLENMEZ: istek depodaki ağaçla hemen yanıtlanır.
    const second = await schedule.runCorporateWbsSync(slowSync);
    assert.equal(second.reason, 'REVALIDATING');
    assert.equal(second.synchronized, false);
    assert.equal(running, 1, 'tazeleme arka planda sürmelidir');

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(completed, 2, 'arka plan tazelemesi tamamlanmalıdır');
  } finally {
    delete process.env.MERGEN_ROTA_WBS_SYNC_TTL_MS;
    schedule.resetCorporateWbsSyncScheduleForTests();
  }
});

test('tazelik penceresi kapalıyken (TTL=0) eşitleme eşzamanlı kalır', async () => {
  const schedule = await import('../src/server/repository/corporateWbsSyncSchedule.js');
  schedule.resetCorporateWbsSyncScheduleForTests();
  process.env.MERGEN_ROTA_WBS_SYNC_TTL_MS = '0';

  try {
    let completed = 0;
    const sync = async () => { completed += 1; return { synchronized: true }; };
    await schedule.runCorporateWbsSync(sync);
    const second = await schedule.runCorporateWbsSync(sync);
    assert.equal(completed, 2, 'geliştirme kipinde her istek eşitlemeyi beklemelidir');
    assert.equal(second.synchronized, true);
  } finally {
    delete process.env.MERGEN_ROTA_WBS_SYNC_TTL_MS;
    schedule.resetCorporateWbsSyncScheduleForTests();
  }
});

/* ── 5. Etiket kataloğu ───────────────────────────────────────── */

test('etiket düz metinden kanonik üçlüye yükseltilir', () => {
  const tag = normalizeProjectTag('  Analiz  ');
  assert.equal(tag.name, 'Analiz');
  assert.ok(TAG_COLOR_KEYS.includes(tag.color));
  assert.ok(TAG_ICON_KEYS.includes(tag.icon));
  assert.equal(normalizeProjectTag('   '), null);
  assert.equal(normalizeProjectTag(null), null);
});

test('etiket rengi ada göre kararlıdır ve geçersiz anahtarlar varsayılana düşer', () => {
  assert.equal(defaultTagColor('Analiz'), defaultTagColor('Analiz'));
  assert.ok(TAG_COLOR_KEYS.includes(defaultTagColor('Analiz')));
  assert.equal(normalizeProjectTag({ name: 'X', color: 'neon', icon: 'Uçak' }).icon, 'Flag');
  assert.ok(TAG_COLOR_KEYS.includes(normalizeProjectTag({ name: 'X', color: 'neon' }).color));
  assert.equal(normalizeProjectTag({ name: 'X', color: 'rose', icon: 'Target' }).color, 'rose');
  assert.equal(normalizeProjectTag({ name: 'X', color: 'rose', icon: 'Target' }).icon, 'Target');
});

test('katalog kırpar, harf duyarsız tekilleştirir ve Türkçe sıralar', () => {
  const tags = normalizeProjectTags([' Test ', { name: 'test', color: 'rose' }, 'Analiz', '', 'ANALİZ']);
  assert.deepEqual(projectTagNames(tags), ['Analiz', 'Test']);
  assert.equal(findProjectTag(tags, 'TEST')?.name, 'Test');
  assert.equal(findProjectTag(tags, 'yok'), null);
});

test('etiket yeniden adlandırıldığında görevlerin etiketi de taşınır', () => {
  const context = {
    projects: [{
      id: 'p1', name: 'Alpha', code: 'A', source: 'manual', color: 'blue',
      leadId: 'u1', lead: 'Ayşe', calendarId: 'cal1', dataDate: '2026-07-22',
      tags: [{ name: 'Analiz', color: 'blue', icon: 'Flag' }]
    }],
    people: [{ id: 'u1', name: 'Ayşe' }],
    calendars: [{ id: 'cal1', name: 'Takvim' }],
    tasks: [
      { id: 't1', projectId: 'p1', keyword: 'Analiz' },
      { id: 't2', projectId: 'p1', keyword: 'Başka' }
    ],
    wbs: []
  };

  const result = prepareProjectUpdateChanges('p1', {
    name: 'Alpha',
    code: 'A',
    color: 'blue',
    leadId: 'u1',
    calendarId: 'cal1',
    dataDate: '2026-07-22',
    tags: [{ name: 'Çözümleme', color: 'rose', icon: 'Target' }],
    tagRenames: [{ from: 'Analiz', to: 'Çözümleme' }]
  }, context);

  assert.equal(result.ok, true);
  assert.deepEqual(result.project.tags, [{ name: 'Çözümleme', color: 'rose', icon: 'Target' }]);
  assert.deepEqual(
    result.changes.taskUpserts.map((task) => [task.id, task.keyword]),
    [['t1', 'Çözümleme']],
    'yalnızca yeniden adlandırılan etiketi taşıyan görev güncellenmelidir'
  );
});

test('etiket rengi ve simgesi kalıcı kayda kapalı küme olarak yazılır', () => {
  const repository = read('src/server/repository/sqlAppRepository.js');
  const validation = read('src/server/repository/commitProjectWbsValidation.js');
  const schema = read('database/MR_Create_Durable_Persistence.sql');

  assert.match(repository, /INSERT dbo\.MR_ProjectTags\(ProjectId, TagName, ColorToken, IconKey, SortOrder, CreatedBySicil\)/);
  assert.match(repository, /const canonical = normalizeProjectTags\(values\);/);
  assert.match(validation, /PROJECT_TAG_COLOR_INVALID/);
  assert.match(validation, /PROJECT_TAG_ICON_INVALID/);
  assert.match(schema, /ColorToken varchar\(20\) NULL,\s*\n\s*IconKey varchar\(40\) NULL,/);
});

/* ── 6. Tekrarlayan görevler ──────────────────────────────────── */

test('tekrar kuralı RFC 5545 gövdesine çevrilir ve geri okunur', () => {
  const rule = normalizeRecurrenceRule({ freq: 'weekly', interval: '2', byWeekday: ['mo', 'fr', 'mo'], count: '10' });
  assert.deepEqual(rule, { freq: 'WEEKLY', interval: 2, byWeekday: ['MO', 'FR'], byMonthDay: null, count: 10, until: null });
  assert.equal(formatRecurrenceRule(rule), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=10');
  assert.deepEqual(normalizeRecurrenceRule('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=10'), rule);
  assert.equal(parseRecurrenceRule(''), null);
  assert.equal(normalizeRecurrenceRule('FREQ=HOURLY'), null);
  assert.equal(normalizeRecurrenceRule(null), null);
});

test('COUNT ve UNTIL birlikte verilemez; COUNT önceliklidir', () => {
  const rule = normalizeRecurrenceRule({ freq: 'DAILY', count: 5, until: '2026-12-31' });
  assert.equal(rule.count, 5);
  assert.equal(rule.until, null);
  assert.equal(formatRecurrenceRule(rule), 'FREQ=DAILY;COUNT=5');

  const bounded = normalizeRecurrenceRule({ freq: 'DAILY', until: '2026-12-31' });
  assert.equal(bounded.until, '2026-12-31');
  assert.equal(formatRecurrenceRule(bounded), 'FREQ=DAILY;UNTIL=20261231');
});

test('kural somut tarihlere açılır: günlük, haftalık, aylık, yıllık', () => {
  assert.deepEqual(
    expandRecurrence({ freq: 'DAILY', interval: 2, count: 4 }, { start: '2026-08-17' }),
    ['2026-08-17', '2026-08-19', '2026-08-21', '2026-08-23']
  );
  assert.deepEqual(
    expandRecurrence({ freq: 'WEEKLY', byWeekday: ['MO', 'WE'], count: 4 }, { start: '2026-08-17' }),
    ['2026-08-17', '2026-08-19', '2026-08-24', '2026-08-26']
  );
  assert.deepEqual(
    expandRecurrence({ freq: 'WEEKLY', interval: 2, byWeekday: ['MO'], count: 3 }, { start: '2026-08-17' }),
    ['2026-08-17', '2026-08-31', '2026-09-14']
  );
  assert.deepEqual(
    expandRecurrence({ freq: 'YEARLY', count: 3 }, { start: '2026-02-28' }),
    ['2026-02-28', '2027-02-28', '2028-02-28']
  );
});

test('ayın 31\'i olmayan aylarda yineleme ayın son gününe çekilir', () => {
  assert.deepEqual(
    expandRecurrence({ freq: 'MONTHLY', byMonthDay: 31, count: 4 }, { start: '2026-01-31' }),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']
  );
});

test('UNTIL ve ufuk sınırı açılımı durdurur; sonsuz kural üst sınırı aşamaz', () => {
  assert.deepEqual(
    expandRecurrence({ freq: 'DAILY', until: '2026-08-20' }, { start: '2026-08-17' }),
    ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20']
  );
  assert.equal(
    expandRecurrence({ freq: 'DAILY' }, { start: '2026-08-17', horizonEnd: '2026-08-19' }).length,
    3
  );
  assert.equal(
    expandRecurrence({ freq: 'DAILY' }, { start: '2026-08-17', limit: 5000 }).length,
    MAX_RECURRENCE_OCCURRENCES
  );
});

test('kural Türkçe olarak özetlenir', () => {
  assert.equal(describeRecurrenceRule({ freq: 'DAILY' }), 'Her gün');
  assert.equal(describeRecurrenceRule({ freq: 'WEEKLY', interval: 2, byWeekday: ['MO', 'FR'], count: 10 }),
    '2 haftada bir · Pzt, Cum · 10 yineleme');
  assert.equal(describeRecurrenceRule({ freq: 'MONTHLY', byMonthDay: 15, until: '2027-01-01' }),
    'Her ay · ayın 15. günü · 2027-01-01 tarihine kadar');
  assert.equal(describeRecurrenceRule(null), 'Tekrar yok');
});

test('yineleme planı süreyi korur ve tatil gününü ileri kaydırır', () => {
  const template = {
    plannedStart: '2026-08-17',
    plannedFinish: '2026-08-18',
    targetFinish: '2026-08-19',
    plannedDurationDays: 1
  };
  const plan = planRecurringOccurrences(template, { freq: 'DAILY', count: 3 }, {});
  assert.deepEqual(plan.map((item) => item.plannedStart), ['2026-08-17', '2026-08-18', '2026-08-19']);
  assert.deepEqual(plan.map((item) => item.plannedFinish), ['2026-08-18', '2026-08-19', '2026-08-20']);
  assert.deepEqual(plan.map((item) => item.targetFinish), ['2026-08-19', '2026-08-20', '2026-08-21']);

  // Hafta sonu çalışma günü değildir: Cumartesi'ye düşen yineleme Pazartesi'ye kayar.
  const calendar = { workingDays: [1, 2, 3, 4, 5], holidays: [] };
  const shifted = planRecurringOccurrences(
    { ...template, plannedStart: '2026-08-21' },
    { freq: 'DAILY', count: 3 },
    { calendar }
  );
  assert.deepEqual(shifted.map((item) => item.plannedStart), ['2026-08-21', '2026-08-24']);
});

test('planlanan başlangıcı olmayan şablon yineleme üretmez', () => {
  assert.deepEqual(planRecurringOccurrences({ plannedFinish: '2026-08-18' }, { freq: 'DAILY', count: 3 }, {}), []);
});

test('yinelemeler şablona bağlanır, kuralı ve bağımlılıkları kopyalamaz', () => {
  const provider = read('src/state/AppStateProvider.jsx');
  assert.match(provider, /recurrence: null,\s*\n\s*recurrenceParentId: taskId,/);
  assert.match(provider, /deps: \[\]/);
  assert.match(provider, /existingStarts\.has\(occurrence\.plannedStart\)/);
});

test('kalıcılaştırma tekrar kuralını doğrular ve yinelemede kurala izin vermez', async () => {
  const { findCommitScalarIssue } = await import('../src/server/repository/commitScalarValidation.js');
  const base = { id: 'a1b2c3d4-0000-4000-8000-000000000001', projectId: 'a1b2c3d4-0000-4000-8000-000000000002', task: 'Görev' };

  assert.equal(findCommitScalarIssue({ taskUpserts: [{ ...base, recurrence: 'FREQ=DAILY;COUNT=3' }] }), null);
  assert.equal(
    findCommitScalarIssue({ taskUpserts: [{ ...base, recurrence: 'FREQ=HOURLY' }] })?.code,
    'TASK_RECURRENCE_INVALID'
  );
  assert.equal(
    findCommitScalarIssue({
      taskUpserts: [{ ...base, recurrence: 'FREQ=DAILY', recurrenceParentId: 'a1b2c3d4-0000-4000-8000-000000000003' }]
    })?.code,
    'TASK_RECURRENCE_CONFLICT'
  );
});

test('tekrar alanları şemada ve anlık görüntü izdüşümünde bulunur', () => {
  const schema = read('database/MR_Create_Durable_Persistence.sql');
  const repository = read('src/server/repository/sqlAppRepository.js');

  assert.match(schema, /RecurrenceRule nvarchar\(400\) NULL,/);
  assert.match(schema, /RecurrenceParentTaskId uniqueidentifier NULL,/);
  assert.match(schema, /CONSTRAINT CK_MR_Tasks_Recurrence CHECK \(RecurrenceParentTaskId IS NULL OR RecurrenceRule IS NULL\)/);
  assert.match(repository, /recurrence: row\.RecurrenceRule \|\| null,/);
  assert.match(repository, /recurrenceParentId: id\(row\.RecurrenceParentTaskId\),/);
});

/* ── 7. Düzeltilen P0–P2 hataları ─────────────────────────────── */

test('Kanban tanınmayan bir görev durumunda çökmez', () => {
  const kanban = read('src/features/kanban/KanbanView.jsx');
  assert.match(kanban, /Object\.prototype\.hasOwnProperty\.call\(map, t\.status\) \? t\.status : 'todo'/);
  assert.doesNotMatch(kanban, /const s = t\.status \|\| 'todo';\s*\n\s*map\[s\]\.push/);
});

test('alan grafiği degradesi belge genelinde benzersizdir', () => {
  // Sabit `areagrad` kimliğiyle aynı sayfadaki ikinci grafik, ilk grafiğin
  // rengiyle boyanıyordu.
  const ui = read('src/components/ui.jsx');
  assert.match(ui, /const gradientId = `areagrad-\$\{React\.useId\(\)/);
  assert.doesNotMatch(ui, /id="areagrad"/);
  assert.doesNotMatch(ui, /url\(#areagrad\)/);
});

test('sekme kapatılırken bekleyen düzenlemeler kaybolmaz', () => {
  const guard = read('src/components/shell/UnsavedChangesGuard.jsx');
  const root = read('src/components/shell/ApplicationRoot.jsx');
  const persistence = read('src/state/persistence.js');

  assert.match(persistence, /hasPendingChanges\(\) \{ return taskPatches\.hasPending\(\); \}/);
  assert.match(guard, /window\.addEventListener\('beforeunload', onBeforeUnload\)/);
  assert.match(guard, /document\.addEventListener\('visibilitychange', flushIfHidden\)/);
  assert.match(guard, /event\.preventDefault\(\);\s*\n\s*event\.returnValue = '';/);
  assert.match(root, /<UnsavedChangesGuard \/>/);
});

test('halka dilimi tıklamasında sökülmüş bileşene durum yazılmaz', () => {
  // Eski çizim seçili dilim için 460 ms'lik bir zamanlayıcı kuruyor ve
  // temizlemiyordu; sayfa bu sürede değiştiğinde sökülmüş bileşene yazıyordu.
  const ui = read('src/components/ui.jsx');
  assert.doesNotMatch(ui, /setPulseI/);
  assert.doesNotMatch(ui, /setTimeout\(\(\) => setPulseI/);
});

test('boş görev başlığı kalıcılaştırmaya hiç gönderilmez', async () => {
  // Boş başlık sunucuda TASK_TITLE_REQUIRED ile reddediliyor ve aynı yamada
  // birleştirilen ilerleme/tarih düzenlemeleri de o istekle birlikte düşüyordu.
  const drawer = read('src/features/task-detail/TaskDrawer.jsx');
  assert.match(drawer, /const saveTitle = \(value\) => \{/);
  assert.match(drawer, /if \(String\(value\)\.trim\(\)\) onUpdate\(task\.id, \{ task: value \}\);/);
  assert.match(drawer, /onChange=\{\(e\) => saveTitle\(e\.target\.value\)\}/);
  assert.match(drawer, /Görev başlığı boş bırakılamaz/);

  const { findCommitScalarIssue } = await import('../src/server/repository/commitScalarValidation.js');
  const rejected = findCommitScalarIssue({
    taskUpserts: [{
      id: 'a1b2c3d4-0000-4000-8000-000000000001',
      projectId: 'a1b2c3d4-0000-4000-8000-000000000002',
      task: '   '
    }]
  });
  assert.equal(rejected?.code, 'TASK_TITLE_REQUIRED', 'sunucu tarafı doğrulama son savunma hattı olarak kalır');
});

test('başarısız bir kayıt görev panelini rehin almaz', async () => {
  // Panel daha önce başarısız kaydı geri döndürüp `closeTask()` çağırmıyordu:
  // sunucu bir alanı reddettiğinde ne "Tamam" ne de kapatma düğmesi çalışıyor,
  // uygulama donmuş görünüyordu.
  const overlay = read('src/features/task-detail/TaskDetailOverlay.jsx');
  assert.match(overlay, /const closeResult = await closeTask\(\);/);
  assert.match(overlay, /return pendingResult\.ok \? closeResult : pendingResult;/);
  assert.doesNotMatch(overlay, /if \(!pendingResult\.ok\) return pendingResult;/);

  const provider = read('src/state/AppStateProvider.jsx');
  assert.match(provider, /applyStateAction\(\{ type: 'task\/select', id: null \}\);\s*\n\s*return failedFlush \|\| \{ ok: true, value: null \};/);

  // Davranış: başarısız temizleme sonrasında bile seçim düşer.
  const { appStateReducer: reducer } = await import('../src/state/appState.js');
  const closed = reducer({ tasks: [{ id: 't1' }], selectedTaskId: 't1', projects: [], people: [], wbs: [], calendars: [] }, {
    type: 'task/select',
    id: null
  });
  assert.equal(closed.selectedTaskId, null);
});

/* ── Sütun süzgeçlerinde canlı arama ──────────────────────────── */

test('süzgeç seçeneği etiketi, değeri ve anahtar sözcükleri üzerinde aranır', async () => {
  const { matchesOptionQuery, OPTION_SEARCH_THRESHOLD } = await import('../src/components/columnFilterSearch.js');

  const option = {
    value: 'MEHMET ONUR KARADAĞ',
    label: '900123 · MEHMET ONUR KARADAĞ',
    keywords: ['MEHMET ONUR KARADAĞ', '900123', 'Fiyatlandırma ve Proje Yönetimi Birimi']
  };

  assert.equal(matchesOptionQuery(option, ''), true, 'boş arama her seçeneği geçirir');
  assert.equal(matchesOptionQuery(option, 'onur'), true);
  assert.equal(matchesOptionQuery(option, 'ONUR'), true, 'arama harf duyarsızdır');
  assert.equal(matchesOptionQuery(option, '900123'), true, 'sicil ile aranabilir');
  assert.equal(matchesOptionQuery(option, 'fiyatlandırma'), true, 'birim ile aranabilir');
  assert.equal(matchesOptionQuery(option, 'bulunmayan'), false);
  assert.ok(OPTION_SEARCH_THRESHOLD > 0);
});

test('seçili değer arama sonucundan düşmez ve süzgeç eşiği uygulanır', () => {
  const extras = read('src/components/ui-extras.jsx');
  assert.match(extras, /const searchable = \(type === 'multi' \|\| type === 'single'\) && options\.length > OPTION_SEARCH_THRESHOLD;/);
  // Seçili değer aramada elense bile listede kalır: aksi hâlde kullanıcı ne
  // seçtiğini göremeden seçimini kaldırabilirdi.
  assert.match(extras, /\|\| \(type === 'multi' \? sel\.has\(option\.value\) : String\(option\.value\) === String\(q \?\? ''\)\)/);
  assert.match(extras, /Eşleşen seçenek yok\./);
});

test('görev ve Gantt süzgeçleri kişi/proje için arama anahtarları taşır', () => {
  const tasks = read('src/features/tasks/TasksView.jsx');
  const gantt = read('src/features/gantt/GanttView.jsx');

  assert.match(tasks, /keywords: \[p\.code, p\.name, p\.projectTypeCode, p\.projectTypeName\]/);
  assert.match(tasks, /keywords: \[p\.name, p\.employeeNo, p\.username, p\.role, p\.team, p\.organization\?\.department, p\.organization\?\.unit\]/);
  assert.match(gantt, /keywords: \[p\.name, p\.employeeNo, p\.username, p\.role, p\.team, p\.organization\?\.department, p\.organization\?\.unit\]/);
});

/* ── Kart düzenleri ───────────────────────────────────────────── */

test('kişi ölçüm tablosu adı esnek sütunda tutar ve sayısal sütunlar ekler', () => {
  const table = read('src/components/PeopleMetricTable.jsx');
  const dashboard = read('src/features/dashboard/DashboardView.jsx');
  const reports = read('src/features/reports/ReportsView.jsx');
  const css = read('src/app/styles/dashboard.css');

  assert.match(css, /\.pm-row \{[^}]*grid-template-columns: minmax\(0, 1fr\)/s);
  assert.match(table, /className="pm-name"/);
  assert.match(table, /className="pm-sub"/);
  // Özet · Ekip iş yükü
  assert.match(dashboard, /key: 'total'/);
  assert.match(dashboard, /key: 'active'/);
  assert.match(dashboard, /key: 'late'/);
  // Raporlar · Kaynak kullanımı
  assert.match(reports, /key: 'free'/);
  assert.match(reports, /key: 'weekly'/);
  assert.match(reports, /key: 'pct'/);
});
