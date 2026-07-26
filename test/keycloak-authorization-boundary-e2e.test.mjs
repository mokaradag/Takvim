/**
 * Keycloak kimliği + mevcut yetkilendirme sınırı — UÇTAN UCA.
 *
 * Zincir: gerçek imzalı jeton → gerçek `/auth/session` rotası → gerçek HttpOnly
 * çerez → gerçek `KeycloakIdentityProvider` → gerçek `/api/mergen-rota/session`
 * ve `/snapshot` rotaları → gerçek SQL deposu (bellek içi SQL Server ikizi).
 *
 * Amaç: kimlik doğrulaması DEĞİŞTİ, yetkilendirme DEĞİŞMEDİ.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CORPORATE_PROJECT_ID, corporateSeed, createActualStack } from './helpers/actualStack.mjs';
import {
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

const signingKey = createSigningKey('boundary-key-1');

/** Gerçek rota üzerinden oturum çerezi üretir. */
async function issueSessionCookie(claimOverrides = {}) {
  applyKeycloakEnvironment();
  const jwks = installJwksEndpoint([signingKey]);
  try {
    const modules = await loadAuthModules();
    const token = signJwt(accessTokenClaims(claimOverrides), { key: signingKey });
    const response = await modules.sessionRoute.POST(sessionExchangeRequest(token));
    assert.equal(response.status, 200, 'oturum takası başarılı olmalıdır');
    return readSetCookie(response, SESSION_COOKIE_NAME).value;
  } finally {
    jwks.restore();
  }
}

async function keycloakProviderFor(cookieValue) {
  const { KeycloakIdentityProvider } = await import('../src/server/identity/keycloakIdentityProvider.js');
  return new KeycloakIdentityProvider({
    readSessionCookie: async (name) => (name === SESSION_COOKIE_NAME ? cookieValue : null)
  });
}

/** Keycloak kimliğiyle tam Gerçek Sistem yığınını kurar. */
async function createKeycloakStack(seed, { claims = {}, cookie = undefined } = {}) {
  const sessionCookie = cookie === undefined ? await issueSessionCookie(claims) : cookie;
  applyKeycloakEnvironment();
  return createActualStack(seed, {
    authMode: 'keycloak',
    currentUserProvider: await keycloakProviderFor(sessionCookie)
  });
}

test('doğrulanmış Keycloak Sicil değeri oturum ve anlık görüntü yetkisini belirler', async () => {
  const stack = await createKeycloakStack(corporateSeed());
  try {
    const session = await stack.repository.loadSessionContext();

    assert.equal(session.dataMode, 'actual');
    assert.equal(session.authMode, 'keycloak');
    assert.equal(session.authenticated, true);
    // Kimlik kurumsal rehberden ve doğrulanmış Sicil'den kurulur.
    assert.equal(session.currentUser.employeeNo, String(TEST_SICIL));
    assert.equal(session.currentUser.sicil, TEST_SICIL);
    assert.equal(session.currentUser.name, 'Test Kullanıcı');
    // MR_UserRoles yetkiyi belirlemeye devam eder (tohumda SYSTEM_ADMIN).
    assert.equal(session.isSystemAdmin, true);
    assert.equal(session.canCreateProjects, true);

    // Anlık görüntü gerçek yetkiyle döner.
    const snapshot = await stack.repository.loadSnapshot();
    assert.ok(snapshot.projects.length >= 1);
  } finally {
    await stack.dispose();
  }
});

test('Keycloak görüntüleme claim\'leri oturumda taşınır ama yetki üretmez', async () => {
  const stack = await createKeycloakStack(corporateSeed());
  try {
    const session = await stack.repository.loadSessionContext();
    const user = session.currentUser;

    assert.equal(user.username, 'tkullanici', 'kurumsal rehber kullanıcı adı önceliklidir');
    assert.equal(user.email, 'test.kullanici@ornek.internal');
    assert.equal(user.department, 'Test Departmanı');
    assert.equal(user.sector, 'Test Sektörü');
    assert.equal(user.managementUnit, 'Test Müdürlüğü');
    assert.equal(user.subject, 'b0000000-0000-4000-8000-000000000002');

    // Ham jeton veya rol bilgisi oturum yanıtında bulunmaz.
    const serialized = JSON.stringify(session);
    assert.equal(serialized.includes('resource_access'), false);
    assert.equal(serialized.includes('access_token'), false);
  } finally {
    await stack.dispose();
  }
});

test('Keycloak rolleri SYSTEM_ADMIN üretmez; yetki MR_UserRoles ve HR09 kaynaklıdır', async () => {
  // Jetonda SYSTEM_ADMIN rolü var; ancak MR_UserRoles'ta yönetici değil.
  const seed = corporateSeed({ systemAdminSicils: [] });
  const stack = await createKeycloakStack(seed, {
    claims: { resource_access: { mergen_rota_test_client: { roles: ['SYSTEM_ADMIN'] } } }
  });
  try {
    const session = await stack.repository.loadSessionContext();
    assert.equal(session.isSystemAdmin, false, 'Keycloak rolü yönetici yapmamalıdır');
    assert.equal(session.canCreateProjects, false);
    // HR09 kurumsal rolü başka bir Sicil'e ait: bu kullanıcı FULL erişim almaz.
    assert.deepEqual(session.projectAccess, []);
  } finally {
    await stack.dispose();
  }
});

