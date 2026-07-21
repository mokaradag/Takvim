import { PEOPLE, PROJECTS, TASKS, WBS } from './seed';

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function createMockRepository(seed = { projects: PROJECTS, people: PEOPLE, wbs: WBS, tasks: TASKS }) {
  const snapshot = clone(seed);
  return {
    kind: 'mock',
    getSnapshot() {
      return clone(snapshot);
    }
  };
}
