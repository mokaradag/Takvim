# CPM ve Kritik Yol Motoru

CPM uygulaması `src/scheduling/cpm` altındadır ve bilinçli olarak saf tutulur. React, Next.js, uygulama durumu, deneme deposu, baz plan verisi veya özellik arayüzlerini içe aktarmaz.

Saklanan zamanlama verileri ile hesaplanan zamanlama sonuçları arasındaki ayrım `docs/ZAMANLAMA-VERI-MODELI.md` belgesinde tanımlanır.

## Dışa açık API

```js
import { calculateCpm, buildDependencyGraph, CpmValidationError } from './src/scheduling/cpm/index.js';
```

`calculateCpm(tasks, options)` şu girdileri kabul eder:

- `tasks`: kararlı kimlikleri, kanonik güncel plan alanları ve bağımlılıkları olan aktiviteler;
- `projects`: proje takvimlerini çözümlemek için kullanılan proje kayıtları;
- `calendars`: zamanlama takvimleri;
- `projectStart`: isteğe bağlı zamanlama referans tarihi;
- `fallbackCalendar`: isteğe bağlı yedek takvim.

`projectStart` verilmezse motor, mevcut en erken görev `plannedStart` değerini güncel planın zamanlama referansı olarak kullanır.

## Aktivite süresi

Motor iş günü cinsinden süreyi şu sırayla belirler:

1. açıkça verilen sayısal `task.plannedDurationDays`;
2. `task.milestone === true` olduğunda sıfır;
3. aktivitenin geçerli takvimiyle `plannedStart` ve `plannedFinish` arasındaki, iki uç dahil iş günü sayısı; kilometre taşı olmayan aktivitelerde en az bir gün kabul edilir.

Üçüncü adımdaki alt sınır önemlidir: başlangıç ve bitişi hafta sonuna veya tatile gelen geçerli tek günlük bir aktivitenin iş günü sayısı sıfırdır; `ZAMANLAMA.md` böyle bir sürenin bire yükseltilmesini gerektirir. Ham sayının yayımlanması aktiviteyi kilometre taşı olarak çizer ve ilerleme ağırlığını sıfırlar.

Kanonik uygulama görevleri normalde güncel plan tarih aralığından normalleştirilmiş `plannedDurationDays` ile gelir. Tarihlerden süre türetme yedeği, aynı kanonik güncel plan anlamını koruyarak saf motorun odaklı zamanlama senaryolarında kullanılmasını sağlar.

CPM sonucundaki `durationDays`, ilgili hesaplamada kullanılan iş günü süresidir. Türetilmiş bir sonuç özelliğidir; kanonik görev süresi için alternatif bir alan değildir.

## Bilinçli olarak kısıt kabul edilmeyen girdiler

Mevcut CPM motoru, saf bir güncel plan ağ hesabı olarak kalır.

- `targetFinish` bir yönetim hedefidir; otomatik CPM kısıtı değildir.
- `actualStart` ve `actualFinish` şu anda yeniden zamanlamayı yönlendirmez.
- `remainingDurationDays` şu anda ilerlemeyi dikkate alan CPM için kullanılmaz.
- `Project.dataDate` şu anda ağın durumunu belirlemek veya ağı yeniden zamanlamak için kullanılmaz.
- Baz plan anlık görüntüleri tarihsel karşılaştırma verisidir; CPM girdi tarihleri değildir.

İlerleme güncellemesi, veri tarihine göre zamanlama ve biçimsel zamanlama kısıtları motorun gelecekteki geliştirme kapsamındadır.

## Takvim çözümleme

Her aktivitenin geçerli takvimi, zamanlama takvimi sözleşmesine göre belirlenir:

1. görev düzeyinde `calendarId` geçersiz kılması;
2. projenin `calendarId` değeri;
3. yedek takvim.

Süreler, tarihler arasındaki hareket ve bağımlılık gecikme/öne alma hesapları `src/scheduling/calendars` iş günü yardımcılarını kullanır.

