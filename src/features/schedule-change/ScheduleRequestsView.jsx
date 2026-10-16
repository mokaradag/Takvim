'use client';
import { useMemo, useRef, useState } from 'react';
import { useAllProjects, useSessionContext, useTaskActions } from '../../state/hooks/index.js';
import { DateInput } from '../../components/DateInput.jsx';
import { Icons } from '../../components/icons.jsx';
import { SearchableSelect } from '../../components/SearchableSelect.jsx';
import { markScheduleNotifications } from '../../data/api/scheduleChangeClient.js';
import { TaskTablePagination } from '../tasks/TaskTablePagination.jsx';
import { NotificationHistorySection } from '../notifications/NotificationHistorySection.jsx';
import { useTaskNotificationQuery } from '../notifications/useTaskNotificationQuery.js';
import { useAssignmentCoordinationQuery } from '../assignment-coordination/useAssignmentCoordinationQuery.js';
import { AssignmentCoordinationView, COORDINATION_INITIAL_QUERY } from '../assignment-coordination/AssignmentCoordinationView.jsx';
import { ScheduleRequestDetails, STATUS_LABELS } from './ScheduleRequestCenter.jsx';
import { useScheduleRequestQuery } from './useScheduleRequestQuery.js';

const COORDINATION_TAB = 'coordination';
const TABS = [
  { id: 'pending', label: 'Gelenler' },
  { id: 'sent', label: 'Gönderdiklerim' },
  { id: 'history', label: 'Geçmiş' },
  { id: COORDINATION_TAB, label: 'Atama Koordinasyonu' }
];
const INITIAL = { tab: 'pending', search: '', projectId: '', requester: '', status: '', from: '', to: '', page: 0 };

function messageOf(error, fallback) {
  return error?.message || error?.error?.message || fallback;
}

