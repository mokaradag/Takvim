'use client';
import { useEffect, useMemo, useState } from 'react';
import { Icons } from '../icons';
import { Heptagon } from '../ui';
import { InfoButton } from '../ui-extras';
import { PeopleDirectoryProvider } from '../PeopleDirectoryContext.jsx';
import { SearchableSelect } from '../SearchableSelect';
import { DashboardView } from '../../features/dashboard/DashboardView';
import { TasksView } from '../../features/tasks/TasksView';
import { SimpleTasksView } from '../../features/tasks/SimpleTasksView';
import { ReminderSettingsView } from '../../features/reminders/ReminderSettingsView';
import { ProjectWorkspaceView } from '../../features/project/ProjectWorkspaceView';
import { CalendarView } from '../../features/calendar/CalendarView';
import { WorkspaceGanttView } from '../../features/gantt/WorkspaceGanttView';
import { KanbanView } from '../../features/kanban/KanbanView';
import { ReportsView } from '../../features/reports/ReportsView';
import { TeamView } from '../../features/team/TeamView';
import { HelpView } from '../../features/help/HelpView';
import { SettingsView } from '../../features/settings/SettingsView';
import { SimpleModePanel } from '../../features/simple/SimpleModePanel';
import { TaskDetailOverlay } from '../../features/task-detail/TaskDetailOverlay';
import { ScheduleRequestCenter } from '../../features/schedule-change/ScheduleRequestCenter.jsx';
import {
  useAllPeople,
  useAllProjects,
  useCurrentUser,
  usePeople,
  useTaskActions,
  useTasks,
  usePortfolioTaskStats,
  useTaskStats,
  useWbs,
  useWorkspace
} from '../../state/hooks';
import { projectTypeMeta, visibleProjects, isArchivedProject } from '../../domain/projectTypes';
import { useAppState } from '../../state/AppStateProvider';
import { useTweaks } from '../../hooks/useTweaks';
import { useApplyTweaks } from '../../hooks/useApplyTweaks';
import { TWEAK_DEFAULTS } from '../../lib/tweaks-defaults';
import { TaskOrganizationFilterProvider } from '../../features/tasks/TaskOrganizationFilterContext.jsx';
import { AppLogo } from './AppLogo';
import { CommandPalette } from './CommandPalette';
import { ModeChooser } from './ModeChooser';
import { DataRefreshControl } from './DataRefreshControl';
import {
  ADMIN_NAV_IDS,
  NAV_ITEMS,
  PAGE_META,
  nextSimpleCalendarTab,
  simpleCalendarPanelId,
  simpleCalendarTabForIntent,
  simpleCalendarTabId
} from './navigation';
import { ProjectExportMenu } from './ProjectExportMenu';
import { SidebarUserPanel } from './SidebarUserPanel';
import { readSidebarPreference, writeSidebarPreference } from './sidebarPreference.js';
import { WelcomeScreen } from './WelcomeScreen';
import { useSignOut } from './useSignOut.js';

// Temel Kip, Kapsamlı Kip ile aynı Gantt görünümünü paylaşır: hızlı görev
// tanımı yapan kullanıcı da planı zaman çizelgesinde görebilmelidir.
//
// Görevler sayfası da Temel Kipte bulunur; ancak Kapsamlı Kipin tam tablosu
// DEĞİL, Hızlı Görev Tanımı'yla toplanan alanları listeleyen sade sürümü
// gösterilir (bkz. features/tasks/SimpleTasksView.jsx).
const SIMPLE_NAV_IDS = new Set(['veri', 'takvim', 'gantt', 'yardim', 'ayarlar']);
const MODE_STORAGE_KEY = 'mergen_rota_mode_selected_v1';

function projectDisplayName(project) {
  if (!project) return '';
  return project.code ? `${project.code} · ${project.name}` : project.name;
}

