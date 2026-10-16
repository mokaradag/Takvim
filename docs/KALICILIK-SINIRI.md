# Kalıcılığa Hazır Durum ve Veri Sınırı

MERGEN Rota, özellik davranışını kanonik proje yönetimi verisini saklayan mekanizmadan ayırır. Mevcut bağdaştırıcı asenkron ve bellekte değiştirilebilirdir; böylece bu geliştirme adımında yapay HTTP katmanı veya veritabanı eklenmeden, gelecekteki API destekli deponun gerektireceği yükleme, kayıt, hata ve sıralama anlamları uygulamada kullanılabilir.

## 1. Depo sorumluluğu

`AppRepository`, durum katmanının kullandığı kalıcılık sınırıdır. Uygulamaya sunduğu sözleşme bilinçli olarak küçüktür:

```text
loadSnapshot(): Promise<AppDataSnapshot>

commitChanges({
  projectUpserts,
  projectDeletes,
  taskUpserts,
  taskDeletes,
  wbsUpserts,
  wbsDeletes
}): Promise<AppChangeSet>
```

`loadSnapshot()`, saklanan kanonik uygulama verisini döndürür: Takvimler, Projeler, Kişiler, WBS düğümleri, Görevler, `Baseline` ve `TaskBaselineSnapshot` kayıtları.

`commitChanges()` yalnızca o anda değiştirilebilir varlıkların değişikliklerini kalıcı saklar. Tek atomik değişiklik kümesi işlemidir; böylece birden çok varlığı etkileyen görev taşıma ve WBS alt ağacını yeniden kodlama daha sonra tek sunucu/veritabanı işlemine eşlenebilir. Reducer eylem protokolü değildir ve her düzenlemede tüm anlık görüntünün yeniden yazılmasını gerektirmez.

Depo; WBS iş doğrulaması, çalışma alanı seçimi, CPM hesapları veya arayüz durumundan sorumlu değildir.

## 2. Durum katmanının sorumluluğu

Durum katmanı, özelliklere sunulan düzenleme sınırıdır. Şunlardan sorumludur:

- asenkron yükleme/yeniden yükleme düzenlemesi;
- yükleme ve kalıcı kayıt yanıtlarından sonra kanonik görev normalleştirmesi;
- mevcut saf geçişler üzerinden alan doğrulaması;
- değişiklikleri sıralı yürütme;
- sık gelen görev yamalarını birleştirme;
- yükleme, kaydetme ve kalıcı kayıt hatası yaşam döngüsü durumu;
- yeniden yükleme sonrası seçili proje ve görevi uzlaştırma;
- türetilmiş çalışma alanı ve CPM projeksiyonları.

Reducer işlevleri saf kalır. Reducer içinden depo çağrısı yapılmaz.

## 3. Özellik sorumluluğu

Özellikler şu tür odaklı kancaları ve uygulama eylemlerini kullanmayı sürdürür:

```text
useTaskActions()
useWbsActions()
useWorkspace()
```

Bir özellik `repository.commitChanges()`, `fetch()`, API rotası veya SQL istemcisi çağırmaz. Mevcut bellek bağdaştırıcısının API bağdaştırıcısıyla değiştirilmesi özelliklerin yeniden yazılmasını gerektirmemelidir.

## 4. Uygulama açılışı ve asenkron yükleme

Uygulama açılışı tek yükleme yolunu izler:

```text
Uygulama açılışı
    │
    ▼
repository.loadSnapshot()
    │
    ▼
normalleştirme / doğrulama
    │
    ▼
uygulama durumu
    │
    ▼
özellikler
```

Uygulama verisi yaşam döngüsü açıktır:

```text
loading → ready
    │
    └────→ error → retry → loading
```

Yükleme sırasında olağan özellikler boş yer tutucu iş verisiyle çizilmez. Yükleme hatası sade bir uygulama düzeyi hata gösterir; `Yeniden Dene`, olağan yeniden yüklemelerle aynı `reloadData()` yolunu kullanır.

