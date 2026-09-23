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
  // Gruplama NORMALLEŞTİRİLMİŞ koda göredir: ham sütunlarla gruplanınca
  // ' abc ' ve 'ABC' iki satır üretiyor, aynı ProjectCode iki kez dönüyor ve
  // benzersiz kod dizini yüzünden eşitleme ya çöküyor ya da belirsiz bir proje
  // adı yazıyordu.
  assert.match(view, /GROUP BY\s+UPPER\(NULLIF\(LTRIM\(RTRIM\(ProjeKodu\)\)/i);
  assert.doesNotMatch(view, /GROUP BY\s+Tur,/i);
  // Kod başına TEK ve belirlenimci ad seçilir.
  assert.match(view, /MIN\(COALESCE\(NULLIF\(LTRIM\(RTRIM\(ProjeAdi\)\)/i);
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
  // Gerçek Sicil değerleri kişisel veridir: betik parametreli tohumlama yapar
  // ve depoya hiçbir gerçek sicil işlenmez.
  assert.match(createSql, /DECLARE @SystemAdminSicils nvarchar\(400\) = N'';/);
  assert.match(createSql, /FROM STRING_SPLIT\(@SystemAdminSicils, ','\)/);
  assert.doesNotMatch(createSql, /VALUES \(\d{4,},\s*'SYSTEM_ADMIN'/);
  assert.match(createSql, /SYSUTCDATETIME\(\)/i);
  assert.ok((createSql.match(/rowversion/gi) || []).length >= 5);
  assert.match(createSql, /NEWSEQUENTIALID\(\)/i);
});

test('rollback is rerunnable and never names source tables as drop targets', () => {
  assert.match(rollbackSql, /OBJECT_ID\(/i);
  for (const source of sourceTables) assert.doesNotMatch(rollbackSql, new RegExp(`DROP\\s+(?:TABLE|VIEW).*${source}`, 'i'));
});

const observabilityUpgrade = readFileSync(new URL('../database/MR_Upgrade_0012_System_Observability.sql', import.meta.url), 'utf8');

function normalizeSqlDefinition(definition, locale) {
  return definition.replace(/[ \[\]()]/g, '').toLocaleLowerCase(locale);
}

test('0012 SQL metninin harmanlamasını LOWER işleminden önce sabitler', () => {
  const expressions = [...observabilityUpgrade.matchAll(/LOWER\(REPLACE\(REPLACE\(REPLACE\(REPLACE\(REPLACE\((\w+\.\w+)\s+COLLATE\s+(\w+),/g)];
  assert.deepEqual(expressions.map((match) => match[1]).sort(), ['c.definition', 'd.definition', 'i.filter_definition']);
  assert.ok(expressions.every((match) => match[2] === 'Latin1_General_100_CS_AS'));
  assert.equal([...observabilityUpgrade.matchAll(/\bLOWER\(/g)].length, expressions.length);
  assert.doesNotMatch(observabilityUpgrade, /ALTER\s+(?:DATABASE|TABLE)[\s\S]*?COLLATE/i);
});

test('0012 beklenen kısıtları Türkçe harf dönüşümüyle karıştırmaz', () => {
  const expectedBlock = observabilityUpgrade.slice(observabilityUpgrade.indexOf('INSERT @RequiredChecks VALUES'), observabilityUpgrade.indexOf('DECLARE @InvalidCheck'));
  const expected = new Map([...expectedBlock.matchAll(/\(N'[^']+', N'(CK_[^']+)', N'((?:[^']|'')*)', N'((?:[^']|'')*)', N'((?:[^']|'')*)'\)/g)]
    .map((match) => [match[1], match.slice(2).map((value) => value.replace(/''/g, "'"))]));
  const definitions = [...observabilityUpgrade.matchAll(/CONSTRAINT (CK_\w+) CHECK \(([^\r\n]+)\)/g)];
  assert.equal(definitions.length, 7);
  assert.equal(expected.size, 7);
  let rejectedByTurkish = 0;
  for (const [, name, definition] of definitions) {
    const accepted = expected.get(name);
    assert.ok(accepted.includes(normalizeSqlDefinition(definition, 'en-US')), name);
    if (!accepted.includes(normalizeSqlDefinition(definition, 'tr-TR'))) rejectedByTurkish += 1;
    assert.equal(accepted.includes(normalizeSqlDefinition(`${definition} OR 1=1`, 'en-US')), false, name);
  }
  assert.equal(rejectedByTurkish, 3);
  const storedSeverity = "([Severity]='CRITICAL' OR [Severity]='ERROR' OR [Severity]='WARNING' OR [Severity]='INFO')";
  assert.ok(expected.get('CK_MR_OperationalEvents_Severity').includes(normalizeSqlDefinition(storedSeverity, 'en-US')));
  assert.equal(normalizeSqlDefinition('(sysutcdatetime())', 'en-US'), 'sysutcdatetime');
  assert.equal(normalizeSqlDefinition('(SYSUTCDATETIME())', 'en-US'), 'sysutcdatetime');
  assert.notEqual(normalizeSqlDefinition('(SYSUTCDATETIME())', 'tr-TR'), 'sysutcdatetime');
});

test('0012 gerçek kısıt hatasını adlandırır ve başarı kaydından önce durur', () => {
  const validation = observabilityUpgrade.slice(observabilityUpgrade.indexOf('DECLARE @InvalidCheck'), observabilityUpgrade.indexOf('DECLARE @RequiredDefaults'));
  assert.match(validation, /@InvalidCheck = r.TableName \+ N'\.' \+ r.ConstraintName/);
  assert.match(validation, /c.object_id IS NULL OR c.is_disabled = 1 OR c.is_not_trusted = 1/);
  assert.match(validation, /IF @InvalidCheck IS NOT NULL[\s\S]*THROW 51012, @CheckError, 1/);
  assert.ok(observabilityUpgrade.indexOf('THROW 51012, @CheckError, 1') < observabilityUpgrade.indexOf('INSERT dbo.MR_SchemaMigrations'));
  assert.match(observabilityUpgrade, /BEGIN CATCH\s+IF XACT_STATE\(\) <> 0 ROLLBACK TRANSACTION;\s+THROW;/);
});

test('filtrelenmiş dizin kuran betikler gerekli bütün oturum seçeneklerini sabitler', () => {
  const upgrade0015 = readFileSync(new URL('../database/MR_Upgrade_0015_Assignment_Coordination_And_Presence.sql', import.meta.url), 'utf8');
  // İstemci aracı bunlardan birini farklı açarsa filtrelenmiş dizin
  // oluşturulamaz ve göç geri alınır.
  const required = [
    'SET QUOTED_IDENTIFIER ON;', 'SET ANSI_NULLS ON;', 'SET ANSI_PADDING ON;', 'SET ANSI_WARNINGS ON;',
    'SET ARITHABORT ON;', 'SET CONCAT_NULL_YIELDS_NULL ON;', 'SET NUMERIC_ROUNDABORT OFF;'
  ];
  for (const [name, script] of [['0015', upgrade0015], ['create', createSql]]) {
    assert.match(script, /WHERE Status IN \('PENDING','CANCELLATION_REQUESTED'\)/, name);
    const tryIndex = script.indexOf('BEGIN TRY');
    assert.ok(tryIndex > 0, `${name}: BEGIN TRY bulunamadı`);
    const header = script.slice(0, tryIndex);
    for (const option of required) assert.ok(header.includes(option), `${name}: ${option}`);
  }
});
