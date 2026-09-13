# Sistem Yönetimi ve Üretim Gözlemlenebilirliği

MERGEN Rota'nın **Sistem Yönetimi** sayfası bir yapılandırma dökümü değil, bir
**işletim kokpitidir**. Amaç tektir: sistem yöneticisi tek sayfada, saniyeler
içinde şu soruları yanıtlayabilmelidir.

- MERGEN Rota sağlıklı mı? Sağlıklı değilse ne bozuk?
- Son zamanlarda ne değişti? Başarım kötüleşiyor mu?
- SQL, CN43N, SMTP, kimlik doğrulama ve arka plan çalışanları çalışıyor mu?
- Outlook ya da hatırlatma kuyrukları birikiyor mu? Kim/ne etkileniyor?
- Yönetici hangi güvenli eylemi alabilir? Sistem zaman içinde kararlı mıydı?

**Ürün ilkesi:** sağlıklı sistem sessizdir. Sorun ortaya çıktığında hemen
görünür, tanılanabilir ve eyleme dönüşebilir olmalıdır. Yönetici, neyin bozuk
olduğunu anlamak için kaynak koda bakmak zorunda kalmamalıdır.

---

## 1. Erişim ve yetki

Sayfa kenar çubuğunda **yalnızca `SYSTEM_ADMIN` rolüne sahip kullanıcılara**
gösterilir (`ADMIN_NAV_IDS`). Gizleme tek başına güvenlik DEĞİLDİR:

- Her yönetim ucu (`/api/mergen-rota/admin/system/*`) oturumdan türetilen
  yetkiyi **her istekte** yeniden denetler ve yetkisiz kullanıcıya `FORBIDDEN`
  (`403`) döner (`server/observability/adminRequestContext.js` →
  `assertSystemAdmin`).
- Yönetim sayfası **Temel Kip** ve **Kapsamlı Kip** ayrımından muaftır: rol
  kapılı sayfa, kullanıcı Temel Kipte diye ulaşılamaz olmaz.
- Kullanıcı sayfa açıkken rolünü kaybederse kabuk kullanıcıyı **Özet**'e
  güvenle geri alır.
- Sayfa **projeye değil sisteme** aittir. Bu yüzden üst çubukta seçili proje
  künyesi ve dışa aktarma denetimi gösterilmez (`GLOBAL_NAV_IDS`).

Rol tanımı ve yetki katmanının bütünü için bkz. `docs/AUTHORIZATION-MODEL.md`.

---

## 2. Sekmeler

Hiyerarşi **tek düzeydir**; her sekme kendi içinde bölümlere ayrılır.

| Sekme | Yanıtladığı soru |
| --- | --- |
| **Genel Durum** | Sistem sağlıklı mı, ne bozuk, ne yapmalıyım? |
| **Performans** | Başarım kötüleşiyor mu? Hangi işlem yavaş? |
| **Kuyruklar ve İşler** | Arka plan işleri akıyor mu, tıkanma var mı? |
| **Hatalar ve Olaylar** | Ne oldu, kaç kez oldu, hâlâ sürüyor mu? |
| **Entegrasyonlar** | Bağımlılıklara ulaşabiliyor muyuz? |
| **Hatırlatma E-postaları** | Şablon, plan ve gönderim geçmişi |

Sekmeler erişilebilir sekme anlamlarını kullanır (`role="tablist"/"tab"/
"tabpanel"`, dolaşan `tabindex`, ok tuşları + `Home`/`End`). Etkin sekme
yenilemeler arasında korunur.

Hatırlatma yönetimi **taşınmıştır, çatallanmamıştır**: var olan
`ReminderSettingsView` olduğu gibi altıncı sekmeye gömülür. Yetki, şablon
doğrulama, zamanlayıcı ve SMTP davranışı değişmemiştir
(`docs/TASK-REMINDERS.md`).

---

## 3. Sağlık modeli

Durum anlamları **tek kaynakta** tanımlıdır
(`domain/observability/healthModel.js`) ve sunucu ile istemci aynı modülü
kullanır.

| Durum | Anlamı |
| --- | --- |
| **Sağlıklı** | Ölçüldü ve beklendiği gibi çalışıyor. |
| **Dikkat** | Ölçüldü, çalışıyor ama eşiğe yaklaştı ya da kısmi hata var. |
| **Kritik** | Ölçüldü ve çalışmıyor; kullanıcı etkisi vardır. |
| **Bilinmiyor** | ÖLÇÜLEMEDİ. Sağlıklı sayılmaz. |
| **Yapılandırılmamış** | Bileşen bilinçli olarak kapalı; toplam sağlığı düşürmez. |

**Bayat (stale)** ayrı bir bayraktır: değer ölçülmüştü ama üzerinden beklenenden
uzun süre geçti. Bayat bir bileşenin son bilinen değeri gösterilir, "şu anda
sağlıklı" DENMEZ.

Genel durum bileşenlerden **türetilir** (kodlanmış değildir):

```
Kritik > Dikkat > Bilinmiyor > Sağlıklı
```

Ölçülebilir hiçbir bileşen yoksa sonuç **Bilinmiyor**'dur; boş liste asla
"sağlıklı" değildir. Açık uyarıların ağırlığı da genel duruma katılır.

