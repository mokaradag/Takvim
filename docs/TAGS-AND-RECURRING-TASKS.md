# Etiket Kataloğu ve Tekrarlayan Görevler

Bu belge iki yakın konuyu birlikte anlatır: proje düzeyinde yönetilen **etiket
kataloğu** ve **tekrarlayan görev serileri**. İkisi de görev tanımının parçasıdır
ve aynı kalıcılaştırma sözleşmesinden geçer.

## 1. Etiket kataloğu

### 1.1 Model

Etiket artık düz bir metin değildir. Kanonik biçim üç alandır:

```js
{ name: 'Analiz', color: 'rose', icon: 'Target' }
```

| Alan    | Kaynak                                  | Kural |
| ------- | --------------------------------------- | ----- |
| `name`  | Kullanıcı                               | Boş olamaz, en fazla 255 karakter, proje içinde harf duyarsız tekil |
| `color` | `TAG_COLOR_KEYS` (uygulama paleti)      | Kapalı küme; verilmezse ada göre **kararlı** bir renk türetilir |
| `icon`  | `TAG_ICON_KEYS` (`Icons` sözlüğü adları) | Kapalı küme; verilmezse `Flag` |

Tek doğruluk kaynağı `src/domain/tags/index.js`'tir. Hem istemci formu hem
sunucu doğrulaması aynı listeleri kullanır; renk ve simge için ikinci bir liste
tanımlanmamalıdır.

`normalizeProjectTags` düz metinleri de kabul eder. Eski anlık görüntülerde ve
Temel Kip'un hızlı giriş akışında etiketler metin olarak geldiği için bu
tolerans bilinçlidir; katalog her durumda kanonik üçlülere yükseltilir.

### 1.2 Yeniden adlandırma

Etiketin kalıcı bir kimliği yoktur (`MR_ProjectTags` her kaydetmede yeniden
kurulur). Bu yüzden ad değişikliği **çıkarımla bulunamaz**: arayüz eski→yeni
eşlemesini `tagRenames` alanıyla açıkça gönderir.

```js
updateProject(projectId, {
  ...form,
  tags: [{ name: 'Çözümleme', color: 'rose', icon: 'Target' }],
  tagRenames: [{ from: 'Analiz', to: 'Çözümleme' }]
});
```

Eşleme **kalıcılaştırma sınırında**, katalog yazmasıyla aynı işlemde uygulanır
(`planProjectTagPropagation` + `propagateProjectTagChanges`). Yayılım istemcinin
gördüğü görev kümesinden türetilseydi, eşzamanlı bir kullanıcının aynı anda
oluşturduğu görev kapsanmaz ve katalog dışında kalırdı: görev yazmaları proje
satırının sürümünü ilerletmediği için bu çakışma sessizce başarılı olurdu.

Plan üç kuraldan oluşur:

1. **Yeniden adlandırma** — açıkça bildirilen eski→yeni eşlemesi uygulanır.
2. **Ad düzeltme** — katalogdaki adın harf varyantları kanonik yazıma çekilir.
3. **Kaldırma** — yalnızca bu yazmada katalogdan çıkarılan ad temizlenir. Hiç
   katalogda olmamış eski anahtar sözcükler korunur; aksi hâlde boş kataloglu
   eski bir projeyi kaydetmek bütün etiketleri silerdi.

Formdaki katalog girdileri **yerel ve değişmez** bir kimlik taşır; eşleme
kümesi form durumundan türetilir. Ada bağlı bir günlük tutulsaydı, `A → B` yapıp
yeni bir `A` ekleyip onu `C` yapmak iki kaydı da aynı kaynakla günlüğe yazar ve
görevleri yanlış etikete taşırdı. Türetilmiş olması aynı zamanda formu geri
almanın bekleyen eşlemeleri de temizlemesini sağlar.

Etiketin kullanım sayısı girdinin **yüklendiği** addan sayılır: güncel adla
sayılsaydı, kullanılan bir etiketi yeniden adlandırmak kullanımı anında sıfıra
düşürür ve silmeyi serbest bırakırdı.

