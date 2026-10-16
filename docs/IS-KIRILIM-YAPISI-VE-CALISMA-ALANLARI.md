# İş Kırılım Yapısı ve Çalışma Alanları

MERGEN Rota; Proje, WBS ve Görev varlıklarını ayrı alan varlıkları olarak tutarken portföy gezinmesini proje yürütmesinden ayırır.

```text
Portföy
│
├── Proje A
│     │
│     ├── WBS A.1
│     │     ├── WBS A.1.1
│     │     │     ├── Aktivite
│     │     │     └── Aktivite
│     │     └── Aktivite
│     │
│     └── WBS A.2
│           └── Aktivite
│
└── Proje B
      └── ...
```

## 1. Portföy Çalışma Alanı

Portföy çalışma alanı bütün projelerin bağlamıdır. Etkin `selectedProjectId` içermez ve uygulamanın genel davranışını korur:

- Özet bütün görevleri kullanır;
- Görevler, Takvim ve Kanban bütün projeleri kullanır;
- mevcut portföy odaklı Gantt kullanılabilir kalır;
- Raporlar portföy veri kümesini kullanır;
- Ekip bütün kişileri sunar.

Portföy yapay bir proje değildir. Proje koleksiyonu üzerinde uygulama gezinme bağlamıdır.

## 2. Proje Çalışma Alanı

Proje çalışma alanı, kararlı `projectId` ile bir projeyi etkinleştirir. Ortak özellik kancaları daha sonra yalnızca seçili projenin ilgili görevlerini, WBS düğümlerini ve katılımcı kişilerini sunar. Ayarlar genel kalır.

Proje kipi ayrıca kabukta kısa proje kontrol bilgisi sunar: Proje adı, Veri Tarihi, Proje Takvimi ve varsa mevcut türetilmiş CPM bitişi.

CPM, WBS başına yeniden hesaplanmaz. Seçili proje, Portföy kipinin de kullandığı aynı proje kapsamlı CPM projeksiyonunu kullanır.

## 3. Çalışma alanı seçiminin anlamı

Durum sözleşmesi kavramsal olarak şöyledir:

```text
workspaceMode: "portfolio" | "project"
selectedProjectId: null | Project.id
```

Proje her zaman kararlı kimlikle seçilir; görüntüleme adıyla seçilmez. Saklanan geçersiz veya silinmiş proje kimliği güvenle Portföy çalışma alanına normalleştirilir.

Son seçim, yerel arayüz tercihi anahtarı `mergen-rota.workspace.v1` altında saklanır. Bu localStorage değeri yalnızca çalışma alanı tercihidir; proje verisi veya uygulama kalıcılığı değildir. Dolayısıyla depo yüklemesi bu tercihten bağımsızdır; tercih ancak proje verisi hazır olup doğrulanabildiğinde geri yüklenir.

Proje değiştirildiğinde seçili görev başka projeye aitse temizlenir. Kabuk, yeni çalışma alanı için özellik yerel görünüm durumunu da yeniden kurar; eski projeye ait tablo süzgeçleri alan değişiminden sonra kalmaz. Görevler kurumsal seçimi, Temel/Kapsamlı kip değişimlerinde ve anlık görüntü yenilemelerinde korunabilmesi için bilinçli olarak kabuğa aittir. Çalışma alanı değişince yalnızca yeni alanın projekte edilen görev sorumlularına göre doğrulanır ve geçersiz alt yol budanır.

Depo yeniden yüklemesi aynı uzlaştırma kurallarını kullanır: seçili proje yoksa Portföy kipine dönülür; artık var olmayan veya etkin projeye ait olmayan seçili görev temizlenir.

## 4. WBS alan modeli

Kanonik WBS düğümü şunları içerir:

```text
id
projectId
parentId
code
name
sortOrder?         // isteğe bağlı, belirlenimci kardeş sırası ipucu
source             // "manual" | "corporate"
sourceKey?         // kurumsal WBS öğe kodu (CN43N "WBS element")
outlineCode?       // kurumsal hiyerarşik kod (CN43N "PYP kodu", ör. 1.3.2.5)
level?             // kurumsal hiyerarşi düzeyi (CN43N "Level")
statusCode?        // kurumsal öğe durumu (CN43N "Status")
elementTypeCode?   // kurumsal öğe türü (CN43N "Proj.type")
```

