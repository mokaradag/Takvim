/**
 * Sistem Yönetimi · gezinme ve arayüz sözleşmeleri.
 *
 * Gezinme öğesinin yönetici süzgeci, sekme erişilebilirliği, Demo Kipi
 * davranışı, bayat/bilinmeyen durumların dürüst gösterimi ve hatırlatma
 * yönetiminin ÇATALLANMADAN gömülmesi burada sınanır.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setImmediate as immediate } from 'node:timers/promises';
import { findElement, mountComponent } from './helpers/clientComponentHarness.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const {
  ADMIN_NAV_IDS,
  GLOBAL_NAV_IDS,
  NAV_ITEMS,
  PAGE_META,
  navigationItems
} = await import('../src/components/shell/navigation.js');
const { SYSTEM_ADMIN_TABS, systemAdminPanelId, systemAdminTabId } = await import('../src/features/system-admin/systemAdminTabs.js');
const { SystemAdministrationView } = await import('../src/features/system-admin/SystemAdministrationView.jsx');
const { SystemHealthStrip } = await import('../src/features/system-admin/SystemHealthStrip.jsx');
const { SystemOverviewTab } = await import('../src/features/system-admin/tabs/SystemOverviewTab.jsx');
const { SystemQueuesTab } = await import('../src/features/system-admin/tabs/SystemQueuesTab.jsx');
const { SystemIntegrationsTab } = await import('../src/features/system-admin/tabs/SystemIntegrationsTab.jsx');
const { SystemEventsTab } = await import('../src/features/system-admin/tabs/SystemEventsTab.jsx');
const { TrendChart } = await import('../src/features/system-admin/components/TrendChart.jsx');
const { DataModeContext } = await import('../src/components/shell/DataModeContext.jsx');
const { HEALTH_STATES } = await import('../src/domain/observability/healthModel.js');
const { COMPONENTS } = await import('../src/domain/observability/eventModel.js');

function withDataMode(t, dataMode) {
  const previous = DataModeContext._currentValue;
  DataModeContext._currentValue = { dataMode, async setDataMode() {} };
  t.after(() => { DataModeContext._currentValue = previous; });
}

function stubFetch(t, handler) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
  t.after(() => { globalThis.fetch = previous; });
  return calls;
}

function overviewFixture(overrides = {}) {
  return {
    ok: true,
    state: HEALTH_STATES.WARNING,
    counts: { total: 9, healthy: 6, warning: 1, critical: 0, unknown: 1, notConfigured: 1 },
    generatedAt: '2026-09-12T10:00:00.000Z',
    configuration: { refreshIntervalMs: 10000, retentionDays: 30, thresholds: {} },
    components: [
      { key: COMPONENTS.APPLICATION, label: 'MERGEN Rota uygulaması', state: HEALTH_STATES.HEALTHY, stateLabel: 'Sağlıklı', message: 'yanıt veriyor', detail: { uptimeSeconds: 7200 }, tab: 'genel', lastSuccessAt: '2026-09-12T10:00:00.000Z', lastCheckedAt: '2026-09-12T10:00:00.000Z', stale: false },
      { key: COMPONENTS.DATABASE, label: 'Ana SQL Server', state: HEALTH_STATES.HEALTHY, stateLabel: 'Sağlıklı', message: 'bağlantı sağlıklı', durationMs: 12, tab: 'entegrasyonlar', lastSuccessAt: '2026-09-12T10:00:00.000Z', lastCheckedAt: '2026-09-12T10:00:00.000Z', stale: false },
      { key: COMPONENTS.OUTLOOK, label: 'Outlook takvim teslimatı', state: HEALTH_STATES.WARNING, stateLabel: 'Dikkat', message: 'kuyruk yaşlanıyor', tab: 'kuyruklar', detail: { queue: { pending: 3, failed: 1 } }, lastSuccessAt: null, lastCheckedAt: '2026-09-12T10:00:00.000Z', stale: false },
      { key: COMPONENTS.CORPORATE_WBS, label: 'CN43N / kurumsal WBS', state: HEALTH_STATES.UNKNOWN, stateLabel: 'Bilinmiyor', message: 'okunamadı', tab: 'kuyruklar', lastSuccessAt: null, lastCheckedAt: '2026-09-12T10:00:00.000Z', stale: false }
    ],
    attention: [
      {
        id: 'alert-1', kind: 'ALERT', alertId: 1, severity: 'ERROR', component: COMPONENTS.OUTLOOK,
        code: 'OUTLOOK_QUEUE_AGING', summary: 'Outlook kuyruğu yaşlanıyor', detail: null, occurrenceCount: 4,
        firstSeenAt: '2026-09-12T09:00:00.000Z', lastSeenAt: '2026-09-12T09:58:00.000Z', active: true,
        state: 'OPEN', action: 'Kuyruklar sekmesinden turu çalıştırın.', tab: 'kuyruklar'
      }
    ],
    alertsSchemaReady: true,
    api: { count: 120, errorCount: 2, errorRate: 0.017, p95Ms: 420, windowMs: 900000 },
    trends: { latencyP95: [], errorRate: [], memory: [], queueDepth: [] },
    feed: [{ at: '2026-09-12T09:59:00.000Z', severity: 'INFO', component: 'APPLICATION', code: 'APP_STARTED', summary: 'Uygulama başlatıldı' }],
    outlook: { queue: { pending: 3, failed: 1 }, age: { oldestUnattemptedAt: null } },
    ...overrides
  };
}

/* ── Gezinme ──────────────────────────────────────────────── */

