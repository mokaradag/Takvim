import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DATE_RANGE_PRESET,
  describeDateRange,
  filterTasksByDateRange,
  resolveDateRangePreset,
  resolveDateRangeSelection,
  taskActivityWindow,
  taskMatchesDateRange
} from '../src/features/shared/dateRangeFilter.js';

const REFERENCE = '2026-09-03';

test('varsayılan ön ayar süzgeç uygulamaz', () => {
  assert.equal(DEFAULT_DATE_RANGE_PRESET, 'all');
  assert.equal(resolveDateRangeSelection({ preset: 'all' }, REFERENCE), null);
  assert.equal(describeDateRange(null), 'Tüm zamanlar');
});

test('ön ayarlar referans güne göre çözülür', () => {
  // Son 30 gün BUGÜNÜ de kapsar: 29 gün geriye gidilir.
  assert.deepEqual(resolveDateRangePreset('last30', REFERENCE), { start: '2026-08-05', end: '2026-09-03' });
  assert.deepEqual(resolveDateRangePreset('last90', REFERENCE), { start: '2026-06-06', end: '2026-09-03' });
  assert.deepEqual(resolveDateRangePreset('thisYear', REFERENCE), { start: '2026-01-01', end: '2026-12-31' });
  assert.equal(resolveDateRangePreset('all', REFERENCE), null);
});

test('görev penceresi en erken ve en geç tarihten türetilir', () => {
  assert.deepEqual(
    taskActivityWindow({ plannedStart: '2026-03-02', plannedFinish: '2026-03-10', targetFinish: '2026-03-15' }),
    { start: '2026-03-02', end: '2026-03-15' }
  );
  // Yalnızca hedefi olan görev de bir pencere taşır.
  assert.deepEqual(taskActivityWindow({ targetFinish: '2026-04-01' }), { start: '2026-04-01', end: '2026-04-01' });
  // Hiç tarihi olmayan görev penceresizdir.
  assert.equal(taskActivityWindow({ task: 'Tarihsiz' }), null);
  // Çözümlenemeyen değerler yok sayılır.
  assert.equal(taskActivityWindow({ plannedStart: 'invalid' }), null);
});

test('aralık KESİŞİME göre eşleşir; sınırlar dahildir', () => {
  const range = { start: '2026-03-01', end: '2026-03-31' };
  // Aralığı tamamen kapsayan görev de sayılır.
  assert.equal(taskMatchesDateRange({ plannedStart: '2026-01-01', plannedFinish: '2026-12-31' }, range), true);
  // Bitişi tam aralık başlangıcına denk gelen görev dahildir.
  assert.equal(taskMatchesDateRange({ plannedStart: '2026-02-01', plannedFinish: '2026-03-01' }, range), true);
  // Başlangıcı tam aralık bitişine denk gelen görev dahildir.
  assert.equal(taskMatchesDateRange({ plannedStart: '2026-03-31', plannedFinish: '2026-05-01' }, range), true);
  // Tamamen dışarıdaki görevler elenir.
  assert.equal(taskMatchesDateRange({ plannedStart: '2026-01-01', plannedFinish: '2026-02-28' }, range), false);
  assert.equal(taskMatchesDateRange({ plannedStart: '2026-04-01', plannedFinish: '2026-04-10' }, range), false);
});

test('tarihsiz görev hiçbir aralıkta KAYBOLMAZ', () => {
  // Tarihsiz bir kayıt sessizce elenseydi toplamlar açıklanamaz biçimde düşerdi.
  const undated = { id: 'u1', task: 'Tarihsiz' };
  assert.equal(taskMatchesDateRange(undated, { start: '2026-03-01', end: '2026-03-31' }), true);
  assert.deepEqual(filterTasksByDateRange([undated], { start: '2026-03-01', end: '2026-03-31' }), [undated]);
});

test('TAŞAN takvim günü özel aralıkta kabul edilmez', () => {
  // `parseDate('2026-02-30')` hata vermez, 2 Mart'a taşar ve sonlu bir zaman
  // damgası taşır. Yalnızca `getTime()` denetlenseydi bu aralık uygulanır ve
  // normalleşmiş başlangıcı bitişinden SONRA olurdu.
  assert.equal(resolveDateRangeSelection({ preset: 'custom', start: '2026-02-30', end: '2026-03-01' }, REFERENCE), null);
  assert.equal(resolveDateRangeSelection({ preset: 'custom', start: '2026-03-01', end: '2026-13-01' }, REFERENCE), null);
  // Gerçek bir 29 Şubat (artık yıl) kabul edilmeye devam eder.
  assert.deepEqual(
    resolveDateRangeSelection({ preset: 'custom', start: '2028-02-29', end: '2028-03-01' }, REFERENCE),
    { start: '2028-02-29', end: '2028-03-01' }
  );
});

