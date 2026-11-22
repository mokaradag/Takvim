# Talepler ve bildirimler

MERGEN Rota Görev Yönetimi, kalıcı talebi kullanıcının geçici bildirim durumundan ayrı tutar. Bu özellik Gerçek Sistem kipinde çalışır; Temel Kip ve Kapsamlı Kip aynı iş akışını kullanır.

Zil TEKTİR ve üç kalıcı kaynağı aynı merkezde toplar:

| Kaynak | Tablo | Ne anlatır |
| --- | --- | --- |
| Tarih değişikliği talebi | `MR_TaskScheduleChangeRequests` | Hedef bitiş önerisi ve kararı |
| Atama koordinasyonu | `MR_TaskAssignmentCoordinations` | Kurum dışı atama talebi/bildirimi ve kararı |
| Atama olayı | `MR_TaskNotifications` | Göreve atandınız / sorumluluğunuz kaldırıldı |

Üçü de aynı okundu/temizlendi anlambilimini kullanır; ikinci bir bildirim altyapısı yoktur.

## Zil ve kalıcı geçmiş

Zil en fazla **8** bildirim önizlemesi gösterir. Önce kullanıcının kararını bekleyen talepler, ardından en yeni bildirimler gelir. Sıralama karar tarihi, yoksa talep tarihi ve eşitlik halinde talep kimliğiyle belirlenir. Sayı rozeti tüm okunmamış bildirimlerin sayısıdır; küçük dikkat noktası ve paneldeki bekleyen sayacı, okunmuş olsa da açık kararları belirtir.

Bir bildirimi açmak onu okundu işaretler. İşaret görev verisini değiştirmediği için tam anlık görüntü yeniden okunmaz: sunucu, işareti yazdığı işlemde güncel zil kutusunu (önizlemeler ve sayaçlar) okuyup döndürür ve yalnızca o uygulanır. Her zil okuması gönderilmeden önce sıra numarası alır; daha önce gönderilmiş bir okumanın geç yanıtı (ör. işaretten önce başlamış otomatik yenileme) daha yeni zil durumunu geri almaz, görev ve proje verisi yine uygulanır. **Okundu işaretle** ve **Görünenleri temizle** yalnızca o an gösterilen bildirimlere uygulanır. Temizlenen bilgilendirmeler zilden kalkar; kullanıcının kararını bekleyen talepler sonuçlanana kadar zilde kalır. Bu işlemler talebi, tarih karşılaştırmasını veya audit kaydını silmez. **Tüm talepleri gör**, Talepler sayfasını açar.

Bildirim durumu kullanıcı ve kayıt kimliğine göre saklanır. Tarih talebi ve atama koordinasyonunda okuma/temizleme, görülen kayıt sürümünü taşır: kayıt sonradan sonuçlanırsa yeni sürüm tekrar okunmamış olur ve gecikmiş bir eski sürüm işlemi yeni kararı temizleyemez. Atama olayı satırı yazıldıktan sonra DEĞİŞMEZ; orada işaretleme tek yönlü ve etkisizdir (idempotent). Bir kişinin okuması diğer kişinin bildirimini hiçbir kaynakta değiştirmez.

Sıralama bütün kaynaklarda ortaktır: önce kullanıcının kararını bekleyenler, sonra en yeni olay. Eşitlikte sunucunun belirlenimci sırası korunur.

## Talepler sayfası

Kenardaki **Talepler** düz bir üst düzey gezinme öğesidir. Sayfa dört sekme içerir; atama koordinasyonu için ayrı bir kenar çubuğu sayfası açılmaz. Gelenler, Gönderdiklerim ve Geçmiş üç kalıcı kaynağı (tarih talebi, atama koordinasyonu, atama olayı) **tek listede** gösterir; kaynaklar kendi tablolarında ve kendi anlamlarıyla kalır, yeni bir bildirim tablosu yoktur:

| Sekme | İçerik | Sayaç |
| --- | --- | --- |
| Gelenler | Kararınızı bekleyen kayıtlar (okunmuş olsa da) ve etkin görevlere ait okunmamış, temizlenmemiş bildirimler: tarih talebi, atama talebi, bölüm dışı atama bildirimi, "Size görev atandı", "Görev sorumluluğunuz kaldırıldı". Kendi açık talebiniz gelen sayılmaz; sonuçlandığında yanıtı gelir | Süzgeçlere uyan kayıt sayısı |
| Gönderdiklerim | Gönderdiğiniz tarih ve atama talepleri (tüm durumlar). Olay bildirimleri ve doğrudan atama bildirimleri (NOTICE) talep sayılmaz | Süzgeçlere uyan kayıt sayısı |
| Geçmiş | Sonuçlanan talepler (kabul, ret, değiştirme, iptal, güncelliğini yitirme; görevi silinen veya projesi kapalı kayıtlar) ve okunmuş/temizlenmiş olanlar dahil **bütün** atama olayları | Süzgeçlere uyan kayıt sayısı; okunma durumundan bağımsızdır |
| Atama Koordinasyonu | Kurum dışı atama talepleri ve bildirimleri (aşağıya bakınız) | Sekmenin kendi süzgeçlerine uyan **tüm** kayıtlar; karar bekleyen sayısı değildir |

**Okundu işareti silme değildir.** Okunan bilgilendirme Gelenler'den çıkar ve Geçmiş'te kalır; karar bekleyen kayıt okunsa da sonuçlanana kadar Gelenler'dedir. **Görünenleri temizle** yalnızca zil önizlemesini boşaltır; kayıt Geçmiş'te kalır. Okunma durumu kabul, ret ya da tamamlanma yerine geçmez: satırdaki **Yeni** etiketi yalnızca okunmamışlığı söyler. Okundu işareti kişiye özeldir.

Arama görev başlığı, proje adı/kodu, talep eden/atayan ve talep notunda çalışır. Proje, tür, talep eden/atayan adı ya da sicili, durum ve kayıt tarihi aralığıyla daraltılabilir. Durum süzgeci yalnızca talepleri (tarih ve atama) kapsar; durumu olmayan atama olayları durum seçildiğinde listelenmez. Başlangıç ve bitiş günleri aralığa dahildir. Sekmeler kesişebilir (ör. sonuçlanan kendi talebiniz hem Gönderdiklerim'de hem Geçmiş'tedir; okunmamış bir atama olayı hem Gelenler'de hem Geçmiş'tedir).

Sunucu varsayılan olarak **25** kayıt döndürür; API sayfa boyutunu 1–100 arasında sınırlar. Sıra belirlenimcidir: önce kararınızı bekleyenler, sonra en yeni kayıt; eşitlikte kaynak ve kayıt kimliği. Sayfalar arasında yinelenen veya kaybolan satır olmaz. İlk/Önceki/Sonraki/Son denetimleri ve sayfa göstergesi vardır. Süzgeç veya sekme değişimi ilk sayfaya döner; sonuç sayısı azalınca sayfa son geçerli sayfaya çekilir. Geçmişin tamamı uygulamanın genel anlık görüntüsüne yüklenmez. Anlık görüntü yalnızca sekiz önizleme ve okunmamış/bekleyen sayaçlarını taşır. Görev paneli kendi bekleyen önerisini ayrıca görev kimliğiyle sorgular.

Tablolar dört sekmede de aynı yerleşimi kullanır: sekme şeridi, süzgeçler ve sayfalama yerinde kalır, yalnızca tablo kabuğu dikey kayar ve sütun başlıkları kaydırma sırasında görünür kalır. Tablo kalan yüksekliği doldurur; altında 16 px nefes payı kalır. Kısa (≤ 600 px) ya da dar (≤ 760 px) görünümde sayfa yeniden kayar ve tablo kabuğu görünüm yüksekliğiyle orantılı bir üst sınırla kendi içinde kayar.

