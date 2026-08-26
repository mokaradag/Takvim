'use client';
import { useState as useState1, useMemo as useMemo1 } from 'react';
import { DateFilterableTH } from '../../components/DateFilterableTH';
import { Icons } from '../../components/icons';
import { PRIORITIES, normalizePriorityId, resolvePriority } from '../../domain/constants';
import { fmt, diffDays, today } from '../../scheduling/dates';
import { describeRecurrenceRule } from '../../scheduling/recurrence';
import { projectColorVar } from '../../lib/colors';
import { Avatar, AvatarStack, StatusPill, StatusIcon } from '../../components/ui';
import { TaskKeyword } from '../../components/TaskKeyword';
import { InfoButton, FilterableTH, dateMatchesFilter, numericMatchesFilter } from '../../components/ui-extras';
import { TaskReminderButton } from '../reminders/TaskReminderButton';
import { useAppState } from '../../state/AppStateProvider';
import { canResolveTaskAssignee } from '../../state/appState';
import { useTasks, useProjects, usePeople, useTaskActions, useTaskAssignableProjects } from '../../state/hooks';
import { canDeleteTask } from '../../state/projectWritePolicy.js';
import { taskProgressValue, taskSortValue } from './taskDisplayValues.js';

function projectLabel(project) {
  if (!project) return '';
  return project.code ? `${project.code} · ${project.name}` : project.name;
}