`id` kararlı ilişki anahtarıdır. `projectId`, düğümün ait olduğu projeyi belirler. `parentId` aynı projede başka bir WBS düğümüne başvurur veya kök için `null` olur.

`sortOrder` isteğe bağlıdır. Görüntüleme sırası yedek olarak WBS kodu, adı ve kararlı kimliğe göre belirlenimci biçimde oluşturulur.

WBS düğümleri yapısal varlıklardır. Görev değildir ve zamanlama özetlerini kalıcı saklamaz.

`source`, yapının sahibini kaydeder. `manual` düğümleri MERGEN Rota'da oluşturulur. `corporate` düğümleri kurumsal CN43N kaynağından yansıtılır ve uygulamada salt okunurdur; diğer kurumsal alanlar görüntülemede kullanılan kaynak niteliklerini taşır.

## 4.1 Kurumsal WBS kaynağı (CN43N)

Kurumsal projelerin uygulamada oluşturulmuş WBS'si yoktur. Yapıları, `MERGEN_Rota` ile **farklı veritabanındaki** kurumsal `CN43N` tablosundan beslenir; bu nedenle `.env.example` içinde kendi bağlantı bloğu vardır (`MERGEN_ROTA_WBS_DB_*`). `MERGEN_ROTA_WBS_DB_SERVER` / `..._DATABASE` boş bırakılırsa eşitleme kapanır; kurumsal projeler yalnızca kök düğümünü gösterir.

Kaynak sütunlar ve eşlemeleri:

| CN43N sütunu | Anlamı | MERGEN Rota hedefi |
| --- | --- | --- |
| `Proje tanımı` | proje kodu (`projeKodu` ile aynı değer) | `MR_Projects.ProjectCode` birleştirme anahtarı |
| `WBS element` | kurumsal WBS öğe kodu | `MR_WBS.SourceKey` ve `MR_WBS.Code` |
| `Name` | öğe adı | `MR_WBS.Name` |
| `Level` | hiyerarşi düzeyi (1, doğrudan projenin altıdır) | `MR_WBS.WbsLevel` |
| `Kontrol kodu` | kullanılmaz | — |
| `Planlanan bşl.tarihi` | kullanılmaz | — |
| `Planlanan bitiş trm.` | kullanılmaz | — |
| `Status` | öğe durumu | `MR_WBS.StatusCode` |
| `PYP kodu` | düzeyleri noktayla ayrılmış hiyerarşik kod | `MR_WBS.OutlineCode` |
| `Proj.type` | öğe türü (iki büyük harf) | `MR_WBS.ElementTypeCode` |

Eşitleme kuralları:

1. Tek kök değişmezi ve mevcut görev başvuruları korunsun diye projenin kökü MERGEN Rota tarafından üretilmiş kalır (`SourceKey`, `NULL`; `Code`, proje kodudur). CN43N düzey-1 öğeleri bu köke bağlanır.
2. Üst düğümler `PYP kodu` değerinin son bölümünü kaldırarak çözümlenir. Üst düğümü çözülemeyen öğeler (eksik, bozuk veya döngülü kodlar) atılmak yerine proje köküne bağlanır.
3. Kaynak, projenin kendisini WBS öğesi olarak listelerse o satır düğüm olarak eklenmez; çocukları yedek olarak proje köküne bağlanır.
4. Yeni öğeler eklenir, değişenler güncellenir; kaynaktan kaybolanlar **yalnızca** hiçbir alt düğüm ve görev onlara başvurmuyorsa silinir. Dolayısıyla görev taşıyan kurumsal düğüm sessizce kaldırılmaz.
5. Eşitleme, anlık görüntü yüklemesinde proje koduna göre toplu çalışır. Kaynak veritabanına ulaşılamasa da anlık görüntü yüklenir: hata günlüğe yazılır ve kurumsal WBS olduğu gibi bırakılır; ikinci veritabanı kesintisi uygulamayı durdurmamalıdır.