### 1.3 Kalıcılaştırma

`dbo.MR_ProjectTags` iki yeni sütun taşır:

```sql
ColorToken varchar(20) NULL,
IconKey    varchar(40) NULL,
```

`NULL` değerler geçerlidir: arayüz o etiket için ada göre türetilen varsayılana
düşer. Böylece bu sürümden önce yazılmış satırlar geçerli kalır ve veri göçü
gerektirmez.

Anlık görüntü kataloğu **iki alanla** taşır: `tags` eski sözleşmedeki düz metin
listesidir (sürüm geçişinde açık kalan eski paketler etiketi metin sanar ve
nesne aldıklarında proje ekranı çökerdi), `tagCatalog` ise renk ve simgeyi
taşıyan kanonik katalogdur. Yeni arayüz `projectTagCatalog(project)` ile
kataloğu okur, yoksa düz metin listesine düşer.

Yazma yolunda saklanan görünüm **korunur**: eski bir paket kataloğu düz metin
olarak geri gönderdiğinde renk ve simge varsayılana dönmez
(`mergeProjectTagAppearance`). Aksi hâlde sürüm geçişi sırasında yeni istemcinin
kaydettiği özelleştirmeler kalıcı olarak kaybolurdu.

Yazma yolu `reconcileProjectTags` içinde kanonikleştirir; sunucu doğrulaması
(`commitProjectWbsValidation`) bilinmeyen renk/simge anahtarını
`PROJECT_TAG_COLOR_INVALID` / `PROJECT_TAG_ICON_INVALID` ile reddeder.

### 1.4 Arayüz

Katalog **Proje Yapısı → Proje Tanımı** ekranında yönetilir. Her satır tek bir
etikettir: simge kutusu, yerinde düzenlenebilir ad, kullanım sayısı, renk
paleti ve simge seçici. Kullanımdaki bir etiket silinemez; kullanıcıya kaç
görevde geçtiği söylenir.

Görev detayında etiket seçimi kataloğun rengini ve simgesini gösterir; etiket
serbest metin değildir.

## 2. Tekrarlayan görevler

### 2.1 Neden RFC 5545

Uzun süre boyunca yinelenen işler (günlük kontrol, haftalık rapor, aylık
kapanış) için özel bir kural biçimi uydurmak yerine takvim uygulamalarının
tamamının konuştuğu standart seçilmiştir: **RFC 5545 (iCalendar) `RRULE`**.
Outlook, Google Takvim ve Primavera P6 "recurring activity" tanımları aynı
kavramları kullanır; kural metni dışa aktarıldığında başka bir sisteme olduğu
gibi taşınabilir.

Desteklenen alan kümesi bilinçli olarak dardır:

```text
FREQ=DAILY|WEEKLY|MONTHLY|YEARLY   tekrar sıklığı
INTERVAL=<n>                       kaç sıklıkta bir (varsayılan 1)
BYDAY=MO,TU,...                    haftalık tekrarda hangi günler
BYMONTHDAY=<1..31>                 aylık tekrarda ayın günü
COUNT=<n> | UNTIL=<YYYYMMDD>       seri sonu (ikisi birden verilemez)
```

`COUNT` ve `UNTIL` birlikte verilirse RFC 5545 gereği kural geçersizdir ve
**yazma sınırında reddedilir**: `findRecurrenceRuleIssue` bunu
`COUNT ve UNTIL birlikte verilemez.` gerekçesiyle bildirir, commit ucu da
`TASK_RECURRENCE_INVALID` döndürür. Kullanıcının verdiği bitiş tarihi bu yüzden
sessizce kaybolamaz.

`normalizeRecurrenceRule` bir OKUMA yolu yardımcısıdır ve hoşgörülüdür: elde
kalmış ya da eski bir kaydı çözerken ikisi birden geldiğinde `COUNT`'u önceler.
Bu tolerans yalnızca çözümlemede geçerlidir; kalıcılaştırma yolunda geçersiz
birleşim hiç kabul edilmez.

