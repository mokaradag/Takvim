import { canonicalActualId } from '../../domain/identity/actualId.js';
import { encodeVersion } from '../repository/versionTokens.js';
function isoDate(value) { return value ? new Date(value).toISOString().slice(0, 10) : null; }

export function mapRequest(row, actorSicil) {
  if (!row) return null;
  const requesterSicil = String(row.RequesterSicil);
  const decisionOwnerSicil = String(row.DecisionOwnerSicil);
  const projectId = row.ProjectIdSnapshot ?? row.ProjectId;
  return {
    id: canonicalActualId(row.RequestId) ?? String(row.RequestId),
    taskId: canonicalActualId(row.TaskId) ?? String(row.TaskId),
    taskTitle: row.TaskTitleSnapshot ?? row.TaskTitle ?? '',
    projectId: canonicalActualId(projectId) ?? String(projectId ?? ''),
    projectName: row.ProjectNameSnapshot ?? row.ProjectName ?? '',
    projectCode: row.ProjectCodeSnapshot ?? row.ProjectCode ?? '',
    requesterSicil,
    requesterName: row.RequesterName || requesterSicil,
    decisionOwnerSicil,
    decisionOwnerName: row.DecisionOwnerName || decisionOwnerSicil,
    originalPlannedStart: isoDate(row.OriginalPlannedStart),
    proposedPlannedStart: isoDate(row.ProposedPlannedStart),
    originalPlannedFinish: isoDate(row.OriginalPlannedFinish),
    proposedPlannedFinish: isoDate(row.ProposedPlannedFinish),
    originalTargetFinish: isoDate(row.OriginalTargetFinish),
    proposedTargetFinish: isoDate(row.ProposedTargetFinish),
    requesterMessage: row.RequesterMessage || '',
    status: row.Status,
    createdAt: row.CreatedAt ? new Date(row.CreatedAt).toISOString() : null,
    decidedAt: row.DecidedAt ? new Date(row.DecidedAt).toISOString() : null,
    decisionBySicil: row.DecisionBySicil == null ? null : String(row.DecisionBySicil),
    decisionMessage: row.DecisionMessage || '',
    version: encodeVersion(row.RowVersion),
    unread: row.IsUnread == null ? true : Boolean(row.IsUnread),
    taskAvailable: row.TaskAvailable == null ? true : Boolean(row.TaskAvailable),
    isDecisionOwner: Number(row.DecisionOwnerSicil) === Number(actorSicil),
    isRequester: Number(row.RequesterSicil) === Number(actorSicil)
  };
}
