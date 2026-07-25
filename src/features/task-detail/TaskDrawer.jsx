'use client';
import { useEffect, useMemo, useState } from 'react';
import { DateInput } from '../../components/DateInput';
import { Icons } from '../../components/icons';
import { SearchableSelect } from '../../components/SearchableSelect';
import { buildWbsTree, flattenWbsTree, formatWbsPath } from '../../domain/selectors/index.js';
import { isArchivedProject, projectTypeMeta, visibleProjects } from '../../domain/projectTypes';
import {
  LAG_UNITS,
  REL_TYPES,
  depId,
  dependencyLagDays,
  formatDependencyLag,
  lagUnitOf,
  lagValueOf,
  relTypeOf
} from '../../scheduling/dependencies';
import { diffDays, fmt, today } from '../../scheduling/dates';
import { getTaskCalendarWarnings } from '../../scheduling/calendarWarnings';
import { projectColorVar } from '../../lib/colors';
import { Avatar, Kw, StatusIcon, statusColorVar } from '../../components/ui';
import { InfoButton } from '../../components/ui-extras';
import { useAllPeople, useAllProjects, useAllWbs, useCalendars, useTaskPrimaryBaseline } from '../../state/hooks';

function legacyProjectTags(projectId, tasks) {
  return Array.from(new Set(
    tasks
      .filter((item) => item.projectId === projectId && String(item.keyword || '').trim() && String(item.keyword).trim() !== 'Yeni')
      .map((item) => String(item.keyword).trim())
  )).sort((a, b) => a.localeCompare(b, 'tr'));
}

function tagsForProject(project, tasks) {
  if (!project) return [];
  return Array.isArray(project.tags) ? project.tags : legacyProjectTags(project.id, tasks);
}

function projectLabel(project) {
  if (!project) return '';
  return project.code ? `${project.code} · ${project.name}` : project.name;
}

function personLabel(person) {
  const employeeNo = person.employeeNo || person.SicilNo || person.PersonelNo || person.CalisanNo;
  return employeeNo ? `${employeeNo} · ${person.name}` : person.name;
}

