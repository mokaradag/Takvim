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
          aiGateway  ── güvenilir Sicil → yapılandırma → profil → kapasite kirası
               │                     → kimlik bilgisi → sağlayıcı
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
  aktarmaz; alt sisteme yalnızca Ayarlar kartı ile Sistem Yönetimi'nin sağlık
  ve entegrasyon gözlemi bağlanır. Bu sınır `test/ai-architecture-contract.test.mjs`
  ile korunur.
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
| `src/server/ai/aiDiagnosticProbe.js` | Sabit istemli Aşama 1 bağlantı sınaması |
| `src/server/ai/aiRouteSupport.js`, `aiRuntime.js`, `aiErrors.js` | Uç yardımcıları, süreç tekilleri, `AiError` |
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
- Her SQL deyimi yalnızca `@sicil` satırına dokunur (`WHERE Sicil = @sicil`).
  Başka bir Sicil'in satırını okuyan, değiştiren ya da silen bir yol yoktur;
  A kullanıcısının anahtarı B kullanıcısına hiçbir koşulda ulaşmaz (ayrıca
  şifre, Sicil'e bağlıdır — §4).
- Kurumsal personel kaynağında bulunmayan Sicil `UNAUTHORIZED` alır.

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
kayıt/güncelleme zamanı ve son doğrulama sonucu. Şifreli alanlar ve satır
sürümü tarayıcıya **gitmez**.

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
- **Değiştirilirse** kayıtlı kişisel anahtarlar çözülemez. Kullanıcılar
  "Kayıtlı kişisel anahtarınız okunamadı. Anahtarı yeniden kaydedin."
  iletisini görür ve anahtarlarını yeniden kaydeder; bu sırada istekler
  kurumsal anahtara **geçmez**. Aşama 1'de toplu yeniden şifreleme aracı yoktur.
- Boşsa kişisel anahtar saklama kapalıdır; yalnızca kurumsal anahtar kullanılabilir.

### Açık doğrulama

**Doğrula** düğmesi yalnızca **kişisel** anahtarı, model üretmeyen hafif bir
çağrıyla (`GET /models`) sınar; kurumsal anahtara hiç dokunmaz.

| Sağlayıcı yanıtı | Kaydedilen sonuç |
| --- | --- |
| 2xx | `VALID` |
| 401 | `REJECTED` |
| 403 | `FORBIDDEN` |
| Diğer, süre aşımı, erişilemeyen uç | Sonuç yazılmaz; hata kodu döner |

Sonuç yalnızca doğrulanan anahtar hâlâ kayıtlıysa yazılır (satır sürümü
denetimi): doğrulama sürerken anahtar değiştirildiyse eski sonuç yeni anahtara
yapışmaz. Yeni anahtar kaydedildiğinde önceki doğrulama sonucu silinir.

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

- `version` yalnızca `1`; en fazla 200 model; model kimlikleri benzersiz.
- `provider` yalnızca `onprem` (varsayılan). `capabilities` bilinen
  yeteneklerden en az biri.
- `contextTokens` boş ya da pozitif tam sayı; `maxConcurrency` boş ya da
  1–1000 (model başına eşzamanlı istek üst sınırı, §6); `enabled` boolean.
- Profil kayıttaki **etkin** bir modele bağlanmalı ve profilin gerektirdiği
  yetenekleri taşımalıdır. `maxOutputTokens` 1–131072; `timeoutMs`
  1000–600000 (profilin istek süre sınırı; yoksa genel sınır).
- Sorunlar birlikte, belge yoluyla bildirilir; değerler yansıtılmaz.

Yükleme: dosya mutlak bir yol olmalı ve `.json` ile bitmelidir (UNC ve Windows
yolları desteklenir), en fazla 256 KiB olabilir, **5 sn süre sınırıyla** ve tek
uçuş olarak okunur, süreç başına bir kez yüklenir (değişiklik yeniden
başlatmayla geçerli olur). Bozuk ya da okunamayan dosya sessizce varsayılana
DÜŞMEZ: istekler `AI_CONFIGURATION_ERROR` (`MODEL_REGISTRY_INVALID`) alır,
Sistem Yönetimi sorunları gösterir ve dosya 30 sn sonra yeniden denenir.

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
- Kişisel anahtar doğrulaması ayrı bir model anahtarıyla (`provider:models`)
  aynı kullanıcı ve küresel sınırlara tabidir.

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
- Tarayıcıdaki süre sınırı sunucunun sıra + istek sınırlarından uzundur: sonucu
  her zaman sunucu belirler.

**Yeniden deneme bilinçli olarak dardır.** Yalnızca isteğin sağlayıcıya HİÇ
ulaşmadığı bağlantı hataları (`ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`,
`EAI_AGAIN`) bir kez, 200–600 ms titreşimli beklemeden sonra ve kalan süre
bekleme + 1 sn'yi karşılıyorsa yinelenir. Geçersiz anahtar, yetki, oran sınırı,
istek doğrulama hatası, süre aşımı ve iptal **yinelenmez**.

---

## 8. Hata sınıflandırması

Sağlayıcının ham hatası arayüze taşınmaz; her sonuç kararlı bir koda indirgenir.
Hata gövdesi var olan sözleşmeyi izler: `{ error: { code, message, details } }`.
"Hizmet hatası" sütunu sonucun hizmet sağlığını mı yoksa kullanıcı/istemci
kararını mı anlattığını söyler; `ai.request` işleminin hata oranı yalnızca
hizmet hatalarını sayar.

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
| `AI_CONFIGURATION_ERROR` | 503 | Hayır | Evet | Yapılandırma, model kaydı, 404 ya da yönlendirme |
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
- **Anlık ölçümler:** etkin ve sıradaki yapay zekâ isteği.
- `ai.*` işlemleri kalıcı telemetriye yazılır ve **Performans** sekmesinin işlem
  dökümüne (toplam süreye göre ilk 25 işlem) girebilir; API P95 ve hata oranı
  uyarılarına katılmaz. Aşama 1'de yapay zekâya özgü otomatik uyarı yoktur.
- **Süreç özeti:** istek/başarı sayıları, sonuç kodları, anahtar kaynağına
  (`personal`/`default`/`missing`) ve profile göre dağılım, sağlayıcı gecikmesi
  ve sıra beklemesi yüzdelikleri, yineleme sayısı, son başarı/başarısızlık.
- **Yapılandırılmış günlük:** hizmet hataları ve kurumsal anahtarla alınan
  retler `component: AI` ile yazılır; bağlamda profil, model kimliği, anahtar
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
  askıda bırakamaz. Durumlar: kapalıysa *Yapılandırılmamış*; yapılandırma ya da
  model kaydı hatalıysa, sıra %80 dolduysa, son 5 dakikada kapasite nedeniyle
  istek geri çevrildiyse ya da son sağlayıcı çağrısı başarısızsa *Dikkat*; son
  15 dakikada başarılı temas varsa *Sağlıklı*; aksi hâlde *Bilinmiyor*. Yapay
  zekâ isteğe bağlı bir yetenek olduğundan hiçbir zaman *Kritik* bildirilmez.
  Ayrıntı çekmecesi etkin/sıradaki istekleri, sınırları, geri çevrilen ve süresi
  dolan istekleri, sağlayıcı P95 gecikmesini ve anahtar kaynağı dağılımını
  gösterir.
- **Entegrasyonlar** yeni bir **Yapay zekâ sağlayıcısı** kartı gösterir.
  **Bağlantıyı Test Et** yıkıcı değildir: 6 sn süre sınırlı, model üretmeyen
  `GET /models` çağrısıdır; kurumsal anahtar tanımlıysa o kullanılır ve yanıtın
  HTTP durumu dışında hiçbir şeyi okunmaz.
- Yanıtlar adres, yol ya da anahtar taşımaz; yapılandırma yalnızca
  "Yapılandırılmış / Yapılandırılmamış" ve eksik ayarların **adlarıyla**
  bildirilir.

---

## 10. Uçlar

Hepsi Node çalışma zamanında, önbelleksiz çalışır ve kimliği yalnızca
güvenilir oturumdan alır.

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
belirteci kullanılır; yanıtta kısaltılmış metin, profil, model, anahtar kaynağı,
süre ve sıra beklemesi döner.

---

## 11. Ayarlar ekranı

**Ayarlar → Yapay zekâ erişimi** kartı:

- Başlıktaki çip hangi anahtarın kullanılacağını söyler: *Kişisel anahtar*,
  *Kurumsal anahtar*, *Anahtar gerekli*, *Yapılandırılmadı* ya da *Kapalı*.
- Kayıtlı anahtar yalnızca `••••` + son dört karakterle, kayıt tarihiyle ve son
  doğrulama sonucuyla gösterilir. **Doğrula**, **Değiştir** ve **Kaldır**
  eylemleri vardır; kaldırma satır içi onay ister ve sonucunu (kurumsal anahtara
  dönüş ya da yapay zekânın kullanılamaması) açıkça yazar.
- Anahtar alanı parola türündedir; otomatik doldurma kapatılır ve parola
  yöneticilerine alanı yok sayma işareti verilir. Taslak yalnızca bileşen
  belleğinde durur; kayıttan sonra silinir ve anahtar bir daha gösterilmez.
  Biçim hatası istek atılmadan gösterilir.
- **Bağlantı denemesi** geçen süreyi sayar ve **İptal** ile kesilebilir;
  sonuç anahtar kaynağını, profili, modeli ve süreyi gösterir. Yerine yenisi
  başlatılan ya da iptal edilen denemenin geç gelen sonucu uygulanmaz; anahtar
  değişince önceki sonuç temizlenir; kart kapanınca süren deneme iptal edilir.
- **Demo Kipinde** hiçbir istek atılmaz ve anahtar kaydedilmez.

---

## 12. Yapılandırma

Bütün değişkenler **yalnızca sunucu tarafıdır**; hiçbiri `NEXT_PUBLIC_` ön eki
taşımaz. Geçersiz değer sessizce varsayılana çevrilmez: sorunlu ayarın adı
bildirilir ve yapay zekâ kullanılamaz sayılır (kapalı kalacak biçimde başarısız
olur). Değerler hiçbir tanı çıktısına taşınmaz.

| Değişken | Varsayılan | Anlamı |
| --- | --- | --- |
| `MERGEN_ROTA_AI_ENABLED` | `false` | Özelliği açar |
| `MERGEN_ROTA_AI_BASE_URL` | — | OpenAI uyumlu ağ geçidinin taban adresi (genellikle `/v1` ile biter). HTTPS zorunlu; düz HTTP yalnız geri döngü adresinde ya da açık onayla. Adreste kullanıcı bilgisi, sorgu ya da parça bulunamaz |
| `MERGEN_ROTA_AI_ALLOW_INSECURE_HTTP` | `false` | Düz HTTP'ye açık onay; üretimde kapalı kalmalıdır |
| `MERGEN_ROTA_AI_DEFAULT_API_KEY` | boş | Kurumsal anahtar; yalnızca kişisel anahtarı olmayanlar için |
| `MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY` | boş | Kişisel anahtarları şifreleyen 32 baytlık ana anahtar (§4) |
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
| `Nonce` | `varbinary(12)` | 12 bayt |
| `Ciphertext` | `varbinary(1024)` | 16–1024 bayt |
| `AuthTag` | `varbinary(16)` | 16 bayt |
| `KeyHint` | `varchar(4)` | Gösterim için son dört karakter |
| `CreatedAt`, `UpdatedAt` | `datetime2(7)` | UTC |
| `LastValidatedAt`, `LastValidationStatus` | `datetime2(7)`, `varchar(20)` | `VALID` / `REJECTED` / `FORBIDDEN` |
| `RowVersion` | `rowversion` | Doğrulama sonucunun eşzamanlılık denetimi |

Konuşma geçmişi, istem ya da yanıt **saklanmaz**. Betik yinelenebilirdir,
veriye dokunmaz, `0015_assignment_coordination_and_presence` kaydı yoksa hata
verir ve `0016_ai_user_credentials` kaydını yazar. Yeni kurulum aynı tabloyu
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
# Normal yanıt veren sahte uç (düz HTTP yalnız geri döngü adresinde kabul edilir)
node test/helpers/fakeOpenAiCompatibleServer.mjs --serve --port 8099
# 20 sn geciken sahte uç (yavaş/takılı yapay zekâ senaryoları için)
node test/helpers/fakeOpenAiCompatibleServer.mjs --serve --port 8099 --delay-ms 20000
# Yalnızca belirtilen anahtarı kabul eden sahte uç (geçersiz anahtar senaryosu için)
node test/helpers/fakeOpenAiCompatibleServer.mjs --serve --port 8099 --valid-key <KURUMSAL_TEST_ANAHTARI>
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
5. **Doğrula** ile anahtarı sınayın; sonuç kalıcı olarak kartta görünür.
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
