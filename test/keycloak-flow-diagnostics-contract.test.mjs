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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(path.join(ROOT, relativePath), 'utf8');

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

test('CMD dosyası NODE_EXTRA_CA_CERTS eksikse durur ve değerini yazdırmaz', () => {
  assert.match(CMD, /if not defined NODE_EXTRA_CA_CERTS \(/);
  assert.match(CMD, /exit \/b 1/);
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

test('.env.example akış anahtarlarını yer tutucularla belgeler', () => {
  assert.match(ENV_EXAMPLE, /^MERGEN_ROTA_KEYCLOAK_FLOW=authorization-code$/m);
  assert.match(ENV_EXAMPLE, /^MERGEN_ROTA_KEYCLOAK_IMPLICIT_REDIRECT_URI=https:\/\/<MERGEN_ROTA_HOST>:8008\/auth\/implicit-callback$/m);
  // Authorization Code adresi implicit köprüye devredilmez.
  assert.match(ENV_EXAMPLE, /^MERGEN_ROTA_KEYCLOAK_REDIRECT_URI=https:\/\/<MERGEN_ROTA_HOST>:8008\/api\/mergen-rota\/auth\/callback$/m);
  assert.match(ENV_EXAMPLE, /^MERGEN_ROTA_KEYCLOAK_CLIENT_SECRET=$/m);

  // Doğrudan test örneği yalnızca yer tutucu kullanır.
  assert.match(ENV_EXAMPLE, /http:\/\/<TEST_HOST>:8008\/auth\/implicit-callback/);
  assert.match(ENV_EXAMPLE, /MERGEN_ROTA_SESSION_COOKIE_SECURE=false/);
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
