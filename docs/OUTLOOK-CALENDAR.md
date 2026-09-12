# Outlook Takvim Tümleştirmesi

Bu belge, MERGEN Rota görevlerinin kullanıcının **kendi Outlook takvimine**
eklenmesini anlatır: tekil ve toplu ekleme, kalıcı abonelik, otomatik
güncelleme, iptal, güvenlik modeli, yapılandırma, dağıtım ve sorun giderme.

Özellik hem **Temel Kip** hem **Kapsamlı Kip** için aynı biçimde çalışır.

---

## 1. Ne kullanılır, ne kullanılmaz

| | |
| --- | --- |
| **Kullanılan** | Kurum içi SMTP (mevcut hatırlatma altyapısının aynısı) + RFC 5545/5546 iCalendar |
| **Kullanılmayan** | Microsoft Graph, Microsoft Entra ID (Azure AD), EWS, herhangi bir bulut hizmeti |
| **İnternet** | **Gerekmez.** Bütün akış kurumsal ağın içindedir. |
| **Yeni bağımlılık** | Yok. iCalendar üretimi ve MIME kurulumu depo içindedir. |

MERGEN Rota, kullanıcının posta kutusuna standart bir **toplantı isteği**
gönderir; Outlook/Exchange bu isteği kendi kurallarıyla takvime yazar. MERGEN
Rota hiçbir zaman kullanıcının takvimini doğrudan okumaz ya da yazmaz.

Akış:

```text
Görev paneli / Görevler tablosu (toplu seçim)
  → kimliği doğrulanmış sunucu ucu
  → görev GÖRÜNÜRLÜK denetimi (SQL)
  → kanonik takvim gösterimi + karma
  → kalıcı abonelik ve gönderim kuyruğu
  → teslimat başladığında alıcı çözümü (Sicil → HR02 → DC01_userr)
  → sürüm ayırma ve takvim kimliklerini koruma
  → iCalendar REQUEST/CANCEL üretimi
  → mevcut SMTP posta hizmeti (text/calendar parçası)
  → kalıcı teslim kaydı
```

---

## 2. Kullanıcı deneyimi

### 2.1 Tek görev

Görev panelinin alt çubuğunda, hatırlatma eyleminin yanında **“Outlook'a Ekle”**
düğmesi durur. Düğme hem **düzenlenebilir** hem **salt okunur** panelde bulunur:
görevi **görebilen** herkes onu kendi takvimine ekleyebilir; görev düzenleme
yetkisi aranmaz.

Ekleme, yeniden gönderme ve kaldırma istekleri SMTP beklemeden kalıcı kuyruğa yazılır. Arayüz önce bekleyen durumu gösterir; SMTP kabulü kaydedilince **“✓ Outlook'a eklendi”** durumuna geçer. Bu durum sıkışık bir menü açar:

- **Outlook davetini yeniden gönder** — aynı randevunun davetini tekrar yollar.
- **Outlook'tan kaldır** — iptal daveti gönderir ve aboneliği kapatır.

Eylem kullanılamıyorsa nedeni **açıkça** yazılır; hiçbir koşulda "gönderildi"
denmez:

| Durum | Arayüz iletisi |
| --- | --- |
| Demo Kip | Outlook takvimi yalnızca Gerçek Sistem verisiyle kullanılabilir. |
| Özellik kapalı | Outlook takvim tümleştirmesi bu kurulumda kapalı. |
| 0010 göçü yok | Outlook takvim şeması kurulmamış. Sistem yöneticinizle görüşün. |
| SMTP yapılandırılmamış | Sunucuda e-posta gönderimi yapılandırılmadığı için Outlook daveti gönderilemez. |
| Görevin termini yok | Görevin termin tarihi yok. Takvime eklemek için önce bir termin girin. |
| Kaydedilmemiş düzenleme | Outlook'a eklemeden önce değişiklikleri Kaydet ile kaydedin. |

### 2.2 Toplu ekleme

**Görevler** sayfasındaki tablonun ilk sütunu seçim kutusudur; başlıktaki kutu
sayfadaki satırların tümünü seçer. Seçim yapıldığında tablonun üstünde sıkışık
bir çubuk belirir:

```text
8 görev seçildi   [Seçilenleri Outlook'a Ekle]                [Seçimi temizle]
```

