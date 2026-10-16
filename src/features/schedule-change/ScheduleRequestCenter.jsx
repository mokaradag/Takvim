'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { markScheduleNotifications } from '../../data/api/scheduleChangeClient.js';
import { markNotificationItems } from '../../data/api/assignmentCoordinationClient.js';
import {
  combineActionErrors,
  decideCoordinationAndRefresh,
  notificationActionError,
  openTaskNotification
} from '../notifications/notificationActions.js';
import { Icons } from '../../components/icons.jsx';
import { fmt } from '../../scheduling/dates/index.js';
import {
  useAssignmentCoordinations,
  useNotificationSummary,
  useSessionContext,
  useScheduleRequests,
  useScheduleRequestSummary,
  useTaskActions,
  useTaskNotifications
} from '../../state/hooks/index.js';
import { AssignmentCoordinationDialog } from '../assignment-coordination/AssignmentCoordinationDialog.jsx';
import {
  NOTIFICATION_SOURCES,
  SCHEDULE_STATUS_LABELS,
  notificationCenterCounts,
  notificationCenterItems
} from '../notifications/notificationCenterItems.js';
import { SCHEDULE_DATE_ROWS, requestDates, scheduleDifferenceSummary } from './scheduleChangePresentation.js';
import { reduceScheduleRequestCenterOpen, scheduleRequestCenterViewState } from './scheduleRequestCenterState.js';
import { useModalFocusTrap } from './useModalFocusTrap.js';

export const STATUS_LABELS = SCHEDULE_STATUS_LABELS;

function requestHeadline(request) {
  if (request.status === 'PENDING') return 'Tarih değişikliği talebi';
  return `Tarih değişikliği ${STATUS_LABELS[request.status]?.toLocaleLowerCase('tr-TR') || 'sonuçlandı'}`;
}

function errorMessage(error, fallback) {
  return error?.message || error?.error?.message || fallback;
}

