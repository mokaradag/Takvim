import assert from 'node:assert/strict';
import test from 'node:test';

import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

/**
 * Kullanıcı varlığı (presence) ve Sistem Yönetimi · Aktif Kullanıcılar.
 *
 * "Aktif" AÇIK bir tanımdır: son üç dakika içinde kimliği doğrulanmış bir nabız
 * görülen kullanıcı. Nabız olağan isteklerden bağımsızdır ve Sicil başına TEK
 * satır tutar.
 */

const PROJECT_ID = '66666666-6666-4666-8666-000000000001';
const ROOT_WBS_ID = '66666666-6666-4666-8666-000000000002';

const ADMIN = 970001;
const USER = 970002;

const store = await import('../src/server/presence/presenceStore.js');
const presenceRoute = await import('../src/app/api/mergen-rota/admin/system/presence/route.js');
const heartbeatRoute = await import('../src/app/api/mergen-rota/presence/heartbeat/route.js');
const {
  PRESENCE_ACTIVE_WINDOW_MS,
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  PRESENCE_RECENT_WINDOW_MS,
  isPresenceActive
} = await import('../src/domain/presence/presenceModel.js');
const {
  PRESENCE_FOLLOWER_POLL_MS,
  PRESENCE_LEADER_STORAGE_KEY,
  PRESENCE_LEADER_TTL_MS,
  PRESENCE_WORST_CASE_GAP_MS,
  nextPresenceTickDelay,
  parsePresenceLock,
  serializePresenceLock,
  shouldClaimPresenceLeadership,
  shouldReleasePresenceLock
} = await import('../src/domain/presence/presenceLeader.js');

function seed(overrides = {}) {
  return {
    calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Kurumsal Takvim', IsDefault: 1, IsActive: 1 }],
    people: [
      { Sicil: ADMIN, DisplayName: 'Sistem Yöneticisi', Username: 'u970001', Directorate: 'Bilgi Teknolojileri', Department: 'Altyapı', Unit: 'İşletim' },
      { Sicil: USER, DisplayName: 'Olağan Kullanıcı', Username: 'u970002', Directorate: 'Üretim', Department: 'Montaj', Unit: 'Hat 1' }
    ],
    systemAdminSicils: [ADMIN],
    projects: [{
      ProjectId: PROJECT_ID, SourceType: 'MANUAL', ProjectCode: 'VARLIK', ProjectName: 'Varlık Projesi',
      LeadSicil: ADMIN, CalendarId: DEFAULT_CALENDAR_ID, IsActive: 1
    }],
    wbs: [{ WbsId: ROOT_WBS_ID, ProjectId: PROJECT_ID, ParentWbsId: null, Code: '1', Name: 'Kök', SortOrder: 0 }],
    tasks: [],
    taskAssignees: [],
    ...overrides
  };
}

async function asUser(sicil, run) {
  const previous = process.env.MERGEN_ROTA_DEV_SICIL;
  process.env.MERGEN_ROTA_DEV_SICIL = String(sicil);
  try { return await run(); }
  finally { process.env.MERGEN_ROTA_DEV_SICIL = previous; }
}

test('varlık tanımı ve nabız aralığı açıkça belirlidir', () => {
  assert.equal(PRESENCE_ACTIVE_WINDOW_MS, 180000);
  assert.equal(PRESENCE_RECENT_WINDOW_MS, 900000);
  // Nabız aralığı pencerenin YARISINDAN kısadır: tek kayıp nabız kişiyi düşürmez.
  assert.ok(PRESENCE_HEARTBEAT_INTERVAL_MS <= PRESENCE_ACTIVE_WINDOW_MS / 2);
  assert.ok(PRESENCE_HEARTBEAT_INTERVAL_MS >= 90000 && PRESENCE_HEARTBEAT_INTERVAL_MS <= 120000);

  const now = Date.parse('2026-09-22T10:00:00.000Z');
  assert.equal(isPresenceActive(new Date(now - 60000).toISOString(), now), true);
  assert.equal(isPresenceActive(new Date(now - 400000).toISOString(), now), false);
  assert.equal(isPresenceActive(null, now), false);
});

