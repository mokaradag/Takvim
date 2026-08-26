'use client';
import { useState as useState2, useMemo as useMemo2, useEffect as useEffect2, useRef as useRef2 } from 'react';
import { DateInput } from '../../components/DateInput';
import { Icons } from '../../components/icons';
import { TR_MONTHS_LONG, TR_DAYS, parseDate, fmtISO, fmt, addDays, startOfMonth, endOfMonth, startOfWeek, endOfWeek, isSameDay, isWeekend, today, eachDay } from '../../scheduling/dates';
import { DEFAULT_CALENDAR, holidayFor } from '../../scheduling/calendars';
import { projectColorVar } from '../../lib/colors';
import { AvatarStack, StatusPill } from '../../components/ui';
import { TaskKeyword } from '../../components/TaskKeyword';
import { Tooltip, InfoButton } from '../../components/ui-extras';
import { appZoom } from '../../lib/zoom';
import { useTasks, useTaskActions } from '../../state/hooks';
import { bucketCalendarTasks, taskCalendarDate } from './calendarTaskBucketing.js';

/* ── Takvim (Calendar) ─────────────────────────────────── */
export function CalendarView({ t, setTweak }) {
  const tasks = useTasks();
  const { openTask: onOpenTask } = useTaskActions();
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
    return bucketCalendarTasks(tasks);
  }, [tasks]);

  const goPrev = () => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1));
  const goNext = () => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1));
  const goToday = () => setMonth(new Date(today_.getFullYear(), today_.getMonth(), 1));

  useEffect2(() => {
    const onKey = (e) => {
      if (dayOpen) return;
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
            {DEFAULT_CALENDAR.holidays.filter((holiday) => {
              const holidayDate = parseDate(holiday.date);
              return holidayDate.getFullYear() === month.getFullYear()
                && holidayDate.getMonth() === month.getMonth();
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
            <p>Aylık takvim bir termin görünümüdür. Her görev yalnızca hedef bitiş gününde görünür; hedef bitişi olmayan eski görevlerde planlanan bitiş kullanılır.</p>
            <p>Görev süresini günlere yayılmış görmek için Gantt görünümünü kullanın.</p>
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
                          <div className="rt-row"><span className="rt-label">Termin</span><span className="rt-val">{fmt(taskCalendarDate(t))}</span></div>
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
              <div style={{ padding: '6px 10px 4px', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.01em', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: projectColorVar(proj) }} />
                {proj} · {list.length}
              </div>
              {list.map(t => (
                <button key={t.id} className="day-event-row" onClick={() => onOpenTask(t)}>
                  <span className="de-bar" style={{ background: projectColorVar(t.proje) }} />
                  <div className="col" style={{ gap: 3, flex: 1, minWidth: 0, alignItems: 'flex-start' }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{t.task}</div>
                    <div className="row" style={{ gap: 6 }}>
                      <TaskKeyword task={t} />
                      <StatusPill task={t} size={10.5} />
                    </div>
                  </div>
                  <div className="col" style={{ alignItems: 'flex-end', gap: 4 }}>
                    <AvatarStack names={t.sorumlu} personIds={t.assigneeIds} max={2} size="sm" />
                    <span className="muted tabular" style={{ fontSize: 10.5 }}>Termin · {fmt(taskCalendarDate(t))}</span>
                  </div>
                </button>
              ))}
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
    <div ref={ref} className="col-filter-pop" style={{ position: 'fixed', left: pos.left, top: pos.top, padding: 12, minWidth: 260 }}>
      <div className="col" style={{ gap: 8 }}>
        <span className="dff-label">Bir tarihe atla</span>
        <DateInput value={val} onChange={setVal} allowEmpty={false} autoFocus />
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
