# Outlook takvim bağlantısı

MERGEN Rota görevlerin ana kaynağıdır. **MERGEN Rota → Outlook tek yönlüdür.** Kurum içi/on-premises Exchange’e mevcut SMTP ve iCalendar üzerinden, kullanıcının açık seçimiyle kişisel termin işaretleri gönderilir. Microsoft Graph, Entra ID, EWS, İnternet hizmeti veya posta kutusu okuma yetkisi kullanılmaz. Outlook Tasks/To Do bu tümleştirmenin kapsamı dışındadır.

## Kullanıcı davranışı

Görevi görebilen kullanıcı **Outlook'a Ekle** ile yalnızca kendi hesabı için abonelik açar. Görevi düzenleme yetkisi aranmaz; her istek ve teslimat sunucuda tekrar yetkilendirilir. Alıcı tarayıcıdan alınmaz: doğrulanmış kullanıcının Sicili, HR02 kullanıcı adı ve yapılandırılmış kurumsal dizin üzerinden çözümlenir. Tam ad benzersiz kimlik değildir. Başka kullanıcıların adresleri veya SMTP bilgileri istemciye dönmez. Demo Kip gerçek gönderim yapmaz.

| Durum | Arayüzün anlamı |
| --- | --- |
| Outlook gönderimi bekliyor | Davet/güncelleme kalıcı kuyruktadır; SMTP teslimatı henüz tamamlanmamıştır. |
| Outlook gönderimi başarısız | Son deneme başarısızdır; deneme eşiğine ulaşılana kadar otomatik yeniden deneme sürer. |
| Outlook bağlantısı etkin | Abonelik açıktır ve son davet SMTP altyapısınca kabul edilmiştir. |
| Outlook bağlantısı bekletiliyor | Görev tamamlanmıştır; abonelik tercihi yeniden açılma için korunur. |
| Outlook daveti gönderildi / yeniden gönderildi | Bir teslimat olayıdır; Outlook takvim içeriğinin doğrulanması değildir. |

SMTP kabulü, kullanıcının daveti kabul ettiğini veya kaydın Outlook’ta göründüğünü kanıtlamaz. MERGEN, Decline yanıtını, elle silmeyi veya Outlook’ta yapılan değişiklikleri okuyamaz. **Outlook davetini yeniden gönder**; daveti reddeden, silen veya kaçıran kullanıcıya aynı kimlikli yeni bir ileti sağlar. Değişmeyen içeriğin açık yeniden gönderiminde mevcut teslim edilmiş revizyon kullanılabilir. Tamamlanan görevde ekleme/yeniden gönderme bekletilir; kaldırma kullanılabilir.

**Outlook'tan kaldır** abonelik tercihini kapatır ve gerekli `METHOD:CANCEL` işlemini kuyruğa alır. Bekleyen iptal veya geçici hata tamamlanmış iptal olarak sunulmaz. Uygulama normal HTTP eylemlerinde SMTP beklemez; “gönderildi” yerine kuyruk sonucu gösterir. Son durum görünür sayfada 30 saniyelik yoklama veya odak dönüşüyle yenilenir.

Outlook’ta değiştirilen tarih veya başlık Rota’ya yazılmaz. Rota’dan daha sonra gelen bir güncelleme, Rota’nın yönettiği bu alanlardaki Outlook düzenlemesinin üzerine yazabilir. Güncel görev bilgilerini Rota’da değiştirin.

## Tarih ve takvim gösterimi

Rota **gün düzeyinde** planlama yapar; saat/dakika, başlangıç saati, bitiş saati, randevu süresi veya zaman dilimi seçimi toplanmaz. Outlook'a Ekle sırasında saat sorulmaz; 09:00 veya 17:00 gibi bir saat atanmaz.

Rota’nın planlanan başlangıç–bitiş dönemi Outlook’a çok günlük bir şerit olarak aktarılmaz. Outlook, **Takvim ile aynı `taskCalendarDate()` yardımcısını** kullanır: geçerli `targetFinish`/Termin, yoksa `plannedFinish`. Basit/Kapsamlı Kip için ayrı Outlook tarih yorumu yoktur.

Örneğin 15 Eylül 2026 terminli öğe:

```text
DTSTART;VALUE=DATE:20260915
DTEND;VALUE=DATE:20260916
TRANSP:TRANSPARENT
X-MICROSOFT-CDO-BUSYSTATUS:FREE
X-MICROSOFT-CDO-ALLDAYEVENT:TRUE
```

`DTEND` dışlayıcıdır; tek günlük işaret ertesi günün başlangıcında biter. Kullanıcının tüm iş günü meşgul görünmez. `VALARM` eklenmez; hatırlatmalar Outlook/kullanıcı ilkesi tarafından belirlenir. `DTSTAMP` protokol zaman damgasıdır, görev için seçilen bir saat değildir. RSVP yanıtı istenmez ve yanıt işlenmez.

Her gerçek üretilmiş tekrar görevi kendi TaskId’siyle bağımsız öğedir. Outlook tekrar serisi/master, `RRULE`, `RECURRENCE-ID` veya occurrence/exception eşlemesi üretilmez. Görev oluşturma ya da tekrar üretimi kendiliğinden Outlook aboneliği açmaz.

## Kimlik, içerik ve yaşam döngüsü

`TaskId + UserSicil` için bir kalıcı `MR_TaskOutlookSubscriptions` satırı ve değişmez `CalendarUid` vardır. Tarih/başlık değişikliği aynı UID ile `METHOD:REQUEST` ve daha yüksek `SEQUENCE` üretir. Rota bağlantısı, mevcut davranış gereği hash dışında kalır; yalnız dağıtım adresinin değişmesi bütün kullanıcılara posta göndermez. Görev başlığı, proje künyesi ve kanonik tarih payload/hash karşılaştırmasına girer. Açıklama, sorumlu listesi ve hassas notlar davete aktarılmaz.

Etiket, yorum, takvimde gösterilmeyen ilerleme değişikliği veya denetim üst verisi için davet gönderilmez. **Tamamlanma/açılma** ise içerikten ayrı bir yaşam döngüsü olayıdır. Yetkiyi etkileyen değişiklikler de yeniden denetim kuyruğu oluşturur; gösterim değişmemişse yeni revizyon gönderilmez.

| Olay | Kalıcı davranış |
| --- | --- |
| İlk ekleme / çift ekleme | Tek abonelik; aynı içerik için ikinci davet yok. |
| Görev tamamlanır; gönderilmiş veya olası gönderilmiş tarih bugün/gelecektir | Aynı UID için CANCEL; `CompletionSuspended=1`, abonelik tercihi etkin kalır. |
| Tamamlanan tarih geçmiştedir | Sırf tamamlanma nedeniyle tarihsel öğeye iptal/güncelleme gönderilmez; abonelik bekletilir. |
| İlk davet hiç gönderilmeden görev tamamlanır | Posta üretmeden bekletilir. |
| Görev yeniden açılır | Tercih hâlâ etkinse aynı UID, daha yüksek SEQUENCE ve güncel kanonik tarih ile REQUEST. |
| Kullanıcı açıkça kaldırır | `CancelRequested=1`, neden `USER_REMOVED`; iptal tamamlanınca abonelik kapanır. |
| Görev silinir / proje devre dışıdır | `TASK_NOT_FOUND` nedeniyle iptal; abonelik kapanır. |
| Görünürlük kaybedilir | `FORBIDDEN` nedeniyle ayrıntısız iptal; abonelik kapanır. |
| Etkin görev kanonik tarihini kaybeder | `NO_CALENDAR_DATE` nedeniyle iptal; abonelik kapanır. |

Tamamlanma sonrası kullanıcı kaldırmışsa, görev silinmişse veya erişim nedeniyle abonelik kapanmışsa yeniden açılma otomatik abonelik kurmaz. Tekrar ekleme açık kullanıcı eylemidir. Aynı görev/Sicil UID’si korunur; kapanmış aboneliğe yeni açık eklemede adresler yeniden çözümlenir. Tamamlanma nedeniyle bekletme adresleri değiştirmez.

