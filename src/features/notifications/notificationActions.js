import { decideAssignmentCoordinationRequest } from '../../data/api/assignmentCoordinationClient.js';

function failureMessage(error, fallback) {
  return error?.message || error?.error?.message || fallback;
}

async function refreshFailure(refresh) {
  try {
    const result = await refresh();
    return result?.ok === false ? (result.message || result.error?.message || 'Bildirimler yenilenemedi.') : null;
  } catch (error) {
    return failureMessage(error, 'Bildirimler yenilenemedi.');
  }
}

/** Birincil kararın sonucu yenileme sonucundan bağımsızdır. */
export async function decideCoordinationAndRefresh(id, input, refresh) {
  let result;
  let decisionFailure = null;
  try { result = await decideAssignmentCoordinationRequest(id, input); }
  catch (error) { decisionFailure = error; }

  const refreshError = await refreshFailure(refresh);
  if (decisionFailure) {
    if (refreshError) decisionFailure.refreshError = refreshError;
    throw decisionFailure;
  }
  return refreshError ? { ...result, refreshError } : result;
}

export function combineActionErrors(entries = []) {
  const failures = entries.filter((entry) => entry?.[1]);
  if (!failures.length) return null;
  if (failures.length === 1) return failures[0][1];
  return failures.map(([label, message]) => `${label}: ${message}`).join(' · ');
}

export function notificationActionError(outcome = {}) {
  return combineActionErrors([
    ['Görev açma', outcome.openError],
    ['Okuma', outcome.readError],
    ['Yenileme', outcome.refreshError]
  ]);
}

/** Görev açma, okuma ve yenileme ayrı sonuçlardır; eski alıcı yeni isteğe başlayamaz. */
export async function openTaskNotification(record, openTask, read, isCurrent = () => true) {
  let openError = null;
  if (Number(record.taskCount || 1) === 1 && record.taskId) {
    if (!isCurrent()) return { stale: true, openError, readError: null, refreshError: null };
    try {
      const response = await openTask(record.taskId, { isCurrent });
      if (response?.stale) return { stale: true, openError, readError: null, refreshError: null };
      if (response?.ok === false) openError = response.error?.message || response.message || 'Görev açılamadı.';
    } catch (failure) { openError = failureMessage(failure, 'Görev açılamadı.'); }
  }

  if (!isCurrent()) return { stale: true, openError, readError: null, refreshError: null };
  let marked;
  let readError = null;
  try {
    marked = await read(record);
    if (marked?.stale) return { stale: true, openError, readError: null, refreshError: null };
    if (marked?.ok === false) readError = marked.message || marked.error?.message || 'Bildirim güncellenemedi.';
  } catch (failure) {
    readError = failureMessage(failure, 'Bildirim güncellenemedi.');
  }
  if (!isCurrent()) return { stale: true, openError, readError, refreshError: null };
  return { stale: false, openError, readError, refreshError: marked?.refreshError || null };
}
