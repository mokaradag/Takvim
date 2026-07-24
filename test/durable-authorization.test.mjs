import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCESS_REASONS,
  assertCanCreateManualProject,
  assertProjectWriteAccess,
  deriveEffectiveAccess,
  projectSchedulingCapability
} from '../src/server/authorization/authorization.js';
import { buildPortfolioSchedule } from '../src/state/selectors/scheduleSelectors.js';

function partial(projectId, taskId, reason = ACCESS_REASONS.ASSIGNEE) {
  return { projectId, taskId, reason };
}

test('SYSTEM_ADMIN bypasses project write checks and may create manual Projects', () => {
  const effective = deriveEffectiveAccess({ isSystemAdmin: true, fullProjectIds: ['p1', 'p2'] });
  assert.doesNotThrow(() => assertProjectWriteAccess(effective, 'unlisted'));
  assert.doesNotThrow(() => assertCanCreateManualProject({ isSystemAdmin: true, isExecutive: false }));
});

test('FULL project access wins over assignee and executive partial visibility', () => {
  const effective = deriveEffectiveAccess({
    isSystemAdmin: false,
    fullProjectIds: ['p1'],
    partialTaskRows: [partial('p1', 't1'), partial('p1', 't2', ACCESS_REASONS.EXECUTIVE_SCOPE)]
  });
  assert.equal(effective.access.get('p1').accessLevel, 'FULL');
  assert.doesNotThrow(() => assertProjectWriteAccess(effective, 'p1'));
});

test('ordinary assignee and executive subordinate visibility remain read-only', () => {
  for (const reason of [ACCESS_REASONS.ASSIGNEE, ACCESS_REASONS.EXECUTIVE_SCOPE]) {
    const effective = deriveEffectiveAccess({
      isSystemAdmin: false,
      partialTaskRows: [partial('p1', 't1', reason)]
    });
    assert.equal(effective.access.get('p1').accessLevel, 'PARTIAL');
    assert.throws(() => assertProjectWriteAccess(effective, 'p1'), (error) => error.code === 'FORBIDDEN');
  }
});

test('unknown users are denied by default', () => {
  const effective = deriveEffectiveAccess({ isSystemAdmin: false });
  assert.equal(effective.access.size, 0);
  assert.throws(() => assertProjectWriteAccess(effective, 'p1'), (error) => error.code === 'FORBIDDEN');
  assert.throws(
    () => assertCanCreateManualProject({ isSystemAdmin: false, isExecutive: false }),
    (error) => error.code === 'FORBIDDEN'
  );
});

test('directors, managers and team leaders may create manual Projects without gaining blanket write rights', () => {
  assert.doesNotThrow(() => assertCanCreateManualProject({ isSystemAdmin: false, isExecutive: true }));
  const effective = deriveEffectiveAccess({
    isSystemAdmin: false,
    partialTaskRows: [partial('subordinate-project', 'task-1', ACCESS_REASONS.EXECUTIVE_SCOPE)]
  });
  assert.throws(() => assertProjectWriteAccess(effective, 'subordinate-project'), (error) => error.code === 'FORBIDDEN');
});

test('partial access explicitly disables complete CPM and critical-path claims', () => {
  assert.deepEqual(projectSchedulingCapability('PARTIAL'), {
    canRunCompleteCpm: false,
    canShowCriticalPath: false
  });
  const schedule = buildPortfolioSchedule({
    projects: [{ id: 'p1', accessLevel: 'PARTIAL', schedulingCapability: 'SUPPRESSED_PARTIAL' }],
    tasks: [{ id: 'a', projectId: 'p1', task: 'A', deps: [], plannedStart: '2026-01-05', plannedFinish: '2026-01-05', plannedDurationDays: 1 }],
    calendars: []
  });
  assert.equal(schedule.projects.p1.status, 'suppressed-partial');
  assert.deepEqual(schedule.projects.p1.criticalTaskIds, []);
  assert.deepEqual(schedule.projects.p1.tasks, {});
  assert.equal(schedule.projects.p1.error.code, 'PARTIAL_PROJECT_NETWORK');
});
