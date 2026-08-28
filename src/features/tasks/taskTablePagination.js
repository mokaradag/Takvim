export const TASK_TABLE_PAGE_SIZE = 100;

export function paginateTaskRows(rows = [], page = 0, pageSize = TASK_TABLE_PAGE_SIZE) {
  const normalizedPageSize = Number(pageSize);
  if (!Number.isInteger(normalizedPageSize) || normalizedPageSize <= 0) {
    throw new RangeError('pageSize must be a positive integer');
  }
  const pageCount = Math.max(1, Math.ceil(rows.length / normalizedPageSize));
  const numericPage = Number(page);
  const normalizedPage = Number.isFinite(numericPage) ? Math.trunc(numericPage) : 0;
  const safePage = Math.min(Math.max(0, normalizedPage), pageCount - 1);
  const start = safePage * normalizedPageSize;
  return { rows: rows.slice(start, start + normalizedPageSize), page: safePage, pageCount, start };
}

/** Reset anahtarı değiştiği render'da eski sayfanın görünmesini engeller. */
export function taskTablePageForReset(page, pageResetKey, resetKey) {
  return Object.is(pageResetKey, resetKey) ? page : 0;
}

/** Satır sayısı azalınca saklanan sayfayı ekranda görünen geçerli sayfaya eşitler. */
export function synchronizeTaskTablePageState(state, resetKey, effectivePage) {
  const requestedPage = taskTablePageForReset(state.page, state.resetKey, resetKey);
  const page = Math.min(requestedPage, effectivePage);
  if (Object.is(state.resetKey, resetKey) && state.page === page) return state;
  return { resetKey, page };
}