Yüklenen anlık görüntü yerleşik veri/durum sınırında normalleştirilir. Dolayısıyla kaynak mevcut bellek bağdaştırıcısı da olsa gelecekteki dış kaynak da olsa eski görev zamanlama özellikleri, bağımlılıklar, profesyonel zamanlama alanları ve Proje/WBS ilişkileri aynı kanonik kurallardan geçer.

### 4.1 Anlık görüntü ve oturum sırası

`loadApplicationData()` önce anlık görüntüyü, sonra oturum bağlamını okur. **Bu sıra bilinçlidir ve paralelleştirilmemelidir.** Anlık görüntü isteği, yeni kurumsal proje satırları oluşturabilen kurumsal katalog eşitlemesini tetikler. Bu eşitlemeden önce okunan oturum bağlamı, henüz bu projeleri içermeyen erişim listesi bildirirdi.

Gidiş-dönüş maliyeti sıra bozulmadan kaldırılır: Gerçek Sistem anlık görüntü ucu iki okumayı aynı istek içinde yapar ve oturum bağlamını anlık görüntü gövdesine gömülü döndürür. Uç, oturumu **anlık görüntü okumasının zaten ürettiği yetki bağlamından** (`readSnapshotWithAuthorization` → `sessionContextFrom`) kurar; böylece kişi/rol/proje yetkisi ve görev sorumlusu kapsamı sorguları tek istekte iki kez çalışmaz. `createApiRepository.loadSnapshot()`, oturumu ortak bir alana bırakmak yerine **kendi anlık görüntü sonucuyla eşli** döndürür: aksi durumda örtüşen yüklemeler birbirinin oturumunu tüketebilir, A anlık görüntüsünü B için hesaplanan proje erişimiyle birleştirebilirdi. Sonraki oturum okumaları (oturum yenilemesi), diğer çağıranlar için değişmeyen `/api/mergen-rota/session` ucuna gitmeyi sürdürür.

### 4.2 Kurumsal katalog güncelliği

Kurumsal WBS eşitlemesi süreç düzeyindeki güncellik penceresini korur ve eski veriyi sunarken arka planda yenileme davranışı ekler:

- **Süreçte ilk çalıştırma** bekletir. Ağaç henüz `MR_WBS` içinde bulunmayabilir; boş yapı göstermek yanlış olurdu.
- **Sonraki pencere dolumları bekletmez.** İstek saklanan `MR_WBS` verisinden hemen yanıtlanır (en fazla bir TTL eski); yenileme arka planda sürer. Böylece açılış CN43N kaynağının yanıt hızına bağımlı olmaktan çıkar.
- `MERGEN_ROTA_WBS_SYNC_TTL_MS=0`, güncellik penceresini tamamen kapatır; bu kipte her istek eskisi gibi eşzamanlı eşitleme yapar.

Arka plan yenileme hataları günlüğe yazılır, yükleme hatası olarak gösterilmez; eşitleme başarısızsa güncellik penceresi ilerletilmez.

## 5. Uygulama verisi ile arayüz/oturum durumunun ayrımı

Deponun uygulama verisi şunlardan oluşur:

- Takvimler;
- Projeler;
- Kişiler;
- WBS düğümleri;
- Görevler;
- `Baseline` kayıtları;
- TaskBaselineSnapshot kayıtları.

Arayüz/oturum durumu ayrı kalır:

- seçili görev;
- çalışma alanı kipi;
- seçili proje tercihi;
- çalışma alanı tercihinin hazır olma durumu;
- özelliğe yerel süzgeçler ve denetimler.

İş verisini yeniden yüklemek, yerel çalışma alanı tercih servisinin yerine geçmez. Etkin çalışma alanı ve seçili görev, eski nesne başvuruları taşınmak yerine yeni yüklenen varlıklarla uzlaştırılır.

## 6. Veri ve kalıcılık yaşam döngüsü durumu

Uygulama durumu tutarlı yaşam döngüsü kavramları sunar:

```text
dataStatus: loading | ready | error
loadError
pendingMutationCount
saveError
lastSavedAt
```

`isSaving`, `pendingMutationCount > 0` ifadesinden türetilir; bağımsız saklanmaz. Böylece çelişkili yükleme/kaydetme mantıksal değerleri önlenir.

Kabuk sade durum geri bildirimi sunar:

- `Kaydediliyor...`
- `Kaydedildi`
- `Kaydetme hatası`

Kalıcı kayıt hataları WBS/alan doğrulama iletilerinden ayrı kalır.

## 7. Değişiklik yaşam döngüsü ve kötümser kayıt yaklaşımı

MERGEN Rota, kanonik uygulama verisinde belirlenimci kötümser kayıt yaklaşımı kullanır:

```text
Özellik eylemi
    │
    ▼
durum düzenlemesi
    │
    ▼
alan doğrulaması / amaçlanan saf geçiş
    │
    ▼
depo değişikliği
    │
    ▼
yetkili sonuçla durum uzlaştırması
    │
    ▼
türetilmiş seçiciler / CPM
```

Mevcut normalleştirme ve iş kurallarını yeniden kullanmak için önce amaçlanan saf reducer geçişi hesaplanır. Doğrulama başarısızsa alan hatası gösterilir ve depo çağrısı yapılmaz.

Doğrulama başarılıysa durum katmanı en küçük Görev/WBS değişiklik kümesini türetir, saklar ve ancak sonra deponun döndürdüğü kanonik varlıkları uygulama durumuna uygular. Dolayısıyla başarısız kayıt, kanonik veriyi iyimser biçimde silmez veya yapısal olarak taşımaz; geri alma protokolü gerektirmez.

Durum eylemleri açık bir sonuç sözleşmesiyle tamamlanır:

```text
{ ok: true, value }

veya

{ ok: false, error }
```

Kalıcı kayıt hataları düzenleme katmanında yakalanır; eylemi beklemeyen özellik çağrı noktaları işlenmemiş Promise retleri üretmez.

## 8. Değişiklik sıralama anlamı

Bütün kalıcı değişiklikler tek sıralı uygulama değişiklik kuyruğundan geçer.

Önceki değişiklik sonuçlanmadan sonraki depoya gönderilmez. Bilinçli olarak basit tutulan bu kural şunları güvence altına alır:

- eski görev yanıtı daha yeni düzenlemeyi ezemez;
- yapısal işlemler sıra dışında tamamlanamaz;
- güncelleme/silme yarışları belirlenimcidir;
- gerçek ağ gecikmeli gelecekteki bağdaştırıcı aynı uygulama değişiklik sırasını görür.

Kuyruk kalıcı kayıt etkilerini sıralar; görev açma veya çalışma alanı değiştirme gibi olağan arayüz eylemlerini değil.

## 9. Sık görev düzenlemeleri

Görev Ayrıntısı, yazmanın akıcı kalması için anlık yerel taslak davranışını korur. Kalıcılık sınırı her klavye karakteri için ayrı yazmayı önler.

Uyumlu görev alanı yamaları, görev başına kısa bir 250 ms pencerede birleştirilir. Aynı düzenleme serisindeki başlık, açıklama, ilerleme, durum, öncelik ve tarih değişiklikleri tek kanonik yamada birleşir ve aynı sıralı kuyruktan saklanır. Yapısal işlemler de sırayı korur: yıkıcı işlem, görev WBS taşıması veya uygulama yeniden yüklemesi ilerlemeden önce etkilenen görevin bekleyen yaması gönderilir. Bekleyen kayıt başarısızsa bağımlı işlem hatalı yazmanın üzerinden sessizce devam etmez.

Görev ayrıntı panelini kapatmak bu gönderimi hemen ister ve aynı sürmekte olan Promise'i bekler; önce geciktirme zamanlayıcısını bekleyip sonra ikinci gönderim yapmaz. Kapat düğmesi işlem bitene kadar etkin `Kaydediliyor…` durumu sunar. Başarısız yamalar yeniden denenebilir kalır ve sessizce atılmaz.

