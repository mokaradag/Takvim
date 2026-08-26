# MERGEN Rota — Proje Yönetimi

Endüstriyel/kontrol paneli tarzında bir proje yönetimi uygulaması: Basit Modda hızlı görev/termin takibi; Gelişmiş Modda Özet, Görevler, İş Kırılım Yapısı, Takvim, Gantt, Kanban, Raporlar, Ekip ve Ayarlar sayfaları. Next.js App Router ve React kullanır.

MERGEN Rota artık iki tümüyle yalıtılmış **Veri Modu** sunar:

- **Demo Modu** — mevcut zengin örnek veri kümesini kullanan, asenkron ve kalıcı olmayan bellek repository'si. Demo kayıtları SQL Server'a veya Gerçek Sistem API'sine gönderilmez.
- **Gerçek Sistem** — tarayıcıdaki API repository'sinden Next.js sunucu katmanına, sunucu tarafı yetkilendirmeye ve SQL Server repository'sine giden kalıcı üretim veri yolu. Tarayıcı SQL Server'a hiçbir zaman doğrudan bağlanmaz.

Veri Modu, **Basit Mod / Gelişmiş Mod** kullanım seçiminden bağımsızdır. Veri Modu değiştiğinde application-state provider yeniden kurulur; Demo ve Gerçek Sistem snapshot'ları birleştirilmez. Demo etkin olduğunda sürekli görünen `DEMO` göstergesi vardır.

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

## Veri Modu ve kullanım modları

İlk Veri Modu seçiminde kullanıcı **Demo Modunu Aç** veya **Gerçek Sisteme Geç** seçeneklerinden birini seçer. Gerçek Sistem yüklenemezse Demo'ya sessiz dönüş yapılmaz; veritabanı, kimlik veya yetki hatası açıkça gösterilir ve Demo'ya dönüş kullanıcı kararıyla gerçekleşir.

Gerçek Sistem seçildiğinde application-state provider kurulmadan önce kurumsal oturum denetlenir. Oturum yoksa kullanıcı doğrudan seçili Keycloak akışına yönlendirilir; uygulama içinde ayrıca `Oturum açmanız gerekiyor` kutusu gösterilmez.

Kullanım modları aynı seçili veri kaynağı üzerinde çalışır:

- **Basit Mod**: Proje, görev, anahtar sözcük, sorumlu, öncelik ve termin tarihiyle hızlı giriş; sütun filtreli sadeleştirilmiş **Görevler** listesi ve termin günü Takvim takibi. İlerleme, başlangıç tarihleri, bağımlılıklar ve ileri planlama alanları Basit Modda gösterilmez.
- **Gelişmiş Mod**: WBS, bağımlılıklar, güncel plan/hedef/gerçekleşen tarihler, Gantt, CPM, Kanban, raporlar ve portföy araçları.

Planlanan/gerçekleşen saat alanları veritabanı ve API uyumluluğu için korunur ancak normal uygulama arayüzünde hiçbir modda gösterilmez; kullanıcı ilerlemeyi `İlerleme` üzerinden izler.

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
4. Kendi atandığı görevler (`PARTIAL`, yalnızca o görevin iş alanlarını düzenleyebilir)
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
2. Yeni kurulumda `database/MR_Create_Durable_Persistence.sql` dosyasını çalıştırın. Mevcut kurulumda bunun yerine yükseltme betiklerini sırayla çalıştırın; sonuncusu görev hatırlatma tablolarını ekleyen `database/MR_Upgrade_0005_Task_Reminders.sql` dosyasıdır. Yükseltme betikleri yeniden çalıştırılabilir ve var olan veriyi korur.
3. `.env.example` içindeki server-only SQL değişkenlerini yapılandırın (MERGEN Rota veritabanı ve isteğe bağlı `CN43N` kurumsal WBS veritabanı).
4. Keycloak istemcisini kaydedin ve `.env.local` içinde kimlik doğrulama değişkenlerini doldurun (bkz. `docs/KEYCLOAK-SSO.md`). Geçici geliştirme kimliği yalnızca yerel geliştirmede etkinleştirilir.
5. `npm ci`
6. `npm run build`
7. `npm run start -- -H 0.0.0.0 -p 8008`
8. İsteğe bağlı: hatırlatma postaları için `.env.local` içindeki SMTP bloğunu doldurun ve zamanlayıcıyı kaydedin (`docs/TASK-REMINDERS.md`).
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
- `src/server` — server-only identity, authorization, SQL config/pool (MERGEN Rota + kurumsal WBS kaynağı), durable repository, SMTP taşıması (`mail`) ve hatırlatma servisi/zamanlayıcısı (`reminders`)
- `src/state` — yükleme, sıralı mutation queue, Task patch coalescing ve access-aware scheduling selector'ları
- `src/features` — uygulama özellikleri; SQL veya API route import etmez
- `src/components/shell` — application shell, Veri Modu/Kullanım Modu seçimleri ve persistence durumları
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
- `docs/SIMPLE-MODE-AND-UI.md`
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
etkilemez. Ayrıntılar: `docs/SCHEDULING.md`.

