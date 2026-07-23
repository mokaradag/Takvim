# MERGEN Rota — Proje Yönetimi

Endüstriyel/kontrol paneli tarzında bir proje yönetimi uygulaması: Basit Modda hızlı görev/termin takibi; Gelişmiş Modda Özet, Görevler, İş Kırılım Yapısı, Takvim, Gantt, Kanban, Raporlar, Ekip ve Ayarlar sayfaları. Next.js (App Router) ile derlenmiş bir React uygulaması; uygulama verileri asenkron repository sözleşmesi üzerinden yüklenir ve mevcut çalışma zamanı adapter'ı başarılı Task/WBS değişikliklerini aktif repository örneği boyunca bellekte saklar.

## Yerel geliştirme

Gereksinim: Node.js 24 (üretim ve Quality CI: 24.14.0)

```bash
npm install
npm run dev
```

`http://localhost:3000` adresinde açılır.

### Diğer komutlar

- `npm run build` — üretim derlemesi
- `npm run start` — üretim sunucusunu başlatır (önce `build` gerekir)
- `npm run lint` — Next.js/ESLint kod kalite kontrolü
- `npm test` — Node.js yerleşik test çalıştırıcısıyla domain, scheduling, saf state-selector ve persistence-boundary testleri

### Test kapsamı

Mevcut testler yeni bir test framework'ü eklemeden Node.js'in yerleşik test çalıştırıcısını kullanır. Kapsam; domain selector ve ilişki normalizasyonu, WBS hiyerarşisi ve doğrulaması, workspace scoping, tarih ve çalışma günü aritmetiği, proje takvimleri, bağımlılık ilişkileri, Gantt zamanlama yardımcıları, profesyonel scheduling veri modeli, saf CPM/critical-path hesapları, proje bazlı uygulama schedule projection davranışı, Basit/Gelişmiş Mod sözleşmesi, proje kodu/çalışan numarası normalizasyonu ve asenkron repository yükleme/mutasyon/hata/atomicity sözleşmesini doğrular.

## Çalışma modları

MERGEN Rota aynı veri altyapısını kullanan iki arayüz modu sunar:

- **Basit Mod**: Kullanıcı proje, görev, anahtar sözcük/kısa açıklama, bir veya daha çok sorumlu ve termin tarihi tanımlar. Kayıt tek günlük plan aralığıyla mevcut Task modeline yazılır ve doğrudan mevcut **Takvim** sayfasında görünür.
- **Gelişmiş Mod**: Mevcut tam proje yönetimi deneyimidir. WBS, plan/gerçekleşen tarihler, iş gücü, bağımlılıklar, CPM/kritik yol, Kanban, raporlar ve portföy araçları kullanılabilir.

İlk açılışta kullanıcıdan çalışma modu seçmesi istenir. Seçim yerel bir arayüz tercihidir ve **Ayarlar** sayfasındaki modern mod kartlarından daha sonra değiştirilebilir. Mod değişikliği görev veya proje verisini silmez ya da ayrı bir kopyaya taşımaz. Basit Modda oluşturulan kayıtlar Gelişmiş Modda açılarak ayrıntılandırılabilir.

Basit Modda yeni bir anahtar sözcük girildiğinde, seçili projenin etiket kataloğunda yoksa proje kataloğuna eklenir. Böylece Gelişmiş Moda geçildiğinde görev, mevcut kontrollü etiket yaklaşımıyla uyumlu kalır.

## Proje kodu ve kurumsal veri hazırlığı

Canonical proje modeli artık isteğe bağlı `code` ve `source` alanlarını taşır. Kurumsal veritabanı entegrasyonunda aşağıdaki alanlar doğrudan normalize edilebilir:

- `ProjeKodu` → `Project.code`
- `ProjeAdi` → `Project.name`

Kurumsal listeden gelen projeler `source: "corporate"`, kullanıcı tarafından uygulama içinde tanımlanan serbest projeler `source: "manual"` olarak tutulabilir. Proje kodu kurumsal projeler için doğal anahtar olarak gösterilebilir; serbest proje tanımında boş bırakılabilir. Aynı dolu proje kodunun iki projede kullanılması domain doğrulamasında engellenir.

