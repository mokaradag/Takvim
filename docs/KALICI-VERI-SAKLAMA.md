# SQL Server ile Kalıcı Veri Saklama

## Mimari

MERGEN Rota'da artık birbirinden yalıtılmış iki veri yolu vardır.

```text
Demo kipi
Arayüz → durum düzenlemesi → asenkron bellek içi Demo deposu

Gerçek Sistem kipi
Arayüz → durum düzenlemesi → istemci API deposu → Next.js Node rotaları
   → güvenilir güncel kullanıcı sağlayıcısı → yetkilendirme servisi
   → SQL Server deposu → SQL Server
```

Özellik modülleri durum eylemlerini kullanmayı sürdürür. SQL Server paketlerini, bağlantı yapılandırmasını, sorguları veya sunucu depolarını içe aktarmaz. Tarayıcı SQL Server'a hiçbir zaman doğrudan bağlanmaz.

## Depo ve API sözleşmesi

`AppRepository`, `loadSnapshot()` ve atomik `commitChanges()` gerektirir; `loadSessionContext()` **isteğe bağlıdır** ve yalnızca Gerçek Sistem kipi uygular (`assertAppRepository()` bu yöntem olmadan da depoyu kabul eder; `docs/KALICILIK-SINIRI.md` aynı iki yöntemli sözleşmeyi belirtir). Gerçek Sistem kipi şunları kullanır:

- `GET /api/mergen-rota/session`
- `GET /api/mergen-rota/snapshot`
- `POST /api/mergen-rota/commit`

Görev hatırlatmaları aynı kuralları izleyen üç rota ekler; bunlar anlık görüntü/kayıt trafiği yerine eylem olduklarından `AppRepository` sözleşmesine dahil değildir:

- `POST /api/mergen-rota/tasks/{taskId}/reminder` — elle gönderim. İstek gövdesi hiç okunmaz; tarayıcı alıcı sağlayamaz. İşlemi yapan kişi bu görev için zaten yetkili olmalıdır.
- `GET|PUT /api/mergen-rota/admin/reminder-settings` — şablon ve otomatik ilke; sunucuda yalnızca yöneticilere açıktır. Yanıt yalnızca SMTP'nin yapılandırılıp yapılandırılmadığını bildirir, kimlik bilgilerini içermez.
- `POST /api/mergen-rota/reminders/run` — hatırlatma zamanlayıcısı ve elle tanı turu. `timingSafeEqual` ile karşılaştırılan paylaşılan gizli değer veya SYSTEM_ADMIN oturumu kabul eder. HTTP 503 durumunda güvenli gerekçeler dahil ayrı hatırlatma ve Outlook özetleri döndürür.
- `GET /api/mergen-rota/reminders/run` — salt okunur Outlook kuyruk sağlığı ve sürece yerel otomatik çalışan durumu; yalnızca SYSTEM_ADMIN oturumu.

Bütün rotalar Next.js Node.js çalışma zamanını zorunlu kılar, önbelleği kapatır, kimliği sunucuda türetir ve normalleştirilmiş güvenli hatalar döndürür. SQL yığınları, bağlantı ayarları ve ham sorgu metni tarayıcıya verilmez.

## SQL Server bağlantısı

`mssql` paketi, `msnodesqlv8` sürücüsünü yalnızca `src/server` altında kullanır. Sürücü Windows Tümleşik Kimlik Doğrulaması (`trustedConnection: true`) ile bağlanır; MERGEN Rota SQL kullanıcı adı veya parolası saklamaz veya kabul etmez. Yeniden kullanılabilir tek bağlantı havuzu ihtiyaç anında başlatılır. Sorgular tür belirtilmiş parametreler kullanır. Bağlantı ve istek zaman aşımları yapılandırılabilir.

SQL Server, Node.js sürecini çalıştıran Windows hesabını doğrular. Yerel geliştirmede bu normalde `npm run dev` başlatan oturum açmış Windows hesabıdır. Üretimde ayrı bir etki alanı hizmet hesabı olmalıdır. BT bu hesaba hedef veritabanına erişim, üç kurumsal kaynağa okuma ve `MR_*` nesnelerinde gereken okuma/yazma izinlerini vermelidir.

