/**
 * Yapay zekâ · kimlik bilgisi güvenliği.
 *
 * Kişisel anahtar yalnızca şifreli saklanır, sahibi yalnızca güvenilir oturum
 * Sicil'idir, A'nın anahtarı B'ye hiçbir yoldan geçmez ve kişisel anahtarın
 * başarısızlığı hiçbir koşulda kurumsal anahtara aktarılmaz.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_KEY,
  MASTER_KEY,
  OTHER_MASTER_KEY,
  PERSONAL_KEY_A,
  PERSONAL_KEY_B,
  SICIL_A,
  SICIL_B,
  SICIL_UNKNOWN,
  aiRequest,
  captureConsole,
  createAiStack,
  credentialRoute,
  credentialStatus,
  readJson,
  removeKey,
  runProbe,
  saveKey,
  validateKey
} from './helpers/aiStack.mjs';

const { decryptCredential, encryptCredential, masterKeyId, CREDENTIAL_VAULT_FAILURES } = await import('../src/server/ai/credentialVault.js');
const { parseAiConfig, aiConfigurationSummary, NO_CREDENTIAL_SOURCE } = await import('../src/server/ai/aiConfig.js');
const {
  AI_CREDENTIAL_SOURCES,
  apiKeyHint,
  normalizeApiKeyInput,
  selectCredentialSource
} = await import('../src/domain/ai/aiCredentialPolicy.js');

const masterBytes = (text) => Buffer.from(text, 'base64url');

function encodings(value) {
  const buffer = Buffer.from(value, 'utf8');
  return [value, buffer.toString('base64'), buffer.toString('base64url'), buffer.toString('hex')];
}

/** Bir değerin serileştirilmiş hâlinde anahtarın hiçbir kodlaması bulunmamalıdır. */
function assertNoSecret(haystack, secrets, label) {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack, (key, value) => (
    value?.type === 'Buffer' && Array.isArray(value.data) ? Buffer.from(value.data).toString('latin1') : value
  ));
  for (const secret of secrets) {
    for (const encoded of encodings(secret)) {
      assert.equal(text.includes(encoded), false, `${label}: gizli değer (${secret.slice(0, 8)}…) sızdı`);
    }
  }
}

/* ── Şifreleme kasası ─────────────────────────────────────── */

test('kasa AES-256-GCM ile şifreler, çözer ve her kayıtta yeni nonce üretir', () => {
  const master = masterBytes(MASTER_KEY);
  const first = encryptCredential({ masterKey: master, sicil: SICIL_A, apiKey: PERSONAL_KEY_A });
  const second = encryptCredential({ masterKey: master, sicil: SICIL_A, apiKey: PERSONAL_KEY_A });
  assert.equal(first.nonce.length, 12);
  assert.equal(first.authTag.length, 16);
  assert.equal(first.encryptionVersion, 1);
  assert.equal(first.masterKeyId, masterKeyId(master));
  assert.notDeepEqual(first.nonce, second.nonce);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assertNoSecret({ ...first }, [PERSONAL_KEY_A], 'şifreli kayıt');
  assert.equal(decryptCredential({ masterKey: master, sicil: SICIL_A, record: first }), PERSONAL_KEY_A);
});

test('şifre sahibine bağlıdır; bozulmuş, başka Sicil’e taşınmış ya da başka ana anahtarla yazılmış kayıt çözülmez', () => {
  const master = masterBytes(MASTER_KEY);
  const record = encryptCredential({ masterKey: master, sicil: SICIL_A, apiKey: PERSONAL_KEY_A });
  const failure = (work) => {
    try {
      work();
    } catch (error) {
      return error.code;
    }
    return null;
  };
  assert.equal(failure(() => decryptCredential({ masterKey: master, sicil: SICIL_B, record })), CREDENTIAL_VAULT_FAILURES.AUTHENTICATION_FAILED);
  const tampered = { ...record, ciphertext: Buffer.from(record.ciphertext) };
  tampered.ciphertext[0] ^= 0xff;
  assert.equal(failure(() => decryptCredential({ masterKey: master, sicil: SICIL_A, record: tampered })), CREDENTIAL_VAULT_FAILURES.AUTHENTICATION_FAILED);
  const wrongTag = { ...record, authTag: Buffer.alloc(16, 7) };
  assert.equal(failure(() => decryptCredential({ masterKey: master, sicil: SICIL_A, record: wrongTag })), CREDENTIAL_VAULT_FAILURES.AUTHENTICATION_FAILED);
  assert.equal(failure(() => decryptCredential({ masterKey: masterBytes(OTHER_MASTER_KEY), sicil: SICIL_A, record })), CREDENTIAL_VAULT_FAILURES.MASTER_KEY_MISMATCH);
  assert.equal(failure(() => decryptCredential({ masterKey: master, sicil: SICIL_A, record: { ...record, encryptionVersion: 2 } })), CREDENTIAL_VAULT_FAILURES.UNSUPPORTED_VERSION);
  assert.equal(failure(() => decryptCredential({ masterKey: master, sicil: SICIL_A, record: { ...record, nonce: Buffer.alloc(3) } })), CREDENTIAL_VAULT_FAILURES.MALFORMED);
});

/* ── Yapılandırma ─────────────────────────────────────────── */

