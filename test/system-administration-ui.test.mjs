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
const { SystemPerformanceTab } = await import('../src/features/system-admin/tabs/SystemPerformanceTab.jsx');
const { TrendChart } = await import('../src/features/system-admin/components/TrendChart.jsx');
const { useAdminResource } = await import('../src/features/system-admin/useAdminResource.js');
const { DataModeContext } = await import('../src/components/shell/DataModeContext.jsx');
const { HEALTH_STATES } = await import('../src/domain/observability/healthModel.js');
const { COMPONENTS } = await import('../src/domain/observability/eventModel.js');

function withDataMode(t, dataMode) {
  const previous = DataModeContext._currentValue;
  DataModeContext._currentValue = { dataMode, async setDataMode() {} };
  t.after(() => { DataModeContext._currentValue = previous; });
}

/** Metnini taşıyan ilk `<button>` düğümü; olay işleyicisi doğrudan çağrılır. */
function findButtonWithText(tree, text) {
  const found = findElement(tree, (node) => node.type === 'button'
    && JSON.stringify(node.props?.children ?? '').includes(text));
  assert.ok(found, `"${text}" düğmesi bulunmalıdır`);
  return found;
}

/** Görünür etiketiyle eşleşen süzgeç alanının denetimi (`select` / `input`). */
function findFilterControl(tree, label, type) {
  const field = findElement(tree, (node) => String(node.props?.className || '').startsWith('sysadmin-filter')
    && JSON.stringify(node.props?.children ?? '').includes(label));
  assert.ok(field, `"${label}" süzgeci bulunmalıdır`);
  const control = findElement(field.props.children, (node) => node.type === type);
  assert.ok(control, `"${label}" süzgecinin ${type} denetimi bulunmalıdır`);
  return control;
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

  // Sağlık şeridine yenileme işleyicisi VERİLMEZ: şerit `onRefresh`'i doğrudan
  // çağırır ve kaynağın `enabled` bayrağını atlayıp canlı istek gönderirdi.
  const strip = findElement(view.output, (node) => typeof node.type === 'function'
    && node.type.name === 'SystemHealthStrip');
  assert.ok(strip, 'sağlık şeridi çizilmelidir');
  assert.equal(strip.props.onRefresh, undefined);
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

  // Eylem GERÇEKTEN çalıştırılır: yalnızca metne bakan bir sınama, düğme onay
  // istemeden POST gönderse bile geçerdi.
  const runAction = findElement(outlookSection.props.actions, (node) => node.props?.label === 'Şimdi Çalıştır');
  assert.ok(runAction, 'Şimdi Çalıştır düğmesi bulunmalıdır');
  const button = mountComponent(runAction.type, runAction.props);
  t.after(() => button.unmount());

  const postCount = () => calls.filter((call) => call.method === 'POST').length;
  assert.equal(postCount(), 0, 'açılışta istek gönderilmez');

  // 1) Tıklama yalnızca onayı kurar; istek gönderilmez.
  findButtonWithText(button.output, 'Şimdi Çalıştır').props.onClick();
  button.render();
  assert.match(JSON.stringify(button.output), /GÖNDERİR/, 'onay metni gösterilmelidir');
  assert.equal(postCount(), 0, 'onay beklenirken istek gönderilmez');

  // 2) Vazgeçmek isteği İPTAL eder.
  findButtonWithText(button.output, 'Vazgeç').props.onClick();
  button.render();
  assert.equal(postCount(), 0, 'vazgeçildiğinde istek gönderilmez');

  // 3) Onaylamak TAM OLARAK bir POST gönderir ve eylem adını taşır.
  findButtonWithText(button.output, 'Şimdi Çalıştır').props.onClick();
  button.render();
  await findButtonWithText(button.output, 'Onayla').props.onClick();
  await immediate();
  const posts = calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1, 'onaydan sonra tek istek gider');
  assert.match(posts[0].url, /\/api\/mergen-rota\/admin\/system\/queues$/);
  assert.deepEqual(JSON.parse(posts[0].body), { action: 'outlook-run' });
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