Kişi modeli `employeeNo` alanını destekler. Normalizasyon sınırı ayrıca `SicilNo`, `PersonelNo` ve `CalisanNo` gibi yaygın alan adlarını `employeeNo` alanına eşleyebilir. Basit Mod sorumlu seçiminde çalışan adı ile çalışan numarası birlikte gösterilir. Task kayıtları mevcut `assigneeIds` ve `sorumlu` alanlarını koruduğu için veritabanı entegrasyonunda kararlı çalışan kimliği ile kullanıcıya gösterilen ad birbirinden ayrılabilir.

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
- `src/data` — asenkron veri erişim sözleşmesi, legacy migration sınırı ve mevcut mutable async in-memory adapter
- `src/state` — uygulama düzeyi state, asenkron yükleme/reload yaşam döngüsü, sıralı persistence orchestration, Portfolio/Project Workspace seçimi, Task/WBS işlemleri ve proje bazlı türetilmiş CPM projection
- `src/features/simple` — Basit Mod hızlı proje/görev/termin giriş akışı
- `src/features` — Özet, Görevler, İş Kırılım Yapısı, Takvim, Gantt, Kanban, Raporlar, Ekip, Ayarlar ve görev detayı
- `src/components/shell` — sidebar, workspace switcher, çalışma modu seçicisi, topbar, navigasyon, komut paleti, loading/error sınırı, persistence durumu ve global overlay bileşenleri
- `src/components/ui.jsx`, `src/components/ui-extras.jsx` — yeniden kullanılabilir görsel bileşenler
- `src/app/styles` — kronolojik düzeltme katmanları yerine shell, Dashboard, shared components, feature layout, Basit Mod ve deneyim yüzeyleri için sorumluluk tabanlı stil sahipliği
- `src/hooks` — görünüm tercihleri ve bunları DOM'a uygulayan hook'lar

Ayrıntılı bağımlılık kuralları için `docs/ARCHITECTURE.md`; UI/stil sahipliği için `docs/UI-STYLING-ARCHITECTURE.md`; tekrarlanabilir elle görsel doğrulama için `docs/VISUAL-SMOKE-TESTS.md`; asenkron yükleme ve persistence semantics için `docs/PERSISTENCE-BOUNDARY.md`; Portfolio/Project Workspace ve WBS kuralları için `docs/WBS-AND-WORKSPACES.md`; profesyonel scheduling veri modeli için `docs/SCHEDULING-DATA-MODEL.md`; proje takvimi ve çalışma günü aritmetiği için `docs/SCHEDULING.md`; CPM motorunun giriş, ilişki, çıktı ve uygulama entegrasyonu sözleşmeleri için `docs/CPM.md` dosyasına bakın.

## Portfolio ve Project Workspace

MERGEN Rota iki açık çalışma bağlamına sahiptir:

- **Portföy · Tüm Projeler**: mevcut bütün-proje davranışını korur.
- **Proje Workspace**: seçili Project ID'sine göre Özet, Görevler, Takvim, Gantt, Kanban, Raporlar ve Ekip verilerini sınırlar.

Sidebar'daki workspace switcher kararlı `projectId` değerlerini kullanır. Son seçim `mergen-rota.workspace.v1` anahtarıyla yalnızca yerel bir UI tercihi olarak saklanır; geçersiz veya artık bulunmayan bir Project ID güvenli biçimde Portfolio moduna döner. Bu localStorage tercihi business-data repository'sinin parçası değildir.

Proje Workspace üst çubuğunda `Aktif Proje` gibi ek bir etiket kullanılmaz; proje kodu varsa **kod · proje adı**, yoksa yalnızca proje adı yatay ve dikey olarak üst çubuğun tam merkezinde gösterilir.

## WBS / İş Kırılım Yapısı

WBS gerçek, çok seviyeli ve keyfi derinliği destekleyen bir proje hiyerarşisidir. WBS düğümleri Project'e `projectId`, birbirlerine `parentId` ile bağlanır; Task ilişkisi `wbsId` üzerinden kurulur. Bir Task başka bir Project'e bağlı WBS düğümünü taşıyamaz.

WBS feature'ı hiyerarşiyi aç/kapat, alt WBS ekleme, yeniden adlandırma, kontrollü Task taşıma, güvenli subtree reparent ve yalnızca güvenli boş düğümleri silme davranışlarını sunar. Alt düğümü veya doğrudan atanmış görevi bulunan bir WBS sessizce silinmez; görevler ya da alt hiyerarşi cascade-delete edilmez. Bulk Task move ve WBS reparent değişiklikleri repository sınırına tek atomic change set olarak gider.

Project-mode Gantt'ın varsayılan görünümü WBS hiyerarşisidir. WBS özet satırları canonical Task değildir; descendant aktivitelerden türetilir ve summary bar'ları `plannedStart` ile `plannedFinish` güncel plan aralığını özetler. CPM ayrı bir proje-ağı projection'ı olarak kalır.