test('yapılandırma kapalı kalacak biçimde doğrulanır ve özet gizli değer taşımaz', () => {
  const base = {
    MERGEN_ROTA_AI_ENABLED: 'true',
    MERGEN_ROTA_AI_BASE_URL: 'https://ai-gateway.example.internal/v1/',
    MERGEN_ROTA_AI_DEFAULT_API_KEY: DEFAULT_KEY,
    MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY: MASTER_KEY,
    MERGEN_ROTA_AI_MODEL_REGISTRY_PATH: '\\\\dosya-sunucusu\\paylasim\\ai-models.json'
  };
  const healthy = parseAiConfig(base);
  assert.equal(healthy.available, true);
  assert.deepEqual(healthy.issues, []);
  assert.equal(healthy.baseUrl, 'https://ai-gateway.example.internal/v1');
  assert.equal(healthy.personalKeysSupported, true);
  assert.equal(healthy.defaultKeyConfigured, true);
  const summary = aiConfigurationSummary(healthy);
  assertNoSecret(summary, [DEFAULT_KEY, MASTER_KEY, 'ai-gateway.example.internal', 'dosya-sunucusu'], 'yapılandırma özeti');
  assert.equal(summary.registrySource, 'file');

  const issuesFor = (overrides) => parseAiConfig({ ...base, ...overrides }).issues;
  assert.deepEqual(issuesFor({ MERGEN_ROTA_AI_BASE_URL: 'http://ai-gateway.example.internal/v1' }), ['MERGEN_ROTA_AI_BASE_URL']);
  assert.deepEqual(issuesFor({ MERGEN_ROTA_AI_BASE_URL: 'http://ai-gateway.example.internal/v1', MERGEN_ROTA_AI_ALLOW_INSECURE_HTTP: 'true' }), []);
  assert.deepEqual(issuesFor({ MERGEN_ROTA_AI_BASE_URL: 'http://127.0.0.1:8099/v1' }), []);
  assert.deepEqual(issuesFor({ MERGEN_ROTA_AI_BASE_URL: 'https://kullanici:parola@ai.example.internal/v1' }), ['MERGEN_ROTA_AI_BASE_URL']);
  assert.deepEqual(issuesFor({ MERGEN_ROTA_AI_BASE_URL: '' }), ['MERGEN_ROTA_AI_BASE_URL']);
  assert.deepEqual(issuesFor({ MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY: '<32_BAYT_BASE64URL_ANAHTAR>' }), ['MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY']);
  assert.deepEqual(issuesFor({ MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY: 'kisa-ama-gecersiz' }), ['MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY']);
  assert.deepEqual(issuesFor({ MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 1).toString('base64url') }), ['MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY']);
  assert.deepEqual(issuesFor({ MERGEN_ROTA_AI_DEFAULT_API_KEY: '<KURUMSAL_ANAHTAR_YER_TUTUCU>' }), ['MERGEN_ROTA_AI_DEFAULT_API_KEY']);
  assert.deepEqual(issuesFor({ MERGEN_ROTA_AI_MAX_ACTIVE_REQUESTS: '0' }), ['MERGEN_ROTA_AI_MAX_ACTIVE_REQUESTS']);
  assert.deepEqual(issuesFor({ MERGEN_ROTA_AI_MAX_ACTIVE_REQUESTS: '2', MERGEN_ROTA_AI_MAX_ACTIVE_PER_USER: '3' }), ['MERGEN_ROTA_AI_MAX_ACTIVE_PER_USER']);
  assert.deepEqual(issuesFor({ MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS: 'sonsuz' }), ['MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS']);
  assert.deepEqual(issuesFor({ MERGEN_ROTA_AI_MODEL_REGISTRY_PATH: 'goreli/ai.json' }), ['MERGEN_ROTA_AI_MODEL_REGISTRY_PATH']);
  assert.deepEqual(issuesFor({ MERGEN_ROTA_AI_DEFAULT_API_KEY: '', MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY: '' }), [NO_CREDENTIAL_SOURCE]);

  const invalidSwitch = parseAiConfig({ ...base, MERGEN_ROTA_AI_ENABLED: 'belki' });
  assert.equal(invalidSwitch.enabled, false);
  assert.deepEqual(invalidSwitch.issues, ['MERGEN_ROTA_AI_ENABLED']);
  assert.equal(parseAiConfig({}).enabled, false, 'varsayılan kapalıdır');

  // Kurumsal anahtar kişisel anahtarla aynı biçim kuralından geçer; yalnızca
  // bütünüyle yer tutucu olan değer reddedilir.
  const angleKey = 'kurum<anahtar>degeri-9f3Kq2Lm';
  assert.equal(normalizeApiKeyInput(angleKey).ok, true);
  assert.deepEqual(issuesFor({ MERGEN_ROTA_AI_DEFAULT_API_KEY: angleKey }), []);
  assert.equal(parseAiConfig({ ...base, MERGEN_ROTA_AI_DEFAULT_API_KEY: angleKey }).defaultApiKey, angleKey);
});

