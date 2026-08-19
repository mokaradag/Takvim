# Büyük Portföy ve Personel Dizini

Bu belge, MERGEN Rota'nın yüzlerce proje ve binlerce personel bulunan Gerçek Sistem kullanımındaki seçim, görüntüleme ve kayıt davranışlarını açıklar.

## Proje seçimi

Proje veya personel seçen uzun listeler yerel HTML `select` alanları yerine canlı arama destekli `SearchableSelect` bileşenini kullanır. Arama Türkçe yerel ayarına göre çalışır ve proje kodu, proje adı, proje türü; personelde ise ad, sicil, unvan ve organizasyon alanlarını tarar. Sonuç listesi sınırlı sayıda kayıt oluşturur; daha ayrıntılı arama yapıldıkça liste daralır.

`Aktif çalışma alanı`, Basit Mod proje seçimi, Yeni Proje sorumlusu, Proje Tanımı içindeki manuel proje sorumlusu, görev çekmecesindeki proje/sorumlu/WBS/etiket/öncül görev seçimleri ve iş dağılım ağacındaki taşıma/üst düğüm seçimleri bu ortak davranışı kullanır.

Ham `<select>` yalnızca sabit ve kısa numaralandırmalar için kalır: ilişki türü (FS/SS/FF/SF), gecikme birimi ve takvimdeki ay/yıl seçimi.

Açılır panelin yerleşim ve katman sözleşmesi `SIMPLE-MODE-AND-UI.md` içinde tanımlanır. Panel `document.body` altına taşınır; bu sayede kenar çubuğunun `overflow: hidden` kırpması ve yığın bağlamı listeyi etkilemez.

## Proje türleri

Kurumsal projeler `ProjectTypeCode` ve `ProjectTypeName` alanlarına göre sınıflandırılır. Tür adları ve simgeleri `src/domain/projectTypes.js` içinde tek bir katalogda tutulur.

Başlangıçta gizlenen tamamlanmış veya kapatılmış türler şunlardır:

- `KF` — Kapatılan Faaliyet
- `KG` — Kapatılan Geliştirme Projesi
- `KP` — Kapatılan Proje
- `KT` — Kapatılan Tohum Projesi
- `TF` — Tamamlanan Faaliyet
- `TG` — Tamamlanan Geliştirme Projesi
- `TP` — Tamamlanan Proje

Kullanıcı gerektiğinde “Tamamlanan ve kapatılanları göster” seçeneğini açabilir. Bu seçim yalnızca arayüz görünürlüğünü değiştirir; verileri silmez veya erişim yetkisini değiştirmez.

## Proje Yapısı / Proje Tanımı

Portföy çalışma alanında tüm projeleri tek tek düğme olarak oluşturmak yerine:

1. Proje türü özet kartları gösterilir.
2. Kullanıcı bir tür seçebilir.
3. Proje kodu, adı veya türüyle canlı arama yapabilir.
4. Sonuçlar sayfalı biçimde artımlı gösterilir.

Bu düzen, sınırlı proje erişimi bulunan ekiplerin yalın deneyimini korurken sistem yöneticileri ve üst yöneticiler için yüzlerce proje içeren görünümü kullanılabilir kılar.

## Kurumsal proje sorumlusu

Kurumsal bir projenin `Proje Sorumlusu`, `MR_V_CorporateProjectAccess` görünümündeki `PROJECT_MANAGER` rolünden alınır. Kurumsal projelerde bu alan salt okunurdur. Manuel projelerde ise yetkili kullanıcı canlı arama ile bir sorumlu seçebilir.

`src/server/repository/corporateQueries.js`, kurumsal proje eşitlemesi sırasında `MR_Projects.LeadSicil` alanını bu rolün siciliyle yeniler.

## PPTS rol düzeltmesi ve temiz kurulum

`HR09_projeSorumlu.pptsSicil` alanından üretilen rol kodu `PPTS` olmalıdır. Uygulama henüz temiz kurulumla sınandığı için ayrı bir artımlı geçiş betiği kullanılmaz.

Tüm MERGEN Rota tabloları ve görünümleri kaldırıldıktan sonra şu temiz kurulum betiği çalıştırılır:

```text
database/MR_Create_Durable_Persistence.sql
```

Bu betik `MR_V_CorporateProjectAccess` görünümünü baştan `PPTS` rol koduyla oluşturur. Uygulama ilk kurumsal proje eşitlemesinde `MR_Projects.LeadSicil` alanını `PROJECT_MANAGER` rolünden doldurur. Dolayısıyla `MR_Migrate_0002_Project_Portfolio_Scaling.sql` adlı ayrı bir betik bulunmaz ve çalıştırılmaz.

## Ekip sayfası

Ekip görünümü tüm personel için büyük kartlar oluşturmaz. Başlangıç görünümü direktörlük özetlerinden oluşur. Kullanıcı daha sonra direktörlük, müdürlük ve birim düzeyinde ilerleyebilir veya ad, sicil, unvan ve organizasyon alanlarında canlı arama yapabilir.

Görev sayıları tek geçişte personel kimliğine göre dizinlenir. Böylece eski `personel × görev` taraması yerine yaklaşık `personel + atama` maliyetli hesaplama kullanılır. Personel sonuçları artımlı yüklenir.

Direktörlüğü tanımlı olmayan personel de dizinde yer alır. Kurumsal rehberde bazı çalışanların yalnızca yöneticisi bilinir; önceki sürümde başlangıç görünümü yalnızca direktörlük değeri dolu olanları grupladığı için bu kişiler hiçbir kartta görünmüyordu. Artık "Direktörlük tanımsız" ayrı bir özet kartı ve ayrı bir süzgeç seçeneğidir. Eşleşme kuralı `src/features/team/teamDirectoryPolicy.js` içindeki `matchesDirectorateFilter` işlevinde tanımlıdır ve tek başına sınanır.

Dizin kartı ile tablo başlığı sayfa kaydırılırken sabit kalır: sayfa `.content` yüksekliğini doldurur, kaydırma yalnızca personel tablosuna aittir.

### Süzgeç ve sıralama · tek durum

"Kurumsal ekip dizini" açılır listeleri ile tablo başlığı süzgeçleri **tek bir
kurumsal süzgeç durumunu** paylaşır:

```text
{ directorate: '', department: '', unit: '' }
```

- Her düzey **tek seçimlidir**: aynı anda birden çok direktörlük, müdürlük veya
  birim etkin olamaz.
- İki yön de aynı duruma yazar: üstteki açılır listeden yapılan seçim tablo
  başlığında, tablo başlığından yapılan seçim açılır listede anında görünür.
- Seçim etiketle değil **kararlı yol anahtarıyla** tutulur
  (`direktörlük > müdürlük > birim`). Farklı direktörlüklerdeki aynı adlı
  müdürlükler bu sayede birbirine karışmaz.
- Hiyerarşi korunur: direktörlük değişince geçersiz kalan müdürlük ve birim,
  müdürlük değişince geçersiz kalan birim temizlenir. Bir üst düzey
  temizlendiğinde alt düzey de temizlenir; gizli kalmış süzgeç bırakılmaz.
- Tablo başlığından müdürlük seçmek üst direktörlüğü, birim seçmek hem müdürlüğü
  hem direktörlüğü otomatik doldurur.

Sütunların tamamı Görevler sayfasıyla aynı `FilterableTH` bileşenini kullanır:
Personel (metin), Unvan (çoklu), Direktörlük/Müdürlük/Birim (tek seçimli),
Toplam/Devam/Geciken (sayısal) ve Yakın görevler (metin). Sıralama `tr-TR`
yerel ayarıyla yapılır, sayısal sütunlar sayısal karşılaştırılır, eksik değerler
her iki yönde de sona gider ve eşitlikte ad + Sicil ile kararlı ikincil sıralama
uygulanır. Süzgeçleme ve sıralama **sayfalamadan önce** çalışır; süzgeç
değiştiğinde görünür satır sınırı sıfırlanır.

Eski "Müdürlük / Birim" birleşik sütunu, her düzeye bağımsız başlık süzgeci
verebilmek için **Müdürlük** ve **Birim** olarak ayrılmıştır. Temizleme
düğmesinin metni **"Filtreleri temizle"** olup her iki konumdaki tüm süzgeçleri
ve genel aramayı sıfırlar.

