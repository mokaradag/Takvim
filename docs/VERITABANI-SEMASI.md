# MERGEN Rota Veritabanı Şeması

Uygulamaya ait bütün SQL Server nesneleri `dbo.MR_` öneki kullanır. Kurumsal kaynak tabloları salt okunurdur; MERGEN tablolarından onlara yabancı anahtar yoktur. Personel yaşam döngüsünü HR02 yönettiğinden personel başvuruları mantıksal Sicil başvurularıdır.

`uniqueidentifier` sütunlarındaki kimliklerden yalnızca geçerli GUID olmaları beklenir. Kurumsal sistemler RFC 4122 sürüm/varyant bitleri olmayan GUID üretir (örneğin `D5D70AEC-0A88-F111-9136-00505699BACD`); uygulama bunları sürümle sınırlı UUID desenleriyle doğrulamamalıdır. SQL Server kimlikleri büyük harfli metin döndürdüğünden bütün katmanlar karşılaştırmadan önce küçük harfe kanonikleştirir.

## Tablolar

| Tablo | Amaç | Önemli anahtarlar ve dizinler |
| --- | --- | --- |
| `MR_SchemaMigrations` | Uygulanan şema kayıtları | PK `MigrationId` |
| `MR_UserRoles` | SYSTEM_ADMIN gibi uygulama rolleri | PK `(Sicil, RoleCode)`; `IX_MR_UserRoles_Role_Active_Sicil`; rowversion |
| `MR_Calendars` | Zamanlama takvimi başlıkları | PK `CalendarId`; süzülmüş benzersiz etkin varsayılan; rowversion |
| `MR_CalendarWorkingDays` | Hafta günü üyeliği | PK `(CalendarId, Weekday)`; hafta günü 0–6 |
| `MR_CalendarHolidays` | Açık tatil tarihleri | PK `(CalendarId, HolidayDate)` |
| `MR_Projects` | Kurumsal proje sicili ve manuel projeler | PK `ProjectId`; süzülmüş benzersiz `ProjectCode`; kaynak/etkinlik ve takvim dizinleri; rowversion |
| `MR_ProjectTags` | Denetimli proje etiket kataloğu (ad, renk, simge) | PK `ProjectTagId`; benzersiz `(ProjectId, TagName)` |
| `MR_ProjectAccess` | MERGEN'e ait tam/okuma yetkileri | PK `(ProjectId, Sicil)`; Sicil/erişim dizini; rowversion |
| `MR_WBS` | Yapısal WBS hiyerarşisi (manuel ve CN43N kaynaklı) | PK `WbsId`; benzersiz `(WbsId, ProjectId)` ve `(ProjectId, Code)`; süzülmüş benzersiz `(ProjectId, SourceKey)`; aynı proje içinde bileşik üst düğüm FK; proje/üst/sıra ve proje/kaynak dizinleri; rowversion |
| `MR_Tasks` | Kanonik değiştirilebilir aktivite verisi | PK `TaskId`; benzersiz `(TaskId, ProjectId)`; aynı proje WBS FK; proje/durum, hedef, plan aralığı, WBS ve oluşturucu dizinleri; rowversion |
| `MR_TaskAssignees` | Normalleştirilmiş Görev-Sicil atamaları | PK `(TaskId, Sicil)`; kritik `IX_MR_TaskAssignees_Sicil_Task` |
| `MR_TaskScheduleChangeRequests` | Kalıcı tarih önerisi iş akışı ve karar geçmişi | PK `RequestId`; görev FK; süzülmüş benzersiz bekleyen `(TaskId, RequesterSicil)`; sahip/durum ve talep eden/durum dizinleri; rowversion |
| `MR_TaskDependencies` | Normalleştirilmiş FS/SS/FF/SF ilişkileri | PK `TaskDependencyId`; aynı proje bileşik görev FK'leri; benzersiz ilişki; öncül dizini |
| `MR_Baselines` | Değişmez baz plan başlıkları | PK `BaselineId`; proje araması; proje başına tek birincil baz plan |
| `MR_TaskBaselineSnapshots` | Değişmez planlanan görev anlık görüntüleri | PK `(BaselineId, TaskId)`; görev araması; güncel göreve bilinçli olarak FK yok (bkz. *Baz plan geçmişi*) |
| `MR_AuditLog` | Yalnızca eklenen, kaydedilmiş iş denetimi | identity PK; proje/zaman, aktör/zaman, varlık/zaman ve ilişkilendirme dizinleri |
| `MR_CorporateWbsSyncState` | Kurumsal proje başına CN43N eşitleme parmak izi | PK `ProjectCode` (`nvarchar(255)`, `MR_Projects.ProjectCode` ile aynı genişlik); `ContentHash` (SHA-256 onaltılık), `NodeCount`, `SyncedAt` |
| `MR_ReminderSettings` | Tek satırlı hatırlatma şablonu ve otomatik ilke | PK `SettingsId`, `CHECK (SettingsId = 1)` ile; rowversion |
| `MR_TaskReminderLog` | Yalnızca eklenen hatırlatma gönderim geçmişi ve yinelenen gönderim sahiplenmesi | identity PK; `IX_MR_TaskReminderLog_Task_Created`; `ReminderKind = 'AUTOMATIC'` için `(TaskId, SlotKey)` üzerinde süzülmüş benzersiz `UX_MR_TaskReminderLog_AutomaticSlot` |
| `MR_TaskOutlookSubscriptions` | Kalıcı Görev+Sicil Outlook takvim aboneliği ve teslim çıkış kuyruğu | identity PK; `(TaskId, UserSicil)` üzerinde benzersiz `UX_MR_TaskOutlookSubs_Task_User`; süzülmüş `IX_MR_TaskOutlookSubs_Pending`; `IX_MR_TaskOutlookSubs_User_Active`; rowversion |
| `MR_TaskAssignmentCoordinations` | Kalıcı bölümler arası atama koordinasyonu (talep/bilgilendirme) ve karar geçmişi | PK `CoordinationId`; `(TaskId, RequestedAssigneeSicil)` üzerinde açık kayıtlara süzülmüş benzersiz `UX_…_OpenRequest`; `IX_…_TaskStatus`; `IX_…_RequesterStatus`; rowversion |
| `MR_AssignmentCoordinationRecipients` | Sicil başına koordinasyon gelen kutusu durumu (yönetici, talep eden, sorumlu) | PK `(CoordinationId, Sicil)`; koordinasyon FK; `IX_MR_AssignmentCoordinationRecipients_Sicil` |
| `MR_TaskNotifications` | Kalıcı Sicil başına görev olay bildirimleri (atandı/ataması kaldırıldı) | PK `NotificationId`; `(RecipientSicil, EventKey)` üzerinde benzersiz `UX_…_RecipientEvent`; `IX_…_RecipientOccurred`; rowversion |
| `MR_TaskMailOutbox` | Kalıcı isteğe bağlı atama e-postası kuyruğu | identity PK `MailId`; benzersiz `UX_MR_TaskMailOutbox_DedupeKey`; `IX_MR_TaskMailOutbox_Due` |
| `MR_UserPresence` | Sicil başına son doğrulanmış nabzı taşıyan tek satır | PK `Sicil`; `IX_MR_UserPresence_LastSeenAt` |
| `MR_AiUserCredentials` | Sicil başına en fazla bir şifreli kişisel AI API anahtarı (AES-256-GCM; nonce, şifreli metin, doğrulama etiketi, ana anahtar kimliği, son dört karakter, doğrulama sonucu); API anahtarının düz metin hâli saklanmaz | PK `Sicil`; rowversion |
| `MR_AiConversations` | Tek Sicil'e ait Rota AI konuşması: belirlenimci başlık, başlangıç turu, ileti sayısı, son etkinlik | PK `ConversationId`; `(OwnerSicil, OriginTurnId)` üzerinde benzersiz `UX_…_OwnerOrigin`; `(OwnerSicil, UpdatedAt DESC, ConversationId DESC)` üzerinde `IX_…_OwnerRecent` |
| `MR_AiConversationMessages` | Konuşmanın sıralı kullanıcı/asistan iletileri; yalnızca kullanıcıya görünen metin (akıl yürütme, ham akış çerçeveleri veya istek nesneleri yok) | kümelenmemiş PK `MessageId`; benzersiz kümelenmiş `(ConversationId, Sequence)`; `(ConversationId, ClientTurnId)` üzerinde süzülmüş benzersiz `UX_…_Turn`, `ReplyToMessageId` üzerinde `UX_…_Reply`; konuşmaya `ON DELETE CASCADE` FK |
| `MR_AiMessageEvidence` | Kanıta bağlı Rota AI yanıtının atıfları (`R1`, `R2` …): tarayıcıdaki güvenli özet ve modele verilen güvenli araç sonucu zarfı; SQL, anahtar, ham sağlayıcı akışı veya akıl yürütme yok | PK `(MessageId, Ordinal)`; asistan iletisine `ON DELETE CASCADE` FK; `Ordinal` 1–16; `ToolName LIKE 'rota[_]%'`; `ISJSON` denetimleri; `EvidenceJson` ≤ 64 KiB |

## Rowversion