test('anahtar biçimi tek kuraldan denetlenir; kaynak seçimi yalnızca varlığa bakar', () => {
  assert.deepEqual(normalizeApiKeyInput(`  ${PERSONAL_KEY_A}\n`), { ok: true, value: PERSONAL_KEY_A });
  assert.equal(normalizeApiKeyInput('').reason, 'EMPTY');
  assert.equal(normalizeApiKeyInput('kisa').reason, 'TOO_SHORT');
  assert.equal(normalizeApiKeyInput('ara boşluk içeren anahtar değeri').reason, 'INVALID_CHARACTERS');
  assert.equal(normalizeApiKeyInput(`abc\u0000${PERSONAL_KEY_A}`).reason, 'INVALID_CHARACTERS');
  assert.equal(normalizeApiKeyInput('x'.repeat(600)).reason, 'TOO_LONG');
  assert.equal(apiKeyHint(PERSONAL_KEY_A), PERSONAL_KEY_A.slice(-4));
  assert.equal(selectCredentialSource({ personalKeyStored: true, defaultKeyConfigured: true }), AI_CREDENTIAL_SOURCES.PERSONAL);
  assert.equal(selectCredentialSource({ personalKeyStored: false, defaultKeyConfigured: true }), AI_CREDENTIAL_SOURCES.DEFAULT);
  assert.equal(selectCredentialSource({ personalKeyStored: false, defaultKeyConfigured: false }), AI_CREDENTIAL_SOURCES.MISSING);
});

/* ── Kaydetme, okuma, kaldırma ────────────────────────────── */

test('kişisel anahtar şifreli kaydedilir; yanıt ve kalıcı veri düz metni hiçbir kodlamada taşımaz', async (t) => {
  const { db } = createAiStack(t);
  const saved = await saveKey(`  ${PERSONAL_KEY_A}  `);
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  assert.deepEqual(
    { configured: saved.body.ai.credential.configured, hint: saved.body.ai.credential.hint, source: saved.body.ai.effectiveSource },
    { configured: true, hint: PERSONAL_KEY_A.slice(-4), source: 'personal' }
  );
  assertNoSecret(saved.text, [PERSONAL_KEY_A, DEFAULT_KEY, MASTER_KEY], 'kaydetme yanıtı');

  const status = await credentialStatus();
  assert.equal(status.body.ai.credential.configured, true);
  assert.equal(status.body.ai.credential.lastValidationStatus, null);
  assertNoSecret(status.text, [PERSONAL_KEY_A, DEFAULT_KEY, MASTER_KEY], 'durum yanıtı');
  for (const field of ['ciphertext', 'nonce', 'authTag', 'rowVersion', 'masterKeyId', 'apiKey']) {
    assert.equal(field in status.body.ai.credential, false, `${field} tarayıcıya gitmemeli`);
  }

  assert.equal(db.aiUserCredentials.length, 1);
  const [row] = db.aiUserCredentials;
  assert.equal(row.Sicil, SICIL_A);
  assert.equal(row.KeyHint, PERSONAL_KEY_A.slice(-4));
  assertNoSecret(row, [PERSONAL_KEY_A], 'veritabanı satırı');
  // Veritabanına giden HİÇBİR deyim parametresi düz anahtarı taşımaz.
  assertNoSecret(db.aiCredentialLog.statements.map((entry) => entry.params), [PERSONAL_KEY_A], 'SQL parametreleri');
  assert.equal(decryptCredential({
    masterKey: masterBytes(MASTER_KEY),
    sicil: SICIL_A,
    record: { encryptionVersion: row.EncryptionVersion, masterKeyId: row.MasterKeyId, nonce: row.Nonce, ciphertext: row.Ciphertext, authTag: row.AuthTag }
  }), PERSONAL_KEY_A);

  const replaced = await saveKey(PERSONAL_KEY_B);
  assert.equal(replaced.body.ai.credential.hint, PERSONAL_KEY_B.slice(-4));
  assert.equal(db.aiUserCredentials.length, 1, 'değiştirme ikinci satır üretmez');

  const removed = await removeKey();
  assert.equal(removed.status, 200);
  assert.equal(removed.body.ai.credential.configured, false);
  assert.equal(removed.body.ai.effectiveSource, 'default');
  assert.equal(db.aiUserCredentials.length, 0);
});

test('geçersiz biçim ve bozuk gövde 400 döner; gövde yankılanmaz', async (t) => {
  const { db } = createAiStack(t);
  const logs = captureConsole(t);
  const tooShort = await saveKey('kisa-anahtar');
  assert.equal(tooShort.status, 400);
  assert.equal(tooShort.body.error.code, 'AI_REQUEST_INVALID');
  assert.match(tooShort.body.error.message, /en az 16 karakter/);

  const malformed = await readJson(await credentialRoute.PUT(aiRequest('/credential', { method: 'PUT', body: `{"apiKey": ${PERSONAL_KEY_A}` })));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.details.reason, 'MALFORMED_JSON');
  assertNoSecret(malformed.text, [PERSONAL_KEY_A], 'bozuk gövde yanıtı');

  const oversized = await readJson(await credentialRoute.PUT(aiRequest('/credential', { method: 'PUT', body: { apiKey: PERSONAL_KEY_A, pad: 'x'.repeat(9000) } })));
  assert.equal(oversized.body.error.details.reason, 'BODY_TOO_LARGE');

  const plainText = await readJson(await credentialRoute.PUT(aiRequest('/credential', {
    method: 'PUT', body: JSON.stringify({ apiKey: PERSONAL_KEY_A }), headers: { 'content-type': 'text/plain' }
  })));
  assert.equal(plainText.body.error.details.reason, 'CONTENT_TYPE');

  assert.equal((db.aiUserCredentials || []).length, 0);
  assertNoSecret(logs.join('\n'), [PERSONAL_KEY_A, DEFAULT_KEY], 'günlük');
});

