/**
 * Keycloak kimlik doğrulaması — UÇTAN UCA sözleşme testleri.
 *
 * Testler gerçek rota gövdelerini, gerçek imza doğrulamasını, gerçek JWKS
 * çekimini ve gerçek `KeycloakIdentityProvider` zincirini çalıştırır. Sahte
 * olan tek şey Keycloak'ın kendisidir (sentetik RSA anahtarı + JWKS ucu).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TEST_KEYCLOAK,
  TEST_SICIL,
  accessTokenClaims,
  applyKeycloakEnvironment,
  createSigningKey,
  installJwksEndpoint,
  loadAuthModules,
  readSetCookie,
  sessionExchangeRequest,
  signJwt
} from './helpers/keycloakStack.mjs';
import { SESSION_COOKIE_NAME } from '../src/server/identity/keycloakSessionCookie.js';

const signingKey = createSigningKey('test-key-1');

/** Ortak kurulum: temiz ortam + JWKS ucu + taze modül durumu. */
async function withKeycloak(run, { keys = [signingKey], env = {}, failWith = null } = {}) {
  applyKeycloakEnvironment(env);
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

/** Oturum çerezini okuyan gerçek sağlayıcıyı kurar. */
function installProviderWithCookie(modules, cookieValue) {
  const provider = new modules.provider.KeycloakIdentityProvider({
    readSessionCookie: async (name) => (name === SESSION_COOKIE_NAME ? cookieValue : null)
  });
  modules.currentUser.setCurrentUserProvider(provider);
  return provider;
}

async function exchange(modules, token, options) {
  return modules.sessionRoute.POST(sessionExchangeRequest(token, options));
}

/* ── Mutlu yol ──────────────────────────────────────────── */

test('geçerli imzalı jeton HttpOnly oturum çerezine dönüşür ve jeton tarayıcıya geri verilmez', async () => {
  await withKeycloak(async (modules) => {
    const token = signJwt(accessTokenClaims(), { key: signingKey });
    const response = await exchange(modules, token);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.currentUser.sicil, TEST_SICIL);
    assert.equal(body.currentUser.department, 'Test Departmanı');
    // Erişim jetonu hiçbir biçimde yanıta sızmamalıdır.
    assert.equal(JSON.stringify(body).includes(token), false);

    const cookie = readSetCookie(response, SESSION_COOKIE_NAME);
    assert.ok(cookie, 'oturum çerezi yazılmalıdır');
    assert.ok(cookie.attributes.includes('HttpOnly'));
    assert.ok(cookie.attributes.includes('Secure'));
    assert.ok(cookie.attributes.includes('SameSite=Lax'));
    assert.ok(cookie.attributes.includes('Path=/'));
    // Çerez ham jetonu taşımaz.
    assert.equal(cookie.value.includes(token), false);
  });
});

test('oturum çerezi getTrustedCurrentSicil() üzerinden doğrulanmış Sicil döndürür', async () => {
  await withKeycloak(async (modules) => {
    const response = await exchange(modules, signJwt(accessTokenClaims(), { key: signingKey }));
    const cookie = readSetCookie(response, SESSION_COOKIE_NAME);
    installProviderWithCookie(modules, cookie.value);

    assert.equal(await modules.currentUser.getTrustedCurrentSicil(), TEST_SICIL);
    const identity = await modules.currentUser.getTrustedSessionIdentity();
    assert.equal(identity.sicil, TEST_SICIL);
    assert.equal(identity.username, 'test.kullanici');
  });
});

test('JWKS bir kez çekilir ve sonraki doğrulamalarda önbellekten kullanılır', async () => {
  await withKeycloak(async (modules) => {
    await exchange(modules, signJwt(accessTokenClaims(), { key: signingKey }));
    await exchange(modules, signJwt(accessTokenClaims(), { key: signingKey }));
    assert.equal(modules.jwks.calls.length, 1);
  });
});

