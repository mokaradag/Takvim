# MERGEN Rota Mimarisi

MERGEN Rota, özellik arayüzünün genel veri kümesini sahiplenmeyeceği ve verinin mevcut asenkron bellek bağdaştırıcısından, gelecekteki API'den veya SQL destekli sunucu servisinden gelmesine bağımlı olmayacağı biçimde düzenlenmiştir.

## Bağımlılık yönü

Amaçlanan yön şöyledir:

`domain <- scheduling <- data <- state <- features <- app/shell`

Ortak görsel bileşenleri özellikler kullanır; ancak bu bileşenler uygulama durumunu veya deneme başlangıç verisini içe aktarmaz.

## Katmanlar

### `src/domain`

React ve tarayıcıdan bağımsız iş kavramları ve veri yapısı kuralları. `models`, `Project`, `Task`/`Activity`, `Dependency`, `Person`, `WBS`, `Baseline` ve `TaskBaselineSnapshot` yapılarını JSDoc ile belgeler.

Kanonik görev zamanlama verisi `plannedStart`, `plannedFinish`, `plannedDurationDays`, `targetFinish`, `actualStart`, `actualFinish` ve `remainingDurationDays` kullanır. Proje durum kesim tarihi `Project.dataDate` ile temsil edilir. CPM sonuçları ayrı türetilmiş `CpmTaskResult` verisi olarak belgelenir; kanonik görev durumunun parçası değildir.

Kararlı ilişkiler `projectId`, `assigneeIds`, `predecessorId`, `wbsId`, `baselineId`, `taskId` gibi kimlikler kullanır. Mevcut deneme bağdaştırıcısı, arayüzün kullandığı yerlerde `proje` ve `sorumlu` gibi zamanlama dışı eski görüntüleme alanlarını korur.

WBS ayrı yapısal alan varlığıdır. Ortak saf seçiciler; hiyerarşi kurma, belirlenimci sıralama, alt/üst düğümler, yollar, düzleştirme ve görev alt ağacı özetlerinden sorumludur. Alan doğrulaması yinelenen kimlik, eksik üst düğüm, kendi üstü olma, projeler arası üst düğüm ve döngü kurallarını yönetir. Görevin `wbsId` değeri varsa aynı `projectId` projesine ait WBS düğümüne çözülmelidir. WBS düğümü yapısının uygulamada mı oluşturulduğunu (`source: 'manual'`), kurumsal CN43N kaynağından mı yansıtıldığını (`source: 'corporate'`, salt okunur) da kaydeder.

`identity/actualId.js`, her katmanın Gerçek Sistem kimlik kurallarını yönetir: hangi dizelerin geçerli SQL Server `uniqueidentifier` olduğu (RFC 4122 sürüm/varyant kısıtı olmadan her GUID) ve kanonik küçük harfli karşılaştırma biçimi. İstemci, sunucu ve doğrulama katmanları kendilerine özel UUID desenleri tanımlamamalıdır.

`projectTypes.js` ayrıca yazma ilkelerinin ve WBS arayüzünün kullandığı kurumsal/manuel proje ayrımını (`isCorporateProject`, `supportsManualWbsEditing`) yönetir.

`tags/index.js`, proje etiket kataloğunu yönetir: kanonik `{ name, color, icon }` yapısı, kapalı renk/simge anahtarı kümeleri, belirlenimci varsayılan renk türetimi ve Türkçe harf duyarsız tekilleştirme. İstemci formları ve sunucu kayıt doğrulaması özel kopyalar tanımlamak yerine bu listeleri kullanmalıdır.

`constants/index.js`, görev durum ve öncelik kataloglarını yönetir. Öncelikte kanonikleştirme kuralları da vardır: `normalizePriorityId`, bilinmeyen/eski değerleri (özellikle saklanan `normal`) katalog tanımlayıcısına eşler; `resolvePriority` her zaman tanım döndürür. Görünümler `PRIORITIES` dizinlemesini doğrudan yapmak yerine bunları kullanmalıdır; eksik girdi önceden `undefined.color` üretiyor ve istemci çizim ağacının tamamını çökertiyordu.

WBS özetleri iki yapıdadır: tek düğüm için `selectWbsTaskRollup`, tek geçişte bütün düğümler için `selectWbsRollupIndex`. Çok satır çizen her yer dizini kullanır; tek düğüm seçicisini satır başına çağırmak düğüm sayısına göre kareseldir.

`assignment/assignmentCoordination.js`, `notifications/notificationInbox.js`, `notifications/taskAssignmentMail.js` ve `presence/`, yeni işbirliği kurallarını saf modüller olarak yönetir. İlki koordinasyon durum/kip kataloglarını, karar matrisini (`allowedCoordinationDecisions`) ve sorumlunun işlemi yapanın kurumu dışında olup olmadığını belirleyen kurum yolu karşılaştırmasını tutar. İkincisi zil gelen kutusu birleşimini yönetir: tarih talepleri ve görev olayları için tek sıra, tek önizleme sınırı ve tek sayaç türetimi; zil ikinci, farklı sıralama geliştiremez. Üçüncüsü isteğe bağlı atama e-postasını hatırlatma şablonlarıyla aynı HTML kaçışıyla üretir. `presence/presenceModel.js`, nabız aralığını, *etkin* pencereyi ve liste sınırını; `presence/presenceLeader.js`, sekmeler arası kilit hesabını yönetir. Saf tutulmaları, tüm karar yüzeyinin (kim onaylayabilir, eski kayıt nedir, hangi sekme nabız gönderir) veritabanı, saat veya tarayıcı olmadan test edilmesini sağlar.

`reminders/`, hiçbir G/Ç yapmadan görev hatırlatma kurallarını yönetir. `reminderTemplate.js`; yer tutucu kataloğunu, izin listeli HTML temizleyicisini, HTML kaçışlı yer tutucu yerleştirmesini, düz metin türetimini ve varsayılan Türkçe konu/gövdeyi tutar. `reminderPolicy.js` otomatik ilkeyi tutar: ayar normalleştirmesi, kalan süre açıklaması, pencere/sıklık değerlendirmesi ve yinelenen gönderimi önleyen belirlenimci *zaman dilimi anahtarı*. `reminderRecipients.js` ile `emailAddress.js` adres doğrulama, normalleştirme ve tekilleştirmeyi; `reminderValues.js` görevin yer tutucu değerlerine eşlenmesini yönetir. Modüller saf olduğundan tüm hatırlatma karar yüzeyi saat, veritabanı veya SMTP sunucusu olmadan test edilir.

### `src/scheduling`