test('bağımsız Hatırlatma E-postaları gezinme öğesi kaldırıldı, Sistem Yönetimi eklendi', () => {
  const ids = NAV_ITEMS.map((item) => item.id);
  assert.equal(ids.includes('hatirlatma'), false);
  assert.ok(ids.includes('sistem'));
  assert.equal(NAV_ITEMS.find((item) => item.id === 'sistem').label, 'Sistem Yönetimi');
  assert.equal(PAGE_META.sistem.title, 'Sistem Yönetimi');
  assert.equal(Object.hasOwn(PAGE_META, 'hatirlatma'), false);
  assert.deepEqual([...ADMIN_NAV_IDS], ['sistem']);
});

test('yönetim sayfası yalnızca sistem yöneticisine gösterilir ve her iki kipte açılır', () => {
  assert.equal(navigationItems(false, false).some((item) => item.id === 'sistem'), false);
  assert.equal(navigationItems(true, false).some((item) => item.id === 'sistem'), false);
  assert.ok(navigationItems(false, true).some((item) => item.id === 'sistem'), 'Kapsamlı Kip');
  assert.ok(navigationItems(true, true).some((item) => item.id === 'sistem'), 'Temel Kip');
});

test('uygulama kabuğu yönetim sayfasını rol kapılı çizer ve rol kaybında çıkar', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  assert.match(shell, /case 'sistem': return isSystemAdmin \? <SystemAdministrationView \/> : null;/);
  assert.equal(shell.includes("case 'hatirlatma'"), false);
  // Rol kaybında güvenli yönlendirme korunur.
  assert.match(shell, /if \(ADMIN_NAV_IDS\.has\(view\) && !isSystemAdmin\) navigate\('ozet'\);/);
  // Temel Kip yönlendirmesi yönetici sayfasını dışarıda bırakır.
  assert.match(shell, /if \(!SIMPLE_NAV_IDS\.has\(view\) && !ADMIN_NAV_IDS\.has\(view\)\) navigate\('takvim'\);/);
});

test('genel sayfalarda proje künyesi ve dışa aktarma gösterilmez', () => {
  assert.ok(GLOBAL_NAV_IDS.has('sistem'));
  const shell = read('src/components/shell/AppShell.jsx');
  assert.match(shell, /const globalPage = GLOBAL_NAV_IDS\.has\(view\);/);
  assert.match(shell, /const projectContextVisible = !simpleMode && selectedProject && !globalPage;/);
  assert.match(shell, /const exportVisible = !simpleMode && !globalPage;/);
});

/* ── Sekme yapısı ve erişilebilirlik ──────────────────────── */

