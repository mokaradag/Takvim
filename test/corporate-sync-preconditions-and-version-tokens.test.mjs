import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { toActualUuid } from '../src/data/api/createApiRepository.js';
import { decodeCanonicalRowVersion } from '../src/server/repository/rowVersionTokenValidation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test("etkin varsayılan takvim yoksa kurumsal eşitleme eklemelerden önce durur", () => {
  const source = read('src/server/repository/corporateQueries.js');
  const guardPosition = source.indexOf("THROW 51003, 'An active default calendar is required");
  const insertPosition = source.indexOf('INSERT dbo.MR_Projects');

  assert.ok(guardPosition >= 0, 'default-calendar preflight must exist');
  assert.ok(insertPosition >= 0, 'corporate project insert must exist');
  assert.ok(guardPosition < insertPosition, 'default-calendar preflight must run before corporate inserts');
  assert.match(source, /FROM dbo\.MR_Calendars WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(source, /WHERE IsDefault = 1 AND IsActive = 1/);
});

test("gerçek UUID normalleştirmesi önekli ve yalın kimlikte küçük harfli ve kararlıdır", () => {
  const uppercase = '550E8400-E29B-41D4-A716-446655440000';
  const lowercase = '550e8400-e29b-41d4-a716-446655440000';

  assert.equal(toActualUuid(uppercase), lowercase);
  assert.equal(toActualUuid(`project-${uppercase}`), lowercase);
  assert.equal(toActualUuid(`  task-${uppercase}  `), lowercase);
});

test("satır sürümü çözümü yalnızca kanonik sekiz bayt Base64 belirtecini kabul eder", () => {
  const valid = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]).toString('base64');
  assert.deepEqual([...decodeCanonicalRowVersion(valid)], [0, 1, 2, 3, 4, 5, 6, 7]);

  for (const malformed of [
    `${valid}evil`,
    valid.slice(0, -1),
    ` ${valid}`,
    `${valid} `,
    '!!!!!!!!!!!!'
  ]) {
    assert.throws(() => decodeCanonicalRowVersion(malformed), /Rowversion token/);
  }
});