export function TaskDrawer({ task, tasks, onClose, onUpdate, onDelete }) {
  const people = useAllPeople();
  const projects = useAllProjects();
  const calendars = useCalendars();
  const allWbs = useAllWbs();
  const { baseline, snapshot: baselineSnapshot } = useTaskPrimaryBaseline(task.id);
  const [local, setLocal] = useState({ ...task });

  useEffect(() => { setLocal({ ...task }); }, [task]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === local.projectId) || null,
    [projects, local.projectId]
  );
  const projectTags = useMemo(() => tagsForProject(selectedProject, tasks), [selectedProject, tasks]);
  const calendarWarnings = useMemo(
    () => getTaskCalendarWarnings(local, { projects, calendars }),
    [local, projects, calendars]
  );

  const projectWbsRows = useMemo(() => {
    const projectWbs = allWbs.filter((node) => node.projectId === local.projectId);
    return flattenWbsTree(buildWbsTree(projectWbs));
  }, [allWbs, local.projectId]);

  const projectOptions = useMemo(() => {
    const listed = visibleProjects(projects);
    if (selectedProject && !listed.some((project) => project.id === selectedProject.id)) listed.unshift(selectedProject);
    return [
      { value: '', label: 'Proje seçilmedi', icon: <Icons.Layers size={13} /> },
      ...listed.map((project) => {
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
      })
    ];
  }, [projects, selectedProject]);

  const selectedAssignees = useMemo(() => {
    const records = [];
    const usedNames = new Set();
    for (const id of local.assigneeIds || []) {
      const person = people.find((item) => String(item.id) === String(id));
      if (!person) continue;
      records.push({ id: person.id, name: person.name, person });
      usedNames.add(person.name);
    }
    for (const name of local.sorumlu || []) {
      if (usedNames.has(name)) continue;
      const person = people.find((item) => item.name === name) || null;
      records.push({ id: person?.id || name, name, person });
      usedNames.add(name);
    }
    return records;
  }, [people, local.assigneeIds, local.sorumlu]);

  const personOptions = useMemo(() => {
    const selectedIds = new Set(selectedAssignees.map((record) => String(record.id)));
    const selectedNames = new Set(selectedAssignees.map((record) => record.name));
    return people
      .filter((person) => !selectedIds.has(String(person.id)) && !selectedNames.has(person.name))
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name, 'tr'))
      .map((person) => ({
        value: person.id,
        label: personLabel(person),
        description: person.role || null,
        group: [person.organization?.directorate, person.organization?.department, person.organization?.unit].filter(Boolean).join(' / '),
        keywords: [person.name, person.employeeNo, person.username, person.role, person.team],
        icon: <Avatar name={person.name} size="sm" />
      }));
  }, [people, selectedAssignees]);

  const save = (patch) => {
    const next = { ...local, ...patch };
    setLocal(next);
    onUpdate(task.id, patch);
  };

  useEffect(() => {
    if (local.keyword !== 'Yeni' || projectTags.includes('Yeni')) return;
    setLocal((current) => ({ ...current, keyword: '' }));
    onUpdate(task.id, { keyword: '' });
  }, [local.keyword, projectTags, task.id, onUpdate]);

  const changeProject = (projectId) => {
    const project = projects.find((item) => item.id === projectId) || null;
    const tags = tagsForProject(project, tasks);
    const roots = allWbs.filter((node) => node.projectId === projectId && node.parentId == null);
    save({
      projectId: projectId || null,
      projectCode: project?.code || '',
      proje: project?.name || '',
      color: project?.color || local.color,
      wbsId: roots.length === 1 ? roots[0].id : null,
      keyword: tags.includes(local.keyword) ? local.keyword : (tags[0] || '')
    });
  };

  const addAssignee = (personId) => {
    const person = people.find((item) => String(item.id) === String(personId));
    if (!person) return;
    const assigneeIds = [...new Set([...(local.assigneeIds || []).map(String), String(person.id)])];
    const sorumlu = [...new Set([...(local.sorumlu || []), person.name])];
    save({ assigneeIds, sorumlu });
  };

  const removeAssignee = (record) => {
    save({
      assigneeIds: (local.assigneeIds || []).filter((id) => String(id) !== String(record.id)),
      sorumlu: (local.sorumlu || []).filter((name) => name !== record.name)
    });
  };

  const today_ = today();
  const overdue = local.status !== 'done' && local.targetFinish && diffDays(local.targetFinish, today_) < 0;
  const color = projectColorVar(local.proje);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div className="col" style={{ gap: 8, flex: 1 }}>
            <div className="row" style={{ gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: color }} />
              <span className="muted" style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                {projectLabel(selectedProject) || local.proje}
              </span>
              {local.keyword && <><span className="muted">·</span><Kw color={local.color}>{local.keyword}</Kw></>}
            </div>
            <textarea
              value={local.task}
              onChange={(e) => save({ task: e.target.value })}
              rows={2}
              style={{
                border: 0, background: 'transparent', resize: 'none',
                font: 'inherit', fontSize: 18, fontWeight: 600, lineHeight: 1.35,
                color: 'var(--text)', letterSpacing: '-0.015em', outline: 'none',
                padding: 0, width: '100%'
              }}
            />
          </div>
          <button className="icon-btn" onClick={onClose} title="Kapat (Esc)"><Icons.Close size={16} /></button>
        </div>

        <div className="drawer-body">
          <div className="col" style={{ gap: 18 }}>
            <Section title="Durum">
              <div className="seg" style={{ width: '100%' }}>
                {[
                  ['todo', 'Yapılacak', statusColorVar('todo'), 'todo'],
                  ['in_progress', 'Devam ediyor', statusColorVar('in_progress'), 'in_progress'],
                  ['done', 'Tamamlandı', statusColorVar('done'), 'done']
                ].map(([id, label, statusColor, iconId]) => {
                  const isActive = (local.status || 'todo') === id;
                  return (
                    <button
                      key={id}
                      className={isActive ? 'active' : ''}
                      onClick={() => save({ status: id })}
                      style={{
                        flex: 1,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                        color: isActive ? statusColor : 'var(--text-muted)',
                        background: isActive ? `color-mix(in oklab, ${statusColor} 14%, transparent)` : 'transparent',
                        fontWeight: 600
                      }}
                    >
                      <StatusIcon id={iconId} size={12} /> {label}
                    </button>
                  );
                })}
              </div>
            </Section>

            <Section title="Proje, WBS & Etiket">
              <div className="task-project-wbs-grid">
                <div className="col" style={{ gap: 6 }}>
                  <div className="label">Proje</div>
                  <SearchableSelect
                    value={local.projectId || ''}
                    options={projectOptions}
                    onChange={changeProject}
                    placeholder="Proje seçilmedi"
                    searchPlaceholder="Proje kodu, adı veya türüyle ara"
                    maxVisible={60}
                  />
                </div>
                <div className="col" style={{ gap: 6 }}>
                  <div className="label">WBS</div>
                  <select
                    className="input"
                    value={local.wbsId || ''}
                    onChange={(e) => save({ wbsId: e.target.value || null })}
                    disabled={!local.projectId || projectWbsRows.length === 0}
                  >
                    <option value="">WBS seçilmedi</option>
                    {projectWbsRows.map(({ node, depth }) => (
                      <option key={node.id} value={node.id}>
                        {`${'— '.repeat(depth)}${formatWbsPath(allWbs, node.id)}`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <div className="label">Etiket</div>
                <select
                  className="input"
                  value={local.keyword || ''}
                  onChange={(e) => save({ keyword: e.target.value })}
                  disabled={!local.projectId || projectTags.length === 0}
                >
                  <option value="">{projectTags.length ? 'Etiket seçin' : 'Önce Proje Yapısı sayfasında etiket tanımlayın'}</option>
                  {projectTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
                </select>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  Görev etiketi serbest metin değildir; seçili projenin kontrollü etiket kataloğundan açıkça seçilir.
                </div>
              </div>
            </Section>

            <Section title="Sorumlular">
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {selectedAssignees.map((record) => (
                  <span key={`${record.id}:${record.name}`} className="row" style={{ gap: 6, padding: '3px 8px 3px 4px', border: '1px solid var(--border)', borderRadius: 'var(--r-pill)', background: 'var(--bg-elev-2)' }}>
                    <Avatar name={record.name} size="sm" />
                    <span style={{ fontSize: 12 }}>{record.name}</span>
                    <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => removeAssignee(record)}><Icons.Close size={10} /></button>
                  </span>
                ))}
              </div>
              <SearchableSelect
                value=""
                options={personOptions}
                onChange={addAssignee}
                placeholder="+ Sorumlu ekle"
                searchPlaceholder="Ad, sicil, unvan veya birimle ara"
                emptyText="Eklenebilecek başka personel bulunamadı."
                maxVisible={60}
                compact
              />
            </Section>

            <Section title="Güncel Plan">
              <div className="task-date-grid">
                <DateField label="Planlanan Başlangıç" value={local.plannedStart} onChange={(v) => save({ plannedStart: v })} />
                <DateField label="Planlanan Bitiş" value={local.plannedFinish} onChange={(v) => save({ plannedFinish: v })} />
                <DateField label="Hedef Bitiş" value={local.targetFinish} onChange={(v) => save({ targetFinish: v })} accent={overdue ? 'var(--status-overdue)' : null} />
              </div>
              <div className="muted" style={{ fontSize: 11.5 }}>
                Planlanan süre: <span className="tabular">{local.plannedDurationDays ?? '—'}</span> çalışma günü
              </div>
              {calendarWarnings.length > 0 && (
                <div className="calendar-warning">
                  <strong>Çalışma takvimi uyarısı</strong>
                  {calendarWarnings.map((warning) => (
                    <div key={warning.field}>{warning.label}: {fmt(warning.date, 'dd MMM yyyy')} · {warning.reason}</div>
                  ))}
                </div>
              )}
            </Section>

            <Section title="Gerçekleşen & Kalan">
              <div className="task-date-grid">
                <DateField label="Gerçekleşen Başlangıç" value={local.actualStart} onChange={(v) => save({ actualStart: v })} nullable />
                <DateField label="Gerçekleşen Bitiş" value={local.actualFinish} onChange={(v) => save({ actualFinish: v })} nullable />
                <NumberField label="Kalan Süre" value={local.remainingDurationDays} onChange={(v) => save({ remainingDurationDays: v })} suffix="gün" />
              </div>
            </Section>

            {baselineSnapshot && (
              <Section title={`Baz Plan · ${baseline?.name || 'Birincil Baz Plan'}`}>
                <div className="task-date-grid">
                  <ReadOnlyField label="Başlangıç" value={baselineSnapshot.plannedStart ? fmt(baselineSnapshot.plannedStart, 'dd MMM yyyy') : '—'} />
                  <ReadOnlyField label="Bitiş" value={baselineSnapshot.plannedFinish ? fmt(baselineSnapshot.plannedFinish, 'dd MMM yyyy') : '—'} />
                  <ReadOnlyField label="Süre" value={baselineSnapshot.plannedDurationDays == null ? '—' : `${baselineSnapshot.plannedDurationDays} gün`} />
                </div>
              </Section>
            )}

            <Section title="İlerleme">
              <div className="row" style={{ gap: 12 }}>
                <input
                  type="range" min={0} max={100} step={5}
                  value={local.progress || 0}
                  onChange={(e) => save({ progress: parseInt(e.target.value) })}
                  style={{ flex: 1, accentColor: 'var(--accent)' }}
                />
                <span className="tabular" style={{ fontWeight: 600, minWidth: 38, textAlign: 'right' }}>{local.progress || 0}%</span>
              </div>
            </Section>

            <Section
              title="İlişkiler & Bağımlılıklar"
              info={
                <InfoButton title="Görev ilişkileri" icon={<Icons.Link size={12} />}>
                  <p><strong>Bağımlılık tipleri ve lead/lag:</strong></p>
                  <div className="rt-sep" />
                  {Object.values(REL_TYPES).map((rt) =>
                    <div key={rt.code} style={{ marginBottom: 6 }}>
                      <div className="rt-row">
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent)', minWidth: 28 }}>{rt.code}</span>
                        <span style={{ fontWeight: 600 }}>{rt.name}</span>
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', paddingLeft: 36, lineHeight: 1.45 }}>{rt.description}</div>
                    </div>
                  )}
                  <div className="rt-sep" />
                  <p>Pozitif değer gecikme (lag), negatif değer öne çekme (lead) oluşturur. Gün, hafta veya ay birimi seçilebilir.</p>
                </InfoButton>
              }
            >
              <RelEditor task={local} tasks={tasks} onChange={(deps) => save({ deps })} />
            </Section>

            <Section title="Notlar">
              <textarea
                className="input" rows={4}
                value={local.description || ''}
                onChange={(e) => save({ description: e.target.value })}
                placeholder="Notlar, gereksinimler, bağlantılar..."
                style={{ resize: 'vertical', fontFamily: 'inherit' }}
              />
            </Section>
          </div>
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={() => { if (confirm('Görev silinsin mi?')) { onDelete(task.id); onClose(); } }}>
            <Icons.Trash size={13} /> Sil
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn primary" onClick={onClose}>Tamam</button>
        </div>
      </div>
    </>
  );
}

function Section({ title, info, children }) {
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 4, alignItems: 'center' }}>
        <div className="label" style={{ margin: 0 }}>{title}</div>
        {info}
      </div>
      {children}
    </div>
  );
}

