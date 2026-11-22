import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';

import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';
import { CLIENT_STATE, findElement, mountComponent } from './helpers/clientComponentHarness.mjs';

registerServerOnlyShim();

/**
 * Zil → karar → kalıcı atama → uzlaştırma zincirinin ve Talepler birleşik
 * gelen kutusunun yakınsama gerilemeleri.
 *
 * Değişmezler:
 *   · Atama onayı gerçek sorumlu ilişkisini yazar; ret yazmaz; karar ve durum
 *     aynı işlemde kalıcılaşır.
 *   · Karardan sonra başlayan okuma, karardan ÖNCE başlamış bir yenilemenin
 *     sonucuyla karşılanmaz.
 *   · Okundu işareti silme değildir: bilgilendirme Geçmiş'te kalır.
 */

const { createDataRefreshRequestGuard, createDataRefreshSingleFlight } = await import('../src/state/dataRefreshSafety.js');
const { createDataReloadOperation, dataReloadSingleFlightOptions } = await import('../src/state/dataReloadLifecycle.js');
const { appStateReducer, createInitialState } = await import('../src/state/appState.js');
const { createNotificationActions, OUTCOME_UNKNOWN_MESSAGE, OUTCOME_UNKNOWN_UNRECONCILED_MESSAGE } = await import('../src/state/notificationActions.js');
const { requestInboxRow, requestInboxKey, selectFresherRecord } = await import('../src/features/schedule-change/requestInboxPresentation.js');
const { AssignmentCoordinationView } = await import('../src/features/assignment-coordination/AssignmentCoordinationView.jsx');
const { AssignmentCoordinationDialog } = await import('../src/features/assignment-coordination/AssignmentCoordinationDialog.jsx');
const { ScheduleRequestDetails } = await import('../src/features/schedule-change/ScheduleRequestCenter.jsx');
const { ScheduleRequestsView } = await import('../src/features/schedule-change/ScheduleRequestsView.jsx');
const { TaskTablePagination } = await import('../src/features/tasks/TaskTablePagination.jsx');
const { useRequestInboxQuery } = await import('../src/features/schedule-change/useRequestInboxQuery.js');
const { fetchRequestInbox } = await import('../src/data/api/assignmentCoordinationClient.js');
const store = await import('../src/server/assignment/assignmentCoordinationStore.js');
const coordinationQueries = await import('../src/server/assignment/assignmentCoordinationQueries.js');
const { withSqlTransaction } = await import('../src/server/db/pool.js');
const inbox = await import('../src/server/notifications/requestInboxQueries.js');
const notificationQueries = await import('../src/server/notifications/notificationInboxQueries.js');

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/* ── Ortak düzenek ──────────────────────────────────────────── */

const PROJECT_ID = '66666666-6666-4666-8666-000000000001';
const ROOT_WBS_ID = '66666666-6666-4666-8666-000000000002';
const TASK_ID = '66666666-6666-4666-8666-000000000003';
const ORDINARY = 960001;
const EXTERNAL = 960002;
const UNIT_MANAGER = 960003;
const OUTSIDER = 960004;
const PROJECT_MANAGER = 960005;

function seed(overrides = {}) {
  const own = { Directorate: 'Yazılım Direktörlüğü', Department: 'Gömülü Müdürlüğü', Unit: 'Doğrulama Birimi' };
  const other = { Directorate: 'Üretim Direktörlüğü', Department: 'Montaj Müdürlüğü', Unit: 'Hat 1 Birimi' };
  return {
    calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Kurumsal Takvim', IsDefault: 1, IsActive: 1 }],
    people: [
      { Sicil: ORDINARY, DisplayName: 'Olağan Kullanıcı', Username: 'u960001', ...own },
      { Sicil: EXTERNAL, DisplayName: 'Dış Birim Personeli', Username: 'u960002', ...other },
      { Sicil: UNIT_MANAGER, DisplayName: 'Birim Yöneticisi', Username: 'u960003', ...other },
      { Sicil: OUTSIDER, DisplayName: 'İlgisiz Kullanıcı', Username: 'u960004', ...own },
      { Sicil: PROJECT_MANAGER, DisplayName: 'Proje Yöneticisi', Username: 'u960005', ...own }
    ],
    executiveScope: [{ ManagerSicil: UNIT_MANAGER, EmployeeSicil: EXTERNAL, ScopeType: 'UNIT' }],
    corporateProjects: [{ ProjectCode: 'P9600001', ProjectName: 'Yakınsama Projesi', ProjectTypeCode: 'GD', ProjectTypeName: 'Garanti dışı' }],
    corporateProjectAccess: [{ ProjectCode: 'P9600001', Sicil: PROJECT_MANAGER, RoleCode: 'PROJECT_MANAGER' }],
    projects: [{
      ProjectId: PROJECT_ID, SourceType: 'CORPORATE', ProjectCode: 'P9600001', ProjectName: 'Yakınsama Projesi',
      ProjectTypeCode: 'GD', ProjectTypeName: 'Garanti dışı', LeadSicil: PROJECT_MANAGER,
      CalendarId: DEFAULT_CALENDAR_ID, IsActive: 1
    }],
    wbs: [{ WbsId: ROOT_WBS_ID, ProjectId: PROJECT_ID, ParentWbsId: null, Code: 'P9600001', Name: 'Kök', SortOrder: 0, SourceType: 'CORPORATE' }],
    tasks: [{
      TaskId: TASK_ID, ProjectId: PROJECT_ID, WbsId: ROOT_WBS_ID, CalendarId: DEFAULT_CALENDAR_ID,
      Title: 'Saha kurulum hazırlığı', Status: 'in_progress', Priority: 'high',
      PlannedStart: '2026-09-01', PlannedFinish: '2026-09-10', PlannedDurationDays: 8,
      TargetFinish: '2026-09-12', CreatedBySicil: ORDINARY
    }],
    taskAssignees: [{ TaskId: TASK_ID, Sicil: ORDINARY }],
    ...overrides
  };
}

async function asUser(sicil, run) {
  const previous = process.env.MERGEN_ROTA_DEV_SICIL;
  process.env.MERGEN_ROTA_DEV_SICIL = String(sicil);
  try { return await run(); }
  finally { process.env.MERGEN_ROTA_DEV_SICIL = previous; }
}

function assigneesOf(stack) {
  return stack.db.taskAssignees
    .filter((row) => row.TaskId.toUpperCase() === stack.actualId(TASK_ID).toUpperCase())
    .map((row) => Number(row.Sicil)).sort((left, right) => left - right);
}

const page = (input) => inbox.queryRequestInbox(input);
const keys = (result) => result.items.map((item) => `${item.source}:${item.id}`);

async function requestAssignment(stack) {
  const created = await asUser(ORDINARY, () => store.createAssignmentCoordination({
    taskId: TASK_ID, assigneeSicils: [EXTERNAL], message: 'Montaj desteği gerekiyor.'
  }));
  return created.items[0];
}

/* ── A · Karar doğruluğu (gerçek sunucu kodu, bellek içi SQL ikizi) ── */

test('atama onayı gerçek sorumlu ilişkisini yazar ve Talepler görünümleri kalıcı duruma yakınsar', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const record = await requestAssignment(stack);
    assert.deepEqual(assigneesOf(stack), [ORDINARY], 'onaydan önce sorumlu yazılmaz');

    const managerIncoming = await asUser(UNIT_MANAGER, () => page({ tab: 'pending' }));
    const managerItem = managerIncoming.items.find((item) => item.id === record.id);
    assert.ok(managerItem?.actionable, 'karar bekleyen talep Gelenler sekmesindedir');
    assert.equal(managerItem.source, 'ASSIGNMENT_COORDINATION');

    // Okundu işareti kararı ortadan kaldırmaz: karar bekleyen kayıt Gelenler'de kalır.
    await asUser(UNIT_MANAGER, () => notificationQueries.markNotifications({
      action: 'read', notifications: [{ id: record.id, version: managerItem.version, source: 'ASSIGNMENT_COORDINATION' }]
    }));
    const afterRead = await asUser(UNIT_MANAGER, () => page({ tab: 'pending' }));
    assert.ok(afterRead.items.some((item) => item.id === record.id && item.actionable && !item.unread));

    const decided = await asUser(UNIT_MANAGER, () => store.decideAssignmentCoordination(record.id, {
      decision: 'APPROVE', version: managerItem.version
    }));
    assert.equal(decided.outcome, 'APPROVED');
    assert.equal(decided.record.status, 'APPROVED');
    assert.deepEqual(assigneesOf(stack), [ORDINARY, EXTERNAL], 'onay sorumluyu kalıcı olarak ekler');

    const managerAfter = await asUser(UNIT_MANAGER, () => Promise.all([page({ tab: 'pending' }), page({ tab: 'history' })]));
    assert.equal(managerAfter[0].items.some((item) => item.id === record.id), false, 'sonuçlanan talep Gelenler’den çıkar');
    assert.ok(managerAfter[1].items.some((item) => item.id === record.id && item.status === 'APPROVED'));

    // Atanan kişi "Size görev atandı" bildirimini Gelenler'de görür.
    const assigneeIncoming = await asUser(EXTERNAL, () => page({ tab: 'pending' }));
    const assigned = assigneeIncoming.items.find((item) => item.source === 'TASK_EVENT' && item.kind === 'TASK_ASSIGNED');
    assert.ok(assigned, 'atama olayı Gelenler sekmesinde görünür');
  } finally { await stack.dispose(); }
});

