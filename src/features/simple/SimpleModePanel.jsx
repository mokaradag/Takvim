'use client';
import { useEffect, useMemo, useState } from 'react';
import { DateInput } from '../../components/DateInput';
import { Icons } from '../../components/icons';
import { SearchableSelect } from '../../components/SearchableSelect';
import { Avatar } from '../../components/ui';
import { ProjectCreateDialog } from '../../components/shell/ProjectCreateDialog';
import { PRIORITIES, DEFAULT_PRIORITY_ID, normalizePriorityId } from '../../domain/constants';
import { projectTypeMeta, visibleProjects, isArchivedProject } from '../../domain/projectTypes';
import { findProjectTag, projectTagCatalog } from '../../domain/tags';
import { fmtISO, today } from '../../scheduling/dates';
import { useAppState } from '../../state/AppStateProvider';
import { canWriteProject, taskCreationScopeInProject } from '../../state/projectWritePolicy.js';
import {
  useAllPeople,
  useAllWbs,
  useAssignmentScopeSicils,
  useTaskActions,
  useTaskAssignableProjects
} from '../../state/hooks';
import {
  findProjectRootWbsId,
  resolveSimpleProjectChoice,
  simpleAssignmentScope,
  simpleTaskRequiredFieldsError,
  withManualProjectOption,
  writableSimpleModeProjects
} from './simpleModePolicy.js';
import {
  SIMPLE_ASSIGNEE_RESULT_LIMIT,
  searchSimpleAssignees,
  simpleAssigneeNumber,
  simpleAssignmentCandidates
} from './simpleAssigneeSearch.js';

const MANUAL_PROJECT = '__manual_project__';

function projectLabel(project) {
  return project.code ? `${project.code} · ${project.name}` : project.name;
}

function PersonChoice({ person, active, onToggle }) {
  return (
    <button type="button" className={`simple-person${active ? ' active' : ''}`} onClick={() => onToggle(person.id)}>
      <Avatar name={person.name} person={person} size="sm" />
      <span><strong>{person.name}</strong><small>{simpleAssigneeNumber(person)}</small></span>
      {active ? <Icons.Check size={13} /> : <Icons.Plus size={13} />}
    </button>
  );
}

