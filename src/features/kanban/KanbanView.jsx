'use client';
import { useState as useState2, useMemo as useMemo2 } from 'react';
import { Icons } from '../../components/icons';
import { resolvePriority } from '../../domain/constants';
import { fmt, diffDays, today } from '../../scheduling/dates';
import { projectColorVar } from '../../lib/colors';
import { AvatarStack } from '../../components/ui';
import { TaskKeyword } from '../../components/TaskKeyword';
import { Tooltip, InfoButton, AnimatedNumber } from '../../components/ui-extras';
import { useTasks, useTaskActions } from '../../state/hooks';

/* ── Kanban (drag-and-drop, animated) ──────────────── */
export function KanbanView() {
  const tasks = useTasks();
  const { openTask: onOpenTask, updateTask: onUpdateTask } = useTaskActions();
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
      // Panoda yalnızca üç sütun vardır. Kalıcı kayıttan gelen tanınmayan bir
      // durum (eski şema, dış aktarım) doğrudan indekslenirse `map[s]` tanımsız
      // olur ve sayfa tümüyle çökerdi; bilinmeyen durum "Yapılacak" sayılır.
      const status = Object.prototype.hasOwnProperty.call(map, t.status) ? t.status : 'todo';
      map[status].push(t);
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
                const days = t.targetFinish ? diffDays(t.targetFinish, today_) : null;
                const overdue = t.status !== 'done' && days != null && days < 0;
                const color = projectColorVar(t.proje);
                const prio = resolvePriority(t.priority);
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
                      <div className="rt-row"><span className="rt-label">Başlangıç</span><span className="rt-val">{fmt(t.plannedStart, 'dd MMM yyyy')}</span></div>
                      <div className="rt-row"><span className="rt-label">Bitiş</span><span className="rt-val">{fmt(t.plannedFinish, 'dd MMM yyyy')}</span></div>
                      <div className="rt-row"><span className="rt-label">Hedef</span><span className="rt-val" style={overdue ? { color: 'var(--status-overdue)' } : null}>{t.targetFinish ? fmt(t.targetFinish, 'dd MMM yyyy') : '—'}</span></div>
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
                      <TaskKeyword task={t} />
                      <span className="k-project">{t.proje}</span>
                    </div>
                    <div className="k-bottom">
                      <span className={`k-date${overdue ? ' late' : ''}`}>
                        <Icons.Clock size={11} />
                        {days == null ? 'Hedef yok' : overdue ? `${Math.abs(days)} gün geçti` : days === 0 ? 'Bugün' : days <= 7 ? `${days} gün` : fmt(t.targetFinish)}
                      </span>
                      <AvatarStack names={t.sorumlu} personIds={t.assigneeIds} max={3} size="sm" />
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
