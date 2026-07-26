'use client';
import { useEffect, useMemo, useState } from 'react';
import { Icons } from '../icons';
import { Heptagon } from '../ui';
import { InfoButton } from '../ui-extras';
import { PeopleDirectoryProvider } from '../PeopleDirectoryContext.jsx';
import { SearchableSelect } from '../SearchableSelect';
import { DashboardView } from '../../features/dashboard/DashboardView';
import { TasksView } from '../../features/tasks/TasksView';
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
import {
  useAllPeople,
  useAllProjects,
  usePeople,
  useTaskActions,
  useTasks,
  useTaskStats,
  useWbs,
  useWorkspace
} from '../../state/hooks';
import { projectTypeMeta, visibleProjects, isArchivedProject } from '../../domain/projectTypes';
import { useTweaks } from '../../hooks/useTweaks';
import { useApplyTweaks } from '../../hooks/useApplyTweaks';
import { TWEAK_DEFAULTS } from '../../lib/tweaks-defaults';
import { AppLogo } from './AppLogo';
import { CommandPalette } from './CommandPalette';
import { ModeChooser } from './ModeChooser';
import { NAV_ITEMS, PAGE_META } from './navigation';
import { ProjectExportMenu } from './ProjectExportMenu';
import { SidebarUserPanel } from './SidebarUserPanel';
import { WelcomeScreen } from './WelcomeScreen';

// Basit Mod, Gelişmiş Mod ile aynı Gantt görünümünü paylaşır: hızlı görev
// tanımı yapan kullanıcı da planı zaman çizelgesinde görebilmelidir.
const SIMPLE_NAV_IDS = new Set(['takvim', 'gantt', 'yardim', 'ayarlar']);
const MODE_STORAGE_KEY = 'mergen_rota_mode_selected_v1';

