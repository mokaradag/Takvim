# MERGEN Rota — Proje Yönetimi

Endüstriyel/kontrol paneli tarzında bir proje yönetimi uygulaması: Özet, Görevler, İş Kırılım Yapısı, Takvim, Gantt, Kanban, Raporlar, Ekip ve Ayarlar sayfaları. Next.js (App Router) ile derlenmiş bir React uygulaması; şu an için veriler istemci tarafında örnek (mock) veri olarak tutuluyor.

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
- `npm test` — Node.js yerleşik test çalıştırıcısıyla domain, scheduling ve saf state-selector testleri

### Test kapsamı

Mevcut testler yeni bir test framework'ü eklemeden Node.js'in yerleşik test çalıştırıcısını kullanır. Kapsam; domain selector ve ilişki normalizasyonu, WBS hiyerarşisi ve doğrulaması, workspace scoping, tarih ve çalışma günü aritmetiği, proje takvimleri, bağımlılık ilişkileri, Gantt zamanlama yardımcıları, profesyonel scheduling veri modeli, saf CPM/critical-path hesapları ve proje bazlı uygulama schedule projection davranışını doğrular.

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

- `src/domain` — Project, Task/Activity, Dependency, Person, WBS, Baseline ve scheduling calendar iş kavramları; WBS hiyerarşi/validasyon kuralları
- `src/scheduling` — tarih, proje takvimi, çalışma günü, bağımlılık, Gantt yardımcıları ve saf CPM/critical-path hesapları
- `src/data` — veri erişim sözleşmesi, legacy migration sınırı ve mevcut mock/in-memory adapter
- `src/state` — uygulama düzeyi state, Portfolio/Project Workspace seçimi, task/WBS işlemleri, workspace selector'ları ve proje bazlı türetilmiş CPM projection
- `src/features` — Özet, Görevler, İş Kırılım Yapısı, Takvim, Gantt, Kanban, Raporlar, Ekip, Ayarlar ve görev detayı
- `src/components/shell` — sidebar, workspace switcher, topbar, navigasyon, komut paleti ve global overlay bileşenleri
- `src/components/ui.jsx`, `src/components/ui-extras.jsx` — yeniden kullanılabilir görsel bileşenler
- `src/hooks` — görünüm tercihleri ve bunları DOM'a uygulayan hook'lar

Ayrıntılı bağımlılık kuralları için `docs/ARCHITECTURE.md`; Portfolio/Project Workspace ve WBS kuralları için `docs/WBS-AND-WORKSPACES.md`; profesyonel scheduling veri modeli için `docs/SCHEDULING-DATA-MODEL.md`; proje takvimi ve çalışma günü aritmetiği için `docs/SCHEDULING.md`; CPM motorunun giriş, ilişki, çıktı ve uygulama entegrasyonu sözleşmeleri için `docs/CPM.md` dosyasına bakın.

## Portfolio ve Project Workspace

MERGEN Rota artık iki açık çalışma bağlamına sahiptir:

- **Portföy · Tüm Projeler**: mevcut bütün-proje davranışını korur.
- **Proje Workspace**: seçili Project ID'sine göre Özet, Görevler, Takvim, Gantt, Kanban, Raporlar ve Ekip verilerini sınırlar.

Sidebar'daki workspace switcher kararlı `projectId` değerlerini kullanır. Son seçim `mergen-rota.workspace.v1` anahtarıyla yalnızca yerel bir UI tercihi olarak saklanır; geçersiz veya artık bulunmayan bir Project ID güvenli biçimde Portfolio moduna döner.

Project Workspace üst çubuğunda proje adıyla birlikte Data Date, proje takvimi ve mevcut CPM projection'dan hesaplanan proje bitişi gösterilir. Settings global kalır.

## WBS / İş Kırılım Yapısı

WBS artık gerçek, çok seviyeli ve keyfi derinliği destekleyen bir proje hiyerarşisidir. WBS düğümleri Project'e `projectId`, birbirlerine `parentId` ile bağlanır; Task ilişkisi `wbsId` üzerinden kurulur. Bir Task başka bir Project'e bağlı WBS düğümünü taşıyamaz.

WBS feature'ı hiyerarşiyi aç/kapat, alt WBS ekleme, yeniden adlandırma ve yalnızca güvenli boş düğümleri silme davranışlarını sunar. Alt düğümü veya doğrudan atanmış görevi bulunan WBS sessizce silinmez; görevler ya da alt hiyerarşi cascade-delete edilmez.

Project-mode Gantt'ın varsayılan görünümü WBS hiyerarşisidir. WBS özet satırları canonical Task değildir; descendant aktivitelerden türetilir ve summary bar'ları `plannedStart` ile `plannedFinish` güncel plan aralığını özetler. CPM ayrı bir proje-ağı projection'ı olarak kalır.

## Profesyonel scheduling veri modeli

Canonical görev modeli güncel planı (`plannedStart`, `plannedFinish`, `plannedDurationDays`), yönetim hedefini (`targetFinish`), gerçekleşen tarihleri (`actualStart`, `actualFinish`) ve bağımsız kalan süreyi (`remainingDurationDays`) birbirinden ayırır. Projeler ayrıca durum kesim tarihi olarak `dataDate` taşır.

Baz plan, mutable görev alanı değildir. `Baseline` ve `TaskBaselineSnapshot` nesneleriyle ayrı tarihsel snapshot verisi olarak tutulur; normal görev veya WBS güncellemeleri bu snapshot'ları değiştirmez ve sonradan oluşturulan görevler mevcut tarihsel baz plana otomatik eklenmez.

Eski `baslangicTarihi`, `bitisTarihi` ve `hedefTarih` alanları yalnızca tek bir veri migration sınırında canonical alanlara dönüştürülür. Feature ve scheduling kodu canonical alanları kullanır.

## CPM / Gantt entegrasyonu

CPM sonuçları uygulama state sınırında proje bazında hesaplanır ve Gantt tarafından türetilmiş veri olarak tüketilir. Birincil Gantt aktivite çubukları güncel planı (`plannedStart` -> `plannedFinish`) gösterir. CPM erken/geç tarihleri canonical Task nesnelerine yazılmaz.

Project Workspace, seçili projenin aynı CPM sonucunu tüketir; WBS başına ayrı CPM ağı hesaplanmaz. Geçersiz bir proje ağı diğer projelerin CPM sonuçlarını engellemez. Projeler arası bağımlılıklar bu aşamada açık bir `CROSS_PROJECT_DEPENDENCY` uyarısıyla reddedilir.

## Sonraki adım

Veriler şu an `src/data/mock` altındaki in-memory adapter üzerinden sağlanıyor. Kalıcı depolama için gerçek veritabanı/API adapter'ı daha sonra `src/data` sınırında eklenebilir.

WBS ve Project Workspace temelinden sonra önerilen sonraki odak, Task'ların WBS içinde taşınmasını ve büyük proje yapılarının yönetimini kolaylaştıran kontrollü reparent/bulk-move işlemlerini ayrı bir değişiklik olarak ele almaktır. Scheduling tarafındaki progress-aware çalışma da ayrı kalmalı; `dataDate`, actual tarihler ve `remainingDurationDays` kullanılarak durum güncelleme/rescheduling kuralları tanımlanırken mevcut saf current-plan CPM motorunun anlamı korunmalıdır.