`MR_Projects`, `MR_WBS`, `MR_Tasks`, `MR_TaskScheduleChangeRequests`, `MR_UserRoles`, `MR_Calendars` ve `MR_ProjectAccess`, `rowversion` içerir. Uygulama bu baytları opak Base64 belirteçleri olarak döndürür. Güncelleme/silme koşullarında karşılaştırılır; iş sayıları olarak yorumlanmaz.

## Proje şeması

`SourceType`, `CORPORATE` veya `MANUAL` olur. Kurumsal kod, ad, tür alanları ve `LeadSicil`, A01/HR09'dan eşitlenir; sunucu kesin kaynaktır. Kurumsal sorumlu `MR_V_CorporateProjectAccess.RoleCode = 'PROJECT_MANAGER'` üzerinden gelir. Veri Tarihi, renk belirteci, takvim ve etiket gibi uygulama üst verisi MERGEN'e aittir. `DataDate` null olabilir: satır zaman damgası değil, ilerleme kesim tarihidir; proje bu tarih kararlaştırılmadan oluşturulabilir. Kurumsal proje güncellemeleri sunucuda `LeadSicil` korur (`CASE WHEN SourceType = 'MANUAL'`); MERGEN alanlarını düzenlemek kurumsal sorumluyu temizleyemez. Manuel proje sorumluları seçilebilir kalır. Süzülmüş benzersiz dizin, null olmayan proje kodlarını korurken kodu null olan birden çok manuel projeyi engellemez.

## WBS şeması ve kurumsal kaynak

`SourceType`, `CORPORATE` veya `MANUAL` olur. Manuel satırlar uygulamada oluşturulur. Kurumsal satırlar farklı veritabanındaki `CN43N` tablosundan özel `MERGEN_ROTA_WBS_DB_*` bağlantısıyla yansıtılır. Kaynak niteliklerini taşırlar: `SourceKey` (`WBS element`), `OutlineCode` (`PYP kodu`), `WbsLevel` (`Level`), `StatusCode` (`Status`), `ElementTypeCode` (`Proj.type`). `CK_MR_WBS_SourceKey`, `SourceKey` alanını yalnızca kurumsal satırlara özgü tutar; süzülmüş benzersiz dizin `(ProjectId, SourceKey)` çiftini eşitlemenin kararlı kimliği yapar.

Proje kökünü her zaman MERGEN üretir: `SourceKey`, `NULL`; kurumsal projede `Code`, proje kodudur. Eşitleme kökü silmez, manuel satırlara dokunmaz; kaybolan kurumsal öğeyi yalnızca ona başvuran alt satır ve görev yoksa siler. Sütun eşlemesi ve eşitleme kuralları `docs/IS-KIRILIM-YAPISI-VE-CALISMA-ALANLARI.md` içindedir.

## Kurumsal WBS eşitleme durumu

`MR_CorporateWbsSyncState`, kurumsal proje kodu başına tek satır saklar: planlanan CN43N düğüm kümesinin SHA-256 parmak izi ve temsil ettiği düğüm sayısı. Anahtar tam proje kodunu tutar; kırpmak aramayı kaçırır (parmak izi birleştirmeyi hiç bastıramaz) ve ortak önekli iki kodun birbirinin satırını ezmesine izin verir. Anlık görüntü yüklemesi; yeniden hesaplanan parmak izi, saklanan düğüm sayısı ve `MR_WBS` içinde gerçekten bulunan kurumsal düğüm sayısı uyuşunca proje için `MR_WBS` birleştirmesini atlar. Tablo iş verisi tutmaz; düşürülmesinin bedeli yalnızca bir tam yeniden eşitlemedir.

## Proje etiket görünümü

Mevcut kalıcı veritabanları bu sütunları, uygulama sürümü dağıtılmadan **önce** çalıştırılan `database/MR_Upgrade_0004_Tag_Appearance_And_Recurrence.sql` ile alır. Temiz oluşturma betiği herhangi bir `MR_*` nesnesi varsa bilinçli olarak durur; canlı veritabanını yükseltemez. Yükseltme betiği yinelenebilir; sütun, kısıt ve dizinleri yalnızca eksikse ekler.

`MR_ProjectTags`, `TagName` yanında `ColorToken varchar(20)` ve `IconKey varchar(40)` taşır. İkisi de null olabilir: `NULL` renk etiket adından belirlenimci palet girdisine, `NULL` simge varsayılana çözülür. Böylece bu sütun çifti öncesinde yazılan satırlar veri geçişi olmadan geçerli kalır. İki değerin kapalı kümelerini `src/domain/tags/index.js` yönetir; kayıt sınırı dışındaki değerleri reddeder (`PROJECT_TAG_COLOR_INVALID`, `PROJECT_TAG_ICON_INVALID`). Bkz. `docs/ETIKETLER-VE-TEKRARLAYAN-GOREVLER.md`.

## Tekrarlayan görev sütunları

`MR_Tasks`, `RecurrenceRule nvarchar(400)`, `RecurrenceParentTaskId uniqueidentifier`, `RecurrenceOccurrenceDate date` taşır. Kural RFC 5545 `RRULE` gövdesidir; yalnızca seri şablonunda bulunur. Oluşumlar şablona `RecurrenceParentTaskId` ile başvurur. `CK_MR_Tasks_Recurrence`, oluşumun kendi kuralı olmamasını zorlar; `CK_MR_Tasks_RecurrenceSelf` kendine başvurmayı engeller; süzülmüş dizin şablon oluşumlarını listelemeyi destekler. `RecurrenceOccurrenceDate`, oluşumun değişmez seri kimliğidir (RFC 5545 `RECURRENCE-ID` karşılığı): oluşumu yeniden zamanlamak bunu değiştirmez. `UX_MR_Tasks_RecurrenceOccurrence`, `(şablon, oluşum günü)` çiftini benzersiz yapar; eşzamanlı iki yazıcı aynı günü üretemez. Kural yazılmadan kanonikleştirilir ve kayıt sınırında katı doğrulanır; ayrıştırılamayan değer veya motorun hiçbir zaman karşılayamayacağı kural kalıcı depoya ulaşmaz.

## Görev öncelik değerleri

`MR_Tasks.Priority`, `low`, `medium`, `high`, `critical` ve eski `normal` değerlerini kabul eder; varsayılan `medium` olur. Uygulama yalnızca katalog tanımlayıcılarını yazar: `normal` arayüz öncelik kataloğunda olmadığından bu değerle saklanan görev Görevler, Kanban ve Raporlar sayfalarında `undefined.color` okunmasına ve istemci çökmesine yol açıyordu. Eski `normal` satırları okunabilir kalır; anlık görüntü projeksiyonunda `medium` olarak kanonikleştirilir.

## WBS ve Görev tutarlılığı

WBS'nin `(ParentWbsId, ProjectId) → (WbsId, ProjectId)` bileşik öz başvurusu, projeler arası üst düğümü önler. Görev, `(WbsId, ProjectId) → MR_WBS(WbsId, ProjectId)` kullanır; projeler arası WBS ataması engellenir. Bağımlılık satırları `ProjectId` taşır; görev ve öncül bileşik yabancı anahtarları tek proje ağını zorlar.

Hesaplanan CPM tarihleri, bolluk, kritiklik bayrakları, WBS zamanlama özetleri, Özet toplamları ve rapor toplamları kalıcı saklanmaz.

## Atamalar ve dış kimlik

Personel ve organizasyonun kesin kaynağı `HR02_rehisRehberwithMasrafYeri`, iş kimliği `sicil` değeridir. Ayrı `MR_People` veya `MR_Employees` ana veri tablosu oluşturulmaz; `MR_V_PeopleDirectory` kurumsal kaynağı yansıtır.

Atamalar `(TaskId, Sicil)` başına tek satır saklar. Virgülle ayrılmış kimlik alanı veya HR02'ye FK kullanılmaz. Sunucu, atama değişikliklerini kaydetmeden önce Sicil'i normalleştirilmiş kişi görünümünden doğrular.

## Tarih değişikliği talepleri

`MR_TaskScheduleChangeRequests`; talep eden/karar sahibi Sicilleri, özgün/önerilen plan başlangıç/bitiş ve hedef bitişi, talep/karar iletilerini, durumu, zaman damgalarını, karar aktörünü, `CreatedAgainstTaskVersion binary(8)` ve kendi rowversion değerini saklar. Durum `PENDING`, `ACCEPTED`, `REJECTED`, `CANCELLED`, `STALE` ile sınırlıdır. Süzülmüş benzersiz dizin, tam karar geçmişini korurken talep eden ve görev başına en fazla bir PENDING talebe izin verir.

Görev yabancı anahtarı silmeyi zincirler; görev kaldırıldıktan sonra talep anlamını koruyamaz. Kabul yalnızca talep satırına güvenmez: işlem tarihleri uygulamadan önce özgün üçlüyü kilitli güncel görevle karşılaştırır, plan değişmişse talebi `STALE` yapar. İlgisiz görev yazımı da rowversion değiştirdiğinden `CreatedAgainstTaskVersion` yalnızca tanı kanıtıdır. Talep oluşturma, kabul, ret/eskime ve sonuç görev güncellemesi mevcut denetim günlüğünü ve güvenilir Sicil kimliğini kullanır.