Talebi açınca mevcut karşılaştırma penceresi gösterilir: özgün ve önerilen başlangıç, bitiş, hedef; talep ve karar notu; izin verilen kabul/ret eylemleri; **Görevi aç**. Karar yetkisi sunucuda yeniden doğrulanır. Görev silinmiş veya proje kapalıysa kayıt okunabilir kalır, görev açma/karar eylemi sunulmaz. Projesi yeniden etkinleşen bir talep, hâlâ açıksa güncel yetki ve sürüm denetiminden geçmek zorundadır.

## Tarih değişikliği iş akışı

Doğrudan hedef bitiş düzenleyemeyen görev sorumlusu tarih ve gerekçe gönderir. Sunucu güncel görevi kilitleyerek özgün tarihleri ve görev sürümünü kaydeder. Aynı kişi aynı görev için yeni öneri gönderirse önceki açık öneri `CANCELLED` olur; önceki kayıt silinmez. Belirlenen karar sahibi öneriyi kabul veya reddeder. Kabul, olağan tarih/takvim ve eşzamanlılık kontrollerinden geçerek atomik uygulanır; ret görevi değiştirmez. Görev arada değişmişse talep `STALE` olur. Silinen görevin açık talepleri de `STALE` olarak korunur.

Talep listeleri yalnızca oturum kullanıcısının gönderdiği veya karar sahibi olduğu kayıtlardan oluşur. Proje/kişi dizini genişlemez. Talep geçmişine erişmek ilgili göreve güncel okuma veya yazma yetkisi kazandırmaz; Görevi aç mevcut yetkili görev yükleme yolunu kullanır.

## Atama Koordinasyonu

Doğrudan atama bildirimlerinin zil ve ayrıntı penceresindeki başlığı **Bölüm dışı atama bildirimi** olarak gösterilir. Kişi aynı kurumun başka bölümündedir; yalnızca kullanıcıya gösterilen başlık değişir, atama ve koordinasyon kuralları değişmez.

Kurum dışı personelle çalışma, atama kapsamı sınırını KALDIRMAZ. Üç soru ayrılır: kimi **bulabilirsiniz**, kimi **doğrudan atayabilirsiniz**, kim için **koordinasyon** gerekir.

### Kurum dışı personel arama

Sorumlu seçicilerinde "Diğer birimlerden personel göster" anahtarı bulunur; varsayılan **KAPALI**dır ve kapalıyken bugünkü izin verilen personel davranışı aynen sürer. Açıldığında arama `GET /api/mergen-rota/directory/search` ucuna gider:

* kurumsal dizin uygulama anlık görüntüsüne **hiçbir zaman** konmaz (nüfus 3.000+ ve büyüyor);
* en az **2** karakterden sonra ve ~250 ms gecikmeyle gönderilir, geç gelen yanıt elenir;
* sonuç en fazla **25** satırdır ve `MR_V_PeopleDirectory` dizininden okunur;
* çağıranın kimliği oturumdan doğrulanır; aynı oturumun aşırı sorgusu HTTP 429 alır;
* yalnızca bu akışın gerektirdiği alanlar döner: Sicil, ad, unvan ve Direktörlük / Müdürlük / Birim. Kullanıcı adı, e-posta ve yönetici ilişkisi dönmez.

Sonuç satırı ad, Sicil ve kurumsal künyeyi birlikte gösterir. Kimlik her zaman **Sicil**'dir: aynı adlı iki çalışan ayrı satır olarak kalır ve ad hiçbir yerde kimlik ya da yetki ölçütü değildir.

### Doğrudan atama mı, talep mi?

| Durum | Sonuç |
| --- | --- |
| Sıradan kullanıcı → kendisi | Doğrudan atama (değişmedi) |
| Sıradan kullanıcı → başka çalışan | **Atama talebi** |
| Yönetici → kendi `MR_V_ExecutiveScope` personeli | Doğrudan atama (değişmedi) |
| Yönetici → kapsam dışı çalışan | **Atama talebi** |
| SYSTEM_ADMIN / tam proje yetkilisi → kurum dışı çalışan | Doğrudan atama **ve** koordinasyon bildirimi |

