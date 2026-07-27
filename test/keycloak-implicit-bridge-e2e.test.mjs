/**
 * Keycloak implicit köprüsü — UÇTAN UCA sözleşme testleri.
 *
 * Gerçek rota gövdeleri, gerçek imza doğrulaması, gerçek JWKS çekimi, gerçek
 * çerez imzalama ve gerçek geri dönüş sayfası betiği çalıştırılır. Sahte olan
 * yalnızca Keycloak (sentetik RSA anahtarı + JWKS ucu) ve tarayıcıdır (küçük bir
 * `vm` bağlamı).
 *
 * TÜM değerler sentetiktir: hiçbir gerçek adres, istemci kimliği, sicil veya
 * jeton kullanılmaz.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import {
  TEST_KEYCLOAK,
  TEST_SICIL,
  accessTokenClaims,
  applyKeycloakEnvironment,
  createSigningKey,
  implicitBridgeRequest,
  installJwksEndpoint,
  loadAuthModules,
  readSetCookie,
  signJwt
} from './helpers/keycloakStack.mjs';
import {
  AUTH_TRANSACTION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  signSessionValue,
  verifySignedValue
} from '../src/server/identity/keycloakSessionCookie.js';
import { KEYCLOAK_FLOWS } from '../src/server/identity/keycloakFlows.js';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

// Sunucu modülleri dinamik olarak da içe aktarılır; çözümleme kancası önce kurulur.
registerServerOnlyShim();

const signingKey = createSigningKey('test-key-1');

const IMPLICIT_ENV = { MERGEN_ROTA_KEYCLOAK_FLOW: 'implicit-bridge' };

/** Ortak kurulum: temiz ortam + JWKS ucu + taze modül durumu. */
async function withKeycloak(run, { keys = [signingKey], env = {}, failWith = null } = {}) {
  applyKeycloakEnvironment({ MERGEN_ROTA_KEYCLOAK_IMPLICIT_REDIRECT_URI: TEST_KEYCLOAK.implicitRedirectUri, ...env });
  const jwks = installJwksEndpoint(keys, { failWith });
  const modules = await loadAuthModules();
  try {
    return await run({ ...modules, jwks });
  } finally {
    jwks.restore();
    modules.currentUser.setCurrentUserProvider(null);
    modules.authentication.resetKeycloakJwksClients();
  }
}

/** Günlükleri hem susturur hem de içeriğini denetlenebilir kılar. */
function captureConsole() {
  const entries = [];
  const original = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    original[level] = console[level];
    console[level] = (...args) => entries.push({ level, args });
  }
  return {
    entries,
    text: () => entries.map((entry) => entry.args.map((value) => {
      try {
        return typeof value === 'string' ? value : JSON.stringify(value);
      } catch {
        return String(value);
      }
    }).join(' ')).join('\n'),
    restore() {
      for (const [level, fn] of Object.entries(original)) console[level] = fn;
    }
  };
}

function signedTransaction(payload) {
  return signSessionValue(payload, TEST_KEYCLOAK.sessionSecret);
}

function implicitTransaction(overrides = {}) {
  return {
    flow: KEYCLOAK_FLOWS.IMPLICIT_BRIDGE,
    state: 'durum-degeri-0001',
    returnTo: '/',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides
  };
}

function codeTransaction(overrides = {}) {
  return {
    flow: KEYCLOAK_FLOWS.AUTHORIZATION_CODE,
    state: 'durum-degeri-0001',
    codeVerifier: 'dogrulayici',
    redirectUri: TEST_KEYCLOAK.redirectUri,
    returnTo: '/',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides
  };
}

/** Köprü ucunu gerçek istekle çağırır ve günlükleri toplar. */
async function callBridge(modules, options) {
  const logs = captureConsole();
  try {
    const response = await modules.implicitSessionRoute.POST(implicitBridgeRequest(options));
    return { response, logs };
  } finally {
    logs.restore();
  }
}

async function expectBridgeRejection(modules, options) {
  const { response, logs } = await callBridge(modules, options);
  assert.equal(response.status, 401, 'köprü reddi 401 dönmelidir');
  assert.equal(readSetCookie(response, SESSION_COOKIE_NAME), null, 'reddedilen istek oturum çerezi yazmamalıdır');
  const cleared = readSetCookie(response, AUTH_TRANSACTION_COOKIE_NAME);
  assert.ok(cleared, 'kullanılamaz işlem çerezi temizlenmelidir');
  assert.equal(cleared.value, '');
  const body = await response.json();
  return { body, logs };
}

/* ── Yapılandırma ───────────────────────────────────────── */

test('akış varsayılanı authorization-code, açık değerler tanınır', async () => {
  const { readKeycloakConfig } = await import('../src/server/identity/keycloakConfig.js');
  assert.equal(readKeycloakConfig({}).flow, KEYCLOAK_FLOWS.AUTHORIZATION_CODE);
  assert.equal(readKeycloakConfig({ MERGEN_ROTA_KEYCLOAK_FLOW: '' }).flow, KEYCLOAK_FLOWS.AUTHORIZATION_CODE);
  assert.equal(
    readKeycloakConfig({ MERGEN_ROTA_KEYCLOAK_FLOW: 'authorization-code' }).flow,
    KEYCLOAK_FLOWS.AUTHORIZATION_CODE
  );
  assert.equal(
    readKeycloakConfig({ MERGEN_ROTA_KEYCLOAK_FLOW: 'implicit-bridge' }).flow,
    KEYCLOAK_FLOWS.IMPLICIT_BRIDGE
  );
  // Büyük/küçük harf ve boşluk toleransı, ama BAŞKA bir değere düşme yok.
  assert.equal(
    readKeycloakConfig({ MERGEN_ROTA_KEYCLOAK_FLOW: '  Implicit-Bridge ' }).flow,
    KEYCLOAK_FLOWS.IMPLICIT_BRIDGE
  );
});