test('donan önderin devri aktiflik penceresinin içinde kalır', () => {
  // Önder kilidi her nabızda tazeler: süre bir aralıktan uzun olmalıdır.
  assert.ok(PRESENCE_LEADER_TTL_MS > PRESENCE_HEARTBEAT_INTERVAL_MS);
  assert.equal(PRESENCE_WORST_CASE_GAP_MS, PRESENCE_LEADER_TTL_MS + PRESENCE_FOLLOWER_POLL_MS);
  assert.ok(PRESENCE_WORST_CASE_GAP_MS < PRESENCE_ACTIVE_WINDOW_MS,
    'devralma gecikmesi etkin kullanıcıyı listeden düşürmemelidir');
  // Önder ve gizli sekme nabız aralığıyla, görünür izleyici daha sık yoklar.
  assert.equal(nextPresenceTickDelay({ leader: true, hidden: false }), PRESENCE_HEARTBEAT_INTERVAL_MS);
  assert.equal(nextPresenceTickDelay({ leader: false, hidden: true }), PRESENCE_HEARTBEAT_INTERVAL_MS);
  assert.equal(nextPresenceTickDelay({ leader: false, hidden: false }), PRESENCE_FOLLOWER_POLL_MS);
  // Kilit yalnızca SAHİBİ tarafından bırakılır.
  const lock = parsePresenceLock(serializePresenceLock('a', 1));
  assert.equal(shouldReleasePresenceLock(lock, 'a'), true);
  assert.equal(shouldReleasePresenceLock(lock, 'b'), false);
  assert.equal(shouldReleasePresenceLock(null, 'a'), false);
});

/**
 * Nabız kancasını tarayıcı olmadan çalıştırır: paylaşılan yerel depo,
 * görünürlük olayları ve sahte saat. Her `mountTab` ayrı bir sekmedir.
 */
