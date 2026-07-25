import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TASK_STATUSES, PRIORITIES } from '../src/domain/constants/index.js';
import { DOMAIN_MODEL_VERSION } from '../src/domain/models/index.js';
import { CALENDARS } from '../src/data/mock/calendars.js';
import { appRepository } from '../src/data/index.js';
import { assertAppRepository } from '../src/data/contracts/appRepository.js';
import { DEFAULT_CALENDAR } from '../src/scheduling/calendars/index.js';
import { TWEAK_DEFAULTS } from '../src/lib/tweaks-defaults.js';
import { NAV_ITEMS, PAGE_META } from '../src/components/shell/navigation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

const runtimeModuleFiles = [
  ...walk(path.join(ROOT, 'src/domain')),
  ...walk(path.join(ROOT, 'src/scheduling')),
  ...walk(path.join(ROOT, 'src/data')),
  path.join(ROOT, 'src/state/appState.js'),
  path.join(ROOT, 'src/state/persistence.js'),
  path.join(ROOT, 'src/state/workspacePreference.js'),
  ...walk(path.join(ROOT, 'src/state/selectors')),
  path.join(ROOT, 'src/lib/colors.js'),
  path.join(ROOT, 'src/lib/zoom.js'),
  path.join(ROOT, 'src/lib/tweaks-defaults.js'),
  path.join(ROOT, 'src/components/shell/navigation.js')
]
  .filter((file) => path.extname(file) === '.js')
  .filter((file, index, files) => files.indexOf(file) === index)
  .sort();

for (const file of runtimeModuleFiles) {
  test(`runtime-safe module imports without top-level failure: ${relative(file)}`, async () => {
    await assert.doesNotReject(import(pathToFileURL(file).href));
  });
}

test('runtime smoke set covers all pure application layers', () => {
  const paths = runtimeModuleFiles.map(relative);
  for (const prefix of ['src/domain/', 'src/scheduling/', 'src/data/', 'src/state/selectors/']) {
    assert.equal(paths.some((item) => item.startsWith(prefix)), true, prefix);
  }
  for (const required of [
    'src/state/appState.js',
    'src/state/persistence.js',
    'src/state/workspacePreference.js',
    'src/lib/colors.js',
    'src/lib/zoom.js',
    'src/lib/tweaks-defaults.js',
    'src/components/shell/navigation.js'
  ]) {
    assert.equal(paths.includes(required), true, required);
  }
});

test('task status constants are frozen, unique, and canonical', () => {
  assert.equal(Object.isFrozen(TASK_STATUSES), true);
  assert.deepEqual(TASK_STATUSES, {
    TODO: 'todo',
    IN_PROGRESS: 'in_progress',
    DONE: 'done'
  });
  assert.equal(new Set(Object.values(TASK_STATUSES)).size, Object.keys(TASK_STATUSES).length);
});

test('priority definitions are frozen and have deterministic contiguous order', () => {
  assert.equal(Object.isFrozen(PRIORITIES), true);
  const entries = Object.entries(PRIORITIES);
  assert.deepEqual(entries.map(([, priority]) => priority.order), [0, 1, 2, 3]);
  assert.deepEqual(entries.map(([key, priority]) => priority.id), entries.map(([key]) => key));
});

test('every priority has a usable label and color token', () => {
  for (const priority of Object.values(PRIORITIES)) {
    assert.equal(typeof priority.label, 'string');
    assert.ok(priority.label.trim().length > 0);
    assert.equal(typeof priority.color, 'string');
    assert.ok(priority.color.trim().length > 0);
  }
});

test('priority identifiers and labels are unique', () => {
  const priorities = Object.values(PRIORITIES);
  assert.equal(new Set(priorities.map((priority) => priority.id)).size, priorities.length);
  assert.equal(new Set(priorities.map((priority) => priority.label)).size, priorities.length);
});

test('domain model version is a positive integer contract', () => {
  assert.equal(Number.isInteger(DOMAIN_MODEL_VERSION), true);
  assert.ok(DOMAIN_MODEL_VERSION > 0);
});

test('application repository satisfies the public repository contract', () => {
  assert.strictEqual(assertAppRepository(appRepository), appRepository);
  assert.equal(appRepository.kind, 'async-memory');
});

test('application repository loads all canonical snapshot collections', async () => {
  const snapshot = await appRepository.loadSnapshot();
  for (const key of ['calendars', 'projects', 'people', 'wbs', 'tasks', 'baselines', 'taskBaselineSnapshots']) {
    assert.equal(Array.isArray(snapshot[key]), true, key);
  }
});

test('application repository returns isolated snapshots across repeated loads', async () => {
  const first = await appRepository.loadSnapshot();
  const second = await appRepository.loadSnapshot();
  assert.notStrictEqual(first, second);
  for (const key of ['calendars', 'projects', 'people', 'wbs', 'tasks', 'baselines', 'taskBaselineSnapshots']) {
    assert.notStrictEqual(first[key], second[key], key);
  }
});

