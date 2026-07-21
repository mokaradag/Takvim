'use client';
import { useEffect, useMemo, useState } from 'react';
import { Icons } from '../icons';
import { Avatar, Heptagon } from '../ui';
import { InfoButton } from '../ui-extras';
import { DashboardView } from '../../features/dashboard/DashboardView';
import { TasksView } from '../../features/tasks/TasksView';
import { CalendarView } from '../../features/calendar/CalendarView';
import { GanttView } from '../../features/gantt/GanttView';
import { KanbanView } from '../../features/kanban/KanbanView';
import { ReportsView } from '../../features/reports/ReportsView';
import { TeamView } from '../../features/team/TeamView';
import { SettingsView } from '../../features/settings/SettingsView';
import { TaskDetailOverlay } from '../../features/task-detail/TaskDetailOverlay';
import { usePeople, useTaskActions, useTasks, useTaskStats } from '../../state/hooks';
import { useTweaks } from '../../hooks/useTweaks';
import { useApplyTweaks } from '../../hooks/useApplyTweaks';
import { TWEAK_DEFAULTS } from '../../lib/tweaks-defaults';
import { AppLogo } from './AppLogo';
import { CommandPalette } from './CommandPalette';
import { NAV_ITEMS, PAGE_META } from './navigation';
import { WelcomeScreen } from './WelcomeScreen';

export default function AppShell() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  useApplyTweaks(t);
  const tasks = useTasks();
  const people = usePeople();
  const stats = useTaskStats();
  const { openTask } = useTaskActions();

  const [view, setView] = useState(() => {
    const landing = TWEAK_DEFAULTS.landingView || 'ozet';
    return NAV_ITEMS.some((item) => item.id === landing) ? landing : 'ozet';
  });
  const [cmdOpen, setCmdOpen] = useState(false);
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

  const totalsByView = useMemo(() => ({
    ozet: tasks.length,
    veri: tasks.length,
    takvim: null,
    gantt: tasks.length,
    kanban: tasks.length,
    rapor: null,
    kisi: people.length,
    ayarlar: null
  }), [tasks.length, people.length]);

  const renderView = () => {
    switch (view) {
      case 'ozet': return <DashboardView onNavigate={setView} />;
      case 'veri': return <TasksView />;
      case 'takvim': return <CalendarView t={t} setTweak={setTweak} />;
      case 'gantt': return <GanttView />;
      case 'kanban': return <KanbanView />;
      case 'rapor': return <ReportsView />;
      case 'kisi': return <TeamView />;
      case 'ayarlar': return <SettingsView t={t} setTweak={setTweak} />;
      default: return null;
    }
  };

  const meta = PAGE_META[view] || PAGE_META.ozet;

  return (
    <div className="app">
      <aside className="sidebar">
        <Heptagon variant="hept-sidebar" />
        <div className="sidebar-header">
          <AppLogo size={34} />
          <div className="col" style={{ gap: 0 }}>
            <div className="brand-name"><span>MERGEN</span><span className="brand-accent">Rota</span><span className="brand-dot" /></div>
            <div className="brand-sub">Proje Yönetimi</div>
          </div>
        </div>
        <button className="cmd-trigger" onClick={() => setCmdOpen(true)}>
          <Icons.Search size={13} />
          <span>Ara veya komut çalıştır...</span>
          <span className="kbd">Ctrl K</span>
        </button>

        <div className="sidebar-section-title">Çalışma alanı</div>
        <nav className="nav">
          {NAV_ITEMS.map((item) => {
            const Icon = Icons[item.icon];
            return (
              <button key={item.id} className={`nav-item${view === item.id ? ' active' : ''}`} onClick={() => setView(item.id)}>
                <Icon className="nav-icon" size={15} />
                <span>{item.label}</span>
                {totalsByView[item.id] != null && <span className="nav-count">{totalsByView[item.id]}</span>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="user-chip">
            <Avatar name="Zeynep Aydın" size="md" />
            <div className="col" style={{ gap: 0, flex: 1, minWidth: 0 }}>
              <div className="name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Zeynep Aydın</div>
              <div className="role">Product Manager</div>
            </div>
          </div>
          <button className="icon-btn" onClick={() => setWelcomeOpen(true)} title="Yardım ve özet"><Icons.Help size={15} /></button>
          <button className="icon-btn" onClick={() => setTweak('theme', t.theme === 'light' ? 'dark' : 'light')} title="Tema">
            {t.theme === 'light' ? <Icons.Moon size={15} /> : <Icons.Sun size={15} />}
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <Heptagon variant="hept-topbar" />
          <div className="col" style={{ gap: 2 }}>
            <h1 className="hero-title">{meta.title}</h1>
            <div className="sub">{meta.sub}</div>
          </div>
          <div className="topbar-spacer" />
          {view === 'veri' && (
            <InfoButton title="Görevler" icon={<Icons.Table size={12} />}>
              <p>Tüm görevleri listele, filtrele ve düzenle. Sütun başlığına tıklayarak o sütuna özel sıralama ve filtre uygulayabilirsiniz.</p>
            </InfoButton>
          )}
        </header>
        <main className="content">{renderView()}</main>
      </div>

      <TaskDetailOverlay />
      {cmdOpen && (
        <CommandPalette
          onClose={() => setCmdOpen(false)}
          onNavigate={setView}
          onOpenTask={openTask}
          onSetTheme={(theme) => setTweak('theme', theme)}
          tasks={tasks}
        />
      )}
      {welcomeOpen && (
        <WelcomeScreen
          stats={stats}
          onClose={closeWelcome}
          onNavigate={setView}
          showAgain={!hideWelcome}
          onShowAgainChange={(show) => setHideWelcome(!show)}
        />
      )}
    </div>
  );
}
