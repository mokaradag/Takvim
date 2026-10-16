# MERGEN Rota Yetkilendirme Modeli

Yetkilendirme, güvenilir Sicil kimliğiyle Next.js sunucusunda değerlendirilir. İstemci yetenek bayrakları kullanılabilirliği iyileştirir; güvenlik sınırı değildir. Her değişiklik SQL işlemi içinde yeniden yetkilendirilir.

## Öncelik sırası

1. **SYSTEM_ADMIN** — bütün projelere ve işlemlere tam erişim.
2. **FULL_PROJECT_ACCESS** — HR09 sorumluluğu, etkin `MR_ProjectAccess` FULL yetkisi veya etkin manuel projede seçili proje sorumlusu olma üzerinden tek projeye tam erişim.
3. **TASK_CREATOR_SCOPE** — yetkili `MR_Tasks.CreatedBySicil` ile tanımlanan tek görevde sınırlı sahiplik; proje erişimine dönüşmez.
4. **EXECUTIVE_SCOPE** — ast çalışanlara atanmış görevlerde salt okunur görünürlük.
5. **ASSIGNEE_SCOPE** — güncel kullanıcıya atanmış görevlerde görev düzeyi iş düzenleme ve böyle yetkili atamanın bulunduğu projelerde yalnızca kendine atanan görev oluşturma.
6. **VARSAYILAN RET**.

Aynı proje kısmi kaynaktan da görünür olduğunda FULL her zaman önceliklidir.

## SYSTEM_ADMIN

Sistem yöneticileri ön yüz kodunda değil, `MR_UserRoles` içinde saklanır. Oluşturma betiği, kuran yöneticinin çalıştırmadan önce doldurduğu `@SystemAdminSicils` parametresinden başlangıç yöneticilerini ekler; gerçek Siciller kişisel veridir ve depoya kaydedilmez. Boş liste yönetici eklemez. Etkin olmayan rol satırı yetki vermez.

SYSTEM_ADMIN hiçbir zaman Keycloak `resource_access` rollerinden türetilmez. Belirteç herhangi bir realm veya istemci rolü taşıyabilir; MERGEN Rota yönetim hakkını yine yalnızca `MR_UserRoles` üzerinden okur.

SYSTEM_ADMIN bütün projeleri görebilir/değiştirebilir, manuel proje oluşturabilir. Boş manuel projeyi etkin dışı da yapabilir. Hiçbir `MR_Tasks` satırı projeye başvurmuyorsa proje boştur; kök WBS, erişim, etiket ve denetim satırları onu dolu saydırmaz. Kurumsal projeler ve tek görev bile içeren manuel projeler bu işlemle silinemez.

### Yönetim yüzeyi

`docs/SISTEM-YONETIMI.md` içinde anlatılan işletim konsolu **Sistem Yönetimi** yalnızca SYSTEM_ADMIN rolüne açıktır. Tek yönetim girişidir: önceden bağımsız gezinme öğesi olan hatırlatma yapılandırması artık sekmelerinden biridir.

Gezinmeyi gizlemek sunumdur; sınır değildir. `/api/mergen-rota/admin/system/*` altındaki her yönetim ucu (genel bakış, performans, kuyruklar, olaylar, bütünleşmeler) yetki bağlamını bağımsız yeniden yükler ve `assertSystemAdmin(actor)` çağırır. Dolayısıyla ucu doğrudan çağıran olağan kullanıcı veri yerine `403 FORBIDDEN` alır. Aynı kural iki değiştirici uç (kuyruk eylemleri, uyarı alındı onayı) ve `/api/mergen-rota/admin/reminder-settings` için de geçerlidir.

Bu yüzeyde üç ek kural vardır:

- Sayfa, Temel Kip gezinme süzgecinden muaftır (`ADMIN_NAV_IDS`): rolle sınırlandırılmış sayfa kullanıcı daha basit kip seçti diye erişilemez olmamalıdır.
- Sayfa açıkken rol kaybolursa kullanıcı güvenle **Özet** sayfasına yönlendirilir; yönetim görünümü rol olmadan hiçbir şey çizmez.
- Sayfa proje kapsamlı değil geneldir; etkin olduğunda kabuk seçili proje rozetini ve dışa aktarma denetimini gizler (`GLOBAL_NAV_IDS`).

Yönetim yanıtları sır taşımaz. Parolalar, belirteçler, çerezler, bağlantı dizeleri, SMTP kimlik bilgileri, iCalendar gövdeleri ve gereksiz alıcı adresleri yapısal olarak dışlanır. Her tanı bağlamı `src/domain/observability/redaction.js` içindeki tek temizleyiciden geçer. Yapılandırma yalnızca “Yapılandırılmış”/“Yapılandırılmamış” olarak bildirilir; kimlik doğrulama kartı eksik ayarların değerlerini değil, **adlarını** listeler.

## Kurumsal tam erişim

`MR_V_CorporateProjectAccess`, HR09 rollerini normalleştirir:

- PROJECT_MANAGER
- TECHNICAL_MANAGER
- QUALITY_MANAGER
- PROCUREMENT_RESPONSIBLE
- PPTS
- PRODUCTION_PLANNING_RESPONSIBLE
- DELIVERY_MANAGER
- RISK_MANAGER
- CONFIGURATION_MANAGER
- LOGISTICS_MANAGER

Bu rol sütunlarındaki her geçerli Sicil, eşleşen kurumsal projede FULL erişim alır. `programMd` açıklayıcıdır; hiçbir zaman personel kimliği sayılmaz.

PPTS yetkilendirmesi `pptsSicil` değerini `STRING_SPLIT`, boşluk kırpma ve `TRY_CONVERT(int, value)` ile virgülden tam belirteçlere ayırır. Bozuk belirteçler yetki vermez. Alt dize veya `LIKE '%10000%'` eşleştirmesi yasaktır.

Kurumsal proje sahibi kesin kaynaktır: `MR_Projects.LeadSicil`, `PROJECT_MANAGER` rolünden eşitlenir. Kurumsal projede salt okunur gösterilir; yalnızca manuel projede seçilebilir kalır.

## Manuel erişim

`MR_ProjectAccess` yalnızca MERGEN'e ait yetkileri saklar. HR09'dan türetilen erişimi çoğaltmaz.

Uygun kullanıcı manuel proje oluşturduğunda tek işlem şunları oluşturur:

- proje;
- kök WBS;
- `GrantSource = OWNER` ile oluşturucu FULL erişimi;
- denetim satırları.

Seçili manuel `LeadSicil`, açık ve türetilmiş FULL erişim kaynağıdır. Oluşturucu ve proje sorumlusu farklıysa oluşturucu OWNER yetkisini korur; sorumlu manuel projeyi WBS ve görevleriyle görebilir ve yönetebilir. `LeadSicil` değişince türetilmiş FULL erişim yeni sorumluyu izler; önceki sorumlunun bağımsız `MR_ProjectAccess` satırları silinmez veya yeniden yazılmaz. Kural yalnızca etkin `SourceType = 'MANUAL'` projelere özgüdür; kurumsal sorumlu alanları kaynak denetiminde kalır ve bu yetkiyi üretmez.