Ana makinede Microsoft ODBC Driver 18 for SQL Server kurulu olmalıdır. Gerektiğinde Driver 17 de açıkça seçilebilir. Yerel `msnodesqlv8` bağımlılığı normalde önceden derlenmiş ikili dosya kullanır; onaylı npm aynası bunu sağlayamıyorsa kurulum derlemeye döner ve **Desktop development with C++** iş yüküyle Visual Studio 2022 Build Tools gerektirir.

Gerekli dağıtım değişkenleri `.env.example` içindedir:

- `NEXT_PUBLIC_MERGEN_ROTA_AUTO_REFRESH_INTERVAL_MS` (varsayılan `60000`; alt sınır `30000`; geçersiz değerler varsayılana döner)

- `MERGEN_ROTA_DB_SERVER`
- `MERGEN_ROTA_DB_PORT`
- `MERGEN_ROTA_DB_DATABASE`
- `MERGEN_ROTA_DB_ODBC_DRIVER`
- `MERGEN_ROTA_DB_ENCRYPT`
- `MERGEN_ROTA_DB_TRUST_SERVER_CERTIFICATE`
- `MERGEN_ROTA_DB_CONNECTION_TIMEOUT_MS`
- `MERGEN_ROTA_DB_REQUEST_TIMEOUT_MS`

`MERGEN_ROTA_DB_USER` veya `MERGEN_ROTA_DB_PASSWORD` eklemeyin; Windows kimlik doğrulamalı bağdaştırıcı bunları kullanmaz. Bütün veritabanı değişkenleri yalnızca sunucu içindir ve hiçbir zaman `NEXT_PUBLIC_` öneki kullanmamalıdır.

Otomatik yenileme değeri tarayıcı zamanlamasını yönettiği ve sır içermediği için bilinçli olarak açıktır. Next.js bunu istemci paketine gömer; değişiklik yeniden derleme gerektirir. Gerçek Sistem kipi yalnızca görünür sekmede yoklar; Demo kipi yoklamaz. Tarayıcı doğrudan SQL bağlantısı veya ikinci veri yolu yerine mevcut anlık görüntü ucunu ve kalıcılık kuyruğunu kullanır.

### Kurumsal kullanıcı dizini (`DC01_userr`)

Personel e-posta dizini `DC01_userr`, `MERGEN_ROTA_DB_DATABASE` içindedir ve ek havuz gerektirmez; ana bağlantıdan salt okunur, parametreli sorgularla okunur. Nesne adı `MERGEN_ROTA_USER_DIRECTORY_SCHEMA` ve `MERGEN_ROTA_USER_DIRECTORY_TABLE` ile yapılandırılabilir. Hatırlatmaların alıcı çözümlemesi için önce Windows hizmet hesabına bu nesnede `SELECT` verilmelidir.

### İkinci bağlantı: kurumsal WBS kaynağı (CN43N)

Kurumsal WBS tablosu `CN43N`, `MERGEN_Rota` veritabanında **değildir**; bu nedenle kendi bağlantı bloğu ve ihtiyaç anında başlatılan havuzu (`src/server/db/corporateWbsPool.js`) vardır. O da Windows Tümleşik Kimlik Doğrulaması kullanır:

- `MERGEN_ROTA_WBS_DB_SERVER`
- `MERGEN_ROTA_WBS_DB_PORT`
- `MERGEN_ROTA_WBS_DB_DATABASE`
- `MERGEN_ROTA_WBS_DB_SCHEMA` (varsayılan `dbo`)
- `MERGEN_ROTA_WBS_DB_TABLE` (varsayılan `CN43N`)
- `MERGEN_ROTA_WBS_DB_ODBC_DRIVER`
- `MERGEN_ROTA_WBS_DB_ENCRYPT`
- `MERGEN_ROTA_WBS_DB_TRUST_SERVER_CERTIFICATE`
- `MERGEN_ROTA_WBS_DB_CONNECTION_TIMEOUT_MS`
- `MERGEN_ROTA_WBS_DB_REQUEST_TIMEOUT_MS`
- `MERGEN_ROTA_WBS_SYNC_PROJECT_BATCH` (kaynağa her gidiş-dönüşteki proje kodu sayısı)

