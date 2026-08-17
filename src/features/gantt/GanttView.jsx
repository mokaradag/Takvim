'use client';
import React, { useState as useState2, useMemo as useMemo2, useEffect as useEffect2, useRef as useRef2 } from 'react';
import { Icons } from '../../components/icons';
import { PRIORITIES, normalizePriorityId, resolvePriority } from '../../domain/constants';
import { TR_MONTHS_LONG, TR_DAYS, parseDate, fmtISO, fmt, diffDays, isSameDay, isWeekend, today, eachDay } from '../../scheduling/dates';
import { holidayFor } from '../../scheduling/calendars';
import { depId, relTypeOf } from '../../scheduling/dependencies';
import { getTaskDateRange, getGroupScheduleSummaries, taskDurationDays, getStatus } from '../../scheduling/metrics';
import { projectColorVar, personColorVar } from '../../lib/colors';
import { Avatar, AvatarStack, StatusPill, StatusIcon } from '../../components/ui';
import { Tooltip, InfoButton, ColumnFilter, dateMatchesFilter, numericMatchesFilter } from '../../components/ui-extras';
import { useTasks, useProjects, usePeople, usePortfolioSchedule, useTaskActions } from '../../state/hooks';

/* ── Gantt ──────────────────────────────────────────────── */
const GANTT_DEFAULT_COLS = {
  start: true,
  end: true,
  hedef: false,
  duration: false,
  earlyStart: false,
  earlyFinish: false,
  lateStart: false,
  lateFinish: false,
  totalFloat: false,
  freeFloat: false,
  hours: false,
  progress: false,
  status: false,
  sorumlu: false,
  priority: false
};
const GANTT_COL_DEFS = [
  { key: 'start', label: 'Başlangıç', width: 78, align: 'right', render: (t) => fmtMaybe(t.plannedStart, 'dd MMM') },
  { key: 'end', label: 'Bitiş', width: 78, align: 'right', render: (t, today_) => {
      const overdue = t.status !== 'done' && t.targetFinish && diffDays(t.targetFinish, today_) < 0;
      return <span style={{ color: overdue ? 'var(--status-overdue)' : 'inherit', fontWeight: overdue ? 600 : 500 }}>{fmtMaybe(t.plannedFinish, 'dd MMM')}</span>;
  } },
  { key: 'hedef', label: 'Hedef', width: 78, align: 'right', render: (t) => t.targetFinish ? fmt(t.targetFinish, 'dd MMM') : '—' },
  { key: 'duration', label: 'Süre', width: 56, align: 'right', render: (t) => {
      const d = taskDurationDays(t);
      return <span className="tabular">{d}g</span>;
  } },
  { key: 'earlyStart', label: 'Erken Başlangıç', width: 96, align: 'right', render: (t, today_, schedule) => schedule ? fmt(schedule.earlyStart, 'dd MMM') : <span className="muted">—</span> },
  { key: 'earlyFinish', label: 'Erken Bitiş', width: 86, align: 'right', render: (t, today_, schedule) => schedule ? fmt(schedule.earlyFinish, 'dd MMM') : <span className="muted">—</span> },
  { key: 'lateStart', label: 'Geç Başlangıç', width: 92, align: 'right', render: (t, today_, schedule) => schedule ? fmt(schedule.lateStart, 'dd MMM') : <span className="muted">—</span> },
  { key: 'lateFinish', label: 'Geç Bitiş', width: 82, align: 'right', render: (t, today_, schedule) => schedule ? fmt(schedule.lateFinish, 'dd MMM') : <span className="muted">—</span> },
  { key: 'totalFloat', label: 'Toplam Bolluk', width: 88, align: 'right', render: (t, today_, schedule) => {
      if (!schedule) return <span className="muted">—</span>;
      const critical = schedule.totalFloatDays <= 0;
      return <span className="tabular" style={{ color: critical ? 'var(--status-overdue)' : 'inherit', fontWeight: critical ? 700 : 500 }}>{schedule.totalFloatDays}g</span>;
  } },
  { key: 'freeFloat', label: 'Serbest Bolluk', width: 88, align: 'right', render: (t, today_, schedule) => schedule ? <span className="tabular">{schedule.freeFloatDays}g</span> : <span className="muted">—</span> },
  { key: 'hours', label: 'Saat', width: 64, align: 'right', render: (t) => {
      if (t.milestone) return <span className="muted">—</span>;
      return <span className="tabular" style={{ fontSize: 11 }}>{t.actualHours || 0}/{t.plannedHours || 0}</span>;
  } },
  { key: 'progress', label: '%', width: 56, align: 'right', render: (t) => {
      const p = t.progress != null ? t.progress : (t.status === 'done' ? 100 : 0);
      return <span className="tabular">{p}%</span>;
  } },
  { key: 'status', label: 'Durum', width: 110, align: 'left', render: (t) => <StatusPill task={t} size={10.5} /> },
  { key: 'sorumlu', label: 'Sorumlu', width: 80, align: 'right', render: (t) => <AvatarStack names={t.sorumlu} personIds={t.assigneeIds} max={2} size="sm" /> },
  { key: 'priority', label: 'Öncelik', width: 76, align: 'left', render: (t) => {
      const p = resolvePriority(t.priority);
      return <span style={{ fontSize: 11, fontWeight: 600, color: p.color }}>{p.label}</span>;
  } }
];

const CPM_WARNING_LABELS = {
  CROSS_PROJECT_DEPENDENCY: 'Projeler arası bağımlılık bu CPM görünümünde desteklenmiyor.',
  DEPENDENCY_CYCLE: 'Bağımlılık döngüsü algılandı.',
  MISSING_PREDECESSOR: 'Eksik bir öncül görev referansı var.',
  SELF_DEPENDENCY: 'Bir görev kendisine bağımlı olamaz.',
  MISSING_TASK_DATE: 'CPM için gerekli görev tarihi eksik.',
  INVALID_TASK_DATE: 'Geçersiz bir görev tarihi var.',
  INVALID_TASK_DATES: 'Görev başlangıç ve bitiş tarihleri geçersiz.',
  MISSING_PROJECT_START: 'Proje başlangıcı belirlenemedi.',
  INVALID_PROJECT_START: 'Proje başlangıcı geçersiz.',
  UNKNOWN_PROJECT: 'Görevin geçerli bir proje ilişkisi yok.'
};