test('atama reddi sorumlu eklemez, kaydı reddedildi yapar ve talep edenin geçmişinde kalır', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const record = await requestAssignment(stack);
    const sent = await asUser(ORDINARY, () => page({ tab: 'sent' }));
    assert.ok(sent.items.some((item) => item.id === record.id), 'gönderilen atama talebi Gönderdiklerim sekmesindedir');
    const ownIncoming = await asUser(ORDINARY, () => page({ tab: 'pending' }));
    assert.equal(ownIncoming.items.some((item) => item.id === record.id), false, 'kendi açık talebi gelen sayılmaz');
    const decided = await asUser(UNIT_MANAGER, () => store.decideAssignmentCoordination(record.id, {
      decision: 'REJECT', version: record.version
    }));
    assert.equal(decided.outcome, 'REJECTED');
    assert.deepEqual(assigneesOf(stack), [ORDINARY]);
    const requester = await asUser(ORDINARY, () => Promise.all([page({ tab: 'pending' }), page({ tab: 'history' })]));
    assert.ok(requester[0].items.some((item) => item.id === record.id && item.unread), 'ret yanıtı talep edene yeni bildirim olarak gelir');
    assert.ok(requester[1].items.some((item) => item.id === record.id && item.status === 'REJECTED'));
  } finally { await stack.dispose(); }
});

test('aynı sürümle verilen ikinci karar reddedilir ve sorumlu iki kez yazılmaz', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const record = await requestAssignment(stack);
    await asUser(UNIT_MANAGER, () => store.decideAssignmentCoordination(record.id, { decision: 'APPROVE', version: record.version }));
    // Hızlı çift tıklama ya da yanıtı kaybolan isteğin yeniden gönderimi.
    await assert.rejects(
      asUser(UNIT_MANAGER, () => store.decideAssignmentCoordination(record.id, { decision: 'APPROVE', version: record.version })),
      (error) => error.code === 'CONFLICT'
    );
    // Eşzamanlı ret de eski sürümle kazanamaz.
    await assert.rejects(
      asUser(PROJECT_MANAGER, () => store.decideAssignmentCoordination(record.id, { decision: 'REJECT', version: record.version })),
      (error) => error.code === 'CONFLICT'
    );
    assert.deepEqual(assigneesOf(stack), [ORDINARY, EXTERNAL]);
    assert.equal(stack.db.taskAssignmentCoordinations.find((row) => row.CoordinationId.toLowerCase() === record.id).Status, 'APPROVED');
  } finally { await stack.dispose(); }
});

/* ── B · Bildirim bütünlüğü ve geçmiş ───────────────────────── */

test('okundu işaretlenen bilgilendirme Gelenler’den çıkar ama Geçmiş’te kalır; okuma kişiye özeldir', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const record = await requestAssignment(stack);
    await asUser(UNIT_MANAGER, () => store.decideAssignmentCoordination(record.id, { decision: 'APPROVE', version: record.version }));
    const before = await asUser(EXTERNAL, () => page({ tab: 'pending' }));
    const event = before.items.find((item) => item.source === 'TASK_EVENT');
    assert.ok(event?.unread);

    const marked = await asUser(EXTERNAL, () => notificationQueries.markNotifications({
      action: 'dismiss', notifications: [{ id: event.id, source: 'TASK_EVENT' }]
    }));
    // Yanıt, aynı işlemde okunan güncel zil kutusunu taşır.
    assert.ok(marked.inbox, 'okundu yanıtı zil kutusunu döndürür');
    assert.equal(marked.inbox.taskNotifications.some((item) => item.id === event.id), false, 'temizlenen olay zilden kalkar');

    const after = await asUser(EXTERNAL, () => Promise.all([page({ tab: 'pending' }), page({ tab: 'history' })]));
    assert.equal(after[0].items.some((item) => item.id === event.id), false);
    const history = after[1].items.find((item) => item.id === event.id);
    assert.ok(history, 'temizlenen bildirim Geçmiş’te bulunur');
    assert.equal(history.unread, false);
    assert.equal(after[1].counts.history, before.counts.history, 'Geçmiş sayısı okunma durumuna bağlı değildir');

    // Başka bir kullanıcı bu olayı hiçbir sekmede görmez.
    for (const tab of ['pending', 'sent', 'history']) {
      const outsider = await asUser(OUTSIDER, () => page({ tab }));
      assert.equal(outsider.items.some((item) => item.id === event.id || item.id === record.id), false, tab);
    }
  } finally { await stack.dispose(); }
});

test('birleşik okundu ucu tarih talebi kaynağını sürüm denetimiyle kabul eder ve bilinmeyen kaynağı reddeder', async () => {
  for (const source of [undefined, 'BILINMEYEN', 'schedule_request']) {
    await assert.rejects(
      notificationQueries.markNotifications({ action: 'read', notifications: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', source }] }),
      (error) => error.code === 'MUTATION_FAILED' && error.message === 'Bildirim kaynağı geçersiz.'
    );
  }
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    // Sürümsüz tarih talebi işareti eski uçtaki gibi reddedilir.
    await assert.rejects(
      notificationQueries.markNotifications({ action: 'read', notifications: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', source: 'SCHEDULE_REQUEST' }] }),
      (error) => error.code === 'CONFLICT'
    );
  } finally { await stack.dispose(); }
});

test('Gelenler sayfalaması belirlenimci sıradadır; sayfalar arasında yinelenen ya da kaybolan kayıt olmaz', async () => {
  const notifications = Array.from({ length: 23 }, (_, index) => ({
    NotificationId: `77777777-7777-4777-8777-${String(index + 1).padStart(12, '0')}`,
    RecipientSicil: EXTERNAL, ActorSicil: ORDINARY, ActorNameSnapshot: 'Olağan Kullanıcı',
    Kind: index % 2 ? 'TASK_ASSIGNED' : 'TASK_UNASSIGNED', TaskId: TASK_ID,
    TaskTitleSnapshot: `Görev ${index + 1}`, ProjectIdSnapshot: PROJECT_ID,
    ProjectNameSnapshot: 'Yakınsama Projesi', ProjectCodeSnapshot: 'P9600001',
    // Aynı zaman damgasını paylaşan satırlar sıranın eşitlik kuralını sınar.
    OccurredAt: new Date(Date.UTC(2026, 9, 1 + Math.floor(index / 3))).toISOString(),
    ReadAt: null, DismissedAt: null, TaskCount: 1, RowVersion: Buffer.alloc(8, index + 1)
  }));
  const stack = await createActualStack(seed({ taskNotifications: notifications }), { sicil: EXTERNAL, corporateWbsSource: false });
  try {
    const seen = [];
    let total = 0;
    for (let index = 0; index < 3; index += 1) {
      const result = await page({ tab: 'pending', page: index, pageSize: 10 });
      total = result.total;
      seen.push(...keys(result));
      assert.equal(result.counts.pending, result.total, 'Gelenler sayacı sekmenin kayıt sayısıdır');
    }
    assert.equal(total, 23);
    assert.equal(seen.length, 23);
    assert.equal(new Set(seen).size, 23, 'yinelenen kayıt yoktur');
    assert.deepEqual(keys(await page({ tab: 'pending', page: 0, pageSize: 10 })), seen.slice(0, 10), 'sıra kararlıdır');
    const clamped = await page({ tab: 'pending', page: 99, pageSize: 10 });
    assert.equal(clamped.page, 2, 'aşan sayfa son geçerli sayfaya çekilir');
    const filtered = await page({ tab: 'history', category: 'TASK_ASSIGNED', pageSize: 100 });
    assert.ok(filtered.items.every((item) => item.kind === 'TASK_ASSIGNED'));
    assert.equal(filtered.items.length, 11);
    // Durum süzgeci olay bildirimlerini (durumsuz) dışarıda bırakır.
    assert.equal((await page({ tab: 'history', status: 'APPROVED' })).items.some((item) => item.source === 'TASK_EVENT'), false);
  } finally { await stack.dispose(); }
});

test('birleşik sorgu geçersiz sekme, tür, durum ve tarih aralığını reddeder', () => {
  const invalid = (input) => assert.throws(() => inbox.normalizeRequestInboxQuery(input), (error) => error.code === 'MUTATION_FAILED');
  invalid({ tab: 'all' });
  invalid({ category: 'GIZLI' });
  invalid({ status: 'DELETED' });
  invalid({ from: '2026-10-05', to: '2026-10-01' });
  invalid({ pageSize: 101 });
  invalid({ projectId: 'task-66666666-6666-4666-8666-000000000001' });
  assert.equal(inbox.normalizeRequestInboxQuery({ projectId: `project-${PROJECT_ID}` }).projectId, PROJECT_ID);
});

test('birleşik sorgu kimliği yalnızca oturumdan alır ve her kaynağın kendi katılım yüklemini kullanır', () => {
  const source = read('src/server/notifications/requestInboxQueries.js');
  assert.match(source, /bindCoordinationScope\(executor\.request\(\), actor\)/);
  assert.match(source, /WHERE \$\{S\.PARTICIPANT\}/);
  assert.match(source, /WHERE \$\{C\.PARTICIPANT\}/);
  assert.match(source, /WHERE \$\{N\.OWNED\}/);
  // Ayrıntı satırları da yeniden katılım süzgecinden geçer.
  assert.match(source, /Source = 'SCHEDULE_REQUEST'\) AND \$\{S\.PARTICIPANT\}/);
  assert.match(source, /Source = 'ASSIGNMENT_COORDINATION'\) AND \$\{C\.PARTICIPANT\}/);
  assert.match(source, /Source = 'TASK_EVENT'\) AND \$\{N\.OWNED\}/);
  assert.doesNotMatch(source, /input\.sicil|searchParams\.get\('sicil'\)/);
});

/* ── A · İstemci yarışları (denetlenen sözlerle, beklemesiz) ── */

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * Sunucuyu taklit eder: anlık görüntü okuma BAŞLADIĞI andaki kalıcı durumu
 * döndürür. Karar `committed` değerini artırır.
 */