test('anahtar rotasyonunda bilinmeyen kid için JWKS yeniden çekilir', async () => {
  const rotated = createSigningKey('test-key-2');
  await withKeycloak(async (modules) => {
    // Önbellek eski anahtarla dolar.
    await exchange(modules, signJwt(accessTokenClaims(), { key: signingKey }));
    assert.equal(modules.jwks.calls.length, 1);

    // JWKS artık yeni anahtarı da sunuyor; bilinmeyen kid yenilemeyi tetikler.
    modules.jwks.restore();
    const refreshed = installJwksEndpoint([signingKey, rotated]);
    try {
      const response = await exchange(modules, signJwt(accessTokenClaims(), { key: rotated }));
      assert.equal(response.status, 200);
      assert.ok(refreshed.calls.length >= 1, 'yeni anahtar için JWKS yeniden çekilmelidir');
    } finally {
      refreshed.restore();
    }
  }, {
    keys: [signingKey],
    // Hız sınırı testte kapatılır; üretimde varsayılan 30 sn korunur.
    env: { MERGEN_ROTA_KEYCLOAK_JWKS_CACHE_TTL_MS: '600000', MERGEN_ROTA_KEYCLOAK_JWKS_MIN_REFRESH_MS: '0' }
  });
});

/* ── Reddedilen jetonlar ────────────────────────────────── */

const rejectionCases = [
  {
    name: 'süresi dolmuş jeton',
    token: () => signJwt(accessTokenClaims({ exp: Math.floor(Date.now() / 1000) - 600 }), { key: signingKey })
  },
  {
    name: 'yanlış issuer',
    token: () => signJwt(accessTokenClaims({ iss: 'https://baska-keycloak.test.internal/realms/diger' }), { key: signingKey })
  },
  {
    name: 'yanlış kitle (aud)',
    token: () => signJwt(accessTokenClaims({ aud: 'baska_istemci', azp: 'baska_istemci' }), { key: signingKey })
  },
  {
    name: 'yanlış yetkili istemci (azp)',
    token: () => signJwt(accessTokenClaims({ aud: [TEST_KEYCLOAK.clientId], azp: 'baska_istemci' }), { key: signingKey })
  },
  {
    name: 'eksik yetkili istemci (azp)',
    token: () => signJwt(accessTokenClaims({ aud: [TEST_KEYCLOAK.clientId], azp: undefined }), { key: signingKey })
  },
  {
    name: 'metin olmayan yetkili istemci (azp)',
    token: () => signJwt(accessTokenClaims({ aud: [TEST_KEYCLOAK.clientId], azp: { client: TEST_KEYCLOAK.clientId } }), { key: signingKey })
  },
  {
    name: 'geçersiz imza (başka anahtar)',
    token: () => signJwt(accessTokenClaims(), { key: createSigningKey('test-key-1') })
  },
  {
    name: 'bozulmuş imza',
    token: () => signJwt(accessTokenClaims(), { key: signingKey, signature: 'AAAA' })
  },
  {
    name: 'desteklenmeyen algoritma: none',
    token: () => signJwt(accessTokenClaims(), { key: signingKey, header: { alg: 'none' }, signature: '' })
  },
  {
    name: 'desteklenmeyen algoritma: HS256',
    token: () => signJwt(accessTokenClaims(), { key: signingKey, header: { alg: 'HS256' } })
  },
  {
    name: 'bozuk jeton biçimi',
    token: () => 'bu.bir.jeton.degil'
  },
  {
    name: 'boş jeton',
    token: () => ''
  },
  {
    name: 'Sicil claim eksik',
    token: () => {
      const claims = accessTokenClaims();
      delete claims.sicil;
      return signJwt(claims, { key: signingKey });
    }
  },
  {
    name: 'bozuk Sicil claim (harf içeriyor)',
    token: () => signJwt(accessTokenClaims({ sicil: '900001abc' }), { key: signingKey })
  },
  {
    name: 'bozuk Sicil claim (sıfır)',
    token: () => signJwt(accessTokenClaims({ sicil: '0' }), { key: signingKey })
  },
  {
    name: 'bozuk Sicil claim (ondalık)',
    token: () => signJwt(accessTokenClaims({ sicil: '900001.5' }), { key: signingKey })
  }
];

