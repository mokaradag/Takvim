import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

import { NAV_ITEMS, PAGE_META } from '../src/components/shell/navigation.js';
import { TWEAK_DEFAULTS } from '../src/lib/tweaks-defaults.js';
import { CALENDARS } from '../src/data/mock/seed.js';
import { DEFAULT_CALENDAR } from '../src/scheduling/calendars/index.js';

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

function relativeModulePath(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

const runtimeSafeModules = walk(path.join(ROOT, 'src'))
  .filter((file) => file.endsWith('.js'))
  .filter((file) => !file.includes(`${path.sep}app${path.sep}`))
  .filter((file) => !file.includes(`${path.sep}hooks${path.sep}`));

for (const file of runtimeSafeModules) {
  test(`runtime-safe module imports without top-level failure: ${relativeModulePath(file)}`, async () => {
    await assert.doesNotReject(import(pathToFileURL(file).href));
  });
}

test('navigation labels and page metadata are serializable plain data', () => {
  assert.doesNotThrow(() => JSON.stringify(NAV_ITEMS));
  assert.doesNotThrow(() => JSON.stringify(PAGE_META));
  for (const item of NAV_ITEMS) {
    assert.equal(Object.getPrototypeOf(item), Object.prototype);
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.label, 'string');
    assert.equal(typeof item.icon, 'string');
  }
});

test('page metadata values are serializable title/subtitle records', () => {
  for (const [id, meta] of Object.entries(PAGE_META)) {
    assert.equal(typeof id, 'string');
    assert.equal(Object.getPrototypeOf(meta), Object.prototype);
    assert.equal(typeof meta.title, 'string');
    assert.equal(typeof meta.sub, 'string');
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

test('source files do not contain accidental TODO or FIXME markers', () => {
  const violations = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    if (!['.js', '.jsx', '.css'].includes(path.extname(file))) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (/\b(?:TODO|FIXME)\b/.test(source)) violations.push(relativeModulePath(file));
  }
  assert.deepEqual(violations, []);
});

test('application root keeps state and shell composition explicit', () => {
  const source = read('src/components/shell/ApplicationRoot.jsx');
  assert.match(source, /<AppStateProvider>/);
  assert.match(source, /<AppShell\s*\/>/);
});

test('all mock projects resolve to known calendars', () => {
  const calendarIds = new Set(CALENDARS.map((calendar) => calendar.id));
  const seed = read('src/data/mock/seed.js');
  const projectCalendarIds = [...seed.matchAll(/calendarId:\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
  for (const calendarId of projectCalendarIds) assert.ok(calendarIds.has(calendarId), calendarId);
});