Node.js çalıştıran Windows hesabının bu veritabanında **okuma** erişimi olmalıdır. Sorgu metnine gömüldükleri için şema ve tablo adları yalın SQL Server tanımlayıcısı olarak doğrulanır; proje kodları her zaman parametreyle verilir. `..._SERVER`/`..._DATABASE` boş bırakılırsa hata yerine eşitleme kapatılır; kurumsal projeler yalnızca kök WBS düğümünü gösterir. Kaynak yapılandırılmış ama erişilemezse anlık görüntü yüklemesi yine başarılı olur ve hata günlüğe yazılır; ikinci veritabanı kesintisi uygulamayı durdurmamalıdır. Sütun eşlemesi ve birleştirme kuralları `docs/IS-KIRILIM-YAPISI-VE-CALISMA-ALANLARI.md` içindedir.

## İşlem anlamı

Bir `commitChanges()` çağrısı tek SQL işlemine eşlenir. Sunucu aynı işlemde güvenilir kimlik çözümlemesi, yetkilendirme, ilişki doğrulaması, iyimser eşzamanlılık denetimleri, normalleştirilmiş alt kayıt uzlaştırması, denetim ekleme ve son kaydı yapar. Herhangi bir hata bütün değişiklik kümesini geri alır.

Atomik işlemler; kök WBS ve sahip erişimiyle proje oluşturmayı, sorumlular ve bağımlılıklarla görev güncellemeyi, WBS taşıma/üst düğüm değiştirmeyi, toplu görev taşımayı, etiketlerle proje üst verisini ve denetim kayıtlarını içerir.

## İyimser eşzamanlılık

Değiştirilebilir SQL varlıkları SQL Server `rowversion` kullanır. API bunu opak Base64 `version` belirteci olarak sunar. Güncelleme ve silme komutları beklenen belirteci vermelidir. Sıfır satır etkileyen güncelleme/silme, son yazan kazanır davranışını sessizce uygulamak yerine `CONFLICT` / HTTP 409 döndürür.

Sürüm belirteci **olmayan** değişiklik kümesi girdisi açık oluşturma niyetidir. `assertUpsertIntentMatchesPersistence`, satırı zaten var olan sürümsüz upsert işlemini `UPSERT_CREATE_COLLISION` (“Kayıt kimliği zaten kullanılıyor”) ile reddeder.

Bu, sürüm güncelliğini istemci doğruluğu gereği yapar: her kayıttan sonra durum katmanı sunucunun geri döndürdüğü yetkili satırları benimsemelidir. Bu nedenle `appStateReducer`, `persistence/success` işlerken WBS ve görev değişikliklerinin yanında `projectUpserts`/`projectDeletes` de uygular. Önceden proje satırları kayıt öncesi sürümde kalıyor; aynı projenin ikinci düzenlemesi (örneğin kaydettikten hemen sonra `Proje rengi` değiştirmek) oluşturma çakışması olarak reddediliyordu. Depo proje satırını hiç geri döndürmezse `AppStateProvider`, sürümsüz yerel kopya saklamak yerine yetkili anlık görüntüyü yeniden yükler.

## Kurumsal kaynaklar

Üç kurumsal kaynak salt okunur kalır:

- `HR02_rehisRehberwithMasrafYeri`: Sicil ile normalleştirilen canlı personel ve kurum dizini.
- `A01_ProjeUrunFaaliyetRaporu`: kurumsal proje kataloğu. Yalnızca `Tur`, `Tur_Aciklama`, `ProjeKodu` ve `ProjeAdi` seçilir; kaynak görünümü bu dört alan üzerinde `GROUP BY` kullanır.
- `HR09_projeSorumlu`: kurumsal tam proje sorumluluğu. `pptcSicil`, tam belirteç eşleşmesi için `STRING_SPLIT`, boşluk kırpma ve `TRY_CONVERT(int, value)` kullanır; `LIKE '%sicil%'` ile yetkilendirmeye izin verilmez.

Kurumsal eşitleme yalnızca kaynağa ait proje kimlik alanlarını günceller, uygulama üst verisini korur, eksik proje sicili satırlarını ve kök WBS kayıtlarını ekler, kaynaktan kaybolanları etkin dışı yapar, manuel projeleri dönüştürmez ve A01'e yazmaz. İstemciden gelen kurumsal proje güncellemeleri de sunucuda `LeadSicil` değerini korur; MERGEN'e ait alanların düzenlenmesi kaynağa ait proje sorumlusunu temizleyemez.