test('tanınmayan akış değeri sessizce yedeklenmez, açık yapılandırma hatası olur', async () => {
  const { readKeycloakConfig, keycloakConfigurationIssues, assertKeycloakConfigured } =
    await import('../src/server/identity/keycloakConfig.js');

  for (const invalid of ['implicit', 'code', 'authorization_code', 'implicitbridge', 'hybrid']) {
    const config = readKeycloakConfig({
      MERGEN_ROTA_KEYCLOAK_BASE_URL: TEST_KEYCLOAK.baseUrl,
      MERGEN_ROTA_KEYCLOAK_REALM: TEST_KEYCLOAK.realm,
      MERGEN_ROTA_KEYCLOAK_CLIENT_ID: TEST_KEYCLOAK.clientId,
      MERGEN_ROTA_SESSION_SECRET: TEST_KEYCLOAK.sessionSecret,
      MERGEN_ROTA_KEYCLOAK_FLOW: invalid
    });
    assert.equal(config.flow, null, invalid);
    // Ham değer yalnızca teşhis içindir.
    assert.equal(config.flowRequested, invalid);
    assert.ok(keycloakConfigurationIssues(config).includes('MERGEN_ROTA_KEYCLOAK_FLOW'), invalid);
    assert.throws(() => assertKeycloakConfigured(config), (error) => error.code === 'UNAUTHORIZED', invalid);
  }
});

test('implicit köprü istemci secret istemez, kendi geri dönüş adresini ayrı okur', async () => {
  const { readKeycloakConfig, keycloakConfigurationIssues } = await import('../src/server/identity/keycloakConfig.js');
  const base = {
    MERGEN_ROTA_KEYCLOAK_BASE_URL: TEST_KEYCLOAK.baseUrl,
    MERGEN_ROTA_KEYCLOAK_REALM: TEST_KEYCLOAK.realm,
    MERGEN_ROTA_KEYCLOAK_CLIENT_ID: TEST_KEYCLOAK.clientId,
    MERGEN_ROTA_SESSION_SECRET: TEST_KEYCLOAK.sessionSecret,
    MERGEN_ROTA_KEYCLOAK_FLOW: 'implicit-bridge',
    MERGEN_ROTA_KEYCLOAK_REDIRECT_URI: TEST_KEYCLOAK.redirectUri,
    MERGEN_ROTA_KEYCLOAK_IMPLICIT_REDIRECT_URI: TEST_KEYCLOAK.implicitRedirectUri
  };

  const config = readKeycloakConfig(base);
  assert.equal(config.clientSecret, null);
  assert.deepEqual(keycloakConfigurationIssues(config), [], 'secret olmadan da yapılandırma geçerlidir');
  // İki adres BİRBİRİNE karışmaz.
  assert.equal(config.implicitRedirectUri, TEST_KEYCLOAK.implicitRedirectUri);
  assert.equal(config.redirectUri, TEST_KEYCLOAK.redirectUri);

  // Boş bırakılabilir: adres istek kökünden türetilir.
  const derived = readKeycloakConfig({ ...base, MERGEN_ROTA_KEYCLOAK_IMPLICIT_REDIRECT_URI: '' });
  assert.equal(derived.implicitRedirectUri, '');
  assert.deepEqual(keycloakConfigurationIssues(derived), []);
});

test('yapılandırma değerleri NEXT_PUBLIC_ ile açığa çıkarılmaz', async () => {
  const { readFileSync } = await import('node:fs');
  for (const file of [
    'src/server/identity/keycloakConfig.js',
    'src/server/identity/keycloakFlows.js',
    'src/app/api/mergen-rota/auth/login/route.js',
    'src/app/api/mergen-rota/auth/implicit-session/route.js'
  ]) {
    // Yorum metninde geçen `NEXT_PUBLIC_` sözcüğü değil, GERÇEK bir değişken adı aranır.
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /NEXT_PUBLIC_[A-Z0-9_]+/, file);
  }
});

/* ── Authorization Code gerilemesi ──────────────────────── */

test('varsayılan akış Authorization Code + PKCE davranışını aynen korur', async () => {
  await withKeycloak(async (modules) => {
    const request = new Request('https://rota.test.internal:8008/api/mergen-rota/auth/login?returnTo=/kisi');
    const response = await modules.loginRoute.GET(request);
    assert.equal(response.status, 302);

    const location = new URL(response.headers.get('location'));
    assert.equal(location.searchParams.get('response_type'), 'code');
    assert.equal(location.searchParams.get('client_id'), TEST_KEYCLOAK.clientId);
    assert.equal(location.searchParams.get('redirect_uri'), TEST_KEYCLOAK.redirectUri);
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(location.searchParams.get('code_challenge'));
    // Implicit'e ait parametreler kod akışına SIZMAZ.
    assert.equal(location.searchParams.get('response_mode'), null);

    const transaction = verifySignedValue(
      readSetCookie(response, AUTH_TRANSACTION_COOKIE_NAME).value,
      TEST_KEYCLOAK.sessionSecret
    );
    assert.equal(transaction.flow, KEYCLOAK_FLOWS.AUTHORIZATION_CODE);
    assert.ok(transaction.codeVerifier, 'doğrulayıcı işlemde saklanmaya devam eder');
    assert.equal(transaction.returnTo, '/kisi');
    assert.equal(transaction.redirectUri, TEST_KEYCLOAK.redirectUri);
  });

  // Akış açıkça yazıldığında da davranış aynıdır.
  await withKeycloak(async (modules) => {
    const response = await modules.loginRoute.GET(
      new Request('https://rota.test.internal:8008/api/mergen-rota/auth/login')
    );
    assert.equal(new URL(response.headers.get('location')).searchParams.get('response_type'), 'code');
  }, { env: { MERGEN_ROTA_KEYCLOAK_FLOW: 'authorization-code' } });
});