test('altı mantıksal sekme erişilebilir sekme anlamlarıyla çizilir', (t) => {
  withDataMode(t, 'demo');
  const view = mountComponent(SystemAdministrationView, {});
  t.after(() => view.unmount());

  const tablist = findElement(view.output, (node) => node.props?.role === 'tablist');
  assert.ok(tablist);
  assert.equal(tablist.props['aria-label'], 'Sistem Yönetimi bölümleri');

  const labels = SYSTEM_ADMIN_TABS.map((tab) => tab.label);
  assert.deepEqual(labels, [
    'Genel Durum', 'Performans', 'Kuyruklar ve İşler', 'Hatalar ve Olaylar', 'Entegrasyonlar', 'Hatırlatma E-postaları'
  ]);

  for (const tab of SYSTEM_ADMIN_TABS) {
    const button = findElement(view.output, (node) => node.props?.id === systemAdminTabId(tab.id));
    assert.ok(button, `${tab.id} sekmesi çizilmelidir`);
    assert.equal(button.props.role, 'tab');
    assert.equal(button.props['aria-controls'], systemAdminPanelId(tab.id));
    assert.equal(button.props.type, 'button');
    // Dolaşan sekme sırası: yalnızca etkin sekme klavye sırasındadır.
    assert.equal(button.props.tabIndex, tab.id === 'genel' ? 0 : -1);
    assert.equal(button.props['aria-selected'], tab.id === 'genel');
  }

  const panel = findElement(view.output, (node) => node.props?.role === 'tabpanel');
  assert.equal(panel.props.id, systemAdminPanelId('genel'));
  assert.equal(panel.props['aria-labelledby'], systemAdminTabId('genel'));
});

test('sekme seçimi tıklama ve ok tuşlarıyla değişir', (t) => {
  withDataMode(t, 'demo');
  const previousRaf = globalThis.requestAnimationFrame;
  const previousDocument = globalThis.document;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.document = { getElementById: () => null };
  t.after(() => {
    globalThis.requestAnimationFrame = previousRaf;
    globalThis.document = previousDocument;
  });

  const view = mountComponent(SystemAdministrationView, {});
  t.after(() => view.unmount());

  const queues = findElement(view.output, (node) => node.props?.id === systemAdminTabId('kuyruklar'));
  queues.props.onClick();
  view.render();
  assert.equal(findElement(view.output, (node) => node.props?.role === 'tabpanel').props.id, systemAdminPanelId('kuyruklar'));

  const active = findElement(view.output, (node) => node.props?.id === systemAdminTabId('kuyruklar'));
  active.props.onKeyDown({ key: 'ArrowRight', preventDefault() {}, stopPropagation() {} });
  view.render();
  assert.equal(findElement(view.output, (node) => node.props?.role === 'tabpanel').props.id, systemAdminPanelId('olaylar'));

  findElement(view.output, (node) => node.props?.id === systemAdminTabId('olaylar'))
    .props.onKeyDown({ key: 'Home', preventDefault() {}, stopPropagation() {} });
  view.render();
  assert.equal(findElement(view.output, (node) => node.props?.role === 'tabpanel').props.id, systemAdminPanelId('genel'));
});

test('hatırlatma yönetimi çatallanmaz; var olan görünüm sekmeye gömülür', (t) => {
  withDataMode(t, 'demo');
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 0;
  t.after(() => { globalThis.requestAnimationFrame = previousRaf; });

  const view = mountComponent(SystemAdministrationView, {});
  t.after(() => view.unmount());
  findElement(view.output, (node) => node.props?.id === systemAdminTabId('hatirlatma')).props.onClick();
  view.render();

  const panel = findElement(view.output, (node) => node.props?.role === 'tabpanel');
  const embedded = findElement(panel, (node) => typeof node.type === 'function' && node.type.name === 'ReminderSettingsView');
  assert.ok(embedded, 'mevcut hatırlatma görünümü sekmeye gömülmelidir');

  // İkinci bir hatırlatma uygulaması yazılmadı.
  const source = read('src/features/system-admin/SystemAdministrationView.jsx');
  assert.match(source, /import \{ ReminderSettingsView \} from '\.\.\/reminders\/ReminderSettingsView';/);
  assert.equal(fs.existsSync(path.join(ROOT, 'src/features/reminders/ReminderSettingsView.jsx')), true);
});

