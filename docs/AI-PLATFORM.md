# Yapay Zekâ Altyapısı (Aşama 1)

Bu belge MERGEN Rota'nın yapay zekâ **temelini** anlatır: kişisel ve kurumsal
API anahtarının yönetimi, sağlayıcı soyutlaması, model/yetenek kaydı, sınırlı
eşzamanlılık, iptal ve süre sınırları, hata sınıflandırması, gözlemlenebilirlik
ve tek bir uçtan uca bağlantı sınaması.

Aşama 1 bir sohbet ürünü **değildir**. Amaç, sonraki aşamaların güvenle
dayanabileceği küçük ama sağlam bir altyapıdır. Kapsam dışı bırakılanlar
[§16](#16-aşama-1-kapsamı-dışında-kalanlar)'da listelenir.

---

## 1. Mimari sınır

```
Tarayıcı ──► /api/mergen-rota/ai/*  (Node çalışma zamanı, önbelleksiz)
               │
               ▼
          aiGateway  ── güvenilir Sicil → rehber üyeliği → yapılandırma → profil
               │         → kapasite kirası → kimlik bilgisi → sağlayıcı
               ▼
   OpenAI uyumlu kurum içi yapay zekâ ağ geçidi
```

- Tarayıcı **yalnızca** MERGEN Rota sunucusuyla konuşur. Sağlayıcının adresi,
  model dizisi ve hiçbir anahtar tarayıcıya ulaşmaz; `NEXT_PUBLIC_` ile açılan
  bir yapay zekâ ayarı yoktur.
- Alt sistemin tek yürütme yolu `src/server/ai/aiGateway.js`'tir. İş kodu somut
  modeli değil **profili** ister (§5).
- **Olağan Rota akışı yapay zekâya bağımlı değildir.** Anlık görüntü, kayıt,
  görev düzenleme, gezinme ve raporlar `src/server/ai` modüllerini içe
  aktarmaz; alt sisteme yalnızca Ayarlar kartı, Sistem Yönetimi'nin sağlık ve
  entegrasyon gözlemi ile telemetri turunun yük örneklemesi bağlanır. Bu sınır
  `test/ai-architecture-contract.test.mjs` ile korunur.
- **Kira öncesi iş de sınırlıdır.** Rehber üyeliği kapasite kirasından önce,
  kendi 5 sn süre sınırıyla ve süreç başına en fazla iki eşzamanlı SQL
  sorgusuyla denetlenir (sıra 64; dolunca istek beklemeden `AI_BUSY` alır,
  `details.saturation: directory`). Kapı Sicil başına adildir: tek bir Sicil
  aynı anda bir sorgu çalıştırır ve sırada en fazla sekiz isteği bekler
  (aşarsa `AI_BUSY`, `saturation: user`); sırayı tek başına doldurup öteki
  kullanıcıları geri çevirtemez. Havuz bağlantısı kapıya girmeden (yer
  tutmadan) alınır: takılı bir bağlantı kurulumu kapıyı kilitleyemez. Yer,
  çağıranın vazgeçtiği anda değil sürücüdeki sorgu GERÇEKTEN bittiğinde
  bırakılır: süre aşımları, bırakılmış sorgular sürerken yenilerini başlatarak
  sınırı aşamaz. Süre dolarsa istek `DATABASE_UNAVAILABLE`
  (`DIRECTORY_PREFLIGHT_TIMEOUT`) ile döner. Anahtar durumu, kaydı ve
  kaldırması (Ayarlar kartı) da ortak havuzu aynı kurallarla işleyen ayrı bir
  kapıdan kullanır (iki sorgu, sıra 32, Sicil başına bir etkin + dört
  bekleyen). Böylece bir yapay zekâ isteği ya da ayar trafiği yığını ortak SQL
  havuzunu tüketemez. Dosya kaydının okunması da istemcinin iptalini izler.
- **Üretim beklenirken veritabanı tutulmaz.** Ağ geçidi açık bir SQL işlemi
  içinde çağrılırsa reddeder (`SQL_TRANSACTION_ACTIVE`). Kimlik bilgisi tek,
  kısa ve süre sınırlı bir SQL isteğiyle okunur; bağlantı havuza döner ve
  sağlayıcı çağrısı ondan SONRA başlar.
- **Küresel kilit yoktur.** Farklı kullanıcıların istekleri kapasite dolana
  kadar birlikte yürür (§6).
- Süreç düzeyindeki tekiller (kapasite denetimi, sağlayıcı bağdaştırıcısı, ağ
  geçidi, model kaydı, telemetri) `globalThis` üzerinde bir kez kurulur;
  geliştirmede modül yeniden yüklemesi ikinci bir kapasite havuzu açmaz.

### Modül haritası

| Modül | Sorumluluk |
| --- | --- |
| `src/domain/ai/aiErrorCatalog.js` | Kararlı hata kodları, HTTP durumu, yinelenebilirlik, Türkçe ileti |
| `src/domain/ai/aiModelRegistry.js` | Yetenekler, profiller, kayıt doğrulama ve profil → model çözümü (saf) |
| `src/domain/ai/aiCredentialPolicy.js` | Anahtar kaynağı kuralı, anahtar biçimi denetimi, gösterim ipucu (saf) |
| `src/server/ai/aiConfig.js` | Ortam değişkenlerinin kapalı kalacak biçimde doğrulanması |
| `src/server/ai/credentialVault.js` | AES-256-GCM şifreleme, HKDF anahtar türetme, Sicil'e bağlama |
| `src/server/ai/aiCredentialQueries.js`, `aiCredentialStore.js` | Sabit, Sicil ile sınırlı SQL ve kalıcılık |
| `src/server/ai/aiCredentialService.js` | Kişisel anahtar kaydı/kaldırma ve çalışma zamanı kimlik bilgisi çözümü |
| `src/server/ai/admissionController.js` | Sınırlı eşzamanlılık, sıra ve geri basınç |
| `src/server/ai/aiDeadline.js` | Tek sinyalde süre sınırı + iptal, iptal edilebilir bekleme |
| `src/server/ai/providers/openAiCompatibleProvider.js` | OpenAI uyumlu HTTP bağdaştırıcısı ve durum → hata eşlemesi |
| `src/server/ai/aiGateway.js` | Sohbet tamamlama ve kişisel anahtar doğrulaması |
| `src/server/ai/modelRegistryLoader.js`, `defaultModelRegistry.js` | Model kaydının yüklenmesi ve varsayılan eşleme (veri) |
| `src/server/ai/aiTelemetry.js`, `aiHealth.js` | Telemetri, sağlık bileşeni ve entegrasyon kartı |
| `src/server/ai/aiDiagnosticProbe.js`, `aiProbeProfile.js` | Sabit istemli Aşama 1 bağlantı sınaması; sınama profilinin kullanılabilirliği ve sunucu süre bütçesi |
| `src/server/ai/aiRouteSupport.js`, `aiRuntime.js`, `aiErrors.js` | Uç yardımcıları (aynı kaynak denetimi dâhil), süreç tekilleri, `AiError` |
| `src/features/ai/*` | Ayarlar kartı, istemci sarmalayıcısı ve saf sunum kuralları |

---

## 2. Anahtarın sahibi: güvenilir Sicil

- Kişisel anahtarın sahibi **her zaman** oturumdaki Sicil'dir
  (`getTrustedCurrentSicil()`: Keycloak HttpOnly oturumu ya da yalnızca yerel
  geliştirmede açılan geliştirme kimliği).
- Hiçbir uç Sicil'i, kullanıcı adını ya da görünen adı istek gövdesinden, sorgu
  dizesinden ya da başlıktan almaz; kimlik yalnızca sunucunun doğruladığı
  oturumdan türetilir. Kullanıcı adla eşleştirilmez.
- Kimlik her denetimden **önce** doğrulanır: oturumu olmayan çağıran,
  yapay zekânın açık olup olmadığını ya da yapılandırma durumunu öğrenemez.
- Oturumdaki Sicil'in kurumsal personel kaynağında (`MR_V_PeopleDirectory`)
  bulunduğu da yapılandırma, profil, gövde, anahtar biçimi ve anahtar tablosu
  kararlarından **önce** denetlenir. Bu denetim anahtar tablosuna dokunmayan
  ayrı bir sorguyla yapılır ve anahtar tablosu ancak ondan sonra okunur: 0016
  uygulanmamış kurulumda da rehberde olmayan Sicil kurumsal anahtarı
  kullanamaz ve tablonun durumunu (yetki, şema) öğrenemez. Kaydetme ucu gövdeyi ancak bu iki denetimden
  sonra okur: oturumu olmayan ya da rehberde bulunmayan çağıran bozuk gövde,
  içerik türü ya da boyut kararlarını (`MALFORMED_JSON`, `CONTENT_TYPE`,
  `BODY_TOO_LARGE`) yoklayamaz, `UNAUTHORIZED` alır.
- Her SQL deyimi yalnızca `@sicil` satırına dokunur (`WHERE Sicil = @sicil`).
  Başka bir Sicil'in satırını okuyan, değiştiren ya da silen bir yol yoktur;
  A kullanıcısının anahtarı B kullanıcısına hiçbir koşulda ulaşmaz (ayrıca
  şifre, Sicil'e bağlıdır — §4).
- Kurumsal personel kaynağında bulunmayan Sicil `UNAUTHORIZED` alır.
- Durum değiştiren uçlar (`PUT`/`DELETE /credential`, `POST /credential/validation`,
  `POST /probe`) ve Sistem Yönetimi'nin bağlantı testi yalnızca **aynı
  kaynaktan** gelen isteği kabul eder (`Origin` ve `Sec-Fetch-Site` denetimi;
  oturum kapatma ucuyla aynı kural). Kaynak **şema + ana bilgisayar** olarak
  karşılaştırılır: vekil istemciye dönük şemayı `X-Forwarded-Proto` ile açıkça
  bildiriyorsa şema bire bir eşleşmelidir (`http` bildirilen hedefe `https`
  kaynağı da reddedilir). Başlık yoksa şema isteğin kendi adresinden bilinir:
  `https` hedefe `http` kaynağından gelen istek reddedilir; TLS'i sonlandırıp
  başlığı iletmeyen vekilin arkasında tarayıcının `https` kaynağı kabul edilir.
  Vekil zincirinde virgülle eklenen
  `X-Forwarded-Host`/`X-Forwarded-Proto` değerlerinin yalnızca ilki kullanılır.
  Oturum çerezi `SameSite=Lax` olduğundan, aynı sitedeki kardeş bir kaynağın
  basit bir formu gövdesiz `POST` uçlarına kullanıcının anahtarıyla istek
  gönderip kapasite tüketebilirdi. Aykırı istek `FORBIDDEN` (403) alır.

---

## 3. Anahtar kaynağı kuralı

Çözüm tek kurala dayanır ve yalnızca **varlığa** bakar:

1. Sicil'in kayıtlı bir kişisel anahtarı **varsa** yalnızca o kullanılır
   (`credentialSource: personal`).
2. Kişisel anahtar **yoksa** ve kurumsal anahtar tanımlıysa kurumsal anahtar
   kullanılır (`default`).
3. İkisi de yoksa istek `AI_KEY_MISSING` (409) ile döner (`missing`).

**Kişisel anahtarın başarısızlığı kurumsal anahtara geçiş nedeni DEĞİLDİR:**

| Kişisel anahtarla alınan sonuç | Dönen kod | Kurumsal anahtara geçilir mi? |
| --- | --- | --- |
| HTTP 401 | `AI_KEY_INVALID` (422) | Hayır |
| HTTP 403 | `AI_UNAUTHORIZED` (403) | Hayır |
| HTTP 429 | `AI_RATE_LIMITED` (429) | Hayır |
| Süre aşımı | `AI_TIMEOUT` (504) | Hayır |
| Sağlayıcı / ağ hatası | `AI_PROVIDER_UNAVAILABLE` (502) | Hayır |
| Kayıt çözülemedi (ana anahtar değişti, satır bozuk) | `AI_KEY_INVALID` (`CREDENTIAL_UNREADABLE`) | Hayır |

Anahtar kaynaklı hatalar yanıtta `details.credentialSource` taşır; kullanıcı
hangi anahtarın reddedildiğini görür. Kurumsal anahtar reddedilirse ileti
kullanıcıyı sistem yöneticisine yönlendirir. Kaydedilen kişisel anahtar
kurumsal anahtarla **karşılaştırılmaz**: bir ret yanıtı, kurumsal anahtarın
tahmin edilip doğrulanabildiği bir kâhine dönüşürdü.

Kişisel anahtarı olmayan kullanıcı için kurumsal anahtar, ayrıca bir işlem
gerekmeden kullanılır. Kullanıcı kişisel anahtarını kaldırdığında sonraki
istekler — kurumsal anahtar tanımlıysa — kurumsal anahtarla yapılır.

Ana anahtar (`MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY`) boş bırakılarak kişisel
anahtar kullanımı **yapılandırmayla kapatıldıysa** daha önce kaydedilmiş satırlar
yok sayılır ve istekler kurumsal anahtarla yapılır; eski satır kullanıcıyı
yapay zekâdan mahrum bırakmaz. Bu kipte istekler isteğe bağlı anahtar tablosuna
hiç gitmez: tablodaki bir yetki ya da şema sorunu kurumsal anahtarla çalışan
kurulumu durduramaz (rehber üyeliği yine denetlenir). Ayarlar kartı durumu
açıkça yazar, kaydı okunamaz gösterir (eski doğrulama sonucu gösterilmez) ve
kayıt yine kaldırılabilir.

Kaldırma yalnızca **okunan** anahtarı siler (anahtar kimliği koşulu, §13): okuma
ile silme arasında başka bir oturumda yeni anahtar kaydedildiyse yeni anahtar
silinmez ve istek `CONFLICT` (409) alır; kart güncel durumu yeniden okur. Araya
giren bir doğrulama sonucu yazımı (yalnız künye) kaldırmayı engellemez.

---

## 4. Kişisel anahtarın güvenliği

### Şifreleme

- **AES-256-GCM** (kimlik doğrulamalı şifreleme), yalnızca Node'un yerleşik
  `node:crypto` modülüyle. Ek bağımlılık yoktur.
- Şifreleme anahtarı ana anahtardan **HKDF-SHA256** ile türetilir
  (tuz `mergen-rota/ai-credential/v1`, amaç `encryption`).
- Her şifrelemede yeni rastgele 96 bitlik nonce; 128 bitlik doğrulama etiketi.
- Sahibin Sicil'i **ek doğrulanmış veri (AAD)** olarak şifreye bağlanır:
  veritabanında A'nın satırı B'nin satırına kopyalansa bile çözme başarısız
  olur.
- Satır, ana anahtarın gizli olmayan kimliğini (`MasterKeyId`, HKDF amaç
  `key-id`, 16 onaltılık karakter) taşır; ana anahtar değiştiğinde "anahtar
  uyuşmazlığı" ile "bozulma" ayırt edilir.

### Saklanan ve gösterilen

Tabloda (`MR_AiUserCredentials`, §13) yalnızca şifreleme sürümü, ana anahtar
kimliği, nonce, şifreli metin, doğrulama etiketi, gösterim için **son dört
karakter**, zaman damgaları ve son doğrulama sonucu durur. Anahtarın kendisi
hiçbir biçimde saklanmaz.

Tarayıcıya dönen durum yalnızca şunları içerir: tanımlı mı, son dört karakter,
kayıt/güncelleme zamanı, son doğrulama sonucu ve okunabilirlik (okunamıyorsa
nedeni: `PERSONAL_KEYS_DISABLED`, `MASTER_KEY_CHANGED`, `RECORD_INVALID` ya da
özellik kapalıyken `AI_DISABLED`). Kayıt ancak şifreli hâli sunucuda doğrulama
etiketinden (AES-GCM) GEÇİYORSA okunabilir sayılır: bozulmuş bir kayıt eski
`VALID` sonucuyla okunabilir gösterilmez (`RECORD_INVALID`; çözülen değer
tutulmaz). Özellik yalnızca kapatıldığında okunabilirlik sınanmaz; künye ve
son doğrulama sonucu olduğu gibi gösterilir. Şifreli alanlar, nonce, ana
anahtar kimliği ve satır sürümü tarayıcıya **gitmez**.

Ham anahtar yalnızca şu yerlerde bulunur: kaydetme isteğinin gövdesinde bir kez
(HTTPS), istek süresince sunucu belleğinde ve sağlayıcıya giden
`Authorization` başlığında. SQL günlüklerinde, uygulama günlüklerinde,
telemetride, hata iletilerinde, tarayıcı deposunda (`localStorage`,
`sessionStorage`), adreslerde ve uç yanıtlarında **bulunmaz**. Sağlayıcının hata
gövdesi hiç okunmaz: gövde anahtarı ya da istek içeriğini yankılayabilir; karar
yalnızca HTTP durumuna dayanır. Sağlayıcı yönlendirmeleri izlenmez; anahtar
başka bir adrese taşınamaz.

Anahtar biçimi: 16–512 yazdırılabilir ASCII karakter, içinde boşluk ya da
görünmeyen karakter yok. Baştaki/sondaki boşluk (kopyalama artığı) kırpılır.

### Ana anahtar (`MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY`)

- Tam **32 rastgele baytın** base64/base64url yazımıdır; parola kabul edilmez.
  Üretmek için:

  ```bash
  node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
  ```

- Yalnızca sunucu ortamında (`.env.local` ya da hizmet ortamı) durur; depoya
  girmez. Güvenli biçimde yedeklenmelidir.
- **Değiştirilirse** kayıtlı kişisel anahtarlar çözülemez. Durum okuması
  satırdaki ana anahtar kimliğini sunucuda geçerli anahtarla karşılaştırır:
  Ayarlar kartı anahtarı *okunamıyor* (`MASTER_KEY_CHANGED`) olarak gösterir,
  eski doğrulama sonucunu göstermez, doğrulama ve bağlantı denemesini kapatır. İstekler
  "Kayıtlı kişisel anahtarınız okunamadı. Anahtarı yeniden kaydedin."
  iletisiyle döner; bu sırada istekler kurumsal anahtara **geçmez**. Ana
  anahtar kimliği tarayıcıya gitmez. Aşama 1'de toplu yeniden şifreleme aracı
  yoktur.
- Boşsa kişisel anahtar saklama ve kullanımı kapalıdır; yalnızca kurumsal
  anahtar kullanılabilir (kayıtlı eski satırlar yok sayılır ve
  `PERSONAL_KEYS_DISABLED` nedeniyle okunamaz gösterilir, §3). Yalnızca
  kurumsal anahtarla çalışan kurulumda boş bırakılmalıdır: yer tutucu ya da
  geçersiz değer bütün yapılandırmayı kullanılamaz kılar.

### Açık doğrulama

**Doğrula** düğmesi yalnızca **kişisel** anahtarı, model üretmeyen hafif bir
çağrıyla (`GET /models`) sınar; kurumsal anahtara hiç dokunmaz.

| Sağlayıcı yanıtı | Kaydedilen sonuç |
| --- | --- |
| 2xx, gövde boş olmayan geçerli bir model listesi **ve** aynı istek rastgele bir denetim anahtarıyla 401/403 alıyor | `VALID` |
| 401 | `REJECTED` |
| 403 | `FORBIDDEN` |
| 2xx ama denetim anahtarı da geçerli listeyi alıyor (uç yalnızca başlığın varlığına bakıyor ya da liste herkese açık) | Sonuç yazılmaz; `AI_CONFIGURATION_ERROR` (`MODELS_ENDPOINT_UNAUTHENTICATED`) |
| 2xx ama denetim anahtarına 401/403 dışı bir yanıt (408, 429, 5xx, yönlendirme, liste olmayan gövde…) | Sonuç yazılmaz (belirsiz); sınıflandırılmış hata döner |
| 2xx ama gövde model listesi değil (ör. HTML) ya da liste boş | Sonuç yazılmaz; `AI_PROVIDER_RESPONSE_INVALID` |
| 400/413/422 (sunucunun ürettiği sabit istek reddedildi) | Sonuç yazılmaz; `AI_CONFIGURATION_ERROR` (`PROVIDER_REJECTED_FIXED_REQUEST`) |
| Diğer, süre aşımı, erişilemeyen uç | Sonuç yazılmaz; hata kodu döner (429'da `Retry-After` iletilir) |

`VALID` yalnızca uç GÖNDERİLEN anahtarı gerçekten denetliyorsa verilir: denetim
isteği başlıksız değil, hiçbir hesaba ait olamayacak rastgele bir anahtarla
gider ve yalnızca kimlik doğrulamaya özgü ret (401/403) denetimin kanıtıdır.
Yanlış adrese yönelmiş bir ters vekilin 200 dönen sayfası, model listesini
herkese açan ya da boş olmayan her anahtarı kabul eden bir ağ geçidi rastgele
bir anahtarı "kabul edildi" gösteremez. Sağlayıcının reddettiği her HTTP
işlemi (kişisel anahtarın 401/403'ü ve denetim anahtarının beklenen reddi
dâhil) işlem ölçümünde başarısız sayılır; paylaşılan sağlığı yine de düşürmez.
Sağlayıcı çağrısı sohbet yolundaki dar yineleme kuralına tabidir (§7).

Sonuç yalnızca doğrulanan anahtar hâlâ kayıtlıysa yazılır (anahtar kimliği
denetimi, §13): doğrulama sürerken anahtar değiştirildiyse eski sonuç yeni
anahtara yapışmaz; yanıt `{ status: null, stale: true }` döner ve kart güncel
durumu yeniden okur. Künye yazımı anahtar kimliğini değiştirmediği için
eşzamanlı iki doğrulama birbirini bayat göstermez. Dönen künye, sonucun
yazıldığı satırdan AYNI deyimle (`OUTPUT`) gelir: yazımdan hemen sonra başka
bir oturumda kaydedilen anahtar doğrulanmış gibi gösterilemez. Sonucun yazımı
da doğrulamanın süre sınırı ve iptal kapsamındadır; süre dolduktan sonra
yazılan bir sonuç başarılı yanıt olarak bildirilmez. Yeni anahtar
kaydedildiğinde önceki doğrulama sonucu silinir.

---

## 5. Model ve yetenek kaydı

İş kodu somut modeli değil **profili** ister. Profil → model eşlemesi ve
modellerin yetenekleri **veridir**: kurum içi model dizisi değiştiğinde iş kodu
değişmez. Bugünkü model listesi kalıcı sayılmaz; tasarım en büyük modele ya da
en uzun bağlama göre yapılmamıştır. Bağlam sınırı dağıtımdaki sunum ayarına
bağlıdır ve bilinmedikçe boş bırakılır.

| Profil | Etiket | Gerekli yetenekler |
| --- | --- | --- |
| `chat.fast` | Hızlı sohbet | `chat` |
| `chat.general` | Genel sohbet | `chat` |
| `chat.reasoning` | Akıl yürütme | `chat`, `reasoning` |
| `chat.tools` | Araç kullanımı | `chat`, `tools` |
| `vision` | Görsel anlama | `chat`, `vision` |
| `embedding` | Anlamsal gösterim | `embedding` |
| `rerank` | Yeniden sıralama | `rerank` |
| `speech.stt` | Konuşmadan metne | `speech.stt` |
| `speech.tts.fast` | Metinden konuşmaya (hızlı) | `speech.tts` |
| `speech.tts.quality` | Metinden konuşmaya (yüksek kalite) | `speech.tts` |
| `image.generation` | Görsel üretimi | `image.generation` |

Aşama 1'de yalnızca `chat.fast` kullanılır (bağlantı sınaması). Öteki profiller
sonraki aşamaların sözleşmesidir; yürütme yolu yoktur.

Varsayılan eşleme `src/server/ai/defaultModelRegistry.js` dosyasındadır. Depoda
ayrıca **mevcut kurum içi sunucu kataloğunun operasyonel anlık görüntüsü**
`config/ai-model-registry.onprem.json` olarak tutulur. Üretimde bu dosyanın
dağıtılmış kopyası mutlak bir yolda tutulur ve
`MERGEN_ROTA_AI_MODEL_REGISTRY_PATH` o dosyayı gösterir. Böylece model adı,
yetenek, bağlam boyutu ya da profil tercihi değiştiğinde uygulama iş kodu
değişmez; JSON güncellenir ve Rota yeniden başlatılır.

24.09.2026 kataloğunda hız gerektiren `chat.fast`, `chat.general` ve
`chat.tools` profilleri düşünme kipine sahip olmayan
`Qwen3-Next-80B-A3B-Instruct` modeline; `chat.reasoning`
`DeepSeek-V4-Flash-0731` modeline; `vision` ise düşünme kipine sahip olmayan
`Qwen3-VL-8B-Instruct` modeline bağlıdır. Dört model sunucudan kaldırılacağı
bildirildiği için hem varsayılan kayıttan hem de operasyonel JSON'dan bilinçli
olarak çıkarılmıştır: `Qwen3-30B-A3B-Instruct-2507`,
`Qwen3-Coder-30B-A3B-Instruct`, `Qwen2.5-VL-7B-Instruct` ve
`Qwen3-VL-30B-A3B-Instruct`.

Kısaltılmış örnek:

```json
{
  "version": 1,
  "models": [
    { "id": "Qwen3-Next-80B-A3B-Instruct", "provider": "onprem", "capabilities": ["chat", "tools"], "contextTokens": 262144, "enabled": true },
    { "id": "DeepSeek-V4-Flash-0731", "provider": "onprem", "capabilities": ["chat", "tools", "reasoning"], "contextTokens": 1048576, "enabled": true },
    { "id": "Qwen3-VL-8B-Instruct", "provider": "onprem", "capabilities": ["chat", "vision"], "contextTokens": 32768, "enabled": true }
  ],
  "profiles": {
    "chat.fast": { "model": "Qwen3-Next-80B-A3B-Instruct", "maxOutputTokens": 512 },
    "chat.reasoning": { "model": "DeepSeek-V4-Flash-0731", "maxOutputTokens": 2048, "timeoutMs": 180000 },
    "vision": { "model": "Qwen3-VL-8B-Instruct", "maxOutputTokens": 1024 }
  }
}
```

Depodaki JSON bir **referans ve dağıtım kaynağıdır**; çalışma zamanı yine yalnız
`MERGEN_ROTA_AI_MODEL_REGISTRY_PATH` ile verilen mutlak yolu okur. Gerçek
sunucu kataloğu değiştiğinde önce bu dosya ve varsayılan kayıt birlikte
güncellenmelidir; böylece sonraki geliştirme oturumları hangi modellerin kurum
içinde mevcut olduğunu ve hangi profillerin seçildiğini doğrudan depodan
görebilir.

Doğrulama kuralları:

- Belge, model ve profil nesnelerinde yalnızca tanınan alanlar bulunabilir
  (belge: `version`, `models`, `profiles`; model: `id`, `provider`,
  `capabilities`, `contextTokens`, `maxConcurrency`, `enabled`; profil: `model`,
  `enabled`, `maxOutputTokens`, `timeoutMs`). `maxConcurreny` gibi bir yazım
  hatası sessizce yok sayılmaz; kayıt reddedilir, çünkü aksi hâlde güvenlik
  sınırı fark edilmeden kalkardı.
- `version` yalnızca `1`; en fazla 200 model; model kimlikleri benzersiz.
- `provider` yalnızca `onprem` (varsayılan). `capabilities` bilinen
  yeteneklerden en az biri.
- `contextTokens` boş ya da pozitif tam sayı; `maxConcurrency` boş ya da
  1–1000 (model başına eşzamanlı istek üst sınırı, §6); `enabled` boolean.
- Profil kayıttaki **etkin** bir modele bağlanmalı ve profilin gerektirdiği
  yetenekleri taşımalıdır. `maxOutputTokens` 1–131072 ve bağlıysa modelin
  `contextTokens` değerinden büyük olamaz (etkin profil için); `timeoutMs`
  1000–600000 (profilin istek süre sınırı; yoksa genel sınır).
- Aynı nesnede yinelenen alan adı reddedilir: `JSON.parse` yalnızca son değeri
  tuttuğu için bir birleştirme hatası önceki bir sınırı ya da profil eşlemesini
  sessizce değiştirebilirdi.
- Sorunlar birlikte, belge yoluyla bildirilir; değerler yansıtılmaz.

Yükleme: dosya mutlak bir yol olmalı ve `.json` ile bitmelidir (UNC ve Windows
yolları desteklenir), en fazla 256 KiB olabilir (sınır **okunan baytlara**
uygulanır; denetim ile okuma arasında büyüyen dosya da reddedilir), UTF-8 BOM
kabul edilir, **5 sn süre sınırıyla** ve tek uçuş olarak okunur, süreç başına
bir kez yüklenir (değişiklik yeniden başlatmayla geçerli olur). Süre dolduğunda
çağıran serbest kalır ama iptal edilemeyen açma/okuma sistem çağrısı gerçekten
bitene kadar yeni okuma başlatılmaz: erişilemeyen bir paylaşımda takılı
işlemler iş parçacığı havuzunda birikmez. Bozuk ya da okunamayan dosya
sessizce varsayılana DÜŞMEZ: istekler `AI_CONFIGURATION_ERROR`
(`MODEL_REGISTRY_INVALID`) alır, Sistem Yönetimi sorunları gösterir ve dosya
30 sn sonra yeniden denenir.

---

## 6. Eşzamanlılık ve geri basınç

Kapasite denetimi (`admissionController.js`) dört sınırı birlikte uygular:

| Sınır | Ortam değişkeni | Varsayılan | Aralık |
| --- | --- | --- | --- |
| Küresel etkin istek | `MERGEN_ROTA_AI_MAX_ACTIVE_REQUESTS` | 8 | 1–256 |
| Küresel sıra | `MERGEN_ROTA_AI_MAX_QUEUED_REQUESTS` | 32 | 0–1024 |
| Kullanıcı başına etkin | `MERGEN_ROTA_AI_MAX_ACTIVE_PER_USER` | 2 | 1–32 |
| Kullanıcı başına sıra | `MERGEN_ROTA_AI_MAX_QUEUED_PER_USER` | 2 | 0–64 |
| Sırada bekleme süresi | `MERGEN_ROTA_AI_QUEUE_TIMEOUT_MS` | 20000 | 100–120000 |

Model başına üst sınır isteğe bağlıdır ve model kaydındaki `maxConcurrency`
alanıyla verilir. Kullanıcı sınırları küresel sınırı aşamaz.

Davranış:

- Kapasite varsa istek hemen başlar. Yoksa **sınırlı** FIFO sıraya girer.
- Kullanıcının sırası ya da küresel sıra doluysa istek bekletilmez:
  `AI_BUSY` (503, `Retry-After: 2`) hemen döner.
- Sırada süre dolarsa `AI_QUEUE_TIMEOUT` (503, `Retry-After: 2`).
- Kendi sınırına takılmış bir kullanıcının ya da modelin bekleyeni, arkasındaki
  uygun bekleyenleri engellemez; her serbest bırakma sırayı yeniden tarar.
- İstemci bağlantıyı keserse sıradaki istek sıradan çıkar.
- Kapasite kirası başarı, hata, süre aşımı ve iptal dâhil **her yolda** bir kez
  bırakılır.
- Kişisel anahtar doğrulaması aynı kullanıcı ve küresel sınırlara tabidir ama
  model sayacına **girmez**: kayıttaki hiçbir model kimliği (ör. adı
  `provider:models` olan sınırlı bir model) doğrulama işiyle aynı sayacı
  paylaşamaz.
- Reddedilen ya da sırada süresi dolan istek neyin dolduğunu `details.saturation`
  ile bildirir: `global`, `model` ya da `directory` (kira öncesi rehber
  denetiminin sırası, §1) paylaşılan kapasitedir, `user` yalnızca o
  kullanıcının kendi etkin sınırıdır. Sistem Yönetimi yalnızca paylaşılan
  kapasitenin dolmasını uyarı sayar; kullanıcının kendi sınırı hizmet hatası
  olarak da sayılmaz (§9). Kişisel anahtar doğrulamasının kapasite reddi ve
  sıra beklemesi sohbet isteğiyle aynı biçimde izlenir.

Sınırlar **süreç başınadır**; birden çok uygulama örneğinde toplam kapasite örnek
sayısıyla çarpılır. Sınırı değiştirmek yeniden başlatma gerektirir: süren
isteklerin kiraları unutulup kapasite aşılamaz.

---

## 7. Süre sınırları, iptal ve yeniden deneme

- Her sağlayıcı çağrısı tek bir `AbortSignal` ile yürür; sinyal hem süre
  dolmasını hem istemcinin iptalini taşır ve hangisinin **önce** olduğu korunur
  (`AI_TIMEOUT` ile `AI_CANCELLED` ayrı kodlardır).
- İstek süre sınırı `MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS` (varsayılan 90000,
  1000–600000) ya da profilin `timeoutMs` değeridir. Sıra beklemesi bu süreye
  dâhil değildir; kendi sınırı vardır (§6).
- İstemci bağlantıyı keserse (`request.signal`) sağlayıcıya giden istek de
  kesilir, kapasite hemen bırakılır ve yanıt `AI_CANCELLED` (499) olur.
- Süre dolduktan ya da iptalden sonra gelen yanıt **uygulanmaz**.
- Zamanlayıcılar ve dinleyiciler her yolda temizlenir.
- Tarayıcıdaki süre sınırı sunucunun GERÇEK bütçesinden uzundur: sonucu her
  zaman sunucu belirler. Bütçeler sunucudan gelir ve kira öncesi rehber
  denetimini (5 sn) de kapsar: bağlantı sınaması için rehber denetimi + dosya
  kaydının okunması + sıra + `chat.fast` profilinin (yoksa genel) süre sınırı
  (`probe.budgetMs`); doğrulama için rehber denetimi + sıra + doğrulama süresi
  (`timeouts.validationBudgetMs`).
- Anahtar durumunu okuma, kaydetme ve kaldırma sunucuda tek bir 15 sn süre
  sınırı altında çalışır (SQL, gövde okuması ve model kaydı dâhil) ve
  istemcinin iptalini izler; tarayıcı 20 sn bekler. Gövdeyi yavaşça gönderen
  istemci okumayı süre sınırının ötesinde tutamaz. İptal ve süre dolması
  yalnızca kalıcı değişikliğin başlangıcına (commit ya da silme deyimi) kadar
  etkilidir: ondan önce vazgeçilen kayıt geri alınır (bırakılmış bir istek
  sonradan gelen yeniden denemeyi ezemez), ondan sonra ise değişikliğin GERÇEK
  sonucu beklenir ve bildirilir; uygulanmış bir kayıt hata olarak bildirilmez.
  Değişiklikten sonra G/Ç yapılmaz (sınama bilgisi önceden hazırlanır). Silme,
  silmeden sonraki güncel satırı aynı gidiş-dönüşte okur: araya giren yeni
  anahtar `CONFLICT` olarak bildirilir, "anahtar yok" yanıtıyla gizlenmez.
  Sonuç belirsiz kalırsa (tarayıcı süre aşımı, ağ kesintisi, beklenen biçimi
  taşımayan 2xx yanıtı ya da sunucunun `CREDENTIAL_OPERATION_TIMEOUT` süre
  aşımı) kayıt/kaldırma sonucu tahmin edilmez; güncel durum yeniden okunur ve
  belirsizlik gerçek nedeniyle söylenir. O okuma da başarısızsa kart durumu
  çözülmemiş (yeniden denenebilir hata) gösterir.
- Uç, gövde gönderilirken bağlantısı kesilen isteği iç hata değil
  `AI_REQUEST_INVALID` (`BODY_INTERRUPTED`) olarak bildirir.
- Sağlayıcının belirteçleyicisi bilinmediği için istem uzunluğu **tahmin
  edilmez** ve kabul/ret ya da bağlam ayırma kararı tahminle verilmez
  (karakter/belirteç oranı dile ve içeriğe göre her iki yönde de sapar).
  Bağlama sığmayan istemi sağlayıcı kendi belirteçleyicisiyle reddeder
  (`AI_REQUEST_INVALID`); iletiler sayı ve uzunlukla sınırlıdır (§10).
- Çıktı sınırı yalnızca KESİN değerlerle daraltılır: çağıranın değeri, profil
  sınırı, modelin `contextTokens` değeri ve genel üst sınır (131072). Çağıran
  da profil de sınır vermediyse 1024 kullanılır: istek hiçbir zaman sınırsız
  gitmez ve sağlayıcının (bağlamın tamamına varabilen) varsayılanı genel üst
  sınırı aşamaz.

**Yeniden deneme bilinçli olarak dardır.** Yalnızca isteğin sağlayıcıya HİÇ
ulaşmadığı bağlantı hataları (`ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`,
`EAI_AGAIN`, `ENOTFOUND`, `ENETUNREACH`, `EHOSTUNREACH`, `ENETDOWN`,
`EHOSTDOWN`, `EADDRNOTAVAIL`) bir kez, 200–600 ms titreşimli beklemeden sonra
ve kalan süre bekleme + 1 sn'yi karşılıyorsa yinelenir. Bağlantı kurulduktan
sonra da oluşabilen belirsiz hatalar (`ECONNRESET`, `ETIMEDOUT`) yinelenmez. Geçersiz anahtar, yetki, oran sınırı,
istek doğrulama hatası, süre aşımı ve iptal **yinelenmez**. Kural sohbet
tamamlamada da kişisel anahtar doğrulamasındaki `GET /models` çağrısında da
aynıdır. Yineleme, ikinci deneme gerçekten başlarken kaydedilir ve sayılır
(sohbet ve doğrulama için aynı sayaç): bekleme sırasında iptal edilen istek
yinelenmiş sayılmaz.

---

## 8. Hata sınıflandırması

Sağlayıcının ham hatası arayüze taşınmaz; her sonuç kararlı bir koda indirgenir.
Hata gövdesi var olan sözleşmeyi izler: `{ error: { code, message, details } }`.
"Hizmet hatası" sütunu sonucun hizmet sağlığını mı yoksa kullanıcı/istemci
kararını mı anlattığını söyler; `ai.request` ve `ai.credential.validate`
işlemlerinin hata oranı yalnızca hizmet hatalarını sayar. Katalog varsayılanı
kaynağa göre düzeltilir: **kişisel** anahtarın oran sınırı (`AI_RATE_LIMITED`)
ve kullanıcının kendi etkin/sıra sınırına takılan `AI_BUSY`/`AI_QUEUE_TIMEOUT`
hizmet hatası sayılmaz; reddedilen **kurumsal** anahtar (`AI_KEY_INVALID`,
`AI_UNAUTHORIZED`) ise kişisel anahtarı olmayan herkesi etkilediği için hizmet
hatasıdır. `ai.provider.*` işlemleri ise sağlayıcının reddettiği
her çağrıyı (kişisel anahtarın 401'i dâhil) başarısız sayar; paylaşılan sağlık
izi bundan ayrıdır.

| Kod | HTTP | Yinelenebilir | Hizmet hatası | Anlamı |
| --- | --- | --- | --- | --- |
| `AI_DISABLED` | 503 | Hayır | Hayır | Özellik bu kurulumda kapalı |
| `AI_KEY_MISSING` | 409 | Hayır | Hayır | Kullanılabilir anahtar yok |
| `AI_KEY_INVALID` | 422 | Hayır | Hayır | Anahtar reddedildi (401) ya da kayıt okunamadı |
| `AI_UNAUTHORIZED` | 403 | Hayır | Hayır | Anahtarın bu yeteneğe yetkisi yok (403) |
| `AI_RATE_LIMITED` | 429 | Evet | Evet | Sağlayıcının oran sınırı; `Retry-After` iletilir |
| `AI_BUSY` | 503 | Evet | Evet | Kapasite ve sıra dolu |
| `AI_QUEUE_TIMEOUT` | 503 | Evet | Evet | Sırada beklerken süre doldu |
| `AI_TIMEOUT` | 504 | Evet | Evet | Sağlayıcı süre sınırında yanıt vermedi (408/504 dâhil) |
| `AI_CANCELLED` | 499 | Hayır | Hayır | İstemci iptal etti |
| `AI_PROVIDER_UNAVAILABLE` | 502 | Evet | Evet | Uca ulaşılamadı ya da 5xx |
| `AI_PROVIDER_RESPONSE_INVALID` | 502 | Hayır | Evet | Bozuk, eksik ya da 1 MiB'ı aşan yanıt |
| `AI_REQUEST_INVALID` | 400 | Hayır | Hayır | Geçersiz istek ya da gövde |
| `AI_CONFIGURATION_ERROR` | 503 | Hayır | Evet | Yapılandırma, model kaydı, 404 ya da yönlendirme; sabit deneme isteğinin sağlayıcıca reddi (400/413/422, `PROVIDER_REJECTED_FIXED_REQUEST`) |
| `AI_INTERNAL_ERROR` | 500 | Hayır | Evet | Beklenmeyen hata |

---

## 9. Gözlemlenebilirlik ve sağlık

Alt sistem ayrı bir günlük evreni açmaz; var olan telemetri kaydedicisini,
yapılandırılmış günlüğü ve kanonik temizleyiciyi kullanır.

- **İşlem adları:** `ai.api.credential.status`, `ai.api.credential.save`,
  `ai.api.credential.delete`, `ai.api.credential.validate`, `ai.api.probe`
  (uçlar); `ai.request` (sıra dâhil uçtan uca), `ai.queue.wait`,
  `ai.provider.chat`, `ai.provider.models`, `ai.credential.validate`. Adlar
  `api.` ile başlamaz: yavaş model yanıtları olağan uç gecikmesi uyarılarını
  (API P95) kirletmez.
- **Anlık ölçümler:** etkin ve sıradaki yapay zekâ isteği (`ai.active_requests`,
  `ai.queued_requests`) telemetri turunun ritminde (dakikada bir) yazılır:
  değer, son turdan bu yana her kapasite değişimiyle (kabul, bırakma, sıraya
  girme) biriken **zaman ağırlıklı ortalamadır**. Hiçbir istek yokken sıfır
  yazılır, yapay zekâ kapalıyken yazılmaz. Yalnızca olay anlarında örneklenseydi
  boşta geçen kovalar veri boşluğu bırakır ve ortalama olay anlarına göre
  çarpılırdı; yalnızca tur anındaki değer yazılsaydı iki tur arasında başlayıp
  biten yük hiç görünmezdi. Performans sekmesinde **Yapay zekâ yükü** grafiğinde
  **süreç başına ortalama** olarak gösterilir (kapasite sınırları da süreç
  başınadır); birden çok uygulama örneği ölçüm yazdıysa örnek sayısı yalnızca
  bilgi olarak yazılır: süreçler aralığın tamamında birlikte çalışmamış
  olabileceği için "örnek sayısı × ortalama" toplam yük diye sunulmaz.
- `ai.*` işlemleri kalıcı telemetriye yazılır ve **Performans** sekmesinin işlem
  dökümüne (ortalama gecikmeye göre ilk 25 işlem) girebilir; API P95 ve hata
  oranı uyarılarına katılmaz. Aşama 1'de yapay zekâya özgü otomatik uyarı yoktur.
- **Süreç özeti:** istek/başarı sayıları, sonuç kodları, anahtar kaynağına
  (`personal`/`default`/`missing`) ve profile göre dağılım, sağlayıcı gecikmesi
  ve sıra beklemesi yüzdelikleri, yineleme sayısı, son başarı/başarısızlık.
  Anahtar çözülemeden düşen istek (`AI_KEY_MISSING`, okunamayan kişisel anahtar)
  da kaynağıyla sayılır. Sağlayıcı gecikmesi tamamlanan **her** çağrıyı
  (süre aşımına uğrayan dâhil) kapsar; sıra beklemesi sırada süresi dolan
  istekleri de kapsar (`ai.queue.wait` bu istekler için başarısızdır).
- **Sağlayıcı sağlığı:** HTTP yanıtı alınan çağrı erişim sayılır; bağlantı,
  süre aşımı, bozuk yanıt, 5xx ve sağlayıcının bulunamayan uç/model ya da
  yönlendirme yanıtı (404/3xx, sohbet yolunda da) hatadır. Kaynak bilindiğinde
  sınıf açıkça belirlenir: **kurumsal** anahtarın 401/403 reddi ve oran sınırı
  herkesi etkilediği için hatadır; **kişisel** anahtarın 401/403/429 sonucu
  yalnızca o anahtarı anlatır, paylaşılan sağlığı düşürmez. İşlem ölçümü ise
  her HTTP çağrısının GERÇEK sonucunu anlatır: sağlayıcının reddettiği çağrı
  (kişisel anahtarın ya da doğrulamanın denetim anahtarının 401/403'ü,
  kurumsal anahtar yokken bağlantı testine dönen 401 dâhil) başarısız sayılır.
  Kurumsal anahtarın son reddi ayrıca tutulur: kişisel anahtarla yapılan
  başarılı bir çağrı onu gizlemez ve ret (401/403) yaşlanarak kalkmaz;
  yalnızca kurumsal anahtarın kabul edildiği bir çağrı temizler. Metin beklenen deneme isteğine
  metinsiz (`content: null`) yanıt ve `assistant` rolünde olmayan ileti (ör.
  isteği yankılayan bir vekil) geçersiz sağlayıcı yanıtıdır. Son sonuç milisaniye
  damgalarıyla değil tekdüze bir sıra sayacıyla belirlenir; hata da başarı gibi
  yalnızca 15 dakika taze sayılır.
- **Yapılandırılmış günlük:** hizmet hataları ve kurumsal anahtarın reddi
  (401/403) `component: AI` ile yazılır; kurumsal anahtarla yapılmış olsa da
  geçersiz istek (400/413/422) yazılmaz; bağlamda profil, model kimliği, anahtar
  kaynağı (`keySource`), deneme sayısı, sağlayıcı HTTP durumu ve ağ kodu
  bulunur. Yoğunluk, sıra süresi ve iptal tek tek yazılmaz, sayaçlarda izlenir.
  Kullanıcının kendi anahtarı ya da isteği kaynaklı sonuçlar hizmet sorunu
  sayılmaz.
- **Kaydedilmeyenler:** anahtarlar, `Authorization` başlığı, istemler, model
  yanıtları, görev/kullanıcı içeriği ve Sicil.
- Her telemetri kaydı kendi hatasını yutar: telemetri ne yapay zekâ isteğini ne
  olağan Rota akışını bozabilir.

### Sistem Yönetimi

- **Genel Durum** yeni bir **Yapay zekâ hizmeti** bileşeni gösterir. Sağlık
  hesabı **hiçbir ağ ya da dosya işlemi beklemez**: yapılandırma, kapasite ve son
  sağlayıcı temasları süreç belleğinden okunur; yanıt vermeyen bir uç sayfayı
  askıda bırakamaz. Durumlar: bilinçli olarak kapalıysa *Yapılandırılmamış*;
  etkinleştirme değeri geçersizse (ör. `tru`), yapılandırma ya da model kaydı
  hatalıysa, kişisel anahtar saklama açıkken kişisel anahtar tablosu (0016)
  kurulmamışsa (kurumsal anahtar istekleri yürütebilse de: kullanıcılar anahtar
  ekleyemez), son 5 dakikada kira öncesi rehber denetiminin (SQL) sınırlı kapısı
  dolduysa (yapay zekâ kapasite sayaçlarından ayrı bildirilir), son 5 dakikada
  **paylaşılan** kapasite nedeniyle istek geri çevrildiyse ya da sırada süresi
  dolduysa, sıra %80 dolduysa ("henüz geri çevrilen istek yok"), kurumsal anahtar
  reddedildiyse ve o zamandan beri kabul edilmediyse (oran sınırı yalnızca 15
  dakika taze sayılır), son 15 dakikadaki son sağlayıcı sonucu başarısızsa
  (bayat hata uyarı olarak kalmaz), son 15 dakikada sağlayıcıya ulaşmadan düşen
  bir hizmet hatası (rehber sorgusu, anahtar tablosu, iç hata) olduysa ve ondan
  sonra başarılı istek gelmediyse ya da `chat.fast` profili çıkarılmış/kapatılmışsa
  (Aşama 1'in tek yürütme yolu çalışmaz) *Dikkat*; yapılandırılmış dosya kaydı
  henüz okunmadıysa ya da kişisel anahtar saklama açıkken tablo son 15 dakikada
  doğrulanmadıysa (eski bir olumlu gözlem kanıt sayılmaz) *Bilinmiyor*; son 15
  dakikada başarılı temas varsa *Sağlıklı*; aksi hâlde *Bilinmiyor*. Tek
  kullanıcının kendi sınırına takılması uyarı değildir; telemetride ayrıca
  izlenir. Yapay zekâ isteğe bağlı bir yetenek olduğundan hiçbir zaman *Kritik*
  bildirilmez ve boştayken *Bilinmiyor* durumu genel başlığı düşürmez (bileşen
  listede görünür kalır; uyarısı genel duruma yansır).
  Ayrıntı çekmecesi etkin/sıradaki istekleri, sınırları, geri çevrilen ve süresi
  dolan istekleri, sağlayıcı P95 gecikmesini ve anahtar kaynağı dağılımını
  gösterir. Bileşenin "son başarılı işlem" anı uçtan uca başarılı yapay zekâ
  isteğinin anıdır; sağlayıcıya erişim anı (reddedilen çağrı dâhil) ayrıntıda
  ayrıca durur.
- **Entegrasyonlar** yeni bir **Yapay zekâ sağlayıcısı** kartı gösterir.
  **Bağlantıyı Test Et** yıkıcı değildir: model üretmeyen `GET /models`
  çağrısıdır; kurumsal anahtar tanımlıysa o kullanılır, hata yanıtının HTTP
  durumu dışında hiçbir şeyi okunmaz ve 2xx gövdesinin boş olmayan bir model
  listesi olduğu doğrulanır. Testin **tamamı** (sağlayıcı çağrıları, kayıt
  okuması, şema denetimi) tek bir 6 sn süre sınırı altındadır ve bildirilen
  süre kurulum doğrulamasını da kapsar. Yönetici sayfadan ayrılırsa test iptal
  edilir; iptal sonuç olarak yazılmaz ve süreç içi kilit hemen bırakılır. İstek
  yalnızca aynı kaynaktan kabul edilir (§2).
  Test PAYLAŞILAN yolu sınadığından reddedilen kurumsal anahtar, 404/3xx ya da
  geçersiz istek sağlık hatası olarak kaydedilir; kart önceki başarıya rağmen
  *Dikkat* gösterir. Kurumsal anahtarla alınan liste, ancak uç rastgele bir
  denetim anahtarını 401/403 ile reddediyorsa anahtarın kanıtıdır; denetim
  anahtarı da listeyi alıyorsa ya da denetim isteğine başka bir yanıt dönüyorsa
  test `DEFAULT_KEY_UNVERIFIED` ile başarısız olur ve sağlıklı temas yazılmaz.
  Denetim isteği kendi gecikmesi ve HTTP sonucuyla ayrıca ölçülür. Kurumsal
  anahtar tanımlı değilse anahtarsız isteğe dönen 401 ucun erişilebilir olduğunu
  gösterir (`AUTHENTICATION_REQUIRED`); 403 ise bir erişim ya da ağ politikası
  reddi olabileceği için başarı sayılmaz (`ACCESS_FORBIDDEN`). Kurumsal anahtar
  kabul edilip `chat.fast` modeli uçta bulunmazsa anahtarın eski reddi temizlenir
  ve sağlık izi asıl sorunu (yapılandırma) gösterir. Son bağlantı testi, ondan
  sonra başarılı bir test olmadan başarısız olduysa kart 15 dakika boyunca
  sağlıklı ya da bilinmiyor görünmez; kartın gecikme alanı son testin süresidir.
  Uca
  ulaşıldıktan sonra kalan yapılandırma sorunları (`CONFIGURATION_INVALID`),
  model kaydı, `chat.fast` profilinin kullanılabilirliği
  (`PROBE_PROFILE_UNAVAILABLE`), profilin modelinin uçtaki listede bulunması
  (`PROBE_MODEL_MISSING`, sağlık hatasıdır) ve kişisel anahtar saklama açıksa
  anahtar tablosunun kurulu olduğu doğrulanır. Tanımlı ama biçimi geçersiz
  kurumsal anahtar "anahtar yok" sayılıp anahtarsız sınanmaz; test
  `DEFAULT_KEY_INVALID` ile başarısız olur. Sağlayıcı beklenirken yönetim
  eyleminin SQL kilidi ve işlemi **tutulmaz** (süreç içi tekillik yeterlidir).
- Yanıtlar adres, yol ya da anahtar taşımaz; yapılandırma yalnızca
  "Yapılandırılmış / Yapılandırılmamış" ve eksik ayarların **adlarıyla**
  bildirilir.

---

## 10. Uçlar

Hepsi Node çalışma zamanında, önbelleksiz çalışır (oturum, yetki ve veritabanı
hataları dâhil her yanıt `Cache-Control: no-store` taşır) ve kimliği yalnızca
güvenilir oturumdan alır. Durum değiştiren istekler yalnızca aynı kaynaktan
kabul edilir (§2).

| Uç | Yöntem | İşlev |
| --- | --- | --- |
| `/api/mergen-rota/ai/credential` | `GET` | Kullanıcının yapay zekâ erişim durumu |
| `/api/mergen-rota/ai/credential` | `PUT` | Kişisel anahtarı kaydeder/değiştirir (`{ "apiKey": "…" }`, en fazla 8 KiB) |
| `/api/mergen-rota/ai/credential` | `DELETE` | Kişisel anahtarı kaldırır |
| `/api/mergen-rota/ai/credential/validation` | `POST` | Kişisel anahtarın açık doğrulaması |
| `/api/mergen-rota/ai/probe` | `POST` | Aşama 1 bağlantı sınaması |

**Bağlantı sınaması** alt sistemin bütün zincirini (güvenilir Sicil → kimlik
bilgisi → profil → kapasite → süre sınırı → sağlayıcı → telemetri) tek, küçük
bir istekle kanıtlar. İstem **sabittir**, kullanıcı içeriği modele gönderilmez;
uç bir sohbet ucuna dönüşemez. `chat.fast` profili ve en fazla 64 çıktı
belirteci kullanılır; yanıtta kısaltılmış metin, profil, yanıtı **gerçekten
üreten** model (`model`: yalnızca sağlayıcının yanıtta bildirdiği model;
bildirmediyse `null` kalır, yapılandırılan model onun yerine yazılmaz),
yapılandırılan model (`configuredModel`, her zaman), anahtar kaynağı, süre ve
sıra beklemesi döner. Ayarlar kartı yanıtlayan model bilinmiyorsa "Sağlayıcı
bildirmedi" yazar; bilinmiyorsa ya da yapılandırılandan farklıysa
yapılandırılan modeli ayrıca gösterir. Metinsiz yanıt geçersiz sağlayıcı
yanıtıdır.

Durum yanıtı (`GET /credential`) sınamanın kullanılabilirliğini ve sunucu
bütçesini de taşır (`probe: { available, reason, timeoutMs, budgetMs }`):
`chat.fast` yapılandırılmamış, kapalı ya da sohbet yeteneği taşımıyorsa veya
kayıt okunamıyorsa deneme düğmesi kapalıdır ve neden yazılır. Sağlık görünümü
ve bağlantı testi aynı kuralı kullanır. Sabit istemin modelin bağlamına sığıp
sığmadığı tahmin edilmez (belirteç sayısı modelin belirteçleyicisine ve sohbet
şablonuna bağlıdır): çıktı sınırı bağlam penceresine göre daraltılır, sığmayan
sabit istemi sağlayıcı reddeder ve bu ret yapılandırma hatası olarak bildirilir.

---

## 11. Ayarlar ekranı

**Ayarlar → Yapay zekâ erişimi** kartı:

- Başlıktaki çip hangi anahtarın kullanılacağını söyler: *Kişisel anahtar*,
  *Kurumsal anahtar*, *Anahtar gerekli*, *Yapılandırılmadı* ya da *Kapalı*.
- Kayıtlı anahtar yalnızca `••••` + son dört karakterle, kayıt tarihiyle ve son
  doğrulama sonucuyla gösterilir. **Doğrula**, **Değiştir** ve **Kaldır**
  eylemleri vardır; kaldırma satır içi onay ister ve sonucunu (kurumsal anahtara
  dönüş ya da yapay zekânın kullanılamaması) açıkça yazar. İsteklerin kurumsal
  anahtarla çalışacağı yalnızca yapılandırma kullanılabilir, kurumsal anahtar
  tanımlı ve model kaydı/sınama profili kullanılabilirse vaat edilir; kayıt
  kullanılamıyorsa yalnızca kurumsal anahtarın seçileceği ve yapılandırmanın
  şu anda kullanılamadığı yazılır. Düzenleme sürerken kaldırma sunulmaz; yeni anahtar kaydedilince
  açık kalan kaldırma onayı kapanır (eski onay yeni anahtarı silemez).
- Kayıtlı anahtar okunamıyorsa (ana anahtar değişti) ya da kişisel anahtar
  kullanımı yapılandırmayla kapatıldıysa bu durum nedeniyle birlikte açıkça
  yazılır; doğrulama sunulmaz. Saklama yapılandırılmış ama tablo (0016)
  kurulmamışsa bu, bilinçli kapatma gibi değil eksik veritabanı göçü olarak
  anlatılır (`personalKeysConfigured` + `schemaReady: false`). Özellik kapalıyken kaldırma onayı anahtar
  eklemeyi bir çıkış yolu olarak göstermez.
- **Doğrula** yalnızca KAYITLI anahtarı sınar; yeni anahtar taslağı yazılırken
  sunulmaz. Güncel anahtarın yeni doğrulama sonucu, önceki (tamamlanmış) deneme
  sonucunun yerini alır.
- Satır içi denetimler (anahtar formu, kaldırma onayı) kapanınca ya da işlem
  bitince odak onları açan düğmeye (yoksa karta) döner.
- Kaldırma başka oturumda değiştirilen anahtar nedeniyle çakışırsa (`CONFLICT`)
  güncel durum okunur ve önceki anahtarın deneme sonucu kaldırılır.
- Anahtar alanı parola türündedir; otomatik doldurma kapatılır ve parola
  yöneticilerine alanı yok sayma işareti verilir. Taslak yalnızca bileşen
  belleğinde durur; kayıttan sonra silinir ve anahtar bir daha gösterilmez.
  Biçim hatası istek atılmadan gösterilir. Kayıt sürerken **Esc** formu
  kapatmaz; hata aynı formda, yazılan anahtar korunarak gösterilir.
- **Bağlantı denemesi** geçen süreyi sayar ve **İptal** ile kesilebilir;
  sonuç anahtar kaynağını, profili, yanıtı üreten modeli (yapılandırılandan
  farklıysa ikisini de) ve süreyi gösterir. Yerine yenisi başlatılan ya da
  iptal edilen denemenin geç gelen sonucu uygulanmaz; anahtar kaydedilince ya
  da kaldırılınca süren deneme de kesilir ve sonucu uygulanmaz; kart kapanınca
  süren deneme iptal edilir. `chat.fast` profili çözülemiyorsa deneme kapalıdır
  ve neden yazılır. Ekran okuyucu yalnızca sabit "Yanıt bekleniyor" metnini
  duyurur; her saniye değişen sayaç canlı bölgenin dışındadır.
- Hata iletilerinde istemci tarafı sonuçlar (süre aşımı, iptal, ağ) kendi
  Türkçe karşılığıyla, sunucunun özgül iletisi olduğu gibi, gövdesiz hata ise
  katalogdaki karşılığıyla gösterilir. Beklenen biçimi taşımayan 2xx yanıtı
  (ör. bir vekilin 200 dönen HTML sayfası) başarı sayılmaz: kart çökmez,
  yeniden denenebilir bir hata gösterir. Eylemleri yöneten alanlar (etkin
  kaynak, deneme durumu, anahtar künyesi, doğrulama sonucu, deneme sonucunun
  kaynağı/modeli/süresi/metni) eksik ya da tanınmayan değerdeyse yanıt reddedilir
  ve ilgili eylem kapalı kalır.
- Durum metinleri (başarı, hata, uyarı) açık ve koyu temada, yüksek karşıtlık
  dâhil, en az 4.5:1 karşıtlık veren kendi belirteçlerini kullanır.
- **Demo Kipinde** hiçbir istek atılmaz ve anahtar kaydedilmez. Kart açıkken
  Demo Kipine geçilirse kart sıfırlanır; süren durum okumaları, kayıt,
  kaldırma, doğrulama ve deneme istekleri kesilir (sunucu commit'ten önce iptal
  edilen kaydı geri alır) ve önceki kipte başlamış isteklerin geç gelen
  sonuçları uygulanmaz. Kart kapanınca (sayfadan ayrılma) da aynı istekler
  kesilir: terk edilmiş bir sayfanın kaydı sonradan uygulanmaz.
- Sonucu bilinmeyen kayıt/kaldırmadan sonra güncel durum okunur; bu okuma
  bitene kadar eylemler kapalı kalır ve okuma yalnızca kendisinden sonra yeni
  bir işlem başlamadıysa uygulanır. Doğrulama sırasında değişen anahtar ya da
  kaldırma çakışması durumu kartı yükleme ekranına düşürmeden yeniler;
  bildirim görünür kalır.

---

## 12. Yapılandırma

Bütün değişkenler **yalnızca sunucu tarafıdır**; hiçbiri `NEXT_PUBLIC_` ön eki
taşımaz. Geçersiz değer sessizce varsayılana çevrilmez: sorunlu ayarın adı
bildirilir ve yapay zekâ kullanılamaz sayılır (kapalı kalacak biçimde başarısız
olur). Değerler hiçbir tanı çıktısına taşınmaz.

| Değişken | Varsayılan | Anlamı |
| --- | --- | --- |
| `MERGEN_ROTA_AI_ENABLED` | `false` | Özelliği açar. Geçersiz değer (ör. `tru`) kapalı sayılır ama bilinçli kapatmadan ayrılır: Sistem Yönetimi yapılandırma hatası gösterir, istekler `AI_CONFIGURATION_ERROR` alır |
| `MERGEN_ROTA_AI_BASE_URL` | — | OpenAI uyumlu ağ geçidinin taban adresi (genellikle `/v1` ile biter). HTTPS zorunlu; düz HTTP yalnız geri döngü adresinde ya da açık onayla. Adreste kullanıcı bilgisi, sorgu ya da parça bulunamaz |
| `MERGEN_ROTA_AI_ALLOW_INSECURE_HTTP` | `false` | Düz HTTP'ye açık onay; üretimde kapalı kalmalıdır |
| `MERGEN_ROTA_AI_DEFAULT_API_KEY` | boş | Kurumsal anahtar; yalnızca kişisel anahtarı olmayanlar için. Kişisel anahtarla aynı biçim kuralından geçer; yalnızca bütünüyle `<…>` yer tutucu olan değer reddedilir |
| `MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY` | boş | Kişisel anahtarları şifreleyen 32 baytlık ana anahtar (§4); yalnızca kurumsal anahtarla çalışan kurulumda boş kalır |
| `MERGEN_ROTA_AI_MODEL_REGISTRY_PATH` | boş | İsteğe bağlı model kaydı JSON dosyası (§5) |
| `MERGEN_ROTA_AI_MAX_ACTIVE_REQUESTS` … `_QUEUE_TIMEOUT_MS` | bkz. §6 | Kapasite sınırları |
| `MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS` | `90000` | Sağlayıcı yanıtı süre sınırı (§7) |

Özellik açıkken en az bir anahtar kaynağı (kurumsal anahtar ya da ana anahtar)
tanımlı olmalıdır. Kurumsal kök sertifika gerekiyorsa Node'a
`NODE_EXTRA_CA_CERTS` ile tanıtılır. Gerçek değerler yalnızca git tarafından yok
sayılan `.env.local` dosyasında ya da hizmet ortamında bulunur.

---

## 13. Veritabanı: 0016

`database/MR_Upgrade_0016_Ai_User_Credentials.sql` tek bir tablo ekler:

| Sütun | Tür | Not |
| --- | --- | --- |
| `Sicil` | `int` | PK — Sicil başına en fazla bir kişisel anahtar |
| `EncryptionVersion` | `tinyint` | Şimdilik yalnızca `1` |
| `MasterKeyId` | `char(16)` | Ana anahtarın gizli olmayan kimliği |
| `Nonce` | `varbinary(12)` | 12 bayt; her kayıtta yenilenir ve **anahtar kimliğidir** (koşullu silme ve doğrulama yazımı) |
| `Ciphertext` | `varbinary(1024)` | 16–1024 bayt |
| `AuthTag` | `varbinary(16)` | 16 bayt |
| `KeyHint` | `varchar(4)` | Gösterim için son dört karakter |
| `CreatedAt`, `UpdatedAt` | `datetime2(7)` | UTC |
| `LastValidatedAt`, `LastValidationStatus` | `datetime2(7)`, `varchar(20)` | `VALID` / `REJECTED` / `FORBIDDEN` |
| `RowVersion` | `rowversion` | Satır sürümü; künye yazımıyla da ilerlediği için anahtar kimliği olarak kullanılmaz |

Konuşma geçmişi, istem ya da yanıt **saklanmaz**. Betik yinelenebilirdir,
veriye dokunmaz, `0015_assignment_coordination_and_presence` kaydı yoksa hata
verir ve `0016_ai_user_credentials` kaydını yazar. Tablo önceden (ör. elle)
oluşturulmuşsa sütunları (tür, uzunluk, boş olabilirlik; `IDENTITY` ya da
hesaplanan sütun olmamalı), uygulamanın dolduramayacağı fazladan zorunlu sütun
bulunmadığı, yalnızca `Sicil` üzerindeki ETKİN birincil anahtarı, beş doğrulama
kısıtının ve tarih varsayılanlarının yalnızca adları değil TANIMLARI (aynı
ifadelerle kurulan geçici bir tablonun sunucu normalleştirmesiyle
karşılaştırılarak) doğrulanır; uyumsuz tablo göç olarak işaretlenmez, betik
açıklayıcı bir hatayla durur. Uygulamanın şema denetimi (Sistem Yönetimi,
bağlantı testi) de yalnızca adı değil göç kaydını ve kullandığı sütunların
yapısını denetler: yarım ya da elle kurulmuş bir tablo "hazır" görünmez. Yeni kurulum aynı tabloyu
`MR_Create_Durable_Persistence.sql` ile kurar; geri alma betiği tabloyu düşürür.

**Göç uygulanmadan** açılan kurulumda uygulama çalışmaya devam eder: Ayarlar
kartı kişisel anahtar saklamanın kullanılamadığını söyler, kişisel anahtar
kaydı açıkça reddedilir (`SCHEMA_MISSING`) ve kurumsal anahtar çalışır.

### Dağıtım sırası

1. Veritabanının yedeğini alın.
2. `0015` uygulanmış bir veritabanında
   `database/MR_Upgrade_0016_Ai_User_Credentials.sql` betiğini çalıştırın.
3. Ana anahtarı üretin ve güvenli biçimde yedekleyin (§4).
4. `config/ai-model-registry.onprem.json` dosyasını sunucuda kalıcı bir mutlak
   yola kopyalayın ve `MERGEN_ROTA_AI_MODEL_REGISTRY_PATH` değerini bu yola
   verin. Sunucu kataloğu değiştiğinde depodaki referans JSON'u da güncelleyin.
5. `.env.local` ya da hizmet ortamında §12'deki diğer değişkenleri ayarlayın;
   `MERGEN_ROTA_AI_ENABLED=true` en son açılır.
6. Uygulamayı yeniden başlatın (`npm run build` ve olağan başlatma).
7. **Sistem Yönetimi → Entegrasyonlar → Yapay zekâ sağlayıcısı → Bağlantıyı
   Test Et** ile uca ulaşıldığını doğrulayın.
8. §15'teki elle kabul listesini uygulayın.

Özelliği kapatmak için `MERGEN_ROTA_AI_ENABLED=false` yeterlidir; tablo ve
kayıtlı anahtarlar korunur.

---

## 14. Kalıcı kural: yapay zekâ ve veritabanı

Yapay zekâ sağlayıcısı **hiçbir zaman** SQL Server kimlik bilgisi almaz ve
serbest SQL çalıştırmaz. "SQL çalıştır" ya da "yapay zekânın ürettiği sorguyu
çalıştır" türünden genel bir yetenek yoktur ve eklenmeyecektir. Sonraki
aşamalardaki alan araçları, var olan yetki denetimli sunucu hizmetleri ve
depolar üzerinden çalışacaktır. Kişisel anahtar tablosuna yalnızca depo modülü,
derleme anında sabit ve Sicil ile sınırlı sorgularla erişir.

---

## 15. Aşama 1 elle kabul listesi

Otomatik sınamalar gerçek bir modele bağlı değildir. Elle kabul için gerçek kurum
içi uç ya da depodaki yerel sahte ağ geçidi kullanılabilir:

```bash
# Normal yanıt veren sahte uç (düz HTTP yalnız geri döngü adresinde kabul edilir).
# Anahtarsız isteği reddeder, boş olmayan her anahtarı kabul eder: sohbet ve
# bağlantı sınaması bu uçla sınanabilir; anahtarı yalnızca başlığın varlığına
# bakarak kabul ettiği için doğrulama MODELS_ENDPOINT_UNAUTHENTICATED döner.
node test/helpers/fakeOpenAiCompatibleServer.mjs --serve --port 8099
# 20 sn geciken sahte uç (yavaş/takılı yapay zekâ senaryoları için)
node test/helpers/fakeOpenAiCompatibleServer.mjs --serve --port 8099 --delay-ms 20000
# Yalnızca belirtilen anahtarları kabul eden sahte uç: kişisel anahtar
# doğrulaması (VALID) ve geçersiz anahtar senaryosu için
node test/helpers/fakeOpenAiCompatibleServer.mjs --serve --port 8099 --valid-key <KURUMSAL_TEST_ANAHTARI> --valid-key <KISISEL_TEST_ANAHTARI>
# Model listesini herkese açan uç (doğrulamanın MODELS_ENDPOINT_UNAUTHENTICATED ve
# bağlantı testinin DEFAULT_KEY_UNVERIFIED senaryosu için)
node test/helpers/fakeOpenAiCompatibleServer.mjs --serve --port 8099 --public-models
```

Ardından `MERGEN_ROTA_AI_BASE_URL=http://127.0.0.1:8099/v1` kullanılır. Kapasite
senaryosu için sınırları küçültün (ör. `MERGEN_ROTA_AI_MAX_ACTIVE_REQUESTS=1`,
`MERGEN_ROTA_AI_MAX_QUEUED_REQUESTS=0`, `MERGEN_ROTA_AI_MAX_ACTIVE_PER_USER=1`,
`MERGEN_ROTA_AI_MAX_QUEUED_PER_USER=0`) ve uygulamayı yeniden başlatın.

1. **Gerçek Sistem** kipinde **Ayarlar → Yapay zekâ erişimi** kartını açın.
2. Kişisel anahtarın **tanımlı olmadığını** ve çipin kurumsal anahtar tanımlıysa
   *Kurumsal anahtar*, değilse *Anahtar gerekli* gösterdiğini görün.
3. **Anahtar ekle** ile kişisel anahtarı kaydedin.
4. Anahtarın bir daha gösterilmediğini, yalnızca `••••` + son dört karakterin
   göründüğünü doğrulayın; sayfayı yenileyip yeniden bakın.
5. **Doğrula** ile anahtarı sınayın; sonuç kalıcı olarak kartta görünür
   (sahte uçta `VALID` için anahtarı `--valid-key` ile tanıtın; boş olmayan her
   anahtarı kabul eden uç doğrulamada `MODELS_ENDPOINT_UNAUTHENTICATED` döner).
6. **Deneme isteği gönder** ile sınama yapın; sonuçta *Anahtar: Kişisel anahtar*
   yazdığını doğrulayın.
7. **Kaldır → Anahtarı kaldır** ile kişisel anahtarı silin.
8. Yeniden deneme isteği gönderin; kurumsal anahtar tanımlıysa sonuç
   *Kurumsal anahtar* yazar, değilse deneme düğmesi kapalıdır.
9. Uç tarafından reddedilecek bir kişisel anahtar kaydedin (sahte uçta
   `--valid-key` ile yalnızca kurumsal test anahtarını kabul ettirin). Deneme
   isteğinin *API anahtarı yapay zekâ hizmeti tarafından reddedildi* iletisiyle
   başarısız olduğunu ve kurumsal anahtara **geçilmediğini** doğrulayın:
   **Sistem Yönetimi → Genel Durum → Yapay zekâ hizmeti** ayrıntısında yalnızca
   *Kişisel* sayacı artar, *Kurumsal* sayacı değişmez.
10. Başka bir Sicil ile oturum açın: kartın o kullanıcının kendi durumunu
    gösterdiğini, ilk kullanıcının anahtarını ya da ipucunu göstermediğini
    doğrulayın.
11. Gerçek kurum içi metin modeline karşı bir deneme isteği gönderin; profil
    *Hızlı sohbet* ve yanıt metni görünür.
12. Geciken sahte uçla bir deneme başlatın ve **İptal**'e basın: *İstek iptal
    edildi.* görünür ve Yapay zekâ hizmeti ayrıntısındaki etkin istek sayısı
    hemen düşer.
13. İki ya da daha fazla sekmeden/kullanıcıdan aynı anda deneme isteği gönderin;
    istekler kullanıcı başına sınırlar içinde birbirini beklemeden yürür.
14. Küçültülmüş sınırlarla kapasiteyi aşın: fazla istekler bekletilmeden *Yapay
    zekâ hizmeti şu anda yoğun* iletisiyle döner.
15. **Sistem Yönetimi → Genel Durum → Yapay zekâ hizmeti** ayrıntısında geri
    çevrilen istekleri, sırada süresi dolanları, sonuç kodlarını (ör.
    `AI_TIMEOUT`) ve anahtar kaynaklarını görün; sunucu günlüğünde hizmet
    hataları `component: AI` satırlarıyla yer alır. Hiçbir yerde anahtar yoktur.
16. Geciken sahte uçla bir deneme sürerken görevleri görüntüleyin, düzenleyip
    kaydedin, sayfalar arasında gezinin ve verileri yenileyin.
17. Bu işlemlerin deneme isteğini beklemeden, olağan hızda tamamlandığını
    doğrulayın.
18. Uygulama günlüklerinde, Sistem Yönetimi yanıtlarında, tarayıcının ağ
    yanıtlarında ve tarayıcı deposunda (`localStorage`, `sessionStorage`)
    anahtarın geçmediğini doğrulayın.

### Otomatik sınamalar

| Dosya | Kapsam |
| --- | --- |
| `test/ai-credential-security.test.mjs` | Şifreleme, Sicil yalıtımı, kurumsal anahtara geçişin olmaması, sızıntı denetimleri |
| `test/ai-model-registry.test.mjs` | Kayıt doğrulama, profil çözümü, dosyadan yükleme |
| `test/ai-concurrency-and-cancellation.test.mjs` | Kapasite, sıra, süre sınırı, iptal, yeniden deneme |
| `test/ai-provider-adapter.test.mjs` | Gerçek soketlerle bağdaştırıcı ve uçtan uca akış |
| `test/ai-runtime-isolation.test.mjs` | Takılı yapay zekâ isteği sürerken anlık görüntü ve görev kaydı; telemetri ve sağlık |
| `test/ai-settings-ui.test.mjs` | Ayarlar kartı |
| `test/ai-architecture-contract.test.mjs` | Katman sınırları, SQL yüzeyi, 0016 göçü, ortam örneği |

Belirlenimci sahte sağlayıcı `test/helpers/fakeAiProvider.mjs`, gerçek soketli
sahte ağ geçidi `test/helpers/fakeOpenAiCompatibleServer.mjs` dosyasındadır.

---

## 16. Aşama 1 kapsamı dışında kalanlar

Bilinçli olarak **yapılmayanlar**:

- sohbet arayüzü, konuşma geçmişi ve istem/yanıt saklama (Aşama 2);
- alan araçları, görev/proje verisine erişen yapay zekâ eylemleri (Aşama 3);
- kritik yol (CPM) yorumlama ve planlama önerileri;
- ses (konuşmadan metne, metinden konuşmaya), görsel anlama ve görsel üretimi;
- RAG, anlamsal gösterim ve yeniden sıralama yürütmesi;
- akış (streaming) yanıtlar;
- ana anahtar için toplu yeniden şifreleme aracı;
- birden çok uygulama örneği arasında paylaşılan kapasite.

---

## 17. İşletim notları

- **Ad çözümlemesi:** Node yeni bağlantılar için ad çözümlemesini libuv iş
  parçacığı havuzunda yapar; SQL sürücüsü de aynı havuzu kullanır (varsayılan
  dört iş parçacığı). Bağlantılar kaynağa göre yeniden kullanıldığından ad
  çözümlemesi seyrektir. Ad çözümlemesinin yavaşlayabileceği ortamlarda
  yapay zekâ ucunun adı güvenilir biçimde çözülmeli ve gerekirse hizmet
  ortamında `UV_THREADPOOL_SIZE` artırılmalıdır.
- **Birden çok örnek:** kapasite sınırları ve sağlık özeti süreç başınadır.
- **Ana anahtar yedeği:** kaybedilirse kişisel anahtarlar kurtarılamaz;
  kullanıcılar anahtarlarını yeniden kaydeder.
