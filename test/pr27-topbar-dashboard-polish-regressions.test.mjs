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

test('topbar shows only a small lower heptagon slice without clipping header popovers', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  const css = read('src/app/topbar-dashboard-polish.css');

  assert.match(shell, /<header className="topbar">[\s\S]*?<div className="topbar-emblem-clip"><Heptagon variant="hept-topbar" \/><\/div>/);

  assert.match(css, /\.topbar\s*\{[^}]*overflow:\s*visible;/s);
  assert.doesNotMatch(css, /\.topbar\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.topbar-emblem-clip\s*\{[^}]*position:\s*absolute !important;[^}]*inset:\s*0 !important;[^}]*overflow:\s*hidden !important;/s);
  assert.match(css, /\.topbar-emblem-clip \.hept-topbar\s*\{[^}]*top:\s*-190px !important;[^}]*right:\s*-205px !important;[^}]*left:\s*auto !important;[^}]*width:\s*320px !important;[^}]*height:\s*320px !important;[^}]*transform:\s*none !important;/s);
  assert.match(css, /\.theme-light \.topbar-emblem-clip \.hept-topbar\s*\{[^}]*opacity:\s*0\.24 !important;/s);

  assert.ok(-190 + 320 / 2 < 0);
  assert.ok(-205 + 320 / 2 < 0);
});

test('marka amblemi preference hides the topbar emblem as well as the sidebar emblem', () => {
  const tweaks = read('src/hooks/useApplyTweaks.js');
  const css = read('src/app/topbar-dashboard-polish.css');

  assert.match(tweaks, /classList\.toggle\('no-emblem',\s*!tweaks\.showEmblem\)/);
  assert.match(css, /body\.no-emblem \.topbar-emblem-clip \.hept-topbar\s*\{[^}]*display:\s*none !important;[^}]*visibility:\s*hidden !important;/s);
});

test('selected project identity is forced to the true horizontal center instead of the flex spacer', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  const css = read('src/app/topbar-dashboard-polish.css');

  assert.match(shell, /topbar-project-code/);
  assert.match(shell, /topbar-project-separator/);
  assert.match(shell, /topbar-project-name/);

  assert.match(css, /\.topbar-project-context\s*\{[^}]*position:\s*absolute !important;[^}]*right:\s*auto !important;[^}]*left:\s*50% !important;[^}]*transform:\s*translate\(-50%, -50%\) !important;[^}]*height:\s*32px;/s);
  assert.match(css, /\.topbar-project-code\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*color:\s*var\(--text-muted\);/s);
  assert.match(css, /\.topbar-project-separator\s*\{[^}]*width:\s*1px;[^}]*height:\s*15px;[^}]*font-size:\s*0;/s);
  assert.match(css, /\.topbar-project-context strong\.topbar-project-name\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*color:\s*color-mix\(in oklab, var\(--accent\) 78%, var\(--text\)\);[^}]*line-height:\s*1;/s);
  assert.match(css, /\.theme-light \.topbar-project-context strong\.topbar-project-name\s*\{[^}]*color:\s*color-mix\(in oklab, var\(--accent\) 68%, var\(--text\)\);/s);
});

test('Durum dağılımı is restored to the exact layout and interaction state from the start of PR28', () => {
  const css = read('src/app/topbar-dashboard-polish.css');
  const ui = read('src/components/ui.jsx');

  // Layout values are the PR28 starting values, before the later 214px experiments.
  assert.match(css, /> \.card:nth-child\(2\) > \.row:last-child\s*\{[^}]*display:\s*grid !important;[^}]*grid-template-columns:\s*minmax\(168px, 1fr\) minmax\(132px, 188px\);[^}]*min-height:\s*214px;/s);
  assert.match(css, /> \.card:nth-child\(2\) > \.row:last-child > div:first-child\s*\{[^}]*width:\s*clamp\(174px, 13vw, 190px\);[^}]*height:\s*clamp\(174px, 13vw, 190px\);/s);
  assert.match(css, /\.content-ozet svg\[viewBox='-10 -10 170 170'\]\s*\{[^}]*width:\s*100% !important;[^}]*height:\s*100% !important;/s);
  assert.match(css, /> \.card:nth-child\(2\) > \.row:last-child > \.col\s*\{[^}]*max-width:\s*188px;/s);
  assert.match(css, /\.content-ozet \.donut-leg-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;[^}]*gap:\s*12px !important;[^}]*padding:\s*5px 6px !important;/s);

  // The generic Donut component is also restored exactly: selected slices use
  // the original translate/bounce interaction rather than PR28 source edits.
  assert.match(ui, /Donut chart \(SVG\) — with click-to-select \+ bounce animation/);
  assert.match(ui, /const tx = isSelected \? Math\.cos\(rad\) \* 10 : 0;/);
  assert.match(ui, /const ty = isSelected \? Math\.sin\(rad\) \* 10 : 0;/);
  assert.match(ui, /translate\(\$\{tx\}px, \$\{ty\}px\)/);

  // No PR28-only forced segment pinning or 214px SVG override may remain.
  assert.doesNotMatch(css, /> svg > g\s*\{[^}]*transform:\s*none !important;/s);
  assert.doesNotMatch(css, /> div:first-child > svg\s*\{[^}]*width:\s*214px !important;/s);
});

test('compact dashboard uses the same 1280px status-card breakpoint as at the start of PR28', () => {
  const css = read('src/app/topbar-dashboard-polish.css');

  assert.match(
    css,
    /@media \(max-width: 1280px\)[\s\S]*?> \.card:first-child,[\s\S]*?> \.card:nth-child\(2\)\s*\{[^}]*grid-column:\s*1 \/ -1;/s
  );
  assert.match(
    css,
    /@media \(max-width: 1280px\)[\s\S]*?> \.card:nth-child\(2\) > \.row:last-child\s*\{[^}]*grid-template-columns:\s*minmax\(184px, 220px\) minmax\(160px, 220px\);[^}]*gap:\s*28px !important;/s
  );
  assert.doesNotMatch(css, /@media \(max-width: 1500px\)[\s\S]*?donut-leg-row/s);
});
