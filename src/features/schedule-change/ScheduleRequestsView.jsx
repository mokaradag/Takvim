'use client';
import { useMemo, useRef, useState } from 'react';
import { useAllProjects, useTaskActions } from '../../state/hooks/index.js';
import { DateInput } from '../../components/DateInput.jsx';
import { Icons } from '../../components/icons.jsx';
import { SearchableSelect } from '../../components/SearchableSelect.jsx';
import { markScheduleNotifications } from '../../data/api/scheduleChangeClient.js';
import { TaskTablePagination } from '../tasks/TaskTablePagination.jsx';
import { ScheduleRequestDetails, STATUS_LABELS } from './ScheduleRequestCenter.jsx';
import { useScheduleRequestQuery } from './useScheduleRequestQuery.js';

const TABS = [{ id: 'pending', label: 'Gelenler' }, { id: 'sent', label: 'Gönderdiklerim' }, { id: 'history', label: 'Geçmiş' }];
const INITIAL = { tab: 'pending', search: '', projectId: '', requester: '', status: '', from: '', to: '', page: 0 };

export function ScheduleRequestsView() {
  const [query, setQuery] = useState(INITIAL);
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
  const { data, loading, error, actual, refresh } = useScheduleRequestQuery(query);
  const openerRef = useRef(null);
  const tabsRef = useRef(null);
  const [readError, setReadError] = useState(null);
  const change = (key, value) => setQuery((current) => ({ ...current, [key]: value, page: 0 }));
  const open = async (request, target) => {
    openerRef.current = target;
    setSelected(request);
    setReadError(null);
    const result = await markScheduleNotifications([request]);
    if (!result.ok) setReadError(result.message);
    else { refresh(); await reloadData?.({ preserveFailedTaskUpdates: true }); }
  };
  return <div className="requests-view">
    <div ref={tabsRef} className="request-tabs" role="tablist" aria-label="Talep türü">
      {TABS.map((tab, index) => <button key={tab.id} type="button" role="tab" id={`requests-${tab.id}-tab`}
        aria-controls="requests-panel" aria-selected={query.tab === tab.id} tabIndex={query.tab === tab.id ? 0 : -1}
        onClick={() => change('tab', tab.id)} onKeyDown={(event) => {
          let next;
          if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
          if (event.key === 'ArrowLeft') next = (index + TABS.length - 1) % TABS.length;
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = TABS.length - 1;
          if (next == null) return;
          event.preventDefault(); change('tab', TABS[next].id);
          tabsRef.current?.querySelectorAll('[role="tab"]')[next]?.focus();
        }}>{tab.label}<span>{data.counts[tab.id]}</span></button>)}
    </div>
    <section className="card requests-panel" id="requests-panel" role="tabpanel" aria-labelledby={`requests-${query.tab}-tab`} aria-busy={loading}>
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
      {(error || readError) && <p role="alert" className="schedule-modal-error">{error || readError}<button type="button" className="btn ghost sm" onClick={refresh}>Yenile</button></p>}
      {!actual && <p className="empty">Tarih değişikliği talepleri Gerçek Sistem kipinde kullanılabilir.</p>}
      {loading && <p className="muted" role="status">Talepler yükleniyor…</p>}
      <div className="detail-list-scroll">
        <table className="table detail-list-table">
          <caption className="sr-only">Tarih değişikliği talepleri</caption>
          <thead><tr>{['Görev / Proje', 'Talep eden', 'Durum', 'Talep tarihi', 'Karar tarihi'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{data.items.map((request) => <tr key={request.id}>
            <td><button type="button" className="detail-task-link" onClick={(event) => open(request, event.currentTarget)}>{request.taskTitle || 'Silinen görev'} <Icons.ChevronRight size={12} /></button><small className="muted">{request.projectCode} · {request.projectName}</small></td>
            <td>{request.requesterName}<small className="muted">{request.requesterSicil}</small></td>
            <td>{request.taskAvailable === false && <small className="muted">Görev silinmiş veya proje kapalı</small>}<span className={`schedule-status ${request.status.toLowerCase()}`}>{STATUS_LABELS[request.status]}</span>{request.isDecisionOwner && request.status === 'PENDING' && request.taskAvailable !== false && <small>Kararınız bekleniyor</small>}</td>
            <td className="tabular">{request.createdAt ? new Date(request.createdAt).toLocaleString('tr-TR') : '—'}</td>
            <td className="tabular">{request.decidedAt ? new Date(request.decidedAt).toLocaleString('tr-TR') : '—'}</td>
          </tr>)}</tbody>
        </table>
        {actual && !loading && !error && !data.items.length && <p className="empty">Bu görünümde talep bulunamadı.</p>}
      </div>
      <TaskTablePagination page={data.page} pageCount={Math.max(1, Math.ceil(data.total / data.pageSize))} label="Talep sayfaları"
        setPage={(update) => setQuery((current) => ({ ...current, page: typeof update === 'function' ? update(data.page) : update }))} />
    </section>
    {selected && <ScheduleRequestDetails request={data.items.find((item) => item.id === selected.id) || selected}
      restoreFocusRef={openerRef} onClose={() => setSelected(null)} onOpenTask={openTask}
      onDecide={async (...args) => { const result = await decideScheduleChange(...args); refresh(); if (result?.value?.request) setSelected(result.value.request); return result; }} />}
  </div>;
}