Tek kullanıcı eylemidir ama **her görev kendi bağımsız iCalendar davetini
alır**: görevler tek bir randevuda birleştirilmez, her biri ayrı ayrı
güncellenebilir ve iptal edilebilir kalır.

Sonuç **tek cümleyle** özetlenir; görev başına bildirim üretilmez:

```text
5 görev gönderim kuyruğuna alındı, 2 görev zaten ekliydi, 1 görev eklenemedi.
```

Toplu uç SMTP gönderimini beklemez; kalıcı kuyruğu yazar ve sonucu hemen döndürür. Davetleri mevcut hatırlatma zamanlayıcısı gönderir. Kısmi hata veya termini olmadığı için atlanan görev varsa seçim korunur; süzgeç dışında kalan görevler seçimden çıkarılır. Arayüz bekleyen, başarısız ve teslim edilmiş durumları ayrı gösterir; açık ekranda 30 saniyede bir ve pencere yeniden odaklandığında yeniler.

Termini olmayan görevler istekten önce ayıklanır ve özetin sonunda söylenir
(“… 1 görev termini olmadığı için atlandı.”).

---

## 3. Kalıcı abonelik

İlişki kalıcıdır ve `Görev + Sicil → Outlook takvim aboneliği` biçimindedir.
Kimlik **Sicil**'dir; tam ad kullanılmaz (aynı ad birden çok kişiye ait olabilir).

Tablo: **`dbo.MR_TaskOutlookSubscriptions`** (göç `0010`).

| Sütun | Anlamı |
| --- | --- |
| `TaskId`, `UserSicil` | İlişkinin kimliği. `UX_MR_TaskOutlookSubs_Task_User` ile **benzersiz**. |
| `CalendarUid` | Randevunun değişmez iCalendar `UID` değeri |
| `Sequence` | Ayrılmış en yüksek revizyon numarası (iCalendar `SEQUENCE`) |
| `IsActive` | Abonelik açık mı |
| `QueueSeq` | Kuyruk sayacı: teslimat sürerken gelen yeni değişiklik kaybolmaz |
| `PendingMethod` | `NULL` = bekleyen iş yok · `REQUEST` = güncelleme · `CANCEL` = iptal |
| `PendingSequence`, `PendingPayloadHash` | Gönderilmek üzere **ayrılmış** revizyon ve içerik parmak izi |
| `DeliveredSequence`, `DeliveredPayloadHash` | Son **başarıyla** teslim edilen revizyon ve parmak izi |
| `DeliveredSummary`, `DeliveredDate` | Son teslimatın künyesi; iptal iletisine görev ayrıntıları eklenmez |
| `AttemptCount`, `NextAttemptAt` | Yeniden deneme sayısı ve en çok bir saatlik üstel geri çekilme |
| `InFlightSince`, `LeaseToken`, `LeaseExpiresAt` | Teslimat başlangıcı, benzersiz sahiplik belirteci ve kalıcı kira bitişi |
| `CalendarAttendee`, `CalendarOrganizer` | İlk gönderim öncesinde saklanan ve abonelik ömrü boyunca korunan takvim adresleri; istemciye verilmez |
| `CancelRequested` | Kullanıcının açık kaldırma isteği; otomatik iptalden ayrıdır |
| `ForceResend` | Yeniden gönderme isteği, sahiplenmeden önce kalıcıdır |
| `DeliveryMayHaveEscaped` | SMTP denemesi kabul edilmiş olabilir; iptalin gerekli olduğunu korur |
| `LastValidatedAt` | Görev değişmese de etkin aboneliklerin sırayla görünürlük taraması |
| `LastDeliveredAt`, `LastFailureCode` | Sorun giderme |
| `RowVersion` | Eşzamanlılık damgası (mimarinin geri kalanıyla aynı) |

**Yabancı anahtar yoktur.** Gerekçe `MR_TaskReminderLog` ve 0008 sonrası
`MR_TaskScheduleChangeRequests` ile aynıdır: görev silindiğinde aboneliğin
**yaşaması** gerekir, çünkü Outlook'a gönderilecek iptal daveti değişmez UID'yi
ve takvim adreslerini bu satırdan okur.

Tablo aynı zamanda dayanıklı bir **gönderim kuyruğudur** (outbox); ayrıntı için
bkz. 8. bölüm.

---

## 4. Değişmez Outlook kimliği

Her abonelik değişmez bir `UID` taşır:

```text
mergen-rota-task-<TaskId>-user-<Sicil>@mergen-rota
```