test('olay sekmesi süzgeçleri ve sayfalamayı isteğe yansıtır', async (t) => {
  const calls = stubFetch(t, async () => Response.json({
    ok: true,
    range: { id: '24h', label: 'Son 24 saat', durationMs: 86400000 },
    schemaReady: true,
    total: 60,
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

  // Süzgeç DEĞİŞİMİ isteğe yansımalıdır; yalnızca çizilen metne bakan bir
  // sınama, işleyici isteği güncellemeyi bıraksa bile geçerdi.
  findFilterControl(view.output, 'Ağırlık', 'select').props.onChange({ target: { value: 'ERROR' } });
  view.render();
  await immediate();
  view.render();
  assert.match(calls.at(-1), /[?&]severity=ERROR(&|$)/);

  // Sayfalama da isteğe yansır ve gösterilen aralık ilerler.
  findButtonWithText(view.output, 'Sonraki').props.onClick();
  view.render();
  await immediate();
  view.render();
  assert.match(calls.at(-1), /[?&]offset=25(&|$)/);
  assert.match(calls.at(-1), /[?&]severity=ERROR(&|$)/, 'sayfa değişince süzgeç korunur');
  assert.match(JSON.stringify(view.output), /26–50 \/ 60/);
});

/* ── Grafikler ────────────────────────────────────────────── */

test('grafik veri yokken boş durumu erişilebilir biçimde bildirir', (t) => {
  const view = mountComponent(TrendChart, { series: [{ id: 'p95', label: 'P95', points: [] }], unit: 'ms' });
  t.after(() => view.unmount());
  assert.equal(view.output.props.className, 'sysadmin-chart sysadmin-chart-empty');
  assert.match(view.output.props['aria-label'], /veri yok/);
});

/** SVG düğümlerini türüne göre toplar. */
function collectSvgNodes(root, type) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === type) found.push(node);
    walk(node.props?.children);
  };
  walk(root);
  return found;
}

test('grafik eksik ölçümde çizgiyi keser, sıfıra düşürmez', (t) => {
  const points = [
    { bucketStart: '2026-09-12T09:00:00.000Z', value: 100 },
    { bucketStart: '2026-09-12T09:05:00.000Z', value: null },
    { bucketStart: '2026-09-12T09:10:00.000Z', value: 120 },
    { bucketStart: '2026-09-12T09:15:00.000Z', value: 130 }
  ];
  const view = mountComponent(TrendChart, { series: [{ id: 'p95', label: 'P95', points }], unit: 'ms' });
  t.after(() => view.unmount());
  const polylines = collectSvgNodes(view.output, 'polyline');
  const circles = collectSvgNodes(view.output, 'circle');

  // Eksik kova çizgiyi böler: geriye bir tek noktalı ve bir iki noktalı parça
  // kalır. Tek koordinatlı `polyline` GÖRÜNMEZDİR; yalnız kalan ölçüm daire
  // olarak çizilir, yoksa grafik "veri var" derken hiçbir şey göstermezdi.
  assert.equal(circles.length, 1, 'yalnız kalan ölçüm daire olarak çizilir');
  assert.equal(polylines.length, 1, 'bitişik ölçümler tek çizgi parçası olur');
  assert.equal(polylines[0].props.points.split(' ').length, 2);
  // Hiçbir parça eksik kovayı sıfır olarak çizmez: dört noktadan yalnız üçü
  // koordinat üretmelidir.
  const drawn = polylines[0].props.points.split(' ').length + circles.length;
  assert.equal(drawn, 3);
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

/* ── İnceleme bulgularının gerilemeleri ───────────────────── */

test('yükleyici reddetse bile otomatik yoklama sürer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const loader = () => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error('NETWORK')) : Promise.resolve({ ok: true, tick: calls });
  };
  const Probe = () => useAdminResource(loader, { intervalMs: 1000 });
  const view = mountComponent(Probe, {});
  t.after(() => view.unmount());
  await immediate();
  view.render();
  assert.equal(calls, 1);
  assert.ok(view.output.error, 'reddedilen istek hata olarak bildirilir');

  t.mock.timers.tick(1000);
  await immediate();
  view.render();
  // Tek bir geçici ağ hatası otomatik izlemeyi kalıcı olarak SUSTURMAZ.
  assert.equal(calls, 2);
  assert.equal(view.output.error, null);
  assert.equal(view.output.data.tick, 2);
});

