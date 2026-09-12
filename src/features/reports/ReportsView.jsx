'use client';
import { TaskActivitiesView } from './TaskActivitiesView.jsx';
import React, { useMemo as useMemo2, useState as useState2 } from 'react';
import { Icons } from '../../components/icons';
import { PRIORITIES, normalizePriorityId } from '../../domain/constants';
import { parseDate, fmt, fmtAxisDate, addDays, diffDays, startOfWeek, endOfWeek, today } from '../../scheduling/dates';
import { countUnknownCompletionDates, taskCompletionDate } from '../../scheduling/metrics';
import { COLOR_MAP, projectColorVar } from '../../lib/colors';
import { HeroHeader, AreaChart } from '../../components/ui';
import { Tooltip, InfoButton, CardHead, AnimatedNumber } from '../../components/ui-extras';
import { useTasks } from '../../state/hooks';
import { selectOverdueAging } from '../dashboard/planHealth.js';
import { useTodayKey } from '../../hooks/useTodayKey.js';
import { DateRangeFilter } from '../../components/DateRangeFilter';
import {
  DEFAULT_DATE_RANGE_PRESET,
  describeDateRange,
  filterTasksByDateRange,
  resolveDateRangeSelection
} from '../shared/dateRangeFilter.js';

/* ── Rapor (Reports) ──────────────────────────────────── */
const REPORT_TABS = [{ id: 'performance', label: 'Performans' }, { id: 'activities', label: 'Görev Hareketleri' }];