### 4.1.1 Eşitleme maliyeti ve atlama kuralları

CN43N, kaynak bağlantısında her `MERGEN_ROTA_WBS_SYNC_PROJECT_BATCH` proje kodu için tek sorguyla okunur (varsayılan 50); birleştirme yalnızca yazılması gereken her proje için tek deyimdir. 38 000 satırlı kurulumda önceki koşulsuz sürüm kurumsal ağacın tamamını *her* anlık görüntü isteğinde yeniden yazıyor ve tek uygulama açılışı 30 saniyeyi aşıyordu. Artık üç katman bu maliyeti sınırlar:

1. **Parmak iziyle atlama.** `corporateWbsSyncState.js`, her projenin planlanan düğüm kümesinin özetini alır (sıralı `sourceKey/name/level/outlineCode/statusCode/elementTypeCode/parentSourceKey/sortOrder` demetleri üzerinden SHA-256). Özet ve düğüm sayısı `MR_CorporateWbsSyncState` içinde saklanır. Yeni planlanan özet, saklanan düğüm sayısı **ve** `MR_WBS` içinde gerçekten bulunan kurumsal düğüm sayısı uyuşursa birleştirme deyimi hiç gönderilmez. Saklanan sayı denetimi, atlamanın kendini onarmasını sağlar: `MR_WBS` uygulama dışında temizlenirse yalnızca parmak izi yanlışlıkla ağacın güncel olduğunu ileri sürerdi.
2. **Güncellik penceresi.** `corporateWbsSyncSchedule.js`, son başarılı katalog yenilemesinin süreç düzeyinde zaman damgasını tutar. `MERGEN_ROTA_WBS_SYNC_TTL_MS` içinde (varsayılan 5 dakika; `0` pencereyi kapatır) kaynak veritabanı hiç sorgulanmaz; eşzamanlı istekler birikmek yerine sürmekte olan tek yenilemeyi paylaşır. Pencere yalnızca WBS eşitlemesi gerçekten başarılıysa *veya* CN43N kaynağı hiç yapılandırılmamışsa ilerler. Ulaşılamayan kaynak pencereyi değiştirmez; tüm TTL boyunca bastırılmak yerine hemen sonraki istekte yeniden denenir.
3. **Yalıtım ayrımı.** Yenileme, serializable anlık görüntü okuma işleminin (`projectedSqlAppRepository`) *dışında* çalışır. Önceden birleştirme, kapsayan okumadan `SERIALIZABLE` devralıyor ve tüm `MR_WBS` tablosunda aralık kilitleri biriktiriyordu. Artık her proje birleştirmesi parmak izi yazımıyla birlikte kısa bir `READ COMMITTED` işlemi kullanır.

Dolayısıyla kararlı durumda bir yetkilendirme okuması, bir kurumsal proje eşitlemesi, bir parmak izi okuması, her grup için bir CN43N okuması ve sıfır birleştirme vardır; güncellik penceresinde ise hiçbir kurumsal iş yapılmaz.

Gerçek Sistem'in görünür sekmede varsayılan 60 saniyelik otomatik veri yenilemesi bu kuralları atlamaz. Her tur mevcut anlık görüntü yaşam döngüsünü kullanır; katalog işi anlık görüntü okumasının arkasında kalır ve ancak bağımsız `MERGEN_ROTA_WBS_SYNC_TTL_MS`/tek-uçuş/parmak izi denetimleri izin verirse CN43N kaynağına gider. İstemci ayrı bir kurumsal WBS eşitlemesi çağırmaz.

`test/corporate-wbs-snapshot-performance-e2e.test.mjs`, gerçek zincirin gönderdiği SQL deyimlerini sayarak bunu uçtan uca kapsar.

