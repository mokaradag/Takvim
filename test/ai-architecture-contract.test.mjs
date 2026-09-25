/**
 * Yapay zekâ · mimari sözleşmeler.
 *
 * Kaynak üzerinde durağan denetimler: sunucu sınırı, tarayıcı katmanının
 * sunucuya/depolara dokunmaması, kişisel anahtar tablosuna yalnızca sabit ve
 * Sicil ile sınırlı sorgularla erişilmesi, genel SQL yürütme yüzeyinin
 * olmaması, olağan Rota akışının alt sisteme bağımlı olmaması ve 0016 göçü.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const AI_DIRECTORIES = ['src/server/ai', 'src/features/ai', 'src/domain/ai', 'src/app/api/mergen-rota/ai'];

const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const toRelative = (file) => path.relative(ROOT, file).split(path.sep).join('/');

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

const sourceFiles = (relativeDirectory) => walk(path.join(ROOT, relativeDirectory))
  .filter((file) => ['.js', '.jsx', '.mjs'].includes(path.extname(file)));

/** Yorumlar çıkarılır ki denetim yalnızca yürütülen kodu kapsasın. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function importsOf(file) {
  const source = fs.readFileSync(file, 'utf8');
  const pattern = /(?:import|export)\s+(?:([^'";]*?)\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  const imports = [];
  let match;
  while ((match = pattern.exec(source))) {
    const specifier = match[2] || match[3];
    const target = specifier.startsWith('.')
      ? ['', '.js', '.jsx', '.mjs', '/index.js'].map((suffix) => path.resolve(path.dirname(file), specifier) + suffix).find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
      : null;
    imports.push({ clause: match[1] || '', specifier, target: target ? toRelative(target) : null });
  }
  return imports;
}

const isAiPath = (relativePath) => AI_DIRECTORIES.some((directory) => relativePath.startsWith(`${directory}/`));

/* ── Uçlar ───────────────────────────────────────────────── */

test('yapay zekâ uçları Node çalışma zamanında, önbelleksiz ve ai.api. işlem adlarıyla çalışır', () => {
  const routes = sourceFiles('src/app/api/mergen-rota/ai').filter((file) => path.basename(file) === 'route.js');
  assert.deepEqual(routes.map(toRelative).sort(), [
    'src/app/api/mergen-rota/ai/credential/route.js',
    'src/app/api/mergen-rota/ai/credential/validation/route.js',
    'src/app/api/mergen-rota/ai/probe/route.js'
  ]);
  for (const file of routes) {
    const source = fs.readFileSync(file, 'utf8');
    const name = toRelative(file);
    assert.match(source, /^export const runtime = 'nodejs';$/m, name);
    assert.match(source, /^export const dynamic = 'force-dynamic';$/m, name);
    // Sağlayıcı çağrısı dâhil hiçbir fetch Next.js veri önbelleğine girmez.
    assert.match(source, /^export const fetchCache = 'force-no-store';$/m, name);
    const handlers = [...source.matchAll(/^export const (GET|POST|PUT|PATCH|DELETE) = (.*)$/gm)];
    assert.ok(handlers.length > 0, name);
    for (const [, method, definition] of handlers) {
      // `api.` ile başlamayan işlem adı yavaş model yanıtlarını olağan uç
      // gecikmesi uyarılarından ayırır.
      assert.match(definition, /^withRouteObservability\('ai\.api\.[a-z.]+', /, `${name} ${method}`);
    }
    // Kimlik yalnızca güvenilir oturumdan gelir; uç sorgu dizesi, başlık ya da
    // çerez okumaz.
    const body = code(source);
    for (const forbidden of ['searchParams', 'headers.get(', 'cookies(', 'sicil']) {
      assert.equal(body.toLowerCase().includes(forbidden.toLowerCase()), false, `${name} → ${forbidden}`);
    }
  }
});

test('kişisel anahtar uçları kimliği yalnızca güvenilir oturumdan çözer', () => {
  const service = code(read('src/server/ai/aiCredentialService.js'));
  for (const operation of ['loadAiCredentialStatus', 'saveAiPersonalCredential', 'removeAiPersonalCredential']) {
    const start = service.indexOf(`export async function ${operation}(`);
    assert.ok(start >= 0, operation);
    const next = service.indexOf('\nexport ', start + 1);
    const block = service.slice(start, next < 0 ? undefined : next);
    assert.match(block, /const sicil = await getTrustedCurrentSicil\(\);/, operation);
  }
  const gateway = read('src/server/ai/aiGateway.js');
  assert.match(gateway, /currentSicil = getTrustedCurrentSicil/);
  // Rehber üyeliği, yapılandırma ve profil kararlarından ÖNCE doğrulanır.
  assert.match(gateway, /verifySicil = assertAiDirectoryMember/);
  const trusted = gateway.indexOf('const sicil = await trustedSicil(signal);');
  assert.ok(trusted > 0 && trusted < gateway.indexOf('requireAiAvailable(loadConfig())'));
});

/* ── Katman sınırları ────────────────────────────────────── */

test('sunucu yapay zekâ modülleri yalnızca sunucuda yüklenir', () => {
  for (const file of [...sourceFiles('src/server/ai')]) {
    assert.match(fs.readFileSync(file, 'utf8'), /^import 'server-only';$/m, toRelative(file));
  }
});

test('tarayıcı katmanı sunucuya, ortam değişkenlerine ve tarayıcı depolarına dokunmaz', () => {
  for (const file of [...sourceFiles('src/features/ai'), ...sourceFiles('src/domain/ai')]) {
    const name = toRelative(file);
    for (const { target, specifier } of importsOf(file)) {
      assert.equal(target?.startsWith('src/server/') ?? false, false, `${name} → ${specifier}`);
      assert.notEqual(specifier, 'server-only', name);
    }
    const body = code(fs.readFileSync(file, 'utf8'));
    for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'process.env', 'console.', 'URLSearchParams']) {
      assert.equal(body.includes(forbidden), false, `${name} → ${forbidden}`);
    }
  }
  for (const file of sourceFiles('src/domain/ai')) {
    for (const { specifier, target } of importsOf(file)) {
      assert.equal(specifier === 'react' || specifier.startsWith('react/'), false, toRelative(file));
      assert.ok(target === null || target.startsWith('src/domain/'), `${toRelative(file)} → ${specifier}`);
    }
  }
});