function SimpleCalendarTabs({ active, onChange }) {
  const onKeyDown = (event) => {
    const next = nextSimpleCalendarTab(active, event.key);
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(next);
    requestAnimationFrame(() => document.getElementById(simpleCalendarTabId(next))?.focus());
  };

  return (
    <div className="simple-calendar-tabs seg" role="tablist" aria-label="Temel Kip Takvim görünümü">
      <button
        type="button"
        id={simpleCalendarTabId('calendar')}
        role="tab"
        aria-selected={active === 'calendar'}
        aria-controls={simpleCalendarPanelId('calendar')}
        tabIndex={active === 'calendar' ? 0 : -1}
        className={active === 'calendar' ? 'active' : ''}
        onClick={() => onChange('calendar')}
        onKeyDown={onKeyDown}
      >
        <Icons.Calendar size={13} /> Takvim
      </button>
      <button
        type="button"
        id={simpleCalendarTabId('entry')}
        role="tab"
        aria-selected={active === 'entry'}
        aria-controls={simpleCalendarPanelId('entry')}
        tabIndex={active === 'entry' ? 0 : -1}
        className={active === 'entry' ? 'active' : ''}
        onClick={() => onChange('entry')}
        onKeyDown={onKeyDown}
      >
        <Icons.Plus size={13} /> Hızlı Görev Tanımı
      </button>
    </div>
  );
}

