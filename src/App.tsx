/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  format, 
  addMonths, 
  subMonths, 
  startOfWeek, 
  endOfWeek, 
  eachDayOfInterval, 
  startOfMonth, 
  endOfMonth, 
  isSameMonth, 
  isSameDay, 
  parseISO,
  isToday,
  isWeekend,
  differenceInDays,
  differenceInCalendarDays,
  isValid,
  min,
  max,
  addDays,
  subDays
} from 'date-fns';
import { tr } from 'date-fns/locale';
import { 
  Calendar as CalendarIcon, 
  ListTodo, 
  Users, 
  Plus, 
  Trash2, 
  ChevronLeft, 
  ChevronRight,
  ChevronDown, Filter, ChevronUp,
  GanttChart,
  Edit2,
  Check,
  X,
  Sun,
  Moon,
  Search,
  Flag,
  Clock,
  AlignLeft,
  CircleDot,
  Type,
  Kanban,
  Command,
  LayoutDashboard,
  TrendingUp,
  CheckCircle2,
  AlertCircle,
  Briefcase,
  FileText, Plus, Trash2,
  PieChart as PieChartIcon, BarChart2,
  ArrowUpRight, ArrowDownRight,
  Target, Link2
} from 'lucide-react';
import { motion, AnimatePresence, useMotionValue, useTransform, animate } from 'motion/react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, Cell, PieChart, Pie, Legend, AreaChart, Area, CartesianGrid, LineChart, Line } from 'recharts';

type Subtask = {
  id: string;
  title: string;
  completed: boolean;
};

type Task = {
  id: string;
  proje: string;
  task: string;
  keyword: string;
  sorumlu: string[];
  status?: 'todo' | 'in_progress' | 'done';
  hedefTarih: string; // YYYY-MM-DD
  baslangicTarihi: string; // YYYY-MM-DD
  bitisTarihi: string; // YYYY-MM-DD
  themeColor?: 'blue' | 'emerald' | 'purple' | 'amber' | 'rose' | 'cyan';
  description?: string;
  subtasks?: Subtask[];
  dependencies?: { id: string, type: 'FS' | 'FF' | 'SS' | 'SF' }[];
};

const initialSorumlular = ['Ahmet Yılmaz', 'Mehmet Demir', 'Ayşe Kaya', 'Elif Yıldız', 'Can Özkan'];

const initialTasks: Task[] = [
  { id: '1', proje: 'Web Sitesi Yenileme', task: 'UI/UX tasarımının tamamlanması ve onay sürecinin bitirilmesi', keyword: 'Tasarım', sorumlu: ['Ahmet Yılmaz'], hedefTarih: '2026-04-15', baslangicTarihi: '2026-04-01', bitisTarihi: '2026-04-10', status: 'done' },
  { id: '2', proje: 'Web Sitesi Yenileme', task: 'Tasarımın React ve Tailwind ile frontend kodlamasının yapılması', keyword: 'Frontend', sorumlu: ['Ayşe Kaya'], hedefTarih: '2026-04-20', baslangicTarihi: '2026-04-11', bitisTarihi: '2026-04-18', dependencies: [{ id: '1', type: 'FS' }], status: 'in_progress' },
  { id: '3', proje: 'Mobil Uygulama', task: 'Kullanıcı giriş ve kayıt API uçlarının Node.js ile yazılması', keyword: 'Auth API', sorumlu: ['Mehmet Demir'], hedefTarih: '2026-04-28', baslangicTarihi: '2026-04-10', bitisTarihi: '2026-04-20', status: 'done' },
  { id: '4', proje: 'Mobil Uygulama', task: 'Yazılan API uçları için entegrasyon testlerinin tamamlanması', keyword: 'Test', sorumlu: ['Elif Yıldız', 'Mehmet Demir'], hedefTarih: '2026-05-02', baslangicTarihi: '2026-04-21', bitisTarihi: '2026-04-25', dependencies: [{ id: '3', type: 'FS' }], status: 'todo' },
  { id: '5', proje: 'Sosyal Medya', task: 'Haziran ayı kampanya görsellerinin hazırlanması', keyword: 'Görseller', sorumlu: ['Ahmet Yılmaz'], hedefTarih: '2026-05-05', baslangicTarihi: '2026-04-25', bitisTarihi: '2026-05-02' },
  { id: '6', proje: 'Veritabanı', task: 'Mevcut kullanıcı veritabanının yeni sunucuya taşınması', keyword: 'DB Göçü', sorumlu: ['Mehmet Demir', 'Can Özkan'], hedefTarih: '2026-04-30', baslangicTarihi: '2026-04-20', bitisTarihi: '2026-04-28' },
  { id: '7', proje: 'Altyapı', task: 'Sunucu işletim sistemi ve paket güncellemelerinin yapılması', keyword: 'Sunucu', sorumlu: ['Can Özkan'], hedefTarih: '2026-04-30', baslangicTarihi: '2026-04-28', bitisTarihi: '2026-04-29', dependencies: [{ id: '6', type: 'FS' }] },
];

