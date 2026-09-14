import assert from 'node:assert/strict';
import test from 'node:test';

import { corporateSeed, createActualStack } from './helpers/actualStack.mjs';
import {
  resetCorporateWbsSyncScheduleForTests,
  whenCorporateWbsSyncSettled
} from '../src/server/repository/corporateWbsSyncSchedule.js';

const SUCCESSFUL_RUN_STATEMENT = 'UPDATE dbo.MR_CorporateWbsSyncRunState';
const SOURCE_STATEMENT = 'LTRIM(RTRIM([WBS element]))';

function countStatements(stack, fragment) {
  return stack.db.statements.filter((entry) => entry.sql.includes(fragment)).length;
}

function cn43nRows() {
  return [{
    'Proje tanımı': 'P4417041',
    'WBS element': 'P4417041.01',
    Name: 'Sistem Tasarımı',
    Level: 1,
    Status: 'REL',
    'PYP kodu': '1',
    'Proj.type': 'GD'
  }];
}

test('boş CN43N turu başarı durumunu tam bir kez kaydeder', async () => {
  const stack = await createActualStack(corporateSeed({
    projects: [],
    wbs: [],
    corporateProjects: [],
    corporateProjectAccess: [],
    corporateWbsRows: []
  }));
  try {
    assert.equal(countStatements(stack, SUCCESSFUL_RUN_STATEMENT), 1);
    assert.ok(
      Number.isFinite(Date.parse(stack.db.corporateWbsSyncRunState.LastSuccessfulSyncAt)),
      'başarılı tur geçerli zaman damgası kaydetmelidir'
    );
    assert.deepEqual(stack.db.corporateWbsSyncRunState, {
      StateId: 1,
      LastSuccessfulSyncAt: stack.db.corporateWbsSyncRunState.LastSuccessfulSyncAt,
      ProjectCount: 0,
      NodeCount: 0,
      MergedProjectCount: 0,
      SkippedProjectCount: 0,
      UpdatedBySicil: 900001
    });
  } finally {
    await stack.dispose();
  }
});

test('tamamlanan CN43N turu başarı durumunu tam bir kez kaydeder', async () => {
  const stack = await createActualStack(corporateSeed({ corporateWbsRows: cn43nRows() }));
  try {
    assert.equal(countStatements(stack, SUCCESSFUL_RUN_STATEMENT), 1);
    assert.ok(
      Number.isFinite(Date.parse(stack.db.corporateWbsSyncRunState.LastSuccessfulSyncAt)),
      'başarılı tur geçerli zaman damgası kaydetmelidir'
    );
    assert.equal(stack.db.corporateWbsSyncRunState.ProjectCount, 1);
    assert.equal(stack.db.corporateWbsSyncRunState.NodeCount, 1);
    assert.equal(stack.db.corporateWbsSyncRunState.MergedProjectCount, 1);
    assert.equal(stack.db.corporateWbsSyncRunState.SkippedProjectCount, 0);
    assert.equal(stack.db.corporateWbsSyncRunState.UpdatedBySicil, 900001);
  } finally {
    await stack.dispose();
  }
});

test('başarısız CN43N turu başarılı tur durumunu ilerletmez', async () => {
  const stack = await createActualStack(corporateSeed({ corporateWbsRows: cn43nRows() }));
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const previousSuccessfulAt = stack.db.corporateWbsSyncRunState.LastSuccessfulSyncAt;
    stack.db.corporateWbsRows = null;
    stack.db.statements.length = 0;
    resetCorporateWbsSyncScheduleForTests();

    await stack.reload();
    await whenCorporateWbsSyncSettled();

    assert.ok(countStatements(stack, SOURCE_STATEMENT) >= 1, 'başarısız tur kaynağı denemelidir');
    assert.equal(countStatements(stack, SUCCESSFUL_RUN_STATEMENT), 0);
    assert.equal(stack.db.corporateWbsSyncRunState.LastSuccessfulSyncAt, previousSuccessfulAt);
  } finally {
    console.warn = originalWarn;
    await stack.dispose();
  }
});
