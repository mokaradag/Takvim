'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icons } from '../../components/icons';
import {
  paginateTaskRows,
  synchronizeTaskTablePageState,
  taskTablePageForReset
} from './taskTablePagination.js';

export { TASK_TABLE_PAGE_SIZE, paginateTaskRows } from './taskTablePagination.js';

export function useTaskTablePagination(rows, resetKey) {
  const [pageState, setPageState] = useState(() => ({ page: 0, resetKey }));
  const requestedPage = taskTablePageForReset(pageState.page, pageState.resetKey, resetKey);
  const result = useMemo(() => paginateTaskRows(rows, requestedPage), [rows, requestedPage]);
  useEffect(() => {
    setPageState((current) => synchronizeTaskTablePageState(current, resetKey, result.page));
  }, [resetKey, result.page]);
  const setPage = useCallback((update) => {
    setPageState((current) => {
      const requested = taskTablePageForReset(current.page, current.resetKey, resetKey);
      const visiblePage = Math.min(requested, result.page);
      const page = typeof update === 'function' ? update(visiblePage) : update;
      return { resetKey, page };
    });
  }, [resetKey, result.page]);
  return { ...result, setPage };
}

export function TaskTablePagination({ page, pageCount, setPage, showDateLegend = false, label = 'Görev sayfaları' }) {
  const pageLabel = label === 'Talep sayfaları'
    ? 'talep sayfası'
    : label === 'Hareket sayfaları'
      ? 'hareket sayfası'
      : 'görev sayfası';
  return (
    <div className="task-table-footer">
      {showDateLegend && <span className="task-date-legend"><Icons.Check size={11} /> Gerçekleşen tarih <span>· İşaretsiz tarih planlanandır</span></span>}
      <nav className="row task-table-pagination" aria-label={label}>
        <button type="button" className="btn ghost sm" onClick={() => setPage(0)} disabled={page === 0} aria-label="İlk sayfa">İlk</button>
        <button type="button" className="btn ghost sm" onClick={() => setPage((value) => Math.max(0, value - 1))}
          disabled={page === 0} aria-label={`Önceki ${pageLabel}`}><Icons.ChevronLeft size={13} /> Önceki</button>
        <span className="muted tabular" aria-live="polite">Sayfa {page + 1} / {pageCount}</span>
        <button type="button" className="btn ghost sm" onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
          disabled={page >= pageCount - 1} aria-label={`Sonraki ${pageLabel}`}>Sonraki <Icons.ChevronRight size={13} /></button>
        <button type="button" className="btn ghost sm" onClick={() => setPage(pageCount - 1)} disabled={page >= pageCount - 1} aria-label="Son sayfa">Son</button>
      </nav>
    </div>
  );
}
