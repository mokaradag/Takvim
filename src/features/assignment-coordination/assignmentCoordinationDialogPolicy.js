import { COORDINATION_MODES } from '../../domain/assignment/assignmentCoordination.js';
import { selectFresherRecord } from '../schedule-change/requestInboxPresentation.js';

/** Güncel doğrulamaya ve karar sonucuna göre pencerenin göstereceği kaydı ve işlemleri seçer. */
export function assignmentCoordinationDialogPolicy(recordProp, {
  verification, revision, committedState, unconfirmed, rejected
}) {
  const { id, mode } = recordProp;
  // Canlı yetki, koordinasyon satırının sürümü değişmeden de değişebilir.
  const permissionKey = JSON.stringify([recordProp.taskAvailable !== false, recordProp.allowedDecisions ?? []]);
  const shouldVerify = mode !== COORDINATION_MODES.NOTICE || Boolean(recordProp.allowedDecisions?.length);
  const verified = verification?.id === id && verification.revision === revision
    && verification.permissionKey === permissionKey ? verification : null;
  const latest = verified?.record ? selectFresherRecord(verified.record, recordProp) : recordProp;
  const record = selectFresherRecord(latest, committedState?.record, { supersededVersion: committedState?.baseVersion });
  const outcomeUnconfirmed = Boolean(
    unconfirmed
    && String(unconfirmed.id) === String(record.id)
    && (!record.version || unconfirmed.version === record.version)
  );
  const recoveredFromRejection = Boolean(
    rejected
    && verified?.record?.allowedDecisions?.length
    && (verified.revision !== rejected.revision || verified.permissionKey !== rejected.permissionKey)
  );
  const definiteRejectionLocked = Boolean(
    rejected
    && !recoveredFromRejection
    && String(rejected.id) === String(record.id)
    && (!record.version || rejected.version === record.version)
  );
  const decisionsLocked = outcomeUnconfirmed || definiteRejectionLocked;
  const verifying = shouldVerify && !verified;
  const verificationError = shouldVerify ? verified?.error : null;
  const hideDetails = verificationError || (verifying && !(verification?.id === id && verification.record));
  const decisions = decisionsLocked || verifying || verificationError ? [] : (record.allowedDecisions || []);

  return { permissionKey, shouldVerify, record, verifying, verificationError, hideDetails, decisionsLocked, decisions };
}
