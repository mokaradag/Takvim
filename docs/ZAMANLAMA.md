# Zamanlama Takviminin Anlamı

MERGEN Rota; takvim, güncel plan normalleştirmesi, bağımlılık ve CPM hesaplarını `src/scheduling` içinde tutar. Böylece zamanlama hesapları saf kalır; React, Next.js ve veri bağdaştırıcısından bağımsızdır.

Saklanan ve türetilen verileri ayıran profesyonel zamanlama modeli `docs/ZAMANLAMA-VERI-MODELI.md` belgesindedir.

## Takvim modeli

Bir zamanlama takvimi şunları içerir:

- kararlı bir `id`;
- görüntülenecek `name`;
- `timezone` tanımlayıcısı;
- JavaScript hafta günü numaralarıyla `workingDays` (`0` Pazar, `6` Cumartesi);
- açık `YYYY-MM-DD` tarihleriyle `holidays`.

Tatil tarihleri bilinçli olarak yıla özeldir. Hareketli tatiller tekrarlanan `MM-DD` değerleriyle saklanmamalıdır; bu, sonraki yıllarda yanlış tarihleri sessizce çalışma dışı gün yapar.

`workingDays` en az bir hafta günü içermelidir. Boş liste geçerli bir yapılandırma değildir: `MR_CalendarWorkingDays` içinde satırı olmayan takvim için SQL projeksiyonu `workingDays: []` üretir ve bu listeyle hiçbir iş günü araması sonuçlanamaz. Bu nedenle `isWorkingDay()` ve `normalizeCalendar()` boş listeyi varsayılan Pazartesi–Cuma haftası olarak değerlendirir.

Yedek takvim, 2028 dahil sabit tarihli Türkiye ulusal bayramlarını içerir. Hareketli dinî bayramlar (Ramazan, Kurban) resmen ilan edilir; gelecek yıllar için **tahmin edilmez**. Her kurulum bunları kendi `MR_CalendarHolidays` satırlarıyla sağlar.

Mevcut deneme bağdaştırıcısı iki takvim sağlar:

- `cal-tr-standard-2026`: Pazartesi–Cuma;
- `cal-tr-operations-2026`: Pazartesi–Cumartesi.

İkisi de şu anda aynı açık 2026 tatil listesini kullanır. Yarım gün istisnaları ve çalışma saati vardiyaları bu temelin dışındadır; tam çalışma dışı gün olarak yaklaşık temsil edilmek yerine daha sonra açıkça modellenmelidir.

## Takvim seçimi

Takvim şu sırayla çözümlenir:

1. görev düzeyindeki `calendarId` geçersiz kılması;
2. görevin projesinin `calendarId` değeri;
3. zamanlama yedek takvimi.

Özellik bileşenleri bu aramayı yeniden uygulamamalıdır. `src/scheduling/calendars` içindeki `resolveTaskCalendar()` veya `resolveProjectCalendar()` kullanılmalıdır.

## İş günü hesapları

Takvim katmanı şu saf yardımcıları sunar:

- `isWorkingDay()`;
- `holidayFor()`;
- `moveToWorkingDay()`;
- `addWorkingDays()`;
- `diffWorkingDays()`;
- `countWorkingDays()`.

`addWorkingDays(date, amount, calendar)` iş günü adımlarıyla ilerler. Pozitif değerler ileri, negatif değerler geri götürür. Seçili takvime göre hafta sonları ve açıkça tanımlanmış tatiller atlanır.

`diffWorkingDays(a, b, calendar)`, iş gününe gelen bir başlangıç ve tamsayı `n` için şöyle tanımlanır:

```text
diffWorkingDays(addWorkingDays(start, n, calendar), start, calendar) === n
```

`countWorkingDays(start, end, calendar)` iki uç dahil iş günlerini sayar. Güncel plan normalleştirmesi, görevin geçerli takvimiyle `plannedStart` ve `plannedFinish` değerlerinden `plannedDurationDays` hesaplamak için bunu kullanır. Açık kanonik plan süresi verilmediğinde CPM de aynı güncel plan tarihlerini süre yedeği olarak kullanabilir.

`calculatePlannedDurationDays()`, kilometre taşı olmayan geçerli bir aralığı en az bir gün kabul eder. Hafta sonuna veya tatile gelen tek günlük görevin iş günü sayısı sıfırdır; `0` bildirilmesi Gantt grup özetlerinde görevi kilometre taşı olarak çiziyor ve ilerleme ağırlığını düşürüyordu.

