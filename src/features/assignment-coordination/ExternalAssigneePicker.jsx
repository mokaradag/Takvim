'use client';
import { useMemo, useState } from 'react';
import { Icons } from '../../components/icons.jsx';
import { organizationPath } from '../../domain/assignment/assignmentCoordination.js';
import { DirectoryPersonSearch } from './DirectoryPersonSearch.jsx';

/**
 * "Diğer birimlerden personel göster" anahtarı ve kurum dışı seçim.
 *
 * Anahtar VARSAYILAN OLARAK KAPALIDIR: kapalıyken sorumlu seçicisi bugünkü izin
 * verilen personel davranışını aynen sürdürür. Açıldığında kurumsal dizin
 * SUNUCUDA aranır; dizin uygulama anlık görüntüsüne yüklenmez.
 *
 * Seçim iki yoldan birine düşer ve kullanıcıya AÇIKÇA söylenir:
 *   · doğrudan atama yetkisi varsa kişi olağan sorumlu listesine eklenir,
 *   · yoksa kayıt sırasında ilgili yöneticiye ATAMA TALEBİ gönderilir.
 *
 * Buradaki ayrım yalnızca arayüzdür; yetki her durumda sunucuda yeniden
 * doğrulanır ve talep edilen kişi onaylanana kadar gerçek sorumlu sayılmaz.
 */
export function ExternalAssigneePicker({
  canAssignDirectly,
  onAssignDirectly,
  requestedAssignees = [],
  onRequestAssignee,
  onCancelRequest,
  assignedSicils = [],
  disabled = false,
  requestNote = '',
  onRequestNoteChange = null
}) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState(null);
  const excluded = useMemo(() => new Set([
    ...assignedSicils.map(String),
    ...requestedAssignees.map((person) => String(person.sicil))
  ]), [assignedSicils, requestedAssignees]);

  const select = (person) => {
    if (!person) return;
    if (canAssignDirectly?.(person)) {
      setNotice(null);
      onAssignDirectly?.(person);
      return;
    }
    setNotice(`${person.name} doğrudan atama yetkinizin dışında. Kaydettiğinizde ilgili yöneticiye atama talebi gönderilecektir.`);
    onRequestAssignee?.(person);
  };

  return (
    <div className="external-assignee">
      <label className="switch-field">
        <input
          type="checkbox"
          role="switch"
          checked={open}
          disabled={disabled}
          onChange={(event) => { setOpen(event.target.checked); if (!event.target.checked) setNotice(null); }}
        />
        <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
        <span className="switch-label">Diğer birimlerden personel göster</span>
      </label>

      {open && (
        <div className="external-assignee-body">
          <DirectoryPersonSearch
            ariaLabel="Diğer birimlerden personel ara"
            placeholder="Ad veya sicil ile ara"
            disabled={disabled}
            excludeSicils={excluded}
            onSelect={select}
          />
          {notice && <p className="external-assignee-notice" role="status"><Icons.Info size={12} /> {notice}</p>}
        </div>
      )}

      {requestedAssignees.length > 0 && (
        <div className="external-assignee-pending">
          <span className="label"><Icons.Clock size={12} /> Atama talebi gönderilecek</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {requestedAssignees.map((person) => (
              <span key={person.sicil} className="external-assignee-chip">
                <span>{person.name}</span>
                <small className="tabular">{person.sicil}</small>
                {person.organizationPath && <small className="muted">{person.organizationPath}</small>}
                <button type="button" className="icon-btn" style={{ width: 18, height: 18 }} disabled={disabled}
                  aria-label={`${person.name} talebini kaldır`} onClick={() => onCancelRequest?.(person.sicil)}>
                  <Icons.Close size={10} />
                </button>
              </span>
            ))}
          </div>
          <p className="muted">
            Bu kişiler onaylanana kadar görevin sorumlusu sayılmaz; iş yükü, Özet, Kanban ve hatırlatmalar değişmez.
          </p>
          {onRequestNoteChange && (
            <label className="schedule-message-field">
              <span>Talep notu <small>(isteğe bağlı)</small></span>
              <textarea className="input" rows={2} maxLength={2000} name="assignmentRequestNote"
                value={requestNote} disabled={disabled}
                onChange={(event) => onRequestNoteChange(event.target.value)} />
            </label>
          )}
        </div>
      )}
    </div>
  );
}

export { organizationPath };
