# Temel Kip ve Arayüz Davranışları

Bu belge, MERGEN Rota'daki Temel Kip akışını ve uygulama kabuğu/Özet yerleşimine ilişkin arayüz sözleşmelerini açıklar.

## Temel Kip Takvim akışı

Temel Kipte **Takvim** sayfası açıldığında varsayılan görünüm aylık Takvimdir. Hızlı kayıt formu Takvim ile aynı anda gösterilmez.

Takvim sayfasında iki sekme bulunur:

1. **Takvim** — varsayılan görünüm; her görevi yalnızca Termin (`targetFinish`) gününde gösterir. Eski bir kayıtta hedef yoksa `plannedFinish` güvenli yedektir; süre `plannedStart`–`plannedFinish` aralığında çoğaltılmaz; ayrıntılı zaman çizelgesi Kapsamlı Kip Gantt görünümünde izlenir.
2. **Hızlı Görev Tanımı** — proje, görev, isteğe bağlı kısa açıklama/etiket, sorumlular ve termin tarihi ile hızlı kayıt oluşturur.

Kullanıcı başka bir sayfadan yeniden Takvim'e geçtiğinde Takvim sekmesi yeniden varsayılan görünüm olur. Temel Kipte oluşturulan kayıtlar mevcut Project/Task veri altyapısını kullanmaya devam eder ve Kapsamlı Kipte ayrıntılandırılabilir.

## Kip sınırları ve komut arama

Temel Kip gezinmesi Görevler, Takvim, Talepler, Kullanım Rehberi ve Ayarlar sayfalarını içerir. Gantt yalnızca Kapsamlı Kiptedir. Temel Kipte kenar çubuğu, komut sonuçları ve dolaylı yönlendirmeler Gantt veya diğer kapsamlı sayfaları açmaz. Rol kapılı yönetici sayfaları yalnızca sistem yöneticisine iki kipte de gösterilir.

**Ara veya komut çalıştır...** düğmesi ile Ctrl/Cmd+K iki kipte de çalışır. Komut paleti kenar çubuğuyla aynı kip/rol listesini kullanır. Görev araması mevcut çalışma alanını daraltır. Tab odağı paletin içinde kalır, ok tuşları sonucu seçer, Enter çalıştırır, Escape kapatır ve odağı geri verir.

## Temel Kipte Görevler

Temel Kip gezinmesi `veri` (Görevler), `takvim`, `talepler`, `yardim` ve `ayarlar` sayfalarını içerir. Temel Kipte **Görevler** sayfası Kapsamlı Kipteki tabloyu göstermez; kendi sadeleştirilmiş görünümü vardır (`SimpleTasksView`).

Sütun kümesi doğrudan **Hızlı Görev Tanımı** alanlarından türetilir (`src/features/tasks/simpleTaskColumns.js`):

| Sütun | Kaynak alan |
| --- | --- |
| Proje | `projectId` |
| Görev | `task` |
| Kısa açıklama | `keyword` |
| Sorumlular | `assigneeIds` |
| Öncelik | `priority` |
| Durum | `status` |
| Termin | `targetFinish` |

Kapsamlı Kipe ait planlama alanları Temel Kipte **hiç gösterilmez**: ilerleme yüzdesi, başlangıç tarihleri, temel plan (baseline), bağımlılıklar, tekrar kuralı, iş dağılım ağacı düğümü ve serbest zamanlama alanları. Saat/efor alanları ise ürünün hiçbir normal kullanıcı görünümünde gösterilmez; eski `plannedHours` / `actualHours` değerleri yalnızca veri uyumluluğu için korunur. Bu liste `ADVANCED_ONLY_TASK_FIELDS` sabitinde tutulur ve regresyon testleri alanların sızmadığını doğrular.

Sayfa aynı sadeleştirilmiş alan kümesi üzerinde şu yetenekleri sunar:

1. **Yeni Görev** — sağ üst düğme Takvim sayfasındaki mevcut **Hızlı Görev Tanımı** akışını açar; Kapsamlı görev düzenleyicisine yönlendirmez.
2. **Kurumsal süzme** — aynı araç çubuğu satırındaki Direktörlük, Müdürlük ve Birim seçimleri Ekip sayfasının ortak yol-anahtarı semantiğini kullanır. Çok sorumlulu görevde sorumlulardan en az birinin eşleşmesi yeterlidir.
3. **Arama** — görev adı, kısa açıklama, proje ve sorumlu üzerinde canlı süzme.
4. **Sütun süzme** — Proje, Görev, Kısa açıklama, Sorumlular, Öncelik, Durum ve Termin başlıklarında ortak filtre bileşenlerini kullanır.
5. **Süzgeçleri temizleme** — global arama, kurumsal seçim ve bütün sütun filtrelerini birlikte sıfırlar.
6. **Sıralama** — sade sütun başlıklarından yapılır.
7. **Düzenleme** — satıra tıklamak `SimpleTaskDrawer` panelini açar.

İşlem sırası `yetkili snapshot → çalışma alanı/proje → kurumsal kapsam → arama → sütun fasetleri → sıralama → sayfalama` biçimindedir. Direktörlük/Müdürlük/Birim bir yetkilendirme kuralı değildir ve görev/kişi görünürlüğünü genişletmez. Seçenekler yalnızca mevcut çalışma alanındaki görevlerin, mevcut kişi projeksiyonunda çözülebilen sorumlularından üretilir; geçici arama veya sütun süzgeci kurumsal seçeneği listeden düşürmez.

`SimpleTaskDrawer`, Kapsamlı Kipteki `TaskDrawer` yerine yalnızca görev adı, kısa açıklama, sorumlular, öncelik, durum ve termin alanlarını düzenler. Her satırda silme eylemi bulunur; silme simgesi yetkisiz durumda açıklayıcı nedenle pasiftir, paneldeki büyük **Sil** düğmesi ise yalnızca sunucudaki kuralla uyumlu yetkili görevlerde gösterilir. Görev başlığı odaklanabilir bir düğmedir: satır tıklaması dışında klavyeyle de açılır.

Dar `ASSIGNEE_CREATE` kapsamında yeni görev tanımlayan normal kullanıcı için Termin alanı etkin ve zorunludur; değer sunucuya `plannedStart`, `plannedFinish` ve `targetFinish` olarak aynı günle gönderilir. Böylece arayüzde seçilen tarih sessizce atılmaz. Başka birinin oluşturduğu mevcut görevde kontrollü planı doğrudan değiştiremeyen sorumlu için Termin salt okunurdur; tarih önerisi Temel ve Kapsamlı Kipteki aynı kalıcı talep akışından yapılır.

Üç davranış Kapsamlı Kiple ortaktır ve bilinçlidir:

- **Boş başlık kalıcılaştırılmaz.** Kullanıcı adı silip yeniden yazarken geçici boş metin yerel taslakta kalır; sunucu boş başlığı reddettiği için kuyruğa hiç girmez.
- **Kısa açıklama/etiket isteğe bağlıdır.** Kullanıcı değer girerse proje etiket kataloğuyla eşleştirilir; değer yoksa görev etiketsiz oluşturulur. Girilen değer katalogda aranır, yoksa yazılabilir projelerde kataloğa eklenir. Proje üst verisi yazılamıyorsa (görev atama kapsamı) açıkça girilen etiket yine görevde saklanır.
- **Gizli plan tarihleri ezilmez.** Temel Kip planı, başlangıç/bitiş/termin hâlâ aynı gün olduğunda "kendi kurduğu plan" sayar ve termin değişikliğiyle üçünü birlikte taşır. Tarihler ayrışmışsa plan Kapsamlı Kipte kurulmuştur; o zaman yalnızca `targetFinish` güncellenir ve görevin Gantt/CPM sonuçları korunur.