Tamamlanma günü görev işlemi sırasında `CompletionDate` alanında kalıcı olarak saklanır. Gün, görevin etkin Rota takviminin `TimeZone` değeriyle hesaplanır; çözümleme sırası görev takvimi → proje takvimi → etkin varsayılan takvimdir. Bu nedenle Node sunucusunun işletim sistemi saat dilimi tamamlanma gününü değiştirmez. Geçersiz/eksik özel takvim dilimi güvenli olarak varsayılan Rota takvim dilimine düşer; eski, tarihi kaydedilmemiş kayıtlar ilk işleme gününü kullanır. Öncelik gönderilmiş takvim tarihindedir; uçuş halindeki/sonucu belirsiz REQUEST için ayrılmış `PendingDate` de dikkate alınır. Böylece görev tarihi değişirken tamamlanması, eski gelecekteki işareti bırakmaz. SMTP kesintisi veya yeniden başlatma ilk iptali ertesi güne ertelediğinde de tamamlanma gününün kararı korunur; başlanmış iptal aynı revizyonla yeniden denenir.

`DeliveredMethod` son SMTP teslimatının REQUEST/CANCEL türünü, `LastCancellationReason` son iptal/bekletme nedenini saklar. Bunlar Outlook’un güncel içeriğini göstermez. `CompletionSuspended`, tamamlanma kaydında kuyrukla aynı işlemde korunur; hızlı tamamla/aç veya çalışan yeniden başlatma bu niyeti kaybettirmez. Yeniden açmada bu işaret yeni REQUEST başarıyla kaydedilene kadar kalır; hemen temizlenmesi değişmeyen içerik denetiminin gerekli daveti atlamasına yol açar. Çalışan yöntemi görevin güncel durumundan seçer. Başarılı güncel kuyruk nesli tamamlandığında askı ve tamamlanma günü temizlenir; yalnız `TASK_COMPLETED` nedeni kaldırılır, diğer iptal nedenleri korunur. Eski bir SMTP tamamlaması daha yeni neslin tamamlanma nedenini temizleyemez.

## Kalıcı kuyruk ve otomatik teslimat

Next.js Node başlangıç kancası `src/instrumentation.js`, her uzun süre çalışan uygulama sürecinde tek Outlook çalışanı başlatır. Derleme ve Edge yürütmesi gönderim başlatmaz. İlk tur başlangıçta, sonraki tur önceki bittikten varsayılan 5 saniye sonra çalışır. Tarayıcı, yönetici düğmesi, hatırlatma anahtarı veya OS zamanlayıcısı Outlook için gerekli değildir. Node uygulaması yönetilen hizmet olarak açık kalmalıdır.

Görev değişikliği ve kuyruk kaydı aynı veritabanı işlemindedir; SMTP task persistence yolunda çağrılmaz. SMTP yokken görev kaydı sürer. Eksik Outlook şeması güvenli biçimde raporlanır; normal görev kaydı eksik isteğe bağlı Outlook şeması yüzünden engellenmez. Veritabanı işlem hataları ayrı kalıcılık hatalarıdır.

- `QueueSeq` her yeni niyeti ayırır. Teslimat sırasında başka bir güncelleme gelirse eski sonuç yeni kuyruk neslini temizlemez.
- `LeaseToken` ve 60 saniyelik `LeaseExpiresAt` tek sahiplik sağlar; kira 20 saniyede bir yenilenir. Yenileme/sahiplik kaybında gönderim durdurulur. Çöken çalışanın işi kira bitince alınabilir.
- SQL `READPAST`/satır kilidi ve koşullu revizyon ayırma; iki çalışan, uygulama örneği ve yönetici tanı turunu aynı sahiplik kurallarında tutar.
- SMTP sonrası SQL sonuç yazımı kaybolursa ayrılmış UID/SEQUENCE/hash aynı denemede yeniden kullanılır. SMTP ile SQL atomik değildir; belirsiz teslimatta aynı davet iletisi tekrar gelebilir. Ayrı UID ile ikinci bir mantıksal öğe oluşturulmaz; gerçek Outlook işleme davranışı kabul testinde doğrulanır.
- `AttemptCount` ve `NextAttemptAt` kalıcıdır: 1, 2, 4… dakika, en çok bir saat geri çekilme. Deneme eşiği dolunca iş silinmez ve HTTP 503 sağlık durumunda görünür kalır, ancak otomatik sahiplenme/yeniden deneme durur. Açık ekleme, yeniden gönderme veya kaldırma eylemi eşiği dolmuş işin deneme sayacını sıfırlar; eşik dolmadan yinelenen bekleyen yeniden gönderme/kaldırma tıklamaları birleştirilir; başarı hata/bekleme durumunu temizler.
- `ForceResend` açık yeniden gönderim niyetidir. Otomatik turlar değişmeyen öğeyi göndermez; açık yeniden gönderim bu kuralın kullanıcı tarafından istenen istisnasıdır.
- Bekleyen işi olmayan, tamamlanma nedeniyle bekletilmeyen etkin abonelikler en erken beş dakika arayla sınırlı gruplarda tekrar yetkilendirilir. Tamamlanmada bekletilen abonelikler periyodik kuyruğa alınmaz. Görev yeniden açıldığında veya ilgili görev/proje değişikliği kuyruğa yazıldığında görünürlük yeniden doğrulanır; yetkisini kaybeden kullanıcıya yeni davet gönderilmez.