Kurumsal WBS yapısı uçtan uca salt okunurdur: `resolveWbsMutationAccess`, Gerçek Sistem kipinde arayüz eylemlerini engeller; `commitWbs` / `deleteWbs` de sunucuda değişikliği bağımsız olarak reddeder. Kurumsal WBS düğümlerine görev atamak ve aralarında görev taşımak serbest kalır; görev-WBS bağı kurumsal yapı değil, MERGEN Rota verisidir. Demo kipinde kurumsal kaynak olmadığından örnek projelerin ağacı düzenlenebilir kalır.

## 4.2 İş Dağılım Ağacı sayfa yerleşimi

Bu sayfada kısıtlı kaynak dikey alandır ve sayfanın amacı ağaç tablosudur. Bu nedenle yerleşim şöyledir:

- proje etiketi, kaynak rozeti (`CN43N kaynaklı` / `Proje düzeyinde yönetilir`), düğüm/aktivite/görünür satır ölçüleri ve ağaç denetimlerini taşıyan tek ince araç çubuğu;
- tam kartlar yerine tek satırlı notlar halinde bildirimler (kurumsal salt okunurluk, salt okunur görünürlük, doğrulama sorunları, kayıt hataları);
- varsayılan kapalı `Görev taşı` anahtarının arkasında görev taşıma iş akışı;
- kalan yüksekliği kendi kaydırma kapsayıcısıyla dolduran ağaç tablosu; satırlar kayarken başlık ve üstündeki her şey görünür kalır.

Hiyerarşinin ne kadarının gösterileceğini üç denetim belirler:

| Denetim | Etkisi |
| --- | --- |
| `Tümünü aç` | bütün düğümleri genişletir |
| `Tümünü kapat` | yalnızca kökler kalacak şekilde kapatır |
| `Hiyerarşi` | seçilen düzeye kadar genişletir (1–5 veya tümü) |

Varsayılan `DEFAULT_WBS_DEPTH` değeridir (2: kökler ve çocukları). Önceki davranış olan bütün ağacı varsayılan açmak kurumsal projelerde uygulanabilir değildir; ilk çizimde on binlerce satırı zorluyordu. `src/features/wbs/wbsTreeViewPolicy.js` içindeki `expandedIdsForDepth`, üç denetimin de arkasındaki saf işlevdir; genişletme kümesine yalnızca gerçekten çocukları olan düğümler girer.

Satır özetleri, her düğümün toplamını tek ters DFS geçişinde hesaplayan `selectWbsRollupIndex` üzerinden gelir. Düğüm başına `selectWbsTaskRollup` tekil aramalar için kullanılabilir kalır; ancak çizilen her satır için çağrılması düğüm sayısına göre karesel maliyet oluşturuyordu.

## 5. WBS hiyerarşi kuralları

Alan doğrulama katmanı şunları saptar:

- `DUPLICATE_WBS_ID`;
- `MISSING_WBS_PARENT`;
- `WBS_SELF_PARENT`;
- `CROSS_PROJECT_WBS_PARENT`;
- `WBS_CYCLE`.

Hiyerarşi yardımcıları döngülere karşı güvenlidir ve her derinliği destekler. Bozuk yapılar incelenebilir kalır; sonsuz özyinelemeye girmez.

Ortak alan seçici katmanı; ağaç kurma, düzleştirme, üst/alt düğümler, yollar, görev seçimi ve WBS özetlerinden sorumludur. Özellik bileşenleri ayrı hiyerarşi algoritmaları uygulamaz.

## 6. Görev-WBS ilişkisi

`Task.wbsId`, ya `null` ya da aynı `Task.projectId` projesine ait kararlı WBS kimliğidir.

Normalleştirme şu kuralı uygular:

1. istenen WBS'yi yalnızca görevin projesine aitse korur;
2. aksi durumda tam bir tane belirsiz olmayan kök varsa projenin kök WBS'sini kullanır;
3. aksi durumda açık atama için `wbsId` değerini `null` yapar.

Dolayısıyla görev proje değiştirdiğinde eski projeye ait WBS yanlışlıkla kalamaz.

## 7. Proje sahipliği kuralları

Kanonik ilişki zinciri şöyledir:

```text
Project
  └── WBS hiyerarşisi
        └── Task / Activity
```

