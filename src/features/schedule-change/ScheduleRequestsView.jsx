'use client';
import { useMemo, useRef, useState } from 'react';
import { useAllProjects, useTaskActions } from '../../state/hooks/index.js';
import { DateInput } from '../../components/DateInput.jsx';
import { Icons } from '../../components/icons.jsx';
import { SearchableSelect } from '../../components/SearchableSelect.jsx';
import { NOTIFICATION_SOURCES } from '../../domain/notifications/notificationInbox.js';
import { TaskTablePagination } from '../tasks/TaskTablePagination.jsx';
import { AssignmentCoordinationDialog } from '../assignment-coordination/AssignmentCoordinationDialog.jsx';
import { AssignmentCoordinationView } from '../assignment-coordination/AssignmentCoordinationView.jsx';
import { ScheduleRequestDetails } from './ScheduleRequestCenter.jsx';
import {
  REQUEST_CATEGORY_FILTER_OPTIONS,
  REQUEST_STATUS_FILTER_OPTIONS,
  requestInboxRow,
  sameRequestInboxItem,
  selectFresherRecord
} from './requestInboxPresentation.js';
import { useRequestInboxQuery } from './useRequestInboxQuery.js';

const COORDINATION_TAB = 'coordination';
const TABS = [
  { id: 'pending', label: 'Gelenler', hint: 'Kararınızı bekleyen kayıtlar ve okunmamış bildirimler' },
  { id: 'sent', label: 'Gönderdiklerim', hint: 'Gönderdiğiniz tarih ve atama talepleri' },
  { id: 'history', label: 'Geçmiş', hint: 'Sonuçlanan talepler ve okunmuş olanlar dahil bütün atama bildirimleri' },
  // Atama koordinasyonu BİRİNCİ SINIF sekmedir: ayrı bir kenar çubuğu sayfası
  // açılmaz, var olan talep altyapısı olduğu gibi korunur.
  { id: COORDINATION_TAB, label: 'Atama Koordinasyonu', hint: 'Süzgeçlerinize uyan bütün atama koordinasyonu kayıtları' }
];
const INITIAL = { tab: 'pending', search: '', projectId: '', requester: '', category: '', status: '', from: '', to: '', page: 0, cursor: '' };

function dateTime(value) {
  return value ? new Date(value).toLocaleString('tr-TR') : '—';
}

/**
 * Talepler sayfası.
 *
 * Gelenler, Gönderdiklerim ve Geçmiş üç kalıcı kaynağı (tarih talebi, atama
 * koordinasyonu, atama olayı) tek, sunucuda sayfalanan listede gösterir. Atama
 * Koordinasyonu kendi ayrıntılı süzgeç ve karar akışıyla ayrı sekmede kalır.
 */
