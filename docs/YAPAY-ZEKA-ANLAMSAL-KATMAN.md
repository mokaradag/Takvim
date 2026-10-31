# Rota AI · Anlamsal Katman (Aşama 4)

Bu belge Aşama 4'ün amacını, **dondurulmuş dört adımlı yol haritasını**,
değişmez güven sınırlarını, Aşama 4A'da kurulan anlamsal sözleşme ile
değerlendirme temelini, Aşama 4B'de kurulan gerçek gömme ile aday keşfini
ve yeniden sıralamayı ve Aşama 4C'de kurulan türlü planlayıcıyı (§12)
anlatır. Aşama 1–2 için
[YAPAY-ZEKA-PLATFORMU.md](YAPAY-ZEKA-PLATFORMU.md), Aşama 3 için
[YAPAY-ZEKA-ALAN-ARACLARI.md](YAPAY-ZEKA-ALAN-ARACLARI.md) esastır.

Belgede **UYGULANDI** yazan bölümler bugünkü depoda vardır ve sınanır.
Aşama 4D (doğrulanmış kanıttan doğal yanıt ve odak görünümü) uygulandı;
kurum içi model kabulü açıktır (§13).

---

## 1. Amaç

Aşama 4, Rota AI'nin Türkçe doğal dili gerçekten anlamasını hedefler:
farklı ifade edilmiş, kısaltılmış, eksik ya da günlük dille yazılmış
soruları anlamsal olarak yorumlamak; kurum içindeki gömme (embedding) ve
yeniden sıralama (rerank) modellerini kullanmak; doğru Rota yeteneğini
seçmek; gerçek belirsizlikte açıklama istemek, desteklenmeyen istekte
çekimser kalmak; Aşama 3 araçlarından gelen yetkili olguları doğal ve
açıklayıcı Türkçe yanıta dönüştürmek. Standart ve Derin düşünme kipleri
birlikte desteklenir.

Kavramsal hedef akış:

```
Türkçe istek
  → anlamsal yorum
  → aday yetenek keşfi (gömme ile katalog araması)
  → sınırlı aday kümesinin yeniden sıralanması
  → sınırlı, türlü plan
  → Aşama 3 salt okunur Rota araçları   ← kimlik, yetki, SQL, hesap, kanıt
  → doğrulanmış kanıt
  → kanıta dayalı, insan kalitesinde yanıt
```

**Aşama 4, Aşama 3'ün üzerine kurulur; onun yerine geçmez.** Gömme,
yeniden sıralama ve sohbet modelleri yalnızca **danışman** katmandır.

---

## 2. Değişmez güven sınırı

| Konu | Sahibi | Aşama 4'ün rolü |
| --- | --- | --- |
| Kimlik (Sicil) | Güvenilir sunucu oturumu | Yok; güvenilir Sicil anlamsal katmana verilmez, onun çıktısında bulunmaz; kullanıcının yazdığı numara yalnızca metindir |
| Yetki ve görünürlük | Aşama 3 araçları ve var olan yetki modeli | Yok; anlamsal benzerlik yetki değildir |
| SQL ve veri erişimi | Sabit, parametreli Aşama 3 sorguları | Yok; model SQL üretemez |
| Belirlenimci hesap | Aşama 3 araçları | Yok |
| Kanıt ve doğrulama | Aşama 3 kanıt defteri ve doğrulayıcısı | Yok; model metni kanıt sayılmaz |
| Yetenek adayı önerisi | — | **Danışman**: yalnızca sunucuya ait katalogdan aday önerir |

Anlamsal katman başarısız olursa (model yok, süre doldu, bozuk çıktı) sonuç
**danışmanlığın kaybıdır**: akış Aşama 3'ün bugünkü davranışına döner; hiçbir
koşulda yetki, kimlik ya da kanıt kararı gevşemez.

---

## 3. Güvenlik ve yetki değişmezleri (dondurulmuş)

1. Güvenilir kimlik yalnızca güvenilir sunucu/oturum sınırından gelir.
2. Gömme ve yeniden sıralama modelleri Sicil seçemez ya da değiştiremez.
3. Gömme ve yeniden sıralama modelleri yetki kapsamı belirleyemez.
4. Gömme ve yeniden sıralama modelleri SQL üretemez.
5. Gömme ve yeniden sıralama modelleri veri görünürlüğünü genişletemez.
6. Anlamsal benzerlik yetki anlamına gelmez.
7. Anlamsal olarak ilgili hâle gelen bir aday bu yüzden görünür olmaz.
8. Aşama 3 araçları var olan sözleşmelerine göre salt okunur kalır.
9. Korunan olgusal yanıtların dayanağı doğrulanmış kanıttır.
10. Model metni, model söyledi diye kanıt olmaz.
11. Gelecekteki bir anlamsal dizin, kullanıcının erişemediği kayıtları açığa
    çıkaran bir yan kanal olamaz.
12. Aşama 4A'da küresel bir veritabanı satırı vektör dizini yoktur.
13. Duyarlı üretim verisi sınama verisine kopyalanmaz.
14. Aşama 4A kıyas verisinin tamamı sentetiktir.
15. Anlamsal malzemedeki yönerge enjeksiyonu ya da kötü niyetli metin,
    sistem/araç sözleşmeleri üzerinde yetki kazanamaz.

Aşağıdakiler olasılıksal kalite ölçüsü DEĞİL, mutlak koşuldur; her aşamada
**sıfır** olmalıdır:

| Mutlak koşul | Bugün nasıl korunur |
| --- | --- |
| Yetkisiz kanıt açıklaması = 0 | Aşama 3 yetki ve açıklama sınamaları (`ai-disclosure-invariants`, `ai-domain-tools` …); anlamsal adaylar kanıt taşımaz |
| Modelin seçtiği kimliğin oturum kimliğinin yerine geçmesi = 0 | Araç kayıt defteri kimlik alanı kabul etmez (`ai-architecture-contract`); anlamsal sözleşmede Sicil yoktur (`ai-semantic-contract`) |
| Modelin ürettiği keyfî SQL'in çalışması = 0 | Genel SQL aracı yoktur; araç SQL'i sabittir (`ai-architecture-contract`) |
| Aşama 3 yetkisinin aşılması = 0 | 4B keşfi yalnızca katalog kimliği, türü, sırası ve skoru döndürür; araç yürütmez, kimlik, yetki, SQL ya da kanıt taşımaz; Aşama 3 turuna bağlı değildir. Sözleşmeyi üretimde yalnızca keşif hizmeti kullanır (`ai-semantic-contract`, `ai-semantic-retrieval`) |
| Kıyas kümesinde gerçek duyarlı veri = 0 | Sentetik veri denetimi (`ai-semantic-evaluation`) |

Aşama 4A'nın dokunduğu sınırlar için sınamalar:

- Katalog öğe türleri kapalıdır (`tool`); veritabanı kaydı türü yoktur.
  Yeni tür bilinçli bir sözleşme değişikliğidir.
- Aday nesnesi yalnızca `id`, `kind`, `rank`, `similarity` ve (yeniden
  sıralandıysa) `relevance` taşır; yetki, kimlik ya da metin taşımaz.
- Yeniden sıralayıcı yalnızca sunucunun verdiği adayları dizer; aday ekleyemez,
  çıkaramaz (dizin adresli yanıt; yabancı dizin reddedilir).
- Katalog metnindeki enjeksiyon metni yalnızca gömülür; sıralama vektöre
  bağlıdır ve sonuca metin girmez.
- Anlamsal modüller kimlik, yetki, SQL, ağ ya da ortam değişkenine erişmez.
- 4B: keşif hizmeti sağlayıcıyı değil yalnızca ağ geçidini çağırır; gömme ve
  yeniden sıralama çağrısını yalnızca ağ geçidi, uç yollarını yalnızca
  bağdaştırıcı bilir; keşif sonucu sorgudaki ya da katalogdaki enjeksiyon
  metnini, Sicil'i ya da SQL'i taşımaz ve günlüğe/telemetriye sorgu, vektör
  ya da katalog metni yazılmaz (`ai-semantic-retrieval`).

---

## 4. Regex ve anahtar sözcük tabanlı "zekâ" yasağı

Doğal dil anlayışı regex, anahtar sözcük, alt dize eşleştirme, elle
yazılmış Türkçe eş anlamlı tabloları, kalıp sözlükleri ya da tek tek kıyas
sorularını geçirmek için eklenen özel durumlarla **kurulmaz**. Gerekçe:

- Türkçe sondan eklemeli bir dildir; ek, yazım hatası, ASCII yazım ve
  günlük dil karşısında kalıp tabloları sürekli büyür ve kırılır.
- Kıyas sorularına göre yamanan kural kümesi ölçüyü şişirir, genellemez.
- Kural tablosu güvenlik sınırı gibi görünüp sessizce yanlış araca yönlendirir.

Anlam gömme, yeniden sıralama, modelin türlü yorumu ve türlü sözleşmelerden
gelir. Belirlenimci kod anlamsal katmanın **önünde ve arkasında** kalır:
şema/tür/enum doğrulaması, yapısal normalleştirme, sınırlar, yetki, yürütme,
kanıt doğrulaması, sıralama mekaniği, kararlı kimlikler, süre aşımı ve
geçersiz yanıt işleme. Var olan sözdizimsel doğrulama regexleri bu yasağın
konusu değildir.

Sınamalar bunu yapısal olarak korur: anlamsal modüllerin yürütülen kodunda
Türkçe harf (dolayısıyla Türkçe sözcük ya da kalıp tablosu) ve belirli bir
araca özel dal yoktur; üretim kaynağında kıyas kümesinin dosya adı, vaka
kimliği ya da vaka metni geçmez.

---

## 5. Dondurulmuş yol haritası

Aşama 4 **tam olarak dört** uygulama adımından oluşur ve 4D ile biter.

### 4A — Anlamsal temel ve değerlendirme (UYGULANDI)

- Anlamsal sözleşmeler ve güven sınırları; model çıktısının güvenilmez veri
  olarak doğrulanması; sürüm/parmak izi kavramı.
- Değerlendirme yöntemi ve ölçüleri; sentetik Türkçe kıyas kümesi.
- Model sınırının belirlenimci sınama ikizleri; gerçek model nitelendirme
  mekanizması; kurum içi kabul sözleşmesi.
- **Beklenen üretim davranışı değişikliği: YOK.** Hiçbir üretim modülü
  anlamsal katmanı içe aktarmaz.

### 4B — Gerçek anlamsal erişim ve yeniden sıralama (UYGULANDI, bu adım)

- `embedding` ve `rerank` profilleri üzerinden (model kaydı esas) gerçek
  gömme ile aday keşfi ve sınırlı aday kümesinin yeniden sıralanması; ikisi
  aynı adımda birlikte yapılır (§7).
- İlk kaynak Rota'nın kendi yetenek/araç anlamıdır: katalog sunucuya ait 19
  araç açıklamasıdır. Kesin/yapısal sinyallerle birleştirme bu adımda
  **gerekmedi**: yapısal sinyal (kimlik, varlık çözümü, süzgeç) Aşama 3'ün
  belirlenimci işi ve 4C planlayıcısının girdisidir; keşfe anahtar sözcük ya
  da kalıp eklenmedi (§4).
- Sağlayıcı bağdaştırıcısı Aşama 1 ağ geçidi kurallarıyla (kimlik, kapasite,
  süre sınırı, iptal, telemetri) çalışır ve §6.1'deki model sınırı
  imzalarını uygular; anlamsal katman hatası danışmanlığın kaybıdır (§7.5).
- Dizin kimliği (§6.2) yeniden kullanımdan önce karşılaştırılır (§7.4).
- Vektör veritabanı **eklenmedi**: dizin süreç içindedir (19 öğe). Ancak
  ölçülmüş bir gereksinim kanıtlanırsa ve yol haritası bilinçli olarak
  güncellenirse eklenebilir.
- Keşif **danışman adaylar** üretir ve Aşama 3 turuna bağlanmaz; adayların
  planlayıcıya ve araç yürütmesine bağlanması 4C'dir (§12). **Beklenen üretim
  davranışı değişikliği: YOK** (asistan turları aynıdır).
- Çıkış ölçütü: 4A kıyas kümesinde ölçülen ve belgelenen iyileşme; eşikler bu
  ölçümden sonra dondurulur. Gerçek model ölçümü geliştirme ortamında
  yapılamadı (§8); eşikler kurum içi ölçüme kadar **dondurulmadı**.

### 4C — Akıllı planlayıcı ve zayıf model doğrulaması (UYGULANDI — kabul kapısı AÇIK)

> Kod, sözleşme, değerlendirici ve altın etiketler uygulandı ve sınanıyor
> (§12). **Düzeltilmiş kabul kapısı bekliyor:** kanonik 117/117 ve zorunlu ek 19/19 birlikte gerekir.
> Tarihsel Haiku 4.5 88/117 ve 89/117 ölçümleri düzeltilmiş kapıdan önceye aittir (§12.7).
> Gerçek Qwen3-Next-80B-A3B-Instruct nitelendirmesi kurum içinde bekliyor.

- Sıralanmış anlamsal anlayışı Aşama 3 türlü araç yürütmesine bağlamak:
  niyet, varlık, ölçü ve koşul yorumu; sınırlı yapılandırılmış plan; doğru
  araç seçimi; gerçek belirsizlikte açıklama; desteklenmeyen istekte
  çekimserlik.
- Mimari, sınır düzeyi akıl yürütme gerektirmemelidir. Düşük yetenekli bir
  Claude modeli (Haiku 4.5) **zayıf model uyumluluk kapısı** olarak
  kullanılabilir; üretimdeki Qwen modelinin birebir taklidi olarak
  tanımlanmaz. Standart kipin bağlayıcı kabulü kurum içindeki gerçek düşünme
  kipsiz modeldir.
- Kıyas kümesi gerekirse türlü istek altın etiketleriyle genişletilir
  (yeni sürüm, yeni parmak izi).

### 4D — İnsan kalitesinde yanıt ve kurum içi yakınsama (UYGULANDI — kurum içi kabul AÇIK)

- Doğrulanmış kanıttan doğal, açıklayıcı Türkçe yanıt: sunucu doğruları ve
  ilişkileri (önermeler) belirler, model onların anlatımını seçer; kanıta
  bağlılık korunur. Uygulama ve ölçümler §13.
- Gerçek üretim/kurum içi modellerle (§9) doğrulama; Aşama 4'ün kapanışı.
  Kurum içi koşu yolu hazırdır (§13.12), gerçek Qwen ölçümü bekliyor.

### Yol haritası yönetişimi

- Bu 4A → 4B → 4C → 4D planı Aşama 4'ün varsayılan mimarisidir. Sonraki
  Aşama 4 PR'ları onu **sessizce değiştiremez**.
- Değişiklik ancak somut ve **ölçülmüş** bir gerekçeyle, bu belge bilinçli
  olarak güncellenerek yapılır; hata düzeltme ya da inceleme yakınsama
  turunda fırsatçı biçimde yapılmaz.
- Aşama 4, 4D ile biter; 4E/4F gibi ek adım açılmaz. İlgisiz yeni fikirler
  sonraki aşamalara aittir (yapay zekâ eliyle yazma Aşama 5, ses ve görsel
  Aşama 6).
- İnceleme yakınsama kuralı: bir inceleme önerisi ancak somut bir doğruluk ya
  da güvenlik kusuru, sözleşme ihlali, gerileme, yeniden üretilebilir uç durum
  ya da adımın kapsamının doğrudan gerektirdiği bir sınama boşluğu gösteriyorsa
  o adımda uygulanır; geleceğe dönük özellik, genel çerçeve, kapsam dışı
  yeniden düzenleme ya da üslup tercihi için PR genişletilmez.

---

## 6. Aşama 4A'da uygulananlar (UYGULANDI)

### 6.1 Anlamsal sözleşme — `src/domain/ai/semanticContract.js`

Saf, belirlenimci ve canlı yola bağlı olmayan kurallar:

| Kavram | Kural |
| --- | --- |
| Sorgu normalleştirme | Asistan iletisiyle aynı denetim karakteri temizliği + görünmez karakter (U+00AD, U+200B, U+2060, U+FEFF) silme + Unicode NFC (temizlikten SONRA: silinen karakterin yan yana getirdiği harf ve birleşen işaret de birleşir; `normalize(normalize(x)) = normalize(x)`) + boşlukların tekleşmesi; boş sorgu `QUERY_EMPTY`, 2000 karakteri aşan `QUERY_TOO_LONG`. **Büyük/küçük harf katlanmaz** (Türkçe I/ı/İ/i korunur); aksan, ek, sözcük değiştirilmez, eş anlam ya da kök bulma yapılmaz |
| Katalog | Öğe: `id`, `kind` (kapalı küme: `tool`), `version`, `text`, `fingerprint`; en fazla 256 öğe, metin en fazla 4000 karakter, kimlik tekil (metnin tekil olması gerekmez: iki öğe aynı açıklamayı taşıyabilir; kimlik ve sıra ayırır); her tanım bir kez okunur, seyrek dizinin boşluğu da reddedilir. Bugünkü katalog Aşama 3 araç kayıt defterinin 19 aracıdır; metin aracın sunucuya ait açıklamasıdır (şema, işleyici, yetki belgesi girmez) |
| Model kökeni | Profil–yetenek uyumlu rota künyesinden: `embedding` profili `embedding`, `rerank` profili `rerank` yeteneğini taşımalıdır. Rota ve köken alanları (`profile`, `model`, `provider`) **bir kez** okunur; doğrulanan değer kökene ve uzaya yazılan değerdir (okumalar arasında değişen erişimci geçerli değerle doğrulanıp başka değer yazdıramaz). Rotanın model kaydından çözülmesi çağıranın işidir (4B'de `resolveModelProfile`); nitelendirmede köken koşu dosyasının beyan ettiği kimliktir ve raporda öyle yazılır. Köken yetki taşımaz, yalnızca uzayı adlandırır. İş kodunda model adı yoktur |
| Gömme uzayı | `profile + model + provider + preprocessing`; ön işleme (ör. E5 `query:`/`passage:` önekleri) adlandırılmış bir belirteçtir |
| Gömme yanıtı | Dizin adresli `[{ index, vector }]`; her giriş tam bir kez, tüm vektörler aynı boyutta (1–8192), değerler sonlu sayı, sıfır vektör yok. Girişler konumla, her değer bir kez okunur (dizinin yineleyicisine güvenilmez; doğrulanan değer kullanılan değerdir); vektör uzunluğu da model verisidir ve ayırmadan önce tam sayı ve sınır olarak denetlenir; okurken fırlayan erişimci (getter/Proxy) doğrulamadan kaçamaz; vektörler taşma/alttaşma güvenli ölçeklemeyle birim uzunluğa indirilir |
| Sıralama | Kosinüs benzerliği ([-1, 1]); en fazla 20 aday; eşitlikte katalog sırası; başka uzayda ya da boyutta üretilmiş sorgu `SPACE_MISMATCH`/`DIMENSION_MISMATCH` |
| Yeniden sıralama yanıtı | Dizin adresli `[{ index, score }]`; her aday tam bir sonlu skor almalıdır; eksik/fazla skor, yabancı ya da yinelenen dizin, sayı olmayan skor reddedilir ve ilk aşama sırası geçerli kalır; eşitlikte ilk aşama sırası korunur; sağlayıcının yanıt sırası sonucu değiştirmez |
| Taklide karşı koruma | Katalog, uzay, dizin, aday listesi ve kıyas kümesi yalnızca modülün kendi kurucularından kabul edilir; kıyas kümesi yalnızca gerçek kataloğa bağlanabilir; taklit nesne doğrulamayı atlayamaz |

Model çıktısı güvenilmez dış veridir. Karşılanan durumlar ve kodları:

| Durum | Sonuç |
| --- | --- |
| `null`, nesne, metin; dizi olmayan yanıt; nesne olmayan giriş; okunamayan (fırlayan erişimcili) giriş ya da değer | `RESPONSE_SHAPE` |
| Eksik/fazla giriş, devasa yanıt (önce uzunluk denetlenir) | `COUNT_MISMATCH` |
| Dizin yok, negatif, kesirli, metin ya da aralık dışı (yabancı aday) | `INDEX_INVALID` |
| Yinelenen dizin | `INDEX_DUPLICATE` |
| Sıfır, negatif, kesirli ya da 8192'den büyük boyut | `DIMENSION_INVALID` |
| Toplu yanıtta ya da sorguda farklı boyut | `DIMENSION_MISMATCH` |
| NaN, ±Infinity, sayısal metin, `null`, seyrek dizi, BigInt; sonlu olmayan skor | `VALUE_NOT_FINITE` |
| Sıfır vektör | `ZERO_VECTOR` |
| Başka model/sağlayıcı/ön işleme uzayının sorgusu (bayat gömme) | `SPACE_MISMATCH` |

**Model sınırı imzaları** (4B bağdaştırıcısının uygulayacağı sözleşme):

```
embed(texts, { purpose: 'document' | 'query', signal }) → [{ index, vector }]
rerank(query, documents, { signal })                    → [{ index, score }]
```

### 6.2 Sürüm ve geçersizlik

| Parmak izi | Bağlı olduğu | Değişince |
| --- | --- | --- |
| Öğe | sözleşme sürümü, tür, kimlik, sürüm, normalleşmiş metin | o öğenin vektörü bayattır |
| Katalog | öğelerin sırası ve parmak izleri | katalog dizini bayattır |
| Gömme uzayı | profil, model, sağlayıcı, ön işleme | o uzaydaki bütün vektörler bayattır |
| Dizin kimliği | sözleşme sürümü, katalog, uzay, boyut | dizin yeniden kurulmalıdır |
| Kıyas kümesi | biçim, sürüm, dil, vakalar ve altın etiketler | eski koşu dosyaları reddedilir |

Aşama 4A kalıcılık ya da önbellek kurmaz. 4B bir dizini yeniden kullanacaksa
önce kimliğini güncel katalog ve uzayla karşılaştırmak zorundadır; eşleşmeyen
dizin hiçbir koşulda güncel sayılmaz. Oluşturma zamanı gibi künye bilgisi
kimliğe katılmaz. 4B'nin süreç içi dizini bu kuralı uygular (§7.4).

### 6.3 Değerlendirme sözleşmesi — `src/domain/ai/semanticEvaluation.js`

**Güven sınırı.** Değerlendirmeye giren her dış veri güvenilmezdir ve tek bir
noktada, bir kez doğrulanıp güvenilir iç biçime çevrilir; ölçüler yalnızca bu
iç biçimle hesaplanır. Aşağı akıştaki işlevler benzer görünen nesnelere
güvenmez.

| Güvenilmez girdi | Doğrulama noktası | Reddin biçimi |
| --- | --- | --- |
| Model çıktısı (vektör, skor) | `semanticContract.js` (§6.1) | Hata kodu; vaka `invalid` ıskadır |
| Kıyas belgesi | `validateSemanticBenchmark`: yalnızca `createSemanticCatalogue` kataloğu; kapalı belge ve vaka şeması; yoğun ve sınırlı diziler (seyrek dizinin boşluğu, açıkça yazılmış `null` yokluk sayılmaz); bozuk grup kopyalanmaz | `{ ok: false, issues }`; okunamayan belge `$:unreadable` |
| Koşu kaydı | `summarizeSemanticRun` içinde bir kez (aşağıda) | `SEMANTIC_RUN_STALE` / `SEMANTIC_RUN_INVALID` |
| Planlayıcı kararı | `evaluateSemanticDecisions` | Geçersiz karar sayılır |
| Ham nitelendirme koşusu | `scripts/semantic-evaluation.mjs report` (§6.6) | Komut reddeder |

Koşu kaydının kuralları. Temel değişmez: kabul edilen kayıt,
`collectSemanticRun()`'ın gerçekten üretebileceği bir durumdur. Alanlar tek
tek değil, birbirine bağlı durum olarak doğrulanır:

- Biçim, sürüm (yalnızca 1), kıyas kümesi ve katalog parmak izi uyuşmazsa
  `SEMANTIC_RUN_STALE`. Bayatlık yalnızca bu karşılaştırmanın kendisinden
  gelir (modül içi işaret); kayıttaki fırlayan erişimcinin hatası, iletisi
  `SEMANTIC_RUN_STALE` olsa bile `SEMANTIC_RUN_INVALID`'dir.
- Yapı kapalıdır: üst düzey kayıt, vaka satırı, çağrı kaydı ve aday,
  koşucunun yazdığı alan kümesini taşır; eksik ya da bilinmeyen alan
  `SEMANTIC_RUN_INVALID`'dir.
- Vaka satırları kıyas kümesinin vakalarıdır ve **kıyas kümesi sırasındadır**
  (koşucu satırları bu sırayla yazar; sıra biçimin parçasıdır). Yabancı,
  yinelenen ya da geri giden (yer değiştirmiş) satır reddedilir (sessizce yok
  sayılmaz, ezilmez). Kaydı olmayan vaka reddedilmez; hangi konumda olursa
  olsun ıska sayılır (kısmi koşu).
- Çağrı kaydının alanları sonuç türüne göre tektir: `ok` → sonuç ve gecikme;
  `invalid`/`failed` → güvenli kod ve gecikme; `timeout` → gecikme ve
  koşucunun duruş kararı (`halted: true|false`). Yapılan her çağrı (dizin,
  sorgu gömme, yeniden sıralama) sonlu ve negatif olmayan gecikme taşır.
- **Çağrılmayan ıska** yalnızca koşucunun ürettiği biçimdir:
  `{ outcome: 'failed', reason: 'INDEX_UNAVAILABLE' | 'RUN_HALTED' }`; gecikme,
  aday ve yeniden sıralama taşımaz. Bu iki ayrılmış kod başka hiçbir kayıtta
  (`invalid` sonuç, gecikmeli kayıt, yeniden sıralama kaydı) kullanılamaz.
- Dizin durumu: dizin `ok` değilse her kayıtlı vaka `INDEX_UNAVAILABLE`
  ıskasıdır (dizin olmadan model çağrılmaz, sıralama puanlanmaz); dizin `ok`
  iken bu kod kullanılamaz ve çağrılmayan vaka yalnızca `RUN_HALTED` olabilir.
- Sonuç ile yük tutarlıdır: `ok` dışındaki gömme aday taşımaz; yeniden
  sıralama kaydı yalnızca başarılı ilk aşamadan sonra vardır ve yalnızca `ok`
  ise sıra taşır; yeniden sıralanmış liste ilk aşamanın aday kümesinin bir
  **permütasyonudur** (aday ekleyemez, çıkaramaz).
- Aday listesi tam `min(limit, katalog)` uzunluktadır, kimlikler katalogda ve
  tekildir, skorlar sonlu ve artmayan sıradadır (benzerlik [-1, 1]).
- **Eşitlik sırası kayıtta da belirlenimcidir:** eşit benzerlikte katalog
  sırası, eşit yeniden sıralama skorunda ilk aşama sırası korunmalıdır. Eşit
  skorlu adayların yerini değiştirip Recall/kapsama/NDCG'yi değiştiren kayıt
  reddedilir.
- **Duruş durum makinesi:** koşu yalnızca `halted: true` taşıyan süre aşımından
  sonra durur; böyle çağrı en çok bir kez vardır. Ondan önceki kayıtlı
  vakalar `RUN_HALTED` taşıyamaz; sonraki kayıtlı vakaların hepsi `RUN_HALTED`
  ıskasıdır (puanlanan vaka ya da yeni çağrı gecikmesi olamaz). `halted:
  false` (ek sürede sonuçlanan) süre aşımından sonra koşu sürer ve `RUN_HALTED`
  kullanılamaz. Duruştan sonraki satırların hiç yazılmaması kısmi koşudur ve
  kabul edilir; yazılmış çelişkili satır reddedilir.
- **Köken ve dizin kimliği:** kayıttaki gömme kökeni (`profile`, `model`,
  `provider`, `preprocessing`) geçerli bir gömme uzayı kurmalı; başarılı dizin
  kaydının `identity` değeri bu uzay, katalog ve `dimensions` ile yeniden
  hesaplanan dizin kimliğine eşit olmalıdır; yeniden sıralayıcı `null` ya da
  geçerli bir `rerank` kökenidir. Özet doğrulanmış kökeni `provenance` alanında
  taşır. Bu bir tutarlılık bağıdır, imza değildir: kökeni ve kimliği birlikte
  yeniden hesaplanmış bir kayıt ayırt edilemez; kökenin model kaydından
  çözülmesi 4B'dedir.
- Kesimler koşunun toplandığı `limit` derinliğini aşamaz (`SEMANTIC_CUTOFFS`):
  toplanmamış derinlik ölçülmez. Özet kendi yapılandırmasını taşır
  (`catalogue`, `limit`, `cutoffs`, `ndcgCutoff`).
- Okunamayan değer de `SEMANTIC_RUN_INVALID`'dir; özet genel bir çalışma
  zamanı hatasıyla düşmez.
- Güvenilmez dizilerin (kıyas `cases`, `needs` ve iç grupları, `avoid`,
  `tags`, vaka satırları, aday listeleri, kesimler, planlayıcı kararları ve
  araç listeleri, katalog tanımları) uzunluğu **bir kez** okunur; yakalanan
  değer negatif olmayan, sınırlı güvenli tam sayı olmalıdır ve kopya yalnızca
  o değerle yapılır (her konum var olmalıdır). Okumalar arasında değişen
  uzunluk doğrulanan ile kopyalanan biçimi ayıramaz.

Vaka beklentileri:

| Beklenti | Anlamı | Altın etiket |
| --- | --- | --- |
| `answer` | Soru, Aşama 3 araçlarıyla sorulduğu gibi yanıtlanabilir | `needs`: en az bir ihtiyaç grubu; grup içindeki araçlar birbirinin yerine geçer, bütün gruplar gerekir |
| `clarify` | Yetenek düzeyinde gerçek belirsizlik; açıklama istenmeli | `needs`: en az iki makul yorum grubu |
| `abstain` | Rota araçlarının sınırı dışında; çekimser kalınmalı | `needs` yok |

`avoid` isteğe bağlı sert negatiflerdir: anlamsal olarak yakın ama yanlış
araçlar; ihtiyaç gruplarıyla kesişemez.

Ölçüler (G: ihtiyaç grupları, r_g: grubun ilk adayının sırası, yoksa ∞):

| Ölçü | Tanım |
| --- | --- |
| Top-1 | min r_g = 1 ise 1 |
| Recall@K | \|{g : r_g ≤ K}\| / \|G\| (aday kapsaması) |
| Kapsama@K | bütün gruplar ilk K içindeyse 1 |
| MRR | 1 / min r_g |
| NDCG@K | Σ_{r_g ≤ K} 1/log2(r_g + 1) ÷ Σ_{i=1..min(K, \|G\|)} 1/log2(i + 1) — grup başına tek kazanç |
| Kaçınma çifti tutarlılığı | en iyi ihtiyaç sırası < kaçınılacak aracın sırası olan çiftlerin oranı |
| Açıklama kapsaması@K | `clarify` vakalarında bütün makul yorumların ilk K adayda bulunması |
| Kapsam dışı ayrılabilirliği | En yüksek skorla kapsam içi/dışı ayrımının AUROC değeri (eşitlik ½); skoru olmayan (başarısız) vaka en kötü durum sayılır |
| Yeniden sıralama katkısı | Aynı ölçünün yeniden sıralama sonrası − ilk aşama farkı; iki aşamada da değeri olan **her** ölçü için: Top-1, MRR, NDCG, Recall@K, kapsama@K, kaçınma çifti tutarlılığı, açıklama kapsaması ve kapsam dışı ayrılabilirliği (`uplift`; Markdown'da "Fark" sütunu). Bir aşamada değer yoksa (`null`) fark da `null`'dır |
| Gecikme | p50 / p95 / en çok (en yakın sıra yüzdeliği) |

Planlayıcı kararları (`[{ case, decision, tools }]`, 4C için): karar
doğruluğu, beklenti başına geri çağırma (**açıklama doğruluğu** =
`recall.clarify`, **desteklenmeyen istekte çekimserlik** = `recall.abstain`),
karışıklık matrisi, `answer` vakalarında ihtiyaç kapsaması ve yasak araç
ihlali. Karar güvenilmez model çıktısıdır: alanlar bir kez okunur; araç
listesi yoğun, en çok 20 öğeli, katalog kimliklerinden ve tekildir; `abstain`
kararı araç adlandıramaz (`tools: []`); okunamayan karar, listedeki boşluk,
bilinmeyen ya da yinelenen vaka geçersiz sayılır. Okunamayan kararın
okunabilen vaka kimliği korunur: aynı vakanın sonraki kararı da yinelenen
sayılır ve tam puan alamaz. Dizi olmayan ya da uzunluğu okunamayan karar
listesi tek geçersiz çıktıdır (her vaka kararsız); değerlendirme fırlamaz.

Ölçü sözleşmesinin kuralları:

- Sıralama ölçüleri `answer`, açıklama kapsaması `clarify`, ayrılabilirlik
  `abstain` vakalarından hesaplanır; kesin kayan nokta değerine değil sıralama
  ilişkilerine dayanır.
- Başarısız (`failed`), geçersiz (`invalid`), süresi dolan (`timeout`) ya da
  hiç kaydı olmayan vaka **paydadan düşmez**; ıska sayılır ve sonuç türü ayrıca
  sayılır.
- Yeniden sıralama başarısızsa sıralama ölçüleri üretimdeki gibi ilk aşama
  sırasını kullanır. Ayrılabilirlik ise yalnızca yeniden sıralama skorunu
  kullanır: benzerlik ile ilgililik farklı ölçeklerdir ve aynı AUROC'ta
  karıştırılmaz; skoru olmayan (başarısız) vaka en kötü durum sayılır.
- Gecikme nüfusu gerçekten yapılan çağrılardır (başarısızlar dâhil); hiç
  çağrılmayan vaka (`INDEX_UNAVAILABLE`, `RUN_HALTED`) gecikmeye girmez,
  sonuç türünde sayılır.
- Hata iletisi kaydedilmez; yalnızca güvenli kod (`[A-Z][A-Z0-9_]*`) ya da
  `MODEL_CALL_FAILED` tutulur. Hata nesnesi de güvenilmezdir: kod bir kez
  okunur; metin olmayan ya da okunamayan kod ve ayrılmış (çağrılmadı) kodlar
  (`INDEX_UNAVAILABLE`, `RUN_HALTED`) genel koda iner.
- Koşucu (`collectSemanticRun`) vakaları sırayla yürütür; iki model çağrısı
  hiçbir zaman örtüşmez. Süre aşımı ve iptal:
  - Çağrı başına süre sınırı her zaman sonludur: varsayılan 60 sn, 1 ms–900 sn
    arasında tam sayı (`SEMANTIC_MAX_CALL_TIMEOUT_MS`; üretim ağ geçidinin en
    uzun meşru yaşam döngüsünü — rehber 5 sn + sıra ≤ 120 sn + rota ≤ 600 sn —
    kapsar); sınırsız çağrı seçeneği yoktur.
  - Koşunun iptali (Durdur) hemen yayılır ve koşu iptal nedeniyle reddedilir.
    İptal çağrı başlamadan geldiyse model hiç çağrılmaz; model sonucu
    kesinleştikten sonra ama koşucu onu kaydetmeden önce geldiyse başarı
    kaydedilmez.
  - Süresi dolan çağrının sinyali `TimeoutError` nedeniyle iptal edilir ve
    vaka `timeout` ıskasıdır. Sinyale uyan model bir süre sınırı daha içinde
    sonuçlanır; koşu sonraki vakayla sürer.
  - Süreç içindeki bir Promise zorla durdurulamaz. Sinyale uymayan model
    (ek süre içinde sonuçlanmayan çağrı) arka planda sürüyor sayılır ve koşu
    **kapalı kalarak** durur: süre aşımı kaydı `halted: true` taşır, model bir
    daha çağrılmaz, kalan vakalar `failed`/`RUN_HALTED` ıskasıdır. Böylece
    terk edilen çağrı sonraki vakaların sonucunu ya da gecikmesini
    kirletemez. Ek sürede sonuçlanan süre aşımı `halted: false` taşır.
  - Model işlevi kendi süre sınırının dolduğunu standart `TimeoutError` adlı
    hatayla bildirebilir (ör. `live` komutunda ağ geçidinin `AI_TIMEOUT`
    sonucu): çağrı sonuçlanmıştır, vaka `timeout` ıskasıdır (`halted: false`),
    genel `failed` değildir. Adı okunamayan hata genel hatadır.
  - **Sınır:** model bağdaştırıcısı eşzamansızdır (olay döngüsünü bloke
    etmez). Süre sınırı ve iptal Promise döndüren çağrıyı sınırlar;
    JavaScript zamanlayıcısı olay döngüsünü bloke eden eşzamanlı bir CPU
    döngüsünü kesemez (böyle bir çağrı süre sınırını aşsa da sonuçlanınca
    kaydedilir, hiç dönmezse koşu askıda kalır). Bunu süreç yalıtımı çözer ve
    4A'nın kapsamında değildir; gerçek model nitelendirmesi ayrı Python
    sürecinde çalışır (§6.6).
- Özet (`summarizeSemanticRun`) koşu kaydını yukarıdaki kurallarla bir kez
  doğrular.

### 6.4 Sentetik Türkçe kıyas kümesi — `test/fixtures/ai-semantic-benchmark.json`

117 vaka: 95 `answer` (6'sı birden çok yetenekli), 7 `clarify`, 15 `abstain`;
30 vakada 33 kaçınma çifti. 19 aracın her biri en az üç tek ihtiyaçlı vakanın
birincil adayıdır. 24 etiketlik kapalı sözlük: resmî/günlük dil, eş anlam,
çekim ekleri, kısaltma,
yazım hatası, noktalamasız, ASCII Türkçe, büyük harf (İ/I), Türkçe-İngilizce
karışık, göreli zaman, olumsuzluk, karşılaştırma, üstünlük, sayım,
tekil-çoğul, takip, varlık adı, birden çok araç; kapsam dışı için genel
bilgi, yazma isteği, desteklenmeyen hesap, Rota dışı veri ve güvenlik
(kimlik değiştirme, SQL, yönerge enjeksiyonu).

**`needs` neyi ölçer.** Aşama 4A **anlamsal yetenek erişimini** ölçer; 4C'nin
üreteceği tam yürütme planını ölçmez. `needs`, soruyu yanıtlamak için gereken
anlamsal yanıt yeteneklerini listeler. Soruda adı geçen görevi, projeyi ya da
kişiyi kimliğe bağlayan arama (`rota_task_search`, `rota_project_search`,
`rota_person_search`) Aşama 3'ün belirlenimci varlık çözümüdür ve bir
**planlayıcı önkoşuludur**: soru o aramanın kendisini sormuyorsa ("MRG-24 hangi
projenin kodu") altın etikete yazılmaz, seçilmesi de cezalandırılmaz. Örneğin
adı verilen görevin açıklaması `rota_task_detail`, adı verilen projenin baz
plan sapması `rota_baseline_compare` ister; ad → kimlik çözümünün plana
yerleşmesi 4C plan doğrulamasının konusudur. Bu kural, "adı geçen varlık için
arama aracı da zorunlu olsun" türünden önerilerle sessizce değiştirilmez.

Ters yön de geçerlidir: arama aracının **sonucu** sorulan olgunun kendisini
taşıyorsa arama, ayrıntı aracının yanında aynı grupta **yeterli bir
alternatiftir** (önkoşul değil). Örneğin görev araması termin, planlanan bitiş
ve ilerleme yüzdesini; proje araması proje liderini döndürür. Arama yalnızca
kimlik çözümü sağlıyorsa (açıklama, saat, oluşturan kişi gibi olgular
ayrıntıdadır) gruba girmez.

Etiketleme kuralları:

- Vakalar **tek turdur**. `answer` vakası sorulduğu gibi yanıtlanabilir: proje
  kapsamlı araçlarda (baz plan, WBS, bağımlılık) proje adı yazılıdır;
  göndergesi bağlam olmadan belirsiz kalan ifade ("bunlardan", "bu proje")
  `answer` vakasında kullanılmaz. Takip üslubundaki vakalar kendi içeriğini
  taşır.
- Makul bir varsayılanla yorumlanabilen bulanık ifade ("bitmesine az kalmış",
  "bu hafta") belirsizlik sayılmaz.
- Varlık adının veri düzeyindeki belirsizliği (iki "Ayşe") `answer`'dır;
  aday seçimi Aşama 3 sunucusunundur.
- Bir araç bir vakada en çok bir ihtiyaç grubunda yer alır.
- Grup içindeki araçlar ancak her biri soruyu sorulduğu gibi tek başına
  yanıtlayabiliyorsa birbirinin yerine geçer. Gereken süzgeci (ör. tarih
  aralığı) olmayan, "hangileri?" sorusunda yalnızca sayı döndüren, tam liste
  isteğinde yalnızca birkaç örnek döndüren, kapsamsız soruda kapsam (ör.
  `projectId`) gerektiren ya da adı geçen varlığı seçemeyip sınırlı bir
  sayfada bulamayabilecek araç gruba girmez.
- Bir yetenek isteğin bütün olgularını tek başına veriyorsa ikinci bir zorunlu
  grup eklenmez.
- Yetkiye bağlı ifade (ör. yalnızca yöneticilere açık "ekip" kapsamı) genel
  olarak yanıtlanabilir sayılan vakada kullanılmaz.
- Veri düzeyindeki sınır (ör. 366 günlük hareket penceresi) bir yeteneği
  yanlış yapmaz; aynı soruyu yanıtlayan başka yetenek yoksa etiket kalır.
- Vaka metinleri kanonik (normalleşmiş) ve tekildir; araç açıklamalarını ve
  belgelerdeki örnek soruları kopyalamaz (sınamayla denetlenir).
- Bütün veriler sentetiktir: gerçek kişi, proje, Sicil, e-posta, adres ya da
  uzun numara yoktur.

Kümeyi değiştirmek bilinçli bir sürüm adımıdır: parmak izi değişir ve eski
koşu dosyaları bayat sayılır. Etiket, bir modelin çıktısına uydurulmak için
değiştirilmez; yalnızca tek tur ilkesine, yukarıdaki kurallara ya da ürünün
ve aracın gerçek davranışına aykırı olduğu gösterilen vaka düzeltilir.

Yakınsama denetimi: 117 vakanın tamamı bu kurallarla, araçların gerçek
çıktısına bakılarak bir kez daha gözden geçirildi; sekiz vaka düzeltildi:

| Vaka | Düzeltme | Gerekçe |
| --- | --- | --- |
| tr-005 | `rota_data_quality` gruptan çıktı | Veri kalitesi yalnızca açık görevleri denetler ve en çok beş örnek verir; tam liste görev aramasıdır |
| tr-032 | `rota_portfolio_summary` gruptan çıktı | Portföy özeti proje seçemez; sınırlı sayfada Radar bulunmayabilir |
| tr-042 | Yalnızca `rota_data_quality` | WBS incelemesi `projectId` ister; soru kapsamsızdır |
| tr-046 | Yalnızca `rota_task_analytics` | İş yükü özetinde tarih süzgeci yoktur |
| tr-051 | "Dün ekipte" → "Dün görevlerde" | Hareket aramasının ekip kapsamı yalnızca yöneticilere açıktır |
| tr-071 | "hangileri" → "kaç görev" | Baz plan karşılaştırması eklenen ve çıkarılan görevleri yalnızca sayar |
| tr-087 | Yalnızca `rota_data_quality` | Gerçekleşen bitişi eksik tamamlanmış görevi yalnızca veri kalitesi denetler |
| tr-090 | Tek grup: `rota_task_analytics` | Proje süzgeci + gecikme + sorumluya göre gruplama toplamı ve kişi kırılımını birlikte verir |

Son hedefli denetim: dört vakada Aşama 3 işleyicisinin çıktısı sorulan olguyu
tek başına verdiği için yeterli alternatif aynı gruba eklendi (parmak izi
bilinçli olarak değişti):

| Vaka | Düzeltme | Gerekçe (araç çıktısı) |
| --- | --- | --- |
| tr-017 | Grup: `rota_task_detail` + `rota_task_search` | Görev araması her görev için `targetFinish`, `plannedFinish` ve `progressPercent` döndürür; soru tam olarak bunları sorar |
| tr-029 | Grup: `rota_project_detail` + `rota_project_search` | Proje araması eşleşen projenin `lead` alanını döndürür; soru proje liderini sorar |
| tr-043 | Grup: `rota_workload_summary` + `rota_task_analytics` | Analitik açık durum süzgeci ve `groupBy: assignee` ile görünür sorumluları süzülen sayıya göre azalan sıralar; en çok açık işi olan kişi ilk gruptur |
| tr-045 | Grup: `rota_workload_summary` + `rota_task_analytics` | Analitik `personSicil` süzgeciyle o kişinin görevlerinde açık, devam eden, gecikmiş, bugün/7 gün içinde terminli ve tamamlanan sayıları, gecikme yaşlandırmasını ve saat kapsamasını döndürür; "iş yükü ne durumda" sorusunu tek başına yanıtlar (tr-047 ile aynı gerekçe). Kişi kimliği için arama her iki araçta da planlayıcı önkoşuludur, ihtiyaç değildir |

Doğrulanıp **değiştirilmeyenler**: adı geçen görev/proje/kişi için arama aracını
önkoşul olarak isteyen öneriler (yukarıdaki `needs` kuralı); proje sıralamasında görev
analitiği (durum süzgeci çok değerlidir, gruplar süzgeçten geçen sayıya göre
azalan sıradadır); onay bekleyen talep varlığında bildirimler (bildirimler
`awaitingYourDecision` sayısını döndürür); görevi açan kişide görev ayrıntısı
(`createdBy` döndürür); tek grupta birbirinin yerine geçen araçlar.

### 6.5 Belirlenimci sınama ikizleri ve CI

`test/helpers/semanticModelDoubles.mjs` gömme ve yeniden sıralama ikizleri
model DEĞİLDİR: metni yorumlamaz, testin sabit eşlemesini (metin → vektör,
sorgu + belge → skor) döndürür ve sıraya konmuş davranışı uygular (bozuk
yanıt, hata, sinyale uyan ve uymayan takılma). Kâhin ikiz altın etiketlerden
vektör kurar ve yalnızca değerlendiricinin kendisini sınar.

CI çevrimdışı ve belirlenimcidir; model indirmez, Hugging Face'e ya da
Python'a bağlı değildir. Uygulama başlangıcı da model indirmez. Python
koşucusunun kendi sınaması (`test/semantic_model_qualification_test.py`,
yalnızca standart kitaplık; model yerine yüklendiğini bildiren saplama
modüller) CI'da koşmaz; koşucu değiştiğinde elle çalıştırılır:
`python3 test/semantic_model_qualification_test.py`.

### 6.6 Gerçek model nitelendirme mekanizması

Gerçek modeller CI'da çalışmaz; nitelendirme bilinçli olarak elle yapılır:

```bash
node scripts/semantic-evaluation.mjs input --out girdi.json
python3 scripts/semantic-model-qualification.py --input girdi.json --output kosu.json \
  --embedding-model intfloat/multilingual-e5-large \
  --query-prefix "query: " --document-prefix "passage: " --preprocessing e5-query-passage \
  --reranker-model BAAI/bge-reranker-v2-m3
node scripts/semantic-evaluation.mjs report --run kosu.json   # --json ile makine okunur özet
```

- Python koşucusu (`pip install sentence-transformers`) yalnızca ham çıktıyı
  (vektörler, skorlar, koşucunun ölçtüğü gecikme) yazar; sorgu vektöründe ya
  da yeniden sıralama skorunda sayı olmayan ya da sonlu olmayan değer `null`
  olur ve raporda geçersiz sayılır. Koşu dosyası modele **gerçekten verilen** belge ve sorgu
  metnini, etkin `queryPrefix`/`documentPrefix` öneklerini ve `batchSize`
  değerini de taşır.
- **Ön koşullar model yüklenmeden denetlenir** (pahalı koşunun sonunda
  reddedilecek değer başta durdurulur): girdi dosyası var, okunur ve kapalı
  şemadadır (üst düzey alanlar, belge `{id, text}`, sorgu `{case, text}`;
  bilinmeyen alan yok; sürüm tam sayı 1; parmak izleri 64 onaltılık
  karakter); belge ve vaka kimlikleri raporun biçiminde ve **tekil**; en çok
  256 belge ve 150 sorgu (katalog ve kıyas kümesi sınırı); metinler boş değil,
  belge metni en çok 4000, sorgu metni en çok 2000 karakter. Raporla aynı
  sınır aynı ölçüyle denetlenir: Node `.length` UTF-16 kod birimi saydığı
  için koşucu önek, `--device` ve metin uzunluğunu da UTF-16 kod birimiyle
  ölçer (`😀` iki birimdir). Çıktı yolu klasör değil, klasörü var ve yazılabilir (geçici dosya
  burada gerçekten ayrılır, `os.access` tahminine dayanılmaz); çıktı girdiyle
  aynı dosya değil (farklı yazım, Windows büyük/küçük harf, kısa ad, sembolik
  ya da sabit bağ: `realpath`/`normcase` ve `os.path.samefile` ile); ön işleme
  belirteci ve önekler tutarlı; `--batch-size` 1–4096; kayda yazılacak gömme
  ve yeniden sıralama model kimliği ile sağlayıcı, raporun model belirteci
  biçiminde (`[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}`). Model yolu ile kimliği
  ayrıdır: yerel klasördeki ya da Windows yolu (`C:\modeller\...`) olan model
  `--embedding-name`/`--reranker-name` ile kayıttaki kimliğiyle adlandırılır;
  yol herhangi bir biçimde olabilir, kayda yazılan kimlik belirteç biçimindedir.
  Ön koşul reddi diske dokunmaz (önceki çıktı da yerinde kalır).
- **Sayı sözleşmesi:** koşucu model çıktısını sayıya **çevirmez**, yalnızca
  zaten sayı olanı kabul eder: Python `int`/`float` ve NumPy sayısal skalerleri
  (`numbers.Real`); `bool` ve NumPy `bool_`, sayısal metin (`"1"`) ve başka
  nesne sayı değildir. Böylece Node sözleşmesinin (`typeof x === 'number'`)
  reddedeceği bir yanıt koşucuda geçerli sayıya dönüşüp nitelendirilemez.
- Güvenilirlik: model yükleme ve **katalog gömme** hatası ölümcüldür. Her
  belgenin tam bir vektörü olmalı; boyut 1–8192 ve hepsinde aynı, bütün
  değerler yukarıdaki anlamda sayı ve sonlu, sıfır vektör yok. Değilse koşu
  dosyası yazılmaz (NaN `null`'a çevrilip başarılı görünen bir dosya
  üretilmez). Tek bir sorgunun gömme ya
  da yeniden sıralama hatası `INFERENCE_FAILED` koduyla kaydedilir (hata
  iletisi yazılmaz); tek sorguya tam bir vektör dönmemesi de bu hatadır (fazla
  vektörün ilki sessizce alınmaz). Rapor o vakayı `failed` ıskası sayar,
  tamamlanan ölçümler korunur. İş başlarken sıra bilinçlidir: önce eski çıktı
  silinir, sonra geçici dosya ayrılır, sonuç atomik olarak yerine konur. Eski
  çıktı silinemezse (Windows'ta başka programda açık, salt okunur ya da erişim
  reddi) koşucu açık bir iletiyle durur ve bu denemenin geçici dosyası hiç
  oluşmamıştır; iş başladıktan sonraki her hata geçici dosyayı siler. Böylece
  başarısız deneme ne eski koşuyu yeni gibi ne de `.semantic-run-*.tmp`
  bırakır. Geçici dosya `mkstemp` ile oluşur; POSIX'te koşu dosyası sahibine
  özeldir (0600). Bu bilinçlidir: kabul ortamı §9'daki Windows VM'dir;
  koşu dosyasını başka bir POSIX hesabıyla paylaşan iş akışı sözleşmede yoktur. Özet satırı ASCII'dir ve stdout
  yazılamayan karakterde düşmez (Windows kod sayfası).
- `report` ham koşuyu güvenilmez girdi olarak bir kez doğrular: kapalı şema
  (bilinmeyen alan reddedilir); biçim/sürüm ve parmak izleri; model kökeni;
  önekler ile ön işleme belirtecinin tutarlılığı (önek varsa belirteç onu
  adlandırır, yoksa `none`); belge, sorgu, yeniden sıralama ve skor satırları
  katalog kimlikleri ve kıyas vakalarıyla **birebir** aynı küme (eksik, fazla,
  yabancı ya da yinelenen satır reddedilir); satırdaki metin girdideki metnin
  aynısı (değiştirilmiş metin puanlanmaz); gecikmeler sonlu ve negatif değil;
  ortam künyesi sınırlı; `batchSize` 1–4096. Sonra aynı çıktıyı üretimdeki
  sözleşme ve koşucudan geçirir; bozuk sorgu değeri ıska sayılır.
- Yeniden oynatım kimlikle eşler, metinle değil: katalog açıklamalarının
  tekil olması gerekmez. Belge vektörleri katalog sırasıyla (konum → kimlik)
  verilir. Yeniden sıralayıcıya yalnızca metin gittiği için aynı metinli
  adaylar metinden ayırt edilemez; adayların kimliği koşucunun ilk aşamasıyla
  aynı belirlenimci sıralamadan (aynı dizin ve sorgu vektörü) yeniden kurulur
  ve skor o kimliğin kayıttaki skorudur.
- Katalog dizini kurulamayan koşu (sonlu olmayan, sıfır ya da farklı boyutlu
  belge vektörü) **nitelendirme değildir**: `report` hata koduyla durur, sıfır
  ölçülü başarılı görünen rapor üretmez.
- Yeniden sıralama satırı **bütün katalogun** skorlarını taşır ve bütünüyle
  doğrulanır: her skor var, sayı ve sonlu olmalıdır; değilse o çağrı
  `invalid`'dir. Geçerlilik raporun `--limit` değerine bağlı değildir (aday
  sınırının dışındaki bozuk skor da çağrıyı geçersiz kılar).
- Sonuç türü ve gecikme aynı nüfusu anlatır: koşucunun gerçekten yaptığı
  çağrılar. Sorgu gömmesi her vaka için bir çağrıdır. Koşucu yeniden
  sıralayıcıyı sorgu gömmesinden bağımsız olarak her vakada çağırdığı için
  yeniden sıralama sonuç türleri ve gecikmesi ham satırlardan sayılır (sorgu
  gömmesi başarısız olan vakada da). Kalite ölçüleri ise yeniden oynatımdan
  gelir: gömmesi başarısız vaka sıralanmaz ve ıskadır; yeniden sıralaması
  geçersiz ya da başarısız vaka ilk aşama sırasını kullanır.
- Markdown raporu bir görüntüleme sınırıdır: koşu dosyasından gelen metin
  (model, sağlayıcı, çalışma ortamı, önekler, ortam künyesi) veri olarak
  yazılır; satır sonu ve denetim karakteri boşluk olur, Markdown işaretleri
  (ters eğik çizgi, ters tırnak, `*`, `_`, `[`, `]`, `<`, `>`, `|`, `#`) kaçışlanır, böylece kayıt başlık ya da tablo
  kuramaz. `--json` çıktısı doğrulanmış özgün değerleri taşır.
- `--limit` (varsayılan 10) en derin ölçü kesiminden (5) sığ, 20'den derin
  olamaz.
- `--json` çıktısındaki `qualification` künyesi sonucu yeniden üretmek için
  gerekeni taşır: koşu biçimi ve sürümü, kıyas kümesi ve katalog parmak izi,
  gömme modeli, sağlayıcı, ön işleme belirteci, etkin sorgu ve belge önekleri,
  çalışma ortamı sürümleri, yeniden sıralayıcı (model, sağlayıcı, çalışma
  ortamı) ya da `null`, aday sınırı (`limit`), kesimler, gecikme iş yükü
  (katalog gömme ve yeniden sıralama `batchSize` dâhil: toplu iş boyutu
  ölçülen gecikmeyi değiştirir) ve ortam (cihaz, iş parçacığı, çekirdek,
  Python, platform). Sistemin bütün değişkenleri kaydedilmez; yalnızca ölçülen
  iş yükünü değiştiren yapılandırma kaydedilir.
- Gecikme iş yükü açıkça yazılır: katalog gömme tek çağrıda bütün belgeler;
  sorgu gömme çağrı başına tek sorgu; yeniden sıralama çağrı başına **bütün
  katalog** (kayıttaki yeniden sıralayıcılar noktasaldır). Kalite ölçüleri ise
  ilk aşamanın ilk `limit` adayının bu skorlarla yeniden dizilmesinden gelir;
  rapor bu farkı gecikmenin yanında yazar. Gecikme nüfusu kıyas kümesinin
  vakalarıdır (başarısızlar dâhil).

---

## 7. Aşama 4B'de uygulananlar (UYGULANDI)

### 7.1 Üretimdeki keşif akışı — `src/server/ai/semanticRetrieval.js`

```
retrieveSemanticCandidates({ query, signal })
  → normalizeSemanticQuery (4A)                 boş/uzun sorgu: model çağrılmaz
  → sunucuya ait katalog (Aşama 3 araç kayıt defteri, 19 araç; 4A)
  → profil kullanılabilirliği (kayıt; ağ geçidi çağrılmaz)
  → ağ geçidi embedTexts(query)  → `embedding` profili, `query` öneki
  → süreç içi dizin (yoksa tek uçuşla: embedServerCatalogue() → `passage` öneki → createSemanticIndex)
  → rankSemanticIndex: ilk aşama, en çok 10 aday (4A)
  → ağ geçidi rerankTexts(sorgu, 10 adayın açıklaması) → `rerank` profili
  → applyRerankScores (4A): yalnızca aynı adayların permütasyonu
  → { status: reranked | first_stage | unavailable, candidates, failure }
```

Aday yalnızca `id`, `kind`, `rank`, `similarity` ve (yeniden sıralandıysa)
`relevance` taşır. Doğrulama, kosinüs, eşitlik ve aday kümesi kuralı
yalnızca 4A sözleşmesindedir; hizmet ikinci bir doğrulama yazmaz. Sonuç
sunucu içinde kullanılır, istemciye gönderilmez.

**Kapsam sınırı.** 4B adayları üretir; 4C'de tek üretim çağıranı
`semanticPlanning.js` bunları planlayıcıya yalnızca danışmanlık olarak verir
(§12.1; sınamayla korunur). Asistan servisi bu sınırı kullanır.
Kimlik, yetki, görünürlük, SQL, kanıt ve yanıt üretimi değişmez.

İlk aşama derinliği (`SEMANTIC_RETRIEVAL_DEPTH = 10`) değerlendirmenin aday
sınırıyla (`SEMANTIC_EVALUATION_DEFAULTS.limit`) aynıdır (sınamayla bağlı):
ölçülen ile üretimdeki aynı derinliktir. 19 öğelik katalogda 10 aday hem
Recall@5/NDCG@5 kesimlerini kapsar hem de yeniden sıralayıcının işini
yarıya indirir. Değer sabittir; isteğe göre değişen "topK" yoktur.

### 7.2 Profil çözümü ve ön işleme

İş kodu model adı bilmez: `embedding` ve `rerank` profilleri model kaydından
çözülür. Gömme modelinin belgelenmiş ön işlemesi kayıttaki modelin
`preprocessing` alanıdır (yalnızca gömme modelinde; kapalı alan kümesi):

```json
{ "id": "intfloat/multilingual-e5-large", "capabilities": ["embedding"], "contextTokens": 512,
  "preprocessing": { "id": "e5-query-passage", "queryPrefix": "query: ", "documentPrefix": "passage: ", "truncateTokens": 512 } }
```

- `id` önekleri adlandıran belirteçtir ve gömme uzayının kimliğine girer
  (§6.1); önek varsa `none` olamaz, önek yoksa `none` olmalıdır (nitelendirme
  raporuyla aynı kural). Önek en çok 200 karakterdir ve kırpılmaz (satır sonu
  dâhil: ör. Qwen3-Embedding sorgu yönergesi).
- Alan **yoksa** ön işleme yoktur (`none`). Yazılmış her değer doğrulanır:
  `"preprocessing": null`, `null` önek ya da `null`/0/kesirli/metin
  `truncateTokens` kayıt hatasıdır; geçersiz değer gömme uzayını sessizce
  değiştiremez (sohbet modelinde alanın kendisi hatadır).
- **Belirteç penceresi.** Karakter sınırı (sorgu 2000, belge 4000) belirteç
  penceresini kanıtlamaz ve ağ geçidi belirteç SAYMAZ (belirteçleyici uçtadır).
  Kural açıktır ve kayıttadır: `truncateTokens: N` varsa uç, önekli metni
  belirteçlere ayırır ve pencereyi aşan girdiyi **önek ve özel belirteçler
  korunarak N belirtece** sınırlar — istek yalnızca `truncate_prompt_tokens: N`
  taşır. `truncation_side` gönderilmez: vLLM 0.31.0
  `vllm/renderers/params.py` içindeki `get_encode_kwargs`, açık yön verilirse
  belirteçleyici kesmesini kapatır; sonradan dizi kesmek E5 kapanış belirtecini
  düşürebilir. E5 belirteçleyicisinin varsayılan sağ yönü kullanılır.
  Alan yoksa kesme istenmez ve pencereyi aşan
  girdiyi uç reddeder (vLLM 400): sorgu için `unavailable`/`rejected`, sunucuya
  ait katalog belgesi için `configuration` (`PROVIDER_REJECTED_FIXED_REQUEST`).
  `truncateTokens`, modelin `contextTokens` değerini aşamaz. Kesme yalnızca
  pencereyi aşan girdiyi değiştirir; değeri dizinin anahtarına girer (§7.4),
  sorgu, katalog ve `live` nitelendirmesi aynı kuralla gömülür. Gerçek katalogun
  en uzun belgesi önekle 369 bayttır, kıyas sorularının en uzunu 84
  karakterdir: olağan girdiler pencerenin çok altındadır; kesme yalnızca uzun
  kullanıcı sorularında devreye girer.
- Kurum içi kayıt ve varsayılan kayıt
  `intfloat/multilingual-e5-large` için E5'in belgelenmiş `query: ` /
  `passage: ` öneklerini ve 512 belirteçlik pencereyi (`contextTokens`,
  `truncateTokens`) taşır; önekler nitelendirme komutundaki
  (`--query-prefix "query: " --document-prefix "passage: " --preprocessing
  e5-query-passage`) aynısıdır. Çevrimdışı koşucu (sentence-transformers)
  modelin kendi `max_seq_length` değeriyle (E5: 512) sağdan keser.
- **Uçun bildirdiği model adları** (`reportedModels`, isteğe bağlı): vLLM
  yanıtta, istekte hangi takma ad kullanılmış olursa olsun her zaman ilk
  `--served-model-name` değerini bildirir. Kayıttaki kimlik o ad değilse
  gömme ya da yeniden sıralama modeli bu adları açıkça listeler:
  `"reportedModels": ["e5-large"]`. Yalnızca gömme/yeniden sıralama modelinde,
  1–8 tekil ad, joker yok, modelin kendi kimliği ve kayıttaki başka bir modelin
  kimliği ya da adı olamaz. Köken (uzay) yine kayıttaki kimliktir. En basit
  kurulum kayıttaki kimliği vLLM'in ilk `--served-model-name` değeriyle aynı
  tutmaktır; o durumda alan gerekmez.
- Önek TEK yerde eklenir: ağ geçidinin `embedTexts` işlemi, amaca (`query` |
  `document`) göre. Yeniden sıralayıcıya önek eklenmez (koşucuyla aynı).
- `Qwen3-Embedding-8B` gibi başka bir modele geçilirse modelin belgelenmiş
  sorgu yönergesi bu alana yazılmalı ve belirteç değiştirilmelidir; önce §6.6
  ya da §7.8 ile ölçülür.

### 7.3 Model sınırı: bağdaştırıcı ve ağ geçidi

Bağdaştırıcı (`openAiCompatibleProvider.js`) iki işlem ekler; tel biçimi
vLLM 0.31 kaynağındaki OpenAI uyumlu gömme ve Cohere/Jina uyumlu yeniden
sıralama sözleşmesiyle doğrulandı:

| İşlem | İstek | Yanıt → sözleşme biçimi |
| --- | --- | --- |
| `embeddings` | `POST {base}/embeddings` `{ model, input: [...], encoding_format: "float" }` (+ yalnızca `truncate_prompt_tokens`, `truncateTokens` varsa) | `data[{ index, embedding }]` → `[{ index, vector }]` |
| `rerank` | `POST {base}/rerank` `{ model, query, documents: [...], top_n: n }` | `results[{ index, relevance_score }]` → `[{ index, score }]` |

- Bağdaştırıcı yalnızca zarfı doğrular (dizi değilse
  `EMBEDDING_RESPONSE_INVALID` / `RERANK_RESPONSE_INVALID`; sayı olmayan
  model kimliği de); değerleri çevirmez, düzeltmez, sıralamaz. Sayı, dizin,
  boyut, sonluluk ve aday kümesi 4A sözleşmesinde doğrulanır. Hata gövdesi
  okunmaz; HTTP durumu var olan eşlemeyle koda iner.
- Gömme yanıtının okuma sınırı girdi sayısıyla ölçeklenir (1 MiB + girdi
  başına 8192 × 32 bayt; JSON'daki en uzun kayan nokta yazımı 24 karakter +
  ayraç): 4096 boyutlu bir modelin 19 belgelik katalog gömmesi (~1,7 MB) sabit
  1 MiB sınırına takılmaz. Girdi sayısı sözleşmenin en büyük kataloğuyla (256)
  sınırlıdır: bütçe hiçbir istekte 65 MiB'ı aşmaz; gerçek katalog için ~5,75
  MiB, sorgu için 1,25 MiB'tır. Bütçeyi aşan yanıt okunurken kesilir ve
  ayrıştırılmaz. Çok girdili tek çağrı katalog kurulumudur ve anahtar başına
  tek uçuştur. Yeniden sıralama 1 MiB'tır.
- Ağ geçidi (`embedTexts`, `rerankTexts`) sohbetle aynı sırayı uygular:
  açık SQL işlemi reddi → güvenilir Sicil → rehber üyeliği → yapılandırma →
  girdi sınırları → profil ve yetenek → kapasite kirası (modelin
  `maxConcurrency` sınırı dâhil) → süre sınırı (profilin `timeoutMs` ya da
  genel sınır) → kimlik bilgisi → sağlayıcı → telemetri; kira ve süre sınırı
  her yolda bırakılır.
- **Sunucuya ait katalog belgesi** yalnızca `embedServerCatalogue` ile gömülür;
  metinler ağ geçidinde sabit sunucu araç kaydından üretilir, çağırandan alınmaz.
  Yanıt, gerçekten gömülen katalogun parmak izini taşır; hizmet kendi kataloguyla
  eşleşmezse vektörleri `stale`/`SPACE_MISMATCH` ile reddeder, dizine almaz.
  `embedTexts` içindeki `purpose: document` yalnızca öneki seçer; kullanıcı
  doğrulamasını, payını, anahtarını ya da hata sınıfını değiştirmez. Paylaşılan
  katalog işi kullanıcı rehberine yeniden başvurmaz; her çağıran kendi sorgu
  gömmesinde ve yeniden sıralamasında bağımsız doğrulanır. Katalog işi sunucu
  kapasite anahtarı (küresel ve model sınırları geçerli; insan başına etkin/sıra
  sınırları uygulanmaz) ve **kurumsal anahtar**
  (`MERGEN_ROTA_AI_DEFAULT_API_KEY`) ile
  yürür. Kurulumu hangi kullanıcı başlatırsa başlatsın onun kişisel anahtarı,
  kotası, iptal edilmiş anahtarı ya da dolu kullanıcı payı paylaşılan dizini
  düşüremez ve katalog gömmesi ona faturalanmaz. Kurumsal anahtar yoksa
  kurulum `AI_CONFIGURATION_ERROR` (`DEFAULT_KEY_REQUIRED`) ile düşer; kişisel
  anahtara geçilmez. Kullanıcı sorgusu (sorgu gömmesi, yeniden sıralama)
  kullanıcının kendi kimliği, payı ve anahtarıyla yürür.
- Girdi sınırları: gömme 1–256 metin, her biri 1–4000 karakter, amaç
  `query`/`document`; yeniden sıralama sorgu 1–2000 karakter, 1–20 aday.
  Aşan istek sağlayıcıya ve kapasiteye ulaşmadan `AI_REQUEST_INVALID`.
- Yineleme sohbettekiyle aynı, bilinçli olarak dar kuraldır: yalnızca
  isteğin sağlayıcıya HİÇ ulaşmadığı bağlantı hatası, bir kez, aynı süre
  sınırı içinde. Gömme ve yeniden sıralama yan etkisiz olsa da 5xx, süre
  aşımı, bozuk çıktı, 4xx ve iptal yinelenmez: pahalı model işi çoğaltılmaz,
  bozuk çıktı yinelemeyle düzelmez.
- Sağlayıcı yanıtta model bildirir ve bu kayıttaki model ya da onun için
  açıkça listelenmiş adlardan (`reportedModels`, §7.2) biri değilse yanıt
  `AI_PROVIDER_RESPONSE_INVALID` (`MODEL_MISMATCH`) ile reddedilir: başka
  modelin vektörü bu uzaya ait değildir. Model bildirilmezse kabul edilir.
- Sunucuya ait katalog belgesinin 400/413/422 reddi yapılandırma hatasıdır
  (`PROVIDER_REJECTED_FIXED_REQUEST`); kullanıcı sorgusunu taşıyan istek
  (sorgu gömmesi, yeniden sıralama) için `AI_REQUEST_INVALID` kalır.

### 7.4 Dizin yaşam döngüsü

- Katalog dizini **süreç içinde** tutulur (`globalThis` üzerinde tek keşif
  örneği); kalıcılık, veritabanı tablosu, göç ya da vektör veritabanı yoktur.
  Bellekte en çok bir görünür dizin ve anahtar başına bir süren kurulum vardır
  (19 × boyut). Sorgu, sorgu vektörü ya da kullanıcı verisi saklanmaz.
- Yeniden kullanım anahtarı: katalog parmak izi, gömme uzayı (4A: sözleşme
  sürümü + profil + model + sağlayıcı + ön işleme belirteci) ve ön işlemenin
  kendisi (önekler, `truncateTokens`). Açıklama, sürüm, sıra, model,
  sağlayıcı, belirteç, önek ya da pencere değişirse dizin yeniden kurulur
  (belirteç aynı kalıp yalnızca önek ya da pencere değişirse 4A kimliği aynı
  kalır ama anahtar dizini yine yeniler). Yeniden sıralama modelinin
  değişmesi dizini bayatlatmaz.
- **Boyut geçişi:** boyut 4A dizin kimliğinin parçasıdır. Uç aynı uzayda
  geçerli ama farklı boyutta vektör döndürmeye başlarsa hazır dizinle sıralama
  4A `DIMENSION_MISMATCH` verir; bu durumda dizin **istek başına bir kez**
  yeniden kurulur (tek uçuş geçerli). Hazır dizin yalnızca yeni kurulum
  başarıyla bitince değişir: kurulum düşerse geçerli dizin görünür kalır.
  Yeniden kurulan dizinle de uyuşmuyorsa bozuk olan sorgudur
  (`embedding`/`invalid_output`). Aynı anahtarda süren bir kurulum varsa
  uyuşmayan istekler onu bekler (eşzamanlı geçişte `unavailable` dönmez);
  YENİ bir yeniden kurulum ise anahtar başına en çok
  `SEMANTIC_DIMENSION_REBUILD_COOLDOWN_MS` (60 sn) aralıkla başlatılır: farklı boyutlu arka uçları karıştıran bir uç her
  istekte kataloğu yeniden gömdüremez. Zamanlar anahtar başına tutulur; süresi
  dolan kayıtlar budanır. En çok 256 yaşayan kayıt tutulur; tablo doluyken
  mevcut bekleme süreleri silinmez, yeni anahtarın yeniden kurulumu bekler.
  Gerçek bir boyut geçişinde danışmanlık
  süreç yeniden başlatılmadan, en geç bu sürede döner.
- Kurulum **anahtar başına tek uçuştur**: aynı anahtardaki eşzamanlı istekler
  tek katalog gömmesini paylaşır; arada başka anahtar istense de süren kurulum
  izlenir (A → B → A ikinci A kurulumu açmaz). Dizin yalnızca 4A
  doğrulamasından tamamen geçtikten sonra ve yalnızca **en son istenen
  anahtara** aitse görünür olur; başka anahtarın geç biten kurulumu kendi
  bekleyenlerine hizmet eder ama görünür dizini değiştirmez.
- Kurulum **tek bir çağıranın iptaline bağlı değildir**: iptal eden çağıran
  yalnızca kendi beklemesinden çıkar; kurulum öteki bekleyenler ve sonraki
  istekler için sürer. Kurulum ağ geçidinin süre ve sıra sınırıyla her
  zaman sonuçlanır (askıda söz kalmaz). Katalog sunucuya aittir: kurulum
  sunucu kapasite anahtarı ve kurumsal anahtarla yürür (§7.3), kullanıcı
  verisi taşımaz. Zaten iptal etmiş çağıran için kurulum başlatılmaz.
- Başarısız kurulum (bozuk çıktı, süre aşımı, hizmet hatası, kurulum
  sırasında değişen rota → `stale`/`SPACE_MISMATCH`) **önbelleğe girmez**:
  bekleyenler danışmansız kalır, sonraki istek yeniden kurar. Görünür dizin
  bozulmaz.
- **Yeniden yükleme sözleşmesi:** model kaydı süreç başına bir kez yüklenir;
  kayıt değişikliği Rota'nın yeniden başlatılmasıyla geçerli olur ve dizin
  yeni süreçte yeniden kurulur. Aynı süreçte rota değişirse (sınamalardaki
  gibi) yukarıdaki kimlik denetimi eski dizini reddeder. Sıcak yeniden yükleme
  iddia edilmez.

### 7.5 Sonuç ve başarısızlık davranışı

Başarısızlık danışmanlığın kaybıdır, hata değildir; uydurulmuş skor,
keyfî aday, boş araç kataloğu ya da gevşeyen yetki yoktur. `failure` evre
(`query`, `catalogue`, `embedding`, `index`, `rerank`), sınıf ve güvenli kod
taşır.

| Durum | Sonuç | Sınıf |
| --- | --- | --- |
| Gömme + yeniden sıralama başarılı | `reranked`: 10 adayın yeniden sıralanmış permütasyonu | — |
| Yeniden sıralama profili kapalı ya da tanımsız | `first_stage`: doğrulanmış ilk aşama, `relevance` yok; ağ geçidi çağrılmaz | `disabled` |
| Yeniden sıralama 5xx / ağ / süre aşımı / 429 / 404 / 400 | `first_stage` | `provider` / `timeout` / `capacity` / `configuration` / `rejected` |
| Yeniden sıralama çıktısı bozuk (eksik/fazla/yabancı/yinelenen dizin, NaN, ±Infinity, metin skor, zarf, başka model) | `first_stage` | `invalid_output` |
| Gömme profili kapalı ya da tanımsız; yapay zekâ kapalı | `unavailable`; ağ geçidi çağrılmaz | `disabled` |
| Yapılandırma ya da model kaydı geçersiz; kurumsal anahtar yokken katalog kurulumu (`DEFAULT_KEY_REQUIRED`) | `unavailable` | `configuration` |
| Sorgu gömmesinin hizmet hatası (sağlayıcı yok, 5xx, ağ, süre aşımı, kapasite) | `unavailable`; hazır dizine dokunulmaz | sınıfına göre |
| Sorgu vektörü bozuk (sayı, NaN, ±Infinity, sıfır, metin, mantıksal değer, yabancı dizin; yeniden kurulumdan sonra da uyuşmayan boyut) | `unavailable` | `invalid_output` (`embedding`) |
| Sorgu pencereyi aşıyor ve kayıtta `truncateTokens` yok (uç 400) | `unavailable` | `rejected` |
| Katalog gömmesi bozuk ya da kurulamadı | `unavailable`; önbelleğe girmez | `invalid_output` / hizmet sınıfı (`index`) |
| Kurulum sırasında rota değişti | `unavailable` | `stale` (`SPACE_MISMATCH`) |
| Boş ya da 2000 karakteri aşan sorgu | `unavailable`; model çağrılmaz | `query` |
| Araç kayıt defteri geçersiz (boş, yinelenen ad, boş açıklama) | `unavailable`; keyfî aday yok | `catalogue` |
| Çağıranın iptali (her evrede) | `AI_CANCELLED` fırlar; ilk aşamaya düşülmez | — |
| Sağlayıcı anahtar hatası (`AI_KEY_INVALID`, `AI_UNAUTHORIZED`, `AI_KEY_MISSING`), her evrede | Yukarı taşınır; danışmanlık kaybına çevrilmez | — |
| İç hata: açık SQL işlemi içinde çağrı (`AI_INTERNAL_ERROR`/`SQL_TRANSACTION_ACTIVE`), programlama ya da değişmez ihlali | Yukarı taşınır; model çağrılmaz, danışmanlık kaybına çevrilmez | — |
| Kimlik/rehber hatası, yapay zekâ dışı hata | Yukarı taşınır (danışmanlık kaybına çevrilmez) | — |

Danışmanlık kaybına yalnızca ortak hata kataloğunun **beklenen** model/hizmet
sonuçları çevrilir (`AI_DISABLED`, `AI_CONFIGURATION_ERROR`,
kapasite, süre aşımı, sağlayıcı, bozuk yanıt, `AI_REQUEST_INVALID`). Bu
tablonun dışındaki her kod (ör. `AI_INTERNAL_ERROR`) hata iletisine bakılmadan
yukarı taşınır. Sağlayıcı anahtar hataları da yukarı taşınır; Rota turu hata verir.

Çağıran (4C, `semanticPlanning.js`, §12.1) `unavailable` sonucunda Aşama 3
planlama davranışıyla sürer; kimlik, yetki ve anahtar hatalarını dönüştürmez.

### 7.6 İptal, süre sınırı ve eşzamanlılık

- Çağıranın sinyali ağ geçidine geçer: sıradaki istek sıradan çıkar, süren
  sağlayıcı isteği kesilir (HTTP bağlantısı kapanır), kira hemen bırakılır.
- Ağ geçidi sonucu geldikten sonra ama sonuç döndürülmeden iptal gelirse de
  sonuç uygulanmaz (`AI_CANCELLED`). Yeniden sıralama sırasında iptal ilk
  aşamaya çevrilmez.
- Süre sınırı ağ geçidinindir (profilin `timeoutMs` ya da
  `MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS`); keşif ayrı zamanlayıcı kurmaz.
- Gömme ve yeniden sıralama çağrıları sohbetle aynı kapasite denetimine
  girer (küresel, kullanıcı başına ve modelin `maxConcurrency` sınırı); ayrı
  semafor yoktur. Bir keşif istek başına en çok bir kira tutar (çağrılar
  sıralıdır); katalog kurulumu kendi kirasını kullanıcı payından değil sunucu
  kapasite anahtarından alır (küresel ve model sınırları yine geçerlidir).
- Eşzamanlı olmayan bir CPU döngüsünün zorla kesilmesi kapsam dışıdır (§6.3):
  model sınırı ağ üzerindedir ve eşzamansızdır.

### 7.7 Telemetri ve gizlilik

- Ağ geçidi işlemleri: `ai.request` (profil `embedding`/`rerank`),
  `ai.provider.embeddings`, `ai.provider.rerank`; sağlayıcı sağlığı ve hizmet
  hatası günlüğü sohbetteki kurallarla.
- Keşif: `ai.semantic.retrieve` işlemi ve süreç özeti (`semantic`): durum
  sayıları (`reranked`, `first_stage`, `unavailable`, `cancelled`), evre ×
  sınıf başarısızlık sayıları, dizin kullanımı (`hit`, `built`, `shared`),
  gecikme yüzdelikleri, son başarısızlık. `AI_SEMANTIC_DEGRADED` günlüğü
  yalnızca ağ geçidinin görmediği kusurlar içindir (sözleşmenin reddettiği
  model çıktısı, bayat dizin, geçersiz katalog ya da yapılandırma); ağ geçidi
  hataları ikinci kez yazılmaz. Bilinçli olarak kapatılmış profil ve geçersiz
  sorgu hata sayılmaz, günlüğe yazılmaz.
- `ai.semantic.retrieve` işleminin sağlık sınıfı ağ geçidinin `ai.request`
  kaydıyla AYNI kuraldır (`aiFailureServiceHealth`, ortak hata kataloğu +
  anahtar kaynağı + kapasite kapsamı): reddedilen ya da yetkisiz **kurumsal**
  anahtar (katalog kurulumunun anahtarı) herkesi etkiler, hizmet hatasıdır;
  **kişisel** anahtarın reddi ya da oran sınırı, kullanıcının kendi etkin/sıra
  sınırı, uçun reddettiği istek (`rejected`), geçersiz sorgu ve kapalı profil
  hizmet hatası sayılmaz; sağlayıcı, paylaşılan kapasite, süre aşımı,
  yapılandırma ve bozuk çıktı sayılır. Yalnızca `unavailable` sonuç sağlık
  işlemine hata olarak yazılır.
- Yazılmayanlar: sorgu, vektör, skor, katalog metni, Sicil, anahtar, model
  yükü. Model kimliği yalnızca var olan telemetri kuralının izin verdiği
  biçimde ağ geçidi kaydındadır.

### 7.8 Üretim yolundan nitelendirme

```bash
# Uygulama dizininden çalıştırılır: ortam uygulamayla aynı kaynaktan (.env.local, .env) okunur.
# Gerekenler: MERGEN_ROTA_AI_ENABLED=true, MERGEN_ROTA_AI_BASE_URL, MERGEN_ROTA_AI_DEFAULT_API_KEY,
# (varsa) MERGEN_ROTA_AI_MODEL_REGISTRY_PATH
node scripts/semantic-evaluation.mjs live            # Markdown rapor
node scripts/semantic-evaluation.mjs live --json     # makine okunur özet ve künye (stdout yalnızca JSON)
node scripts/semantic-evaluation.mjs live --queries sorular.json   # başka ifadeler, aynı altın etiketler
```

- **Ortam:** komut, `next start` ile aynı kural ve araçla (`@next/env`)
  çalışma dizinindeki `.env.production.local`, `.env.local`,
  `.env.production`, `.env` dosyalarını okur; kabukta tanımlı değer dosyadakinden
  önceliklidir. Okunan dosyanın yalnızca adı stderr'e yazılır, değerler
  yazılmaz. Ayrı bir ortam yükleyicisi yoktur.
- **Çıktı:** stdout yalnızca rapordur. Ağ geçidinin işletim günlüğü (ör.
  bağlantı hatasından sonraki `AI_PROVIDER_RETRY`) bu komut sürecinde
  stderr'e yönlendirilir; yinelenen ama başarılı bir koşunun `--json`
  çıktısı da doğrudan `JSON.parse` ile okunur.
- **Derinlik:** aday derinliği üretimdekidir (`SEMANTIC_RETRIEVAL_DEPTH = 10`).
  `live` başka bir `--limit` değerini reddeder (`--limit` `report` içindir):
  üretimde yeniden sıralayıcıya hiç gitmeyen 11.–20. adayın ölçüye girmesi
  önlenir.
- **Yeniden sıralama:** profil **bilinçli olarak kapatılmış** (`enabled:
  false`) ya da **tanımlanmamışsa** yalnızca ilk aşama ölçülür ve künyede
  `reranker: null` yazar. Bozuk eşleme (yeteneği olmayan, kapalı ya da
  bilinmeyen modele bağlı profil) ölçüm değil hatadır: kayıt yüklenemez ya da
  komut profilin nedenini yazıp durur.
- **Süre:** her çağrının dış süre sınırı ağ geçidinin en uzun meşru yaşam
  döngüsüdür: rehber denetimi (5 s) + sıra (`MERGEN_ROTA_AI_QUEUE_TIMEOUT_MS`)
  + profilin süre sınırı + 5 s sonuçlanma payı (en çok 730 s; değerlendirici
  900 s'ye kadar kabul eder). Ağ geçidinin `AI_TIMEOUT` sonucu ölçüde
  **süre aşımı** (`timeout`) olarak sayılır, genel hata olarak değil.
- **İş yükü künyesi:** `latencyWorkload` yalnızca gerçekten yapılan çağrıları
  sayar; koşu durduysa (sonuçlanmayan çağrı) çağrılmayan vakalar çağrı
  sayılmaz. Künye ayrıca gömme önekleri, `truncateTokens` ve dış süre
  sınırını (`environment.callTimeoutMs`) taşır.

- Kıyas kümesi üretimdeki yoldan geçer: kayıttaki profiller → ağ geçidi
  (kapasite, süre sınırı, dar yineleme, model eşleşmesi, önekler) → OpenAI
  uyumlu bağdaştırıcı → uç. Ölçüler 4A koşucusu ve özetiyle hesaplanır
  (başarısız çağrı ıskadır, paydadan düşmez); yeniden sıralama üretimdeki
  gibi ilk aşamanın 10 adayına yapılır. Gecikme ağ geçidi dâhil gerçek
  gecikmedir.
- Operatör komutudur: kullanıcı oturumu yoktur, kurumsal anahtar kullanılır,
  Rota verisi okunmaz; uca yalnızca sentetik sorular ve sunucuya ait araç
  açıklamaları gider. Katalog gömmesi kurulamazsa komut hata koduyla durur.
- `--queries` (`input`, `report`, `live`): `[{ "case": "tr-001", "text": "..." }]`
  her kıyas vakası için tam bir satır; metin normalleşir, altın etiketler
  değişmez, türetilen küme aynı kıyas doğrulamasından geçer (tekil metin
  dâhil) ve kendi parmak izini taşır. İfade sağlamlığını ölçmek içindir;
  türetilen küme altın veri sayılmaz ve depoya eklenmez.

### 7.9 Aşama 4B'nin bilerek yapmadıkları

- Adayları asistan turuna, planlayıcıya ya da araç seçimine bağlamak (4C);
  yanıt üretimi (4D).
- Gömme kullanılamazken anahtar sözcük, regex, eş anlamlı tablosu, bulanık
  dize eşleştirme ya da kıyas sorusuna özel kural (yasak, §4). Yedek davranış
  danışmanlığın yokluğudur.
- Vektör veritabanı, kalıcı vektör deposu, tablo ya da göç; genel önbellek
  çerçevesi; sıcak kayıt yeniden yükleme.
- Rota veritabanı satırlarının gömülmesi; kullanıcıya özgü görünürlük ya da
  veri taşıyan katalog.
- Ölçüm olmadan eşik dondurmak.

---

## 8. Ölçüm sonuçları (Aşama 4A, 4B)

Üç tür sonuç birbirinden ayrı tutulur.

**Belirlenimci sınamalar (CI).** Sözleşme, ölçü ve koşucu davranışı elle
hesaplanmış senaryolarla ve tam kıyas kümesinde kâhin ikizle doğrulanır.
Bunlar model kalitesi ölçmez.

**Gerçek kamuya açık model nitelendirmesi (17.10.2026): ÇALIŞTIRILAMADI.**

| Model | Kayıttaki rolü | Durum |
| --- | --- | --- |
| `intfloat/multilingual-e5-large` | `embedding` profilinin modeli | Denendi; geliştirme ortamının ağ politikası `huggingface.co` adresini reddetti (vekil 403), model indirilemedi |
| `bge-reranker-v2-m3` (`BAAI/bge-reranker-v2-m3`) | Katalogdaki yeniden sıralayıcı | Aynı nedenle indirilemedi |
| `Qwen3-Embedding-8B` | Katalogdaki gömme modeli | Çalıştırılmadı: ortam 15 GiB bellek, 4 çekirdek, GPU yok; 8B model pratik değil. Kurum içi kabule bırakıldı |
| `Qwen3-Reranker-8B` | `rerank` profilinin modeli | Aynı nedenle çalıştırılmadı; kurum içi kabule bırakıldı |

Mekanizmanın kendisi sınandı: koşucu, ortamda yerel olarak oluşturulan küçük,
**rastgele ağırlıklı** BERT modelleriyle (indirme yok) girdi → koşu → rapor
zinciri boyunca uçtan uca çalıştırıldı ve bayat, yinelenen ya da bozuk koşu
dosyalarının reddi doğrulandı. Yakınsama turunda koşucu, modeli taklit eden
yerel saplama modülleriyle (indirme yok) yeniden uçtan uca çalıştırıldı: sorgu
düzeyindeki gömme ve yeniden sıralama hatasının `INFERENCE_FAILED` ıskası
olması, eski çıktının silinmesi, atomik yazım, cp1252 stdout ve raporun
`qualification` künyesi doğrulandı. Son yakınsama turunda aynı saplamalarla
ön koşulların model yüklenmeden reddi (eksik çıktı klasörü, girdiyle aynı
dosya — sembolik ve sabit bağ dâhil —, geçersiz model/sağlayıcı kimliği,
yerel klasörün adsız kullanımı, toplu iş boyutu), sonlu olmayan ya da sıfır
katalog vektöründe koşu dosyasının yazılmaması, tek sorguya iki vektörün
`INFERENCE_FAILED` olması, aday sınırının dışındaki sonlu olmayan skorun
yeniden sıralama çağrısını geçersiz sayması ve Windows yolu + `--embedding-name`
ile kimlik ayrımı doğrulandı. Kök neden yakınsama turunda gerçek katalog ve
kıyas kümesiyle girdi → koşucu (NumPy `float32` döndüren saplamalar) → rapor
zinciri yeniden koşturuldu: koşu dosyası raporca kabul edildi, bütün "Fark"
hücreleri doldu, geçici dosya kalmadı; ön koşul, sayı sözleşmesi ve temizlik
kuralları `test/semantic_model_qualification_test.py` ile sınandı. Bunlar yalnızca tesisatın sınamasıdır;
anlamsal kalite hakkında hiçbir şey söylemez. Gerçek gömme/yeniden sıralama taban
çizgisi 4B'nin ilk işidir (ağ izni verilen bir ortamda §6.6 komutlarıyla ya da
kurum içinde §9 ile).

**Zayıf model uyumluluk okuması (Claude Haiku 4.5, 18.10.2026, son kök neden
yakınsama turundan sonra).** Haiku 4.5 is a weak/basic-model compatibility
proxy only. It is not an emulator of Qwen3-Next-80B-A3B-Instruct, and it
freezes no production threshold. Haiku 4.5 yalnızca bir **zayıf model / düşük
düşünmeli uyumluluk vekilidir**: kurum içindeki `Qwen3-Next-80B-A3B-Instruct`
modelinin taklidi ya da benzetimi DEĞİLDİR, Qwen'in üretim başarımı hakkında
bir şey söylemez, 4C kabul ölçütü değildir ve hiçbir eşik dondurmaz. Amaç,
katalog ve kıyas kümesinin gizli akıl yürütme olmadan anlaşılıp
anlaşılmadığını görmektir.

Kurulum: yalnızca `claude-haiku-4-5-20251001` modeline sabitlenmiş, depo
bağlanmamış ayrı bir oturum; tek tur, araç çağrısı yok (oturum kaydıyla
doğrulandı). Genişletilmiş düşünme, adım adım düşünme ya da gerekçe
istenmedi; ancak ürün düşünmesiz bir kip sunmuyor ve oturumun varsayılan
ayarı modelin yanıttan önce bir düşünme bloğu (kayda göre yaklaşık 9.600
düşünme belirteci) üretmesine izin verdi. Bu yüzden okuma tam olarak
"düşünmesiz" değildir. Modele yalnızca 19 aracın sunucuya ait açıklamaları,
üç karar türünün kısa tanımı ve sabit tohumla karıştırılmış sırada, yalnızca
sıra numarasıyla 117 soru verildi; vaka kimliği, beklenti, ihtiyaç, kaçınma,
etiket, altın araç, önceki yanıtlar, inceleme yorumları ya da zor vaka listesi
verilmedi. Yanıt, bu turun kıyas kümesi üzerinde güncel
`evaluateSemanticDecisions` ile tek geçişte puanlandı:

| Ölçü | Bu okuma | Önceki okuma |
| --- | --- | --- |
| Karar doğruluğu | 0.932 (109/117) | 0.957 (112/117) |
| `answer` geri çağırma | 0.968 (92/95) | 0.958 (91/95) |
| Açıklama doğruluğu (`recall.clarify`) | 0.286 (2/7) | 0.857 (6/7) |
| Desteklenmeyen istekte çekimserlik (`recall.abstain`) | 1.000 (15/15) | 1.000 (15/15) |
| `answer` vakalarında araç kapsaması | 0.947 (90/95) | 0.926 (88/95) |
| Yasak araç ihlali | 0 | 0 |
| Eksik / geçersiz karar | 0 / 0 | 0 / 0 |

Ayrışmalar (10 vaka) ve sınıfları:

| Vaka | Model | Sınıf | Not |
| --- | --- | --- | --- |
| tr-005 "Sorumlusu olmayan görevler hangileri?" | `rota_data_quality` | Belirsiz katalog açıklaması | Veri kalitesi yalnızca açık görevleri ve en çok beş örnek verir; görev aramasının açıklaması `assignee` süzgecini anmaz, veri kalitesininki "sorumlusuz" der |
| tr-048, tr-050 kişinin birimi/unvanı | Çekimser | Belirsiz katalog açıklaması | Kişi araması birim ve unvan döndürür; açıklaması anmıyor |
| tr-046 "Bu hafta termini dolan işler kişilere nasıl dağılmış?" | İş yükü özeti | Meşru zayıf model ıskası | İş yükü özetinde tarih süzgeci yoktur; analitik `deadline` süzgeci ve `groupBy: assignee` ile tek başına yanıtlar |
| tr-060 "Talepleri göster" | Açıklama istedi (aynı iki araç) | Meşru zayıf model ıskası (sınırda) | Ürünün Talepler ekranı iki talep türünü birlikte gösterir |
| tr-098 "Takvimi göster" | Tek yorumla yanıt (çalışma takvimi) | Meşru zayıf model ıskası | Çalışma takvimi, Outlook gönderimi ve görev takvimi gerçekten ayrı yetenekler |
| tr-099 "Ahmet ne yapıyor?" | Çekimser | Meşru zayıf model ıskası | Kişinin görevleri ve hareketleri Rota yeteneğidir; istek kapsam içidir ama okuma belirsizdir |
| tr-100 "Toplantı ne zaman?" | Çekimser | Meşru zayıf model ıskası (sınırda) | Toplantı Rota'da görev ya da tekrarlayan seri olarak bulunur; hangisi kastedildiği sorulmalıdır |
| tr-101 "Bunu kim yaptı?", tr-102 "Kaç tane var?" | Çekimser | Meşru zayıf model ıskası | Göndergesi olmayan kapsam içi istek açıklama gerektirir; çekimserlik kapsam dışı istek içindir |

Kıyas altın etiketi ya da soru kusuru bulunmadı; bu okuma yüzünden hiçbir
etiket değiştirilmedi. Bu turdaki tek etiket değişikliği (tr-045) Aşama 3
işleyicisine dayanır ve okumadan önce yapıldı; model tr-045'te iş yükü özetini
seçtiği için puanı değiştirmedi. Önceki okumayla fark büyük ölçüde açıklama
vakalarındadır: model bu kez göndergesiz kısa istekleri (tr-099–tr-102)
kapsam dışı saydı. Bu, 4C planlayıcısının açıklama/çekimserlik sınırı için
girdidir; ölçüyü iyileştirmek için kıyas kümesi ya da tanımlar
ayarlanmadı. Tek okuma; okumalar arası oynaklık ölçülmedi. Model istenen düz
JSON yerine yanıtı yine kod çitine sardı (protokol sapması, ayrışma değil);
çit soyularak puanlandı. Adı geçen varlık için arama aracını da seçmesi §6.4
kuralı gereği cezalandırılmadı. Aşama 4A bu okumaya bağlı değildir; MERGEN
Rota'da Anthropic bağlantısı, kimlik bilgisi ya da bağımlılığı yoktur.

**Aşama 4B gerçek model ölçümü (18.10.2026): ÇALIŞTIRILAMADI.** Geliştirme
ortamının ağ politikası `huggingface.co`, `hf-mirror.com`, `modelscope.cn` ve
PyTorch paket deposunu reddetti (vekil 403); kurum içi uç bu ortamdan
erişilemez; ortamda GPU yoktur. Bu yüzden ne kayıttaki modellerle
(`intfloat/multilingual-e5-large` + `Qwen3-Reranker-8B`) ne de kamuya açık
eşdeğerleriyle gerçek bir taban çizgisi, Top-1/MRR/Recall/NDCG değeri ya da
yeniden sıralama katkısı ölçülmüştür; **sayı uydurulmadı**. Deponun araç
açıklamalarını üçüncü taraf bir model barındırma ortamına göndererek ölçmek
bilinçli olarak yapılmadı.

Sınanan, üretim yolunun kendisidir: `live` komutu 117 vakayı ağ geçidi →
bağdaştırıcı → gerçek soketli yerel HTTP ikizi zincirinden geçirdi. Kâhin
uçla (belge birim vektörü, sorgu ihtiyaç adayları) iki aşamada da Top-1 =
1.000 elde edildi; katalog tek çağrıda (`passage: ` önekli 19 belge), her
vaka tek önekli sorgu gömmesi ve 10 adayın öneksiz yeniden sıralamasıyla
(117 + 1 gömme, 117 yeniden sıralama çağrısı) ölçüldü. Anlam çıkarmayan
(özetten türetilmiş) ikizle aynı zincir, model hatası olmadan uçtan uca
tamamlandı; bu sayılar model kalitesi hakkında bilgi taşımaz.

Kurum içi VM'de yapılacak ölçüm (§9): `node scripts/semantic-evaluation.mjs
live --json` (kayıttaki profiller); karşılaştırma için aynı komut
`rerank` profili kapalı kayıtla ilk aşama tabanını verir. Kamuya açık
modellerle yerel ölçüm §6.6 komutlarıyla yapılır.

**Aşama 4B düşük düşünmeli sağlamlık yoklaması (Claude Haiku 4.5,
18.10.2026, son yakınsama turu; bağlayıcı değil).** Haiku 4.5 was used as a
non-binding low-deliberation robustness probe. It is not an emulator of
Qwen3-Next-80B-A3B-Instruct and is not the Phase 4C weak-model acceptance
gate. Soru: "4B hattı, ifadeler daha zayıf ve düşük düşünmeli bir modelden
geldiğinde yapısal olarak sağlam mı?" — "Qwen3-Next-80B-A3B-Instruct 4C
kapısını geçti mi?" sorusu DEĞİL.

- Hugging Face modeli (1. seçenek) kullanılamadı: ağ politikası
  `huggingface.co` bağlantısını reddediyor, yerel model ve GPU yok. Deponun
  metinleri üçüncü taraf barındırılan Space'lere bilinçli olarak gönderilmedi.
- Kurulum: `claude-haiku-4-5-20251001` modeline sabitlenmiş, depo ve kurulum
  betiği olmayan ayrı oturum; tek tur, araç kullanılmadı. Ürün düşünmesiz kip
  sunmuyor: yanıtta bir düşünme bloğu vardı (içeriği görünmez) ve çıktı
  ~15.800 belirteçti (JSON yanıtının birkaç katı), yani yoklama "düşünmesiz"
  değildir; yalnızca düşük düşünmeli bir yaklaşıklıktır.
- Girdi yalnızca numaralı 117 soru metni ve dar dönüştürme kurallarıdır
  (anlamı, olumsuzluğu, özel adları, sayıları, kodları ve alan terimlerini
  koru; cümle türünü koru; yetki aşma/SQL isteklerini yumuşatma). Vaka
  kimliği, beklenti, etiket, araç adı ya da katalog verilmedi.
- Yapısal denetim (belirlenimci): 117/117 satır, boş yok, yinelenen yok,
  hiçbiri özgünüyle ya da başka bir özgün soruyla aynı değil; bütün metinler
  4A normalleştirmesinden geçti. Sayılar, kodlar (`MRG-24`, `RDR`, `104233`,
  `4711`, `29 Ekim`) ve `SELECT * FROM gorevler` korundu.
- Elle inceleme: 24 yeniden ifade anlam kaydırdı ve elendi — zaman ("Dün" →
  "önceki/evvelki gün", "Bugün" → "Günümüzde"), alan terimi ("bildirim" →
  "haber", "Sicil" → "numara/personel kodu", "kritik yol" → "kritik seçenek",
  "bolluk süresi (total float)" → "leyback zamanları (toplam boşluk)", "baz
  plan" → "başlangıç programı", "tekrar" → "periyot/sürüm", "hava" → "iklim"),
  karar durumu ("kararı bende olan" → "onay verdiğim") ve zaman kipi/olumsuzluk
  ("gönderilemeyen görev kaldı mı" → "iletilmemiş görev kalacak mı").
  Kabul edilen 93 yeniden ifade ve elenen satırlarda özgün metin `--queries`
  dosyası oldu. Yeniden ifadeler altın veri değildir, depoya eklenmedi.
- Önceki istek biçimiyle 4B yolundan geçiş (yerel HTTP ikiziyle, anlamsız özet
  vektörleri; mevcut istek biçiminin yoklama kanıtı değildir):
  `live --json --queries` 117/117 gömme ve 117/117 yeniden sıralama
  çağrısını `ok` tamamladı; stdout ayrıştırılabilir JSON, istekler
  o tarihte `truncate_prompt_tokens: 512, truncation_side: right` taşıdı.
  Bu istek biçimi sonradan değiştirildi; güncel kod yalnızca
  `truncate_prompt_tokens: 512` gönderir (§7.2–§7.3). Önceki iş yükü
  künyesi gerçek çağrı sayısını (117/117) yazdı; türetilen kümenin parmak izi
  özgününden farklı. Üretim `semanticRetrieval` hizmeti (gerçek ağ geçidi →
  bağdaştırıcı → HTTP) için önceki kayıt üç 117 sorguluk kümede `reranked`
  sonucu ve bir kurulumla 233 yeniden kullanım bildirmişti. Bu iki iddia
  tutarsızdır: üç tam geçiş 350 yeniden kullanım gerektirir; 233 ise iki
  geçişe karşılık gelir. Ham ölçüm raporu depoda bulunmadığından hangi
  geçişlerin yapıldığı doğrulanamıyor; geçiş ve toplam yeniden kullanım
  sayısı doğrulanmış ölçüm olarak verilmez.
- İkiz anlam taşımadığı için **hiçbir kalite sayısı (Top-1, MRR, Recall,
  NDCG, yeniden sıralama katkısı, özgün–yeniden ifade farkı) raporlanmadı**;
  bu sayılar kurum içi VM'de gerçek modellerle `live --queries` ile ölçülür.
- Sonuç: düşük düşünmeli modelin ifadeleri 4B hattında yapısal bir kırılma
  üretmedi; üretim kodu yoklamaya göre değiştirilmedi. Gözlenen anlam
  kaymaları 4C için girdidir (zayıf modelin kendi ürettiği metinlere
  güvenilmemeli).

Eşikler (ör. kabul edilebilir Recall@5 ya da çekimserlik oranı)
**dondurulmadı**: gerçek model ölçümü olmadan seçilen eşik keyfî olurdu. 4B
gömme/yeniden sıralama eşikleri kurum içi `live` ölçümünden, 4C planlayıcı
eşikleri kendi ölçümlerinden sonra dondurulur. §3'teki mutlak koşullar eşik
değildir; her zaman sıfırdır.

---

## 9. Kurum içi kabul sözleşmesi (Windows VM / ağdan yalıtılmış ortam)

Kabul, model kaydının **seçtiği** modellerle ve üretimdeki yol üzerinden
yapılır; sonuçlar aynı kıyas kümesi parmak iziyle kaydedilir ki 4A/4B taban
çizgisiyle karşılaştırılabilsin. Sıra ve ölçütler:

| # | Denetim | Ölçüt | Adım |
| --- | --- | --- | --- |
| 1 | Profil çözümü | `embedding`, `rerank`, `chat.tools`, `chat.tools.reasoning` kayıttaki etkin, yetenekli modellere çözülür | 4B, 4C |
| 2 | Uç uyumluluğu ve model erişilebilirliği | Gömme ve yeniden sıralama uçları kayıttaki model kimliğiyle yanıt verir; tel biçimi bağdaştırıcıyla eşleşir | 4B |
| 3 | Vektör biçimi | Boyut sabit ve 1–8192; değerler sonlu; sıfır vektör yok; dizin adresleri tam | 4B |
| 4 | Yeniden sıralama yanıtı | Her aday tam bir sonlu skor; yabancı/yinelenen dizin yok | 4B |
| 5 | Sıralama davranışı | Kıyas kümesinde §6.3 ölçüleri; 4A/4B taban çizgisine göre kayıt | 4B |
| 6 | Gecikme | Gömme ve yeniden sıralama p50/p95; profil süre sınırı içinde | 4B |
| 7 | Süre aşımı ve iptal | Süre aşımı ve Durdur, ağ geçidi kurallarıyla tam bir kez kaynak bırakır; anlamsal hata Aşama 3 davranışına döner | 4B |
| 8 | Toplu istek ve eşzamanlılık | Toplu gömme sırası korunur; kapasite denetimi aşılmaz | 4B |
| 9 | Türkçe anlamsal kalite | Etiket kırılımında (çekim, ASCII, yazım hatası, karışık dil) ıskalar incelenir | 4B |
| 10 | Standart model araç planlaması | Düşünme kipsiz standart modelle karar ölçüleri (açıklama, çekimserlik, araç kapsaması) | 4C |
| 11 | Derin kip davranışı | `chat.tools.reasoning` ile aynı ölçüler ve devir davranışı | 4C, 4D |
| 12 | Kanıta dayalı yanıt | Aşama 3 kanıt doğrulaması ve mutlak koşullar değişmeden geçer | 4D |

Ön işleme (ör. Qwen3-Embedding için sorgu yönergesi) modele özgüdür ve
kayıttaki modelin `preprocessing` alanına yazılır (§7.2); değişirse dizin
yeniden kurulur. 2–9 numaralı denetimlerin kabul kaydı üretimdeki yoldan
alınan `node scripts/semantic-evaluation.mjs live --json` çıktısıdır (§7.8;
uygulama dizininden çalıştırılır, `.env.local` okunur, kurumsal anahtar
gerekir, aday derinliği 10'dur). Kayıttaki model kimliği vLLM'in ilk
`--served-model-name` değeri değilse gömme/yeniden sıralama modeline
`reportedModels` yazılır (§7.2). İlk aşama tabanı yalnızca `rerank` profili
`enabled: false` yapılarak alınır;
kamuya açık modellerin yerel koşusunun kaydı `report --json` çıktısıdır. İkisi
de sonucu yeniden üretmek için `qualification` künyesini (§6.6) taşır. Kabul
çıktısı içerik taşımaz: vaka kimliği, ölçüler, sonuç türü sayıları, gecikme ve
ortam künyesi. Soru metni dışında kullanıcı verisi, anahtar ya da adres
kaydedilmez.

---

## 10. Aşama 4A'nın bilerek yapmadıkları

Aşama 4B'nin sınırları §7.9'dadır; 4B bu listeden gerçek gömme, yeniden
sıralama, `aiGateway` ve bağdaştırıcı eklerini ve model kaydının `preprocessing`
alanını uygulamıştır.

- Canlı yolda anlamsal yönlendirme, gömme ile erişim ya da yeniden sıralama;
- planlayıcı davranışı ve yeni yanıt üretimi;
- vektör veritabanı, kalıcılık, önbellek çerçevesi, veritabanı göçü;
- Rota veritabanı satırlarının gömülmesi ya da küresel kayıt dizini;
- yeni yetki mimarisi, yeni sağlayıcı soyutlaması, `aiGateway`, Aşama 3 araç
  ya da kanıt sözleşmesi değişikliği; model kaydı şeması değişikliği;
- genel SQL üretimi; arayüz değişikliği; ses; dış web erişimi;
- uygulama başlangıcında ya da CI'da model indirme.

---

## 11. Otomatik sınamalar

| Dosya | Kapsam |
| --- | --- |
| `test/ai-semantic-contract.test.mjs` | Yapısal sorgu normalleştirme (NFC, temizlikten sonra NFC ve tekrar edilebilirlik, İ/I, görünmez karakter, sınırlar); katalog ve parmak izleri (negatif, kesirli, güvensiz ya da değişen uzunluk dâhil); Aşama 3 kayıt defterinden katalog; model kökeni ve uzay (okumalar arasında değişen köken alanı dâhil); bozuk gömme yanıtları (Proxy uzunluğu, fırlayan erişimci dâhil); belirlenimci, sınırlı sıralama ve eşitlik; bayat uzay; yeniden sıralama sözleşmesi; enjeksiyon metninin etkisizliği; kimlik/yetki/SQL yüzeyi olmaması; sözleşmenin üretimde keşif hizmetince kullanılması (ağ geçidinde yalnızca sabit katalog ve sınırlar, bağdaştırıcıda yalnızca sınırlar) |
| `test/ai-semantic-gateway.test.mjs` | Bağdaştırıcının gerçek soketle tel biçimi (`/embeddings`, `/rerank`, `encoding_format`, `top_n`), değerlerin çevrilmemesi; bozuk zarf, sayı olmayan model kimliği ve HTTP durumlarının kararlı kodu, hata gövdesinin taşınmaması; girdi sayısıyla ölçeklenen okuma sınırı (4096 boyutlu katalog); ağ geçidinde öneklerin kayıttan ve tek yerde eklenmesi; girdi sınırları; profil/yetenek çözümü; `MODEL_MISMATCH` ve kayıtta bildirilen uç adlarının (`reportedModels`) kabulü, başka modelin adının reddi; belirteç penceresi (vLLM 0.31.0 ikizi: kesme yokken aşan sorgu `AI_REQUEST_INVALID`, aşan kullanıcı belgesi de `AI_REQUEST_INVALID`, sabit katalog belgesi yapılandırma hatası; `truncateTokens` ile tel gövdesinde `truncate_prompt_tokens` ve açık yönün bulunmaması, uzun sorgu/belgede önekin ve özel belirteçlerin korunması; karakter sınırındaki girdi); en kötü biçimli en büyük boyutlu geçerli yanıtın kabulü ve bütçeyi aşan bozuk yanıtın ayrıştırılmaması, bütçenin sözleşme tavanı; katalog belgesinin kurumsal anahtar ve sunucu kapasite anahtarıyla gitmesi (kullanıcının payı dolu ya da anahtarı kişiselken), kurumsal anahtar yokken `DEFAULT_KEY_REQUIRED`; sabit istek reddinin yapılandırma hatası olması; dar yineleme; modelin eşzamanlılık sınırı ve sıradayken iptal; süre aşımı, iptal ve geç yanıt; her yolda kiranın bırakılması; içeriksiz günlük; açık SQL işlemi reddi |
| `test/ai-semantic-retrieval.test.mjs` | Keşif akışı (normalleştirme, önekler, tek katalog gömmesi, sınırlı ilk aşama, yalnızca o adayların yeniden sıralanması), derinliğin değerlendirmeyle bağı, eşitlik sırası, gerçek araç kataloğu; tek uçuşlu kurulum (20 eşzamanlı istek), başarısız kurulumun önbelleğe girmemesi, başlatanın iptalinin paylaşılan kurulumu düşürmemesi, yalnızca en son kurulumun görünmesi, A → B → A sırasında süren kurulumun yeniden kullanılması, takılan kurulumun süre sınırında düşmesi; geçerli boyut geçişinde dizinin yeniden kurulması, düşen yeniden kurulumda geçerli dizinin korunması, eşzamanlı geçişte süren kurulumun paylaşılması ve karışık boyutlu uçta bekleme süresi; paylaşılan dizinin kurulumu başlatan kullanıcının kişisel anahtarı ya da kotasıyla düşmemesi; açıklama/sürüm/sıra/model/belirteç/önek değişince yeniden kurulum, kurulum sırasında değişen rota (`stale`); bozuk katalog ve sorgu gömmesi tabloları; yeniden sıralama düşüş tablosu (bozuk çıktı ve hizmet hataları → `first_stage`); kapalı profiller, kapalı yapay zekâ ve geçersiz yapılandırma; hizmet hatası sınıfları ve kapasite; geçersiz sorgu ve katalog; her evrede iptal ve geç sonuç; enjeksiyon metninin sonuca, günlüğe ve telemetriye girmemesi; anlamsal sağlık işleminin `ai.request` kuralıyla sınıflanması (kurumsal anahtar reddi hizmet hatası; kişisel anahtar reddi/oran sınırı, kullanıcının kendi kapasite sınırı ve istek reddi değil); iç hatanın (açık SQL işlemi, sağlayıcının beklenmeyen istisnası) her evrede yukarı taşınması; süreç düzeyi tam yığın (oturum, rehber, anahtar), SQL işlemi ve kimlik hatasının yukarı taşınması; durağan mimari sınırları (sağlayıcı yalnızca ağ geçidinde, Türkçe kalıp ya da araca özel dal yok, model adı yok, Aşama 3 turuna bağlanmama) |
| `test/ai-semantic-evaluation.test.mjs` | Kıyas kümesinin yapısı, sentetikliği ve sızıntısızlığı; üretim kodunun kıyas kümesinden bağımsızlığı; kapalı yapı (seyrek dizi, açık `null`, bozuk grup, bilinmeyen alan, okunamayan belge, taklit katalog) tablosu; elle hesaplanan ölçüler ve her ölçünün yeniden sıralama katkısı; kâhin ikizle tam küme; başarısız/geçersiz/süresi dolan çağrıların ıska sayılması; model işlevinin `TimeoutError` ile bildirdiği süre aşımının `timeout` sayılması; çağrı süre sınırı üst değerinin ağ geçidi yaşam döngüsünü kapsaması; sinyale uymayan modelde koşunun durması; iptal yarışları; yeniden sıralama düşüşü; dizin kurulamaması; iptal; gecikme özeti; koşu kaydı durum makinesinin geçerli/geçersiz durum tabloları (bayat sürüm, bayat iletili fırlayan erişimcinin `INVALID` sayılması, kapalı alanlar, yabancı/yinelenen/geri giden satır, atlanan ara satır, sonuç–yük çelişkisi, çağrılmayan ıska biçimi, dizin durumu, duruş dilimi ve `halted` kararı, kısmi koşu, eşitlik sırası, köken ve dizin kimliği, permütasyon olmayan yeniden sıralama, negatif gecikme, sınırdan derin kesim); uzunluğu okumalar arasında değişen dizi; planlayıcı karar ölçüleri ve güvenilmez karar tablosu (okunamayan liste, korunan vaka kimliği) |
| `test/ai-semantic-qualification.test.mjs` | Nitelendirme komutu: parmak izli girdi; kâhin koşu dosyasıyla rapor ve `qualification` künyesi (model, önekler, yeniden sıralayıcı, aday sınırı, gecikme iş yükü); bayat, eksik/fazla/yabancı/yinelenen satırlı, değiştirilmiş metinli, negatif gecikmeli, öneki çelişkili, bilinmeyen alanlı ya da güvensiz hata kodlu koşunun reddi; bozuk değerin ve `INFERENCE_FAILED` satırının ıska sayılması; dizini kurulamayan koşunun reddi; bütün katalog yeniden sıralama skoru doğrulaması ve gerçek çağrı nüfusu; `batchSize` künyesi; Markdown enjeksiyonunun etkisizliği; yeniden sıralamalı raporda her ölçünün "Fark" hücresi; `--limit` sınırı; aynı açıklamalı iki katalog öğesinin yeniden oynatımda kendi kimliğinin vektörünü ve skorunu alması; `live`: üretim yolundan (ağ geçidi + bağdaştırıcı + yerel HTTP ikizi) kâhin uçla kusursuz ölçü, kayıttan gelen profil ve önekler, tek katalog gömmesi, 10 adaylık yeniden sıralama, künye; `--queries` ile türetilen küme ve bozuk soru dosyalarının reddi; anahtarsız ya da kapalı yapılandırmanın ve kurulamayan dizinin reddi; yeniden sıralama profili kapalıyken yalnızca ilk aşama, bozuk yeniden sıralama eşlemesinin reddi; üretimden farklı `--limit` değerinin reddi; bağlantı hatası yinelenen koşuda stdout'un ayrıştırılabilir JSON kalması (günlük stderr'de); `.env.local` ortam kaynağı ve kabuk önceliği, anahtarın yazılmaması; ağ geçidi süre aşımının `timeout` sayılması; durmuş koşuda iş yükünün yalnızca gerçek çağrıları sayması; dış süre sınırının ağ geçidinin en uzun yaşam döngüsünü kapsaması; belirteç penceresinin künyede ve tel gövdesinde olması |
| `test/ai-model-registry.test.mjs` (4B eki) | Gömme modelinin `preprocessing` alanı: varsayılan ve operasyonel kayıtta E5 önekleri ve 512 belirteçlik pencere, rotaya taşınması, yokken `none`, yazılmış `null` (gömme ve sohbet modelinde) ve `null` önekin reddi, yalnızca gömme modelinde, kapalı alan kümesi, belirteç biçimi, önek–`none` kuralı, uzunluk sınırı, `truncateTokens` biçimi ve `contextTokens` sınırı; `reportedModels`: yalnızca gömme/yeniden sıralama modelinde, tekil, jokersiz, kendi kimliği ya da başka bir modelin kimliği/adı olamaz |
| `test/semantic_model_qualification_test.py` (CI dışı, elle) | Python koşucusu: yinelenen kimlik, sayı ve metin sınırı (astral karakter dâhil), kapalı şema ve mantıksal sürümün model modülleri yüklenmeden reddi; önek ve `--device` için UTF-16 sınırı; sayısal metin, mantıksal değer, NaN/sonsuz ve sıfır vektörün sayıya çevrilmemesi, NumPy skalerlerinin kabulü; tür geçersiz katalogda koşu dosyası yazılmaması; eski çıktı silinemediğinde geçici dosya bırakılmaması |
| `test/ai-planner-contract.test.mjs` (4C) | Anlamsal adayların kayıt defterine karşı yeniden doğrulanması (bilinmeyen, yinelenen, yanlış tür/sıra, fazla aday → danışmanlık yok); süre aşımında Aşama 3 davranışı; iptalin, kimlik/yetki, sağlayıcı anahtarı ve sınıflandırılmamış iç hatanın yukarı taşınması; araç kümesinin ve sırasının adaylardan bağımsızlığı; türlü planın kapalı biçimi (niyet, dil, ek istek sayısı/türü, karar alanları); açıklama ve çekimserliğin sıfır SQL ile sunucu metni; ilk karar yerine düz metnin boş plan reddi olması ve metnin döküme taşınmaması; genel karardan sonra plan reddi olmaması; çok bölümlü planın hep-ya-hiç doğrulanması ve bağımlı kaynağın sınırı; açılmamış serbest metinde sabit uyarı; çelişkili termin penceresi; proje aramasının adlandırılmış varlıkla kabulü; içeriksiz telemetri |
| `test/ai-planner-benchmark.test.mjs` (4C) | Altın etiket belgesinin kapalı şeması ve kıyas kümesine bağı; her yanıt vakasının örnek planının üretim planlama sınırından ilk bildirimde geçmesi ve kendi etiketini karşılaması (iki referans günü); açıklama/çekimserlik puanlaması; anlam denetimi (süzgeç, pencere, bağımlı bölüm, varlık, sıralama, ilgisiz araç, ölçü, bölüm eşlemesi); ek bölüm kuralı; modele giden girdide vaka kimliği ve altın etiket izi olmaması; üretim kodunun etiketleri, kıyas kümesini ve değerlendirme betiklerini içe aktarmaması ve vaka metni taşımaması |

---

## 12. Aşama 4C'de uygulananlar (UYGULANDI — kabul kapısı AÇIK)

### 12.1 Bağlantı noktası — `src/server/ai/assistant/semanticPlanning.js`

- 4B keşfinin üretimdeki **tek** çağıranı (`semanticRetrieval` başka hiçbir
  üretim modülünden içe aktarılmaz; mimari sınaması). `assistantService` her
  Rota turundan önce `semanticPlanningAdvice({ query, catalog, signal })`
  çağırır; sonuç `runGroundedTurn` seçeneğidir.
- Adaylar güvenilmez veridir: durum bilinen değerlerden biri, en çok
  `SEMANTIC_RETRIEVAL_DEPTH` (10) aday, tür `tool`, sıra 1..n, kimlik kayıt
  defterinde ve tekil olmalıdır; değilse danışmanlık yoktur
  (`CANDIDATES_INVALID`). Benzerlik eşiği **yoktur** (§8 ölçümleri bir eşiği
  haklı çıkarmadı).
- Kendi süre bütçesi (`SEMANTIC_PLANNING_BUDGET_MS` = 8 sn): bütçe aşımı
  danışmanlığın kaybıdır (Aşama 3 planlaması sürer); üst iptal
  `AI_CANCELLED` olarak taşınır; kimlik/yetki, sağlayıcı anahtar hataları (`AI_KEY_INVALID`, `AI_UNAUTHORIZED`, `AI_KEY_MISSING`) ve sınıflandırılmamış iç hatalar yukarı taşınır; `AI_CONFIGURATION_ERROR` dâhil beklenen işlemsel keşif hataları `unavailable`/`first_stage` danışmanlığa düşer (§7.5).
- **Daraltma yoktur.** Gerçek e5 ölçümünde (§8) ilk aşamanın 10 adayı bazı
  soruların gereken yeteneğini içermedi; bu yüzden araç kümesi her zaman
  kayıt defterinin tamamıdır ve **sırası sabittir**. Adaylar yalnızca sistem
  notunda "öneri" olarak görünür (`plannerCandidateNote`); bu not sabit sistem/araç önekinin ardından ayrı iletidedir. Sabit sıra hem
  sağlayıcı önek önbelleğini (vLLM önek önbelleği, Anthropic önbellek okuması)
  korur hem de adayın yetki ya da kesinlik sayılmasını önler.

### 12.2 Türlü plan sözleşmesi — `rota_plan` (`executionSet.js`)

`{ intent, language, request?, additionalRequests?, calls?, clarify?, abstain? }`:

- `intent: rota` — `request` zorunludur; ileti ayrı okuma gerektiren bir ya da
  iki soru daha soruyorsa `additionalRequests` (en çok 3 bölüm). Ek bölüm
  önceki bölümün satırlarındaki kayıtlar için soruyorsa varlığı
  `{ "type": "task|project", "from": <bölüm> }` olarak yazılır; sunucu kaynağın
  takibe açık satır kimliklerinden en çok 3'ünü bağlar. Çok bölümlü planın
  okumalarını yalnızca sunucu kurar (`calls` verilemez); bütün bölümler veri
  okunmadan birlikte doğrulanır, biri geçersizse hiçbiri yürütülmez.
- `intent: clarify` — `clarify.reason`: `missing_referent | ambiguous`
  (isteğe bağlı `topics`: 2–4 kayıtlı araç). `intent: abstain` —
  `abstain.reason`: `write | calculation | outside_data | security | general`.
  İkisi de **sonlandırıcıdır**: araç çağrısı ya da istek taşıyamaz, Rota verisi
  okunmaz, kullanıcı sunucunun sabit metnini görür (`plannerOutcome.js`).
- `intent: general` da Rota planlamasını kapatır: sonraki yanıt turu araçsızdır; model kararı yeniden Rota planına çeviremez. Bir mantıksal turda karar sayacı en çok bir kez artar (devir dâhil).
- Çok bölümlü plan önce bütünüyle doğrulanır, sonra bölümler sırayla çalışır. Bölümün kök okuma kapsamı, kanıtları ve hata sınıfları yereldir; yetkili kimlikler, son yetki doğrulaması ve tüm bütçeler ortaktır. Sonraki bölümün hatası/sınır aşımı önceki doğrulanmış yanıtları silmez; eksik bölüm sabit sunucu notuyla belirtilir. Bağımlı kimlikler model atıflarından değil kaynak bölümün doğrulanmış nüfus satırlarından, satır sırasıyla gelir.
- Biçim hataları alanıyla bildirilir (`$.intent:required`,
  `$.additionalRequests[0].metrics[1]:enum`, `$.fields[0].path:unknown` …);
  ipuçları yalnızca sözleşmeden ve kayıt defterinden türetilir ve modelin
  gördüğü araç sonucunda da yer alır.
- Çelişkili plan SQL'den önce reddedilir; örneğin göreli termin ön ayarı ile
  açık termin aralığı birlikte (`$.filters.deadline:conflict`).
- İlk karar yerine gelen düz metin karar değildir: dökümde boş bir plan
  çağrısının reddi (`$.plan:required`) olarak kalır, metnin kendisi taşınmaz.
- Soru korumalı metin ölçüsü gerektiriyorsa izin kapalıyken sunucu "Notlar ve iletiler" uyarısıyla biter. Modelin kazara eklediği `textFields` ise mevcut sınırlı bildirim düzeltmesinde kaldırılabilir; izin kendiliğinden açılmaz. Boş `additionalRequests: []` ve kullanılmayan boş karar nesneleri anlamsal olarak yok sayılır; dolu bozuk alanlar reddedilir.
- Düzeltme bütçesi Aşama 3'ünkidir (2 bildirim düzeltmesi); düzeltme
  önceki geçersiz plandaki doğrulanmış sorunsuz bölümleri değiştiremez; ölçü biçimi onarılırken varlıklar ve nüfus koşulları sabittir. Genel belirsizlik açıklaması, sonraki turda güvenli devam için kayıt adını/kodunu içeren tam sorunun yeniden yazılmasını açıkça ister. Veri okunduktan sonra istek
  değişmez; Standart → Derin devri aynı sınırlardan geçer.

Tek bölümlü doğrulanmış görev listesinin/sıralamasının dönen kimlikleri (en çok 50), mevcut
kanıt JSON'unda `resultScope` olarak saklanır. Hemen önceki asistan iletisi başarılıysa sunucu
planlayıcıya yalnızca kayıt türünü ve küme boyunu verir. Model `request.previousResult: true`
ile bu kümeyi seçebilir: tek bölümlü, varlıksız `rota_task_search` veya `rota_task_analytics`.
Önceki tarih/durum koşulları yeniden çalıştırılmaz; sunucu aynı kimliklerin güncel verisini okur.
Planın tamamı doğrulanmadan yetki/veri okuması başlamaz. Eski kanıtın dönem/proje/görev yetkisi
mevcut denetimden geçmezse okuma kapalı kalır. Yeni konuşma, araya giren başka yanıt, bozuk ya da
kayıpsız saklanamayan kapsam gönderge sağlamaz. Önceki asistan metni güncel kanıt değildir;
zamir/anahtar sözcük tanıma yoktur. Yeni alan mevcut monoton düzeltme eşitliğinde korunur.
Gönderge yokken `previousResult: true` bildirimi veri okumayan `missing_referent` açıklamasıyla
biter; bayrak silinerek geniş okuma yapılmaz. Kullanıcının yeniden yazdığı tam soru sonraki
turda eski yürütme durumu taşınmadan olağan plan doğrulamasından geçer.

### 12.3 Sunucu yönergesi

Yönerge sözleşmeyi anlatır, doğal dili yorumlamaz: yanıt protokolü (ilk yanıt
her zaman `rota_plan`), karar tanımları, gönderge ve belirsizlik ilkesi
(uydurma adlarla karşıt örnek), karar önceliği (yazma/hesap/Rota dışı/
güvenlik her zaman çekimserlik), tek kaydın alanları için ayrıntı aracı ve
sunucunun hesapladığı **takvim çapaları** (bugün, dün, yarın, bu hafta, geçen
hafta, bu ay, önümüzdeki ay; Türkiye günü). Sunucu yalnızca takvim gerçeğini
verir; ifadeyi çapaya model eşler. Türkçe anahtar sözcük tablosu, eşanlam
sözlüğü, düzenli ifade yönlendirmesi ya da kıyas vakasına özel dal yoktur
(mimari sınamaları).

### 12.4 Telemetri

`recordPlannerDecision` / `recordPlannerRejection`: karar türü (rota, general,
clarify, abstain, invalid, text_fields), çok bölümlü plan sayısı, anlamsal durum ve sınırlı kullanılamama nedeni (süre aşımı kullanıcı iptali sayılmaz), aday
sayısı, bildirim sayısı, gecikme ve ret yolunun türü. Soru, yönerge,
vektör, aday metni, Sicil ya da model gerekçesi yazılmaz (sınama). Gateway `AI_TIMEOUT`
yapılandırılmış nedeni, mevcut `TIMEOUT` sayacına normalleştirilir; diğer nedenler değişmez.

### 12.5 Değerlendirici — `scripts/planner-evaluation.mjs`, `scripts/planner-scoring.mjs`

- Her vaka **üretimdeki planlama sınırından** geçer: sunucu bağlamı,
  `semanticPlanningAdvice`, kayıt defteri araçları ve `rota_plan`,
  `runGroundedTurn` döngüsü (düzeltmeler dâhil). İlk SQL'den hemen önce tur
  durur; Rota verisi okunmaz. Korumalı metin yalnızca vakanın açık `input.allowedTextFields` girdisinde verilen alanlar için açıktır (altın etiketten türetilmez); olağan sorularda kapalıdır.
- Model kaynağı: `--model-command` (stdin `{ messages, tools, toolChoice }`,
  stdout `{ text, toolCalls, finishReason, usage, models, thinking: "off" }`) ya da `--model live`
  (ağ geçidinin `chat.tools` oturumu). Anlamsal kaynak: `--semantic
  kosu.json` (gerçek model koşu dosyası, 4A/4B sözleşmesiyle yeniden
  oynatılır), `none` ya da `live` (üretimdeki keşif hizmeti).
- Modele giden her girdi sızıntı için denetlenir (vaka kimliği, beklenti,
  ihtiyaç, altın etiket izi). Altyapı hatasında (kota, kimlik doğrulama,
  beklenmeyen model) geçiş durur ve kaydedilmez; vaka başına yineleme yoktur.
- Kurum içi kabul (uygulama dizininden, `.env.local` okunur):
  `node scripts/planner-evaluation.mjs live --passes 3 --out kabul.json`.
- Dış Haiku kapısında beklenen model `claude-haiku-4-5-20251001` ve düşünme kapalıdır; her çağrı gerçek `finishReason` değerini, model kimliğini, `thinking: "off"` beyanını ve sıfır düşünme belirtecini raporlamalıdır. Canlı yolda düşünme yetenekli modelin kapalı kipini mevcut ağ geçidi sözleşmesi kanıtlayamıyorsa koşu sertifikalanmaz; üretim sözleşmesi bu amaçla genişletilmez. Eksik köken, başka model veya düşünme belirteci koşuyu geçersiz kılar. `--expected-model` yalnızca değerlendirme künyesidir; canlı yolda kayıtlı `chat.tools` modeliyle de birebir doğrulanır, üretim rotasını değiştirmez.
- Araçlı OpenAI uyumlu ağ geçidinin sohbet şablonu, ilk iletiden sonraki `system` iletilerini desteklemelidir. Yalnızca başta `system` kabul eden şablonlar bu sözleşmede desteklenmez; operatör sunucuda uygun şablonu seçmelidir. Bağdaştırıcı sunucu notlarını kullanıcı rolüne taşımaz veya sabit öneğe birleştirmez; şablonun isteği HTTP 400 ile reddetmesi mevcut `AI_REQUEST_INVALID` hatasıyla kapanır ve Rota okuması başlatmaz.
- Çok turlu takip nitelendirmesi gerçek anlamsal model bağlanmadığında danışmanlığı unavailable kullanır; hash tabanlı sınama vektörleri gerçek modele araç önerisi olarak verilmez. Windows Claude başlatıcısı yerel yürütülebilir dosyayı veya standart npm kurulumunun sabit `@anthropic-ai/claude-code/cli.js` girişini kullanır; `.cmd` içeriği ve model bağımsız değişkenleri kabukta çalıştırılmaz.
- Claude komutunda aynı kayıt dosyasını kullanan çağrılar, bütçe denetiminden kullanım kaydına kadar sırayla yürür; önbellek kapısı tamamlanan önceki çağrıyı görür. Değerlendirici aynı kayıtlı bağdaştırıcının kuyruğunu komut zamanlayıcısından önce bekler; kapanış kuyruktaki komutları başlatmaz. Süreçler arası kilit beklemesi, değerlendiricinin ilettiği komut bütçesiyle sınırlıdır (doğrudan çağrıda 120 sn). Kilit PID, süreç başlangıç kimliği ve tekil sahip dosyasıyla atomik yayımlanır; ölü ya da PID'si yeniden kullanılmış sahibin kilidi kurtarılır, canlı sahip yaşa göre düşürülmez. Linux kimliği çekirdek açılışı ve süreç başlangıç sayacını, Windows kimliği yerel süreç başlangıç zamanını içerir. Kesilmiş çağrının bilinmeyen harcaması belirteç bütçesinde sıfır sayılmaz (`PLANNER_BUDGET_UNVERIFIED`); yeni ölçüm için ayrı koşu kaydı gerekir. Bütçe, tamamlanan harcamaya göre sonraki çağrıyı durduran kabul sınırıdır. Takip nitelendirmesi de ortak açık bitiş nedeni doğrulamasını kullanır; eksik/bilinmeyen neden normal bitişe çevrilmez. Başarısız senaryo ya da Derin devir varsa tanı raporu korunur ve komut başarısız çıkar. Komut bütçesi de ortak pozitif ondalık ortam sınırı ayrıştırıcısından geçer.
- Claude değerlendirme adaptörünün varsayılan evi geçici kökte POSIX için `rota-planner-claude-home-<uid>`, Windows için `rota-planner-claude-home` olur; açık `PLANNER_CLAUDE_HOME` ayarı aynen korunur. `PLANNER_CLAUDE_HOME` alt ağacında sembolik bağlantı/Windows reparse noktası kabul edilmez. Windows yerel PowerShell ACL denetimi; GNU/Linux ACL destekli yerel `/bin/ls` ve macOS `/bin/ls -ldben` ile ACL denetimi kullanılır; başka POSIX platformları ve doğrulanamayan metadata kapalı ret verir. Linux genişletilmiş ve varsayılan ACL'leri reddeder; macOS salt okuma/deny ACL'lerine izin verir, yazma veren veya tanınmayan allow haklarını reddeder. `chmod` ACL temizleme kanıtı sayılmaz. Atalar da denetlenir. POSIX dosya ACL metadatası, kaçırılmış dosya adlarıyla en çok 64 dosyalık kümelerde okunur; her dosyada ayrı süreç açılmaz ve hiçbir kayıt atlanmaz. Kaybolan dosyalar kümeden çıkarılabilir; öteki metadata hataları reddedilir. Aynı özel evi kullanan paralel çağrılarda yalnızca kaybolmuş alt öğe tolere edilir; kök kaybı, erişim, sahiplik, ACL ve bağlantı hataları modeli başlatmadan ve bütçe ayırmadan reddedilir.
- Kilit temizliğindeki geçici `EPERM`/`EBUSY` dosya paylaşımı hataları aynı tekil sahip dosyasında yeniden denenir. Eski kilidi kurtarma mevcut kilit bekleme süresini, kendi kilidini bırakma mevcut 5 sn temizleme sınırını kullanır. Yeni sahibin dolu dizini silinmez; kalıcı hata veya dolan süre komutu başarısız sonlandırır.
- Dış komut platform kabuğunda çalışır (Windows dâhil), varsayılan 120 sn süre ve toplam 4 MiB stdout/stderr sınırına sahiptir (`--model-timeout-ms`, `--model-output-bytes` yalnızca değerlendirme içindir). Sınırda veya SIGINT/SIGTERM kesintisinde tüm etkin komutların süreç ağaçları sonlandırılır; geçici dizin temizlenir. Değer alan CLI bayrağı sonraki bayrağı değer saymaz. Ham komut saklanmaz: yalnızca SHA-256 kimliği yazılır; ham stderr/altyapı iletileri kayda alınmaz.
- Koşu biçimi sürüm **2**: referans gün kıyas parmak izine bağlıdır; gerçek takvim günü, bilinen/tekil vaka kimlikleri, bütün geçiş/vaka kayıtları, model/düşünme ve anlamsal köken puanlamadan önce doğrulanır. Bozuk koşu puanlanmaz. Anlamsal belge vektörleri ve yeniden sıralama puanları kimlikle bağlanır; dizi sırası anlam taşımaz. Eski sürüm koşular bu kapıyı karşılamaz.
- Puanlanan `run`, `report`, `live` komutları kabul kapısı geçilmediyse sıfırdan farklı çıkar; `--no-score` tanısaldır. Kısmi vaka koşusu kapıyı geçiremez. Kabul için kanonik **117/117** ve zorunlu ek **19/19** her geçişte birlikte gereklidir.

### 12.6 Altın etiketler — `test/fixtures/ai-planner-benchmark.json`

Kapalı şema, sürüm 1, 4A kıyas kümesinin parmak izine bağlı (kıyas değişirse
etiketler bayat sayılır); yalnızca değerlendirme ve sınamalar okur. Her yanıt
vakası anlam kısıtları taşır: gerekli bölümler (her biri bir ihtiyaç grubunu
karşılar; aynı ihtiyaç iki okuma isteyebilir), seçenek başına araç, işlem,
varlık (aramanın kanonik biçimiyle; kullanıcının yazdığı tür sözcüğü aynı
kaydı adlandırır), ölçü, süzgeç (üretimin kanonik nüfus kimliğiyle), göreli
pencere (bugüne ya da takvim çapasına göre), sıralama, gruplama ve bağımlı
kaynak; isteğe bağlı kabul edilen ek bölümler. Her vakanın örnek planı üretim
doğrulayıcılarından ilk bildirimde geçer ve kendi etiketini karşılar (sınama).
19 odaklı ek vaka (Türkçe ve İngilizce gerçek `general` kararları dâhil): takip bağlamı ve kapsam, göreli tarih, ASCII, yazım
hatası, çekim, oran, en üstünlük, olumsuzluk, çoklu araç, yazma, kimlik
değiştirme, yönerge enjeksiyonu, Rota dışı veri, desteklenmeyen hesap,
İngilizce. Parmak izi altın sözleşme ve referans günle birlikte hesaplanır. İşlem, koleksiyon, izin verilen ölçüler, ek süzgeçler, sıralama/sınır, gruplama, bağımlılık, korumalı metin ve muhakeme boyutları kapalıdır; dil ve sonlandırıcı kararın nedeni/konuları da puanlanır. Bildirilmemiş yinelenen ek bölüm kabul edilmez.

### 12.7 Ölçümler (2026-10-19)

**Anlamsal katman (gerçek modeller, CPU):** `intfloat/multilingual-e5-large`
ilk aşama: hit@1 0,568, MRR 0,650, recall@5 0,737. Ek ölçüm (profil modeli
DEĞİL; `Qwen3-Reranker-8B` bu ortamda çalıştırılamadı):
`BAAI/bge-reranker-v2-m3` (revizyon `953dc6f6…`) ile hit@1 0,589, MRR 0,680,
recall@5 0,789; yeniden sıralama p50 4,5 sn (19 belge, CPU). Görev arama
sorularında ilk aşama zayıf: daraltma yerine danışman not seçildi.

**Önceki değerlendiriciyle tarihsel ölçüm (aşağıdaki 88/117 düzeltilmiş katı kapının sonucu değildir):** `claude-haiku-4-5-20251001`, genişletilmiş
düşünme KAPALI (her turda düşünme belirteci 0), depoyu görmeyen yeni oturum,
yalnızca `rota_plan` ve 19 kayıtlı araç (yerel araç arayüzü), e5 ilk aşama
adayları, vaka başına yineleme/çoğunluk/model değişimi yok. Haiku 4.5
Qwen3-Next-80B-A3B-Instruct'ın taklidi DEĞİLDİR; yalnızca mimarinin sınır
düzeyi akıl yürütme gerektirip gerektirmediğinin kanıtıdır.

| Geçiş | Kanonik | yanıt | açıklama | çekimserlik |
| --- | --- | --- | --- | --- |
| Son düzeltmeden önce | 89/117 | — | — | — |
| Son geçiş | **88/117** | 70/95 | 4/7 | 14/15 |

Kapı (117/117, tercihen 3×) **geçilmedi**. Son geçişin ıskaları (yalnız vaka
kimliğiyle): açıklama yerine plan ya da tersi — tr-017, tr-032, tr-045,
tr-072, tr-073, tr-075, tr-079 (ad verilmiş kayıtta gereksiz açıklama),
tr-096 (düzeltme tükendi), tr-097, tr-098 (belirsiz soruda plan); yanlış araç
ya da eksik bölüm — tr-023, tr-046, tr-060, tr-090, tr-095; süzgeç/pencere —
tr-021, tr-034, tr-053, tr-078, tr-091; düzeltmesi yakınsamayan plan —
tr-049, tr-052, tr-066, tr-068, tr-070, tr-077, tr-087, tr-092, tr-104.
Ek 17 vaka önceki geçişte 17/17.

### 12.8 Bekleyenler

- **Gerçek model nitelendirmesi:** Qwen3-Next-80B-A3B-Instruct (81,3 milyar
  parametre) ve gemma-4-31B-it bu ortamda çalıştırılamadı (GPU yok);
  Qwen3-Reranker-8B ~16,4 GB, 15 GiB bellekte çalıştırılamadı; kurum içi uç
  erişilemez. Kurum içi komut §12.5'tedir.
- **Kabul kapısı:** zayıf model geçişi 117/117 değil; ıska sınıfları
  (gereksiz açıklama, belirsizlikte plan, yakınsamayan düzeltme) sonraki
  düzeltmenin girdisidir. Kapı geçilmeden 4C "kabul edildi" sayılmaz.


**4C kök neden yakınsaması:** Katı değerlendirici için yerel belirlenimci regresyonlar güncellendi. Bu ortamda doğrulanmış Haiku 4.5 / kurum içi model erişimi yoktur; düzeltilmiş kapıyla yeni gerçek-model ölçümü **bekliyor**. Kanonik 117/117 ve ek 19/19 gerçek modelle gösterilmeden kabul/merge-ready iddiası yoktur. Üretim uç noktası, araç, sağlayıcı, bağımlılık, göç veya yetki yolu eklenmedi; üretim araç sınırları değiştirilmedi.


### 12.9 — İkinci kök neden yakınsaması

İlk karar yalnızca yerel `rota_plan` çağrısıdır; metin JSON başarılı plan sayılmaz. Okuma sınırı kanıt
sayısından ayrıdır; başarısız okuma niyeti yeniden açmaz. Veri öncesi Derin devri karar ve onarım
anlık görüntüsünü birlikte temizler. Onarım, tamamlanmış anlamı karşılaştırır; bağımsız geçerli
bölümler ve soru sayısı korunur. Çok bölümlü sonuçta eksik bölüm `grounded` sayılmaz. Tek bölümlü yanıtta aday
seçimi açıklama bağlamıyla saklanır; çok bölümlü belirsizlikte bölüm kimliği taşımayan küresel seçim
kaydedilmez, kayıt adı/kodu ile soru yeniden istenir. Bağımlı kimlikler yalnızca doğrulanmış kaynak seçiminin sonuç
satırlarından gelir; sıralama sınırı sonraki okumaları genişletmez.

Değerlendiricide izinler açık `input.allowedTextFields` girdisidir; altın etiket modele giden girdiyi
etkilemez. `--semantic none` tanısaldır, kabul sağlamaz. Dosyadan anlamsal kabul için 136 sorunun
vektörlerini aynı mevcut Python koşucusuyla üretin:

```bash
node scripts/planner-evaluation.mjs input --out planner-semantic-input.json
python3 scripts/semantic-model-qualification.py --input planner-semantic-input.json --output planner-semantic-run.json --embedding-model <yerel-model> --reranker-model <yerel-yeniden-siralayici>
node scripts/planner-evaluation.mjs run --model-command '<komut>' --semantic planner-semantic-run.json --out planner-run.json --json
```

Eksik/yabancı/yinelenen anlamsal kimlikler reddedilir. Belgelenmiş `INFERENCE_FAILED` yeniden
sıralama sonucu ve tam kimlik kümesindeki sonlu olmayan (`null`) model skoru ilk aşamaya döner;
eksik/yinelenen skor kimliği, eksik skor alanı ve metin skor bozuk artifakttır. Canlı yolda kayıtlı düşünmesiz
rota, olaylar ve eksik/sıfır kullanım birlikte doğrulanır; dış komutta bilinmeyen düşünme sayısı
kabul edilmez. Her iki model yolunda her tur sızıntı denetiminden geçer. Dış komut çağıranın
çalışma klasöründe çalışır; geçici dosyaları ayrı klasördedir. `--no-score --out` ve canlı modelle
aynı anda dış komut açıkça reddedilir. Gerçek model kabulü hâlâ bekliyor.


### 12.10 — Son kök neden yakınsaması

- Onarım aynı kanonik izdüşümle yalnızca doğrulayıcının reddettiği yolları değiştirir; geçerli çağrı koşulları, kapsam, ölçü yuvaları ve bağımsız bölümler korunur. İlgisiz çağrı ipucu yalnızca o nüfusa bağlı ek bölüme izin verir.
- Bölüm hatası etkin Rota kararını değiştirmez. Yerel sağlayıcı duraklaması önceki doğrulanmış yanıtları korur; çağıranın iptali ve genel süre sınırı yukarı taşınır. Kesik sağlayıcı yanıtı hiçbir niyet için kabul edilmez. Kanıtlı + bulunamadı sonucu kesinti sayılmaz; ortak açıklama yönergesi bir kez gösterilir.
- Planlayıcı değerlendirmesi anlamsal koşunun kanonik doğrulayıcısını kullanır. Dış modelin bitiş nedeni zorunludur ve korunur. Sızıntı denetimi ham yapılandırılmış girdide çalışır (`PLANNER_GOLD_LEAK`); sayfa boyu aynı nüfusu farklı okuma saydırmaz. Geçerli başarısız model vakası ıskadır, bozuk koşu değildir.
- Sağlayıcı anahtar hataları (`AI_KEY_INVALID`, `AI_UNAUTHORIZED`, `AI_KEY_MISSING`), kimlik/yetki ve sınıflandırılmamış iç hatalar yukarı taşınır; `AI_CONFIGURATION_ERROR` dâhil beklenen işlemsel keşif hataları §7.5 uyarınca `unavailable`/`first_stage` danışmanlığa düşer. Yeni üretim yüzeyi, bağımlılık veya bütçe artışı yoktur.
- Gerçek model kabulü **BEKLİYOR**: kanonik 117/117 + zorunlu ek 19/19 burada çalıştırılmadı. Ortamda canlı AI kapalıdır; dış Haiku komutu ve yerel HuggingFace çalışma zamanı yoktur. Belirlenimci sınamalar gerçek model kabulü sayılmaz.

Son geçişte yapısal ret öncesi çözülen Rota niyeti de korunur; onarım başka niyete geçemez.
Bağımlı bölüm, kaynağın onarılan metnine değil aynı bölüm kimliğine bağlıdır. Reddedilen karma/taşkın
ölçü kümesi yalnızca mevcut üç bölüm sınırında, tam ölçü/alan/bağlama kümesi ve kapsam korunarak
bölünebilir; geçerli ölçü ya da soru silinmez. Hatalı bağlama geçerli kardeş bağlamaları serbest bırakmaz. Bölmede tam ölçü kümesi ve etkilenmeyen alan/bağlama yuvaları ayrı korunur; bozuk yuva karşılaştırmayı çökertmez. Bağlı varlıklar kendi ölçü bölümüne, ortak bağlanmamış bağlam uygun tüm bölümlere gider; sıralama ve liste işlemi yalnızca kendi satır ölçülerinde kalır.
Modelin kendi reddedilen çağrısındaki uydurma anahtar altın sızıntısı sayılmaz; sunucu girdileri ve
vaka/dosya izleri denetlenmeye devam eder. Canlı boş yanıtlar kimlik, düşünmesizlik ve bitiş nedeni
doğrulanarak ıska sayılır; gerçek altyapı hatası koşuyu yine durdurur. Bilinmeyen giriş belirteci `null`
kalır; `live --no-score` tanısal kayıtları puanlamadan gösterir. Gerçek model kabulü hâlâ **BEKLİYOR**.


21 bulguluk son geçişte tekillik hatası yalnızca yinelemeyi kaldırmaya izin verir; geçerli alan ve
kayıt bağları değişmez. Taşkın dizinin bölünmesi yeni bağ ekleyemez; sonraki doğrulamanın izin verdiği
bölme düzeltilmiş tam ölçü kümesini korur. Açık satır koleksiyonu liste izdüşümünde korunur.
Sonraki bölüm, kendi adını çözen doğrulanmış arama kanıtını yeniden kullanır. Genel karar bildirim
bütçesinden bağımsız kabul edilir; yürütme bütçeleri değişmez.

Değerlendirici boş bayrak değerlerini reddeder; canlı eşzamanlılık mevcut Sicil kabul sınırına
indirilir. Dış komut başarıda da süreç grubunu temizler; SIGHUP aynı temizliği yapar. Linux procfs
sinyal sınaması yalnızca Linux'ta çalışır, başlangıç işaretleri atomik yazılır. Puanlama aynı varsayılan
alanın açık bağını ve birleşik proje/IDA seçicilerini kabul eder; farklı alan anlamını ve eksik gönderen
kapsamını reddeder. Sağlayıcı ikizi açık parçaları, kesilme nedenini, model kimliğini ve kullanımı
korur. Bu regresyonlar gerçek model kabulü değildir; 117/117 + 19/19 kapısı hâlâ bekler.

Arka plan süreç temizliği sınamasında üretilen JavaScript kaynağı sabittir; geçici dosya yolları
koda eklenmez, alt sürece bağımsız değişken olarak iletilir. CodeQL denetimleri bastırılmaz.

Beş bulguluk ek geçişte alan/bağlama onarımı, bölmeyle aynı sınırlı birebir öğe eşlemesini kullanır:
bozuk yuvalar kaldırılabilir; geçerli kardeşler düşürülemez veya değiştirilemez. Hot reload ile kalan
eski telemetri nesnesinde yalnızca eksik planlayıcı durumu başlatılır, mevcut sayımlar korunur.
Metin izni reddi sınaması sıfır veri okumasını; karar puanlama sınaması kabul edilmiş planın doğru
nedenle reddini doğrular. Canlı eşzamanlılık sınaması sabit, açık referans günle çalışır.

### 21 Ekim 2026 — donmuş 4C yakınsama kümesi

Başlangıç HEAD: `1d4b491bd7ba273b0ac0ace063d9134b295ba287`. Kod değişmeden önce GitHub'dan
okunan **11** açık başlık, bu geçişin sabit kapsamıdır:

```text
FROZEN_UNRESOLVED_SET
PRRT_kwDOSQ6ZIs6um4St
PRRT_kwDOSQ6ZIs6um5mn
PRRT_kwDOSQ6ZIs6um5mr
PRRT_kwDOSQ6ZIs6um5mz
PRRT_kwDOSQ6ZIs6unmgQ
PRRT_kwDOSQ6ZIs6unosH
PRRT_kwDOSQ6ZIs6unosO
PRRT_kwDOSQ6ZIs6upTgp
PRRT_kwDOSQ6ZIs6upTgt
PRRT_kwDOSQ6ZIs6upTgz
PRRT_kwDOSQ6ZIs6uqMVd
```

Dokuz kök neden/sözleşme kümesi değerlendirildi: yedi kümede sekiz başlık kod düzeltmesi gerektirdi;
bir başlık aynı telemetri hatasının tekrarıdır, iki başlık mevcut sözleşmeyle uyuşmaz.

| Küme | Yorum kimlikleri | Sonuç ve odaklı doğrulama |
| --- | --- | --- |
| Kalan telemetri durumu | 4332597100, 4332918304 (tekrar) | Eksik `grounding.abstained` sıfırlanır; mevcut sayaçlar ve sonraki artışlar korunur. |
| Ret sınıfı | 4332605939 | Sınırlı küçük harfle başlayan doğrulayıcı son ekleri ayrı sayılır; eşleşmezse yalnızca kayıtlı büyük harfli araç hata kodları kullanılır. Tür sayısı sınırı ve `invalid` geri dönüşü korunur. |
| Sınırlı öğe ve bölme onarımı | 4332903844, 4334001052 | Hatalı alan yolu kaldırılabilir; geçerli kardeşler birebir kalır. Önceki pimle eşleşmiş bölme aynı sunucu anlık görüntüsüne yeniden bağlanır; sonraki ret yalnızca kendi hatalı yolunu açar. Kapsam/ölçü/kardeş kaybı reddedilir. |
| Korumalı metin | 4332605953 | Son jokerden önceki alan kullanılır; `activity.changes` karma hatada da sıfır okumayla izin uyarısı verir. |
| Windows süreç sahipliği | 4332918294 | Çıkmış veya sinyalle bitmiş kök için `taskkill` çağrılmaz; yaşayan kökün mevcut ağaç temizliği korunur. Platform ikizi bu üç durumu doğrular. |
| Anlamsal artifakt reddi | 4333626923 | Bayatlık ve satır sayısı için sabit doğrulayıcı nedenleri ile 136 soruluk `input` komutu gösterilir. Ham iç hata/artifakt içeriği yansıtılmaz. |
| Model raporu | 4333626929 | Beklenen/gözlenen model, anlamsal kip, kapı sonucu, zayıf model hedefi ve dört karar sınıfı gösterilir. Mevcut özel model değerlendirmesi kısıtlanmaz; daha güçlü model raporda açıkça ayrılır. |
| Birincil çağrı sözleşmesi | 4332605932 | Kod değişmedi: `additionalRequests` ile açık çağrı reddedilir; `onPlanned.calls` ilk yürütme kümesidir ve yalnızca birincil isteğe bağlıdır. Sekiz çok bölümlü kıyas örneğinin tamamında doğrulandı. Puanlayıcı daha izinli yapılmadı. |
| Bağımlı bölüm notu | 4333626936 | Kod değişmedi: bölüm önceden `completeRequest` ile doğrulanır; örnekleme yalnızca aynı türde `from` yerine `id` koyar. Boş çağrılı tamamlama kimlik değerine göre farklılaşmaz. İki bağımlı kıyas biçimi ve mevcut satır/bütçe sınamaları doğrulandı. Not gerçekleşen başarı sayısını değil üç kaynak kaydı sınırını bildirir. |

Sekiz odaklı regresyon seçimi başlangıç kodunda başarısız olup düzeltmelerden sonra geçer.
Üretim sınırları, onarım/çağrı bütçeleri, kimlik ve yetki sözleşmeleri değişmez; yeni uç, araç,
bağımlılık, girdi biçimi veya Aşama 4D davranışı yoktur. Gerçek model kabul kapısı hâlâ bekler.

### Aynı gün — dört yeni başlığın sınırlı düzeltmesi

Başlangıç HEAD: `3d704735293e4e0208a94af199134758443ef078`. Düzenlemeden önce okunan
`FROZEN_UNRESOLVED_SET` yalnızca şu dört başlıktır:

```text
PRRT_kwDOSQ6ZIs6ur61x
PRRT_kwDOSQ6ZIs6usLiQ
PRRT_kwDOSQ6ZIs6usdfm
PRRT_kwDOSQ6ZIs6ustXB
```

| Yorum | Kök neden ve düzeltme |
| --- | --- |
| 4334728587 | Bağımlı örnekler aynı bölüm kimliğini paylaşır. Sunucunun eksik bölüm notu birleştirmede bölüm başına bir kez yazılır; farklı bölümlerin notları, geçerli sonuçlar, kanıtlar ve takip sınırı korunur. |
| 4334839380 | Telemetri denetim notu düzeltildi: küçük harfle başlayan sınırlı doğrulayıcı son ekleri ve kayıtlı büyük harfli araç kodu geri dönüşü birlikte açıklanır. Çalışan sınıflandırma değiştirilmedi. |
| 4334958867 | Anlamsal koşu doğrulayıcısının sabit retleri kendi içinde işaretlenir. Planlayıcı değerlendiricisi bu retlerin tamamını gösterir; işaretlenmemiş beklenmeyen iç hatanın iletisini gizler ve koşuyu yine reddeder. Artifakt değerleri yansıtılmaz. |
| 4335062436 | Sonraki reddin sunucu tarafından ilgisiz bulunan çağrıları, mevcut onarım anlık görüntüsüne erken dönüşten önce eklenir; kanonik okuma anahtarıyla tekilleştirilir. Hem mevcut pim hem eşleşmiş bölmenin yeniden bağlanması aynı birleşik izinleri kullanır. Geçerli kapsam ve ilgisiz yeni bölüm yasağı korunur. |

Üç davranış regresyonu başlangıç kodunda başarısız oldu. Düzeltmelerden sonra eksik/karma bağımlı
sonuçlar, üç bildirimli onarımın iki anlık görüntü yolu, kapsam değişikliği olumsuzları ve sabit
anlamsal ret nedenleri doğrulanır. Yürütme/onarım bütçesi, kabul edilen girdi ve yetki sınırı değişmez.

### Aynı gün — iki yeni başlığın sınırlı düzeltmesi

Başlangıç HEAD: `ab53343e6af7ebe363c66a2ae088ff87938d9e2d`. Düzenleme öncesi
`FROZEN_UNRESOLVED_SET`: `PRRT_kwDOSQ6ZIs6uutPj`, `PRRT_kwDOSQ6ZIs6uxrTk`.

- **4335905669:** §12.1 ve §12.10 mevcut §7.5 sözleşmesine uyarlandı. Anahtar/kimlik/yetki
  hatalarının yukarı taşınması ile `AI_CONFIGURATION_ERROR` danışmanlık kaybı ayrıldı;
  çalışma zamanı hata sınıflandırması değiştirilmedi.
- **4337155666:** Çok bölümlü doğrulama birincil hata yüzünden durmaz. Bütün bölümlerin şema ve
  yetenek sorunları kendi yollarıyla aynı rette toplanır; onarım yalnızca bu yolları açar. Kaynak
  bölüm geçersizse bağımlı kaynak kontrolü ertelenir; plan yine bütünüyle reddedilir ve düzeltilmiş
  planda kontrol yeniden yapılır. Kaynak indisleri hatalı kardeşler yüzünden kaymaz.

Odaklı sınamalar iki/üç bölümün birlikte onarımını, birincil ve ek bağımlı kaynaklarını, geçerli
kardeş kapsamının korunmasını ve sıfır veri okumasıyla reddi kapsar. Bütçe, araç, yetki, girdi
biçimi veya Aşama 4D davranışı eklenmedi.

### 23 Ekim 2026 — sağlayıcı uyumluluğu ve takip nitelendirmesi

`chat.tools` için adlı araç seçiminin `auto` tel biçimine çevrilmesi, varsayılan model kimliği
yerine ağ geçidinin etkin kayıttan doğruladığı profil üzerinden belirlenir. Özel kayıt başka model
seçse de standart profil aynı uyumluluğu kullanır; aynı modelin `chat.tools.reasoning` profili adlı
seçimi, açık `none` seçimi de veri aracı yasağını korur. Plan doğrulaması değişmez.

Takip nitelendirmesinde gerçek model yanıtları `native: true` ile sınama sağlayıcısına aktarılır.
Metindeki veya araç önsözündeki JSON plan bildirimi yerel araç çağrısına dönüştürülmez; yalnızca
modelin gerçekten ürettiği araç çağrıları korunur. Metin planı üretimdeki ret ve sınırlı onarım
yolundan geçer. Regresyonlar özel kayıt/standart/Derin seçimini, gerçek metin/önsöz/yerel çağrı
ayrımını ve veri okumadan metin planının reddini doğrular. Gerçek model kabul kapısı hâlâ bekler.

## 13. Aşama 4D — kanıta bağlı anlatım ve odak görünümü (UYGULANDI — kurum içi kabul AÇIK)

### 13.1 Amaç ve güven sınırı

**Sunucu neyin doğru olduğunu belirler; model doğrulanmış doğruların insana nasıl anlatılacağını belirler.**

4C'de doğrulanmış yanıt sunucunun belirlenimci anlatımıyla (`renderVerifiedNarrative`) yazılıyordu: doğru ama
kalıplı. 4D aynı doğrulanmış kanıtın üstüne isteğe bağlı bir anlatım katmanı ekler. Olgular ve olgusal ilişkiler —
sayım, ad, tarih, süre, oran, durum, öncelik, kapsam, sahiplik, sıra, en büyük/en küçük, karşılaştırma, çoğunluk,
gruplama ve kaynak — sunucunundur ve kanıta bağlıdır. Model yalnızca sunucunun yazdığı önermelerden hangilerinin
soruyu yanıtladığını, sırasını, paragraflarını ve tablo/grafiğe yönlendirmesini seçer. Kimlik (Sicil), yetki, SQL,
hesap, kanıt, kapsam notu ve kalıcı kanıt kaydı değişmez; anlatım kanıt değildir ve kanıt kümesini değiştiremez.
Anlatım kurulamazsa ya da doğrulanamazsa doğrulanmış belirlenimci anlatım **değişmeden** gösterilir: insan anlatımı
bir iyileştirmedir, olgusal doğruluğun önkoşulu değildir.

### 13.2 Neden 4D bir süre 4C gibi görünüyordu (tarihçe)

İlk 4D sürümü (PR #105) modelin kendi paragraflarını doğrulanmış yuvalarla (`{F1}`) yazmasına izin veriyordu.
İnceleme şu kusurları buldu: geçerli yuvaların çevresine yanlış karşılaştırma/sıralama cümlesi yazılabiliyordu,
satır adları ve değerleri çapraz eşlenebiliyordu, yuva dışına yazıyla sayı yazılabiliyordu; bunları yakalamak
Türkçe/İngilizce sayı ve karşılaştırma sözcüğü denetimine (ve "bir görev" gibi doğal Türkçenin reddine) gidiyordu.
Gömülü yuvaların doğruluğu, keyfî cümlenin anlamsal doğruluğunu kanıtlamaz. Yakınsama bu nedenle serbest model
metnini tamamen kaldırdı ve model yalnızca `details`/`rows`/`chart` bloklarını seçer oldu: güvenliydi, ama anlatımın
tamamı yine 4C cümleleriydi. PR #107 güvenlik düzeltmeleri bu durumun nedeni değildir.

Güncel tasarım ikisini birleştirir: modelin anlatım gücü geri gelir, ama model HİÇBİR ZAMAN serbest kelime yazmaz.
Kullanıcıya ulaşan her karakter ya sunucunun önerme cümlesi, ya sunucunun yönlendirme cümlesi, ya da sunucunun
tablosu/grafiği/ayrıntısıdır. Modelin karakterlerini gösteren her kanal keyfî bir önerme taşıyabilir ve bunu dil
anlamadan engellemek mümkün değildir; bu yüzden güvenlik sınırı metin değil, kimlik seçimidir.

### 13.3 Akış — `src/server/ai/assistant/groundedAnswer.js` → `answerComposition.js`

1. Tur 4C yolunda doğrulanır (`analyzeGroundedAnswer` sunum için olguları da döndürür: `presentation`).
2. `compositionInput` doğrulanmış bölümleri, tamamlanamayan bölümleri (yalnızca konu etiketi) ve sunucu notlarını
   toplar. Eksik bölümün notu konusuyla yazılır (ör. `**Outlook takvimi:** Rota verisine şu anda ulaşılamıyor.`).
3. `buildComposition` (`src/domain/ai/groundedComposition.js`) sayfayı kurar: `language`, `today`, `question`, bölüm
   sayısı `parts`, önermeler `P#` (`kind` ve düz metin), tablolar `T#` (sütunlar `C#`), önermeyle temsil edilmeyen
   ayrıntılar `D#`, grafik adayları `G#` ve tamamlanamayan bölümler `missing`; doğrulanmış takip bağlamı varsa
   `previousQuestion`. Sayfa kimlik, kanıt kimliği, ham alan yolu, SQL, araç dökümü ya da Sicil taşımaz.
4. Güncel yetki yeniden doğrulanır; düzen turu **aynı oturumda**, `tools: []`, `toolChoice: "none"`, iki iletiyle
   (bayt bayt sabit yönerge + sayfa) yürür. Konuşma geçmişi, araç sonuçları ve önceki asistan metni gönderilmez.
5. `validateComposition` yanıtı yapısal sözleşmeye göre denetler; `renderComposition` geçerli düzeni Markdown'a
   çevirir. Düzen tamamlandıktan sonra güncel yetki tekrar doğrulanır; ancak bundan sonra yanıt ve kalıcı kanıt
   kurulur. Yetki geri alındıysa kullanılamıyor yanıtı verilir, yetkisiz kanıt kaydedilmez.

Akış evresi `composing` olarak yayımlanır; arayüz "Yanıt yazılıyor…" gösterir. Düzen turundaki sağlayıcı
olayları dış üretim gözcüsüne ilerleme bildirir; ham düzen çıktısı kullanıcıya aktarılmaz.

### 13.4 Sunucunun önermeleri — `src/domain/ai/groundedPropositions.js`

| Tür | Türetildiği yer | Önkoşul (sağlanmazsa önerme yoktur) | Örnek (tr) |
| --- | --- | --- | --- |
| `count` | Yalnızca zarf sayısından oluşan ayrıntının `totalCount` olgusu; sayım ölçüsü seçilmemiş görev listesinde atfedilen kanıtın kesin toplamı | Sayı bilinir (null değil); liste kanıtında okuma nüfusun tamamıdır (tam, kesilmemiş, imleçsiz, döndürülen = kesin toplam) ve tablo bütün satırları taşır (tek görevlik tam nüfus da sayımdır) | Şu anda **4** gecikmiş göreviniz var. |
| `maximum` / `minimum` | Satır tablosunun sayısal (yoksa tarih) sütunu | Bütün satırlar tam kanıttan, koleksiyonun tamamı gösterilir ve `totalCount` = satır sayısı; değerler farklı; ad yalnızca değerin tek sahibi ve tabloda tekil adı varsa | En uzun süredir geciken görev **X** (**9 gün**). / En uzun gecikme **9 gün**. |
| `total` | `rota_task_analytics` gruplarının **`tasks.total`** sütunu (açık/gecikmiş/tamamlanmış alt kümesi bütün görevlerin paydası değildir; ölçü kimliği kanıtın türüdür) | Grup boyutu birbirini dışlar (`status`, `priority`, `project`, `deadline`, `target_month`; kişi grupları değil), dağılım tam (tek grup da olabilir), toplam > 0 | Toplam **165** göreviniz var. |
| `majority` | Aynı dağılım | Tekil en büyük grup, payı %50'yi aşar ve tek dolu grup değildir; gösterilen pay da %50'yi aşar (tam sayı %50 gösterecekse en az ondalıkla aşağı kesilir: 1001/2000 → %50,05) | Görevlerinizin büyük bölümü (**%69**) **Tamamlandı** durumunda. |
| `largest` | Aynı dağılım | Tekil en büyük grup, pay ≤ %50 | En büyük grup **Yapılacak**: **40** görev (**%40**). |
| `breakdown` | Aynı dağılım | En çok 8 grup | Durumlara göre: Tamamlandı **114**, Yapılacak **47**, Devam ediyor **4**. |
| `completion` | Durum dağılımı (`groupBy: status`) | Bütün grup anahtarları `todo`/`in_progress`/`done`; tamamlanan ve açık görev var | Görevlerinizin **%69**'u tamamlandı; **51** görev hâlâ açık. |
| `average` | Satır tablosunun sayısal sütunu | Bütün nüfus; en az 3 satır (bütün satır istatistikleri en az 2 satır ister) | Gecikmelerin ortalaması **5,3 gün**. |
| `threshold` | `task.overdueDays` sütunu | Bütün nüfus; sabit eşik 7 gün ("bir haftayı aşan" = 7'den büyük) | **4** görevin **1**'i bir haftadan uzun süredir gecikmiş. |
| `concentration` | Görev koleksiyonu satırlarının doğrulanmış proje bağlamı | Bütün nüfus; her satırın proje KİMLİĞİ var (gruplama kimlikle, ad yalnızca gösterim; aynı adlı iki proje bir proje değildir ve adla öne çıkarılmaz) | Bu görevlerin tamamı **PAYKDM Bölüm Faaliyetleri** projesinde. |
| `span` | Tarih sütunu (sayısal önerme yoksa) | Bütün nüfus; değerler farklı | Terminler **26 Ekim 2026** ile **30 Ekim 2026** arasında. |

Her önermenin sunucu tonu vardır (`info`, `warning`, `success`): gecikmiş sayım, en uzun gecikme ve bir haftayı aşan
gecikme `warning`; bir haftayı aşan gecikme olmaması ve tamamlananların çoğunluğu `success`; diğerleri `info`. Ton
olgu değildir, yalnızca not kutusunun rengini seçer; model tonu seçemez ya da değiştiremez. Sayfa ayrıca bölüm başına
en çok bir başlık adayı (`H#`, ör. "Gecikmiş görevleriniz", "Görevlerinizin durum dağılımı") taşır; başlık yalnızca
nüfusu adlandırır, sayı ya da ilişki içermez ve süzgeçler doğal olarak ifade edilemiyorsa sunulmaz.

Sayım cümlesinin nüfus betimi süzgeçlerden üretilir (sorumlu ben/sorumlusuz, termin kovası, durum, öncelik, proje,
termin aralığı). Süzgeçlerin TAMAMI doğal olarak ifade edilemiyorsa (ör. başlık araması, kişi, WBS) önerme sunucunun
ölçütlü belirlenimci cümlesidir (`Eşleşen 4 görev bulundu (ölçüt: …)`). Kilometre taşı süzgecinin iki değeri de
(`false` kilometre taşlarını dışlar) nüfusu daraltır; doğal cümle onu düşürüp "2 göreviniz var" demez. Başlık da termin
aralığını (tek uçlu ve gruplanmış dahil) taşır ya da hiç sunulmaz; nüfusu genişletmez. Paylar tam sayı yüzdedir; sıfırdan büyük ve
tamamdan küçük pay %0 ya da %100 görünmez. Tablonun `_Ölçüt: …_` satırı kapsam etiketi olarak her zaman korunur.
Sayfada en çok 12 önerme vardır; bütün sayımlar türetilmiş önermelerden önce gelir. Bütün cümleler ve değer
biçimleri (`**…**`, kaçış) sunucunundur; model metni hiçbir zaman okunmaz ya da yorumlanmaz.

### 13.5 Anlatım sözleşmesi ve yapısal doğrulayıcı

Model yalnızca tek JSON nesnesi döndürür: `{"blocks":[...]}` (en çok 12 blok).

- `{"type":"title","source":"H1"}` — isteğe bağlı başlık (`#### …`); son blok olamaz, her aday bir kez.
- `{"type":"say","items":["P1","P2","P3","T1"]}` — paragraf (en çok 4 paragraf, paragrafta en çok 8 kimlik). `P#`
  önermedir; `T#`/`G#` ise paragrafın **hemen ardından** çizilen tabloya/grafiğe yönlendiren sunucu cümlesidir
  ("Ayrıntıları aşağıdaki tabloda görebilirsiniz.", "Dağılımı aşağıdaki grafikte görebilirsiniz."). Sayfada her önerme
  kaynak bağını kimlikle taşır (`table: "T1"`, sütuna dayanıyorsa `column: "C2"`); grafik `G#` yalnızca paragraftaki
  bir önerme aynı tablo ve sütundansa seçilebilir.
- `{"type":"rows","source":"T1","style":"table|list"}` — her tablo bir kez zorunlu; açık düzen tercihi önceliklidir.
- `{"type":"chart","source":"G1","style":"bar|donut"}` — isteğe bağlı; adayın türlerinden biri; ilk blok olamaz.
- `{"type":"note","items":["P5"]}` — not kutusu (en çok 2 kutu, kutuda en çok 3 önerme, yalnızca `P#`); ilk blok olamaz.
  Çizim `> [!warning]` / `> [!success]` / `> [!info]` işaretli alıntıdır; ton önermelerin sunucu tonudur (karışık tonlar
  `info`), etiket sunucunundur (**Dikkat**, **Olumlu**, **Öne çıkan**). İstemci yalnızca bu üç işareti tanır ve alıntıyı
  tema renkli kutu olarak çizer (`--status-overdue`, `--status-done`, `--c-blue`; kutudaki değerler tonun rengini alır);
  işaret ne görünür ne kopyalanır. Kayıt adındaki `[`, `!`, `#` kaçışlıdır: veri işaret ya da başlık açamaz.
- `{"type":"details","source":"D1"}` — sunucunun hazır ayrıntısı.

Yönerge zayıf modelden analist üslubu ister: başlık varsa onunla başlar, ilk paragraf soruyu doğrudan yanıtlar ve
sayfada varsa 3–5 önermeyi birleştirir (önce sayım/toplam, sonra en anlamlı ilişkiler), ardından tablo/grafik ve
uygunsa `warning`/`success` tonlu bir not kutusu gelir. Zengin kanıt zengin anlatım ister: sayfada önerme varsa düzen
en az bir paragraf ve en az üç önerme (sayfada daha azı varsa hepsini) söyler; yalnızca tablo ya da başlık 4C görünümüdür
ve reddedilir (`NARRATION_REQUIRED`). Seyrek kanıtta (bir-iki önerme) kısa anlatım doğrudur; dolgu istenmez. Örnek çıktı:

```
#### Gecikmiş görevleriniz

Şu anda **4** gecikmiş göreviniz var. En uzun gecikme **9 gün**. Gecikmelerin ortalaması **5,3 gün**. Bu görevlerin
tamamı **PAYKDM · PAYKDM Bölüm Faaliyetleri** projesinde. Ayrıntıları aşağıdaki tabloda görebilirsiniz. 【R1】

(tablo)

> [!warning]
> **Dikkat:** **4** görevin **1**'i bir haftadan uzun süredir gecikmiş. 【R1】
```

Doğrulama yalnızca yapıyı denetler: tam anahtar kümesi, bilinen kimlik (`UNKNOWN_PROPOSITION`, `UNKNOWN_SOURCE`),
yinelenmeyen önerme/kaynak/yönlendirme (`DUPLICATE_*`), yönlendirmenin paragrafın hemen ardındaki kanıt bloğu olması
(`POINTER_TARGET`: paragrafın k yönlendirmesi ondan sonraki ilk k tablo/grafik bloğudur), yönlendirilen bloğun
paragraftaki bir önermeyi desteklemesi (`POINTER_PROVENANCE`: tablo kendi kanıtının önermelerini, grafik yalnızca
gösterdiği sütunun önermelerini), bölüm sahipliği (`PART_MIXED`: paragraf/not tek bölümün kimliklerini taşır;
`PART_SCOPE`: başlık, ardından gelen blokların bölümünü adlandırır — başlığı olmayan bir bölüm varsa çok bölümlü
sayfada başlık hiç sunulmaz), anlatım (`NARRATION_REQUIRED`), paragraf ve
not sınırları (`SAY_INVALID`, `NOTE_INVALID`), ilk bloğun grafik ya da not, son bloğun başlık olmaması (`LEAD_REQUIRED`) ve bütün tabloların kapsamı
(`COVERAGE_INCOMPLETE`). Tek normalleştirme: paragrafta söylenen önerme sonraki not kutusunda da seçildiyse paragraftan
çıkarılır (yalnızca kutuda kalır; boşalan paragraf düşer); kutudan sonra yeniden söyleme ya da iki kutuda kullanma
reddedilir. Paragraf, başlık ve not metin ya da ton taşımaz; metin/ton taşıyan her alan (`text`, `tone`, eski `paragraph`,
`points`, `heading`, `assessment`) `BLOCK_INVALID`'dir. Doğrulayıcıda dil, sözcük listesi, sayı sözcüğü, çekim eki ya da
kalıp yoktur (sınama doğrulayıcı kaynağında metin deseni olmadığını da denetler). Türetilmemiş bir ilişkiyi
(ör. sayfada olmayan "en kısa gecikme") iddia etmenin tek yolu sayfada olmayan bir kimlik yazmaktır ve bu yapısal
olarak reddedilir.

Çizim: söylenen sayım önermesi kendi ayrıntısının yerine geçer (ayrıntı yinelenmez); söylenmeyen her ayrıntı
sunucu tarafından eklenir. Paragraf, önermelerinin kanıt kimlikleriyle (`【R1】`) biter; atıflar yanıtın doğrulanmış
kanıt kümesinin dışına çıkamaz (`CITATION_SCOPE`). Önerme ve tablo birlikteyse ya da birden çok önerme varsa anlatım
modelindir; tek başına tek önerme (ör. yalnızca sayım) model turu açmaz (`NO_CHOICE`) ve belirlenimci anlatım gösterilir.

### 13.6 Bütçe, süre ve devir

| Kip | Düzen turu çıktı sınırı | Tur sayısı (sunucu seçimli yanıt) | Anlatım devri |
| --- | --- | --- | --- |
| Standart (`chat.tools`) | 1200 belirteç (`COMPOSITION_RUNTIME.maxOutputTokens`) | plan + düzen = 2 | En çok 1 (yalnızca yapısal ret, boş ya da kesik düzen) |
| Derin (`chat.tools.reasoning`) | Profil sınırı (akıl yürütme payı) | plan + düzen = 2 | Yok |

Düzen turunun kendi süre penceresi vardır (en çok 60 sn; oturumun kalan süresinden son yetki okumasının 8 sn bütçesi
ve 5 sn teslim payı ayrılır; kalan düzen penceresi 8 sn'den azsa düzen istenmez — `BUDGET`). Düzeltme turu yoktur.

**Anlatım devri** (`NARRATION_ESCALATION`): Standart anlatım `INVALID`, `EMPTY` ya da `LENGTH` ile biterse, Derin
profili kuruluysa, tur henüz devretmediyse ve ortak süreden en az 30 sn kaldıysa, aynı önerme sayfası (aynı iki
ileti: sabit yönerge ve sayfa) Derin oturumuna BİR kez gönderilir. Derin kuyruğu en çok 5 sn beklenir. Derin'e zayıf
modelin düzeni, plan, araç dökümü ya da kanıt yükü gönderilmez. Derin de başarısız olursa, oturum açılamazsa ya da
hata verirse doğrulanmış belirlenimci anlatım gösterilir. Derin anlatımın ortak yaşam döngüsü süresi dolsa da
(`AI_TIMEOUT`) doğrulanmış yanıt teslim edilir: süre yalnızca model denemesini bitirir; son yetki doğrulaması süresi
dolmuş oturum sinyaliyle değil, isteğin kendi iptal sinyaline bağlı taze ve sınırlı bir okumayla (`callTimeoutMs`)
yapılır. Model süresi uzatılmaz, yetki denetimi atlanmaz. Sağlayıcı hatası, süre ve `BUDGET` devredilmez: yanıt zaten
doğrudur; kullanıcı yalnızca daha güzel bir cümle için bekletilmez.

### 13.7 Planlayıcı devri — temiz yeniden planlama

Devir turda **en fazla bir kez** olur ve iki biçimi vardır (`escalation.kind`):

- `plan` — zayıf modelin planı doğrulanamadı: bildirim reddi tek ucuz düzeltmeden sonra da sürdü
  (`REQUEST_DECLARATION`), boş yanıt yeniden denemeden sonra da sürdü (`EMPTY_COMPLETION`), uzunluk sınırı (`LENGTH`)
  ya da veri okunduğu hâlde kanıt bildirilen isteği karşılamadı ve onarım tükendi (`VERIFICATION_FAILED`). Deneme
  **atılır**: bildirim, plan, onarım izleri, sunucunun kabul/yönlendirme notları ve araç alışverişleri. Veri
  okunduysa kanıt defteri, araç kapsamı ve okuma kaydı da yenilenir; atılan kanıt ne Derin'e ne kullanıcıya açılır,
  kalıcı kayda girmez. Derin yalnızca kanonik başlangıcı görür (sistem yönergesi, sınırlı geçmiş, sunucunun tur
  başı notları: önceki sonuç kapsamı, anlamsal aday sırası, metin alanı notu; kullanıcının sorusu) ve tek bir makine
  okunur neden notu: `SUNUCU: … önceki planlama denemesi doğrulamadan geçmedi ve atıldı (neden: VERIFICATION_FAILED) …`.
- `select` — istek veri okunduktan sonra donmuştur ve kanıt onu belirlenimci olarak karşılar (sentez gereksinimi ya
  da seçim/biçim hatası). Derin aynı kanıtla yalnızca son seçimi yapar; dökümde onarım notları ve reddedilen planlar
  yoktur.

Bütçeler: Standart deneme tek ucuz bildirim düzeltmesi kullanır (devir yoksa — Derin kip ya da Derin profili yok —
iki); Derin'in temiz yeniden planlaması da tek düzeltme hakkıyla başlar (turda en çok iki bildirim düzeltmesi).
Temiz yeniden başlangıç bir model/kanıt bağlamı yenilemesidir, kaynak bütçesi yenilemesi değil: ortak bütçeler (toplam
çağrı, toplam sonuç boyutu, araç turu, araç evresi süresi, SQL süresi, mutlak üretim süresi) atılan denemenin
harcamasıyla daralır ve tükenmiş kanıt onarımı yeniden açılmaz. Yeniden planlama yalnızca kanıt varken, hiçbir okuma
hata vermemişken, doğrulanmış bir bölüm yokken, en az iki çağrı, bir araç turu ve araç evresi süresi kalmışken açılır; `NOT_FOUND`, kapsam dışı, desteklenmeyen istek ya da
SQL/altyapı hatası devri engeller. Sıra hep `Standart → (tek düzeltme) → Derin → güvenli açıklama/ret/başarısızlık`
biçimindedir; Derin'den Standart'a dönüş ya da ikinci devir yoktur.

Gerekçe ("istek veri okunduktan sonra değiştirilemez" kuralı): kural, modelin okuduğu veriye göre isteğini
değiştirmesini engeller. Temiz yeniden planlamada Derin atılan denemenin verisini hiç görmez; kendi isteğini kendi
okumasından önce bildirir. Kullanıcıya ve kalıcı kayda yalnızca Derin'in kendi okumasının kanıtı ulaşır.

Zayıf model için ek önlemler: planlayıcıya gösterilen `rota_plan` şeması ölçü kimliklerinin kapalı listesini yalnızca
`metrics` içinde bir kez taşır (`fields`/`bindings`/`rank` aynı kimliği yineler); şema ~58 bin karakterden ~29 bine
iner, sunucunun doğrulama şeması (`requestSchema`) değişmez. Yönerge, boyutu söylenmemiş dağılım/grafik/özet
isteğinde `groupBy: "status"` varsayılanını modele söyler (yorum modelindir; sunucu cümleyi anahtar sözcükle
yorumlamaz).

### 13.8 Grafikler — `src/domain/ai/answerChart.js`, `src/features/ai/assistant/AnswerChart.jsx`

Grafik yalnızca sayfadaki aday (`G#`) seçilerek istenir; tanımı sunucu kurar: `{version:1, type, locale, title, unit,
evidence, items}` kapalı anahtarlarla, `bar` (2–12 öge) ya da `donut` (2–6 öge; yalnızca `rota_task_analytics`
gruplarının tam ve pozitif toplamlı sayımı; gösterilen satırlar kanıttaki bütün grupları kapsamalıdır, yalnız üst grupları gösteren sıralama halka olamaz). Birimler `count`, `days`, `hours`, `percent`, `number`; değerler sonlu ve
negatif değildir; renk, URL, HTML ya da SVG taşımaz. İstemci tanımı yeniden doğrular ve yalnızca bütün `evidence`
kimlikleri o yanıtın kanıtlarındaysa çizer; aksi hâlde (kanıtsız yanıt ve genel sohbet dâhil) ham tanımı da göstermez.
Kopyalanan metin aynı kuralla grafiğin düz veri karşılığını taşır. Çizim uygulamanın ortak zengin ipucunu
(`Tooltip`, fare ve klavye), ortak halka geometrisini ve tema renk belirteçlerini kullanır; satırlar tek sekme
durağıdır ve ok/Home/End ile gezilir. Halka vurgusu ve ipucu, ortak `Tooltip` bileşeninin kalıcı odak sahipliğini izler; fare tıklamasının DOM odağı başka dilimlerin fare ipuçlarını engellemez. İpucunda değer, halkada toplamdaki pay, çubukta sıra ve kaynak gösterilir.

### 13.9 Takip soruları

Takip sözleşmesi 4C'dir (önceki doğrulanmış görev kümesi ya da onun bir satırı güncel yetkiyle yeniden okunur). Düzen
sayfası yalnızca yanıt önceki kümeye ya da onun satırına dayanıyorsa önceki kullanıcı sorusunu bağlam olarak taşır
(`previousQuestion`); önceki asistan metni hiçbir zaman taşınmaz. Kısmi çok bölümlü yanıtta (bir bölüm
tamamlanamadı) doğrulanmış tek liste bölümünün kümesi sonraki takip için korunur; tamamlanamayan bölüm gönderge adayı
sayılmaz. Uçtan uca sınamalar
(`test/ai-grounded-conversation-flows.test.mjs`) zamir, satır göndergesi, süzgeç ve zaman değişikliği, karşılaştırma,
açıklama sonrası istek, kısmi sonuç devamı, yetki değişikliği, talimat/yuva/HTML enjeksiyonu, zincirden sonra yeni
konu, genel yönlendirmeden sonra Rota sorusu, İngilizce zincir ve kısaltılmış uzun konuşmayı kapsar.

### 13.10 Günlük ve telemetri

Tur başına **tek** içeriksiz tamamlanma satırı (`ai.grounded.turn`): sonuç, seçim, `parts`, `evidence`,
`presentation` (`mode`, `reason`, `issue`, `blocks`, `said` söylenen önerme, `tables` çizilen tablo, `chart`, `charts`, `ms`,
`rejected` anlatım devrinde zayıf modelin reddedilen düzeninin kodu), `usage` (girdi, çıktı, akıl yürütme belirteci
toplamları, ilk olay süresi, `length` duruşları), varsa `escalation` (`kind`: `plan`|`select`|`narrate`, `reason`,
`models`, `toolsReused`, `outcome`; ayrı `ai.grounded.escalation` satırı kaldırıldı)
ve tur listesi (`purpose: "compose"` ile bütçe). Bağlam günlük temizleyicisinin nesne başına 25 alan sınırının
içindedir (sınama korur). Soru, yanıt, kayıt adı, kanıt, Sicil, anahtar ya da model çıktısı günlüğe yazılmaz;
reddedilen düzen metni de yazılmaz. Sayaçlar: `grounding.presentation` (`composed`, `narrative`, `unavailable`, `byReason`, `charts`).
`NO_CHOICE`, model turu gerekmeyen belirlenimci sunumdur; `BUDGET` ve sağlayıcı/çıktı hataları geri dönüş
nedenlerini ayırır. Metin sınırında anlatım teslim edilmişse `narrative` / `LENGTH`, anlatım da sığmadıysa
`unavailable` / `LENGTH_UNAVAILABLE` yazılır. Yetki kaybında kip `unavailable`, neden `AUTHORIZATION` olur.
`charts`, başarılı çizilen çit sayısıdır; reddedilen ya da kanıtına bağlı olmayan grafikler sayılmaz. Her belirteç
metriği ancak bütün model turları bildirdiyse toplanır; eksik metrik `null` kalır. Tur izi kesilmişse toplam tam görünmez.

Konsolda aynı bağlamdan kurulan kısa insan satırı yazılır (`MERGEN_ROTA_LOG_FORMAT`: `json`, `summary`, `both`;
ayarsız terminalde `summary`, yönlendirilmiş çıktıda `json`; ayrıntı ve örnekler Sistem Yönetimi §15.1). Önceki
yoğun satır ile karşılaştırma:

```
önce:  [mergen-rota] {"timestamp":"…","level":"INFO","component":"AI","operation":"ai.grounded.turn","code":"AI_GROUNDED_TURN",…,"context":{"outcome":"failed",…,"rounds":[{"purpose":"plan","profile":"chat.tools","model":"Qwen3-Next-80B-A3B-Instruct",…}, … sekiz tur …]}}
sonra: [mergen-rota] AI FAIL failed 7.1s | Qwen3-Next-80B-A3B-Instruct | rounds 5: plan, declaration, tools, select, repair | tools 1 | evidence 0 | 4D - | 60eda636
```

İşletim anahtarı: `MERGEN_ROTA_AI_ANSWER_COMPOSITION` (varsayılan `true`; geçersiz değer güvenle `false` sayılır ve
yapılandırma uyarısı verir). Kapalıyken model turu yoktur; 4C belirlenimci anlatımı aynen çalışır.

### 13.11 Nitelendirme — `scripts/answer-composition-qualification.mjs`

**Kanıta bağlı anlatımın küçük kapısı (`COMPOSITION_QUALIFICATION_STAGE=phase4d`).** Sekiz vaka; her vaka birden çok
sözleşme özelliğini birlikte sınar. Anlatım vakaları planlamayı betikler ve yalnızca anlatım turunu modele gönderir;
iki planlayıcı vakası (`planner: 'model'`) üretimin gerçek planlayıcı yönergesini, `rota_plan` aracını ve kataloğunu
da modele gönderir. Derin modele giden her çağrı modele gitmez, devir sayılır ve kapıyı düşürür. İlk altyapı
hatasında kalan vakalar koşmaz. `COMPOSITION_QUALIFICATION_CASE=<vaka>[,<vaka>…]` yalnızca o vakaları (ör. kodu değişen
vakayı) yeniden ölçer; aşamada olmayan (yanlış yazılmış) bir kimlik ya da boş seçim sınama kaydından önce reddedilir ve
hiç vaka koşmayan kapı başarı sayılmaz (`COMPOSITION_NO_CASES`, `COMPOSITION_CASES_NOT_RUN`). Kompozisyonlu her turda
sayfadaki önermelerin en az üçü (azsa hepsi) söylenmelidir (`NARRATION_TOO_THIN`).

```
COMPOSITION_QUALIFICATION_PROVIDER=claude COMPOSITION_QUALIFICATION_STAGE=phase4d \
  PLANNER_CLAUDE_LOG=cagri.jsonl PLANNER_CLAUDE_MAX_CALLS=12 PLANNER_CLAUDE_MAX_UNCACHED=150000 \
  node --test scripts/answer-composition-qualification.mjs
```

**Haiku 4.5 ölçümü (30 Ekim 2026, kanıta bağlı anlatım protokolü):** `claude-haiku-4-5-20251001`, çaba `low`,
düşünme kapalı (`MAX_THINKING_TOKENS=0`; her çağrıda düşünme belirteci 0, düşünme bloğu 0), her çağrıda tek API
çağrısı. Haiku yalnızca vekil zayıf modeldir; **Qwen üretim kabulünü kanıtlamaz.**

| Vaka | Sınanan | Model çağrısı | Sonuç |
| --- | --- | ---: | --- |
| `p4d-overdue` | Örnek A: sayım + en uzun gecikme + tablo | 1 anlatım | composed, 3 önerme, çubuk grafik |
| `p4d-my-tasks` | çok satırlı liste, insan girişi | 1 anlatım | composed, 3 önerme |
| `p4d-status-chart` | "grafik olarak göster": dağılım + grafik | 1 anlatım | composed, 3 önerme, grafik |
| `p4d-record` | tek kayıt sorgusu | 0 | narrative `NO_CHOICE` (tasarım gereği) |
| `p4d-multipart` | iki bölümlü soru | 1 anlatım | composed, 3 önerme |
| `p4d-followup` | önceki kümeye takip ("bunların") | 1 anlatım (bağlam turu betikli) | composed |
| `p4d-planner-distribution` | Örnek B: "görevlerimin dağılımını göster", gerçek planlayıcı | 1 plan + 1 anlatım | durum dağılımı planlandı; composed, halka grafik |
| `p4d-planner-overdue` | Örnek A, gerçek planlayıcı | 1 plan + 1 anlatım | composed, 3 önerme, grafik (aşağıdaki düzeltmeden sonra) |

İlk koşu: 9 çağrı, 7/8 vaka. Başarısız vakada Haiku "Kaç gecikmiş görevim var ve hangileri?" sorusunu doğru süzgeç ve
sırayla ama `tasks.total` ölçüsü olmadan planladı; sayfada sayım olmadığı için yanıt "kaç" sorusunu söylemedi (yanlış
olgu yoktu). Düzeltme yapısaldır: atfedilen `rota_task_search` kanıtı nüfusun tamamıysa (tam, kesilmemiş, imleçsiz,
döndürülen = kesin toplam) sunucu o kanıtın zarf sayısını sayım önermesi yapar (`populationSizes` →
`populationProposition`). Planlayıcı yönergesi değişmedi. Tanı için aynı vakanın bir koşusu (2 çağrı, plan içeriği
yalnızca yerel tanı çıktısında görüldü) ve düzeltmeden sonra yalnızca o vakanın yeniden ölçümü (2 çağrı) yapıldı:
8/8 vaka, Derin devri 0, geri dönüş 0 (`NO_CHOICE` dışında).

| Ölçüm | Ana koşu (9 çağrı) | Tanı + yeniden ölçüm (4 çağrı) | Toplam (13 çağrı) |
| --- | ---: | ---: | ---: |
| Önbelleksiz girdi belirteci | 9.957 | 2.770 | 12.727 |
| Önbelleğe yazılan girdi | 36.672 | 0 | 36.672 |
| Önbellekten okunan girdi | 34.381 | 71.058 | 105.439 |
| Çıktı belirteci | 1.328 | 626 | 1.954 |
| Düşünme belirteci | 0 | 0 | 0 |

**Zengin analist anlatımı yeniden ölçümü (başlık, not kutusu, yeni önerme türleri; yönerge değiştiği için yalnızca
anlatım vakaları).** İlk koşu 5 çağrı: 3/5 vaka; `p4d-overdue` ve `p4d-multipart` düzeni yapısal olarak reddedildi
(güvenli geri dönüş; Derin çağrısı nitelendirmede engellendi). Tek tanı çağrısı (ilk tanı denemesinin çıktısı kesildiği
için bir çağrı daha) nedeni gösterdi: Haiku vurgulamak istediği önermeyi hem paragrafa hem not kutusuna koymuştu
(`DUPLICATE_PROPOSITION`). Düzeltme yapısaldır: paragrafta söylenip sonraki not kutusunda vurgulanan önerme yalnızca
kutuda kalır (kimlik kümesi daralır, içerik eklenmez; başka her yineleme reddedilir); yönergeye "o önermeyi paragrafta
tekrar etme" eklendi. Yalnızca iki vakanın yeniden ölçümü (2 çağrı): ikisi de composed.

| Vaka (son ölçüm) | Başlık | Paragraftaki önerme | Not kutusu | Grafik |
| --- | --- | ---: | ---: | --- |
| `p4d-overdue` | var | 4 | 0 | çubuk |
| `p4d-my-tasks` | var | 3 | 0 | — |
| `p4d-status-chart` | var | 4 | 0 | halka |
| `p4d-multipart` | var | 4 | 1 | çubuk |
| `p4d-followup` (sayfada tek önerme) | — | 1 | 0 | — |

İki planlayıcı vakası önceki anlatım yönergesiyle ölçüldü; planlayıcı yönergesi bu adımda değişmedi ve yeniden
ölçülmedi. Bütün çalışmadaki toplam Haiku kullanımı: **22 çağrı**, önbelleksiz girdi **29.152**, önbelleğe yazılan
**36.672**, önbellekten okunan **105.439**, çıktı **3.357**, düşünme **0** belirteç; CLI ölçümüyle toplam ~49 sn.

Anlatım turu: girdi 1.274–1.925 belirteç (önerme sayfası + sabit yönerge; zengin sayfada ~1,6–1,9 bin), çıktı 74–210
belirteç, CLI üzerinden uçtan uca 1,7–2,5 sn (CLI başlatma payı dâhil). Planlayıcı turu: ~35,5 bin belirteçlik sabit önek
(yönerge + plan aracı + katalog; ilk çağrıda önbelleğe yazıldı, sonrakilerde okundu), çıktı 202–328 belirteç,
3,6–5,1 sn. Deterministik sınamaların yaptığı işler (şema, önerme hesabı, yetki, tablo/grafik aritmetiği) modele
yaptırılmadı.

Aşağıdaki eski Haiku ölçümleri önceki serbest metin protokolüne aittir; güncel protokolün model kabulü değildir.

Vakalar üretimdeki asistan hizmetinden geçer (konuşma kaydı, salt okunur araçlar, doğrulayıcılar, kalıcı kanıt, sayfa,
düzen doğrulayıcısı, çizici); planlama turları sabit `rota_plan` ile belirlenimcidir, yalnızca düzen turu modele
gider. Kabul üretimin kendisidir (düzen doğrulanıp çizildi mi), ayrıca beklenen doğrulanmış değerler ve çözülmemiş
yuva denetlenir. Rapor içerik taşımaz. Sağlayıcılar: `dry` (model yok; vakaların kuru sınaması), `claude`
(`scripts/planner-claude-model.mjs`, düşünme kapalı, en düşük çaba, çağrı ve önbelleksiz girdi bütçesiyle) ve `live`
(kurum içi uç). Aşamalar: `smoke` (2 vaka, 1 düzen turu), `targeted` (4 vaka, 5 düzen turu), `broad` (6 vaka, 6 düzen turu).
Her vaka `requiresComposition` sözleşmesini taşır. Düzen gereken turun gerçekten çağrılıp `composed` olması
zorunludur; geri dönüş model kabulü sayılmaz. Tek ayrıntılı `task-record`, `project-summary` ve `notifications`
vakaları çağrısız `narrative` / `NO_CHOICE` sonucuyla geçer. `live` ve `claude` koşusunda toplam model çağrısı
sıfırsa kapı düşer; `dry` dış model çağrısı gerektirmez.

```
COMPOSITION_QUALIFICATION_PROVIDER=claude COMPOSITION_QUALIFICATION_STAGE=smoke \
  PLANNER_CLAUDE_LOG=cagri.jsonl PLANNER_CLAUDE_MAX_CALLS=2 PLANNER_CLAUDE_MAX_UNCACHED=14000 \
  node --test scripts/answer-composition-qualification.mjs
```

**Haiku ölçümü (24 Ekim 2026, son yönerge ve son doğrulayıcı):** `claude-haiku-4-5-20251001`, çaba `low`, düşünme
kapalı, düşünme belirteci 0, her çağrıda tek API çağrısı, bitiş `end_turn`, Derin devri 0.

| Aşama | Düzen turu | Doğal düzen | Geri dönüş | Önbelleksiz girdi | Çıktı |
| --- | ---: | ---: | --- | ---: | ---: |
| smoke | 2 | 2 | — | 6.503 | 221 |
| targeted | 5 | 4 | 1 (`UNSUPPORTED_NUMBER`) | 16.786 | 650 |
| broad | 8 | 6 | 2 (`ROW_LABEL_REQUIRED`, `ROW_PAIRING`) | 26.472 | 887 |
| **Toplam** | **15** | **12** | **3** | **49.761** | **1.758** |

Düzen turu başına çıktı ortanca 116, en çok 184 belirteç; CLI üzerinden uçtan uca süre ortanca 2.678 ms (en az
1.921, en çok 3.448; CLI başlatma payı dâhil). Önbellek okuması gözlenmedi. Yedi yanıtta grafik seçildi.
Geri dönüşlerin üçü de doğrulanmış belirlenimci anlatımdır (yanlış yanıt değildir).

Yineleme geçmişi: aynı vakalarla önceki yönerge/doğrulayıcı sürümlerinde 14/15 doğal düzen ölçüldü; inceleme sonrası
eklenen yapısal kurallar (`ROW_PAIRING`, birden çok kayıtta kayıt adı, `ROW_ORDER`) doğruluk için daha katıdır ve
oranı 12/15'e indirdi. Tanı çağrıları ve bütün yinelemeler dâhil oturumda 100 çağrı, 321.975 önbelleksiz girdi ve
11.917 çıktı belirteci harcandı, düşünme belirteci 0; gözlenen en büyük düzen çıktısı 251 belirteçti. Ret nedenleri
(yuva dışında rakam, satır adı olmadan değer, çapraz eşleme, eksik kapsam, bozuk yuva sözdizimi, dayanaksız yorum,
eksik bölüm hakkında yorum) yönergeye ve doğrulayıcıya yansıtıldı. Haiku yalnızca vekil bir zayıf modeldir; **Qwen
üretim kabulünü kanıtlamaz.**

### 13.12 Kurum içi kabul yolu

Aynı vakalar kurum içi uçla, üretim sağlayıcı bağdaştırıcısıyla ve Standart profille koşar (uygulama dizininden
çalıştırılınca `.env.local` okunur; kabukta verilen değer önceliklidir):

```
COMPOSITION_QUALIFICATION_PROVIDER=live COMPOSITION_QUALIFICATION_STAGE=all \
  MERGEN_ROTA_AI_BASE_URL=https://<kurum-ici-uc>/v1 MERGEN_ROTA_AI_DEFAULT_API_KEY=<anahtar> \
  [MERGEN_ROTA_AI_MODEL_REGISTRY_PATH=config/ai-models.json] \
  COMPOSITION_QUALIFICATION_OUT=kabul.jsonl node --test scripts/answer-composition-qualification.mjs
```

Bu geliştirme ortamında kurum içi uca erişim olmadığı için gerçek modelle **çalıştırılmadı**; Qwen3-Next-80B-A3B-Instruct
üzerinde doğal düzen oranı, ret nedenleri ve gecikme ölçülmedi. Yolun kendisi (üretim sağlayıcı bağdaştırıcısı, gerçek
HTTP/SSE, model rotası, ölçüm) deponun OpenAI uyumlu sahte ağ geçidiyle (`test/helpers/fakeOpenAiCompatibleServer.mjs`)
sınanır. Güncel 12 vaka 12 düzen turu kullanır; 3 vaka tasarım gereği `NO_CHOICE` yolundadır. Bu, model kalitesi
ölçümü değildir. Uç ya da anahtar verilmezse komut veri okumadan durur. Kabul için önerilen kapı: Derin devri 0, değer denetimi
başarısızlığı 0, düzen turu bitişlerinde `length` 0 ve raporun `composed`/`narrative` dağılımının ve ret
nedenlerinin incelenmesi (geri dönüşler tasarım gereği doğru yanıttır, ancak doğal düzen oranı ürün kalitesini belirler).

### 13.13 Bilinen sınırlar

- Model kelime yazmaz: anlatımın ifade gücü sunucunun önerme türleriyle sınırlıdır (sayım, en büyük/en küçük,
  çoğunluk/en büyük grup, toplam, döküm ve yönlendirme). Eğilim, iki dönem karşılaştırması ya da neden-sonuç gibi
  ilişkiler için önce sunucuda belirlenimci önerme türü eklenmelidir; serbest model metni sözcük kurallarıyla açılamaz.
- Önerme türetimi görev araçlarına (`rota_task_search` satırları, `rota_task_analytics` grupları) odaklıdır; diğer
  araçların ayrıntıları belirlenimci cümle olarak kalır. Tek başına tek önerme (ör. yalnızca sayım) model turu açmaz.
- Düzeltme turu yoktur: geçersiz düzen en çok bir kez Derin anlatımına, o da olmazsa belirlenimci anlatıma döner.
- Planlayıcının anlam hatası (geçerli ama yanlış niyetli plan, ör. dağılım sorusuna liste) yapısal olarak
  saptanamaz; böyle bir plan doğrulanmış ama soruya uymayan bir yanıt üretebilir. Bunun önlemi daha dar şema ve
  yönergedir, sözcük sınıflandırması değildir.
- Grafik tek dizili çubuk ve halka ile sınırlıdır; zaman serisi ve çok dizili karşılaştırma yoktur.
- Kişi sonuç kümeleri 4C sözleşmesi gereği takip göndergesi değildir.
- Anlatım bir model turu ekler (Haiku/CLI ölçümünde 2,0–2,4 sn, girdi ~1,3–1,6 bin belirteç); kurum içi Qwen gecikmesi
  ölçülmedi. Önceden `NO_CHOICE` olan sayım + liste yanıtları artık anlatım turu açar.
- Odak görünümü yalnızca masaüstündedir ve panel kapanınca sıfırlanır.
