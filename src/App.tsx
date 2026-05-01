/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
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
  X
} from 'lucide-react';

type Task = {
  id: string;
  proje: string;
  task: string;
  keyword: string;
  sorumlu: string;
  hedefTarih: string; // YYYY-MM-DD
  baslangicTarihi: string; // YYYY-MM-DD
  bitisTarihi: string; // YYYY-MM-DD
};

const initialSorumlular = ['Ahmet Yılmaz', 'Mehmet Demir', 'Ayşe Kaya', 'Elif Yıldız', 'Can Özkan'];

const initialTasks: Task[] = [
  { id: '1', proje: 'Web Sitesi Yenileme', task: 'UI/UX tasarımının tamamlanması ve onay sürecinin bitirilmesi', keyword: 'Tasarım', sorumlu: 'Ahmet Yılmaz', hedefTarih: '2026-04-15', baslangicTarihi: '2026-04-01', bitisTarihi: '2026-04-10' },
  { id: '2', proje: 'Web Sitesi Yenileme', task: 'Tasarımın React ve Tailwind ile frontend kodlamasının yapılması', keyword: 'Frontend', sorumlu: 'Ayşe Kaya', hedefTarih: '2026-04-20', baslangicTarihi: '2026-04-11', bitisTarihi: '2026-04-18' },
  { id: '3', proje: 'Mobil Uygulama', task: 'Kullanıcı giriş ve kayıt API uçlarının Node.js ile yazılması', keyword: 'Auth API', sorumlu: 'Mehmet Demir', hedefTarih: '2026-04-28', baslangicTarihi: '2026-04-10', bitisTarihi: '2026-04-20' },
  { id: '4', proje: 'Mobil Uygulama', task: 'Yazılan API uçları için entegrasyon testlerinin tamamlanması', keyword: 'Test', sorumlu: 'Elif Yıldız', hedefTarih: '2026-05-02', baslangicTarihi: '2026-04-21', bitisTarihi: '2026-04-25' },
  { id: '5', proje: 'Sosyal Medya', task: 'Haziran ayı kampanya görsellerinin hazırlanması', keyword: 'Görseller', sorumlu: 'Ahmet Yılmaz', hedefTarih: '2026-05-05', baslangicTarihi: '2026-04-25', bitisTarihi: '2026-05-02' },
  { id: '6', proje: 'Veritabanı', task: 'Mevcut kullanıcı veritabanının yeni sunucuya taşınması', keyword: 'DB Göçü', sorumlu: 'Mehmet Demir', hedefTarih: '2026-04-30', baslangicTarihi: '2026-04-20', bitisTarihi: '2026-04-28' },
  { id: '7', proje: 'Altyapı', task: 'Sunucu işletim sistemi ve paket güncellemelerinin yapılması', keyword: 'Sunucu', sorumlu: 'Can Özkan', hedefTarih: '2026-04-30', baslangicTarihi: '2026-04-28', bitisTarihi: '2026-04-29' },
];

