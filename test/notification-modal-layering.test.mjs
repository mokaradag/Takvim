import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import postcss from 'postcss';
import React, { act, useRef } from 'react';
import { button, click, key, mountDom } from './helpers/clientDomHarness.mjs';

const { ScheduleRequestCenter } = await import('../src/features/schedule-change/ScheduleRequestCenter.jsx');
const { hasBlockingModal, useModalFocusTrap } = await import('../src/hooks/useModalFocusTrap.js');
const { DetailDrawer } = await import('../src/features/system-admin/components/DetailDrawer.jsx');
const { useApplyTweaks } = await import('../src/hooks/useApplyTweaks.js');
const { RotaAssistantPanel } = await import('../src/features/ai/assistant/RotaAssistant.jsx');
const { createAssistantController } = await import('../src/features/ai/assistant/assistantController.js');
const { ASSISTANT_SHEET_QUERY } = await import('../src/features/ai/assistant/assistantInteraction.js');
const { TWEAKS_STORAGE_KEY } = await import('../src/lib/tweaksBootstrap.js');
const { SIDEBAR_PREFERENCE_KEY } = await import('../src/components/shell/sidebarPreference.js');
const { createRoot } = await import('react-dom/client');

/**
 * Bildirimden açılan kipli pencerelerin katman gerilemeleri.
 *
 * Değişmezler:
 *   · Zil `.topbar` içindedir; üst çubuk kendi yığılma bağlamını kurar. Pencere
 *     ve arka perdesi bu bağlamın İÇİNDE çizilirse yapışkan çalışma alanı
 *     şeritleri ve kenar çubuğu arka perdenin üstüne boyanır, bulanıklaşmaz ve
 *     tıklanabilir kalır. Pencere bu yüzden gövdeye taşınır.
 *   · Gövdedeki pencere kök bağlamdaki katman sözleşmesine katılır: kipli katman
 *     şeritlerin, kabuğun ve açılır panellerin üstündedir.
 *   · Taşıma; odak tuzağını, odağın zile dönüşünü, Esc ve arka perde kapanışını,
 *     temizliği ve tema kapsamını bozmaz. Görev atama bildirimi pencere açmaz.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/* ── Ortak düzenek ──────────────────────────────────────────── */

const SCHEDULE_REQUEST = Object.freeze({
  id: 'sr-1',
  status: 'PENDING',
  isDecisionOwner: true,
  taskAvailable: true,
  unread: true,
  version: 'v1',
  taskId: 'task-1',
  taskTitle: 'Yük testi',
  projectCode: 'ALT',
  requesterName: 'Mehmet Kaya',
  requesterMessage: 'Tedarikçi gecikmesi.',
  originalPlannedStart: '2026-10-24',
  proposedPlannedStart: '2026-10-30',
  originalPlannedFinish: '2026-11-03',
  proposedPlannedFinish: '2026-11-12',
  createdAt: '2026-11-24T07:20:00.000Z'
});

// Karar seçeneği taşımayan bilgilendirme kaydı sunucudan yeniden doğrulanmaz;
// test ağ isteği yapmadan atama koordinasyonu penceresini açabilir.
const ASSIGNMENT_NOTICE = Object.freeze({
  id: 'ac-1',
  source: 'ASSIGNMENT_COORDINATION',
  mode: 'NOTICE',
  status: 'APPROVED',
  allowedDecisions: [],
  unread: true,
  version: 'v1',
  taskId: 'task-2',
  taskTitle: 'Ağ yapılandırması',
  projectCode: 'ALT',
  projectName: 'Altyapı Yenileme',
  assigneeName: 'Selin Çelik',
  requesterName: 'Canan Er',
  createdAt: '2026-11-24T07:10:00.000Z'
});

const TASK_EVENT = Object.freeze({
  id: 'tn-1',
  source: 'TASK_EVENT',
  kind: 'TASK_ASSIGNED',
  unread: true,
  version: 'v1',
  taskId: 'task-3',
  taskTitle: 'Kapasite planı',
  actorName: 'Murat Öztürk',
  occurredAt: '2026-11-24T07:05:00.000Z'
});

function notificationState(overrides = {}) {
  const calls = { openTask: [], mark: [] };
  const state = {
    scheduleRequests: [SCHEDULE_REQUEST],
    assignmentCoordinations: [ASSIGNMENT_NOTICE],
    taskNotifications: [TASK_EVENT],
    scheduleRequestSummary: { unreadCount: 1, pendingCount: 1 },
    notificationSummary: { unreadCount: 2, pendingCount: 0 },
    session: { dataMode: 'actual' },
    dataLifecycle: {},
    actions: {
      decideScheduleChange: async () => ({ ok: true, value: {} }),
      decideAssignmentCoordination: async () => ({ ok: true, value: {} }),
      openTask: async (taskId) => { calls.openTask.push(taskId); return { ok: true }; },
      markNotifications: async (items, action) => { calls.mark.push({ items, action }); return { ok: true }; }
    },
    ...overrides
  };
  return { state, calls };
}

/** Bildirim merkezini gerçek kabuktaki gibi `.topbar` içinde bağlar. */
function mountCenter(stateOverrides) {
  const { state, calls } = notificationState(stateOverrides);
  const TopbarHost = () => React.createElement(
    'header',
    { className: 'topbar' },
    React.createElement('div', { className: 'topbar-actions' }, React.createElement(ScheduleRequestCenter, { onNavigate: () => {} }))
  );
  const view = mountDom(TopbarHost, {}, state);
  const topbar = view.host.querySelector('.topbar');
  const toggle = topbar.querySelector('.schedule-request-toggle');
  return { view, topbar, toggle, calls, state };
}

/** Zil panelini açar ve başlığı eşleşen bildirim kartını seçer. */
async function openNotification(toggle, headline) {
  click(toggle);
  const card = [...document.querySelectorAll('.schedule-request-card')]
    .find((node) => headline.test(node.textContent));
  assert.ok(card, `${headline} bildirim kartı bulunmalıdır`);
  // Kart işleyicisi eşzamansızdır (okundu işareti); söz zinciri act içinde tamamlanır.
  await act(async () => { click(card); });
}

/** Odak geri verme `requestAnimationFrame` ile ertelenir; bir kare beklenir. */
async function nextFrame() {
  await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
}

function modalLayers() {
  return document.querySelectorAll('.schedule-modal-layer');
}

/* ── Gerçek DOM davranışı ───────────────────────────────────── */