`AppShell`, `simpleMode` bayrağına göre sade veya gelişmiş görev tablosunu seçer. Her iki görünüm aynı kalıcı Task modelini ve kabuğun anahtarlı içerik alanı dışında duran `TaskOrganizationFilterProvider` geçici durumunu kullanır; bu nedenle Temel → Kapsamlı ve Kapsamlı → Temel geçişinde seçim korunur. Durum sunucuya yazılmaz. Temel Kip düğmesi yalnızca var olan hızlı kayıt sekmesine geçer.

### Öncelik Temel Kipte

Öncelik, Temel Kipte daha önce hiç görünmüyordu; artık dört yüzeyde birden vardır: Hızlı Görev Tanımı formunda, sadeleştirilmiş tabloda, sadeleştirilmiş görev düzenlemede ve süzme/sıralamada.

Yeni bir öncelik modeli **tanımlanmaz**. Kapsamlı Kipin `TASK_PRIORITIES` kataloğu, `normalizePriorityId` normalleştirmesi ve aynı rozet stilleri kullanılır; iki kip arasında geçiş yapan kullanıcı aynı değeri aynı adla görür.

### Proje seçimi

Hızlı Görev Tanımı ve sadeleştirilmiş görev düzenleme proje listesini `useTaskAssignableProjects()` üzerinden alır. Sıradan kullanıcı için tam yetkili projelere ek olarak, yetkili sorumlusu olduğu görev bulunan proje dar kendi-görev oluşturma kapsamında seçilebilir; müdür/direktör için buna kurumsal CN43N kataloğu eklenir. Bu genişleme proje veya WBS yönetim yetkisi vermez. Kural ve sunucu tarafı sınırı: `docs/AUTHORIZATION-MODEL.md` · *Task assignment scope*.

## Açılış perdesi

İlk veri yüklemesi ve yükleme hatası perdesi (`AppDataBoundary`) uygulama kabuğunun `.app` ızgarasını **kullanmaz**. O ızgaranın ilk sütunu 240 piksellik kenar çubuğuna ayrılmıştır; perde tek çocuk olarak yerleştirildiğinde o dar sütuna düşüyor ve kart ekranın solunda kırpılmış görünüyordu.

Perde artık `.app-boot` sınıfıyla tam ekran, ortalanmış kendi düzenini kurar: marka satırı, başlık, açıklama, belirsiz ilerleme çubuğu ve yükleme adımı rozetleri. Stil sahibi `src/app/styles/shell.css` dosyasıdır.

## Sorumlu seçimi ve büyük kullanıcı listeleri

Sorumlu seçiminin görsel kart tasarımı korunur; ancak tüm kullanıcılar aynı anda gösterilmez. Kullanıcı:

- ad veya personel numarasıyla arama yapabilir;
- en fazla ilk sekiz eşleşmeyi hızlı seçim kartları olarak görür;
- seçtiği kişileri ayrı bir **Seçilenler** bölümünde görmeye devam eder.

Bu yaklaşım, kişi sayısı büyüdüğünde yüzlerce kartın aynı anda render edilmesini önler. Mevcut uygulama kişi listesini istemci tarafında filtreler. Gerçek veritabanı/API entegrasyonunda aynı arayüz korunarak arama sunucu tarafına taşınabilir; bu durumda arama metni sorgu parametresi olarak gönderilmeli, sonuçlar sayfalı veya sınırlı biçimde dönmelidir.

## Üst çubuk proje bağlamı

Proje çalışma alanında proje bağlamı üst çubuğun gerçek yatay ve dikey merkezinde gösterilir:

- proje kodu varsa daha geri planda, gri tonlu ve monospace tipografiyle;
- proje adı vurgu rengi ile ana metin arasında belirgin bir tonla ve daha güçlü ağırlıkta;
- açık ve koyu temalarda `--text-muted` ve `--text` tema değişkenleriyle yeterli ayrım sağlanacak biçimde.

Üst sağ köşedeki dönen MERGEN yedigeni yalnızca `.topbar-emblem-clip` dekoratif katmanı tarafından kırpılır; topbarın kendisi dışa taşan menü ve popoverlar için `overflow: visible` kalır. Bu sözleşmenin sahibi `src/app/styles/shell.css` dosyasıdır.

## Özet yerleşimi

Özet sayfasının grafik ve alt kart satırları aynı üç kolon izini kullanır. Böylece:

- **Tamamlama Trendi** kartının sağ sınırı **Ekip İş Yükü** kartının sağ sınırıyla;
- **Durum Dağılımı** kartının sol sınırı **Yaklaşan Teslimler** kartının sol sınırıyla

hizalanır.

Durum dağılımı halka grafiği ve legend yerleşimi, kabul edilen boyut ve 1280 px davranışını korur. Dashboard yapısı `dashboard-main-grid`, `dashboard-status-card`, `dashboard-status-body`, `dashboard-status-chart` ve `dashboard-status-legend` gibi semantik sınıflarla tanımlanır; inline stil metni veya kart sırası üzerinden çıkarım yapılmaz. Bu sözleşmenin sahibi `src/app/styles/dashboard.css` dosyasıdır.

### Durum dağılımı kovaları birbirini dışlar

Halka grafiği yalnızca birbirini dışlayan kovalarla doğru çizilir. Kovalar
`src/features/dashboard/statusDistribution.js` içinde, uygulamanın her yerinde
kullanılan `getStatus` üzerinden türetilir: bir görev **tam olarak bir** kovaya
girer ve dilimlerin toplamı her zaman görev sayısına eşittir.

Önceki hesap "Yapılacak" ve "Devam eden" kovalarını durum alanından, "Geciken"
kovasını hedef tarihinden türetiyordu. Geciken bir görev aynı anda iki kovaya
birden düştüğü için dilimlerin toplamı görev sayısını aşıyor (44 görev için 54
birim), halka 360 dereceyi geçip kendi üzerine biniyordu.

Üst rozetler (KPI kartları) **aynı kovaları** okur. Daha önce kartlar durum
alanını doğrudan okuyordu ve iki okuma bilinçli olarak farklıydı; sonuç, aynı
ekranda çelişen iki sayı oldu: kart "6 devam eden" derken halka aynı anda "3"
gösteriyordu. Kartlar artık `selectStatusDistribution` kovalarından beslenir,
dolayısıyla dört kartın toplamı her zaman toplam görev sayısına eşittir. Hedefi
geçmiş bir "devam eden" görev yalnızca **Geciken** kartında sayılır ve kartın
ipucu bunu açıkça söyler.

Dilim seçimi sıra numarasıyla değil **kova kimliğiyle** saklanır: görev listesi
kısaldığında saklanan sıra numarası boşa düşüyor ve merkez etiket
`undefined.color` okumasıyla çöküyordu.

### Halka dilimleri kapalı yol olarak çizilir

Dilimler `stroke-dasharray` yerine kapalı yay YOLU olarak çizilir
(`src/components/charts/donutGeometry.js`). Kesik desen çevre boyunca
tekrarlandığı için yuvarlama artığı deseni başa sardırıyor, aynı dilim halkanın
iki ayrı yerinde parça parça görünüyordu; seçili dilimi dışarı öteleyen
"patlatma" da dilimi halkadan kopararak aynı bölünmüş izlenimi veriyordu. Vurgu
artık yalnızca iç yarıçapı değiştirir. Ayrıntı için bkz.
`docs/UI-STYLING-ARCHITECTURE.md` § 10.

### Plan sağlığı kartları

Özet iki eyleme dönük kart daha taşır (ikisi de
`src/features/dashboard/planHealth.js` üzerinden beslenir, Raporlar sayfası
yaşlandırmayı yeniden kullanır):

- **Gecikme yaşlandırması** — geciken görevleri hedef tarihinin üzerinden geçen
  güne göre 1–7 / 8–30 / 31–90 / 90+ kovalarına ayırır. Tek bir "9 geciken"
  sayısı, dün gecikmiş bir işle aylardır bekleyen bir işi aynı kefeye koyar.