/* ── Demo Kipi ────────────────────────────────────────────── */

test('Demo Kipinde üretim uçları çağrılmaz ve durum açıkça söylenir', async (t) => {
  withDataMode(t, 'demo');
  const calls = stubFetch(t, async () => Response.json({ ok: true }));
  const view = mountComponent(SystemAdministrationView, {});
  t.after(() => view.unmount());
  await immediate();
  view.render();

  assert.deepEqual(calls, [], 'Demo Kipinde yönetim ucu çağrılmamalıdır');
  const serialized = JSON.stringify(view.output);
  assert.match(serialized, /Demo Kipi/);
  assert.match(serialized, /CANLI veri okumaz/);
});

test('Gerçek Sistem kipinde genel durum ucu çağrılır', async (t) => {
  withDataMode(t, 'actual');
  const calls = stubFetch(t, async () => Response.json(overviewFixture()));
  const view = mountComponent(SystemAdministrationView, {});
  t.after(() => view.unmount());
  await immediate();
  view.render();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/api\/mergen-rota\/admin\/system\/overview$/);
});

/* ── Sağlık şeridi ────────────────────────────────────────── */

test('sağlık şeridi veri yokken "bilinmiyor" gösterir, sağlıklı demez', () => {
  const output = SystemHealthStrip({ overview: null, stale: false, error: null, lastUpdatedAt: null, refreshing: false });
  const serialized = JSON.stringify(output);
  assert.match(serialized, /Bilinmiyor/);
  assert.doesNotMatch(serialized, /Sağlıklı/);
  assert.match(serialized, /henüz yok/);
});

test('sağlık şeridi bayat veriyi ve son geçerli bilgiyi ayırt eder', () => {
  const now = Date.now();
  const stale = SystemHealthStrip({
    overview: overviewFixture(), stale: true, error: null, lastUpdatedAt: now - 600000, refreshing: false
  });
  assert.match(JSON.stringify(stale), /bayatladı/);

  const failing = SystemHealthStrip({
    overview: overviewFixture(), stale: false, error: { code: 'NETWORK', message: 'yok' }, lastUpdatedAt: now - 30000, refreshing: false
  });
  assert.match(JSON.stringify(failing), /son geçerli bilgi/);
});

test('şerit bileşenleri ilgili sekmeye yönlendirir', () => {
  const navigated = [];
  const output = SystemHealthStrip({
    overview: overviewFixture(),
    stale: false,
    error: null,
    lastUpdatedAt: Date.now(),
    refreshing: false,
    onNavigate: (tab, key) => navigated.push([tab, key])
  });
  const chip = findElement(output, (node) => node.props?.['aria-label']?.includes('Outlook takvim teslimatı'));
  assert.ok(chip);
  chip.props.onClick();
  assert.deepEqual(navigated, [['kuyruklar', COMPONENTS.OUTLOOK]]);
});

/* ── Genel Durum sekmesi ──────────────────────────────────── */

test('genel durum dikkat gerektirenleri, bileşenleri ve göstergeleri çizer', (t) => {
  const view = mountComponent(SystemOverviewTab, {
    overview: overviewFixture(), loading: false, error: null, stale: false,
    lastUpdatedAt: Date.parse('2026-09-12T10:00:00.000Z'), demoMode: false, onNavigate() {}
  });
  t.after(() => view.unmount());
  const serialized = JSON.stringify(view.output);
  assert.match(serialized, /Dikkat Gerektirenler/);
  assert.match(serialized, /Outlook kuyruğu yaşlanıyor/);
  assert.match(serialized, /Kuyruklar sekmesinden turu çalıştırın/);
  assert.match(serialized, /Bileşen sağlığı/);
  assert.match(serialized, /İşletim göstergeleri/);
  assert.match(serialized, /Son işletim olayları/);
  // Ölçülemeyen bileşen "bilinmiyor" tonuyla ayrı gösterilir ve son başarılı
  // işlem anı da bilinmiyor olarak yazılır.
  assert.match(serialized, /sysadmin-component-unknown/);
  assert.match(serialized, /Son başarı: .{0,4}bilinmiyor/);
});

