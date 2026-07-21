'use client';
import { Icons } from '../icons';
import { AppLogo } from './AppLogo';

/* ── Welcome / Onboarding screen ──────────────────────── */
export function WelcomeScreen({ onClose, onNavigate, onShowAgainChange, showAgain, stats }) {
  const features = [
    { ico: 'Dashboard', color: 'var(--accent)', title: 'Yönetici özet panosu',
      desc: 'Tamamlama oranı, bekleyen iş yükü, geciken görevler ve trendler tek ekranda.' },
    { ico: 'Gantt', color: 'var(--c-purple)', title: 'Primavera-tarzı Gantt',
      desc: 'FS/SS/FF/SF bağımlılıkları, özet (rollup) çubukları, kilometre taşları, hafta sonu/tatil işaretleri.' },
    { ico: 'Calendar', color: 'var(--c-emerald)', title: 'Aylık takvim',
      desc: 'Resmi tatilleri ve görev yoğunluğunu görün, yoğun günlere tıklayarak tüm girdileri açın.' },
    { ico: 'Kanban', color: 'var(--c-amber)', title: 'Sürükle-bırak Kanban',
      desc: 'Yapılacak → Devam ediyor → Tamamlandı kolonları arasında kartları sürükleyin.' },
    { ico: 'Table', color: 'var(--c-cyan)', title: 'Akıllı veri tablosu',
      desc: 'Çoklu seçim filtreleri, tarih için hızlı önayar/aralık filtreleri, sütun bazlı sıralama.' },
    { ico: 'Chart', color: 'var(--c-rose)', title: 'Etkileşimli raporlar',
      desc: 'Çevrim süresi, zamanında teslim oranı, proje bazlı throughput ve trend eğrileri.' }
  ];

  return (
    <div className="welcome-backdrop" onClick={onClose}>
      <div className="welcome-panel" onClick={(e) => e.stopPropagation()}>
        <div className="welcome-head">
          <AppLogo size={48} />
          <div className="col" style={{ flex: 1, gap: 0 }}>
            <div className="row" style={{ gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent)' }}>MERGEN Rota · v2.4</span>
            </div>
            <h2>Hoş geldiniz</h2>
            <div className="welcome-sub">
              MERGEN Rota, projenizin planlamasından raporlamasına kadar her şeyi tek bir yerden yönetmenizi sağlar.
              Aşağıda hızlı bir özet; istediğiniz zaman sol alttaki <strong>Yardım</strong> düğmesinden tekrar açabilirsiniz.
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icons.Close size={16} /></button>
        </div>

        <div className="welcome-body">
          <div className="welcome-callouts">
            <div className="welcome-callout">
              <span className="wc-k">Aktif görev</span>
              <span className="wc-v">{stats.active}</span>
              <span className="wc-s">{stats.inProgress} devam · {stats.todo} yapılacak</span>
            </div>
            <div className="welcome-callout">
              <span className="wc-k">Tamamlama</span>
              <span className="wc-v" style={{ color: 'var(--status-done)' }}>{stats.compRate}%</span>
              <span className="wc-s">{stats.done} / {stats.total} görev</span>
            </div>
            <div className="welcome-callout">
              <span className="wc-k">Geciken</span>
              <span className="wc-v" style={{ color: stats.overdue > 0 ? 'var(--status-overdue)' : 'var(--text)' }}>{stats.overdue}</span>
              <span className="wc-s">{stats.overdue > 0 ? 'müdahale gerekli' : 'tertip · sıfır geciken'}</span>
            </div>
          </div>

          <div className="welcome-grid" style={{ marginTop: 14 }}>
            {features.map((f) => {
              const I = Icons[f.ico];
              return (
                <div key={f.title} className="welcome-card" style={{ '--wc-color': f.color }}>
                  <span className="wc-ico"><I size={17} /></span>
                  <div className="col" style={{ gap: 0, flex: 1 }}>
                    <span className="wc-title">{f.title}</span>
                    <span className="wc-desc">{f.desc}</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="welcome-shortcuts">
            <span className="ws-item"><Icons.Keyboard size={13} /> Kısayollar:</span>
            <span className="ws-item"><kbd>Ctrl</kbd><kbd>K</kbd> Komut paleti</span>
            <span className="ws-item"><kbd>Esc</kbd> Paneli kapat</span>
            <span className="ws-item"><kbd>←</kbd> <kbd>→</kbd> Ay değiştir (takvimde)</span>
            <span className="ws-item"><Icons.Info size={12} /> Her yerde "i" ipuçları</span>
          </div>
        </div>

        <div className="welcome-foot">
          <label>
            <input type="checkbox" checked={!showAgain} onChange={(e) => onShowAgainChange(!e.target.checked)} />
            Bir daha gösterme
          </label>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => { onNavigate('ozet'); onClose(); }}>
            <Icons.Dashboard size={13} /> Panoya git
          </button>
          <button className="btn primary" onClick={onClose}>
            Başlayalım <Icons.ArrowRight size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
