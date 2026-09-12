export function outlookCompletionNeedsCancellation(subscription, date) {
  if (subscription.deliveredMethod === 'CANCEL'
    && (subscription.pendingSequence == null || subscription.pendingSequence <= subscription.deliveredSequence)) return false;
  if (subscription.deliveredSequence == null && !subscription.deliveryMayHaveEscaped) return false;
  if (subscription.lastCancellationReason === 'TASK_COMPLETED'
    && subscription.pendingSequence != null && subscription.pendingPayloadHash && !subscription.pendingDate) return true;
  const completionDate = subscription.completionDate;
  if (!completionDate) return false;
  const dates = [
    subscription.deliveredMethod !== 'CANCEL' ? subscription.deliveredDate : null,
    subscription.deliveryMayHaveEscaped && subscription.pendingSequence != null ? subscription.pendingDate : null
  ].filter(Boolean);
  if (!dates.length) dates.push(date);
  return dates.some((value) => value && value >= completionDate);
}