### Sonlanma güvenceleri

Her iş günü araması **sınırlıdır**. Yardımcılar önceden koşulsuz döngü kullandığından iki olağan girdi tarayıcı sekmesini tamamen donduruyordu; bildirilen “Kaydet'e bastığımda uygulama donuyor” hatasının nedeni buydu:

- `workingDays` listesi boş takvimde (yukarıya bakın) `isWorkingDay()` her tarih için `false` döndürüyor, `moveToWorkingDay()` / `addWorkingDays()` hiç sonlanmıyordu. `createNewTask()`, `moveToWorkingDay()` çağırdığından böyle bir projede görev oluşturmak bütün sekmeyi kilitliyordu;
- `parseDate()` tarafından çözülemeyen bir değer, `getTime()` sonucu `NaN` olan Invalid Date üretir. `diffWorkingDays()` zaman damgalarını eşitlik için karşılaştırdığından onun döngüsü de bitmiyordu.

Güncel sözleşme şöyledir:

- çözülemeyen tarih, girdiyi değiştirmeden döndürür (`moveToWorkingDay`, `addWorkingDays`) veya `0` döndürür (`diffWorkingDays`, `countWorkingDays`);
- `addWorkingDays` tarama bütçesi **istekten türetilir** (`7n + 7` takvim günü ve en az on yıllık tarama bütçesi). Böylece uzun ama geçerli bir gecikme veya süre sessizce girdi tarihine indirgenmek yerine tam hesaplanır. Sabit üst sınır, yaklaşık 2595 iş gününü aşan her aralığı sıfırdan ayırt edilemez kılıyor ve hatayı iyimser yönde üretiyordu: 4000 iş günü gecikme hiç gecikme yokmuş gibi, 2600 günlük aktivite sıfır süreli kilometre taşı gibi zamanlanıyordu;
- `MAX_WORKING_DAY_SPAN` (20 000 iş günü) üzerindeki aralık **kesilmez, bildirilir**: `addWorkingDays`, `null` döndürür ve CPM motoru `SCHEDULE_HORIZON_EXCEEDED` hatası verir. Böylece proje zamanlaması yanlış tarihle yayımlanmak yerine geçersiz gösterilir. Aynı sınır yazma sınırında (`commitScalarValidation`) ve Öne Alma/Gecikme girdisinde uygulanır; olağan bir düzenlemeyle bu sınıra ulaşılamaz;
- `diffWorkingDays` / `countWorkingDays` sabit bitiş noktasına ilerler ve her zaman sonlanır. `MAX_CALENDAR_SPAN_DAYS` sınırı (yaklaşık yüz yıl), yalnızca SQL'in kabul ettiği uç tarihlerin (0001–9999 yılları) milyonlarca yinelemeye dönüşmesini önler. `calculatePlannedDurationDays`, bu sınırı aşan aralıkta kesilmiş sayı yerine `null` döndürür;
- ulaşılabilir iş günü olmayan takvimde de döngüye girmek yerine girdi tarihine dönülür; asgari tarama bütçesinin koruduğu durum budur;
- `parseDate()`, saat bölümü içeren ISO dizelerini (`2026-08-18T00:00:00.000Z`) kabul eder; çözemediği değerlerde sessizce “bugün” yerine Invalid Date döndürür. İkisini ayırt etmesi gereken çağıranlar için `isValidDate()` dışa aktarılır.

Bu sözleşmeler birim testleriyle (`test/task-dialog-freeze-regressions.test.mjs`) kapsanır ve güncel plan ile CPM katmanlarının kullandığı hesap temelini oluşturur.

## Sürelerin anlamı

Aksi açıkça belirtilmedikçe bütün zamanlama süreleri iş günü cinsindendir.

- `Task.plannedDurationDays`, değiştirilebilir güncel planın normalleştirilmiş süresidir.
- `Task.remainingDurationDays`, null olabilen bir uyumluluk alanıdır; mevcut arayüz ve zamanlama motoru bunu kullanmaz, yeni görevler bunu plandan veya ilerlemeden türetmez.
- `CpmTaskResult.durationDays`, ilgili CPM hesabında kullanılan iş günü süresidir.
- `Dependency.lagDays`, iş günü cinsinden gecikme/öne alma değeridir.

