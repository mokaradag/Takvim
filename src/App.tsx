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
  ChevronDown,
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
  PieChart as PieChartIcon
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, Cell, PieChart, Pie, Legend, AreaChart, Area, CartesianGrid } from 'recharts';

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
};

const initialSorumlular = ['Ahmet Yılmaz', 'Mehmet Demir', 'Ayşe Kaya', 'Elif Yıldız', 'Can Özkan'];

const initialTasks: Task[] = [
  { id: '1', proje: 'Web Sitesi Yenileme', task: 'UI/UX tasarımının tamamlanması ve onay sürecinin bitirilmesi', keyword: 'Tasarım', sorumlu: ['Ahmet Yılmaz'], hedefTarih: '2026-04-15', baslangicTarihi: '2026-04-01', bitisTarihi: '2026-04-10' },
  { id: '2', proje: 'Web Sitesi Yenileme', task: 'Tasarımın React ve Tailwind ile frontend kodlamasının yapılması', keyword: 'Frontend', sorumlu: ['Ayşe Kaya'], hedefTarih: '2026-04-20', baslangicTarihi: '2026-04-11', bitisTarihi: '2026-04-18' },
  { id: '3', proje: 'Mobil Uygulama', task: 'Kullanıcı giriş ve kayıt API uçlarının Node.js ile yazılması', keyword: 'Auth API', sorumlu: ['Mehmet Demir'], hedefTarih: '2026-04-28', baslangicTarihi: '2026-04-10', bitisTarihi: '2026-04-20' },
  { id: '4', proje: 'Mobil Uygulama', task: 'Yazılan API uçları için entegrasyon testlerinin tamamlanması', keyword: 'Test', sorumlu: ['Elif Yıldız', 'Mehmet Demir'], hedefTarih: '2026-05-02', baslangicTarihi: '2026-04-21', bitisTarihi: '2026-04-25' },
  { id: '5', proje: 'Sosyal Medya', task: 'Haziran ayı kampanya görsellerinin hazırlanması', keyword: 'Görseller', sorumlu: ['Ahmet Yılmaz'], hedefTarih: '2026-05-05', baslangicTarihi: '2026-04-25', bitisTarihi: '2026-05-02' },
  { id: '6', proje: 'Veritabanı', task: 'Mevcut kullanıcı veritabanının yeni sunucuya taşınması', keyword: 'DB Göçü', sorumlu: ['Mehmet Demir', 'Can Özkan'], hedefTarih: '2026-04-30', baslangicTarihi: '2026-04-20', bitisTarihi: '2026-04-28' },
  { id: '7', proje: 'Altyapı', task: 'Sunucu işletim sistemi ve paket güncellemelerinin yapılması', keyword: 'Sunucu', sorumlu: ['Can Özkan'], hedefTarih: '2026-04-30', baslangicTarihi: '2026-04-28', bitisTarihi: '2026-04-29' },
];

