'use client';
import { useMemo as useMemo1 } from 'react';
import { Icons } from '../../components/icons';
import { diffDays, today } from '../../scheduling/dates';
import { projectColorVar } from '../../lib/colors';
import { Avatar } from '../../components/ui';
import { InfoButton, AnimatedNumber } from '../../components/ui-extras';
import { useTasks, usePeople, useTaskActions } from '../../state/hooks';

/* ── Kişi (People) view ──────────────────────────────── */
export function TeamView() {
  const tasks = useTasks();
  const people = usePeople();
  const { openTask: onOpenTask } = useTaskActions();
  const today_ = today();

  const stats = useMemo1(() => {
    return people.map(p => {
      const mine = tasks.filter(t => t.sorumlu.includes(p.name));
      const done = mine.filter(t => t.status === 'done').length;
      const active = mine.filter(t => t.status === 'in_progress').length;
      const late = mine.filter(t => t.status !== 'done' && diffDays(t.hedefTarih, today_) < 0).length;
      return { person: p, total: mine.length, done, active, late, tasks: mine };
    });
  }, [tasks]);

  const byTeam = useMemo1(() => {
    const map = {};
    stats.forEach(s => {
      map[s.person.team] = map[s.person.team] || [];
      map[s.person.team].push(s);
    });
    return map;
  }, [stats]);

  return (
    <div className="col" style={{ gap: 20 }}>
      {Object.entries(byTeam).map(([team, members]) => (
        <div key={team} className="col" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>{team}</div>
            <div style={{ height: 1, flex: 1, background: 'var(--border)' }} />
            <div className="muted tabular" style={{ fontSize: 11 }}>{members.length} üye</div>
          </div>
          <div className="stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {members.map(m => (
              <div key={m.person.id} className="card" style={{ padding: 18 }}>
                <div className="row" style={{ alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
                  <Avatar name={m.person.name} size="lg" />
                  <div className="col" style={{ flex: 1, gap: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{m.person.name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{m.person.role}</div>
                  </div>
                  <InfoButton title={m.person.name} icon={<Avatar name={m.person.name} size="sm" />}>
                    <div className="rt-row"><span className="rt-label">Rol</span><span className="rt-val">{m.person.role}</span></div>
                    <div className="rt-row"><span className="rt-label">Ekip</span><span className="rt-val">{m.person.team}</span></div>
                    <div className="rt-sep" />
                    <div className="rt-row"><span className="rt-label">Toplam görev</span><span className="rt-val">{m.total}</span></div>
                    <div className="rt-row"><span className="rt-label">Devam eden</span><span className="rt-val">{m.active}</span></div>
                    <div className="rt-row"><span className="rt-label">Tamamlanan</span><span className="rt-val" style={{ color: 'var(--status-done)' }}>{m.done}</span></div>
                    <div className="rt-row"><span className="rt-label">Geciken</span><span className="rt-val" style={m.late > 0 ? { color: 'var(--status-overdue)' } : null}>{m.late}</span></div>
                  </InfoButton>
                  {m.late > 0 && (
                    <span className="badge" style={{ color: 'var(--status-overdue)', borderColor: 'color-mix(in oklab, var(--status-overdue) 35%, var(--border))', background: 'color-mix(in oklab, var(--status-overdue) 14%, transparent)' }}>
                      <Icons.Alert size={10} /> {m.late} geciken
                    </span>
                  )}
                </div>
                <div className="row" style={{ gap: 16, marginBottom: 12 }}>
                  <Mini label="Toplam" value={m.total} />
                  <Mini label="Devam" value={m.active} color="var(--status-progress)" />
                  <Mini label="Bitti" value={m.done} color="var(--status-done)" />
                </div>
                <div className="bar-track" style={{ marginBottom: 12 }}>
                  <div className="bar-fill done" style={{ width: m.total ? `${(m.done / m.total) * 100}%` : 0 }} />
                </div>
                <div className="col" style={{ gap: 4 }}>
                  {m.tasks.slice(0, 3).map(t => (
                    <button key={t.id} onClick={() => onOpenTask(t)} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px',
                      borderRadius: 5, background: 'transparent', border: 0,
                      width: '100%', textAlign: 'left', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 12
                    }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
                    >
                      <span style={{ width: 5, height: 5, borderRadius: 99, background: projectColorVar(t.proje), flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{t.task}</span>
                    </button>
                  ))}
                  {m.tasks.length > 3 && <div className="muted" style={{ fontSize: 11, padding: '2px 8px' }}>+{m.tasks.length - 3} daha</div>}
                  {m.tasks.length === 0 && <div className="muted" style={{ fontSize: 12, padding: '6px 8px' }}>Atanmış görev yok.</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
function Mini({ label, value, color }) {
  return (
    <div className="col" style={{ gap: 0, flex: 1 }}>
      <div className="muted" style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</div>
      <div className="tabular" style={{ fontSize: 18, fontWeight: 700, color: color || 'var(--text)', letterSpacing: '-0.02em', lineHeight: 1.2 }}>
        <AnimatedNumber value={value} duration={700} />
      </div>
    </div>
  );
}