for (const scenario of rejectionCases) {
  test(`reddedilir: ${scenario.name}`, async () => {
    await withKeycloak(async (modules) => {
      const response = await exchange(modules, scenario.token());
      assert.equal(response.status, 401, scenario.name);
      const body = await response.json();
      assert.equal(body.error.code, 'UNAUTHORIZED');
      assert.equal(readSetCookie(response, SESSION_COOKIE_NAME), null, 'reddedilen jeton oturum açmamalıdır');
    });
  });
}

test('JWKS alınamadığında kapalı başarısızlık uygulanır', async () => {
  for (const failWith of ['network', 'status']) {
    await withKeycloak(async (modules) => {
      const response = await exchange(modules, signJwt(accessTokenClaims(), { key: signingKey }));
      assert.equal(response.status, 401, failWith);
      assert.equal(readSetCookie(response, SESSION_COOKIE_NAME), null);
    }, { failWith });
  }
});

test('bilinmeyen imza anahtarı (kid) kabul edilmez', async () => {
  const unknown = createSigningKey('bilinmeyen-anahtar');
  await withKeycloak(async (modules) => {
    const response = await exchange(modules, signJwt(accessTokenClaims(), { key: unknown }));
    assert.equal(response.status, 401);
  });
});

/* ── Kullanıcı adı → Sicil yedeği ───────────────────────── */

async function withUsernameFallback(run, resolver) {
  await withKeycloak(async (modules) => {
    const claims = accessTokenClaims();
    delete claims.sicil;
    const token = signJwt(claims, { key: signingKey });
    const identity = modules.authentication.authenticateAccessToken(token, { resolveSicil: resolver });
    await run(identity, modules);
  }, { env: { MERGEN_ROTA_KEYCLOAK_USERNAME_SICIL_FALLBACK: 'true' } });
}

test('Sicil claim yoksa kurumsal kullanıcı adı tekil eşleşmeyle çözülür', async () => {
  await withUsernameFallback(async (pending) => {
    const identity = await pending;
    assert.equal(identity.sicil, 900042);
    assert.equal(identity.sicilSource, 'directory-username');
  }, async (username) => {
    assert.equal(username, 'test.kullanici');
    return 900042;
  });
});

for (const malformedSicil of [0, '900001abc']) {
  test(`bozuk Sicil claim kullanıcı adı yedeğine düşmez: ${malformedSicil}`, async () => {
    await withKeycloak(async (modules) => {
      let lookupCalled = false;
      const token = signJwt(accessTokenClaims({ sicil: malformedSicil }), { key: signingKey });
      await assert.rejects(
        modules.authentication.authenticateAccessToken(token, {
          resolveSicil: async () => { lookupCalled = true; return 900042; }
        }),
        (error) => error.code === 'UNAUTHORIZED'
      );
      assert.equal(lookupCalled, false);
    }, { env: { MERGEN_ROTA_KEYCLOAK_USERNAME_SICIL_FALLBACK: 'true' } });
  });
}

test('kullanıcı adı kurumsal rehberde bulunamazsa UNAUTHORIZED döner', async () => {
  await withUsernameFallback(async (pending) => {
    await assert.rejects(pending, (error) => error.code === 'UNAUTHORIZED');
  }, async () => null);
});

test('kullanıcı adı birden çok Sicil ile eşleşirse (belirsiz) UNAUTHORIZED döner', async () => {
  // Çözümleyici belirsizlikte `null` döndürür; sözleşme budur.
  await withUsernameFallback(async (pending) => {
    await assert.rejects(pending, (error) => error.code === 'UNAUTHORIZED');
  }, async () => null);
});

