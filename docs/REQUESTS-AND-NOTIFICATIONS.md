# Talepler ve bildirimler

MERGEN Rota Görev Yönetimi, kalıcı tarih değişikliği talebini kullanıcının geçici bildirim durumundan ayrı tutar. Bu özellik Gerçek Sistem kipinde çalışır; Temel Kip ve Kapsamlı Kip aynı talep iş akışını kullanır.

## Zil ve kalıcı geçmiş

Zil en fazla **8** bildirim önizlemesi gösterir. Önce kullanıcının kararını bekleyen talepler, ardından en yeni bildirimler gelir. Sıralama karar tarihi, yoksa talep tarihi ve eşitlik halinde talep kimliğiyle belirlenir. Sayı rozeti tüm okunmamış bildirimlerin sayısıdır; küçük dikkat noktası ve paneldeki bekleyen sayacı, okunmuş olsa da açık kararları belirtir.

Bir bildirimi açmak onu okundu işaretler. **Okundu işaretle** ve **Görünenleri temizle** yalnızca o an gösterilen bildirimlere uygulanır. Temizlenen bilgilendirmeler zilden kalkar; kullanıcının kararını bekleyen talepler sonuçlanana kadar zilde kalır. Bu işlemler talebi, tarih karşılaştırmasını veya audit kaydını silmez. **Tüm talepleri gör**, Talepler sayfasını açar.

Bildirim durumu kullanıcı ve talep kimliğine göre saklanır. Okuma/temizleme, görülen talep sürümünü taşır. Talep daha sonra sonuçlanırsa yeni sürüm tekrar okunmamış olur; gecikmiş bir eski sürüm işlemi yeni kararı temizleyemez. Bir kişinin okuması diğer kişinin bildirimini değiştirmez.

## Talepler sayfası

Kenardaki **Talepler** düz bir üst düzey gezinme öğesidir. Sayfa üç sekme içerir:

| Sekme | İçerik |
| --- | --- |
| Bekleyenler | Kullanıcının kararını bekleyen, etkin projelerdeki açık talepler |
| Gönderdiklerim | Kullanıcının gönderdiği tüm durumdaki talepler |
| Geçmiş | Kabul, ret, yeni taleple değiştirme ve güncelliğini yitirme kayıtları; görevi silinen veya projesi kapalı kayıtlar |

Arama görev başlığı, proje adı/kodu, talep eden ve talep notunda çalışır. Proje, talep eden adı/sicili, durum ve talep oluşturma tarihi aralığıyla daraltılabilir. Başlangıç ve bitiş günleri aralığa dahildir. Sekme sayaçları mevcut süzgeçlere uyar; Gönderdiklerim ile Geçmiş kesişebilir.

Sunucu varsayılan olarak **25** kayıt döndürür; API sayfa boyutunu 1–100 arasında sınırlar. İlk/Önceki/Sonraki/Son denetimleri ve sayfa göstergesi vardır. Süzgeç veya sekme değişimi ilk sayfaya döner; sonuç sayısı azalınca sayfa son geçerli sayfaya çekilir. Geçmişin tamamı uygulamanın genel anlık görüntüsüne yüklenmez. Anlık görüntü yalnızca sekiz önizleme ve okunmamış/bekleyen sayaçlarını taşır. Görev paneli kendi bekleyen önerisini ayrıca görev kimliğiyle sorgular.

Talebi açınca mevcut karşılaştırma penceresi gösterilir: özgün ve önerilen başlangıç, bitiş, hedef; talep ve karar notu; izin verilen kabul/ret eylemleri; **Görevi aç**. Karar yetkisi sunucuda yeniden doğrulanır. Görev silinmiş veya proje kapalıysa kayıt okunabilir kalır, görev açma/karar eylemi sunulmaz. Projesi yeniden etkinleşen bir talep, hâlâ açıksa güncel yetki ve sürüm denetiminden geçmek zorundadır.

## Tarih değişikliği iş akışı

Doğrudan hedef bitiş düzenleyemeyen görev sorumlusu tarih ve gerekçe gönderir. Sunucu güncel görevi kilitleyerek özgün tarihleri ve görev sürümünü kaydeder. Aynı kişi aynı görev için yeni öneri gönderirse önceki açık öneri `CANCELLED` olur; önceki kayıt silinmez. Belirlenen karar sahibi öneriyi kabul veya reddeder. Kabul, olağan tarih/takvim ve eşzamanlılık kontrollerinden geçerek atomik uygulanır; ret görevi değiştirmez. Görev arada değişmişse talep `STALE` olur. Silinen görevin açık talepleri de `STALE` olarak korunur.

Talep listeleri yalnızca oturum kullanıcısının gönderdiği veya karar sahibi olduğu kayıtlardan oluşur. Proje/kişi dizini genişlemez. Talep geçmişine erişmek ilgili göreve güncel okuma veya yazma yetkisi kazandırmaz; Görevi aç mevcut yetkili görev yükleme yolunu kullanır.

## Kurulum ve veri modeli

Mevcut kurulumda **0007** yüklü olmalıdır. Uygulama dağıtımından önce aynı veritabanında `database/MR_Upgrade_0008_Request_Notifications.sql` çalıştırılır. Betik tekrar çalıştırılabilir. Veritabanı yeniden oluşturulmaz; daha önceki talep ve audit kayıtları korunur. Ardından `npm run build` çalıştırılıp Node hizmeti yeniden başlatılır. Yeni kurulumda ana oluşturma betiği güncel şemayı içerir.

`MR_ScheduleRequestNotifications` tablosu `(RequestId, Sicil)` anahtarını, `ReadVersion`, `DismissedVersion` ve `UpdatedAt` alanlarını taşır. `MR_TaskScheduleChangeRequests` ek olarak görev başlığı ve proje kimliği/adı/kodu künyesini saklar. 0008 mevcut kayıtların künyesini doldurur ve görev silinince talepleri de silen yabancı anahtarı kaldırır. Önceden silinmiş kayıtlar bu yükseltmeyle geri getirilemez. Görev silme akışı açık talepleri güncelliğini yitirmiş olarak işaretler; tamamlanmış taleplere dokunmaz.

`GET /api/mergen-rota/schedule-changes` parametreleri: `tab`, sıfır tabanlı `page`, `pageSize`, `search`, `projectId`, `taskId`, `requester`, `status`, `from`, `to`. `PATCH` aynı adrese `action: read|dismiss` ve `notifications: [{id, version}]` gönderir. Mevcut talep oluşturma `POST` ve karar `PATCH /schedule-changes/{requestId}` uçları korunur. Kullanıcı kimliği istemciden alınmaz; tüm sorgular parametrelidir ve yanıtlar önbelleğe alınmaz.

## Klavye ve görünüm

Sekmeler sol/sağ ok, Home ve End tuşlarıyla değişir. Zil paneli ve karşılaştırma penceresi Tab odağını içeride tutar; Escape kapatır ve odak çağıran denetime döner. Karar kaydı sürerken kapatma engellenir. Geçmiş tablosunda görev başlığı gerçek bir düğmedir. Açık/koyu tema tasarım değişkenleri, ölçekli görünüm ölçüleri ve dar ekranda sarılan filtreler kullanılır.
