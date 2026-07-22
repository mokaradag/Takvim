'use client';
import { useEffect, useState } from 'react';
import { useWorkspace } from '../../state/hooks';
import { GanttView } from './GanttView';
import { WbsGanttView } from './WbsGanttView';

export function WorkspaceGanttView() {
  const workspace = useWorkspace();
  const [mode, setMode] = useState('wbs');

  useEffect(() => {
    setMode('wbs');
  }, [workspace.selectedProjectId]);

  if (workspace.mode === 'portfolio') return <GanttView />;

  return (
    <div className="col" style={{ gap: 12 }}>
      <ProjectGanttModeSwitch mode={mode} setMode={setMode} />
      {mode === 'wbs' ? <WbsGanttView /> : <GanttView />}
    </div>
  );
}

function ProjectGanttModeSwitch({ mode, setMode }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <div className="seg">
        <button className={mode === 'wbs' ? 'active' : ''} onClick={() => setMode('wbs')}>WBS</button>
        <button className={mode === 'person' ? 'active' : ''} onClick={() => setMode('person')}>Sorumlu / Kritik Yol</button>
      </div>
      <div className="muted" style={{ fontSize: 11.5 }}>WBS ve sorumlu görünümleri aynı Gantt etkileşimlerini ve kritik yol vurgularını kullanır.</div>
    </div>
  );
}
