import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NAV_ITEMS, PAGE_META } from '../src/components/shell/navigation.js';
import { COLOR_MAP } from '../src/lib/colors.js';
import { TWEAK_DEFAULTS } from '../src/lib/tweaks-defaults.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const TEST = path.join(ROOT, 'test');
const JS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs']);

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function sourceFiles(directory = SRC) {
  return walk(directory).filter((file) => JS_EXTENSIONS.has(path.extname(file)));
}

function textFiles() {
  return [...walk(SRC), ...walk(TEST), path.join(ROOT, 'package.json'), path.join(ROOT, 'next.config.mjs')]
    .filter((file) => fs.existsSync(file) && ['.js', '.jsx', '.mjs', '.css', '.json', '.md', '.yml', '.yaml'].includes(path.extname(file)));
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function toRelative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function importSpecifiers(source) {
  const specifiers = [];
  const pattern = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = pattern.exec(source))) specifiers.push(match[1] || match[2]);
  return specifiers;
}

function resolveRelativeImport(file, specifier) {
  const base = path.resolve(path.dirname(file), specifier);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.json`,
    `${base}.css`,
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
    path.join(base, 'index.mjs')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function isWithin(file, directory) {
  const relative = path.relative(directory, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function importedProjectTargets(file) {
  const source = fs.readFileSync(file, 'utf8');
  return importSpecifiers(source)
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => ({ specifier, target: resolveRelativeImport(file, specifier) }))
    .filter((item) => item.target);
}

function assertLayerDoesNotReach(layer, forbiddenLayers) {
  const files = sourceFiles(path.join(SRC, layer));
  const violations = [];
  for (const file of files) {
    for (const { specifier, target } of importedProjectTargets(file)) {
      for (const forbidden of forbiddenLayers) {
        if (isWithin(target, path.join(SRC, forbidden))) {
          violations.push(`${toRelative(file)} -> ${specifier}`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
}

test("bütün göreli içe aktarma ve yeniden dışa aktarma depo dosyasına çözülür", () => {
  const unresolved = [];
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source).filter((value) => value.startsWith('.'))) {
      if (!resolveRelativeImport(file, specifier)) unresolved.push(`${toRelative(file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(unresolved, []);
});

test("özellik modülü sahte başlangıç verisini doğrudan içe aktarmaz", () => {
  const violations = sourceFiles(path.join(SRC, 'features')).filter((file) =>
    importSpecifiers(fs.readFileSync(file, 'utf8')).some((specifier) => specifier.includes('/data/mock'))
  ).map(toRelative);
  assert.deepEqual(violations, []);
});

test("özellik modülü eski uyumluluk veri dışa aktarımına bağlanmaz", () => {
  const violations = sourceFiles(path.join(SRC, 'features')).filter((file) =>
    importSpecifiers(fs.readFileSync(file, 'utf8')).some((specifier) => specifier.includes('/lib/data'))
  ).map(toRelative);
  assert.deepEqual(violations, []);
});

test("alan katmanı uygulama ve altyapıdan bağımsız kalır", () => {
  assertLayerDoesNotReach('domain', ['data', 'state', 'features', 'components', 'app', 'hooks']);
});

test("çizelgeleme katmanı veri durum ve arayüzden bağımsız kalır", () => {
  assertLayerDoesNotReach('scheduling', ['data', 'state', 'features', 'components', 'app', 'hooks']);
});

test("veri katmanı durum veya arayüze bağlanmaz", () => {
  assertLayerDoesNotReach('data', ['state', 'features', 'components', 'app']);
});

test("durum katmanı özellik veya kabuk arayüzüne bağlanmaz", () => {
  assertLayerDoesNotReach('state', ['features', 'components', 'app']);
});

test("alan çizelgeleme ve veri katmanları React içe aktarmaz", () => {
  const violations = [];
  for (const layer of ['domain', 'scheduling', 'data']) {
    for (const file of sourceFiles(path.join(SRC, layer))) {
      const imports = importSpecifiers(fs.readFileSync(file, 'utf8'));
      if (imports.some((specifier) => specifier === 'react' || specifier.startsWith('react/'))) {
        violations.push(toRelative(file));
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("ortak görsel öğeler uygulama durumu veya sahte veri içe aktarmaz", () => {
  const files = ['src/components/icons.jsx', 'src/components/ui.jsx', 'src/components/ui-extras.jsx'];
  for (const relativePath of files) {
    const imports = importSpecifiers(read(relativePath));
    assert.equal(imports.some((specifier) => specifier.includes('/state/')), false, relativePath);
    assert.equal(imports.some((specifier) => specifier.includes('/data/mock')), false, relativePath);
  }
});

test("kaynak kodda yasak çalışma zamanı CDN veya uzak yazı tipi bağımlılığı bulunmaz", () => {
  const forbiddenHosts = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'esm.sh', 'skypack.dev'];
  const violations = [];
  for (const file of walk(SRC)) {
    if (!['.js', '.jsx', '.mjs', '.css'].includes(path.extname(file))) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const host of forbiddenHosts) {
      if (source.includes(host)) violations.push(`${toRelative(file)} -> ${host}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("JavaScript modülü uzak URL üzerinden yürütülebilir kod içe aktarmaz", () => {
  const violations = [];
  for (const file of sourceFiles()) {
    for (const specifier of importSpecifiers(fs.readFileSync(file, 'utf8'))) {
      if (/^https?:\/\//i.test(specifier)) violations.push(`${toRelative(file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("kaynak ve sınamada çözülmemiş birleştirme işareti bulunmaz", () => {
  const violations = [];
  for (const file of textFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    if (/^(<<<<<<<|=======|>>>>>>>)/m.test(source)) violations.push(toRelative(file));
  }
  assert.deepEqual(violations, []);
});

test("eski karma modüller kaldırılmış kalır", () => {
  for (const relativePath of [
    'src/components/AppShell.jsx',
    'src/components/views-a.jsx',
    'src/components/views-b.jsx',
    'src/components/settings.jsx'
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, relativePath)), false, relativePath);
  }
});

test("bütün ana özellik giriş modülleri vardır", () => {
  for (const relativePath of [
    'src/features/dashboard/DashboardView.jsx',
    'src/features/tasks/TasksView.jsx',
    'src/features/wbs/WbsView.jsx',
    'src/features/calendar/CalendarView.jsx',
    'src/features/gantt/GanttView.jsx',
    'src/features/gantt/WorkspaceGanttView.jsx',
    'src/features/kanban/KanbanView.jsx',
    'src/features/reports/ReportsView.jsx',
    'src/features/team/TeamView.jsx',
    'src/features/settings/SettingsView.jsx',
    'src/features/task-detail/TaskDetailOverlay.jsx'
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, relativePath)), true, relativePath);
  }
});

test("Next.js sayfası tarayıcı kabuğunu sunucu çizimsiz dinamik aktarmada tutar", () => {
  const source = read('src/app/page.js');
  assert.match(source, /dynamic\(\(\)\s*=>\s*import\(['"]\.\.\/components\/shell\/ApplicationRoot['"]\)/);
  assert.match(source, /ssr\s*:\s*false/);
});

test("Next.js katı kipi açık kalır", () => {
  const source = read('next.config.mjs');
  assert.match(source, /reactStrictMode\s*:\s*true/);
});

test("paket betikleri sınama ve üretim derlemesi komutlarını korur", () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts?.test, 'node --test');
  assert.equal(pkg.scripts?.build, 'next build');
  // MERGEN Rota 8008 portunda çalışır; 8009 MERGEN Bilge'ye aittir.
  assert.equal(pkg.scripts?.dev, 'next dev -p 8008');
  assert.equal(pkg.scripts?.start, 'next start');
  assert.equal(pkg.scripts?.['start:prod'], 'next start -H 0.0.0.0 -p 8008');
});

test("kalite iş akışı kurulum sınama ve üretim derlemesini sürekli çalıştırır", () => {
  const source = read('.github/workflows/quality.yml');
  assert.match(source, /run:\s*npm ci/);
  assert.match(source, /run:\s*npm test/);
  assert.match(source, /npm run build/);
  // Boru hattı `tee` yüzünden başarısızlığı yutmaz.
  assert.match(source, /set -o pipefail/);
  assert.match(source, /pull_request:/);
  assert.match(source, /branches:\s*\n\s*- main/);
});

test("gezinme kimlikleri tekildir; her öğenin sayfa üstverisi vardır", () => {
  const ids = NAV_ITEMS.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(Object.keys(PAGE_META).sort(), [...ids].sort());
  for (const item of NAV_ITEMS) {
    assert.equal(typeof item.label, 'string');
    assert.notEqual(item.label.trim(), '');
    assert.equal(typeof PAGE_META[item.id]?.title, 'string');
    assert.notEqual(PAGE_META[item.id].title.trim(), '');
  }
});

test("her gezinme simgesi ortak simge kataloğunda uygulanır", () => {
  const iconSource = read('src/components/icons.jsx');
  const iconNames = new Set([...iconSource.matchAll(/^\s{2}([A-Z][A-Za-z0-9]*):/gm)].map((match) => match[1]));
  const missing = NAV_ITEMS.map((item) => item.icon).filter((name) => !iconNames.has(name));
  assert.deepEqual(missing, []);
});

test("bütün doğrudan Icons başvuruları uygulanmış simge adına çözülür", () => {
  const iconSource = read('src/components/icons.jsx');
  const iconNames = new Set([...iconSource.matchAll(/^\s{2}([A-Z][A-Za-z0-9]*):/gm)].map((match) => match[1]));
  const missing = new Set();
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/Icons\.([A-Z][A-Za-z0-9]*)/g)) {
      if (!iconNames.has(match[1])) missing.add(`${match[1]} in ${toRelative(file)}`);
    }
  }
  assert.deepEqual([...missing], []);
});

test("bütün yapılandırılmış proje renk değişkenleri genel CSS içinde tanımlıdır", () => {
  const css = read('src/app/globals.css');
  for (const value of Object.values(COLOR_MAP)) {
    const variable = value.match(/var\((--[^)]+)\)/)?.[1];
    assert.ok(variable, value);
    assert.match(css, new RegExp(`${variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`));
  }
});

test("genel CSS koyu ve açık temanın tam belirteç bloklarını tanımlar", () => {
  const css = read('src/app/globals.css');
  for (const theme of ['dark', 'light']) {
    assert.match(css, new RegExp(`\\.theme-${theme}\\s*\\{`));
  }
  for (const variable of ['--bg', '--bg-elev', '--border', '--text', '--text-muted', '--shadow-sm', '--cal-weekend-bg', '--cal-holiday-bg']) {
    const occurrences = [...css.matchAll(new RegExp(`${variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'g'))].length;
    assert.ok(occurrences >= 2, `${variable} should be defined for both themes`);
  }
});

test("ince ayar varsayılanları desteklenen gezinme ve temaya işaret eder", () => {
  assert.ok(['dark', 'light'].includes(TWEAK_DEFAULTS.theme));
  assert.ok(['compact', 'balanced', 'spacious'].includes(TWEAK_DEFAULTS.density));
  assert.equal(NAV_ITEMS.some((item) => item.id === TWEAK_DEFAULTS.landingView), true);
  assert.equal(Number.isFinite(TWEAK_DEFAULTS.fontScale), true);
  assert.ok(TWEAK_DEFAULTS.fontScale > 0);
  assert.match(TWEAK_DEFAULTS.accent, /^#[0-9a-f]{6}$/i);
  assert.equal(typeof TWEAK_DEFAULTS.calLarge, 'boolean');
  assert.equal(TWEAK_DEFAULTS.reduceMotion, true);
  assert.equal(TWEAK_DEFAULTS.showEmblem, true);
});

test("uygulama kabuğunda her gezinme hedefinin çizim dalı vardır", () => {
  const source = read('src/components/shell/AppShell.jsx');
  const renderedIds = new Set([...source.matchAll(/case\s+['\"]([^'\"]+)['\"]\s*:/g)].map((match) => match[1]));
  assert.deepEqual([...renderedIds].sort(), NAV_ITEMS.map((item) => item.id).sort());
});

test("kök düzen Türkçe belge üstverisini ve varsayılan koyu temayı korur", () => {
  const source = read('src/app/layout.js');
  assert.match(source, /title:\s*['\"]MERGEN Rota — Görev Yönetimi['\"]/);
  assert.match(source, /<html lang=['\"]tr['\"]>/);
  assert.match(source, /<body className=['\"]theme-dark['\"]>/);
  assert.match(source, /href=\{FAVICON\}/);
});

test("paket kilidinin kök bildirimi paket bağımlılıklarıyla eş kalır", () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const root = lock.packages?.[''];
  assert.ok(root);
  assert.deepEqual(root.dependencies || {}, pkg.dependencies || {});
  assert.deepEqual(root.devDependencies || {}, pkg.devDependencies || {});
});

test("varsayılan vurgu DOM ince ayar kancasınca desteklenir", () => {
  const source = read('src/hooks/useApplyTweaks.js');
  assert.match(source, new RegExp(`['\"]${TWEAK_DEFAULTS.accent.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}['\"]\\s*:`));
});

test("depo kaynak ağacında boş JavaScript modülü yoktur", () => {
  const empty = sourceFiles().filter((file) => fs.readFileSync(file, 'utf8').trim().length === 0).map(toRelative);
  assert.deepEqual(empty, []);
});
