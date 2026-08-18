'use client';
import { useEffect, useMemo, useRef } from 'react';
import { Icons } from '../../components/icons';
import { Avatar, StatusPill } from '../../components/ui';
import { PRIORITIES, resolvePriority } from '../../domain/constants/index.js';
import { projectColorVar } from '../../lib/colors';
import { fmt, today } from '../../scheduling/dates';
import { organizationValue } from './teamDirectoryPolicy.js';
import { dueTone } from './upcomingTaskPolicy.js';

/**
 * Personel ayrıntı penceresi.
 *
 * Ekip tablosunda bir satır yalnızca ilk iki görevi gösterebiliyordu; kişinin
 * gerçek yükünü görmek için başka bir sayfaya gitmek gerekiyordu. Bu pencere
 * kişinin kurumsal kimliğini, yük özetini ve YAKIN GÖREVLERİNİ tek yerde verir.
 *
 * Liste `open` görevlerle sınırlıdır: tamamlanmış işler "yaklaşan" değildir ve
 * listeyi kişinin bugün ne yapacağına dair bir araç olmaktan çıkarırdı.
 */

function Metric({ label, value, tone, hint }) {
  return (
    <div className="person-metric" title={hint}>
      <span className="person-metric-value" style={tone ? { color: tone } : null}>{value}</span>
      <span className="person-metric-label">{label}</span>
    </div>
  );
}

function IdentityRow({ label, value }) {
  if (!value) return null;
  return (
    <div className="person-identity-row">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

export function PersonDetailDialog({ member, onClose, onOpenTask }) {
  const closeRef = useRef(null);
  const today_ = today();

  // Kapatma her zaman erişilebilir olmalıdır: odak açılışta kapatma düğmesine
  // taşınır, Esc pencereyi kapatır.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const person = member?.person || null;
  const openTasks = useMemo(
    () => (member?.tasks || []).filter((task) => task.status !== 'done'),
    [member]
  );
  const priorityBreakdown = useMemo(() => {
    const counts = new Map(Object.keys(PRIORITIES).map((id) => [id, 0]));
    for (const task of openTasks) counts.set(resolvePriority(task.priority).id, (counts.get(resolvePriority(task.priority).id) || 0) + 1);
    return Object.values(PRIORITIES)
      .map((priority) => ({ ...priority, count: counts.get(priority.id) || 0 }))
      .filter((entry) => entry.count > 0);
  }, [openTasks]);

  if (!person) return null;

  const organization = [
    organizationValue(person, 'directorate'),
    organizationValue(person, 'department'),
    organizationValue(person, 'unit') || person.team
  ].filter(Boolean);

  return (
    <div className="person-dialog-backdrop" role="presentation" onClick={onClose}>
      <section
        className="person-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="person-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="person-dialog-head">
          <span className="person-dialog-glow" aria-hidden="true" />
          <Avatar name={person.name} person={person} size="xl" />
          <div className="person-dialog-identity">
            <h2 id="person-dialog-title">{person.name}</h2>
            <span className="person-dialog-role">{person.role || 'Unvan tanımlı değil'}</span>
            {organization.length > 0 && (
              <span className="person-dialog-org">{organization.join(' › ')}</span>
            )}
          </div>
          <button ref={closeRef} type="button" className="icon-btn person-dialog-close" onClick={onClose} aria-label="Kapat">
            <Icons.Close size={15} />
          </button>
        </header>

        <div className="person-dialog-body">
          <div className="person-metrics">
            <Metric label="Toplam görev" value={member.total} hint="Kişiye atanmış tüm görevler" />
            <Metric label="Açık" value={member.total - member.done} hint="Tamamlanmamış görevler" />
            <Metric label="Devam eden" value={member.active} tone="var(--status-progress)" hint="Üzerinde çalışılan görevler" />
            <Metric label="Tamamlanan" value={member.done} tone="var(--status-done)" hint="Tamamlanmış görevler" />
            <Metric label="Geciken" value={member.late} tone={member.late > 0 ? 'var(--status-overdue)' : undefined} hint="Hedef tarihi geçmiş görevler" />
          </div>

          <div className="person-dialog-details">
            <IdentityRow label="Sicil" value={person.employeeNo || person.id} />
            <IdentityRow label="Kullanıcı" value={person.username} />
            <IdentityRow label="Sektör" value={organizationValue(person, 'sector')} />
          </div>

          {priorityBreakdown.length > 0 && (
            <div className="person-priority-row">
              {priorityBreakdown.map((entry) => (
                <span key={entry.id} className="person-priority-chip" style={{ '--priority-color': entry.color }}>
                  <Icons.Flag size={11} /> {entry.label} · <strong>{entry.count}</strong>
                </span>
              ))}
            </div>
          )}

          <div className="person-tasks">
            <div className="person-tasks-head">
              <Icons.Clock size={13} />
              <span>Yakın görevler</span>
              <span className="person-tasks-count">{openTasks.length}</span>
            </div>

            {openTasks.length === 0 ? (
              <div className="person-tasks-empty">
                <Icons.Check size={16} />
                <span>Açık görev yok.</span>
              </div>
            ) : (
              <ul className="person-task-list">
                {openTasks.map((task) => {
                  const due = dueTone(task, today_);
                  const priority = resolvePriority(task.priority);
                  return (
                    <li key={task.id}>
                      <button type="button" className="person-task-item" onClick={() => onOpenTask?.(task)}>
                        <span className="person-task-bar" style={{ background: projectColorVar(task.proje) }} />
                        <span className="person-task-main">
                          <span className="person-task-title">{task.task}</span>
                          <span className="person-task-meta">
                            <span>{task.proje || 'Proje yok'}</span>
                            <span className="person-task-dot">·</span>
                            <span style={{ color: priority.color }}>{priority.label}</span>
                            {task.progress > 0 && (
                              <>
                                <span className="person-task-dot">·</span>
                                <span>%{task.progress}</span>
                              </>
                            )}
                          </span>
                        </span>
                        <span className="person-task-due">
                          <span className="person-task-due-days" style={{ color: due.tone.color }}>{due.text}</span>
                          <span className="person-task-due-date">{due.due ? fmt(due.due, 'dd MMM yyyy') : '—'}</span>
                        </span>
                        <StatusPill task={task} size={10} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
