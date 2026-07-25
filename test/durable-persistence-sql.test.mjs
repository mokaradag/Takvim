import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const createSql = readFileSync(new URL('../database/MR_Create_Durable_Persistence.sql', import.meta.url), 'utf8');
const rollbackSql = readFileSync(new URL('../database/MR_Rollback_Durable_Persistence.sql', import.meta.url), 'utf8');

function captures(source, expression) {
  return new Set([...source.matchAll(expression)].map((match) => match[1].toUpperCase()));
}

const createdTables = captures(createSql, /CREATE\s+TABLE\s+dbo\.(MR_[A-Za-z0-9_]+)/gi);
const droppedTables = captures(rollbackSql, /DROP\s+TABLE\s+dbo\.(MR_[A-Za-z0-9_]+)/gi);
const createdViews = captures(createSql, /CREATE\s+VIEW\s+dbo\.(MR_V_[A-Za-z0-9_]+)/gi);
const droppedViews = captures(rollbackSql, /DROP\s+VIEW\s+dbo\.(MR_V_[A-Za-z0-9_]+)/gi);

const requiredTables = [
  'MR_SCHEMAMIGRATIONS', 'MR_USERROLES', 'MR_CALENDARS', 'MR_CALENDARWORKINGDAYS',
  'MR_CALENDARHOLIDAYS', 'MR_PROJECTS', 'MR_PROJECTTAGS', 'MR_PROJECTACCESS', 'MR_WBS',
  'MR_TASKS', 'MR_TASKASSIGNEES', 'MR_TASKDEPENDENCIES', 'MR_BASELINES',
  'MR_TASKBASELINESNAPSHOTS', 'MR_AUDITLOG'
];

const sourceTables = [
  'HR02_rehisRehberwithMasrafYeri',
  'A01_ProjeUrunFaaliyetRaporu',
  'HR09_projeSorumlu'
];

test('create and rollback scripts have exact MR table parity', () => {
  assert.deepEqual([...createdTables].sort(), [...droppedTables].sort());
  for (const table of requiredTables) assert.ok(createdTables.has(table), `missing ${table}`);
});

test('create and rollback scripts have exact MR view parity', () => {
  assert.deepEqual([...createdViews].sort(), [...droppedViews].sort());
  assert.deepEqual([...createdViews].sort(), [
    'MR_V_CORPORATEPROJECTACCESS',
    'MR_V_CORPORATEPROJECTS',
    'MR_V_EXECUTIVESCOPE',
    'MR_V_PEOPLEDIRECTORY'
  ]);
});

test('all application-owned SQL tables start with MR_', () => {
  const allCreated = captures(createSql, /CREATE\s+TABLE\s+dbo\.([A-Za-z0-9_]+)/gi);
  assert.ok([...allCreated].every((name) => name.startsWith('MR_')));
});

test('corporate source tables are never mutated', () => {
  for (const source of sourceTables) {
    for (const verb of ['INSERT\\s+(?:INTO\\s+)?', 'UPDATE\\s+', 'DELETE\\s+(?:FROM\\s+)?', 'DROP\\s+TABLE\\s+', 'ALTER\\s+TABLE\\s+']) {
      const expression = new RegExp(`${verb}(?:dbo\\.)?${source}`, 'i');
      assert.equal(expression.test(`${createSql}\n${rollbackSql}`), false, `${source} must be read-only`);
    }
  }
});

test('corporate Project view uses only approved A01 columns and GROUP BY', () => {
  const view = createSql.match(/CREATE VIEW dbo\.MR_V_CorporateProjects AS([\s\S]*?)GROUP BY([\s\S]*?);'\);/i)?.[0] || '';
  assert.match(view, /Tur/);
  assert.match(view, /Tur_Aciklama/);
  assert.match(view, /ProjeKodu/);
  assert.match(view, /ProjeAdi/);
  assert.match(view, /GROUP BY\s+Tur,\s*Tur_Aciklama,\s*ProjeKodu,\s*ProjeAdi/i);
  assert.doesNotMatch(view, /SELECT\s+\*/i);
  const identifiers = [...view.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)].map((match) => match[1]);
  for (const forbidden of ['Masraf', 'Butce', 'Tarih', 'Aciklama2']) assert.equal(identifiers.includes(forbidden), false);
});

test('PPTS access uses exact STRING_SPLIT tokenization and never LIKE', () => {
  const view = createSql.match(/CREATE VIEW dbo\.MR_V_CorporateProjectAccess AS([\s\S]*?);'\);/i)?.[0] || '';
  assert.match(view, /STRING_SPLIT\(pptsSicil,\s*'',''\)/i);
  assert.match(view, /''PPTS''/);
  assert.doesNotMatch(view, /''PPTC''/);
  assert.match(view, /TRY_CONVERT\(int,\s*LTRIM\(RTRIM\(value\)\)\)/i);
  assert.doesNotMatch(view, /LIKE\s+['"]%/i);
});

test('admin bootstrap and UTC/concurrency requirements are present', () => {
  for (const sicil of ['10276', '18068', '23977']) assert.match(createSql, new RegExp(`\\b${sicil}\\b`));
  assert.match(createSql, /SYSUTCDATETIME\(\)/i);
  assert.ok((createSql.match(/rowversion/gi) || []).length >= 5);
  assert.match(createSql, /NEWSEQUENTIALID\(\)/i);
});

test('rollback is rerunnable and never names source tables as drop targets', () => {
  assert.match(rollbackSql, /OBJECT_ID\(/i);
  for (const source of sourceTables) assert.doesNotMatch(rollbackSql, new RegExp(`DROP\\s+(?:TABLE|VIEW).*${source}`, 'i'));
});