test('Bildirim penceresi üst çubuğun yığılma bağlamı dışında görüntülenir', async (t) => {
  const { view, topbar, toggle } = mountCenter();
  t.after(() => view.unmount());

  await openNotification(toggle, /Kararınız bekleniyor.*Mehmet Kaya/);

  const layers = modalLayers();
  assert.equal(layers.length, 1, 'tek pencere katmanı açılır; yinelenen perde oluşmaz');
  const [layer] = layers;
  assert.ok(layer.parentElement === document.body, 'pencere katmanı doğrudan gövdeye taşınır');
  assert.ok(layer.closest('.topbar') === null, 'pencere üst çubuğun yığılma bağlamında kalmaz');
  assert.ok(topbar.querySelector('.schedule-modal-layer, .schedule-modal-backdrop') === null, 'üst çubukta artık perde kalmaz');

  // Arka perde ve pencere aynı katmanın kardeşleridir: perde pencerenin altında,
  // sayfanın tamamının üstünde çizilir.
  const backdrop = layer.querySelector(':scope > .schedule-modal-backdrop');
  const dialog = layer.querySelector(':scope > [role="dialog"]');
  assert.ok(backdrop, 'arka perde pencereyle aynı katmandadır');
  assert.ok(dialog, 'pencere katmanın içindedir');
  // Konumlu kardeşler DOM sırasıyla boyanır: perde pencereden SONRA gelseydi
  // pencerenin üstüne çizilir ve denetimlerinin tıklamalarını yutardı.
  assert.ok(backdrop.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING, 'perde pencereden önce, yani altında çizilir');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent, 'Tarih değişikliği talebi');
  assert.ok(dialog.contains(document.activeElement), 'ilk odak pencerenin içindedir');

  // Bildirim paneli kapanır; pencere açık kalır ve üst çubuk olağan katmanına döner.
  assert.ok(document.querySelector('.schedule-request-popover') === null, 'bildirim paneli seçimle kapanır');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(layer.isConnected, 'panelin kapanması pencereyi sökmez');
});

test('Kipli pencere kapatıldığında odak bildirim düğmesine döner', async (t) => {
  const { view, toggle } = mountCenter();
  t.after(() => view.unmount());

  await openNotification(toggle, /Kararınız bekleniyor.*Mehmet Kaya/);
  assert.equal(modalLayers().length, 1);
  // Seçilen kart panelle birlikte söküldüğü için açılış anındaki odak gövdedeydi;
  // gövde odak verilebilir bir açan sayılmaz ve yedek zil düğmesi kullanılır.
  key('Escape');
  assert.equal(modalLayers().length, 0, 'Esc pencereyi ve perdesini kaldırır');
  await nextFrame();
  assert.ok(document.activeElement === toggle, 'odak bildirim düğmesine döner');

  // Arka perde tıklaması da aynı kapanış ve odak yolunu izler.
  await openNotification(toggle, /Kararınız bekleniyor.*Mehmet Kaya/);
  click(document.querySelector('.schedule-modal-backdrop'));
  assert.equal(modalLayers().length, 0, 'arka perde tıklaması pencereyi kapatır');
  await nextFrame();
  assert.ok(document.activeElement === toggle, 'arka perde kapanışında da odak zile döner');
});

test('Açan öge pencereyle birlikte söküldüğünde odak gövdede kalmaz, yedek açana döner', async (t) => {
  // Tarayıcı, odaklı öge DOM'dan söküldüğünde odağı gövdeye taşır: bildirim
  // kartı panelle aynı çizimde kalkar ve pencere açılırken etkin öge gövdedir.
  // JSDOM bu düzeltmeyi her durumda uygulamaz; koşul burada açıkça kurulur.
  const bell = document.createElement('button');
  bell.textContent = 'Bildirimler';
  document.body.append(bell);
  t.after(() => bell.remove());
  act(() => document.activeElement?.blur?.());
  assert.ok(document.activeElement === document.body, 'açılış anında odak gövdededir');

  function TrapProbe({ open }) {
    const containerRef = useRef(null);
    const restoreFocusRef = useRef(bell);
    useModalFocusTrap({ containerRef, initialFocusRef: containerRef, restoreFocusRef, onClose: () => {}, enabled: open });
    return open ? React.createElement('div', { ref: containerRef, tabIndex: -1, role: 'dialog', 'aria-modal': 'true' }) : null;
  }
  // Üretimdeki gibi Strict Mode OLMADAN bağlanır: Strict Mode'un çift etki
  // çalıştırması ikinci turda açanı pencerenin kendisi sayar ve hatayı gizler.
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(() => { act(() => root.unmount()); host.remove(); });
  act(() => root.render(React.createElement(TrapProbe, { open: true })));
  assert.equal(document.activeElement.getAttribute('role'), 'dialog', 'ilk odak pencerededir');

  act(() => root.render(React.createElement(TrapProbe, { open: false })));
  await nextFrame();
  assert.ok(document.activeElement === bell, 'gövde açan sayılmaz; odak yedek açan olan zile döner');
});

test('Pencere içindeki Tab odak tuzağı gövdeye taşındıktan sonra da pencerede kalır', async (t) => {
  const { view, toggle } = mountCenter();
  t.after(() => view.unmount());

  await openNotification(toggle, /Kararınız bekleniyor.*Mehmet Kaya/);
  const dialog = document.querySelector('.schedule-modal-layer [role="dialog"]');
  const focusable = [...dialog.querySelectorAll('button:not([disabled]), textarea:not([disabled])')];
  // Sarma, birbirinden FARKLI iki uç arasında sınanır; tek ögeli liste kendine
  // sarar ve tuzak bozulsa da test geçerdi.
  assert.ok(focusable.length >= 2 && focusable[0] !== focusable.at(-1), 'pencerede birden çok odaklanabilir öge vardır');
  act(() => focusable.at(-1).focus());
  key('Tab');
  assert.ok(document.activeElement === focusable[0], 'son ögeden Tab pencerenin başına sarar');
  key('Tab', document.activeElement, { shiftKey: true });
  assert.ok(document.activeElement === focusable.at(-1), 'ilk ögeden Shift+Tab pencerenin sonuna sarar');
  assert.equal(toggle.contains(document.activeElement), false, 'odak arkadaki üst çubuğa kaçmaz');
});

test('Bölüm dışı atama bildirimi penceresi gövdeye taşınır ve söküldüğünde iz bırakmaz', async (t) => {
  const { view, toggle } = mountCenter();
  // Doğrulama başarısız olsa da kabuk sökülür; sonraki testler temiz DOM'la başlar.
  let mounted = true;
  const unmount = () => { if (mounted) { mounted = false; view.unmount(); } };
  t.after(unmount);

  await openNotification(toggle, /Bölüm dışı atama bildirimi/);
  const layers = modalLayers();
  assert.equal(layers.length, 1);
  assert.ok(layers[0].parentElement === document.body, 'atama koordinasyonu penceresi de gövdededir');
  assert.ok(layers[0].querySelector('.coordination-modal[role="dialog"][aria-modal="true"]'));

  // Pencere açıkken kabuk sökülürse (oturum değişimi, gezinme) portal da sökülür.
  unmount();
  assert.equal(modalLayers().length, 0, 'sahipsiz pencere katmanı kalmaz');
  assert.ok(document.querySelector('.schedule-modal-backdrop') === null, 'sahipsiz arka perde kalmaz');
});