test('kuyruk eylemi başarısız olduğunda hata bildirilir ve düğme kilitli kalmaz', async (t) => {
  withDataMode(t, 'actual');
  stubFetch(t, async (url, init) => {
    if (init?.method === 'POST') throw new Error('ECONNRESET');
    return Response.json({
      ok: true,
      generatedAt: '2026-09-12T10:00:00.000Z',
      outlook: { enabled: true, worker: { started: true, enabled: true, lastFinishedAt: '2026-09-12T09:59:00.000Z' }, queue: { pending: 1, due: 1, inFlight: 0, failed: 0, exhausted: 0 }, age: {}, items: [], maxAttempts: 6, pollIntervalMs: 5000, itemLimit: 50 },
      reminders: { automaticEnabled: false, schemaReady: true, history: [] },
      corporateWbs: { configured: false }
    });
  });
  const view = mountComponent(SystemQueuesTab, { enabled: true });
  t.after(() => view.unmount());
  await immediate();
  view.render();

  const section = findElement(view.output, (node) => node.props?.title === 'Outlook takvim teslimatı');
  const action = findElement(section.props.actions, (node) => node.props?.label === 'Şimdi Çalıştır');
  await action.props.onRun();
  await immediate();
  view.render();

  // Başarısızlık HEM bildirilir HEM de eylem durumunu temizler.
  const result = findElement(view.output, (node) => String(node.props?.className || '').includes('sysadmin-action-error'));
  assert.ok(result, 'başarısız eylem kullanıcıya bildirilmelidir');
  const rerendered = findElement(view.output, (node) => node.props?.title === 'Outlook takvim teslimatı');
  for (const label of ['Şimdi Çalıştır', 'Başarısızları Yeniden Dene']) {
    const action = findElement(rerendered.props.actions, (node) => node.props?.label === label);
    assert.equal(Boolean(action.props.busy), false, `${label} "çalışıyor" durumunda kalmamalıdır`);
    assert.equal(Boolean(action.props.disabled), false, `${label} yeniden kullanılabilir olmalıdır`);
  }
});

test('olay isteği başarısızken boş sonuç bildirilmez', async (t) => {
  stubFetch(t, async () => Response.json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Veritabanına ulaşılamadı.' } }, { status: 503 }));
  const view = mountComponent(SystemEventsTab, { enabled: true });
  t.after(() => view.unmount());
  await immediate();
  view.render();
  // "Açık uyarı yok" / "olay bulunamadı" ölçülmüş bir SONUÇTUR; alınamayan
  // yanıt bunların yerine geçemez. Bölümler boş değil HATA durumundadır.
  for (const title of ['Uyarılar', 'Olay geçmişi']) {
    const section = findElement(view.output, (node) => node.props?.title === title);
    assert.ok(section, `${title} bölümü çizilmelidir`);
    assert.equal(section.props.empty, false, `${title} boş bildirilmemelidir`);
    assert.match(String(section.props.error), /DATABASE_UNAVAILABLE/);
  }
});

test('tek zaman damgalı grafik ölçümü ortada daire olarak gösterir', (t) => {
  const view = mountComponent(TrendChart, { series: [{ id: 'p95', points: [
    { bucketStart: '2026-09-12T09:00:00.000Z', value: 100 }
  ] }] });
  t.after(() => view.unmount());
  const circles = collectSvgNodes(view.output, 'circle');
  assert.equal(circles.length, 1);
  assert.equal(circles[0].props.cx, 377);
  assert.ok(Number.isFinite(circles[0].props.cy));
});

test('grafik yalnızca geçerli zaman ve değeri birlikte taşıyan ölçümleri çizer', (t) => {
  for (const series of [null, [{ points: [null, { bucketStart: null, value: 9 }, { bucketStart: 'bozuk', value: 10 }, { bucketStart: '2026-09-12', value: null }] }]]) {
    const view = mountComponent(TrendChart, { series });
    t.after(() => view.unmount());
    assert.equal(collectSvgNodes(view.output, 'circle').length, 0);
    assert.match(view.output.props['aria-label'], /veri yok/);
  }
});

test('elle yenileme etkin yoklamayı bekler ve tek yeni yanıt alır', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = [];
  const loader = () => new Promise((resolve) => pending.push(resolve));
  const view = mountComponent(() => useAdminResource(loader, { intervalMs: 1000 }), {});
  t.after(() => view.unmount());
  const first = view.output.refresh();
  const second = view.output.refresh();
  assert.equal(first, second);
  assert.equal(pending.length, 1);
  pending[0]({ ok: true, revision: 1 });
  await immediate();
  assert.equal(pending.length, 2);
  pending[1]({ ok: true, revision: 2 });
  await first;
  view.render();
  assert.equal(view.output.data.revision, 2);
  t.mock.timers.tick(999);
  assert.equal(pending.length, 2);
  t.mock.timers.tick(1);
  assert.equal(pending.length, 3);
  pending[2]({ ok: true, revision: 3 });
  await immediate();
});