test('Authorization Code geri dönüşü taze bir işlemle uçtan uca çalışmayı sürdürür', async () => {
  applyKeycloakEnvironment();
  const modules = await loadAuthModules();
  const token = signJwt(accessTokenClaims(), { key: signingKey });
  const originalFetch = globalThis.fetch;

  // Jeton takası ve JWKS aynı sahte Keycloak tarafından karşılanır.
  globalThis.fetch = async (url, init) => {
    const address = String(url);
    if (address === TEST_KEYCLOAK.jwksUri) {
      return new Response(JSON.stringify({ keys: [signingKey.jwk] }), { status: 200 });
    }
    if (address === `${TEST_KEYCLOAK.issuer}/protocol/openid-connect/token`) {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.ok(body.get('code_verifier'), 'PKCE doğrulayıcısı takasa taşınmaya devam eder');
      return new Response(JSON.stringify({ access_token: token }), { status: 200 });
    }
    throw new Error(`Beklenmeyen ağ isteği: ${address}`);
  };

  try {
    const login = await modules.loginRoute.GET(
      new Request('https://rota.test.internal:8008/api/mergen-rota/auth/login?returnTo=/kisi')
    );
    const cookie = readSetCookie(login, AUTH_TRANSACTION_COOKIE_NAME);
    const state = new URL(login.headers.get('location')).searchParams.get('state');

    const callback = await modules.callbackRoute.GET(new Request(
      `https://rota.test.internal:8008/api/mergen-rota/auth/callback?code=kod&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=${cookie.value}` } }
    ));

    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/kisi');
    const session = readSetCookie(callback, SESSION_COOKIE_NAME);
    assert.ok(session && session.value, 'kod akışı oturum çerezini yazmaya devam eder');
    assert.ok(session.attributes.includes('HttpOnly'));
  } finally {
    globalThis.fetch = originalFetch;
    modules.authentication.resetKeycloakJwksClients();
  }
});

/* ── Implicit oturum açma isteği ────────────────────────── */

test('implicit köprüde oturum açma isteği token + fragment ister, PKCE göndermez', async () => {
  await withKeycloak(async (modules) => {
    const response = await modules.loginRoute.GET(
      new Request('https://rota.test.internal:8008/api/mergen-rota/auth/login?returnTo=/ekip')
    );
    assert.equal(response.status, 302);

    const location = new URL(response.headers.get('location'));
    assert.equal(location.origin + location.pathname, `${TEST_KEYCLOAK.issuer}/protocol/openid-connect/auth`);
    assert.equal(location.searchParams.get('response_type'), 'token');
    assert.equal(location.searchParams.get('response_mode'), 'fragment');
    assert.equal(location.searchParams.get('client_id'), TEST_KEYCLOAK.clientId);
    assert.equal(location.searchParams.get('redirect_uri'), TEST_KEYCLOAK.implicitRedirectUri);
    assert.equal(location.searchParams.get('scope'), 'openid profile email');
    assert.ok(location.searchParams.get('state'), 'state gönderilmelidir');

    // PKCE ve secret bu adreste ASLA bulunmaz.
    assert.equal(location.searchParams.get('code_challenge'), null);
    assert.equal(location.searchParams.get('code_challenge_method'), null);
    assert.equal(location.searchParams.get('client_secret'), null);
    assert.equal(location.searchParams.get('code_verifier'), null);
  }, { env: IMPLICIT_ENV });
});

test('implicit işlem çerezi imzalı, HttpOnly ve akış işaretlidir; doğrulayıcı taşımaz', async () => {
  await withKeycloak(async (modules) => {
    const response = await modules.loginRoute.GET(
      new Request('https://rota.test.internal:8008/api/mergen-rota/auth/login?returnTo=/ekip')
    );
    const cookie = readSetCookie(response, AUTH_TRANSACTION_COOKIE_NAME);
    assert.ok(cookie);
    assert.ok(cookie.attributes.includes('HttpOnly'));
    assert.ok(cookie.attributes.includes('Secure'));
    assert.ok(cookie.attributes.includes('SameSite=Lax'));

    const transaction = verifySignedValue(cookie.value, TEST_KEYCLOAK.sessionSecret);
    assert.equal(transaction.flow, KEYCLOAK_FLOWS.IMPLICIT_BRIDGE);
    assert.equal(transaction.returnTo, '/ekip');
    assert.equal(transaction.state, new URL(response.headers.get('location')).searchParams.get('state'));
    assert.equal(typeof transaction.exp, 'number');
    assert.equal(Object.hasOwn(transaction, 'codeVerifier'), false, 'implicit akışta doğrulayıcı üretilmez');
    assert.equal(Object.hasOwn(transaction, 'codeChallenge'), false);
  }, { env: IMPLICIT_ENV });
});

test('implicit oturum açma yalnızca uygulama içi returnTo saklar', async () => {
  await withKeycloak(async (modules) => {
    const response = await modules.loginRoute.GET(new Request(
      'https://rota.test.internal:8008/api/mergen-rota/auth/login?returnTo=https://kotu.ornek/kap'
    ));
    const transaction = verifySignedValue(
      readSetCookie(response, AUTH_TRANSACTION_COOKIE_NAME).value,
      TEST_KEYCLOAK.sessionSecret
    );
    assert.equal(transaction.returnTo, '/');
  }, { env: IMPLICIT_ENV });
});