test('Art arda açılıp kapanan bildirim penceresi artık katman bırakmaz', async (t) => {
  const { view, toggle } = mountCenter();
  t.after(() => view.unmount());

  for (const headline of [/Kararınız bekleniyor.*Mehmet Kaya/, /Bölüm dışı atama bildirimi/, /Kararınız bekleniyor.*Mehmet Kaya/]) {
    await openNotification(toggle, headline);
    assert.equal(modalLayers().length, 1, 'her açılışta tek katman bulunur');
    click(button('Kapat', document.querySelector('.schedule-modal-layer')));
    assert.equal(modalLayers().length, 0, 'kapanışta katman kalmaz');
  }
});

test('Görev atama bildirimi kipli pencere açmaz ve görev açma yolunu korur', async (t) => {
  const { view, toggle, calls } = mountCenter();
  t.after(() => view.unmount());

  await openNotification(toggle, /Size görev atandı/);
  assert.deepEqual(calls.openTask, ['task-3'], 'görev olağan yetkili yükleme yolundan açılır');
  assert.equal(modalLayers().length, 0, 'görev bildirimi pencereye dönüştürülmez');
  assert.ok(document.querySelector('.schedule-request-popover') === null, 'görev açıldığında panel kapanır');
});

test('Gövdeye taşınan pencere tema kapsamını ve kök değişkenlerini devralır', async (t) => {
  // Tema, uygulamanın GERÇEK tema yolu (useApplyTweaks) ile uygulanır: sınıf
  // gövdeye, vurgu değişkenleri köke, yazı ölçeği gövdenin `zoom` değerine.
  // Portal hedefi bu kapsamların İÇİNDE olmalıdır.
  function ThemedCenter({ theme }) {
    useApplyTweaks({ theme, accent: '#10b981', density: 'regular', fontScale: 'large' });
    return React.createElement(
      'header',
      { className: 'topbar' },
      React.createElement('div', { className: 'topbar-actions' }, React.createElement(ScheduleRequestCenter, { onNavigate: () => {} }))
    );
  }
  const { state } = notificationState();
  const view = mountDom(ThemedCenter, { theme: 'light' }, state);
  t.after(() => {
    view.unmount();
    document.body.classList.remove('theme-light', 'theme-dark');
    document.body.style.removeProperty('zoom');
    for (const name of ['--accent', '--accent-strong', '--accent-soft', '--accent-fg', '--density']) document.documentElement.style.removeProperty(name);
  });

  await openNotification(view.host.querySelector('.schedule-request-toggle'), /Kararınız bekleniyor.*Mehmet Kaya/);
  const layer = document.querySelector('.schedule-modal-layer');
  assert.ok(layer.closest('.theme-light') === document.body, 'pencere uygulanan açık tema kapsamındadır');
  assert.equal(document.documentElement.style.getPropertyValue('--accent'), '#10b981', 'vurgu değişkeni köktedir; pencere de devralır');
  assert.notEqual(document.body.style.zoom, '', 'yazı ölçeği gövdededir; gövdedeki pencere de ölçeklenir');

  // Tema pencere açıkken değişirse gövdedeki pencere yeni temayı alır.
  view.render({ theme: 'dark' });
  assert.ok(layer.isConnected, 'tema değişimi pencereyi sökmez');
  assert.ok(layer.closest('.theme-dark') === document.body && !document.body.classList.contains('theme-light'), 'pencere koyu tema kapsamına geçer');

  // Pencere biçimleri yalnızca kendi sınıflarına bağlıdır; kabuk veya üst çubuk
  // soyundan seçici (boşluklu ya da `>`/`+`/`~` bitişik birleştiricili) yoktur.
  const selectors = [];
  for (const path of ['src/app/globals.css', 'src/app/styles/shell.css', 'src/app/styles/features.css']) {
    postcss.parse(read(path)).walkRules((rule) => selectors.push(...rule.selectors));
  }
  const scoped = selectors.filter((selector) => /\.(?:topbar|app|main|content|schedule-request-center)\b.*\.(?:schedule-modal|coordination-modal)/.test(selector));
  assert.deepEqual(scoped, [], 'kipli pencere kabuk kapsamına bağlı biçim kullanmaz');
});

/* ── Katman sözleşmesi ──────────────────────────────────────── */

/** Kök yerleşimin içe aktardığı bütün biçim dosyaları ve koşullu yüklenen Bilgin biçimleri. */
function stylesheets() {
  const paths = [...read('src/app/layout.js').matchAll(/^import '\.\/(.+\.css)';$/gm)].map((match) => `src/app/${match[1]}`);
  assert.ok(paths.includes('src/app/globals.css') && paths.includes('src/app/styles/features.css'), 'kök yerleşimin biçim dosyaları bulunur');
  return [...paths, 'src/app/styles/assistant.css'].map((path) => [path, postcss.parse(read(path))]);
}

/**
 * Seçicinin ÖZNESİ (son birleşik seçicisi) sınıfı taşıyor mu? `:has(...)`,
 * `:not(...)` gibi parantez içleri özneyi belirlemez; `.reports-module
 * .workspace-sticky` ya da `.topbar:has(...)` gibi birleşik ve bağlamlı
 * seçiciler de sınıfın öğesine uygulanır.
 */
function targetsClass(selector, className) {
  let flat = selector;
  while (/\([^()]*\)/.test(flat)) flat = flat.replace(/\([^()]*\)/g, '');
  const subject = flat.trim().split(/\s*[\s>+~]\s*/).at(-1);
  return new RegExp(`\\.${className}(?![\\w-])`).test(subject);
}

/**
 * Öznesi sınıf olan HER kuraldaki özellik değerleri: her biçim dosyası, her
 * `@media`/`@supports` koşulu ve her birleşik ya da bağlamlı seçici. Yalnızca
 * kuralın KENDİ bildirimleri alınır; iç içe alt kural seçiciye sayılmaz.
 */
function subjectValues(sheets, className, prop) {
  const values = [];
  for (const [path, root] of sheets) {
    root.walkRules((rule) => {
      if (!rule.selectors.some((selector) => targetsClass(selector, className))) return;
      rule.each((node) => { if (node.type === 'decl' && node.prop === prop) values.push({ at: `${path} · ${rule.selector}`, value: node.value }); });
    });
  }
  return values;
}

/** Tam seçicili koşulsuz kuralın bildirimleri (beklenen kanonik değerler için). */
function declarations(sheets, selector) {
  const merged = {};
  for (const [, root] of sheets) {
    root.walkRules((rule) => {
      for (let parent = rule.parent; parent; parent = parent.parent) if (parent.type === 'atrule') return;
      if (rule.selectors.includes(selector)) rule.each((node) => { if (node.type === 'decl') merged[node.prop] = node.value; });
    });
  }
  return merged;
}