test('sorun yokken genel durum sessiz kalır', (t) => {
  const calm = overviewFixture({ attention: [], state: HEALTH_STATES.HEALTHY, counts: { total: 4, healthy: 4, warning: 0, critical: 0, unknown: 0, notConfigured: 0 } });
  const view = mountComponent(SystemOverviewTab, {
    overview: calm, loading: false, error: null, stale: false, lastUpdatedAt: Date.now(), demoMode: false, onNavigate() {}
  });
  t.after(() => view.unmount());
  assert.match(JSON.stringify(view.output), /Açık bir sorun yok/);
});

test('genel durum Demo Kipinde canlı veri yerine açık bir ileti gösterir', (t) => {
  const view = mountComponent(SystemOverviewTab, { demoMode: true });
  t.after(() => view.unmount());
  assert.match(JSON.stringify(view.output), /Demo Kipinde canlı gözlemlenebilirlik kullanılamaz/);
});

/* ── Kuyruklar, olaylar ve entegrasyonlar ─────────────────── */

test('kuyruk sekmesi etkili eylemler için onay ister', async (t) => {
  withDataMode(t, 'actual');
  const calls = [];
  stubFetch(t, async (url, init) => {
    calls.push({ url, method: init?.method || 'GET', body: init?.body });
    if (init?.method === 'POST') return Response.json({ ok: true, message: 'Tur tamamlandı.' });
    return Response.json({
      ok: true,
      generatedAt: '2026-09-12T10:00:00.000Z',
      outlook: { enabled: true, worker: { started: true, enabled: true, lastFinishedAt: '2026-09-12T09:59:00.000Z' }, queue: { pending: 2, due: 1, inFlight: 0, failed: 1, exhausted: 0 }, age: { maxAttemptCount: 2 }, items: [], maxAttempts: 6, pollIntervalMs: 5000, itemLimit: 50 },
      reminders: { automaticEnabled: true, schemaReady: true, windowValue: 7, windowUnit: 'day', frequencyValue: 2, frequencyUnit: 'day', history: [] },
      corporateWbs: { configured: false },
      telemetryWorker: { started: true }
    });
  });

  const view = mountComponent(SystemQueuesTab, { enabled: true });
  t.after(() => view.unmount());
  await immediate();
  view.render();

  // Eylemler bölüm başlığının `actions` alanında durur; onay metni orada tanımlanır.
  const outlookSection = findElement(view.output, (node) => node.props?.title === 'Outlook takvim teslimatı');
  assert.ok(outlookSection, 'Outlook bölümü çizilmelidir');
  const actions = JSON.stringify(outlookSection.props.actions);
  assert.match(actions, /Şimdi Çalıştır/);
  assert.match(actions, /GÖNDERİR/);
  assert.match(actions, /Başarısızları Yeniden Dene/);
  // Onay istenmeden istek gönderilmez.
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('entegrasyon kartı yapılandırma durumunu gizli değer olmadan gösterir', async (t) => {
  stubFetch(t, async () => Response.json({
    ok: true,
    generatedAt: '2026-09-12T10:00:00.000Z',
    integrations: [{
      id: 'smtp', label: 'SMTP posta sunucusu', kind: 'Kurumsal posta', configured: true,
      state: HEALTH_STATES.HEALTHY, message: 'Yapılandırma eksiksiz.', testable: true, durationMs: 12,
      lastSuccessAt: '2026-09-12T09:00:00.000Z', lastFailureAt: null, lastFailureCode: null
    }]
  }));
  const view = mountComponent(SystemIntegrationsTab, { enabled: true });
  t.after(() => view.unmount());
  await immediate();
  view.render();
  const serialized = JSON.stringify(view.output);
  assert.match(serialized, /Yapılandırılmış/);
  assert.match(serialized, /Bağlantıyı Test Et/);
  assert.match(serialized, /ileti göndermeden/);
});

test('olay sekmesi süzgeç kümesini ve sayfalamayı sunar', async (t) => {
  stubFetch(t, async () => Response.json({
    ok: true,
    range: { id: '24h', label: 'Son 24 saat', durationMs: 86400000 },
    schemaReady: true,
    total: 2,
    offset: 0,
    limit: 25,
    events: [{ id: 1, occurredAt: '2026-09-12T09:00:00.000Z', severity: 'ERROR', component: 'SMTP', code: 'SMTP_DELIVERY_FAILED', summary: 'SMTP teslimatı başarısız', occurrenceCount: 12, correlationId: 'abc-123', detail: null, context: null, action: 'Sunucu erişimini denetleyin.' }],
    alerts: [{ id: 5, alertKey: 'SMTP:SMTP_DELIVERY_FAILED', severity: 'ERROR', component: 'SMTP', code: 'SMTP_DELIVERY_FAILED', summary: 'SMTP teslimatı başarısız', state: 'OPEN', occurrenceCount: 12, firstSeenAt: '2026-09-12T08:00:00.000Z', lastSeenAt: '2026-09-12T09:00:00.000Z', detail: null, context: null, action: null }],
    feed: [],
    filters: { severities: [{ id: 'ERROR', label: 'Hata' }], components: [{ id: 'SMTP', label: 'SMTP' }], codes: [{ id: 'SMTP_DELIVERY_FAILED', label: 'SMTP teslimatı başarısız' }] }
  }));
  const view = mountComponent(SystemEventsTab, { enabled: true });
  t.after(() => view.unmount());
  await immediate();
  view.render();
  const serialized = JSON.stringify(view.output);
  for (const label of ['Ağırlık', 'Bileşen', 'Olay kodu', 'Zaman aralığı', 'Uyarı durumu', 'Ara']) {
    assert.match(serialized, new RegExp(label), `${label} süzgeci bulunmalıdır`);
  }
  assert.match(serialized, /Süzgeçleri temizle/);
  assert.match(serialized, /Onayla/);
  assert.match(serialized, /Önceki/);
  assert.match(serialized, /Sonraki/);
});

/* ── Grafikler ────────────────────────────────────────────── */

test('grafik veri yokken boş durumu erişilebilir biçimde bildirir', (t) => {
  const view = mountComponent(TrendChart, { series: [{ id: 'p95', label: 'P95', points: [] }], unit: 'ms' });
  t.after(() => view.unmount());
  assert.equal(view.output.props.className, 'sysadmin-chart sysadmin-chart-empty');
  assert.match(view.output.props['aria-label'], /veri yok/);
});

test('grafik eksik ölçümde çizgiyi keser, sıfıra düşürmez', (t) => {
  const points = [
    { bucketStart: '2026-09-12T09:00:00.000Z', value: 100 },
    { bucketStart: '2026-09-12T09:05:00.000Z', value: null },
    { bucketStart: '2026-09-12T09:10:00.000Z', value: 120 }
  ];
  const view = mountComponent(TrendChart, { series: [{ id: 'p95', label: 'P95', points }], unit: 'ms' });
  t.after(() => view.unmount());
  const polylines = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'polyline') polylines.push(node);
    walk(node.props?.children);
  };
  walk(view.output);
  assert.equal(polylines.length, 2, 'eksik kova çizgiyi ikiye böler');
  for (const polyline of polylines) {
    assert.equal(polyline.props.points.split(' ').length, 1);
  }
});

/* ── Stil ve mimari ───────────────────────────────────────── */

test('yönetim konsolu stilleri kök düzende yüklenir ve hareket tercihine uyar', () => {
  assert.match(read('src/app/layout.js'), /styles\/system-admin\.css/);
  const css = read('src/app/styles/system-admin.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  // Durum tonları uygulamanın belirteçlerinden türetilir; yeni renk paleti yok.
  assert.match(css, /--sys-ok: var\(--status-done\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{6}/i);
  assert.doesNotMatch(css, /\[style\*=/);
});

test('yönetim konsolu tek bir dev bileşene sığdırılmadı', () => {
  const files = fs.readdirSync(path.join(ROOT, 'src/features/system-admin'), { recursive: true })
    .filter((name) => String(name).endsWith('.jsx') || String(name).endsWith('.js'));
  assert.ok(files.length >= 12, 'özellik anlamlı modüllere bölünmelidir');
  for (const file of files) {
    const lines = read(path.join('src/features/system-admin', String(file))).split('\n').length;
    assert.ok(lines < 460, `${file} çok büyüdü (${lines} satır)`);
  }
});
