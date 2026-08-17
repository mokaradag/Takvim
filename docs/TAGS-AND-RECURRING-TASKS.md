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
Basit Mod'un hızlı giriş akışında etiketler metin olarak geldiği için bu
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

`prepareProjectUpdateChanges` bu eşlemeyi kullanarak eski adı taşıyan
görevlerin `keyword` alanını yeni ada taşır. Eşleme gönderilmezse ad değişikliği
yalnızca katalogda kalır ve görevler katalog dışında kalırdı — bu yüzden
yeniden adlandırma arayüzü eşlemeyi biriktirmek zorundadır.

Aynı etiket birden çok kez yeniden adlandırıldığında zincir tek bir
eski→son ad eşlemesine sadeleştirilir.

### 1.3 Kalıcılaştırma

`dbo.MR_ProjectTags` iki yeni sütun taşır:

```sql
ColorToken varchar(20) NULL,
IconKey    varchar(40) NULL,
```

`NULL` değerler geçerlidir: arayüz o etiket için ada göre türetilen varsayılana
düşer. Böylece bu sürümden önce yazılmış satırlar geçerli kalır ve veri göçü
gerektirmez.

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

`COUNT` ve `UNTIL` birlikte verilirse RFC 5545 gereği kural geçersizdir;
normalleştirme `COUNT`'u önceler ve `UNTIL`'i düşürür.

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

- şablonun **süresi** korunur (her yineleme aynı uzunlukta planlanır);
- hedef bitiş uzaklığı korunur;
- çalışma takvimi verildiğinde tatil ve hafta sonuna denk gelen yineleme bir
  sonraki iş gününe kaydırılır, kaydırma iki yinelemeyi aynı güne düşürürse
  ikincisi üretilmez;
- şablonun **bağımlılıkları kopyalanmaz** — aksi hâlde aynı öncül onlarca kez
  tekrarlanır ve CPM ağı bozulurdu;
- daha önce üretilmiş bir başlangıç günü yeniden üretilmez, bu yüzden düğmeye
  ikinci kez basmak kopya görev oluşturmaz, yalnızca eksik günleri tamamlar.

Ayın 31'i olmayan aylarda yineleme ayın son gününe çekilir. RFC 5545 o ayı
atlamayı öngörür; planlamada bir yinelemeyi kaybetmemek daha yararlıdır ve
kullanıcı beklentisine uyar.

Sonsuz kurallar `MAX_RECURRENCE_OCCURRENCES` (400) ile sınırlıdır.

### 2.3 Kalıcılaştırma

`dbo.MR_Tasks`:

```sql
RecurrenceRule         nvarchar(400) NULL,
RecurrenceParentTaskId uniqueidentifier NULL,
```

Kural yazılmadan önce `formatRecurrenceRule` ile kanonikleştirilir: ayrıştırılamayan
bir metin kalıcı kayda düşmez. Sunucu doğrulaması geçersiz kuralı
`TASK_RECURRENCE_INVALID` ile reddeder.

### 2.4 Arayüz

Görev detayında **Tekrar** bölümü sıklık, aralık, haftalık günler / ayın günü ve
seri sonu (yineleme sayısı veya bitiş tarihi) alanlarını sunar. Kuralın hem
Türkçe özeti hem RFC 5545 karşılığı gösterilir; kullanıcı ne tanımladığını ve
dışa aktarımda ne taşınacağını aynı anda görür. "Tekrarları oluştur" düğmesi
yinelemeleri gerçek görev olarak üretir.

Görev listesinde seri şablonu **Seri**, üretilen yinelemeler **Tekrar** rozetiyle
işaretlenir.

## 3. Şema göçü

Her iki özellik de `0004_tag_appearance_and_recurrence` göç kimliğiyle
kaydedilir. Eklenen sütunların tamamı `NULL` kabul eder ve varsayılan davranışı
değiştirmez; mevcut kayıtlar için veri dönüşümü gerekmez.
