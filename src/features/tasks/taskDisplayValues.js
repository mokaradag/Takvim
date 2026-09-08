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
