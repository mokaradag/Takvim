'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  buildWbsTree,
  selectWbsTaskRollup
} from '../../domain/selectors/index.js';
import { validateWbsStructure } from '../../domain/validation/index.js';
import { projectColorVar } from '../../lib/colors';
import { diffDays, fmt } from '../../scheduling/dates';
import { getTaskDateRange } from '../../scheduling/metrics';
import {
  useProjectSchedule,
  useTaskActions,
  useWorkspace,
  useWorkspaceTasks,
  useWorkspaceWbs
} from '../../state/hooks';
import { GanttView } from './GanttView';

function percent(value, start, totalDays) {
  return Math.max(0, Math.min(100, (diffDays(value, start) / totalDays) * 100));
}

function widthPercent(start, finish, rangeStart, totalDays) {
  return Math.max(0.7, ((diffDays(finish, start) + 1) / totalDays) * 100);
}

function buildRows(tree, tasks, wbs, expanded, scheduleTasks) {
  const directByWbsId = new Map();
  for (const task of tasks) {
    const bucket = directByWbsId.get(task.wbsId) || [];
    bucket.push(task);
    directByWbsId.set(task.wbsId, bucket);
  }
  for (const bucket of directByWbsId.values()) {
    bucket.sort((left, right) => (left.plannedStart || '').localeCompare(right.plannedStart || '') || left.task.localeCompare(right.task, 'tr'));
  }

  const rows = [];
  const visited = new Set();
  function visit(node, depth) {
    if (!node || visited.has(node.id)) return;
    visited.add(node.id);
    rows.push({
      type: 'wbs',
      id: `wbs:${node.id}`,
      node,
      depth,
      rollup: selectWbsTaskRollup(wbs, tasks, node.id, scheduleTasks)
    });
    if (!expanded.has(node.id)) return;
    for (const task of directByWbsId.get(node.id) || []) {
      rows.push({ type: 'task', id: `task:${task.id}`, task, depth: depth + 1 });
    }
    for (const child of node.children || []) visit(child, depth + 1);
  }
  for (const root of tree) visit(root, 0);
  return rows;
}

export function WorkspaceGanttView() {
  const workspace = useWorkspace();
  if (workspace.mode === 'portfolio') return <GanttView />;
  return <ProjectWorkspaceGantt />;
}

