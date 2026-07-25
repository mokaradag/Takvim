'use client';
import { useEffect, useMemo, useState } from 'react';
import { DateInput } from '../../components/DateInput';
import { Icons } from '../../components/icons';
import { SearchableSelect } from '../../components/SearchableSelect';
import { Avatar } from '../../components/ui';
import { ProjectColorPicker } from '../../components/project/ProjectColorPicker';
import { ProjectCreateDialog } from '../../components/shell/ProjectCreateDialog';
import {
  groupProjectsByType,
  isArchivedProject,
  projectSearchText,
  projectTypeMeta,
  visibleProjects
} from '../../domain/projectTypes';
import { useAppState } from '../../state/AppStateProvider';
import { useAllPeople, useAllTasks, useTaskActions, useWorkspace } from '../../state/hooks';
import { WbsView } from '../wbs/WbsView';

const INITIAL_PROJECT_LIMIT = 60;

function legacyTags(project, tasks) {
  return Array.from(new Set(
    tasks
      .filter((task) => task.projectId === project?.id && String(task.keyword || '').trim() && String(task.keyword).trim() !== 'Yeni')
      .map((task) => String(task.keyword).trim())
  )).sort((a, b) => a.localeCompare(b, 'tr'));
}

function projectForm(project, people, tasks) {
  return {
    code: project?.code || '',
    name: project?.name || '',
    source: project?.source || 'manual',
    leadId: project?.leadId || people.find((person) => person.name === project?.lead)?.id || '',
    dataDate: project?.dataDate || '',
    color: project?.color || 'blue',
    tags: Array.isArray(project?.tags) ? [...project.tags] : legacyTags(project, tasks)
  };
}

function projectLabel(project) {
  return project.code ? `${project.code} · ${project.name}` : project.name;
}

function personLabel(person) {
  return person.employeeNo ? `${person.employeeNo} · ${person.name}` : person.name;
}

function TagEditor({ values, usage, disabled, onChange, onBlockedRemove }) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const value = draft.trim();
    if (!value) return;
    const exists = values.some((tag) => tag.toLocaleLowerCase('tr-TR') === value.toLocaleLowerCase('tr-TR'));
    if (!exists) onChange([...values, value].sort((a, b) => a.localeCompare(b, 'tr')));
    setDraft('');
  };

  const remove = (tag) => {
    const count = usage.get(tag) || 0;
    if (count > 0) {
      onBlockedRemove(tag, count);
      return;
    }
    onChange(values.filter((value) => value !== tag));
  };

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 7, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <input
          className="input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
          placeholder="Yeni etiket adı"
          disabled={disabled}
          style={{ flex: '1 1 240px' }}
        />
        <button type="button" className="btn" onClick={add} disabled={disabled || !draft.trim()}>
          <Icons.Plus size={13} /> Etiket ekle
        </button>
      </div>
      <div className="project-label-editor">
        {values.map((tag) => (
          <span className="project-label-chip" key={tag}>
            <span>{tag}</span>
            {(usage.get(tag) || 0) > 0 && <span className="muted">· {usage.get(tag)}</span>}
            <button type="button" onClick={() => remove(tag)} disabled={disabled} title={(usage.get(tag) || 0) > 0 ? 'Kullanımdaki etiket önce görevlerden kaldırılmalıdır.' : 'Etiketi kaldır'}>
              <Icons.Close size={10} />
            </button>
          </span>
        ))}
        {!values.length && <span className="muted" style={{ fontSize: 11.5 }}>Henüz etiket tanımlanmadı.</span>}
      </div>
      <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.55 }}>
        Etiketler proje düzeyinde kontrollü bir katalog olarak yönetilir. Basit Modda girilen yeni kısa açıklamalar da proje kataloğuna eklenir; böylece Gelişmiş Moda geçildiğinde kayıtlar aynı yapı içinde kullanılabilir.
      </div>
    </div>
  );
}