/* ── Sicil yalıtımı ───────────────────────────────────────── */

test('A Sicil’inin anahtarı B’ye görünmez, B tarafından silinemez ve B’nin isteğinde kullanılmaz', async (t) => {
  const { db, provider, useSicil } = createAiStack(t);
  await saveKey(PERSONAL_KEY_A);

  useSicil(SICIL_B);
  const statusB = await credentialStatus();
  assert.equal(statusB.body.ai.credential.configured, false);
  assert.equal(statusB.body.ai.effectiveSource, 'default');
  assertNoSecret(statusB.text, [PERSONAL_KEY_A], 'B durumu');

  const validationB = await validateKey();
  assert.equal(validationB.status, 409);
  assert.equal(validationB.body.error.code, 'AI_KEY_MISSING');

  const removeB = await removeKey();
  assert.equal(removeB.status, 200);
  assert.equal(db.aiUserCredentials.length, 1, 'B, A’nın satırını silemez');
  assert.equal(db.aiUserCredentials[0].Sicil, SICIL_A);

  const probeB = await runProbe();
  assert.equal(probeB.status, 200);
  assert.equal(probeB.body.result.credentialSource, 'default');
  assert.deepEqual(provider.calls.map((call) => call.apiKey), [DEFAULT_KEY]);

  useSicil(SICIL_A);
  const probeA = await runProbe();
  assert.equal(probeA.body.result.credentialSource, 'personal');
  assert.deepEqual(provider.calls.map((call) => call.apiKey), [DEFAULT_KEY, PERSONAL_KEY_A]);
});

