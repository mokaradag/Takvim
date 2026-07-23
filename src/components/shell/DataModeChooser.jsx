'use client';
import { Icons } from '../icons';

export function DataModeChooser({ onChoose }) {
  return (
    <div className="mode-picker-backdrop" role="presentation">
      <section className="mode-picker data-mode-picker" role="dialog" aria-modal="true" aria-labelledby="data-mode-picker-title">
        <div className="mode-picker-head">
          <div className="mode-picker-kicker">MERGEN Rota</div>
          <h2 id="data-mode-picker-title">Veri Modu</h2>
          <p>Örnek verileri veya kurumsal SQL Server üzerinde kalıcı Gerçek Sistem verilerini seçin. Bu seçim Basit/Gelişmiş kullanım modundan bağımsızdır.</p>
        </div>
        <div className="mode-picker-grid">
          <button type="button" className="mode-picker-card mode-simple" onClick={() => onChoose('demo')}>
            <span className="mode-picker-icon"><Icons.Sparkle size={22} /></span>
            <span className="mode-picker-copy"><small>İzole örnek veri</small><strong>Demo Modunu Aç</strong><span>Örnek verilerle uygulamanın tüm özelliklerini inceleyin. Demo kayıtları SQL Server&apos;a gönderilmez.</span></span>
            <span className="mode-picker-action">Demo ile başla <Icons.ArrowRight size={14} /></span>
          </button>
          <button type="button" className="mode-picker-card mode-advanced" onClick={() => onChoose('actual')}>
            <span className="mode-picker-icon"><Icons.Database size={22} /></span>
            <span className="mode-picker-copy"><small>Kurumsal ve kalıcı veri</small><strong>Gerçek Sisteme Geç</strong><span>Yetkili kurumsal projeler, çalışanlar ve kalıcı görev verileriyle çalışın.</span></span>
            <span className="mode-picker-action">Gerçek Sistemi aç <Icons.ArrowRight size={14} /></span>
          </button>
        </div>
      </section>
    </div>
  );
}
