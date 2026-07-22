'use client';
import { useEffect, useMemo, useState } from 'react';
import { Icons } from '../icons';
import { COLOR_MAP } from '../../lib/colors';
import { fmtISO, today } from '../../scheduling/dates';

const COLOR_LABELS = {
  blue: 'Mavi',
  emerald: 'Yeşil',
  purple: 'Mor',
  amber: 'Kehribar',
  rose: 'Gül',
  cyan: 'Camgöbeği'
};

function initialForm(people, calendars) {
  return {
    name: '',
    leadId: people[0]?.id || '',
    calendarId: calendars[0]?.id || '',
    dataDate: fmtISO(today()),
    color: 'blue'
  };
}

export function ProjectCreateDialog({ open, people = [], calendars = [], onClose, onCreate }) {
  const defaults = useMemo(() => initialForm(people, calendars), [people, calendars]);
  const [form, setForm] = useState(defaults);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setForm(defaults);
    setSaving(false);
    setError(null);
  }, [open, defaults]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, saving, onClose]);

  if (!open) return null;

  const setField = (field) => (event) => {
    setError(null);
    setForm((current) => ({ ...current, [field]: event.target.value }));
  };

  const submit = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    const result = await onCreate(form);
    setSaving(false);
    if (!result?.ok) {
      setError(result?.error?.message || 'Proje oluşturulamadı. Lütfen yeniden deneyin.');
      return;
    }
    onClose();
  };

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 120,
        display: 'grid',
        placeItems: 'center',
        padding: 20,
        background: 'color-mix(in oklab, black 45%, transparent)'
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        onSubmit={submit}
        className="card"
        style={{ width: 'min(560px, 100%)', maxHeight: '90vh', overflowY: 'auto', padding: 22 }}
      >
        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <div className="col" style={{ gap: 3, flex: 1 }}>
            <div id="new-project-title" style={{ fontSize: 18, fontWeight: 750 }}>Yeni proje</div>
            <div className="muted" style={{ fontSize: 12 }}>Proje bilgilerini tanımlayın. Kök WBS düğümü otomatik oluşturulur.</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} disabled={saving} aria-label="Pencereyi kapat">
            <Icons.Close size={14} />
          </button>
        </div>

        <div className="col" style={{ gap: 14, marginTop: 20 }}>
          <label className="col" style={{ gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 650 }}>Proje adı</span>
            <input
              className="input"
              value={form.name}
              onChange={setField('name')}
              placeholder="Örn. Radar Modernizasyonu"
              autoFocus
              disabled={saving}
            />
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
            <label className="col" style={{ gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 650 }}>Proje sorumlusu</span>
              <select className="input" value={form.leadId} onChange={setField('leadId')} disabled={saving || !people.length}>
                {!people.length && <option value="">Kişi bulunamadı</option>}
                {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
              </select>
            </label>

            <label className="col" style={{ gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 650 }}>Proje takvimi</span>
              <select className="input" value={form.calendarId} onChange={setField('calendarId')} disabled={saving || !calendars.length}>
                {!calendars.length && <option value="">Takvim bulunamadı</option>}
                {calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}
              </select>
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
            <label className="col" style={{ gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 650 }}>Veri tarihi</span>
              <input className="input" type="date" value={form.dataDate} onChange={setField('dataDate')} disabled={saving} />
            </label>

            <label className="col" style={{ gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 650 }}>Proje rengi</span>
              <select className="input" value={form.color} onChange={setField('color')} disabled={saving}>
                {Object.entries(COLOR_MAP).map(([key, value]) => (
                  <option key={key} value={key}>{COLOR_LABELS[key] || key} · {value.replace('var(', '').replace(')', '')}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(COLOR_MAP).map(([key, value]) => (
              <button
                key={key}
                type="button"
                aria-label={`${COLOR_LABELS[key] || key} rengini seç`}
                title={COLOR_LABELS[key] || key}
                onClick={() => setForm((current) => ({ ...current, color: key }))}
                disabled={saving}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 99,
                  border: form.color === key ? '2px solid var(--text)' : '2px solid transparent',
                  outline: '1px solid var(--border-strong)',
                  background: value,
                  cursor: 'pointer'
                }}
              />
            ))}
          </div>

          {error && (
            <div style={{ padding: '10px 12px', borderRadius: 'var(--r-md)', border: '1px solid color-mix(in oklab, var(--status-overdue) 45%, var(--border))', background: 'color-mix(in oklab, var(--status-overdue) 8%, var(--bg-elev))', color: 'var(--status-overdue)', fontSize: 12.5 }}>
              {error}
            </div>
          )}
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 22 }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>Vazgeç</button>
          <button type="submit" className="btn primary" disabled={saving || !people.length || !calendars.length}>
            <Icons.Plus size={14} /> {saving ? 'Oluşturuluyor...' : 'Projeyi oluştur'}
          </button>
        </div>
      </form>
    </div>
  );
}
