'use client';
import { useEffect, useMemo, useState } from 'react';
import { Icons } from '../../components/icons';
import { ProjectColorPicker } from '../../components/project/ProjectColorPicker';
import { ProjectCreateDialog } from '../../components/shell/ProjectCreateDialog';
import { useAllPeople, useAllTasks, useTaskActions, useWorkspace } from '../../state/hooks';
import { WbsView } from '../wbs/WbsView';

function legacyTags(project, tasks) {
  return Array.from(new Set(
    tasks
      .filter((task) => task.projectId === project?.id && String(task.keyword || '').trim())
      .map((task) => String(task.keyword).trim())
  )).sort((a, b) => a.localeCompare(b, 'tr'));
}

function projectForm(project, people, tasks) {
  return {
    name: project?.name || '',
    leadId: project?.leadId || people.find((person) => person.name === project?.lead)?.id || '',
    dataDate: project?.dataDate || '',
    color: project?.color || 'blue',
    tags: Array.isArray(project?.tags) ? [...project.tags] : legacyTags(project, tasks)
  };
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
        Etiketler proje düzeyinde kontrollü bir katalog olarak yönetilir. Görev oluştururken veya düzenlerken kullanıcı bu katalogdan açıkça seçim yapar; böylece yazım farklılıkları ve yinelenen değerler önlenir.
      </div>
    </div>
  );
}

function ProjectDefinition({ project, people, tasks, onSave }) {
  const defaults = useMemo(() => projectForm(project, people, tasks), [project, people, tasks]);
  const [form, setForm] = useState(defaults);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    setForm(defaults);
    setMessage(null);
  }, [defaults]);

  const usage = useMemo(() => {
    const counts = new Map();
    tasks.filter((task) => task.projectId === project.id).forEach((task) => {
      if (!task.keyword) return;
      counts.set(task.keyword, (counts.get(task.keyword) || 0) + 1);
    });
    return counts;
  }, [tasks, project.id]);

  const dirty = JSON.stringify(form) !== JSON.stringify(defaults);
  const setField = (field) => (event) => {
    setMessage(null);
    setForm((current) => ({ ...current, [field]: event.target.value }));
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
    <form className="card" onSubmit={submit} style={{ maxWidth: 920 }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
        <div className="col" style={{ gap: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Proje tanımı</div>
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            Seçili projenin temel bilgilerini ve görevlerde kullanılabilecek kontrollü etiket listesini buradan yönetin.
          </div>
        </div>
        <span className="badge">{project.id}</span>
      </div>

      <div className="col" style={{ gap: 18, marginTop: 20 }}>
        <label className="col" style={{ gap: 6 }}>
          <span className="label">Proje adı</span>
          <input className="input" value={form.name} onChange={setField('name')} disabled={saving} />
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          <label className="col" style={{ gap: 6 }}>
            <span className="label">Proje sorumlusu</span>
            <select className="input" value={form.leadId} onChange={setField('leadId')} disabled={saving || !people.length}>
              {!people.length && <option value="">Kişi bulunamadı</option>}
              {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </label>

          <label className="col" style={{ gap: 6 }}>
            <span className="label">Veri tarihi</span>
            <input className="input" type="date" value={form.dataDate} onChange={setField('dataDate')} disabled={saving} />
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
        <button type="submit" className="btn primary" disabled={!dirty || saving || !people.length}>
          <Icons.Check size={14} /> {saving ? 'Kaydediliyor...' : 'Değişiklikleri kaydet'}
        </button>
      </div>
    </form>
  );
}

export function ProjectWorkspaceView() {
  const workspace = useWorkspace();
  const people = useAllPeople();
  const tasks = useAllTasks();
  const { addProject, updateProject } = useTaskActions();
  const [tab, setTab] = useState('definition');
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);

  const project = workspace.selectedProject || null;

  const createProject = async (input) => {
    const result = await addProject(input);
    if (result?.ok) setTab('definition');
    return result;
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card" style={{ padding: 8 }}>
        <div className="row" role="tablist" aria-label="Proje yapısı sekmeleri" style={{ gap: 6, flexWrap: 'wrap' }}>
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
          <button type="button" className="btn primary" onClick={() => setProjectCreateOpen(true)}>
            <Icons.Plus size={14} /> Yeni Proje
          </button>
        </div>
      </div>

      {tab === 'definition' && !project && (
        <div className="card">
          <div className="col" style={{ gap: 12 }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>Proje seçin veya yeni proje oluşturun</div>
            <div className="muted" style={{ maxWidth: 760, lineHeight: 1.6 }}>
              Proje bilgilerini ve kontrollü etiket kataloğunu yönetmek için bir proje çalışma alanı seçin. Yeni proje tanımı da yalnızca bu sayfadan yapılır.
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {workspace.projects.map((item) => (
                <button key={item.id} type="button" className="btn" onClick={() => workspace.selectWorkspace(item.id)}>
                  {item.name}
                </button>
              ))}
              {!workspace.projects.length && <span className="muted">Henüz proje yok.</span>}
            </div>
          </div>
        </div>
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
