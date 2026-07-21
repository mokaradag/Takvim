import fs from 'node:fs';

function replaceMemoDependency(path, marker, oldSuffix, newSuffix) {
  let source = fs.readFileSync(path, 'utf8');
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing memo marker in ${path}: ${marker}`);
  const end = source.indexOf(oldSuffix, start);
  if (end < 0) throw new Error(`Missing memo suffix in ${path}: ${marker}`);
  source = source.slice(0, end) + newSuffix + source.slice(end + oldSuffix.length);
  fs.writeFileSync(path, source);
}

replaceMemoDependency(
  'src/features/tasks/TasksView.jsx',
  'const projOpts = useMemo1(() => projects',
  '})), []);',
  '})), [projects]);'
);
replaceMemoDependency(
  'src/features/tasks/TasksView.jsx',
  'const sorumluOpts = useMemo1(() => people',
  '})), []);',
  '})), [people]);'
);
replaceMemoDependency(
  'src/features/team/TeamView.jsx',
  'const stats = useMemo1(() => {',
  '}, [tasks]);',
  '}, [tasks, people]);'
);

console.log('State-backed memo dependencies updated.');