Toplu ekleme açık kullanıcı seçimidir; varsayılan üst sınır 25, yapılandırılabilir aralık 1–50’dir. Kimlikler normalleştirilip yinelenenler elenir. Her görev bağımsız yetkilendirilir ve ayrı takvim öğesidir; arayüz tek toplu özet verir, görev başına toast üretmez. Değişmeyen abonelikler yeniden gönderilmez.

## SMTP ve dağıtım

**Outlook teslimatı etkinse SMTP zorunludur.** En az `SMTP_HOST` ve geçerli bir `SMTP_FROM` bulunmalıdır. Diğer bağlantı/kimlik doğrulama ayarları kurumsal SMTP kurallarına uygun olmalıdır. SMTP yalnızca **hem e-posta hatırlatma işlevleri hem Outlook teslimatı kullanılmıyorsa** isteğe bağlıdır. Otomatik hatırlatmanın kapalı olması Outlook için SMTP gereksinimini kaldırmaz; elle hatırlatma da SMTP gerektirir.

SMTP yoksa `SMTP_NOT_CONFIGURED`, bozuksa `SMTP_CONFIG_INVALID` bildirilir; davetler kuyrukta, teslim edilmemiş kalır. Yapılandırma düzeltildikten ve gerekiyorsa uygulama yeniden başlatıldıktan sonra deneme eşiğine ulaşmamış işler otomatik devam eder. Eşiği dolmuş iş için açık ekleme, yeniden gönderme veya kaldırma eylemi deneme durumunu sıfırlar. Hatırlatma ayarını veya yönetici düğmesini açmak çözüm değildir.

Kimlik doğrulamalı SMTP varsayılan olarak şifreli taşıma gerektirir. `SMTP_USE_STARTTLS=false` iken `SMTP_USERNAME`/`SMTP_PASSWORD` ile kimlik doğrulama engellenir; yalnızca açıkça `SMTP_ALLOW_INSECURE_AUTH=true` verilirse izin verilir. Bu istisna kullanıcı adı/parolayı şifrelenmemiş bağlantı üzerinden gönderebilir ve üretim ortamında kullanılmamalıdır.

| Ayar | Anlamı |
| --- | --- |
| `SMTP_HOST`, `SMTP_FROM` | Zorunlu SMTP sunucusu ve geçerli gönderen adresi. |
| `SMTP_PORT` | Varsayılan 587. |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | Kurumsal sunucu kimlik doğrulama istiyorsa gerekli. |
| `SMTP_USE_STARTTLS` | Varsayılan true; kurumsal relay politikasıyla uyumlu olmalı. |
| `SMTP_ALLOW_INSECURE_AUTH` | Varsayılan false; yalnız açıkça kabul edilen yerel/özel test durumlarında STARTTLS olmadan kimlik doğrulamaya izin verir. Üretimde kullanmayın. |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | Varsayılan true; kurumsal kökü `NODE_EXTRA_CA_CERTS` ile tanıtın. |
| `SMTP_TIMEOUT_MS` | Varsayılan 20000 ms. |
| `MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED` | Varsayılan true; geçersiz açık değer güvenli biçimde kapalıdır. |
| `MERGEN_ROTA_OUTLOOK_POLL_INTERVAL_MS` | Varsayılan 5000 ms; 1000–60000 ms. |
| `MERGEN_ROTA_OUTLOOK_BULK_LIMIT` | Varsayılan 25; 1–50. |
| `MERGEN_ROTA_OUTLOOK_OUTBOX_BATCH` | Tur başına varsayılan 25; 1–200. |
| `MERGEN_ROTA_OUTLOOK_MAX_ATTEMPTS` | Varsayılan sağlık eşiği 6; 1–20. Eşik dolunca otomatik yeniden deneme durur; açık kullanıcı eylemi sayacı sıfırlar. |
| `MERGEN_ROTA_OUTLOOK_RUN_BUDGET_MS` | Varsayılan 45000 ms; 1000–240000 ms. |
| `MERGEN_ROTA_PUBLIC_ORIGIN` | Dağıtılmış ortamda zorunlu `https://` kökeni; `/rota` yolunu eklemeyin. Düz HTTP yalnız `localhost`/loopback geliştirme adreslerinde kabul edilir. |
| `NEXT_PUBLIC_MERGEN_ROTA_PUBLIC_BASE_PATH` | Uygulama yolu; örneğin `/rota`. |

