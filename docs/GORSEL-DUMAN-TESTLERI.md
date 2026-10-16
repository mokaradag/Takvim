# MERGEN Rota Elle Görsel Duman Testleri

Bu belge tekrarlanabilir **elle** görsel denetim listesidir. Otomatik tarayıcı/uçtan uca test paketi değildir ve öyle raporlanmamalıdır.

Sunum, kalıcılık durumu, kimlik doğrulama/yükleme/hata yüzeyleri veya genel katmanlama değiştiğinde listeyi üretim derlemesinde uygulayın.

## Test matrisi

Yüksek riskli denetimleri hem **Koyu Tema** hem **Açık Tema** ile şu boyutlarda tekrarlayın:

- Geniş masaüstü: yaklaşık 1440 px veya daha geniş.
- Orta/dar masaüstü: yaklaşık 1280 px ve 1080 px.
- Dar/mobil görünüm: uygulamanın yerleşimi desteklediği yaklaşık 760 px ve altı.

Sonuçla birlikte tarayıcıyı, işletim sistemini, derleme commit'ini ve görünüm boyutlarını kaydedin.

## Açılış ve kipler

- İlk kip seçici, alttaki uygulama kabuğu görünmeden açılır.
- Temel Kip başarıyla açılır.
- Temel Kip Takvim, **Takvim** sekmesinde açılır; **Hızlı Görev Tanımı** ayrı sekme olarak kalır.
- Temel Kip **Yeni proje** düğmesi görevsiz proje oluşturur ve proje alanında seçer.
- Kapsamlı Kip başarıyla açılır; kip değiştirmek proje/görev verisini değiştirmez.

## Kabuk, çalışma alanı ve üst çubuk

- Kenar çubuğu doğru kayar; altlığı kullanılabilir kalır.
- Portföy/proje çalışma alanı değişimi görünür bağlamı günceller.
- Üst çubuk sayfa başlığı/alt başlığı okunabilir kalır.
- Seçili proje kimliği gerçek üst çubukta görsel olarak ortalanır.
- Proje kodu ve adı görsel olarak ayrılır.
- Sağ üstte dönen yedigen, kabul edilen görünür kesiti ve dönüş davranışını korur.
- **Marka amblemi** tercihi hem kenar hem üst çubuk amblemini gizler.
- Dekoratif amblem işaretçi olaylarını engellemez.
- `Dışa aktar`, üst çubuğun altında kesilmeden açılır ve klavyeyle erişilebilir kalır.
- Tema, bölümlü Temel Kip/Kapsamlı Kip seçici ve çıkış kenar çubuğu altlığındadır; üst çubukta yinelenmez.
- Klavyeyle erişilen denetimlerde odak göstergeleri görünürdür.

## Özet

- KPI kartları taşmadan hizalanır.
- Eğilim/durum satırı kabul edilen geniş yerleşimi izler.
- 1280 px genişlikte Tamamlama trendi ve Durum dağılımı amaçlandığı gibi tam satıra geçer.
- Durum dağılımı halka grafiği kabul edilen boyutu, açıklama genişliğini ve aralıkları korur.
- **Her dilim tek kesintisiz yaydır.** Hiçbir dilim halkanın iki yerinde görünmez; dilimler arası boşluk eşittir. Üzerine gelmek veya seçmek dilimi halkadan ayırmadan içeri doğru kalınlaştırır.
- Dört KPI kartı halka grafiğiyle uyuşur: `Tamamlanan + Devam eden + Yapılacak + Geciken`, `Toplam görev` değerine eşittir; gecikmiş devam eden görev yalnızca `Geciken` altında sayılır.
- Açıklama satırları tıklanabilir kalır; üzerine gelme/ayrıntı davranışı çalışır.
- **Tamamlanma eğilimi eksen etiketleri her kart genişliğinde olağan metin boyutundadır**; kartla büyümemelidir.
- `Gecikme yaşlandırması` ve `Plan bütünlüğü` kartları çizilir; dilim veya denetimin üzerine gelmek ilgili görevleri listeler, göreve tıklamak çekmecesini açar.
- Dar yerleşim yatay kesilmeden alt alta dizilir.
- Alt Özet kartları amaçlanan hizalamayı korur.

## Görevler ve DateInput

