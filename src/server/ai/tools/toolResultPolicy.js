import 'server-only';

const POLICIES = Object.freeze({
  rota_task_search: { rows: ['tasks'], trim: ['tasks', 'tasks.*.assignees'] },
  rota_task_detail: { trim: ['task.assignees', 'task.wbsPath'] },
  rota_task_analytics: { trim: ['groups'] },
  rota_project_search: { rows: ['matches'], trim: ['matches'] },
  rota_project_detail: { trim: ['project.tags'] },
  rota_portfolio_summary: { rows: ['projects'], trim: ['projects'] },
  rota_wbs_inspect: { rows: ['nodes'], trim: ['nodes'] },
  rota_workload_summary: { rows: ['people'], trim: ['people'] },
  rota_person_search: { rows: ['people'], trim: ['people'] },
  rota_baseline_compare: { rows: ['mostSlipped'], trim: ['mostSlipped', 'availableBaselines'] },
  rota_dependency_inspect: { rows: ['predecessors', 'successors'], trim: ['predecessors', 'successors', 'mostConnected'] },
  rota_recurrence_inspect: { rows: ['series'], trim: ['series', 'series.next', 'series.*.next'] },
  rota_calendar_inspect: { rows: ['holidays'], trim: ['holidays'] },
  rota_activity_search: { rows: ['items'], trim: ['items', 'items.*.changes', 'items.*.structuredChanges'] },
  rota_schedule_requests: { rows: ['items'], trim: ['items'] },
  rota_assignment_requests: { rows: ['items'], trim: ['items'] },
  rota_notifications: { rows: ['scheduleRequests.latest', 'assignmentCoordination.latest', 'taskEvents.latest'], trim: ['scheduleRequests.latest', 'assignmentCoordination.latest', 'taskEvents.latest'] },
  rota_outlook_status: { rows: ['items'], trim: ['items'] },
  rota_data_quality: { trim: ['checks.*.examples', 'completedWithoutActualFinish.examples'] }
});

function collections(value, path) {
  if (!path.length) return Array.isArray(value) ? [value] : [];
  const [key, ...rest] = path;
  if (key === '*') return Array.isArray(value) ? value.flatMap((item) => collections(item, rest)) : [];
  return value && typeof value === 'object' ? collections(value[key], rest) : [];
}

export function fitToolResult(envelope, maxBytes, factScope, explicitPolicy = null) {
  const current = structuredClone(envelope);
  const policy = explicitPolicy || POLICIES[current.tool];
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const text = JSON.stringify({ ...current, factScope });
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    const candidates = (policy?.trim || []).flatMap((path) => collections(current.data, path.split('.')))
      .filter((list) => list.length > 0).sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length);
    const largest = candidates[0];
    if (!largest) return null;
    largest.splice(Math.floor(largest.length / 2));
    current.complete = false;
    current.truncated = true;
    current.nextCursor = null;
    current.data.sizeNote = 'Sonuç boyut sınırı nedeniyle kısaltıldı; daha dar bir süzgeçle yeniden sorgulayın.';
    const primary = (policy.rows || []).flatMap((path) => collections(current.data, path.split('.')));
    if (primary.length) current.returnedCount = primary.reduce((count, list) => count + list.length, 0);
  }
  return null;
}