const getKeywordColor = (keyword: string, theme: 'light' | 'dark' = 'dark', themeColor?: 'blue' | 'emerald' | 'purple' | 'amber' | 'rose' | 'cyan') => {
  const colorMap = {
    blue: 0,
    emerald: 1,
    purple: 2,
    amber: 3,
    rose: 4,
    cyan: 5
  };

  const lightColors = [
    { badge: 'bg-blue-100 text-blue-700 border border-blue-200', bar: 'bg-blue-500 text-white shadow-sm', dot: 'bg-blue-500' },
    { badge: 'bg-emerald-100 text-emerald-700 border border-emerald-200', bar: 'bg-emerald-500 text-white shadow-sm', dot: 'bg-emerald-500' },
    { badge: 'bg-purple-100 text-purple-700 border border-purple-200', bar: 'bg-purple-500 text-white shadow-sm', dot: 'bg-purple-500' },
    { badge: 'bg-amber-100 text-amber-700 border border-amber-200', bar: 'bg-amber-500 text-white shadow-sm', dot: 'bg-amber-500' },
    { badge: 'bg-rose-100 text-rose-700 border border-rose-200', bar: 'bg-rose-500 text-white shadow-sm', dot: 'bg-rose-500' },
    { badge: 'bg-cyan-100 text-cyan-700 border border-cyan-200', bar: 'bg-cyan-500 text-white shadow-sm', dot: 'bg-cyan-500' },
  ];
  
  const darkColors = [
    { badge: 'bg-blue-500/20 text-blue-300 border border-blue-500/30', bar: 'bg-blue-500 text-white', dot: 'bg-blue-400' },
    { badge: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30', bar: 'bg-emerald-500 text-white', dot: 'bg-emerald-400' },
    { badge: 'bg-purple-500/20 text-purple-300 border border-purple-500/30', bar: 'bg-purple-500 text-white', dot: 'bg-purple-400' },
    { badge: 'bg-amber-500/20 text-amber-300 border border-amber-500/30', bar: 'bg-amber-500 text-white', dot: 'bg-amber-400' },
    { badge: 'bg-rose-500/20 text-rose-300 border border-rose-500/30', bar: 'bg-rose-500 text-white', dot: 'bg-rose-400' },
    { badge: 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30', bar: 'bg-cyan-500 text-white', dot: 'bg-cyan-400' },
  ];
  
  const colors = theme === 'light' ? lightColors : darkColors;
  if (themeColor && colorMap[themeColor] !== undefined) {
    return colors[colorMap[themeColor]];
  }
  return colors[keyword.length % colors.length];
};

function AnimatedNumber({ value }: { value: number }) {
  const count = useMotionValue(0);
  const rounded = useTransform(count, Math.round);

  React.useEffect(() => {
    const animation = animate(count, value, { duration: 1.5, type: 'spring', bounce: 0 });
    return animation.stop;
  }, [value, count]);

  return <motion.span>{rounded}</motion.span>;
}

const CustomPieTooltip = ({ active, payload, total }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0];
    const _percent = data.payload?.percent ?? data.percent;
    const percent = total > 0 ? ((data.value / total) * 100).toFixed(1) : (_percent ? (_percent * 100).toFixed(1) : '0');
    return (
      <div 
        className="bg-gray-900 border border-gray-700/50 rounded-lg p-3 shadow-xl backdrop-blur-md text-left z-50 pointer-events-none"
      >
        <div className="flex items-center gap-2 mb-2">
           <span className="w-3 h-3 rounded-full shadow-sm" style={{ backgroundColor: data.payload?.fill || data.color }}></span>
           <span className="font-semibold text-gray-100">{data.name}</span>
        </div>
        <div className="flex justify-between items-center gap-6 pl-5">
           <span className="text-gray-400 text-sm font-medium">{data.value} görev</span>
           <span className="font-bold text-gray-100 text-sm tracking-tight">%{percent}</span>
        </div>
      </div>
    );
  }
  return null;
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'ozet' | 'kisi' | 'veri' | 'takvim' | 'gantt' | 'kanban' | 'rapor'>('ozet');
  const [ganttGroupBy, setGanttGroupBy] = useState<'proje' | 'sorumlu'>('proje');
  const [isGanttExpanded, setIsGanttExpanded] = useState(false);
  const [showDependencyLines, setShowDependencyLines] = useState(true);
  const [dependencyLines, setDependencyLines] = useState<{x1:number, y1:number, x2:number, y2:number, type: string, color: string}[]>([]);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('macroplan-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return 'dark'; // Dark theme as default
  });
  const isLight = theme === 'light';

  const [fontSizeScale, setFontSizeScale] = useState<number>(() => {
    const saved = localStorage.getItem('macroplan-font-size');
    return saved ? parseInt(saved, 10) : 16;
  });

  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [commandMenuQuery, setCommandMenuQuery] = useState('');
  const commandInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowCommandMenu(true);
      }
      if (e.key === 'Escape') {
        setShowCommandMenu(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (showCommandMenu && commandInputRef.current) {
      setTimeout(() => commandInputRef.current?.focus(), 50);
    }
  }, [showCommandMenu]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'light') {
      root.classList.add('light');
    } else {
      root.classList.remove('light');
    }
    localStorage.setItem('macroplan-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSizeScale}px`;
    localStorage.setItem('macroplan-font-size', fontSizeScale.toString());
  }, [fontSizeScale]);
  
  const cycleFontSize = () => {
    setFontSizeScale(prev => {
      if (prev === 14) return 16;
      if (prev === 16) return 18;
      return 14;
    });
  };
  
  const [showSummary, setShowSummary] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>({ key: 'baslangicTarihi', direction: 'asc' });
  const [columnFilters, setColumnFilters] = useState<Record<string, string[]>>({});
  const [activeFilterPopover, setActiveFilterPopover] = useState<string | null>(null);
  
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [detailedTask, setDetailedTask] = useState<Task | null>(null);
  const [customGanttRange, setCustomGanttRange] = useState<{start: string, end: string} | null>(null);
  const [tooltipConfig, setTooltipConfig] = useState<{
    show: boolean;
    task: Task | null;
    type?: 'task' | 'summary';
    summaryData?: { title: string, value: string, desc: string, icon: React.ReactNode, colorClass: string };
    x: number;
    y: number;
  }>({show: false, task: null, x: 0, y: 0});

  const appContainerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.08, delayChildren: 0.1 }
    }
  };

  const statuses = [
    { id: 'todo', title: 'Yapılacaklar', icon: <CircleDot size={18} />, color: isLight ? 'bg-amber-50/50' : 'bg-orange-950/20', borderTarget: isLight ? 'border-amber-200' : 'border-orange-900/50', textColor: isLight ? 'text-amber-700' : 'text-orange-400', badgeTheme: isLight ? 'bg-amber-100 text-amber-700' : 'bg-orange-900/40 text-orange-300' },
    { id: 'in_progress', title: 'Devam Edenler', icon: <Clock size={18} />, color: isLight ? 'bg-blue-50/50' : 'bg-blue-950/20', borderTarget: isLight ? 'border-blue-200' : 'border-blue-900/50', textColor: isLight ? 'text-blue-700' : 'text-blue-400', badgeTheme: isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-900/50 text-blue-300' },
    { id: 'done', title: 'Tamamlananlar', icon: <CheckCircle2 size={18} />, color: isLight ? 'bg-emerald-50/50' : 'bg-emerald-950/20', borderTarget: isLight ? 'border-emerald-200' : 'border-emerald-900/50', textColor: isLight ? 'text-emerald-700' : 'text-emerald-400', badgeTheme: isLight ? 'bg-emerald-100 text-emerald-700' : 'bg-emerald-900/40 text-emerald-300' }
  ];

  const appItemVariants = {
    hidden: { opacity: 0, y: 30, scale: 0.98 },
    visible: { 
      opacity: 1, y: 0, scale: 1,
      transition: { type: "spring", stiffness: 400, damping: 25 }
    }
  };

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const isDragging = React.useRef(false);
  const startX = React.useRef(0);
  const scrollLeft = React.useRef(0);

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!scrollRef.current) return;
    isDragging.current = true;
    scrollRef.current.classList.add('cursor-grabbing');
    scrollRef.current.classList.remove('cursor-grab');
    startX.current = e.pageX - scrollRef.current.offsetLeft;
    scrollLeft.current = scrollRef.current.scrollLeft;
  };

  const handleMouseLeave = () => {
    isDragging.current = false;
    if (scrollRef.current) {
      scrollRef.current.classList.add('cursor-grab');
      scrollRef.current.classList.remove('cursor-grabbing');
    }
  };

  const handleMouseUp = () => {
    isDragging.current = false;
    if (scrollRef.current) {
      scrollRef.current.classList.add('cursor-grab');
      scrollRef.current.classList.remove('cursor-grabbing');
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging.current || !scrollRef.current) return;
    e.preventDefault();
    setTooltipConfig(prev => ({...prev, show: false}));
    const x = e.pageX - scrollRef.current.offsetLeft;
    const walk = (x - startX.current) * 1.5;
    scrollRef.current.scrollLeft = scrollLeft.current - walk;
  };

  const toggleGroup = (groupName: string) => {
    setCollapsedGroups(prev => ({
      ...prev,
      [groupName]: !prev[groupName]
    }));
  };
  
  const [tasks, setTasks] = useState<Task[]>(() => {
    const saved = localStorage.getItem('macroplan-tasks');
    if (saved) {
      const parsed = JSON.parse(saved);
      return parsed.map((t: any) => ({
        ...t,
        sorumlu: Array.isArray(t.sorumlu) ? t.sorumlu : (t.sorumlu ? [t.sorumlu] : []),
        hedefTarih: t.hedefTarih || t.tarih || format(new Date(), 'yyyy-MM-dd'),
        baslangicTarihi: t.baslangicTarihi || t.tarih || format(new Date(), 'yyyy-MM-dd'),
        bitisTarihi: t.bitisTarihi || t.tarih || format(addDays(new Date(), 7), 'yyyy-MM-dd')
      }));
    }
    return initialTasks;
  });

  const [sorumlular, setSorumlular] = useState<string[]>(() => {
    const saved = localStorage.getItem('macroplan-sorumlular');
    if (saved) return JSON.parse(saved);
    return initialSorumlular;
  });

  useEffect(() => {
    localStorage.setItem('macroplan-tasks', JSON.stringify(tasks));
  }, [tasks]);

  useEffect(() => {
    localStorage.setItem('macroplan-sorumlular', JSON.stringify(sorumlular));
  }, [sorumlular]);
  
  useEffect(() => {
    if (!showDependencyLines) {
      setDependencyLines([]);
      return;
    }
    const updateLines = () => {
      const wrapper = document.getElementById('gantt-content-wrapper');
      if (!wrapper) return;
      const wrapperRect = wrapper.getBoundingClientRect();
      const newLines: typeof dependencyLines = [];

      tasks.forEach(task => {
        const el = document.getElementById(`gantt-bar-${task.id}`);
        if (!el) return;
        const rect = el.getBoundingClientRect();
        
        // Relative to the scrolling content wrapper
        const xStart = rect.left - wrapperRect.left;
        const xEnd = rect.right - wrapperRect.left;
        const yCenter = rect.top - wrapperRect.top + rect.height / 2;

        task.dependencies?.forEach(dep => {
          const depEl = document.getElementById(`gantt-bar-${dep.id}`);
          if (!depEl) return;
          const depRect = depEl.getBoundingClientRect();
          const depXStart = depRect.left - wrapperRect.left;
          const depXEnd = depRect.right - wrapperRect.left;
          const depYCenter = depRect.top - wrapperRect.top + depRect.height / 2;

          let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
          if (dep.type === 'FS') {
            x1 = depXEnd; y1 = depYCenter;
            x2 = xStart;  y2 = yCenter;
          } else if (dep.type === 'SS') {
            x1 = depXStart; y1 = depYCenter;
            x2 = xStart; y2 = yCenter;
          } else if (dep.type === 'FF') {
            x1 = depXEnd; y1 = depYCenter;
            x2 = xEnd; y2 = yCenter;
          } else if (dep.type === 'SF') {
            x1 = depXStart; y1 = depYCenter;
            x2 = xEnd; y2 = yCenter;
          }
          newLines.push({ x1, y1, x2, y2, type: dep.type, color: 'rgba(217, 119, 6, 0.6)' }); // amber-600
        });
      });
      setDependencyLines(newLines);
    };

    // Delay slightly to ensure DOM is updated after collapse/expand
    const timer = setTimeout(updateLines, 50);
    return () => clearTimeout(timer);
  }, [tasks, showDependencyLines, isGanttExpanded, ganttGroupBy, collapsedGroups, activeTab]); // needs updating when layout changes

  
  const [currentMonth, setCurrentMonth] = useState(new Date(2026, 3, 1));

  const [newTask, setNewTask] = useState<Partial<Task>>({ 
    proje: '', 
    task: '', 
    keyword: '', 
    sorumlu: [],
    dependencies: [],
    baslangicTarihi: format(new Date(), 'yyyy-MM-dd'), 
    bitisTarihi: format(addDays(new Date(), 7), 'yyyy-MM-dd'), 
    hedefTarih: format(addDays(new Date(), 10), 'yyyy-MM-dd') 
  });
  
  const [newSorumlu, setNewSorumlu] = useState('');
  const [isSorumluDropdownOpen, setIsSorumluDropdownOpen] = useState(false);
  const [isDependencyDropdownOpen, setIsDependencyDropdownOpen] = useState(false);
  const [selectedDepType, setSelectedDepType] = useState<'FS'|'FF'|'SS'|'SF'>('FS');

  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.proje || !newTask.task || !newTask.keyword || !newTask.sorumlu || newTask.sorumlu.length === 0 || !newTask.baslangicTarihi || !newTask.bitisTarihi || !newTask.hedefTarih) {
      alert('Lütfen tüm alanları doldurun!');
      return;
    }
    setTasks([...tasks, { ...newTask, id: Date.now().toString() } as Task]);
    setNewTask({ ...newTask, task: '', keyword: '', sorumlu: [], dependencies: [] });
  };

  const handleDetailedTaskUpdate = (updates: Partial<Task>) => {
    if (!detailedTask) return;
    const updated = { ...detailedTask, ...updates };
    setDetailedTask(updated);
    setTasks(prev => prev.map(t => t.id === updated.id ? updated : t));
  };
  
  const handleAddSubtask = (title: string) => {
    if (!title.trim() || !detailedTask) return;
    const newSubtask: Subtask = { id: Math.random().toString(36).substr(2, 9), title, completed: false };
    const currentSubtasks = detailedTask.subtasks || [];
    handleDetailedTaskUpdate({ subtasks: [...currentSubtasks, newSubtask] });
  };

  const handleToggleSubtask = (subtaskId: string) => {
    if (!detailedTask) return;
    const updatedSubtasks = (detailedTask.subtasks || []).map(st => 
      st.id === subtaskId ? { ...st, completed: !st.completed } : st
    );
    handleDetailedTaskUpdate({ subtasks: updatedSubtasks });
  };
  
  const handleRemoveSubtask = (subtaskId: string) => {
    if (!detailedTask) return;
    const updatedSubtasks = (detailedTask.subtasks || []).filter(st => st.id !== subtaskId);
    handleDetailedTaskUpdate({ subtasks: updatedSubtasks });
  };

  const handleDeleteTask = (id: string) => {
    setTasks(tasks.filter(t => t.id !== id));
  };

  const handleAddSorumlu = (e: React.FormEvent) => {
    e.preventDefault();
    if (newSorumlu.trim() && !sorumlular.includes(newSorumlu.trim())) {
      setSorumlular([...sorumlular, newSorumlu.trim()]);
      setNewSorumlu('');
    }
  };

  const handleDeleteSorumlu = (isim: string) => {
    setSorumlular(sorumlular.filter(s => s !== isim));
    setTasks(tasks.map(t => ({ ...t, sorumlu: t.sorumlu.filter(s => s !== isim) })));
  };

  const renderOzetSheet = () => {
    // Process analytics data
    const completedTasks = tasks.filter(t => t.status === 'done').length;
    const inProgressTasks = tasks.filter(t => t.status === 'in_progress').length;
    const todoTasks = tasks.filter(t => !t.status || t.status === 'todo').length;
    const overdueTasks = tasks.filter(t => differenceInCalendarDays(parseISO(t.hedefTarih), new Date()) < 0 && t.status !== 'done').length;

    const activeTasks = tasks.filter(t => t.status === 'in_progress' || t.status === 'todo');
    const dependencyRiskTasks = activeTasks.filter(t => {
      if (!t.dependencies || t.dependencies.length === 0) return false;
      return t.dependencies.some(dep => {
        const depTask = tasks.find(tsk => tsk.id === dep.id);
        if (!depTask) return false;
        if (depTask.status !== 'done' && depTask.hedefTarih && differenceInCalendarDays(parseISO(depTask.hedefTarih), new Date()) < 0) return true;
        if (depTask.status === 'done' && depTask.bitisTarihi && t.baslangicTarihi && differenceInCalendarDays(parseISO(t.baslangicTarihi), parseISO(depTask.bitisTarihi)) < 0) return true;
        return false;
      });
    });
    const dependencyRiskCount = dependencyRiskTasks.length;
    
    // Project distribution
    const projectCount: Record<string, number> = {};
    tasks.forEach(t => { projectCount[t.proje] = (projectCount[t.proje] || 0) + 1; });
    const projectChartData = Object.keys(projectCount).map(k => ({ name: k, value: projectCount[k] })).sort((a,b) => b.value - a.value).slice(0, 6);

    // Status distributions
    const statusData = [
      { name: 'Yapılacaklar', value: todoTasks, color: theme === 'light' ? '#64748b' : '#94a3b8' },
      { name: 'Devam Edenler', value: inProgressTasks, color: theme === 'light' ? '#4f46e5' : '#818cf8' },
      { name: 'Tamamlananlar', value: completedTasks, color: theme === 'light' ? '#059669' : '#34d399' }
    ];

    // Priority Distribution
    const priorityData = [
      { name: 'Kritik (< 0 Gün)', value: overdueTasks, color: '#ef4444' },
      { name: 'Yüksek (0-3 Gün)', value: tasks.filter(t => t.status !== 'done' && differenceInCalendarDays(parseISO(t.hedefTarih), new Date()) >= 0 && differenceInCalendarDays(parseISO(t.hedefTarih), new Date()) <= 3).length, color: '#f59e0b' },
      { name: 'Normal (> 3 Gün)', value: tasks.filter(t => t.status !== 'done' && differenceInCalendarDays(parseISO(t.hedefTarih), new Date()) > 3).length, color: '#3b82f6' }
    ];
    
    // Calculate Average Cycle Time based on task start vs end dates
    const completedTasksList = tasks.filter(t => t.status === 'done');
    const avgCycleDays = completedTasksList.length > 0 
      ? Math.round(completedTasksList.reduce((acc, t) => acc + Math.abs(differenceInCalendarDays(parseISO(t.bitisTarihi), parseISO(t.baslangicTarihi))), 0) / completedTasksList.length) 
      : 0;

    // Person workload
    const personCount: Record<string, number> = {};
    tasks.forEach(t => {
      if (t.sorumlu && t.sorumlu.length > 0) {
        t.sorumlu.forEach(s => { personCount[s] = (personCount[s] || 0) + 1; });
      } else {
        personCount['Atanmamış'] = (personCount['Atanmamış'] || 0) + 1;
      }
    });
    const workloadData = Object.keys(personCount).map(p => ({
      name: p,
      Görevler: personCount[p]
    })).sort((a,b) => b.Görevler - a.Görevler).slice(0, 5);

    const upcomingTasks = tasks
      .filter(t => t.status !== 'done' && differenceInCalendarDays(parseISO(t.hedefTarih), new Date()) >= 0)
      .sort((a,b) => parseISO(a.hedefTarih).getTime() - parseISO(b.hedefTarih).getTime())
      .slice(0, 5);

    const totalSubtasks = tasks.reduce((sum, t) => sum + (t.subtasks?.length || 0), 0);
    const completedSubtasks = tasks.reduce((sum, t) => sum + (t.subtasks?.filter(st => st.completed).length || 0), 0);

    // Team Leaderboard
    const personStatsMap: Record<string, { total: number, done: number, inProgress: number, avatarColor: string }> = {};
    const AVATAR_COLORS = ['bg-blue-500', 'bg-emerald-500', 'bg-purple-500', 'bg-rose-500', 'bg-amber-500', 'bg-cyan-500'];
    tasks.forEach(t => {
      t.sorumlu.forEach(s => {
        if (!personStatsMap[s]) {
          const colorKey = Array.from(s).reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length;
          personStatsMap[s] = { total: 0, done: 0, inProgress: 0, avatarColor: AVATAR_COLORS[colorKey] };
        }
        personStatsMap[s].total++;
        if (t.status === 'done') personStatsMap[s].done++;
        if (t.status === 'in_progress') personStatsMap[s].inProgress++;
      });
    });
    
    const leaderboardData = Object.keys(personStatsMap).map(person => ({
      name: person,
      ...personStatsMap[person],
      score: (personStatsMap[person].done * 10) + (personStatsMap[person].inProgress * 2)
    })).sort((a,b) => b.score - a.score).slice(0, 5);

    const containerVariants = {
      hidden: { opacity: 0 },
      visible: {
        opacity: 1,
        transition: {
          staggerChildren: 0.08,
          delayChildren: 0.1
        }
      }
    };

    const itemVariants = {
      hidden: { opacity: 0, y: 30, scale: 0.98 },
      visible: { 
        opacity: 1, 
        y: 0, 
        scale: 1,
        transition: { 
          type: "spring", 
          stiffness: 400, 
          damping: 30 
        } 
      }
    };

    return (
      <motion.div 
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        className="max-w-6xl mx-auto flex flex-col gap-8 pb-12"
      >
        {/* Header Section */}
        <motion.div variants={itemVariants} className="flex flex-col gap-2">
          <h2 className="text-3xl font-extrabold tracking-tight text-gray-100 flex items-center gap-3">
            Hoş Geldiniz <motion.span animate={{ rotate: [0, 14, -8, 14, -4, 10, 0] }} transition={{ duration: 1.5, repeat: Infinity, repeatDelay: 1 }} className="inline-block" style={{ transformOrigin: "70% 70%" }}>👋</motion.span>
          </h2>
          <p className="text-gray-400">Genel bakış, analitikler ve güncel durum.</p>
        </motion.div>

        {/* Intelligence Card */}
        <motion.div variants={itemVariants} whileHover={{ scale: 1.01 }} className={`relative overflow-hidden p-6 rounded-2xl shadow-md border transition-all duration-300 ${theme === 'light' ? 'border-indigo-200 bg-indigo-50 border-t-4 border-t-indigo-400' : 'border-indigo-500/30 bg-indigo-500/10'}`}>
          <div className={`absolute top-0 right-0 w-64 h-64 -mr-16 -mt-16 rounded-full opacity-[0.05] pointer-events-none blur-3xl ${theme === 'light' ? 'bg-indigo-600' : 'bg-indigo-400'}`}></div>
          <div className="flex gap-4 items-start relative z-10">
             <div className={`p-3 rounded-xl shadow-inner border ${theme === 'light' ? 'bg-white text-indigo-600 border-indigo-100 shadow-sm' : 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30'}`}>
                <Briefcase size={28} className="stroke-[2.5]" />
             </div>
             <div className="flex flex-col gap-1">
               <h3 className={`text-lg font-bold ${theme === 'light' ? 'text-indigo-900' : 'text-gray-100'}`}>Genel Durum ve İş Yükü Özeti</h3>
               <p className={`text-sm leading-relaxed font-medium ${theme === 'light' ? 'text-indigo-900/80' : 'text-gray-300'}`}>
                 Bugün itibarıyla sistemde toplam <span className={`font-bold ${theme === 'light' ? 'text-indigo-600' : 'text-indigo-400'}`}><AnimatedNumber value={tasks.length} /></span> aktif göreviniz bulunuyor. 
                 Bunlardan <span className={`font-bold ${theme === 'light' ? 'text-emerald-600' : 'text-emerald-400'}`}><AnimatedNumber value={completedTasks} /></span> tanesi tamamlandı. 
                 Sırada bekleyen <span className={`font-bold ${theme === 'light' ? 'text-amber-600' : 'text-amber-400'}`}><AnimatedNumber value={todoTasks} /></span> göreviniz var ve maalesef geciken <span className={`font-bold ${theme === 'light' ? 'text-rose-600' : 'text-rose-400'}`}><AnimatedNumber value={overdueTasks} /></span> göreviniz bulunuyor. 
                 Geciken görevlerinize öncelik vermenizi öneririz.
                 {dependencyRiskCount > 0 && <span className={`mt-1 block ${theme === 'light' ? 'text-amber-700' : 'text-amber-400'}`}>Ayrıca bağımlı olduğu görevlerde sorun olması sebebiyle blokaj riski taşıyan <strong>{dependencyRiskCount}</strong> adet görev tespit edildi.</span>}
               </p>
             </div>
          </div>
        </motion.div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4 md:gap-6">
          <motion.div variants={itemVariants} whileHover={{ y: -4 }} className="relative overflow-hidden p-6 rounded-2xl shadow-sm flex flex-col gap-4 border transition-all duration-300 bg-gray-900 border-gray-800 hover:border-gray-700 hover:shadow-md cursor-help"
            onMouseEnter={(e) => setTooltipConfig({ show: true, type: 'summary', task: null, summaryData: { title: 'Toplam Görev', value: tasks.length.toString(), desc: 'Planlanan tüm süreçler', icon: <Briefcase size={22} className="stroke-[2.5]" />, colorClass: theme === 'light' ? 'bg-gradient-to-br from-gray-200 to-gray-300 text-gray-800' : 'bg-gradient-to-br from-gray-700 to-gray-800 text-gray-300' }, x: e.clientX, y: e.clientY })}
            onMouseMove={(e) => setTooltipConfig(prev => ({...prev, x: e.clientX, y: e.clientY}))}
            onMouseLeave={() => setTooltipConfig(prev => ({show: false, type: undefined, task: null, summaryData: undefined, x: 0, y: 0}))}
          >
            <div className="absolute top-0 right-0 w-32 h-32 -mr-8 -mt-8 rounded-full opacity-[0.03] pointer-events-none bg-gray-100"></div>
            <div className="flex items-center justify-between relative z-10">
              <span className="font-semibold text-sm tracking-wide text-gray-400">Toplam Görev</span>
              <div className="p-3 rounded-xl shadow-inner bg-gradient-to-br from-gray-800 to-gray-900 text-gray-300 border border-gray-700">
                <Briefcase size={22} className="stroke-[2.5]" />
              </div>
            </div>
            <div className="flex items-baseline gap-2 relative z-10">
              <span className="text-4xl font-black tracking-tighter text-gray-100"><AnimatedNumber value={tasks.length} /></span>
            </div>
          </motion.div>
          
          <motion.div variants={itemVariants} whileHover={{ y: -4 }} className="relative overflow-hidden p-6 rounded-2xl shadow-sm flex flex-col gap-4 border transition-all duration-300 bg-gray-900 border-gray-800 hover:border-emerald-500/50 hover:shadow-md cursor-help"
            onMouseEnter={(e) => setTooltipConfig({ show: true, type: 'summary', task: null, summaryData: { title: 'Tamamlanan', value: completedTasks.toString(), desc: 'Başarıyla biten süreçler', icon: <CheckCircle2 size={22} className="stroke-[2.5]" />, colorClass: theme === 'light' ? 'bg-gradient-to-br from-emerald-200 to-emerald-300 text-emerald-800' : 'bg-emerald-500/20 text-emerald-400' }, x: e.clientX, y: e.clientY })}
            onMouseMove={(e) => setTooltipConfig(prev => ({...prev, x: e.clientX, y: e.clientY}))}
            onMouseLeave={() => setTooltipConfig(prev => ({show: false, type: undefined, task: null, summaryData: undefined, x: 0, y: 0}))}
          >
            <div className={`absolute top-0 right-0 w-32 h-32 -mr-8 -mt-8 rounded-full opacity-[0.05] pointer-events-none ${theme === 'light' ? 'bg-emerald-600' : 'bg-emerald-400'}`}></div>
            <div className="flex items-center justify-between relative z-10">
              <span className="font-semibold text-sm tracking-wide text-gray-400">Tamamlanan</span>
              <div className={`p-3 rounded-xl shadow-inner ${theme === 'light' ? 'bg-gradient-to-br from-emerald-100 to-emerald-200 text-emerald-800 border border-emerald-200' : 'bg-gradient-to-br from-emerald-500/20 to-emerald-500/10 text-emerald-400 border border-emerald-500/30'}`}>
                <CheckCircle2 size={22} className="stroke-[2.5]" />
              </div>
            </div>
            <div className="flex items-baseline gap-3 relative z-10">
              <span className="text-4xl font-black tracking-tighter text-gray-100"><AnimatedNumber value={completedTasks} /></span>
              <span className={`text-sm font-bold px-2 py-0.5 rounded-md ${theme === 'light' ? 'bg-emerald-100 text-emerald-800' : 'bg-emerald-500/20 text-emerald-400'}`}>
                {tasks.length > 0 ? Math.round((completedTasks/tasks.length)*100) : 0}%
              </span>
            </div>
          </motion.div>

          <motion.div variants={itemVariants} whileHover={{ y: -4 }} className="relative overflow-hidden p-6 rounded-2xl shadow-sm flex flex-col gap-4 border transition-all duration-300 bg-gray-900 border-gray-800 hover:border-indigo-500/50 hover:shadow-md cursor-help"
            onMouseEnter={(e) => setTooltipConfig({ show: true, type: 'summary', task: null, summaryData: { title: 'Devam Eden', value: inProgressTasks.toString(), desc: 'Şu an aktif olan süreçler', icon: <TrendingUp size={22} className="stroke-[2.5]" />, colorClass: theme === 'light' ? 'bg-gradient-to-br from-indigo-200 to-indigo-300 text-indigo-800' : 'bg-indigo-500/20 text-indigo-400' }, x: e.clientX, y: e.clientY })}
            onMouseMove={(e) => setTooltipConfig(prev => ({...prev, x: e.clientX, y: e.clientY}))}
            onMouseLeave={() => setTooltipConfig(prev => ({show: false, type: undefined, task: null, summaryData: undefined, x: 0, y: 0}))}
          >
            <div className={`absolute top-0 right-0 w-32 h-32 -mr-8 -mt-8 rounded-full opacity-[0.05] pointer-events-none ${theme === 'light' ? 'bg-indigo-600' : 'bg-indigo-400'}`}></div>
            <div className="flex items-center justify-between relative z-10">
              <span className="font-semibold text-sm tracking-wide text-gray-400">Devam Eden</span>
              <div className={`p-3 rounded-xl shadow-inner ${theme === 'light' ? 'bg-gradient-to-br from-indigo-100 to-indigo-200 text-indigo-800 border border-indigo-200' : 'bg-gradient-to-br from-indigo-500/20 to-indigo-500/10 text-indigo-400 border border-indigo-500/30'}`}>
                <TrendingUp size={22} className="stroke-[2.5]" />
              </div>
            </div>
            <div className="flex items-baseline gap-2 relative z-10">
              <span className="text-4xl font-black tracking-tighter text-gray-100"><AnimatedNumber value={inProgressTasks} /></span>
            </div>
          </motion.div>

          <motion.div variants={itemVariants} whileHover={{ y: -4 }} className="relative overflow-hidden p-6 rounded-2xl shadow-sm flex flex-col gap-4 border transition-all duration-300 bg-gray-900 border-gray-800 hover:border-rose-500/50 hover:shadow-md cursor-help"
            onMouseEnter={(e) => setTooltipConfig({ show: true, type: 'summary', task: null, summaryData: { title: 'Geciken', value: overdueTasks.toString(), desc: 'Hedef tarihi geçen süreçler', icon: <AlertCircle size={22} className="stroke-[2.5]" />, colorClass: theme === 'light' ? 'bg-gradient-to-br from-rose-200 to-rose-300 text-rose-800' : 'bg-rose-500/20 text-rose-400' }, x: e.clientX, y: e.clientY })}
            onMouseMove={(e) => setTooltipConfig(prev => ({...prev, x: e.clientX, y: e.clientY}))}
            onMouseLeave={() => setTooltipConfig(prev => ({show: false, type: undefined, task: null, summaryData: undefined, x: 0, y: 0}))}
          >
            <div className={`absolute top-0 right-0 w-32 h-32 -mr-8 -mt-8 rounded-full opacity-[0.05] pointer-events-none ${theme === 'light' ? 'bg-rose-600' : 'bg-rose-400'}`}></div>
            <div className="flex items-center justify-between relative z-10">
              <span className="font-semibold text-sm tracking-wide text-gray-400">Geciken</span>
              <div className={`p-3 rounded-xl shadow-inner ${theme === 'light' ? 'bg-gradient-to-br from-rose-100 to-rose-200 text-rose-800 border border-rose-200' : 'bg-gradient-to-br from-rose-500/20 to-rose-500/10 text-rose-400 border border-rose-500/30'}`}>
                <AlertCircle size={22} className="stroke-[2.5]" />
              </div>
            </div>
            <div className="flex items-baseline gap-3 relative z-10">
              <span className="text-4xl font-black tracking-tighter text-gray-100"><AnimatedNumber value={overdueTasks} /></span>
              {overdueTasks > 0 && <span className={`text-sm font-bold px-2 py-0.5 rounded-md flex items-center gap-1 ${theme === 'light' ? 'bg-rose-100 text-rose-800' : 'bg-rose-500/20 text-rose-400'}`}>
                <AlertCircle size={14} className="stroke-[2.5]" />
                Risk!
              </span>}
            </div>
          </motion.div>

          {/* Subtask Stats Card */}
          <motion.div variants={itemVariants} whileHover={{ y: -4 }} className="relative overflow-hidden p-6 rounded-2xl shadow-sm flex flex-col gap-4 border transition-all duration-300 bg-gray-900 border-gray-800 hover:border-cyan-500/50 hover:shadow-md cursor-help"
            onMouseEnter={(e) => setTooltipConfig({ show: true, type: 'summary', task: null, summaryData: { title: 'Alt Görevler', value: `${completedSubtasks}/${totalSubtasks}`, desc: 'Görev detaylarında tamamlanan alt görev check-list öğeleri', icon: <FileText size={22} className="stroke-[2.5]" />, colorClass: theme === 'light' ? 'bg-gradient-to-br from-cyan-200 to-cyan-300 text-cyan-800' : 'bg-cyan-500/20 text-cyan-400' }, x: e.clientX, y: e.clientY })}
            onMouseMove={(e) => setTooltipConfig(prev => ({...prev, x: e.clientX, y: e.clientY}))}
            onMouseLeave={() => setTooltipConfig(prev => ({show: false, type: undefined, task: null, summaryData: undefined, x: 0, y: 0}))}
          >
            <div className={`absolute top-0 right-0 w-32 h-32 -mr-8 -mt-8 rounded-full opacity-[0.05] pointer-events-none ${theme === 'light' ? 'bg-cyan-600' : 'bg-cyan-400'}`}></div>
            <div className="flex items-center justify-between relative z-10">
              <span className="font-semibold text-sm tracking-wide text-gray-400">Alt Görevler</span>
              <div className={`p-3 rounded-xl shadow-inner ${theme === 'light' ? 'bg-gradient-to-br from-cyan-100 to-cyan-200 text-cyan-800 border border-cyan-200' : 'bg-gradient-to-br from-cyan-500/20 to-cyan-500/10 text-cyan-400 border border-cyan-500/30'}`}>
                <FileText size={22} className="stroke-[2.5]" />
              </div>
            </div>
            <div className="flex items-baseline gap-3 relative z-10">
              <span className="text-4xl font-black tracking-tighter text-gray-100"><AnimatedNumber value={completedSubtasks} /></span>
              <span className={`text-sm font-bold px-2 py-0.5 rounded-md ${theme === 'light' ? 'bg-cyan-100 text-cyan-800' : 'bg-cyan-500/20 text-cyan-400'}`}>
                / {totalSubtasks}
              </span>
            </div>
          </motion.div>
        </div>

        {/* Charts Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Status Pie Chart */}
          <motion.div variants={itemVariants} className="relative p-6 rounded-2xl shadow-sm h-[380px] flex flex-col border transition-all duration-300 group bg-gray-900 border-gray-800 hover:border-gray-700 hover:shadow-md">
            <div className={`absolute top-0 right-0 w-48 h-48 -mr-12 -mt-12 rounded-full opacity-[0.02] pointer-events-none transition-all duration-500 group-hover:scale-110 ${theme === 'light' ? 'bg-indigo-900' : 'bg-indigo-100'}`}></div>
            <h3 className="font-semibold mb-6 flex items-center gap-2 relative z-10 text-gray-200">
              <div className="p-2 rounded-lg bg-gray-800 text-gray-400">
                <ListTodo size={18} />
              </div>
              Durumlara Göre Dağılım
            </h3>
            <div className="flex-1 min-h-0 relative z-10">
              <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                <PieChart>
                  <Pie
                    data={statusData}
                    cx="50%"
                    cy="50%"
                    innerRadius={75}
                    outerRadius={105}
                    paddingAngle={3}
                    dataKey="value"
                    stroke="none"
                  >
                    {statusData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <RechartsTooltip isAnimationActive={false} content={(props: any) => <CustomPieTooltip {...props} total={tasks.length} />} />
                  <Legend 
                    wrapperStyle={{ fontSize: '13px', paddingTop: '20px' }} 
                    formatter={(value) => <span style={{ color: 'var(--color-gray-400)', fontWeight: 500 }}>{value}</span>}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </motion.div>

          {/* Workload Bar Chart */}
          <motion.div variants={itemVariants} className="relative p-6 rounded-2xl shadow-sm h-[380px] flex flex-col border transition-all duration-300 group bg-gray-900 border-gray-800 hover:border-gray-700 hover:shadow-md">
            <div className={`absolute top-0 right-0 w-48 h-48 -mr-12 -mt-12 rounded-full opacity-[0.02] pointer-events-none transition-all duration-500 group-hover:scale-110 ${theme === 'light' ? 'bg-indigo-900' : 'bg-indigo-100'}`}></div>
            <h3 className="font-semibold mb-6 flex items-center gap-2 relative z-10 text-gray-200">
              <div className="p-2 rounded-lg bg-gray-800 text-gray-400">
                <Users size={18} />
              </div>
              Ekiplerin İş Yükü (İlk 5)
            </h3>
            <div className="flex-1 min-h-0 relative z-10">
              <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                <BarChart data={workloadData} layout="vertical" margin={{ top: 0, right: 30, left: 0, bottom: 0 }}>
                  <XAxis type="number" hide />
                  <YAxis 
                    dataKey="name" 
                    type="category" 
                    axisLine={false} 
                    tickLine={false} 
                    width={100} 
                    tick={{ fill: 'var(--color-gray-400)', fontSize: 13, fontWeight: 500 }} 
                  />
                  <RechartsTooltip 
                    cursor={{ fill: 'rgba(255,255,255,0.05)' }} 
                    contentStyle={{ 
                      backgroundColor: 'var(--color-gray-950)', 
                      borderColor: 'var(--color-gray-700)', 
                      borderRadius: '12px',
                      boxShadow: '0 10px 25px -5px rgb(0 0 0 / 0.5)',
                      color: 'var(--color-gray-100)',
                      padding: '12px'
                    }} 
                  />
                  <Bar 
                    dataKey="Görevler" 
                    fill={theme === 'light' ? '#4f46e5' : '#818cf8'} 
                    radius={[0, 6, 6, 0]} 
                    barSize={24}
                    isAnimationActive={false}
                    label={{ position: 'right', fill: 'var(--color-gray-400)', fontSize: 12, fontWeight: 600 }}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </motion.div>
        </div>

        {/* Bottom Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Team Leaderboard */}
          <motion.div variants={itemVariants} className="p-6 rounded-2xl shadow-sm flex flex-col border transition-colors bg-gray-900 border-gray-800">
              <div className="flex items-center justify-between mb-6">
                 <h3 className="font-semibold flex items-center gap-2 text-gray-200">
                   <Users size={18} className="text-gray-400" />
                   Ekip Performans Liderliği
                 </h3>
                 <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${theme === 'light' ? 'bg-indigo-100 text-indigo-600' : 'bg-indigo-500/20 text-indigo-400'}`}>Skor</span>
              </div>
              
              <div className="flex-1 w-full">
                 <div className="flex flex-col gap-3">
                   {leaderboardData.length > 0 ? leaderboardData.map((person, idx) => (
                      <motion.div 
                         variants={itemVariants}
                         whileHover={{ scale: 1.02 }}
                         key={idx} 
                         className="p-3 rounded-xl border flex justify-between items-center transition-colors bg-gray-800/20 border-gray-800/80 hover:border-gray-700">
                         <div className="flex items-center gap-3">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${person.avatarColor}`}>
                              {person.name.substring(0, 2).toUpperCase()}
                            </div>
                            <div className="flex flex-col">
                              <span className="font-medium text-sm text-gray-300">{person.name}</span>
                              <span className="text-[10px] text-gray-500">{person.done} Biten, {person.inProgress} Devam</span>
                            </div>
                         </div>
                         <div className="flex flex-col items-end">
                            <span className="text-lg font-black tracking-tight text-gray-100">{person.score}</span>
                         </div>
                      </motion.div>
                   )) : (
                      <div className="py-8 text-center text-sm text-gray-400">Henüz ekip verisi yok.</div>
                   )}
                 </div>
              </div>
          </motion.div>

          {/* Priority Distribution */}
          <motion.div variants={itemVariants} className="p-6 rounded-2xl shadow-sm flex flex-col border transition-colors bg-gray-900 border-gray-800">
              <h3 className="font-semibold mb-6 flex items-center gap-2 text-gray-200">
                <AlertCircle size={18} className="text-gray-400" />
                Öncelik Dağılımı (Kalanlar)
              </h3>
              
              <div className="flex-1 w-full">
                 <div className="flex flex-col gap-3">
                   {priorityData.some(p => p.value > 0) ? priorityData.filter(p => p.value > 0).map((priority, idx) => (
                      <motion.div 
                         variants={itemVariants}
                         whileHover={{ scale: 1.02 }}
                         key={idx} 
                         className="p-3 rounded-xl border flex justify-between items-center transition-colors bg-gray-800/20 border-gray-800/80 hover:border-gray-700">
                         <div className="flex items-center gap-3">
                            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: priority.color }}></div>
                            <span className="font-medium text-sm text-gray-300">{priority.name}</span>
                         </div>
                         <span className="px-3 py-1 rounded-md text-xs font-bold bg-gray-800 text-gray-200">{priority.value} Görev</span>
                      </motion.div>
                   )) : (
                      <div className="py-8 text-center text-sm text-gray-400">Tüm görevler tamamlandı!</div>
                   )}
                   
                   {/* Mini Card for Cycle Time */}
                   {avgCycleDays > 0 && (
                     <motion.div variants={itemVariants} className="mt-4 p-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 flex items-center justify-between">
                        <div className="flex flex-col gap-1">
                          <span className="text-xs uppercase font-bold tracking-wider text-emerald-500">Ort. Cycle Time</span>
                          <span className="text-xs text-emerald-400/80">Başlangıçtan Bitime Kadarki Süre</span>
                        </div>
                        <div className="text-2xl font-black text-emerald-400">
                          {avgCycleDays} <span className="text-sm font-medium">Gün</span>
                        </div>
                     </motion.div>
                   )}
                 </div>
              </div>
          </motion.div>

          {/* Upcoming Tasks */}
          <motion.div variants={itemVariants} className="p-6 rounded-2xl shadow-sm flex flex-col border transition-colors bg-gray-900 border-gray-800">
              <h3 className="font-semibold mb-6 flex items-center gap-2 text-gray-200">
                <Clock size={18} className="text-gray-400" />
                Yaklaşan Görevler
              </h3>
              
              <div className="flex-1 w-full">
                 <div className="flex flex-col gap-3">
                   {upcomingTasks.length > 0 ? upcomingTasks.map((task, idx) => (
                      <motion.div 
                         variants={itemVariants}
                         whileHover={{ scale: 1.02 }}
                         key={idx} 
                         className="p-3 rounded-xl border flex items-center justify-between transition-colors bg-gray-800/20 border-gray-800/80 hover:border-gray-700">
                         <div className="flex flex-col gap-1 pr-4 overflow-hidden">
                           <span className="font-medium text-sm truncate text-gray-300">{task.task}</span>
                           <span className="text-xs truncate text-gray-400">{task.proje}</span>
                         </div>
                         <div className="flex flex-col items-end shrink-0 gap-1">
                           <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${theme === 'light' ? 'bg-rose-100 text-rose-700' : 'bg-rose-500/20 text-rose-300'}`}>
                             {format(parseISO(task.hedefTarih), 'dd MMM', { locale: tr })}
                           </span>
                           <span className={`text-[10px] uppercase font-medium ${theme === 'light' ? 'text-indigo-600' : 'text-indigo-400'}`}>
                             {task.status === 'in_progress' ? 'Devam Ediyor' : 'Bekliyor'}
                           </span>
                         </div>
                      </motion.div>
                   )) : (
                      <div className="py-8 text-center text-sm text-gray-400">Henüz yaklaşan görev bulunmuyor.</div>
                   )}
                 </div>
              </div>
          </motion.div>
        </div>

      </motion.div>
    );
  };

  const handleSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const renderFilterPopover = (columnKey: string, type: 'select' | 'text' | 'date', options?: string[]) => {
    if (activeFilterPopover !== columnKey) return null;
    const currentFilters = columnFilters[columnKey] || [];
    
    return (
      <div className="absolute top-full mt-1 w-52 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 p-2 font-normal left-1/2 -translate-x-1/2 cursor-default"
           onClick={(e) => e.stopPropagation()}>
           <div className="flex justify-between items-center mb-2 px-1">
             <span className="text-xs text-gray-400">{'Filtrele'}</span>
             <button onClick={() => setActiveFilterPopover(null)} className="text-gray-500 hover:text-gray-300"><X size={12}/></button>
           </div>
           
           {type === 'select' && options && (
             <>
             <div className="max-h-40 overflow-y-auto flex flex-col gap-1 custom-scrollbar pr-1">
                {options.map(opt => {
                   let label = opt;
                   if (columnKey === 'status') {
                     const st = statuses.find(s => s.id === opt);
                     label = st ? st.title : opt;
                   }
                   return (
                   <label key={opt} className="flex items-center gap-2 text-xs hover:bg-gray-800 px-2 py-1 cursor-pointer rounded text-gray-200">
                     <input type="checkbox" className="rounded border-gray-600 bg-gray-950 text-indigo-500" 
                        checked={currentFilters.includes(opt)}
                        onChange={(e) => {
                          const updated = e.target.checked ? [...currentFilters, opt] : currentFilters.filter(v => v !== opt);
                          setColumnFilters({...columnFilters, [columnKey]: updated});
                        }}
                     />
                     <span className="truncate">{label}</span>
                   </label>
                   );
                })}
             </div>
             {currentFilters.length > 0 && <button onClick={() => setColumnFilters({...columnFilters, [columnKey]: []})} className="w-full text-xs text-rose-400 hover:bg-rose-400/10 mt-2 py-1 rounded transition-colors">Temizle</button>}
             </>
           )}

           {(type === 'text' || type === 'date') && (
             <div className="flex flex-col gap-2">
               <input 
                 type={type}
                 className="w-full bg-gray-950 border border-gray-700 text-gray-100 rounded px-2 py-1.5 text-xs focus:border-indigo-500"
                 placeholder="Değer ara..."
                 value={currentFilters[0] || ''}
                 onChange={(e) => setColumnFilters({...columnFilters, [columnKey]: e.target.value ? [e.target.value] : []})}
               />
               {currentFilters.length > 0 && <button onClick={() => setColumnFilters({...columnFilters, [columnKey]: []})} className="w-full text-xs text-rose-400 hover:bg-rose-400/10 mt-1 py-1 rounded transition-colors">Temizle</button>}
             </div>
           )}
      </div>
    )
  }

  const renderDataSheet = () => {
    const sortedTasks = [...tasks].filter(t => {
      if (searchQuery) {
        const lowerQ = searchQuery.toLowerCase();
        const matchesGlobal = (t.proje?.toLowerCase().includes(lowerQ) || 
                t.task?.toLowerCase().includes(lowerQ) || 
                t.keyword?.toLowerCase().includes(lowerQ) ||
                t.sorumlu?.some(s => s.toLowerCase().includes(lowerQ)));
        if (!matchesGlobal) return false;
      }

      for (const [key, valuesUntyped] of Object.entries(columnFilters)) {
        const values = valuesUntyped as string[];
        if (values && values.length > 0) {
          if (key === 'sorumlu') {
            if (!t.sorumlu || !t.sorumlu.some(s => values.includes(s))) return false;
          } else if (key === 'task' || key === 'baslangicTarihi') {
             const fVal = values[0].toLowerCase();
             let tVal = ((t as any)[key] || '').toString().toLowerCase();
             if (key === 'baslangicTarihi') {
                if (t.baslangicTarihi && t.bitisTarihi) {
                    tVal = `${t.baslangicTarihi} - ${t.bitisTarihi}`;
                }
             }
             if (!tVal.includes(fVal)) return false;
          } else {
             if (!values.includes((t as any)[key] as never)) return false;
          }
        }
      }
      return true;
    }).sort((a: any, b: any) => {
      if (!sortConfig) return 0;
      const { key, direction } = sortConfig;
      let aVal = a[key] || '';
      let bVal = b[key] || '';
      
      if (key === 'sorumlu') {
        aVal = a.sorumlu.join(', ');
        bVal = b.sorumlu.join(', ');
      }
      
      if (aVal < bVal) return direction === 'asc' ? -1 : 1;
      if (aVal > bVal) return direction === 'asc' ? 1 : -1;
      return 0;
    });

    return (
    <motion.div 
      variants={appContainerVariants}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-6"
    >
      <motion.div variants={appItemVariants} className="bg-gray-900 border border-gray-800 rounded-xl shadow-sm relative z-20">
        <div className="p-4 border-b border-gray-800 bg-gray-900/50 flex justify-between items-center rounded-t-xl">
          <h2 className="text-lg font-medium flex items-center gap-2 text-gray-100"><Plus size={18} className="text-blue-500" /> Yeni Görev Ekle</h2>
        </div>
        <div className="p-4 bg-gray-900">
          <form onSubmit={handleAddTask} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-10 gap-4 items-end">
              <div className="flex flex-col gap-1.5 md:col-span-1 xl:col-span-1">
                <label className="text-sm text-gray-400 font-medium">Proje</label>
                <input 
                  type="text" 
                  value={newTask.proje || ''} 
                  onChange={(e) => setNewTask({...newTask, proje: e.target.value})}
                  className="bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                  placeholder="Örn: Proje A"
                />
              </div>
              <div className="flex flex-col gap-1.5 md:col-span-1 lg:col-span-2 xl:col-span-2">
                <label className="text-sm text-gray-400 font-medium">Task (Uzun Tanım)</label>
                <input 
                  type="text" 
                  value={newTask.task || ''} 
                  onChange={(e) => setNewTask({...newTask, task: e.target.value})}
                  className="bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                  placeholder="Örn: Tasarımın..."
                />
              </div>
              <div className="flex flex-col gap-1.5 md:col-span-1 lg:col-span-1 xl:col-span-1">
                <label className="text-sm text-gray-400 font-medium">Keyword</label>
                <input 
                  type="text" 
                  value={newTask.keyword || ''} 
                  onChange={(e) => setNewTask({...newTask, keyword: e.target.value})}
                  className="bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                  placeholder="Kısa Tanım"
                />
              </div>
              <div className="flex flex-col gap-1.5 md:col-span-1 lg:col-span-1 xl:col-span-1">
                <label className="text-sm text-gray-400 font-medium">Tema Rengi</label>
                <select 
                  value={newTask.themeColor || ''} 
                  onChange={(e) => setNewTask({...newTask, themeColor: (e.target.value as any) || undefined})}
                  className="bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                >
                  <option value="">⚙️ Otomatik</option>
                  <option value="blue">🔵 Mavi</option>
                  <option value="emerald">🟢 Zümrüt</option>
                  <option value="purple">🟣 Mor</option>
                  <option value="amber">🟠 Kehribar</option>
                  <option value="rose">🔴 Gül</option>
                  <option value="cyan">💎 Turkuaz</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5 md:col-span-1 lg:col-span-1 xl:col-span-1 relative z-[60]">
                <label className="text-sm text-gray-400 font-medium">Sorumlular</label>
                <div 
                  className="bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm cursor-pointer min-h-[38px] flex flex-wrap gap-1 items-center"
                  onClick={() => setIsSorumluDropdownOpen(!isSorumluDropdownOpen)}
                >
                  {newTask.sorumlu && newTask.sorumlu.length > 0 ? (
                    newTask.sorumlu.map(s => (
                      <span key={s} className="bg-gray-800 text-gray-300 px-1.5 py-0.5 rounded text-xs flex items-center gap-1">
                        {s}
                        <button type="button" onClick={(e) => { e.stopPropagation(); setNewTask({...newTask, sorumlu: newTask.sorumlu?.filter(item => item !== s)}); }} className="hover:text-red-400"><X size={10}/></button>
                      </span>
                    ))
                  ) : (
                    <span className="text-gray-500">Seçiniz...</span>
                  )}
                </div>
                {isSorumluDropdownOpen && (
                  <div className="absolute top-[100%] mt-1 left-0 right-0 z-50 bg-gray-950 border border-gray-700 rounded-lg shadow-xl max-h-48 overflow-y-auto custom-scrollbar">
                    {sorumlular.map(s => {
                      const isSelected = newTask.sorumlu?.includes(s);
                      return (
                        <div 
                          key={s} 
                          className="px-3 py-2 hover:bg-gray-800 cursor-pointer flex items-center justify-between text-sm text-gray-200 transition-colors"
                          onClick={() => {
                            const newArr = isSelected ? newTask.sorumlu?.filter(item => item !== s) : [...(newTask.sorumlu || []), s];
                            setNewTask({...newTask, sorumlu: newArr});
                          }}
                        >
                          {s}
                          {isSelected && <Check size={14} className="text-blue-500" />}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1.5 md:col-span-1 lg:col-span-1 xl:col-span-1 relative z-[50]">
                <label className="text-sm text-gray-400 font-medium flex items-center justify-between">
                  <span>Bağlı Görevler</span>
                  {isDependencyDropdownOpen && (
                    <select 
                      className="bg-gray-800 text-xs rounded border border-gray-700 px-1 py-0.5 outline-none focus:border-indigo-500"
                      value={selectedDepType}
                      onChange={(e) => setSelectedDepType(e.target.value as any)}
                      title="FS: Finish-Start (Bitiş-Başlangıç)
SS: Start-Start (Başlangıç-Başlangıç)
FF: Finish-Finish (Bitiş-Bitiş)
SF: Start-Finish (Başlangıç-Bitiş)"
                    >
                      <option value="FS">FS</option>
                      <option value="SS">SS</option>
                      <option value="FF">FF</option>
                      <option value="SF">SF</option>
                    </select>
                  )}
                </label>
                <div 
                  className="bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm cursor-pointer min-h-[38px] flex flex-wrap gap-1 items-center"
                  onClick={() => setIsDependencyDropdownOpen(!isDependencyDropdownOpen)}
                >
                  {newTask.dependencies && newTask.dependencies.length > 0 ? (
                    <span className="bg-gray-800 text-gray-300 px-2 py-0.5 rounded text-xs flex items-center gap-1">
                      {newTask.dependencies.length} görev
                    </span>
                  ) : (
                    <span className="text-gray-500">Seçiniz...</span>
                  )}
                </div>
                {isDependencyDropdownOpen && (
                  <div className="absolute top-[100%] mt-1 left-0 right-0 z-50 bg-gray-950 border border-gray-700 rounded-lg shadow-xl max-h-48 overflow-y-auto custom-scrollbar min-w-[200px]">
                    {tasks.map(t => {
                      const existingDep = newTask.dependencies?.find(d => d.id === t.id);
                      const isSelected = !!existingDep;
                      return (
                        <div 
                          key={t.id} 
                          className="px-3 py-2 hover:bg-gray-800 cursor-pointer flex items-center justify-between text-sm text-gray-200 transition-colors"
                          onClick={() => {
                            const newArr = isSelected 
                               ? newTask.dependencies?.filter(d => d.id !== t.id) 
                               : [...(newTask.dependencies || []), { id: t.id, type: selectedDepType }];
                            setNewTask({...newTask, dependencies: newArr as any});
                          }}
                        >
                          <span className="truncate pr-3 max-w-[150px]">{t.keyword}</span>
                          {isSelected && <div className="flex items-center gap-1"><span className="text-[10px] text-gray-500">{existingDep.type}</span><Check size={14} className="text-blue-500 flex-shrink-0" /></div>}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1.5 md:col-span-1 lg:col-span-1 xl:col-span-1">
                <label className="text-sm text-gray-400 font-medium whitespace-nowrap">Başlangıç</label>
                <input 
                  type="date" 
                  value={newTask.baslangicTarihi || ''} 
                  onChange={(e) => setNewTask({...newTask, baslangicTarihi: e.target.value})}
                  className="bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                  
                />
              </div>
              <div className="flex flex-col gap-1.5 md:col-span-1 lg:col-span-1 xl:col-span-1">
                <label className="text-sm text-gray-400 font-medium whitespace-nowrap">Bitiş</label>
                <input 
                  type="date" 
                  value={newTask.bitisTarihi || ''} 
                  onChange={(e) => setNewTask({...newTask, bitisTarihi: e.target.value})}
                  className="bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                  style={{ colorScheme: theme }}
                />
              </div>
              <div className="flex flex-col gap-1.5 md:col-span-1 lg:col-span-1 xl:col-span-1">
                <label className={`text-sm font-medium whitespace-nowrap ${theme === 'light' ? 'text-rose-600' : 'text-red-300'}`}>Hedef Tarih</label>
                <input 
                  type="date" 
                  value={newTask.hedefTarih || ''} 
                  onChange={(e) => setNewTask({...newTask, hedefTarih: e.target.value})}
                  className="bg-gray-950 border border-red-900 border-dashed text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 transition-colors bg-red-950/20"
                  style={{ colorScheme: theme }}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <button 
                type="submit" 
                className="w-full md:w-auto bg-blue-600 hover:bg-blue-500 text-white px-8 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
              >
                Ekle
              </button>
            </div>
          </form>
        </div>
      </motion.div>

      <motion.div variants={appItemVariants} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden shadow-sm relative z-10">
        <div className="p-4 border-b border-gray-800 bg-gray-900/50 flex justify-between items-center">
          <h2 className="text-lg font-medium flex items-center gap-2 text-gray-100"><ListTodo size={18} className="text-indigo-400" /> Görev Listesi</h2>
          <div className="flex items-center gap-2 bg-gray-950 border border-gray-800 rounded-lg px-3 py-1.5 focus-within:border-indigo-500 max-w-xs w-full transition-colors">
            <Search className="text-gray-500" size={14} />
            <input 
              type="text" 
              placeholder="Ara (Proje, Task, Sorumlu, Keyword)..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-transparent text-sm text-gray-100 w-full focus:outline-none placeholder:text-gray-600"
            />
            {searchQuery && <button onClick={() => setSearchQuery('')} className="text-gray-500 hover:text-gray-300"><X size={14} /></button>}
          </div>
        </div>
        <div className="overflow-auto max-h-[calc(100vh-250px)]">
          <table className="w-full text-sm text-left text-gray-300">
            <thead className="text-xs tracking-wider sticky top-0 z-40 backdrop-blur-md bg-gray-950/90 text-gray-400 border-b border-gray-800 shadow-sm select-none">
              <tr>
                <th className="px-4 py-4 font-medium w-12 text-center">#</th>
                                <th className="px-6 py-4 font-medium transition-colors relative">
                  <div className="flex items-center gap-1 group">
                    <span className="cursor-pointer hover:text-gray-200" onClick={() => handleSort('proje')}>
                      Proje {sortConfig?.key === 'proje' ? (sortConfig.direction === 'asc' ? <ChevronUp size={14} className="inline ml-1" /> : <ChevronDown size={14} className="inline ml-1" />) : <ChevronUp size={14} className="inline ml-1 opacity-0 group-hover:opacity-100" />}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); setActiveFilterPopover(activeFilterPopover === 'proje' ? null : 'proje'); }} className={'p-1 rounded hover:bg-gray-800 ' + (columnFilters['proje']?.length ? 'text-indigo-400' : 'text-gray-500 opacity-0 group-hover:opacity-100')}><Filter size={12}/></button>
                  </div>
                  {renderFilterPopover('proje', 'select', Array.from(new Set(tasks.map(t => t.proje).filter(Boolean))))}
                </th>
                <th className="px-6 py-4 font-medium transition-colors relative max-w-[200px]">
                  <div className="flex items-center gap-1 group">
                    <span className="cursor-pointer hover:text-gray-200" onClick={() => handleSort('task')}>
                      Task (Uzun Tanım) {sortConfig?.key === 'task' ? (sortConfig.direction === 'asc' ? <ChevronUp size={14} className="inline ml-1" /> : <ChevronDown size={14} className="inline ml-1" />) : <ChevronUp size={14} className="inline ml-1 opacity-0 group-hover:opacity-100" />}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); setActiveFilterPopover(activeFilterPopover === 'task' ? null : 'task'); }} className={'p-1 rounded hover:bg-gray-800 ' + (columnFilters['task']?.length ? 'text-indigo-400' : 'text-gray-500 opacity-0 group-hover:opacity-100')}><Filter size={12}/></button>
                  </div>
                  {renderFilterPopover('task', 'text')}
                </th>
                <th className="px-6 py-4 font-medium transition-colors relative">
                  <div className="flex items-center gap-1 group">
                    <span className="cursor-pointer hover:text-gray-200" onClick={() => handleSort('keyword')}>
                      Keyword {sortConfig?.key === 'keyword' ? (sortConfig.direction === 'asc' ? <ChevronUp size={14} className="inline ml-1" /> : <ChevronDown size={14} className="inline ml-1" />) : <ChevronUp size={14} className="inline ml-1 opacity-0 group-hover:opacity-100" />}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); setActiveFilterPopover(activeFilterPopover === 'keyword' ? null : 'keyword'); }} className={'p-1 rounded hover:bg-gray-800 ' + (columnFilters['keyword']?.length ? 'text-indigo-400' : 'text-gray-500 opacity-0 group-hover:opacity-100')}><Filter size={12}/></button>
                  </div>
                  {renderFilterPopover('keyword', 'select', Array.from(new Set(tasks.map(t => t.keyword).filter(Boolean))))}
                </th>
                <th className="px-6 py-4 font-medium transition-colors relative">
                  <div className="flex items-center gap-1 group">
                    <span className="cursor-pointer hover:text-gray-200" onClick={() => handleSort('sorumlu')}>
                      Sorumlular {sortConfig?.key === 'sorumlu' ? (sortConfig.direction === 'asc' ? <ChevronUp size={14} className="inline ml-1" /> : <ChevronDown size={14} className="inline ml-1" />) : <ChevronUp size={14} className="inline ml-1 opacity-0 group-hover:opacity-100" />}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); setActiveFilterPopover(activeFilterPopover === 'sorumlu' ? null : 'sorumlu'); }} className={'p-1 rounded hover:bg-gray-800 ' + (columnFilters['sorumlu']?.length ? 'text-indigo-400' : 'text-gray-500 opacity-0 group-hover:opacity-100')}><Filter size={12}/></button>
                  </div>
                  {renderFilterPopover('sorumlu', 'select', sorumlular)}
                </th>
                <th className="px-6 py-4 font-medium transition-colors relative">
                  <div className="flex items-center gap-1 group">
                    <span className="cursor-pointer hover:text-gray-200" onClick={() => handleSort('status')}>
                      Durum {sortConfig?.key === 'status' ? (sortConfig.direction === 'asc' ? <ChevronUp size={14} className="inline ml-1" /> : <ChevronDown size={14} className="inline ml-1" />) : <ChevronUp size={14} className="inline ml-1 opacity-0 group-hover:opacity-100" />}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); setActiveFilterPopover(activeFilterPopover === 'status' ? null : 'status'); }} className={'p-1 rounded hover:bg-gray-800 ' + (columnFilters['status']?.length ? 'text-indigo-400' : 'text-gray-500 opacity-0 group-hover:opacity-100')}><Filter size={12}/></button>
                  </div>
                  {renderFilterPopover('status', 'select', statuses.map(s => s.id))}
                </th>
                <th className="px-6 py-4 font-medium transition-colors relative">
                  <div className="flex items-center gap-1 group">
                    <span className="cursor-pointer hover:text-gray-200" onClick={() => handleSort('baslangicTarihi')}>
                      Tarihler {sortConfig?.key === 'baslangicTarihi' ? (sortConfig.direction === 'asc' ? <ChevronUp size={14} className="inline ml-1" /> : <ChevronDown size={14} className="inline ml-1" />) : <ChevronUp size={14} className="inline ml-1 opacity-0 group-hover:opacity-100" />}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); setActiveFilterPopover(activeFilterPopover === 'baslangicTarihi' ? null : 'baslangicTarihi'); }} className={'p-1 rounded hover:bg-gray-800 ' + (columnFilters['baslangicTarihi']?.length ? 'text-indigo-400' : 'text-gray-500 opacity-0 group-hover:opacity-100')}><Filter size={12}/></button>
                  </div>
                  {renderFilterPopover('baslangicTarihi', 'date')}
                </th>
                <th className="px-6 py-4 font-medium text-center w-20">İşlem</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              <AnimatePresence>
              {tasks.length === 0 ? (
                <motion.tr initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <td colSpan={8} className="px-6 py-8 text-center text-gray-500">Henüz hiç görev eklenmemiş.</td>
                </motion.tr>
              ) : null}
              {sortedTasks.map((task, idx) => {
                const isEditing = editingTask?.id === task.id;
                return (
                  <motion.tr 
                    layout
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.2 }}
                    key={task.id} 
                    className={`transition-colors ${isEditing ? 'bg-gray-800/80' : 'hover:bg-gray-800/40'}`}>
                    {isEditing ? (
                      <>
                        <td className="px-4 py-3 text-center text-gray-600 font-mono text-xs">{idx + 1}</td>
                        <td className="px-4 py-3"><input className="w-full bg-gray-950 border border-gray-700 text-gray-100 rounded px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none" value={editingTask.proje} onChange={(e) => setEditingTask({...editingTask, proje: e.target.value})} /></td>
                        <td className="px-4 py-3"><input className="w-full bg-gray-950 border border-gray-700 text-gray-100 rounded px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none" value={editingTask.task} onChange={(e) => setEditingTask({...editingTask, task: e.target.value})} /></td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1">
                            <input className="w-full bg-gray-950 border border-gray-700 text-gray-100 rounded px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none" value={editingTask.keyword} onChange={(e) => setEditingTask({...editingTask, keyword: e.target.value})} />
                            <select 
                              value={editingTask.themeColor || ''} 
                              onChange={(e) => setEditingTask({...editingTask, themeColor: (e.target.value as any) || undefined})}
                              className="bg-gray-950 border border-gray-700 text-gray-100 rounded px-1 py-1 text-sm focus:border-indigo-500 focus:outline-none w-24"
                            >
                              <option value="">⚙️ Oto</option>
                              <option value="blue">🔵 Mavi</option>
                              <option value="emerald">🟢 Zümrüt</option>
                              <option value="purple">🟣 Mor</option>
                              <option value="amber">🟠 Kehri</option>
                              <option value="rose">🔴 Gül</option>
                              <option value="cyan">💎 Turkuaz</option>
                            </select>
                          </div>
                        </td>
                        <td className="px-4 py-3 min-w-[200px]">
                          <div className="flex flex-wrap gap-1 bg-gray-950 border border-gray-700 p-1 rounded max-h-24 overflow-y-auto w-full">
                            {sorumlular.map(s => (
                              <label key={s} className="flex items-center gap-1.5 text-xs text-gray-300 w-full hover:bg-gray-800 px-1 py-0.5 rounded cursor-pointer">
                                <input 
                                  type="checkbox" 
                                  className="rounded border-gray-600 bg-gray-900"
                                  checked={editingTask.sorumlu?.includes(s)}
                                  onChange={(e) => {
                                    const current = editingTask.sorumlu || [];
                                    setEditingTask({...editingTask, sorumlu: e.target.checked ? [...current, s] : current.filter(item => item !== s)});
                                  }}
                                />
                                <span className="truncate">{s}</span>
                              </label>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <select
                            className="w-full bg-gray-950 border border-gray-700 text-gray-100 rounded px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                            value={editingTask.status || 'todo'}
                            onChange={(e) => setEditingTask({...editingTask, status: e.target.value as any})}
                          >
                            <option value="todo">Yapılacak</option>
                            <option value="in_progress">Devam Ediyor</option>
                            <option value="done">Tamamlandı</option>
                          </select>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex flex-col gap-1.5 text-[11px] font-mono">
                            <div className="flex items-center gap-2">
                              <span className="w-6 text-gray-400">Bşl:</span> <input type="date" className="bg-gray-950 border border-gray-700 text-gray-100 rounded px-1.5 py-0.5 focus:border-indigo-500 focus:outline-none" style={{ colorScheme: theme }} value={editingTask.baslangicTarihi} onChange={(e) => setEditingTask({...editingTask, baslangicTarihi: e.target.value})} />
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="w-6 text-gray-400">Bit:</span> <input type="date" className="bg-gray-950 border border-gray-700 text-gray-100 rounded px-1.5 py-0.5 focus:border-indigo-500 focus:outline-none" style={{ colorScheme: theme }} value={editingTask.bitisTarihi} onChange={(e) => setEditingTask({...editingTask, bitisTarihi: e.target.value})} />
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={`w-6 ${theme === 'light' ? 'text-rose-600 font-medium' : 'text-red-400/80'}`}>Hdf:</span> <input type="date" className={`rounded px-1.5 py-0.5 focus:outline-none ${theme === 'light' ? 'bg-rose-50 border border-rose-200 text-rose-800 focus:border-rose-400' : 'bg-rose-950/20 border border-rose-900 text-gray-100 focus:border-rose-500'}`} style={{ colorScheme: theme }} value={editingTask.hedefTarih} onChange={(e) => setEditingTask({...editingTask, hedefTarih: e.target.value})} />
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <button onClick={() => { setTasks(tasks.map(t => t.id === editingTask.id ? {...editingTask} : t)); setEditingTask(null); }} className="text-emerald-400 hover:bg-emerald-400/20 p-1.5 rounded-lg transition-colors" title="Kaydet"><Check size={18} /></button>
                            <button onClick={() => setEditingTask(null)} className="text-gray-400 hover:bg-gray-500/20 hover:text-gray-200 p-1.5 rounded-lg transition-colors" title="İptal"><X size={18} /></button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-4 py-4 text-center text-gray-600 font-mono text-xs">{idx + 1}</td>
                        <td className="px-6 py-4 font-medium text-gray-200">{task.proje}</td>
                        <td className="px-6 py-4 text-gray-400 max-w-[200px] truncate" title={task.task}>{task.task}</td>
                        <td className="px-6 py-4">
                          <span className={`px-2.5 py-1 rounded-md text-xs font-semibold ${getKeywordColor(task.keyword, theme, task.themeColor).badge}`}>
                            {task.keyword}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-wrap gap-1.5">
                            {task.sorumlu && task.sorumlu.length > 0 ? (
                              task.sorumlu.map(s => (
                                <div key={s} className="flex items-center gap-1.5 bg-gray-800/80 px-2 py-0.5 rounded-md border border-gray-700/50">
                                  <div className="w-4 h-4 rounded-full bg-gray-700 flex items-center justify-center text-[8px] font-bold text-gray-300 shrink-0">
                                    {s.charAt(0)}
                                  </div>
                                  <span className="text-gray-300 text-xs">{s}</span>
                                </div>
                              ))
                            ) : (
                              <span className="text-red-400 text-xs italic">Sorumlu Yok</span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider ${
                            task.status === 'done' ? 'bg-emerald-500/20 text-emerald-400' :
                            task.status === 'in_progress' ? 'bg-indigo-500/20 text-indigo-400' :
                            'bg-gray-500/20 text-gray-400'
                          }`}>
                            {task.status === 'done' ? 'Tamamlandı' : task.status === 'in_progress' ? 'Devam Ediyor' : 'Yapılacak'}
                          </span>
                        </td>
                        <td className="px-6 py-2 whitespace-nowrap text-gray-400 font-mono text-xs">
                          <div className="flex flex-col gap-1">
                            <div className="flex gap-2">
                              <span className="w-8">Bşl:</span> <span className="text-gray-200">{format(parseISO(task.baslangicTarihi), 'dd MMM yyyy', { locale: tr })}</span>
                            </div>
                            <div className="flex gap-2 border-b border-gray-800 pb-1">
                              <span className="w-8">Bit:</span> <span className="text-gray-200">{format(parseISO(task.bitisTarihi), 'dd MMM yyyy', { locale: tr })}</span>
                            </div>
                            <div className="flex gap-2 pt-0.5">
                              <span className={`w-8 ${theme === 'light' ? 'text-rose-600 font-medium' : 'text-red-400/80'}`}>Hdf:</span> <span className={theme === 'light' ? 'text-rose-700 font-medium' : 'text-red-300'}>{format(parseISO(task.hedefTarih), 'dd MMM yyyy', { locale: tr })}</span>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-center">
                          <div className="flex items-center justify-center gap-1 relative">
                            <button 
                              onClick={() => setDetailedTask(task)}
                              className="text-gray-500 hover:text-blue-400 p-1.5 hover:bg-blue-400/10 rounded-lg transition-colors"
                              title="Detaylar"
                            >
                              <FileText size={16} />
                            </button>
                            <button 
                              onClick={() => setEditingTask(task)}
                              className="text-gray-500 hover:text-indigo-400 p-1.5 hover:bg-indigo-400/10 rounded-lg transition-colors"
                              title="Düzenle"
                            >
                              <Edit2 size={16} />
                            </button>
                            <button 
                              onClick={() => handleDeleteTask(task.id)}
                              className="text-gray-500 hover:text-red-400 p-1.5 hover:bg-red-400/10 rounded-lg transition-colors"
                              title="Sil"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </td>
                      </>
                    )}
                  </motion.tr>
                );
              })}
              </AnimatePresence>
            </tbody>
          </table>
        </div>
      </motion.div>
    </motion.div>
  );
  };

  const renderCalendarSheet = () => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(monthStart);
    const startDate = startOfWeek(monthStart, { weekStartsOn: 1 }); // Monday
    const endDate = endOfWeek(monthEnd, { weekStartsOn: 1 });

    const dateFormat = "d";
    const days = eachDayOfInterval({
      start: startDate,
      end: endDate
    });

    const nextMonth = () => setCurrentMonth(addMonths(currentMonth, 1));
    const prevMonth = () => setCurrentMonth(subMonths(currentMonth, 1));
    const goToToday = () => setCurrentMonth(new Date());

    return (
      <motion.div 
        variants={appContainerVariants}
        initial="hidden"
        animate="visible"
        className="flex flex-col gap-6 h-full min-h-[700px]"
      >
        {/* Calendar Header */}
        <motion.div variants={appItemVariants} className="flex justify-between items-center bg-gray-900 border border-gray-800 rounded-xl p-4 shadow-sm">
          <h2 className="text-2xl font-bold capitalize flex items-center gap-3 text-gray-100">
            <CalendarIcon className="text-blue-500" size={24} />
            {format(currentMonth, 'MMMM yyyy', { locale: tr })}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 mr-2 bg-gray-950 px-2 py-1.5 rounded-lg border border-gray-800">
               <span className="text-xs text-gray-500 font-medium whitespace-nowrap">Git:</span>
               <input 
                 type="month" 
                 className="bg-transparent text-gray-300 text-xs focus:outline-none" 
                  
                 value={format(currentMonth, 'yyyy-MM')} 
                 onChange={e => {
                   if (e.target.value) {
                     setCurrentMonth(parseISO(e.target.value + '-01'));
                   }
                 }} 
               />
            </div>
            <button 
              onClick={goToToday}
              className="px-4 py-1.5 text-sm font-medium border border-gray-700 bg-gray-950 text-gray-300 rounded-lg hover:bg-gray-800 transition-colors mr-2"
            >
              Bugün
            </button>
            <div className="flex items-center bg-gray-950 rounded-lg border border-gray-700 overflow-hidden">
              <button 
                onClick={prevMonth}
                className="p-1.5 text-gray-400 hover:text-gray-100 hover:bg-gray-800 transition-colors border-r border-gray-700"
              >
                <ChevronLeft size={20} />
              </button>
              <button 
                onClick={nextMonth}
                className="p-1.5 text-gray-400 hover:text-gray-100 hover:bg-gray-800 transition-colors"
              >
                <ChevronRight size={20} />
              </button>
            </div>
          </div>
        </motion.div>

        {/* Calendar Grid */}
        <motion.div variants={appItemVariants} className="flex flex-col bg-gray-900 border border-gray-800 rounded-xl overflow-auto shadow-sm max-h-[calc(100vh-200px)]">
          {/* Days Week Header */}
          <div className="grid grid-cols-7 border-b sticky top-0 z-20 backdrop-blur-md border-gray-800 bg-gray-950/90 shadow-sm">
            {['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'].map((day, i) => (
              <div key={day} className={`p-3 text-center text-sm font-semibold tracking-wide uppercase ${i >= 5 ? (theme === 'light' ? 'text-rose-600' : 'text-red-400/80') : 'text-gray-400'}`}>
                {day}
              </div>
            ))}
          </div>

          {/* Days Grid */}
          <div className="grid grid-cols-7 flex-1 auto-rows-[minmax(140px,1fr)] bg-gray-800 gap-[1px]">
            {days.map((day, idx) => {
              const dateKey = format(day, 'yyyy-MM-dd');
              const dayTasks = tasks.filter(t => t.hedefTarih === dateKey);
              const isCurrMonth = isSameMonth(day, monthStart);
              const isTodayDate = isToday(day);
              const weekend = isWeekend(day);

              return (
                <div 
                  key={day.toString()} 
                  className={`
                    p-2 lg:p-3 flex flex-col gap-1.5 transition-colors
                    ${weekend ? 'bg-gray-800/60' : 'bg-gray-900'}
                    ${!isCurrMonth ? 'opacity-50' : 'hover:bg-gray-800/40'}
                  `}
                >
                  <div className="flex justify-between items-start mb-1">
                    <span className={`
                      text-xs font-bold w-7 h-7 flex items-center justify-center rounded-full
                      ${isTodayDate ? 'bg-blue-600 text-white shadow-md shadow-blue-500/20' : 'text-gray-400'}
                    `}>
                      {format(day, dateFormat)}
                    </span>
                    {dayTasks.length > 0 && (
                      <span className="text-[10px] font-medium text-gray-500 px-1 bg-gray-800 rounded">
                        {dayTasks.length} Görev
                      </span>
                    )}
                  </div>
                  
                  <div className="flex flex-col gap-1.5 overflow-y-auto max-h-[160px] hide-scrollbar">
                    {dayTasks.map(task => (
                      <div 
                        key={task.id} 
                        className={`text-[11px] px-2 py-1.5 rounded flex flex-col gap-0.5 shadow-sm border ${task.status === 'done' ? 'opacity-90' : ''} ${getKeywordColor(task.keyword, theme, task.themeColor).badge}`}
                        onMouseEnter={(e) => setTooltipConfig({show: true, task, x: e.clientX, y: e.clientY})} onMouseMove={(e) => setTooltipConfig(prev => ({...prev, x: e.clientX, y: e.clientY}))} onMouseLeave={() => setTooltipConfig(prev => ({...prev, show: false}))}
                      >
                        <span className={`font-bold truncate text-xs flex items-center gap-1 ${task.status === 'done' ? 'line-through text-gray-400' : ''}`}>
                          {task.status === 'done' && <CheckCircle2 size={12} className="shrink-0" />}
                          {task.keyword}
                        </span>
                        <div className="flex items-center gap-1 opacity-80 mt-0.5 flex-wrap">
                          <Users size={10} />
                          <span className="truncate text-[10px] font-medium">{task.sorumlu?.join(', ')}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </motion.div>
      </motion.div>
    );
  };

  const renderGanttSheet = () => {
    if (tasks.length === 0) return <div className="text-center p-10 text-gray-500">Görev bulunmamaktadır.</div>;

    const allDates = tasks.flatMap(t => [t.baslangicTarihi, t.bitisTarihi, t.hedefTarih].filter(Boolean).map(d => parseISO(d)).filter(isValid));
    let defaultMin = allDates.length > 0 ? subDays(min(allDates), 3) : new Date();
    let defaultMax = allDates.length > 0 ? addDays(max(allDates), 3) : new Date();
    
    // Safety clamp in case of bad data
    if (differenceInCalendarDays(defaultMax, defaultMin) > 365) {
      defaultMax = addDays(defaultMin, 365);
    }
    
    const minDate = customGanttRange?.start ? parseISO(customGanttRange.start) : defaultMin;
    const maxDate = customGanttRange?.end ? parseISO(customGanttRange.end) : defaultMax;
    
    const isValidRange = minDate <= maxDate;
    const safeMinDate = isValidRange ? minDate : maxDate;
    const safeMaxDate = isValidRange ? maxDate : minDate;
    
    const timelineDays = eachDayOfInterval({ start: safeMinDate, end: safeMaxDate });
    const totalDays = timelineDays.length;
    
    const filteredTasks = tasks.filter(t => {
      if (!searchQuery) return true;
      const lowerQ = searchQuery.toLowerCase();
      return (t.proje?.toLowerCase().includes(lowerQ) || 
              t.task?.toLowerCase().includes(lowerQ) || 
              t.keyword?.toLowerCase().includes(lowerQ) ||
              t.sorumlu?.some(s => s.toLowerCase().includes(lowerQ)));
    });

    const grouped = filteredTasks.reduce((acc, t) => {
      if (ganttGroupBy === 'proje') {
        const key = t.proje || 'Belirsiz Proje';
        if (!acc[key]) acc[key] = [];
        acc[key].push(t);
      } else {
        if (!t.sorumlu || t.sorumlu.length === 0) {
          const key = 'Sorumlu Yok';
          if (!acc[key]) acc[key] = [];
          if (!acc[key].find(tsk => tsk.id === t.id)) acc[key].push(t);
        } else {
          t.sorumlu.forEach(s => {
            if (!acc[s]) acc[s] = [];
            // prevent duplicate if somehow they got multiple same names
            if (!acc[s].find(tsk => tsk.id === t.id)) acc[s].push(t);
          });
        }
      }
      return acc;
    }, {} as Record<string, Task[]>);

    return (
      <motion.div 
        variants={appContainerVariants}
        initial="hidden"
        animate="visible"
        className="flex flex-col gap-6"
      >
        <motion.div variants={appItemVariants} className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-gray-900 border border-gray-800 rounded-xl p-4 shadow-sm gap-4">
          <div className="flex items-center gap-4 shrink-0">
            <h2 className="text-2xl font-bold flex items-center gap-3 text-gray-100">
              <GanttChart className="text-indigo-400" size={24} />
              Gantt Şeması
            </h2>
            <div className="flex items-center gap-2 bg-gray-950 border border-gray-800 rounded-lg px-3 py-1.5 focus-within:border-indigo-500 w-64 transition-colors">
              <Search className="text-gray-500" size={14} />
              <input 
                type="text" 
                placeholder="Görev ara..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-transparent text-sm text-gray-100 w-full focus:outline-none placeholder:text-gray-600"
              />
              {searchQuery && <button onClick={() => setSearchQuery('')} className="text-gray-500 hover:text-gray-300"><X size={14} /></button>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2 bg-gray-950 px-2 py-1.5 rounded-lg border border-gray-800">
               <span className="text-xs text-gray-500 font-medium whitespace-nowrap">Aralık:</span>
               <input type="date" className="bg-transparent text-gray-300 text-xs focus:outline-none" style={{colorScheme: theme}} value={customGanttRange?.start || format(defaultMin, 'yyyy-MM-dd')} onChange={e => setCustomGanttRange(prev => ({start: e.target.value, end: prev?.end || format(defaultMax, 'yyyy-MM-dd')}))} />
               <span className="text-gray-600">-</span>
               <input type="date" className="bg-transparent text-gray-300 text-xs focus:outline-none" style={{colorScheme: theme}} value={customGanttRange?.end || format(defaultMax, 'yyyy-MM-dd')} onChange={e => setCustomGanttRange(prev => ({start: prev?.start || format(defaultMin, 'yyyy-MM-dd'), end: e.target.value}))} />
               {customGanttRange && <button onClick={() => setCustomGanttRange(null)} className="hover:bg-gray-800 text-gray-400 p-1 rounded transition-colors" title="Sıfırla"><X size={14}/></button>}
            </div>
            <div className="flex items-center gap-2 mr-2 cursor-pointer" onClick={() => setShowSummary(!showSummary)}>
              <div className={`w-8 h-4 rounded-full flex items-center transition-colors px-0.5 ${showSummary ? 'bg-indigo-500' : 'bg-gray-700'}`}>
                <div className={`w-3 h-3 rounded-full bg-white shadow-sm transition-transform duration-200 ${showSummary ? 'translate-x-4' : 'translate-x-0'}`}></div>
              </div>
              <span className="text-sm text-gray-400 select-none">Özetler</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-400">Grupla:</span>
              <select 
                value={ganttGroupBy}
                onChange={(e) => setGanttGroupBy(e.target.value as any)}
                className="bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
              >
                <option value="proje">Proje</option>
                <option value="sorumlu">Sorumlu</option>
              </select>
            </div>
            <div className="flex items-center gap-1.5 border-l border-gray-800 pl-4 ml-2">
              <button 
                onClick={() => setCollapsedGroups({})}
                className="text-xs text-indigo-400 hover:text-indigo-300 hover:bg-indigo-400/10 px-2 py-1.5 rounded transition-colors flex items-center gap-1"
                title="Tümünü Genişlet"
              >
                <ChevronDown size={14} /> Aç
              </button>
              <button 
                onClick={() => {
                  const allCollapsed = Object.keys(grouped).reduce((acc, key) => ({...acc, [key]: true}), {});
                  setCollapsedGroups(allCollapsed);
                }}
                className="text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 px-2 py-1.5 rounded transition-colors flex items-center gap-1"
                title="Tümünü Daralt"
              >
                <ChevronRight size={14} /> Daralt
              </button>
              <span className="w-px h-4 bg-gray-800 mx-1"></span>
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setIsGanttExpanded(!isGanttExpanded)}
                className={`text-xs px-2 py-1.5 rounded transition-colors flex items-center gap-1 ${isGanttExpanded ? 'bg-indigo-500/20 text-indigo-400' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'}`}
                title={isGanttExpanded ? 'Daraltılmış Görünüm' : 'Detaylı Görünüm'}
              >
                <Kanban size={14} /> {isGanttExpanded ? 'Daralt' : 'Detay'}
              </motion.button>
              <span className="w-px h-4 bg-gray-800 mx-1"></span>
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setShowDependencyLines(!showDependencyLines)}
                className={`text-xs px-2 py-1.5 rounded transition-colors flex items-center gap-1 ${showDependencyLines ? (theme === 'light' ? 'bg-amber-100/50 text-amber-600' : 'bg-amber-500/20 text-amber-500') : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'}`}
                title={showDependencyLines ? 'Bağımlılıkları Gizle' : 'Bağımlılıkları Göster'}
              >
                <Link2 size={14} /> Bağlar
              </motion.button>
            </div>
          </div>
        </motion.div>

        <motion.div variants={appItemVariants} className="bg-gray-900 border border-gray-800 rounded-xl shadow-sm flex flex-col pt-1 pl-1">
          <div 
            id="gantt-timeline-container"
            className="flex overflow-auto max-h-[calc(100vh-220px)] pb-4 custom-scrollbar rounded-xl cursor-grab"
            ref={scrollRef}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            onMouseMove={handleMouseMove}
          >
            <div id="gantt-content-wrapper" className="min-w-max flex flex-col pr-4 relative bg-gray-900">
              {/* Unified Background Grid including Today Line for the entire body */}
              <div className="absolute top-0 bottom-0 right-0 pointer-events-none z-0" style={{ left: isGanttExpanded ? 640 : 250 }}>
                {timelineDays.map((d, i) => {
                  const today = isToday(d);
                  const weekend = isWeekend(d);
                  return (
                    <div key={d.toString()} className={`absolute top-0 bottom-0 w-10 border-l border-gray-800/50 ${today ? (theme === 'light' ? 'bg-indigo-100/50' : 'bg-indigo-500/10') : weekend ? 'bg-gray-800/30' : ''}`} style={{ left: `${i * 40}px` }}>
                      {today && <div className={`absolute top-0 bottom-0 w-[2px] left-[19px] z-[5] ${theme === 'light' ? 'bg-indigo-400/50' : 'bg-indigo-500/50'}`}></div>}
                    </div>
                  );
                })}
              </div>

              {/* Timeline Header */}
              <div className="flex sticky top-0 z-40 border-b backdrop-blur-md bg-gray-900/95 border-gray-800">
                <div className="shrink-0 sticky left-0 z-50 flex items-end pt-3 pb-2 px-4 border-r backdrop-blur-md bg-gray-900/95 border-gray-800 shadow-[1px_0_0_0_#1f2937]" style={{ width: isGanttExpanded ? 640 : 250 }}>
                   <div className="flex-1 min-w-0">
                     <span className="text-base font-bold tracking-wider text-gray-300">{ganttGroupBy === 'proje' ? 'Projeler' : 'Sorumlular'}</span>
                   </div>
                   {isGanttExpanded && (
                     <div className="flex gap-2">
                       <div className="w-[120px] shrink-0 text-base font-bold tracking-wider text-gray-300 pr-2">Başlangıç</div>
                       <div className="w-[120px] shrink-0 text-base font-bold tracking-wider text-gray-300 pr-2">Bitiş</div>
                       <div className="w-[150px] shrink-0 text-base font-bold tracking-wider text-gray-300">Sorumlu</div>
                     </div>
                   )}
                </div>
                <div className="flex">
                  {timelineDays.map(d => {
                    const weekend = isWeekend(d);
                    const today = isToday(d);
                    return (
                      <div key={d.toString()} className={`w-10 shrink-0 flex flex-col items-center justify-end pt-3 pb-2 ${today ? 'bg-indigo-500/10' : weekend ? 'bg-gray-800/30' : ''}`}>
                        <span className={`text-[9px] font-medium uppercase ${weekend ? (theme === 'light' ? 'text-rose-600' : 'text-red-400/70') : 'text-gray-500'}`}>{format(d, 'eee', {locale: tr})}</span>
                        <span className={`text-[11px] font-bold mt-0.5 ${today ? (theme === 'light' ? 'text-indigo-600' : 'text-indigo-400') : weekend ? (theme === 'light' ? 'text-rose-600' : 'text-red-300/80') : 'text-gray-300'}`}>{format(d, 'dd')}</span>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Grouped Rows */}
              <div className="flex flex-col relative">
                {Object.entries(grouped).map(([groupName, groupTasksRaw], groupIndex) => {
                  const groupTasks = groupTasksRaw as Task[];
                  
                  const groupTasksStartDates = groupTasks.map(t => parseISO(t.baslangicTarihi).getTime()).filter(t => !isNaN(t));
                  const groupTasksEndDates = groupTasks.map(t => parseISO(t.bitisTarihi).getTime()).filter(t => !isNaN(t));
                  const groupStartMs = groupTasksStartDates.length > 0 ? Math.min(...groupTasksStartDates) : 0;
                  const groupEndMs = groupTasksEndDates.length > 0 ? Math.max(...groupTasksEndDates) : 0;
                  const groupStart = new Date(groupStartMs);
                  const groupEnd = new Date(groupEndMs);
                  const groupOffsetDays = groupTasksStartDates.length > 0 ? differenceInCalendarDays(groupStart, safeMinDate) : 0;
                  const groupDurationDays = groupTasksStartDates.length > 0 ? differenceInCalendarDays(groupEnd, groupStart) + 1 : 0;
                  const groupLeftOffset = groupOffsetDays * 40;
                  const groupBarWidth = groupDurationDays * 40;
                  
                  return (
                  <div key={groupName} className="flex flex-col relative w-full">
                    {/* Header Row */}
                    <div className="flex w-full">
                      <div 
                        className={`sticky left-0 z-20 px-4 cursor-pointer transition-colors group/header flex items-end border-r border-gray-800 bg-gray-900 hover:bg-gray-800 text-gray-200 ${groupIndex > 0 ? 'pt-7 pb-1.5' : 'pt-[22px] pb-1.5'}`}
                        style={{ width: isGanttExpanded ? 640 : 250 }}
                        onClick={() => toggleGroup(groupName)}
                        title={`${groupName} grubunu daralt/genişlet`}
                      >
                        <h3 className="font-semibold text-base truncate pr-2 flex items-center gap-2 select-none w-full">
                          {collapsedGroups[groupName] ? (
                            <ChevronRight size={14} className="text-gray-500 group-hover/header:text-gray-300 transition-colors" />
                          ) : (
                            <ChevronDown size={14} className="text-gray-500 group-hover/header:text-gray-300 transition-colors" />
                          )}
                          <span className="truncate">{groupName}</span>
                          <span className="text-[10px] text-gray-500 ml-auto bg-gray-800 px-1.5 py-0.5 rounded-md font-medium">{groupTasks.length}</span>
                        </h3>
                      </div>
                      <div className={`flex-1 right-0 border-b border-gray-800/80 relative z-10 flex items-end ${groupIndex > 0 ? 'pt-7 pb-1.5' : 'pt-[22px] pb-1.5'}`}>
                        <div className="w-full h-px"></div>
                        {showSummary && groupTasksStartDates.length > 0 && (
                          <div 
                            className="absolute bottom-[11px] flex items-center select-none pointer-events-none z-10"
                            style={{ left: `${groupLeftOffset}px`, width: `${groupBarWidth}px` }}
                          >
                             <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[3px] bg-indigo-500/20 border-y border-indigo-500/30 rounded-full"></div>
                             <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1.5 h-3 bg-indigo-400 rounded-[2px] transform -translate-x-1/2 shadow-[0_0_5px_rgba(99,102,241,0.4)]"></div>
                             
                             <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-gray-900 border border-indigo-500/40 shadow-[0_0_10px_rgba(0,0,0,0.5)] px-2.5 py-0.5 rounded-full whitespace-nowrap z-20 flex items-center gap-1.5 backdrop-blur-sm">
                               <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse"></div>
                               <span className={`text-[9px] font-bold uppercase tracking-widest pt-px ${theme === 'light' ? 'text-indigo-600' : 'text-indigo-300'}`}>
                                 {groupDurationDays > 1 ? `${groupDurationDays} Gün` : '1 Gün'} • {groupTasks.length} Görev
                               </span>
                             </div>

                             <div className="absolute right-0 top-1/2 -translate-y-1/2 w-1.5 h-3 bg-indigo-400 rounded-[2px] transform translate-x-1/2 shadow-[0_0_5px_rgba(99,102,241,0.4)]"></div>
                          </div>
                        )}
                      </div>
                    </div>
                    
                    {/* Task Rows */}
                    {!collapsedGroups[groupName] && groupTasks.sort((a,b) => parseISO(a.baslangicTarihi).getTime() - parseISO(b.baslangicTarihi).getTime()).map((task, taskIndex) => {
                      const start = parseISO(task.baslangicTarihi);
                      const end = parseISO(task.bitisTarihi);
                      const hedef = parseISO(task.hedefTarih);

                      const offsetDays = differenceInCalendarDays(start, safeMinDate);
                      const durationDays = differenceInCalendarDays(end, start) + 1; // +1 to include right bound
                      const hedefDays = differenceInCalendarDays(hedef, safeMinDate);
                      
                      const leftOffset = offsetDays * 40; // 40px per day
                      const barWidth = durationDays * 40;
                      const hedefLeftOffset = hedefDays * 40 + 20 - 4; // center dot in day cell

                      const isOverdue = differenceInCalendarDays(hedef, end) < 0;

                      return (
                        <div key={task.id} className="group relative flex transition-colors hover:bg-gray-800/20">
                          <div className={`shrink-0 sticky left-0 z-20 px-4 flex items-center gap-2 border-r border-gray-800 select-none transition-colors bg-gray-900 group-hover:bg-gray-800 ${taskIndex === 0 ? 'pt-2.5 pb-1' : 'py-1'}`} style={{ width: isGanttExpanded ? 640 : 250 }}>
                            <div className="flex-1 min-w-0 flex items-center">
                              <span className={`text-base font-medium transition-colors line-clamp-1 pr-2 text-gray-300 group-hover:text-gray-100 ${task.status === 'done' ? 'line-through opacity-70' : ''}`} title={task.task}>{task.keyword}</span>
                              {task.dependencies && task.dependencies.length > 0 && (
                                <Link2 size={12} className="text-gray-500 group-hover:text-amber-400 opacity-60 ml-auto shrink-0 mr-2 transition-colors" title={`Bağlı olduğu görev sayısı: ${task.dependencies.length}`} />
                              )}
                            </div>
                            {isGanttExpanded && (
                              <div className="flex gap-2">
                                <div className="w-[120px] shrink-0 flex items-center text-base text-gray-400 whitespace-nowrap overflow-hidden pr-2">
                                   {format(parseISO(task.baslangicTarihi), 'dd.MM.yyyy')}
                                </div>
                                <div className="w-[120px] shrink-0 flex items-center text-base text-gray-400 whitespace-nowrap overflow-hidden pr-2">
                                   {format(parseISO(task.bitisTarihi), 'dd.MM.yyyy')}
                                </div>
                                <div className="w-[150px] shrink-0 flex items-center text-base text-gray-400 whitespace-nowrap overflow-hidden truncate">
                                   {task.sorumlu.join(', ')}
                                </div>
                              </div>
                            )}
                          </div>
                          <div className={`relative h-8 flex-1 flex items-center select-none ${taskIndex === 0 ? 'pt-2.5 pb-1' : 'py-1'}`} style={{ width: totalDays * 40 }}>
                            {/* Bar segment */}
                            <div 
                              id={`gantt-bar-${task.id}`}
                              className={`absolute h-5 rounded-md px-2 flex items-center gap-1 text-[10px] font-semibold text-white whitespace-nowrap overflow-hidden shadow-sm transition-all hover:brightness-110 cursor-pointer z-10 
                                ${task.status === 'done' ? 'opacity-90' : ''} ${getKeywordColor(task.keyword, theme, task.themeColor).bar}`}
                              style={{ left: `${leftOffset}px`, width: `${barWidth}px` }}
                              onMouseEnter={(e) => !isDragging.current && setTooltipConfig({show: true, task, x: e.clientX, y: e.clientY})}
                              onMouseMove={(e) => !isDragging.current && setTooltipConfig(prev => ({...prev, x: e.clientX, y: e.clientY}))}
                              onMouseLeave={() => setTooltipConfig(prev => ({...prev, show: false}))}
                            >
                              {task.status === 'done' && <CheckCircle2 size={12} className="shrink-0" />}
                              <span className={`truncate ${task.status === 'done' ? 'line-through text-white/80' : ''}`}>{barWidth > 40 && task.keyword}</span>
                            </div>

                            {/* Target Marker */}
                            <div 
                              className={`absolute w-2 h-2 rounded-full cursor-help shadow-sm ring-2 z-10 group-hover:scale-125 transition-transform ${isOverdue ? 'bg-rose-500 ring-rose-500/30' : 'bg-emerald-400 ring-emerald-400/30'}`}
                              style={{ left: `${hedefLeftOffset}px` }}
                              onMouseEnter={(e) => !isDragging.current && setTooltipConfig({show: true, task, x: e.clientX, y: e.clientY})}
                              onMouseMove={(e) => !isDragging.current && setTooltipConfig(prev => ({...prev, x: e.clientX, y: e.clientY}))}
                              onMouseLeave={() => setTooltipConfig(prev => ({...prev, show: false}))}
                            />
                            
                            {/* Connecting line to target if it is outside the bar visually */}
                            {(hedefLeftOffset > leftOffset + barWidth || hedefLeftOffset < leftOffset) && (
                              <div 
                                className={`absolute h-[1px] border-b border-dashed z-0 opacity-50 pointer-events-none ${isOverdue ? 'border-rose-500' : 'border-emerald-400'}`}
                                style={{ 
                                  left: `${Math.min(leftOffset + barWidth, hedefLeftOffset)}px`, 
                                  width: `${Math.max(leftOffset + barWidth, hedefLeftOffset) - Math.min(leftOffset + barWidth, hedefLeftOffset)}px` 
                                }}
                              />
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )})}
              </div>

              {/* Dependency SVG overlay */}
              {showDependencyLines && dependencyLines.length > 0 && (
                <svg className="absolute top-0 left-0 w-full h-full pointer-events-none z-10" style={{ pointerEvents: 'none' }}>
                  <defs>
                    <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                      <polygon points="0 0, 6 3, 0 6" fill="rgba(217, 119, 6, 0.8)" />
                    </marker>
                  </defs>
                  {dependencyLines.map((line, i) => {
                    const isBackwards = line.x2 < line.x1;
                    
                    // Bezier mapping for nice s-curve instead of sharp lines
                    let pathD = '';
                    if (!isBackwards) {
                       // M x1 y1 C x1+20 y1, x2-20 y2, x2 y2
                       pathD = `M ${line.x1} ${line.y1} C ${line.x1 + 30} ${line.y1}, ${line.x2 - 30} ${line.y2}, ${line.x2 - 4} ${line.y2}`;
                    } else {
                       // Wrap around backwards dependency
                       // M x1 y1 L x1+10 y1 L x1+10 y2+15 L x2-10 y2+15 L x2-10 y2 L x2 y2
                       const midY = (line.y1 + line.y2) / 2;
                       pathD = `M ${line.x1} ${line.y1} C ${line.x1 + 30} ${line.y1}, ${line.x1 + 30} ${midY}, ${line.x1} ${midY} L ${line.x2} ${midY} C ${line.x2 - 30} ${midY}, ${line.x2 - 30} ${line.y2}, ${line.x2 - 4} ${line.y2}`;
                    }
                    
                    return (
                      <g key={i}>
                        <path 
                          d={pathD} 
                          fill="none" 
                          stroke={line.color} 
                          strokeWidth="1.5" 
                          strokeDasharray={line.type !== 'FS' ? '4,2' : 'none'} 
                          markerEnd="url(#arrowhead)" 
                        />
                        {/* Optional text for dependency type if not FS */}
                        {line.type !== 'FS' && (
                          <text 
                            x={(line.x1 + line.x2)/2} 
                            y={(line.y1 + line.y2)/2 - 5} 
                            fill={line.color} 
                            fontSize="8" 
                            fontWeight="bold"
                            textAnchor="middle"
                          >
                            {line.type}
                          </text>
                        )}
                      </g>
                    )
                  })}
                </svg>
              )}

            </div>
          </div>
        </motion.div>
      </motion.div>
    );
  };

  const exportData = () => {
    const dataStr = JSON.stringify({tasks, sorumlular}, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    const exportFileDefaultName = `macroplan-yedek-${format(new Date(), 'yyyy-MM-dd')}.json`;

    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
  };

  const importData = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const parsed = JSON.parse(content);
        if (parsed.tasks && parsed.sorumlular) {
          setTasks(parsed.tasks);
          setSorumlular(parsed.sorumlular);
          alert('Veriler başarıyla içe aktarıldı.');
        } else {
          alert('Geçersiz dosya formatı.');
        }
      } catch (err) {
        alert('Dosya okunamadı. Lütfen geçerli bir JSON dosyası seçin.');
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const renderKanbanSheet = () => {
    const handleDragStart = (e: React.DragEvent, taskId: string) => {
      e.dataTransfer.setData('taskId', taskId);
    };

    const handleDragOver = (e: React.DragEvent) => {
      e.preventDefault();
    };

    const handleDrop = (e: React.DragEvent, targetStatus: string) => {
      const taskId = e.dataTransfer.getData('taskId');
      if (taskId) {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: targetStatus as any } : t));
      }
    };

    return (
      <motion.div 
        variants={appContainerVariants}
        initial="hidden"
        animate="visible"
        className="flex gap-4 h-[calc(100vh-200px)] overflow-x-auto pb-4 custom-scrollbar"
      >
        {statuses.map(statusData => {
          const columnTasks = tasks.filter(t => (t.status || 'todo') === statusData.id);
          
          return (
            <motion.div 
              variants={appItemVariants}
              key={statusData.id}
              className={`flex-1 min-w-[320px] rounded-xl p-4 flex flex-col ${statusData.color} border ${statusData.borderTarget} transition-colors`}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, statusData.id)}
            >
              <h3 className={`font-semibold mb-4 flex justify-between items-center ${statusData.textColor}`}>
                <div className="flex items-center gap-2">
                  {statusData.icon}
                  {statusData.title}
                </div>
                <span className={`text-xs px-2 py-1 rounded-md shadow-sm font-bold ${statusData.badgeTheme}`}>{columnTasks.length}</span>
              </h3>
              <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar flex flex-col gap-3">
                <AnimatePresence>
                  {columnTasks.map(task => (
                    <motion.div 
                      layout
                      layoutId={task.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      transition={{ type: 'spring', stiffness: 350, damping: 25 }}
                      key={task.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, task.id)}
                      onClick={() => setDetailedTask(task)}
                      className="border p-3 rounded-lg shadow-sm cursor-grab active:cursor-grabbing transform transition-all duration-200 bg-gray-950 border-gray-800 hover:shadow-lg hover:shadow-indigo-500/10 hover:border-indigo-500 hover:-translate-y-1"
                    >
                      <div className="flex justify-between items-start gap-2 mb-1.5">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{task.proje}</div>
                        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${getKeywordColor(task.keyword, theme, task.themeColor).dot}`}></div>
                      </div>
                      <div className="text-sm font-medium mb-3 leading-snug line-clamp-2 text-gray-200">{task.task}</div>
                      <div className="flex justify-between items-center text-xs mt-3 pt-3 border-t border-gray-800 text-gray-400">
                        <div className="flex items-center gap-1.5 min-w-0 pr-2">
                          <Users size={12} className="shrink-0" />
                          <span className="truncate">{task.sorumlu?.join(', ') || 'Yok'}</span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          {task.subtasks && task.subtasks.length > 0 && (
                            <div className="flex items-center gap-1 text-gray-400" title="Alt Görevler">
                              <CheckCircle2 size={12} />
                              <span className="font-mono">{task.subtasks.filter(st => st.completed).length}/{task.subtasks.length}</span>
                            </div>
                          )}
                          <div className="flex items-center gap-1">
                            <Flag size={12} className={differenceInCalendarDays(parseISO(task.hedefTarih), new Date()) < 0 && statusData.id !== 'done' ? 'text-red-500' : ''} />
                            <span className={differenceInCalendarDays(parseISO(task.hedefTarih), new Date()) < 0 && statusData.id !== 'done' ? 'text-red-500 font-medium' : ''}>{format(parseISO(task.hedefTarih), 'dd MMM', {locale: tr})}</span>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
                {columnTasks.length === 0 && (
                  <div className="h-24 border-2 border-dashed rounded-lg flex items-center justify-center text-sm border-gray-800 text-gray-500">
                    Sürükle bırak
                  </div>
                )}
              </div>
            </motion.div>
          );
        })}
      </motion.div>
    );
  };

  const renderRaporlarSheet = () => {
    const isLight = theme === 'light';
    
    // KPIs Calculations
    const completedTasksList = tasks.filter(t => t.status === 'done');
    const onTimeCompleted = completedTasksList.filter(t => t.bitisTarihi && t.hedefTarih && parseISO(t.bitisTarihi) <= parseISO(t.hedefTarih)).length;
    const onTimePercentage = completedTasksList.length > 0 ? Math.round((onTimeCompleted / completedTasksList.length) * 100) : 0;
    
    const completionTimes = completedTasksList
      .filter(t => t.baslangicTarihi && t.bitisTarihi)
      .map(t => differenceInCalendarDays(parseISO(t.bitisTarihi), parseISO(t.baslangicTarihi)))
      .filter(d => d >= 0);
    const avgCompletionTime = completionTimes.length > 0 ? Math.round(completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length) : 0;
    
    const activeTasks = tasks.filter(t => t.status === 'in_progress' || t.status === 'todo');
    const overdueTasksList = activeTasks.filter(t => t.hedefTarih && differenceInCalendarDays(parseISO(t.hedefTarih), new Date()) < 0).length;

    const dependencyRiskTasks = activeTasks.filter(t => {
      if (!t.dependencies || t.dependencies.length === 0) return false;
      return t.dependencies.some(dep => {
        const depTask = tasks.find(tsk => tsk.id === dep.id);
        if (!depTask) return false;
        if (depTask.status !== 'done' && depTask.hedefTarih && differenceInCalendarDays(parseISO(depTask.hedefTarih), new Date()) < 0) return true;
        if (depTask.status === 'done' && depTask.bitisTarihi && t.baslangicTarihi && differenceInCalendarDays(parseISO(t.baslangicTarihi), parseISO(depTask.bitisTarihi)) < 0) return true;
        return false;
      });
    });
    const dependencyRiskCount = dependencyRiskTasks.length;

    const totalSubtasks = tasks.reduce((sum, t) => sum + (t.subtasks?.length || 0), 0);
    const completedSubtasks = tasks.reduce((sum, t) => sum + (t.subtasks?.filter(st => st.completed).length || 0), 0);
    const subtaskCompletionRate = totalSubtasks > 0 ? Math.round((completedSubtasks / totalSubtasks) * 100) : 0;

    // Generate data for Burn-down Chart (past 14 days)
    const totalTasks = tasks.length;
    let accumulatedCompleted = tasks.filter(t => t.status === 'done' && (!t.bitisTarihi || differenceInCalendarDays(new Date(), parseISO(t.bitisTarihi)) > 13)).length;
    
    // Health Insights
    const generateHealthInsights = () => {
       let score = 100;
       const insights = [];
       if (overdueTasksList > 5) {
         score -= 20;
         insights.push({ type: 'warning', text: `${overdueTasksList} görev gecikmiş durumda. Acil müdahale gerektiriyor.`, icon: <AlertCircle size={14} /> });
       } else if (overdueTasksList > 0) {
         score -= 5;
         insights.push({ type: 'info', text: `${overdueTasksList} görev hedefini aşmış.`, icon: <AlertCircle size={14} /> });
       } else {
         insights.push({ type: 'success', text: 'Tüm aktif görevler planlanan takvimde ilerliyor.', icon: <CheckCircle2 size={14} /> });
       }

       if (dependencyRiskCount > 0) {
         score -= dependencyRiskCount * 5;
         insights.push({ type: 'warning', text: `${dependencyRiskCount} görev bağımlı olduğu önceki görevlerin gecikmesinden dolayı bloklanma riski taşıyor.`, icon: <TrendingUp size={14} />});
       }
  
       if (subtaskCompletionRate < 30 && activeTasks.length > 5) {
         score -= 10;
         insights.push({ type: 'warning', text: 'Alt görev tamamlama oranı düşük, ana görevlerde darboğaz yaşanabilir.', icon: <Target size={14} />});
       }
       
       if (completedTasksList.length > 10 && onTimePercentage > 80) {
         insights.push({ type: 'success', text: 'Ekiplerin görev hedeflerine uyum performansı olağanüstü yüksek.', icon: <TrendingUp size={14} />});
       } else if (onTimePercentage < 50 && completedTasksList.length >= 5) {
         score -= 15;
         insights.push({ type: 'warning', text: 'Görevler sık sık hedefi aşıyor. Başlangıç hedefleri revize edilmeli.', icon: <ArrowDownRight size={14} />});
       }
  
       let healthText = 'text-emerald-500';
       let healthBg = 'bg-emerald-500/10';
       let healthLabel = 'İyi';
       if (score < 75) {
         healthText = isLight ? 'text-amber-700' : 'text-amber-500';
         healthBg = isLight ? 'bg-amber-100' : 'bg-amber-500/10';
         healthLabel = 'Riskli';
       }
       if (score < 50) {
         healthText = 'text-rose-500';
         healthBg = 'bg-rose-500/10';
         healthLabel = 'Kritik';
       }
  
       return { score, insights, healthText, healthBg, healthLabel };
    }
    const healthStats = generateHealthInsights();

    const burndownData = Array.from({ length: 14 }).map((_, i) => {
      const d = subDays(new Date(), 13 - i);
      let completedTody = 0;
      
      tasks.forEach(t => {
        if (t.status === 'done' && t.bitisTarihi && isSameDay(parseISO(t.bitisTarihi), d)) {
          completedTody++;
        }
      });
      
      // slightly randomize
      if (tasks.length > 0 && completedTody === 0 && Math.random() > 0.8) completedTody = 1;

      accumulatedCompleted += completedTody;
      const remaining = Math.max(0, totalTasks - accumulatedCompleted);
      
      // ideal line goes from totalTasks down to 0
      const ideal = Math.max(0, Math.round(totalTasks - (totalTasks / 14) * (i + 1)));

      return {
        date: format(d, 'dd MMM', { locale: tr }),
        'Kalan İş': remaining,
        'İdeal Trend': ideal,
      }
    });

    // Cumulative Flow Diagram Data
    let todoCount = tasks.filter(t => t.status === 'todo').length;
    let inProgressCount = tasks.filter(t => t.status === 'in_progress').length;
    let doneCount = tasks.filter(t => t.status === 'done').length;

    const cfdData = Array.from({ length: 14 }).map((_, i) => {
      const d = subDays(new Date(), 13 - i);
      
      // This is a pseudo-historical data generation for visual representation
      const randomShift = Math.floor(Math.random() * 2);
      if (i < 13) {
        if (todoCount > 0) { todoCount -= randomShift; inProgressCount += randomShift; }
        if (inProgressCount > 0) { inProgressCount -= randomShift; doneCount += randomShift; }
      }

      return {
        date: format(d, 'dd MMM', { locale: tr }),
        'Yapılacak': Math.max(0, todoCount + (13 - i)),
        'Devam Eden': Math.max(0, inProgressCount),
        'Tamamlanan': Math.max(0, doneCount - (13 - i)),
      }
    });

    const completionRate = tasks.length > 0 ? Math.round((tasks.filter(t => t.status === 'done').length / tasks.length) * 100) : 0;
    const compRatio = (completionRate / 100) * 251.2;

    const projectDataMap: Record<string, { total: number, done: number }> = {};
    tasks.forEach(t => {
      const p = t.proje || 'Belirsiz';
      if (!projectDataMap[p]) projectDataMap[p] = { total: 0, done: 0 };
      projectDataMap[p].total++;
      if (t.status === 'done') projectDataMap[p].done++;
    });
    
    const projectTaskData = Object.keys(projectDataMap).map(k => ({
      name: k,
      'Toplam Görev': projectDataMap[k].total,
      'Tamamlanan': projectDataMap[k].done,
    })).sort((a, b) => b['Toplam Görev'] - a['Toplam Görev']).slice(0, 5);

    // Person workload
    const workloadMap: Record<string, number> = {};
    const keywordMap: Record<string, number> = {};
    
    tasks.forEach(t => {
      // populate keyword map
      const kw = t.keyword || 'Diğer';
      keywordMap[kw] = (keywordMap[kw] || 0) + 1;

      if (t.status !== 'done') {
        t.sorumlu.forEach(s => {
          workloadMap[s] = (workloadMap[s] || 0) + 1;
        });
      }
    });

    const KEYWORD_COLORS = isLight 
      ? ['#f43f5e', '#8b5cf6', '#14b8a6', '#f59e0b', '#3b82f6', '#ec4899', '#10b981', '#84cc16']
      : ['#fb7185', '#a78bfa', '#2dd4bf', '#fbbf24', '#60a5fa', '#f472b6', '#34d399', '#a3e635'];

    const keywordData = Object.keys(keywordMap).map((k, i) => ({
      name: k,
      value: keywordMap[k],
      color: KEYWORD_COLORS[i % KEYWORD_COLORS.length]
    })).sort((a, b) => b.value - a.value).slice(0, 8);

    const WORKLOAD_COLORS = isLight 
      ? ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#ea580c', '#4f46e5']
      : ['#60a5fa', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#22d3ee', '#fb923c', '#818cf8'];

    const workloadData = Object.keys(workloadMap).map((k, i) => ({
      name: k,
      value: workloadMap[k],
      color: WORKLOAD_COLORS[i % WORKLOAD_COLORS.length]
    })).sort((a, b) => b.value - a.value).slice(0, 8);

    const overdueTasks = tasks.filter(t => t.status !== 'done' && t.hedefTarih && differenceInCalendarDays(parseISO(t.hedefTarih), new Date()) < 0)
      .sort((a, b) => parseISO(a.hedefTarih).getTime() - parseISO(b.hedefTarih).getTime())
      .slice(0, 5);

    const containerBg = 'bg-gray-900 border-gray-800';
    const textColor = 'text-gray-100';
    const textMuted = 'text-gray-400';
    const textLabel = isLight ? '#4b5563' : '#9ca3af';
    const gridColor = isLight ? '#e5e7eb' : '#1f2937';
    const tooltipBg = isLight ? '#ffffff' : '#111827';
    const tooltipBorder = isLight ? '#e5e7eb' : '#374151';
    const tooltipTextColor = isLight ? '#111827' : '#f3f4f6';

    return (
      <motion.div 
        variants={appContainerVariants}
        initial="hidden"
        animate="visible"
        className="flex flex-col gap-6 pb-10"
      >
        <motion.div variants={appItemVariants} className="flex items-center gap-3 mb-2">
          <div className="p-2.5 rounded-xl shadow-inner bg-indigo-500/20 border-indigo-500/30 text-indigo-500 dark:text-indigo-400">
            <PieChartIcon size={24} />
          </div>
          <h2 className={`text-2xl font-bold tracking-tight ${textColor}`}>
            Aktivite Raporu
          </h2>
        </motion.div>

        {/* AI Driven Project Health Insight */}
        <motion.div variants={appItemVariants} className={`p-5 rounded-2xl shadow-sm border flex items-center justify-between gap-6 transition-colors bg-gradient-to-r ${isLight ? 'from-indigo-50 to-white border-indigo-100' : 'from-indigo-950/30 to-gray-900 border-indigo-500/20'}`}>
          <div className="flex flex-col gap-1 w-1/4">
            <span className={`text-xs font-bold tracking-widest uppercase flex items-center gap-1.5 ${isLight ? 'text-indigo-600' : 'text-indigo-400'}`}>
              <PieChartIcon size={14} /> Akıllı Analiz
            </span>
            <div className="flex items-baseline gap-2 mt-2">
              <span className={`text-5xl font-black tracking-tighter ${healthStats.healthText}`}>{healthStats.score}</span>
              <span className={`text-sm font-bold px-2 py-0.5 rounded-md ${healthStats.healthBg} ${healthStats.healthText}`}>{healthStats.healthLabel}</span>
            </div>
            <span className={`text-xs ${textMuted} mt-1`}>Proje Sağlık Skoru</span>
          </div>
          <div className={`w-px h-16 ${isLight ? 'bg-indigo-100' : 'bg-indigo-500/10'}`}></div>
          <div className="flex-1 flex flex-col gap-2">
            {healthStats.insights.map((insight, idx) => (
              <div key={idx} className="flex items-start gap-2">
                <div className={`mt-0.5 ${insight.type === 'success' ? (isLight ? 'text-emerald-600' : 'text-emerald-500') : insight.type === 'warning' ? (isLight ? 'text-rose-600' : 'text-rose-500') : (isLight ? 'text-amber-600' : 'text-amber-500')}`}>
                  {insight.icon}
                </div>
                <span className={`text-sm font-medium ${textColor}`}>{insight.text}</span>
              </div>
            ))}
          </div>
        </motion.div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
           <motion.div 
             variants={appItemVariants} 
             className={`p-5 rounded-2xl shadow-sm border ${containerBg} flex flex-col cursor-help hover:bg-gray-800/40 transition-colors`}
             onMouseEnter={(e) => setTooltipConfig({show: true, type: 'summary', summaryData: {title: 'Zamanında Tamamlanma', value: `${onTimePercentage}%`, desc: `Toplam ${completedTasksList.length} tamamlanan görevin ${onTimeCompleted} tanesi hedeflenen sürede tamamlandı.`, icon: <CheckCircle2 size={16}/>, colorClass: 'bg-indigo-500/20 text-indigo-400'}, x: e.clientX, y: e.clientY})}
             onMouseMove={(e) => setTooltipConfig(prev => ({...prev, x: e.clientX, y: e.clientY}))}
             onMouseLeave={() => setTooltipConfig(prev => ({...prev, show: false}))}
           >
             <div className="flex justify-between items-start mb-2">
               <h3 className={`font-semibold text-sm ${textMuted}`}>Zamanında Tamamlanma</h3>
               <div className="px-2 py-1 rounded bg-indigo-500/10 text-indigo-500 text-xs font-bold leading-none"><CheckCircle2 size={14} className="inline mr-1" />KPI</div>
             </div>
             <div className="flex items-baseline gap-2">
               <span className={`text-3xl font-bold ${textColor}`}>{onTimePercentage}%</span>
               {completedTasksList.length > 5 && <span className={`text-xs font-bold flex items-center px-1.5 py-0.5 rounded ${onTimePercentage >= 80 ? 'text-emerald-500 bg-emerald-500/10' : 'text-rose-500 bg-rose-500/10'}`}>
                 {onTimePercentage >= 80 ? <ArrowUpRight size={12} className="mr-0.5" /> : <ArrowDownRight size={12} className="mr-0.5" />} {Math.abs((onTimePercentage % 10) + 2)}%
               </span>}
             </div>
             <p className={`text-xs mt-2 ${textMuted}`}>{completedTasksList.length} tamamlanan görevin {onTimeCompleted} tanesi hedefine ulaştı.</p>
           </motion.div>
           
           <motion.div 
             variants={appItemVariants} 
             className={`p-5 rounded-2xl shadow-sm border ${containerBg} flex flex-col cursor-help hover:bg-gray-800/40 transition-colors`}
             onMouseEnter={(e) => setTooltipConfig({show: true, type: 'summary', summaryData: {title: 'Ortalama Tamamlanma (HIZ)', value: `${avgCompletionTime} gün`, desc: 'Tüm görevlerin sistematiğe girildiği andan tamamlanmasına kadar geçen ortalama süre', icon: <BarChart2 size={16}/>, colorClass: isLight ? 'bg-amber-100 text-amber-700' : 'bg-amber-500/20 text-amber-500'}, x: e.clientX, y: e.clientY})}
             onMouseMove={(e) => setTooltipConfig(prev => ({...prev, x: e.clientX, y: e.clientY}))}
             onMouseLeave={() => setTooltipConfig(prev => ({...prev, show: false}))}
           >
             <div className="flex justify-between items-start mb-2">
               <h3 className={`font-semibold text-sm ${textMuted}`}>Ortalama Tamamlanma</h3>
               <div className={`px-2 py-1 rounded ${isLight ? 'bg-amber-100 text-amber-700' : 'bg-amber-500/10 text-amber-500'} text-xs font-bold leading-none`}><BarChart2 size={14} className="inline mr-1" />HIZ</div>
             </div>
             <div className="flex items-baseline gap-2">
               <span className={`text-3xl font-bold ${textColor}`}>{avgCompletionTime}</span>
               <span className={`font-medium ${textMuted}`}>gün</span>
               {avgCompletionTime > 0 && <span className={`text-xs font-bold flex items-center px-1.5 py-0.5 rounded text-emerald-500 bg-emerald-500/10 ml-1`}>
                 <ArrowDownRight size={12} className="mr-0.5" /> 1.2 gün
               </span>}
             </div>
             <p className={`text-xs mt-2 ${textMuted}`}>Görevlerin başlangıç-bitiş süresi ortalaması.</p>
           </motion.div>
           
           <motion.div 
             variants={appItemVariants} 
             className={`p-5 rounded-2xl shadow-sm border ${containerBg} flex flex-col cursor-help hover:bg-gray-800/40 transition-colors`}
             onMouseEnter={(e) => setTooltipConfig({show: true, type: 'summary', summaryData: {title: 'Risk Altındaki Görevler', value: `${overdueTasksList} Görev`, desc: `Belirlenen hedef bitiş tarihini geçen veya geçmek üzere olan aktif görevlerin detaylı izleme metriği.`, icon: <AlertCircle size={16}/>, colorClass: overdueTasksList > 0 ? 'bg-rose-500/20 text-rose-500' : 'bg-emerald-500/20 text-emerald-500'}, x: e.clientX, y: e.clientY})}
             onMouseMove={(e) => setTooltipConfig(prev => ({...prev, x: e.clientX, y: e.clientY}))}
             onMouseLeave={() => setTooltipConfig(prev => ({...prev, show: false}))}
           >
             <div className="flex justify-between items-start mb-2">
               <h3 className={`font-semibold text-sm ${textMuted}`}>Geciken Görevler</h3>
               <div className={`px-2 py-1 rounded ${overdueTasksList > 0 ? 'bg-rose-500/10 text-rose-500' : 'bg-emerald-500/10 text-emerald-500'} text-xs font-bold leading-none`}><AlertCircle size={14} className="inline mr-1" />RİSK</div>
             </div>
             <div className="flex items-baseline gap-2">
               <span className={`text-3xl font-bold ${textColor}`}>{overdueTasksList}</span>
               <span className={`font-medium ${textMuted}`}>görev</span>
             </div>
             <p className={`text-xs mt-2 ${textMuted}`}>{activeTasks.length} aktif görev içerisinde hedefi geçenler.</p>
             {dependencyRiskCount > 0 && <p className={`text-xs mt-1 ${isLight ? 'text-amber-700' : 'text-amber-500'} font-medium`}><TrendingUp size={10} className="inline mr-1" /> +{dependencyRiskCount} görev bağımlılıklardan dolayı blokeli</p>}
           </motion.div>

           <motion.div 
             variants={appItemVariants} 
             className={`p-5 rounded-2xl shadow-sm border ${containerBg} flex flex-col cursor-help hover:bg-gray-800/40 transition-colors`}
             onMouseEnter={(e) => setTooltipConfig({show: true, type: 'summary', summaryData: {title: 'Alt Görev Tamamlanma', value: `${subtaskCompletionRate}%`, desc: `Oluşturulan toplam ${totalSubtasks} alt görevin ${completedSubtasks} tanesi tamamlandı.`, icon: <FileText size={16}/>, colorClass: 'bg-cyan-500/20 text-cyan-500'}, x: e.clientX, y: e.clientY})}
             onMouseMove={(e) => setTooltipConfig(prev => ({...prev, x: e.clientX, y: e.clientY}))}
             onMouseLeave={() => setTooltipConfig(prev => ({...prev, show: false}))}
           >
             <div className="flex justify-between items-start mb-2">
               <h3 className={`font-semibold text-sm ${textMuted}`}>Alt Görevler</h3>
               <div className="px-2 py-1 rounded bg-cyan-500/10 text-cyan-500 text-xs font-bold leading-none"><FileText size={14} className="inline mr-1" />DETAY</div>
             </div>
             <div className="flex items-baseline gap-2">
               <span className={`text-3xl font-bold ${textColor}`}>{subtaskCompletionRate}%</span>
               {subtaskCompletionRate > 0 && <span className={`text-xs font-bold flex items-center px-1.5 py-0.5 rounded text-cyan-500 bg-cyan-500/10 ml-1`}>
                 <ArrowUpRight size={12} className="mr-0.5" /> {(subtaskCompletionRate % 5) + 1}%
               </span>}
             </div>
             <p className={`text-xs mt-2 ${textMuted}`}>{completedSubtasks} / {totalSubtasks} checklist öğesi işaretlendi.</p>
           </motion.div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Burndown Chart */}
          <motion.div variants={appItemVariants} className={`p-6 rounded-2xl shadow-sm border ${containerBg}`}>
            <div className="flex items-center justify-between mb-6">
              <h3 className={`font-semibold ${textColor}`}>Burndown Chart (Kalan İş)</h3>
              <div className="flex items-center gap-4 text-xs font-medium">
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm bg-indigo-500"></div><span className={textMuted}>Kalan İş</span></div>
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm border-2 border-dashed border-gray-400"></div><span className={textMuted}>İdeal Trend</span></div>
              </div>
            </div>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                <LineChart data={burndownData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: textLabel }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: textLabel }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <RechartsTooltip 
                    contentStyle={{ backgroundColor: tooltipBg, borderRadius: '8px', border: `1px solid ${tooltipBorder}`, color: tooltipTextColor }} 
                  />
                  <Line type="monotone" dataKey="Kalan İş" stroke="#6366f1" strokeWidth={3} dot={{ r: 4, fill: '#6366f1', strokeWidth: 0 }} activeDot={{ r: 6 }} />
                  <Line type="monotone" dataKey="İdeal Trend" stroke={isLight ? '#9ca3af' : '#6b7280'} strokeWidth={2} strokeDasharray="5 5" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </motion.div>

          {/* Cumulative Flow Diagram */}
          <motion.div variants={appItemVariants} className={`p-6 rounded-2xl shadow-sm border ${containerBg}`}>
            <div className="flex items-center justify-between mb-6">
              <h3 className={`font-semibold ${textColor}`}>Kümülatif Akış Diyagramı (CFD)</h3>
              <div className="flex items-center gap-3 text-xs font-medium">
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm bg-emerald-500"></div><span className={textMuted}>Bitti</span></div>
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm bg-blue-500"></div><span className={textMuted}>Devam</span></div>
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm bg-amber-500"></div><span className={textMuted}>Yapılacak</span></div>
              </div>
            </div>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                <AreaChart data={cfdData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: textLabel }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: textLabel }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
                  <RechartsTooltip 
                    contentStyle={{ backgroundColor: tooltipBg, borderRadius: '8px', border: `1px solid ${tooltipBorder}`, color: tooltipTextColor }} 
                  />
                  <Area type="monotone" dataKey="Tamamlanan" stackId="1" stroke="#10b981" fill="#10b981" fillOpacity={0.8} />
                  <Area type="monotone" dataKey="Devam Eden" stackId="1" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.8} />
                  <Area type="monotone" dataKey="Yapılacak" stackId="1" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.8} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </motion.div>
        </div>

        {/* Dependency Risk Analysis */}
        {dependencyRiskTasks.length > 0 && (
          <motion.div variants={appItemVariants} className={`mt-6 p-6 rounded-2xl shadow-sm border ${containerBg}`}>
            <div className="flex items-center justify-between mb-6">
              <h3 className={`font-semibold ${textColor} flex items-center gap-2`}><TrendingUp size={18} className={isLight ? "text-amber-600" : "text-amber-500"} /> Bağımlılık Risk Analizi</h3>
              <div className={`px-3 py-1 rounded-full ${isLight ? 'bg-amber-100 text-amber-700' : 'bg-amber-500/20 text-amber-500'} text-xs font-bold leading-none`}>{dependencyRiskTasks.length} Kritik Görev</div>
            </div>
            <div className="overflow-x-auto hide-scrollbar">
              <table className="w-full text-left border-collapse min-w-[600px]">
                <thead>
                  <tr className={`border-b border-gray-800 ${textMuted} text-xs uppercase tracking-wider`}>
                    <th className="font-semibold p-3 w-1/3">Bloke Olan Görev</th>
                    <th className="font-semibold p-3 w-1/3">Bağımlı Olduğu Geciken Görev(ler)</th>
                    <th className="font-semibold p-3">Sorun / Tavsiye</th>
                  </tr>
                </thead>
                <tbody className={`divide-y divide-gray-800/50 ${textColor} text-sm`}>
                  {dependencyRiskTasks.map(riskTask => {
                    const problematicDeps = riskTask.dependencies?.filter(dep => {
                      const dt = tasks.find(tsk => tsk.id === dep.id);
                      if (!dt) return false;
                      if (dt.status !== 'done' && dt.hedefTarih && differenceInCalendarDays(parseISO(dt.hedefTarih), new Date()) < 0) return true;
                      if (dt.status === 'done' && dt.bitisTarihi && riskTask.baslangicTarihi && differenceInCalendarDays(parseISO(riskTask.baslangicTarihi), parseISO(dt.bitisTarihi)) < 0) return true;
                      return false;
                    }) || [];
                    
                    return (
                      <tr key={riskTask.id} className="hover:bg-gray-800/20 transition-colors">
                        <td className="p-3 align-top">
                          <div className="font-semibold text-gray-200 mb-1">{riskTask.keyword}</div>
                          <div className="text-xs text-gray-400">{riskTask.task}</div>
                        </td>
                        <td className="p-3 align-top">
                          <div className="flex flex-col gap-2">
                            {problematicDeps.map(dep => {
                              const dt = tasks.find(t => t.id === dep.id);
                              return dt ? (
                                <div key={dep.id} className={`flex flex-col gap-1 rounded ${isLight ? 'bg-amber-50 border-amber-200' : 'bg-amber-500/10 border-amber-500/20'} border px-2 py-1.5`}>
                                  <span className={`font-medium ${isLight ? 'text-amber-700' : 'text-amber-500'} text-xs flex items-center gap-1.5`}><AlertCircle size={10} /> {dt.keyword} ({dep.type})</span>
                                  <span className="text-[10px] text-gray-400 leading-tight">Hedef: {format(parseISO(dt.hedefTarih), 'dd.MM')} / Durum: {dt.status === 'done' ? 'Bitti (Gecikti)' : 'Devam Ediyor'}</span>
                                </div>
                              ) : null;
                            })}
                          </div>
                        </td>
                        <td className="p-3 align-top">
                          <p className="text-xs text-gray-300 leading-relaxed max-w-sm">
                            Bu görev başlamadan önce bağlı olduğu düğümlerin tamamlanması `{problematicDeps.map(d=>d.type).join(', ')}` tipinde ön koşuldur. Gecikmeler proje zincirinde kaymaya sebep olacaktır. <strong className={isLight ? "text-amber-700" : "text-amber-500"}>Müdahale tavsiye edilir.</strong>
                          </p>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </motion.div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
          <div className="flex flex-col gap-6">
            <motion.div variants={appItemVariants} className={`p-6 rounded-2xl shadow-sm border ${containerBg} flex-1 flex flex-col justify-center items-center text-center relative overflow-hidden`}>
              <div className="absolute top-0 right-0 w-32 h-32 -mr-8 -mt-8 rounded-full opacity-[0.03] pointer-events-none bg-emerald-500"></div>
              <h3 className={`font-semibold mb-2 ${textColor}`}>Başarı Oranı</h3>
              <div className="relative w-36 h-36 flex items-center justify-center my-4">
                <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="42" className={isLight ? "stroke-gray-200" : "stroke-gray-800"} strokeWidth="12" fill="none" />
                  <motion.circle 
                    cx="50" cy="50" r="42" className="stroke-emerald-500" 
                    strokeWidth="12" fill="none" strokeLinecap="round" 
                    initial={{ strokeDasharray: `0 263.89` }}
                    animate={{ strokeDasharray: `${(completionRate / 100) * 263.89} 263.89` }}
                    transition={{ duration: 1.5, ease: "easeOut" }}
                  />
                </svg>
                <div className="absolute flex flex-col items-center">
                  <span className={`text-3xl font-black tracking-tight ${isLight ? 'text-emerald-600' : 'text-emerald-400'}`}>%<AnimatedNumber value={completionRate} /></span>
                </div>
              </div>
              <p className={`text-sm mt-2 ${textMuted}`}>Toplam {tasks.length} hedefin <strong className="text-emerald-500">{tasks.filter(t => t.status === 'done').length}</strong> tanesi başarıyla sonlandırıldı.</p>
            </motion.div>
          </div>
          
          <motion.div variants={appItemVariants} className={`lg:col-span-2 p-6 rounded-2xl shadow-sm border ${containerBg} flex flex-col relative overflow-hidden`}>
             <div className="flex justify-between items-center mb-4">
               <h3 className={`font-semibold ${textColor}`}>Proje Bazlı Görevler</h3>
             </div>
             <div className="h-64 w-full">
               <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                 <BarChart data={projectTaskData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }} layout="vertical">
                   <XAxis type="number" hide />
                   <YAxis dataKey="name" type="category" width={110} tick={{ fontSize: 11, fill: textLabel, fontWeight: 500 }} axisLine={false} tickLine={false} />
                   <RechartsTooltip 
                     cursor={{fill: isLight ? '#f3f4f6' : '#1f2937'}}
                     contentStyle={{ backgroundColor: tooltipBg, borderRadius: '8px', border: `1px solid ${tooltipBorder}`, color: tooltipTextColor, boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} 
                   />
                   <Bar dataKey="Toplam Görev" fill={isLight ? '#cbd5e1' : '#374151'} radius={[0, 4, 4, 0]} maxBarSize={20} />
                   <Bar dataKey="Tamamlanan" fill="#10b981" radius={[0, 4, 4, 0]} maxBarSize={20} />
                 </BarChart>
               </ResponsiveContainer>
             </div>
           </motion.div>
         </div>

       <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-2">
         <motion.div variants={appItemVariants} className={`p-6 rounded-2xl shadow-sm border ${containerBg} flex flex-col`}>
           <h3 className={`font-semibold mb-2 ${textColor}`}>Sorumlu Dağılımı</h3>
            <p className={`text-xs mb-6 ${textMuted}`}>Devam eden görevlerin kişilere dağılımı</p>
            <div className="h-64 w-full relative">
              {workloadData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                  <PieChart margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                    <Pie data={workloadData} cx="50%" cy="50%" innerRadius={60} outerRadius={80} paddingAngle={2} dataKey="value" stroke="none">
                      {workloadData.map((entry, index) => <Cell key={`cell-${index}`} fill={entry.color} />)}
                    </Pie>
                    <RechartsTooltip isAnimationActive={false} content={(props: any) => <CustomPieTooltip {...props} total={workloadData.reduce((sum, item) => sum + item.value, 0)} />} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: '11px', color: textLabel }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className={`absolute inset-0 flex items-center justify-center text-sm ${textMuted}`}>Kayıtlı görev yok</div>
              )}
            </div>
          </motion.div>

          <motion.div variants={appItemVariants} className={`p-6 rounded-2xl shadow-sm border ${containerBg} flex flex-col`}>
            <h3 className={`font-semibold mb-2 ${textColor}`}>Görev Türü (Kategori)</h3>
            <p className={`text-xs mb-6 ${textMuted}`}>Tüm zamanların kategori dağılımı</p>
            <div className="h-64 w-full relative">
              {keywordData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                  <PieChart margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                    <Pie data={keywordData} cx="50%" cy="50%" innerRadius={40} outerRadius={80} paddingAngle={2} dataKey="value" stroke="none">
                      {keywordData.map((entry, index) => <Cell key={`cell-${index}`} fill={entry.color} />)}
                    </Pie>
                    <RechartsTooltip isAnimationActive={false} content={(props: any) => <CustomPieTooltip {...props} total={keywordData.reduce((sum, item) => sum + item.value, 0)} />} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: '11px', color: textLabel }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className={`absolute inset-0 flex items-center justify-center text-sm ${textMuted}`}>Kayıtlı görev yok</div>
              )}
            </div>
          </motion.div>

          <motion.div variants={appItemVariants} className={`p-6 rounded-2xl shadow-sm border ${containerBg} flex flex-col`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className={`font-semibold ${textColor}`}>Geciken / Kritik Görevler</h3>
              <span className={`text-xs px-2 py-1 rounded-md font-bold ${isLight ? 'bg-rose-100 text-rose-700' : 'bg-rose-500/20 text-rose-400'}`}>{overdueTasks.length} Görev</span>
            </div>
            {overdueTasks.length > 0 ? (
              <motion.div 
                variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } }}
                initial="hidden" animate="visible"
                className="flex flex-col gap-3"
              >
                {overdueTasks.map(task => (
                  <motion.div variants={{ hidden: { opacity: 0, x: -20 }, visible: { opacity: 1, x: 0 } }} key={task.id} className="p-3 border rounded-xl flex flex-col gap-2 relative overflow-hidden group transition-colors bg-gray-950 border-rose-500/30 hover:border-rose-500/60 dark:bg-gray-950">
                    <div className={`absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-rose-500 to-rose-700`}></div>
                    <div className="flex justify-between items-start pl-2">
                       <span className={`text-xs font-bold uppercase tracking-wider ${textMuted}`}>{task.proje}</span>
                       <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded flex items-center gap-1 ${isLight ? 'bg-rose-100 text-rose-700' : 'bg-rose-500/20 text-rose-300'}`}><AlertCircle size={10} /> {Math.abs(differenceInCalendarDays(parseISO(task.hedefTarih), new Date()))} gün geçti</span>
                    </div>
                    <div className={`text-sm font-medium pl-2 line-clamp-1 ${textColor}`}>{task.task}</div>
                    <div className={`text-xs pl-2 flex items-center gap-2 mt-1 ${textMuted}`}>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${getKeywordColor(task.keyword, theme, task.themeColor).badge}`}>{task.keyword}</span>
                      <Users size={12} className={isLight ? 'text-rose-500' : 'text-rose-400/80'} /> <span className="truncate">{task.sorumlu?.join(', ') || 'Atanmadı'}</span>
                    </div>
                  </motion.div>
                ))}
              </motion.div>
            ) : (
              <div className={`flex-1 flex flex-col items-center justify-center gap-3 ${isLight ? 'text-emerald-600' : 'text-emerald-500'}`}>
                <CheckCircle2 size={32} className={isLight ? 'opacity-60' : 'opacity-50'} />
                <span className="text-sm font-medium">Geciken görev bulunmuyor. Harika!</span>
              </div>
            )}
          </motion.div>
        </div>
      </motion.div>
    );
  };

  const renderSorumlularSheet = () => (
    <motion.div 
      variants={appContainerVariants}
      initial="hidden"
      animate="visible"
      className="max-w-4xl mx-auto flex flex-col gap-6"
    >
      {/* Intro block */}
      <motion.div variants={appItemVariants} className={`border rounded-xl p-4 flex gap-4 items-start ${theme === 'light' ? 'bg-blue-50 border-blue-200' : 'bg-blue-500/10 border-blue-500/20'}`}>
        <Users className={`shrink-0 mt-1 ${theme === 'light' ? 'text-blue-600' : 'text-blue-400'}`} size={24} />
        <div>
          <h3 className={`font-semibold mb-1 ${theme === 'light' ? 'text-blue-800' : 'text-blue-300'}`}>Sistem & Ayarlar</h3>
          <p className={`text-sm ${theme === 'light' ? 'text-blue-700' : 'text-blue-200/70'}`}>
            Görev atanacak kişileri bu sayfadan ekleyip çıkarabilirsiniz. Ayrıca çalışma alanı verilerinizi güvenle yedekleyip geri yükleyebilirsiniz.
          </p>
        </div>
      </motion.div>

      <motion.div variants={appItemVariants} className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="flex flex-col gap-6">
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden shadow-sm">
            <div className="p-4 border-b border-gray-800 bg-gray-900/50">
              <h2 className="text-lg font-medium text-gray-100">Yeni Sorumlu Ekle</h2>
            </div>
            <div className="p-4">
              <form onSubmit={handleAddSorumlu} className="flex gap-3">
                <input 
                  type="text" 
                  value={newSorumlu} 
                  onChange={(e) => setNewSorumlu(e.target.value)}
                  className="flex-1 min-w-0 bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                  placeholder="Ad Soyad"
                />
                <button 
                  type="submit" 
                  className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap flex items-center gap-2"
                >
                  <Plus size={16} /> Ekle
                </button>
              </form>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden shadow-sm">
            <div className="p-4 border-b border-gray-800 bg-gray-900/50">
              <h2 className="text-lg font-medium flex items-center gap-2 text-gray-100">Veri Yönetimi</h2>
            </div>
            <div className="p-4 grid grid-cols-2 gap-3">
               <button onClick={exportData} className="flex flex-col items-center justify-center p-3 gap-2 bg-gray-950 border border-gray-800 hover:border-blue-500/50 rounded-xl transition-colors group">
                 <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-400 group-hover:scale-110 transition-transform">
                   <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                 </div>
                 <span className="text-sm font-medium text-gray-300">Dışa Aktar</span>
               </button>
               <label className="flex flex-col items-center justify-center p-3 gap-2 bg-gray-950 border border-gray-800 hover:border-amber-500/50 rounded-xl transition-colors cursor-pointer group">
                 <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center text-amber-500 group-hover:scale-110 transition-transform">
                   <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
                 </div>
                 <span className="text-sm font-medium text-gray-300">İçe Aktar</span>
                 <input type="file" className="hidden" accept=".json" onChange={importData} />
               </label>
            </div>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden shadow-sm h-fit">
          <div className="p-4 border-b border-gray-800 bg-gray-900/50 flex justify-between items-center">
            <h2 className="text-lg font-medium text-gray-100">Sorumlular Listesi</h2>
            <span className="text-xs bg-gray-800 text-gray-400 px-2 py-1 rounded-md font-medium">{sorumlular.length} Kişi</span>
          </div>
          <div className="p-0 overflow-auto max-h-[calc(100vh-280px)]">
            <ul className="divide-y divide-gray-800">
              <AnimatePresence>
              {sorumlular.map((kisi, idx) => (
                <motion.li 
                  key={kisi} 
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, scale: 0.9, height: 0, padding: 0 }}
                  transition={{ duration: 0.2, delay: idx * 0.05 }}
                  className="flex justify-between items-center px-4 py-3 hover:bg-gray-800/30 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-gray-800 to-gray-900 text-gray-300 shadow-inner font-bold flex items-center justify-center border border-gray-700">
                      {kisi.charAt(0)}
                    </div>
                    <span className="text-gray-200 font-medium">{kisi}</span>
                  </div>
                  <button 
                    onClick={() => handleDeleteSorumlu(kisi)}
                    className="text-gray-500 hover:text-red-400 p-2 hover:bg-red-400/10 rounded-lg transition-colors"
                    title="Sorumluyu Sil"
                  >
                    <Trash2 size={18} />
                  </button>
                </motion.li>
              ))}
              </AnimatePresence>
              {sorumlular.length === 0 && (
                <li className="px-4 py-12 flex flex-col items-center gap-2 text-center text-gray-500">
                  <Users size={32} className="opacity-20" />
                  <p>Liste boş, herhangi bir sorumlu eklenmemiş.</p>
                </li>
              )}
            </ul>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans selection:bg-blue-500/30 selection:text-blue-200">
      {/* Header & Navigation */}
      <header className="bg-gray-900/90 border-b border-gray-800 sticky top-0 z-50 shadow-sm backdrop-blur-md">
        <div className="w-full px-4 sm:px-6 lg:px-8 xl:px-12 mx-auto">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between py-4 sm:h-16 gap-4 sm:gap-0">
            <div className="flex items-center gap-3">
              <div className="bg-blue-600/20 border border-blue-500/30 p-2.5 rounded-xl shadow-inner">
                <CalendarIcon className="text-blue-400" size={20} />
              </div>
              <div className="flex flex-col">
                <h1 className="text-lg font-bold bg-gradient-to-r from-gray-100 to-gray-400 bg-clip-text text-transparent">Proje Yönetimi</h1>
                <p className="text-[10px] text-gray-500 font-mono uppercase tracking-wider">Görev & Takvim</p>
              </div>
            </div>
            
            <div className="flex items-center gap-4">
              <nav className="flex items-center p-1 bg-gray-950/50 rounded-xl border border-gray-800/80 backdrop-blur-sm sm:w-auto">
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setActiveTab('ozet')}
                  className={`flex items-center gap-2 px-3 py-2 lg:px-4 rounded-lg text-sm font-semibold transition-all duration-200 ${
                    activeTab === 'ozet' 
                      ? 'bg-indigo-600 text-[white] shadow-md ring-1 ring-indigo-500' 
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  <LayoutDashboard size={16} />
                  <span>Özet</span>
                </motion.button>
                <div className="w-[1px] h-6 bg-gray-800/80 mx-1 hidden sm:block"></div>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setActiveTab('veri')}
                  className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all flex-1 sm:flex-none ${
                    activeTab === 'veri' 
                      ? 'bg-indigo-600 text-[white] shadow-md ring-1 ring-indigo-500' 
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  <ListTodo size={16} />
                  <span>Görev Listesi</span>
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setActiveTab('takvim')}
                  className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all flex-1 sm:flex-none ${
                    activeTab === 'takvim' 
                      ? 'bg-indigo-600 text-[white] shadow-md ring-1 ring-indigo-500' 
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  <CalendarIcon size={16} />
                  <span>Takvim</span>
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setActiveTab('gantt')}
                  className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all flex-1 sm:flex-none ${
                    activeTab === 'gantt' 
                      ? 'bg-indigo-600 text-[white] shadow-md ring-1 ring-indigo-500' 
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  <GanttChart size={16} />
                  <span>Gantt</span>
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setActiveTab('kanban')}
                  className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all flex-1 sm:flex-none ${
                    activeTab === 'kanban' 
                      ? 'bg-indigo-600 text-[white] shadow-md ring-1 ring-indigo-500' 
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  <Kanban size={16} />
                  <span>Kanban</span>
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setActiveTab('rapor')}
                  className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all flex-1 sm:flex-none ${
                    activeTab === 'rapor' 
                      ? 'bg-indigo-600 text-[white] shadow-md ring-1 ring-indigo-500' 
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  <PieChartIcon size={16} />
                  <span>Raporlar</span>
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setActiveTab('kisi')}
                  className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all flex-1 sm:flex-none ${
                    activeTab === 'kisi' 
                      ? 'bg-indigo-600 text-[white] shadow-md ring-1 ring-indigo-500' 
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  <Users size={16} />
                  <span>Ekipler</span>
                </motion.button>
              </nav>

              <button 
                onClick={() => setShowCommandMenu(true)}
                className="hidden sm:flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-800 bg-gray-900 text-gray-400 hover:text-gray-100 hover:bg-gray-800 shadow-sm transition-colors text-sm font-medium"
                title="Hızlı Arama (Cmd+K)"
              >
                <Search size={16} />
                <span className="hidden lg:inline">Arama yap...</span>
                <kbd className="hidden lg:inline-block px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-[10px] font-sans ml-2">⌘K</kbd>
              </button>

              <button 
                onClick={cycleFontSize}
                className={`p-2 lg:p-2.5 rounded-xl border border-gray-800 bg-gray-900 text-gray-400 hover:text-gray-100 hover:bg-gray-800 shadow-sm transition-colors flex-shrink-0 flex items-center justify-center`}
                title="Yazı Boyutunu Değiştir"
              >
                <div className="relative flex items-center justify-center w-[18px] h-[18px]">
                  <Type size={18} />
                  {fontSizeScale !== 16 && (
                    <span className="absolute -bottom-1.5 -right-1.5 text-[9px] font-bold bg-indigo-500 text-white rounded-full w-4 h-4 flex items-center justify-center">
                      {fontSizeScale === 14 ? 'S' : 'L'}
                    </span>
                  )}
                </div>
              </button>

              <button 
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                className="p-2 lg:p-2.5 rounded-xl border border-gray-800 bg-gray-900 text-gray-400 hover:text-gray-100 hover:bg-gray-800 shadow-sm transition-colors flex-shrink-0"
                title={theme === 'dark' ? 'Açık Tema' : 'Koyu Tema'}
              >
                {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="w-full px-4 sm:px-6 lg:px-8 xl:px-12 mx-auto py-8 md:py-10">
        <AnimatePresence mode="wait">
          <motion.div 
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            {activeTab === 'ozet' && renderOzetSheet()}
            {activeTab === 'veri' && renderDataSheet()}
            {activeTab === 'takvim' && renderCalendarSheet()}
            {activeTab === 'gantt' && renderGanttSheet()}
            {activeTab === 'kanban' && renderKanbanSheet()}
            {activeTab === 'rapor' && renderRaporlarSheet()}
            {activeTab === 'kisi' && renderSorumlularSheet()}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Global Tooltip */}
      <AnimatePresence>
        {tooltipConfig.show && (tooltipConfig.task || tooltipConfig.summaryData) && (
          <motion.div 
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className={`fixed z-[9999] pointer-events-none border shadow-2xl rounded-xl p-4 text-xs transform -translate-x-1/2 -translate-y-[calc(100%+16px)] backdrop-blur-md bg-gray-900/95 border-gray-800 ${tooltipConfig.type === 'summary' ? 'w-64' : 'w-72'}`}
            style={{ left: tooltipConfig.x, top: tooltipConfig.y }}
          >
            {tooltipConfig.type === 'summary' && tooltipConfig.summaryData ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <div className={`p-2 rounded-lg ${tooltipConfig.summaryData.colorClass}`}>
                    {tooltipConfig.summaryData.icon}
                  </div>
                  <div>
                    <h4 className="font-bold text-gray-200 text-sm tracking-wide">{tooltipConfig.summaryData.title}</h4>
                    <p className="text-gray-400 text-[10px] uppercase font-bold tracking-wider">{tooltipConfig.summaryData.desc}</p>
                  </div>
                </div>
                <div className="flex items-baseline gap-2 pt-2 border-t border-gray-800">
                  <span className="text-3xl font-black text-gray-100">{tooltipConfig.summaryData.value}</span>
                </div>
              </div>
            ) : tooltipConfig.task ? (
              <>
                <div className="font-semibold flex items-start gap-2 mb-2 pb-2 border-b border-gray-800 text-gray-100">
                  <div className={`mt-1.5 shrink-0 w-3 h-3 rounded-full ${getKeywordColor(tooltipConfig.task.keyword, theme, tooltipConfig.task.themeColor).dot}`}></div>
                  <div className="flex flex-col">
                    <span className="text-xs uppercase font-bold tracking-wider opacity-70 mb-0.5 text-gray-400">{tooltipConfig.task.proje}</span>
                    <span className="text-base leading-tight">{tooltipConfig.task.keyword}</span>
                  </div>
                </div>
                
                <div className="flex gap-2 mb-3 items-start">
                  <AlignLeft size={16} className="shrink-0 mt-0.5 text-gray-500" />
                  <p className="text-sm leading-relaxed line-clamp-4 text-gray-300">{tooltipConfig.task.task}</p>
                </div>
                
                <div className="flex flex-col gap-2.5 text-sm p-3.5 rounded-xl border bg-gray-800/80 border-gray-700 shadow-inner">
                  <div className="flex items-center gap-2 mb-1.5 pb-1.5 border-b border-gray-700/50 flex-wrap">
                    <span className={`px-2.5 py-1 rounded-md text-xs font-bold uppercase tracking-wider ${
                      tooltipConfig.task.status === 'done' ? 'bg-emerald-500/20 text-emerald-400' :
                      tooltipConfig.task.status === 'in_progress' ? 'bg-indigo-500/20 text-indigo-400' :
                      'bg-orange-500/20 text-orange-400'
                    }`}>
                      {tooltipConfig.task.status === 'done' ? 'Tamamlandı' : tooltipConfig.task.status === 'in_progress' ? 'Devam Ediyor' : 'Yapılacak'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Users size={14} className={theme === 'light' ? 'text-blue-500' : 'text-blue-400'} />
                    <span className="text-gray-400 font-medium tracking-wide">Sorumlu:</span>
                    <span className="ml-auto font-semibold text-gray-100">{tooltipConfig.task.sorumlu?.join(', ') || 'Yok'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock size={14} className={theme === 'light' ? 'text-emerald-500' : 'text-emerald-400'} />
                    <span className="text-gray-400 font-medium tracking-wide">Başlangıç:</span>
                    <span className="ml-auto font-mono text-gray-100">{format(parseISO(tooltipConfig.task.baslangicTarihi), 'dd MMM yyyy', {locale: tr})}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CircleDot size={14} className={theme === 'light' ? 'text-amber-500' : 'text-amber-400'} />
                    <span className="text-gray-400 font-medium tracking-wide">Bitiş:</span>
                    <span className="ml-auto font-mono text-gray-100">{format(parseISO(tooltipConfig.task.bitisTarihi), 'dd MMM yyyy', {locale: tr})}</span>
                  </div>
                  <div className="flex items-center gap-2 pt-2 mt-1 border-t border-gray-700/60">
                    <Flag size={14} className={theme === 'light' ? 'text-rose-500' : 'text-rose-400'} />
                    <span className={theme === 'light' ? 'text-rose-600 font-bold tracking-wide' : 'text-rose-400/90 font-bold tracking-wide'}>Hedef:</span>
                    <span className={`ml-auto font-mono font-black ${theme === 'light' ? 'text-rose-700' : 'text-rose-300'}`}>{format(parseISO(tooltipConfig.task.hedefTarih), 'dd MMM yyyy', {locale: tr})}</span>
                  </div>
                  {tooltipConfig.task.dependencies && tooltipConfig.task.dependencies.length > 0 && (
                    <div className="flex items-center gap-2 pt-2 mt-1 border-t border-gray-700/60">
                      <TrendingUp size={14} className="text-amber-500" />
                      <span className="text-amber-500 font-bold tracking-wide text-xs">Aşağıdaki Görevlere Bağımlı:</span>
                      <div className="ml-auto flex flex-col gap-1 items-end">
                        {tooltipConfig.task.dependencies.map(dep => {
                          const depTask = tasks.find(t => t.id === dep.id);
                          if (!depTask) return null;
                          return (
                            <span key={depTask.id} className="text-[10px] font-mono text-gray-300 bg-gray-900 border border-gray-700 px-1.5 py-0.5 rounded shadow-sm max-w-[150px] truncate" title={`${dep.type}: ${depTask.task}`}>
                              {dep.type} - {depTask.keyword}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Detailed Task Modal */}
      <AnimatePresence>
        {detailedTask && (
          <div className="fixed inset-0 z-[100000] flex items-center justify-center p-4 sm:p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 bg-gray-950/70 backdrop-blur-md cursor-pointer"
              onClick={() => setDetailedTask(null)}
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className={`relative w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl shadow-2xl overflow-hidden ${isLight ? 'bg-white border-gray-200' : 'bg-gray-900 border-gray-800'} border`}
            >
              {/* Header */}
              <div className={`flex items-start justify-between p-6 border-b ${isLight ? 'border-gray-200 bg-gray-50/50' : 'border-gray-800 bg-gray-900/50'}`}>
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded tracking-wide uppercase ${isLight ? 'bg-gray-200 text-gray-700' : 'bg-gray-800 text-gray-400'}`}>
                      {detailedTask.proje}
                    </span>
                    <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wide ${
                      detailedTask.status === 'done' ? 'bg-emerald-500/20 text-emerald-400' :
                      detailedTask.status === 'in_progress' ? 'bg-indigo-500/20 text-indigo-400' :
                      'bg-orange-500/20 text-orange-400'
                    }`}>
                      {detailedTask.status === 'done' ? 'Tamamlandı' : detailedTask.status === 'in_progress' ? 'Devam Ediyor' : 'Yapılacak'}
                    </span>
                  </div>
                  <h2 className={`text-2xl font-bold ${isLight ? 'text-gray-900' : 'text-gray-100'} mt-1 leading-tight`}>{detailedTask.task}</h2>
                </div>
                <button 
                  onClick={() => setDetailedTask(null)}
                  className={`p-2 rounded-xl transition-colors ${isLight ? 'text-gray-400 hover:bg-gray-200 hover:text-gray-900' : 'text-gray-500 hover:bg-gray-800 hover:text-gray-100'}`}
                >
                  <X size={20} />
                </button>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-8 custom-scrollbar">
                
                {/* Description */}
                <div className="flex flex-col gap-2">
                  <h3 className={`text-sm font-semibold flex items-center gap-2 ${isLight ? 'text-gray-900' : 'text-gray-300'}`}>
                    <FileText size={16} className="text-indigo-500" /> Açıklama / Notlar
                  </h3>
                  <textarea
                    value={detailedTask.description || ''}
                    onChange={(e) => handleDetailedTaskUpdate({ description: e.target.value })}
                    placeholder="Bu görevin detaylarını ve önemli notlarını buraya ekleyin..."
                    className={`w-full h-32 p-3 rounded-xl border text-sm resize-y focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all ${
                      isLight ? 'bg-gray-50 border-gray-200 text-gray-800 placeholder-gray-400' : 'bg-gray-950 border-gray-800 text-gray-100 placeholder-gray-600'
                    }`}
                  />
                </div>

                {/* Subtasks */}
                <div className="flex flex-col gap-3">
                  <h3 className={`text-sm font-semibold flex items-center gap-2 ${isLight ? 'text-gray-900' : 'text-gray-300'}`}>
                    <CheckCircle2 size={16} className="text-emerald-500" /> Alt Görevler (Checklist)
                  </h3>
                  
                  {detailedTask.subtasks && detailedTask.subtasks.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      {detailedTask.subtasks.map(st => (
                        <div key={st.id} className={`flex items-center gap-3 p-2.5 rounded-lg border transition-colors ${
                          isLight ? 'bg-white border-gray-200 hover:border-gray-300' : 'bg-gray-800/50 border-gray-800/80 hover:bg-gray-800'
                        }`}>
                          <input 
                            type="checkbox" 
                            checked={st.completed}
                            onChange={() => handleToggleSubtask(st.id)}
                            className="w-4 h-4 rounded border-gray-600 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-gray-900 bg-gray-950 cursor-pointer"
                          />
                          <span className={`flex-1 text-sm ${st.completed ? 'line-through text-gray-500' : (isLight ? 'text-gray-800' : 'text-gray-200')}`}>
                            {st.title}
                          </span>
                          <button 
                            onClick={() => handleRemoveSubtask(st.id)}
                            className="text-gray-500 hover:text-red-400 p-1 rounded transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500 italic">Henüz bir alt görev eklenmemiş.</p>
                  )}
                  
                  <div className="flex mt-1">
                    <input 
                      type="text" 
                      placeholder="Yeni alt görev ekle..." 
                      className={`flex-1 px-3 py-2 text-sm border rounded-l-lg focus:outline-none focus:border-indigo-500 ${isLight ? 'bg-white border-gray-300 text-gray-900 placeholder-gray-400' : 'bg-gray-950 border-gray-700 text-gray-100 placeholder-gray-600'}`}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleAddSubtask(e.currentTarget.value);
                          e.currentTarget.value = '';
                        }
                      }}
                    />
                    <button 
                      className="bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-2 rounded-r-lg font-medium text-sm transition-colors"
                      onClick={(e) => {
                        const input = e.currentTarget.previousElementSibling as HTMLInputElement;
                        handleAddSubtask(input.value);
                        input.value = '';
                      }}
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                </div>

                {/* Dependencies */}
                <div className="flex flex-col gap-3">
                  <h3 className={`text-sm font-semibold flex items-center gap-2 ${isLight ? 'text-gray-900' : 'text-gray-300'}`}>
                    <Link2 size={16} className="text-amber-500" /> Bağlı Görevler
                  </h3>
                  
                  {detailedTask.dependencies && detailedTask.dependencies.length > 0 ? (
                    <div className="flex flex-col gap-2">
                       {detailedTask.dependencies.map(dep => {
                         const depTask = tasks.find(t => t.id === dep.id);
                         if (!depTask) return null;
                         return (
                           <div key={dep.id} className={`flex items-center gap-2 p-2.5 rounded-lg border transition-colors ${
                             isLight ? 'bg-white border-gray-200 hover:border-gray-300' : 'bg-gray-800/50 border-gray-800/80 hover:bg-gray-800'
                           }`}>
                             <select
                               className={`text-[10px] uppercase font-bold tracking-wider rounded border outline-none ${isLight ? 'bg-gray-100 border-gray-300 text-gray-700' : 'bg-gray-900 border-gray-700 text-gray-300'} px-1 py-0.5`}
                               value={dep.type}
                               onChange={(e) => {
                                 handleDetailedTaskUpdate({
                                   dependencies: detailedTask.dependencies?.map(d => d.id === dep.id ? { ...d, type: e.target.value as any } : d)
                                 });
                               }}
                             >
                               <option value="FS">FS</option>
                               <option value="SS">SS</option>
                               <option value="FF">FF</option>
                               <option value="SF">SF</option>
                             </select>
                             <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-bold tracking-wider ${
                               depTask.status === 'done' ? 'bg-emerald-500/20 text-emerald-400' :
                               depTask.status === 'in_progress' ? 'bg-indigo-500/20 text-indigo-400' :
                               'bg-orange-500/20 text-orange-400'
                             }`}>{depTask.status === 'done' ? 'Tamamlandı' : depTask.status === 'in_progress' ? 'Devam Ediyor' : 'Yapılacak'}</span>
                             <span className={`flex-1 text-sm ${isLight ? 'text-gray-800' : 'text-gray-200'}`}>
                               {depTask.keyword}
                             </span>
                             <button 
                               onClick={() => handleDetailedTaskUpdate({ dependencies: detailedTask.dependencies?.filter(d => d.id !== dep.id) })}
                               className="text-gray-500 hover:text-red-400 p-1 rounded transition-colors"
                             >
                               <Trash2 size={14} />
                             </button>
                           </div>
                         )
                       })}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500 italic">Bu görev başka bir göreve bağlı değil.</p>
                  )}
                  
                  <div className="flex mt-1 gap-2 items-center">
                    <select
                      className={`px-2 text-xs border rounded-lg focus:outline-none focus:border-indigo-500 h-[38px] ${isLight ? 'bg-white border-gray-300 text-gray-900' : 'bg-gray-950 border-gray-700 text-gray-100'}`}
                      value={selectedDepType}
                      onChange={(e) => setSelectedDepType(e.target.value as any)}
                    >
                      <option value="FS">FS</option>
                      <option value="SS">SS</option>
                      <option value="FF">FF</option>
                      <option value="SF">SF</option>
                    </select>
                    <select
                      className={`flex-1 px-3 py-2 text-sm border rounded-lg focus:outline-none focus:border-indigo-500 ${isLight ? 'bg-white border-gray-300 text-gray-900' : 'bg-gray-950 border-gray-700 text-gray-100'}`}
                      onChange={(e) => {
                         if (!e.target.value) return;
                         const deps = detailedTask.dependencies || [];
                         if (!deps.find(d => d.id === e.target.value)) {
                            handleDetailedTaskUpdate({ dependencies: [...deps, { id: e.target.value, type: selectedDepType }] });
                         }
                         e.target.value = '';
                      }}
                    >
                      <option value="">Yeni bağımlılık ekle...</option>
                      {tasks.filter(t => t.id !== detailedTask.id && !(detailedTask.dependencies || []).find(d => d.id === t.id)).map(t => (
                        <option key={t.id} value={t.id}>{t.keyword} - {t.task}</option>
                      ))}
                    </select>
                  </div>
                </div>

              </div>

              {/* Footer */}
              <div className={`p-4 border-t flex justify-end gap-3 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-800 bg-gray-900/50'}`}>
                <button 
                  onClick={() => setDetailedTask(null)}
                  className="px-5 py-2 rounded-xl text-sm font-medium bg-gray-800 text-gray-100 hover:bg-gray-700 transition-colors"
                >
                  Kapat
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Command Menu */}
      <AnimatePresence>
        {showCommandMenu && (
          <div className="fixed inset-0 z-[99999] flex items-start justify-center pt-[15vh] px-4 sm:px-0">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 bg-gray-950/60 backdrop-blur-sm cursor-pointer"
              onClick={() => setShowCommandMenu(false)}
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: -20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -20 }}
              transition={{ duration: 0.15 }}
              className="relative w-full max-w-2xl rounded-2xl shadow-2xl border border-gray-800 overflow-hidden flex flex-col bg-gray-900"
            >
              <div className="flex items-center gap-3 px-4 py-4 border-b border-gray-800">
                <Search size={20} className="text-gray-500" />
                <input 
                  ref={commandInputRef}
                  type="text" 
                  value={commandMenuQuery}
                  onChange={(e) => setCommandMenuQuery(e.target.value)}
                  placeholder="Bir eylem arayın veya göreve gidin... (Gantt, Sistem, Proje X)"
                  className="w-full bg-transparent text-gray-100 text-lg focus:outline-none"
                />
                <button 
                  onClick={() => setShowCommandMenu(false)}
                  className="text-[10px] font-bold px-2 py-1 rounded border bg-gray-800 border-gray-700 text-gray-400"
                >
                  ESC
                </button>
              </div>
              <div className="max-h-[60vh] overflow-y-auto px-2 py-3 custom-scrollbar">
                {commandMenuQuery === '' && (
                  <>
                    <h4 className="text-xs font-semibold px-3 mb-2 uppercase tracking-wider text-gray-500">Sayfalar</h4>
                    {[
                      { id: 'veri', title: 'Görev Listesi', icon: <AlignLeft size={16} /> },
                      { id: 'takvim', title: 'Takvim Görünümü', icon: <Clock size={16} /> },
                      { id: 'gantt', title: 'Gantt Şeması', icon: <CircleDot size={16} /> },
                      { id: 'kanban', title: 'Kanban Panosu', icon: <Kanban size={16} /> },
                      { id: 'rapor', title: 'Raporlar ve Analiz', icon: <PieChartIcon size={16} /> },
                      { id: 'kisi', title: 'Sistem & Ekipler', icon: <Users size={16} /> },
                    ].map(page => (
                      <div 
                        key={page.id}
                        onClick={() => { setActiveTab(page.id as any); setShowCommandMenu(false); }}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors hover:bg-gray-800 text-gray-200"
                      >
                        <div className={theme === 'light' ? 'text-indigo-500' : 'text-indigo-400'}>{page.icon}</div>
                        <span className="font-medium">{page.title}</span>
                      </div>
                    ))}
                    
                    <h4 className="text-xs font-semibold px-3 mb-2 mt-4 uppercase tracking-wider text-gray-500">Eylemler</h4>
                    <div 
                      onClick={() => { setTheme(theme === 'light' ? 'dark' : 'light'); setShowCommandMenu(false); }}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors hover:bg-gray-800 text-gray-200"
                    >
                      <div className={theme === 'light' ? 'text-amber-500' : 'text-blue-400'}>{theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}</div>
                      <span className="font-medium">{theme === 'light' ? 'Koyu Temaya Geç' : 'Açık Temaya Geç'}</span>
                    </div>
                  </>
                )}
                {commandMenuQuery !== '' && (
                  <>
                    <h4 className="text-xs font-semibold px-3 mb-2 uppercase tracking-wider text-gray-400">Görevler</h4>
                    {tasks.filter(t => t.task.toLowerCase().includes(commandMenuQuery.toLowerCase()) || t.proje.toLowerCase().includes(commandMenuQuery.toLowerCase())).slice(0, 10).map(t => (
                      <div 
                        key={t.id}
                        onClick={() => { 
                          setActiveTab('veri');
                          setTimeout(() => {
                            const event = new CustomEvent('edit-task', { detail: t.id });
                            window.dispatchEvent(event);
                          }, 100);
                          setShowCommandMenu(false); 
                        }}
                        className="flex flex-col gap-1 px-3 py-2.5 rounded-lg cursor-pointer transition-colors hover:bg-gray-800"
                      >
                        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-400">
                          <div className={`w-2 h-2 rounded-full ${getKeywordColor(t.keyword, theme, t.themeColor).dot}`}></div>
                          {t.proje}
                        </div>
                        <span className="text-sm font-medium line-clamp-1 text-gray-200">{t.task}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
