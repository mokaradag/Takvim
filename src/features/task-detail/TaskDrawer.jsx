'use client';
import { useEffect, useMemo, useState } from 'react';
import { Icons } from '../../components/icons';
import { buildWbsTree, flattenWbsTree, formatWbsPath } from '../../domain/selectors/index.js';
import { REL_TYPES, depId, relTypeOf } from '../../scheduling/dependencies';
import { diffDays, today } from '../../scheduling/dates';
import { projectColorVar } from '../../lib/colors';
import { Avatar, Kw, StatusIcon, statusColorVar } from '../../components/ui';
import { InfoButton } from '../../components/ui-extras';
import { useAllPeople, useAllProjects, useAllWbs, useTaskPrimaryBaseline } from '../../state/hooks';

/* ── Detail drawer ───────────────────────────────────── */
export function TaskDrawer({ task, tasks, onClose, onUpdate, onDelete }) {
  const people = useAllPeople();
  const projects = useAllProjects();
  const allWbs = useAllWbs();
  const { baseline, snapshot: baselineSnapshot } = useTaskPrimaryBaseline(task.id);
  const [local, setLocal] = useState({ ...task });

  useEffect(() => { setLocal({ ...task }); }, [task]);

  const projectWbsRows = useMemo(() => {
    const projectWbs = allWbs.filter((node) => node.projectId === local.projectId);
    return flattenWbsTree(buildWbsTree(projectWbs));
  }, [allWbs, local.projectId]);

  const save = (patch) => {
    const next = { ...local, ...patch };
    setLocal(next);
    onUpdate(task.id, patch);
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
              <span className="muted" style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{local.proje}</span>
              <span className="muted">·</span>
              <Kw color={local.color}>{local.keyword}</Kw>
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
            {/* Status + dates row */}
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

            <Section title="Proje & WBS">
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.45fr)', gap: 12 }}>
                <div className="col" style={{ gap: 6 }}>
                  <div className="label">Proje</div>
                  <select
                    className="input"
                    value={local.projectId || ''}
                    onChange={(e) => save({ projectId: e.target.value || null })}
                  >
                    <option value="">Proje seçilmedi</option>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
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
              <div className="muted" style={{ fontSize: 11.5 }}>
                Proje değişirse önceki projeye bağlı WBS korunmaz; yeni projenin tek kök WBS düğümü varsa otomatik atanır.
              </div>
            </Section>

            <Section title="Sorumlular">
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {(local.sorumlu || []).map((s) =>
                  <span key={s} className="row" style={{ gap: 6, padding: '3px 8px 3px 4px', border: '1px solid var(--border)', borderRadius: 'var(--r-pill)', background: 'var(--bg-elev-2)' }}>
                    <Avatar name={s} size="sm" />
                    <span style={{ fontSize: 12 }}>{s}</span>
                    <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => save({ sorumlu: local.sorumlu.filter((x) => x !== s) })}><Icons.Close size={10} /></button>
                  </span>
                )}
                <select
                  className="input" style={{ width: 'auto', padding: '4px 8px' }}
                  value=""
                  onChange={(e) => { if (e.target.value && !local.sorumlu.includes(e.target.value)) save({ sorumlu: [...local.sorumlu, e.target.value] }); }}
                >
                  <option value="">+ Ekle</option>
                  {people.filter((p) => !local.sorumlu.includes(p.name))
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
                    .map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
                </select>
              </div>
            </Section>

            <Section title="Güncel Plan">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <DateField label="Planlanan Başlangıç" value={local.plannedStart} onChange={(v) => save({ plannedStart: v })} />
                <DateField label="Planlanan Bitiş" value={local.plannedFinish} onChange={(v) => save({ plannedFinish: v })} />
                <DateField label="Hedef Bitiş" value={local.targetFinish} onChange={(v) => save({ targetFinish: v })} accent={overdue ? 'var(--status-overdue)' : null} />
              </div>
              <div className="muted" style={{ fontSize: 11.5 }}>
                Planlanan süre: <span className="tabular">{local.plannedDurationDays ?? '—'}</span> çalışma günü
              </div>
            </Section>

            <Section title="Gerçekleşen & Kalan">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <DateField label="Gerçekleşen Başlangıç" value={local.actualStart} onChange={(v) => save({ actualStart: v })} nullable />
                <DateField label="Gerçekleşen Bitiş" value={local.actualFinish} onChange={(v) => save({ actualFinish: v })} nullable />
                <NumberField label="Kalan Süre" value={local.remainingDurationDays} onChange={(v) => save({ remainingDurationDays: v })} suffix="gün" />
              </div>
            </Section>

            {baselineSnapshot && (
              <Section title={`Baz Plan · ${baseline?.name || 'Birincil Baz Plan'}`}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                  <ReadOnlyField label="Başlangıç" value={baselineSnapshot.plannedStart || '—'} />
                  <ReadOnlyField label="Bitiş" value={baselineSnapshot.plannedFinish || '—'} />
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
                  <p><strong>Bağımlılık tipleri:</strong></p>
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
  const others = tasks.filter((t) => t.id !== task.id);
  const [selectedType, setSelectedType] = useState('FS');

  const updateDep = (idx, patch) => {
    const next = deps.map((d, i) => {
      if (i !== idx) return d;
      const cur = typeof d === 'string' ? { id: d, type: 'FS' } : { ...d };
      return { ...cur, ...patch };
    });
    onChange(next);
  };
  const removeDep = (idx) => onChange(deps.filter((_, i) => i !== idx));
  const addDep = (depTaskId, type) => {
    if (!depTaskId) return;
    onChange([...deps, { id: depTaskId, type: type || 'FS' }]);
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
        if (!dep) return null;
        return (
          <div key={`${id}-${idx}`} className="rel-item">
            <div className="rel-row">
              <div className="row" style={{ gap: 8, minWidth: 0 }}>
                <span style={{ width: 6, height: 6, borderRadius: 99, background: projectColorVar(dep.proje), flexShrink: 0 }} />
                <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dep.task}</span>
              </div>
              <button className="icon-btn" style={{ width: 24, height: 24, flexShrink: 0 }} onClick={() => removeDep(idx)}><Icons.Close size={11} /></button>
            </div>
            <label className="rel-type-field">
              <span className="rel-type-field-label">İlişki türü</span>
              <select
                className="input rel-type-select"
                value={type}
                onChange={(e) => updateDep(idx, { type: e.target.value })}
              >
                {Object.values(REL_TYPES).map((rt) =>
                  <option key={rt.code} value={rt.code}>{rt.code} — {rt.name}</option>
                )}
              </select>
            </label>
            <div className="rel-type-help">
              <strong>{rt.code} · {rt.name}:</strong> {rt.description}
              <div style={{ marginTop: 4, color: 'var(--text-dim)', fontStyle: 'italic' }}>Örn: {rt.example}</div>
            </div>
          </div>
        );
      })}

      <div className="row" style={{ gap: 6, marginTop: 4 }}>
        <select
          className="input"
          value={selectedType}
          onChange={(e) => setSelectedType(e.target.value)}
          style={{ width: 100, flexShrink: 0, fontSize: 12 }}
        >
          {Object.values(REL_TYPES).map((rt) =>
            <option key={rt.code} value={rt.code}>{rt.code}</option>
          )}
        </select>
        <select
          className="input"
          value=""
          onChange={(e) => { addDep(e.target.value, selectedType); e.target.value = ''; }}
          style={{ flex: 1 }}
        >
          <option value="">+ Görev seçin...</option>
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
      <input
        type="date"
        className="input"
        value={value || ''}
        onChange={(e) => onChange(nullable && !e.target.value ? null : e.target.value)}
        style={accent ? { borderColor: accent, color: accent } : null}
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