test('kullanıcı adı yedeği kapalıyken Sicil claim yoksa oturum açılmaz', async () => {
  await withKeycloak(async (modules) => {
    const claims = accessTokenClaims();
    delete claims.sicil;
    const response = await exchange(modules, signJwt(claims, { key: signingKey }));
    assert.equal(response.status, 401);
  }, { env: { MERGEN_ROTA_KEYCLOAK_USERNAME_SICIL_FALLBACK: 'false' } });
});

test('kurumsal rehber sorgusu parametrelidir ve tekil olmayan sonucu reddeder', async () => {
  const { USERNAME_SICIL_QUERY, resolveSicilFromUsername } = await import('../src/server/identity/resolveSicilFromUsername.js');
  assert.match(USERNAME_SICIL_QUERY, /@username/);
  assert.doesNotMatch(USERNAME_SICIL_QUERY, /\+\s*username|\$\{/);

  const executorFor = (rows) => ({
    request() {
      const inputs = {};
      return {
        input(name, _type, value) { inputs[name] = value; return this; },
        async query() {
          assert.equal(inputs.username, 'test.kullanici');
          return { recordset: rows };
        }
      };
    }
  });

  assert.equal(await resolveSicilFromUsername('test.kullanici', executorFor([{ Sicil: 900042 }])), 900042);
  assert.equal(await resolveSicilFromUsername('test.kullanici', executorFor([])), null);
  // Belirsiz eşleşme kimlik üretmez.
  assert.equal(await resolveSicilFromUsername('test.kullanici', executorFor([{ Sicil: 900042 }, { Sicil: 900043 }])), null);
});

/* ── Kimliğin tarayıcıdan gelmesi engellenir ────────────── */

test('Sicil istek gövdesinden, sorgu dizesinden veya tarayıcı başlığından kabul edilmez', async () => {
  await withKeycloak(async (modules) => {
    const forged = new Request('https://rota.test.internal:8008/api/mergen-rota/auth/session?sicil=900999', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sicil': '900999', 'x-user-sicil': '900999' },
      body: JSON.stringify({ sicil: 900999, currentUser: { sicil: 900999 } })
    });
    const response = await modules.sessionRoute.POST(forged);
    assert.equal(response.status, 401);
    assert.equal(readSetCookie(response, SESSION_COOKIE_NAME), null);
  });
});

test('geçerli jetonun Sicil değeri, gövdedeki sahte Sicil tarafından ezilemez', async () => {
  await withKeycloak(async (modules) => {
    const token = signJwt(accessTokenClaims(), { key: signingKey });
    const response = await exchange(modules, token, {
      extra: { body: JSON.stringify({ sicil: 900999 }), headers: { 'x-sicil': '900999' } }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.currentUser.sicil, TEST_SICIL);
  });
});

test('imzası kurcalanmış oturum çerezi kimlik üretmez', async () => {
  await withKeycloak(async (modules) => {
    const response = await exchange(modules, signJwt(accessTokenClaims(), { key: signingKey }));
    const cookie = readSetCookie(response, SESSION_COOKIE_NAME);
    const [payload] = cookie.value.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({
      v: 1, sicil: 900999, exp: Math.floor(Date.now() / 1000) + 600
    }), 'utf8').toString('base64url');

    for (const tampered of [`${forgedPayload}.${cookie.value.split('.')[1]}`, `${payload}.AAAA`, 'bozuk']) {
      installProviderWithCookie(modules, tampered);
      await assert.rejects(modules.currentUser.getTrustedCurrentSicil(), (error) => error.code === 'SESSION_REQUIRED');
    }
  });
});

test('süresi dolmuş oturum çerezi reddedilir', async () => {
  await withKeycloak(async (modules) => {
    const { signSessionValue } = await import('../src/server/identity/keycloakSessionCookie.js');
    const expired = signSessionValue(
      { v: 1, sicil: TEST_SICIL, exp: Math.floor(Date.now() / 1000) - 5 },
      TEST_KEYCLOAK.sessionSecret
    );
    installProviderWithCookie(modules, expired);
    await assert.rejects(modules.currentUser.getTrustedCurrentSicil(), (error) => error.code === 'SESSION_REQUIRED');
  });
});

