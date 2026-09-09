# Görev Hatırlatma E-postaları

Bu belge hatırlatma e-postası özelliğinin tamamını anlatır: elle gönderim,
otomatik gönderim planı, alıcı çözümü, şablon, SMTP yapılandırması, zamanlayıcı
kurulumu, güvenlik kararları ve sorun giderme.

Özellik hem **Temel Kip** hem **Kapsamlı Kip** için aynı biçimde çalışır.

Aynı SMTP altyapısı **Outlook takvim davetlerini** de taşır; takvim
tümleştirmesi ayrı bir belgede anlatılır: `docs/OUTLOOK-CALENDAR.md`. Bu
belgedeki SMTP yapılandırması ikisi için de geçerlidir ve hatırlatma
e-postalarının biçimi takvim tümleştirmesinden **etkilenmez**: takvim parçası
yalnızca davet iletilerine eklenir.

---

## 1. İki gönderim yolu, tek çekirdek

| Yol | Tetikleyen | Nerede |
| --- | --- | --- |
| **Elle** | Kullanıcı | Görev satırındaki zarf simgesi (silme simgesinin yanında) ve görev panelinin alt çubuğu |
| **Otomatik** | Sunucu zamanlayıcısı | Yönetici tarafından tanımlanan pencere ve sıklığa göre |

İki yol **aynı** çekirdeği kullanır (`src/server/reminders/reminderService.js` ·
`deliverTaskReminder`): alıcı çözümü, şablon üretimi, SMTP hizmeti, doğrulama
ve gönderim geçmişi tek yerde tanımlıdır. İkinci bir uygulama yoktur; böylece
iki yol arasında davranış farkı oluşamaz.

Akış:

```text
Görev arayüzü / zamanlayıcı
  → kimliği doğrulanmış sunucu ucu
  → yetki denetimi
  → görevi yükle
  → sorumluları çöz  (MR_TaskAssignees → MR_V_PeopleDirectory.Username)
  → DC01_userr.EmailAddress
  → yönetici şablonunu güncel görev değerleriyle üret
  → SMTP posta hizmeti
  → kalıcı gönderim kaydı
  → başarı / hata yanıtı
```

---

## 2. Elle hatırlatma

- Zarf simgesi Görevler tablosunda (her iki kip) ve görev panelinin alt
  çubuğunda bulunur; her zaman **silme eyleminin yanındadır**.
- Yalnızca **seçili göreve** uygulanır.
- İstek sürerken düğme kapatılır: art arda tıklamak kopya ileti üretmez.
- Sonuç düğmenin yanında görünür. Başarı **yalnızca** SMTP sunucusu iletiyi
  kabul ettiğinde bildirilir.
- Gönderim görevi **değiştirmez ve silmez**; satır tıklaması da yutulur.
- Otomatik hatırlatma kapalıyken de çalışır.
- Demo kipinde kapalıdır: e-posta yalnızca Gerçek Sistem verisiyle gönderilir.

**Yetki**: kullanıcı görevi **görüyorsa** hatırlatma gönderebilir. Görünürlük
kuralı anlık görüntüyle aynıdır: tam proje yetkisi (`MR_ProjectAccess` üzerinde
`FULL`/`READ`), kendi görevi ya da astına atanmış görev. Elle verilmiş bir
`PARTIAL` proje yetkisi görev kapsamlıdır ve tek başına **başkasının görevine**
posta göndermeye yetmez. Görev atama kapsamı (bkz. `docs/AUTHORIZATION-MODEL.md`)
burada yetki **vermez**: yönetici, göremediği bir görevin sorumlularına posta
gönderemez. Sistem yöneticisi kullanıcı bazlı yetki denetimlerini atlar ama
projenin **etkin** olması gerekir.

Yetki iki kez denetlenir: istek geldiğinde ve gönderime girecek görev satırı
yüklendikten sonra. Görev iki sorgu arasında taşınmış ya da yeniden atanmış
olabilir; eski duruma dayanan bir yetki, artık görülmeyen bir görevin
sorumlularına posta göndermeye yeterdi.

İstemci **alıcı gönderemez**. Uç istek gövdesini hiç okumaz; alıcılar yalnızca
görevin kendisinden türetilir. Aksi hâlde uç açık bir posta rölesine dönüşürdü.