/** `var(--z-*)` ve `calc(var(--z-*) ± n)` katman değerlerini sayıya çevirir. */
function layerValue(value, layers) {
  let number;
  const plain = value.match(/^var\((--z-[\w-]+)\)$/);
  const offset = value.match(/^calc\(var\((--z-[\w-]+)\)\s*([+-])\s*(\d+)\)$/);
  if (plain) number = layers[plain[1]];
  else if (offset) number = layers[offset[1]] + (offset[2] === '+' ? 1 : -1) * Number(offset[3]);
  else number = Number(value);
  // Tanımsız bir `--z-*` belirteci de (undefined/NaN) burada yakalanır.
  assert.ok(Number.isFinite(number), `çözülemeyen katman değeri: ${value}`);
  return number;
}

function layerTokens(sheets) {
  return Object.fromEntries(Object.entries(declarations(sheets, ':root'))
    .filter(([name]) => name.startsWith('--z-'))
    .map(([name, value]) => [name, Number(value)]));
}

test('Yapışkan şeritler ve kabuk katmanları kipli pencerenin arkasında kalır', () => {
  const sheets = stylesheets();
  const layers = layerTokens(sheets);
  const modal = layers['--z-modal'];
  assert.ok(Number.isFinite(modal), 'kipli pencere katmanı tanımlıdır');
  // Pencere içindeki aranabilir seçim panelleri ve ipuçları pencerenin üstünde kalır.
  assert.ok(modal < layers['--z-select-popover'] && layers['--z-select-popover'] < layers['--z-tooltip'], 'kipli pencere aranabilir seçim panellerinin ve ipuçlarının altındadır');

  const values = (className, prop) => subjectValues(sheets, className, prop);
  const every = (entries, predicate, message) => {
    assert.ok(entries.length, `${message}: değer tanımlıdır`);
    for (const { at, value } of entries) assert.ok(predicate(value), `${message} (${at}: ${value})`);
  };

  // Pencere katmanı her koşulda TAM OLARAK `--z-modal` olur: düşürülen pencere
  // şeritlerin altında kalır, yükseltilen pencere seçim panellerini örter.
  every(values('schedule-modal-layer', 'z-index'), (value) => layerValue(value, layers) === modal, 'pencere katmanı --z-modal değerindedir');
  every(values('schedule-modal-layer', 'position'), (value) => value === 'fixed', 'pencere katmanı görünüm alanına sabitlenir');
  assert.equal(declarations(sheets, '.schedule-modal-layer').inset, '0', 'arka perde bütün görünüm alanını kaplar');

  // Perde ve pencere aynı katmanın kardeşleridir; perde DOM'da önce gelir.
  // Konumlu kardeşler katman değeri yoksa DOM sırasıyla boyanır. Perde konumludur;
  // pencere de konumlu olmalı ve perde ondan yüksek bir katman almamalıdır.
  const positioned = new Set(['relative', 'absolute', 'fixed', 'sticky']);
  every(values('schedule-modal-backdrop', 'position'), (value) => value === 'absolute', 'perde katmana göre konumlanır');
  assert.equal(declarations(sheets, '.schedule-modal-backdrop').inset, '0');
  every(values('schedule-modal', 'position'), (value) => positioned.has(value), 'pencere konumludur');
  const backdropLayers = values('schedule-modal-backdrop', 'z-index').map(({ value }) => layerValue(value, layers));
  const dialogLayers = values('schedule-modal', 'z-index').map(({ value }) => layerValue(value, layers));
  // Katman değeri olmayan konumlu öge 0 düzeyinde boyanır; eşitlikte DOM'da sonra
  // gelen pencere üstte kalır.
  const highestBackdrop = backdropLayers.length ? Math.max(...backdropLayers) : 0;
  const lowestDialog = dialogLayers.length ? Math.min(...dialogLayers) : 0;
  assert.ok(highestBackdrop <= lowestDialog, `perde pencerenin üstünde bir katman almaz (perde ${backdropLayers}, pencere ${dialogLayers})`);

  // Bulanıklık hiçbir görünüm alanı koşulunda kapatılmaz.
  every(values('schedule-modal-backdrop', 'backdrop-filter'), (value) => Number(value.match(/^blur\(\s*([\d.]+)px\s*\)$/)?.[1]) > 0, 'arka plan bulanıklaştırılır');
  // Perde, katman ve pencere işaretçi olaylarını yakalar; tıklama arkadaki
  // kenar çubuğuna ya da şeritlere geçmez.
  for (const className of ['schedule-modal-layer', 'schedule-modal-backdrop', 'schedule-modal']) {
    for (const { at, value } of values(className, 'pointer-events')) assert.notEqual(value, 'none', `${at} işaretçi olaylarını geçirmez`);
  }

  // Özet ve Raporlar tarih/bölüm şeridi, Proje Yapısı ve Rapor sekmeleri, kabuk
  // ve alt katmanlar: öznesi bu sınıflar olan HER kural pencerenin altındadır.
  const background = {
    'workspace-sticky': 'yapışkan çalışma alanı şeritleri',
    sidebar: 'kenar çubuğu',
    topbar: 'üst çubuk',
    'drawer-backdrop': 'çekmece perdesi',
    drawer: 'çekmece',
    'rota-assistant': 'Bilgin paneli'
  };
  for (const [className, label] of Object.entries(background)) {
    every(values(className, 'z-index').filter(({ value }) => value !== 'auto'), (value) => layerValue(value, layers) < modal, `${label} kipli pencerenin altındadır`);
  }

  // Kabuk ataları (`html`, `body`, `.app`, `.main`, `.content`) yığılma bağlamı
  // KURMAZ. Böylece uygulama içi yüzeyler ve gövde portalları aynı kök bağlamda
  // yer alır: şeritler perdenin üstüne çıkamaz ve eşit katmandaki iki tuzak
  // yüzeyinin boyama sırası DOM sırasıdır (`useModalFocusTrap` klavye sahipliği
  // bu ön koşula dayanır).
  const contextProps = ['z-index', 'isolation', 'transform', 'filter', 'opacity', 'will-change', 'contain', 'backdrop-filter',
    'mix-blend-mode', 'mask', 'mask-image', 'clip-path', 'perspective', 'container-type'];
  const neutral = new Set(['auto', 'none', 'normal', '1', 'initial', 'unset']);
  const shellAncestors = ['app', 'main', 'content'].map((className) => (selector) => targetsClass(selector, className))
    .concat(['html', 'body'].map((tag) => (selector) => {
      let flat = selector;
      while (/\([^()]*\)/.test(flat)) flat = flat.replace(/\([^()]*\)/g, '');
      return new RegExp(`^${tag}(?![\\w-])`).test(flat.trim().split(/\s*[\s>+~]\s*/).at(-1));
    }));
  for (const [path, root] of sheets) {
    root.walkRules((rule) => {
      if (!rule.selectors.some((selector) => shellAncestors.some((matches) => matches(selector)))) return;
      rule.each((node) => {
        if (node.type === 'decl' && contextProps.includes(node.prop)) {
          assert.ok(neutral.has(node.value), `${path} · ${rule.selector} { ${node.prop}: ${node.value} } kabuk atasında yığılma bağlamı kurar`);
        }
      });
    });
  }

  // Üst çubuk kendi yığılma bağlamını kurar ve katmanı rapor sekmelerinin
  // altındadır: içinde çizilen hiçbir perde şeritleri örtemez. Pencerenin
  // üst çubuktan çıkarılması bu yüzden zorunludur.
  const topbar = declarations(sheets, '.topbar');
  assert.equal(topbar.isolation, 'isolate');
  const reportTabs = declarations(sheets, '.reports-module > .request-tabs.workspace-sticky');
  assert.ok(layerValue(topbar['z-index'], layers) < layerValue(reportTabs['z-index'], layers));
  assert.match(read('src/features/schedule-change/ScheduleRequestCenter.jsx'), /createPortal\(children, document\.body\)/);

  // Şeritlerin yapışkan davranışı korunur; hata katman düşürülerek gizlenmez.
  const sticky = declarations(sheets, '.workspace-sticky');
  assert.equal(sticky.position, 'sticky');
  assert.equal(sticky['z-index'], 'var(--z-chrome)');
  assert.equal(reportTabs['z-index'], 'calc(var(--z-chrome) + 1)');
});

