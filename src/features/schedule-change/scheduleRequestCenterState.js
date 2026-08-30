/**
 * Tarih talebi merkezinin açılır panel durumunu tek bir geçiş kuralıyla yönetir.
 */
export function reduceScheduleRequestCenterOpen(open, action = {}) {
  if (action.type === 'close') return false;
  if (action.type === 'sync') return action.hasRequests ? Boolean(open) : false;
  if (action.type === 'toggle') return action.hasRequests ? !open : false;
  return Boolean(open);
}

/**
 * İstek listesi ile panel durumundan kullanıcıya yansıtılacak görünüm durumunu üretir.
 */
export function scheduleRequestCenterViewState(requests, open) {
  const hasRequests = Array.isArray(requests) && requests.length > 0;
  return {
    hasRequests,
    isOpen: hasRequests && Boolean(open),
    disabled: !hasRequests
  };
}
