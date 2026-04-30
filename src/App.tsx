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
  isToday
} from 'date-fns';
import { tr } from 'date-fns/locale';
import { 
  Calendar as CalendarIcon, 
  ListTodo, 
  Users, 
  Plus, 
  Trash2, 
  ChevronLeft, 
  ChevronRight
} from 'lucide-react';

type Task = {
  id: string;
  proje: string;
  task: string;
  keyword: string;
  sorumlu: string;
  tarih: string; // YYYY-MM-DD
};

const initialSorumlular = ['Ahmet Yılmaz', 'Mehmet Demir', 'Ayşe Kaya', 'Elif Yıldız', 'Can Özkan'];

const initialTasks: Task[] = [
  { id: '1', proje: 'Web Sitesi Yenileme', task: 'UI/UX tasarımının tamamlanması ve onay sürecinin bitirilmesi', keyword: 'Tasarım', sorumlu: 'Ahmet Yılmaz', tarih: '2026-04-15' },
  { id: '2', proje: 'Web Sitesi Yenileme', task: 'Tasarımın React ve Tailwind ile frontend kodlamasının yapılması', keyword: 'Frontend', sorumlu: 'Ayşe Kaya', tarih: '2026-04-20' },
  { id: '3', proje: 'Mobil Uygulama', task: 'Kullanıcı giriş ve kayıt API uçlarının Node.js ile yazılması', keyword: 'Auth API', sorumlu: 'Mehmet Demir', tarih: '2026-04-28' },
  { id: '4', proje: 'Mobil Uygulama', task: 'Yazılan API uçları için entegrasyon testlerinin tamamlanması', keyword: 'Test', sorumlu: 'Elif Yıldız', tarih: '2026-05-02' },
  { id: '5', proje: 'Sosyal Medya', task: 'Haziran ayı kampanya görsellerinin hazırlanması', keyword: 'Görseller', sorumlu: 'Ahmet Yılmaz', tarih: '2026-05-05' },
  { id: '6', proje: 'Veritabanı', task: 'Mevcut kullanıcı veritabanının yeni sunucuya taşınması', keyword: 'DB Göçü', sorumlu: 'Mehmet Demir', tarih: '2026-04-30' },
  { id: '7', proje: 'Altyapı', task: 'Sunucu işletim sistemi ve paket güncellemelerinin yapılması', keyword: 'Sunucu', sorumlu: 'Can Özkan', tarih: '2026-04-30' },
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
  const [activeTab, setActiveTab] = useState<'kisi' | 'veri' | 'takvim'>('veri');
  
  const [tasks, setTasks] = useState<Task[]>(() => {
    const saved = localStorage.getItem('macroplan-tasks');
    if (saved) return JSON.parse(saved);
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
    tarih: format(new Date(), 'yyyy-MM-dd') 
  });
  
  const [newSorumlu, setNewSorumlu] = useState('');

  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.proje || !newTask.task || !newTask.keyword || !newTask.sorumlu || !newTask.tarih) {
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
          <form onSubmit={handleAddTask} className="grid grid-cols-1 md:grid-cols-6 gap-4 items-end">
            <div className="flex flex-col gap-1.5 md:col-span-1">
              <label className="text-sm text-gray-400 font-medium">Proje</label>
              <input 
                type="text" 
                value={newTask.proje || ''} 
                onChange={(e) => setNewTask({...newTask, proje: e.target.value})}
                className="bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                placeholder="Örn: Proje A"
              />
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-1">
              <label className="text-sm text-gray-400 font-medium">Task (Uzun Tanım)</label>
              <input 
                type="text" 
                value={newTask.task || ''} 
                onChange={(e) => setNewTask({...newTask, task: e.target.value})}
                className="bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                placeholder="Örn: Tasarımın..."
              />
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-1">
              <label className="text-sm text-gray-400 font-medium">Keyword (Kısa Tanım)</label>
              <input 
                type="text" 
                value={newTask.keyword || ''} 
                onChange={(e) => setNewTask({...newTask, keyword: e.target.value})}
                className="bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                placeholder="Tasarım"
              />
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-1">
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
            <div className="flex flex-col gap-1.5 md:col-span-1">
              <label className="text-sm text-gray-400 font-medium">Tarih</label>
              <input 
                type="date" 
                value={newTask.tarih || ''} 
                onChange={(e) => setNewTask({...newTask, tarih: e.target.value})}
                className="bg-gray-950 border border-gray-700 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                // inline style trick to make calendar icon white on older webkit
                style={{ colorScheme: 'dark' }}
              />
            </div>
            <div className="md:col-span-1 flex justify-end">
              <button 
                type="submit" 
                className="w-full bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 h-[38px]"
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
                <th className="px-6 py-4 font-medium">Tarih</th>
                <th className="px-6 py-4 font-medium text-center w-20">İşlem</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {tasks.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-gray-500">Henüz hiç görev eklenmemiş.</td>
                </tr>
              ) : null}
              {tasks.sort((a,b) => a.tarih.localeCompare(b.tarih)).map((task) => (
                <tr key={task.id} className="hover:bg-gray-800/40 transition-colors">
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
                  <td className="px-6 py-4 whitespace-nowrap text-gray-400 font-mono text-xs">
                    {format(parseISO(task.tarih), 'dd MMM yyyy', { locale: tr })}
                  </td>
                  <td className="px-6 py-4 text-center">
                    <button 
                      onClick={() => handleDeleteTask(task.id)}
                      className="text-gray-500 hover:text-red-400 p-1.5 hover:bg-red-400/10 rounded-lg transition-colors"
                      title="Sil"
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
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
              const dayTasks = tasks.filter(t => t.tarih === dateKey);
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
            
            <nav className="flex items-center p-1 bg-gray-950/50 rounded-xl border border-gray-800/80 backdrop-blur-sm self-stretch max-w-full overflow-x-auto hide-scrollbar">
              <button
                onClick={() => setActiveTab('veri')}
                className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all shrink-0 ${
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
                className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all shrink-0 ${
                  activeTab === 'takvim' 
                    ? 'bg-gray-800 text-white shadow-sm ring-1 ring-gray-700' 
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                }`}
              >
                <CalendarIcon size={16} />
                <span>Takvim</span>
              </button>
              <button
                onClick={() => setActiveTab('kisi')}
                className={`flex items-center justify-center gap-2 px-3 lg:px-5 py-2 rounded-lg text-sm font-medium transition-all shrink-0 ${
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
          {activeTab === 'kisi' && renderSorumlularSheet()}
        </div>
      </main>
    </div>
  );
}