test('tarayıcının gönderdiği Sicil gövdede, sorguda ya da başlıkta sahipliği değiştiremez', async (t) => {
  const { db } = createAiStack(t);
  const response = await credentialRoute.PUT(new Request(`http://localhost/api/mergen-rota/ai/credential?sicil=${SICIL_B}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-mergen-rota-sicil': String(SICIL_B), 'x-user-sicil': String(SICIL_B) },
    body: JSON.stringify({ apiKey: PERSONAL_KEY_A, sicil: SICIL_B, ownerSicil: SICIL_B, username: 'denemeb' })
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(db.aiUserCredentials.map((row) => row.Sicil), [SICIL_A]);
});

test('veritabanında B’nin satırına kopyalanan şifreli anahtar çözülmez ve kurumsal anahtara geçilmez', async (t) => {
  const { db, provider, useSicil } = createAiStack(t);
  await saveKey(PERSONAL_KEY_A);
  db.aiUserCredentials.push({ ...db.aiUserCredentials[0], Sicil: SICIL_B });

  useSicil(SICIL_B);
  const probe = await runProbe();
  assert.equal(probe.status, 422);
  assert.equal(probe.body.error.code, 'AI_KEY_INVALID');
  assert.equal(probe.body.error.details.reason, 'CREDENTIAL_UNREADABLE');
  assert.equal(provider.calls.length, 0, 'ne A’nın anahtarı ne de kurumsal anahtar kullanılır');
});

test('oturumu olmayan çağıran yapılandırmayı ve kurumsal anahtarı yoklayamaz', async (t) => {
  const { db, provider, setEnv } = createAiStack(t, { env: { MERGEN_ROTA_DEV_SICIL: null } });
  for (const response of [await credentialStatus(), await saveKey(DEFAULT_KEY), await saveKey('kisa'), await runProbe(), await validateKey()]) {
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'UNAUTHORIZED');
    assertNoSecret(response.text, [DEFAULT_KEY], 'kimliksiz yanıt');
  }
  // Özellik kapalıyken de yanıt aynıdır: kimliksiz çağıran açık/kapalı ayrımını öğrenemez.
  setEnv({ MERGEN_ROTA_AI_ENABLED: 'false' });
  for (const response of [await saveKey(PERSONAL_KEY_A), await runProbe(), await validateKey()]) {
    assert.equal(response.status, 401);
  }
  assert.equal((db.aiUserCredentials || []).length, 0);
  assert.equal(provider.calls.length, 0);
});

test('kaydedilen anahtar kurumsal anahtarla karşılaştırılmaz; yanıt kurumsal anahtar hakkında bilgi taşımaz', async (t) => {
  createAiStack(t);
  const saved = await saveKey(DEFAULT_KEY);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ai.effectiveSource, 'personal');
  assertNoSecret(saved.text, [DEFAULT_KEY], 'kayıt yanıtı');
});

test('rehberde bulunmayan Sicil anahtar yönetimine erişemez', async (t) => {
  createAiStack(t, { sicil: SICIL_UNKNOWN });
  const status = await credentialStatus();
  assert.equal(status.status, 401);
  assert.equal(status.body.error.code, 'UNAUTHORIZED');
  const saved = await saveKey(PERSONAL_KEY_A);
  assert.equal(saved.status, 401);
});

/* ── Kaynak seçimi ve geri düşmeme ────────────────────────── */

test('kişisel anahtar tercih edilir; kurumsal anahtar yalnızca kişisel anahtar YOKKEN kullanılır', async (t) => {
  const { provider } = createAiStack(t);
  const withoutPersonal = await runProbe();
  assert.equal(withoutPersonal.body.result.credentialSource, 'default');
  await saveKey(PERSONAL_KEY_A);
  const withPersonal = await runProbe();
  assert.equal(withPersonal.body.result.credentialSource, 'personal');
  await removeKey();
  const afterRemoval = await runProbe();
  assert.equal(afterRemoval.body.result.credentialSource, 'default');
  assert.deepEqual(provider.calls.map((call) => call.apiKey), [DEFAULT_KEY, PERSONAL_KEY_A, DEFAULT_KEY]);
});

for (const [label, behavior, code, status] of [
  ['401', { type: 'status', status: 401 }, 'AI_KEY_INVALID', 422],
  ['403', { type: 'status', status: 403 }, 'AI_UNAUTHORIZED', 403],
  ['429', { type: 'status', status: 429, retryAfter: '3' }, 'AI_RATE_LIMITED', 429],
  ['503', { type: 'status', status: 503 }, 'AI_PROVIDER_UNAVAILABLE', 502],
  ['ağ hatası', { type: 'network', code: 'ECONNRESET' }, 'AI_PROVIDER_UNAVAILABLE', 502],
  ['bozuk yanıt', { type: 'malformed' }, 'AI_PROVIDER_RESPONSE_INVALID', 502]
]) {
  test(`kişisel anahtar ${label} aldığında istek kurumsal anahtara AKTARILMAZ`, async (t) => {
    const { provider } = createAiStack(t);
    await saveKey(PERSONAL_KEY_A);
    provider.enqueue(behavior);
    const probe = await runProbe();
    assert.equal(probe.status, status);
    assert.equal(probe.body.error.code, code);
    assert.equal(provider.calls.length, 1);
    assert.deepEqual(provider.calls.map((call) => call.apiKey), [PERSONAL_KEY_A]);
    if (code === 'AI_KEY_INVALID' || code === 'AI_UNAUTHORIZED' || code === 'AI_RATE_LIMITED') {
      assert.equal(probe.body.error.details.credentialSource, 'personal');
    }
  });
}

test('kişisel anahtarla zaman aşımı da kurumsal anahtara aktarılmaz', async (t) => {
  const { provider } = createAiStack(t, { env: { MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS: '1000' } });
  await saveKey(PERSONAL_KEY_A);
  provider.enqueue({ type: 'stall' });
  const probe = await runProbe();
  assert.equal(probe.status, 504);
  assert.equal(probe.body.error.code, 'AI_TIMEOUT');
  assert.deepEqual(provider.calls.map((call) => call.apiKey), [PERSONAL_KEY_A]);
  assert.equal(provider.calls[0].aborted, true);
});

test('ana anahtar değiştiğinde kayıtlı kişisel anahtar okunamaz; istek reddedilir, kurumsal anahtar kullanılmaz', async (t) => {
  const { provider, setEnv } = createAiStack(t);
  await saveKey(PERSONAL_KEY_A);
  setEnv({ MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY: OTHER_MASTER_KEY });
  const probe = await runProbe();
  assert.equal(probe.status, 422);
  assert.equal(probe.body.error.details.reason, 'CREDENTIAL_UNREADABLE');
  assert.match(probe.body.error.message, /yeniden kaydedin/);
  assert.equal(provider.calls.length, 0);
});

test('kurumsal anahtar reddedildiğinde kullanıcı yöneticiye yönlendirilir', async (t) => {
  const { provider } = createAiStack(t);
  provider.enqueue({ type: 'status', status: 401 });
  const probe = await runProbe();
  assert.equal(probe.body.error.code, 'AI_KEY_INVALID');
  assert.equal(probe.body.error.details.credentialSource, 'default');
  assert.match(probe.body.error.message, /Kurumsal yapay zekâ anahtarı reddedildi/);
});

test('kişisel ve kurumsal anahtar yoksa istek sağlayıcıya gitmeden AI_KEY_MISSING ile reddedilir', async (t) => {
  const { provider } = createAiStack(t, { env: { MERGEN_ROTA_AI_DEFAULT_API_KEY: null } });
  const status = await credentialStatus();
  assert.equal(status.body.ai.effectiveSource, 'missing');
  assert.equal(status.body.ai.defaultKeyConfigured, false);
  const probe = await runProbe();
  assert.equal(probe.status, 409);
  assert.equal(probe.body.error.code, 'AI_KEY_MISSING');
  assert.equal(probe.body.error.details.credentialSource, 'missing');
  assert.equal(provider.calls.length, 0);
});

/* ── Doğrulama ────────────────────────────────────────────── */

test('doğrulama yalnızca kişisel anahtarı sınar ve sonucu zaman damgasıyla kaydeder', async (t) => {
  const { provider } = createAiStack(t);
  await saveKey(PERSONAL_KEY_A);

  provider.enqueue({ type: 'reply' });
  const valid = await validateKey();
  assert.equal(valid.status, 200);
  assert.equal(valid.body.validation.status, 'VALID');
  assert.ok(valid.body.validation.credential.lastValidatedAt);

  provider.enqueue({ type: 'status', status: 401 });
  const rejected = await validateKey();
  assert.equal(rejected.body.validation.status, 'REJECTED');
  assert.equal((await credentialStatus()).body.ai.credential.lastValidationStatus, 'REJECTED');

  provider.enqueue({ type: 'status', status: 403 });
  assert.equal((await validateKey()).body.validation.status, 'FORBIDDEN');

  // Erişilemeyen sağlayıcı anahtar hakkında sonuç ÜRETMEZ.
  provider.enqueue({ type: 'status', status: 503 });
  const inconclusive = await validateKey();
  assert.equal(inconclusive.status, 502);
  assert.equal((await credentialStatus()).body.ai.credential.lastValidationStatus, 'FORBIDDEN');

  // `VALID` ancak uç anahtarsız isteği reddediyorsa verilir: ilk sonuçtan sonra
  // anahtarsız bir denetim yapılır (kurumsal anahtar hiç kullanılmaz).
  assert.deepEqual(provider.calls.map((call) => [call.kind, call.apiKey]), [
    ['models', PERSONAL_KEY_A], ['models', null], ['models', PERSONAL_KEY_A], ['models', PERSONAL_KEY_A], ['models', PERSONAL_KEY_A]
  ]);

  // Anahtar değişince eski doğrulama sonucu taşınmaz.
  const replaced = await saveKey(PERSONAL_KEY_B);
  assert.equal(replaced.body.ai.credential.lastValidationStatus, null);
});

/* ── Şema ve kapalı özellik ───────────────────────────────── */

test('0016 uygulanmamışsa ayarlar çökmez, kişisel anahtar kaydı açıkça reddedilir, kurumsal anahtar çalışır', async (t) => {
  const { db, provider } = createAiStack(t);
  db.aiCredentialSchemaMissing = true;
  const status = await credentialStatus();
  assert.equal(status.status, 200);
  assert.equal(status.body.ai.schemaReady, false);
  assert.equal(status.body.ai.personalKeysSupported, false);
  const saved = await saveKey(PERSONAL_KEY_A);
  assert.equal(saved.status, 503);
  assert.equal(saved.body.error.details.reason, 'SCHEMA_MISSING');
  const probe = await runProbe();
  assert.equal(probe.body.result.credentialSource, 'default');
  assert.deepEqual(provider.calls.map((call) => call.apiKey), [DEFAULT_KEY]);
});

test('özellik kapalıyken kayıt ve istek reddedilir; kayıtlı anahtar yine de kaldırılabilir', async (t) => {
  const { db, provider, setEnv } = createAiStack(t);
  await saveKey(PERSONAL_KEY_A);
  setEnv({ MERGEN_ROTA_AI_ENABLED: 'false' });
  const status = await credentialStatus();
  assert.equal(status.body.ai.enabled, false);
  assert.equal(status.body.ai.credential.configured, true);
  assert.equal((await saveKey(PERSONAL_KEY_B)).body.error.code, 'AI_DISABLED');
  const probe = await runProbe();
  assert.equal(probe.status, 503);
  assert.equal(probe.body.error.code, 'AI_DISABLED');
  assert.equal(provider.calls.length, 0);
  assert.equal((await removeKey()).status, 200);
  assert.equal(db.aiUserCredentials.length, 0);
});

test('ana anahtar yokken kişisel anahtar saklanmaz; kurumsal anahtar kullanılmaya devam eder', async (t) => {
  const { provider } = createAiStack(t, { env: { MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY: null } });
  const status = await credentialStatus();
  assert.equal(status.body.ai.personalKeysSupported, false);
  const saved = await saveKey(PERSONAL_KEY_A);
  assert.equal(saved.status, 503);
  assert.equal(saved.body.error.details.reason, 'PERSONAL_KEYS_UNSUPPORTED');
  assert.equal((await runProbe()).body.result.credentialSource, 'default');
  assert.deepEqual(provider.calls.map((call) => call.apiKey), [DEFAULT_KEY]);
});

test('ana anahtar kaldırıldığında kayıtlı kişisel satır kurumsal anahtarı engellemez', async (t) => {
  const { db, provider, setEnv } = createAiStack(t);
  await saveKey(PERSONAL_KEY_A);
  setEnv({ MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY: null });
  const status = await credentialStatus();
  assert.equal(status.body.ai.personalKeysSupported, false);
  assert.equal(status.body.ai.effectiveSource, 'default', 'kullanılamayan kayıt etkin kaynak gösterilmez');
  assert.equal(status.body.ai.credential.configured, true, 'kayıt yine de kaldırılabilir');
  const probe = await runProbe();
  assert.equal(probe.status, 200);
  assert.equal(probe.body.result.credentialSource, 'default');
  assert.deepEqual(provider.calls.map((call) => call.apiKey), [DEFAULT_KEY]);
  assert.equal((await removeKey()).status, 200);
  assert.equal(db.aiUserCredentials.length, 0);
});

test('ana anahtar değişince durum, kayıtlı anahtarı okunamaz gösterir ve eski doğrulama sonucunu taşımaz', async (t) => {
  const { provider, setEnv } = createAiStack(t);
  await saveKey(PERSONAL_KEY_A);
  provider.enqueue({ type: 'reply' });
  assert.equal((await validateKey()).body.validation.status, 'VALID');
  assert.equal((await credentialStatus()).body.ai.credential.readable, true);

  setEnv({ MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY: OTHER_MASTER_KEY });
  const status = await credentialStatus();
  assert.equal(status.body.ai.credential.configured, true);
  assert.equal(status.body.ai.credential.readable, false);
  assert.equal(status.body.ai.credential.lastValidationStatus, null, 'eski VALID sonucu gösterilmez');
  assert.equal(status.body.ai.effectiveSource, 'personal', 'kural değişmez: kurumsal anahtara geçilmez');
  assert.equal('masterKeyId' in status.body.ai.credential, false);
  assertNoSecret(status.text, [MASTER_KEY, OTHER_MASTER_KEY, masterKeyId(masterBytes(MASTER_KEY))], 'durum yanıtı');
});

test('kaldırma, okuma ile silme arasında başka oturumda kaydedilen yeni anahtarı silmez', async (t) => {
  const { db } = createAiStack(t);
  await saveKey(PERSONAL_KEY_A);
  db.aiCredentialHooks = {
    beforeDelete(row, { nextRowVersion }) {
      db.aiCredentialHooks = null;
      // Başka sekmede yeni anahtar kaydedildi: satır sürümü değişir.
      Object.assign(row, { KeyHint: PERSONAL_KEY_B.slice(-4), RowVersion: nextRowVersion() });
    }
  };
  const removed = await removeKey();
  assert.equal(removed.status, 409);
  assert.equal(removed.body.error.code, 'CONFLICT');
  assert.equal(removed.headers.get('cache-control'), 'no-store');
  assert.equal(db.aiUserCredentials.length, 1, 'yeni anahtar korunur');
  assert.equal(db.aiUserCredentials[0].KeyHint, PERSONAL_KEY_B.slice(-4));
  // Çakışma olmadan kaldırma olağan biçimde çalışır.
  assert.equal((await removeKey()).status, 200);
  assert.equal(db.aiUserCredentials.length, 0);
});

test('0016 yokken rehberde olmayan Sicil kurumsal anahtarı kullanamaz ve durum öğrenemez', async (t) => {
  const { db, provider, useSicil } = createAiStack(t, { sicil: SICIL_UNKNOWN });
  db.aiCredentialSchemaMissing = true;
  for (const response of [await credentialStatus(), await removeKey(), await runProbe(), await validateKey()]) {
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'UNAUTHORIZED');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(provider.calls.length, 0, 'kurumsal anahtar kullanılmaz');
  // Rehberdeki Sicil için tablo yokluğu olağan davranışını korur.
  useSicil(SICIL_A);
  assert.equal((await credentialStatus()).status, 200);
  assert.equal((await runProbe()).body.result.credentialSource, 'default');
});

test('rehberde olmayan Sicil yapılandırma, profil ve biçim kararlarından önce reddedilir', async (t) => {
  const { provider, setEnv } = createAiStack(t, { sicil: SICIL_UNKNOWN });
  for (const env of [{ MERGEN_ROTA_AI_ENABLED: 'false' }, { MERGEN_ROTA_AI_ENABLED: 'true', MERGEN_ROTA_AI_BASE_URL: 'http://ai.example.internal/v1' }]) {
    setEnv(env);
    for (const response of [await runProbe(), await validateKey(), await saveKey('kisa'), await saveKey(PERSONAL_KEY_A)]) {
      assert.equal(response.status, 401, JSON.stringify(env));
      assert.equal(response.body.error.code, 'UNAUTHORIZED');
    }
  }
  assert.equal(provider.calls.length, 0);
});

test('doğrulama sürerken anahtar değiştirilirse sonuç yeni anahtara yazılmaz ve bayat olarak bildirilir', async (t) => {
  const { db, provider } = createAiStack(t);
  await saveKey(PERSONAL_KEY_A);
  provider.enqueue({ type: 'deferred' });
  const pending = validateKey();
  await provider.waitForActive(1);
  await saveKey(PERSONAL_KEY_B);
  provider.calls[0].resolve();
  const validation = await pending;
  assert.equal(validation.status, 200);
  assert.deepEqual(
    { status: validation.body.validation.status, stale: validation.body.validation.stale, hint: validation.body.validation.credential.hint },
    { status: null, stale: true, hint: PERSONAL_KEY_B.slice(-4) }
  );
  assert.equal(db.aiUserCredentials[0].LastValidationStatus, null, 'yeni anahtar doğrulanmış görünmez');
});

test('anahtarsız da model listesi veren uçta anahtar VALID sayılmaz ve sonuç kaydedilmez', async (t) => {
  const { db, provider } = createAiStack(t);
  await saveKey(PERSONAL_KEY_A);
  provider.enqueue({ type: 'reply' }, { type: 'reply' });
  const validation = await validateKey();
  assert.equal(validation.status, 503);
  assert.equal(validation.body.error.code, 'AI_CONFIGURATION_ERROR');
  assert.equal(validation.body.error.details.reason, 'MODELS_ENDPOINT_UNAUTHENTICATED');
  assert.equal(db.aiUserCredentials[0].LastValidationStatus, null);
  assert.deepEqual(provider.calls.map((call) => call.apiKey), [PERSONAL_KEY_A, null]);
});

test('doğrulamada oran sınırının Retry-After değeri korunur; bağlantı kurulamazsa bir kez yeniden denenir', async (t) => {
  const { provider } = createAiStack(t);
  await saveKey(PERSONAL_KEY_A);
  provider.enqueue({ type: 'status', status: 429, retryAfter: '30' });
  const limited = await validateKey();
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'AI_RATE_LIMITED');
  assert.equal(limited.body.error.details.retryAfterMs, 30000);
  assert.equal(limited.headers.get('retry-after'), '30');

  provider.enqueue({ type: 'network', code: 'ECONNREFUSED' }, { type: 'reply' });
  const recovered = await validateKey();
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.validation.status, 'VALID');
  assert.deepEqual(provider.calls.slice(1).map((call) => call.apiKey), [PERSONAL_KEY_A, PERSONAL_KEY_A, null]);
});

/* ── İstek güvenliği ──────────────────────────────────────── */

test('durum değiştiren yapay zekâ istekleri yalnızca aynı kaynaktan kabul edilir', async (t) => {
  const { db, provider } = createAiStack(t);
  const crossSite = [
    { origin: 'https://kardes.example.internal' },
    { 'sec-fetch-site': 'same-site' },
    { 'sec-fetch-site': 'cross-site', origin: 'https://baska.example' }
  ];
  for (const headers of crossSite) {
    for (const response of [
      await runProbe({ headers }),
      await validateKey({ headers }),
      await saveKey(PERSONAL_KEY_A, { headers }),
      await readJson(await credentialRoute.DELETE(aiRequest('/credential', { method: 'DELETE', headers })))
    ]) {
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.equal(response.body.error.code, 'FORBIDDEN');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal(provider.calls.length, 0);
  assert.equal((db.aiUserCredentials || []).length, 0);

  const sameOrigin = { origin: 'http://localhost', 'sec-fetch-site': 'same-origin' };
  assert.equal((await saveKey(PERSONAL_KEY_A, { headers: sameOrigin })).status, 200);
  assert.equal((await runProbe({ headers: sameOrigin })).status, 200);
});

test('gövde gönderilirken kesilen bağlantı kararlı istek hatasıdır, iç hata olarak kaydedilmez', async (t) => {
  createAiStack(t);
  const logs = captureConsole(t);
  const body = new ReadableStream({
    pull(controller) {
      controller.error(new Error('istemci bağlantıyı kesti'));
    }
  });
  const request = new Request('http://localhost/api/mergen-rota/ai/credential', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body, duplex: 'half'
  });
  const response = await readJson(await credentialRoute.PUT(request));
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'AI_REQUEST_INVALID');
  assert.equal(response.body.error.details.reason, 'BODY_INTERRUPTED');
  assert.equal(logs.some((line) => line.includes('AI_INTERNAL_ERROR')), false);
});

/* ── Gizlilik ─────────────────────────────────────────────── */

test('anahtarlar günlüğe, telemetriye, işletim akışına ve yanıtlara hiçbir akışta girmez', async (t) => {
  const { provider } = createAiStack(t);
  const logs = captureConsole(t);
  const texts = [];
  texts.push((await saveKey(PERSONAL_KEY_A)).text);
  texts.push((await runProbe()).text);
  provider.enqueue({ type: 'status', status: 401 });
  texts.push((await runProbe()).text);
  provider.enqueue({ type: 'network', code: 'ECONNREFUSED' }, { type: 'network', code: 'ECONNREFUSED' });
  texts.push((await runProbe()).text);
  provider.enqueue({ type: 'status', status: 500 });
  texts.push((await validateKey()).text);
  texts.push((await credentialStatus()).text);
  await removeKey();
  provider.enqueue({ type: 'status', status: 401 });
  texts.push((await runProbe()).text);

  const { snapshotOperations, recentFeed } = await import('../src/server/observability/telemetryRegistry.js');
  const { aiTelemetrySnapshot } = await import('../src/server/ai/aiTelemetry.js');
  const secrets = [PERSONAL_KEY_A, DEFAULT_KEY, MASTER_KEY];
  assertNoSecret(texts.join('\n'), secrets, 'yanıtlar');
  assertNoSecret(logs.join('\n'), secrets, 'günlük');
  assertNoSecret(snapshotOperations(), secrets, 'telemetri');
  assertNoSecret(recentFeed(60), secrets, 'işletim akışı');
  assertNoSecret(aiTelemetrySnapshot(), secrets, 'yapay zekâ özeti');
  // İstem ve yanıt metni de kayda girmez; Sicil hiçbir telemetri satırında yoktur.
  const telemetryText = JSON.stringify({ operations: snapshotOperations(), feed: recentFeed(60), ai: aiTelemetrySnapshot(), logs });
  assert.equal(telemetryText.includes('Bağlantı sınaması'), false);
  assert.equal(telemetryText.includes('bağlantı çalışıyor'), false);
  assert.doesNotMatch(telemetryText, new RegExp(`sicil\\W{1,6}${SICIL_A}`, 'i'));
});

test('şifreleme ana anahtarı yapılandırmadan başka yere taşınmaz', async (t) => {
  createAiStack(t);
  const status = await credentialStatus();
  assertNoSecret(status.text, [MASTER_KEY, masterBytes(MASTER_KEY).toString('hex')], 'durum');
  assert.equal(JSON.stringify(Object.keys(status.body.ai)).includes('master'), false);
});
