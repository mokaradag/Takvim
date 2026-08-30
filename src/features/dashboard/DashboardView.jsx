'use client';
import { useState as useState1, useMemo as useMemo1 } from 'react';
import { Icons } from '../../components/icons';
import { parseDate, fmt, fmtAxisDate, addDays, diffDays } from '../../scheduling/dates';
import { taskCompletionDate } from '../../scheduling/metrics';
import { depId } from '../../scheduling/dependencies';
import { projectColorVar, personColorVar } from '../../lib/colors';
import { AvatarStack, StatusPill, HeroHeader, Donut, AreaChart } from '../../components/ui';
import { TaskKeyword } from '../../components/TaskKeyword';
import { Tooltip, CardHead, AnimatedNumber, HoverListCard } from '../../components/ui-extras';
import { PeopleMetricTable, personUnitLabel } from '../../components/PeopleMetricTable';
import { useAllPeople, useTasks, useTaskActions } from '../../state/hooks';
import { STATUS_DISTRIBUTION_BUCKETS, selectStatusDistribution } from './statusDistribution.js';
import { selectOverdueAging, selectPlanHygiene } from './planHealth.js';
import { useTodayKey } from '../../hooks/useTodayKey.js';
import { selectDashboardWorkload } from './workloadProjection.js';

