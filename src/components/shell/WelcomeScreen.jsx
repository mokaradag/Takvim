'use client';
import { useEffect } from 'react';
import { Icons } from '../icons';
import { Avatar } from '../ui';
import { resolveUserDepartmentLabel, resolveUserDisplayName } from '../../domain/identity/sessionUser.js';
import { AppLogo } from './AppLogo';

/**
 * Karşılama ekranı.
 *
 * Ekran artık kişiselleştirilmiştir: doğrulanmış oturumdan gelen kullanıcı
 * kurumsal fotoğrafı (yoksa baş harf yedeği), adı ve departmanı ile selamlanır.
 * Kimlik yalnızca GÖSTERİM amaçlıdır; hiçbir yetki kararı buradan türetilmez.
 */

/** Saate göre Türkçe selamlama. */
export function greetingForHour(hour) {
  if (!Number.isFinite(hour)) return 'Hoş geldiniz';
  if (hour < 6) return 'İyi geceler';
  if (hour < 12) return 'Günaydın';
  if (hour < 18) return 'İyi günler';
  return 'İyi akşamlar';
}

/** Selamlamada tam ad yerine yalnızca ilk ad kullanılır. */
export function welcomeFirstName(displayName) {
  const first = String(displayName || '').trim().split(/\s+/)[0] || '';
  return first;
}

const FEATURES = [
  { ico: 'Dashboard', color: 'var(--accent)', view: 'ozet', title: 'Yönetici özet panosu',
    desc: 'Tamamlama oranı, bekleyen iş yükü, geciken görevler ve trendler tek ekranda.' },
  { ico: 'Layers', color: 'var(--c-emerald)', view: 'wbs', title: 'Sürükle-bırak iş dağılım ağacı',
    desc: 'Proje yapısını satırları sürükleyerek kurun; alt düğüm yapın veya kardeş sırasını değiştirin.' },
  { ico: 'Gantt', color: 'var(--c-purple)', view: 'gantt', title: 'Primavera-tarzı Gantt',
    desc: 'FS/SS/FF/SF bağımlılıkları, özet (rollup) çubukları, kilometre taşları, tatil işaretleri.' },
  { ico: 'Calendar', color: 'var(--c-cyan)', view: 'takvim', title: 'Aylık takvim',
    desc: 'Resmî tatilleri ve görev yoğunluğunu görün, yoğun günlere tıklayarak tüm girdileri açın.' },
  { ico: 'Kanban', color: 'var(--c-amber)', view: 'kanban', title: 'Sürükle-bırak Kanban',
    desc: 'Yapılacak → Devam ediyor → Tamamlandı kolonları arasında kartları sürükleyin.' },
  { ico: 'Chart', color: 'var(--c-rose)', view: 'rapor', title: 'Etkileşimli raporlar',
    desc: 'Çevrim süresi, zamanında teslim oranı, kaynak kullanımı ve trend eğrileri.' }
];

