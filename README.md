# MERGEN Rota — Görev Yönetimi

Endüstriyel/kontrol paneli tarzında bir görev yönetimi uygulaması: Temel Kipte hızlı görev/termin takibi; her iki kipte Talepler ve komut arama; Kapsamlı Kipte Özet, Görevler, İş Kırılım Yapısı, Takvim, Gantt, Kanban, Raporlar, Ekip ve Ayarlar sayfaları. Next.js App Router ve React kullanır.

MERGEN Rota artık iki tümüyle yalıtılmış **Veri Kipi** sunar:

- **Demo Kipi** — mevcut zengin örnek veri kümesini kullanan, asenkron ve kalıcı olmayan bellek repository'si. Demo kayıtları SQL Server'a veya Gerçek Sistem API'sine gönderilmez.
- **Gerçek Sistem** — tarayıcıdaki API repository'sinden Next.js sunucu katmanına, sunucu tarafı yetkilendirmeye ve SQL Server repository'sine giden kalıcı üretim veri yolu. Tarayıcı SQL Server'a hiçbir zaman doğrudan bağlanmaz.

Veri Kipi, **Temel Kip / Kapsamlı Kip** kullanım seçiminden bağımsızdır. Veri Kipi değiştiğinde application-state provider yeniden kurulur; Demo ve Gerçek Sistem snapshot'ları birleştirilmez. Demo etkin olduğunda sürekli görünen `DEMO` göstergesi vardır.

## Otomatik veri yenileme

Gerçek Sistem verisi, sekme görünürken varsayılan olarak **60 saniyede bir** uygulamanın mevcut `reloadData()`/snapshot yaşam döngüsüyle yenilenir. Bu bir tarayıcı sayfası yenilemesi değildir: çalışma alanı, arama, görev tablosu süzgeçleri ve Direktörlük/Müdürlük/Birim seçimi korunur; seçili proje ile açık görev çekmecesi ise dayandıkları kayıtlar yetkili snapshot'ta geçerli kaldığı sürece korunur. Proje artık geçerli değilse Portföy kipine dönülür, seçili görev artık geçerli değilse çekmece kapatılır. Eşdeğer snapshot'larda değişmeyen nesne ve koleksiyon referansları yeniden kullanılır. Yenilenen yetkili kişi/görev projeksiyonunda kurumsal yol gerçekten kaybolmuşsa yalnızca geçersiz alt seçim en yakın geçerli üst kapsama indirilir. Manuel yenileme denetimi de kullanılabilir durumda kalır.

Aralık, gizli olmayan ve derleme sırasında istemci paketine gömülen `NEXT_PUBLIC_MERGEN_ROTA_AUTO_REFRESH_INTERVAL_MS` değişkeniyle ayarlanır. Varsayılan `60000`, izin verilen en küçük değer `30000` milisaniyedir. Eksik, boş, sayısal olmayan, sıfır, negatif, alt sınırdan küçük veya tarayıcı zamanlayıcı sınırını aşan değerler güvenli biçimde `60000` değerine döner; değişiklikten sonra üretim paketi yeniden derlenmelidir.

Gizli sekmede periyodik yoklama durur. Sekmeye dönüldüğünde veri aralık kadar eskimişse hemen yenilenir; değilse kalan süre beklenir. Tek-uçuş denetimi otomatik ve manuel yenilemelerin üst üste binmesini önler. Otomatik tur sürerken başlatılan manuel yenileme, arka plan sonucuna katılmak yerine turun hemen arkasına tek kez alınır; böylece manuel isteğin yükleme ve hata durumu görünür kalır. Otomatik yenileme önce bekleyen yazmaları mevcut sıralı persistence kuyruğuyla tamamlar; çözülememiş başarısız görev yaması varsa yenilemeyi sessizce atlar ve yerel düzenlemeyi hiçbir zaman otomatik olarak silmez. Geçici arka plan bağlantı hataları mevcut veriyi kullanılamaz hâle getirmez; oturum/kimlik hataları mevcut uygulama akışında işlenmeye devam eder.

Demo Kipi bellek içi depoya karşı otomatik yoklama yapmaz. Her otomatik tur normal snapshot ucunu kullanır; istemci ayrı bir CN43N eşitlemesi başlatmaz. Kurumsal WBS eşitlemesi bağımsız `MERGEN_ROTA_WBS_SYNC_TTL_MS` penceresi, tek-uçuş kilidi ve içerik parmak iziyle korunmaya devam eder; 60 saniyelik veri yenilemesi CN43N'yi 60 saniyede bir zorla eşitlemez.

## Yerel geliştirme

Gereksinim: Node.js 24 (üretim ve Quality CI: 24.14.0)

```bash
npm install
npm run dev
```

`http://localhost:8008` adresinde açılır. MERGEN Rota **8008** portunu kullanır; **8009** portu ayrı bir uygulama olan MERGEN Bilge'ye aittir.

### Diğer komutlar

- `npm run build` — üretim derlemesi
- `npm run start:prod` — üretim sunucusunu `0.0.0.0:8008` üzerinde başlatır
- `npm run start` — üretim sunucusunu varsayılan ayarlarla başlatır (`npm run start -- -H 0.0.0.0 -p 8008`)
- `npm run lint` — Next.js/ESLint kod kalite kontrolü
- `npm test` — domain, scheduling, state, persistence, SQL şeması ve yetkilendirme regresyon testleri

## Veri Kipi ve kullanım kipleri

İlk Veri Kipi seçiminde kullanıcı **Demo Kipini Aç** veya **Gerçek Sisteme Geç** seçeneklerinden birini seçer. Gerçek Sistem yüklenemezse Demo'ya sessiz dönüş yapılmaz; veritabanı, kimlik veya yetki hatası açıkça gösterilir ve Demo'ya dönüş kullanıcı kararıyla gerçekleşir.

Gerçek Sistem seçildiğinde application-state provider kurulmadan önce kurumsal oturum denetlenir. Oturum yoksa kullanıcı doğrudan seçili Keycloak akışına yönlendirilir; uygulama içinde ayrıca `Oturum açmanız gerekiyor` kutusu gösterilmez.

Kullanım kipleri aynı seçili veri kaynağı üzerinde çalışır:

- **Temel Kip**: Proje, görev, anahtar sözcük, sorumlu, öncelik ve termin tarihiyle hızlı giriş; sütun filtreli sadeleştirilmiş **Görevler** listesi ve termin günü Takvim takibi. İlerleme, başlangıç tarihleri, bağımlılıklar ve ileri planlama alanları Temel Kipte gösterilmez.
- **Kapsamlı Kip**: WBS, bağımlılıklar, güncel plan/hedef/gerçekleşen tarihler, Gantt, CPM, Kanban, raporlar ve portföy araçları.