SQL kayıt yanıtı, yazma işlemi açıkken yetki süzgeçli portföy anlık görüntüsünün tamamını yeniden kurmak yerine yalnızca değişikliğin dokunduğu yetkili satırları (ve gerekli görünür sorumlu/bağımlılıklarını) yeniden kurar. İyimser rowversion denetimleri, yetkilendirme ve bütünlük doğrulaması işlem içinde kalır; tarayıcının mevcut 30 saniyelik istek zaman aşımı değişmez.

Böylece Görev Ayrıntısı açık Kaydet düğmesi etrafında yeniden tasarlanmadan gelecekteki API için güvenli kayıt sınırı sağlanır.

### 9.1 Birleştirilmiş düzenleme kaybı sessiz olmamalıdır

Birleştirme penceresini iki koruma gözetir:

- **Sekme kapatma / gizleme.** `UnsavedChangesGuard`, `visibilitychange` ve `pagehide` sırasında bekleyen kuyruğu gönderir; yazma bekliyor veya sürüyorsa `beforeunload` sırasında tarayıcının kendi onayını açar. Önceden sekme kapanmadan 250 ms'den kısa süre önce yapılan düzenleme sunucuya hiç ulaşmıyor, “Kaydedildi” göstergesi de çıkmadığından kayıp görünmüyordu. Son gönderim `keepalive` ile yapılır; çünkü sayfa boşaltılırken başlatılan olağan `fetch` tarayıcıca iptal edilebilir. “Sürüyor” bilgisi `pendingMutationCount` üzerinden okunur: birleştirici isteği beklemeden *önce* yamayı kuyruktan çıkarır; yalnızca kuyruk denetimi başlamış yazmayı korumasız bırakırdı.
- **Geçersiz değerler kuyruğa girmez.** Boş görev başlığı zamanlanmadan önce çekmecede reddedilir. Sunucu boş başlığı `TASK_TITLE_REQUIRED` ile reddeder; birleştirme alanları bir araya getirdiğinden bu ret toplu ilerleme ve tarih düzenlemelerini de başarısız kılıyordu. Alanı temizlemek **kuyruktaki başlık yamasını da iptal eder**: `ABC → AB → A → boş` sonrasında kuyrukta `A` kalıyor, arayüz kaydedilmeyeceğini söylese de gecikme (veya çekmece kapatma) bunu saklıyordu.

### 9.1.1 Yeniden kurulan sağlayıcı kapalı kuyruğu korumamalıdır

`dispose()`, bekleyen yamaları reddeder ve birleştiriciyi kapatır; kapatılan kuyruk daha sonraki her `schedule()` çağrısını sessizce reddeder. React 18 `StrictMode`, geliştirmede etkileri bir kez kurar, kaldırır ve yeniden kurar; kuyruk ise `useMemo` ile üretildiğinden benzetilmiş kaldırmadan sonra yaşar. Bu nedenle sağlayıcı **kapalı** kuyruğu yeniden kullanıyordu: `npm run dev` altında hiçbir görev düzenlemesi depoya ulaşmıyor, iyimser reducer eylemi çalışmıyor (durum eylemi `persistAction` içinde gönderilir), kullanıcı kayıt veya hata görmüyordu. `AppStateProvider` artık etki kurulurken `persistence.revive()`, temizlenirken `dispose()` çağırır. Üretim derlemesinde etki bir kez çalışır; yeni kuyrukta `revive()` etkisizdir.

### 9.2 Başarısız yazma görev panelini kilitlemez

Görev panelini kapatma bekleyen yazmaları gönderir; kapatmanın kendisi ise **koşulsuzdur**. Önceden hem `closeTask()` hem üst katmanın `onClose` işlevi seçimi temizlemeden başarısız gönderim sonucunu döndürüyor, sunucunun reddettiği alan paneli çalışmayan kapat düğmesiyle açık bırakıyordu; uygulama donmuş görünüyordu. Hata yine bildirilir: kalıcılık durum şeridinde iletisi, kodu ve alan yoluyla kalır.

