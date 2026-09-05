'use client';
import { Icons } from '../icons';
import { AppLogo } from './AppLogo';

const MODES = [
  {
    id: 'simple',
    title: 'Temel Kip',
    kicker: 'Hızlı takip',
    icon: Icons.Calendar,
    description: 'Proje, görev, kısa açıklama, sorumlular ve termin tarihini tanımlayın; kayıtları doğrudan Takvim üzerinde izleyin.',
    points: ['Az alan, hızlı giriş', 'Takvim odaklı görünüm', 'Kapsamlı kipe sorunsuz geçiş']
  },
  {
    id: 'advanced',
    title: 'Kapsamlı Kip',
    kicker: 'Tam görev yönetimi',
    icon: Icons.Gantt,
    description: 'Mevcut MERGEN Rota deneyimini; WBS, Gantt, bağımlılıklar, Kanban, raporlar ve görev yönetimi araçlarıyla kullanın.',
    points: ['WBS ve bağımlılıklar', 'Gantt ve kritik yol', 'Raporlama ve portföy görünümü']
  }
];

export function ModeChooser({ onChoose }) {
  return (
    <div className="mode-picker-backdrop" role="presentation">
      <section className="mode-picker" role="dialog" aria-modal="true" aria-labelledby="mode-picker-title">
        <div className="mode-picker-head">
          {/* Ürün adı küçük bir üst etiket değil, pencerenin kimliğidir. */}
          <div className="mode-picker-brand">
            <AppLogo size={46} />
            <div className="mode-picker-wordmark">
              <span>MERGEN</span><strong>Rota</strong>
              <small>Görev Yönetimi</small>
            </div>
          </div>
          <h2 id="mode-picker-title">Nasıl çalışmak istersiniz?</h2>
          <p>İki kip da aynı veri altyapısını kullanır. Daha sonra Ayarlar sayfasından istediğiniz anda geçiş yapabilirsiniz.</p>
        </div>
        <div className="mode-picker-grid">
          {MODES.map((mode) => {
            const Icon = mode.icon;
            return (
              <button key={mode.id} type="button" className={`mode-picker-card mode-${mode.id}`} onClick={() => onChoose(mode.id)}>
                <span className="mode-picker-icon"><Icon size={22} /></span>
                <span className="mode-picker-copy">
                  <small>{mode.kicker}</small>
                  <strong>{mode.title}</strong>
                  <span>{mode.description}</span>
                </span>
                <span className="mode-picker-points">
                  {mode.points.map((point) => <span key={point}><Icons.Check size={12} /> {point}</span>)}
                </span>
                <span className="mode-picker-action">Bu kiple başla <Icons.ArrowRight size={14} /></span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
