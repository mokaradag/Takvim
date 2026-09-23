'use client';
import { useMemo, useRef, useState } from 'react';
import { Icons } from '../../components/icons.jsx';
import {
  COORDINATION_DECISIONS,
  COORDINATION_DECISION_LABELS,
  COORDINATION_MODES,
  COORDINATION_STATUS_LABELS
} from '../../domain/assignment/assignmentCoordination.js';
import { fmt } from '../../scheduling/dates/index.js';
import { useModalFocusTrap } from '../schedule-change/useModalFocusTrap.js';
import { DirectoryPersonSearch } from './DirectoryPersonSearch.jsx';

/**
 * Atama koordinasyonu ayrıntı penceresi.
 *
 * Yerleşim ve klavye davranışı tarih talebi penceresiyle aynıdır: odak içeride
 * tutulur, Escape kapatır, karar kaydı sürerken kapatma engellenir.
 */

function headline(record) {
  if (record.mode === COORDINATION_MODES.NOTICE) return 'Kurum dışı atama bildirimi';
  if (record.status === 'PENDING') return 'Atama talebi';
  return `Atama talebi · ${COORDINATION_STATUS_LABELS[record.status] || record.status}`;
}

const PRIMARY_DECISIONS = new Set([COORDINATION_DECISIONS.APPROVE]);