Kural motoru `src/scheduling/recurrence/index.js` içindedir ve saftır.

### 2.2 Şablon ve yineleme

Model iki rolü ayırır:

- **Seri şablonu** — `recurrence` alanında kuralı taşıyan görev.
- **Yineleme** — şablondan üretilen, `recurrenceParentId` ile şablona bağlı
  sıradan görev.

Yineleme sıradan bir görevdir: Gantt, Kanban ve Takvim'de görünür, tek tek
ilerletilir ve gerektiğinde ayrı ayrı düzenlenir. Bir yineleme kendi kuralını
taşıyamaz; bu hem sunucu doğrulamasında (`TASK_RECURRENCE_CONFLICT`) hem de
veritabanı kısıtında (`CK_MR_Tasks_Recurrence`) zorlanır.

Üretim sırasında:

- şablonun **süresi** korunur; süre `plannedDurationDays` gibi **dahil iş günü**
  ölçüsüdür, bu yüzden bitiş N'inci iş günü olarak hesaplanır ve hafta sonuna
  taşmaz. Şablonun planlanan bitişi yoksa yinelemeye de bitiş uydurulmaz;
- hedef bitiş uzaklığı **iş günü ölçüsüyle** korunur. Şablonun termini yoksa
  yinelemeye termin yazılmaz; planlanan bitişten önceye konmuş bir termin de
  bitişe kadar ötelenmez;
- çalışma takvimi görevden çözülür (`resolveTaskCalendar`: görev geçersiz
  kılması, sonra proje takvimi). Tatil ve hafta sonuna denk gelen yineleme bir
  sonraki iş gününe kaydırılır, kaydırma iki yinelemeyi aynı güne düşürürse
  ikincisi üretilmez;
- **COUNT / UNTIL / ufuk sınırları kaydırma ve tekilleştirmeden sonraki kümeye**
  uygulanır: kullanıcı üç yineleme istediyse üç görev oluşur ve hiçbir görev
  `UNTIL` tarihinden sonraya kalıcılaştırılmaz;
- şablonun **bağımlılıkları kopyalanmaz** — aksi hâlde aynı öncül onlarca kez
  tekrarlanır ve CPM ağı bozulurdu;
- gerçekleşen tarih, emek ve harcama sıfırlanır, yapay bir kalan süre üretilmez
  ve her yinelemeye ayrı bir sıra anahtarı verilir;
- daha önce üretilmiş bir yineleme yeniden üretilmez. Tanıma **değişmez seri
  kimliği** (`recurrenceOccurrenceDate`) üzerinden yapılır: kullanıcı bir
  yinelemeyi ertelese bile o gün ikinci kez üretilmez.

Takvimde bulunmayan bir tarih (31 Şubat, artık olmayan yılda 29 Şubat) RFC 5545
gereği **atlanır** ve yineleme sayılmaz. Kural dışa aktarıldığında başka bir
takvim uygulamasıyla aynı seriyi vermelidir; ayın son gününe çekmek saklanan
`RRULE`'ün anlamını sessizce değiştirirdi.

Haftalık kuralda `BYDAY` verilmediğinde RFC 5545 serinin başlangıç gününü
varsayar; arayüz de gün seçilmediğinde bunu açıkça yazar.

**Gün seçimi tümüyle kullanıcınındır.** Arayüz daha önce `DTSTART` gününü zorla
seçili tutuyordu: Salı başlayan bir seride kullanıcı yalnızca Pazartesi ve
Perşembe tanımlamak istediğinde Salı'yı listeden çıkaramıyordu. Bu kısıt
kaldırıldı; planlanan başlangıcın günü yalnızca ince bir çizgiyle *işaretlenir*,
seçimi zorunlu değildir.