/* ── Özet (Dashboard) ──────────────────────────────────── */
export function DashboardView({ onNavigate }) {
  const tasks = useTasks();
  const people = useAllPeople();
  const { openTask: onOpenTask } = useTaskActions();
  // Referans gün KARARLI bir değerdir. `today()` her çizimde yeni bir `Date`
  // döndürür; doğrudan bağımlılık olarak kullanılsaydı tarihe duyarlı memolar
  // her çizimde yeniden hesaplanır, bağımlılıktan çıkarılsaydı pano gece
  // yarısını açık geçtiğinde dünün sınıflandırmasında kalırdı.
  // Gün sınırı İZLENİR: sayfa gece yarısını açık geçtiğinde yeniden çizilir
  // ve tarihe duyarlı bütün memolar tazelenir.
  const todayKey = useTodayKey();
  const today_ = useMemo1(() => parseDate(todayKey), [todayKey]);
  const [donutSel, setDonutSel] = useState1(null);

  // Üst rozetler ve halka grafiği TEK kaynaktan beslenir: birbirini dışlayan
  // durum kovaları (bkz. statusDistribution.js). Daha önce kartlar durum
  // alanını doğrudan okuyordu; hem "devam eden" hem "geciken" sayılan bir görev
  // yüzünden kart "6 devam eden" derken halka aynı anda "3" gösteriyordu.
  const distribution = useMemo1(() => selectStatusDistribution(tasks, today_), [tasks, today_]);
  const bucketItems = useMemo1(() => {
    const index = new Map(STATUS_DISTRIBUTION_BUCKETS.map((bucket) => [bucket.id, []]));
    for (const segment of distribution.segments) index.set(segment.id, segment.items || []);
    return index;
  }, [distribution]);
  const doneTasks = bucketItems.get('done') || [];
  const progressTasks = bucketItems.get('in_progress') || [];
  const overdueTasks = bucketItems.get('overdue') || [];
  // `todo` kovası da GÖSTERİLİR. Rozet satırı yalnızca Toplam/Tamamlanan/
  // Devam eden/Geciken taşıdığında, henüz başlamamış sıradan bir görev halkada
  // görünüyor ama hiçbir kartta sayılmıyordu; "dört kartın toplamı görev
  // sayısına eşittir" iddiası da yanlıştı (dördüncü kart Toplam'dı).
  const todoTasks = bucketItems.get('todo') || [];
  const done = doneTasks.length;
  const progress = progressTasks.length;
  const overdue = overdueTasks.length;
  const todo = todoTasks.length;
  const compRate = distribution.completionRate;

  const byProject = useMemo1(() => {
    const map = {};
    tasks.forEach(t => {
      map[t.proje] = map[t.proje] || { total: 0, done: 0 };
      map[t.proje].total++;
      if (t.status === 'done') map[t.proje].done++;
    });
    return Object.entries(map)
      .map(([name, v]) => ({ name, value: v.total, done: v.done, color: projectColorVar(name) }))
      .sort((a, b) => b.value - a.value);
  }, [tasks]);

  // Fotoğraf kimliği genel kişi dizininden ada göre yeniden çözülmez. Görev
  // kapsamında yetkili olarak gelen Sicil iş yükü satırına kadar korunur.
  const workload = useMemo1(
    () => selectDashboardWorkload(tasks, people, today_)
      .map((row) => ({ ...row, color: personColorVar(row.name) })),
    [tasks, people, today_]
  );

  // Birikimli tamamlanma: bir görevin tamamlandığı gün GERÇEKLEŞEN bitiştir.
  // Planlanan bitişe bakmak, planı ileri bir tarihte olan ama bugün bitirilen
  // görevi eğriye hiç sokmuyordu.
  const completionTrend = useMemo1(() => {
    const values = [];
    const labels = [];
    // Planlanan bitiş YEDEK DEĞİLDİR: gelecek aya planlanmış ama bugün bitirilen
    // görev eğriye gelecek ay girer, gecikmiş bir plan ise görevi geçmişte
    // bitmiş gösterirdi. Gerçekleşen bitişi olmayan tamamlanmış görev kronolojiye
    // girmez (bkz. scheduling/metrics · taskCompletionDate).
    const completions = tasks
      .map(taskCompletionDate)
      .filter(Boolean)
      .map((value) => parseDate(value));
    for (let offset = 13; offset >= 0; offset -= 1) {
      const day = addDays(today_, -offset);
      values.push(completions.filter((finish) => finish <= day).length);
      // Eksen etiketi tarih biçimi tercihinden bağımsızdır; memolanmış etiketler
      // böylece gizli modül durumuna göre eskimez.
      labels.push(offset % 3 === 0 ? fmtAxisDate(day) : '');
    }
    return { values, labels };
  }, [tasks, today_]);

  const upcoming = useMemo1(() => tasks
    .filter(t => t.status !== 'done' && t.targetFinish && diffDays(t.targetFinish, today_) >= 0)
    .sort((a, b) => parseDate(a.targetFinish) - parseDate(b.targetFinish))
    .slice(0, 5),
    [tasks, today_]);

  // Bağımlılık riski: bekleyen öncül SAYISI da burada hesaplanır. Kart daha
  // önce `deps.length` yazıyordu; bu, tamamlanmış öncülleri de sayan yanlış bir
  // rakamdı ("3 bekleyen bağımlılık" derken yalnızca biri bekliyor olabiliyordu).
  const risks = useMemo1(() => {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return tasks
      .map((task) => {
        if (task.status === 'done') return null;
        const blocking = (task.deps || []).filter((dependency) => {
          const predecessor = byId.get(depId(dependency));
          return predecessor && predecessor.status !== 'done';
        });
        return blocking.length ? { task, blockingCount: blocking.length } : null;
      })
      .filter(Boolean)
      .sort((left, right) => right.blockingCount - left.blockingCount)
      .slice(0, 4);
  }, [tasks]);

  // Proje RAG (red/amber/green) sağlık göstergeleri.
  const portfolioHealth = useMemo1(() => {
    const projHealth = {};
    tasks.forEach(t => {
      const overdue = t.status !== 'done' && t.targetFinish && diffDays(t.targetFinish, today_) < 0;
      projHealth[t.proje] = projHealth[t.proje] || { total: 0, done: 0, overdue: 0 };
      projHealth[t.proje].total++;
      if (t.status === 'done') projHealth[t.proje].done++;
      if (overdue) projHealth[t.proje].overdue++;
    });
    const portfolio = Object.entries(projHealth).map(([name, v]) => {
      const overdueRate = v.total ? v.overdue / v.total : 0;
      let rag = 'green';
      if (overdueRate > 0.3) rag = 'red';
      else if (overdueRate > 0.1) rag = 'amber';
      return { name, ...v, rag, color: projectColorVar(name) };
    });
    return { portfolio };
  }, [tasks, today_]);

  // "Bu hafta tamamlanan" GERÇEKLEŞEN bitiş tarihinden sayılır. Planlanan bitişe
  // bakmak, bugün biten ama planı daha eskiye düşen görevi saymıyor; buna
  // karşılık aylar önce bitmiş, planlanan bitişi bu haftaya düşen görevi
  // sayıyordu. Pencere son 7 günlük kayan aralıktır (bugün dahil).
  const weeklyDelta = useMemo1(() => {
    const completedWithin = (fromDays, toDays) => tasks.filter((t) => {
      if (t.status !== 'done' || !t.actualFinish) return false;
      const gap = diffDays(parseDate(t.actualFinish), today_);
      return gap >= fromDays && gap <= toDays;
    }).length;
    const thisWeekDone = completedWithin(-6, 0);
    const lastWeekDone = completedWithin(-13, -7);
    return { thisWeekDone, lastWeekDone, delta: thisWeekDone - lastWeekDone };
  }, [tasks, today_]);

  // Gecikme yaşlandırması ve plan bütünlüğü: tek bir "9 geciken" sayısı, dün
  // gecikmiş işle aylardır bekleyen işi aynı kefeye koyar.
  const aging = useMemo1(() => selectOverdueAging(tasks, today_), [tasks, today_]);
  // Sorumlu denetimi kişi dizinine göre ÇÖZÜLÜR: eşleşmeyen bir Sicil ya da
  // eski ad, alan dolu diye "sağlıklı" sayılmamalıdır (Ekip sayfası bu
  // referansları düşürür ve görev iş yükü tablosundan kaybolur).
  const hygiene = useMemo1(() => selectPlanHygiene(tasks, people), [tasks, people]);

  const statusDonut = distribution.segments;
  // Seçim dilim SIRASI değil, kova KİMLİĞİ ile tutulur: görevler değiştiğinde
  // dilim listesi kısalabilir ve saklanan sıra numarası boşa düşerek çizimi
  // çökertirdi.
  const selectedSegmentIndex = statusDonut.findIndex((segment) => segment.id === donutSel);
  const selectedSegment = selectedSegmentIndex < 0 ? null : statusDonut[selectedSegmentIndex];
  const toggleSegment = (id) => setDonutSel((current) => (!id || current === id ? null : id));
  const segmentShare = (value) => (distribution.total ? Math.round((value / distribution.total) * 100) : 0);

  return (
    <div className="col stagger dashboard">
      <HeroHeader title="Genel bakış">
        <div className="muted" style={{ fontSize: 13.5 }}>
          {fmt(today_, 'dd MMM yyyy')} · {tasks.length} görev · {progress} aktif · <span style={{ color: overdue > 0 ? 'var(--status-overdue)' : 'var(--text-dim)' }}>{overdue} geciken</span>
        </div>
      </HeroHeader>

      <div className="dashboard-kpi-grid">
        <Stat icon={<Icons.Briefcase size={16} />} label="Toplam görev" value={tasks.length} accent="var(--text)" trend={`${compRate}% tamamlandı`} items={tasks} onOpenTask={onOpenTask}
          tip="Sistemdeki tüm aktif ve kapanmış görevlerin sayısı. Projeler, sorumlular ve tarih aralıklarına göre filtrelenebilir." />
        {/* Haftalık değer uydurulmaz: son 7 günde tamamlananların gerçek sayısıdır. */}
        <Stat icon={<Icons.Check size={16} />} label="Tamamlanan" value={done} accent="var(--status-done)" trend={`+${weeklyDelta.thisWeekDone} bu hafta`} trendUp={weeklyDelta.thisWeekDone > 0} items={doneTasks} onOpenTask={onOpenTask}
          tip="Durumu 'Tamamlandı' olarak işaretlenmiş görev sayısı. Bu sayı tamamlanma oranını ve hız göstergelerini besler." />
        <Stat icon={<Icons.Clock size={16} />} label="Devam eden" value={progress} accent="var(--status-progress)" trend="aktif" items={progressTasks} onOpenTask={onOpenTask}
          tip="Üzerinde çalışılan ve hedef tarihi henüz geçmemiş görevler. Hedefi geçmiş olanlar “Geciken” kartında sayılır; Yapılacak, Devam eden, Geciken ve Tamamlanan kartlarının toplamı her zaman toplam görev sayısına eşittir." />
        <Stat icon={<Icons.Circle size={16} />} label="Yapılacak" value={todo} accent="var(--status-todo)" trend="başlanmadı" items={todoTasks} onOpenTask={onOpenTask}
          tip="Henüz başlanmamış ve hedef tarihi geçmemiş görevler. Halka grafiğindeki “Yapılacak” dilimiyle aynı kovadır." />
        <Stat icon={<Icons.Alert size={16} />} label="Geciken" value={overdue} accent="var(--status-overdue)" trend={overdue > 0 ? 'müdahale gerekli' : 'tertip'} trendDown={overdue > 0} items={overdueTasks} onOpenTask={onOpenTask}
          tip={<>
            <p>Hedef tarihi geçmiş ve hâlâ tamamlanmamış görevler.</p>
            <div className="rt-sep" />
            <div className="rt-row"><Icons.Alert size={12} className="rt-ico" /><span>Bu listeyi sıfırda tutmaya çalışın.</span></div>
          </>} />
      </div>

      <div className="dashboard-main-grid">
        {/* Tamamlanma eğilimi */}
        <div className="card dashboard-trend-card">
          <CardHead
            icon={<Icons.TrendUp size={14} />}
            title="Tamamlanma eğilimi"
            subtitle="Son 14 gün · birikimli"
            infoAccent="var(--status-done)"
            infoIcon={<Icons.TrendUp size={12} />}
            info={<>
              <p>Son 14 gün içinde tamamlanan görev sayısının birikimli değişimi. Bir görev, gerçekleşen bitiş tarihinde sayılır.</p>
              <div className="rt-sep" />
              <div className="rt-row"><span className="rt-label">Eğri dik</span><span className="rt-val" style={{ color: 'var(--status-done)' }}>İvmelenme</span></div>
              <div className="rt-row"><span className="rt-label">Eğri yatay</span><span className="rt-val" style={{ color: 'var(--status-overdue)' }}>Duraklama</span></div>
              <div className="rt-sep" />
              <div className="rt-row"><span className="rt-label">Toplam</span><span className="rt-val">{done} görev</span></div>
              <div className="rt-row"><span className="rt-label">Periyod</span><span className="rt-val">14 gün</span></div>
              <div className="rt-foot"><Icons.Sparkle size={11} /> İmleci eğri üzerinde gezdirerek günlük değeri görün.</div>
            </>}
            right={<div className="badge" style={{ color: 'var(--status-done)' }}>+{done} toplam</div>}
          />
          <AreaChart data={completionTrend.values} labels={completionTrend.labels} width={500} height={150} color="var(--status-done)" animated />
        </div>

        {/* Durum halkası */}
        <div className="card dashboard-status-card">
          <CardHead
            icon={<Icons.Layers size={14} />}
            title="Durum dağılımı"
            subtitle="Görevlerin tamamlanma durumu"
            infoAccent="var(--accent)"
            infoIcon={<Icons.Layers size={12} />}
            info={<>
              <p>Görevlerin durumlarına göre yüzdesel dağılımı. Halka grafiğinin merkezindeki yüzde, ‘Tamamlandı’ oranıdır.</p>
              <div className="rt-sep" />
              {statusDonut.map(s => (
                <div key={s.label} className="rt-row">
                  <span style={{ width: 9, height: 9, borderRadius: 99, background: s.color, display: 'inline-block' }} />
                  <span>{s.label}</span>
                  <span className="rt-val">{s.value}</span>
                </div>
              ))}
              <div className="rt-foot"><Icons.Sparkle size={11} /> Bir dilime tıklayarak seçilebilir.</div>
            </>}
          />
          <div className="dashboard-status-body">
            <div className="dashboard-status-chart">
              <Donut
                data={statusDonut}
                size={150}
                thickness={20}
                label="Görev durumu dağılımı"
                selected={selectedSegmentIndex < 0 ? null : selectedSegmentIndex}
                onSegmentClick={(i) => toggleSegment(statusDonut[i]?.id)}
              />
              <div className="dashboard-status-center">
                <div>
                  {!selectedSegment ? (
                    <>
                      <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em' }}>
                        <AnimatedNumber value={compRate} />%
                      </div>
                      <div className="muted" style={{ fontSize: 11 }}>tamamlandı</div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', color: selectedSegment.color }}>
                        <AnimatedNumber value={selectedSegment.value} />
                      </div>
                      <div className="muted" style={{ fontSize: 10.5, maxWidth: 80, lineHeight: 1.3 }}>{selectedSegment.label}</div>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="col dashboard-status-legend">
              {statusDonut.map((s) => (
                <HoverListCard
                  key={s.id}
                  title={s.label}
                  icon={<span style={{ width: 9, height: 9, borderRadius: 99, background: s.color, display: 'inline-block' }} />}
                  accent={s.color}
                  items={s.items || []}
                  listHint="Açmak için tıklayın"
                  emptyText="Bu durumda görev yok."
                  summary={<>
                    <div className="rt-row"><span className="rt-label">Görev</span><span className="rt-val">{s.value}</span></div>
                    <div className="rt-row"><span className="rt-label">Oran</span><span className="rt-val">{segmentShare(s.value)}%</span></div>
                    <div className="rt-bar"><div style={{ width: `${segmentShare(s.value)}%`, background: s.color }} /></div>
                    <div className="rt-sep" />
                    <p>{s.explain}</p>
                  </>}
                  renderItem={(t) => (
                    <button key={t.id} className="rt-list-item" onClick={() => onOpenTask(t)}>
                      <span className="rli-bar" style={{ background: projectColorVar(t.proje) }} />
                      <span className="rli-main">
                        <span className="rli-name">{t.task}</span>
                        <span className="rli-meta">{t.proje} · {fmt(t.targetFinish)}</span>
                      </span>
                      <StatusPill task={t} size={10} />
                    </button>
                  )}
                >
                  <button
                    type="button"
                    className="row donut-leg-row"
                    aria-pressed={donutSel === s.id}
                    style={{ background: donutSel === s.id ? 'color-mix(in oklab, ' + s.color + ' 12%, transparent)' : 'transparent', border: donutSel === s.id ? `1px solid ${s.color}40` : '1px solid transparent' }}
                    onClick={() => toggleSegment(s.id)}
                  >
                    <div className="row" style={{ gap: 8 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 99, background: s.color, display: 'inline-block' }} />
                      <span style={{ fontSize: 13 }}>{s.label}</span>
                    </div>
                    <span className="tabular" style={{ fontWeight: 600, fontSize: 13 }}>
                      <AnimatedNumber value={s.value} />
                    </span>
                  </button>
                </HoverListCard>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Alt satırlar */}
      <div className="dashboard-bottom-grid">
        <div className="card">
          <CardHead
            icon={<Icons.Briefcase size={14} />}
            title="Projeler"
            subtitle={`${byProject.length} aktif proje`}
            infoAccent="var(--c-purple)"
            infoIcon={<Icons.Briefcase size={12} />}
            info={<>
              <p>Aktif projelerin her birinin görev sayısı ve tamamlama yüzdesi.</p>
              <div className="rt-sep" />
              <div className="rt-row"><span className="rt-label">Renk</span><span className="rt-val">Proje rengi</span></div>
              <div className="rt-row"><span className="rt-label">Sayılar</span><span className="rt-val">Tamamlanan / Toplam</span></div>
              <div className="rt-foot"><Icons.Sparkle size={11} /> Bir projenin üzerine gelin: detaylı kırılım açılır.</div>
            </>}
            right={<button className="btn ghost sm" onClick={() => onNavigate('veri')}>Tümü <Icons.ArrowRight size={12} /></button>}
          />
          <div className="col" style={{ gap: 12 }}>
            {byProject.map(p => {
              const pct = Math.round((p.done / p.value) * 100);
              return (
                <Tooltip
                  key={p.name}
                  title={p.name}
                  icon={<span style={{ width: 10, height: 10, borderRadius: 2, background: p.color, display: 'inline-block' }} />}
                  content={<>
                    <div className="rt-row"><span className="rt-label">Toplam görev</span><span className="rt-val">{p.value}</span></div>
                    <div className="rt-row"><span className="rt-label">Tamamlanan</span><span className="rt-val" style={{ color: 'var(--status-done)' }}>{p.done}</span></div>
                    <div className="rt-sep" />
                    <div className="rt-row"><span className="rt-label">İlerleme</span><span className="rt-val">{pct}%</span></div>
                  </>}
                >
                  <div className="col" style={{ gap: 6, cursor: 'help', width: '100%' }}>
                    <div className="row">
                      <div className="row" style={{ gap: 8, flex: 1, minWidth: 0 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
                        <span style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                      </div>
                      <span className="muted tabular" style={{ fontSize: 12 }}>{p.done}/{p.value}</span>
                    </div>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${pct}%`, background: p.color }} />
                    </div>
                  </div>
                </Tooltip>
              );
            })}
          </div>
        </div>

        <div className="card">
          <CardHead
            icon={<Icons.Users size={14} />}
            title="Ekip iş yükü"
            subtitle="En yüklü 5 üye · görev kırılımı"
            infoAccent="var(--c-cyan)"
            infoIcon={<Icons.Users size={12} />}
            info={<>
              <p>Görev sayısına göre en yüklü 5 ekip üyesi. Aşırı yüklenmiş bir kişiyi tespit etmek için bakın.</p>
              <div className="rt-sep" />
              <div className="rt-row"><span className="rt-label">Toplam</span><span className="rt-val">Kişiye atanmış tüm görevler</span></div>
              <div className="rt-row"><span className="rt-label">Açık</span><span className="rt-val">Tamamlanmamış görevler</span></div>
              <div className="rt-row"><span className="rt-label">Geciken</span><span className="rt-val" style={{ color: 'var(--status-overdue)' }}>Hedef tarihi geçmiş görevler</span></div>
              <div className="rt-sep" />
              <div className="rt-row"><Icons.Alert size={12} className="rt-ico" /><span>5+ açık görev: yük dengelemeyi düşünün</span></div>
            </>}
          />
          <PeopleMetricTable
            barLabel="Yük"
            columns={[
              { key: 'total', label: 'Toplam', title: 'Kişiye atanmış tüm görevler' },
              { key: 'active', label: 'Açık', title: 'Tamamlanmamış görevler' },
              { key: 'done', label: 'Biten', title: 'Tamamlanan görevler' },
              { key: 'late', label: 'Geciken', title: 'Hedef tarihi geçmiş görevler' }
            ]}
            emptyText="Görev atanmış ekip üyesi yok."
            rows={workload.map((row) => ({
              id: row.id,
              name: row.name,
              person: row.person,
              subtitle: personUnitLabel(row.person),
              share: row.share,
              barColor: row.late > 0 ? 'var(--status-overdue)' : row.color,
              values: {
                total: row.total,
                active: { value: row.active, tone: 'muted' },
                done: { value: row.done, tone: row.done > 0 ? 'done' : 'muted' },
                late: { value: row.late, tone: row.late > 0 ? 'overdue' : 'muted' }
              },
              tooltip: <>
                <div className="rt-row"><span className="rt-label">Toplam görev</span><span className="rt-val">{row.total}</span></div>
                <div className="rt-row"><span className="rt-label">Açık</span><span className="rt-val">{row.active}</span></div>
                <div className="rt-row"><span className="rt-label">Tamamlanan</span><span className="rt-val" style={{ color: 'var(--status-done)' }}>{row.done}</span></div>
                {row.late > 0 && <div className="rt-row"><span className="rt-label">Geciken</span><span className="rt-val" style={{ color: 'var(--status-overdue)' }}>{row.late}</span></div>}
              </>
            }))}
          />
        </div>

        <div className="card">
          <CardHead
            icon={<Icons.Clock size={14} />}
            title="Yaklaşan teslimler"
            subtitle="Hedef tarihi en yakın 5 görev"
            infoAccent="var(--status-overdue)"
            infoIcon={<Icons.Clock size={12} />}
            info={<>
              <p>Hedef tarihi en yakın olan, henüz tamamlanmamış 5 görev. Acil işlere bakmak için kullanın.</p>
              <div className="rt-sep" />
              <div className="rt-row"><span className="rt-label">Kırmızı sayı</span><span className="rt-val" style={{ color: 'var(--status-overdue)' }}>≤ 3 gün</span></div>
              <div className="rt-row"><span className="rt-label">Tıklama</span><span className="rt-val">Detay panelini açar</span></div>
            </>}
          />
          <div className="col" style={{ gap: 6 }}>
            {upcoming.length === 0 ? <div className="empty">Yaklaşan teslim yok.</div> :
              upcoming.map(t => {
                const days = diffDays(t.targetFinish, today_);
                const urgent = days <= 3;
                return (
                  <button key={t.id} onClick={() => onOpenTask(t)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                      borderRadius: 'var(--r-md)', background: 'transparent', border: '1px solid transparent',
                      width: '100%', textAlign: 'left', cursor: 'pointer'
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; }}
                  >
                    <span style={{ width: 3, height: 28, borderRadius: 2, background: projectColorVar(t.proje), flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.task}</div>
                      <div className="muted" style={{ fontSize: 11 }}>{t.proje}</div>
                    </div>
                    <div className="col" style={{ alignItems: 'flex-end', gap: 2 }}>
                      <span className="tabular" style={{ fontSize: 11.5, fontWeight: 600, color: urgent ? 'var(--status-overdue)' : 'var(--text-muted)' }}>
                        {days === 0 ? 'Bugün' : days === 1 ? 'Yarın' : `${days} gün`}
                      </span>
                      <AvatarStack names={t.sorumlu} personIds={t.assigneeIds} people={t.assigneeAvatarIdentities} max={2} size="sm" />
                    </div>
                  </button>
                );
              })}
          </div>
        </div>
      </div>

      {/* Portföy sağlığı (RAG) — PMO standardı özet */}
      <div className="card">
        <CardHead
          icon={<Icons.Briefcase size={14} />}
          title="Portföy sağlığı"
          subtitle={`${portfolioHealth.portfolio.length} proje · RAG değerlendirmesi`}
          infoAccent="var(--c-emerald)"
          infoIcon={<Icons.Briefcase size={12} />}
          info={<>
            <p><strong>RAG</strong> (Red-Amber-Green) projelerin sağlık durumunu öz olarak gösteren PMO standardıdır.</p>
            <div className="rt-sep" />
            <div className="rt-row"><span style={{ width: 8, height: 8, borderRadius: 99, background: 'var(--status-done)' }} /><span><strong>Yeşil:</strong> &lt;%10 görev gecikmesi</span></div>
            <div className="rt-row"><span style={{ width: 8, height: 8, borderRadius: 99, background: 'var(--c-amber)' }} /><span><strong>Sarı:</strong> %10–30 görev gecikmesi</span></div>
            <div className="rt-row"><span style={{ width: 8, height: 8, borderRadius: 99, background: 'var(--status-overdue)' }} /><span><strong>Kırmızı:</strong> &gt;%30 görev gecikmesi</span></div>
            <div className="rt-foot"><Icons.Sparkle size={11} /> Detaylar için Raporlar bölümüne bakın.</div>
          </>}
          right={
            <div className="row" style={{ gap: 8 }}>
              <span className="rag-tag green">{portfolioHealth.portfolio.filter(p => p.rag === 'green').length}</span>
              <span className="rag-tag amber">{portfolioHealth.portfolio.filter(p => p.rag === 'amber').length}</span>
              <span className="rag-tag red">{portfolioHealth.portfolio.filter(p => p.rag === 'red').length}</span>
            </div>
          }
        />
        <div className="rag-grid">
          {portfolioHealth.portfolio.map(p => {
            const ragColor = p.rag === 'green' ? 'var(--status-done)' : p.rag === 'amber' ? 'var(--c-amber)' : 'var(--status-overdue)';
            const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
            return (
              <Tooltip
                key={p.name}
                title={p.name}
                accent={p.color}
                icon={<span style={{ width: 10, height: 10, borderRadius: 2, background: p.color, display: 'inline-block' }} />}
                content={<>
                  <div className="rt-row"><span className="rt-label">RAG</span><span className="rt-val" style={{ color: ragColor }}>{p.rag === 'green' ? 'Yeşil' : p.rag === 'amber' ? 'Sarı' : 'Kırmızı'}</span></div>
                  <div className="rt-row"><span className="rt-label">İlerleme</span><span className="rt-val">{p.done} / {p.total} · {pct}%</span></div>
                  {p.overdue > 0 && <div className="rt-row"><span className="rt-label">Geciken</span><span className="rt-val" style={{ color: 'var(--status-overdue)' }}>{p.overdue}</span></div>}
                </>}
              >
                <div className={`rag-card rag-${p.rag}`}>
                  <span className="rag-dot" style={{ background: ragColor }} />
                  <div className="col" style={{ flex: 1, gap: 4, minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color, flexShrink: 0 }} />
                      <span className="rag-name">{p.name}</span>
                    </div>
                    <div className="row" style={{ gap: 8, fontSize: 11, color: 'var(--text-dim)' }}>
                      <span>{p.done}/{p.total} görev</span>
                      {p.overdue > 0 && <span style={{ color: 'var(--status-overdue)' }}>· {p.overdue} geciken</span>}
                    </div>
                    <div className="bar-track" style={{ height: 3 }}>
                      <div className="bar-fill" style={{ width: `${pct}%`, background: p.color }} />
                    </div>
                  </div>
                </div>
              </Tooltip>
            );
          })}
        </div>
      </div>

      {/* Haftalık tamamlanma kesiti */}
      <div className="dashboard-insights-grid">
        <div className="card mini-kpi">
          <CardHead
            icon={<Icons.Check size={14} />}
            title="Bu hafta tamamlanan"
            infoAccent="var(--status-done)"
            infoIcon={<Icons.Check size={12} />}
            info={<>
              <p>Son 7 günde tamamlanan görev sayısı ve önceki hafta ile karşılaştırma.</p>
              <div className="rt-sep" />
              <div className="rt-row"><span className="rt-label">Bu hafta</span><span className="rt-val">{weeklyDelta.thisWeekDone}</span></div>
              <div className="rt-row"><span className="rt-label">Geçen hafta</span><span className="rt-val">{weeklyDelta.lastWeekDone}</span></div>
            </>}
          />
          <div className="kpi-big" style={{ color: 'var(--status-done)' }}>
            <AnimatedNumber value={weeklyDelta.thisWeekDone} />
          </div>
          <div className="kpi-delta">
            {weeklyDelta.delta > 0 && <><Icons.TrendUp size={11} style={{ color: 'var(--status-done)' }} /> <span style={{ color: 'var(--status-done)' }}>+{weeklyDelta.delta}</span></>}
            {weeklyDelta.delta < 0 && <><Icons.TrendUp size={11} style={{ color: 'var(--status-overdue)', transform: 'rotate(180deg)' }} /> <span style={{ color: 'var(--status-overdue)' }}>{weeklyDelta.delta}</span></>}
            {weeklyDelta.delta === 0 && <span>geçen hafta ile aynı</span>}
            {weeklyDelta.delta !== 0 && <span style={{ color: 'var(--text-dim)' }}>· geçen haftaya kıyasla</span>}
          </div>
        </div>

      </div>

      <div className="dashboard-health-grid">
        {/* Gecikme yaşlandırması — PMO raporlamasının standart görünümü. */}
        <div className="card">
          <CardHead
            icon={<Icons.Alert size={14} />}
            title="Gecikme yaşlandırması"
            subtitle={aging.total ? `${aging.total} geciken görev · en eskisi ${aging.worstDays} gün` : 'Geciken görev yok'}
            infoAccent="var(--status-overdue)"
            infoIcon={<Icons.Alert size={12} />}
            info={<>
              <p>Geciken görevler, hedef tarihinin ÜZERİNDEN geçen gün sayısına göre gruplanır.</p>
              <div className="rt-sep" />
              <p>Tek bir gecikme sayısı, dün gecikmiş bir işle aylardır bekleyen bir işi aynı kefeye koyar. Yaşlandırma, önce hangi işe dönüleceğini gösterir.</p>
              <div className="rt-foot"><Icons.Sparkle size={11} /> Bir kovaya gelin: içindeki görevler listelenir.</div>
            </>}
          />
          {aging.total === 0 ? (
            <div className="empty">Hedef tarihi geçmiş görev yok.</div>
          ) : (
            <div className="col" style={{ gap: 8 }}>
              {aging.buckets.map((bucket) => (
                <HoverListCard
                  key={bucket.id}
                  title={`${bucket.label} geciken`}
                  accent={bucket.color}
                  icon={<span style={{ width: 9, height: 9, borderRadius: 2, background: bucket.color, display: 'inline-block' }} />}
                  items={bucket.items}
                  listHint="Açmak için tıklayın"
                  emptyText="Bu aralıkta geciken görev yok."
                  summary={<>
                    <div className="rt-row"><span className="rt-label">Görev</span><span className="rt-val">{bucket.value}</span></div>
                    <div className="rt-row"><span className="rt-label">Pay</span><span className="rt-val">{aging.total ? Math.round((bucket.value / aging.total) * 100) : 0}%</span></div>
                  </>}
                  renderItem={(t) => (
                    <button key={t.id} className="rt-list-item" onClick={() => onOpenTask(t)}>
                      <span className="rli-bar" style={{ background: projectColorVar(t.proje) }} />
                      <span className="rli-main">
                        <span className="rli-name">{t.task}</span>
                        <span className="rli-meta">{t.proje} · {t.lateBy} gün gecikti</span>
                      </span>
                      <StatusPill task={t} size={10} />
                    </button>
                  )}
                >
                  <div className="aging-row">
                    <span className="aging-label">{bucket.label}</span>
                    <div className="bar-track" style={{ flex: 1 }}>
                      <div
                        className="bar-fill"
                        style={{ width: `${aging.total ? (bucket.value / aging.total) * 100 : 0}%`, background: bucket.color }}
                      />
                    </div>
                    <span className="tabular aging-value" style={{ color: bucket.value ? bucket.color : 'var(--text-dim)' }}>{bucket.value}</span>
                  </div>
                </HoverListCard>
              ))}
            </div>
          )}
        </div>

        {/* Plan bütünlüğü — eksik alan taşıyan görev hiçbir ölçüme girmez. */}
        <div className="card">
          <CardHead
            icon={<Icons.Check size={14} />}
            title="Plan bütünlüğü"
            subtitle={`${hygiene.cleanCount} / ${hygiene.openCount} açık görev eksiksiz`}
            infoAccent="var(--c-emerald)"
            infoIcon={<Icons.Check size={12} />}
            info={<>
              <p>Açık görevlerde eksik kalan planlama alanları. Yalnızca tamamlanmamış görevler denetlenir.</p>
              <div className="rt-sep" />
              <p>Sorumlusu, termini veya planlanan tarihi olmayan bir görev iş yükü, gecikme ve kritik yol hesaplarının hiçbirine girmez; sessizce kaybolur.</p>
            </>}
            right={
              <span
                className="badge"
                style={{ color: hygiene.cleanCount === hygiene.openCount ? 'var(--status-done)' : 'var(--c-amber)' }}
              >
                {hygiene.openCount ? Math.round((hygiene.cleanCount / hygiene.openCount) * 100) : 100}% eksiksiz
              </span>
            }
          />
          {hygiene.openCount === 0 ? (
            <div className="empty">Açık görev yok.</div>
          ) : (
            <div className="col" style={{ gap: 6 }}>
              {hygiene.checks.map((check) => (
                <HoverListCard
                  key={check.id}
                  title={check.label}
                  accent={check.value ? 'var(--c-amber)' : 'var(--status-done)'}
                  icon={check.value ? <Icons.Alert size={12} /> : <Icons.Check size={12} />}
                  items={check.items}
                  listHint="Açmak için tıklayın"
                  emptyText="Bu denetimde eksik görev yok."
                  summary={<>
                    <div className="rt-row"><span className="rt-label">Eksik</span><span className="rt-val">{check.value}</span></div>
                    <div className="rt-sep" />
                    <p>{check.explain}</p>
                  </>}
                  renderItem={(t) => (
                    <button key={t.id} className="rt-list-item" onClick={() => onOpenTask(t)}>
                      <span className="rli-bar" style={{ background: projectColorVar(t.proje) }} />
                      <span className="rli-main">
                        <span className="rli-name">{t.task}</span>
                        <span className="rli-meta">{t.proje}</span>
                      </span>
                      <StatusPill task={t} size={10} />
                    </button>
                  )}
                >
                  <div className={`hygiene-row${check.value ? ' has-gap' : ''}`}>
                    <span className="hygiene-icon">
                      {check.value ? <Icons.Alert size={12} /> : <Icons.Check size={12} />}
                    </span>
                    <span className="hygiene-label">{check.label}</span>
                    <span className="tabular hygiene-value">{check.value}</span>
                  </div>
                </HoverListCard>
              ))}
            </div>
          )}
        </div>
      </div>

      {risks.length > 0 && (
        <div className="card" style={{ borderColor: 'color-mix(in oklab, var(--status-overdue) 35%, var(--border))' }}>
          <CardHead
            icon={<Icons.Alert size={14} />}
            title="Bağımlılık riski olan görevler"
            subtitle="Tamamlanması başka görevlere bağlı"
            infoAccent="var(--status-overdue)"
            infoIcon={<Icons.Alert size={12} />}
            info={<>
              <p>Tamamlanması, henüz bitmemiş başka görevlere bağlı olduğu için bekleyen görevler.</p>
              <div className="rt-sep" />
              <p>Önceki görev gecikirse zincir gecikmesi oluşur. Bunları öncelikli takip edin.</p>
              <div className="rt-foot"><Icons.Link size={11} /> Tıklayarak görev detayını açın.</div>
            </>}
            right={<span className="badge" style={{ color: 'var(--status-overdue)', borderColor: 'color-mix(in oklab, var(--status-overdue) 35%, var(--border))' }}>{risks.length} görev</span>}
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
            {risks.map(({ task, blockingCount }) => (
              <button key={task.id} onClick={() => onOpenTask(task)} className="col" style={{
                gap: 6, padding: 12, borderRadius: 'var(--r-md)', border: '1px solid var(--border)',
                background: 'var(--bg)', cursor: 'pointer', textAlign: 'left', alignItems: 'stretch'
              }}>
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>{task.task}</div>
                <div className="row" style={{ gap: 8 }}>
                  <TaskKeyword task={task} />
                  <span className="muted" style={{ fontSize: 11 }}>{blockingCount} bekleyen bağımlılık</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ icon, label, value, accent, trend, trendUp, trendDown, tip, items, onOpenTask }) {
  const body = (
    <div className="stat">
      {tip && (
        <div className="card-info-corner" style={{ pointerEvents: 'none' }}>
          <span className="info-btn corner" aria-hidden="true"><Icons.Info size={12} /></span>
        </div>
      )}
      <div className="label">{icon}{label}</div>
      <div className="value" style={{ color: accent }}><AnimatedNumber value={value} duration={900} /></div>
      <div className={`delta ${trendUp ? 'up' : ''} ${trendDown ? 'down' : ''}`}>{trend}</div>
    </div>
  );
  if (!items) return body;
  return (
    <HoverListCard
      title={label}
      icon={icon}
      accent={accent === 'var(--text)' ? 'var(--accent)' : accent}
      items={items}
      listHint="Açmak için tıklayın"
      emptyText="Bu kategoride görev yok."
      summary={typeof tip === 'string' ? <p>{tip}</p> : tip}
      renderItem={(t) => (
        <button key={t.id} className="rt-list-item" onClick={() => onOpenTask && onOpenTask(t)}>
          <span className="rli-bar" style={{ background: projectColorVar(t.proje) }} />
          <span className="rli-main">
            <span className="rli-name">{t.task}</span>
            <span className="rli-meta">{t.proje} · {fmt(t.targetFinish)}</span>
          </span>
          <StatusPill task={t} size={10} />
        </button>
      )}
    >
      {body}
    </HoverListCard>
  );
}