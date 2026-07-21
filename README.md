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

## On-prem / internet erişimi olmayan ortam

Uygulamanın çalışma zamanı dış internet bağlantısına gereksinim duymaz. Arayüz, harici Google Fonts çağrısı yapmadan işletim sistemindeki yerel font yığınını kullanır.

Bağımlılıklar daha önce kurulmuşsa üretim derlemesi ve sunucu çevrimdışı çalıştırılabilir:

```bash
npm run build
npm run start -- -H 0.0.0.0 -p 3000
```

İlk `npm ci` veya `npm install` işlemi için paketlerin npm kayıt sunucusundan ya da kurum içi bir npm proxy/registry sunucusundan erişilebilir olması gerekir.

Windows üzerinde UNC ağ dizinine geçmek için örnek:

```cmd
pushd "\\rehisds\uygulamalar\Primavera\PYB\08 - MERGEN Rota"
npm run build
npm run start -- -H 0.0.0.0 -p 3000
```

Next.js telemetri bildirimi bir hata değildir. İstenirse yerel kurulumda şu komutla devre dışı bırakılabilir:

```bash
npx next telemetry disable
```

`npm warn Unknown user config "disturl"` uyarısı uygulama kodundan değil, çalıştırılan Windows hesabının npm kullanıcı yapılandırmasından kaynaklanır. Uygulamanın derlenmesini veya çalışmasını engellemez; gerekli görülürse ilgili npm yapılandırması sistem yöneticisi tarafından ayrıca düzenlenmelidir.

## Yapı

- `src/app` — Next.js App Router giriş noktaları (`layout.js`, `page.js`, `globals.css`)
- `src/components` — UI bileşenleri ve sayfa görünümleri (`AppShell`, `views-a`, `views-b`, `settings`, `ui`, `ui-extras`, `icons`)
- `src/lib` — örnek veri, tarih yardımcıları, sabitler (`data.js`, `tweaks-defaults.js`, `zoom.js`)
- `src/hooks` — `useTweaks` (tema/yoğunluk/aksan/yazı boyutu tercihlerini `localStorage`'da saklar)

## Sonraki adım

Veriler şu an `src/lib/data.js` içinde statik örnek veri olarak tanımlı. Kalıcı depolama için bir veritabanı/API entegrasyonu planlanıyor.
