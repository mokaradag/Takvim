import './globals.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/dashboard.css';
import './styles/features.css';
import './styles/reports.css';
import './styles/system-admin.css';
import './styles/simple-mode.css';
import './styles/experience.css';
import { TWEAKS_BOOTSTRAP_SCRIPT } from '../lib/tweaksBootstrap.js';
import { APP_FAVICON_DATA_URI, APP_FAVICON_PNG_DATA_URI } from '../lib/appFavicon.js';

export const metadata = {
  title: 'MERGEN Rota — Görev Yönetimi',
  description: 'MERGEN Rota — Sürüm 1.0 endüstriyel görev yönetimi paneli: Özet, Görevler, Proje Yapısı, Takvim, Gantt, Kanban ve Raporlar.',
};

// Pusula markası; ürün kimliğiyle aynı biçim (bkz. lib/appFavicon.js).
const FAVICON = APP_FAVICON_DATA_URI;
const FALLBACK_ICON = APP_FAVICON_PNG_DATA_URI;

export default function RootLayout({ children }) {
  return (
    <html lang="tr">
      <head>
        <link rel="icon" type="image/svg+xml" href={FAVICON} />
        {/* SVG desteği olmayan istemciler ve iOS ana ekranı raster yedeği kullanır. */}
        <link rel="alternate icon" type="image/png" href={FALLBACK_ICON} />
        <link rel="apple-touch-icon" href={FALLBACK_ICON} />
      </head>
      <body className="theme-dark">
        {/* Erişilebilirlik ve hareket tercihleri, uygulama paketi çalışmadan
            ÖNCE gövdeye yazılır (bkz. lib/tweaksBootstrap.js). Aksi hâlde
            yüksek karşıtlık ve "Hareketi azalt" ancak AppShell monte edildikten
            sonra devreye giriyor, ondan önceki uzun ömürlü ekranlarda tercih
            yok sayılıyordu. */}
        <script dangerouslySetInnerHTML={{ __html: TWEAKS_BOOTSTRAP_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