### Yönetici ne yapmalı?

| Genel durum | İlk adım |
| --- | --- |
| **Kritik** | Genel Durum → *Dikkat Gerektirenler*'in en üstündeki kaydı açın; önerilen eylemi uygulayın. |
| **Dikkat** | Aynı listeyi inceleyin; çoğu koşul kuyruk yaşı ya da eşik aşımıdır. |
| **Bilinmiyor** | Ölçülemeyen bileşeni Entegrasyonlar sekmesinden **Bağlantıyı Test Et** ile deneyin. |
| **Bayat** | Sağlık şeridindeki **Yenile**'yi kullanın; sürüyorsa sunucu/ağ erişimini denetleyin. |

---

## 4. Kalıcı sağlık şeridi

Hangi sekme açık olursa olsun sayfanın üstünde durur ve şunları söyler: genel
durum, çekirdek bileşenlerin (SQL · CN43N · SMTP · Outlook · Kimlik) tek tek
durumu, kritik/uyarı sayısı, son başarılı yenileme anı ve bilginin bayatlayıp
bayatlamadığı. Sorunlu bir bileşene tıklamak ilgili sekmeye götürür.

---

## 5. Genel Durum sekmesi

1. **Sağlık özeti** — durum, kısa açıklama, son yenileme, çalışma süresi.
2. **Dikkat Gerektirenler** — açık uyarılar ve henüz uyarıya dönüşmemiş
   sağlıksız bileşenler; ağırlığa ve tazeliğe göre sıralı. Her kayıt ne
   olduğunu, ağırlığını, bileşenini, ilk/son görülme anını, hâlâ sürüp
   sürmediğini ve **önerilen eylemi** söyler.
3. **Bileşen sağlığı** — uygulama, ana SQL Server, CN43N/kurumsal WBS, kurumsal
   personel/proje kaynağı, kimlik doğrulama, SMTP, Outlook teslimatı, hatırlatma
   hizmeti ve süreç kaynakları. Kart tıklanınca güvenli teknik künye açılır.
4. **İşletim göstergeleri** — API P95, hata oranı, bekleyen/hatalı Outlook
   teslimatı, en eski bekleyen kayıt, son CN43N eşitlemesi, son hatırlatma turu,
   süreç belleği, çalışma süresi.
5. **Mini eğilimler** — gecikme, hata oranı, bellek ve kuyruk derinliği.
6. **Son işletim olayları** — bu sunucunun belleğindeki en yeni satırlar.

Genel Durum isteği bilinçli olarak **hafiftir**: birkaç küçük yoklama sorgusu,
dizinli bir uyarı okuması ve süreç belleğindeki toplamlar. 30 günlük geçmiş bu
uçta okunmaz.

---

## 6. Performans sekmesi

Zaman aralığı **sunucuda sınırlanır**; yalnızca tanımlı dört pencere geçerlidir:
`Son 1 saat`, `24 saat`, `7 gün`, `30 gün`. Tanınmayan değer varsayılana düşer.

- **Özet** — istek sayısı, hata oranı, ortalama, P50/P95/P99, en yavaş gözlem ve
  güncel pencere.
- **Grafikler** — yüzdelik dağılımı, hata oranı, istek hacmi, süreç belleği ve
  Outlook kuyruk derinliği. Ölçüm bulunmayan kovada çizgi **kesilir**; eksik
  veri sıfır gibi çizilmez.
- **Yavaş İşlemler** — işlem adı, sayı, P50/P95/P99, hata oranı ve son görülme;
  başlıktan sıralanır. Listeye giren işlemler **ortalama gecikmeye** göre
  seçilir: toplam süre ölçüt olsaydı yoğun ama hızlı bir uç, düşük hacimli ama
  çok yavaş bir ucu listeden düşürürdü.
- **Kaynaklar** — çalışma zamanı sürümü, platform, RSS, yığın, yığın oranı,
  süreç CPU kullanımı, olay döngüsü gecikmesi, sunucu yükü ve belleği.

**Temel karşılaştırması** yalnızca yeterli örnek varken yapılır (varsayılan 20):
`Snapshot P95: 820 ms · 7 günlük baz: 610 ms · +34%`. Eşik **iki pencere için de**
geçerlidir: az örnekli bir güncel pencereden çıkarılan yüzde de gösterilmez.
Taban penceresi seçilen aralığın **başladığı anda biter**; aksi halde `7g`
seçiminde güncel pencere ile taban aynı kayıtları içerir ve karşılaştırma hep
düz çıkardı. Normal istatistiksel dalgalanma hata olarak etiketlenmez. Taban
sıfırken (ör. geçen hafta hiç hata yokken) oran tanımsızdır; değişim gizlenmez,
"yeni oluştu" olarak bildirilir.

Kovalar arası yüzdelikler **ağırlıklı ortalamadır** ve öyle sunulur: birden çok
kovadan türeyen değerler arayüzde **`≈`** ile işaretlenir. Kesin yüzdelik
yalnızca ham örneklerin durduğu güncel pencerede hesaplanır.

### Ölçülen işlemler

Ölçüm sarmalayıcısı imzayı ve yanıtı değiştirmez, yalnızca süreyi, sonucu ve
ilişkilendirme kimliğini kaydeder. Üretimde kapsanan yüksek değerli yollar:

| İşlem | Karşılığı |
| --- | --- |
| `api.snapshot` | Anlık görüntü + oturum yüklemesi |
| `api.commit` | Değişiklik kümesi kalıcılaştırması |
| `api.session` | Oturum bağlamı |
| `api.reminders.run` / `api.reminders.status` | Hatırlatma turu ve gönderim durumu |
| `api.outlook.state` / `api.outlook.bulk-add` | Outlook durumu ve toplu ekleme |
| `api.admin.reminder-settings[.save]` | Hatırlatma yapılandırması |
| `api.admin.system.*` | Yönetim konsolu uçları |
| `background.outlook.outbox` | Otomatik Outlook turu |
| `background.reminders.run` | Otomatik hatırlatma turu |
| `admin.outlook.run` / `admin.wbs.sync` | Yönetici eylemleri |

Mekanizma genişletilebilir: yeni bir yol `withRouteObservability(...)` ya da
`observeOperation(...)` ile kapsama alınır. HTTP `4xx` istemci kararıdır ve hata
oranına yazılmaz; yalnızca `5xx` sunucu hatası sayılır.

---

## 7. Kuyruklar ve İşler sekmesi

**Kritik kural: dolu kuyruk kendiliğinden sorun değildir; YAŞLANAN ya da tıkanan
kuyruk sorundur.** Bu yüzden sayımların yanında yaş, deneme sayısı ve çalışan
nabzı da öne çıkarılır.

### Outlook takvim teslimatı

Çalışan durumu ve tur aralığı, kuyruk sayıları (bekleyen · hazır · işleniyor ·
hatalı · deneme eşiğini aşan), **en eski bekleyen kayıt** (hiç denenmemiş
kayıtlar için gerçek bekleme süresi), en yüksek deneme sayısı ve son başarılı
teslimat. Bekleyen kayıtların güvenli künyesi tablo hâlinde listelenir: kayıt
numarası, görev referansının kısaltması, işlem (DAVET/İPTAL), deneme sayısı, son
durum değişikliği, sonraki deneme ve son hata kodu. **Alıcı adresi, takvim
kimliği ve ileti içeriği hiçbir koşulda gösterilmez.**

### Hatırlatma turları

Otomatik gönderimin açık/kapalı olması, okunur plan özeti ve son turların
geçmişi (tür, durum, alıcı sayısı, aralık anahtarı, zaman).

### CN43N / kurumsal WBS eşitlemesi

Son eşitleme anı, eşitlenen proje ve düğüm sayısı, tazelik penceresi ve
pencerenin açık olup olmadığı.

### Güvenli yönetici eylemleri

| Eylem | Ne yapar | Koruma |
| --- | --- | --- |
| **Şimdi Çalıştır** (Outlook) | Bekleyen teslimatları hemen işler | Çalışanla aynı kiralı sahiplenme yolu; ikinci davet üretmez |
| **Başarısızları Yeniden Dene** | Deneme sayacını ve sonraki deneme anını sıfırlar | `QueueSeq` ve `SEQUENCE` DEĞİŞMEZ; kiralı (süren) teslimata dokunulmaz |
| **Şimdi Eşitle** (CN43N) | Kurumsal ağacı tazeler | Kaynak yapılandırılmamışsa eylem sunulmaz |
| **Turu Şimdi Çalıştır** (hatırlatma) | Kayıtlı ayarlarla turu başlatır | Var olan `/api/mergen-rota/reminders/run` ucu kullanılır |

Etkisi olan eylemler **iki adımlıdır**: düğme önce onay ister, sonra çalışır.
Aynı eylem süreç içinde eşzamanlı iki kez çalıştırılamaz; ikinci istek `409
CONFLICT` alır.

Bilinçli olarak **"Kuyruğu Temizle" ya da yıkıcı bir sıfırlama eylemi yoktur**:
mevcut mimaride böyle bir işletim gereksinimi kanıtlanmamıştır ve kuyruk
semantiği zaten kendi kendini toparlar.

---

## 8. Hatalar ve Olaylar sekmesi

Ham günlük dökümü **değildir**. Her kayıt kararlı bir **olay kodu**, bileşen,
ağırlık, okunur özet, güvenli tanı ayrıntısı, ilişkilendirme kimliği, ilk/son
görülme anı ve **yineleme sayacı** taşır.

**Ağırlık modeli:** `Bilgi · Uyarı · Hata · Kritik`.

**Yinelenen sorun tek satırda toplanır.** Sekiz yüz özdeş SMTP hatası sekiz yüz
uyarı değil, sayacı sekiz yüz olan tek bir kayıt üretir.

**Süzgeçler:** ağırlık, bileşen, olay kodu, zaman aralığı, uyarı durumu (açık /
çözülenler dâhil) ve metin araması. Liste sayfalanır.

Arama metni **harfi harfine** aranır: `_`, `%` ve `[` gibi karakterler joker
sayılmaz, atılmaz da. `HTTP_500` ya da `TELEMETRY_DATA_DROPPED` araması tam
olarak o kaydı bulur.

**Uyarı yaşam döngüsü:** `Açık → Onaylandı → Çözüldü`.

