'use client';
/* ============================================================
   Views part 2: Takvim, Gantt, Kanban, Rapor
   ============================================================ */
import React, { useState as useState2, useMemo as useMemo2, useEffect as useEffect2, useRef as useRef2 } from 'react';
import { Icons } from './icons';
import {
  PEOPLE, PRIORITIES, HOLIDAYS, TR_MONTHS_LONG, TR_DAYS, COLOR_MAP,
  today, addDays, diffDays, parseDate, fmtISO, fmt,
  startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDay,
  isSameDay, isWeekend, holidayFor,
  projectColorVar, personColorVar, getStatus, depId, relTypeOf,
} from '../lib/data';
import { appZoom } from '../lib/zoom';
import { Avatar, AvatarStack, Kw, StatusPill, StatusIcon, HeroHeader, AreaChart } from './ui';
import { Tooltip, InfoButton, CardHead, AnimatedNumber, ColumnFilter, dateMatchesFilter, numericMatchesFilter } from './ui-extras';

/* ── Takvim (Calendar) ─────────────────────────────────── */
export function TakvimView({ tasks, onOpenTask, t, setTweak }) {
  const today_ = today();
  const calLarge = !!(t && t.calLarge);
  const [month, setMonth] = useState2(new Date(today_.getFullYear(), today_.getMonth(), 1));
  const [dayOpen, setDayOpen] = useState2(null); // ISO date string
  const [jumpOpen, setJumpOpen] = useState2(false);
  const jumpAnchorRef = useRef2(null);

  const days = useMemo2(() => {
    const start = startOfWeek(startOfMonth(month));
    const end = endOfWeek(endOfMonth(month));
    return eachDay(start, end);
  }, [month]);

  const eventsByDay = useMemo2(() => {
    const map = {};
    tasks.forEach(t => {
      const start = parseDate(t.baslangicTarihi);
      const end = parseDate(t.bitisTarihi);
      eachDay(start, end).forEach(d => {
        const k = fmtISO(d);
        map[k] = map[k] || [];
        map[k].push(t);
      });
    });
    return map;
  }, [tasks]);

  const goPrev = () => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1));
  const goNext = () => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1));
  const goToday = () => setMonth(new Date(today_.getFullYear(), today_.getMonth(), 1));

  // Arrow-key month navigation
  useEffect2(() => {
    const onKey = (e) => {
      if (dayOpen) return; // when modal open, esc handled elsewhere
      if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
      if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, dayOpen]);

  return (
    <div className="col" style={{ gap: 16, position: 'relative' }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div className="row" style={{ gap: 8 }}>
          <button className="icon-btn" onClick={goPrev} title="Önceki ay (←)"><Icons.ChevronLeft size={16} /></button>
          <button className="icon-btn" onClick={goNext} title="Sonraki ay (→)"><Icons.ChevronRight size={16} /></button>
          <div className="cal-month-picker">
            <select
              className="cal-mp-select"
              value={month.getMonth()}
              onChange={(e) => setMonth(new Date(month.getFullYear(), parseInt(e.target.value), 1))}
              aria-label="Ay"
            >
              {TR_MONTHS_LONG.map((m, i) => <option key={i} value={i}>{m}</option>)}
            </select>
            <select
              className="cal-mp-select"
              value={month.getFullYear()}
              onChange={(e) => setMonth(new Date(parseInt(e.target.value), month.getMonth(), 1))}
              aria-label="Yıl"
            >
              {Array.from({ length: 11 }, (_, i) => today_.getFullYear() - 5 + i).map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <button ref={jumpAnchorRef} className="btn sm" onClick={() => setJumpOpen(o => !o)} title="Tarihe git">
            <Icons.Calendar size={13} /> Tarihe git
          </button>
          {jumpOpen && (
            <DateJumpPopover anchor={jumpAnchorRef.current} onClose={() => setJumpOpen(false)} onJump={(d) => { setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); setJumpOpen(false); }} />
          )}
        </div>
        <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
          <div className="seg" title="Gün kutusu boyutu">
            <button className={!calLarge ? 'active' : ''} onClick={() => setTweak && setTweak('calLarge', false)}>Normal</button>
            <button className={calLarge ? 'active' : ''} onClick={() => setTweak && setTweak('calLarge', true)}>Büyük</button>
          </div>
          <span className="muted tabular" style={{ fontSize: 12.5 }}>
            <Icons.Gift size={11} style={{ verticalAlign: 'middle', marginRight: 4, color: 'var(--status-overdue)' }} />
            {HOLIDAYS.filter(h => {
              const [m] = h.date.split('-');
              return parseInt(m) === month.getMonth() + 1;
            }).length} resmi tatil
          </span>
          <button className="btn sm" onClick={goToday}>Bugün</button>
        </div>
      </div>

      <div className="cal-legend">
        <span className="cl-item"><span className="cl-swatch" style={{ background: 'var(--cal-weekend-bg)' }} /> Hafta sonu</span>
        <span className="cl-item"><span className="cl-swatch" style={{ background: 'var(--cal-holiday-bg)' }} /> Resmi tatil</span>
        <span className="cl-item"><span className="cl-swatch" style={{ background: 'var(--accent)', borderRadius: 99 }} /> Bugün</span>
        <span className="cl-item ms-auto">
          <InfoButton title="Takvim görünümü" icon={<Icons.Calendar size={12} />} corner accent="var(--accent)">
            <p>Aylık takvimde her hücre bir günü temsil eder. Hücredeki etiketler o güne denk gelen görevlerdir.</p>
            <div className="rt-sep" />
            <div className="rt-row"><Icons.Calendar size={12} className="rt-ico" /><span><strong>Hafta sonu:</strong> mavi-gri dolgu</span></div>
            <div className="rt-row"><Icons.Gift size={12} className="rt-ico" /><span><strong>Resmi tatil:</strong> kırmızı dolgu</span></div>
            <div className="rt-row"><Icons.Target size={12} className="rt-ico" /><span><strong>Bugün:</strong> renkli daire</span></div>
            <div className="rt-sep" />
            <div className="rt-row"><span className="rt-label">Tıklama</span><span className="rt-val">Günü genişlet</span></div>
            <div className="rt-row"><span className="rt-label">Ok tuşları</span><span className="rt-val">Ay değiştir</span></div>
          </InfoButton>
        </span>
      </div>

      <div className={`cal anim-in${calLarge ? ' cal-lg' : ''}`}>
        <div className="cal-head">
          {TR_DAYS.map(d => <div className="dow" key={d}>{d}</div>)}
        </div>
        <div className="cal-body">
          {days.map(d => {
            const inMonth = d.getMonth() === month.getMonth();
            const isToday_ = isSameDay(d, today_);
            const k = fmtISO(d);
            const events = eventsByDay[k] || [];
            const visible = events.slice(0, calLarge ? 6 : 3);
            const extra = events.length - visible.length;
            const hol = holidayFor(d);
            const weekend = isWeekend(d);
            return (
              <div
                key={k}
                className={`cal-cell${inMonth ? '' : ' other'}${isToday_ ? ' today' : ''}${weekend ? ' weekend' : ''}${hol ? ' holiday' : ''}`}
                onClick={(e) => {
                  // open if clicked on empty area (not on event)
                  if (e.target.closest('.cal-event') || e.target.closest('.info-btn') || e.target.closest('.rich-tip')) return;
                  if (events.length > 0) setDayOpen(k);
                }}
                style={{ cursor: events.length > 0 ? 'pointer' : 'default' }}
              >
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="dnum">{d.getDate()}</div>
                  {hol && inMonth && (
                    <Tooltip
                      title={hol.name}
                      icon={<Icons.Gift size={12} />}
                      content={<div className="rt-row"><span className="rt-label">Resmi tatil</span><span className="rt-val">{hol.short}</span></div>}
                    >
                      <span style={{ fontSize: 9.5, padding: '1px 5px', background: 'color-mix(in oklab, var(--status-overdue) 15%, transparent)', color: 'var(--status-overdue)', borderRadius: 3, fontWeight: 700 }}>{hol.short}</span>
                    </Tooltip>
                  )}
                </div>
                <div className="events">
                  {visible.map(t => (
                    <Tooltip
                      key={t.id}
                      title={t.task}
                      icon={<span style={{ width: 10, height: 8, borderRadius: 2, background: projectColorVar(t.proje), display: 'inline-block' }} />}
                      content={
                        <>
                          <div className="rt-row"><span className="rt-label">Proje</span><span className="rt-val">{t.proje}</span></div>
                          <div className="rt-row"><span className="rt-label">Etiket</span><span className="rt-val">{t.keyword}</span></div>
                          <div className="rt-row"><span className="rt-label">Sorumlu</span><span className="rt-val">{t.sorumlu.join(', ')}</span></div>
                          <div className="rt-row"><span className="rt-label">Tarih</span><span className="rt-val">{fmt(t.baslangicTarihi)} – {fmt(t.bitisTarihi)}</span></div>
                          <div className="rt-sep" />
                          <div className="rt-row"><span className="rt-label">Durum</span><span className="rt-val"><StatusPill task={t} size={10.5} /></span></div>
                        </>
                      }
                    >
                      <div className="cal-event"
                        style={{ '--ev-color': projectColorVar(t.proje) }}
                        onClick={(e) => { e.stopPropagation(); onOpenTask(t); }}
                      >
                        {t.keyword} · {t.task}
                      </div>
                    </Tooltip>
                  ))}
                  {extra > 0 && (
                    <button
                      style={{
                        fontSize: 10.5, color: 'var(--accent)', padding: '2px 6px', textAlign: 'left',
                        background: 'transparent', border: 0, cursor: 'pointer', fontWeight: 600, borderRadius: 4
                      }}
                      onClick={(e) => { e.stopPropagation(); setDayOpen(k); }}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'var(--accent-soft)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      +{extra} daha…
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {dayOpen && (
        <DayExpandModal
          iso={dayOpen}
          events={eventsByDay[dayOpen] || []}
          onClose={() => setDayOpen(null)}
          onOpenTask={(t) => { onOpenTask(t); setDayOpen(null); }}
        />
      )}
    </div>
  );
}

function DayExpandModal({ iso, events, onClose, onOpenTask }) {
  const d = parseDate(iso);
  const hol = holidayFor(d);
  const isWeekend_ = isWeekend(d);

  useEffect2(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // group by project
  const byProj = useMemo2(() => {
    const m = {};
    events.forEach(e => { m[e.proje] = m[e.proje] || []; m[e.proje].push(e); });
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0], 'tr'));
  }, [events]);

  return (
    <div className="day-expand-backdrop" onClick={onClose}>
      <div className="day-expand-panel" onClick={(e) => e.stopPropagation()}>
        <div className="day-expand-head">
          <div className="day-num">{d.getDate()}</div>
          <div className="col" style={{ flex: 1, gap: 2 }}>
            <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.015em' }}>
              {fmt(d, 'MMM yyyy')} · {TR_DAYS[(d.getDay() + 6) % 7]}
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {events.length} aktif görev{isWeekend_ ? ' · Hafta sonu' : ''}{hol ? ` · ${hol.name}` : ''}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icons.Close size={15} /></button>
        </div>
        <div className="day-expand-list">
          {byProj.length === 0 && <div className="empty" style={{ padding: 32 }}>Bu gün için görev yok.</div>}
          {byProj.map(([proj, list]) => (
            <div key={proj} className="col" style={{ gap: 2, marginBottom: 6 }}>
              <div style={{ padding: '6px 10px 4px', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: projectColorVar(proj) }} />
                {proj} · {list.length}
              </div>
              {list.map(t => {
                return (
                  <button key={t.id} className="day-event-row" onClick={() => onOpenTask(t)}>
                    <span className="de-bar" style={{ background: projectColorVar(t.proje) }} />
                    <div className="col" style={{ gap: 3, flex: 1, minWidth: 0, alignItems: 'flex-start' }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{t.task}</div>
                      <div className="row" style={{ gap: 6 }}>
                        <Kw color={t.color}>{t.keyword}</Kw>
                        <StatusPill task={t} size={10.5} />
                      </div>
                    </div>
                    <div className="col" style={{ alignItems: 'flex-end', gap: 4 }}>
                      <AvatarStack names={t.sorumlu} max={2} size="sm" />
                      <span className="muted tabular" style={{ fontSize: 10.5 }}>{fmt(t.baslangicTarihi)} → {fmt(t.bitisTarihi)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DateJumpPopover({ anchor, onClose, onJump }) {
  const [pos, setPos] = useState2({ left: 0, top: 0 });
  const ref = useRef2(null);
  const today_ = today();
  const [val, setVal] = useState2(fmtISO(today_));

  useEffect2(() => {
    if (!anchor) return;
    const Z = appZoom();
    const r = anchor.getBoundingClientRect();
    setPos({ left: Math.min(window.innerWidth / Z - 280, r.left / Z), top: r.bottom / Z + 6 });
  }, [anchor]);

  useEffect2(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !anchor?.contains(e.target)) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const quick = [
    { l: 'Bugün', d: today_ },
    { l: 'Sonraki ay', d: addDays(today_, 30) },
    { l: 'Sonraki çeyrek', d: addDays(today_, 90) },
    { l: 'Önceki ay', d: addDays(today_, -30) }
  ];

  return (
    <div ref={ref} className="col-filter-pop" style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 150, padding: 12, minWidth: 260 }}>
      <div className="col" style={{ gap: 8 }}>
        <span className="dff-label">Bir tarihe atla</span>
        <input type="date" className="input" value={val} onChange={(e) => setVal(e.target.value)} autoFocus />
        <div className="row" style={{ gap: 6 }}>
          <button className="btn ghost sm" onClick={onClose}>İptal</button>
          <div style={{ flex: 1 }} />
          <button className="btn primary sm" onClick={() => { onJump(parseDate(val)); }}>
            <Icons.ArrowRight size={12} /> Git
          </button>
        </div>
        <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
        <span className="dff-label">Hızlı atla</span>
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          {quick.map(q => (
            <button key={q.l} className="btn ghost sm" onClick={() => onJump(q.d)}>{q.l}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Gantt ──────────────────────────────────────────────── */
const GANTT_DEFAULT_COLS = {
  start: true,
  end: true,
  hedef: false,
  duration: false,
  hours: false,
  progress: false,
  status: false,
  sorumlu: false,
  priority: false
};
const GANTT_COL_DEFS = [
  { key: 'start', label: 'Başlangıç', width: 78, align: 'right', render: (t) => fmt(t.baslangicTarihi, 'dd MMM') },
  { key: 'end', label: 'Bitiş', width: 78, align: 'right', render: (t, today_) => {
      const overdue = t.status !== 'done' && diffDays(t.hedefTarih, today_) < 0;
      return <span style={{ color: overdue ? 'var(--status-overdue)' : 'inherit', fontWeight: overdue ? 600 : 500 }}>{fmt(t.bitisTarihi, 'dd MMM')}</span>;
  } },
  { key: 'hedef', label: 'Hedef', width: 78, align: 'right', render: (t) => fmt(t.hedefTarih, 'dd MMM') },
  { key: 'duration', label: 'Süre', width: 56, align: 'right', render: (t) => {
      const d = diffDays(t.bitisTarihi, t.baslangicTarihi) + 1;
      return <span className="tabular">{d}g</span>;
  } },
  { key: 'hours', label: 'Saat', width: 64, align: 'right', render: (t) => {
      if (t.milestone) return <span className="muted">—</span>;
      return <span className="tabular" style={{ fontSize: 11 }}>{t.actualHours || 0}/{t.plannedHours || 0}</span>;
  } },
  { key: 'progress', label: '%', width: 56, align: 'right', render: (t) => {
      const p = t.progress != null ? t.progress : (t.status === 'done' ? 100 : 0);
      return <span className="tabular">{p}%</span>;
  } },
  { key: 'status', label: 'Durum', width: 110, align: 'left', render: (t) => <StatusPill task={t} size={10.5} /> },
  { key: 'sorumlu', label: 'Sorumlu', width: 80, align: 'right', render: (t) => <AvatarStack names={t.sorumlu} max={2} size="sm" /> },
  { key: 'priority', label: 'Öncelik', width: 76, align: 'left', render: (t) => {
      const p = PRIORITIES[t.priority || 'medium'];
      return <span style={{ fontSize: 11, fontWeight: 600, color: p.color }}>{p.label}</span>;
  } }
];

export function GanttView({ tasks, onOpenTask }) {
  const today_ = today();
  const [groupBy, setGroupBy] = useState2('proje');
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
    baslangicTarihi: null,
    bitisTarihi: null,
    hedefTarih: null
  });
  const [sort, setSort] = useState2({ key: null, dir: 'asc' });
  const rightRef = useRef2(null);
  const leftRef = useRef2(null);

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
        const overdue = t.status !== 'done' && diffDays(t.hedefTarih, today_) < 0;
        if (colFilters.status.includes('overdue') && overdue) return true;
        return colFilters.status.includes(t.status || 'todo');
      });
    }
    ['baslangicTarihi', 'bitisTarihi', 'hedefTarih'].forEach(k => {
      if (colFilters[k]) out = out.filter(t => dateMatchesFilter(t[k], colFilters[k]));
    });
    ['progress', 'plannedHours'].forEach(k => {
      if (colFilters[k]) out = out.filter(t => numericMatchesFilter(t[k] != null ? t[k] : 0, colFilters[k]));
    });
    return out;
  }, [tasks, globalSearch, colFilters, today_]);

  const hasFilters = !!(globalSearch || colFilters.task || colFilters.proje.length || colFilters.sorumlu.length || colFilters.priority.length || colFilters.status.length || colFilters.progress || colFilters.plannedHours || colFilters.baslangicTarihi || colFilters.bitisTarihi || colFilters.hedefTarih);
  const clearAllFilters = () => {
    setGlobalSearch('');
    setColFilters({ task: '', proje: [], sorumlu: [], priority: [], status: [], progress: null, plannedHours: null, baslangicTarihi: null, bitisTarihi: null, hedefTarih: null });
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
    height: 'calc(100vh - 240px)',
    '--gantt-left-w': `${totalLeftW}px`,
    '--gantt-left-cols': gridTemplate
  };

  // Determine date range — based on tasks (full range, not filtered, so timeline doesn't shift)
  const range = useMemo2(() => {
    if (!tasks.length) return { start: today_, end: addDays(today_, 30) };
    let min = parseDate(tasks[0].baslangicTarihi);
    let max = parseDate(tasks[0].bitisTarihi);
    tasks.forEach(t => {
      const s = parseDate(t.baslangicTarihi);
      const e = parseDate(t.bitisTarihi);
      if (s < min) min = s;
      if (e > max) max = e;
    });
    return { start: addDays(min, -3), end: addDays(max, 3) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

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
          if (sort.key === 'priority') { va = (PRIORITIES[a.priority || 'medium'] || {}).order ?? 9; vb = (PRIORITIES[b.priority || 'medium'] || {}).order ?? 9; }
          if (va == null) va = '';
          if (vb == null) vb = '';
          if (va < vb) return sort.dir === 'asc' ? -1 : 1;
          if (va > vb) return sort.dir === 'asc' ? 1 : -1;
          return 0;
        }
        return parseDate(a.baslangicTarihi) - parseDate(b.baslangicTarihi);
      });
    });
    return Object.entries(map).sort((a, b) => a[0].localeCompare(b[0], 'tr'));
  }, [filteredTasks, groupBy, sort]);

  const xForDate = (d) => diffDays(d, range.start) * zoom;

  // Compute summary rollup per group: min start, max end, avg progress (weighted by duration)
  const groupSummaries = useMemo2(() => {
    const s = {};
    groups.forEach(([groupName, items]) => {
      const nonMs = items.filter(t => !t.milestone);
      if (!nonMs.length) { s[groupName] = null; return; }
      let minS = parseDate(nonMs[0].baslangicTarihi);
      let maxE = parseDate(nonMs[0].bitisTarihi);
      let totalDur = 0;
      let totalProg = 0;
      nonMs.forEach(t => {
        const ts = parseDate(t.baslangicTarihi);
        const te = parseDate(t.bitisTarihi);
        if (ts < minS) minS = ts;
        if (te > maxE) maxE = te;
        const d = (diffDays(te, ts) + 1);
        const p = t.progress != null ? t.progress : (t.status === 'done' ? 100 : 0);
        totalDur += d;
        totalProg += d * p;
      });
      s[groupName] = {
        start: minS, end: maxE,
        progress: totalDur ? Math.round(totalProg / totalDur) : 0,
        items: items.length,
        done: items.filter(t => t.status === 'done').length
      };
    });
    return s;
  }, [groups]);

  // Build flat row list (respect collapsed groups)
  const rows = [];
  groups.forEach(([groupName, items]) => {
    const isCollapsed = collapsed.has(groupName);
    rows.push({ type: 'group', name: groupName, summary: groupSummaries[groupName], collapsed: isCollapsed, itemCount: items.length });
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

        const fromY = rowTops.tops[j] + 19;
        const toY = rowTops.tops[i] + 19;

        const predStart = xForDate(parseDate(depTask.baslangicTarihi));
        const predEnd = xForDate(parseDate(depTask.bitisTarihi)) + zoom;
        const succStart = xForDate(parseDate(r.task.baslangicTarihi));
        const succEnd = xForDate(parseDate(r.task.bitisTarihi)) + zoom;

        let fromX, toX, fromSide, toSide;
        if (type === 'FS') { fromX = predEnd; toX = succStart; fromSide = 'R'; toSide = 'L'; }
        else if (type === 'SS') { fromX = predStart; toX = succStart; fromSide = 'L'; toSide = 'L'; }
        else if (type === 'FF') { fromX = predEnd; toX = succEnd; fromSide = 'R'; toSide = 'R'; }
        else { fromX = predStart; toX = succEnd; fromSide = 'L'; toSide = 'R'; }

        arrows.push({
          id: `${dId}-${r.task.id}-${type}`,
          type, fromX, fromY, toX, toY, fromSide, toSide,
          fromTaskId: dId, toTaskId: r.task.id,
          hot: hotTaskId === dId || hotTaskId === r.task.id
        });
      });
    });
    return arrows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, range, zoom, hotTaskId, rowTops]);

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
            <p>Görev çubukları zaman çizelgesinde başlangıç ve bitiş tarihlerine göre konumlanır. Bağımlılık okları görevler arasındaki ilişkiyi gösterir.</p>
            <div className="rt-sep" />
            <p><strong>Çubuk tipleri:</strong></p>
            <div className="rt-row"><span style={{ width: 16, height: 6, background: 'var(--accent)', borderRadius: 2 }} /><span>Normal görev</span></div>
            <div className="rt-row"><span style={{ width: 16, height: 6, background: 'linear-gradient(180deg, var(--text) 0%, color-mix(in oklab, var(--text) 80%, black) 100%)', borderRadius: 1 }} /><span>Özet (rollup)</span></div>
            <div className="rt-row"><span style={{ width: 12, height: 12, background: 'var(--status-overdue)', transform: 'rotate(45deg)' }} /><span>Kilometre taşı</span></div>
            <div className="rt-sep" />
            <div className="rt-row"><Icons.Filter size={12} className="rt-ico" /><span>Sütun başlığına tıkla: filtre & sıralama</span></div>
            <div className="rt-row"><Icons.ChevronDown size={12} className="rt-ico" /><span>Grup başlığına tıkla: daralt/genişlet</span></div>
            <div className="rt-row"><Icons.Grip size={12} className="rt-ico" /><span>Boş alana basılı tut: yatay kaydır</span></div>
            <div className="rt-row"><Icons.Link size={12} className="rt-ico" /><span>FS, SS, FF, SF ilişki tipleri</span></div>
          </InfoButton>
        </div>
      </div>

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
              let onSort = sortFor(c.key === 'start' ? 'baslangicTarihi' : c.key === 'end' ? 'bitisTarihi' : c.key === 'hedef' ? 'hedefTarih' : c.key);
              let sortKey = sortDirFor(c.key === 'start' ? 'baslangicTarihi' : c.key === 'end' ? 'bitisTarihi' : c.key === 'hedef' ? 'hedefTarih' : c.key);
              let numMin = null, numMax = null, numUnit = '';
              if (c.key === 'start') { filterType = 'date'; filterValue = colFilters.baslangicTarihi; onFilter = (v) => setCF('baslangicTarihi', v); }
              else if (c.key === 'end') { filterType = 'date'; filterValue = colFilters.bitisTarihi; onFilter = (v) => setCF('bitisTarihi', v); }
              else if (c.key === 'hedef') { filterType = 'date'; filterValue = colFilters.hedefTarih; onFilter = (v) => setCF('hedefTarih', v); }
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
                filterOptions = PEOPLE.slice().sort((a, b) => a.name.localeCompare(b.name, 'tr'))
                  .map(p => ({ value: p.name, label: p.name, icon: <Avatar name={p.name} size="sm" /> }));
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
                  {s && <span className="muted tabular" style={{ fontSize: 10, fontWeight: 600 }}>{s.done}/{s.items} · {s.progress}%</span>}
                </div>
              );
            }
            const t = r.task;
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
                    ? <Icons.Diamond size={11} style={{ color: projectColorVar(t.proje), flexShrink: 0 }} />
                    : <span style={{ width: 3, height: 18, borderRadius: 2, background: projectColorVar(t.proje), flexShrink: 0 }} />
                  }
                  <span>{t.task}</span>
                </div>
                {visibleCols.map(c => (
                  <div key={c.key} className="tr-date" style={{ textAlign: c.align === 'right' ? 'right' : 'left' }}>
                    {c.render(t, today_)}
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
              if (t.milestone) {
                const x = xForDate(parseDate(t.baslangicTarihi)) + zoom / 2 - 8;
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
                          <div className="rt-row"><span className="rt-label">Tarih</span><span className="rt-val">{fmt(t.hedefTarih, 'dd MMM yyyy')}</span></div>
                          <div className="rt-row"><span className="rt-label">Durum</span><span className="rt-val">{status.label}</span></div>
                          <div className="rt-row"><span className="rt-label">Sorumlu</span><span className="rt-val">{t.sorumlu.join(', ')}</span></div>
                        </>
                      }
                    >
                      <div
                        className="gantt-milestone"
                        style={{ '--milestone-color': projectColorVar(t.proje), top: top + 11, left: x }}
                        onClick={() => onOpenTask(t)}
                        onMouseEnter={() => setHotTaskId(t.id)}
                        onMouseLeave={() => setHotTaskId(null)}
                      />
                    </Tooltip>
                  </React.Fragment>
                );
              }
              const x = xForDate(parseDate(t.baslangicTarihi));
              const w = (diffDays(t.bitisTarihi, t.baslangicTarihi) + 1) * zoom;
              const color = projectColorVar(t.proje);
              const done = t.status === 'done';
              const pct = t.progress != null ? t.progress : (done ? 100 : 0);
              const overdue = t.status !== 'done' && diffDays(t.hedefTarih, today_) < 0;
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
                        <div className="rt-row"><span className="rt-label">Başlangıç</span><span className="rt-val">{fmt(t.baslangicTarihi, 'dd MMM yyyy')}</span></div>
                        <div className="rt-row"><span className="rt-label">Bitiş</span><span className="rt-val">{fmt(t.bitisTarihi, 'dd MMM yyyy')}</span></div>
                        <div className="rt-row"><span className="rt-label">Hedef</span><span className="rt-val" style={overdue ? { color: 'var(--status-overdue)' } : null}>{fmt(t.hedefTarih, 'dd MMM yyyy')}</span></div>
                        <div className="rt-sep" />
                        <div className="rt-row"><span className="rt-label">Durum</span><span className="rt-val">{status.label}</span></div>
                        <div className="rt-row"><span className="rt-label">İlerleme</span><span className="rt-val">{pct}%</span></div>
                        {t.plannedHours != null && (
                          <div className="rt-row"><span className="rt-label">Saat</span><span className="rt-val">{t.actualHours || 0}/{t.plannedHours} sa</span></div>
                        )}
                        <div className="rt-row"><span className="rt-label">Sorumlu</span><span className="rt-val">{t.sorumlu.join(', ')}</span></div>
                      </>
                    }
                  >
                    <div
                      className={`gantt-bar${done ? ' done' : ''}`}
                      style={{ '--bar-color': color, position: 'absolute', left: x + 2, width: Math.max(20, w - 4), top: top + 8 }}
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
              </defs>
              {depArrows.map((a) => {
                const d = buildArrowPath(a);
                const midX = (a.fromX + a.toX) / 2;
                const midY = (a.fromY + a.toY) / 2;
                return (
                  <g key={a.id} className={`dep-arrow${a.hot ? ' hot' : ''}`}>
                    <path
                      d={d}
                      strokeDasharray={a.hot ? '0' : '3 3'}
                      markerEnd={`url(#${a.hot ? 'arrowhead-hot' : 'arrowhead'})`}
                    />
                    <rect className="lbl-bg" x={midX - 11} y={midY - 7} width="22" height="13" rx="3" />
                    <text className="lbl" x={midX} y={midY + 3} textAnchor="middle">{a.type}</text>
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


/* ── Kanban (drag-and-drop, animated) ──────────────── */
export function KanbanView({ tasks, onOpenTask, onUpdateTask }) {
  const cols = [
    { id: 'todo', title: 'Yapılacak', icon: <Icons.Circle size={14} />, color: 'var(--status-todo)',
      help: 'Henüz başlanmamış görevler. Tahsis edildiler ama çalışma başlamadı.' },
    { id: 'in_progress', title: 'Devam ediyor', icon: <Icons.Clock size={14} />, color: 'var(--status-progress)',
      help: 'Aktif olarak üzerinde çalışılan görevler. Bu sütun eşzamanlı iş (devam eden) limitinizi gösterir.' },
    { id: 'done', title: 'Tamamlandı', icon: <Icons.Check size={14} />, color: 'var(--status-done)',
      help: 'Bitirilmiş görevler. Çevrim süresi raporları bu sütundaki kartlardan hesaplanır.' }
  ];

  const [dragId, setDragId] = useState2(null);
  const [dragOver, setDragOver] = useState2(null);
  const [flashId, setFlashId] = useState2(null);

  const grouped = useMemo2(() => {
    const map = { todo: [], in_progress: [], done: [] };
    tasks.forEach(t => {
      const s = t.status || 'todo';
      map[s].push(t);
    });
    return map;
  }, [tasks]);

  const onDragStart = (id) => setDragId(id);
  const onDragEnd = () => { setDragId(null); setDragOver(null); };
  const onDropTo = (colId) => {
    if (!dragId) return;
    const id = dragId;
    onUpdateTask(id, { status: colId });
    setFlashId(id);
    setTimeout(() => setFlashId(null), 700);
    setDragId(null); setDragOver(null);
  };

  return (
    <div className="kanban">
      {cols.map((c, ci) => {
        const items = grouped[c.id] || [];
        const isOver = dragOver === c.id;
        return (
          <div key={c.id} className="kanban-col anim-card" style={{ animationDelay: `${ci * 60}ms` }}>
            <div className="kanban-col-head" style={{ borderTopColor: c.color }}>
              <span style={{ display: 'inline-grid', placeItems: 'center', width: 22, height: 22, borderRadius: 5, color: c.color, background: `color-mix(in oklab, ${c.color} 14%, transparent)` }}>{c.icon}</span>
              <span style={{ fontWeight: 700, fontSize: 13.5, color: c.color, letterSpacing: '-0.005em' }}>{c.title}</span>
              <span className="count tabular" style={{ color: c.color, background: `color-mix(in oklab, ${c.color} 12%, transparent)`, padding: '1px 8px', borderRadius: 99, fontSize: 11.5, fontWeight: 600 }}><AnimatedNumber value={items.length} duration={500} /></span>
              <InfoButton title={c.title} icon={c.icon}>
                <p>{c.help}</p>
                <div className="rt-sep" />
                <div className="rt-row"><span className="rt-label">Toplam görev</span><span className="rt-val">{items.length}</span></div>
              </InfoButton>
            </div>
            <div
              className={`kanban-list${isOver ? ' drop-target' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(c.id); }}
              onDragLeave={() => setDragOver(null)}
              onDrop={() => onDropTo(c.id)}
            >
              {items.map((t, i) => {
                const today_ = today();
                const days = diffDays(t.hedefTarih, today_);
                const overdue = t.status !== 'done' && days < 0;
                const color = projectColorVar(t.proje);
                const prio = PRIORITIES[t.priority || 'medium'];
                return (
                  <Tooltip
                    key={t.id}
                    title={t.task}
                    icon={<span style={{ width: 12, height: 8, borderRadius: 2, background: color, display: 'inline-block' }} />}
                    accent={color}
                    content={<>
                      <div className="rt-row"><span className="rt-label">Proje</span><span className="rt-val">{t.proje}</span></div>
                      <div className="rt-row"><span className="rt-label">Etiket</span><span className="rt-val">{t.keyword}</span></div>
                      <div className="rt-row"><span className="rt-label">Öncelik</span><span className="rt-val" style={{ color: prio.color }}>{prio.label}</span></div>
                      <div className="rt-sep" />
                      <div className="rt-row"><span className="rt-label">Sorumlu</span><span className="rt-val">{t.sorumlu.join(', ')}</span></div>
                      <div className="rt-row"><span className="rt-label">Başlangıç</span><span className="rt-val">{fmt(t.baslangicTarihi, 'dd MMM yyyy')}</span></div>
                      <div className="rt-row"><span className="rt-label">Bitiş</span><span className="rt-val">{fmt(t.bitisTarihi, 'dd MMM yyyy')}</span></div>
                      <div className="rt-row"><span className="rt-label">Hedef</span><span className="rt-val" style={overdue ? { color: 'var(--status-overdue)' } : null}>{fmt(t.hedefTarih, 'dd MMM yyyy')}</span></div>
                      {t.plannedHours != null && (
                        <div className="rt-row"><span className="rt-label">Saat</span><span className="rt-val">{t.actualHours || 0} / {t.plannedHours} sa</span></div>
                      )}
                      {t.progress != null && t.progress > 0 && (
                        <>
                          <div className="rt-row"><span className="rt-label">İlerleme</span><span className="rt-val">{t.progress}%</span></div>
                          <div className="rt-bar"><div style={{ width: `${t.progress}%`, background: color }} /></div>
                        </>
                      )}
                      <div className="rt-foot"><Icons.Grip size={11} /> Sürükleyerek başka kolona taşı, tıklayarak detayı aç.</div>
                    </>}
                    asChild
                  >
                  <div
                    className={`k-card${dragId === t.id ? ' dragging' : ''}${flashId === t.id ? ' flash' : ''}`}
                    draggable
                    style={{ borderLeft: `3px solid ${color}`, animationDelay: `${Math.min(i * 30, 240)}ms` }}
                    onDragStart={() => onDragStart(t.id)}
                    onDragEnd={onDragEnd}
                    onClick={() => onOpenTask(t)}
                  >
                    <div className="k-title">{t.task}</div>
                    <div className="k-meta">
                      <Kw color={t.color}>{t.keyword}</Kw>
                      <span className="k-project">{t.proje}</span>
                    </div>
                    <div className="k-bottom">
                      <span className={`k-date${overdue ? ' late' : ''}`}>
                        <Icons.Clock size={11} />
                        {overdue ? `${Math.abs(days)} gün geçti` : days === 0 ? 'Bugün' : days <= 7 ? `${days} gün` : fmt(t.hedefTarih)}
                      </span>
                      <AvatarStack names={t.sorumlu} max={3} size="sm" />
                    </div>
                  </div>
                  </Tooltip>
                );
              })}
              {items.length === 0 && (
                <div className="empty" style={{ padding: 24, fontSize: 12 }}>Buraya sürükle</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Rapor (Reports) ──────────────────────────────────── */
export function RaporView({ tasks }) {
  const today_ = today();

  const trend = useMemo2(() => {
    const out = [];
    const labels = [];
    for (let i = 29; i >= 0; i--) {
      const d = addDays(today_, -i);
      const c = tasks.filter(t => t.status === 'done' && parseDate(t.bitisTarihi) <= d).length;
      out.push(c);
      labels.push(i % 5 === 0 ? fmt(d, 'd') : '');
    }
    return { values: out, labels };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);


  // Cumulative Flow Diagram — last 14 days
  const cfd = useMemo2(() => {
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = addDays(today_, -i);
      let todo = 0, prog = 0, done = 0;
      tasks.forEach(t => {
        const s = parseDate(t.baslangicTarihi);
        const e = parseDate(t.bitisTarihi);
        if (s > d) return; // hasn't started yet
        if (t.status === 'done' && e <= d) done++;
        else if (t.status === 'in_progress' || (t.status === 'done' && e > d)) prog++;
        else todo++;
      });
      days.push({ d, todo, prog, done, label: i % 3 === 0 ? fmt(d, 'd') : '' });
    }
    return days;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  // Weekly velocity — tasks completed each of last 6 weeks
  const velocity = useMemo2(() => {
    const out = [];
    for (let i = 5; i >= 0; i--) {
      const weekEnd = endOfWeek(addDays(today_, -i * 7));
      const weekStart = startOfWeek(weekEnd);
      const count = tasks.filter(t => {
        if (t.status !== 'done') return false;
        const e = parseDate(t.bitisTarihi);
        return e >= weekStart && e <= weekEnd;
      }).length;
      out.push({ label: `${fmt(weekStart, 'd')}–${fmt(weekEnd, 'd')}`, value: count });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  // Resource utilization (planned hours vs capacity)
  const CAPACITY_PER_PERSON = 40 * 6; // ~6-week horizon × 40h
  const resourceUtilization = useMemo2(() => {
    const map = {};
    tasks.forEach(t => {
      if (t.status === 'done') return; // only count remaining work
      (t.sorumlu || []).forEach(s => {
        const remaining = (t.plannedHours || 0) * (1 - (t.progress || 0) / 100);
        map[s] = map[s] || { hours: 0, tasks: 0 };
        map[s].hours += remaining / (t.sorumlu.length || 1);
        map[s].tasks += 1;
      });
    });
    return Object.entries(map).map(([name, v]) => ({
      name,
      hours: Math.round(v.hours),
      tasks: v.tasks,
      pct: Math.round((v.hours / CAPACITY_PER_PERSON) * 100),
      color: personColorVar(name)
    })).sort((a, b) => b.pct - a.pct);
  }, [tasks]);


  // Risk matrix — by priority × status (in-progress + todo)
  const risks = useMemo2(() => {
    const matrix = {};
    Object.keys(PRIORITIES).forEach(p => {
      matrix[p] = { todo: [], in_progress: [], overdue: [] };
    });
    tasks.forEach(t => {
      if (t.status === 'done') return;
      const p = t.priority || 'medium';
      const overdue = diffDays(t.hedefTarih, today_) < 0;
      if (overdue) matrix[p].overdue.push(t);
      else if (t.status === 'in_progress') matrix[p].in_progress.push(t);
      else matrix[p].todo.push(t);
    });
    return matrix;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  const projThroughput = useMemo2(() => {
    const map = {};
    tasks.forEach(t => {
      map[t.proje] = map[t.proje] || { total: 0, done: 0, late: 0 };
      map[t.proje].total++;
      if (t.status === 'done') map[t.proje].done++;
      if (t.status !== 'done' && diffDays(t.hedefTarih, today_) < 0) map[t.proje].late++;
    });
    return Object.entries(map).map(([name, v]) => ({ name, ...v, color: projectColorVar(name) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  const cycle = useMemo2(() => {
    const completed = tasks.filter(t => t.status === 'done');
    if (!completed.length) return { avg: 0, min: 0, max: 0 };
    const durations = completed.map(t => diffDays(t.bitisTarihi, t.baslangicTarihi));
    return {
      avg: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      min: Math.min(...durations),
      max: Math.max(...durations)
    };
  }, [tasks]);

  const onTime = useMemo2(() => {
    const completed = tasks.filter(t => t.status === 'done');
    if (!completed.length) return 0;
    const ot = completed.filter(t => diffDays(t.bitisTarihi, t.hedefTarih) <= 0).length;
    return Math.round((ot / completed.length) * 100);
  }, [tasks]);

  const tagDist = useMemo2(() => {
    const map = {};
    const taskMap = {};
    tasks.forEach(t => {
      map[t.keyword] = (map[t.keyword] || 0) + 1;
      taskMap[t.keyword] = taskMap[t.keyword] || { done: 0, total: 0, late: 0, color: t.color };
      taskMap[t.keyword].total++;
      if (t.status === 'done') taskMap[t.keyword].done++;
      if (t.status !== 'done' && diffDays(t.hedefTarih, today_) < 0) taskMap[t.keyword].late++;
    });
    return Object.entries(map).map(([k, v]) => ({
      label: k, value: v, color: COLOR_MAP[taskMap[k].color] || 'var(--accent)',
      colorKey: taskMap[k].color, done: taskMap[k].done, total: taskMap[k].total, late: taskMap[k].late
    })).sort((a, b) => b.value - a.value).slice(0, 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  const compRate = tasks.length ? Math.round(tasks.filter(t => t.status === 'done').length / tasks.length * 100) : 0;
  const doneCount = tasks.filter(t => t.status === 'done').length;
  const pendingCount = tasks.filter(t => t.status !== 'done').length;

  return (
    <div className="col stagger" style={{ gap: 20 }}>
      <HeroHeader title="Raporlar">
        <div className="muted" style={{ fontSize: 13.5 }}>Performans, çevrim süreleri ve teslim oranları.</div>
      </HeroHeader>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Big label="Tamamlama oranı" value={compRate} suffix="%" sub={`${doneCount} / ${tasks.length} görev`}
          tip="Tamamlanan görevlerin toplam görevlere oranı. Yüksek değer, takımın iş akışını verimli ilerlettiğini gösterir." />
        <Big label="Zamanında teslim" value={onTime} suffix="%" sub="tamamlanan görevlerin" accent={onTime >= 70 ? 'var(--status-done)' : 'var(--status-overdue)'}
          tip={<>
            <p>Hedef tarihinden önce veya hedef tarihinde tamamlanan görevlerin oranı.</p>
            <div className="rt-sep" />
            <div className="rt-row"><Icons.TrendUp size={12} className="rt-ico" /><span><strong>≥ %70</strong> sağlıklı ekip ritmi</span></div>
            <div className="rt-row"><Icons.Alert size={12} className="rt-ico" /><span><strong>&lt; %70</strong> planlama gözden geçirilmeli</span></div>
          </>}
        />
        <Big label="Ort. çevrim süresi" value={cycle.avg} suffix=" gün" sub={`min ${cycle.min} · max ${cycle.max}`}
          tip="Bir görevin başlangıçtan bitişine kadar geçen ortalama süre. Daha kısa çevrim, takım çevikliğine işaret eder." />
        <Big label="Bekleyen iş yükü" value={pendingCount} sub="aktif görev"
          tip="Henüz tamamlanmamış (yapılacak + devam eden) görev sayısı. Bekleyen iş listesinin büyüklüğünü ve önümüzdeki yükü gösterir." />
      </div>

      {/* Trend chart */}
      <div className="card">
        <div className="row" style={{ marginBottom: 14 }}>
          <div className="col">
            <div className="card-title" style={{ margin: 0 }}>
              <Icons.TrendUp size={14} /> 30 Günlük Tamamlama Eğrisi
              <InfoButton title="Tamamlama eğrisi" icon={<Icons.TrendUp size={12} />}>
                <p>Son 30 gün içinde birikimli olarak tamamlanan görev sayısının değişimi.</p>
                <div className="rt-sep" />
                <div className="rt-row"><span className="rt-label">Eğri yatay</span><span className="rt-val">Yavaşlama</span></div>
                <div className="rt-row"><span className="rt-label">Eğri dik</span><span className="rt-val">Hızlanma</span></div>
              </InfoButton>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>Birikimli "Tamamlandı" sayısı</div>
          </div>
        </div>
        <AreaChart data={trend.values} labels={trend.labels} width={1100} height={200} color="var(--status-done)" animated />
      </div>

      {/* Cumulative Flow Diagram */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
        <div className="card">
          <CardHead
            icon={<Icons.Layers size={14} />}
            title="Birikimli Akış Diyagramı"
            subtitle="Son 14 gün · devam eden iş gelişimi"
            infoAccent="var(--c-cyan)"
            infoIcon={<Icons.Layers size={12} />}
            info={<>
              <p><strong>CFD</strong>, görevlerin durum kolonları arasında zamana göre dağılımını gösterir (Lean / Kanban standardı).</p>
              <div className="rt-sep" />
              <div className="rt-row"><span className="rt-label">Bant genişler</span><span className="rt-val" style={{ color: 'var(--status-overdue)' }}>Birikim / darboğaz</span></div>
              <div className="rt-row"><span className="rt-label">Bant sabit</span><span className="rt-val" style={{ color: 'var(--status-done)' }}>Akış sağlıklı</span></div>
            </>}
          />
          <CFDChart data={cfd} />
        </div>

        <div className="card">
          <CardHead
            icon={<Icons.TrendUp size={14} />}
            title="Haftalık iş hızı"
            subtitle="Son 6 hafta · tamamlanan görev sayısı"
            infoAccent="var(--c-emerald)"
            infoIcon={<Icons.TrendUp size={12} />}
            info={<>
              <p>Her hafta tamamlanan görev sayısı. Dönem planlamasında referans olarak kullanılır.</p>
              <div className="rt-sep" />
              <div className="rt-row"><span className="rt-label">Hareketli ort.</span><span className="rt-val">{Math.round(velocity.reduce((a, b) => a + b.value, 0) / velocity.length)} görev/hafta</span></div>
              <div className="rt-foot"><Icons.Sparkle size={11} /> Sürekli artış: ekip ivmeleniyor.</div>
            </>}
          />
          <VelocityChart data={velocity} />
        </div>
      </div>

      {/* Kaynak kullanımı */}
        <div className="card">
          <CardHead
            icon={<Icons.Users size={14} />}
            title="Kaynak kullanımı"
            subtitle="Kişi başına kalan iş · 6 hafta = 240 sa"
            infoAccent="var(--c-cyan)"
            infoIcon={<Icons.Users size={12} />}
            info={<>
              <p>Her ekip üyesinin kalan görev saatlerinin 6 haftalık kapasiteye oranı (PMBOK kaynak yönetimi).</p>
              <div className="rt-sep" />
              <div className="rt-row"><span className="rt-label">≤ %70</span><span className="rt-val" style={{ color: 'var(--status-done)' }}>Düşük yük</span></div>
              <div className="rt-row"><span className="rt-label">%70–%100</span><span className="rt-val" style={{ color: 'var(--status-progress)' }}>Sağlıklı</span></div>
              <div className="rt-row"><span className="rt-label">&gt; %100</span><span className="rt-val" style={{ color: 'var(--status-overdue)' }}>Aşırı yük</span></div>
            </>}
          />
          <div className="col" style={{ gap: 8 }}>
            {resourceUtilization.map(r => {
              const danger = r.pct > 100;
              const warn = r.pct > 85;
              return (
                <Tooltip
                  key={r.name}
                  title={r.name}
                  accent={r.color}
                  icon={<Avatar name={r.name} size="sm" />}
                  content={<>
                    <div className="rt-row"><span className="rt-label">Kalan saat</span><span className="rt-val">{r.hours} sa</span></div>
                    <div className="rt-row"><span className="rt-label">Aktif görev</span><span className="rt-val">{r.tasks}</span></div>
                    <div className="rt-row"><span className="rt-label">Kapasite</span><span className="rt-val">{CAPACITY_PER_PERSON} sa</span></div>
                    <div className="rt-sep" />
                    <div className="rt-row"><span className="rt-label">Kullanım</span><span className="rt-val" style={{ color: danger ? 'var(--status-overdue)' : warn ? 'var(--c-amber)' : 'var(--status-done)' }}>%{r.pct}</span></div>
                    <div className="rt-bar"><div style={{ width: `${Math.min(100, r.pct)}%`, background: danger ? 'var(--status-overdue)' : r.color }} /></div>
                  </>}
                >
                  <div className="row" style={{ gap: 10, cursor: 'help', padding: '4px 0' }}>
                    <Avatar name={r.name} size="sm" />
                    <div className="col" style={{ gap: 3, flex: 1, minWidth: 0 }}>
                      <div className="row" style={{ gap: 6 }}>
                        <span style={{ fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                        <span className="muted tabular" style={{ fontSize: 10.5, marginLeft: 'auto' }}>{r.hours}sa</span>
                        <span className="tabular" style={{ fontSize: 11, fontWeight: 700, color: danger ? 'var(--status-overdue)' : warn ? 'var(--c-amber)' : 'var(--text)', minWidth: 36, textAlign: 'right' }}>%{r.pct}</span>
                      </div>
                      <div className="bar-track" style={{ height: 4 }}>
                        <div className="bar-fill" style={{ width: `${Math.min(100, r.pct)}%`, background: danger ? 'var(--status-overdue)' : r.color }} />
                      </div>
                    </div>
                  </div>
                </Tooltip>
              );
            })}
          </div>
        </div>

      {/* Risk matrix */}
      <div className="card">
        <CardHead
          icon={<Icons.Alert size={14} />}
          title="Risk matrisi"
          subtitle="Öncelik × durum dağılımı"
          infoAccent="var(--status-overdue)"
          infoIcon={<Icons.Alert size={12} />}
          info={<>
            <p>Açık görevlerin öncelik–durum kesişiminde gruplanması (PRINCE2 risk yönetimi yaklaşımı).</p>
            <div className="rt-sep" />
            <p>Sağ üst köşeye (kritik × geciken) yığılmış görevlere öncelikli müdahale gerekir.</p>
          </>}
        />
        <div className="risk-matrix">
          <div className="rm-th" />
          <div className="rm-th">Yapılacak</div>
          <div className="rm-th">Devam</div>
          <div className="rm-th">Geciken</div>
          {Object.values(PRIORITIES).map(p => {
            const row = risks[p.id];
            return (
              <React.Fragment key={p.id}>
                <div className="rm-row-th"><span style={{ color: p.color }}>●</span> {p.label}</div>
                {['todo', 'in_progress', 'overdue'].map(s => {
                  const items = row[s];
                  const v = items.length;
                  const intensity = Math.min(1, v / 5);
                  const statusLabel = s === 'todo' ? 'Yapılacak' : s === 'in_progress' ? 'Devam eden' : 'Geciken';
                  const cell = (
                    <div
                      className="rm-cell"
                      style={{
                        background: `color-mix(in oklab, ${p.color} ${10 + intensity * 30}%, var(--bg-elev-2))`,
                        opacity: v === 0 ? 0.35 : 1,
                        cursor: v ? 'help' : 'default',
                        width: '100%'
                      }}
                    >
                      <span className="rm-val">{v}</span>
                      <span className="rm-sub">görev</span>
                    </div>
                  );
                  if (!v) return <React.Fragment key={s}>{cell}</React.Fragment>;
                  return (
                    <Tooltip
                      key={s}
                      wrapperStyle={{ display: 'flex', width: '100%' }}
                      title={`${p.label} · ${statusLabel}`}
                      accent={p.color}
                      icon={<span style={{ color: p.color, fontSize: 9 }}>●</span>}
                      content={<>
                        <div className="rt-row"><span className="rt-label">Görev sayısı</span><span className="rt-val">{v}</span></div>
                        <div className="rt-sep" />
                        {items.slice(0, 6).map(t => (
                          <div key={t.id} className="rt-row">
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{t.task}</span>
                          </div>
                        ))}
                        {v > 6 && <div className="rt-foot">+{v - 6} görev daha</div>}
                      </>}
                    >
                      {cell}
                    </Tooltip>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 16 }}>
        <div className="card">
          <div className="card-title" style={{ marginBottom: 14 }}>
            <Icons.Briefcase size={14} /> Proje bazında ilerleme
            <InfoButton title="Proje ilerlemesi" icon={<Icons.Briefcase size={12} />}>
              <p>Her projenin toplam görev, tamamlanan ve geciken görev sayıları ile yüzdesel ilerlemesi.</p>
            </InfoButton>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Proje</th>
                <th style={{ textAlign: 'right' }}>Toplam</th>
                <th style={{ textAlign: 'right' }}>Tamamlanan</th>
                <th style={{ textAlign: 'right' }}>Geciken</th>
                <th style={{ width: 160 }}>İlerleme</th>
              </tr>
            </thead>
            <tbody>
              {projThroughput.map(p => {
                const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
                return (
                  <tr key={p.name}>
                    <td>
                      <Tooltip
                        title={p.name}
                        icon={<span style={{ width: 10, height: 10, borderRadius: 2, background: p.color, display: 'inline-block' }} />}
                        content={
                          <>
                            <div className="rt-row"><span className="rt-label">Toplam</span><span className="rt-val">{p.total}</span></div>
                            <div className="rt-row"><span className="rt-label">Tamamlanan</span><span className="rt-val" style={{ color: 'var(--status-done)' }}>{p.done}</span></div>
                            <div className="rt-row"><span className="rt-label">Geciken</span><span className="rt-val" style={p.late > 0 ? { color: 'var(--status-overdue)' } : null}>{p.late}</span></div>
                            <div className="rt-sep" />
                            <div className="rt-row"><span className="rt-label">İlerleme</span><span className="rt-val">{pct}%</span></div>
                          </>
                        }
                      >
                        <div className="row" style={{ gap: 8 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
                          <span style={{ fontWeight: 500 }}>{p.name}</span>
                        </div>
                      </Tooltip>
                    </td>
                    <td className="tabular" style={{ textAlign: 'right' }}><AnimatedNumber value={p.total} /></td>
                    <td className="tabular" style={{ textAlign: 'right', color: 'var(--status-done)' }}><AnimatedNumber value={p.done} /></td>
                    <td className="tabular" style={{ textAlign: 'right', color: p.late > 0 ? 'var(--status-overdue)' : 'var(--text-dim)' }}><AnimatedNumber value={p.late} /></td>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <div className="bar-track" style={{ flex: 1 }}>
                          <div className="bar-fill" style={{ width: `${pct}%`, background: p.color }} />
                        </div>
                        <span className="tabular" style={{ fontSize: 11.5, color: 'var(--text-muted)', minWidth: 32, textAlign: 'right' }}>
                          <AnimatedNumber value={pct} />%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="card">
          <CardHead
            icon={<Icons.Sparkle size={14} />}
            title="En sık etiketler"
            subtitle={`${tagDist.length} farklı etiket · top 10`}
            infoAccent="var(--c-purple)"
            infoIcon={<Icons.Sparkle size={12} />}
            info={<>
              <p>Görevlerde en çok kullanılan etiketler. Hangi alanlara odaklandığınızı gösterir.</p>
              <div className="rt-sep" />
              <div className="rt-row"><span className="rt-label">Sıralama</span><span className="rt-val">Görev sayısına göre</span></div>
              <div className="rt-row"><span className="rt-label">Daire</span><span className="rt-val">Tamamlama oranı</span></div>
              <div className="rt-foot"><Icons.Sparkle size={11} /> Etiketin üzerine gelin: detaylı kırılım açılır.</div>
            </>}
          />
          <div className="tag-cloud">
            {tagDist.map((t, i) => {
              const pct = Math.round((t.done / t.total) * 100);
              const max = tagDist[0].value;
              const scale = 0.7 + 0.5 * (t.value / max);
              return (
                <Tooltip
                  key={t.label}
                  title={t.label}
                  icon={<span style={{ width: 10, height: 10, borderRadius: 2, background: t.color, display: 'inline-block' }} />}
                  accent={t.color}
                  content={<>
                    <div className="rt-row"><span className="rt-label">Toplam</span><span className="rt-val">{t.total} görev</span></div>
                    <div className="rt-row"><span className="rt-label">Tamamlanan</span><span className="rt-val" style={{ color: 'var(--status-done)' }}>{t.done}</span></div>
                    {t.late > 0 && <div className="rt-row"><span className="rt-label">Geciken</span><span className="rt-val" style={{ color: 'var(--status-overdue)' }}>{t.late}</span></div>}
                    <div className="rt-sep" />
                    <div className="rt-row"><span className="rt-label">Tamamlama</span><span className="rt-val">{pct}%</span></div>
                    <div className="rt-bar"><div style={{ width: `${pct}%`, background: t.color }} /></div>
                  </>}
                >
                  <div
                    className="tag-chip"
                    style={{
                      '--tg-color': t.color,
                      animationDelay: `${i * 35}ms`,
                      fontSize: `${12 + scale * 1}px`
                    }}
                  >
                    <span className="tg-ring" style={{ '--p': pct, '--tg-color': t.color }}>
                      <span className="tg-ring-bg" />
                      <span className="tg-ring-fg" />
                      <span className="tg-count">{t.value}</span>
                    </span>
                    <div className="col" style={{ gap: 2, minWidth: 0 }}>
                      <span className="tg-label">{t.label}</span>
                      <span className="tg-meta">
                        <span style={{ color: 'var(--status-done)' }}>{t.done}</span>
                        <span style={{ color: 'var(--text-dim)' }}> / {t.total}</span>
                        <span style={{ color: 'var(--text-dim)' }}>  · {pct}%</span>
                      </span>
                    </div>
                  </div>
                </Tooltip>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Big({ label, value, suffix, sub, accent, tip }) {
  return (
    <div className="card" style={{ padding: 18, position: 'relative' }}>
      {tip && (
        <div className="card-info-corner">
          <InfoButton title={label} corner accent={accent}>{tip}</InfoButton>
        </div>
      )}
      <div className="muted" style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 8 }}>{label}</div>
      <div className="tabular" style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-0.025em', color: accent || 'var(--text)', lineHeight: 1.05 }}>
        <AnimatedNumber value={typeof value === 'number' ? value : parseInt(value) || 0} duration={900} />{suffix || ''}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function CFDChart({ data, height = 200 }) {
  if (!data || !data.length) return null;
  const width = 600;
  const pad = { l: 30, r: 14, t: 8, b: 24 };
  const max = Math.max(...data.map(d => d.todo + d.prog + d.done));
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const x = (i) => pad.l + (i / (data.length - 1)) * innerW;
  const y = (v) => pad.t + innerH - (v / (max || 1)) * innerH;

  // Build stacked paths
  const buildPath = (key, prevKeys) => {
    const top = data.map((d, i) => {
      let stack = 0;
      prevKeys.forEach(k => stack += d[k]);
      return [x(i), y(stack + d[key])];
    });
    const bot = data.map((d, i) => {
      let stack = 0;
      prevKeys.forEach(k => stack += d[k]);
      return [x(i), y(stack)];
    }).reverse();
    return [...top, ...bot].map(([X, Y]) => `${X.toFixed(1)},${Y.toFixed(1)}`).join(' ');
  };

  const [hover, setHover] = React.useState(null);
  const svgRef = React.useRef(null);
  const onMove = (e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * width;
    let best = 0; let bestD = Infinity;
    data.forEach((_, i) => {
      const xi = x(i);
      const dd = Math.abs(xi - px);
      if (dd < bestD) { bestD = dd; best = i; }
    });
    setHover(best);
  };

  return (
    <div style={{ position: 'relative' }}>
      <svg
        ref={svgRef}
        width="100%" height={height} viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ display: 'block', cursor: 'crosshair' }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* gridlines */}
        {[0, 0.5, 1].map((g, i) => (
          <line key={i} x1={pad.l} x2={width - pad.r} y1={pad.t + g * innerH} y2={pad.t + g * innerH} stroke="var(--border)" strokeDasharray="3 3" />
        ))}
        <polygon points={buildPath('done', [])} fill="var(--status-done)" opacity="0.7" />
        <polygon points={buildPath('prog', ['done'])} fill="var(--status-progress)" opacity="0.7" />
        <polygon points={buildPath('todo', ['done', 'prog'])} fill="var(--status-todo)" opacity="0.55" />
        {hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + innerH} stroke="var(--accent)" strokeWidth="1" strokeDasharray="2 2" opacity="0.6" />
        )}
        {/* axis labels */}
        {data.map((d, i) => d.label ? (
          <text key={i} x={x(i)} y={height - 6} textAnchor="middle" fontSize="10.5" fill="var(--text-dim)">{d.label}</text>
        ) : null)}
      </svg>
      {/* legend */}
      <div className="row" style={{ gap: 14, padding: '8px 12px 0', fontSize: 11.5, color: 'var(--text-dim)' }}>
        <span className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--status-done)', opacity: 0.7 }} /> Tamamlanan</span>
        <span className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--status-progress)', opacity: 0.7 }} /> Devam</span>
        <span className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--status-todo)', opacity: 0.55 }} /> Yapılacak</span>
      </div>
      {hover != null && (
        <div className="rich-tip" style={{
          position: 'absolute',
          left: `${(x(hover) / width) * 100}%`,
          top: 0,
          transform: 'translate(-50%, -100%)',
          pointerEvents: 'none',
          maxWidth: 220,
          minWidth: 150
        }}>
          <div className="rich-tip-head">
            <span className="rich-tip-icon"><Icons.Calendar size={12} /></span>
            <span className="rich-tip-title">{fmt(data[hover].d, 'dd MMM')}</span>
          </div>
          <div className="rich-tip-body">
            <div className="rt-row"><span className="rt-label">Tamamlanan</span><span className="rt-val" style={{ color: 'var(--status-done)' }}>{data[hover].done}</span></div>
            <div className="rt-row"><span className="rt-label">Devam</span><span className="rt-val" style={{ color: 'var(--status-progress)' }}>{data[hover].prog}</span></div>
            <div className="rt-row"><span className="rt-label">Yapılacak</span><span className="rt-val">{data[hover].todo}</span></div>
            <div className="rt-row"><span className="rt-label">Toplam</span><span className="rt-val">{data[hover].todo + data[hover].prog + data[hover].done}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}

function VelocityChart({ data, height = 180 }) {
  const max = Math.max(...data.map(d => d.value), 1);
  const avg = Math.round(data.reduce((a, b) => a + b.value, 0) / data.length);
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="velocity-bars" style={{ height }}>
        {data.map((d, i) => {
          const h = (d.value / max) * 100;
          const isCurrent = i === data.length - 1;
          return (
            <Tooltip
              key={i}
              title={d.label}
              icon={<Icons.TrendUp size={12} />}
              accent={isCurrent ? 'var(--status-done)' : 'var(--accent)'}
              content={<>
                <div className="rt-row"><span className="rt-label">Tamamlanan</span><span className="rt-val">{d.value} görev</span></div>
                <div className="rt-row"><span className="rt-label">Ort. fark</span><span className="rt-val" style={{ color: (d.value - avg) >= 0 ? 'var(--status-done)' : 'var(--status-overdue)' }}>{(d.value - avg) >= 0 ? '+' : ''}{d.value - avg}</span></div>
                <div className="rt-bar"><div style={{ width: `${h}%`, background: 'var(--accent)' }} /></div>
              </>}
            >
              <div className="vel-col" style={{ cursor: 'help' }}>
                <span className="vel-num">{d.value}</span>
                <span className="vel-bar" style={{ height: `${Math.max(2, h)}%`, background: isCurrent ? 'var(--status-done)' : 'var(--accent)' }} />
                <span className="vel-label">{d.label}</span>
              </div>
            </Tooltip>
          );
        })}
      </div>
      <div className="row" style={{ justifyContent: 'space-between', fontSize: 11.5, color: 'var(--text-dim)' }}>
        <span>Hareketli ort: <strong style={{ color: 'var(--text)' }}>{avg}</strong> görev/hafta</span>
        <span>En yüksek: <strong style={{ color: 'var(--status-done)' }}>{max}</strong></span>
      </div>
    </div>
  );
}