test('mock calendar identifiers are unique and non-empty', () => {
  assert.ok(CALENDARS.length > 0);
  const ids = CALENDARS.map((calendar) => calendar.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.every((id) => typeof id === 'string' && id.trim().length > 0), true);
});

test('mock calendars use valid unique JavaScript weekday numbers', () => {
  for (const calendar of CALENDARS) {
    assert.ok(Array.isArray(calendar.workingDays));
    assert.ok(calendar.workingDays.length > 0);
    assert.equal(new Set(calendar.workingDays).size, calendar.workingDays.length, calendar.id);
    assert.equal(calendar.workingDays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6), true, calendar.id);
  }
});

test('mock calendars expose explicit timezone and holiday arrays', () => {
  for (const calendar of CALENDARS) {
    assert.equal(typeof calendar.timezone, 'string');
    assert.ok(calendar.timezone.trim().length > 0);
    assert.equal(Array.isArray(calendar.holidays), true);
  }
});

test('mock calendar holidays use unique ISO date keys per calendar', () => {
  for (const calendar of CALENDARS) {
    const dates = calendar.holidays.map((holiday) => holiday.date);
    assert.equal(new Set(dates).size, dates.length, calendar.id);
    for (const date of dates) assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('mock calendars clone default calendar collections instead of aliasing them', () => {
  assert.notStrictEqual(CALENDARS[0].workingDays, DEFAULT_CALENDAR.workingDays);
  assert.notStrictEqual(CALENDARS[0].holidays, DEFAULT_CALENDAR.holidays);
  if (CALENDARS[0].holidays.length && DEFAULT_CALENDAR.holidays.length) {
    assert.notStrictEqual(CALENDARS[0].holidays[0], DEFAULT_CALENDAR.holidays[0]);
  }
  if (CALENDARS.length > 1) {
    assert.notStrictEqual(CALENDARS[0].holidays, CALENDARS[1].holidays);
  }
});

test('tweak defaults expose exactly the settings consumed by the application', () => {
  assert.deepEqual(Object.keys(TWEAK_DEFAULTS).sort(), [
    'accent',
    'appMode',
    'calLarge',
    'density',
    'fontScale',
    'landingView',
    'reduceMotion',
    'showEmblem',
    'theme'
  ]);
});

test('tweak defaults contain serializable primitive values only', () => {
  for (const value of Object.values(TWEAK_DEFAULTS)) {
    assert.ok(['string', 'number', 'boolean'].includes(typeof value));
  }
  assert.doesNotThrow(() => JSON.stringify(TWEAK_DEFAULTS));
});

test('default landing view remains a valid navigation destination', () => {
  assert.equal(NAV_ITEMS.some((item) => item.id === TWEAK_DEFAULTS.landingView), true);
  assert.ok(PAGE_META[TWEAK_DEFAULTS.landingView]);
});

test('navigation definitions contain no duplicate labels or icons', () => {
  assert.equal(new Set(NAV_ITEMS.map((item) => item.label)).size, NAV_ITEMS.length);
  assert.equal(new Set(NAV_ITEMS.map((item) => item.icon)).size, NAV_ITEMS.length);
});

test('application root composes provider, data boundary, shell, and persistence status', () => {
  const source = read('src/components/shell/ApplicationRoot.jsx');
  assert.match(source, /^['"]use client['"];?/m);
  assert.match(source, /<AppStateProvider\b/);
  assert.match(source, /<AppDataBoundary>/);
  assert.match(source, /<AppShell\s*\/>/);
  assert.match(source, /<PersistenceStatus\s*\/>/);
});

test('data boundary has explicit loading, error, retry, and ready branches', () => {
  const source = read('src/components/shell/AppDataBoundary.jsx');
  assert.match(source, /dataStatus\s*===\s*['"]loading['"]/);
  assert.match(source, /dataStatus\s*===\s*['"]error['"]/);
  assert.match(source, /onClick=\{reloadData\}/);
  assert.match(source, /return children;/);
});

test('data boundary presents user-facing Turkish status messages', () => {
  const source = read('src/components/shell/AppDataBoundary.jsx');
  for (const message of ['Veriler yükleniyor...', 'Veriler yüklenemedi.', 'Yeniden Dene']) {
    assert.ok(source.includes(message), message);
  }
});

test('persistence status distinguishes saving, failure, and successful save states', () => {
  const source = read('src/components/shell/PersistenceStatus.jsx');
  for (const message of ['Kaydediliyor...', 'Kaydetme hatası', 'Kaydedildi']) {
    assert.ok(source.includes(message), message);
  }
  assert.match(source, /onClick=\{clearPersistenceError\}/);
});

test('persistence success notification is temporary and cleans up its timer', () => {
  const source = read('src/components/shell/PersistenceStatus.jsx');
  assert.match(source, /setTimeout\(\(\)\s*=>\s*setShowSaved\(false\),\s*1800\)/);
  assert.match(source, /clearTimeout\(timer\)/);
});

test('tweak hook is SSR-safe and falls back when stored preferences are invalid', () => {
  const source = read('src/hooks/useTweaks.js');
  assert.match(source, /typeof window\s*===\s*['"]undefined['"]/);
  assert.match(source, /JSON\.parse\(raw\)/);
  assert.match(source, /catch\s*\{\s*return defaults;\s*\}/s);
});

test('tweak hook persists merged values under a versioned storage key', () => {
  const source = read('src/hooks/useTweaks.js');
  assert.match(source, /mergen_rota_tweaks_v1/);
  assert.match(source, /const next\s*=\s*\{\s*\.\.\.prev,\s*\.\.\.edits\s*\}/s);
  assert.match(source, /localStorage\.setItem\(STORAGE_KEY,\s*JSON\.stringify\(next\)\)/);
});

test('tweak application hook applies every persisted visual preference', () => {
  const source = read('src/hooks/useApplyTweaks.js');
  for (const token of [
    'tweaks.theme',
    'tweaks.accent',
    'tweaks.density',
    'tweaks.fontScale',
    'tweaks.reduceMotion',
    'tweaks.showEmblem'
  ]) {
    assert.ok(source.includes(token), token);
  }
});

test('tweak application hook maps all supported density modes', () => {
  const source = read('src/hooks/useApplyTweaks.js');
  assert.match(source, /tweaks\.density\s*===\s*['"]compact['"]\s*\?\s*0\.85/);
  assert.match(source, /tweaks\.density\s*===\s*['"]spacious['"]\s*\?\s*1\.15/);
  assert.match(source, /--density/);
});

test('tweak application hook supports the configured default accent', () => {
  const source = read('src/hooks/useApplyTweaks.js');
  assert.ok(source.includes(`'${TWEAK_DEFAULTS.accent}'`) || source.includes(`"${TWEAK_DEFAULTS.accent}"`));
});

test('all client shell modules that directly use React hooks declare a client boundary', () => {
  const shellFiles = walk(path.join(ROOT, 'src/components/shell')).filter((file) => /\.jsx?$/.test(file));
  const violations = [];
  for (const file of shellFiles) {
    const source = fs.readFileSync(file, 'utf8');
    if (/\buse(?:State|Effect|Memo|Callback|Ref|Context|Reducer|LayoutEffect)\s*\(/.test(source)
      && !/^\s*['"]use client['"];?/m.test(source)) {
      violations.push(relative(file));
    }
  }
  assert.deepEqual(violations, []);
});

test('feature view files never import the compatibility data barrel', () => {
  const files = walk(path.join(ROOT, 'src/features')).filter((file) => /\.(?:js|jsx)$/.test(file));
  const violations = files.filter((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return /from\s+['"][^'"]*\/lib\/data(?:\.js)?['"]/.test(source);
  }).map(relative);
  assert.deepEqual(violations, []);
});

test('source files contain no focused or skipped Node test declarations', () => {
  const tests = walk(path.join(ROOT, 'test')).filter((file) => /\.test\.mjs$/.test(file));
  const violations = [];
  for (const file of tests) {
    const source = fs.readFileSync(file, 'utf8');
    if (/\btest\.(?:only|skip|todo)\s*\(/.test(source)) violations.push(relative(file));
  }
  assert.deepEqual(violations, []);
});

test('all test files use strict assertions', () => {
  const tests = walk(path.join(ROOT, 'test')).filter((file) => /\.test\.mjs$/.test(file));
  const violations = tests.filter((file) => !fs.readFileSync(file, 'utf8').includes("node:assert/strict")).map(relative);
  assert.deepEqual(violations, []);
});

test('all test files are discoverable by the configured Node test runner naming convention', () => {
  // `test/helpers/` yalnızca paylaşılan test altyapısını barındırır (uçtan uca
  // yığın kurulumu, bellek içi SQL Server ikizi). Bu dosyalar test tanımlamaz;
  // aşağıdaki ikinci kontrol bunu güvence altına alır.
  const nonConforming = walk(path.join(ROOT, 'test'))
    .filter((file) => path.extname(file) === '.mjs')
    .filter((file) => !file.endsWith('.test.mjs'))
    .filter((file) => !relative(file).startsWith('test/helpers/'))
    .map(relative);
  assert.deepEqual(nonConforming, []);

  const helpersWithTests = walk(path.join(ROOT, 'test', 'helpers'))
    .filter((file) => path.extname(file) === '.mjs')
    .filter((file) => /^\s*test\(/m.test(fs.readFileSync(file, 'utf8')))
    .map(relative);
  assert.deepEqual(helpersWithTests, []);
});
