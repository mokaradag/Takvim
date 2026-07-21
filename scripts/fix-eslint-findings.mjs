import fs from 'node:fs';

function replaceExact(path, before, after) {
  const source = fs.readFileSync(path, 'utf8');
  if (!source.includes(before)) {
    throw new Error(`Expected text not found in ${path}: ${before.slice(0, 80)}`);
  }
  fs.writeFileSync(path, source.replace(before, after));
}

replaceExact(
  'src/components/shell/WelcomeScreen.jsx',
  'Her yerde "i" ipuçları',
  'Her yerde ‘i’ ipuçları'
);

replaceExact(
  'src/components/ui-extras.jsx',
  '<span className="dff-hint">"{dateTo || \'tarih\'}" tarihinden öncesi listelenir.</span>',
  '<span className="dff-hint">‘{dateTo || \'tarih\'}’ tarihinden öncesi listelenir.</span>'
);
replaceExact(
  'src/components/ui-extras.jsx',
  '<span className="dff-hint">"{dateFrom || \'tarih\'}" tarihinden sonrası listelenir.</span>',
  '<span className="dff-hint">‘{dateFrom || \'tarih\'}’ tarihinden sonrası listelenir.</span>'
);

replaceExact(
  'src/features/dashboard/DashboardView.jsx',
  'Halka grafiğinin merkezindeki yüzde, "Tamamlandı" oranıdır.',
  'Halka grafiğinin merkezindeki yüzde, ‘Tamamlandı’ oranıdır.'
);

replaceExact(
  'src/features/reports/ReportsView.jsx',
  'Birikimli "Tamamlandı" sayısı',
  'Birikimli ‘Tamamlandı’ sayısı'
);

replaceExact(
  'src/components/ui.jsx',
  `export function AreaChart({ data, width = 600, height = 160, color = 'var(--accent)', labels = [], animated = false }) {\n  if (!data || !data.length) return null;`,
  `export function AreaChart({ data, width = 600, height = 160, color = 'var(--accent)', labels = [], animated = false }) {\n  const [hover, setHover] = React.useState(null);\n  const svgRef = React.useRef(null);\n  if (!data || !data.length) return null;`
);
replaceExact(
  'src/components/ui.jsx',
  `  // tooltip state\n  const [hover, setHover] = React.useState(null);\n  const svgRef = React.useRef(null);\n\n`,
  `  // tooltip state is initialized before the empty-data guard to preserve Hook order.\n`
);

replaceExact(
  'src/features/reports/ReportsView.jsx',
  `function CFDChart({ data, height = 200 }) {\n  if (!data || !data.length) return null;`,
  `function CFDChart({ data, height = 200 }) {\n  const [hover, setHover] = React.useState(null);\n  const svgRef = React.useRef(null);\n  if (!data || !data.length) return null;`
);
replaceExact(
  'src/features/reports/ReportsView.jsx',
  `  const [hover, setHover] = React.useState(null);\n  const svgRef = React.useRef(null);\n  const onMove = (e) => {`,
  `  const onMove = (e) => {`
);

replaceExact(
  'src/features/task-detail/TaskDrawer.jsx',
  `  useEffect(() => { setLocal({ ...task }); }, [task && task.id]);`,
  `  useEffect(() => { setLocal({ ...task }); }, [task]);`
);

console.log('Applied ESLint findings without disabling rules.');