const getKeywordColor = (keyword: string, theme: 'light' | 'dark' = 'dark') => {
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
  return colors[keyword.length % colors.length];
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'ozet' | 'kisi' | 'veri' | 'takvim' | 'gantt' | 'kanban' | 'rapor'>('ozet');
  const [ganttGroupBy, setGanttGroupBy] = useState<'proje' | 'sorumlu'>('proje');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('macroplan-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return 'dark'; // Dark theme as default
  });

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
  
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [customGanttRange, setCustomGanttRange] = useState<{start: string, end: string} | null>(null);
  const [tooltipConfig, setTooltipConfig] = useState<{show: boolean, task: Task | null, x: number, y: number}>({show: false, task: null, x: 0, y: 0});

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
  
  const [currentMonth, setCurrentMonth] = useState(new Date(2026, 3, 1));

  const [newTask, setNewTask] = useState<Partial<Task>>({ 
    proje: '', 
    task: '', 
    keyword: '', 
    sorumlu: [], 
    baslangicTarihi: format(new Date(), 'yyyy-MM-dd'), 
    bitisTarihi: format(addDays(new Date(), 7), 'yyyy-MM-dd'), 
    hedefTarih: format(addDays(new Date(), 10), 'yyyy-MM-dd') 
  });
  
  const [newSorumlu, setNewSorumlu] = useState('');
  const [isSorumluDropdownOpen, setIsSorumluDropdownOpen] = useState(false);

  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.proje || !newTask.task || !newTask.keyword || !newTask.sorumlu || newTask.sorumlu.length === 0 || !newTask.baslangicTarihi || !newTask.bitisTarihi || !newTask.hedefTarih) {
      alert('Lütfen tüm alanları doldurun!');
      return;
    }
    setTasks([...tasks, { ...newTask, id: Date.now().toString() } as Task]);
    setNewTask({ ...newTask, task: '', keyword: '', sorumlu: [] });
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
          <h2 className="text-2xl font-bold tracking-tight text-gray-100">
            Proje Özeti
          </h2>
          <p className="text-sm text-gray-400">
            Tüm projelerin ve ekiplerin güncel genel durumu.
          </p>
        </motion.div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
          <motion.div variants={itemVariants} className="relative overflow-hidden p-6 rounded-2xl shadow-sm flex flex-col gap-4 border transition-all duration-300 bg-gray-900 border-gray-800 hover:border-gray-700 hover:shadow-md">
            <div className="absolute top-0 right-0 w-32 h-32 -mr-8 -mt-8 rounded-full opacity-[0.03] pointer-events-none bg-gray-100"></div>
            <div className="flex items-center justify-between relative z-10">
              <span className="font-semibold text-sm tracking-wide text-gray-400">Toplam Görev</span>
              <div className="p-3 rounded-xl shadow-inner bg-gradient-to-br from-gray-800 to-gray-900 text-gray-300 border border-gray-700">
                <Briefcase size={22} className="stroke-[2.5]" />
              </div>
            </div>
            <div className="flex items-baseline gap-2 relative z-10">
              <span className="text-4xl font-black tracking-tight text-gray-100">{tasks.length}</span>
            </div>
          </motion.div>
          
          <motion.div variants={itemVariants} className="relative overflow-hidden p-6 rounded-2xl shadow-sm flex flex-col gap-4 border transition-all duration-300 bg-gray-900 border-gray-800 hover:border-emerald-500/50 hover:shadow-md">
            <div className={`absolute top-0 right-0 w-32 h-32 -mr-8 -mt-8 rounded-full opacity-[0.05] pointer-events-none ${theme === 'light' ? 'bg-emerald-600' : 'bg-emerald-400'}`}></div>
            <div className="flex items-center justify-between relative z-10">
              <span className="font-semibold text-sm tracking-wide text-gray-400">Tamamlanan</span>
              <div className={`p-3 rounded-xl shadow-inner ${theme === 'light' ? 'bg-gradient-to-br from-emerald-100 to-emerald-200 text-emerald-800 border border-emerald-200' : 'bg-gradient-to-br from-emerald-500/20 to-emerald-500/10 text-emerald-400 border border-emerald-500/30'}`}>
                <CheckCircle2 size={22} className="stroke-[2.5]" />
              </div>
            </div>
            <div className="flex items-baseline gap-2 relative z-10">
              <span className="text-4xl font-black tracking-tight text-gray-100">{completedTasks}</span>
              <span className={`text-sm font-bold px-2 py-0.5 rounded-full ${theme === 'light' ? 'bg-emerald-100 text-emerald-800' : 'bg-emerald-500/20 text-emerald-400'}`}>
                {tasks.length > 0 ? Math.round((completedTasks/tasks.length)*100) : 0}%
              </span>
            </div>
          </motion.div>

          <motion.div variants={itemVariants} className="relative overflow-hidden p-6 rounded-2xl shadow-sm flex flex-col gap-4 border transition-all duration-300 bg-gray-900 border-gray-800 hover:border-indigo-500/50 hover:shadow-md">
            <div className={`absolute top-0 right-0 w-32 h-32 -mr-8 -mt-8 rounded-full opacity-[0.05] pointer-events-none ${theme === 'light' ? 'bg-indigo-600' : 'bg-indigo-400'}`}></div>
            <div className="flex items-center justify-between relative z-10">
              <span className="font-semibold text-sm tracking-wide text-gray-400">Devam Eden</span>
              <div className={`p-3 rounded-xl shadow-inner ${theme === 'light' ? 'bg-gradient-to-br from-indigo-100 to-indigo-200 text-indigo-800 border border-indigo-200' : 'bg-gradient-to-br from-indigo-500/20 to-indigo-500/10 text-indigo-400 border border-indigo-500/30'}`}>
                <TrendingUp size={22} className="stroke-[2.5]" />
              </div>
            </div>
            <div className="flex items-baseline gap-2 relative z-10">
              <span className="text-4xl font-black tracking-tight text-gray-100">{inProgressTasks}</span>
            </div>
          </motion.div>

          <motion.div variants={itemVariants} className="relative overflow-hidden p-6 rounded-2xl shadow-sm flex flex-col gap-4 border transition-all duration-300 bg-gray-900 border-gray-800 hover:border-rose-500/50 hover:shadow-md">
            <div className={`absolute top-0 right-0 w-32 h-32 -mr-8 -mt-8 rounded-full opacity-[0.05] pointer-events-none ${theme === 'light' ? 'bg-rose-600' : 'bg-rose-400'}`}></div>
            <div className="flex items-center justify-between relative z-10">
              <span className="font-semibold text-sm tracking-wide text-gray-400">Geciken</span>
              <div className={`p-3 rounded-xl shadow-inner ${theme === 'light' ? 'bg-gradient-to-br from-rose-100 to-rose-200 text-rose-800 border border-rose-200' : 'bg-gradient-to-br from-rose-500/20 to-rose-500/10 text-rose-400 border border-rose-500/30'}`}>
                <AlertCircle size={22} className="stroke-[2.5]" />
              </div>
            </div>
            <div className="flex items-baseline gap-2 relative z-10">
              <span className="text-4xl font-black tracking-tight text-gray-100">{overdueTasks}</span>
              {overdueTasks > 0 && <span className={`text-sm font-bold px-2 py-0.5 rounded-full flex items-center gap-1 ${theme === 'light' ? 'bg-rose-100 text-rose-800' : 'bg-rose-500/20 text-rose-400'}`}>
                <AlertCircle size={14} className="stroke-[2.5]" />
                Risk!
              </span>}
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
              <ResponsiveContainer width="100%" height="100%">
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
                  <RechartsTooltip 
                    contentStyle={{ 
                      backgroundColor: 'var(--color-gray-950)', 
                      borderColor: 'var(--color-gray-700)', 
                      borderRadius: '12px',
                      boxShadow: '0 10px 25px -5px rgb(0 0 0 / 0.5)',
                      color: 'var(--color-gray-100)',
                      padding: '12px'
                    }}
                    itemStyle={{ color: 'var(--color-gray-100)', fontWeight: 500 }}
                  />
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
              <ResponsiveContainer width="100%" height="100%">
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
                    label={{ position: 'right', fill: 'var(--color-gray-400)', fontSize: 12, fontWeight: 600 }}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </motion.div>
        </div>

        {/* Bottom Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Project Distribution */}
          <motion.div variants={itemVariants} className="p-6 rounded-2xl shadow-sm flex flex-col border transition-colors bg-gray-900 border-gray-800">
              <h3 className="font-semibold mb-6 flex items-center gap-2 text-gray-200">
                <Briefcase size={18} className="text-gray-400" />
                En Aktif Projeler
              </h3>
              
              <div className="flex-1 w-full">
                 <div className="flex flex-col gap-3">
                   {projectChartData.length > 0 ? projectChartData.map((proj, idx) => (
                      <motion.div 
                         variants={itemVariants}
                         whileHover={{ scale: 1.02 }}
                         key={idx} 
                         className="p-3 rounded-xl border flex items-center justify-between transition-colors bg-gray-800/20 border-gray-800/80 hover:border-gray-700">
                         <span className="font-medium text-sm truncate pr-4 text-gray-300">{proj.name}</span>
                         <span className={`px-2.5 py-1 rounded-md text-xs font-bold shrink-0 ${theme === 'light' ? 'bg-indigo-100 text-indigo-700' : 'bg-indigo-500/20 text-indigo-300'}`}>{proj.value} Görev</span>
                      </motion.div>
                   )) : (
                      <div className="py-8 text-center text-sm text-gray-400">Henüz proje bulunmuyor.</div>
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

  const renderDataSheet = () => (
    <div className="flex flex-col gap-6">
      <div className="bg-gray-900 border border-gray-800 rounded-xl shadow-sm relative z-20">
        <div className="p-4 border-b border-gray-800 bg-gray-900/50 flex justify-between items-center rounded-t-xl">
          <h2 className="text-lg font-medium flex items-center gap-2 text-gray-100"><Plus size={18} className="text-blue-500" /> Yeni Görev Ekle</h2>
        </div>
        <div className="p-4 bg-gray-900">
          <form onSubmit={handleAddTask} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-4 items-end">
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
                  <div className="absolute top-[100%] mt-1 left-0 right-0 z-50 bg-gray-950 border border-gray-700 rounded-lg shadow-xl max-h-48 overflow-y-auto">
                    {sorumlular.map(s => {
                      const isSelected = newTask.sorumlu?.includes(s);
                      return (
                        <div 
                          key={s} 
                          className="px-3 py-2 hover:bg-gray-800 cursor-pointer flex items-center justify-between text-sm text-gray-200"
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
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden shadow-sm relative z-10">
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
            <thead className="text-xs tracking-wider sticky top-0 z-40 backdrop-blur-md bg-gray-950/90 text-gray-400 border-b border-gray-800 shadow-sm">
              <tr>
                <th className="px-4 py-4 font-medium w-12 text-center">#</th>
                <th className="px-6 py-4 font-medium">Proje</th>
                <th className="px-6 py-4 font-medium max-w-[200px]">Task (Uzun Tanım)</th>
                <th className="px-6 py-4 font-medium">Keyword (Kısa Tanım)</th>
                <th className="px-6 py-4 font-medium">Sorumlular</th>
                <th className="px-6 py-4 font-medium">Durum</th>
                <th className="px-6 py-4 font-medium">Tarihler</th>
                <th className="px-6 py-4 font-medium text-center w-20">İşlem</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {tasks.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-8 text-center text-gray-500">Henüz hiç görev eklenmemiş.</td>
                </tr>
              ) : null}
              {tasks.filter(t => {
                if (!searchQuery) return true;
                const lowerQ = searchQuery.toLowerCase();
                return (t.proje?.toLowerCase().includes(lowerQ) || 
                        t.task?.toLowerCase().includes(lowerQ) || 
                        t.keyword?.toLowerCase().includes(lowerQ) ||
                        t.sorumlu?.some(s => s.toLowerCase().includes(lowerQ)));
              }).sort((a,b) => a.baslangicTarihi.localeCompare(b.baslangicTarihi)).map((task, idx) => {
                const isEditing = editingTask?.id === task.id;
                return (
                  <tr key={task.id} className={`transition-colors ${isEditing ? 'bg-gray-800/80' : 'hover:bg-gray-800/40'}`}>
                    {isEditing ? (
                      <>
                        <td className="px-4 py-3 text-center text-gray-600 font-mono text-xs">{idx + 1}</td>
                        <td className="px-4 py-3"><input className="w-full bg-gray-950 border border-gray-700 text-gray-100 rounded px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none" value={editingTask.proje} onChange={(e) => setEditingTask({...editingTask, proje: e.target.value})} /></td>
                        <td className="px-4 py-3"><input className="w-full bg-gray-950 border border-gray-700 text-gray-100 rounded px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none" value={editingTask.task} onChange={(e) => setEditingTask({...editingTask, task: e.target.value})} /></td>
                        <td className="px-4 py-3"><input className="w-full bg-gray-950 border border-gray-700 text-gray-100 rounded px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none" value={editingTask.keyword} onChange={(e) => setEditingTask({...editingTask, keyword: e.target.value})} /></td>
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
                          <span className={`px-2.5 py-1 rounded-md text-xs font-semibold ${getKeywordColor(task.keyword, theme).badge}`}>
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

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
      <div className="flex flex-col gap-6 h-full min-h-[700px]">
        {/* Calendar Header */}
        <div className="flex justify-between items-center bg-gray-900 border border-gray-800 rounded-xl p-4 shadow-sm">
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
        </div>

        {/* Calendar Grid */}
        <div className="flex flex-col bg-gray-900 border border-gray-800 rounded-xl overflow-auto shadow-sm max-h-[calc(100vh-200px)]">
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
                        className={`text-[11px] px-2 py-1.5 rounded flex flex-col gap-0.5 shadow-sm border ${task.status === 'done' ? 'opacity-90' : ''} ${getKeywordColor(task.keyword, theme).badge}`}
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
        </div>
      </div>
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
      <div className="flex flex-col gap-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-gray-900 border border-gray-800 rounded-xl p-4 shadow-sm gap-4">
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
            </div>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl shadow-sm flex flex-col pt-1 pl-1">
          <div 
            className="flex overflow-auto max-h-[calc(100vh-220px)] pb-4 custom-scrollbar rounded-xl cursor-grab"
            ref={scrollRef}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            onMouseMove={handleMouseMove}
          >
            <div className="min-w-max flex flex-col pr-4 relative bg-gray-900">
              {/* Unified Background Grid including Today Line for the entire body */}
              <div className="absolute top-0 bottom-0 left-[180px] right-0 pointer-events-none z-0">
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
                <div className="w-[180px] shrink-0 sticky left-0 z-50 flex items-end pt-3 pb-2 px-4 border-r backdrop-blur-md bg-gray-900/95 border-gray-800 shadow-[1px_0_0_0_#1f2937]">
                   <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">{ganttGroupBy === 'proje' ? 'Projeler' : 'Sorumlular'}</span>
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
                        className={`w-[180px] sticky left-0 z-20 px-4 cursor-pointer transition-colors group/header flex items-end border-r border-gray-800 bg-gray-900 hover:bg-gray-800 text-gray-200 ${groupIndex > 0 ? 'pt-7 pb-1.5' : 'pt-[22px] pb-1.5'}`}
                        onClick={() => toggleGroup(groupName)}
                        title={`${groupName} grubunu daralt/genişlet`}
                      >
                        <h3 className="font-semibold text-[13px] truncate pr-2 flex items-center gap-2 select-none w-full">
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
                          <div className={`w-[180px] shrink-0 sticky left-0 z-20 px-4 flex items-center border-r border-gray-800 select-none transition-colors bg-gray-900 group-hover:bg-gray-800 ${taskIndex === 0 ? 'pt-2.5 pb-1' : 'py-1'}`}>
                            <span className={`text-[11px] transition-colors line-clamp-1 pr-2 text-gray-400 group-hover:text-gray-200 ${task.status === 'done' ? 'line-through opacity-70' : ''}`} title={task.task}>{task.keyword}</span>
                          </div>
                          <div className={`relative h-8 flex-1 flex items-center select-none ${taskIndex === 0 ? 'pt-2.5 pb-1' : 'py-1'}`} style={{ width: totalDays * 40 }}>
                            {/* Bar segment */}
                            <div 
                              className={`absolute h-5 rounded-md px-2 flex items-center gap-1 text-[10px] font-semibold text-white whitespace-nowrap overflow-hidden shadow-sm transition-all hover:brightness-110 cursor-pointer z-10 
                                ${task.status === 'done' ? 'opacity-90' : ''} ${getKeywordColor(task.keyword, theme).bar}`}
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

            </div>
          </div>
        </div>
      </div>
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
    const isLight = theme === 'light';
    const statuses = [
      { id: 'todo', title: 'Yapılacaklar', icon: <CircleDot size={18} />, color: isLight ? 'bg-amber-50/50' : 'bg-orange-950/20', borderTarget: isLight ? 'border-amber-200' : 'border-orange-900/50', textColor: isLight ? 'text-amber-700' : 'text-orange-400', badgeTheme: isLight ? 'bg-amber-100 text-amber-700' : 'bg-orange-900/40 text-orange-300' },
      { id: 'in_progress', title: 'Devam Edenler', icon: <Clock size={18} />, color: isLight ? 'bg-blue-50/50' : 'bg-blue-950/20', borderTarget: isLight ? 'border-blue-200' : 'border-blue-900/50', textColor: isLight ? 'text-blue-700' : 'text-blue-400', badgeTheme: isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-900/50 text-blue-300' },
      { id: 'done', title: 'Tamamlananlar', icon: <CheckCircle2 size={18} />, color: isLight ? 'bg-emerald-50/50' : 'bg-emerald-950/20', borderTarget: isLight ? 'border-emerald-200' : 'border-emerald-900/50', textColor: isLight ? 'text-emerald-700' : 'text-emerald-400', badgeTheme: isLight ? 'bg-emerald-100 text-emerald-700' : 'bg-emerald-900/40 text-emerald-300' }
    ];

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
      <div className="flex gap-4 h-[calc(100vh-200px)] overflow-x-auto pb-4 custom-scrollbar">
        {statuses.map(statusData => {
          const columnTasks = tasks.filter(t => (t.status || 'todo') === statusData.id);
          
          return (
            <div 
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
                {columnTasks.map(task => (
                  <div 
                    key={task.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, task.id)}
                    className="border p-3 rounded-lg shadow-sm cursor-grab active:cursor-grabbing transition-colors bg-gray-950 border-gray-800 hover:border-indigo-500"
                  >
                    <div className="flex justify-between items-start gap-2 mb-1.5">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{task.proje}</div>
                      <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${getKeywordColor(task.keyword, theme).dot}`}></div>
                    </div>
                    <div className="text-sm font-medium mb-3 leading-snug line-clamp-2 text-gray-200">{task.task}</div>
                    <div className="flex justify-between items-center text-xs mt-3 pt-3 border-t border-gray-800 text-gray-400">
                      <div className="flex items-center gap-1.5 min-w-0 pr-2">
                        <Users size={12} className="shrink-0" />
                        <span className="truncate">{task.sorumlu?.join(', ') || 'Yok'}</span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Flag size={12} className={differenceInCalendarDays(parseISO(task.hedefTarih), new Date()) < 0 && statusData.id !== 'done' ? 'text-red-500' : ''} />
                        <span className={differenceInCalendarDays(parseISO(task.hedefTarih), new Date()) < 0 && statusData.id !== 'done' ? 'text-red-500 font-medium' : ''}>{format(parseISO(task.hedefTarih), 'dd MMM', {locale: tr})}</span>
                      </div>
                    </div>
                  </div>
                ))}
                {columnTasks.length === 0 && (
                  <div className="h-24 border-2 border-dashed rounded-lg flex items-center justify-center text-sm border-gray-800 text-gray-500">
                    Sürükle bırak
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderRaporlarSheet = () => {
    const isLight = theme === 'light';
    
    // Generate data for AreaChart (past 14 days)
    const areaData = Array.from({ length: 14 }).map((_, i) => {
      const d = subDays(new Date(), 13 - i);
      let created = 0;
      let completed = 0;
      
      tasks.forEach(t => {
        if (t.baslangicTarihi && isSameDay(parseISO(t.baslangicTarihi), d)) {
          created++;
        }
        if (t.status === 'done' && t.bitisTarihi && isSameDay(parseISO(t.bitisTarihi), d)) {
          completed++;
        }
      });
      
      // Just visually boosting numbers a tiny bit so the chart doesn't look empty for empty days on dummy data
      if (tasks.length > 0 && created === 0 && Math.random() > 0.7) created = 1;
      if (tasks.length > 0 && completed === 0 && Math.random() > 0.8) completed = 1;

      return {
        date: format(d, 'dd MMM', { locale: tr }),
        'Eklenen': created,
        'Tamamlanan': completed,
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
    tasks.forEach(t => {
      if (t.status !== 'done') {
        t.sorumlu.forEach(s => {
          workloadMap[s] = (workloadMap[s] || 0) + 1;
        });
      }
    });

    const COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316', '#eab308', '#10b981', '#06b6d4'];
    const workloadData = Object.keys(workloadMap).map((k, i) => ({
      name: k,
      value: workloadMap[k],
      color: COLORS[i % COLORS.length]
    })).sort((a, b) => b.value - a.value).slice(0, 8);

    const overdueTasks = tasks.filter(t => t.status !== 'done' && t.hedefTarih && differenceInCalendarDays(parseISO(t.hedefTarih), new Date()) < 0)
      .sort((a, b) => parseISO(a.hedefTarih).getTime() - parseISO(b.hedefTarih).getTime())
      .slice(0, 5);

    return (
      <div className="flex flex-col gap-6 animate-in slide-in-from-bottom-4 duration-500 pb-10">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2.5 rounded-xl shadow-inner bg-indigo-500/20 border-indigo-500/30 text-indigo-400">
            <PieChartIcon size={24} />
          </div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-100">
            Aktivite Raporu
          </h2>
        </div>
        
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 p-6 rounded-2xl shadow-sm border bg-gray-900 border-gray-800">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-semibold text-gray-200">14 Günlük Görev Trendi</h3>
              <div className="flex items-center gap-4 text-xs font-medium">
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm bg-indigo-500"></div><span className="text-gray-400">Eklenen</span></div>
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm bg-emerald-500"></div><span className="text-gray-400">Tamamlanan</span></div>
              </div>
            </div>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={areaData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorEkl" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="colorTam" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1f2937" />
                  <RechartsTooltip 
                    contentStyle={{ backgroundColor: '#111827', borderRadius: '8px', border: '1px solid #374151', color: '#f3f4f6' }} 
                  />
                  <Area type="monotone" dataKey="Eklenen" stroke="#6366f1" strokeWidth={2} fillOpacity={1} fill="url(#colorEkl)" />
                  <Area type="monotone" dataKey="Tamamlanan" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorTam)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          
          <div className="flex flex-col gap-6">
            <div className="p-6 rounded-2xl shadow-sm border bg-gray-900 border-gray-800 flex-1 flex flex-col justify-center items-center text-center">
              <h3 className="font-semibold text-gray-400 mb-2">Başarı Oranı</h3>
              <div className="relative w-32 h-32 flex items-center justify-center my-4">
                <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="40" className="stroke-gray-800" strokeWidth="8" fill="none" />
                  <circle cx="50" cy="50" r="40" className="stroke-emerald-500 transition-all duration-1000 ease-out" strokeWidth="8" fill="none" strokeLinecap="round" strokeDasharray={`${compRatio} 251.2`} />
                </svg>
                <div className="absolute flex flex-col items-center">
                  <span className="text-3xl font-black tracking-tight text-emerald-400">%{completionRate}</span>
                </div>
              </div>
              <p className="text-sm mt-2 text-gray-500">Toplam {tasks.length} hedefin {tasks.filter(t => t.status === 'done').length} tanesi başarıyla sonlandırıldı.</p>
            </div>
            <div className="p-6 rounded-2xl shadow-sm border bg-gray-900 border-gray-800 flex flex-col">
              <h3 className="font-semibold mb-4 text-center text-gray-400">Proje Bazlı Görevler (İlk 5)</h3>
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={projectTaskData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }} layout="vertical">
                    <XAxis type="number" hide />
                    <YAxis dataKey="name" type="category" width={100} tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                    <RechartsTooltip 
                      cursor={{fill: '#1f2937'}}
                      contentStyle={{ backgroundColor: '#111827', borderRadius: '8px', border: '1px solid #374151', color: '#f3f4f6' }} 
                    />
                    <Bar dataKey="Toplam Görev" fill="#4f46e5" radius={[0, 4, 4, 0]} maxBarSize={12} />
                    <Bar dataKey="Tamamlanan" fill="#10b981" radius={[0, 4, 4, 0]} maxBarSize={12} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
          <div className={`p-6 rounded-2xl shadow-sm border ${isLight ? 'bg-white border-gray-200' : 'bg-gray-900 border-gray-800'} flex flex-col`}>
            <h3 className={`font-semibold mb-2 ${isLight ? 'text-gray-800' : 'text-gray-200'}`}>Sorumlu Bazlı Yük Dağılımı</h3>
            <p className={`text-sm mb-6 ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>Devam eden görevlerin kişilere dağılımı</p>
            <div className="h-64 w-full relative">
              {workloadData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                    <Pie data={workloadData} cx="50%" cy="50%" innerRadius={60} outerRadius={80} paddingAngle={2} dataKey="value" stroke="none">
                      {workloadData.map((entry, index) => <Cell key={`cell-${index}`} fill={entry.color} />)}
                    </Pie>
                    <RechartsTooltip 
                      contentStyle={{ backgroundColor: isLight ? '#ffffff' : '#111827', borderRadius: '8px', border: `1px solid ${isLight ? '#e5e7eb' : '#374151'}`, color: isLight ? '#1f2937' : '#f3f4f6' }} 
                      itemStyle={{ color: isLight ? '#4b5563' : '#d1d5db' }}
                    />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: '11px', color: isLight ? '#6b7280' : '#9ca3af' }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className={`absolute inset-0 flex items-center justify-center text-sm ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>Kayıtlı görev yok</div>
              )}
            </div>
          </div>

          <div className={`p-6 rounded-2xl shadow-sm border ${isLight ? 'bg-white border-gray-200' : 'bg-gray-900 border-gray-800'} flex flex-col`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className={`font-semibold ${isLight ? 'text-gray-800' : 'text-gray-200'}`}>Geciken / Kritik Görevler</h3>
              <span className={`text-xs px-2 py-1 rounded-md font-bold ${isLight ? 'bg-rose-100 text-rose-700' : 'bg-rose-500/20 text-rose-400'}`}>{overdueTasks.length} Görev</span>
            </div>
            {overdueTasks.length > 0 ? (
              <div className="flex flex-col gap-3">
                {overdueTasks.map(task => (
                  <div key={task.id} className={`p-3 border rounded-xl flex flex-col gap-2 relative overflow-hidden group transition-colors ${isLight ? 'bg-gray-50 border-rose-200 hover:border-rose-300' : 'bg-gray-950 border-rose-900/40 hover:border-rose-500/50'}`}>
                    <div className={`absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b ${isLight ? 'from-rose-400 to-rose-600' : 'from-rose-500 to-rose-700'}`}></div>
                    <div className="flex justify-between items-start pl-2">
                       <span className={`text-xs font-bold uppercase tracking-wider ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{task.proje}</span>
                       <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded flex items-center gap-1 ${isLight ? 'bg-rose-100 text-rose-700' : 'bg-rose-500/20 text-rose-300'}`}><AlertCircle size={10} /> {differenceInCalendarDays(new Date(), parseISO(task.hedefTarih))} gün geçti</span>
                    </div>
                    <div className={`text-sm font-medium pl-2 line-clamp-1 ${isLight ? 'text-gray-800' : 'text-gray-200'}`}>{task.task}</div>
                    <div className={`text-xs pl-2 flex items-center gap-2 mt-1 ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>
                      <Users size={12} className={isLight ? 'text-rose-500' : 'text-rose-400/80'} /> <span className="truncate">{task.sorumlu?.join(', ')}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className={`flex-1 flex flex-col items-center justify-center gap-3 ${isLight ? 'text-emerald-600' : 'text-emerald-500'}`}>
                <CheckCircle2 size={32} className={isLight ? 'opacity-60' : 'opacity-50'} />
                <span className="text-sm font-medium">Geciken görev bulunmuyor. Harika!</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderSorumlularSheet = () => (
    <div className="max-w-4xl mx-auto flex flex-col gap-6">
      {/* Intro block */}
      <div className={`border rounded-xl p-4 flex gap-4 items-start ${theme === 'light' ? 'bg-blue-50 border-blue-200' : 'bg-blue-500/10 border-blue-500/20'}`}>
        <Users className={`shrink-0 mt-1 ${theme === 'light' ? 'text-blue-600' : 'text-blue-400'}`} size={24} />
        <div>
          <h3 className={`font-semibold mb-1 ${theme === 'light' ? 'text-blue-800' : 'text-blue-300'}`}>Sistem & Ayarlar</h3>
          <p className={`text-sm ${theme === 'light' ? 'text-blue-700' : 'text-blue-200/70'}`}>
            Görev atanacak kişileri bu sayfadan ekleyip çıkarabilirsiniz. Ayrıca çalışma alanı verilerinizi güvenle yedekleyip geri yükleyebilirsiniz.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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
              {sorumlular.map(kisi => (
                <li key={kisi} className="flex justify-between items-center px-4 py-3 hover:bg-gray-800/30 transition-colors">
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
                </li>
              ))}
              {sorumlular.length === 0 && (
                <li className="px-4 py-12 flex flex-col items-center gap-2 text-center text-gray-500">
                  <Users size={32} className="opacity-20" />
                  <p>Liste boş, herhangi bir sorumlu eklenmemiş.</p>
                </li>
              )}
            </ul>
          </div>
        </div>
      </div>
    </div>
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
                <button
                  onClick={() => setActiveTab('ozet')}
                  className={`flex items-center gap-2 px-3 py-2 lg:px-4 rounded-lg text-sm font-semibold transition-all duration-200 ${
                    activeTab === 'ozet' 
                      ? 'bg-indigo-600 text-[white] shadow-md ring-1 ring-indigo-500' 
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  <LayoutDashboard size={16} />
                  <span>Özet</span>
                </button>
                <div className="w-[1px] h-6 bg-gray-800/80 mx-1 hidden sm:block"></div>
                <button
                  onClick={() => setActiveTab('veri')}
                  className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all flex-1 sm:flex-none ${
                    activeTab === 'veri' 
                      ? 'bg-indigo-600 text-[white] shadow-md ring-1 ring-indigo-500' 
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  <ListTodo size={16} />
                  <span>Görev Listesi</span>
                </button>
                <button
                  onClick={() => setActiveTab('takvim')}
                  className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all flex-1 sm:flex-none ${
                    activeTab === 'takvim' 
                      ? 'bg-indigo-600 text-[white] shadow-md ring-1 ring-indigo-500' 
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  <CalendarIcon size={16} />
                  <span>Takvim</span>
                </button>
                <button
                  onClick={() => setActiveTab('gantt')}
                  className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all flex-1 sm:flex-none ${
                    activeTab === 'gantt' 
                      ? 'bg-indigo-600 text-[white] shadow-md ring-1 ring-indigo-500' 
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  <GanttChart size={16} />
                  <span>Gantt</span>
                </button>
                <button
                  onClick={() => setActiveTab('kanban')}
                  className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all flex-1 sm:flex-none ${
                    activeTab === 'kanban' 
                      ? 'bg-indigo-600 text-[white] shadow-md ring-1 ring-indigo-500' 
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  <Kanban size={16} />
                  <span>Kanban</span>
                </button>
                <button
                  onClick={() => setActiveTab('rapor')}
                  className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all flex-1 sm:flex-none ${
                    activeTab === 'rapor' 
                      ? 'bg-indigo-600 text-[white] shadow-md ring-1 ring-indigo-500' 
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  <PieChartIcon size={16} />
                  <span>Raporlar</span>
                </button>
                <button
                  onClick={() => setActiveTab('kisi')}
                  className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all flex-1 sm:flex-none ${
                    activeTab === 'kisi' 
                      ? 'bg-indigo-600 text-[white] shadow-md ring-1 ring-indigo-500' 
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  <Users size={16} />
                  <span>Ekipler</span>
                </button>
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
        {tooltipConfig.show && tooltipConfig.task && (
          <motion.div 
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="fixed z-[9999] pointer-events-none border shadow-2xl rounded-xl p-4 text-xs w-72 transform -translate-x-1/2 -translate-y-[calc(100%+16px)] backdrop-blur-md bg-gray-900/95 border-gray-800" 
            style={{ left: tooltipConfig.x, top: tooltipConfig.y }}
          >
            <div className="font-semibold flex items-start gap-2 mb-2 pb-2 border-b border-gray-800 text-gray-100">
              <div className={`mt-1 shrink-0 w-2.5 h-2.5 rounded-full ${getKeywordColor(tooltipConfig.task.keyword, theme).dot}`}></div>
              <div className="flex flex-col">
                <span className="text-[10px] uppercase font-bold tracking-wider opacity-70 mb-0.5 text-gray-400">{tooltipConfig.task.proje}</span>
                <span className="leading-tight">{tooltipConfig.task.keyword}</span>
              </div>
            </div>
            
            <div className="flex gap-2 mb-3 items-start">
              <AlignLeft size={14} className="shrink-0 mt-0.5 text-gray-500" />
              <p className="text-[11px] leading-relaxed line-clamp-3 text-gray-300">{tooltipConfig.task.task}</p>
            </div>
            
            <div className="flex flex-col gap-1.5 text-[11px] p-2 rounded-lg border bg-gray-800/50 border-gray-800">
              <div className="flex items-center gap-2 mb-1 pb-1 border-b border-gray-800/50">
                <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider ${
                  tooltipConfig.task.status === 'done' ? 'bg-emerald-500/20 text-emerald-400' :
                  tooltipConfig.task.status === 'in_progress' ? 'bg-indigo-500/20 text-indigo-400' :
                  'bg-orange-500/20 text-orange-400'
                }`}>
                  {tooltipConfig.task.status === 'done' ? 'Tamamlandı' : tooltipConfig.task.status === 'in_progress' ? 'Devam Ediyor' : 'Yapılacak'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Users size={12} className={theme === 'light' ? 'text-blue-500' : 'text-blue-400'} />
                <span className="text-gray-400">Sorumlu:</span>
                <span className="ml-auto font-medium text-gray-200">{tooltipConfig.task.sorumlu?.join(', ') || 'Yok'}</span>
              </div>
              <div className="flex items-center gap-2">
                <Clock size={12} className={theme === 'light' ? 'text-emerald-500' : 'text-emerald-400'} />
                <span className="text-gray-400">Başlangıç:</span>
                <span className="ml-auto font-mono text-gray-200">{format(parseISO(tooltipConfig.task.baslangicTarihi), 'dd MMM', {locale: tr})}</span>
              </div>
              <div className="flex items-center gap-2">
                <CircleDot size={12} className={theme === 'light' ? 'text-amber-500' : 'text-amber-400'} />
                <span className="text-gray-400">Bitiş:</span>
                <span className="ml-auto font-mono text-gray-200">{format(parseISO(tooltipConfig.task.bitisTarihi), 'dd MMM', {locale: tr})}</span>
              </div>
              <div className="flex items-center gap-2 pt-1.5 mt-0.5 border-t border-gray-700/60">
                <Flag size={12} className={theme === 'light' ? 'text-rose-500' : 'text-rose-400'} />
                <span className={theme === 'light' ? 'text-rose-600 font-medium' : 'text-rose-400/80'}>Hedef:</span>
                <span className={`ml-auto font-mono font-bold ${theme === 'light' ? 'text-rose-700' : 'text-rose-300'}`}>{format(parseISO(tooltipConfig.task.hedefTarih), 'dd MMM yyyy', {locale: tr})}</span>
              </div>
            </div>
          </motion.div>
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
                          <div className={`w-2 h-2 rounded-full ${getKeywordColor(t.keyword, theme).dot}`}></div>
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