**En küçük aralık.** Aynı kullanıcı aynı göreve **beş dakikada birden** sık elle
hatırlatma gönderemez (`MANUAL_REMINDER_MIN_INTERVAL_MS`). Sınır olmadan, görevi
görebilen herkes uç üzerinde bir döngüyle iş arkadaşlarının posta kutularını
doldurabilir ve kurumsal SMTP aktarıcısını engelletebilirdi. Sınıra takılan
istek `429` ve `retry-after` başlığıyla döner, gönderim kaydı **açmaz** ve ileti
üretmez. Sınır `(TaskId, RequestedBySicil)` başınadır: başka bir yönetici aynı
görev için kendi hatırlatmasını gönderebilir.

---

## 3. Alıcıların çözümü

Zincir kurumsal kaynaklarla tanımlıdır:

```text
MR_TaskAssignees.Sicil
  → MR_V_PeopleDirectory.Username     (HR02 kullanici_adi)
  → DC01_userr.Name
  → DC01_userr.EmailAddress
```

`DC01_userr`, MERGEN Rota veritabanının (`MERGEN_ROTA_DB_DATABASE`) içindedir,
uygulama tarafından **oluşturulmaz ve yazılmaz**; her gönderimde yeniden okunur.
E-posta adresleri görev kayıtlarına **kopyalanmaz**: yetkili kaynak `DC01_userr`
olarak kalır.

Ele alınan durumlar:

| Durum | Davranış |
| --- | --- |
| Birden çok sorumlu | Hepsi çözülür, tek iletide tüm alıcılar |
| Kullanıcı adı tanımsız | Sorun olarak raporlanır (`NO_USERNAME`) |
| `DC01_userr` kaydı yok / adres boş | Sorun olarak raporlanır (`NO_EMAIL`) |
| Bozuk adres | Sorun olarak raporlanır (`INVALID_EMAIL`) |
| Aynı sorumlu iki kez bağlı | Bir kez değerlendirilir |
| İki kişi aynı posta kutusu | Adres bir kez gönderilir (harf duyarsız tekilleştirme) |
| Hiçbir geçerli adres yok | **Gönderilmez**; elle gönderimde neden kullanıcıya yazılır, otomatik turda `NO_RECIPIENTS` koduyla kaydedilir |

Alıcı adresleri tarayıcıya **taşınmaz**; kalıcı kayda da maskelenerek yazılır
(`a***@alan.adi`).

Kullanıcıya dönen uyarılar **kimlik taşımaz**: yalnızca sayı ve neden yazılır
("1 sorumlunun DC01_userr kaydında e-posta adresi yok"). PARTIAL anlık görüntü
kapsam dışı bir eş sorumluyu bilinçli olarak gizler; ayrıntılı iletiyi geri
vermek o kimliği yalnızca hatırlatma göndererek öğrenilebilir kılardı.
Ayrıntılı tanılama sunucuda kalır.

`{{assignees}}` yer tutucusu **bütün** sorumlu satırlarından kurulur: adresi
çözülemeyen bir sorumlu iletide "görevden sorumlu değil" gibi görünmez. Kısmi
alıcı çözümü gönderim geçmişine `PARTIAL_RECIPIENTS` olarak yazılır ve otomatik
tur özetinde ayrıca sayılır.

---

## 4. E-posta içeriği

İleti **çok parçalıdır** (`multipart/alternative`): HTML gövde ve düz metin
karşılığı birlikte gönderilir. Başlıklar RFC 2047 ile kodlanır, gövdeler
base64'tür; Türkçe karakterler konu ve gövdede korunur.

Varsayılan şablon; başlık, kısa bir giriş metni, düzenli bir görev özeti
tablosu, açıklama bölümü ve kısa bir kapanış taşır. Biçimlendirme bilinçli
olarak sadedir: tablo düzeni ve satır içi stiller kullanılır, modern
tarayıcıya özgü CSS'ten kaçınılır — Outlook bu kuralların çoğunu yok sayar.

Şablonda gösterilen bilgiler: görev adı, proje kodu/adı, kısa açıklama,
sorumlular, termin ve **kalan süre**, öncelik, durum, açıklama.

