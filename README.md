# MERGEN Rota — Proje Yönetimi

Endüstriyel/kontrol paneli tarzında bir proje yönetimi uygulaması: Özet, Görevler, Takvim, Gantt, Kanban, Raporlar, Ekip ve Ayarlar sayfaları. Next.js (App Router) ile derlenmiş bir React uygulaması; şu an için veriler istemci tarafında örnek (mock) veri olarak tutuluyor.

## Yerel geliştirme

Gereksinim: Node.js 18+

```bash
npm install
npm run dev
```

`http://localhost:3000` adresinde açılır.

### Diğer komutlar

- `npm run build` — üretim derlemesi
- `npm run start` — üretim sunucusunu başlatır (önce `build` gerekir)
- `npm run lint` — Next.js lint kontrolü

## Yapı

- `src/app` — Next.js App Router giriş noktaları (`layout.js`, `page.js`, `globals.css`)
- `src/components` — UI bileşenleri ve sayfa görünümleri (`AppShell`, `views-a`, `views-b`, `settings`, `ui`, `ui-extras`, `icons`)
- `src/lib` — örnek veri, tarih yardımcıları, sabitler (`data.js`, `tweaks-defaults.js`, `zoom.js`)
- `src/hooks` — `useTweaks` (tema/yoğunluk/aksan/yazı boyutu tercihlerini `localStorage`'da saklar)

## Sonraki adım

Veriler şu an `src/lib/data.js` içinde statik örnek veri olarak tanımlı. Kalıcı depolama için bir veritabanı/API entegrasyonu planlanıyor.
