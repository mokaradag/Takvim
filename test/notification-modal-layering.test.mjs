import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';
import React, { act, useRef } from 'react';
import { button, click, key, mountDom } from './helpers/clientDomHarness.mjs';

const { ScheduleRequestCenter } = await import('../src/features/schedule-change/ScheduleRequestCenter.jsx');
const { useModalFocusTrap } = await import('../src/hooks/useModalFocusTrap.js');
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
  return { view, topbar, toggle, calls };
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
  // Tema sınıfı gövdede, tema değişkenleri kökte uygulanır (bkz. useApplyTweaks).
  // Portal hedefi bu kapsamların İÇİNDE olmalıdır; `.app` gibi bir alt kabuğa
  // bağlı seçici pencereyi biçimlendirmemelidir.
  document.body.classList.add('theme-light');
  t.after(() => document.body.classList.remove('theme-light'));
  const { view, toggle } = mountCenter();
  t.after(() => view.unmount());

  await openNotification(toggle, /Kararınız bekleniyor.*Mehmet Kaya/);
  const layer = document.querySelector('.schedule-modal-layer');
  assert.ok(layer.closest('.theme-light') === document.body, 'pencere gövdedeki tema kapsamındadır');

  const tweaks = read('src/hooks/useApplyTweaks.js');
  assert.match(tweaks, /body\.classList\.toggle\('theme-light'/, 'tema sınıfı gövdeye uygulanır');
  assert.match(tweaks, /const root = document\.documentElement;\s*root\.style\.setProperty\('--accent'/, 'vurgu değişkenleri köke uygulanır');
  assert.match(tweaks, /document\.body\.style\.zoom = zoom/, 'yazı ölçeği gövdeye uygulanır; portal da ölçeklenir');

  // Pencere biçimleri yalnızca kendi sınıflarına bağlıdır; kabuk veya üst çubuk
  // soyundan seçici yoktur, taşıma görünümü değiştirmez.
  const selectors = [];
  for (const path of ['src/app/globals.css', 'src/app/styles/shell.css', 'src/app/styles/features.css']) {
    postcss.parse(read(path)).walkRules((rule) => selectors.push(...rule.selectors));
  }
  const scoped = selectors.filter((selector) => /\.(?:topbar|app|main|schedule-request-center)\b[^,]*\s+[^,]*\.(?:schedule-modal|coordination-modal)/.test(selector));
  assert.deepEqual(scoped, [], 'kipli pencere kabuk kapsamına bağlı biçim kullanmaz');
});

/* ── Katman sözleşmesi ──────────────────────────────────────── */

/** Koşulsuz kurallardan bir seçicinin son bildirimlerini birleştirir. */
function declarations(source, selector) {
  const merged = {};
  postcss.parse(source).walkRules((rule) => {
    if (rule.parent?.type === 'atrule' || !rule.selectors.includes(selector)) return;
    rule.walkDecls((decl) => { merged[decl.prop] = decl.value; });
  });
  return merged;
}

/** `var(--z-*)` ve `calc(var(--z-*) + n)` katman değerlerini sayıya çevirir. */
function layerValue(value, layers) {
  const plain = value.match(/^var\((--z-[\w-]+)\)$/);
  if (plain) return layers[plain[1]];
  const offset = value.match(/^calc\(var\((--z-[\w-]+)\)\s*([+-])\s*(\d+)\)$/);
  if (offset) return layers[offset[1]] + (offset[2] === '+' ? 1 : -1) * Number(offset[3]);
  const number = Number(value);
  assert.ok(Number.isFinite(number), `çözülemeyen katman değeri: ${value}`);
  return number;
}

test('Yapışkan şeritler ve kabuk katmanları kipli pencerenin arkasında kalır', () => {
  const globals = read('src/app/globals.css');
  const shell = read('src/app/styles/shell.css');
  const features = read('src/app/styles/features.css');
  const root = declarations(globals, ':root');
  const layers = Object.fromEntries(Object.entries(root)
    .filter(([name]) => name.startsWith('--z-'))
    .map(([name, value]) => [name, Number(value)]));

  const modalLayer = declarations(features, '.schedule-modal-layer');
  assert.equal(modalLayer.position, 'fixed', 'pencere katmanı görünüm alanına sabitlenir');
  assert.equal(modalLayer.inset, '0', 'arka perde bütün görünüm alanını kaplar');
  assert.equal(modalLayer['z-index'], 'var(--z-modal)', 'merkezi katman sözleşmesi korunur; keyfi büyük değer yoktur');
  const modal = layerValue(modalLayer['z-index'], layers);

  const backdrop = declarations(features, '.schedule-modal-backdrop');
  assert.equal(backdrop.inset, '0');
  assert.match(backdrop['backdrop-filter'], /^blur\(/, 'arka plan bulanıklaştırılır');

  // Özet ve Raporlar tarih/bölüm şeridi, Proje Yapısı ve Rapor sekmeleri.
  const background = {
    'yapışkan çalışma alanı şeridi': declarations(features, '.workspace-sticky')['z-index'],
    'yapışkan rapor sekmeleri': declarations(features, '.reports-module > .request-tabs.workspace-sticky')['z-index'],
    'kenar çubuğu': declarations(shell, '.sidebar')['z-index'],
    'üst çubuk': declarations(shell, '.topbar')['z-index'],
    'bildirim paneli açıkken üst çubuk': declarations(shell, '.topbar:has(.schedule-request-popover)')['z-index'],
    'görev çekmecesi': declarations(features, '.drawer-backdrop')['z-index']
  };
  for (const [label, value] of Object.entries(background)) {
    assert.ok(value, `${label} katmanı tanımlıdır`);
    assert.ok(layerValue(value, layers) < modal, `${label} (${value}) kipli pencerenin altındadır`);
  }

  // Üst çubuk kendi yığılma bağlamını kurar ve katmanı rapor sekmelerinin
  // altındadır: içinde çizilen hiçbir perde şeritleri örtemez. Pencerenin
  // üst çubuktan çıkarılması bu yüzden zorunludur.
  const topbar = declarations(shell, '.topbar');
  assert.equal(topbar.isolation, 'isolate');
  assert.ok(layerValue(topbar['z-index'], layers) < layerValue(background['yapışkan rapor sekmeleri'], layers));
  assert.match(read('src/features/schedule-change/ScheduleRequestCenter.jsx'), /createPortal\(children, document\.body\)/);

  // Şeritlerin yapışkan davranışı korunur; hata katman düşürülerek gizlenmez.
  assert.equal(declarations(features, '.workspace-sticky').position, 'sticky');
  assert.equal(declarations(features, '.workspace-sticky')['z-index'], 'var(--z-chrome)');
  assert.equal(background['yapışkan rapor sekmeleri'], 'calc(var(--z-chrome) + 1)');
});