Kurumsal WBS eşitlemesi ikinci bağlantıdan `CN43N` okuyan ayrı adımdır. Yalnızca kurumsal projelerin `SourceType = 'CORPORATE'` satırlarına yazar; manuel satırlara, MERGEN'in ürettiği proje köküne veya kaynak tabloya yazmaz. İstemcinin kurumsal WBS yapısına yazma girişimi `FORBIDDEN` ile reddedilir.

### Katalog yenileme zamanlaması

Kurumsal proje ve WBS eşitlemesi birlikte *katalog yenilemesini* oluşturur; SQL deposunda `refreshCorporateCatalog()` olarak sunulur ve `readSnapshot()` işleminden ayrı tutulur. İşletim açısından üç özellik önemlidir:

- yenileme serializable anlık görüntü okuma işleminin **öncesinde ve dışında** çalışır; büyük CN43N birleştirmesi artık serializable yalıtımı devralmaz veya okuma boyunca `MR_WBS` aralık kilitlerini tutmaz;
- `MERGEN_ROTA_WBS_SYNC_TTL_MS` ile **sıklığı sınırlanır** (varsayılan 300000; `0` her istekte yeniler) ve **yinelenmez**: eşzamanlı istekler sürmekte olan tek yenilemeyi paylaşır;
- `MR_CorporateWbsSyncState` üzerinden proje başına **parmak iziyle denetlenir**; değişmeyen kurumsal ağaç birleştirme deyimi üretmez.

Başarısız yenileme güncellik penceresini ilerletmez ve isteği başarısız kılmaz: anlık görüntü zaten saklanan veriden sunulur, sonraki istek hemen yeniden dener. Yapılandırılmamış CN43N kaynağı hata değildir; eşitlenecek veri olmadığından pencere normal ilerler ve kurumsal proje eşitlemesi her istekte tekrarlanmaz.

60 saniyelik tarayıcı veri yenilemesi bu katalog ilkesinin yerine geçmez veya süresini kısaltmaz. Manuel ve otomatik anlık görüntü istekleri önce güncel yetkili anlık görüntüyü döndürür, katalog işini arkasına zamanlar. CN43N okuma/birleştirmesine yine `MERGEN_ROTA_WBS_SYNC_TTL_MS`, süreçte tek etkin yenileme koruması ve proje parmak izleri karar verir. İstemci kurumsal eşitleme mantığını çoğaltmaz.

## Demo ve Gerçek Sistem kipleri

Demo kipi kalıcı değildir ve mevcut zengin örnek veri kümesini kullanır. SQL Server'ı veya Gerçek Sistem API'sini hiç çağırmaz. Gerçek Sistem kipi Demo başlangıç kayıtlarını içe aktarmaz veya birleştirmez. Depo değiştirmek uygulama durum sınırını yeniden kurar; sürekli `DEMO` göstergesi örnek verinin canlı sanılmasını önler. Temel/Kapsamlı ayrı bir kullanım kipi seçimidir.

Gerçek Sistem hataları sessizce Demo'ya dönmez. Kullanıcı Gerçek Sistem hatasını görür ve isterse bilinçli olarak Demo'ya geçer.

## Kimlik

`CurrentUserProvider`, sunucu kimlik sınırıdır ve artık **Keycloak** desteklidir. `KeycloakIdentityProvider`, yalnızca Keycloak belirteci sunucuda doğrulandıktan sonra (realm JWKS ile imza ve `iss`/`exp`/`aud`/`azp`) yazılan, sunucu imzalı HttpOnly oturum çerezindeki Sicil'i döndürür. Bkz. `docs/KEYCLOAK-SSO.md`.

Sağlayıcının değiştirilmesi yetkilendirme servisinde, depo işlem modelinde veya SQL şemasında **hiçbir** değişiklik gerektirmedi.