test('oturum çerezi yokken kimlik doğrulanmamıştır', async () => {
  await withKeycloak(async (modules) => {
    installProviderWithCookie(modules, null);
    await assert.rejects(modules.currentUser.getTrustedCurrentSicil(), (error) => error.code === 'SESSION_REQUIRED');
  });
});

test('kısa oturum sırrıyla imzalanan çerez kimlik üretmez', async () => {
  const weakSecret = 'kisa';
  await withKeycloak(async (modules) => {
    const { signSessionValue } = await import('../src/server/identity/keycloakSessionCookie.js');
    const forged = signSessionValue(
      { v: 1, sicil: TEST_SICIL, exp: Math.floor(Date.now() / 1000) + 600 },
      weakSecret
    );
    installProviderWithCookie(modules, forged);
    await assert.rejects(modules.currentUser.getTrustedCurrentSicil(), (error) => error.code === 'UNAUTHORIZED');
  }, { env: { MERGEN_ROTA_SESSION_SECRET: weakSecret } });
});

/* ── Geliştirme kimliğine sessiz düşüş yok ──────────────── */

test('Keycloak kipinde geçici geliştirme kimliğine sessizce düşülmez', async () => {
  await withKeycloak(async (modules) => {
    installProviderWithCookie(modules, null);
    await assert.rejects(modules.currentUser.getTrustedCurrentSicil(), (error) => error.code === 'SESSION_REQUIRED');

    // Geliştirme sağlayıcısı doğrudan çağrılsa bile Keycloak kipinde reddeder.
    const development = new modules.currentUser.DevelopmentIdentityProvider();
    await assert.rejects(development.getCurrentSicil(), (error) => error.code === 'UNAUTHORIZED');
  }, { env: { MERGEN_ROTA_DEV_IDENTITY_ENABLED: 'true', MERGEN_ROTA_DEV_SICIL: '900777' } });
});

test('geliştirme kimliği yalnızca kip development VE anahtar açıkken çalışır', async () => {
  await withKeycloak(async (modules) => {
    const development = new modules.currentUser.DevelopmentIdentityProvider();
    assert.equal(await development.getCurrentSicil(), 900777);
  }, { env: { MERGEN_ROTA_AUTH_MODE: 'development', MERGEN_ROTA_DEV_IDENTITY_ENABLED: 'true', MERGEN_ROTA_DEV_SICIL: '900777' } });

  await withKeycloak(async (modules) => {
    const development = new modules.currentUser.DevelopmentIdentityProvider();
    await assert.rejects(development.getCurrentSicil(), (error) => error.code === 'UNAUTHORIZED');
  }, { env: { MERGEN_ROTA_AUTH_MODE: 'development', MERGEN_ROTA_DEV_IDENTITY_ENABLED: 'false', MERGEN_ROTA_DEV_SICIL: '900777' } });
});

/* ── Oturum açma / kapatma akışı ────────────────────────── */

test('oturum açma ucu PKCE ile Keycloak yetkilendirme adresine yönlendirir', async () => {
  await withKeycloak(async (modules) => {
    const request = new Request('https://rota.test.internal:8008/api/mergen-rota/auth/login?returnTo=/kisi');
    const response = await modules.loginRoute.GET(request);
    assert.equal(response.status, 302);

    const location = new URL(response.headers.get('location'));
    assert.equal(location.origin + location.pathname, `${TEST_KEYCLOAK.issuer}/protocol/openid-connect/auth`);
    assert.equal(location.searchParams.get('response_type'), 'code');
    assert.equal(location.searchParams.get('client_id'), TEST_KEYCLOAK.clientId);
    assert.equal(location.searchParams.get('redirect_uri'), TEST_KEYCLOAK.redirectUri);
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(location.searchParams.get('code_challenge'));
    assert.ok(location.searchParams.get('state'));

    // `code_verifier` tarayıcıya AÇIK verilmez, imzalı HttpOnly çerezde taşınır.
    assert.equal(location.searchParams.get('code_verifier'), null);
    const transaction = readSetCookie(response, 'mergen_rota_auth_tx');
    assert.ok(transaction);
    assert.ok(transaction.attributes.includes('HttpOnly'));
  });
});

