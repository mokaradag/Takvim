'use client';
import { useMemo, useRef, useState } from 'react';
import { DateInput } from '../../components/DateInput.jsx';
import { Icons } from '../../components/icons.jsx';
import { SearchableSelect } from '../../components/SearchableSelect.jsx';
import {
  COORDINATION_MODES,
  COORDINATION_STATUS_LABELS
} from '../../domain/assignment/assignmentCoordination.js';
import { decideAssignmentCoordinationRequest, markNotificationItems } from '../../data/api/assignmentCoordinationClient.js';
import { useAllProjects, useTaskActions } from '../../state/hooks/index.js';
import { TaskTablePagination } from '../tasks/TaskTablePagination.jsx';
import { AssignmentCoordinationDialog } from './AssignmentCoordinationDialog.jsx';
import { useAssignmentCoordinationQuery } from './useAssignmentCoordinationQuery.js';

const SCOPES = Object.freeze([
  { value: 'all', label: 'Tüm kayıtlar' },
  { value: 'pending', label: 'Kararımı bekleyenler' },
  { value: 'sent', label: 'Gönderdiklerim' },
  { value: 'history', label: 'Sonuçlananlar' }
]);

const INITIAL = Object.freeze({
  tab: 'all', search: '', projectId: '', requester: '', assignee: '',
  organization: '', status: '', from: '', to: '', page: 0
});

/**
 * Talepler · Atama Koordinasyonu.
 *
 * Geçmiş uygulama anlık görüntüsüne yüklenmez: süzgeçler ve sayfalama sunucuda
 * uygulanır. Kapsam seçimi ikinci bir sekme katmanı açmaz; olağan süzgeç
 * satırında durur.
 */