test('olağan Rota akışı yapay zekâ alt sistemine bağımlı değildir', () => {
  const importers = [];
  for (const file of sourceFiles('src')) {
    const name = toRelative(file);
    if (isAiPath(name)) continue;
    if (importsOf(file).some(({ target }) => target && isAiPath(target))) importers.push(name);
  }
  // Ayarlar kartı ve sağlık/entegrasyon/telemetri gözlemi dışında hiçbir modül
  // (anlık görüntü, kayıt, görev, rapor) yapay zekâya bağlanmaz. Telemetri turu
  // yalnızca yük ölçümünü örnekler.
  assert.deepEqual(importers.sort(), [
    'src/features/settings/SettingsView.jsx',
    'src/server/observability/healthProbes.js',
    'src/server/observability/integrationsService.js',
    'src/server/observability/telemetryWorker.js'
  ]);
  const worker = code(read('src/server/observability/telemetryWorker.js'));
  assert.deepEqual([...worker.matchAll(/from '\.\.\/ai\/([^']+)'/g)].map((match) => match[1]), ['aiRuntime.js']);
  assert.match(worker, /import \{ sampleAiLoad \} from '\.\.\/ai\/aiRuntime\.js';/);
  assert.match(read('src/features/settings/SettingsView.jsx'), /<AiAccessSettings \/>/);
});

test('sunucu yapay zekâ modülleri yalnızca izinli altyapıya bağlanır ve genel SQL yüzeyi açmaz', () => {
  const allowedServerTargets = new Set([
    'src/server/db/pool.js',
    'src/server/errors.js',
    'src/server/identity/currentUserProvider.js',
    'src/server/identity/sameOriginRequest.js',
    'src/server/observability/boundedExecution.js',
    'src/server/observability/structuredLogger.js',
    'src/server/observability/telemetryRegistry.js'
  ]);
  const poolImports = {};
  for (const file of sourceFiles('src/server/ai')) {
    const name = toRelative(file);
    for (const { clause, specifier, target } of importsOf(file)) {
      if (!target) {
        assert.ok(specifier === 'server-only' || specifier.startsWith('node:'), `${name} → ${specifier}`);
        continue;
      }
      assert.ok(isAiPath(target) || target.startsWith('src/domain/') || allowedServerTargets.has(target), `${name} → ${specifier}`);
      if (target === 'src/server/db/pool.js') poolImports[name] = clause.replace(/[{}\s]/g, '').split(',').sort();
    }
    assert.doesNotMatch(code(fs.readFileSync(file, 'utf8')), /export\s+(?:async\s+)?function\s+\w*(?:execute|run|raw)(?:Sql|Query)\b/i, name);
  }
  // Sağlayıcı, ağ geçidi ve sınama veritabanına erişemez; ağ geçidi yalnızca
  // "işlem içinde miyim" sorusunu sorar.
  assert.deepEqual(poolImports, {
    'src/server/ai/aiCredentialService.js': ['getSqlPool', 'withSqlTransaction'],
    'src/server/ai/aiCredentialStore.js': ['sql'],
    'src/server/ai/aiGateway.js': ['isWithinSqlTransaction']
  });
});

/* ── Kişisel anahtar tablosu ─────────────────────────────── */

test('kişisel anahtar tablosuna yalnızca depo modülü, sabit ve Sicil ile sınırlı sorgularla erişir', async () => {
  const tableUsers = sourceFiles('src').filter((file) => fs.readFileSync(file, 'utf8').includes('MR_AiUserCredentials')).map(toRelative).sort();
  assert.deepEqual(tableUsers, ['src/server/ai/aiCredentialQueries.js', 'src/server/ai/aiCredentialStore.js']);

  const queryCalls = [];
  for (const file of sourceFiles('src/server/ai')) {
    for (const match of code(fs.readFileSync(file, 'utf8')).matchAll(/\.query\(([^)]*)\)/g)) queryCalls.push([toRelative(file), match[1].trim()]);
  }
  assert.ok(queryCalls.length > 0);
  for (const [file, argument] of queryCalls) {
    assert.equal(file, 'src/server/ai/aiCredentialStore.js');
    assert.match(argument, /^AI_CREDENTIAL_[A-Z_]+_SQL$/, 'SQL metni hiçbir zaman çalışma anında birleştirilmez');
  }

  const queries = await import('../src/server/ai/aiCredentialQueries.js');
  const statements = Object.entries(queries).flatMap(([name, text]) => text.split(';').map((statement) => [name, statement.replace(/\s+/g, ' ').trim()]));
  const touching = statements.filter(([, statement]) => statement.includes('MR_AiUserCredentials'));
  assert.ok(touching.length >= 6);
  for (const [name, statement] of touching) {
    if (name === 'AI_CREDENTIAL_SCHEMA_SQL') {
      // Şema denetimi yalnızca nesnenin varlığına bakar; satır okumaz.
      assert.match(statement, /^SELECT CAST\(CASE WHEN OBJECT_ID\(N'dbo\.MR_AiUserCredentials', N'U'\) IS NULL/, name);
      assert.doesNotMatch(statement, /\bFROM\b/i, name);
    } else if (/^IF @@ROWCOUNT = 0 INSERT /.test(statement)) {
      assert.match(statement, /VALUES \(@sicil, /, name);
    } else {
      assert.match(statement, /WHERE Sicil = @sicil(?: AND Nonce = @keyNonce)?$/, `${name}: ${statement}`);
    }
  }
  // Durum sorgusu şifreli metni ve doğrulama etiketini hiç okumaz. Ana anahtar
  // KİMLİĞİ ve nonce gizli değildir (nonce AES-GCM'nin açık parametresidir ve
  // her kayıtta yenilendiği için anahtar malzemesinin kimliğidir); ikisi de
  // yalnızca sunucuda kullanılır, tarayıcıya gitmez.
  assert.doesNotMatch(queries.AI_CREDENTIAL_STATUS_SQL, /Ciphertext|AuthTag/);
  assert.match(queries.AI_CREDENTIAL_STATUS_SQL, /Nonce AS KeyNonce/);
  // Rehber denetimi anahtar tablosuna dokunmaz: 0016 yokken de kimlik korunur.
  assert.doesNotMatch(queries.AI_CREDENTIAL_DIRECTORY_SQL, /MR_AiUserCredentials/);
  assert.match(queries.AI_CREDENTIAL_DIRECTORY_SQL, /FROM dbo\.MR_V_PeopleDirectory WHERE Sicil = @sicil/);
  // Silme ve doğrulama yalnızca okunan anahtara (nonce) uygulanır; künye
  // yazımıyla ilerleyen satır sürümüne bağlanmaz. Doğrulama yazımı künyeyi
  // aynı deyimden (`OUTPUT`) döndürür.
  assert.match(queries.AI_CREDENTIAL_DELETE_SQL, /WHERE Sicil = @sicil AND Nonce = @keyNonce;/);
  assert.match(queries.AI_CREDENTIAL_VALIDATION_SQL, /OUTPUT inserted\.KeyHint[^;]*WHERE Sicil = @sicil AND Nonce = @keyNonce;/);
  for (const text of Object.values(queries)) assert.doesNotMatch(text, /@rowVersion/);
});

test('0016 göçü sıralı, yinelenebilir ve düz metin anahtar sütunu içermez', () => {
  const upgrades = fs.readdirSync(path.join(ROOT, 'database')).filter((name) => /^MR_Upgrade_\d{4}_/.test(name)).sort();
  assert.equal(upgrades.at(-1), 'MR_Upgrade_0016_Ai_User_Credentials.sql');
  assert.equal(upgrades.filter((name) => name.startsWith('MR_Upgrade_0016_')).length, 1);

  const upgrade = read('database/MR_Upgrade_0016_Ai_User_Credentials.sql');
  assert.match(upgrade, /^SET XACT_ABORT ON;$/m);
  assert.match(upgrade, /WHERE MigrationId = N'0015_assignment_coordination_and_presence'\s*\)\s*THROW 51016,/);
  assert.match(upgrade, /IF OBJECT_ID\(N'dbo\.MR_AiUserCredentials', N'U'\) IS NULL\s+CREATE TABLE dbo\.MR_AiUserCredentials \(/);
  assert.match(upgrade, /IF NOT EXISTS \(\s*SELECT 1 FROM dbo\.MR_SchemaMigrations\s*WHERE MigrationId = N'0016_ai_user_credentials'\s*\)\s*INSERT dbo\.MR_SchemaMigrations/);
  assert.match(upgrade, /BEGIN CATCH\s+IF XACT_STATE\(\) <> 0 ROLLBACK TRANSACTION;\s+THROW;/);
  // Önceden var olan tablo yapısı doğrulanmadan göç işaretlenmez.
  const verification = upgrade.indexOf('DECLARE @RequiredColumns TABLE');
  assert.ok(verification > upgrade.indexOf('CREATE TABLE dbo.MR_AiUserCredentials ('));
  assert.ok(verification < upgrade.indexOf("INSERT dbo.MR_SchemaMigrations"));
  for (const check of ['sys.columns', 'is_primary_key = 1', 'sys.check_constraints', 'default_object_id = 0']) {
    assert.ok(upgrade.slice(verification).includes(check), check);
  }
  assert.doesNotMatch(upgrade, /\b(?:UPDATE|DELETE)\s+(?:FROM\s+)?dbo\.MR_(?!SchemaMigrations)/i, 'göç veriye dokunmaz');

  const tableOf = (script) => {
    const start = script.indexOf('CREATE TABLE dbo.MR_AiUserCredentials (');
    assert.ok(start >= 0);
    const lines = script.slice(start).split('\n').map((line) => line.trim());
    return lines.slice(0, lines.indexOf(');'));
  };
  const createSql = read('database/MR_Create_Durable_Persistence.sql');
  const upgradeTable = tableOf(upgrade);
  assert.deepEqual(tableOf(createSql), upgradeTable, 'yeni kurulum ile göç aynı tabloyu kurar');
  const columns = upgradeTable.slice(1)
    .filter((line) => /^[A-Za-z]+ (?:int|tinyint|char|varchar|varbinary|datetime2|rowversion)\b/.test(line))
    .map((line) => line.split(' ')[0]);
  assert.deepEqual(columns, [
    'Sicil', 'EncryptionVersion', 'MasterKeyId', 'Nonce', 'Ciphertext', 'AuthTag', 'KeyHint',
    'CreatedAt', 'UpdatedAt', 'LastValidatedAt', 'LastValidationStatus', 'RowVersion'
  ]);
  assert.ok(upgradeTable.includes('KeyHint varchar(4) NOT NULL,'), 'gösterim için en fazla dört karakter');
  assert.ok(upgradeTable.includes('CONSTRAINT PK_MR_AiUserCredentials PRIMARY KEY (Sicil),'), 'Sicil başına tek anahtar');

  assert.match(createSql, /\(N'0016_ai_user_credentials', N'[^']+'\)/);
  assert.match(read('database/MR_Rollback_Durable_Persistence.sql'), /IF OBJECT_ID\(N'dbo\.MR_AiUserCredentials', N'U'\) IS NOT NULL DROP TABLE dbo\.MR_AiUserCredentials;/);
});

/* ── Yapılandırma ────────────────────────────────────────── */

test('ortam örneği yapay zekâ ayarlarını yalnızca sunucu tarafında ve yer tutucuyla tanıtır', async () => {
  const env = read('.env.example');
  const { AI_CONFIG_NAMES } = await import('../src/server/ai/aiConfig.js');
  for (const name of Object.values(AI_CONFIG_NAMES)) {
    assert.match(name, /^MERGEN_ROTA_AI_[A-Z_]+$/);
    assert.match(env, new RegExp(`^${name}=`, 'm'), name);
  }
  assert.match(env, /^MERGEN_ROTA_AI_ENABLED=false$/m, 'özellik varsayılan olarak kapalıdır');
  assert.match(env, /^MERGEN_ROTA_AI_DEFAULT_API_KEY=$/m);
  // Yer tutucu bırakılırsa yalnızca kurumsal anahtarla çalışan kurulum da
  // kullanılamaz olurdu; ana anahtar boş gelir.
  assert.match(env, /^MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY=$/m);
  assert.match(env, /^MERGEN_ROTA_AI_BASE_URL=https:\/\/<[A-Z_]+>\/v1$/m);
  assert.doesNotMatch(env, /NEXT_PUBLIC_[A-Z0-9_]*AI_/);
  for (const file of sourceFiles('src')) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /NEXT_PUBLIC_MERGEN_ROTA_AI/, toRelative(file));
  }
});
