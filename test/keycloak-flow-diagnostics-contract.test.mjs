/**
 * Teşhis betikleri ve akış sözleşmesi.
 *
 * `diagnose-keycloak.cjs` ve `run-keycloak-diagnosis.cmd` depoya dağıtım yolu,
 * ağ paylaşımı, konak adı, sertifika konumu veya sır TAŞIMAZ ve seçili akışa
 * göre doğru sondaları çalıştırır.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(path.join(ROOT, relativePath), 'utf8');

// Betik doğrudan çalıştırılmadığında yalnızca saf yardımcıları verir; teşhis
// akışı başlamaz ve hiçbir ağ isteği yapılmaz.
const diagnostics = createRequire(import.meta.url)('../diagnose-keycloak.cjs');

const CMD = read('run-keycloak-diagnosis.cmd');
const SCRIPT = read('diagnose-keycloak.cjs');
const ENV_EXAMPLE = read('.env.example');

/* ── CMD sarmalayıcısı ──────────────────────────────────── */

test('CMD dosyası kendi depo dizininden çalışır ve dağıtım yolu içermez', () => {
  assert.match(CMD, /cd \/d "%~dp0"/, 'betik kendi konumuna geçmelidir');
  assert.match(CMD, /node diagnose-keycloak\.cjs/);

  // Eşlenmiş sürücü, UNC yolu, mutlak proje dizini veya sertifika konumu yok.
  assert.doesNotMatch(CMD, /\\\\[^\s"]+/, 'UNC yolu bulunmamalıdır');
  assert.doesNotMatch(CMD, /\b[A-Za-z]:\\/, 'sürücü harfli mutlak yol bulunmamalıdır');
  assert.doesNotMatch(CMD, /PROJECT_DIR/);
  assert.doesNotMatch(CMD, /\.pem|\.cer|\.crt|Sertifika/i, 'sertifika konumu bulunmamalıdır');
  assert.doesNotMatch(CMD, /set "NODE_EXTRA_CA_CERTS=/, 'sertifika yolu betiğe gömülmemelidir');
});

test('CMD dosyası NODE_EXTRA_CA_CERTS eksikse uyarır, durmaz ve değerini yazdırmaz', () => {
  assert.match(CMD, /if not defined NODE_EXTRA_CA_CERTS \(/);
  // Herkese açık güvenilen bir sertifikada bu değişken GEREKMEZ; sarmalayıcı
  // burada çıktığında TEST 2 hiç çalışmıyor ve o geçerli yapılandırma teşhis
  // edilemiyordu. Uyarır ve devam eder.
  assert.doesNotMatch(CMD, /exit \/b 1/);
  assert.match(CMD, /TEST 2 will report whether Node trusts the Keycloak certificate/);
  // Değişkenin GENİŞLETİLMİŞ değeri hiçbir yerde yazdırılmaz.
  assert.doesNotMatch(CMD, /echo[^\n]*%NODE_EXTRA_CA_CERTS%/);
});

/* ── Akışa duyarlı teşhis ───────────────────────────────── */

test('teşhis betiği akışı okur ve tanınmayan değeri açık hataya çevirir', () => {
  assert.match(SCRIPT, /MERGEN_ROTA_KEYCLOAK_FLOW/);
  assert.match(SCRIPT, /MERGEN_ROTA_KEYCLOAK_IMPLICIT_REDIRECT_URI/);
  assert.match(SCRIPT, /MERGEN_ROTA_KEYCLOAK_FLOW is invalid/);
  assert.match(SCRIPT, /'authorization-code'/);
  assert.match(SCRIPT, /'implicit-bridge'/);
});

test('authorization-code sondaları ve düzeltilmiş yorum korunur', () => {
  // Keşif, TLS ve PKCE sondaları yerinde.
  assert.match(SCRIPT, /well-known\/openid-configuration/);
  assert.match(SCRIPT, /code_challenge_method: 'S256'/);
  assert.match(SCRIPT, /grant_type: 'authorization_code'/);

  // 401 + unauthorized_client + "Invalid client" artık gizli istemci kimlik
  // doğrulaması olarak yorumlanır, "Standard Flow kapalı" olarak değil.
  assert.match(SCRIPT, /invalid client/i);
  assert.match(SCRIPT, /CONFIDENTIAL-CLIENT AUTHENTICATION FAILED/);
  assert.match(SCRIPT, /does NOT mean Standard Flow is disabled/);
  assert.match(SCRIPT, /tokenResponse\.status === 401/);
});

test('implicit-bridge teşhisi jeton ucunu kullanmaz ve gerçek jeton yakalamaz', () => {
  assert.match(SCRIPT, /response_type: 'token'/);
  assert.match(SCRIPT, /response_mode: 'fragment'/);
  // Etkileşimsiz sonda: gerçek bir jeton hiç düzenlenmez.
  assert.match(SCRIPT, /prompt: 'none'/);
  assert.match(SCRIPT, /login_required/);
  assert.match(SCRIPT, /tokenEndpointUsed: false/);
  assert.match(SCRIPT, /clientSecretRequired: false/);
  assert.match(SCRIPT, /never calls the token endpoint/);

  // Parçanın yalnızca VARLIĞI raporlanır; içeriği okunmaz veya yazdırılmaz.
  assert.match(SCRIPT, /fragmentPresent/);
  assert.doesNotMatch(SCRIPT, /console\.log\([^)]*\.hash/);
});

test('yönlendirme çözümlemesi implicit akışta hatayı URL PARÇASINDAN okur', () => {
  const { describeRedirect } = diagnostics;
  const callback = 'https://rota.test.internal:8008/auth/implicit-callback';
  const requestUrl = 'https://keycloak.test.internal/realms/r/protocol/openid-connect/auth';

  // `response_mode=fragment`: sağlıklı etkileşimsiz sonda parçada döner.
  const healthy = describeRedirect(
    `${callback}#error=login_required&error_description=Giris%20gerekli&state=abc`,
    requestUrl,
    callback
  );
  assert.equal(healthy.returnsToConfiguredCallback, true);
  assert.equal(healthy.error, 'login_required');
  assert.equal(healthy.errorLocation, 'fragment');
  assert.equal(healthy.errorDescription, 'Giris gerekli');
  assert.equal(healthy.accessTokenReturned, false);

  // İstemci reddi de parçadan tanınır.
  const rejected = describeRedirect(`${callback}#error=unauthorized_client`, requestUrl, callback);
  assert.equal(rejected.error, 'unauthorized_client');
  assert.equal(rejected.errorLocation, 'fragment');

  // Authorization Code akışı sorgu dizesinden okunmayı sürdürür.
  const codeFlow = describeRedirect(
    'https://rota.test.internal:8008/api/mergen-rota/auth/callback?error=login_required',
    requestUrl,
    'https://rota.test.internal:8008/api/mergen-rota/auth/callback'
  );
  assert.equal(codeFlow.error, 'login_required');
  assert.equal(codeFlow.errorLocation, 'query');
});

test('yönlendirme çözümlemesi jeton değerini okumaz, yalnızca varlığını bildirir', () => {
  const callback = 'https://rota.test.internal:8008/auth/implicit-callback';
  const described = diagnostics.describeRedirect(
    `${callback}#access_token=sentetik.jeton.degeri&token_type=bearer&state=abc`,
    'https://keycloak.test.internal/realms/r/protocol/openid-connect/auth',
    callback
  );

  assert.equal(described.accessTokenReturned, true);
  assert.equal(described.fragmentPresent, true);
  assert.equal(described.error, null);
  // Jeton DEĞERİ hiçbir alanda bulunmaz.
  assert.equal(JSON.stringify(described).includes('sentetik.jeton.degeri'), false);
});

test('akış ayrıştırıcısı betikte de katıdır', () => {
  assert.equal(diagnostics.parseFlow(''), 'authorization-code');
  assert.equal(diagnostics.parseFlow('implicit-bridge'), 'implicit-bridge');
  assert.equal(diagnostics.parseFlow('implicit'), null);
  assert.deepEqual(diagnostics.SUPPORTED_FLOWS, ['authorization-code', 'implicit-bridge']);
});

test('canlı oturum açma rotası denetimi seçili akışı tanır', () => {
  assert.match(SCRIPT, /api\/mergen-rota\/auth\/login/);
  assert.match(SCRIPT, /responseType: 'code'/);
  assert.match(SCRIPT, /responseType: 'token'/);
  assert.match(SCRIPT, /pkceChallengePresent: false/);
  assert.match(SCRIPT, /pkceChallengePresent: true/);
  assert.match(SCRIPT, /mismatches/);
});

test('teşhis betiği sır, jeton veya sertifika yolu yazdırmaz', () => {
  // Yalnızca "verildi mi" bilgisi raporlanır.
  assert.match(SCRIPT, /clientSecretSupplied: Boolean\(clientSecret\)/);
  assert.match(SCRIPT, /nodeExtraCaCertsConfigured: Boolean\(text\(env\.NODE_EXTRA_CA_CERTS\)\)/);
  // Ham secret veya sertifika yolu asla yazdırılmaz.
  assert.doesNotMatch(SCRIPT, /clientSecret,\s*$/m);
  assert.doesNotMatch(SCRIPT, /sessionSecret: text/);
  assert.doesNotMatch(SCRIPT, /nodeExtraCaCerts: text\(env\.NODE_EXTRA_CA_CERTS\)/);
  // Yalnızca oturum anahtarının UZUNLUĞU raporlanır.
  assert.match(SCRIPT, /sessionSecretLength: text\(env\.MERGEN_ROTA_SESSION_SECRET\)\.length/);
});

test('teşhis dosyaları gerçek konak, IP veya kurumsal adres taşımaz', () => {
  for (const [name, source] of [['run-keycloak-diagnosis.cmd', CMD], ['diagnose-keycloak.cjs', SCRIPT]]) {
    // Sabit bir dış adres veya IP gömülü değildir; adresler ortamdan gelir.
    assert.doesNotMatch(source, /https?:\/\/(?!127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i, name);
    assert.doesNotMatch(source, /\b(?:\d{1,3}\.){3}\d{1,3}\b(?<!127\.0\.0\.1)/, name);
  }
  // Yerel denetim yalnızca geri döngü adresini kullanır.
  assert.match(SCRIPT, /127\.0\.0\.1/);
});

/* ── Ortam şablonu ──────────────────────────────────────── */

test('.env.example mevcut kurumsal uyumluluk için implicit köprüyü etkin tutar', () => {
  assert.match(ENV_EXAMPLE, /^NEXT_PUBLIC_MERGEN_ROTA_PUBLIC_BASE_PATH=\/rota$/m);
  // Kurumsal istemci secret sağlamadığı için çalışan uyumluluk akışı etkindir.
  assert.match(ENV_EXAMPLE, /^MERGEN_ROTA_KEYCLOAK_FLOW=implicit-bridge$/m);
  assert.doesNotMatch(ENV_EXAMPLE, /^MERGEN_ROTA_KEYCLOAK_FLOW=authorization-code$/m);
  assert.match(ENV_EXAMPLE, /^MERGEN_ROTA_KEYCLOAK_CLIENT_SECRET=$/m);
  assert.match(ENV_EXAMPLE, /^MERGEN_ROTA_KEYCLOAK_IMPLICIT_REDIRECT_URI=https:\/\/<MERGEN_HOST>\/rota\/auth\/implicit-callback$/m);
  assert.match(ENV_EXAMPLE, /^MERGEN_ROTA_SESSION_COOKIE_SECURE=true$/m);

  // Authorization Code adresi implicit köprü adresine devredilmez.
  assert.match(ENV_EXAMPLE, /^MERGEN_ROTA_KEYCLOAK_REDIRECT_URI=$/m);
  assert.match(ENV_EXAMPLE, /MERGEN_ROTA_KEYCLOAK_FLOW=authorization-code/);
  assert.match(ENV_EXAMPLE, /Keycloak BT[\s\S]*implicit-bridge olarak tutulmalıdır/);
  assert.match(ENV_EXAMPLE, /NODE_EXTRA_CA_CERTS/);
});

test('belgeler her iki akışı ve jeton güvencelerini açıklar', () => {
  const doc = read('docs/KEYCLOAK-SSO.md');
  const readme = read('README.md');

  for (const source of [doc, readme]) {
    assert.match(source, /authorization-code/);
    assert.match(source, /implicit-bridge/);
  }
  assert.match(doc, /response_type=token/);
  assert.match(doc, /response_mode=fragment/);
  assert.match(doc, /history\.replaceState/);
  assert.match(doc, /Invalid client or Invalid client credentials/);
  assert.match(doc, /jeton endpoint'i|Jeton endpoint'i/i);
  assert.match(doc, /NODE_EXTRA_CA_CERTS/);
  assert.match(doc, /MERGEN_ROTA_SESSION_COOKIE_SECURE=true/);
  // Geliştirme kimliği üretim yedeği DEĞİLDİR.
  assert.match(doc, /üretim yedeği/);
  assert.match(readme, /üretim yedeği/);
});
