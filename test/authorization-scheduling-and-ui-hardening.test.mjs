/**
 * Tam depo P0–P3 incelemesinin gerileme sınamaları.
 *
 * Her sınama, giderilen bulgunun DAVRANIŞINI sabitler: kod bir sonraki
 * düzenlemede eski hâline dönerse burada kırılır. Sınamalar bulgunun kendi
 * senaryosunu kurar; kaynak metni eşleştiren "şu dizge var mı" denetimleri
 * yalnızca SQL metni gibi başka türlü çalıştırılamayan yerlerde kullanılır.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_CALENDAR,
  MAX_CALENDAR_SPAN_DAYS,
  MAX_WORKING_DAY_SPAN,
  addWorkingDays,
  countWorkingDays,
  normalizeCalendar,
  resolveTaskCalendar
} from '../src/scheduling/calendars/index.js';
import { calculateCpm } from '../src/scheduling/cpm/engine.js';
import { calculatePlannedDurationDays } from '../src/scheduling/plans/index.js';
import {
  MAX_GANTT_RANGE_DAYS,
  calculateTaskDateRange,
  clearGanttDateRangeOverride,
  setGanttDateRangeOverride
} from '../src/scheduling/metrics/index.js';
import { fmtISO } from '../src/scheduling/dates/index.js';
import { sameActualId } from '../src/domain/identity/actualId.js';
import { buildReminderValues } from '../src/domain/reminders/reminderValues.js';
import { normalizeTaskReferences, validateTaskBaselineSnapshot } from '../src/domain/validation/index.js';
import { validateWbsDeletion } from '../src/domain/validation/wbsValidation.js';
import { selectWbsChildren } from '../src/domain/selectors/wbsSelectors.js';
import { selectStatusDistribution } from '../src/features/dashboard/statusDistribution.js';
import { selectOverdueAging } from '../src/features/dashboard/planHealth.js';
import { bucketCalendarTasks } from '../src/features/calendar/calendarTaskBucketing.js';
import { dueTone } from '../src/features/team/upcomingTaskPolicy.js';
import { planSuccessorUpdate } from '../src/features/task-detail/taskSuccessorPolicy.js';
import { computePopoverPlacement } from '../src/components/searchableSelectPlacement.js';
import { safeReturnTo } from '../src/server/identity/keycloakPkce.js';
import { findCommitChangeIssue } from '../src/server/repository/commitChangeValidation.js';
import { findCommitScalarIssue } from '../src/server/repository/commitScalarValidation.js';
import { createTaskPatchCoalescer } from '../src/state/persistence.js';
import { createDataRefreshSingleFlight } from '../src/state/dataRefreshSafety.js';
import { buildPortfolioSchedule } from '../src/state/selectors/scheduleSelectors.js';

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

/* ── Yetkilendirme sınırı ───────────────────────────────────────── */

test('hatırlatma yetkisi kurumsal erişimi YALNIZCA kurumsal projelerde sayar', () => {
  const source = read('src/server/reminders/reminderAccess.js');

  // `MR_V_CorporateProjectAccess` ile `MR_V_CorporateProjects` AYRI kurumsal
  // kaynaklardan beslenir. Kaynak türü süzgeci olmadan, kodu yalnızca HR09'da
  // bulunan bir MANUEL proje, o projeyi hiç göremeyen kişilere hatırlatma
  // gönderme yetkisi (ve görev varlığı bilgisi) veriyordu.
  const clause = /MR_V_CorporateProjectAccess a\s+WHERE p\.SourceType = 'CORPORATE'/;
  assert.match(source, clause);

  // Görevi oluşturan kullanıcı anlık görüntüde görevi GÖRÜR; hatırlatma
  // yükleminde eksikti ve kendi görevi için FORBIDDEN alıyordu.
  assert.match(source, /OR t\.CreatedBySicil = @sicil/);
});

test('kurumsal erişim yüklemi her sunucu sorgusunda kaynak türü süzgecini taşır', () => {
  // Sözleşme sınaması: aynı yüklem on bir yerde tekrarlanıyor ve bir tanesinin
  // sürüklenmesi tam olarak yukarıdaki bulguya yol açmıştı.
  const files = [
    'src/server/reminders/reminderAccess.js',
    'src/server/repository/projectedSqlAppRepository.js',
    'src/server/repository/sqlAppRepository.js',
    'src/server/authorization/loadAuthorizationContext.js',
    'src/server/schedule-change/scheduleChangeStore.js'
  ];
  for (const file of files) {
    const source = read(file);
    const references = source.split('MR_V_CorporateProjectAccess').length - 1;
    if (!references) continue;
    const guarded = source.split(/MR_V_CorporateProjectAccess[\s\S]{0,200}?SourceType = 'CORPORATE'/).length - 1;
    assert.equal(
      guarded,
      references,
      `${file}: her MR_V_CorporateProjectAccess kullanımı SourceType = 'CORPORATE' ile sınırlanmalıdır`
    );
  }
});