export function SimpleModePanel() {
  // Proje seçicisi görev ATAMA kapsamını kullanır: sıradan kullanıcıda
  // FULL ve sorumluluktan doğan dar projeler; yöneticide bütün CN43N listesi.
  const projects = useTaskAssignableProjects();
  const people = useAllPeople();
  const wbs = useAllWbs();
  const assignmentScopeSicils = useAssignmentScopeSicils();
  const appState = useAppState();
  const { canCreateProjects, currentUser } = appState;
  const { addProject, updateProject, addTask, closeTask } = useTaskActions();
  const sortedProjects = useMemo(() => projects.slice().sort((a, b) => projectLabel(a).localeCompare(projectLabel(b), 'tr')), [projects]);
  const writableProjects = useMemo(
    () => writableSimpleModeProjects(sortedProjects, { alreadyAuthorized: true }),
    [sortedProjects]
  );
  const sortedPeople = useMemo(() => people.slice().sort((a, b) => a.name.localeCompare(b.name, 'tr')), [people]);

  const [projectChoice, setProjectChoice] = useState('');
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const [manualProjectName, setManualProjectName] = useState('');
  const [manualProjectCode, setManualProjectCode] = useState('');
  const [task, setTask] = useState('');
  const [keyword, setKeyword] = useState('');
  const [dueDate, setDueDate] = useState('');
  // Öncelik Basit Modda da tanımlanır. Katalog GELİŞMİŞ MODLA AYNIDIR
  // (domain/constants · PRIORITIES): ikinci bir öncelik modeli, aynı görevin iki
  // ekranda farklı okunmasına yol açardı.
  const [priority, setPriority] = useState(DEFAULT_PRIORITY_ID);
  const [assigneeIds, setAssigneeIds] = useState([]);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);

  const selectableProjects = useMemo(
    () => visibleProjects(writableProjects, { showArchived: showArchivedProjects }),
    [writableProjects, showArchivedProjects]
  );
  const archivedProjectCount = useMemo(() => writableProjects.filter(isArchivedProject).length, [writableProjects]);
  const projectOptions = useMemo(() => {
    const options = selectableProjects.map((project) => {
      const type = projectTypeMeta(project.projectTypeCode, project.projectTypeName);
      const ProjectIcon = Icons[type.icon] || Icons.Layers;
      return {
        value: project.id,
        label: projectLabel(project),
        group: `${type.code} · ${type.name}`,
        description: isArchivedProject(project) ? 'Tamamlanan / kapatılan' : null,
        keywords: [project.code, project.name, type.code, type.name],
        icon: <ProjectIcon size={13} />
      };
    });
    // Serbest proje seçeneği listenin BAŞINDA durur.
    return withManualProjectOption(options, canCreateProjects, {
      value: MANUAL_PROJECT,
      label: 'Serbest proje tanımla',
      description: 'Kurumsal listede olmayan yeni bir çalışma açın',
      icon: <Icons.Plus size={13} />,
      keywords: ['yeni', 'serbest', 'manuel proje', 'kurumsal olmayan']
    });
  }, [selectableProjects, canCreateProjects]);

  useEffect(() => {
    setProjectChoice((current) => resolveSimpleProjectChoice(
      current,
      selectableProjects,
      canCreateProjects,
      { alreadyAuthorized: true }
    ));
  }, [selectableProjects, canCreateProjects]);

  const selectedProject = writableProjects.find((project) => project.id === projectChoice) || null;
  const taskCreationState = useMemo(() => ({
    tasks: appState.tasks,
    projects: appState.projects,
    assignableProjects: appState.assignableProjects
  }), [appState.tasks, appState.projects, appState.assignableProjects]);
  const selectedCreationScope = useMemo(
    () => selectedProject ? taskCreationScopeInProject(taskCreationState, selectedProject.id) : null,
    [selectedProject, taskCreationState]
  );
  const assigneeCreateOnly = selectedCreationScope === 'ASSIGNEE_CREATE';
  const assignmentScopeOnly = useMemo(() => simpleAssignmentScope({
    selectedProject,
    creationScope: selectedCreationScope,
    currentUserId: currentUser?.id,
    assignmentScopeSicils
  }), [
    selectedProject,
    selectedCreationScope,
    currentUser?.id,
    assignmentScopeSicils
  ]);
  const candidatePeople = useMemo(
    () => simpleAssignmentCandidates(sortedPeople, assignmentScopeOnly),
    [sortedPeople, assignmentScopeOnly]
  );
  const candidatePersonIds = useMemo(
    () => new Set(candidatePeople.map((person) => String(person.id))),
    [candidatePeople]
  );
  // Atama kapsamındaki projenin dağılım ağacı istemciye yüklenmez; kök düğüm
  // kimliği kapsam kaydından okunur.
  const selectedRootWbsId = useMemo(
    () => findProjectRootWbsId(wbs, selectedProject?.id) || selectedProject?.rootWbsId || null,
    [wbs, selectedProject?.id, selectedProject?.rootWbsId]
  );
  const selectedPeople = useMemo(
    () => candidatePeople.filter((person) => assigneeIds.some((id) => String(id) === String(person.id))),
    [candidatePeople, assigneeIds]
  );
  const peopleMatches = useMemo(
    () => searchSimpleAssignees(candidatePeople, peopleQuery, assigneeIds),
    [candidatePeople, peopleQuery, assigneeIds]
  );
  const visiblePeople = peopleMatches.slice(0, SIMPLE_ASSIGNEE_RESULT_LIMIT);
  const hasWritableDestination = writableProjects.length > 0 || canCreateProjects;

  useEffect(() => {
    if (!assignmentScopeOnly) return;
    setAssigneeIds((current) => {
      const allowed = current.filter((id) => candidatePersonIds.has(String(id)));
      return allowed.length === current.length ? current : allowed;
    });
  }, [assignmentScopeOnly, candidatePersonIds]);

  // Basit Modda proje oluşturmak, görev tanımlamaktan bağımsız bir yetenektir:
  // kullanıcı görevleri sonra eklemek üzere yalnızca projeyi açabilir.
  const createProjectOnly = async (input) => {
    setMessage(null);
    const created = await addProject(input, { focusWorkspace: false });
    if (created?.ok) {
      setProjectChoice(created.value.id);
      setManualProjectName('');
      setManualProjectCode('');
      setMessage({
        type: 'success',
        text: `“${created.value.name}” projesi oluşturuldu. Görevleri şimdi ya da daha sonra ekleyebilirsiniz.`
      });
    }
    return created;
  };

  const togglePerson = (personId) => {
    setAssigneeIds((current) => current.includes(personId)
      ? current.filter((id) => id !== personId)
      : [...current, personId]);
  };

  // Serbest proje tanımından vazgeçildiğinde kurumsal listeye geri dönülür.
  const returnToProjectList = () => {
    setMessage(null);
    setManualProjectName('');
    setManualProjectCode('');
    setProjectChoice(resolveSimpleProjectChoice(
      '',
      selectableProjects,
      false,
      { alreadyAuthorized: true }
    ));
  };

  const resetTaskFields = () => {
    setTask('');
    setKeyword('');
    setDueDate('');
    setPriority(DEFAULT_PRIORITY_ID);
    setAssigneeIds([]);
    setPeopleQuery('');
  };

  /**
   * Hızlı girişte verilen anahtar sözcüğü kontrollü katalogla uyumlu hâle getirir.
   *
   * İki incelik vardır:
   *  - Katalogda harf farkıyla eşleşen bir etiket varsa KANONİK adı kullanılır;
   *    aksi hâlde `Analiz` katalogdayken `analiz` yazmak, katalogla birebir
   *    eşleşmeyen bir anahtar sözcük kalıcılaştırır ve görev panelinde
   *    seçeneği bulunmayan bir etiket olarak görünürdü.
   *  - Kataloğa ekleme başarısız olursa anahtar sözcük GÖREVE DE yazılmaz:
   *    görev kaydı katalog üyeliğini zorlamadığı için sonuç, katalogda
   *    karşılığı olmayan kalıcı bir etiket olurdu.
   */
  const ensureTag = async (project) => {
    const requested = keyword.trim();
    if (!requested) return { ok: true, project, keyword: '' };
    const tags = projectTagCatalog(project);
    const existing = findProjectTag(tags, requested);
    if (existing) return { ok: true, project, keyword: existing.name };
    // Atama kapsamıyla açılan projede üst veri YAZILAMAZ ve katalog boştur.
    // Katalog yazmasını denemek her seferinde reddediliyor; bu projelerde etiket
    // doğrudan görev kaydında saklanır.
    if (!canWriteProject(project)) return { ok: true, project, keyword: requested, catalogSkipped: true };
    const result = await updateProject(project.id, { tags: [...tags, { name: requested }] });
    if (!result?.ok) return { ok: false, project, keyword: '', error: result?.error };
    return { ok: true, project: result.value || project, keyword: requested };
  };

  const submit = async (event) => {
    event.preventDefault();
    setMessage(null);

    if (!hasWritableDestination || (!selectedProject && projectChoice !== MANUAL_PROJECT)) {
      setMessage({ type: 'error', text: 'Görev ekleyebileceğiniz yazılabilir bir proje bulunmuyor.' });
      return;
    }
    const requiredFieldsError = simpleTaskRequiredFieldsError({
      task,
      dueDate,
      assigneeIds,
      creationScope: selectedCreationScope
    });
    if (requiredFieldsError) {
      setMessage({ type: 'error', text: requiredFieldsError });
      return;
    }
    if (projectChoice === MANUAL_PROJECT && !manualProjectName.trim()) {
      setMessage({ type: 'error', text: 'Serbest proje için proje adını girin.' });
      return;
    }

    setSaving(true);
    let project = selectedProject;
    let targetWbsId = selectedRootWbsId;
    let tagWarning = null;
    let taskKeyword = keyword.trim();

    if (!project) {
      // Basit Mod portföy görünümünde kalır: çalışma alanı değiştirilirse bu form
      // kayıt tamamlanmadan yeniden monte edilir ve sonuç mesajı kaybolur.
      const created = await addProject({
        name: manualProjectName.trim(),
        code: manualProjectCode.trim(),
        leadId: assigneeIds[0] || people[0]?.id || '',
        dataDate: fmtISO(today()),
        color: 'blue',
        tags: keyword.trim() ? [keyword.trim()] : [],
        source: 'manual'
      }, { focusWorkspace: false });
      if (!created?.ok) {
        setSaving(false);
        setMessage({ type: 'error', text: created?.error?.message || 'Proje oluşturulamadı.' });
        return;
      }
      project = created.value;
      // Kök düğüm önce sunucunun döndürdüğü değişiklik kümesinden, bulunamazsa
      // güncel uygulama durumundan çözülür. Böylece tek bir kaynağa bağımlı kalmayız.
      targetWbsId = created.rootWbs?.id
        || created.changes?.wbsUpserts?.find(
          (node) => node.projectId === project.id && node.parentId == null
        )?.id
        || findProjectRootWbsId(wbs, project.id);
      setProjectChoice(project.id);
      setManualProjectName('');
      setManualProjectCode('');
    } else {
      // Etiket kataloğuna ekleme, görev kaydından bağımsız ikincil bir yazmadır.
      // Proje satırı yazılamıyorsa (salt okunur kurumsal alan, sürüm çakışması vb.)
      // asıl işlem olan görev oluşturma engellenmez; yalnızca uyarı gösterilir.
      const tagged = await ensureTag(project);
      project = tagged.project || project;
      if (tagged.ok) {
        taskKeyword = tagged.keyword;
      } else {
        taskKeyword = '';
        tagWarning = `${tagged.error?.message || 'Etiket proje kataloğuna eklenemedi.'} Görev etiketsiz oluşturuldu; etiketi Proje Yapısı sayfasından tanımlayıp göreve atayabilirsiniz.`;
      }
    }

    if (!targetWbsId) {
      setSaving(false);
      setMessage({ type: 'error', text: 'Projenin kök iş dağılım düğümü bulunamadı. Proje Yapısı sayfasından kök düğümü oluşturun.' });
      return;
    }

    const selectedPeopleForTask = assigneeIds.map((id) => people.find((person) => person.id === id)).filter(Boolean);
    const createdTask = await addTask({
      projectId: project.id,
      projectCode: project.code || '',
      proje: project.name,
      color: project.color || 'blue',
      wbsId: targetWbsId,
      task: task.trim(),
      keyword: taskKeyword,
      assigneeIds: [...assigneeIds],
      sorumlu: selectedPeopleForTask.map((person) => person.name),
      status: 'todo',
      priority: normalizePriorityId(priority),
      progress: 0,
      plannedStart: dueDate,
      plannedFinish: dueDate,
      targetFinish: dueDate,
      ...(!assigneeCreateOnly ? {
        actualStart: null,
        actualFinish: null,
        plannedDurationDays: null,
        remainingDurationDays: null,
        plannedHours: 0,
        actualHours: 0
      } : {}),
      deps: []
    });

    if (!createdTask?.ok || !createdTask.value) {
      setSaving(false);
      setMessage({ type: 'error', text: createdTask?.error?.message || 'Görev oluşturulamadı.' });
      return;
    }

    await closeTask();
    resetTaskFields();
    setSaving(false);
    setMessage(tagWarning
      ? { type: 'warning', text: `Kayıt Takvim görünümüne eklendi. Etiket kataloğu güncellenemedi: ${tagWarning}` }
      : { type: 'success', text: 'Kayıt Takvim görünümüne eklendi.' });
  };

  return (
    // Proje oluşturma penceresi form ağacının DIŞINDA durur: iç içe <form>
    // öğeleri geçersizdir ve tarayıcı iç formu yok sayar.
    <>
      <form className="simple-entry-card" onSubmit={submit}>
        <div className="simple-entry-head">
          <div>
            <span className="simple-mode-badge"><Icons.Sparkle size={12} /> Basit Mod</span>
            <h2>Hızlı görev tanımı</h2>
            <p>Yalnızca gerekli bilgileri girin. Kayıt aynı proje ve görev altyapısında tutulur ve gelişmiş modda da kullanılabilir.</p>
          </div>
          <div className="simple-entry-actions">
            <div className="simple-entry-flow" aria-label="Basit mod akışı">
              <span>Tanımla</span><i>→</i><span>Takvimde izle</span><i>→</i><span>Gerekirse geliştir</span>
            </div>
            {/* Görev tanımlamadan yalnızca proje açma yolu. */}
            <button
              type="button"
              className="btn"
              onClick={() => setProjectCreateOpen(true)}
              disabled={!canCreateProjects || saving}
              title={canCreateProjects
                ? 'Görev eklemeden yalnızca yeni bir proje oluşturun'
                : 'Bu oturumda proje oluşturma yetkiniz bulunmuyor.'}
            >
              <Icons.Plus size={13} /> Yeni proje
            </button>
          </div>
        </div>

        <div className="simple-entry-grid">
          <div className="simple-field simple-project-field">
            <span>Proje</span>
            <SearchableSelect
              value={projectChoice}
              options={projectOptions}
              onChange={(value) => { setProjectChoice(value); setMessage(null); }}
              placeholder={hasWritableDestination ? 'Proje seçin' : 'Yazılabilir proje yok'}
              searchPlaceholder="Proje kodu, adı veya türüyle ara"
              disabled={!hasWritableDestination}
              maxVisible={70}
            />
            {archivedProjectCount > 0 && (
              <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, fontSize: 10.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={showArchivedProjects} onChange={(event) => setShowArchivedProjects(event.target.checked)} />
                Tamamlanan ve kapatılanları göster ({archivedProjectCount})
              </label>
            )}
          </div>

          {projectChoice === MANUAL_PROJECT && canCreateProjects && (
            <>
              <label className="simple-field">
                <span>Proje kodu <small>isteğe bağlı</small></span>
                <input className="input" value={manualProjectCode} onChange={(event) => setManualProjectCode(event.target.value)} placeholder="Örn. PRJ-2026-041" />
              </label>
              <label className="simple-field">
                <span>Proje adı</span>
                <input className="input" value={manualProjectName} onChange={(event) => setManualProjectName(event.target.value)} placeholder="Proje veya çalışma adı" />
              </label>
              {/* Serbest proje tanımından kurumsal listeye tek tıkla dönüş. */}
              <div className="simple-field simple-project-back">
                <button type="button" className="btn ghost sm" onClick={returnToProjectList} disabled={!selectableProjects.length}>
                  <Icons.ArrowLeft size={13} /> Kurumsal proje listesine dön
                </button>
              </div>
            </>
          )}

          <label className="simple-field simple-task-field">
            <span>Görev</span>
            <input className="input" value={task} onChange={(event) => setTask(event.target.value)} placeholder="Yapılacak işi yazın" disabled={!hasWritableDestination} />
          </label>
          <label className="simple-field">
            <span>Anahtar sözcük / kısa açıklama <small>isteğe bağlı</small></span>
            <input className="input" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="Örn. Teklif, Onay, Teslim" disabled={!hasWritableDestination} />
          </label>
          <label className="simple-field">
            <span>Termin tarihi</span>
            <DateInput
              value={dueDate}
              onChange={(value) => { setDueDate(value); setMessage(null); }}
              disabled={!hasWritableDestination}
            />
          </label>
          <div className="simple-field">
            <span>Öncelik</span>
            <div className="simple-priority-picker" role="group" aria-label="Görev önceliği">
              {Object.values(PRIORITIES).map((option) => {
                const active = normalizePriorityId(priority) === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`simple-priority-option${active ? ' active' : ''}`}
                    aria-pressed={active}
                    style={{ '--priority-color': option.color }}
                    disabled={!hasWritableDestination}
                    onClick={() => { setPriority(option.id); setMessage(null); }}
                  >
                    <Icons.Flag size={11} /> {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {!hasWritableDestination && (
          <div className="simple-message error">Bu oturumda yalnızca salt okunur projeler görünür. Görev eklemek için tam proje yetkisi gerekir.</div>
        )}

        <div className="simple-people-block">
          <div className="simple-people-title">
            <span>Sorumlular</span>
            <small>{assigneeIds.length} kişi seçili · {candidatePeople.length} kişi</small>
          </div>
          <label className="simple-people-search">
            <Icons.Search size={14} />
            <input
              value={peopleQuery}
              onChange={(event) => setPeopleQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
              placeholder="Ad, sicil, unvan veya birimle ara"
              aria-label="Sorumlu ara"
              disabled={!hasWritableDestination}
            />
          </label>

          {selectedPeople.length > 0 && (
            <div className="simple-people-selection">
              <div className="simple-people-results-title">Seçilenler</div>
              <div className="simple-people-grid">
                {selectedPeople.map((person) => (
                  <PersonChoice key={person.id} person={person} active onToggle={togglePerson} />
                ))}
              </div>
            </div>
          )}

          {!peopleQuery.trim() ? (
            <div className="simple-people-empty">Ad, sicil, unvan veya birim yazarak sorumlu arayın.</div>
          ) : (
            <>
              <div className="simple-people-results-title">
                <span>Arama sonuçları</span>
                <small>{peopleMatches.length} eşleşme</small>
              </div>
              <div className="simple-people-grid">
                {visiblePeople.map((person) => (
                  <PersonChoice key={person.id} person={person} active={false} onToggle={togglePerson} />
                ))}
              </div>
              {visiblePeople.length === 0 && <div className="simple-people-empty">Eşleşen sorumlu bulunamadı.</div>}
              {peopleMatches.length > SIMPLE_ASSIGNEE_RESULT_LIMIT && (
                <div className="simple-people-hint">
                  İlk {SIMPLE_ASSIGNEE_RESULT_LIMIT} sonuç gösteriliyor. Arama alanını kullanarak listeyi daraltın.
                </div>
              )}
            </>
          )}
        </div>

        <div className="simple-entry-foot">
          {message && <div className={`simple-message ${message.type}`}>{message.text}</div>}
          <button className="btn primary simple-save" type="submit" disabled={saving || candidatePeople.length === 0 || !hasWritableDestination}>
            <Icons.Plus size={14} /> {saving ? 'Kaydediliyor...' : 'Takvime ekle'}
          </button>
        </div>

      </form>

      <ProjectCreateDialog
        open={projectCreateOpen}
        people={people}
        onCreate={createProjectOnly}
        onClose={() => setProjectCreateOpen(false)}
      />
    </>
  );
}