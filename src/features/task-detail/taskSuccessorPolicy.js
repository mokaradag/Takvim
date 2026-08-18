import { depId, dependencyLagDays, relTypeOf } from '../../scheduling/dependencies/index.js';

/**
 * Ardıl görev düzenleme ilkeleri.
 *
 * Bağımlılıklar veride YALNIZCA öncül yönünde saklanır: `B.deps` içinde `A`
 * varsa "A, B'nin öncülüdür". Ardıl kavramı bu ilişkinin ters okunuşudur ve
 * ayrı bir alan olarak tutulmaz — aksi hâlde aynı kenar iki yerde saklanır ve
 * ikisi kaçınılmaz olarak ayrışır.
 *
 * Bu yüzden bir göreve ardıl EKLEMEK, o görevi ARDILIN öncül listesine
 * yazmaktır. Görünümden ayrı tutulan bu modül hangi görevin nasıl yamalanacağını
 * üretir ve tek başına sınanabilir.
 */

const MESSAGES = Object.freeze({
  SUCCESSOR_NOT_FOUND: 'Ardıl görev bulunamadı.',
  SUCCESSOR_IS_SELF: 'Bir görev kendisinin ardılı olamaz.',
  SUCCESSOR_ALREADY_LINKED: 'Bu görev zaten ardıl olarak tanımlı.',
  SUCCESSOR_CREATES_CYCLE: 'Bu ilişki döngü oluşturur: seçilen görev zaten bu görevin öncülleri arasında.'
});

function reject(code) {
  return { ok: false, code, message: MESSAGES[code] };
}

/** Bir görevin doğrudan öncül kimlikleri. */
function predecessorIds(task) {
  return (task?.deps || []).map(depId).filter(Boolean);
}

/**
 * Ardılları ilişki bilgisiyle birlikte döndürür.
 *
 * @param {string} taskId öncül görevin kimliği
 * @param {Array<object>} tasks aday görevler
 * @returns {Array<{task: object, dependency: object}>}
 */
export function selectSuccessors(taskId, tasks) {
  if (!taskId) return [];
  const successors = [];
  for (const candidate of tasks || []) {
    const dependency = (candidate?.deps || []).find((entry) => depId(entry) === taskId);
    if (dependency) successors.push({ task: candidate, dependency });
  }
  return successors;
}

/**
 * `taskId` görevine ulaşan tüm öncül kimlikleri (geçişli kapanış).
 * Döngü denetiminde kullanılır; ziyaret edilen düğüm ikinci kez taranmaz, bu
 * yüzden bozuk (döngülü) bir veri kümesinde bile sonlanır.
 */
export function collectPredecessorClosure(taskId, tasks) {
  const byId = new Map((tasks || []).map((task) => [task.id, task]));
  const seen = new Set();
  const queue = [...predecessorIds(byId.get(taskId))];
  while (queue.length) {
    const current = queue.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    queue.push(...predecessorIds(byId.get(current)));
  }
  return seen;
}

/**
 * Ardıl eklemeyi doğrular ve uygulanacak yamayı üretir.
 *
 * @returns {{ok: true, successorId: string, patch: {deps: Array<object>}}
 *   | {ok: false, code: string, message: string}}
 */
export function planSuccessorLink(task, successorId, tasks, { type = 'FS' } = {}) {
  if (!successorId) return reject('SUCCESSOR_NOT_FOUND');
  if (successorId === task?.id) return reject('SUCCESSOR_IS_SELF');
  const successor = (tasks || []).find((item) => item.id === successorId);
  if (!successor) return reject('SUCCESSOR_NOT_FOUND');
  if (predecessorIds(successor).includes(task.id)) return reject('SUCCESSOR_ALREADY_LINKED');
  // Seçilen görev bu görevin (dolaylı da olsa) öncülüyse, ters yönde bir kenar
  // eklemek ağda döngü oluşturur ve kritik yol hesabı çözümsüz kalır.
  if (collectPredecessorClosure(task.id, tasks).has(successorId)) return reject('SUCCESSOR_CREATES_CYCLE');

  const dependency = { id: task.id, predecessorId: task.id, type, lagValue: 0, lagUnit: 'day', lagDays: 0 };
  return {
    ok: true,
    successorId,
    patch: { deps: [...(successor.deps || []), dependency] }
  };
}

/** Ardıl ilişkisini kaldıran yamayı üretir. */
export function planSuccessorUnlink(task, successorId, tasks) {
  const successor = (tasks || []).find((item) => item.id === successorId);
  if (!successor) return reject('SUCCESSOR_NOT_FOUND');
  return {
    ok: true,
    successorId,
    patch: { deps: (successor.deps || []).filter((entry) => depId(entry) !== task.id) }
  };
}

/** Ardıl ilişkisinin türünü/gecikmesini değiştiren yamayı üretir. */
export function planSuccessorUpdate(task, successorId, changes, tasks) {
  const successor = (tasks || []).find((item) => item.id === successorId);
  if (!successor) return reject('SUCCESSOR_NOT_FOUND');
  const deps = (successor.deps || []).map((entry) => {
    if (depId(entry) !== task.id) return entry;
    const current = typeof entry === 'string'
      ? { id: entry, predecessorId: entry, type: relTypeOf(entry), lagValue: 0, lagUnit: 'day' }
      : { ...entry };
    const updated = { ...current, ...changes };
    return { ...updated, lagDays: dependencyLagDays(updated) };
  });
  return { ok: true, successorId, patch: { deps } };
}