export function AssignmentCoordinationDialog({
  record,
  onClose,
  onDecide,
  onOpenTask,
  restoreFocusRef
}) {
  const [message, setMessage] = useState('');
  const [suggested, setSuggested] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const closeRef = useRef(null);
  const dialogRef = useRef(null);
  useModalFocusTrap({ containerRef: dialogRef, initialFocusRef: closeRef, restoreFocusRef, onClose, blocked: busy });

  const decisions = useMemo(() => record.allowedDecisions || [], [record.allowedDecisions]);
  const canSuggest = decisions.includes(COORDINATION_DECISIONS.REQUEST_CHANGE);
  // Etiket yanıt notunu "değişiklik isteğinde zorunlu" diye bildirir; düğme de
  // aynı kuralı uygular. Uygulanmadığında boş notlu istek gidiyor ve kullanıcı
  // ya gidiş-dönüş sonrası geç bir hata alıyor ya da etiket yalan oluyordu.
  const noteMissing = !message.trim();

  const decide = async (decision) => {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await onDecide(record.id, {
        decision,
        message: message.trim(),
        version: record.version,
        suggestedAssigneeSicil: decision === COORDINATION_DECISIONS.REQUEST_CHANGE ? suggested?.sicil ?? null : null
      });
    } catch (decisionError) {
      setError(decisionError?.message || 'Karar kaydedilemedi.');
      return;
    } finally {
      setBusy(false);
    }
    if (!result?.ok) {
      setError(result?.message || 'Karar kaydedilemedi.');
      return;
    }
    if (result.value?.outcome === 'STALE') {
      setError(result.value.message);
      return;
    }
    onClose();
  };

  return (
    <div className="schedule-modal-layer">
      <button className="schedule-modal-backdrop" type="button" aria-label="Atama koordinasyonunu kapat" onClick={onClose} disabled={busy} />
      <section ref={dialogRef} className="schedule-modal coordination-modal" role="dialog" aria-modal="true" aria-labelledby="coordination-title" tabIndex={-1}>
        <header className="schedule-modal-head">
          <div>
            <span className={`schedule-status coordination-${record.status.toLowerCase()}`}>
              {COORDINATION_STATUS_LABELS[record.status] || record.status}
            </span>
            <h2 id="coordination-title">{headline(record)}</h2>
            <p>{record.projectCode ? `${record.projectCode} · ` : ''}{record.taskTitle || 'Silinen görev'}</p>
          </div>
          <button ref={closeRef} className="icon-btn" type="button" onClick={onClose} aria-label="Kapat" disabled={busy}>
            <Icons.Close size={15} />
          </button>
        </header>

        <dl className="coordination-facts">
          <div>
            <dt>Görevlendirilen</dt>
            <dd>
              <strong>{record.assigneeName}</strong>
              <small className="tabular">Sicil {record.assigneeSicil}</small>
              {record.assigneeOrganization && <small className="muted">{record.assigneeOrganization}</small>}
            </dd>
          </div>
          <div>
            <dt>{record.mode === COORDINATION_MODES.NOTICE ? 'Atayan' : 'Talep eden'}</dt>
            <dd>
              <strong>{record.requesterName}</strong>
              <small className="tabular">Sicil {record.requesterSicil}</small>
            </dd>
          </div>
          <div>
            <dt>Proje</dt>
            <dd><strong>{record.projectName || '—'}</strong>{record.projectCode && <small className="muted">{record.projectCode}</small>}</dd>
          </div>
          <div>
            <dt>Hedef</dt>
            <dd><strong className="tabular">{record.targetFinish ? fmt(record.targetFinish, 'dd MMM yyyy') : '—'}</strong></dd>
          </div>
          <div>
            <dt>Oluşturma</dt>
            <dd><strong className="tabular">{record.createdAt ? new Date(record.createdAt).toLocaleString('tr-TR') : '—'}</strong></dd>
          </div>
          <div>
            <dt>Son yanıt</dt>
            <dd><strong className="tabular">{record.decidedAt ? new Date(record.decidedAt).toLocaleString('tr-TR') : '—'}</strong>
              {record.decisionByName && <small className="muted">{record.decisionByName}</small>}</dd>
          </div>
        </dl>

        {record.requesterMessage && (
          <div className="schedule-request-message">
            <strong>Talep notu</strong>
            <p>{record.requesterMessage}</p>
          </div>
        )}
        {record.decisionMessage && (
          <div className="schedule-request-message decision">
            <strong>Yanıt notu</strong>
            <p>{record.decisionMessage}</p>
          </div>
        )}
        {record.suggestedAssigneeName && (
          <div className="schedule-request-message decision">
            <strong>Alternatif öneri</strong>
            <p>{record.suggestedAssigneeName} · Sicil {record.suggestedAssigneeSicil}</p>
          </div>
        )}

        {decisions.length > 0 && (
          <label className="schedule-message-field">
            <span>Yanıt notu {canSuggest ? <small>(değişiklik isteğinde zorunlu)</small> : <small>(isteğe bağlı)</small>}</span>
            <textarea className="input" rows={2} maxLength={2000} name="coordinationDecisionNote"
              value={message} disabled={busy} onChange={(event) => setMessage(event.target.value)} />
          </label>
        )}
        {canSuggest && (
          <div className="coordination-suggestion">
            <span className="label">Bunun yerine önerilecek personel <small>(isteğe bağlı)</small></span>
            <DirectoryPersonSearch
              ariaLabel="Alternatif personel ara"
              placeholder="Ad veya sicil ile ara"
              selected={suggested}
              disabled={busy}
              onSelect={setSuggested}
            />
            <p className="muted">Yalnızca kendi personelinizi önerebilirsiniz; öneri sicil ile kaydedilir.</p>
          </div>
        )}

        {error && <div className="schedule-modal-error" role="alert"><Icons.Alert size={13} /> {error}</div>}

        <footer className="schedule-modal-actions">
          <button className="btn" type="button" disabled={busy || record.taskAvailable === false}
            title={record.taskAvailable === false ? 'Görev silinmiş veya proje kapatılmış.' : undefined}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const result = await onOpenTask(record.taskId);
                if (result?.ok === false) setError(result.error?.message || 'Görev açılamadı.');
                else onClose();
              } catch (openError) {
                setError(openError.message || 'Görev açılamadı.');
              } finally { setBusy(false); }
            }}>
            Görevi aç
          </button>
          <div style={{ flex: 1 }} />
          {decisions.length ? decisions.map((decision) => (
            <button key={decision} type="button" aria-busy={busy}
              disabled={busy || (decision === COORDINATION_DECISIONS.REQUEST_CHANGE && noteMissing)}
              title={decision === COORDINATION_DECISIONS.REQUEST_CHANGE && noteMissing
                ? 'Değişiklik isteğinde yanıt notu zorunludur.' : undefined}
              className={`btn${PRIMARY_DECISIONS.has(decision) ? ' primary' : ''}${decision === COORDINATION_DECISIONS.REJECT ? ' schedule-reject' : ''}`}
              onClick={() => decide(decision)}>
              {PRIMARY_DECISIONS.has(decision) && <Icons.Check size={13} />} {COORDINATION_DECISION_LABELS[decision]}
            </button>
          )) : <button className="btn primary" type="button" onClick={onClose} disabled={busy}>Tamam</button>}
        </footer>
      </section>
    </div>
  );
}
