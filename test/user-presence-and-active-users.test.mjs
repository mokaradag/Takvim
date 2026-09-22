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
  PRESENCE_LEADER_TTL_MS,
  parsePresenceLock,
  serializePresenceLock,
  shouldClaimPresenceLeadership
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
  assert.match(tab, /className="sysadmin-presence-scroll"/);

  const css = read('src/app/styles/system-admin.css');
  // Sayfa gereksiz kaydırılmaz: panel taşmayı gizler, yalnızca tablo kaydırılır.
  assert.match(css, /\.sysadmin-panel\.is-filled \{ overflow: hidden; display: flex; flex-direction: column; \}/);
  assert.match(css, /\.sysadmin-presence-section \{ flex: 1 1 0; min-height: 0; overflow: hidden; \}/);
  const scroll = css.slice(css.indexOf('.sysadmin-presence-scroll'), css.indexOf('.sysadmin-presence-table'));
  assert.match(scroll, /overflow: auto/);
  assert.match(scroll, /flex: 1 1 0/);
  const header = css.slice(css.indexOf('.sysadmin-presence-table thead th'));
  assert.match(header, /position: sticky/);
  assert.match(header, /top: 0/);
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