test('Bağlamlı ya da koşullu bir geçersiz kılma da katman denetiminden kaçamaz', () => {
  // Denetimin kendisi sınanır: yalnızca tam seçiciye bakan bir yardımcı bu
  // kuralları kaçırır ve şerit perdenin üstüne çıktığı hâlde test geçerdi.
  const sheets = [['örnek.css', postcss.parse(`
    .reports-module .workspace-sticky { z-index: 999; }
    @media (max-width: 760px) { .schedule-modal-backdrop { backdrop-filter: none; } }
    .app>.sidebar:hover { z-index: 700; }
    .topbar:has(.schedule-request-popover) { z-index: 200; }
    .workspace-sticky-note { z-index: 900; }
    .card:not(.workspace-sticky) { z-index: 800; }
  `)]];
  assert.deepEqual(subjectValues(sheets, 'workspace-sticky', 'z-index').map(({ value }) => value), ['999']);
  assert.deepEqual(subjectValues(sheets, 'schedule-modal-backdrop', 'backdrop-filter').map(({ value }) => value), ['none']);
  assert.deepEqual(subjectValues(sheets, 'sidebar', 'z-index').map(({ value }) => value), ['700']);
  assert.deepEqual(subjectValues(sheets, 'topbar', 'z-index').map(({ value }) => value), ['200']);
});

/**
 * Her odak tuzağı çağıranı ve yüzeyinin katmanı (çağrı sırasıyla): katman
 * belirteci ve bu belirteci taşıyan yüzey sınıfı. Satır içi biçimli yüzeyde
 * sınıf yerine bileşen kaynağındaki `var(--z-*)` aranır.
 */
const TRAP_LAYERS = {
  'src/components/shell/CommandPalette.jsx': [['--z-command', 'cmd-backdrop']],
  'src/components/shell/DataModeChooser.jsx': [['--z-modal', 'mode-picker-backdrop']],
  'src/components/shell/ProjectCreateDialog.jsx': [['--z-modal', null]],
  'src/components/shell/WelcomeScreen.jsx': [['--z-modal', 'welcome-backdrop']],
  'src/features/ai/assistant/RotaAssistant.jsx': [['--z-drawer', 'rota-assistant']],
  'src/features/assignment-coordination/AssignmentCoordinationDialog.jsx': [['--z-modal', 'schedule-modal-layer']],
  'src/features/calendar/CalendarView.jsx': [['--z-modal', 'day-expand-backdrop']],
  'src/features/dashboard/KpiTaskModal.jsx': [['--z-modal', 'schedule-modal-layer']],
  'src/features/schedule-change/ScheduleChangeDialog.jsx': [['--z-modal', 'schedule-modal-layer']],
  'src/features/schedule-change/ScheduleRequestCenter.jsx': [['--z-modal', 'schedule-modal-layer'], ['--z-popover', 'schedule-request-popover']],
  'src/features/system-admin/components/DetailDrawer.jsx': [['--z-drawer', 'drawer']],
  'src/features/task-detail/ReadOnlyTaskDrawer.jsx': [['--z-drawer', 'drawer']],
  'src/features/task-detail/SimpleTaskDrawer.jsx': [['--z-drawer', 'drawer']],
  'src/features/task-detail/TaskDrawer.jsx': [['--z-drawer', 'drawer']],
  'src/features/team/PersonDetailDialog.jsx': [['--z-modal', 'person-dialog-backdrop']]
};

/** Kaynaktaki `useModalFocusTrap(...)` çağrılarının bildirdiği öncelikler (varsayılan 500). */
function trapPriorities(source) {
  const priorities = [];
  for (let index = source.indexOf('useModalFocusTrap('); index >= 0; index = source.indexOf('useModalFocusTrap(', index + 1)) {
    let depth = 0;
    let end = index + 'useModalFocusTrap'.length;
    do {
      if (source[end] === '(') depth += 1;
      else if (source[end] === ')') depth -= 1;
      end += 1;
    } while (depth > 0 && end < source.length);
    // Öncelik sayısal bir sabit olmalıdır: `310 + 1000` gibi bir ifade ya da
    // değişken CSS katmanıyla karşılaştırılamaz ve sözleşmeyi sessizce aşardı.
    const declared = source.slice(index, end).match(/\bpriority:\s*([^,}\n]+)/);
    if (declared) assert.match(declared[1].trim(), /^\d+$/, `öncelik sayısal sabittir: priority: ${declared[1].trim()}`);
    priorities.push(declared ? Number(declared[1]) : 500);
  }
  return priorities;
}

