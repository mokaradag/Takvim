# Rota AI · Kanıta Dayalı Alan Araçları (Aşama 3)

Bu belge Rota AI'nin MERGEN Rota verisini **yetkili, salt okunur ve kanıta
dayalı** biçimde yanıtlamasını sağlayan Aşama 3'ü anlatır: sunucuya ait araç
kayıt defteri, 19 alan aracı, kanıt kimlikleri ve atıf doğrulaması, sınırlı
araç döngüsü, kanıt kaydı (0018), akış protokolüne eklenenler, arayüz,
gözlemlenebilirlik, dağıtım ve kabul.

Aşama 1–2 temelleri (güvenilir Sicil, anahtar yönetimi, sağlayıcı soyutlaması,
model kaydı, `aiGateway`, kapasite, akış, konuşma geçmişi) için bkz.
[AI-PLATFORM.md](AI-PLATFORM.md). Aşama 3 bu temelleri değiştirmez; yalnızca
sınırlı ve sınanmış uzantılar ekler (§15).

**Dört ilke:**

1. Dil ve akıl yürütme modelindir; **olgular, yetkiler ve hesaplar Rota sunucu
   kodunundur.**
2. Rota bir olguyu yetkili kanıtla kanıtlayamıyorsa Rota AI o olguyu **söylemez.**
3. Model hangi kayıtlı salt okunur aracı çağıracağını seçebilir; **hangi
   veritabanı erişimine sahip olacağını seçemez.**
4. Gösterişli bir yanıttan önce **doğru, yetkili ve yeniden üretilebilir** bir
   yanıt gelir.

---

## 1. Kalıcı sınırlar

- **Genel SQL aracı yoktur ve eklenmeyecektir.** Model SQL üretemez; üretilen
  hiçbir metin sorgu olarak çalıştırılmaz. Modele SQL Server şeması, bağlantı
  bilgisi ya da kimlik bilgisi verilmez. Bütün SQL, MERGEN Rota'nın sabit ve
  parametreli sunucu kodudur (`src/server/ai/tools/rota/rotaToolQueries.js` ya
  da var olan okuma hizmetleri). Bu, AI-PLATFORM §14'teki kalıcı kuralın
  devamıdır ve `test/ai-architecture-contract.test.mjs` ile korunur.
- **Kimlik her zaman güvenilir Sicil'dir.** Hiçbir araç `sicil`,
  `currentUserSicil`, `actorSicil`, `userSicil`, `authenticatedUser`, `user`,
  `userId`, `username`, `role`, `isAdmin`, `accessLevel` gibi kimlik/yetki
  alanını ya da `sql`, `query`, `where`, `orderBy`, `column(s)`, `table`,
  `select`, `filterSql` gibi sorgu alanını bağımsız değişken olarak kabul
  edemez; kayıt defteri böyle bir şemayı yüklemez.
- **Güvenlik amacıyla ad eşleştirilmez.** Kişi ve proje yalnızca kimlikle
  (Sicil, proje kimliği) süzülür; ad yalnızca aramadır. Aynı adlı birden çok
  kişi "belirsiz" döner ve model tahmin etmez.
- **Araçlar salt okunurdur.** Hiçbir araç görev oluşturamaz, düzenleyemez,
  durum ya da tarih değiştiremez, atama yapamaz, talep açamaz ya da karara
  bağlayamaz, Outlook aboneliği ekleyip kaldıramaz, bildirimi okundu
  işaretleyemez, tercih değiştiremez. Bildirimler yapay zekâ okudu diye okundu
  sayılmaz.
- **Tarayıcı hiçbir zaman anahtar almaz;** araç adı, bağımsız değişkeni, SQL,
  bağlantı dizesi, yığın izi ya da sürücü hatası hiçbir akış olayında,
  yanıtta ya da kayıtta bulunmaz.
- **Özellik isteğe bağlıdır.** `MERGEN_ROTA_AI_TOOLS_ENABLED` kapalıyken
  (varsayılan) Rota AI Aşama 2'deki genel sohbet yoluyla bire bir aynı çalışır.

---

## 2. Mimari

```
Tarayıcı ── POST /assistant/turns ──► assistantService.prepareAssistantTurn
                                         │  kanıta dayalı yol kullanılabilir mi? (§3)
                                         ▼
                              aiGateway.runToolSession        tek kapasite kirası, tek süre
                                         │                      sınırı, tek kimlik bilgisi
                                         ▼
                              groundedAnswer.runGroundedTurn  sınırlı döngü (§7)
                               │         │
          session.round() ◄────┘         └──► toolExecutor.runRound   sınırlar, önbellek (§8)
     (sağlayıcı: streamToolCompletion)              │
                                                    ▼
                                     araç işleyicisi (19 araç, §10)
                                                    │
                          toolContext ── yetki bağlamı (küme başına yeniden okunur)
                                     └── araç SQL kapısı ──► rotaToolStore (sabit SQL)
                                                           └► var olan okuma hizmetleri
                                                    │
                                         kanıt defteri (R1, R2 …)
                                                    ▼
                         belirlenimci doğrulama → (tek düzeltme) → güvenli ileti
                                                    ▼
                    kısa işlem: yanıt + atfedilen kanıt (0018) → done olayı
```

- Model turları ve araç yürütmesi **SQL işlemi dışında** çalışır; her model
  turundan önce açık işlem olmadığı yeniden doğrulanır. Yanıt ve kanıt, yanıt
  doğrulandıktan sonra tek kısa işlemde yazılır.
- Kapasite kirası, süre sınırı ve kimlik bilgisi tur başına **bir kez** alınır;
  araç turları arasında yeniden kuyruğa girilmez. Kira hangi yolla biterse
  bitsin tam bir kez bırakılır.

### Modül haritası

| Modül | Sorumluluk |
| --- | --- |
| `src/server/ai/tools/toolRegistry.js` | Kayıt defteri: ad, sürüm, konu, kanıt türü, açıklama, yetki belgesi, katı şema, yasak alanlar, işleyici; modele giden katalog |
| `src/server/ai/tools/toolArguments.js` | Katı JSON şeması doğrulaması (tür, enum, aralık, biçim, bilinmeyen alan, boyut) |
| `src/server/ai/tools/toolExecutor.js` | Sınırlı yürütücü: tur/çağrı/süre/boyut sınırları, önbellek, sonuç zarfı, kanıt kaydı |
| `src/server/ai/tools/toolContext.js` | Tur bağlamı: güvenilir Sicil, Türkiye günü, küme başına yetki bağlamı, SQL süresi muhasebesi |
| `src/server/ai/tools/toolSqlGate.js`, `toolLimits.js` | Araç SQL kapısı ve sabit sınırlar |
| `src/server/ai/tools/toolErrors.js` | Güvenli hata sınıfları |
| `src/server/ai/tools/evidenceLedger.js` | Tur başına kanıt defteri ve kalıcılık satırları |
| `src/server/ai/tools/rota/*` | 19 aracın işleyicileri, kapsam kuralları, sabit SQL ve tek SQL sahibi depo (`rotaToolStore.js`) |
| `src/domain/ai/evidenceContract.js` | Sunucu ve tarayıcının ortak kanıt/atıf sözleşmesi (saf) |
| `src/domain/ai/evidenceIntent.js` | Veri okunmadan bildirilen yönlendirmenin (dil, türlü istek, dönem) yapısal ayrıştırıcısı; doğal dili yorumlamaz |
| `src/domain/ai/requestContract.js` | Türlü istek ile seçilen olguların belirlenimci uyumu: ölçü kapsamı, nüfus, varlık, liste ve sıralama bütünlüğü (saf) |
| `src/server/ai/tools/requestDeclaration.js` | İstek şeması (araçlarla aynı süzgeç sözlüğü ve kapalı ölçü sözlüğü), güven kaynağı denetimi, varlık bağlama ve kanıtın nüfus dizini |
| `src/domain/ai/claimableEvidence.js` | Araç başına kanonik iddia yolları; her yolun açık ölçüsü, ölçme birimi ve özellik/toplam sınıfı |
| `src/server/ai/tools/toolScope.js` | İlk başarılı çağrının süzgeçleri, güvenilir varlık kimlikleri ve metin izdüşümüyle takip sınırı |
| `src/server/ai/tools/toolResultPolicy.js`, `toolResultText.js` | Araç başına sayılabilir koleksiyonlar, kısaltma ve metin tamlığı |
| `src/domain/ai/evidenceFacts.js`, `evidenceVerification.js` | Türlü alan olguları, kayıt/alan/değer doğrulaması ve sunucuda güvenli yanıt çizimi |
| `src/server/ai/assistant/groundedPrompt.js`, `groundedAnswer.js` | Sunucuya ait yönerge ve sınırlı, doğrulanan döngü |

---

## 3. Kanıta dayalı yol ne zaman kullanılır?

Kaynak seçimi kullanıcıya aittir: **Rota verisi** (varsayılan) doğrulanmış
olgular verir; **Genel sohbet** Rota verisi okumayan Aşama 2 akışını kullanır.
İstek `source: rota|general` taşır; eksik değer `rota` kabul edilir. Araç
bayrağı açıkken veri yolu hazır değilse sabit `unavailable` yanıtı verilir,
model düzyazısına sessiz geçiş yapılmaz. Bayrak kapalıyken Aşama 2 değişmez.
Veri yolunun dört önkoşulu vardır:

1. `MERGEN_ROTA_AI_TOOLS_ENABLED=true`;
2. seçilen kipin araç profili kurulu ve yetenekli: Standart → `chat.tools`,
   Derin düşünme → `chat.tools.reasoning` (profil `chat` + `tools`
   yeteneği ister; akıl yürütme profili ayrıca `reasoning`);
3. araç kayıt defteri geçerli;
4. kanıt tablosu (0018) kurulu. Gözlem önbelleğe alınır: "hazır" 15 dk,
   "eksik" 60 sn geçerlidir; bilinmiyorsa konuşma kapısından tek küçük sorguyla
   (satır okumadan) denetlenir.

Hazırlık yanıtı (`GET /assistant`) özellik açıkken ek bir `rotaData` alanı taşır:

```json
{ "enabled": true, "available": false, "reason": "EVIDENCE_SCHEMA_MISSING",
  "modes": [{ "id": "standard", "available": true }, { "id": "deep", "available": true }] }
```

`reason`: `TOOL_REGISTRY_INVALID`, `PROFILE_UNAVAILABLE`,
`EVIDENCE_SCHEMA_MISSING` ya da geçici şema denetimi hatalarında
`EVIDENCE_SCHEMA_UNKNOWN`. Özellik kapalıyken alan hiç bulunmaz.

---

## 4. Araç kayıt defteri ve bağımsız değişkenler

Her araç sunucuda şu künyeyle kayıtlıdır: ad (`rota_` ile başlar,
`/^rota_[a-z]+(?:_[a-z]+){0,4}$/`), sürüm, konu (arayüzdeki ilerleme metni),
kanıt türü, 20–700 karakterlik açıklama, **yetki anlambilimi belgesi**, katı
JSON şeması (`additionalProperties: false`), işleyici ve süre sınırı. Kayıt
defteri yüklenirken doğrulanır; sorunlu kayıt defteri Rota verisi yolunu
kapatır (`TOOL_REGISTRY_INVALID`), genel sohbet çalışmaya devam eder.

Bağımsız değişkenler model metnidir ve **güvenilmez**:

- en fazla 8 KiB; JSON nesnesi olmalıdır;
- bilinmeyen alan, yanlış tür, enum dışı değer, aralık dışı sayı, geçersiz
  tarih (`YYYY-MM-DD`, gerçek takvim günü), geçersiz kimlik (GUID) ve eksik
  zorunlu alan reddedilir; `null` "verilmemiş" sayılır;
- hata ayrıntısı yalnızca alan yolunu ve nedeni taşır (`$.limit:range`,
  `$.dateFrom:reversed`); modelin gönderdiği değer geri yansıtılmaz;
- serbest metin (ör. arama metni) SQL'e yalnızca **parametre** olarak girer ve
  `LIKE` kullanılmaz (`CHARINDEX` ile büyük/küçük harf ve aksan duyarsız kaba arama; kesin eşleşmede noktasız `ı` ayrı kalır): `%`, `_`,
  `[` ve `' OR 1=1 --` gibi girdiler düz metindir.

---

## 5. Yetki

Araçlar yeni bir yetki modeli **kurmaz**; Rota'nın var olan anlamını kullanır
(bkz. [AUTHORIZATION-MODEL.md](AUTHORIZATION-MODEL.md)):

- Yetki bağlamı `loadAuthorizationContext` ile okunur ve `buildRotaScope` ile
  sabit SQL'e parametre olarak verilir; görünür görevler SQL içinde anlık
  görüntüyle **aynı kurallarla** yeniden hesaplanır: sistem yöneticisi → bütün
  etkin projeler; kurumsal proje rolü, manuel sahip ve FULL/READ hibesi →
  projenin bütün görevleri; kısmi (PARTIAL) erişim → yalnızca oluşturduğu,
  sorumlusu olduğu ya da yönetim kapsamındaki çalışanın görevleri.
- Eş sorumluların kimliği anlık görüntüyle aynı kuralla gösterilir: kısmi
  görünümde başkasının kimliği yalnızca kullanıcı görevin kendi sorumlusuysa
  (ya da kişi yönetim kapsamındaysa) açılır; aksi hâlde "kimliği gösterilemeyen
  sorumlu" olarak temsil edilir, kişi olarak atfedilmez. Atama durumu
  yalnızca kullanıcıya açıklanabilen atamalardan türetilir: `visible`
  (görünür sorumlu), `unresolved` (açıklanabilen ama dizinde çözülemeyen
  atama), `unassigned` (kimlik tabanı açık — FULL/READ ya da oluşturan —
  olup hiç ataması olmayan görev) ve `undisclosed` (kimlik tabanı kapalı
  görevde açıklanabilen atama yok). Kimlik tabanı kapalı görevde gizli atama
  ile hiç atama olmaması ayırt edilemez: ikisi de nötr `undisclosed`
  durumundadır. "Sorumlusuz" süzgeci, sorumlu grubu, iş yükü ve kalite
  sayımları gizli atamanın varlığını ne ekleyerek ne düşürerek yansıtır.
  Dizinde çözülemeyen atama ayrı kalite denetimidir.
- Bağımlılıklar ve baz planlar yalnızca projede **FULL** erişimde açıktır;
  diğer düzeylerde araç `UNSUPPORTED_SCOPE` döner.
- İş dağılım ağacı: FULL/READ/kendi görev kapsamında katalog; yalnızca yönetim
  kapsamıyla görülen projede yalnızca görünür görevlerin düğümleri ve ataları.
- **Görünmeyen kayıt ile var olmayan kayıt ayırt edilemez** (`NOT_FOUND`).
- Yetki bağlamı her araç kümesinde (model yanıtı başına) **yeniden okunur** ve
  kümedeki çağrılar arasında paylaşılır: yetki tur ortasında kaldırılırsa sonraki
  küme yeni kapsamla çalışır. Oturumdaki Sicil tur sırasında değişirse tur
  sonlandırılır.
- **Kısmi kapsam kısmi kalır.** Toplamlar yalnızca görünür görevler üzerindedir;
  gizli görevlerin sayısı, adı ya da varlığı hiçbir alanda (toplam, sayfa,
  grup, "diğer" kovası) sızmaz. Sonuç `scope.kind = authorized-task-subset`
  taşır; kısmi kapsamlı kanıta atıf yapan her yanıta sunucu sabit kapsam
  notunu ekler (§6.4).