async function presenceTabs(t) {
  const { mountComponent } = await import('./helpers/clientComponentHarness.mjs');
  const { usePresenceHeartbeat } = await import('../src/hooks/usePresenceHeartbeat.js');
  const values = new Map();
  const localStorage = {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); }
  };
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.window = Object.assign(new EventTarget(), { localStorage });
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const heartbeats = [];
  globalThis.fetch = async (url) => {
    heartbeats.push(String(url));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-22T10:00:00.000Z') });
  const mounted = [];
  t.after(() => {
    for (const view of mounted) view.unmount();
    t.mock.timers.reset();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  const flush = async () => { for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
  return {
    heartbeats,
    flush,
    lock: () => parsePresenceLock(localStorage.getItem(PRESENCE_LEADER_STORAGE_KEY)),
    setLock: (tabId) => localStorage.setItem(PRESENCE_LEADER_STORAGE_KEY, serializePresenceLock(tabId, Date.now())),
    async mountTab() {
      const view = mountComponent(function PresenceProbe() { usePresenceHeartbeat(true); return null; }, {});
      mounted.push(view);
      await flush();
      return { unmount() { mounted.splice(mounted.indexOf(view), 1); view.unmount(); } };
    },
    async setVisibility(state) {
      globalThis.document.visibilityState = state;
      globalThis.document.dispatchEvent(new Event('visibilitychange'));
      await flush();
    },
    async advance(ms) {
      t.mock.timers.tick(ms);
      await flush();
    }
  };
}

test('önder sekme gizlenince kilidi bırakır; görünür olan sekme beklemeden nabız gönderir', async (t) => {
  const tabs = await presenceTabs(t);
  const tab = await tabs.mountTab();
  assert.equal(tabs.heartbeats.length, 1);
  assert.ok(tabs.lock(), 'önder kilidi almalıdır');

  await tabs.setVisibility('hidden');
  assert.equal(tabs.lock(), null, 'gizlenen önder kilidi bırakmalıdır');

  // Zamanlayıcı beklenmez: görünür olan sekme hemen bir tur başlatır.
  await tabs.setVisibility('visible');
  assert.equal(tabs.heartbeats.length, 2);
  assert.ok(tabs.lock());

  // Sayfa kapanırken ve etki sökülürken de kilit bırakılır.
  globalThis.window.dispatchEvent(new Event('pagehide'));
  assert.equal(tabs.lock(), null);
  await tabs.setVisibility('visible');
  assert.ok(tabs.lock());
  tab.unmount();
  assert.equal(tabs.lock(), null);
});

test('kapanan önderin yerine görünür sekme bir yoklama aralığında geçer', async (t) => {
  const tabs = await presenceTabs(t);
  const leader = await tabs.mountTab();
  await tabs.mountTab();
  // Aynı tarayıcıda TEK nabız gider.
  assert.equal(tabs.heartbeats.length, 1);

  leader.unmount();
  await tabs.advance(PRESENCE_FOLLOWER_POLL_MS);
  assert.equal(tabs.heartbeats.length, 2, 'izleyici boşalan önderliği hemen devralmalıdır');
});

test('donan önderin yerine görünür sekme aktiflik penceresi dolmadan geçer', async (t) => {
  const tabs = await presenceTabs(t);
  // Kilidi bırakamadan donan bir sekme.
  tabs.setLock('donmus-sekme');
  await tabs.mountTab();
  assert.equal(tabs.heartbeats.length, 0);

  let elapsed = 0;
  while (tabs.heartbeats.length === 0 && elapsed < PRESENCE_ACTIVE_WINDOW_MS * 2) {
    await tabs.advance(PRESENCE_FOLLOWER_POLL_MS);
    elapsed += PRESENCE_FOLLOWER_POLL_MS;
  }
  assert.equal(tabs.heartbeats.length, 1);
  assert.ok(elapsed <= PRESENCE_WORST_CASE_GAP_MS, `devralma ${elapsed} ms sürdü`);
  assert.ok(elapsed < PRESENCE_ACTIVE_WINDOW_MS);
});

test('sekmeler arası önderlik kilidi tek nabız gönderir ve bayatlayınca devreder', () => {
  const now = Date.parse('2026-09-22T10:00:00.000Z');
  assert.equal(shouldClaimPresenceLeadership(null, 'a', now), true);
  const lock = parsePresenceLock(serializePresenceLock('a', now));
  assert.deepEqual(lock, { tabId: 'a', at: now });
  // Kilit sahibi kendi nabzını gönderir; öteki sekme göndermez.
  assert.equal(shouldClaimPresenceLeadership(lock, 'a', now + 1000), true);
  assert.equal(shouldClaimPresenceLeadership(lock, 'b', now + 1000), false);
  // Kapanan ya da donan önderin kilidi bayatlayınca devralınır.
  assert.equal(shouldClaimPresenceLeadership(lock, 'b', now + PRESENCE_LEADER_TTL_MS + 1), true);
  assert.equal(parsePresenceLock('bozuk-json'), null);
  assert.equal(parsePresenceLock(null), null);
});

test('nabız Sicil başına TEK satır yazar ve tekrarlayan nabız satır çoğaltmaz', async () => {
  const stack = await createActualStack(seed(), { sicil: USER, corporateWbsSource: false });
  try {
    for (let index = 0; index < 5; index += 1) await store.submitPresenceHeartbeat();
    assert.equal(stack.db.userPresence.length, 1);
    assert.equal(Number(stack.db.userPresence[0].Sicil), USER);

    await asUser(ADMIN, () => store.submitPresenceHeartbeat());
    assert.equal(stack.db.userPresence.length, 2);
    // İstek düzeyinde telemetri satırı yazılmaz.
    assert.equal(stack.db.statements.some((entry) => entry.sql.includes('MR_TelemetryOperationSamples')), false);
  } finally { await stack.dispose(); }
});

test('Aktif Kullanıcılar YALNIZCA sistem yöneticisine açıktır', async () => {
  const stack = await createActualStack(seed(), { sicil: USER, corporateWbsSource: false });
  try {
    await store.submitPresenceHeartbeat();
    const forbidden = await presenceRoute.GET(new Request('http://localhost/api/mergen-rota/admin/system/presence'));
    assert.equal(forbidden.status, 403);
    const body = await forbidden.json();
    assert.equal(body.error.code, 'FORBIDDEN');

    const allowed = await asUser(ADMIN, () =>
      presenceRoute.GET(new Request('http://localhost/api/mergen-rota/admin/system/presence')));
    assert.equal(allowed.status, 200);
    const payload = await allowed.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.metrics.activeCount, 1);
    assert.equal(payload.users.length, 1);
    assert.equal(payload.users[0].sicil, String(USER));
    assert.equal(payload.users[0].directorate, 'Üretim');
    // Yalnızca yöneticinin zaten görmeye yetkili olduğu künye taşınır.
    assert.deepEqual(Object.keys(payload.users[0]).sort(), [
      'department', 'directorate', 'firstSeenAt', 'lastSeenAt', 'name', 'sessionStartedAt', 'sicil', 'unit'
    ]);
  } finally { await stack.dispose(); }
});

test('bayat nabız aktif eşiğinden düşer ama son 15 dakika listesinde kalır', async () => {
  const now = Date.now();
  const stack = await createActualStack(seed({
    userPresence: [
      { Sicil: USER, FirstSeenAt: new Date(now - 3600000).toISOString(), SessionStartedAt: new Date(now - 600000).toISOString(), LastSeenAt: new Date(now - 300000).toISOString() },
      { Sicil: ADMIN, FirstSeenAt: new Date(now - 3600000).toISOString(), SessionStartedAt: new Date(now - 120000).toISOString(), LastSeenAt: new Date(now - 30000).toISOString() }
    ]
  }), { sicil: ADMIN, corporateWbsSource: false });
  try {
    const data = await store.loadActiveUsers();
    assert.equal(data.metrics.activeCount, 1, 'beş dakika önceki nabız aktif sayılmaz');
    assert.equal(data.metrics.recentCount, 2);
    assert.equal(data.users.length, 2);
    assert.equal(data.definition.activeWindowMs, PRESENCE_ACTIVE_WINDOW_MS);
    // Başvuru anı, `LastSeenAt` damgasını yazan saatten (SQL Server) okunur.
    const presenceSql = stack.db.statements.map((entry) => entry.sql)
      .find((sql) => sql.includes('AS ActiveCount'));
    assert.match(presenceSql, /SYSUTCDATETIME\(\) AS ServerNow/);
    assert.ok(Number.isFinite(Date.parse(data.generatedAt)));
  } finally { await stack.dispose(); }
});

test('çok eski nabız listeden tümüyle düşer ve sorgu sınırlıdır', async () => {
  const now = Date.now();
  const stack = await createActualStack(seed({
    userPresence: [
      { Sicil: USER, FirstSeenAt: new Date(now - 86400000).toISOString(), SessionStartedAt: new Date(now - 86400000).toISOString(), LastSeenAt: new Date(now - 86400000).toISOString() }
    ]
  }), { sicil: ADMIN, corporateWbsSource: false });
  try {
    const data = await store.loadActiveUsers();
    assert.equal(data.metrics.activeCount, 0);
    assert.equal(data.metrics.recentCount, 0);
    assert.deepEqual(data.users, []);
    assert.equal(data.definition.listLimit, 200);
  } finally { await stack.dispose(); }
});

test('kurumsal sayaçlar liste sınırının ÖTESİNDEKİ aktif kullanıcıyı da sayar', async () => {
  const now = Date.now();
  const recent = (offsetMs) => new Date(now - offsetMs).toISOString();
  // Liste sınırını aşacak kadar kullanıcı: sınırın ötesinde kalan direktörlük ve
  // müdürlük, sayaçlardan düşmemelidir.
  const extras = Array.from({ length: 220 }, (unused, index) => ({
    Sicil: 971000 + index,
    DisplayName: `Aktif ${index}`,
    Username: `u971${String(index).padStart(3, '0')}`,
    Directorate: `Direktörlük ${index % 7}`,
    Department: `Müdürlük ${index % 11}`,
    Unit: `Birim ${index % 3}`
  }));
  const stack = await createActualStack(seed({
    people: [
      { Sicil: ADMIN, DisplayName: 'Sistem Yöneticisi', Username: 'u970001', Directorate: 'Bilgi Teknolojileri', Department: 'Altyapı', Unit: 'İşletim' },
      ...extras
    ],
    // En eski nabızlar listenin sonunda kalır; sınır onları keser.
    userPresence: extras.map((entry, index) => ({
      Sicil: entry.Sicil,
      FirstSeenAt: recent(60000 + index),
      SessionStartedAt: recent(60000 + index),
      LastSeenAt: recent(1000 + index)
    }))
  }), { sicil: ADMIN, corporateWbsSource: false });
  try {
    const data = await store.loadActiveUsers();
    assert.equal(data.metrics.activeCount, extras.length);
    assert.equal(data.users.length, data.definition.listLimit);
    assert.ok(data.users.length < extras.length, 'tablo sınırlı kalmalıdır');
    // Sayaçlar gösterilen satırdan değil, aktif kümenin TAMAMINDAN gelir.
    assert.equal(data.metrics.directorateCount, 7);
    assert.equal(data.metrics.departmentCount, 11);
  } finally { await stack.dispose(); }
});

test('nabız yazması işlem içindedir', async () => {
  const stack = await createActualStack(seed(), { sicil: USER, corporateWbsSource: false });
  try {
    const before = stack.db.statements.length;
    const openedBefore = stack.db.transactions.length;
    await heartbeatRoute.POST(new Request('http://localhost/api/mergen-rota/presence/heartbeat', { method: 'POST' }));

    const upsert = stack.db.statements
      .findIndex((entry, index) => index >= before && entry.sql.includes('UPDATE dbo.MR_UserPresence'));
    assert.ok(upsert >= 0, 'nabız yazması çalışmalıdır');
    // Otomatik işlem kipinde `HOLDLOCK` aralık kilidi koşullu `INSERT`'ten önce
    // bırakılabiliyor, eşzamanlı ilk nabız birincil anahtar hatasına düşüyordu.
    assert.ok(
      stack.db.transactions.slice(openedBefore).some((entry) => {
        const completedAt = entry.commitStatementIndex ?? entry.rollbackStatementIndex;
        return entry.statementIndex <= upsert
          && Number.isSafeInteger(completedAt)
          && completedAt > upsert;
      }),
      'nabız yazması işlem kapanmadan önce çalışmalıdır'
    );
    assert.deepEqual(stack.db.userPresence.map((row) => Number(row.Sicil)), [USER]);
  } finally { await stack.dispose(); }
});

test('nabız ucu kimliği gövdeden almaz ve göç uygulanmamışken uygulamayı düşürmez', async () => {
  const stack = await createActualStack(seed({ assignmentCoordinationSchemaMissing: true }), { sicil: USER, corporateWbsSource: false });
  try {
    const response = await heartbeatRoute.POST(new Request('http://localhost/api/mergen-rota/presence/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Gövdeden gelen Sicil YOK SAYILIR: kimlik oturumdan türetilir.
      body: JSON.stringify({ sicil: ADMIN })
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.enabled, false);
    assert.equal(stack.db.userPresence.length, 0);
  } finally { await stack.dispose(); }
});

test('nabız gövdedeki Sicil yerine oturum kimliğini yazar', async () => {
  const stack = await createActualStack(seed(), { sicil: USER, corporateWbsSource: false });
  try {
    await heartbeatRoute.POST(new Request('http://localhost/api/mergen-rota/presence/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sicil: ADMIN })
    }));
    assert.deepEqual(stack.db.userPresence.map((row) => Number(row.Sicil)), [USER]);
  } finally { await stack.dispose(); }
});

test('Aktif Kullanıcılar sekmesi kalan yüksekliği doldurur ve başlığı sabitler', async () => {
  const fs = await import('node:fs');
  const pathModule = await import('node:path');
  const url = await import('node:url');
  const root = pathModule.resolve(pathModule.dirname(url.fileURLToPath(import.meta.url)), '..');
  const read = (relativePath) => fs.readFileSync(pathModule.join(root, relativePath), 'utf8');

  const view = read('src/features/system-admin/SystemAdministrationView.jsx');
  // Sekme etkin DEĞİLKEN bileşen hiç kurulmaz: yoklama da çalışmaz.
  assert.match(view, /active === ADMIN_TABS\.PRESENCE && <SystemPresenceTab enabled=\{actualMode\} \/>/);
  assert.match(view, /active === ADMIN_TABS\.PRESENCE \? ' is-filled' : ''/);

  const tab = read('src/features/system-admin/tabs/SystemPresenceTab.jsx');
  assert.match(tab, /useAdminResource\(load, \{ intervalMs: REFRESH_INTERVAL_MS, enabled \}\)/);
  assert.match(tab, /className="sysadmin-tile-grid sysadmin-presence-metrics"/);
  // Kaydırma kabı klavyeyle odaklanabilir olmalıdır: içinde etkileşimli öğe
  // yoktur, odaklanamazsa klavye kullanan biri kalan satırlara ulaşamaz.
  assert.match(tab, /className="sysadmin-presence-scroll" tabIndex=\{0\} role="region" aria-label="[^"]+"/);

  const css = read('src/app/styles/system-admin.css');
  // Sayfa gereksiz kaydırılmaz: panel taşmayı gizler, yalnızca tablo kaydırılır.
  assert.match(css, /\.sysadmin-panel\.is-filled \{ overflow: hidden; display: flex; flex-direction: column; \}/);
  assert.match(css, /\.sysadmin-presence-section \{ flex: 1 1 0; min-height: 0; overflow: hidden; \}/);
  const scroll = css.slice(css.indexOf('.sysadmin-presence-scroll'), css.indexOf('.sysadmin-presence-table'));
  assert.match(scroll, /overflow: auto/);
  assert.match(scroll, /flex: 1 1 0/);
  assert.match(scroll, /\.sysadmin-presence-scroll:focus-visible \{[^}]*outline:/);
  // Dilim KURAL GÖVDESİYLE sınırlıdır: dosyanın ilerisindeki başka bir kural
  // `position: sticky` bildirirse sav bu kural silinmiş olsa da geçerdi.
  const headerStart = css.indexOf('.sysadmin-presence-table thead th');
  const header = css.slice(headerStart, css.indexOf('}', headerStart));
  assert.match(header, /position: sticky/);
  assert.match(header, /top: 0/);
});

test('Aktif Kullanıcılar sekmesi Demo Kipinde sıfır aktif kullanıcı İDDİA ETMEZ', async () => {
  const { CLIENT_STATE, findElement, mountComponent } = await import('./helpers/clientComponentHarness.mjs');
  const { SystemPresenceTab } = await import('../src/features/system-admin/tabs/SystemPresenceTab.jsx');
  globalThis[CLIENT_STATE] = { actions: {} };
  const view = mountComponent(SystemPresenceTab, { enabled: false });
  try {
    // Demo Kipinde sorgu HİÇ çalışmaz; "etkin kullanıcı yok" bir saptama olurdu.
    const rendered = JSON.stringify(view.output);
    assert.equal(rendered.includes('Şu anda etkin kullanıcı görünmüyor.'), false);
    assert.equal(rendered.includes('Demo Kipinde varlık verisi okunmaz.'), true);
    // Ölçüm kutuları da çizilmez: tanımsız değerli kutu gösterilmez.
    assert.equal(findElement(view.output, (node) => node.props?.className === 'sysadmin-tile-grid sysadmin-presence-metrics'), null);
  } finally { view.unmount(); delete globalThis[CLIENT_STATE]; }
});

test('Aktif Kullanıcılar tablosu tarayıcı saatini değil SUNUCU başvuru anını kullanır', async (t) => {
  const { CLIENT_STATE, findElement, mountComponent } = await import('./helpers/clientComponentHarness.mjs');
  const { SystemPresenceTab } = await import('../src/features/system-admin/tabs/SystemPresenceTab.jsx');
  // Sunucu saati tarayıcıdan günler öncesini gösterir: tarayıcı saati ileride.
  const serverNow = Date.parse('2020-01-01T12:00:00.000Z');
  const payload = {
    ok: true,
    enabled: true,
    generatedAt: new Date(serverNow).toISOString(),
    definition: { activeWindowMs: PRESENCE_ACTIVE_WINDOW_MS, recentWindowMs: PRESENCE_RECENT_WINDOW_MS, listLimit: 200 },
    metrics: { activeCount: 1, recentCount: 1, directorateCount: 1, departmentCount: 1 },
    users: [{
      sicil: String(USER), name: 'Olağan Kullanıcı', directorate: 'Üretim', department: 'Montaj', unit: 'Hat 1',
      sessionStartedAt: new Date(serverNow - 15 * 60000).toISOString(),
      firstSeenAt: new Date(serverNow - 3600000).toISOString(),
      lastSeenAt: new Date(serverNow - 60000).toISOString()
    }]
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(payload), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
  globalThis[CLIENT_STATE] = { actions: {} };
  const view = mountComponent(SystemPresenceTab, { enabled: true });
  t.after(() => { view.unmount(); delete globalThis[CLIENT_STATE]; globalThis.fetch = previousFetch; });
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
  view.render({ enabled: true });

  const row = findElement(view.output, (node) => node.type === 'tr' && node.key === String(USER));
  assert.ok(row, 'kullanıcı satırı çizilmelidir');
  const rendered = JSON.stringify(row);
  // Sunucuya göre bir dakika önce görülen kullanıcı ETKİNDİR ve süresi 15 dk'dır.
  assert.equal(row.props.className, undefined, 'satır boşta gösterilmemelidir');
  assert.match(rendered, /sysadmin-dot-ok/);
  assert.match(rendered, /15 dk/);
});

test('varlık başvuru anı sunucu yanıtından gelir; yoksa tarayıcı saatine düşer', async () => {
  const { presenceReferenceMs } = await import('../src/features/system-admin/systemAdminPresentation.js');
  assert.equal(presenceReferenceMs('2026-09-22T12:00:00.000Z', 5), Date.parse('2026-09-22T12:00:00.000Z'));
  assert.equal(presenceReferenceMs(null, 5), 5);
  assert.equal(presenceReferenceMs('bozuk', 5), 5);
});

test('etkinlik süresi ve son görülme okunur biçimde yazılır', async () => {
  const { presenceDuration, presenceTimestamp } = await import('../src/features/system-admin/systemAdminPresentation.js');
  const now = Date.parse('2026-09-22T12:00:00.000Z');
  assert.equal(presenceDuration('2026-09-22T11:45:00.000Z', now), '15 dk');
  assert.equal(presenceDuration('2026-09-22T09:30:00.000Z', now), '2 sa 30 dk');
  assert.equal(presenceDuration('2026-09-22T10:00:00.000Z', now), '2 sa');
  assert.equal(presenceDuration(null, now), '—');
  assert.equal(presenceDuration('2026-09-22T13:00:00.000Z', now), '—');
  assert.equal(presenceTimestamp(null), '—');
  assert.equal(presenceTimestamp('bozuk'), '—');
  assert.equal(typeof presenceTimestamp('2026-09-22T12:00:00.000Z'), 'string');
});

test('varlık verisi ana anlık görüntüye girmez', async () => {
  const stack = await createActualStack(seed(), { sicil: ADMIN, corporateWbsSource: false });
  try {
    await store.submitPresenceHeartbeat();
    await stack.reload();
    assert.equal(Object.prototype.hasOwnProperty.call(stack.state, 'presence'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(stack.state, 'activeUsers'), false);
  } finally { await stack.dispose(); }
});
