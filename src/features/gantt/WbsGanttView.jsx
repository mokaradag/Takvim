'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from '../../components/icons';
import { InfoButton, Tooltip } from '../../components/ui-extras';
import { buildWbsTree, selectWbsTaskRollup } from '../../domain/selectors/index.js';
import { projectColorVar } from '../../lib/colors';
import { holidayFor } from '../../scheduling/calendars';
import { depId, relTypeOf } from '../../scheduling/dependencies';
import {
  TR_DAYS,
  TR_MONTHS_LONG,
  diffDays,
  eachDay,
  fmt,
  isSameDay,
  isWeekend,
  parseDate,
  today
} from '../../scheduling/dates';
import { getStatus, getTaskDateRange } from '../../scheduling/metrics';
import {
  useProjectSchedule,
  useTaskActions,
  useWorkspace,
  useWorkspaceTasks,
  useWorkspaceWbs
} from '../../state/hooks';

const EMPTY_SCHEDULE_TASKS = Object.freeze({});
const ROW_H = 38;
const GROUP_H = 32;
const HEAD_H = 56;

function buildRows(tree, tasks, wbs, expanded, scheduleTasks) {
  const directTasks = new Map();
  for (const task of tasks) {
    const bucket = directTasks.get(task.wbsId) || [];
    bucket.push(task);
    directTasks.set(task.wbsId, bucket);
  }
  for (const bucket of directTasks.values()) {
    bucket.sort((a, b) => (a.plannedStart || '').localeCompare(b.plannedStart || '') || a.task.localeCompare(b.task, 'tr'));
  }

  const rows = [];
  const visited = new Set();
  const visit = (node, depth) => {
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
    for (const task of directTasks.get(node.id) || []) {
      rows.push({ type: 'task', id: `task:${task.id}`, task, depth: depth + 1 });
    }
    for (const child of node.children || []) visit(child, depth + 1);
  };
  for (const root of tree) visit(root, 0);
  return rows;
}

function CriticalPathDetails({ schedule }) {
  if (!schedule) return null;
  return (
    <>
      <div className="rt-sep" />
      <div className="rt-row"><span className="rt-label">Erken Başlangıç</span><span className="rt-val">{fmt(schedule.earlyStart, 'dd MMM yyyy')}</span></div>
      <div className="rt-row"><span className="rt-label">Erken Bitiş</span><span className="rt-val">{fmt(schedule.earlyFinish, 'dd MMM yyyy')}</span></div>
      <div className="rt-row"><span className="rt-label">Geç Başlangıç</span><span className="rt-val">{fmt(schedule.lateStart, 'dd MMM yyyy')}</span></div>
      <div className="rt-row"><span className="rt-label">Geç Bitiş</span><span className="rt-val">{fmt(schedule.lateFinish, 'dd MMM yyyy')}</span></div>
      <div className="rt-row"><span className="rt-label">Toplam Bolluk</span><span className="rt-val">{schedule.totalFloatDays}g</span></div>
      <div className="rt-row"><span className="rt-label">Kritik yol</span><span className="rt-val" style={schedule.isCritical ? { color: 'var(--status-overdue)', fontWeight: 700 } : null}>{schedule.isCritical ? 'Kritik görev' : 'Kritik değil'}</span></div>
    </>
  );
}

function arrowPath({ fromX, fromY, toX, toY, fromSide, toSide }) {
  const stub = 10;
  if (fromSide === 'R' && toSide === 'L') {
    if (toX <= fromX) {
      const midY = fromY + (toY - fromY) / 2;
      return `M ${fromX} ${fromY} h ${stub} V ${midY} H ${toX - stub} V ${toY} H ${toX}`;
    }
    return `M ${fromX} ${fromY} h ${stub} V ${toY} H ${toX}`;
  }
  if (fromSide === 'L' && toSide === 'L') {
    const leftX = Math.min(fromX, toX) - stub;
    return `M ${fromX} ${fromY} H ${leftX} V ${toY} H ${toX}`;
  }
  if (fromSide === 'R' && toSide === 'R') {
    const rightX = Math.max(fromX, toX) + stub;
    return `M ${fromX} ${fromY} H ${rightX} V ${toY} H ${toX}`;
  }
  const midY = fromY + (toY - fromY) / 2;
  return `M ${fromX} ${fromY} H ${fromX - stub} V ${midY} H ${toX + stub} V ${toY} H ${toX}`;
}