test('HR09 kurumsal proje sorumluluğu FULL erişimi vermeye devam eder', async () => {
  // Kimlik, HR09'da PROJECT_MANAGER olan Sicil ile doğrulanır.
  const stack = await createKeycloakStack(corporateSeed({ systemAdminSicils: [] }), {
    claims: { sicil: '900010', preferred_username: 'sproje', name: 'Sentetik Proje Yöneticisi' }
  });
  try {
    const session = await stack.repository.loadSessionContext();
    assert.equal(session.isSystemAdmin, false);
    const access = session.projectAccess.find((entry) => entry.projectId.toLowerCase() === CORPORATE_PROJECT_ID.toLowerCase());
    assert.ok(access, 'kurumsal proje erişimi görünmelidir');
    assert.equal(access.accessLevel, 'FULL');
    assert.deepEqual(access.reasons, ['CORPORATE_PROJECT_ROLE']);
  } finally {
    await stack.dispose();
  }
});

/** Yığın kurulduktan sonra kimliği düşürür (oturum süresi dolmuş senaryosu). */
async function dropIdentity() {
  const { setCurrentUserProvider } = await import('../src/server/identity/currentUserProvider.js');
  setCurrentUserProvider(await keycloakProviderFor(null));
}

test('kimliği doğrulanmamış istek korunan veriye erişemez (UNAUTHORIZED)', async () => {
  const stack = await createKeycloakStack(corporateSeed());
  try {
    assert.equal((await stack.repository.loadSessionContext()).currentUser.sicil, TEST_SICIL);

    await dropIdentity();
    await assert.rejects(stack.repository.loadSessionContext(), (error) => error.code === 'UNAUTHORIZED');
    // Yarım yüklenmiş veri değil, açık kimlik hatası dönmelidir.
    await assert.rejects(stack.repository.loadSnapshot(), (error) => error.code === 'UNAUTHORIZED');
  } finally {
    await stack.dispose();
  }
});

test('kimliği doğrulanmamış yazma isteği de reddedilir', async () => {
  const stack = await createKeycloakStack(corporateSeed());
  try {
    await dropIdentity();
    await assert.rejects(
      stack.repository.commitChanges({
        taskUpserts: [{
          id: '11111111-1111-4111-8111-111111111111',
          projectId: CORPORATE_PROJECT_ID,
          task: 'Deneme',
          status: 'todo',
          priority: 'medium'
        }]
      }),
      (error) => error.code === 'UNAUTHORIZED'
    );
  } finally {
    await stack.dispose();
  }
});

test('yetkisiz yazma UNAUTHORIZED değil FORBIDDEN döner (ayrım korunur)', async () => {
  // Kimlik geçerli, ancak kullanıcı bu proje üzerinde FULL yetkiye sahip değil.
  const stack = await createKeycloakStack(corporateSeed({ systemAdminSicils: [] }));
  try {
    const session = await stack.repository.loadSessionContext();
    assert.equal(session.isSystemAdmin, false);

    await assert.rejects(
      stack.repository.commitChanges({
        taskUpserts: [{
          id: '22222222-2222-4222-8222-222222222222',
          projectId: CORPORATE_PROJECT_ID,
          task: 'Yetkisiz görev',
          status: 'todo',
          priority: 'medium'
        }]
      }),
      (error) => {
        assert.equal(error.code, 'FORBIDDEN', 'kimlik doğrulanmışsa yetki hatası FORBIDDEN olmalıdır');
        return true;
      }
    );
  } finally {
    await stack.dispose();
  }
});

test('oturum kapatıldıktan sonra aynı yığın korunan veriyi döndürmez', async () => {
  const cookie = await issueSessionCookie();
  const stack = await createKeycloakStack(corporateSeed(), { cookie });
  try {
    assert.equal((await stack.repository.loadSessionContext()).currentUser.sicil, TEST_SICIL);

    // Gerçek çıkış ucu çerezi temizler; sağlayıcı artık boş çerez okur.
    applyKeycloakEnvironment();
    const modules = await loadAuthModules();
    const response = await modules.logoutRoute.POST(
      new Request('https://rota.test.internal:8008/api/mergen-rota/auth/logout', { method: 'POST' })
    );
    const cleared = readSetCookie(response, SESSION_COOKIE_NAME);
    assert.equal(cleared.value, '');

    modules.currentUser.setCurrentUserProvider(await keycloakProviderFor(cleared.value));
    await assert.rejects(stack.repository.loadSessionContext(), (error) => error.code === 'UNAUTHORIZED');
  } finally {
    await stack.dispose();
  }
});

test('istemci gövdesi/başlığı Sicil değiştiremez: commit isteği doğrulanmış kimliği kullanır', async () => {
  const stack = await createKeycloakStack(corporateSeed());
  try {
    // Sunucu rota gövdeleri istekten Sicil OKUMAZ; kimlik yalnızca çerezden gelir.
    const session = await stack.repository.loadSessionContext();
    assert.equal(session.currentUser.sicil, TEST_SICIL);

    const routeSources = await Promise.all([
      import('node:fs').then(({ readFileSync }) => readFileSync('src/app/api/mergen-rota/commit/route.js', 'utf8')),
      import('node:fs').then(({ readFileSync }) => readFileSync('src/app/api/mergen-rota/snapshot/route.js', 'utf8')),
      import('node:fs').then(({ readFileSync }) => readFileSync('src/app/api/mergen-rota/session/route.js', 'utf8'))
    ]);
    for (const source of routeSources) {
      assert.doesNotMatch(source, /sicil/i, 'veri rotaları Sicil okumamalıdır');
    }
  } finally {
    await stack.dispose();
  }
});