test('oturum açma yalnızca uygulama içi adrese döner (açık yönlendirme engeli)', async () => {
  await withKeycloak(async (modules) => {
    const { verifySignedValue } = await import('../src/server/identity/keycloakSessionCookie.js');
    const request = new Request('https://rota.test.internal:8008/api/mergen-rota/auth/login?returnTo=https://kotu.ornek');
    const response = await modules.loginRoute.GET(request);
    const transaction = readSetCookie(response, 'mergen_rota_auth_tx');
    const payload = verifySignedValue(transaction.value, TEST_KEYCLOAK.sessionSecret);
    assert.equal(payload.returnTo, '/');
  });
});

test('türetilen callback adresi işlem boyunca token takasına taşınır', async () => {
  await withKeycloak(async (modules) => {
    const { verifySignedValue } = await import('../src/server/identity/keycloakSessionCookie.js');
    const request = new Request('https://dinamik-rota.test.internal/api/mergen-rota/auth/login');
    const response = await modules.loginRoute.GET(request);
    const transaction = readSetCookie(response, 'mergen_rota_auth_tx');
    const payload = verifySignedValue(transaction.value, TEST_KEYCLOAK.sessionSecret);
    const expected = 'https://dinamik-rota.test.internal/api/mergen-rota/auth/callback';
    assert.equal(new URL(response.headers.get('location')).searchParams.get('redirect_uri'), expected);
    assert.equal(payload.redirectUri, expected);

    let submitted;
    await modules.authentication.exchangeAuthorizationCode({
      code: 'kod',
      codeVerifier: 'dogrulayici',
      redirectUri: payload.redirectUri,
      fetchImpl: async (_url, init) => {
        submitted = new URLSearchParams(init.body);
        return new Response(JSON.stringify({ access_token: 'jeton' }), { status: 200 });
      }
    });
    assert.equal(submitted.get('redirect_uri'), expected);
  }, { env: { MERGEN_ROTA_KEYCLOAK_REDIRECT_URI: null } });
});

test('yetkilendirme kodu takası zaman aşımı sinyaliyle sınırlandırılır', async () => {
  await withKeycloak(async (modules) => {
    let signal;
    await modules.authentication.exchangeAuthorizationCode({
      code: 'kod',
      codeVerifier: 'dogrulayici',
      timeoutMs: 25,
      fetchImpl: async (_url, init) => {
        signal = init.signal;
        return new Response(JSON.stringify({ access_token: 'jeton' }), { status: 200 });
      }
    });
    assert.ok(signal instanceof AbortSignal);
  });
});

test('geri dönüş ucu state doğrulanmadan oturum açmaz', async () => {
  await withKeycloak(async (modules) => {
    const request = new Request('https://rota.test.internal:8008/api/mergen-rota/auth/callback?code=abc&state=sahte');
    const response = await modules.callbackRoute.GET(request);
    assert.equal(response.status, 401);
    assert.equal(readSetCookie(response, SESSION_COOKIE_NAME), null);
  });
});

test('oturum kapatma çerezi temizler ve Keycloak end-session adresini verir', async () => {
  await withKeycloak(async (modules) => {
    const request = new Request('https://rota.test.internal:8008/api/mergen-rota/auth/logout', { method: 'POST' });
    const response = await modules.logoutRoute.POST(request);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.signedOut, true);
    const endSession = new URL(body.endSessionUrl);
    assert.equal(endSession.origin + endSession.pathname, `${TEST_KEYCLOAK.issuer}/protocol/openid-connect/logout`);
    assert.equal(endSession.searchParams.get('post_logout_redirect_uri'), TEST_KEYCLOAK.postLogoutRedirectUri);

    const cookie = readSetCookie(response, SESSION_COOKIE_NAME);
    assert.ok(cookie);
    assert.equal(cookie.value, '');
    assert.ok(cookie.attributes.includes('Max-Age=0'));

    // Temizlenen çerezle kimlik çözülemez.
    installProviderWithCookie(modules, cookie.value);
    await assert.rejects(modules.currentUser.getTrustedCurrentSicil(), (error) => error.code === 'SESSION_REQUIRED');
  });
});