function reloadHarness() {
  const server = { committed: 0 };
  const gates = [];
  const applied = [];
  let state = { hasLoadedOnce: true, notificationInboxSequence: 0 };
  let sequence = 0;
  const repository = {
    async loadSnapshot() {
      const seenAt = server.committed;
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      return { tasks: [], decisionVersion: seenAt };
    }
  };
  const persistence = {
    flush: async () => ({ ok: true }), hasFailedTaskUpdates: () => false,
    runSerialized: (operation) => operation(), discardFailedTaskUpdates() {},
    rebaseFailedTaskUpdates(snapshot) { return { snapshot, missingTaskIds: [] }; }
  };
  const runDataReload = createDataReloadOperation({
    repository, persistence, getState: () => state,
    applyStateAction: (action) => { if (action.type === 'data/load-success') applied.push(action.snapshot.decisionVersion); },
    requestGuard: createDataRefreshRequestGuard(),
    beginInboxRead: () => ++sequence
  });
  const singleFlight = createDataRefreshSingleFlight();
  const reloadData = (options = {}) => singleFlight.run(
    () => runDataReload({ ...options, refreshMode: 'manual' }),
    dataReloadSingleFlightOptions('manual', options)
  );
  const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
  return { server, gates, applied, reloadData, flushMicrotasks, setState: (next) => { state = next; } };
}

test('karar sonrası yenileme, karardan önce başlamış süren yenilemeye katılmaz', async () => {
  const harness = reloadHarness();
  // 1) Zilde bildirimi açmak (eski davranış) bir yenileme başlatır.
  const markReload = harness.reloadData({ preserveFailedTaskUpdates: true });
  await harness.flushMicrotasks();
  assert.equal(harness.gates.length, 1);
  // 2) Kullanıcı onaylar; sunucu kaydeder.
  harness.server.committed = 1;
  // 3) Karar sonrası uzlaştırma AYNI seçeneklerle istenir.
  const decisionReload = harness.reloadData({ preserveFailedTaskUpdates: true });
  assert.notStrictEqual(decisionReload, markReload, 'süren okumanın sözü döndürülmez');
  harness.gates[0].resolve();
  await markReload;
  await harness.flushMicrotasks();
  assert.equal(harness.gates.length, 2, 'karardan sonra yeni bir okuma başlar');
  harness.gates[1].resolve();
  await decisionReload;
  assert.deepEqual(harness.applied, [0, 1], 'son uygulanan anlık görüntü kararı içerir');
});

test('art arda aynı yenileme istekleri tek bekleyen okumada birleşir', async () => {
  const harness = reloadHarness();
  const first = harness.reloadData();
  await harness.flushMicrotasks();
  const second = harness.reloadData();
  const third = harness.reloadData();
  assert.strictEqual(second, third, 'kuyruktaki aynı istek birleşir');
  harness.gates[0].resolve();
  await first;
  await harness.flushMicrotasks();
  harness.gates[1].resolve();
  await Promise.all([second, third]);
  assert.equal(harness.gates.length, 2, 'üçüncü istek ayrı okuma başlatmaz');
});

function actionsHarness({ decide, reload = async () => ({ ok: true }), mark, readRecord = async () => ({ ok: true, value: { record: null } }) } = {}) {
  const calls = { decide: 0, reload: 0, lookup: [], applied: [] };
  let sequence = 0;
  const actions = createNotificationActions({
    isActualMode: () => true,
    flush: async () => ({ ok: true }),
    reloadData: async (...args) => { calls.reload += 1; return reload(...args); },
    applyStateAction: (action) => calls.applied.push(action),
    beginInboxRead: () => ++sequence,
    getInboxSequence: () => sequence,
    markItems: mark || (async () => ({ ok: true, value: { ok: true } })),
    decideCoordination: async (...args) => { calls.decide += 1; return decide(...args); },
    readCoordination: async (id) => { calls.lookup.push(id); return readRecord(id); }
  });
  return { actions, calls, bumpSequence: () => ++sequence, getSequence: () => sequence };
}