Saf zamanlama mantığı. `dates` ayrıştırma, biçimlendirme ve tarih aralığı yardımcılarını; `calendars` tatil/iş günü kurallarını; `dependencies` FS/SS/FF/SF üst verisini ve normalleştirmeyi; `plans` kanonik güncel plan süre normalleştirmesini; `metrics` Gantt ve görev durum özetlerinin zamanlamadan türetilen hesaplarını; `cpm` takvime duyarlı kritik yol motorunu, ileri/geri geçişleri, erken/geç tarihleri, bolluğu ve kritik yolları yönetir. Zamanlama React ve uygulama durumundan bağımsız kalır.

`recurrence`, tekrarlayan görev kurallarını RFC 5545 (iCalendar) `RRULE` alt kümesi olarak yönetir: normalleştirme, `RRULE` metninin gidiş-dönüş dönüşümü, Türkçe açıklama, takvime duyarlı somut tarih açılımı ve oluşum planlaması. Saf tarih hesabıdır; uygulama durumu taşımaz. Kural metni alışveriş biçimi olduğundan dışa aktarılan plan diğer takvim sistemlerince okunabilir kalır.

WBS bağımsız zamanlama ağları oluşturmaz. CPM proje kapsamlı kalır. WBS özet tarihleri ve çubukları alt görevlerin güncel plan değerlerinden türetilir; CPM çıktısının yerine geçmez.

### `src/data`

Veri erişimi ve kalıcılık sınırı. `contracts/appRepository.js`, asenkron depo sözleşmesini belgeler:

```text
loadSnapshot(): Promise<AppDataSnapshot>
commitChanges(changeSet): Promise<AppChangeSet>
```

Anlık görüntü; takvimler, projeler, kişiler, WBS, kanonik görevler, baz planlar ve görev baz plan anlık görüntülerini içerir. Değişiklik kümesi `projectUpserts`, `projectDeletes`, `taskUpserts`, `taskDeletes`, `wbsUpserts` ve `wbsDeletes` alanlarını içerir; birden çok varlık işlemine tek atomik sınır sağlar.

`mock/createMockRepository.js` mevcut asenkron değiştirilebilir bellek bağdaştırıcısı, `mock/seed.js` örnek veri kümesidir. Başarılı değişiklikler depo örneğinin ömrü boyunca sonraki `loadSnapshot()` çağrılarında erişilebilir kalır. Yeni depo örneği verilen başlangıç verisiyle başlar; tarayıcı/süreç/sanal makine yeniden başlatmasında kalıcılık sağlanmaz.

Bağdaştırıcı dış girdi/çıktıları derin kopyalar; yalnızca test için odaklı gecikme/yükleme/değişiklik hatası yapılandırması destekler. Eski zamanlama özellik adlarını, kayıt kanonik görev olmadan önce yalnızca özel geçiş bağdaştırıcısı kabul eder. Bu çalışmada veritabanı veya yapay HTTP API uygulanmaz.

Deneme bağdaştırıcısı anlamlı çok düzeyli WBS hiyerarşileri ve geçerli Görev-WBS ilişkileri sağlar. Proje kapsamlı CPM'i doğrulayan bilinçli projeler arası bağımlılık veri senaryosunda kalır.

Gelecekteki tarayıcı API depo bağdaştırıcısı aynı uygulamaya açık sözleşmeyi uygulamalı ve `AppStateProvider` içine verilmelidir. Arka kaynak değişince özellik modülleri değişmemelidir.

### `src/state`

`AppStateProvider`, React uygulama durumunu yönetir ve özelliklere odaklı eylemler oluşturur. Saf durum başlatma, kanonik anlık görüntü normalleştirmesi ve reducer geçişleri `src/state/appState.js` içindedir. Asenkron kalıcılık düzenlemesi reducer dışında `src/state/persistence.js`; ortak ilk/manuel/otomatik yeniden yükleme yolu `src/state/dataReloadLifecycle.js` içindedir.

Uygulama verisi yaşam döngüsü `dataStatus: loading | ready | error`, `loadError`, `pendingMutationCount`, `saveError`, `lastSavedAt` ile açıktır. İlk yükleme, manuel yenileme ve görünürlüğe duyarlı otomatik yenileme aynı `reloadData()` → `repository.loadSnapshot()` yolunu kullanır. Otomatik denetleyici yalnızca Gerçek Sistem deposu için kurulur, belge gizliyken duraklar, örtüşen istek olmadan kendini zamanlar ve sağlayıcı etkisiyle temizlenir. Otomatik yenileme, geçici arka plan hatalarında yüklenmiş kabuğu etkileşimli ve sessiz tutar; oturum/kimlik doğrulama hataları yerleşik veri hatası akışına girer. Kabuk eksik ilk veriyle olağan özellikleri çizmez; yükleme hatasında yeniden deneme sunar.

Mevcut Görev/WBS değişiklikleri kanonik durumda kötümser yaklaşım kullanır: durum katmanı amaçlanan saf geçişi hesaplayıp doğrular, en küçük değişiklik kümesini türetir, saklar, sonra durumu deponun döndürdüğü yetkili varlıklarla uzlaştırır. Kayıt hatası iyimser geri alma gerektirmez.

Bütün depo değişiklikleri tek sıralı kuyruktan geçer; gecikmiş yanıtlar yeni düzenlemeyi ezemez, yapısal işlemler sıra dışında tamamlanamaz. Sık Görev Ayrıntısı yamaları kayıttan önce görev başına birleştirilir; ayrık ve yıkıcı işlemler önce bağımlı bekleyen yamaları gönderir.

Her yenileme de sıralı kalıcılık sınırından geçer. Önce bekleyen yamalar gönderilir; çözülmemiş başarısız görev yamaları atılmadan otomatik yenilemeyi engeller; ortak etkin yük koruması manuel/otomatik yarışını önler. Otomatik yükleme sırasında gelen manuel talep, sessiz arka plan hatası anlamını devralmak yerine bir kez arkasına alınır. Başarılı anlık görüntüler yapısal paylaşımla uzlaştırılır; değişmeyen iş verisi özellik ağaçlarını gereksiz yenilemez, arayüz durumunu sıfırlamaz. Görevler kurumsal seçiminin (`directorate → department → unit`) sahibi `TaskOrganizationFilterProvider` olup `AppShell` tarafından anahtarlı kipe özgü görünüm dışında kurulur; otomatik yenileme ve Temel/Kapsamlı geçişleri seçimi korur. Yenilenen yetkili projeksiyon seçili alt yolu yalnızca artık görünür görev sorumlusu tarafından temsil edilmiyorsa budar.

Çalışma alanı düzenlemesinin tek kesin kaynağı vardır:

```text
workspaceMode: portfolio | project
selectedProjectId: null | Project.id
```

