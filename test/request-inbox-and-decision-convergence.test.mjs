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
const { requestInboxRow, requestInboxKey } = await import('../src/features/schedule-change/requestInboxPresentation.js');
const { AssignmentCoordinationDialog } = await import('../src/features/assignment-coordination/AssignmentCoordinationDialog.jsx');
const { ScheduleRequestsView } = await import('../src/features/schedule-change/ScheduleRequestsView.jsx');
const store = await import('../src/server/assignment/assignmentCoordinationStore.js');
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

function actionsHarness({ decide, reload = async () => ({ ok: true }), mark } = {}) {
  const calls = { decide: 0, reload: 0, applied: [] };
  let sequence = 0;
  const actions = createNotificationActions({
    isActualMode: () => true,
    flush: async () => ({ ok: true }),
    reloadData: async (...args) => { calls.reload += 1; return reload(...args); },
    applyStateAction: (action) => calls.applied.push(action),
    beginInboxRead: () => ++sequence,
    markItems: mark || (async () => ({ ok: true, value: { ok: true } })),
    decideCoordination: async (...args) => { calls.decide += 1; return decide(...args); }
  });
  return { actions, calls };
}

test('belirsiz karar sonucu yeniden gönderilmez; önce güncel durum okunur', async () => {
  const { actions, calls } = actionsHarness({ decide: async () => ({ ok: false, code: 'NETWORK', message: 'Sunucuya ulaşılamadı.' }) });
  const result = await actions.decideAssignmentCoordination('c1', { decision: 'APPROVE', version: 'v1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OUTCOME_UNKNOWN');
  assert.equal(result.message, OUTCOME_UNKNOWN_MESSAGE);
  assert.equal(calls.decide, 1, 'karar isteği tekrarlanmaz');
  assert.equal(calls.reload, 1, 'yetkili durum yeniden okunur');

  // Yenileme de başarısızsa ileti durumun yüklendiğini İDDİA etmez.
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
  const { actions, calls } = actionsHarness({ decide: async () => ({ ok: false, code: 'CONFLICT', message: 'Koordinasyon kaydı bu sırada güncellendi.' }) });
  const result = await actions.decideAssignmentCoordination('c1', { decision: 'REJECT', version: 'eski' });
  assert.equal(result.code, 'CONFLICT');
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

test('Atama Koordinasyonu sayacı karar bekleyen sayısından değil kayıt sayısından gelir', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis[CLIENT_STATE] = { projects: [], actions: {}, session: { dataMode: 'demo' }, notificationSummary: { unreadCount: 0, pendingCount: 0 } };
  t.after(() => { delete globalThis[CLIENT_STATE]; });
  const view = mountComponent(ScheduleRequestsView, {});
  t.after(() => view.unmount());
  const source = read('src/features/schedule-change/ScheduleRequestsView.jsx');
  assert.doesNotMatch(source, /notificationSummary\.pendingCount/);
  assert.match(source, /<AssignmentCoordinationView onTotalChange=\{setCoordinationTotal\} \/>/);
  const coordinationSource = read('src/features/assignment-coordination/AssignmentCoordinationView.jsx');
  assert.match(coordinationSource, /const allCount = data\.counts\.all;/);
  assert.match(read('src/server/assignment/assignmentCoordinationQueries.js'), /all: Number\(counts\.Total \|\| 0\)/);
});

test('karar penceresi yenileme hatasında açık kalır ve sunucunun döndürdüğü kaydı gösterir', async (t) => {
  globalThis.document = { addEventListener() {}, removeEventListener() {}, activeElement: null };
  let closed = false;
  const record = { id: 'c1', status: 'PENDING', mode: 'REQUEST', version: 'v1', allowedDecisions: ['APPROVE', 'REJECT'], taskTitle: 'Görev', assigneeName: 'Dış', requesterName: 'Talep' };
  const view = mountComponent(AssignmentCoordinationDialog, {
    record, onClose: () => { closed = true; }, onOpenTask: async () => ({ ok: true }),
    onDecide: async () => ({ ok: true, value: { outcome: 'APPROVED', message: 'Atama onaylandı.', record: { ...record, status: 'APPROVED', version: 'v2', allowedDecisions: [] } }, refreshError: { message: 'Bağlantı yok' } })
  });
  t.after(() => { view.unmount(); delete globalThis.document; });
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
  assert.match(fallback || '', /var\(--app-viewport-h, 100vh\) \* \.65/);
  // Sabit piksel yükseklikleri yerine ölçekli görünüm değişkeni kullanılır.
  assert.doesNotMatch(read('src/app/styles/features.css').match(/Talepler · tam yükseklikli[\s\S]*?\n}\n}/)?.[0] || '', /100vh\s*-/);
});