test('otomatik hatırlatma yüklemesi etkin olmayan projeyi dışarıda bırakır', () => {
  // Aday seçimi `p.IsActive = 1` uygular; gönderim öncesi yeniden yükleme de
  // aynı kuralı uygulamazsa, aday listesi ile gönderim arasında devre dışı
  // bırakılan projenin sorumlularına yine posta gidiyordu.
  // Tarama SABİTİN KENDİ şablon değişmezinde sınırlanır (`[^`]*`). Açgözlü
  // `[\s\S]*` dosyanın geri kalanını tarıyordu: `REMINDER_TASK_SQL` yüklemi
  // kaybolsa bile DAHA SONRAKİ bir sabitteki aynı `JOIN` eşleşiyor ve test
  // yeşil kalıyordu.
  assert.match(
    read('src/server/reminders/reminderQueries.js'),
    /REMINDER_TASK_SQL[^`]*`[^`]*JOIN dbo\.MR_Projects p ON p\.ProjectId = t\.ProjectId AND p\.IsActive = 1/
  );
});

test('elle hatırlatma hakkı TEK deyimde sahiplenilir', () => {
  const source = read('src/server/reminders/reminderQueries.js');
  // Ayrı `SELECT` + koşulsuz `INSERT`, aynı kullanıcının eşzamanlı iki isteğinin
  // de en küçük aralığı geçmesine izin veriyordu.
  // Desenler ilgili sabitin kendi şablon değişmezinde sınırlanır; açgözlü
  // tarama başka bir sabitteki cümleyle eşleşebilirdi.
  assert.match(source, /INSERT dbo\.MR_TaskReminderLog[^`]*SELECT @taskId[^`]*WHERE @intervalStart IS NULL[^`]*NOT EXISTS/);
  // Başarısız gönderim aralığı TUTMAZ.
  assert.match(source, /REMINDER_LAST_MANUAL_SQL[^`]*`[^`]*AND Status <> 'FAILED'/);
});

test('yapılandırma upsert’i eşzamanlı ilk kayıtta birincil anahtar ihlali üretmez', () => {
  assert.match(
    read('src/server/reminders/reminderQueries.js'),
    // Tarama şablon değişmezinin İÇİNDE kalır. `[\s\S]*?` sabit sınırını
    // aşabildiği için `SELECT 1,` ve `WHERE NOT EXISTS` başka bir SQL
    // sabitinden eşleşebiliyor, koruma kaybolsa bile sınama yeşil kalıyordu.
    /INSERT dbo\.MR_ReminderSettings\([^`]*?\)\s*SELECT 1,[^`]*?WHERE NOT EXISTS/
  );
});

test('giriş dönüş adresi denetim karakterlerini reddeder', () => {
  assert.equal(safeReturnTo('/gorevler'), '/gorevler');
  // Sekme/yeni satır, URL çözümleyicilerinde atılıp `//evil.example` DIŞ
  // otoritesine dönüşebiliyordu.
  assert.equal(safeReturnTo('/\t/evil.example'), '/');
  assert.equal(safeReturnTo('/%09/evil.example'), '/');
  assert.equal(safeReturnTo('/%2F/evil.example'), '/');
  assert.equal(safeReturnTo('//evil.example'), '/');
  assert.equal(safeReturnTo('/\\evil.example'), '/');
});

/* ── Değişiklik kümesi sınırı ───────────────────────────────────── */

test('sınırsız değişiklik kümesi işlem açılmadan reddedilir', () => {
  const many = (count) => Array.from({ length: count }, (unused, index) => ({
    id: `1a2b3c4d-0000-4000-8000-${String(index).padStart(12, '0')}`,
    projectId: '1a2b3c4d-0000-4000-8000-ffffffffffff',
    task: 'Görev',
    type: 'FS'
  }));

  assert.equal(findCommitChangeIssue({ taskUpserts: many(10) }), null);

  const oversized = findCommitChangeIssue({ taskUpserts: many(1001) });
  assert.equal(oversized?.code, 'CHANGE_COLLECTION_TOO_LARGE');
  assert.equal(oversized?.path, 'taskUpserts');

  const total = findCommitChangeIssue({
    taskUpserts: many(1000),
    wbsUpserts: many(1000),
    projectUpserts: many(1000)
  });
  assert.equal(total?.code, 'CHANGE_SET_TOO_LARGE');
});

test('iç içe SORUMLU listesi de kardinalite bütçesine girer', () => {
  // `deps` ile aynı açık: `assigneeIds` sınırsızdı ve `ensurePeople` her sicil
  // için SERIALIZABLE işlemin İÇİNDE ayrı bir dizin sorgusu açar. Tek bir
  // geçerli görev, 8 MiB gövdeye sığan yüz binlerce sicille üst düzey
  // kardinalite savunmasını atlayabiliyordu.
  const task = (assigneeCount) => ({
    id: '1a2b3c4d-0000-4000-8000-000000000001',
    projectId: '1a2b3c4d-0000-4000-8000-ffffffffffff',
    task: 'Görev',
    assigneeIds: Array.from({ length: assigneeCount }, (unused, index) => 900001 + index)
  });

  assert.equal(findCommitChangeIssue({ taskUpserts: [task(50)] }), null);

  const perTask = findCommitChangeIssue({ taskUpserts: [task(201)] });
  assert.equal(perTask?.code, 'TASK_ASSIGNEES_TOO_LARGE');
  assert.equal(perTask?.path, 'taskUpserts[0].assigneeIds');

  // Görev başına sınırın altında kalan ama TOPLAMDA bütçeyi aşan küme.
  const many = Array.from({ length: 30 }, (unused, index) => ({
    ...task(200),
    id: `1a2b3c4d-0000-4000-8000-${String(index).padStart(12, '0')}`
  }));
  assert.equal(findCommitChangeIssue({ taskUpserts: many })?.code, 'CHANGE_SET_ASSIGNEES_TOO_LARGE');
});

test('proje ETİKET kataloğu da kardinalite bütçesine girer', () => {
  // `reconcileProjectTags` kataloğu silip kanonik etiket başına ayrı bir ekleme
  // sorgusu açar — hepsi SERIALIZABLE commit işleminin içinde. Sınırsız bir
  // katalog, `deps`/`assigneeIds` ile aynı amplifikasyon yoluydu.
  const project = (field, count) => ({
    id: '1a2b3c4d-0000-4000-8000-ffffffffffff',
    name: 'Proje',
    calendarId: '1a2b3c4d-0000-4000-8000-eeeeeeeeeeee',
    [field]: Array.from({ length: count }, (unused, index) => `etiket-${index}`)
  });

  // Olağan boyutlu katalog etiket sınırına HİÇ takılmaz. (Kayıt başka
  // alanlarda eksik olabilir; burada sınanan yalnızca kardinalite kuralıdır.)
  const small = findCommitChangeIssue({ projectUpserts: [project('tags', 40)] });
  assert.equal(small?.code === 'PROJECT_TAGS_TOO_LARGE', false);
  assert.equal(small?.code === 'CHANGE_SET_TAGS_TOO_LARGE', false);

  for (const field of ['tags', 'tagRenames']) {
    const oversized = findCommitChangeIssue({ projectUpserts: [project(field, 501)] });
    assert.equal(oversized?.code, 'PROJECT_TAGS_TOO_LARGE', field);
    assert.equal(oversized?.path, `projectUpserts[0].${field}`);
  }

  // Proje başına sınırın altında kalıp TOPLAMDA bütçeyi aşan küme.
  const many = Array.from({ length: 12 }, (unused, index) => ({
    ...project('tags', 500),
    id: `1a2b3c4d-0000-4000-8000-${String(index).padStart(12, '0')}`
  }));
  assert.equal(findCommitChangeIssue({ projectUpserts: many })?.code, 'CHANGE_SET_TAGS_TOO_LARGE');
});

test('commit ucu gövde boyutunu işlemden ÖNCE sınırlar', async () => {
  // Kaynak denetimi tek başına YETMEZ: tanımlayıcı dosyada dursa da sınır hiç
  // uygulanmıyor, okuyucu bayt saymıyor ya da 413 dalı erişilemez olabilirdi.
  // Bu yüzden ucun kendisi çağrılır.
  const { registerServerOnlyShim } = await import('./helpers/serverOnlyShim.mjs');
  registerServerOnlyShim();
  const { POST } = await import('../src/app/api/mergen-rota/commit/route.js');

  // `content-length` BAŞLIĞI YOK: sınırı yalnızca akış sırasında sayılan
  // baytlar uygulayabilir. Başlığa güvenen bir denetim burada hiç çalışmazdı.
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  let remaining = 12;
  const body = new ReadableStream({
    pull(controller) {
      if (remaining <= 0) return controller.close();
      remaining -= 1;
      controller.enqueue(chunk);
    }
  });
  const response = await POST(new Request('http://localhost/api/mergen-rota/commit', {
    method: 'POST',
    body,
    duplex: 'half'
  }));
  assert.equal(response.status, 413);
  const payload = await response.json();
  assert.equal(payload?.error?.details?.code, 'CHANGE_SET_BODY_TOO_LARGE');
  // Akış sınır aşılır aşılmaz iptal edilir: bütün gövde belleğe alınmaz.
  assert.ok(remaining > 0, 'okuma sınırda durmalı, gövdenin tamamı tüketilmemelidir');
});

/* ── Zamanlama ufku ─────────────────────────────────────────────── */

test('uzun ama geçerli bir gecikme SESSİZCE sıfırlanmaz', () => {
  // Sabit tarama sınırı, yaklaşık 2595 iş gününü aşan her aramayı giriş
  // tarihine düşürüyordu: 4000 iş günü eklemek ile HİÇ eklememek aynı sonucu
  // veriyordu.
  const origin = '2026-01-01';
  const moved = addWorkingDays(origin, 4000, DEFAULT_CALENDAR);
  assert.ok(moved instanceof Date);
  assert.ok(fmtISO(moved) > '2041-01-01', `4000 iş günü ileri taşınmalıydı, sonuç: ${fmtISO(moved)}`);

  // Ufku aşan istek KIRPILMAZ, bildirilir.
  assert.equal(addWorkingDays(origin, MAX_WORKING_DAY_SPAN + 1, DEFAULT_CALENDAR), null);
});

test('yirmi yıllık aralık kesilmiş bir iş günü sayısı üretmez', () => {
  const counted = countWorkingDays('2026-01-01', '2046-01-01', DEFAULT_CALENDAR);
  assert.ok(counted > 5000, `yirmi yılda 5000'den fazla iş günü olmalı, sayım: ${counted}`);
});

test('ufku aşan süre planlanan süre olarak YAZILMAZ', () => {
  const beyondHorizon = calculatePlannedDurationDays({
    plannedStart: '2026-01-01',
    plannedFinish: `${2026 + Math.ceil(MAX_CALENDAR_SPAN_DAYS / 365) + 5}-01-01`
  });
  assert.equal(beyondHorizon, null);
});

test('CPM ufku aşan süreyi geçersiz plan olarak bildirir', () => {
  assert.throws(
    () => calculateCpm([
      { id: 'A', plannedStart: '2026-01-01', plannedFinish: '2026-01-02', plannedDurationDays: MAX_WORKING_DAY_SPAN + 10 }
    ], { projectStart: '2026-01-01' }),
    (error) => error.code === 'SCHEDULE_HORIZON_EXCEEDED'
  );
});

test('FS bağı BELGELENEN en büyük gecikmeyi CPM içinde de kullanabilir', () => {
  // Yazma sınırı `MAX_WORKING_DAY_SPAN` gecikmeyi kabul eder. Geri geçiş
  // ilişkinin bir günlük kaymasını gecikmeye EKLEYİP tek çağrıda isteyince
  // büyüklük ufku bir gün aşıyor, `addWorkingDays` `null` dönüyor ve sınır
  // değeri yalnızca FS bağlarında, yalnızca yeniden hesaplamada
  // `SCHEDULE_HORIZON_EXCEEDED` ile patlıyordu. İleri geçiş iki adımı zaten
  // ayırdığı için gerileme yalnızca geri geçişte görünüyordu.
  const schedule = calculateCpm([
    { id: 'A', plannedStart: '2026-01-01', plannedFinish: '2026-01-02', plannedDurationDays: 2 },
    {
      id: 'B',
      plannedStart: '2026-01-05',
      plannedFinish: '2026-01-06',
      plannedDurationDays: 2,
      deps: [{ predecessorId: 'A', type: 'FS', lagDays: MAX_WORKING_DAY_SPAN }]
    }
  ], { projectStart: '2026-01-01' });

  assert.ok(schedule.tasks.A, 'öncül zamanlanmalıdır');
  assert.ok(schedule.tasks.B, 'ardıl zamanlanmalıdır');
  // Bir FAZLASI hâlâ ufkun dışındadır: sınır gevşetilmedi, doğru yerde uygulanıyor.
  assert.throws(
    () => calculateCpm([
      { id: 'A', plannedStart: '2026-01-01', plannedFinish: '2026-01-02', plannedDurationDays: 2 },
      {
        id: 'B',
        plannedStart: '2026-01-05',
        plannedFinish: '2026-01-06',
        plannedDurationDays: 2,
        deps: [{ predecessorId: 'A', type: 'FS', lagDays: MAX_WORKING_DAY_SPAN + 1 }]
      }
    ], { projectStart: '2026-01-01' }),
    (error) => error.code === 'SCHEDULE_HORIZON_EXCEEDED'
  );
});

test('tarih talebi KABULÜ de zamanlama ufkunu uygular', () => {
  // Olağan görev yazmalarında sınır `commitScalarValidation` içinde uygulanır.
  // Kabul yolu süreyi kendisi hesaplayıp doğrudan yazdığı için denetimi
  // tümüyle atlıyor, KABUL EDİLMİŞ bir talep CPM'in zamanlayamayacağı bir süre
  // kalıcılaştırabiliyordu.
  const source = read('src/server/schedule-change/scheduleChangeStore.js');
  assert.match(source, /import \{ MAX_WORKING_DAY_SPAN \} from '\.\.\/\.\.\/scheduling\/calendars\/index\.js';/);
  // Takvim tavanını aşan aralıkta süre `null` döner; bu da yazılmamalıdır.
  assert.match(source, /plannedDurationDays == null \|\| !Number\.isFinite\(plannedDurationDays\)/);
  assert.match(source, /plannedDurationDays < 0 \|\| plannedDurationDays > MAX_WORKING_DAY_SPAN/);
  // Denetim YAZMADAN ÖNCE gelir.
  const guardIndex = source.indexOf('MAX_WORKING_DAY_SPAN)');
  const updateIndex = source.indexOf("update.input('plannedDuration'");
  assert.ok(guardIndex > 0 && updateIndex > guardIndex, 'denetim güncelleme bağlamasından önce olmalıdır');
});

test('Gantt çubukları SINIRLANMIŞ eksene kırpılır', () => {
  // Aralık üst sınıra dayandığında gün başlığı kırpılır; çubuklar ham
  // tarihlerden ölçülürse kaydırılabilir içerik başlığın ötesine taşar ve
  // denetimlerin "görünüm kısaltıldı" bildirimiyle çelişir.
  const source = read('src/features/gantt/GanttView.jsx');
  assert.match(source, /const axisWidth = days\.length \* zoom;/);
  assert.match(source, /const clampBar = \(startValue, finishValue\) => \{/);
  assert.match(source, /Math\.max\(0, Math\.min\(rawX, axisWidth\)\)/);
  assert.match(source, /Math\.max\(x, Math\.min\(rawEnd, axisWidth\)\)/);
  // Hem görev hem GRUP ÖZET çubuğu kırpılır; ham geometri kalmamalıdır.
  assert.match(source, /const \{ x, w \} = clampBar\(t\.plannedStart, t\.plannedFinish\);/);
  assert.match(source, /left: clampBar\(s\.start, s\.end\)\.x/);
  assert.doesNotMatch(source, /width: Math\.max\(8, \(diffDays\(s\.end, s\.start\) \+ 1\) \* zoom\)/);
});

test('yazma sınırı ufku aşan gecikmeyi birim çevrimiyle birlikte reddeder', () => {
  const issue = findCommitScalarIssue({
    taskUpserts: [{
      id: '1a2b3c4d-0000-4000-8000-000000000001',
      task: 'Görev',
      deps: [{ predecessorId: '1a2b3c4d-0000-4000-8000-000000000002', type: 'FS', lagValue: 5000, lagUnit: 'month' }]
    }]
  });
  // 5000 "ay" tek başına küçük görünür ama 100 000 iş gününe karşılık gelir.
  assert.equal(issue?.code, 'DEPENDENCY_LAG_INVALID');

  assert.equal(findCommitScalarIssue({
    taskUpserts: [{
      id: '1a2b3c4d-0000-4000-8000-000000000001',
      task: 'Görev',
      deps: [{ predecessorId: '1a2b3c4d-0000-4000-8000-000000000002', type: 'FS', lagValue: 2, lagUnit: 'month' }]
    }]
  }), null);
});

test('görev takvimi PROJE KİMLİĞİNİ ad yedeğinden önce çözer', () => {
  const projects = [
    { id: 'p-first', name: 'Alfa Programı', calendarId: 'cal-5' },
    { id: 'p-second', name: 'Alfa Programı', calendarId: 'cal-7' }
  ];
  const calendars = [
    { id: 'cal-5', name: '5 gün', workingDays: [1, 2, 3, 4, 5], holidays: [] },
    { id: 'cal-7', name: '7 gün', workingDays: [0, 1, 2, 3, 4, 5, 6], holidays: [] }
  ];
  // `find(item => item.id === projectId || item.name === proje)` ilk KOŞULU
  // sağlayan ögeyi döndürüyordu: aynı adlı önceki proje, görevin geçerli
  // kimliğini yeniyor ve görev BAŞKA projenin takvimiyle planlanıyordu.
  const resolved = resolveTaskCalendar(
    { projectId: 'p-second', proje: 'Alfa Programı' },
    projects,
    calendars
  );
  assert.equal(resolved.id, 'cal-7');

  // Kimlik çözülemediğinde ad yedeği yine çalışır.
  assert.equal(
    resolveTaskCalendar({ projectId: null, proje: 'Alfa Programı' }, [projects[0]], calendars).id,
    'cal-5'
  );
});

test('normalizeCalendar açıkça verilen null değeri varsayılana düşürür', () => {
  assert.equal(normalizeCalendar(null).id, DEFAULT_CALENDAR.id);
});

test('belirsiz proje adı görevi rastgele bir projeye bağlamaz', () => {
  const context = {
    projects: [
      { id: 'p1', name: 'Alfa', color: 'blue' },
      { id: 'p2', name: 'Alfa', color: 'blue' }
    ],
    people: [],
    wbs: []
  };
  // Ad belirsizse kimlik ya da kod gerekir; dizi sırası karar veremez.
  const normalized = normalizeTaskReferences({ proje: 'Alfa', task: 'Görev' }, context);
  assert.equal(normalized.projectId, null);
});

/* ── Gantt görünüm durumu ───────────────────────────────────────── */

test('otomatik yenileme Gantt grafiğini yeniden kurmaz', () => {
  const source = read('src/features/gantt/WorkspaceGanttView.jsx');
  // Sıfırlama etkisi YALNIZCA proje değişimine bağlıdır; `autoStart`/`autoEnd`
  // bağımlılığı, bir iş arkadaşının tarih düzenlemesiyle `chartKey` değiştirip
  // yakınlaştırma, süzgeç, sıralama, açık dallar ve özel aralığı siliyordu.
  assert.match(source, /setRangeRevision\(\(value\) => value \+ 1\);[\s\S]*?\}, \[workspace\.selectedProjectId\]\);/);
  assert.match(source, /if \(rangeMode !== 'auto'\) return;[\s\S]*?\}, \[autoStart, autoEnd, rangeMode\]\);/);
});