- Görev **adına** ya da kullanıcının **tam adına** dayanmaz; ikisi de değişebilir.
- GUID küçük harfe indirgenir: SQL Server'ın büyük harfli metni ile istemcinin
  kanonik kimliği aynı UID'yi üretir.
- Aynı Outlook öğesi ömrü boyunca aynı UID ile adreslenir.

Revizyon kuralı:

| Olay | Yöntem | `SEQUENCE` |
| --- | --- | --- |
| İlk ekleme | `REQUEST` | 1 |
| Takvim alanı değişti | `REQUEST` | bir önceki + 1 |
| Aynı içerik yeniden gönderildi | `REQUEST` | **değişmez** |
| Kaldırma / silme / erişim kaybı | `CANCEL` | bir önceki + 1 |

Aynı UID ve artan `SEQUENCE`, standart iCalendar davranışında **güncelleme**
demektir: Outlook ikinci bir randevu açmaz.

---

## 5. Takvim tarihi ve içerik

Takvim tarihi **MERGEN Rota Takvim görünümünün kendi kuralıdır** ve tek bir saf
yardımcıda durur (`src/domain/calendar/taskCalendarDate.js`):

```text
targetFinish (Termin)  →  yoksa plannedFinish  →  yoksa takvime eklenemez
```

Takvim ızgarası ve Outlook daveti **aynı** işlevi çağırır; ikinci bir kural
yoktur. Temel Kip ile Kapsamlı Kip arasında fark yoktur: Temel Kip planı
terminle birlikte yazar, Kapsamlı Kip ayrı bir termin taşır, iki durumda da
görünen gün budur.

Randevu bir **termin kaydıdır**:

- Tüm gün süren olay (`DTSTART;VALUE=DATE`), bitiş **dışlayıcıdır**
  (`DTEND` = termin + 1 gün).
- `TRANSP:TRANSPARENT` ve `X-MICROSOFT-CDO-BUSYSTATUS:FREE`: kullanıcının günü
  meşgul görünmez.
- Uydurma 09:00/17:00 saatleri **yoktur**.
- `VALARM` **eklenmez**; hatırlatıcıyı Outlook/kullanıcı ilkesi yönetir.
- `RSVP=FALSE`: MERGEN Rota yanıt iletisi işlemez, ortak posta kutusu "kabul
  edildi" iletileriyle dolmaz.

İçerik kısa tutulur:

```text
SUMMARY:      MERGEN Rota · <Görev adı>
DESCRIPTION:  Görev: <Görev adı>
              Proje: <Proje kodu · Proje adı>
              Termin: <GG.AA.YYYY>

              MERGEN Rota: <uygulama adresi>
```

**Sorumlu listesi ve notlar bilinçli olarak yazılmaz.** Görev görünürlüğü kısmi
olduğunda eş sorumluların kimliği kullanıcıdan gizlenir; takvim daveti bu sınırı
delmemelidir.

Bağlantının kökeni koda gömülü değildir: sunucu tarafı
`MERGEN_ROTA_PUBLIC_ORIGIN` verilmişse o kullanılır. Davetleri zamanlayıcı gönderdiği için kanonik köken yoksa bağlantı eklenmez. İç servis veya localhost adresi takvime yazılmaz; yol öneki kanonik `NEXT_PUBLIC_MERGEN_ROTA_PUBLIC_BASE_PATH`
mekanizmasından gelir. MERGEN Rota tek sayfalık bir kabuk olduğu için bağlantı
uygulamanın kendisini açar.

---

## 6. Hangi değişiklik Outlook güncellemesi üretir?

Karar **iki katmanlıdır**:

1. **Kayıt anında** (`src/server/outlook/outlookCommitHooks.js`): görevin
   takvim alanları veya görünürlük değiştiğinde kuyruk yazılır. Sorumlu ve manuel proje lideri değişiklikleri görünürlük denetimini yeniden çalıştırır.
2. **Teslimat anında** (`outlookCalendarService.js`): kanonik gösterimin karması
   son teslim edilen karmayla aynıysa **ileti gönderilmez** ve `SEQUENCE`
   ilerlemez.

| Güncelleme üretir | Üretmez |
| --- | --- |
| Görev adı | Etiket / kısa açıklama |
| Termin (`targetFinish`) | Yorum ve notlar |
| Takvimin kullandığı planlanan bitiş | İlerleme yüzdesi |
| Proje kodu / proje adı (proje yeniden adlandırıldığında) | Öncelik, durum |
| Görevin başka projeye taşınması | Denetim üst verisi |

