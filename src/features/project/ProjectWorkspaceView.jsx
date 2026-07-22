'use client';
import { useEffect, useMemo, useState } from 'react';
import { Icons } from '../../components/icons';
import { ProjectColorPicker } from '../../components/project/ProjectColorPicker';
import { useAllPeople, useTaskActions, useWorkspace } from '../../state/hooks';
import { WbsView } from '../wbs/WbsView';

function projectForm(project, people) {
  return {
    name: project?.name || '',
    leadId: project?.leadId || people.find((person) => person.name === project?.lead)?.id || '',
    dataDate: project?.dataDate || '',
    color: project?.color || 'blue'
  };
}

function ProjectDefinition({ project, people, onSave }) {
  const defaults = useMemo(() => projectForm(project, people), [project, people]);
  const [form, setForm] = useState(defaults);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    setForm(defaults);
    setMessage(null);
  }, [defaults]);

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
    setMessage({ type: 'success', text: 'Proje bilgileri kaydedildi.' });
  };

  return (
    <form className="card" onSubmit={submit} style={{ maxWidth: 860 }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
        <div className="col" style={{ gap: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Proje tanımı</div>
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            Seçili projenin temel bilgilerini buradan güncelleyebilirsiniz.
          </div>
        </div>
        <span className="badge">{project.id}</span>
      </div>

      <div className="col" style={{ gap: 16, marginTop: 20 }}>
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
  const { updateProject } = useTaskActions();
  const [tab, setTab] = useState('definition');

  const project = workspace.selectedProject || null;

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
        </div>
      </div>

      {tab === 'definition' && !project && (
        <div className="card">
          <div className="col" style={{ gap: 12 }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>Proje seçin</div>
            <div className="muted" style={{ maxWidth: 760, lineHeight: 1.6 }}>
              Proje bilgilerini görmek ve düzenlemek için bir proje çalışma alanı seçin.
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
          onSave={(form) => updateProject(project.id, form)}
        />
      )}

      {tab === 'tree' && project && <WbsView />}
    </div>
  );
}
