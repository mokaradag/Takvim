import { fmt } from '../../scheduling/dates/index.js';

/** Seçenek künyeleri arama tuşlarında değil, görev listesi değişince hazırlanır. */
export function buildTaskDependencyOptions(tasks, wbs = []) {
  const nodes = new Map(wbs.map((node) => [node.id, node]));
  const names = new Map();
  for (const task of tasks) names.set(task.task, (names.get(task.task) || 0) + 1);
  const options = tasks.map((task) => {
    const node = nodes.get(task.wbsId);
    const start = fmt(task.plannedStart, 'dd MMM yyyy');
    const finish = fmt(task.plannedFinish, 'dd MMM yyyy');
    const dates = `${start} → ${finish}`;
    const context = [node?.code, dates].filter(Boolean);
    if (names.get(task.task) > 1) context.push(task.keyword, (task.sorumlu || []).join(', '));
    const description = context.filter(Boolean).join(' · ');
    const created = task.createdAt ? new Date(task.createdAt).toLocaleString('tr-TR') : '';
    return {
      value: task.id,
      label: task.task,
      description,
      title: [task.task, node && `${node.code} · ${node.name}`, dates, task.keyword,
        (task.sorumlu || []).join(', '), created && `Oluşturulma: ${created}`, task.description].filter(Boolean).join('\n'),
      keywords: [task.keyword, task.projectCode, node?.code, node?.name,
        task.plannedStart, task.plannedFinish, ...(task.sorumlu || [])],
      created
    };
  });
  const contexts = new Map();
  for (const option of options) {
    const key = `${option.label}\n${option.description}`;
    contexts.set(key, (contexts.get(key) || 0) + 1);
  }
  return options.map(({ created, ...option }) => {
    if (created && contexts.get(`${option.label}\n${option.description}`) > 1) {
      option.description += ` · Tanım: ${created}`;
    }
    return option;
  });
}