## Baz plan geçmişi

Baz plan anlık görüntüsü güncel görevden uzun yaşayabilir. Bu nedenle `MR_TaskBaselineSnapshots.TaskId` dizinlidir ama bilinçli olarak `MR_Tasks` FK'si yoktur; oluşturma betiği, bunun unutma sanılmaması için tablo tanımında aynı kararı açıklar. Güncel görevi silmek tarihsel anlık görüntüyü yeniden yazmaz veya sessizce silmez; kısıtı eklemek silmenin sapma geçmişini geriye dönük değiştirmesine izin verirdi. Olağan Görev/WBS değişiklikleri baz plan satırlarını güncellemez.

## Denetim modeli

Kaydedilen her Proje, WBS ve Görev oluşturma/güncelleme/silme aynı işlemde denetim satırı yazar. Tek atomik değişiklik kümesi tek `CorrelationId` kullanır. Oluşturma kayıtlarında `AfterJson`, silmede `BeforeJson`, güncellemede ikisi bulunur. Aktör alanları güvenilir sunucu kimliğinden gelir. Kimlik bilgileri, sırlar, ham SQL ve gereksiz tam İK kaynak kayıtları dışlanır.

## Salt okunur görünümler

### `MR_V_CorporateProjects`

`A01_ProjeUrunFaaliyetRaporu` üzerinden yalnızca şu alanları okur:

- `Tur`
- `Tur_Aciklama`
- `ProjeKodu`
- `ProjeAdi`

Boş kodları süzer ve **normalleştirilmiş** `UPPER(NULLIF(LTRIM(RTRIM(ProjeKodu)), ''))` koduna göre gruplar. Geniş kaynak sütunları veya `SELECT *` kullanılamaz.

Ham sütunlarla gruplama tek `ProjectCode` için birden çok satır üretiyordu: kaynak `' abc '` ve `'ABC'` satırları iki grup oluşturup ikisi de `ABC` oluyordu; bir kodun farklı `ProjeAdi` veya `Tur_Aciklama` değerleri de aynı etkiyi yapıyordu. `UX_MR_Projects_ProjectCode` kod üzerinde benzersiz olduğundan görünüm satırı başına upsert yapan eşitleme ya yinelenen anahtar hatası veriyor ya satır sırasına göre belirsiz proje adı yazıyordu. Bu nedenle kalan sütunlar `MIN(...)` ile toplanır; kod başına tek belirlenimci değer seçilir.

### `MR_V_CorporateProjectAccess`

Her HR09 sorumluluk sütununu `(ProjectCode, Sicil, RoleCode, ProgramMd)` biçimine normalleştirir. `pptsSicil`, `PPTS` rol koduyla `STRING_SPLIT`, kırpma ve `TRY_CONVERT(int, value)` kullanır. Tam belirteçlere ayırma kısmi numarayla yetkilendirmeyi önler.

### `MR_V_ExecutiveScope`

Direktörlük, Müdürlük ve Birim ast kapsamlarının birleşimini doğrudan HR02'den üretir. Kurumsal değişiklikler hiyerarşi MR_* tablolarına kopyalanmadan dinamik yürürlüğe girer.

### `MR_V_PeopleDirectory`

HR02'yi Sicil'e göre normalleştirir; yinelenen Sicil için tek belirlenimci satır seçer. Ekip sırasıyla Birim, Müdürlük, Direktörlük, Sektör yedeğini kullanır. Yinelenen ana veri kaynak sınırında gözlenebilir kalır; yinelenen Person kimliği üretmez.

## Hatırlatma şeması

`MR_ReminderSettings` tam bir satır tutar. Düzenlenebilir e-posta şablonu (`SubjectTemplate`, `BodyTemplate`) ve otomatik ilke (`AutomaticEnabled`, `WindowValue`, `WindowUnit`, `FrequencyValue`, `FrequencyUnit`) burada bulunur; `.env.local` içinde değildir. Çünkü dağıtım yapılandırması değil, yöneticinin düzenlediği uygulama verisidir. Yalnızca SMTP bağlantı ayarları ve zamanlayıcı sırrı ortam değişkenidir. Başlangıç satırı varsayılan Türkçe şablon ve `AutomaticEnabled = 0` ile eklenir; yükseltmeden sonra otomatik hatırlatma e-postaları kapalı kalır. Bu ayar kullanıcının istediği Outlook davetlerini yönetmez.

`MR_TaskReminderLog` iki amaç taşır. Her denemenin denetim geçmişidir (`ReminderKind` = `MANUAL`/`AUTOMATIC`, `Status` = `PENDING` → `SENT`/`FAILED`, `RecipientCount`, `RecipientDigest`, `FailureCode`, `RequestedBySicil`, `CreatedAt`, `CompletedAt`); `PENDING` ve `CompletedAt IS NULL` etkin gönderimdir. `PENDING`, dolu `CompletedAt` ve `RECIPIENTS_PENDING` ise kalıcı alıcı ilerlemesini koruyan, sonraki turda devam edilebilir sonuçtur. `PENDING`, dolu `CompletedAt` ve `MAIL_DELIVERY_UNCERTAIN` terminal belirsizliktir; otomatik yeniden gönderilmez. Ayrıca yinelenen gönderim sahiplenmesidir: otomatik tur SMTP'ye bağlanmadan *önce* belirlenimci `SlotKey` taşıyan satırı `PENDING` ekler, sonra tamamlar. `UX_MR_TaskReminderLog_AutomaticSlot` bu eklemeyi karşılıklı dışlama mekanizması yapar; yeniden başlatmalarda veya aynı zamanlamada yarışan iki örnekte aynı dilim iki kez sahiplenilemez. Gönderimi sonra başarısız olan dilim sahiplenilmiş kalır; yeniden deneme sık döngü yerine sonraki dilimde yapılır.

Ancak `PENDING` satır sonsuza kadar sahiplenilmez. Servisin `catch` bloğu yalnızca JavaScript istisnalarını kapsar; gönderim ortasında biten süreç (dağıtım, yeniden başlatma, makine arızası) önceden dilimi kalıcı sahiplenilmiş bırakıyor, hatırlatma teslim edilemiyordu. Bu nedenle `REMINDER_CLAIM_SQL`, 30 dakikadan eski etkin (`CompletedAt IS NULL`) `PENDING` satırı **yerinde** yeniden sahiplenir: satır yeniden kullanılır, `FailureCode = 'ABANDONED'` işaretlenir ve zaman damgası yenilenir. Böylece süzülmüş benzersiz dizin korunur, ikinci satır oluşmaz. Eşik `SMTP_TIMEOUT_MS` değerinin çok üzerindedir; sürmekte olan gönderim yeniden sahiplenilmez. Kurtarılan satırda alıcı ilerleme protokolü yoksa önceki SMTP sonucu bilinemez; satır terminal belirsizlikle kapatılır ve otomatik yeniden gönderilmez.

**Kalan risk: belirsiz SMTP sonucu tek yinelenen gönderim üretebilir.** Satırı yeniden kullanmak benzersiz dizini korur; *teslimi* idempotant yapmaz. Süreç SMTP iletiyi kabul ettikten sonra ama `SENT` yazılmadan biterse satır `PENDING` kalır; 30 dakika sonra aynı `(TaskId, SlotKey)` yeniden gönderilir ve alıcı hatırlatmayı iki kez alır. Pencere dardır; tercih bilinçlidir: kaçırılmış hatırlatma yinelenenden kötüdür. SMTP aktarıcısının tanıdığı idempotanlık anahtarı olmadan “kabul edildi ama onay kayboldu” ile “hiç kabul edilmedi” ayırt edilemez. Doğru çözüm sonucu *bilinmiyor* kaydedip aktarıcıyla uzlaştırmaktır; bu dizini değil teslim sözleşmesini değiştirir. Yinelemeyi araştıran işletmeci `ABANDONED` kodundan başlamalı, ancak bunu *“sonucu bilinmeyen denemeden sonra dilim yeniden sahiplenildi”* olarak okumalıdır; yinelenen teslimin kanıtı **değildir**. SMTP kabul etmiş olsa da süreç bağlantı kurmadan ölse de aynı kod yazılır. İkisini yalnızca aktarıcının günlüğü ayırır; `ABANDONED` araştırmayı daraltır, sonucu vermez.

Dizin `ReminderKind = 'AUTOMATIC'` ile süzülür; elle gönderimler tamamen dışındadır: kullanıcı aynı görev için bilinçli ikinci hatırlatma gönderebilir. Her satır kararlı kimlik taşısın diye manuel satırlarda da zaman dilimi anahtarı (`manual:<uuid>`) bulunur.

Alıcı adresleri maskeli saklanır (`a***@example.com`). Kesin kaynak her zaman `DC01_userr.EmailAddress` olur; personel e-postası görev kayıtlarına kopyalanmaz.

### Personel e-postası çözümlemesi (`DC01_userr`)

Alıcılar gönderim anında, MERGEN verisi kurumsal kullanıcı dizinine bağlanarak sunucuda çözümlenir:

```
MR_TaskAssignees.Sicil
  → MR_V_PeopleDirectory.Username          (HR02 rehber, kullanici_adi)
  → DC01_userr.Name                        (harf duyarsız eşleşme)
  → DC01_userr.EmailAddress
```