test('implicit geri dönüş adresi boşsa istek kökünden türetilir', async () => {
  await withKeycloak(async (modules) => {
    const response = await modules.loginRoute.GET(
      new Request('https://dinamik-rota.test.internal/api/mergen-rota/auth/login')
    );
    assert.equal(
      new URL(response.headers.get('location')).searchParams.get('redirect_uri'),
      'https://dinamik-rota.test.internal/auth/implicit-callback'
    );
  }, { env: { ...IMPLICIT_ENV, MERGEN_ROTA_KEYCLOAK_IMPLICIT_REDIRECT_URI: null } });
});

/* ── Köprü ucu: ret yolları ─────────────────────────────── */

test('köprü ucu eksik ve bozuk Bearer başlığını ayrı iletilerle reddeder', async () => {
  await withKeycloak(async (modules) => {
    const transactionCookie = signedTransaction(implicitTransaction());

    const missing = await expectBridgeRejection(modules, { transactionCookie, state: 'durum-degeri-0001' });
    assert.match(missing.body.error.message, /jetonu gönderilmedi/i);

    // Bozuk şema: `Bearer` yok.
    const logs = captureConsole();
    let response;
    try {
      const request = new Request('https://rota.test.internal:8008/api/mergen-rota/auth/implicit-session', {
        method: 'POST',
        headers: {
          authorization: 'Token abc.def.ghi',
          cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=${transactionCookie}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ state: 'durum-degeri-0001' })
      });
      response = await modules.implicitSessionRoute.POST(request);
    } finally {
      logs.restore();
    }
    assert.equal(response.status, 401);
    assert.match((await response.json()).error.message, /biçimi geçersiz/i);
  }, { env: IMPLICIT_ENV });
});

test('köprü ucu bozuk JSON ve eksik state gövdesini reddeder', async () => {
  await withKeycloak(async (modules) => {
    const transactionCookie = signedTransaction(implicitTransaction());
    const token = signJwt(accessTokenClaims(), { key: signingKey });

    const malformed = await expectBridgeRejection(modules, { transactionCookie, token, body: '{bozuk' });
    assert.match(malformed.body.error.message, /gövdesi okunamadı/i);

    const missing = await expectBridgeRejection(modules, { transactionCookie, token, body: JSON.stringify({}) });
    assert.match(missing.body.error.message, /durumu gönderilmedi/i);

    const blank = await expectBridgeRejection(modules, { transactionCookie, token, body: JSON.stringify({ state: '   ' }) });
    assert.match(blank.body.error.message, /durumu gönderilmedi/i);
  }, { env: IMPLICIT_ENV });
});

test('köprü ucu eksik, kurcalanmış ve süresi dolmuş işlem çerezini ayrı ayrı reddeder', async () => {
  await withKeycloak(async (modules) => {
    const token = signJwt(accessTokenClaims(), { key: signingKey });

    const missing = await expectBridgeRejection(modules, { token, state: 'durum-degeri-0001' });
    assert.match(missing.body.error.message, /işlemi bulunamadı/i);

    // Yükü değişmiş çerez: imza artık tutmaz.
    const valid = signedTransaction(implicitTransaction());
    const tampered = `${Buffer.from(JSON.stringify(implicitTransaction({ returnTo: '/yonetim' })), 'utf8').toString('base64url')}.${valid.split('.')[1]}`;
    const tamperedResult = await expectBridgeRejection(modules, { token, state: 'durum-degeri-0001', transactionCookie: tampered });
    assert.match(tamperedResult.body.error.message, /doğrulanamadı/i);

    // Başka bir anahtarla imzalanmış çerez de kabul edilmez.
    const foreign = signSessionValue(implicitTransaction(), 'baska-bir-imza-anahtari-0123456789abcdef');
    const foreignResult = await expectBridgeRejection(modules, { token, state: 'durum-degeri-0001', transactionCookie: foreign });
    assert.match(foreignResult.body.error.message, /doğrulanamadı/i);

    const expired = signedTransaction(implicitTransaction({ exp: Math.floor(Date.now() / 1000) - 5 }));
    const expiredResult = await expectBridgeRejection(modules, { token, state: 'durum-degeri-0001', transactionCookie: expired });
    assert.match(expiredResult.body.error.message, /süresi doldu/i);
  }, { env: IMPLICIT_ENV });
});

test('köprü ucu state uyuşmazlığını reddeder', async () => {
  await withKeycloak(async (modules) => {
    const token = signJwt(accessTokenClaims(), { key: signingKey });
    const transactionCookie = signedTransaction(implicitTransaction());

    const mismatch = await expectBridgeRejection(modules, { token, transactionCookie, state: 'baska-durum-0002' });
    assert.match(mismatch.body.error.message, /durumu eşleşmedi/i);

    // Uzunluğu aynı ama içeriği farklı değer de reddedilir.
    const sameLength = await expectBridgeRejection(modules, { token, transactionCookie, state: 'durum-degeri-0002' });
    assert.match(sameLength.body.error.message, /durumu eşleşmedi/i);
  }, { env: IMPLICIT_ENV });
});

