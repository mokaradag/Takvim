/**
 * Snapshot yenilemesinde değişmeyen kayıtların React kimliğini korur.
 *
 * Sonuç kümesi HER ZAMAN yeni snapshot'ın üyeliğini izler; önceki snapshot'ta
 * olup artık yetki kapsamında bulunmayan kayıtlar geri eklenmez.
 */
export function snapshotValueEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (left == null || right == null || typeof left !== typeof right) return false;
  if (typeof left !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => snapshotValueEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
    && snapshotValueEqual(left[key], right[key]));
}

export function reuseSnapshotValue(previous, incoming) {
  return snapshotValueEqual(previous, incoming) ? previous : incoming;
}

export function reconcileSnapshotCollection(previous = [], incoming = [], keyOf = (value) => value?.id) {
  const prior = Array.isArray(previous) ? previous : [];
  const next = Array.isArray(incoming) ? incoming : [];
  const previousByKey = new Map();
  prior.forEach((value, index) => {
    const key = keyOf(value, index);
    if (key != null) previousByKey.set(String(key), value);
  });

  const reconciled = next.map((value, index) => {
    const key = keyOf(value, index);
    if (key == null) return value;
    const oldValue = previousByKey.get(String(key));
    return oldValue === undefined ? value : reuseSnapshotValue(oldValue, value);
  });
  return reconciled.length === prior.length
    && reconciled.every((value, index) => value === prior[index])
    ? prior
    : reconciled;
}
