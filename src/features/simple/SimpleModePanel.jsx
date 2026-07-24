'use client';
import { useEffect, useMemo, useState } from 'react';
import { DateInput } from '../../components/DateInput';
import { Icons } from '../../components/icons';
import { Avatar } from '../../components/ui';
import { fmtISO, today } from '../../scheduling/dates';
import { useAppState } from '../../state/AppStateProvider';
import { useAllPeople, useAllProjects, useAllWbs, useTaskActions } from '../../state/hooks';
import {
  findProjectRootWbsId,
  resolveSimpleProjectChoice,
  writableSimpleModeProjects
} from './simpleModePolicy.js';

const MANUAL_PROJECT = '__manual_project__';
const MAX_VISIBLE_PEOPLE = 8;

function projectLabel(project) {
  return project.code ? `${project.code} · ${project.name}` : project.name;
}

function personNumber(person) {
  return person.employeeNo || person.SicilNo || person.PersonelNo || person.id;
}

function PersonChoice({ person, active, onToggle }) {
  return (
    <button type="button" className={`simple-person${active ? ' active' : ''}`} onClick={() => onToggle(person.id)}>
      <Avatar name={person.name} size="sm" />
      <span><strong>{person.name}</strong><small>{personNumber(person)}</small></span>
      {active ? <Icons.Check size={13} /> : <Icons.Plus size={13} />}
    </button>
  );
}