test('WBS Gantt kullanıcının kapattığı dalları yenilemede geri açmaz', () => {
  const source = read('src/features/gantt/WbsGanttView.jsx');
  // Yalnızca `seenWbsIdsRef` dizgesinin varlığını aramak yetmez: ikinci etki
  // her `wbs` değişiminde BÜTÜN düğümleri yeniden eklese bile o dizge dosyada
  // bulunur ve test yeşil kalırdı. Asıl güvence, YALNIZCA daha önce görülmemiş
  // kimliklerin açılmasıdır.
  assert.match(
    source,
    /const newIds = wbs\.map\(\(node\) => node\.id\)\.filter\(\(id\) => !seenWbsIdsRef\.current\.has\(id\)\);/
  );
  // Ref güncellemesi durum güncelleyicisinin DIŞINDA kalır: React güncelleyiciyi
  // yeniden oynatırsa içeride yapılan mutasyon yeni düğümleri yutardı.
  assert.match(source, /for \(const id of newIds\) seenWbsIdsRef\.current\.add\(id\);\s*\n\s*setExpanded\(/);
  // Yeni düğüm etkisi `wbs` değişimini izler; sıfırlama etkisi ise yalnızca
  // seçili projeyi.
  assert.match(source, /\}, \[wbs\]\);/);
  assert.match(source, /\}, \[workspace\.selectedProjectId\]\);/);
});