/* ── Veri (Data table) ─────────────────────────────────── */
export function TasksView() {
  const tasks = useTasks();
  const projects = useProjects();
  const people = usePeople();
  const { openTask: onOpenTask, addTask: onAddTask, deleteTask: onDeleteTask } = useTaskActions();
  const [search, setSearch] = useState1('');
  const [sort, setSort] = useState1({ key: 'plannedStart', dir: 'asc' });
  const [colFilter, setColFilter] = useState1({
    proje: [],
    task: '',
    keyword: [],
    sorumlu: [],
    status: [],
    priority: [],
    plannedStart: null,
    plannedFinish: null,
    targetFinish: null,
    progress: null
  });

  const setCF = (key, value) => setColFilter(f => ({ ...f, [key]: value }));
  // Görev yazma yetkisi görev ATAMA kapsamını da içerir: yönetici, kendi
  // personeline tanımladığı görevi düzenleyip silebilir.
  const assignableProjects = useTaskAssignableProjects();
  const taskMutationState = useMemo1(
    () => ({ tasks, projects, assignableProjects }),
    [tasks, projects, assignableProjects]
  );
  // Düğme, isteğin KABUL EDİLEBİLİR bir sorumluyla gidebildiği en az bir proje
  // varken etkinleşir. Atama kapsamındaki projede varsayılan sorumlu oturum
  // sahibi olduğunda istek panel açılmadan reddediliyor, kullanıcıya da astını
  // seçme fırsatı verilmiyordu.
  const appState = useAppState();
  const canAddTask = assignableProjects.some((project) => canResolveTaskAssignee(appState, project));

  // Süzgeç değeri KARARLI kimliktir, görünen ad değil. Ada göre süzülseydi aynı
  // ada sahip iki proje (ya da iki çalışan) tek bir seçenekte birleşir; kullanıcı
  // benzersiz kodu arayıp birini seçse bile sonuçta ikisi de listelenirdi.
  const projOpts = useMemo1(() => projects
    .slice()
    .sort((a, b) => projectLabel(a).localeCompare(projectLabel(b), 'tr'))
    // Süzgeç listesindeki canlı arama proje kodunu ve türünü de tarar.
    .map(p => ({
      value: p.id,
      label: projectLabel(p),
      keywords: [p.code, p.name, p.projectTypeCode, p.projectTypeName],
      icon: <span style={{ width: 8, height: 8, borderRadius: 2, background: projectColorVar(p.name) }} />
    })), [projects]);
  const kwOpts = useMemo1(() => Array.from(new Set(tasks.map(t => String(t.keyword || '').trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'tr'))
    .map(k => ({ value: k, label: k })), [tasks]);
  const sorumluOpts = useMemo1(() => people
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
    // Sicil, unvan ve birim de aranabilir: binlerce kişilik dizinde ad tek
    // başına yeterli bir arama anahtarı değildir.
    .map(p => ({
      value: String(p.id),
      label: p.employeeNo ? `${p.employeeNo} · ${p.name}` : p.name,
      keywords: [p.name, p.employeeNo, p.username, p.role, p.team, p.organization?.department, p.organization?.unit],
      icon: <Avatar name={p.name} person={p} size="sm" />
    })), [people]);
  const statusOpts = [
    { value: 'todo', label: 'Yapılacak', icon: <StatusIcon id="todo" size={11} /> },
    { value: 'in_progress', label: 'Devam ediyor', icon: <StatusIcon id="in_progress" size={11} /> },
    { value: 'done', label: 'Tamamlandı', icon: <StatusIcon id="done" size={11} /> },
    { value: 'overdue', label: 'Geciken', icon: <StatusIcon id="overdue" size={11} /> }
  ];
  const priorityOpts = Object.values(PRIORITIES).map(p => ({
    value: p.id, label: p.label, icon: <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
  }));

  const filtered = useMemo1(() => {
    const today_ = today();
    let out = [...tasks];
    if (search) {
      const q = search.toLocaleLowerCase('tr-TR');
      out = out.filter(t => {
        const haystack = [t.task, t.proje, t.projectCode, t.keyword, ...(t.sorumlu || [])]
          .map((value) => String(value || '').toLocaleLowerCase('tr-TR'));
        return haystack.some((value) => value.includes(q));
      });
    }
    if (colFilter.proje.length) out = out.filter(t => colFilter.proje.includes(t.projectId));
    if (colFilter.task) {
      const q = colFilter.task.toLocaleLowerCase('tr-TR');
      out = out.filter(t => String(t.task || '').toLocaleLowerCase('tr-TR').includes(q));
    }
    if (colFilter.keyword.length) out = out.filter(t => colFilter.keyword.includes(t.keyword));
    if (colFilter.sorumlu.length) {
      out = out.filter(t => (t.assigneeIds || []).some(id => colFilter.sorumlu.includes(String(id))));
    }
    if (colFilter.priority?.length) out = out.filter(t => colFilter.priority.includes(normalizePriorityId(t.priority)));
    if (colFilter.status.length) {
      out = out.filter(t => {
        const overdue = t.status !== 'done' && t.targetFinish && diffDays(t.targetFinish, today_) < 0;
        if (colFilter.status.includes('overdue') && overdue) return true;
        return colFilter.status.includes(t.status || 'todo');
      });
    }
    ['plannedStart', 'plannedFinish', 'targetFinish'].forEach(k => {
      const spec = colFilter[k];
      if (spec) out = out.filter(t => !!t[k] && dateMatchesFilter(t[k], spec));
    });
    ['progress'].forEach(k => {
      const spec = colFilter[k];
      // Süzgeç ve hücre AYNI türetilmiş değeri kullanır: süzgeç `null` ilerlemeyi
      // 0 sayarken satır tamamlanmış görevi %100 gösteriyor, "Eşit 100" süzgeci
      // ekranda 100 yazan satırları gizliyordu.
      if (spec) out = out.filter(t => numericMatchesFilter(k === 'progress' ? taskProgressValue(t) : (t[k] != null ? t[k] : 0), spec));
    });

    out.sort((a, b) => {
      let va = taskSortValue(a, sort.key), vb = taskSortValue(b, sort.key);
      if (sort.key === 'sorumlu') { va = (a.sorumlu?.[0] || ''); vb = (b.sorumlu?.[0] || ''); }
      if (sort.key === 'priority') { va = resolvePriority(a.priority).order; vb = resolvePriority(b.priority).order; }
      const aMissing = va == null || va === '';
      const bMissing = vb == null || vb === '';
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      if (va < vb) return sort.dir === 'asc' ? -1 : 1;
      if (va > vb) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
    return out;
  }, [tasks, search, sort, colFilter]);

  const setSortFor = (key) => (dir) => setSort({ key, dir });
  const sortDirFor = (key) => sort.key === key ? sort.dir : null;

  const clearAll = () => {
    setSearch('');
    setColFilter({ proje: [], task: '', keyword: [], sorumlu: [], status: [], priority: [], plannedStart: null, plannedFinish: null, targetFinish: null, progress: null });
  };
  const hasAnyFilter = search || Object.values(colFilter).some(v => {
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'string') return v.length > 0;
    return !!v;
  });

  return (
    <div className="tasks-page col">
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div className="topbar-search" style={{ flex: 1, minWidth: 240, maxWidth: 360 }}>
          <Icons.Search size={14} />
          <input placeholder="Görev, proje, sorumlu, etiket..." value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => setSearch('')}><Icons.Close size={12} /></button>}
        </div>
        <InfoButton title="Görevler tablosu" icon={<Icons.Table size={12} />}>
          <p>Tüm görevlerin tek bakışta listesi.</p>
          <div className="rt-sep" />
          <div className="rt-row"><Icons.Search size={12} className="rt-ico" /><span>Üstteki arama: tüm sütunlarda arar</span></div>
          <div className="rt-row"><Icons.Filter size={12} className="rt-ico" /><span>Sütun başlığına tıkla: filtrele/sırala</span></div>
          <div className="rt-row"><Icons.Calendar size={12} className="rt-ico" /><span>Tarih sütunları: Hızlı önayar veya aralık</span></div>
          <div className="rt-row"><Icons.Edit size={12} className="rt-ico" /><span>Satıra tıkla: detay panelini aç</span></div>
        </InfoButton>
        {hasAnyFilter && (
          <button className="btn ghost sm" onClick={clearAll}>
            <Icons.Close size={12} /> Filtreleri temizle
          </button>
        )}
        <span className="muted tabular" style={{ marginLeft: 'auto', fontSize: 12.5 }}>{filtered.length} / {tasks.length} görev</span>
        <button
          className="btn primary"
          onClick={onAddTask}
          disabled={!canAddTask}
          title={canAddTask ? 'Yeni görev' : 'Görev eklemek için yazabileceğiniz bir proje ve atayabileceğiniz bir sorumlu gerekir.'}
        >
          <Icons.Plus size={14} /> Yeni görev
        </button>
      </div>

      <div className="tasks-table-card">
        <div className="tasks-table-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 36, textAlign: 'center' }}>#</th>
                <FilterableTH label="Proje" style={{ minWidth: 180 }}
                  sortKey={sortDirFor('proje')} onSort={setSortFor('proje')}
                  filter={colFilter.proje} onFilter={v => setCF('proje', v)}
                  filterType="multi" filterOptions={projOpts}
                />
                <FilterableTH label="Görev" style={{ minWidth: 260 }}
                  sortKey={sortDirFor('task')} onSort={setSortFor('task')}
                  filter={colFilter.task} onFilter={v => setCF('task', v)}
                  filterType="text"
                />
                <FilterableTH label="Etiket" style={{ minWidth: 110 }}
                  filter={colFilter.keyword} onFilter={v => setCF('keyword', v)}
                  filterType="multi" filterOptions={kwOpts}
                />
                <FilterableTH label="Sorumlu" style={{ minWidth: 150 }}
                  sortKey={sortDirFor('sorumlu')} onSort={setSortFor('sorumlu')}
                  filter={colFilter.sorumlu} onFilter={v => setCF('sorumlu', v)}
                  filterType="multi" filterOptions={sorumluOpts}
                />
                <FilterableTH label="Durum" style={{ minWidth: 130 }}
                  sortKey={sortDirFor('status')} onSort={setSortFor('status')}
                  filter={colFilter.status} onFilter={v => setCF('status', v)}
                  filterType="multi" filterOptions={statusOpts}
                />
                <FilterableTH label="Öncelik" style={{ minWidth: 100 }}
                  sortKey={sortDirFor('priority')} onSort={setSortFor('priority')}
                  filter={colFilter.priority} onFilter={v => setCF('priority', v)}
                  filterType="multi" filterOptions={priorityOpts}
                />
                <FilterableTH label="İlerleme" style={{ minWidth: 110 }}
                  sortKey={sortDirFor('progress')} onSort={setSortFor('progress')}
                  filter={colFilter.progress} onFilter={v => setCF('progress', v)}
                  filterType="number" numericMin={0} numericMax={100} numericUnit="%"
                />
                <DateFilterableTH label="Başlangıç" style={{ minWidth: 130 }}
                  sortKey={sortDirFor('plannedStart')} onSort={setSortFor('plannedStart')}
                  filter={colFilter.plannedStart} onFilter={v => setCF('plannedStart', v)}
                />
                <DateFilterableTH label="Bitiş" style={{ minWidth: 130 }}
                  sortKey={sortDirFor('plannedFinish')} onSort={setSortFor('plannedFinish')}
                  filter={colFilter.plannedFinish} onFilter={v => setCF('plannedFinish', v)}
                />
                <DateFilterableTH label="Hedef" style={{ minWidth: 130 }}
                  sortKey={sortDirFor('targetFinish')} onSort={setSortFor('targetFinish')}
                  filter={colFilter.targetFinish} onFilter={v => setCF('targetFinish', v)}
                />
                <th style={{ width: 78 }} aria-label="İşlemler" />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={12} className="empty">Eşleşen görev bulunamadı.</td></tr>
              )}
              {filtered.map((t, idx) => {
                const today_ = today();
                const overdue = t.status !== 'done' && t.targetFinish && diffDays(t.targetFinish, today_) < 0;
                const prio = resolvePriority(t.priority);
                const prog = taskProgressValue(t);
                const canDeleteCurrentTask = canDeleteTask(taskMutationState, t.id);
                return (
                  <tr key={t.id} onClick={() => onOpenTask(t)} style={{ cursor: 'pointer' }}>
                    <td className="muted tabular" style={{ textAlign: 'center', fontSize: 11.5 }}>{idx + 1}</td>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 99, background: projectColorVar(t.proje) }} />
                        <span style={{ fontWeight: 500 }}>{t.projectCode ? `${t.projectCode} · ${t.proje}` : t.proje}</span>
                      </div>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        {t.milestone && <Icons.Diamond size={10} style={{ color: projectColorVar(t.proje) }} />}
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{t.task}</div>
                        {/* Seri şablonu kuralı taşır; yinelemeler şablona bağlıdır. */}
                        {t.recurrence && (
                          <span className="recurrence-badge" title={describeRecurrenceRule(t.recurrence)}>
                            <Icons.Clock size={9} /> Seri
                          </span>
                        )}
                        {t.recurrenceParentId && (
                          <span className="recurrence-badge" title="Tekrar serisinden üretilmiş yineleme">
                            <Icons.Clock size={9} /> Tekrar
                          </span>
                        )}
                      </div>
                    </td>
                    <td><TaskKeyword task={t} /></td>
                    <td><AvatarStack names={t.sorumlu || []} personIds={t.assigneeIds} max={3} size="sm" /></td>
                    <td><StatusPill task={t} /></td>
                    <td><span style={{ fontSize: 11.5, fontWeight: 600, color: prio.color }}>{prio.label}</span></td>
                    <td>
                      <div className="row" style={{ gap: 8, minWidth: 90 }}>
                        <div className="bar-track" style={{ flex: 1, height: 4 }}>
                          <div className="bar-fill" style={{ width: `${prog}%`, background: prog === 100 ? 'var(--status-done)' : projectColorVar(t.proje) }} />
                        </div>
                        <span className="tabular" style={{ fontSize: 11, minWidth: 28, textAlign: 'right', color: 'var(--text-muted)' }}>{prog}%</span>
                      </div>
                    </td>
                    <td className="muted tabular" style={{ fontSize: 12 }}>{fmt(t.plannedStart)}</td>
                    <td className="muted tabular" style={{ fontSize: 12 }}>{fmt(t.plannedFinish)}</td>
                    <td className="tabular" style={{ fontSize: 12, color: overdue ? 'var(--status-overdue)' : 'var(--text-muted)', fontWeight: overdue ? 600 : 500 }}>{fmt(t.targetFinish)}</td>
                    <td>
                      {/* Hatırlatma eylemi silme simgesinin YANINDA durur;
                          Basit Modda da aynı yerdedir. */}
                      <div className="row" style={{ gap: 4 }}>
                        <TaskReminderButton task={t} />
                        <button
                          className="icon-btn"
                          style={{ width: 26, height: 26 }}
                          disabled={!canDeleteCurrentTask}
                          title={canDeleteCurrentTask ? 'Görevi sil' : 'Görevi silme yetkiniz yok'}
                          aria-label="Görevi sil"
                          onClick={(e) => { e.stopPropagation(); if (confirm('Görev silinsin mi?')) onDeleteTask(t.id); }}
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
    </div>
  );
}
