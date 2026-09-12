# Raporlar: Performans ve Görev Hareketleri

Raporlar, Kapsamlı Kipte tek gezinme öğesidir. İçindeki **Performans** sekmesi mevcut metrikleri, grafikleri ve görev tarih aralığını korur. **Görev Hareketleri**, görünür görevlerde kimin hangi kalıcı değişikliği yaptığını gösterir; çalışanları düzenleme sayısına göre sıralamaz. Sekmeler arasında geçiş yerel filtreleri korur. Performans tarih aralığı hareket raporunu etkilemez.

## Kullanım

Varsayılan dönem **Bugün**, yönetici kapsamı bulunan kullanıcıda **Ekibim**, diğer kullanıcılarda **Görünür görevler**dir. Benim hareketlerim ayrıca seçilebilir. Bugün, Dün, Son 7 gün ve en fazla 366 günlük özel aralık desteklenir. Kişi, proje, hareket türü ve Direktörlük → Müdürlük → Birim filtreleri sunucuya gönderilir. Kurumsal yol anahtarları ortak hiyerarşi yardımcılarını kullanır; aynı adlı alt birimler karışmaz. Seçenekler yalnızca yetkili hareket kümesinden çıkarılır.

Özet; mantıksal değişiklik, farklı görev, kişi ve tamamlanan görev sayılarını seçili kümenin tamamı için verir. Son hareket önce gösterilir. Sayfalar varsayılan 25, en fazla 50 işlem içerir; İlk/Önceki/Sonraki/Son kullanılabilir. Görev adı mevcut görev çekmecesini açar. Silinmiş görevin tarihsel adı gösterilir; açma düğmesi bulunmaz. Yenile düğmesi raporu tekrar sorgular.

Sekmeler ok tuşları/Home/End ile gezilebilir. Hareket ayrıntıları yerel `details` denetimiyle açılır; tablo dar ekranda kendi alanında kayar. Yükleme, boş sonuç ve güvenli hata durumları vardır. Demo Kipi kalıcı denetim raporu sorgulamaz.

## Veri ve zaman sınırı

`GET /api/mergen-rota/reports/task-activities` oturum kimliğini sunucudan alır; yanıt `no-store`dur. İstemci yalnızca rapora özgü alanları alır. Parametreler: `period=today|yesterday|week|custom`, `from`, `to`, `scope=team|visible|mine`, `person`, `projectId`, `kind=created|updated|completed|deleted`, kurumsal yol alanları, sıfır tabanlı `page`, `pageSize`.

Tek kaynak **MR_AuditLog**dur; ikinci hareket tablosu yoktur. `OccurredAt` UTC tutulur. Sunucu gün sınırlarını **Europe/Istanbul** saat diliminden `[startUtc, endUtc)` aralığına çevirir; geçmişteki saat dilimi farklarını da dikkate alır. Örneğin 8 Eylül 2026 günü, 7 Eylül 21:00 UTC dahil ve 8 Eylül 21:00 UTC hariç aralıktır. İstemci tarih/saat gösterimi de İstanbul saatini kullanır.

Sorgu ve yetkilendirme `src/server/reports/taskActivityReport.js`, tarih sınırları `activityDates.js`, Türkçe fark dönüşümü `taskActivityChanges.js` içindedir. Yetkili tarih kümesi sunucuda gruplanır, toplamlar hesaplanır ve sayfalanır. Ham önce/sonra JSON yalnızca seçili sayfanın işlemleri için alınır ve sunucuda işlenir; APIye veya genel snapshot'a gönderilmez. Sorumlu adları tek toplu sorguda çözülür; satır başına sorgu yoktur.

## Yetkilendirme ve tarihçe

**Ekibim** için hem denetimin `ActorSicil` değeri mevcut `MR_V_ExecutiveScope` kapsamına/kullanıcının kendisine uymalı, hem ilgili görev/proje mevcut görünürlük kurallarını sağlamalıdır. Aktör görev sorumlularından türetilmez. Çalışanın başka projelere erişmesi yöneticiye bu projeleri açmaz. Görünür görevler seçimi yalnızca görev kapsamı içindeki diğer aktörlerin hareketlerini gösterir; görev kapsamını genişletmez.