- **Sistem yöneticisi.** Yönetici bayrağı taşıyan kullanıcının etkin erişimi,
  `FULL` ve `SYSTEM_ADMIN` yüklemeden SQL’de etkin proje koşuluyla uygulanır.
  AI yetki yüklemesi bütün projeleri/görevleri numaralandırmaz; odaklı okuma
  ve kanıt doğrulaması yalnızca istenen kimlikleri sorgular. Proje adı/kodu
  araması da proje nüfusu sınırından önce uygulanır.
- **Toplu nüfus.** Sayı, oran, dağılım ve grup gibi toplu olgular yalnızca
  onları oluşturan görevlerin **tamamı** kullanıcının güncel yetkisiyle
  görülebiliyorsa açıklanır. Araç saydığı görev nüfusunu kanıta bağlar; son
  çizimden önce ve kayıtlı yanıt yeniden açılırken yalnızca yükte listelenen
  satırlar değil, nüfusun tamamı analiz sınırı büyüklüğündeki parçalarla (en
  fazla 20 000 görev/SQL deyimi) yeniden doğrulanır. Konuşma genelinde
  parça sayısı eşiği yoktur; her yanıt bağımsız doğrulanır. Yeniden açılışın
  toplam süre bütçesi 25 sn, yanıt başına 8 sn’dir; süre/hizmet hatası yalnızca
  denetlenemeyen yanıtı geçici olarak gizler. Boş projeler dahil sayılan proje
  nüfusu da güncel etkinlik ve yetki koşullarıyla denetlenir. Nüfus kalıcı kanıtta proje başına sıkıştırılmış görev
  kimlikleriyle saklanır; 32 000 karakterlik kayda sığmazsa kanıt kalıcı olarak
  "doğrulanamaz" işaretlenir: bu turda doğrulanan yanıt gösterilir, sonraki
  açılışlarda metin sabit bir açıklamayla gizlenir.


Kimliklerin kaynağı kapsam denetiminin parçasıdır. İlk turdaki proje/görev/WBS/
baz plan kimliği kullanıcının güncel iletisinde açıkça bulunmalı; Sicil bir
Sicil seçicisi olarak belirtilmelidir. Adlar yalnızca bu iletideki bütün
ifadeden yapılan kesin aramayla veya sunucunun numaralı açıklama seçimiyle
kimliğe dönüşür. Önceki ilgisiz konuşma, modelin ürettiği kimlik, görev
künyesindeki proje/eş sorumlu ve bildirim metni yeni nüfus açamaz. Sonraki
arama önceki metni koruyarak daralır; kullanıcıdaki başka bir ifade önceki
aramayı değiştiremez. Görev listesindeki kimlikler aynı dondurulmuş nüfustaki
görev ayrıntılarına izin verir, üst projenin bütününü açmaz. Takip ayrıntısına
yalnızca sonucun kayıtlı takip yollarındaki görev kimlikleri açılır (görev
listesi satırı, bağımlılık, tekrar serisi ve son tamamlanan yineleme, hareket,
talep, Outlook ve bildirim satırı); toplu grup anahtarları ve aday listeleri
kimlik değildir. Portföy özeti yalnızca `source: all` iken bütün görünür görev
nüfusuna geçiş kökü olur; kaynağa göre daraltılmış portföy, kaynak süzgeci
olmayan görev analitiğini açamaz.

**Türlü istek sözleşmesi.** Sunucu kullanıcının cümlesinden ölçü, varlık,
dönem ya da sıralama çıkarmaz. Model veri okumadan önce isteği türlü olarak
bildirir. Seçilen kipin araç profili (Standart `chat.tools`, Derin düşünme
`chat.tools.reasoning`) `rota_plan` yerel çağrısında isteği ve ilk okuma
planını birlikte taşır; normal asistan metni gerekmez. Plan aracı salt okunur
araçlarla birlikte sunulur: okuma çağrıları `calls` içinde ya da aynı yanıtta
doğrudan verilebilir (aynı çağrı bir kez çalışır). Yerel çağrı yerine metin
olarak dönen aynı plan (tek JSON nesnesi: `calls` taşıyan yönlendirme
bildirimi, planın kendisi ya da `{"name":"rota_plan","arguments":…}`; tek kod
çiti veya tek `<tool_call>` zarfı içinde olabilir) aynı doğrulamadan geçer.
Eksik `layout` `auto`, eksik `population` sunucu seçimi yerine model seçimidir:

```json
{"intent":"rota","language":"tr","request":{"operation":"value","metrics":["tasks.total"],"population":{"tool":"rota_task_search"},"layout":"auto","filters":{"status":["in_progress"],"assignee":"me"}},"calls":[{"name":"rota_task_search","arguments":{"status":["in_progress"],"assignee":"me"}}]}
```

`request.population.tool` nüfusu üreten aracı, `collection` list/rank için
tam kanonik koleksiyonu bağlar. `sort`, analitik `groupBy`, WBS `depth` ve
korumalı arama `textFields` boyutları ilgili durumda açıkça bildirilir.
`layout` auto/list/table; `fields: [{metric, tool, path}]` somut alt alan ve
toplam/satır düzeyini; `bindings: [{metric, entity: 0}]` çok varlıklı ölçü
eşlemesini bağlar. `reasoning: synthesis` yalnızca gerçek muhakeme ihtiyacıdır.
Eski route JSON bildirimi de kabul edilir; belirsiz eski bildirimler sunucu
seçimini açmaz. Geçerli istek ve araç bağımsız değişkenleri doğrulanmadan veri
okunmaz.

- `operation`: `value` (değerler, toplamlar ya da bir kaydın alanları), `list`
  (listenin bütün satırları) ya da `rank` (`rank: {metric, order, limit}`;
  yalnızca sayı ve tarih gibi sıralanabilir ölçüler).
- `metrics`: `claimableEvidence.js` kayıt defterinin kapalı ölçü sözlüğü. Her
  iddia edilebilir yolun tek ölçüsü, açık ölçme birimi (`tasks`, `days`,
  `hours`, `percent`, `date` …) ve özellik/toplam sınıfı vardır; birim alan
  adından tahmin edilmez. Planlanan/gerçekleşen saat ve tarih, termin/takvim
  günü/gecikme, ilerleme/tamamlanma oranı ayrı ölçülerdir.
- `entities`: `project|task|person|wbs|baseline`; `text` kullanıcının
  iletisinde geçen ifade, `id` kullanıcının yazdığı ya da sunucunun açıklama
  seçiminde bağladığı kimliktir.
- `filters`: araç şemalarıyla aynı sözlük (görev durumu, öncelik, termin,
  tarih alanı/aralığı, `period`, `assignee: me|unassigned`, oluşturan,
  kilometre taşı, arama metni; talep sekmesi/durumu; portföy kaynağı; hareket
  kapsamı/türü).
- Bir koşula uyan kayıtların sayısı o nüfusun toplamıdır (`tasks.total` ve
  koşul `filters` içinde); `tasks.overdue` ve `tasks.open` proje, kişi ya da
  portföy nüfusunun kırılımıdır, görev satırı alanı değildir. Sayı ile kayıtlar
  birlikte istenirse `list` ve en az bir satır alanı bildirilir. İstem bu
  kalıbı tek örnekle gösterir:
  `{"operation":"list","metrics":["tasks.total","task.targetFinish"],"filters":{"deadline":"overdue","assignee":"me"}}`
  ve `rota_task_search {"deadline":"overdue","assignee":"me"}`. Bu, modele
  verilen yönergedir; sunucu cümleyi yorumlamaz, yalnızca bildirimi doğrular.

Geçerli bildirim olmadan hiçbir araç çalışmaz; bildirim düzeltmesi en fazla iki
model turudur. Reddedilen plan çalışan dökümde modelin kendi çağrısı ve yalnızca
sorun yolları ile kayıt defteri ipuçlarını (aracın koleksiyonları, sıraları,
ölçüyü taşıyan araçlar) taşıyan hata sonucu olarak kalır; model planı baştan
yazmadan düzeltir. Nüfus aracının taşımadığı, `fields` kaynağı ya da varlık
özelliği olmayan ölçü doğrulanamayacağından veri okunmadan reddedilir. Standart
kipte ucuz bütçe tükenince tur Derin düşünmeye bir kez devredilir; Derin kip
kendine devretmez. Bildirim veri okunduktan sonra değişmez; bu yüzden araç
sonucundaki bir yönerge sorunun anlamını değiştiremez. Doğrulama hatası
modele yalnızca şema yolları ve kayıt defterinden üretilen yol ipuçlarıyla
bildirilir; modelin ya da verinin metni yönergeye taşınmaz.

Son seçim isteğe belirlenimci olarak bağlanır (`requestContract.js`):

- Bildirilen her ölçü en az bir olguyla temsil edilir (birden çok ölçü tek
  olguyla karşılanamaz); bildirilmeyen ölçü yanıt olamaz, genel toplam istenen
  ölçünün yerine geçmez. Ad ve etiket alanları yalnızca bağlamdır.
- Toplam ve sayımlar bildirilen koşullarla birebir aynı nüfustan gelir. Nüfus,
  kanıtın yürütülen bağımsız değişkenlerinden sunucuda hesaplanır; aracın
  ifade edemediği bir koşul uyumsuzluktur. Grup satırı, anahtarı bildirilen
  koşul ya da varlık olduğunda kabul edilir. Arama metni de bir nüfustur.
- Adla bildirilen varlık yalnızca bu turdaki tek kesin sunucu çözümüne ya da
  sunucunun bağladığı açıklama seçimine bağlanır; kısmi ya da belirsiz eşleşme
  açıklama ister. Araç çağrısındaki her proje/görev/kişi/WBS/baz plan seçicisi
  bildirilen bir varlık olmalı, her varlık kendi ölçü olgusuyla karşılanmalıdır.
- Değer isteği çok satırlı koleksiyondan yalnızca bildirilen varlığın satırını
  ya da bildirilen koşulla adlandırılan grubu seçebilir. Varlığın kendi
  özelliği (ör. görevin durumu) arama koşulundan bağımsızdır; satırdaki
  toplamlar (ör. kişinin açık görev sayısı) değildir.
- `list` her seçilen satır koleksiyonunun bütün satırlarını kapsar ve yalnızca
  TAM (`complete`, kısaltılmamış, ilk sayfadan başlayan) bir sonuçtan kurulur. Her seçilen satır,
  bildirilen bütün satır ölçülerini kendi kayıt yolunda taşımalıdır; başka koleksiyon
  ya da genel toplam eksik satır ölçüsünün yerine geçmez. Aynı nüfusun ayrıca
  bildirilen toplamı satır ölçüsü yerine geçmeden bağlamsal olarak korunur.
  Boşluk yalnızca TAM, kısaltılmamış, ilk sayfadaki tam istenen koleksiyonla
  kanıtlanır. Satır-only listede `complete` olgusu bu kanıta atıf yapabilir;
  ayrıca toplam istenmişse toplam olgusu da gerekir. Sibling koleksiyon,
  ilgisiz scalar veya başka araç nüfusu satır ölçüsünü karşılayamaz.
  `totalCount` yalnızca aracın tanımlı nüfusunu sayar: tekrar serisi sayısı
  oluşum sayısı değildir; içteki `next` koleksiyonları kendi `upcomingCount`
  ve `nextTruncated` değerleriyle doğrulanır.
- `rank` kayıt defterindeki uyumlu satır nüfusunun ölçülü satırlarını,
  belirlenimci sırayla ve sınırdaki bütün eşitleriyle seçer. Kesilmiş ilk sayfa
  aynı ölçüyle sunucuda sıralanmalıdır. Sınırdan sonraki farklı değer sayfada
  görünür ya da `rankingBoundary` sunucunun aynı yetkili nüfustaki sonraki
  değerini kanıtlar. N sayfa boyutuna eşitken de bu kanıt gerekir; eşitlik
  varsa daha geniş yetkili sonuç gerekir. Boyut kısaltması sınır kanıtını siler.
  Ayrıntı/toplam kanıtı satır nüfusu değildir; boş nüfus için uyumlu gerçek
  boş dizi ve sıfır kaynak sayımı gerekir.
- Eksik ölçü, nüfus, liste ya da sıralama kanıtı mevcut tek düzeltme ve araç
  bütçesi içinde önce tamamlanır. Standart → Derin devri bu bütçeleri sıfırlamaz
  (veri okunmadıysa Derin kendi bildirim bütçesini alır). Ucuz kurtarmadan sonra
  kalan bildirim, biçim, boş yanıt ya da seçim hatası tek Derin devrine yol
  açabilir; veri okunduysa Derin araç çağıramadığından devir yalnızca bildirilen
  ölçülerin kanıtı hazırsa yapılır.

Satır kimliği ve proje/kişi/WBS/baz plan/arama/kaynak/tarih seçicileri modelin
alan seçiminden bağımsız korunur; Sicil ve UUID grup anahtarları kullanıcıya
iddia edilebilir alan olarak açılmaz. Tarih biçimi alanın türünden gelir, metnin görünümünden gelmez.
Baz plan yokken karşılaştırma ölçüleri bilinmiyor (`null`), anlamlı sıfır değil;
sınır aşan sayımlar `truncated` ve eksik olarak temsil edilir.

Katılımcıların silinmiş/arşivlenmiş göreve ait talep ve koordinasyon geçmişi
kayıtlı katılım ve künye üzerinden görünür kalır; canlı görev yetkisi üçüncü
kişinin eski kaydını açamaz. Hareket grubunda tek bir ayrıntı JSON’u bile
kırpılmışsa yapılandırılmış değişiklikler bütünüyle bırakılır. Seçilmemiş
serbest değişiklik metni tamlık durumunu değiştirmez.

---

## 6. Sonuç zarfı, kanıt ve atıf

### 6.1 Sonuç zarfı

Modele giden her başarılı sonuç:

| Alan | Anlamı |
| --- | --- |
| `ok` | `true` |
| `evidenceId` | Bu turdaki kanıt kimliği (`R1`, `R2` …) |
| `factScope`, `subject` | Tur için rastgele üretilen olgu öneki ve güvenli görünen kayıt adı; yalnızca model/sunucu protokolünde kullanılır |
| `tool`, `generatedAt`, `today` | Araç adı, veri zamanı (UTC), Türkiye iş günü |
| `scope` | `kind` ve açıklama (aşağıda) |
| `complete` | Yetkili kapsamda eşleşen kayıtların tamamı döndü mü (başka sayfa/kısaltma yok) |
| `truncated` | Liste sınır ya da boyut nedeniyle kısaltıldı mı |
| `returnedCount`, `totalCount` | Döndürülen öğe ve yetkili kapsamda bilinen kesin toplam; tamamlanmayan/korunan toplam `null` olabilir |
| `nextCursor` | Sonraki sayfanın imleci (yoksa `null`) |
| `claimable` | Sunucuya ait sürüm, kanonik yol şablonları (`*` dizi indisi), veri öncesinde seçilen `textFields` |
| `data` | Araca özgü veri (§10) |

Hata: `{ ok: false, tool, error: { code, message, details? } }` (§11).

`scope.kind` değerleri:

| Değer | Anlamı |
| --- | --- |
| `complete-projects` | İlgili projelerin, kullanıcının görmeye yetkili olduğu bütün görevleri |
| `authorized-task-subset` | Kısmi erişimli projelerde yalnızca yetkili görevler; sayılar proje bütününü temsil etmez |
| `current-user` | Yalnızca kullanıcının kendi kayıtları (bildirimler, Outlook abonelikleri) |
| `participant` | Kullanıcının tarafı olduğu talepler |
| `directory` | Kurumsal personel dizini araması |
| `reference` | Referans veri (çalışma takvimi) |

`complete` tutulan maddi verinin tamlığıdır: sonraki sayfa, kesilmiş metin,
eksik ayrıntı/örnek, boyut kısaltması veya tanımsız döngü sonucu varsa false
olur. Kapsamın kısmi olması ayrıca `scope.kind` / `partial` ile taşınır.
`toolResultPolicy` birincil satırları açıkça tanımlar: bağımlılık ayrıntısında
öncül + ardıl, bildirimde üç kaynak listesi; görev ayrıntısında tek görevdir.
Toplam/kalite araçlarının sayıları analiz nüfusudur, örnek satırı sayısı
değildir. Boyut kısaltması yalnızca tanımlı koleksiyonlarda yapılır; ardından
satır sayısı yeniden hesaplanır, imleç kapatılır ve eski vurgular kaldırılır.

### 6.2 Kanıt kimlikleri

- Yalnızca **başarılı** araç sonuçları kanıt olur; kimlikler turda **çağrı
  sırasıyla** verilir (tamamlanma sırasıyla değil).
- Aynı **model yanıtında** aynı araç aynı bağımsız değişkenlerle birden fazla
  kez çağrılırsa SQL yeniden çalışmaz; önceki sonuç (aynı kanıt kimliği) verilir.
  Sonraki araç turunda aynı çağrı yeniden çalışır; yetki bağlamı yeniden okunur ve
  başarılı sonuç yeni bir kanıt kimliği alır.