## İlişki anlamları

Motor dört bağımlılık türünü de destekler:

- `FS`: Bitişten Başlangıca (Finish-to-Start);
- `SS`: Başlangıçtan Başlangıca (Start-to-Start);
- `FF`: Bitişten Bitişe (Finish-to-Finish);
- `SF`: Başlangıçtan Bitişe (Start-to-Finish).

Zamanlama, saat içermeyen ve iki ucu dahil aktivite tarihlerini kullanır. Bu nedenle sıfır gecikmeli bir `FS` ilişkisi, ardılı öncülün bitişinden sonraki ilk iş gününe yerleştirir. `lagDays` iş günü cinsindendir:

- pozitif değerler gecikme ekler;
- negatif değerler öne alma/örtüşme oluşturur.

İlişki kısıtları, gecikme/öne almayı tarihlere dönüştürürken ardıl aktivitenin geçerli takvimini kullanır. Böylece ardılın yerleşimi, gerçekten çalışabileceği takvimle tutarlı kalır.

## İleri geçiş

İleri geçiş topolojik bağımlılık sırasını izler ve şunları hesaplar:

- Erken Başlangıç (`earlyStart`);
- Erken Bitiş (`earlyFinish`).

Her aktivite, proje başlangıcından ve gelen bağımlılık kısıtlarının herhangi birinden önce başlayamaz.

## Geri geçiş

Geri geçiş, hesaplanan proje bitişinden başlar ve aktiviteleri ters topolojik sırada işler. Şunları hesaplar:

- Geç Başlangıç (`lateStart`);
- Geç Bitiş (`lateFinish`).

Motor daha sonra şunları hesaplar:

- Toplam Bolluk (`totalFloatDays`);
- Serbest Bolluk (`freeFloatDays`);
- kritiklik durumu (`isCritical`).

Bir aktivite şu anda `totalFloatDays <= 0` olduğunda kritik sayılır.

## Kritik yollar

Sonuç şunları içerir:

- `criticalTaskIds`: bolluğu sıfır veya negatif olan bütün aktiviteler;
- `criticalPaths`: kritik aktiviteleri sıfır bolluklu ilişkiler üzerinden bağlayan bağımlılık yolları.

Dolayısıyla paralel yolların belirleyici süreleri eşitse birden çok kritik yol dönebilir.

### Yol listelemenin sınırı

Yol listeleme, kökten yaprağa her kritik yol için bir dizi oluşturur; art arda gelen elmas yapılarında bu sayı **üstel** büyür: yirmi beş kritik elmas katmanı otuz üç milyondan fazla yol tanımlar. `buildPortfolioSchedule()`, `calculateCpm()` işlevini eşzamanlı çağırdığından böyle bir ağ zamanlama çizimini donduruyor veya tarayıcı belleğini tüketiyordu.

Bu nedenle listeleme `MAX_CRITICAL_PATHS` (500) sınırında durur ve `criticalPathsTruncated: true` bildirir. Yol sayısı tek başına yetmez: uzun ortak bir kuyruğa bağlanan yüzlerce kök, her adımda yolun tamamı kopyalandığında karesel iş üretiyordu. Gezinti bu yüzden özyinelemesizdir, yolu tek bir yığında tutar ve yalnızca tamamlanan yolu kopyalar; ziyaret edilen ve yayımlanan yol öğelerinin toplamı `MAX_CRITICAL_PATH_STEPS` (250 000) ile sınırlıdır ve bu sınıra ulaşılması da aynı bayrakla bildirilir. `criticalTaskIds` **eksiksiz** kalır; yalnızca yol listesi kesilir. Böylece kritiklik vurgusu yanlış olmaz, yalnızca ayrıntı azalır. `selectPortfolioSchedule()` bu bayrağı her proje zamanlamasına taşır; arayüz listenin eksiksiz olduğunu ileri sürmez.

## Sonuç yapısı

`calculateCpm()` şu yapıyı döndürür:

