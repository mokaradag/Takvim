# Profesyonel Zamanlama Veri Modeli

MERGEN Rota, saklanan zamanlama olgularını hesaplanan zamanlama sonuçlarından ayırır. Bu ayrım; gelecekteki SQL Server kalıcılığının, Primavera P6 bütünleşmesinin, ilerleme güncellemesinin, baz plan karşılaştırmasının ve denetim geçmişinin temelidir.

## Kavramsal model

```text
Project
├── dataDate
└── WBS hiyerarşisi
      └── Task / Activity
            │
            ├── Güncel Plan
            │     ├── plannedStart
            │     ├── plannedFinish
            │     └── plannedDurationDays
            │
            ├── Hedef
            │     └── targetFinish
            │
            ├── Gerçekleşenler
            │     ├── actualStart
            │     └── actualFinish
            │
            ├── İlerleme Planlaması
            │     └── remainingDurationDays
            │
            ├── Baz Plan Anlık Görüntüsü (ayrı varlık)
            │     ├── plannedStart
            │     ├── plannedFinish
            │     ├── plannedDurationDays
            │     └── calendarId
            │
            └── Hesaplanan CPM Zamanlaması (türetilmiş projeksiyon)
                  ├── earlyStart
                  ├── earlyFinish
                  ├── lateStart
                  ├── lateFinish
                  ├── totalFloatDays
                  └── freeFloatDays
```

Diyagramdaki baz plan dalı kavramsaldır: baz plan değerleri değiştirilebilir `Task` nesnesine gömülmez. Ayrı `Baseline` ve `TaskBaselineSnapshot` kayıtlarında saklanır. WBS de ayrı bir yapısal varlıktır; WBS özet zamanlama değerleri alt görevlerden türetilir, WBS düğümlerinde saklanmaz.

## 1. Güncel Plan

Güncel plan, uygulamanın o anda kullandığı düzenlenebilir zamanlamadır:

- `plannedStart`
- `plannedFinish`
- `plannedDurationDays`

`plannedStart` ve `plannedFinish`, düzenlenebilir güncel plan tarihlerinin kesin kaynağıdır. Ana Gantt aktivite çubukları ve güncel plan tarih sütunları bu alanları kullanır. Takvim bilinçli olarak termin görünümüdür: her görevi bir kez `targetFinish` tarihine yerleştirir; yalnızca hedef yoksa eski kayıtlarla uyumluluk için `plannedFinish` kullanılır.

`plannedDurationDays`, görevin geçerli zamanlama takvimine göre güncel planın iki uç dahil iş günü süresidir. Normalleştirme sınırı, görev her yüklendiğinde veya güncellendiğinde bunu `plannedStart` ve `plannedFinish` üzerinden yeniden hesaplar; böylece saklanan süre eskimez. Kilometre taşlarının plan süresi her zaman sıfırdır.

Güncel planın değişmesi gerçekleşen tarihleri değiştirmez ve hiçbir baz plan anlık görüntüsünü yeniden yazmaz.

## 2. Hedef Bitiş

`targetFinish`, yönetim hedefi veya son tarihtir. Mevcut gecikme mantığı bu alanı kullanır ve uygulamanın mevcut davranışına göre tamamlanmış görevleri dışarıda bırakır.

`targetFinish` bir CPM zamanlama kısıtı değildir. CPM motoru bunu Belirli Tarihte Bitmeli (Must Finish On), En Geç Şu Tarihte Bitmeli (Finish No Later Than) veya başka bir zamanlama kısıtı olarak yorumlamaz. Gelecekteki kısıt modeli bu kavramları açıkça temsil etmelidir.

### Tarih değişikliği talebi iş akışı

Başkasının görev planını yönetemeyen sorumlu, olağan görev yaması göndererek `plannedStart`, `plannedFinish` veya `targetFinish` değiştiremez. Ayrı ve kalıcı bir `MR_TaskScheduleChangeRequests` kaydı; üç tarihin özgün ve önerilen değerlerini, talep edenin iletisini, karar sahibi olarak yetkili oluşturucuyu, durumu, denetim kimliklerini/zamanlarını ve oluşturma sırasında kullanılan görev rowversion değerini saklar. Talep PENDING durumundayken görev değişmez.

Kabul işlemi, `READ_COMMITTED` yalıtım düzeyinde görev ve bekleyen talep satırlarını `UPDLOCK, HOLDLOCK` ile kilitleyerek kaydedilmiş özgün tarih üçlüsünü güncel görevle karşılaştırır. Uyumsuzluk STALE üretir ve daha yeni planı korur. Aksi durumda önerilen üçlü, takvimden türetilen `plannedDurationDays`, ACCEPTED durumu ve ilişkili denetim olayları atomik olarak kaydedilir. Ret işlemi kararı kaydeder ve güncel plana dokunmaz. Yerine geçen bir talep, aynı talep edenin bu görevdeki önceki PENDING satırını iptal eder.