Doğrudan atanan kişi için aynı görevde bekleyen bir talep varsa talep aynı işlemde `CANCELLED` ("Doğrudan atamayla karşılandı.") olur. Tekrar serisinin yinelemesi, şablonunda zaten bulunan kurum dışı sorumlu için ayrı bir koordinasyon kaydı açmaz; kayıt şablondadır.

Talep gerektiren bir kişi seçildiğinde panel bunu açıkça söyler: *"Bu kişi doğrudan atama yetkinizin dışında. Kaydettiğinizde ilgili yöneticiye atama talebi gönderilecektir."* İstemci anahtarı yalnızca arayüzdür; yetki her çağrıda sunucuda yeniden doğrulanır ve doğrudan API isteği kuralları atlayamaz.

### Gerçek sorumlu ile talep edilen sorumlu

Talep edilen kişi **onaylanana kadar `MR_TaskAssignees` satırı almaz**. Bu yüzden iş yükü raporları, Özet, Kanban, hatırlatmalar, Outlook, görev görünürlüğü ve ölçümler önerilmiş bir atamayı kabul edilmiş iş gibi saymaz.

### Yönetim zinciri

Karşı taraftaki yönetim zinciri yetkili İK ilişkisinden (`MR_V_ExecutiveScope`) çözülür; en az **birim yöneticisi** ve **müdürlük yöneticisi** dikkate alınır. Aynı kişi iki rolü birden taşıyorsa **tek** bildirim alır. Rehberde bulunmayan kimliğe bildirim üretilmez. Çalışanın tanımlı yöneticisi yoksa karar, görevin proje yetkililerine düşer; o da yoksa talep sahipsiz bırakılmaz ve reddedilir. Atanan kişi, atama **gerçekten yürürlüğe girdiğinde** bildirim alır.

### Yönetici yanıtları

| Eylem | Ne zaman | Sonuç |
| --- | --- | --- |
| Onayla | `PENDING` · yönetici | Sorumlu atomik olarak eklenir, kayıt `APPROVED` olur |
| Değişiklik İste | `PENDING` · yönetici | Kayıt `CHANGE_REQUESTED`; not ve isteğe bağlı alternatif Sicil taşınır |
| Reddet | `PENDING` · yönetici | Kayıt `REJECTED`; atama değişmez |
| Atamanın Kaldırılmasını İste | `APPROVED` · yönetici | Kayıt `CANCELLATION_REQUESTED` |
| Talebi Geri Çek | `PENDING` · talep eden | Kayıt `CANCELLED` |
| Onayla / Reddet | `CANCELLATION_REQUESTED` · talep eden | Sorumlu kaldırılır (`CANCELLED`) ya da atama korunur (`APPROVED`) |

Alternatif öneri ("Ahmet yerine Mehmet görevlendirilsin") yalnızca yanıtlayan yöneticinin **kendi** kapsamındaki bir çalışan için kabul edilir ve Sicil ile kaydedilir. Koordinasyon bildirimi almak, göreve geniş bir düzenleme yetkisi VERMEZ: yöneticinin olağan yetkisi varsa normal görev düzenleme akışı açık kalır, yoksa tek yol koordinasyon iş akışıdır. Karar yetkisi karar anında güncel İK ilişkisinden ve güncel proje yetkisinden yeniden türetilir; eski bir alıcı satırı tek başına yetki taşımaz. Proje ölçütü görevin **güncel** projesidir: görev başka projeye taşınırsa kaydı yeni projenin tam yetkilisi bulur ve karara bağlar. Talep eden kendi talebini onaylayamaz; kendi bekleyen talebini geri çekebilir ama bu kayıt ona "Kararınız bekleniyor" diye gösterilmez ve bekleyen karar sayacına girmez.

