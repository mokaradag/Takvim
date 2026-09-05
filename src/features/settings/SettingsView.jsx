'use client';
import { Icons } from '../../components/icons';
import { DataModeIndicator } from '../../components/shell/DataModeIndicator';
import { HeroHeader } from '../../components/ui';
import { TWEAK_DEFAULTS } from '../../lib/tweaks-defaults';

const MODE_STORAGE_KEY = 'mergen_rota_mode_selected_v1';

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

function ToggleSeg({ value, onChange, on = 'Açık', off = 'Kapalı' }) {
  return (
    <div className="seg">
      <button type="button" className={`seg-btn${value ? ' active' : ''}`} onClick={() => onChange(true)}>{on}</button>
      <button type="button" className={`seg-btn${!value ? ' active' : ''}`} onClick={() => onChange(false)}>{off}</button>
    </div>
  );
}

function ModeCard({ id, active, icon: Icon, title, kicker, description, points, onSelect }) {
  return (
    <button type="button" className={`settings-mode-card${active ? ' active' : ''}`} onClick={() => onSelect(id)}>
      <span className="settings-mode-icon"><Icon size={20} /></span>
      <span className="settings-mode-main">
        <small>{kicker}</small>
        <strong>{title}</strong>
        <span>{description}</span>
      </span>
      <span className="settings-mode-points">
        {points.map((point) => <span key={point}><Icons.Check size={11} /> {point}</span>)}
      </span>
      <span className="settings-mode-state">{active ? <><Icons.Check size={13} /> Kullanılıyor</> : 'Bu kipe geç'}</span>
    </button>
  );
}

