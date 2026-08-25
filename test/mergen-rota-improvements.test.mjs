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
import { donutSegments, donutSlicePath } from '../src/components/charts/donutGeometry.js';
import { resolveWbsDrop, wbsSiblings } from '../src/features/wbs/wbsDragPolicy.js';
import { appStateReducer } from '../src/state/appState.js';
import {
  TAG_COLOR_KEYS,
  TAG_ICON_KEYS,
  applyProjectTagPropagation,
  defaultTagColor,
  findProjectTag,
  mergeProjectTagAppearance,
  normalizeProjectTag,
  normalizeProjectTags,
  planProjectTagPropagation,
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

test('halka dilimleri tam 360 dereceyi paylaşır ve hiçbiri halkayı aşamaz', () => {
  // Kesik-desenli çizimde yuvarlama artığı deseni başa sardırıyor, aynı dilim
  // halkanın iki ayrı yerinde parça parça görünüyordu.
  const segments = donutSegments([
    { label: 'Tamamlanan', value: 1 },
    { label: 'Devam eden', value: 3 },
    { label: 'Yapılacak', value: 31 },
    { label: 'Geciken', value: 9 }
  ], { gapDegrees: 0 });

  assert.equal(segments.length, 4);
  assert.equal(segments[0].startAngle, -90);
  assert.equal(segments.at(-1).endAngle, 270);
  for (const segment of segments) {
    assert.ok(segment.endAngle > segment.startAngle, 'her dilimin açısı pozitiftir');
    assert.ok(segment.endAngle <= 270 + 1e-9, 'hiçbir dilim halkanın sonunu aşamaz');
  }
  // Ardışık dilimler boşluksuz zincirlenir: toplam tam 360 derecedir.
  for (let index = 1; index < segments.length; index += 1) {
    assert.ok(Math.abs(segments[index].startAngle - segments[index - 1].endAngle) < 1e-9);
  }
});

test('halka dilimleri sayı olmayan, negatif ve sıfır değerleri çizime sokmaz', () => {
  const segments = donutSegments([
    { label: 'A', value: 5 },
    { label: 'B', value: -3 },
    { label: 'C', value: 0 },
    { label: 'D', value: Number.NaN },
    { label: 'E', value: 5 }
  ], { gapDegrees: 0 });

  assert.deepEqual(segments.map((segment) => segment.index), [0, 4]);
  assert.equal(segments[0].endAngle - segments[0].startAngle, 180);
});

test('dilimler arası boşluk küçük dilimi yutmaz', () => {
  const segments = donutSegments([{ label: 'A', value: 1 }, { label: 'B', value: 999 }], { gapDegrees: 30 });
  for (const segment of segments) {
    assert.ok(segment.endAngle > segment.startAngle, 'boşluk uygulandıktan sonra da dilim çizilebilir kalır');
  }
});

test('tek dilim halkayı boşluksuz kapatır ve tam tur yolu üretir', () => {
  const segments = donutSegments([{ label: 'Tek', value: 7 }]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].startAngle, -90);
  assert.equal(segments[0].endAngle, 270);

  const path = donutSlicePath(90, 90, 90, 70, segments[0].startAngle, segments[0].endAngle);
  // Tam tur tek yayla ifade edilemez: iki yarım turla kapatılır ve iç halka
  // ters yönde çizilerek delik oluşur.
  assert.equal((path.match(/A /g) || []).length, 4);
  assert.ok(path.endsWith('Z'));
});

test('halka dilimi yolu ÇİZGİ kalınlığına değil, kapalı alana dayanır', () => {
  // `stroke-dasharray` yerine kapalı yol kullanmak dilimin halkayı aşmasını
  // geometrik olarak imkânsız kılar; vurgu da yalnızca iç yarıçapı değiştirir.
  const path = donutSlicePath(90, 90, 90, 70, -90, 0);
  assert.match(path, /^M /);
  assert.ok(path.endsWith('Z'));
  assert.equal((path.match(/A /g) || []).length, 2);
});

