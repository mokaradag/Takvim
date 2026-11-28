/**
 * Bilgin ICE-2 · kart türlerinin tarayıcı etkileşimi (JSDOM, gerçek React).
 *
 * Sınananlar: hesap, karşılaştırma, varlık koleksiyonu ve kişi kartı klavyeyle açılır; odak karta taşınır, Esc kapatıp odağı
 * tetikleyiciye döndürür; kart içeriği yalnızca doğrulanmış tanımlayıcının metnidir (tarayıcı hesap yapmaz); liste bölümü
 * olmayan kartta "Kayıt yok" satırı çizilmez; kişi kartının görev satırı mevcut görev açma sözleşmesini çağırır; açma ve
 * inceleme sırasında ağ isteği yapılmaz.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { click, key, mountDom } from './helpers/clientDomHarness.mjs';

const { EvidenceReference, EvidenceCardActionsContext } = await import('../src/features/ai/assistant/EvidenceCard.jsx');
const { EVIDENCE_CARD_VERSION, normalizeEvidenceCards } = await import('../src/domain/ai/evidenceCards.js');

const GENERATED_AT = '2026-11-27T08:00:00.000Z';
const taskId = (n) => `21000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n) => ({ id: taskId(n), title: `Görev ${n}`, project: 'Altyapı', status: 'in_progress', overdue: true, overdueDays: 4 + n, due: '2026-11-10',
  finished: null, progress: 30, assignees: ['Ayşe Demir'], hiddenAssignees: 0, assignment: 'visible' });

const descriptor = normalizeEvidenceCards({ v: EVIDENCE_CARD_VERSION, cards: [
  { id: 'c1', kind: 'calc', title: 'Açık işlerde gecikme oranı', tone: 'overdue', generatedAt: GENERATED_AT, scopePartial: false,
    metrics: [{ label: 'Gecikmiş görev', value: '12' }, { label: 'Açık görev', value: '40' }], result: '%30', formula: '12 / 40 × 100 = %30' },
  { id: 'c2', kind: 'projects', title: 'Gecikmiş görevi olan projeler', tone: 'neutral', generatedAt: GENERATED_AT, scopePartial: true, total: 3,
    columns: ['Açık görev', 'Gecikmiş'], rows: [{ name: 'Altyapı Yenileme', values: [12, 5] }, { name: 'Mobil Uygulama', values: [9, 3] }, { name: 'Veri Ambarı Göçü', values: [8, null] }] },
  { id: 'c3', kind: 'person', title: 'Ayşe Demir', tone: 'neutral', generatedAt: GENERATED_AT, scopePartial: false, metrics: [{ label: 'Açık görev', value: '4' }, { label: 'Gecikmiş', value: '2' }],
    total: 5, items: [item(1), item(2)], listLabel: 'Gecikmiş görevler' },
  { id: 'c4', kind: 'compare', title: 'Dönem karşılaştırması', tone: 'neutral', generatedAt: GENERATED_AT, scopePartial: false,
    metrics: [{ label: 'Ağustos 2026', value: '8' }, { label: 'Eylül 2026', value: '6' }], result: 'Fark: −2 (azalış %25)', formula: '|6 − 8| / 8 × 100 ≈ %25' }
], anchors: [{ strong: 0, text: '%30', card: 'c1' }, { strong: 1, text: '3', card: 'c2' }, { strong: 2, text: 'Ayşe Demir', card: 'c3' }, { strong: 3, text: '%25', card: 'c4' }] });
const card = (id) => descriptor.cards.find((entry) => entry.id === id);

function Harness({ shown, text, openTask = null }) {
  return React.createElement(EvidenceCardActionsContext.Provider, { value: { openTask } },
    React.createElement('p', null, 'Değer ', React.createElement(EvidenceReference, { card: shown, receivedAt: Date.now(), text }, React.createElement('strong', null, text)), '.'),
    React.createElement('button', { type: 'button', id: 'disari' }, 'Dışarı'));
}

const cardNode = () => document.querySelector('.ice-card');

function withoutNetwork(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => { calls.push(args); throw new Error('ağ isteği beklenmiyor'); });
  return calls;
}

test('ICE-2 hesap kartı klavyeyle açılır; pay, payda, işlem ve sonuç tanımlayıcıdan çizilir; liste bölümü yoktur', (t) => {
  const network = withoutNetwork(t);
  const view = mountDom(Harness, { shown: card('c1'), text: '%30' });
  try {
    const trigger = view.host.querySelector('.ice-ref');
    assert.equal(trigger.textContent, '%30', 'yanıt metni değişmez');
    assert.match(trigger.getAttribute('aria-label'), /%30 — Açık işlerde gecikme oranı: %30/);
    act(() => trigger.focus());
    key('Enter', trigger);
    const dialog = cardNode();
    assert.ok(dialog);
    assert.equal(dialog.getAttribute('aria-label'), 'Açık işlerde gecikme oranı: %30');
    assert.match(dialog.textContent, /Gecikmiş görev\s*12/);
    assert.match(dialog.textContent, /Açık görev\s*40/);
    assert.match(dialog.textContent, /12 \/ 40 × 100 = %30/);
    assert.equal(dialog.querySelector('.rt-list'), null, 'hesap kartında görev listesi yoktur');
    assert.doesNotMatch(dialog.textContent, /Kayıt yok/);
    key('Escape', document.activeElement);
    assert.equal(cardNode(), null);
    assert.equal(document.activeElement, trigger, 'odak tetikleyiciye dönmeli');
    assert.equal(network.length, 0);
  } finally {
    view.unmount();
  }
});

test('ICE-2 proje koleksiyonu kaydırılabilir tabloda ad ve doğrulanmış sayılarla çizilir; bilinmeyen değer tire olur', (t) => {
  const network = withoutNetwork(t);
  const view = mountDom(Harness, { shown: card('c2'), text: '3' });
  try {
    const trigger = view.host.querySelector('.ice-ref');
    key('Enter', trigger);
    const dialog = cardNode();
    assert.ok(dialog.classList.contains('is-table'));
    const wrap = dialog.querySelector('[role=region]');
    assert.equal(wrap.getAttribute('tabindex'), '0', 'tablo ve kapsam klavyeyle kaydırılabilir');
    assert.equal(document.activeElement, wrap);
    assert.ok(wrap.querySelector('.ice-notice'));
    const rows = [...dialog.querySelectorAll('tbody tr')].map((row) => [...row.children].map((cell) => cell.textContent));
    assert.deepEqual(rows, [['Altyapı Yenileme', '12', '5'], ['Mobil Uygulama', '9', '3'], ['Veri Ambarı Göçü', '8', '—']]);
    assert.match(dialog.textContent, /Yalnızca görüntüleme yetkiniz bulunan kayıtlar/);
    key('Escape', document.activeElement);
    assert.equal(network.length, 0);
  } finally {
    view.unmount();
  }
});

test('ICE-2 kişi kartı ölçüleri ve kişinin görevlerini gösterir; kısmi önizleme yazılır; satır görev açma sözleşmesini çağırır', (t) => {
  const network = withoutNetwork(t);
  const opened = [];
  const view = mountDom(Harness, { shown: card('c3'), text: 'Ayşe Demir', openTask: (id) => opened.push(id) });
  try {
    const trigger = view.host.querySelector('.ice-ref');
    key('Enter', trigger);
    const dialog = cardNode();
    assert.match(dialog.textContent, /Açık görev\s*4/);
    assert.match(dialog.textContent, /Gecikmiş görevler · 2/);
    assert.match(dialog.textContent, /5 görevin tamamı değil, 2 görev gösteriliyor/);
    const rows = dialog.querySelectorAll('.ice-row');
    assert.equal(rows.length, 2);
    click(rows[0]);
    assert.deepEqual(opened, [taskId(1)]);
    assert.equal(cardNode(), null, 'görev açılınca kart kapanır');
    assert.equal(network.length, 0);
  } finally {
    view.unmount();
  }
});

test('ICE-2 karşılaştırma kartı iki dönemi, farkı ve değişim işlemini gösterir', (t) => {
  const network = withoutNetwork(t);
  const view = mountDom(Harness, { shown: card('c4'), text: '%25' });
  try {
    key('Enter', view.host.querySelector('.ice-ref'));
    const dialog = cardNode();
    assert.match(dialog.textContent, /Fark: −2 \(azalış %25\)/);
    assert.match(dialog.textContent, /Ağustos 2026\s*8/);
    assert.match(dialog.textContent, /Eylül 2026\s*6/);
    assert.match(dialog.textContent, /Değişim/);
    key('Escape', document.activeElement);
    assert.equal(network.length, 0);
  } finally {
    view.unmount();
  }
});

test('ICE-2 kart türleri kötü niyetli metni HTML olarak çizmez', (t) => {
  const network = withoutNetwork(t);
  const hostile = normalizeEvidenceCards({ v: EVIDENCE_CARD_VERSION, cards: [{ id: 'c1', kind: 'people', title: '<img src=x onerror=alert(1)>', tone: 'neutral', generatedAt: GENERATED_AT,
    scopePartial: false, total: 1, columns: ['<b>Açık</b>'], rows: [{ name: '<script>alert(1)</script>', values: [1] }] }], anchors: [{ strong: 0, text: '1', card: 'c1' }] });
  const view = mountDom(Harness, { shown: hostile.cards[0], text: '1' });
  try {
    key('Enter', view.host.querySelector('.ice-ref'));
    const dialog = cardNode();
    assert.equal(dialog.querySelector('img, script, b'), null);
    assert.match(dialog.textContent, /<script>alert\(1\)<\/script>/);
    key('Escape', document.activeElement);
    assert.equal(network.length, 0);
  } finally {
    view.unmount();
  }
});
