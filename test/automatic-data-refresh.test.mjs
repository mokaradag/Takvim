import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createMockRepository } from '../src/data/mock/createMockRepository.js';
import {
  automaticDataRefreshInterval,
  createAutomaticDataRefreshController,
  DEFAULT_AUTO_REFRESH_INTERVAL_MS,
  MAX_AUTO_REFRESH_INTERVAL_MS,
  MIN_AUTO_REFRESH_INTERVAL_MS,
  resolveAutomaticDataRefreshInterval,
  shouldSurfaceAutomaticRefreshFailure,
  supportsAutomaticDataRefresh
} from '../src/state/automaticDataRefresh.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function createVisibilitySource(initial = 'visible') {
  const listeners = new Set();
  return {
    visibilityState: initial,
    addEventListener(type, listener) {
      if (type === 'visibilitychange') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'visibilitychange') listeners.delete(listener);
    },
    change(next) {
      this.visibilityState = next;
      for (const listener of [...listeners]) listener();
    },
    get listenerCount() { return listeners.size; }
  };
}

function createClock(initial = 0) {
  let current = initial;
  let sequence = 0;
  const timers = new Map();
  const timerApi = {
    setTimeout(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, dueAt: current + Math.max(0, delay) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };

  async function settle() {
    await new Promise((resolve) => setImmediate(resolve));
  }

  async function advance(milliseconds) {
    const target = current + milliseconds;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      current = timer.dueAt;
      timer.callback();
      await settle();
    }
    current = target;
    await settle();
  }

  return {
    timerApi,
    now: () => current,
    set: (milliseconds) => { current = milliseconds; },
    advance,
    settle,
    get nextDelay() {
      const nextDue = [...timers.values()]
        .map((timer) => timer.dueAt)
        .sort((left, right) => left - right)[0];
      return nextDue == null ? null : nextDue - current;
    },
    get timerCount() { return timers.size; }
  };
}

function createController({ clock, visibility, refresh, getLastRefreshedAt } = {}) {
  return createAutomaticDataRefreshController({
    intervalMs: DEFAULT_AUTO_REFRESH_INTERVAL_MS,
    refresh,
    getLastRefreshedAt,
    visibilitySource: visibility,
    timerApi: clock.timerApi,
    now: clock.now
  });
}

test('otomatik yenileme varsayılanı 60 saniye, güvenli alt sınırı 30 saniyedir', () => {
  assert.equal(DEFAULT_AUTO_REFRESH_INTERVAL_MS, 60000);
  assert.equal(MIN_AUTO_REFRESH_INTERVAL_MS, 30000);
  assert.equal(MAX_AUTO_REFRESH_INTERVAL_MS, 2147483647);
  assert.equal(resolveAutomaticDataRefreshInterval(undefined), 60000);
  assert.equal(resolveAutomaticDataRefreshInterval(null), 60000);
  assert.equal(resolveAutomaticDataRefreshInterval(''), 60000);
});

test('geçerli ortam değeri otomatik yenileme aralığını değiştirir', () => {
  assert.equal(resolveAutomaticDataRefreshInterval('90000'), 90000);
  const previous = process.env.NEXT_PUBLIC_MERGEN_ROTA_AUTO_REFRESH_INTERVAL_MS;
  try {
    process.env.NEXT_PUBLIC_MERGEN_ROTA_AUTO_REFRESH_INTERVAL_MS = '120000';
    assert.equal(automaticDataRefreshInterval(), 120000);
  } finally {
    if (previous == null) delete process.env.NEXT_PUBLIC_MERGEN_ROTA_AUTO_REFRESH_INTERVAL_MS;
    else process.env.NEXT_PUBLIC_MERGEN_ROTA_AUTO_REFRESH_INTERVAL_MS = previous;
  }
});

test('geçersiz, sıfır, negatif ve alt sınırdan küçük aralıklar 60 saniyeye döner', () => {
  for (const value of ['abc', '0', '-1', '1', '29999', '60000.5', 'Infinity', '2147483648']) {
    assert.equal(resolveAutomaticDataRefreshInterval(value), 60000, value);
  }
  assert.equal(resolveAutomaticDataRefreshInterval('30000'), 30000);
});