Davet bağlantısı yapılandırılmış public origin’den üretilir; dağıtılmış ortamda yalnız HTTPS kökeni kabul edilir. Düz HTTP yalnız yerel geliştirmede `localhost`, `127.0.0.1` veya IPv6 loopback için geçerlidir. Otomatik/elle tanı turunda güvenli köken yoksa bağlantı yazılmaz, iç cron kökeni kullanılmaz. Sunucu sırları `NEXT_PUBLIC_` değişkenlerine konmaz.

Mevcut kurulum için:

1. Veritabanını yedekleyin, eski uygulama çalışanlarını durdurun.
2. Eksik önceki göçleri sırayla tamamlayın; güncel `database/MR_Upgrade_0010_Outlook_Calendar_Subscriptions.sql` uygulanmış olmalıdır. PR #72’nin güncel 0010 sürümü zaten varsa 0010’ı tekrar çalıştırmak gerekmez.
3. **`database/MR_Upgrade_0011_Outlook_Completion_Lifecycle.sql`, ardından `database/MR_Upgrade_0012_System_Observability.sql` çalıştırın.** PR #72/0010 bulunan kurulumlar da bu yeni tamamlanma göçünü uygulamalıdır. Göç yinelenebilir, UID/sıra/abonelikleri korur; eski belirsiz iptaller kendiliğinden yeniden etkinleştirilmez.
4. Yeni kurulumda `database/MR_Create_Durable_Persistence.sql` her iki göçün son şemasını içerir; dolu veritabanında temiz kurulum betiğini kullanmayın.
5. SMTP, kurumsal dizin, ODBC/SQL ve kimlik yapılandırmasını doğrulayın. Ayrıntılar: [Kalıcı kurulum](DURABLE-PERSISTENCE.md), [SMTP/hatırlatmalar](TASK-REMINDERS.md).
6. `npm ci`, `npm run build`, ardından mevcut yönetilen Node hizmetini başlatın. Outlook için OS zamanlayıcısı kurmayın; **yalnız otomatik hatırlatma e-postaları** isteniyorsa mevcut Windows Task Scheduler/cron gerekir.

Özelliği kapatmak için `MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED=false` kullanılır; kalıcı kuyruk silinmez. Tam şema geri alma betiği `MR_Rollback_Durable_Persistence.sql` bütün MR uygulama verilerini siler; Outlook özelliğini kapatmak için kullanılmaz.

## İleti biçimi (MIME)

Davet ve iptal iletileri **tek** bir `multipart/alternative` gövde taşır:

```
Content-class: urn:content-classes:calendarmessage
Content-Type: multipart/alternative
  ├── text/plain
  ├── text/html
  └── text/calendar; charset="UTF-8"; method=REQUEST|CANCEL
```

Takvim içeriğinin **ikinci bir kopyası ek olarak gönderilmez**. Aynı içerik hem
alternatif parçada hem de ayrı bir `application/ics` ekinde taşındığında Outlook
iletiyi takvim öğesi olarak işlemek yerine iki dosya eki gösteriyordu
(`not supported calendar message.ics` ve `mergen-rota.ics`). Tek alternatif
parça, davet ve iptal iletilerinin doğrudan takvim öğesi olarak açılmasını
sağlar. Takvim parçası base64 taşınır: CRLF satır sonları ve Türkçe karakterler
aktarım boyunca bozulmaz. Hatırlatma e-postaları takvim parçası taşımaz ve
yapıları değişmemiştir.

