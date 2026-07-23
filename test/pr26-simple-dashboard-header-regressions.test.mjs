import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('Basit Mod Takvim sayfası Takvim ile açılır ve hızlı görev tanımı ayrı sekmededir', () => {
  const shell = read('src/components/shell/AppShell.jsx');

  assert.match(shell, /useState\('calendar'\)/);
  assert.match(shell, /aria-label="Basit Mod Takvim görünümü"/);
  assert.match(shell, />\s*<Icons\.Calendar[^>]*\/> Takvim\s*</s);
  assert.match(shell, />\s*<Icons\.Plus[^>]*\/> Hızlı Görev Tanımı\s*</s);
  assert.match(shell, /simpleCalendarTab === 'calendar'[\s\S]*?<CalendarView[\s\S]*?: <SimpleModePanel/);
  assert.doesNotMatch(shell, /calendar-page-stack/);
});

test('Basit Mod workspace etkisi hook bağımlılıklarını nesne yerine kararlı alanlarla izler', () => {
  const shell = read('src/components/shell/AppShell.jsx');

  assert.match(shell, /mode: workspaceMode,[\s\S]*?selectWorkspace[\s\S]*?= workspace;/);
  assert.match(shell, /workspaceMode !== 'portfolio'\) selectWorkspace\(null\)/);
  assert.match(shell, /\[simpleMode, view, workspaceMode, selectWorkspace\]/);
  assert.doesNotMatch(shell, /\[simpleMode, view, workspace\.mode, workspace\.selectWorkspace\]/);
});

test('Basit Mod sorumlu seçimi büyük kişi listeleri için arama ve sınırlı sonuç kullanır', () => {
  const simple = read('src/features/simple/SimpleModePanel.jsx');

  assert.match(simple, /const MAX_VISIBLE_PEOPLE = 8;/);
  assert.match(simple, /placeholder="Ad veya personel numarasıyla ara"/);
  assert.match(simple, /peopleMatches\.slice\(0, MAX_VISIBLE_PEOPLE\)/);
  assert.match(simple, /personNumber\(person\)/);
  assert.match(simple, />Seçilenler</);
  assert.match(simple, /İlk \{MAX_VISIBLE_PEOPLE\} sonuç gösteriliyor/);
});

test('üst çubukta dönen yedigen görünür alana taşınır ve proje kodu ile adı ayrıştırılır', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  const css = read('src/app/followup-fixes.css');
  const globalCss = read('src/app/globals.css');

  assert.match(shell, /topbar-project-code/);
  assert.match(shell, /topbar-project-name/);
  assert.match(css, /\.topbar-emblem-clip \.hept-topbar\s*\{[^}]*top:\s*-88px;[^}]*right:\s*-58px;[^}]*width:\s*220px;[^}]*height:\s*220px;/s);
  assert.match(globalCss, /\.hept-emblem \.hept-spin\s*\{[^}]*animation:\s*heptSpin 120s linear infinite;/s);
  assert.match(css, /\.topbar-project-code\s*\{[^}]*color:\s*var\(--text-muted\)/s);
  assert.match(css, /\.topbar-project-context strong\.topbar-project-name\s*\{[^}]*color:\s*var\(--text\)/s);
});

test('Özet kartları ortak üç kolon izinde hizalanır ve durum grafiği büyüyüp dikey ortalanır', () => {
  const css = read('src/app/followup-fixes.css');

  assert.match(css, /grid-template-columns:\s*minmax\(0, 1\.1fr\) minmax\(0, 0\.9fr\) minmax\(0, 1fr\) !important;/);
  assert.match(css, /> \.card:first-child\s*\{\s*grid-column:\s*1 \/ 3;/s);
  assert.match(css, /> \.card:nth-child\(2\)\s*\{[^}]*grid-column:\s*3;/s);
  assert.match(css, /svg\[viewBox='-10 -10 170 170'\]\s*\{[^}]*width:\s*180px;[^}]*height:\s*180px;/s);
  assert.match(css, /> \.card:nth-child\(2\) > \.row:last-child\s*\{[^}]*align-items:\s*center !important;/s);
});

test('son katman düzeltme stilleri temel stillerden sonra yüklenir ve rehber yeni Basit Mod akışını açıklar', () => {
  const layout = read('src/app/layout.js');
  const help = read('src/features/help/HelpView.jsx');

  const fixesIndex = layout.indexOf("import './fixes.css';");
  const followupIndex = layout.indexOf("import './followup-fixes.css';");
  assert.ok(followupIndex > fixesIndex);
  assert.match(help, /Takvim varsayılan sekmedir; Hızlı Görev Tanımı ayrı bir sekmede açılır/);
  assert.match(help, /ad veya personel numarasıyla ara/i);
});