test('görünürlük dönüşü bekleyen yoklama zamanını yeniden kurar', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const previous = globalThis.document;
  let onVisibility;
  globalThis.document = { visibilityState: 'visible', addEventListener(type, fn) { onVisibility = fn; }, removeEventListener() {} };
  t.after(() => { globalThis.document = previous; });
  let calls = 0;
  const loader = async () => { calls += 1; return { ok: false, code: 'NETWORK' }; };
  const view = mountComponent(() => useAdminResource(loader, { intervalMs: 1000 }), {});
  t.after(() => view.unmount());
  await immediate();
  view.render();
  t.mock.timers.tick(999);
  onVisibility();
  await immediate();
  view.render();
  assert.equal(calls, 2);
  t.mock.timers.tick(1);
  await immediate();
  assert.equal(calls, 2);
  t.mock.timers.tick(999);
  await immediate();
  assert.equal(calls, 3);
});

test('yükleyici değişince iptal edilen yanıt uygulanmaz ve yeni istek gecikmez', async (t) => {
  let finish;
  let calls = 0;
  const oldLoader = () => new Promise((resolve) => { finish = resolve; });
  const newLoader = async () => { calls += 1; return { ok: true, revision: 2 }; };
  const view = mountComponent(({ loader, enabled = true }) => useAdminResource(loader, { intervalMs: 1000, enabled }), { loader: oldLoader });
  t.after(() => view.unmount());
  view.render({ loader: newLoader });
  finish({ ok: true, revision: 1 });
  await immediate();
  view.render();
  assert.equal(calls, 1);
  assert.equal(view.output.data.revision, 2);
  view.render({ loader: newLoader, enabled: false });
  await view.output.refresh();
  assert.equal(calls, 1);
});

test('kaydedilmiş sekme ilk çizimden sonra okunur ve önce ezilmez', (t) => {
  withDataMode(t, 'demo');
  const previous = globalThis.window;
  const writes = [];
  globalThis.window = { localStorage: { getItem: () => 'kuyruklar', setItem(key, value) { writes.push(value); } } };
  t.after(() => { globalThis.window = previous; });
  const view = mountComponent(SystemAdministrationView, {});
  t.after(() => view.unmount());
  assert.equal(findElement(view.frames[0], (node) => node.props?.role === 'tabpanel').props.id, systemAdminPanelId('genel'));
  assert.equal(findElement(view.output, (node) => node.props?.role === 'tabpanel').props.id, systemAdminPanelId('kuyruklar'));
  assert.deepEqual(writes, ['kuyruklar']);
});

test('bileşen çekmecesi güncel ölçümü ve sağlık etiketini gösterir', (t) => {
  const initial = overviewFixture();
  initial.components.forEach((item) => { delete item.stateLabel; });
  const view = mountComponent(SystemOverviewTab, { overview: initial });
  t.after(() => view.unmount());
  findButtonWithText(view.output, 'Ana SQL Server').props.onClick();
  view.render();
  const drawer = () => findElement(view.output, (node) => node.type?.name === 'DetailDrawer');
  assert.equal(drawer().props.subtitle, 'Sağlıklı');
  const updated = { ...initial, components: initial.components.map((item) => item.key === COMPONENTS.DATABASE ? { ...item, state: HEALTH_STATES.CRITICAL, message: 'Yeni hata', lastCheckedAt: '2026-09-12T11:00:00Z' } : item) };
  view.render({ overview: updated });
  assert.equal(drawer().props.subtitle, 'Kritik');
  assert.ok(findElement(drawer(), (node) => node.props?.value === '2026-09-12T11:00:00Z'));
  view.render({ overview: { ...updated, components: [] } });
  assert.equal(drawer(), null);
});

