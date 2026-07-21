import fs from 'node:fs';
import path from 'node:path';

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const featureFiles = walk('src/features').filter((file) => /\.(?:js|jsx)$/.test(file));

for (const file of featureFiles) {
  let source = fs.readFileSync(file, 'utf8');
  if (source.includes('const people = usePeople();')) source = source.replace(/\bPEOPLE\b/g, 'people');
  if (source.includes('const projects = useProjects();')) source = source.replace(/\bPROJECTS\b/g, 'projects');
  fs.writeFileSync(file, source);
}

for (const file of featureFiles) {
  const source = fs.readFileSync(file, 'utf8');
  if (/\b(?:PROJECTS|PEOPLE|TASKS)\b/.test(source)) {
    throw new Error(`Legacy raw-data identifier remains in ${file}`);
  }
  if (/data\/mock\/seed|(?:^|\/)lib\/data/.test(source)) {
    throw new Error(`Feature bypasses the data/state boundary in ${file}`);
  }
}

console.log(`Validated ${featureFiles.length} feature modules against raw-data references.`);