- Proje/kişi aranabilir seçicileri kullanılabilir kalır.
- Kaydırmada görev tablosu başlıkları yapışkan kalır.
- Sütun süzgeçleri tablo üstünde kesilmeden açılır; ekranın altına yakınken yukarı yönelir ve tamamen görünüm içinde kalır.
- DateInput, `gg/aa/yyyy` gösterimini ve düzenlemesini doğru yapar.
- Takvim düğmesi, geçersiz durum kenarlığı ve dar genişlikte DateInput kullanılabilir kalır.
- Bir sütunda süzgeç uygulamak diğer sütun seçeneklerini hâlâ görünür değerlere daraltır; sütunun kendi menüsü diğer değerlerini sunmaya devam eder, seçili değer kendi menüsünden kaybolmaz.
- Tablo yatay kayarken en sağ eylem sütunu sabit kalır: posta/silme düğmelerine her genişlikte erişilir. **%125 yazı ölçeğinde** satır numarası sütunu kalkar, başlık etiketleri satır kaydırmaz.

## Görev Ayrıntısı

- Çekmece sağdan açılır; üst çubuk veya açılır pencerelerin arkasında kalmaz.
- Arka perde amaçlanan sayfa alanını kaplar.
- Proje/WBS, tarih ve ilişki alanları masaüstünde sığar; dar genişlikte alt alta dizilir.
- Düğmeler gerçek düğme olarak klavyeyle erişilebilir ve odaklanabilir kalır.
- Her bölümün kendi simgesi ve vurgu rengi vardır; başlıklar cümle düzenindedir, tamamı büyük harf değildir.
- **Öncelik** bölümü görev önceliğini ayarlar; seçim Görevler ve Kanban listelerine yansır.
- **Tekrar**: `Haftalık` seçiminde her hafta günü, plan başlangıcının kendi günü dahil, *seçilebilir ve seçimden çıkarılabilir*. Özet seride kaç oluşum ve kaç yeni görev olacağını söyler; oluşum takvimi şablon gününü işaretleyerek en fazla sekiz tarih listeler.
- *Güncel plan* içindeki **Kilometre taşı** anahtarı açılınca planlanan bitiş gizlenir, başlangıç alanı yeniden adlandırılır, sıfır süre açıklanır ve görev iki Gantt görünümünde elmas çizilir. Tek tıklama bir kez değiştirir.
- Görevi oluşturmayan sorumlu plan/gerçekleşen tarihleri düzenler; **Hedef bitiş** düzenleyemez. `Yeni tarih öner` yalnızca hedef bitişi sorar.
- **İlişkiler ve bağımlılıklar**, `Öncüller` ve `Ardıllar` sekmelerini içerir. Ardıl eklemek diğer görevi günceller; döngü oluşturacak seçim listede sunulmaz.
- **%125 yazı ölçeğinde** (Ayarlar → Yazı tipi boyutu → Çok büyük) `Sil` ve `Kaydet` tamamen ekranda kalır; `+ Öncül görev seçin` listesi hiçbir parçası dışarı çıkmadan yukarı açılır.

## Takvim

- Aylık takvim iki temada da çizilir.
- Tarih süzgeci/gün ayrıntısı pencereleri doğru katmanlanır.
- Hafta sonu/tatil sunumu okunabilir kalır.
- Temel Kip hızlı giriş görevleri mevcut takvim akışında görünür.

## Proje Yapısı

- Proje seçici başlığı, arama alanı ve proje türü hızlı seçim düğmeleri sabit kalırken yalnızca proje listesi kayar.
- **Daha fazla göster**, sabit başlıkla değil listeyle kayar.
- **Yeni Proje** pencereyi açar; proje oluşturmak pencereyi kapatır, uygulama kabuğunu kurulu tutar. Karşılama ekranı veya yeniden başlamış görünümü oluşmaz.
- Mevcut projede **Değişiklikleri kaydet**, sayfayı korur ve başarı iletisini yerinde gösterir.

## WBS