Mevcut SYSTEM_ADMIN önceliği ve FULL/READ proje görünürlüğü korunur. Kısmi erişim mevcut yetkili görev kimlikleriyle sınırlıdır. Taşınmış görevlerde güncel görev ve tarihsel proje bağlamı ayrıca doğrulanır. Filtre parametreleri yönetici/rol/kimlik yetkisi vermez.

Silinen görev için son silme denetiminin oluşturucu ve sorumlu Sicilleri, mevcut görev görünürlüğündeki aynı kurallarla değerlendirilir; yalnızca aktörün ekipte olması yeterli değildir. Eski silme kaydı atama bilgisi içermiyorsa bu bilgi tahmin edilmez: proje düzeyinde görünürlük veya kayıtlı oluşturucu sahipliği gerekir. Yetkisiz veya artık görünür olmayan proje tarihçesi açılmaz; SYSTEM_ADMIN tarihsel/değişmiş proje bağlamını okuyabilir.

Görev adı/proje künyesi ve aktör görüntü adı için denetimdeki tarihsel değerler, eksikse mevcut kayıt kullanılır. Eksik eski alanlar çökme üretmez; bilinmeyen önceki değer için sahte alan farkı üretilmez. Görev kaydetme denetimi artık gerçekten kalıcılaştırılan satırı ve önce/sonra sorumlu Sicillerini taşır. Silme denetimi son görev/proje künyesini ve atamaları korur.

## İşlem gruplama

Yalnızca anlamlı TASK oluşturma/güncelleme/silme olayları alınır. Teknik tarih talebi denetimleri listelenmez; kabul işleminin TASK tarih değişikliği görünür. Aynı `CorrelationId`, görev, proje ve aktör bir işlem satırıdır; korelasyonu olmayan eski kayıtlar bağımsızdır. Alanların net önce/sonra farkları Türkçe etiketlerle, sorumlu ekleme/çıkarma adlarıyla gösterilir. Bir işlemde aşırı sayıda denetim satırı varsa ayrıntı okuması 100 satırla sınırlandırılır ve eksik ayrıntı uyarısı gösterilir; toplam işlem sayısı değişmez.

## Dağıtım

Mevcut kurulumda `database/MR_Upgrade_0009_Task_Activity_Report.sql` çalıştırılır. Yeni `IX_MR_AuditLog_Type_Occurred` dizini `(EntityType, OccurredAt DESC, AuditId DESC)` üzerinden tarih aralığındaki görev hareketlerine erişir; aktör/proje/korelasyon anahtarlarını kapsar, büyük JSON sütunlarını dizine kopyalamaz. Diğer denetim dizinleri korunur. Yeni kurulum betiği aynı dizini oluşturur. Bu değişiklik kümesinin bildirim yükseltmesi 0008 de uygulama dağıtımından önce tamamlanmalıdır.

Etkin bir kullanıcı filtresi varken **Filtreleri Temizle** gösterilir. Tek işlemle dönem Bugün’e, kapsam sunucunun yetkili varsayılanına, kişi/proje/tür/tarih/kurumsal seçimler boş duruma ve sayfa ilk sayfaya döner. Aynı rapor ucu görünürlük ve ekip yetkilerini yeniden denetler; temizleme yetki kümesini değiştirmez.

Görev Hareketleri çalışma alanında yalnız tablo gövdesinin bulunduğu alan dikey kayar; sütun başlıkları aynı tablo içinde yapışkandır. Filtreler, özet ve sayfalama alanı görünür kalır. Başlık ve satır vurguları Talepler ile aynı açık/koyu tema tokenlarını kullanır. Yaşam döngüsü kaynaklı durum, gerçek tarih ve ilerleme değişiklikleri mevcut görev denetiminde tek kaydın önce/sonra değerleriyle görünür.
