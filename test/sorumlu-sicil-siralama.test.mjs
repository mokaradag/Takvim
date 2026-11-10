import assert from 'node:assert/strict';
import test from 'node:test';
import { mountDom } from './helpers/clientDomHarness.mjs';

const { ColumnFilter } = await import('../src/components/ui-extras.jsx');

function gorunenSecenekler() {
  return [...document.querySelectorAll('.col-filter-pop .col-filter-opt')]
    .map((element) => element.textContent.trim());
}

test('Görevler ve Gantt Sorumlu süzgeci sicilleri sayısal sırada listeler', () => {
  const options = [
    { value: '10000', label: '10000 · Ali' },
    { value: '9001', label: '9001 · Ayşe' },
    { value: '500', label: '500 · Can' },
    { value: '9000', label: '9000 · Zeynep' }
  ];
  const view = mountDom(ColumnFilter, {
    label: 'Sorumlu',
    type: 'multi',
    options,
    value: [],
    onChange() {},
    onClose() {}
  });
  try {
    assert.deepEqual(gorunenSecenekler(), [
      '500 · Can',
      '9000 · Zeynep',
      '9001 · Ayşe',
      '10000 · Ali'
    ]);
  } finally {
    view.unmount();
  }
});

test('Sorumlu dışındaki çoklu süzgeçlerin metin sırası değişmez', () => {
  const view = mountDom(ColumnFilter, {
    label: 'Proje',
    type: 'multi',
    options: [
      { value: '9', label: '9 · Proje' },
      { value: '10', label: '10 · Proje' }
    ],
    value: [],
    onChange() {},
    onClose() {}
  });
  try {
    assert.deepEqual(gorunenSecenekler(), ['10 · Proje', '9 · Proje']);
  } finally {
    view.unmount();
  }
});
