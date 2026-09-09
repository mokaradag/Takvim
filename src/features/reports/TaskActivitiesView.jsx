'use client';
import { useState } from 'react';
import { DateInput } from '../../components/DateInput.jsx';
import { SearchableSelect } from '../../components/SearchableSelect.jsx';
import { useTaskActions } from '../../state/hooks/index.js';
import { applyOrgSelection, createEmptyOrgFilter, orgLevelOptions } from '../../domain/organization/organizationHierarchy.js';
import { TaskOrganizationFilterControls } from '../tasks/TaskOrganizationFilterControls.jsx';
import { TaskTablePagination } from '../tasks/TaskTablePagination.jsx';
import { useTaskActivities } from './useTaskActivities.js';

const INITIAL = { period: 'today', scope: '', from: '', to: '', person: '', projectId: '', kind: '', page: 0, ...createEmptyOrgFilter() };
const timestamp = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function TaskActivitiesView({ active = true }) {
  const [query, setQuery] = useState(INITIAL);
  const [openError, setOpenError] = useState(null);
  const { openTask } = useTaskActions();
  const { data, options, loading, error, actual, refresh } = useTaskActivities(query, active && (query.period !== 'custom' || Boolean(query.from && query.to)));
  const change = (key, value) => setQuery((current) => ({ ...current, [key]: value, page: 0 }));
  const organization = { selection: query,
    directorateOptions: orgLevelOptions(options.people, 'directorate', query),
    departmentOptions: orgLevelOptions(options.people, 'department', query),
    unitOptions: orgLevelOptions(options.people, 'unit', query),
    selectLevel: (level, value) => setQuery((current) => ({ ...current, ...applyOrgSelection(current, level, value), page: 0 })) };
  const team = (query.scope || data.scope) === 'team';
  return <div className="task-activities-view">
    <div className="requests-intro"><h2>Görev Hareketleri</h2><p className="muted">Görevlerde kimin, ne zaman, neyi değiştirdiğini inceleyin. Tarihler Türkiye saatine göredir.</p></div>
    <div className="activity-filters">
      <label><span>Dönem</span><select className="input" value={query.period} onChange={(event) => {
        const period = event.target.value;
        setQuery((current) => ({ ...current, period, page: 0, from: current.from || data.range?.from || '', to: current.to || data.range?.to || '' }));
      }}>
        <option value="today">Bugün</option><option value="yesterday">Dün</option><option value="week">Son 7 gün</option><option value="custom">Özel tarih/aralık</option>
      </select></label>
      {query.period === 'custom' && <><label><span>İlk gün</span><DateInput value={query.from} onChange={(value) => change('from', value)} ariaLabel="Hareket başlangıç tarihi" /></label>
        <label><span>Son gün</span><DateInput value={query.to} onChange={(value) => change('to', value)} ariaLabel="Hareket bitiş tarihi" /></label></>}
      <label><span>Kapsam</span><select className="input" value={query.scope || data.scope || ''} onChange={(event) => change('scope', event.target.value)}>
        {!data.scope && <option value="">Yetkili kapsam</option>}{data.canViewTeam && <option value="team">Ekibim</option>}
        <option value="visible">Görünür görevler</option><option value="mine">Benim hareketlerim</option>
      </select></label>
      <SearchableSelect compact ariaLabel="Güncelleyen kişi" value={query.person} onChange={(value) => change('person', value)} searchPlaceholder="Kişi ara"
        options={[{ value: '', label: 'Tüm kişiler' }, ...options.people.map((person) => ({ value: person.id, label: person.name, description: person.id }))]} />
      <SearchableSelect compact ariaLabel="Hareket projesi" value={query.projectId} onChange={(value) => change('projectId', value)} searchPlaceholder="Proje ara"
        options={[{ value: '', label: 'Tüm projeler' }, ...options.projects.map((project) => ({ value: project.id, label: project.name, description: project.code }))]} />
      <label><span>Hareket türü</span><select className="input" value={query.kind} onChange={(event) => change('kind', event.target.value)}>
        <option value="">Tüm hareketler</option><option value="created">Oluşturulan</option><option value="updated">Güncellenen</option><option value="completed">Tamamlanan</option><option value="deleted">Silinen</option>
      </select></label>
      <TaskOrganizationFilterControls organization={organization} />
      <button type="button" className="btn ghost sm" onClick={refresh} disabled={loading}>Yenile</button>
    </div>
    {!actual && <p className="muted">Görev hareketleri Gerçek Sistem verilerinden gösterilir.</p>}
    {(error || openError) && <p className="schedule-modal-error" role="alert">{error || openError}</p>}
    <div className="activity-summary" aria-live="polite" aria-busy={loading}>
      {[[data.total, 'değişiklik'], [data.summary.tasks, 'farklı görev'], [data.summary.people, team ? 'ekip üyesi' : 'kişi'], [data.summary.completed, 'tamamlanan görev']].map(([value, label]) =>
        <span key={label}><strong>{loading ? '—' : value}</strong> {label}</span>)}
    </div>
    <div className="detail-list-scroll" aria-busy={loading}>
      <table className="table activity-table"><caption className="sr-only">Görev hareketleri · Türkiye saati</caption>
        <thead><tr>{['Tarih / Saat', 'Güncelleyen', 'Proje', 'Görev', 'Yapılan değişiklik'].map((label) => <th scope="col" key={label} style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg-elev)' }}>{label}</th>)}</tr></thead>
        <tbody>{data.items.map((item) => <tr key={item.id}>
          <td><time dateTime={item.occurredAt}>{timestamp.format(new Date(item.occurredAt))}</time></td>
          <td>{item.actorName}</td><td title={item.projectName}>{item.projectCode || item.projectName}</td>
          <td>{item.taskAvailable ? <button type="button" className="detail-task-link" onClick={async () => {
            setOpenError(null);
            try { const result = await openTask(item.taskId); if (result?.ok === false) setOpenError('Görev açılamadı. Verileri yenileyip tekrar deneyin.'); }
            catch { setOpenError('Görev açılamadı. Verileri yenileyip tekrar deneyin.'); }
          }}>{item.taskTitle}</button> : <span>{item.taskTitle} <span className="muted">(silinmiş)</span></span>}</td>
          <td>{item.changes.length <= 2 ? item.changes.join(' · ') : <details><summary>{item.changes.slice(0, 2).join(' · ')} <span className="muted">+{item.changes.length - 2} değişiklik</span></summary>
            <ul>{item.changes.slice(2).map((line, index) => <li key={index}>{line}</li>)}</ul></details>}{item.detailsLimited && <p className="muted">Bu işlemin ayrıntılarının bir bölümü gösteriliyor.</p>}</td>
        </tr>)}</tbody>
      </table>
      {loading && <p className="requests-empty" role="status">Görev hareketleri yükleniyor…</p>}
      {!loading && !error && !data.items.length && <p className="requests-empty">{team ? 'Seçilen dönemde ekibiniz tarafından yapılan bir görev değişikliği bulunmuyor.' : 'Seçilen dönemde görünür görevlerinizde bir değişiklik bulunmuyor.'}</p>}
    </div>
    <TaskTablePagination page={data.page} pageCount={Math.max(1, Math.ceil(data.total / data.pageSize))} label="Hareket sayfaları"
      setPage={(update) => setQuery((current) => ({ ...current, page: typeof update === 'function' ? update(data.page) : update }))} />
  </div>;
}