`DC01_userr` salt okunurdur, `MERGEN_ROTA_DB_DATABASE` içinde bulunur ve ona yazılmaz. Şema/tablo adı yapılandırılabilir (`MERGEN_ROTA_USER_DIRECTORY_SCHEMA`, `MERGEN_ROTA_USER_DIRECTORY_TABLE`); farklı dizin nesnesi kullanan kurulum kod değişikliği gerektirmez. Sorgu gözlenen veri kusurlarını tolere eder: eksik dizin satırı, NULL/boş/bozuk adres, aynı adresi paylaşan kullanıcılar, birden çok görünen kullanıcı. Adresler kullanımdan önce doğrulanır ve tekilleştirilir; geçerli adres kalmazsa ileti gönderilmez, çağırana gerekçesi bildirilir.

## Outlook takvim aboneliği şeması

`MR_TaskOutlookSubscriptions`, tek kullanıcının (`UserSicil`: Sicil; görüntüleme adı değil) tek görevin Outlook projeksiyonuna katıldığını kaydeder; posta kutusu/takvim içeriğini doğrulamaz. `(TaskId, UserSicil)` üzerindeki `UX_MR_TaskOutlookSubs_Task_User` idempotanlık mekanizmasıdır: çift tıklama, ikinci sekme ve aynı görevde yarışan ikinci uygulama örneği ikinci takvim öğesi oluşturamaz.

Satır değişmez iCalendar kimliğini (`CalendarUid`) ve revizyon durumunu taşır: `Sequence` ayrılmış en yüksek iCalendar `SEQUENCE`, `PendingSequence`/`PendingPayloadHash` *gönderim için ayrılmış* revizyon, `DeliveredSequence`/`DeliveredPayloadHash` posta katmanının gerçekten kabul ettiği son revizyondur. Gönderim öncesi ayırma tekrarı güvenli yapar: SMTP iletiyi kabul edip tamamlanma yazımı kaybolursa sonraki deneme aynı içerikle **aynı** `SEQUENCE` değerini gönderir; Outlook iki yerine tek revizyon görür.

`CalendarAttendee` ve `CalendarOrganizer`, ilk gönderimden önce ayrılır ve abonelik ömrü boyunca korunur. Tarayıcıya dönmez. İdempotant 0010 geçişi, bu alanları ve `LeaseToken`/`LeaseExpiresAt` değerlerini mevcut tablolara ekler; dağıtımdan önce güncel geçişi yeniden çalıştırın. Kimliği olmayan mevcut satırlar sonraki gönderimde güncel dizin/yapılandırmayı kullanır. Kesin ilk teslim reddi geçici adresleri temizler; kapalı aboneliği açıkça yeniden etkinleştirmek adresleri yeniden çözer; tamamlama/yeniden açma korur.

Aynı satır teslim **çıkış kuyruğudur**. `PendingMethod` (`NULL` / `REQUEST` / `CANCEL`) işi işaretler; kalıcılık işlemi görev değişikliğiyle aynı işlemde yazar, görev kaydı SMTP erişimine bağımlı olmaz. Hatırlatma ayarlarından bağımsız Next.js Node instrumentation kancasıyla başlatılan Outlook çalışanı, zamanı gelen satırları belirlenimci sırada teslimden hemen önce tek tek; `READPAST`, sahiplik `LeaseToken` ve kalıcı `LeaseExpiresAt` ile kiralar. Otomatik çalışanlar, elle tanı turları ve çoklu örnekler aynı daveti eşzamanlı gönderemez; gönderimde ölen süreç satırı sonsuza dek sahiplenmez. `AttemptCount`/`NextAttemptAt`, en fazla bir saatlik geri çekilmeyle tekrarları izler. Yapılandırılmış deneme eşiği HTTP 503 sağlık koşuludur; açık ekle/yeniden gönder/kaldır eylemi durumu sıfırlayana kadar otomatik sahiplenmeyi durdurur. Satır toparlanma için kuyrukta görünür kalır. `QueueSeq` her kuyruğa almada artar; teslim *sırasında* gelen değişiklik o teslimin tamamlanmasıyla sessizce temizlenmez.

`DeliveredSummary` ve `DeliveredDate`, son SMTP kabulü almış gösterimi tutar; tamamlama onun tarihini tamamlanma günüyle karşılaştırır. İptal; silinen veya artık yetkisiz görev içeriğini açıklamadan genel özet, kararlı UID ve saklanan katılımcı/düzenleyiciyi kullanır. Bu nedenle tabloda `MR_Tasks` yabancı anahtarı **yoktur**: `MR_TaskReminderLog` ve 0008 sonrası `MR_TaskScheduleChangeRequests` ile aynı gerekçe. İlk gönderimden sonra abonelik `CalendarAttendee` ve `CalendarOrganizer` adreslerini korur; sonraki güncelleme/iptaller aynı takvim kimliklerini hedefler. Adresler tarayıcıya dönmez. İlk kabul edilmiş veya teslim edilmiş olabilecek gönderimden önce alıcı, yukarıdaki aynı `DC01_userr` zinciriyle `Sicil` üzerinden çözülür.

## Sistem yönetimi telemetri şeması

`MR_Upgrade_0012_System_Observability.sql`, **Sistem Yönetimi** arkasındaki dört tabloyu ekler (`docs/SISTEM-YONETIMI.md`). Tasarım kısıtı gözlemlenebilirliğin kendi başına üretim yükü kaynağına dönüşmemesidir; hiçbir tablo istek başına satır almaz.

`MR_TelemetryOperationSamples`, **uygulama örneği ve beş dakikalık dilim başına, işlem başına tek toplam** saklar: örnek/hata sayısı, süre toplamı/en büyüğü ve sınırlı bellek örnek havuzundan hesaplanan P50/P95/P99. `(BucketStart, Operation, InstanceId)` birincil anahtarı süreçlerin gecikme dağılımını ayırır; örnek bölümü olmadan aynı dilime yazan iki süreç birbirinin yüzdeliklerini ezer, konsol tek sürecin dağılımını bütün sisteminki olarak sunardı. `IX_…_Bucket`, aralık okumalarının tam tablo taramasına gitmesini önler. `MR_TelemetryGaugeSamples`, anlık ölçümler (süreç belleği, kuyruk derinliği, en eski kuyruk yaşı/dakika) için aynı yapıyı `(BucketStart, MetricKey, InstanceId)` anahtarıyla tutar.

İki telemetri tablosu da `LastFlushId` taşır. Aktarım saklanan sayaçlara eklediğinden çağıran belirsiz hata görürken kaydedilen yazma, tekrarda iki kez sayılabilirdi. Birleştirme zaten uyguladığı aktarım kimliğini bu nedenle yok sayar. Dilimler arasında birleştirilen yüzdelikler **ağırlıklı ortalamadır; birleşik örneklerin yüzdeliği değildir**. API bunları yaklaşık işaretler, konsol `≈` ile çizer.

`MR_OperationalEvents`, kalıcı işletim kaydıdır: zaman damgası, önem, bileşen, kararlı olay kodu, okunabilir özet, temizlenmiş ayrıntı, ilişkilendirme kimliği, `OccurrenceCount`, kararlı `AggregationKey`. Özdeş olaylar yazmadan **önce** birleştirilir; sekiz yüz özdeş SMTP hatası sekiz yüz satır yerine sayacı sekiz yüz olan tek satır üretir. Bellek birleşimi yalnızca tek aktarım çevrimini kapsadığından yazma aynı parmak izinin tekrarını sınırlı pencere içindeki en son satıra da katar (`IX_MR_OperationalEvents_Aggregate`). Pencere dışında tekrar yeni satır açar; iki gün arayla iki kesinti geçmişte ayrı görülmelidir.

`MR_OperationalAlerts`; yaşam döngüsü (`OPEN`/`ACKNOWLEDGED`/`RESOLVED`), ilk/son görülme, tekrar sayısı ve alındı onayı veren kişiyle otomatik uyarıları tutar. `AlertKey WHERE State <> 'RESOLVED'` üzerindeki süzülmüş benzersiz `UX_MR_OperationalAlerts_ActiveKey`, tekilleştirme mekanizmasıdır: tek koşul en fazla bir etkin uyarı tutar. Dalgalanan bağımlılık tabloyu doldurmak yerine sayacı artırır; çözülen uyarı geçmişte kalır, tekrar yeni satır açar; her kesintinin başlangıç/bitişi ayrı görünür.

Saklama süresi sınırlıdır (varsayılan 30 gün, `MERGEN_ROTA_TELEMETRY_RETENTION_DAYS`). Telemetri çevrimi küçük gruplarla siler; temizlik uzun tablo kilidi tutmaz. Eksik geçişte uygulama çalışmayı sürdürür, konsol hata vermek yerine eksik şemayı bildirir.

## Atama koordinasyonu şeması

`MR_Upgrade_0015_Assignment_Coordination_And_Presence.sql` beş tablo ekler. Ortak
kural: **hiçbiri gerçek atama ilişkisinin yerine geçmez.** Bir görevin sorumlusu
her zaman yalnızca `MR_TaskAssignees` satırıdır; koordinasyon kaydı beklemedeyken
o satır yazılmaz, dolayısıyla iş yükü, Özet, Kanban, hatırlatma ve Outlook
yalnızca gerçek sorumluyu görür.

