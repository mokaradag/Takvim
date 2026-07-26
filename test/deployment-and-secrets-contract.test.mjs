/**
 * Dağıtım ve gizlilik sözleşmeleri.
 *
 * MERGEN Rota 8008 portunda çalışır; 8009 MERGEN Bilge'ye aittir. Depoya gerçek
 * adres, kimlik bilgisi, jeton veya kişisel veri işlenmez.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(path.join(ROOT, relativePath), 'utf8');

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '.git' ? [] : walk(full);
    return [full];
  });
}

const DOC_AND_CONFIG_FILES = [
  'README.md',
  '.env.example',
  'package.json',
  ...readdirSync(path.join(ROOT, 'docs')).map((name) => `docs/${name}`)
];

/* ── Port ───────────────────────────────────────────────── */

test('üretim komutu ve belgeler MERGEN Rota için 8008 portunu kullanır', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['start:prod'], 'next start -H 0.0.0.0 -p 8008');
  assert.match(pkg.scripts.dev, /-p 8008/);

  const readme = read('README.md');
  assert.match(readme, /npm run start -- -H 0\.0\.0\.0 -p 8008/);
});

test('hiçbir MERGEN Rota dağıtım talimatı 8009 portunu kullanmaz', () => {
  for (const relativePath of DOC_AND_CONFIG_FILES) {
    const source = read(relativePath);
    // Paragraf düzeyinde bakılır: cümle satır sonuna sarabilir.
    for (const paragraph of source.split(/\n\s*\n/)) {
      if (!paragraph.includes('8009')) continue;
      // 8009 yalnızca "MERGEN Bilge'ye aittir" bağlamında anılabilir.
      assert.match(
        paragraph,
        /Bilge/i,
        `${relativePath}: 8009 yalnızca MERGEN Bilge bağlamında anılabilir → ${paragraph.trim().slice(0, 120)}`
      );
    }
    // Dağıtım komutu olarak 8009 hiçbir yerde geçmez.
    assert.doesNotMatch(source, /-p\s*8009/, relativePath);
  }
});

test('eski 3000 portu MERGEN Rota dağıtım talimatlarında kalmadı', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /-p 3000/);
  assert.doesNotMatch(readme, /localhost:3000/);
});

