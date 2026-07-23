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

  // P1 regression: the header itself must not clip Dışa aktar or other popovers.
  // Only the decorative overlay is allowed to clip the rotating emblem.
  assert.match(css, /\.topbar\s*\{[^}]*overflow:\s*visible;/s);
  assert.doesNotMatch(css, /\.topbar\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.topbar-emblem-clip\s*\{[^}]*position:\s*absolute !important;[^}]*inset:\s*0 !important;[^}]*overflow:\s*hidden !important;/s);

  // The vertical center is moved 15px south while the horizontal center stays put.
  assert.match(css, /\.topbar-emblem-clip \.hept-topbar\s*\{[^}]*top:\s*-190px !important;[^}]*right:\s*-205px !important;[^}]*left:\s*auto !important;[^}]*width:\s*320px !important;[^}]*height:\s*320px !important;[^}]*transform:\s*none !important;/s);
  assert.match(css, /\.theme-light \.topbar-emblem-clip \.hept-topbar\s*\{[^}]*opacity:\s*0\.24 !important;/s);

  // The rotation center remains outside the visible header, but is now closer
  // to the top edge: -190 + 320 / 2 = -30px; right remains -45px.
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

test('Durum dağılımı keeps the enlarged donut intact when a segment is selected', () => {
  const css = read('src/app/topbar-dashboard-polish.css');

  assert.match(css, /> \.card:nth-child\(2\) > \.row:last-child\s*\{[^}]*display:\s*grid !important;[^}]*grid-template-columns:\s*minmax\(214px, 1fr\) minmax\(126px, 150px\);[^}]*min-height:\s*236px;/s);
  assert.match(css, /> \.card:nth-child\(2\) > \.row:last-child > div:first-child\s*\{[^}]*width:\s*214px !important;[^}]*height:\s*214px !important;/s);
  assert.match(css, /> \.card:nth-child\(2\) > \.row:last-child > div:first-child > svg\s*\{[^}]*width:\s*214px !important;[^}]*height:\s*214px !important;/s);

  // Dashboard Donut translates selected SVG groups inline. At the dash seam this
  // can visually split a single selected arc into detached pieces, so the final
  // dashboard layer pins those segment groups to the ring.
  assert.match(css, /> \.card:nth-child\(2\) > \.row:last-child > div:first-child > svg > g\s*\{[^}]*transform:\s*none !important;/s);

  assert.match(css, /> \.card:nth-child\(2\) > \.row:last-child > \.col\s*\{[^}]*max-width:\s*150px;/s);
  assert.match(css, /\.content-ozet \.donut-leg-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;[^}]*gap:\s*8px !important;/s);
});

test('compact desktop widths stack trend and status cards before the 214px donut can overflow', () => {
  const css = read('src/app/topbar-dashboard-polish.css');

  // P2 regression: around 1280px viewport the status card used to remain in a
  // narrow third column, while its 214px donut + legend needed much more width.
  assert.match(
    css,
    /@media \(max-width: 1500px\)[\s\S]*?div\[style\*='grid-template-columns: 1fr 1fr'\]:has\(\.donut-leg-row\)\s*\{[^}]*grid-template-columns:\s*1fr !important;/s
  );
  assert.match(
    css,
    /@media \(max-width: 1500px\)[\s\S]*?> \.card:first-child,[\s\S]*?> \.card:nth-child\(2\)\s*\{[^}]*grid-column:\s*1 \/ -1 !important;/s
  );
  assert.match(
    css,
    /@media \(max-width: 1500px\)[\s\S]*?> \.card:nth-child\(2\) > \.row:last-child\s*\{[^}]*grid-template-columns:\s*minmax\(214px, 230px\) minmax\(150px, 190px\);/s
  );
});
