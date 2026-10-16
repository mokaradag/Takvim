'use client';
import { useNotificationActions } from './useNotificationActions.js';
import { useTaskActions } from '../../state/hooks/index.js';
import { AssignmentCoordinationDialog } from '../assignment-coordination/AssignmentCoordinationDialog.jsx';
import { TaskTablePagination } from '../tasks/TaskTablePagination.jsx';
import { coordinationItem, taskEventItem } from './notificationCenterItems.js';
import { combineActionErrors } from './notificationActions.js';

/** Her kaynağın sayfası ayrıdır; tarayıcıda birleşik geçmiş sıralanmaz. */
export function NotificationHistorySection({ coordination = false, result, setPage, onChanged }) {
  const { data, loading, error, actual } = result;
  const { openTask } = useTaskActions();
  const { selected, busy, actionError, fallbackRef, open, read, decide, openEvent, openOwnedTask, close, refresh: retry } = useNotificationActions(onChanged, openTask);
  const title = coordination ? 'Atama koordinasyonu bildirimleri' : 'Görev bildirimleri';
  const rows = data.items.map(coordination ? coordinationItem : taskEventItem);
  const displayedError = combineActionErrors([['Sorgu', error], ['İşlem', actionError]]);
  const rowsActionable = result.rowsKnown !== false;

  return <section ref={fallbackRef} tabIndex={-1} className="notification-history-section" aria-label={title} aria-busy={loading}>
    <h3>{title} <span className="muted tabular">({result.totalKnown === false ? '…' : data.total})</span></h3>
    {displayedError && <p role="alert" className="schedule-modal-error">{displayedError}
      <button type="button" className="btn ghost sm" onClick={() => { void retry(); }}>Yenile</button></p>}
    {!actual && <p className="empty">Bildirimler Gerçek Sistem kipinde kullanılabilir.</p>}
    {loading && <p className="muted" role="status">Bildirimler yükleniyor…</p>}
    <div className="detail-list-scroll">
      <table className="table detail-list-table enterprise-table">
        <caption className="sr-only">{title}</caption>
        <thead><tr>{['Bildirim / Görev / Proje', 'İlgili kişi', 'Durum', 'Tarih', 'İşlem'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{rows.map((record) => <tr key={`${record.source}:${record.id}`}>
          <td>{coordination ? <button type="button" className="detail-task-link" disabled={busy || !rowsActionable} onClick={() => open(record)}>{record.headline}</button> : <strong>{record.headline}</strong>}
            <small>{record.taskTitle || 'Silinen görev'}</small>
            <small className="muted">{[record.projectCode, record.projectName].filter(Boolean).join(' · ')}</small>
          </td>
          <td>{coordination ? record.assigneeName : record.actorName}
            <small className="muted">{coordination ? record.requesterName : record.actorSicil}</small></td>
          <td><span className={`schedule-status ${record.statusClass}`}>{record.statusLabel}</span>
            {record.unread && <small>Okunmadı</small>}
            {record.actionable && <small>Kararınız bekleniyor</small>}
            {record.taskAvailable === false && <small className="muted">Görev silinmiş veya proje kapalı</small>}</td>
          <td className="tabular">{record.sortAt ? new Date(record.sortAt).toLocaleString('tr-TR') : '—'}</td>
          <td>{record.unread && <button type="button" className="btn ghost sm" disabled={busy || !rowsActionable} onClick={() => read(record)}>Okundu işaretle</button>}
            {!coordination && Number(record.taskCount || 1) === 1 && <button type="button" className="btn ghost sm" disabled={busy || !rowsActionable || record.taskAvailable === false}
              onClick={() => openEvent(record)}>Görevi aç</button>}</td>
        </tr>)}</tbody>
      </table>
      {actual && !loading && !error && !rows.length && <p className="empty">Bu görünümde bildirim bulunamadı.</p>}
    </div>
    {result.totalKnown !== false && <TaskTablePagination page={data.page} pageCount={Math.max(1, Math.ceil(data.total / data.pageSize))}
      label={`${title} sayfaları`} setPage={(update) => setPage(typeof update === 'function' ? update(data.page) : update)} />}
    {selected && <AssignmentCoordinationDialog record={rows.find((item) => item.id === selected.id) || selected}
      restoreFocusRef={fallbackRef} onClose={close} onOpenTask={openOwnedTask} onDecide={decide} />}
  </section>;
}
