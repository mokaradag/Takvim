export function scheduleRequestItems(previewRequests = [], queryState = {}) {
  if (!queryState.actual || queryState.loading || queryState.error) return previewRequests;
  return queryState.data?.items || [];
}
