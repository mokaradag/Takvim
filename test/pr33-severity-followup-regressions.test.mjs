import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { prepareProjectCreation } from '../src/state/projectCreation.js';

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const calendar = { id: 'calendar-1', name: 'Default' };
const lead = { id: '900002', name: 'Project Lead' };
const validProjectInput = {
  name: 'Manual Project',
  code: 'MANUAL-001',
  leadId: lead.id,
  calendarId: calendar.id,
  dataDate: '2026-07-24',
  color: 'blue',
  tags: ['Plan']
};

test('AppStateProvider propagates the loaded project-creation capability to shared validation', () => {
  const source = read('src/state/AppStateProvider.jsx');
  const preparation = source.match(/prepareProjectCreation\(input,\s*\{([\s\S]*?)\},\s*\{/);

  assert.ok(preparation, 'project creation preparation call must exist');
  assert.match(preparation[1], /canCreateProjects:\s*current\.canCreateProjects/);
});

test('shared project creation preparation rejects an explicitly unauthorized session', () => {
  const result = prepareProjectCreation(validProjectInput, {
    projects: [],
    people: [lead],
    calendars: [calendar],
    wbs: [],
    canCreateProjects: false
  }, {
    projectId: 'project-1',
    rootWbsId: 'wbs-1'
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROJECT_CREATE_FORBIDDEN');
});

test('SQL Server schema permits only the canonical persisted task statuses', () => {
  const schema = read('database/MR_Create_Durable_Persistence.sql');
  const constraint = schema.match(/CONSTRAINT CK_MR_Tasks_Status CHECK \(Status IN \(([^)]*)\)\)/);

  assert.ok(constraint, 'task status constraint must exist');
  assert.equal(constraint[1], "'planned','in-progress','done'");
  for (const legacyStatus of ['blocked', 'cancelled', 'not-started', 'completed']) {
    assert.doesNotMatch(constraint[1], new RegExp(`'${legacyStatus}'`));
  }
});
