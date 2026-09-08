import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createMockRepository } from '../src/data/mock/createMockRepository.js';
import {
  dataRefreshFailure,
  dataRefreshLabel,
  dataRefreshTitle
} from '../src/components/shell/dataRefreshLabel.js';
import { appStateReducer, createInitialState } from '../src/state/appState.js';
import {
  createDataRefreshRequestGuard,
  createDataRefreshSingleFlight,
  resolvePersistenceDataRefreshSafety
} from '../src/state/dataRefreshSafety.js';
import { createStateMutationOrchestrator } from '../src/state/persistence.js';
import {
  createDataReloadOperation,
  dataReloadSingleFlightOptions
} from '../src/state/dataReloadLifecycle.js';
import { describeSaveError } from '../src/components/shell/persistenceStatusMessage.js';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';
import {
  paginateTaskRows,
  synchronizeTaskTablePageState,
  taskTablePageForReset,
  TASK_TABLE_PAGE_SIZE
} from '../src/features/tasks/taskTablePagination.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('uygulama düzeyi yenileme denetimi tarayıcı gezinmesi yerine veri yaşam döngüsünü çağırır', () => {
  const control = read('src/components/shell/DataRefreshControl.jsx');
  const shell = read('src/components/shell/AppShell.jsx');
  assert.match(control, /const result = await reloadData\(\)/);
  assert.match(control, /disabled=\{busy\}/);
  assert.match(control, /aria-busy=\{busy\}/);
  assert.doesNotMatch(control, /window\.location|location\.reload|router\.refresh/);
  assert.match(shell, /<DataRefreshControl \/>/);
});

test('yenileme simgesi 24x24 merkezinde döner ve azaltılmış hareketi gözetir', () => {
  const control = read('src/components/shell/DataRefreshControl.jsx');
  const icons = read('src/components/icons.jsx');
  const css = read('src/app/styles/shell.css');
  assert.match(control, /<Icons\.Refresh size=\{13\} className=\{busy \? 'is-spinning' : ''\} \/>/);
  assert.match(icons, /Refresh:[\s\S]*?M20 7v5h-5[\s\S]*?M4 17v-5h5/);
  assert.match(css, /\.data-refresh-control \.is-spinning[\s\S]*?transform-box: view-box;[\s\S]*?transform-origin: center;/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?\.data-refresh-control \.is-spinning \{ animation: none; \}/);
});

test('son başarılı veri yükleme zamanı kayıt zamanından ayrı güncellenir', () => {
  const refreshedAt = '2026-08-27T09:47:00.000Z';
  const current = { ...createInitialState(), lastSavedAt: '2026-08-27T09:40:00.000Z' };
  const next = appStateReducer(current, {
    type: 'data/load-success',
    snapshot: { projects: [], tasks: [], wbs: [] },
    refreshedAt
  });

  assert.equal(next.lastRefreshedAt, refreshedAt);
  assert.equal(next.lastSavedAt, current.lastSavedAt);
  assert.equal(dataRefreshLabel(new Date(2026, 7, 27, 9, 47), new Date(2026, 7, 27, 12, 0)), 'Son güncelleme 09:47');
  assert.match(dataRefreshTitle(new Date(2026, 7, 27, 9, 47)), /Son başarılı veri yüklemesi:/);
});

test('yenileme düğmesi bütün veri yaşam döngüsü hatalarını ve yerel engelleri gösterir', () => {
  assert.equal(dataRefreshFailure({ dataStatus: 'ready' }), null);
  assert.equal(dataRefreshFailure({
    dataStatus: 'error',
    loadError: { message: 'Sunucuya ulaşılamadı' }
  }), 'Sunucuya ulaşılamadı');
  assert.equal(dataRefreshFailure({
    localFailure: 'Kaydedilmemiş değişiklik var',
    dataStatus: 'error',
    loadError: { message: 'Sunucuya ulaşılamadı' }
  }), 'Kaydedilmemiş değişiklik var');
});

