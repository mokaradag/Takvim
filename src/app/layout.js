import './globals.css';
import './enhancements.css';
import './fixes.css';

export const metadata = {
  title: 'MERGEN Rota — Proje Yönetimi',
  description: 'MERGEN Rota — Sürüm 1.0 endüstriyel proje yönetimi paneli: Özet, Görevler, Proje Yapısı, Takvim, Gantt, Kanban ve Raporlar.',
};

const FAVICON =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%234f8bf9'/><stop offset='1' stop-color='%232c5fd9'/></linearGradient></defs><rect width='32' height='32' rx='8' fill='url(%23g)'/><path d='M6 22V11l5 7 5-7v11' stroke='white' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round' fill='none'/><path d='M22 22V13' stroke='white' stroke-width='2.4' stroke-linecap='round' fill='none'/><circle cx='22' cy='10' r='1.8' fill='white'/></svg>";

export default function RootLayout({ children }) {
  return (
    <html lang="tr">
      <head>
        <link rel="icon" type="image/svg+xml" href={FAVICON} />
      </head>
      <body className="theme-dark">{children}</body>
    </html>
  );
}
