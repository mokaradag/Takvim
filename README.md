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

Kullanım modları aynı seçili veri kaynağı üzerinde çalışır:

- **Basit Mod**: Proje, görev, anahtar sözcük, sorumlu ve termin tarihiyle hızlı giriş ve Takvim takibi.
- **Gelişmiş Mod**: WBS, bağımlılıklar, güncel plan/hedef/gerçekleşen tarihler, Gantt, CPM, Kanban, raporlar ve portföy araçları.

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
2. Proje bazlı `FULL`
3. Yönetici alt-organizasyon görünürlüğü (`PARTIAL`, salt okunur)
4. Kendi atandığı görevler (`PARTIAL`, salt okunur)
5. Varsayılan ret

`MR_UserRoles` oluşturma betiği sistem yöneticilerini parametreli tohumlar: kurulumdan önce `@SystemAdminSicils` değişkenine virgülle ayrılmış Sicil listesi yazılır. Gerçek Sicil değerleri kişisel veridir ve depoya işlenmez. HR09 sorumlulukları kurumsal FULL erişim sağlar. Manuel erişimler `MR_ProjectAccess` içinde tutulur. Sistem yöneticileri ile HR02'de dinamik olarak yönetici görünen kullanıcılar manuel Project oluşturabilir; Project, kök WBS, FULL OWNER erişimi ve audit kayıtları aynı transaction içinde oluşturulur.

PARTIAL görünürlük tam Project yönetim yetkisi vermez. Kısmi Task ağı üzerinde yanıltıcı CPM/critical-path hesaplanmaz; Project scheduling sonucu `suppressed-partial` olarak işaretlenir.

## Kimlik doğrulama (Keycloak)

Kimlik doğrulama **Keycloak** ile yapılır ve varsayılan kiptir (`MERGEN_ROTA_AUTH_MODE=keycloak`). Akış Authorization Code + PKCE'dir; erişim jetonu tarayıcıda saklanmaz, sunucuda doğrulanır ve yalnızca doğrulanmış **Sicil** HttpOnly bir oturum çerezine yazılır.

- `GET /api/mergen-rota/auth/login` — PKCE ile Keycloak'a yönlendirir
- `GET /api/mergen-rota/auth/callback` — kodu sunucuda jetonla takas eder, doğrular, oturum çerezini yazar
- `POST /api/mergen-rota/auth/session` — uyumluluk ucu: `Authorization: Bearer` jetonunu doğrulayıp HttpOnly oturuma çevirir
- `POST|GET /api/mergen-rota/auth/logout` — MERGEN Rota oturumunu kapatır ve Keycloak `end_session` adresine yönlendirir

Güvenilen kimlik yalnızca doğrulanmış `sicil` claim'idir. Claim yoksa isteğe bağlı olarak `preferred_username → HR02 kurumsal kullanıcı adı → Sicil` çözümü yapılır; sonuç tekil değilse **UNAUTHORIZED** döner. Keycloak `resource_access` rollerinden MERGEN Rota SYSTEM_ADMIN yetkisi **türetilmez**.

Sicil; istek gövdesi, sorgu dizesi, tarayıcı başlığı, localStorage veya görüntüleme alanlarından kabul edilmez. Kimlik yoksa yönetici, Demo veya geliştirme kimliğine sessizce düşülmez.

Yerel geliştirme kimliği yalnızca `MERGEN_ROTA_AUTH_MODE=development` **ve** `MERGEN_ROTA_DEV_IDENTITY_ENABLED=true` birlikte verildiğinde çalışır; varsayılan olarak kapalıdır.

Ayrıntılar, ortam değişkenleri, IT'nin kaydetmesi gereken adresler ve sorun giderme: [`docs/KEYCLOAK-SSO.md`](docs/KEYCLOAK-SSO.md).

## Kullanıcı fotoğrafları