export function WelcomeScreen({ onClose, onNavigate, onShowAgainChange, showAgain, stats, currentUser = null, now = new Date() }) {
  const displayName = resolveUserDisplayName(currentUser, { fallback: '' });
  const firstName = welcomeFirstName(displayName);
  const greeting = greetingForHour(now.getHours());
  const department = resolveUserDepartmentLabel(currentUser, { fallback: '' });
  const employeeNo = currentUser?.employeeNo || currentUser?.sicil || null;

  // Esc karşılama ekranını kapatır: modalın klavyeyle de kapanabilmesi gerekir.
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="welcome-backdrop" onClick={onClose}>
      <div
        className="welcome-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="welcome-head">
          <div className="welcome-head-glow" aria-hidden="true" />
          <div className="welcome-identity">
            <div className="welcome-avatar">
              <Avatar name={displayName || 'Kullanıcı'} employeeNo={employeeNo} size="lg" />
              <span className="welcome-avatar-ring" aria-hidden="true" />
            </div>
            <div className="col welcome-identity-text">
              <span className="welcome-greeting">{greeting}{firstName ? `, ${firstName}` : ''}</span>
              {displayName && <span className="welcome-user-name">{displayName}</span>}
              {(department || employeeNo) && (
                <span className="welcome-user-meta">
                  {department}
                  {department && employeeNo ? ' · ' : ''}
                  {employeeNo ? `Sicil ${employeeNo}` : ''}
                </span>
              )}
            </div>
          </div>

          <div className="welcome-brand">
            <AppLogo size={40} />
            <div className="col" style={{ gap: 1 }}>
              <span className="welcome-brand-name">MERGEN <strong>Rota</strong></span>
              <span className="welcome-brand-sub">Proje Yönetimi · Sürüm 1.0</span>
            </div>
          </div>

          <button className="icon-btn welcome-close" onClick={onClose} aria-label="Karşılama ekranını kapat">
            <Icons.Close size={16} />
          </button>
        </div>

        <div className="welcome-body">
          <h2 id="welcome-title" className="welcome-title">Portföyünüz bugün böyle görünüyor</h2>
          <div className="welcome-sub">
            Planlamadan raporlamaya tüm proje akışı tek yerde. Ayrıntılı açıklamalara istediğiniz zaman{' '}
            <strong>Kullanım Rehberi</strong> sayfasından ulaşabilirsiniz.
          </div>

          <div className="welcome-callouts">
            <button type="button" className="welcome-callout" onClick={() => { onNavigate('veri'); onClose(); }}>
              <span className="wc-k"><Icons.Clock size={11} /> Aktif görev</span>
              <span className="wc-v">{stats.active}</span>
              <span className="wc-s">{stats.inProgress} devam · {stats.todo} yapılacak</span>
            </button>
            <button type="button" className="welcome-callout" onClick={() => { onNavigate('ozet'); onClose(); }}>
              <span className="wc-k"><Icons.Check size={11} /> Tamamlama</span>
              <span className="wc-v" style={{ color: 'var(--status-done)' }}>{stats.compRate}%</span>
              <span className="wc-s">{stats.done} / {stats.total} görev</span>
              <span className="wc-bar"><span style={{ width: `${Math.min(100, Math.max(0, stats.compRate))}%` }} /></span>
            </button>
            <button
              type="button"
              className={`welcome-callout${stats.overdue > 0 ? ' alert' : ''}`}
              onClick={() => { onNavigate('ozet'); onClose(); }}
            >
              <span className="wc-k"><Icons.Alert size={11} /> Geciken</span>
              <span className="wc-v" style={{ color: stats.overdue > 0 ? 'var(--status-overdue)' : 'var(--text)' }}>{stats.overdue}</span>
              <span className="wc-s">{stats.overdue > 0 ? 'müdahale gerekli' : 'tertip · sıfır geciken'}</span>
            </button>
          </div>

          <div className="welcome-grid">
            {FEATURES.map((f) => {
              const I = Icons[f.ico];
              return (
                <button
                  type="button"
                  key={f.title}
                  className="welcome-card"
                  style={{ '--wc-color': f.color }}
                  onClick={() => { onNavigate(f.view); onClose(); }}
                >
                  <span className="wc-ico"><I size={17} /></span>
                  <span className="col" style={{ gap: 0, flex: 1, minWidth: 0, textAlign: 'left' }}>
                    <span className="wc-title">{f.title}</span>
                    <span className="wc-desc">{f.desc}</span>
                  </span>
                  <Icons.ArrowRight size={13} className="wc-go" />
                </button>
              );
            })}
          </div>

          <div className="welcome-shortcuts">
            <span className="ws-item"><Icons.Keyboard size={13} /> Kısayollar:</span>
            <span className="ws-item"><kbd>Ctrl</kbd><kbd>K</kbd> Komut paleti</span>
            <span className="ws-item"><kbd>Esc</kbd> Paneli kapat</span>
            <span className="ws-item"><kbd>←</kbd> <kbd>→</kbd> Ay değiştir (takvimde)</span>
            <span className="ws-item"><Icons.Info size={12} /> Her yerde ‘i’ ipuçları</span>
          </div>
        </div>

        <div className="welcome-foot">
          <label>
            <input type="checkbox" checked={!showAgain} onChange={(e) => onShowAgainChange(!e.target.checked)} />
            Bir daha gösterme
          </label>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => { onNavigate('yardim'); onClose(); }}>
            <Icons.Help size={13} /> Kullanım rehberi
          </button>
          <button className="btn primary" onClick={onClose}>
            Başlayalım <Icons.ArrowRight size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