## 3. Gerçekleşenler

Gözlenen yürütme tarihleri bağımsız temsil edilir:

- `actualStart`
- `actualFinish`

Geçerli durumlar şunlardır:

- iki tarihin de kaydedilmemesi;
- `actualFinish` olmadan `actualStart` kaydedilmesi;
- iki tarihin de kaydedilmesi.

`actualFinish` değerinin `actualStart` öncesinde olması geçersizdir. Kayıtlı başlangıç olmadan bitiş gönderilirse kalıcı saklamadan önce aynı gün tamamlama (`actualStart = actualFinish`) uygulanır.

Görev güncellemeleri istemcide ve SQL işlemli yazma yolunda ortak `normalizeTaskLifecycle` kuralından geçer. `in_progress` seçimi, eksik gerçekleşen başlangıcı geçerli görev takviminin bugünkü tarihiyle doldurur. `done` seçimi ilerlemeyi 100 yapar ve eksik bitişi aynı tarihle doldurur; kayıtlı başlangıç yoksa iki gerçekleşen tarih de tamamlanma gününü kullanır. Mevcut gerçekleşen tarihler korunur; plan tarihleri gerçekleşenlere hiçbir zaman kopyalanmaz.

Başlangıç girmek `todo` durumunu `in_progress` yapar; tamamlanmış görevde başlangıcı düzenlemek tamamlanmayı korur. Bitiş girmek görevi tamamlar ve ilerlemeyi 100 yapar. İlerleme tek başına, %100'de bile durumu değiştirmez; tamamlanmış görevler her zaman %100 kalır.

`in_progress` olarak yeniden açma, gerçekleşen başlangıcı ve ilerlemeyi (%100 dahil) korur, gerçekleşen bitişi temizler. Tarihsel gerçekleşen bilgi varken `todo` durumuna dönüş açık onay gerektirir (değişiklik zarfında `resetActualDates: true`); ardından iki gerçekleşen tarihi de temizler ve ilerlemeyi 0 yapar. Onay bayrağı görevde saklanmaz. Mevcut satır sürümü, denetim ve Outlook işlem kancaları son duruma uygulanır. Paralel geçmiş deposu veya şema geçişi eklenmez. Ortak iş tarihi biçimlendiricisi geçerli takvimin saat dilimini, yedek olarak Europe/Istanbul kullanır.

## 4. Kalan Süre

`remainingDurationDays`, null olabilen uyumluluk alanı olarak korunur. Mevcut zamanlama motoru bunu kullanmaz; görev düzenleyicisi bunu işletimsel planlama girdisi olarak sunmaz. Tamamlanma yüzdesinden türetilmez.

Uygulama şu tür bir formül uygulamaz:

```text
kalan süre = planlanan süre × (1 - ilerleme)
```

Yeni görevlerde ve üretilen tekrar oluşumlarında `remainingDurationDays`, `null` bırakılır. Mevcut kalıcı değerler uyumluluk için okunabilir kalır; veri kaybettiren bir geçiş gerekmez.

## 5. Proje Veri Tarihi

`Project.dataDate`, proje durum/kesim tarihidir: proje durumunun hangi tarihe kadar güncel kabul edildiğini belirtir.

Şunlardan farklıdır:

- tarayıcının bugünkü tarihi;
- `targetFinish`;
- baz plan oluşturma tarihi;
- güncel plan bitişi;
- CPM ile hesaplanan proje bitişi.

Ayrıca satır zaman damgası **değildir**. Oluşturma ve değiştirme zamanları ayrı denetim sütunlarındadır (`CreatedAt`, `UpdatedAt`, `MR_AuditLog`); `dataDate` ise bir proje kontrol sorusunu yanıtlar: bildirilen ilerleme ve gerçekleşenler hangi güne kadar geçerli kabul edilir? Raporlama ve gelecekteki ilerlemeye duyarlı yeniden zamanlama, durum değerlendirmesini bu tarihe göre yapar.

Bu karar çoğu zaman proje kaydından sonra verildiğinden `dataDate` **isteğe bağlıdır**. Proje oluşturma ve güncelleme boş değerle başarılı olur; arayüz alanın isteğe bağlı olduğunu ve kesim tarihi anlamını açıklar, sunucu yalnızca değer verildiğinde biçimi doğrular. Böylece veri tarihi olmadan aktarılan kurumsal projelerin MERGEN'e ait alanları (renk, etiket kataloğu, takvim), önce yapay bir kesim tarihi belirlenmeden düzenlenebilir.

