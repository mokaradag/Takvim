/**
 * Kanban panosunun SÜZGEÇ ve SIRALAMA kuralları — SAF işlevler.
 *
 * İkisi de tümüyle istemci tarafındadır ve YALNIZCA zaten yetkilendirilmiş,
 * süzülmüş görev listesi üzerinde çalışır: hiçbir kural sunucuya ek sorgu
 * üretmez ve görünürlüğü genişletmez.
 *
 * Kimlik her zaman Sicil'dir. Ad-soyad ne eşleştirmede ne de tekilleştirmede
 * kullanılır; aynı adlı iki çalışan ayrı seçenek olarak kalır.
 */

export const KANBAN_SORT_DIRECTIONS = Object.freeze({ ASC: 'asc', DESC: 'desc' });

export const KANBAN_BOARD_IDS = Object.freeze(['todo', 'in_progress', 'done']);

/** Her pano KENDİ yönünü taşır; varsayılan eskiden yeniye. */
export function createKanbanSortState() {
  return Object.fromEntries(KANBAN_BOARD_IDS.map((id) => [id, KANBAN_SORT_DIRECTIONS.ASC]));
}

export function toggleKanbanSort(state, boardId) {
  const current = state?.[boardId] === KANBAN_SORT_DIRECTIONS.DESC
    ? KANBAN_SORT_DIRECTIONS.ASC
    : KANBAN_SORT_DIRECTIONS.DESC;
  return { ...state, [boardId]: current };
}

export const KANBAN_SORT_LABELS = Object.freeze({
  asc: 'Hedef: eskiden yeniye',
  desc: 'Hedef: yeniden eskiye'
});

/**
 * Panoyu HEDEF tarihe göre sıralar.
 *
 * Hedefi olmayan görev her iki yönde de EN ALTTA kalır; eşitlikte başlık, sonra
 * kimlik kararlı bir sıra üretir.
 */
export function sortKanbanTasks(tasks = [], direction = KANBAN_SORT_DIRECTIONS.ASC) {
  const factor = direction === KANBAN_SORT_DIRECTIONS.DESC ? -1 : 1;
  const tiebreak = (left, right) => String(left?.task || '').localeCompare(String(right?.task || ''), 'tr')
    || String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
  return [...tasks].sort((left, right) => {
    const a = left?.targetFinish || '';
    const b = right?.targetFinish || '';
    if (!a) return b ? 1 : tiebreak(left, right);
    if (!b) return -1;
    return a === b ? tiebreak(left, right) : (a < b ? -1 : 1) * factor;
  });
}

/** Görevin sorumlu Sicil kümesi (çok sorumlu desteklenir). */
export function taskAssigneeSicils(task) {
  return (task?.assigneeIds || []).map(String).filter(Boolean);
}

/** Seçili sorumlu süzgeci bu göreve uyuyor mu? */
export function matchesKanbanAssignee(task, assigneeId) {
  if (!assigneeId) return true;
  return taskAssigneeSicils(task).includes(String(assigneeId));
}

/**
 * Seçilebilir sorumlular, O AN süzülmüş görev kümesinden türetilir.
 *
 * Böylece kurumsal süzgeç daraldığında seçici de daralır ve kullanıcıya hiçbir
 * görevi olmayan kişi gösterilmez.
 */
export function kanbanAssigneeOptions(tasks = [], directory = []) {
  const byId = new Map(directory.map((person) => [String(person.id), person]));
  const found = new Map();
  for (const task of tasks) {
    const identities = task?.assigneeAvatarIdentities || [];
    for (const id of taskAssigneeSicils(task)) {
      if (found.has(id)) continue;
      const identity = identities.find((candidate) => String(candidate.employeeNo) === id);
      found.set(id, byId.get(id)?.name || identity?.name || id);
    }
  }
  return [...found.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label, 'tr') || left.value.localeCompare(right.value));
}