- **Onay**, uyarının sorumluluğunun alındığını gösterir; koşulu ÇÖZMEZ. Sorun
  sürüyorsa sayaç ilerlemeye devam eder.
- **Çözme** kararını yalnızca sağlık değerlendirmesi verir. Uyarı, "geçerli
  yenilemede görünmediği için" kapanmaz; koşulun gerçekten düzeldiği art arda
  temiz gözlemlerle doğrulanır.

Bir kayda tıklamak, güvenli teknik bağlamı taşıyan bir **ayrıntı çekmecesi**
açar (kod, bileşen, ilişkilendirme kimliği, zamanlar, yineleme, temizlenmiş
bağlam, önerilen eylem).

### Otomatik uyarılar

| Olay kodu | Koşul |
| --- | --- |
| `DATABASE_UNAVAILABLE` | Ana veritabanı yoklaması başarısız |
| `DATABASE_SLOW` | Yoklama yanıtı yavaş |
| `AUTHENTICATION_MISCONFIGURED` | Kurumsal oturum açma yapılandırması eksik |
| `CORPORATE_WBS_STALE` | Son başarılı eşitleme eşikten eski |
| `CORPORATE_WBS_STATUS_UNAVAILABLE` | Eşitleme durumu ÖLÇÜLEMİYOR (okunamadı ya da hiç eşitleme yok) |
| `CORPORATE_WBS_SYNC_FAILED` | Eşitleme başarısız (kayıtlı kod; ölçüm yokluğu bu kodu üretmez) |
| `SMTP_CONFIG_INVALID` | SMTP yapılandırması geçersiz |
| `OUTLOOK_WORKER_STALE` | Çalışan başlamamış ya da nabzı eskimiş |
| `OUTLOOK_QUEUE_AGING` | En eski bekleyen kayıt eşiği aştı |
| `OUTLOOK_DELIVERY_FAILED` | Hatalı / deneme eşiğini aşan teslimat |
| `REMINDER_RUN_FAILED` | Son otomatik hatırlatma turu başarısız |
| `API_ERROR_RATE_HIGH` | Hata oranı eşiği aştı |
| `API_LATENCY_HIGH` | P95 eşiği aştı |
| `MEMORY_PRESSURE` | Süreç yığını sürekli yüksek |
| `TELEMETRY_DATA_DROPPED` | Sınır aşımı nedeniyle telemetrinin bir bölümü kaydedilemedi |

**Ölçülemeyen kural temiz gözlem sayılmaz.** Bir koşulun bu turda görünmemesi
iki ayrı şey olabilir: koşul düzelmiştir ya da hiç ölçülememiştir. Örneği
yetersiz bir pencere ya da okunamayan bir bileşen, açık bir uyarıyı "düzeldi"
diye kapatmaz; çözülme yalnızca iyileşmeyi KANITLAYAN ölçümlerle olur.

**Süreç yeniden başladığında** çırpınma izleyicisi boşalır; bu yüzden kalıcı
olarak açık duran uyarı anahtarları izleyiciye yeniden tohumlanır. Aksi halde
koşulu yeniden başlatma sırasında düzelen bir uyarı sonsuza dek açık kalırdı.

**Çırpınma koruması:** bir koşul, uyarı açılmadan önce üst üste iki
değerlendirme turunda görülmelidir; çözülme de aynı sayıda temiz tur ister.
Eşik uyarıları ayrıca en az 20 örnek olmadan hiç üretilmez — birkaç isteklik bir
pencereden eğilim çıkarılmaz.

Bu kapsamda **e-posta uyarısı ya da dış çağrı sistemi yoktur**; uyarılar
uygulama içindedir.

---

## 9. Entegrasyonlar sekmesi

Kartlar tek soruyu yanıtlar: **MERGEN Rota bağımlılıklarına ulaşabiliyor mu?**

| Entegrasyon | Tür |
| --- | --- |
| MERGEN Rota SQL Server | Ana veritabanı |
| CN43N / kurumsal WBS kaynağı | İkincil SQL Server |
| Kurumsal personel kaynağı (HR02) | Kurumsal görünüm |
| Kurumsal proje kaynağı | Kurumsal görünüm |
| Kurumsal proje sorumluluk kaynağı | Kurumsal görünüm |
| Kimlik doğrulama (Keycloak) | Kurumsal oturum açma |
| SMTP posta sunucusu | Kurumsal posta |
| **Outlook takvim teslimatı** | **SMTP + iCalendar** |

> Outlook tümleştirmesi Microsoft Graph ya da EWS **değildir**; davetler kurum
> içi SMTP üzerinden iCalendar (`METHOD:REQUEST`/`CANCEL`) olarak gönderilir.

Her kart durumu, yapılandırma bilgisini (**Yapılandırılmış** /
**Yapılandırılmamış**), son başarılı etkileşimi, son hatayı ve gecikmeyi
gösterir.

**Yapılandırmanın eksiksizliği erişilebilirlik değildir.** Yoklamayla
denetlenemeyen kartlar (Kimlik, SMTP, Outlook) yalnızca yakın zamanda **başarılı
bir yoklama** varsa *Sağlıklı* olur; hiç denenmemişse ya da son başarı
bayatlamışsa durum *Bilinmiyor*, son deneme başarısızsa *Dikkat* olur. Aksi
halde bağımlılık erişilemez hale geldikten sonra da kart sağlıklı kalırdı.