`DevelopmentIdentityProvider`, yalnızca açıkça etkinleştirilen yerel geliştirme seçeneği olarak kalır; hem `MERGEN_ROTA_AUTH_MODE=development` hem `MERGEN_ROTA_DEV_IDENTITY_ENABLED=true` gerektirir. Varsayılan olarak kapalıdır.

İstek gövdeleri, sorgu parametreleri, tarayıcı başlıkları ve yerel depolama güncel kimlik olarak güvenilir sayılmaz. Otomatik SYSTEM_ADMIN yedeği, geliştirme kimliğine veya Demo kipine sessiz dönüş yoktur.

## Hatalar

Depo hataları küçük tutulur:

- `LOAD_FAILED`
- `MUTATION_FAILED`
- `UNAUTHORIZED` (401)
- `FORBIDDEN` (403)
- `CONFLICT` (409)
- `DATABASE_UNAVAILABLE` (503)

Alan doğrulama hataları kalıcılık ve yetkilendirme hatalarından ayrı kalır.

Kalıcı kayıt hataları kullanıcıya olduğu gibi gösterilir. `PersistenceStatus`, sunucu iletisini, hata/ayrıntı kodunu ve varsa hatalı alanı veya değişiklik kümesi yolunu çizer. `CONFLICT`, `UPSERT_CREATE_COLLISION` ve `UPSERT_TARGET_MISSING` ayrıca **Verileri yeniden yükle** eylemi sunar; bunlar kullanıcının çözebileceği eski durum hatalarıdır. Alt gerekçe olmadan genel “Kaydetme hatası” etiketi kabul edilmez; kullanıcıya toparlanma yolu bırakmaz.

## Dağıtım