function warningText(warning, projectById) {
  const project = warning.projectId ? projectById.get(warning.projectId) : null;
  const scope = project?.name || (warning.taskId ? `Görev ${warning.taskId}` : 'Zamanlama');
  return `${scope}: ${CPM_WARNING_LABELS[warning.code] || warning.message} [${warning.code}]`;
}

function hasPlannedRange(task) {
  return Boolean(task?.plannedStart && task?.plannedFinish);
}

function fmtMaybe(value, pattern) {
  return value ? fmt(value, pattern) : <span className="muted">—</span>;
}

function CpmTooltipRows({ schedule }) {
  if (!schedule) return null;
  return (
    <>
      <div className="rt-sep" />
      <div className="rt-row"><span className="rt-label">Erken Başlangıç</span><span className="rt-val">{fmt(schedule.earlyStart, 'dd MMM yyyy')}</span></div>
      <div className="rt-row"><span className="rt-label">Erken Bitiş</span><span className="rt-val">{fmt(schedule.earlyFinish, 'dd MMM yyyy')}</span></div>
      <div className="rt-row"><span className="rt-label">Geç Başlangıç</span><span className="rt-val">{fmt(schedule.lateStart, 'dd MMM yyyy')}</span></div>
      <div className="rt-row"><span className="rt-label">Geç Bitiş</span><span className="rt-val">{fmt(schedule.lateFinish, 'dd MMM yyyy')}</span></div>
      <div className="rt-row"><span className="rt-label">Toplam Bolluk</span><span className="rt-val" style={schedule.totalFloatDays <= 0 ? { color: 'var(--status-overdue)', fontWeight: 700 } : null}>{schedule.totalFloatDays}g</span></div>
      <div className="rt-row"><span className="rt-label">Serbest Bolluk</span><span className="rt-val">{schedule.freeFloatDays}g</span></div>
      <div className="rt-row"><span className="rt-label">CPM Durumu</span><span className="rt-val" style={schedule.isCritical ? { color: 'var(--status-overdue)', fontWeight: 700 } : null}>{schedule.isCritical ? 'Kritik' : 'Kritik değil'}</span></div>
    </>
  );
}