- **İş Dağılım Ağacı sekmesi her projede istemci istisnası olmadan açılır.** Eksik `wbsDragPolicy` içe aktarımının ana regresyon denetimidir.
- Satırı tutamacından sürüklemek sırasını/üstünü değiştirir; tutamacı başka yerde bırakmak satırı yeniden seçilebilir bırakır.
- WBS ağacı dar genişliklerde yatay kaydırılabilir kalır.
- Yapışkan WBS başlığı satırlarla hizalıdır ve **satırlar kayarken görünür kalır**; üst araç çubuğu kaybolmaz.
- Ağaç tamamen açık değil, varsayılan düzey 2'de açılır.
- `Tümünü aç`, `Tümünü kapat`, `Hiyerarşi` tek denetim grubu olarak araç çubuğunda görünür; hiyerarşi menüsü dış tıklama ve `Esc` ile kapanır.
- `Görev taşı` taşıma panelini açıp kapatır; girişte ve proje değişiminde panel kapalıdır.
- Kurumsal projede (Gerçek Sistem) CN43N notu tek satırdır, satır eylemleri gizlidir, satırlar düzey/PYP/tür/durum gösterir; görev taşıma paneli yine çalışır.
- Manuel projede Alt ekle / Ad / Taşı / Sil çalışır; yeni düğüm beklenen kodla görünür.

## Gantt

- Gantt bütün sayfayı kaydırmak yerine kendi dikey/yatay kaydırmasını kullanır.
- Sol bölüm/başlık ve sağ zaman çizgisi hizalı kalır.
- Sütun süzgeçleri ve Gantt sütun pencereleri çizim üstünde kesilmeden açılır.
- Tatil şeritleri ve bağımlılık katmanları amaçlanan yerel çizim sırasını korur.
- WBS Gantt ve sorumlu/CPM görünümleri kullanılabilir kalır.
- Araç çubuğu etiketleri Türkçedir: **Yakınlaştırma**, `Dar / Orta / Geniş`.
- **Genişlet / Daralt**, her grubu (portföy) veya dalı (WBS) açar/kapatır. **Seviye** düğmeleri yalnızca WBS Gantt'ta görünür; hiyerarşiyi seçilen düzeye açar. Elle genişletme sonrasında hiçbir düzey vurgulanmaz.
- Kilometre taşı görev çubuk yerine elmas çizilir.

## Açılış perdesi (ilk veri yüklemesi)

- İlk anlık görüntü yüklenirken kart, %100 dışı yazı ölçekleri dahil, yatay/dikey ortalanır; dar sütuna sıkışmaz veya görünür merkezin altına kaymaz.
- Marka satırı, başlık, açıklama ve ilerleme hareketi iki temada çizilir.
- `MERGEN Rota`, küçük açıklama yerine kartın kimliği olarak okunur (logo ve tam boy marka yazısı). Veri Kipi ve Nasıl çalışmak istersiniz? pencereleri de böyledir.
- Uygulama düzeyi `Hareketi azalt` tercihi açılış yıldızlarını veya ilerleme hareketini dondurmaz; bunlar yükleme/durum geri bildirimidir. İşletim sisteminin `prefers-reduced-motion` tercihi açılış animasyonunu yine bastırır.
- Yükleme hatası `Yeniden Dene` ve Demo kipi dışında Demo'ya geçiş düğmesi gösterir.

## Ekip

- Kişi listesi kayarken `Kurumsal ekip dizini` kartı ve tablo başlığı görünür kalır.
- Böyle kişiler varsa varsayılan özet `Direktörlük tanımsız` kartını içerir; tıklamak tam o kişileri süzer.
- Direktörlük seçicisi adlandırılmış direktörlüklerin yanında `Direktörlük tanımsız` sunar.
- Üst kartta direktörlük seçmek `Direktörlük` sütun başlığını hemen süzülmüş işaretler; tersi de geçerlidir. Aynı kural `Müdürlük`, `Birim` için geçerlidir.
- Her kurum düzeyinde tek değer etkin olabilir; farklı direktörlük seçmek öncekini değiştirir, artık geçersiz müdürlük/birimi temizler.
- Her sütun başlığı sıralama/süzgeç penceresi açar: Personel, Unvan, Direktörlük, Müdürlük, Birim, Toplam, Devam, Geciken, Yakın görevler.
- Temizleme eylemi **Filtreleri temizle** yazar (`Süzgeçleri temizle` değil); arama, seçiciler ve başlık süzgeçlerini birlikte sıfırlar.
- Personel satırları kurumsal fotoğrafı, yoksa baş harfleri gösterir; tablo dar masaüstünde okunabilir kalır.
- Kişi adına tıklamak kimlik, iş yükü ölçüleri, öncelik dağılımı ve tam `Yakın görevler` listesini içeren ayrıntı penceresini açar. `Esc` ve arka perde kapatır; göreve tıklamak pencereyi kapatıp görev çekmecesini açar.
- Pencere her yazı ölçeğinde görünüme sığar; görev listesi uzunsa içeriden kayar.