test('köprü ucu geçersiz jetonların tamamını mevcut kanonik doğrulayıcıyla reddeder', async () => {
  const otherKey = createSigningKey('sahte-anahtar');
  const cases = [
    ['imzası geçersiz', () => signJwt(accessTokenClaims(), { key: otherKey })],
    ['yanlış issuer', () => signJwt(accessTokenClaims({ iss: 'https://sahte.test.internal/realms/x' }), { key: signingKey })],
    ['yanlış kitle', () => signJwt(accessTokenClaims({ aud: 'baska-istemci', azp: 'baska-istemci' }), { key: signingKey })],
    ['yanlış yetkili taraf', () => signJwt(accessTokenClaims({ azp: 'baska-istemci' }), { key: signingKey })],
    ['kabul edilmeyen algoritma', () => signJwt(accessTokenClaims(), { key: signingKey, header: { alg: 'HS256' } })],
    ['süresi dolmuş', () => signJwt(accessTokenClaims({ exp: Math.floor(Date.now() / 1000) - 3600 }), { key: signingKey })],
    ['henüz geçerli değil', () => signJwt(accessTokenClaims({ nbf: Math.floor(Date.now() / 1000) + 3600 }), { key: signingKey })],
    ['biçimsiz jeton', () => 'abc.def.ghi']
  ];

  await withKeycloak(async (modules) => {
    for (const [name, makeToken] of cases) {
      const result = await expectBridgeRejection(modules, {
        token: makeToken(),
        transactionCookie: signedTransaction(implicitTransaction()),
        state: 'durum-degeri-0001'
      });
      assert.match(result.body.error.message, /kimlik doğrulanamadı/i, name);
    }
  }, { env: IMPLICIT_ENV });
});

test('köprü ucu geçersiz veya çözülemeyen Sicil değerlerini reddeder', async () => {
  await withKeycloak(async (modules) => {
    for (const sicil of ['0', '-1', '900001abc', '900001.5', '']) {
      const result = await expectBridgeRejection(modules, {
        token: signJwt(accessTokenClaims({ sicil }), { key: signingKey }),
        transactionCookie: signedTransaction(implicitTransaction()),
        state: 'durum-degeri-0001'
      });
      assert.match(result.body.error.message, /Sicil bilgisi geçersiz/i, `sicil=${sicil}`);
    }

    // Claim hiç yoksa ve kullanıcı adı yedeği kapalıysa oturum açılmaz.
    const claims = accessTokenClaims();
    delete claims.sicil;
    const unresolved = await expectBridgeRejection(modules, {
      token: signJwt(claims, { key: signingKey }),
      transactionCookie: signedTransaction(implicitTransaction()),
      state: 'durum-degeri-0001'
    });
    assert.match(unresolved.body.error.message, /Sicil bilgisi çözülemedi/i);
  }, { env: IMPLICIT_ENV });
});

test('kullanıcı adı yedeği tekil eşleşmiyorsa kanonik doğrulayıcı oturum üretmez', async () => {
  await withKeycloak(async (modules) => {
    const claims = accessTokenClaims();
    delete claims.sicil;
    const token = signJwt(claims, { key: signingKey });

    // Köprü ucunun çağırdığı kanonik sınırın kendisi: tekil olmayan eşleşme
    // `null` döner ve UNAUTHORIZED üretir.
    await assert.rejects(
      modules.authentication.authenticateAccessToken(token, { resolveSicil: async () => null }),
      (error) => error.code === 'UNAUTHORIZED' && /çözülemedi/i.test(error.message)
    );
  }, { env: { ...IMPLICIT_ENV, MERGEN_ROTA_KEYCLOAK_USERNAME_SICIL_FALLBACK: 'true' } });
});

test('köprü ucu yalnızca implicit-bridge kipinde çalışır', async () => {
  await withKeycloak(async (modules) => {
    const result = await expectBridgeRejection(modules, {
      token: signJwt(accessTokenClaims(), { key: signingKey }),
      transactionCookie: signedTransaction(implicitTransaction()),
      state: 'durum-degeri-0001'
    });
    assert.match(result.body.error.message, /köprü kipi etkin değil/i);
  }, { env: { MERGEN_ROTA_KEYCLOAK_FLOW: 'authorization-code' } });
});

/* ── Akış ayrımı ────────────────────────────────────────── */

test('bir akışın işlemi öteki akışın geri dönüşünde kabul edilmez', async () => {
  // Kod akışı işlemi implicit köprü ucunda reddedilir.
  await withKeycloak(async (modules) => {
    const result = await expectBridgeRejection(modules, {
      token: signJwt(accessTokenClaims(), { key: signingKey }),
      transactionCookie: signedTransaction(codeTransaction()),
      state: 'durum-degeri-0001'
    });
    assert.match(result.body.error.message, /bu akışa ait değil/i);
  }, { env: IMPLICIT_ENV });

  // Implicit işlem Authorization Code geri dönüşünde reddedilir.
  await withKeycloak(async (modules) => {
    const logs = captureConsole();
    let response;
    try {
      response = await modules.callbackRoute.GET(new Request(
        'https://rota.test.internal:8008/api/mergen-rota/auth/callback?code=kod&state=durum-degeri-0001',
        { headers: { cookie: `${AUTH_TRANSACTION_COOKIE_NAME}=${signedTransaction(implicitTransaction())}` } }
      ));
    } finally {
      logs.restore();
    }
    assert.equal(response.status, 401);
    assert.equal(readSetCookie(response, SESSION_COOKIE_NAME), null);
  });
});

/* ── Başarılı köprü ─────────────────────────────────────── */