const getKeywordColor = (keyword: string) => {
  const colors = [
    'bg-blue-500/20 text-blue-300 border border-blue-500/30',
    'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
    'bg-purple-500/20 text-purple-300 border border-purple-500/30',
    'bg-amber-500/20 text-amber-300 border border-amber-500/30',
    'bg-rose-500/20 text-rose-300 border border-rose-500/30',
    'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30',
  ];
  return colors[keyword.length % colors.length];
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'kisi' | 'veri' | 'takvim' | 'gantt'>('veri');
  const [ganttGroupBy, setGanttGroupBy] = useState<'proje' | 'sorumlu'>('proje');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  
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
    sorumlu: '', 
    baslangicTarihi: format(new Date(), 'yyyy-MM-dd'), 
    bitisTarihi: format(addDays(new Date(), 7), 'yyyy-MM-dd'), 
    hedefTarih: format(addDays(new Date(), 10), 'yyyy-MM-dd') 
  });
  
  const [newSorumlu, setNewSorumlu] = useState('');

  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.proje || !newTask.task || !newTask.keyword || !newTask.sorumlu || !newTask.baslangicTarihi || !newTask.bitisTarihi || !newTask.hedefTarih) {
      alert('Lütfen tüm alanları doldurun!');
      return;
    }
    setTasks([...tasks, { ...newTask, id: Date.now().toString() } as Task]);
    setNewTask({ ...newTask, task: '', keyword: '' });
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
    setTasks(tasks.map(t => t.sorumlu === isim ? { ...t, sorumlu: '' } : t));
  };

  const renderDataSheet = () => (
    <div className="flex flex-col gap-6">
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden shadow-sm">
        <div className="p-4 border-b border-gray-800 bg-gray-900/50 flex justify-between items-center">
          <h2 className="text-lg font-medium text-gray-100 flex items-center gap-2"><Plus size={18} className="text-blue-500" /> Yeni Görev Ekle</h2>
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
              <div className="flex flex-col gap-1.5 md:col-span-1 lg:col-span-1 xl:col-span-1">
                <label className="text-sm text-gray-400 font-medium">Sorumlu</label>
                <select 
                  value={newTask.sorumlu || ''} 
                  onChange={(e) => setNewTask({...newTask, sorumlu: e.target.value})}
                  className="bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                >
                  <option value="">Seçiniz</option>
                  {sorumlular.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5 md:col-span-1 lg:col-span-1 xl:col-span-1">
                <label className="text-sm text-gray-400 font-medium whitespace-nowrap">Başlangıç</label>
                <input 
                  type="date" 
                  value={newTask.baslangicTarihi || ''} 
                  onChange={(e) => setNewTask({...newTask, baslangicTarihi: e.target.value})}
                  className="bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                  style={{ colorScheme: 'dark' }}
                />
              </div>
              <div className="flex flex-col gap-1.5 md:col-span-1 lg:col-span-1 xl:col-span-1">
                <label className="text-sm text-gray-400 font-medium whitespace-nowrap">Bitiş</label>
                <input 
                  type="date" 
                  value={newTask.bitisTarihi || ''} 
                  onChange={(e) => setNewTask({...newTask, bitisTarihi: e.target.value})}
                  className="bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                  style={{ colorScheme: 'dark' }}
                />
              </div>
              <div className="flex flex-col gap-1.5 md:col-span-1 lg:col-span-1 xl:col-span-1">
                <label className="text-sm text-gray-400 font-medium whitespace-nowrap text-red-300">Hedef Tarih</label>
                <input 
                  type="date" 
                  value={newTask.hedefTarih || ''} 
                  onChange={(e) => setNewTask({...newTask, hedefTarih: e.target.value})}
                  className="bg-gray-950 border border-red-900 border-dashed text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 transition-colors bg-red-950/20"
                  style={{ colorScheme: 'dark' }}
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

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden shadow-sm">
        <div className="p-4 border-b border-gray-800 bg-gray-900/50">
          <h2 className="text-lg font-medium text-gray-100 flex items-center gap-2"><ListTodo size={18} className="text-indigo-400" /> Görev Listesi</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left text-gray-300">
            <thead className="text-xs text-gray-400 uppercase bg-gray-950/50 border-b border-gray-800 tracking-wider">
              <tr>
                <th className="px-6 py-4 font-medium">Proje</th>
                <th className="px-6 py-4 font-medium max-w-[200px]">Task (Uzun Tanım)</th>
                <th className="px-6 py-4 font-medium">Keyword (Kısa Tanım)</th>
                <th className="px-6 py-4 font-medium">Sorumlu</th>
                <th className="px-6 py-4 font-medium">Tarihler</th>
                <th className="px-6 py-4 font-medium text-center w-20">İşlem</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {tasks.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-gray-500">Henüz hiç görev eklenmemiş.</td>
                </tr>
              ) : null}
              {tasks.sort((a,b) => a.baslangicTarihi.localeCompare(b.baslangicTarihi)).map((task) => {
                const isEditing = editingTask?.id === task.id;
                return (
                  <tr key={task.id} className={`transition-colors ${isEditing ? 'bg-gray-800/80' : 'hover:bg-gray-800/40'}`}>
                    {isEditing ? (
                      <>
                        <td className="px-4 py-3"><input className="w-full bg-gray-950 border border-gray-700 text-gray-100 rounded px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none" value={editingTask.proje} onChange={(e) => setEditingTask({...editingTask, proje: e.target.value})} /></td>
                        <td className="px-4 py-3"><input className="w-full bg-gray-950 border border-gray-700 text-gray-100 rounded px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none" value={editingTask.task} onChange={(e) => setEditingTask({...editingTask, task: e.target.value})} /></td>
                        <td className="px-4 py-3"><input className="w-full bg-gray-950 border border-gray-700 text-gray-100 rounded px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none" value={editingTask.keyword} onChange={(e) => setEditingTask({...editingTask, keyword: e.target.value})} /></td>
                        <td className="px-4 py-3">
                          <select className="w-full bg-gray-950 border border-gray-700 text-gray-100 rounded px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none" value={editingTask.sorumlu} onChange={(e) => setEditingTask({...editingTask, sorumlu: e.target.value})}>
                            <option value="">Seçiniz</option>
                            {sorumlular.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex flex-col gap-1.5 text-[11px] font-mono">
                            <div className="flex items-center gap-2">
                              <span className="w-6 text-gray-400">Bşl:</span> <input type="date" className="bg-gray-950 border border-gray-700 text-gray-100 rounded px-1.5 py-0.5 focus:border-indigo-500 focus:outline-none" style={{ colorScheme: 'dark' }} value={editingTask.baslangicTarihi} onChange={(e) => setEditingTask({...editingTask, baslangicTarihi: e.target.value})} />
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="w-6 text-gray-400">Bit:</span> <input type="date" className="bg-gray-950 border border-gray-700 text-gray-100 rounded px-1.5 py-0.5 focus:border-indigo-500 focus:outline-none" style={{ colorScheme: 'dark' }} value={editingTask.bitisTarihi} onChange={(e) => setEditingTask({...editingTask, bitisTarihi: e.target.value})} />
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="w-6 text-red-400/80">Hdf:</span> <input type="date" className="bg-gray-950 border border-rose-900 text-gray-100 rounded px-1.5 py-0.5 bg-rose-950/20 focus:border-rose-500 focus:outline-none" style={{ colorScheme: 'dark' }} value={editingTask.hedefTarih} onChange={(e) => setEditingTask({...editingTask, hedefTarih: e.target.value})} />
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
                        <td className="px-6 py-4 font-medium text-gray-200">{task.proje}</td>
                        <td className="px-6 py-4 text-gray-400 max-w-[200px] truncate" title={task.task}>{task.task}</td>
                        <td className="px-6 py-4">
                          <span className={`px-2.5 py-1 rounded-md text-xs font-semibold ${getKeywordColor(task.keyword)}`}>
                            {task.keyword}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            {task.sorumlu ? (
                              <>
                                <div className="w-6 h-6 rounded-full bg-gray-800 flex items-center justify-center text-[10px] font-bold text-gray-300 shrink-0 border border-gray-700">
                                  {task.sorumlu.charAt(0)}
                                </div>
                                <span className="text-gray-300">{task.sorumlu}</span>
                              </>
                            ) : (
                              <span className="text-red-400 text-xs italic">Silinmiş Kisi</span>
                            )}
                          </div>
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
                              <span className="w-8 text-red-400/80">Hdf:</span> <span className="text-red-300">{format(parseISO(task.hedefTarih), 'dd MMM yyyy', { locale: tr })}</span>
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
          <h2 className="text-2xl font-bold text-gray-100 capitalize flex items-center gap-3">
            <CalendarIcon className="text-blue-500" size={24} />
            {format(currentMonth, 'MMMM yyyy', { locale: tr })}
          </h2>
          <div className="flex items-center gap-2">
            <button 
              onClick={goToToday}
              className="px-4 py-2 text-sm font-medium border border-gray-700 bg-gray-950 text-gray-300 rounded-lg hover:bg-gray-800 transition-colors mr-2"
            >
              Bugün
            </button>
            <div className="flex items-center bg-gray-950 rounded-lg border border-gray-700 overflow-hidden">
              <button 
                onClick={prevMonth}
                className="p-2 text-gray-400 hover:text-gray-100 hover:bg-gray-800 transition-colors border-r border-gray-700"
              >
                <ChevronLeft size={20} />
              </button>
              <button 
                onClick={nextMonth}
                className="p-2 text-gray-400 hover:text-gray-100 hover:bg-gray-800 transition-colors"
              >
                <ChevronRight size={20} />
              </button>
            </div>
          </div>
        </div>

        {/* Calendar Grid */}
        <div className="flex flex-col flex-1 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden shadow-sm">
          {/* Days Week Header */}
          <div className="grid grid-cols-7 border-b border-gray-800 bg-gray-950/80">
            {['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'].map((day, i) => (
              <div key={day} className={`p-3 text-center text-sm font-semibold tracking-wide uppercase ${i >= 5 ? 'text-red-400/80' : 'text-gray-400'}`}>
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

              return (
                <div 
                  key={day.toString()} 
                  className={`
                    bg-gray-900 p-2 lg:p-3 flex flex-col gap-1.5 transition-colors
                    ${!isCurrMonth ? 'bg-gray-900/40 opacity-50' : 'hover:bg-gray-800/40'}
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
                        className={`text-[11px] px-2 py-1.5 rounded flex flex-col gap-0.5 shadow-sm border ${getKeywordColor(task.keyword)}`}
                        title={`${task.proje} - ${task.task}`}
                      >
                        <span className="font-bold truncate text-xs">{task.keyword}</span>
                        <div className="flex items-center gap-1 opacity-80 mt-0.5">
                          <Users size={10} />
                          <span className="truncate text-[10px] font-medium">{task.sorumlu}</span>
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
    
    const grouped = tasks.reduce((acc, t) => {
      const key = t[ganttGroupBy] || 'Silinmiş Kisi/Bilinmeyen';
      if (!acc[key]) acc[key] = [];
      acc[key].push(t);
      return acc;
    }, {} as Record<string, Task[]>);

    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-gray-900 border border-gray-800 rounded-xl p-4 shadow-sm gap-4">
          <h2 className="text-2xl font-bold text-gray-100 flex items-center gap-3 shrink-0">
            <GanttChart className="text-indigo-400" size={24} />
            Gantt Şeması
          </h2>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2 bg-gray-950 px-2 py-1.5 rounded-lg border border-gray-800">
               <span className="text-xs text-gray-500 font-medium whitespace-nowrap">Aralık:</span>
               <input type="date" className="bg-transparent text-gray-300 text-xs focus:outline-none" style={{colorScheme: 'dark'}} value={customGanttRange?.start || format(defaultMin, 'yyyy-MM-dd')} onChange={e => setCustomGanttRange(prev => ({start: e.target.value, end: prev?.end || format(defaultMax, 'yyyy-MM-dd')}))} />
               <span className="text-gray-600">-</span>
               <input type="date" className="bg-transparent text-gray-300 text-xs focus:outline-none" style={{colorScheme: 'dark'}} value={customGanttRange?.end || format(defaultMax, 'yyyy-MM-dd')} onChange={e => setCustomGanttRange(prev => ({start: prev?.start || format(defaultMin, 'yyyy-MM-dd'), end: e.target.value}))} />
               {customGanttRange && <button onClick={() => setCustomGanttRange(null)} className="hover:bg-gray-800 text-gray-400 p-1 rounded transition-colors" title="Sıfırla"><X size={14}/></button>}
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
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl shadow-sm flex flex-col pt-1 pl-1">
          <div 
            className="flex overflow-x-auto pb-4 custom-scrollbar rounded-xl cursor-grab"
            ref={scrollRef}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            onMouseMove={handleMouseMove}
          >
            <div className="min-w-max flex flex-col pt-2 pb-2 pr-4 bg-gray-900">
              
              {/* Timeline Header */}
              <div className="flex mb-4 sticky top-0 z-10 bg-gray-900/95 backdrop-blur-md shadow-[0_1px_0_0_#1f2937]">
                <div className="w-[180px] shrink-0 sticky left-0 z-20 bg-gray-900/95 flex items-end pb-2 px-4 shadow-[1px_0_0_0_#1f2937]">
                   <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">{ganttGroupBy === 'proje' ? 'Projeler' : 'Sorumlular'}</span>
                </div>
                <div className="flex">
                  {timelineDays.map(d => (
                    <div key={d.toString()} className={`w-10 shrink-0 flex flex-col items-center justify-end pb-2 ${isToday(d) ? 'bg-indigo-500/10' : ''}`}>
                      <span className="text-[9px] text-gray-500 font-medium uppercase">{format(d, 'eee', {locale: tr})}</span>
                      <span className={`text-[11px] font-bold mt-0.5 ${isToday(d) ? 'text-indigo-400' : 'text-gray-300'}`}>{format(d, 'dd')}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Grouped Rows */}
              <div className="flex flex-col gap-6">
                {Object.entries(grouped).map(([groupName, groupTasks]) => (
                  <div key={groupName} className="flex flex-col gap-1.5 relative">
                    {/* Header Row */}
                    <div className="flex items-center">
                      <div 
                        className="w-[180px] sticky left-0 z-10 bg-gray-900/98 py-1.5 px-4 shadow-[1px_0_0_0_#1f2937] cursor-pointer hover:bg-gray-800/80 transition-colors group/header flex items-center"
                        onClick={() => toggleGroup(groupName)}
                        title={`${groupName} grubunu daralt/genişlet`}
                      >
                        <h3 className="font-semibold text-[13px] text-gray-200 truncate pr-2 flex items-center gap-2 select-none w-full">
                          {collapsedGroups[groupName] ? (
                            <ChevronRight size={14} className="text-gray-500 group-hover/header:text-gray-300 transition-colors" />
                          ) : (
                            <ChevronDown size={14} className="text-gray-500 group-hover/header:text-gray-300 transition-colors" />
                          )}
                          <span className="truncate">{groupName}</span>
                          <span className="text-[10px] text-gray-500 ml-auto bg-gray-800 px-1.5 py-0.5 rounded-md font-medium">{groupTasks.length}</span>
                        </h3>
                      </div>
                      <div className="flex-1 right-0 border-b border-gray-800/80 h-px"></div>
                    </div>
                    
                    {/* Task Rows */}
                    {!collapsedGroups[groupName] && groupTasks.sort((a,b) => parseISO(a.baslangicTarihi).getTime() - parseISO(b.baslangicTarihi).getTime()).map(task => {
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
                        <div key={task.id} className="group relative flex items-center hover:bg-gray-800/20 py-1 transition-colors">
                          <div className="w-[180px] shrink-0 sticky left-0 z-10 bg-gray-900 px-4 flex items-center shadow-[1px_0_0_0_#1f2937] select-none">
                            <span className="text-[11px] text-gray-400 group-hover:text-gray-200 transition-colors line-clamp-1 pr-2" title={task.task}>{task.keyword}</span>
                          </div>
                          <div className="relative h-6 flex items-center select-none" style={{ width: totalDays * 40 }}>
                            {/* Inner Grid */}
                            <div className="absolute inset-0 flex pointer-events-none opacity-[0.03]">
                              {timelineDays.map(d => (
                                <div key={d.toString()} className={`w-10 border-l border-gray-100 h-full ${isToday(d) ? 'bg-indigo-500/50' : ''}`}></div>
                              ))}
                            </div>
                            
                            {/* Bar segment */}
                            <div 
                              className={`absolute h-5 rounded-md px-2 flex items-center text-[10px] font-semibold text-white whitespace-nowrap overflow-hidden shadow-sm transition-all hover:brightness-110 cursor-pointer 
                                ${getKeywordColor(task.keyword).split(' ')[0].replace('/20', '')}`}
                              style={{ left: `${leftOffset}px`, width: `${barWidth}px` }}
                              onMouseEnter={(e) => !isDragging.current && setTooltipConfig({show: true, task, x: e.clientX, y: e.clientY})}
                              onMouseMove={(e) => !isDragging.current && setTooltipConfig(prev => ({...prev, x: e.clientX, y: e.clientY}))}
                              onMouseLeave={() => setTooltipConfig(prev => ({...prev, show: false}))}
                            >
                              <span className="truncate">{barWidth > 40 && task.keyword}</span>
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
                ))}
              </div>

            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderSorumlularSheet = () => (
    <div className="max-w-2xl mx-auto flex flex-col gap-6">
      {/* Intro block */}
      <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 flex gap-4 items-start">
        <Users className="text-blue-400 shrink-0 mt-1" size={24} />
        <div>
          <h3 className="text-blue-300 font-semibold mb-1">Data Sayfası</h3>
          <p className="text-sm text-blue-200/70">
            Veri Girişi tablosunda Sorumlu sütununda listelenecek kişileri bu sayfadan ekleyip çıkarabilirsiniz. Veriler dinamik olarak beslenecektir.
          </p>
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden shadow-sm">
        <div className="p-4 border-b border-gray-800 bg-gray-900/50">
          <h2 className="text-lg font-medium text-gray-100">Yeni Sorumlu Ekle</h2>
        </div>
        <div className="p-4">
          <form onSubmit={handleAddSorumlu} className="flex gap-3 max-w-sm">
            <input 
              type="text" 
              value={newSorumlu} 
              onChange={(e) => setNewSorumlu(e.target.value)}
              className="flex-1 bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
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
        <div className="p-4 border-b border-gray-800 bg-gray-900/50 flex justify-between items-center">
          <h2 className="text-lg font-medium text-gray-100">Sorumlular Listesi</h2>
          <span className="text-xs bg-gray-800 text-gray-400 px-2 py-1 rounded-md font-medium">{sorumlular.length} Kişi</span>
        </div>
        <div className="p-0">
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
  );

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans selection:bg-blue-500/30 selection:text-blue-200">
      {/* Header & Navigation */}
      <header className="bg-gray-900 border-b border-gray-800 sticky top-0 z-10 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between py-4 sm:h-16 gap-4 sm:gap-0">
            <div className="flex items-center gap-3">
              <div className="bg-blue-600/20 border border-blue-500/30 p-2.5 rounded-xl shadow-inner">
                <CalendarIcon className="text-blue-400" size={20} />
              </div>
              <div className="flex flex-col">
                <h1 className="text-lg font-bold bg-gradient-to-r from-gray-100 to-gray-400 bg-clip-text text-transparent">MacroPlan</h1>
                <p className="text-[10px] text-gray-500 font-mono uppercase tracking-wider">Görev & Takvim</p>
              </div>
            </div>
            
            <nav className="flex items-center p-1 bg-gray-950/50 rounded-xl border border-gray-800/80 backdrop-blur-sm sm:w-auto">
              <button
                onClick={() => setActiveTab('veri')}
                className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all flex-1 sm:flex-none ${
                  activeTab === 'veri' 
                    ? 'bg-gray-800 text-white shadow-sm ring-1 ring-gray-700' 
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                }`}
              >
                <ListTodo size={16} />
                <span>Veri Girişi</span>
              </button>
              <button
                onClick={() => setActiveTab('takvim')}
                className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all flex-1 sm:flex-none ${
                  activeTab === 'takvim' 
                    ? 'bg-gray-800 text-white shadow-sm ring-1 ring-gray-700' 
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
                    ? 'bg-gray-800 text-white shadow-sm ring-1 ring-gray-700' 
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                }`}
              >
                <GanttChart size={16} />
                <span>Gantt</span>
              </button>
              <button
                onClick={() => setActiveTab('kisi')}
                className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all flex-1 sm:flex-none ${
                  activeTab === 'kisi' 
                    ? 'bg-gray-800 text-white shadow-sm ring-1 ring-gray-700' 
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                }`}
              >
                <Users size={16} />
                <span>Data (Kişiler)</span>
              </button>
            </nav>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-10">
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out fill-mode-both">
          {activeTab === 'veri' && renderDataSheet()}
          {activeTab === 'takvim' && renderCalendarSheet()}
          {activeTab === 'gantt' && renderGanttSheet()}
          {activeTab === 'kisi' && renderSorumlularSheet()}
        </div>
      </main>

      {/* Global Tooltip */}
      {tooltipConfig.show && tooltipConfig.task && (
        <div 
          className="fixed z-[9999] pointer-events-none bg-gray-900 border border-gray-700 shadow-2xl rounded-lg p-3 text-xs w-64 transform -translate-x-1/2 -translate-y-[calc(100%+16px)]" 
          style={{ left: tooltipConfig.x, top: tooltipConfig.y }}
        >
          <div className="font-semibold text-gray-100 flex items-center gap-2 mb-1.5 pb-1.5 border-b border-gray-800">
            <span className={`w-2 h-2 rounded-full ${getKeywordColor(tooltipConfig.task.keyword).split(' ')[0].replace('/20', '')}`}></span>
            <span className="truncate">{tooltipConfig.task.proje} - {tooltipConfig.task.keyword}</span>
          </div>
          <p className="text-gray-300 text-[11px] mb-2 leading-relaxed line-clamp-3">{tooltipConfig.task.task}</p>
          <div className="flex flex-col gap-1 text-[11px]">
            <div className="flex justify-between">
              <span className="text-gray-500">Sorumlu:</span>
              <span className="text-gray-200 font-medium">{tooltipConfig.task.sorumlu}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Başlangıç:</span>
              <span className="text-gray-200 font-mono">{format(parseISO(tooltipConfig.task.baslangicTarihi), 'dd MMM yyyy', {locale: tr})}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Bitiş:</span>
              <span className="text-gray-200 font-mono">{format(parseISO(tooltipConfig.task.bitisTarihi), 'dd MMM yyyy', {locale: tr})}</span>
            </div>
            <div className="flex justify-between pt-1 border-t border-gray-800/60 mt-1">
              <span className="text-rose-400/80">Hedef Tarih:</span>
              <span className="text-rose-300 font-mono font-medium">{format(parseISO(tooltipConfig.task.hedefTarih), 'dd MMM yyyy', {locale: tr})}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