export function WbsGanttView() {
  const workspace = useWorkspace();
  const tasks = useWorkspaceTasks();
  const wbs = useWorkspaceWbs();
  const projectSchedule = useProjectSchedule(workspace.selectedProjectId);
  const { openTask } = useTaskActions();
  const [expanded, setExpanded] = useState(() => new Set());
  const [zoom, setZoom] = useState(28);
  const [hotTaskId, setHotTaskId] = useState(null);
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const today_ = useMemo(() => today(), []);

  useEffect(() => {
    setExpanded(new Set(wbs.map((node) => node.id)));
  }, [workspace.selectedProjectId, wbs]);

  const tree = useMemo(() => buildWbsTree(wbs), [wbs]);
  const scheduleTasks = projectSchedule?.tasks || EMPTY_SCHEDULE_TASKS;
  const rows = useMemo(
    () => buildRows(tree, tasks, wbs, expanded, scheduleTasks),
    [tree, tasks, wbs, expanded, scheduleTasks]
  );
  const knownWbsIds = useMemo(() => new Set(wbs.map((node) => node.id)), [wbs]);
  const unassignedTasks = useMemo(
    () => tasks.filter((task) => !task.wbsId || !knownWbsIds.has(task.wbsId)),
    [tasks, knownWbsIds]
  );
  const visibleRows = useMemo(() => {
    if (!unassignedTasks.length) return rows;
    return [
      ...rows,
      { type: 'wbs-unassigned', id: 'wbs:unassigned', depth: 0, label: `Atanmamış WBS (${unassignedTasks.length})` },
      ...unassignedTasks.map((task) => ({ type: 'task', id: `unassigned:${task.id}`, task, depth: 1 }))
    ];
  }, [rows, unassignedTasks]);

  const scheduledTasks = useMemo(
    () => tasks.filter((task) => task.plannedStart && task.plannedFinish),
    [tasks]
  );
  const range = useMemo(
    () => getTaskDateRange(scheduledTasks, { paddingDays: 3, fallbackStart: today_, fallbackDays: 30 }),
    [scheduledTasks, today_]
  );
  const days = useMemo(() => eachDay(range.start, range.end), [range]);
  const totalWidth = days.length * zoom;
  const xForDate = useCallback((date) => diffDays(date, range.start) * zoom, [range.start, zoom]);

  const rowTops = useMemo(() => {
    const tops = [];
    let total = 0;
    for (const row of visibleRows) {
      tops.push(total);
      total += row.type === 'task' ? ROW_H : GROUP_H;
    }
    return { tops, total };
  }, [visibleRows]);

  const taskRowIndex = useMemo(() => {
    const index = new Map();
    visibleRows.forEach((row, rowIndex) => {
      if (row.type === 'task') index.set(row.task.id, rowIndex);
    });
    return index;
  }, [visibleRows]);

  const arrows = useMemo(() => {
    const result = [];
    visibleRows.forEach((row, rowIndex) => {
      if (row.type !== 'task') return;
      for (const dependency of row.task.deps || []) {
        const predecessorId = depId(dependency);
        const predecessorIndex = taskRowIndex.get(predecessorId);
        if (predecessorIndex == null) continue;
        const predecessor = visibleRows[predecessorIndex].task;
        if (!predecessor?.plannedStart || !predecessor?.plannedFinish || !row.task.plannedStart || !row.task.plannedFinish) continue;

        const type = relTypeOf(dependency);
        const predStart = xForDate(parseDate(predecessor.plannedStart));
        const predEnd = xForDate(parseDate(predecessor.plannedFinish)) + zoom;
        const succStart = xForDate(parseDate(row.task.plannedStart));
        const succEnd = xForDate(parseDate(row.task.plannedFinish)) + zoom;
        let fromX;
        let toX;
        let fromSide;
        let toSide;
        if (type === 'FS') { fromX = predEnd; toX = succStart; fromSide = 'R'; toSide = 'L'; }
        else if (type === 'SS') { fromX = predStart; toX = succStart; fromSide = 'L'; toSide = 'L'; }
        else if (type === 'FF') { fromX = predEnd; toX = succEnd; fromSide = 'R'; toSide = 'R'; }
        else { fromX = predStart; toX = succEnd; fromSide = 'L'; toSide = 'R'; }

        result.push({
          id: `${predecessorId}-${row.task.id}-${type}`,
          fromX,
          toX,
          fromSide,
          toSide,
          fromY: rowTops.tops[predecessorIndex] + ROW_H / 2,
          toY: rowTops.tops[rowIndex] + ROW_H / 2,
          hot: hotTaskId === predecessorId || hotTaskId === row.task.id,
          critical: Boolean(projectSchedule?.criticalDependencyKeys?.includes(`${predecessorId}::${row.task.id}`))
        });
      }
    });
    return result;
  }, [visibleRows, taskRowIndex, rowTops, xForDate, zoom, hotTaskId, projectSchedule]);

  useEffect(() => {
    const left = leftRef.current;
    const right = rightRef.current;
    if (!left || !right) return undefined;
    let syncing = false;
    const syncFromLeft = () => {
      if (syncing) return;
      syncing = true;
      right.scrollTop = left.scrollTop;
      syncing = false;
    };
    const syncFromRight = () => {
      if (syncing) return;
      syncing = true;
      left.scrollTop = right.scrollTop;
      syncing = false;
    };
    left.addEventListener('scroll', syncFromLeft);
    right.addEventListener('scroll', syncFromRight);
    return () => {
      left.removeEventListener('scroll', syncFromLeft);
      right.removeEventListener('scroll', syncFromRight);
    };
  }, []);

  useEffect(() => {
    const element = rightRef.current;
    if (!element) return undefined;
    let dragging = false;
    let startX = 0;
    let startScroll = 0;
    const onDown = (event) => {
      if (event.button !== 0 || event.target.closest('.gantt-bar') || event.target.closest('.gantt-milestone')) return;
      dragging = true;
      startX = event.clientX;
      startScroll = element.scrollLeft;
      element.classList.add('is-panning');
    };
    const onMove = (event) => {
      if (!dragging) return;
      element.scrollLeft = startScroll - (event.clientX - startX);
    };
    const onUp = () => {
      dragging = false;
      element.classList.remove('is-panning');
    };
    element.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      element.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  useEffect(() => {
    const element = rightRef.current;
    if (!element) return;
    element.scrollLeft = Math.max(0, xForDate(today_) + zoom / 2 - element.clientWidth / 3);
  }, [today_, xForDate, zoom]);

  const toggle = (id) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!wbs.length) {
    return <div className="card muted">Bu projede WBS bulunmadığı için hiyerarşik Gantt oluşturulamıyor.</div>;
  }

  const projectColor = projectColorVar(workspace.selectedProject?.name || '');
  const wrapStyle = {
    height: 'calc(100vh - 240px)',
    '--gantt-left-w': '360px',
    '--gantt-left-cols': 'minmax(320px, 1fr)'
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div className="col" style={{ gap: 2 }}>
          <div style={{ fontWeight: 700 }}>{workspace.selectedProject?.name} · WBS Gantt</div>
          <div className="muted" style={{ fontSize: 11.5 }}>WBS hiyerarşisi, görevler, kritik yol ve bağımlılıklar aynı zaman ekseninde gösterilir.</div>
        </div>
        <div className="row" style={{ marginLeft: 'auto', gap: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>Zoom</span>
          <div className="seg">
            <button className={zoom === 22 ? 'active' : ''} onClick={() => setZoom(22)}>S</button>
            <button className={zoom === 28 ? 'active' : ''} onClick={() => setZoom(28)}>M</button>
            <button className={zoom === 40 ? 'active' : ''} onClick={() => setZoom(40)}>L</button>
          </div>
          <InfoButton title="Kritik Yol" icon={<Icons.Gantt size={12} />} corner accent="var(--c-purple)">
            <p>Kritik Yol Yöntemi (CPM), proje bitişini doğrudan etkileyen görev zincirini gösterir. Kırmızı çerçeveli görevlerde gecikme proje bitişini geciktirebilir.</p>
            <div className="rt-sep" />
            <div className="rt-row"><Icons.ChevronDown size={12} className="rt-ico" /><span>WBS satırına tıkla: daralt/genişlet</span></div>
            <div className="rt-row"><Icons.Grip size={12} className="rt-ico" /><span>Boş alana basılı tut: yatay kaydır</span></div>
            <div className="rt-row"><Icons.Link size={12} className="rt-ico" /><span>Bağımlılık çizgileri: FS / SS / FF / SF</span></div>
          </InfoButton>
        </div>
      </div>

      <div className="row" style={{ gap: 14, fontSize: 11.5, color: 'var(--text-dim)', flexWrap: 'wrap' }}>
        <span className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 6, background: 'linear-gradient(180deg, var(--text) 0%, color-mix(in oklab, var(--text) 80%, black) 100%)', borderRadius: 1 }} /> WBS özeti</span>
        <span className="row" style={{ gap: 6 }}><span style={{ width: 12, height: 7, border: '2px solid var(--status-overdue)', borderRadius: 2 }} /> Kritik görev</span>
        <span className="row" style={{ gap: 6 }}><span style={{ width: 16, height: 2, background: 'var(--status-overdue)' }} /> Kritik ilişki</span>
        <span className="row" style={{ gap: 6 }}><span style={{ width: 1, height: 12, background: 'var(--accent)' }} /> Bugün</span>
      </div>

      <div className="gantt-wrap" style={wrapStyle}>
        <div className="gantt-left" ref={leftRef}>
          <div className="gantt-left-head" style={{ display: 'flex', alignItems: 'center', padding: '0 12px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>WBS / GÖREV</div>
          {visibleRows.map((row) => {
            if (row.type !== 'task') {
              const unassigned = row.type === 'wbs-unassigned';
              const collapsed = !unassigned && !expanded.has(row.node.id);
              return (
                <div
                  key={row.id}
                  className={`gantt-group-header${collapsed ? ' collapsed' : ''}`}
                  onClick={() => !unassigned && toggle(row.node.id)}
                  style={{ cursor: unassigned ? 'default' : 'pointer', paddingLeft: 10 + row.depth * 18 }}
                >
                  {!unassigned && <Icons.ChevronDown size={11} style={{ transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.18s' }} />}
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: unassigned ? 'var(--status-overdue)' : projectColor }} />
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{unassigned ? row.label : `${row.node.code} ${row.node.name}`}</span>
                  {!unassigned && row.rollup && (
                    <span className="muted tabular" style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600 }}>{row.rollup.taskCount} görev · {row.rollup.progress}% · {row.rollup.criticalTaskCount} kritik</span>
                  )}
                </div>
              );
            }

            const taskSchedule = scheduleTasks[row.task.id];
            const critical = Boolean(taskSchedule?.isCritical);
            return (
              <div
                key={row.id}
                className={`gantt-task-row${hotTaskId === row.task.id ? ' hot' : ''}`}
                onClick={() => openTask(row.task)}
                onMouseEnter={() => setHotTaskId(row.task.id)}
                onMouseLeave={() => setHotTaskId(null)}
                style={{ cursor: 'pointer' }}
              >
                <div className="tr-name" style={{ paddingLeft: 12 + row.depth * 18 }}>
                  {row.task.milestone
                    ? <Icons.Diamond size={11} style={{ color: critical ? 'var(--status-overdue)' : projectColor }} />
                    : <span style={{ width: 3, height: 18, borderRadius: 2, background: projectColor }} />}
                  <span>{row.task.task}</span>
                  {critical && <span title="Kritik yol görevi" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--status-overdue)', flexShrink: 0 }} />}
                </div>
              </div>
            );
          })}
        </div>

        <div className="gantt-right" ref={rightRef}>
          <div className="gantt-right-inner" style={{ width: totalWidth, position: 'relative', height: HEAD_H + rowTops.total }}>
            <div className="gantt-day-strip" style={{ gridTemplateColumns: `repeat(${days.length}, ${zoom}px)` }}>
              {days.map((day, index) => {
                const weekend = isWeekend(day);
                const holiday = holidayFor(day);
                const current = isSameDay(day, today_);
                const showMonth = index === 0 || day.getDate() === 1;
                return (
                  <div key={index} className={`gantt-day-cell${weekend ? ' weekend' : ''}${holiday ? ' holiday' : ''}${current ? ' today' : ''}`}>
                    {showMonth && <div className="dmon">{TR_MONTHS_LONG[day.getMonth()]} {day.getFullYear()}</div>}
                    <div className="ddow">{TR_DAYS[(day.getDay() + 6) % 7][0]}</div>
                    <div className="dnum">{day.getDate()}</div>
                  </div>
                );
              })}
            </div>

            {days.map((day, index) => (!isWeekend(day) || holidayFor(day)) ? null : <div key={`weekend-${index}`} className="gantt-weekend-stripe" style={{ left: index * zoom, width: zoom }} />)}

            {days.map((day, index) => {
              const holiday = holidayFor(day);
              if (!holiday) return null;
              return (
                <Tooltip key={`holiday-${index}`} title={holiday.name} icon={<Icons.Gift size={12} />} content={<div className="rt-row"><span className="rt-label">Resmi tatil</span><span className="rt-val">{holiday.short}</span></div>}>
                  <span className="gantt-holiday-stripe" style={{ position: 'absolute', left: index * zoom, width: zoom }} />
                </Tooltip>
              );
            })}

            {visibleRows.map((row, index) => {
              const top = HEAD_H + rowTops.tops[index];
              if (row.type !== 'task') {
                const rollup = row.type === 'wbs' ? row.rollup : null;
                return (
                  <React.Fragment key={`canvas-${row.id}`}>
                    <div style={{ position: 'absolute', top, left: 0, right: 0, height: GROUP_H, background: 'color-mix(in oklab, var(--text) 4%, var(--bg-elev))', borderBottom: '1px solid var(--border-strong)' }} />
                    {rollup?.plannedStart && rollup?.plannedFinish && (
                      <Tooltip
                        title={`${row.node.code} ${row.node.name}`}
                        icon={<Icons.Layers size={12} />}
                        content={<>
                          <div className="rt-row"><span className="rt-label">Başlangıç</span><span className="rt-val">{fmt(rollup.plannedStart, 'dd MMM yyyy')}</span></div>
                          <div className="rt-row"><span className="rt-label">Bitiş</span><span className="rt-val">{fmt(rollup.plannedFinish, 'dd MMM yyyy')}</span></div>
                          <div className="rt-row"><span className="rt-label">Görev</span><span className="rt-val">{rollup.taskCount}</span></div>
                          <div className="rt-row"><span className="rt-label">İlerleme</span><span className="rt-val">{rollup.progress}%</span></div>
                          <div className="rt-row"><span className="rt-label">Kritik görev</span><span className="rt-val">{rollup.criticalTaskCount}</span></div>
                        </>}
                      >
                        <div className="gantt-summary-bar" style={{ top: top + 9, left: xForDate(parseDate(rollup.plannedStart)), width: Math.max(8, (diffDays(rollup.plannedFinish, rollup.plannedStart) + 1) * zoom), pointerEvents: 'auto' }}>
                          <div className="summary-progress" style={{ width: `${Math.min(100, rollup.progress)}%` }} />
                        </div>
                      </Tooltip>
                    )}
                  </React.Fragment>
                );
              }

              const task = row.task;
              const taskSchedule = scheduleTasks[task.id];
              const critical = Boolean(taskSchedule?.isCritical);
              const status = getStatus(task, today_);
              const overdue = task.status !== 'done' && task.targetFinish && diffDays(task.targetFinish, today_) < 0;
              const progress = task.progress != null ? task.progress : (task.status === 'done' ? 100 : 0);
              const rowLine = <div style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_H, borderBottom: '1px solid var(--border)' }} />;
              if (!task.plannedStart || !task.plannedFinish) return <React.Fragment key={`canvas-${row.id}`}>{rowLine}</React.Fragment>;

              if (task.milestone) {
                const left = xForDate(parseDate(task.plannedStart)) + zoom / 2 - 8;
                return (
                  <React.Fragment key={`canvas-${row.id}`}>
                    {rowLine}
                    <Tooltip title={`${task.task} · Kilometre taşı`} icon={<Icons.Diamond size={11} />} content={<>
                      <div className="rt-row"><span className="rt-label">Tarih</span><span className="rt-val">{fmt(task.plannedStart, 'dd MMM yyyy')}</span></div>
                      <div className="rt-row"><span className="rt-label">Durum</span><span className="rt-val">{status.label}</span></div>
                      <div className="rt-row"><span className="rt-label">Sorumlu</span><span className="rt-val">{task.sorumlu?.join(', ') || '—'}</span></div>
                      <CriticalPathDetails schedule={taskSchedule} />
                    </>}>
                      <div className="gantt-milestone" style={{ '--milestone-color': critical ? 'var(--status-overdue)' : projectColor, top: top + 11, left }} onClick={() => openTask(task)} onMouseEnter={() => setHotTaskId(task.id)} onMouseLeave={() => setHotTaskId(null)} />
                    </Tooltip>
                  </React.Fragment>
                );
              }

              const left = xForDate(parseDate(task.plannedStart));
              const width = (diffDays(task.plannedFinish, task.plannedStart) + 1) * zoom;
              return (
                <React.Fragment key={`canvas-${row.id}`}>
                  {rowLine}
                  <Tooltip title={task.task} icon={<span style={{ width: 12, height: 8, borderRadius: 2, background: projectColor, display: 'inline-block' }} />} content={<>
                    <div className="rt-row"><span className="rt-label">Başlangıç</span><span className="rt-val">{fmt(task.plannedStart, 'dd MMM yyyy')}</span></div>
                    <div className="rt-row"><span className="rt-label">Bitiş</span><span className="rt-val">{fmt(task.plannedFinish, 'dd MMM yyyy')}</span></div>
                    <div className="rt-row"><span className="rt-label">Hedef</span><span className="rt-val" style={overdue ? { color: 'var(--status-overdue)' } : null}>{task.targetFinish ? fmt(task.targetFinish, 'dd MMM yyyy') : '—'}</span></div>
                    <div className="rt-sep" />
                    <div className="rt-row"><span className="rt-label">Durum</span><span className="rt-val">{status.label}</span></div>
                    <div className="rt-row"><span className="rt-label">İlerleme</span><span className="rt-val">{progress}%</span></div>
                    <div className="rt-row"><span className="rt-label">Sorumlu</span><span className="rt-val">{task.sorumlu?.join(', ') || '—'}</span></div>
                    <CriticalPathDetails schedule={taskSchedule} />
                  </>}>
                    <div className={`gantt-bar${task.status === 'done' ? ' done' : ''}`} style={{ '--bar-color': projectColor, position: 'absolute', left: left + 2, width: Math.max(20, width - 4), top: top + 8, boxShadow: critical ? '0 0 0 2px var(--status-overdue)' : undefined }} onClick={() => openTask(task)} onMouseEnter={() => setHotTaskId(task.id)} onMouseLeave={() => setHotTaskId(null)}>
                      {progress > 0 && progress < 100 && <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(to right, color-mix(in oklab, ${projectColor} 100%, black 18%) ${progress}%, transparent ${progress}%)`, borderRadius: 'inherit' }} />}
                      <span style={{ position: 'relative', zIndex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.keyword || task.task}</span>
                    </div>
                  </Tooltip>
                </React.Fragment>
              );
            })}

            <svg style={{ position: 'absolute', top: HEAD_H, left: 0, width: totalWidth, height: rowTops.total, pointerEvents: 'none', zIndex: 4 }} width={totalWidth} height={rowTops.total}>
              <defs>
                <marker id="wbs-arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L0,6 L6,3 z" fill="var(--text-muted)" /></marker>
                <marker id="wbs-arrowhead-hot" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L0,6 L6,3 z" fill="var(--accent)" /></marker>
                <marker id="wbs-arrowhead-critical" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L0,6 L6,3 z" fill="var(--status-overdue)" /></marker>
              </defs>
              {arrows.map((arrow) => (
                <path
                  key={arrow.id}
                  d={arrowPath(arrow)}
                  fill="none"
                  stroke={arrow.critical ? 'var(--status-overdue)' : arrow.hot ? 'var(--accent)' : 'var(--text-muted)'}
                  strokeWidth={arrow.critical || arrow.hot ? 1.8 : 1.1}
                  opacity={arrow.critical || arrow.hot ? 0.95 : 0.55}
                  markerEnd={`url(#${arrow.critical ? 'wbs-arrowhead-critical' : arrow.hot ? 'wbs-arrowhead-hot' : 'wbs-arrowhead'})`}
                />
              ))}
            </svg>

            {days.map((day, index) => isSameDay(day, today_) ? <div key={`today-${index}`} style={{ position: 'absolute', top: HEAD_H, bottom: 0, left: index * zoom + zoom / 2, width: 1, background: 'var(--accent)', zIndex: 3, pointerEvents: 'none' }} /> : null)}
          </div>
        </div>
      </div>
    </div>
  );
}
