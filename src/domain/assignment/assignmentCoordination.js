/**
 * Atama koordinasyonu · alan modeli.
 *
 * Model iki kavramı KESİN olarak ayırır:
 *
 *   · GERÇEK sorumlu — `MR_TaskAssignees` satırı. İş yükü, Özet, Kanban,
 *     hatırlatma, Outlook ve görünürlük yalnızca bunu okur.
 *   · TALEP EDİLEN sorumlu — bu kayıt. Onaylanana kadar hiçbir hesaba girmez.
 *
 * Doğrudan atama yetkisi sunucuda yeniden doğrulanır; buradaki işlevler
 * yalnızca arayüz metni ve durum geçişi içindir.
 */

export const COORDINATION_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CHANGE_REQUESTED: 'CHANGE_REQUESTED',
  CANCELLATION_REQUESTED: 'CANCELLATION_REQUESTED',
  CANCELLED: 'CANCELLED',
  STALE: 'STALE'
});

/** REQUEST onay bekler; NOTICE yetkili yöneticinin yürürlükteki koordinasyonudur. */
export const COORDINATION_MODES = Object.freeze({ REQUEST: 'REQUEST', NOTICE: 'NOTICE' });

export const COORDINATION_STATUS_LABELS = Object.freeze({
  PENDING: 'Onay bekliyor',
  APPROVED: 'Atandı',
  REJECTED: 'Reddedildi',
  CHANGE_REQUESTED: 'Değişiklik istendi',
  CANCELLATION_REQUESTED: 'Kaldırılması istendi',
  CANCELLED: 'İptal edildi',
  STALE: 'Güncelliğini yitirdi'
});

export const COORDINATION_DECISIONS = Object.freeze({
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  REQUEST_CHANGE: 'REQUEST_CHANGE',
  REQUEST_CANCELLATION: 'REQUEST_CANCELLATION',
  CANCEL: 'CANCEL'
});

const OPEN_STATUSES = new Set([
  COORDINATION_STATUSES.PENDING,
  COORDINATION_STATUSES.CANCELLATION_REQUESTED
]);

export function isOpenCoordinationStatus(status) {
  return OPEN_STATUSES.has(String(status || ''));
}

/**
 * Bir karar, kaydın MEVCUT durumunda uygulanabilir mi?
 *
 * Sunucu aynı tabloyu kullanır; istemci yalnızca düğmeleri gizler.
 */
export function allowedCoordinationDecisions(status, { isManager = false, isRequester = false } = {}) {
  const current = String(status || '');
  const allowed = [];
  if (current === COORDINATION_STATUSES.PENDING) {
    if (isManager) {
      allowed.push(
        COORDINATION_DECISIONS.APPROVE,
        COORDINATION_DECISIONS.REQUEST_CHANGE,
        COORDINATION_DECISIONS.REJECT
      );
    }
    if (isRequester) allowed.push(COORDINATION_DECISIONS.CANCEL);
  } else if (current === COORDINATION_STATUSES.APPROVED) {
    if (isManager) allowed.push(COORDINATION_DECISIONS.REQUEST_CANCELLATION);
  } else if (current === COORDINATION_STATUSES.CANCELLATION_REQUESTED) {
    if (isRequester) allowed.push(COORDINATION_DECISIONS.APPROVE, COORDINATION_DECISIONS.REJECT);
  }
  return [...new Set(allowed)];
}

export const COORDINATION_DECISION_LABELS = Object.freeze({
  APPROVE: 'Onayla',
  REJECT: 'Reddet',
  REQUEST_CHANGE: 'Değişiklik İste',
  REQUEST_CANCELLATION: 'Atamanın Kaldırılmasını İste',
  CANCEL: 'Talebi Geri Çek'
});

/** Kurumsal künye metni. Ad ASLA kimlik değildir; yalnızca gösterilir. */
export function organizationPath(organization = {}) {
  return [organization.directorate, organization.department, organization.unit]
    .map((value) => (value == null ? '' : String(value).trim()))
    .filter(Boolean)
    .join(' / ');
}

/**
 * İki kurumsal künyenin AYNI birimi gösterip göstermediği.
 *
 * Yalnızca arayüz rozetini ("başka birim") belirler; yetki kararı değildir.
 */
export function isExternalOrganization(actor = {}, candidate = {}) {
  const left = organizationPath(actor);
  const right = organizationPath(candidate);
  if (!left || !right) return false;
  return left.localeCompare(right, 'tr', { sensitivity: 'base' }) !== 0;
}