test('görünür sayfada yapılandırılmış süre dolunca veri yenilenir', async () => {
  const clock = createClock();
  const visibility = createVisibilitySource();
  let calls = 0;
  const controller = createController({
    clock,
    visibility,
    refresh: async () => { calls += 1; return { ok: true }; }
  });
  controller.start();

  await clock.advance(59999);
  assert.equal(calls, 0);
  await clock.advance(1);
  assert.equal(calls, 1);
  controller.stop();
});

test('açılıştaki eski kayıt zamanı yeni başlangıç zamanı ile tazelenmiş sayılmaz', async () => {
  const clock = createClock(180000);
  const visibility = createVisibilitySource();
  let calls = 0;
  const controller = createController({
    clock,
    visibility,
    getLastRefreshedAt: () => new Date(60000).toISOString(),
    refresh: async () => { calls += 1; return { ok: true }; }
  });
  controller.start();
  await clock.advance(0);

  assert.equal(calls, 1);
  controller.stop();
});

test('düzeltilmiş saat gelecekteki kayıt zamanına kadar yenilemeyi ertelemez', async () => {
  const clock = createClock();
  const visibility = createVisibilitySource();
  let calls = 0;
  const controller = createController({
    clock,
    visibility,
    getLastRefreshedAt: () => new Date(MAX_AUTO_REFRESH_INTERVAL_MS).toISOString(),
    refresh: async () => { calls += 1; return { ok: true }; }
  });
  controller.start();

  assert.equal(clock.nextDelay, DEFAULT_AUTO_REFRESH_INTERVAL_MS);
  await clock.advance(DEFAULT_AUTO_REFRESH_INTERVAL_MS - 1);
  assert.equal(calls, 0);
  await clock.advance(1);
  assert.equal(calls, 1);
  controller.stop();
});

test('çalışma sırasında geri alınan saat yeni bir güvenli zamanlama başlangıcı kurar', async () => {
  const clock = createClock(MAX_AUTO_REFRESH_INTERVAL_MS + DEFAULT_AUTO_REFRESH_INTERVAL_MS);
  const visibility = createVisibilitySource();
  let calls = 0;
  const controller = createController({
    clock,
    visibility,
    refresh: async () => { calls += 1; return { ok: true }; }
  });
  controller.start();
  await clock.advance(DEFAULT_AUTO_REFRESH_INTERVAL_MS);
  assert.equal(calls, 1);

  visibility.change('hidden');
  clock.set(0);
  visibility.change('visible');
  assert.equal(clock.nextDelay, DEFAULT_AUTO_REFRESH_INTERVAL_MS);
  await clock.advance(DEFAULT_AUTO_REFRESH_INTERVAL_MS);
  assert.equal(calls, 2);
  controller.stop();
});

test('gizli sayfada zamanlayıcı durur ve arka planda yoklama yapmaz', async () => {
  const clock = createClock();
  const visibility = createVisibilitySource();
  let calls = 0;
  const controller = createController({
    clock,
    visibility,
    refresh: async () => { calls += 1; return { ok: true }; }
  });
  controller.start();
  visibility.change('hidden');

  assert.equal(clock.timerCount, 0);
  await clock.advance(180000);
  assert.equal(calls, 0);
  controller.stop();
});

test('eski veriyle görünür olan sayfa hemen yenilenir', async () => {
  const clock = createClock();
  const visibility = createVisibilitySource();
  let calls = 0;
  const controller = createController({
    clock,
    visibility,
    refresh: async () => { calls += 1; return { ok: true }; }
  });
  controller.start();
  await clock.advance(10000);
  visibility.change('hidden');
  await clock.advance(60000);
  visibility.change('visible');
  await clock.settle();

  assert.equal(calls, 1);
  controller.stop();
});

test('veri henüz eski değilken görünür olmak yinelenen istek üretmez', async () => {
  const clock = createClock();
  const visibility = createVisibilitySource();
  let calls = 0;
  const controller = createController({
    clock,
    visibility,
    refresh: async () => { calls += 1; return { ok: true }; }
  });
  controller.start();
  await clock.advance(10000);
  visibility.change('hidden');
  await clock.advance(10000);
  visibility.change('visible');
  await clock.settle();

  assert.equal(calls, 0);
  assert.equal(clock.timerCount, 1);
  await clock.advance(39999);
  assert.equal(calls, 0);
  await clock.advance(1);
  assert.equal(calls, 1);
  controller.stop();
});