**Bağlantıyı Test Et** eylemi **yıkıcı değildir**:

- veritabanı ve kurumsal görünüm testleri `SELECT 1` / `TOP (1)` düzeyindedir,
- **SMTP testi ileti GÖNDERMEZ**: yalnızca bağlantı ve `EHLO` el sıkışması
  denenir, `QUIT` ile kapanır. Kimlik doğrulama da denenmez — art arda başarısız
  denemeler kurumsal hesabı kilitleyebilir.
- **Kimlik testi oturum açmaz**: yalnızca ortak anahtar kümesi (JWKS) adresi
  okunur; kimlik bilgisi gönderilmez, hesap kilitlenmez.

Aynı anda **tek test** çalışır: ikinci bir test başlatılabilseydi ilkinin bitişi
bütün düğmeleri erken açar ve yinelenen yoklamalar gönderilebilirdi.

---

## 10. Gerçek zamana yakın davranış

Yönetim konsolu **yoklama** ile tazelenir; WebSocket/SSE eklenmez.

- Sağlık şeridi ve Genel Durum: varsayılan **10 saniye**
  (`MERGEN_ROTA_ADMIN_REFRESH_INTERVAL_MS`).
- Kuyruklar 15 sn, olaylar ve entegrasyonlar 30 sn, Performans 60 sn.
- Aynı kaynak için **iki istek aynı anda gitmez**.
- Sekme gizliyken yoklama **durur**; dönüşte veri bayatsa hemen tazelenir.
- Sökülen bileşenin isteği iptal edilir; geç gelen yanıt uygulanmaz.
- **Geçici hata son geçerli veriyi silmez**: ekranda son bilinen değer kalır,
  üzerine "son yenileme başarısız" bilgisi eklenir ve tazelik damgası
  ilerletilmez.

Bu döngü uygulamanın olağan görev verisi yenilemesinden **bağımsızdır**: yönetim
konsolu anlık görüntü istemez ve kullanıcı durumuna dokunmaz.

---

## 11. Telemetri mimarisi ve saklama

Gözlemlenebilirlik, gözlediği uygulamayı **düşüremez**. Bütün telemetri yazma ve
okuma yolları hata yutar; şema yoksa uçlar çalışmaya devam eder ve durumu açıkça
bildirir.

```
istek / arka plan turu
  └─ observeOperation / withRouteObservability      (ölçüm + ilişkilendirme)
       └─ telemetryRegistry                         (BELLEK: 5 dk kovaları, sınırlı)
            └─ telemetryWorker (60 sn)              (kapanmış kovaları kalıcılaştırır)
                 ├─ MR_TelemetryOperationSamples
                 ├─ MR_TelemetryGaugeSamples
                 ├─ MR_OperationalEvents            (yinelenenler toplanmış)
                 └─ MR_OperationalAlerts            (aç / güncelle / çöz)
```

**Neden bellekte toplanıyor?** Her istek için SQL satırı yazmak, telemetriyi
üretimde yeni bir yük kaynağına dönüştürürdü. Yüksek sıklıklı gözlemler bellekte
beş dakikalık kovalarda toplanır; yalnızca **kapanmış** kovanın özeti yazılır.
Güncel kova açık bırakılır, aynı satır dakikada bir yeniden yazılmaz.

**Bütün sınırlar açıktır:** kova başına işlem adı (120), işlem başına süre
örneği (400, rezervuar örneklemesi), bellekteki kova sayısı (36), bekleyen olay
kuyruğu (200) ve işletim akışı halkası (60). Sınır aşıldığında sayaçlar
çalışmaya devam eder; yalnızca örnek ayrıntısı seyrelir.

**Saklama** varsayılan **30 gündür** (`MERGEN_ROTA_TELEMETRY_RETENTION_DAYS`).
Telemetri turu saatte bir, her turda sınırlı sayıda satır silerek eski kayıtları
temizler; uzun tablo kilidi alınmaz. Çözülmüş uyarılar da aynı pencereye tabidir.

Veritabanı erişilemezken tur bellek ölçümlerini toplamaya devam eder;
kalıcılaştırma bir sonraki tura ertelenir.

---

## 12. Yapılandırılmış günlükler ve ilişkilendirme

Sunucu günlükleri tek bir kapıdan yazılır ve hep aynı alanları taşır:

```json
{"timestamp":"…","level":"ERROR","component":"SMTP","operation":"background.reminders.run",
 "code":"SMTP_SEND_FAILED","correlationId":"…","durationMs":1235,"message":"…","context":{…}}
```

Her istek bir **ilişkilendirme kimliği** üretir ve bunu yanıtın
`x-mergen-rota-correlation-id` başlığında döndürür. Kimlik, o isteğin ürettiği
işletim olaylarında da görünür: yönetici "Commit başarısız" satırından tek bir
kimliğe, oradan da isteğin izine ulaşabilir. İstemciden gelen üst kimlik
yalnızca güvenli biçimdeyse kabul edilir.

---

## 13. Güvenlik ve gizlilik

