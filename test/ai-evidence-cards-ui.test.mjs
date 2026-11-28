/**
 * Bilgin etkileşimli kanıt kartları (ICE-1) · tarayıcı etkileşimi (JSDOM, gerçek React).
 *
 * Sınananlar: klavyeyle açma ve odağın karta taşınması, Esc ile kapanma ve odağın tetikleyiciye dönmesi, dış kaydırma ve
 * dış tıklamayla kapanma, görev satırının mevcut görev açma sözleşmesini görev kimliğiyle çağırması, kısmi önizleme ve
 * farklı sorumluların gösterilmesi, süresi dolan kartın sade metne dönmesi ve `HoverListCard`'ın mevcut kullanımının
 * (Özet) değişmemesi.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { click, key, mountDom } from './helpers/clientDomHarness.mjs';

const { EvidenceReference, EvidenceCardActionsContext } = await import('../src/features/ai/assistant/EvidenceCard.jsx');
const { AssistantMarkdown } = await import('../src/features/ai/assistant/AssistantMarkdown.jsx');
const { RotaAssistantPanel } = await import('../src/features/ai/assistant/RotaAssistant.jsx');
const { createAssistantController } = await import('../src/features/ai/assistant/assistantController.js');
const { useModalFocusTrap } = await import('../src/hooks/useModalFocusTrap.js');
const { HoverListCard } = await import('../src/components/ui-extras.jsx');
const { EVIDENCE_CARD_LIMITS, EVIDENCE_CARD_VERSION, normalizeEvidenceCards } = await import('../src/domain/ai/evidenceCards.js');

const taskId = (n) => `21000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n, overrides = {}) => ({ id: taskId(n), title: `Görev ${n}`, project: 'Altyapı', status: 'in_progress', overdue: true, overdueDays: 10 + n, due: '2026-11-10',
  finished: null, progress: 30, assignees: ['Ayşe Demir'], hiddenAssignees: 0, assignment: 'visible', ...overrides });
const descriptor = normalizeEvidenceCards({ v: EVIDENCE_CARD_VERSION, cards: [{ id: 'c1', kind: 'tasks', title: 'Gecikmiş görevleriniz', tone: 'overdue', generatedAt: '2026-11-27T08:00:00.000Z',
  total: 12, scopePartial: true, items: [item(1), item(2), item(3, { assignees: [], assignment: 'unassigned' })], people: [{ name: 'Ayşe Demir', tasks: 2 }], unassigned: 1, undisclosed: 0 }],
anchors: [{ strong: 0, text: '12', card: 'c1' }] });
const [card] = descriptor.cards;

function Harness({ receivedAt, openTask, shownCard = card }) {
  return React.createElement(EvidenceCardActionsContext.Provider, { value: { openTask } },
    React.createElement('p', null, 'Şu anda ',
      React.createElement(EvidenceReference, { card: shownCard, receivedAt, text: '12' }, React.createElement('strong', null, '12')),
      ' gecikmiş göreviniz var.'),
    React.createElement('button', { type: 'button', id: 'disari' }, 'Dışarı'));
}

const cardNode = () => document.querySelector('.ice-card');

test('kart klavyeyle açılır, odak karta taşınır, Esc kartı kapatıp odağı tetikleyiciye döndürür', () => {
  const opened = [];
  const view = mountDom(Harness, { receivedAt: Date.now(), openTask: (id) => opened.push(id) });
  const trigger = view.host.querySelector('.ice-ref');
  assert.ok(trigger, 'bağlı olgu tetikleyici olmalı');
  assert.equal(trigger.getAttribute('role'), 'button');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.match(trigger.getAttribute('aria-label'), /12 — Gecikmiş görevleriniz: 12 görev/);
  assert.equal(trigger.textContent, '12', 'yanıt metni değişmez');
  act(() => trigger.focus());
  key('Enter', trigger);
  const dialog = cardNode();
  assert.ok(dialog, 'kart açılmalı');
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-label'), 'Gecikmiş görevleriniz: 12 görev');
  assert.ok(dialog.contains(document.activeElement), 'odak kartta olmalı');
  assert.match(document.activeElement.getAttribute('aria-label'), /^Görev 1 görevini aç · Altyapı/);
  key('Escape', document.activeElement);
  assert.equal(cardNode(), null, 'Esc kartı kapatmalı');
  assert.equal(document.activeElement, trigger, 'odak tetikleyiciye dönmeli');
  assert.equal(cardNode(), null, 'odak dönüşü kartı yeniden açmamalı');
  view.unmount();
});

test('yeniden açılan kart yeni konumu ölçülene kadar gizli kalır ve odak ölçümden sonra taşınır', (t) => {
  const view = mountDom(Harness, { receivedAt: Date.now(), openTask: () => {} });
  try {
    const trigger = view.host.querySelector('.ice-ref');
    const beforePlacement = [];
    let left = 40;
    t.mock.method(trigger, 'getBoundingClientRect', () => {
      beforePlacement.push({ visibility: cardNode().style.visibility, triggerFocused: document.activeElement === trigger });
      return { left, top: 60, width: 20, height: 16 };
    });
    key('Enter', trigger);
    assert.equal(cardNode().style.left, '40px');
    key('Escape');
    assert.equal(cardNode(), null);

    left = 120;
    beforePlacement.length = 0;
    key('Enter', trigger);
    assert.deepEqual(beforePlacement, [{ visibility: 'hidden', triggerFocused: true }]);
    assert.equal(cardNode().style.left, '120px');
    assert.equal(cardNode().style.visibility, 'visible');
    assert.equal(document.activeElement, cardNode().querySelector('.ice-row'));
  } finally {
    view.unmount();
  }
});

test('görev satırı mevcut görev açma sözleşmesini görev kimliğiyle çağırır ve kartı kapatır', () => {
  const opened = [];
  const view = mountDom(Harness, { receivedAt: Date.now(), openTask: (id) => opened.push(id) });
  click(view.host.querySelector('.ice-ref'));
  const rows = [...cardNode().querySelectorAll('.ice-row')];
  assert.equal(rows.length, 3);
  click(rows[1]);
  assert.deepEqual(opened, [taskId(2)]);
  assert.equal(cardNode(), null);
  view.unmount();
});

test('kart kısmi önizlemeyi, kapsamı, farklı sorumluları ve kanıt anındaki durumu açıkça gösterir', () => {
  const view = mountDom(Harness, { receivedAt: Date.now(), openTask: () => {} });
  click(view.host.querySelector('.ice-ref'));
  const text = cardNode().textContent;
  assert.match(text, /Kanıt sınırı nedeniyle 12 görevin tamamı değil, 3 görev gösteriliyor\./);
  assert.match(text, /Yalnızca görüntüleme yetkiniz bulunan kayıtlar\./);
  assert.match(text, /gösterilen görevlerde/);
  assert.match(text, /Ayşe Demir2/);
  assert.match(text, /Sorumlusuz1/);
  assert.match(text, /11 gün gecikmiş/);
  assert.match(text, /Veri zamanı:/);
  assert.equal(cardNode().querySelectorAll('.ice-row').length, 3);
  view.unmount();
});

test('dış tıklama ve kart dışındaki kaydırma kartı kapatır; kart içindeki kaydırma kapatmaz', () => {
  const view = mountDom(Harness, { receivedAt: Date.now(), openTask: () => {} });
  const trigger = view.host.querySelector('.ice-ref');
  click(trigger);
  act(() => cardNode().querySelector('.rt-list').dispatchEvent(new window.Event('scroll', { bubbles: false })));
  assert.ok(cardNode(), 'liste kaydırması kartı kapatmamalı');
  act(() => view.host.dispatchEvent(new window.Event('scroll', { bubbles: false })));
  assert.equal(cardNode(), null, 'sohbet kaydırması kartı kapatmalı');
  click(trigger);
  act(() => document.getElementById('disari').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
  assert.equal(cardNode(), null, 'dış tıklama kartı kapatmalı');
  view.unmount();
});

test('süresi dolan kart açılmaz ve olgu sade kalın metne döner', () => {
  const view = mountDom(Harness, { receivedAt: Date.now() - EVIDENCE_CARD_LIMITS.ttlMs - 1, openTask: () => {} });
  assert.equal(view.host.querySelector('.ice-ref'), null);
  assert.equal(view.host.querySelector('strong').textContent, '12');
  view.unmount();
});

test('görev açma eylemi yoksa satırlar bilgi olarak kalır, düğme olmaz', () => {
  const view = mountDom(Harness, { receivedAt: Date.now(), openTask: null });
  click(view.host.querySelector('.ice-ref'));
  assert.equal(cardNode().querySelectorAll('button.ice-row').length, 0);
  assert.equal(cardNode().querySelectorAll('.ice-row.is-static').length, 3);
  view.unmount();
});

test('HoverListCard mevcut kullanımı değişmez: rol, odak taşıma ve iki bağımsız değişkenli satır çizimi eskisi gibi', () => {
  const seen = [];
  function Ozet() {
    return React.createElement(HoverListCard, {
      title: 'Toplam görev', items: [{ id: 'a' }, { id: 'b' }], listHint: 'Açmak için tıklayın',
      renderItem: (task, index) => { seen.push([task.id, index]); return React.createElement('button', { key: task.id, className: 'rt-list-item' }, task.id); }
    }, React.createElement('div', { className: 'stat' }, '34'));
  }
  const view = mountDom(Ozet);
  const trigger = view.host.querySelector('.hovercard-trigger');
  act(() => trigger.focus());
  key('Enter', trigger);
  const tip = document.querySelector('.rich-tip.interactive');
  assert.ok(tip);
  assert.equal(tip.getAttribute('role'), null, 'eski kart rol almaz');
  assert.equal(trigger.getAttribute('aria-haspopup'), null);
  assert.equal(tip.querySelector('.rt-list-head').textContent.startsWith('Görevler · 2'), true);
  assert.equal(document.activeElement, trigger, 'odak yönetimi istenmeden odak taşınmaz');
  assert.deepEqual(seen.slice(-2), [['a', 0], ['b', 1]]);
  key('Escape', trigger);
  assert.equal(document.querySelector('.rich-tip.interactive'), null);
  view.unmount();
});

test('kipli kart Tab sınırında pencereye döner ve ilk Esc yalnız kartı kapatır', () => {
  let closed = 0;
  function Panel() {
    const containerRef = React.useRef(null);
    const initialFocusRef = React.useRef(null);
    useModalFocusTrap({ containerRef, initialFocusRef, onClose: () => { closed += 1; } });
    return React.createElement('div', { ref: containerRef },
      React.createElement('input', { ref: initialFocusRef }),
      React.createElement(Harness, { receivedAt: Date.now(), openTask: () => {} }));
  }
  const view = mountDom(Panel);
  try {
    const trigger = view.host.querySelector('.ice-ref');
    act(() => trigger.focus());
    key('Enter', trigger);
    const chips = cardNode().querySelector('ul.ice-chips');
    const rows = [...cardNode().querySelectorAll('button')];
    assert.ok(chips, 'sorumlu listesi odaklanabilir olmalı');
    assert.equal(document.activeElement, rows[0]);
    assert.equal(key('Tab', rows[0]).defaultPrevented, false);
    assert.equal(key('Tab', rows[0], { shiftKey: true }).defaultPrevented, false);
    act(() => chips.focus());
    assert.equal(key('Tab', chips, { shiftKey: true }).defaultPrevented, true);
    assert.equal(document.activeElement, trigger);
    assert.equal(cardNode(), null);
    key('Enter', trigger);
    assert.equal(key('Tab', cardNode().querySelectorAll('button')[2]).defaultPrevented, false);
    act(() => cardNode().querySelectorAll('button')[2].focus());
    assert.equal(key('Tab').defaultPrevented, false, 'tarayıcı tetikleyicinin ardından devam eder');
    assert.equal(document.activeElement, trigger);
    assert.equal(cardNode(), null);
    key('Enter', trigger);
    key('Escape');
    assert.equal(cardNode(), null);
    assert.equal(document.activeElement, trigger);
    assert.equal(closed, 0);
    key('Escape');
    assert.equal(closed, 1);
  } finally {
    view.unmount();
  }
});

test('fareye açık sabitlenmemiş kart Esc ile kapanır, dışarıdaki odak yerinde kalır', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const view = mountDom(Harness, { receivedAt: Date.now(), openTask: () => {} });
  const outside = view.host.querySelector('#disari');
  act(() => outside.focus());
  act(() => view.host.querySelector('.ice-ref').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  act(() => t.mock.timers.tick(90));
  assert.ok(cardNode());
  assert.equal(key('Escape', outside).defaultPrevented, true);
  assert.equal(cardNode(), null);
  assert.equal(document.activeElement, outside);
  assert.equal(key('Escape', outside).defaultPrevented, false);
  view.unmount();
});

test('sabitlenmiş kart yanıt süresi dolunca veya sekme geri gelince kaybolur', (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  for (const resume of [false, true]) {
    const view = mountDom(AssistantMarkdown, { text: 'Toplam **12** görev.', rotaData: true, cards: { value: descriptor, receivedAt: Date.now() } });
    const trigger = view.host.querySelector('.ice-ref');
    act(() => trigger.focus());
    if (resume) key('Enter', trigger);
    assert.ok(cardNode());
    assert.ok(resume ? cardNode().contains(document.activeElement) : document.activeElement === trigger);
    act(() => {
      if (resume) {
        t.mock.timers.setTime(Date.now() + EVIDENCE_CARD_LIMITS.ttlMs);
        document.dispatchEvent(new Event('visibilitychange'));
      } else t.mock.timers.tick(EVIDENCE_CARD_LIMITS.ttlMs);
    });
    assert.equal(cardNode(), null);
    assert.equal(view.host.querySelector('.ice-ref'), null);
    assert.equal(view.host.querySelector('strong').textContent, '12');
    assert.equal(document.activeElement, view.host.querySelector('.assistant-md'));
    view.unmount();
  }
});

test('aynı adlı görevler görünür bağlamla ayırt edilir ve doğru görev açılır', () => {
  const shownCard = { ...card, items: [
    item(1, { title: 'Yük testi', project: 'Birinci proje', hiddenAssignees: 1, unresolvedAssignees: 1 }),
    item(2, { title: 'Yük testi', project: 'İkinci proje', due: '2026-11-15', assigneesClipped: true })
  ], peopleClipped: true };
  const opened = [];
  const view = mountDom(Harness, { shownCard, receivedAt: Date.now(), openTask: (id) => opened.push(id) });
  const trigger = view.host.querySelector('.ice-ref');
  click(trigger);
  const rows = [...cardNode().querySelectorAll('button')];
  assert.match(cardNode().textContent, /Kişi listesi kısmi önizlemedir/);
  assert.match(rows[0].getAttribute('aria-label'), /Birinci proje.*1 sorumlu gösterilemiyor.*1 sorumlunun dizin kaydı çözülemedi/);
  assert.match(rows[1].getAttribute('aria-label'), /İkinci proje.*Diğer görünür adlar listelenmiyor.*Termin/);
  click(rows[0]);
  click(trigger);
  click(cardNode().querySelectorAll('button')[1]);
  assert.deepEqual(opened, [taskId(1), taskId(2)]);
  view.unmount();
});

test('görünüm alanı kanıt kartının tamamını sınırlar ve kart gövdesi kaydırılabilir', () => {
  const css = readFileSync(new URL('../src/app/styles/assistant.css', import.meta.url), 'utf8');
  assert.match(css, /\.rich-tip\.ice-card\s*\{[^}]*max-height:\s*min\([^;]*--app-viewport-h/);
  assert.match(css, /\.ice-card \.rich-tip-body\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.ice-chips:focus-visible\s*\{[^}]*outline:/);
});

test('fareyle sabitlenen kart tetikleyiciden başka öğeye odak gidince kapanır, kendi kartına geçince açık kalır', () => {
  const secondCard = { ...card, id: 'c2', title: 'İkinci kanıt', total: 4 };
  function TwoRefs() {
    return React.createElement(EvidenceCardActionsContext.Provider, { value: { openTask: () => {} } },
      React.createElement('p', null,
        React.createElement(EvidenceReference, { card, receivedAt: Date.now(), text: '12' }, React.createElement('strong', null, '12')),
        ' ve ',
        React.createElement(EvidenceReference, { card: secondCard, receivedAt: Date.now(), text: '4' }, React.createElement('strong', null, '4'))));
  }
  const view = mountDom(TwoRefs);
  try {
    const [first, second] = [...view.host.querySelectorAll('.ice-ref')];
    click(first);
    assert.equal(document.querySelectorAll('.ice-card').length, 1);
    // Odak kendi kartının içine geçerse kart açık kalır.
    const ownRow = cardNode().querySelector('button.ice-row');
    act(() => ownRow.focus());
    assert.equal(document.querySelectorAll('.ice-card').length, 1);
    // Tekrar ilk tetikleyiciye dönüp ikinci tetikleyiciye Tab ile geçilince yalnızca ikinci kart açık kalır.
    act(() => first.focus());
    act(() => second.focus());
    const openCards = [...document.querySelectorAll('.ice-card')];
    assert.equal(openCards.length, 1, 'iki kart aynı anda açık kalmamalı');
    assert.match(openCards[0].getAttribute('aria-label'), /^İkinci kanıt:/);
    assert.equal(document.activeElement, second, 'odak ikinci tetikleyicide kalmalı');
  } finally {
    view.unmount();
  }
});

test('salt okunur kartın kökü odaklanabilir ve ters Tab ile tetikleyiciye dönülür', () => {
  const singleCard = normalizeEvidenceCards({
    v: EVIDENCE_CARD_VERSION,
    cards: [{ id: 'c1', kind: 'task', title: 'Tekil görev', tone: 'neutral', generatedAt: '2026-11-27T08:00:00.000Z',
      total: 1, scopePartial: false, items: [item(1)], people: [{ name: 'Ayşe Demir', tasks: 1 }], unassigned: 0, undisclosed: 0 }],
    anchors: [{ strong: 0, text: 'Tekil görev', card: 'c1' }]
  }).cards[0];
  function ModalReadOnly() {
    const containerRef = React.useRef(null);
    const initialFocusRef = React.useRef(null);
    useModalFocusTrap({ containerRef, initialFocusRef, onClose: () => {} });
    return React.createElement('div', { ref: containerRef },
      React.createElement('input', { ref: initialFocusRef }),
      React.createElement(EvidenceCardActionsContext.Provider, { value: { openTask: null } },
        React.createElement(EvidenceReference, { card: singleCard, receivedAt: Date.now(), text: 'Tekil görev' },
          React.createElement('strong', null, 'Tekil görev'))));
  }
  const view = mountDom(ModalReadOnly);
  try {
    const trigger = view.host.querySelector('.ice-ref');
    act(() => trigger.focus());
    key('Enter', trigger);
    const dialog = cardNode();
    assert.ok(dialog);
    assert.equal(dialog.getAttribute('tabindex'), '-1');
    assert.equal(document.activeElement, dialog, 'alt öğe yoksa odak diyalog köküne yerleşmeli');
    assert.equal(key('Tab', dialog, { shiftKey: true }).defaultPrevented, true);
    assert.equal(cardNode(), null);
    assert.equal(document.activeElement, trigger);
  } finally {
    view.unmount();
  }
});

test('taşan sorumlu listesi klavyeyle odaklanabilir ve uygun Türkçe erişilebilir ada sahiptir', () => {
  const manyPeople = Array.from({ length: 24 }, (_, index) => ({ name: `Sorumlu ${index + 1}`, tasks: 1 }));
  const crowdedCard = { ...card, people: manyPeople };
  const view = mountDom(Harness, { shownCard: crowdedCard, receivedAt: Date.now(), openTask: () => {} });
  try {
    click(view.host.querySelector('.ice-ref'));
    const list = cardNode().querySelector('ul.ice-chips');
    assert.ok(list);
    assert.equal(list.getAttribute('tabindex'), '0');
    assert.equal(list.getAttribute('aria-label'), 'Sorumlular');
    assert.equal(list.querySelectorAll('li.ice-chip').length, 25);
    assert.equal(list.querySelectorAll('button, [tabindex]').length, 0, 'statik kişi yongaları gereksiz etkileşim taşımamalı');
    act(() => list.focus());
    assert.equal(document.activeElement, list);
  } finally {
    view.unmount();
  }
});

test('görev seçimi başarılıysa yalnız kipli Bilgin paneli çekmeceye alan açar', async (t) => {
  const controller = await taskPanelController();
  t.after(() => controller.dispose());

  for (const [focused, ok, shouldClose] of [[true, false, false], [false, true, false], [true, true, true]]) {
    const closed = [];
    const opened = [];
    const view = mountDom(RotaAssistantPanel, {
      assistant: { controller, open: true, actual: true, focused, launcherRef: { current: null }, close: (options) => closed.push(options) },
      openEvidenceTask: async (id) => { opened.push(id); return { ok }; }
    });
    try {
      click(view.host.querySelector('.ice-ref'));
      const row = cardNode()?.querySelector('button.ice-row');
      assert.ok(row);
      await act(async () => click(row));
      assert.deepEqual(opened, [taskId(1)]);
      assert.deepEqual(closed, shouldClose ? [{ restoreFocus: false }] : []);
      assert.equal(Boolean(view.host.querySelector('[role=alert]')), !ok);
    } finally {
      view.unmount();
    }
  }
});

test('Bilgin görev çekmecesinin odağını bağlanma sırasından bağımsız korur ve olağan kapanışta başlatıcıya döner', async (t) => {
  const controller = await taskPanelController();
  t.after(() => controller.dispose());
  const frames = [];
  t.mock.method(globalThis, 'requestAnimationFrame', (callback) => frames.push(callback));
  const flushFrames = () => act(() => { for (const frame of frames.splice(0)) frame(); });

  function GecikenCekmece() {
    const drawerRef = React.useRef(null);
    useModalFocusTrap({ containerRef: drawerRef, initialFocusRef: drawerRef, priority: 310 });
    return React.createElement('div', { ref: drawerRef, role: 'dialog', tabIndex: -1, 'aria-label': 'Görev ayrıntısı' });
  }

  function BilginVeCekmece({ drawer }) {
    const [open, setOpen] = React.useState(false);
    const launcherRef = React.useRef(null);
    return React.createElement(React.Fragment, null,
      React.createElement('button', { ref: launcherRef, onClick: () => setOpen(true) }, 'Bilgin'),
      drawer && React.createElement(GecikenCekmece),
      React.createElement(RotaAssistantPanel, {
        assistant: { controller, open, actual: true, focused: true, launcherRef, close: () => setOpen(false) },
        openEvidenceTask: async () => ({ ok: true })
      }));
  }

  const view = mountDom(BilginVeCekmece);
  try {
    const launcher = view.host.querySelector('button');
    const drawer = () => view.host.querySelector('[aria-label="Görev ayrıntısı"]');
    for (const drawerFirst of [false, true]) {
      click(launcher);
      if (drawerFirst) {
        view.render({ drawer: true });
        assert.equal(view.host.querySelector('#rota-assistant-panel').contains(document.activeElement), true);
      }
      click(view.host.querySelector('.ice-ref'));
      await act(async () => click(cardNode().querySelector('.ice-row')));
      assert.equal(view.host.querySelector('#rota-assistant-panel'), null);
      flushFrames();
      if (!drawerFirst) {
        assert.equal(document.activeElement === document.body, true, 'çekmece henüz kurulmadan odak başlatıcıya dönmemeli');
        view.render({ drawer: true });
      }
      assert.equal(document.activeElement === drawer(), true, 'odak görev çekmecesine geçmeli');
      view.render({ drawer: false });
      flushFrames();
    }

    click(launcher);
    click(view.host.querySelector('[aria-label="Bilgin’i kapat"]'));
    flushFrames();
    assert.equal(document.activeElement, launcher);
  } finally {
    view.unmount();
    flushFrames();
  }
});

async function taskPanelController() {
  const conversation = { id: '6f1c2d3e-4a5b-4c6d-8e7f-001122334455', title: 'Kanıt', messageCount: 2 };
  const controller = createAssistantController({ api: {
    loadAssistantReadinessRequest: async () => ({ ok: true, assistant: { available: true, modes: [{ id: 'standard', label: 'Standart', available: true }] } }),
    listAssistantConversationsRequest: async () => ({ ok: true, conversations: [], nextCursor: null }),
    async streamAssistantTurnRequest({ turnId, onEvent }) {
      onEvent({ type: 'accepted', data: { conversation, userMessage: { id: 'u1', turnId, content: 'Soru' }, context: {}, rotaData: true } });
      return { ok: true, done: { conversation, evidenceCards: descriptor, assistantMessage: { id: 'a1', content: 'Toplam **12** görev.', rotaData: true, evidence: [] } } };
    }
  } });
  await controller.activate();
  controller.send('Soru');
  await new Promise((resolve) => setImmediate(resolve));
  return controller;
}

test('görev açma reddi bildirilir, eski istek ve eski konuşma paneli kapatamaz', async (t) => {
  const controller = await taskPanelController();
  t.after(() => controller.dispose());
  const pending = [];
  const closed = [];
  const view = mountDom(RotaAssistantPanel, {
    assistant: { controller, open: true, actual: true, focused: true, launcherRef: { current: null }, close: () => closed.push(true) },
    openEvidenceTask: (id, { isCurrent }) => new Promise((resolve, reject) => pending.push({ isCurrent, resolve, reject }))
  });
  try {
    const openRow = () => {
      click(view.host.querySelector('.ice-ref'));
      click(cardNode().querySelector('button.ice-row'));
    };
    openRow();
    openRow();
    assert.equal(pending[0].isCurrent(), false);
    assert.equal(pending[1].isCurrent(), true);
    await act(async () => pending[0].resolve({ ok: true }));
    assert.deepEqual(closed, []);
    await act(async () => pending[1].reject(new Error('İç ayrıntı')));
    assert.match(view.host.querySelector('[role=alert]').textContent, /Görev açılamadı/);
    assert.doesNotMatch(view.host.textContent, /İç ayrıntı/);
    openRow();
    act(() => controller.newConversation());
    assert.equal(pending[2].isCurrent(), false);
    await act(async () => pending[2].resolve({ ok: true }));
    assert.deepEqual(closed, []);
    assert.equal(view.host.querySelector('[role=alert]'), null);
  } finally {
    view.unmount();
  }
});

test('dış kaydırma odaktaki kartı kaydırmadan kapatır ve tetikleyiciyi yeniden açmaz', (t) => {
  const view = mountDom(Harness, { receivedAt: Date.now(), openTask: () => {} });
  try {
    const trigger = view.host.querySelector('.ice-ref');
    act(() => trigger.focus());
    key('Enter', trigger);
    assert.ok(cardNode().contains(document.activeElement));
    const focus = t.mock.method(trigger, 'focus');
    act(() => view.host.dispatchEvent(new Event('scroll')));
    assert.equal(cardNode(), null);
    assert.equal(document.activeElement, trigger);
    assert.deepEqual(focus.mock.calls[0].arguments, [{ preventScroll: true }]);
    click(trigger);
    const outside = view.host.querySelector('#disari');
    act(() => outside.focus());
    act(() => view.host.dispatchEvent(new Event('scroll')));
    assert.equal(document.activeElement, outside);
  } finally {
    view.unmount();
  }
});

test('bütün görünür adlar kırpıldığında boş sekme durağı yerine kısmi önizleme açıklanır', () => {
  const shownCard = { ...card, people: [], unassigned: 0, undisclosed: 0, peopleClipped: true,
    items: [item(1, { assignees: [], assigneesClipped: true })] };
  const view = mountDom(Harness, { shownCard, receivedAt: Date.now(), openTask: () => {} });
  try {
    click(view.host.querySelector('.ice-ref'));
    assert.match(cardNode().textContent, /Kişi listesi kısmi önizlemedir/);
    assert.equal(cardNode().querySelector('.ice-chips'), null);
  } finally {
    view.unmount();
  }
});

test('Markdown yalnız güvenli şemalarda bağlantı çizer ve Türkçe metni korur', () => {
  const text = '[Bir](JaVaScRiPt:alert%281%29) [İki](javascript%3Aalert%281%29) [Üç](java&#x73;cript:alert%281%29) '
    + '[Dört](java\tscript:alert%281%29) <data:text/plain,örnek> [İş](HTTPS://example.test/%C4%B1) <mailto:rota@example.test>';
  const view = mountDom(AssistantMarkdown, { text });
  try {
    assert.deepEqual([...view.host.querySelectorAll('a')].map((element) => element.getAttribute('href')),
      ['https://example.test/%C4%B1', 'mailto:rota@example.test']);
    assert.match(view.host.textContent, /Bir İki Üç Dört/);
    assert.match(view.host.textContent, /İş/);
  } finally {
    view.unmount();
  }
});