test('tamamlanmamış otomatik yenilemenin üzerine ikinci istek bindirilmez', async () => {
  const clock = createClock();
  const visibility = createVisibilitySource();
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const controller = createController({
    clock,
    visibility,
    refresh: async () => { calls += 1; await pending; return { ok: true }; }
  });
  controller.start();
  await clock.advance(60000);
  assert.equal(calls, 1);

  visibility.change('hidden');
  visibility.change('visible');
  await clock.advance(120000);
  assert.equal(calls, 1);
  release();
  await clock.settle();
  controller.stop();
});

test('başarısız veya atlanan deneme sıkı yeniden deneme döngüsü oluşturmaz', async () => {
  const clock = createClock();
  const visibility = createVisibilitySource();
  let calls = 0;
  const controller = createController({
    clock,
    visibility,
    refresh: async () => { calls += 1; return { ok: false, skipped: true }; }
  });
  controller.start();
  await clock.advance(60000);
  assert.equal(calls, 1);
  assert.equal(clock.timerCount, 1);
  await clock.advance(59999);
  assert.equal(calls, 1);
  await clock.advance(1);
  assert.equal(calls, 2);
  controller.stop();
});

test('Demo deposu otomatik yoklama kapsamına girmez', () => {
  assert.equal(supportsAutomaticDataRefresh(createMockRepository()), false);
  assert.equal(supportsAutomaticDataRefresh({ kind: 'actual-api' }), true);
  assert.equal(supportsAutomaticDataRefresh({ kind: 'sql-server' }), true);
});

test('durdurma zamanlayıcıyı ve görünürlük dinleyicisini temizler', async () => {
  const clock = createClock();
  const visibility = createVisibilitySource();
  let calls = 0;
  const controller = createController({
    clock,
    visibility,
    refresh: async () => { calls += 1; return { ok: true }; }
  });
  controller.start();
  assert.equal(clock.timerCount, 1);
  assert.equal(visibility.listenerCount, 1);
  controller.stop();
  assert.equal(clock.timerCount, 0);
  assert.equal(visibility.listenerCount, 0);
  await clock.advance(120000);
  assert.equal(calls, 0);
});

test('yinelenen kurulum Strict Mode altında ikinci döngü oluşturmaz', () => {
  const clock = createClock();
  const visibility = createVisibilitySource();
  const controller = createController({
    clock,
    visibility,
    refresh: async () => ({ ok: true })
  });
  controller.start();
  controller.start();
  assert.equal(clock.timerCount, 1);
  assert.equal(visibility.listenerCount, 1);
  controller.stop();
});

test('oturum ve yetki hataları mevcut hata akışına aktarılır', () => {
  assert.equal(shouldSurfaceAutomaticRefreshFailure({ code: 'SESSION_REQUIRED' }), true);
  assert.equal(shouldSurfaceAutomaticRefreshFailure({ code: 'UNAUTHORIZED' }), true);
  assert.equal(shouldSurfaceAutomaticRefreshFailure({ code: 'FORBIDDEN' }), true);
  assert.equal(shouldSurfaceAutomaticRefreshFailure({ code: 'DATABASE_UNAVAILABLE' }), false);
});

test('provider otomatik yenilemeyi güvenli reloadData yaşam döngüsüne bağlar', () => {
  const provider = read('src/state/AppStateProvider.jsx');
  assert.match(provider, /supportsAutomaticDataRefresh\(repository\)/);
  assert.match(provider, /refresh: \(\) => reloadData\(\{ refreshMode: 'automatic' \}\)/);
  assert.match(provider, /return \(\) => controller\.stop\(\)/);
  assert.doesNotMatch(provider, /window\.location\.reload|router\.refresh/);
  assert.doesNotMatch(provider, /refreshMode: 'automatic'[\s\S]{0,100}discardFailedTaskUpdates: true/);
});