test('ilk entegrasyon ve genel durum hatası başarılı boş durum gibi gösterilmez', async (t) => {
  stubFetch(t, async () => Response.json({ ok: false, code: 'NETWORK' }, { status: 500 }));
  const integrations = mountComponent(SystemIntegrationsTab, { enabled: true });
  const overview = mountComponent(SystemOverviewTab, { overview: null, error: { code: 'NETWORK' } });
  t.after(() => { integrations.unmount(); overview.unmount(); });
  await immediate();
  integrations.render();
  const section = findElement(integrations.output, (node) => node.props?.title === 'Bağımlılıklar');
  assert.ok(section.props.error);
  assert.equal(section.props.empty, false);
  assert.ok(findElement(integrations.output, (node) => node.props?.role === 'status' && node.props['aria-live'] === 'polite'));
  assert.doesNotMatch(JSON.stringify(overview.output), /son geçerli ölçüme aittir/);
});

test('kuyruk yaşı sunucunun ayarladığı eşikle renklendirilir', async (t) => {
  stubFetch(t, async () => Response.json({ ok: true, generatedAt: '2026-09-12T10:00:00Z', configuration: { thresholds: { queueAgeMinutes: 5 } }, outlook: { enabled: true, queue: {}, age: { oldestUnattemptedAt: '2026-09-12T09:50:00Z' }, items: [] } }));
  const view = mountComponent(SystemQueuesTab, { enabled: true });
  t.after(() => view.unmount());
  await immediate();
  view.render();
  const tile = findElement(view.output, (node) => node.props?.label === 'En eski bekleyen');
  assert.equal(tile.props.tone, 'warn');
});

test('grafik işaretçisi SVG ölçeğinde iç çizim alanına göre seçilir', (t) => {
  const at = Date.parse('2026-09-12T10:00:00Z');
  const view = mountComponent(TrendChart, { width: 720, series: [{ label: 'Ölçüm', points: [0, 1, 2].map((i) => ({ bucketStart: new Date(at + i * 300000).toISOString(), value: i * 10 + 10 })) }] });
  t.after(() => view.unmount());
  const svg = findElement(view.output, (node) => node.type === 'svg');
  svg.props.onMouseMove({ clientX: 105, currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 360 }) } });
  view.render();
  const tooltip = findElement(view.output, (node) => node.props?.className === 'sysadmin-chart-tip');
  assert.ok(tooltip);
  assert.match(JSON.stringify(tooltip), /13:00/);
});

test('eğilim boş metinleri sıfır ölçüm olarak çizmez', async (t) => {
  const { MetricTile } = await import('../src/features/system-admin/components/MetricTile.jsx');
  const view = mountComponent(MetricTile, { trend: [{ value: 5 }, { value: '' }, { value: ' ' }, { value: 10 }] });
  t.after(() => view.unmount());
  const sparkline = findElement(view.output, (node) => node.type?.name === 'Sparkline');
  assert.deepEqual(sparkline.props.values, [5, 10]);
});

test('başarısız onaydan sonra başka kayıt açılınca eski hata temizlenir', async (t) => {
  stubFetch(t, async (url, init) => init?.method === 'POST'
    ? Response.json({ ok: false, message: 'Önceki onay başarısız' }, { status: 409 })
    : Response.json({ ok: true, alerts: [{ id: 1, state: 'OPEN', severity: 'ERROR', component: 'SMTP', summary: 'Uyarı' }], events: [{ id: 2, severity: 'INFO', component: 'APPLICATION', summary: 'Olay' }], total: 1 }));
  const view = mountComponent(SystemEventsTab, { enabled: true });
  t.after(() => view.unmount());
  await immediate();
  view.render();
  const alerts = findElement(view.output, (node) => node.props?.title === 'Uyarılar');
  findButtonWithText(alerts, 'Ayrıntı').props.onClick();
  view.render();
  const drawer = findElement(view.output, (node) => node.type?.name === 'DetailDrawer');
  const acknowledge = findElement(drawer.props.footer, (node) => node.type === 'button');
  await acknowledge.props.onClick();
  view.render();
  assert.match(JSON.stringify(view.output), /Önceki onay başarısız/);
  const events = findElement(view.output, (node) => node.props?.title === 'Olay geçmişi');
  findElement(events, (node) => node.props?.['aria-label'] === 'Olay ayrıntısını aç').props.onClick();
  view.render();
  assert.doesNotMatch(JSON.stringify(view.output), /Önceki onay başarısız/);
});