Gelecekteki ilerlemeye duyarlı zamanlamanın doğru alan temeline sahip olması için bu alan şimdiden projede saklanır. Deneme projeleri bu alanı tarayıcı saatinden otomatik türetmek yerine açık ve sabit bir örnek veri tarihi kullanır. Mevcut CPM motoru saf güncel plan ağ hesabı olarak kalır; durum güncellemesi veya yeniden zamanlama için henüz `dataDate`, gerçekleşen tarihler veya kalan süreyi kullanmaz.

## 6. Proje, WBS ve Görev sahipliği

WBS, zamanlama anlamlarını değiştirmeden yapısal proje sahipliğini kurar:

```text
Project.id
  └── WbsNode.projectId
        └── Task.wbsId
```

Kanonik WBS düğümü `id`, `projectId`, `parentId`, `code`, `name` ve isteğe bağlı `sortOrder` saklar. Üst düğümü varsa aynı projeye ait olmalıdır. `Task.wbsId` varsa, `projectId` değeri görevin `projectId` değeriyle aynı olan bir WBS düğümüne başvurmalıdır.

Görevin projesi değiştiğinde normalleştirme eski projenin WBS'sini koruyamaz. Yeni projede tek ve belirsiz olmayan bir kök varsa onu kullanır; aksi durumda açık atama yapılması için `wbsId` null bırakılır.

WBS hiyerarşi derinliği, yolları, alt düğümleri, aktivite sayıları, ilerlemesi ve zamanlama aralıkları türetilir. WBS düğümleri güncel plan tarihlerini, CPM tarihlerini, bolluğu veya ilerleme özetlerini saklamaz.

## 7. Baz Plan

Baz plan, `Task` üzerinde başka bir değiştirilebilir alan çifti değil, değişmez tarihsel anlık görüntü verisidir.

`Baseline`, proje düzeyindeki anlık görüntü kümesini tanımlar:

- `id`
- `projectId`
- `name`
- `createdAt`
- `isPrimary`

`TaskBaselineSnapshot`, bir baz planda bir görev için yakalanan zamanlama durumunu saklar:

- `baselineId`
- `taskId`
- `plannedStart`
- `plannedFinish`
- `plannedDurationDays`
- `calendarId`

Deneme deposu, mevcut her proje için birincil baz plan ve başlangıç veri kümesindeki görevler için anlık görüntüler sağlar. Olağan görev CRUD işlemleri ve WBS düzenlemeleri bu kayıtları hiçbir zaman değiştirmez. Baz plan oluşturulduktan sonra açılan görev, tarihsel anlık görüntüye otomatik eklenmez.

Baz plan değerleri CPM sonucu değildir ve güncel plan değiştiğinde yeniden hesaplanmaz. Görevin güncel WBS'sini değiştirmek, WBS düğümünü yeniden adlandırmak veya güvenli boş bir WBS düğümü eklemek/kaldırmak tarihsel zamanlama anlık görüntülerini yeniden yazmaz. Tarihsel WBS yapısının sürümlenmesi bilinçli olarak mevcut modelin dışındadır.

## 8. Hesaplanan CPM Zamanlaması

CPM çıktısı, türetilmiş uygulama zamanlama durumu olarak kalır. `CpmTaskResult` şunları içerebilir:

- `earlyStart`
- `earlyFinish`
- `lateStart`
- `lateFinish`
- `totalFloatDays`
- `freeFloatDays`
- `isCritical`
- `durationDays`: ilgili CPM hesabında kullanılan iş günü süresi.

Bu değerler kanonik `Task` nesnelerine kopyalanmaz ve olağan görev alanları olarak kalıcı saklanmaz. Uygulama akışı şöyledir:

```text
Kanonik Görev Güncel Planı
          │
          ▼
     Saf CPM Motoru
          │
          ▼
Türetilmiş Zamanlama Projeksiyonu
```

Durum zamanlama projeksiyonu her projeyi bağımsız hesaplamayı sürdürür. Proje çalışma alanı, seçili projenin mevcut sonucunu kullanır; WBS başına CPM hesaplamaz. Proje kapsamlı CPM, projeler arası bağımlılık ilişkilerini açıkça desteklemez; bunlar belirlenimci proje düzeyi doğrulama uyarıları üretir.

## 9. WBS Gantt özetleri

