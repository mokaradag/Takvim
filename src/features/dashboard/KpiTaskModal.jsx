'use client';
import { useMemo, useRef, useState } from 'react';
import { FilterableTH } from '../../components/ui-extras.jsx';
import { DateFilterableTH } from '../../components/DateFilterableTH.jsx';
import {
  TASK_PRIORITY_FILTER_OPTIONS,
  TASK_STATUS_FILTER_OPTIONS,
  resolvePriority
} from '../../domain/constants/index.js';
import { createEmptyOrgFilter } from '../../domain/organization/organizationHierarchy.js';
import { useTaskOrganizationFilter } from '../tasks/useTaskOrganizationFilter.js';
import { TaskOrganizationFilterControls } from '../tasks/TaskOrganizationFilterControls.jsx';
import { taskTableMatches, taskTableFacetValues } from '../tasks/taskTableFacets.js';
import { taskSortValue } from '../tasks/taskDisplayValues.js';
import { getStatus } from '../../scheduling/metrics/index.js';
import { today } from '../../scheduling/dates/index.js';
import { Icons } from '../../components/icons.jsx';
import { StatusPill, AvatarStack } from '../../components/ui.jsx';
import { useModalFocusTrap } from '../../hooks/useModalFocusTrap.js';
import { TaskDate } from '../tasks/TaskDate.jsx';
import { TaskTablePagination, useTaskTablePagination } from '../tasks/TaskTablePagination.jsx';
import { useSelectedTask, useAllPeople } from '../../state/hooks/index.js';
import { resolveDashboardVariant } from './dashboardVariant.js';

export function filterKpiTasks(tasks, { search = '', project = '', assignee = '', filters = {}, dateMode = 'effective' }, referenceDay = today()) {
  return tasks.filter((task) => (!project || String(task.projectId) === project)
    && (!assignee || (task.assigneeIds || []).map(String).includes(assignee))
    && taskTableMatches(task, { search, filters, dateMode }, null, referenceDay));
}