`MR_TaskAssignmentCoordinations` bir talebi (`Mode = 'REQUEST'`) ya da
bilgilendirme kaydını (`Mode = 'NOTICE'`) taşır: `TaskId`, `RequesterSicil`,
`RequestedAssigneeSicil`, `SuggestedAssigneeSicil` (yerine kimin önerildiği),
`Status`, istek/karar mesajları, `DecisionBySicil`, `OriginalAssigneeSicils`,
`CorrelationId`, `CreatedAt`/`DecidedAt`, `CreatedAgainstTaskVersion binary(8)`
ve kendi `RowVersion` değeri. Karar penceresinin yeniden çözmek zorunda kalmaması
için referans alanları da saklanır: `TaskTitleSnapshot`, `ProjectIdSnapshot`,
`ProjectNameSnapshot`, `ProjectCodeSnapshot`, `TargetFinishSnapshot`,
`AssigneeNameSnapshot` ve hedef kişinin o andaki birim/müdürlük/direktörlük yolu
(`AssigneeOrgSnapshot`). Bu alanlar *kanıt*tır, yetki kaynağı değildir — karar
anında hem yönetici yetkisi hem görev erişimi canlı veriden yeniden türetilir.
`CreatedAgainstTaskVersion` de aynı biçimde yalnızca tanıdır; bayatlık kararı
kilitlenmiş güncel görevin sorumlu kümesiyle karşılaştırılarak verilir.

Durum kümesi `PENDING`, `APPROVED`, `REJECTED`, `CHANGE_REQUESTED`,
`CANCELLATION_REQUESTED`, `CANCELLED`, `STALE` ile sınırlıdır.
`UX_MR_TaskAssignmentCoordinations_OpenRequest`, `Status IN ('PENDING',
'CANCELLATION_REQUESTED')` üzerinde filtrelidir: bir görev/kişi çifti için aynı
anda en fazla bir **açık** kayıt bulunabilir, ama kapanmış kararların tamamı
geçmişte kalır. Yinelenen bir talep eskisini `CANCELLED` yapar, silmez.
`MR_TaskReminderLog`, `MR_TaskOutlookSubscriptions` ve 0008 sonrası
`MR_TaskScheduleChangeRequests` ile aynı gerekçeyle görev tablosuna yabancı
anahtar **yoktur**: görev silindikten sonra da koordinasyon geçmişi okunabilir
kalmalıdır.

`MR_AssignmentCoordinationRecipients` kaydın kimin gelen kutusunda göründüğünü
tutar: `RecipientRole` (`MANAGER` / `REQUESTER` / `ASSIGNEE`), `ReadVersion`,
`DismissedVersion` ve `UpdatedAt`. Bildirim durumu `MR_ScheduleRequestNotifications`
ile aynı deseni kullanır — saklanan sürüm **koordinasyon satırının**
`RowVersion` değeridir, alıcı satırının kendi sürümü değil; bu yüzden okundu
işaretlemek satırı yeniden okunmamış yapmaz, ama yeni bir karar onu haklı olarak
yeniden okunmamış yapar. Yönetici kümesi HR verisinden küme hâlinde çözülür
(birim ve müdürlük yöneticisi) ve Sicil bazında tekilleştirilir; ad-soyad
eşleşmesi hiçbir aşamada kullanılmaz ve var olmayan bir kimliğe satır yazılmaz.
Bekleyen bir talebin hedefi alıcı satırı almaz: talep geçmişi görev görünürlüğü
vermez.

`MR_TaskNotifications` zil bildiriminin kalıcı kaydıdır: `RecipientSicil`,
`Kind` (`TASK_ASSIGNED` / `TASK_UNASSIGNED`), `TaskId`, `ActorSicil`, görev ve
proje künyesi anlık alanları, toplulaştırılmış olaylar için `TaskCount`,
`EventKey`, `OccurredAt`, `ReadAt`, `DismissedAt`.
`UX_MR_TaskNotifications_RecipientEvent` bu tablonun idempotanlık ilkelidir:
`EventKey` `"<CorrelationId>:<Kind>"` olduğundan aynı kayıt işleminin yeniden
yürütülmesi ikinci satır üretmez ve bir toplu/yinelenen kaydetme alıcı başına tek
satır yazar. Okundu/temizlendi burada **zaman damgasıdır, sürüm değildir**: bu
satırın karşılaştırabileceği bir üst kayıt yok, kendi `RowVersion` değerine karşı
sürüm saklamak ise okundu işaretinin sürümü yükseltip satırı anında yeniden
okunmamış yapmasına yol açardı. Güncellemeler `COALESCE` ile tek yönlüdür, böylece
geç gelen eski bir işlem yeni bir olayı temizleyemez.

`MR_TaskMailOutbox` isteğe bağlı "Sorumlulara e-posta bildirimi gönder" kutusunun
dayanıklı kuyruğudur: `Kind`, `TaskId`, `RecipientSicil`, gönderim için gereken
anlık künyeyi taşıyan `PayloadJson`, `DedupeKey`, `Status`
(`PENDING`/`SENT`/`FAILED`), `AttemptCount`, `NextAttemptAt`, `LeaseExpiresAt`,
`LeaseToken`, `LastFailureCode`, `SentAt`. `UX_MR_TaskMailOutbox_DedupeKey`
(`"<CorrelationId>:<TaskId>:<RecipientSicil>"`) aynı değişikliğin iki kez kuyruğa
girmesini engeller; `IX_MR_TaskMailOutbox_Due` tarama maliyetini tüm tabloya
değil kuyruktaki işe orantılı tutar. Satır kayıt işlemiyle **aynı veritabanı işlemi**
içinde yazılır, SMTP ise ayrı bir çalışan tarafından tüketilir: `api.commit`
hiçbir koşulda posta sunucusunu beklemez. Çalışan satırı `LeaseExpiresAt` ve
`LeaseToken` ile kiralar: her teslimat uçtan uca bir bütçeyle (SMTP zaman
aşımının iki katı) kesilir, kira süresi parti boyu × bu bütçeden türetilir,
üst sınıra sığmayan parti daraltılır, kira içinde bitemeyecek teslimat hiç
başlatılmaz ve tur sonundaki durum yazması yalnızca kirayı hâlâ elinde tutan
örnekten kabul edilir — böylece kira süresi içinde çok örnekli dağıtımda aynı
ileti iki kez gönderilmez. Tam olarak bir kez teslimat garanti edilmez: SMTP
kabulü ile `SENT` yazımı arasında çalışan durursa ya da durum yazması başarısız
olursa satır kira dolunca yeniden kiralanır ve ileti yeniden gönderilebilir. Yeniden deneme üstel geri çekilme ile
yapılır ve deneme eşiği dolduğunda satır `FAILED` olarak **kalır** — kaybolmaz,
`LastFailureCode` ile incelenebilir. Bağlantı ileti gövdesi aktarıldıktan sonra
kabul yanıtı okunmadan koparsa satır doğrudan `FAILED` /
`MAIL_DELIVERY_UNCERTAIN` olur ve kendiliğinden yeniden denenmez: posta sunucusu
iletiyi kabul etmiş olabilir.

`MR_UserPresence` Sicil başına tek satır tutar: `FirstSeenAt`,
`SessionStartedAt` ve `LastSeenAt`. Satır sayısı kullanıcı sayısıyla sınırlıdır,
istek sayısıyla değil: nabız 90 saniyede bir ve yalnızca sekmeler arası kilidi
tutan tek sekmeden gönderilir, hiçbir olağan istek yan etki olarak varlık
yazmaz. `IX_MR_UserPresence_LastSeenAt` "son 3 dakika" penceresini sıralı okur ve
sorgu sonuç sayısı da sınırlıdır.

Beş tablonun tamamı yokken uygulama çalışmaya devam eder: sorgular eksik şemayı
tanır, ilgili yüzey boş döner ve görev kaydetme etkilenmez.

## Dizinlerin gerekçesi