WBS üst düğümü aynı projeye ait olmalıdır. Görev ve WBS'si aynı projeye ait olmalıdır. WBS ve proje adları ilişki anahtarı değil, görüntüleme değeridir.

Sahiplik karşılaştırmaları kanonik Gerçek Sistem kimliklerini (`src/domain/identity/actualId.js`) kullanır. SQL Server `uniqueidentifier` değerlerini büyük harfli metin olarak döndürürken istemci küçük harf gönderdiğinden ham dize karşılaştırması, geçerli yazmaları “Üst WBS aynı projede bulunmalıdır” veya “Görev WBS kaydı aynı projede olmalıdır” ile reddediyordu. Artık her katman karşılaştırmadan önce kanonikleştirir.

Mevcut deneme verisi, CPM sınırını doğrulamak için bilinçli tutulan projeler arası bağımlılığı korurken her mevcut görevi aynı projede anlamlı bir WBS düğümüne atar.

## 8. WBS seçicileri ve türetilmiş hiyerarşi

Ortak saf yardımcılar şu yeteneklerin karşılıklarını içerir:

- `buildWbsTree()`;
- `flattenWbsTree()`;
- `selectProjectWbs()`;
- `selectWbsDescendantIds()`;
- `selectWbsPath()` / `formatWbsPath()`;
- `selectTasksForWbs()`;
- `selectWbsTaskRollup()`.

WBS özelliği, Görev Ayrıntısı ve Proje kipi Gantt, bağımsız ağaç uygulamaları sürdürmek yerine bu ortak kuralları kullanır.

## 9. WBS Gantt özetleri

Proje kipi Gantt varsayılan olarak WBS hiyerarşisini kullanır:

```text
WBS özet satırı
  alt WBS özet satırı
    Aktivite satırı
    Kilometre taşı satırı
```

WBS satırları kanonik görevler değil, türetilmiş görünüm satırlarıdır. Özet çubuğu yalnızca alt aktivitelerde güncel plan tarihleri varsa bulunur ve şu aralığı kapsar:

```text
alt görevlerdeki en erken plannedStart
        →
alt görevlerdeki en geç plannedFinish
```

Özetleme ayrıca aktivite sayısı, ilerleme ve kritik aktivite sayısını türetir. Bu değerler görevlerden ve mevcut zamanlama projeksiyonundan yeniden hesaplanır.

## 10. Saklanan ve türetilen WBS verileri

Saklanan WBS verileri:

- kararlı kimlik;
- ait olduğu proje kimliği;
- üst düğüm kimliği;
- kod;
- ad;
- isteğe bağlı kardeş sırası.

Türetilen WBS verileri:

- ağaç derinliği ve görüntüleme yolu;
- alt düğümler;
- doğrudan ve alt ağaç görev sayıları;
- güncel plan tarih aralığı;
- ilerleme özeti;
- kritik görev sayısı;
- Gantt özet satırları ve çubukları.

Türetilmiş değerler WBS kayıtlarına geri yazılmaz veya depo üzerinden kalıcı saklanmaz.

## 11. CPM ile etkileşim

CPM her proje için bağımsız tek ağ hesabı olarak kalır. WBS yapısal ayrıştırmadır ve CPM ağ sınırlarını tanımlamaz.

Uygulama, portföy zamanlama projeksiyonunu durum sınırında bir kez hesaplamayı sürdürür. Proje çalışma alanı seçili projenin mevcut sonucunu okur. WBS ve Gantt bileşenleri `calculateCpm()` çağırmaz.

Şunlar için mevcut davranış korunur:

- kritik görevler ve yollar;
- bolluk değerleri;
- hesaplanan proje bitişi;
- doğrulama uyarıları;
- belirlenimci `CROSS_PROJECT_DEPENDENCY` reddi.

WBS düğümleri arasında görev taşıma ve WBS hiyerarşisinde üst düğüm değiştirme yalnızca yapısal sınıflandırmayı değiştirir. Görev tarihlerini, süreleri, bağımlılıkları veya takvimleri değiştirmez; dolayısıyla tek başına CPM çıktısını etkilemez. CPM çıktısı türetilmiş kalır ve WBS kalıcılık değişiklik kümelerine hiçbir zaman girmez.