export function KpiTaskModal({ title, tasks, onClose, onOpenTask, restoreFocusRef, referenceDay = today(), variant = 'advanced' }) {
  const profile = resolveDashboardVariant(variant);
  const tableColumns = profile.kpiColumns;
  const [filters, setFilters] = useState({ search: '', project: '', assignee: '' });
  const [columnFilters, setColumnFilters] = useState({});
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
  const candidates = useMemo(
    () => filterKpiTasks(organization.filteredTasks, { ...filters, dateMode: profile.kpiDateMode }, referenceDay),
    [organization.filteredTasks, filters, profile.kpiDateMode, referenceDay]
  );
  const facetKeys = useMemo(
    () => tableColumns.filter((column) => column.filterType === 'multi').map((column) => column.key),
    [tableColumns]
  );
  const facets = useMemo(() => {
    const state = { filters: columnFilters, dateMode: profile.kpiDateMode };
    return Object.fromEntries(facetKeys.map((key) => [key,
      taskTableFacetValues(candidates, state, key, referenceDay)
    ]));
  }, [candidates, columnFilters, facetKeys, profile.kpiDateMode, referenceDay]);
  const filterOptions = (key) => {
    if (key === 'proje') return projects.filter(([id]) => facets.proje.has(id)).map(([id, label]) => ({ value: id, label }));
    if (key === 'sorumlu') return people.filter(([id]) => facets.sorumlu.has(id)).map(([id, name]) => ({ value: id, label: `${name} · ${id}` }));
    if (key === 'status') return TASK_STATUS_FILTER_OPTIONS.filter((option) => facets.status.has(option.value));
    if (key === 'priority') return TASK_PRIORITY_FILTER_OPTIONS
      .filter((priority) => facets.priority.has(priority.id))
      .map((priority) => ({ value: priority.id, label: priority.label }));
    if (key === 'keyword') return [...facets.keyword]
      .sort((left, right) => left.localeCompare(right, 'tr'))
      .map((value) => ({ value, label: value }));
    return [];
  };
  const filtered = useMemo(() => {
    const result = filterKpiTasks(candidates, { filters: columnFilters, dateMode: profile.kpiDateMode }, referenceDay);
    if (!sort.key) return result;
    const value = (task) => {
      if (sort.key === 'sorumlu') return (task.sorumlu || []).join(', ');
      if (sort.key === 'status') return getStatus(task, referenceDay).label;
      if (sort.key === 'priority') return resolvePriority(task.priority).order;
      return taskSortValue(task, sort.key, profile.kpiDateMode);
    };
    return result.sort((left, right) => {
      const a = value(left), b = value(right);
      if (a == null || a === '') return b == null || b === '' ? 0 : 1;
      if (b == null || b === '') return -1;
      const delta = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'tr');
      return delta * (sort.dir === 'desc' ? -1 : 1);
    });
  }, [candidates, columnFilters, profile.kpiDateMode, referenceDay, sort]);
  const paged = useTaskTablePagination(filtered, JSON.stringify([filters, columnFilters, organization.selection, sort]));
  const change = (key, value) => setFilters((current) => ({ ...current, [key]: value }));
  const columnProps = (key) => ({
    sortKey: sort.key === key ? sort.dir : null,
    onSort: (dir) => setSort({ key, dir }),
    filter: columnFilters[key],
    onFilter: (value) => setColumnFilters((current) => ({ ...current, [key]: value }))
  });
  const clearFilters = () => {
    setFilters({ search: '', project: '', assignee: '' });
    setColumnFilters({});
    setOrganizationSelection(createEmptyOrgFilter());
  };
  const openTask = async (task) => {
    setError(null);
    try { const result = await onOpenTask(task); if (result?.ok === false) setError(result.error?.message || 'Görev açılamadı.'); }
    catch (openError) { setError(openError.message || 'Görev açılamadı.'); }
  };
  const cell = (key, task) => {
    if (key === 'task') return <button type="button" className="detail-task-link" onClick={() => openTask(task)}>{task.task}</button>;
    if (key === 'proje') return task.proje || task.projectCode;
    if (key === 'keyword') return <span className="muted">{task.keyword || '—'}</span>;
    if (key === 'sorumlu') return <><AvatarStack names={task.sorumlu || []} personIds={task.assigneeIds} people={task.assigneeAvatarIdentities} max={3} /><span className="detail-assignee-names">{(task.sorumlu || []).join(', ') || '—'}</span></>;
    if (key === 'priority') {
      const priority = resolvePriority(task.priority);
      return <span className="simple-tasks-priority" style={{ color: priority.color }}><Icons.Flag size={11} /> {priority.label}</span>;
    }
    if (key === 'status') return <StatusPill task={task} />;
    return <TaskDate task={task} field={key} />;
  };
  return <div className="schedule-modal-layer kpi-modal-layer" hidden={Boolean(selectedTask)}>
    <button type="button" className="schedule-modal-backdrop" aria-label="Görev listesini kapat" onClick={onClose} />
    <section ref={dialogRef} className="schedule-modal kpi-task-modal" role="dialog" aria-modal="true" aria-labelledby="kpi-task-title" tabIndex={-1}>
      <header className="schedule-modal-head">
        <div><h2 id="kpi-task-title">{title}</h2><p>{tasks.length} görev · {filtered.length} eşleşme</p></div>
        <button type="button" className="icon-btn" aria-label="Kapat" onClick={onClose}><Icons.Close size={15} /></button>
      </header>
      <div className="detail-list-filters">
        <label><span>Görev ara</span><input ref={searchRef} className="input" type="search" value={filters.search} onChange={(event) => change('search', event.target.value)} placeholder={profile.kpiSearchPlaceholder} /></label>
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
            {tableColumns.map((column) => (column.filterType === 'date'
              ? <DateFilterableTH key={column.key} label={column.label} {...columnProps(column.key)} />
              : <FilterableTH key={column.key} label={column.label} {...columnProps(column.key)}
                  filterType={column.filterType} filterOptions={column.filterType === 'multi' ? filterOptions(column.key) : undefined} />))}
          </tr></thead>
          <tbody>{paged.rows.map((task) => <tr key={task.id}>
            {tableColumns.map((column) => <td key={column.key} className={column.filterType === 'date' ? 'tabular' : undefined}>{cell(column.key, task)}</td>)}
          </tr>)}</tbody>
        </table>
        {!filtered.length && <p className="empty">Bu filtrelerle eşleşen görev yok.</p>}
      </div>
      <TaskTablePagination {...paged} showDateLegend={profile.kpiDateLegend} />
    </section>
  </div>;
}