test('boş veri kümesi hiç dilim üretmez', () => {
  assert.deepEqual(donutSegments([]), []);
  assert.deepEqual(donutSegments(null), []);
  assert.deepEqual(donutSegments([{ label: 'A', value: 0 }]), []);
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
  assert.match(view, /const draggable = canEdit && node\.parentId != null && !structuralWritePending;/);
  assert.match(view, /if \(!canEdit \|\| node\.parentId == null \|\| structuralWritePending \|\| dragHandleNodeId !== node\.id\) \{/);
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

test('anlık görüntü yanıtındaki oturum kendi isteğiyle EŞLEŞİK döner', async () => {
  const { createApiRepository } = await import('../src/data/api/createApiRepository.js');
  const { loadApplicationData } = await import('../src/state/persistence.js');
  const requests = [];
  const originalFetch = globalThis.fetch;
  let sequence = 0;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    const id = String(url).includes('/snapshot') ? (sequence += 1) : sequence;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          calendars: [], projects: [], people: [], wbs: [], tasks: [], baselines: [], taskBaselineSnapshots: [],
          session: { dataMode: 'actual', projectAccess: [], requestId: id }
        };
      }
    };
  };

  try {
    const repository = createApiRepository({ basePath: '/test-api' });

    // Oturum, anlık görüntünün SONUCUYLA birlikte taşınır: paylaşılan tek bir
    // yuvada saklansaydı üst üste binen iki yükleme birbirinin oturumunu
    // tüketebilir ve A anlık görüntüsü B'nin proje erişimiyle eşleşebilirdi.
    const [first, second] = await Promise.all([repository.loadSnapshot(), repository.loadSnapshot()]);
    assert.equal(first.session.requestId, 1);
    assert.equal(second.session.requestId, 2);

    // Açılış tek istekle tamamlanır: gömülü oturum için ayrı bir tur yapılmaz.
    requests.length = 0;
    const loaded = await loadApplicationData(repository);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.snapshot.session.dataMode, 'actual');
    assert.deepEqual(requests, ['/test-api/snapshot'], 'açılışta yalnızca tek istek yapılmalıdır');

    // Oturum tazeleme (gömülü bağlam olmadan) yine sunucuya gider.
    requests.length = 0;
    await repository.loadSessionContext();
    assert.deepEqual(requests, ['/test-api/session']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('anlık görüntü ucu oturumu aynı istek içinde ve tek yetkilendirmeyle döndürür', () => {
  const route = read('src/app/api/mergen-rota/snapshot/route.js');
  const repository = read('src/server/repository/projectedSqlAppRepository.js');
  assert.match(route, /const body = await repository\.loadSnapshotWithSession\(\);/);
  assert.match(route, /Response\.json\(body/);
  // Oturum anlık görüntünün YETKİ BAĞLAMINDAN kurulur: kişi/rol/proje erişimi
  // ve görev-atama kapsamı aynı istekte ikinci kez sorgulanmaz.
  assert.match(repository, /const \{ snapshot, auth \} = await readProjectedSnapshot\(\);/);
  assert.match(repository, /session: await baseRepository\.sessionContextFrom\(auth\)/);
  assert.doesNotMatch(repository, /await baseRepository\.loadSessionContext\(\)/);
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
  // Yayılım artık istemcinin gördüğü görev kümesinden TÜRETİLMEZ: eşleme proje
  // yazmasıyla birlikte gönderilir ve kalıcı katmanda canlı satırlara uygulanır.
  assert.deepEqual(result.changes.taskUpserts, []);
  assert.deepEqual(result.changes.projectUpserts[0].tagRenames, [{ from: 'Analiz', to: 'Çözümleme' }]);

  const plan = planProjectTagPropagation({
    storedTags: ['Analiz'],
    nextTags: [{ name: 'Çözümleme', color: 'rose', icon: 'Target' }],
    renames: [{ from: 'Analiz', to: 'Çözümleme' }]
  });
  assert.deepEqual(
    applyProjectTagPropagation(context.tasks, 'p1', plan).map((task) => [task.id, task.keyword]),
    [['t1', 'Çözümleme'], ['t2', 'Başka']],
    'yalnızca yeniden adlandırılan etiketi taşıyan görev güncellenmelidir'
  );
});

test('etiket yayılımı kalıcı katmanda canlı görev satırlarına uygulanır', () => {
  const repository = read('src/server/repository/sqlAppRepository.js');
  // Görev yazmaları proje satırının sürümünü ilerletmez: eşzamanlı bir
  // kullanıcının oluşturduğu görev, istemcinin listesinde bulunmadığı için
  // katalog dışında kalırdı. Bu yüzden eşleme SQL sınırında uygulanır.
  assert.match(repository, /async function propagateProjectTagChanges/);
  assert.match(repository, /UPDATE dbo\.MR_Tasks\s*\n\s*SET Keyword = @to/);
  assert.match(repository, /OUTPUT inserted\.TaskId/);
  assert.match(repository, /propagatedTaskIds\.push\(\.\.\.await propagateProjectTagChanges/);
  // Yayılım görev yazmalarından SONRA çalışır; aksi hâlde istemcinin gönderdiği
  // görevler eskimiş sürüm anahtarıyla çakışırdı.
  assert.ok(
    repository.indexOf('for (const task of changes.taskUpserts) await commitTask')
      < repository.indexOf('propagatedTaskIds.push(...await propagateProjectTagChanges')
  );
});

test('etiket rengi ve simgesi kalıcı kayda kapalı küme olarak yazılır', () => {
  const repository = read('src/server/repository/sqlAppRepository.js');
  const validation = read('src/server/repository/commitProjectWbsValidation.js');
  const schema = read('database/MR_Create_Durable_Persistence.sql');

  assert.match(repository, /INSERT dbo\.MR_ProjectTags\(ProjectId, TagName, ColorToken, IconKey, SortOrder, CreatedBySicil\)/);
  // Eski istemci paketleri kataloğu düz metin olarak geri gönderir; saklanan
  // renk ve simge bu yazmalarda korunur (sürüm geçişinde veri kaybı olmaz).
  assert.match(repository, /const canonical = mergeProjectTagAppearance\(values, stored\);/);
  assert.equal(
    mergeProjectTagAppearance(['Analiz'], [{ name: 'analiz', color: 'rose', icon: 'Target' }])[0].color,
    'rose'
  );
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

test('takvimde bulunmayan yineleme günü RFC 5545 gereği ATLANIR', () => {
  // Kural dışa aktarıldığında başka bir takvim uygulamasıyla aynı seriyi
  // vermelidir: 31 Şubat yoktur, o yineleme sayılmaz ve ayın son gününe
  // çekilmez (çekilseydi saklanan RRULE'ün anlamı sessizce değişirdi).
  assert.deepEqual(
    expandRecurrence({ freq: 'MONTHLY', byMonthDay: 31, count: 4 }, { start: '2026-01-31' }),
    ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']
  );
  // 29 Şubat yalnızca artık yıllarda vardır.
  assert.deepEqual(
    expandRecurrence({ freq: 'YEARLY', count: 2 }, { start: '2028-02-29' }),
    ['2028-02-29', '2032-02-29']
  );
});

test('haftalık kural gün seçilmediğinde başlangıç gününü kullanır', () => {
  // `BYDAY` yokken kural her güne açılıyordu: kullanıcı "Haftalık" seçip henüz
  // gün işaretlemediğinde seri günlüğe dönüşüyordu.
  assert.deepEqual(
    expandRecurrence({ freq: 'WEEKLY', count: 3 }, { start: '2026-08-18' }),
    ['2026-08-18', '2026-08-25', '2026-09-01']
  );
  // Büyük INTERVAL değerlerinde tarama bütçesi yineleme sayısıyla orantılıdır.
  assert.equal(
    expandRecurrence({ freq: 'WEEKLY', interval: 99, byWeekday: ['MO'], count: 5 }, { start: '2026-08-17' }).length,
    5
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
  // `plannedDurationDays` DAHİL iş günü sayısıdır: Pzt→Sal iki iş günüdür.
  const template = {
    plannedStart: '2026-08-17',
    plannedFinish: '2026-08-18',
    targetFinish: '2026-08-19',
    plannedDurationDays: 2
  };
  const plan = planRecurringOccurrences(template, { freq: 'DAILY', count: 3 }, {});
  assert.deepEqual(plan.map((item) => item.plannedStart), ['2026-08-17', '2026-08-18', '2026-08-19']);
  assert.deepEqual(plan.map((item) => item.plannedFinish), ['2026-08-18', '2026-08-19', '2026-08-20']);
  assert.deepEqual(plan.map((item) => item.targetFinish), ['2026-08-19', '2026-08-20', '2026-08-21']);

  // Hafta sonu çalışma günü değildir: Cumartesi'ye düşen yineleme Pazartesi'ye
  // kayar. COUNT kuralın KENDİ yineleme sayısıdır ve kaydırmadan ÖNCE ham
  // yineleme sırasına uygulanır (RFC 5545). Cuma başlayan `COUNT=3` günlük seri
  // Cum/Cmt/Paz yinelemelerini tüketir; Cmt ve Paz aynı Pazartesi'ye kaydığı
  // için ortaya iki görev çıkar. Daha önce kopya elenip döngü kuralın DIŞINDAKİ
  // dördüncü yinelemeyi tüketiyor ve RRULE'da bulunmayan bir gün üretiliyordu.
  const calendar = { workingDays: [1, 2, 3, 4, 5], holidays: [] };
  const shifted = planRecurringOccurrences(
    { ...template, plannedStart: '2026-08-21', plannedFinish: '2026-08-21', targetFinish: null, plannedDurationDays: 1 },
    { freq: 'DAILY', count: 3 },
    { calendar }
  );
  assert.deepEqual(shifted.map((item) => item.plannedStart), ['2026-08-21', '2026-08-24']);
  // Ham yineleme günü seri kimliğidir ve kaydırmadan etkilenmez.
  assert.deepEqual(shifted.map((item) => item.occurrenceDate), ['2026-08-21', '2026-08-22']);
  // Şablonun yönetsel termini yoksa yinelemeye termin UYDURULMAZ.
  assert.deepEqual(shifted.map((item) => item.targetFinish), [null, null]);

  // Planlanan bitişi olmayan şablon yinelemeye de bitiş yazmaz.
  const open = planRecurringOccurrences(
    { plannedStart: '2026-08-17' },
    { freq: 'DAILY', count: 2 },
    {}
  );
  assert.deepEqual(open.map((item) => item.plannedFinish), [null, null]);

  // UNTIL kaydırılmış tarihe uygulanır: sınırın ötesine görev taşmaz.
  const bounded = planRecurringOccurrences(
    { plannedStart: '2026-08-21', plannedDurationDays: 1 },
    { freq: 'DAILY', until: '2026-08-23' },
    { calendar }
  );
  assert.deepEqual(bounded.map((item) => item.plannedStart), ['2026-08-21']);
});

test('planlanan başlangıcı olmayan şablon yineleme üretmez', () => {
  assert.deepEqual(planRecurringOccurrences({ plannedFinish: '2026-08-18' }, { freq: 'DAILY', count: 3 }, {}), []);
});

test('yinelemeler şablona bağlanır, kuralı ve bağımlılıkları kopyalamaz', () => {
  const provider = read('src/state/AppStateProvider.jsx');
  assert.match(provider, /recurrence: null,\s*\n\s*recurrenceParentId: taskId,/);
  assert.match(provider, /deps: \[\]/);
  // Kimlik DEĞİŞMEZDİR: yineleme ertelense bile o gün ikinci kez üretilmez.
  // Kimlik HAM yineleme günüdür; çalışma takvimi planlanan başlangıcı kaydırsa
  // bile şablonun kendi yinelemesi ikinci kez üretilmez.
  assert.match(provider, /recurrenceOccurrenceDate: occurrence\.occurrenceDate,/);
  assert.match(provider, /materialized\.has\(occurrence\.occurrenceDate\)/);
  // Gerçekleşen emek/harcama ve yapay kalan süre yinelemeye taşınmaz.
  assert.match(provider, /actualHours: null,\s*\n\s*spent: null,/);
  assert.match(provider, /remainingDurationDays: null,/);
  assert.doesNotMatch(provider, /remainingDurationDays: created\.plannedDurationDays/);
  // Şablon ve kural, kuyruktaki yazmalar tamamlandıktan SONRA okunur.
  assert.ok(provider.indexOf('const flushResult = await persistence.flush();') < provider.indexOf('const template = current.tasks.find'));
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

  // Kaydedilmemiş düzenleme: kuyrukta bekleyen VE reddedilip saklanan yamalar.
  assert.match(persistence, /hasPendingChanges\(\) \{ return taskPatches\.hasUnsavedChanges\(\); \}/);
  assert.match(persistence, /if \(!result\.ok\) failed\.set\(taskId/);
  assert.match(guard, /window\.addEventListener\('beforeunload', onBeforeUnload\)/);
  assert.match(guard, /window\.addEventListener\('pagehide', flushBeforeTeardown\)/);
  assert.match(guard, /document\.addEventListener\('visibilitychange', flushIfHidden\)/);
  assert.match(guard, /event\.preventDefault\(\);\s*\n\s*event\.returnValue = '';/);
  // Süren yazma da korunur: boşaltma başladığında yama kuyruktan çıkar.
  assert.match(guard, /const isSaving = pendingMutationCount > 0;/);
  // Son yazma sayfa boşaltılırken iptal edilmemelidir.
  assert.match(guard, /flushPendingChanges\(\{ keepalive: true \}\)/);
  assert.match(read('src/data/api/createApiRepository.js'), /async commitChanges\(changes, \{ keepalive = false \} = \{\}\)/);
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
  assert.match(drawer, /if \(String\(value\)\.trim\(\)\) \{[\s\S]*onUpdate\(task\.id, \{ task: value \}\);/);
  assert.match(drawer, /onChange=\{\(e\) => saveTitle\(e\.target\.value\)\}/);
  assert.match(drawer, /Görev başlığı boş bırakılamaz/);
  // Alan boşaldığında kuyrukta bekleyen önceki tuş vuruşu da iptal edilir; aksi
  // hâlde arayüzün "kaydedilmeyecek" dediği ön ek kalıcılaşıyordu.
  assert.match(drawer, /cancelTaskFieldUpdates\(task\.id, \['task'\]\);/);
  assert.match(read('src/state/persistence.js'), /function cancelFields\(taskId, fields = \[\]\)/);
  // Yerel boş başlık taslağı, ilgisiz bir alan düzenlendiğinde gelen yeni görev
  // nesnesiyle geri yazılmaz.
  assert.match(drawer, /if \(titleDraftRef\.current !== null\) next\.task = titleDraftRef\.current;/);

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