Kanonik plan süresi sıradan takvim günü çıkarımıyla hesaplanmamalıdır. Kilometre taşlarının plan süresi sıfırdır.

Kilometre taşı, Görev ayrıntı çekmecesinin *Güncel plan* kartından tanımlanır (projeye tam yazma yetkisi gerekir). Anahtar açıldığında görev tek güne iner: planlanan bitiş, planlanan başlangıcı izler ve süre sıfıra normalleştirilir. Her iki Gantt görünümü de çubuk yerine elmas çizer. Saklanan alan `MR_Tasks.IsMilestone`, istemciye yansıyan alan `milestone`/`isMilestone` değeridir; sunucu plan süresi sıfır olmayan kilometre taşını reddeder. Bu anahtar eklenene kadar bayrak veri modeli ve dışa aktarım boyunca korunuyor ancak ürünün hiçbir yerinde ayarlanamıyordu; bu nedenle Gantt çizelgesinde kilometre taşı görünmüyordu.

## Bağımlılık gecikmesi ve öne alma

Kanonik bağımlılık alanı `lagDays` olarak kalır; zamanlama bunu iş günü olarak yorumlar:

- pozitif `lagDays` = gecikme;
- negatif `lagDays` = öne alma.

Doğrudan takvim günü eklemek yerine `applyDependencyLag()` kullanılmalıdır. Yardımcı, seçili zamanlama takvimini uygular ve çalışma dışı günleri atlar.

Kesin kaynak `lagValue`/`lagUnit`, türetilmiş önbellek ise `lagDays` değeridir. Bu nedenle `normalizeDependency()` parametre olarak **takvimi** alır ve hafta/ay birimlerini onunla dönüştürür. Varsayılan takvimle dönüşüm, altı günlük takvimde zamanlamanın gerçekten uyguladığı tarihle uyuşmayan `lagDays` yazıyordu; doğrudan `lagDays` okuyan tüketiciler (örneğin projeler arası bağımlılık raporu) planla uyuşmayan gecikme bildiriyordu. `normalizeTaskRecord()` görevin kendi takvimini çözümler ve iletir.

`dependencyLagDays()` **saf okumadır**: incelediği bağımlılığa yazmaz. Bağımlılıklar uygulama durumundaki görev kayıtlarından gelir; yerinde yazma, durumu reducer dışında değiştiriyor ve içerik farklıyken `task.deps` eşitlik denetimlerini “değişmedi” sonucunda bırakıyordu. Eski biçim tamamlama işlemi (kayıtta birim bulunup açık değer olmadığında saklanan `lagDays` üzerinden `lagValue` doldurma), **kopya** döndüren `materializeDependencyLag()` içine taşındı. Bu işlev yalnızca düzenleyici yazma yollarından (`TaskDrawer.updateDep`, `planSuccessorUpdate`) çağrılır.

## Öncüller ve ardıllar

Bir bağımlılık kenarı **bir kez**, ardıl üzerinde saklanır: `B.deps` içinde `A` bulunması “A, B'nin öncülüdür” anlamına gelir. `successors` alanı yoktur ve olmamalıdır; aynı kenarın iki yerde tutulması zamanla tutarsızlık oluşturur.

Dolayısıyla “ardıl”, ikinci bir veri yapısı değil bir **okuma yönüdür**. Görev Ayrıntısı ilişki düzenleyicisi iki yönü de sunar:

- *Öncüller* sekmesi doğrudan `task.deps` düzenler;
- *Ardıllar* sekmesi **diğer** görevin `deps` alanını düzenler ve `updateTask(successorId, …)` üzerinden yama gönderir.

`src/features/task-detail/taskSuccessorPolicy.js` bu dönüşümden sorumlu saf modüldür: ters başvuruyu tarayarak ardılları türetir, bağlama/bağı kaldırma/tür ve gecikme değişikliklerinin yamasını üretir, döngü oluşturacak kenarı reddeder. Döngü denetimi mevcut görevin geçişli öncül kapanışını gezer; zaten bu kapanıştaki adaylar seçiciden çıkarılır. Böylece kullanıcı reddedilecek seçimi yapamaz. Gezinme ziyaret edilen düğümleri işaretlediğinden saklanan veri zaten döngülü olsa bile sonlanır.

## Görev önceliği