test('gün ekseni uçuk tarihlerde sınırlanır ve durumu bildirir', () => {
  const range = calculateTaskDateRange([
    { plannedStart: '2026-01-01', plannedFinish: '2026-01-10' },
    // Yanlış yazılmış TEK bir yıl on binlerce gün üretiyordu.
    { plannedStart: '2026-01-01', plannedFinish: '2926-01-01' }
  ]);
  const spanDays = Math.round((range.end.getTime() - range.start.getTime()) / 86400000);
  assert.ok(spanDays <= MAX_GANTT_RANGE_DAYS, `aralık sınırlanmalıydı: ${spanDays}`);
  assert.equal(range.truncated, true);

  assert.equal(calculateTaskDateRange([
    { plannedStart: '2026-01-01', plannedFinish: '2026-01-10' }
  ]).truncated, false);
});

test('özel aralık kırpıldığında UYGULANAN aralık geri bildirilir', () => {
  try {
    const applied = setGanttDateRangeOverride({ start: '2026-01-01', end: '2426-01-01' });
    // Kırpma bildirilmezse görünüm kullanıcının yazdığı tarihleri göstermeye
    // devam ederken grafik yalnızca kırpılmış bölümü çizerdi: kullanıcı
    // görmediği bir aralığa güvenip dışarıda kalan görevleri kaçırırdı.
    assert.equal(applied.truncated, true);
    const spanDays = Math.round((applied.end.getTime() - applied.start.getTime()) / 86400000);
    // Aralık İKİ UÇU DA kapsar: kapsanan gün sayısı `span + 1`'dir. Bitiş
    // `start + MAX` yapılsaydı eksen MAX_GANTT_RANGE_DAYS + 1 gün çizer, yani
    // sınırın kendisi bir gün aşılırdı.
    assert.equal(spanDays, MAX_GANTT_RANGE_DAYS - 1);
    const inclusiveDays = spanDays + 1;
    assert.equal(inclusiveDays, MAX_GANTT_RANGE_DAYS);

    const withinBound = setGanttDateRangeOverride({ start: '2026-01-01', end: '2026-06-30' });
    assert.equal(withinBound.truncated, false);
    assert.equal(fmtISO(withinBound.end), '2026-06-30');
  } finally {
    clearGanttDateRangeOverride();
  }
});

