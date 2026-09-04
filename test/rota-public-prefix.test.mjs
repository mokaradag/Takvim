import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePublicBasePath, publicRotaPath } from '../src/lib/publicPath.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(path.join(ROOT, relativePath), 'utf8');

test('public prefix is normalized and applied exactly once', () => {
  assert.equal(normalizePublicBasePath(''), '');
  assert.equal(normalizePublicBasePath('/'), '');
  assert.equal(normalizePublicBasePath('rota'), '/rota');
  assert.equal(normalizePublicBasePath('/rota/'), '/rota');
  assert.equal(publicRotaPath('/', '/rota'), '/rota/');
  assert.equal(publicRotaPath('/api/mergen-rota', '/rota'), '/rota/api/mergen-rota');
  assert.equal(publicRotaPath('/rota/api/mergen-rota', '/rota'), '/rota/api/mergen-rota');
  assert.equal(publicRotaPath('/api/mergen-rota', ''), '/api/mergen-rota');
});

test('unsafe public paths are rejected', () => {
  assert.throws(() => normalizePublicBasePath('https://example.invalid/rota'));
  assert.throws(() => normalizePublicBasePath('//example.invalid/rota'));
  assert.throws(() => normalizePublicBasePath('/rota/../other'));
  assert.throws(() => publicRotaPath('https://example.invalid/api', '/rota'));
});

test('Next config uses asset prefix plus prefix-stripping compatibility rewrites', async () => {
  // Yapılandırma ÇALIŞTIRILIR: kaynak metni aramak, `rewrites()` bozulduğunda
  // ya da yönlendirme geri geldiğinde testi yeşil bırakabiliyordu.
  process.env.NEXT_PUBLIC_MERGEN_ROTA_PUBLIC_BASE_PATH = '/rota';
  const config = (await import(`../next.config.mjs?case=prefix-${Date.now()}`)).default;

  assert.equal(config.assetPrefix, '/rota');
  // `basePath` KULLANILMAZ: nginx öneki soyduğu için uygulama kökte çalışır.
  assert.equal(config.basePath, undefined);
  // YÖNLENDİRME yoktur; `/rota` -> `/rota/` yönlendirmesi `trailingSlash: false`
  // normalleştirmesiyle sonsuz döngüye giriyordu.
  assert.equal(typeof config.redirects, 'undefined');

  const rewrites = await config.rewrites();
  const rules = Array.isArray(rewrites) ? rewrites : (rewrites.beforeFiles || []);
  // Önekli yol köke yeniden yazılır.
  assert.ok(
    rules.some((rule) => rule.source === '/rota/:path*' && rule.destination === '/:path*'),
    'önekli yollar köke yeniden yazılmalıdır'
  );
  // Çıplak önek de yeniden yazılır (yönlendirilmez).
  assert.ok(
    rules.some((rule) => rule.source === '/rota' && rule.destination === '/'),
    'çıplak önek köke yeniden YAZILMALIDIR'
  );
});

test('browser-facing API, login and logout paths use the public prefix helper', () => {
  const boundary = read('src/components/shell/AppDataBoundary.jsx');
  const sidebar = read('src/components/shell/useSignOut.js');
  const dataMode = read('src/data/dataMode.js');
  const flows = read('src/server/identity/keycloakFlows.js');

  assert.match(boundary, /publicRotaPath\('\/api\/mergen-rota\/auth\/login'\)/);
  assert.doesNotMatch(boundary, /href="\/api\/mergen-rota\/auth\/login"/);
  assert.match(sidebar, /publicRotaPath\('\/api\/mergen-rota\/auth\/logout'\)/);
  assert.doesNotMatch(sidebar, /fetch\('\/api\/mergen-rota\/auth\/logout'/);
  assert.match(dataMode, /publicRotaPath\('\/api\/mergen-rota'\)/);
  assert.match(flows, /publicRotaPath\('\/auth\/implicit-callback'\)/);
  assert.match(flows, /publicRotaPath\('\/api\/mergen-rota\/auth\/implicit-session'\)/);
});
