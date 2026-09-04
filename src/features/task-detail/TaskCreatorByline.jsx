'use client';
import { Avatar } from '../../components/ui';

export function resolveTaskCreatorByline(task, people = [], fallback = null) {
  const sicilValue = task?.createdBySicil ?? fallback?.id ?? fallback?.employeeNo;
  const sicil = sicilValue == null ? null : String(sicilValue);
  const person = sicil ? people.find((item) => String(item.id) === sicil) : null;
  const name = person?.name
    || String(task?.createdByName || fallback?.name || '').trim()
    || (sicil ? 'Bilinmeyen kullanıcı' : null);
  const createdAtIso = task?.createdAt || fallback?.createdAt || null;
  const createdAt = createdAtIso ? new Date(createdAtIso) : null;
  const validDate = createdAt && Number.isFinite(createdAt.getTime());
  if (!name && !validDate) return null;
  return {
    sicil,
    name: name || 'Bilinmeyen kullanıcı',
    employeeNo: person?.employeeNo || fallback?.employeeNo || sicil,
    createdAtIso: validDate ? createdAt.toISOString() : null,
    createdAt: validDate
      ? createdAt.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' })
      : null,
    createdAtLong: validDate ? createdAt.toLocaleString('tr-TR') : null
  };
}

export function TaskCreatorByline({ task, people = [], fallback = null }) {
  const byline = resolveTaskCreatorByline(task, people, fallback);
  if (!byline) return null;
  return (
    <div className="task-byline" aria-label={`Görevi tanımlayan: ${byline.name}`}>
      <span className="task-byline-label">Görevi tanımlayan</span>
      <Avatar name={byline.name} personId={byline.sicil} employeeNo={byline.employeeNo} size="sm" />
      <span className="task-byline-text">
        <span className="task-byline-name">{byline.name}</span>
        {byline.createdAt && (
          <>
            <span className="task-byline-sep">·</span>
            <time dateTime={byline.createdAtIso} title={byline.createdAtLong}>{byline.createdAt}</time>
          </>
        )}
      </span>
    </div>
  );
}
