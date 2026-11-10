/**
 * Görevin kullanıcıya gösterilen ilerleme değerini döndürür. Kalıcı yüzde
 * yoksa tamamlanmış görev yüzde 100, diğer durumlar yüzde 0 kabul edilir.
 */
export function taskProgressValue(task) {
  if (task?.progress != null) return task.progress;
  return task?.status === 'done' ? 100 : 0;
}

/**
 * Tarih sıralamasında çağıran görünümün anlamını açıkça seçmesine izin verir.
 * Gantt varsayılan olarak planı gösterir; Görevler tablosu gerçekleşen tarih
 * varsa onu gösterdiği için `effective` kipini kullanır.
 */
export function taskSortValue(task, key, dateMode = 'planned') {
  if (key === 'progress') return taskProgressValue(task);
  return dateMode === 'effective' ? effectiveTaskDate(task, key) : task?.[key];
}

export function effectiveTaskDate(task, key) {
  if (key === 'plannedStart') return task?.actualStart || task?.plannedStart;
  if (key === 'plannedFinish') return task?.actualFinish || task?.plannedFinish;
  return task?.[key];
}

/**
 * Sicil numarası sayısal karşılaştırılır; iç kişi kimliği kullanılmaz.
 * Eksik veya geçersiz Siciller sonda, eşit Siciller kararlı sırada kalır.
 */
function sortableSicil(entry) {
  const person = entry?.person ?? entry;
  for (const candidate of [person?.employeeNo, person?.sicil]) {
    const value = String(candidate ?? '').trim();
    if (/^\d+$/.test(value)) return value.replace(/^0+(?=\d)/, '');
  }
  return null;
}

export function compareAssigneesBySicil(a, b, direction = 'asc') {
  const left = sortableSicil(a);
  const right = sortableSicil(b);
  if (left !== null && right !== null) {
    const order = left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
    return direction === 'desc' ? -order : order;
  }
  if (left !== null) return -1;
  if (right !== null) return 1;
  return String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'tr') * (direction === 'desc' ? -1 : 1);
}
