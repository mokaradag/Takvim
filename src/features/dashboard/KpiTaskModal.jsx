'use client';
import { useMemo, useRef, useState } from 'react';
import { Icons } from '../../components/icons.jsx';
import { StatusPill, AvatarStack } from '../../components/ui.jsx';
import { useModalFocusTrap } from '../../hooks/useModalFocusTrap.js';
import { TaskDate } from '../tasks/TaskDate.jsx';
import { TaskTablePagination, useTaskTablePagination } from '../tasks/TaskTablePagination.jsx';
import { useSelectedTask, useAllPeople } from '../../state/hooks/index.js';

export function filterKpiTasks(tasks, { search = '', project = '', assignee = '' }) {
  const query = search.trim().toLocaleLowerCase('tr-TR');
  return tasks.filter((task) => (!project || String(task.projectId) === project)
    && (!assignee || (task.assigneeIds || []).map(String).includes(assignee))
    && (!query || [task.task, task.proje, task.projectCode, ...(task.sorumlu || [])]
      .some((value) => String(value || '').toLocaleLowerCase('tr-TR').includes(query))));
}

export function KpiTaskModal({ title, tasks, onClose, onOpenTask, restoreFocusRef }) {
  const [filters, setFilters] = useState({ search: '', project: '', assignee: '' });
  const [error, setError] = useState(null);
  const selectedTask = useSelectedTask();
  const directory = useAllPeople();
  const dialogRef = useRef(null);
  const searchRef = useRef(null);
  useModalFocusTrap({ containerRef: dialogRef, initialFocusRef: searchRef, restoreFocusRef, onClose, enabled: !selectedTask });
  const projects = useMemo(() => [...new Map(tasks.map((task) => [String(task.projectId), task.proje || task.projectCode])).entries()], [tasks]);
  const people = useMemo(() => {
    const found = new Map();
    for (const task of tasks) for (const id of task.assigneeIds || []) {
      const person = directory.find((candidate) => String(candidate.id) === String(id));
      const identity = task.assigneeAvatarIdentities?.find((candidate) => String(candidate.employeeNo) === String(id));
      found.set(String(id), person?.name || identity?.name || String(id));
    }
    return [...found.entries()];
  }, [tasks, directory]);
  const filtered = useMemo(() => filterKpiTasks(tasks, filters), [tasks, filters]);
  const paged = useTaskTablePagination(filtered, JSON.stringify(filters));
  const change = (key, value) => setFilters((current) => ({ ...current, [key]: value }));
  return <div className="schedule-modal-layer kpi-modal-layer" hidden={Boolean(selectedTask)}>
    <button type="button" className="schedule-modal-backdrop" aria-label="Görev listesini kapat" onClick={onClose} />
    <section ref={dialogRef} className="schedule-modal kpi-task-modal" role="dialog" aria-modal="true" aria-labelledby="kpi-task-title" tabIndex={-1}>
      <header className="schedule-modal-head">
        <div><h2 id="kpi-task-title">{title}</h2><p>{tasks.length} görev · {filtered.length} eşleşme</p></div>
        <button type="button" className="icon-btn" aria-label="Kapat" onClick={onClose}><Icons.Close size={15} /></button>
      </header>
      <div className="detail-list-filters">
        <label><span>Görev ara</span><input ref={searchRef} className="input" type="search" value={filters.search} onChange={(event) => change('search', event.target.value)} placeholder="Görev, proje veya sorumlu…" /></label>
        <label><span>Proje</span><select className="input" value={filters.project} onChange={(event) => change('project', event.target.value)}><option value="">Tüm projeler</option>{projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label><span>Sorumlu</span><select className="input" value={filters.assignee} onChange={(event) => change('assignee', event.target.value)}><option value="">Tüm sorumlular</option>{people.map(([id, name]) => <option key={id} value={id}>{name} · {id}</option>)}</select></label>
      </div>
      {error && <p role="alert" className="schedule-modal-error">{error}</p>}
      <div className="detail-list-scroll">
        <table className="table detail-list-table">
          <caption className="sr-only">{title} görevleri</caption>
          <thead><tr>{['Görev', 'Proje', 'Sorumlu', 'Durum', 'Başlangıç', 'Bitiş', 'Hedef'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{paged.rows.map((task) => <tr key={task.id}>
            <td><button type="button" className="detail-task-link" onClick={async () => {
              setError(null);
              try { const result = await onOpenTask(task); if (result?.ok === false) setError(result.error?.message || 'Görev açılamadı.'); }
              catch (openError) { setError(openError.message || 'Görev açılamadı.'); }
            }}>{task.task}</button></td>
            <td>{task.proje || task.projectCode}</td>
            <td><AvatarStack names={task.sorumlu || []} personIds={task.assigneeIds} max={3} /><span className="detail-assignee-names">{(task.sorumlu || []).join(', ') || '—'}</span></td>
            <td><StatusPill task={task} /></td>
            {['plannedStart', 'plannedFinish', 'targetFinish'].map((field) => <td key={field} className="tabular"><TaskDate task={task} field={field} /></td>)}
          </tr>)}</tbody>
        </table>
        {!filtered.length && <p className="empty">Bu filtrelerle eşleşen görev yok.</p>}
      </div>
      <TaskTablePagination {...paged} />
    </section>
  </div>;
}