## Görev hatırlatma postaları

Her görev için sorumlularına hatırlatma e-postası gönderilebilir. İki akış vardır ve ikisi de aynı alıcı çözümleme, şablon işleme ve SMTP servisini kullanır:

- **Elle gönderim** — görev satırındaki ve görev panelindeki zarf düğmesi (Silme düğmesinin yanında, her iki modda). Otomatik hatırlatmalar kapalıyken de çalışır, görevi değiştirmez ve yalnızca SMTP sunucusu iletiyi kabul ettiğinde başarı bildirir.
- **Otomatik gönderim** — yöneticinin belirlediği pencere (`kalan süre = termin - şimdi`, örn. 7 gün) ve sıklıkla (örn. 2 günde bir) sunucu tarafındaki zamanlayıcı üzerinden. Görev tamamlandığında, iptal edildiğinde, silindiğinde, otomatik gönderim kapatıldığında veya termin gününe ulaşıldığında durur; sınırsız gecikme postası gönderilmez.

Alıcılar sunucuda `MR_TaskAssignees.Sicil → MR_V_PeopleDirectory.Username → DC01_userr.Name → DC01_userr.EmailAddress` zinciriyle çözülür; tarayıcı alıcı belirleyemez. Konu/gövde şablonu ile otomatik gönderim ilkesi **Hatırlatma** yönetici sayfasından düzenlenir ve veritabanında saklanır. SMTP bağlantı bilgileri yalnızca sunucu tarafındaki `.env.local` içinde tutulur.

Elle gönderim, aynı kullanıcı–görev çifti için **beş dakikada bir** ile
sınırlıdır (`429` + `retry-after`); şifrelenmemiş bir SMTP kanalında kimlik
bilgisi gönderilmez; zamanlayıcı ucu tur hiç başlayamadığında `503` döner. Süreç
gönderim sırasında sonlanırsa `PENDING` kalan aralık 30 dakika sonra yeniden
sahiplenilir, böylece o hatırlatma kalıcı olarak kaybolmaz. Ayrıntılar:
`docs/TASK-REMINDERS.md`.

## Görünüm tercihleri

Ayarlar sayfası tema, yoğunluk, vurgu rengi ve yazı boyutunun yanında şunları da
taşır:

- **Tarih biçimi** — `gg/aa/yyyy` veya `18 Ağu 2026`. Daha önce koda gömülüydü.
  Tercih gösterilen tarihlerin yanı sıra **düzenlenebilir** tarih kutularını da
  kapsar; okuma her iki biçimi de kabul eder.
- **Yüksek karşıtlık** — sınırları ve ikincil metni koyulaştırır; parlak ortamda
  ve açık temada okunabilirliği artırır.

Yazı boyutu ölçeği gövdeye `zoom` uygular. Tam ekran kaplayan her yükseklik bu
ölçeğe bölünmüş `--app-viewport-h` değişkenini kullanır; aksi hâlde yazı
büyütüldüğünde panel alt çubuğu ekranın dışına itiliyordu. Ölçek, tema ve
erişilebilirlik sınıflarıyla birlikte **ilk boyamadan önce** uygulanır
(`src/lib/tweaksBootstrap.js`): `AppShell` monte olmadan çizilen veri modu ve
oturum ekranları da doğru ölçekte açılır, yerleşim zıplaması olmaz. Açılır listeler,
ipuçları ve süzgeç kutuları da ölçeği hesaba katıp görünüm alanına sığdırılır.
Ayrıntılar: `docs/UI-STYLING-ARCHITECTURE.md`.

## Scheduling ve baseline ilkeleri

Canonical Task; güncel planı (`plannedStart`, `plannedFinish`, `plannedDurationDays`), yönetim hedefini (`targetFinish`) ve gerçekleşen tarihleri (`actualStart`, `actualFinish`) ayrı tutar. `remainingDurationDays` gelecekteki ilerleme duyarlı planlama için nullable uyumluluk alanı olarak korunur; mevcut arayüz ve planlama motoru bu alanı kullanmaz. Project `dataDate` taşır. Baseline verisi ayrı immutable `Baseline` ve `TaskBaselineSnapshot` kayıtlarıdır; normal Task/WBS değişiklikleri eski baseline'ları değiştirmez.

CPM erken/geç tarihler, float, kritik bayraklar, WBS rollup'ları ve Dashboard aggregate'ları SQL'e yazılmaz. Bunlar yalnızca tam Project ağı için türetilir.

### Çalışma günü hesapları SONLANIR

Bütün çalışma günü aramaları sınırlıdır. İki sıradan girdi eskiden tarayıcı
sekmesini tümüyle donduruyordu — kullanıcıların "görev oluşturup **Tamam**'a
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