1. Hedef veritabanını yedekleyin.
2. Yeni kurulumda `database/MR_Create_Durable_Persistence.sql` çalıştırın. **Mevcut** kurulumda bunun yerine yükseltme betiklerini **sırayla** çalıştırın:
   1. `database/MR_Upgrade_0004_Tag_Appearance_And_Recurrence.sql` — etiket görünümü ve görev tekrarı.
   2. `database/MR_Upgrade_0005_Task_Reminders.sql` — `MR_ReminderSettings` ve `MR_TaskReminderLog`.
   3. `database/MR_Upgrade_0006_Audit_Deactivation.sql` — `DEACTIVATE` denetim eylemi.
   4. `database/MR_Upgrade_0007_Task_Schedule_Change_Requests.sql` — `MR_TaskScheduleChangeRequests`.
   5. `database/MR_Upgrade_0008_Request_Notifications.sql` — ayrı bildirim durumu ve kalıcı görev/proje künyesi.
   6. `database/MR_Upgrade_0009_Task_Activity_Report.sql` — görev denetimi tarih aralığı dizini.
   7. `database/MR_Upgrade_0010_Outlook_Calendar_Subscriptions.sql` — `MR_TaskOutlookSubscriptions` ve güncel Outlook kuyruk alanları. Dağıtımdan önce eski çalışanları durdurup güncel geçişi uygulayın. `0010` betiğinin güncel PR #72 sürümünü zaten uygulayanların 0010'u yeniden çalıştırması gerekmez; yine de aşağıdaki 0011 uygulanmalıdır.
   8. `database/MR_Upgrade_0011_Outlook_Completion_Lifecycle.sql` — tamamlanma askısı/tarihi, iptal nedeni, teslim yöntemi ve ayrılmış tarih. Bütün mevcut 0010 kurulumları için zorunludur.
   9. `database/MR_Upgrade_0012_System_Observability.sql` — Sistem Yönetimi telemetri toplamları, işletim olayları ve otomatik uyarılar.
   10. `database/MR_Upgrade_0013_Corporate_Wbs_Sync_Freshness.sql` — CN43N başarılı tur tazeliği.
   11. `database/MR_Upgrade_0014_Task_Creator_Index.sql` — görev oluşturan Sicil dizini; yetki ve anlık görüntü sorgularında tam tablo taramasını kaldırır.
   12. `database/MR_Upgrade_0015_Assignment_Coordination_And_Presence.sql` — atama koordinasyonu, görev bildirimleri, dayanıklı atama postası kuyruğu ve kullanıcı varlığı tabloları.
   13. `database/MR_Upgrade_0016_Ai_User_Credentials.sql` — Sicil başına şifreli kişisel yapay zekâ API anahtarı tablosu (`docs/YAPAY-ZEKA-PLATFORMU.md`).
   14. `database/MR_Upgrade_0017_Ai_Assistant_Conversations.sql` — Rota AI konuşma geçmişi: Sicil sahipli konuşmalar ve sıralı iletiler (`docs/YAPAY-ZEKA-PLATFORMU.md` §18).
   15. `database/MR_Upgrade_0018_Ai_Message_Evidence.sql` — Rota AI kanıt kaydı: kanıta dayalı yanıtın atıf yaptığı kanıt künyeleri, yanıt iletisine bağlı ve onunla silinir (`docs/YAPAY-ZEKA-ALAN-ARACLARI.md` §13).

   `0005` aşamasında kalmak `MR_TaskScheduleChangeRequests` tablosunu eksik bırakır; uygulama tabloya ulaştığında her tarih değişikliği talebi başarısız olur. `0009` aşamasında kalmak Outlook abonelik tablosunu eksik bırakır; Outlook teslimi `OUTLOOK_SCHEMA_MISSING` bildirir. `0014` aşamasında kalmak koordinasyon, bildirim, posta çıkış kuyruğu ve kullanıcı varlığı tablolarını eksik bırakır; uygulama tamamen kullanılabilir kalır: bölüm dışı atama mevcut doğrudan atama kurallarına döner, zil yalnızca tarih değişikliği taleplerini gösterir, isteğe bağlı atama e-postası etkisiz kalır ve **Aktif Kullanıcılar** hata vermek yerine eksik şemayı bildirir. `0015` aşamasında kalmak `MR_AiUserCredentials` tablosunu eksik bırakır; uygulama tamamen kullanılabilir kalır, kişisel AI anahtarı saklanamaz ve yalnızca varsa kurumsal varsayılan AI anahtarı kullanılır. `0016` aşamasında kalmak Rota AI konuşma tablolarını eksik bırakır; uygulama tamamen kullanılabilir kalır, yalnızca Rota AI paneli modeli çağırmadan veritabanı güncellemesinin (0017) eksik olduğunu bildirir. `0017` aşamasında kalmak `MR_AiMessageEvidence` tablosunu eksik bırakır; `MERGEN_ROTA_AI_TOOLS_ENABLED=true` olduğunda Rota veri kaynağı modeli çağırmadan sabit kullanılamıyor yanıtı döndürür, Sistem Yönetimi 0018 eksikliği uyarısı verir. Kullanıcı yine açıkça Genel sohbet seçebilir. Her yükseltme betiği yinelendiğinde aynı sonucu verir ve mevcut veriyi korur. Uygulamayı dağıtmadan önce gereken yükseltmeleri tamamlayın.
