export const EMPTY_TASK_ACTIVITY_DATA = Object.freeze({
  items: [],
  total: 0,
  page: 0,
  pageSize: 25,
  summary: { tasks: 0, people: 0, completed: 0 },
  filters: { people: [], projects: [] }
});

export function taskActivityQueryViewState(state, key, actual) {
  const data = state?.data || EMPTY_TASK_ACTIVITY_DATA;
  if (!actual) {
    return { data: EMPTY_TASK_ACTIVITY_DATA, options: EMPTY_TASK_ACTIVITY_DATA.filters, error: null };
  }
  const matching = state?.key === key;
  return {
    data: matching ? data : {
      ...EMPTY_TASK_ACTIVITY_DATA,
      scope: data.scope,
      canViewTeam: data.canViewTeam
    },
    options: data.filters || EMPTY_TASK_ACTIVITY_DATA.filters,
    error: matching ? (state?.error || null) : null
  };
}
