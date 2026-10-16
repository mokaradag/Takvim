const MISSING_TABLE_NUMBERS = new Set([208, 4145]);
const NEW_TABLES = [
  'MR_TaskAssignmentCoordinations',
  'MR_AssignmentCoordinationRecipients',
  'MR_TaskNotifications'
];

/** Göç uygulanmadan açılan kurulumda zil, var olan talep akışıyla çalışmayı sürdürür. */
export function isMissingNotificationInboxSchema(error) {
  return MISSING_TABLE_NUMBERS.has(Number(error?.number))
    && NEW_TABLES.some((name) => String(error?.message || '').includes(name));
}