/* ── İnceleme bulgularının gerilemeleri ───────────────────── */

test('genel sayfa çalışma alanı değişiminde yeniden bağlanmaz', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  // `key` çalışma alanına bağlı kalsaydı proje ya da kip değişimi Sistem
  // Yönetimi'ni yeniden bağlar, açık sekmeyi ve süren isteği düşürürdü.
  assert.match(shell, /key=\{globalPage \? `global:\$\{view\}` : workspaceKey\}/);
});

test('sayım grafiğinin ekseni yinelenen etiket üretmez', (t) => {
  const at = Date.parse('2026-09-12T09:00:00Z');
  const points = [1, 2, 3].map((value, index) => ({
    bucketStart: new Date(at + index * 300000).toISOString(),
    value
  }));
  const view = mountComponent(TrendChart, { series: [{ id: 'count', label: 'İstek', points }], unit: 'count' });
  t.after(() => view.unmount());
  const axis = findElement(view.output, (node) => node.props?.className === 'sysadmin-chart-axis-y');
  assert.ok(axis, 'y ekseni çizilmelidir');
  const labels = axis.props.children.map((child) => child.props.children);
  // Kesirli adım sayım birimiyle yuvarlanınca "0, 0, 1, 1, 1" gibi yinelenen
  // etiketler üretirdi.
  assert.deepEqual(labels, [...new Set(labels)], `yinelenen eksen etiketi: ${labels.join(', ')}`);
  for (const label of labels) assert.match(label, /^\d+$/);
});

test('süre grafiğinin ekseni kesirli değerleri korur', (t) => {
  const at = Date.parse('2026-09-12T09:00:00Z');
  const points = [120, 240, 360].map((value, index) => ({
    bucketStart: new Date(at + index * 300000).toISOString(),
    value
  }));
  const view = mountComponent(TrendChart, { series: [{ id: 'p95', label: 'P95', points }], unit: 'ms' });
  t.after(() => view.unmount());
  const axis = findElement(view.output, (node) => node.props?.className === 'sysadmin-chart-axis-y');
  assert.equal(axis.props.children.length, 5, 'süre ekseni beş değer yazmayı sürdürür');
});

test('kuyruk yaşı grafiği dakika birimiyle çizilir', async (t) => {
  stubFetch(t, async () => Response.json({
    ok: true,
    range: { id: '24h', label: 'Son 24 saat', durationMs: 86400000, bucketMs: 900000 },
    schemaReady: true, summary: {}, series: [], operations: [], gauges: {}, resources: {}
  }));
  const view = mountComponent(SystemPerformanceTab, { enabled: true });
  t.after(() => view.unmount());
  await immediate();
  view.render();
  const chart = findElement(view.output, (node) => node.props?.label === 'Outlook kuyruğunda en eski bekleyen kaydın yaşı');
  assert.ok(chart, 'kuyruk yaşı grafiği çizilmelidir');
  // Sayım birimi yarım dakikalık bir yaşı "1" gösterir ve birimini yitirirdi.
  assert.equal(chart.props.unit, 'minutes');
  const depth = findElement(view.output, (node) => node.props?.label === 'Outlook kuyruk derinliği');
  assert.equal(depth.props.unit, 'count', 'kuyruk derinliği kayıt sayısıdır');
});