Kapatma düzenlemeyi de atmaz. Reddedilen yama birleştiricide **korunur**: bekleyen kuyruğa yeniden konmaz (kalıcı olarak reddedilen yama her gönderimde döngü oluştururdu), ancak kaydedilmemiş değişiklik sayılır, aynı görevin sonraki düzenlemesinin altına birleştirilir ve durum şeridi `Yeniden dene` sunar. Bu koruma olmadan düzenlemenin tek kopyası çekmece taslağında kalıyor, panel kaldırılınca yok oluyordu. Açık vazgeçme işlemi `Verileri yeniden yükle` seçeneğidir: yetkili sunucu durumunu istediğinden korunan yama da atılır.

Birleştirme `schedule()` işlevinin **iki** dalında da yapılır. Önceden yalnızca görevin bekleyen girdisi yokken çalışıyordu; kuyruk girdisi zaten varsa korunan alanlar birleştirilmeden siliniyordu. Bu sıra mümkündür: gönderim başlar ve sunucuyu bekler, kullanıcı yeniden yazar (`failed` hâlâ boşken bekleyen girdi oluşur), beklenen gönderim reddedilip korunan alanları yazar, sonraki tuş bunları düşürürdü.

### 9.3 Yanıtsız sunucu paneli dondurmamalıdır

Gerçek Sistem deposunun her isteği **30 saniyelik süre sınırı** taşır (`REQUEST_TIMEOUT_MS`). Sunucu bağlantıyı kabul edip yanıt vermediğinde sınırsız `fetch` sonuçlanmaz. Sıralı değişiklik kuyruğu dönen Promise'i beklediğinden tek takılmış istek sekmenin ömrü boyunca sonraki bütün değişiklikleri engelliyor, `whenIdle()` tamamlanmıyor ve kapatmadan önce bekleyen yazmaları bekleyen Görev panelinin `Kaydet` düğmesi de takılıyordu. İptal edilen istek, ayırt edici “zamanında yanıt vermedi” iletisiyle `DATABASE_UNAVAILABLE` olarak bildirilir.

Kapsamlı Kip görev oluşturmanın ayrı bir kayıt öncesi aşaması vardır. `beginTaskDraft`, yerel görev oluşturup normalleştirir; değişiklik kuyruğuna girmez ve kanonik duruma eklemez. Alan değişiklikleri yalnızca `taskCreationDraft` günceller; `saveTaskDraft`, taslağın kararlı istemci kimliğiyle ilk `task/create` değişikliğini yapar. İptal veya çekmece kapatma taslağı temizler; **Yeni Görev** açmak hiçbir zaman boş kalıcı satır bırakamaz.

Son sayfa boşaltma gönderimi `keepalive` kullanmayı sürdürür; süre sınırından muaftır (iptal etmek amacını bozar). Ancak Fetch standardı `keepalive` gövdesini 64 KiB ile sınırlar. Bu sınırı aşan değişiklik kümesi, yanıltıcı “sunucuya ulaşılamıyor” iletisiyle doğrudan reddedilmek yerine olağan isteğe döner.

**Bu yedek yol daha iyi hata sağlar; teslim güvencesi vermez.** Sayfa boşaltılırken başlayan olağan `fetch`, belgeyle birlikte iptal edilebilir; büyük değişiklik kümesi yine kaybolabilir. Gerçek koruma, sayfa boşaltılmadan *önce* göndermektir: `UnsavedChangesGuard`, yazmalar sürerken uyarır; birleştirici reddedilen yamayı `failed` içinde tutar, böylece düzenleme son isteğe bağımlı kalmak yerine sekmede korunur. Sayfa boşaltma gönderimini yalnızca küçük değişiklik kümeleri için eldeki olanaklarla yapılan son deneme kabul edin; daha büyükleri sayfa hâlâ açıkken kaydedilmelidir.

## 10. Atomik yapısal işlemler