- **Plan bütünlüğü** — açık görevlerde eksik kalan planlama alanlarını
  (sorumlu, termin, planlanan tarih, dağılım düğümü) sayar. Eksik alanı olan bir
  görev iş yükü, gecikme ve kritik yol hesaplarının hiçbirine girmez.

### Grafik eksen etiketleri

Eksen etiketleri SVG'nin **dışında**, gerçek HTML metni olarak çizilir. SVG kart
genişliğine göre ölçeklendiği için içine yazılan `font-size` de ölçekleniyordu ve
geniş kartlarda etiketler neredeyse iki katı boyutta görünüyordu.

### Kişi ölçüm tabloları

Özet **Ekip iş yükü** ve Raporlar **Kaynak kullanımı** kartları ortak
`PeopleMetricTable` bileşenini kullanır. Ad esnek sütunu alır ve altında birim
bilgisi gösterilir; kartın kalan yatay alanı boş bırakılmak yerine sayısal
sütunlara ayrılır (iş yükünde toplam/açık/biten/geciken, kaynak kullanımında
kalan saat/görev/boşta kapasite/haftalık ortalama/doluluk). Önceki tek çubuklu
düzen adı sabit 110 pikselik bir sütuna sıkıştırıyor, uzun kurumsal adlar üç
noktaya kırpılıyordu.

Ad **kırpılmaz**: gerekirse satıra sarar ve satır yüksekliği büyür. Tablonun
varlık nedeni uzun kurumsal adların okunabilir olmasıdır; üç noktalı kırpma
korunsaydı ilk sütun daraldığı anda aynı sorun geri gelirdi. Satır ipuçları
`asChild` ile doğrudan satıra bağlanır: varsayılan sarmalayıcı satırı bir
`inline-flex` `span` içine alıyor, `.pm-row` artık `.pm-table`'ın doğrudan
çocuğu olmadığı için ızgara sütunları satırdan satıra kayıyordu.

Kaynak kullanımındaki **haftalık ortalama** ve boşta kapasite yalnızca altı
haftalık rapor ufkuna düşen işi sayar: kalan işin tamamı kapasiteyle
karşılaştırılırsa, önümüzdeki bir yıla yayılmış 240 saatlik yük de "haftada 40
saat" gibi görünüyordu. İş, planlanan aralığın ufukla kesişimi oranında
sayılır; planlanmamış ve gecikmiş işin kalanı bugünün yüküdür.

## Tarih biçimi düzenlenebilir alanlarda da geçerlidir

Ayarlar sayfasındaki **Tarih biçimi** seçeneği (`gg/aa/yyyy` ↔ `18 Ağu 2026`) yalnızca pasif etiketleri değiştiriyordu: `18 Ağu 2026` seçen kullanıcı görev panelinde `18/08/2026` bekleyen bir kutu görüyordu.

`DateInput` artık tercihe uyar. Kurallar React'ten bağımsız `src/components/dateInputFormat.js` modülündedir:

- **Yazma** tercihe uyar (`formatEditableDate`).
- **Okuma** bilerek daha geniştir (`parseDisplayDate`): `18/08/2026`, `18 Ağu 2026`, `18 Ağustos 2026` ve ISO biçimi kabul edilir; ay adı Türkçe küçültme kurallarıyla eşleştirilir. Biçim değiştiğinde yarım kalmış bir giriş ya da kopyalanmış eski bir metin reddedilmemelidir. Takvimde olmayan gün (`31 Şub 2026`, `2026-02-31`) **her biçimde** reddedilir — ISO metni rakam maskesini atladığı için gerçek takvim doğrulaması ayrıca uygulanır, aksi hâlde imkânsız tarih mart ayına yuvarlanıyordu.
- **Rakam maskesi** yalnızca rakam ve eğik çizgi içeren girişe uygulanır (`maskDateDraft`); aksi hâlde `18 Ağu 2026` yazılırken rakamlar ayıklanıp `18/20/26` üretiliyordu.
- **Yer tutucu ve hata iletisi** tercihten türetilir; koda gömülü `gg/aa/yyyy` metni kalmadı.

Taslak durumu değerin yanı sıra biçim tercihine de bağlıdır: aksi hâlde değer aynı kalırken tercih değiştiğinde kutu eski biçimde donuyordu.

## Karşılama ekranı

Ekran, doğrulanmış oturumdan gelen kullanıcı fotoğrafı (yoksa baş harf yedeği),
adı ve departmanıyla kişiselleştirilmiştir. Kimlik yalnızca **gösterim**
amaçlıdır; hiçbir yetki kararı buradan türetilmez.

Saate göre selamlama **yalnızca tarayıcıda** hesaplanır. Bu istemci bileşeni
sunucuda da ön-render edilebilir; `new Date()` orada sunucu saat diliminde
okunur ve iki taraf farklı dilime düşerse hidrasyon uyuşmazlığı ve yanlış
selamlama oluşurdu. Bağlanana kadar dilimden bağımsız bir metin gösterilir.

Ölçüm kartları **portföyün tamamını** özetler (`usePortfolioTaskStats`), çalışma
alanı seçimini değil: başlık portföy özeti dediği hâlde, son çalışma alanı tek
bir proje olan kullanıcıya o projenin sayıları gösteriliyordu.

Özellik kartları bir **gezinme niyeti** taşıyabilir. "Sürükle-bırak iş dağılım
ağacı" kartı `wbs` sayfasını `tree` sekmesiyle açar; niyet olmasaydı kart adını
taşıdığı ağaca değil, Proje Tanımı sekmesine düşerdi.

## Kenar çubuğu görünüm kontrolleri

Tema, **Temel Kip / Kapsamlı Kip** seçimi ve oturum kapatma eylemleri
`SidebarUserPanel` içindeki tek alt araç alanında yaşar. İki seçenekli kip
seçicisi `role="group"` ve `aria-pressed` ile etkin tercihi bildirir; seçili
kipe yeniden basmak gezinmeyi sıfırlamaz. İç kimlikler (`simple`, `advanced`,
`appMode`) ve kaydedilmiş tercihler korunur. Üst çubuk bu kontrolleri yinelemez.
Temel Kipe geçiş `AppShell.chooseMode` üzerinden seçili çalışma alanını koruyarak Takvimi açar.

Kenar çubuğu ilk kullanımda **sabitlenmiş ve açık** başlar. Gereksiz çalışma
alanı başlıkları ve daraltma oku yoktur; proje seçicisi markanın hemen altında
yer alır. Alt raptiye sabitlemeyi kaldırınca ana sütun 72 piksele iner.
Fare üzerine geldiğinde veya klavyeyle gezinirken geçici olarak açılır.
Fare görünen çubuğun dışına çıktığında gezinme düğmesinde kalan odak çubuğu
açık tutmaz. Klavye odağı içerideyken açık kalır; dışarı çıktığında kapanır.
Yeniden sabitleme açık durumu korur. Tercih `mergen_rota_sidebar_v1` anahtarıyla
saklanır; azaltılmış hareket tercihinde geçiş animasyonları kapatılır.

Görev penceresindeki **Görevi tanımlayan** satırı fotoğrafı, adı ve oluşturma
tarihini yerel saat/dakika ile gösterir. Yeni görevde taslağın zamanı, kayıttan
sonra kalıcı `createdAt` kullanılır. Dar ekranlarda tarih ayrı satıra geçer.
Her iki görev düzenleyicisinde Kaydet düğmesi kayıt simgesi taşır; işlem
sürerken simgenin yerini mevcut bekleme göstergesi alır.

## Kanban araması ve Gantt avatarları

Kanban, Görevler ile aynı `TaskOrganizationFilterControls` ve
`useTaskOrganizationFilter` bileşenlerini kullanır. Arama ve kurumsal seçim
birlikte uygulanır; yalnızca görünür görevler kolonlara ve sayılara girer.
Kurumsal seçim Görevler ile paylaşılır, arama sayfaya özeldir. Filtreleri
temizle ikisini de sıfırlar. Seçili proje değiştiğinde artık geçerli olmayan
alt kurumsal yol ortak süzgeç kurallarıyla temizlenir. Gizlenmiş bir kartın
bekleyen sürüklemesi durum güncellemesi yapmaz.