test('Gantt görünümü uygulanan aralığı denetimlere geri yazar', () => {
  const source = read('src/features/gantt/WorkspaceGanttView.jsx');
  // Dönen aralık yok sayılırsa özet ve tarih kutuları tam aralığın etkin
  // olduğunu söylerken grafik kırpılmış hâlde çizilirdi.
  assert.match(source, /const applied = setGanttDateRangeOverride\(\{ start: rangeStart, end: rangeEnd \}\);/);
  assert.match(source, /setRangeStart\(fmtISO\(applied\.start\)\);\s*setRangeEnd\(fmtISO\(applied\.end\)\);/);
  assert.match(source, /setRangeError\(applied\?\.truncated/);
  // Otomatik kırpma uyarısı yalnızca otomatik kipte gösterilir.
  assert.match(source, /rangeMode === 'auto' && automaticRange\.truncated/);
});

/* ── Kalıcılık kuyruğu ──────────────────────────────────────────── */

test('uçuştaki yamada iptal edilen alan başarısızlıkta SAKLANMAZ', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // Yazıcının GERÇEKTEN girdiğini bildiren söz; sabit bir gecikmeyle beklemek
  // yavaş bir çalıştırıcıda yanlış yere kırılan kırılgan bir sınama üretirdi.
  let entered;
  const writerEntered = new Promise((resolve) => { entered = resolve; });
  const calls = [];
  const coalescer = createTaskPatchCoalescer(async (taskId, patch) => {
    calls.push({ taskId, patch });
    entered();
    await gate;
    return { ok: false, error: { kind: 'persistence', code: 'CONFLICT', message: 'çakışma' } };
  }, { delayMs: 0 });

  const scheduled = coalescer.schedule('T', { task: 'Merhaba' });
  await writerEntered;
  assert.equal(calls.length, 1, 'yama gönderime girmiş olmalı');

  // Kullanıcı istek yoldayken başlığı siler.
  coalescer.cancelFields('T', ['task']);
  release();
  await scheduled;

  // İptal edilen alan saklanmaz: veri yenilemesi bloklanmaz ve "Yeniden dene"
  // silinen başlığı geri yazmaz.
  assert.equal(coalescer.hasFailedChanges(), false);
  await coalescer.retryFailed();
  assert.equal(calls.length, 1, 'iptal edilen alan yeniden gönderilmemelidir');
});