function projectDisplayName(project) {
  if (!project) return '';
  return project.code ? `${project.code} · ${project.name}` : project.name;
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
  const { openTask } = useTaskActions();
  const simpleMode = t.appMode === 'simple';

  const [view, setView] = useState(() => {
    const landing = TWEAK_DEFAULTS.landingView || 'ozet';
    return NAV_ITEMS.some((item) => item.id === landing) ? landing : 'ozet';
  });
  const [simpleCalendarTab, setSimpleCalendarTab] = useState('calendar');
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
      setView('takvim');
    }
  };

  useEffect(() => {
    if (!simpleMode) return;
    if (workspaceMode !== 'portfolio') selectWorkspace(null);
    if (!SIMPLE_NAV_IDS.has(view)) setView('takvim');
  }, [simpleMode, view, workspaceMode, selectWorkspace]);

  useEffect(() => {
    if (simpleMode && view === 'takvim') setSimpleCalendarTab('calendar');
  }, [simpleMode, view]);

  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCmdOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    ayarlar: null
  }), [tasks.length, wbs.length, projects.length, people.length, workspaceMode]);

  const visibleNavItems = simpleMode
    ? NAV_ITEMS.filter((item) => SIMPLE_NAV_IDS.has(item.id))
    : NAV_ITEMS;

  const renderView = () => {
    switch (view) {
      case 'ozet': return <DashboardView onNavigate={setView} />;
      case 'veri': return <TasksView />;
      case 'wbs': return <ProjectWorkspaceView />;
      case 'takvim': return simpleMode ? (
        <div className="simple-calendar-workspace">
          <div className="simple-calendar-tabs seg" role="tablist" aria-label="Basit Mod Takvim görünümü">
            <button
              type="button"
              role="tab"
              aria-selected={simpleCalendarTab === 'calendar'}
              className={simpleCalendarTab === 'calendar' ? 'active' : ''}
              onClick={() => setSimpleCalendarTab('calendar')}
            >
              <Icons.Calendar size={13} /> Takvim
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={simpleCalendarTab === 'entry'}
              className={simpleCalendarTab === 'entry' ? 'active' : ''}
              onClick={() => setSimpleCalendarTab('entry')}
            >
              <Icons.Plus size={13} /> Hızlı Görev Tanımı
            </button>
          </div>
          <div className="simple-calendar-tab-panel" role="tabpanel">
            {simpleCalendarTab === 'calendar'
              ? <CalendarView t={t} setTweak={setTweak} />
              : <SimpleModePanel />}
          </div>
        </div>
      ) : <CalendarView t={t} setTweak={setTweak} />;
      case 'gantt': return <WorkspaceGanttView />;
      case 'kanban': return <KanbanView />;
      case 'rapor': return <ReportsView />;
      case 'kisi': return <TeamView />;
      case 'yardim': return <HelpView />;
      case 'ayarlar': return <SettingsView t={t} setTweak={setTweak} />;
      default: return null;
    }
  };

  const meta = PAGE_META[view] || PAGE_META.ozet;
  const workspaceKey = `${workspaceMode}:${selectedProjectId || 'all'}:${simpleMode ? 'simple' : 'advanced'}`;
  const projectContextVisible = !simpleMode && selectedProject && view !== 'ayarlar' && view !== 'yardim';
  const exportVisible = !simpleMode && view !== 'ayarlar' && view !== 'yardim';

  // İlk açılış akışlarında ana uygulama hiç render edilmez. Böylece Özet üst çubuğu,
  // sidebar veya başka bir sayfa parçası karşılama/mod seçim ekranının arkasından görünmez.
  if (modePickerOpen) return <ModeChooser onChoose={chooseMode} />;

  if (welcomeOpen && !simpleMode) {
    return (
      <WelcomeScreen
        stats={stats}
        onClose={closeWelcome}
        onNavigate={setView}
        showAgain={!hideWelcome}
        onShowAgainChange={(show) => setHideWelcome(!show)}
      />
    );
  }

  return (
    <div className={`app app-mode-${simpleMode ? 'simple' : 'advanced'}`}>
      {/* Kişi dizini bağlamı DOM düğümü üretmez: ızgara çocukları değişmez. */}
      <PeopleDirectoryProvider people={directoryPeople}>
      <aside className="sidebar">
        <Heptagon variant="hept-sidebar" />
        <div className="sidebar-header">
          <AppLogo size={34} />
          <div className="col" style={{ gap: 0 }}>
            <div className="brand-name"><span>MERGEN</span><span className="brand-accent">Rota</span><span className="brand-dot" /></div>
            <div className="brand-sub">Proje Yönetimi</div>
          </div>
        </div>

        {!simpleMode ? (
          <div className="col" style={{ gap: 6, padding: '0 12px 10px' }}>
            <div className="sidebar-section-title" style={{ margin: 0 }}>Aktif çalışma alanı</div>
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
            <span><Icons.Calendar size={13} /> Basit Mod</span>
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

        <div className="sidebar-section-title">Çalışma alanı</div>
        <nav className="nav">
          {visibleNavItems.map((item) => {
            const Icon = Icons[item.icon];
            return (
              <button
                key={item.id}
                className={`nav-item${view === item.id ? ' active' : ''}`}
                onClick={() => {
                  if (simpleMode && item.id === 'takvim') setSimpleCalendarTab('calendar');
                  setView(item.id);
                }}
              >
                <Icon className="nav-icon" size={15} />
                <span>{item.label}</span>
                {totalsByView[item.id] != null && <span className="nav-count">{totalsByView[item.id]}</span>}
              </button>
            );
          })}
        </nav>

        {/* Veri modu anahtarı kenar çubuğunda değil, Ayarlar sayfasında yaşar.
            Kullanıcı bloğu artık sabit örnek kişi değil, doğrulanmış oturumdur. */}
        <div className="sidebar-footer">
          <SidebarUserPanel
            theme={t.theme}
            onToggleTheme={() => setTweak('theme', t.theme === 'light' ? 'dark' : 'light')}
          />
          <div className="sidebar-version">MERGEN Rota · Sürüm 1.0 · {simpleMode ? 'Basit' : 'Gelişmiş'} Mod</div>
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
            {exportVisible && (
              <ProjectExportMenu
                project={selectedProject}
                projects={projects}
                tasks={tasks}
                wbs={wbs}
              />
            )}
            {view === 'veri' && (
              <InfoButton title="Görevler" icon={<Icons.Table size={12} />}>
                <p>Görevleri listele, filtrele ve düzenle. Proje çalışma alanında liste seçili proje ile otomatik olarak sınırlandırılır.</p>
              </InfoButton>
            )}
          </div>
        </header>
        <main key={workspaceKey} className={`content content-${view}`}>{renderView()}</main>
      </div>

      <TaskDetailOverlay />
      {cmdOpen && !simpleMode && (
        <CommandPalette
          onClose={() => setCmdOpen(false)}
          onNavigate={setView}
          onOpenTask={openTask}
          onSetTheme={(theme) => setTweak('theme', theme)}
          tasks={tasks}
        />
      )}
      </PeopleDirectoryProvider>
    </div>
  );
}