test('son turu başarısız çalışan sağlıklı gösterilmez', async (t) => {
  withDataMode(t, 'actual');
  stubFetch(t, async () => Response.json({
    ok: true,
    generatedAt: '2026-09-12T10:00:00.000Z',
    outlook: {
      enabled: true,
      worker: {
        started: true, enabled: true, lastFinishedAt: '2026-09-12T09:59:00.000Z',
        lastResult: { ok: false, reason: 'SMTP_SEND_FAILED' }
      },
      queue: { pending: 1, due: 1, inFlight: 0, failed: 1, exhausted: 0 },
      age: {}, items: [], maxAttempts: 6, pollIntervalMs: 5000, itemLimit: 50
    },
    reminders: { automaticEnabled: false, schemaReady: true, history: [] },
    corporateWbs: { configured: false }
  }));
  const view = mountComponent(SystemQueuesTab, { enabled: true });
  t.after(() => view.unmount());
  await immediate();
  view.render();
  const dot = findElement(view.output, (node) => node.type?.name === 'HealthDot');
  assert.ok(dot, 'çalışan göstergesi çizilmelidir');
  // Aynı satırda hem yeşil gösterge hem hata rozeti okunurdu.
  assert.equal(dot.props.state, HEALTH_STATES.WARNING);
  assert.match(JSON.stringify(view.output), /sysadmin-chip-warn/);
});

test('açık çekmece yenilenen uyarının son durumunu gösterir', async (t) => {
  let state = 'OPEN';
  stubFetch(t, async (url, init) => {
    if (init?.method === 'POST') {
      state = 'ACKNOWLEDGED';
      return Response.json({ ok: true, acknowledged: true, state });
    }
    return Response.json({
      ok: true, total: 1, offset: 0, limit: 25, schemaReady: true, events: [],
      alerts: [{
        id: 1, state, severity: 'ERROR', component: 'SMTP', code: 'SMTP_DELIVERY_FAILED',
        summary: 'SMTP teslimatı başarısız', occurrenceCount: 3, detail: null, context: null, action: null
      }],
      filters: { severities: [], components: [], codes: [] }
    });
  });
  const view = mountComponent(SystemEventsTab, { enabled: true });
  t.after(() => view.unmount());
  await immediate();
  view.render();

  const alerts = findElement(view.output, (node) => node.props?.title === 'Uyarılar');
  findButtonWithText(alerts, 'Ayrıntı').props.onClick();
  view.render();
  const drawer = findElement(view.output, (node) => node.type?.name === 'DetailDrawer');
  assert.ok(drawer.props.footer, 'açık uyarı onay eylemi taşır');

  // Onay LİSTEDEN verilir; çekmece tıklama anındaki kopyayı tutsaydı eski
  // durumu ve geçersiz onay eylemini göstermeyi sürdürürdü.
  const list = findElement(view.output, (node) => node.props?.title === 'Uyarılar');
  await findButtonWithText(list, 'Onayla').props.onClick();
  await immediate();
  view.render();

  const refreshed = findElement(view.output, (node) => node.type?.name === 'DetailDrawer');
  assert.ok(refreshed, 'çekmece açık kalmalıdır');
  assert.equal(refreshed.props.footer, null, 'onaylanmış uyarı yeniden onaylanamaz');
  assert.match(JSON.stringify(refreshed), /Onaylandı/);
});

test('listeden düşen kayıt çekmeceyi kapatır', async (t) => {
  let events = [{
    id: 7, occurredAt: '2026-09-12T09:00:00.000Z', severity: 'INFO', component: 'APPLICATION',
    code: 'APP_STARTED', summary: 'Uygulama başlatıldı', occurrenceCount: 1, detail: null, context: null, action: null
  }];
  stubFetch(t, async () => Response.json({
    ok: true, total: events.length, offset: 0, limit: 25, schemaReady: true, events, alerts: [],
    filters: { severities: [], components: [], codes: [] }
  }));
  const view = mountComponent(SystemEventsTab, { enabled: true });
  t.after(() => view.unmount());
  await immediate();
  view.render();

  findElement(view.output, (node) => node.props?.['aria-label'] === 'Uygulama başlatıldı ayrıntısını aç').props.onClick();
  view.render();
  assert.ok(findElement(view.output, (node) => node.type?.name === 'DetailDrawer'));

  // Saklama sınırı ya da süzgeç değişimi kaydı listeden düşürdüğünde bayat
  // kopya gösterilmeye devam etmez.
  events = [];
  findFilterControl(view.output, 'Ara', 'input').props.onChange({ target: { value: 'başka' } });
  view.render();
  await immediate();
  view.render();
  assert.equal(findElement(view.output, (node) => node.type?.name === 'DetailDrawer'), null);
});