export default function AppShell() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  useApplyTweaks(t);
  const tasks = useTasks();
  const people = usePeople();
  // Avatar fotoğrafı çözümü çalışma alanı kapsamına değil, tüm kişi dizinine
  // bakar: başka projede görünen bir sorumlunun fotoğrafı da bulunabilmelidir.
  const directoryPeople = useAllPeople();
  const wbs = useWbs();
  const projects = useAllProjects();
  const workspace = useWorkspace();
  const {
    mode: workspaceMode,
    selectedProjectId,
    selectedProject,
    selectWorkspace
  } = workspace;
  const stats = useTaskStats();
  const portfolioStats = usePortfolioTaskStats();
  const currentUser = useCurrentUser();
  const { isSystemAdmin } = useAppState();
  const { openTask } = useTaskActions();
  const signOutState = useSignOut();
  const simpleMode = t.appMode === 'simple';
  const [sidebarPreference, setSidebarPreference] = useState(readSidebarPreference);
  const [sidebarKeyboardOpen, setSidebarKeyboardOpen] = useState(false);
  const { pinned: sidebarPinned, collapsed: sidebarCollapsed } = sidebarPreference;

  const [view, setView] = useState(() => {
    const landing = TWEAK_DEFAULTS.landingView || 'ozet';
    return NAV_ITEMS.some((item) => item.id === landing) ? landing : 'ozet';
  });
  // Gezinme niyeti: bir sayfanın hangi alt görünümle açılacağını taşır.
  const [viewIntent, setViewIntent] = useState(null);
  const navigate = (nextView, intent = null) => {
    setViewIntent(intent);
    setView(nextView);
  };
  const [simpleCalendarTab, setSimpleCalendarTab] = useState('calendar');
  const [simpleCalendarMonth, setSimpleCalendarMonth] = useState(() => {
    const current = new Date();
    return new Date(current.getFullYear(), current.getMonth(), 1);
  });
  const [cmdOpen, setCmdOpen] = useState(false);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const [modePickerOpen, setModePickerOpen] = useState(() => {
    try { return localStorage.getItem(MODE_STORAGE_KEY) !== '1'; }
    catch { return false; }
  });
  const [welcomeOpen, setWelcomeOpen] = useState(() => {
    try { return localStorage.getItem('mp_seen_welcome_v2') !== '1'; }
    catch { return true; }
  });
  const [hideWelcome, setHideWelcome] = useState(() => {
    try { return localStorage.getItem('mp_seen_welcome_v2') === '1'; }
    catch { return false; }
  });

  const closeWelcome = () => {
    setWelcomeOpen(false);
    try { if (hideWelcome) localStorage.setItem('mp_seen_welcome_v2', '1'); }
    catch {}
  };

  const chooseMode = (mode) => {
    setTweak('appMode', mode);
    try { localStorage.setItem(MODE_STORAGE_KEY, '1'); } catch {}
    setModePickerOpen(false);
    if (mode === 'simple') {
      selectWorkspace(null);
      setSimpleCalendarTab('calendar');
      navigate('takvim');
    }
  };

  const toggleSidebarPin = () => {
    setSidebarPreference((current) => current.pinned
      ? { pinned: false, collapsed: true }
      : { pinned: true, collapsed: false });
  };

  useEffect(() => {
    writeSidebarPreference(sidebarPreference);
  }, [sidebarPreference]);

  useEffect(() => {
    if (!simpleMode) return;
    if (workspaceMode !== 'portfolio') selectWorkspace(null);
    // Rol kapılı yönetici sayfaları Temel Kip yönlendirmesinden MUAFTIR:
    // yalnızca sistem yöneticisine açılan yapılandırma ekranı, kullanıcı Temel
    // Kipte diye ulaşılamaz olmamalıdır.
    if (!SIMPLE_NAV_IDS.has(view) && !ADMIN_NAV_IDS.has(view)) navigate('takvim');
  }, [simpleMode, view, workspaceMode, selectWorkspace]);

  // Yönetici sayfasında yetki kaybı (oturum tazelenmesi, rol kaldırılması)
  // kullanıcıyı boş bir ekranda bırakmaz.
  useEffect(() => {
    if (ADMIN_NAV_IDS.has(view) && !isSystemAdmin) navigate('ozet');
  }, [view, isSystemAdmin]);

  useEffect(() => {
    if (simpleMode && view === 'takvim') {
      setSimpleCalendarTab(simpleCalendarTabForIntent(viewIntent));
    }
  }, [simpleMode, view, viewIntent]);

  useEffect(() => {
    // Temel Kipte komut paleti RENDER EDİLMEZ: kısayolu yine de yutmak,
    // tarayıcının kendi Ctrl+K davranışını hiçbir karşılık vermeden alıyor ve
    // `cmdOpen` açık kaldığı için Kapsamlı Kipe geçildiğinde palet kendiliğinden
    // açılıyordu.
    if (simpleMode) return undefined;
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key?.toLowerCase() === 'k') {
        event.preventDefault();
        setCmdOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [simpleMode]);

  const archivedProjectCount = useMemo(() => projects.filter(isArchivedProject).length, [projects]);
  const workspaceProjectOptions = useMemo(() => {
    const listed = visibleProjects(projects, { showArchived: showArchivedProjects });
    if (selectedProject && !listed.some((project) => project.id === selectedProject.id)) listed.unshift(selectedProject);
    return [
      {
        value: '',
        label: 'Portföy · Tüm Projeler',
        description: `${projects.length} proje`,
        icon: <Icons.Layers size={13} />,
        keywords: ['portföy', 'tüm projeler']
      },
      ...listed.map((project) => {
        const type = projectTypeMeta(project.projectTypeCode, project.projectTypeName);
        const ProjectIcon = Icons[type.icon] || Icons.Layers;
        return {
          value: project.id,
          label: projectDisplayName(project),
          group: `${type.code} · ${type.name}`,
          description: isArchivedProject(project) ? 'Tamamlanan / kapatılan' : null,
          icon: <ProjectIcon size={13} />,
          keywords: [project.code, project.name, type.code, type.name]
        };
      })
    ];
  }, [projects, selectedProject, showArchivedProjects]);

  const totalsByView = useMemo(() => ({
    ozet: tasks.length,
    veri: tasks.length,
    wbs: workspaceMode === 'project' ? wbs.length : projects.length,
    takvim: null,
    gantt: tasks.length,
    kanban: tasks.length,
    rapor: null,
    kisi: people.length,
    yardim: null,
    ayarlar: null,
    hatirlatma: null
  }), [tasks.length, wbs.length, projects.length, people.length, workspaceMode]);

  const visibleNavItems = (simpleMode
    // Yönetici sayfaları Temel Kipte de listelenir; aşağıdaki rol süzgeci
    // bunları yine yalnızca sistem yöneticisine gösterir.
    ? NAV_ITEMS.filter((item) => SIMPLE_NAV_IDS.has(item.id) || ADMIN_NAV_IDS.has(item.id))
    : NAV_ITEMS
  ).filter((item) => !ADMIN_NAV_IDS.has(item.id) || isSystemAdmin);

  const renderView = () => {
    switch (view) {
      case 'ozet': return <DashboardView onNavigate={navigate} />;
      case 'veri': return simpleMode
        ? <SimpleTasksView onNewTask={() => navigate('takvim', 'entry')} />
        : <TasksView />;
      // Sekme niyeti anahtar olarak taşınır: karşılama kısayolu ağacı açar,
      // sıradan gezinme Proje Tanımı ile başlar.
      case 'wbs': return <ProjectWorkspaceView key={`wbs:${viewIntent || 'definition'}`} initialTab={viewIntent} />;
      case 'takvim': return simpleMode ? (
        <div className="simple-calendar-workspace">
          {simpleCalendarTab === 'calendar' ? (
            <CalendarView
              t={t}
              setTweak={setTweak}
              month={simpleCalendarMonth}
              onMonthChange={setSimpleCalendarMonth}
              panelId={simpleCalendarPanelId('calendar')}
              panelLabelledBy={simpleCalendarTabId('calendar')}
              leadingControls={<SimpleCalendarTabs active={simpleCalendarTab} onChange={setSimpleCalendarTab} />}
            />
          ) : (
            <div
              id={simpleCalendarPanelId('entry')}
              className="simple-calendar-tab-panel"
              role="tabpanel"
              aria-labelledby={simpleCalendarTabId('entry')}
            >
              <SimpleCalendarTabs active={simpleCalendarTab} onChange={setSimpleCalendarTab} />
              <SimpleModePanel />
            </div>
          )}
        </div>
      ) : <CalendarView t={t} setTweak={setTweak} />;
      case 'gantt': return <WorkspaceGanttView />;
      case 'kanban': return <KanbanView />;
      case 'rapor': return <ReportsView />;
      case 'kisi': return <TeamView />;
      case 'yardim': return <HelpView />;
      case 'ayarlar': return <SettingsView t={t} setTweak={setTweak} />;
      // Yönetici sayfası: gezinme öğesi gizlense bile doğrudan geçiş
      // denendiğinde de yalnızca yönetici görebilir. Sunucu ayrıca denetler.
      case 'hatirlatma': return isSystemAdmin ? <ReminderSettingsView /> : null;
      default: return null;
    }
  };

  const meta = PAGE_META[view] || PAGE_META.ozet;
  const workspaceKey = `${workspaceMode}:${selectedProjectId || 'all'}:${simpleMode ? 'simple' : 'advanced'}`;
  const projectContextVisible = !simpleMode && selectedProject && view !== 'ayarlar' && view !== 'yardim';
  const exportVisible = !simpleMode && view !== 'ayarlar' && view !== 'yardim';
  const calendarContentActive = view === 'takvim' && (!simpleMode || simpleCalendarTab === 'calendar');

  // İlk açılış akışlarında ana uygulama hiç render edilmez. Böylece Özet üst çubuğu,
  // sidebar veya başka bir sayfa parçası karşılama/kip seçim ekranının arkasından görünmez.
  if (modePickerOpen) return <ModeChooser onChoose={chooseMode} />;

  if (welcomeOpen && !simpleMode) {
    return (
      <WelcomeScreen
        stats={portfolioStats}
        currentUser={currentUser}
        onClose={closeWelcome}
        onNavigate={navigate}
        showAgain={!hideWelcome}
        onShowAgainChange={(show) => setHideWelcome(!show)}
      />
    );
  }

  return (
    <div className={`app app-mode-${simpleMode ? 'simple' : 'advanced'} sidebar-is-${sidebarPinned ? 'pinned' : 'unpinned'} sidebar-is-${sidebarCollapsed ? 'collapsed' : 'expanded'}`}>
      {/* Kişi dizini bağlamı DOM düğümü üretmez: ızgara çocukları değişmez. */}
      <PeopleDirectoryProvider people={directoryPeople}>
      <aside
        className="sidebar"
        data-keyboard-open={sidebarKeyboardOpen}
        onPointerDownCapture={() => setSidebarKeyboardOpen(false)}
        onPointerLeave={() => setSidebarKeyboardOpen(false)}
        onFocusCapture={(event) => {
          if (event.target.matches(':focus-visible')) setSidebarKeyboardOpen(true);
        }}
        onKeyDownCapture={() => setSidebarKeyboardOpen(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setSidebarKeyboardOpen(false);
        }}
      >
        <Heptagon variant="hept-sidebar" />
        <div className="sidebar-header">
          <AppLogo size={34} />
          <div className="brand-copy col" style={{ gap: 0 }}>
            <div className="brand-name"><span>MERGEN</span><span className="brand-accent">Rota</span><span className="brand-dot" /></div>
            <div className="brand-sub">Görev Yönetimi</div>
          </div>
        </div>
        {!simpleMode ? (
          <div className="sidebar-workspace-context col" style={{ gap: 6, padding: '0 12px 10px' }}>
            <SearchableSelect
              value={selectedProjectId || ''}
              options={workspaceProjectOptions}
              onChange={(projectId) => selectWorkspace(projectId || null)}
              placeholder="Portföy veya proje seçin"
              searchPlaceholder="Proje kodu, adı veya türüyle ara"
              ariaLabel="Portföy veya proje çalışma alanı seç"
              maxVisible={70}
              compact
              allowClear
              clearLabel="Portföye dön (tüm projeler)"
              style={{ width: '100%', fontSize: 12.5 }}
            />
            {/* Proje çalışma alanından portföye tek tıkla dönüş. */}
            {workspaceMode === 'project' && (
              <button type="button" className="btn ghost sm workspace-back-btn" onClick={() => selectWorkspace(null)}>
                <Icons.ArrowLeft size={12} /> Portföye dön
              </button>
            )}
            {archivedProjectCount > 0 && (
              <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={showArchivedProjects}
                  onChange={(event) => setShowArchivedProjects(event.target.checked)}
                />
                Tamamlanan ve kapatılanları göster ({archivedProjectCount})
              </label>
            )}
            <div className="muted" style={{ fontSize: 10.5, paddingLeft: 2 }}>
              {workspaceMode === 'project' ? `${tasks.length} görev · ${wbs.length} dağılım düğümü` : `${projects.length} proje · ${tasks.length} görev`}
            </div>
          </div>
        ) : (
          <div className="sidebar-simple-mode">
            <span><Icons.Calendar size={13} /> Temel Kip</span>
            <small>Hızlı tanım ve Takvim takibi</small>
          </div>
        )}

        {!simpleMode && (
          <button className="cmd-trigger" onClick={() => setCmdOpen(true)}>
            <Icons.Search size={13} />
            <span>Ara veya komut çalıştır...</span>
            <span className="kbd">Ctrl K</span>
          </button>
        )}

        <nav className="nav">
          {visibleNavItems.map((item) => {
            const Icon = Icons[item.icon];
            return (
              <button
                key={item.id}
                className={`nav-item${view === item.id ? ' active' : ''}`}
                onClick={() => {
                  if (simpleMode && item.id === 'takvim') setSimpleCalendarTab('calendar');
                  navigate(item.id);
                }}
              >
                <Icon className="nav-icon" size={15} />
                <span className="nav-label">{item.label}</span>
                {totalsByView[item.id] != null && <span className="nav-count">{totalsByView[item.id]}</span>}
              </button>
            );
          })}
        </nav>

        {/* Kullanıcı, görünüm ve oturum kontrolleri tek alt araç alanında yaşar. */}
        <div className="sidebar-footer">
          <SidebarUserPanel
            theme={t.theme}
            onToggleTheme={() => setTweak('theme', t.theme === 'light' ? 'dark' : 'light')}
            simpleMode={simpleMode}
            onChooseMode={chooseMode}
            sidebarPinned={sidebarPinned}
            onToggleSidebarPin={toggleSidebarPin}
            signOutState={signOutState}
          />
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-emblem-clip"><Heptagon variant="hept-topbar" /></div>
          <div className="topbar-page-copy col" style={{ gap: 2 }}>
            <h1 className="hero-title">{meta.title}</h1>
            <div className="sub">{meta.sub}</div>
          </div>
          {projectContextVisible && (
            <div className="topbar-project-context" aria-label={`Seçili proje: ${projectDisplayName(selectedProject)}`}>
              {selectedProject.code && <span className="topbar-project-code">{selectedProject.code}</span>}
              {selectedProject.code && <span className="topbar-project-separator">·</span>}
              <strong className="topbar-project-name">{selectedProject.name}</strong>
            </div>
          )}
          <div className="topbar-spacer" />
          <div className="topbar-actions">
            <ScheduleRequestCenter />
            <DataRefreshControl />
            {exportVisible && (
              <ProjectExportMenu
                project={selectedProject}
                projects={projects}
                tasks={tasks}
                wbs={wbs}
                people={directoryPeople}
              />
            )}
            {view === 'veri' && (
              <InfoButton title="Görevler" icon={<Icons.Table size={12} />}>
                <p>Görevleri listele, filtrele ve düzenle. Proje çalışma alanında liste seçili proje ile otomatik olarak sınırlandırılır.</p>
              </InfoButton>
            )}
          </div>
        </header>
        {/* Sağlayıcı anahtar verilen içerik alanının DIŞINDADIR: çalışma alanı veya
            kip değişse de geçerli kurumsal görev kapsamı yeniden kurulmaz. */}
        <TaskOrganizationFilterProvider>
          <main key={workspaceKey} className={`content content-${view}${calendarContentActive ? ' calendar-content-active' : ''}`}>{renderView()}</main>
        </TaskOrganizationFilterProvider>
      </div>

      <TaskDetailOverlay simple={simpleMode} />
      {cmdOpen && !simpleMode && (
        <CommandPalette
          onClose={() => setCmdOpen(false)}
          onNavigate={navigate}
          onOpenTask={openTask}
          onSetTheme={(theme) => setTweak('theme', theme)}
          tasks={tasks}
        />
      )}
      </PeopleDirectoryProvider>
    </div>
  );
}
