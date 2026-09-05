import { normalizePriorityId, resolvePriority } from '../../domain/constants/index.js';
import { dateMatchesFilter } from '../../components/dateMatchesFilter.js';
import { numericMatchesFilter } from '../../components/numericMatchesFilter.js';
import { diffDays, today } from '../../scheduling/dates/index.js';
import { taskProgressValue } from './taskDisplayValues.js';

/**
 * Kapsamlı Kip · Görevler tablosunun ÇAPRAZ süzgeç fasetleri.
 *
 * Bir sütuna süzgeç uygulandığında öteki sütunların seçenek listesi de daralır:
 * listede yalnızca O AN görünen satırlarda bulunan değerler kalır. Seçenekler
 * süzülmemiş kümeden üretildiğinde kullanıcı, sonucu kesinlikle boş olan bir
 * değeri seçebiliyordu (örneğin bir proje süzülüyken başka projenin sorumlusu).
 *
 * Bir sütunun KENDİ seçenekleri hesaplanırken kendi süzgeci yok sayılır
 * (`ignoredKey`): aksi hâlde seçili değerin dışındaki her seçenek listeden
 * düşer ve kullanıcı ikinci bir değer ekleyemezdi.
 */
export const TASK_TABLE_FACET_KEYS = Object.freeze(['proje', 'keyword', 'sorumlu', 'status', 'priority']);

const DATE_KEYS = Object.freeze(['plannedStart', 'plannedFinish', 'targetFinish']);

/** Görevin süzgeçlerde karşılığı olan durum değerleri (`overdue` türetilmiştir). */
export function taskStatusFilterValues(task, referenceDay) {
  const values = [String(task.status || 'todo')];
  if (task.status !== 'done' && task.targetFinish && diffDays(task.targetFinish, referenceDay) < 0) {
    values.push('overdue');
  }
  return values;
}

function matchesSearch(task, query) {
  if (!query) return true;
  const priority = normalizePriorityId(task.priority);
  // Öncelik hem kanonik kimliğiyle hem görünen etiketiyle aranır: Gantt eskiden
  // ham kimliği tarıyordu ("high"), kullanıcılar ise etiketi yazar ("Yüksek").
  const haystack = [
    task.task, task.proje, task.projectCode, task.keyword,
    priority, resolvePriority(priority)?.label,
    ...(Array.isArray(task.sorumlu) ? task.sorumlu : [])
  ].map((value) => String(value || '').toLocaleLowerCase('tr-TR'));
  return haystack.some((value) => value.includes(query));
}

export function taskTableMatches(task, { search = '', filters = {} } = {}, ignoredKey = null, referenceDay = today()) {
  if (!matchesSearch(task, String(search || '').trim().toLocaleLowerCase('tr-TR'))) return false;

  if (ignoredKey !== 'proje' && filters.proje?.length && !filters.proje.includes(task.projectId)) return false;
  if (ignoredKey !== 'task' && filters.task) {
    const query = String(filters.task).toLocaleLowerCase('tr-TR');
    if (!String(task.task || '').toLocaleLowerCase('tr-TR').includes(query)) return false;
  }
  // Seçenek listesi kırpılmış etiket değerleri saklar; ham `keyword` ile
  // karşılaştırma, baştaki/sondaki boşluk taşıyan etiketlerde eşleşmiyordu.
  if (ignoredKey !== 'keyword' && filters.keyword?.length
    && !filters.keyword.includes(String(task.keyword || '').trim())) return false;
  if (ignoredKey !== 'sorumlu' && filters.sorumlu?.length
    && !(task.assigneeIds || []).some((id) => filters.sorumlu.includes(String(id)))) return false;
  if (ignoredKey !== 'priority' && filters.priority?.length
    && !filters.priority.includes(normalizePriorityId(task.priority))) return false;
  if (ignoredKey !== 'status' && filters.status?.length
    && !taskStatusFilterValues(task, referenceDay).some((value) => filters.status.includes(value))) return false;

  for (const key of DATE_KEYS) {
    if (ignoredKey === key || !filters[key]) continue;
    if (!task[key] || !dateMatchesFilter(task[key], filters[key])) return false;
  }
  if (ignoredKey !== 'progress' && filters.progress
    && !numericMatchesFilter(taskProgressValue(task), filters.progress)) return false;

  return true;
}

/** Bir sütunun seçenek kümesi: öteki süzgeçlerden GEÇEN satırların değerleri. */
export function taskTableFacetValues(tasks, state, key, referenceDay = today()) {
  const values = new Set();
  for (const task of tasks || []) {
    if (!taskTableMatches(task, state, key, referenceDay)) continue;
    if (key === 'proje' && task.projectId != null) values.add(String(task.projectId));
    if (key === 'keyword' && String(task.keyword || '').trim()) values.add(String(task.keyword).trim());
    if (key === 'sorumlu') for (const id of task.assigneeIds || []) values.add(String(id));
    if (key === 'priority') values.add(normalizePriorityId(task.priority));
    if (key === 'status') for (const value of taskStatusFilterValues(task, referenceDay)) values.add(value);
  }
  return values;
}