## 12. Baz planlarla etkileşim

Baz plan zamanlama anlık görüntüleri, olağan görev ve WBS işlemlerinde ayrı, değişmez tarihsel varlıklar olarak kalır.

Görevin WBS'sini değiştirmek, WBS düğümleri arasında birden çok görev taşımak, WBS alt ağacının üst düğümünü değiştirmek, WBS düğümünü yeniden adlandırmak, eklemek veya boş düğümü silmek `Baseline` ya da `TaskBaselineSnapshot` kayıtlarını değiştirmez.

Tarihsel WBS yapı sürümlemesi uygulanmamıştır. Bu nedenle baz plan zamanlama anlık görüntüsü baz plan anında yakalanan zamanlama olgularını, güncel WBS ise güncel proje yapısını anlatır.

## 13. Kontrollü taşıma iş akışları

### Görev taşıma

WBS özelliği proje kapsamlı taşıma çalışma alanı sunar. Önce kaynak WBS seçilir; sonra doğrudan ona atanmış bir veya birden çok görev seçilip aynı projede başka WBS'ye taşınabilir.

Durum/alan sınırı, kalıcı kayıttan önce bütün seçimi doğrular:

- hedef WBS var olmalıdır;
- seçilen her görev var olmalıdır;
- seçilen her görev hedef WBS'nin projesine ait olmalıdır;
- herhangi bir görev doğrulanamazsa depo değişikliği denenmez.

Başarılı taşımada yalnızca `Task.wbsId` değişir. Zamanlama alanları, bağımlılıklar, atamalar, proje sahipliği ve baz plan anlık görüntüleri değişmez.

Tek görev taşıma, bir kanonik görev güncellemesi saklar. Toplu taşıma, değişen her görev atamasını tek `commitChanges()` çağrısıyla saklar; bu, gelecekteki API/SQL uygulamasının açık atomik işlem sınırıdır. Mevcut asenkron bellek bağdaştırıcısı da değişiklik kümesini ya tamamen uygular ya hiç uygulamaz.

### WBS üst düğümünü değiştirme

Kök olmayan WBS düğümü aynı projede başka geçerli bir WBS düğümünün altına taşınabilir. Şu durumlarda işlem reddedilir:

- kaynak veya hedef yoksa;
- kaynak proje köküyse;
- kaynak kendisinin altına taşınıyorsa;
- hedef başka projeye aitse;
- hedef zaten kaynağın alt düğümüyse ve döngü oluşacaksa.

Başarılı üst düğüm değişikliği bütün kararlı WBS kimliklerini korur. Taşınan düğüm yeni üst düğüm altında sıradaki belirlenimci çocuk kodunu alır; alt düğümlerin görüntüleme kodları yeni öneke uyarlanır. Mevcut görev atamaları aynı kararlı WBS kimliklerine başvurmayı sürdürür; böylece görev kayıtları yeniden yazılmadan yapısal olarak alt ağaçla taşınır.

Üst düğüm/kod öneki değişiminden etkilenen bütün WBS düğümleri tek atomik depo değişiklik kümesinde saklanır. Dolayısıyla kalıcı kayıt hatası, kısmen yeniden kodlanmış alt ağaç göstermek yerine hem kanonik uygulama durumunu hem depo hiyerarşisini değiştirmeden bırakır.

İş geçerliliği alan/durum sınırında uygulanır. Depo, WBS iş kurallarından değil, kalıcılıktan ve atomik kayıt anlamından sorumludur.

### Sürükle-bırak ile hiyerarşi düzenleme

Üst düğüm değiştirme doğrudan ağaç satırlarında da kullanılabilir. `src/features/wbs/wbsDragPolicy.js`, görünümden bağımsız saf bırakma ilkesinden sorumludur; bırakmayı somut taşıma isteğine veya açık ret gerekçesine çözümler.

Hedef satır içindeki işaretçinin dikey konumuna göre üç bırakma konumu vardır:

| Konum | İşaretçi bölgesi | Sonuç |
| -------- | ------------ | ------ |
| `before` | üst %28 | düğüm hedefin önceki kardeşi olur |
| `inside` | orta | düğüm hedefin son çocuğu olur |
| `after` | alt %28 | düğüm hedefin sonraki kardeşi olur |

`inside` yalnızca **üst düğüm** değişikliğidir. Düğümü zaten ait olduğu üst düğümün ortasına bırakmak, sessizce kardeş listesinin sonuna taşımak yerine `WBS_DROP_NO_CHANGE` ile reddedilir; kardeş sırasını yalnızca `before`/`after` yönetir.

Retler kararlı kod ve kullanıcıya yönelik Türkçe gerekçe taşır: `WBS_NODE_NOT_FOUND`, `WBS_TARGET_NOT_FOUND`, `WBS_DROP_ON_SELF`, `WBS_ROOT_REPARENT_FORBIDDEN`, `WBS_ROOT_SIBLING_FORBIDDEN`, `CROSS_PROJECT_WBS_PARENT`, `WBS_REPARENT_TO_DESCENDANT`, `WBS_DROP_NO_CHANGE`. Bırakma reddedilecekse satır vurgusu kırmızı olur; kural işaretçi bırakılmadan görülür.

Çözümlenen taşıma, mevcut üst düğüm değiştirme anlamını kardeş sırasıyla birleştiren `wbs/move` durum eylemiyle uygulanır:

1. üst düğüm değişince mevcut kurallar aynen çalışır (kodun yeniden türetilmesi ve alt düğüm kodlarının yeni öneke uyarlanması);
2. düğüm kardeşleri arasında istenen sıraya yerleştirilir ve `sortOrder` yeniden numaralanır.

Sıralama bilinçli olarak WBS kodlarını yeniden **yazmaz**. Ağaç önce `sortOrder` ile sıralandığından görüntüleme sırası doğru kalır; tek sürükleme yüzlerce kaydı güncellemek zorunda kalmaz. Yalnızca `sortOrder` değeri gerçekten değişen kardeşler yeni nesne olur; kalıcı kayıt değişiklik kümesi küçük, iyimser eşzamanlılık çakışmaları seyrek kalır.

Kurumsal (CN43N kaynaklı) ve salt okunur projelerde sürükle-bırak kapalıdır; proje kökleri hiçbir zaman sürüklenemez. Sürükleme **yalnızca tutamaçtan** başlar: satırda satır içi ad girdisi ve eylem düğmeleri de vardır; tüm satırın sürükleme kaynağı olması metin seçerken hiyerarşi değişikliği başlatabilirdi.

Taşıma kötümser kayıt yaklaşımıyla saklanır; yanıt gelene kadar görünür ağaç bir kayıt geridedir. Bu nedenle taşıma sürerken yeni sürüklemeler kapalıdır; aksi durumda ikinci bırakma eski ağaçtan mutlak kardeş sırası hesaplayıp yeni ağaca uygulardı. `inside` bırakma kabul edilince sürükleme bitmeden hedef genişletilir; taşınan düğüm kapalı (veya önceden çocuksuz) üst düğümün altında kaybolmak yerine görünür kalır.

`dragover` her işaretçi hareketinde tetiklenir; sürükleme oturumu erişim dizinini bir kez kurar (`createWbsDropIndex`) ve her çözümlemede kullanır. Bırakma ipucu yalnızca gerçekten değiştiğinde yazılır. Her olayda üst/alt düğüm dizinini yeniden kurmak yaklaşık 38 bin düğümlü kurumsal ağaçlarda işaretçinin takılmasına yol açıyordu.

Kardeş sırası yalnızca sürüklemeyle yönetilmez: her satır **Taşı** yanında **yukarı taşı / aşağı taşı** eylemleri içerir; klavye kullanıcısı da sıralamayı yapabilir. Seçici tabanlı **Taşı**, üst düğüm değiştirme için klavye yolu olarak kalır.

### Sayfa içinde düğüm düzenleme