## Kimlik doğrulama ve kenar çubuğu kimliği

- Gerçek Sistem'de oturum yoksa açılış ekranı kısmen yüklenmiş veri yerine **Kurumsal oturum aç** gösterir; Demo kipi bilinçli ayrı seçimdir.
- Girişten sonra kenar çubuğu sabit örnek kullanıcı/rol yerine doğrulanmış kullanıcının fotoğrafını, tam adını ve Keycloak bölümünü gösterir.
- Uzun bölüm adı küçük yazıyla birden çok satıra bölünür; kenar çubuğundan taşmaz.
- Uzun tam ad `MEHMET O…` diye kesilmek yerine ikinci satıra geçer.
- Altlıkta `Kullanım rehberi` kısayolu yoktur; Yardım gezinme öğesi yardım sayfasını açar.
- Altlık tek denetim satırında tema, bölümlü Temel Kip/Kapsamlı Kip seçici ve çıkışı sıralar; üst çubukta yinelenmez.
- Kenar çubuğu sabitlenmiş ve açık başlar. Sabitlemeyi kaldırmak ana içeriği 72 px şeride göre boyutlandırır. Üzerine gelme ve klavye gezinmesi genişletir. Sayfaya tıklayıp görüntülenen kenar çubuğunun dışına çıkın: tıklanan düğme odaklı kalsa da kapanır. Tab gezinmesi çalışır; sabitleme ve yeniden yükleme tercihi korur.
- Altlık sürüm satırı yalnızca `MERGEN Rota · Sürüm 1.0` yazar; kipi anahtar gösterir.
- Sol altta dönen yedigen altlık denetimleriyle yarışmadan gözle görülür daha büyük çeyrek alan gösterir.
- Tema düğmesi çalışır; Gerçek Sistem'de kompakt çıkış düğmesi bulunur. Çıkış doğrulanmamış duruma döndürür.
- Avatarlar Görevler, Takvim, Kanban, Ekip, görev çekmeceleri, Özet, Gantt, raporlar, proje çalışma alanı ve Temel Kipte fotoğraf, yedek olarak baş harf gösterir.
- Doğrudan sorumlu, açık **Görevi tanımlayan** etiketi altında oluşturucunun avatarını, tam adını, oluşturma tarih/saatini görür; oluşturucu aynı görevi açtığında aynı kimliği görür.
- Kapsamlı Kipte **Yeni Görev**, kaydedilmemiş çekmece açar. Kapatmak kayıt oluşturmaz; yalnızca **Kaydet** görevi kalıcı saklar.

## Temel Kip

- Kenar çubuğu Görevler, Takvim, Gantt, Kullanım Rehberi ve Ayarlar sunar.
- Gantt, Kapsamlı Kip portföy Gantt'ıyla özdeş portföy zaman çizgisini çizer.
- Görevler yalnızca sade tabloyu gösterir: Proje, Görev, Kısa açıklama, Sorumlular, Öncelik, Durum, Termin. Sayfanın hiçbir yerinde ilerleme çubuğu, efor/saat, başlangıç tarihi, baz plan, bağımlılık veya WBS sütunu bulunmaz.
- Arama, durum bölümleri, öncelik süzgeci ve sıralama seçicisi listeyi daraltır/sıralar; temizlemek tam listeyi geri getirir.
- Satıra tıklamak aynı alanları düzenleyen ve gelişmiş planlama verisine dokunmadan kaydeden sade görev panelini açar.
- Öncelik, Hızlı Görev Tanımı, tablo, panel ve süzgeçte Kapsamlı Kip ile aynı dört etiket ve rozet rengiyle görünür.
- Kapsamlı Kipe geçmek tam Görevler tablosunu değişmeden gösterir.

