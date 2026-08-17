'use client';
import { useState as useState1, useMemo as useMemo1 } from 'react';
import { Icons } from '../../components/icons';
import { parseDate, fmt, addDays, diffDays, today } from '../../scheduling/dates';
import { depId } from '../../scheduling/dependencies';
import { projectColorVar, personColorVar } from '../../lib/colors';
import { AvatarStack, Kw, StatusPill, HeroHeader, Donut, AreaChart } from '../../components/ui';
import { Tooltip, CardHead, AnimatedNumber, HoverListCard } from '../../components/ui-extras';
import { PeopleMetricTable, personUnitLabel } from '../../components/PeopleMetricTable';
import { useAllPeople, useTasks, useTaskActions } from '../../state/hooks';
import { selectStatusDistribution } from './statusDistribution.js';

/* ── Özet (Dashboard) ──────────────────────────────────── */
export function DashboardView({ onNavigate }) {
  const tasks = useTasks();
  const people = useAllPeople();
  const { openTask: onOpenTask } = useTaskActions();
  const today_ = today();
  const [donutSel, setDonutSel] = useState1(null);

  // Üst rozetler: kartlar durum alanını doğrudan okur (bir görev hem "devam
  // eden" hem "geciken" sayılabilir), halka grafiği ise ayrıştırılmış kovaları
  // kullanır. İki okuma bilinçli olarak farklıdır ve karıştırılmamalıdır.
  const doneTasks = tasks.filter(t => t.status === 'done');
  const progressTasks = tasks.filter(t => t.status === 'in_progress');
  const overdueTasks = tasks.filter(t => t.status !== 'done' && t.targetFinish && diffDays(t.targetFinish, today_) < 0);
  const done = doneTasks.length;
  const progress = progressTasks.length;
  const overdue = overdueTasks.length;
  const compRate = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

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

  // Aynı adlı iki çalışan olduğunda kişi kaydı çözülmez; fotoğraf yerine baş
  // harf yedeği gösterilir (yanlış kişiyi göstermektense belirsiz bırakılır).
  const personByName = useMemo1(() => {
    const index = new Map();
    for (const person of people) {
      if (!person?.name) continue;
      index.set(person.name, index.has(person.name) ? null : person);
    }
    return index;
  }, [people]);

  const workload = useMemo1(() => {
    const map = {};
    tasks.forEach(t => {
      t.sorumlu.forEach(s => {
        map[s] = map[s] || { total: 0, done: 0, late: 0, active: 0 };
        map[s].total++;
        if (t.status === 'done') map[s].done++;
        else map[s].active++;
        if (t.status !== 'done' && t.targetFinish && diffDays(t.targetFinish, today_) < 0) map[s].late++;
      });
    });
    const rows = Object.entries(map)
      .map(([name, v]) => ({ name, ...v, color: personColorVar(name) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
    const max = rows.reduce((peak, row) => Math.max(peak, row.total), 1);
    return rows.map((row) => ({ ...row, share: row.total / max, person: personByName.get(row.name) || null }));
  }, [tasks, personByName]);

  const burndown = useMemo1(() => {
    const out = [];
    const labels = [];
    for (let i = 13; i >= 0; i--) {
      const d = addDays(today_, -i);
      const c = tasks.filter(t => t.status === 'done' && parseDate(t.plannedFinish) <= d).length;
      out.push(c);
      labels.push(i % 3 === 0 ? fmt(d, 'd') : '');
    }
    return { values: out, labels };
  }, [tasks]);

  const upcoming = useMemo1(() => tasks
    .filter(t => t.status !== 'done' && t.targetFinish && diffDays(t.targetFinish, today_) >= 0)
    .sort((a, b) => parseDate(a.targetFinish) - parseDate(b.targetFinish))
    .slice(0, 5),
    [tasks]);

  const risks = useMemo1(() => {
    return tasks.filter(t => {
      if (t.status === 'done' || !t.deps) return false;
      return t.deps.some(d => {
        const dep = tasks.find(x => x.id === depId(d));
        return dep && dep.status !== 'done';
      });
    }).slice(0, 4);
  }, [tasks]);

  // Industry KPI: effort & weekly delta
  const portfolioHealth = useMemo1(() => {
    let totalPlanned = 0, totalActual = 0;
    tasks.forEach(t => {
      totalPlanned += t.plannedHours || 0;
      totalActual += t.actualHours || 0;
    });
    // Project RAG (red/amber/green) health: based on % overdue
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
    return {
      totalPlanned, totalActual,
      hoursUsage: totalPlanned ? totalActual / totalPlanned : 0,
      portfolio
    };
  }, [tasks]);

  const weeklyDelta = useMemo1(() => {
    const thisWeekDone = tasks.filter(t => {
      if (t.status !== 'done') return false;
      const e = parseDate(t.plannedFinish);
      return diffDays(e, today_) >= -7 && diffDays(e, today_) <= 0;
    }).length;
    const lastWeekDone = tasks.filter(t => {
      if (t.status !== 'done') return false;
      const e = parseDate(t.plannedFinish);
      return diffDays(e, today_) >= -14 && diffDays(e, today_) < -7;
    }).length;
    return { thisWeekDone, lastWeekDone, delta: thisWeekDone - lastWeekDone };
  }, [tasks]);

  // Halka grafiği birbirini dışlayan kovalarla beslenir: dilimlerin toplamı
  // her zaman görev sayısına eşittir (bkz. statusDistribution.js).
  const distribution = useMemo1(() => selectStatusDistribution(tasks, today_), [tasks]);
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
          tip="Durumu 'Tamamlandı' olarak işaretlenmiş görev sayısı. Bu sayı tamamlama oranını ve hız metriklerini besler." />
        <Stat icon={<Icons.Clock size={16} />} label="Devam eden" value={progress} accent="var(--status-progress)" trend="aktif" items={progressTasks} onOpenTask={onOpenTask}
          tip="Şu anda üzerinde çalışılan görev sayısı. Eşzamanlı iş (devam eden) limitiniz için referans olabilir." />
        <Stat icon={<Icons.Alert size={16} />} label="Geciken" value={overdue} accent="var(--status-overdue)" trend={overdue > 0 ? 'müdahale gerekli' : 'tertip'} trendDown={overdue > 0} items={overdueTasks} onOpenTask={onOpenTask}
          tip={<>
            <p>Hedef tarihi geçmiş ve hâlâ tamamlanmamış görevler.</p>
            <div className="rt-sep" />
            <div className="rt-row"><Icons.Alert size={12} className="rt-ico" /><span>Bu listeyi sıfırda tutmaya çalışın.</span></div>
          </>} />
      </div>

      <div className="dashboard-main-grid">
        {/* Burndown */}
        <div className="card dashboard-trend-card">
          <CardHead
            icon={<Icons.TrendUp size={14} />}
            title="Tamamlama trendi"
            subtitle="Son 14 gün · birikimli"
            infoAccent="var(--status-done)"
            infoIcon={<Icons.TrendUp size={12} />}
            info={<>
              <p>Son 14 gün içinde tamamlanan görev sayısının birikimli değişimi.</p>
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
          <AreaChart data={burndown.values} labels={burndown.labels} width={500} height={150} color="var(--status-done)" animated />
        </div>

        {/* Status donut */}
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

      {/* Bottom rows */}
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
              id: row.name,
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
                      <AvatarStack names={t.sorumlu} personIds={t.assigneeIds} max={2} size="sm" />
                    </div>
                  </button>
                );
              })}
          </div>
        </div>
      </div>

      {/* Portfolio health (RAG) — industry-standard summary */}
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

      {/* Weekly snapshot + effort mini */}
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

        <div className="card mini-kpi">
          <CardHead
            icon={<Icons.Hours size={14} />}
            title="İş gücü"
            infoAccent="var(--c-cyan)"
            infoIcon={<Icons.Hours size={12} />}
            info={<>
              <p>Planlanan saatlere göre fiili harcanan saatlerin oranı (ortalama efor verimliliği).</p>
              <div className="rt-sep" />
              <div className="rt-row"><span className="rt-label">Fiili</span><span className="rt-val">{portfolioHealth.totalActual} sa</span></div>
              <div className="rt-row"><span className="rt-label">Planlanan</span><span className="rt-val">{portfolioHealth.totalPlanned} sa</span></div>
            </>}
          />
          <div className="kpi-big" style={{ color: portfolioHealth.hoursUsage > 1 ? 'var(--status-overdue)' : 'var(--text)' }}>
            %<AnimatedNumber value={Math.round(portfolioHealth.hoursUsage * 100)} />
          </div>
          <div className="bar-track" style={{ height: 6, marginTop: 8 }}>
            <div className="bar-fill" style={{ width: `${Math.min(100, portfolioHealth.hoursUsage * 100)}%`, background: portfolioHealth.hoursUsage > 1 ? 'var(--status-overdue)' : 'var(--c-cyan)' }} />
          </div>
          <div className="kpi-delta">{portfolioHealth.totalActual} / {portfolioHealth.totalPlanned} sa</div>
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
            {risks.map(t => (
              <button key={t.id} onClick={() => onOpenTask(t)} className="col" style={{
                gap: 6, padding: 12, borderRadius: 'var(--r-md)', border: '1px solid var(--border)',
                background: 'var(--bg)', cursor: 'pointer', textAlign: 'left', alignItems: 'stretch'
              }}>
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>{t.task}</div>
                <div className="row" style={{ gap: 8 }}>
                  <Kw color={t.color}>{t.keyword}</Kw>
                  <span className="muted" style={{ fontSize: 11 }}>{t.deps.length} bekleyen bağımlılık</span>
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