Her iki kipin **Görevler** ve **Takvim**, ayrıca Kapsamlı Kipin **Kanban** araç çubuğunda Ekip sayfasıyla aynı kararlı kurumsal yol semantiğini kullanan **Direktörlük → Müdürlük → Birim** süzgeçleri bulunur. Süzgeç, görevin oluşturucusuna veya proje sorumlusuna değil görev sorumlularına bakar; çok sorumlulu görevde en az bir sorumlunun seçili kapsamda olması yeterlidir. Bu yalnızca istemci tarafı daraltmadır: önce sunucunun yetkilendirdiği snapshot ve seçili çalışma alanı/proje uygulanır, kurumsal seçim bunlara yeni görev veya kişi ekleyemez. Temel/Kapsamlı Kip ile Görevler/Kanban/Takvim geçişleri aynı oturum içindeki kurumsal seçimi paylaşır. Kanban araması görev, proje adı/kodu, sorumlu, etiket ve öncelikle kurumsal seçimi birlikte uygular; sütun sayıları süzülmüş görevleri sayar. Filtreleri temizle aramayı ve kurumsal seçimi sıfırlar.

Planlanan/gerçekleşen saat alanları veritabanı ve API uyumluluğu için korunur ancak normal uygulama arayüzünde hiçbir kipte gösterilmez; kullanıcı ilerlemeyi `İlerleme` üzerinden izler.

## Durable SQL Server mimarisi

```text
Browser / MERGEN Rota UI
  → state actions and ordered persistence orchestration
  → client-side API AppRepository
  → Next.js Node API/service layer
  → CurrentUserProvider
  → authorization service
  → SQL Server AppRepository
  → SQL Server
```

SQL bağlantısı yalnızca `src/server` altında bulunur. Feature, client component ve state hook'ları `mssql`, bağlantı kodu veya SQL sorgusu import etmez. SQL Server sürücüsü yerel npm bağımlılığıdır; çalışma zamanı dış internete gereksinim duymaz.

Actual-mode API uçları:

- `GET /api/mergen-rota/auth/status` — SQL'e gitmeden kurumsal oturumun varlığını denetler
- `GET /api/mergen-rota/session`
- `GET /api/mergen-rota/snapshot`
- `POST /api/mergen-rota/commit`

Her yazma işlemi sunucuda yeniden yetkilendirilir ve bir `commitChanges()` çağrısı tek SQL transaction olarak uygulanır. SQL Server `rowversion` değerleri Base64 opaque version token'ları olarak taşınır; stale update/delete `CONFLICT` / HTTP 409 döndürür.

## Kurumsal veri kaynakları

MERGEN Rota şu kurumsal tabloları yalnızca okur:

- `HR02_rehisRehberwithMasrafYeri` — çalışan ve organizasyon kaynağı. İş kimliği `sicil` değeridir; ayrı `MR_People` veya `MR_Employees` tablosu oluşturulmaz.
- `A01_ProjeUrunFaaliyetRaporu` — kurumsal Proje kataloğu. Yalnızca `Tur`, `Tur_Aciklama`, `ProjeKodu`, `ProjeAdi` seçilir ve sorgu bu dört alanla `GROUP BY` kullanır.
- `HR09_projeSorumlu` — kurumsal Proje FULL erişimi. `pptcSicil` virgülle ayrılmış değerleri `STRING_SPLIT`, trim ve `TRY_CONVERT(int, ...)` ile tam token olarak ayrıştırılır; `LIKE '%sicil%'` kullanılmaz.

Kurumsal Project kodu/adı/türü sunucu tarafından yönetilir. Senkronizasyon eksik kayıtları `MR_Projects` içine ekler, kök WBS oluşturur, kaynak alanları değiştiğinde günceller, uygulama metadata'sını korur ve kaynakta geçici olarak kaybolan kaydı silmek yerine pasif yapar.

### Kurumsal iş dağılım ağacı: `CN43N`

Kurumsal projelerin İş Dağılım Ağacı MERGEN Rota içinde tanımlanmaz; **farklı bir veritabanında** bulunan `CN43N` tablosundan eşitlenir. Bu nedenle ikinci bir bağlantı tanımı gerekir (`.env.example` içindeki `MERGEN_ROTA_WBS_DB_*` bloğu). Eşleştirme `Proje tanımı` kolonu ile proje kodu üzerinden yapılır; `WBS element`, `Name`, `Level`, `Status`, `PYP kodu` ve `Proj.type` kolonları kullanılır, `Kontrol kodu` ile planlanan tarih kolonları kullanılmaz.

Yapı uygulama üzerinden değiştirilemez: hem arayüz hem sunucu kurumsal WBS yazma girişimlerini reddeder. Görevlerin bu düğümlere atanması ve düğümler arasında taşınması mümkündür. Bağlantı tanımlanmazsa eşitleme atlanır ve kurumsal projeler yalnızca kök düğümle görünür; kaynak erişilemezse veri yüklemesi kurumsal WBS olmadan sürer. Ayrıntılar: `docs/WBS-AND-WORKSPACES.md`.

Eşitleme her istekte baştan çalışmaz. Proje başına içerik parmak izi `MR_CorporateWbsSyncState` tablosunda tutulur; kaynak değişmediğinde `MR_WBS` birleştirmesi hiç yapılmaz. Ayrıca `MERGEN_ROTA_WBS_SYNC_TTL_MS` (varsayılan 5 dakika) süresince kurumsal kaynak yeniden okunmaz ve eşzamanlı istekler tek bir eşitlemeyi paylaşır. Bu iki katman olmadan 38 bin satırlık kurulumda tek bir açılış isteği 30 saniyeyi aşıyordu.

## Yetkilendirme

Öncelik sırası:

1. `SYSTEM_ADMIN`
2. Proje bazlı `FULL` (kurumsal sorumluluk, açık erişim veya etkin manuel proje sorumluluğu)
3. Yönetici alt-organizasyon görünürlüğü (`PARTIAL`, salt okunur)
4. Kendi atandığı görevler (`PARTIAL`, yalnızca o görevin iş alanlarını düzenleyebilir; görevi tanımlayan kişi künyesi görünür)
5. Varsayılan ret