test('belirsiz karar sonucu yeniden gönderilmez; ön-işlem okuması kesin uzlaştırma sayılmaz ve zaman aşımı da uzlaştırılır', async () => {
  // Karar sonrası yeni sürüm gözlendiğinde uzlaştırma kesinleşir ve güncel kayıt döner.
  const committedRecord = { id: 'c1', status: 'APPROVED', version: 'v2', allowedDecisions: [] };
  const confirmed = actionsHarness({
    decide: async () => ({ ok: false, code: 'NETWORK', message: 'Sunucuya ulaşılamadı.' }),
    readRecord: async () => ({ ok: true, value: { record: committedRecord } }),
    reload: async () => ({ ok: false, error: { message: 'Anlık görüntü alınamadı' } })
  });
  const result = await confirmed.actions.decideAssignmentCoordination('c1', { decision: 'APPROVE', version: 'v1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OUTCOME_UNKNOWN');
  assert.equal(result.reconciled, true);
  assert.deepEqual(result.record, committedRecord);
  assert.equal(result.message, OUTCOME_UNKNOWN_MESSAGE);
  assert.equal(confirmed.calls.decide, 1, 'karar isteği tekrarlanmaz');
  assert.equal(confirmed.calls.reload, 1, 'uygulama anlık görüntüsü de yenilenir');
  assert.deepEqual(confirmed.calls.lookup, ['c1'], 'zil önizlemesinden bağımsız olarak kayıt okunur');
  assert.equal(result.refreshError.message, 'Anlık görüntü alınamadı');

  // Erken okuma hâlâ karar öncesi aynı sürümü görüyorsa kesin uzlaştırma sayılmaz.
  const preCommit = actionsHarness({
    decide: async () => ({ ok: false, code: 'REQUEST_TIMEOUT', message: 'İstek zaman aşımına uğradı.' }),
    readRecord: async () => ({ ok: true, value: { record: { id: 'c1', status: 'PENDING', version: 'v1' } } })
  });
  const unconfirmed = await preCommit.actions.decideAssignmentCoordination('c1', { decision: 'APPROVE', version: 'v1' });
  assert.equal(unconfirmed.code, 'OUTCOME_UNKNOWN');
  assert.equal(unconfirmed.reconciled, false, 'karar öncesi aynı sürüm kesin uzlaştırma sayılmaz');
  assert.equal(unconfirmed.record, undefined);
  assert.equal(unconfirmed.message, OUTCOME_UNKNOWN_UNRECONCILED_MESSAGE);
  assert.equal(preCommit.calls.reload, 1, 'REQUEST_TIMEOUT da yeniden okuma tetikler');

  // Yenileme de başarısızsa ileti durumun doğrulandığını İDDİA etmez.
  const offline = actionsHarness({
    decide: async () => ({ ok: false, code: 'NETWORK', message: 'Sunucuya ulaşılamadı.' }),
    reload: async () => ({ ok: false, error: { message: 'Bağlantı yok' } })
  });
  const unreconciled = await offline.actions.decideAssignmentCoordination('c1', { decision: 'APPROVE', version: 'v1' });
  assert.equal(unreconciled.reconciled, false);
  assert.equal(unreconciled.message, OUTCOME_UNKNOWN_UNRECONCILED_MESSAGE);
  assert.equal(offline.calls.decide, 1);
});

test('kaydedilen kararın uzlaştırması başarısızsa sonuç bunu başarılı eşitleme gibi göstermez', async () => {
  const committed = { ok: true, value: { outcome: 'APPROVED', record: { id: 'c1', status: 'APPROVED' }, message: 'Atama onaylandı.' } };
  const failed = actionsHarness({ decide: async () => committed, reload: async () => ({ ok: false, error: { code: 'LOAD_FAILED', message: 'Bağlantı yok' } }) });
  const result = await failed.actions.decideAssignmentCoordination('c1', { decision: 'APPROVE' });
  assert.equal(result.ok, true, 'karar kaydedilmiştir');
  assert.equal(result.refreshError.message, 'Bağlantı yok');

  const order = [];
  const gate = deferred();
  const succeeded = actionsHarness({
    decide: async () => { order.push('karar'); await gate.promise; order.push('kaydedildi'); return committed; },
    reload: async () => { order.push('yenileme'); return { ok: true }; }
  });
  const pending = succeeded.actions.decideAssignmentCoordination('c1', { decision: 'APPROVE' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['karar'], 'sunucu yanıtı gelmeden başarı ya da yenileme yoktur');
  gate.resolve();
  const success = await pending;
  assert.deepEqual(order, ['karar', 'kaydedildi', 'yenileme']);
  assert.equal(success.refreshError, undefined);
});

test('sürüm çakışmasında bayat kayıt yerine güncel durum okunur', async () => {
  const record = { id: 'c1', version: 'yeni', status: 'APPROVED' };
  const { actions, calls } = actionsHarness({
    decide: async () => ({ ok: false, code: 'CONFLICT', message: 'Koordinasyon kaydı bu sırada güncellendi.' }),
    readRecord: async () => ({ ok: true, value: { record } })
  });
  const result = await actions.decideAssignmentCoordination('c1', { decision: 'REJECT', version: 'eski' });
  assert.equal(result.code, 'CONFLICT');
  assert.deepEqual(result.record, record);
  assert.deepEqual(calls.lookup, ['c1']);
  assert.equal(calls.reload, 1);
});

test('okundu işareti tam anlık görüntü okumadan yalnız dönen zil kutusunu uygular', async () => {
  const inboxValue = { notificationSummary: { unreadCount: 0, pendingCount: 1 }, taskNotifications: [] };
  const { actions, calls } = actionsHarness({ mark: async () => ({ ok: true, value: { ok: true, inbox: inboxValue } }) });
  const result = await actions.markNotifications([{ id: 'n1', source: 'TASK_EVENT' }, { id: 'x', source: 'BILINMEYEN' }]);
  assert.equal(result.ok, true);
  assert.equal(calls.reload, 0, 'tam anlık görüntü okunmaz');
  assert.deepEqual(calls.applied.map((action) => action.type), ['notifications/inbox-refreshed']);
  assert.equal(calls.applied[0].inboxSequence, 1);

  const legacy = actionsHarness({ mark: async () => ({ ok: true, value: { ok: true } }) });
  await legacy.actions.markNotifications([{ id: 'n1', source: 'TASK_EVENT' }]);
  assert.equal(legacy.calls.reload, 1, 'kutuyu döndürmeyen eski sunucuda olağan yenilemeye düşülür');
});

test('daha önce gönderilmiş okumanın geç yanıtı yeni zil durumunu geri almaz', () => {
  const base = createInitialState({ tasks: [], notificationSummary: { unreadCount: 2, pendingCount: 1 } });
  const marked = appStateReducer(base, {
    type: 'notifications/inbox-refreshed', inboxSequence: 5,
    inbox: { notificationSummary: { unreadCount: 0, pendingCount: 1 }, taskNotifications: [] }
  });
  assert.deepEqual(marked.notificationSummary, { unreadCount: 0, pendingCount: 1 });
  // İşaretten önce başlamış anlık görüntü: görevleri uygular, zil kutusunu ezmez.
  const stale = appStateReducer(marked, {
    type: 'data/load-success', inboxSequence: 4,
    snapshot: { tasks: [], projects: [{ id: 'p1', name: 'Yeni' }], notificationSummary: { unreadCount: 2, pendingCount: 1 } }
  });
  assert.deepEqual(stale.notificationSummary, { unreadCount: 0, pendingCount: 1 });
  assert.equal(stale.projects.length, 1, 'iş verisi yine uygulanır');
  const olderMark = appStateReducer(stale, {
    type: 'notifications/inbox-refreshed', inboxSequence: 3, inbox: { notificationSummary: { unreadCount: 9, pendingCount: 9 } }
  });
  assert.strictEqual(olderMark, stale);
  // Daha sonra başlayan anlık görüntü uygulanır.
  const fresh = appStateReducer(stale, {
    type: 'data/load-success', inboxSequence: 6, snapshot: { tasks: [], notificationSummary: { unreadCount: 1, pendingCount: 0 } }
  });
  assert.deepEqual(fresh.notificationSummary, { unreadCount: 1, pendingCount: 0 });
});

/* ── Arayüz sözleşmeleri ────────────────────────────────────── */

test('Talepler satırı kaynak anlamını korur ve okunmamışlığı durumla karıştırmaz', () => {
  const event = requestInboxRow({ source: 'TASK_EVENT', id: 'n1', kind: 'TASK_UNASSIGNED', unread: false, actorName: 'A', taskTitle: 'T', occurredAt: '2026-10-01T00:00:00Z' });
  assert.equal(event.category, 'Görev sorumluluğunuz kaldırıldı');
  assert.equal(event.actionable, false);
  assert.equal(event.unread, false);
  const notice = requestInboxRow({ source: 'ASSIGNMENT_COORDINATION', id: 'c1', mode: 'NOTICE', status: 'APPROVED', unread: true });
  assert.equal(notice.category, 'Bölüm dışı atama bildirimi');
  assert.equal(notice.statusLabel, 'Atandı');
  const schedule = requestInboxRow({ id: 'r1', status: 'PENDING', isDecisionOwner: true, taskAvailable: true });
  assert.equal(schedule.category, 'Tarih değişikliği talebi');
  assert.equal(schedule.actionable, true);
  assert.notEqual(requestInboxKey({ source: 'TASK_EVENT', id: 'x' }), requestInboxKey({ source: 'SCHEDULE_REQUEST', id: 'x' }));
});

const readResponse = (value, status = 200) => ({ ok: status < 400, status, async json() { return value; } });
const settleRead = () => new Promise((resolve) => setImmediate(resolve));

test('Atama Koordinasyonu aynı zil sayısıyla yenilenir, hatada son geçerli sayacı korur', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const counts = [];
  const responses = [40, null, 41];
  t.mock.method(globalThis, 'fetch', async () => {
    const all = responses.shift();
    return all == null ? readResponse({ message: 'Bağlantı yok' }, 503)
      : readResponse({ items: [], total: all, page: 0, pageSize: 25, counts: { all, pending: 0 } });
  });
  const lifecycle = { lastRefreshedAt: 'ilk' };
  globalThis[CLIENT_STATE] = {
    projects: [], actions: {}, session: { dataMode: 'actual' }, dataLifecycle: lifecycle,
    notificationSummary: { unreadCount: 0, pendingCount: 0 }
  };
  const onTotalChange = (value) => counts.push(value);
  const view = mountComponent(AssignmentCoordinationView, { onTotalChange });
  t.after(() => { view.unmount(); delete globalThis[CLIENT_STATE]; });
  async function showResponse() {
    t.mock.timers.tick(250);
    await settleRead();
    view.render();
  }
  await showResponse();
  assert.deepEqual(counts, [40]);
  lifecycle.lastRefreshedAt = 'ikinci';
  view.render();
  await showResponse();
  assert.ok(findElement(view.output, (node) => node.props?.role === 'alert'));
  assert.deepEqual(counts, [40]);
  lifecycle.lastRefreshedAt = 'üçüncü';
  view.render();
  await showResponse();
  assert.equal(findElement(view.output, (node) => node.props?.role === 'alert'), null);
  assert.deepEqual(counts, [40, 41]);
  assert.equal(responses.length, 0);
});

test('karar penceresi yenileme hatasında açık kalır ve sunucunun döndürdüğü kaydı gösterir', async (t) => {
  globalThis.document = { addEventListener() {}, removeEventListener() {}, activeElement: null };
  let closed = false;
  const record = { id: 'c1', status: 'PENDING', mode: 'REQUEST', version: 'v1', allowedDecisions: ['APPROVE', 'REJECT'], taskTitle: 'Görev', assigneeName: 'Dış', requesterName: 'Talep' };
  const view = mountComponent(AssignmentCoordinationDialog, {
    record, loadRecord: async () => ({ ok: true, value: { record } }), onClose: () => { closed = true; }, onOpenTask: async () => ({ ok: true }),
    onDecide: async () => ({ ok: true, value: { outcome: 'APPROVED', message: 'Atama onaylandı.', record: { ...record, status: 'APPROVED', version: 'v2', allowedDecisions: [] } }, refreshError: { message: 'Bağlantı yok' } })
  });
  t.after(() => { view.unmount(); delete globalThis.document; });
  await settleRead();
  view.render();
  const approve = findElement(view.output, (node) => node.type === 'button' && node.props.className?.includes('primary'));
  await approve.props.onClick();
  view.render();
  assert.equal(closed, false, 'uzlaştırılamayan karar pencereyi başarıyla kapatmaz');
  const status = findElement(view.output, (node) => node.props?.role === 'status');
  assert.match(JSON.stringify(status.props.children), /görünüm yenilenemedi/);
  assert.equal(findElement(view.output, (node) => node.type === 'h2').props.children, 'Atama talebi · Atandı');
  assert.equal(findElement(view.output, (node) => node.type === 'button' && /Reddet/.test(JSON.stringify(node.props.children))), null, 'eski karar düğmeleri gösterilmez');
});

const css = postcss.parse(read('src/app/styles/features.css'));
function declaration(selector, property) {
  let value;
  // Ortam sorgusu içindeki yedek kurallar ayrı denetlenir.
  css.walkRules(selector, (rule) => {
    if (rule.parent?.type === 'atrule') return;
    rule.walkDecls(property, (decl) => { value = decl.value; });
  });
  return value;
}

test('Talepler dört sekmede tablo kabuğunu tek dikey kaydırma alanı yapar ve başlığı yapışkan tutar', () => {
  assert.equal(declaration('.content-talepler', 'overflow'), 'hidden');
  assert.equal(declaration('.content-talepler', 'padding-bottom'), '16px', 'alt nefes payı');
  assert.equal(declaration('.requests-view', 'height'), '100%');
  assert.equal(declaration('.requests-view > .requests-panel', 'flex'), '1 1 0');
  assert.equal(declaration('.requests-view > .requests-panel', 'min-height'), '0');
  assert.equal(declaration('.requests-panel > .coordination-panel', 'min-height'), '0');
  assert.equal(declaration('.requests-panel > .detail-list-scroll,\n.coordination-panel > .detail-list-scroll', 'overflow'), 'auto');
  assert.equal(declaration('.requests-panel > .detail-list-scroll,\n.coordination-panel > .detail-list-scroll', 'flex'), '1 1 0');
  assert.equal(declaration('.detail-list-table th', 'position'), 'sticky');
  // Paylaşılan kabuk (KPI penceresi vb.) değişmez.
  assert.equal(declaration('.detail-list-scroll', 'overflow'), 'auto');
  assert.equal(declaration('.detail-list-scroll', 'flex'), undefined);
  // Kısa/dar görünümde sayfa yeniden kayar, tablo üst sınırı ölçekli görünüm yüksekliğidir.
  let fallback = null;
  css.walkAtRules('media', (rule) => {
    if (rule.params.includes('max-height: 600px') && rule.toString().includes('.content-talepler')) fallback = rule.toString();
  });
  assert.ok(fallback, 'dar görünüm kuralı bulunmalı');
  assert.match(fallback, /var\(--app-viewport-h, 100vh\) \* \.65/);
  // Sabit piksel yükseklikleri yerine ölçekli görünüm değişkeni kullanılır.
  const start = css.nodes.findIndex((node) => node.type === 'comment' && node.text.includes('Talepler · tam yükseklikli'));
  const end = css.nodes.findIndex((node) => node.type === 'rule' && node.selector === '.coordination-modal');
  assert.ok(start >= 0 && end > start, 'Talepler yerleşim bölümünün iki sınırı bulunmalı');
  assert.doesNotMatch(css.nodes.slice(start, end).map(String).join('\n'), /100vh\s*-/);
  assert.equal(declaration('.requests-view > .requests-panel', 'overflow'), 'auto');
});

/* ── Yetki iptali, eşzamanlılık ve kenar durum regresyonları ─── */

test('geçici tam proje yetkisiyle geçmiş koordinasyonu okundu işaretlemek yetki iptali sonrası kalıcı erişim vermez', async () => {
  const TEMP_MANAGER = 960010;
  const baseSeed = seed();
  baseSeed.people.push({
    Sicil: TEMP_MANAGER, DisplayName: 'Geçici Yönetici', Username: 'u960010',
    Directorate: 'Yazılım Direktörlüğü', Department: 'Gömülü Müdürlüğü', Unit: 'Doğrulama Birimi'
  });
  const stack = await createActualStack(baseSeed, { sicil: ORDINARY, corporateWbsSource: false });
  try {
    // 1) Talep oluşturulur ve yetkili birim yöneticisi tarafından onaylanır (Geçmiş kaydı).
    const created = await requestAssignment(stack);
    const approved = await asUser(UNIT_MANAGER, () => store.decideAssignmentCoordination(created.id, {
      decision: 'APPROVE', version: created.version
    }));
    assert.equal(approved.outcome, 'APPROVED');

    // 2) Geçici yöneticiye projeye geçici FULL erişim verilir (ne talep eden ne de alıcıdır).
    stack.db.corporateProjectAccess.push({ ProjectCode: 'P9600001', Sicil: TEMP_MANAGER, RoleCode: 'PROJECT_MANAGER' });
    const beforeRevoke = await asUser(TEMP_MANAGER, () => page({ tab: 'history' }));
    const found = beforeRevoke.items.find((item) => item.id === created.id);
    assert.ok(found, 'geçici tam proje yetkisi varken geçmiş kayıt görünür');
    assert.equal(found.unread, true);

    // 3) Kaydı açıp okundu işaretler; okuma satırı REQUESTER rolüyle yazılır.
    await asUser(TEMP_MANAGER, () => notificationQueries.markNotifications({
      action: 'read',
      notifications: [{ id: found.id, version: found.version, source: 'ASSIGNMENT_COORDINATION' }]
    }));
    const readRow = stack.db.assignmentCoordinationRecipients.find(
      (row) => Number(row.Sicil) === TEMP_MANAGER
    );
    assert.equal(readRow?.RecipientRole, 'REQUESTER', 'okuma işareti yalnızca okuma satırı üretir');
    const afterMark = await asUser(TEMP_MANAGER, () => page({ tab: 'history' }));
    assert.equal(afterMark.items.find((item) => item.id === created.id)?.unread, false, 'yetki sürerken okundu durumu korunur');

    // 4) Geçici proje yetkisi iptal edilir.
    stack.db.corporateProjectAccess = stack.db.corporateProjectAccess.filter((row) => Number(row.Sicil) !== TEMP_MANAGER);
    const afterRevokeInbox = await asUser(TEMP_MANAGER, () => page({ tab: 'history' }));
    assert.equal(afterRevokeInbox.items.find((item) => item.id === created.id), undefined,
      'yetki iptali sonrası okuma satırı kalıcı erişim vermemelidir');
    const afterRevokeCoord = await asUser(TEMP_MANAGER, () => coordinationQueries.queryAssignmentCoordinations({ tab: 'all' }));
    assert.equal(afterRevokeCoord.items.find((item) => item.id === created.id), undefined,
      'Atama Koordinasyonu okuması da yetki iptali sonrası kaydı gizlemelidir');
    const detail = await asUser(TEMP_MANAGER, () => coordinationQueries.queryAssignmentCoordinations({ coordinationId: created.id }));
    assert.equal(detail.record, null, 'tek kayıt okuması aynı katılım yetkisini gerektirir');

    // 5) Gerçek tarihsel alıcılar (talep eden, karar veren yönetici, onaylı sorumlu) erişimini korur.
    for (const legitimate of [ORDINARY, UNIT_MANAGER, EXTERNAL]) {
      const history = await asUser(legitimate, () => page({ tab: 'history' }));
      assert.ok(history.items.some((item) => item.id === created.id), `meşru alıcı (${legitimate}) geçmiş erişimini korur`);
    }

    // 6) SQL kaynağı da açık alıcı rollerini (MANAGER, ASSIGNEE) zorunlu kılar.
    const sqlSource = read('src/server/assignment/assignmentCoordinationQueries.js');
    assert.match(sqlSource, /RecipientRole IN \('MANAGER','ASSIGNEE'\)/);
  } finally {
    await stack.dispose();
  }
});

test('örtüşen okundu işaretleri sıraya girer ve son işlenen durumu korur', async () => {
  const firstGate = deferred();
  const order = [];
  const { actions, calls } = actionsHarness({
    mark: async (items) => {
      const id = items[0].id;
      order.push(`basla:${id}`);
      if (id === 'n1') await firstGate.promise;
      order.push(`bit:${id}`);
      return {
        ok: true,
        value: { ok: true, inbox: { notificationSummary: { unreadCount: id === 'n1' ? 1 : 0, pendingCount: 0 } } }
      };
    }
  });
  const mark1 = actions.markNotifications([{ id: 'n1', source: 'TASK_EVENT' }]);
  const mark2 = actions.markNotifications([{ id: 'n2', source: 'TASK_EVENT' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['basla:n1'], 'ikinci işaret ilki bitmeden başlamaz');
  firstGate.resolve();
  await Promise.all([mark1, mark2]);
  assert.deepEqual(order, ['basla:n1', 'bit:n1', 'basla:n2', 'bit:n2']);
  assert.deepEqual(calls.applied.map((a) => a.inboxSequence), [1, 2]);
  assert.equal(calls.applied[1].inbox.notificationSummary.unreadCount, 0);
});

test('okundu işareti sürerken başlayan anlık görüntü okuması işareti kalıcı olarak geri almaz', async () => {
  const gate = deferred();
  const { actions, calls, bumpSequence } = actionsHarness({
    mark: async () => {
      await gate.promise;
      return { ok: true, value: { ok: true, inbox: { notificationSummary: { unreadCount: 0, pendingCount: 0 } } } };
    },
    reload: async () => ({ ok: true })
  });
  const pending = actions.markNotifications([{ id: 'n1', source: 'TASK_EVENT' }]);
  await new Promise((resolve) => setImmediate(resolve));
  // İşaret sürerken daha yüksek sıra numaralı bir anlık görüntü okuması başlar.
  bumpSequence();
  gate.resolve();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(calls.reload, 1, 'üstüne binen okuma algılandığında işaret sonrası uzlaştırma okuması yapılır');
});

test('yanıtı kaybolan okundu işareti güncel durumu uzlaştırır ve hatayı gizlemez', async () => {
  const { actions, calls } = actionsHarness({
    mark: async () => ({ ok: false, code: 'NETWORK', message: 'Sunucuya ulaşılamadı.' }),
    reload: async () => ({ ok: true })
  });
  const result = await actions.markNotifications([{ id: 'n1', source: 'TASK_EVENT' }]);
  assert.equal(result.ok, false, 'belirsiz hata başarı gibi gösterilmez');
  assert.equal(calls.reload, 1, 'işlenmiş olabilecek işaret için güncel durum okunur');
});

test('karar penceresi elde tutulan kopyayı daha yeni sunucu sürümüyle değiştirir ve doğrulanmamış belirsiz sonuçta düğmeleri kilitler', async (t) => {
  globalThis.document = { addEventListener() {}, removeEventListener() {}, activeElement: null };
  const v1 = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]).toString('base64');
  const v2 = Buffer.from([0, 0, 0, 0, 0, 0, 0, 2]).toString('base64');
  const v3 = Buffer.from([0, 0, 0, 0, 0, 0, 0, 3]).toString('base64');
  const initial = { id: 'c1', status: 'PENDING', mode: 'REQUEST', version: v1, allowedDecisions: ['APPROVE', 'REJECT'], taskTitle: 'Görev', assigneeName: 'Dış', requesterName: 'Talep' };
  const approved = { ...initial, status: 'APPROVED', version: v2, allowedDecisions: ['REQUEST_CANCELLATION'] };
  const cancelled = { ...initial, status: 'CANCELLED', version: v3, allowedDecisions: [] };

  // 1) Karar sonrası yenileme hatasında committedRecord korunur, ama daha yeni v3 geldiğinde yerini bırakır.
  const props = {
    record: initial, loadRecord: async () => ({ ok: true, value: { record: initial } }), onClose() {}, onOpenTask: async () => ({ ok: true }),
    onDecide: async () => ({ ok: true, value: { outcome: 'APPROVED', message: 'Onaylandı.', record: approved }, refreshError: { message: 'Ağ hatası' } })
  };
  const view = mountComponent(AssignmentCoordinationDialog, props);
  await settleRead();
  view.render();
  const approve = findElement(view.output, (node) => node.type === 'button' && node.props.className?.includes('primary'));
  await approve.props.onClick();
  view.render();
  assert.equal(findElement(view.output, (node) => node.type === 'h2').props.children, 'Atama talebi · Atandı', 'eski v1 kopyası yetkili v2 kaydını ezmez');
  view.render({ ...props, record: cancelled });
  assert.equal(findElement(view.output, (node) => node.type === 'h2').props.children, 'Atama talebi · İptal edildi', 'daha yeni sunucu sürümü v3 elde tutulan v2 kopyasının yerini alır');

  // 2) Doğrulanmamış OUTCOME_UNKNOWN yanıtında karar düğmeleri gizlenir; aynı sürümle ikinci karar sunulamaz.
  const unknownView = mountComponent(AssignmentCoordinationDialog, {
    record: initial, loadRecord: async () => ({ ok: true, value: { record: initial } }), onClose() {}, onOpenTask: async () => ({ ok: true }),
    onDecide: async () => ({ ok: false, code: 'OUTCOME_UNKNOWN', reconciled: false, message: OUTCOME_UNKNOWN_UNRECONCILED_MESSAGE })
  });
  t.after(() => { view.unmount(); unknownView.unmount(); delete globalThis.document; });
  await settleRead();
  unknownView.render();
  const approve2 = findElement(unknownView.output, (node) => node.type === 'button' && node.props.className?.includes('primary'));
  await approve2.props.onClick();
  unknownView.render();
  assert.equal(findElement(unknownView.output, (node) => node.type === 'button' && /Reddet/.test(JSON.stringify(node.props.children))), null,
    'doğrulanmamış belirsiz sonuçta eski karar düğmeleri sunulmaz');
});

test('tarih talebi ayrıntı penceresi yenileme hatasında kapanmaz ve yetkili kaydı bayat listeden korur', async (t) => {
  globalThis.document = { addEventListener() {}, removeEventListener() {}, activeElement: null };
  let closed = false;
  const req = { id: 'r1', status: 'PENDING', isDecisionOwner: true, taskAvailable: true, taskTitle: 'Görev', requesterName: 'A', version: 'v1' };
  const resolved = { ...req, status: 'ACCEPTED', version: 'v2', decidedAt: '2026-10-02T10:00:00Z' };
  const view = mountComponent(ScheduleRequestDetails, {
    request: req, onClose: () => { closed = true; }, onOpenTask: async () => ({ ok: true }),
    onDecide: async () => ({ ok: true, value: { outcome: 'ACCEPTED', request: resolved }, refreshError: { message: 'Sunucu geçici erişilemez' } })
  });
  t.after(() => { view.unmount(); delete globalThis.document; });
  const accept = findElement(view.output, (node) => node.type === 'button' && node.props.className?.includes('primary'));
  await accept.props.onClick();
  view.render();
  assert.equal(closed, false, 'yenileme hatasında pencere sessizce kapanmaz');
  const status = findElement(view.output, (node) => node.props?.role === 'status');
  assert.match(JSON.stringify(status.props.children), /görünüm yenilenemedi/);
  assert.equal(selectFresherRecord(req, resolved).status, 'ACCEPTED', 'bayat PENDING satırı yetkili karar yanıtını ezmez');
});

test('prototip anahtarı taşıyan bildirim kaynağı 500 yerine 400 ile reddedilir', async () => {
  await assert.rejects(
    () => notificationQueries.markNotifications({
      action: 'read',
      notifications: [{ id: TASK_ID, source: 'constructor' }]
    }),
    (error) => error.status === 400 && /Bildirim kaynağı geçersiz/.test(error.message)
  );
});

test('birleşik gelen kutusu üyelik ile ayrıntı arasında eşzamanlı değişim olursa tutarlı okumaya yakınsar', async () => {
  let calls = 0;
  const nid = '66666666-6666-4666-8666-000000000099';
  const executor = {
    request() {
      const req = {
        input() { return req; },
        async query() {
          calls += 1;
          if (calls === 1) {
            // İlk okumada üyelik UnreadFlag=1 iken ayrıntı okunduğunda IsUnread=0 döner (eşzamanlı okuma yarışı).
            return {
              recordsets: [
                [{ IncomingCount: 1, SentCount: 0, HistoryCount: 1 }],
                [{ CoordinationCount: 0 }],
                [{ Total: 1, Page: 0 }],
                [{ Ordinal: 1, Source: 'TASK_EVENT', ItemId: nid, ItemVersion: Buffer.alloc(8, 1), UnreadFlag: 1, ActionableFlag: 0 }],
                [], [],
                [{ NotificationId: nid, Kind: 'TASK_ASSIGNED', TaskId: TASK_ID, TaskTitleSnapshot: 'G', OccurredAt: '2026-10-01T00:00:00Z', RowVersion: Buffer.alloc(8, 2), IsUnread: 0, TaskAvailable: 1 }]
              ]
            };
          }
          // İkinci okumada tutarlı anlık görüntü döner: okunan bildirim Gelenler'den çıkmıştır.
          return {
            recordsets: [
              [{ IncomingCount: 0, SentCount: 0, HistoryCount: 1 }],
              [{ CoordinationCount: 0 }],
              [{ Total: 0, Page: 0 }],
              [], [], [], []
            ]
          };
        }
      };
      return req;
    }
  };
  const result = await inbox.readRequestInboxPage(executor, { sicil: ORDINARY, isSystemAdmin: false, effective: { fullProjectIds: new Set() } }, { tab: 'pending' });
  assert.equal(calls, 2, 'anlık görüntü sapmasında sınırlı tek yineleme yapılır');
  assert.equal(result.items.length, 0, 'okunmuş bilgilendirme Gelenler listesine sızmaz');
  assert.equal(result.counts.pending, 0);
});

test('çok projeli toplu atama bildirimi proje süzgecinde yalnızca ilk görevin projesine bağlanmaz ve uzun tarih aralığı kabul edilir', async () => {
  const stack = await createActualStack(seed({
    taskNotifications: [{
      NotificationId: '66666666-6666-4666-8666-000000000088',
      RecipientSicil: EXTERNAL,
      Kind: 'TASK_ASSIGNED',
      TaskId: TASK_ID,
      ActorSicil: ORDINARY,
      ActorNameSnapshot: 'Olağan Kullanıcı',
      TaskTitleSnapshot: 'Çok projeli atama',
      ProjectIdSnapshot: null,
      ProjectNameSnapshot: null,
      ProjectCodeSnapshot: null,
      TaskCount: 2,
      EventKey: 'multi-project-1',
      OccurredAt: '2026-10-01T10:00:00Z',
      ReadAt: null,
      DismissedAt: null,
      RowVersion: Buffer.alloc(8, 5)
    }]
  }), { sicil: EXTERNAL, corporateWbsSource: false });
  try {
    const unfiltered = await asUser(EXTERNAL, () => page({ tab: 'history', from: '2020-01-01', to: '2026-12-31' }));
    assert.equal(unfiltered.items.length, 1, '366 günden uzun tarih aralığı reddedilmez ve çok projeli kayıt süzgeçsiz görünür');
    const filtered = await asUser(EXTERNAL, () => page({ tab: 'history', projectId: PROJECT_ID }));
    assert.equal(filtered.items.length, 0, 'çok projeli toplu bildirim yalnızca ilk görevin projesine yanlış bağlanmaz');
  } finally {
    await stack.dispose();
  }
});

test('birleşik gelen kutusu imleçli sayfalamada araya yeni kayıt girse de yinelenen veya atlanan satır üretmez', async () => {
  const notifications = [1, 2, 3, 4].map((index) => ({
    NotificationId: `66666666-6666-4666-8666-00000000001${index}`,
    RecipientSicil: EXTERNAL,
    Kind: 'TASK_ASSIGNED',
    TaskId: TASK_ID,
    ActorSicil: ORDINARY,
    ActorNameSnapshot: 'Olağan Kullanıcı',
    TaskTitleSnapshot: `Olay ${index}`,
    ProjectIdSnapshot: PROJECT_ID,
    TaskCount: 1,
    EventKey: `cursor-ev-${index}`,
    OccurredAt: `2026-10-0${index}T10:00:00Z`,
    ReadAt: null,
    DismissedAt: null,
    RowVersion: Buffer.alloc(8, index)
  }));
  const stack = await createActualStack(seed({ taskNotifications: notifications }), { sicil: EXTERNAL, corporateWbsSource: false });
  try {
    const first = await asUser(EXTERNAL, () => page({ tab: 'history', page: 0, pageSize: 2 }));
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor, 'sonraki sayfa için devam imleci döner');

    // İlk sayfa ile ikinci sayfa arasında başa yeni bir olay eklenir.
    stack.db.taskNotifications.push({
      NotificationId: '66666666-6666-4666-8666-000000000019',
      RecipientSicil: EXTERNAL,
      Kind: 'TASK_ASSIGNED',
      TaskId: TASK_ID,
      ActorSicil: ORDINARY,
      ActorNameSnapshot: 'Olağan Kullanıcı',
      TaskTitleSnapshot: 'Yeni olay',
      ProjectIdSnapshot: PROJECT_ID,
      TaskCount: 1,
      EventKey: 'cursor-ev-new',
      OccurredAt: '2026-10-09T10:00:00Z',
      ReadAt: null,
      DismissedAt: null,
      RowVersion: Buffer.alloc(8, 9)
    });

    const second = await asUser(EXTERNAL, () => page({ tab: 'history', page: 1, pageSize: 2, cursor: first.nextCursor }));
    const combined = [...first.items.map((item) => item.id), ...second.items.map((item) => item.id)];
    assert.equal(new Set(combined).size, 4, 'imleçli sayfalama araya yeni kayıt girse de yinelenen satır üretmez');
    assert.deepEqual(second.items.map((item) => item.taskTitle), ['Olay 2', 'Olay 1']);

    // Karar bekleyen tarih talebi `actionable` alanı taşımasa da imleçte a=1 olarak kodlanır.
    const scheduleCursor = inbox.encodeRequestInboxCursor({
      source: 'SCHEDULE_REQUEST', id: TASK_ID, isDecisionOwner: true, status: 'PENDING', taskAvailable: true, createdAt: '2026-10-05T10:00:00Z'
    });
    assert.equal(JSON.parse(Buffer.from(scheduleCursor, 'base64url').toString('utf8')).a, 1);

    // Geçersiz imleç 400 ile reddedilir ve sorgu tam geçmişi @items tablo değişkenine yığmaz.
    await assert.rejects(() => asUser(EXTERNAL, () => page({ tab: 'history', cursor: 'bozuk-imlec' })), (err) => err.status === 400);
    assert.doesNotMatch(read('src/server/notifications/requestInboxQueries.js'), /DECLARE @items TABLE/);
  } finally {
    await stack.dispose();
  }
});