Değeri olmayan alan **uydurulmaz**: nötr bir işaretle (`—`) gösterilir.

---

## 5. Yer tutucular

Yönetici şablonu `{{ad}}` biçiminde yer tutucu kullanır. Yerleştirme
**sunucuda** yapılır; ifade, kod, SQL ya da sunucu şablonu **çalıştırılmaz**.

| Yer tutucu | Anlamı |
| --- | --- |
| `{{task_name}}` | Görev adı |
| `{{project_name}}` | Proje adı |
| `{{project_code}}` | Proje kodu |
| `{{description}}` | Görev açıklaması |
| `{{keyword}}` | Kısa açıklama / etiket |
| `{{assignees}}` | Sorumlular |
| `{{due_date}}` | Termin tarihi |
| `{{remaining_days}}` | Kalan gün sayısı |
| `{{remaining_duration}}` | Kalan süre (okunur: "3 gün kaldı") |
| `{{priority}}` | Öncelik |
| `{{status}}` | Durum |
| `{{app_name}}` | Uygulama adı |
| `{{today}}` | Gönderim günü |

Kurallar:

- Zaman bağımlı değerler (`remaining_days`, `remaining_duration`, `today`)
  **gönderim anında** yetkili görev verisinden hesaplanır; hiçbir yerde
  saklanmaz.
- Dinamik değerler HTML'e **kaçırılarak** yazılır: görev adında `<script>`
  bulunması yalnızca metin üretir.
- **Tanınmayan** yer tutucu değiştirilmez, olduğu gibi kalır ve yönetici
  ekranında uyarı olarak listelenir. Sessizce boş bırakılmaz.
- Yönetici HTML'i kapalı bir etiket/öznitelik kümesine indirgenir. `script`,
  `style`, `iframe`, olay işleyicileri ve `javascript:` bağlantıları hem
  kaydederken hem gönderirken düşer.

---

## 6. Yönetici sayfası

**Hatırlatma E-postaları** sayfası kenar çubuğunda yalnızca sistem
yöneticilerine görünür. Gizleme tek başına güvenlik değildir: uçlar
(`/api/mergen-rota/admin/reminder-settings`) her istekte yetkiyi yeniden
denetler ve yetkisiz kullanıcıya `FORBIDDEN` döner.

Sayfa dört bölümden oluşur:

1. **Otomatik hatırlatma planı** — açık/kapalı, hatırlatma penceresi
   (değer + birim) ve yineleme sıklığı (değer + birim). Altında okunur özet:
   «Otomatik hatırlatmalar termine 7 gün kala başlar ve 2 günde bir yinelenir.»
2. **E-posta şablonu** — konu satırı ve zengin metin gövde düzenleyicisi
   (kalın, italik, altı çizili, başlık, madde/numaralı liste, bağlantı, tablo).
   Desteklenen yer tutucular listelenir.
3. **Önizleme** — örnek değerlerle üretilmiş, temizlenmiş gövde.
4. **Son gönderimler** — tür, durum, alıcı sayısı, aralık anahtarı ve zaman.

Yönetici ayrıca **"Turu şimdi çalıştır"** ile zamanlanmış turu elle
tetikleyebilir (deneme amaçlı).

---

## 7. Otomatik gönderim planı

Kavramlar:

- **Pencere**: termine ne kadar kala hatırlatmanın başlayacağı süre.
  `kalan süre = termin − şimdi`.
- **Sıklık**: pencere içindeyken hatırlatmanın ne sıklıkla yineleneceği.

Birim olarak **gün** ve **saat** desteklenir; değer serbestçe girilir (sabit
bir liste yoktur). Pencere en çok **365 gün** (saat biriminde 8760 saat)
olabilir; daha büyük bir değer bu sınıra **kırpılarak kaydedilir**, böylece
ekranda görünen plan motorun gerçekte uyguladığı planla aynı kalır.

Sıklık pencereden **uzun** olabilir ve sessizce kısaltılmaz: bu durumda pencere
içinde tek bir hatırlatma gönderilir ve yönetici ekranı bunu açıkça yazar.

