import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;

function filesUnder(relativePath) {
  const base = join(root, relativePath);
  const result = [];
  function walk(path) {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(?:js|jsx|mjs)$/.test(name)) result.push(full);
    }
  }
  walk(base);
  return result;
}

function source(path) { return readFileSync(path, 'utf8'); }

const clientAreas = ['src/features', 'src/components', 'src/state'];

test('client and feature modules never import mssql or server database modules', () => {
  for (const area of clientAreas) {
    for (const file of filesUnder(area)) {
      const text = source(file);
      assert.doesNotMatch(text, /from\s+['"]mssql['"]|require\(['"]mssql['"]\)/, relative(root, file));
      assert.doesNotMatch(text, /server\/db|server\/repository\/sqlAppRepository/, relative(root, file));
    }
  }
});

test('SQL connection and repository implementation are server-only', () => {
  for (const file of [
    'src/server/db/config.js',
    'src/server/db/pool.js',
    'src/server/repository/sqlAppRepository.js'
  ]) {
    assert.match(source(join(root, file)), /import ['"]server-only['"]/);
  }
});

test('Actual API repository talks only to HTTP API and never imports Demo seed or SQL', () => {
  const text = source(join(root, 'src/data/api/createApiRepository.js'));
  assert.match(text, /fetch\(/);
  assert.doesNotMatch(text, /mock\/seed|createMockRepository|mssql|server\/db/);
});

test('Demo repository never calls SQL or Actual API', () => {
  const text = source(join(root, 'src/data/mock/createMockRepository.js'));
  assert.doesNotMatch(text, /fetch\(|mssql|api\/mergen-rota|server\/db/);
  assert.match(text, /\.\/seed\.js/);
});

test('database secrets are never NEXT_PUBLIC variables', () => {
  const env = source(join(root, '.env.example'));
  assert.doesNotMatch(env, /NEXT_PUBLIC_MERGEN_ROTA_DB/);
  for (const name of ['SERVER', 'DATABASE', 'USER', 'PASSWORD']) {
    assert.match(env, new RegExp(`MERGEN_ROTA_DB_${name}=`));
  }
});

test('trusted current Sicil comes only from server environment provider', () => {
  const identity = source(join(root, 'src/server/identity/currentUserProvider.js'));
  assert.match(identity, /process\.env\.MERGEN_ROTA_DEV_SICIL/);
  assert.doesNotMatch(identity, /request|headers|query|localStorage/);
  const routes = filesUnder('src/app/api/mergen-rota').map(source).join('\n');
  assert.doesNotMatch(routes, /sicil\s*=\s*(?:body|request|searchParams|headers)/i);
});

test('API routes force Node runtime and disable caching', () => {
  for (const file of filesUnder('src/app/api/mergen-rota')) {
    const text = source(file);
    assert.match(text, /runtime\s*=\s*['"]nodejs['"]/);
    assert.match(text, /dynamic\s*=\s*['"]force-dynamic['"]/);
    assert.match(text, /no-store/);
  }
});

test('Actual repository does not persist CPM output fields', () => {
  const sql = source(join(root, 'database/MR_Create_Durable_Persistence.sql'));
  for (const forbidden of ['EarlyStart', 'LateStart', 'TotalFloat', 'FreeFloat', 'IsCritical', 'CriticalPath']) {
    assert.doesNotMatch(sql, new RegExp(`\\b${forbidden}\\b`, 'i'));
  }
});

test('one commit maps to one SQL transaction and one correlation id', () => {
  const repository = source(join(root, 'src/server/repository/sqlAppRepository.js'));
  assert.match(repository, /commitChanges\(input\).*withSqlTransaction/s);
  assert.match(repository, /const\s+correlationId\s*=\s*randomUUID\(\)/);
  assert.match(repository, /MR_AuditLog/);
});