function taskEvent(id, time) {
  return {
    NotificationId: id, RecipientSicil: EXTERNAL, Kind: 'TASK_ASSIGNED', TaskId: TASK_ID,
    ActorSicil: ORDINARY, TaskTitleSnapshot: id, ProjectIdSnapshot: PROJECT_ID, TaskCount: 1,
    EventKey: id, OccurredAt: time, ReadAt: null, DismissedAt: null, RowVersion: Buffer.alloc(8, 1)
  };
}

test('0015 öncesi Gelenler okuması okunmamış tarih talebi sonucunu sayar ve listeler', async () => {
  const requestId = '66666666-6666-4666-8666-000000000091';
  const stack = await createActualStack(seed({
    assignmentCoordinationSchemaMissing: true,
    taskScheduleChangeRequests: [{
      RequestId: requestId, TaskId: TASK_ID, RequesterSicil: ORDINARY, DecisionOwnerSicil: UNIT_MANAGER,
      Status: 'ACCEPTED', CreatedAt: '2026-10-02T10:00:00Z', DecidedAt: '2026-10-03T10:00:00Z'
    }]
  }), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const incoming = await page({ tab: 'pending' });
    assert.deepEqual(incoming.counts, { pending: 1, sent: 1, history: 1, coordination: 0 });
    assert.deepEqual(incoming.items.map((item) => item.id), [requestId]);
    await notificationQueries.markNotifications({ action: 'read', notifications: incoming.items });
    assert.equal((await page({ tab: 'pending' })).total, 0);
    assert.equal((await page({ tab: 'history' })).total, 1);
  } finally { await stack.dispose(); }
});