Yalnızca SYSTEM_ADMIN veya HR02 üzerinden dinamik olarak direktör, müdür ya da birim yöneticisi belirlenen kullanıcı manuel proje oluşturabilir.

## Yönetici görünürlüğü

Yönetici kapsamı şu kümelerin birleşimidir:

- `direktorluk_yonetici_sicil` değeri güncel Sicil olan direktörlük çalışanları;
- `mudurluk_yonetici_sicil` değeri güncel Sicil olan müdürlük çalışanları;
- `birim_yonetici_sicil` değeri güncel Sicil olan birim çalışanları.

Kapsam dinamik ve salt okunurdur. Yöneticiler astlarına atanmış görevleri ve gerekli Proje/WBS bağlamını görebilir. Ast işi bulunan her projede otomatik tam yönetim hakkı **kazanmazlar**.

## Görev atama kapsamı

**Yeni veya yeniden atanan görev için** proje seçmek, proje veya görevlerini görmekten farklı sorudur. İkisini farklı listeler yanıtlar:

- `projects` — kullanıcının *görebilecekleri*: çalışma alanı seçici, süzgeçler, raporlar, Gantt, portföy istatistikleri. Bu kural değiştirmez.
- `assignableProjects` — görev tanımlarken veya atarken *seçebilecekleri*. Ekleyici, yalnızca seçim içindir; `projects` içine birleştirilmez.