## Yönetici tanısı

Kuyruk, çalışan ve teslimat sağlığı **Sistem Yönetimi → Kuyruklar ve İşler**
sekmesinde izlenir (`docs/SYSTEM-ADMINISTRATION.md`): çalışan nabzı, bekleyen /
hazır / işleniyor / hatalı / deneme eşiğini aşan sayıları, **en eski bekleyen
kayıt yaşı**, en yüksek deneme sayısı, son başarılı teslimat ve bekleyen
kayıtların güvenli künyesi. Kritik UX kuralı: dolu kuyruk kendiliğinden sorun
değildir, YAŞLANAN kuyruk sorundur. Alıcı adresi, takvim kimliği ve ileti
içeriği hiçbir yönetim yanıtında yer almaz.

Aynı sekmedeki iki onaylı eylem güvenlidir: **Şimdi Çalıştır** bekleyen
teslimatları çalışanla aynı kiralı sahiplenme yolundan işler (ikinci davet
üretmez); **Başarısızları Yeniden Dene** yalnızca deneme sayacını ve sonraki
deneme anını sıfırlar — `QueueSeq` ve iCalendar `SEQUENCE` değişmez, kiralı
(süren) teslimata dokunulmaz, böylece eski bir kuyruk kuşağı yeni niyeti ezemez.
Yıkıcı bir "kuyruğu temizle" eylemi bilinçli olarak yoktur.

`POST /api/mergen-rota/reminders/run`, SYSTEM_ADMIN veya mevcut reminder scheduler anahtarıyla sınırlıdır. Hatırlatma ve Outlook turlarını bağımsız başlatır. `reminders.ok=false`, pozitif `failed` veya herhangi bir `results[].status=FAILED`, Outlook başarılı olsa da toplam `ok=false` ve **HTTP 503** üretir. Başarısızlıklar güvenli kodlarıyla gösterilir; bir tarafın başarısı diğerinin hatasını gizlemez. Başarılı/kapalı iki taraf HTTP 200 üretir. Ham SQL, parolalar, adresler veya takvim gövdeleri tanı yanıtına yazılmaz.

Otomatik çalışanda önce SQL bağlantısını edinmek için en çok **15 saniye**, ardından kuyruk işlemleri için `MERGEN_ROTA_OUTLOOK_RUN_BUDGET_MS` (varsayılan **45 saniye**) ayrılır. `completeOutlookDelivery` ve `failOutlookDelivery` işlemlerinin **her biri yeni ve bağımsız 5 saniyelik** sonuçlandırma süresine sahiptir. Böylece sonuç yazımı zaman aşımına uğrasa bile hata ve yeniden deneme zamanı kaydedilebilir. Tek sonuçlandırmayla otomatik turun toplamı **65 saniyeye**, sonuç yazımının ardından hata yazımı da gerekirse **70 saniyeye** kadar çıkabilir. Yönetici tanı ucunun Outlook kuyruk bütçesi 10 saniyedir; bu bütçe bağlantı edinme, sonuçlandırma ve ayrı hatırlatma turunun toplam süresi değildir. Tarayıcı `REQUEST_TIMEOUT` sonucu, işlemin sonucunun henüz doğrulanmadığını belirtir.

SYSTEM_ADMIN-only GET ortak veritabanından pending/due/inFlight/failed/exhausted sayılarını ve **yerel Node sürecinin** son otomatik turunu verir. Son tur bütün sunucuların toplamı değildir. Yönetici ekranı görünürken 15 saniyede yenilenir; kaydedilmemiş hatırlatma taslağı değiştirilmez. Kuyruk tıkanması, çalışan nabzının eskimesi ve deneme eşiğinin dolması ayrıca `OUTLOOK_QUEUE_AGING`, `OUTLOOK_WORKER_STALE` ve `OUTLOOK_DELIVERY_FAILED` işletim uyarıları üretir.