### Karar ve uzlaştırma

Zil, Talepler ve Atama Koordinasyonu kararı aynı istemci yolundan verir. Pencere başarıyı ancak sunucu işlemi kaydettikten sonra gösterir; ardından görev ve zil, karardan **sonra** başlayan bir okumayla uzlaştırılır. Veri yenilemesi tek uçuşludur ama atlanmayan bir istek süren yenilemeye hiçbir zaman katılmaz: süren okuma karardan önce başlamış olabilir. Önceden, zilde atama bildirimini açmanın başlattığı okundu yenilemesi sürerken verilen onay aynı istek anahtarıyla bu yenilemeye katılıyor, karar öncesi anlık görüntü uygulanıyordu; rozet değişiyor, görev ise eski sorumlularla ve kayıt bekleyen durumda görünüyordu. İstek artık kuyruğa girer ve kuyruktaki aynı istekle birleşir.

Kaydedilen kararın uzlaştırma okuması başarısız olursa pencere kapanmaz: sunucunun döndürdüğü kaydı (yeni durum, karar düğmeleri olmadan) ve "Karar kaydedildi ancak görünüm yenilenemedi" uyarısını gösterir. Yanıt hiç alınamazsa (zaman aşımı, kopan bağlantı) karar **yeniden gönderilmez**; önce güncel durum okunur ve kullanıcıya sonucun doğrulanamadığı söylenir. Sunucudaki sürüm denetimi aynı kararın ikinci kez uygulanmasını zaten engeller. Sürüm çakışmasında da güncel durum okunur.

### Eşzamanlılık

Onay, görev ve sorumlu satırları kilitliyken tek işlemde çalışır. Bayatlık geçişe göre değerlendirilir: `PENDING` onayı için yetkili sorumlu kümesi talep anındaki kümeyle aynı olmalı, kaldırma onayı için kişi hâlâ sorumlu olmalıdır. Uymazsa kayıt `STALE` olur ve hiçbir şey yazılmaz. Görev silinmiş ya da projesi kapatılmışsa da kayıt `STALE` olur: kapatılmış projedeki göreve sorumlu yazılmaz. Onay **tek Sicil ekler**, kaldırma **tek Sicil siler**; sorumlu kümesi yeniden yazılmaz, bu yüzden görünmeyen eş sorumlular sessizce düşmez. İstemci sürüm göndermişse kaydın `RowVersion` değeriyle karşılaştırılır: eski bir yönetici yanıtı daha yenisini ezemez.

### Sekme ve süzgeçler

**Atama Koordinasyonu** sekmesi arama, kapsam (tümü / kararımı bekleyenler / gönderdiklerim / sonuçlananlar), proje, talep eden, görevlendirilen, birim, durum ve tarih aralığı süzgeçleri sunar. Süzgeçler ve sayfalama **sunucuda** uygulanır; geçmişin tamamı uygulamanın anlık görüntüsüne yüklenmez. Satır; görev, proje, görevlendirilen, talep eden, kurumsal künye, durum, oluşturma ve son yanıt zamanını gösterir. Kaydı açmak, tarih talebi penceresiyle aynı klavye ve odak davranışına sahip bir pencere açar.

## Atama e-posta bildirimi

Görev oluşturma ve düzenleme panellerinde, Kaydet düğmesinin yanında **"Sorumlulara e-posta bildirimi gönder"** kutusu bulunur. Varsayılan **KAPALI**dır ve kalıcı bir kullanıcı tercihi olarak saklanmaz: kullanıcı her işlemde ayrıca seçer, böylece olağan kayıtlar posta üretmez.

Açıkken, sorumlu kümesine **gerçekten eklenen veya çıkarılan** her kişi için bir posta NİYETİ yazılır. Kullanıcı kendisini sorumlu olarak ekliyorsa da, kutuyu açıkça işaretlediği için kendi adresine posta üretilir; sağ üstteki zil bildirimi ise kendine atamada gereksiz gürültüyü önlemek için yine üretilmez. İleti kısadır: görev, proje, atayan, öncelik, Hedef/Termin, değişiklik özeti ve dağıtımda tanımlıysa Rota bağlantısı.

