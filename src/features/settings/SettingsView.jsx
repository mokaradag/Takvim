'use client';
/* ── Ayarlar (Settings) ──────────────────────────────────
   Görünüm ve okunabilirlik tercihleri. Tüm değerler Tweaks
   state'i üzerinden yönetilir (kalıcı). ===================== */
import { Icons } from '../../components/icons';
import { HeroHeader } from '../../components/ui';
import { TWEAK_DEFAULTS } from '../../lib/tweaks-defaults';

function SettingsRow({ title, desc, children }) {
  return (
    <div className="set-row">
      <div className="col" style={{ gap: 3, flex: 1, minWidth: 0 }}>
        <div className="set-row-title">{title}</div>
        {desc && <div className="set-row-desc">{desc}</div>}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <div className="seg">
      {options.map(([val, label]) => (
        <button
          key={String(val)}
          className={`seg-btn${value === val ? ' active' : ''}`}
          onClick={() => onChange(val)}
          type="button"
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// Boolean on/off segmented control
function ToggleSeg({ value, onChange, on = 'Açık', off = 'Kapalı' }) {
  return (
    <div className="seg">
      <button type="button" className={`seg-btn${value ? ' active' : ''}`} onClick={() => onChange(true)}>{on}</button>
      <button type="button" className={`seg-btn${!value ? ' active' : ''}`} onClick={() => onChange(false)}>{off}</button>
    </div>
  );
}

export function SettingsView({ t, setTweak }) {
  const fontScale = t.fontScale || 1;
  const accents = [
    ['#3b82f6', 'Mavi'], ['#8b5cf6', 'Mor'], ['#f43f5e', 'Gül'],
    ['#10b981', 'Zümrüt'], ['#f59e0b', 'Amber'], ['#0ea5e9', 'Camgöbeği']
  ];
  const fontPresets = [['0.9', 'Küçük'], ['1', 'Normal'], ['1.1', 'Büyük'], ['1.25', 'Çok büyük']];
  const landingOpts = [
    ['ozet', 'Özet'], ['veri', 'Görevler'], ['takvim', 'Takvim'], ['gantt', 'Gantt'],
    ['kanban', 'Kanban'], ['rapor', 'Raporlar'], ['kisi', 'Ekip']
  ];
  const pct = Math.round(fontScale * 100);

  const resetWelcome = () => {
    try { localStorage.removeItem('mp_seen_welcome_v2'); } catch (e) {}
    window.location.reload();
  };

  const resetDefaults = () => {
    if (!confirm('Tüm görünüm ve tercih ayarları varsayılan değerlerine döndürülsün mü?')) return;
    setTweak({ ...TWEAK_DEFAULTS });
  };

  return (
    <div className="col stagger" style={{ gap: 20 }}>
      <HeroHeader title="Ayarlar">
        <div className="muted" style={{ fontSize: 13.5 }}>Görünüm, okunabilirlik ve uygulama tercihleri.</div>
      </HeroHeader>

      <div className="settings-grid">
        {/* Görünüm */}
        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>
            <Icons.Sun size={14} /><span>Görünüm</span>
          </div>
          <div className="card-sub">Tema ve arayüz yoğunluğu.</div>

          <SettingsRow title="Tema" desc="Açık veya koyu arayüz.">
            <Segmented value={t.theme} onChange={(v) => setTweak('theme', v)}
              options={[['dark', 'Koyu'], ['light', 'Açık']]} />
          </SettingsRow>

          <div className="set-sep" />

          <SettingsRow title="Yoğunluk" desc="Satır ve kart boşluklarının sıklığı.">
            <Segmented value={t.density} onChange={(v) => setTweak('density', v)}
              options={[['compact', 'Sıkışık'], ['balanced', 'Dengeli'], ['spacious', 'Ferah']]} />
          </SettingsRow>

          <div className="set-sep" />

          <SettingsRow title="Marka amblemi" desc="Başlıklarda ve kenar çubuğunda yedigen amblemi.">
            <ToggleSeg value={t.showEmblem !== false} onChange={(v) => setTweak('showEmblem', v)} />
          </SettingsRow>
        </div>

        {/* Yazı tipi boyutu */}
        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>
            <Icons.Table size={14} /><span>Yazı tipi boyutu</span>
          </div>
          <div className="card-sub">Tüm uygulama metnini ölçeklendirir.</div>

          <div className="set-row" style={{ alignItems: 'flex-start' }}>
            <div className="col" style={{ gap: 3, flex: 1, minWidth: 0 }}>
              <div className="set-row-title">Ölçek</div>
              <div className="set-row-desc">Önayar seçin veya kaydırıcıyla ince ayar yapın.</div>
            </div>
            <div className="font-preview" style={{ fontSize: `${14 * fontScale}px` }}>Aa</div>
          </div>

          <div className="seg" style={{ marginTop: 10 }}>
            {fontPresets.map(([val, label]) => (
              <button key={val} type="button"
                className={`seg-btn${Math.abs(fontScale - parseFloat(val)) < 0.001 ? ' active' : ''}`}
                onClick={() => setTweak('fontScale', parseFloat(val))}>
                {label}
              </button>
            ))}
          </div>

          <div className="row" style={{ gap: 12, marginTop: 14, alignItems: 'center' }}>
            <input type="range" min="0.8" max="1.4" step="0.05" value={fontScale}
              onChange={(e) => setTweak('fontScale', parseFloat(e.target.value))}
              style={{ flex: 1, accentColor: 'var(--accent)' }} />
            <span className="tabular" style={{ fontSize: 13, fontWeight: 600, minWidth: 44, textAlign: 'right' }}>%{pct}</span>
          </div>
        </div>

        {/* Vurgu rengi */}
        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>
            <Icons.Sparkle size={14} /><span>Vurgu rengi</span>
          </div>
          <div className="card-sub">Düğmeler, bağlantılar, başlıklar ve seçili öğeler.</div>
          <div className="swatch-grid">
            {accents.map(([hex, name]) => (
              <button key={hex} type="button"
                className={`swatch${t.accent === hex ? ' active' : ''}`}
                onClick={() => setTweak('accent', hex)} title={name}>
                <span className="swatch-dot" style={{ background: hex }}>
                  {t.accent === hex && <Icons.Check size={13} />}
                </span>
                <span className="swatch-name">{name}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Çalışma alanı */}
        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>
            <Icons.Dashboard size={14} /><span>Çalışma alanı</span>
          </div>
          <div className="card-sub">Başlangıç ve görünüm davranışı.</div>

          <SettingsRow title="Açılış sayfası" desc="Uygulama açıldığında gösterilecek sayfa.">
            <select className="set-select" value={t.landingView || 'ozet'} onChange={(e) => setTweak('landingView', e.target.value)}>
              {landingOpts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </SettingsRow>

          <div className="set-sep" />

          <SettingsRow title="Takvim gün kutuları" desc="Takvimde her güne daha fazla alan ve görev ayır.">
            <ToggleSeg value={!!t.calLarge} onChange={(v) => setTweak('calLarge', v)} on="Büyük" off="Normal" />
          </SettingsRow>

          <div className="set-sep" />

          <SettingsRow title="Hareketi azalt" desc="Süslemeli ve sürekli animasyonları kapatır.">
            <ToggleSeg value={!!t.reduceMotion} onChange={(v) => setTweak('reduceMotion', v)} />
          </SettingsRow>
        </div>

        {/* Uygulama */}
        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>
            <Icons.Help size={14} /><span>Uygulama</span>
          </div>
          <div className="card-sub">Yardım, kısayollar ve sıfırlama.</div>

          <SettingsRow title="Karşılama ekranı" desc="Tanıtım turunu yeniden gösterir.">
            <button className="btn sm" type="button" onClick={resetWelcome}>
              <Icons.Help size={13} /> Tekrar göster
            </button>
          </SettingsRow>

          <div className="set-sep" />

          <SettingsRow title="Komut paleti" desc="Hızlı gezinme ve eylemler (Windows).">
            <span className="kbd-hint"><kbd>Ctrl</kbd><kbd>K</kbd></span>
          </SettingsRow>

          <div className="set-sep" />

          <SettingsRow title="Varsayılanlara dön" desc="Tema, yoğunluk, yazı boyutu, renk ve tüm tercihleri sıfırlar.">
            <button className="btn sm" type="button" onClick={resetDefaults}>
              <Icons.Sparkle size={13} /> Sıfırla
            </button>
          </SettingsRow>
        </div>
      </div>
    </div>
  );
}