```text
projectStart
projectFinish
orderedTaskIds
criticalTaskIds
criticalPaths
criticalPathsTruncated
tasks
  <taskId>
    id
    calendarId
    durationDays
    earlyStart
    earlyFinish
    lateStart
    lateFinish
    totalFloatDays
    freeFloatDays
    isCritical
```

Tarihler yerel `YYYY-MM-DD` dizeleri olarak döner.

Sonuç, türetilmiş zamanlama durumudur. Kanonik görev nesnesine birleştirilmez.

## Graf doğrulama

Bağımlılık grafı zamanlamadan önce doğrulanır. `CpmValidationError`, kararlı bir `code` ve isteğe bağlı `details` içerir.

Mevcut doğrulama kodları şunlardır:

- `MISSING_TASK_ID`;
- `DUPLICATE_TASK_ID`;
- `MISSING_PREDECESSOR`;
- `SELF_DEPENDENCY`;
- `DEPENDENCY_CYCLE`;
- `MISSING_TASK_DATE`;
- `INVALID_TASK_DATE`;
- `INVALID_TASK_DATES`;
- `MISSING_PROJECT_START`;
- `INVALID_PROJECT_START`.

Geçersiz ağlar, kısmi CPM sonuçları dönmeden hata verir.

## Uygulama bütünleşmesi

CPM motoru bir zamanlama servisi olarak kalır. Uygulama bütünleşmesinden `src/state/selectors/scheduleSelectors.js` sorumludur; `AppStateProvider` sonucu bellekte yeniden kullanır.

Durum projeksiyonu:

- görevleri `projectId` ile ayırır;
- her proje için bağımsız `calculateCpm()` çağrısı yapar;
- başarılı görev sonuçlarını portföy düzeyinde türetilmiş bir erişim yapısında birleştirir;
- proje düzeyindeki `criticalTaskIds`, `criticalPaths` ve hesaplanan bitiş tarihlerini korur;
- hatalı bir projenin diğer projelerin çizilmesini engellememesi için doğrulama hatalarını yalıtır;
- geçersiz bir proje hesabını sessizce üretmek yerine projeler arası bağımlılıkları açıkça `CROSS_PROJECT_DEPENDENCY` olarak bildirir.

Özellik bileşenleri türetilmiş projeksiyonu durum kancaları üzerinden kullanır. Doğrudan `calculateCpm()` çağırmaz ve CPM matematiğini React içine kopyalamaz.

Gantt bütünleşmesi, ana güncel plan çubuklarında `plannedStart` -> `plannedFinish` aralığını korur. CPM sonuçları ayrı türetilmiş katmanlarla sunulur: kritik görev/ilişki biçimlendirmesi, isteğe bağlı erken/geç/bolluk sütunları, yalnızca kritik görevleri süzme, hesaplanan proje bitişi, CPM bilgi kutuları ve doğrulama uyarıları.

Hesaplanan CPM alanları kalıcı olarak saklanmaz veya kanonik görev nesnelerine birleştirilmez. Güncel plan düzenlendiğinde türetilmiş projeksiyon doğal olarak yeniden hesaplanır; baz plan anlık görüntüleri ve gerçekleşen tarihler değişmez.

## Motorun dışında kalan kapsam

Motor ve mevcut uygulama projeksiyonu hâlâ bilinçli olarak şunları yapmaz:

- ilerlemeyi veya veri tarihini dikkate alan yeniden zamanlama;
- gerçekleşen tarihleri zamanlama yönlendiricisi olarak kullanma;
- yönetim hedeflerini kesin kısıt kabul etme;
- CPM sonuçlarını kalıcı saklama;
- baz plan anlık görüntülerini değiştirme;
- biçimsel zamanlama kısıtlarını modelleme;
- projeler arası bağımlılık ağlarını modelleme;
- çalışma saatlerini veya kısmi gün takvimlerini modelleme;
- aktiviteler için kaynak dengeleme.