test('daha yeni yenilemenin gerisinde kalan hata çağırana başarısızlık olarak dönmez', () => {
  const requests = createDataRefreshRequestGuard();
  const first = requests.begin();
  const second = requests.begin();

  assert.deepEqual(first.settle({ ok: false, error: { code: 'LOAD_FAILED' } }), {
    ok: true,
    value: null,
    superseded: true
  });
  assert.deepEqual(second.settle({ ok: true, snapshot: {} }), { ok: true, snapshot: {} });
});

test('manuel ve otomatik yenilemeler ortak tek-uçuş sınırında üst üste binmez', async () => {
  const singleFlight = createDataRefreshSingleFlight();
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const first = singleFlight.run(async () => {
    calls += 1;
    await pending;
    return { ok: true };
  }, dataReloadSingleFlightOptions('automatic'));
  const queuedManual = singleFlight.run(async () => {
    calls += 1;
    return { ok: true };
  }, dataReloadSingleFlightOptions('manual'));
  const skippedAutomatic = await singleFlight.run(async () => {
    calls += 1;
    return { ok: true };
  }, dataReloadSingleFlightOptions('automatic'));

  assert.notStrictEqual(queuedManual, first);
  assert.equal(calls, 1);
  assert.equal(skippedAutomatic.skipped, true);
  release();
  await first;
  await queuedManual;
  assert.equal(calls, 2);

  await singleFlight.run(async () => {
    calls += 1;
    return { ok: true };
  });
  assert.equal(calls, 3);
});

test('başarısız veri yenilemesi mevcut uygulama anlık görüntüsünü korur', async () => {
  const repository = createMockRepository();
  const snapshot = await repository.loadSnapshot();
  const current = createInitialState(snapshot);
  const next = appStateReducer(current, {
    type: 'data/load-error',
    error: { code: 'LOAD_FAILED', message: 'Bağlantı yok' }
  });

  assert.strictEqual(next.tasks, current.tasks);
  assert.strictEqual(next.projects, current.projects);
  assert.equal(next.dataStatus, 'error');
});

test('eşdeğer snapshot değişmeyen varlık ve koleksiyon referanslarını korur', async () => {
  const repository = createMockRepository();
  const current = createInitialState(await repository.loadSnapshot());
  const replacement = structuredClone(await repository.loadSnapshot());
  const next = appStateReducer(current, { type: 'data/load-success', snapshot: replacement });

  for (const key of ['projects', 'tasks', 'wbs', 'people', 'calendars', 'baselines', 'taskBaselineSnapshots']) {
    assert.strictEqual(next[key], current[key], `${key} koleksiyonu kararlı kalmalıdır`);
  }
});

test('manuel yenileme seçili proje çalışma alanını ve açık görev çekmecesini sökmez', async () => {
  const repository = createMockRepository();
  const snapshot = await repository.loadSnapshot();
  const task = snapshot.tasks[0];
  let current = createInitialState(snapshot);
  current = appStateReducer(current, {
    type: 'workspace/select',
    workspaceMode: 'project',
    selectedProjectId: task.projectId
  });
  current = appStateReducer(current, { type: 'task/select', id: task.id });

  const loading = appStateReducer(current, { type: 'data/load-start' });
  assert.equal(loading.hasLoadedOnce, true);
  assert.equal(loading.selectedTaskId, task.id);
  assert.equal(loading.selectedProjectId, task.projectId);

  const refreshed = appStateReducer(loading, {
    type: 'data/load-success',
    snapshot: structuredClone(snapshot)
  });
  assert.equal(refreshed.workspaceMode, 'project');
  assert.equal(refreshed.selectedProjectId, task.projectId);
  assert.equal(refreshed.selectedTaskId, task.id);
  assert.strictEqual(
    refreshed.tasks.find((entry) => entry.id === task.id),
    current.tasks.find((entry) => entry.id === task.id)
  );
});

