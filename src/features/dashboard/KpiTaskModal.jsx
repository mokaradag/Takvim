'use client';
import { useMemo, useRef, useState } from 'react';
import { FilterableTH } from '../../components/ui-extras.jsx';
import { DateFilterableTH } from '../../components/DateFilterableTH.jsx';
import { TASK_STATUS_FILTER_OPTIONS } from '../../domain/constants/index.js';
import { createEmptyOrgFilter } from '../../domain/organization/organizationHierarchy.js';
import { useTaskOrganizationFilter } from '../tasks/useTaskOrganizationFilter.js';
import { TaskOrganizationFilterControls } from '../tasks/TaskOrganizationFilterControls.jsx';
import { taskTableMatches, taskTableFacetValues } from '../tasks/taskTableFacets.js';
import { effectiveTaskDate } from '../tasks/taskDisplayValues.js';
import { getStatus } from '../../scheduling/metrics/index.js';
import { today } from '../../scheduling/dates/index.js';
import { Icons } from '../../components/icons.jsx';
import { StatusPill, AvatarStack } from '../../components/ui.jsx';
import { useModalFocusTrap } from '../../hooks/useModalFocusTrap.js';
import { TaskDate } from '../tasks/TaskDate.jsx';
import { TaskTablePagination, useTaskTablePagination } from '../tasks/TaskTablePagination.jsx';
import { useSelectedTask, useAllPeople } from '../../state/hooks/index.js';

export function filterKpiTasks(tasks, { search = '', project = '', assignee = '', filters = {} }, referenceDay = today()) {
  return tasks.filter((task) => (!project || String(task.projectId) === project)
    && (!assignee || (task.assigneeIds || []).map(String).includes(assignee))
    && taskTableMatches(task, { search, filters, dateMode: 'effective' }, null, referenceDay));
}