export function AssignmentCoordinationView() {
  const [query, setQuery] = useState(INITIAL);
  const [selected, setSelected] = useState(null);
  const [readError, setReadError] = useState(null);
  const openerRef = useRef(null);
  const projects = useAllProjects();
  const { openTask, reloadData } = useTaskActions();
  const { data, loading, error, actual, refresh } = useAssignmentCoordinationQuery(query);

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

  const change = (key, value) => setQuery((current) => ({ ...current, [key]: value, page: 0 }));

  const open = async (record, target) => {
    openerRef.current = target;
    setSelected(record);
    setReadError(null);
    const result = await markNotificationItems([record]);
    if (!result.ok) setReadError(result.message);
    else { refresh(); await reloadData?.({ preserveFailedTaskUpdates: true }); }
  };

  const decide = async (coordinationId, input) => {
    const result = await decideAssignmentCoordinationRequest(coordinationId, input);
    refresh();
    if (result.ok) {
      await reloadData?.({ preserveFailedTaskUpdates: true });
      if (result.value?.record) setSelected(result.value.record);
    }
    return result;
  };

  const rows = data.items;
  return (
    <div className="coordination-panel">
      <div className="detail-list-filters request-filters">
        <label><span>Ara</span>
          <input className="input" type="search" value={query.search} placeholder="Görev, proje, kişi veya not…"
            onChange={(event) => change('search', event.target.value)} />
        </label>
        <label><span>Kapsam</span>
          <select className="input" value={query.tab} onChange={(event) => change('tab', event.target.value)}>
            {SCOPES.map((scope) => <option key={scope.value} value={scope.value}>{scope.label}</option>)}
          </select>
        </label>
        <div className="coordination-project-filter">
          <span>Proje</span>
          <SearchableSelect compact style={{ width: '100%' }} ariaLabel="Proje filtresi" value={query.projectId}
            onChange={(value) => change('projectId', value)} searchPlaceholder="Proje ara" options={projectOptions} />
        </div>
        <label><span>Talep eden</span>
          <input className="input" value={query.requester} placeholder="Ad veya sicil"
            onChange={(event) => change('requester', event.target.value)} />
        </label>
        <label><span>Görevlendirilen</span>
          <input className="input" value={query.assignee} placeholder="Ad veya sicil"
            onChange={(event) => change('assignee', event.target.value)} />
        </label>
        <label><span>Birim</span>
          <input className="input" value={query.organization} placeholder="Direktörlük / Müdürlük / Birim"
            onChange={(event) => change('organization', event.target.value)} />
        </label>
        <label><span>Durum</span>
          <select className="input" value={query.status} onChange={(event) => change('status', event.target.value)}>
            <option value="">Tüm durumlar</option>
            {Object.entries(COORDINATION_STATUS_LABELS).map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </label>
        <label><span>Tarih · İlk</span>
          <DateInput ariaLabel="İlk kayıt tarihi" value={query.from} onChange={(value) => change('from', value)} />
        </label>
        <label><span>Tarih · Son</span>
          <DateInput ariaLabel="Son kayıt tarihi" value={query.to} onChange={(value) => change('to', value)} />
        </label>
        <button type="button" className="btn ghost sm" onClick={() => setQuery(INITIAL)}>Filtreleri temizle</button>
      </div>

      {(error || readError) && (
        <p role="alert" className="schedule-modal-error">
          {error || readError}
          <button type="button" className="btn ghost sm" onClick={refresh}>Yenile</button>
        </p>
      )}
      {!actual && <p className="empty">Atama koordinasyonu Gerçek Sistem kipinde kullanılabilir.</p>}
      {loading && <p className="muted" role="status">Kayıtlar yükleniyor…</p>}

      <div className="detail-list-scroll">
        <table className="table detail-list-table enterprise-table coordination-table">
          <caption className="sr-only">Atama koordinasyonu kayıtları</caption>
          <thead>
            <tr>
              {['Görev / Proje', 'Görevlendirilen', 'Talep eden', 'Durum', 'Oluşturma', 'Son yanıt']
                .map((label) => <th scope="col" key={label}>{label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((record) => (
              <tr key={record.id}>
                <td>
                  <button type="button" className="detail-task-link" onClick={(event) => open(record, event.currentTarget)}>
                    {record.taskTitle || 'Silinen görev'} <Icons.ChevronRight size={12} />
                  </button>
                  <small className="muted">{[record.projectCode, record.projectName].filter(Boolean).join(' · ')}</small>
                </td>
                <td>
                  {record.assigneeName}
                  <small className="muted tabular">{record.assigneeSicil}</small>
                  {record.assigneeOrganization && <small className="muted">{record.assigneeOrganization}</small>}
                </td>
                <td>
                  {record.requesterName}
                  <small className="muted tabular">{record.requesterSicil}</small>
                </td>
                <td>
                  <span className={`schedule-status coordination-${record.status.toLowerCase()}`}>
                    {COORDINATION_STATUS_LABELS[record.status] || record.status}
                  </span>
                  {record.mode === COORDINATION_MODES.NOTICE && <small className="muted">Bildirim</small>}
                  {record.actionable && <small>Kararınız bekleniyor</small>}
                  {record.taskAvailable === false && <small className="muted">Görev silinmiş veya proje kapalı</small>}
                </td>
                <td className="tabular">{record.createdAt ? new Date(record.createdAt).toLocaleString('tr-TR') : '—'}</td>
                <td className="tabular">{record.decidedAt ? new Date(record.decidedAt).toLocaleString('tr-TR') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {actual && !loading && !error && !rows.length && <p className="empty">Bu görünümde koordinasyon kaydı bulunamadı.</p>}
      </div>

      <TaskTablePagination
        page={data.page}
        pageCount={Math.max(1, Math.ceil(data.total / data.pageSize))}
        label="Talep sayfaları"
        setPage={(update) => setQuery((current) => ({
          ...current,
          page: typeof update === 'function' ? update(data.page) : update
        }))}
      />

      {selected && (
        <AssignmentCoordinationDialog
          record={rows.find((item) => item.id === selected.id) || selected}
          restoreFocusRef={openerRef}
          onClose={() => setSelected(null)}
          onOpenTask={openTask}
          onDecide={decide}
        />
      )}
    </div>
  );
}