export function ScheduleRequestDetails({ request, onClose, onDecide, onOpenTask, restoreFocusRef }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const decisionAvailable = request.isDecisionOwner && request.status === 'PENDING' && request.taskAvailable !== false;
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
          <button className="btn" type="button" disabled={busy || request.taskAvailable === false} title={request.taskAvailable === false ? 'Görev silinmiş veya proje kapatılmış.' : undefined} onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const result = await onOpenTask(request.taskId);
              if (result?.stale) return;
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
 * BİRLEŞİK bildirim merkezi.
 *
 * Zil tektir: tarih değişikliği talebi, atama koordinasyonu ve atama olayı aynı
 * panelde, aynı okundu/temizlendi anlambilimiyle görünür. Her işlem başladığı
 * Sicil'e aittir; kullanıcı değişince eski işlem yeni alıcı adına yazamaz.
 */
export function ScheduleRequestCenter({ onNavigate }) {
  const session = useSessionContext();
  const recipient = `${session?.dataMode}:${session?.currentUser?.employeeNo ?? session?.currentUser?.id ?? ''}`;
  const recipientRef = useRef(recipient);
  recipientRef.current = recipient;
  const [storedRecipient, setStoredRecipient] = useState(recipient);
  const requests = useScheduleRequests();
  const coordinations = useAssignmentCoordinations();
  const taskEvents = useTaskNotifications();
  const { decideScheduleChange, openTask, reloadData } = useTaskActions();
  const openOwnedTask = (taskId) => openTask(taskId, { isCurrent: () => recipientRef.current === recipient });
  const summary = useScheduleRequestSummary();
  const notificationSummary = useNotificationSummary();
  const [notificationError, setNotificationError] = useState(null);
  const [marking, setMarking] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [selectedCoordination, setSelectedCoordination] = useState(null);
  if (storedRecipient !== recipient) {
    setStoredRecipient(recipient); setSelected(null); setSelectedCoordination(null);
    setNotificationError(null); setMarking(false); setOpen(false);
  }
  const rootRef = useRef(null);
  const toggleRef = useRef(null);
  const popoverRef = useRef(null);
  const counts = notificationCenterCounts(summary, notificationSummary);
  const pendingCount = counts.pendingCount;
  const unreadCount = counts.unreadCount;
  const listed = useMemo(
    () => notificationCenterItems({
      scheduleRequests: requests,
      assignmentCoordinations: coordinations,
      taskNotifications: taskEvents
    }),
    [requests, coordinations, taskEvents]
  );

  const mark = async (items, action = 'read', expectedRecipient = recipient) => {
    if (recipientRef.current !== expectedRecipient) return { ok: false, stale: true };
    if (!items.length) return { ok: true };
    if (marking) return { ok: false, message: 'Bildirim işlemi sürüyor.' };
    setMarking(true); setNotificationError(null);
    try {
      if (recipientRef.current !== expectedRecipient) return { ok: false, stale: true };
      const scheduleItems = items.filter((item) => item.source === NOTIFICATION_SOURCES.SCHEDULE_REQUEST);
      const otherItems = items.filter((item) => item.source !== NOTIFICATION_SOURCES.SCHEDULE_REQUEST);
      const results = await Promise.all([
        scheduleItems.length ? markScheduleNotifications(scheduleItems, action) : { ok: true },
        otherItems.length ? markNotificationItems(otherItems, action) : { ok: true }
      ]);
      if (recipientRef.current !== expectedRecipient) return { ok: false, stale: true };

      const failure = results.find((result) => !result.ok) || null;
      let refreshError = null;
      try {
        if (recipientRef.current === expectedRecipient) {
          const refreshed = await reloadData?.({ preserveFailedTaskUpdates: true });
          if (refreshed?.ok === false) refreshError = errorMessage(refreshed, 'Bildirimler yenilenemedi.');
        }
      } catch (error) {
        refreshError = errorMessage(error, 'Bildirimler yenilenemedi.');
      }
      if (recipientRef.current !== expectedRecipient) return { ok: false, stale: true };

      const businessError = failure ? (failure.message || failure.error?.message || 'Bildirim güncellenemedi.') : null;
      setNotificationError(combineActionErrors([['Okuma', businessError], ['Yenileme', refreshError]]));
      return failure
        ? { ...failure, ...(refreshError ? { refreshError } : {}) }
        : { ok: true, ...(refreshError ? { refreshError } : {}) };
    } catch (error) {
      if (recipientRef.current !== expectedRecipient) return { ok: false, stale: true };
      const failure = { ok: false, message: errorMessage(error, 'Bildirim güncellenemedi.') };
      setNotificationError(failure.message);
      return failure;
    } finally {
      if (recipientRef.current === expectedRecipient) setMarking(false);
    }
  };
  const {
    hasRequests,
    isOpen: requestCenterOpen,
    disabled: requestToggleDisabled
  } = scheduleRequestCenterViewState(listed, open);

  useModalFocusTrap({ containerRef: popoverRef, initialFocusRef: popoverRef, restoreFocusRef: toggleRef,
    onClose: () => setOpen(false), enabled: requestCenterOpen });

  useEffect(() => {
    setOpen((current) => reduceScheduleRequestCenterOpen(current, { type: 'sync', hasRequests }));
  }, [hasRequests]);

  useEffect(() => {
    if (!requestCenterOpen) return undefined;
    const handlePointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handlePointer);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
    };
  }, [requestCenterOpen]);

  return (
    <>
      <div className="schedule-request-center" ref={rootRef}>
        <button
          ref={toggleRef}
          className="icon-btn schedule-request-toggle"
          type="button"
          aria-label={`${unreadCount} okunmamış bildirim, ${pendingCount} kararınızı bekleyen kayıt`}
          aria-expanded={requestCenterOpen}
          disabled={requestToggleDisabled}
          onClick={() => setOpen((current) => reduceScheduleRequestCenterOpen(current, { type: 'toggle', hasRequests }))}
          title={hasRequests ? 'Bildirimler' : 'Bildirim bulunmuyor'}
        >
          <Icons.Bell size={15} />
          {unreadCount > 0 && <span className="schedule-request-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
          {pendingCount > 0 && <span className="schedule-action-dot" title="Kararınızı bekleyen kayıtlar var" />}
        </button>
        {requestCenterOpen && (
          <section ref={popoverRef} tabIndex={-1} className="schedule-request-popover" role="dialog" aria-label="Bildirimler">
            <header>
              <div><strong>Bildirimler</strong><small>{pendingCount ? `${pendingCount} kayıt kararınızı bekliyor` : 'Son bildirimler'}</small></div>
              <span>{unreadCount} yeni</span>
            </header>
            <div className="schedule-request-list">
              {listed.map((item) => {
                const scheduleSummary = item.source === NOTIFICATION_SOURCES.SCHEDULE_REQUEST
                  ? scheduleDifferenceSummary(requestDates(item, 'original'), requestDates(item, 'proposed'))[0]
                  : null;
                return (
                  <button type="button" className="schedule-request-card" disabled={marking} key={`${item.source}:${item.id}`} onClick={async () => {
                    const operationRecipient = recipient;
                    const taskEvent = item.source === NOTIFICATION_SOURCES.TASK_EVENT;
                    if (!taskEvent) setOpen(false);
                    if (item.source === NOTIFICATION_SOURCES.SCHEDULE_REQUEST) setSelected(item);
                    else if (item.source === NOTIFICATION_SOURCES.ASSIGNMENT_COORDINATION) setSelectedCoordination(item);
                    if (taskEvent) {
                      const outcome = await openTaskNotification(
                        item,
                        openTask,
                        (record) => mark([record], 'read', operationRecipient),
                        () => recipientRef.current === operationRecipient
                      );
                      if (recipientRef.current !== operationRecipient || outcome.stale) return;
                      const actionError = notificationActionError(outcome);
                      if (actionError) setNotificationError(actionError);
                      else setOpen(false);
                    } else {
                      await mark([item], 'read', operationRecipient);
                    }
                  }}>
                    <span className={`schedule-status ${item.statusClass}`}>{item.statusLabel}</span>
                    <strong>{item.headline}{item.unread && <span className="schedule-new-label">Yeni</span>}</strong>
                    <small>{item.subtitle}</small>
                    <span>{scheduleSummary || item.detail
                      || (item.source === NOTIFICATION_SOURCES.SCHEDULE_REQUEST ? 'Plan tarihleri için değişiklik' : '')}</span>
                    <time>{item.sortAt ? new Date(item.sortAt).toLocaleString('tr-TR') : ''}</time>
                  </button>
                );
              })}
            </div>
            {notificationError && <p role="alert" className="schedule-modal-error">{notificationError}</p>}
            <footer className="schedule-inbox-actions">
              <button type="button" className="btn ghost sm" disabled={marking} onClick={() => mark(listed)}>Okundu işaretle</button>
              <button type="button" className="btn ghost sm" disabled={marking} onClick={() => mark(listed, 'dismiss')}>Görünenleri temizle</button>
              <button type="button" className="btn sm" onClick={() => { setOpen(false); onNavigate?.('talepler'); }}>Tüm talepleri gör <Icons.ChevronRight size={12} /></button>
            </footer>
          </section>
        )}
      </div>
      {selected && (
        <ScheduleRequestDetails
          request={requests.find((request) => request.id === selected.id) || selected}
          onClose={() => setSelected(null)}
          onDecide={async (...args) => {
            const operationRecipient = recipient;
            const result = await decideScheduleChange(...args);
            if (recipientRef.current === operationRecipient && result?.refreshError) {
              setNotificationError(`Yenileme: ${errorMessage(result.refreshError, 'Bildirimler yenilenemedi.')}`);
              setOpen(true);
            }
            return result;
          }}
          onOpenTask={openOwnedTask}
          restoreFocusRef={toggleRef}
        />
      )}
      {selectedCoordination && (
        <AssignmentCoordinationDialog
          record={coordinations.find((item) => item.id === selectedCoordination.id) || selectedCoordination}
          onClose={() => setSelectedCoordination(null)}
          onOpenTask={openOwnedTask}
          onDecide={async (coordinationId, payload) => {
            const operationRecipient = recipient;
            let result;
            try {
              result = await decideCoordinationAndRefresh(coordinationId, payload, async () => {
                if (recipientRef.current !== operationRecipient) return { ok: true, stale: true };
                return reloadData?.({ preserveFailedTaskUpdates: true });
              });
            } catch (error) {
              if (recipientRef.current !== operationRecipient) return { ok: false, stale: true };
              const decisionError = errorMessage(error, 'Karar kaydedilemedi.');
              const displayedError = combineActionErrors([['Karar', decisionError], ['Yenileme', error.refreshError]]);
              setSelectedCoordination(null);
              setNotificationError(displayedError);
              setOpen(true);
              return { ok: false, message: decisionError, ...(error.refreshError ? { refreshError: error.refreshError } : {}) };
            }
            if (recipientRef.current !== operationRecipient) return { ...result, stale: true };
            const primaryError = !result.ok ? (result.message || result.error?.message || 'Karar kaydedilemedi.')
              : result.value?.outcome === 'STALE' ? result.value.message : null;
            const displayedError = combineActionErrors([['Karar', primaryError], ['Yenileme', result.refreshError]]);
            if (displayedError) {
              setSelectedCoordination(null);
              setNotificationError(displayedError);
              setOpen(true);
            }
            return result;
          }}
          restoreFocusRef={toggleRef}
        />
      )}
    </>
  );
}