Mimari dayanıklıdır ve `api.commit` süresini SMTP'ye bağlamaz:

```
görev işlemi → posta niyeti (MR_TaskMailOutbox) → commit başarılı
            → arka plan çalışanı → SMTP → SENT / geri çekilmeli yeniden deneme
```

Görev yazması SMTP'yi **beklemez** ve posta sunucusu erişilemez olsa da tamamlanır. Teslimat var olan SMTP altyapısını kullanır; ikinci bir SMTP istemcisi yazılmaz. Tekilleştirme anahtarı `(ilişkilendirme, görev, alıcı)` üçlüsünden üretilir: aynı değişiklik kuyruğa iki kez girmez. Tam olarak bir kez teslimat **garanti edilmez**: SMTP iletiyi kabul ettikten sonra, `SENT` yazılamadan çalışan durursa ya da durum yazması başarısız olursa satır kira dolunca yeniden kiralanır ve aynı ileti yeniden gönderilebilir. Alıcı adresi göreve kopyalanmaz, her teslimatta kurumsal dizinden okunur. Altı denemeden sonra kayıt `FAILED` olur ve yönetim konsolundan görülebilir.

Tur, satırları **kiralayarak** alır ve kira turun tamamını kapsar. Her kiralama bir deneme sayılır; SMTP kabulünden sonra `SENT` yazılamasa bile yeniden sahiplenme `TASK_MAIL_MAX_ATTEMPTS` (6) bütçesini tüketir. `SMTP_TIMEOUT_MS` diyaloğun tamamına değil her SMTP adımına ayrı uygulandığı için her teslimat **uçtan uca** bir bütçeyle (zaman aşımının iki katı) kesilir; kira, parti boyu × bu bütçe üzerinden ölçülür ve üst sınıra sığmayan parti daraltılır. Kira bitmeden tamamlanamayacak bir teslimat hiç başlatılmaz; satır kira dolunca yeniden kiralanır. Her satır kirayı alan turun **sahiplik belirtecini** taşır; kira yine de dolar ve satırı başka bir uygulama örneği devralırsa, geciken turun durum yazması satıra dokunmaz. Böylece kira süresi içinde çok örnekli dağıtımda aynı ileti iki kez gönderilmez; SMTP kabulü ile `SENT` yazımı arasındaki arıza penceresi yukarıda anlatıldığı gibi açık kalır.

Satıra özgü bir hata (dizin okuması, ileti kurulumu) yalnızca o satırı etkiler: deneme olarak sayılır ve geri çekilmeyle yeniden denenir, partideki öteki satırlar işlenmeye devam eder. Gönderici beklenmedik biçimde hata fırlatırsa iletinin sunucuya ulaşıp ulaşmadığı bilinemez; satır `MAIL_DELIVERY_UNCERTAIN` olarak durur.

Bağlantı ileti gövdesi aktarıldıktan sonra, kabul yanıtı okunmadan koparsa posta sunucusu iletiyi **kabul etmiş olabilir**. Böyle bir satır olağan yeniden deneme yoluna döndürülseydi alıcı aynı iletiyi ikinci kez alabilirdi; satır bu yüzden `FAILED` olarak, `MAIL_DELIVERY_UNCERTAIN` koduyla durur ve kendiliğinden bir daha gönderilmez. Kayıt kaybolmaz: yönetim konsolunda görünür ve gerekirse elle ele alınır.

Yoklama aralığı `MERGEN_ROTA_TASK_MAIL_POLL_MS` ile ayarlanır. Değişken tanımsız, boş ya da geçersizse varsayılan **30000 ms** uygulanır; geçerli bir değer 5000–300000 aralığına kırpılır.

## Atama zil bildirimi

