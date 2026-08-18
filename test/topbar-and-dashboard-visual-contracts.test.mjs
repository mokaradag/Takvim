import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function readAppCss() {
  const stylesDir = path.join(ROOT, 'src/app/styles');
  return [read('src/app/globals.css'), ...fs.readdirSync(stylesDir)
    .filter((name) => name.endsWith('.css'))
    .sort()
    .map((name) => read(`src/app/styles/${name}`))].join('\n');
}

test('topbar and dashboard visual contracts have semantic owners instead of chronological patch layers', () => {
  const layout = read('src/app/layout.js');

  assert.match(layout, /import '\.\/styles\/shell\.css';/);
  assert.match(layout, /import '\.\/styles\/dashboard\.css';/);
  assert.doesNotMatch(layout, /enhancements\.css|fixes\.css|followup-fixes\.css|topbar-dashboard-polish\.css/);
});

test('topbar keeps popovers visible while only the decorative emblem layer clips the heptagon', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  const css = read('src/app/styles/shell.css');

  assert.match(shell, /<header className="topbar">[\s\S]*?<div className="topbar-emblem-clip"><Heptagon variant="hept-topbar" \/><\/div>/);
  assert.match(css, /\.topbar\s*\{[^}]*overflow:\s*visible;/s);
  assert.doesNotMatch(css, /\.topbar\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.topbar-emblem-clip\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*overflow:\s*hidden;[^}]*pointer-events:\s*none;/s);
  assert.match(css, /\.topbar-emblem-clip \.hept-topbar\s*\{[^}]*top:\s*-190px;[^}]*right:\s*-205px;[^}]*left:\s*auto;[^}]*width:\s*320px;[^}]*height:\s*320px;[^}]*transform:\s*none;/s);
  assert.match(css, /\.theme-light \.topbar-emblem-clip \.hept-topbar\s*\{[^}]*opacity:\s*0\.24;/s);

  assert.ok(-190 + 320 / 2 < 0);
  assert.ok(-205 + 320 / 2 < 0);
});

test('marka amblemi preference hides the topbar emblem as well as the sidebar emblem', () => {
  const tweaks = read('src/hooks/useApplyTweaks.js');
  const css = read('src/app/styles/shell.css');

  assert.match(tweaks, /classList\.toggle\('no-emblem',\s*!tweaks\.showEmblem\)/);
  assert.match(css, /body\.no-emblem \.topbar-emblem-clip \.hept-topbar\s*\{[^}]*display:\s*none;[^}]*visibility:\s*hidden;/s);
});

test('selected project identity remains at the true horizontal center with distinct code and name styling', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  const css = read('src/app/styles/shell.css');

  assert.match(shell, /topbar-project-code/);
  assert.match(shell, /topbar-project-separator/);
  assert.match(shell, /topbar-project-name/);

  assert.match(css, /\.topbar-project-context\s*\{[^}]*position:\s*absolute;[^}]*right:\s*auto;[^}]*left:\s*50%;[^}]*transform:\s*translate\(-50%, -50%\);[^}]*height:\s*32px;/s);
  assert.match(css, /\.topbar-project-code\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*color:\s*var\(--text-muted\);/s);
  assert.match(css, /\.topbar-project-separator\s*\{[^}]*width:\s*1px;[^}]*height:\s*15px;[^}]*font-size:\s*0;/s);
  assert.match(css, /\.topbar-project-context strong\.topbar-project-name\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*color:\s*color-mix\(in oklab, var\(--accent\) 78%, var\(--text\)\);[^}]*line-height:\s*1;/s);
  assert.match(css, /\.theme-light \.topbar-project-context strong\.topbar-project-name\s*\{[^}]*color:\s*color-mix\(in oklab, var\(--accent\) 68%, var\(--text\)\);/s);
});

test('Durum dağılımı uses semantic dashboard structure with the exact accepted dimensions', () => {
  const css = read('src/app/styles/dashboard.css');
  const dashboard = read('src/features/dashboard/DashboardView.jsx');
  const ui = read('src/components/ui.jsx');
  const allCss = readAppCss();

  assert.match(dashboard, /className="dashboard-main-grid"/);
  assert.match(dashboard, /className="card dashboard-status-card"/);
  assert.match(dashboard, /className="dashboard-status-body"/);
  assert.match(dashboard, /className="dashboard-status-chart"/);
  assert.match(dashboard, /className="col dashboard-status-legend"/);

  assert.match(css, /\.dashboard-status-body\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(168px, 1fr\) minmax\(132px, 188px\);[^}]*min-height:\s*214px;/s);
  assert.match(css, /\.dashboard-status-chart\s*\{[^}]*width:\s*clamp\(174px, 13vw, 190px\);[^}]*height:\s*clamp\(174px, 13vw, 190px\);/s);
  assert.match(css, /\.dashboard-status-chart > svg\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/s);
  assert.match(css, /\.dashboard-status-legend\s*\{[^}]*max-width:\s*188px;/s);
  assert.match(css, /\.dashboard-status-card \.donut-leg-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;[^}]*gap:\s*12px;[^}]*padding:\s*5px 6px;/s);

  assert.doesNotMatch(css, /\[style\*=/);
  assert.doesNotMatch(css, /\.card:nth-child/);
  assert.doesNotMatch(css, /svg\[viewBox=/);

  // The generic Donut interaction is unchanged: selected slices keep the translate/bounce behavior.
  // The lift distance now lives in the named DONUT_LIFT constant so the viewBox padding can be
  // derived from it, but the mechanism (polar offset of the selected slice) is identical.
  assert.match(ui, /Donut chart \(SVG\) — with click-to-select \+ bounce animation/);
  assert.match(ui, /const DONUT_LIFT = \d+;/);
  assert.match(ui, /const tx = isSelected \? Math\.cos\(rad\) \* DONUT_LIFT : 0;/);
  assert.match(ui, /const ty = isSelected \? Math\.sin\(rad\) \* DONUT_LIFT : 0;/);
  assert.match(ui, /translate\(\$\{tx\}px, \$\{ty\}px\)/);

  // No rejected forced segment pinning or 214px SVG override may return.
  assert.doesNotMatch(allCss, /> svg > g\s*\{[^}]*transform:\s*none\s*!important;/s);
  assert.doesNotMatch(allCss, /> div:first-child > svg\s*\{[^}]*width:\s*214px\s*!important;/s);
});

test('compact dashboard preserves the accepted 1280px status-card breakpoint', () => {
  const css = read('src/app/styles/dashboard.css');

  assert.match(
    css,
    /@media \(max-width: 1280px\)[\s\S]*?\.dashboard-trend-card,[\s\S]*?\.dashboard-status-card\s*\{\s*grid-column:\s*1 \/ -1;/s
  );
  assert.match(
    css,
    /@media \(max-width: 1280px\)[\s\S]*?\.dashboard-status-body\s*\{[^}]*grid-template-columns:\s*minmax\(184px, 220px\) minmax\(160px, 220px\);[^}]*gap:\s*28px;/s
  );
  assert.doesNotMatch(css, /@media \(max-width: 1500px\)[\s\S]*?donut-leg-row/s);
});
