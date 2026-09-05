import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const retiredDescriptor = ['MERGEN Rota', ['Proje', 'Yönetimi'].join(' ')].join(' — ');

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  });
}

test('ürün başlığı ve açıklaması Görev Yönetimi olarak görünür', () => {
  const checked = [
    path.join(root, 'README.md'),
    ...filesBelow(path.join(root, 'src')),
    ...filesBelow(path.join(root, 'docs')),
    ...filesBelow(path.join(root, 'test'))
  ].filter((file) => !file.endsWith('mergen-rota-task-management-branding.test.mjs'));

  for (const file of checked) {
    const source = readFileSync(file, 'utf8');
    assert.equal(source.includes(retiredDescriptor), false, path.relative(root, file));
  }

  const layout = readFileSync(path.join(root, 'src/app/layout.js'), 'utf8');
  const boundary = readFileSync(path.join(root, 'src/components/shell/AppDataBoundary.jsx'), 'utf8');
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(layout, /title:\s*'MERGEN Rota — Görev Yönetimi'/);
  assert.match(layout, /endüstriyel görev yönetimi paneli/);
  assert.doesNotMatch(boundary, new RegExp('>' + ['Proje', 'Yönetimi'].join(' ') + '<'));
  assert.match(boundary, />Görev Yönetimi</);
  for (const component of [
    'src/components/shell/DataModeChooser.jsx',
    'src/components/shell/ModeChooser.jsx',
    'src/components/shell/WelcomeScreen.jsx'
  ]) {
    const source = readFileSync(path.join(root, component), 'utf8');
    assert.doesNotMatch(source, new RegExp('>\\s*' + ['Proje', 'Yönetimi'].join(' ') + '(?:\\s*·|\\s*<)'), component);
    assert.match(source, />\s*Görev Yönetimi(?:\s*·|\s*<)/, component);
  }
  assert.match(readme, /^# MERGEN Rota — Görev Yönetimi/m);
  assert.match(readme, /görev yönetimi uygulaması/);
});
