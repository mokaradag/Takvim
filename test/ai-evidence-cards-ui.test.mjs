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
import React, { act } from 'react';
import { click, key, mountDom } from './helpers/clientDomHarness.mjs';

const { EvidenceReference, EvidenceCardActionsContext } = await import('../src/features/ai/assistant/EvidenceCard.jsx');
const { HoverListCard } = await import('../src/components/ui-extras.jsx');
const { EVIDENCE_CARD_LIMITS, normalizeEvidenceCards } = await import('../src/domain/ai/evidenceCards.js');

const taskId = (n) => `21000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n, overrides = {}) => ({ id: taskId(n), title: `Görev ${n}`, project: 'Altyapı', status: 'in_progress', overdue: true, overdueDays: 10 + n, due: '2026-11-10',
  finished: null, progress: 30, assignees: ['Ayşe Demir'], hiddenAssignees: 0, assignment: 'visible', ...overrides });
const descriptor = normalizeEvidenceCards({ v: 1, cards: [{ id: 'c1', kind: 'tasks', title: 'Gecikmiş görevleriniz', tone: 'overdue', generatedAt: '2026-11-27T08:00:00.000Z',
  total: 12, scopePartial: true, items: [item(1), item(2), item(3, { assignees: [], assignment: 'unassigned' })], people: [{ name: 'Ayşe Demir', tasks: 2 }], unassigned: 1, undisclosed: 0 }],
anchors: [{ strong: 0, text: '12', card: 'c1' }] });
const [card] = descriptor.cards;

function Harness({ receivedAt, openTask }) {
  return React.createElement(EvidenceCardActionsContext.Provider, { value: { openTask } },
    React.createElement('p', null, 'Şu anda ',
      React.createElement(EvidenceReference, { card, receivedAt, text: '12' }, React.createElement('strong', null, '12')),
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
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Görev 1 görevini aç');
  key('Escape', document.activeElement);
  assert.equal(cardNode(), null, 'Esc kartı kapatmalı');
  assert.equal(document.activeElement, trigger, 'odak tetikleyiciye dönmeli');
  assert.equal(cardNode(), null, 'odak dönüşü kartı yeniden açmamalı');
  view.unmount();
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