Gantt görev ve kilometre taşı ipuçları her sorumlunun fotoğrafını adıyla
birlikte gösterir. WBS görünümü aynı `GanttAssignees` bileşenini kullanır.
Sorumluya göre gruplama ilk sorumluyu esas alır; Sicil kimliği aynı adlı
kişileri ayırır ve özet satırının avatarını belirler. Fotoğraf bulunamazsa
baş harf yedeği kullanılır; sunucunun görev kapsamlı kimlikleri yeterlidir.

## Kayıt göstergeleri

Görev tanımı ve düzenlemesi veritabanına yazılırken birkaç saniye sürebilir.
`src/components/Loader.jsx` üç göstergeyi tek yerde toplar ve hepsi aynı
hareket dilini kullanır; `reduce-motion` tercihinde animasyonlar CSS tarafında
yavaşlar:

- `Spinner` — düğme ve durum satırlarındaki dönen halka,
- `ButtonSpinner` — kayıt sürerken düğmenin simgesinin yerini alır,
- `SavingOverlay` — Hızlı Görev Tanımı kartının üzerine yayılan ve işaretçi
  etkileşimini kesen perde. Klavye etkileşimini kendi başına kesmez: her çağıran
  etkileşimli içerik ağacına kayıt boyunca `inert` uygulamalı, erişilebilir durum
  bildirimini ise bu `inert` ağacının dışında tutmalıdır.

Kullanıldığı yerler: Hızlı Görev Tanımı (`Takvime ekle`), iki kipteki görev
panelinin **Kaydet** düğmesi, dışa aktarma
menüsü ve sağ alttaki kalıcılaştırma şeridi (`Kaydediliyor…` + ilerleme
süpürmesi).

## Görev tablosu · çapraz sütun süzgeçleri

Kapsamlı Kipteki **Görevler** tablosunda bir sütuna süzgeç uygulandığında öteki
sütunların seçenek listesi de daralır: menüde yalnızca o an görünen satırlarda
bulunan değerler kalır (`src/features/tasks/taskTableFacets.js`). Seçenekler
süzülmemiş kümeden üretildiğinde kullanıcı, sonucu kesinlikle boş olan bir
değeri seçebiliyordu — örneğin bir proje süzülüyken başka projenin sorumlusunu.

Bir sütunun **kendi** süzgeci, kendi seçenekleri hesaplanırken yok sayılır;
aksi hâlde seçili değerin dışındaki her seçenek listeden düşer ve ikinci bir
değer eklenemezdi. Seçili değerler ayrıca listede tutulur: otomatik yenileme ya
da kurumsal seçim satırları kaldırdığında kullanıcı o değeri işaretten
çıkarabilmelidir. Satır süzmesi ile faset hesabı **aynı yüklemi** kullanır
(`taskTableMatches`), böylece iki kopya arasında kural farkı oluşmaz. Temel Kip
tablosu aynı davranışı `simpleTaskFacets.js` ile zaten uyguluyordu.

## Görev tablosu · büyük yazı tipinde yerleşim

Yazı ölçeği gövdeye `zoom` uygular; görünüm alanı CSS pikseli cinsinden küçülür
ve 12 sütunlu tablo yatay kaydırmaya girer. Önceden en sağdaki **posta** ve
**silme** düğmeleri görüş dışında kalıyor, tarih ve sorumlu sütunları ise
gereğinden geniş duruyordu. Üç kural bunu düzeltir:

1. Sütun alt sınırları içeriğe göre daraltıldı (tarihler 130 → 96 piksel,
   sorumlu 150 → 96, öncelik 100 → 86); tablonun doğal genişliği ~1540
   pikselden ~1230 piksele indi.
2. Eylem sütunu **sağa yapışıktır** (`position: sticky; right: 0`); tablo
   kaydırılsa da posta ve silme düğmeleri her zaman erişilebilir kalır. Aynı
   kural Temel Kip tablosunda da geçerlidir.
3. Kapsayıcı daraldığında sıra numarası sütunu düşer ve hücre boşluğu azalır.
   Ölçüt **kapsayıcı sorgusudur** (`@container`), ortam sorgusu değil: `zoom`
   pencere boyutunu değiştirmediği için `@media` bu daralmayı göremez.

Başlıklar sarmalanmaz; uzun metin yalnızca gövde hücrelerinde sarılır.

## Gantt · anahat denetimleri ve kilometre taşları

Gantt araç çubuğundaki İngilizce **Zoom** etiketi **Yakınlaştırma** oldu ve
S/M/L düğmeleri **Dar / Orta / Geniş** olarak yazıldı. Yanına ortak anahat
denetimleri eklendi (`src/features/gantt/GanttOutlineControls.jsx`):

