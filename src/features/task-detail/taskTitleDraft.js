import { useCallback, useEffect, useRef, useState } from 'react';

export const TASK_TITLE_DRAFT_DELAY_MS = 320;

export function canCloseWithTaskTitle(value) {
  return Boolean(String(value ?? '').trim());
}

export function createTaskTitleDraftController({
  initialTitle = '',
  delayMs = TASK_TITLE_DRAFT_DELAY_MS,
  persist,
  cancel,
  schedule = setTimeout,
  clearSchedule = clearTimeout
} = {}) {
  let canonicalTitle = String(initialTitle ?? '');
  let draft = canonicalTitle;
  let dirty = false;
  let timer = null;
  let requestVersion = 0;
  let confirmedRequestVersion = 0;
  const pendingRequests = new Map();
  let lastRequest = Promise.resolve({ ok: true, value: null });
  let awaitingCanonicalTitle = null;
  let lastIncomingTitle = canonicalTitle;

  const clearTimer = () => {
    if (timer === null) return;
    clearSchedule(timer);
    timer = null;
  };

  const cancelQueuedTitle = () => {
    cancel?.();
  };

  const matchingRequest = (value) => (
    [...pendingRequests.values()].find((request) => request.title === value) || null
  );

  const hasDifferentPendingRequest = (value) => (
    [...pendingRequests.values()].some((request) => request.title !== value)
  );

  const updateDirtyState = () => {
    dirty = draft !== canonicalTitle || pendingRequests.size > 0;
  };

  const commit = () => {
    clearTimer();
    const candidate = draft;
    if (!candidate.trim()) {
      cancelQueuedTitle();
      return Promise.resolve({ ok: true, value: null, skipped: true });
    }
    const matching = matchingRequest(candidate);
    if (matching) return matching.promise;
    if (candidate === canonicalTitle && !hasDifferentPendingRequest(candidate)) {
      dirty = false;
      return Promise.resolve({ ok: true, value: null, skipped: true });
    }

    const version = ++requestVersion;
    // `persist` may throw before returning a promise, or return a promise that
    // rejects. Normalize both paths so the request is always removed from the
    // de-duplication map and the same title can be retried.
    let persistenceResult;
    try {
      persistenceResult = persist?.(candidate);
    } catch (error) {
      persistenceResult = { ok: false, error };
    }
    lastRequest = Promise.resolve(persistenceResult)
      .catch((error) => ({ ok: false, error }))
      .then((result) => {
        pendingRequests.delete(version);
        const persisted = result?.ok !== false && result?.value !== null;
        if (persisted && version >= confirmedRequestVersion) {
          confirmedRequestVersion = version;
          canonicalTitle = candidate;
          awaitingCanonicalTitle = lastIncomingTitle === candidate ? null : candidate;
        }
        updateDirtyState();
        if (result?.ok === false && !matchingRequest(draft) && (!draft.trim() || draft === canonicalTitle)) {
          cancelQueuedTitle();
        }

        const shouldCommitLatest = result?.ok !== false
          && Boolean(draft.trim())
          && !matchingRequest(draft)
          && (draft !== canonicalTitle || hasDifferentPendingRequest(draft));
        if (!shouldCommitLatest) return result ?? { ok: true, value: null };
        return Promise.resolve(commit()).then(() => result ?? { ok: true, value: null });
      });
    pendingRequests.set(version, { title: candidate, promise: lastRequest });
    return lastRequest;
  };

  const update = (value) => {
    clearTimer();
    draft = String(value ?? '');
    awaitingCanonicalTitle = null;
    updateDirtyState();

    if (!draft.trim()) {
      cancelQueuedTitle();
      return draft;
    }
    if (!dirty) return draft;
    if (matchingRequest(draft)) return draft;
    if (draft === canonicalTitle) cancelQueuedTitle();

    timer = schedule(() => {
      timer = null;
      commit();
    }, delayMs);
    return draft;
  };

  const reconcile = (value) => {
    const incoming = String(value ?? '');
    lastIncomingTitle = incoming;
    if (dirty) return draft;
    if (awaitingCanonicalTitle !== null) {
      if (incoming === awaitingCanonicalTitle) {
        canonicalTitle = incoming;
        draft = incoming;
        awaitingCanonicalTitle = null;
      }
      return draft;
    }
    canonicalTitle = incoming;
    draft = incoming;
    return draft;
  };

  const dispose = () => {
    const pendingCommit = timer !== null ? commit() : null;
    clearTimer();
    return pendingCommit;
  };

  return {
    update,
    commit,
    reconcile,
    getDraft: () => draft,
    isDirty: () => dirty,
    dispose
  };
}

export function useTaskTitleDraft({ canonicalTitle, persist, cancel, delayMs = TASK_TITLE_DRAFT_DELAY_MS }) {
  const persistRef = useRef(persist);
  const cancelRef = useRef(cancel);

  useEffect(() => {
    persistRef.current = persist;
    cancelRef.current = cancel;
  }, [persist, cancel]);

  const controllerRef = useRef(null);
  if (!controllerRef.current) {
    controllerRef.current = createTaskTitleDraftController({
      initialTitle: canonicalTitle,
      delayMs,
      persist: (value) => persistRef.current?.(value),
      cancel: () => cancelRef.current?.()
    });
  }

  const [draft, setDraft] = useState(() => String(canonicalTitle ?? ''));

  useEffect(() => {
    const next = controllerRef.current.reconcile(canonicalTitle);
    setDraft((current) => current === next ? current : next);
  }, [canonicalTitle]);

  useEffect(() => () => controllerRef.current?.dispose(), []);

  const change = useCallback((value) => {
    const next = controllerRef.current.update(value);
    setDraft(next);
  }, []);

  const flush = useCallback(() => controllerRef.current.commit(), []);

  return { draft, change, flush, valid: Boolean(draft.trim()) };
}