Tek `commitChanges()` çağrısı, bir uygulama komutunun ürettiği bütün değişikliklerin işlem sınırıdır.

### Toplu görev WBS taşıma

Mevcut alan katmanı önce görev seçiminin tamamını doğrular. Başarılı taşıma, değişen bütün görev atamalarını tek kümede saklar. Hata, ne kalıcı depo durumunu ne kanonik uygulama durumunu değiştirir.

### WBS alt ağacının üst düğümünü değiştirme

Mevcut alan/durum mantığı, alt düğüm kodlarının belirlenimci yeniden öneklenmesi dahil geçerli sonucun tamamını hesaplar. Değişen bütün WBS düğümleri sonra tek değişiklik kümesinde gönderilir.

Kararlı WBS kimlikleri değişmez. Görevler aynı WBS kimliklerine başvurmaya devam ettiğinden atamalar değişmez. Baz planlar değişmez.

Bellek bağdaştırıcısı değişiklik kümesini klonlanmış aday anlık görüntüye uygular, iç anlık görüntüsünü ancak bütün işlem başarılıysa değiştirir. Böylece gelecekteki veritabanı işleminden beklenen ya hep ya hiç davranışını modeller.

## 11. Hata işleme

Depo/veri hataları küçük, normalleştirilmiş sözleşme kullanır:

```text
code
message
operation
details
```

Mevcut depo hata kodları bilinçli olarak şunlarla sınırlıdır:

- `LOAD_FAILED`;
- `MUTATION_FAILED`.

Bu yapı, şimdi kullanılmayan davranışlar icat etmeden çakışma gibi gelecekteki API'ye özgü hatalara yer bırakır.

Ham fırlatılan değerler uygulama durumuna girmeden normalleştirilir. Olağan arayüz, uygulama ayrıntıları yerine genel ve güvenli iletiler gösterir.

Alan hataları ve kalıcı kayıt hataları ayrı kavramlardır:

```text
WBS_HAS_CHILDREN              → alan doğrulaması
WBS_REPARENT_TO_DESCENDANT    → alan doğrulaması
MUTATION_FAILED               → kalıcı kayıt hatası
LOAD_FAILED                   → veri yükleme hatası
```

`wbsActionError`, WBS/alan hatası kanalı olarak kalır; depo hatalarında yeniden kullanılmaz.

## 11.1 Gerçek Sistem kimliğinin kanonikleştirilmesi

Gerçek Sistem kimlikleri SQL Server `uniqueidentifier` değerleridir. İki kuralın sahibi `src/domain/identity/actualId.js` olup her katman bunları kullanır (istemci deposu, kayıt doğrulaması, SQL depoları, yetkilendirme):

1. **Her geçerli GUID kabul edilir.** Kurumsal kaynaklar `D5D70AEC-0A88-F111-9136-00505699BACD` gibi GUID ürettiğinden RFC 4122 sürüm ve varyant bitleri zorlanmaz. Sürümle sınırlı desen her kurumsal projeyi, WBS düğümünü ve görevi `ACTUAL_ID_INVALID` ile reddediyordu.
2. **Kanonik biçim küçük harftir.** SQL Server kimlikleri büyük harfli metin olarak döndürürken istemci küçük harf gönderir; bu nedenle sunucudaki ham `!==` karşılaştırmaları aynı satırı farklı sayıyordu. Anlık görüntüler kanonik kimlik üretir; sunucu karşılaştırmaları `sameActualId()` kullanır.

İstemcinin ürettiği kimlikler yerelde `task-`/`wbs-`/`project-` önekini korur; API deposu aktarım için GUID'i çıkarıp kanonikleştirir, dönüşte takma ad haritasından önekli biçimi geri kurar.

## 12. Yeniden yükleme ve uzlaştırma

`reloadData()` tek uygulama yeniden yükleme mekanizmasıdır; ilk yükleme tekrarında da kullanılır.

Yeniden yüklemeden önce bekleyen görev yamaları gönderilir ve sıralı değişiklik kuyruğunun sonuçlanması beklenir. Ardından depo anlık görüntüsü yüklenir ve normalleştirilir.