Telemetri **yeni bir sızıntı yolu değildir**. Tek kanonik temizleyici
(`domain/observability/redaction.js`) hem günlüklerde hem kalıcı olay bağlamında
hem de uç yanıtlarında çalışır:

- **Adı** duyarlı olan alanlar (parola, secret, token, `authorization`, çerez,
  bağlantı dizesi, oturum kimliği…) değerine bakılmadan `[gizlendi]` olur.
- **Değeri** duyarlı desene uyan metinler (bağlantı dizesi, `Bearer …`, JWT,
  `password=…`) anahtarı masum olsa da gizlenir.
- E-posta adresleri maskelenir (`k***@kurum.local`).
- Hata özetleri **yığın izi taşımaz**; yalnızca tür, kararlı kod ve temizlenmiş
  ileti kalır.
- Bağlam derinliği, anahtar sayısı ve metin uzunluğu sınırlıdır.

Yönetim yanıtlarında **hiçbir koşulda** yer almayanlar: parolalar, jetonlar,
çerezler, bağlantı dizeleri, SMTP kimlik bilgileri, iCalendar gövdesi, e-posta
içeriği ve gereksiz alıcı adresleri. Yapılandırma yalnızca "Yapılandırılmış /
Yapılandırılmamış" olarak bildirilir; kimlik doğrulama kartı yalnızca **eksik
ayarların adlarını** gösterir, değerlerini değil.

---

## 14. Veritabanı değişiklikleri

Yeni kurulumda `database/MR_Create_Durable_Persistence.sql` yeterlidir. Mevcut
kurulumda, `0011` uygulandıktan **sonra** sıradaki betik çalıştırılır:

```
database/MR_Upgrade_0012_System_Observability.sql
```

Betik yinelenebilir (idempotent): var olan nesneler yeniden oluşturulmaz.
Sıra denetlenir: `0011_outlook_completion_lifecycle` kaydı yoksa betik hata
verir. Göç tablosunun yalnızca VAR OLMASI sıranın doğruluğunu kanıtlamaz —
`0010`'da duran bir veritabanında betik `0012` nesnelerini kurup kaydı yazar ve
`0011` sessizce eksik kalırdı.

Eklenen tablolar:

| Tablo | İçerik | Anahtar / dizin |
| --- | --- | --- |
| `MR_TelemetryOperationSamples` | İşlem başına 5 dakikalık süre/hata toplamı | PK `(BucketStart, Operation, InstanceId)`, `IX_…_Bucket` |
| `MR_TelemetryGaugeSamples` | Bellek, kuyruk derinliği gibi anlık ölçümler | PK `(BucketStart, MetricKey, InstanceId)`, `IX_…_Metric` |
| `MR_OperationalEvents` | Kalıcı işletim olayları (yinelenenler toplanmış) | `IX_…_OccurredAt`, `IX_…_Component`, `IX_…_Aggregate` |
| `MR_OperationalAlerts` | Açık/onaylı/çözülmüş otomatik uyarılar | **Benzersiz** `UX_…_ActiveKey` (`State <> 'RESOLVED'`), `IX_…_LastSeen` |

`InstanceId` anahtarın parçasıdır: birden çok uygulama süreci aynı kovaya
yazdığında satırlar birbirinin yüzdeliklerini ezmez ve süreç ölçümleri tek bir
seriye karışmaz. `LastFlushId`, işlenmiş bir boşaltmanın belirsiz hata sonrası
yeniden gönderilmesinde sayıların ikinci kez toplanmasını engeller.

Etkin uyarı anahtarı benzersizdir: aynı koşul ikinci bir satır açamaz, yalnızca
sayacı ilerletir. Çözülmüş uyarı geçmişte kalır ve koşul yeniden görülürse yeni
bir kayıt açılır — kesintinin ilk ve son anı ayrı ayrı durur.

Olay tarafında `AggregationKey` aynı işi görür: bellekteki birleştirme yalnızca
tek bir boşaltma turunu kapsadığı için, tur sınırında bölünen aynı sorun kalıcı
tarafta da sınırlı bir pencere içinde tek satıra toplanır. Pencere dışındaki
yineleme yeni satır açar; iki gün arayla yaşanan iki kesinti geçmişte ayrı
durmalıdır.

Geri alma betiği (`MR_Rollback_Durable_Persistence.sql`) bu tabloları da düşürür.

---

## 15. Yapılandırma

Ortam değişkeni sayısı bilinçli olarak azdır; hepsinin makul bir varsayılanı
vardır, hepsi sınırlanır ve **hiçbiri `NEXT_PUBLIC_` ön eki taşımaz**. Yönetim
konsolu bu değerleri yalnızca yetkili uçtan öğrenir.