test('doğrulanmış jeton HttpOnly Rota oturumuna çevrilir ve jeton geri verilmez', async () => {
  await withKeycloak(async (modules) => {
    const token = signJwt(accessTokenClaims(), { key: signingKey });
    const transactionCookie = signedTransaction(implicitTransaction({ returnTo: '/ekip' }));
    const { response, logs } = await callBridge(modules, { token, transactionCookie, state: 'durum-degeri-0001' });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { authenticated: true, returnTo: '/ekip' });

    // Yanıt jeton, claim veya işlem yükü SIZDIRMAZ.
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes('durum-degeri-0001'), false);
    assert.equal(serialized.includes(TEST_KEYCLOAK.sessionSecret), false);
    for (const forbidden of ['access_token', 'id_token', 'refresh_token', 'claims', 'state', 'sicil']) {
      assert.equal(Object.hasOwn(body, forbidden), false, forbidden);
    }

    const session = readSetCookie(response, SESSION_COOKIE_NAME);
    assert.ok(session, 'oturum çerezi yazılmalıdır');
    assert.ok(session.attributes.includes('HttpOnly'));
    assert.ok(session.attributes.includes('SameSite=Lax'));
    assert.ok(session.attributes.includes('Secure'));
    assert.ok(session.attributes.includes('Path=/'));
    assert.equal(session.value.includes(token), false, 'çerez ham jetonu taşımaz');

    // İşlem çerezi tek kullanımlıktır.
    const cleared = readSetCookie(response, AUTH_TRANSACTION_COOKIE_NAME);
    assert.ok(cleared);
    assert.equal(cleared.value, '');
    assert.ok(cleared.attributes.includes('Max-Age=0'));

    // Oturum gerçek sağlayıcı üzerinden doğrulanmış Sicil'i üretir.
    modules.currentUser.setCurrentUserProvider(new modules.provider.KeycloakIdentityProvider({
      readSessionCookie: async (name) => (name === SESSION_COOKIE_NAME ? session.value : null)
    }));
    assert.equal(await modules.currentUser.getTrustedCurrentSicil(), TEST_SICIL);

    // Başarılı akışta jeton/state/gizli anahtar günlüğe düşmez.
    const logged = logs.text();
    assert.equal(logged.includes(token), false);
    assert.equal(logged.includes('durum-degeri-0001'), false);
    assert.equal(logged.includes(TEST_KEYCLOAK.sessionSecret), false);
  }, { env: IMPLICIT_ENV });
});

test('köprü reddi güvenli teşhis yazar; jeton, state ve gizli anahtar günlüğe düşmez', async () => {
  await withKeycloak(async (modules) => {
    const token = signJwt(accessTokenClaims(), { key: signingKey });
    const { logs } = await expectBridgeRejection(modules, {
      token,
      transactionCookie: signedTransaction(implicitTransaction()),
      state: 'baska-durum-0002'
    });

    const logged = logs.text();
    assert.equal(logged.includes(token), false, 'Bearer jetonu günlüğe yazılmamalıdır');
    assert.equal(logged.includes('durum-degeri-0001'), false, 'işlem state değeri günlüğe yazılmamalıdır');
    assert.equal(logged.includes('baska-durum-0002'), false, 'gelen state değeri günlüğe yazılmamalıdır');
    assert.equal(logged.includes(TEST_KEYCLOAK.sessionSecret), false, 'oturum imza anahtarı günlüğe yazılmamalıdır');

    // Güvenli alanlar teşhis için bulunur.
    assert.match(logged, /implicit köprü reddi/);
    assert.match(logged, /"stage"/);
    assert.match(logged, /"bearerSupplied":true/);
    assert.match(logged, /"transactionSupplied":true/);
    assert.match(logged, /"flow":"implicit-bridge"/);
  }, { env: IMPLICIT_ENV });
});

test('genel oturum takas ucu zayıflatılmadan yerinde kalır', async () => {
  await withKeycloak(async (modules) => {
    const token = signJwt(accessTokenClaims(), { key: signingKey });
    const response = await modules.sessionRoute.POST(new Request(
      'https://rota.test.internal:8008/api/mergen-rota/auth/session',
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }
    ));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.currentUser.sicil, TEST_SICIL);
    assert.ok(readSetCookie(response, SESSION_COOKIE_NAME));
  }, { env: IMPLICIT_ENV });
});

/* ── Geri dönüş sayfası (HTML) ──────────────────────────── */

function callbackHtml(response) {
  return response.text();
}

function extractScript(html) {
  const match = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
  assert.ok(match, 'satır içi betik nonce ile bulunmalıdır');
  return { nonce: match[1], source: match[2] };
}

/**
 * Betiği küçük bir sahte tarayıcıda çalıştırır; DOM/ağ etkileri kaydedilir.
 *
 * `historyBroken` ve `hashSetterBroken` ile parçanın silinemediği durumlar
 * canlandırılır: betik bu durumda ağa çıkmadan durmalıdır.
 */