- Turda en fazla 12 çağrı yürütüldüğünden bir yanıt en fazla 12 kanıta dayanır
  (kalıcı sıra numarası üst sınırı 16'dır).

### 6.3 Atıf ve belirlenimci doğrulama

Doğal dildeki soruyu yorumlamak, araç seçmek ve ilgili alanları seçmek modelin
işidir. Güvenlik katmanı Türkçe/İngilizce cümleleri, olumsuzlukları veya tarih
ifadelerini anlamaya çalışmaz. Model kanıtlı yanıtı serbest düzyazı yerine
kapalı bir JSON sözleşmesiyle, yalnızca **olgu seçerek** verir:

```json
{"kind":"rota","facts":["R1:data.visibleTasks.total","R1:data.tasks.*.title"],"layout":"auto"}
```

Her başvuru `R<n>:` önekiyle bu turdaki bir kanıta ve onun `claimable`
sözleşmesindeki kanonik yola bağlanır; `*` bir dizideki bütün satırları seçer
(yürüyüş sınırı içinde). Model değer, kimlik, özne ya da cümle kopyalamaz:
değeri, türü, özneyi, birimi, süzgeci, tanımı ve veri zamanını sunucu kendi
yetkili kanıt yükünden okur. Sözleşmede olmayan, başka turun ya da uydurulmuş
bir başvuru doğrulanmaz ve yanıt çizilmez. `layout` (`auto`, `prose`, `list`,
`table`) yalnızca sunumu seçer. Bu biçim, daha az yetenekli bir araç modelinin
sık sorulara (sayı, liste, proje özeti, iş yükü) düzeltme turu gerektirmeden
doğrulanmış yanıt verebilmesi için modelden istenen işi azaltır; doğrulama
zayıflamaz.

Eski yapılandırılmış iddia biçimi uyumluluk için kabul edilir ve aynı birebir
eşitlik kurallarıyla doğrulanır:

```json
{"kind":"rota","claims":[{"evidenceId":"R1","factId":"0123456789abcdef_R1:data.task.status","subjectId":"data.task","field":"data.task.status","operator":"eq","value":"in_progress"}]}
```

`factId`, sunucunun verdiği `factScope` ile tam JSON alan yolunun birleşimidir.
`subjectId` alanın sahibi olan nesnenin yoludur; liste indeksleri yolun
parçasıdır (`data.tasks.0.status`); üst düzey sonuç metaverisinin sahibi
`result`'tır. Sicil veya kayıt kimliği olgu kimliğine eklenmez. Her iddia tam
olarak bu altı alanı taşır. Sunucu kendi yetkili kanıt yükünden alanı yeniden
okur; aynı turdaki kanıt, olgu kimliği, kayıt yolu, alan yolu ve türüyle birlikte
değerin birebir eşitliğini denetler. Yalnızca `eq` desteklenir; `null`, sayı,
boole ve metin birbirine dönüştürülmez. Başka kaydın aynı değeri, termin yerine
başlangıç tarihi veya planlanan süre yerine kalan süre kanıt sayılamaz.

**Doğrulanmış anlatım.** Seçilen olgular sunucuya ait şablonlarla Türkçe ya da
İngilizce metne çevrilir: özet sorular paragraf olur ("**Radar Modernizasyonu**
projesinde toplam **8** görev bulunuyor. Bunların **6**'sı açık, **2**'si
tamamlanmış ve **2**'si gecikmiş; tamamlanma oranı **%25**."), açıkça liste
istenen ya da doğası gereği listelenen satırlar madde listesi, en az üç
satırlı karşılaştırmalar (üç sütun ya da iki sayısal sütun) ve açık tablo
istekleri tablo olur; sayı sütunları sağa yaslanır. Önemli değerler kalın,
sunucunun kapsam notu eğik yazılır ve arayüzde yanıttan ikincil görünür; atıf
ilgili cümleye ya da kaynak satırına bağlı kalır. Sayılar kendi nüfusunu tanımlayan niteleyicilerle
(proje, kişi, dönem, süzgeç; kimlik değil ad) yazılır, sınırı aşan sayı kesin
sayı gibi sunulmaz. Şablon yalnızca seçilen olguları yerleştirir; olgular
arasında ilişki ya da neden-sonuç kurmaz ve emoji kullanmaz. Serbest model
önsözü/sonucu veya başlık bulmaya dayalı bir nitel iddia gösterilmez. Veri metnindeki Markdown, bağlantı, denetim ve atıf
işaretleri nötrlenir. Atıf yardımcıları kayıtlı yanıtların ortak sunum
sözleşmesini korur; kanıtlı sonucun doğrulanması bir düzyazı tarayıcısı değildir.
İkinci bir model güvenlik hakemi olarak kullanılmaz.

| Durum | Kural |
| --- | --- |
| Başlangıç | `undecided`; seçilen kipin araç profili veri okumadan `rota_plan` içinde türlü istek ve okuma planını bildirir. Yerel çağrıda boş asistan metni geçerlidir. Eski route JSON ve metin olarak dönen plan da kabul edilir. Bildirimdeki dönem (`filters.period`/`dateFrom`/`dateTo`, eski `window` de kabul edilir) kimlik çözümünden sonraki hareket/takvim penceresinin üst sınırıdır |
| Genel önerisi | Modelin ayrı rota ya da doğrudan `general` önerisi veri kipinde kanıt denetimini kapatmaz. Serbest metin gösterilmez; sunucu Genel sohbet seçimini isteyen güvenli açıklama verir. Kullanıcının `source: general` seçimi ayrı, veri okumayan akış ve `general` bitişidir. |
| Rota | Yalnızca kabul edilmiş türlü istekle araç çalışır; bildirimsiz ya da geçersiz bildirimli çağrı yürütülmez, sınırlı bildirim düzeltmesi istenir. Geçerli olgu seçimi isteğe uyduğunda sunucuda çizilir; istek kanıttaki olguları tek anlamlı belirliyorsa seçimi sunucu yapar (§7.1) |
| Aday seçimi | Kimlik yalnızca kesin eşleşmedir: tek Sicil ya da tam ad / tam başlık. Belirsiz ya da yalnızca kısmi bir arama (proje, kişi, başlıkla görev) sunucunun tuttuğu en fazla 10 adayı döndürür. Model yalnızca `{"kind":"clarification","evidence":"R1"}` bildirir; adayların tamamını, sırasını ve soruyu sunucu çizer ve aday kimliklerini yanıtla birlikte (`clarificationContext`) saklar. Sonraki turda yanıtın tamamı tek bir aday numarasıysa ("2", "2.", "#2", "(2)") seçim sunucuda o adayın kimliğine bağlanır. Sözcükle anlatılan seçim ("ikincisi", "evet") sunucuda yorumlanmaz; model yeniden sorar ya da kullanıcının yazdığı adla arar. Seçilmeyen adaylar o turda kimlik olamaz, ad eşleşmesi yetki kanıtı değildir |
| Genel sohbete yönlendirme | Modelin `general` önerisi `general_redirect` sonucu olarak ayrı sayılır (bitiş `clarification`); aday seçimi sayacına karışmaz |
| Bulunamadı | Hiç başarılı kanıt yok ve son araç kümesinin hataları yalnızca `NOT_FOUND` ise `kind: not_found` / güvenli eski ileti; sabit, varlık/yetki ayrımı yapmayan yanıt ve `not_found` bitişi |
| Veri hizmeti kullanılamıyor | Kullanılabilir kanıt yokken `kind: unavailable`; sabit hizmet iletisi, ayrı sonuç sayacı |
| Gerçek doğrulama hatası | Tek düzeltme de geçmezse ve devir (§7.1) yoksa ya da o da doğrulanamazsa `grounding_failed`; kanıt kaydedilmez |
| İptal | Ağ geçidi/istemci sinyali turu keser; yarım protokol veya yanıt kaydedilmez |
| Sağlayıcı çıktısı kesildi | `finish_reason=length` tek ortak düzeltme bütçesinden kısa (en fazla 8 iddia), tam JSON ister; kesik JSON geçmişe eklenmez |

Model her turun niyetini yorumlayabilir; kaynak seçiminin güvenlik sonucunu
sunucu belirler. Eski asistan düzyazısı güvenilir talimat olarak tekrar
oynatılmaz; önceki kullanıcı soruları ve güncel yetkiyle doğrulanan minimal
aday sıra numaraları ve kimlikleri kısa takipler için bağlam sağlar; serbest aday adları/kodları ve birim metinleri modele yeniden verilmez. Aday seçimi metni
yerine sunucunun yapılandırılmış `clarificationContext` referansları kullanılır.

**Aşama 3 / Aşama 4 sınırı.** Aşama 3, Türkçe ya da İngilizce kullanıcı
niyetini yorumlamak için regex ya da anahtar sözcük tabanlı doğal dil işleme
kullanmaz. Doğal dildeki anlamsal çıkarım Aşama 4'te geliştirilecektir. Aşama
3'ün belirlenimci mantığı güvenilir yapısal doğrulama, yetki, kanıt
bütünlüğü, ölçü hesabı, sınırlar ve benzeri nesnel değişmezlerle sınırlıdır.

> Phase 3 does not use regex/keyword NLP to interpret Turkish or English user
> intent. Natural-language semantic reasoning will be improved in Phase 4.
> Phase 3 deterministic logic is limited to trusted structural validation,
> authorization, evidence integrity, metric computation, bounds and other
> objective invariants.

Sorunun türlü isteğe çevrilmesi modelin olasılıksal yorumudur; sunucu her
ifadenin doğru çevrileceğini iddia etmez. Sunucunun güvencesi şudur: istek
veri okunmadan, yalnızca kullanıcının yazdığı metin ve kimliklerle bildirilir;
yanıt bu isteğe, yetkiye ve kanıta belirlenimci olarak bağlıdır; sayıların
nüfusu (proje, kişi, süzgeç, dönem) yanıtta niteleyici olarak görünür. Rota
verisini edinme, kapsam ve son olgu doğrulaması sunucuya aittir. Kimlik
kökeninde kullanılan yapısal biçimler (UUID, "sicil N" seçicisi, aday
numarası) niyet yorumu değil, kullanıcının açıkça yazdığı kimliğin
tanınmasıdır.

`claimableEvidence` her araç için tam kanonik yol şablonlarını belirler;
bilinmeyen veya yanlış konumdaki aynı adlı alan iddia değildir. Son yanıtta
seçilen yollar yalnızca yürüyüşü daraltır, izin listesi oluşturmaz. Açıklama,
talep/karar iletisi ve hareket metni yalnızca kullanıcı aynı turda
**"Notlar ve iletiler"** anahtarını açtıysa (`includeText: true`) ve model veri
görülmeden bu kümeden `textFields` seçtiyse modele verilir ve çizilebilir;
model kullanıcı seçimi olmadan serbest metni açamaz (ilk turda da
`UNSUPPORTED_SCOPE`). Onay yalnızca o iletiye aittir: gönderimle, kaynak
değişince, yeni ya da başka bir konuşmaya geçince kapanır; sonraki ileti ve
yeniden deneme yeni onay ister. Hareketlerdeki başlık, etiket, açıklama ve yineleme
kuralı önce/sonra değerleri de `changes` seçimine bağlıdır; seçilmemiş alanlar yürütücüde
kanıt kaydı ve model tüketiminden **önce** çıkarılır. Hareketlerde açıklama
önce/sonra değerleri de aynı seçime bağlıdır. Belirlenimci `ruleDescription`
kullanıcı metni değildir; normal bir kanonik olgudur. Veri sonradan bu
izdüşümü genişletemez. Olgu anlamı
kanonik yol/araç kimliği, türlü değer, etiket, uygulanabilen birim, süzgeç ve
gruplama, veri zamanı, Türkiye günü, tamlık ve null anlamını içerir. İç
kimlikler ve kaynak yönergeleri iddia değildir. Kayıtlı model düzyazısı ve
serbest SQL yüzeyi bu sözleşmeye dahil değildir.

Olgu yürüyüşü en fazla 12 derinlik ve 256 olgu, son yanıt en fazla 64 iddia ve
24.000 karakterle sınırlıdır. Doğrulama yalnızca seçilen iddia yollarını yürür;
uzun listedeki son kayıt da doğrulanabilir. Araç sonucu ayrıca 16 KiB sınırına
tabidir; kısaltılan sonuçlar için daha dar sorgu/ayrıntı gerekebilir.

Doğrulanamayan taslak **gösterilmez**; model **bir kez** sunucuya ait
`SUNUCU DOĞRULAMASI` yönergesiyle düzeltmeye çağrılır (kanıt varken yalnızca
yeniden yazım, araç kapalı; kanıt yoksa gerekli araç çağrılabilir). Düzeltme de
geçmezse kullanıcı sabit güvenli iletiyi görür ve bu ileti kaydedilir:

> Rota verilerine ilişkin yanıt doğrulanamadı. Soruyu daha dar kapsamda yeniden deneyin.

Bu yanıtın bitiş nedeni `grounding_failed`'dır ve hiçbir kanıtı kaydedilmez.

### 6.4 Kısmi kapsam notu

Yanıt kısmi kapsamlı bir kanıta atıf yapıyorsa sunucu her zaman şu notu ekler;
eklenen not yanıtla birlikte kaydedilir:

> _Not: Bu yanıt yalnızca görüntüleme yetkiniz bulunan kayıtları kapsar; ilgili projelerin tamamını yansıtmayabilir._

### 6.5 Kanıt künyesi (tarayıcıya giden)

`{ id, kind, label, entity: { type, id, name } | null, generatedAt, complete,
truncated, partial, counts: { returned, total }, highlights: [{ label, value }] }`
— en fazla 6 kısa öne çıkan değer. Künye araç adı, SQL, yetki ayrıntısı ya da
kayıt içeriği taşımaz; tarayıcı da aynı doğrulamadan geçirir (bozuk öğe atılır).

---

## 7. Sınırlı döngü, akış ve arayüz

### 7.1 Döngü

Gemma ile görülen metinsiz yerel araç çağrıları, isteğin ilk veri çağrısıyla
aynı asistan metninde bulunmasını bekleyen protokolü açığa çıkardı. Veri
okunmadan bildirim onarımları, veri sonrasında ise eksik nüfus/alt alan
bağları ek seçim ve onarım turları üretiyordu. Bunların Standart hatası
sayılarak Derin'e devredilmesi model turu sayısını büyütüyordu. Model
adını değiştirmek bu yapısal sorunu çözmez.

`Fast` genel sohbet profilidir; türlü Rota planı kullanıcının seçtiği kipin
araç profilinin işidir: Standart `chat.tools`, Derin düşünme
`chat.tools.reasoning`. Derin seçildiğinde modele bağlı her tur (plan, takip,
seçim) Derin profildedir; Standart araç profili ön koşul değildir ve Derin
kendine devretmez. Basit sayım/liste, yetki, SQL, doğrulama ve çizim her iki
kipte sunucuda tamamlanır. Standart kipte gerçek sentez isteği veri
toplandıktan sonra Derin profilinde olgu seçebilir.

| Yapısal durum | Önceki riskli yol | Güncel yol |
| --- | --- | --- |
| Basit sayım/liste, iki UI kipi | Bildirim + araç + seçim; onarım/devirle daha fazla tur | Seçilen kipin 1 türlü planı + 1 araç okuması + sunucu doğrulaması/çizimi |
| Yerel çağrı ve boş asistan metni | Bildirim reddi ve tekrarlanan pahalı onarım | `rota_plan` bağımsız değişkeninde istek; metin gerekmiyor; metin olarak dönen plan da aynı doğrulamadan geçer |
| Geçersiz plan | Düzeltmede plan baştan yazılır, süzgeçler kaybolur | Reddedilen kendi çağrısı + kayıt defteri ipucu; en fazla 2 bildirim turu, SQL yok |
| Belirsiz somut alan | Tek doğrulanan aday yanlış anlamı sabitleyebilir | Sunucu seçimi reddeder; 1 ucuz seçim turu, gerekirse sınırlı takip |
| Boş tamamlanma | Onarım/devir zinciri | Aynı profilde en fazla 1 yeniden deneme; Standart'ta sonra tek Derin devri |
| Gerçek sentez | Mekanik işlemler de Derin'de | Standart: veri toplama, ardından 1 Derin seçim; Derin: bütün tur Derin profilde |

Bu sayılar sağlayıcı ikizleriyle doğrulanan yapısal tur sayılarıdır; canlı
Gemma/DeepSeek/Qwen kalite veya duvar saati ölçümü değildir. 4096/8192
profil çıktı bütçeleri ve sağlayıcı/araç/oturum süre sınırları değiştirilmedi.

1. Seçilen kipin araç profili `rota_plan` üretir. İstek ve her kayıtlı
   aracın bağımsız değişkenleri veri okunmadan doğrulanır. Yerel araç çağrısı
   boş asistan metni taşıyabilir; metin olarak dönen aynı plan aynı
   doğrulamadan geçer; geçerli istek olmadan Rota aracı çalışmaz.
2. İlk okuma planı mevcut araç yürütücüsü, kapsam ve SQL sınırlarından geçer.
   En fazla 4 araç turu, turda 5 ve toplam 12 çağrı sınırı değişmez.
3. **Açıklama sınırı.** Her başarılı okumadan sonra ve sonraki HER sağlayıcı
   çağrısından önce güncel yetki ve kanıt nüfusu yeniden doğrulanır.
   Kanıt iptal edilmişse tur güvenli `unavailable` ile sonlanır; eski araç
   yükü içeren döküm sağlayıcıya tekrar gönderilmez. Okuma bir iş sayacına
   bağlıdır: arada model, araç ya da oturum işi yoksa aynı yetki art arda
   ikinci kez okunmaz; herhangi bir işten sonra yeniden okunur.
4. **Sunucu seçimi.** Tam, ilk sayfadaki kanıtın anlamı türlü sözleşmede
   bağlıysa kayıt defterinden aday türetilir. Araç/koleksiyon, alt alan,
   gruplama, derinlik, sıra, düzen ve ölçü/varlık eşlemesi belirsiz olamaz.
   Yalnızca bir adayın doğrulanması bu semantik koşulların yerine geçmez.
   Aynı ölçünün alternatif alanları veya toplam/satır düzeyi bağlanmamışsa
   seçim modele kalır. Üst üste binen eski ölçü kanıtı doğrulanmaz; çelişen
   veya yinelenen anlık görüntüler kendiliğinden düzleştirilmez. Güncellik
   aynı somut alan/koleksiyon, varlık, süzgeç ve gruplama/derinlik/metin
   izdüşümü içinde karşılaştırılır; başka nüfustaki aynı ölçü eski kaydı silmez.
   Değer isteğinde sayfalı aramanın satır dışı kesin toplamı (ör. `totalCount`)
   sayfa tamlığına bağlı değildir; satır olgusu ve liste/rank tam sayfa ister.
5. Uygun aday model çıktısıyla AYNI `analyzeGroundedAnswer` ve
   `verifyRequestedFacts` yolundan geçer. Liste tam satır nüfusunu, rank
   sınırdaki bütün eşitleri kapsar; boşluk yalnızca tam istenen koleksiyonla
   kanıtlanır. Aday yoksa seçilen kipin modeli takip aracı veya olgu seçimi yapar.
6. **Derin muhakeme.** Derin düşünme seçildiğinde modele bağlı bütün turlar
   `chat.tools.reasoning` ile çalışır. Standart kipte `reasoning: synthesis`
   gerçek yorum ihtiyacını bildirirse ve profil kuruluysa bildirilen ölçülerin
   kanıtı toplandıktan sonra aynı kanıt, kapsam ve bütçelerle bir kez
   `chat.tools.reasoning` kullanılır. Standart kipte ucuz kurtarma (iki bildirim
   düzeltmesi, tek yanıt düzeltmesi, tek boş yanıt yinelemesi) tükenince tur yine
   BİR kez Derin'e devredilir; veri okunduysa yalnızca bildirilen ölçülerin
   kanıtı hazırsa. NOT_FOUND, kapsam ya da SQL hatasıyla kanıtsız biten tur
   devredilmez. Biçim/kanıt düzeltmesi tek ortak onarım hakkını kullanır. İptal, veri veya
   süre aşımı hatası devri güvenli iletiye dönüştürmez; olağan hata sınırı korunur.
7. Boş tamamlanma oturumda en az 15 saniye kaldıysa aynı profilde bir kez
   yinelenir. İkinci boş yanıt Standart kipte tek Derin devrine, aksi hâlde
   `EMPTY_COMPLETION` hatasına gider; ölçümleri
   (kullanım ve ilk olay dahil) içeriksiz tur izinde korunur.
8. Yanıt ve yalnızca atıflı kanıt kısa işlemde yazılır. Kayıttan sonraki
   güncel erişim/açıklama denetimi geçmeden görünür SSE `delta` gönderilmez.
   Son tur izi bu kararın sonucunu bir kez kaydeder: kayıt ya da açıklama hatası
   `error` izi bırakır; görünür yanıt değiştirilmediyse özgün sonuç (ör.
   `general_redirect`) korunur. Kalıcı nüfusu sınıra sığmayan
   kendi yanıtı ancak aynı turun bellekteki nüfusu yeniden doğrulanırsa gösterilir.

### 7.2 Akış protokolü (sürüm 1, geriye uyumlu eklemeler)

| Olay | Ek |
| --- | --- |
| `accepted` | Kanıta dayalı yolda `rotaData: true` |
| `status` | Yeni evreler: `tools` (+ yalnızca veri alanı `topic`: `tasks`, `projects`, `portfolio`, `wbs`, `workload`, `people`, `activity`, `requests`, `notifications`, `baseline`, `dependencies`, `recurrence`, `calendar`, `outlook`, `quality`) ve `verifying` |
| `revise` | O ana kadar gösterilen taslak geçersiz (araç çağrısına dönüştü ya da doğrulanamadı); istemci metni siler |
| `done` | Kanıta dayalı yolda `assistantMessage.content` (kayıtlı, esas metin) ve `assistantMessage.evidence` |

Aşama 3 yolunda model protokolü ve bütün taslaklar tamponlanır. Doğrulanan
kanıtlı yanıt veya güvenli son ileti tek parça gönderilir;
JSON, doğrulanmamış önsöz veya sonradan silinecek olgular gösterilmez.
`revise` istemci sözleşmesinde uyumluluk için korunur. Araç özelliği kapalı
Aşama 2 yolu gerçek zamanlı akışını korur.

### 7.3 Arayüz

- İlerleme metni araç adını, bağımsız değişkeni ya da SQL'i göstermez; yalnızca
  veri alanını söyler ("Görevler inceleniyor…", "Baz plan
  karşılaştırılıyor…", "Yanıt kaynaklarla doğrulanıyor…").
- Atıf işaretleri küçük kaynak işaretleri olarak çizilir (`R1`, erişilebilir
  adı "Kaynak R1"); kopyalanan metinde `[R1]` olur.
- Yanıtın altında kapalı "N Rota kaynağı · Veri zamanı: …" paneli: kaynak
  başına etiket, tür, veri zamanı (Türkiye saati), "Yalnızca yetkili kayıtlar",
  "Kısaltılmış sonuç", "20 / 45 kayıt gösterildi" notları ve öne çıkan değerler.
- Doğrulanamayan yanıtta kopyalama düğmesi yoktur; açıklayıcı not gösterilir.
- Kayıtlı konuşma açıldığında kanıt künyeleri de yüklenir.
- Yardımcının arayüzdeki adı **Bilgin**'dir; yapılandırma ve kod adları
  (`MERGEN_ROTA_AI_*`, Rota AI) değişmez.
- Panel masaüstünde görünüm alanının yaklaşık %42'sidir (460–600 px; 1600 px ve
  üstünde en fazla 680 px) ve çalışma alanına her durumda en az 96 px bırakır;
  760 px ve altında tam ekran sayfadır.
- Yazma alanı tek yüzeydir: ileti ve altında TEK satırlık araç çubuğu.
  Çubukta **Yanıt kaynağı** (`Rota verisi` / `Genel sohbet` bölümlü radyo
  grubu), **Notlar ve iletiler** anahtarı, **Derin düşünme** anahtarı
  (kapalıyken Standart kip) ve Gönder/Durdur vardır; anahtarlar
  `role="switch"` taşır, açıklamaları ipucu ve ekran okuyucu metnidir. Çubuk
  sarmaz: kutu daraldıkça anahtar etiketleri önce kısalır (`Notlar`, `Derin`),
  sonra simgeye iner; erişilebilir adlar değişmez. Gönder ile Durdur aynı
  boyutta ve aynı sabit yuvada yer değiştirir; yanıt başlayınca ya da bir
  anahtar açılınca öteki denetimler kaymaz.
- Kök yerleşim statik kalır. `/runtime.js`, yalnızca açık/kapalı bayrağını
  istek anında SQL’siz ve sağlayıcı hazırlığı okumadan sunar. Bayrak kapalıysa
  kabuk yardımcı bileşeni, denetleyicisi ve stillerini yüklemez; başlatıcı,
  panel ve komut girdisi görünmez. AI uçları kendi sunucu kapısını korur.

- **Araç SQL kapısı:** 1 eşzamanlı sorgu, sıra 32; Sicil başına 1 etkin + 6
  bekleyen. Yapay zekâ SQL kapıları (rehber ve çalışma anı kimlik bilgisi okuması
  2, kişisel anahtar 2, konuşma 4, araç 1) toplam 9 bağlantılık bütçeye kayıtlıdır
  (`aiSqlGate`: havuz 10, olağan Rota için ayrılan 1); bütçeyi aşan kapı
  tanımı başlangıçta hata verir. Böylece 10 bağlantılı ortak havuzda olağan
  Rota trafiği için en az bir bağlantı ayrılmış kalır; yapay zekâ kapalıyken
  yapay zekâ SQL'i çalışmaz. Yer, sürücüdeki sorgu GERÇEKTEN bittiğinde
  bırakılır; iptal edilen tur yer tutmaya devam etmez, bırakılmış sorgular sınırı aşamaz.
- Liste döndüren sabit SQL'ler `TOP (@maxRows)` ile istenen sınırın bir fazlasını
  okur; fazladan satır kısaltma olarak bildirilir (`truncated`).
- Sağlayıcı yanıtı en fazla 16 çağrı ve 64 karakterlik araç adı taşıyabilir;
  aşan yanıt geçersiz sayılır (tur `AI_PROVIDER_RESPONSE_INVALID` ile biter).
  32 KiB'ı aşan bağımsız değişken metni saklanmaz; çağrı "aşırı büyük"
  işaretlenir ve yürütülmeden `INVALID_ARGUMENTS` alır.
- Ağ geçidinin araç oturumu dökümü en fazla 96 ileti taşır.

---

## 9. Belirlenimci tanımlar

Bütün hesaplar sunucuda, sabit kurallarla yapılır; model sayı hesaplamaz.

| Kavram | Tanım |
| --- | --- |
| Bugün | `Europe/Istanbul` iş günü (`businessDate`); UTC 21:30 → Türkiye'de ertesi gün |
| Durum | Ortak `PERSISTED_TASK_STATUSES`: `planned/not-started/todo` → `todo`; `in-progress/in_progress/blocked` → `in_progress`; `done/completed/cancelled` → `done`; tanınmayan → `todo`. SQL/JS/rapor geçişleri bu tanımı kullanır. |
| Açık görev | Durumu `done` olmayan |
| Gecikmiş | Açık **ve** termini (`targetFinish`) bugünden önce; gecikme günü = bugün − termin |
| Termini bugün | Açık ve termin = bugün |
| 7/30 gün içinde terminli | Açık ve bugün ≤ termin ≤ bugün + 6 / + 29 (bugün dâhil) |
| Termini olmayan | Açık ve termini boş |
| Takvim günü | Termin, yoksa planlanan bitiş |
| Tamamlanma tarihi | Gerçekleşen bitiş (`actualFinish`) |
| Tamamlanma oranı | Normal Rota ile ortak `taskCompletionRate`: `Math.round(tamamlanan / toplam * 100)`; boş kümede `0` |
| Gecikme yaşlandırması | 1–7, 8–30, 31–90, 91+ gün |
| Saat ve bütçe | Boş değer 0 sayılmaz: toplamla birlikte "değeri olan / olmayan görev" sayısı; para birimi Rota'da tutulmadığı için belirtilmez |
| Baz plan sapması | Güncel planlanan bitiş − baz plandaki planlanan bitiş (takvim günü); silinen ve sonradan eklenen görevler ayrıca sayılır |
| Bağımlılık | FS, SS, FF, SF ve gecikme (ör. "+2 gün", "−1 hafta") kayıtlı ilişkidir; kritik yol, bolluk ya da tarih hesabı yapılmaz |
| İş günü | Rota takvim kuralı: çalışma günleri eksi resmi tatiller, iki uç dâhil |
| İş yükü | Açık görev sayıları ve kişinin atandığı görevlerin task düzeyindeki planlanan saat toplamı; kişi-saat tahsisi, kapasite ya da aşırı yük yargısı değildir |

---

## 10. Araç kataloğu

Ortak: bütün araçlar salt okunurdur, süre sınırı 8 sn'dir ve sonuç zarfı §6.1
biçimindedir. Kimlik alanları GUID'dir ve arama araçlarının sonucundan gelir.

### 10.1 `rota_task_search` — görev arama

- **Amaç:** Yetkili görevleri süzgeçle listelemek ve süzgece uyan kesin toplamı vermek.
- **Girdiler:** `text`, `projectId`, `wbsId`, `status[]` (`todo`, `in_progress`, `done`), `priority[]`, `deadline` (`overdue`, `due_today`, `due_next_7_days`, `due_next_30_days`, `no_target_finish`), `dateField` + `dateFrom`/`dateTo`, `assignee` (`any`, `me`, `unassigned`), `personSicil`, `createdByMe`, `milestone`, `sort` (`target_finish_asc` varsayılan; gecikme süzgecinde `overdue_days_desc`), `limit` (1–50, varsayılan 20), `cursor`.
- **Yetki:** Anlık görüntünün görev görünürlüğü; kişi süzgeci yalnızca kimliği kullanıcıya açık sorumluluklarla eşleşir.
- **Kaynak:** `AI_TOOL_TASK_FACTS_SQL` (yetki + daraltıcı kaba süzgeç) → tam süzgeç, sıralama ve sayfalama saf JS'de.
- **Çıktı:** `tasks[]` (kimlik, başlık, proje, durum, öncelik, termin/plan/gerçekleşen tarihleri, gecikme günü, sorumlular), `sort`.
- **Tamlık:** `totalCount` kesin toplam; liste bir sayfa; `nextCursor` süzgeç ve sıralı veri kümesi özetine bağlıdır. Canlı ekleme/silme/sıralama değişimi eski imleci reddeder; aynı imleçle sessizce kayıt atlanmaz veya tekrarlanmaz.
- **Anlambilim:** §9; metin araması büyük/küçük harf ve aksan duyarsızdır: `ş/ç/ğ/ö/ü` taban harfleriyle eşleşir, kesin JS eşleşmesinde noktasız `ı` ayrı kalır; SQL'deki `CHARINDEX` yalnızca kaba daraltmadır. `%`/`_`/`[` düz metindir.
- **Örnek sorular:** "Bu hafta termini olan görevlerim neler?", "Radar projesinde gecikmiş kritik görevler hangileri?"

### 10.2 `rota_task_detail` — görev ayrıntısı

- **Amaç:** Tek görevin tam künyesi.
- **Girdiler:** `taskId` (zorunlu).
- **Yetki:** Görünmeyen görev `NOT_FOUND`; oluşturan ve eş sorumlu kimliği anlık görüntü kuralıyla; bağımlılık sayıları yalnızca FULL.
- **Kaynak:** `AI_TOOL_TASK_DETAIL_SQL`.
- **Çıktı:** açıklama (en fazla 1600 karakter, kısaltma bildirilir), proje ve iş dağılım yolu, durum, öncelik, kilometre taşı, tarihler, gecikme, ilerleme, saat, bütçe (para birimi yok), tekrar kuralı, sorumlular, oluşturan, takvim, erişim düzeyi ve nedeni, notlar.
- **Tamlık:** Tek kayıt; boş alanlar "yok" olarak değil `null` ve not olarak döner.
- **Örnek sorular:** "Anten kalibrasyonu görevinin durumu ne, kimde?"

### 10.3 `rota_task_analytics` — görev toplamları

- **Amaç:** Sayı, oran ve dağılım sorularının belirlenimci yanıtı.
- **Girdiler:** `rota_task_search` süzgeçleri + `groupBy` (`status`, `priority`, `project`, `assignee`, `deadline`, `target_month`), `limit` (grup sayısı, 1–25).
- **Yetki:** `rota_task_search` ile aynı; `assignee` grubunda gizli eş sorumlu kişi olarak sayılmaz ("Kimliği gösterilemeyen sorumlu").
- **Kaynak:** `AI_TOOL_TASK_FACTS_SQL` + saf toplamlar.
- **Çıktı:** `totals` (toplam, durumlar, açık, gecikmiş, bugün, 7 gün, terminsiz, gerçekleşen bitişi eksik tamamlanan, açık kilometre taşı, tamamlanma oranı), `overdueAging`, `hours` (saat/bütçe kapsamasıyla), `groups[]` (fazlası "Diğer n grup"), `definitions`.
- **Tamlık:** Bütün yetkili eşleşmeler üzerinde; 20 000 satırı aşan küme `RESULT_TOO_LARGE`.
- **Örnek sorular:** "Projede kaç gecikmiş görev var ve ne kadar süredir gecikiyorlar?", "Görevlerin aylara göre termin dağılımı?"

### 10.4 `rota_project_search` — proje çözümü

- **Amaç:** Ad ya da kod parçasından proje kimliğini çözmek.
- **Girdiler:** `text` (zorunlu), `limit` (1–10).
- **Yetki:** Yalnızca görmeye yetkili ETKİN projeler.
- **Kaynak:** `AI_TOOL_PROJECT_SEARCH_SQL` (tam eşleşme önce).
- **Çıktı:** `matches[]` (kimlik, ad, kod, kaynak etiketi ve kanonik `sourceType: corporate/manual`, erişim, lider, tam eşleşme), `resolution` (`unique`, `partial`, `ambiguous`, `none`), tek kesin eşleşmede `resolvedProject`, belirsiz/kısmi aramada en fazla 10 `candidates`, `ambiguous`, `guidance`.
- **Tamlık:** Yalnızca tek tam ad/kod eşleşmesi projeyi çözer; bulanık tek sonuç `partial` olur ve kimlik sayılmaz. Model tahmin etmez; sunucu adayları çizerek sorar (§6.3).
- **Örnek sorular:** "RDR kodlu proje hangisi?"

### 10.5 `rota_project_detail` — proje künyesi ve erişim nedeni

- **Amaç:** Proje bilgisi ve "neden görüyorum / neden tamamını göremiyorum".
- **Girdiler:** `projectId` (zorunlu).
- **Yetki:** Görünmeyen proje `NOT_FOUND`; erişim nedeni kullanıcının kendi yetkisidir (proje lideri, erişim hibesi, kurumsal rol, manuel sahip, sorumlu, oluşturan, yönetim kapsamı, sistem yöneticisi).
- **Kaynak:** `AI_TOOL_PROJECT_DETAIL_SQL` + yetki bağlamı.
- **Çıktı:** künye (kaynak etiketi ve kanonik `sourceType`, lider, takvim, etiketler, iş dağılım düğüm sayısı, FULL'da bağımlılık/baz plan sayısı), `access` (düzey, etiket, nedenler, tam görev görünümü), `visibleTasks` toplamları, `definitions`.
- **Örnek sorular:** "Bu projede neden bütün görevleri göremiyorum?"

### 10.6 `rota_portfolio_summary` — portföy

- **Amaç:** Görülebilen projelerin karşılaştırmalı özeti.
- **Girdiler:** `sort` (`overdue_desc` varsayılan, `open_desc`, `due_soon_desc`, `name_asc`), `source` (`all`, `corporate`, `manual`), `includeEmpty`, `limit` (1–25).
- **Yetki:** Kısmi projede yalnızca görünür görevler; proje satırı `completeTaskView` taşır.
- **Kaynak:** `AI_TOOL_PORTFOLIO_SQL`.
- **Çıktı:** `totals` (proje, görev, açık, tamamlanan, gecikmiş, 7 gün, terminsiz, gecikmeli proje), `projects[]`, `definitions`.
- **Örnek sorular:** "Hangi projede en çok gecikme var?"

### 10.7 `rota_wbs_inspect` — iş dağılım ağacı

- **Amaç:** Düğüm ve alt ağaç başına görünür görev, açık ve gecikmiş sayıları.
- **Girdiler:** `projectId` (zorunlu), `wbsId`, `depth` (1–4, varsayılan 2), `limit` (1–60).
- **Yetki:** §5 iş dağılım kuralı; `catalogVisibility`: `full-catalog` ya da `ancestor-chain-of-visible-tasks`.
- **Kaynak:** `AI_TOOL_WBS_SQL`.
- **Çıktı:** `nodes[]` (kod, ad, derinlik, alt düğüm, doğrudan/alt ağaç görev, açık, gecikmiş), `tasksWithoutWbs`, notlar.
- **Örnek sorular:** "Tasarım paketinde kaç açık görev var?"

### 10.8 `rota_workload_summary` — iş yükü

- **Amaç:** Açık görevlerin kişilere dağılımı.
- **Girdiler:** `projectId`, `personSicil`, `limit` (1–25).
- **Yetki:** Yalnızca görünür açık görevler; kişiye atıf yalnızca kimliği açık sorumluluklarla.
- **Kaynak:** `AI_TOOL_TASK_FACTS_SQL` + saf toplamlar.
- **Çıktı:** `people[]` (açık, devam eden, gecikmiş, 7 gün, `plannedHoursOnAssignedTasks` ve kapsaması; bu değer kişi-saat tahsisi değildir), `unassignedOpenTasks`, notlar (kapasite yargısı yok). Gizli sorumlu kimliklerinden ayrı bir adet/türemiş toplam üretilmez.
- **Örnek sorular:** "Ekipte kimde kaç açık iş var?"

### 10.9 `rota_person_search` — kişi çözümü

- **Amaç:** Ad ya da Sicil'den kişinin Sicil'ini çözmek (süzgeç için).
- **Girdiler:** `text` (zorunlu), `limit` (1–25).
- **Yetki:** Rota'nın var olan sınırlı kurumsal personel araması (ad için en az 2 karakter; geçerli Sicil için 1–10 rakam (1–2147483647), en fazla 25 satır, oturum başına hız sınırı); ad eşleşmesi kimlik ya da yetki kanıtı değildir.
- **Kaynak:** `searchCorporateDirectory`.
- **Çıktı:** `people[]` (Sicil, ad, unvan, birim), `resolution`, tek kesin Sicil ya da tam ad eşleşmesinde `resolvedPerson`, belirsiz/kısmi aramada en fazla 10 `candidates`, `ambiguous`, `sameNameCount`, `guidance`. Sınırlı dizin sonucunun son satırındaki tek kesin eşleşme, aynı adlı bir sonraki satırı dışarıda bırakmış olabileceğinden çözüm sayılmaz.
- **Örnek sorular:** "Ali Veli'nin görevleri?" (iki "Ali Veli" varsa model birimini sorar).

### 10.10 `rota_activity_search` — hareket geçmişi

- **Amaç:** Kim, ne zaman, neyi değiştirdi.
- **Girdiler:** `period` (`today`, `yesterday`, `last_7_days`, `custom` + `dateFrom`/`dateTo`, en fazla 366 gün), `scope` (`visible`, `mine`, `team`), `projectId`, `taskId`, `personSicil`, `kind`, `limit` (1–20), `cursor`.
- **Yetki:** Görev Hareketleri raporunun kuralı; `team` yalnızca yöneticilere (aksi `UNSUPPORTED_SCOPE`).
- **Kaynak:** `readTaskActivityReport`; AI çağrısı isteğe bağlı `taskId` süzgecini ve türlü değişiklik çıktısını açar. Normal rapor çağrısı ek çıktı üretmez.
- **Çıktı:** `range` (Türkiye günü), `summary`, `items[]` (iş diliyle değişiklikler ve `structuredChanges[]: {field,before,after}`). Kanonik durum, öncelik, sayı, boole ve tarih değerleri gösterim metninden ayrı tutulur; atama kimlikleri bu ek çıktıya konmaz.
- **Örnek sorular:** "Dün ekibimde hangi görevler tamamlandı?"

### 10.11 `rota_schedule_requests` — tarih değişikliği talepleri

- **Amaç:** Talepleri salt okunur listelemek.
- **Girdiler:** `tab` (`pending`, `sent`, `history`, `all`), `status`, `projectId`, `taskId`, `dateFrom`/`dateTo`, `text`, `limit`, `cursor`.
- **Yetki:** Kullanıcının talep eden ya da karar sahibi olduğu kayıtlar (Talepler ekranı).
- **Kaynak:** `readSchedulePage`.
- **Çıktı:** `counts` (kararınızı bekleyen, gönderilen, geçmiş), `items[]` (önerilen değişiklikler, iletiler, durum).
- **Örnek sorular:** "Kararımı bekleyen tarih talebi var mı?"

### 10.12 `rota_assignment_requests` — atama koordinasyonu

- **Amaç:** Kurum dışı atama koordinasyonu kayıtları.
- **Girdiler:** `tab`, `status`, `projectId`, `taskId`, `dateFrom`/`dateTo`, `text`, `limit`, `cursor`.
- **Yetki:** Talep eden, alıcı ve CANLI karar yetkisi; alıcı satırı tek başına yetki değildir.
- **Kaynak:** `readCoordinationPage`.
- **Çıktı:** `counts`, `items[]` (kararın kimde olduğu, kullanıcının karar verip veremeyeceği).
- **Örnek sorular:** "Onay bekleyen atama talebim var mı?"

### 10.13 `rota_notifications` — bildirimler

- **Amaç:** Kullanıcının kendi bildirim zilinin özeti.
- **Girdiler:** yok.
- **Yetki:** Yalnızca kullanıcının kendi bildirimleri; **okundu işaretlenmez.**
- **Kaynak:** `readScheduleInbox`, `readNotificationInbox`.
- **Çıktı:** okunmamış ve işlem bekleyen sayıları, tarih talepleri, atama koordinasyonu ve görev olaylarının son kayıtları.
- **Örnek sorular:** "Okumadığım bildirimler neler?"

### 10.14 `rota_baseline_compare` — baz plan karşılaştırması

- **Amaç:** Baz plan ile güncel planın sapması.
- **Girdiler:** `projectId` (zorunlu), `baselineId` (yoksa birincil, o da yoksa en yeni), `limit`.
- **Yetki:** Yalnızca FULL (aksi `UNSUPPORTED_SCOPE`).
- **Kaynak:** `AI_TOOL_BASELINE_SQL`.
- **Çıktı:** seçilen ve mevcut baz planlar, `counts` (kayan, öne alınan, değişmeyen, başlangıcı kayan, tarihi eksik, baz plandan sonra silinen/eklenen), `finishVariance` (ortalama, en büyük kayma, en büyük öne alma), `mostSlipped[]`, `definitions`.
- **Örnek sorular:** "Onaylı plana göre en çok kayan görevler hangileri?"

### 10.15 `rota_dependency_inspect` — bağımlılıklar

- **Amaç:** Görevin öncül/ardılları ya da projenin bağımlılık kapsaması.
- **Girdiler:** `taskId` ya da `projectId`.
- **Yetki:** Yalnızca FULL.
- **Kaynak:** `AI_TOOL_DEPENDENCIES_SQL`.
- **Çıktı:** öncüller/ardıllar (tür etiketi "Bitiş → Başlangıç (FS)", gecikme etiketi, tarihler) ya da proje kapsaması; "Kritik yol hesaplanmaz" notu.
- **Örnek sorular:** "Bu görev hangi görevleri bekliyor?"

### 10.16 `rota_recurrence_inspect` — tekrar serileri

- **Amaç:** Tekrarlayan görev serileri.
- **Girdiler:** `taskId` (şablon ya da yineleme), `projectId`, `limit`.
- **Yetki:** Yalnızca görünür görevler; kısmi projede yalnızca yetkili yinelemeler.
- **Kaynak:** `AI_TOOL_TASK_FACTS_SQL` + `describeRecurrenceRule`.
- **Çıktı:** kural ve Türkçe açıklaması, görünür yineleme, açık/tamamlanan/gecikmiş sayıları, sıradaki yinelemeler, son tamamlanan.
- **Örnek sorular:** "Haftalık toplantı serisinde kaç yineleme açık?"

### 10.17 `rota_calendar_inspect` — çalışma takvimi

- **Amaç:** Çalışma günleri, tatiller ve iş günü sayısı.
- **Girdiler:** `projectId` (yoksa varsayılan takvim), `dateFrom`/`dateTo` (yoksa bugünden 30 gün; en fazla 366 gün).
- **Yetki:** Proje takvimi için proje görünür olmalı.
- **Kaynak:** `AI_TOOL_CALENDAR_SQL` + `countWorkingDays`.
- **Çıktı:** takvim adı, saat dilimi, çalışma günleri, aralık, iş günü sayısı, tatiller.
- **Örnek sorular:** "Ekim sonuna kadar kaç iş günü var?"

### 10.18 `rota_outlook_status` — Outlook teslim durumu

- **Amaç:** Kullanıcının Outlook'a eklediği görevlerin Rota tarafındaki gönderim durumu.
- **Girdiler:** `taskId`, `limit`.
- **Yetki:** Yalnızca kullanıcının kendi görünür görev abonelikleri; görünmeyen aboneliklerin sayısı hiçbir alana/etikete çıkmaz. Belirli `taskId` için görünmeyen ve olmayan/aboneliği olmayan kayıtlar aynı `NOT_FOUND` sonucunu alır.
- **Kaynak:** `AI_TOOL_OUTLOOK_SQL` + ürünün hata iletileri.
- **Çıktı:** görünür etkin abonelik sayısı (kesilirse `null`), duruma göre görünür sayılar, `items[]`. Gizli abonelikler nüfusa, toplam/dağılıma, eksiklik ya da varlık işaretine katılmaz. Posta kutusu ya da davetin kabulü **bilinmez**.
- **Örnek sorular:** "Outlook'a eklediğim görevlerden gönderilemeyen var mı?"

### 10.19 `rota_data_quality` — plan veri kalitesi

- **Amaç:** Ürünün kendi plan bütünlüğü kurallarıyla denetim.
- **Girdiler:** `projectId`, `limit` (denetim başına örnek, 1–5).
- **Yetki:** Yalnızca görünür görevler; kısmi projede proje bütününü temsil etmez.
- **Kaynak:** `AI_TOOL_TASK_FACTS_SQL` + `PLAN_HYGIENE_CHECKS` (Pano'daki "Plan bütünlüğü" kartının kuralları; sorumlu kuralı yetkili sorumlu sayısıyla uygulanır).
- **Çıktı:** açık görevlerde gerçekten sorumlusuz, dizinde çözülemeyen atamalı, terminsiz, planlanan tarihi eksik, iş dağılımına bağlanmamış sayıları ve örnekleri; gerçekleşen bitişi eksik tamamlanan görevler.
- **Örnek sorular:** "Planımda eksik veri var mı?"

---

## 11. Hata sınıfları

| Kod | Anlamı |
| --- | --- |
| `INVALID_ARGUMENTS` | Şemaya uymayan bağımsız değişken (ayrıntı yalnızca alan yolu) |
| `UNKNOWN_TOOL` | Kayıtlı olmayan araç (ör. `execute_sql`) |
| `NOT_FOUND` | Kayıt yok ya da görme yetkisi yok (ayırt edilmez) |
| `UNSUPPORTED_SCOPE` | Bilgi yalnızca FULL erişime ya da yöneticiye açık |
| `UNSUPPORTED` | İstek araç tarafından desteklenmiyor |
| `RESULT_TOO_LARGE` | Sonuç güvenli sınırı aşıyor; süzgeci daraltın |
| `LIMIT_EXCEEDED` | Tur çağrı/süre/boyut sınırı |
| `TIMEOUT`, `BUSY`, `DATABASE_UNAVAILABLE`, `INTERNAL` | Hizmet hataları; ileti sabittir |

Sürücü hatası, SQL metni, bağlantı dizesi ya da yığın izi hiçbir koşulda modele,
tarayıcıya ya da günlüğe yazılmaz. Oturum ve iptal hataları araç sonucu değildir;
turu sonlandırır.

---

## 12. İstem enjeksiyonu savunması

- Araç sonuçlarındaki serbest metin (başlık, açıklama, ileti, ad) veridir:
  denetim karakterleri atılır, atıf işaretleri (`【R7】`, `[R7]`) `(R7)` biçimine
  nötrlenir ve metin kısaltılır. Görev açıklamasındaki "önceki talimatları yok
  say" gibi bir metin yalnızca veri olarak iletilir.
- Yönerge modele araç sonuçlarının talimat olmadığını söyler; ama güvenlik
  yönergeye bağlı değildir: katalog sunucudadır, kimlik ve yetki bağımsız
  değişkenle değiştirilemez, atıflar sunucuda doğrulanır.
- Önceki kanıtlı yanıtlar model geçmişinde sabit yeniden sorgulama notuyla değiştirilir. Güncel turun yönlendirmesi yeni karardır.
- İlk başarılı araç kümesinin seçimi takip kataloğunu, süzgeçlerini ve güvenilir varlık kimliklerini sınırlar; sonraki her başarılı küme kendi sabit takip araçlarını ekler (ör. kişi → görev listesi → görev ayrıntısı). Görev ayrıntısı başka görev/proje sorgusuna genişleyemez; arama metni ilk araç turunda da yalnızca kullanıcının bu turdaki iletisinde (açıklama yanıtında önceki sorusunda) geçiyorsa kullanılabilir (büyük/küçük harf, aksan ve noktalama katlanarak karşılaştırılır), metin izdüşümü veri tarafından açılamaz. Aynı aracın takibi en geniş kök değerleri (`visible`, `all`, `includeEmpty: true`) daraltabilir. Başarısız ilk küme kataloğu daraltmaz. Belirsiz adaylar kullanıcı seçimi gerektirir; belirsizlik yalnızca o aramanın adaylarını bağlar, aynı turdaki ilgisiz çözümlenmiş varlıkları engellemez. Tek kesin proje/görev adı eşleşmesi yalnızca o kaydı kimlik yapar; bulanık alternatifler takip kimliği olmaz. Proje kırılımlı toplu analizin grup kimlikleri sunucuya ait ayrıntı kökleridir.
- Toplu kanıtlar (görev araması ve analizinin toplamları, iş yükü, veri kalitesi) son yetki denetiminde yalnızca yükte görünen görevlerle değil, saydıkları bütün görev nüfusuyla yeniden doğrulanır; sayılan bir görev yetkili nüfustan çıktıysa kanıt düşer. Kimlikler analiz sınırı büyüklüğünde parçalarla okunur. Sunucu serbest model cümlesini onaylamaz; yetkili olgunun kayıt/alan/değer bağını doğrular ve kaçışlayarak çizer.

---

## 13. Veritabanı: 0018

`database/MR_Upgrade_0018_Ai_Message_Evidence.sql` tek bir tablo ekler:
`dbo.MR_AiMessageEvidence`.

| Sütun | Tür | Not |
| --- | --- | --- |
| `MessageId` | `uniqueidentifier` | PK₁; FK → `MR_AiConversationMessages(MessageId)` **ON DELETE CASCADE** |
| `Ordinal` | `tinyint` | PK₂; 1–16 (`R<n>`) |
| `ToolName` | `varchar(64)` | `rota_` ile başlar |
| `EvidenceType` | `varchar(40)` | Kanıt türü |
| `Label` | `nvarchar(200)` | Künye etiketi |
| `EntityType`, `EntityId` | `varchar(20)`, `nvarchar(64)` | İsteğe bağlı varlık |
| `GeneratedAt` | `datetime2(3)` | Veri zamanı (UTC) |
| `IsComplete`, `IsTruncated` | `bit` | Tamlık |
| `SummaryJson` | `nvarchar(4000)` | Tarayıcıya giden künye (`ISJSON`) |
| `EvidenceJson` | `nvarchar(max)` | Modele verilen güvenli sonuç zarfı (`ISJSON`, en fazla 64 KiB) |
| `CreatedAt` | `datetime2(3)` | `SYSUTCDATETIME()` |

- Yalnızca yanıtın **atıf yaptığı** kanıtlar, yanıtla **aynı kısa işlemde**
  yazılır. Ham sağlayıcı akışı, düşünce zinciri, başarısız denemeler, SQL ve
  anahtar saklanmaz.
- Tarayıcıya yalnızca `SummaryJson` döner; `EvidenceJson` yanıtın yeniden
  üretilebilirliği içindir ve hiçbir uçtan okunmaz.
- Kayıtlar konuşmayla birlikte silinir (cascade); ayrı bir saklama süresi yoktur.
- Betik yinelenebilirdir, `0017_ai_assistant_conversations` kaydı yoksa durur, önceden
  (elle) kurulmuş tabloda sütunları, fazladan zorunlu sütunu, birincil anahtarı,
  FK'nin cascade ve güvenilir olduğunu, kısıtların ve varsayılanın
  TANIMLARINI doğrular ve `0018_ai_message_evidence` kaydını yazar. Yeni kurulum
  `MR_Create_Durable_Persistence.sql` ile aynı tabloyu kurar; geri alma betiği
  kanıt tablosunu iletilerden ÖNCE düşürür.
- 0018 uygulanmadan açılan kurulumda Rota AI genel sohbetle çalışır (§3).

---

## 14. Gözlemlenebilirlik

Telemetri (`aiTelemetrySnapshot`) içerik taşımaz: soru, yanıt, görev adı,
bağımsız değişken, sonuç içeriği, SQL ya da anahtar kaydedilmez.

- `tools`: çağrı sayısı, sonuç sınıfına göre sayılar, araç başına çağrı/hata
  ve son gecikme/boyut (en fazla 40 araç), gecikme yüzdelikleri, son hizmet
  hatası (araç adı + kod).
- `grounding`: kanıtlı, genel, aday seçimi, bulunamadı, hizmet kullanılamıyor, doğrulanamayan, düzeltilen ve kapsam notu eklenen yanıt sayıları; tur ve kanıt sayısı yüzdelikleri. `NOT_FOUND` doğrulama hatası değildir. Tamponlanan model protokolü istemciye teslim edilmiş metin sayılmaz. `grounding.serverSelected`, olguları sunucunun istekten seçtiği (ayrı model seçim turu olmayan) kanıtlı yanıtları sayar.
- Her kanıta dayalı tur `ai.grounded.turn` bilgi olayı yazar: sonuç ve güvenli
  hata kodu, seçimi kimin yaptığı (`server` / `model`), devir, model ve araç
  turu, araç çağrısı/hatası, sonuç baytı, bildirim ve düzeltme sayısı, SQL
  süresi/sorgu sayısı, yetki yüklemesi, yeniden doğrulama ve doğrulama süreleri;
  her model turu için (en fazla 16) amaç (`plan`, `tools`, `follow-up`,
  `select`, `repair`, `declaration`, `retry`), profil, model, süre, ilk olaya
  kadar geçen süre, çıktı sınırı, bitiş nedeni, çağrı sayısı ve sağlayıcının
  bildirdiği girdi/tamamlama/akıl yürütme belirteçleri. Soru, yanıt, bağımsız
  değişken, kanıt içeriği, Sicil ya da anahtar yazılmaz.
- `grounding.escalations`: Standart → Derin düşünme devri sayısı, nedene
  (`SYNTHESIS_REQUIRED`, gerçek muhakeme isteğinde `VERIFICATION_FAILED`)
  ve son sonuca göre. Sonuç devredilen turun kendi sonucudur: doğrulanan yanıt
  (`grounded`, `clarification` …), `failed` (devirde de doğrulanamadı),
  `timeout` (sağlayıcı süre sınırı) ya da `error` (başka hizmet hatası).
  Her devir `ai.grounded.escalation` bilgi olayı yazar: istenen kip, kullanılan
  yapılandırılmış modeller, neden, kanıtın
  yeniden kullanılıp kullanılmadığı ve sonuç.
- `emptyCompletions`: görünür çıktı üretmeden biten model çağrıları. Her biri
  `ai.provider.empty_completion` uyarı olayı yazar: profil, model, bitiş nedeni,
  sağlayıcının bildirdiği girdi / akıl yürütme / tamamlama / görünür belirteç
  sayıları (bildirilmeyen `null`), araç çağrısı, akıl yürütme ve metin gelip
  gelmediği, ilk olaya kadar geçen süre ve toplam sağlayıcı süresi. İstem, araç
  verisi ya da model metni yazılmaz.
- İşletim olayı yalnızca beklenmeyen araç hatasında (`AI_TOOL_INTERNAL_ERROR`,
  yalnızca araç adıyla) yazılır.

Sistem Yönetimi → Genel Durum → Bileşen sağlığı → yapay zekâ hizmeti kartının
ayrıntısı: "Rota verisi araçları"
(açık/kapalı, kanıt tablosu durumu), araç çağrıları ve P95, hata sınıfları,
kanıta dayalı yanıt sayıları ve araç SQL kapısının doluluğu. Sağlık bileşeni
özellik açıkken şu durumlarda uyarır: kayıt defteri geçersiz, 0018 kurulmamış,
araç profilleri yok, son beş dakikada araç hizmet hatası.

---

## 15. Aşama 1–2 temellerindeki sınırlı değişiklikler

| Dosya | Değişiklik |
| --- | --- |
| `aiModelRegistry.js`, `defaultModelRegistry.js`, `config/ai-model-registry.onprem.json` | `chat.tools.reasoning` profili (`chat` + `tools` + `reasoning`) |
| `aiConfig.js`, `.env.example` | `MERGEN_ROTA_AI_TOOLS_ENABLED` (varsayılan `false`) |
| `openAiCompatibleProvider.js`, `openAiCompatibleStream.js` | `streamToolCompletion`: araç kataloğu, tel biçimi, sınırlı çağrı birleştirme; araçsız akış değişmedi |
| `aiGateway.js` | `runToolSession`: tek kira/süre/kimlik bilgisiyle çok turlu oturum; araç dökümü en fazla 96 ileti |
| `aiTelemetry.js`, `aiHealth.js`, `SystemOverviewTab.jsx` | Araç ve kanıt ölçümleri, uyarılar, yönetim görünümü |
| `assistantService.js`, `assistantStreamResponse.js` | Yol seçimi, `rotaData` hazırlığı, kanıtın yüklenmesi ve yazılması, `revise` ve yetkili `done` metni |
| `conversationQueries.js`, `conversationStore.js` | Kanıt okuma ve yanıtla birlikte yazma (0018) |
| `assistantContract.js` | Yeni evreler, `revise`, veri alanı konuları, daha dar kanıtlı bağlam bütçesi |
| `taskActivityReport.js`, talep okuma hizmetleri | AI için isteğe bağlı ham satır sınırı, yapısal değişiklik ve sınırlı tur anlık görüntüsü; normal sayfa davranışı değişmez |
| `src/features/ai/assistant/*`, `assistant.css` | İlerleme konusu, `revise`, atıf işareti, kanıt paneli |

Özellik kapalıyken bu değişikliklerin hiçbiri davranışı değiştirmez; Aşama 2
sınamaları değiştirilmeden geçer.

---

## 16. Yapılandırma ve dağıtım sırası

| Değişken | Varsayılan | Anlamı |
| --- | --- | --- |
| `MERGEN_ROTA_AI_TOOLS_ENABLED` | `false` | Rota verisi araçlarını açar; geçersiz değer araçları kapatır, genel sohbet sürer ve Sistem Yönetimi uyarı gösterir |

1. Veritabanının yedeğini alın.
2. `0017` uygulanmış veritabanında
   `database/MR_Upgrade_0018_Ai_Message_Evidence.sql` betiğini çalıştırın.
3. Sunucudaki model kaydı JSON'unda `chat.tools` ve `chat.tools.reasoning`
   profillerinin araç yetenekli modellere bağlı olduğunu doğrulayın
   (`config/ai-model-registry.onprem.json` referanstır).
4. Uygulamayı yeni sürümle `MERGEN_ROTA_AI_TOOLS_ENABLED=false` iken yayımlayın
   ve Aşama 2 davranışının değişmediğini doğrulayın.
5. `MERGEN_ROTA_AI_TOOLS_ENABLED=true` yapıp yeniden başlatın.
6. Sistem Yönetimi'nde "Rota verisi araçları: Açık · Kanıt tablosu: Hazır"
   görüldüğünü doğrulayın (tablo ilk turda ya da hazırlık okumasında denetlenir).
7. §17 elle kabul listesini uygulayın.

**Özellik geri alma:** `MERGEN_ROTA_AI_TOOLS_ENABLED=false` yeterlidir; kanıt
tablosu ve kayıtlar korunur, Rota AI genel sohbete döner. **Aşama 3 öncesi bir
uygulama sürümüne dönülecekse**, eski süreç başlatılmadan önce model kaydı da
önceki JSON'a döndürülmeli veya `chat.tools` / `chat.tools.reasoning`
profilleri kaldırılmalıdır; eski kayıt doğrulayıcısı bu profil kimliklerini
tanımaz. Tabloyu kaldırmak gerekirse
geri alma betiği kanıtı iletilerden önce düşürür.

---

## 17. Elle kabul listesi

- [ ] Özellik kapalıyken Rota AI Aşama 2 gibi yanıt verir; kanıt paneli yoktur.
- [ ] "Radar projesinde kaç görev var?" → yanıt `【R1】` ile atıflı, altında
      "1 Rota kaynağı · Veri zamanı: …" paneli; sayı Görevler ekranıyla aynı.
- [ ] Kısmi erişimli bir projede sayı sorusu → yalnızca görünür görevler
      sayılır ve sunucu her zaman kapsam notunu ekler.
- [ ] Görülmeyen bir projenin adı sorulduğunda "bulunamadı / yetkiniz yok";
      varlığı doğrulanmaz.
- [ ] İki aynı adlı kişi için model birimini sorar, tahmin etmez.
- [ ] Gecikmiş görev sayısı Pano ile aynı; Türkiye gece yarısı sınırında doğru.
- [ ] “Kaç gecikmiş görevim var ve hangileri?” Standart ve Derin kipte sayı ve
      satırlarla yanıtlanır; `ai.grounded.turn` olayında çoğunlukla
      `modelRounds: 1`, `selectedBy: "server"` görülür. Gecikmiş görevi olmayan
      kullanıcı “Eşleşen 0 görev” yanıtı alır.
- [ ] FULL olmayan projede baz plan/bağımlılık sorgusu veri döndürmez;
      doğrulanamayan yanıt sabit güvenli iletiyle sonuçlanır.
- [ ] "Bildirimlerim" sorusundan sonra zildeki okunmamış sayısı değişmez.
- [ ] Görev oluşturma/düzenleme istendiğinde yardımcı yapamayacağını söyler.
- [ ] Görev açıklamasına yazılmış "önceki talimatları yok say" metni yanıtı
      yönlendirmez.
- [ ] İlerleme metninde araç adı, JSON ya da SQL görünmez.
- [ ] Durdur, araç sorgusu sürerken turu keser; yanıt ve kanıt yazılmaz.
- [ ] Konuşma yeniden açıldığında kanıt paneli korunur; başka kullanıcı
      konuşmayı açamaz.
- [ ] Sistem Yönetimi araç çağrılarını ve kanıtlı yanıt sayılarını gösterir;
      içerik göstermez.

---

## 18. Otomatik sınamalar

| Dosya | Kapsam |
| --- | --- |
| `test/ai-tool-contracts.test.mjs` | Katı şema, türlü kayıt/alan/değer bağı, kardeş kayıt ve tur değişimi, kısa kodlar, tarih/süre kökeni, durum/boole olumsuzluklarının düzyazıyla kabul edilmemesi, yerel sayı çizimi, NULL/0, metrikler, hareket değerleri, enjeksiyon nötrleme, güvenli NOT_FOUND, kapsam ve sınırlar |
| `test/ai-disclosure-invariants.test.mjs` | Kalıcı yanıt/tekrar/özet yetki iptali, görev kimlik hakkı değişimi, eski kanıt, güvenli aday bağlamı, güncel bildirim görünürlüğü ve taşma sayacı |
| `test/ai-evidence-semantics.test.mjs` | Normalize takip kapsamı, 19 kökün kataloğu, metin izdüşümü, birim/null/tamlık, ondalık kesinlik, odaklı WBS ve süzgeçten sonra sınır |
| `test/ai-domain-tools.test.mjs` | 19 aracın yetki matrisi (yönetici, FULL, READ, kısmi, yönetim kapsamı, oluşturan, ilgisiz), 10 görevden 2'si görünen kısmi toplam, gizli eş sorumlu, aynı adlı kişi, NULL kapsaması, baz plan, bağımlılık türleri ve gecikme, tekrar, takvim, Outlook, bildirimlerin işaretlenmemesi, hareketler, `' OR 1=1 --`/`%`/`_`/`[`, sınırlar, sonuç boyutu, SQL kapısının bırakılması, küme başına yetki |
| `test/ai-grounded-assistant.test.mjs` | Uçtan uca: özellik bayrağı, kip/profil, 0018 eksikliği, türlü yanıt ve kalıcılık, oynatma, uydurma atıf ve düzeltme, güvenli ileti, kısmi kapsam notu, genel niyet bildirimi ve protokol tamponlama, tanınmayan araç, tur sınırı, istem enjeksiyonu, geçmiş olgularını yeniden sorgulama, Sicil yalıtımı, iptal, içeriksiz gözlem, sürücü hatası |
| `test/ai-evidence-boundaries.test.mjs` | Yönlendirme, aday seçimi, yeniden deneme, varlık/metin sınırı, yetki iptali, null/hassasiyet, canlı imleçler, gizli sayı, kısaltma ve tam sınırlar |
| `test/ai-provider-tool-calls.test.mjs` | Tel biçimi, parçalı çağrı birleştirme, sınırlar, bozuk/yarım çağrı, JSON yanıtı; tek kira, döküm doğrulaması, yetenek uyuşmazlığı, SQL işlemi |
| `test/ai-assistant-evidence-ui.test.mjs` | Çözücü (`revise`, konu, yetkili metin, künye doğrulaması), denetleyici, atıf işareti, kanıt paneli, sunum |
| `test/ai-grounding-hardening.test.mjs` | Kapsam sınırının güvenilir kaynakları (kullanıcı iletisi, veri öncesi türlü istek ve dönem bildirimi, açık serbest metin seçimi), aday belirsizliği ve tek kesin eşleşme, çok adımlı takip, takip kimliği yolları, toplu kanıtın nüfus doğrulaması, yönetici kanıtı, olgu niteleyicileri, etkinlik ilk/son kaydı, geçici tablo temizliği, geçici hazırlık hatası |
| `test/ai-request-contract.test.mjs` | Türlü istek sözleşmesi: kapalı şema ve güven kaynağı, bildirimsiz çağrının SQL çalıştırmaması ve sınırlı reddi, veri okunduktan sonra değişmeyen istek, veri metniyle yönlendirilememe; birleşik ölçü/koşul, sahiplik/öncelik/tarih nüfusu, ayrı ölçüler (planlanan/gerçekleşen, termin/takvim günü, ilerleme/tamamlanma oranı), varlık kapsaması, ad çözümü, sıralama ve sınırdaki eşitlik, liste bütünlüğü, satır özelliği/toplamı, iş akışı ve bildirim sayaçları; kayıt defteri tutarlılığı |
| `test/ai-scope-and-bounds-regressions.test.mjs` | Sonraki başarılı araçların kendi nüfusunu dondurması, ölçek koruyan iş yükü toplamı, WBS özyineleme sınırı, sayfalama kayması, kaçışlı atıflar, kaynak seçimi |
| `test/ai-architecture-contract.test.mjs` | Genel SQL aracı yok, araç SQL'i sabit ve salt okunur, kimlik alanı yok, tek SQL sahibi, 0018, panel genişliği ve Gönder/Durdur yuvası, kök yerleşimin yalnızca açık/kapalı bilgisini yazması |
| `test/ai-aggregate-population.test.mjs` | Toplu kanıtın tam görev nüfusu: listelenmeyen ama sayılan görevler, tarih/atama talebi, hareket, Outlook, tekrar, baz plan, bağımlılık ve WBS toplamları; son doğrulama, yeniden açılış ve sınıra sığmayan nüfusun "doğrulanamaz" işareti |
| `test/ai-system-admin-scope.test.mjs` | Yöneticinin proje başına kanonik FULL erişimi, proje kapıları ve yetki dönemi; etkin olmayan/var olmayan projenin yetkisiz projeyle aynı yanıtı |
| `test/ai-clarification-binding.test.mjs` | Kesin eşleşme / kısmi ve belirsiz aday; sunucunun çizdiği adaylar; yalnızca aday numarasının ("2", "#2") kayıtlı kimliğe bağlanması, sözcükle anlatılan seçimin yorumlanmaması |
| `test/ai-fact-selection-narrative.test.mjs` | Olgu seçimi protokolü, uydurma/başka tur başvurularının reddi, eski iddia biçimi, paragraf/liste/tablo anlatımı, Türkçe iyelik ekleri; sık soruların tek model turunda sunucu seçimiyle yanıtı ve yalnızca olgu seçen modelin aynı doğrulamadan geçmesi |
| `test/ai-grounded-round-budget.test.mjs` | Tur bütçesi: istemdeki örnek bildirimle “Kaç gecikmiş görevim var ve hangileri?” sorusunun Standart ve Derin kipte tek model turu, profil çıktı sınırı, düzeltme/devir olmaması, çizimden önce ve kayıttan sonra görünürlük okuması, kapsam notu, içeriksiz tur izi; ayrı/eksik bildirimin tek ek turu; boş nüfusun sayımla doğrulanması ve sınırları; birden çok doğrulanan seçimde seçimin modele kalması |
| `test/ai-free-text-consent.test.mjs` | İleti başına serbest metin onayı: kapalıyken arama, model girdisi, olgu ve sayım dışı; açıkken yine veri |
| `test/ai-tool-containment.test.mjs` | İlk turda da kullanıcı iletisinden gelen arama metni, normalize takip karşılaştırması, meşru daraltma ve ilgisiz genişlemenin reddi |
| `test/ai-evidence-selectors.test.mjs` | Sayıların proje/kişi/görev/dönem seçicileriyle çizilmesi, kimlik yerine ad, birim ve tekrar tamlığı |
| `test/ai-grounded-escalation.test.mjs` | Bildirilen muhakeme gereksiniminde veri sonrası Derin devri; eksik kanıtın önce ucuz profilde toplanması, ortak onarım/araç bütçesi, SQL'in yeniden kullanılmaması, süre aşımı/iptal/kimlik sınırları; ucuz bütçe tükenince tek Derin devri, Derin kipin kendine devretmemesi, içeriksiz tanı |
| `test/ai-grounded-mode-and-protocol.test.mjs` | Kipin araç profili (Derin, Standart profil olmadan da çalışır), metin/kod çiti/`<tool_call>` olarak dönen plan, planla birlikte doğrudan çağrı, reddedilen planın kayıt defteri ipucuyla düzeltilmesi ve SQL'siz sınırlı kurtarma, sıfır/sıfır olmayan sayım-liste-sıra, kayıt hatasında tek son iz, `general_redirect` sonucu, art arda yinelenmeyen ve işten sonra yinelenen yetki okuması |
| `test/ai-request-populations.test.mjs` | Tam koleksiyonla boşluk, kardeş/nested nüfuslar, somut alan ve gruplama kimliği, ölçü/varlık eşlemesi, eski/çelişen anlık görüntüler ve bağımsız metaveri |
| `test/ai-assistant-availability.test.mjs` | `MERGEN_ROTA_AI_ENABLED` kapalıyken başlatıcının, panelin ve komut paleti girdisinin gösterilmemesi; işaretin her istekte ortamdan okunması ve yapılandırma değeri taşımaması |

Yerel/CI doğrulaması: tüm Node sınamaları `--test-concurrency=1` ile,
`npm run lint` ve `npm run build`. CI Node 24.14.0 kullanır; Node 22
uyumluluğu da tam paketle doğrulanır. SQL ikizi davranış ve yetki matrisini
sınar; gerçek SQL Server sözdizimi/yürütme planı testi yerine geçmez. Dağıtım
öncesinde admin proje kapısı ve baz planın seçili/seçili olmayan dalları
gerçek veritabanında elle kabul kapsamındadır.

---

## 19. Aşama 3 kapsamı dışında kalanlar

- Anlamsal gösterim, vektör arama, RAG (Aşama 4);
- yapay zekâ eliyle herhangi bir yazma: görev oluşturma/düzenleme, atama,
  durum/tarih değişikliği, talep açma/karar, bildirim işaretleme, Outlook
  (Aşama 5);
- ses ve görsel girdi/üretim (Aşama 6);
- kritik yol, bolluk, kapasite ve aşırı yük hesabı; genel internet araması;
- birden çok uygulama örneği arasında paylaşılan araç SQL kapısı.


### Yanıt dili ve araç amaç sınırı

Kanıta dayalı yol Türkçe ve İngilizce yanıtları destekler. Yanıt dilini model
veri okunmadan önceki bildirimde `language: "tr" | "en"` olarak verir; sunucu
dili sözcük listesiyle tahmin etmez. Türlü değerlerin çizimi, kapsam notu ve
doğrulanamayan yanıt metni aynı dil sözleşmesini kullanır. Dil bildirilmezse
ya da soru başka bir dildeyse yanıt Türkçedir.

İlk başarılı araç kümesinden sonra katalog ve varlık/süzgeç sınırı sunucuya
aittir. Başarısız başlangıç daha doğru araca geçmeyi engellemez. Model üretimi
45 saniyelik araç yürütme bütçesine katılmaz; bütün model turları ağ geçidinin
oturum süresine tabidir. Varsayılan araç profilleri `chat.tools` için 4096,
`chat.tools.reasoning` için 8192 çıktı tokenıdır; dış model kaydının sınırı
aşılmaz. Bunlar tur başına üst sınırdır, hedef değildir (gerekçe: “Tur bütçesi
ve sunucu seçimi”). Kesilme kısa JSON ile yalnızca bir kez onarılır.

### Tur bütçesi ve sunucu seçimi

**Çalışma zamanı kök nedenleri.** OpenAI uyumlu bazı sohbet şablonları yerel
`tool_calls` üretirken sıradan asistan metnini boş bırakır. Gemma ile görülen
bildirim tekrarları bu ayrımı açığa çıkardı: çağrı vardı, metin içindeki özel
bildirim yoktu, dolayısıyla güvenli araç yürütme başlamıyordu. Bildirim,
biçim veya doğrulama hatasını Derin'e devretmek aynı protokolü pahalı modelde
yineledi. Bu gözlem modelin anlamsal kalitesine ilişkin bir ölçüm değildir.

Veri sonrası sorunlar aynı ölçü kimliğinin farklı alt alan, nüfus veya
toplam/satır düzeyi taşıyabilmesinden kaynaklanıyordu. WBS adı/kodu, örgüt
düzeyi, bağımlılık yönü/türü, analitik gruplama ve iş akışı türü yalnızca
`metrics` ile bağlanamaz. Genel ölçü ve varlık kapsaması doğru eşleşmeyi
kanıtlamaz. Eski ve yeni anlık görüntülerin düzleştirilmesi, başka boş
koleksiyonla satır ölçüsünün karşılanması ve sağlayıcı/akış sınırındaki geç
yetki denetimi ayrıca yanlış veya artık yetkisiz veriyi açıklayabiliyordu.

**Sorumluluklar.** Rota verisi için ilk plan seçilen kipin araç profilinde
yapılır: Standart `chat.tools`, Derin `chat.tools.reasoning`. `rota_plan` veri okumayan bir protokol
işlemidir; kayıttaki 19 salt okunur Rota aracını veya güvenlik sınırlarını
genişletmez. Model doğal dili türlü isteğe ve araç planına çevirir. Sunucu
şemayı, kapsamı, SQL sınırlarını, güncel erişimi, kanıt bütünlüğünü ve çizimi
yürütür. Hızlı yol uygun değilse seçilen kipin modeli olguları seçer. Standart
kipte Derin profil gerçek `reasoning: synthesis` ihtiyacı için veri sonrası ya
da ucuz kurtarma tükendiğinde bir kez kullanılabilir; Derin seçildiğinde modele
bağlı kısım Derin profilde kalır, yetki/SQL/doğrulama/çizim yine sunucudadır.
Genel sohbetin Fast/Standard/Deep profil çözümü bu değişiklikten etkilenmez.

**Seçim uygunluğu.** Tam ilk sayfa ve tek aday yeterli değildir: amaçlanan
araç/koleksiyon, alt alanlar, gruplama/derinlik, sıra, düzen ve çok varlıklı
ölçü ilişkileri türlü sözleşmede bağlı olmalıdır. Bir ölçünün kayıt defterinde
birden çok anlamlı taşıyıcısı varsa yalnızca tek taşıyıcının dolu olması
anlamı tekleştirmez; `fields` gerekir veya model seçimi yapılır. Satırla
birleşen toplamın o koleksiyonu saydığı sunucuda tanımlı olmalıdır. Yinelenen
veya üst üste binen ölçü kanıtları körlemesine birleştirilmez. Yeni örtüşen
ölçü eski seçimi `STALE_EVIDENCE` ile reddeder; güvenli, ayrı metaveri
aynı varlığa bağlı ölçü kanıtıyla birleşebilir. Yetki yenilemek ölçüyü yenilemez.

**Boş nüfus.** Sadece satır ölçüsü isteyen sıfır satırlı liste/rank geçerlidir.
Kanıt doğru, tam, kısaltılmamış, ilk sayfadaki tam istenen koleksiyonu
kanıtlamalıdır. Kardeş dizi, ilgisiz tekil zarf veya kipte olmayan koleksiyon
boşluk kanıtı olamaz. Tekrar oluşumlarında seri toplamı kullanılmaz;
iç koleksiyonun kendi sayım ve tamlık işaretleri gerekir. Çok değerli
özellikler ayrı nüfus sanılmaz. Sıralama sınırındaki bütün eşitler korunur;
bütün satırlar seçiliyorsa wildcard başvurusu gereksiz referans artışını önler.

**Açıklama sınırları.** Araç okumasından sonra ve her sağlayıcı takibinden
önce güncel erişim yeniden doğrulanır. İptal edilen kanıtla eski döküm tekrar
gönderilmez; tur güvenli sonlanır. Görünür çıktı son kayıttan sonraki açıklama
kararına kadar tamponlanır. Gizli sayı koruması, kısmi kapsam notu, atıflı
kanıt kaydı, kimlik ve kullanıcı yalıtımı, iptal/eşzamanlılık, araç ve SQL
sınırları ve salt okunurluk korunur. Olağan Rota sayfalarına yeni SQL eklenmez.

**Beklenen yapısal turlar.** Aşağıdakiler kod ve senaryo sözleşmesidir;
canlı model kalitesini veya bu ortamda ölçülmüş duvar saatini göstermez.

| Senaryo | Önceki sorunlu yol | Yeni hedef yol |
| --- | --- | --- |
| Standart basit devam eden sayımı | Bildirim/onarım → araç → seçim → olası Derin devri | 1 `chat.tools` planı → 1 okuma → sunucu yanıtı |
| Gecikmiş sayı + liste, Derin kipte | Derin seçimi yok sayılıp `chat.tools` kullanılıyordu | 1 `chat.tools.reasoning` planı → 1 okuma → sunucu yanıtı |
| Plan metin olarak döner ya da geçersizdir | Plan → onarım ile genel doğrulanamadı iletisi | Metin planı doğrulanır; geçersiz plan kendi çağrısı ve ipucuyla düzeltilir; tükenirse tek Derin devri |
| Yerel çağrı, boş asistan metni | Bildirim reddi ve tekrarları | Türlü planın çağrı bağımsız değişkenlerinden doğrulanması |
| Gerçekten bildirimsiz eski okuma çağrısı | Pahalı bildirim tekrarları | Okuma yapılmaz; en fazla 2 ucuz bildirim onarımı |
| Boş tamamlanma | Yeniden deneme ve olası Derin devri | Aynı profilde en fazla 1 yeniden deneme; Standart'ta sonra tek Derin devri |
| Anlamsal taşıyıcı belirsizliği | Tek aday yanlış biçimde kesin sayılır | Sunucu çekilir; ucuz model seçimi |
| Gerçek muhakeme ihtiyacı | Her mekanik işlem de Derin'de | Standart: ucuz plan/okuma → gerektiğinde 1 Derin oturumu; Derin: bütün tur Derin |

**Telemetri ve bütçeler.** `ai.grounded.turn` sıradan tur amacını tamamlanan
işleme göre sınıflandırır; plan, okuma/takip ve olgu seçimini ayırır.
Onarım/bildirim/yeniden deneme amaçları korunur. Bildirim sayacı yalnızca
gerçek bildirim denemelerini sayar. Bağlantı tekrarları tur gecikmesine
dahildir; boş tamamlanmanın kullanım ve ilk olay bilgisi hata üzerinde
taşınır. Model adı güvenilir oturumdan, bitiş nedeni kapalı sözlükten gelir.
Sonuç ve sunucu seçim sayacı son açıklama kararından sonra kaydedilir.
İz Sicil, soru, yanıt, görev/proje adı, istem, anahtar veya sağlayıcının
keyfi metaverisini içermez. Çıktı sınırları 4096/8192 ve bütün sağlayıcı/araç/
oturum süre sınırları korunur. Daha küçük aşama bütçesi ancak gerçek kullanım
ve kesilme ölçümüyle gerekçelendirilebilir.

Sağlayıcı ikizleri boş asistan metniyle yerel çağrı, bildirimsiz çağrı, boş
tamamlanma, doğru eski bildirim, belirsizlik ve erişim değişimini sınar.
Kullanılmayan betikli yanıt sayısı ayrıca denetlenir. Bu yapısal sınamalar
canlı Gemma/Qwen/DeepSeek kalitesinin kanıtı değildir. Canlı model süreleri
bu ortamda ölçülmedi; dağıtım kabulünde içeriksiz tur izleriyle ölçülmelidir.

### Yetki kökeni ve kanıt ömrü

Küme başına tek yetki okuması proje erişimi, kısmi görev kimlikleri, yönetici
bayrakları, görev başına oluşturucu/sorumlu/yönetim nedenleri ve yönetim
kapsamındaki kişi üyeliklerinden sunucu içi bir epoch
üretir. Defter her kanıtı bu epoch'a bağlar. Yeni proje/görev odaklı kanıt
ayrıca yalnızca ilgili proje ve görev nüfusunun yetki parmak izini taşır;
ilgisiz bir projeye hibe verilmesi bu kanıtı tek başına iptal etmez. Global
toplamlar ve eski kapsam parmak izi olmayan kanıtlar tam epoch kontrolünü
korur. Son çizimden önce yetki bir kez daha kapı/süre sınırı içinde okunur;
atıf yapılan görevlerin varlığı, güncel görünürlüğü ve proje üyeliği toplu,
sınırlı bir okumayla yeniden doğrulanır. Geçersiz kanıt ne
çizilir ne yanıtla kaydedilir. Epoch modele/tarayıcıya yetki ayrıntısı taşımaz.
Epoch `EvidenceJson` içinde kalıcıdır. Konuşma açma, tekrar oynatma ve
yazma uzlaştırması aynı merkezi açıklama kapısından geçer: kanıt nüfusunun
yetkisi veya atfedilen görev üyeliği doğrulanamıyorsa yanıt metni ve kaynak
künyeleri birlikte gizlenir. Tek bir atıf iptal olsa bile kayıtlı yanıtın
tamamı gizlenir; korunmuş metin genel sohbet geçmişine de alınmaz. Eski, epoch
içermeyen kanıt güvenilir sayılmaz; geçici kanıt/yetki okuma hatası `unavailable`
olarak gösterilir, yetki kaybı diye sunulmaz. Yeni doğrulanıp yazılan kendi
yanıtının tekrar okuması geçici olarak başarısızsa doğrulanmış sonuç korunur;
başka bir yazıcıyla uzlaştırılmış eski yanıt bu istisnayı kullanamaz.
Son yetki okumasının ayrı 8 saniyelik bütçesi vardır; tüketilmiş araç SQL
bütçesi başarılı kanıtı otomatik doğrulama hatasına çevirmez.
Bu, gözlenen yetki değişimini kapatan uygulama denetimidir; SQL okuması,
model üretimi ve yanıt teslimi atomik bir işlem değildir ve saklanmış geçmiş
kanıtı güncel veri yerine kullanılamaz.

Hareket, tarih talebi ve atama koordinasyonu sayfaları tek tur içinde en fazla
1000 kayıtlık sunucu anlık görüntüsünü paylaşır. Yeni turda eski iş akışı
imleci reddedilir; epoch değişince anlık görüntü atılır. Görev listeleri
sıralı veri özeti değişince imleci reddeder. Normal UI/rapor OFFSET davranışı
bu AI kuralları için değiştirilmez.

Tarih ve atama sayfalarında sayaçlar **seçilen sekmedeki** yetkili/süzülmüş
anlık görüntüyü sayar; sekmeler arası toplam gibi sunulmaz. Taşan nüfus
`RESULT_TOO_LARGE` olur. Bildirim önizlemesi kaynak başına sınırlı canlı
nüfustan kurulur; taşmada sayaçlar bilinmezdir. Geçmiş katılımcı/alıcı üyeliği
tek başına AI açıklama yetkisi değildir: görev etkin projede halen FULL/READ
ya da kişisel görev kapsamında olmalıdır. Normal rapor/bildirim SQL yolu
`evidenceSnapshotLimit` verilmedikçe AI birleşimlerini/bütçelerini çalıştırmaz.

Takip kökleri karşılaştırılmadan önce katı şemayla normalize edilir (null,
GUID, metin boşluğu). Sayfalama/sunum değişebilir; filtreler daralabilir;
metin araması dondurulur. İlk başarılı köklerin keşfettiği kimlikler ve açık
`TOOL_FOLLOW_UPS` ilişkileri izin listesi oluşturur. Görevden ilgisiz projeye
geçiş ve yeni serbest metin izdüşümü reddedilir. Kendi bildirim kökü kendi
talep/atama listesini açabilir; analitik, proje ve WBS kökleri kayıtlı
detay zincirlerini korur.

### Kanonik ölçüler ve kabul

Yedi günlük termin toplamı bugün dahil `[bugün, bugün+6]` aralığıdır; ayrık
gruplar `due_today`, `due_days_1_to_6`, `due_days_7_to_29` kullanır. Bilinen
değer yoksa saat/bütçe toplamı ve kişi iş yükü saati null kalır; bilinen sıfır
sıfırdır. Saat toplamları iki, bütçe/harcama dört ondalık ölçekle tamsayı tabanlı
olarak toplanır. SQL `decimal(19,4)` bütçe/harcamayı metin olarak taşır;
güvenli sayı aralığının dışında tam ondalık metin korunur ve yerel biçimde
çizilir. Para birimi varsayılmaz. Gecikme büyüklüğü aynı olgunun birimiyle,
saat ve parasal ölçüler kendi birimiyle çizilir. İç enum/süzgeç anahtarları
kullanıcıya ham gösterilmez; bilinmeyen etiketler genel değer olarak çizilir. Projeye seçilmiş varsayılan takvimin kökeni `project`,
yalnızca geri düşüşün kökeni `default` olur. WBS döngüsü yalnızca ona bağımlı alt ağaç ölçülerini
null ve sonucu eksik yapar; bağımsız sağlıklı dal toplamları korunur. Odaklı
WBS nüfusu yetkili alt ağaçla sınırlandırılır; odak geçişi 201 yinelemede
güvenle kesilir. Gizli tekrar şablonları açıklanmaz. Proje listesinde her
görünür yineleme ayrı kayıt olarak sayılır; odaklı görevde yalnızca o
yineleme sayılır. Gizli ebeveynin varlığı veya iki görevin aynı gizli seriye
bağlı olması sayıları, nüfusu ya da önizleme sınırını değiştiremez. Kısmi
hareketlerde gizli sorumlu değişiklikleri tek genel işaretle temsil edilir.

Otomatik sınamalar SQL/sağlayıcı ikizleriyle davranış güvencesi verir; gerçek
SQL Server yürütme planı veya canlı model sınıflandırması ölçümü değildir.
Dağıtımda FULL/READ/kısmi kullanıcılarla yetki iptali, eş adlı aday seçimi,
kısa Türkçe/İngilizce takip, ilgisiz genel soru, kesik çıktı, canlı sayfalama,
sınır nüfusları ve normal rapor gecikmesi elle kabul edilmelidir. Aşama 4
semantik temsil/vektör arama/yeniden sıralama/RAG'yi bu yetkili kanıt
sözleşmesine ekleyebilir; burada uygulanmaz. Aşama 5 yazma/işlem yetkisidir.

Görev takvimi etkin görev → etkin proje → etkin varsayılan sırasıyla SQL’de
çözülür; hiçbiri yoksa değer/köken null kalır. Tekrarda `lastCompleted`,
gerçek bitişi bilinen tamamlanan yinelemelerden en yeni gün ve kararlı görev
kimliğiyle seçilir; planlanan oluşum tarihi bitiş yerine kullanılamaz.
Gerçek bitişi eksik tamamlanmış yineleme varsa `completionDatesComplete=false`
ve sonuç eksiktir; bilinen gerçek bitiş yoksa `lastCompleted=null` olur.