Saf çalışma alanı seçicileri etkin Proje, Projeler, Görevler, WBS ve katılımcı Kişileri sunar. Özellik kancaları bu kapsamlı seçicileri kullanır. Aynı özellik uygulaması ham deneme verisini içe almadan veya her görünümde `projectId` süzgeci yinelemeden Portföy ve Proje kipine hizmet eder. Görevler kurumsal süzgeci ancak seçicilerden sonra uygular; süzgeç yetkili çalışma alanı projeksiyonu dışından Görev/Kişi ekleyemez.

Son çalışma alanı yalnızca `mergen-rota.workspace.v1` arayüz tercihi olarak saklanır. Proje kimliği doğrulanabilsin diye ancak depo verisi hazır olduktan sonra geri yüklenir. Geçersiz kalıcı proje kimliği Portföy kipine normalleştirilir. Alan değiştirmek, başka projedeki seçili görevin açık kalmasını da önler. Tercih `AppRepository` parçası değildir.

Olağan görev CRUD yalnızca değiştirilebilir görev verisini etkiler. Proje değişimi merkezî normalleştirilir; eski projenin WBS ataması kalamaz. Yeni projede tek belirsiz olmayan kök varsa güvenli varsayılan olur; aksi durumda `wbsId`, `null` olur.

Baz plan kayıtları ve görev baz plan anlık görüntüleri ayrı taşınır; güncel plan/WBS düzenlemesi, görev silme veya yeni görev açma bunları yeniden yazmaz. Özelliğin ihtiyacı olduğunda odaklı seçiciler birincil baz plan/anlık görüntü araması sunar.

WBS değişiklikleri alan/durum sınırında doğrulanır. Düğümün alt WBS düğümleri veya doğrudan atanmış görevleri varsa silme önlenir; uygulama sessiz zincirleme silme veya yeniden atama yapmaz. Toplu görev WBS taşıması ve alt ağaç üst düğüm değişimi, mevcut doğrulamadan sonra tek atomik değişiklik kümesi olarak saklanır.

CPM, `src/state/selectors/scheduleSelectors.js` içindeki türetilmiş uygulama zamanlama projeksiyonuyla sunulur. Projeksiyon:

- her projede bağımsız CPM hesaplar;
- başarılı sonuçları portföy düzeyi görev erişim verisinde birleştirir;
- hesaplanan CPM alanlarını kanonik görev nesnelerinden ayrı tutar;
- geçersiz projenin ilgisiz projeleri engellememesi için doğrulama hatalarını yalıtır;
- portföy bağımlılık ağları mevcut zamanlama kapsamı dışında olduğundan projeler arası bağımlılığı açıkça reddeder.

Özellik Proje çalışma alanındayken bile `AppStateProvider`, bütün kanonik görev, proje ve takvimlerden bu projeksiyonu bellekte yeniden kullanılacak biçimde hesaplar. Proje özellikleri uygun mevcut sonucu seçer; ikinci CPM hesabı başlatmaz. Başarılı kalıcı zamanlama değişikliği kanonik görev durumu değiştiğinden doğal olarak projeksiyonu yeniden hesaplatır; CPM çıktısı saklanmaz.

### `src/features`

Özellik odaklı modüller: özet, görevler, WBS, takvim, Gantt, Kanban, raporlar, ekip, ayarlar ve görev ayrıntısı. Bileşenler durum kancaları ve ortak saf mantığı kullanır; ham deneme dizileri veya depo uygulamalarını içe aktarmaz.

Özet, Görevler, Takvim, Kanban, Raporlar ve Ekip çalışma alanı kapsamlı kancaları kullanır. Ayarlar genel kalır. WBS ağırlıkla proje odaklıdır ve ortak alan hiyerarşi seçicilerini kullanır.

Yeniden kullanılabilir saf kurallar büyük `.jsx` çizim gövdeleri dışında bulunur; yalın Node testleri bunları sınayabilir. `domain/organization/organizationHierarchy.js`, Ekip ve Görevler'in ortak kararlı hiyerarşik yol anahtarları, seçenek üretimi, eşleştirme ve seçim budamasını yönetir. `domain/organization/taskOrganizationFilter.js`, Ekip özellik mantığını almadan kararlı sorumlu kimliği dizinleme, korumalı eski ad uyumluluğu ve herhangi bir sorumlunun eşleşmesiyle görev eşleştirme ekler. Yalnızca Ekip sıralaması `features/team/teamFilterPolicy.js` içinde kalır; `features/wbs/wbsTreeViewPolicy.js` ile `features/simple/simpleModePolicy.js` özelliklerine özgü kuralları korur.

Portföy Gantt mevcut portföy odaklı uygulamayı korur. Proje çalışma alanı varsayılan WBS hiyerarşisidir; özet satırları/çubukları yapay görev değil, türetilmiş görünüm verisidir. Sorumlu/CPM ayrıntısı için mevcut Gantt kullanılabilir. İki Gantt yolu da doğrudan `calculateCpm()` çağırmaz.

Görev Ayrıntısı güncel plan, hedef, gerçekleşen, kalan süre, Proje ve WBS verisini düzenler. WBS seçicisi yalnızca görevin güncel projesinin düğümlerini sunar. Birincil baz plan anlık görüntüsü salt okunur kalır. Durum kalıcılık katmanı sık yamaları depo yazımından önce birleştirirken yerel alan düzenlemeleri akıcı kalır.

### `src/components`

`components/shell`; uygulama çerçevesi, asenkron yükleme/hata sınırı, kalıcılık durum göstergesi, kararlı kimlikli çalışma alanı seçici, gezinme, komut paleti, karşılama ekranı, logo ve doğrulanmış kenar çubuğu kullanıcı panelini içerir. Kenar çubuğu genişlik/sabitleme durumu yerel kalıcı sunum tercihidir; yetkilendirme veya depo durumuna girmez. `components/ui.jsx` ve `components/ui-extras.jsx` yeniden kullanılabilir görsel temel bileşenler olarak kalır.

`components/Loader.jsx`, görev oluşturma, çekmeceler, dışa aktarma menüsü ve kalıcılık şeridinin kullandığı ortak yükleme göstergelerini (`Spinner`, `ButtonSpinner`, `SavingOverlay`) yönetir; hiçbir özellik kendi dönen göstergesini tanımlamaz.

`Avatar`/`AvatarStack`, güvenilir baş harf yedeğiyle kurumsal fotoğrafları gösterir. Uygulama durumunu içe aktarmamalıdır; bu nedenle kabuk kişi dizinini `components/PeopleDirectoryContext.jsx` üzerinden sağlar. Saf çözümleme kuralları `components/avatarIdentity.js`, tek URL kurucu `lib/userPhoto.js` içindedir. Kimlik çözümü önce verilen kişiyi, sonra kanonik id/Sicil'i, en son görüntüleme adını tercih eder; belirsiz ad iki personel arasında tahmin yapmaz.

