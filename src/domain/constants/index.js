export const TASK_STATUSES = Object.freeze({
  TODO: 'todo',
  IN_PROGRESS: 'in_progress',
  DONE: 'done'
});

export const PRIORITIES = Object.freeze({
  critical: { id: 'critical', label: 'Kritik', color: 'var(--status-overdue)', order: 0 },
  high: { id: 'high', label: 'Yüksek', color: 'oklch(70% 0.16 50)', order: 1 },
  medium: { id: 'medium', label: 'Orta', color: 'oklch(70% 0.13 200)', order: 2 },
  low: { id: 'low', label: 'Düşük', color: 'var(--text-dim)', order: 3 }
});