test('farklı seçenek taşıyan yenileme isteği yutulmaz', async () => {
  const singleFlight = createDataRefreshSingleFlight();
  const ran = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const first = singleFlight.run(async () => {
    ran.push('automatic');
    await gate;
    return { ok: true };
  }, { operationKind: 'automatic', requestKey: 'automatic:0:0' });

  // "Yeniden yükle ve kaydedilmemiş değişiklikleri at" seçimi, süren yenilemeyle
  // birleştirilip yutulduğunda hiç çalışmıyordu.
  const second = singleFlight.run(async () => {
    ran.push('discard');
    return { ok: true };
  }, { operationKind: 'manual', queueIfActiveKind: 'automatic', requestKey: 'manual:1:0' });

  release();
  await Promise.all([first, second]);
  assert.deepEqual(ran, ['automatic', 'discard']);
});

test('proje kimlikleri tür farkına rağmen eşleşir', () => {
  const schedule = buildPortfolioSchedule({
    projects: [{ id: 12, name: 'Sayısal kimlik' }],
    tasks: [{ id: 't1', projectId: '12', plannedStart: '2026-01-05', plannedFinish: '2026-01-09' }],
    calendars: []
  });
  // Katı `Map` eşitliği yüzünden projenin BÜTÜN görevleri `UNKNOWN_PROJECT`
  // uyarısına düşüyor ve zamanlama `empty` kalıyordu.
  assert.deepEqual(schedule.warnings.filter((warning) => warning.code === 'UNKNOWN_PROJECT'), []);
  assert.notEqual(schedule.projects[12].status, 'empty');
});

/* ── Alan adı ve doğrulama ──────────────────────────────────────── */

test('yokluk kimlik eşitliği saymaz', () => {
  assert.equal(sameActualId(null, null), false);
  assert.equal(sameActualId('', undefined), false);
  assert.equal(sameActualId('1A2B3C4D-0000-4000-8000-000000000001', '1a2b3c4d-0000-4000-8000-000000000001'), true);
});

test('başlangıç anlık görüntüsü geçersiz tarihi bildirir', () => {
  const issues = validateTaskBaselineSnapshot({ plannedStart: '2026-02-30', plannedFinish: '2026-03-05' });
  assert.ok(issues.some((issue) => issue.code === 'INVALID_BASELINE_START'));
});

test('bilinmeyen WBS düğümünün silinmesi sessiz geçmez', () => {
  const issues = validateWbsDeletion([{ id: 'w1', projectId: 'p1', parentId: null }], [], 'yok-boyle-bir-dugum');
  assert.deepEqual(issues.map((issue) => issue.code), ['WBS_NODE_NOT_FOUND']);
});

test('selectWbsChildren ağaçla AYNI geçerli-ebeveyn kuralını uygular', () => {
  const wbs = [
    { id: 'root', projectId: 'p1', parentId: null, code: '1', name: 'Kök' },
    { id: 'ok', projectId: 'p1', parentId: 'root', code: '1.1', name: 'Geçerli' },
    { id: 'cross', projectId: 'p2', parentId: 'root', code: '1.2', name: 'Başka proje' }
  ];
  assert.deepEqual(selectWbsChildren(wbs, 'root').map((node) => node.id), ['ok']);
});

test('kök sorgusu ÖKSÜZ düğümü de döndürür', () => {
  // Geçerli-ebeveyn kuralı öksüz düğümü `parentId` sorgusundan eler. Kök dalı
  // yalnızca `parentId == null` süzseydi bu düğüm HİÇBİR sorgudan dönmezdi ve
  // ağaçtan tümüyle kaybolurdu — kuralın kapatmayı amaçladığı uyuşmazlığın ta
  // kendisi. Ölçüt `selectWbsRoots` ile aynıdır.
  const wbs = [
    { id: 'root', projectId: 'p1', parentId: null, code: '1', name: 'Kök' },
    { id: 'child', projectId: 'p1', parentId: 'root', code: '1.1', name: 'Çocuk' },
    // Ebeveyni listede YOK.
    { id: 'orphan', projectId: 'p1', parentId: 'missing', code: '2', name: 'Öksüz' },
    // Ebeveyni BAŞKA projede.
    { id: 'crossParent', projectId: 'p1', parentId: 'foreign', code: '3', name: 'Yabancı ebeveyn' },
    { id: 'foreign', projectId: 'p2', parentId: null, code: '9', name: 'Diğer proje' },
    // KENDİNİ ebeveyn gösteriyor.
    { id: 'selfy', projectId: 'p1', parentId: 'selfy', code: '4', name: 'Kendi ebeveyni' }
  ];
  const roots = selectWbsChildren(wbs, null).map((node) => node.id);
  for (const id of ['root', 'orphan', 'crossParent', 'selfy', 'foreign']) {
    assert.ok(roots.includes(id), `${id} kök sorgusundan dönmelidir`);
  }
  assert.equal(roots.includes('child'), false, 'gerçek çocuk kök sayılmamalıdır');
  // Öksüz düğüm kendi `parentId` sorgusundan DÖNMEZ; kök dalı tek kapıdır.
  assert.deepEqual(selectWbsChildren(wbs, 'missing'), []);
});

test('hatırlatma imkânsız takvim gününü reddeder', () => {
  const values = buildReminderValues({ task: 'İş', targetFinish: '2026-02-30', status: 'planned' });
  assert.equal(values.due_date, '');
  assert.equal(values.remaining_days, '');
});