export function KpiTaskModal({ title, tasks, onClose, onOpenTask, restoreFocusRef, referenceDay = today() }) {
  const [filters, setFilters] = useState({ search: '', project: '', assignee: '' });
  const [columns, setColumns] = useState({});
  const [organizationSelection, setOrganizationSelection] = useState(createEmptyOrgFilter);
  const [sort, setSort] = useState({ key: '', dir: 'asc' });
  const [error, setError] = useState(null);
  const selectedTask = useSelectedTask();
  const directory = useAllPeople();
  const organization = useTaskOrganizationFilter(tasks, directory, organizationSelection, setOrganizationSelection);
  const dialogRef = useRef(null);
  const searchRef = useRef(null);
  useModalFocusTrap({ containerRef: dialogRef, initialFocusRef: searchRef, restoreFocusRef, onClose, enabled: !selectedTask });
  const projects = useMemo(() => [...new Map(tasks.map((task) => [String(task.projectId), task.proje || task.projectCode])).entries()], [tasks]);
  const people = useMemo(() => {
    const found = new Map();
    const byId = new Map(directory.map((person) => [String(person.id), person]));
    for (const task of tasks) for (const id of task.assigneeIds || []) {
      const person = byId.get(String(id));
      const identity = task.assigneeAvatarIdentities?.find((candidate) => String(candidate.employeeNo) === String(id));
      found.set(String(id), person?.name || identity?.name || String(id));
    }
    return [...found.entries()];
  }, [tasks, directory]);
  const candidates = useMemo(() => filterKpiTasks(organization.filteredTasks, filters, referenceDay), [organization.filteredTasks, filters, referenceDay]);
  const facets = useMemo(() => {
    const state = { filters: columns, dateMode: 'effective' };
    return Object.fromEntries(['proje', 'sorumlu', 'status'].map((key) => [key,
      taskTableFacetValues(candidates, state, key, referenceDay)
    ]));
  }, [candidates, columns, referenceDay]);
  const projectOptions = projects.filter(([id]) => facets.proje.has(id)).map(([id, label]) => ({ value: id, label }));
  const assigneeOptions = people.filter(([id]) => facets.sorumlu.has(id)).map(([id, name]) => ({ value: id, label: `${name} · ${id}` }));
  const statusOptions = TASK_STATUS_FILTER_OPTIONS.filter((option) => facets.status.has(option.value));
  const filtered = useMemo(() => {
    const result = filterKpiTasks(candidates, { filters: columns }, referenceDay);
    if (!sort.key) return result;
    const value = (task) => {
      if (sort.key === 'sorumlu') return (task.sorumlu || []).join(', ');
      if (sort.key === 'status') return getStatus(task, referenceDay).label;
      return effectiveTaskDate(task, sort.key);
    };
    return result.sort((left, right) => {
      const a = value(left), b = value(right);
      if (a == null || a === '') return b == null || b === '' ? 0 : 1;
      if (b == null || b === '') return -1;
      return String(a).localeCompare(String(b), 'tr') * (sort.dir === 'desc' ? -1 : 1);
    });
  }, [candidates, columns, referenceDay, sort]);
  const paged = useTaskTablePagination(filtered, JSON.stringify([filters, columns, organization.selection, sort]));
  const change = (key, value) => setFilters((current) => ({ ...current, [key]: value }));
  const columnProps = (key) => ({
    sortKey: sort.key === key ? sort.dir : null,
    onSort: (dir) => setSort({ key, dir }),
    filter: columns[key],
    onFilter: (value) => setColumns((current) => ({ ...current, [key]: value }))
  });
  const clearFilters = () => {
    setFilters({ search: '', project: '', assignee: '' });
    setColumns({});
    setOrganizationSelection(createEmptyOrgFilter());
  };
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
      <div className="kpi-organization-filters">
        <TaskOrganizationFilterControls organization={organization} />
        <button type="button" className="btn ghost sm" onClick={clearFilters}><Icons.Close size={12} /> Filtreleri Temizle</button>
      </div>
      {error && <p role="alert" className="schedule-modal-error">{error}</p>}
      <div className="detail-list-scroll">
        <table className="table detail-list-table">
          <caption className="sr-only">{title} görevleri</caption>
          <thead><tr>
            <FilterableTH label="Görev" {...columnProps('task')} filterType="text" />
            <FilterableTH label="Proje" {...columnProps('proje')} filterType="multi" filterOptions={projectOptions} />
            <FilterableTH label="Sorumlu" {...columnProps('sorumlu')} filterType="multi" filterOptions={assigneeOptions} />
            <FilterableTH label="Durum" {...columnProps('status')} filterType="multi" filterOptions={statusOptions} />
            <DateFilterableTH label="Başlangıç" {...columnProps('plannedStart')} />
            <DateFilterableTH label="Bitiş" {...columnProps('plannedFinish')} />
            <DateFilterableTH label="Hedef" {...columnProps('targetFinish')} />
          </tr></thead>
          <tbody>{paged.rows.map((task) => <tr key={task.id}>
            <td><button type="button" className="detail-task-link" onClick={async () => {
              setError(null);
              try { const result = await onOpenTask(task); if (result?.ok === false) setError(result.error?.message || 'Görev açılamadı.'); }
              catch (openError) { setError(openError.message || 'Görev açılamadı.'); }
            }}>{task.task}</button></td>
            <td>{task.proje || task.projectCode}</td>
            <td><AvatarStack names={task.sorumlu || []} personIds={task.assigneeIds} people={task.assigneeAvatarIdentities} max={3} /><span className="detail-assignee-names">{(task.sorumlu || []).join(', ') || '—'}</span></td>
            <td><StatusPill task={task} /></td>
            {['plannedStart', 'plannedFinish', 'targetFinish'].map((field) => <td key={field} className="tabular"><TaskDate task={task} field={field} /></td>)}
          </tr>)}</tbody>
        </table>
        {!filtered.length && <p className="empty">Bu filtrelerle eşleşen görev yok.</p>}
      </div>
      <TaskTablePagination {...paged} showDateLegend />
    </section>
  </div>;
}
