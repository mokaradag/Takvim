'use client';
import { useMemo, useState } from 'react';
import { DateFilterableTH } from '../../components/DateFilterableTH';
import { Icons } from '../../components/icons';
import { Avatar, AvatarStack, PriorityIcon, StatusIcon, StatusPill } from '../../components/ui';
import { FilterableTH, InfoButton } from '../../components/ui-extras';
import { TaskReminderButton } from '../reminders/TaskReminderButton';
import {
  TASK_PRIORITY_FILTER_OPTIONS,
  TASK_STATUS_FILTER_OPTIONS,
  normalizePriorityId,
  resolvePriority
} from '../../domain/constants';
import { projectColorVar } from '../../lib/colors';
import { diffDays, fmt, today } from '../../scheduling/dates';
import { useAppState } from '../../state/AppStateProvider';
import { canResolveTaskAssignee } from '../../state/appState';
import { canDeleteTask } from '../../state/projectWritePolicy.js';
import { usePeople, useProjects, useTaskActions, useTaskAssignableProjects, useTasks } from '../../state/hooks';
import { createEmptySimpleTaskFilterState, SIMPLE_TASK_COLUMNS } from './simpleTaskColumns.js';
import { SIMPLE_TASK_FACET_KEYS, simpleTaskFacetValues, simpleTaskMatches } from './simpleTaskFacets.js';

/**
 * Basit Mod · Görevler.
 *
 * Gelişmiş Modun tam tablosu BİLİNÇLİ OLARAK gösterilmez. Basit Mod kullanıcısı
 * görevini "Hızlı Görev Tanımı" ile açar: proje, görev, kısa açıklama, sorumlu,
 * termin ve öncelik. Tablo aynı alanları listeler; ilerleme yüzdesi,
 * planlanan başlangıç/bitiş, dağılım ağacı ve bağımlılıklar gibi
 * Basit Modda hiç toplanmayan sütunlar dışarıda kalır (bkz. simpleTaskColumns.js).
 *
 * Gelişmiş Mod tablosu (TasksView) değişmeden durur.
 */
function projectLabel(project) {
  if (!project) return '';
  return project.code ? `${project.code} · ${project.name}` : project.name;
}

