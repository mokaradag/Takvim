import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'src/app');
const STYLES = path.join(APP, 'styles');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function cssFiles() {
  return [path.join(APP, 'globals.css'), ...fs.readdirSync(STYLES)
    .filter((name) => name.endsWith('.css'))
    .map((name) => path.join(STYLES, name))];
}

function selectorOwners(selector) {
  return cssFiles()
    .filter((file) => fs.readFileSync(file, 'utf8').includes(selector))
    .map((file) => path.relative(ROOT, file).replaceAll('\\', '/'));
}

test('root layout loads responsibility-based styles and obsolete chronology layers stay deleted', () => {
  const layout = read('src/app/layout.js');
  const obsolete = [
    'src/app/enhancements.css',
    'src/app/fixes.css',
    'src/app/followup-fixes.css',
    'src/app/topbar-dashboard-polish.css'
  ];

  for (const file of obsolete) {
    assert.equal(fs.existsSync(path.join(ROOT, file)), false, `${file} must not return as a permanent override layer`);
  }

  assert.doesNotMatch(layout, /enhancements\.css|fixes\.css|followup-fixes\.css|topbar-dashboard-polish\.css/);
  assert.match(layout, /styles\/shell\.css/);
  assert.match(layout, /styles\/dashboard\.css/);
  assert.match(layout, /styles\/features\.css/);
});

test('core application CSS does not infer layout from serialized inline style text', () => {
  for (const file of cssFiles()) {
    const css = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(css, /\[style\*=/, `${path.relative(ROOT, file)} must use semantic classes instead of style-string selectors`);
  }
});

test('major topbar selectors have one authoritative stylesheet owner', () => {
  for (const selector of ['.topbar {', '.topbar-project-context {', '.topbar-emblem-clip {']) {
    assert.deepEqual(selectorOwners(selector), ['src/app/styles/shell.css'], `${selector} should have one shell owner`);
  }
});

test('dashboard structure uses semantic classes instead of card position or DOM inference', () => {
  const dashboardCss = read('src/app/styles/dashboard.css');
  const dashboard = read('src/features/dashboard/DashboardView.jsx');

  assert.doesNotMatch(dashboardCss, /:has\(/);
  assert.doesNotMatch(dashboardCss, /nth-child\(/);
  assert.doesNotMatch(dashboardCss, /\[style\*=/);
  for (const className of [
    'dashboard-main-grid',
    'dashboard-trend-card',
    'dashboard-status-card',
    'dashboard-status-body',
    'dashboard-status-chart',
    'dashboard-status-legend',
    'dashboard-bottom-grid'
  ]) {
    assert.match(dashboard, new RegExp(`className="[^"]*${className}[^"]*"`));
  }
});

test('application layering avoids unexplained four-digit z-index escalation', () => {
  const sourceFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(css|js|jsx|mjs)$/.test(entry.name)) sourceFiles.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));

  for (const file of sourceFiles) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /z-index:\s*[1-9]\d{3,}/, `${path.relative(ROOT, file)} contains a four-digit z-index`);
    assert.doesNotMatch(source, /zIndex:\s*[1-9]\d{3,}/, `${path.relative(ROOT, file)} contains a four-digit inline z-index`);
  }
});