Çocuk ekleme, yeniden adlandırma ve silme artık engelleyici `prompt()` / `confirm()` pencerelerini kullanmaz. Ekleme ve yeniden adlandırma satır içi girdide yapılır (Enter kaydeder, Esc iptal eder, boş değerde odak kaybı iptal eder); silme satır üzerinde onay ister. Satır içi düzenleyici yalnızca değişiklik **başarılıysa** kapanır: satır sürümü çakışması veya geçici depo hatasında yazılan ad, kaldırılan girdiyle kaybolmak yerine alanda kalır. Ağaç görünüm durumu (genişletme, açık paneller, seçimler) yalnızca seçili proje değişince sıfırlanır; önceden her ağaç düzenlemesi yeni satır dizisi üretiyor ve ağacı varsayılan derinliğe kapatıyordu.

## 14. Kalıcılık anlamı ve mevcut sınırlamalar

Görev/WBS değişiklikleri artık asenkron durum/veri kalıcılık sınırından geçer. Başarılı değişiklikler aynı etkin asenkron bellek deposu örneğine yapılan `loadSnapshot()` çağrılarında korunur.

**Demo kipi** kalıcı depo değildir: yeni depo örneği oluşturan tarayıcı yenilemesi, süreç veya sanal makine yeniden başlatması verilen başlangıç verisinden başlar. **Gerçek Sistem kipi kalıcıdır**: WBS satırları `MR_WBS` içinde bulunur, kurumsal düğümler CN43N'den eşitlenir ve eşitleme parmak izi `MR_CorporateWbsSyncState` içinde saklanır (bkz. bölüm 13). Gerçek Sistem kipindeki kalıcılık hatası beklenen bellek sıfırlaması değil, araştırılması gereken arızadır.

Bu geliştirme adımı bilinçli olarak şunları uygulamaz:

- projeler arası görev veya WBS taşıma;
- zincirleme silme;
- tarihsel WBS sürümleme;
- projeler arası CPM ağları;
- ilerlemeyi dikkate alan CPM veya Veri Tarihine göre yeniden zamanlama;
- tam proje yönetimi ekranı.

Düğümün çocukları veya doğrudan atanmış görevleri varsa silme engellenir; hiçbir görev veya alt düğüm sessizce silinmez veya taşınmaz. Kalıcı kayıt hataları WBS doğrulama hatalarından ayrı bildirilir.

## 15. Gelecekteki Primavera P6 eşlemesine ilişkin değerlendirmeler

Model şu yapıya dayalı gelecekteki içe aktarma sınırıyla bilinçli olarak uyumludur:

```text
Project → WBS hiyerarşisi → Aktiviteler
```

Gelecekteki bağdaştırıcılar, özellik hiyerarşisinin anlamını değiştirmeden dış Proje, WBS ve Aktivite tanımlayıcılarını MERGEN Rota kararlı kimliklerine eşleyebilir. Mevcut tasarım açık proje sahipliğini, üst düğüm ilişkilerini, herhangi bir WBS derinliğini ve ayrı Aktivite varlığını zaten korur.

Primavera'ya özgü veritabanı tanımlayıcıları, kalıcılık kuralları, içe aktarma çakışma yönetimi ve eşitleme üst verileri odaklı bütünleşme sözleşmesi tasarlanana kadar bilinçli olarak ertelenmiştir. Asenkron depo sınırı, WBS özellik bileşenlerine kalıcılık uygulama ayrıntılarını göstermeden daha sonra böyle bir sunucu bütünleşmesinin önüne yerleşebilir.

## Kullanılabilir dikey alan

Proje Tanımı proje tarayıcısı sabit görünüm yüksekliği çıkarımı yerine sekmelerin altındaki kalan çalışma alanı yüksekliğini alır. Başlık ve tür süzgeçleri bağımsız kaydırılan proje listesinin üstünde kalır. İş Dağılım Ağacı esnek ağaç görünümünü korur; iki sekme de kompakt 16 px alt iç boşluk kullanır. Kısa pencerelerde denetimlere erişim için sayfa kaydırılabilir. Kapalı dallar kapalı kalır: boş alan büyük kurumsal ağacı otomatik genişletmez. Proje tanım formları sayfa düzeyinde kaydırılabilir kalır.