## Profesyonel scheduling veri modeli

Canonical görev modeli güncel planı (`plannedStart`, `plannedFinish`, `plannedDurationDays`), yönetim hedefini (`targetFinish`), gerçekleşen tarihleri (`actualStart`, `actualFinish`) ve bağımsız kalan süreyi (`remainingDurationDays`) birbirinden ayırır. Projeler ayrıca durum kesim tarihi olarak `dataDate` taşır.

Baz plan, mutable görev alanı değildir. `Baseline` ve `TaskBaselineSnapshot` nesneleriyle ayrı tarihsel snapshot verisi olarak tutulur; normal görev veya WBS güncellemeleri bu snapshot'ları değiştirmez ve sonradan oluşturulan görevler mevcut tarihsel baz plana otomatik eklenmez.

Eski `baslangicTarihi`, `bitisTarihi` ve `hedefTarih` alanları yalnızca tek bir veri migration sınırında canonical alanlara dönüştürülür. Feature ve scheduling kodu canonical alanları kullanır.

## CPM / Gantt entegrasyonu

CPM sonuçları uygulama state sınırında proje bazında hesaplanır ve Gantt tarafından türetilmiş veri olarak tüketilir. Birincil Gantt aktivite çubukları güncel planı (`plannedStart` -> `plannedFinish`) gösterir. CPM erken/geç tarihleri canonical Task nesnelerine yazılmaz ve repository'ye kaydedilmez.

Project Workspace, seçili projenin aynı CPM sonucunu tüketir; WBS başına ayrı CPM ağı hesaplanmaz. Geçersiz bir proje ağı diğer projelerin CPM sonuçlarını engellemez. Projeler arası bağımlılıklar bu aşamada açık bir `CROSS_PROJECT_DEPENDENCY` uyarısıyla reddedilir.

Gantt sayfası mevcut viewport yüksekliğini kullanır. Sayfanın kendisi yerine Gantt içeriği kendi `gantt-wrap` alanında dikey ve yatay kaydırılır. WBS satırlarında resmi tatil şeritleri özet satır arka planlarının üzerinde kalacak şekilde katmanlanır.

## Asenkron veri ve persistence sınırı

Uygulama state'i `loadSnapshot()` üzerinden asenkron olarak başlatılır. Task ve WBS mutasyonları feature katmanından repository implementation'ına doğrudan gitmez; state orchestration önce mevcut domain kurallarını uygular, mutasyonu sıralı olarak persist eder ve başarılı repository sonucuyla canonical state'i uzlaştırır.

Mevcut `src/data/mock` adapter'ı asenkron ve mutable bir in-memory adapter'dır. Başarılı değişiklikler aynı aktif repository örneğinde sonraki `loadSnapshot()` çağrılarında görülür. Bu davranış browser refresh, process/VM restart veya yeni repository örneği boyunca kalıcı değildir; gerçek veritabanı persistence'ı henüz uygulanmamıştır.

Task Detail'daki hızlı metin değişiklikleri kısa bir per-Task pencere içinde coalesce edilerek kontrolsüz bir persistence request-per-keypress akışı önlenir. Bulk WBS Task move ve subtree reparent tek atomic repository change set kullanır. Domain validation hataları ile repository/persistence hataları ayrı state kanallarında tutulur.

## Sonraki adım

UI/stil mimarisi, kronolojik patch katmanlarından sorumluluk tabanlı sahipliğe geçirilmiştir. Persistence-ready state/data boundary uygulamadadır. Önerilen sonraki büyük persistence adımı, aynı `AppRepository` sözleşmesini uygulayan gerçek client API adapter'ı ile Next.js server-side service ve SQL Server persistence katmanını eklemektir; tarayıcı SQL Server'a doğrudan bağlanmamalıdır.

İlk kurumsal adapter; proje tablosundaki `ProjeKodu`/`ProjeAdi` alanlarını canonical `code`/`name`, personel tablosundaki çalışan numarası/ad alanlarını `employeeNo`/`name` alanlarına eşlemelidir. Kullanıcı tarafından oluşturulan serbest projeler aynı repository sözleşmesi içinde farklı `source` değeriyle saklanabilir.

Progress-aware scheduling ayrı bir scheduling hattı olarak kalmalıdır. `dataDate`, actual tarihler ve `remainingDurationDays` kullanılarak durum güncelleme/rescheduling kuralları tanımlanırken mevcut saf current-plan CPM motorunun anlamı korunmalıdır.