Başka bir kullanıcı bir kişiyi göreve atadığında, atanan kişi sağ üstteki **aynı** zilde bildirim alır. Bildirim görevi, projeyi, atayanı, Hedef/Termin'i ve olay zamanını taşır. Tıklamak görevi açar; erişim olağan yetkili yükleme yolunda yeniden doğrulanır.

Kurallar:

* bildirim yalnızca **yetkili sorumlu kümesi** değiştiğinde üretilir; başlık, açıklama, öncelik ya da ilgisiz bir alan düzenlemesi "atandı" bildirimini yeniden göndermez;
* kişi kendini atadığında bildirim üretilmez;
* sorumluluk kaldırıldığında ayrı bir bildirim yazılır;
* toplu ve yinelenen yazmalarda kişi başına **tek** satır üretilir ("40 görev atandı"), kırk ayrı bildirim değil;
* olay anahtarı işlem ilişkilendirme kimliğinden türetildiği için aynı yazma iki kez uygulanamaz.

## Kurulum ve veri modeli

Atama koordinasyonu, görev bildirimleri, posta kuyruğu ve kullanıcı varlığı **0015** göçüyle gelir. Dağıtım sırası: `database/MR_Upgrade_0015_Assignment_Coordination_And_Presence.sql` → `npm run build` → Node hizmetini yeniden başlat. Betik yinelenebilir ve veriye dokunmaz; 0014 uygulanmadan çalışmaz. Göç uygulanmadan açılan kurulumda zil, var olan tarih talebi akışıyla çalışmayı sürdürür ve görev yazması etkilenmez.

Mevcut kurulumda **0007** yüklü olmalıdır. Uygulama dağıtımından önce aynı veritabanında `database/MR_Upgrade_0008_Request_Notifications.sql` çalıştırılır. Betik tekrar çalıştırılabilir. Veritabanı yeniden oluşturulmaz; daha önceki talep ve denetim kayıtları korunur. Ardından `npm run build` çalıştırılıp Node hizmeti yeniden başlatılır. Yeni kurulumda ana oluşturma betiği güncel şemayı içerir.

`MR_ScheduleRequestNotifications` tablosu `(RequestId, Sicil)` anahtarını, `ReadVersion`, `DismissedVersion` ve `UpdatedAt` alanlarını taşır. `MR_TaskScheduleChangeRequests` ek olarak görev başlığı ve proje kimliği/adı/kodu künyesini saklar. 0008 mevcut kayıtların künyesini doldurur ve görev silinince talepleri de silen yabancı anahtarı kaldırır. Önceden silinmiş kayıtlar bu yükseltmeyle geri getirilemez. Görev silme akışı açık talepleri güncelliğini yitirmiş olarak işaretler; tamamlanmış taleplere dokunmaz.

`MR_TaskAssignmentCoordinations` görev/proje/kişi künyesini, talep anındaki yetkili sorumlu kümesini, görev sürümünü, durumu, notları ve karar zamanını taşır; `MR_AssignmentCoordinationRecipients` hem alıcı kümesidir hem de `(CoordinationId, Sicil)` anahtarıyla okundu/temizlendi sürümünü tutar. `MR_TaskNotifications` alıcı başına değişmez olay satırıdır. `MR_TaskMailOutbox` posta niyetini ve teslimat durumunu tutar. `MR_UserPresence` Sicil başına tek nabız satırıdır.

