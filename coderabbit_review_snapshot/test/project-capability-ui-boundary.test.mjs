import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepareProjectUpdateChanges } from '../src/state/projectCreation.js';
import {
  canWriteProject,
  findProjectRootWbsId,
  resolveSimpleProjectChoice,
  writableSimpleModeProjects
} from '../src/features/simple/simpleModePolicy.js';

const calendar = { id: 'calendar-1', name: 'Default' };
const lead = { id: '900002', name: 'Project Lead' };
const corporateProject = {
  id: 'project-corporate',
  source: 'corporate',
  code: 'CORP-001',
  name: 'Corporate Project',
  color: 'blue',
  leadId: lead.id,
  lead: lead.name,
  calendarId: calendar.id,
  dataDate: '2026-07-24',
  tags: ['Plan'],
  accessLevel: 'FULL',
  version: 'AAAAAAAAAAA='
};
const corporateRoot = {
  id: 'wbs-root',
  projectId: corporateProject.id,
  parentId: null,
  code: '1',
  name: corporateProject.name,
  sortOrder: 1,
  version: 'AAAAAAAAAAA='
};

function projectContext(project = corporateProject) {
  return {
    projects: [project],
    people: [lead],
    calendars: [calendar],
    tasks: [],
    wbs: [{ ...corporateRoot, projectId: project.id, name: project.name }]
  };
}

test('corporate project identity edits cannot rename the root WBS or change source-controlled fields', () => {
  const prepared = prepareProjectUpdateChanges(corporateProject.id, {
    name: 'Client-Spoofed Name',
    code: 'CLIENT-CODE',
    source: 'manual',
    leadId: lead.id,
    calendarId: calendar.id,
    dataDate: corporateProject.dataDate,
    color: corporateProject.color,
    tags: corporateProject.tags
  }, projectContext());

  assert.equal(prepared.ok, true);
  assert.equal(prepared.project.name, corporateProject.name);
  assert.equal(prepared.project.code, corporateProject.code);
  assert.equal(prepared.project.source, 'corporate');
  assert.deepEqual(prepared.changes.wbsUpserts, []);
});

test('partial project metadata updates are rejected before persistence', () => {
  const partialProject = { ...corporateProject, accessLevel: 'PARTIAL' };
  const prepared = prepareProjectUpdateChanges(partialProject.id, {
    color: 'emerald'
  }, projectContext(partialProject));

  assert.equal(prepared.ok, false);
  assert.equal(prepared.error.code, 'PROJECT_WRITE_FORBIDDEN');
});

test('Simple Mode exposes only writable project destinations', () => {
  const projects = [
    { id: 'full', accessLevel: 'FULL' },
    { id: 'partial', accessLevel: 'PARTIAL' },
    { id: 'read', accessLevel: 'READ' },
    { id: 'demo' }
  ];

  assert.equal(canWriteProject(projects[0]), true);
  assert.equal(canWriteProject(projects[1]), false);
  assert.equal(canWriteProject(projects[2]), false);
  assert.equal(canWriteProject(projects[3]), true);
  assert.deepEqual(writableSimpleModeProjects(projects).map((project) => project.id), ['full', 'demo']);
});

test('Simple Mode restores a valid choice after asynchronous project loading', () => {
  const projects = [{ id: 'full', accessLevel: 'FULL' }];
  assert.equal(resolveSimpleProjectChoice('', projects, false), 'full');
  assert.equal(resolveSimpleProjectChoice('partial', projects, false), 'full');
  assert.equal(resolveSimpleProjectChoice('', [], true), '__manual_project__');
  assert.equal(resolveSimpleProjectChoice('__manual_project__', projects, true), '__manual_project__');
  assert.equal(resolveSimpleProjectChoice('', [], false), '');
});

test('Simple Mode task creation resolves the project root WBS', () => {
  assert.equal(findProjectRootWbsId([corporateRoot], corporateProject.id), corporateRoot.id);
  assert.equal(findProjectRootWbsId([corporateRoot], 'missing-project'), null);

  const source = fs.readFileSync(new URL('../src/features/simple/SimpleModePanel.jsx', import.meta.url), 'utf8');
  assert.match(source, /wbsId:\s*targetWbsId/);
  assert.match(source, /created\.changes\?\.wbsUpserts/);
  // Serbest proje seçeneği artık listenin başına eklenir (bkz. withManualProjectOption).
  assert.match(source, /withManualProjectOption\(options, canCreateProjects, \{[\s\S]*?value: MANUAL_PROJECT/);
  assert.match(source, /<SearchableSelect[\s\S]*?options=\{projectOptions\}/);
  assert.doesNotMatch(source, /wbsId:\s*null/);
});
