'use client';
import { useEffect, useMemo, useState } from 'react';
import { fmt, fmtISO, today } from '../../scheduling/dates';
import {
  calculateTaskDateRange,
  clearGanttDateRangeOverride,
  setGanttDateRangeOverride
} from '../../scheduling/metrics';
import { useWorkspace, useWorkspaceTasks } from '../../state/hooks';
import { GanttView } from './GanttView';
import { WbsGanttView } from './WbsGanttView';

export function WorkspaceGanttView() {
  const workspace = useWorkspace();
  const tasks = useWorkspaceTasks();
  const [mode, setMode] = useState('wbs');
  const [rangeMode, setRangeMode] = useState('auto');
  const [rangeRevision, setRangeRevision] = useState(0);
  const [rangeError, setRangeError] = useState('');

  const automaticRange = useMemo(
    () => calculateTaskDateRange(tasks, { paddingDays: 3, fallbackStart: today(), fallbackDays: 30 }),
    [tasks]
  );
  const autoStart = fmtISO(automaticRange.start);
  const autoEnd = fmtISO(automaticRange.end);
  const [rangeStart, setRangeStart] = useState(autoStart);
  const [rangeEnd, setRangeEnd] = useState(autoEnd);

  useEffect(() => {
    setMode('wbs');
    setRangeMode('auto');
    setRangeStart(autoStart);
    setRangeEnd(autoEnd);
    setRangeError('');
    clearGanttDateRangeOverride();
    setRangeRevision((value) => value + 1);
  }, [workspace.selectedProjectId, autoStart, autoEnd]);

  useEffect(() => () => clearGanttDateRangeOverride(), []);

  const applyRange = () => {
    if (!rangeStart || !rangeEnd) {
      setRangeError('Başlangıç ve bitiş tarihlerini seçin.');
      return;
    }
    if (rangeStart > rangeEnd) {
      setRangeError('Başlangıç tarihi bitiş tarihinden sonra olamaz.');
      return;
    }
    setGanttDateRangeOverride({ start: rangeStart, end: rangeEnd });
    setRangeMode('custom');
    setRangeError('');
    setRangeRevision((value) => value + 1);
  };

  const resetRange = () => {
    clearGanttDateRangeOverride();
    setRangeMode('auto');
    setRangeStart(autoStart);
    setRangeEnd(autoEnd);
    setRangeError('');
    setRangeRevision((value) => value + 1);
  };

  const chartKey = `${workspace.selectedProjectId || 'portfolio'}:${mode}:${rangeRevision}`;

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        {workspace.mode === 'project' ? (
          <ProjectGanttModeSwitch mode={mode} setMode={setMode} />
        ) : (
          <div className="muted" style={{ fontSize: 11.5 }}>Portföy Gantt görünümü tüm projeleri birlikte gösterir.</div>
        )}
        <div className="gantt-range-controls">
          <span className="muted" style={{ fontSize: 11.5 }}>Görüntü aralığı</span>
          <input type="date" lang="tr" className="input" value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} />
          <span className="muted">—</span>
          <input type="date" lang="tr" className="input" value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} />
          <button type="button" className="btn primary sm" onClick={applyRange}>Uygula</button>
          <button type="button" className={`btn sm${rangeMode === 'auto' ? ' ghost' : ''}`} onClick={resetRange}>Otomatik</button>
        </div>
      </div>
      <div className="gantt-range-summary">
        {rangeMode === 'auto'
          ? `Otomatik aralık: ${fmt(autoStart, 'dd MMM yyyy')} – ${fmt(autoEnd, 'dd MMM yyyy')}`
          : `Seçili aralık: ${fmt(rangeStart, 'dd MMM yyyy')} – ${fmt(rangeEnd, 'dd MMM yyyy')}`}
        {rangeError && <span style={{ marginLeft: 10, color: 'var(--status-overdue)', fontWeight: 600 }}>{rangeError}</span>}
      </div>

      {workspace.mode === 'portfolio'
        ? <GanttView key={chartKey} />
        : mode === 'wbs'
          ? <WbsGanttView key={chartKey} />
          : <GanttView key={chartKey} />}
    </div>
  );
}

function ProjectGanttModeSwitch({ mode, setMode }) {
  return (
    <div className="gantt-mode-switch row" style={{ gap: 12, flexWrap: 'wrap' }}>
      <div className="seg">
        <button className={mode === 'wbs' ? 'active' : ''} onClick={() => setMode('wbs')}>WBS</button>
        <button className={mode === 'person' ? 'active' : ''} onClick={() => setMode('person')}>Sorumlu / Kritik Yol</button>
      </div>
    </div>
  );
}
