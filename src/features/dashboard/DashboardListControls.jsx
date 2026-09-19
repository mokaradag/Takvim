'use client';
import { Icons } from '../../components/icons.jsx';

export function DashboardResultLimit({ label, value, onChange }) {
  return <label className="dashboard-result-limit">
    <span>Göster</span>
    <select aria-label={`${label} sonuç sayısı`} value={value} onChange={(event) => onChange(Number(event.target.value))}>
      {[5, 10, 20, 50].map((count) => <option key={count} value={count}>İlk {count}</option>)}
    </select>
  </label>;
}

export function DashboardPagination({ label, page, pageCount, start, rows, total, setPage }) {
  return <nav className="dashboard-pagination" aria-label={`${label} sayfaları`}>
    <span className="muted tabular" aria-live="polite">{total ? start + 1 : 0}–{start + rows.length} / {total}</span>
    <div className="row">
      <button type="button" className="icon-btn" aria-label={`${label}: ilk sayfa`} disabled={page === 0} onClick={() => setPage(0)}>İlk</button>
      <button type="button" className="icon-btn" aria-label={`${label}: önceki sayfa`} disabled={page === 0} onClick={() => setPage(page - 1)}><Icons.ChevronLeft size={14} /></button>
      <span className="tabular">{page + 1} / {pageCount}</span>
      <button type="button" className="icon-btn" aria-label={`${label}: sonraki sayfa`} disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}><Icons.ChevronRight size={14} /></button>
      <button type="button" className="icon-btn" aria-label={`${label}: son sayfa`} disabled={page >= pageCount - 1} onClick={() => setPage(pageCount - 1)}>Son</button>
    </div>
  </nav>;
}