### Sunucu katmanı (`src/server`)

Yalnızca sunucuda kimlik, kimlik doğrulama, yetkilendirme, SQL yapılandırması ve kalıcı depolar.

`identity/`, kimlik doğrulama sınırını yönetir. `currentUserProvider.js`, yalnızca sunucu yapılandırmasından (`MERGEN_ROTA_AUTH_MODE`) sağlayıcı seçer: varsayılan `KeycloakIdentityProvider`; yerel geliştirme açıkça istediğinde `DevelopmentIdentityProvider`. Keycloak modülleri bilinçli olarak küçük ve tek amaçlıdır: `keycloakConfig.js` (ortam → yapılandırma), `keycloakJwks.js` (JWKS alma/önbellek/anahtar dönüşümü), `keycloakToken.js` (`node:crypto` ile saf JWT çözme + RSA imzası + standart beyan doğrulama), `keycloakClaims.js` (saf beyan → kimlik eşleme ve günlük maskeleme), `keycloakSessionCookie.js` (HMAC imzalı HttpOnly oturum yükü), `keycloakPkce.js` (PKCE + imzalı state işlemi), `keycloakAuthentication.js` (düzenleme), `resolveSicilFromUsername.js` (isteğe bağlı HR02 araması), `authRouteSupport.js` (ortak rota yardımcıları). Üçüncü taraf kimlik doğrulama çatısı kullanılmaz; çalışma zamanı çevrimdışı yeteneğini korur.

`sicil.js`, Sicil ayrıştırmanın tek kuralıdır; hem Keycloak beyanı hem geliştirme kimliği kullanır. `src/domain/identity/sessionUser.js` saf olup sunucu ve istemci arasında ortaktır: kurumsal dizin kaydını doğrulanmış beyanlarla birleştirir ve kenar çubuğu etiketlerini çözümler.

İki bağlantı havuzu vardır: MERGEN Rota veritabanı için `db/pool.js`, ayrı kurumsal WBS (CN43N) veritabanı için `db/corporateWbsPool.js`. İkisi de yerel sürücüyü, uçtan uca kalıcılık testlerinin yalnızca teste özel enjeksiyon noktasını da sunan `db/driver.js` üzerinden çözer.

Kurumsal WBS eşitlemesi; saf projeksiyon modülüne (`repository/corporateWbsProjection.js`, CN43N satırları → hiyerarşi planı), saf atlama karar modülüne (`repository/corporateWbsSyncState.js`, içerik parmak izleri), süreç düzeyi zamanlamaya (`repository/corporateWbsSyncSchedule.js`, güncellik penceresi ve tek etkin yenileme), SQL metnine (`repository/corporateWbsQueries.js`) ve düzenlemeye (`repository/corporateWbsSync.js`) ayrılır. Böylece hiyerarşi çözümü ve atlama kararları veritabanı olmadan test edilir.

Anlık görüntü yükleme bilinçli olarak iki adımdır: `refreshCorporateCatalog()` kurumsal kataloğu günceller, `readSnapshot()` yetkili anlık görüntüyü okur. `projectedSqlAppRepository`, yenilemeyi serializable okuma işlemini açmadan *önce* çağırır; büyük CN43N birleştirmesi serializable yalıtım devralmaz veya okuma boyunca aralık kilidi tutmaz. İkisini isteyen çağıranlar için `loadSnapshot()` birleşimleri olarak kalır.

`mail/`, SMTP taşımasıdır. `smtpConfig.js` yalnızca sunucu ortam değişkenlerini okur (`NEXT_PUBLIC_*` kullanmaz); `mimeMessage.js` kodlanmış başlıklar ve nokta kaçışlı gövdelerle RFC 5322 multipart/alternative ileti kurar; `smtpClient.js`, `node:net`/`node:tls` üzerinden SMTP akışını yürütür (EHLO → STARTTLS → EHLO → AUTH → MAIL FROM → RCPT TO → DATA → QUIT); `mailService.js` ikisini birleştirir. Üçüncü taraf posta bağımlılığı eklenmez: yerel sunucu yığını akışı zaten gerçekleştirir; kimlik bilgileri sunucu sürecinden çıkmaz veya günlükte görünmez.

`reminders/`, hatırlatma uygulama servisidir. `reminderQueries.js`, `MR_TaskAssignees.Sicil → MR_V_PeopleDirectory.Username → DC01_userr.Name → DC01_userr.EmailAddress` alıcı zinciri dahil SQL metnini yönetir. `reminderStore.js` ayar satırını ve gönderim günlüğünü okur/yazar, adresleri günlüğe ulaşmadan maskeler. `reminderAccess.js` yetki denetimlerini yönetir (görev erişimi, yöneticiye özgü ayarlar, `timingSafeEqual` ile zamanlayıcı anahtarı karşılaştırması). `reminderService.js`, elle düğme ve zamanlayıcının kullandığı tek ortak `deliverTaskReminder()` yolunu düzenler; alıcı çözümü, çizim veya taşıma ayrışamaz. Gönderim işlevi enjekte edilebilir; bütünleşme testleri sokete kadar her şeyi böyle sınar.

Zamanlayıcı sunucu tarafındadır: `POST /api/mergen-rota/reminders/run` tek otomatik tur çalıştırır; Windows Task Scheduler veya cron tetikler. Açık tarayıcı gerekmez. Belirlenimci zaman dilimi anahtarının gönderimden *önce*, otomatik gönderimlere süzülmüş benzersiz dizin altında `MR_TaskReminderLog` içinde sahiplenilmesi yinelenen gönderimi önler; yeniden başlatmalar ve çoklu uygulama örnekleri zaman dilimi başına tek iletide birleşir.

`outlook/`, takvim aboneliklerini ve kalıcı çıkış kuyruğunu yönetir. `src/instrumentation.js`, açık Next.js 14 instrumentation kancasıyla uzun ömürlü Next.js Node süreci başına tek Outlook döngüsü başlatır; derleme ve Edge yürütmeleri teslim başlatmaz. İlk tur başlangıçta zamanlanır; sonraki turlar tamamlanmadan sonra `MERGEN_ROTA_OUTLOOK_POLL_INTERVAL_MS` (varsayılan 5 saniye) bekler. Mevcut sınırlı çıkış servisi, SQL satır kiraları, revizyon ayırma ve kalıcı tekrar zamanları kullanılır. Döngü bağlantı/sorgu/SMTP hatasından sonra sürer; otomatik hatırlatma ayarına bakmaz. Çoklu örnekler ve isteğe bağlı elle/zamanlayıcı ucu SQL sahiplik korumasını paylaşır. Outlook için tarayıcı veya işletim sistemi zamanlayıcısı gerekmez; otomatik hatırlatma e-postalarını yine işletim sistemi zamanlar.