test('kalan gün sayısı sunucunun saat diliminden bağımsızdır', () => {
  // 2026-09-02 00:30 Istanbul = 2026-09-01T21:30Z
  const now = new Date('2026-09-01T21:30:00Z');
  const task = { task: 'İş', targetFinish: '2026-09-02', status: 'planned' };
  // Değerler BEKLENEN sabitlerle karşılaştırılır. İki özdeş çağrıyı birbirine
  // eşitlemek totolojiydi: `buildReminderValues` `timeZone` seçeneğini tamamen
  // yok saysa bile test geçerdi.
  assert.equal(buildReminderValues(task, { now, timeZone: 'Europe/Istanbul' }).remaining_days, '0');
  assert.equal(buildReminderValues(task, { now, timeZone: 'Europe/Istanbul' }).today, '02.09.2026');
  // Farklı bir dilim FARKLI sonuç verir; bu, seçeneğin gerçekten uygulandığını
  // kanıtlar. New York'ta aynı an hâlâ 1 Eylül'dür, termin bir gün ötededir.
  assert.equal(buildReminderValues(task, { now, timeZone: 'America/New_York' }).remaining_days, '1');
  assert.equal(buildReminderValues(task, { now, timeZone: 'America/New_York' }).today, '01.09.2026');
  // GEÇERSİZ dilim varsayılana düşer; `Intl` `RangeError` yükseltip bütün
  // hatırlatma değerlerini düşürmemelidir.
  assert.equal(buildReminderValues(task, { now, timeZone: 'Mars/Olympus' }).remaining_days, '0');
  assert.equal(buildReminderValues(task, { now }).remaining_days, '0');
  assert.equal(buildReminderValues(task, { now }).today, '02.09.2026');
});

/* ── Gösterge paneli ve görünüm ölçütleri ───────────────────────── */

test('durum dağılımı toplamı dilim değerlerinin toplamına eşittir', () => {
  const distribution = selectStatusDistribution([
    { id: 't1', status: 'done' },
    null,
    { id: 't2', status: 'todo' }
  ], new Date(2026, 0, 15));
  const sum = distribution.segments.reduce((total, segment) => total + segment.value, 0);
  assert.equal(distribution.total, sum);
  assert.equal(distribution.total, 2);
});

test('çözülemeyen termin gecikme ölçüsünü NaN yapmaz', () => {
  const aging = selectOverdueAging([
    { id: 't1', status: 'todo', targetFinish: 'çöp' },
    { id: 't2', status: 'todo', targetFinish: '2026-01-01' }
  ], new Date(2026, 0, 15));
  assert.ok(Number.isFinite(aging.worstDays));
  assert.equal(aging.worstDays, 14);
});

test('yaklaşan görev penceresi NaN metni üretmez', () => {
  const tone = dueTone({ targetFinish: 'çöp' }, new Date(2026, 0, 15));
  assert.equal(tone.text, 'Tarih yok');
  assert.equal(tone.days, null);
});

test('takvim kovası saat taşıyan tarihi gün anahtarına indirger', () => {
  const buckets = bucketCalendarTasks([{ id: 't1', targetFinish: '2026-04-02T00:00:00' }]);
  assert.deepEqual(Object.keys(buckets), ['2026-04-02']);
});

test('tarih süzgeci yalnızca ÇÖZÜMLENEBİLİR tarihleri eşleştirir', async () => {
  // Kural artık DAVRANIŞTAN sınanır. Önceden `ui-extras.jsx` düz Node ile
  // içe aktarılamadığı için sınama kaynak metnine bakıyordu; öyle bir sınama
  // kuralı değil yazılışını sabitler ve ilk yeniden düzenlemede kırılır.
  const { dateMatchesFilter } = await import('../src/components/dateMatchesFilter.js');
  const range = { mode: 'range', from: '1900-01-01', to: '2999-12-31' };

  // `parseDate(null)`/`parseDate('')` BUGÜNÜ döndürür: eleme olmasa tarihsiz
  // bir Gantt satırı her aralıktan geçerdi.
  for (const empty of [null, undefined, '', '   ']) {
    assert.equal(dateMatchesFilter(empty, range), false, String(empty));
  }
  // `parseDate(false)` de bugünü döndürür; mantıksal değer tarih değildir.
  assert.equal(dateMatchesFilter(false, range), false);
  assert.equal(dateMatchesFilter(true, range), false);
  assert.equal(dateMatchesFilter(Number.NaN, range), false);
  assert.equal(dateMatchesFilter(Number.POSITIVE_INFINITY, range), false);
  // Çözümlenemeyen metin de elenir.
  assert.equal(dateMatchesFilter('bugün', range), false);

  // `0` da elenir. `parseDate(0)` dönem başlangıcını DEĞİL bugünü döndürür
  // (`!0` doğru olduğu için sayısal dal hiç çalışmaz); `0`'ı "geçerli dönem
  // damgası" sayan bir düzeltme, bozuk kaydı güncel tarihle eşleştirirdi.
  assert.equal(dateMatchesFilter(0, range), false);
  assert.equal(
    dateMatchesFilter(0, { mode: 'preset', preset: 'today' }),
    false,
    '`0` bugünle eşleşmemelidir'
  );

  // Olağan yol bozulmadan çalışır.
  assert.equal(dateMatchesFilter('2026-06-15', { mode: 'range', from: '2026-06-01', to: '2026-06-30' }), true);
  assert.equal(dateMatchesFilter('2026-07-15', { mode: 'range', from: '2026-06-01', to: '2026-06-30' }), false);
  // Süzgeç yoksa her satır geçer.
  assert.equal(dateMatchesFilter(null, null), true);
});

