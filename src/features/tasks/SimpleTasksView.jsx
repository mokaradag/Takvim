'use client';
import { useMemo, useState } from 'react';
import { Icons } from '../../components/icons';
import { AvatarStack, StatusIcon, StatusPill } from '../../components/ui';
import { InfoButton } from '../../components/ui-extras';
import { TaskReminderButton } from '../reminders/TaskReminderButton';
import { PRIORITIES, normalizePriorityId, resolvePriority } from '../../domain/constants';
import { projectColorVar } from '../../lib/colors';
import { diffDays, fmt, today } from '../../scheduling/dates';
import { canWriteProject } from '../../state/projectWritePolicy.js';
import { usePeople, useProjects, useTaskActions, useTaskAssignableProjects, useTasks } from '../../state/hooks';
import { SIMPLE_TASK_COLUMNS } from './simpleTaskColumns.js';

/**
 * Basit Mod · Görevler.
 *
 * Gelişmiş Modun tam tablosu BİLİNÇLİ OLARAK gösterilmez. Basit Mod kullanıcısı
 * görevini "Hızlı Görev Tanımı" ile açar: proje, görev, kısa açıklama, sorumlu,
 * termin ve öncelik. Tablo aynı alanları listeler; ilerleme yüzdesi, efor
 * saatleri, planlanan başlangıç/bitiş, dağılım ağacı ve bağımlılıklar gibi
 * Basit Modda hiç toplanmayan sütunlar dışarıda kalır (bkz. simpleTaskColumns.js).
 *
 * Gelişmiş Mod tablosu (TasksView) değişmeden durur.
 */
export function SimpleTasksView() {
  const tasks = useTasks();
  const projects = useProjects();
  const people = usePeople();
  const assignableProjects = useTaskAssignableProjects();
  const { openTask, deleteTask } = useTaskActions();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('open');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [sort, setSort] = useState('targetFinish');

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const assignableProjectIds = useMemo(
    () => new Set(assignableProjects.map((project) => String(project.id))),
    [assignableProjects]
  );
  const peopleById = useMemo(() => new Map(people.map((person) => [String(person.id), person])), [people]);

  const visible = useMemo(() => {
    const referenceDay = today();
    const query = search.trim().toLocaleLowerCase('tr-TR');
    const filtered = tasks.filter((task) => {
      if (query) {
        const haystack = [task.task, task.proje, task.projectCode, task.keyword, ...(task.sorumlu || [])]
          .map((value) => String(value || '').toLocaleLowerCase('tr-TR'));
        if (!haystack.some((value) => value.includes(query))) return false;
      }
      if (statusFilter === 'open' && task.status === 'done') return false;
      if (statusFilter === 'done' && task.status !== 'done') return false;
      if (statusFilter === 'late') {
        const late = task.status !== 'done' && task.targetFinish && diffDays(task.targetFinish, referenceDay) < 0;
        if (!late) return false;
      }
      if (priorityFilter && normalizePriorityId(task.priority) !== priorityFilter) return false;
      return true;
    });

    return filtered.sort((left, right) => {
      if (sort === 'priority') {
        const delta = resolvePriority(left.priority).order - resolvePriority(right.priority).order;
        if (delta !== 0) return delta;
      }
      const leftDue = left.targetFinish || '';
      const rightDue = right.targetFinish || '';
      if (!leftDue && !rightDue) return String(left.task || '').localeCompare(String(right.task || ''), 'tr');
      if (!leftDue) return 1;
      if (!rightDue) return -1;
      return leftDue.localeCompare(rightDue);
    });
  }, [tasks, search, statusFilter, priorityFilter, sort]);

  const canEdit = (task) => canWriteProject(projectById.get(task.projectId))
    || assignableProjectIds.has(String(task.projectId));

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

        <div className="seg simple-tasks-filter" role="group" aria-label="Durum süzgeci">
          {[['open', 'Açık'], ['late', 'Geciken'], ['done', 'Tamamlanan'], ['all', 'Tümü']].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={statusFilter === value ? 'active' : ''}
              aria-pressed={statusFilter === value}
              onClick={() => setStatusFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="simple-tasks-select">
          <span className="muted">Öncelik</span>
          <select
            className="input"
            value={priorityFilter}
            onChange={(event) => setPriorityFilter(event.target.value)}
            aria-label="Öncelik süzgeci"
          >
            <option value="">Tümü</option>
            {Object.values(PRIORITIES).map((priority) => (
              <option key={priority.id} value={priority.id}>{priority.label}</option>
            ))}
          </select>
        </label>

        <label className="simple-tasks-select">
          <span className="muted">Sırala</span>
          <select className="input" value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sıralama">
            <option value="targetFinish">Termine göre</option>
            <option value="priority">Önceliğe göre</option>
          </select>
        </label>

        <InfoButton title="Basit Mod Görevler" icon={<Icons.Table size={12} />}>
          <p>Hızlı Görev Tanımı ile girdiğiniz bilgiler burada listelenir.</p>
          <div className="rt-sep" />
          <div className="rt-row"><Icons.Edit size={12} className="rt-ico" /><span>Satıra tıklayın: görevi düzenleyin</span></div>
          <div className="rt-row"><Icons.Mail size={12} className="rt-ico" /><span>Zarf simgesi: sorumlulara hatırlatma e-postası gönderir</span></div>
          <div className="rt-sep" />
          <p>İlerleme yüzdesi, efor saatleri ve planlama sütunları Gelişmiş Modda yer alır.</p>
        </InfoButton>

        <span className="muted tabular simple-tasks-count">{visible.length} / {tasks.length} görev</span>
      </div>

      <div className="card simple-tasks-card">
        <div className="simple-tasks-scroll">
          <table className="tbl simple-tasks-table">
            <thead>
              <tr>
                {SIMPLE_TASK_COLUMNS.map((column) => (
                  <th key={column.id} data-column={column.id}>{column.label}</th>
                ))}
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
                const editable = canEdit(task);
                return (
                  <tr key={task.id} onClick={() => openTask(task)} style={{ cursor: 'pointer' }}>
                    <td>
                      <div className="row" style={{ gap: 8, minWidth: 0 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 99, background: projectColorVar(task.proje), flexShrink: 0 }} />
                        <span className="simple-tasks-project">{task.projectCode ? `${task.projectCode} · ${task.proje}` : task.proje}</span>
                      </div>
                    </td>
                    <td><span className="simple-tasks-title">{task.task}</span></td>
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
                          disabled={!editable}
                          title={editable ? 'Görevi sil' : 'Salt okunur görev'}
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