test('yarım bırakılmış özel aralık süzmez', () => {
  // Kullanıcı ikinci tarihi girerken tablo bir anlığına boşalmamalıdır.
  assert.equal(resolveDateRangeSelection({ preset: 'custom', start: '2026-03-01', end: '' }, REFERENCE), null);
  assert.equal(resolveDateRangeSelection({ preset: 'custom', start: '', end: '2026-03-31' }, REFERENCE), null);
  // Ters sıralı aralık da uygulanmaz.
  assert.equal(
    resolveDateRangeSelection({ preset: 'custom', start: '2026-04-01', end: '2026-03-01' }, REFERENCE),
    null
  );
  assert.deepEqual(
    resolveDateRangeSelection({ preset: 'custom', start: '2026-03-01', end: '2026-03-31' }, REFERENCE),
    { start: '2026-03-01', end: '2026-03-31' }
  );
});

test('süzgeç listeyi gerçekten daraltır', () => {
  const tasks = [
    { id: 'a', plannedStart: '2026-08-10', plannedFinish: '2026-08-20' },
    { id: 'b', plannedStart: '2026-01-05', plannedFinish: '2026-01-09' },
    { id: 'c', targetFinish: '2026-09-01' }
  ];
  const range = resolveDateRangeSelection({ preset: 'last30' }, REFERENCE);
  assert.deepEqual(filterTasksByDateRange(tasks, range).map((t) => t.id), ['a', 'c']);
  // Süzgeç yokken liste olduğu gibi döner.
  assert.equal(filterTasksByDateRange(tasks, null).length, 3);
});

test('Özet ve Raporlar aynı süzgeci ölçümlerin ÖNÜNDE uygular', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  for (const path of ['src/features/dashboard/DashboardView.jsx', 'src/features/reports/ReportsView.jsx']) {
    const source = read(path);
    // Ham liste `allTasks`'e alınır ve türetilmiş `tasks` süzülmüş kümedir;
    // aksi hâlde kartların bir kısmı süzgeci yok sayardı.
    assert.match(source, /const allTasks = useTasks\(\);/, path);
    assert.match(source, /filterTasksByDateRange\(allTasks, activeRange\)/, path);
    assert.match(source, /<DateRangeFilter/, path);
  }
});

test('Görevler sütun süzgeci ETKİN seçimi menüde tutar', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/features/tasks/TasksView.jsx', import.meta.url), 'utf8');

  // Seçenekler kurumsal süzgecin sonucundan türetilir; seçim menüde
  // tutulmazsa, süzülen satırlar kaybolduğunda kullanıcı o değeri işaretten
  // çıkaramaz ve tabloyu geri getiremez — sütunu ya da tümünü temizlemeden
  // kurtulunamayan GİZLİ bir süzgeç kalır.
  assert.match(source, /const withSelected = useCallback1\(/);
  for (const [set, selection] of [
    ['facetValues.proje', 'colFilter.proje'],
    ['facetValues.sorumlu', 'colFilter.sorumlu'],
    ['facetValues.status', 'colFilter.status'],
    ['facetValues.priority', 'colFilter.priority'],
    // Etiket listesi de aynı birleşimi uygular.
    ['facetValues.keyword', 'colFilter.keyword']
  ]) {
    assert.match(
      source,
      new RegExp(`withSelected\\(${set.replace('.', '\\.')}, ${selection.replace('.', '\\.')}\\)`),
      `${set} seçili değerlerle birleştirilmelidir`
    );
  }
  // Fasetler ÇAPRAZ süzülür: her sütunun seçenekleri öteki süzgeçlerden geçen
  // satırlardan toplanır.
  assert.match(source, /taskTableFacetValues\(organization\.filteredTasks, \{ search, filters: colFilter, dateMode: 'effective' \}, key\)/);
  // Seçenek listeleri artık HAM görünür kümeyi değil, birleşimi süzer.
  assert.match(source, /\.filter\(p => projectOptionIds\.has\(String\(p\.id\)\)\)/);
  assert.match(source, /\.filter\(p => assigneeOptionIds\.has\(String\(p\.id\)\)\)/);
  assert.match(source, /statusOptionValues\.has\(String\(status\.value\)\)/);
  assert.match(source, /priorityOptionValues\.has\(String\(priority\.id\)\)/);
});