**Varsayılanlar**: otomatik gönderim **kapalı**, pencere **7 gün**, sıklık
**2 gün**. Kapalı gelmesi bilinçlidir: kurulumdan hemen sonra kimseye habersiz
posta gitmez. Şablon varsayılanı hazırdır ve yönetici hiçbir şey değiştirmese
bile özellik ilk günden çalışır.

Örnek (pencere 7 gün, sıklık 2 gün, termin 20 Ağustos):

| Gün | Kalan | Davranış |
| --- | --- | --- |
| 12 Ağustos | 8 gün | Pencere dışı, gönderim yok |
| 13 Ağustos | 7 gün | Pencereye girer → 1. hatırlatma |
| 15 Ağustos | 5 gün | 2. hatırlatma |
| 17 Ağustos | 3 gün | 3. hatırlatma |
| 19 Ağustos | 1 gün | 4. hatırlatma |
| 20 Ağustos | 0 | Son hatırlatma (termin günü, **kendi aralığı**) |
| 21 Ağustos | — | **Durur** |

Termin günü **kendi aralık anahtarını** taşır (`…|sdue`). Sayısal aralıkla
paylaşılan bir anahtar kullanılsaydı benzersiz `(TaskId, SlotKey)` kısıtı son
hatırlatmayı susturur ve gece yarısından sonra çalışan her tur da "termin
geçti" diye elenirdi. Termin bir **takvim günüdür**: o gün içinde saat kaçta
çalışılırsa çalışılsın son hatırlatma gönderilebilir, gün bittikten sonra
gönderim durur.

### Durma koşulları

Otomatik hatırlatma şu durumlarda **durur**:

- görev tamamlandı (`done`/`completed`),
- görev iptal edildi (`cancelled`),
- görev silindi,
- görevin termini yok,
- termin günü geçildi (o gün bittikten sonra),
- yönetici otomatik gönderimi kapattı — **tur sürerken kapatılsa bile**:
  yapılandırma her adımda yeniden okunur ve kalan adaylar atlanır,
- SMTP yapılandırılmamış: bu durumda tur hiçbir aralığı **sahiplenmez**, aksi
  hâlde tüketilen aralık SMTP sonradan kurulduğunda bir daha gönderilemezdi.

Gecikme (overdue) hatırlatması bu sürümde bilinçli olarak **yoktur**: sınırsız
gecikme postası göndermek kullanıcıyı hatırlatmalara tümüyle sağırlaştırır.
İlke modülü ayrı ve saf tutulduğu için (`src/domain/reminders/reminderPolicy.js`)
ileride gecikme ilkesi eklemek bu PR'ı büyütmeden mümkündür.

### Kopya gönderimin önlenmesi

Her uygun görev için **determinist bir aralık anahtarı** hesaplanır:

```text
<termin> | w<pencere dakika> | f<sıklık dakika> | s<aralık sırası>
<termin> | w<pencere dakika> | f<sıklık dakika> | sdue      (termin günü)
```

Anahtar `MR_TaskReminderLog` üzerindeki benzersiz dizinle (`TaskId`, `SlotKey`,
yalnızca `AUTOMATIC`) sahiplenilir. Sahiplenme **gönderimden önce** yapılır.
Sonuç:

- zamanlayıcı saatte bir çalışsa da günde bir gönderilen hatırlatma 24 kez
  gitmez;
- uygulama ya da sunucu yeniden başlasa bile geçmiş korunur (bellek içi bir
  küme kullanılmaz);
- birden çok uygulama örneği aynı anda çalışsa bile ikinci ekleme veritabanı
  tarafından reddedilir;
- başarısız bir aralık sahiplenilmiş kalır: aynı aralıkta sonsuz yeniden
  deneme yapılmaz, bir sonraki aralıkta yeniden denenir;
- sahiplenilen aralık **her koşulda kapatılır**: beklenmedik bir hata da kaydı
  `FAILED` yapar, böylece geçmişte kalıcı olarak "Sürüyor" görünen ve sorun
  giderilse bile bir daha denenemeyen aralık oluşmaz;
