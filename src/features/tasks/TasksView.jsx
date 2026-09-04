'use client';
import { useState as useState1, useMemo as useMemo1, useCallback as useCallback1 } from 'react';
import { DateFilterableTH } from '../../components/DateFilterableTH';
import { Icons } from '../../components/icons';
import { ButtonSpinner } from '../../components/Loader';
import {
  TASK_PRIORITY_FILTER_OPTIONS,
  TASK_STATUS_FILTER_OPTIONS,
  resolvePriority
} from '../../domain/constants';
import { fmt, diffDays, today } from '../../scheduling/dates';
import { describeRecurrenceRule } from '../../scheduling/recurrence';
import { projectColorVar } from '../../lib/colors';
import { Avatar, AvatarStack, PriorityIcon, StatusPill, StatusIcon } from '../../components/ui';
import { TaskKeyword } from '../../components/TaskKeyword';
import { InfoButton, FilterableTH } from '../../components/ui-extras';
import { TaskReminderButton } from '../reminders/TaskReminderButton';
import { useAppState } from '../../state/AppStateProvider';
import { canResolveTaskAssignee } from '../../state/appState';
import { useTasks, useProjects, usePeople, useTaskActions, useTaskAssignableProjects } from '../../state/hooks';
import { resolveTaskDeleteAccess } from '../../state/projectWritePolicy.js';
import { taskProgressValue, taskSortValue } from './taskDisplayValues.js';
import { TASK_TABLE_FACET_KEYS, taskTableFacetValues, taskTableMatches } from './taskTableFacets.js';
import { TaskTablePagination, useTaskTablePagination } from './TaskTablePagination.jsx';
import { createEmptyOrgFilter, hasOrgSelection } from '../../domain/organization/organizationHierarchy.js';
import { TaskOrganizationFilterControls } from './TaskOrganizationFilterControls.jsx';
import { useSharedTaskOrganizationFilter } from './TaskOrganizationFilterContext.jsx';
import { useTaskOrganizationFilter } from './useTaskOrganizationFilter.js';

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
  const { selection: organizationFilter, setSelection: onOrganizationFilterChange } = useSharedTaskOrganizationFilter();
  const [search, setSearch] = useState1('');
  // Görev oluşturma sunucuya yazma yapar ve birkaç saniye sürebilir; düğme bu
  // süre boyunca dönen halkayı gösterir ve ikinci tıklamayı engeller.
  const [creating, setCreating] = useState1(false);
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
  const organization = useTaskOrganizationFilter(
    tasks,
    people,
    organizationFilter,
    onOrganizationFilterChange
  );

  const setCF = (key, value) => setColFilter(f => ({ ...f, [key]: value }));
  const appState = useAppState();
  // Görev yazma yetkisi görev ATAMA kapsamını da içerir; silme kararı ayrıca
  // görev oluşturucusu ve kalıcı sorumlu listesiyle sınırlandırılır.
  const assignableProjects = useTaskAssignableProjects();
  const taskMutationState = useMemo1(
    () => ({ tasks, projects, assignableProjects, currentUser: appState.currentUser }),
    [tasks, projects, assignableProjects, appState.currentUser]
  );
  // Düğme, isteğin KABUL EDİLEBİLİR bir sorumluyla gidebildiği en az bir proje
  // varken etkinleşir. Atama kapsamındaki projede varsayılan sorumlu oturum
  // sahibi olduğunda istek panel açılmadan reddediliyor, kullanıcıya da astını
  // seçme fırsatı verilmiyordu.
  const canAddTask = assignableProjects.some((project) => canResolveTaskAssignee(appState, project));

  // Süzgeç değeri KARARLI kimliktir, görünen ad değil. Ada göre süzülseydi aynı
  // ada sahip iki proje (ya da iki çalışan) tek bir seçenekte birleşir; kullanıcı
  // benzersiz kodu arayıp birini seçse bile sonuçta ikisi de listelenirdi.
  //
  // Seçenekler ÇAPRAZ süzülür: her sütunun listesi, ÖTEKİ sütun süzgeçlerinden
  // (ve aramadan, kurumsal seçimden) geçen satırlardan toplanır. Böylece bir
  // sütunda süzme yapıldığında öteki sütunlarda yalnızca hâlâ görünen değerler
  // kalır; sonucu kesinlikle boş olan bir seçenek listelenmez. Sütunun KENDİ
  // süzgeci hesap dışıdır, yoksa kullanıcı ikinci bir değer ekleyemezdi
  // (bkz. features/tasks/taskTableFacets.js).
  const facetValues = useMemo1(() => Object.fromEntries(TASK_TABLE_FACET_KEYS.map((key) => [
    key,
    taskTableFacetValues(organization.filteredTasks, { search, filters: colFilter }, key)
  ])), [organization.filteredTasks, search, colFilter]);

  // Seçenek listesi GÖRÜNÜR değerlerle HÂLEN SEÇİLİ değerlerin BİRLEŞİMİDİR.
  //
  // Yalnızca görünür değerler listelenseydi, kurumsal seçim ya da otomatik
  // yenileme süzülen satırları kaldırdığında etkin seçenek menüden kayboluyor;
  // kullanıcı o değeri işaretten çıkaramıyor ve tabloyu geri getiremiyordu.
  // Geride, sütunu ya da tümünü temizlemeden kurtulunamayan GİZLİ bir süzgeç
  // kalıyor, sıradan bir süzgeç değişikliği açıklanamaz biçimde boş tablo
  // üretiyordu.
  const withSelected = useCallback1((visible, selected) => {
    if (!selected?.length) return visible;
    const values = new Set(visible);
    for (const value of selected) values.add(String(value));
    return values;
  }, []);

  const projectOptionIds = useMemo1(
    () => withSelected(facetValues.proje, colFilter.proje),
    [facetValues, colFilter.proje, withSelected]
  );
  const assigneeOptionIds = useMemo1(
    () => withSelected(facetValues.sorumlu, colFilter.sorumlu),
    [facetValues, colFilter.sorumlu, withSelected]
  );
  const statusOptionValues = useMemo1(
    () => withSelected(facetValues.status, colFilter.status),
    [facetValues, colFilter.status, withSelected]
  );
  const priorityOptionValues = useMemo1(
    () => withSelected(facetValues.priority, colFilter.priority),
    [facetValues, colFilter.priority, withSelected]
  );

  const projOpts = useMemo1(() => projects
    .filter(p => projectOptionIds.has(String(p.id)))
    .sort((a, b) => projectLabel(a).localeCompare(projectLabel(b), 'tr'))
    // Süzgeç listesindeki canlı arama proje kodunu ve türünü de tarar.
    .map(p => ({
      value: p.id,
      label: projectLabel(p),
      keywords: [p.code, p.name, p.projectTypeCode, p.projectTypeName],
      icon: <span style={{ width: 8, height: 8, borderRadius: 2, background: projectColorVar(p.name) }} />
    })), [projects, projectOptionIds]);
  const kwOpts = useMemo1(() => Array.from(withSelected(facetValues.keyword, colFilter.keyword))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'tr'))
    .map(k => ({ value: k, label: k })), [facetValues, colFilter.keyword, withSelected]);
  const sorumluOpts = useMemo1(() => people
    .filter(p => assigneeOptionIds.has(String(p.id)))
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
    // Sicil, unvan ve birim de aranabilir: binlerce kişilik dizinde ad tek
    // başına yeterli bir arama anahtarı değildir.
    .map(p => ({
      value: String(p.id),
      label: p.employeeNo ? `${p.employeeNo} · ${p.name}` : p.name,
      keywords: [p.name, p.employeeNo, p.username, p.role, p.team, p.organization?.department, p.organization?.unit],
      icon: <Avatar name={p.name} person={p} size="sm" />
    })), [people, assigneeOptionIds]);
  const statusOpts = useMemo1(() => TASK_STATUS_FILTER_OPTIONS
    .filter((status) => statusOptionValues.has(String(status.value)))
    .map((status) => ({
      ...status,
      icon: <StatusIcon id={status.value} size={11} />
    })), [statusOptionValues]);
  const priorityOpts = useMemo1(() => TASK_PRIORITY_FILTER_OPTIONS
    .filter((priority) => priorityOptionValues.has(String(priority.id)))
    .map((priority) => ({
      value: priority.id,
      label: priority.label,
      icon: <PriorityIcon color={priority.color} size={11} />
    })), [priorityOptionValues]);

  const filtered = useMemo1(() => {
    const today_ = today();
    // `filteredTasks`, yetkili çalışma alanı kümesinin kurumsal kapsamla
    // daraltılmış hâlidir; arama ve tablo süzgeçleri bundan sonra gelir. Satır
    // süzmesi ile faset hesabı AYNI yüklemi kullanır: iki ayrı kopya, birinde
    // düzeltilen bir kural ötekinde kalıyordu.
    const out = organization.filteredTasks
      .filter((task) => taskTableMatches(task, { search, filters: colFilter }, null, today_));

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
  }, [organization.filteredTasks, search, sort, colFilter]);
  const paginationKey = `${JSON.stringify(organization.selection)}\u001f${search}\u001f${JSON.stringify(colFilter)}\u001f${sort.key}\u001f${sort.dir}`;
  const paged = useTaskTablePagination(filtered, paginationKey);

  const createTask = async () => {
    if (creating) return;
    setCreating(true);
    try {
      await onAddTask();
    } finally {
      setCreating(false);
    }
  };

  const setSortFor = (key) => (dir) => setSort({ key, dir });
  const sortDirFor = (key) => sort.key === key ? sort.dir : null;

  const clearAll = () => {
    setSearch('');
    setColFilter({ proje: [], task: '', keyword: [], sorumlu: [], status: [], priority: [], plannedStart: null, plannedFinish: null, targetFinish: null, progress: null });
    onOrganizationFilterChange(createEmptyOrgFilter());
  };
  const hasAnyFilter = hasOrgSelection(organization.selection) || search || Object.values(colFilter).some(v => {
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'string') return v.length > 0;
    return !!v;
  });

  return (
    <div className="tasks-page col">
      <div className="row tasks-toolbar">
        <div className="topbar-search tasks-toolbar-search">
          <Icons.Search size={14} />
          <input placeholder="Görev, proje, sorumlu, etiket..." value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => setSearch('')}><Icons.Close size={12} /></button>}
        </div>
        <TaskOrganizationFilterControls organization={organization} />
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
          onClick={createTask}
          disabled={!canAddTask || creating}
          aria-busy={creating}
          title={canAddTask ? 'Yeni görev' : 'Görev eklemek için yazabileceğiniz bir proje ve atayabileceğiniz bir sorumlu gerekir.'}
        >
          <ButtonSpinner busy={creating} size={14}><Icons.Plus size={14} /></ButtonSpinner>
          {creating ? 'Oluşturuluyor…' : 'Yeni görev'}
        </button>
      </div>

      <div className="tasks-table-card">
        <div className="tasks-table-scroll">
          <table className="tbl tasks-table" aria-label="Görevler">
            <thead>
              <tr>
                <th className="tasks-index-col" style={{ textAlign: 'center' }}>#</th>
                <FilterableTH label="Proje" style={{ minWidth: 148 }}
                  sortKey={sortDirFor('proje')} onSort={setSortFor('proje')}
                  filter={colFilter.proje} onFilter={v => setCF('proje', v)}
                  filterType="multi" filterOptions={projOpts}
                />
                <FilterableTH label="Görev" style={{ minWidth: 210 }}
                  sortKey={sortDirFor('task')} onSort={setSortFor('task')}
                  filter={colFilter.task} onFilter={v => setCF('task', v)}
                  filterType="text"
                />
                <FilterableTH label="Etiket" style={{ minWidth: 100 }}
                  filter={colFilter.keyword} onFilter={v => setCF('keyword', v)}
                  filterType="multi" filterOptions={kwOpts}
                />
                <FilterableTH label="Sorumlu" style={{ minWidth: 96 }}
                  sortKey={sortDirFor('sorumlu')} onSort={setSortFor('sorumlu')}
                  filter={colFilter.sorumlu} onFilter={v => setCF('sorumlu', v)}
                  filterType="multi" filterOptions={sorumluOpts}
                />
                <FilterableTH label="Durum" style={{ minWidth: 118 }}
                  sortKey={sortDirFor('status')} onSort={setSortFor('status')}
                  filter={colFilter.status} onFilter={v => setCF('status', v)}
                  filterType="multi" filterOptions={statusOpts}
                />
                <FilterableTH label="Öncelik" style={{ minWidth: 86 }}
                  sortKey={sortDirFor('priority')} onSort={setSortFor('priority')}
                  filter={colFilter.priority} onFilter={v => setCF('priority', v)}
                  filterType="multi" filterOptions={priorityOpts}
                />
                <FilterableTH label="İlerleme" style={{ minWidth: 100 }}
                  sortKey={sortDirFor('progress')} onSort={setSortFor('progress')}
                  filter={colFilter.progress} onFilter={v => setCF('progress', v)}
                  filterType="number" numericMin={0} numericMax={100} numericUnit="%"
                />
                <DateFilterableTH label="Başlangıç" style={{ minWidth: 104 }}
                  sortKey={sortDirFor('plannedStart')} onSort={setSortFor('plannedStart')}
                  filter={colFilter.plannedStart} onFilter={v => setCF('plannedStart', v)}
                />
                <DateFilterableTH label="Bitiş" style={{ minWidth: 96 }}
                  sortKey={sortDirFor('plannedFinish')} onSort={setSortFor('plannedFinish')}
                  filter={colFilter.plannedFinish} onFilter={v => setCF('plannedFinish', v)}
                />
                <DateFilterableTH label="Hedef" style={{ minWidth: 96 }}
                  sortKey={sortDirFor('targetFinish')} onSort={setSortFor('targetFinish')}
                  filter={colFilter.targetFinish} onFilter={v => setCF('targetFinish', v)}
                />
                <th className="tasks-actions-col" aria-label="İşlemler" />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={12} className="empty">Eşleşen görev bulunamadı.</td></tr>
              )}
              {paged.rows.map((t, idx) => {
                const today_ = today();
                const overdue = t.status !== 'done' && t.targetFinish && diffDays(t.targetFinish, today_) < 0;
                const prio = resolvePriority(t.priority);
                const prog = taskProgressValue(t);
                const deleteAccess = resolveTaskDeleteAccess(taskMutationState, t.id);
                return (
                  <tr key={t.id} data-task-id={t.id} onClick={() => onOpenTask(t)} style={{ cursor: 'pointer' }}>
                    <td className="muted tabular tasks-index-cell">{paged.start + idx + 1}</td>
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
                    <td><AvatarStack names={t.sorumlu || []} personIds={t.assigneeIds} people={t.assigneeAvatarIdentities} max={3} size="sm" /></td>
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
                    <td className="muted tabular tasks-date-cell">{fmt(t.plannedStart)}</td>
                    <td className="muted tabular tasks-date-cell">{fmt(t.plannedFinish)}</td>
                    <td className="tabular tasks-date-cell" style={{ color: overdue ? 'var(--status-overdue)' : 'var(--text-muted)', fontWeight: overdue ? 600 : 500 }}>{fmt(t.targetFinish)}</td>
                    {/* Eylem sütunu sağa YAPIŞIKTIR: yazı tipi büyütülüp tablo
                        yatay kaydırmaya girdiğinde bile posta ve silme düğmeleri
                        görünür kalır. */}
                    <td className="tasks-actions-cell">
                      <div className="row" style={{ gap: 4 }}>
                        <TaskReminderButton task={t} />
                        <button
                          className="icon-btn"
                          style={{ width: 26, height: 26 }}
                          disabled={!deleteAccess.canDelete}
                          title={deleteAccess.canDelete ? 'Görevi sil' : deleteAccess.reason}
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
      <TaskTablePagination page={paged.page} pageCount={paged.pageCount} setPage={paged.setPage} />
    </div>
  );
}
