import fs from 'node:fs';

function update(path, transform) {
  const before = fs.readFileSync(path, 'utf8');
  const after = transform(before);
  if (after === before) return;
  fs.writeFileSync(path, after);
}

const featureFiles = [
  'src/features/tasks/TasksView.jsx',
  'src/features/team/TeamView.jsx',
  'src/features/gantt/GanttView.jsx'
];

for (const file of featureFiles) {
  update(file, (source) => {
    let next = source;
    if (source.includes('const projects = useProjects();')) next = next.replace(/\bPROJECTS\b/g, 'projects');
    if (source.includes('const people = usePeople();')) next = next.replace(/\bPEOPLE\b/g, 'people');
    return next;
  });
}

update('src/state/AppStateProvider.jsx', (source) => source.replace(
  "tasks: state.tasks.map((task) => task.id === action.id ? normalizeTask({ ...task, ...action.patch }, state) : task)",
  `tasks: state.tasks.map((task) => {
          if (task.id !== action.id) return task;
          const next = { ...task, ...action.patch };
          if (Object.prototype.hasOwnProperty.call(action.patch, 'sorumlu')) delete next.assigneeIds;
          if (Object.prototype.hasOwnProperty.call(action.patch, 'proje')) {
            delete next.projectId;
            delete next.wbsId;
          }
          return normalizeTask(next, state);
        })`
));

const featureSources = fs.readdirSync('src/features', { recursive: true })
  .filter((path) => /\.(?:js|jsx)$/.test(path))
  .map((path) => `src/features/${path}`)
  .filter((path) => fs.statSync(path).isFile());

for (const file of featureSources) {
  const source = fs.readFileSync(file, 'utf8');
  if (/\bPROJECTS\b|\bPEOPLE\b|\bTASKS\b/.test(source)) {
    throw new Error(`Legacy raw-data identifier remains in ${file}`);
  }
  if (/data\/mock\/seed|lib\/data/.test(source)) {
    throw new Error(`Feature bypasses the data/state boundary in ${file}`);
  }
}

console.log('Feature references and canonical ID synchronization fixed.');
