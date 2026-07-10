'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from './icons';
import {
  PEOPLE, PROJECTS, TASKS, REL_TYPES,
  today, diffDays, addDays, fmtISO, depId, relTypeOf, projectColorVar,
} from '../lib/data';
import { Avatar, Heptagon, Kw, StatusIcon, statusColorVar } from './ui';
import { InfoButton } from './ui-extras';
import { OzetView, VeriView, KisiView } from './views-a';
import { TakvimView, GanttView, KanbanView, RaporView } from './views-b';
import { SettingsView } from './settings';
import { useTweaks } from '../hooks/useTweaks';
import { TWEAK_DEFAULTS } from '../lib/tweaks-defaults';

/* ── Welcome / Onboarding screen ──────────────────────── */
function WelcomeScreen({ onClose, onNavigate, onShowAgainChange, showAgain, stats }) {
  const features = [
    { ico: 'Dashboard', color: 'var(--accent)', title: 'Yönetici özet panosu',
      desc: 'Tamamlama oranı, bekleyen iş yükü, geciken görevler ve trendler tek ekranda.' },
    { ico: 'Gantt', color: 'var(--c-purple)', title: 'Primavera-tarzı Gantt',
      desc: 'FS/SS/FF/SF bağımlılıkları, özet (rollup) çubukları, kilometre taşları, hafta sonu/tatil işaretleri.' },
    { ico: 'Calendar', color: 'var(--c-emerald)', title: 'Aylık takvim',
      desc: 'Resmi tatilleri ve görev yoğunluğunu görün, yoğun günlere tıklayarak tüm girdileri açın.' },
    { ico: 'Kanban', color: 'var(--c-amber)', title: 'Sürükle-bırak Kanban',
      desc: 'Yapılacak → Devam ediyor → Tamamlandı kolonları arasında kartları sürükleyin.' },
    { ico: 'Table', color: 'var(--c-cyan)', title: 'Akıllı veri tablosu',
      desc: 'Çoklu seçim filtreleri, tarih için hızlı önayar/aralık filtreleri, sütun bazlı sıralama.' },
    { ico: 'Chart', color: 'var(--c-rose)', title: 'Etkileşimli raporlar',
      desc: 'Çevrim süresi, zamanında teslim oranı, proje bazlı throughput ve trend eğrileri.' }
  ];

  return (
    <div className="welcome-backdrop" onClick={onClose}>
      <div className="welcome-panel" onClick={(e) => e.stopPropagation()}>
        <div className="welcome-head">
          <AppLogo size={48} />
          <div className="col" style={{ flex: 1, gap: 0 }}>
            <div className="row" style={{ gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent)' }}>MERGEN Rota · v2.4</span>
            </div>
            <h2>Hoş geldiniz</h2>
            <div className="welcome-sub">
              MERGEN Rota, projenizin planlamasından raporlamasına kadar her şeyi tek bir yerden yönetmenizi sağlar.
              Aşağıda hızlı bir özet; istediğiniz zaman sol alttaki <strong>Yardım</strong> düğmesinden tekrar açabilirsiniz.
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icons.Close size={16} /></button>
        </div>

        <div className="welcome-body">
          <div className="welcome-callouts">
            <div className="welcome-callout">
              <span className="wc-k">Aktif görev</span>
              <span className="wc-v">{stats.active}</span>
              <span className="wc-s">{stats.inProgress} devam · {stats.todo} yapılacak</span>
            </div>
            <div className="welcome-callout">
              <span className="wc-k">Tamamlama</span>
              <span className="wc-v" style={{ color: 'var(--status-done)' }}>{stats.compRate}%</span>
              <span className="wc-s">{stats.done} / {stats.total} görev</span>
            </div>
            <div className="welcome-callout">
              <span className="wc-k">Geciken</span>
              <span className="wc-v" style={{ color: stats.overdue > 0 ? 'var(--status-overdue)' : 'var(--text)' }}>{stats.overdue}</span>
              <span className="wc-s">{stats.overdue > 0 ? 'müdahale gerekli' : 'tertip · sıfır geciken'}</span>
            </div>
          </div>

          <div className="welcome-grid" style={{ marginTop: 14 }}>
            {features.map((f) => {
              const I = Icons[f.ico];
              return (
                <div key={f.title} className="welcome-card" style={{ '--wc-color': f.color }}>
                  <span className="wc-ico"><I size={17} /></span>
                  <div className="col" style={{ gap: 0, flex: 1 }}>
                    <span className="wc-title">{f.title}</span>
                    <span className="wc-desc">{f.desc}</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="welcome-shortcuts">
            <span className="ws-item"><Icons.Keyboard size={13} /> Kısayollar:</span>
            <span className="ws-item"><kbd>Ctrl</kbd><kbd>K</kbd> Komut paleti</span>
            <span className="ws-item"><kbd>Esc</kbd> Paneli kapat</span>
            <span className="ws-item"><kbd>←</kbd> <kbd>→</kbd> Ay değiştir (takvimde)</span>
            <span className="ws-item"><Icons.Info size={12} /> Her yerde "i" ipuçları</span>
          </div>
        </div>

        <div className="welcome-foot">
          <label>
            <input type="checkbox" checked={!showAgain} onChange={(e) => onShowAgainChange(!e.target.checked)} />
            Bir daha gösterme
          </label>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => { onNavigate('ozet'); onClose(); }}>
            <Icons.Dashboard size={13} /> Panoya git
          </button>
          <button className="btn primary" onClick={onClose}>
            Başlayalım <Icons.ArrowRight size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── App logo (SVG mark) ────────────────────────────────── */
function AppLogo({ size = 34 }) {
  return (
    <div className="brand-mark" style={{ width: size, height: size, borderRadius: Math.max(6, size * 0.26) }}>
      <svg width={size * 0.66} height={size * 0.66} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        {/* Rota compass mark */}
        <circle cx="12" cy="12" r="8.5" opacity="0.95" />
        <polygon className="logo-compass-needle" points="16.4 7.6 13.5 13.5 7.6 16.4 10.5 10.5" fill="white" stroke="none" />
        <circle cx="12" cy="12" r="1.15" fill="white" stroke="none" />
      </svg>
    </div>
  );
}

/* ── App shell — sidebar nav, topbar, Cmd+K, detail drawer
   ============================================================ */

const NAV_ITEMS = [
  { id: 'ozet', label: 'Özet', icon: 'Dashboard' },
  { id: 'veri', label: 'Görevler', icon: 'Table' },
  { id: 'takvim', label: 'Takvim', icon: 'Calendar' },
  { id: 'gantt', label: 'Gantt', icon: 'Gantt' },
  { id: 'kanban', label: 'Kanban', icon: 'Kanban' },
  { id: 'rapor', label: 'Raporlar', icon: 'Chart' },
  { id: 'kisi', label: 'Ekip', icon: 'Users' },
  { id: 'ayarlar', label: 'Ayarlar', icon: 'Settings' }
];

const PAGE_META = {
  ozet: { title: 'Özet', sub: 'Genel görünüm ve metrikler' },
  veri: { title: 'Görevler', sub: 'Tüm görevleri listele ve düzenle' },
  takvim: { title: 'Takvim', sub: 'Aylık görünüm' },
  gantt: { title: 'Gantt', sub: 'Zaman çizelgesi ve bağımlılıklar' },
  kanban: { title: 'Kanban', sub: 'Durum panosu' },
  rapor: { title: 'Raporlar', sub: 'Çevrim süresi, performans ve trendler' },
  kisi: { title: 'Ekip', tab: 'kisi', sub: 'Ekip üyeleri ve iş yükü' },
  ayarlar: { title: 'Ayarlar', sub: 'Görünüm ve tercihler' }
};

/* ── Detail drawer ───────────────────────────────────── */
function TaskDrawer({ task, tasks, onClose, onUpdate, onDelete }) {
  const [local, setLocal] = useState({ ...task });

  useEffect(() => { setLocal({ ...task }); }, [task && task.id]);

  const save = (patch) => {
    const next = { ...local, ...patch };
    setLocal(next);
    onUpdate(task.id, patch);
  };

  const today_ = today();
  const overdue = local.status !== 'done' && diffDays(local.hedefTarih, today_) < 0;
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
                ].map(([id, label, color, iconId]) => {
                  const isActive = (local.status || 'todo') === id;
                  return (
                    <button
                      key={id}
                      className={isActive ? 'active' : ''}
                      onClick={() => save({ status: id })}
                      style={{
                        flex: 1,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                        color: isActive ? color : 'var(--text-muted)',
                        background: isActive ? `color-mix(in oklab, ${color} 14%, transparent)` : 'transparent',
                        fontWeight: 600
                      }}
                    >
                      <StatusIcon id={iconId} size={12} /> {label}
                    </button>
                  );
                })}
              </div>
            </Section>

            <Section title="Sorumlular">
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {local.sorumlu.map((s) =>
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
                  {PEOPLE.filter((p) => !local.sorumlu.includes(p.name))
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
                    .map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
                </select>
              </div>
            </Section>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <DateField label="Başlangıç" value={local.baslangicTarihi} onChange={(v) => save({ baslangicTarihi: v })} />
              <DateField label="Bitiş" value={local.bitisTarihi} onChange={(v) => save({ bitisTarihi: v })} />
              <DateField label="Hedef" value={local.hedefTarih} onChange={(v) => save({ hedefTarih: v })} accent={overdue ? 'var(--status-overdue)' : null} />
            </div>

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
function DateField({ label, value, onChange, accent }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="label">{label}</div>
      <input type="date" className="input" value={value} onChange={(e) => onChange(e.target.value)} style={accent ? { borderColor: accent, color: accent } : null} />
    </div>
  );
}

/* ── Command palette (Cmd+K) ────────────────────────── */
function CmdK({ onClose, onNavigate, onOpenTask, onSetTheme, tasks }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => a + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = useMemo(() => {
    const nav = NAV_ITEMS.map((n) => ({
      kind: 'nav', icon: n.icon, label: n.label, sub: `${PAGE_META[n.id].sub}`,
      action: () => { onNavigate(n.id); onClose(); }
    }));
    const themes = [
      { kind: 'cmd', icon: 'Sun', label: 'Tema: Açık', action: () => { onSetTheme('light'); onClose(); } },
      { kind: 'cmd', icon: 'Moon', label: 'Tema: Koyu', action: () => { onSetTheme('dark'); onClose(); } }
    ];
    const taskItems = tasks.map((t) => ({
      kind: 'task', icon: 'Target', label: t.task, sub: `${t.proje} · ${t.keyword}`,
      action: () => { onOpenTask(t); onClose(); }
    }));
    let all = [...nav, ...themes, ...taskItems];
    if (q) {
      const Q = q.toLowerCase();
      all = all.filter((i) => i.label.toLowerCase().includes(Q) || (i.sub || '').toLowerCase().includes(Q));
    } else {
      all = [...nav, ...themes, ...taskItems.slice(0, 5)];
    }
    return all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, tasks]);

  const a = Math.min(active, items.length - 1);

  const onSubmit = (e) => {
    e.preventDefault();
    const it = items[a];
    if (it) it.action();
  };

  // group display
  const grouped = useMemo(() => {
    const out = { Sayfa: [], Komut: [], Görev: [] };
    items.forEach((i) => out[i.kind === 'nav' ? 'Sayfa' : i.kind === 'cmd' ? 'Komut' : 'Görev'].push(i));
    return out;
  }, [items]);

  let idx = -1;
  return (
    <div className="cmd-backdrop" onClick={onClose}>
      <form className="cmd-panel" onClick={(e) => e.stopPropagation()} onSubmit={onSubmit}>
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
          <Icons.Search size={15} className="muted" style={{ marginLeft: 18 }} />
          <input
            ref={inputRef} className="cmd-input"
            placeholder="Sayfaya geç, görev ara veya komut çalıştır..."
            value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }}
            style={{ borderBottom: 0, padding: '14px 14px 14px 10px' }}
          />
        </div>
        <div className="cmd-results">
          {items.length === 0 && <div className="empty" style={{ padding: 28, fontSize: 13 }}>Eşleşme yok.</div>}
          {Object.entries(grouped).map(([group, list]) => {
            if (!list.length) return null;
            return (
              <div key={group}>
                <div className="cmd-group-title">{group}</div>
                {list.map((it) => {
                  idx++;
                  const isActive = idx === a;
                  const I = Icons[it.icon] || Icons.Target;
                  return (
                    <div key={idx} className={`cmd-row${isActive ? ' active' : ''}`} onMouseEnter={() => setActive(idx)} onClick={() => it.action()}>
                      <I size={14} className="cmd-icon" />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                      {it.sub && <span className="cmd-meta">{it.sub}</span>}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </form>
    </div>
  );
}

/* ── App ───────────────────────────────────────────────── */
const ACCENT_PRESETS = {
  '#3b82f6': { fg: 'white' }, // blue
  '#8b5cf6': { fg: 'white' }, // violet
  '#f43f5e': { fg: 'white' }, // rose
  '#10b981': { fg: 'white' }, // emerald
  '#f59e0b': { fg: 'black' }, // amber
  '#0ea5e9': { fg: 'white' } // cyan
};

export default function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  const [view, setView] = useState(() => {
    const v = (TWEAK_DEFAULTS && TWEAK_DEFAULTS.landingView) || 'ozet';
    return NAV_ITEMS.some((n) => n.id === v) ? v : 'ozet';
  });
  const [tasks, setTasks] = useState(() => TASKS.map((t) => ({ ...t })));
  const [openTask, setOpenTask] = useState(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(() => {
    try { return localStorage.getItem('mp_seen_welcome_v2') !== '1'; }
    catch { return true; }
  });
  const [hideWelcome, setHideWelcome] = useState(() => {
    try { return localStorage.getItem('mp_seen_welcome_v2') === '1'; }
    catch { return false; }
  });
  const closeWelcome = () => {
    setWelcomeOpen(false);
    try { if (hideWelcome) localStorage.setItem('mp_seen_welcome_v2', '1'); }
    catch {}
  };

  // Welcome stats
  const welcomeStats = useMemo(() => {
    const today_ = today();
    const done = tasks.filter((t) => t.status === 'done').length;
    const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
    const todo = tasks.filter((t) => !t.status || t.status === 'todo').length;
    const overdue = tasks.filter((t) => t.status !== 'done' && diffDays(t.hedefTarih, today_) < 0).length;
    return {
      total: tasks.length,
      active: inProgress + todo,
      inProgress, todo, done, overdue,
      compRate: tasks.length ? Math.round(done / tasks.length * 100) : 0
    };
  }, [tasks]);

  // theme on body
  useEffect(() => {
    document.body.className = t.theme === 'light' ? 'theme-light' : 'theme-dark';
  }, [t.theme]);

  // accent on root
  useEffect(() => {
    const r = document.documentElement;
    r.style.setProperty('--accent', t.accent);
    // derive stronger / soft
    r.style.setProperty('--accent-strong', t.accent);
    r.style.setProperty('--accent-soft', t.accent + '20');
    r.style.setProperty('--accent-fg', (ACCENT_PRESETS[t.accent] || {}).fg || 'white');
  }, [t.accent]);

  // density
  useEffect(() => {
    const r = document.documentElement;
    const v = t.density === 'compact' ? 0.85 : t.density === 'spacious' ? 1.15 : 1;
    r.style.setProperty('--density', String(v));
  }, [t.density]);

  // font scale (zoom the whole app)
  useEffect(() => {
    document.body.style.zoom = String(t.fontScale || 1);
  }, [t.fontScale]);

  // motion + emblem preferences
  useEffect(() => {
    document.body.classList.toggle('reduce-motion', !!t.reduceMotion);
  }, [t.reduceMotion]);
  useEffect(() => {
    document.body.classList.toggle('no-emblem', !t.showEmblem);
  }, [t.showEmblem]);

  // Cmd+K
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // task ops
  const updateTask = (id, patch) => setTasks((ts) => ts.map((t) => t.id === id ? { ...t, ...patch } : t));
  const deleteTask = (id) => { setTasks((ts) => ts.filter((t) => t.id !== id)); if (openTask?.id === id) setOpenTask(null); };
  const addTask = () => {
    const id = `n-${Date.now()}`;
    const t = {
      id, proje: PROJECTS[0].name, task: 'Yeni görev', keyword: 'Yeni',
      sorumlu: [PEOPLE[0].name],
      status: 'todo',
      baslangicTarihi: fmtISO(today()),
      bitisTarihi: fmtISO(addDays(today(), 5)),
      hedefTarih: fmtISO(addDays(today(), 7)),
      color: PROJECTS[0].color
    };
    setTasks((ts) => [t, ...ts]);
    setOpenTask(t);
  };

  // keep openTask in sync with tasks
  useEffect(() => {
    if (openTask) {
      const fresh = tasks.find((x) => x.id === openTask.id);
      if (fresh && fresh !== openTask) setOpenTask(fresh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  const totalsByView = useMemo(() => ({
    ozet: tasks.length,
    veri: tasks.length,
    takvim: null,
    gantt: tasks.length,
    kanban: tasks.length,
    rapor: null,
    kisi: PEOPLE.length,
    ayarlar: null
  }), [tasks]);

  const renderView = () => {
    const props = { tasks, onOpenTask: setOpenTask, onUpdateTask: updateTask, onAddTask: addTask, onDeleteTask: deleteTask, onNavigate: setView, t, setTweak };
    switch (view) {
      case 'ozet': return <OzetView {...props} />;
      case 'veri': return <VeriView {...props} />;
      case 'takvim': return <TakvimView {...props} />;
      case 'gantt': return <GanttView {...props} />;
      case 'kanban': return <KanbanView {...props} />;
      case 'rapor': return <RaporView {...props} />;
      case 'kisi': return <KisiView {...props} />;
      case 'ayarlar': return <SettingsView t={t} setTweak={setTweak} />;
      default: return null;
    }
  };

  const meta = PAGE_META[view] || PAGE_META.ozet;

  return (
    <div className="app">
      {/* Sidebar */}
      <aside className="sidebar">
        <Heptagon variant="hept-sidebar" />
        <div className="sidebar-header">
          <AppLogo size={34} />
          <div className="col" style={{ gap: 0 }}>
            <div className="brand-name"><span>MERGEN</span><span className="brand-accent">Rota</span><span className="brand-dot" /></div>
            <div className="brand-sub">Proje Yönetimi</div>
          </div>
        </div>
        <button className="cmd-trigger" onClick={() => setCmdOpen(true)}>
          <Icons.Search size={13} />
          <span>Ara veya komut çalıştır...</span>
          <span className="kbd">Ctrl K</span>
        </button>

        <div className="sidebar-section-title">Çalışma alanı</div>
        <nav className="nav">
          {NAV_ITEMS.map((n) => {
            const I = Icons[n.icon];
            return (
              <button key={n.id} className={`nav-item${view === n.id ? ' active' : ''}`} onClick={() => setView(n.id)}>
                <I className="nav-icon" size={15} />
                <span>{n.label}</span>
                {totalsByView[n.id] != null && <span className="nav-count">{totalsByView[n.id]}</span>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="user-chip">
            <Avatar name="Zeynep Aydın" size="md" />
            <div className="col" style={{ gap: 0, flex: 1, minWidth: 0 }}>
              <div className="name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Zeynep Aydın</div>
              <div className="role">Product Manager</div>
            </div>
          </div>
          <button className="icon-btn" onClick={() => setWelcomeOpen(true)} title="Yardım ve özet">
            <Icons.Help size={15} />
          </button>
          <button className="icon-btn" onClick={() => setTweak('theme', t.theme === 'light' ? 'dark' : 'light')} title="Tema">
            {t.theme === 'light' ? <Icons.Moon size={15} /> : <Icons.Sun size={15} />}
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="main">
        <header className="topbar">
          <Heptagon variant="hept-topbar" />
          <div className="col" style={{ gap: 2 }}>
            <h1 className="hero-title">{meta.title}</h1>
            <div className="sub">{meta.sub}</div>
          </div>
          <div className="topbar-spacer" />
          {view === 'veri' &&
            <InfoButton title="Görevler" icon={<Icons.Table size={12} />}>
              <p>Tüm görevleri listele, filtrele ve düzenle. Sütun başlığına tıklayarak o sütuna özel sıralama ve filtre uygulayabilirsiniz.</p>
            </InfoButton>
          }
        </header>

        <main className="content">
          {renderView()}
        </main>
      </div>

      {/* Detail drawer */}
      {openTask &&
        <TaskDrawer
          task={openTask}
          tasks={tasks}
          onClose={() => setOpenTask(null)}
          onUpdate={updateTask}
          onDelete={deleteTask}
        />
      }

      {/* Cmd K */}
      {cmdOpen &&
        <CmdK
          onClose={() => setCmdOpen(false)}
          onNavigate={setView}
          onOpenTask={setOpenTask}
          onSetTheme={(theme) => setTweak('theme', theme)}
          tasks={tasks}
        />
      }

      {/* Welcome */}
      {welcomeOpen &&
        <WelcomeScreen
          stats={welcomeStats}
          onClose={closeWelcome}
          onNavigate={setView}
          showAgain={!hideWelcome}
          onShowAgainChange={(show) => setHideWelcome(!show)}
        />
      }
    </div>
  );
}