export function GanttView() {
  const tasks = useTasks();
  const projects = useProjects();
  const people = usePeople();
  const schedule = usePortfolioSchedule();
  const { openTask: onOpenTask } = useTaskActions();
  const today_ = today();
  const [groupBy, setGroupBy] = useState2('proje');
  const [criticalOnly, setCriticalOnly] = useState2(false);
  const [zoom, setZoom] = useState2(28); // px per day
  const [hotTaskId, setHotTaskId] = useState2(null);
  const [cols, setCols] = useState2(GANTT_DEFAULT_COLS);
  const [colsOpen, setColsOpen] = useState2(false);
  const [globalSearch, setGlobalSearch] = useState2('');
  const [collapsed, setCollapsed] = useState2(() => new Set()); // group names that are collapsed
  const [colFilters, setColFilters] = useState2({
    task: '',
    proje: [],
    sorumlu: [],
    priority: [],
    status: [],
    progress: null,
    plannedHours: null,
    plannedStart: null,
    plannedFinish: null,
    targetFinish: null
  });
  const [sort, setSort] = useState2({ key: null, dir: 'asc' });
  const rightRef = useRef2(null);
  const leftRef = useRef2(null);

  const projectById = useMemo2(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const projectByName = useMemo2(() => new Map(projects.map((project) => [project.name, project])), [projects]);

  // Apply global search + per-column filters to tasks
  const filteredTasks = useMemo2(() => {
    let out = [...tasks];
    if (globalSearch) {
      const q = globalSearch.toLowerCase();
      out = out.filter(t =>
        t.task.toLowerCase().includes(q)
        || t.proje.toLowerCase().includes(q)
        || t.keyword.toLowerCase().includes(q)
        || (t.sorumlu || []).some(s => s.toLowerCase().includes(q))
        || (t.priority || '').toLowerCase().includes(q)
      );
    }
    if (colFilters.task) {
      const q = colFilters.task.toLowerCase();
      out = out.filter(t => t.task.toLowerCase().includes(q));
    }
    if (colFilters.proje.length) out = out.filter(t => colFilters.proje.includes(t.proje));
    if (colFilters.sorumlu.length) out = out.filter(t => (t.sorumlu || []).some(s => colFilters.sorumlu.includes(s)));
    if (colFilters.priority.length) out = out.filter(t => colFilters.priority.includes(t.priority || 'medium'));
    if (colFilters.status.length) {
      out = out.filter(t => {
        const overdue = t.status !== 'done' && t.targetFinish && diffDays(t.targetFinish, today_) < 0;
        if (colFilters.status.includes('overdue') && overdue) return true;
        return colFilters.status.includes(t.status || 'todo');
      });
    }
    ['plannedStart', 'plannedFinish', 'targetFinish'].forEach(k => {
      if (colFilters[k]) out = out.filter(t => dateMatchesFilter(t[k], colFilters[k]));
    });
    ['progress', 'plannedHours'].forEach(k => {
      if (colFilters[k]) out = out.filter(t => numericMatchesFilter(t[k] != null ? t[k] : 0, colFilters[k]));
    });
    if (criticalOnly) out = out.filter(t => schedule.tasks[t.id]?.isCritical);
    return out;
  }, [tasks, globalSearch, colFilters, today_, criticalOnly, schedule]);

  const hasFilters = !!(criticalOnly || globalSearch || colFilters.task || colFilters.proje.length || colFilters.sorumlu.length || colFilters.priority.length || colFilters.status.length || colFilters.progress || colFilters.plannedHours || colFilters.plannedStart || colFilters.plannedFinish || colFilters.targetFinish);
  const clearAllFilters = () => {
    setCriticalOnly(false);
    setGlobalSearch('');
    setColFilters({ task: '', proje: [], sorumlu: [], priority: [], status: [], progress: null, plannedHours: null, plannedStart: null, plannedFinish: null, targetFinish: null });
  };

  // Setters for per-column filters
  const setCF = (k, v) => setColFilters(f => ({ ...f, [k]: v }));
  const sortFor = (key) => (dir) => setSort({ key, dir });
  const sortDirFor = (key) => sort.key === key ? sort.dir : null;

  // Visible columns
  const visibleCols = useMemo2(() => GANTT_COL_DEFS.filter(c => cols[c.key]), [cols]);
  const totalLeftW = useMemo2(() => 220 + visibleCols.reduce((s, c) => s + c.width + 6, 0) + 40, [visibleCols]);
  // Grid template for left rows
  const gridTemplate = useMemo2(() => {
    return `minmax(180px, 1fr) ${visibleCols.map(c => `${c.width}px`).join(' ')}`;
  }, [visibleCols]);

  // Set CSS vars
  const wrapStyle = {
    '--gantt-left-w': `${totalLeftW}px`,
    '--gantt-left-cols': gridTemplate
  };

  // Stable task range calculation lives in the scheduling layer. Stored task dates remain the visible bar dates.
  const range = useMemo2(() => getTaskDateRange(tasks, { paddingDays: 3, fallbackStart: today_ }), [tasks]);
  const days = useMemo2(() => eachDay(range.start, range.end), [range]);
  const totalWidth = days.length * zoom;

  // Group tasks (using filtered set)
  const groups = useMemo2(() => {
    const map = {};
    filteredTasks.forEach(t => {
      const key = groupBy === 'proje' ? t.proje : (t.sorumlu[0] || 'Atanmamış');
      map[key] = map[key] || [];
      map[key].push(t);
    });
    Object.values(map).forEach(arr => {
      // Apply column sort if any, else default by start
      arr.sort((a, b) => {
        if (sort.key) {
          let va = a[sort.key], vb = b[sort.key];
          if (sort.key === 'sorumlu') { va = (a.sorumlu[0] || ''); vb = (b.sorumlu[0] || ''); }
          if (sort.key === 'priority') { va = resolvePriority(a.priority).order; vb = resolvePriority(b.priority).order; }
          if (va == null) va = '';
          if (vb == null) vb = '';
          if (va < vb) return sort.dir === 'asc' ? -1 : 1;
          if (va > vb) return sort.dir === 'asc' ? 1 : -1;
          return 0;
        }
        return parseDate(a.plannedStart) - parseDate(b.plannedStart);
      });
    });
    return Object.entries(map).sort((a, b) => a[0].localeCompare(b[0], 'tr'));
  }, [filteredTasks, groupBy, sort]);

  const xForDate = (d) => diffDays(d, range.start) * zoom;

  // Schedule rollups are pure and independently testable.
  const groupSummaries = useMemo2(() => getGroupScheduleSummaries(groups), [groups]);

  // Build flat row list (respect collapsed groups)
  const rows = [];
  groups.forEach(([groupName, items]) => {
    const isCollapsed = collapsed.has(groupName);
    const project = groupBy === 'proje' ? projectByName.get(groupName) : null;
    rows.push({
      type: 'group',
      name: groupName,
      summary: groupSummaries[groupName],
      projectSchedule: project ? schedule.projects[project.id] || null : null,
      collapsed: isCollapsed,
      itemCount: items.length
    });
    if (!isCollapsed) items.forEach(t => rows.push({ type: 'task', task: t, groupName }));
  });

  const toggleCollapse = (name) => {
    setCollapsed(s => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name); else n.add(name);
      return n;
    });
  };

  const ROW_H = 38;
  const GROUP_H = 32;
  const HEAD_H = 56;

  // Compute Y position of each row (group headers smaller)
  const rowTops = useMemo2(() => {
    const tops = [];
    let y = 0;
    rows.forEach(r => {
      tops.push(y);
      y += r.type === 'group' ? GROUP_H : ROW_H;
    });
    return { tops, total: y };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // Today X position (center of today's column)
  const todayX = xForDate(today_) + zoom / 2;

  // Auto-scroll to today on mount and when zoom changes
  useEffect2(() => {
    if (!rightRef.current) return;
    const el = rightRef.current;
    const target = Math.max(0, todayX - el.clientWidth / 3);
    el.scrollLeft = target;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Sync vertical scroll between left & right ───
  useEffect2(() => {
    const l = leftRef.current;
    const r = rightRef.current;
    if (!l || !r) return;
    let syncing = false;
    const onL = () => {
      if (syncing) return;
      syncing = true; r.scrollTop = l.scrollTop; syncing = false;
    };
    const onR = () => {
      if (syncing) return;
      syncing = true; l.scrollTop = r.scrollTop; syncing = false;
    };
    l.addEventListener('scroll', onL);
    r.addEventListener('scroll', onR);
    return () => {
      l.removeEventListener('scroll', onL);
      r.removeEventListener('scroll', onR);
    };
  }, []);

  // ── Drag-to-pan (horizontal only) ──────────────
  useEffect2(() => {
    const el = rightRef.current;
    if (!el) return;
    let dragging = false;
    let startX = 0;
    let startScroll = 0;

    const down = (e) => {
      if (e.target.closest('.gantt-bar') || e.target.closest('.gantt-milestone')) return;
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startScroll = el.scrollLeft;
      el.classList.add('is-panning');
    };
    const move = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      el.scrollLeft = startScroll - dx;
    };
    const up = () => {
      dragging = false;
      el.classList.remove('is-panning');
    };
    el.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      el.removeEventListener('mousedown', down);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  // ── Dep arrows: handle FS/SS/FF/SF with proper routing ──
  const depArrows = useMemo2(() => {
    const arrows = [];
    const taskRowIdx = {};
    rows.forEach((r, i) => { if (r.type === 'task') taskRowIdx[r.task.id] = i; });

    rows.forEach((r, i) => {
      if (r.type !== 'task' || !r.task.deps) return;
      r.task.deps.forEach(dep => {
        const dId = depId(dep);
        const type = relTypeOf(dep);
        const j = taskRowIdx[dId];
        if (j === undefined) return;
        const depTask = rows[j].task;
        if (!hasPlannedRange(depTask) || !hasPlannedRange(r.task)) return;

        const fromY = rowTops.tops[j] + 19;
        const toY = rowTops.tops[i] + 19;

        const predStart = xForDate(parseDate(depTask.plannedStart));
        const predEnd = xForDate(parseDate(depTask.plannedFinish)) + zoom;
        const succStart = xForDate(parseDate(r.task.plannedStart));
        const succEnd = xForDate(parseDate(r.task.plannedFinish)) + zoom;

        let fromX, toX, fromSide, toSide;
        if (type === 'FS') { fromX = predEnd; toX = succStart; fromSide = 'R'; toSide = 'L'; }
        else if (type === 'SS') { fromX = predStart; toX = succStart; fromSide = 'L'; toSide = 'L'; }
        else if (type === 'FF') { fromX = predEnd; toX = succEnd; fromSide = 'R'; toSide = 'R'; }
        else { fromX = predStart; toX = succEnd; fromSide = 'L'; toSide = 'R'; }

        const projectSchedule = schedule.projects[r.task.projectId];
        const critical = !!projectSchedule?.criticalDependencyKeys?.includes(`${dId}::${r.task.id}`);
        arrows.push({
          id: `${dId}-${r.task.id}-${type}`,
          type, fromX, fromY, toX, toY, fromSide, toSide,
          fromTaskId: dId, toTaskId: r.task.id,
          critical,
          hot: hotTaskId === dId || hotTaskId === r.task.id
        });
      });
    });
    return arrows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, range, zoom, hotTaskId, rowTops, schedule]);

  function buildArrowPath(a) {
    const { fromX, fromY, toX, toY, fromSide, toSide } = a;
    const STUB = 10;
    if (fromSide === 'R' && toSide === 'L') {
      if (toX <= fromX) {
        const midY = fromY + (toY - fromY) / 2;
        return `M ${fromX} ${fromY} h ${STUB} V ${midY} H ${toX - STUB} V ${toY} H ${toX}`;
      }
      return `M ${fromX} ${fromY} h ${STUB} V ${toY} H ${toX}`;
    }
    if (fromSide === 'L' && toSide === 'L') {
      const leftX = Math.min(fromX, toX) - STUB;
      return `M ${fromX} ${fromY} H ${leftX} V ${toY} H ${toX}`;
    }
    if (fromSide === 'R' && toSide === 'R') {
      const rightX = Math.max(fromX, toX) + STUB;
      return `M ${fromX} ${fromY} H ${rightX} V ${toY} H ${toX}`;
    }
    const midY = fromY + (toY - fromY) / 2;
    return `M ${fromX} ${fromY} H ${fromX - STUB} V ${midY} H ${toX + STUB} V ${toY} H ${toX}`;
  }

  const holidayRanges = useMemo2(() => {
    const list = [];
    days.forEach((d, i) => {
      const h = holidayFor(d);
      if (h) list.push({ x: i * zoom, w: zoom, h, isToday: isSameDay(d, today_) });
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, zoom]);

  const toggleCol = (k) => setCols(c => ({ ...c, [k]: !c[k] }));

  return (
    <div className="col" style={{ gap: 12 }}>
      {/* Controls — header row with global search */}
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div className="topbar-search" style={{ flex: 1, minWidth: 240, maxWidth: 380 }}>
          <Icons.Search size={14} />
          <input
            placeholder="Tüm Gantt'ta ara: görev, proje, sorumlu, etiket..."
            value={globalSearch}
            onChange={(e) => setGlobalSearch(e.target.value)}
          />
          {globalSearch && <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => setGlobalSearch('')}><Icons.Close size={12} /></button>}
        </div>
        <div className="seg">
          <button className={groupBy === 'proje' ? 'active' : ''} onClick={() => setGroupBy('proje')}>Projeye göre</button>
          <button className={groupBy === 'sorumlu' ? 'active' : ''} onClick={() => setGroupBy('sorumlu')}>Sorumluya göre</button>
        </div>
        <div className="seg">
          <button className={!criticalOnly ? 'active' : ''} onClick={() => setCriticalOnly(false)}>Tümü</button>
          <button className={criticalOnly ? 'active' : ''} onClick={() => setCriticalOnly(true)}>Kritik</button>
        </div>
        <span className="muted tabular" style={{ fontSize: 12 }}>{filteredTasks.length} / {tasks.length} görev</span>
        {hasFilters && (
          <button className="btn ghost sm" onClick={clearAllFilters}>
            <Icons.Close size={12} /> Filtreleri temizle
          </button>
        )}
        <div className="row" style={{ marginLeft: 'auto', gap: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>Zoom</span>
          <div className="seg">
            <button className={zoom === 22 ? 'active' : ''} onClick={() => setZoom(22)}>S</button>
            <button className={zoom === 28 ? 'active' : ''} onClick={() => setZoom(28)}>M</button>
            <button className={zoom === 40 ? 'active' : ''} onClick={() => setZoom(40)}>L</button>
          </div>
          <InfoButton title="Gantt görünümü" icon={<Icons.Gantt size={12} />} corner accent="var(--c-purple)">
            <p>Görev çubukları kayıtlı başlangıç ve bitiş tarihlerine göre konumlanır. CPM sonuçları kritik görevleri ve ilişkileri vurgular; hesaplanan tarihler ayrı sütun ve bilgi alanlarında gösterilir.</p>
            <div className="rt-sep" />
            <p><strong>Çubuk tipleri:</strong></p>
            <div className="rt-row"><span style={{ width: 16, height: 6, background: 'var(--accent)', borderRadius: 2 }} /><span>Normal görev</span></div>
            <div className="rt-row"><span style={{ width: 16, height: 6, background: 'linear-gradient(180deg, var(--text) 0%, color-mix(in oklab, var(--text) 80%, black) 100%)', borderRadius: 1 }} /><span>Özet (rollup)</span></div>
            <div className="rt-row"><span style={{ width: 12, height: 12, background: 'var(--status-overdue)', transform: 'rotate(45deg)' }} /><span>Kilometre taşı</span></div>
            <div className="rt-row"><span style={{ width: 16, height: 6, border: '2px solid var(--status-overdue)', borderRadius: 2 }} /><span>Kritik CPM görevi</span></div>
            <div className="rt-sep" />
            <div className="rt-row"><Icons.Filter size={12} className="rt-ico" /><span>Sütun başlığına tıkla: filtre & sıralama</span></div>
            <div className="rt-row"><Icons.ChevronDown size={12} className="rt-ico" /><span>Grup başlığına tıkla: daralt/genişlet</span></div>
            <div className="rt-row"><Icons.Grip size={12} className="rt-ico" /><span>Boş alana basılı tut: yatay kaydır</span></div>
            <div className="rt-row"><Icons.Link size={12} className="rt-ico" /><span>FS, SS, FF, SF ilişki tipleri</span></div>
          </InfoButton>
        </div>
      </div>

      {schedule.warnings.length > 0 && (
        <div
          style={{
            padding: '9px 12px',
            borderRadius: 8,
            border: '1px solid color-mix(in oklab, var(--status-overdue) 38%, var(--border))',
            background: 'color-mix(in oklab, var(--status-overdue) 7%, var(--bg-elev))',
            fontSize: 11.5
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>CPM zamanlama uyarıları</div>
          {schedule.warnings.slice(0, 3).map((warning, index) => (
            <div key={`${warning.projectId || warning.taskId || 'schedule'}-${warning.code}-${index}`} className="muted">
              {warningText(warning, projectById)}
            </div>
          ))}
          {schedule.warnings.length > 3 && <div className="muted">+{schedule.warnings.length - 3} ek uyarı</div>}
        </div>
      )}

      {/* Legend */}
      <div className="row" style={{ gap: 14, fontSize: 11.5, color: 'var(--text-dim)', flexWrap: 'wrap' }}>
        <span className="row" style={{ gap: 6 }}>
          <span style={{ width: 12, height: 10, borderRadius: 2, background: 'color-mix(in oklab, var(--text-dim) 8%, transparent)' }} /> Hafta sonu
        </span>
        <span className="row" style={{ gap: 6 }}>
          <span style={{ width: 12, height: 10, borderRadius: 2, background: 'repeating-linear-gradient(135deg, color-mix(in oklab, var(--status-overdue) 25%, transparent) 0 3px, transparent 3px 6px)' }} /> Resmi tatil
        </span>
        <span className="row" style={{ gap: 6 }}>
          <span style={{ width: 1, height: 12, background: 'var(--accent)' }} /> Bugün
        </span>
        <span className="row" style={{ gap: 6 }}>
          <span style={{ width: 10, height: 6, background: 'linear-gradient(180deg, var(--text) 0%, color-mix(in oklab, var(--text) 80%, black) 100%)', borderRadius: 1 }} /> Özet (rollup)
        </span>
        <span className="row" style={{ gap: 6 }}>
          <span style={{ width: 10, height: 10, background: 'var(--status-overdue)', transform: 'rotate(45deg)' }} /> Kilometre taşı
        </span>
        <span className="row" style={{ gap: 6 }}>
          <span style={{ width: 12, height: 7, border: '2px solid var(--status-overdue)', borderRadius: 2 }} /> Kritik görev
        </span>
        <span className="row" style={{ gap: 6 }}>
          <span style={{ width: 16, height: 2, background: 'var(--status-overdue)' }} /> Kritik ilişki
        </span>
        <span className="row" style={{ gap: 6 }}>
          <Icons.Link size={11} /> FS / SS / FF / SF
        </span>
      </div>

      <div className="gantt-wrap" style={wrapStyle}>
        {/* Left rail */}
        <div className="gantt-left" ref={leftRef}>
          <div className="gantt-left-head">
            <div className="row" style={{ gap: 6 }}>
              <GanttColHead
                label="Görev"
                filter={colFilters.task}
                onFilter={(v) => setCF('task', v)}
                onSort={sortFor('task')}
                sortKey={sortDirFor('task')}
                filterType="text"
              />
              <span style={{ flex: 1 }} />
            </div>
            {visibleCols.map(c => {
              // Determine filter type per column
              let filterType = null;
              let filterOptions = null;
              let filterValue = null;
              let onFilter = null;
              let onSort = sortFor(c.key === 'start' ? 'plannedStart' : c.key === 'end' ? 'plannedFinish' : c.key === 'hedef' ? 'targetFinish' : c.key);
              let sortKey = sortDirFor(c.key === 'start' ? 'plannedStart' : c.key === 'end' ? 'plannedFinish' : c.key === 'hedef' ? 'targetFinish' : c.key);
              let numMin = null, numMax = null, numUnit = '';
              if (c.key === 'start') { filterType = 'date'; filterValue = colFilters.plannedStart; onFilter = (v) => setCF('plannedStart', v); }
              else if (c.key === 'end') { filterType = 'date'; filterValue = colFilters.plannedFinish; onFilter = (v) => setCF('plannedFinish', v); }
              else if (c.key === 'hedef') { filterType = 'date'; filterValue = colFilters.targetFinish; onFilter = (v) => setCF('targetFinish', v); }
              else if (c.key === 'progress') { filterType = 'number'; filterValue = colFilters.progress; onFilter = (v) => setCF('progress', v); numMin = 0; numMax = 100; numUnit = '%'; }
              else if (c.key === 'hours') { filterType = 'number'; filterValue = colFilters.plannedHours; onFilter = (v) => setCF('plannedHours', v); numMin = 0; numMax = 200; numUnit = ' sa'; }
              else if (c.key === 'status') {
                filterType = 'multi';
                filterValue = colFilters.status;
                onFilter = (v) => setCF('status', v);
                filterOptions = [
                  { value: 'todo', label: 'Yapılacak', icon: <StatusIcon id="todo" size={11} /> },
                  { value: 'in_progress', label: 'Devam ediyor', icon: <StatusIcon id="in_progress" size={11} /> },
                  { value: 'done', label: 'Tamamlandı', icon: <StatusIcon id="done" size={11} /> },
                  { value: 'overdue', label: 'Geciken', icon: <StatusIcon id="overdue" size={11} /> }
                ];
              }
              else if (c.key === 'sorumlu') {
                filterType = 'multi';
                filterValue = colFilters.sorumlu;
                onFilter = (v) => setCF('sorumlu', v);
                // Canlı arama sicil, unvan ve birim üzerinde de çalışır.
                filterOptions = people.slice().sort((a, b) => a.name.localeCompare(b.name, 'tr'))
                  .map(p => ({
                    value: p.name,
                    label: p.employeeNo ? `${p.employeeNo} · ${p.name}` : p.name,
                    keywords: [p.name, p.employeeNo, p.username, p.role, p.team, p.organization?.department, p.organization?.unit],
                    icon: <Avatar name={p.name} person={p} size="sm" />
                  }));
              }
              else if (c.key === 'priority') {
                filterType = 'multi';
                filterValue = colFilters.priority;
                onFilter = (v) => setCF('priority', v);
                filterOptions = Object.values(PRIORITIES).map(p => ({ value: p.id, label: p.label, icon: <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} /> }));
              }
              return (
                <div key={c.key} style={{ textAlign: c.align === 'right' ? 'right' : 'left' }}>
                  <GanttColHead
                    label={c.label}
                    filter={filterValue}
                    onFilter={onFilter}
                    onSort={onSort}
                    sortKey={sortKey}
                    filterType={filterType}
                    filterOptions={filterOptions}
                    numericMin={numMin}
                    numericMax={numMax}
                    numericUnit={numUnit}
                    align={c.align}
                  />
                </div>
              );
            })}
            <div style={{ position: 'relative' }}>
              <button className="cols-btn" onClick={(e) => { e.stopPropagation(); setColsOpen(o => !o); }} title="Sütunları yönet">
                <Icons.Columns size={13} />
              </button>
              {colsOpen && (
                <ColsPopover cols={cols} onToggle={toggleCol} onClose={() => setColsOpen(false)} />
              )}
            </div>
          </div>
          {rows.map((r, i) => {
            if (r.type === 'group') {
              const s = r.summary;
              const projectSchedule = r.projectSchedule;
              return (
                <div
                  key={`g-${r.name}-${i}`}
                  className={`gantt-group-header${r.collapsed ? ' collapsed' : ''}`}
                  onClick={() => toggleCollapse(r.name)}
                  style={{ cursor: 'pointer' }}
                  title={r.collapsed ? 'Genişlet' : 'Daralt'}
                >
                  <Icons.ChevronDown size={11} className="gh-chevron" style={{ transform: r.collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.18s', flexShrink: 0 }} />
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: groupBy === 'proje' ? projectColorVar(r.name) : personColorVar(r.name) }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  {s && (
                    <span className="muted tabular" style={{ fontSize: 10, fontWeight: 600 }}>
                      {s.done}/{s.items} · {s.progress}%
                      {projectSchedule?.status === 'valid' && ` · ${projectSchedule.criticalTaskIds.length} kritik · CPM ${fmt(projectSchedule.projectFinish, 'dd MMM')}`}
                      {projectSchedule?.status === 'invalid' && ' · CPM uyarısı'}
                    </span>
                  )}
                </div>
              );
            }
            const t = r.task;
            const taskSchedule = schedule.tasks[t.id];
            const isCritical = !!taskSchedule?.isCritical;
            return (
              <div
                key={t.id}
                className={`gantt-task-row${hotTaskId === t.id ? ' hot' : ''}`}
                onClick={() => onOpenTask(t)}
                onMouseEnter={() => setHotTaskId(t.id)}
                onMouseLeave={() => setHotTaskId(null)}
                style={{ cursor: 'pointer' }}
              >
                <div className="tr-name">
                  {t.milestone
                    ? <Icons.Diamond size={11} style={{ color: isCritical ? 'var(--status-overdue)' : projectColorVar(t.proje), flexShrink: 0 }} />
                    : <span style={{ width: 3, height: 18, borderRadius: 2, background: projectColorVar(t.proje), flexShrink: 0 }} />
                  }
                  <span>{t.task}</span>
                  {isCritical && <span title="Kritik CPM görevi" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--status-overdue)', flexShrink: 0 }} />}
                </div>
                {visibleCols.map(c => (
                  <div key={c.key} className="tr-date" style={{ textAlign: c.align === 'right' ? 'right' : 'left' }}>
                    {c.render(t, today_, taskSchedule)}
                  </div>
                ))}
                <div />
              </div>
            );
          })}
        </div>

        {/* Right canvas */}
        <div className="gantt-right" ref={rightRef}>
          <div className="gantt-right-inner" style={{ width: totalWidth, position: 'relative', height: HEAD_H + rowTops.total }}>
            {/* Day strip */}
            <div className="gantt-day-strip" style={{ gridTemplateColumns: `repeat(${days.length}, ${zoom}px)` }}>
              {days.map((d, i) => {
                const isToday_ = isSameDay(d, today_);
                const w = isWeekend(d);
                const hol = holidayFor(d);
                const showMonth = i === 0 || d.getDate() === 1;
                return (
                  <div key={i} className={`gantt-day-cell${w ? ' weekend' : ''}${hol ? ' holiday' : ''}${isToday_ ? ' today' : ''}`}>
                    {showMonth && <div className="dmon">{TR_MONTHS_LONG[d.getMonth()]} {d.getFullYear()}</div>}
                    <div className="ddow">{TR_DAYS[(d.getDay() + 6) % 7][0]}</div>
                    <div className="dnum">{d.getDate()}</div>
                  </div>
                );
              })}
            </div>

            {/* Weekend stripes */}
            {days.map((d, i) => {
              if (!isWeekend(d) || holidayFor(d)) return null;
              return <div key={`w-${i}`} className="gantt-weekend-stripe" style={{ left: i * zoom, width: zoom }} />;
            })}

            {/* Holiday stripes */}
            {holidayRanges.map((h, i) => (
              <Tooltip
                key={`h-${i}`}
                title={h.h.name}
                icon={<Icons.Gift size={12} />}
                content={<div className="rt-row"><span className="rt-label">Resmi tatil</span><span className="rt-val">{h.h.short}</span></div>}
              >
                <span
                  className="gantt-holiday-stripe"
                  style={{ position: 'absolute', left: h.x, width: h.w }}
                />
              </Tooltip>
            ))}

            {/* Rows: backgrounds + bars/summary/milestones */}
            {rows.map((r, i) => {
              const top = HEAD_H + rowTops.tops[i];
              if (r.type === 'group') {
                const s = r.summary;
                const projectSchedule = r.projectSchedule;
                return (
                  <React.Fragment key={`gr-${i}`}>
                    <div
                      style={{
                        position: 'absolute',
                        top, left: 0, right: 0,
                        width: '100%', height: GROUP_H, boxSizing: 'border-box',
                        background: 'color-mix(in oklab, var(--text) 4%, var(--bg-elev))',
                        borderBottom: '1px solid var(--border-strong)'
                      }}
                    />
                    {s && (
                      <Tooltip
                        title={`${r.name} · Özet`}
                        icon={<Icons.Layers size={12} />}
                        content={
                          <>
                            <div className="rt-row"><span className="rt-label">Başlangıç</span><span className="rt-val">{fmt(fmtISO(s.start), 'dd MMM yyyy')}</span></div>
                            <div className="rt-row"><span className="rt-label">Bitiş</span><span className="rt-val">{fmt(fmtISO(s.end), 'dd MMM yyyy')}</span></div>
                            <div className="rt-row"><span className="rt-label">Süre</span><span className="rt-val">{diffDays(s.end, s.start) + 1} gün</span></div>
                            <div className="rt-sep" />
                            <div className="rt-row"><span className="rt-label">Görev</span><span className="rt-val">{s.items}</span></div>
                            <div className="rt-row"><span className="rt-label">Tamamlanan</span><span className="rt-val" style={{ color: 'var(--status-done)' }}>{s.done}</span></div>
                            <div className="rt-row"><span className="rt-label">İlerleme</span><span className="rt-val">{s.progress}%</span></div>
                            {projectSchedule?.status === 'valid' && (
                              <>
                                <div className="rt-sep" />
                                <div className="rt-row"><span className="rt-label">CPM Bitiş</span><span className="rt-val">{fmt(projectSchedule.projectFinish, 'dd MMM yyyy')}</span></div>
                                <div className="rt-row"><span className="rt-label">Kritik Görev</span><span className="rt-val" style={{ color: 'var(--status-overdue)', fontWeight: 700 }}>{projectSchedule.criticalTaskIds.length}</span></div>
                              </>
                            )}
                            {projectSchedule?.status === 'invalid' && (
                              <>
                                <div className="rt-sep" />
                                <div className="rt-row"><span className="rt-label">CPM</span><span className="rt-val" style={{ color: 'var(--status-overdue)' }}>{projectSchedule.error.code}</span></div>
                              </>
                            )}
                          </>
                        }
                      >
                        <div
                          className="gantt-summary-bar"
                          style={{
                            top: top + 9,
                            left: xForDate(s.start),
                            width: Math.max(8, (diffDays(s.end, s.start) + 1) * zoom),
                            pointerEvents: 'auto'
                          }}
                        >
                          <div className="summary-progress" style={{ width: `${Math.min(100, s.progress)}%` }} />
                        </div>
                      </Tooltip>
                    )}
                  </React.Fragment>
                );
              }
              const t = r.task;
              const taskSchedule = schedule.tasks[t.id];
              const isCritical = !!taskSchedule?.isCritical;
              if (!hasPlannedRange(t)) {
                return (
                  <React.Fragment key={t.id}>
                    <div style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_H, borderBottom: '1px solid var(--border)' }} />
                  </React.Fragment>
                );
              }
              if (t.milestone) {
                const x = xForDate(parseDate(t.plannedStart)) + zoom / 2 - 8;
                const status = getStatus(t);
                return (
                  <React.Fragment key={t.id}>
                    <div style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_H, borderBottom: '1px solid var(--border)' }} />
                    <Tooltip
                      title={`${t.task} · Kilometre taşı`}
                      icon={<Icons.Diamond size={11} />}
                      content={
                        <>
                          <div className="rt-row"><span className="rt-label">Proje</span><span className="rt-val">{t.proje}</span></div>
                          <div className="rt-row"><span className="rt-label">Tarih</span><span className="rt-val">{t.targetFinish ? fmt(t.targetFinish, 'dd MMM yyyy') : '—'}</span></div>
                          <div className="rt-row"><span className="rt-label">Durum</span><span className="rt-val">{status.label}</span></div>
                          <div className="rt-row"><span className="rt-label">Sorumlu</span><span className="rt-val">{t.sorumlu.join(', ')}</span></div>
                          <CpmTooltipRows schedule={taskSchedule} />
                        </>
                      }
                    >
                      <div
                        className="gantt-milestone"
                        style={{ '--milestone-color': isCritical ? 'var(--status-overdue)' : projectColorVar(t.proje), top: top + 11, left: x }}
                        onClick={() => onOpenTask(t)}
                        onMouseEnter={() => setHotTaskId(t.id)}
                        onMouseLeave={() => setHotTaskId(null)}
                      />
                    </Tooltip>
                  </React.Fragment>
                );
              }
              const x = xForDate(parseDate(t.plannedStart));
              const w = (diffDays(t.plannedFinish, t.plannedStart) + 1) * zoom;
              const color = projectColorVar(t.proje);
              const done = t.status === 'done';
              const pct = t.progress != null ? t.progress : (done ? 100 : 0);
              const overdue = t.status !== 'done' && t.targetFinish && diffDays(t.targetFinish, today_) < 0;
              const status = getStatus(t);
              return (
                <React.Fragment key={t.id}>
                  <div style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_H, borderBottom: '1px solid var(--border)' }} />
                  <Tooltip
                    title={t.task}
                    icon={<span style={{ width: 12, height: 8, borderRadius: 2, background: color, display: 'inline-block' }} />}
                    content={
                      <>
                        <div className="rt-row"><span className="rt-label">Proje</span><span className="rt-val">{t.proje}</span></div>
                        <div className="rt-row"><span className="rt-label">Başlangıç</span><span className="rt-val">{fmt(t.plannedStart, 'dd MMM yyyy')}</span></div>
                        <div className="rt-row"><span className="rt-label">Bitiş</span><span className="rt-val">{fmt(t.plannedFinish, 'dd MMM yyyy')}</span></div>
                        <div className="rt-row"><span className="rt-label">Hedef</span><span className="rt-val" style={overdue ? { color: 'var(--status-overdue)' } : null}>{t.targetFinish ? fmt(t.targetFinish, 'dd MMM yyyy') : '—'}</span></div>
                        <div className="rt-sep" />
                        <div className="rt-row"><span className="rt-label">Durum</span><span className="rt-val">{status.label}</span></div>
                        <div className="rt-row"><span className="rt-label">İlerleme</span><span className="rt-val">{pct}%</span></div>
                        {t.plannedHours != null && (
                          <div className="rt-row"><span className="rt-label">Saat</span><span className="rt-val">{t.actualHours || 0}/{t.plannedHours} sa</span></div>
                        )}
                        <div className="rt-row"><span className="rt-label">Sorumlu</span><span className="rt-val">{t.sorumlu.join(', ')}</span></div>
                        <CpmTooltipRows schedule={taskSchedule} />
                      </>
                    }
                  >
                    <div
                      className={`gantt-bar${done ? ' done' : ''}`}
                      style={{
                        '--bar-color': color,
                        position: 'absolute',
                        left: x + 2,
                        width: Math.max(20, w - 4),
                        top: top + 8,
                        boxShadow: isCritical ? '0 0 0 2px var(--status-overdue)' : undefined
                      }}
                      onClick={() => onOpenTask(t)}
                      onMouseEnter={() => setHotTaskId(t.id)}
                      onMouseLeave={() => setHotTaskId(null)}
                    >
                      {pct > 0 && pct < 100 && (
                        <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(to right, color-mix(in oklab, ${color} 100%, black 18%) ${pct}%, transparent ${pct}%)`, borderRadius: 'inherit' }} />
                      )}
                      <span style={{ position: 'relative', zIndex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.keyword}</span>
                    </div>
                  </Tooltip>
                </React.Fragment>
              );
            })}

            {/* Dependency arrows */}
            <svg
              style={{ position: 'absolute', top: HEAD_H, left: 0, width: totalWidth, height: rowTops.total, pointerEvents: 'none', zIndex: 4 }}
              width={totalWidth} height={rowTops.total}
            >
              <defs>
                <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L6,3 z" fill="var(--text-muted)" />
                </marker>
                <marker id="arrowhead-hot" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L6,3 z" fill="var(--accent)" />
                </marker>
                <marker id="arrowhead-critical" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L6,3 z" fill="var(--status-overdue)" />
                </marker>
              </defs>
              {depArrows.map((a) => {
                const d = buildArrowPath(a);
                const midX = (a.fromX + a.toX) / 2;
                const midY = (a.fromY + a.toY) / 2;
                const markerId = a.hot ? 'arrowhead-hot' : a.critical ? 'arrowhead-critical' : 'arrowhead';
                return (
                  <g key={a.id} className={`dep-arrow${a.hot ? ' hot' : ''}`}>
                    <path
                      d={d}
                      stroke={a.hot ? 'var(--accent)' : a.critical ? 'var(--status-overdue)' : undefined}
                      strokeWidth={a.critical ? 1.8 : undefined}
                      strokeDasharray={a.hot || a.critical ? '0' : '3 3'}
                      markerEnd={`url(#${markerId})`}
                    />
                    <rect className="lbl-bg" x={midX - 11} y={midY - 7} width="22" height="13" rx="3" />
                    <text className="lbl" x={midX} y={midY + 3} textAnchor="middle" style={a.critical && !a.hot ? { fill: 'var(--status-overdue)', fontWeight: 700 } : undefined}>{a.type}</text>
                  </g>
                );
              })}
            </svg>

            {/* Today marker */}
            {todayX >= 0 && todayX <= totalWidth && (
              <div className="gantt-today-marker" style={{ left: todayX, height: HEAD_H + rowTops.total }} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function GanttColHead({ label, filter, onFilter, onSort, sortKey, filterType, filterOptions, numericMin, numericMax, numericUnit, align = 'left' }) {
  const [open, setOpen] = useState2(false);
  const anchorRef = useRef2(null);
  const active = filterType === 'text' ? !!filter : Array.isArray(filter) ? filter.length > 0 : !!filter;
  if (!filterType) {
    return <span style={{ textAlign: align }}>{label}</span>;
  }
  return (
    <>
      <button
        ref={anchorRef}
        className={`col-th-btn${active ? ' has-filter' : ''}${sortKey ? ' is-sorted' : ''}`}
        onClick={() => setOpen(o => !o)}
        style={{ width: '100%', justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}
      >
        <span>{label}</span>
        {sortKey === 'asc' && <Icons.ChevronUp size={11} />}
        {sortKey === 'desc' && <Icons.ChevronDown size={11} />}
        {active && <span className="col-th-dot" />}
        <Icons.Filter size={10} className="col-th-filter-ico" />
      </button>
      {open && (
        <ColumnFilter
          label={label}
          anchor={anchorRef.current}
          type={filterType}
          options={filterOptions || []}
          value={filter}
          onChange={onFilter}
          onClose={() => setOpen(false)}
          sort={sortKey}
          onSort={onSort}
          numericMin={numericMin}
          numericMax={numericMax}
          numericUnit={numericUnit}
        />
      )}
    </>
  );
}

function ColsPopover({ cols, onToggle, onClose }) {
  const ref = useRef2(null);
  useEffect2(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} className="gantt-cols-pop" style={{ right: 0, top: 28 }}>
      <div className="gp-head">Sütunlar</div>
      {GANTT_COL_DEFS.map(c => (
        <label key={c.key}>
          <input type="checkbox" checked={!!cols[c.key]} onChange={() => onToggle(c.key)} />
          <span>{c.label}</span>
        </label>
      ))}
    </div>
  );
}
