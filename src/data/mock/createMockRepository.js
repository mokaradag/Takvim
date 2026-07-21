import {
  BASELINES,
  CALENDARS,
  PEOPLE,
  PROJECTS,
  TASK_BASELINE_SNAPSHOTS,
  TASKS,
  WBS
} from './seed.js';

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function createMockRepository(seed = {
  calendars: CALENDARS,
  projects: PROJECTS,
  people: PEOPLE,
  wbs: WBS,
  tasks: TASKS,
  baselines: BASELINES,
  taskBaselineSnapshots: TASK_BASELINE_SNAPSHOTS
}) {
  const snapshot = clone(seed);
  return {
    kind: 'mock',
    getSnapshot() {
      return clone(snapshot);
    }
  };
}
