import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyDefaultCalendarProjection } from '../src/server/repository/calendarProjection.js';
import { orderWbsUpsertsByParents } from '../src/server/repository/wbsCommitPlanning.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('WBS upserts are planned parent-first without disturbing unrelated stable order', () => {
  const grandchild = { id: 'grandchild', parentId: 'child' };
  const child = { id: 'child', parentId: 'parent' };
  const parent = { id: 'parent', parentId: 'existing-root' };
  const unrelated = { id: 'unrelated', parentId: 'existing-root' };

  const ordered = orderWbsUpsertsByParents([grandchild, child, parent, unrelated]);
  assert.deepEqual(ordered.map((node) => node.id), ['parent', 'child', 'grandchild', 'unrelated']);
});

test('WBS planning preserves input when no in-batch parent dependency exists', () => {
  const input = [
    { id: 'second', parentId: 'existing-root' },
    { id: 'first', parentId: 'existing-root' }
  ];
  assert.deepEqual(orderWbsUpsertsByParents(input), input);
});

test('default calendar projection marks and places the SQL default first', () => {
  const snapshot = {
    calendars: [
      { id: 'calendar-a', name: 'A Calendar' },
      { id: 'calendar-default', name: 'Z Default' },
      { id: 'calendar-b', name: 'B Calendar' }
    ],
    tasks: []
  };

  const projected = applyDefaultCalendarProjection(snapshot, 'calendar-default');
  assert.equal(projected.calendars[0].id, 'calendar-default');
  assert.equal(projected.calendars[0].isDefault, true);
  assert.equal(projected.calendars.filter((calendar) => calendar.isDefault).length, 1);
  assert.deepEqual(projected.tasks, []);
});

test('commit route canonicalizes IDs and scalars before WBS ordering and hardened SQL planning', () => {
  const route = read('src/app/api/mergen-rota/commit/route.js');
  const wrapper = read('src/server/repository/orderedSqlAppRepository.js');

  assert.match(route, /canonicalizeCommitScalars\(canonicalizeCommitChanges\(body\.changes\)\)/);
  assert.match(route, /createOrderedSqlAppRepository/);
  assert.match(wrapper, /createHardenedSqlAppRepository/);

  const idPosition = wrapper.indexOf('canonicalizeCommitChanges(changes)');
  const scalarPosition = wrapper.indexOf('canonicalizeCommitScalars(');
  const orderingPosition = wrapper.indexOf('orderWbsUpsertsByParents(canonicalChanges.wbsUpserts || [])');
  const commitPosition = wrapper.indexOf('repository.commitChanges(orderedChanges)');

  assert.ok(idPosition >= 0, 'UUID canonicalization must run');
  assert.ok(scalarPosition >= 0, 'scalar canonicalization must run');
  assert.ok(orderingPosition > scalarPosition, 'WBS ordering must use fully canonicalized changes');
  assert.ok(commitPosition > orderingPosition, 'hardened persistence must receive ordered changes');
});

test('Actual snapshots resolve the active SQL default calendar in the same transaction', () => {
  const source = read('src/server/repository/projectedSqlAppRepository.js');

  assert.match(source, /WHERE IsDefault = 1 AND IsActive = 1/);
  assert.match(source, /const defaultCalendarId = await loadDefaultCalendarId\(transaction\);/);
  assert.match(source, /Object\.assign\(snapshot, applyDefaultCalendarProjection\(snapshot, defaultCalendarId\)\);/);
  assert.match(source, /return applyTaskAssigneeProjection\(snapshot, assigneeRows\);/);
});