**Görev atama kapsamı** görünürlükten ayrı bir kavramdır. Müdür, direktör ve takım liderleri (HR02'den türeyen mevcut `isExecutive` soyutlaması; koda gömülü kullanıcı listesi yoktur) yeni görev tanımlarken proje seçicisinde **tüm etkin CN43N kataloğunu** görür; böylece kendi personeline, kendisinde `corporateprojectaccess` bulunmayan bir kurumsal projede de iş atayabilir. Bu genişleme yalnızca seçime ve görev yazmasına açıktır: görev görünürlüğü, proje üst verisi, iş dağılım ağacı ve yönetici işlevleri değişmez ve sunucu her atananın `MR_V_ExecutiveScope` içinde olmasını arar. Sıradan kullanıcının seçicisi eskisi gibi yalnızca kendi `corporateprojectaccess` projeleridir. Ayrıntılar: `docs/AUTHORIZATION-MODEL.md`.

`MR_UserRoles` oluşturma betiği sistem yöneticilerini parametreli tohumlar: kurulumdan önce `@SystemAdminSicils` değişkenine virgülle ayrılmış Sicil listesi yazılır. Gerçek Sicil değerleri kişisel veridir ve depoya işlenmez. HR09 sorumlulukları kurumsal FULL erişim sağlar. Manuel açık erişimler `MR_ProjectAccess` içinde tutulur. Sistem yöneticileri ile HR02'de dinamik olarak yönetici görünen kullanıcılar manuel Project oluşturabilir; Project, kök WBS, oluşturucu için FULL OWNER erişimi ve audit kayıtları aynı transaction içinde oluşturulur. Seçilen manuel Proje sorumlusu ayrıca türetilmiş FULL erişim alır; bu erişim lead değişikliğini izler ve bağımsız erişim kayıtlarını silmez.

SYSTEM_ADMIN yalnızca hiç Task kaydı olmayan manuel bir Projecti kaldırabilir. İşlem projeyi ve etkin erişimlerini pasifleştirir, audit/WBS geçmişini korur; kurumsal/CN43N projeleri bu yolla silinemez.

PARTIAL görünürlük tam Project yönetim yetkisi vermez. Kısmi Task ağı üzerinde yanıltıcı CPM/critical-path hesaplanmaz; Project scheduling sonucu `suppressed-partial` olarak işaretlenir.

## Kimlik doğrulama (Keycloak)

Kimlik doğrulama **Keycloak** ile yapılır ve varsayılan kiptir (`MERGEN_ROTA_AUTH_MODE=keycloak`). Erişim jetonu tarayıcıda **saklanmaz**, sunucuda doğrulanır ve yalnızca doğrulanmış **Sicil** HttpOnly bir oturum çerezine yazılır.

Oturum açma akışı `MERGEN_ROTA_KEYCLOAK_FLOW` ile **açıkça** seçilir; tanınmayan bir değer yapılandırma hatasıdır ve sessizce başka akışa düşülmez:

| Değer | Açıklama |
| --- | --- |
| `authorization-code` | **Varsayılan ve tercih edilen.** Authorization Code + PKCE. Kod → jeton takası sunucuda yapılır; jeton tarayıcıya hiç ulaşmaz. Keycloak istemcisi gizli (confidential) ise bu takas geçerli bir istemci kimlik doğrulaması gerektirir. |
| `implicit-bridge` | **Uyumluluk kipi.** Hâlihazırda implicit akışla çalışan bir Keycloak istemcisi için. Jeton endpoint'i kullanılmaz, istemci secret'ı gerekmez; jeton yine sunucuda tam olarak doğrulanır. |

- `GET /api/mergen-rota/auth/status` — HttpOnly MERGEN Rota oturumunu kişisel alanları açmadan denetler
- `GET /api/mergen-rota/auth/login` — seçili akışa göre Keycloak'a yönlendirir
- `GET /api/mergen-rota/auth/callback` — (yalnızca Authorization Code) kodu sunucuda jetonla takas eder, doğrular, oturum çerezini yazar
- `GET /auth/implicit-callback` — (yalnızca implicit köprü) URL parçasını okuyup **hemen silen** küçük geri dönüş sayfası
- `POST /api/mergen-rota/auth/implicit-session` — (yalnızca implicit köprü) imzalı işlem çerezi + `state` + `Bearer` jetonunu doğrulayıp HttpOnly oturuma çevirir
- `POST /api/mergen-rota/auth/session` — genel uyumluluk ucu: `Authorization: Bearer` jetonunu doğrulayıp HttpOnly oturuma çevirir
- `POST|GET /api/mergen-rota/auth/logout` — MERGEN Rota oturumunu kapatır ve Keycloak `end_session` adresine yönlendirir

Gerçek Sistem açılışında tarayıcı önce `auth/status` ucunu çağırır. Yanıt `authenticated: false` ise `auth/login?returnTo=<uygulama-kökü>` adresine `location.replace` ile geçilir. Böylece korunan `session` ve `snapshot` uçları oturum oluşmadan çağrılmaz; geri düğmesi de eski oturumsuz sayfaya yönlendirme döngüsü oluşturmaz.

Implicit köprüde erişim jetonu tarayıcıya kısa süreliğine URL parçasında ulaşır; parça `history.replaceState` ile derhâl silinir, jeton `localStorage`/`sessionStorage`/`IndexedDB`/çerez veya sorgu dizesinde **saklanmaz** ve yalnızca tek bir POST isteğiyle sunucuya gönderilir. Sunucu tarafındaki JWT ve Sicil doğrulaması her iki akışta da **aynıdır**.

Güvenilen kimlik yalnızca doğrulanmış `sicil` claim'idir. Claim yoksa isteğe bağlı olarak `preferred_username → HR02 kurumsal kullanıcı adı → Sicil` çözümü yapılır; sonuç tekil değilse **UNAUTHORIZED** döner. Keycloak `resource_access` rollerinden MERGEN Rota SYSTEM_ADMIN yetkisi **türetilmez**.

Sicil; istek gövdesi, sorgu dizesi, tarayıcı başlığı, localStorage veya görüntüleme alanlarından kabul edilmez. Kimlik yoksa yönetici, Demo veya geliştirme kimliğine sessizce düşülmez.

Yerel geliştirme kimliği yalnızca `MERGEN_ROTA_AUTH_MODE=development` **ve** `MERGEN_ROTA_DEV_IDENTITY_ENABLED=true` birlikte verildiğinde çalışır; varsayılan olarak kapalıdır. Geliştirme kimliği bir üretim yedeği **değildir**: Keycloak akışı çalışmıyorsa çözüm yapılandırmayı düzeltmektir. Üretim HTTPS kullanmalı ve `MERGEN_ROTA_SESSION_COOKIE_SECURE=true` kalmalıdır.

Her iki akışta da sunucu realm JWKS ucundan imza anahtarlarını çeker; kurumsal kök sertifika gerekiyorsa Node başlatılmadan önce `NODE_EXTRA_CA_CERTS` ayarlanmalıdır.

Ayrıntılar, ortam değişkenleri, IT'nin kaydetmesi gereken adresler ve sorun giderme: [`docs/KEYCLOAK-SSO.md`](docs/KEYCLOAK-SSO.md). Otomatik açılış sınırı: [`docs/AUTOMATIC-AUTH-BOOTSTRAP.md`](docs/AUTOMATIC-AUTH-BOOTSTRAP.md).

## Kullanıcı fotoğrafları

Kurumsal fotoğraflar `<TABAN_URL>/<SICIL>.jpg` biçiminde üretilir. Taban adres `NEXT_PUBLIC_MERGEN_ROTA_USER_PHOTO_BASE_URL` değişkeninden okunur; tarayıcı tarafından istendiği için **sır değildir** ve istemci paketine gömülür. Gerçek adres yalnızca `.env.local` içinde tutulur ve depoya işlenmez.

Değer boşsa, sicil eksik/bozuksa veya görsel yüklenemezse tüm avatarlar baş harflere döner. Üretilen adres hiçbir tabloda saklanmaz; fotoğraf tamamen sunum verisidir ve başarısız bir görsel isteği kimlik doğrulamayı veya veri yüklemeyi engellemez.

## Veritabanı kurulumu

1. Hedef veritabanının yedeğini alın.
2. Yeni kurulumda `database/MR_Create_Durable_Persistence.sql` dosyasını çalıştırın. Mevcut kurulumda bunun yerine yükseltme betiklerini sırayla çalıştırın; güncel `database/MR_Upgrade_0010_Outlook_Calendar_Subscriptions.sql` sonrasında `database/MR_Upgrade_0011_Outlook_Completion_Lifecycle.sql` uygulanmalıdır. Mevcut çalışanları göçten önce durdurun. Yükseltme betikleri yeniden çalıştırılabilir ve var olan veriyi korur.
3. `.env.example` içindeki server-only SQL değişkenlerini yapılandırın (MERGEN Rota veritabanı ve isteğe bağlı `CN43N` kurumsal WBS veritabanı).
4. Keycloak istemcisini kaydedin ve `.env.local` içinde kimlik doğrulama değişkenlerini doldurun (bkz. `docs/KEYCLOAK-SSO.md`). Geçici geliştirme kimliği yalnızca yerel geliştirmede etkinleştirilir.
5. Outlook teslimatı veya elle/otomatik hatırlatma kullanılıyorsa SMTP zorunludur; en az geçerli `SMTP_HOST` ve `SMTP_FROM` ile `.env.local` içindeki SMTP bloğunu doldurun (`docs/TASK-REMINDERS.md`, `docs/OUTLOOK-CALENDAR.md`). Outlook çalışanı Node sunucusuyla otomatik başlar; OS zamanlayıcısı yalnız otomatik hatırlatma e-postaları için gereklidir.
6. `npm ci`
7. `npm run build`
8. `npm run start -- -H 0.0.0.0 -p 8008`
9. **Gerçek Sistem** seçerek yetki ve kalıcılığı doğrulayın.

Build aşamasında tüm MERGEN Rota nesnelerini kaldırmak için `database/MR_Rollback_Durable_Persistence.sql` çalıştırılabilir. **Bu işlem tüm MR_* uygulama verisini kalıcı olarak siler.** HR02, A01 ve HR09 tablolarına dokunmaz.

## On-prem / internet erişimi olmayan ortam

Uygulama çalışma zamanında CDN, uzak font, public API, uzak JavaScript veya uzak CSS gerektirmez. İlk `npm ci` işlemi için onaylı npm registry ya da kurum içi proxy gerekir; kurulmuş bağımlılıklar, Next.js sunucusu ve SQL Server erişimi tümüyle kurum içinde çalışır.

Windows UNC örneği:

```cmd
pushd "\\rehisds\uygulamalar\Primavera\PYB\08 - MERGEN Rota"
npm run build
npm run start -- -H 0.0.0.0 -p 8008
```

## Yapı

- `src/domain` — Project, Task, Dependency, Person, WBS, Baseline, etiket kataloğu, calendar kavramları ve Gerçek Sistem kimlik kuralları
- `src/scheduling` — tarih, çalışma günü, dependency, tekrar kuralları (RFC 5545) ve saf CPM hesapları
- `src/data` — AppRepository sözleşmesi, Demo adapter ve Actual API adapter
- `src/server` — server-only identity, authorization, SQL config/pool (MERGEN Rota + kurumsal WBS kaynağı), durable repository, SMTP taşıması (`mail`), hatırlatma servisi/zamanlayıcısı (`reminders`) ve Outlook takvim abonelikleri (`outlook`)
- `src/state` — yükleme, sıralı mutation queue, Task patch coalescing ve access-aware scheduling selector'ları
- `src/features` — uygulama özellikleri; SQL veya API route import etmez
- `src/components/shell` — application shell, sabitlenebilir/daraltılabilir kenar çubuğu, görünüm kontrolleri ve persistence durumları
- `src/lib/xlsx` — bağımlılıksız `.xlsx` ve ZIP yazıcısı (dışa aktarma çıktısı)
- `database` — deterministic create ve destructive rollback SQL betikleri

Ayrıntılar:

- `docs/KEYCLOAK-SSO.md`
- `docs/AUTOMATIC-AUTH-BOOTSTRAP.md`
- `docs/DURABLE-PERSISTENCE.md`
- `docs/DATABASE-SCHEMA.md`
- `docs/AUTHORIZATION-MODEL.md`
- `docs/ARCHITECTURE.md`
- `docs/PERSISTENCE-BOUNDARY.md`
- `docs/WBS-AND-WORKSPACES.md`
- `docs/SCHEDULING-DATA-MODEL.md`
- `docs/CPM.md`
- `docs/TAGS-AND-RECURRING-TASKS.md`
- `docs/TASK-REMINDERS.md`
- `docs/OUTLOOK-CALENDAR.md`
- `docs/SIMPLE-MODE-AND-UI.md`
- `docs/SCHEDULING.md`
- `docs/UI-STYLING-ARCHITECTURE.md`
- `docs/VISUAL-SMOKE-TESTS.md`

## Etiketler ve tekrarlayan görevler

Proje etiketleri ad, renk ve simge taşıyan kontrollü bir katalogdur; ad
değişikliği o etiketi kullanan görevlere taşınır. Tekrarlayan görevler RFC 5545
(iCalendar) `RRULE` altkümesiyle tanımlanır: kural seri şablonunda yaşar,
üretilen yinelemeler `recurrenceParentId` ile şablona bağlı sıradan görevlerdir.
Ayrıntılar: `docs/TAGS-AND-RECURRING-TASKS.md`.

## Görev ilişkileri ve öncelik

Bağımlılık kenarı **tek yerde** saklanır: ardılın `deps` listesinde. Görev
panelindeki *İlişkiler ve bağımlılıklar* bölümü aynı kenarı iki yönden düzenler —
*Öncüller* sekmesi görevin kendi listesini, *Ardıllar* sekmesi ise karşı görevin
listesini yamalar. Döngü oluşturacak seçimler listeye hiç girmez.

Görev önceliği (`Kritik` / `Yüksek` / `Orta` / `Düşük`) görev panelindeki
**Öncelik** bölümünden tanımlanır ve Görevler, Gantt, Kanban ile Raporlar risk
matrisini besler. Öncelik bir planlama kısıtı değildir; CPM sonuçlarını
etkilemez.

**Kilometre taşı** aynı panelin *Güncel plan* kartındaki anahtarla tanımlanır
(tam proje yetkisi gerekir): görev sıfır süreli tek bir güne indirgenir ve Gantt
görünümlerinde çubuk yerine eşkenar dörtgenle çizilir. Ayrıntılar:
`docs/SCHEDULING.md`.

## Dışa aktarma

Üst çubuktaki **Dışa aktar** menüsü üç çıktı sunar. Üçü de aynı sayfa
modelinden üretilir (`src/lib/exportProjectData.js`), böylece Excel ve CSV
içerikleri birbirinden ayrı düşmez:

| Çıktı | Dosya | İçerik |
| --- | --- | --- |
| **Excel çalışma kitabı** | `<ad>_Raporu.xlsx` | Özet, Görevler, İş Dağılım Ağacı ve portföy çıktısında Projeler sayfaları |
| **CSV paketi** | `<ad>_CSV.zip` | Aynı sayfaların her biri ayrı `.csv` dosyası (UTF-8 BOM) |
| **Görev listesi** | `<ad>_Gorevler.csv` | Tek dosyalık düz görev tablosu (veri aktarımı için) |

Excel çıktısı **gerçek bir `.xlsx` kabıdır**: başlık satırı dondurulmuş ve
otomatik süzgeçlidir, tarihler gerçek tarih, ilerleme gerçek yüzde hücresidir,
sütun genişlikleri içeriğe göre ayarlanır. Önceki sürüm `.xls` uzantılı bir HTML
tablosu yazdığı için Excel her açılışta "biçim ve uzantı eşleşmiyor" uyarısı
gösteriyordu. Yazıcı bağımlılıksızdır (`src/lib/xlsx`); çevrimdışı kurulumda ek
paket gerekmez. Her iki çıktıda da `=`, `+`, `-`, `@` ile başlayan metin formül
enjeksiyonuna karşı nötrlenir ve dışarı yalnızca ekranda da görülen alanlar
çıkar — iç kimlikler, sürüm anahtarları ve yetki alanları taşınmaz.

## Görev hatırlatma postaları

Her görev için sorumlularına hatırlatma e-postası gönderilebilir. İki akış vardır ve ikisi de aynı alıcı çözümleme, şablon işleme ve SMTP servisini kullanır:

- **Elle gönderim** — görev satırındaki ve görev panelindeki zarf düğmesi (Silme düğmesinin yanında, her iki kipte). Otomatik hatırlatmalar kapalıyken de çalışır, görevi değiştirmez ve yalnızca SMTP sunucusu iletiyi kabul ettiğinde başarı bildirir.
- **Otomatik gönderim** — yöneticinin belirlediği pencere (`kalan süre = termin - şimdi`, örn. 7 gün) ve sıklıkla (örn. 2 günde bir) sunucu tarafındaki zamanlayıcı üzerinden. Görev tamamlandığında, iptal edildiğinde, silindiğinde, otomatik gönderim kapatıldığında veya termin gününe ulaşıldığında durur; sınırsız gecikme postası gönderilmez.

Alıcılar sunucuda `MR_TaskAssignees.Sicil → MR_V_PeopleDirectory.Username → DC01_userr.Name → DC01_userr.EmailAddress` zinciriyle çözülür; tarayıcı alıcı belirleyemez. Konu/gövde şablonu ile otomatik gönderim ilkesi **Hatırlatma** yönetici sayfasından düzenlenir ve veritabanında saklanır. SMTP bağlantı bilgileri yalnızca sunucu tarafındaki `.env.local` içinde tutulur.

Elle gönderim, aynı kullanıcı–görev çifti için **beş dakikada bir** ile
sınırlıdır (`429` + `retry-after`); şifrelenmemiş bir SMTP kanalında kimlik
bilgisi gönderilmez; zamanlayıcı ucu tur hiç başlayamadığında `503` döner. Süreç
gönderim sırasında sonlanırsa `PENDING` kalan aralık 30 dakika sonra yeniden
sahiplenilir, böylece o hatırlatma kalıcı olarak kaybolmaz. Ayrıntılar:
`docs/TASK-REMINDERS.md`.

## Outlook takvim tümleştirmesi

Rota gün düzeyinde görev yönetir; saat/dakika toplanmaz. Outlook, Takvim ile aynı `taskCalendarDate()` kuralından tek günlük all-day FREE/TRANSPARENT termin işareti üretir; başlangıç–bitiş dönemi aktarılmaz. **Rota → Outlook tek yönlüdür**; Outlook’ta elle değiştirilen alanlar okunmaz ve sonraki Rota güncellemesi bunları değiştirebilir. Etkin bağlantı/SMTP kabulü, kullanıcının kabul ettiğini veya öğenin takvimde durduğunu doğrulamaz. Yeniden gönderim kullanılabilir.

Bugün/gelecek tarihli abone görev tamamlanınca CANCEL gönderilir, abonelik tercihi korunur; geçmiş kayıt tamamlanma nedeniyle değiştirilmez. Yeniden açılma aynı UID ve daha yüksek SEQUENCE ile REQUEST üretir. Açık kaldırma, silme ve erişim kaybı kapanmış aboneliği kendiliğinden açmaz. Tekrar görevleri bağımsız TaskId/UID öğeleridir; Outlook tekrar master’ı veya Tasks/To Do yoktur.

SMTP yalnızca hem e-posta hatırlatma işlevleri hem Outlook teslimatı kullanılmıyorsa isteğe bağlıdır. SMTP olmadan davetler kuyrukta teslim edilmemiş kalır. Varsayılan Outlook özelliği açıktır; üretimde SMTP yapılandırılmalıdır.

Tekil/toplu ekleme, yeniden gönderme ve kaldırma kalıcı kuyruğa yazılır; gönderimi Next.js Node sunucusuyla başlayan Outlook çalışanı yapar. İlk tur açılışta, sonraki turlar önceki tamamlandıktan varsayılan 5 saniye sonra çalışır (`MERGEN_ROTA_OUTLOOK_POLL_INTERVAL_MS`). Otomatik hatırlatma kapalı olsa da Outlook teslimatı ve yeniden denemeleri sürer; yönetici düğmesi veya Outlook için OS zamanlayıcısı gerekmez. Arayüz bekleyen, başarısız ve teslim edilmiş sonuçları ayırır. Sorumlu/proje lideri değişiklikleri, kurumsal proje eşitlemesi ve kabul edilen tarih talepleri aynı işlemde kuyruğa yansır. PR #72 öncesindeki eski 0010 betiği uygulanmışsa dağıtımdan önce güncel betiği yeniden çalıştırın; abonelikler korunarak iptal/yeniden gönderim niyeti, olası SMTP teslimatı ve görünürlük doğrulama alanları eklenir. Güncel PR #72/0010 bulunan mevcut kurulumlarda da `database/MR_Upgrade_0011_Outlook_Completion_Lifecycle.sql` uygulanmalıdır. Bekleyen işi olmayan aboneliklerin dış yetki kaynakları da periyodik olarak doğrulanır. Teslimat kirası bir dakikadır ve yenilenir; kuyruk bütçesi varsayılan 45 saniyedir. SQL bağlantısı edinmeye 15 saniye, her sonuç/hata yazımına bağımsız 5 saniye ayrılır; otomatik tur tek sonuçlandırmayla 65, zaman aşımından sonra hata yazımı da gerekirse 70 saniyeye kadar çıkabilir. Deneme eşiğine ulaşan işler kaybolmaz ve HTTP 503 ile görünür kalır; otomatik sahiplenme durur ve açık ekleme/yeniden gönderme/kaldırma eylemi deneme durumunu sıfırlayana kadar yeniden denenmez.

Kullanıcı, görebildiği bir görevi **kendi** Outlook takvimine ekleyebilir. Görev
panelinin alt çubuğundaki **Outlook'a Ekle** eylemi hem düzenlenebilir hem salt
okunur panelde bulunur ve görev düzenleme yetkisi gerektirmez; davet teslim edildikten sonra
**✓ Outlook bağlantısı etkin** durumuna geçip sıkışık bir menü açar (daveti yeniden
gönder · Outlook'tan kaldır). Görevler tablosundaki seçim kutularıyla birden çok
görev tek işlemde eklenebilir; **her görev kendi bağımsız randevusunu** alır.

Tümleştirme **kurum içi SMTP + iCalendar** ile çalışır: Microsoft Graph, Entra ID
ve EWS kullanılmaz, internet erişimi gerekmez, yeni paket bağımlılığı eklenmez.
Davet, oturum sahibinin kurumsal e-posta adresine gider; adres sunucuda
`Sicil → MR_V_PeopleDirectory.Username → DC01_userr.EmailAddress` zinciriyle
çözülür ve tarayıcı alıcı belirleyemez.

Termin değiştiğinde MERGEN Rota **aynı `UID` ve daha yüksek `SEQUENCE`** ile bir
güncelleme gönderir; Outlook ikinci bir randevu açmaz. Etiket, yorum, ilerleme
gibi randevuya yazılmayan alanlar hiç ileti üretmez. Kaldırma, görev silme ve
görünürlük kaybı `METHOD:CANCEL` üretir. Gönderim **dayanıklı bir kuyrukla**
yapılır: görev kaydı hiçbir koşulda SMTP'ye bağlı değildir, bekleyen teslimatlar
otomatik Outlook çalışanında sınırlı yığınlar hâlinde yeniden denenir. Yönetici “Turu şimdi çalıştır” eylemi tanı içindir; hatırlatma ve Outlook sayaçları, HTTP 503 olsa da güvenli hata nedenleriyle ayrı gösterilir. Son otomatik tur yerel sürece, kuyruk sağlık sayıları ortak veritabanına aittir. Şema göçü
`database/MR_Upgrade_0010_Outlook_Calendar_Subscriptions.sql` ve ardından `database/MR_Upgrade_0011_Outlook_Completion_Lifecycle.sql`; ayrıntılar:
`docs/OUTLOOK-CALENDAR.md`.

## Görünüm tercihleri

Ayarlar sayfası tema, yoğunluk, vurgu rengi ve yazı boyutunun yanında şunları da
taşır:

- **Tarih biçimi** — `gg/aa/yyyy` veya `18 Ağu 2026`. Daha önce koda gömülüydü.
  Tercih gösterilen tarihlerin yanı sıra **düzenlenebilir** tarih kutularını da
  kapsar; okuma her iki biçimi de kabul eder.
- **Yüksek karşıtlık** — sınırları ve ikincil metni koyulaştırır; parlak ortamda
  ve açık temada okunabilirliği artırır.

Tema, **Temel Kip / Kapsamlı Kip** seçimi ve oturum kapatma eylemleri kenar
çubuğunun alt araç alanında tek sırada bulunur. Kip seçicisi iki sade seçenek
sunar. Kenar çubuğu varsayılan olarak açık ve sabitlenmiş başlar. Raptiye
kaldırıldığında üzerine gelince açılır ve fare görünen çubuğun dışına çıkar
çıkmaz daralır; sayfa seçiminin bıraktığı odak çubuğu açık tutmaz. Klavye ile
gezinirken odak içeride kaldıkça açık kalır. Gereksiz çalışma alanı başlıkları
ve daraltma oku kaldırılmıştır. Tercih tarayıcıda korunur; alt sürüm satırı
yalnızca `MERGEN Rota · Sürüm 1.0` bilgisini taşır.

## Görev oluşturma ve oluşturan künyesi

Kapsamlı Kipteki **Yeni Görev** eylemi veritabanına hemen kayıt yazmaz; yerel
bir görev taslağı açar. Alan değişiklikleri taslakta kalır, kapatma taslağı
atar ve ilk kalıcı `task/create` işlemi yalnızca paneldeki **Kaydet** düğmesiyle
başlar. Mevcut görev panellerindeki birincil düğmenin adı da aynı eylem diliyle
**Kaydet**tir. Mevcut görevdeki tüm alan ve ardıl bağlantısı düzenlemeleri de yalnızca bu düğmeyle tek istekte yazılır; alan değişimi, odak kaybı ve kapatma kayıt başlatmaz. Başarısız kayıtta taslak açık kalır.

Görev başlığının altında kısa bir **Görevi tanımlayan** künyesi; oluşturanın
fotoğrafını, tam adını ve oluşturma tarihini saat ve dakika ile gösterir. Künye
rozet yerine sade bir bilgi satırıdır; Kaydet düğmesi kayıt simgesi taşır. Doğrudan görev sorumlusu,
dar `PARTIAL` görünümde de `MR_Tasks.CreatedBySicil` ve yetkili ad projeksiyonunu
alır. Bu kimlik aynı zamanda **Yeni tarih öner** talebinin karar sahibidir;
istemci kişi dizininin dar olması oluşturanı `—` değerine düşürmez.

Yazı boyutu ölçeği gövdeye `zoom` uygular. Tam ekran kaplayan her yükseklik bu
ölçeğe bölünmüş `--app-viewport-h` değişkenini kullanır; aksi hâlde yazı
büyütüldüğünde panel alt çubuğu ekranın dışına itiliyordu. Ölçek, tema ve
erişilebilirlik sınıflarıyla birlikte **ilk boyamadan önce** uygulanır
(`src/lib/tweaksBootstrap.js`): `AppShell` monte olmadan çizilen veri kipi ve
oturum ekranları da doğru ölçekte açılır, yerleşim zıplaması olmaz. Açılır listeler,
ipuçları ve süzgeç kutuları da ölçeği hesaba katıp görünüm alanına sığdırılır.
Ayrıntılar: `docs/UI-STYLING-ARCHITECTURE.md`.

## Gantt sorumlu görünümü

Görev ve kilometre taşı ipuçlarında her sorumlunun fotoğrafı adıyla birlikte
gösterilir; bu davranış portföy ve proje/WBS görünümünde ortaktır. **Sorumluya
göre** gruplamada ilk sorumlunun avatarı özet satırında da görünür. Aynı adlı
kişiler Sicil kimliğiyle ayrı gruplarda tutulur. Fotoğraf adresi tanımlı
değilse veya yüklenemezse baş harfler gösterilir. Görev kapsamlı kimlikler
kullanılır; kişi dizini ve yetki kapsamı genişletilmez.

## Scheduling ve baseline ilkeleri

Canonical Task; güncel planı (`plannedStart`, `plannedFinish`, `plannedDurationDays`), yönetim hedefini (`targetFinish`) ve gerçekleşen tarihleri (`actualStart`, `actualFinish`) ayrı tutar. `remainingDurationDays` gelecekteki ilerleme duyarlı planlama için nullable uyumluluk alanı olarak korunur; mevcut arayüz ve planlama motoru bu alanı kullanmaz. Project `dataDate` taşır. Baseline verisi ayrı immutable `Baseline` ve `TaskBaselineSnapshot` kayıtlarıdır; normal Task/WBS değişiklikleri eski baseline'ları değiştirmez.

CPM erken/geç tarihler, float, kritik bayraklar, WBS rollup'ları ve Dashboard aggregate'ları SQL'e yazılmaz. Bunlar yalnızca tam Project ağı için türetilir.

### Çalışma günü hesapları SONLANIR

Bütün çalışma günü aramaları sınırlıdır. İki sıradan girdi eskiden tarayıcı
sekmesini tümüyle donduruyordu — kullanıcıların "görev oluşturup **Kaydet**'e
basınca uygulama donuyor" olarak bildirdiği hata:

- takvimin `workingDays` listesi **boşsa** (sunucu, `MR_CalendarWorkingDays`
  tablosunda satırı olmayan takvimi böyle yansıtır) `isWorkingDay()` her gün için
  `false` dönüyor, `moveToWorkingDay()`/`addWorkingDays()` hiç bitmiyordu.
  `createNewTask()` bu işlevi çağırdığı için o projede görev açmak sekmeyi
  kilitliyordu. Boş liste artık **varsayılan haftaya** düşer;
- çözülemeyen bir tarih Geçersiz Tarih üretiyor, `diffWorkingDays()` içindeki
  eşitlik hiç sağlanmıyordu. Geçersiz tarih artık `0` (ya da girdinin kendisi)
  döner ve her tarama on yıllık üst sınırda durur.

Kritik yol sayımı da sınırlıdır (`MAX_CRITICAL_PATHS`): art arda elmas desenleri
yol sayısını üstel büyütür. Kritik **görev** kümesi tam kalır; yalnızca yol
listesi kesilir ve `criticalPathsTruncated` ile bildirilir. Ayrıntılar:
`docs/SCHEDULING.md` ve `docs/CPM.md`.

## Sonraki aşama

Keycloak entegrasyonu tamamlanmıştır: kimlik doğrulama yalnızca `CurrentUserProvider` katmanını değiştirmiş; SQL şeması, yetkilendirme önceliği ve repository transaction modeli korunmuştur. Bundan sonraki iş kalemleri kimlik doğrulamayla ilgili değildir.


### Görev akışı ve görünüm güncellemesi

- Her iki kipte kenar çubuğundan proje/portföy seçimi; arşivlenmiş projeleri gösterme tercihi **Ayarlar → Çalışma alanı** altında.
- Temel Kip tablosunda ölçeğe uyumlu sütunlar; koyu Takvimde belirgin hafta sonları ve daha geniş gün/görev pencereleri.
- Takvimde iki kip için ortak direktörlük/müdürlük/birim filtresi; Görevler ile paylaşılan seçim.
- Görevi oluşturan yöneticiye kapsam içi sorumlu yönetimi ve silme; normal kullanıcı ve kapsam dışı personel sınırları korunur.
- **Tekrarları hazırla** tekrar üretimini taslağa ekler; **Kaydet** şablonu ve tekrarları tek işlemde yazar.
- Kilometre taşında tek gerçekleşen tarih ve ikili tamamlanma durumu.
- Tarih önerisi/kararı sırasında SQL 1205 için sınırlı transaction yeniden denemesi. Veritabanı şema değişikliği gerekmez.
- Açılış logosu: `.env.example` → `MERGEN_ROTA_COMPANY_LOGO_PATH`. UNC/Windows SVG yolu sunucudan okunur; Node hizmet hesabının okuma yetkisi olmalıdır. Eski `NEXT_PUBLIC_MERGEN_ROTA_COMPANY_LOGO_URL` içindeki UNC veya HTTPS değeri de desteklenir. Ayar değişince hizmeti yeniden başlatın.

Ayrıntılar: [Arayüz](docs/SIMPLE-MODE-AND-UI.md), [Tekrarlar](docs/TAGS-AND-RECURRING-TASKS.md), [Takvim veri modeli](docs/SCHEDULING-DATA-MODEL.md), [Görsel yapı](docs/UI-STYLING-ARCHITECTURE.md).

### Sicil, kayıt ve arayüz düzeltmeleri

Personel atamaları SicilNo üzerinden yapılır; aynı adlı çalışanlar ayrı kimliklerle korunur. Yönetici, FULL erişimli manuel projelerinde de yalnızca kurumsal kapsamındaki personeli atayabilir. Görev penceresinde Kaydet dışındaki alan değişiklikleri yerel taslaktır; görev, değişen ardıl bağlantıları ve istenen tekrarlar tek işlemde yazılır. Değişmeyen atamalar yeniden doğrulanıp silinerek eklenmez.

Temel Kip eylem başlığı kaydırmada sabit kalır. Takvim kurumsal seçicileri tarih denetimleriyle aynı satırdadır. Tarih talebi rozetleri ve Görevi aç akışı, kilometre taşı gerçekleşen tarih genişliği, yıldızlı açılış ekranı ve daralan kenar çubuğunun menü/fotoğraf yerleşimi güncellenmiştir. Ayrıntılar: [arayüz](docs/SIMPLE-MODE-AND-UI.md), [yetki modeli](docs/AUTHORIZATION-MODEL.md), [logo ve görünüm](docs/UI-STYLING-ARCHITECTURE.md). Veritabanı şema yükseltmesi gerekmez.

Yeni görev oluştururken de **Öncüller** ve **Ardıllar** tanımlanabilir. Ardılın türü/gecikmesi ve kaldırılması taslakta tutulur; Kaydet yeni görevle tüm bağlantıları aynı transaction içinde yazar. Kapatma bağlantıları da bırakır; döngü, farklı proje, yetki veya sürüm hatasında hiçbir kısmi kayıt oluşmaz. Proje seçimi değişirse önceki projeye ait bekleyen ardıl bağlantıları temizlenir. Bağımlılık düzenlemesi tam proje yetkisi gerektirir.


### Talepler, bildirimler ve ayrıntılı görev listeleri

**Talepler** her iki kipte düz kenar çubuğunda yer alır: Bekleyenler, Gönderdiklerim ve Geçmiş sekmeleri sunucuda arama/süzme ve 25 kayıtlık sayfalama kullanır. Zil en fazla sekiz önizleme gösterir; okuma/temizleme yalnızca kullanıcıya ait bildirim durumunu değiştirir. Açık kararlar görünür kalır, talep/audit geçmişi silinmez. **Özet** KPI kartlarının zengin açılır listeleri korunur; **Tüm görevleri gör** arama, proje/sorumlu süzgeci ve sayfalama içeren geniş pencereyi açar. Görev panelinden geri dönünce pencerenin arama ve sayfa durumu korunur.

**Temel Kip** Gantt içermez; **Ara veya komut çalıştır...** ve Ctrl/Cmd+K iki kipte de kullanılabilir, sonuçlar kip/rol sınırlarını izler. Görevler durumları birbirini dışlar: geciken bir görev Yapılacak veya Devam ediyor süzgecinde gösterilmez. Kapsamlı Kip Görevler tablosunda Başlangıç/Bitiş gerçekleşen tarih varsa onu, yoksa planlanan tarihi gösterir; sıralama ve süzme aynı tarihi kullanır. Küçük, nötr ✓ gerçekleşen tarihi belirtir. Açıklama ile İlk/Önceki/Sonraki/Son gezinmesi aynı alt satırdadır.

**Dağıtım:** Mevcut veritabanında 0007 sonrasında `database/MR_Upgrade_0008_Request_Notifications.sql` ve `database/MR_Upgrade_0009_Task_Activity_Report.sql` sırasıyla çalıştırılmalıdır; ardından uygulamayı derleyip hizmeti yeniden başlatın. Ayrıntılar: [Talepler ve bildirimler](docs/REQUESTS-AND-NOTIFICATIONS.md), [arayüz sözleşmeleri](docs/SIMPLE-MODE-AND-UI.md).

Raporlar artık **Performans** ve **Görev Hareketleri** sekmelerini içerir. Görev Hareketleri, MR_AuditLog üzerinden yetkili ekibin/görevlerin kalıcı değişikliklerini, gerçek aktör kimliği ve Türkiye takvim günüyle raporlar. [Kapsam, süzgeçler ve tarihçe](docs/TASK-ACTIVITY-REPORT.md).

Özet ve Raporlar’daki **Filtreleri Temizle**, tarih ve paylaşılan kurumsal seçimleri sıfırlar. Raporlar → Görev Hareketleri kendi dönem/kapsam/kişi/proje/tür/kurumsal seçimlerini ve sayfasını varsayılana döndürür. Görünürlük yetkileri ve seçili çalışma alanı korunur.

Görev yaşam döngüsü istemci ve SQL yazma sınırında merkezîdir: başlatma eksik gerçek başlangıcı, tamamlama eksik gerçek bitişi doldurur ve ilerlemeyi %100 yapar. İlerleme tek başına kapatma eylemi değildir. Yeniden açma bitişi temizleyip başlangıç/ilerlemeyi korur; Yapılacak'a dönüşte tarih temizleme onayı gerekir. Proje değişikliğiyle aynı istekte tamamlanan görev hedef projenin etkin takvim gününü kullanır. Yeni tekrar oluşumlarının günü, plan tarihleri, termini ve süresi sunucuda şablon planıyla doğrulanır. Normal kullanıcı Kapsamlı Kipte kendi yetkili, yalnız kendisine atanmış görevini tekrarlayabilir; proje/WBS/atama yetkileri genişlemez. Özet/Performans filtreleri ve Proje Yapısı sekmeleri yapışkandır; Görev Hareketleri tek dikey tablo alanında kayar. Ayrıntılar: [yaşam döngüsü](docs/SCHEDULING-DATA-MODEL.md), [tekrar yetkisi](docs/TAGS-AND-RECURRING-TASKS.md), [arayüz](docs/SIMPLE-MODE-AND-UI.md).

Outlook deneme sınırına ulaşan teslimatlar otomatik yeniden denenmez; açık yeniden ekleme, yeniden gönderme veya kaldırma eylemiyle tekrar işlenebilir. Tamamlanmada bekletilen bağlantılar periyodik taramaya alınmaz; yeniden açılma sırasında erişim yeniden doğrulanır. Ayrıntılar: [Outlook takvim bağlantısı](docs/OUTLOOK-CALENDAR.md).