Kısıtın gerekçesi olan belirsizlik ise ARAYÜZDE çözülür: `COUNT` RFC 5545'te
serinin **toplam** yineleme sayısıdır ve `DTSTART` kurala uyuyorsa serinin ilk
yinelemesi şablonun kendisidir. Bu durumda "3 yineleme" yalnızca **2 yeni görev**
demektir. `summarizeRecurrencePlan` bu ayrımı hesaplar ve panel açıkça yazar:

> Seri toplam **6** yinelemeden oluşur. İlki bu görevin kendisidir; **5** yeni
> görev oluşturulur.

Aynı özet yineleme takvimini de üretir: ilk sekiz gün, haftanın günüyle birlikte
listelenir, şablonun kendi günü vurgulanır ve kalan yineleme sayısı
"+N daha" olarak gösterilir. Önizleme üretimle **aynı** planlayıcıyı kullanır
(`planRecurringOccurrences`); hafta sonuna denk gelen günler iş gününe kaydırılıp
tekilleştirildikten sonra gösterilir.

Sonsuz kurallar `MAX_RECURRENCE_OCCURRENCES` (400) ile sınırlıdır. Bu tavanı
aşan sonlu bir `COUNT` hiçbir zaman tamamlanamayacağı için hem arayüzde hem de
kalıcılaştırma sınırında reddedilir.

### 2.3 Kalıcılaştırma

`dbo.MR_Tasks`:

```sql
RecurrenceRule           nvarchar(400) NULL,
RecurrenceParentTaskId   uniqueidentifier NULL,
RecurrenceOccurrenceDate date NULL,
```

Kural yazılmadan önce `formatRecurrenceRule` ile kanonikleştirilir: ayrıştırılamayan
bir metin kalıcı kayda düşmez. Sunucu doğrulaması gönderilen `RRULE` gövdesini
**katı** biçimde denetler (`findRecurrenceRuleIssue`): desteklenmeyen bileşen,
geçersiz `BYDAY`/`BYMONTHDAY`, `COUNT=0` ya da tavanı aşan `COUNT`
`TASK_RECURRENCE_INVALID` ile reddedilir. Hoşgörülü normalleştirme yalnızca
OKUMA yolundadır; yazma yolunda hoşgörü, gönderilen kuralın saklanandan başka
anlama gelmesi demektir. Başlangıçtan önce biten bir kural
(`TASK_RECURRENCE_RANGE_INVALID`) hiçbir yineleme üretemeyeceği için kabul
edilmez.

`RecurrenceOccurrenceDate` yinelemenin **değişmez** seri kimliğidir (RFC 5545
`RECURRENCE-ID` karşılığı). `UX_MR_Tasks_RecurrenceOccurrence` filtrelenmiş
tekil dizini `(şablon, gün)` çiftini garanti eder: istemci tarafı denetim
eşzamanlı iki yazıcıyı durduramaz, ikisi de günü "eksik" görüp farklı `TaskId`
ile ekleyebilirdi.

Seri bütünlüğü kalıcı katmanda korunur:

- yeni yinelemenin ham tekrar günü, şablon kuralının ve çalışma takviminin ürettiği bir oluşumla eşleşmelidir; planlanan başlangıç, bitiş, termin ve iş günü süresi de aynı oluşumun değerlerini taşımalıdır. Uyumsuz bir satır bütün kayıt işlemini geri alır. Oluşturulduktan sonra yinelemenin kendi planı mevcut yetki ve sürüm kurallarıyla düzenlenebilir;

- yineleme, şablonuyla **aynı projede** olmak zorundadır ve şablonun kendisi
  başka bir serinin yinelemesi olamaz;
- yinelemeleri olan bir şablon **başka projeye taşınamaz** — aksi hâlde seri iki
  projeye bölünür ve yeni proje ikinci bir seri üretebilirdi;
- şablon silindiğinde yinelemeler **ayrılır, silinmez**: her yineleme gerçek bir
  görevdir ve kendi ilerlemesini taşır.

### 2.4 Arayüz

