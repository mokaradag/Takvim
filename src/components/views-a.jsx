'use client';
/* ============================================================
   Views part 1: Özet (Dashboard), Veri (Data table), Kişi (People)
   ============================================================ */
import React, { useState as useState1, useMemo as useMemo1 } from 'react';
import { Icons } from './icons';
import {
  PROJECTS, PEOPLE, PRIORITIES,
  today, diffDays, addDays, fmt, parseDate, depId,
  projectColorVar, personColorVar,
} from '../lib/data';
import { Avatar, AvatarStack, Kw, StatusPill, StatusIcon, HeroHeader, Donut, BarRows, AreaChart } from './ui';
import { Tooltip, InfoButton, CardHead, AnimatedNumber, FilterableTH, HoverListCard, dateMatchesFilter, numericMatchesFilter } from './ui-extras';

/* ── Özet (Dashboard) ──────────────────────────────────── */
export function OzetView({ tasks, onOpenTask, onNavigate }) {
  const today_ = today();
  const [donutSel, setDonutSel] = useState1(null);

  // Stats
  const done = tasks.filter(t => t.status === 'done').length;
  const progress = tasks.filter(t => t.status === 'in_progress').length;
  const todo = tasks.filter(t => !t.status || t.status === 'todo').length;
  const overdue = tasks.filter(t => t.status !== 'done' && diffDays(t.hedefTarih, today_) < 0).length;
  const compRate = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

  // Task lists behind each summary metric (for hover cards)
  const doneTasks = tasks.filter(t => t.status === 'done');
  const progressTasks = tasks.filter(t => t.status === 'in_progress');
  const todoTasks = tasks.filter(t => !t.status || t.status === 'todo');
  const overdueTasks = tasks.filter(t => t.status !== 'done' && diffDays(t.hedefTarih, today_) < 0);

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

  const workload = useMemo1(() => {
    const map = {};
    tasks.forEach(t => {
      t.sorumlu.forEach(s => {
        map[s] = map[s] || { total: 0, done: 0, late: 0 };
        map[s].total++;
        if (t.status === 'done') map[s].done++;
        if (t.status !== 'done' && diffDays(t.hedefTarih, today_) < 0) map[s].late++;
      });
    });
    return Object.entries(map)
      .map(([name, v]) => ({ label: name, value: v.total, color: personColorVar(name), done: v.done, late: v.late }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  }, [tasks]);

  const burndown = useMemo1(() => {
    const out = [];
    const labels = [];
    for (let i = 13; i >= 0; i--) {
      const d = addDays(today_, -i);
      const c = tasks.filter(t => t.status === 'done' && parseDate(t.bitisTarihi) <= d).length;
      out.push(c);
      labels.push(i % 3 === 0 ? fmt(d, 'd') : '');
    }
    return { values: out, labels };
  }, [tasks]);

  const upcoming = useMemo1(() => tasks
    .filter(t => t.status !== 'done' && diffDays(t.hedefTarih, today_) >= 0)
    .sort((a, b) => parseDate(a.hedefTarih) - parseDate(b.hedefTarih))
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
      const overdue = t.status !== 'done' && diffDays(t.hedefTarih, today_) < 0;
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
      const e = parseDate(t.bitisTarihi);
      return diffDays(e, today_) >= -7 && diffDays(e, today_) <= 0;
    }).length;
    const lastWeekDone = tasks.filter(t => {
      if (t.status !== 'done') return false;
      const e = parseDate(t.bitisTarihi);
      return diffDays(e, today_) >= -14 && diffDays(e, today_) < -7;
    }).length;
    return { thisWeekDone, lastWeekDone, delta: thisWeekDone - lastWeekDone };
  }, [tasks]);

  const statusDonut = [
    { label: 'Tamamlanan', value: done, color: 'var(--status-done)', items: doneTasks, explain: 'Bitirilmiş görevler.' },
    { label: 'Devam Eden', value: progress, color: 'var(--status-progress)', items: progressTasks, explain: 'Aktif olarak üzerinde çalışılan görevler.' },
    { label: 'Yapılacak', value: todo, color: 'var(--status-todo)', items: todoTasks, explain: 'Henüz başlanmamış görevler.' },
    { label: 'Geciken', value: overdue, color: 'var(--status-overdue)', items: overdueTasks, explain: 'Hedef tarihi geçmiş, tamamlanmamış görevler.' }
  ].filter(d => d.value > 0);

  return (
    <div className="col stagger" style={{ gap: 20 }}>
      <HeroHeader title="Genel bakış">
        <div className="muted" style={{ fontSize: 13.5 }}>
          {fmt(today_, 'dd MMM yyyy')} · {tasks.length} görev · {progress} aktif · <span style={{ color: overdue > 0 ? 'var(--status-overdue)' : 'var(--text-dim)' }}>{overdue} geciken</span>
        </div>
      </HeroHeader>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <Stat icon={<Icons.Briefcase size={16} />} label="Toplam görev" value={tasks.length} accent="var(--text)" trend={`${compRate}% tamamlandı`} items={tasks} onOpenTask={onOpenTask}
          tip="Sistemdeki tüm aktif ve kapanmış görevlerin sayısı. Projeler, sorumlular ve tarih aralıklarına göre filtrelenebilir." />
        <Stat icon={<Icons.Check size={16} />} label="Tamamlanan" value={done} accent="var(--status-done)" trend={`+${Math.max(0, done - 4)} bu hafta`} trendUp items={doneTasks} onOpenTask={onOpenTask}
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Burndown */}
        <div className="card">
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
        <div className="card">
          <CardHead
            icon={<Icons.Layers size={14} />}
            title="Durum dağılımı"
            subtitle="Görevlerin tamamlanma durumu"
            infoAccent="var(--accent)"
            infoIcon={<Icons.Layers size={12} />}
            info={<>
              <p>Görevlerin durumlarına göre yüzdesel dağılımı. Halka grafiğinin merkezindeki yüzde, "Tamamlandı" oranıdır.</p>
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
          <div className="row" style={{ gap: 24, justifyContent: 'space-between' }}>
            <div style={{ position: 'relative' }}>
              <Donut
                data={statusDonut}
                size={150}
                thickness={20}
                selected={donutSel}
                onSegmentClick={(i) => setDonutSel(donutSel === i ? null : i)}
              />
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', pointerEvents: 'none' }}>
                <div>
                  {donutSel == null ? (
                    <>
                      <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em' }}>
                        <AnimatedNumber value={compRate} />%
                      </div>
                      <div className="muted" style={{ fontSize: 11 }}>tamamlandı</div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', color: statusDonut[donutSel].color }}>
                        <AnimatedNumber value={statusDonut[donutSel].value} />
                      </div>
                      <div className="muted" style={{ fontSize: 10.5, maxWidth: 80, lineHeight: 1.3 }}>{statusDonut[donutSel].label}</div>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="col" style={{ gap: 10, flex: 1 }}>
              {statusDonut.map((s, i) => (
                <HoverListCard
                  key={s.label}
                  title={s.label}
                  icon={<span style={{ width: 9, height: 9, borderRadius: 99, background: s.color, display: 'inline-block' }} />}
                  accent={s.color}
                  items={s.items || []}
                  listHint="Açmak için tıklayın"
                  emptyText="Bu durumda görev yok."
                  summary={<>
                    <div className="rt-row"><span className="rt-label">Görev</span><span className="rt-val">{s.value}</span></div>
                    <div className="rt-row"><span className="rt-label">Oran</span><span className="rt-val">{Math.round(s.value / tasks.length * 100)}%</span></div>
                    <div className="rt-bar"><div style={{ width: `${(s.value / tasks.length) * 100}%`, background: s.color }} /></div>
                    <div className="rt-sep" />
                    <p>{s.explain}</p>
                  </>}
                  renderItem={(t) => (
                    <button key={t.id} className="rt-list-item" onClick={() => onOpenTask(t)}>
                      <span className="rli-bar" style={{ background: projectColorVar(t.proje) }} />
                      <span className="rli-main">
                        <span className="rli-name">{t.task}</span>
                        <span className="rli-meta">{t.proje} · {fmt(t.hedefTarih)}</span>
                      </span>
                      <StatusPill task={t} size={10} />
                    </button>
                  )}
                >
                  <div
                    className="row donut-leg-row"
                    style={{ justifyContent: 'space-between', cursor: 'pointer', padding: '4px 8px', borderRadius: 6, background: donutSel === i ? 'color-mix(in oklab, ' + s.color + ' 12%, transparent)' : 'transparent', border: donutSel === i ? `1px solid ${s.color}40` : '1px solid transparent', transition: 'background 0.18s, border-color 0.18s' }}
                    onClick={() => setDonutSel(donutSel === i ? null : i)}
                  >
                    <div className="row" style={{ gap: 8 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 99, background: s.color, display: 'inline-block' }} />
                      <span style={{ fontSize: 13 }}>{s.label}</span>
                    </div>
                    <span className="tabular" style={{ fontWeight: 600, fontSize: 13 }}>
                      <AnimatedNumber value={s.value} />
                    </span>
                  </div>
                </HoverListCard>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom rows */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr 1fr', gap: 16 }}>
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
            subtitle="En yüklü 5 üye"
            infoAccent="var(--c-cyan)"
            infoIcon={<Icons.Users size={12} />}
            info={<>
              <p>Görev sayısına göre en yüklü 5 ekip üyesi. Aşırı yüklenmiş bir kişiyi tespit etmek için bakın.</p>
              <div className="rt-sep" />
              <div className="rt-row"><Icons.Alert size={12} className="rt-ico" /><span>5+ aktif görev: yük dengelemeyi düşünün</span></div>
              <div className="rt-row"><Icons.Check size={12} className="rt-ico" /><span>Sağlıklı bir takım dağılımı: ±%30 standart sapma</span></div>
            </>}
          />
          <BarRows data={workload} maxLabel={110} animated />
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
                const days = diffDays(t.hedefTarih, today_);
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
                      <AvatarStack names={t.sorumlu} max={2} size="sm" />
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
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
            <span className="rli-meta">{t.proje} · {fmt(t.hedefTarih)}</span>
          </span>
          <StatusPill task={t} size={10} />
        </button>
      )}
    >
      {body}
    </HoverListCard>
  );
}

/* ── Veri (Data table) ─────────────────────────────────── */
export function VeriView({ tasks, onOpenTask, onUpdateTask, onAddTask, onDeleteTask }) {
  const [search, setSearch] = useState1('');
  const [sort, setSort] = useState1({ key: 'baslangicTarihi', dir: 'asc' });
  // per-column filters
  const [colFilter, setColFilter] = useState1({
    proje: [],
    task: '',
    keyword: [],
    sorumlu: [],
    status: [],
    priority: [],
    baslangicTarihi: null,
    bitisTarihi: null,
    hedefTarih: null,
    progress: null,
    plannedHours: null
  });

  const setCF = (key, value) => setColFilter(f => ({ ...f, [key]: value }));

  // distinct value helpers — all SORTED alphabetically (TR locale)
  const projOpts = useMemo1(() => PROJECTS
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
    .map(p => ({ value: p.name, label: p.name, icon: <span style={{ width: 8, height: 8, borderRadius: 2, background: projectColorVar(p.name) }} /> })), []);
  const kwOpts = useMemo1(() => Array.from(new Set(tasks.map(t => t.keyword)))
    .sort((a, b) => a.localeCompare(b, 'tr'))
    .map(k => ({ value: k, label: k })), [tasks]);
  const sorumluOpts = useMemo1(() => PEOPLE
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
    .map(p => ({ value: p.name, label: p.name, icon: <Avatar name={p.name} size="sm" /> })), []);
  const statusOpts = [
    { value: 'todo', label: 'Yapılacak', icon: <StatusIcon id="todo" size={11} /> },
    { value: 'in_progress', label: 'Devam ediyor', icon: <StatusIcon id="in_progress" size={11} /> },
    { value: 'done', label: 'Tamamlandı', icon: <StatusIcon id="done" size={11} /> },
    { value: 'overdue', label: 'Geciken', icon: <StatusIcon id="overdue" size={11} /> }
  ];
  const priorityOpts = Object.values(PRIORITIES).map(p => ({
    value: p.id, label: p.label, icon: <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
  }));

  // Numeric stats for filter hints
  const numStats = useMemo1(() => {
    const stats = {};
    ['progress', 'plannedHours', 'actualHours'].forEach(k => {
      const vals = tasks.map(t => t[k] || 0);
      stats[k] = { min: Math.min(...vals), max: Math.max(...vals) };
    });
    return stats;
  }, [tasks]);

  const filtered = useMemo1(() => {
    const today_ = today();
    let out = [...tasks];
    if (search) {
      const q = search.toLowerCase();
      out = out.filter(t => t.task.toLowerCase().includes(q) || t.proje.toLowerCase().includes(q) || t.keyword.toLowerCase().includes(q) || t.sorumlu.some(s => s.toLowerCase().includes(q)));
    }
    // per-column
    if (colFilter.proje.length) out = out.filter(t => colFilter.proje.includes(t.proje));
    if (colFilter.task) {
      const q = colFilter.task.toLowerCase();
      out = out.filter(t => t.task.toLowerCase().includes(q));
    }
    if (colFilter.keyword.length) out = out.filter(t => colFilter.keyword.includes(t.keyword));
    if (colFilter.sorumlu.length) out = out.filter(t => t.sorumlu.some(s => colFilter.sorumlu.includes(s)));
    if (colFilter.priority && colFilter.priority.length) out = out.filter(t => colFilter.priority.includes(t.priority || 'medium'));
    if (colFilter.status.length) {
      out = out.filter(t => {
        const overdue = t.status !== 'done' && diffDays(t.hedefTarih, today_) < 0;
        if (colFilter.status.includes('overdue') && overdue) return true;
        return colFilter.status.includes(t.status || 'todo');
      });
    }
    ['baslangicTarihi', 'bitisTarihi', 'hedefTarih'].forEach(k => {
      const spec = colFilter[k];
      if (spec) out = out.filter(t => dateMatchesFilter(t[k], spec));
    });
    ['progress', 'plannedHours'].forEach(k => {
      const spec = colFilter[k];
      if (spec) out = out.filter(t => numericMatchesFilter(t[k] != null ? t[k] : 0, spec));
    });

    out.sort((a, b) => {
      let va = a[sort.key], vb = b[sort.key];
      if (sort.key === 'sorumlu') { va = (a.sorumlu[0] || ''); vb = (b.sorumlu[0] || ''); }
      if (sort.key === 'priority') { va = (PRIORITIES[a.priority || 'medium'] || {}).order ?? 9; vb = (PRIORITIES[b.priority || 'medium'] || {}).order ?? 9; }
      if (va < vb) return sort.dir === 'asc' ? -1 : 1;
      if (va > vb) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
    return out;
  }, [tasks, search, sort, colFilter]);

  const setSortFor = (key) => (dir) => setSort({ key, dir });
  const sortDirFor = (key) => sort.key === key ? sort.dir : null;

  const clearAll = () => {
    setSearch('');
    setColFilter({ proje: [], task: '', keyword: [], sorumlu: [], status: [], priority: [], baslangicTarihi: null, bitisTarihi: null, hedefTarih: null, progress: null, plannedHours: null });
  };
  const hasAnyFilter = search || Object.values(colFilter).some(v => {
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'string') return v.length > 0;
    return !!v;
  });

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div className="topbar-search" style={{ flex: 1, minWidth: 240, maxWidth: 360 }}>
          <Icons.Search size={14} />
          <input placeholder="Görev, proje, sorumlu, keyword..." value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => setSearch('')}><Icons.Close size={12} /></button>}
        </div>
        <InfoButton title="Görevler tablosu" icon={<Icons.Table size={12} />}>
          <p>Tüm görevlerin tek bakışta listesi.</p>
          <div className="rt-sep" />
          <div className="rt-row"><Icons.Search size={12} className="rt-ico" /><span>Üstteki arama: tüm sütunlarda arar</span></div>
          <div className="rt-row"><Icons.Filter size={12} className="rt-ico" /><span>Sütun başlığına tıkla: filtrele/sırala</span></div>
          <div className="rt-row"><Icons.Calendar size={12} className="rt-ico" /><span>Tarih sütunları: Hızlı önayar veya aralık</span></div>
          <div className="rt-row"><Icons.Edit size={12} className="rt-ico" /><span>Satıra tıkla: detay panelini aç</span></div>
        </InfoButton>
        {hasAnyFilter && (
          <button className="btn ghost sm" onClick={clearAll}>
            <Icons.Close size={12} /> Filtreleri temizle
          </button>
        )}
        <span className="muted tabular" style={{ marginLeft: 'auto', fontSize: 12.5 }}>{filtered.length} / {tasks.length} görev</span>
        <button className="btn primary" onClick={onAddTask}><Icons.Plus size={14} /> Yeni görev</button>
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', background: 'var(--bg-elev)', overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto', maxHeight: 'calc(100vh - 240px)' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 36, textAlign: 'center' }}>#</th>
                <FilterableTH label="Proje" style={{ minWidth: 160 }}
                  sortKey={sortDirFor('proje')} onSort={setSortFor('proje')}
                  filter={colFilter.proje} onFilter={v => setCF('proje', v)}
                  filterType="multi" filterOptions={projOpts}
                />
                <FilterableTH label="Görev" style={{ minWidth: 260 }}
                  sortKey={sortDirFor('task')} onSort={setSortFor('task')}
                  filter={colFilter.task} onFilter={v => setCF('task', v)}
                  filterType="text"
                />
                <FilterableTH label="Etiket" style={{ minWidth: 110 }}
                  filter={colFilter.keyword} onFilter={v => setCF('keyword', v)}
                  filterType="multi" filterOptions={kwOpts}
                />
                <FilterableTH label="Sorumlu" style={{ minWidth: 130 }}
                  sortKey={sortDirFor('sorumlu')} onSort={setSortFor('sorumlu')}
                  filter={colFilter.sorumlu} onFilter={v => setCF('sorumlu', v)}
                  filterType="multi" filterOptions={sorumluOpts}
                />
                <FilterableTH label="Durum" style={{ minWidth: 130 }}
                  sortKey={sortDirFor('status')} onSort={setSortFor('status')}
                  filter={colFilter.status} onFilter={v => setCF('status', v)}
                  filterType="multi" filterOptions={statusOpts}
                />
                <FilterableTH label="Öncelik" style={{ minWidth: 100 }}
                  sortKey={sortDirFor('priority')} onSort={setSortFor('priority')}
                  filter={colFilter.priority} onFilter={v => setCF('priority', v)}
                  filterType="multi" filterOptions={priorityOpts}
                />
                <FilterableTH label="İlerleme" style={{ minWidth: 110 }}
                  sortKey={sortDirFor('progress')} onSort={setSortFor('progress')}
                  filter={colFilter.progress} onFilter={v => setCF('progress', v)}
                  filterType="number" numericMin={0} numericMax={100} numericUnit="%"
                />
                <FilterableTH label="Saat (P)" style={{ minWidth: 80 }}
                  sortKey={sortDirFor('plannedHours')} onSort={setSortFor('plannedHours')}
                  filter={colFilter.plannedHours} onFilter={v => setCF('plannedHours', v)}
                  filterType="number" numericMin={numStats.plannedHours.min} numericMax={numStats.plannedHours.max} numericUnit=" sa"
                />
                <FilterableTH label="Başlangıç" style={{ minWidth: 130 }}
                  sortKey={sortDirFor('baslangicTarihi')} onSort={setSortFor('baslangicTarihi')}
                  filter={colFilter.baslangicTarihi} onFilter={v => setCF('baslangicTarihi', v)}
                  filterType="date"
                />
                <FilterableTH label="Bitiş" style={{ minWidth: 130 }}
                  sortKey={sortDirFor('bitisTarihi')} onSort={setSortFor('bitisTarihi')}
                  filter={colFilter.bitisTarihi} onFilter={v => setCF('bitisTarihi', v)}
                  filterType="date"
                />
                <FilterableTH label="Hedef" style={{ minWidth: 130 }}
                  sortKey={sortDirFor('hedefTarih')} onSort={setSortFor('hedefTarih')}
                  filter={colFilter.hedefTarih} onFilter={v => setCF('hedefTarih', v)}
                  filterType="date"
                />
                <th style={{ width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={14} className="empty">Eşleşen görev bulunamadı.</td></tr>
              )}
              {filtered.map((t, idx) => {
                const today_ = today();
                const overdue = t.status !== 'done' && diffDays(t.hedefTarih, today_) < 0;
                const prio = PRIORITIES[t.priority || 'medium'];
                const prog = t.progress != null ? t.progress : (t.status === 'done' ? 100 : 0);
                return (
                  <tr key={t.id} onClick={() => onOpenTask(t)} style={{ cursor: 'pointer' }}>
                    <td className="muted tabular" style={{ textAlign: 'center', fontSize: 11.5 }}>{idx + 1}</td>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 99, background: projectColorVar(t.proje) }} />
                        <span style={{ fontWeight: 500 }}>{t.proje}</span>
                      </div>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        {t.milestone && <Icons.Diamond size={10} style={{ color: projectColorVar(t.proje) }} />}
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{t.task}</div>
                      </div>
                    </td>
                    <td><Kw color={t.color}>{t.keyword}</Kw></td>
                    <td><AvatarStack names={t.sorumlu} max={3} size="sm" /></td>
                    <td><StatusPill task={t} /></td>
                    <td><span style={{ fontSize: 11.5, fontWeight: 600, color: prio.color }}>{prio.label}</span></td>
                    <td>
                      <div className="row" style={{ gap: 8, minWidth: 90 }}>
                        <div className="bar-track" style={{ flex: 1, height: 4 }}>
                          <div className="bar-fill" style={{ width: `${prog}%`, background: prog === 100 ? 'var(--status-done)' : projectColorVar(t.proje) }} />
                        </div>
                        <span className="tabular" style={{ fontSize: 11, minWidth: 28, textAlign: 'right', color: 'var(--text-muted)' }}>{prog}%</span>
                      </div>
                    </td>
                    <td className="tabular" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{t.plannedHours || 0} sa</td>
                    <td className="muted tabular" style={{ fontSize: 12 }}>{fmt(t.baslangicTarihi)}</td>
                    <td className="muted tabular" style={{ fontSize: 12 }}>{fmt(t.bitisTarihi)}</td>
                    <td className="tabular" style={{ fontSize: 12, color: overdue ? 'var(--status-overdue)' : 'var(--text-muted)', fontWeight: overdue ? 600 : 500 }}>{fmt(t.hedefTarih)}</td>
                    <td>
                      <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={(e) => { e.stopPropagation(); if (confirm('Görev silinsin mi?')) onDeleteTask(t.id); }}>
                        <Icons.Trash size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ── Kişi (People) view ──────────────────────────────── */
export function KisiView({ tasks, onOpenTask }) {
  const today_ = today();

  const stats = useMemo1(() => {
    return PEOPLE.map(p => {
      const mine = tasks.filter(t => t.sorumlu.includes(p.name));
      const done = mine.filter(t => t.status === 'done').length;
      const active = mine.filter(t => t.status === 'in_progress').length;
      const late = mine.filter(t => t.status !== 'done' && diffDays(t.hedefTarih, today_) < 0).length;
      return { person: p, total: mine.length, done, active, late, tasks: mine };
    });
  }, [tasks]);

  const byTeam = useMemo1(() => {
    const map = {};
    stats.forEach(s => {
      map[s.person.team] = map[s.person.team] || [];
      map[s.person.team].push(s);
    });
    return map;
  }, [stats]);

  return (
    <div className="col" style={{ gap: 20 }}>
      {Object.entries(byTeam).map(([team, members]) => (
        <div key={team} className="col" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>{team}</div>
            <div style={{ height: 1, flex: 1, background: 'var(--border)' }} />
            <div className="muted tabular" style={{ fontSize: 11 }}>{members.length} üye</div>
          </div>
          <div className="stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {members.map(m => (
              <div key={m.person.id} className="card" style={{ padding: 18 }}>
                <div className="row" style={{ alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
                  <Avatar name={m.person.name} size="lg" />
                  <div className="col" style={{ flex: 1, gap: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{m.person.name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{m.person.role}</div>
                  </div>
                  <InfoButton title={m.person.name} icon={<Avatar name={m.person.name} size="sm" />}>
                    <div className="rt-row"><span className="rt-label">Rol</span><span className="rt-val">{m.person.role}</span></div>
                    <div className="rt-row"><span className="rt-label">Ekip</span><span className="rt-val">{m.person.team}</span></div>
                    <div className="rt-sep" />
                    <div className="rt-row"><span className="rt-label">Toplam görev</span><span className="rt-val">{m.total}</span></div>
                    <div className="rt-row"><span className="rt-label">Devam eden</span><span className="rt-val">{m.active}</span></div>
                    <div className="rt-row"><span className="rt-label">Tamamlanan</span><span className="rt-val" style={{ color: 'var(--status-done)' }}>{m.done}</span></div>
                    <div className="rt-row"><span className="rt-label">Geciken</span><span className="rt-val" style={m.late > 0 ? { color: 'var(--status-overdue)' } : null}>{m.late}</span></div>
                  </InfoButton>
                  {m.late > 0 && (
                    <span className="badge" style={{ color: 'var(--status-overdue)', borderColor: 'color-mix(in oklab, var(--status-overdue) 35%, var(--border))', background: 'color-mix(in oklab, var(--status-overdue) 14%, transparent)' }}>
                      <Icons.Alert size={10} /> {m.late} geciken
                    </span>
                  )}
                </div>
                <div className="row" style={{ gap: 16, marginBottom: 12 }}>
                  <Mini label="Toplam" value={m.total} />
                  <Mini label="Devam" value={m.active} color="var(--status-progress)" />
                  <Mini label="Bitti" value={m.done} color="var(--status-done)" />
                </div>
                <div className="bar-track" style={{ marginBottom: 12 }}>
                  <div className="bar-fill done" style={{ width: m.total ? `${(m.done / m.total) * 100}%` : 0 }} />
                </div>
                <div className="col" style={{ gap: 4 }}>
                  {m.tasks.slice(0, 3).map(t => (
                    <button key={t.id} onClick={() => onOpenTask(t)} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px',
                      borderRadius: 5, background: 'transparent', border: 0,
                      width: '100%', textAlign: 'left', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 12
                    }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
                    >
                      <span style={{ width: 5, height: 5, borderRadius: 99, background: projectColorVar(t.proje), flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{t.task}</span>
                    </button>
                  ))}
                  {m.tasks.length > 3 && <div className="muted" style={{ fontSize: 11, padding: '2px 8px' }}>+{m.tasks.length - 3} daha</div>}
                  {m.tasks.length === 0 && <div className="muted" style={{ fontSize: 12, padding: '6px 8px' }}>Atanmış görev yok.</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
function Mini({ label, value, color }) {
  return (
    <div className="col" style={{ gap: 0, flex: 1 }}>
      <div className="muted" style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</div>
      <div className="tabular" style={{ fontSize: 18, fontWeight: 700, color: color || 'var(--text)', letterSpacing: '-0.02em', lineHeight: 1.2 }}>
        <AnimatedNumber value={value} duration={700} />
      </div>
    </div>
  );
}
