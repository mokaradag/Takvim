import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { waitForServerReady, stopServer } from '../scripts/browser-check-server.mjs';

function child() {
  const server = new EventEmitter();
  server.stdout = new PassThrough();
  server.stderr = new PassThrough();
  return server;
}
function assertClean(server) {
  for (const event of ['error', 'exit', 'close']) assert.equal(server.listenerCount(event), 0);
  assert.equal(server.stdout.listenerCount('data'), 0);
  assert.equal(server.stderr.listenerCount('data'), 0);
}

test('Tarayıcı sunucusu parçalı hazırlık çıktısını birleştirir ve dinleyicileri temizler', async () => {
  const server = child();
  const ready = waitForServerReady(server);
  server.stdout.write('Rea');
  server.stderr.write('Bilgi');
  server.stdout.write('dy in 10ms');
  await ready;
  assertClean(server);
});

test('Tarayıcı sunucusunun hazırlık süresi sınırlıdır ve hata çıktısı korunur', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const server = child();
  const rejected = assert.rejects(waitForServerReady(server, 20), /20 ms.*hazır olmadı: Başlatma hatası/);
  server.stderr.write('Başlatma hatası');
  t.mock.timers.tick(20);
  await rejected;
  assertClean(server);
});

for (const event of ['error', 'exit'])
  test(`Tarayıcı sunucusu ${event === 'error' ? 'başlatma hatasını' : 'erken kapanmayı'} başarı saymaz`, async () => {
    const server = child();
    const rejected = assert.rejects(waitForServerReady(server), event === 'error' ? /Başlatılamadı/ : /hazır olmadan kapandı/);
    server.emit(event, event === 'error' ? new Error('Başlatılamadı') : 1);
    await rejected;
    assertClean(server);
  });

test('Tarayıcı sunucusu normal sonlandırmaya yanıt vermeyince zorla kapatılır', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const server = child();
  const signals = [];
  server.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') server.emit('close', null, signal);
    return true;
  };
  const stopped = stopServer(server);
  t.mock.timers.tick(2000);
  await stopped;
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assertClean(server);
});

test('Hazırlık zaman aşımı sonrasında gerçek çocuk süreç açık kalmaz', async () => {
  const server = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await assert.rejects(waitForServerReady(server, 50), /hazır olmadı/);
  } finally {
    await stopServer(server);
  }
  assert.ok(server.exitCode != null || server.signalCode != null);
});
