import { requestJson } from './scheduleChangeClient.js';

export function fetchTaskActivities(query = {}) {
  const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value != null && value !== ''));
  return requestJson(`/api/mergen-rota/reports/task-activities?${params}`, { method: 'GET' });
}
