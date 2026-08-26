/**
 * Görevin kullanıcıya gösterilen ilerleme değerini döndürür. Kalıcı yüzde
 * yoksa tamamlanmış görev yüzde 100, diğer durumlar yüzde 0 kabul edilir.
 */
export function taskProgressValue(task) {
  if (task?.progress != null) return task.progress;
  return task?.status === 'done' ? 100 : 0;
}

/** Sıralama, hücrenin ve sayısal süzgecin kullanıcıya gösterdiği değeri izler. */
export function taskSortValue(task, key) {
  return key === 'progress' ? taskProgressValue(task) : task?.[key];
}
