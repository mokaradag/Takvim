import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ACTUAL_AUTH_STATUS_ENDPOINT,
  corporateLoginHref,
  hasCorporateSession
} from '../src/components/shell/actualAuthBootstrap.js';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const { ServerPersistenceError, safeErrorResponse } = await import('../src/server/errors.js');
const currentUser = await import('../src/server/identity/currentUserProvider.js');
const authStatusRoute = await import('../src/app/api/mergen-rota/auth/status/route.js');

function captureConsoleError() {
  const entries = [];
  const original = console.error;
  console.error = (...args) => entries.push(args);
  return {
    entries,
    restore() { console.error = original; }
  };
}

test('oturum durum ucu kimlik yokluğunu normal durum olarak döndürür', async () => {
  currentUser.setCurrentUserProvider({
    async getSessionIdentity() {
      throw new ServerPersistenceError('SESSION_REQUIRED', 'Oturum bulunamadı.');
    }
  });

  const logs = captureConsoleError();
  try {
    const response = await authStatusRoute.GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    assert.deepEqual(await response.json(), { authenticated: false });
    assert.equal(logs.entries.length, 0, 'beklenen oturum yokluğu hata günlüğü üretmemelidir');
  } finally {
    logs.restore();
    currentUser.setCurrentUserProvider(null);
  }
});

test('oturum durum ucu doğrulanmış kimliği yanıta sızdırmaz', async () => {
  currentUser.setCurrentUserProvider({
    async getSessionIdentity() {
      return {
        sicil: 900001,
        username: 'test.kullanici',
        email: 'test.kullanici@ornek.internal',
        sid: 'sentetik-oturum'
      };
    }
  });

  try {
    const response = await authStatusRoute.GET();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { authenticated: true });
  } finally {
    currentUser.setCurrentUserProvider(null);
  }
});

test('istemci önyüklemesi durum ucunu kimlikli ve önbelleksiz çağırır', async () => {
  const calls = [];
  const authenticated = await hasCorporateSession({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ authenticated: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  assert.equal(authenticated, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ACTUAL_AUTH_STATUS_ENDPOINT);
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.cache, 'no-store');
});

test('istemci önyüklemesi eksik oturumu yönlendirme kararı için false döndürür', async () => {
  const authenticated = await hasCorporateSession({
    fetchImpl: async () => new Response(JSON.stringify({ authenticated: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  });

  assert.equal(authenticated, false);
  assert.equal(corporateLoginHref(), '/api/mergen-rota/auth/login?returnTo=%2F');
});

test('durum ucu hatası anlaşılır kod ve iletiyle yükseltilir', async () => {
  await assert.rejects(
    hasCorporateSession({
      fetchImpl: async () => new Response(JSON.stringify({
        error: { code: 'UNAUTHORIZED', message: 'Kimlik yapılandırması geçersiz.' }
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    }),
    (error) => error.code === 'UNAUTHORIZED' && error.message === 'Kimlik yapılandırması geçersiz.'
  );
});

test('SESSION_REQUIRED genel hata sınırında da yığın dökümü üretmez', async () => {
  const logs = captureConsoleError();
  try {
    const response = safeErrorResponse(new ServerPersistenceError('SESSION_REQUIRED', 'Oturum bulunamadı.'));
    assert.equal(response.status, 401);
    assert.equal(logs.entries.length, 0);
  } finally {
    logs.restore();
  }
});

test('Gerçek Sistem sağlayıcısı oturum denetlenmeden kurulmaz ve elle giriş kutusu gösterilmez', () => {
  const root = readFileSync(new URL('../src/components/shell/ApplicationRoot.jsx', import.meta.url), 'utf8');
  const boundary = readFileSync(new URL('../src/components/shell/AppDataBoundary.jsx', import.meta.url), 'utf8');

  assert.match(root, /dataMode === DATA_MODES\.ACTUAL[\s\S]*CorporateSessionGate/);
  assert.match(root, /window\.location\.replace\(corporateLoginHref\(\)\)/);
  assert.match(root, /<CorporateSessionGate[^>]*>\{application\}<\/CorporateSessionGate>/);
  assert.match(boundary, /if \(sessionRequired\) window\.location\.replace\(loginHref\)/);
  assert.doesNotMatch(boundary, /Kurumsal oturum aç/);
});
