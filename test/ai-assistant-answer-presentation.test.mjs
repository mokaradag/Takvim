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
import { findElement, mountComponent } from './helpers/clientComponentHarness.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const { renderBlock } = await import('../src/features/ai/assistant/AssistantMarkdown.jsx');
const { AnswerChart } = await import('../src/features/ai/assistant/AnswerChart.jsx');
const { Tooltip } = await import('../src/components/ui-extras.jsx');
const { RotaAssistantPanel } = await import('../src/features/ai/assistant/RotaAssistant.jsx');
const { createAssistantController } = await import('../src/features/ai/assistant/assistantController.js');
const { answerChartFence } = await import('../src/domain/ai/answerChart.js');
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
  const key = (index, name) => {
    let prevented = false;
    rowAt(index).props.onKeyDown({ key: name, preventDefault: () => { prevented = true; } });
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
  assert.equal(toggle().props['aria-label'], 'Odak görünümüne geç');
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
  assert.equal(toggle().props['aria-label'], 'Odak görünümünden çık');
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