`Task.priority`, veri sınırında (`normalizePriorityId`) `critical` / `high` / `medium` / `low` değerlerinden birine kanonikleştirilir; bilinmeyen ve eski değerler `medium` olur. Öncelik zamanlama kısıtı **değildir**; CPM'i veya tarihleri etkilemez, ancak Görevler, Gantt, Kanban ve Raporlar risk görünümlerini yönlendirir.

Alan önceden her yerde salt okunurdu: her liste bunu çiziyor ve süzüyordu, ancak hiçbir ekran ayarlayamıyordu; bu nedenle her görev varsayılan değerde kalıyordu. Artık Görev Ayrıntısı **Öncelik** bölümünde düzenlenir.

## Profesyonel zamanlama kavramları

Mevcut zamanlama modeli şunları ayırır:

- güncel plan: `plannedStart`, `plannedFinish`, `plannedDurationDays`;
- yönetim hedefi: `targetFinish`;
- gerçekleşenler: `actualStart`, `actualFinish`;
- null olabilen kalan süre uyumluluk alanı: `remainingDurationDays`;
- proje durum kesim tarihi: `Project.dataDate`;
- değişmez tarihsel baz plan anlık görüntüleri;
- türetilmiş CPM sonuçları.

`targetFinish` zamanlama kısıtı değildir. Gerçekleşen tarihler durumdan türetilmez. Kalan süre plandan veya tamamlanma yüzdesinden türetilmez ve mevcut görev arayüzünde düzenlenmez.

## Veri ve durum sınırı

Zamanlama takvimleri, projeler, kanonik görevler, baz planlar ve görev baz plan anlık görüntüleri depo anlık görüntüsünün parçasıdır. Projeler `calendarId` ve `dataDate` taşır; görevler isteğe bağlı olarak kendi `calendarId` değerleriyle proje takvimini geçersiz kılabilir.

Deneme bağdaştırıcısı bu verinin yalnızca bir sağlayıcısıdır. Gelecekteki API/veritabanı bağdaştırıcısı aynı kararlı anlamsal yapıları döndürmelidir; böylece özelliklere sunulan durum kancaları değişmez.

Eski zamanlama özellik adları veri sınırında bir kez normalleştirilir; duruma, zamanlama hesaplarına veya özelliklere yayılmaz.

## CPM motoru

Saf CPM uygulaması `src/scheduling/cpm` altındadır; kanonik güncel plan verisini ve yukarıdaki takvim sözleşmelerini kullanır. Şunları sağlar:

- bağımlılık grafı doğrulaması ve döngü saptama;
- FS, SS, FF ve SF kısıtları;
- iş günü cinsinden pozitif gecikme ve negatif öne alma;
- proje/görev takvim çözümlemesi;
- ileri ve geri geçişler;
- erken ve geç tarihler;
- toplam ve serbest bolluk;
- bir veya birden çok kritik yol;
- kilometre taşı ve sıfır süreli aktivite işleme.

Motor şu anda `actualStart`, `actualFinish`, `remainingDurationDays` veya `Project.dataDate` alanlarını ilerlemeyi dikkate alan yeniden zamanlamada kullanmaz. Ayrıntılı girdi, ilişki ve çıktı anlamları `docs/CPM.md` belgesindedir.

## Uygulama zamanlama projeksiyonu

Uygulama, özellik bileşenlerinden `calculateCpm()` çağırmak yerine CPM'i `src/state/selectors/scheduleSelectors.js` üzerinden kullanır.

Projeksiyon her projeyi bağımsız hesaplar, ardından başarılı sonuçları portföy düzeyinde erişim için birleştirir. Böylece bir projenin bitiş tarihi diğerinin bolluğunu etkilemez. CPM doğrulama hataları proje başına yakalanır; ilgisiz projeler kullanılabilir kalır.

Projeler arası bağımlılıklar şu anda `CROSS_PROJECT_DEPENDENCY` olarak bildirilir; gelecekteki portföy ağı modeli bu anlamları tanımlayana kadar etkilenen proje CPM dışında bırakılır.

CPM çıktısı türetilmiş veri olarak kalır. Erken/geç tarihler, bolluk ve kritiklik kanonik görev nesnelerine yazılmaz. Gantt, ana çubukları değiştirilebilir güncel plana göre yerleştirmeyi sürdürür ve CPM bilgisini ayrı katmanda gösterir.