3. MERGEN Rota ana makinesine Microsoft ODBC Driver 18 for SQL Server kurun.
4. Node.js çalıştıracak Windows hesabının gerekli SQL Server izinlerini taşıdığından emin olun.
5. `.env.example` üzerinden `.env.local` oluşturup yalnızca sunucuya ait veritabanı değişkenlerini yapılandırın.
6. `.env.local` içinde Keycloak değişkenlerini yapılandırın ve `docs/KEYCLOAK-SSO.md` içindeki yönlendirme URI'lerini kaydedin. Geliştirme kimliğini yalnızca yerel geliştirme ortamında açın.
7. `npm ci` çalıştırın.
8. `npm run build` çalıştırın.
9. **Outlook teslimi, elle/otomatik hatırlatma veya isteğe bağlı atama e-postası kullanıldığında SMTP zorunludur.** En az `SMTP_HOST` ve geçerli `SMTP_FROM` ile kurumsal SMTP sunucusunun gerektirdiği ayarları yapın. SMTP yalnızca bu üç e-posta işlevi de kullanılmıyorsa isteğe bağlıdır. SMTP olmadan Outlook davetleri kuyrukta kalır ve teslim edilmez. `.env.local` içinde SMTP bloğunu yapılandırın; yalnızca otomatik hatırlatma e-postası isteniyorsa `docs/GOREV-HATIRLATMALARI.md` içinde anlatıldığı gibi zamanlayıcıyı (Windows Task Scheduler veya cron) kaydedin. Yönetici **Sistem Yönetimi → Hatırlatma E-postaları** sekmesinden açana kadar otomatik hatırlatmalar kapalıdır; SMTP yapılandırılınca elle gönder düğmesi çalışır. Outlook teslimi bağımsızdır: Next.js Node başlangıç kancası, hatırlatmalar kapalıyken bile kalıcı kuyruk çalışanını otomatik başlatır; yönetici tıklaması veya işletim sistemi görevi gerekmez. Aynı kanca atama postası çalışanını da başlatır (`MERGEN_ROTA_TASK_MAIL_POLL_MS`, varsayılan 30 saniye); bu çalışan isteğe bağlı “Sorumlulara e-posta bildirimi gönder” çıkış kuyruğunu boşaltır. İşletim sistemi görevi gerektirmez ve kullanıcı kayıtta kutuyu işaretlemedikçe gönderim yapmaz. Node uygulamasını yönetilen hizmet olarak çalışır tutun. Dağıtımdan önce 2. adımdaki gereken yükseltmeleri tamamlayın. Bkz. `docs/OUTLOOK-TAKVIM.md`.
10. Onaylı Windows/etki alanı hesabıyla `npm run start -- -H 0.0.0.0 -p 8008` (veya `npm run start:prod`) başlatın. MERGEN Rota 8008 portunu kullanır; 8009 MERGEN Bilge'ye aittir.
11. **Gerçek Sistem** seçip yetkilendirmeyi ve kalıcılığı doğrulayın.

Geliştirme aşaması şemasını kaldırmak için `database/MR_Rollback_Durable_Persistence.sql` çalıştırın. **Geri alma bütün MR_* uygulama verilerini kalıcı olarak siler.** Üç kurumsal kaynak tablosunu değiştirmez.

## Yerel sürücünün yüklenmesi

`src/server/db/driver.js`, saf JavaScript `mssql` çekirdeğini statik içe aktarır (tür sabitleri, `ISOLATION_LEVEL`); yerel `mssql/msnodesqlv8.js` sürücüsünü ilk bağlantıda **ihtiyaç anında** yükler. İki havuz (`pool.js`, `corporateWbsPool.js`) aynı tek sürücü çözümlemesini paylaşır. İki paket de aynı `lib/base` tanımlarını yeniden dışa aktardığından tür sabitleri özdeştir.

İhtiyaç anında yükleme zorunludur; görsel tercih değildir. Modül düzeyinde `import` ile `mssql/msnodesqlv8.js` içe aktarımı, yerel bağlamanın derlenmediği her makinede (Linux CI, `--ignore-scripts` ile kuran iş istasyonu) API rotalarının sayfa verisi toplanırken `next build` hatasına yol açar. İhtiyaç anında yüklemeyle derleme her yerde başarılı olur; eksik sürücü derlemeyi çökertmek yerine çalışma zamanında açık Türkçe iletiyle `DATABASE_UNAVAILABLE` (503) üretir.

`package-lock.json`, `msnodesqlv8` çözümlemesini içermelidir. Kilit dosyasında yoksa `npm ci` doğrudan başarısız olur ve makinede SQL sürücüsü bulunmaz. `test/mergen-rota-critical-fixes.test.mjs` iki değişmezi de korur.

## Yerel sürücü kurulumunda sorun giderme

`npm install` veya `npm ci`, `Could not find any Visual Studio installation to use` bildirirse önceden derlenmiş `msnodesqlv8` ikilisi yapılandırılan npm kayıt deposu veya vekilinden sağlanamamış, npm yerel derleme denemiştir. Onaylı çözümlerden birini uygulayın:

1. BT'den onaylı Node.js x64 sürümüne uygun önceden derlenmiş `msnodesqlv8` ikilisini aynalamasını/sağlamasını isteyin; veya
2. BT'den derleme makinesine **Desktop development with C++**, MSVC araçları ve Windows SDK ile Visual Studio 2022 Build Tools kurmasını isteyin.

Tam Visual Studio IDE kurulumu gerekmez. Hatayı aşmak için `.env.local` dosyasına Windows parolası veya SQL oturumu eklemeyin.

## Çevrimdışı/kurum içi işletim

