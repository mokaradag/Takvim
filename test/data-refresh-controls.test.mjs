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
  resolvePersistenceDataRefreshSafety
} from '../src/state/dataRefreshSafety.js';
import { createStateMutationOrchestrator } from '../src/state/persistence.js';
import { describeSaveError } from '../src/components/shell/persistenceStatusMessage.js';

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
  const status = read('src/components/shell/PersistenceStatus.jsx');
  assert.match(provider, /const refreshSafety = resolvePersistenceDataRefreshSafety\(persistence/);
  assert.match(provider, /persistence\.runSerialized\(async \(\) =>/);
  assert.match(provider, /persistence\.rebaseFailedTaskUpdates\(result\.snapshot\)/);
  assert.match(provider, /reloadData\(\{ preserveFailedTaskUpdates: true \}\)/);
  assert.match(provider, /if \(refreshSafety\.discardFailedTaskUpdates\) persistence\.discardFailedTaskUpdates\(\)/);
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
