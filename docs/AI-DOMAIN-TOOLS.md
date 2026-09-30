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
| `src/server/ai/assistant/groundedPrompt.js`, `groundedAnswer.js` | Sunucuya ait yönerge ve sınırlı, doğrulanan döngü |

---

## 3. Kanıta dayalı yol ne zaman kullanılır?

Bir tur ancak **dördü birden** sağlanırsa kanıta dayalı yoldan yanıtlanır;
aksi hâlde Aşama 2 genel sohbet yolu aynen kullanılır:

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

`reason`: `TOOL_REGISTRY_INVALID`, `PROFILE_UNAVAILABLE` ya da
`EVIDENCE_SCHEMA_MISSING`. Özellik kapalıyken alan hiç bulunmaz.

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
  `LIKE` kullanılmaz (`CHARINDEX` ile Türkçe harmanlamada arama): `%`, `_`,
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
  sorumlu" olarak sayılır, kişi olarak atfedilmez.
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
  taşır; kısmi kapsamlı kanıta atıf yapan her yanıta sunucu sabit kapsam notunu
  ekler (§6.4).

---

## 6. Sonuç zarfı, kanıt ve atıf

### 6.1 Sonuç zarfı

Modele giden her başarılı sonuç:

| Alan | Anlamı |
| --- | --- |
| `ok` | `true` |
| `evidenceId` | Bu turdaki kanıt kimliği (`R1`, `R2` …) |
| `tool`, `generatedAt`, `today` | Araç adı, veri zamanı (UTC), Türkiye iş günü |
| `scope` | `kind` ve açıklama (aşağıda) |
| `complete` | Yetkili kapsamda eşleşen kayıtların tamamı döndü mü (başka sayfa/kısaltma yok) |
| `truncated` | Liste sınır ya da boyut nedeniyle kısaltıldı mı |
| `returnedCount`, `totalCount` | Döndürülen öğe ve eşleşen KESİN toplam |
| `nextCursor` | Sonraki sayfanın imleci (yoksa `null`) |
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

`complete` sayfalama bütünlüğüdür; kapsamın kısmi olup olmadığı `scope.kind`
(ve kanıt künyesindeki `partial`) ile taşınır.

### 6.2 Kanıt kimlikleri

- Yalnızca **başarılı** araç sonuçları kanıt olur; kimlikler turda **çağrı
  sırasıyla** verilir (tamamlanma sırasıyla değil).
- Aynı turda aynı araç aynı bağımsız değişkenlerle yeniden çağrılırsa SQL
  yeniden çalışmaz; önceki sonuç (aynı kanıt kimliği) verilir.