export function ReportsView() {
  const [tab, setTab] = useState2('performance');
  const [activityVisited, setActivityVisited] = useState2(false);
  const tabsRef = React.useRef(null);
  const select = (id) => { setTab(id); if (id === 'activities') setActivityVisited(true); };
  return <div className="reports-module">
    <HeroHeader title="Raporlar"><span className="muted">Performans ve görev değişiklikleri.</span></HeroHeader>
    <div className="request-tabs" role="tablist" aria-label="Rapor türü" ref={tabsRef}>
      {REPORT_TABS.map((item, index) => <button key={item.id} type="button" role="tab" id={`report-tab-${item.id}`}
        aria-controls={`report-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1}
        onClick={() => select(item.id)} onKeyDown={(event) => {
          let next;
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = 1 - index;
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = 1;
          if (next == null) return;
          event.preventDefault(); select(REPORT_TABS[next].id);
          tabsRef.current?.querySelectorAll('[role="tab"]')[next]?.focus();
        }}>{item.label}</button>)}
    </div>
    <div role="tabpanel" id="report-panel-performance" aria-labelledby="report-tab-performance" hidden={tab !== 'performance'}><PerformanceReportsView /></div>
    <div role="tabpanel" id="report-panel-activities" aria-labelledby="report-tab-activities" hidden={tab !== 'activities'}>
      {activityVisited && <TaskActivitiesView active={tab === 'activities'} />}
    </div>
  </div>;
}

export function PerformanceReportsView() {
  const allTasks = useTasks();
  // Referans gün KARARLI bir değerdir: `today()` her çizimde yeni bir `Date`
  // döndürdüğü için doğrudan bağımlılık olamaz, bağımlılıktan çıkarıldığında da
  // sayfa gece yarısını açık geçtiğinde dünün sınıflandırmasında kalırdı.
  // Gün sınırı İZLENİR: sayfa gece yarısını açık geçtiğinde yeniden çizilir
  // ve tarihe duyarlı bütün memolar tazelenir.
  const todayKey = useTodayKey();
  const today_ = useMemo2(() => parseDate(todayKey), [todayKey]);

  // Raporlar bütün geçmişi tek sayfada özetliyordu; kurulum yaşlandıkça eğilim
  // grafikleri ve tablolar okunamaz hâle geliyordu. Aralık, türetilmiş bütün
  // ölçümlerin ÖNÜNDE uygulanır ki her kart aynı kümeyi anlatsın.
  const [dateRange, setDateRange] = useState2({ preset: DEFAULT_DATE_RANGE_PRESET, start: '', end: '' });
  const activeRange = useMemo2(() => resolveDateRangeSelection(dateRange, today_), [dateRange, today_]);
  const tasks = useMemo2(() => filterTasksByDateRange(allTasks, activeRange), [allTasks, activeRange]);

  // Bir görev GERÇEKLEŞEN bitiş tarihinde tamamlanmış sayılır; planlanan bitişe
  // bakmak, planı ileri bir tarihte olan ama bugün bitirilen görevi eğriye
  // hiç sokmuyordu.
  const trend = useMemo2(() => {
    const values = [];
    const labels = [];
    const completions = tasks
      .map(taskCompletionDate)
      .filter(Boolean)
      .map((value) => parseDate(value));
    for (let offset = 29; offset >= 0; offset -= 1) {
      const day = addDays(today_, -offset);
      values.push(completions.filter((finish) => finish <= day).length);
      // Eksen etiketi tarih biçimi tercihinden BAĞIMSIZDIR: `dd/mm/yyyy`
      // seçiliyken altı etiket birbirine giriyor ve karttan taşıyordu.
      labels.push(offset % 5 === 0 ? fmtAxisDate(day) : '');
    }
    return { values, labels };
  }, [tasks, today_]);

  // Gerçekleşen bitişi olmayan tamamlanmış görevler kronolojik ölçümlerin
  // DIŞINDA kalır; sessizce kaybolmamaları için sayıları raporlanır.
  const unknownCompletions = useMemo2(() => countUnknownCompletionDates(tasks), [tasks]);


  // Cumulative Flow Diagram — last 14 days
  const cfd = useMemo2(() => {
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = addDays(today_, -i);
      let todo = 0, prog = 0, done = 0;
      tasks.forEach(t => {
        // Tarihi OLMAYAN görev sütun dışında bırakılır. `parseDate(null)` bugünü
        // döndürdüğü için başlangıcı boş bir görev "bugün başlamış" sayılıyor,
        // sonuç sayfanın ne zaman açıldığına göre değişiyordu.
        if (!t.plannedStart) return;
        const s = parseDate(t.plannedStart);
        // ÇÖZÜMLENEMEYEN başlangıç da elenir: `parseDate('invalid')` Invalid Date
        // döndürür, `s > d` karşılaştırması `false` olur ve görev CFD'nin HER
        // gününde "başlamış" sayılırdı.
        if (!Number.isFinite(s?.getTime?.())) return;
        if (s > d) return; // hasn't started yet
        // Tamamlanma kronolojisi GERÇEKLEŞEN bitişten okunur. Planlanan bitişe
        // bakan eski hesap, 18 Ağustos'ta biten ama 10 Eylül'e planlanmış bir
        // görevi eğilim grafiğinde tamamlanmış, CFD'de ise Eylül'e kadar devam
        // ediyor gösteriyordu.
        const finished = taskCompletionDate(t);
        if (t.status === 'done' && !finished) return; // ne zaman bittiği bilinmiyor
        if (finished && parseDate(finished) <= d) done++;
        else if (t.status === 'in_progress' || t.status === 'done') prog++;
        else todo++;
      });
      days.push({ d, todo, prog, done, label: i % 3 === 0 ? fmtAxisDate(d) : '' });
    }
    return days;
  }, [tasks, today_]);

  // Weekly velocity — tasks completed each of last 6 weeks
  const velocity = useMemo2(() => {
    const out = [];
    for (let i = 5; i >= 0; i--) {
      const weekEnd = endOfWeek(addDays(today_, -i * 7));
      const weekStart = startOfWeek(weekEnd);
      const count = tasks.filter(t => {
        const finished = taskCompletionDate(t);
        if (!finished) return false;
        const e = parseDate(finished);
        return e >= weekStart && e <= weekEnd;
      }).length;
      out.push({ label: `${fmt(weekStart, 'd')}–${fmt(weekEnd, 'd')}`, value: count });
    }
    return out;
  }, [tasks, today_]);

  // Risk matrix — by priority × status (in-progress + todo)
  const risks = useMemo2(() => {
    const matrix = {};
    Object.keys(PRIORITIES).forEach(p => {
      matrix[p] = { todo: [], in_progress: [], overdue: [] };
    });
    tasks.forEach(t => {
      if (t.status === 'done') return;
      const p = normalizePriorityId(t.priority);
      const overdue = t.targetFinish && diffDays(t.targetFinish, today_) < 0;
      if (overdue) matrix[p].overdue.push(t);
      else if (t.status === 'in_progress') matrix[p].in_progress.push(t);
      else matrix[p].todo.push(t);
    });
    return matrix;
  }, [tasks, today_]);

  const projThroughput = useMemo2(() => {
    const map = {};
    tasks.forEach(t => {
      map[t.proje] = map[t.proje] || { total: 0, done: 0, late: 0 };
      map[t.proje].total++;
      if (t.status === 'done') map[t.proje].done++;
      if (t.status !== 'done' && t.targetFinish && diffDays(t.targetFinish, today_) < 0) map[t.proje].late++;
    });
    return Object.entries(map).map(([name, v]) => ({ name, ...v, color: projectColorVar(name) }));
  }, [tasks, today_]);

  const cycle = useMemo2(() => {
    const completed = tasks.filter(t => t.status === 'done');
    if (!completed.length) return { avg: 0, min: 0, max: 0 };
    const durations = completed.map(t => t.plannedDurationDays || 0);
    return {
      avg: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      min: Math.min(...durations),
      max: Math.max(...durations)
    };
  }, [tasks]);

  const onTime = useMemo2(() => {
    const completed = tasks.filter(t => t.status === 'done');
    if (!completed.length) return 0;
    // Oran GERÇEKLEŞEN bitişten hesaplanır. `plannedFinish` PLANIN öngörüsüdür,
    // tamamlanma tarihi değil: hedefinden önce bitmesi PLANLANMIŞ ama hedeften
    // sonra TAMAMLANMIŞ bir görev "zamanında" sayılıyordu. Eğilim ve CFD
    // hesapları zaten `taskCompletionDate` kullanır.
    const targeted = completed
      .map(t => ({ task: t, finished: taskCompletionDate(t) }))
      .filter(({ task, finished }) => task.targetFinish && finished);
    if (!targeted.length) return 0;
    const ot = targeted.filter(({ task, finished }) => diffDays(finished, task.targetFinish) <= 0).length;
    return Math.round((ot / targeted.length) * 100);
  }, [tasks]);

  const tagDist = useMemo2(() => {
    const map = {};
    const taskMap = {};
    tasks.forEach(t => {
      // Etiket anahtarı `distinctTagCount` ile AYNI biçimde normalleştirilir:
      // aksi hâlde `"Risk"` ile `" Risk "` iki ayrı çip olarak çizilirken alt
      // başlık tek bir etiket bildiriyordu.
      const key = String(t.keyword || '').trim();
      if (!key) return;
      map[key] = (map[key] || 0) + 1;
      taskMap[key] = taskMap[key] || { done: 0, total: 0, late: 0, color: t.color };
      taskMap[key].total++;
      if (t.status === 'done') taskMap[key].done++;
      if (t.status !== 'done' && t.targetFinish && diffDays(t.targetFinish, today_) < 0) taskMap[key].late++;
    });
    return Object.entries(map).map(([k, v]) => ({
      label: k, value: v, color: COLOR_MAP[taskMap[k].color] || 'var(--accent)',
      colorKey: taskMap[k].color, done: taskMap[k].done, total: taskMap[k].total, late: taskMap[k].late
    })).sort((a, b) => b.value - a.value).slice(0, 10);
  }, [tasks, today_]);

  // Farklı etiket sayısı, listenin ilk 10'a kırpılmasından ÖNCE ölçülür:
  // `tagDist.length` kullanıldığında 10'dan fazla etiket taşıyan her projede
  // başlık her zaman "10 farklı etiket" diyordu.
  const distinctTagCount = useMemo2(
    () => new Set(tasks.map((t) => String(t.keyword || '').trim()).filter(Boolean)).size,
    [tasks]
  );
  const aging = useMemo2(() => selectOverdueAging(tasks, today_), [tasks, today_]);
  const agingAverage = useMemo2(() => {
    const late = aging.buckets.flatMap((bucket) => bucket.items).map((task) => task.lateBy);
    return late.length ? Math.round(late.reduce((sum, days) => sum + days, 0) / late.length) : 0;
  }, [aging]);

  const compRate = tasks.length ? Math.round(tasks.filter(t => t.status === 'done').length / tasks.length * 100) : 0;
  const doneCount = tasks.filter(t => t.status === 'done').length;
  const pendingCount = tasks.filter(t => t.status !== 'done').length;

  return (
    <div className="col stagger" style={{ gap: 20 }}>
      <p className="muted" style={{ margin: 0 }}>Performans, çevrim süreleri ve teslim oranları.</p>

      <DateRangeFilter
        value={dateRange}
        onChange={setDateRange}
        summary={activeRange
          ? `${describeDateRange(activeRange)} · ${tasks.length}/${allTasks.length} görev`
          : `${allTasks.length} görev`}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Big label="Tamamlama oranı" value={compRate} suffix="%" sub={`${doneCount} / ${tasks.length} görev`}
          tip="Tamamlanan görevlerin toplam görevlere oranı. Yüksek değer, takımın iş akışını verimli ilerlettiğini gösterir." />
        <Big label="Zamanında teslim" value={onTime} suffix="%" sub="tamamlanan görevlerin" accent={onTime >= 70 ? 'var(--status-done)' : 'var(--status-overdue)'}
          tip={<>
            <p>Hedef tarihinden önce veya hedef tarihinde tamamlanan görevlerin oranı.</p>
            <div className="rt-sep" />
            <div className="rt-row"><Icons.TrendUp size={12} className="rt-ico" /><span><strong>≥ %70</strong> sağlıklı ekip ritmi</span></div>
            <div className="rt-row"><Icons.Alert size={12} className="rt-ico" /><span><strong>&lt; %70</strong> planlama gözden geçirilmeli</span></div>
          </>}
        />
        <Big label="Ort. çevrim süresi" value={cycle.avg} suffix=" gün" sub={`min ${cycle.min} · max ${cycle.max}`}
          tip="Bir görevin başlangıçtan bitişine kadar geçen ortalama süre. Daha kısa çevrim, takım çevikliğine işaret eder." />
        <Big label="Bekleyen iş yükü" value={pendingCount} sub="aktif görev"
          tip="Henüz tamamlanmamış (yapılacak + devam eden) görev sayısı. Bekleyen iş listesinin büyüklüğünü ve önümüzdeki yükü gösterir." />
      </div>

      {/* Tamamlanma eğilimi grafiği */}
      <div className="card">
        <div className="row" style={{ marginBottom: 14 }}>
          <div className="col">
            <div className="card-title" style={{ margin: 0 }}>
              <Icons.TrendUp size={14} /> 30 Günlük Tamamlama Eğrisi
              <InfoButton title="Tamamlama eğrisi" icon={<Icons.TrendUp size={12} />}>
                <p>Son 30 gün içinde birikimli olarak tamamlanan görev sayısının değişimi.</p>
                <div className="rt-sep" />
                <div className="rt-row"><span className="rt-label">Eğri yatay</span><span className="rt-val">Yavaşlama</span></div>
                <div className="rt-row"><span className="rt-label">Eğri dik</span><span className="rt-val">Hızlanma</span></div>
              </InfoButton>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Birikimli ‘Tamamlandı’ sayısı · gerçekleşen bitiş tarihine göre
            </div>
          </div>
        </div>
        {/* Gerçekleşen bitişi olmayan tamamlanmış görevler kronolojiye
            giremez; sayı gizlenmez, açıkça yazılır. */}
        {unknownCompletions > 0 && (
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
            {unknownCompletions} tamamlanmış görevin gerçekleşen bitiş tarihi yok; eğri, akış ve hız
            ölçümlerine dâhil edilmedi.
          </div>
        )}
        <AreaChart data={trend.values} labels={trend.labels} width={1100} height={200} color="var(--status-done)" animated />
      </div>

      {/* Cumulative Flow Diagram */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
        <div className="card">
          <CardHead
            icon={<Icons.Layers size={14} />}
            title="Birikimli Akış Diyagramı"
            subtitle="Son 14 gün · devam eden iş gelişimi"
            infoAccent="var(--c-cyan)"
            infoIcon={<Icons.Layers size={12} />}
            info={<>
              <p><strong>CFD</strong>, görevlerin durum kolonları arasında zamana göre dağılımını gösterir (Lean / Kanban standardı).</p>
              <div className="rt-sep" />
              <div className="rt-row"><span className="rt-label">Bant genişler</span><span className="rt-val" style={{ color: 'var(--status-overdue)' }}>Birikim / darboğaz</span></div>
              <div className="rt-row"><span className="rt-label">Bant sabit</span><span className="rt-val" style={{ color: 'var(--status-done)' }}>Akış sağlıklı</span></div>
            </>}
          />
          <CFDChart data={cfd} />
        </div>

        <div className="card">
          <CardHead
            icon={<Icons.TrendUp size={14} />}
            title="Haftalık iş hızı"
            subtitle="Son 6 hafta · tamamlanan görev sayısı"
            infoAccent="var(--c-emerald)"
            infoIcon={<Icons.TrendUp size={12} />}
            info={<>
              <p>Her hafta tamamlanan görev sayısı. Dönem planlamasında referans olarak kullanılır.</p>
              <div className="rt-sep" />
              <div className="rt-row"><span className="rt-label">Hareketli ort.</span><span className="rt-val">{Math.round(velocity.reduce((a, b) => a + b.value, 0) / velocity.length)} görev/hafta</span></div>
              <div className="rt-foot"><Icons.Sparkle size={11} /> Sürekli artış: ekip ivmeleniyor.</div>
            </>}
          />
          <VelocityChart data={velocity} />
        </div>
      </div>

      {/* Gecikme yaşlandırması — PMO raporlamasının standart görünümü. */}
      <div className="card">
        <CardHead
          icon={<Icons.Clock size={14} />}
          title="Gecikme yaşlandırması"
          subtitle={aging.total
            ? `${aging.total} geciken görev · en eskisi ${aging.worstDays} gün · ortalama ${agingAverage} gün`
            : 'Geciken görev yok'}
          infoAccent="var(--status-overdue)"
          infoIcon={<Icons.Clock size={12} />}
          info={<>
            <p>Geciken görevler, hedef tarihinin üzerinden geçen gün sayısına göre gruplanır.</p>
            <div className="rt-sep" />
            <p>Kronikleşen gecikmeler (90+ gün) genellikle plan hatasına ya da terk edilmiş işe işaret eder; kapatılmaları ya da yeniden planlanmaları gerekir.</p>
          </>}
          right={<span className="badge" style={{ color: aging.total ? 'var(--status-overdue)' : 'var(--status-done)' }}>{aging.total} görev</span>}
        />
        {aging.total === 0 ? (
          <div className="empty">Hedef tarihi geçmiş görev yok.</div>
        ) : (
          <div className="aging-report-grid">
            {aging.buckets.map((bucket) => (
              <Tooltip
                key={bucket.id}
                title={`${bucket.label} geciken`}
                accent={bucket.color}
                // Kova payı ve ilk görev adları YALNIZCA bu ipucunda bulunur;
                // klavye kullanıcısı için tetikleyici odaklanabilir olmalıdır.
                focusable
                ariaLabel={`${bucket.label} geciken · ${bucket.value} görev`}
                // Izgara hücresi sarmalayıcıdır: genişlik verilmezse kart
                // içeriği kadar daralır ve eşit sütunlara rağmen kartlar
                // (ve yüzde çubukları) farklı genişliklerde görünürdü.
                wrapperStyle={{ display: 'block', width: '100%' }}
                icon={<span style={{ width: 10, height: 10, borderRadius: 2, background: bucket.color, display: 'inline-block' }} />}
                content={<>
                  <div className="rt-row"><span className="rt-label">Görev</span><span className="rt-val">{bucket.value}</span></div>
                  <div className="rt-row"><span className="rt-label">Pay</span><span className="rt-val">{Math.round((bucket.value / aging.total) * 100)}%</span></div>
                  {bucket.items.slice(0, 4).map((task) => (
                    <div key={task.id} className="rt-row">
                      <span className="rt-label">{task.lateBy} gün</span>
                      <span className="rt-val">{task.task}</span>
                    </div>
                  ))}
                </>}
              >
                <div className="aging-report-cell" style={{ '--aging-color': bucket.color }}>
                  <span className="aging-report-value">
                    <AnimatedNumber value={bucket.value} duration={600} />
                  </span>
                  <span className="aging-report-label">{bucket.label}</span>
                  <div className="bar-track" style={{ height: 4, marginTop: 8 }}>
                    <div className="bar-fill" style={{ width: `${(bucket.value / aging.total) * 100}%`, background: bucket.color }} />
                  </div>
                </div>
              </Tooltip>
            ))}
          </div>
        )}
      </div>

      {/* Risk matrix */}
      <div className="card">
        <CardHead
          icon={<Icons.Alert size={14} />}
          title="Risk matrisi"
          subtitle="Öncelik × durum dağılımı"
          infoAccent="var(--status-overdue)"
          infoIcon={<Icons.Alert size={12} />}
          info={<>
            <p>Açık görevlerin öncelik–durum kesişiminde gruplanması (PRINCE2 risk yönetimi yaklaşımı).</p>
            <div className="rt-sep" />
            <p>Sağ üst köşeye (kritik × geciken) yığılmış görevlere öncelikli müdahale gerekir.</p>
          </>}
        />
        <div className="risk-matrix">
          <div className="rm-th" />
          <div className="rm-th">Yapılacak</div>
          <div className="rm-th">Devam</div>
          <div className="rm-th">Geciken</div>
          {Object.values(PRIORITIES).map(p => {
            const row = risks[p.id];
            return (
              <React.Fragment key={p.id}>
                <div className="rm-row-th"><span style={{ color: p.color }}>●</span> {p.label}</div>
                {['todo', 'in_progress', 'overdue'].map(s => {
                  const items = row[s];
                  const v = items.length;
                  const intensity = Math.min(1, v / 5);
                  const statusLabel = s === 'todo' ? 'Yapılacak' : s === 'in_progress' ? 'Devam eden' : 'Geciken';
                  const cell = (
                    <div
                      className="rm-cell"
                      style={{
                        background: `color-mix(in oklab, ${p.color} ${10 + intensity * 30}%, var(--bg-elev-2))`,
                        opacity: v === 0 ? 0.35 : 1,
                        cursor: v ? 'help' : 'default',
                        width: '100%'
                      }}
                    >
                      <span className="rm-val">{v}</span>
                      <span className="rm-sub">görev</span>
                    </div>
                  );
                  if (!v) return <React.Fragment key={s}>{cell}</React.Fragment>;
                  return (
                    <Tooltip
                      key={s}
                      wrapperStyle={{ display: 'flex', width: '100%' }}
                      title={`${p.label} · ${statusLabel}`}
                      accent={p.color}
                      icon={<span style={{ color: p.color, fontSize: 9 }}>●</span>}
                      content={<>
                        <div className="rt-row"><span className="rt-label">Görev sayısı</span><span className="rt-val">{v}</span></div>
                        <div className="rt-sep" />
                        {items.slice(0, 6).map(t => (
                          <div key={t.id} className="rt-row">
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{t.task}</span>
                          </div>
                        ))}
                        {v > 6 && <div className="rt-foot">+{v - 6} görev daha</div>}
                      </>}
                    >
                      {cell}
                    </Tooltip>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 16 }}>
        <div className="card">
          <div className="card-title" style={{ marginBottom: 14 }}>
            <Icons.Briefcase size={14} /> Proje bazında ilerleme
            <InfoButton title="Proje ilerlemesi" icon={<Icons.Briefcase size={12} />}>
              <p>Her projenin toplam görev, tamamlanan ve geciken görev sayıları ile yüzdesel ilerlemesi.</p>
            </InfoButton>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Proje</th>
                <th style={{ textAlign: 'right' }}>Toplam</th>
                <th style={{ textAlign: 'right' }}>Tamamlanan</th>
                <th style={{ textAlign: 'right' }}>Geciken</th>
                <th style={{ width: 160 }}>İlerleme</th>
              </tr>
            </thead>
            <tbody>
              {projThroughput.map(p => {
                const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
                return (
                  <tr key={p.name}>
                    <td>
                      <Tooltip
                        title={p.name}
                        icon={<span style={{ width: 10, height: 10, borderRadius: 2, background: p.color, display: 'inline-block' }} />}
                        content={
                          <>
                            <div className="rt-row"><span className="rt-label">Toplam</span><span className="rt-val">{p.total}</span></div>
                            <div className="rt-row"><span className="rt-label">Tamamlanan</span><span className="rt-val" style={{ color: 'var(--status-done)' }}>{p.done}</span></div>
                            <div className="rt-row"><span className="rt-label">Geciken</span><span className="rt-val" style={p.late > 0 ? { color: 'var(--status-overdue)' } : null}>{p.late}</span></div>
                            <div className="rt-sep" />
                            <div className="rt-row"><span className="rt-label">İlerleme</span><span className="rt-val">{pct}%</span></div>
                          </>
                        }
                      >
                        <div className="row" style={{ gap: 8 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
                          <span style={{ fontWeight: 500 }}>{p.name}</span>
                        </div>
                      </Tooltip>
                    </td>
                    <td className="tabular" style={{ textAlign: 'right' }}><AnimatedNumber value={p.total} /></td>
                    <td className="tabular" style={{ textAlign: 'right', color: 'var(--status-done)' }}><AnimatedNumber value={p.done} /></td>
                    <td className="tabular" style={{ textAlign: 'right', color: p.late > 0 ? 'var(--status-overdue)' : 'var(--text-dim)' }}><AnimatedNumber value={p.late} /></td>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <div className="bar-track" style={{ flex: 1 }}>
                          <div className="bar-fill" style={{ width: `${pct}%`, background: p.color }} />
                        </div>
                        <span className="tabular" style={{ fontSize: 11.5, color: 'var(--text-muted)', minWidth: 32, textAlign: 'right' }}>
                          <AnimatedNumber value={pct} />%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="card">
          <CardHead
            icon={<Icons.Sparkle size={14} />}
            title="En sık etiketler"
            subtitle={`${distinctTagCount} farklı etiket · top 10`}
            infoAccent="var(--c-purple)"
            infoIcon={<Icons.Sparkle size={12} />}
            info={<>
              <p>Görevlerde en çok kullanılan etiketler. Hangi alanlara odaklandığınızı gösterir.</p>
              <div className="rt-sep" />
              <div className="rt-row"><span className="rt-label">Sıralama</span><span className="rt-val">Görev sayısına göre</span></div>
              <div className="rt-row"><span className="rt-label">Daire</span><span className="rt-val">Tamamlama oranı</span></div>
              <div className="rt-foot"><Icons.Sparkle size={11} /> Etiketin üzerine gelin: detaylı kırılım açılır.</div>
            </>}
          />
          <div className="tag-cloud">
            {tagDist.map((t, i) => {
              const pct = Math.round((t.done / t.total) * 100);
              const max = tagDist[0].value;
              const scale = 0.7 + 0.5 * (t.value / max);
              return (
                <Tooltip
                  key={t.label}
                  title={t.label}
                  icon={<span style={{ width: 10, height: 10, borderRadius: 2, background: t.color, display: 'inline-block' }} />}
                  accent={t.color}
                  content={<>
                    <div className="rt-row"><span className="rt-label">Toplam</span><span className="rt-val">{t.total} görev</span></div>
                    <div className="rt-row"><span className="rt-label">Tamamlanan</span><span className="rt-val" style={{ color: 'var(--status-done)' }}>{t.done}</span></div>
                    {t.late > 0 && <div className="rt-row"><span className="rt-label">Geciken</span><span className="rt-val" style={{ color: 'var(--status-overdue)' }}>{t.late}</span></div>}
                    <div className="rt-sep" />
                    <div className="rt-row"><span className="rt-label">Tamamlama</span><span className="rt-val">{pct}%</span></div>
                    <div className="rt-bar"><div style={{ width: `${pct}%`, background: t.color }} /></div>
                  </>}
                >
                  <div
                    className="tag-chip"
                    style={{
                      '--tg-color': t.color,
                      animationDelay: `${i * 35}ms`,
                      fontSize: `${12 + scale * 1}px`
                    }}
                  >
                    <span className="tg-ring" style={{ '--p': pct, '--tg-color': t.color }}>
                      <span className="tg-ring-bg" />
                      <span className="tg-ring-fg" />
                      <span className="tg-count">{t.value}</span>
                    </span>
                    <div className="col" style={{ gap: 2, minWidth: 0 }}>
                      <span className="tg-label">{t.label}</span>
                      <span className="tg-meta">
                        <span style={{ color: 'var(--status-done)' }}>{t.done}</span>
                        <span style={{ color: 'var(--text-dim)' }}> / {t.total}</span>
                        <span style={{ color: 'var(--text-dim)' }}>  · {pct}%</span>
                      </span>
                    </div>
                  </div>
                </Tooltip>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Big({ label, value, suffix, sub, accent, tip }) {
  return (
    <div className="card" style={{ padding: 18, position: 'relative' }}>
      {tip && (
        <div className="card-info-corner">
          <InfoButton title={label} corner accent={accent}>{tip}</InfoButton>
        </div>
      )}
      <div className="muted" style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '0.01em', marginBottom: 8 }}>{label}</div>
      <div className="tabular" style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-0.025em', color: accent || 'var(--text)', lineHeight: 1.05 }}>
        <AnimatedNumber value={typeof value === 'number' ? value : parseInt(value) || 0} duration={900} />{suffix || ''}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function CFDChart({ data, height = 200 }) {
  const [hover, setHover] = React.useState(null);
  const svgRef = React.useRef(null);
  if (!data || !data.length) return null;
  const width = 600;
  const pad = { l: 30, r: 14, t: 8, b: 24 };
  const max = Math.max(...data.map(d => d.todo + d.prog + d.done));
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const x = (i) => pad.l + (i / (data.length - 1)) * innerW;
  const y = (v) => pad.t + innerH - (v / (max || 1)) * innerH;

  // Build stacked paths
  const buildPath = (key, prevKeys) => {
    const top = data.map((d, i) => {
      let stack = 0;
      prevKeys.forEach(k => stack += d[k]);
      return [x(i), y(stack + d[key])];
    });
    const bot = data.map((d, i) => {
      let stack = 0;
      prevKeys.forEach(k => stack += d[k]);
      return [x(i), y(stack)];
    }).reverse();
    return [...top, ...bot].map(([X, Y]) => `${X.toFixed(1)},${Y.toFixed(1)}`).join(' ');
  };

  const onMove = (e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * width;
    let best = 0; let bestD = Infinity;
    data.forEach((_, i) => {
      const xi = x(i);
      const dd = Math.abs(xi - px);
      if (dd < bestD) { bestD = dd; best = i; }
    });
    setHover(best);
  };

  return (
    <div style={{ position: 'relative' }}>
      {/* Eksen etiketleri YALNIZCA çizim alanına göre konumlanır; sarmalayıcı
          açıklama satırını da kapsasaydı etiketler onun üzerine düşerdi. */}
      <div style={{ position: 'relative' }}>
      <svg
        ref={svgRef}
        width="100%" height={height} viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ display: 'block', cursor: 'crosshair' }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* gridlines */}
        {[0, 0.5, 1].map((g, i) => (
          <line key={i} x1={pad.l} x2={width - pad.r} y1={pad.t + g * innerH} y2={pad.t + g * innerH} stroke="var(--border)" strokeDasharray="3 3" />
        ))}
        <polygon points={buildPath('done', [])} fill="var(--status-done)" opacity="0.7" />
        <polygon points={buildPath('prog', ['done'])} fill="var(--status-progress)" opacity="0.7" />
        <polygon points={buildPath('todo', ['done', 'prog'])} fill="var(--status-todo)" opacity="0.55" />
        {hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + innerH} stroke="var(--accent)" strokeWidth="1" strokeDasharray="2 2" opacity="0.6" />
        )}
      </svg>
      {/* Eksen etiketleri SVG DIŞINDA çizilir: `preserveAspectRatio="none"`
          yatayda esnediği için SVG içine yazılan metin kart genişledikçe
          orantısız biçimde yayılıyordu. */}
      <div className="chart-axis-labels" aria-hidden="true">
        {data.map((d, i) => (d.label
          ? <span key={i} style={{ left: `${(x(i) / width) * 100}%` }}>{d.label}</span>
          : null))}
      </div>
      </div>
      {/* Açıklama */}
      <div className="row" style={{ gap: 14, padding: '8px 12px 0', fontSize: 11.5, color: 'var(--text-dim)' }}>
        <span className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--status-done)', opacity: 0.7 }} /> Tamamlanan</span>
        <span className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--status-progress)', opacity: 0.7 }} /> Devam</span>
        <span className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--status-todo)', opacity: 0.55 }} /> Yapılacak</span>
      </div>
      {hover != null && (
        <div className="rich-tip" style={{
          position: 'absolute',
          left: `${(x(hover) / width) * 100}%`,
          top: 0,
          transform: 'translate(-50%, -100%)',
          pointerEvents: 'none',
          maxWidth: 220,
          minWidth: 150
        }}>
          <div className="rich-tip-head">
            <span className="rich-tip-icon"><Icons.Calendar size={12} /></span>
            <span className="rich-tip-title">{fmt(data[hover].d, 'dd MMM')}</span>
          </div>
          <div className="rich-tip-body">
            <div className="rt-row"><span className="rt-label">Tamamlanan</span><span className="rt-val" style={{ color: 'var(--status-done)' }}>{data[hover].done}</span></div>
            <div className="rt-row"><span className="rt-label">Devam</span><span className="rt-val" style={{ color: 'var(--status-progress)' }}>{data[hover].prog}</span></div>
            <div className="rt-row"><span className="rt-label">Yapılacak</span><span className="rt-val">{data[hover].todo}</span></div>
            <div className="rt-row"><span className="rt-label">Toplam</span><span className="rt-val">{data[hover].todo + data[hover].prog + data[hover].done}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}

function VelocityChart({ data, height = 180 }) {
  const max = Math.max(...data.map(d => d.value), 1);
  const avg = Math.round(data.reduce((a, b) => a + b.value, 0) / data.length);
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="velocity-bars" style={{ height }}>
        {data.map((d, i) => {
          const h = (d.value / max) * 100;
          const isCurrent = i === data.length - 1;
          return (
            <Tooltip
              key={i}
              title={d.label}
              icon={<Icons.TrendUp size={12} />}
              accent={isCurrent ? 'var(--status-done)' : 'var(--accent)'}
              content={<>
                <div className="rt-row"><span className="rt-label">Tamamlanan</span><span className="rt-val">{d.value} görev</span></div>
                <div className="rt-row"><span className="rt-label">Ort. fark</span><span className="rt-val" style={{ color: (d.value - avg) >= 0 ? 'var(--status-done)' : 'var(--status-overdue)' }}>{(d.value - avg) >= 0 ? '+' : ''}{d.value - avg}</span></div>
                <div className="rt-bar"><div style={{ width: `${h}%`, background: 'var(--accent)' }} /></div>
              </>}
            >
              <div className="vel-col" style={{ cursor: 'help' }}>
                <span className="vel-num">{d.value}</span>
                <span className="vel-bar" style={{ height: `${Math.max(2, h)}%`, background: isCurrent ? 'var(--status-done)' : 'var(--accent)' }} />
                <span className="vel-label">{d.label}</span>
              </div>
            </Tooltip>
          );
        })}
      </div>
      <div className="row" style={{ justifyContent: 'space-between', fontSize: 11.5, color: 'var(--text-dim)' }}>
        <span>Hareketli ort: <strong style={{ color: 'var(--text)' }}>{avg}</strong> görev/hafta</span>
        <span>En yüksek: <strong style={{ color: 'var(--status-done)' }}>{max}</strong></span>
      </div>
    </div>
  );
}
