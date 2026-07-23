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

test('sorumlu aramasında Enter tuşu hızlı görev formunu yanlışlıkla göndermez', () => {
  const simple = read('src/features/simple/SimpleModePanel.jsx');

  assert.match(
    simple,
    /onKeyDown=\{\(event\) => \{ if \(event\.key === 'Enter'\) event\.preventDefault\(\); \}\}[\s\S]*?aria-label="Sorumlu ara"/
  );
});

test('üst çubuk yedigeni ve proje kimliği tek shell sahibi altında PR28 son durumunu korur', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  const css = read('src/app/styles/shell.css');
  const globalCss = read('src/app/globals.css');

  assert.match(shell, /topbar-project-code/);
  assert.match(shell, /topbar-project-name/);
  assert.match(css, /\.topbar-emblem-clip \.hept-topbar\s*\{[^}]*top:\s*-190px;[^}]*right:\s*-205px;[^}]*width:\s*320px;[^}]*height:\s*320px;/s);
  assert.match(globalCss, /\.hept-emblem \.hept-spin\s*\{[^}]*animation:\s*heptSpin 120s linear infinite;/s);
  assert.match(css, /\.topbar-project-code\s*\{[^}]*color:\s*var\(--text-muted\)/s);
  assert.match(css, /\.topbar-project-context strong\.topbar-project-name\s*\{[^}]*color:\s*color-mix\(in oklab, var\(--accent\) 78%, var\(--text\)\)/s);
});

test('Özet hizalaması semantik grid ve kart sınıflarıyla tanımlanır', () => {
  const css = read('src/app/styles/dashboard.css');
  const dashboard = read('src/features/dashboard/DashboardView.jsx');

  assert.match(dashboard, /className="dashboard-main-grid"/);
  assert.match(dashboard, /className="card dashboard-trend-card"/);
  assert.match(dashboard, /className="card dashboard-status-card"/);
  assert.match(dashboard, /className="dashboard-bottom-grid"/);
  assert.match(css, /\.dashboard-main-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.1fr\) minmax\(0, 0\.9fr\) minmax\(0, 1fr\);/s);
  assert.match(css, /\.dashboard-trend-card\s*\{\s*grid-column:\s*1 \/ 3;/s);
  assert.match(css, /\.dashboard-status-card\s*\{[^}]*grid-column:\s*3;/s);
  assert.doesNotMatch(css, /\[style\*=/);
  assert.doesNotMatch(css, /\.card:nth-child/);
});

test('orta genişlikte trend ve durum kartlarının ikisi de tam satıra yayılır', () => {
  const css = read('src/app/styles/dashboard.css');

  assert.match(
    css,
    /@media \(max-width: 1280px\)[\s\S]*?\.dashboard-trend-card,[\s\S]*?\.dashboard-status-card\s*\{\s*grid-column:\s*1 \/ -1;/s
  );
});

test('kök stil yükleme sırası sorumluluk tabanlıdır ve rehber Basit Mod akışını açıklar', () => {
  const layout = read('src/app/layout.js');
  const help = read('src/features/help/HelpView.jsx');

  assert.match(layout, /import '\.\/styles\/shell\.css';/);
  assert.match(layout, /import '\.\/styles\/dashboard\.css';/);
  assert.match(layout, /import '\.\/styles\/simple-mode\.css';/);
  assert.doesNotMatch(layout, /fixes\.css|followup-fixes\.css|topbar-dashboard-polish\.css/);
  assert.match(help, /Takvim varsayılan sekmedir; Hızlı Görev Tanımı ayrı bir sekmede açılır/);
  assert.match(help, /ad veya personel numarasıyla ara/i);
});
