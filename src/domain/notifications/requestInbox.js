/**
 * Talepler gelen kutusunun ORTAK sözlüğü.
 *
 * Sunucu sorgusu ve arayüz aynı sekme ve tür kimliklerini kullanır. Kaynakların
 * kalıcı anlamı değişmez; burada yalnızca kullanıcıya gösterilen sınıflama
 * vardır.
 */

/** Sekme kimlikleri geriye dönük uyumludur: `pending` = Gelenler. */
export const REQUEST_INBOX_TABS = Object.freeze({
  INCOMING: 'pending',
  SENT: 'sent',
  HISTORY: 'history'
});

export const REQUEST_INBOX_CATEGORIES = Object.freeze({
  SCHEDULE_REQUEST: 'SCHEDULE_REQUEST',
  ASSIGNMENT_REQUEST: 'ASSIGNMENT_REQUEST',
  ASSIGNMENT_NOTICE: 'ASSIGNMENT_NOTICE',
  TASK_ASSIGNED: 'TASK_ASSIGNED',
  TASK_UNASSIGNED: 'TASK_UNASSIGNED'
});

export const REQUEST_INBOX_CATEGORY_LABELS = Object.freeze({
  SCHEDULE_REQUEST: 'Tarih değişikliği talebi',
  ASSIGNMENT_REQUEST: 'Atama talebi',
  ASSIGNMENT_NOTICE: 'Bölüm dışı atama bildirimi',
  TASK_ASSIGNED: 'Size görev atandı',
  TASK_UNASSIGNED: 'Görev sorumluluğunuz kaldırıldı'
});