function ProjectWorkspaceGantt() {
  const workspace = useWorkspace();
  const tasks = useWorkspaceTasks();
  const wbs = useWorkspaceWbs();
  const projectSchedule = useProjectSchedule(workspace.selectedProjectId);
  const { openTask } = useTaskActions();
  const [mode, setMode] = useState('wbs');
  const [expanded, setExpanded] = useState(() => new Set());

  useEffect(() => {
    setMode('wbs');
    setExpanded(new Set(wbs.map((node) => node.id)));
  }, [workspace.selectedProjectId, wbs]);

  const tree = useMemo(() => buildWbsTree(wbs), [wbs]);
  const validationIssues = useMemo(() => validateWbsStructure(wbs), [wbs]);
  const scheduleTasks = projectSchedule?.tasks || {};
  const rows = useMemo(
    () => buildRows(tree, tasks, wbs, expanded, scheduleTasks),
    [tree, tasks, wbs, expanded, scheduleTasks]
  );
  const knownWbsIds = useMemo(() => new Set(wbs.map((node) => node.id)), [wbs]);
  const unassignedTasks = tasks.filter((task) => !task.wbsId || !knownWbsIds.has(task.wbsId));
  const scheduledTasks = tasks.filter((task) => task.plannedStart && task.plannedFinish);
  const range = getTaskDateRange(scheduledTasks, { paddingDays: 2, fallbackDays: 30 });
  const totalDays = Math.max(1, diffDays(range.end, range.start) + 1);
  const ticks = Array.from({ length: 7 }, (_, index) => {
    const dayOffset = Math.round((index / 6) * Math.max(0, totalDays - 1));
    const date = new Date(range.start);
    date.setDate(date.getDate() + dayOffset);
    return { date, left: (dayOffset / totalDays) * 100 };
  });

  if (mode === 'person') {
    return (
      <div className="col" style={{ gap: 12 }}>
        <ProjectGanttModeSwitch mode={mode} setMode={setMode} />
        <GanttView />
      </div>
    );
  }

  const toggle = (id) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      <ProjectGanttModeSwitch mode={mode} setMode={setMode} />

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div className="col" style={{ gap: 4 }}>
            <div style={{ fontWeight: 700 }}>{workspace.selectedProject?.name} · WBS zaman çizelgesi</div>
            <div className="muted" style={{ fontSize: 12 }}>
              WBS özet çubukları alt aktivitelerin Güncel Plan tarih aralığından türetilir; WBS düğümleri görev değildir.
            </div>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="badge">{tasks.length} aktivite</span>
            <span className="badge">{projectSchedule?.criticalTaskIds?.length || 0} kritik</span>
            <span className="badge">CPM bitiş: {projectSchedule?.projectFinish || '—'}</span>
          </div>
        </div>
      </div>

      {(validationIssues.length > 0 || projectSchedule?.status === 'invalid') && (
        <div className="card" style={{ borderColor: 'color-mix(in oklab, var(--status-overdue) 45%, var(--border))' }}>
          <div className="col" style={{ gap: 4, fontSize: 12.5 }}>
            {validationIssues.map((item, index) => <span key={`${item.code}-${index}`}>{item.code} · {item.nodeId}</span>)}
            {projectSchedule?.status === 'invalid' && <span>{projectSchedule.error?.code}: {projectSchedule.error?.message}</span>}
          </div>
        </div>
      )}

      {!wbs.length ? (
        <div className="card muted">Bu projede WBS bulunmadığı için hiyerarşik Gantt oluşturulamıyor.</div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <div style={{ minWidth: 1100 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '370px minmax(720px, 1fr)', borderBottom: '1px solid var(--border)' }}>
              <div style={{ padding: '12px 14px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>WBS / Aktivite</div>
              <div style={{ position: 'relative', minHeight: 42, borderLeft: '1px solid var(--border)' }}>
                {ticks.map((tick, index) => (
                  <div key={index} style={{ position: 'absolute', left: `${tick.left}%`, top: 0, bottom: 0, borderLeft: '1px solid var(--border)', padding: '10px 0 0 6px', fontSize: 10.5, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {fmt(tick.date, 'dd MMM')}
                  </div>
                ))}
              </div>
            </div>

            {rows.map((row) => (
              <GanttRow
                key={row.id}
                row={row}
                rangeStart={range.start}
                totalDays={totalDays}
                expanded={expanded}
                onToggle={toggle}
                onOpenTask={openTask}
                taskSchedule={row.type === 'task' ? scheduleTasks[row.task.id] : null}
              />
            ))}

            {unassignedTasks.length > 0 && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '370px minmax(720px, 1fr)', minHeight: 42, borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ padding: '11px 14px', fontWeight: 700, color: 'var(--status-overdue)' }}>Atanmamış WBS ({unassignedTasks.length})</div>
                  <div style={{ borderLeft: '1px solid var(--border)' }} />
                </div>
                {unassignedTasks.map((task) => (
                  <GanttRow
                    key={`unassigned:${task.id}`}
                    row={{ type: 'task', task, depth: 1 }}
                    rangeStart={range.start}
                    totalDays={totalDays}
                    expanded={expanded}
                    onToggle={toggle}
                    onOpenTask={openTask}
                    taskSchedule={scheduleTasks[task.id]}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectGanttModeSwitch({ mode, setMode }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <div className="seg">
        <button className={mode === 'wbs' ? 'active' : ''} onClick={() => setMode('wbs')}>WBS</button>
        <button className={mode === 'person' ? 'active' : ''} onClick={() => setMode('person')}>Sorumlu / CPM</button>
      </div>
      <div className="muted" style={{ fontSize: 11.5 }}>Proje çalışma alanında varsayılan görünüm WBS hiyerarşisidir.</div>
    </div>
  );
}

function GanttRow({ row, rangeStart, totalDays, expanded, onToggle, onOpenTask, taskSchedule }) {
  const isWbs = row.type === 'wbs';
  const start = isWbs ? row.rollup.plannedStart : row.task.plannedStart;
  const finish = isWbs ? row.rollup.plannedFinish : row.task.plannedFinish;
  const critical = !isWbs && taskSchedule?.isCritical;
  const milestone = !isWbs && row.task.milestone;
  const barLeft = start ? percent(start, rangeStart, totalDays) : 0;
  const barWidth = start && finish ? widthPercent(start, finish, rangeStart, totalDays) : 0;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '370px minmax(720px, 1fr)', minHeight: 44, borderBottom: '1px solid var(--border)', background: isWbs ? 'color-mix(in oklab, var(--bg-elev-2) 58%, transparent)' : 'transparent' }}>
      <button
        type="button"
        onClick={() => (isWbs ? onToggle(row.node.id) : onOpenTask(row.task))}
        style={{ border: 0, background: 'transparent', color: 'inherit', textAlign: 'left', padding: '8px 14px', cursor: 'pointer' }}
      >
        <div className="row" style={{ gap: 8, paddingLeft: row.depth * 18, minWidth: 0 }}>
          {isWbs ? (
            <span style={{ width: 16, color: 'var(--text-muted)' }}>{expanded.has(row.node.id) ? '▾' : '▸'}</span>
          ) : (
            <span style={{ width: 16, textAlign: 'center', color: critical ? 'var(--status-overdue)' : 'var(--text-dim)' }}>{milestone ? '◆' : '•'}</span>
          )}
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <div style={{ fontWeight: isWbs ? 700 : 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: critical ? 'var(--status-overdue)' : 'inherit' }}>
              {isWbs ? `${row.node.code} ${row.node.name}` : row.task.task}
            </div>
            <div className="muted" style={{ fontSize: 10.5 }}>
              {isWbs
                ? `${row.rollup.taskCount} aktivite · ${row.rollup.progress}% · ${row.rollup.criticalTaskCount} kritik`
                : `${row.task.sorumlu?.join(', ') || 'Sorumlu yok'}${taskSchedule ? ` · TF ${taskSchedule.totalFloatDays}g` : ''}`}
            </div>
          </div>
        </div>
      </button>
      <div style={{ position: 'relative', minHeight: 44, borderLeft: '1px solid var(--border)', backgroundImage: 'linear-gradient(to right, color-mix(in oklab, var(--border) 45%, transparent) 1px, transparent 1px)', backgroundSize: `${100 / Math.min(totalDays, 31)}% 100%` }}>
        {start && finish && (
          milestone ? (
            <div title={`${start} · Milestone`} style={{ position: 'absolute', left: `${barLeft}%`, top: 14, width: 14, height: 14, transform: 'translateX(-50%) rotate(45deg)', background: critical ? 'var(--status-overdue)' : projectColorVar(row.task.proje), border: '2px solid var(--bg-elev-1)', boxShadow: '0 0 0 1px var(--border)' }} />
          ) : (
            <div
              title={`${start} → ${finish}`}
              style={{
                position: 'absolute',
                left: `${barLeft}%`,
                width: `${barWidth}%`,
                top: isWbs ? 18 : 12,
                height: isWbs ? 8 : 20,
                minWidth: 4,
                borderRadius: isWbs ? 3 : 5,
                background: isWbs ? 'color-mix(in oklab, var(--accent) 72%, var(--text))' : (critical ? 'var(--status-overdue)' : projectColorVar(row.task.proje)),
                opacity: isWbs ? 0.72 : 0.92,
                boxShadow: critical ? '0 0 0 1px color-mix(in oklab, var(--status-overdue) 55%, transparent)' : 'none'
              }}
            />
          )
        )}
      </div>
    </div>
  );
}