## Görev hatırlatma

- Her iki kipte görev satırlarında Sil yanında ve görev paneli altlığında, bilgi kutusu ve aria-label içeren kompakt zarf düğmesi bulunur.
- Basmak bekleme, sonra alıcı sayılı başarı iletisi veya açık hata gösterir; kabul edilmiş gönderim olmadan başarı bildirmez.
- Gönderim sürerken düğme kapalıdır; çift tıklama iki ileti üretemez.
- Gönderim görevi değiştirmez veya silmez; sonrasında satır değerleri aynıdır.
- Otomatik hatırlatmalar kapalıyken düğme çalışır.
- **Hatırlatma** sayfası kenar çubuğunda yalnızca yöneticiye görünür; yönetici olmayan doğrudan giderse düzenleyici yerine ret görür.
- Şablon düzenleyici araç çubuğu (kalın/eğik/liste/bağlantı) biçim uygular, yer tutucu listesi belirteç ekler, önizleme gerçek görev değerlerini çizer.
- Otomatik ilkeyi kaydetmek okunabilir zamanlama özeti gösterir (“termine 7 gün kala başlar ve 2 günde bir yinelenir”).

## Kanban, Raporlar, Ayarlar ve kalıcılık durumu

- Kanban sütun/kartları çizilir ve kaydırılabilir kalır; kartı geldiği sütuna bırakmak kayıt isteği üretmez.
- Raporlar yerleşim regresyonu olmadan çizilir; CFD eksen etiketleri açıklamaların üzerine binmek yerine üstünde bulunur, `Gecikme yaşlandırması` Özet kartı toplamlarıyla uyuşur.
- Ayarlar denetimleri iki temada okunabilir kalır.
- Vurgu rengi kataloğu `Kehribar` yazar (`Amber` değil).
- **Tarih biçimi**, **düzenlenebilir tarih alanları dahil**, ekrandaki bütün tarihleri yeniden yüklemeden `gg/aa/yyyy` ve `18 Ağu 2026` arasında değiştirir. Görev Ayrıntısı/Hızlı Görev Tanımı kutuları seçili biçimi gösterir; yer tutucu ve doğrulama iletisi ona uyar. `18 Ağu 2026` ve `18/08/2026` girmek iki kipte de doğru kaydedilir.
- **Yüksek karşıtlık**, iki temada kenarlıkları ve ikincil metni belirgin koyulaştırır.
- Görünüm/amblem/kip ayarları beklendiği gibi görünür uygulanır.
- %90–%140 bütün yazı ölçeklerinde, hiçbir sayfada düğme, açılır liste, bilgi kutusu veya pencere görünür alan dışında çizilmez.
- Gerçek Sistem / Demo anahtarı Ayarlar **Veri kaynağı** kartında vardır, kenar çubuğunda yoktur.
- Mevcut test/geliştirme mekanizmalarıyla kayıt/hata/kaydedildi durumu benzetildiğinde kalıcılık göstergesi olağan içeriğin üstünde görünür.

## Dışa aktarma çıktısı

- **Excel çalışma kitabı**, Excel'de **dosya biçimi ve uzantısı uyuşmuyor uyarısı olmadan** açılır; Özet, Görevler, İş Dağılım Ağacı (portföy aktarımında ayrıca Projeler) içerir.
- Her sayfanın başlık satırı sabittir, otomatik süzgeç okları taşır; tarihler tarih olarak sıralanır, İlerleme yüzde gösterilir.
- **CSV paketi**, içeriği Türkçe karakterleri koruyarak açılan ZIP indirir; **Görev listesi** tek düz CSV indirmeyi sürdürür.
- Aktarım üretilirken menü düğmesi dönen gösterge sunar.

## Sonuç kaydı

Şu tür kısa kayıt kullanın:

```text
Commit:
Tarayıcı / İşletim sistemi:
Tema:
Görünüm boyutları:
Denetlenen alanlar:
Başarılı / Başarısız:
Notlar / ekran görüntüleri:
```

Elle duman testi otomatik testleri tamamlar; yerine geçmez. Görsel regresyon, yeni genel geçersiz kılma katmanı eklemek yerine `ARAYUZ-BICIMLENDIRME-MIMARISI.md` içinde belgelenen yetkili biçim kaynağında düzeltilmelidir.