Örnek:

```text
Termin: 15.09.2026   →   METHOD:REQUEST · UID: …  · SEQUENCE:1
Termin: 18.09.2026   →   METHOD:REQUEST · UID: …  · SEQUENCE:2   (aynı randevu güncellenir)
```

Manuel proje değişiklikleri, kurumsal proje eşitlemesindeki ad/etkinlik değişiklikleri ve kabul edilen tarih önerileri kendi veritabanı işlemleri içinde kuyruğa yazılır. Özellik geçici olarak kapatılsa da mevcut aboneliklerin değişiklik ve silme kayıtları birikir; yeniden açıldığında işlenir.

---

## 7. İptal ve yaşam döngüsü

`METHOD:CANCEL` **aynı UID** ve **daha yüksek `SEQUENCE`** ile gönderilir,
`STATUS:CANCELLED` taşır ve abonelik başarıdan sonra kapatılır. İptal iletisi
görev ayrıntısı taşımaz: konu, metin, HTML ve iCalendar özeti geneldir; görev adı, proje, açıklama, bağlantı ve termin eklenmez. `CANCEL` için başlangıç/bitiş alanları isteğe bağlıdır ([RFC 5546 §3.2.5](https://www.rfc-editor.org/rfc/rfc5546.html#section-3.2.5)).

İptal şu durumlarda üretilir:

| Olay | Davranış |
| --- | --- |
| Kullanıcı **Outlook'tan kaldır** dedi | İptal gönderilir, abonelik kapanır |
| Görev **silindi** | Kalıcılık işlemi iptali kuyruğa alır; UID ve adresler abonelik satırından okunur |
| Kullanıcı görevi **artık göremiyor** | Teslimat anında yetki yeniden değerlendirilir; güncelleme yerine iptal gider |
| Görevin projesi **devre dışı** bırakıldı | Aynı biçimde iptal |
| Görevin **termini kaldırıldı** | Takvimde karşılığı kalmadığı için iptal |

Yalnızca hiç teslim edilmediği ve önceki girişimin kaçmış olamayacağı bilinen abonelik (`DeliveredSequence IS NULL` ve `DeliveryMayHaveEscaped = 0`) postasız kapatılır. SMTP DATA kabulü belirsizse aynı UID ile iptal gönderilir. Kesin ilk teslimat reddinde geçici takvim adresleri temizlenir; dizin düzeltildikten sonra yeniden çözülür.

`CancelRequested` açık kaldırmayı korur; görev düzenlemesi bu kararı geri almaz. Otomatik iptaller her yeniden denemede güncel görev/görünürlük durumundan hesaplanır. İptal sürerken görev tekrar geçerli olursa sonraki nesil güncelleme olarak gönderilir. Başarıyla kapatılmış abonelik yeniden eklendiğinde güncel alıcı/düzenleyici çözülür; UID ve artan sürüm korunur.

Görev dışında değişen kurumsal erişim, proje erişimi, yönetici kapsamı ve sistem yöneticisi yetkileri de taranır. Bekleyen işi olmayan etkin abonelikler son doğrulama zamanına göre, beş dakika geçtikten sonra sınırlı gruplar halinde yeniden doğrulanır; dolayısıyla toplam tamamlanma süresi abonelik sayısına, kuyruk yüküne ve zamanlayıcı sıklığına bağlıdır.

Sorumlu listesindeki bir değişiklik, abonelik sahibinin **görünürlüğünü**
etkilemiyorsa aboneliği iptal etmez.

---

## 8. Teslim güvenilirliği (outbox)

**Görev kaydı hiçbir koşulda SMTP'ye bağlı değildir.** Kalıcılık işlemi yalnızca
kuyruk kaydını yazar (`PendingMethod`); posta gönderimi ayrı ve yeniden
denenebilirdir. Posta sunucusu erişilemez olsa da görev kaydı tamamlanır.

Bekleyen teslimatlar **mevcut hatırlatma zamanlayıcısı** tarafından işlenir;
ikinci bir kuyruk altyapısı eklenmez:

```text
POST /api/mergen-rota/reminders/run
  → otomatik hatırlatma turu
  → bekleyen Outlook teslimatları (sınırlı yığın)
```

Yanıt gövdesine `outlook` alanı eklenir:

```json
{ "ok": true, "sent": 0, "outlook": { "enabled": true, "ok": true, "claimed": 3, "sent": 2, "unchanged": 1, "cancelled": 0, "failed": 0 } }
```

Güvenceler:

- **Dayanıklı bekleyen durum** — kuyruk satırdadır, bellekte değil.
- **Sahiplenme** — satırlar `NextAttemptAt, SubscriptionId` sırasında, teslimat başlamadan hemen önce birer birer alınır. `LeaseToken` eski çalışanın yeni sahipliğe yazmasını engeller. 60 saniyelik kira sürüm ayırmada ve gönderim sırasında 20 saniyede bir yenilenir. Sahiplik kaybında SMTP bağlantısı kesilir. Sonuç kaydedildiğinde kira bırakılır; süreç çökerse son yenilemeden bir dakika sonra kayıt geri alınabilir.
- **Kurtarılabilir yeniden deneme** — üstel geri çekilme (1, 2, 4 … dakika, en çok bir saat). `MERGEN_ROTA_OUTLOOK_MAX_ATTEMPTS` deneme durdurma sınırı değildir: eşik aşılmış bekleyen kayıtlar `exhausted` sayısında ve HTTP 503 ile görünür kalır. Adres/SMTP düzeltildiğinde aynı kuyruk otomatik olarak kurtarılır; görünmeyen görev için kullanıcı müdahalesi gerekmez.
- **Tur süre sınırı** — `MERGEN_ROTA_OUTLOOK_RUN_BUDGET_MS` varsayılan 45.000 ms'dir. Süre dolunca SQL istekleri ve SMTP bağlantısı iptal edilir; yeni görev sahiplenilmez. Sonuç/yeniden deneme kaydı için ayrıca kısa, 5 saniyelik bir kapatma süresi ayrılır. `OUTLOOK_RUN_TIMEOUT` HTTP 503 olarak bildirilir; gerekirse süre ayarı ve zamanlayıcı/ters vekil zaman aşımı birlikte artırılır.
- **Sessiz kayıp yok** — başarısızlık `LastFailureCode` ile kayda geçer.
- **Yinelenen mantıksal revizyon yok** — SMTP başarılı olup kayıt
  güncellenemezse, yeniden deneme **aynı** `SEQUENCE` ile aynı daveti gönderir.
- **Kayıp güncelleme yok** — teslimat sürerken gelen yeni değişiklik `QueueSeq`
  ile ayırt edilir ve bir sonraki turda gönderilir.
- **Tek başarısızlık diğer işleri durdurmaz** — her satır bağımsız işlenir. Hatırlatma sorgusu hata verse de Outlook turu denenir. İki turdan biri başarısızsa HTTP 503 döner. Eksik Outlook tablosu/sütunu da başarısızlıktır; SMTP ayar hatası `SMTP_CONFIG_INVALID` olarak ayrılır.
- **SMTP yapılandırılmamışken kuyruk sahiplenilmez**: deneme hakkı boşa harcanmaz.

Bütün tarayıcı eylemleri yalnızca kalıcı kuyruğa yazar. Zamanlayıcı kurulmalıdır; tarayıcının 30 saniyelik HTTP sınırı SMTP süresine bağlı değildir. Teslimat başarısızsa abonelik kalır ve arayüz hata/bekleme durumunu sonraki sorgulamalarda yeniler.

---

## 9. SMTP ve MIME

Mevcut posta katmanı **aynen** kullanılır: `smtpConfig` → `smtpClient` →
`mailService`. İkinci bir SMTP istemcisi yoktur; TLS, kimlik doğrulama ve zaman
aşımı davranışı hatırlatma postalarıyla aynıdır.

`buildMimeMessage` bir `calendar` parçası aldığında yapı genişler:

```text
Content-class: urn:content-classes:calendarmessage
Content-Type: multipart/mixed
 ├── multipart/alternative
 │    ├── text/plain    (base64, UTF-8)
 │    ├── text/html     (base64, UTF-8)
 │    └── text/calendar; charset="UTF-8"; method=REQUEST|CANCEL   (base64)
 └── application/ics; name="mergen-rota.ics"  (ek kopya, base64)
```

- Takvim parçası `multipart/alternative` **içindedir**: Outlook iletiyi ancak bu
  konumda gerçek bir toplantı isteği olarak işler.
- Base64 kodlama CRLF satır sonlarını ve Türkçe karakterleri bozulmadan taşır.
- `method` başlık değeri yalnızca `REQUEST` ya da `CANCEL` olabilir; serbest
  metin kabul edilmez (başlık enjeksiyonu).
- Ek adı sadeleştirilir.
- **`calendar` verilmediğinde ileti eskisi gibi yalın `multipart/alternative`
  kalır**: görev hatırlatma e-postaları değişmez.

Günlükler: takvim içeriği, alıcı adresi ve SMTP parolası **hiçbir zaman**
günlüğe yazılmaz; yalnızca hata kodu tutulur.

---

## 10. Güvenlik modeli

Özellik mevcut yetkilendirme modelini **genişletmez**.

- Sunucu, oturum açmış kullanıcıyı `Sicil` üzerinden doğrular.
- Görev görünürlüğü **her istekte** SQL'de yeniden değerlendirilir; yüklem
  hatırlatma ucundakiyle aynıdır (kurumsal proje erişimi, manuel proje sorumlusu,
  görev oluşturucusu, `FULL`/`READ` proje yetkisi, sorumluluk ya da yönetici
  kapsamı).
- İlk alıcı oturum sahibinin kurumsal Sicil kaydından çözülür. İlk gönderim öncesinde alıcı ve düzenleyici adresi saklanır; kesin ilk ret bunları yeniden çözülebilir bırakır, tamamlanmış iptalden sonraki ekleme yeni adresleri kullanır; sonraki güncelleme/iptaller aynı takvim kimliklerini kullanır. Dizin veya SMTP gönderen adresi değişirse mevcut abonelik otomatik olarak başka posta kutusuna taşınmaz. İstemci hiçbir zaman adres göndermez veya bu adresleri almaz.
- Toplu uç kuralları **her görev için bağımsız** uygular; görünmeyen görev
  kimlikleri sessizce reddedilir, ötekiler işlenmeye devam eder.
- Kimlik doğrulama sonrası gövde akış halinde en fazla 8 KiB okunur; sınır aşılınca akış iptal edilir ve HTTP 413 döner. JSON ayrıştırıldıktan sonra kimlikler normalleştirilip tekilleştirilir ve benzersiz görev sayısı sınırı uygulanır.
- Başka sorumluların adları ve e-posta adresleri tarayıcıya taşınmaz.
- Hata yanıtları SMTP sırlarını ya da ham sunucu hatalarını taşımaz.
- Teslimat anında görünürlüğünü yitirmiş kullanıcıya güncelleme **gönderilmez**;
  onun yerine iptal gider.

Eşzamanlılık **veritabanında** çözülür, React durumunda değil:

| Durum | Koruma |
| --- | --- |
| Çift tıklama / iki sekme | `(TaskId, UserSicil)` benzersiz kısıtı + `InFlightSince` kirası |
| Otomatik güncelleme ile elle yeniden gönderim çakışması | Tek deyimli sürüm ayırma |
| SMTP başarılı, kayıt kesildi | Ayrılmış sürümün yeniden kullanımı |
| İki zamanlayıcı örneği | `READPAST` + kira |

---

## 11. Demo Kip ve otomatik testler

- Arayüz eylemi **yalnızca Gerçek Sistem** verisinde etkindir; Demo Kipte kapalı
  görünür ve nedeni yazılır. Demo verisiyle hiçbir istek gönderilmez.
- Uçlar SQL Server'a ve doğrulanmış oturuma bağlıdır; demo veri kaynağı bu
  uçlara hiç ulaşmaz.
- Otomatik testlerde SMTP taşıması **enjekte edilir**; hiçbir sınama gerçek bir
  posta sunucusuna bağlanmaz.
- SMTP yapılandırılmamışsa kuyruk sahiplenilmez ve arayüz "gönderildi" demez.

Bu, hatırlatma e-postalarındaki ilkenin aynısıdır.

---

## 12. Yapılandırma

Var olan SMTP ayarları yeniden kullanılır (bkz. `docs/TASK-REMINDERS.md` · 8.
bölüm). Özelliğe ait ek ayarlar azdır, tümü **sunucu tarafıdır** ve hiçbiri
gizli bilgi değildir:

```dotenv
MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED=true   # false özelliği kapatır
MERGEN_ROTA_OUTLOOK_BULK_LIMIT=25           # tek istekte en çok görev (1-50)
MERGEN_ROTA_OUTLOOK_OUTBOX_BATCH=25         # turda işlenecek teslimat (1-200)
MERGEN_ROTA_OUTLOOK_MAX_ATTEMPTS=6          # sağlık hatası deneme eşiği (1-20)
MERGEN_ROTA_OUTLOOK_RUN_BUDGET_MS=45000     # toplam tur süresi (1000-240000 ms)
MERGEN_ROTA_PUBLIC_ORIGIN=https://<MERGEN_HOST>   # takvim öğesindeki bağlantının kökeni
```

Toplu sınır **25** seçilmiştir: her görev kendi SMTP iletisini alır ve tek bir
kullanıcı isteği kurumsal posta sunucusunu onlarca eşzamanlı teslimatla
yüklememelidir. Üst sınır 50'dir.

---

## 13. Dağıtım adımları

1. **Veritabanı göçü** — uygulama sürümü dağıtılmadan **önce**:
   ```bash
   sqlcmd -S <SUNUCU> -d <VERITABANI> -b -i database/MR_Upgrade_0010_Outlook_Calendar_Subscriptions.sql
   ```
   Betik yinelenebilirdir; birden çok kez çalıştırılabilir. Temiz kurulumda tablo
   `MR_Create_Durable_Persistence.sql` içinde zaten vardır.
**0010 betiğinin önceki sürümü çalıştırılmışsa bu sürümü yeniden çalıştırın.** Dört yeni sütun var olan abonelikler silinmeden eklenir. Eski teslimatlarda adresler saklanmadığından, mevcut satırlar ilk sonraki gönderimde o anki kurumsal adreslerle tamamlanır.

2. **Yapılandırma** — `.env.local` dosyasına yukarıdaki ayarları ekleyin (SMTP
   ayarları zaten kuruluysa ek bir şey gerekmez).
3. **Uygulamayı dağıtın** ve yeniden başlatın.
4. **Zamanlayıcı** — mevcut hatırlatma turu Outlook kuyruğunu da işler; ayrı bir
   görev tanımlamak gerekmez. Zamanlayıcı kurulmadıysa bkz.
   `docs/TASK-REMINDERS.md` · 9. bölüm.

Geri alma: `database/MR_Rollback_Durable_Persistence.sql` tabloyu da düşürür.
Yalnızca özelliği kapatmak için `MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED=false`
yeterlidir; abonelikler korunur.

---

## 14. Sorun giderme

### “Outlook takvim şeması kurulmamış”
`0010` göçü çalıştırılmamıştır. Uygulama çökmez, özellik kapalı davranır ve
görev kaydı etkilenmez.

### “Kurumsal e-posta adresiniz personel kaydında bulunamadı”
Zincir `Sicil → MR_V_PeopleDirectory.Username → DC01_userr.Name →
EmailAddress` çözülememiştir. Hatırlatma e-postalarındaki tanı adımlarının
aynısı geçerlidir (`docs/TASK-REMINDERS.md` · 11. bölüm). Abonelik silinmez;
adres tanımlandığında kuyruk yeniden dener.

### Davet gitti ama Outlook randevu açmadı
- İletinin `text/calendar` parçası `multipart/alternative` içinde mi?
- `method=REQUEST` başlık değeri var mı?
- Kurumsal posta ağ geçidi takvim parçasını soyuyor olabilir; posta yöneticisine
  ham iletiyi inceletin.

### Güncelleme yeni bir randevu açtı
`UID` değişmişse olur. `MR_TaskOutlookSubscriptions.CalendarUid` değerinin
görev ömrü boyunca sabit kaldığını doğrulayın.

### Beklenmedik güncelleme yağmuru
Randevuya yazılan alanlardan biri toplu olarak değişmiştir (örneğin bir proje
yeniden adlandırıldı). `DeliveredPayloadHash` karşılaştırması gereksiz gönderimi
zaten keser; kuyruk sayısını `MR_TaskOutlookSubscriptions` üzerinden izleyin:

```sql
SELECT PendingMethod, COUNT(*) AS Bekleyen
FROM dbo.MR_TaskOutlookSubscriptions
WHERE PendingMethod IS NOT NULL
GROUP BY PendingMethod;
```

### Teslimat takılı kaldı
```sql
SELECT TOP (50) SubscriptionId, TaskId, UserSicil, PendingMethod,
       AttemptCount, NextAttemptAt, LastFailureCode
FROM dbo.MR_TaskOutlookSubscriptions
WHERE PendingMethod IS NOT NULL
ORDER BY UpdatedAt DESC;
```
`AttemptCount` eşiği aşılmış işler `exhausted` sayısında ve HTTP 503 ile görünür kalır; `NextAttemptAt` geldiğinde yeniden denenir. SMTP/dizin sorununu düzeltin ve zamanlayıcıyı çalıştırın. Görünür görevlerde “Outlook davetini yeniden gönder” eylemi sayacı sıfırlar. Süre hatalarında `MERGEN_ROTA_OUTLOOK_RUN_BUDGET_MS` ile vekil/zamanlayıcı zaman aşımını birlikte gözden geçirin.

---

## 15. Kod haritası

| Dosya | Sorumluluk |
| --- | --- |
| `src/domain/calendar/taskCalendarDate.js` | Takvim tarihinin TEK kuralı (saf) |
| `src/domain/outlook/icalendar.js` | Kaçırma, satır katlama, CRLF, VCALENDAR üretimi (saf) |
| `src/domain/outlook/outlookCalendarPayload.js` | Kanonik gösterim, karma, değişiklik kararı (saf) |
| `src/domain/outlook/outlookMailContent.js` | İletinin metin/HTML yedeği (saf) |
| `src/server/identity/corporateDirectory.js` | Sicil → kurumsal e-posta (hatırlatmalarla ortak) |
| `src/server/mail/mimeMessage.js` | `text/calendar` parçalı MIME kurulumu |
| `src/server/outlook/outlookConfig.js` | Özellik sınırları ve uygulama bağlantısı |
| `src/server/outlook/outlookQueries.js` | SQL sözleşmesi ve eşzamanlılık kararları |
| `src/server/outlook/outlookStore.js` | Abonelik kalıcılığı ve kuyruk işlemleri |
| `src/server/outlook/outlookCalendarService.js` | Ekleme, yeniden gönderme, iptal, toplu ve kuyruk turu |
| `src/server/outlook/outlookCommitHooks.js` | Kalıcılık işlemi içindeki kuyruk kancaları |
| `src/app/api/mergen-rota/tasks/[taskId]/outlook/route.js` | Tekil ekleme / yeniden gönderme / kaldırma ucu |
| `src/app/api/mergen-rota/outlook/tasks/route.js` | Durum ve toplu ekleme ucu |
| `src/features/outlook/outlookPresentation.js` | Kullanılabilirlik ve toplu özet (saf) |
| `src/features/outlook/outlookSubscriptionStore.js` | Ortak istemci durumu |
| `src/features/outlook/OutlookCalendarAction.jsx` | Görev panelindeki eylem |
| `src/features/outlook/OutlookBulkAction.jsx` | Görevler sayfasındaki toplu eylem |

### Testler

| Dosya | Kapsam |
| --- | --- |
| `test/outlook-calendar-icalendar.test.mjs` | iCalendar, MIME, kanonik gösterim, sunum kuralları |
| `test/outlook-calendar-integration.test.mjs` | Abonelik, sürüm, güncelleme, iptal, toplu, yetki, yeniden deneme |
| `test/smtp-delivery-lifecycle.test.mjs` | Yerel SMTP sunucusuyla kesin ret, belirsiz DATA teslimatı ve bağlantı iptali |
| `test/outlook-calendar-ui.test.mjs` | Arayüz durumları ve panel/tablo tümleşmesi |

### Son yaşam döngüsü yükseltmesi

0010 daha önce uygulanmış olsa da güncel dosya bütünüyle tekrar çalıştırılmalıdır. `CancelRequested`, `ForceResend`, `DeliveryMayHaveEscaped`, `LastValidatedAt` ve yeniden doğrulama dizini eklenir. Mevcut `CANCEL` kayıtlarının kaynağı bilinmediği için kullanıcı iptali kabul edilir; önceki ayrılmış/teslim edilmiş sürümler olası teslimat olarak korunur. Göç sırasında eski uygulama çalışanlarını durdurun, göçü tamamlayıp yeni sürümü başlatın. Yeni kurulum betiği de aynı alanları oluşturur.

Geçersiz, açık bir `MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED` değeri özelliği kapatır; yalnızca eksik/boş değer varsayılanı kullanır. iCalendar `URL` alanı HTTP(S) URI olarak yazılır; virgül ve noktalı virgül TEXT kaçışı almaz ([RFC 5545 §3.8.4.6](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.8.4.6)).