test('yapısal paylaşım yetkiden çıkan kayıtları önceki snapshot üzerinden geri getirmez', async () => {
  const repository = createMockRepository();
  const snapshot = await repository.loadSnapshot();
  const current = createInitialState(snapshot);
  const removedTaskId = snapshot.tasks[0].id;
  const next = appStateReducer(current, {
    type: 'data/load-success',
    snapshot: { ...structuredClone(snapshot), tasks: snapshot.tasks.slice(1) }
  });

  assert.equal(next.tasks.some((task) => task.id === removedTaskId), false);
  assert.notStrictEqual(next.tasks, current.tasks);
});

test('yenileme yaşam döngüsü büyük uygulama bağlamından ve pahalı seçici bağımlılıklarından ayrıdır', () => {
  const provider = read('src/state/AppStateProvider.jsx');
  const hooks = read('src/state/hooks/index.js');
  assert.match(provider, /const DataLifecycleContext = createContext\(null\)/);
  const applicationState = provider.match(/const applicationState = \{([\s\S]*?)\n    \};\n    return/);
  assert.ok(applicationState);
  assert.doesNotMatch(applicationState[1], /dataStatus|hasLoadedOnce|loadError|lastRefreshedAt/);
  assert.match(provider, /const workspace = useMemo\(\(\) => selectWorkspaceContext\(\{/);
  assert.doesNotMatch(provider, /selectWorkspaceContext\(state\), \[state\]/);
  assert.match(provider, /buildPortfolioSchedule[\s\S]*?\[state\.tasks, state\.projects, state\.calendars\]/);
  assert.match(hooks, /return useDataLifecycleState\(\)/);
});

test('ilk yükleme ile manuel ve otomatik yenileme katalog eşitlemesine doğru niyeti gönderir', async () => {
  const refreshModes = [];
  const repository = {
    async loadSnapshot({ refreshMode }) {
      refreshModes.push(refreshMode);
      return {
        projects: [], tasks: [], wbs: [], people: [], calendars: [],
        session: { dataMode: 'actual', projectAccess: [] }
      };
    }
  };
  const actions = [];
  const persistence = {
    flush: async () => ({ ok: true }),
    hasFailedTaskUpdates: () => false,
    runSerialized: async (operation) => operation(),
    discardFailedTaskUpdates() {},
    rebaseFailedTaskUpdates(snapshot) { return { snapshot, missingTaskIds: [] }; }
  };
  const runDataReload = createDataReloadOperation({
    repository,
    persistence,
    getState: () => ({ hasLoadedOnce: false }),
    applyStateAction: (action) => actions.push(action),
    requestGuard: createDataRefreshRequestGuard(),
    now: () => '2026-08-31T12:00:00.000Z'
  });
  const initial = await runDataReload({ refreshMode: 'initial' });

  assert.equal(initial.ok, true);
  assert.deepEqual(refreshModes, ['initial']);
  assert.deepEqual(actions.map((action) => action.type), ['data/load-start', 'data/load-success']);
  assert.equal(actions[1].refreshedAt, '2026-08-31T12:00:00.000Z');

  registerServerOnlyShim();
  const { loadSnapshotForRequest } = await import('../src/app/api/mergen-rota/snapshot/route.js');
  const catalogSyncModes = [];
  const routeRepository = {
    async loadSnapshotWithSession({ catalogSync }) {
      catalogSyncModes.push(catalogSync);
      return { tasks: [] };
    }
  };
  await loadSnapshotForRequest(new Request('http://localhost/snapshot', {
    headers: { 'x-mergen-rota-refresh-mode': 'initial' }
  }), routeRepository);
  await loadSnapshotForRequest(new Request('http://localhost/snapshot', {
    headers: { 'x-mergen-rota-refresh-mode': 'automatic' }
  }), routeRepository);
  await loadSnapshotForRequest(new Request('http://localhost/snapshot', {
    headers: { 'x-mergen-rota-refresh-mode': 'manual' }
  }), routeRepository);
  assert.deepEqual(catalogSyncModes, [
    'blocking-before',
    'background-after',
    'background-after'
  ]);
});

test('otomatik istek sürerken gelen manuel yenileme kendi hata yaşam döngüsünü çalıştırır', async () => {
  const singleFlight = createDataRefreshSingleFlight();
  const refreshModes = [];
  let releaseAutomatic;
  const automaticPending = new Promise((resolve) => { releaseAutomatic = resolve; });
  const repository = {
    async loadSnapshot({ refreshMode }) {
      refreshModes.push(refreshMode);
      if (refreshMode === 'automatic') await automaticPending;
      throw Object.assign(new Error('Bağlantı yok'), { code: 'LOAD_FAILED' });
    }
  };
  const actions = [];
  const persistence = {
    flush: async () => ({ ok: true }),
    hasFailedTaskUpdates: () => false,
    runSerialized: async (operation) => operation(),
    discardFailedTaskUpdates() {},
    rebaseFailedTaskUpdates(snapshot) { return { snapshot, missingTaskIds: [] }; }
  };
  const runDataReload = createDataReloadOperation({
    repository,
    persistence,
    getState: () => ({ hasLoadedOnce: true }),
    applyStateAction: (action) => actions.push(action),
    requestGuard: createDataRefreshRequestGuard()
  });

  const automatic = singleFlight.run(
    () => runDataReload({ refreshMode: 'automatic' }),
    dataReloadSingleFlightOptions('automatic')
  );
  const manual = singleFlight.run(
    () => runDataReload({ refreshMode: 'manual' }),
    dataReloadSingleFlightOptions('manual')
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(refreshModes, ['automatic']);
  releaseAutomatic();
  await automatic;
  const manualResult = await manual;

  assert.equal(manualResult.ok, false);
  assert.deepEqual(refreshModes, ['automatic', 'manual']);
  assert.deepEqual(actions.map((action) => action.type), ['data/load-start', 'data/load-error']);
});

test('büyük görev tabloları tüm satırları aynı anda render etmek yerine erişilebilir sayfalara ayrılır', () => {
  const rows = Array.from({ length: TASK_TABLE_PAGE_SIZE * 2 + 7 }, (_, id) => ({ id }));
  const first = paginateTaskRows(rows, 0);
  const last = paginateTaskRows(rows, 99);
  assert.equal(first.rows.length, TASK_TABLE_PAGE_SIZE);
  assert.equal(first.pageCount, 3);
  assert.equal(last.page, 2, 'geçersiz/eski sayfa numarası güvenle son sayfaya sıkıştırılmalıdır');
  assert.equal(last.rows.length, 7);

  const advanced = read('src/features/tasks/TasksView.jsx');
  const simple = read('src/features/tasks/SimpleTasksView.jsx');
  const control = read('src/features/tasks/TaskTablePagination.jsx');
  assert.match(advanced, /paged\.rows\.map/);
  assert.match(simple, /paged\.rows\.map/);
  assert.match(control, /label = 'Görev sayfaları'/);
  assert.match(control, /aria-label=\{label\}/);
});

test('görev sayfalama girdileri sınırlandırılır ve geçersiz sayfa boyutları reddedilir', () => {
  const rows = Array.from({ length: 250 }, (_, id) => ({ id }));
  assert.equal(paginateTaskRows(rows, 1.9).page, 1);
  assert.equal(paginateTaskRows(rows, Number.POSITIVE_INFINITY).page, 0);
  assert.equal(paginateTaskRows(rows, -4).page, 0);

  for (const pageSize of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.throws(() => paginateTaskRows(rows, 0, pageSize), RangeError);
  }
});

test('süzgeç sıfırlaması ve azalan satır sayısı eski saklanan sayfayı göstermeden eşitlenir', () => {
  const stale = { page: 2, resetKey: 'önceki-süzgeç' };
  assert.equal(taskTablePageForReset(stale.page, stale.resetKey, 'yeni-süzgeç'), 0);
  assert.deepEqual(
    synchronizeTaskTablePageState(stale, 'yeni-süzgeç', 0),
    { page: 0, resetKey: 'yeni-süzgeç' }
  );

  const rowsReduced = { page: 2, resetKey: 'aynı-süzgeç' };
  assert.deepEqual(
    synchronizeTaskTablePageState(rowsReduced, 'aynı-süzgeç', 1),
    { page: 1, resetKey: 'aynı-süzgeç' }
  );
});

test('koruyucu veri yüklemesi kayıt hatasını görünür tutar', () => {
  const saveError = { code: 'MUTATION_FAILED', message: 'Görev kaydedilemedi' };
  const current = { ...createInitialState(), saveError };
  const next = appStateReducer(current, {
    type: 'data/load-success',
    snapshot: { projects: [], tasks: [], wbs: [] },
    preserveSaveError: true
  });

  assert.strictEqual(next.saveError, saveError);
});

test('rutin yenileme saklanan başarısız görev değişikliklerini sessizce atmaz', async () => {
  const repository = createMockRepository(undefined, { failNextMutation: true });
  let state = createInitialState(await repository.loadSnapshot());
  const persistence = createStateMutationOrchestrator({
    repository,
    getState: () => state,
    applyStateAction(action) { state = appStateReducer(state, action); },
    taskPatchDelayMs: 0
  });

  const result = await persistence.updateTask('t1', { task: 'Kaybolmaması gereken başlık' });
  assert.equal(result.ok, false);
  assert.equal(persistence.hasPendingChanges(), true);
  assert.equal(persistence.hasFailedTaskUpdates(), true);
  assert.equal((await persistence.flush()).ok, true);
  assert.equal(persistence.hasFailedTaskUpdates(), true);

  const blocked = resolvePersistenceDataRefreshSafety(persistence);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'UNSAVED_TASK_CHANGES');

  const explicitDiscard = resolvePersistenceDataRefreshSafety(persistence, {
    discardFailedTaskUpdates: true
  });
  assert.deepEqual(explicitDiscard, { ok: true, discardFailedTaskUpdates: true });

  const internalReconciliation = resolvePersistenceDataRefreshSafety(persistence, {
    preserveFailedTaskUpdates: true
  });
  assert.deepEqual(internalReconciliation, { ok: true, discardFailedTaskUpdates: false });

  const serverSnapshot = await repository.loadSnapshot();
  const rebased = persistence.rebaseFailedTaskUpdates(serverSnapshot);
  assert.equal(rebased.snapshot.tasks.find((task) => task.id === 't1').task, 'Kaybolmaması gereken başlık');
  assert.deepEqual(rebased.missingTaskIds, []);

  const missing = persistence.rebaseFailedTaskUpdates({ ...serverSnapshot, tasks: [] });
  assert.deepEqual(missing.missingTaskIds, ['t1']);

  const provider = read('src/state/AppStateProvider.jsx');
  const lifecycle = read('src/state/dataReloadLifecycle.js');
  const status = read('src/components/shell/PersistenceStatus.jsx');
  assert.match(provider, /createDataReloadOperation\(\{/);
  assert.match(lifecycle, /const refreshSafety = resolvePersistenceDataRefreshSafety\(persistence/);
  assert.match(lifecycle, /persistence\.runSerialized\(async \(\) =>/);
  assert.match(lifecycle, /persistence\.rebaseFailedTaskUpdates\(result\.snapshot\)/);
  assert.match(provider, /reloadData\(\{ preserveFailedTaskUpdates: true \}\)/);
  assert.match(lifecycle, /if \(refreshSafety\.discardFailedTaskUpdates\) persistence\.discardFailedTaskUpdates\(\)/);
  assert.match(status, /onClick=\{\(\) => reload\(\{ allowDiscard: true \}\)\}/);
  persistence.dispose();
});

test('korunan başarısız görev yaması görünür kalır ve yeniden denenebilir', async () => {
  const repository = createMockRepository(undefined, { failNextMutation: true });
  let state = createInitialState(await repository.loadSnapshot());
  const persistence = createStateMutationOrchestrator({
    repository,
    getState: () => state,
    applyStateAction(action) { state = appStateReducer(state, action); },
    taskPatchDelayMs: 0
  });

  const failed = await persistence.updateTask('t1', { task: 'Korunan başlık' });
  assert.equal(failed.ok, false);
  const rebased = persistence.rebaseFailedTaskUpdates(await repository.loadSnapshot());
  state = appStateReducer(state, {
    type: 'data/load-success',
    snapshot: rebased.snapshot,
    preserveSaveError: true
  });
  assert.equal(state.tasks.find((task) => task.id === 't1').task, 'Korunan başlık');
  assert.equal(describeSaveError(state.saveError)?.code, 'MUTATION_FAILED');

  const retried = await persistence.retryFailedTaskUpdates();
  assert.equal(retried.every((result) => result.ok), true);
  assert.equal(persistence.hasFailedTaskUpdates(), false);
  state = appStateReducer(state, { type: 'persistence/clear-error' });
  assert.equal(state.saveError, null);
  persistence.dispose();
});

test('silinmiş göreve ait korunan yama yeniden denendiğinde başarısız kalır', async () => {
  const repository = createMockRepository(undefined, { failNextMutation: true });
  let state = createInitialState(await repository.loadSnapshot());
  const persistence = createStateMutationOrchestrator({
    repository,
    getState: () => state,
    applyStateAction(action) { state = appStateReducer(state, action); },
    taskPatchDelayMs: 0
  });

  assert.equal((await persistence.updateTask('t1', { task: 'Yetim başlık' })).ok, false);
  const snapshotWithoutTask = { ...await repository.loadSnapshot(), tasks: [] };
  const rebased = persistence.rebaseFailedTaskUpdates(snapshotWithoutTask);
  assert.deepEqual(rebased.missingTaskIds, ['t1']);
  state = appStateReducer(state, {
    type: 'data/load-success',
    snapshot: rebased.snapshot,
    preserveSaveError: true
  });

  const retried = await persistence.retryFailedTaskUpdates();
  assert.equal(retried[0].ok, false);
  assert.equal(retried[0].error.code, 'TASK_NOT_FOUND');
  assert.equal(persistence.hasFailedTaskUpdates(), true);
  persistence.dispose();
});

test('yenileme bariyeri daha yeni görev mutasyonunu anlık görüntünün arkasında bırakmaz', async () => {
  const repository = createMockRepository();
  const originalCommit = repository.commitChanges.bind(repository);
  const events = [];
  repository.commitChanges = async (changes, options) => {
    events.push('mutation');
    return originalCommit(changes, options);
  };
  let state = createInitialState(await repository.loadSnapshot());
  const persistence = createStateMutationOrchestrator({
    repository,
    getState: () => state,
    applyStateAction(action) { state = appStateReducer(state, action); },
    taskPatchDelayMs: 0
  });
  let releaseLoad;
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  const refresh = persistence.runSerialized(async () => {
    events.push('load-start');
    await loadGate;
    events.push('load-apply');
  });
  await Promise.resolve();

  const mutation = persistence.updateTask('t1', { task: 'Yenilemeden sonraki başlık' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ['load-start']);

  releaseLoad();
  await refresh;
  await mutation;
  assert.deepEqual(events, ['load-start', 'load-apply', 'mutation']);
  assert.equal(state.tasks.find((task) => task.id === 't1').task, 'Yenilemeden sonraki başlık');
  persistence.dispose();
});