- **terk edilmiş** kayıt kurtarılır. `catch` bloğu yalnızca JavaScript hatalarını
  kapsar; sürecin kendisi dağıtım, yeniden başlatma ya da makine çökmesiyle
  sonlanırsa satır `PENDING` kalıyor, sonraki turlar aralığı "gönderilmiş"
  sayıyor ve o hatırlatma **kalıcı olarak** kayboluyordu. `ABANDONED_CLAIM_MINUTES`
  (30 dakika) süresini aşmış bir `PENDING` satır bu yüzden **yerinde** yeniden
  sahiplenilir (`FailureCode = 'ABANDONED'`); benzersiz dizin korunur, ikinci
  satır açılmaz. Eşik `SMTP_TIMEOUT_MS` değerinin çok üstündedir ki hâlâ süren
  bir gönderim yanlışlıkla ikinci kez sahiplenilmesin.

Aralık sahiplenildikten sonra görev **yeniden yüklenir ve uygunluğu yeniden
değerlendirilir**: tur sürerken tamamlanan, iptal edilen ya da termini değişen
bir görev ileti almaz.

Anahtar termini, pencereyi ve sıklığı da taşır: yönetici ayarları değiştirdiğinde
(ya da görevin termini kaydığında) yeni bir aralık dizisi başlar ve geçmiş
gönderimler yeni planı susturmaz.

Bir görevin gönderimi başarısız olduğunda **tur durmaz**; öteki uygun görevler
işlenmeye devam eder.

Durdurma anahtarı (yöneticinin "otomatik gönderim" kapatması) uzun bir tur
sürerken de geçerlidir: yapılandırma **30 saniyede bir** yeniden okunur. Her aday
için yeniden okumak, yüzlerce adaylı bir turda aynı sayıda gereksiz SQL
gidiş-dönüşü demekti.

---

## 8. SMTP yapılandırması

Bütün değerler **sunucu tarafıdır** ve `.env.local` dosyasından okunur.
Hiçbiri `NEXT_PUBLIC_` ön eki taşımaz; kullanıcı adı ve parola istemci
paketine asla girmez.

```env
SMTP_HOST=smtp.kurum.internal
SMTP_PORT=587
SMTP_USERNAME=<kullanıcı>
SMTP_PASSWORD=<parola>
SMTP_FROM=mergen-rota@kurum.internal
SMTP_FROM_NAME=MERGEN Rota
SMTP_USE_STARTTLS=true
SMTP_TLS_REJECT_UNAUTHORIZED=true
SMTP_TIMEOUT_MS=20000
# Yalnızca BİLİNÇLİ bir istisna için; varsayılan false.
SMTP_ALLOW_INSECURE_AUTH=false
```

`SMTP_HOST` ya da `SMTP_FROM` boşsa gönderim kapalıdır: arayüz bunu açıkça
söyler ve hiçbir zaman "gönderildi" demez. Değerler **çözümlenebilir** de
olmalıdır: bozuk bir `SMTP_PORT`/`SMTP_TIMEOUT_MS`/boole değeri genel bir sunucu
hatasına dönüşmez, `SMTP_CONFIG_INVALID` koduyla ayrıca bildirilir (ortam
değişkeninin içeriği hata iletisine taşınmaz).

`SMTP_FROM` **yapılandırma anında** geçerli bir e-posta adresi olarak doğrulanır.
Eskiden boş olmayan her değer kabul ediliyor, arayüz SMTP'yi "hazır" gösteriyor
ve hata ancak MIME kurulurken genel `SMTP_SEND_FAILED` olarak ortaya çıkıyordu.
Otomatik turda bu, aralık **zaten sahiplenildikten sonra** olduğu için o
hatırlatma değer düzeltilse bile bir daha gönderilemiyordu.

**Şifrelenmemiş kanalda kimlik bilgisi gönderilmez.** `AUTH LOGIN`/`AUTH PLAIN`
kullanıcı adını ve parolayı base64 ile taşır; base64 şifreleme değildir.
`SMTP_USE_STARTTLS=false` yapıldığında bunlar düz TCP üzerinden gidiyordu.
Gönderim artık `SMTP_INSECURE_AUTH` koduyla reddedilir; şifresiz kanalda kimlik
doğrulama yalnızca `SMTP_ALLOW_INSECURE_AUTH=true` ile bilinçli olarak açılır.
STARTTLS yükseltmesinden **önce** düz oturumun dinleyicileri de sökülür, aksi
hâlde el sıkışma baytları eski konuşmaya akabiliyordu.