- Proje/durum ve proje/tarih dizinleri görev listeleri, süzgeçler, Gantt ve hedef tarih sırasını destekler.
- WBS proje/üst/sıra dizini ağaç gezinmesini destekler.
- Sorumlu Sicil/görev dizini kendi görevi ve yönetici görünürlüğünü destekler.
- ProjectAccess Sicil/etkinlik/erişim dizini yetki yüklemesini destekler.
- Bağımlılık öncül dizini ilişki doğrulama ve açık silme temizliğini destekler.
- Baz plan proje ve anlık görüntü görev dizinleri proje geçmişini ve silinmiş görev aramasını destekler.
- Denetim dizinleri proje, aktör, varlık ve işlem ilişkilendirme araştırmalarını destekler.
- Hatırlatma günlüğünün görev/zaman dizini gönderim geçmişini destekler; süzülmüş benzersiz zaman dilimi dizini okuma iyileştirmesi değil, yinelenen gönderim korumasıdır.
- Outlook abonelik dizinleri de amaca göre ayrılır: benzersiz `(TaskId, UserSicil)` yinelenen aboneliği önler; süzülmüş bekleyen dizini çıkış taramasını bütün tablo yerine kuyruktaki işle orantılı tutar; kullanıcı/etkinlik dizini çekmece ve görev tablosunun “eklendi” durumunu tek aramayla sunar.
- Telemetri dizinleri aynı ayrımı izler: `IX_MR_TelemetryOperationSamples_Bucket` ve `IX_MR_TelemetryGaugeSamples_Metric`, sınırlı aralık sorgularında okuma iyileştirmesidir; `UX_MR_OperationalAlerts_ActiveKey` okuma yolu değil doğruluk kısıtıdır (koşul başına tek etkin uyarı). İşletim olayı dizinleri konsolun iki gerçek süzgecine hizmet eder: en yeniden başlayan zaman aralıkları ve bileşen bazlı ayrıntı.
- Koordinasyon, bildirim, posta ve varlık dizinleri de koruma/okuma ayrımını sürdürür. `UX_MR_TaskAssignmentCoordinations_OpenRequest`, `UX_MR_TaskNotifications_RecipientEvent`, `UX_MR_TaskMailOutbox_DedupeKey` doğruluk kısıtıdır: görev/kişi başına tek açık kayıt, olay/alıcı başına tek bildirim, değişiklik/alıcı başına tek kuyruk postası. Diğerleri sınırlı sorgu iyileştirmesidir: `IX_…_TaskStatus`, `IX_…_RequesterStatus`, `IX_MR_AssignmentCoordinationRecipients_Sicil`, Talepler sayfasının sunucu sayfalamasına ve koordinasyon gelen kutusuna; `IX_MR_TaskNotifications_RecipientOccurred` zil önizlemesine; `IX_MR_TaskMailOutbox_Due` kuyruk işiyle orantılı boşaltmaya; `IX_MR_UserPresence_LastSeenAt` üç dakikalık varlık penceresine hizmet eder. Hiçbiri anlık görüntü veya kayıt yolunda okunmaz.

Dizinler her sütuna oluşturulmak yerine kanıtlanmış depo ve arayüz sorgu örüntüleriyle sınırlıdır.

Anlık görüntü ana sorgusu, görev başına yetki kararını satır başına yeniden türetmek yerine bir kez hesaplayıp geçici tabloda taşıyacak biçimde düzenlendi. Yeni kalıcı erişim yolu eklenmedi: `MR_Tasks.CreatedBySicil = @sicil`, `IX_MR_Tasks_CreatedBySicil`; `MR_TaskAssignees.Sicil = @sicil` ve yönetici kapsamı aramaları, `IX_MR_TaskAssignees_Sicil_Task`; `TaskId → ProjectId` araması, mevcut `UX_MR_Tasks_Id_Project` benzersiz kısıtı (ek anahtar araması gerekmez); proje yetkileri `IX_MR_ProjectAccess_Sicil_Active_Level`; kısmi WBS üst düğüm gezinmesi `PK_MR_WBS` ve `IX_MR_WBS_Project_Parent_Sort` ile karşılanır. Sorgunun geçici tablolarına sonraki her arama birincil anahtarlardan geçer; `#Directory`, `IX_Directory_Sicil` kümelenmiş dizinini korur. Yeniden düzenlenen koşulların hiçbiri desteksiz kalmadığından yeni dizin/geçiş eklenmedi; sırf yardımcı olabilir diye dizin oluşturulmaz. Tam analiz ve üretim doğrulama yöntemi için `docs/SISTEM-YONETIMI.md` belgesine bakın.

## Oluşturma ve geri alma

Mevcut MERGEN nesnelerini şu betikle kaldırın:

`database/MR_Rollback_Durable_Persistence.sql`

Ardından güncel şemanın tamamını şu betikle oluşturun:

`database/MR_Create_Durable_Persistence.sql`

Oluşturma betiği kaynak tabloları ön denetler, MR_* nesneleri zaten varsa hemen durur, işlem ve TRY/CATCH kullanır, `MR_V_CorporateProjectAccess` görünümünü doğrudan `PPTS` rol koduyla oluşturur, varsayılan takvimi ve `@SystemAdminSicils` üzerinden SYSTEM_ADMIN rollerini ekler (varsayılan boş; gerçek Siciller kişisel veridir ve depoya kaydedilmez), `0001_durable_persistence` kaydını yazar.

Görev hatırlatmalarını `database/MR_Upgrade_0005_Task_Reminders.sql` ekler; idempotanttır, yeniden çalıştırılabilir: `MR_ReminderSettings` ve `MR_TaskReminderLog` yalnızca yoksa oluşturulur, tek ayar satırı otomatik gönderim kapalı eklenir, süzülmüş benzersiz zaman dilimi dizini kurulur ve `0005_task_reminders` kaydedilir. Mevcut veriye dokunulmaz. Yeni kurulumda `MR_Create_Durable_Persistence.sql` aynı nesneleri oluşturur; `MR_Rollback_Durable_Persistence.sql` ters sırada kaldırır.

Outlook takvim aboneliklerini `database/MR_Upgrade_0010_Outlook_Calendar_Subscriptions.sql` ekler. Geçiş idempotanttır; `MR_TaskOutlookSubscriptions` ve dört dizinini oluşturur/genişletir, `0010_outlook_calendar_subscriptions` kaydeder, ihtiyatlı yaşam döngüsü tamamlamalarıyla mevcut abonelikleri korur. Uygulama dağıtılmadan **önce** çalışmalıdır; o zamana kadar özellik görev kayıtlarını başarısız kılmak yerine kullanılamadığını bildirir. Yeni kurulum aynı nesneyi `MR_Create_Durable_Persistence.sql` içinde oluşturur; geri alma önce onu kaldırır. Bkz. `docs/OUTLOOK-TAKVIM.md`.

Sistem yönetimi telemetrisi `database/MR_Upgrade_0012_System_Observability.sql` ile eklenir. İdempotanttır; dört tablo ve dizinlerini yalnızca yoksa oluşturur, `0012_system_observability` kaydeder, mevcut veriye dokunmaz. `0011` **sonrasında** çalışır. Yeni kurulum aynı nesneleri `MR_Create_Durable_Persistence.sql` içinde oluşturur; geri alma Outlook tablosundan önce kaldırır. Geçiş yapılana kadar Sistem Yönetimi kullanılabilir kalır; hata yerine “telemetri tabloları bulunamadı” bildirir. Bkz. `docs/SISTEM-YONETIMI.md`.

Tarih değişikliği talepleri `database/MR_Upgrade_0007_Task_Schedule_Change_Requests.sql` ile eklenir. Geçiş idempotanttır; yalnızca eksik tablo/dizinleri oluşturur, `0007_task_schedule_change_requests` kaydeder, mevcut görevleri yeniden yazmaz. Yeni kurulum aynı nesneyi `MR_Create_Durable_Persistence.sql` içinde oluşturur; geri alma görev satırlarından önce kaldırır.

Görev oluşturucu dizini `database/MR_Upgrade_0014_Task_Creator_Index.sql` ile eklenir. İdempotanttır; `IX_MR_Tasks_CreatedBySicil ON dbo.MR_Tasks(CreatedBySicil) INCLUDE (ProjectId)` yalnızca yoksa oluşturulur, `0014_task_creator_index` kaydedilir, veriye dokunulmaz. `0013` **sonrasında** çalışır. `MR_Tasks.CreatedBySicil = @sicil`, yetki bağlamı yüklemesinin (her anlık görüntü/kayıt), anlık görüntünün kendi kapsam proje kümesinin ve yetkili değişiklik yanıtının görev kapsamlı proje görünürlüğünün koşuludur. Diğer hiçbir `MR_Tasks` dizini bu sütunla başlamaz veya onu içermez; koşul önceden kullanıcının görevleri yerine toplam görev sayısıyla büyüyen tam tablo taraması gerektiriyordu. Dizin dardır (`int` anahtar ve `ProjectId`); `MR_Tasks` tek satırlı etkileşimli değişikliklerle yazıldığından yazma ek yükü sınırlıdır. Geçişe kadar sorgular doğru kalır, yalnızca dizin aramasını kaybeder. Yeni kurulum aynı dizini `MR_Create_Durable_Persistence.sql` içinde oluşturur; geri alma tabloyla kaldırır.

Atama koordinasyonu, görev bildirimleri, atama posta çıkış kuyruğu ve kullanıcı varlığı `database/MR_Upgrade_0015_Assignment_Coordination_And_Presence.sql` ile eklenir. İdempotanttır; beş tablo/dizinini yalnızca yoksa oluşturur, `0015_assignment_coordination_and_presence` kaydeder, mevcut veriye dokunmaz. `0014` **sonrasında** çalışır. Yeni kurulum aynı nesneleri `MR_Create_Durable_Persistence.sql` içinde oluşturur; geri alma telemetri tablolarından önce kaldırır. Geçişe kadar uygulama tamamen kullanılabilir: bölüm dışı atama mevcut doğrudan atama kurallarına döner, zil yalnızca tarih taleplerini gösterir, isteğe bağlı atama e-postası etkisizdir, **Aktif Kullanıcılar** hata yerine eksik şema bildirir. Bkz. `docs/TALEPLER-VE-BILDIRIMLER.md` ve `docs/SISTEM-YONETIMI.md`.