test('Her odak tuzağının önceliği yüzeyinin CSS katmanına eşittir', () => {
  // Klavye sahibi görsel olarak en üstteki tuzaktır; bunun için her tuzağın
  // önceliği yüzeyinin GERÇEK katmanını yansıtmalıdır. Varsayılan 500 ile kalan
  // bir çekmece, üstünü örten Bilgin sayfasının Tab/Esc sahipliğini çalardı.
  const sheets = stylesheets();
  const layers = layerTokens(sheets);
  const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));
  const callers = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.jsx?$/.test(entry.name))
    .map((entry) => `src/${relative(sourceRoot, join(entry.parentPath, entry.name)).split(sep).join('/')}`)
    .filter((path) => path !== 'src/hooks/useModalFocusTrap.js' && read(path).includes('useModalFocusTrap('))
    .sort();
  assert.deepEqual(callers, Object.keys(TRAP_LAYERS).sort(), 'yeni bir tuzak çağıranı katmanını bu tabloya bildirir');

  for (const [path, surfaces] of Object.entries(TRAP_LAYERS)) {
    const source = read(path);
    assert.deepEqual(trapPriorities(source), surfaces.map(([token]) => layers[token]), `${path} tuzak öncelikleri yüzey katmanlarına eşittir`);
    for (const [token, className] of surfaces) {
      if (!className) {
        assert.ok(source.includes(`'var(${token})'`), `${path} satır içi katmanı ${token}`);
        continue;
      }
      assert.match(source, new RegExp(`\\b${className}\\b`), `${path} yüzeyi ${className} sınıfını kullanır`);
      const declared = subjectValues(sheets, className, 'z-index').map(({ value }) => value);
      assert.ok(declared.includes(`var(${token})`), `${className} katmanı ${token} (${declared})`);
    }
  }
});

/* ── Tuzaklar arası klavye ve odak sahipliği ────────────────── */

