import { canonicalActualId } from '../../domain/identity/actualId.js';
import {
  COORDINATION_STATUSES,
  allowedCoordinationDecisions
} from '../../domain/assignment/assignmentCoordination.js';
import { NOTIFICATION_SOURCES } from '../../domain/notifications/notificationInbox.js';
import { encodeVersion } from '../repository/versionTokens.js';

function isoDate(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : null;
}

function isoTime(value) {
  return value ? new Date(value).toISOString() : null;
}

/**
 * Kalıcı koordinasyon satırının istemci künyesi.
 *
 * Satır, geçmişte sunulabilmesi için görev/proje/kişi künyesini KENDİ İÇİNDE
 * taşır. Bu künye göreve erişim VERMEZ; "Görevi aç" yine olağan yetkili görev
 * yükleme yolundan geçer.
 */
export function mapCoordination(row, actorSicil) {
  if (!row) return null;
  const actor = Number(actorSicil);
  const isRequester = Number(row.RequesterSicil) === actor;
  const isAssignee = Number(row.RequestedAssigneeSicil) === actor;
  const isManager = Boolean(row.IsManager);
  const projectId = row.ProjectIdSnapshot ?? row.ProjectId;
  const status = String(row.Status);
  const taskAvailable = row.TaskAvailable == null ? true : Boolean(row.TaskAvailable);
  return {
    source: NOTIFICATION_SOURCES.ASSIGNMENT_COORDINATION,
    id: canonicalActualId(row.CoordinationId) ?? String(row.CoordinationId),
    taskId: canonicalActualId(row.TaskId) ?? String(row.TaskId),
    taskTitle: row.TaskTitleSnapshot ?? row.TaskTitle ?? '',
    projectId: projectId == null ? '' : (canonicalActualId(projectId) ?? String(projectId)),
    projectName: row.ProjectNameSnapshot ?? row.ProjectName ?? '',
    projectCode: row.ProjectCodeSnapshot ?? row.ProjectCode ?? '',
    requesterSicil: String(row.RequesterSicil),
    requesterName: row.RequesterName || String(row.RequesterSicil),
    assigneeSicil: String(row.RequestedAssigneeSicil),
    assigneeName: row.AssigneeName || row.AssigneeNameSnapshot || String(row.RequestedAssigneeSicil),
    assigneeOrganization: row.AssigneeOrgSnapshot || '',
    suggestedAssigneeSicil: row.SuggestedAssigneeSicil == null ? null : String(row.SuggestedAssigneeSicil),
    suggestedAssigneeName: row.SuggestedAssigneeName || null,
    mode: String(row.Mode),
    status,
    targetFinish: isoDate(row.TargetFinishSnapshot),
    requesterMessage: row.RequesterMessage || '',
    decisionMessage: row.DecisionMessage || '',
    decisionBySicil: row.DecisionBySicil == null ? null : String(row.DecisionBySicil),
    decisionByName: row.DecisionByName || null,
    createdAt: isoTime(row.CreatedAt),
    decidedAt: isoTime(row.DecidedAt),
    sortAt: isoTime(row.DecidedAt || row.CreatedAt),
    version: encodeVersion(row.RowVersion),
    unread: row.IsUnread == null ? true : Boolean(row.IsUnread),
    taskAvailable,
    isRequester,
    isAssignee,
    isManager,
    // Sunucudaki `ACTIONABLE` yüklemiyle AYNI kural: PENDING yalnızca karar
    // yetkilisinin, CANCELLATION_REQUESTED yalnızca talep edenin bekleyen
    // kararıdır. Talep edenin kendi PENDING kaydındaki "Talebi Geri Çek"
    // seçeneği bir karar beklemesi değildir; o kayıt "Kararınız bekleniyor"
    // gösterip sayaçla çelişiyor ve gerçek kararların üstüne sıralanıyordu.
    actionable: taskAvailable && (
      (status === COORDINATION_STATUSES.PENDING && isManager)
      || (status === COORDINATION_STATUSES.CANCELLATION_REQUESTED && isRequester)
    ),
    allowedDecisions: taskAvailable
      ? allowedCoordinationDecisions(status, { isManager, isRequester })
      : []
  };
}

export { COORDINATION_STATUSES };