Gerçek Sistem'de aynı mekanizma görünür sekmede otomatik olarak da çağrılır. Dağıtım aralığı `NEXT_PUBLIC_MERGEN_ROTA_AUTO_REFRESH_INTERVAL_MS` ile belirlenir (varsayılan `60000`, alt sınır `30000` milisaniye; geçersiz değer varsayılana döner). Kendini zamanlayan tek-uçuşlu denetleyici sekme gizlenince zamanlayıcıyı kaldırır; görünür olduğunda son başarılı anlık görüntü aralık kadar eskiyse hemen, değilse kalan süre sonunda çalışır. Demo deposu için denetleyici kurulmaz.

Otomatik çağrı `discardFailedTaskUpdates` seçeneğini hiçbir zaman kullanmaz. Bekleyen yazmalar normal sırayla tamamlanır; reddedilmiş yerel görev yaması varsa güvenlik denetimi anlık görüntü yükünü atlar ve sonraki aralıkta yeniden değerlendirir. Atlanan ya da başarısız deneme tam aralık beklemeden tekrar edilmez. Geçici arka plan yükleme hatası mevcut başarılı anlık görüntüyü hata durumuna çevirmez; `SESSION_REQUIRED`, `UNAUTHORIZED` ve `FORBIDDEN` ise mevcut kimlik/yetki davranışına aktarılır. Manuel yenileme aynı giriş noktasında kalır ve ortak etkin-yük denetimi iki yenilemenin yarışmasını engeller. Otomatik yük sürerken gelen manuel istek onun sessiz arka plan sonucunu paylaşmaz; otomatik turun arkasına tek kez alınır ve kendi görünür yükleme/hata yaşam döngüsünü çalıştırır.

Manuel yeniden yükleme uygulama kabuğunu **kaldırmaz**. `dataStatus`, `loading` olur; ancak ilk başarılı yüklemeden sonra `hasLoadedOnce` true kalır. Bu nedenle `AppDataBoundary` kabuğu kurulu tutar, engelleyici ekranı yalnızca ilk yüklemede gösterir. Veri varsa otomatik yükleme görünür yükleme durumunu hiç açmaz. Bu kurallardan önce her kayıt sonrası yenileme `AppShell` öğesini yeniden kuruyor, görünüm durumunu atıyor ve uygulama yeni başlamış gibi karşılama ekranını yeniden gösteriyordu. Veri zaten varken başarısız manuel yenileme, uygulamanın yerine geçmek yerine kalıcılık durum alanında bildirilir.

Yeniden yüklemeden sonra:

- geçersiz seçili proje güvenle Portföy çalışma alanına döner;
- artık var olmayan seçili görev temizlenir;
- etkin proje çalışma alanına artık ait olmayan seçili görev temizlenir;
- Görev/WBS ilişkileri kanonik sınırdan normalleştirilir;
- proje kapsamlı CPM projeksiyonu yeni kanonik Görev, Proje ve Takvimlerden yeniden türetilir.

Yeniden yüklemeler arasında eski varlık nesnesi başvuruları tutulmaz.

## 13. Asenkron bellek bağdaştırıcısının anlamı

`createMockRepository()` artık asenkron, değiştirilebilir bellek bağdaştırıcısıdır. Şunları yapar:

- mevcut deneme başlangıç verisinden veya verilen test verisinden başlar;
- başlangıç girdisinin derin kopyasını alır;
- yüklenen anlık görüntüleri ve değişiklik sonuçlarını derin kopyalar;
- başarılı Görev/WBS değişikliklerini depo örneğinin ömrü boyunca saklar;
- sonraki `loadSnapshot()` çağrılarında güncel saklanan veriyi döndürür;
- birden çok varlığın değişiklik kümesini atomik uygular;
- yalnızca test için gecikme, yükleme hatası ve sıradaki değişikliğin başarısızlığı davranışını destekler.

Olağan uygulama kullanımında yapay gecikme açık değildir.