export function SettingsView({ t, setTweak }) {
  const fontScale = t.fontScale || 1;
  const appMode = t.appMode || 'advanced';
  const accents = [
    ['#3b82f6', 'Mavi'], ['#8b5cf6', 'Mor'], ['#f43f5e', 'Gül'],
    // Vurgu rengi adları Türkçedir; proje renk kataloğuyla aynı sözcük kullanılır.
    ['#10b981', 'Zümrüt'], ['#f59e0b', 'Kehribar'], ['#0ea5e9', 'Camgöbeği']
  ];
  const fontPresets = [['0.9', 'Küçük'], ['1', 'Normal'], ['1.1', 'Büyük'], ['1.25', 'Çok büyük']];
  const landingOpts = [
    ['ozet', 'Özet'], ['veri', 'Görevler'], ['takvim', 'Takvim'], ['gantt', 'Gantt'],
    ['kanban', 'Kanban'], ['rapor', 'Raporlar'], ['kisi', 'Ekip']
  ];
  const pct = Math.round(fontScale * 100);

  const setMode = (mode) => {
    setTweak('appMode', mode);
    try { localStorage.setItem(MODE_STORAGE_KEY, '1'); } catch {}
  };

  const resetWelcome = () => {
    try { localStorage.removeItem('mp_seen_welcome_v2'); } catch (e) {}
    window.location.reload();
  };

  const resetModeChoice = () => {
    try { localStorage.removeItem(MODE_STORAGE_KEY); } catch (e) {}
    window.location.reload();
  };

  const resetDefaults = () => {
    if (!confirm('Tüm görünüm ve tercih ayarları varsayılan değerlerine döndürülsün mü?')) return;
    setTweak({ ...TWEAK_DEFAULTS });
  };

  return (
    <div className="col stagger" style={{ gap: 20 }}>
      <HeroHeader title="Ayarlar">
        <div className="muted" style={{ fontSize: 13.5 }}>Çalışma kipi, görünüm, okunabilirlik ve uygulama tercihleri.</div>
      </HeroHeader>

      <section className="settings-mode-section">
        <div className="settings-mode-heading">
          <div>
            <span className="help-kicker">Çalışma biçimi</span>
            <h2>MERGEN Rota kipini seçin</h2>
            <p>İki kip aynı proje ve görev altyapısını kullanır. Temel kipte oluşturduğunuz kayıtları daha sonra kapsamlı kipte ayrıntılandırabilirsiniz.</p>
          </div>
          <span className="settings-mode-current">Aktif: {appMode === 'simple' ? 'Temel Kip' : 'Kapsamlı Kip'}</span>
        </div>
        <div className="settings-mode-grid">
          <ModeCard
            id="simple"
            active={appMode === 'simple'}
            icon={Icons.Calendar}
            title="Temel Kip"
            kicker="Hızlı takip"
            description="Proje, görev, kısa açıklama, sorumlu ve termin tarihi ile çalışın; kayıtları Takvim üzerinde izleyin."
            points={['Tek ekranlı hızlı giriş', 'Takvim odaklı takip', 'Aynı veri modeli']}
            onSelect={setMode}
          />
          <ModeCard
            id="advanced"
            active={appMode === 'advanced'}
            icon={Icons.Gantt}
            title="Kapsamlı Kip"
            kicker="Tam görev yönetimi"
            description="WBS, Gantt, bağımlılıklar, Kanban, raporlar ve portföy araçlarının tümünü kullanın."
            points={['WBS ve kritik yol', 'Bağımlılık yönetimi', 'Raporlama ve portföy']}
            onSelect={setMode}
          />
        </div>
      </section>

      <div className="settings-grid">
        {/* Gerçek Sistem / Demo anahtarı kenar çubuğundan buraya taşındı. */}
        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>
            <Icons.Database size={14} /><span>Veri kaynağı</span>
          </div>
          <div className="card-sub">Uygulamanın hangi veri kaynağıyla çalıştığını belirler.</div>

          <SettingsRow
            title="Çalışma verisi"
            desc="Gerçek Sistem kurumsal SQL Server üzerinde çalışır; Demo kipi örnek veriyle güvenle denemenizi sağlar. Kip değiştirilmeden önce bekleyen kayıtlar tamamlanır."
          >
            <DataModeIndicator variant="settings" />
          </SettingsRow>
        </div>

        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>
            <Icons.Sun size={14} /><span>Görünüm</span>
          </div>
          <div className="card-sub">Tema ve arayüz yoğunluğu.</div>

          <SettingsRow title="Tema" desc="Açık veya koyu arayüz.">
            <Segmented value={t.theme} onChange={(v) => setTweak('theme', v)}
              options={[["dark", 'Koyu'], ['light', 'Açık']]} />
          </SettingsRow>

          <div className="set-sep" />

          <SettingsRow title="Yoğunluk" desc="Satır ve kart boşluklarının sıklığı.">
            <Segmented value={t.density} onChange={(v) => setTweak('density', v)}
              options={[["compact", 'Sıkışık'], ['balanced', 'Dengeli'], ['spacious', 'Ferah']]} />
          </SettingsRow>

          <div className="set-sep" />

          <SettingsRow title="Marka amblemi" desc="Başlıklarda ve kenar çubuğunda yedigen amblemi.">
            <ToggleSeg value={t.showEmblem !== false} onChange={(v) => setTweak('showEmblem', v)} />
          </SettingsRow>
        </div>

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
            {/* `SettingsRow` başlığı bir `div`'dir ve hiçbir denetimi
                etiketlemez; ekran okuyucu kullanıcıları bu iki denetimin ne
                yaptığını anlayamıyordu. */}
            <input type="range" min="0.8" max="1.4" step="0.05" value={fontScale}
              aria-label="Yazı tipi ölçeği"
              onChange={(e) => setTweak('fontScale', parseFloat(e.target.value))}
              style={{ flex: 1, accentColor: 'var(--accent)' }} />
            <span className="tabular" style={{ fontSize: 13, fontWeight: 600, minWidth: 44, textAlign: 'right' }}>%{pct}</span>
          </div>
        </div>

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

        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>
            <Icons.Dashboard size={14} /><span>Çalışma alanı</span>
          </div>
          <div className="card-sub">Başlangıç ve görünüm davranışı.</div>

          <SettingsRow title="Açılış sayfası" desc="Kapsamlı kip açıldığında gösterilecek sayfa.">
            <select className="set-select" aria-label="Açılış sayfası" value={t.landingView || 'ozet'} onChange={(e) => setTweak('landingView', e.target.value)}>
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

          <div className="set-sep" />

          {/* Tarih biçimi daha önce koda gömülüydü; kurumsal alışkanlığa göre
              seçilebilmesi gerekir.

              Sözleşme, DÜZENLENEBİLİR tarih alanlarını da kapsar: `DateInput`
              seçilen biçime göre `formatEditableDate()`/`maskDateDraft()`
              kullanır, yani "18 Ağu 2026" seçildiğinde giriş alanları da o
              biçimde görünür ve yazılır. Ayrıştırma her iki biçimi de kabul
              eder (bkz. components/dateInputFormat.js · parseDisplayDate), bu
              yüzden alışkın olunan gg/aa/yyyy yazımı hiçbir zaman reddedilmez.

              Grafik EKSENLERİ bu ayardan etkilenmez: eksen etiketi her zaman
              kısa biçimdedir (bkz. fmtAxisDate). */}
          <SettingsRow
            title="Tarih biçimi"
            desc="Gösterilen VE düzenlenen tarihlerin yazımını belirler; her iki biçimde yazılan giriş de kabul edilir. Grafik eksenleri her zaman kısa biçimi kullanır."
          >
            <Segmented
              value={t.dateFormat || 'dd/mm/yyyy'}
              onChange={(v) => setTweak('dateFormat', v)}
              options={[['dd/mm/yyyy', 'gg/aa/yyyy'], ['pattern', '18 Ağu 2026']]}
            />
          </SettingsRow>

          <div className="set-sep" />

          <SettingsRow
            title="Yüksek karşıtlık"
            desc="Sınırları ve ikincil metni koyulaştırır; parlak ortamda ve açık temada okunabilirliği artırır."
          >
            <ToggleSeg value={!!t.highContrast} onChange={(v) => setTweak('highContrast', v)} />
          </SettingsRow>
        </div>

        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>
            <Icons.Help size={14} /><span>Uygulama</span>
          </div>
          <div className="card-sub">Yardım, kısayollar ve sıfırlama.</div>

          <SettingsRow title="Kip seçim ekranı" desc="Bir sonraki açılışta Temel / Kapsamlı Kip seçimini yeniden gösterir.">
            <button className="btn sm" type="button" onClick={resetModeChoice}>
              <Icons.Sparkle size={13} /> Tekrar göster
            </button>
          </SettingsRow>

          <div className="set-sep" />

          <SettingsRow title="Karşılama ekranı" desc="Kapsamlı kip tanıtım turunu yeniden gösterir.">
            <button className="btn sm" type="button" onClick={resetWelcome}>
              <Icons.Help size={13} /> Tekrar göster
            </button>
          </SettingsRow>

          <div className="set-sep" />

          <SettingsRow title="Komut paleti" desc="Kapsamlı kipte hızlı gezinme ve eylemler (Windows).">
            <span className="kbd-hint"><kbd>Ctrl</kbd><kbd>K</kbd></span>
          </SettingsRow>

          <div className="set-sep" />

          <SettingsRow title="Varsayılanlara dön" desc="Tema, kip, yoğunluk, yazı boyutu, renk ve tüm tercihleri sıfırlar.">
            <button className="btn sm" type="button" onClick={resetDefaults}>
              <Icons.Sparkle size={13} /> Sıfırla
            </button>
          </SettingsRow>
        </div>
      </div>
    </div>
  );
}
