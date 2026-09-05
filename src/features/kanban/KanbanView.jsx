'use client';
import { useEffect as useEffect2, useMemo as useMemo2, useRef as useRef2, useState as useState2 } from 'react';
import { Icons } from '../../components/icons';
import { resolvePriority } from '../../domain/constants';
import { fmt, diffDays, today } from '../../scheduling/dates';
import { projectColorVar } from '../../lib/colors';
import { AvatarStack } from '../../components/ui';
import { TaskKeyword } from '../../components/TaskKeyword';
import { Tooltip, InfoButton, AnimatedNumber } from '../../components/ui-extras';
import { useTasks, usePeople, useTaskActions } from '../../state/hooks';
import { createEmptyOrgFilter, hasOrgSelection } from '../../domain/organization/organizationHierarchy.js';
import { TaskOrganizationFilterControls } from '../tasks/TaskOrganizationFilterControls.jsx';
import { useSharedTaskOrganizationFilter } from '../tasks/TaskOrganizationFilterContext.jsx';
import { useTaskOrganizationFilter } from '../tasks/useTaskOrganizationFilter.js';
import { taskTableMatches } from '../tasks/taskTableFacets.js';

/* ── Kanban (drag-and-drop, animated) ──────────────── */
export function KanbanView() {
  const tasks = useTasks();
  const people = usePeople();
  const [search, setSearch] = useState2('');
  const { selection, setSelection } = useSharedTaskOrganizationFilter();
  const organization = useTaskOrganizationFilter(tasks, people, selection, setSelection);
  const filteredTasks = useMemo2(
    () => organization.filteredTasks.filter((task) => taskTableMatches(task, { search })),
    [organization.filteredTasks, search]
  );
  const hasFilters = Boolean(search) || hasOrgSelection(organization.selection);
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
  // Vurgu zamanlayıcısı tek bir referansta tutulur: art arda bırakmalarda
  // önceki zamanlayıcı iptal edilir ve bileşen sökülürse boşta kalmaz.
  const flashTimer = useRef2(null);
  useEffect2(() => () => clearTimeout(flashTimer.current), []);

  const grouped = useMemo2(() => {
    const map = { todo: [], in_progress: [], done: [] };
    filteredTasks.forEach(t => {
      // Panoda yalnızca üç sütun vardır. Kalıcı kayıttan gelen tanınmayan bir
      // durum (eski şema, dış aktarım) doğrudan indekslenirse `map[s]` tanımsız
      // olur ve sayfa tümüyle çökerdi; bilinmeyen durum "Yapılacak" sayılır.
      const status = Object.prototype.hasOwnProperty.call(map, t.status) ? t.status : 'todo';
      map[status].push(t);
    });
    return map;
  }, [filteredTasks]);

  const onDragStart = (id) => setDragId(id);
  const onDragEnd = () => { setDragId(null); setDragOver(null); };
  const onDropTo = (colId) => {
    if (!dragId) return;
    const id = dragId;
    // Aynı sütuna bırakmak bir DEĞİŞİKLİK değildir: yama gönderilirse sunucuya
    // boşuna yazma isteği gider ve kayıt sürümü sebepsiz ilerler.
    const current = filteredTasks.find((task) => task.id === id);
    const unchanged = current && (current.status || 'todo') === colId;
    setDragId(null);
    setDragOver(null);
    if (!current) return;
    if (unchanged) return;
    onUpdateTask(id, { status: colId });
    setFlashId(id);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), 700);
  };

  return (
    <div className="kanban-page col">
      <div className="row tasks-toolbar">
        <div className="topbar-search tasks-toolbar-search">
          <Icons.Search size={14} />
          <input aria-label="Kanban görevlerinde ara" placeholder="Görev, proje, sorumlu, etiket..." value={search} onChange={(event) => setSearch(event.target.value)} />
          {search && <button type="button" className="icon-btn" aria-label="Aramayı temizle" onClick={() => setSearch('')}><Icons.Close size={12} /></button>}
        </div>
        <TaskOrganizationFilterControls organization={organization} />
        {hasFilters && <button type="button" className="btn ghost sm" onClick={() => { setSearch(''); setSelection(createEmptyOrgFilter()); }}><Icons.Close size={12} /> Filtreleri temizle</button>}
        <span className="muted tabular kanban-filter-count" role="status">{filteredTasks.length} / {tasks.length} görev</span>
      </div>
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
                      {/* `sorumlu` her kayıtta dizi DEĞİLDİR (Gantt görünümü aynı alanı zaten
                          korumalı okur); korumasız `join`, sorumlusuz tek bir görev
                          yüzünden yalnızca o kartı değil BÜTÜN panoyu çizim hatasıyla
                          düşürüyordu. İsteğe bağlı zincir YALNIZCA null/undefined
                          durumunu karşılar: içe aktarılmış bir kayıtta metin ya da
                          nesne varsa `join` yine tanımsız olur ve aynı hatayı verir. */}
                      <div className="rt-row"><span className="rt-label">Sorumlu</span><span className="rt-val">{Array.isArray(t.sorumlu) ? t.sorumlu.join(', ') || '—' : '—'}</span></div>
                      <div className="rt-row"><span className="rt-label">Başlangıç</span><span className="rt-val">{fmt(t.plannedStart, 'dd MMM yyyy')}</span></div>
                      <div className="rt-row"><span className="rt-label">Bitiş</span><span className="rt-val">{fmt(t.plannedFinish, 'dd MMM yyyy')}</span></div>
                      <div className="rt-row"><span className="rt-label">Hedef</span><span className="rt-val" style={overdue ? { color: 'var(--status-overdue)' } : null}>{t.targetFinish ? fmt(t.targetFinish, 'dd MMM yyyy') : '—'}</span></div>
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
                    data-task-id={t.id}
                    draggable
                    style={{ borderLeft: `3px solid ${color}`, animationDelay: `${Math.min(i * 30, 240)}ms` }}
                    // Firefox, `dragstart` sırasında veri deposu boş kalırsa
                    // sürüklemeyi iptal eder ve kolon bırakma işleyicileri hiç
                    // çalışmaz; taşıma sessizce başarısız oluyordu.
                    onDragStart={(event) => {
                      event.dataTransfer?.setData?.('text/plain', String(t.id));
                      onDragStart(t.id);
                    }}
                    onDragEnd={onDragEnd}
                    onClick={() => onOpenTask(t)}
                    // Kart bir `div` olduğu için klavye ve ekran okuyucu
                    // kullanıcıları görev ayrıntısını hiç açamıyordu.
                    role="button"
                    tabIndex={0}
                    // YAKALAMA evresinde dinlenir. `Tooltip asChild`, çocuğu
                    // `React.cloneElement` ile kopyalar ve KENDİ `onKeyDown`
                    // işleyicisini (yalnızca Escape) çocuğun proplarından SONRA
                    // yayar; kabarcık evresindeki `onKeyDown` bu yüzden tamamen
                    // eziliyor ve odaklanmış kart Enter/Space ile açılmıyordu.
                    // Fare hâlâ çalıştığı için gerileme işaretçi kullanıcılarda
                    // görünmüyordu.
                    onKeyDownCapture={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      onOpenTask(t);
                    }}
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
                      <AvatarStack names={t.sorumlu} personIds={t.assigneeIds} people={t.assigneeAvatarIdentities} max={3} size="sm" />
                    </div>
                  </div>
                  </Tooltip>
                );
              })}
              {items.length === 0 && (
                <div className="empty" style={{ padding: 24, fontSize: 12 }}>{hasFilters ? 'Eşleşen görev bulunamadı.' : 'Buraya sürükle'}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
    </div>
  );
}