test('silinmiş görevin geçmiş kanıtı açık alıcı rolünü veya gerçek talep edeni gerektirir', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const record = await requestAssignment(stack);
    await asUser(UNIT_MANAGER, () => store.decideAssignmentCoordination(record.id, {
      decision: 'APPROVE', version: record.version
    }));
    stack.db.tasks = [];
    const managerRow = stack.db.assignmentCoordinationRecipients.find((row) => Number(row.Sicil) === UNIT_MANAGER);
    assert.equal(managerRow.RecipientRole, 'MANAGER');
    const evidence = (sicil) => withSqlTransaction((executor) =>
      coordinationQueries.readCoordinationPage(executor, { sicil }, { tab: 'history' }, { evidenceSnapshotLimit: 8 }));
    assert.equal((await evidence(UNIT_MANAGER)).total, 1);
    managerRow.RecipientRole = 'REQUESTER';
    assert.equal((await evidence(UNIT_MANAGER)).total, 0);
    assert.equal((await evidence(ORDINARY)).total, 1);
  } finally { await stack.dispose(); }
});

test('yedi basamaklı zaman ve GUID sırası imleç sınırında tüm satırları korur', async () => {
  const sameTime = '2026-10-04T10:00:00.1234567Z';
  const laterGuid = '11111111-0000-4000-8000-000000000002';
  const earlierGuid = 'aaaaaaaa-0000-4000-8000-000000000001';
  const earlierTime = 'aaaaaaaa-0000-4000-8000-000000000003';
  const stack = await createActualStack(seed({ taskNotifications: [
    taskEvent(earlierGuid, sameTime), taskEvent(laterGuid, sameTime),
    taskEvent(earlierTime, '2026-10-04T10:00:00.1234566Z')
  ] }), { sicil: EXTERNAL, corporateWbsSource: false });
  try {
    await asUser(EXTERNAL, async () => {
      let cursor;
      const ids = [];
      for (let index = 0; index < 3; index += 1) {
        const result = await page({ tab: 'history', page: index, pageSize: 1, cursor });
        ids.push(result.items[0]?.id);
        cursor = result.nextCursor;
        assert.equal(result.hasNext, index < 2);
        if (cursor) assert.equal(JSON.parse(Buffer.from(cursor, 'base64url')).t, sameTime);
      }
      assert.deepEqual(ids, [laterGuid, earlierGuid, earlierTime]);
    });
  } finally { await stack.dispose(); }
});

