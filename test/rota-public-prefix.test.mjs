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

test('Next config uses asset prefix plus prefix-stripping compatibility rewrites', () => {
  const source = read('next.config.mjs');
  assert.match(source, /assetPrefix:\s*publicBasePath/);
  assert.match(source, /source:\s*`\$\{publicBasePath\}\/\:path\*`/);
  assert.match(source, /destination:\s*'\/\:path\*'/);
  assert.match(source, /destination:\s*`\$\{publicBasePath\}\/`/);
  assert.doesNotMatch(source, /basePath\s*:/);
});

test('browser-facing API, login and logout paths use the public prefix helper', () => {
  const boundary = read('src/components/shell/AppDataBoundary.jsx');
  const sidebar = read('src/components/shell/SidebarUserPanel.jsx');
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