`directory/`, `assignment/`, `notifications/` ve `presence/`, bölümler arası işbirliği sınırını yönetir. `directory/directorySearch.js` tek kurumsal dizin arama yoludur: asgari sorgu uzunluğu, sınırlı sonuç, süreç içi hız sınırı ve asgari projeksiyon (ad, Sicil, kurum yolu) uygular; arama dizin yoklama ucuna dönüşmez, 3000 satırlık kurumsal dizin anlık görüntüye girmez. `assignment/managementChain.js`, alıcı birim ve müdürlük yöneticilerini yetkili İK verisinden **küme bazında** çözer, Sicil ile tekilleştirir. `assignment/crossOrganization.js`, istenen sorumlulardan hangilerinin işlemi yapanın yönetici kapsamı dışında olduğunu sınıflar. `assignment/assignmentCoordinationStore.js` oluşturma, karar geçişleri ve geçiş başına eskime denetimlerini; `assignment/assignmentCoordinationQueries.js` SQL metnini ve sunucuda sayfalı gelen kutusunu yönetir. `notifications/taskNotificationStore.js` yetkili sorumlu kümesi farkını türetip alıcı başına toplar; `notifications/notificationInboxQueries.js`, tarih talepleri, koordinasyon ve görev bildirimlerini dört kayıt kümeli **tek** sorguyla okur. `notifications/taskMailOutbox.js`/`taskMailService.js`/`taskMailWorker.js`, kalıcı posta çıkış kuyruğu, SMTP tüketicisi ve döngüsüdür. `presence/presenceStore.js` nabzı kaydeder, yalnızca SYSTEM_ADMIN etkin kullanıcı listesini sunar.

Bu ayrımın yönü bilinçlidir. Bildirim, onu haklı kılan sorumlu değişikliğiyle **aynı işlemde** yazılır; geri alınan değişikliği anlatamaz. E-posta aynı işlemde yalnızca *niyet* satırıdır; `api.commit` SMTP beklemez, posta kesintisi görev kaydını başarısız kılamaz. `src/instrumentation.js`, aynı Next.js Node instrumentation kancası ve yeniden başlatma anlamıyla Outlook döngüsü yanında görev postası döngüsünü başlatır (`MERGEN_ROTA_TASK_MAIL_POLL_MS`, varsayılan 30 saniye).

Yönetici çalıştırma ucu hatırlatma ve Outlook turlarını bağımsız başlatır; HTTP 503'te iki özeti de güvenli hata kodlarıyla korur. GET yalnızca SYSTEM_ADMIN için ortak veritabanı kuyruk sayılarını ve açıkça sürece yerel son tur tanısını sunar. Yönetici görünümü hatırlatma taslağını değiştirmeden durumu yoklar; görev Outlook durumu güvenli 30 saniye/odak yenilemesini korur. Bütçe, dağıtım ve toparlanma için [Outlook takvim teslimi](OUTLOOK-TAKVIM.md) belgesine bakın.