function ProjectDefinition({ project, people, tasks, onSave }) {
  const defaults = useMemo(() => projectForm(project, people, tasks), [project, people, tasks]);
  const personOptions = useMemo(() => people
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, 'tr'))
    .map((person) => ({
      value: person.id,
      label: personLabel(person),
      description: person.role || null,
      group: [person.organization?.directorate, person.organization?.department, person.organization?.unit].filter(Boolean).join(' / '),
      keywords: [person.name, person.employeeNo, person.username, person.role, person.team],
      icon: <Avatar name={person.name} size="sm" />
    })), [people]);
  const [form, setForm] = useState(defaults);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const isCorporate = String(project?.source || '').toLowerCase() === 'corporate';
  const manager = people.find((person) => String(person.id) === String(form.leadId)) || null;
  const type = projectTypeMeta(project.projectTypeCode, project.projectTypeName);
  const TypeIcon = Icons[type.icon] || Icons.Layers;

  useEffect(() => {
    setForm(defaults);
    setMessage(null);
  }, [defaults]);

  const usage = useMemo(() => {
    const counts = new Map();
    tasks.filter((task) => task.projectId === project.id).forEach((task) => {
      if (!task.keyword || task.keyword === 'Yeni') return;
      counts.set(task.keyword, (counts.get(task.keyword) || 0) + 1);
    });
    return counts;
  }, [tasks, project.id]);

  const dirty = JSON.stringify(form) !== JSON.stringify(defaults);
  const setField = (field) => (event) => {
    setMessage(null);
    setForm((current) => ({ ...current, [field]: event.target.value }));
  };
  const setValue = (field, value) => {
    setMessage(null);
    setForm((current) => ({ ...current, [field]: value }));
  };

  const submit = async (event) => {
    event.preventDefault();
    if (saving || !dirty) return;
    setSaving(true);
    setMessage(null);
    const result = await onSave(form);
    setSaving(false);
    if (!result?.ok) {
      setMessage({ type: 'error', text: result?.error?.message || 'Proje bilgileri kaydedilemedi.' });
      return;
    }
    setMessage({ type: 'success', text: 'Proje bilgileri ve etiket kataloğu kaydedildi.' });
  };

  return (
    <form className="card" onSubmit={submit} style={{ maxWidth: 980 }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
        <div className="col" style={{ gap: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Proje tanımı</div>
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            Seçili projenin temel bilgilerini, rengini ve görevlerde kullanılabilecek kontrollü etiket listesini yönetin.
          </div>
        </div>
        <div className="row" style={{ gap: 7, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span className="badge"><TypeIcon size={12} /> {type.code}</span>
          <span className="badge">{project.code || project.id}</span>
        </div>
      </div>

      <div className="col" style={{ gap: 18, marginTop: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, .7fr) minmax(280px, 1.3fr)', gap: 12 }}>
          <label className="col" style={{ gap: 6 }}>
            <span className="label">Proje kodu</span>
            <input className="input" value={form.code} onChange={setField('code')} disabled={saving || isCorporate} placeholder="Serbest projelerde isteğe bağlı" />
          </label>
          <label className="col" style={{ gap: 6 }}>
            <span className="label">Proje adı</span>
            <input className="input" value={form.name} onChange={setField('name')} disabled={saving || isCorporate} />
          </label>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          <div className="col" style={{ gap: 6 }}>
            <span className="label">Proje sorumlusu</span>
            {isCorporate ? (
              <div className="input" style={{ minHeight: 38, display: 'flex', alignItems: 'center', gap: 9 }}>
                {manager && <Avatar name={manager.name} size="sm" />}
                <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {manager ? personLabel(manager) : 'PROJECT_MANAGER rolü tanımlanmamış'}
                </span>
                <Icons.Database size={13} style={{ color: 'var(--text-dim)' }} />
              </div>
            ) : (
              <SearchableSelect
                value={form.leadId}
                options={personOptions}
                onChange={(leadId) => setValue('leadId', leadId)}
                placeholder={people.length ? 'Proje sorumlusu seçin' : 'Kişi bulunamadı'}
                searchPlaceholder="Ad, sicil, unvan veya birimle ara"
                disabled={saving || !people.length}
                maxVisible={60}
              />
            )}
            {isCorporate && (
              <span className="muted" style={{ fontSize: 10.5, lineHeight: 1.45 }}>
                Kurumsal proje sorumlusu MR_V_CorporateProjectAccess içindeki PROJECT_MANAGER rolünden otomatik alınır ve bu ekrandan değiştirilemez.
              </span>
            )}
          </div>

          <label className="col" style={{ gap: 6 }}>
            <span className="label">Veri tarihi <span className="muted">(isteğe bağlı)</span></span>
            <DateInput value={form.dataDate} onChange={(value) => setValue('dataDate', value)} allowEmpty disabled={saving} />
            {/* "Veri tarihi" ilerleme kesim tarihidir; satırın oluşturulma zamanı değildir. */}
            <span className="muted" style={{ fontSize: 10.5, lineHeight: 1.45 }}>
              İlerleme kesim tarihi: gerçekleşme ve ilerleme bilgilerinin hangi güne kadar geçerli sayıldığını gösterir.
              Kayıt oluşturma/güncelleme zamanları ayrı alanlarda tutulur.
            </span>
          </label>
        </div>

        <ProjectColorPicker
          value={form.color}
          onChange={(color) => {
            setMessage(null);
            setForm((current) => ({ ...current, color }));
          }}
          disabled={saving}
        />

        <div className="col" style={{ gap: 7 }}>
          <div className="label">Etiket kataloğu</div>
          <TagEditor
            values={form.tags}
            usage={usage}
            disabled={saving}
            onChange={(tags) => {
              setMessage(null);
              setForm((current) => ({ ...current, tags }));
            }}
            onBlockedRemove={(tag, count) => setMessage({
              type: 'error',
              text: `“${tag}” etiketi ${count} görevde kullanılıyor. Katalogdan kaldırmadan önce bu görevleri başka bir etikete taşıyın.`
            })}
          />
        </div>

        <div className="project-source-note">
          <Icons.Database size={14} />
          <span>
            {isCorporate ? 'Kurumsal proje kaydı' : 'Kullanıcı tarafından tanımlanan serbest proje'} · {type.code} · {type.name}
          </span>
        </div>

        {message && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 'var(--r-md)',
              border: `1px solid color-mix(in oklab, ${message.type === 'success' ? 'var(--status-done)' : 'var(--status-overdue)'} 45%, var(--border))`,
              color: message.type === 'success' ? 'var(--status-done)' : 'var(--status-overdue)',
              background: `color-mix(in oklab, ${message.type === 'success' ? 'var(--status-done)' : 'var(--status-overdue)'} 8%, var(--bg-elev))`,
              fontSize: 12.5
            }}
          >
            {message.text}
          </div>
        )}
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
        <button type="button" className="btn" disabled={!dirty || saving} onClick={() => setForm(defaults)}>Değişiklikleri geri al</button>
        <button type="submit" className="btn primary" disabled={!dirty || saving || (!isCorporate && !people.length)}>
          <Icons.Check size={14} /> {saving ? 'Kaydediliyor...' : 'Değişiklikleri kaydet'}
        </button>
      </div>
    </form>
  );
}

function PortfolioProjectBrowser({ projects, onSelect }) {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [selectedTypeCode, setSelectedTypeCode] = useState('');
  const [limit, setLimit] = useState(INITIAL_PROJECT_LIMIT);

  const activeProjects = useMemo(() => visibleProjects(projects, { showArchived }), [projects, showArchived]);
  const groups = useMemo(() => groupProjectsByType(activeProjects), [activeProjects]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('tr-TR');
    return activeProjects.filter((project) => {
      const typeMatches = !selectedTypeCode || projectTypeMeta(project.projectTypeCode, project.projectTypeName).code === selectedTypeCode;
      return typeMatches && (!needle || projectSearchText(project).includes(needle));
    });
  }, [activeProjects, query, selectedTypeCode]);
  const archivedCount = useMemo(() => projects.filter(isArchivedProject).length, [projects]);
  const visibleRows = filtered.slice(0, limit);

  useEffect(() => setLimit(INITIAL_PROJECT_LIMIT), [query, selectedTypeCode, showArchived]);

  return (
    /* Arama, tür süzgeçleri ve başlık donuk kalır; yalnızca proje listesi kaydırılır. */
    <div className="card project-browser">
      <div className="project-browser-head">
        <div className="row" style={{ justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div className="col" style={{ gap: 4 }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>Proje seçin</div>
            <div className="muted" style={{ maxWidth: 760, lineHeight: 1.6 }}>
              Projeler türlerine göre gruplanır. Arama alanı proje kodu, adı ve türü üzerinde canlı çalışır; tamamlanan ve kapatılan projeler başlangıçta gizlidir.
            </div>
          </div>
          <span className="badge">{filtered.length} / {projects.length} proje</span>
        </div>

        <div className="row" style={{ gap: 10, marginTop: 18, flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="topbar-search" style={{ flex: '1 1 320px', maxWidth: 520 }}>
            <Icons.Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Proje kodu, adı veya türüyle ara"
              aria-label="Proje ara"
            />
            {query && <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => setQuery('')}><Icons.Close size={11} /></button>}
          </label>
          {archivedCount > 0 && (
            <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
              Tamamlanan ve kapatılanları göster ({archivedCount})
            </label>
          )}
        </div>

        <div className="project-browser-types">
          <button
            type="button"
            className={`btn${selectedTypeCode === '' ? ' primary' : ''}`}
            onClick={() => setSelectedTypeCode('')}
            style={{ minHeight: 48, justifyContent: 'flex-start' }}
          >
            <Icons.Layers size={15} />
            <span style={{ flex: 1, textAlign: 'left' }}>Tüm etkin türler</span>
            <span className="badge">{activeProjects.length}</span>
          </button>
          {groups.map((group) => {
            const GroupIcon = Icons[group.icon] || Icons.Layers;
            return (
              <button
                key={group.code}
                type="button"
                className={`btn${selectedTypeCode === group.code ? ' primary' : ''}`}
                onClick={() => setSelectedTypeCode((current) => current === group.code ? '' : group.code)}
                style={{ minHeight: 48, justifyContent: 'flex-start' }}
                title={group.name}
              >
                <GroupIcon size={15} />
                <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                  <strong style={{ display: 'block', fontSize: 11.5 }}>{group.code}</strong>
                  <small style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.name}</small>
                </span>
                <span className="badge">{group.projects.length}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="col project-browser-list" style={{ gap: 7 }}>
        {visibleRows.map((item) => {
          const type = projectTypeMeta(item.projectTypeCode, item.projectTypeName);
          const ProjectIcon = Icons[type.icon] || Icons.Layers;
          return (
            <button
              key={item.id}
              type="button"
              className="btn"
              onClick={() => onSelect(item.id)}
              style={{ width: '100%', minHeight: 45, justifyContent: 'flex-start', padding: '8px 11px' }}
            >
              <ProjectIcon size={15} style={{ flexShrink: 0 }} />
              <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{projectLabel(item)}</strong>
                <small className="muted" style={{ display: 'block', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {type.code} · {type.name}{isArchivedProject(item) ? ' · tamamlanan/kapatılan' : ''}
                </small>
              </span>
              <Icons.ChevronRight size={14} />
            </button>
          );
        })}
        {!visibleRows.length && <div className="muted" style={{ padding: 22, textAlign: 'center' }}>Arama ve tür ölçütleriyle eşleşen proje bulunamadı.</div>}

        {filtered.length > limit && (
          <div className="row" style={{ justifyContent: 'center', marginTop: 7 }}>
            <button type="button" className="btn" onClick={() => setLimit((current) => current + INITIAL_PROJECT_LIMIT)}>
              <Icons.Plus size={13} /> Daha fazla göster ({Math.min(INITIAL_PROJECT_LIMIT, filtered.length - limit)})
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ProjectWorkspaceView() {
  const workspace = useWorkspace();
  const people = useAllPeople();
  const tasks = useAllTasks();
  const { canCreateProjects } = useAppState();
  const { addProject, updateProject } = useTaskActions();
  const [tab, setTab] = useState('definition');
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);

  const project = workspace.selectedProject || null;

  const createProject = async (input) => {
    const result = await addProject(input);
    if (result?.ok) setTab('definition');
    return result;
  };

  const backToProjectList = () => {
    setTab('definition');
    workspace.selectWorkspace(null);
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card" style={{ padding: 8 }}>
        <div className="row" role="tablist" aria-label="Proje yapısı sekmeleri" style={{ gap: 6, flexWrap: 'wrap' }}>
          {/* Seçili projeden proje listesine dönüş. Bu düğüm olmadan kullanıcı
              proje seçtikten sonra karşılama/proje seçim ekranına hiç dönemiyordu. */}
          {project && (
            <button
              type="button"
              className="btn ghost"
              onClick={backToProjectList}
              title="Proje seçim ekranına dön"
            >
              <Icons.ArrowLeft size={14} /> Proje listesi
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'definition'}
            className={`btn${tab === 'definition' ? ' primary' : ''}`}
            onClick={() => setTab('definition')}
          >
            <Icons.Settings size={14} /> Proje Tanımı
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'tree'}
            className={`btn${tab === 'tree' ? ' primary' : ''}`}
            onClick={() => setTab('tree')}
            disabled={!project}
          >
            <Icons.Layers size={14} /> İş Dağılım Ağacı
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="btn primary"
            onClick={() => setProjectCreateOpen(true)}
            disabled={!canCreateProjects}
            title={canCreateProjects
              ? 'Kurumsal listede olmayan serbest bir proje tanımlayın'
              : 'Bu oturumda manuel proje oluşturma yetkiniz bulunmuyor.'}
          >
            <Icons.Plus size={14} /> Yeni Proje
          </button>
        </div>
      </div>

      {tab === 'definition' && !project && (
        <PortfolioProjectBrowser projects={workspace.projects} onSelect={workspace.selectWorkspace} />
      )}

      {tab === 'definition' && project && (
        <ProjectDefinition
          project={project}
          people={people}
          tasks={tasks}
          onSave={(form) => updateProject(project.id, form)}
        />
      )}

      {tab === 'tree' && project && <WbsView />}

      <ProjectCreateDialog
        open={projectCreateOpen}
        people={people}
        onCreate={createProject}
        onClose={() => setProjectCreateOpen(false)}
      />
    </div>
  );
}
