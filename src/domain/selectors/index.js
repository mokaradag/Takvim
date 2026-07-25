export function selectTaskById(tasks, taskId) {
  return tasks.find((task) => task.id === taskId) || null;
}

export function selectTasksByProject(tasks, projectId) {
  return tasks.filter((task) => task.projectId === projectId);
}

export function selectTasksByPerson(tasks, personId) {
  return tasks.filter((task) => (task.assigneeIds || []).includes(personId));
}

export function selectProjectById(projects, projectId) {
  return projects.find((project) => project.id === projectId) || null;
}

export function selectPersonById(people, personId) {
  return people.find((person) => person.id === personId) || null;
}

export {
  buildWbsTree,
  compareWbsNodes,
  emptyWbsRollup,
  flattenWbsTree,
  formatWbsPath,
  selectDefaultProjectWbs,
  selectProjectWbs,
  selectTasksForWbs,
  selectWbsAncestors,
  selectWbsChildren,
  selectWbsDescendantIds,
  selectWbsPath,
  selectWbsRollupIndex,
  selectWbsRoots,
  selectWbsTaskRollup
} from './wbsSelectors.js';