Güvenli tanılar: `SMTP_*`, `NO_RECIPIENT_ADDRESS`, `DATABASE_UNAVAILABLE`, `DATABASE_TIMEOUT`, `DATABASE_DEADLOCK`, `DATABASE_QUERY_FAILED`, `OUTLOOK_LEASE_LOST`, `OUTLOOK_RUN_TIMEOUT`, `OUTLOOK_RETRY_EXHAUSTED`, `OUTLOOK_SCHEMA_MISSING`. Sistem düzeldiğinde eşiğe ulaşmamış satırlar otomatik yeniden denenir; `exhausted` satırlar ise açık ekleme/yeniden gönderme/kaldırma eylemiyle deneme durumu sıfırlanana kadar bekler.

## Kurumsal Exchange/Outlook kabul kontrolü

Aşağıdaki kontroller kurumun gerçek Outlook istemcileri ve Exchange ilkeleriyle yapılır. Uygulama bunların posta kutusu tarafındaki sonucunu okuyamaz. Otomatik testler kurumsal Exchange’e bağlanmaz; iCalendar/MIME, SQL davranışı, outbox ve yerel SMTP taşımasını deterministik sınar.

| Kontrol | Doğrulanacak sonuç |
| --- | --- |
| İlk REQUEST | Kullanıcı eylemi kuyruk yanıtı verir; yönetici olmadan davet ulaşır. VALUE=DATE, ertesi gün DTEND ve FREE gösterimi kontrol edilir. |
| Accept | Kullanıcı kabul ettikten sonra tek öğe görünür; Rota yalnız gönderim/abonelik durumunu gösterir. |
| Decline | Rota “reddedildi” bilgisi uydurmaz; yeniden gönderim yolu kullanılabilir. |
| Outlook’ta elle silme | Rota silmeyi algıladığını iddia etmez; abonelik durumunun anlamı açıktır. |
| Yeniden gönderme | Aynı UID kullanılır; silme/ret sonrası istemcinin yeniden ekleme davranışı gözlenir. |
| Başlık değişikliği | Yeni başlık aynı mantıksal öğeyi günceller; farklı UID oluşmaz. |
| Termin değişikliği | Takvim ile aynı gün, daha yüksek SEQUENCE ve tek günlük FREE öğe. |
| Art arda tarih değişikliği | Son Rota günü görünür; eski mesajların geç işlenmesi ve yinelenen öğeler kontrol edilir. |
| Açık CANCEL | Kaldırma iptali doğru öğeye yönelir; abonelik kapanır. |
| Tamamlanma | Bugün/gelecek öğe CANCEL alır; geçmiş öğe sırf tamamlanma nedeniyle değiştirilmez. |
| Yeniden açılma | Etkin tercih aynı UID ve daha yüksek SEQUENCE ile döner; açıkça kaldırılmış tercih dönmez. |
| Toplu ekleme | Sınır korunur, her görev ayrı öğe, arayüz tek özet; değişmeyen ikinci ekleme yeni posta üretmez. |
| Outlook kapalıyken teslimat | Outlook açıldığında Exchange/istemci ilkesinin işleme davranışı doğrulanır. |
| Geçici SMTP kesintisi | Görev kaydı başarır; davet kalıcı bekler, NextAttemptAt sonrası deneme eşiğine ulaşmadıysa yönetici müdahalesiz toparlanır. |

## Kod ve testler

Kanonik gün: `src/domain/calendar/taskCalendarDate.js`. iCalendar ve içerik/hash: `src/domain/outlook/`. Abonelik, SQL, yaşam döngüsü, çalışan ve güvenli tanı: `src/server/outlook/`. UI: `src/features/outlook/`; yönetici sonuçları: `src/features/reminders/`. Şema ayrıntıları: [DATABASE-SCHEMA.md](DATABASE-SCHEMA.md).

Regresyonlar `test/outlook-calendar-*.test.mjs`, `test/outlook-automatic-delivery.test.mjs`, `test/delivery-run-reporting.test.mjs` ve `test/smtp-delivery-lifecycle.test.mjs` kapsamındadır. Tam doğrulama: `npm test`, `npm run lint`, `npm run build`.

0011 yükseltmesi eski tamamlanmış etkin abonelikleri ilk kez bekletirken aynı işlemde kuyruk işi oluşturur; böylece periyodik tarama dışında kalsalar da gerekli iptal değerlendirilir. Açık kullanıcı iptalleri ve daha önce bekletilmiş abonelikler bu geri doldurmada değiştirilmez; mevcut bekleyen işin deneme durumu korunur.
