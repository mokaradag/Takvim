/**
 * Rota AI · doğal yanıtın tarayıcı tarafı.
 *
 * Kanıtlı yanıttaki grafik yalnızca sunucunun doğruladığı kapalı tanımdan ve bu yanıtın kanıtlarına
 * bağlıysa çizilir; aksi hâlde (kanıtsız yanıt ve genel sohbet dâhil) hiç gösterilmez, ham tanım da görünmez.
 * Kopyalanan metin çizimle aynı kuralı izler. Grafik satırları tek sekme durağıdır, ok tuşlarıyla
 * gezilir ve uygulamanın ortak zengin ipucunu kullanır. Masaüstü odak görünümü aynı paneli yeniden
 * kurmadan genişletir: istek yinelenmez, Esc önce odaktan çıkar, dar ekranda ikinci bir tam ekran yoktur.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import ReactDOM from 'react-dom';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { renderToStaticMarkup } from 'react-dom/server';
import { findElement, mountComponent } from './helpers/clientComponentHarness.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const { renderBlock } = await import('../src/features/ai/assistant/AssistantMarkdown.jsx');
const { AnswerChart } = await import('../src/features/ai/assistant/AnswerChart.jsx');
const { Tooltip } = await import('../src/components/ui-extras.jsx');
const { RotaAssistantPanel, useRotaAssistant } = await import('../src/features/ai/assistant/RotaAssistant.jsx');
const { createAssistantController } = await import('../src/features/ai/assistant/assistantController.js');
const { answerChartFence, answerChartValue } = await import('../src/domain/ai/answerChart.js');
const { assistantMarkdownText, parseAssistantMarkdown } = await import('../src/features/ai/assistant/assistantMarkdown.js');
const presentation = await import('../src/features/ai/assistant/assistantPresentation.js');
const { ASSISTANT_STREAM_PHASES } = await import('../src/domain/ai/assistantContract.js');

const SPEC = Object.freeze({ version: 1, type: 'bar', locale: 'tr', title: 'Gecikme (gün)', unit: 'days', evidence: ['R1'],
  items: [{ label: 'Haftalık durum toplantısı', value: 23 }, { label: 'Radar test planı', value: 10 }, { label: 'Kısmi kendi görevim', value: 1 }] });
const answer = (spec = SPEC) => `Şu anda **3** gecikmiş göreviniz var. 【R1】\n\n${answerChartFence(spec)}\n\n_Kaynak:_ 【R1】`;
const chartBlock = (text) => parseAssistantMarkdown(text).find((block) => block.type === 'code');
const named = (name) => (node) => typeof node?.type === 'function' && node.type.name === name;

test('grafik yalnızca geçerli tanım ve bu yanıtın kanıtıyla çizilir; aksi hâlde ham tanım dâhil hiç gösterilmez', () => {
  const block = chartBlock(answer());
  const drawn = renderBlock(block, 'b1', new Set(['R1']));
  assert.equal(drawn.type, AnswerChart);
  assert.deepEqual(drawn.props.spec.items.map((item) => item.value), [23, 10, 1]);
  assert.equal(renderBlock(block, 'b1', new Set(['R2'])), null, 'başka yanıtın kanıtına dayanan grafik çizilmez');
  assert.equal(renderBlock(chartBlock(answer({ ...SPEC, evidence: ['R1', 'R2'] })), 'b1', new Set(['R1'])), null, 'kanıtlardan biri eksikse çizilmez');
  const tampered = chartBlock(answer().replace('"version":1', '"version":1,"color":"red"'));
  assert.equal(renderBlock(tampered, 'b1', new Set(['R1'])), null, 'kapalı tanım dışındaki alan grafiği düşürür');
  const html = chartBlock(answer().replace('Radar test planı', '<img src=x onerror=alert(1)>'));
  const escaped = renderBlock(html, 'b1', new Set(['R1']));
  assert.equal(escaped.type, AnswerChart, 'etiket yalnızca metin düğümüdür');
  assert.equal(escaped.props.spec.items[1].label, '<img src=x onerror=alert(1)>');
  assert.equal(renderBlock(block, 'b1', new Set()), null, 'kanıtsız yanıtta grafik tanımı kod olarak da görünmez');
  assert.equal(renderBlock(block, 'b1'), null, 'genel sohbette grafik tanımı kod olarak da görünmez');
  assert.equal(renderBlock(chartBlock('```rota-chart\n{bozuk\n```'), 'b1', new Set(['R1'])), null, 'çözülemeyen tanım kod olarak görünmez');
  assert.equal(renderBlock(chartBlock('```js\nconst a = 1;\n```'), 'b1').type.name, 'CodeBlock', 'diğer kod blokları değişmez');
});

test('kopyalanan metin grafiği çizimle aynı kuralla düz veri olarak taşır', () => {
  const evidenceIds = new Set(['R1']);
  assert.equal(assistantMarkdownText(answer(), { evidenceIds }),
    'Şu anda 3 gecikmiş göreviniz var. [R1]\n\nGecikme (gün)\nHaftalık durum toplantısı\t23 gün\nRadar test planı\t10 gün\nKısmi kendi görevim\t1 gün\n\nKaynak: [R1]');
  assert.equal(assistantMarkdownText(answer(), { evidenceIds: new Set(['R9']) }), 'Şu anda 3 gecikmiş göreviniz var. [R1]\n\nKaynak: [R1]', 'çizilmeyen grafik kopyalanmaz');
  assert.equal(assistantMarkdownText(answer()), 'Şu anda 3 gecikmiş göreviniz var. [R1]\n\nKaynak: [R1]', 'kanıtsız yanıtta grafik tanımı kopyalanmaz');
  assert.equal(assistantMarkdownText(answer(), { evidenceIds: new Set() }), 'Şu anda 3 gecikmiş göreviniz var. [R1]\n\nKaynak: [R1]');
});

test('grafik: başlık, kayıt sayısı ve kaynak; çubuk oranı en büyük değere göre; yalnız tema sıra sınıfları', () => {
  const chart = mountComponent(AnswerChart, { spec: SPEC });
  const figure = chart.output;
  assert.equal(figure.type, 'figure');
  assert.equal(figure.props['aria-label'], 'Gecikme (gün)');
  const caption = findElement(figure, (node) => node.props?.className === 'assistant-chart-meta');
  assert.equal(caption.props.children, '3 değer · Kaynak R1');
  const barElement = findElement(figure, named('BarChart'));
  const bars = mountComponent(barElement.type, barElement.props);
  const rows = bars.output.props.children.map((item) => item.props.children);
  assert.ok(rows.every((tooltip) => tooltip.type === Tooltip && tooltip.props.asChild));
  const fills = rows.map((tooltip) => findElement(tooltip.props.children, (node) => node.props?.className === 'assistant-chart-fill').props.style['--chart-ratio']);
  assert.deepEqual(fills.map((ratio) => Math.round(ratio * 1000) / 1000), [1, 0.435, 0.043]);
  assert.equal(JSON.stringify(bars.output).includes('#'), false, 'tanım renk taşımaz; renk tema sınıfındadır');
});

test('grafik satırları tek sekme durağıdır; ok, Home ve End tuşlarıyla gezilir ve ipucu işleyicileriyle birlikte çalışır', () => {
  const barElement = findElement(mountComponent(AnswerChart, { spec: SPEC }).output, named('BarChart'));
  const bars = mountComponent(barElement.type, barElement.props);
  const focused = [];
  const nodes = SPEC.items.map((_, index) => ({ focus: () => focused.push(index) }));
  const rowAt = (index) => bars.output.props.children[index].props.children.props.children;
  SPEC.items.forEach((_, index) => rowAt(index).ref(nodes[index]));
  assert.deepEqual(SPEC.items.map((_, index) => rowAt(index).props.tabIndex), [0, -1, -1]);
  const key = (index, name, modifiers = {}) => {
    let prevented = false;
    rowAt(index).props.onKeyDown({ key: name, ...modifiers, preventDefault: () => { prevented = true; } });
    bars.render();
    return prevented;
  };
  assert.equal(key(0, 'ArrowDown'), true);
  assert.deepEqual(SPEC.items.map((_, index) => rowAt(index).props.tabIndex), [-1, 0, -1]);
  key(1, 'End');
  key(2, 'ArrowDown');
  key(2, 'Home');
  assert.deepEqual(focused, [1, 2, 2, 0], 'sınırda kalır');
  assert.equal(key(0, 'a'), false, 'başka tuş tüketilmez');
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
    for (const name of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End']) {
      assert.equal(key(0, name, { [modifier]: true }), false);
    }
  }
  assert.deepEqual(focused, [1, 2, 2, 0], 'değiştiricili kısayollar odağı taşımaz');
  // Ortak ipucu çocuğun kendi işleyicilerini ezmez: odak ve tuş olayları ikisine de ulaşır.
  const seen = [];
  const tooltip = mountComponent(Tooltip, { asChild: true, content: 'İpucu', children: React.createElement('div', { onFocus: () => seen.push('focus'), onKeyDown: (event) => seen.push(event.key) }) });
  const child = tooltip.output.props.children[0];
  child.props.onFocus({ currentTarget: {} });
  child.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  assert.deepEqual(seen, ['focus', 'ArrowDown']);
  tooltip.unmount();
});

test('halka diliminin ayrıntısı dokunuşla da açılır: dilim açıklamadaki karşılığını odaklar', () => {
  const spec = { ...SPEC, type: 'donut', unit: 'count', title: 'Görev sayısı', items: [{ label: 'Yapılacak', value: 5 }, { label: 'Tamamlandı', value: 2 }, { label: 'Devam ediyor', value: 1 }] };
  const donutElement = findElement(mountComponent(AnswerChart, { spec }).output, named('DonutChart'));
  const donut = mountComponent(donutElement.type, donutElement.props);
  const legend = (index) => findElement(donut.output, (node) => node.props?.className?.startsWith?.('assistant-chart-legend-item') && node.props['aria-label']?.startsWith(spec.items[index].label));
  const focused = [];
  spec.items.forEach((_, index) => legend(index).ref({ focus: () => focused.push(index) }));
  const slices = findElement(donut.output, (node) => node.props?.className === 'assistant-chart-slices').props.children;
  slices[1].props.children.props.onClick();
  assert.deepEqual(focused, [1]);
});

test('çizilmiş çubuk ve halka açıklamaları adlandırılabilen grupta doğrulanmış etiket ve değeri sunar', () => {
  for (const type of ['bar', 'donut']) {
    const html = renderToStaticMarkup(React.createElement(AnswerChart, { spec: { ...SPEC, type } }));
    assert.match(html, /role="group"[^>]*aria-label="Haftalık durum toplantısı: 23 gün"/);
    assert.match(html, /role="group"[^>]*aria-label="Radar test planı: 10 gün"/);
    assert.match(html, /class="assistant-chart-value" aria-hidden="true">23 gün/);
    if (type === 'donut') assert.match(html, /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
  }
});

test('düzen evresi kullanıcıya "Yanıt yazılıyor" olarak gösterilir', () => {
  assert.equal(ASSISTANT_STREAM_PHASES.COMPOSING, 'composing');
  assert.equal(presentation.generationPhaseLabel(ASSISTANT_STREAM_PHASES.COMPOSING), 'Yanıt yazılıyor…');
});

/* ── Odak görünümü ─────────────────────────────────────────── */