function RelEditor({ task, tasks, onChange }) {
  const deps = task.deps || [];
  const others = tasks.filter((t) => t.id !== task.id && (!task.projectId || t.projectId === task.projectId));
  const [selectedType, setSelectedType] = useState('FS');

  const updateDep = (idx, patch) => {
    const next = deps.map((d, i) => {
      if (i !== idx) return d;
      const cur = typeof d === 'string' ? { id: d, type: 'FS', lagValue: 0, lagUnit: 'day', lagDays: 0 } : { ...d };
      const updated = { ...cur, ...patch };
      return { ...updated, lagDays: dependencyLagDays(updated) };
    });
    onChange(next);
  };
  const removeDep = (idx) => onChange(deps.filter((_, i) => i !== idx));
  const addDep = (depTaskId, type) => {
    if (!depTaskId) return;
    onChange([...deps, { id: depTaskId, predecessorId: depTaskId, type: type || 'FS', lagValue: 0, lagUnit: 'day', lagDays: 0 }]);
  };

  return (
    <div className="col" style={{ gap: 8 }}>
      {deps.length === 0 &&
        <div className="muted" style={{ fontSize: 12, padding: '8px 10px', background: 'var(--bg-elev-2)', borderRadius: 'var(--r-md)', textAlign: 'center' }}>
          Bu görevin henüz bir ilişkisi yok. Aşağıdan ekleyebilirsiniz.
        </div>
      }
      {deps.map((d, idx) => {
        const id = depId(d);
        const type = relTypeOf(d);
        const dep = tasks.find((x) => x.id === id);
        const rt = REL_TYPES[type];
        const lagValue = lagValueOf(d);
        const lagUnit = lagUnitOf(d);
        if (!dep) return null;
        return (
          <div key={`${id}-${idx}`} className="rel-item">
            <div className="rel-row">
              <div className="row" style={{ gap: 8, minWidth: 0 }}>
                <span style={{ width: 6, height: 6, borderRadius: 99, background: projectColorVar(dep.proje), flexShrink: 0 }} />
                <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dep.task}</span>
                {lagValue !== 0 && <span className="badge">{formatDependencyLag(d)}</span>}
              </div>
              <button className="icon-btn" style={{ width: 24, height: 24, flexShrink: 0 }} onClick={() => removeDep(idx)}><Icons.Close size={11} /></button>
            </div>
            <div className="rel-fields-grid">
              <label className="rel-type-field">
                <span className="rel-type-field-label">İlişki türü</span>
                <select
                  className="input rel-type-select"
                  value={type}
                  onChange={(e) => updateDep(idx, { type: e.target.value })}
                >
                  {Object.values(REL_TYPES).map((item) =>
                    <option key={item.code} value={item.code}>{item.code} — {item.name}</option>
                  )}
                </select>
              </label>
              <label className="rel-type-field">
                <span className="rel-type-field-label">Lead / Lag</span>
                <input
                  type="number"
                  step="1"
                  className="input"
                  value={lagValue}
                  onChange={(e) => updateDep(idx, { lagValue: e.target.value === '' ? 0 : Number(e.target.value) })}
                />
              </label>
              <label className="rel-type-field">
                <span className="rel-type-field-label">Birim</span>
                <select className="input" value={lagUnit} onChange={(e) => updateDep(idx, { lagUnit: e.target.value })}>
                  {Object.values(LAG_UNITS).map((unit) => <option key={unit.id} value={unit.id}>{unit.label}</option>)}
                </select>
              </label>
            </div>
            <div className="rel-type-help">
              <strong>{rt.code} · {rt.name}:</strong> {rt.description}
              <div style={{ marginTop: 4, color: 'var(--text-dim)' }}>
                {lagValue > 0 ? `+${lagValue} ${LAG_UNITS[lagUnit].short} gecikme` : lagValue < 0 ? `${Math.abs(lagValue)} ${LAG_UNITS[lagUnit].short} öne çekme` : 'Ek lead/lag yok'}
              </div>
            </div>
          </div>
        );
      })}

      <div className="rel-add-row">
        <select
          className="input"
          value={selectedType}
          onChange={(e) => setSelectedType(e.target.value)}
        >
          {Object.values(REL_TYPES).map((rt) =>
            <option key={rt.code} value={rt.code}>{rt.code}</option>
          )}
        </select>
        <select
          className="input"
          value=""
          onChange={(e) => { addDep(e.target.value, selectedType); e.target.value = ''; }}
        >
          <option value="">+ Öncül görev seçin...</option>
          {others.filter((t) => !deps.some((d) => depId(d) === t.id))
            .slice()
            .sort((a, b) => a.task.localeCompare(b.task, 'tr'))
            .map((t) =>
              <option key={t.id} value={t.id}>{t.task}</option>
            )}
        </select>
      </div>
    </div>
  );
}

function DateField({ label, value, onChange, accent, nullable = false }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="label">{label}</div>
      <DateInput
        value={value || ''}
        onChange={(next) => onChange(nullable && !next ? null : next)}
        allowEmpty={nullable}
        style={accent ? { '--date-field-accent': accent } : undefined}
      />
    </div>
  );
}

function NumberField({ label, value, onChange, suffix }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="label">{label}</div>
      <div className="row" style={{ gap: 6 }}>
        <input
          type="number"
          min={0}
          step={1}
          className="input"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
        />
        {suffix && <span className="muted" style={{ fontSize: 12 }}>{suffix}</span>}
      </div>
    </div>
  );
}

function ReadOnlyField({ label, value }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="label">{label}</div>
      <div className="input tabular" style={{ background: 'var(--bg-elev-2)', color: 'var(--text-muted)' }}>{value}</div>
    </div>
  );
}
