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
    'src/app/api/mergen-rota/ai/assistant/conversations/[conversationId]/route.js',
    'src/app/api/mergen-rota/ai/assistant/conversations/before/[cursor]/route.js',
    'src/app/api/mergen-rota/ai/assistant/conversations/route.js',
    'src/app/api/mergen-rota/ai/assistant/route.js',
    'src/app/api/mergen-rota/ai/assistant/turns/route.js',
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
    'src/components/shell/AppShell.jsx',
    'src/features/settings/SettingsView.jsx',
    'src/server/observability/healthProbes.js',
    'src/server/observability/integrationsService.js',
    'src/server/observability/telemetryWorker.js'
  ]);
  // Kabuk yardımcıyı YALNIZCA bileşen sınırından bağlar (istemci, denetleyici ya da sunucu modülü değil).
  const shellAiImports = importsOf(path.join(ROOT, 'src/components/shell/AppShell.jsx')).filter(({ target }) => target && isAiPath(target));
  assert.deepEqual(shellAiImports.map(({ target }) => target), ['src/features/ai/assistant/RotaAssistant.jsx']);
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
  // Konuşma geçmişi hizmeti kısa işlemleri açar; deposu yalnızca parametre türlerini kullanır.
  assert.deepEqual(poolImports, {
    'src/server/ai/aiCredentialService.js': ['getSqlPool', 'withSqlTransaction'],
    'src/server/ai/aiCredentialStore.js': ['sql'],
    'src/server/ai/aiGateway.js': ['isWithinSqlTransaction'],
    'src/server/ai/assistant/assistantService.js': ['getSqlPool', 'withSqlTransaction'],
    'src/server/ai/assistant/conversationStore.js': ['sql']
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
    if (file === 'src/server/ai/assistant/conversationStore.js') {
      // Konuşma geçmişi deposu da yalnızca sabit metinleri çalıştırır (sayfa imleci için iki sabitten biri seçilir).
      assert.match(argument, /^(?:[a-z]+ \? )?AI_CONVERSATION_[A-Z_]+_SQL(?: : AI_CONVERSATION_[A-Z_]+_SQL)?$/, 'SQL metni hiçbir zaman çalışma anında birleştirilmez');
      continue;
    }
    assert.equal(file, 'src/server/ai/aiCredentialStore.js');
    assert.match(argument, /^AI_CREDENTIAL_[A-Z_]+_SQL$/, 'SQL metni hiçbir zaman çalışma anında birleştirilmez');
  }

  const queries = await import('../src/server/ai/aiCredentialQueries.js');
  const statements = Object.entries(queries).flatMap(([name, text]) => text.split(';').map((statement) => [name, statement.replace(/\s+/g, ' ').trim()]));
  const touching = statements.filter(([, statement]) => statement.includes('MR_AiUserCredentials'));
  assert.ok(touching.length >= 6);
  for (const [name, statement] of touching) {
    if (name === 'AI_CREDENTIAL_SCHEMA_SQL') {
      // Şema denetimi tablonun satırlarını okumaz: nesnenin varlığı, 0016 göç
      // kaydı ve uygulamanın kullandığı sütunların yapısı denetlenir.
      assert.match(statement, /^SELECT CAST\(CASE WHEN OBJECT_ID\(N'dbo\.MR_AiUserCredentials', N'U'\) IS NOT NULL/, name);
      assert.doesNotMatch(statement, /FROM dbo\.MR_AiUserCredentials/i, name);
      assert.match(statement, /FROM dbo\.MR_SchemaMigrations WHERE MigrationId = N'0016_ai_user_credentials'/, name);
      assert.match(statement, /LEFT JOIN sys\.columns c ON c\.object_id = OBJECT_ID\(N'dbo\.MR_AiUserCredentials', N'U'\)/, name);
      assert.match(statement, /c\.is_identity <> 0/, name);
    } else if (/^IF @@ROWCOUNT = 0 INSERT /.test(statement)) {
      assert.match(statement, /VALUES \(@sicil, /, name);
    } else {
      assert.match(statement, /WHERE Sicil = @sicil(?: AND Nonce = @keyNonce)?$/, `${name}: ${statement}`);
    }
  }
  // Durum sorgusu YALNIZCA anahtar tablosuna gider: rehber üyeliği ondan önce
  // ayrı sorguyla doğrulanır (rehberde olmayan Sicil tablonun durumunu
  // öğrenemez). Şifreli alanlar kaydın bütünlüğünü (AES-GCM etiketi) sunucuda
  // sınamak için okunur; ana anahtar KİMLİĞİ ve nonce gizli değildir. Hiçbiri
  // tarayıcıya gitmez (bkz. kimlik bilgisi güvenliği testleri).
  assert.doesNotMatch(queries.AI_CREDENTIAL_STATUS_SQL, /MR_V_PeopleDirectory|KnownSicil/);
  assert.match(queries.AI_CREDENTIAL_STATUS_SQL, /SELECT TOP \(1\) EncryptionVersion, MasterKeyId, Nonce, Ciphertext, AuthTag, /);
  // Rehber denetimi anahtar tablosuna dokunmaz: 0016 yokken de kimlik korunur.
  assert.doesNotMatch(queries.AI_CREDENTIAL_DIRECTORY_SQL, /MR_AiUserCredentials/);
  assert.match(queries.AI_CREDENTIAL_DIRECTORY_SQL, /FROM dbo\.MR_V_PeopleDirectory WHERE Sicil = @sicil/);
  // Silme ve doğrulama yalnızca okunan anahtara (nonce) uygulanır; künye
  // yazımıyla ilerleyen satır sürümüne bağlanmaz. Doğrulama yazımı künyeyi
  // aynı deyimden (`OUTPUT`) döndürür.
  assert.match(queries.AI_CREDENTIAL_DELETE_SQL, /WHERE Sicil = @sicil AND Nonce = @keyNonce;/);
  // Silmeden sonraki güncel satır aynı gidiş-dönüşte okunur: araya giren kayıt
  // "anahtar yok" yanıtıyla gizlenmez.
  assert.match(queries.AI_CREDENTIAL_DELETE_SQL, /SELECT @@ROWCOUNT AS Deleted;\s+SELECT TOP \(1\) Nonce AS KeyNonce, /);
  assert.match(queries.AI_CREDENTIAL_VALIDATION_SQL, /OUTPUT inserted\.KeyHint[^;]*WHERE Sicil = @sicil AND Nonce = @keyNonce;/);
  for (const text of Object.values(queries)) assert.doesNotMatch(text, /@rowVersion/);
});

test('0016 göçü sıralı, yinelenebilir ve düz metin anahtar sütunu içermez', () => {
  const upgrades = fs.readdirSync(path.join(ROOT, 'database')).filter((name) => /^MR_Upgrade_\d{4}_/.test(name)).sort();
  // 0016 sıradaki yerini korur: kendisinden sonra yalnızca 0017 (Rota AI konuşma geçmişi) gelir.
  assert.deepEqual(upgrades.slice(-2), ['MR_Upgrade_0016_Ai_User_Credentials.sql', 'MR_Upgrade_0017_Ai_Assistant_Conversations.sql']);
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
  for (const check of [
    'sys.columns', 'is_primary_key = 1', 'i.is_disabled = 0', 'sys.check_constraints', 'default_object_id = 0',
    'c.is_identity <> 0', 'NOT EXISTS (SELECT 1 FROM @RequiredColumns r WHERE r.ColumnName = c.name)',
    'k.definition COLLATE Latin1_General_BIN2 <> e.definition', 'd.definition COLLATE Latin1_General_BIN2 <> ed.definition'
  ]) {
    assert.ok(upgrade.slice(verification, upgrade.indexOf('INSERT dbo.MR_SchemaMigrations')).includes(check), check);
  }
  // Beklenen kısıt ve varsayılan tanımları, tablonun kendi tanımıyla aynı
  // ifadelerden (aynı sunucu normalleştirmesiyle) üretilir.
  const expected = upgrade.slice(upgrade.indexOf('CREATE TABLE #MR_AiUserCredentials_Expected ('));
  for (const expression of [
    'CHECK (EncryptionVersion IN (1))', 'CHECK (DATALENGTH(Nonce) = 12)', 'CHECK (DATALENGTH(AuthTag) = 16)',
    'CHECK (DATALENGTH(Ciphertext) BETWEEN 16 AND 1024)',
    "CHECK (LastValidationStatus IS NULL OR LastValidationStatus IN ('VALID','REJECTED','FORBIDDEN'))",
    'DEFAULT SYSUTCDATETIME()'
  ]) {
    assert.ok(upgrade.slice(0, verification).includes(expression), `tablo: ${expression}`);
    assert.ok(expected.slice(0, expected.indexOf(');')).includes(expression), `beklenen: ${expression}`);
  }
  assert.ok(upgrade.indexOf('DROP TABLE #MR_AiUserCredentials_Expected;') < upgrade.indexOf('INSERT dbo.MR_SchemaMigrations'));
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

/* ── Rota AI sohbeti (akış, konuşma geçmişi, yardımcı panel) ── */

const ASSISTANT_SOURCES = [
  ...sourceFiles('src/features/ai/assistant'),
  ...sourceFiles('src/server/ai/assistant'),
  ...sourceFiles('src/app/api/mergen-rota/ai/assistant'),
  path.join(ROOT, 'src/domain/ai/assistantContract.js'),
  path.join(ROOT, 'src/domain/ai/eventStreamParser.js')
];

test('Rota AI kodu sağlayıcı bağdaştırıcısına bağlanmaz; sağlayıcı yalnızca ağ geçidi arkasındadır', () => {
  for (const file of ASSISTANT_SOURCES) {
    const name = toRelative(file);
    for (const { target, specifier } of importsOf(file)) {
      assert.equal(target?.startsWith('src/server/ai/providers/') ?? false, false, `${name} → ${specifier}`);
    }
    const body = code(fs.readFileSync(file, 'utf8'));
    assert.doesNotMatch(body, /streamChatCompletion|chatCompletion\(|\/chat\/completions/, name);
  }
  // Akışlı sağlayıcı çağrısını yalnızca ağ geçidi yapar; hizmet ağ geçidini çağırır.
  const callers = sourceFiles('src').filter((file) => code(fs.readFileSync(file, 'utf8')).includes('.streamChatCompletion(')).map(toRelative);
  assert.deepEqual(callers, ['src/server/ai/aiGateway.js']);
  assert.match(code(read('src/server/ai/assistant/assistantService.js')), /getAiGateway\(\)\.streamChat\(\{/);
  // Tarayıcıdan ya da özellik kodundan sağlayıcıya doğrudan fetch yoktur.
  for (const file of sourceFiles('src/features/ai')) {
    for (const match of code(fs.readFileSync(file, 'utf8')).matchAll(/fetch\(\s*([^,)]+)/g)) {
      assert.match(match[1], /^publicRotaPath\(`\$\{BASE\}\//, `${toRelative(file)} yalnızca Rota uçlarına istek atar`);
    }
  }
});

test('Rota AI özellik ve iş kodunda kurulu model adı, profil kimliği ya da sağlayıcı ayarı geçmez', async () => {
  const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
  const catalog = JSON.parse(read('config/ai-model-registry.onprem.json'));
  const models = new Set([...DEFAULT_AI_MODEL_REGISTRY.models, ...catalog.models].map((model) => model.id));
  for (const file of ASSISTANT_SOURCES) {
    const name = toRelative(file);
    const body = code(fs.readFileSync(file, 'utf8'));
    for (const model of models) assert.equal(body.includes(model), false, `${name} → ${model}`);
    assert.doesNotMatch(body, /MERGEN_ROTA_AI_|process\.env/, name);
    assert.doesNotMatch(body, /'chat\.tools'|CHAT_TOOLS/, `${name}: araç profili bu aşamada kullanılmaz`);
  }
  // Tarayıcı katmanı profil kimliği de bilmez: kip → profil eşlemesi sunucudadır.
  for (const file of sourceFiles('src/features/ai/assistant')) {
    assert.doesNotMatch(code(fs.readFileSync(file, 'utf8')), /chat\.(?:general|reasoning|fast)|AI_PROFILES/, toRelative(file));
  }
  const service = code(read('src/server/ai/assistant/assistantService.js'));
  assert.match(service, /\[ASSISTANT_MODES\.STANDARD\]: AI_PROFILES\.CHAT_GENERAL,\s*\[ASSISTANT_MODES\.DEEP\]: AI_PROFILES\.CHAT_REASONING/);
});

test('sohbet Sicil’i yalnızca güvenilir oturumdan alır; tur gövdesi yalnızca dört alan kabul eder', () => {
  const service = code(read('src/server/ai/assistant/assistantService.js'));
  assert.match(service, /const TURN_FIELDS = new Set\(\['conversationId', 'turnId', 'message', 'mode'\]\);/);
  for (const operation of ['listAssistantConversations', 'loadAssistantConversation', 'deleteAssistantConversation', 'prepareAssistantTurn']) {
    const start = service.indexOf(`export async function ${operation}(`);
    assert.ok(start >= 0, operation);
    const firstStatement = service.slice(service.indexOf('{', service.indexOf(')', start)) + 1).trim().split('\n')[0];
    assert.equal(firstStatement, 'const sicil = await getTrustedCurrentSicil();', operation);
  }
  // Hazırlık durumu da kimliği Phase 1 durum okumasıyla (güvenilir Sicil + rehber) doğrular.
  assert.match(service, /export async function loadAssistantReadiness\(\{ signal = null \} = \{\}\) \{\s*const status = await loadAiCredentialStatus\(\{ signal \}\);/);
  // Rehber üyeliği gövde okunmadan önce doğrulanır.
  const prepare = service.slice(service.indexOf('export async function prepareAssistantTurn('));
  assert.ok(prepare.indexOf('verifyDirectoryMember(sicil, signal)') < prepare.indexOf('readBody(scoped)'));
  for (const file of sourceFiles('src/features/ai/assistant')) {
    assert.doesNotMatch(code(fs.readFileSync(file, 'utf8')), /\bsicil\b|apiKey|authorization/i, toRelative(file));
  }
});

test('konuşma tablolarına yalnızca konuşma deposu, sabit ve Sicil sahipliğiyle sınırlı sorgularla erişir', async () => {
  const tableUsers = sourceFiles('src').filter((file) => /MR_AiConversation/.test(fs.readFileSync(file, 'utf8'))).map(toRelative).sort();
  assert.deepEqual(tableUsers, ['src/server/ai/assistant/conversationQueries.js', 'src/server/ai/assistant/conversationStore.js']);
  // Depo tablo adını yalnızca "0017 uygulanmamış" hatasını tanımak için anar; SQL metni sorgu modülündedir.
  const store = code(read('src/server/ai/assistant/conversationStore.js'));
  assert.deepEqual(store.split('\n').filter((line) => line.includes('MR_AiConversation')),
    ["const CONVERSATION_TABLES = ['MR_AiConversations', 'MR_AiConversationMessages'];"]);
  assert.match(store, /CONVERSATION_TABLES\.some\(\(table\) => String\(entry\.message \|\| ''\)\.includes\(table\)\)/);
  assert.doesNotMatch(store, /\b(?:SELECT|INSERT|UPDATE|DELETE)\s+(?:TOP|INTO|FROM|dbo)\b/);
  const queries = await import('../src/server/ai/assistant/conversationQueries.js');
  const names = Object.keys(queries).sort();
  assert.deepEqual(names, [
    'AI_CONVERSATION_APPEND_ANSWER_SQL',
    'AI_CONVERSATION_DELETE_SQL',
    'AI_CONVERSATION_LIST_BEFORE_SQL',
    'AI_CONVERSATION_LIST_SQL',
    'AI_CONVERSATION_LOAD_SQL',
    'AI_CONVERSATION_PREPARE_TURN_SQL'
  ]);
  for (const [name, text] of Object.entries(queries)) {
    // Her deyim konuşmayı güvenilir Sicil'in sahipliğiyle sınırlar; ileti tabloları sahip konuşma üzerinden okunur.
    assert.match(text, /OwnerSicil = @sicil/, name);
    assert.doesNotMatch(text, /\$\{|EXEC\s*\(|sp_executesql/i, `${name}: dinamik SQL yoktur`);
    for (const statement of text.split(';').map((part) => part.replace(/\s+/g, ' ').trim()).filter((part) => /MR_AiConversationMessages/.test(part) && /^(?:SELECT|UPDATE|DELETE)/.test(part))) {
      assert.match(statement, /OwnerSicil = @sicil|c\.ConversationId = @conversationId|ConversationId = @conversationId/, `${name}: ${statement.slice(0, 80)}`);
    }
  }
  // Sayfalar sınırlıdır: liste TOP (@limit), okuma TOP (@maxMessages), geçmiş TOP (@historyLimit).
  assert.match(queries.AI_CONVERSATION_LIST_SQL, /SELECT TOP \(@limit\)/);
  assert.match(queries.AI_CONVERSATION_LIST_BEFORE_SQL, /SELECT TOP \(@limit\)/);
  assert.match(queries.AI_CONVERSATION_LOAD_SQL, /SELECT TOP \(@maxMessages\)/);
  assert.match(queries.AI_CONVERSATION_PREPARE_TURN_SQL, /SELECT TOP \(@historyLimit\)/);
  // Liste iletileri yüklemez.
  assert.doesNotMatch(queries.AI_CONVERSATION_LIST_SQL, /MR_AiConversationMessages/);
});

test('0017 göçü sıralı, yinelenebilir, yapıyı doğrular ve yalnızca görünür ileti metnini saklar', () => {
  const upgrade = read('database/MR_Upgrade_0017_Ai_Assistant_Conversations.sql');
  assert.match(upgrade, /^SET XACT_ABORT ON;$/m);
  // Süzgeçli tekil dizinler bu oturum seçeneklerinin tamamını ister.
  for (const option of ['QUOTED_IDENTIFIER ON', 'ANSI_NULLS ON', 'ANSI_PADDING ON', 'ANSI_WARNINGS ON', 'ARITHABORT ON', 'CONCAT_NULL_YIELDS_NULL ON', 'NUMERIC_ROUNDABORT OFF']) {
    assert.match(upgrade, new RegExp(`^SET ${option};$`, 'm'), option);
  }
  assert.match(upgrade, /WHERE MigrationId = N'0016_ai_user_credentials'\s*\)\s*THROW 51017,/);
  assert.match(upgrade, /IF OBJECT_ID\(N'dbo\.MR_AiConversations', N'U'\) IS NULL\s+CREATE TABLE dbo\.MR_AiConversations \(/);
  assert.match(upgrade, /IF OBJECT_ID\(N'dbo\.MR_AiConversationMessages', N'U'\) IS NULL\s+CREATE TABLE dbo\.MR_AiConversationMessages \(/);
  assert.match(upgrade, /IF NOT EXISTS \(\s*SELECT 1 FROM dbo\.MR_SchemaMigrations\s*WHERE MigrationId = N'0017_ai_assistant_conversations'\s*\)\s*INSERT dbo\.MR_SchemaMigrations/);
  assert.match(upgrade, /BEGIN CATCH\s+IF XACT_STATE\(\) <> 0 ROLLBACK TRANSACTION;\s+THROW;/);
  assert.match(upgrade, /REFERENCES dbo\.MR_AiConversations\(ConversationId\) ON DELETE CASCADE/);
  assert.match(upgrade, /CREATE UNIQUE INDEX UX_MR_AiConversationMessages_Turn\s+ON dbo\.MR_AiConversationMessages\(ConversationId, ClientTurnId\)\s+WHERE ClientTurnId IS NOT NULL;/);
  assert.match(upgrade, /CREATE UNIQUE INDEX UX_MR_AiConversationMessages_Reply\s+ON dbo\.MR_AiConversationMessages\(ReplyToMessageId\)\s+WHERE ReplyToMessageId IS NOT NULL;/);
  assert.match(upgrade, /CREATE UNIQUE INDEX UX_MR_AiConversations_OwnerOrigin\s+ON dbo\.MR_AiConversations\(OwnerSicil, OriginTurnId\);/);
  // Yapı doğrulaması göç kaydından ÖNCE yapılır.
  const verification = upgrade.indexOf('DECLARE @RequiredColumns TABLE');
  const marker = upgrade.indexOf('INSERT dbo.MR_SchemaMigrations');
  assert.ok(verification > upgrade.indexOf('CREATE TABLE dbo.MR_AiConversationMessages ('));
  for (const check of [
    'c.is_identity <> 0', 'c.is_computed <> 0', 'DECLARE @RequiredIndexColumns TABLE', 'ic.is_descending_key <> r.IsDescending',
    'f.delete_referential_action = 1', 'f.is_not_trusted = 0', 'k.definition COLLATE Latin1_General_BIN2 <> e.definition',
    'i.filter_definition COLLATE Latin1_General_BIN2 <> e.filter_definition', 'd.definition COLLATE Latin1_General_BIN2 <> ed.definition'
  ]) {
    const at = upgrade.indexOf(check, verification);
    assert.ok(at > verification && at < marker, check);
  }
  assert.doesNotMatch(upgrade, /\b(?:UPDATE|DELETE)\s+(?:FROM\s+)?dbo\.MR_(?!SchemaMigrations)/i, 'göç veriye dokunmaz');
  // Akıl yürütme, ham akış, istek nesnesi ya da anahtar için sütun yoktur.
  assert.doesNotMatch(upgrade, /\b(?:Reasoning|Thinking|RawStream|RequestJson|ApiKey|Prompt|SystemPrompt)\w*\s+(?:n?varchar|varbinary|nvarchar)/i);

  const tableOf = (script, table) => {
    const start = script.indexOf(`CREATE TABLE dbo.${table} (`);
    assert.ok(start >= 0, table);
    const lines = script.slice(start).split('\n').map((line) => line.trim());
    return lines.slice(0, lines.indexOf(');'));
  };
  const createSql = read('database/MR_Create_Durable_Persistence.sql');
  for (const table of ['MR_AiConversations', 'MR_AiConversationMessages']) {
    assert.deepEqual(tableOf(createSql, table), tableOf(upgrade, table), `yeni kurulum ile göç aynı ${table} tablosunu kurar`);
  }
  for (const index of ['UX_MR_AiConversations_OwnerOrigin', 'IX_MR_AiConversations_OwnerRecent', 'UX_MR_AiConversationMessages_Turn', 'UX_MR_AiConversationMessages_Reply']) {
    assert.ok(createSql.includes(index), `yeni kurulum ${index} dizinini kurar`);
  }
  assert.match(createSql, /\(N'0017_ai_assistant_conversations', N'[^']+'\)/);
  // Geri alma betiği iletileri konuşmalardan ÖNCE kaldırır (yabancı anahtar).
  const rollback = read('database/MR_Rollback_Durable_Persistence.sql');
  const messagesDrop = rollback.indexOf("IF OBJECT_ID(N'dbo.MR_AiConversationMessages', N'U') IS NOT NULL DROP TABLE dbo.MR_AiConversationMessages;");
  const conversationsDrop = rollback.indexOf("IF OBJECT_ID(N'dbo.MR_AiConversations', N'U') IS NOT NULL DROP TABLE dbo.MR_AiConversations;");
  assert.ok(messagesDrop >= 0 && conversationsDrop > messagesDrop);
});

test('olağan anlık görüntü, kayıt ve depo yolları Rota AI çalışma zamanına bağlanmaz', () => {
  const ordinary = [
    ...sourceFiles('src/server/repository'),
    ...sourceFiles('src/app/api/mergen-rota/snapshot'),
    ...sourceFiles('src/app/api/mergen-rota/commit'),
    ...sourceFiles('src/state'),
    ...sourceFiles('src/data')
  ];
  assert.ok(ordinary.length > 10);
  for (const file of ordinary) {
    for (const { target, specifier } of importsOf(file)) {
      assert.equal(Boolean(target && isAiPath(target)), false, `${toRelative(file)} → ${specifier}`);
    }
  }
  // Konuşma SQL işleri kendi sınırlı kapısından geçer; model üretimi olağan SQL havuzunu tüketemez.
  const service = code(read('src/server/ai/assistant/assistantService.js'));
  assert.match(service, /const conversationGate = createAiSqlGate\(\{/);
  assert.match(service, /conversationGate\.run\(sicil, scoped,/);
  // SQL sürücüsüne doğrudan bağlanan Rota AI modülü yoktur.
  for (const file of [...sourceFiles('src/server/ai'), ...sourceFiles('src/features/ai')]) {
    for (const { specifier } of importsOf(file)) {
      assert.equal(['mssql', 'msnodesqlv8', 'mssql/msnodesqlv8'].includes(specifier), false, toRelative(file));
    }
  }
});

test('yanıt çizimi güvenlidir: HTML enjeksiyonu, görsel ve betik şemalı bağlantı üretilmez', () => {
  for (const file of sourceFiles('src/features/ai/assistant')) {
    const name = toRelative(file);
    const body = code(fs.readFileSync(file, 'utf8'));
    assert.doesNotMatch(body, /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|DOMParser|new Function|eval\(/, name);
    assert.doesNotMatch(body, /<img\b|<iframe\b|<script\b/, name);
  }
  const renderer = code(read('src/features/ai/assistant/AssistantMarkdown.jsx'));
  // Bağlantı hedefi yalnızca çözücünün güvenli adres denetiminden geçmiş değerdir.
  assert.match(renderer, /<a key=\{key\} href=\{node\.href\} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" title=\{node\.href\}>/);
  const parser = code(read('src/features/ai/assistant/assistantMarkdown.js'));
  assert.match(parser, /const SAFE_PROTOCOLS = new Set\(\['http:', 'https:', 'mailto:'\]\);/);
  assert.match(parser, /tokens\.push\(\{ type: 'link', href, image/);
});

test('yardımcı panel katman sözleşmesine bağlıdır ve ölçekli görünüm değişkenlerini kullanır', async () => {
  const globals = read('src/app/globals.css');
  const tokens = Object.fromEntries([...globals.matchAll(/--z-([a-z-]+):\s*(\d+);/g)].map((match) => [match[1], Number(match[2])]));
  assert.ok(tokens.chrome < tokens.assistant && tokens.assistant < tokens.popover, 'yardımcı kabuğun üstünde, açılır panellerin altında');
  assert.ok(tokens.assistant < tokens['drawer-backdrop'] && tokens.assistant < tokens.command && tokens.assistant < tokens.modal);
  const css = read('src/app/styles/assistant.css');
  const zIndexes = [...css.matchAll(/z-index:\s*([^;]+);/g)].map((match) => match[1].trim());
  assert.deepEqual([...new Set(zIndexes)].sort(), ['var(--z-assistant)', 'var(--z-drawer)']);
  const stripped = css.replaceAll('var(--app-viewport-h, 100vh)', 'var(--app-viewport-h)').replaceAll('var(--app-viewport-w, 100vw)', 'var(--app-viewport-w)');
  assert.deepEqual(stripped.match(/\b(?:height|max-height|min-height|width|max-width|min-width|top|padding-top):[^;]*\d+v[hw]\b/g) || [], []);
  assert.doesNotMatch(css, /text-transform:\s*uppercase/);
  const { ASSISTANT_SHEET_QUERY } = await import('../src/features/ai/assistant/assistantInteraction.js');
  assert.ok(css.includes(`@media ${ASSISTANT_SHEET_QUERY} {`), 'dar ekran sorgusu bileşenle ortaktır');
  assert.match(read('src/app/layout.js'), /^import '\.\/styles\/assistant\.css';$/m);
  // Panelin üst konumu üst çubuğun yüksekliğidir.
  const topbarHeight = read('src/app/styles/shell.css').match(/\.topbar \{\s*height: (\d+px);/)[1];
  assert.match(css, new RegExp(`--assistant-top: ${topbarHeight};`));
  // Bildirim paneli açıkken üst çubuk açılır panel katmanına çıkar; yardımcı paneli onu örtmez.
  assert.match(read('src/app/styles/shell.css'), /\.topbar:has\(\.schedule-request-popover\) \{\s*z-index: var\(--z-popover\);\s*\}/);
  for (const file of cssFilesOutside('src/app/styles/assistant.css')) {
    assert.doesNotMatch(read(file), /\.rota-assistant|\.assistant-md/, `${file} yardımcı panelin stil sahibi değildir`);
  }
});

function cssFilesOutside(owner) {
  return ['src/app/globals.css', ...fs.readdirSync(path.join(ROOT, 'src/app/styles')).map((name) => `src/app/styles/${name}`)]
    .filter((file) => file.endsWith('.css') && file !== owner);
}

test('kullanıcıya dönük Rota AI metinleri aşama numarası ya da iç yol haritası terimi içermez', () => {
  for (const file of [...sourceFiles('src/features/ai/assistant'), path.join(ROOT, 'src/server/ai/assistant/assistantPrompt.js')]) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /Phase\s*\d|Faz\s*\d|Aşama\s*\d/i, toRelative(file));
  }
});
