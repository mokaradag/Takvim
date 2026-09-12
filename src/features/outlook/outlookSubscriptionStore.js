import { extractActualId } from '../../domain/identity/actualId.js';
import {
  addTaskToOutlookRequest,
  addTasksToOutlookRequest,
  loadOutlookCalendarStateRequest,
  removeTaskFromOutlookRequest,
  resendOutlookInvitationRequest
} from './outlookClient.js';

function initialState() {
  return {
    status: 'idle', enabled: false, mailConfigured: false, schemaReady: false,
    bulkLimit: 25, subscribed: new Set(), tasks: new Map(), busy: new Set(), error: null
  };
}

let snapshot = initialState();
const listeners = new Set();
let loadPromise = null;
let generation = 0;
let readVersion = 0;
let dataMode = null;
let refreshTimer = null;

function emit(next) {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getOutlookSnapshot() { return snapshot; }

function refresh() {
  if (dataMode === 'actual' && !snapshot.busy.size && document.visibilityState !== 'hidden') ensureOutlookState();
}

export function subscribeToOutlookStore(listener) {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== 'undefined') {
    refreshTimer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && typeof window !== 'undefined') {
      clearInterval(refreshTimer);
      refreshTimer = null;
      window.removeEventListener('focus', refresh);
    }
  };
}

export function outlookTaskKey(taskId) {
  const raw = String(taskId ?? '').trim();
  return raw ? extractActualId(raw) || raw.toLowerCase() : '';
}

export function isTaskInOutlook(state, taskId) {
  return state.subscribed.has(outlookTaskKey(taskId));
}

export function outlookTaskState(state, taskId) {
  return state.tasks.get(outlookTaskKey(taskId)) || { subscribed: false, pending: false, delivered: false, failureCode: null };
}

export function isTaskBusy(state, taskId) { return state.busy.has(outlookTaskKey(taskId)); }

function withBusy(keys, busy) {
  const next = new Set(snapshot.busy);
  for (const key of keys) {
    if (busy) next.add(key);
    else next.delete(key);
  }
  emit({ ...snapshot, busy: next });
}

function applyResult(key, result) {
  readVersion += 1;
  const previous = outlookTaskState(snapshot, key);
  const deliveredStatus = ['ADDED', 'ALREADY_ADDED', 'RESENT'].includes(result.status);
  const queuedStatus = ['QUEUED', 'IN_PROGRESS'].includes(result.status);
  const removed = ['REMOVED', 'NOT_SUBSCRIBED'].includes(result.status);
  if (typeof result.subscribed !== 'boolean' && !deliveredStatus && !queuedStatus && !removed) return;
  const value = {
    subscribed: result.subscribed ?? !removed,
    completionSuspended: result.completionSuspended ?? Boolean(queuedStatus && previous.completionSuspended),
    pending: result.pending ?? queuedStatus,
    delivered: result.delivered ?? (deliveredStatus || (queuedStatus && previous.delivered)),
    failureCode: result.failureCode || (!result.ok ? result.code : null) || null
  };
  const tasks = new Map(snapshot.tasks);
  tasks.set(key, value);
  const subscribed = new Set(snapshot.subscribed);
  if (value.subscribed) subscribed.add(key);
  else subscribed.delete(key);
  emit({ ...snapshot, tasks, subscribed });
}

export function resetOutlookStore() {
  generation += 1;
  dataMode = null;
  loadPromise = null;
  emit(initialState());
}

export function setOutlookDataMode(next) {
  if (dataMode !== null && dataMode !== next) resetOutlookStore();
  dataMode = next;
}

// Söz yalnızca süren istekleri birleştirir; sonraki okuma yeniden yapılabilir.
export function ensureOutlookState({ load = loadOutlookCalendarStateRequest } = {}) {
  if (loadPromise) return loadPromise;
  const current = generation;
  const version = readVersion;
  emit({ ...snapshot, status: snapshot.status === 'ready' ? 'ready' : 'loading' });
  const attempt = Promise.resolve().then(load).then((response) => {
    if (current !== generation || version !== readVersion) return snapshot;
    if (!response.ok) {
      emit({ ...snapshot, status: 'error', error: response.message || 'Outlook takvim durumu okunamadı.' });
      return snapshot;
    }
    const subscribed = new Set();
    const tasks = new Map();
    for (const item of response.tasks || []) {
      const key = outlookTaskKey(item.taskId);
      subscribed.add(key);
      tasks.set(key, { subscribed: true, completionSuspended: Boolean(item.completionSuspended), pending: Boolean(item.pending), delivered: Boolean(item.delivered), failureCode: item.failureCode || null });
    }
    emit({
      ...snapshot, status: 'ready', enabled: response.enabled !== false,
      mailConfigured: response.mailConfigured !== false, schemaReady: response.schemaReady !== false,
      bulkLimit: Number(response.bulkLimit) || snapshot.bulkLimit, subscribed, tasks, error: null
    });
    return snapshot;
  }).catch(() => {
    if (current === generation && version === readVersion) emit({ ...snapshot, status: 'error', error: 'Outlook takvim durumu okunamadı.' });
    return snapshot;
  }).finally(() => { if (loadPromise === attempt) loadPromise = null; });
  loadPromise = attempt;
  return attempt;
}

async function runTaskAction(taskId, action) {
  const key = outlookTaskKey(taskId);
  if (!key || snapshot.busy.has(key)) return { ok: false, code: 'BUSY' };
  const current = generation;
  readVersion += 1;
  loadPromise = null;
  withBusy([key], true);
  try {
    const response = await action(taskId);
    if (current === generation) applyResult(key, response);
    return response;
  } finally {
    if (current === generation) withBusy([key], false);
  }
}

export function addTaskToOutlook(taskId, { request = addTaskToOutlookRequest } = {}) {
  return runTaskAction(taskId, request);
}
export function resendOutlookInvitation(taskId, { request = resendOutlookInvitationRequest } = {}) {
  return runTaskAction(taskId, request);
}
export function removeTaskFromOutlook(taskId, { request = removeTaskFromOutlookRequest } = {}) {
  return runTaskAction(taskId, request);
}

export async function addTasksToOutlook(taskIds, { request = addTasksToOutlookRequest } = {}) {
  const keys = [...new Set((taskIds || []).map(outlookTaskKey).filter(Boolean))];
  if (!keys.length) return { ok: false, code: 'EMPTY_SELECTION' };
  if (keys.some((key) => snapshot.busy.has(key))) return { ok: false, code: 'BUSY' };
  const current = generation;
  readVersion += 1;
  loadPromise = null;
  withBusy(keys, true);
  try {
    const response = await request(taskIds);
    if (current === generation && response.ok) {
      for (const item of response.results || []) applyResult(outlookTaskKey(item.taskId), { ...item, ok: !['FAILED', 'FORBIDDEN', 'NOT_FOUND'].includes(item.status) });
    }
    return response;
  } finally {
    if (current === generation) withBusy(keys, false);
  }
}