/* ── Günlük ve gizlilik ─────────────────────────────────── */

test('reddedilen jeton günlüğe ham olarak yazılmaz', async () => {
  const originalWarn = console.warn;
  const originalError = console.error;
  const lines = [];
  console.warn = (...args) => lines.push(args.map((item) => JSON.stringify(item)).join(' '));
  console.error = (...args) => lines.push(args.map((item) => JSON.stringify(item)).join(' '));
  try {
    await withKeycloak(async (modules) => {
      const token = signJwt(accessTokenClaims({ exp: Math.floor(Date.now() / 1000) - 60 }), { key: signingKey });
      await exchange(modules, token);
      const combined = lines.join('\n');
      assert.equal(combined.includes(token), false, 'ham jeton günlüğe yazılmamalıdır');
      assert.equal(combined.includes('test.kullanici@ornek.internal'), false, 'tam e-posta günlüğe yazılmamalıdır');
    });
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
});

test('maskeleme yardımcıları tam kimlik bilgisi sızdırmaz', async () => {
  const { maskIdentityForLog } = await import('../src/server/identity/keycloakClaims.js');
  const masked = maskIdentityForLog({
    sicil: 900001,
    username: 'test.kullanici',
    email: 'test.kullanici@ornek.internal',
    name: 'Test Kullanıcı',
    subject: 'b0000000-0000-4000-8000-000000000002'
  });
  assert.equal(masked.sicil, '****01');
  assert.equal(masked.username.startsWith('t'), true);
  assert.equal(masked.username.includes('kullanici'), false);
  assert.equal(masked.email.endsWith('@ornek.internal'), true);
  assert.equal(masked.email.includes('test.kullanici'), false);
  assert.equal(masked.hasName, true);
  assert.equal(Object.values(masked).includes('Test Kullanıcı'), false);
});

/* ── Yetkilendirme sınırı korunur ───────────────────────── */

test('Keycloak rolleri MERGEN Rota SYSTEM_ADMIN yetkisi üretmez', async () => {
  await withKeycloak(async (modules) => {
    const token = signJwt(accessTokenClaims({
      resource_access: { [TEST_KEYCLOAK.clientId]: { roles: ['SYSTEM_ADMIN', 'admin', 'realm-admin'] } }
    }), { key: signingKey });

    const identity = await modules.authentication.authenticateAccessToken(token);
    assert.deepEqual(identity.resourceRoles, ['SYSTEM_ADMIN', 'admin', 'realm-admin'].sort());
    // Kimlik nesnesi hiçbir yetki bayrağı taşımaz.
    assert.equal('isSystemAdmin' in identity, false);
    assert.equal('canCreateProjects' in identity, false);

    const response = await exchange(modules, token);
    const body = await response.json();
    assert.equal('isSystemAdmin' in body.currentUser, false);
  });
});

test('kimlik sağlayıcısı yapılandırılmamışsa oturum açılmaz', async () => {
  await withKeycloak(async (modules) => {
    const response = await exchange(modules, signJwt(accessTokenClaims(), { key: signingKey }));
    assert.equal(response.status, 401);
  }, { env: { MERGEN_ROTA_SESSION_SECRET: 'kisa' } });

  await withKeycloak(async (modules) => {
    const response = await exchange(modules, signJwt(accessTokenClaims(), { key: signingKey }));
    assert.equal(response.status, 401);
  }, { env: { MERGEN_ROTA_KEYCLOAK_BASE_URL: null } });
});
