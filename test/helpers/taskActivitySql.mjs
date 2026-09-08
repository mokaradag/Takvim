import { matchesOrgFilter } from '../../src/domain/organization/organizationHierarchy.js';

const key = (id) => String(id || '').toLowerCase();
const json = (text) => { try { return JSON.parse(text || '{}') || {}; } catch { return {}; } };
export function taskActivityRecordsets(db, params) {
  const projects = new Set(params.visibleProjects.split(',').map(key));
  const tasks = new Set(params.partialTasks.split(',').map(key));
  const inTeam = (id) => Number(id) === params.sicil || db.executiveScope.some((scope) => scope.ManagerSicil === params.sicil && scope.EmployeeSicil === Number(id));
  const rows = db.auditLog.filter((row) => row.EntityType === 'TASK' && ['CREATE', 'UPDATE', 'DELETE'].includes(row.ActionCode))
    .filter((row) => new Date(row.OccurredAt) >= params.startUtc && new Date(row.OccurredAt) < params.endUtc)
    .filter((row) => params.scope === 'visible' || (params.scope === 'mine' ? row.ActorSicil === params.sicil : params.isAdmin || inTeam(row.ActorSicil)))
    .flatMap((row) => {
      const task = db.tasks.find((task) => key(task.TaskId) === key(row.EntityId));
      const project = db.projects.find((project) => key(project.ProjectId) === key(row.ProjectId));
      const deletion = db.auditLog.filter((event) => event.EntityType === 'TASK' && event.ActionCode === 'DELETE' && key(event.EntityId) === key(row.EntityId) && key(event.ProjectId) === key(row.ProjectId))
        .sort((a, b) => b.AuditId - a.AuditId)[0];
      const historic = json(deletion?.BeforeJson);
      const visible = params.isAdmin || (project?.IsActive && (
        (projects.has(key(row.ProjectId)) && (!task || projects.has(key(task.ProjectId)) || tasks.has(key(task.TaskId))))
        || (task && key(task.ProjectId) === key(row.ProjectId) && tasks.has(key(task.TaskId)))
        || (!task && (Number(historic.CreatedBySicil) === params.sicil || (historic.assigneeIds || []).some(inTeam)))
      ));
      if (!visible) return [];
      const person = db.people.find((person) => person.Sicil === row.ActorSicil);
      const before = json(row.BeforeJson), after = json(row.AfterJson);
      const completed = ['done', 'completed'].includes(after.Status || after.status) && !['done', 'completed'].includes(before.Status || before.status);
      return [{ ...row, ActionGroup: row.CorrelationId || `audit:${row.AuditId}`, CurrentTaskId: task?.TaskId,
        CurrentTitle: task?.Title, ProjectName: project?.ProjectName, ProjectCode: project?.ProjectCode,
        CurrentActorName: person?.DisplayName, Directorate: person?.Directorate, Department: person?.Department, Unit: person?.Unit,
        Kind: row.ActionCode === 'DELETE' ? 'deleted' : row.ActionCode === 'CREATE' ? 'created' : completed ? 'completed' : 'updated', Completed: completed }];
    });
  const actors = [...new Map(rows.map((row) => [row.ActorSicil, { ...row, DisplayName: row.CurrentActorName || row.ActorDisplayName }])).values()];
  const projectOptions = [...new Map(rows.filter((row) => row.ProjectId).map((row) => [row.ProjectId, row])).values()];
  const groups = new Map();
  for (const row of rows) {
    if (params.person && row.ActorSicil !== params.person || params.projectId && key(row.ProjectId) !== key(params.projectId)) continue;
    if (!matchesOrgFilter({ organization: { directorate: row.Directorate, department: row.Department, unit: row.Unit } }, params)) continue;
    const group = `${row.ActionGroup}:${row.EntityId}:${row.ActorSicil}:${row.ProjectId}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  const grouped = [...groups.values()].map((events) => {
    events.sort((a, b) => a.AuditId - b.AuditId);
    const last = events.at(-1);
    const Completed = events.some((row) => row.Completed), Deleted = events.some((row) => row.Kind === 'deleted'), Created = events.some((row) => row.Kind === 'created');
    return { events, GroupId: last.AuditId, GroupOccurredAt: last.OccurredAt, Completed, Deleted, Created, EventCount: events.length,
      kind: Deleted ? 'deleted' : Created ? 'created' : Completed ? 'completed' : 'updated' };
  }).filter((group) => !params.kind || group.kind === params.kind)
    .sort((a, b) => String(b.GroupOccurredAt).localeCompare(String(a.GroupOccurredAt)) || b.GroupId - a.GroupId);
  const Page = Math.min(params.page, Math.max(0, Math.ceil(grouped.length / params.pageSize) - 1));
  const summary = { Total: grouped.length, Page, TaskCount: new Set(grouped.map((g) => g.events[0].EntityId)).size,
    ActorCount: new Set(grouped.map((g) => g.events[0].ActorSicil)).size,
    CompletedCount: new Set(grouped.filter((g) => g.Completed).map((g) => g.events[0].EntityId)).size };
  return [actors, projectOptions, [summary], grouped.slice(Page * params.pageSize, (Page + 1) * params.pageSize)
    .flatMap(({ events, ...group }) => events.slice(0, 100).map((row) => ({ ...row, ...group })))];
}