| Değişken | Varsayılan | Sınır | Anlamı |
| --- | --- | --- | --- |
| `MERGEN_ROTA_TELEMETRY_ENABLED` | `true` | — | Telemetri toplama ve kalıcılaştırma |
| `MERGEN_ROTA_TELEMETRY_RETENTION_DAYS` | `30` | 1–365 | Eğilim/olay saklama süresi |
| `MERGEN_ROTA_ADMIN_REFRESH_INTERVAL_MS` | `10000` | 5000–120000 | Konsol yoklama aralığı |
| `MERGEN_ROTA_ALERT_P95_MS` | `1500` | 100–60000 | P95 gecikme uyarı eşiği |
| `MERGEN_ROTA_ALERT_ERROR_RATE` | `0.05` | 0.001–1 | Hata oranı uyarı eşiği |
| `MERGEN_ROTA_ALERT_QUEUE_AGE_MINUTES` | `15` | 1–1440 | Outlook kuyruk yaşı eşiği |
| `MERGEN_ROTA_ALERT_WBS_STALE_HOURS` | `24` | 1–720 | CN43N eşitlemesinin bayatlama süresi |
| `MERGEN_ROTA_INSTANCE_ID` | makine adı + süreç numarası | 64 karakter | Telemetri satırlarının süreç kimliği |
| `MERGEN_ROTA_TRUST_CORRELATION_HEADER` | `false` | — | Gelen ilişkilendirme başlığına güvenilsin mi |

Geçersiz değer varsayılana düşer; sınır dışı POZİTİF değer sınıra çekilir.
Sıfır ve negatif değer geçerli bir ayar değildir ve alt sınıra çekilmez:
varsayılan kullanılır — `MERGEN_ROTA_TELEMETRY_RETENTION_DAYS=-1` ayarı bir
günlük saklamaya değil, belgelenen 30 güne düşer.

`MERGEN_ROTA_TRUST_CORRELATION_HEADER` varsayılan olarak **kapalıdır**:
ilişkilendirme kimliği sunucuda üretilir. Uygulama doğrudan erişilebildiğinde
istemci kendi kimliğini dayatıp başkasının iziyle aynı gruba düşebilir ya da
kendi isteklerini gizleyebilirdi. Başlık yalnızca onu HER istekte yeniden yazan
güvenilir bir ters vekil sunucunun arkasında açılmalıdır.

---

## 16. Demo Kipi

Sistem Yönetimi üretim gözlemlenebilirliğini gösterir. **Demo Kipinde canlı veri
okunmaz ve üretim uçları hiç çağrılmaz.** Konsolun iskeleti gösterilir, her
sekme "Demo Kipinde kullanılamaz" bilgisiyle açıklanır ve hiçbir değer gerçek
sistem sağlığını temsil ediyormuş gibi sunulmaz. Veri kipleri sessizce
değiştirilmez.

---

## 17. Başarım sözleşmesi

Yönetim konsolu üretimde yeni bir yük kaynağı olmamalıdır:

- On saniyelik yoklama **tam tablo taraması yapmaz**; kurumsal görünüm
  yoklamaları `TOP (1)` varlık denetimidir, sayım yapmaz.
- 30 günlük ham geçmiş her yenilemede yeniden hesaplanmaz; kovalar SQL tarafında
  istenen çözünürlüğe indirgenir ve zaman aralığı sınırlıdır.
- Olay ve kuyruk tabloları sayfalanır; kuyruk ayrıntısı en çok 50 kayıttır.
- Maliyetli veriler yalnızca **etkin sekme** görüntülenirken ve daha seyrek
  yenilenir.
- Bütün yeni telemetri okumaları dizinlidir; N+1 sorgu yoktur.

---

## 18. Sorun giderme

| Belirti | Bakılacak yer |
| --- | --- |
| Grafikler boş, "telemetri tabloları bulunamadı" | `MR_Upgrade_0012_System_Observability.sql` uygulanmamış |
| SQL **Kritik** | Entegrasyonlar → *Bağlantıyı Test Et*; sunucu, kimlik ve ağ erişimi |
| Outlook **Kritik**, çalışan başlamamış | Node sunucusunun başlatma günlüğü; `MERGEN_ROTA_OUTLOOK_CALENDAR_ENABLED` |
| Outlook kuyruğu yaşlanıyor | Kuyruklar → *Şimdi Çalıştır*; hata kodları için Hatalar ve Olaylar |
| Deneme eşiğini aşan teslimatlar | Kuyruklar → *Başarısızları Yeniden Dene* (sonra kök nedeni giderin) |
| CN43N **Dikkat** (bayat) | Kuyruklar → *Şimdi Eşitle*; kaynak veritabanı erişimi |
| SMTP **Yapılandırılmamış** | `.env.local` içindeki `SMTP_HOST` / `SMTP_FROM` |
| Kimlik **Kritik** | Kartın listelediği eksik ayar adları; `docs/KEYCLOAK-SSO.md` |
| Hata oranı yüksek | Performans → *Yavaş İşlemler*; ilgili olay kodları ve ilişkilendirme kimliği |
| Bilgi sürekli **bayat** | Tarayıcı–sunucu erişimi; sunucu günlüğünde `api.admin.system.*` hataları |

---

## 19. İlgili belgeler

- `docs/AUTHORIZATION-MODEL.md` — rol ve yetki katmanı
- `docs/TASK-REMINDERS.md` — hatırlatma şablonu, planı ve gönderim geçmişi
- `docs/OUTLOOK-CALENDAR.md` — takvim teslimatı ve kuyruk semantiği
- `docs/DATABASE-SCHEMA.md` — tablo ve dizin künyesi
- `docs/DURABLE-PERSISTENCE.md` — kalıcılaştırma sınırları