Kişisel AI API anahtarlarını `database/MR_Upgrade_0016_Ai_User_Credentials.sql` ekler. İdempotanttır; `MR_AiUserCredentials` yalnızca yoksa oluşturulur. Mevcut tablonun yapısını doğrular: `IDENTITY`/hesaplanan sütun bulunmaması ve uygulamanın dolduramayacağı ek zorunlu sütun olmaması dahil sütunlar, etkin `Sicil` birincil anahtarı, aynı ifadelerden oluşturulan geçici tabloyla karşılaştırılan denetim kısıtı ve varsayılan *tanımları*. Uyumsuz tablo üzerine geçiş kaydı yazmayı reddeder; `0016_ai_user_credentials` kaydeder, mevcut veriye dokunmaz. `0015` **sonrasında** çalışır. Tablo yalnızca AES-256-GCM zarfını (şifreleme sürümü, gizli olmayan ana anahtar kimliği, 12 bayt nonce, şifreli metin, 16 bayt doğrulama etiketi), görüntülenecek son dört karakteri ve son açık doğrulama sonucunu saklar. Nonce her kayıtta yenilenir; korumalı silme/doğrulama yazmalarında anahtar malzemesi kimliğidir (`rowversion` doğrulama üst verisinde de ilerlediğinden bu korumada kullanılmaz). API anahtarının düz metin hâli saklanmaz; tabloda konuşma geçmişi, istem veya yanıt yoktur. 0017 geçişi kullanıcı/asistan metnini ayrı `MR_AiConversationMessages` içinde saklar. Her deyim güvenilir oturumun `@sicil` değeriyle sınırlıdır; şifreli metin doğrulanan ek veri olarak Sicil'e bağlanır, başka Sicil'e kopyalanan satır çözülemez. Yeni kurulum aynı tabloyu `MR_Create_Durable_Persistence.sql` içinde oluşturur; geri alma önce kaldırır. Geçişe kadar uygulama kullanılabilir: ayarlar kartı kişisel anahtarların kullanılamadığını bildirir, kayıt açıkça reddedilir, kurumsal varsayılan anahtar çalışır. Bkz. `docs/YAPAY-ZEKA-PLATFORMU.md`.

Rota AI konuşma geçmişini `database/MR_Upgrade_0017_Ai_Assistant_Conversations.sql` ekler. `0016` **sonrasında** çalışır (aksi durumda 51017 ile durur); idempotanttır. `MR_AiConversations`, `MR_AiConversationMessages` ve dizinlerini yalnızca yoksa oluşturur. Mevcut tabloların yapısını doğrular: `IDENTITY`/hesaplanan sütun olmadan sütun tür/uzunluk/null olabilirliği, ek zorunlu sütun olmaması, sıra/yön dahil anahtar ve dizin sütunları, süzülmüş benzersiz dizinlerin süzgeç *tanımları*, zincirleme ve güvenilir yabancı anahtar, aynı ifadelerle kurulan geçici tablolarla karşılaştırılan denetim kısıtı ve varsayılan *tanımları*. Uyumsuz yapıya geçiş kaydı yazmayı reddeder; `0017_ai_assistant_conversations` kaydeder, mevcut veriye dokunmaz. Betik süzülmüş dizinlerin gerektirdiği tam oturum seçeneği listesini ayarlar. Anlamı:

- her konuşma güvenilir oturumun Sicil'ine aittir (`OwnerSicil`); her deyim `OwnerSicil = @sicil` ile sınırlı sabit metindir; başka Sicil'in konuşmasını okuma, ekleme ve silme, eksik konuşmayla aynı davranır;
- kullanıcı iletisi üretimden **önce** kısa işlemde yazılır; asistan iletisi yalnızca yanıt **tamamlandığında** ikinci kısa işlemde yazılır; model üretirken SQL bağlantısı/işlemi tutulmaz;
- `UX_…_OwnerOrigin`, yeniden gönderilen ilk turda aynı konuşmayı açar; `UX_…_Turn` yeniden gönderilen turda kullanıcı iletisini kullanır; `UX_…_Reply` kullanıcı turu başına en fazla bir yanıt sağlar;
- `Content`, denetim kısıtıyla sınırlı `nvarchar(max)` olur; başlıklar belirlenimcidir (ilk iletiden türetilir, model çağrısı yoktur); `datetime2(3)` zaman damgaları anahtar tabanlı sayfalamayı kesin tutar;
- konuşmayı silmek iletileri siler (`ON DELETE CASCADE`).

Yeni kurulum aynı tabloları `MR_Create_Durable_Persistence.sql` içinde oluşturur; geri alma `MR_AiUserCredentials` öncesinde önce iletileri, sonra konuşmaları kaldırır. Geçişe kadar uygulama tamamen kullanılabilir kalır; yalnızca Rota AI uçları modeli çağırmadan `AI_CONFIGURATION_ERROR` (`CONVERSATION_SCHEMA_MISSING`) bildirir. Bkz. `docs/YAPAY-ZEKA-PLATFORMU.md` §18.

Rota AI kanıtını `database/MR_Upgrade_0018_Ai_Message_Evidence.sql` ekler. `0017` **sonrasında** çalışır (aksi durumda 51018 ile durur); idempotanttır. `MR_AiMessageEvidence` yalnızca yoksa oluşturulur; mevcut tablo doğrulanır (sütunlar, ek zorunlu sütun olmaması, `(MessageId, Ordinal)` birincil anahtarı, `MR_AiConversationMessages` tablosuna güvenilir `ON DELETE CASCADE` yabancı anahtarı, denetim kısıtı ve varsayılan *tanımları*). Uyumsuz yapıya geçiş kaydı yazmayı reddeder; `0018_ai_message_evidence` kaydeder, mevcut veriye dokunmaz. Anlamı:

- yalnızca yanıtın gerçekten **atıf yaptığı** kanıt saklanır; doğrulamadan sonra asistan iletisiyle **aynı kısa işlemde** yazılır. Model veya araçlar çalışırken SQL işlemi tutulmaz;
- sahiplik devralınır: her okuma güvenilir Sicil'in kendi konuşmasına bağlanır (`OwnerSicil = @sicil`). Tarayıcıya yalnızca `SummaryJson` (güvenli özet: tür, etiket, veri zamanı, tamlık bayrakları, sayılar, en fazla altı öne çıkan bilgi) döner; `EvidenceJson` yeniden üretilebilirlik için modele verilen güvenli araç sonucu zarfını tutar, hiçbir uçtan açıklanmaz;
- kanıt ileti ve konuşmayla silinir (`ON DELETE CASCADE`); ayrı saklama süresi yoktur;
- kanıta dayandırma hatalı yanıt (`FinishReason = 'grounding_failed'`) kanıt saklamaz.

Yeni kurulum aynı tabloyu `MR_Create_Durable_Persistence.sql` içinde oluşturur; geri alma konuşma tablolarından önce kaldırır. Geçişe kadar uygulama tamamen kullanılabilir. `MERGEN_ROTA_AI_TOOLS_ENABLED=true` iken Rota veri kaynağı modeli çağırmadan sabit kullanılamıyor yanıtı verir; kullanıcı açıkça Genel sohbet seçebilir. Bkz. `docs/YAPAY-ZEKA-ALAN-ARACLARI.md` §13.

İlk kurumsal proje eşitlemesinde depo `MR_Projects.LeadSicil` değerini `PROJECT_MANAGER` rolünden doldurur. Uygulama temiz veritabanı yeniden oluşturmayla sınanırken ayrı `0002` geçiş betiği gerekmez.

Geri alma MERGEN verisi için bilinçli olarak yıkıcıdır; görünüm ve tabloları bağımlılığa güvenli ters sırada kaldırır, yeniden çalıştırılabilir; HR02, A01 veya HR09'u düşürmez/değiştirmez.

## Kimlik doğrulama ve şema

Keycloak kimlik doğrulaması **şema değişikliği gerektirmedi**. Yalnızca kimlik sağlayıcısını değiştirir: doğrulanmış `sicil` beyanı (veya isteğe bağlı `preferred_username → MR_V_PeopleDirectory.Username → Sicil` araması), zaten mevcut aynı `loadAuthorizationContext()` sorgusunu besler.

Kullanıcı adı yedeğinde `MR_V_PeopleDirectory`, tam bir Sicil döndürmesi gereken parametreli sorguyla okunur; belirsiz sonuç yetki vermez. `0003_keycloak_identity` geçiş satırı bu aşamayı ve parametreli SYSTEM_ADMIN başlangıcını kaydeder.

Üretilen kullanıcı fotoğrafı URL'leri sunum verisidir; hiçbir tabloda **saklanmaz**. Çizim anında yapılandırılmış temel URL ve personel numarasından türetilir.


## Talep bildirimleri ve geçmişin saklanması

`0008_request_notifications` yükseltmesi `MR_ScheduleRequestNotifications` tablosunu ekler. `(RequestId, Sicil)` anahtarı; `ReadVersion binary(8)`, `DismissedVersion binary(8)` ve `UpdatedAt datetime2(7)` ile bildirim durumu ayrı tutulur. Talep `RowVersion` değeri değişince yeni olay okunmamış olur. Talep satırının sürümü okundu/temizle nedeniyle değişmez.