Protokol akışı, kurumda çalıştığı doğrulanmış Python (`smtplib`) uygulamasının
davranışını birebir yeniden üretir:

```text
EHLO → STARTTLS → EHLO → AUTH (duyurulan mekanizma)
     → MAIL FROM → RCPT TO → DATA → QUIT
```

Çok satırlı EHLO yanıtının **bütün satırları** korunur: yetenekler ara satırlarda
bildirilebilir. Kimlik doğrulama yöntemi yalnızca **duyurulan** mekanizmalardan
seçilir — LOGIN varsa LOGIN, yoksa PLAIN; ikisi de yoksa açık bir
`SMTP_AUTH_UNSUPPORTED` hatası döner. Sunucu hiç AUTH bildirmiyorsa eski LOGIN
yedeği korunur.

Yalnızca e-posta göndermek için Python çalışma zamanı taşınmaz: aynı protokol
Node'un `net`/`tls` modülleriyle konuşulur ve **yeni bir paket bağımlılığı
eklenmez** (`src/server/mail/smtpClient.js`).

Güvenlik ve dayanıklılık:

- parola yalnızca yapılandırmadan okunur; hata iletisine ve günlüğe **yazılmaz**;
- bağlantı, TLS, kimlik doğrulama, zaman aşımı ve gönderim hataları ayrı
  kodlarla döner;
- bağlantı her koşulda (`finally`) serbest bırakılır;
- STARTTLS el sıkışması zaman aşımına uğrarsa bağlantı yıkılır ve hata döner:
  el sıkışmasında duran bir sunucu sıralı otomatik turu süresiz dondurmaz;
- başlıklara satır sonu enjekte edilemez, geçersiz alıcı iletiyi hiç kurdurmaz;
- uzun konu satırı RFC 2047 "encoded-word" dizisine bölünür, `Subject`/`To`/
  `From` başlıkları RFC 5322 kurallarıyla katlanır; özel karakter taşıyan ASCII
  görünen ad (örneğin `MERGEN Rota, PMO`) tırnaklanır;
- sunucu tek bir alıcıyı reddederse gönderim düşmez: kabul edilen alıcılara
  ileti gider, hiçbiri kabul edilmezse gönderim başarısız olur.

---

## 9. Zamanlayıcı kurulumu (dağıtım adımı)

Otomatik tur **sunucu tarafındadır** ve açık bir tarayıcı gerektirmez. Uygulama
zaten Next.js sunucusu olarak çalıştığı için ayrı bir kuyruk altyapısı
eklenmez; tur bir HTTP ucundan tetiklenir:

```text
POST /rota/api/mergen-rota/reminders/run
x-mergen-rota-reminder-key: <MERGEN_ROTA_REMINDER_CRON_SECRET>
```

Anahtar sabit süreli karşılaştırmayla doğrulanır. Anahtar yapılandırılmamışsa
uç **yalnızca** sistem yöneticisi oturumuyla çalıştırılabilir; hiçbir koşulda
kimliksiz erişime açılmaz.

**Windows Görev Zamanlayıcı** (uygulama Windows üzerinde çalışır):

```powershell
# Saatte bir çalışan görev
$key = "<MERGEN_ROTA_REMINDER_CRON_SECRET>"
Invoke-RestMethod -Method Post `
  -Uri "https://<MERGEN_HOST>/rota/api/mergen-rota/reminders/run" `
  -Headers @{ "x-mergen-rota-reminder-key" = $key }
```

**cron** karşılığı:

```cron
0 * * * * curl -fsS -X POST \
  -H "x-mergen-rota-reminder-key: $MERGEN_ROTA_REMINDER_CRON_SECRET" \
  https://<MERGEN_HOST>/rota/api/mergen-rota/reminders/run
```

Turun sık çalışması **güvenlidir**: aralık anahtarı aynı hatırlatmanın ikinci
kez gönderilmesini engeller. Saatte bir çalıştırmak, gün içinde tanımlanan
görevlerin de zamanında hatırlatılmasını sağlar.