test('Bildirim penceresi açıkken Bilgin yazma alanına bekleyen odak verilmez', async (t) => {
  const { view, toggle } = mountCenter();
  t.after(() => view.unmount());
  const controller = createAssistantController({ api: {
    loadAssistantReadinessRequest: async () => ({ ok: true, assistant: {
      available: true, modes: [{ id: 'standard', label: 'Standart', available: true }]
    } }),
    listAssistantConversationsRequest: async () => ({ ok: true, conversations: [], nextCursor: null })
  } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(() => { act(() => root.unmount()); host.remove(); controller.dispose(); });
  await controller.activate();

  const assistant = { controller, open: true, actual: true, launcherRef: { current: null }, close() {} };
  const render = (focusRequest) => act(() => root.render(React.createElement(RotaAssistantPanel, {
    assistant: { ...assistant, focusRequest }
  })));
  render(0);
  const panel = host.querySelector('.rota-assistant');
  const composer = panel?.querySelector('textarea');
  assert.ok(composer?.isConnected, 'Bilgin yazma alanı DOM ağacına bağlıdır');

  await openNotification(toggle, /Kararınız bekleniyor.*Mehmet Kaya/);
  const dialog = document.querySelector('.schedule-modal-layer [role="dialog"]');
  assert.ok(dialog?.isConnected && !panel.contains(dialog), 'bildirim penceresi ayrı bir DOM yüzeyidir');
  assert.ok(dialog.contains(document.activeElement), 'ilk odak bildirim penceresindedir');

  // Etkin öge gövdeye düşse de klavye sahipliği açık bildirim penceresindedir.
  act(() => document.activeElement.blur());
  assert.ok(document.activeElement === document.body, 'odak isteği öncesinde etkin öge gövdedir');
  render(1);
  assert.ok(document.activeElement === document.body, 'Bilgin açık pencerenin arkasında odak almaz');

  key('Escape');
  assert.equal(modalLayers().length, 0);
  await nextFrame();
  act(() => document.activeElement.blur());
  render(2);
  assert.ok(document.activeElement === composer, 'pencere kapandıktan sonraki istek yazma alanına odak verir');
});

test('AppShell komut paleti kısayolunu dar Bilgin sayfasında ve odak görünümünde engeller', async (t) => {
  // Node, Next'in uzantısız paket yolunu ve biçim içe aktarmasını kendisi çözmez.
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(specifier === 'next/dynamic' ? 'next/dynamic.js' : specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === new URL('../src/app/styles/assistant.css', import.meta.url).href) {
        return { format: 'module', source: '', shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  });
  let AppShell;
  try {
    ({ default: AppShell } = await import('../src/components/shell/AppShell.jsx'));
    await import('../src/components/shell/AssistantShell.jsx');
  } finally {
    hooks.deregister();
  }

  const preferences = {
    mergen_rota_mode_selected_v1: '1',
    mp_seen_welcome_v2: '1',
    [TWEAKS_STORAGE_KEY]: JSON.stringify({ landingView: 'yardim' }),
    [SIDEBAR_PREFERENCE_KEY]: null
  };
  for (const [name, value] of Object.entries(preferences)) {
    const previous = localStorage.getItem(name);
    if (value === null) localStorage.removeItem(name);
    else localStorage.setItem(name, value);
    t.after(() => previous === null ? localStorage.removeItem(name) : localStorage.setItem(name, previous));
  }
  const media = Object.assign(new window.EventTarget(), { matches: false });
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = (query) => query === ASSISTANT_SHEET_QUERY ? media : { matches: false };
  t.after(() => { window.matchMedia = originalMatchMedia; });

  const { state } = notificationState({ session: { dataMode: 'demo' } });
  const workspace = { mode: 'portfolio', tasks: [], people: [], projects: [], wbs: [] };
  const bodyClass = document.body.className;
  const rootStyle = document.documentElement.style.cssText;
  await act(async () => {
    const view = mountDom(AppShell, {}, { ...state, tasks: workspace.tasks, people: workspace.people,
      projects: workspace.projects, workspace });
    t.after(() => {
      view.unmount();
      document.body.className = bodyClass;
      document.documentElement.style.cssText = rootStyle;
    });
  });
  click(button('Bilgin'));
  const panel = document.querySelector('.rota-assistant');
  const palette = () => document.querySelector('.cmd-panel[role="dialog"]');
  const shortcut = () => key('k', document.activeElement, { ctrlKey: true });

  assert.equal(panel.getAttribute('role'), 'complementary');
  shortcut();
  assert.ok(palette(), 'yerleşik masaüstü paneli açıkken kısayol paleti açar');
  key('Escape');
  assert.ok(!palette(), 'Esc açık paleti kapatır');

  click(button('Odak görünümü', panel));
  assert.equal(panel.getAttribute('aria-modal'), 'true');
  shortcut();
  assert.ok(!palette(), 'masaüstü odak görünümünde kısayol paleti açmaz');
  key('Escape');

  media.matches = true;
  act(() => media.dispatchEvent(new Event('change')));
  assert.ok(panel.matches('.is-sheet[aria-modal="true"]'));
  shortcut();
  assert.ok(!palette(), 'dar ekran sayfasında kısayol paleti açmaz');

  click(button('Bilgin’i kapat', panel));
  assert.ok(!panel.isConnected);
  shortcut();
  assert.ok(palette(), 'Bilgin kapandıktan sonra kısayol yeniden çalışır');
});

/** Alt katmanda (çekmece/Bilgin sayfası) sonradan etkinleşebilen kipli yüzey. */
function LowerSurface({ enabled, onClose }) {
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  useModalFocusTrap({ containerRef, initialFocusRef: inputRef, onClose, enabled, priority: 310 });
  return React.createElement(
    'aside',
    { ref: containerRef, className: 'lower-surface', role: 'dialog', 'aria-modal': enabled ? 'true' : undefined },
    React.createElement('textarea', { ref: inputRef, 'aria-label': 'Yazma alanı' }),
    React.createElement('button', { type: 'button' }, 'Gönder')
  );
}

function mountLowerSurface(t, onClose) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (enabled) => act(() => root.render(React.createElement(LowerSurface, { enabled, onClose })));
  t.after(() => { act(() => root.unmount()); host.remove(); });
  return { host, render };
}

test('Alt katmandaki tuzak sonradan etkinleşse de odak ve Tab/Esc sahipliği üstteki bildirim penceresinde kalır', async (t) => {
  // Bilgin masaüstünde açıkken bildirim penceresi açılır, sonra görünüm daralır
  // ve panel çekmece katmanında kipli sayfaya dönüşür. Panel görsel olarak
  // pencerenin ALTINDADIR; odağı ve klavyeyi de ondan alamaz.
  const { view, toggle } = mountCenter();
  t.after(() => view.unmount());
  const closes = [];
  const lower = mountLowerSurface(t, () => closes.push('alt yüzey'));
  lower.render(false);

  await openNotification(toggle, /Kararınız bekleniyor.*Mehmet Kaya/);
  const dialog = document.querySelector('.schedule-modal-layer [role="dialog"]');
  lower.render(true);
  assert.ok(dialog.contains(document.activeElement), 'etkinleşen alt katman odağı pencereden çalmaz');

  const focusable = [...dialog.querySelectorAll('button:not([disabled]), textarea:not([disabled])')];
  act(() => focusable.at(-1).focus());
  key('Tab');
  assert.ok(document.activeElement === focusable[0], 'Tab üstteki pencerede sarar, arkadaki yüzeye geçmez');

  key('Escape');
  assert.equal(modalLayers().length, 0, 'Esc görünür bildirim penceresini kapatır');
  assert.deepEqual(closes, [], 'arkadaki yüzey Esc ile kapanmaz');

  await nextFrame();
  assert.ok(document.activeElement === lower.host.querySelector('textarea'), 'pencere kapanınca odak zile değil açık kalan yüzeye döner');
  key('Escape');
  assert.deepEqual(closes, ['alt yüzey'], 'Esc sahipliği alt yüzeye geri döner');
});

test('Yönetim çekmecesi açıkken dar Bilgin sayfası klavye sahipliğini alır', async (t) => {
  // Sistem Yönetimi ayrıntı çekmecesi `--z-drawer` katmanındadır. Görünüm daralınca
  // Bilgin aynı katmanda, gövdeye taşınmış (DOM'da sonra gelen) kipli sayfaya
  // dönüşür ve çekmeceyi örter. Klavye görünür sayfaya geçmelidir.
  const closes = [];
  const drawerHost = document.createElement('div');
  document.body.append(drawerHost);
  const drawerRoot = createRoot(drawerHost);
  t.after(() => { act(() => drawerRoot.unmount()); drawerHost.remove(); });
  act(() => drawerRoot.render(React.createElement(DetailDrawer, { title: 'Veritabanı', onClose: () => closes.push('çekmece') },
    React.createElement('p', null, 'Bileşen ayrıntısı'))));
  const drawer = drawerHost.querySelector('.sysadmin-drawer');
  assert.ok(drawer.contains(document.activeElement), 'çekmece açılınca odağı alır');
  assert.equal(hasBlockingModal(), true, 'çekmece komut paletini engellemeyi sürdürür');

  const lower = mountLowerSurface(t, () => closes.push('Bilgin'));
  lower.render(true);
  const textarea = lower.host.querySelector('textarea');
  assert.ok(document.activeElement === textarea, 'çekmeceyi örten Bilgin sayfası odağı alır');
  act(() => lower.host.querySelector('button').focus());
  key('Tab');
  assert.ok(document.activeElement === textarea, 'Tab görünür sayfada sarar, örtülen çekmeceye geçmez');

  key('Escape');
  assert.deepEqual(closes, ['Bilgin'], 'Esc görünür sayfayı kapatır, örtülen çekmeceyi değil');
  lower.render(false);
  await nextFrame();
  assert.ok(drawer.contains(document.activeElement), 'sayfa kapanınca odak açık kalan çekmeceye döner');
  key('Escape');
  assert.deepEqual(closes, ['Bilgin', 'çekmece'], 'Esc sahipliği çekmeceye geri döner');
});

test('Eşit katmanda klavye sahibi DOM sırasında sonra gelen, yani üstte boyanan yüzeydir', async (t) => {
  // Aynı yığılma bağlamında eşit `z-index` taşıyan kardeşler ağaç sırasıyla
  // boyanır. DOM'da sonra gelen yüzey önce açılmış olsa bile üsttedir; sonradan
  // etkinleşen ama altta kalan yüzey odağı ve Tab/Esc sahipliğini alamaz.
  const closes = [];
  const below = mountLowerSurface(t, () => closes.push('alttaki'));
  const above = mountLowerSurface(t, () => closes.push('üstteki'));
  above.render(true);
  const aboveInput = above.host.querySelector('textarea');
  assert.ok(document.activeElement === aboveInput);
  below.render(true);
  assert.ok(document.activeElement === aboveInput, 'altta boyanan yüzey odağı çalmaz');
  key('Escape');
  assert.deepEqual(closes, ['üstteki'], 'Esc üstte boyanan yüzeye aittir');
  above.render(false);
  await nextFrame();
  key('Escape');
  assert.deepEqual(closes, ['üstteki', 'alttaki'], 'üstteki kapanınca sahiplik alttakine geçer');
});

test('Pencere kapanınca açık kalan tuzağın dışında kalan odak o tuzağa geri alınır', async (t) => {
  // Odak pencere açıkken arkadaki bir ögeye taşınmış olabilir. Pencere kapanırken
  // arkada açık bir kipli yüzey varsa odak onun dışında bırakılmaz.
  const lower = mountLowerSurface(t, () => {});
  lower.render(true);
  const outside = document.createElement('button');
  outside.textContent = 'Arka plan';
  document.body.append(outside);
  t.after(() => outside.remove());

  function TrapProbe({ open }) {
    const containerRef = useRef(null);
    useModalFocusTrap({ containerRef, initialFocusRef: containerRef, onClose: () => {}, enabled: open });
    return open ? React.createElement('div', { ref: containerRef, tabIndex: -1, role: 'dialog', 'aria-modal': 'true' }) : null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(() => { act(() => root.unmount()); host.remove(); });
  act(() => root.render(React.createElement(TrapProbe, { open: true })));
  act(() => outside.focus());
  act(() => root.render(React.createElement(TrapProbe, { open: false })));
  await nextFrame();
  assert.ok(lower.host.contains(document.activeElement), 'odak açık kalan kipli yüzeye geri alınır');
});

test('Görevi aç ile açılan görev çekmecesi odağı alır; kapanan pencere odağı zile geri çekmez', async (t) => {
  // "Görevi aç" görevi (çekmece) açar, ardından pencereyi kapatır. Çekmece
  // pencere hâlâ açıkken bağlanır; kapanan pencerenin odak geri vermesi odağı
  // çekmecenin arkasındaki zile taşımamalıdır.
  let lower = null;
  const { view, toggle } = mountCenter({
    actions: {
      ...notificationState().state.actions,
      openTask: async () => { lower.render(true); return { ok: true }; }
    }
  });
  t.after(() => view.unmount());
  lower = mountLowerSurface(t, () => {});
  lower.render(false);

  await openNotification(toggle, /Kararınız bekleniyor.*Mehmet Kaya/);
  await act(async () => { click(button('Görevi aç', document.querySelector('.schedule-modal-layer'))); });
  assert.equal(modalLayers().length, 0, 'görev açılınca pencere kapanır');
  await nextFrame();
  assert.ok(lower.host.contains(document.activeElement), 'odak açılan görev çekmecesindedir');
  assert.ok(document.activeElement !== toggle, 'odak çekmecenin arkasındaki zile taşınmaz');
});

test('Odak alamayan açan atlanır; devre dışı zil yerine açık kalan yüzeye dönülür', async (t) => {
  // Bildirim listesi pencere açıkken boşalırsa zil devre dışı kalır; devre dışı
  // düğmeye `focus()` etkisizdir. Kök öge (`html`) de açan sayılmaz.
  const bell = document.createElement('button');
  bell.disabled = true;
  document.body.append(bell);
  t.after(() => { bell.remove(); document.documentElement.removeAttribute('tabindex'); });
  const lower = mountLowerSurface(t, () => {});
  lower.render(true);
  document.documentElement.tabIndex = -1;
  act(() => document.documentElement.focus());

  function TrapProbe({ open }) {
    const containerRef = useRef(null);
    const restoreFocusRef = useRef(bell);
    useModalFocusTrap({ containerRef, initialFocusRef: containerRef, restoreFocusRef, onClose: () => {}, enabled: open });
    return open ? React.createElement('div', { ref: containerRef, tabIndex: -1, role: 'dialog', 'aria-modal': 'true' }) : null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(() => { act(() => root.unmount()); host.remove(); });
  act(() => root.render(React.createElement(TrapProbe, { open: true })));
  assert.equal(document.activeElement.getAttribute('role'), 'dialog', 'üstteki pencere odağı alır');

  act(() => root.render(React.createElement(TrapProbe, { open: false })));
  await nextFrame();
  assert.ok(document.activeElement !== bell && document.activeElement !== document.documentElement, 'devre dışı zil ve kök öge hedef alınmaz');
  assert.ok(document.activeElement === lower.host.querySelector('textarea'), 'odak açık kalan kipli yüzeye döner');
});

test('Bildirim paneli açıkken etkinleşen üst katman yüzeyi odağı ve Tab/Esc sahipliğini alır', async (t) => {
  // Panel açılır pencere katmanındadır (`--z-popover`); dar ekrana geçişte kipli
  // sayfaya dönüşen Bilgin (çekmece katmanı) onu örter. Klavye görünür sayfaya
  // geçer; sayfa kapanınca odak hâlâ açık olan panele döner.
  const { view, toggle } = mountCenter();
  t.after(() => view.unmount());
  const closes = [];
  const lower = mountLowerSurface(t, () => closes.push('üst yüzey'));
  lower.render(false);

  click(toggle);
  const popover = document.querySelector('.schedule-request-popover');
  assert.ok(popover?.contains(document.activeElement), 'odak açılan bildirim panelindedir');
  lower.render(true);
  assert.ok(document.activeElement === lower.host.querySelector('textarea'), 'paneli örten yüzey odağı alır');

  key('Escape');
  assert.deepEqual(closes, ['üst yüzey'], 'Esc görünür yüzeye aittir');
  assert.ok(document.querySelector('.schedule-request-popover'), 'örtülen bildirim paneli Esc ile kapanmaz');

  lower.render(false);
  await nextFrame();
  assert.ok(document.querySelector('.schedule-request-popover').contains(document.activeElement), 'yüzey kapanınca odak açık panele döner');
});

test('Liste pencere açıkken boşalırsa zil odak alabilir kalır ve odak zile döner', async (t) => {
  // Başka bir sekme son bildirimi temizlerse liste boşalır. Zil devre dışı
  // (`disabled`) olsaydı odak alamaz, kapanışta odak gövdeye düşerdi.
  const { view, toggle, state } = mountCenter();
  t.after(() => view.unmount());

  await openNotification(toggle, /Kararınız bekleniyor.*Mehmet Kaya/);
  Object.assign(state, { scheduleRequests: [], assignmentCoordinations: [], taskNotifications: [] });
  view.render();
  assert.equal(toggle.getAttribute('aria-disabled'), 'true', 'boş listede zil kullanılamaz olarak bildirilir');
  assert.equal(toggle.disabled, false, 'zil odak alabilir kalır');
  assert.equal(modalLayers().length, 1, 'açık pencere listenin boşalmasıyla kapanmaz');

  key('Escape');
  await nextFrame();
  assert.ok(document.activeElement === toggle, 'odak gövdeye değil zile döner');
  click(toggle);
  assert.ok(document.querySelector('.schedule-request-popover') === null, 'boş listede zil paneli açmaz');
});

test('Gizlenen açan atlanır; odak gerçekten geçebilen sonraki yedeğe verilir', async (t) => {
  // Açan öge bağlı kalıp gizlenebilir (`hidden`, `display: none`). Tarayıcı ona
  // odak vermez; aday kabul edilseydi yedek hiç denenmez, odak kökte kalırdı.
  // JSDOM gizli ögeye de odak verdiği için tarayıcı davranışı burada açıkça kurulur.
  const opener = document.createElement('button');
  const fallback = document.createElement('button');
  document.body.append(opener, fallback);
  t.after(() => { opener.remove(); fallback.remove(); });
  act(() => opener.focus());

  function TrapProbe({ open }) {
    const containerRef = useRef(null);
    const restoreFocusRef = useRef(fallback);
    useModalFocusTrap({ containerRef, initialFocusRef: containerRef, restoreFocusRef, onClose: () => {}, enabled: open });
    return open ? React.createElement('div', { ref: containerRef, tabIndex: -1, role: 'dialog', 'aria-modal': 'true' }) : null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(() => { act(() => root.unmount()); host.remove(); });
  act(() => root.render(React.createElement(TrapProbe, { open: true })));

  opener.hidden = true;
  opener.focus = () => {};
  act(() => root.render(React.createElement(TrapProbe, { open: false })));
  await nextFrame();
  assert.ok(document.activeElement === fallback, 'gizli açan atlanır, odak yedeğe geçer');
});