Görev detayında **Tekrar** bölümü sıklık, aralık, haftalık günler / ayın günü ve
seri sonu (toplam yineleme veya bitiş tarihi) alanlarını sunar. Kuralın hem
Türkçe özeti hem RFC 5545 karşılığı gösterilir; kullanıcı ne tanımladığını ve
dışa aktarımda ne taşınacağını aynı anda görür. Bunlara ek olarak:

- **kaç yeni görev oluşacağı** açıkça yazılır (yukarıdaki `COUNT` ayrımı),
- **yineleme takvimi** ilk sekiz günü haftanın günüyle birlikte gösterir,
- haftanın günleri serbestçe seçilip **kaldırılabilir**.

"Tekrarları hazırla" düğmesi üretimi taslağa ekler; "Kaydet" yinelemeleri gerçek görev olarak oluşturur.

Görev listesinde seri şablonu **Seri**, üretilen yinelemeler **Tekrar** rozetiyle
işaretlenir.

## 3. Şema göçü

Her iki özellik de `0004_tag_appearance_and_recurrence` göç kimliğiyle
kaydedilir. Eklenen sütunların tamamı `NULL` kabul eder ve varsayılan davranışı
değiştirmez; mevcut kayıtlar için veri dönüşümü gerekmez.

**Mevcut veritabanları için göç betiği ayrıdır.** Temiz kurulum betiği
(`MR_Create_Durable_Persistence.sql`) herhangi bir `MR_*` nesnesi varsa bilerek
durur; dolayısıyla çalışan bir kurulum yeni sütunları ondan alamaz. Uygulama
sürümü dağıtılmadan **önce**
`database/MR_Upgrade_0004_Tag_Appearance_And_Recurrence.sql` çalıştırılır. Betik
yinelenebilirdir: sütun, kısıt ve dizinleri yalnızca yoksa ekler, göç kaydını
yalnızca bir kez yazar.

### Yeni görevde tekrarları oluşturma

Kapsamlı Kipte **Tekrarları hazırla**, yeni veya mevcut görevin tekrar üretim isteğini yerel taslağa ekler. Şablon ve ilk tekrar partisi yalnızca **Kaydet** ile tek kalıcı değişiklik kümesinde yazılır. Önce kaydedip görevi yeniden açmak gerekmez. Başlık, açıklama ve diğer alanlar aynı işlemde yer alır; SQL katmanında bir kayıt reddedilirse tüm küme geri alınır ve taslak açık kalır. Tekrar tıklama aynı kaydı çoğaltmaz.

Yeni ve mevcut şablonlar `src/state/recurringTaskCreation.js` içindeki ortak planlayıcıyı kullanır. İş takvimi, 60 görevlik parti sınırı, değişmez yineleme kimlikleri ve daha önce üretilmiş günlerin tekilleştirilmesi korunur. Sorumluya tanınan dar görev oluşturma yetkisi yapısal tekrar yetkisine dönüşmez.

## Kendi görevinde tekrar yetkisi

Kapsamlı Kipte **Tekrar**, genel yapı yönetiminden ayrı `canManageRecurrence` yeteneğiyle gösterilir. Normal kullanıcı, zaten görev oluşturabildiği projede yalnız kendisine atanmış görev için kural tanımlayabilir ve oluşumları hazırlayabilir. Gizli veya başka bir sorumlusu bulunan görev bu dar haktan yararlanamaz; kimlik denetimi yalnız Sicil üzerinden yapılır. Oluşturma ve üretim SQL işlemi içinde yeniden yetkilendirilir; proje/WBS yönetimi veya başka kişiye atama yetkisi verilmez.

Şablonun yeni kuralı ve oluşumları aynı kayıt isteğindeyse şablon önce yazılır. Oluşumlar geçerli aynı proje, WBS, takvim ve sorumlu kapsamını devralır. Oluşum üretildikten sonra kural kilitlidir; mevcut oluşum sınırı, COUNT, RFC 5545, iş takvimi ve değişmez tekrar günüyle kopya önleme korunur.
