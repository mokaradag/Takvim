import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('final topbar and dashboard polish stylesheet is loaded after earlier fix layers', () => {
  const layout = read('src/app/layout.js');

  const followupIndex = layout.indexOf("import './followup-fixes.css';");
  const polishIndex = layout.indexOf("import './topbar-dashboard-polish.css';");

  assert.ok(followupIndex >= 0, 'followup-fixes.css import is missing');
  assert.ok(polishIndex > followupIndex, 'final polish layer must load after followup-fixes.css');
});

test('topbar keeps the rotating heptagon in a visible clipped viewport on every application page', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  const css = read('src/app/topbar-dashboard-polish.css');

  assert.match(shell, /<header className="topbar">[\s\S]*?<div className="topbar-emblem-clip"><Heptagon variant="hept-topbar" \/><\/div>/);
  assert.match(css, /\.topbar-emblem-clip\s*\{[^}]*width:\s*214px;[^}]*height:\s*100%;[^}]*overflow:\s*hidden;[^}]*z-index:\s*1;/s);
  assert.match(css, /\.topbar-emblem-clip \.hept-topbar\s*\{[^}]*display:\s*block !important;[^}]*visibility:\s*visible !important;[^}]*top:\s*50% !important;[^}]*right:\s*-34px !important;[^}]*width:\s*176px !important;[^}]*height:\s*176px !important;/s);
  assert.match(css, /\.theme-light \.topbar-emblem-clip \.hept-topbar\s*\{[^}]*opacity:\s*0\.34 !important;/s);
});

test('selected project code and name form one aligned theme-safe identity capsule', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  const css = read('src/app/topbar-dashboard-polish.css');

  assert.match(shell, /topbar-project-code/);
  assert.match(shell, /topbar-project-separator/);
  assert.match(shell, /topbar-project-name/);

  assert.match(css, /\.topbar-project-context\s*\{[^}]*height:\s*34px;[^}]*gap:\s*0;[^}]*border-radius:\s*var\(--r-pill\);[^}]*backdrop-filter:\s*blur\(10px\);/s);
  assert.match(css, /\.topbar-project-code\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*color:\s*color-mix\(in oklab, var\(--text-muted\) 88%, var\(--text\)\);/s);
  assert.match(css, /\.topbar-project-separator\s*\{[^}]*width:\s*1px;[^}]*height:\s*16px;[^}]*font-size:\s*0;/s);
  assert.match(css, /\.topbar-project-context strong\.topbar-project-name\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*color:\s*color-mix\(in oklab, var\(--accent\) 82%, var\(--text\)\);[^}]*line-height:\s*1;/s);
  assert.match(css, /\.theme-light \.topbar-project-context strong\.topbar-project-name\s*\{[^}]*color:\s*color-mix\(in oklab, var\(--accent\) 72%, var\(--text\)\);/s);
});

test('Durum dağılımı uses vertical space for a larger donut and a compact label-count legend', () => {
  const css = read('src/app/topbar-dashboard-polish.css');

  assert.match(css, /> \.card:nth-child\(2\) > \.row:last-child\s*\{[^}]*display:\s*grid !important;[^}]*grid-template-columns:\s*minmax\(168px, 1fr\) minmax\(132px, 188px\);[^}]*min-height:\s*214px;/s);
  assert.match(css, /> \.card:nth-child\(2\) > \.row:last-child > div:first-child\s*\{[^}]*width:\s*clamp\(174px, 13vw, 190px\);[^}]*height:\s*clamp\(174px, 13vw, 190px\);/s);
  assert.match(css, /svg\[viewBox='-10 -10 170 170'\]\s*\{[^}]*width:\s*100% !important;[^}]*height:\s*100% !important;/s);
  assert.match(css, /\.content-ozet \.donut-leg-row\s*\{[^}]*display:\s*grid !important;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;[^}]*gap:\s*12px !important;[^}]*max-width:\s*none;/s);
  assert.match(css, /@media \(max-width: 1280px\)[\s\S]*?> \.card:first-child,[\s\S]*?> \.card:nth-child\(2\) \{\s*grid-column:\s*1 \/ -1;/s);
});