test('silinen önceki satırlar devamı gizlemez ve boş kalan imleç geçerli sayfaya döner', async () => {
  const events = [1, 2, 3, 4, 5, 6].map((index) => taskEvent(
    `66666666-6666-4666-8666-00000000004${index}`, `2026-10-0${index}T10:00:00Z`));
  const stack = await createActualStack(seed({ taskNotifications: events }), { sicil: EXTERNAL, corporateWbsSource: false });
  try {
    await asUser(EXTERNAL, async () => {
      const first = await page({ tab: 'pending', pageSize: 2 });
      const mark = (items) => notificationQueries.markNotifications({ action: 'read', notifications: items });
      await mark(first.items);
      const second = await page({ tab: 'pending', page: 1, pageSize: 2, cursor: first.nextCursor });
      assert.equal(second.total, 4);
      assert.deepEqual(second.items.map((item) => item.id), [events[3].NotificationId, events[2].NotificationId]);
      assert.ok(second.nextCursor, 'sayaçtaki son sayfa görünse de imleç sonrasında iki kayıt vardır');
      const third = await page({ tab: 'pending', page: 2, pageSize: 2, cursor: second.nextCursor });
      assert.equal(third.page, 2);
      assert.equal(third.hasNext, false);
      await mark(third.items);
      const clamped = await page({ tab: 'pending', page: 2, pageSize: 2, cursor: second.nextCursor });
      assert.equal(clamped.page, 0);
      assert.equal(clamped.cursorReset, true);
      assert.deepEqual(clamped.items.map((item) => item.id), second.items.map((item) => item.id));
    });
  } finally { await stack.dispose(); }
});

test('zil önizlemesi dışında kalan karar doğrulanır ve okuma yetkisi oturumdan gelir', async () => {
  const stack = await createActualStack(seed(), { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const created = await requestAssignment(stack);
    const decided = await asUser(UNIT_MANAGER, () => store.decideAssignmentCoordination(created.id, {
      decision: 'APPROVE', version: created.version
    }));
    const { actions } = actionsHarness({
      decide: async () => ({ ok: false, code: 'NETWORK' }),
      reload: async () => ({ ok: true, snapshot: { assignmentCoordinations: [] } }),
      readRecord: async (id) => ({ ok: true, value: await coordinationQueries.queryAssignmentCoordinations({ coordinationId: id }) })
    });
    const recovered = await asUser(UNIT_MANAGER, () => actions.decideAssignmentCoordination(created.id, { version: created.version }));
    assert.equal(recovered.reconciled, true);
    assert.equal(recovered.record.version, decided.record.version);
    assert.equal(recovered.record.status, 'APPROVED');
    const outsider = await asUser(OUTSIDER, () => coordinationQueries.queryAssignmentCoordinations({ coordinationId: created.id }));
    assert.equal(outsider.record, null);
    await assert.rejects(() => coordinationQueries.queryAssignmentCoordinations({ coordinationId: 'hatalı' }),
      (error) => error.status === 400);
  } finally { await stack.dispose(); }
});

test('yetki değiştiğinde aynı kayıt sürümünden eski karar düğmeleri geri gelmez', async (t) => {
  const record = { id: TASK_ID, mode: 'REQUEST', status: 'PENDING', version: 'v1', allowedDecisions: ['APPROVE'] };
  const current = { ...record, allowedDecisions: [] };
  const { actions } = actionsHarness({
    decide: async () => ({ ok: false, code: 'FORBIDDEN', message: 'Karar yetkisi değişti.' }),
    readRecord: async () => ({ ok: true, value: { record: current } })
  });
  const view = mountComponent(AssignmentCoordinationDialog, {
    record, loadRecord: async () => ({ ok: true, value: { record } }), onClose() {},
    onDecide: actions.decideAssignmentCoordination
  });
  t.after(() => view.unmount());
  await settleRead();
  view.render();
  const approve = () => findElement(view.output, (node) => node.type === 'button' && node.props?.['aria-busy'] === false);
  assert.ok(approve());
  await approve().props.onClick();
  view.render();
  assert.equal(approve(), null);
  assert.equal(findElement(view.output, (node) => node.props?.role === 'alert').props.children.at(-1), 'Karar yetkisi değişti.');
});

test('önceden okunan koordinasyon açılırken eski karar düğmeleri gösterilmez', async (t) => {
  const record = { id: TASK_ID, mode: 'REQUEST', status: 'PENDING', version: 'v1', allowedDecisions: ['APPROVE'], unread: false };
  const lookup = deferred();
  const loads = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    loads.push(String(url));
    return lookup.promise;
  });
  const modal = mountComponent(AssignmentCoordinationDialog, { record, onClose() {} });
  t.after(() => modal.unmount());
  const approve = (tree) => findElement(tree, (node) => node.type === 'button' && node.props?.['aria-busy'] === false);
  assert.equal(approve(modal.output), null);
  assert.equal(loads.length, 1);
  assert.ok(loads[0].endsWith(`?coordinationId=${TASK_ID}`));
  lookup.resolve(readResponse({ record: { ...record, status: 'REJECTED', version: 'v2', allowedDecisions: [] } }));
  await settleRead();
  modal.render();
  assert.equal(findElement(modal.output, (node) => node.type === 'h2').props.children, 'Atama talebi · Reddedildi');
  assert.equal(approve(modal.output), null);
});