- **Genişlet / Daralt** — bütün grupları (Portföy Gantt'ı) veya bütün WBS
  dallarını (WBS Gantt'ı) tek tıkla açar/kapatır.
- **Seviye** — yalnızca WBS Gantt'ında görünür ve hiyerarşiyi belirtilen
  seviyeye kadar açar. Seviye 1 yalnızca kökleri gösterir. Eşleme saf bir
  modülde tutulur (`ganttOutlineLevels.js`); kullanıcı dalları tek tek açtıysa
  hiçbir seviye düğmesi etkin görünmez.

Talep penceresi yalnızca **sorduğu** alanları gönderir; sunucu eksik alanları
kilitli görev satırından tamamlar. Gizli alanlar da taşınsaydı, pencere açıkken
planı başkası değiştirdiğinde öneri panelin eski değerlerini kalıcılaştırır ve
kabul, kullanıcının hiç istemediği bir geri alma yazardı.

**Kilometre taşı**, görev panelindeki *Güncel plan* kartında bir anahtarla
tanımlanır (tam proje yetkisi gerekir). Açıldığında görev sıfır süreli tek bir
güne indirgenir: planlanan bitiş başlangıcı izler, süre sıfırlanır ve alan
"Kilometre taşı tarihi" olarak adlandırılır. Gantt görünümleri bu görevi çubuk
yerine eşkenar dörtgenle çizer. Alan daha önce veri modelinde ve dışa aktarımda
vardı ama hiçbir ekrandan **tanımlanamıyordu**; bu yüzden Gantt'ta kilometre
taşı hiç görünmüyordu.

## Sütun süzgeçlerinde canlı arama

Çoklu (`multi`) ve tekli (`single`) sütun süzgeçleri, seçenek sayısı
`OPTION_SEARCH_THRESHOLD` değerini (7) aştığında listenin üstünde bir arama
alanı gösterir. Görevler sayfasındaki **Proje**, **Sorumlu**, **Etiket**,
**Durum**, **Öncelik**; Ekip sayfasındaki kırılım süzgeçleri ve Gantt
sayfasındaki **Sorumlu** süzgeci aynı bileşeni kullandığı için davranış her
yerde aynıdır.

Eşleştirme kuralı `src/components/columnFilterSearch.js` içinde saf bir işlev
olarak yaşar ve seçeneğin etiketi, değeri, açıklaması ve `keywords` alanı
üzerinde çalışır. Kişi süzgeçleri sicil, kullanıcı adı, unvan ve birimi;
proje süzgeci proje kodu ve türünü anahtar sözcük olarak taşır — binlerce
kayıtlık bir dizinde ad tek başına yeterli bir arama anahtarı değildir.

Karşılaştırma **iki katlamayla** yapılır. Türkçe katlama insan adları için
doğrudur: `toLowerCase()` "İ/ı" ayrımı yüzünden kurumsal adlarda yanlış sonuç
verir. Ancak aynı yardımcı proje kodu, Sicil ve kullanıcı adı gibi ASCII
tanımlayıcıları da arar; `MIR` kodu Türkçe katlamada `mır` olur ve kullanıcı
`mir` yazdığında hiç eşleşmezdi. Bu yüzden her iki katlama da denenir.

Süzgeç **değeri** görünen ad değil, kararlı kimliktir (proje kimliği, Sicil).
Ada göre süzülseydi aynı ada sahip iki proje ya da iki çalışan tek seçenekte
birleşir; kullanıcı benzersiz kodu arayıp birini seçse bile sonuçta ikisi de
listelenirdi.

Tek seçimli süzgeçte **Enter**, arama tek bir seçeneğe indiyse onu uygular.
Genel `apply()` çağrısı aranan değeri değil, önceden seçili radyo değerini
uyguluyordu: kullanıcı arayıp Enter'a bastığında süzgeç eskisi gibi kalıyordu.

**Seçili değerler aramada elense bile listede kalır.** Aksi hâlde kullanıcı
arama yazdığında neyi seçtiğini göremez ve farkında olmadan seçimini
kaldırabilirdi.

## Uzun listeler için aranabilir seçim bileşeni

Proje, personel, iş dağılım düğümü ve öncül görev gibi binlerce kayda ulaşabilen tüm seçim noktaları `SearchableSelect` bileşenini kullanır. Bileşenin sözleşmesi:

- açılır panel **React portalı ile `document.body` altına** taşınır. Panel `position: fixed` ile tetikleyiciye göre konumlanır ve `computePopoverPlacement` (bkz. `src/components/searchableSelectPlacement.js`) tarafından görünüm alanı içinde tutulur; alt kenara sıkışan liste yukarı açılır, yan kenardan taşan liste içeri çekilir;
- panel gövdeye taşındığı için daraltılmış/geçici açılmış kenar çubuğunun boyutu ve `.sidebar > *` yığın bağlamı listeyi etkilemez. Daha önce liste kenar çubuğunun içinde kalıyor, gezinme bağlantıları listenin üzerine boyanıyor ve liste arka planla karışmış görünüyordu;
- panel `--z-select-popover` katmanını kullanır. Bu katman kip pencerelerinin (`--z-modal`) üzerindedir; böylece bileşen bir kip pencere içinde de kullanılabilir;
- liste her zaman opak `--bg-elev` zeminine sahiptir;
- `allowClear` verildiğinde panelin üstünde bir **temizleme satırı** çıkar. Portföy/proje seçimi bu sayede geri alınabilir;
- klavye ile gezinme (`↑ ↓ Home End Enter Esc`) desteklenir ve etkin satır görünür alanda tutulur.

Yeni bir uzun liste eklenirken ham `<select>` kullanılmamalıdır. Ham `<select>` yalnızca sabit ve kısa numaralandırmalar (ilişki türü, gecikme birimi, ay/yıl) için uygundur.

## Temel Kipte serbest proje tanımlama

Kurumsal proje kataloğu binlerce kayıt içerebildiği ve açılır liste yalnızca ilk N sonucu gösterdiği için **Serbest proje tanımla** seçeneği listenin başına sabitlenir (`withManualProjectOption`). Seçenek yalnızca oturumun `canCreateProjects` yetkisi varsa eklenir.

Serbest proje tanımı ekranından kurumsal listeye **Kurumsal proje listesine dön** düğmesiyle geri dönülür.

Temel Kipte proje oluşturmak etkin çalışma alanını **değiştirmez** (`addProject(input, { focusWorkspace: false })`). Çalışma alanı değiştiğinde uygulama kabuğu içerik alanını yeniden monte ettiği için hızlı görev formu kayıt tamamlanmadan sıfırlanıyor, kullanıcı ne sonucu ne de hatayı görebiliyordu.

### Görev tanımlamadan yalnızca proje oluşturma

Kullanıcı bir projeyi açıp görevleri **sonra** tanımlamak isteyebilir. Bu nedenle Temel Kipte, hızlı görev formundan bağımsız bir **Yeni proje** düğmesi bulunur; düğme Kapsamlı Kipteki `ProjectCreateDialog` penceresini açar ve yalnızca projeyi (ve kök iş dağılım düğümünü) oluşturur. Oluşturulan proje form üzerindeki proje seçiminde etkin hâle gelir, çalışma alanı değişmez ve hiçbir görev kaydı üretilmez. Düğme oturumun `canCreateProjects` yetkisi yoksa devre dışıdır.

Pencere, hızlı görev formunun **dışında** render edilir: iç içe `<form>` öğeleri geçersiz HTML'dir ve tarayıcı iç formu yok sayar.

Etiket kataloğuna yazma, görev kaydından **bağımsız ikincil bir işlemdir**. Proje satırı yazılamıyorsa görev yine oluşturulur ve kullanıcıya uyarı gösterilir; asıl işlem ikincil bir yazma yüzünden engellenmez.

## Geri dönüş yolları

Her seçim yapılabilen yüzeyin geri dönüş yolu bulunmalıdır:

| Yüzey | Geri dönüş |
| --- | --- |
| Kenar çubuğu · Aktif çalışma alanı | Açılır listedeki **Portföye dön (tüm projeler)** satırı ve seçicinin altındaki **Portföye dön** düğmesi |
| Proje Yapısı sayfası | Sekme çubuğundaki **Proje listesi** düğmesi (proje seçili olduğunda görünür) |
| Temel Kip · Serbest proje tanımı | **Kurumsal proje listesine dön** düğmesi |

## Veri kipi anahtarı ve kaydetme bildirimi

Sağ alt köşe yalnızca **kaydetme bildirimine** (`.persistence-status`) aittir. Demo/Gerçek Sistem anahtarı **Ayarlar** sayfasındaki *Veri kaynağı* kartında yaşar (`DataModeIndicator variant="settings"`). Kenar çubuğu ve veri sınırı ekranı bu veri kaynağı anahtarını göstermez; kenar çubuğu çalışma alanı, gezinme, kullanıcı bilgisi ve tema/kullanım kipi/oturum araçlarını taşır.

Ayarlar sayfasına yalnızca uygulama kabuğu üzerinden ulaşıldığı için **ilk** veri yüklemesi başarısız olduğunda hata ekranı ayrıca bir **Demo kipine geç** çıkışı sunar (`DemoModeEscape`). Bu tek düğme olmadan Gerçek Sistem erişilemediğinde uygulama tamamen kilitlenirdi.

## Uygulama kabuğu yeniden yüklemede sökülmez

`AppDataBoundary` yükleme/hata perdesini **yalnızca ilk veri yüklemesinde** gösterir (`dataStatus === 'loading' && !hasLoadedOnce`). Daha önce her yeniden yükleme kabuğu söküyordu: proje oluşturduktan veya değişiklik kaydettikten sonra `AppShell` yeniden monte oluyor, açık sayfa ve karşılama ekranı tercihi sıfırlanıyor ve uygulama ilk kez açılmış gibi davranıyordu.

Veri zaten yüklüyken başarısız olan bir tazeleme kabuğu kapatmaz; kullanıcı son başarılı veriyle çalışmayı sürdürür ve kaydetme bildirimi alanında **Veriler yenilenemedi** uyarısı ile yeniden deneme düğmesi gösterilir.

## Proje Yapısı · yalnızca proje listesi kaydırılır

Proje seçici kartında başlık, arama alanı, tamamlananları gösterme kutusu ve proje türü hızlı seçim düğmeleri donuk (`.project-browser-head`) kalır; yalnızca listelenen proje düğmeleri (`.project-browser-list`) dikey olarak kaydırılır. Kurumsal katalog yüzlerce proje içerdiği için süzgeçler daha önce listeyle birlikte görünüm alanının dışına kayıyordu. **Daha fazla göster** düğmesi de kaydırılan bölümün içindedir.

## Ekip sayfası · donuk başlıklar ve tanımsız direktörlük

Ekip sayfası kendi yüksekliğini yönetir: "Kurumsal ekip dizini" kartı sabit kalır ve yalnızca personel tablosu kayar, böylece tablo başlığı ile süzgeçler aşağı kaydırırken de görünür durur.

Kurumsal rehberde herkesin direktörlüğü tanımlı değildir; bir bölüm çalışanın yalnızca yöneticisi bilinir. Bu kişiler önceki sürümde hiçbir grupta görünmüyordu. Artık "Direktörlük tanımsız" hem özet kartı hem de süzgeç seçeneği olarak listelenir; süzgeç mantığı `src/features/team/teamDirectoryPolicy.js` içindeki `matchesDirectorateFilter` işlevindedir.

Tablo sütunları Görevler sayfasıyla aynı süzgeç/sıralama bileşenini kullanır ve
kurumsal düzey süzgeçleri üstteki dizin açılır listeleriyle tek durumu paylaşır.
Ayrıntı: `docs/PROJECT-PORTFOLIO-AND-DIRECTORY.md`.

## Ekip · personel ayrıntı penceresi

Ekip tablosunda personel adı bir düğmedir; tıklandığında kişinin kurumsal
kimliğini, yük özetini, öncelik kırılımını ve **yakın görevlerinin tam
listesini** gösteren bir pencere açılır (`PersonDetailDialog`). Tablo satırı
yalnızca ilk iki görevi gösterebiliyordu.

Liste yalnızca **açık** görevleri taşır: kapanmış bir iş "yaklaşan" değildir.
Aciliyet tonlaması saf bir ilkedir (`upcomingTaskPolicy.js`) ve ayrıca sınanır;
hedef bitiş yoksa planlanan bitişe düşülür, ikisi de yoksa görev tarihsiz
sayılır — uydurma bir tarihle listeye sokulmaz. Pencere kimlikle açılır, bu
sayede süzgeç değişip satır listeden düştüğünde ekranda eski veri kalmaz.

## Kenar çubuğu kullanıcı bloğu

Kenar çubuğunun altındaki kullanıcı bloğu artık sabit bir örnek kişi değil,
**doğrulanmış oturum kullanıcısıdır** (`session.currentUser`):

- kurumsal fotoğraf, Sicil'den `<TABAN_URL>/<SICIL>.jpg` biçiminde üretilir;
  adres yoksa ya da görsel yüklenemezse baş harflere dönülür;
- ad satırının altında **Keycloak `department` claim'i** gösterilir; uydurma bir
  "rol" metni yoktur. Değer yoksa nötr `Departman bilgisi yok` yazılır;
- departman adları uzun olabildiği için satır tek satıra zorlanmaz: küçük yazı
  tipi, sıkı satır yüksekliği ve çok satıra sarma kullanılır, taşma engellenir.

Eski **Kullanım rehberi** kısayol düğmesi bu satırdan kaldırılmıştır; boşalan
yatay alan kimlik bloğuna verilmiştir. Yardım sayfası ve gezinme öğesi
yerindedir. Tema düğmesi korunur; Gerçek Sistem'de kompakt bir **Oturumu kapat**
düğmesi eklenir.

Avatar boyutları fotoğrafın okunabilir olması için ölçülü biçimde büyütülmüştür:
satır içi (`sm`) 26 px, tablo/kart (varsayılan) 32 px, kenar çubuğu (`lg`) 40 px.
Boyutlar `src/app/globals.css` içindeki `--avatar-size` değişkeniyle tek yerden
yönetilir.

## Proje Yapısı · İş Dağılım Ağacı denetimleri

Dağılım ağacı sekmesinde dikey alan tabloya ayrılır: üst bilgi tek satırlık bir başlık çubuğuna (`.wbs-toolbar`) indirgenir, uyarılar ince notlara dönüşür, görev taşıma paneli varsayılan olarak kapalıdır ve tablo kalan yüksekliğin tamamını alarak kendi kaydırma kabuğunda kayar. Başlık satırı donuktur.

Ağaç denetimleri `Tümünü aç`, `Tümünü kapat` ve `Hiyerarşi` (1–5 arası seviye ya da tüm seviyeler) düğmeleridir. Açılış derinliği ikidir; kurumsal projelerde ağacın tamamını açık başlatmak on binlerce satırın ilk çizimde oluşturulması demekti.

### Sürükle-bırak hiyerarşi düzenleme

Düzenlenebilir projelerde satırlar sürüklenebilir. İmlecin satır içindeki dikey
konumu bırakma niyetini belirler: üst/alt kenar şeridi (%28) kardeş sırası,
orta bölge alt düğüm yapar. Kural ihlali olan bir bırakma kırmızı vurgu ve
gerekçe ipucuyla gösterilir, uygulanmaz. Kapalı bir düğümün üzerinde kısa süre
beklemek alt ağacı kendiliğinden açar.

Kural mantığı görünümden ayrıdır (`src/features/wbs/wbsDragPolicy.js`) ve tek
başına sınanır. Fare kullanmadan taşımak için satırdaki **Taşı** düğmesi
korunmuştur.

> **Gerileme kaydı.** Görünüm bu ilke modülünden `wbsSiblings` ve
> `createWbsDropIndex` işlevlerini kullanıyor ama **içe aktarmıyordu**. Sekme
> açılır açılmaz `ReferenceError: wbsSiblings is not defined` fırlıyor ve sayfa
> "Application error: a client-side exception has occurred" ile çöküyordu; hata
> yalnızca satır çizimi sırasında oluştuğu için ne birim testleri ne de
> `next build` yakalıyordu. `test/module-binding-and-recurrence-editing.test.mjs`
> artık kaynak ağacının tamamını tarar: bir modülün dışa aktardığı bir işlev,
> başka bir dosyada içe aktarılmadan çağrılıyorsa test düşer.

Sürükleme tutamağı `pointerup`/`pointercancel` olaylarını **pencere düzeyinde**
dinler. Tutamağa basıp sürüklemeden başka bir yerde bırakmak satırı
`draggable` durumda bırakıyor ve içindeki metin seçilemiyordu.

Alt düğüm ekleme, ad değiştirme ve silme artık engelleyici `prompt()`/`confirm()`
pencereleri kullanmaz: ekleme ve ad değişikliği satır içi bir alanda (Enter
kaydeder, Esc vazgeçer), silme ise satır üzerinde onay ister.

Ağaç görünüm durumu (açık düğümler, paneller, seçimler) yalnızca **proje
değiştiğinde** sıfırlanır. Önceden her düzenleme yeni bir satır dizisi ürettiği
için ağaç varsayılan derinliğe kapanıyordu.

## Vurgu rengi adları

Ayarlar sayfasındaki vurgu rengi kataloğu Türkçedir. `Amber` yerine proje renk kataloğuyla aynı sözcük olan `Kehribar` kullanılır.

## Kurumsal iş dağılım ağacı salt okunurdur

Gerçek Sistem kipinde kurumsal projelerin İş Dağılım Ağacı sekmesi düzenleme eylemlerini (Alt ekle / Ad / Taşı / Sil) hiç göstermez, satırlar sürüklenemez ve yapının CN43N kaynağından beslendiğini açıklayan bir bilgi kartı sunar. Satırlarda kaynaktan gelen seviye, PYP kodu, eleman türü ve durum bilgisi gösterilir. Görevleri bu düğümlere atamak ve düğümler arasında taşımak yine mümkündür; görev-WBS bağı MERGEN Rota verisidir. Demo kipinde kurumsal kaynak bulunmadığı için örnek projelerin ağacı düzenlenebilir kalır.

Kaydetme bildirimi artık sabit "Kaydetme hatası" metni yerine sunucunun gerçek iletisini, hata kodunu ve varsa alan/yol bilgisini gösterir. Sürüm/eşzamanlılık hatalarında (`CONFLICT`, `UPSERT_CREATE_COLLISION`, `UPSERT_TARGET_MISSING`) **Verileri yeniden yükle** eylemi sunulur.


## Windows VM üzerindeki `npm run build` uyarıları

### React Hook bağımlılık uyarısı

Önceki sürümde `AppShell.jsx` içindeki Temel Kip `useEffect` bağımlılık listesi bütün `workspace` nesnesini dolaylı olarak kullanıyordu. Bu nedenle ESLint şu uyarıyı üretebiliyordu:

```text
React Hook useEffect has a missing dependency: 'workspace'.
```

Bu bir derleme hatası değildi; üretim build'i tamamlanabiliyordu. Bununla birlikte ileride kapanış (closure) kaynaklı beklenmeyen davranışlara yol açmaması için düzeltilmiştir. Effect artık yalnızca kullandığı `workspaceMode` ve `selectWorkspace` değerlerini açık bağımlılık olarak izler.

### `npm warn Unknown user config "distrurl"`

Bu uyarı uygulama kaynak kodundan değil, komutu çalıştıran Windows kullanıcısının npm kullanıcı yapılandırmasından kaynaklanır. Mevcut npm sürümünde build'i engellemez; ancak npm'in sonraki ana sürümünde bu bilinmeyen ayarın desteklenmeyeceği bildirilmektedir.

Yapılandırmayı görmek için:

```bash
npm config get userconfig
npm config list
```

Yanlış yazılmış ayar gerçekten `distrurl` ise kaldırmak için:

```bash
npm config delete distrurl
```

Kurum içi npm registry/proxy yapılandırması kullanılıyorsa ayarı silmeden önce sistem yöneticisinin beklenen ayar adını doğrulaması gerekir.

### `deprecated` paket bildirimleri

`npm install` sırasında görülen `deprecated` satırları da tek başına build hatası değildir. Bunlar doğrudan veya geçişli bağımlılıkların eski sürümlerine ilişkin bildirimlerdir. Uygulamanın çalışan sürümünü bozma riski nedeniyle, paket güncellemeleri bu arayüz düzeltmesinden ayrı bir bakım çalışmasında `npm test` ve `npm run build` ile doğrulanarak yapılmalıdır.


## Stil sahipliği

Temel Kip arayüz stilleri `src/app/styles/simple-mode.css` içinde sahiplenilir. Üst çubuk `shell.css`, Özet/Dashboard `dashboard.css` tarafından yönetilir. Yerel bir görsel sorun için yeni bir global `fixes` veya `polish` katmanı eklenmemelidir; ilgili yetkili stil sahibi düzeltilmelidir. Ayrıntılar için `UI-STYLING-ARCHITECTURE.md` dosyasına bakın.


## Proje seçimi, ölçek ve Takvim görünümü

Her iki kipte Takvimde ay/yıl seçimi ve Bugün düğmesinden sonra, Normal/Büyük denetiminden önce aynı araç çubuğu satırında Görevler ile aynı **Direktörlük → Müdürlük → Birim** seçicileri bulunur. Seçim Görevler, Kanban ve Takvim geçişlerinde korunur; gün kutuları ve genişletilmiş gün penceresi aynı süzülmüş görevleri gösterir. **Filtreleri temizle** tüm kurumsal seçimleri sıfırlar. Dar ekranda seçiciler ortak **Kurumsal filtre** menüsünde toplanır.

Birim yöneticisi dahil atama yetkisi bulunan görev oluşturucusu, kendi kurumsal görevinde kapsamındaki sorumluları ekleyip çıkarabilir ve görevi silebilir. İki kipin liste ve panelleri aynı yetki kararını kullanır. Sorumlu değişikliği görevde en az bir kapsam içi sorumlu bırakmalıdır. Etiket, başlık ve tarih düzenlemeleri aynı görev kaydetme akışından geçer; başka bir kullanıcının güncel sürümü eski bir kayıtla ezilmez.

Her iki kipte kenar çubuğu aynı aranabilir proje/portföy seçicisini kullanır. Kip değişimi seçili projeyi sıfırlamaz; Görevler, Takvim ve Gantt bu kapsamı izler. **Tamamlanan ve kapatılanları göster** tercihi kenar çubuğundan **Ayarlar → Çalışma alanı** kartına taşınmıştır ve diğer görünüm tercihleriyle saklanır. Bu tercih seçicinin proje listesini etkiler; görev veya proje erişimini genişletmez.

Temel Kip Görevler tablosu sabit sütun alt genişlikleri yerine oransal genişlikler kullanır. Proje adı, görev başlığı, durum ve başlıklar dar alanda satıra geçer. Ölçek büyüdüğünde tüm sütunlar kullanılabilir genişliğe sığar; içerik yüksekliği büyüyebilir. Eylemler gerektiğinde alt alta yerleşir ve hiçbir sütun gizlenmez.

Koyu temada hafta sonları daha açık mavi zemin ve üst kenar çizgisiyle ayrılır. Takvim gün penceresi 800 piksele, Takvimden açılan görev paneli 860 piksele kadar genişler; ekran ve ölçek sınırları korunur. Kenar çubuğu genişliği ile etiketlerin görünürlüğü yumuşak geçiş yapar. Hareketi azalt tercihi bu geçişleri kapatır.

## Görev penceresinde açık kayıt

Temel ve Kapsamlı Kipte yeni veya mevcut görevde yapılan değişiklikler **Kaydet** seçilene kadar yerel taslakta kalır. Sorumlu, başlık, kısa açıklama/etiket, not, tarih, durum, öncelik, ilerleme, proje/WBS, bağımlılık ve tekrar alanları yazarken, odak kaybında veya pencere kapatılırken sunucuya gönderilmez. Kapatma ve arka plana tıklama taslağı bırakır. Boş başlık kaydı engeller; pencere yine kapatılabilir.

Kaydet, görev ve değişen ardıl bağlantılarını tek değişiklik kümesinde gönderir. Kayıt sürerken alanlar ve tekrar tıklama kilitlenir. Başarılı sonuçtan sonra pencere kapanır; hata taslağı açık tutar. Yeni yetkili snapshot geldiğinde düzenlenen değerler korunur; eski sürüm güncel kaydı ezemez. Etiket kataloğuna ekleme yetkisi varsa Temel Kip kısa açıklaması aynı işlemde kataloğa eklenir. Başlık ve not için ayrı istek, kapanışta ek debounce beklemesi ve değişmeyen sorumluların tekrar yazılması yoktur.

Sorumlu seçimi ve yazma `assigneeIds`/Sicil ile yapılır; adlar yalnızca gösterim içindir. Aynı adlı çalışanlar sicilleriyle ayrı ayrı seçilebilir, çıkarılabilir ve yeniden yüklenebilir. Yöneticiye ait manuel projeler ve yeni serbest proje formu da kurumsal atama kapsamıyla sınırlıdır; sistem yöneticisi istisnası korunur.

Tarih talebi ayrıntısındaki **Görevi aç**, görev kimliğini çözer ve gerekirse yetkili veriyi yeniler. Farklı proje çalışma alanındaki göreve geçerken proje bağlamı da güncellenir. Silinmiş veya erişimi kaldırılmış görev için açık bir hata gösterilir.

Yeni görev oluştururken de **Öncüller** ve **Ardıllar** tanımlanabilir. Ardılın türü/gecikmesi ve kaldırılması taslakta tutulur; Kaydet yeni görevle tüm bağlantıları aynı transaction içinde yazar. Kapatma bağlantıları da bırakır; döngü, farklı proje, yetki veya sürüm hatasında hiçbir kısmi kayıt oluşmaz. Proje seçimi değişirse önceki projeye ait bekleyen ardıl bağlantıları temizlenir. Bağımlılık düzenlemesi tam proje yetkisi gerektirir.


Kaydedilmemiş görev taslakları sekme kapatma/yenileme korumasına katılır. Demo/Gerçek Sistem geçişi açık taslak varken durur ve Kaydet veya kapatarak vazgeçme yönlendirmesi gösterir. Temel/Kapsamlı Kip değişimi aynı görev taslağını korur. Yerel taslak varken hatırlatma e-postası gönderilemez; önce Kaydet gerekir. Tekrar hazırlama ve ardıl düzenlemeleri de bu korumaya dahildir.

Taslakta proje değişince alan yetkileri birikmiş düzenlemeye göre yeniden hesaplanır. Kaydet, düzenlenen görevlerin önceki gecikmeli yazmalarını önce tamamlar; eski değerler yeni taslağın üzerine yazılmaz. Başarılı yerel yazmanın sürümü ilerletilir, gerçek dış sürüm çakışmaları reddedilir. FULL erişimi olan yöneticiler de son sorumluyu kaldıramaz; dar sorumlu oluşturma kapsamındaki kişi yalnızca kendisini seçebilir.


## Talepler ve bildirim önizlemesi

Her iki kipte düz **Talepler** sayfasının Bekleyenler, Gönderdiklerim ve Geçmiş sekmeleri vardır. Kalıcı geçmiş sunucuda sayfalanır; zil yalnızca sekiz önizleme ile okunmamış/bekleyen sayaçlarını taşır. Okuma veya görünenleri temizleme iş kaydını silmez; açık kararlar görünür kalır. Ayrıntılar ve dağıtım adımı: [Talepler ve bildirimler](REQUESTS-AND-NOTIFICATIONS.md).

## Özet KPI ayrıntı penceresi

Toplam görev, Tamamlanan, Devam eden, Yapılacak ve Geciken kartlarının mevcut zengin açılır listeleri korunur. İçlerindeki **Tüm görevleri gör**, kartın aynı görev kümesiyle geniş bir pencere açar. Özet tarih aralığı ve çalışma alanı kapsamı korunur. Pencere görev/proje/sorumlu araması, proje ve Sicil temelli sorumlu seçimi, 100 kayıtlık sayfalama, başlık ve toplam/eşleşen sayısı içerir. Görev, Proje, Sorumlu, Durum, Başlangıç, Bitiş ve Hedef gösterilir. Görev başlığı mevcut paneli açar; panel kapatılınca liste ve süzgeçler geri gelir. Pencere kapanınca Özet yerinde kalır. Escape, Tab/Shift+Tab odak sınırı ve çağırana odak dönüşü desteklenir. Açık/koyu tema ve yazı ölçeği ortak tasarım değişkenlerini izler.

## Durum, etkin tarihler ve alt gezinme satırı

Her iki kipte durum süzgeci Özetle aynı `getStatus` sonucunu kullanır: `done` → Tamamlandı; bitmemiş ve hedefi geçmiş → Geciken; gecikmemiş `in_progress` → Devam ediyor; gecikmemiş `todo` → Yapılacak. Çoklu seçim bu ayrık kümelerin birleşimidir. Tarihi bugün olan görev gecikmiş sayılmaz.

Kapsamlı Kip Görevler tablosunda **Başlangıç** = `actualStart || plannedStart`, **Bitiş** = `actualFinish || plannedFinish`. Sıralama ve tarih süzgeci hücreyle aynı etkin değeri kullanır; ham plan saklanmaya devam eder. Gerçekleşen tarihin yanında nötr renkli küçük ✓ vardır; erişilebilir açıklaması **Gerçekleşen başlangıç** veya **Gerçekleşen bitiş**tir. İşaret bir başarı veya görev tamamlanması iddiası taşımaz. Temel Kip sade sütunlarını ve Termin anlamını korur.

Tablonun altındaki tek satırda solda **✓ Gerçekleşen tarih · İşaretsiz tarih planlanandır**, sağda **İlk / Önceki / Sayfa n / N / Sonraki / Son** bulunur. İlk sayfada İlk/Önceki, son sayfada Sonraki/Son devre dışıdır. Temel Kip aynı gezinmeyi tarih açıklaması olmadan kullanır. Tek sayfada da konum anlaşılır kalır; dar ekranlarda satır gerektiğinde sarılır.

## Yazarken imleç ve taslak eşitleme

Görev başlığı, Notlar ve diğer alanlar iki kez kopyalanan yerel durum yerine üst görev düzenleyicisinin aynı taslağından doğrudan çizilir. Her tuştan sonra etkiyle eski kontrollü değeri geri yazma yoktur; ortada yazma, seçim değiştirme, silme ve Türkçe karakterler normal alan davranışını izler. Taslak halen yalnızca **Kaydet** ile kalıcılaşır. Dışarıdan gelen görev, dokunulmayan alanları yeniler; yerel yamalar korunur ve başladıkları sürümle kaydedilir. Gerçek dış sürüm çakışması reddedilir.


### Raporlar sekmeleri

Kapsamlı Kipte Raporlar tek gezinme öğesi olarak kalır: Performans mevcut raporları, Görev Hareketleri ise kimin hangi görünür görevde ne değiştirdiğini gösterir. Sekmelerin tarih filtreleri bağımsızdır. Hareket raporu Bugün ve uygun kullanıcıda Ekibim ile açılır; Türkiye saatini, sunucu süzgeçlerini ve sayfalamayı kullanır. [Ayrıntılar](TASK-ACTIVITY-REPORT.md).

**Filtreleri Temizle** görünürlüğü rapora özeldir. Özet kendi tarih/kurumsal filtrelerinden en az biri etkin olduğunda; Performans kendi rapor filtrelerinden biri varsayılandan saptığında düğmeyi gösterir. Görev Hareketleri (`TaskActivitiesView`) ise `INITIAL` sorgusundaki herhangi bir alan değiştiğinde — kişi, proje, tür veya dönem dahil — düğmeyi gösterir. Temizleme Özet/Performans tarafında ilgili tarih ve kurumsal seçimleri varsayılanlarına döndürür; Görev Hareketleri sekmesinde dönem Bugün’e, kapsam sunucunun yetkili varsayılanına, kişi/proje/tür filtreleri boş seçime ve sayfa ilk sayfaya döner. Çalışma alanı ve yetki kümesi korunur; ek onay sorulmaz. Outlook menüsü etkin abonelik ile gönderim/bekleme/hata durumlarını ayırır; ayrıntılı tek yönlü bağlantı açıklaması Yardım → Outlook’tadır.

## Görev yaşam döngüsü ve kaydırma

Durum, gerçekleşen tarihler ve ilerleme aynı işlemde tutarlı hâle gelir. Devam ediyor seçimi eksik gerçek başlangıcı; Tamamlandı seçimi eksik gerçek bitişi Rota takviminin bugünüyle doldurur. Tamamlanmada ilerleme %100 olur; başlangıç bilinmiyorsa bitiş günü kullanılır. Gerçek başlangıç Yapılacak görevini başlatır; gerçek bitiş tamamlar. Plan tarihleri gerçekleşen tarih olarak kullanılmaz. İlerleme %100 tek başına tamamlamaz; tamamlanmış görevde sürgü kapalıdır. Yeniden açma bitişi temizler, başlangıcı ve ilerlemeyi korur. Yapılacak durumuna dönüşte gerçek tarihler varsa kısa onay istenir; kabul edilince tarihler boşalır ve ilerleme %0 olur.

Özet'in Genel bakış/tarih/sayı başlığı kaldırılmıştır. Özet ve Raporlar → Performans tarih/kurum filtreleri ile Proje Yapısı sekmeleri içerik çalışma alanı içinde yapışkandır; ana gezinmenin üstüne çıkmaz. Filtreleri Temizle mevcut kapsamı korur. Görev Hareketleri'nde denetimler ve sayfalama yerinde kalır; kalan yükseklikte yalnız tablo kayar, sütun başlıkları sabittir. Talepler'in bütün sekmeleri ve tabloları ile Görev Hareketleri aynı nötr, hafif vurgu renkli açık/koyu tema yüzeylerini kullanır.