Proje kipindeki WBS özet satırı bir görev değil, türetilmiş sunum verisidir. WBS alt ağacında zamanlanmış aktiviteler varsa güncel plan özet aralığı şöyledir:

```text
alt görevlerdeki en erken plannedStart
        →
alt görevlerdeki en geç plannedFinish
```

Aynı özetleme, alt aktivite sayısını, tamamlanma ilerlemesini ve kritik aktivite sayısını türetebilir. Bu değerler kanonik görevlerden ve mevcut CPM projeksiyonundan yeniden hesaplanır; `WbsNode` üzerinde hiçbir zaman kalıcı saklanmaz.

WBS özet çubuğu, CPM Erken/Geç zamanlama çıktısı olarak yorumlanmamalıdır. Güncel plan, WBS özeti ve CPM projeksiyonu ayrı kavramlar olarak kalır.

## 10. Saklanan ve türetilen veriler

| Kavram | Veri | Saklama anlamı |
| --- | --- | --- |
| Proje yapısı | WBS `id`, `projectId`, `parentId`, `code`, `name`, isteğe bağlı `sortOrder` | Saklanan, değiştirilebilir yapı |
| Görev WBS ataması | `Task.wbsId` | Saklanan, değiştirilebilir, aynı proje içi ilişki |
| Güncel plan | `plannedStart`, `plannedFinish`, `plannedDurationDays` | Saklanan, değiştirilebilir |
| Yönetim hedefi | `targetFinish` | Saklanan, değiştirilebilir |
| Tarih talebi | özgün/önerilen plan tarihleri, talep eden/sahip, durum, yakalanan görev sürümü, karar | Ayrı saklanır; kabul edilene kadar güncel görev planı sayılmaz |
| Gerçekleşenler | `actualStart`, `actualFinish` | Saklanır; yalnızca açık kullanıcı/veri işlemleriyle değiştirilebilir |
| Kalan süre | `remainingDurationDays` | Null olabilen uyumluluk alanı; mevcut zamanlamada düzenlenmez veya kullanılmaz |
| Proje durum kesim tarihi | `dataDate` | Projede saklanır, değiştirilebilir, isteğe bağlı |
| Baz plan | `Baseline`, `TaskBaselineSnapshot` | Olağan görev/WBS CRUD işlemlerinde değişmez olarak saklanan anlık görüntü verisi |
| WBS zamanlama özeti | alt görev tarih aralığı, ilerleme ve sayılar | Türetilir, WBS'ye yazılmaz |
| CPM zamanlaması | erken/geç tarihler, bolluk, kritiklik | Türetilir, yeniden hesaplanır, göreve geri yazılmaz |

## 11. İş günü sürelerinin anlamı

Aksi açıkça belirtilmedikçe bütün zamanlama süreleri iş günü cinsindendir.

- `plannedDurationDays`, görevin geçerli takvimiyle güncel plan tarih aralığından normalleştirilir.
- `remainingDurationDays`, uyumluluk için null olabilir; plan süresinden üretilmez.
- CPM sonucundaki `durationDays`, ilgili hesapta kullanılan süredir ve kanonik güncel plan girdisinden türetilir.
- Bağımlılık `lagDays` ve öne alma değerleri iş günü kullanmayı sürdürür.

Kanonik plan süresi hesabında sıradan takvim günü çıkarımı kullanılmamalıdır.

## 12. Eski tarih alanlarının dönüşümü

Eski görev girdisi yalnızca özel veri dönüşüm sınırında kabul edilir:

```text
baslangicTarihi -> plannedStart
bitisTarihi     -> plannedFinish
hedefTarih      -> targetFinish
```

Dönüşümden sonra eski özellikler normalleştirilmiş görevden silinir. Uygulama durumu, zamanlama kodu ve özellik bileşenleri yalnızca kanonik alanları kullanır. Uygulama, eski ve kanonik tarih kaynaklarını birbirinin kopyası olarak sürdürmez.

## 13. Doğrulama sözleşmesi

Alan doğrulama katmanı, kullanıcı niyetini sessizce yeniden yazmadan anlamlı zamanlama ve hiyerarşi tutarsızlıklarını bildirir. Önemli denetimler şunlardır:

- planlanan bitişin planlanan başlangıçtan önce olması;
- gerçekleşen başlangıç olmadan gerçekleşen bitiş;
- gerçekleşen bitişin gerçekleşen başlangıçtan önce olması;
- geçersiz veya negatif süreler;
- kilometre taşı plan süresinin sıfır olmaması;
- baz plan bitişinin baz plan başlangıcından önce olması;
- yinelenen WBS kimlikleri;
- eksik WBS üst düğümü;
- kendi üst düğümü olan WBS düğümleri;
- başka projeye ait WBS üst düğümleri;
- WBS döngüleri;
- görev ile WBS arasında proje uyumsuzluğu.

