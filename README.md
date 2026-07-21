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
- `npm run lint` — Next.js/ESLint kod kalite kontrolü
- `npm test` — Node.js yerleşik test çalıştırıcısıyla domain ve scheduling saf fonksiyon testleri

### Test kapsamı

Mevcut testler yeni bir test framework'ü eklemeden Node.js'in yerleşik test çalıştırıcısını kullanır. İlk kapsam; domain selector ve ilişki normalizasyonu ile tarih, takvim, bağımlılık ve Gantt zamanlama hesaplarının temel davranışlarını doğrular.

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

- `src/domain` — Project, Task/Activity, Dependency, Person ve WBS iş kavramları
- `src/scheduling` — tarih, takvim, bağımlılık ve Gantt zamanlama hesapları
- `src/data` — veri erişim sözleşmesi ve mevcut mock/in-memory adapter
- `src/state` — uygulama düzeyi state, task işlemleri ve odaklı hook'lar
- `src/features` — Özet, Görevler, Takvim, Gantt, Kanban, Raporlar, Ekip, Ayarlar ve görev detayı
- `src/components/shell` — sidebar, topbar, navigasyon, komut paleti ve global overlay bileşenleri
- `src/components/ui.jsx`, `src/components/ui-extras.jsx` — yeniden kullanılabilir görsel bileşenler
- `src/hooks` — görünüm tercihleri ve bunları DOM'a uygulayan hook'lar

Ayrıntılı bağımlılık kuralları ve yeni kodun nereye eklenmesi gerektiği için `docs/ARCHITECTURE.md` dosyasına bakın.

## Sonraki adım

Veriler şu an `src/data/mock` altındaki in-memory adapter üzerinden sağlanıyor. Kalıcı depolama için gerçek veritabanı/API adapter'ı daha sonra `src/data` sınırında eklenmeli; bu PR gerçek bir veritabanı bağlantısı kurmaz.