async function runCallbackScript(source, { hash, fetchImpl, historyBroken = false, hashSetterBroken = false }) {
  const events = { order: [], replaceStateUrls: [], replaced: [], requests: [], logs: [], messages: [] };
  const elements = {
    'rota-yukleniyor': { hidden: false, textContent: '' },
    'rota-hata': { hidden: true, textContent: '' },
    'rota-hata-metni': {
      hidden: false,
      _text: '',
      get textContent() { return this._text; },
      set textContent(value) { this._text = value; events.messages.push(value); }
    }
  };

  let currentHash = hash;
  const location = {
    pathname: '/auth/implicit-callback',
    search: '',
    // Gerçek tarayıcıda olduğu gibi adres çubuğunu temsil eden canlı değer.
    get hash() { return currentHash; },
    set hash(value) {
      // Bozuk kurulumda atama adres çubuğunu DEĞİŞTİRMEZ: jeton görünür kalır.
      if (!hashSetterBroken) currentHash = value;
    },
    replace(target) {
      events.order.push('replace');
      events.replaced.push(target);
    }
  };

  const logger = new Proxy({}, {
    get: () => (...args) => events.logs.push(args.join(' '))
  });

  const sandbox = {
    window: { location },
    document: { title: 'MERGEN Rota', getElementById: (id) => elements[id] || null },
    history: {
      replaceState(state, title, url) {
        events.order.push('replaceState');
        events.replaceStateUrls.push(url);
        if (historyBroken) throw new Error('History API kullanılamıyor');
        currentHash = '';
      }
    },
    URLSearchParams,
    JSON,
    String,
    console: logger,
    localStorage: new Proxy({}, { get: () => { throw new Error('localStorage kullanılmamalıdır'); } }),
    sessionStorage: new Proxy({}, { get: () => { throw new Error('sessionStorage kullanılmamalıdır'); } }),
    indexedDB: new Proxy({}, { get: () => { throw new Error('IndexedDB kullanılmamalıdır'); } }),
    fetch: (url, init) => {
      events.order.push('fetch');
      events.requests.push({ url, init });
      return fetchImpl(url, init);
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  // Betikteki promise zincirinin tamamlanmasını bekle.
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  return { events, elements };
}

test('implicit geri dönüş sayfası HTML, katı başlıklar ve nonce tabanlı CSP döner', async () => {
  await withKeycloak(async (modules) => {
    const response = await modules.implicitCallbackRoute.GET();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    assert.equal(response.headers.get('pragma'), 'no-cache');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');

    const html = await callbackHtml(response);
    const { nonce } = extractScript(html);
    const csp = response.headers.get('content-security-policy');
    for (const directive of [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'"
    ]) {
      assert.ok(csp.includes(directive), directive);
    }
    // Nonce kriptografik ve yanıta özeldir.
    assert.match(nonce, /^[A-Za-z0-9_-]{16,}$/);
    assert.ok(html.includes(`<style nonce="${nonce}">`), 'satır içi stil de nonce taşır');

    const second = await modules.implicitCallbackRoute.GET();
    assert.notEqual(extractScript(await callbackHtml(second)).nonce, nonce, 'her yanıt yeni nonce üretir');
  }, { env: IMPLICIT_ENV });
});

test('geri dönüş sayfası tarayıcı deposu, üçüncü taraf kaynak ve günlük kullanmaz', async () => {
  await withKeycloak(async (modules) => {
    const html = await callbackHtml(await modules.implicitCallbackRoute.GET());

    for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'IndexedDB', 'document.cookie']) {
      assert.equal(html.includes(forbidden), false, forbidden);
    }
    for (const forbidden of ['console.log', 'console.error', 'console.warn', 'console.info', 'console.']) {
      assert.equal(html.includes(forbidden), false, forbidden);
    }
    // Hiçbir dış kaynak yüklenmez.
    assert.doesNotMatch(html, /<script[^>]+src=/);
    assert.doesNotMatch(html, /<link[^>]+href=/);
    assert.doesNotMatch(html, /https?:\/\//);
    // Türkçe yükleniyor ve hata metinleri sayfada bulunur.
    assert.match(html, /doğrulanıyor/);
    assert.match(html, /Kurumsal oturum açılamadı/);
    assert.match(html, /Yeniden oturum aç/);
    // Yeniden deneme bağlantısı başarısız parçayı DEĞİL, oturum açma ucunu kullanır.
    assert.match(html, /href="\/api\/mergen-rota\/auth\/login"/);
  }, { env: IMPLICIT_ENV });
});

test('geri dönüş betiği parçayı ağ isteğinden ÖNCE siler ve jetonu yalnızca başlıkta gönderir', async () => {
  await withKeycloak(async (modules) => {
    const { source } = extractScript(await callbackHtml(await modules.implicitCallbackRoute.GET()));
    const { events } = await runCallbackScript(source, {
      hash: '#access_token=sentetik.jeton.degeri&state=durum-degeri-0001&token_type=bearer&expires_in=300',
      fetchImpl: async () => ({ ok: true, json: async () => ({ authenticated: true, returnTo: '/ekip' }) })
    });

    // Sıra: önce parça silinir, sonra ağ isteği yapılır, en sonda yönlendirme.
    assert.deepEqual(events.order, ['replaceState', 'fetch', 'replace']);
    assert.equal(events.replaceStateUrls[0], '/auth/implicit-callback');

    assert.equal(events.requests.length, 1, 'jeton yalnızca BİR kez gönderilir');
    const [{ url, init }] = events.requests;
    assert.equal(url, '/api/mergen-rota/auth/implicit-session');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Authorization, 'Bearer sentetik.jeton.degeri');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { state: 'durum-degeri-0001' });
    // Jeton gövdeye veya adrese yazılmaz.
    assert.equal(init.body.includes('sentetik.jeton.degeri'), false);
    assert.equal(String(url).includes('sentetik.jeton.degeri'), false);

    // Uygulamaya dönüş sunucunun döndürdüğü güvenli yolla yapılır.
    assert.deepEqual(events.replaced, ['/ekip']);
    assert.deepEqual(events.logs, [], 'betik hiçbir şey günlüğe yazmaz');
  }, { env: IMPLICIT_ENV });
});

test('geri dönüş betiği sunucudan gelen returnTo değerini de açık yönlendirmeye karşı süzer', async () => {
  await withKeycloak(async (modules) => {
    const { source } = extractScript(await callbackHtml(await modules.implicitCallbackRoute.GET()));
    for (const [returnTo, expected] of [
      ['https://kotu.ornek/kap', '/'],
      ['//kotu.ornek', '/'],
      ['/yonetim', '/yonetim'],
      [null, '/']
    ]) {
      const { events } = await runCallbackScript(source, {
        hash: '#access_token=sentetik.jeton.degeri&state=durum-degeri-0001',
        fetchImpl: async () => ({ ok: true, json: async () => ({ authenticated: true, returnTo }) })
      });
      assert.deepEqual(events.replaced, [expected], String(returnTo));
    }
  }, { env: IMPLICIT_ENV });
});