test('Keycloak yönlendirme örnekleri 8008 portunu ve maskeli konak adını kullanır', () => {
  const env = read('.env.example');
  assert.match(env, /MERGEN_ROTA_KEYCLOAK_REDIRECT_URI=https:\/\/<MERGEN_ROTA_HOST>:8008\/api\/mergen-rota\/auth\/callback/);
  assert.match(env, /MERGEN_ROTA_KEYCLOAK_POST_LOGOUT_REDIRECT_URI=https:\/\/<MERGEN_ROTA_HOST>:8008\//);
});

/* ── Ortam şablonu ──────────────────────────────────────── */

test('.env.example tüm Keycloak anahtarlarını yer tutucularla içerir', () => {
  const env = read('.env.example');
  const required = [
    'MERGEN_ROTA_AUTH_MODE',
    'MERGEN_ROTA_KEYCLOAK_BASE_URL',
    'MERGEN_ROTA_KEYCLOAK_REALM',
    'MERGEN_ROTA_KEYCLOAK_CLIENT_ID',
    'MERGEN_ROTA_KEYCLOAK_CLIENT_SECRET',
    'MERGEN_ROTA_KEYCLOAK_AUDIENCE',
    'MERGEN_ROTA_KEYCLOAK_REDIRECT_URI',
    'MERGEN_ROTA_KEYCLOAK_POST_LOGOUT_REDIRECT_URI',
    'MERGEN_ROTA_KEYCLOAK_JWKS_CACHE_TTL_MS',
    'MERGEN_ROTA_KEYCLOAK_USERNAME_SICIL_FALLBACK',
    'MERGEN_ROTA_AUTH_DEBUG',
    'MERGEN_ROTA_SESSION_SECRET',
    'NEXT_PUBLIC_MERGEN_ROTA_USER_PHOTO_BASE_URL'
  ];
  for (const key of required) assert.match(env, new RegExp(`^${key}=`, 'm'), key);

  // Değerler yalnızca yer tutucudur; gerçek sır veya adres yoktur.
  assert.match(env, /MERGEN_ROTA_SESSION_SECRET=<LONG_RANDOM_SECRET>/);
  assert.match(env, /MERGEN_ROTA_KEYCLOAK_CLIENT_SECRET=$/m, 'client secret boş bırakılmalıdır');
  assert.match(env, /NEXT_PUBLIC_MERGEN_ROTA_USER_PHOTO_BASE_URL=https:\/\/<INTERNAL_PHOTO_HOST>\/<PHOTO_PATH>/);
});

test('yalnızca fotoğraf taban adresi NEXT_PUBLIC ile açığa çıkar ve bu belgelenmiştir', () => {
  const env = read('.env.example');
  const publicKeys = [...env.matchAll(/^(NEXT_PUBLIC_[A-Z0-9_]+)=/gm)].map((match) => match[1]);
  assert.deepEqual(publicKeys, ['NEXT_PUBLIC_MERGEN_ROTA_USER_PHOTO_BASE_URL']);
  // Tarayıcıya açık olduğu açıkça yazılmıştır.
  assert.match(env, /NOT A SECRET/);
  assert.match(env, /inlined into the client\s*\n#\s*bundle/);

  // Sırlar hiçbir biçimde NEXT_PUBLIC_ ile taşınmaz.
  for (const secret of ['SESSION_SECRET', 'CLIENT_SECRET', 'DB_', 'AUTH_MODE']) {
    assert.doesNotMatch(env, new RegExp(`NEXT_PUBLIC_[A-Z0-9_]*${secret}`));
  }
});

test('.env.local Git tarafından yok sayılır ve depoda bulunmaz', () => {
  const gitignore = read('.gitignore');
  assert.match(gitignore, /^\.env\*$/m);
  assert.match(gitignore, /^!\.env\.example$/m);

  const files = walk(ROOT).map((file) => path.relative(ROOT, file));
  const committedEnv = files.filter((file) => /(^|\/)\.env($|\.)/.test(file) && !file.endsWith('.env.example'));
  assert.deepEqual(committedEnv, [], 'yalnızca .env.example depoda bulunmalıdır');
});

/* ── Gizlilik ───────────────────────────────────────────── */

test('istemci paketine sunucu tarafı kimlik yapılandırması sızmaz', () => {
  const clientDirectories = ['src/components', 'src/features', 'src/state', 'src/data', 'src/lib', 'src/hooks'];
  for (const directory of clientDirectories) {
    for (const file of walk(path.join(ROOT, directory))) {
      if (!/\.(js|jsx|mjs)$/.test(file)) continue;
      const source = readFileSync(file, 'utf8');
      const relative = path.relative(ROOT, file);
      assert.doesNotMatch(source, /MERGEN_ROTA_SESSION_SECRET/, relative);
      assert.doesNotMatch(source, /MERGEN_ROTA_KEYCLOAK_CLIENT_SECRET/, relative);
      assert.doesNotMatch(source, /process\.env\.MERGEN_ROTA_KEYCLOAK_/, relative);
      // İstemci yalnızca NEXT_PUBLIC_ değişkenini okuyabilir.
      for (const match of source.match(/process\.env\.[A-Z0-9_]+/g) || []) {
        assert.ok(
          match.startsWith('process.env.NEXT_PUBLIC_') || match === 'process.env.NODE_ENV',
          `${relative}: istemci katmanı ${match} okumamalıdır`
        );
      }
    }
  }
});

test('depoda gerçek sicil, gerçek jeton veya gerçek kurumsal adres bulunmaz', () => {
  const scanned = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'test')), ...walk(path.join(ROOT, 'database'))]
    .filter((file) => /\.(js|jsx|mjs|sql)$/.test(file));

  // Tarayıcının kendisi aranan değerleri sabit olarak içerir; kendini denetlemez.
  const selfPath = fileURLToPath(import.meta.url);
  for (const file of [...scanned, ...DOC_AND_CONFIG_FILES.map((name) => path.join(ROOT, name))]) {
    if (file === selfPath) continue;
    if (!statSync(file).isFile()) continue;
    const source = readFileSync(file, 'utf8');
    const relative = path.relative(ROOT, file);
    // Kaldırılan gerçek sicil değerleri geri gelmemelidir.
    for (const sicil of ['10276', '18068', '23977', '17205']) {
      assert.equal(source.includes(sicil), false, `${relative}: gerçek sicil değeri (${sicil}) bulunmamalıdır`);
    }
    // Gerçek JWT veya Bearer jetonu yer almamalıdır.
    assert.doesNotMatch(source, /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}/, `${relative}: ham JWT bulunmamalıdır`);
  }
});

test('SQL kurulum betiği sistem yöneticilerini parametreli tohumlar', () => {
  const sql = read('database/MR_Create_Durable_Persistence.sql');
  assert.match(sql, /DECLARE @SystemAdminSicils nvarchar\(400\) = N'';/);
  assert.match(sql, /FROM STRING_SPLIT\(@SystemAdminSicils, ','\)/);
  assert.doesNotMatch(sql, /VALUES \(\d{4,},\s*'SYSTEM_ADMIN'/);
  // Kimlik doğrulama şema değişikliği gerektirmez; yalnızca sağlayıcı değişti.
  assert.match(sql, /0003_keycloak_identity/);
});

/* ── Rota yüzeyi ────────────────────────────────────────── */

test('kimlik doğrulama uçları beklenen yolda ve Node çalışma zamanındadır', () => {
  for (const name of ['login', 'callback', 'session', 'logout']) {
    const source = read(`src/app/api/mergen-rota/auth/${name}/route.js`);
    assert.match(source, /export const runtime = 'nodejs';/);
    assert.match(source, /export const dynamic = 'force-dynamic';/);
    assert.match(source, /force-no-store/);
  }
});

test('korunan veri uçları sunucu tarafı yetkilendirmeyi korur', () => {
  assert.match(read('src/app/api/mergen-rota/session/route.js'), /loadSessionContext\(\)/);
  assert.match(read('src/app/api/mergen-rota/snapshot/route.js'), /createProjectedSqlAppRepository\(\)\.loadSnapshot\(\)/);
  assert.match(read('src/app/api/mergen-rota/commit/route.js'), /createOrderedSqlAppRepository\(\)\.commitChanges\(changes\)/);

  // Yetki kararı React bileşenlerine taşınmadı.
  const authorization = read('src/server/authorization/loadAuthorizationContext.js');
  assert.match(authorization, /getTrustedCurrentSicil\(\)/);
  assert.match(authorization, /MR_UserRoles/);
  assert.match(authorization, /MR_V_CorporateProjectAccess/);
});