test('liste yenilemesi aynı sürümde karar yetkisini kaldırınca açık pencere düğmeleri gizler', async (t) => {
  const record = { id: TASK_ID, mode: 'REQUEST', status: 'PENDING', version: 'v1', allowedDecisions: ['APPROVE'] };
  const refreshed = { ...record, allowedDecisions: [] };
  const followUp = deferred();
  let loads = 0;
  const props = {
    record, onClose() {}, loadRecord: async () => {
      loads += 1;
      return loads === 1 ? { ok: true, value: { record } } : followUp.promise;
    }
  };
  const dialog = mountComponent(AssignmentCoordinationDialog, props);
  t.after(() => dialog.unmount());
  const approve = () => findElement(dialog.output, (node) => node.type === 'button' && node.props?.['aria-busy'] === false);
  await settleRead();
  dialog.render();
  assert.ok(approve());
  dialog.render({ ...props, record: refreshed });
  assert.equal(approve(), null, 'aynı veri sürümündeki yeni yetkiler eski düğmeleri kapatır');
  assert.equal(loads, 2);
  followUp.resolve({ ok: true, value: { record: refreshed } });
  await settleRead();
  dialog.render();
  assert.equal(approve(), null);
});

test('taşınan görev için birleşik Geçmiş süzgeci satırda gösterilen projeyi kullanır', async () => {
  const secondProjectId = '66666666-6666-4666-8666-000000000006';
  const initial = seed();
  initial.projects.push({ ...initial.projects[0], ProjectId: secondProjectId, ProjectCode: 'P9600002', ProjectName: 'İkinci proje' });
  const stack = await createActualStack(initial, { sicil: ORDINARY, corporateWbsSource: false });
  try {
    const record = await requestAssignment(stack);
    await asUser(UNIT_MANAGER, () => store.decideAssignmentCoordination(record.id, {
      decision: 'APPROVE', version: record.version
    }));
    stack.db.tasks.find((row) => row.TaskId.toLowerCase() === TASK_ID).ProjectId = secondProjectId;
    const originalProject = await page({ tab: 'history', projectId: PROJECT_ID, category: 'ASSIGNMENT_REQUEST' });
    assert.equal(originalProject.items[0]?.id, record.id);
    assert.equal(originalProject.items[0].projectId, PROJECT_ID);
    assert.equal(originalProject.counts.history, 1);
    const secondProject = await page({ tab: 'history', projectId: secondProjectId, category: 'ASSIGNMENT_REQUEST' });
    assert.equal(secondProject.counts.history, 0);
    assert.equal(secondProject.items.length, 0);
  } finally { await stack.dispose(); }
});

test('Talepler gezinmesi imleçte kayıt varsa toplam küçülse de ilerler ve boşalan sınırı temizler', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const params = new URL(url, 'http://localhost').searchParams;
    const requested = Number(params.get('page'));
    const cursor = params.get('cursor');
    requests.push([requested, cursor]);
    const clamped = requested === 2;
    const data = { items: [], total: 26, page: clamped ? 0 : requested, pageSize: 25, counts: { pending: 26 },
      hasNext: !clamped, nextCursor: clamped ? null : `sonraki-${requested}`, cursorReset: clamped };
    return readResponse(data);
  });
  globalThis[CLIENT_STATE] = { projects: [], session: { dataMode: 'actual' }, actions: {} };
  const view = mountComponent(ScheduleRequestsView, {});
  t.after(() => { view.unmount(); delete globalThis[CLIENT_STATE]; });
  async function showResponse() {
    t.mock.timers.tick(250);
    await settleRead();
    view.render();
  }
  const navigate = () => {
    const pagination = findElement(view.output, (node) => node.type === TaskTablePagination);
    const controls = mountComponent(TaskTablePagination, pagination.props);
    const next = findElement(controls.output, (node) => node.props?.['aria-label'] === 'Sonraki talep sayfası');
    assert.equal(next.props.disabled, false);
    next.props.onClick();
    controls.unmount();
    view.render();
  };
  await showResponse();
  navigate();
  await showResponse();
  navigate();
  await showResponse();
  await showResponse();
  assert.deepEqual(requests, [[0, null], [1, 'sonraki-0'], [2, 'sonraki-1'], [0, null]]);
});

test('bozuk başarılı gelen kutusu yanıtı INVALID_RESPONSE olarak reddedilir ve geçici hata son geçerli veriyi silmez', async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: true, status: 200, async json() { return { broken: true }; } };
    }
    return {
      ok: true, status: 200,
      async json() {
        return { items: [{ id: 'n1', source: 'TASK_EVENT' }], total: 1, page: 0, pageSize: 25, counts: { pending: 1, sent: 0, history: 1, coordination: 0 } };
      }
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const malformed = await fetchRequestInbox({ tab: 'pending' });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'INVALID_RESPONSE');

  // Aynı sorgunun ikinci okuması başarısız olduğunda son geçerli liste korunur.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis[CLIENT_STATE] = { session: { dataMode: 'actual' }, scheduleRequestSummary: { unreadCount: 0, pendingCount: 0 }, notificationSummary: { unreadCount: 1, pendingCount: 0 } };
  t.after(() => { delete globalThis[CLIENT_STATE]; });
  let latest;
  function Probe({ query }) {
    latest = useRequestInboxQuery(query, true);
    return null;
  }
  const query = { tab: 'pending', page: 0 };
  const view = mountComponent(Probe, { query });
  t.after(() => view.unmount());
  t.mock.timers.tick(250);
  await new Promise((resolve) => setImmediate(resolve));
  view.render({ query });
  assert.equal(latest.data.items.length, 1, 'ilk geçerli veri yüklenir');

  // Sonraki yenileme geçici ağ hatası döndürür.
  globalThis.fetch = async () => { throw new Error('ağ koptu'); };
  latest.refresh();
  view.render({ query });
  t.mock.timers.tick(250);
  await new Promise((resolve) => setImmediate(resolve));
  view.render({ query });
  assert.equal(latest.data.items.length, 1, 'geçici hata son geçerli satırları silmez');
  assert.ok(latest.error, 'hata iletisi yine gösterilir');
});

test('okundu hatası asıl işlemi yineler ve kaldırılan satır kapatıldığında odağı etkin sekmeye verir', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const item = { id: 'c1', source: 'ASSIGNMENT_COORDINATION', mode: 'NOTICE', status: 'APPROVED', unread: true, version: 'v1', taskTitle: 'Görev' };
  let unread = true;
  const writes = [];
  t.mock.method(globalThis, 'fetch', async () => readResponse({
    items: unread ? [item] : [], total: unread ? 1 : 0, page: 0, pageSize: 25,
    hasNext: false, counts: { pending: unread ? 1 : 0, history: 1 }
  }));
  globalThis[CLIENT_STATE] = {
    projects: [], session: { dataMode: 'actual' }, actions: { markNotifications: async (items) => {
      writes.push(items);
      if (writes.length === 1) return { ok: false, message: 'İşaret kaydedilemedi' };
      unread = false;
      return { ok: true };
    } }
  };
  let focusedTarget;
  const activeTab = { isConnected: true, focus() { focusedTarget = 'sekme'; } };
  const row = { isConnected: true, focus() { focusedTarget = 'satır'; } };
  const documentStub = { addEventListener() {}, removeEventListener() {}, activeElement: row, body: {} };
  const originalRaf = globalThis.requestAnimationFrame;
  let rafCallback;
  globalThis.requestAnimationFrame = (fn) => { rafCallback = fn; return 1; };
  globalThis.document = documentStub;
  t.after(() => {
    globalThis.requestAnimationFrame = originalRaf;
    delete globalThis.document;
    delete globalThis[CLIENT_STATE];
  });
  const view = mountComponent(ScheduleRequestsView, {});
  t.after(() => view.unmount());
  t.mock.timers.tick(250);
  await settleRead();
  view.render();
  const tabs = findElement(view.output, (node) => node.props?.role === 'tablist');
  tabs.ref.current = { querySelector: () => activeTab };
  const rowButton = findElement(view.output, (node) => node.props?.className === 'detail-task-link');
  await rowButton.props.onClick({ currentTarget: row });
  view.render();
  const dialogElement = findElement(view.output, (node) => node.type === AssignmentCoordinationDialog);
  const dialog = mountComponent(dialogElement.type, dialogElement.props);
  const retry = findElement(view.output, (node) => node.type === 'button' && node.props?.children === 'Okundu işaretini yinele');
  assert.ok(retry);
  await retry.props.onClick();
  assert.deepEqual(writes, [[item], [item]]);
  view.render();
  t.mock.timers.tick(250);
  await settleRead();
  view.render();
  assert.equal(findElement(view.output, (node) => node.props?.role === 'alert'), null);
  assert.equal(findElement(view.output, (node) => node.props?.className === 'detail-task-link'), null);
  row.isConnected = false;
  findElement(dialog.output, (node) => node.props?.['aria-label'] === 'Kapat').props.onClick();
  view.render();
  assert.equal(findElement(view.output, (node) => node.type === AssignmentCoordinationDialog), null);
  dialog.unmount();
  assert.equal(typeof rafCallback, 'function');
  rafCallback();
  assert.equal(focusedTarget, 'sekme');
});