`ai/`, yapay zekâ alt sistemidir (bkz. [Yapay zekâ platformu](YAPAY-ZEKA-PLATFORMU.md)). Bilinçli olarak yaprak modüldür: olağan istek yolları (anlık görüntü, kayıt, görev düzenleme, raporlar) bunu içe almaz; yalnızca ayarlar kartı, Sistem Yönetimi sağlık/bütünleşme yoklamaları ve telemetri döngüsünün AI yük örneklemesi erişir. Kök yerleşim statiktir, AI alt sistemi içe almaz. Küçük ve önbelleksiz `/runtime.js` yanıtı SQL veya sağlayıcı işi yapmadan yalnızca çalışma zamanı kullanılabilirlik mantıksal değerini sunar. Kabuk `AssistantShell.jsx` ile asistan kod/biçimlerini yalnızca bu değer açıksa yükler; uçlar kendi `AI_DISABLED` denetimini korur. AI SQL kapıları sabit bağlantı bütçesine kaydedilir (`aiSqlGate.js`: 10 havuz bağlantısının 9'u; biri daima olağan Rota işine kalır). Tek yürütme yolu `aiGateway.js` şöyledir: güvenilir Sicil → kurumsal rehber üyeliği (kendi süre sınırı olan sınırlı kabul öncesi SQL denetimi) → yapılandırma → profil → kapasite kirası (`admissionController.js`) → kimlik bilgisi (`credentialVault.js` ile şifrelenen `aiCredentialService.js`) → OpenAI uyumlu sağlayıcı (`providers/`). Kimlik bilgisi okuması ve sağlayıcı çağrısı tek süre sınırı/iptal sinyalini (`aiDeadline.js`) paylaşır. İş kodu somut model değil yetenek profili ister; profil → model eşlemesi veridir (`defaultModelRegistry.js` veya işletmecinin JSON dosyası). Güncel kurum içi kataloğun sürümlü anlık görüntüsü `config/ai-model-registry.onprem.json` dosyasıdır; üretimde `MERGEN_ROTA_AI_MODEL_REGISTRY_PATH` dağıtılan mutlak yol kopyasını gösterir. Ağ geçidi açık SQL işlemi içinde çalışmayı reddeder; model üretirken SQL bağlantısı/işlemi tutulmaz. Sağlayıcı SQL kimlik bilgisi almaz; genel SQL yürütme yüzeyi yoktur.

`ai/tools/` (Aşama 3, `MERGEN_ROTA_AI_TOOLS_ENABLED` ile isteğe bağlı), Rota AI'ye Rota verisinde kanıta bağlı salt okunur erişim verir (bkz. [Yapay zekâ alan araçları](YAPAY-ZEKA-ALAN-ARACLARI.md)). Model yalnızca `toolRegistry.js` içindeki sunucuya ait, katı şema doğrulamalı 19 araç arasından seçer; kimlik, yetki veya SQL vermez. `aiGateway.runToolSession`, çok turlu isteği tek kapasite kirası, süre sınırı ve kimlik bilgisi altında çalıştırır. `toolExecutor.js` tur, çağrı, zaman ve sonuç boyutunu sınırlar. `toolContext.js`, her araç turunda yetki bağlamını (`loadAuthorizationContext`) bir kez yeniden okur; her sorguyu özel tek yuvalı araç SQL kapısından geçirir. `ai/tools/rota/rotaToolStore.js`, görev görünürlüğünü anlık görüntüyle aynı kurallarla yeniden hesaplayan sabit, parametreli `AI_TOOL_*_SQL` deyimlerini çalıştıran tek modüldür; diğer araçlar mevcut okuma servislerini kullanır (hareket raporu, talepler, bildirimler, dizin araması). Başarılı sonuçlar tur başına kanıt olur (`R1`, `R2` …). Veri okunmadan önce model türlendirilmiş talep bildirir: `operation` için value/list/rank, kapalı kayıt sözlüğünden `metrics`, ad/kimliği kullanıcı iletisinden veya sunucuya bağlı açıklama seçiminden gelen `entities`, araçların kendi sözlüğünden `filters` ve yanıt `language`. Kabul edilmiş talep olmadan araç çalışmaz; veri okunduktan sonra talep değişemez. Aşama 3, Türkçe veya İngilizce kullanıcı niyetini yorumlamak için regex/anahtar kelime NLP kullanmaz. Doğal dil anlamsal akıl yürütmesi Aşama 4'te iyileştirilecektir. Aşama 3 belirlenimci mantığı güvenilir yapısal doğrulama, yetkilendirme, kanıt bütünlüğü, ölçüm hesabı, sınırlar ve diğer nesnel değişmezlerle sınırlıdır. Model, sunucunun onayladığı olguları seçerek yanıtlar (`{"kind":"rota","facts":["R1:data.…"]}`; eski türlendirilmiş iddia biçimi de kabul edilir). `domain/ai/requestContract.js`, seçimi bildirilen talebe bağlar (her ölçüm temsil edilir, nüfus boyutları tam eşleşir, bağlı varlıklar kapsanır, listeler eksiksizdir, sıralar sunucuda hesaplanır). `assistant/groundedAnswer.js`, her atfı yetkili yükle belirlenimci çözer (LLM yargıcı yoktur); `domain/ai/evidenceNarrative.js`, doğrulanan olguları sunucuya ait düzyazı, liste veya tabloda çizer. Tek onarım mümkündür; Standart kipte kurtarılabilir model hatası (doğrulanamayan çıktı, uzunluk, boş tamamlama), sabit güvenli iletiye geçmeden önce aynı kanıt defteriyle Derin Düşünme araç profili tarafından bir kez sonuçlandırılır. Kimlik yalnızca kesin eşleşmedir; belirsiz adayları sunucu tutar. Tam bir sunulan seçim numarası olan yanıt saklanan kimliğe bağlanır (sözel seçimleri sunucu yorumlamaz). Toplu olgular sayılan görev nüfusunun tamamına karşı yeniden doğrulanır. Model niyet önerir; ayrı, verisiz Genel sohbet kaynağını yalnızca kullanıcı seçebilir. Modelin genel sohbet beyanı varsayılan Rota kaynağında türlendirilmiş kanıtı atlayamaz. Açıklama isteme, bulunamadı, kullanılamıyor ve hata bitişleri ayrı kalır. `toolScope.js`, devam varlıklarını, süzgeçleri ve önceden seçilmiş metni sınırlar; `claimableEvidence.js`, kanonik iddia yollarını ve anlamsal kökeni tanımlar. `toolResultPolicy.js` ile `toolResultText.js`, korunan eleman sayısı ve kesme doğruluğunu yönetir. Kanıt, görev başına oluşturucu/atama hakları ve görünür kişi üyeliklerini içeren kalıcı yetki epoch'una bağlıdır; sonraki turlar ve sınırlı çizim öncesi yetki okuması eski epoch'u geçersiz kılar. Bu gözlenen yetki denetimidir; atomik model/veritabanı işlemi değildir. AI iş akışı sayfaları sınırlı tur anlık görüntüsü kullanır; görev imleçleri değişen veri kümelerini reddeder. Gruplama öncesinde görevler, sorumlu kenarları ve ham hareket için ayrı max+1 bütçeleri vardır. Seçilmemiş kayıtlı serbest metin, modele ve kanıt deposuna gitmeden projeksiyondan çıkarılır; onaylı devamlar normalleştirilmiş kapsam argümanlarını karşılaştırır. Tam ölçekli ondalık değerler ve anlamsal birimler çizimde korunur. Kayıtlı yanıtlar, kanıt özetleri, tekrar ve uzlaştırma güncel yetkiye göre açıklama doğrulamasını paylaşır; epoch'suz eski kanıt gizlenir. Açıklama geçmişi yalnızca yetkili yapılandırılmış adayları tutar. Bildirim/iş akışı AI okumaları, isteğe bağlı parametrelerle güncel görev görünürlüğünü ve sınırlı anlık görüntüleri ekler; olağan okumalar değişmez. Atıflı kanıt yanıtla tek kısa işlemde yazılır (`MR_AiMessageEvidence`, geçiş 0018). Bayrak kapalıyken Rota AI, Aşama 2 ile aynı davranır.

### Sunum ve biçimlendirme sorumluluğu

Sunum da alan, zamanlama, veri ve durum mimarisiyle aynı sorumluluk kuralını izler: güncel davranışı zamana dayalı geçersiz kılma zinciri değil, sahibi bileşen/özellik tanımlar. `src/app/globals.css` genel tasarım değişkenleri/temel bileşenleri; `src/app/styles/shell.css` uygulama çerçevesini; `dashboard.css` Özet yapısını; `components.css` ortak görsel/bileşen, form ve tablo sözleşmelerini; `features.css` Gantt, WBS ve Görev Ayrıntısı yerleşim bölümlerini; `simple-mode.css` Temel Kipi; `experience.css` kip/ayarlar/yardım sunumunu yönetir.

Genel görsel temel bileşenler `src/components` altında; kabuk sunumu kabuk sorumluluğunda; özelliğe özgü yerleşim ilgili özellik biçim kaynağında bulunur. Kök genel biçimler `fixes`/`followup`/`polish` katmanları dizisine dönüşmemelidir. Statik uygulama yapısı satır içi biçim metni veya çocuk konumundan çıkarılmak yerine anlamsal sınıflarla sunulmalıdır. Renk ve hesaplanan genişlik gibi dinamik çalışma zamanı değerleri satır içinde kalabilir.

Ortak katman değişkenleri yapışkan öğe, çerçeve, açılır pencere, çekmece, modal ve bilgi kutusu sırasını tanımlar. Özellik kodu açıklanmayan z-index değerlerini büyütmek yerine bu katmanları kullanmalıdır. Tam sözleşme için `docs/ARAYUZ-BICIMLENDIRME-MIMARISI.md`, elle görsel doğrulama listesi için `docs/GORSEL-DUMAN-TESTLERI.md` belgesine bakın.

## Yeni çalışma ekleme

- Kimlik doğrulama, belirteç doğrulama, oturum çerezleri, kimlik çözümleme: `src/server/identity`
- Proje/Görev/WBS/Baz Plan iş kuralları ve Gerçek Sistem kimlik kuralları: `src/domain`
- Tarih, bağımlılık, takvim, güncel plan süresi veya CPM hesapları: `src/scheduling`
- Depo sözleşmeleri, bellek/API/veritabanı bağdaştırıcıları ve veri dönüşüm sınırları: `src/data`
- Genel istemci düzenlemesi, asenkron kalıcılık komutları, çalışma alanı seçimi, türetilmiş uygulama projeksiyonları: `src/state`
- Hatırlatma kuralları, şablonları ve ilkesi: `src/domain/reminders`
- SMTP taşıması, hatırlatma kalıcılığı ve servisi: `src/server/mail` ve `src/server/reminders`
- Sağlık durumları, olay/uyarı modeli, ölçüm hesabı, tanı temizleme: `src/domain/observability`
- Koordinasyon durumları, karar yetkisi, zil gelen kutusu birleşimi ve varlık pencereleri: `src/domain/assignment`, `src/domain/notifications`, `src/domain/presence`
- Kurumsal dizin araması, bölümler arası sınıflandırma, yönetim zinciri çözümü, koordinasyon kalıcılığı, görev bildirimleri, atama posta çıkış kuyruğu ve varlık: `src/server/directory`, `src/server/assignment`, `src/server/notifications`, `src/server/presence`
- Telemetri toplama, sağlık yoklamaları, uyarı kuralları, yapılandırılmış günlük ve yönetim uçları: `src/server/observability` (bkz. `docs/SISTEM-YONETIMI.md`)
- AI yapılandırması, kişisel anahtar saklama, kapasite kontrolü, sağlayıcı bağdaştırıcıları ve model/yetenek kaydı: `src/server/ai`; saf ortak kurallar `src/domain/ai` içinde (bkz. `docs/YAPAY-ZEKA-PLATFORMU.md`)
- Rota AI alan araçları, sabit salt okunur SQL'leri, kanıt ve atıf doğrulaması: `src/server/ai/tools`, `src/domain/ai/evidenceContract.js` (bkz. `docs/YAPAY-ZEKA-ALAN-ARACLARI.md`). Yeni araç katı şemalı, yetki anlamı belgeli ve mevcut yetkilendirmeyi kullanan işleyicili kayıt girdisidir; genel sorgu yüzeyi değildir.
- Özellik arayüzü ve yalnızca özelliğe ait yardımcılar: ilgili `src/features/<feature>` klasörü
- Genel görsel temel bileşenler: `src/components/ui*`
- Ortak yükleme göstergeleri: `src/components/Loader.jsx`
- Kenar çubuğu/üst çubuk/genel üst katmanlar ve uygulama yaşam döngüsü yüzeyleri: `src/components/shell`
- Hesap tablosu/arşiv yazıcıları ve dışa aktarma şekillendirmesi: `src/lib/xlsx`, `src/lib/exportProjectData.js`

## Dışa aktarma hattı

Dışa aktarma çıktısı tek sayfa modeli ve iki üretici kullanır. `lib/exportProjectData.js`, sayfa tanımlarını (`buildExportSheets`) kurar: Özet, Görevler, İş Dağılım Ağacı ve yalnızca portföy dışa aktarımında Projeler. Her sütun anahtar, genişlik ve isteğe bağlı hücre türü (`date`, `percent`, `number`) veya satıra göre tür alanı (`typeKey`) tanımlar. Özet sayfası bunu sayıların sayı, rapor tarihinin tarih, ortalama ilerlemenin yüzde kalması için kullanır. Excel üreticisi (`buildProjectWorkbook`) ve CSV üreticisi (`sheetToCsv`, `buildProjectCsvBundle`) aynı tanımları kullanır; iki çıktı ayrışamaz. Eski tek dosyalı `buildProjectCsv`, makine tüketicileri için düz sütun sözleşmesini korur.

Tarihler `toISOString()` yerine yerel takvimden gelir: UTC+3'te UTC günü 03:00'e kadar dündür; bu hem gecikme sayısını hem rapor tarihini kaydırıyordu. Kurumsal projeler görüntüleme adı yerine kimlik taşıdığından proje sorumlusu `leadId` ile yetkili kişi anlık görüntüsünden çözümlenir.

`lib/xlsx/`, bağımlılıksız yazıcıdır: `zipArchive.js` doğru merkezî dizinli, saklama yöntemli (sıkıştırılmamış) ZIP kapsayıcısı üretir; `xlsxWorkbook.js`, satır içi dizeler, gerçek tarih seri değerleri, yüzde hücreleri, sabit başlık bölmeleri, otomatik süzgeç ve sütun genişlikleriyle OOXML parçalarını (çalışma kitabı, biçimler, her sayfa için çalışma sayfası) yazar. Önceki dışa aktarım `.xls` uzantısıyla HTML tablosu yazıyor, Excel her açılışta biçim/uzantı uyumsuzluğu uyarısı veriyordu. Hücre metni iki üreticide de formül enjeksiyonuna karşı etkisizleştirilir.

## Zamanlama verisinin sorumluluğu

Saklanan ve hesaplanan zamanlama verilerinin anlamları bilinçli olarak farklıdır:

- güncel plan: değiştirilebilir kanonik görev alanları;
- yönetim hedefi: değiştirilebilir `targetFinish`; CPM kısıtı değildir;
- gerçekleşenler: açık gözlenen tarihler; durumdan türetilmez;
- kalan süre: null olabilen uyumluluk alanı; mevcut zamanlama üretmez veya kullanmaz;
- proje veri tarihi: saklanan, isteğe bağlı proje durum kesim tarihi; satır zaman damgası değildir;
- baz plan: olağan Görev/WBS CRUD altında ayrı değişmez anlık görüntü varlıkları;
- CPM zamanlaması: yalnızca türetilmiş durum;
- WBS zamanlama özetleri: alt görevlerin güncel planından türetilir; WBS düğümlerinde saklanmaz.

Asenkron yükleme/değişiklik anlamı için `docs/KALICILIK-SINIRI.md`, zamanlama sözleşmesi için `docs/ZAMANLAMA-VERI-MODELI.md`, çalışma alanı ve hiyerarşi kuralları için `docs/IS-KIRILIM-YAPISI-VE-CALISMA-ALANLARI.md` belgesine bakın.

## Veritabanı/API geçiş yolu

Uygulama `getAppRepository()` üzerinden başlar; bu erişim işlevi ihtiyaç anında Demo Kipinin asenkron bellek bağdaştırıcısını çözümler. Modül sabiti yerine erişim işlevi kullanılır; oturum Gerçek Sistem verisindeyken içe aktarım anında demo başlangıç verisi kurulmaz. Kalıcı uygulama, özellik kancalarını değiştirmeden durum düzenleme sınırının arkasındaki veri bağdaştırıcısını değiştirmelidir.

Amaçlanan yön şöyledir:

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

Tarayıcı SQL Server'a hiçbir zaman doğrudan bağlanmamalıdır. Sunucu/veritabanı uygulaması atomik `commitChanges()` anlamını korumalı ve yetkili kanonik varlıkları döndürmelidir.

Gelecekteki kalıcılık şeması Proje → WBS → Aktivite ilişkilerini ayrı kararlı kimlik ilişkileri olarak korumalı; güncel plan, gerçekleşenler, baz plan anlık görüntüleri ve hesaplanan CPM çıktısının anlamsal ayrımını sürdürmelidir. SQL Server, Next.js rota işleyicileri, REST istemcileri, Primavera/SAP bütünleşmesi, yetkilendirme ve denetim geçmişi mevcut uygulama kapsamı dışında kalır.


## Talep geçmişi ve görev ayrıntı katmanı

Genel anlık görüntü `scheduleRequests` içinde en fazla sekiz önizleme, `scheduleRequestSummary` içinde sayaçlar taşır. Talepler sayfası ve görevdeki bekleyen öneri `schedule-changes` GET sorgularıyla ayrı yüklenir; geçmiş büyüklüğü uygulama bağlamını büyütmez. SQL okuma/temizleme ayrı bildirim tablosuna gider. KPI modalı zaten yetkilendirilmiş ve Özet tarafından daraltılmış görevleri yerel olarak arar/sayfalar. İki görev panelinde ikinci bir alan kopyası bulunmaz; `TaskEditor` taslağı tek kaynaktır. [Akış ve API](TALEPLER-VE-BILDIRIMLER.md), [arayüz sözleşmesi](TEMEL-KIP-VE-ARAYUZ.md).


### Atama koordinasyonu ve birleşik bildirim mimarisi

Kurum dışı atama, zil bildirimi ve isteğe bağlı e-posta **tek bir mimaridir**,
üç ayrı özellik değil. Rota doğruluk kaynağıdır; e-posta yalnızca bir taşıma
katmanıdır ve iş akışı durumu taşımaz.

Gerçek atama ilişkisi ile *talep edilmiş* atama kesin olarak ayrıdır: onay
gelene kadar `MR_TaskAssignees` yazılmaz, dolayısıyla hiçbir mevcut görünürlük,
iş yükü, hatırlatma veya Outlook davranışı bekleyen bir talepten etkilenmez.
Koordinasyon kaydı kendi tablosunda yaşar ve karar geçmişini korur; kararı veren
yönetici görev düzenleme yetkisi kazanmaz, yalnızca o Sicilin eklenmesi/
kaldırılması uygulanır ve görünmeyen ortak sorumlular sessizce silinmez.

Her üç akış da **dayanıklı ve idempotanttır**. Bildirim `EventKey`, posta
`DedupeKey` ile tekilleştirilir; yeniden çalıştırılan bir kayıt işlemi ikinci kayıt
üretmez. Bildirim sürümlenir: yeni bir karar kaydı haklı olarak yeniden
okunmamış yapar, ama **eski bir eylem daha yeni bir sürümü temizleyemez**
(koordinasyon alıcıları sürüm kapısı, görev bildirimleri tek yönlü `COALESCE`
kullanır). Karar geçmişi hiçbir akışta silinmez.

Maliyet sınırları da mimarinin parçasıdır. Anlık görüntü yalnızca **bir** ek sorgu
alır ve yalnızca sınırlı önizleme taşır: dizin araması, koordinasyon geçmişi ve
bildirim geçmişi anlık görüntüye girmez, sayfalama sunucudadır. `api.commit` SMTP
beklemez. Varlık nabzı istek başına değil, kullanıcı başına ve 90 saniyede
birdir. Ayrıntılar: [Talepler ve bildirimler](TALEPLER-VE-BILDIRIMLER.md),
[yetki modeli](YETKILENDIRME-MODELI.md), [şema](VERITABANI-SEMASI.md).

### Görev hareket raporu

Raporlar, Performans ve Görev Hareketleri sekmelerini içerir. Performans hesapları korunur; hareket sorgusu ayrı API → yetkilendirilmiş rapor servisi → MR_AuditLog yolunu kullanır. Aktör ve görev görünürlüğü birlikte doğrulanır; JSON farkları sunucuda Türkçe iş diline çevrilir. Genel anlık görüntü denetim geçmişi taşımaz. Ayrıntılar: [Görev Hareketleri](GOREV-HAREKET-RAPORU.md).

### Outlook ürün ve yaşam döngüsü sınırı

Rota gün düzeyinde görev yönetimi olarak kalır. Outlook, `taskCalendarDate()` ile tek, tüm gün, TRANSPARENT/FREE termin işareti üretir; DTEND izleyen günü dışlayan sınırdır. Saat aralığı veya başlangıç–bitiş dönemi dışa aktarılmaz. SMTP/iCalendar tek yönlü projeksiyondur: posta kutusu okuması, ters eşitleme, Graph/Entra/EWS, Outlook Tasks/To Do veya Outlook yinelenen ana kaydı eklenmez. Üretilen görev oluşumları bağımsız TaskId/UserSicil UID'lerini korur. Rota'nın yönettiği içerik değişimleri elle yapılan Outlook düzenlemelerini ezebilir; aboneliğin etkinliği ve SMTP teslimi güncel takvim içeriğini doğrulamaz.

0011 geçişi mevcut kalıcı satıra tamamlanma askısı/tarihi, iptal nedeni, son teslim yöntemi ve ayrılmış tarih ekler. Bugün/gelecek tamamlanması, katılım kimliğini koruyarak işareti iptal eder; tarihsel tamamlanma sessizce sonuçlanır. Yeniden açma aynı UID ve daha yüksek revizyonla güncel kanonik gösterimi ister. Açık kaldırma, silme ve görünürlük kaybı tercihi kapatır; otomatik yeniden etkinleştirmez. Tamamlanma niyeti görev işleminde saklanır; QueueSeq ve kira koşulları süren teslim sırasında gelen sonraki yazmaları korur. Outlook veya her e-posta hatırlatması için SMTP zorunludur (`SMTP_HOST`, geçerli `SMTP_FROM`, kurumsal posta kuralları); Outlook için yalnızca hatırlatma zamanlayıcısı isteğe bağlıdır.

Ortak DateRangeFilter, Özet ve performans raporlarında mevcut kompakt temizleme eylemini çizer. Tarih durumunu ve ortak kurum hiyerarşisini birlikte sıfırlar, türetilmiş organizationTaskIds kaldırılır. Hareket raporları kendi sorgu, bağımlı alan ve sayfalamasını sıfırlar. Bütün süzme yetkili çalışma alanı verisi veya rapor ucundan başlar; temizleme oturum yetkisini veya çalışma alanı seçimini değiştirmez.