## Görev arayüzü doğrulaması

- Yeni ve mevcut görev pencerelerinde künye çerçevesizdir; ad ile oluşturma
  tarihi/saat okunur. Kaydet simgesi ve kayıt sırasında bekleme göstergesi
  her iki kipte görünür. Dar ekranda uzun ad ve tarih taşmaz.
- Kenar çubuğunda fazladan ok, Aktif çalışma alanı ve Çalışma alanı başlıkları
  bulunmaz; proje seçicisi marka bloğunun hemen altındadır.
- Temel Kip ve Kapsamlı Kip seçimi mevcut tercihi korur; Ayarlar, karşılama,
  yardım ve veri seçimi ekranları kip ve görev yönetimi ifadelerini kullanır.
- Kanban aramasını bir proje kodu ve Türkçe sorumlu adıyla deneyin. Direktörlük,
  müdürlük ve birim seçimlerini birlikte uygulayın; kolon sayıları, boş sonuç,
  temizleme ve filtreli sürükleme doğru çalışır. Görevler sayfasına geçince
  kurumsal seçim korunur; dar ekran ortak kurumsal filtre menüsünü kullanır.
- Gantt görev ve kilometre taşı ipuçlarında tüm sorumluların fotoğraf/ad
  çiftleri görünür. Aynı davranışı WBS görünümünde doğrulayın. Sorumluya göre
  gruplamada avatarlar doğru Sicile aittir; aynı adlı kişiler birleşmez.
  Fotoğraf bulunmayan kişi baş harflerle gösterilir.


## Talepler, KPI detayları ve tablo davranışı

Açık/koyu tema, normal/büyütülmüş yazı ve dar ekran için kontrol edin:

- Her iki kipte Talepler düz menü öğesidir; dört sekme ok tuşlarıyla ve Home/End ile değişir. Arama/süzgeç sonrası sayfa başa döner.
- Zilde en fazla sekiz kart vardır; karar gerekenler belirgindir. Okundu/temizle geçmişi silmez; açık karar ve dikkat noktası kalır. Yeni karar yeniden okunmamış görünür.
- Özetin beş KPI kartında zengin liste ve Tüm görevleri gör çalışır; pencere doğru küme/sayı ile açılır. Sorumlular Sicil ile ayrılır. Görev paneli kapanınca liste durumu, liste kapanınca Özet bağlamı korunur.
- Temel Kipte Ctrl/Cmd+K ve arama düğmesi çalışır; Gantt sonucu yoktur. Kapsamlı Kipte Gantt vardır.
- Başlık ve Notlar içinde Home/ok tuşlarıyla ortaya gidip Türkçe karakter yazın, seçim yapıp değiştirin, yapıştırın ve silin; imleç sona atlamamalıdır. Kaydet öncesinde kalıcı görev değişmez.
- Geciken todo/in_progress yalnızca Geciken durumunda görünür. Başlangıç/Bitişte gerçekleşen tarih varsa ✓ ile gösterilir; tarih süzgeci ve sıralama aynı değeri izler.
- Tarih açıklaması ve İlk/Önceki/Sonraki/Son tek alt satırı paylaşır. İlk/son sayfa düğmeleri doğru kilitlenir.
- Zil, komut paleti, KPI penceresi ve görev/talep panellerinde Tab/Shift+Tab odağı içeride tutar; Escape ve kapatma odağı uygun denetime döndürür. Kayıt sürerken kapanış kilidi korunur.


### Raporlar → Görev Hareketleri

Her iki temada Performans/Görev Hareketleri sekmelerini ok tuşları ve Home/End ile değiştirin; Performans aralığının korunduğunu kontrol edin. Bugün/Ekibim, özel aralık, kurumsal yol, kişi/proje/hareket türü ve son sayfa kontrollerini deneyin. Çok alanlı işlem ayrıntısını klavyeyle açın; görev çekmecesini kapatınca filtrelerin korunduğunu, silinen görevde açma düğmesi olmadığını doğrulayın. Dar ekranda yalnızca tablonun kendi alanının kaydığını kontrol edin.

### Sabit şeritler ve hatırlatma sonucu

Açık/koyu tema, normal/büyütülmüş yazı ve dar/geniş pencere için:

- Özet ve Proje Yapısı → Proje Tanımı'nı ortasına ve sonuna kaydırın. Üst çubuk ile sabit şerit arasında grafik/metin görünmemeli; şeridin altındaki 10 piksel boşluk korunmalı. Kurumsal filtre açılır menüleri ve proje sekmeleri tıklanabilmeli.
- Raporlar → Performans'ta sekmeler ve tarih/organizasyon şeridi sabit kalmalı; aralarındaki 12 piksel boşlukta kaydırılan içerik görünmemeli. Özel tarih aralığında satır yüksekliği değişince sekmeler çakışmamalı. Görev Hareketleri'ne geçip sekme gezinmesini ve tablo kaydırmasını doğrulayın.
- Sistem Yönetimi'nin yedi sekmesinde sağlık şeridi ve sekmeler sabit kalmalı; yalnız alt panel kaymalı. Sekme değişince panel baştan açılmalı; Tab ve PageDown ile panel kaydırılabilmeli. Hatırlatma E-postaları'nın son düğmelerine ulaşılabilmeli.
- Her iki Görevler kipinde, yetkili bir test görevinin hatırlatma sonucunu orta ve son satırlarda gösterin. Komşu zarf/silme simgeleri metni örtmemeli; yatay kaydırma ve tablo başlığı davranışı korunmalı. Demo Kip gerçek posta göndermemeli.
- Kurumsal test posta kutusunda bir daveti iptal edin: tek takvim iletisi, önceki görev başlığı/tarihi, aynı UID ve yükselen SEQUENCE doğrulanmalı; `not supported calendar message.ics` görülmemeli. SMTP sonrası Outlook görünümü ayrıca kontrol edilmeli.

## Özet süzme ve alan kullanımı

- Beş KPI kartının her birinden **Tüm görevleri gör** açın; ilk sayı/kategoriyi doğrulayın.
- Metin, çoklu seçim, tarih ve kurum süzgeçlerini birleştirin; temizleyince üst özet kapsamı/kategorisinin korunduğunu doğrulayın.
- Modal üstünde sütun/tarih süzgeçlerini açın. Tab açılır pencerede kalır; Escape önce onu, ikinci Escape modalı kapatır.
- Görev açıp dönün: süzgeç, sıra ve sayfa korunur. Açık/koyu tema ve 1440/1280/760 px genişlikte tekrarlayın.
- Projeler (sayfada 5) ve Portföy sağlığı (sayfada 6) listelerini bağımsız sayfalayın; son sayfada süzerek geçerli aralığı/kapalı denetimleri doğrulayın.
- İki sonuç seçicisini 5'ten 10/20/50'ye değiştirin. Bağımsız sonuçları, değişmeyen sırayı ve boş durumları doğrulayın.
- Proje Tanımı tarayıcısı ve açılmış WBS ağacı kullanılabilir alt boşluğa ulaşır; kısa pencerelerde denetimler erişilebilir kalır.
- Temel Kipte görev başlığı geniş, sorumlu/öncelik/termin sütunları dardır. Uzun Türkçe adları, çok sorumluyu ve eylem düğmelerini denetleyin.

## Sekme simgesi ve marka

- Uygulamayı açık ve koyu işletim sistemi temasında açın; tarayıcı sekmesindeki
  pusula simgesi her ikisinde de okunaklı olmalı ve gövde çemberi ile ibre
  seçilebilmeli.
- Sekmeyi yer imlerine ekleyin ve 16 piksellik yer imi çubuğunda simgenin
  bulanıklaşmadığını doğrulayın. Uygulama pusula logosu ile aynı biçim dilinde
  olmalı; ilgisiz bir "M" harfi amblemi görünmemeli.
- Ağ sekmesinde simge için ek bir dosya isteği görünmemeli.

## Kurum dışı atama, koordinasyon ve bildirimler

Açık/koyu tema, normal/büyütülmüş yazı ve 1440/1280/760 piksel genişliklerde:

- Görev panelini açın: **Diğer birimlerden personel göster** anahtarı kapalı
  gelmeli ve liste yalnızca kapsam içi personeli göstermeli. Anahtarı açın; iki
  karakterden kısa yazıda istek gitmemeli, sonuçlar sınırlı kalmalı ve her satır
  adın yanında kurumsal yolu göstermeli. Aynı adlı iki kişi ayrı satır olmalı.
