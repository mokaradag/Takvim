import './globals.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/dashboard.css';
import './styles/features.css';
import './styles/simple-mode.css';
import './styles/experience.css';
import { TWEAKS_BOOTSTRAP_SCRIPT } from '../lib/tweaksBootstrap.js';

export const metadata = {
  title: 'MERGEN Rota — Görev Yönetimi',
  description: 'MERGEN Rota — Sürüm 1.0 endüstriyel görev yönetimi paneli: Özet, Görevler, Proje Yapısı, Takvim, Gantt, Kanban ve Raporlar.',
};

const FAVICON =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%234f8bf9'/><stop offset='1' stop-color='%232c5fd9'/></linearGradient></defs><rect width='32' height='32' rx='8' fill='url(%23g)'/><path d='M6 22V11l5 7 5-7v11' stroke='white' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round' fill='none'/><path d='M22 22V13' stroke='white' stroke-width='2.4' stroke-linecap='round' fill='none'/><circle cx='22' cy='10' r='1.8' fill='white'/></svg>";

export default function RootLayout({ children }) {
  return (
    <html lang="tr">
      <head>
        <link rel="icon" type="image/svg+xml" href={FAVICON} />
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
