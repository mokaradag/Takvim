import { ADMIN_TABS } from '../../domain/observability/eventModel.js';

/**
 * Sistem Yönetimi sekmeleri.
 *
 * Hiyerarşi bilinçli olarak TEK düzeydir: her sekme kendi içinde bölümlere
 * ayrılır, ikinci bir sekme katmanı açılmaz.
 */
export const SYSTEM_ADMIN_TABS = Object.freeze([
  { id: ADMIN_TABS.OVERVIEW, label: 'Genel Durum', icon: 'Dashboard' },
  { id: ADMIN_TABS.PERFORMANCE, label: 'Performans', icon: 'Chart' },
  { id: ADMIN_TABS.QUEUES, label: 'Kuyruklar ve İşler', icon: 'Layers' },
  { id: ADMIN_TABS.EVENTS, label: 'Hatalar ve Olaylar', icon: 'Alert' },
  { id: ADMIN_TABS.INTEGRATIONS, label: 'Entegrasyonlar', icon: 'Link' },
  { id: ADMIN_TABS.REMINDERS, label: 'Hatırlatma E-postaları', icon: 'Mail' }
]);

export const DEFAULT_SYSTEM_ADMIN_TAB = ADMIN_TABS.OVERVIEW;
export const SYSTEM_ADMIN_TAB_STORAGE_KEY = 'mergen_rota_system_admin_tab_v1';

const TAB_IDS = SYSTEM_ADMIN_TABS.map((tab) => tab.id);

export function isSystemAdminTab(id) {
  return TAB_IDS.includes(String(id ?? ''));
}

export function systemAdminTabId(id) {
  return `system-admin-${id}-tab`;
}

export function systemAdminPanelId(id) {
  return `system-admin-${id}-panel`;
}

/**
 * Klavye gezinmesi.
 *
 * Ok tuşları uçlarda sarar; `Home`/`End` ilk ve son sekmeye gider. Tanınmayan
 * tuş seçimi DEĞİŞTİRMEZ ve `null` döner.
 */
export function nextSystemAdminTab(active, key) {
  const current = Math.max(0, TAB_IDS.indexOf(active));
  if (key === 'Home') return TAB_IDS[0];
  if (key === 'End') return TAB_IDS[TAB_IDS.length - 1];
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const direction = key === 'ArrowRight' ? 1 : -1;
  return TAB_IDS[(current + direction + TAB_IDS.length) % TAB_IDS.length];
}

/** Etkin sekme yenilemeler arasında korunur. */
export function readStoredSystemAdminTab(storage) {
  try {
    const value = storage?.getItem(SYSTEM_ADMIN_TAB_STORAGE_KEY);
    return isSystemAdminTab(value) ? value : DEFAULT_SYSTEM_ADMIN_TAB;
  } catch {
    return DEFAULT_SYSTEM_ADMIN_TAB;
  }
}

export function writeStoredSystemAdminTab(storage, id) {
  try {
    if (isSystemAdminTab(id)) storage?.setItem(SYSTEM_ADMIN_TAB_STORAGE_KEY, id);
  } catch {
    // Tercih saklanamazsa sekme yalnızca bu oturumda korunur.
  }
}
