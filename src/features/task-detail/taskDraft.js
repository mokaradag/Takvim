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

/** Kapanışta yalnızca gerçekten değişmiş yerel alanı tek yamaya dönüştürür. */
export function finalTaskFieldPatch(canonicalTask, localDraft, field) {
  if (!field || taskDraftValuesEqual(canonicalTask?.[field], localDraft?.[field])) return null;
  return { [field]: localDraft?.[field] ?? '' };
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