### İnceleme sonrası doğruluk güvenceleri

Olay gezginindeki ağırlık, olay kodu ve metin süzgeçleri uyarılara da uygulanır.
Outlook çalışanının durması ile deneme sınırına ulaşmış teslimatlar ayrı uyarılar
üretir; zamanlayıcı turunda Outlook başarısızsa arka plan ölçümü de başarısızdır.
Bellek baskısı uyarıları uygulama süreç kimliğiyle ayrılır; bir süreç başka bir
sürecin uyarısını çözmez. Uzun makine adlarında otomatik kimliğin PID son eki korunur.

SMTP ve Outlook bağlantı testlerinde bütün aşamalar için toplam altı saniyelik
süre sınırı vardır. Kimlik yoklaması HTTP başarısına ek olarak JSON gövdesinde boş
olmayan bir `keys` dizisi ister. Tek zaman damgalı ölçümler grafikte nokta olarak
çizilir. Gecikmiş olaylar kendilerinden yeni olaylarla birleştirilmez.

0012 betiği mevcut dört tablonun sütun türlerini, boyutlarını, null ve kimlik
özelliklerini; anahtarları, dizin sütunlarını ve etkin benzersizlik koşulunu;
doğrulama kısıtlarını ve varsayılan değerlerini denetler. Uyumsuz şemada işlem
geri alınır ve göç başarı kaydı yazılmaz. Verileri yedekleyip belirtilen şema
uyumsuzluğunu giderdikten sonra betik yeniden çalıştırılmalıdır.

Yenileme ve saklama ek güvenceleri:

- Kaydedilmiş sekme, ilk çizim tamamlandıktan sonra geri yüklenir. Görünürlük
  dönüşü bekleyen yoklamayı yeniden zamanlar; elle ve eylem sonrası yenileme,
  süren isteği bekleyip tek yeni istek başlatır. Açık çekmece son ölçüme bağlanır;
  listeden kaldırılan kayıt çekmecesi kapanır. İlk istek hatası boş başarı sayılmaz.
- Kuyruk yanıtı etkin `configuration.thresholds.queueAgeMinutes` değerini taşır.
  Başarısız Outlook/CN43N eylemleri `ADMIN_ACTION_FAILED` hata olayı üretir,
  yanıtın `ok` alanı `false` olur ve uç **HTTP 503** döndürür (gövde ile ileti
  değişmez); başarılı eylemler bilgi düzeyinde kalır ve HTTP 200 döner.
- Outlook çalışanının durumu kuyruk sayımından **bağımsız** türetilir: nabzı
  bayatlamış bir çalışan, aynı anda deneme eşiğini aşan teslimatlar olsa da kendi
  `OUTLOOK_WORKER_STALE` uyarısını açar. Tur bütçesi nabız sınırını aşabildiği
  için hiç tamamlanmamış ama sınırdan uzun süredir **süren ilk tur** da bayat
  nabızdır: sınır içinde durum `Bilinmiyor`, sınırdan sonra `Kritik` olur.
- Yönetici sayfası genel bir sayfadır; proje ya da kip değişimi konsolu yeniden
  bağlamaz, açık sekme ile süren istek korunur.
- Telemetri yazma/okuma, yarım uygulanmış bir göçte de uygulamayı düşürmez:
  eksik TABLO gibi eksik SÜTUN hatası da `schemaReady: false` olarak bildirilir.
- Uyarı değerlendirmesinin API özeti, kapanmış kovalar bellekten düşürülmeden
  **önce** alınır; boşaltma penceredeki hataları ve gecikmeleri gizlemez.
- Bağlantı testinin süre aşımı `PROBE_TIMEOUT` koduyla bildirilir; genel hata
  adı (`Error`) karta ve son hata koduna yazılmaz.
- Tanı bağlamında yalnız değerler değil **alan adları** da temizlenir.
- Kuyruk yaşı grafiği dakika birimiyle çizilir; sayım serilerinin ekseni tam
  sayı adım kullanır ve yinelenen etiket üretmez.
- Saklama en çok 20 yığın çifti işler; beş saniye dolduğunda yeni yığın başlatmaz.
  Tamamlanmayan temizlik bir sonraki telemetri turunda sürer. Bir saatlik bekleme
  yalnızca temizliğin tamamlandığı doğrulandıktan sonra başlar. Açık uyarılar silinmez.
- Yinelenen olayın okunması ve güncellenmesi/eklenmesi aynı SQL işlemi içindedir;
  hata halinde geri alınır. Eşzamanlı yazıcılar birleştirme kilitlerini paylaşır.
- Olay döngüsü histogramı zamanlanmış ölçüm kaydedildikten sonra sıfırlanır.
  Aralığın başlangıcıyla kesişen beş dakikalık kova korunur; kova içindeki
  gözlemler ayrı ayrı bölünemediğinden sınırdaki özet yaklaşık kalır.
- Ölçülmemiş günlük süresi `null` kalır; boş eğilim değeri sıfır çizilmez.
  500 karakteri aşan tanı metni desen taramasından önce bütünüyle maskelenir;
  böylece hem tarama işi sınırlanır hem kesilmiş kimlik bilgisi taşınmaz.