Talep tablosuna `TaskTitleSnapshot nvarchar(1000)`, `ProjectIdSnapshot uniqueidentifier`, `ProjectNameSnapshot nvarchar(1000)` ve `ProjectCodeSnapshot nvarchar(100)` eklenir; mevcut kayıtlar doldurulur. Görevden talebe silme zinciri kaldırılır. Görev silinirken açık talepler STALE olur; tamamlanan talepler ve denetim geçmişi korunur. Bildirim tablosu yalnızca kalıcı talebe yabancı anahtar taşır. Ana oluşturma/geri alma betikleri aynı nesne kümesini kapsar. Ayrıntılar: [Talepler ve bildirimler](TALEPLER-VE-BILDIRIMLER.md).


### Görev hareket raporu dizini

`0009_task_activity_report`, mevcut MR_AuditLog üzerine `IX_MR_AuditLog_Type_Occurred(EntityType, OccurredAt DESC, AuditId DESC)` dizinini ekler; ActorSicil, ProjectId, EntityId, CorrelationId, ActionCode alanlarını kapsar. Ayrı hareket tablosu yoktur. Görev denetiminde kalıcı satır, sorumlu Sicilleri ve tarihsel proje künyesi saklanır; eski kayıtlar yeniden yazılmaz. [Sorgu ve tarihçe sözleşmesi](GOREV-HAREKET-RAPORU.md).

Güncel 0010 ayrıca `CancelRequested` (açık kaldırma), `ForceResend` (kalıcı yeniden gönderme niyeti), `DeliveryMayHaveEscaped` (olası SMTP kabulü), `LastValidatedAt` (sınırlı dönemsel yetki doğrulaması) ekler. Mevcut bekleyen iptaller ihtiyatla açık iptal sayılır; ayrılmış/teslim edilmiş revizyonlar olası teslim işaretlenir. `IX_MR_TaskOutlookSubs_Revalidation`, temiz etkin satırları doğrulama zamanına göre kapsar. Kiralar 60 saniyedir, 20 saniyede yenilenir; SMTP ve teslim SQL yürütmesi tur bütçesinde kesilir (varsayılan 45 saniye). Sonlandırma istisnadır: `deliverSubscription`, her kalıcı işlem için yeni ve bağımsız beş saniyelik süre sınırıyla `completeOutlookDelivery`, `failOutlookDelivery` çalıştırır. Tamamlama zaman aşımı, tekrar kaydı için kullanılabilir hata yazma süresi bırakır. Otomatik turlar varsayılan 45 saniyelik çıkış bütçesinden önce SQL edinimine 15 saniye daha ayırır: tek sonlandırmayla en fazla 65, zaman aşan tamamlama hata yazımı gerektirirse 70 saniye. Geçişten önce eski çalışanları durdurun, sonra güncel uygulamayı başlatın.

Tamamlanma yaşam döngüsü güncel 0010 sonrasında `MR_Upgrade_0011_Outlook_Completion_Lifecycle.sql` gerektirir; temiz oluşturma aynı şemayı içerir. Başlangıçta ve her tamamlanan turdan sonra (varsayılan 5 saniye) aynı kira/revizyon sorgularıyla zamanı gelen satırlar boşaltılır; veritabanı bağlantı hatası sonraki turları durdurmaz. `OUTLOOK_COMPLETE_SQL`, etkilenen aboneliği döndürür; sahiplik kaybı kaydedilmiş teslim değil `OUTLOOK_LEASE_LOST` bildirilir. Kuyruk durumu görev/alıcı açıklamadan bekleyen, zamanı gelen, kiralı, başarısız ve eşiği aşan satırları toplar. Sayaçlar ortak veritabanından gelir; son çalışan sonuçları kalıcı teslim geçmişi değil sürece yerel tanıdır. Yalnızca SYSTEM_ADMIN erişimli GET `/api/mergen-rota/reminders/run` bu ayrımı sunar.

### Outlook tamamlanma yaşam döngüsü (0011)

`CompletionDate date NULL`, tamamlanma geçişinin yerel iş gününü saklar; SMTP kesintisi veya yeniden başlatma aynı gün iptalini atlanan tarihsel tamamlanmaya dönüştüremez. Yeniden açma teslimi aynı QueueSeq korumasıyla temizler. `CompletionSuspended bit NOT NULL DEFAULT 0`, tamamlanmış görevin abonelik tercihini korur. Tamamlama bunu görev işleminde ayarlar; çalışan başlamadan hızlı tamamla/yeniden aç geçişleri de dahildir. `IsActive` tamamlamada true kalır; yalnızca kaldırma, silme, erişim kaybı veya geçersiz etkin takvim içeriği işlenince false olur. Tarihsel tamamlanma gönderimsiz sonuçlanır. Yeniden açma aynı UID ve daha yüksek SEQUENCE ile REQUEST gönderir; askıyı yalnızca QueueSeq hâlâ eşleşiyorsa temizler.

`DeliveredMethod varchar(10) NULL`, son SMTP kabulü almış REQUEST/CANCEL değerini ayırır; posta kutusu durumu değildir. `PendingDate date NULL`, ayrılan revizyona eşlik eder; güncel görev tarihi değişse de belirsiz/sürmekte olan gelecek REQUEST iptal edilebilir. `LastCancellationReason varchar(60) NULL`, sorun giderme için `TASK_COMPLETED`, `USER_REMOVED`, `TASK_NOT_FOUND`, `FORBIDDEN` veya takvim doğrulama nedenini korur. SQL ayırma, tamamlama, etkin dışı bırakma ve sonuçlandırma kira/QueueSeq korumasını sürdürür; sonraki niyet eski teslimle temizlenemez. Alıcı/düzenleyici ve UID tamamlama/yeniden açmada kararlı kalır.

İdempotant geçiş, UID/SEQUENCE yeniden yazmadan veya etkin dışı aboneliği açmadan null olabilen/varsayılanlı alanlar ekler. Mevcut teslim yöntemleri etkin durumdan ihtiyatla çıkarılır; önceki bekleyen tarih mevcut görev/teslim tarihlerinden başlatılır. Geçişte eski çalışanları durdurun, ardından güncel uygulamayı dağıtın. Göreve yabancı anahtar eklenmez; iptal geçmişi silinmeden sonra korunur.

Outlook teslimi açık olduğunda SMTP (`SMTP_HOST`, geçerli `SMTP_FROM`, kurumsal taşıma ayarları) zorunludur. Yalnızca hem e-posta hatırlatması hem Outlook teslimi kapalıysa isteğe bağlıdır. Eksik yapılandırma davetleri kuyrukta bırakır. Ayrı hatırlatma zamanlayıcısı Outlook için isteğe bağlıdır.


### 0019 · Sunucu tarafından verilen oluşturma kimlikleri

`database/MR_Upgrade_0019_Creation_Allocations.sql`, 0018 sonrasında ve yeni uygulama dağıtılmadan **önce** çalıştırılır. `MR_CreationAllocations`, Sicil/varlık türü/hedef projeye bağlı tek kullanımlık oluşturma onaylarını saklar (`Proof`, `Sicil`, `EntityType`, `EntityId`, `ProjectId`, `ExpiresAt`). Henüz oluşturulmamış projeye bağlanabildiğinden varlık/personel yabancı anahtarı yoktur; kayıt hiçbir yazma veya görünürlük yetkisi vermez. Süre 24 saat, çağıran başına etkin onay sınırı 4.000, saklanan tüm onay ve makbuzların toplam sınırı 16.000'dir; temizlik mevcut ayırma işlemi içinde çağıranla sınırlı ve en fazla 4.000 satırdır. Aynı onay ancak bir SERIALIZABLE kayıt işlemiyle tüketilebilir; geri alma onayı da geri getirir. Başarılı işlem onayı siler. `release-creation-ids`, tüketilmemiş onayı iptal eder; süresi dolan veya iptal edilen satırlar, yanıtı kaybolan bırakma isteklerinin güvenle yinelenebilmesi için 7 gün boyunca çağırana bağlı tüketilmemişlik makbuzu olarak tutulur; sonraki ayırmalarda bu süreyi aşan makbuzlar temizlenir. Görev/proje sonradan silinse bile eski onay yeniden oluşturma yetkisi vermez.

Geçiş yinelenebilir ve işlemseldir; mevcut sütun, anahtar/dizin ve tür kısıtı tanımlarını doğrular. Yeni kurulum aynı tabloyu oluşturur, tam geri alma kaldırır. Şema yoksa oluşturma kontrollü 503 döner; eski istemci kimliklerine geçiş yapılmaz. Yeni sunucu tüm örneklere dağıtıldıktan sonra yeni istemci varlıkları sunulmalıdır. Yeni istemcinin ayırma isteği eski sunucuda `changes: {}` nedeniyle yazma yapmaz; eski istemci yeni sunucuda onaysız oluşturamaz. Mevcut görev/proje/WBS satırları ve sürümlü güncelleme/silme kuralları değiştirilmez. Protokol ve F-024 kanıtı: `docs/SECURITY-DEEP-SCAN-2026-10-28.md`.