export function ScheduleRequestsView() {
  const [query, setQuery] = useState(INITIAL);
  const [pageCursors, setPageCursors] = useState({});
  const [activeTab, setActiveTab] = useState('pending');
  const [selected, setSelected] = useState(null);
  const [coordinationTotal, setCoordinationTotal] = useState(null);
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
  const { decideScheduleChange, openTask, markNotifications, decideAssignmentCoordination } = useTaskActions();
  const coordinationActive = activeTab === COORDINATION_TAB;
  const { data, loading, error, actual, refresh } = useRequestInboxQuery(query, !coordinationActive);
  const openerRef = useRef(null);
  const tabsRef = useRef(null);
  const [readError, setReadError] = useState(null);
  const change = (key, value) => {
    setPageCursors({});
    setQuery((current) => ({ ...current, [key]: value, page: 0, cursor: '' }));
  };
  const selectTab = (id) => {
    setActiveTab(id);
    // Sekme değişimi açık talep ayrıntısını KAPATIR. Seçim korunduğunda,
    // Atama Koordinasyonu'na geçip geri dönen kullanıcının önüne çekmece
    // kendiliğinden yeniden açılıyordu.
    setSelected(null);
    setReadError(null);
    if (id !== COORDINATION_TAB) change('tab', id);
    else setCoordinationTotal(null);
  };
  // Sayaç anlamları: Gelenler/Gönderdiklerim/Geçmiş, sekmenin süzgeçli kayıt
  // sayısıdır (okunmamış sayısı DEĞİL). Atama Koordinasyonu, sekmenin kendi
  // süzgeçlerine uyan "Tüm kayıtlar" sayısıdır; karar bekleyen sayısı değildir.
  const tabCount = (id) => (id === COORDINATION_TAB
    ? (coordinationActive && coordinationTotal != null ? coordinationTotal : data.counts.coordination ?? 0)
    : data.counts[id] ?? 0);

  const markRead = async (item) => {
    if (!item.unread) return { ok: true };
    const result = await markNotifications?.([item]);
    if (result && !result.ok) setReadError(result.message || 'Bildirim güncellenemedi.');
    else if (result?.refreshError) setReadError(result.refreshError.message || 'Bildirimler yenilenemedi.');
    refresh();
    return result;
  };

  const open = async (item, target) => {
    openerRef.current = target;
    setReadError(null);
    if (item.source === NOTIFICATION_SOURCES.TASK_EVENT) {
      // Atama olayı bir karar penceresi açmaz: görev olağan yetkili yolla
      // açılır. Sorumluluğu kaldırılan kişi görevi çoğu zaman artık göremez;
      // başarısızlık YUTULMAZ, bildirim yine de okundu işaretlenir.
      let failure = null;
      if (item.taskAvailable !== false && item.taskId) {
        try {
          const result = await openTask?.(item.taskId);
          if (result?.ok === false) failure = result.error?.message || 'Görev açılamadı.';
        } catch (openError) { failure = openError?.message || 'Görev açılamadı.'; }
      } else failure = 'Görev silinmiş veya proje kapatılmış.';
      await markRead(item);
      if (failure) setReadError(failure);
      return;
    }
    setSelected(item);
    await markRead(item);
  };

  // Okundu işareti satırı Gelenler listesinden kaldırdığında pencere kapanınca
  // klavye odağı belge gövdesine düşmemesi için etkin sekmeye geri verilir.
  const closeDetails = () => {
    if (!openerRef.current?.isConnected) {
      openerRef.current = tabsRef.current?.querySelector('[role="tab"][aria-selected="true"]') || null;
    }
    setSelected(null);
  };

  const inboxMatch = selected ? data.items.find((item) => sameRequestInboxItem(item, selected)) : null;
  const selectedRecord = selected
    ? (inboxMatch ? selectFresherRecord(inboxMatch, selected) : selected)
    : null;
  const activeHint = TABS.find((tab) => tab.id === activeTab)?.hint;

  return <div className="requests-view">
    <div ref={tabsRef} className="request-tabs" role="tablist" aria-label="Talep türü">
      {TABS.map((tab, index) => <button key={tab.id} type="button" role="tab" id={`requests-${tab.id}-tab`}
        aria-controls="requests-panel" aria-selected={activeTab === tab.id} tabIndex={activeTab === tab.id ? 0 : -1}
        title={tab.hint}
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
    <section className="card requests-panel" id="requests-panel" role="tabpanel" aria-labelledby={`requests-${activeTab}-tab`}
      aria-describedby="requests-panel-hint" aria-busy={coordinationActive ? undefined : loading}>
      <p id="requests-panel-hint" className="sr-only">{activeHint}</p>
      {coordinationActive ? <AssignmentCoordinationView onTotalChange={setCoordinationTotal} /> : <>
      <div className="detail-list-filters request-filters">
        <label><span>Ara</span><input className="input" type="search" value={query.search} placeholder="Görev, proje, kişi veya talep notu…" onChange={(event) => change('search', event.target.value)} /></label>
        <div className="request-project-filter">
          <span>Proje</span>
          <SearchableSelect compact style={{ width: '100%' }} ariaLabel="Proje filtresi" value={query.projectId}
            onChange={(value) => change('projectId', value)} searchPlaceholder="Proje ara" options={projectOptions} />
        </div>
        <label><span>Tür</span><select className="input" value={query.category} onChange={(event) => change('category', event.target.value)}><option value="">Tüm türler</option>{REQUEST_CATEGORY_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label><span>Talep eden / Atayan</span><input className="input" value={query.requester} placeholder="Ad veya sicil" onChange={(event) => change('requester', event.target.value)} /></label>
        <label><span>Durum</span><select className="input" value={query.status} onChange={(event) => change('status', event.target.value)}><option value="">Tüm durumlar</option>{REQUEST_STATUS_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label><span>Tarih · İlk</span><DateInput ariaLabel="İlk kayıt tarihi" value={query.from} onChange={(value) => change('from', value)} /></label>
        <label><span>Tarih · Son</span><DateInput ariaLabel="Son kayıt tarihi" value={query.to} onChange={(value) => change('to', value)} /></label>
        <button type="button" className="btn ghost sm" onClick={() => { setPageCursors({}); setQuery({ ...INITIAL, tab: query.tab }); }}>Filtreleri temizle</button>
      </div>
      {(error || readError) && <p role="alert" className="schedule-modal-error">{error || readError}<button type="button" className="btn ghost sm" onClick={refresh}>Yenile</button></p>}
      {!actual && <p className="empty">Talepler ve bildirimler Gerçek Sistem kipinde kullanılabilir.</p>}
      {loading && <p className="muted request-loading" role="status">Talepler yükleniyor…</p>}
      <div className="detail-list-scroll">
        <table className="table detail-list-table enterprise-table">
          <caption className="sr-only">Talepler ve bildirimler</caption>
          <thead><tr>{['Görev / Proje', 'Tür', 'Talep eden / Atayan', 'Durum', 'Tarih', 'Karar tarihi'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{data.items.map((item) => {
            const row = requestInboxRow(item);
            return <tr key={row.key} data-unread={row.unread || undefined}>
              <td><button type="button" className="detail-task-link" onClick={(event) => open(item, event.currentTarget)}>{row.taskTitle} <Icons.ChevronRight size={12} /></button>{row.projectLabel && <small className="muted">{row.projectLabel}</small>}{row.detail && <small className="muted">{row.detail}</small>}</td>
              <td>{row.category}{row.unread && <span className="schedule-new-label">Yeni</span>}</td>
              <td>{row.actorName || '—'}{row.actorSicil && <small className="muted tabular">{row.actorSicil}</small>}</td>
              <td>{!row.taskAvailable && <small className="muted">Görev silinmiş veya proje kapalı</small>}<span className={`schedule-status ${row.statusClass}`}>{row.statusLabel}</span>{row.actionable && <small>Kararınız bekleniyor</small>}</td>
              <td className="tabular">{dateTime(row.createdAt)}</td>
              <td className="tabular">{dateTime(row.decidedAt)}</td>
            </tr>;
          })}</tbody>
        </table>
        {actual && !loading && !error && !data.items.length && <p className="empty">Bu görünümde kayıt bulunamadı.</p>}
      </div>
      <TaskTablePagination page={data.page} pageCount={Math.max(1, Math.ceil(data.total / data.pageSize))} label="Talep sayfaları"
        setPage={(update) => {
          const nextPage = typeof update === 'function' ? update(data.page) : update;
          const nextCursors = { ...pageCursors };
          if (data.nextCursor) nextCursors[data.page + 1] = data.nextCursor;
          setPageCursors(nextCursors);
          setQuery((current) => ({ ...current, page: nextPage, cursor: nextPage === 0 ? '' : (nextCursors[nextPage] || '') }));
        }} />
      </>}
    </section>
    {!coordinationActive && selectedRecord?.source === NOTIFICATION_SOURCES.SCHEDULE_REQUEST && <ScheduleRequestDetails request={selectedRecord}
      restoreFocusRef={openerRef} onClose={closeDetails} onOpenTask={openTask}
      onDecide={async (...args) => {
        const result = await decideScheduleChange(...args);
        refresh();
        if (result?.value?.request) setSelected({ ...result.value.request, source: NOTIFICATION_SOURCES.SCHEDULE_REQUEST });
        return result;
      }} />}
    {!coordinationActive && selectedRecord?.source === NOTIFICATION_SOURCES.ASSIGNMENT_COORDINATION && <AssignmentCoordinationDialog
      record={selectedRecord} restoreFocusRef={openerRef} onClose={closeDetails} onOpenTask={openTask}
      onDecide={async (...args) => {
        const result = await decideAssignmentCoordination(...args);
        refresh();
        const updatedRecord = result?.value?.record || result?.record;
        if (updatedRecord) setSelected({ ...updatedRecord, source: NOTIFICATION_SOURCES.ASSIGNMENT_COORDINATION });
        return result;
      }} />}
  </div>;
}
