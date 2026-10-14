import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildTaskDependencyOptions } from '../src/features/task-detail/taskDependencyOptions.js';
import { setAppDateDisplayFormat } from '../src/scheduling/dates/index.js';

const wbs = [{ id: 'w1', code: '1.2', name: 'Entegrasyon' }];

test('bağımlılık seçicisi mevcut İDA kodunu ve tam yıllı Türkçe plan tarihlerini gösterir', () => {
  const [option] = buildTaskDependencyOptions([{ id: 'internal-uuid', task: 'Test', wbsId: 'w1', plannedStart: '2026-10-14', plannedFinish: '2026-10-20' }], wbs);
  assert.equal(option.label, 'Test');
  assert.equal(option.description, '1.2 · 14 Eki 2026 → 20 Eki 2026');
  assert.equal(option.description.includes('internal-uuid'), false);
  assert.ok(option.keywords.includes('Entegrasyon'));
  assert.ok(option.keywords.includes('2026-10-14'));
  assert.match(option.title, /Entegrasyon/);
});

test('eksik tarihler bugüne dönüşmez; uygulamanın tarih tercihi korunur', () => {
  setAppDateDisplayFormat('dd/mm/yyyy');
  try {
    const options = buildTaskDependencyOptions([
      { id: 'a', task: 'A', plannedFinish: '2026-10-20' },
      { id: 'b', task: 'B', plannedStart: '2026-10-14' },
      { id: 'c', task: 'C' }
    ]);
    assert.deepEqual(options.map((option) => option.description), ['— → 20/10/2026', '14/10/2026 → —', '— → —']);
  } finally { setAppDateDisplayFormat('pattern'); }
});

test('aynı adlı ve tarihli görevler sorumlu/etiket veya mevcut oluşturulma zamanıyla ayrılır', () => {
  const options = buildTaskDependencyOptions([
    { id: 'a', task: 'Aynı ad', sorumlu: ['Birinci'], keyword: 'Test' },
    { id: 'b', task: 'Aynı ad', sorumlu: ['İkinci'], keyword: 'Test' },
    { id: 'c', task: 'Başka', createdAt: '2026-10-14T08:00:00Z' },
    { id: 'd', task: 'Başka', createdAt: '2026-10-14T09:00:00Z' }
  ]);
  assert.notEqual(options[0].description, options[1].description);
  assert.notEqual(options[2].description, options[3].description);
  assert.match(options[2].description, /Tanım:/);
});

test('yüzlerce uzun görev adında tam başlık korunur; mevcut daraltma ve portal düzeni kullanılır', () => {
  const longName = 'Çok uzun görev adı '.repeat(100);
  const options = buildTaskDependencyOptions(Array.from({ length: 500 }, (_, id) => ({ id: String(id), task: longName, plannedFinish: `2026-10-${String(id % 28 + 1).padStart(2, '0')}` })));
  assert.equal(options.length, 500);
  assert.equal(new Set(options.map((option) => option.value)).size, 500);
  assert.equal(options[0].label, longName);
  assert.ok(options[0].title.includes(longName));
  const component = readFileSync(new URL('../src/components/SearchableSelect.jsx', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/app/styles/components.css', import.meta.url), 'utf8');
  assert.match(component, /title=\{option.title\}/);
  assert.match(component, /createPortal/);
  assert.match(styles, /\.searchable-select-option-label\s*\{[^}]*text-overflow: ellipsis/s);
});