Saf kurallar `src/features/team/teamFilterPolicy.js` içindedir ve
`test/team-directory-filtering-e2e.test.mjs` ile tek başına sınanır.

## Görev sorumlusu ataması

Görev sorumluları **Sicil kimliğiyle** tutulur; ad yalnızca görüntüleme amaçlıdır. Bir güncelleme yaması açık `assigneeIds` alanı taşıdığında bu kimlikler kesin kaynaktır ve adlardan yeniden türetilmez.

Bu ayrım binlerce çalışanın bulunduğu dizinde zorunludur: ad eşlemesi (`indexByUniqueName`) aynı ada sahip kişileri belirsizlik nedeniyle **eler**. Yama yalnızca ad listesi taşıdığında, aynı adı paylaşan bir çalışana yapılan atama sessizce kayboluyordu. Aynı nedenle görev çekmecesindeki sorumlu listesi de seçili kişileri yalnızca Sicil kimliğine göre eler; ad eşlemesi sadece kimliği çözülemeyen eski kayıtlar için kullanılır.

Yalnızca `sorumlu` (ad listesi) gönderen eski çağrılarda kimlik türetme davranışı korunur.

## Görev tanımlamada proje seçimi

Görev tanımlarken açılan proje listesi, çalışma alanı seçicisindeki **görünür**
proje listesiyle aynı değildir. Sunucu anlık görüntüsü iki ayrı dizi taşır:
`projects` (görülebilenler) ve `assignableProjects` (görev tanımlamak için
seçilebilenler). İkincisi birinciyle asla birleştirilmez; süzgeçler, raporlar,
portföy istatistikleri ve görev görünürlüğü değişmeden kalır.

Sıradan kullanıcıda `assignableProjects` boştur: seçici eskisi gibi yalnızca
kendi `corporateprojectaccess` projelerini gösterir. Müdür/direktör/takım
liderinde ise tüm etkin CN43N kataloğunu taşır; büyük katalogda seçici yine
`SearchableSelect` üzerinden aranarak kullanılır ve kök iş dağılım düğümü
(`rootWbsId`) proje kaydıyla birlikte gelir, böylece görev seçimden hemen sonra
yazılabilir.

Kural ve sunucu tarafı sınırı: `docs/AUTHORIZATION-MODEL.md` · *Task assignment
scope*.

## Kayıt güvenilirliği

Gerçek Sistem kayıtları için şu korumalar uygulanır:

- Var olan proje, WBS ve görev nesnelerinde arayüzün düşürdüğü `version` alanı, commit öncesinde mevcut durumdan geri yüklenir. Böylece güncelleme işlemi yanlışlıkla oluşturma olarak yorumlanmaz ve “Kayıt kimliği zaten kullanılıyor” çatışması oluşmaz.
- Commit yanıtındaki yetkili satırlar **proje kayıtları dâhil** duruma uygulanır. Aksi hâlde proje sürüm anahtarı eskir ve aynı projenin ikinci güncellemesi (örneğin `Proje rengi` değişikliği) oluşturma çakışması olarak reddedilir. Depo projeyi hiç yankılamazsa sürümsüz yerel kopya saklanmaz; yetkili anlık görüntü yeniden yüklenir.
- Gerçek Sistem istemcisi proje, WBS, görev, takvim ve bağımlılık kimliklerini API isteğinden önce UUID olarak doğrular. İstemci ön ekli kimliklerin sonundaki UUID güvenli biçimde ayrıştırılır. Doğrulama başarısız olduğunda ileti hangi alanın hatalı olduğunu ve **alınan değeri** açıkça belirtir; genel bir “geçerli UUID olmalıdır” uyarısı sorunlu kaydın bulunmasını imkânsız kılıyordu.
- İkincil yazmalar asıl işlemi engellemez. Basit Modda etiket kataloğuna ekleme başarısız olsa bile görev kaydı oluşturulur ve kullanıcıya uyarı gösterilir.

Görev oluşturma eylemine yanlışlıkla React tıklama olayı geçirilmesi de eylem kancasında ayıklanır.