- Kapsam dışı bir kişi seçin: panel kaydetmenin **talep** oluşturacağını açıkça
  söylemeli. Kaydedin; görev sorumlusu listesinde o kişinin **görünmediğini**,
  Kanban/Özet/iş yükü sayılarının değişmediğini doğrulayın.
- Yönetici hesabıyla **Talepler → Atama Koordinasyonu** sekmesini açın. Ok
  tuşları ve Home/End ile dört sekme arasında gezinin. Arama, durum, proje,
  talep eden, sorumlu, kurumsal yol ve tarih süzgeçlerini deneyin; süzgeç
  değişince sayfa başa dönmeli.
- Satırı açın: pencerede dört eylem bulunmalı (**Onayla**, **Değişiklik İste**,
  **Reddet**, **Atamanın Kaldırılmasını İste**). Tab/Shift+Tab odağı içeride
  tutmalı, Escape kapatmalı ve odak çağırana dönmeli. Onaylayın; sorumlunun
  göreve gerçekten eklendiğini ve diğer sorumluların korunduğunu doğrulayın.
- Talep edenin zilinde sonucun göründüğünü, en fazla sekiz önizleme kuralının
  korunduğunu ve tarih talepleri ile atama bildirimlerinin **tek** listede
  birleştiğini doğrulayın. İkinci bir zil olmamalı.
- Bir göreve sorumlu ekleyin: eklenen kişinin zilinde bildirim çıkmalı, ekleyen
  kişi kendi işlemi için bildirim almamalı. Yalnızca açıklama/etiket değiştirip
  kaydedin; yeni bildirim çıkmamalı.
- **Sorumlulara e-posta bildirimi gönder** kutusunun kapalı açıldığını, panel
  kapatılıp yeniden açıldığında yine kapalı geldiğini ve işaretli kaydetmenin
  gözle görülür bir bekleme yaratmadığını doğrulayın. Demo Kipte gerçek posta
  gönderilmemeli.

## Sistem Yönetimi → Aktif Kullanıcılar

- Sekmeyi `SYSTEM_ADMIN` olmayan bir kullanıcıda görmemeli, adres satırından
  zorlandığında da veri gelmemelidir.
- Sekme kalan dikey alanı doldurmalı: sayfa gövdesi kaymamalı, yalnızca tablo
  kaymalı ve sütun başlıkları sabit kalmalı. 760 piksel genişlikte de yatay
  taşma olmamalı.
- "Aktif" tanımı (son 3 dakika) ekranda yazmalı. KPI kartları ile tablo satır
  sayısı tutarlı olmalı.
- Aynı kullanıcıyla ikinci bir sekme açın: ağ sekmesinde nabzın yalnızca **bir**
  sekmeden gittiğini ve tabloda kişinin **tek** satır olduğunu doğrulayın.
  Nabız gönderen sekmeyi kapatın; kısa süre sonra diğer sekmenin devraldığını
  görün.
- Sekmeyi arka plana alın: yoklama durmalı, geri dönünce hemen tazelenmelidir.

## Kanban sorumlu süzgeci ve hedef sıralaması

- Sorumlu seçicisi Direktörlük/Müdürlük/Birim ile **aynı satırda** olmalı.
  1280 ve 760 pikselde denetimler sıkışarak sarmalanmalı, hiçbiri kesilmemeli.
- Aynı adlı iki çalışanın ayrı seçenek olduğunu doğrulayın. Arama ve kurumsal
  seçimle birlikte çalıştığını, sütun sayaçlarının süzülmüş kümeyi saydığını ve
  **Filtreleri temizle** ile sıfırlandığını kontrol edin.
- Her sütun başlığında sıralama düğmesi sayacın yanında ve aynı satırda
  olmalı. Varsayılan artan olmalı; tıklayınca yön değişmeli ve **yalnızca o
  sütun** etkilenmeli. Hedefi olmayan görev her iki yönde de en altta kalmalı.
  Düğmenin ipucu/erişilebilir adı yönü söylemeli; klavyeyle ulaşılabilmeli.
- `prefers-reduced-motion` açıkken yeni denetimler animasyon üretmemeli.