export function ScheduleRequestsView() {
  const session = useSessionContext();
  const recipient = `${session?.dataMode}:${session?.currentUser?.employeeNo ?? session?.currentUser?.id ?? ''}`;
  const recipientRef = useRef(recipient);
  recipientRef.current = recipient;
  const [storedRecipient, setStoredRecipient] = useState(recipient);
  const [coordinationQuery, setCoordinationQuery] = useState(COORDINATION_INITIAL_QUERY);
  const [query, setQuery] = useState(INITIAL);
  const [activeTab, setActiveTab] = useState('pending');
  const [selected, setSelected] = useState(null);
  const projects = useAllProjects();
  const projectOptions = useMemo(() => [
    { value: '', label: 'Tüm projeler' },
    ...projects
      .map((project) => ({
        value: project.id,
        label: project.name || project.projectName || project.code || 'Adsız proje',
        description: project.code || '',
        keywords: [project.code, project.name, project.projectName].filter(Boolean)
      }))
      .sort((left, right) => left.label.localeCompare(right.label, 'tr'))
  ], [projects]);
  const { decideScheduleChange, openTask, reloadData } = useTaskActions();
  const openOwnedTask = (taskId) => openTask(taskId, { isCurrent: () => recipientRef.current === recipient });
  const coordinationActive = activeTab === COORDINATION_TAB;
  const dateRequests = useScheduleRequestQuery(query);
  const { data, loading, error, actual, refresh } = dateRequests;
  const [notificationPages, setNotificationPages] = useState({ task: 0, coordination: 0 });
  const notificationTab = activeTab === 'history' ? 'history' : 'pending';
  const taskNotifications = useTaskNotificationQuery({ tab: notificationTab, page: notificationPages.task });
  const coordinationNotifications = useAssignmentCoordinationQuery(coordinationActive ? coordinationQuery : {
    tab: notificationTab === 'history' ? 'archive' : 'incoming', page: notificationPages.coordination
  });
  const refreshNotifications = () => { taskNotifications.refresh(); coordinationNotifications.refresh(); };
  const notificationsChanged = async () => {
    refreshNotifications();
    return (await reloadData?.({ preserveFailedTaskUpdates: true })) || { ok: true };
  };
  const openerRef = useRef(null);
  const tabsRef = useRef(null);
  const [readError, setReadError] = useState(null);
  const change = (key, value) => setQuery((current) => ({ ...current, [key]: value, page: 0 }));
  const selectTab = (id) => {
    setActiveTab(id);
    setSelected(null);
    setNotificationPages({ task: 0, coordination: 0 });
    if (id !== COORDINATION_TAB) change('tab', id);
  };
  if (storedRecipient !== recipient) {
    setStoredRecipient(recipient); setSelected(null); setReadError(null);
    setQuery(INITIAL); setActiveTab('pending');
    setCoordinationQuery(COORDINATION_INITIAL_QUERY);
    setNotificationPages({ task: 0, coordination: 0 });
  }
  const coordinationCounts = coordinationNotifications.data.notificationCounts || coordinationNotifications.data.counts;
  const tabCount = (id) => {
    if (id === COORDINATION_TAB) return coordinationNotifications.countsKnown === false || coordinationNotifications.error ? '…' : coordinationCounts.all;
    if (id === 'sent') return dateRequests.countsKnown === false || dateRequests.error ? '…' : data.counts.sent;
    if ([dateRequests, taskNotifications, coordinationNotifications].some((source) => source.countsKnown === false || source.error)) return '…';
    return data.counts[id] + taskNotifications.data.counts[id] + coordinationCounts[id === 'history' ? 'archive' : 'incoming'];
  };
  const open = async (request, target) => {
    openerRef.current = target;
    setSelected(request);
    setReadError(null);
    const result = await markScheduleNotifications([request]);
    if (recipientRef.current !== recipient) return;
    if (!result.ok) setReadError(result.message);
    else { refresh(); await reloadData?.({ preserveFailedTaskUpdates: true }); }
  };
  const sourceErrors = [dateRequests, taskNotifications, coordinationNotifications].filter((source) => source.error);
  return <div className="requests-view">
    <div ref={tabsRef} className="request-tabs" role="tablist" aria-label="Talep türü">
      {TABS.map((tab, index) => <button key={tab.id} type="button" role="tab" id={`requests-${tab.id}-tab`}
        aria-controls="requests-panel" aria-busy={dateRequests.loading || taskNotifications.loading || coordinationNotifications.loading}
        aria-selected={activeTab === tab.id} tabIndex={activeTab === tab.id ? 0 : -1}
        onClick={() => selectTab(tab.id)} onKeyDown={(event) => {
          let next;
          if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
          if (event.key === 'ArrowLeft') next = (index + TABS.length - 1) % TABS.length;
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = TABS.length - 1;
          if (next == null) return;
          event.preventDefault(); selectTab(TABS[next].id);
          tabsRef.current?.querySelectorAll('[role="tab"]')[next]?.focus();
        }}>{tab.label}<span>{tabCount(tab.id)}</span></button>)}
    </div>
    {sourceErrors.length > 0 &&
      <p role="alert" className="schedule-modal-error">Bildirim verilerinin bir bölümü güncellenemedi; birleşik toplam bilinmiyor. Bilinen bölüm değerleri korunuyor.
        <button type="button" className="btn ghost sm" onClick={() => { refresh(); refreshNotifications(); }}>Yenile</button></p>}
    <section className="card requests-panel" id="requests-panel" role="tabpanel" aria-labelledby={`requests-${activeTab}-tab`} aria-busy={coordinationActive ? undefined : loading}>
      {coordinationActive ? <AssignmentCoordinationView query={coordinationQuery} setQuery={setCoordinationQuery}
        result={coordinationNotifications} onChanged={notificationsChanged} /> : <>
      <h3>Tarih değişikliği talepleri <span className="muted tabular">({dateRequests.totalKnown === false ? '…' : data.total})</span></h3>
      <p className="muted">Aşağıdaki filtreler tarih değişikliği taleplerine uygulanır.</p>
      <div className="detail-list-filters request-filters">
        <label><span>Ara</span><input className="input" type="search" value={query.search} placeholder="Görev, proje veya talep notu…" onChange={(event) => change('search', event.target.value)} /></label>
        <div style={{ display: 'flex', flex: '1 1 160px', flexDirection: 'column', gap: 5, minWidth: 0, fontSize: 11, color: 'var(--text-dim)' }}>
          <span>Proje</span>
          <SearchableSelect compact style={{ width: '100%' }} ariaLabel="Proje filtresi" value={query.projectId}
            onChange={(value) => change('projectId', value)} searchPlaceholder="Proje ara" options={projectOptions} />
        </div>
        <label><span>Talep eden</span><input className="input" value={query.requester} placeholder="Ad veya sicil" onChange={(event) => change('requester', event.target.value)} /></label>
        <label><span>Durum</span><select className="input" value={query.status} onChange={(event) => change('status', event.target.value)}><option value="">Tüm durumlar</option>{Object.entries(STATUS_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label><span>Talep tarihi · İlk</span><DateInput ariaLabel="İlk talep tarihi" value={query.from} onChange={(value) => change('from', value)} /></label>
        <label><span>Talep tarihi · Son</span><DateInput ariaLabel="Son talep tarihi" value={query.to} onChange={(value) => change('to', value)} /></label>
        <button type="button" className="btn ghost sm" onClick={() => setQuery({ ...INITIAL, tab: query.tab })}>Filtreleri temizle</button>
      </div>
      {(error || readError) && <p role="alert" className="schedule-modal-error">{[error, readError].filter(Boolean).join(' · ')}<button type="button" className="btn ghost sm" onClick={refresh}>Yenile</button></p>}
      {!actual && <p className="empty">Tarih değişikliği talepleri Gerçek Sistem kipinde kullanılabilir.</p>}
      {loading && <p className="muted" role="status">Talepler yükleniyor…</p>}
      <div className="detail-list-scroll">
        <table className="table detail-list-table enterprise-table">
          <caption className="sr-only">Tarih değişikliği talepleri</caption>
          <thead><tr>{['Görev / Proje', 'Talep eden', 'Durum', 'Talep tarihi', 'Karar tarihi'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{data.items.map((request) => <tr key={request.id}>
            <td><button type="button" className="detail-task-link" disabled={dateRequests.rowsKnown === false} onClick={(event) => open(request, event.currentTarget)}>{request.taskTitle || 'Silinen görev'} <Icons.ChevronRight size={12} /></button><small className="muted">{request.projectCode} · {request.projectName}</small></td>
            <td>{request.requesterName}<small className="muted">{request.requesterSicil}</small></td>
            <td>{request.taskAvailable === false && <small className="muted">Görev silinmiş veya proje kapalı</small>}<span className={`schedule-status ${request.status.toLowerCase()}`}>{STATUS_LABELS[request.status]}</span>{request.isDecisionOwner && request.status === 'PENDING' && request.taskAvailable !== false && <small>Kararınız bekleniyor</small>}</td>
            <td className="tabular">{request.createdAt ? new Date(request.createdAt).toLocaleString('tr-TR') : '—'}</td>
            <td className="tabular">{request.decidedAt ? new Date(request.decidedAt).toLocaleString('tr-TR') : '—'}</td>
          </tr>)}</tbody>
        </table>
        {actual && !loading && !error && !data.items.length && <p className="empty">Bu görünümde talep bulunamadı.</p>}
      </div>
      {dateRequests.totalKnown !== false && <TaskTablePagination page={data.page} pageCount={Math.max(1, Math.ceil(data.total / data.pageSize))} label="Talep sayfaları"
        setPage={(update) => setQuery((current) => ({ ...current, page: typeof update === 'function' ? update(data.page) : update }))} />}
      {activeTab !== 'sent' && <>
        <NotificationHistorySection key={`${recipient}-task-${activeTab}`} result={taskNotifications}
          setPage={(page) => setNotificationPages((current) => ({ ...current, task: page }))} onChanged={notificationsChanged} />
        <NotificationHistorySection key={`${recipient}-coordination-${activeTab}`} coordination result={coordinationNotifications}
          setPage={(page) => setNotificationPages((current) => ({ ...current, coordination: page }))} onChanged={notificationsChanged} />
      </>}
      </>}
    </section>
    {!coordinationActive && storedRecipient === recipient && selected && <ScheduleRequestDetails request={data.items.find((item) => item.id === selected.id) || selected}
      restoreFocusRef={openerRef} onClose={() => setSelected(null)} onOpenTask={openOwnedTask}
      onDecide={async (...args) => {
        const result = await decideScheduleChange(...args);
        refresh();
        if (recipientRef.current === recipient) {
          if (result?.refreshError) setReadError(`Yenileme: ${messageOf(result.refreshError, 'Talepler yenilenemedi.')}`);
          if (result?.value?.request) setSelected(result.value.request);
        }
        return result;
      }} />}
  </div>;
}