test('dar panelde seçenek listesi sıfır yüksekliğe düşmez', () => {
  // Tetikleyicinin altındaki ve üstündeki boşluk, panel çerçevesi (104 px) artı
  // taban liste yüksekliğinden (96 px) küçük olacak biçimde seçilir.
  const placement = computePopoverPlacement(
    { top: 90, bottom: 130, left: 20, width: 200 },
    { width: 900, height: 260 }
  );
  assert.equal(placement.scrollPanel, true, 'bu düzen panel kaydırma yolunu seçmelidir');
  // `panelMaxHeight - PANEL_CHROME_HEIGHT` sıfır olduğunda liste tümüyle
  // gizleniyor, panel kaydırılsa bile hiçbir seçenek görünmüyordu.
  // Alan BULUNMAMALIDIR. `Number.isFinite(...) === false` denetimi `NaN`
  // değeriyle de geçer; `max-height: NaNpx` ise geçersiz bir bildirimdir ve
  // sınamanın kilitlediğini iddia ettiği çöken liste kusurunun ta kendisidir.
  assert.equal(placement.listMaxHeight ?? null, null);
});

test('eski gecikme değeri birim değişiminde açık alana taşınır', () => {
  const tasks = [
    { id: 'A' },
    { id: 'B', deps: [{ predecessorId: 'A', type: 'FS', lagDays: 1 }] }
  ];
  const toWeek = planSuccessorUpdate({ id: 'A' }, 'B', { lagUnit: 'week' }, tasks);
  const dependency = toWeek.patch.deps[0];
  // Birim değişimi, birimi olmayan eski kaydı açık biçime taşımalıdır: değişiklik
  // ÖNCE birleştirilir ki `materializeDependencyLag` taşımayı yapabilsin.
  // Materyalleştirmeyi önce yapmak `lagValue` alanını hiç yazmaz ve sonraki
  // birim değişimi `lagDays` sayısını gecikme DEĞERİ sanardı (1 ay yerine 5 ay).
  assert.equal(dependency.lagValue, 1);
  assert.equal(dependency.lagUnit, 'week');
  assert.equal(dependency.lagDays, 5);

  // İkinci değişim: 1 ay = 20 iş günü (100 değil).
  const toMonth = planSuccessorUpdate(
    { id: 'A' },
    'B',
    { lagUnit: 'month' },
    [{ id: 'A' }, { id: 'B', deps: [dependency] }]
  );
  assert.equal(toMonth.patch.deps[0].lagValue, 1);
  assert.equal(toMonth.patch.deps[0].lagDays, 20);
});

/* ── İkinci tur inceleme bulguları ──────────────────────────────── */

test('tam sınırdaki aralık son gününü de sayar', () => {
  // Sayım iki ucu da içerir: N günlük bir aralıkta ziyaret edilecek gün sayısı
  // N+1'dir. `>=` ile kesildiğinde yazma sınırının KABUL ETTİĞİ tam sınırdaki
  // bir görev son gününü saymadan bitiyor ve süresi bir gün eksik yazılıyordu.
  const allWorkingDays = { id: 'her-gun', workingDays: [0, 1, 2, 3, 4, 5, 6], holidays: [] };
  const start = new Date(2026, 0, 1);
  const end = new Date(start.getTime() + (MAX_CALENDAR_SPAN_DAYS * 86400000));
  assert.equal(
    countWorkingDays(fmtISO(start), fmtISO(end), allWorkingDays),
    MAX_CALENDAR_SPAN_DAYS + 1
  );
});

test('havuz kurulumu reddedildiğinde önbellek TEMİZLENİR', () => {
  for (const file of ['src/server/db/pool.js', 'src/server/db/corporateWbsPool.js']) {
    const source = read(file);
    // Yapılandırma okuması, sürücü yüklemesi ve kurucu da hata yükseltebilir;
    // yalnızca `pool.connect()` sarılsaydı reddedilen söz önbellekte kalır ve
    // sorun giderilse bile süreç yeniden başlatılana kadar her istek düşerdi.
    assert.match(source, /const attempt = \(async \(\) => \{[\s\S]*?const config = get/, file);
    // Temizlik ATAMADAN SONRA bağlanır: eşzamanlı hata `poolPromise` atanmadan
    // önce çalışan bir catch bloğuyla temizlenemezdi.
    assert.match(
      source,
      /poolPromise = attempt;\s*(\/\/[^\n]*\n\s*)*attempt\.catch\(\(\) => \{\s*if \(poolPromise === attempt\) poolPromise = undefined;\s*\}\);/,
      file
    );
  }
});

test('kesilen gövde BAŞARILI boş yanıt olarak raporlanmaz', () => {
  // `response.json().catch(() => ({}))` iptali de yutuyordu: gövdesi askıda
  // kalan bir commit yanıtı `ok` ile birlikte `{}` dönüyor, kalıcılık kuyruğu
  // bunu başarı sayıp saklanan yeniden deneme durumunu atıyordu.
  const repository = read('src/data/api/createApiRepository.js');
  assert.doesNotMatch(repository, /response\.json\(\)\.catch\(/);
  assert.match(repository, /body = await response\.json\(\);/);
  assert.match(repository, /if \(controller\?\.signal\.aborted\)/);

  // Hatırlatma ve Outlook takvim uçları ORTAK sarmalayıcıyı kullanır; kural
  // artık tek yerde durur ve iki istemci de aynı davranışı miras alır.
  for (const file of ['src/data/api/scheduleChangeClient.js', 'src/features/shared/jsonRequest.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /response\.json\(\)\.catch\(/, file);
    assert.match(source, /if \(controller\?\.signal\.aborted\)/, file);
  }
  for (const file of ['src/features/reminders/reminderClient.js', 'src/features/outlook/outlookClient.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /response\.json\(\)\.catch\(/, file);
    assert.match(source, /from '\.\.\/shared\/jsonRequest\.js'/, file);
  }
});

test('yardım sekmeleri klavyeyle gezilebilir', () => {
  const source = read('src/features/help/HelpView.jsx');
  // Gezinen sekme durağı tek başına eklenirse seçili olmayan bölümler klavyeyle
  // TÜMÜYLE ulaşılamaz olur; WAI-ARIA sekme kalıbı odağı ok tuşlarıyla taşır.
  assert.match(source, /tabIndex=\{selected \? 0 : -1\}/);
  assert.match(source, /onKeyDown=\{onTabKeyDown\}/);
  assert.match(source, /event\.key === 'ArrowRight' \|\| event\.key === 'ArrowDown'/);
  assert.match(source, /event\.key === 'Home'/);
  assert.match(source, /event\.key === 'End'/);
});