Normalleştirme; yapısal varsayılanları, aynı projede görev/WBS tutarlılığını ve takvime göre normalleştirilmiş plan süresini kurar. Doğrulama ise açıkça gösterilmesi veya ele alınması gereken anlamsal tutarsızlıkları bildirir.

## 14. Mevcut sınırlamalar

Bu model bilinçli olarak henüz şunları uygulamaz:

- ilerlemeyi dikkate alan CPM;
- veri tarihine dayalı yeniden zamanlama;
- gerçekleşen tarihlere dayalı zamanlama;
- biçimsel zamanlama kısıtları;
- baz plan yakalama veya yeniden baz plan oluşturma iş akışları;
- baz plan sürüm karşılaştırması;
- tarihsel WBS sürümleme;
- WBS sürükle-bırak/üst düğüm değiştirme geçmişi;
- projeler arası CPM ağları;
- kaynak dengeleme;
- kazanılmış değer yönetimi;
- projeler arası tarih talebi yetki devri kuralları.

Bu yetenekler artık çekirdek görev zamanlama modelini yeniden tanımlamadan; ayrı Proje/WBS/Aktivite ilişkileri ve birbirinden ayrılmış güncel plan, hedef, gerçekleşen, kalan süre, baz plan, veri tarihi, WBS özeti ve hesaplanan zamanlama anlamları üzerine kurulabilir.

## Kilometre taşı gerçekleşmesi

Kilometre taşı tek bir olaydır: **Gerçekleşen tarih** alanı iki eski SQL sütununa (`ActualStart`, `ActualFinish`) aynı değerle yazılır. Ayrı gerçekleşen başlangıç/bitiş veya ilerleme sürgüsü gösterilmez. Durumu **Yapılacak / Tamamlandı**, ilerlemesi **0 / 100** olur. Tamamlandı seçimi gerçekleşen tarihi damgalar; yeniden açma veya gerçekleşen tarihi temizleme, mevcut gerçekleşen bilgi varsa açık onaydan sonra iki sütunu birlikte boşaltır. Girilen gerçekleşen tarih değiştirildiğinde iki sütun birlikte güncellenir. Temel Kip ve salt okunur panel de ikili durumu kullanır.

Ortak `milestoneCompletion` kuralı istemci durum güncellemelerinde, kayıt normalleştirmesinde ve SQL yazma sınırında uygulanır. Eski kayıtlar ayrıca topluca dönüştürülmez; okunurken normalleştirilir, sonraki yetkili yazmada kalıcılaştırılır. Normal görevler de ortak yaşam döngüsü kuralını kullanır; kilometre taşının tek gün ve 0/100 davranışı korunur. SQL şeması yükseltmesi gerekmez.

Hızlı durum değişiklikleri tek kayıtta birleştirilirken kullanıcının onayladığı gerçekleşen tarih sıfırlama niyeti korunur. Onay işareti kalıcı görev modeline yazılmaz.

## Tarih önerilerinde eşzamanlı kayıt

Talep oluşturma ve karar işlemleri `READ_COMMITTED` kullanır; görev ve bekleyen talep satırlarında mevcut `UPDLOCK, HOLDLOCK` koruması sürer. Yetki sorgularındaki geniş okuma kilitleri işlem sonuna kadar tutulmaz. SQL Server 1205 deadlock kurbanı hatasında yalnızca geri alınmış işlemin tamamı yeni veritabanı işlemi ile en fazla iki kez yeniden denenir. Her denemede yetki ve güncel görev yeniden okunur; zaman aşımı veya belirsiz bağlantı hatası otomatik yinelenmez. Denemeler tükenirse kullanıcıya yeniden denemesi için açık bir hata mesajı verilir. Diğer işlem türlerinin izolasyonu veya tekrar politikası değişmez.


## Görevler tablosunda gerçekleşen tarih gösterimi

Başlangıç ve Bitiş sütunları sırasıyla `actualStart || plannedStart` ve `actualFinish || plannedFinish` gösterir; süzme ve sıralama da aynı değeri kullanır. Bu görünüm planı veya CPM hesabını değiştirmez. Nötr ✓ ve alanın erişilebilir açıklaması gerçekleşen tarihi belirtir; açıklama alt sayfalama satırındadır. Temel Kip Termin alanı değişmez. Tarih talebi geçmişi ve bildirim durumu için [ayrı veri modeli](TALEPLER-VE-BILDIRIMLER.md) kullanılır.
