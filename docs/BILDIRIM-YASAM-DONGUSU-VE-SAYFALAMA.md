# Bildirim yaşam döngüsü ve sunucu sayfalaması

Bu belge, Talepler sayfası, Atama Koordinasyonu ve birleşik bildirim zilinin aynı değişmezleri nasıl kullandığını açıklar. Kimlik ve işlem sahipliği her zaman oturumdaki **Sicil** ile belirlenir.

## Sorgu yaşam döngüsü

Sayfalı bildirim sorgusunda dört durum birbirinden ayrılır:

1. **Bilinen veri:** son başarılı sorgunun satırları, toplamı ve sayaçları yetkilidir.
2. **Aynı sorgunun arka plan yenilemesi:** mevcut satırlar ve bilinen toplam/sayaçlar gösterilmeye devam eder. Yalnız yenileme durumu ayrıca belirtilir; geçerli satır eylemleri sırf yenileme sürüyor diye kilitlenmez.
3. **Yeni kapsam veya süzgeç:** eski kapsamın toplamı yeni kapsamın sonucu gibi sunulmaz. Yeni kapsam kesinleşene kadar toplam ve sayaç `…` ile bilinmiyor olarak gösterilir; bilinmeyen değer `0` sayılmaz.
4. **Hata:** aynı kapsam için daha önce yetkili bir sonuç varsa son bilinen satır ve sayılar korunur ve yenileme hatası ayrıca gösterilir. Yeni kapsamın ilk isteği başarısızsa o kapsamdaki toplam bilinmiyor kalır.

Sayfa değişimi kapsamı değiştirmez. Bu nedenle sayfa getirilirken önceki yetkili toplam ve sayaç korunabilir; ancak önceki sayfanın satırları yeni sayfanın satırlarıymış gibi gösterilmez.

## Atomik ve dar sunucu sayfalaması

Görev bildirimleri ile atama koordinasyonu geçmişi her istekte tüm geniş geçmişi geçici tabloya kopyalamaz. Sunucu önce yalnız nüfus tutarlılığı için gereken dar alanları materyalleştirir: kayıt kimliği, sıralama alanları ve gelen/geçmiş/bekleyen/okunmamış gibi bayraklar. Sayaç, toplam, güvenli sayfa ve sayfa üyeliği bu tek dar nüfustan türetilir. Görev/proje/kişi künyesi gibi geniş gösterim alanları yalnızca son sayfadaki kimlikler için birleştirilir.

Koordinasyon sorgusunda kişi dizini birleştirmeleri, ancak arama veya talep eden/görevlendirilen kişi süzgeci bu alanları gerektiriyorsa nüfus aşamasına girer. Yetkilendirme ve Sicil kapsamı değişmez. Yapay zekâ kanıt sorgusunun sınırlı anlık görüntü yolu ayrı sözleşmesini korur.

## İşlem sonuçlarının ayrılması

Bir iş kararı, bildirim okuma ve sonrasındaki yenileme ayrı sonuçlardır. Sunucu bir kararı başarıyla kaydetmişse sonradan yapılan yenilemenin başarısız olması bu kararı başarısızlığa çeviremez. Görev açma başarısızlığı, okundu işaretleme başarısızlığı ve yenileme başarısızlığı birbirini gizlemez; birden fazlası oluşursa kullanıcıya ayrı bağlamlarıyla birlikte gösterilir.

Bu nedenle birincil iş sonucunu `finally` bloğunda beklenen yenileme sonucuyla ezmek yasaktır. Yenileme hatası ek bir `refreshError` olarak taşınır.

## Alıcı ve eşzamansız işlem sahipliği

Bir işlem başladığında o anki Sicil işlem sahibidir. İşlemin her sonraki ağ isteğinden veya durum değişikliğinden önce aynı alıcının hâlâ etkin olduğu doğrulanır. A kullanıcısı için başlayan görev/bildirim işlemi sırasında oturum B kullanıcısına geçerse eski işlem B adına PATCH gönderemez, B'nin hata/işlem durumu veya seçimini değiştiremez ve B arayüzünü `busy` / `marking` durumunda bırakamaz.

Aynı kural Talepler görev bildirimleri, Talepler koordinasyon bildirimleri, Atama Koordinasyonu ayrıntı pencereleri ve zil işlemleri için ortaktır. Alıcı değişiminde eski satırlar, seçimler, açık pencereler ve işlem hataları yeni kullanıcıya taşınmaz.