Kurumsal fotoğraflar `<TABAN_URL>/<SICIL>.jpg` biçiminde üretilir. Taban adres `NEXT_PUBLIC_MERGEN_ROTA_USER_PHOTO_BASE_URL` değişkeninden okunur; tarayıcı tarafından istendiği için **sır değildir** ve istemci paketine gömülür. Gerçek adres yalnızca `.env.local` içinde tutulur ve depoya işlenmez.

Değer boşsa, sicil eksik/bozuksa veya görsel yüklenemezse tüm avatarlar baş harflere döner. Üretilen adres hiçbir tabloda saklanmaz; fotoğraf tamamen sunum verisidir ve başarısız bir görsel isteği kimlik doğrulamayı veya veri yüklemeyi engellemez.

## Veritabanı kurulumu

1. Hedef veritabanının yedeğini alın.
2. `database/MR_Create_Durable_Persistence.sql` dosyasını çalıştırın.
3. `.env.example` içindeki server-only SQL değişkenlerini yapılandırın (MERGEN Rota veritabanı ve isteğe bağlı `CN43N` kurumsal WBS veritabanı).
4. Keycloak istemcisini kaydedin ve `.env.local` içinde kimlik doğrulama değişkenlerini doldurun (bkz. `docs/KEYCLOAK-SSO.md`). Geçici geliştirme kimliği yalnızca yerel geliştirmede etkinleştirilir.
5. `npm ci`
6. `npm run build`
7. `npm run start -- -H 0.0.0.0 -p 8008`
8. **Gerçek Sistem** seçerek yetki ve kalıcılığı doğrulayın.

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

- `src/domain` — Project, Task, Dependency, Person, WBS, Baseline, calendar kavramları ve Gerçek Sistem kimlik kuralları
- `src/scheduling` — tarih, çalışma günü, dependency ve saf CPM hesapları
- `src/data` — AppRepository sözleşmesi, Demo adapter ve Actual API adapter
- `src/server` — server-only identity, authorization, SQL config/pool (MERGEN Rota + kurumsal WBS kaynağı) ve durable repository
- `src/state` — yükleme, sıralı mutation queue, Task patch coalescing ve access-aware scheduling selector'ları
- `src/features` — uygulama özellikleri; SQL veya API route import etmez
- `src/components/shell` — application shell, Veri Modu/Kullanım Modu seçimleri ve persistence durumları
- `database` — deterministic create ve destructive rollback SQL betikleri

Ayrıntılar:

- `docs/KEYCLOAK-SSO.md`
- `docs/DURABLE-PERSISTENCE.md`
- `docs/DATABASE-SCHEMA.md`
- `docs/AUTHORIZATION-MODEL.md`
- `docs/ARCHITECTURE.md`
- `docs/PERSISTENCE-BOUNDARY.md`
- `docs/WBS-AND-WORKSPACES.md`
- `docs/SCHEDULING-DATA-MODEL.md`
- `docs/CPM.md`
- `docs/SIMPLE-MODE-AND-UI.md`
- `docs/UI-STYLING-ARCHITECTURE.md`
- `docs/VISUAL-SMOKE-TESTS.md`

## Scheduling ve baseline ilkeleri

Canonical Task; güncel planı (`plannedStart`, `plannedFinish`, `plannedDurationDays`), yönetim hedefini (`targetFinish`), gerçekleşen tarihleri (`actualStart`, `actualFinish`) ve kalan süreyi (`remainingDurationDays`) ayrı tutar. Project `dataDate` taşır. Baseline verisi ayrı immutable `Baseline` ve `TaskBaselineSnapshot` kayıtlarıdır; normal Task/WBS değişiklikleri eski baseline'ları değiştirmez.

CPM erken/geç tarihler, float, kritik bayraklar, WBS rollup'ları ve Dashboard aggregate'ları SQL'e yazılmaz. Bunlar yalnızca tam Project ağı için türetilir.

## Sonraki aşama

Keycloak entegrasyonu tamamlanmıştır: kimlik doğrulama yalnızca `CurrentUserProvider` katmanını değiştirmiş; SQL şeması, yetkilendirme önceliği ve repository transaction modeli korunmuştur. Bundan sonraki iş kalemleri kimlik doğrulamayla ilgili değildir.
