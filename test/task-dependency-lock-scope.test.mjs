import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'src/server/repository/taskDependencyAccess.js'), 'utf8');

test('dependency preparation does not lock an entire project task population for content-only saves', () => {
  const taskLock = source.match(/SELECT TaskId, ProjectId\s+FROM dbo\.MR_Tasks WITH \(UPDLOCK, HOLDLOCK\)[\s\S]*?ORDER BY TaskId;/)?.[0];
  assert.ok(taskLock, 'task lock query must exist');
  assert.match(taskLock, /TaskId IN \(SELECT TRY_CONVERT\(uniqueidentifier, value\) FROM STRING_SPLIT\(@scopedDependencyTaskIds, ','\)\)/);
  assert.doesNotMatch(taskLock, /ProjectId IN/);
});

test('project-wide serialization is reserved for new tasks and explicit dependency mutations', () => {
  assert.match(source, /const dependencyProjectIds = new Set\(upserts\s*\.filter\(\(task\) => !task\.version \|\| task\.dependencyMutation !== false\)/);
  const projectLock = source.indexOf('FROM dbo.MR_Projects WITH (UPDLOCK, HOLDLOCK)');
  const taskLock = source.indexOf('FROM dbo.MR_Tasks WITH (UPDLOCK, HOLDLOCK)');
  const dependencyLock = source.indexOf('FROM dbo.MR_TaskDependencies WITH (UPDLOCK, HOLDLOCK)');
  assert.ok(projectLock >= 0 && projectLock < taskLock && taskLock < dependencyLock);
});
