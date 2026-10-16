'use client';
import { useRef, useState } from 'react';
import { markNotificationItems } from '../../data/api/assignmentCoordinationClient.js';
import { useSessionContext } from '../../state/hooks/index.js';
import {
  combineActionErrors,
  decideCoordinationAndRefresh,
  notificationActionError,
  openTaskNotification
} from './notificationActions.js';

function messageOf(error, fallback) {
  return error?.message || error?.error?.message || fallback;
}

function failedRefresh(result) {
  return result?.ok === false ? (result.message || result.error?.message || 'Bildirimler yenilenemedi.') : null;
}

/** Talepler'in iki koordinasyon yüzeyi aynı alıcı-sahipli işlem kurallarını uygular. */
export function useNotificationActions(onChanged, openTask) {
  const session = useSessionContext();
  const owner = `${session?.dataMode}:${session?.currentUser?.employeeNo ?? session?.currentUser?.id ?? ''}`;
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const [state, setState] = useState({ owner });
  const fallbackRef = useRef(null);
  if (state.owner !== owner) setState({ owner });
  const visible = state.owner === owner ? state : {};
  const isCurrent = () => currentOwner.current === owner;
  const update = (changes) => {
    if (isCurrent()) setState((current) => ({ ...(current.owner === owner ? current : {}), owner, ...changes }));
  };
  const openOwnedTask = (taskId) => {
    if (!isCurrent()) return Promise.resolve({ ok: false, stale: true });
    return openTask(taskId, { isCurrent });
  };

  const refresh = async () => {
    if (!isCurrent()) return { ok: false, stale: true };
    update({ error: null });
    try {
      if (!isCurrent()) return { ok: false, stale: true };
      const result = await onChanged();
      const message = failedRefresh(result);
      if (message) update({ error: message });
      return message ? { ok: false, message } : { ok: true };
    } catch (error) {
      const message = messageOf(error, 'Bildirimler yenilenemedi.');
      update({ error: message });
      return { ok: false, message };
    }
  };

  const read = async (record) => {
    if (!isCurrent()) return { ok: false, stale: true };
    update({ busy: true, error: null });
    let result;
    try {
      if (!isCurrent()) return { ok: false, stale: true };
      try {
        result = await markNotificationItems([record]);
      } catch (error) {
        result = { ok: false, message: messageOf(error, 'Bildirim güncellenemedi.') };
      }
      if (!isCurrent()) return { ...result, stale: true };

      let refreshError = null;
      try {
        if (isCurrent()) refreshError = failedRefresh(await onChanged());
      } catch (error) {
        refreshError = messageOf(error, 'Bildirimler yenilenemedi.');
      }
      if (!isCurrent()) return { ...result, stale: true, ...(refreshError ? { refreshError } : {}) };

      const error = combineActionErrors([
        ['Okuma', result?.ok === false ? (result.message || result.error?.message || 'Bildirim güncellenemedi.') : null],
        ['Yenileme', refreshError]
      ]);
      update({ busy: false, error });
      return { ...result, ...(refreshError ? { refreshError } : {}) };
    } finally {
      if (isCurrent()) update({ busy: false });
    }
  };

  const open = (record) => {
    if (!isCurrent()) return;
    update({ selected: record, error: null });
    if (record.unread) void read(record);
  };

  const decide = async (id, input) => {
    if (!isCurrent()) return { ok: false, stale: true };
    let result;
    let decisionError = null;
    try {
      result = await decideCoordinationAndRefresh(id, input, async () => {
        if (!isCurrent()) return { ok: true, stale: true };
        return onChanged();
      });
    } catch (error) {
      decisionError = messageOf(error, 'Karar kaydedilemedi.');
      result = { ok: false, message: decisionError, ...(error.refreshError ? { refreshError: error.refreshError } : {}) };
    }
    if (!isCurrent()) return { ...result, stale: true };

    const primaryError = decisionError || (!result.ok ? (result.message || result.error?.message || 'Karar kaydedilemedi.')
      : result.value?.outcome === 'STALE' ? result.value.message : null);
    update({
      selected: null,
      error: combineActionErrors([['Karar', primaryError], ['Yenileme', result.refreshError]])
    });
    return result;
  };

  const openEvent = async (record) => {
    if (!isCurrent()) return;
    update({ busy: true, error: null });
    try {
      const outcome = await openTaskNotification(record, openTask, read, isCurrent);
      if (!isCurrent() || outcome.stale) return;
      update({ error: notificationActionError(outcome) });
    } finally {
      if (isCurrent()) update({ busy: false });
    }
  };

  return {
    selected: visible.selected,
    busy: visible.busy,
    actionError: visible.error,
    fallbackRef,
    open,
    read,
    decide,
    openEvent,
    openOwnedTask,
    refresh,
    close: () => update({ selected: null })
  };
}
