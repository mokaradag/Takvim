'use client';
import { useEffect, useRef, useState } from 'react';
import { Icons } from '../../components/icons.jsx';
import { fmt } from '../../scheduling/dates/index.js';
import { useScheduleRequests, useTaskActions } from '../../state/hooks/index.js';
import { SCHEDULE_DATE_ROWS, requestDates, scheduleDifferenceSummary } from './scheduleChangePresentation.js';
import { reduceScheduleRequestCenterOpen, scheduleRequestCenterViewState } from './scheduleRequestCenterState.js';
import { useModalFocusTrap } from './useModalFocusTrap.js';

const STATUS_LABELS = Object.freeze({
  PENDING: 'Bekliyor',
  ACCEPTED: 'Kabul edildi',
  REJECTED: 'Reddedildi',
  CANCELLED: 'Değiştirildi',
  STALE: 'Güncelliğini yitirdi'
});

function requestHeadline(request) {
  if (request.status === 'PENDING') return 'Tarih değişikliği talebi';
  return `Tarih değişikliği ${STATUS_LABELS[request.status]?.toLocaleLowerCase('tr-TR') || 'sonuçlandı'}`;
}

function ScheduleRequestDetails({ request, onClose, onDecide, onOpenTask, restoreFocusRef }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const decisionAvailable = request.isDecisionOwner && request.status === 'PENDING';
  const current = requestDates(request, 'original');
  const proposed = requestDates(request, 'proposed');
  const summary = scheduleDifferenceSummary(current, proposed);
  const closeRef = useRef(null);
  const dialogRef = useRef(null);

  useModalFocusTrap({
    containerRef: dialogRef,
    initialFocusRef: closeRef,
    restoreFocusRef,
    onClose,
    blocked: busy
  });

  const decide = async (decision) => {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await onDecide(request.id, decision, message.trim());
    } catch (decisionError) {
      setError(decisionError?.message || 'Talep kararı kaydedilemedi.');
      return;
    } finally {
      setBusy(false);
    }
    if (!result?.ok) {
      setError(result?.error?.message || 'Talep kararı kaydedilemedi.');
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
      <button className="schedule-modal-backdrop" type="button" aria-label="Talep ayrıntısını kapat" onClick={onClose} disabled={busy} />
      <section ref={dialogRef} className="schedule-modal schedule-request-details" role="dialog" aria-modal="true" aria-labelledby="schedule-request-title" tabIndex={-1}>
        <header className="schedule-modal-head">
          <div>
            <span className={`schedule-status ${request.status.toLowerCase()}`}>{STATUS_LABELS[request.status] || request.status}</span>
            <h2 id="schedule-request-title">{requestHeadline(request)}</h2>
            <p>{request.requesterName} · {request.projectCode ? `${request.projectCode} · ` : ''}{request.taskTitle}</p>
          </div>
          <button ref={closeRef} className="icon-btn" type="button" onClick={onClose} aria-label="Kapat" disabled={busy}><Icons.Close size={15} /></button>
        </header>

        <table className="schedule-compare">
          <caption className="sr-only">Talep tarih karşılaştırması</caption>
          <thead>
            <tr className="schedule-compare-head">
              <th scope="col"><span className="sr-only">Tarih alanı</span></th>
              <th scope="col">Mevcut</th>
              <th scope="col">Önerilen</th>
            </tr>
          </thead>
          <tbody>
            {SCHEDULE_DATE_ROWS.map(({ key, label }) => (
              <tr className="schedule-compare-row" key={key}>
                <th scope="row">{label}</th>
                {/* Bkz. ScheduleChangeDialog: iki hücre de kullanıcının tarih
                    biçimiyle çizilir. */}
                <td className="tabular">{current[key] ? fmt(current[key], 'dd MMM yyyy') : '—'}</td>
                <td className="tabular schedule-proposed-date">{proposed[key] ? fmt(proposed[key], 'dd MMM yyyy') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {summary.length > 0 && <div className="schedule-difference-summary">{summary.map((item) => <span key={item}>{item}</span>)}</div>}

        <div className="schedule-request-message">
          <strong>Talep notu</strong>
          <p>{request.requesterMessage || 'Açıklama eklenmedi.'}</p>
        </div>
        {request.decisionMessage && (
          <div className="schedule-request-message decision">
            <strong>Karar notu</strong>
            <p>{request.decisionMessage}</p>
          </div>
        )}
        {decisionAvailable && (
          <label className="schedule-message-field">
            <span>Yanıt notu <small>(isteğe bağlı)</small></span>
            <textarea className="input" rows={2} maxLength={2000} name="scheduleDecisionNote" value={message} disabled={busy} onChange={(event) => setMessage(event.target.value)} />
          </label>
        )}
        {error && <div className="schedule-modal-error" role="alert"><Icons.Alert size={13} /> {error}</div>}
        <footer className="schedule-modal-actions">
          <button className="btn" type="button" disabled={busy} onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const result = await onOpenTask(request.taskId);
              if (result?.ok === false) setError(result.error?.message || 'Görev açılamadı.');
              else onClose();
            } catch (openError) {
              setError(openError.message || 'Görev açılamadı.');
            } finally { setBusy(false); }
          }}>
            Görevi aç
          </button>
          <div style={{ flex: 1 }} />
          {decisionAvailable ? <>
            <button className="btn schedule-reject" type="button" disabled={busy} onClick={() => decide('REJECT')}>
              Reddet
            </button>
            <button className="btn primary" type="button" disabled={busy} aria-busy={busy} onClick={() => decide('ACCEPT')}>
              <Icons.Check size={13} /> {busy ? 'Kaydediliyor…' : 'Kabul et'}
            </button>
          </> : <button className="btn primary" type="button" onClick={onClose} disabled={busy}>Tamam</button>}
        </footer>
      </section>
    </div>
  );
}

/**
 * Tarih değişikliği taleplerini ve kalıcı karar bildirimlerini sunar.
 */
export function ScheduleRequestCenter() {
  const requests = useScheduleRequests();
  const { decideScheduleChange, openTask } = useTaskActions();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const rootRef = useRef(null);
  const toggleRef = useRef(null);
  const pendingCount = requests.filter((request) => request.status === 'PENDING' && request.isDecisionOwner).length;
  const listed = requests;
  const {
    hasRequests,
    isOpen: requestCenterOpen,
    disabled: requestToggleDisabled
  } = scheduleRequestCenterViewState(requests, open);

  useEffect(() => {
    setOpen((current) => reduceScheduleRequestCenterOpen(current, { type: 'sync', hasRequests }));
  }, [hasRequests]);

  useEffect(() => {
    if (!requestCenterOpen) return undefined;
    const handlePointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const handleKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [requestCenterOpen]);

  return (
    <>
      <div className="schedule-request-center" ref={rootRef}>
        <button
          ref={toggleRef}
          className="icon-btn schedule-request-toggle"
          type="button"
          aria-label={pendingCount ? `${pendingCount} bekleyen tarih talebi` : hasRequests ? 'Tarih talepleri' : 'Tarih talebi bulunmuyor'}
          aria-expanded={requestCenterOpen}
          disabled={requestToggleDisabled}
          onClick={() => setOpen((current) => reduceScheduleRequestCenterOpen(current, { type: 'toggle', hasRequests }))}
          title={hasRequests ? 'Tarih talepleri' : 'Tarih talebi bulunmuyor'}
        >
          <Icons.Bell size={15} />
          {pendingCount > 0 && <span className="schedule-request-badge">{pendingCount > 9 ? '9+' : pendingCount}</span>}
        </button>
        {requestCenterOpen && (
          <section className="schedule-request-popover" role="dialog" aria-label="Tarih talepleri">
            <header>
              <div><strong>Tarih talepleri</strong><small>Kalıcı bildirimler ve kararlar</small></div>
              <span>{requests.length}</span>
            </header>
            <div className="schedule-request-list">
              {listed.map((request) => {
                const summary = scheduleDifferenceSummary(
                  requestDates(request, 'original'),
                  requestDates(request, 'proposed')
                )[0];
                return (
                  <button type="button" className="schedule-request-card" key={request.id} onClick={() => { setSelected(request); setOpen(false); }}>
                    <span className={`schedule-status ${request.status.toLowerCase()}`}>{STATUS_LABELS[request.status] || request.status}</span>
                    <strong>{requestHeadline(request)}</strong>
                    <small>{request.isRequester ? request.taskTitle : `${request.requesterName} · ${request.taskTitle}`}</small>
                    <span>{summary || 'Plan tarihleri için değişiklik'}</span>
                    <time>{request.createdAt ? new Date(request.createdAt).toLocaleString('tr-TR') : ''}</time>
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>
      {selected && (
        <ScheduleRequestDetails
          request={requests.find((request) => request.id === selected.id) || selected}
          onClose={() => setSelected(null)}
          onDecide={decideScheduleChange}
          onOpenTask={openTask}
          restoreFocusRef={toggleRef}
        />
      )}
    </>
  );
}