export function SimpleTasksView({ onNewTask }) {
  const tasks = useTasks();
  const projects = useProjects();
  const people = usePeople();
  const assignableProjects = useTaskAssignableProjects();
  const appState = useAppState();
  const { openTask, deleteTask } = useTaskActions();
  const initialFilterState = useMemo(() => createEmptySimpleTaskFilterState(), []);
  const [search, setSearch] = useState(initialFilterState.search);
  const [filters, setFilters] = useState(initialFilterState.filters);
  const [sort, setSort] = useState({ key: 'targetFinish', dir: 'asc' });

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const taskMutationState = useMemo(
    () => ({ tasks, projects, assignableProjects }),
    [tasks, projects, assignableProjects]
  );
  const canAddTask = assignableProjects.some((project) => canResolveTaskAssignee(appState, project));
  const peopleById = useMemo(() => new Map(people.map((person) => [String(person.id), person])), [people]);
  const facetValues = useMemo(() => Object.fromEntries(SIMPLE_TASK_FACET_KEYS.map((key) => [
    key,
    simpleTaskFacetValues(tasks, { search, filters }, key)
  ])), [tasks, search, filters]);
  const projectOptions = useMemo(() => projects
    .filter((project) => facetValues.proje.has(project.id))
    .slice()
    .sort((a, b) => projectLabel(a).localeCompare(projectLabel(b), 'tr'))
    .map((project) => ({ value: project.id, label: projectLabel(project), keywords: [project.code, project.name] })),
  [projects, facetValues]);
  const keywordOptions = useMemo(() => [...facetValues.keyword]
    .sort((a, b) => a.localeCompare(b, 'tr')).map((value) => ({ value, label: value })), [facetValues]);
  const assigneeOptions = useMemo(() => people
    .filter((person) => facetValues.sorumlu.has(String(person.id)))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'tr')).map((person) => ({
    value: String(person.id),
    label: person.employeeNo ? `${person.employeeNo} · ${person.name}` : person.name,
    keywords: [person.name, person.employeeNo, person.role, person.team],
    icon: <Avatar name={person.name} person={person} size="sm" />
  })), [people, facetValues]);
  const priorityOptions = TASK_PRIORITY_FILTER_OPTIONS
    .filter((priority) => facetValues.priority.has(priority.id))
    .map((priority) => ({
      value: priority.id,
      label: priority.label,
      icon: <PriorityIcon color={priority.color} size={11} />
    }));
  const statusOptions = TASK_STATUS_FILTER_OPTIONS
    .filter((status) => facetValues.status.has(status.value))
    .map((status) => ({
      ...status,
      icon: <StatusIcon id={status.value} size={11} />
    }));
  const setFilter = (key, value) => setFilters((current) => ({ ...current, [key]: value }));

  const visible = useMemo(() => {
    const filtered = tasks.filter((task) => simpleTaskMatches(task, { search, filters }));

    return filtered.sort((left, right) => {
      let a = left[sort.key];
      let b = right[sort.key];
      if (sort.key === 'priority') { a = resolvePriority(left.priority).order; b = resolvePriority(right.priority).order; }
      if (sort.key === 'sorumlu') { a = left.sorumlu?.[0] || ''; b = right.sorumlu?.[0] || ''; }
      if (sort.key === 'proje') { a = projectLabel(projectById.get(left.projectId)); b = projectLabel(projectById.get(right.projectId)); }
      if (a == null || a === '') return b == null || b === '' ? 0 : 1;
      if (b == null || b === '') return -1;
      const delta = typeof a === 'number' ? a - b : String(a).localeCompare(String(b), 'tr');
      return sort.dir === 'asc' ? delta : -delta;
    });
  }, [tasks, search, filters, sort, projectById]);

  const hasFilters = Boolean(search || Object.values(filters).some((value) => Array.isArray(value) ? value.length : value));
  const clearFilters = () => {
    const empty = createEmptySimpleTaskFilterState();
    setSearch(empty.search);
    setFilters(empty.filters);
  };
  const setSortFor = (key) => (dir) => setSort({ key, dir });
  const sortFor = (key) => sort.key === key ? sort.dir : null;

  return (
    <div className="simple-tasks-page col">
      <div className="simple-tasks-toolbar">
        <div className="topbar-search simple-tasks-search">
          <Icons.Search size={14} />
          <input
            placeholder="Görev, proje, sorumlu veya kısa açıklama ara"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Görev ara"
          />
          {search && (
            <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => setSearch('')} aria-label="Aramayı temizle">
              <Icons.Close size={12} />
            </button>
          )}
        </div>

        {hasFilters && <button type="button" className="btn ghost sm" onClick={clearFilters}><Icons.Close size={12} /> Filtreleri temizle</button>}

        <InfoButton title="Basit Mod Görevler" icon={<Icons.Table size={12} />}>
          <p>Hızlı Görev Tanımı ile girdiğiniz bilgiler burada listelenir.</p>
          <div className="rt-sep" />
          <div className="rt-row"><Icons.Edit size={12} className="rt-ico" /><span>Satıra tıklayın: görevi düzenleyin</span></div>
          <div className="rt-row"><Icons.Mail size={12} className="rt-ico" /><span>Zarf simgesi: sorumlulara hatırlatma e-postası gönderir</span></div>
          <div className="rt-sep" />
          <p>İlerleme yüzdesi ve ayrıntılı planlama sütunları Gelişmiş Modda yer alır.</p>
        </InfoButton>

        <span className="muted tabular simple-tasks-count">{visible.length} / {tasks.length} görev</span>
        <button
          type="button"
          className="btn primary"
          onClick={onNewTask}
          disabled={!canAddTask}
          title={canAddTask ? 'Yeni görev' : 'Görev eklemek için yazabileceğiniz bir proje ve atayabileceğiniz bir sorumlu gerekir.'}
        >
          <Icons.Plus size={14} /> Yeni Görev
        </button>
      </div>

      <div className="card simple-tasks-card">
        <div className="simple-tasks-scroll">
          <table className="tbl simple-tasks-table" aria-label="Basit Mod Görevler">
            <thead>
              <tr>
                <FilterableTH label="Proje" style={{ minWidth: 170 }} sortKey={sortFor('proje')} onSort={setSortFor('proje')}
                  filter={filters.proje} onFilter={(value) => setFilter('proje', value)} filterType="multi" filterOptions={projectOptions} />
                <FilterableTH label="Görev" style={{ minWidth: 220 }} sortKey={sortFor('task')} onSort={setSortFor('task')}
                  filter={filters.task} onFilter={(value) => setFilter('task', value)} filterType="text" />
                <FilterableTH label="Kısa açıklama" style={{ minWidth: 130 }} sortKey={sortFor('keyword')} onSort={setSortFor('keyword')}
                  filter={filters.keyword} onFilter={(value) => setFilter('keyword', value)} filterType="multi" filterOptions={keywordOptions} />
                <FilterableTH label="Sorumlular" style={{ minWidth: 140 }} sortKey={sortFor('sorumlu')} onSort={setSortFor('sorumlu')}
                  filter={filters.sorumlu} onFilter={(value) => setFilter('sorumlu', value)} filterType="multi" filterOptions={assigneeOptions} />
                <FilterableTH label="Öncelik" style={{ minWidth: 100 }} sortKey={sortFor('priority')} onSort={setSortFor('priority')}
                  filter={filters.priority} onFilter={(value) => setFilter('priority', value)} filterType="multi" filterOptions={priorityOptions} />
                <FilterableTH label="Durum" style={{ minWidth: 120 }} sortKey={sortFor('status')} onSort={setSortFor('status')}
                  filter={filters.status} onFilter={(value) => setFilter('status', value)} filterType="multi" filterOptions={statusOptions} />
                <DateFilterableTH label="Termin" style={{ minWidth: 125 }} sortKey={sortFor('targetFinish')} onSort={setSortFor('targetFinish')}
                  filter={filters.targetFinish} onFilter={(value) => setFilter('targetFinish', value)} />
                <th style={{ width: 78 }} aria-label="İşlemler" />
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={SIMPLE_TASK_COLUMNS.length + 1} className="empty">Eşleşen görev bulunamadı.</td></tr>
              )}
              {visible.map((task) => {
                const priority = resolvePriority(task.priority);
                const referenceDay = today();
                const late = task.status !== 'done' && task.targetFinish && diffDays(task.targetFinish, referenceDay) < 0;
                const deletable = canDeleteTask(taskMutationState, task.id);
                return (
                  <tr key={task.id} onClick={() => openTask(task)} style={{ cursor: 'pointer' }}>
                    <td>
                      <div className="row" style={{ gap: 8, minWidth: 0 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 99, background: projectColorVar(task.proje), flexShrink: 0 }} />
                        <span className="simple-tasks-project">{task.projectCode ? `${task.projectCode} · ${task.proje}` : task.proje}</span>
                      </div>
                    </td>
                    <td>
                      {/* Başlık odaklanabilir bir DÜĞMEDİR: satırın kendisi
                          klavyeyle odaklanamıyor ve Enter/Boşluk işlemiyordu,
                          yani klavye kullanıcısı hatırlatma ile silmeye
                          ulaşırken görevi düzenlemek için hiçbir yol
                          bulamıyordu. Tablo semantiği korunur. */}
                      <button
                        type="button"
                        className="simple-tasks-open"
                        onClick={(event) => { event.stopPropagation(); openTask(task); }}
                      >
                        <span className="simple-tasks-title">{task.task}</span>
                      </button>
                    </td>
                    <td><span className="muted">{task.keyword || '—'}</span></td>
                    <td>
                      <AvatarStack
                        names={task.sorumlu || []}
                        personIds={(task.assigneeIds || []).map((id) => String(id)).filter((id) => peopleById.has(id))}
                        max={3}
                        size="sm"
                      />
                    </td>
                    <td>
                      <span className="simple-tasks-priority" style={{ color: priority.color }}>
                        <Icons.Flag size={11} /> {priority.label}
                      </span>
                    </td>
                    <td><StatusPill task={task} /></td>
                    <td className={`tabular${late ? ' simple-tasks-late' : ''}`}>{fmt(task.targetFinish)}</td>
                    <td>
                      <div className="row simple-tasks-actions" style={{ gap: 4 }}>
                        <TaskReminderButton task={task} />
                        <button
                          className="icon-btn"
                          style={{ width: 26, height: 26 }}
                          disabled={!deletable}
                          title={deletable ? 'Görevi sil' : 'Görevi silme yetkiniz yok'}
                          aria-label="Görevi sil"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (confirm('Görev silinsin mi?')) deleteTask(task.id);
                          }}
                        >
                          <Icons.Trash size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="simple-tasks-legend muted">
        <StatusIcon id="todo" size={11} /> Yapılacak
        <StatusIcon id="in_progress" size={11} /> Devam ediyor
        <StatusIcon id="done" size={11} /> Tamamlandı
        <StatusIcon id="overdue" size={11} /> Geciken
      </div>
    </div>
  );
}