test('geri dönüş betiği Keycloak hatasında, eksik jetonda ve eksik state değerinde ağa çıkmaz', async () => {
  await withKeycloak(async (modules) => {
    const { source } = extractScript(await callbackHtml(await modules.implicitCallbackRoute.GET()));
    const cases = [
      ['#error=login_required&error_description=Oturum%20gerekli&state=durum-degeri-0001', /reddetti/],
      ['#state=durum-degeri-0001', /erişim jetonu alınamadı/],
      ['#access_token=sentetik.jeton.degeri', /durum değeri alınamadı/],
      ['', /erişim jetonu alınamadı/]
    ];

    for (const [hash, expected] of cases) {
      const { events, elements } = await runCallbackScript(source, {
        hash,
        fetchImpl: async () => { throw new Error('bu durumda ağ isteği yapılmamalıdır'); }
      });
      assert.deepEqual(events.requests, [], hash);
      assert.deepEqual(events.replaced, [], hash);
      // Parça yine de silinir.
      assert.ok(events.order.includes('replaceState'), hash);
      assert.equal(elements['rota-yukleniyor'].hidden, true, hash);
      assert.equal(elements['rota-hata'].hidden, false, hash);
      assert.match(events.messages.join(' '), expected, hash);
    }
  }, { env: IMPLICIT_ENV });
});

test('History API çalışmazsa parça yedek yolla silinir ve akış sürer', async () => {
  await withKeycloak(async (modules) => {
    const { source } = extractScript(await callbackHtml(await modules.implicitCallbackRoute.GET()));
    const { events } = await runCallbackScript(source, {
      hash: '#access_token=sentetik.jeton.degeri&state=durum-degeri-0001',
      historyBroken: true,
      fetchImpl: async () => ({ ok: true, json: async () => ({ authenticated: true, returnTo: '/ekip' }) })
    });

    // replaceState hata verse de parça adres çubuğundan düşer; ancak ondan
    // SONRA ağ isteği yapılır.
    assert.deepEqual(events.order, ['replaceState', 'fetch', 'replace']);
    assert.deepEqual(events.replaced, ['/ekip']);
  }, { env: IMPLICIT_ENV });
});

test('parça hiçbir yolla silinemiyorsa jeton ağa VERİLMEZ (kapalı başarısızlık)', async () => {
  await withKeycloak(async (modules) => {
    const { source } = extractScript(await callbackHtml(await modules.implicitCallbackRoute.GET()));
    const { events, elements } = await runCallbackScript(source, {
      hash: '#access_token=sentetik.jeton.degeri&state=durum-degeri-0001',
      historyBroken: true,
      hashSetterBroken: true,
      fetchImpl: async () => { throw new Error('parça silinemedi, ağ isteği yapılmamalıdır'); }
    });

    assert.deepEqual(events.requests, [], 'jeton adres çubuğunda kalırken ağa gönderilmemelidir');
    assert.deepEqual(events.replaced, [], 'uygulamaya geçilmemelidir');
    assert.equal(elements['rota-hata'].hidden, false);
    assert.equal(elements['rota-yukleniyor'].hidden, true);
    assert.match(events.messages.join(' '), /adres çubuğundan temizlenemedi/);
    assert.deepEqual(events.logs, []);
  }, { env: IMPLICIT_ENV });
});

test('geri dönüş betiği sunucu reddini ve ağ hatasını Türkçe hata sayfasına çevirir', async () => {
  await withKeycloak(async (modules) => {
    const { source } = extractScript(await callbackHtml(await modules.implicitCallbackRoute.GET()));

    const rejected = await runCallbackScript(source, {
      hash: '#access_token=sentetik.jeton.degeri&state=durum-degeri-0001',
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: {} }) })
    });
    assert.deepEqual(rejected.events.replaced, []);
    assert.equal(rejected.elements['rota-hata'].hidden, false);
    assert.match(rejected.events.messages.join(' '), /doğrulanamadı/);

    const offline = await runCallbackScript(source, {
      hash: '#access_token=sentetik.jeton.degeri&state=durum-degeri-0001',
      fetchImpl: async () => { throw new Error('ağ yok'); }
    });
    assert.deepEqual(offline.events.replaced, []);
    assert.match(offline.events.messages.join(' '), /ulaşılamadı/);

    // `authenticated` gelmezse de uygulamaya geçilmez.
    const unauthenticated = await runCallbackScript(source, {
      hash: '#access_token=sentetik.jeton.degeri&state=durum-degeri-0001',
      fetchImpl: async () => ({ ok: true, json: async () => ({ authenticated: false, returnTo: '/' }) })
    });
    assert.deepEqual(unauthenticated.events.replaced, []);
    assert.match(unauthenticated.events.messages.join(' '), /doğrulanamadı/);
  }, { env: IMPLICIT_ENV });
});

/* ── Oturum kapatma korunur ─────────────────────────────── */

test('implicit köprü kipinde oturum kapatma davranışı değişmez', async () => {
  await withKeycloak(async (modules) => {
    const response = await modules.logoutRoute.POST(new Request(
      'https://rota.test.internal:8008/api/mergen-rota/auth/logout',
      { method: 'POST' }
    ));
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.signedOut, true);
    const endSession = new URL(body.endSessionUrl);
    assert.equal(endSession.origin + endSession.pathname, `${TEST_KEYCLOAK.issuer}/protocol/openid-connect/logout`);
    assert.equal(endSession.searchParams.get('post_logout_redirect_uri'), TEST_KEYCLOAK.postLogoutRedirectUri);

    // Rota oturum çerezi her hâlükârda temizlenir; jeton gerekmez.
    const cleared = readSetCookie(response, SESSION_COOKIE_NAME);
    assert.ok(cleared);
    assert.equal(cleared.value, '');
    assert.ok(cleared.attributes.includes('Max-Age=0'));
  }, { env: IMPLICIT_ENV });
});
