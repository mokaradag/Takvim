function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function taskDraftValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => taskDraftValuesEqual(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => (
      Object.prototype.hasOwnProperty.call(right, key)
      && taskDraftValuesEqual(left[key], right[key])
    ));
  }
  return false;
}

export function reconcileTaskDraft(canonicalTask, localDraft, dirtyFields = new Set()) {
  const canonical = canonicalTask || {};
  const local = localDraft || canonical;
  const nextDirtyFields = new Set(dirtyFields);
  const nextTask = { ...canonical };

  for (const field of nextDirtyFields) {
    if (taskDraftValuesEqual(canonical[field], local[field])) {
      nextDirtyFields.delete(field);
    } else if (Object.prototype.hasOwnProperty.call(local, field)) {
      nextTask[field] = local[field];
    }
  }

  return { task: nextTask, dirtyFields: nextDirtyFields };
}

/** Temel Kip etiket taslağı varken yalnızca `keyword` alanı korunur. */
export function keywordDirtyFields(keywordDraft) {
  return keywordDraft === null ? new Set() : new Set(['keyword']);
}

/**
 * Proje etiketi kataloğu yazılırken kullanıcı yeni bir taslak açmış olabilir.
 * Asenkron işlemin sonucu yalnızca başladığı taslak hâlâ güncelse uygulanır.
 */
export async function runCurrentKeywordCommit({ draftAtCommit, getCurrentDraft, commit }) {
  const result = await commit();
  return {
    current: getCurrentDraft() === draftAtCommit,
    result
  };
}

/** Kapanışta yalnızca gerçekten değişmiş yerel alanı tek yamaya dönüştürür. */
export function finalTaskFieldPatch(canonicalTask, localDraft, field) {
  if (!field || taskDraftValuesEqual(canonicalTask?.[field], localDraft?.[field])) return null;
  return { [field]: localDraft?.[field] ?? '' };
}

/** Taslak kayıtları tamamlanmadan görev panelini kapatma. */
export async function closeAfterTaskDrafts({ flushTitle, persistDescription, close }) {
  const settle = (run) => Promise.resolve()
    .then(run)
    .catch((error) => ({ ok: false, error }));
  const [titleResult, descriptionResult] = await Promise.all([
    settle(flushTitle),
    settle(persistDescription)
  ]);
  const closeResult = await close();
  if (titleResult?.ok === false) return titleResult;
  if (descriptionResult?.ok === false) return descriptionResult;
  return closeResult;
}

/** Eski bir kapanışın sonucu, daha sonra başlayan başka bir kapanışı temizleyemez. */
export function clearCompletedClosingTaskId(currentClosingTaskId, completedTaskId) {
  return currentClosingTaskId === completedTaskId ? null : currentClosingTaskId;
}

export function createTaskUpdateTracker() {
  const pending = new Set();
  let failure = null;

  function track(resultOrPromise) {
    let tracked;
    tracked = Promise.resolve(resultOrPromise).then(
      (result) => {
        pending.delete(tracked);
        if (result && result.ok === false && !failure) failure = result;
        return result;
      },
      (error) => {
        pending.delete(tracked);
        const result = { ok: false, error };
        if (!failure) failure = result;
        return result;
      }
    );

    pending.add(tracked);
    return tracked;
  }

  async function waitForIdle() {
    while (pending.size > 0) {
      await Promise.all([...pending]);
    }
    return failure || { ok: true, value: null };
  }

  return {
    track,
    waitForIdle,
    clearFailure() {
      failure = null;
    },
    getFailure() {
      return failure;
    },
    getPendingCount() {
      return pending.size;
    }
  };
}

/**
 * Görev panelini, bekleyen kayıt sonucu ne olursa olsun kapatır. İki işlem aynı
 * anda başlatılır; başarısız kayıt kullanıcıya döndürülürken kapanışın kendisi
 * başarısız kayıt tarafından bloke edilmez.
 */
export async function closeTaskWithPendingUpdates(updateTracker, closeTask) {
  const [pendingResult, closeResult] = await Promise.all([
    updateTracker.waitForIdle(),
    closeTask()
  ]);
  return pendingResult.ok ? closeResult : pendingResult;
}