Yanıt gövdesi turun özetini taşır: `evaluated`, `sent`, `skipped`, `failed`.

**Aynı tur, bekleyen Outlook takvim teslimatlarını da işler.** Etkin Outlook turunda hata varsa HTTP 503 döner; yanıt içindeki hatırlatma sonucu korunur. Zamanlayıcı takvim bağlantısı için `MERGEN_ROTA_PUBLIC_ORIGIN` kullanır, bu ayar yoksa bağlantıyı eklemez. İkinci bir
zamanlayıcı görevi tanımlamak gerekmez; yanıt gövdesine `outlook` alanı eklenir
(`claimed`, `sent`, `unchanged`, `cancelled`, `failed`). Takvim kuyruğundaki bir
hata hatırlatma turunun sonucunu düşürmez. Ayrıntılar:
`docs/OUTLOOK-CALENDAR.md`.

**Durum kodu turun başlayıp başlamadığını söyler.** Tur hiç başlayamadığında
(örneğin SMTP yapılandırılmamışken) yanıt `503` döner; başarılı turda `200`
gelir. İşletim sistemi zamanlayıcısı yalnızca HTTP durumuna — ya da `curl` çıkış
koduna — bakar, bu yüzden her koşulda `200` dönmek hatırlatmalar tamamen
dururken çalıştırmayı başarılı gösteriyor ve kimse uyarılmıyordu.

---

## 10. Veritabanı

İki tablo eklenir (bkz. `docs/DATABASE-SCHEMA.md`):

- `MR_ReminderSettings` — tek satırlık yönetici yapılandırması (otomatik
  gönderim, pencere, sıklık, konu ve gövde şablonu).
- `MR_TaskReminderLog` — kalıcı gönderim geçmişi; otomatik gönderimde
  `(TaskId, SlotKey)` benzersizdir.

**Dağıtım adımı**: uygulama sürümü yayımlanmadan **önce**
`database/MR_Upgrade_0005_Task_Reminders.sql` çalıştırılır. Betik
yinelenebilirdir, mevcut veriyi değiştirmez, varsayılan şablonu tohumlar ve
otomatik gönderimi kapalı bırakır. Temiz kurulumda aynı şema
`MR_Create_Durable_Persistence.sql` içindedir.

Göç çalıştırılmadan uygulama **çökmez**: yapılandırma okunamadığında varsayılan
şablonla ve kapalı otomatik gönderimle sürer, yönetici sayfası da eksik göçü
açıkça bildirir.

`DC01_userr` zaten vardır; hiçbir betik onu oluşturmaz, değiştirmez ya da
silmez.

---

## 11. Sorun giderme

### "Hatırlatma gönderilemedi … e-posta adresi yok"

Sorumlunun `DC01_userr` kaydı bulunamadı ya da `EmailAddress` alanı boş.
Denetim sırası:

1. `MR_V_PeopleDirectory` içinde kişinin `Username` (HR02 `kullanici_adi`)
   değeri dolu mu?
2. `DC01_userr` içinde `Name` alanı bu kullanıcı adıyla **birebir** eşleşen bir
   satır var mı? (baştaki/sondaki boşluklar kırpılır)
3. O satırın `EmailAddress` alanı dolu ve geçerli mi?

Adresler görev kayıtlarına kopyalanmadığı için kaynaktaki düzeltme bir sonraki
gönderimde geçerli olur; uygulamada bir işlem gerekmez.

### "E-posta gönderimi yapılandırılmamış"

`.env.local` içinde `SMTP_HOST` ve `SMTP_FROM` tanımlı değil. Yönetici sayfası
da bu durumu bir uyarı olarak gösterir.

### SMTP hataları