export function SimpleModePanel() {
  const projects = useAllProjects();
  const people = useAllPeople();
  const wbs = useAllWbs();
  const { canCreateProjects } = useAppState();
  const { addProject, updateProject, addTask, closeTask, selectWorkspace } = useTaskActions();
  const sortedProjects = useMemo(() => projects.slice().sort((a, b) => projectLabel(a).localeCompare(projectLabel(b), 'tr')), [projects]);
  const writableProjects = useMemo(() => writableSimpleModeProjects(sortedProjects), [sortedProjects]);
  const sortedPeople = useMemo(() => people.slice().sort((a, b) => a.name.localeCompare(b.name, 'tr')), [people]);

  const [projectChoice, setProjectChoice] = useState('');
  const [manualProjectName, setManualProjectName] = useState('');
  const [manualProjectCode, setManualProjectCode] = useState('');
  const [task, setTask] = useState('');
  const [keyword, setKeyword] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [assigneeIds, setAssigneeIds] = useState([]);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    setProjectChoice((current) => resolveSimpleProjectChoice(current, writableProjects, canCreateProjects));
  }, [writableProjects, canCreateProjects]);

  const selectedProject = writableProjects.find((project) => project.id === projectChoice) || null;
  const selectedRootWbsId = useMemo(
    () => findProjectRootWbsId(wbs, selectedProject?.id),
    [wbs, selectedProject?.id]
  );
  const selectedPeople = useMemo(
    () => sortedPeople.filter((person) => assigneeIds.includes(person.id)),
    [sortedPeople, assigneeIds]
  );
  const peopleMatches = useMemo(() => {
    const query = peopleQuery.trim().toLocaleLowerCase('tr-TR');
    return sortedPeople.filter((person) => {
      if (assigneeIds.includes(person.id)) return false;
      if (!query) return true;
      return `${person.name} ${personNumber(person)}`.toLocaleLowerCase('tr-TR').includes(query);
    });
  }, [sortedPeople, peopleQuery, assigneeIds]);
  const visiblePeople = peopleMatches.slice(0, MAX_VISIBLE_PEOPLE);
  const hasWritableDestination = writableProjects.length > 0 || canCreateProjects;

  const togglePerson = (personId) => {
    setAssigneeIds((current) => current.includes(personId)
      ? current.filter((id) => id !== personId)
      : [...current, personId]);
  };

  const resetTaskFields = () => {
    setTask('');
    setKeyword('');
    setDueDate('');
    setAssigneeIds([]);
    setPeopleQuery('');
  };

  const ensureTag = async (project) => {
    if (!keyword.trim()) return { ok: true, value: project };
    const tags = Array.isArray(project.tags) ? project.tags : [];
    if (tags.some((tag) => tag.toLocaleLowerCase('tr-TR') === keyword.trim().toLocaleLowerCase('tr-TR'))) {
      return { ok: true, value: project };
    }
    return updateProject(project.id, { tags: [...tags, keyword.trim()] });
  };

  const submit = async (event) => {
    event.preventDefault();
    setMessage(null);

    if (!hasWritableDestination || (!selectedProject && projectChoice !== MANUAL_PROJECT)) {
      setMessage({ type: 'error', text: 'Görev ekleyebileceğiniz yazılabilir bir proje bulunmuyor.' });
      return;
    }
    if (!task.trim() || !keyword.trim() || !dueDate || assigneeIds.length === 0) {
      setMessage({ type: 'error', text: 'Görev, kısa açıklama, sorumlu ve termin tarihi alanlarını tamamlayın.' });
      return;
    }
    if (projectChoice === MANUAL_PROJECT && !manualProjectName.trim()) {
      setMessage({ type: 'error', text: 'Serbest proje için proje adını girin.' });
      return;
    }

    setSaving(true);
    let project = selectedProject;
    let targetWbsId = selectedRootWbsId;

    if (!project) {
      const created = await addProject({
        name: manualProjectName.trim(),
        code: manualProjectCode.trim(),
        leadId: assigneeIds[0] || people[0]?.id || '',
        dataDate: fmtISO(today()),
        color: 'blue',
        tags: [keyword.trim()],
        source: 'manual'
      });
      if (!created?.ok) {
        setSaving(false);
        setMessage({ type: 'error', text: created?.error?.message || 'Proje oluşturulamadı.' });
        return;
      }
      project = created.value;
      targetWbsId = created.changes?.wbsUpserts?.find(
        (node) => node.projectId === project.id && node.parentId == null
      )?.id || null;
      setProjectChoice(project.id);
      setManualProjectName('');
      setManualProjectCode('');
    } else {
      const tagged = await ensureTag(project);
      if (!tagged?.ok) {
        setSaving(false);
        setMessage({ type: 'error', text: tagged?.error?.message || 'Proje etiketi güncellenemedi.' });
        return;
      }
      project = tagged.value || project;
    }

    if (!targetWbsId) {
      setSaving(false);
      setMessage({ type: 'error', text: 'Projenin kök iş dağılım düğümü bulunamadı.' });
      return;
    }

    const selectedPeopleForTask = assigneeIds.map((id) => people.find((person) => person.id === id)).filter(Boolean);
    selectWorkspace(null);
    const createdTask = await addTask({
      projectId: project.id,
      projectCode: project.code || '',
      proje: project.name,
      color: project.color || 'blue',
      wbsId: targetWbsId,
      task: task.trim(),
      keyword: keyword.trim(),
      assigneeIds: [...assigneeIds],
      sorumlu: selectedPeopleForTask.map((person) => person.name),
      status: 'todo',
      priority: 'medium',
      progress: 0,
      plannedStart: dueDate,
      plannedFinish: dueDate,
      targetFinish: dueDate,
      actualStart: null,
      actualFinish: null,
      plannedDurationDays: null,
      remainingDurationDays: null,
      plannedHours: 0,
      actualHours: 0,
      deps: []
    });

    if (!createdTask?.ok || !createdTask.value) {
      setSaving(false);
      setMessage({ type: 'error', text: createdTask?.error?.message || 'Görev oluşturulamadı.' });
      return;
    }

    await closeTask();
    selectWorkspace(null);
    resetTaskFields();
    setSaving(false);
    setMessage({ type: 'success', text: 'Kayıt Takvim görünümüne eklendi.' });
  };

  return (
    <form className="simple-entry-card" onSubmit={submit}>
      <div className="simple-entry-head">
        <div>
          <span className="simple-mode-badge"><Icons.Sparkle size={12} /> Basit Mod</span>
          <h2>Hızlı görev tanımı</h2>
          <p>Yalnızca gerekli bilgileri girin. Kayıt aynı proje ve görev altyapısında tutulur ve gelişmiş modda da kullanılabilir.</p>
        </div>
        <div className="simple-entry-flow" aria-label="Basit mod akışı">
          <span>Tanımla</span><i>→</i><span>Takvimde izle</span><i>→</i><span>Gerekirse geliştir</span>
        </div>
      </div>

      <div className="simple-entry-grid">
        <label className="simple-field simple-project-field">
          <span>Proje</span>
          <select className="input" value={projectChoice} onChange={(event) => { setProjectChoice(event.target.value); setMessage(null); }} disabled={!hasWritableDestination}>
            {writableProjects.map((project) => <option key={project.id} value={project.id}>{projectLabel(project)}</option>)}
            {canCreateProjects && <option value={MANUAL_PROJECT}>+ Serbest proje tanımla</option>}
            {!hasWritableDestination && <option value="">Yazılabilir proje yok</option>}
          </select>
        </label>

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
          </>
        )}

        <label className="simple-field simple-task-field">
          <span>Görev</span>
          <input className="input" value={task} onChange={(event) => setTask(event.target.value)} placeholder="Yapılacak işi yazın" disabled={!hasWritableDestination} />
        </label>
        <label className="simple-field">
          <span>Anahtar sözcük / kısa açıklama</span>
          <input className="input" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="Örn. Teklif, Onay, Teslim" disabled={!hasWritableDestination} />
        </label>
        <label className="simple-field">
          <span>Termin tarihi</span>
          <DateInput value={dueDate} onChange={(value) => { setDueDate(value); setMessage(null); }} disabled={!hasWritableDestination} />
        </label>
      </div>

      {!hasWritableDestination && (
        <div className="simple-message error">Bu oturumda yalnızca salt okunur projeler görünür. Görev eklemek için tam proje yetkisi gerekir.</div>
      )}

      <div className="simple-people-block">
        <div className="simple-people-title">
          <span>Sorumlular</span>
          <small>{assigneeIds.length} kişi seçili · {people.length} kişi</small>
        </div>
        <label className="simple-people-search">
          <Icons.Search size={14} />
          <input
            value={peopleQuery}
            onChange={(event) => setPeopleQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
            placeholder="Ad veya personel numarasıyla ara"
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

        <div className="simple-people-results-title">
          <span>{peopleQuery.trim() ? 'Arama sonuçları' : 'Hızlı seçim'}</span>
          <small>{peopleMatches.length} eşleşme</small>
        </div>
        <div className="simple-people-grid">
          {visiblePeople.map((person) => (
            <PersonChoice key={person.id} person={person} active={false} onToggle={togglePerson} />
          ))}
        </div>
        {visiblePeople.length === 0 && <div className="simple-people-empty">Eşleşen başka kişi yok.</div>}
        {peopleMatches.length > MAX_VISIBLE_PEOPLE && (
          <div className="simple-people-hint">
            İlk {MAX_VISIBLE_PEOPLE} sonuç gösteriliyor. Arama alanını kullanarak listeyi daraltın.
          </div>
        )}
      </div>

      <div className="simple-entry-foot">
        {message && <div className={`simple-message ${message.type}`}>{message.text}</div>}
        <button className="btn primary simple-save" type="submit" disabled={saving || people.length === 0 || !hasWritableDestination}>
          <Icons.Plus size={14} /> {saving ? 'Kaydediliyor...' : 'Takvime ekle'}
        </button>
      </div>
    </form>
  );
}