`GET /api/mergen-rota/assignment-coordination` parametreleri: `tab` (`all|pending|sent|history`), sıfır tabanlı `page`, `pageSize` (1–100), `search`, `projectId`, `taskId`, `requester`, `assignee`, `organization`, `status`, `from`, `to`. `coordinationId` ile tek kayıt okunabilir. Yanıt `{ record }` biçimindedir ve erişilebilir bir kayıt yoksa `record` değeri `null` olur. `POST` aynı adrese `{ taskId, assigneeSicils, message }` gönderir. `PATCH /assignment-coordination/{coordinationId}` gövdesi `{ decision, message, version, suggestedAssigneeSicil }` taşır. `PATCH /api/mergen-rota/notifications` gövdesi `{ action: read|dismiss, notifications: [{id, version, source}] }` ile karışık kaynaklı işaretleme yapar; `source` `SCHEDULE_REQUEST`, `ASSIGNMENT_COORDINATION` veya `TASK_EVENT` olabilir ve her kayıt kendi kaynağının sürüm/sahiplik kuralından geçer. Yanıt `{ ok: true, inbox }` biçimindedir; `inbox` anlık görüntüdeki beş zil alanını (`scheduleRequests`, `scheduleRequestSummary`, `assignmentCoordinations`, `taskNotifications`, `notificationSummary`) taşır.

`GET /api/mergen-rota/notifications` Talepler'in birleşik listesidir. Parametreler: `tab` (`pending` = Gelenler, `sent`, `history`), sıfır tabanlı `page`, `pageSize` (1–100), isteğe bağlı `cursor`, `search`, `projectId`, `requester`, `category` (`SCHEDULE_REQUEST`, `ASSIGNMENT_REQUEST`, `ASSIGNMENT_NOTICE`, `TASK_ASSIGNED`, `TASK_UNASSIGNED`), `status`, `from`, `to`. Yanıt `{ items, total, page, pageSize, hasNext, nextCursor, cursorReset, counts: { pending, sent, history, coordination } }` biçimindedir. `nextCursor` bir sonraki sayfaya geçişte kullanılır ve `cursorReset` konuma göre sayfalamaya dönüldüğünü bildirir. Her kalem kendi kaynağının alanlarını ve `source` alanını taşır. Katılım yüklemleri her kaynağın kendi sorgu modülünden alınır (tarih talebinde talep eden/karar sahibi, koordinasyonda alıcı satırı ve canlı karar yetkisi, olayda alıcı); ayrıntı satırları da aynı yüklemle yeniden süzülür. 0015 göçü uygulanmamış kurulumda liste yalnızca tarih taleplerini döndürür. Atama Koordinasyonu sayfası `counts.all` alanında süzgeçlere uyan tüm kayıtların sayısını da döndürür.

`GET /api/mergen-rota/schedule-changes` parametreleri: `tab`, sıfır tabanlı `page`, `pageSize`, `search`, `projectId`, `taskId`, `requester`, `status`, `from`, `to`. `projectId` ve `taskId`, düz Gerçek Sistem UUID'sini veya kendi istemci kimliği biçimini (`project-<uuid>` / `task-<uuid>`) kabul eder ve sunucuda küçük harfli UUID'ye kanonikleştirilir; yanlış türde önekler ve geçersiz metinler reddedilir. `PATCH` aynı adrese `action: read|dismiss` ve `notifications: [{id, version}]` gönderir. Mevcut talep oluşturma `POST` ve karar `PATCH /schedule-changes/{requestId}` uçları korunur. Kullanıcı kimliği istemciden alınmaz; tüm sorgular parametrelidir ve yanıtlar önbelleğe alınmaz.

## Klavye ve görünüm

Sekmeler sol/sağ ok, Home ve End tuşlarıyla değişir. Atama Koordinasyonu sekmesi de bu gezinmeye dahildir; kapsam seçimi ikinci bir sekme katmanı açmaz, olağan süzgeç satırında durur. Zil paneli ve karşılaştırma penceresi Tab odağını içeride tutar; Escape kapatır ve odak çağıran denetime döner. Karar kaydı sürerken kapatma engellenir. Geçmiş tablosunda görev başlığı gerçek bir düğmedir. "Diğer birimlerden personel göster" gerçek bir `role="switch"` denetimidir; arama sonuçları `role="listbox"` altında sunulur. Açık/koyu tema tasarım değişkenleri, ölçekli görünüm ölçüleri ve dar ekranda sarılan filtreler kullanılır.