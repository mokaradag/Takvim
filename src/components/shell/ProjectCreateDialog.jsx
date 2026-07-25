'use client';
import { useEffect, useMemo, useState } from 'react';
import { DateInput } from '../DateInput';
import { Icons } from '../icons';
import { SearchableSelect } from '../SearchableSelect';
import { Avatar } from '../ui';
import { ProjectColorPicker } from '../project/ProjectColorPicker';
import { fmtISO, today } from '../../scheduling/dates';

function initialForm(people) {
  return {
    code: '',
    name: '',
    leadId: people[0]?.id || '',
    dataDate: fmtISO(today()),
    color: 'blue',
    source: 'manual'
  };
}

function personLabel(person) {
  return person.employeeNo ? `${person.employeeNo} · ${person.name}` : person.name;
}

export function ProjectCreateDialog({ open, people = [], onClose, onCreate }) {
  const defaults = useMemo(() => initialForm(people), [people]);
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
  const setValue = (field, value) => {
    setError(null);
    setForm((current) => ({ ...current, [field]: value }));
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
        zIndex: 'var(--z-modal)',
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
        style={{ width: 'min(620px, 100%)', maxHeight: '90vh', overflowY: 'auto', padding: 22 }}
      >
        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <div className="col" style={{ gap: 3, flex: 1 }}>
            <div id="new-project-title" style={{ fontSize: 18, fontWeight: 750 }}>Yeni proje</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Kurumsal proje kodunu girebilir veya serbest çalışma için kod alanını boş bırakabilirsiniz. Kök iş dağılım ağacı düğümü otomatik oluşturulur.
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} disabled={saving} aria-label="Pencereyi kapat">
            <Icons.Close size={14} />
          </button>
        </div>

        <div className="col" style={{ gap: 16, marginTop: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, .7fr) minmax(260px, 1.3fr)', gap: 12 }}>
            <label className="col" style={{ gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 650 }}>Proje kodu <span className="muted">(isteğe bağlı)</span></span>
              <input
                className="input"
                value={form.code}
                onChange={setField('code')}
                placeholder="Örn. PRJ-2026-041"
                autoFocus
                disabled={saving}
              />
            </label>
            <label className="col" style={{ gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 650 }}>Proje adı</span>
              <input
                className="input"
                value={form.name}
                onChange={setField('name')}
                placeholder="Örn. Radar Modernizasyonu"
                disabled={saving}
              />
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
            <label className="col" style={{ gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 650 }}>Proje sorumlusu</span>
              <SearchableSelect
                value={form.leadId}
                options={personOptions}
                onChange={(leadId) => setValue('leadId', leadId)}
                placeholder={people.length ? 'Proje sorumlusu seçin' : 'Kişi bulunamadı'}
                searchPlaceholder="Ad, sicil, unvan veya birimle ara"
                emptyText="Eşleşen personel bulunamadı."
                disabled={saving || !people.length}
                maxVisible={60}
              />
            </label>

            <label className="col" style={{ gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 650 }}>Veri tarihi</span>
              <DateInput value={form.dataDate} onChange={(value) => setValue('dataDate', value)} allowEmpty={false} disabled={saving} />
            </label>
          </div>

          <ProjectColorPicker
            value={form.color}
            onChange={(color) => {
              setError(null);
              setForm((current) => ({ ...current, color }));
            }}
            disabled={saving}
          />

          <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
            Veritabanı entegrasyonunda kurumsal proje listesi <strong>ProjeKodu</strong> ve <strong>ProjeAdi</strong> alanlarından beslenebilir. Kullanıcı tarafından oluşturulan serbest projeler aynı modelde <strong>source: manual</strong> bilgisiyle tutulur.
          </div>

          {error && (
            <div style={{ padding: '10px 12px', borderRadius: 'var(--r-md)', border: '1px solid color-mix(in oklab, var(--status-overdue) 45%, var(--border))', background: 'color-mix(in oklab, var(--status-overdue) 8%, var(--bg-elev))', color: 'var(--status-overdue)', fontSize: 12.5 }}>
              {error}
            </div>
          )}
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 22 }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>Vazgeç</button>
          <button type="submit" className="btn primary" disabled={saving || !people.length}>
            <Icons.Plus size={14} /> {saving ? 'Oluşturuluyor...' : 'Projeyi oluştur'}
          </button>
        </div>
      </form>
    </div>
  );
}