- Turda en fazla 12 çağrı yürütüldüğünden bir yanıt en fazla 12 kanıta dayanır
  (kalıcı sıra numarası üst sınırı 16'dır).

### 6.3 Atıf ve belirlenimci doğrulama

Atıf biçimi `【R1】`'dir (Markdown bağlantısıyla çakışmaz). Modelin küçük yazım
farkları (`[R1]`, `【 R1 】`, `【R1, R2】`) kanonik biçime getirilir; atıf
uydurulmaz ya da silinmez. Son yanıt **ikinci bir dil modeline sorulmadan**
şu kurallarla doğrulanır:

| Durum | Kural |
| --- | --- |
| Kanıt var | Her atıf bu turdaki bir kanıta işaret etmeli (`R99` gibi uydurma kimlik geçersiz); biçimsiz işaret geçersiz; en az bir geçerli atıf olmalı; **her paragraf kendi içinde**, her liste/tablo/başlık kendisinde ya da hemen komşu bloğunda geçerli atıf taşımalı; atıf yapılan sayı, tarih ve durum değerleri ilgili kanıt yükünde bulunmalı |
| Araç kullanılmadı (genel sohbet) | Yanıt hiçbir kanıt işareti taşıyamaz |
| Araç denendi ama kanıt yok (hata, bulunamadı) | Kanıt işareti yok **ve** Rota verisi olarak okunabilecek sayı/tarih yok (kod bloğu hariç); araç hatası tahminle doldurulamaz |

Doğrulanamayan taslak **gösterilmez**; model **bir kez** sunucuya ait
`SUNUCU DOĞRULAMASI` yönergesiyle düzeltmeye çağrılır (kanıt varken yalnızca
yeniden yazım, araç kapalı; kanıt yoksa gerekli araç çağrılabilir). Düzeltme de
geçmezse kullanıcı sabit güvenli iletiyi görür ve bu ileti kaydedilir:

> Rota verilerine ilişkin yanıt doğrulanamadı. Soruyu daha dar kapsamda yeniden deneyin.

Bu yanıtın bitiş nedeni `grounding_failed`'dır ve hiçbir kanıtı kaydedilmez.

### 6.4 Kısmi kapsam notu

Yanıt kısmi kapsamlı bir kanıta atıf yapıyorsa sunucu yanıta şu notu ekler;
model kapsamı ayrıca belirtmiş olsa da not eklenir ve yanıtla birlikte kaydedilir:

> _Not: Bu yanıt yalnızca görüntüleme yetkiniz bulunan kayıtları kapsar; ilgili projelerin tamamını yansıtmayabilir._

### 6.5 Kanıt künyesi (tarayıcıya giden)

`{ id, kind, label, entity: { type, id, name } | null, generatedAt, complete,
truncated, partial, counts: { returned, total }, highlights: [{ label, value }] }`
— en fazla 6 kısa öne çıkan değer. Künye araç adı, SQL, yetki ayrıntısı ya da
kayıt içeriği taşımaz; tarayıcı da aynı doğrulamadan geçirir (bozuk öğe atılır).

---

## 7. Sınırlı döngü, akış ve arayüz

### 7.1 Döngü

1. Model yanıt ya da araç çağrısı üretir (`toolChoice: auto`).
2. Çağrılar sunucuda sınırlarla yürütülür; her çağrı kimliği için tam bir araç
   iletisi eklenir.
3. En fazla **4 araç turu**; sonra araçlar kapatılır (`toolChoice: none`),
   modele sınır notu verilir ve yanıt eldeki kanıtla yazılır.
4. Son yanıt doğrulanır (§6.3); gerekirse bir düzeltme.

### 7.2 Akış protokolü (sürüm 1, geriye uyumlu eklemeler)

| Olay | Ek |
| --- | --- |
| `accepted` | Kanıta dayalı yolda `rotaData: true` |
| `status` | Yeni evreler: `tools` (+ yalnızca veri alanı `topic`: `tasks`, `projects`, `portfolio`, `wbs`, `workload`, `people`, `activity`, `requests`, `notifications`, `baseline`, `dependencies`, `recurrence`, `calendar`, `outlook`, `quality`) ve `verifying` |
| `revise` | O ana kadar gösterilen taslak geçersiz (araç çağrısına dönüştü ya da doğrulanamadı); istemci metni siler |
| `done` | Kanıta dayalı yolda `assistantMessage.content` (kayıtlı, esas metin) ve `assistantMessage.evidence` |

Akış dürüsttür: **kanıta dayanan yanıt doğrulanmadan gösterilmez ve tek parça
gönderilir** (sahte karakter akışı yoktur). Araç kullanmayan genel yanıt,
taslak 160 karakteri ya da iki satırı geçip atıf işareti taşımadığı anlaşılınca
gerçek zamanlı akar; ardından araç çağrısı ya da düzeltme gerekirse `revise`
gönderilir.

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

---

## 8. Sınırlar ve başarım

| Sınır (`toolLimits.js`) | Değer |
| --- | --- |
| Araç turu | 4 |
| Tek model yanıtında yürütülen çağrı | 5 (fazlası `LIMIT_EXCEEDED`) |
| Tur başına toplam çağrı | 12 |
| Tur içi eşzamanlı çağrı | 1 (aynı model yanıtındaki çağrılar sırayla yürütülür) |
| Çağrı süre sınırı | 8 sn (kapı beklemesi ve sorgu dâhil) |
| Tur boyunca araç SQL süresi | 25 sn |
| Araç evresi duvar saati | 45 sn |
| Tek sonuç | 16 KiB (büyük liste yarılanarak kısaltılır ve bildirilir; sığmazsa `RESULT_TOO_LARGE`) |
| Tur boyunca sonuçlar | 96 KiB |
| Bağımsız değişken | 8 KiB |
| Düzeltme turu | 1 |
| Analizde okunabilecek yetkili görev | 20 000 (aşarsa `RESULT_TOO_LARGE`: süzgeci daraltın) |
| İmleç ötelemesi | 1000 |

- **Araç SQL kapısı:** 2 eşzamanlı sorgu, sıra 32; Sicil başına 1 etkin + 6
  bekleyen. Yer, sürücüdeki sorgu GERÇEKTEN bittiğinde bırakılır; iptal edilen
  tur yer tutmaya devam etmez, bırakılmış sorgular sınırı aşamaz.
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
| Durum | `planned` → Yapılacak (`todo`), `in-progress` → Devam ediyor (`in_progress`), `done` → Tamamlandı |
| Açık görev | Durumu `done` olmayan |
| Gecikmiş | Açık **ve** termini (`targetFinish`) bugünden önce; gecikme günü = bugün − termin |
| Termini bugün | Açık ve termin = bugün |
| 7/30 gün içinde terminli | Açık ve bugün ≤ termin ≤ bugün + 6 / + 29 (bugün dâhil) |
| Termini olmayan | Açık ve termini boş |
| Takvim günü | Termin, yoksa planlanan bitiş |
| Tamamlanma tarihi | Gerçekleşen bitiş (`actualFinish`) |
| Tamamlanma oranı | Tamamlanan / toplam görünür görev, % bir ondalık |
| Gecikme yaşlandırması | 1–7, 8–30, 31–90, 91+ gün |
| Saat ve bütçe | Boş değer 0 sayılmaz: toplamla birlikte "değeri olan / olmayan görev" sayısı; para birimi Rota'da tutulmadığı için belirtilmez |
| Baz plan sapması | Güncel planlanan bitiş − baz plandaki planlanan bitiş (takvim günü); silinen ve sonradan eklenen görevler ayrıca sayılır |
| Bağımlılık | FS, SS, FF, SF ve gecikme (ör. "+2 gün", "−1 hafta") kayıtlı ilişkidir; kritik yol, bolluk ya da tarih hesabı yapılmaz |
| İş günü | Rota takvim kuralı: çalışma günleri eksi resmi tatiller, iki uç dâhil |
| İş yükü | Açık görev sayıları ve planlanan saat; kapasite ya da aşırı yük yargısı üretilmez |

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
- **Tamlık:** `totalCount` kesin toplam; liste bir sayfa; `nextCursor` aynı süzgeçle sonraki sayfa (imleç süzgeç özetine bağlıdır).
- **Anlambilim:** §9; metin araması Rota'nın diğer aramalarıyla aynı kuraldır (`CHARINDEX` + `Turkish_100_CI_AI`: büyük/küçük harf duyarsız, Türkçe harfler ayrı harf sayılır; model Türkçe karakterleri doğru yazmaya yönlendirilir); `%`/`_`/`[` düz metindir.
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
- **Çıktı:** `matches[]` (kimlik, ad, kod, kaynak, erişim, lider, tam eşleşme), `ambiguous`, `guidance`.
- **Tamlık:** Tek tam eşleşme yoksa `ambiguous = true`; model tahmin etmez, sorar.
- **Örnek sorular:** "RDR kodlu proje hangisi?"

### 10.5 `rota_project_detail` — proje künyesi ve erişim nedeni

- **Amaç:** Proje bilgisi ve "neden görüyorum / neden tamamını göremiyorum".
- **Girdiler:** `projectId` (zorunlu).
- **Yetki:** Görünmeyen proje `NOT_FOUND`; erişim nedeni kullanıcının kendi yetkisidir (proje lideri, erişim hibesi, kurumsal rol, manuel sahip, sorumlu, oluşturan, yönetim kapsamı, sistem yöneticisi).
- **Kaynak:** `AI_TOOL_PROJECT_DETAIL_SQL` + yetki bağlamı.
- **Çıktı:** künye (kaynak, lider, takvim, etiketler, iş dağılım düğüm sayısı, FULL'da bağımlılık/baz plan sayısı), `access` (düzey, etiket, nedenler, tam görev görünümü), `visibleTasks` toplamları, `definitions`.
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
- **Çıktı:** `people[]` (açık, devam eden, gecikmiş, 7 gün, planlanan saat ve kapsaması), `unassignedOpenTasks`, `openTasksWithOnlyHiddenAssignees`, notlar (kapasite yargısı yok).
- **Örnek sorular:** "Ekipte kimde kaç açık iş var?"

### 10.9 `rota_person_search` — kişi çözümü

- **Amaç:** Ad ya da Sicil'den kişinin Sicil'ini çözmek (süzgeç için).
- **Girdiler:** `text` (zorunlu), `limit` (1–25).
- **Yetki:** Rota'nın var olan sınırlı kurumsal personel araması (en az 2 karakter, en fazla 25 satır, oturum başına hız sınırı); ad eşleşmesi kimlik ya da yetki kanıtı değildir.
- **Kaynak:** `searchCorporateDirectory`.
- **Çıktı:** `people[]` (Sicil, ad, unvan, birim), `ambiguous`, `sameNameCount`, `guidance`.
- **Örnek sorular:** "Ali Veli'nin görevleri?" (iki "Ali Veli" varsa model birimini sorar).

### 10.10 `rota_activity_search` — hareket geçmişi

- **Amaç:** Kim, ne zaman, neyi değiştirdi.
- **Girdiler:** `period` (`today`, `yesterday`, `last_7_days`, `custom` + `dateFrom`/`dateTo`, en fazla 366 gün), `scope` (`visible`, `mine`, `team`), `projectId`, `taskId`, `personSicil`, `kind`, `limit` (1–20), `cursor`.
- **Yetki:** Görev Hareketleri raporunun kuralı; `team` yalnızca yöneticilere (aksi `UNSUPPORTED_SCOPE`).
- **Kaynak:** `readTaskActivityReport` (Aşama 3'te rapora isteğe bağlı `taskId` süzgeci eklendi; raporun kendisi değişmedi).
- **Çıktı:** `range` (Türkiye günü), `summary`, `items[]` (iş diliyle değişiklikler).
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
- **Yetki:** Yalnızca kullanıcının kendi abonelikleri; görünmeyen görevlerin aboneliği yalnızca sayı olarak.
- **Kaynak:** `AI_TOOL_OUTLOOK_SQL` + ürünün hata iletileri.
- **Çıktı:** etkin abonelik sayısı, duruma göre sayılar (etkin, bekliyor, bekletiliyor, başarısız), `items[]`, görünmeyen görev aboneliği sayısı; posta kutusu ya da davetin kabulü **bilinmez**.
- **Örnek sorular:** "Outlook'a eklediğim görevlerden gönderilemeyen var mı?"

### 10.19 `rota_data_quality` — plan veri kalitesi

- **Amaç:** Ürünün kendi plan bütünlüğü kurallarıyla denetim.
- **Girdiler:** `projectId`, `limit` (denetim başına örnek, 1–5).
- **Yetki:** Yalnızca görünür görevler; kısmi projede proje bütününü temsil etmez.
- **Kaynak:** `AI_TOOL_TASK_FACTS_SQL` + `PLAN_HYGIENE_CHECKS` (Pano'daki "Plan bütünlüğü" kartının kuralları; sorumlu kuralı yetkili sorumlu sayısıyla uygulanır).
- **Çıktı:** açık görevlerde sorumlusuz, terminsiz, planlanan tarihi eksik, iş dağılımına bağlanmamış sayıları ve örnekleri; gerçekleşen bitişi eksik tamamlanan görevler.
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
- Önceki yanıtların atıf işaretleri geçmişten çıkarılır: eski kanıt yeni turun
  kanıtı değildir.

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
- `grounding`: kanıtlı, genel, doğrulanamayan, düzeltilen, kapsam notu eklenen
  yanıt sayıları; tur ve kanıt sayısı yüzdelikleri.
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
| `taskActivityReport.js` | İsteğe bağlı `taskId` süzgeci |
| `src/features/ai/assistant/*`, `assistant.css` | İlerleme konusu, `revise`, atıf işareti, kanıt paneli |

Özellik kapalıyken bu değişikliklerin hiçbiri davranışı değiştirmez; Aşama 2
sınamaları değiştirilmeden geçer.

---

## 16. Yapılandırma ve dağıtım sırası

| Değişken | Varsayılan | Anlamı |
| --- | --- | --- |
| `MERGEN_ROTA_AI_TOOLS_ENABLED` | `false` | Rota verisi araçlarını açar; geçersiz değer yapılandırma hatasıdır |

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
      sayılır ve yanıt kapsamı belirtir (ya da sunucu notu eklenir).
- [ ] Görülmeyen bir projenin adı sorulduğunda "bulunamadı / yetkiniz yok";
      varlığı doğrulanmaz.
- [ ] İki aynı adlı kişi için model birimini sorar, tahmin etmez.
- [ ] Gecikmiş görev sayısı Pano ile aynı; Türkiye gece yarısı sınırında doğru.
- [ ] FULL olmayan projede baz plan/bağımlılık sorusu "yalnızca tam yetkiye
      açık" yanıtı alır.
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
| `test/ai-tool-contracts.test.mjs` | Bağımsız değişken katılığı, SQL benzeri metin, şema/kayıt defteri reddi, belirlenimci tanımlar, Türkiye günü sınırı, imleç, kapsam belirteçleri, veri nötrleme, atıf doğrulaması (`【R99】`), kapsam notu, güvenli hata eşlemesi |
| `test/ai-domain-tools.test.mjs` | 19 aracın yetki matrisi (yönetici, FULL, READ, kısmi, yönetim kapsamı, oluşturan, ilgisiz), 10 görevden 2'si görünen kısmi toplam, gizli eş sorumlu, aynı adlı kişi, NULL kapsaması, baz plan, bağımlılık türleri ve gecikme, tekrar, takvim, Outlook, bildirimlerin işaretlenmemesi, hareketler, `' OR 1=1 --`/`%`/`_`/`[`, sınırlar, sonuç boyutu, SQL kapısının bırakılması, küme başına yetki |
| `test/ai-grounded-assistant.test.mjs` | Uçtan uca: özellik bayrağı, kip/profil, 0018 eksikliği, atıflı yanıt ve kalıcılık, oynatma, uydurma atıf ve düzeltme, güvenli ileti, kısmi kapsam notu, canlı genel yanıt ve `revise`, tanınmayan araç, tur sınırı, istem enjeksiyonu, geçmişten atıf ayıklama, Sicil yalıtımı, iptal, gözlemin içeriksizliği, sürücü hatası |
| `test/ai-provider-tool-calls.test.mjs` | Tel biçimi, parçalı çağrı birleştirme, sınırlar, bozuk/yarım çağrı, JSON yanıtı; tek kira, döküm doğrulaması, yetenek uyuşmazlığı, SQL işlemi |
| `test/ai-assistant-evidence-ui.test.mjs` | Çözücü (`revise`, konu, yetkili metin, künye doğrulaması), denetleyici, atıf işareti, kanıt paneli, sunum |
| `test/ai-architecture-contract.test.mjs` | Genel SQL aracı yok, araç SQL'i sabit ve salt okunur, kimlik alanı yok, tek SQL sahibi, 0018 |

---

## 19. Aşama 3 kapsamı dışında kalanlar

- Anlamsal gösterim, vektör arama, RAG (Aşama 4);
- yapay zekâ eliyle herhangi bir yazma: görev oluşturma/düzenleme, atama,
  durum/tarih değişikliği, talep açma/karar, bildirim işaretleme, Outlook
  (Aşama 5);
- ses ve görsel girdi/üretim (Aşama 6);
- kritik yol, bolluk, kapasite ve aşırı yük hesabı; genel internet araması;
- birden çok uygulama örneği arasında paylaşılan araç SQL kapısı.
