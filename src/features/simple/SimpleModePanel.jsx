'use client';
import { useMemo, useState } from 'react';
import { Icons } from '../../components/icons';
import { Avatar } from '../../components/ui';
import { fmtISO, today } from '../../scheduling/dates';
import { useAllPeople, useAllProjects, useTaskActions } from '../../state/hooks';

const MANUAL_PROJECT = '__manual_project__';

function projectLabel(project) {
  return project.code ? `${project.code} · ${project.name}` : project.name;
}

function personNumber(person) {
  return person.employeeNo || person.SicilNo || person.PersonelNo || person.id;
}

export function SimpleModePanel() {
  const projects = useAllProjects();
  const people = useAllPeople();
  const { addProject, updateProject, addTask, updateTask, closeTask, selectWorkspace } = useTaskActions();
  const sortedProjects = useMemo(() => projects.slice().sort((a, b) => projectLabel(a).localeCompare(projectLabel(b), 'tr')), [projects]);
  const sortedPeople = useMemo(() => people.slice().sort((a, b) => a.name.localeCompare(b.name, 'tr')), [people]);

  const [projectChoice, setProjectChoice] = useState(sortedProjects[0]?.id || MANUAL_PROJECT);
  const [manualProjectName, setManualProjectName] = useState('');
  const [manualProjectCode, setManualProjectCode] = useState('');
  const [task, setTask] = useState('');
  const [keyword, setKeyword] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [assigneeIds, setAssigneeIds] = useState([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const selectedProject = projects.find((project) => project.id === projectChoice) || null;

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
  };

  const ensureTag = async (project) => {
    if (!keyword.trim()) return { ok: true, value: project };
    const tags = Array.isArray(project.tags) ? project.tags : [];
    if (tags.some((tag) => tag.toLocaleLowerCase('tr-TR') === keyword.trim().toLocaleLowerCase('tr-TR'))) {
      return { ok: true, value: project };
    }
    return updateProject(project.id, {
      name: project.name,
      code: project.code || '',
      leadId: project.leadId || people[0]?.id || '',
      dataDate: project.dataDate || fmtISO(today()),
      color: project.color || 'blue',
      tags: [...tags, keyword.trim()],
      source: project.source || 'manual'
    });
  };

  const submit = async (event) => {
    event.preventDefault();
    setMessage(null);

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

    selectWorkspace(null);
    const createdTask = await addTask();
    if (!createdTask?.ok || !createdTask.value) {
      setSaving(false);
      setMessage({ type: 'error', text: createdTask?.error?.message || 'Görev oluşturulamadı.' });
      return;
    }

    const selectedPeople = assigneeIds.map((id) => people.find((person) => person.id === id)).filter(Boolean);
    const saved = await updateTask(createdTask.value.id, {
      proje: project.name,
      projectCode: project.code || '',
      task: task.trim(),
      keyword: keyword.trim(),
      sorumlu: selectedPeople.map((person) => person.name),
      status: 'todo',
      priority: 'medium',
      progress: 0,
      plannedStart: dueDate,
      plannedFinish: dueDate,
      targetFinish: dueDate,
      plannedHours: 0,
      actualHours: 0,
      deps: []
    });

    if (!saved?.ok) {
      setSaving(false);
      setMessage({ type: 'error', text: saved?.error?.message || 'Görev kaydedilemedi.' });
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
          <select className="input" value={projectChoice} onChange={(event) => { setProjectChoice(event.target.value); setMessage(null); }}>
            {sortedProjects.map((project) => <option key={project.id} value={project.id}>{projectLabel(project)}</option>)}
            <option value={MANUAL_PROJECT}>+ Serbest proje tanımla</option>
          </select>
        </label>

        {projectChoice === MANUAL_PROJECT && (
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
          <input className="input" value={task} onChange={(event) => setTask(event.target.value)} placeholder="Yapılacak işi yazın" />
        </label>
        <label className="simple-field">
          <span>Anahtar sözcük / kısa açıklama</span>
          <input className="input" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="Örn. Teklif, Onay, Teslim" />
        </label>
        <label className="simple-field">
          <span>Termin tarihi</span>
          <input className="input" type="date" lang="en-GB" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
        </label>
      </div>

      <div className="simple-people-block">
        <div className="simple-people-title"><span>Sorumlular</span><small>{assigneeIds.length} kişi seçili</small></div>
        <div className="simple-people-grid">
          {sortedPeople.map((person) => {
            const active = assigneeIds.includes(person.id);
            return (
              <button key={person.id} type="button" className={`simple-person${active ? ' active' : ''}`} onClick={() => togglePerson(person.id)}>
                <Avatar name={person.name} size="sm" />
                <span><strong>{person.name}</strong><small>{personNumber(person)}</small></span>
                {active && <Icons.Check size={13} />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="simple-entry-foot">
        {message && <div className={`simple-message ${message.type}`}>{message.text}</div>}
        <button className="btn primary simple-save" type="submit" disabled={saving || people.length === 0}>
          <Icons.Plus size={14} /> {saving ? 'Kaydediliyor...' : 'Takvime ekle'}
        </button>
      </div>
    </form>
  );
}
