'use client';
import { Icons } from '../../components/icons';
import { fmt } from '../../scheduling/dates';
import { projectColorVar } from '../../lib/colors';
import { AvatarStack, StatusPill } from '../../components/ui';
import { TaskKeyword } from '../../components/TaskKeyword';
import { taskAssigneeDisplayNames } from './taskAssigneeDisplay.js';

function valueOrDash(value) {
  return value == null || value === '' ? '—' : value;
}

function ReadOnlyField({ label, value }) {
  return (
    <div className="col" style={{ gap: 5 }}>
      <div className="label">{label}</div>
      <div className="input" style={{ background: 'var(--bg-elev-2)', color: 'var(--text-muted)' }}>{valueOrDash(value)}</div>
    </div>
  );
}

export function ReadOnlyTaskDrawer({ task, onClose }) {
  const color = projectColorVar(task.proje);
  const assigneeNames = taskAssigneeDisplayNames(task);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer" aria-readonly="true">
        <div className="drawer-head">
          <div className="col" style={{ gap: 8, flex: 1 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: color }} />
              <span className="muted" style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '0.01em' }}>
                {task.projectCode ? `${task.projectCode} · ${task.proje}` : task.proje}
              </span>
              {task.keyword && <TaskKeyword task={task} />}
              <span className="badge">Salt okunur</span>
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.35 }}>{task.task}</div>
          </div>
          <button className="icon-btn" onClick={onClose} title="Kapat (Esc)"><Icons.Close size={16} /></button>
        </div>

        <div className="drawer-body">
          <div className="col" style={{ gap: 18 }}>
            <div className="card" style={{ padding: 12 }}>
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.55 }}>
                Bu görev PARTIAL veya READ proje görünürlüğüyle açıldı. Ayrıntıları görüntüleyebilirsiniz; değişiklik yapmak için tam proje yazma yetkisi gerekir.
              </div>
            </div>

            <div className="col" style={{ gap: 8 }}>
              <div className="label">Durum</div>
              <StatusPill task={task} />
            </div>

            <div className="col" style={{ gap: 8 }}>
              <div className="label">Sorumlular</div>
              {assigneeNames.length
                ? <AvatarStack names={assigneeNames} personIds={task.assigneeIds} max={8} size="sm" />
                : <span className="muted">Sorumlu tanımlanmamış.</span>}
            </div>

            <div className="task-date-grid">
              <ReadOnlyField label="Planlanan Başlangıç" value={fmt(task.plannedStart)} />
              <ReadOnlyField label="Planlanan Bitiş" value={fmt(task.plannedFinish)} />
              <ReadOnlyField label="Hedef Bitiş" value={fmt(task.targetFinish)} />
            </div>

            <div className="task-date-grid">
              <ReadOnlyField label="Gerçekleşen Başlangıç" value={fmt(task.actualStart)} />
              <ReadOnlyField label="Gerçekleşen Bitiş" value={fmt(task.actualFinish)} />
              <ReadOnlyField label="İlerleme" value={`${Number(task.progress || 0)}%`} />
            </div>

            <div className="col" style={{ gap: 6 }}>
              <div className="label">Notlar</div>
              <div className="input" style={{ minHeight: 90, whiteSpace: 'pre-wrap', background: 'var(--bg-elev-2)', color: 'var(--text-muted)' }}>
                {valueOrDash(task.description)}
              </div>
            </div>
          </div>
        </div>

        <div className="drawer-foot">
          <span className="muted" style={{ fontSize: 12 }}>Salt okunur görev görünümü</span>
          <div style={{ flex: 1 }} />
          <button className="btn primary" onClick={onClose}>Kapat</button>
        </div>
      </div>
    </>
  );
}