test('tarih seçici paneli açılış BAŞINA bir kez odaklanır', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/components/DateInput.jsx', import.meta.url), 'utf8');

  // `placement` her yakalanan kaydırma/yeniden boyutlandırmada yeniden
  // hesaplanır; koşulsuz odaklama, açık seçicide sayfa kaydırıldığında odağı
  // seçili gün düğmesinden çalıp panel kabına geri sıçratıyordu.
  assert.match(source, /const panelFocusedRef = useRef\(false\);/);
  assert.match(source, /if \(!placement \|\| panelFocusedRef\.current\) return;/);
  // Kapanışta bayrak sıfırlanır, aksi hâlde ikinci açılışta odak hiç girmezdi.
  assert.match(source, /panelFocusedRef\.current = false;/);
});

/* ── Paylaşımlı modal odak tuzağı ────────────────────────────────── */

test('odak tuzağı sınırlarda SARAR ve arada tarayıcıya bırakır', async () => {
  const { resolveFocusTrapTarget } = await import('../src/hooks/useModalFocusTrap.js');

  // Son ögede Tab → ilk ögeye sarar.
  assert.deepEqual(
    resolveFocusTrapTarget({ focusableCount: 3, activeIndex: 2, containsActive: true, shiftKey: false }),
    { target: 'first', preventDefault: true }
  );
  // İlk ögede Shift+Tab → son ögeye sarar.
  assert.deepEqual(
    resolveFocusTrapTarget({ focusableCount: 3, activeIndex: 0, containsActive: true, shiftKey: true }),
    { target: 'last', preventDefault: true }
  );
  // ARADA tarayıcının kendi sırası geçerlidir; olay engellenmez.
  assert.deepEqual(
    resolveFocusTrapTarget({ focusableCount: 3, activeIndex: 1, containsActive: true, shiftKey: false }),
    { target: null, preventDefault: false }
  );
  assert.deepEqual(
    resolveFocusTrapTarget({ focusableCount: 3, activeIndex: 1, containsActive: true, shiftKey: true }),
    { target: null, preventDefault: false }
  );
  // Odak modalın DIŞINDAYSA içeri çekilir; YÖN korunur.
  assert.deepEqual(
    resolveFocusTrapTarget({ focusableCount: 3, activeIndex: -1, containsActive: false, shiftKey: false }),
    { target: 'first', preventDefault: true }
  );
  assert.deepEqual(
    resolveFocusTrapTarget({ focusableCount: 3, activeIndex: -1, containsActive: false, shiftKey: true }),
    { target: 'last', preventDefault: true }
  );
  // Odak modalın İÇİNDE ama listede DEĞİLSE (kabın kendisi, `tabindex="-1"`
  // taşıyan bir başlık) bu da bir sınırdır. Yalnızca `containsActive`
  // denetlenseydi Shift+Tab tarayıcının sırasına düşer ve kullanıcı modaldan
  // çıkardı.
  assert.deepEqual(
    resolveFocusTrapTarget({ focusableCount: 3, activeIndex: -1, containsActive: true, shiftKey: true }),
    { target: 'last', preventDefault: true }
  );
  assert.deepEqual(
    resolveFocusTrapTarget({ focusableCount: 3, activeIndex: -1, containsActive: true, shiftKey: false }),
    { target: 'first', preventDefault: true }
  );
  // Odaklanabilir öge yoksa odak kabın kendisine alınır: aksi hâlde Tab
  // kullanıcıyı modaldan çıkarırdı.
  assert.deepEqual(
    resolveFocusTrapTarget({ focusableCount: 0, activeIndex: -1, containsActive: true, shiftKey: false }),
    { target: 'container', preventDefault: true }
  );
  // TEK odaklanabilir öge her iki yönde de kendine sarar.
  assert.equal(
    resolveFocusTrapTarget({ focusableCount: 1, activeIndex: 0, containsActive: true, shiftKey: false }).target,
    'first'
  );
  assert.equal(
    resolveFocusTrapTarget({ focusableCount: 1, activeIndex: 0, containsActive: true, shiftKey: true }).target,
    'last'
  );
});