Başarılı değişiklik **aynı etkin depo örneğinde uygulama düzeyi depo yeniden yüklemesinden sonra korunur**.

Yeni depo örneği oluşturulması, tarayıcı yenilemesi, süreç veya sanal makine yeniden başlatmasından sonra **korunmaz**. Bağdaştırıcı kalıcı üretim deposu değil, kalıcılık sözleşmesi benzeticisidir.

`localStorage` veya IndexedDB iş verisi veritabanı eklenmez.

## 14. Çalışma alanı tercihinin ayrılması

`workspaceMode` ve son `selectedProjectId`, mevcut yerel arayüz tercih anahtarı altında kalır:

```text
mergen-rota.workspace.v1
```

Bu tercih `AppRepository` tarafından okunmaz veya yazılmaz. Saklanan proje kimliğinin güncel proje koleksiyonuyla doğrulanabilmesi için yalnızca iş verisi yüklendikten sonra geri yüklenir.

Gelecekteki kullanıcı tercih servisi, bu yerel mekanizmayı proje yönetimi verisi kalıcılığından bağımsız değiştirebilir.

## 15. Hiçbir zaman kalıcı saklanmayan türetilmiş veriler

Depo, belirlenimci projeksiyonları değil kanonik proje yönetimi olgularını saklar.

Kalıcılık sınırı şunları kaydetmez:

- CPM Erken Başlangıç / Erken Bitiş;
- CPM Geç Başlangıç / Geç Bitiş;
- Toplam Bolluk / Serbest Bolluk;
- kritiklik veya kritik yollar;
- hesaplanan proje bitişi;
- WBS özet tarih aralıkları;
- WBS ilerleme özetleri;
- WBS kritik görev sayıları;
- çalışma alanı görev alt kümeleri;
- Özet toplamları.

Bu değerler seçiciler ve saf zamanlama katmanı üzerinden kanonik durumdan türetilmeyi sürdürür.

`Baseline` ve `TaskBaselineSnapshot` kayıtları depodan yüklenir; mevcut arayüz işlemlerinde salt okunur kalır. Olağan Görev/WBS değişiklikleri bunları yeniden yazmaz.

## 16. Gelecekteki API ve SQL Server yolu

Amaçlanan kalıcı veri saklama yönü şöyledir:

```text
Tarayıcı / MERGEN Rota Arayüzü
        │
        ▼
İstemci tarafı API depo bağdaştırıcısı
        │
        ▼
Next.js sunucu rotası/servisi
        │
        ▼
Sunucu tarafı SQL deposu/servisi
        │
        ▼
SQL Server
```

Tarayıcı SQL Server'a hiçbir zaman doğrudan bağlanmamalıdır.

Gelecekteki istemci API bağdaştırıcısı aynı uygulamaya açık `loadSnapshot()` ve `commitChanges()` anlamlarını uygulamalıdır. Sunucu servisi, özellik bileşenlerini değiştirmeden atomik değişiklik kümelerini veritabanı işlemlerine dönüştürebilir ve yetkili kanonik varlıkları döndürebilir.

## 17. Mevcut kapsam dışı konular

Bu kalıcılık sınırı geliştirme adımı şunları uygulamaz:

- SQL Server veya başka veritabanı;
- veritabanı geçişleri veya bağlantı dizeleri;
- Prisma, Sequelize, TypeORM veya başka ORM;
- yapay REST uçları veya yerel HTTP gidiş-dönüşleri;
- kimlik doğrulama veya yetkilendirme;
- denetim günlüğü;
- baz plan yakalama/yeniden baz plan CRUD işlemleri;
- tarayıcı yenilemesinde kalıcı veri koruma;
- çakışma çözüm arayüzü;
- ilerlemeyi dikkate alan CPM veya Veri Tarihine göre yeniden zamanlama.

Sonraki kalıcılık adımı gerçek API/sunucu tarafı kalıcılık uygulamasıdır. İlerlemeye duyarlı zamanlama ayrı bir geliştirme hattı olarak kalır.