const READINESS = Object.freeze({ available: true, reason: null, credentialSource: 'default',
  modes: [{ id: 'standard', label: 'Standart', available: true }, { id: 'deep', label: 'Derin düşünme', available: true }],
  limits: { maxMessageChars: 8000, maxConversationMessages: 100 } });

async function panelController() {
  const turns = [];
  const api = {
    loadAssistantReadinessRequest: async () => ({ ok: true, assistant: READINESS }),
    listAssistantConversationsRequest: async () => ({ ok: true, conversations: [], nextCursor: null }),
    loadAssistantConversationRequest: async (id) => ({ ok: true, conversation: { id, title: 'Konuşma' }, messages: [] }),
    deleteAssistantConversationRequest: async () => ({ ok: true, deleted: true }),
    streamAssistantTurnRequest: (input) => { turns.push(input); return new Promise(() => {}); }
  };
  let id = 0;
  const controller = createAssistantController({ api, createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`, reconciliationDelaysMs: [], schedule: () => () => {} });
  await controller.activate();
  return { controller, turns };
}

function browserDouble(t, { narrow = false } = {}) {
  const saved = { window: globalThis.window, document: globalThis.document, MutationObserver: globalThis.MutationObserver };
  const windowEvents = new EventTarget();
  windowEvents.matchMedia = () => ({ matches: narrow, addEventListener() {}, removeEventListener() {} });
  const documentListeners = [];
  globalThis.window = windowEvents;
  globalThis.document = { body: { classList: { contains: () => false } }, activeElement: null,
    addEventListener: (type, fn) => documentListeners.push({ type, fn }),
    removeEventListener: (type, fn) => { const index = documentListeners.findIndex((item) => item.type === type && item.fn === fn); if (index >= 0) documentListeners.splice(index, 1); } };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  t.after(() => Object.assign(globalThis, saved));
  const escape = () => Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
  return {
    pressDocumentKey(key) { const event = Object.assign(new Event('keydown', { cancelable: true }), { key }); for (const { fn } of documentListeners.filter((item) => item.type === 'keydown')) fn(event); return event; },
    pressDocumentEscape() { const event = escape(); for (const { fn } of documentListeners.filter((item) => item.type === 'keydown')) fn(event); return event; },
    pressWindowEscape() { windowEvents.dispatchEvent(escape()); }
  };
}

test('odak görünümü aynı paneli kipli tam görünüme genişletir; konuşma ve süren yanıt korunur, istek yinelenmez', async (t) => {
  const browser = browserDouble(t);
  const { controller, turns } = await panelController();
  let focused = false;
  let closed = 0;
  const assistant = () => ({ controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close: () => { closed += 1; },
    focused, setFocused: (value) => { focused = value; } });
  const panel = mountComponent(RotaAssistantPanel, { assistant: assistant() });
  const aside = () => findElement(panel.output, (node) => node.type === 'aside');
  const toggle = () => findElement(panel.output, (node) => typeof node.props?.className === 'string' && node.props.className.includes('rota-assistant-focus-toggle'));
  assert.equal(toggle().props['aria-pressed'], false);
  assert.equal(toggle().props['aria-label'], 'Odak görünümü');
  assert.equal(aside().props.role, 'complementary');

  controller.send('Geciken görevlerimi göster');
  assert.equal(turns.length, 1);
  const running = controller.getState().running;
  toggle().props.onClick();
  assert.equal(focused, true);
  panel.render({ assistant: assistant() });
  assert.match(aside().props.className, /\bis-focused\b/);
  assert.equal(aside().props.role, 'dialog');
  assert.equal(aside().props['aria-modal'], 'true');
  assert.equal(toggle().props['aria-pressed'], true);
  assert.equal(toggle().props['aria-label'], 'Odak görünümü');
  assert.equal(turns.length, 1, 'genişletme yeni istek göndermez');
  assert.deepEqual(controller.getState().running, running, 'süren yanıt aynı yanıttır');

  // Esc katmanlıdır: önce odak görünümünden çıkar, panel açık kalır; ikinci Esc paneli kapatır.
  const event = browser.pressDocumentEscape();
  assert.equal(event.defaultPrevented, true);
  assert.equal(focused, false);
  assert.equal(closed, 0);
  panel.render({ assistant: assistant() });
  assert.doesNotMatch(aside().props.className, /\bis-focused\b/);
  assert.equal(aside().props.role, 'complementary');
  browser.pressWindowEscape();
  assert.equal(closed, 1);
  assert.equal(turns.length, 1);
  panel.unmount();
});

test('odak kipinden Esc yazma odağı ve imleci korur; yan panelde Tab serbesttir, ikinci Esc gerçek başlatıcıya döner', async (t) => {
  const browser = browserDouble(t);
  const savedFrame = globalThis.requestAnimationFrame;
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  t.after(() => { globalThis.requestAnimationFrame = savedFrame; });
  const flushFrames = () => { while (frames.length) frames.shift()(); };
  const node = () => ({ isConnected: true, disabled: false, offsetParent: {}, focus() { document.activeElement = this; } });
  const launcher = node();
  const composer = { ...node(), selectionStart: 4, selectionEnd: 4 };
  const control = node();
  const owner = { contains: (item) => [composer, control].includes(item), setAttribute() {}, removeAttribute() {}, querySelectorAll: () => [control, composer] };
  const { controller } = await panelController();
  const hook = mountComponent(useRotaAssistant, {});
  hook.output.launcherRef.current = launcher;
  launcher.focus();
  hook.output.openPanel();
  hook.render();
  const assistant = () => ({ ...hook.output, controller, actual: true });
  const panel = mountComponent(RotaAssistantPanel, { assistant: assistant() });
  const aside = findElement(panel.output, (item) => item.type === 'aside');
  aside.ref.current = owner;
  findElement(panel.output, named('AssistantComposer')).props.inputRef.current = composer;
  composer.focus();
  hook.output.setFocused(true);
  hook.render();
  panel.render({ assistant: assistant() });
  assert.equal(document.activeElement, composer);
  assert.equal(browser.pressDocumentEscape().defaultPrevented, true);
  hook.render();
  panel.render({ assistant: assistant() });
  flushFrames();
  assert.equal(hook.output.open, true);
  assert.equal(hook.output.focused, false);
  assert.equal(findElement(panel.output, (item) => item.type === 'aside').props.role, 'complementary');
  assert.equal(document.activeElement, composer);
  assert.deepEqual([composer.selectionStart, composer.selectionEnd], [4, 4]);
  assert.equal(browser.pressDocumentKey('Tab').defaultPrevented, false, 'kapanan kipin odak tuzağı kalmaz');
  control.focus();
  assert.equal(owner.contains(document.activeElement), true, 'panelin diğer kontrolü hâlâ odaklanabilir');
  browser.pressWindowEscape();
  hook.render();
  panel.render({ assistant: assistant() });
  flushFrames();
  assert.equal(hook.output.open, false);
  assert.equal(panel.output, null);
  assert.equal(document.activeElement, launcher, 'üretimdeki close başlatıcıya odağı geri verir');
  panel.unmount();
  hook.unmount();
});

test('dar ekranda panel zaten tam ekran sayfadır: odak düğmesi yoktur ve odak durumu yok sayılır', async (t) => {
  browserDouble(t, { narrow: true });
  const { controller } = await panelController();
  const panel = mountComponent(RotaAssistantPanel, { assistant: { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() {}, focused: true, setFocused() {} } });
  const aside = findElement(panel.output, (node) => node.type === 'aside');
  assert.match(aside.props.className, /\bis-sheet\b/);
  assert.doesNotMatch(aside.props.className, /\bis-focused\b/);
  assert.equal(findElement(panel.output, (node) => typeof node.props?.className === 'string' && node.props.className.includes('rota-assistant-focus-toggle')), null);
  panel.unmount();
});


test('küçük doğrulanmış grafik değeri görünür etiket, ipucu, erişilebilir ad ve kopyada aynıdır', () => {
  for (const locale of ['tr', 'en']) {
    const value = locale === 'tr' ? '0,001 gün' : '0.001 days';
    const spec = { ...SPEC, locale, items: [{ label: 'Küçük değer', value: 0.001 }, { label: 'Sıfır', value: 0 }] };
    assert.equal(answerChartValue(0.001, 'days', locale), value);
    const markup = renderToStaticMarkup(React.createElement(AnswerChart, { spec }));
    assert.ok(markup.includes(`aria-label="Küçük değer: ${value}"`));
    assert.ok(markup.includes(`aria-hidden="true">${value}</span>`));
    const bar = findElement(mountComponent(AnswerChart, { spec }).output, named('BarChart'));
    const bars = mountComponent(bar.type, bar.props);
    const tooltip = bars.output.props.children[0].props.children;
    assert.ok(renderToStaticMarkup(tooltip.props.content).includes(`class="rt-val">${value}</span>`));
    assert.ok(assistantMarkdownText(answer(spec), { evidenceIds: new Set(['R1']) }).includes(`Küçük değer\t${value}`));
  }
});

test('grafik sayı hassasiyeti sıfır sınırını korur ve kayan nokta gürültüsünü göstermez', () => {
  for (const [input, expected] of [[0, '0'], [-0, '-0'], [0.001, '0.001'], [0.0049, '0.0049'], [0.005, '0.005'],
    [0.00999, '0.00999'], [0.01, '0.01'], [0.1 + 0.2, '0.3'], [1e-7, '1E-7'], [Number.MIN_VALUE, '5E-324']]) {
    assert.equal(answerChartValue(input, 'number', 'en'), expected);
  }
  for (const value of [Number.MIN_VALUE, 1e-100, 1e-8, 0.000001, 0.000999, 0.004999, 0.005001]) {
    assert.notEqual(answerChartValue(value, 'number', 'en'), '0');
    assert.notEqual(answerChartValue(value, 'number', 'tr'), '0');
  }
  assert.equal(answerChartValue(1234, 'count', 'tr'), '1.234');
  assert.equal(answerChartValue(1234, 'count', 'en'), '1,234');
  assert.equal(answerChartValue(0.001, 'percent', 'tr'), '%0,001');
  assert.equal(answerChartValue(0.001, 'hours', 'en'), '0.001 h');
  const spec = { ...SPEC, type: 'donut', unit: 'count', items: [{ label: 'Küçük pay', value: 1 }, { label: 'Kalan', value: 999999 }] };
  const donut = findElement(mountComponent(AnswerChart, { spec }).output, named('DonutChart'));
  const slices = mountComponent(donut.type, donut.props);
  const tooltip = findElement(slices.output, (node) => node.type === Tooltip && node.props.title === 'Küçük pay');
  const content = renderToStaticMarkup(tooltip.props.content);
  assert.ok(content.includes('class="rt-val">%0,0001</span>'), 'küçük pozitif pay da sıfır gösterilmez');
  assert.ok(content.includes('width:0.00009999999999999999%'), content);
});

test('iki azaltılmış hareket yolu grafik animasyonunu kapatır; temel grafik durumu görünürdür', () => {
  const root = postcss.parse(readFileSync(new URL('../src/app/styles/assistant.css', import.meta.url), 'utf8'));
  const base = root.nodes.find((node) => node.type === 'rule' && node.selector === '.assistant-chart-slices');
  assert.ok(base, 'dilim grubunun temel kuralı');
  assert.equal(base.nodes.some((node) => node.prop === 'opacity' && Number(node.value) < 1), false, 'animasyon olmadan SVG varsayılanı görünür kalır');
  const media = root.nodes.find((node) => node.type === 'atrule' && node.name === 'media' && node.params === '(prefers-reduced-motion: reduce)');
  const disables = (rule) => rule.nodes.some((node) => node.prop === 'animation' && node.value === 'none' && node.important);
  assert.ok(media.nodes.some((node) => node.type === 'rule' && node.selectors.includes('.rota-assistant *') && disables(node)));
  assert.ok(root.nodes.some((node) => node.type === 'rule' && node.selectors.includes('body.reduce-motion .rota-assistant *') && disables(node)));
  for (const selector of ['.assistant-chart-fill', '.assistant-chart-slices']) {
    const rule = root.nodes.find((node) => node.type === 'rule' && node.selector === selector);
    assert.equal(rule.nodes.some((node) => node.prop === 'opacity' && Number(node.value) === 0 || node.prop === 'transform' && node.value.includes('scaleX(0)')), false, selector);
  }
});

test('grafik başlığının dar kutuda bölünmesi ve üstbilginin sarılması CSS sözleşmesidir', () => {
  const root = postcss.parse(readFileSync(new URL('../src/app/styles/assistant.css', import.meta.url), 'utf8'));
  const declarations = (selector) => Object.fromEntries(root.nodes.find((node) => node.type === 'rule' && node.selector === selector).nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]));
  assert.equal(declarations('.assistant-chart-head')['flex-wrap'], 'wrap');
  const title = declarations('.assistant-chart-title');
  assert.equal(title['min-width'], '0');
  assert.equal(title['overflow-wrap'], 'anywhere');
  const meta = declarations('.assistant-chart-meta');
  assert.equal(meta['min-width'], '0');
  assert.equal(meta['overflow-wrap'], 'anywhere');
  assert.notEqual(meta['white-space'], 'nowrap');
  const spec = { ...SPEC, title: 'X'.repeat(80) };
  assert.ok(answerChartFence(spec), 'geçerli başlık sınırı daraltılmadı');
  assert.ok(renderToStaticMarkup(React.createElement(AnswerChart, { spec })).includes(spec.title));
});


test('dilimden gerçek açıklama odağına geçiş yalnızca açıklama ipucunu açık tutar', (t) => {
  browserDouble(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(ReactDOM, 'createPortal', (content) => content);
  const spec = { ...SPEC, type: 'donut', unit: 'count' };
  const element = findElement(mountComponent(AnswerChart, { spec }).output, named('DonutChart'));
  const donut = mountComponent(element.type, element.props);
  const sliceElement = () => findElement(donut.output, (node) => node.type === Tooltip && node.props.children.type === 'path');
  const legendElement = () => findElement(donut.output, (node) => node.type === Tooltip && node.props.children.props.className.startsWith('assistant-chart-legend-item'));
  const slice = mountComponent(Tooltip, sliceElement().props);
  const legend = mountComponent(Tooltip, legendElement().props);
  const child = (tip) => tip.output.props.children[0];
  const node = { focus() { document.activeElement = this; child(legend).props.onFocus({ currentTarget: this }); } };
  legendElement().props.children.ref(node);
  child(slice).props.onMouseEnter({ clientX: 20, clientY: 20 });
  slice.render();
  t.mock.timers.tick(100);
  slice.render();
  assert.ok(findElement(slice.output, (item) => item.props?.className === 'rich-tip'));
  child(slice).props.onClick();
  donut.render();
  slice.render(sliceElement().props);
  legend.render(legendElement().props);
  t.mock.timers.tick(100);
  slice.render();
  legend.render();
  assert.equal(document.activeElement, node, 'gerçek odak aktarımı korunur');
  assert.equal(findElement(slice.output, (item) => item.props?.className === 'rich-tip'), null);
  const portal = findElement(legend.output, (item) => item.props?.role === 'tooltip');
  assert.ok(portal);
  assert.equal(child(legend).props['aria-describedby'], portal.props.id);
  assert.equal(child(slice).props['aria-describedby'], undefined);
  child(legend).props.onKeyDown({ key: 'Escape', preventDefault() {} });
  legend.render();
  assert.equal(findElement(legend.output, (item) => item.props?.className === 'rich-tip'), null);
  assert.equal(child(legend).props['aria-describedby'], undefined);
  child(legend).props.onBlur();
  donut.render();
  slice.render(sliceElement().props);
  t.mock.timers.tick(100);
  slice.render();
  assert.ok(findElement(slice.output, (item) => item.props?.className === 'rich-tip'), 'odak ayrılınca fare ipucu yeni enter olmadan açılır');
  assert.ok(sliceElement().props.children.props.className.includes('is-active'), 'süren fare temasının vurgusu geri gelir');
  slice.unmount(); legend.unmount(); donut.unmount();
});


test('halka açıklamasında fare ve klavye aynı dilimi ve tek ipucunu etkinleştirir', (t) => {
  browserDouble(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(ReactDOM, 'createPortal', (content) => content);
  const spec = { ...SPEC, type: 'donut', unit: 'count' };
  const element = findElement(mountComponent(AnswerChart, { spec }).output, named('DonutChart'));
  const donut = mountComponent(element.type, element.props);
  const sliceElements = () => findElement(donut.output, (node) => node.props?.className === 'assistant-chart-slices').props.children;
  const legendElements = () => findElement(donut.output, (node) => node.props?.className === 'assistant-chart-legend').props.children.map((item) => item.props.children);
  const slices = sliceElements().map((item) => mountComponent(Tooltip, item.props));
  const legends = legendElements().map((item) => mountComponent(Tooltip, item.props));
  t.after(() => { for (const component of [...slices, ...legends, donut]) component.unmount(); });
  const child = (tip) => tip.output.props.children[0];
  const nodes = legends.map((tip) => ({ focus() { document.activeElement = this; child(tip).props.onFocus({ currentTarget: this }); } }));
  legendElements().forEach((item, index) => item.props.children.ref(nodes[index]));
  const settle = () => {
    donut.render();
    slices.forEach((tip, index) => tip.render(sliceElements()[index].props));
    legends.forEach((tip, index) => tip.render(legendElements()[index].props));
    t.mock.timers.tick(100);
    for (const tip of [...slices, ...legends]) tip.render();
  };
  const assertActive = (index) => {
    assert.deepEqual(sliceElements().map((item) => item.props.children.props.className.includes('is-active')), spec.items.map((_, i) => i === index));
    assert.deepEqual(legendElements().map((item) => item.props.children.props.className.includes('is-active')), spec.items.map((_, i) => i === index));
    const open = [...slices, ...legends].filter((tip) => findElement(tip.output, (node) => node.props?.role === 'tooltip'));
    assert.equal(open.length, 1, 'yalnız etkin öğenin ipucu görünür');
    assert.equal(open[0], legends[index]);
    assert.ok(child(legends[index]).props['aria-describedby']);
  };
  nodes[0].focus(); settle(); assertActive(0);
  child(legends[1]).props.onMouseEnter({ clientX: 40, clientY: 40 });
  settle(); assertActive(1);
  assert.equal(document.activeElement, nodes[0], 'fare odağı taşımaz');
  child(legends[1]).props.onMouseLeave();
  settle(); assertActive(0);
  child(legends[2]).props.onMouseEnter({ clientX: 50, clientY: 50 });
  settle(); assertActive(2);
  child(legends[0]).props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  settle(); assertActive(1);
  assert.equal(document.activeElement, nodes[1], 'ok tuşu fare teması sürerken de odağı ve ipucunu taşır');
});

test('ipucu açıklama bağı odak, fare, Escape ve devre dışı durumu ile eşleşir', (t) => {
  browserDouble(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(ReactDOM, 'createPortal', (content) => content);
  const props = { asChild: true, content: 'Pay ve kaynak', children: React.createElement('div', { 'aria-describedby': 'existing-description' }) };
  const tip = mountComponent(Tooltip, props);
  const trigger = () => tip.output.props.children[0];
  const portal = () => findElement(tip.output, (node) => node.props?.role === 'tooltip');
  const open = () => { tip.render(); t.mock.timers.tick(100); tip.render(); };
  assert.equal(trigger().props['aria-describedby'], 'existing-description');
  trigger().props.onFocus({ currentTarget: {} });
  open();
  const id = portal().props.id;
  assert.ok(id);
  assert.equal(trigger().props['aria-describedby'], `existing-description ${id}`);
  trigger().props.onMouseEnter({ clientX: 12, clientY: 15 });
  tip.render();
  trigger().props.onMouseLeave();
  tip.render();
  assert.equal(portal().props.id, id, 'fare ayrılması odağın açıklamasını kapatmaz');
  let prevented = false;
  trigger().props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true; } });
  tip.render();
  t.mock.timers.tick(100);
  tip.render();
  assert.equal(prevented, true);
  assert.equal(portal(), null);
  assert.equal(trigger().props['aria-describedby'], 'existing-description');
  trigger().props.onBlur(); tip.render();
  trigger().props.onFocus({ currentTarget: {} }); open();
  assert.equal(portal().props.id, id, 'yeniden açılınca kimlik değişmez');
  trigger().props.onBlur(); tip.render();
  trigger().props.onMouseEnter({ clientX: 12, clientY: 15 }); open();
  tip.render({ ...props, disabled: true });
  assert.equal(portal(), null);
  assert.equal(trigger().props['aria-describedby'], 'existing-description');
  tip.render(props); open();
  assert.equal(portal().props.id, id, 'süren fare teması yeni enter olmadan geri gelir');
  tip.render({ ...props, disabled: true });
  trigger().props.onMouseLeave(); tip.render({ ...props, disabled: true });
  tip.render(props); open();
  assert.equal(portal(), null, 'devre dışıyken ayrılan fare hayalet ipucu açmaz');
  tip.unmount();
});

test('gün birimi yerelleştirmesi etiket, ipucu, erişilebilir ad ve kopyada tutarlıdır', () => {
  for (const [locale, expected] of [['en', ['0 days', '1 day', '2 days']], ['tr', ['0 gün', '1 gün', '2 gün']]]) {
    const spec = { ...SPEC, locale, items: [0, 1, 2].map((value) => ({ label: `Item ${value}`, value })) };
    assert.deepEqual(spec.items.map((item) => answerChartValue(item.value, 'days', locale)), expected);
    const markup = renderToStaticMarkup(React.createElement(AnswerChart, { spec }));
    const copied = assistantMarkdownText(answer(spec), { evidenceIds: new Set(['R1']) });
    const barElement = findElement(mountComponent(AnswerChart, { spec }).output, named('BarChart'));
    const bars = mountComponent(barElement.type, barElement.props);
    for (const [index, value] of expected.entries()) {
      assert.ok(markup.includes(`aria-label="Item ${index}: ${value}"`));
      assert.ok(markup.includes(`aria-hidden="true">${value}</span>`));
      assert.ok(copied.split('\n').includes(`Item ${index}\t${value}`));
      const tooltip = bars.output.props.children[index].props.children;
      assert.ok(renderToStaticMarkup(tooltip.props.content).includes(`class="rt-val">${value}</span>`));
    }
  }
});