Olağan çalışanın sunucu `assignableProjects` kataloğu boş kalır. İstemci yalnızca anlık görüntüde en az bir `isCurrentUserAssignee` işaretli görev bulunan görünür projeleri ekler; sunucu bu türetilmiş listeye güvenmez. Direktör, müdür ve birim yöneticileri (`isExecutive`, yönetici görünürlüğüyle aynı biçimde HR02'den türetilir; sabit kullanıcı listesi yoktur), `assignableProjects` içinde **etkin CN43N kurumsal proje kataloğunun tamamını** alır. Böylece kendi `corporateprojectaccess` hakları olmasa da herhangi bir kurumsal proje altında kendi personeline iş atayabilir. SYSTEM_ADMIN öncelik sırasıyla zaten bütün projelere erişir.

## Bölümler arası atama: doğrudan atama ve atama talebi

Kullanıcının kendi Direktörlük / Müdürlük / Birim yapısı dışındaki personelle çalışmak atama kapsamı sınırını **gevşetmez**. Tasarım üç ayrı soruyu ayırır:

1. **Kullanıcı kimi bulabilir?** — `GET /api/mergen-rota/directory/search`. Kurumsal nüfus (3.000+ ve büyüyor) `api.snapshot` içine konmaz. Uç, çağıranı oturumdan doğrular, en az iki karakter ister, dizinli `MR_V_PeopleDirectory` üzerinden en fazla 25 satır döndürür ve yalnızca iş akışının gerektirdiği Sicil, görüntüleme adı, unvan ve Direktörlük / Müdürlük / Birim yolunu açıklar. Kullanıcı adı, e-posta ve yönetici ilişkileri dönmez. Oturum başına pencere sayacı yoğun yoklamayı HTTP 429 ile reddeder.
2. **Kullanıcı kimi doğrudan atayabilir?** — Değişmez. Her `MR_TaskAssignees` yazımını `assertAssigneeScope` yönetir: SYSTEM_ADMIN ve yönetici olmayan FULL proje kullanıcıları projede herkesi, yöneticiler kendi `MR_V_ExecutiveScope` personelini atayabilir; `ASSIGNEE_CREATE` yalnızca işlemi yapanı kabul eder. Başkası için sahte doğrudan istek `FORBIDDEN` alır ve kalıcı sorumlu kümesi değişmez.
3. **Kim koordinasyon gerektirir?** — Diğer herkes. Talep eden `MR_TaskAssignmentCoordinations` satırı gönderir; yönetici onaylayana kadar istenen kişi `MR_TaskAssignees` içine **yazılmaz**.

İstemci anahtarı (“Diğer birimlerden personel göster”, varsayılan KAPALI) ve işlemin talep olacağını bildiren not yalnızca kullanıcı deneyimidir. Kipe ve sonuca sunucu karar verir.

### Koordinasyon kaydı oluşturma

`POST /api/mergen-rota/assignment-coordination`, çağıranın görevle yetkili ilişkisini gerektirir: SYSTEM_ADMIN, FULL proje erişimi, görev oluşturucusu, mevcut sorumlu veya mevcut sorumlunun güncel `MR_V_ExecutiveScope` yöneticisi. İlgisiz çağıran ve var olmayan görev **aynı** `FORBIDDEN` iletisini alır; kayıt varlığı yoklanamaz. Kendini veya bilinmeyen Sicil'i istemek reddedilir. `(TaskId, RequestedAssigneeSicil)` başına tek açık kayıt etkindir; yerine gelen talep geçmişi silmeden önceki satırı iptal eder.

`NOTICE` kaydı ise zaten yetkili atayan kişi hem kendi `MR_V_ExecutiveScope` dışında hem farklı Direktörlük / Müdürlük / Birim içinde birini eklediğinde olağan görev kayıt yolundan yazılır. Atama hemen geçerlidir (atayan zaten yetkilidir); alıcı yönetim zincirine bildirilir ve zincir kaldırılmasını isteyebilir. Kimse yeni doğrudan atama yetkisi kazanmaz. Aynı `(TaskId, RequestedAssigneeSicil)` için açık talep, `NOTICE` eklenmeden önce aynı grupta `CANCELLED` (“Doğrudan atamayla karşılandı.”) olarak kapatılır: doğrudan atama talebi karşılamıştır; açık bırakılması sonraki kaldırma talebini tek açık kayıt kuralıyla çakıştırırdı. Şablonunda aynı sorumlu bulunan tekrar oluşumu şablon kaydını devralır, yeni kayıt açmaz; seri üretimi alıcı zinciri oluşum başına kayıtla doldurmaz.

### Alıcı yönetim zinciri

Zincir `MR_V_ExecutiveScope` üzerinden `ScopeType IN ('UNIT','DEPARTMENT')` ile küme bazında çözümlenir: birim yöneticisi ve müdürlük yöneticisi. Adlar kullanılmaz. `MR_V_PeopleDirectory` içinde olmayan kimlikler ve talep eden çıkarılır; `MR_AssignmentCoordinationRecipients` birincil anahtarı bu rollerden ikisini taşıyan kişiye tek bildirim sağlar. Personelin böyle yöneticisi yoksa karar görevin kendi proje yetkililerine döner: FULL erişim üreten kaynakların aynısı olan manuel proje sorumlusu, etkin `MR_ProjectAccess` FULL yetkisi ve kurumsal proje rolü; talep eden yine dışlanır. Projede görev oluşturmak bu kaynaklardan **değildir**: görev oluşturma FULL erişim vermez. Aksi durumda karar sahibi seçilen oluşturucu, sunucunun daima reddedeceği eyleme açık kaydı alır; erişimi olmadığı görevin başlığını, proje kimliğini ve istenen kişinin kurum yolunu görürdü. Aday yoksa talep sahipsiz bırakılmak yerine reddedilir.

### Karar yetkisi

Karar yetkisi **karar anında** güncel İK ilişkisi ve proje erişiminden yeniden türetilir; eski alıcı satırı yetki vermez. Okuma yüzeyi **aynı canlı kuralı** kullanır: zil, `Atama Koordinasyonu` sekmesi ve kaydın `IsManager`/eyleme açıklık bayrakları kalıcı alıcı satırından değil, güncel `MR_V_ExecutiveScope` ilişkisi ve FULL erişimden türetilir. Proje görevin **güncel** projesidir; kayıttaki proje anlık görüntüsü yalnızca silinmiş görev yedeğidir. Görev taşınınca yeni projenin FULL kullanıcıları kaydı bulup karara bağlar; önceki projeninkilere sunucunun reddedeceği düğmeler sunulmaz. Talep açıkken yetkili olan yönetici kaydı keşfeder; ilişkiyi kaybeden kaydı geçmişinde korur ama karar düğmeleri sunulmaz. Alıcı satırı **posta kutusu girdisidir**, yetki değildir; bir kişi alıcı satırı olmayan kaydı karara bağlarsa kendi kararını okuyabilmesi için satır eklenir.

Yönetici `PENDING` kaydı onaylayabilir, reddedebilir veya değişiklik isteyebilir; `APPROVED` kayıt için kaldırma isteyebilir. Talep eden kendi `PENDING` kaydını çekebilir, kaldırma talebini yanıtlar; ancak kendi talebini onaylayamaz. “Ahmet yerine Mehmet görevlendirilsin”, `SuggestedAssigneeSicil` olarak taşınır; öneri yalnızca önerilen çalışan yanıtlayan yöneticinin kendi yetkili kapsamındaysa kabul edilir.

Koordinasyon bildirimi almak görev düzenleme yetkisi **vermez**. Yönetici görevde zaten olağan yetkiliyse normal düzenleme akışı kullanılabilir; aksi durumda tek mekanizma koordinasyon iş akışıdır.

### Eşzamanlılık

Onay, görev ve sorumlu satırları kilitlenerek tek işlemde çalışır. Eskime geçiş başına değerlendirilir: `PENDING` onayı, yetkili sorumlu kümesinin talep anında yakalanan kümeyle hâlâ aynı olmasını gerektirir. Yalnızca kaydın kendi gönderiminde istenen Siciller tolere edilir; çok kişilik talepte birini onaylamak kardeş kayıtları eskitmez. Kaldırma onayında kişinin hâlâ sorumlu olması gerekir. Uyumsuzluk kaydı `STALE` yapar ve yazma yapılmaz. Silinmiş görev veya etkin dışı proje de eskimiş sayılır: diğer her görev yazımı etkin dışı projeyi reddettiğinden onay da böyle projeye sorumlu eklemez. Onay **tek Sicil ekler**, kaldırma **tek Sicil siler**; sorumlu kümesi yeniden yazılmaz, gizli kapsam dışı eş sorumlular sessizce düşürülemez. İki değişiklik de `MR_Tasks` satırına dokunur; karardan önce yükleyen düzenleyici eski `assigneeIds` ile ilişki kümesini sessizce yazmak yerine eskimiş olarak reddedilir. İsteğe bağlı istemci `version`, kaydın `RowVersion` değeriyle karşılaştırılır; eski yönetici yanıtı yenisini geçersiz kılamaz.

## Sorumlunun görev oluşturma kapsamı

P projesinde en az bir görevin yetkili sorumlusu olan olağan çalışan P içinde yeni görev oluşturabilir. Bu `ASSIGNEE_CREATE` kapsamıdır; FULL proje erişimi veya yönetici atama kapsamı değildir.

Sunucu, görev oluşturma SQL işleminde etkin projeyle birleştirilmiş `MR_TaskAssignees` okuyarak karar verir. Üyelik araması güncelleme/serializable anahtar aralığı kilitleri kullanır; oluşturma işleminden önce kaldırılan atamanın yerini eski tarayıcı durumu alamaz. Yetkili satır yoksa sahte doğrudan istek `FORBIDDEN` alır.

`ASSIGNEE_CREATE` bilinçli olarak sınırlıdır:

- yeni görev aynı etkin projede kalır;
- işlemi yapan, görevin başlangıçtaki tek sorumlusudur;
- aynı projede mevcut WBS düğümü seçilebilir; WBS oluşturulamaz, yeniden adlandırılamaz, taşınamaz veya silinemez;
- planlanan başlangıç, bitiş ve hedef bitiş verilebilir; Temel Kip yeni görevde zorunlu Termin tarihini üç alana da eşler;
- kendine atanmış iş için gerçekleşen tarihler ve tekrar kuralı verilebilir; yaşam döngüsü normalleştirmesi diğer yetkili güncellemelerle aynıdır;
- bağımlılık, kilometre taşı, sıralama, göreve özgü takvim, saat ve mali alanlar bu kapsamla eklenemez; üretilen oluşumlar şablonun yetkili yapısını ve sorumlu olarak yalnızca işlemi yapanı devralır;
- proje üst verisi, proje erişimi, WBS, baz plan, bağımlılık ve proje silme izinleri değişmez;
- ilgisiz proje ve görevler yetki süzgeçli anlık görüntüde bulunmaz.

Aynı `taskCreationScopeInProject` ilkesi Kapsamlı Kipi, Temel Kipi ve hızlı giriş sorumlu seçicisini besler. Temel Kipte `ASSIGNEE_CREATE` projesi ilk sorumlu olarak yalnızca güncel kullanıcıyı sunar. Bunlar istemcide kullanılabilirlik kısıtlarıdır; güvenlik sınırı sunucunun işlem içi denetimidir.

Genişletme bilinçli olarak dardır. Sunucu kararı proje düzeyi (`assertTaskProjectScope`) ve sorumlu düzeyi (`assertAssigneeScope`) denetimlerine ayırır; atama kapsamı yazmasına yalnızca *şunların tamamı* geçerliyse izin verir:

- işlemi yapanın görev atama kapsamı vardır (`hasTaskAssignmentScope`: SYSTEM_ADMIN veya yönetici);
- hedef **etkin kurumsal** projedir;
- sonuçta görevde en az bir sorumlu bulunur;
- değişiklikten önce ve sonra **her** sorumlu, işlemi yapanın `MR_V_ExecutiveScope` kapsamındadır.

Proje denetimi, sorumlu Sicilleri `MR_V_PeopleDirectory` üzerinden doğrulanmadan **önce** çalışır. Önce kişileri doğrulamak yetkisiz çağıranın gerçek çalışanı (`FORBIDDEN`) bilinmeyenden (`invalid employee`) ayırıp kurumsal dizini yoklamasına izin veriyordu.

Taşımanın hem kaynağı hem hedefi denetlenir; görev başka personel üzerinden yöneticinin kapsamına sokulamaz veya kapsamından çıkarılamaz. Atama kapsamı başka hak vermez. Görev yazmasının kapsam dışına ulaşabilmesi nedeniyle üç sınır açık uygulanır:

- **WBS yerleşimi.** Yönetici atama kapsamı WBS düğümü seçemez: yeni görev proje köküne bağlanır, mevcut görev düğümünü korur. `ASSIGNEE_CREATE` ve sınırlı görev oluşturucusu ayrı dar kapsamlardır; salt okunur katalogdan aynı projede mevcut düğümü seçebilir ama WBS yapısını yönetemez.
- **Bağımlılıklar.** PARTIAL anlık görüntüler `MR_TaskDependencies` yüklemez; istemci `deps: []` tutar. FULL olmayan yazma mevcut bağımlılık satırlarını değiştirmez, açık bağımlılık düzenlemesi reddedilir. Aksi durumda başlık düzenlemek yöneticinin görmesine izin verilmeyen öncülleri sessizce silerdi.
- **Zincirleme silme.** Tek başına yönetici atama veya olağan sorumlu kapsamı görev silemez. Yönetici atama kapsamlı oluşturucu, mevcut bütün sorumlular kapsamdaysa kendi kurumsal görevini silebilir. Olağan oluşturucu yalnızca başka sorumlusu olmayan görevi silebilir. İlişkili görev güvenlik denetimi, iki silmenin de kapsam dışı tekrar/bağımlılık kayıtlarını değiştirmesini önler.

Şablon altında tekrar oluşumu oluşturmak da aynı denetlenir: FULL olmayan yazmada **şablonun yetkili sorumluları** da kapsamda olmalıdır; seri üretimi PARTIAL anlık görüntünün gizlediği eş sorumluyu sessizce düşüremez.

SYSTEM_ADMIN kullanıcıya özel yetki denetimlerini atlar; yine de **etkin dışı** projeye görev yazamaz. Etkin FULL yetkileri yalnızca etkin projelerden kurulur; etkin dışı projeye taşınan görev bütün anlık görüntülerden kaybolurdu.

Kurumsal görev atayan yönetici sonrasında da olağan yönetici görünürlüğüyle yalnızca o görevi görür.

İstemci aynı kuralı (`src/state/projectWritePolicy.js`) yalnızca kullanılabilirlik için yansıtır. Doğru yansıtmak için anlık görüntü, yöneticinin atayabileceği çalışanlar olan `assignmentScopeSicils` de döndürür; iki kipin sorumlu seçicileri yalnızca sunucunun kabul edeceği kişileri sunar. Görünür görevin anlık görüntüde gizlenen sorumluları varsa yönetici atama kapsamlı düzenleyici salt okunur kalır; eksik liste yeniden atamayı güvenle yetkilendiremez. Güncel sorumlu aşağıdaki dar iş düzenleyicisini alır. Arayüzü atlayan isteği yalnızca sunucu denetimleri değerlendirir; `test/task-assignment-scope-e2e.test.mjs`, `test/assignment-scope-write-boundary.test.mjs` ve `test/task-assignee-editing-boundary.test.mjs` gerçek rota gövdelerini çalıştırarak bunu kanıtlar.

## Sorumlu görünürlüğü

Olağan çalışan kendi Sicil'ine atanmış görevleri ve onları anlamak için gereken Proje/WBS bağlamını görür. İlgisiz proje ve görevler dönmez. Sunucu ancak işlem içinde yetkili `MR_TaskAssignees` satırlarını okuyup güncel Sicil'in hâlâ atandığını doğruladıktan sonra güncellemeye izin verir.

Yetkili görev projeksiyonu, doğrudan sorumluya görevin oluşturucu Sicil'ini ve görüntüleme adını da sunar. Bu, kişi dizinini genişletmekten bilinçli olarak daha dardır: kimlik yalnızca görünür göreve eklenir; **Görevi tanımlayan** künyesini ve avatar anahtarını besler. Böylece tarih değişikliği servisinin karar sahibi seçtiği aynı yetkili oluşturucu görünür; PARTIAL dizin künyeyi `—` yapamaz veya talebi sahipsiz gösteremez.

Sorumlu; başlık, açıklama/etiket, durum, öncelik, ilerleme ve izinli gerçekleşen/iş alanlarını düzenleyebilir. Kendi yürütmesini anlatan tarihlerde de söz sahibidir: **planlanan başlangıç, planlanan bitiş, gerçekleşen başlangıç ve gerçekleşen bitiş yetkili sorumlu tarafından doğrudan yazılabilir**. Yalnızca **hedef bitiş** kapalıdır; kişisel plan değil taahhüt olduğundan bunun için kalıcı tarih değişikliği talebi sunar (`ASSIGNEE_BLOCKED_SCHEDULE_FIELDS`). İstemci ayrımı aynen yansıtır: çekmecede plan/gerçekleşen tarihler açık, hedef bitiş kapalıdır; *Yeni tarih öner* penceresi yalnızca hedef bitiş satırını sorar. Aynı kişi yukarıdaki dar kurallarla kendine atanmış görev oluşturabilir. İki işlem de proje üst verisi, WBS yönetimi, erişim, bağımlılık, kilometre taşı, sıralama, silme veya atama listesi değiştirme hakkı vermez.

Kısmi anlık görüntüler eş sorumluları bilinçli olarak dışarıda bırakabilir. Bu nedenle sorumlu iş güncellemesi istemci listesini kesin kaynak saymaz: `MR_TaskAssignees` satırlarını silmez veya yeniden eklemez, gizli eş sorumlular korunur. Atama listesini değiştirmek için istemci açık `assigneeIds` yaması göndermeli; sunucu FULL veya geçerli yönetici atama kapsamı istemelidir.

## Sınırlı görev oluşturucu kapsamı

`MR_Tasks.CreatedBySicil`, sınırlı sahipliğin kesin kaynağıdır. Olağan oluşturucu, o tek görevde üç denetimli plan tarihini doğrudan düzenleyebilir ve aynı projedeki mevcut WBS düğümünü seçebilir. FULL proje erişimi, proje üst verisi hakkı, sorumlu yönetimi, bağımlılık yönetimi veya WBS yönetimi almaz.

Olağan oluşturucu görevi yalnızca yetkili `MR_TaskAssignees` kümesi kendisi dışında Sicil içermiyorsa silebilir. Boş ve yalnızca oluşturucudan oluşan kümeler uygundur; başka herhangi bir sorumlu silmeyi engeller. Liste/çekmece denetimleri açık gerekçe için ortak istemci ilkesini kullanır; SQL işlemi oluşturucu ve sorumlu satırlarını yeniden yükler, son sınırdır.

Oluşturucu olmak direktör, müdür veya birim yöneticisinin mevcut atama haklarını bastırmaz. Kendi etkin kurumsal görevinde yönetici kapsam içi sorumlu ekleyip çıkarabilir, başka ekip üyeleri atanmışken de silebilir. Açık sorumlu değişikliği hem güncel hem önerilen listeyi `MR_V_ExecutiveScope` ile doğrular; sonuç boş olmamalıdır. Gizli/kapsam dışı sorumlular denetimi aşmak için kaldırılamaz. İçerik, etiket ve tarih düzenlemeleri oluşturucu izinlerini korur; yeniden atama açıkça istenmedikçe yetkili sorumlu listesini değiştirmez. Proje üst verisi, bağımlılıklar, tekrar üst kayıt/oluşum kimliği ve WBS yönetimi korumalı kalır. Tek sorumlusu kendisi olan görevde tekrar kuralı aşağıdaki ayrı dar izni kullanır.

Görev güncelleme ve silme yine güncel `RowVersion` gerektirir. `CONFLICT` (HTTP 409), gönderilen sürümün eskidiğini belirtir; `FORBIDDEN` ile farklıdır. Art arda başarılı arayüz kayıtları, sonraki kayıttan önce dönen sürümü uygular. Eski istek son satırı sessizce ezmez; yeniden denemeden önce veriyi yeniden yükleyin, kaydedilmemiş değişiklik varsa mevcut açık vazgeçme/yeniden yükleme akışını kullanın.

## Tarih değişikliği talepleri

Başkasının görevindeki sorumlu, kendisi yazamadığı tarih (uygulamada hedef bitiş) için `MR_TaskScheduleChangeRequests` satırı gönderir; görev değişmez. **Talep yalnızca gerçekten önerdiği tarihleri taşır.** Atlanan alanlar istemci kopyasından değil, kilit altında okunan görevden doldurulur. Talep penceresi açıkken başkası planı değiştirmiş olabilir; eski değerleri geri göndermek kabul edilen yalnızca hedef tarih talebinin güncel planı sessizce geri almasına yol açardı (STALE koruması gönderimde yakalanan özgün değerleri karşılaştırdığından bunu yakalamazdı). Sunucu belirlenimci karar sahibi olarak `MR_Tasks.CreatedBySicil` tercih eder; doğrudan sorumluya görev künyesinde yansıtılan kimlik de budur. Eski görevde oluşturucu kökeni yoksa sırayla manuel proje sorumlusu, etkin FULL proje erişimli kullanıcı veya yetkili kurumsal FULL kullanıcıya döner. Yalnızca talep eden ve karar sahibi okuyabilir; yalnızca o kesin sahip kabul/ret verebilir. `(TaskId, RequesterSicil)` başına tek PENDING satır etkindir; yerine yenisini göndermek öncekini iptal eder.

Kabul `READ_COMMITTED` yalıtım düzeyinde çalışır; görev ve bekleyen talep satırlarını `UPDLOCK, HOLDLOCK` ile kilitler, yakalanan üç özgün tarihi güncel görevle karşılaştırır, geçerli takvimle plan iş günü süresini yeniden hesaplar, görevi ve talebi atomik günceller, ilişkili denetim satırları yazar. Tarih uyumsuzluğu talebi STALE yapar; yeni planı ezmez. Ret, görev tarihlerini değiştirmeden kararı saklar. Projeksiyon anlık görüntüsü iki taraf için kalıcı bildirim kaynağıdır; durum yenileme, çıkış ve çevrimdışı dönemlerde korunur. Arayüz zorunlu gerçek zamanlı modal yerine engellemeyen talep merkezi kullanır.

## Yazma izinleri

FULL proje kullanıcıları görev oluşturabilir/düzenleyebilir/silebilir, personel atayabilir, bağımlılık ve WBS yönetebilir, görev taşıyabilir, WBS üst düğümü değiştirebilir, izinli proje üst verisini düzenleyebilir ve tam proje zamanlama/raporlama kullanabilir.

Bağımlılık seçicilerindeki kısa WBS/tarih bağlamı ve bağlamsal arama, yetkilendirmeyi veya kalıcılığı değiştirmez. Olağan/PARTIAL kullanıcı bağımlılık yönetimi izni kazanmaz; mevcut main kuralları geçerlidir.

PARTIAL kullanıcılar Proje, WBS yapısı, atama, bağımlılık, baz plan, etiket veya erişim kayıtlarını değiştiremez. Dar görev istisnaları; yönetici görev atama kapsamı, iş alanlarını düzenleyen yetkili güncel sorumlu, Termin ve mevcut WBS seçimiyle kendine görev oluşturan `ASSIGNEE_CREATE` ve yukarıdaki sınırlı oluşturucu kapsamıdır. İstemci denetimleri kapatabilir; sunucu yetkisiz yazmaya bağımsız olarak FORBIDDEN döndürür.

Kurumsal kimlik alanları kaynak denetimindedir. FULL kullanıcı bile kurumsal SourceType, ProjectCode, ProjectName, ProjectTypeCode, ProjectTypeName veya LeadSicil değiştiremez; güncelleme deyimi kurumsal sorumluyu açıkça korur, MERGEN alanlarını düzenlemek bunu temizleyemez. Veri Tarihi, renk, takvim ve etiket gibi desteklenen uygulama üst verisi değiştirilebilir. Manuel proje sahipleri manuel proje sorumlusunu değiştirebilir.

Kurumsal WBS yapısı da aynı anlamda kaynak denetimindedir: kurumsal projede FULL erişim görev işine ve görev-WBS atamasına izin verir; WBS oluşturma/adlandırma/taşıma/silmeye izin vermez. Yapı yalnızca CN43N eşitlemesinden gelir; sunucu istemci girişimlerini FORBIDDEN ile reddeder.

Erişim haritaları kanonik Gerçek Sistem kimlikleriyle (küçük harfli GUID) anahtarlanır. SQL Server `uniqueidentifier` değerlerini büyük harfli metin döndürdüğünden kanonikleştirilmemiş anahtar etkin erişim aramasını kaçırıyor ve projede gerçekten FULL olan kullanıcıya yazmayı reddediyordu.

## Yetki süzgeçli anlık görüntüler

Görünür projeler şunların birleşimidir:

- SYSTEM_ADMIN için her etkin proje;
- sıfır görevli projeler dahil HR09 yetkili kurumsal projeler;
- etkin MR_ProjectAccess yetkileri;
- `LeadSicil` değeri güncel Sicil olan etkin manuel projeler;
- kendi oluşturduğu, kendine veya astına atanmış görünür görev içeren projeler.

`assignableProjects`, bu birleşimin içinde değil yanında döner; yöneticilerin görev seçimini genişletmek görünürlüğü genişletemez. Kişi dizini tam bir kuralla genişler: görev atama kapsamı açıksa yöneticinin kendi `MR_V_ExecutiveScope` çalışanları eklenir. Aksi durumda görünür FULL projesi olmayan yönetici, kuralın atamasına izin verdiği astını bulamazdı. Bayrak Görev, WBS ve Proje görünürlüğünü değiştirmez.

Eş sorumlu avatarları kişi dizinini genişletmez. Projeksiyon anlık görüntüsü yalnızca zaten yetkili görünür görev kimlikleri için görev kapsamlı `(DisplayName, AvatarEmployeeNo)` kimliği taşır. Görev yüzeyleri ve Özet iş yükü toplaması, gruplamada Sicil'i korur ve fotoğrafı ondan türetir; yalnızca görüntüleme adı fotoğraf seçmek için kullanılmaz, eş adlı çalışanlar birbirinin fotoğrafını alamaz.

Görev oluşturucu künyeleri ikinci bir dizin atlama yolu oluşturmaz. Oluşturucunun adı ve Sicil/fotoğraf anahtarı yalnızca kişi zaten çağıranın yetki süzgeçli kişi kapsamındaysa yansıtılır. Sırf çağıran sorumlusu olduğu için görünen görev, ilgisiz personel kimliğini açıklamadan genel oluşturucu etiketi gösterebilir. Sunucunun türettiği `isCurrentUserCreator`, gizli Sicil'i açıklamadan yazma ilkesini destekler.

FULL proje anlık görüntüleri tam görev ağını, WBS'yi, bağımlılıkları, baz planları ve zamanlama bağlamını içerir. PARTIAL görüntüler yalnızca yetkili görevleri ve gerekli Proje/WBS bağlamını içerir. Varsayılan ret, ilgisiz A01 katalog projelerinin olağan çalışanlara görünmesini önler.

### Kararın verildiği yer

Yukarıdaki her kural, **yönettiği kümenin satırı başına bir kez** değerlendirilir; sonuç yeniden türetilmek yerine taşınır. Anlık görüntü sorgusu proje düzeyi sonucu (`AccessLevel`, READ yetkisi, kendi görev kataloğu kapsamı) görünür proje satırında; görev düzeyi sonucu (oluşturucu, kendi sorumluluğu, ast sorumluluğu ve oluşturucu kimliği temeli) görünür görev satırında somutlaştırır. Sonraki her küme (WBS, görevler, sorumlu satırları, kişi dizini), görev tablosuna yeniden bağlanıp aynı `EXISTS` denetimlerini çalıştırmak yerine bu sütunları okur. Yalnızca hesap yerelliği değişmiştir: koşullar, girdileri ve sonuçları özdeştir; sorguyu ucuzlatmak için kural gevşetilmemiştir.

Kestirme sanılabilecek iki sonuç açıklığa kavuşturulmalıdır. Önce, görünür görev kümesi ayrık iki daldan kurulur: FULL/READ projelerin bütün görevleri ve kalan PARTIAL projelerin yalnızca kişisel kapsam görevleri. Bu, kuralların zaten tanımladığı birleşimdir; PARTIAL projenin diğer görevleri hiçbir zaman görünür değildi. İkinci olarak yönetici kapsam kümesi, aynı SERIALIZABLE işlemde `MR_V_ExecutiveScope` üzerinden yüklenen yetki bağlamı çağıranı zaten yönetici bildiriyorsa okunur. Yönetici olmayan için sorgu tanım gereği satır döndürmez; atlamak kararı değiştiremez. Kapsamın kendisi yine her istekte yeniden okunur; istekler veya kullanıcılar arasında önbelleğe alınmaz.

Kişi dizini iki üyelik düzeyi tutar. Sicil yalnızca mevcut kurallarla `people` içine **yayımlanır**: çağıran, görünür projelerin sorumluları, READ yetkisi/çağıranın kendisi/yönetici kapsamıyla erişilen sorumlular ve görev atama kapsamı açıksa çağıranın astları. Yalnızca görev künyesi veya sorumlu satırında **görüntüleme adı** çözmek için gereken Sicil yayımlanmamış işaretlenir ve `people` içine girmez. Görüntüleme adı görünürlüğü kimlik görünürlüğü değildir; gizli eş sorumlunun Sicil'i yükün hiçbir alanında bulunmaz.

## Kısmi görünürlük ve CPM

Süzülmüş görev alt kümesi tam ağ değildir. Bu nedenle zamanlama seçicisi kısmi projeleri `suppressed-partial` işaretler; tam proje CPM'i döndürmez ve kritik yol iddiasında bulunmaz. Kısmi kullanıcıların portföy istatistikleri yalnızca görünür kapsamı anlatır.

## Oturum modeli

Oturum/yetenek verisi kanonik iş verisinden ayrıdır. Depo oturumu şunları içerir:

- veri kipi;
- normalleştirilmiş güncel kullanıcı;
- isSystemAdmin;
- isExecutive;
- canCreateProjects;
- canAssignAllCorporateProjects;
- FULL/PARTIAL ve sunucudan türetilmiş gerekçelerle proje erişim girdileri.

Tarayıcı bu değerleri uyduramaz.

## Güncel kimlik sağlayıcısı

Kimlik doğrulamayı **Keycloak** sağlar (`MERGEN_ROTA_AUTH_MODE=keycloak`, varsayılan). `KeycloakIdentityProvider`, güvenilir Sicil'i yalnızca sunucunun Keycloak belirtecini doğruladıktan sonra yazdığı sunucu imzalı HttpOnly uygulama oturum çerezinden okur. Tam akış, ortam değişkenleri ve işletim adımları: `docs/KEYCLOAK-SSO.md`.

`DevelopmentIdentityProvider` yalnızca açıkça açılan yerel geliştirme seçeneğidir. **Hem** `MERGEN_ROTA_AUTH_MODE=development` **hem** `MERGEN_ROTA_DEV_IDENTITY_ENABLED=true` gerektirir; varsayılan kapalıdır.

İstek gövdesi, sorgu parametresi, tarayıcı denetimli başlık, yerel depolama değeri, görüntüleme adı veya istemci yeteneği güncel kimlik olarak güvenilir sayılmaz. Eksik/çözülemeyen kimlik UNAUTHORIZED döndürür; yöneticiye, geliştirme kimliğine veya Demo verisine dönmez.

## Kimlik eşleme

Kimlik doğrulama değişiminde yalnızca `CurrentUserProvider` katmanı değiştirilmiştir:

```text
Keycloak ile doğrulanmış kullanıcı
→ doğrulanmış `sicil` beyanı
```

veya beyan yokken yedek çözüm açıksa:

```text
Keycloak `preferred_username`
→ HR02.kullanici_adi   (parametreli sunucu sorgusu; tam bir satırla eşleşmelidir)
→ HR02.sicil
```

Belirsiz veya çözülemeyen aramalar UNAUTHORIZED döndürür. Bütün iş yetkilendirmesi Sicil üzerinde çalışır. Yetkilendirme önceliği, SQL şeması, depo işlemleri ve kurumsal okuma modelleri değişmez.

## Oturum görüntüleme alanları

Oturum yanıtı yetki verisinin yanında güvenli görüntüleme alanları taşır: `sicil`, `employeeNo`, `name`, `username`, `givenName`, `familyName`, `email`, `department` (Keycloak beyanı), `sector`, `managementUnit`, `subject`; ayrıca kurumsal dizinden `role`, `team`, `organization`. Ham erişim belirteçleri açıklanmaz.

`currentUser.department`, Keycloak `department` beyanıdır ve kenar çubuğunda gösterilir. `currentUser.organization.department`, HR02 `mudurluk` üzerinden türetilen kurumsal dizin değeridir. Kaynakları farklıdır; karıştırılmamalıdır. Bu alanların hiçbiri yetki kararına katılmaz.

### Görev görünümlerindeki kurumsal süzgeç yetki değildir

Her iki kipte Görevler ve Takvim, ayrıca Kapsamlı Kipte Kanban araç çubuğundaki **Direktörlük → Müdürlük → Birim** seçimi yalnızca istemci tarafı kullanım kolaylığıdır. Sunucu önce mevcut oturum, proje erişimi ve görev görünürlüğü kurallarıyla yetkili anlık görüntüyü üretir; istemci çalışma alanı/proje seçimini uygular; kurumsal süzgeç ancak bundan sonra bu kümeyi daraltır. Seçili bir kurumsal yol yeni görev, proje veya kişi kaydı görünür kılamaz ve yazma/silme/atama kararlarına katılmaz. Takvimde gün kutuları, ek görev sayıları ve genişletilmiş gün penceresi aynı süzülmüş kümeyi kullanır.

Eşleşme görev oluşturucusu, proje sorumlusu veya oturum kullanıcısı üzerinden değil görevin mevcut projeksiyondaki sorumluları üzerinden yapılır. Kararlı `assigneeIds` varsa ad eşlemesi kullanılmaz. Eski bir kayıtta kimlik hiç yoksa yalnızca mevcut kişi projeksiyonundaki tekil ad güvenli yedektir; aynı adlı iki kişi varsa tahmin yapılmaz. Çok sorumlulu görevde en az bir görünür sorumlunun seçili kurumsal yolda bulunması yeterlidir. Projeksiyon dışındaki veya gizli sorumlular için kurumsal bilgi türetilmez; kişi dizini genişletilmez.

### Atama kimliği ve manuel projelerde personel kapsamı

Sorumlu yazmalarında `assigneeIds` (Sicil/SicilNo) kesin kaynaktır. Aynı istekteki `sorumlu` adları kimlikleri yeniden türetmez. Eski, yalnızca ad taşıyan girdilerde tekil eşleşme bulunmazsa işlem reddedilir; iki aynı adlı çalışan birleştirilmez. Görev kapsamlı fotoğraf kimlikleri mutasyon yanıtında da güncel Sicil ile verilir; eski bir fotoğraf aynı ad üzerinden başka çalışana taşınmaz. Proje sorumlusu için eski ad yedeği ve Özet plan bütünlüğü denetimleri de yalnızca tekil adları kabul eder; geçersiz Sicil eş adlı bir kişiyle tamamlanmaz. Genel kişi rehberi ve görev görünürlüğü genişlemez.

Sistem yöneticisi olmayan direktör, müdür veya birim yöneticisinin yeni/değiştirilen atama listesi `MR_V_ExecutiveScope` ile doğrulanır. Manuel projenin sahibi/sorumlusu olmak veya kurumsal projede FULL erişim taşımak bu personel sınırını kaldırmaz. İstemcide üç görev giriş/düzenleme seçicisi aynı kümeyi kullanır; sunucu doğrudan API yazmalarında da denetler. FULL projede değişmeyen eski atamalar içerik düzenlemesini engellemez; sorumlu listesi veya proje değişirse sonuçtaki tüm çalışanlar kapsamda olmalıdır. Kısmi projede mevcut ve yeni atama listeleri ayrı ayrı doğrulanmaya devam eder.

Kaydet işleminde görev/ardıl yamaları tek veritabanı işlemi ile uygulanır. Yerel taslak başlamasından sonra bilinen sürüm değişmişse istemci kaydı reddeder; sunucu mevcut rowversion denetimini ayrıca uygular. SQL şema değişikliği gerekmez.


### Aktif Kullanıcılar ve nabız yetkisi

`GET /api/mergen-rota/admin/system/presence` öteki yönetim uçlarıyla aynı kapıdan geçer: oturum okunur, `assertSystemAdmin` bağımsız olarak denetlenir ve yetkisiz kullanıcı FORBIDDEN alır. Gezinmeyi gizlemek sınır değildir. Nabız ucu (`POST /api/mergen-rota/presence/heartbeat`) kimliği **oturumdan** türetir; gövdeden gelen Sicil yok sayılır. Tablo yalnızca sistem yöneticisinin zaten görmeye yetkili olduğu künyeyi (ad, Sicil, Direktörlük / Müdürlük / Birim, ilk/son görülme) taşır. Ayrıntılar: [Sistem Yönetimi](SISTEM-YONETIMI.md).

### Talep geçmişi ve bildirim yetkisi

Talepler GET sorguları ve bildirim okuma/temizleme işlemleri yalnızca oturum Sicilinin talep eden veya belirlenmiş karar sahibi olduğu kayıtlarla sınırlıdır. Atama koordinasyonunda katılım talep edenden, alıcı satırından ve CANLI yetkiden (güncel `MR_V_ExecutiveScope` ilişkisi veya görevin güncel projesindeki FULL yetki) türetilir; alıcı satırı bir posta kutusu kaydıdır, yetki belgesi değildir. Talep edilen kişi, atama yürürlüğe girene kadar kaydı görmez. Zil bildirimi göreve erişim vermez; "Görevi aç" olağan yetkili görev yükleme yolundan geçer ve yetki orada yeniden doğrulanır. Kullanıcı kimliği ve rolü istemci parametresi değildir. Kişi/proje kataloğu genişletilmez. Kalıcı geçmiş silinen görevin künyesini taşıyabilir; bu, göreve güncel erişim vermez. Karar işlemi halen güncel görev/proje yetkisini ve sürümünü doğrular. Komut araması kenar çubuğuyla ortak kip/rol süzgecini kullanır; Temel Kipte Gantt gösterilmez. Ayrıntılar: [Talepler](TALEPLER-VE-BILDIRIMLER.md).


### Görev Hareketleri gizlilik sınırı

Ekip raporu, yetkili görev/proje kümesi ile `ActorSicil` üzerinden mevcut yönetici kapsamının kesişimidir. Görevin sorumlusu güncelleyen kişi yerine kullanılamaz; çalışan üyeliği başka projelere erişim vermez. SYSTEM_ADMIN ve FULL/READ proje görünürlüğü mevcut önceliğini korur. Silinen görevde son denetimin oluşturucu/atama künyesi aynı görünürlük kurallarına göre değerlendirilir; eksik tarihsel atamalar tahmin edilmez. Filtreler yalnızca daraltır; ham JSON istemciye çıkmaz. [Rapor yetkilendirmesi ve tarihsel kayıtlar](GOREV-HAREKET-RAPORU.md).

### Kendi görevinin tekrarı

`canManageRecurrence`, `canManageStructure` yetkisinden ayrıdır. O projede zaten görev oluşturabilen yetkili tek sorumlu, kendi görevinin tekrarını yapılandırabilir. Gizli/eş sorumlular bu dar izni engeller; bütün kimlik denetimleri Sicil kullanır. SQL işlemi tam yetkili atama kümesini, üst kayıt/proje/WBS/takvim kapsamını, oluşum sayısını ve yinelenen kimliği denetler. Oluşumlar oluştuktan sonra mevcut seri kuralları değişmez olur. İstemci görünürlüğü sunucu yetkilendirmesinin yerine geçmez.

### Rota AI alan araçları (Aşama 3)

Rota AI'nin Rota verisini okuyan 19 salt okunur aracı yeni bir yetki modeli kurmaz; bu belgedeki kuralları yeniden kullanır ([ayrıntı](YAPAY-ZEKA-ALAN-ARACLARI.md)):

- Kimlik yalnızca oturumun güvenilir Sicil'idir. Araç şemaları kimlik, rol ya da yetki alanı (`sicil`, `currentUserSicil`, `actorSicil`, `isAdmin`, `accessLevel` …) ve SQL parçası taşıyamaz; kayıt defteri böyle bir aracı yüklemez. Kişi süzgeci Sicil'dir ve yalnızca süzgeçtir; ad eşleşmesi hiçbir koşulda kimlik ya da yetki kanıtı sayılmaz.
- Yetki bağlamı `loadAuthorizationContext` ile her araç kümesinde (model yanıtı başına) yeniden okunur; sabit SQL görünür görev kümesini yetki süzgeçli anlık görüntüyle **aynı** iki daldan kurar (FULL/READ projelerin bütün görevleri + kalan kısmi projelerin yalnızca kişisel kapsamdaki görevleri). Sistem yöneticisi bütün etkin projeleri görür: türetilmiş etkin erişimde her etkin proje `FULL` ve `SYSTEM_ADMIN` gerekçesiyle yer alır; araç kapsamı, proje künyesi ve kanıtın yetki parmak izi bu aynı erişimi kullanır, etkin olmayan ya da var olmayan proje yetkisiz projeyle aynı yanıtı alır. AI için isteğe bağlı kişi kapsamı üyelikleri aynı okumaya eklenir; normal yetki yüklemesi ek SQL çalıştırmaz. Sunucu içi epoch proje/görev/kişi kapsamına ve görev başına oluşturucu/sorumlu/yönetim hakkına bağlıdır. Yeni odaklı kanıtlar ilgili nüfusun parmak izini kullanır; global toplamlar ve eski kanıtlar tam epoch denetimini korur. Son çizim, açma ve tekrar öncesinde atfedilen görevlerin güncel görünürlüğü ve proje üyeliği de sınırlı toplu okumayla doğrulanır; epoch'un değişmemesi bu kontrolü atlatmaz. Model üretimi ile yetki denetimi atomik değildir.
- Eş sorumlu kimliği, oluşturan künyesi ve iş dağılım kataloğu anlık görüntüdeki kurallarla gösterilir; gizli eş sorumlu kişi olarak sayılmaz ve Sicil'i hiçbir alana çıkmaz. Bağımlılıklar ve baz planlar yalnızca FULL erişimde açıktır.
- Kısmi kapsam kısmi kalır: toplamlar ve gruplar yalnızca görünür görevler üzerindedir, gizli görevin sayısı ya da varlığı sızmaz; kısmi kapsamlı kanıta atıf yapan her yanıta sunucu kapsam notunu ekler.
- Toplu bir olgu (sayı, oran, dağılım, grup, "yok" sonucu) yalnızca ona katkı veren **bütün** görevler güncel yetkiyle hâlâ görülebiliyorsa açıklanır. Araç saydığı görev nüfusunu kanıta bağlar; son çizimde, açmada ve tekrarda yüklü satırlar değil nüfusun tamamı sınırlı parçalarla yeniden doğrulanır. Nüfus kalıcı kayda sığmazsa kayıtlı yanıt sonraki açılışlarda doğrulanamaz sayılır ve gösterilmez.
- Kişi ve proje/görev adı eşleşmesi kimlik değildir: yalnızca tek kesin eşleşme (tek Sicil ya da tam ad/başlık) bir kaydı çözer. Belirsiz ya da kısmi eşleşmenin adaylarını sunucu tutar ve çizer; kullanıcının numaralı seçimi sunucuda kayıtlı aday kimliğine bağlanır, seçilmeyen aday o turda kimlik olamaz.
- Açıklama, talep/karar iletisi ve değişiklik metni gibi serbest metin yalnızca kullanıcı o iletide **Notlar ve iletiler** onayını verdiyse okunur; onay sonraki iletiye taşınmaz. Sorumlusuzluk süzgeci yalnızca kimliği görünür sorumluları sayar; gizli atama eklemek sonucu değiştirmez.
- Outlook araç çıktısı görünmeyen aboneliklerin sayısını veya varlık işaretini taşımaz; görünür toplam/dağılım ve tamlık gizli nüfustan etkilenmez. Belirli görev için görünmeyen, olmayan ve aboneliği olmayan kayıt aynı `NOT_FOUND` sonucunu alır.
- Doğal dil ve alan seçimi modeldedir; yetkili araç yükü, bu tura ait olgu öneki, kayıt yolu, kanonik alan ve türlü değerin eşitliği sunucuda doğrulanır. Serbest model düzyazısı kanıt sayılmaz. Modelin yönlendirme önerisi kanıt zorunluluğunu kapatamaz; veri okumayan Genel sohbet yolunu kullanıcı seçer; eski olgular yeni kanıt yerine geçmez. İlk başarılı araç kümesi güvenilir varlık/süzgeç sınırını kurar; sonraki veri bu sınırı veya metin izdüşümünü genişletemez. Kanonik iddia yolları sunucu sözleşmesidir, modelin seçimi izin listesi değildir.
- Görünmeyen kayıt, var olmayan kayıtla aynı yanıtı alır (`NOT_FOUND`); bu meşru bitiş doğrulama hatası sayılmaz. Gizli tekrar şablonları açıklanmaz; ortak ebeveyn yalnızca görünür yinelemelerin iç gruplamasında kullanılır; kısmi hareketlerde gizli sorumlu değişimleri tek genel işaret olarak gösterilir.
- Talepler, atama koordinasyonu, bildirimler ve Görev Hareketleri araçları ilgili ekranların var olan okuma hizmetlerini aynı yetkiyle çağırır; ekip hareketleri yalnızca yöneticilere açıktır. Hiçbir araç bildirimi okundu işaretlemez ve hiçbir araç yazma yapmaz.

Kalıcı Rota yanıtı için konuşma sahipliği yeterli değildir. Yanıtla saklanan yetki hash’i açma, tekrar ve uzlaştırma sırasında güncel yetkiyle eşleşmelidir; yoksa metin, atıflar ve özetler birlikte varlık/yetki ayrımı yapmayan iletiye döner. Görev görünür kalsa bile oluşturucu hakkının kalkması önceki kimlik kanıtını geçersiz yapar. Güncel yetki okunamazsa açıklama yapılmaz. Talepler/atama/bildirim AI okumaları katılımcılık kuralına ayrıca güncel etkin görev görünürlüğünü uygular; gizli satırlar sayaçlara girmez. Normal okuma yolları bu AI davranışına açık seçenek verilmedikçe değişmez.

AI kanıtlarında görünür atama kimliği ile gerçek atama varlığı ayrıdır. Kimliği
gizli sorumlu, sorumlusuz görev veya boş grup olarak sayılmaz. Çözülemeyen
atama ayrı kalite durumudur. Sistem yöneticisi AI okumalarında proje/görev
listesi yüklemez; etkinlik ve FULL yetki SQL koşullarıyla denetlenir. Kalıcı
kanıt, sayılan görevlerin ve boş projeler dahil proje nüfusunun güncel yetkisini
parçalı olarak yeniden doğrular; konuşma genelinde 160 000 görev eşiği yoktur.
İlk kimlik yalnızca güncel kullanıcı isteği, kesin ad çözümü veya sunucunun
numaralı açıklama seçiminden gelir; veri metni ve model kimliği yetki değildir.
Silinmiş/arşivlenmiş görevlerde talepler ve koordinasyon geçmişi gerçek kayıtlı
katılımcılara açıktır; canlı görev yetkisi bu tarihi katılımın yerine geçmez.