| İleti | Olası neden |
| --- | --- |
| E-posta sunucusuna ulaşılamadı | Yanlış `SMTP_HOST`/`SMTP_PORT`, güvenlik duvarı |
| Güvenli bağlantı kurulamadı | Sunucu STARTTLS beklemiyor (`SMTP_USE_STARTTLS=false` deneyin) ya da kurumsal kök sertifika yüklü değil — kök sertifikayı `NODE_EXTRA_CA_CERTS` ile tanıtın. **`SMTP_TLS_REJECT_UNAUTHORIZED=false` kullanmayın:** bu ayar saldırganın sunduğu sertifikayı da kabul eder ve ağdaki etkin bir saldırgan hem SMTP kimlik bilgilerini hem de hatırlatma içeriğini alabilir. |
| Kimlik doğrulama başarısız | `SMTP_USERNAME`/`SMTP_PASSWORD` hatalı ya da sunucu kimlik doğrulama beklemiyor (kullanıcı adını boş bırakın) |
| Sunucu iletiyi kabul etmedi | Gönderici adresi yetkisiz, alıcı alan adı reddedildi, ileti boyutu sınırı |

Gönderim kayıtları yönetici sayfasındaki **Son gönderimler** bölümünde durum ve
hata koduyla listelenir. Alıcı adresleri maskelenmiştir.

### Otomatik hatırlatma çalışmıyor

1. Yönetici sayfasında **otomatik hatırlatma açık** mı?
2. Zamanlayıcı ucu çağrılıyor mu? "Turu şimdi çalıştır" ile elle deneyin;
   yanıt `evaluated`/`sent`/`skipped` sayılarını gösterir.
3. `skipped` yüksek ve `reason: ALREADY_SENT` ise aralık zaten gönderilmiştir —
   beklenen davranıştır.
4. `evaluated: 0` ise pencereye giren, açık ve **sorumlusu olan** görev yoktur.
5. Görevlerin **termini** (hedef bitiş) dolu mu? Terminsiz görev otomatik
   hatırlatmaya girmez.
6. `MR_TaskReminderLog` tablosu var mı? Yoksa 0005 göçü çalıştırılmamıştır.

---

## 12. Kod haritası

| Dosya | Sorumluluk |
| --- | --- |
| `src/domain/reminders/reminderTemplate.js` | Yer tutucular, temizleme, varsayılan şablon, üretim (saf) |
| `src/domain/reminders/reminderPolicy.js` | Pencere, sıklık, aralık anahtarı, durma koşulları (saf) |
| `src/domain/reminders/reminderRecipients.js` | Alıcı kuralları ve tekilleştirme (saf) |
| `src/domain/reminders/reminderValues.js` | Görevden şablon değerleri (saf) |
| `src/server/identity/corporateDirectory.js` | Sicil → kurumsal e-posta (Outlook takvimiyle ortak) |
| `src/server/mail/smtpConfig.js` | `.env.local` yapılandırması |
| `src/server/mail/mimeMessage.js` | RFC 5322/2047 ileti kurulumu; isteğe bağlı `text/calendar` parçası |
| `src/server/mail/smtpClient.js` | SMTP protokolü (net/tls) |
| `src/server/mail/mailService.js` | Yeniden kullanılabilir gönderim hizmeti |
| `src/server/reminders/reminderQueries.js` | SQL sözleşmesi |
| `src/server/reminders/reminderStore.js` | Ayarlar, alıcı satırları, aralık sahiplenme, geçmiş |
| `src/server/reminders/reminderService.js` | Elle ve otomatik akışların ortak çekirdeği |
| `src/server/reminders/reminderAccess.js` | Uç yetkilendirmesi |
| `src/features/reminders/TaskReminderButton.jsx` | Elle gönderim eylemi |
| `src/features/reminders/ReminderSettingsView.jsx` | Yönetici sayfası |
| `src/features/reminders/RichTextEditor.jsx` | Zengin metin gövde düzenleyicisi |

Outlook kullanıcı eylemleri kalıcı kuyruğa yazılır ve bu zamanlayıcı tarafından gönderilir. Hatırlatma sorgusu hata verse de Outlook kuyruğu denenir; iki işten biri başarısızsa uç HTTP 503 döndürür. Eksik Outlook şeması, geçersiz SMTP yapılandırması, deneme eşiğini aşmış bekleyen işler ve Outlook tur bütçesinin dolması sağlık hatasıdır. `MERGEN_ROTA_OUTLOOK_RUN_BUDGET_MS` varsayılanı 45.000 ms; ayrıntılar için [Outlook takvimi](OUTLOOK-CALENDAR.md).
