'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icons } from '../../components/icons';
import { DATA_MODES } from '../../data/dataMode.js';
import { useDataMode } from '../../components/shell/DataModeContext.jsx';
import { ADMIN_TABS } from '../../domain/observability/eventModel.js';
import { ReminderSettingsView } from '../reminders/ReminderSettingsView';
import { SystemHealthStrip } from './SystemHealthStrip.jsx';
import { SystemOverviewTab } from './tabs/SystemOverviewTab.jsx';
import { SystemPerformanceTab } from './tabs/SystemPerformanceTab.jsx';
import { SystemQueuesTab } from './tabs/SystemQueuesTab.jsx';
import { SystemEventsTab } from './tabs/SystemEventsTab.jsx';
import { SystemIntegrationsTab } from './tabs/SystemIntegrationsTab.jsx';
import { loadSystemOverviewRequest } from './systemAdminClient.js';
import { useAdminResource } from './useAdminResource.js';
import {
  DEFAULT_SYSTEM_ADMIN_TAB,
  SYSTEM_ADMIN_TABS,
  isSystemAdminTab,
  nextSystemAdminTab,
  readStoredSystemAdminTab,
  systemAdminPanelId,
  systemAdminTabId,
  writeStoredSystemAdminTab
} from './systemAdminTabs.js';

/**
 * Sistem Yönetimi · işletim kokpiti.
 *
 * Sayfa YALNIZCA sistem yöneticilerine gösterilir; asıl sınır sunucudadır ve
 * her yönetim ucu yetkiyi bağımsız olarak yeniden denetler (bkz.
 * server/observability/adminRequestContext.js). Sayfa proje kapsamlı DEĞİLDİR:
 * seçili projeden bağımsız olarak bütün sistemi anlatır.
 *
 * Demo Kipinde üretim uçları HİÇ çağrılmaz; konsolun iskeleti gösterilir ve
 * canlı gözlemlenebilirliğin kullanılamadığı açıkça söylenir.
 */
function browserStorage() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function SystemAdministrationView() {
  const { dataMode } = useDataMode();
  const actualMode = dataMode === DATA_MODES.ACTUAL;
  const [activeTab, setActiveTab] = useState(() => readStoredSystemAdminTab(browserStorage()));
  const [focusedComponent, setFocusedComponent] = useState(null);
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(10000);

  const loadOverview = useCallback((options) => loadSystemOverviewRequest(options), []);
  const overview = useAdminResource(loadOverview, { intervalMs: refreshIntervalMs, enabled: actualMode });

  // Yenileme aralığı sunucudan gelir: dağıtımda ayarlanan değer istemciye
  // `NEXT_PUBLIC_` değişkeniyle değil, yetkili uçtan taşınır.
  const configuredInterval = overview.data?.configuration?.refreshIntervalMs;
  useEffect(() => {
    if (Number.isFinite(configuredInterval) && configuredInterval !== refreshIntervalMs) {
      setRefreshIntervalMs(configuredInterval);
    }
  }, [configuredInterval, refreshIntervalMs]);

  useEffect(() => {
    writeStoredSystemAdminTab(browserStorage(), activeTab);
  }, [activeTab]);

  const goToTab = useCallback((tab, componentKey = null) => {
    if (!isSystemAdminTab(tab)) return;
    setFocusedComponent(componentKey);
    setActiveTab(tab);
  }, []);

  const onTabKeyDown = (event) => {
    const next = nextSystemAdminTab(activeTab, event.key);
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveTab(next);
    requestAnimationFrame(() => document.getElementById(systemAdminTabId(next))?.focus());
  };

  const tabs = useMemo(() => SYSTEM_ADMIN_TABS, []);
  const active = isSystemAdminTab(activeTab) ? activeTab : DEFAULT_SYSTEM_ADMIN_TAB;

  return (
    <div className="sysadmin-page col" style={{ gap: 14 }}>
      {!actualMode && (
        <div className="card sysadmin-demo-notice" role="status">
          <Icons.Sparkle size={15} aria-hidden="true" />
          <div>
            <strong>Demo Kipi</strong>
            <p>
              Sistem Yönetimi üretim gözlemlenebilirliğini gösterir ve Demo Kipinde CANLI veri okumaz.
              Ekrandaki yapı yalnızca konsolun düzenini tanıtır; hiçbir değer gerçek sistem sağlığını
              temsil etmez. Gerçek Sistem verisine geçtiğinizde canlı ölçümler görünür.
            </p>
          </div>
        </div>
      )}

      <SystemHealthStrip
        overview={actualMode ? overview.data : null}
        stale={actualMode && overview.stale}
        error={actualMode ? overview.error : null}
        lastUpdatedAt={actualMode ? overview.lastUpdatedAt : null}
        refreshing={actualMode && overview.refreshing}
        onRefresh={overview.refresh}
        onNavigate={goToTab}
      />

      <div className="sysadmin-tabs" role="tablist" aria-label="Sistem Yönetimi bölümleri">
        {tabs.map((tab) => {
          const Icon = Icons[tab.icon] || Icons.Activity;
          const selected = active === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              id={systemAdminTabId(tab.id)}
              role="tab"
              aria-selected={selected}
              aria-controls={systemAdminPanelId(tab.id)}
              tabIndex={selected ? 0 : -1}
              className={`sysadmin-tab${selected ? ' active' : ''}`}
              onClick={() => goToTab(tab.id)}
              onKeyDown={onTabKeyDown}
            >
              <Icon size={13} aria-hidden="true" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      <div
        id={systemAdminPanelId(active)}
        role="tabpanel"
        aria-labelledby={systemAdminTabId(active)}
        className="sysadmin-panel"
        tabIndex={-1}
      >
        {active === ADMIN_TABS.OVERVIEW && (
          <SystemOverviewTab
            overview={overview.data}
            loading={overview.loading}
            error={overview.error}
            stale={overview.stale}
            lastUpdatedAt={overview.lastUpdatedAt}
            demoMode={!actualMode}
            onNavigate={goToTab}
          />
        )}
        {active === ADMIN_TABS.PERFORMANCE && <SystemPerformanceTab enabled={actualMode} />}
        {active === ADMIN_TABS.QUEUES && <SystemQueuesTab enabled={actualMode} focusedComponent={focusedComponent} />}
        {active === ADMIN_TABS.EVENTS && <SystemEventsTab enabled={actualMode} focusedComponent={focusedComponent} />}
        {active === ADMIN_TABS.INTEGRATIONS && <SystemIntegrationsTab enabled={actualMode} />}
        {/* Hatırlatma yönetimi TAŞINIR, çatallanmaz: var olan görünüm olduğu
            gibi bu sekmeye gömülür ve davranışı değişmez. */}
        {active === ADMIN_TABS.REMINDERS && <ReminderSettingsView />}
      </div>
    </div>
  );
}