Çalışma zamanı tamamen kurum içinde kalır. CDN, uzak yazı tipi, dış API, uzak JavaScript veya CSS bağımlılığı eklenmez. `mssql` ve `msnodesqlv8`, onaylı kayıt deposu veya iç vekilden kurulan yerel npm bağımlılıklarıdır. Yerel ikililer ve Microsoft ODBC sürücüsü kurum içi yazılım dağıtım sınırında bulunmalıdır.

Node.js 24 kullanılır; Quality CI sürümü `.github/workflows/quality.yml` içinde `24.14.0` olarak sabittir. İlk `npm ci` için onaylı npm registry veya kurum içi proxy erişimi gerekir; kurulan bağımlılıklar çalışma zamanında dış internet gerektirmez. Kaynak Windows UNC paylaşımındaysa komut isteminde önce çalışma dizinine geçin (yer tutucuları kendi ortamınızla değiştirin):

```cmd
pushd "\\<DOSYA_SUNUCUSU>\<PAYLASIM>\MERGEN-Rota"
npm ci
npm run build
npm run start -- -H 0.0.0.0 -p 8008
```

## Doğrulama sınırı

Olağan test paketi saf/statik ve enjekte edilmiş sınırlar kullanır; özel kurumsal SQL Server gerektirmez. İsteğe bağlı canlı doğrulama, `MERGEN_ROTA_DB_INTEGRATION=1` ve geçerli sunucu yapılandırmasıyla ayrıca açılabilir. Başarılı derleme veya benzetilmiş işlem testi, canlı veritabanı doğrulaması olarak sunulmamalıdır.

### Uçtan uca kalıcılık testleri

`test/wbs-and-task-creation-e2e.test.mjs`, bütün Gerçek Sistem zincirini (uygulama durumu → değişiklik düzenleyicisi → istemci API deposu → gerçek rota işleyicileri → sıralı/güçlendirilmiş/temel SQL depoları), bellek içi SQL Server test ikiziyle (`test/helpers/fakeSqlServer.mjs`) çalıştırır. Yalnızca sürücü `src/server/db/driver.js` içindeki `setSqlDriverForTests` noktasıyla değiştirilir; testteki her doğrulama, yetkilendirme ve SQL kurma modülü gerçektir.

İkiz, doğruluk için önemli yerlerde SQL Server gibi davranır: `uniqueidentifier` değerleri büyük harfli metin döner, karşılaştırmalar harf duyarsızdır, RFC 4122 sürüm bitleri olmayan kurumsal GUID'ler aynen saklanır; güncelleme veya silmenin satırı etkilemesi için `rowversion` belirteçleri eşleşmelidir. `test/helpers/actualStack.mjs` zinciri bağlar ve `fetch` çağrılarını rota işleyicilerine yöneltir; `server-only` paketi yalın Node altında hata fırlattığından çözümleme kancasıyla boş modüle yönlendirilir.

Bu yine canlı veritabanı doğrulamasının yerine geçmez: T-SQL metninin kendisi (birleştirme deyimleri, anlık görüntü sorgusu) SQL Server ayrıştırıcısıyla değil, yalnızca sözleşmesi üzerinden sınanır.

Tarih talepleri görev silme işleminden sonra da korunur. Bildirim okuma/temizleme talep/audit verisini değiştirmez. Şema, uç noktalar ve dağıtım ayrıntıları: [Talepler ve bildirimler](TALEPLER-VE-BILDIRIMLER.md).


### Denetim raporlaması

Raporlar → Görev Hareketleri, MR_AuditLog verisini özel yetkili sunucu raporuyla sorgular. Tarayıcıya sınırlı Türkçe hareket satırları verilir; BeforeJson/AfterJson veya sınırsız denetim geçmişi verilmez. UTC zaman damgaları Europe/Istanbul takvim sınırlarıyla süzülür; ilişkilendirilmiş TASK değişiklikleri tek mantıksal eylem oluşturur. Kaydedilen görev anlık görüntüleri yetkili saklanan alanları ve sorumlu Sicillerini içerir. Yetkilendirme, tarihsel kayıtlar ve API parametreleri için [Görev Hareketleri](GOREV-HAREKET-RAPORU.md) belgesine bakın.
