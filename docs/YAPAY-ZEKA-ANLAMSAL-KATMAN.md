# Rota AI · Anlamsal Katman (Aşama 4)

Bu belge Aşama 4'ün amacını, **dondurulmuş dört adımlı yol haritasını**,
değişmez güven sınırlarını ve Aşama 4A'da kurulan anlamsal sözleşme ile
değerlendirme temelini anlatır. Aşama 1–2 için
[YAPAY-ZEKA-PLATFORMU.md](YAPAY-ZEKA-PLATFORMU.md), Aşama 3 için
[YAPAY-ZEKA-ALAN-ARACLARI.md](YAPAY-ZEKA-ALAN-ARACLARI.md) esastır.

Belgede **UYGULANDI** yazan bölümler bugünkü depoda vardır ve sınanır;
**PLANLANDI (4B/4C/4D)** yazan bölümler henüz yoktur ve yalnızca sonraki
adımların sözleşmesidir.

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
| Aşama 3 yetkisinin aşılması = 0 | Aşama 4A canlı yola bağlanmaz; hiçbir üretim modülü anlamsal katmanı içe aktarmaz (`ai-semantic-contract`) |
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

### 4A — Anlamsal temel ve değerlendirme (UYGULANDI, bu adım)

- Anlamsal sözleşmeler ve güven sınırları; model çıktısının güvenilmez veri
  olarak doğrulanması; sürüm/parmak izi kavramı.
- Değerlendirme yöntemi ve ölçüleri; sentetik Türkçe kıyas kümesi.
- Model sınırının belirlenimci sınama ikizleri; gerçek model nitelendirme
  mekanizması; kurum içi kabul sözleşmesi.
- **Beklenen üretim davranışı değişikliği: YOK.** Hiçbir üretim modülü
  anlamsal katmanı içe aktarmaz.

### 4B — Gerçek anlamsal erişim ve yeniden sıralama (PLANLANDI)

- `embedding` ve `rerank` profilleri üzerinden (model kaydı esas) gerçek
  gömme ile aday keşfi ve sınırlı aday kümesinin yeniden sıralanması; ikisi
  aynı adımda birlikte yapılır.
- İlk kaynak Rota'nın kendi yetenek/araç anlamı ve açıkça güvenli katalog
  malzemesidir; doğal olduğu yerde kesin/yapısal sinyallerle birleştirilir.
- Sağlayıcı bağdaştırıcısı Aşama 1 ağ geçidi kurallarıyla (kimlik, kapasite,
  süre sınırı, iptal, telemetri) çalışır ve §6.1'deki model sınırı
  imzalarını uygular; anlamsal katman hatası Aşama 3 davranışına döner.
- Dizin kimliği (§6.2) yeniden kullanımdan önce karşılaştırılır.
- Vektör veritabanı **varsayılmaz**; ancak ölçülmüş bir gereksinim kanıtlanırsa
  ve yol haritası bilinçli olarak güncellenirse eklenebilir.
- Çıkış ölçütü: 4A kıyas kümesinde ölçülen ve belgelenen iyileşme; eşikler bu
  ölçümden sonra dondurulur.

### 4C — Akıllı planlayıcı ve zayıf model doğrulaması (PLANLANDI)

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

### 4D — İnsan kalitesinde yanıt ve kurum içi yakınsama (PLANLANDI)

- Doğrulanmış kanıttan doğal, açıklayıcı Türkçe yanıt (paragraf, kısa liste,
  karşılaştırma, açıklama); kanıta bağlılık korunur.
- Gerçek üretim/kurum içi modellerle (§8) doğrulama; Aşama 4'ün kapanışı.

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
| Katalog | Öğe: `id`, `kind` (kapalı küme: `tool`), `version`, `text`, `fingerprint`; en fazla 256 öğe, metin en fazla 4000 karakter, kimlik tekil; her tanım bir kez okunur, seyrek dizinin boşluğu da reddedilir. Bugünkü katalog Aşama 3 araç kayıt defterinin 19 aracıdır; metin aracın sunucuya ait açıklamasıdır (şema, işleyici, yetki belgesi girmez) |
| Model kökeni | Profil–yetenek uyumlu rota künyesinden: `embedding` profili `embedding`, `rerank` profili `rerank` yeteneğini taşımalıdır. Rotanın model kaydından çözülmesi çağıranın işidir (4B'de `resolveModelProfile`); nitelendirmede köken koşu dosyasının beyan ettiği kimliktir ve raporda öyle yazılır. Köken yetki taşımaz, yalnızca uzayı adlandırır. İş kodunda model adı yoktur |
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
kimliğe katılmaz.

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

Koşu kaydının kuralları:

- Biçim, sürüm (yalnızca 1), kıyas kümesi ve katalog parmak izi uyuşmazsa
  `SEMANTIC_RUN_STALE`.
- Vaka satırları kıyas kümesinin vakalarıdır; yabancı ya da yinelenen satır
  `SEMANTIC_RUN_INVALID`'dir (sessizce yok sayılmaz, ezilmez). Kaydı olmayan
  vaka reddedilmez; ıska sayılır.
- Sonuç ile yük tutarlıdır: `ok` dışındaki gömme aday taşımaz; yeniden
  sıralama kaydı yalnızca başarılı ilk aşamadan sonra vardır ve yalnızca `ok`
  ise sıra taşır; yeniden sıralanmış liste ilk aşamanın aday kümesinin bir
  **permütasyonudur** (aday ekleyemez, çıkaramaz).
- Aday listesi tam `min(limit, katalog)` uzunluktadır, kimlikler katalogda ve
  tekildir, skorlar sonlu ve artmayan sıradadır (benzerlik [-1, 1]).
- `ok` ve `timeout` gerekçe taşımaz; `invalid` ve `failed` güvenli kod taşır;
  gecikme sonlu ve negatif olmayan bir sayıdır.
- Kesimler koşunun toplandığı `limit` derinliğini aşamaz (`SEMANTIC_CUTOFFS`):
  toplanmamış derinlik ölçülmez. Özet kendi yapılandırmasını taşır
  (`catalogue`, `limit`, `cutoffs`, `ndcgCutoff`).
- Okunamayan değer de `SEMANTIC_RUN_INVALID`'dir; özet genel bir çalışma
  zamanı hatasıyla düşmez.

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
| Yeniden sıralama katkısı | Aynı ölçünün yeniden sıralama sonrası − ilk aşama farkı |
| Gecikme | p50 / p95 / en çok (en yakın sıra yüzdeliği) |

Planlayıcı kararları (`[{ case, decision, tools }]`, 4C için): karar
doğruluğu, beklenti başına geri çağırma (**açıklama doğruluğu** =
`recall.clarify`, **desteklenmeyen istekte çekimserlik** = `recall.abstain`),
karışıklık matrisi, `answer` vakalarında ihtiyaç kapsaması ve yasak araç
ihlali. Karar güvenilmez model çıktısıdır: alanlar bir kez okunur; araç
listesi yoğun, en çok 20 öğeli, katalog kimliklerinden ve tekildir; `abstain`
kararı araç adlandıramaz (`tools: []`); okunamayan karar, listedeki boşluk,
bilinmeyen ya da yinelenen vaka geçersiz sayılır.

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
  okunur; metin olmayan ya da okunamayan kod genel koda iner.
- Koşucu (`collectSemanticRun`) vakaları sırayla yürütür; iki model çağrısı
  hiçbir zaman örtüşmez. Süre aşımı ve iptal:
  - Çağrı başına süre sınırı her zaman sonludur: varsayılan 60 sn, 1 ms–600 sn
    arasında tam sayı; sınırsız çağrı seçeneği yoktur.
  - Koşunun iptali (Durdur) hemen yayılır ve koşu iptal nedeniyle reddedilir.
    İptal çağrı başlamadan geldiyse model hiç çağrılmaz; model sonucu
    kesinleştikten sonra ama koşucu onu kaydetmeden önce geldiyse başarı
    kaydedilmez.
  - Süresi dolan çağrının sinyali `TimeoutError` nedeniyle iptal edilir ve
    vaka `timeout` ıskasıdır. Sinyale uyan model bir süre sınırı daha içinde
    sonuçlanır; koşu sonraki vakayla sürer.
  - Süreç içindeki bir Promise zorla durdurulamaz. Sinyale uymayan model
    (ek süre içinde sonuçlanmayan çağrı) arka planda sürüyor sayılır ve koşu
    **kapalı kalarak** durur: model bir daha çağrılmaz, kalan vakalar
    `failed`/`RUN_HALTED` ıskasıdır. Böylece terk edilen çağrı sonraki
    vakaların sonucunu ya da gecikmesini kirletemez.
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

Doğrulanıp **değiştirilmeyenler**: adı geçen görev/proje/kişi için arama aracı
isteyen öneriler (yukarıdaki `needs` kuralı); proje sıralamasında görev
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
Python'a bağlı değildir. Uygulama başlangıcı da model indirmez.

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
  (vektörler, skorlar, koşucunun ölçtüğü gecikme) yazar; sonlu olmayan değer
  `null` olur. Koşu dosyası modele **gerçekten verilen** belge ve sorgu
  metnini ve etkin `queryPrefix`/`documentPrefix` öneklerini de taşır. Yerel
  klasördeki model `--embedding-name`/`--reranker-name` ile adlandırılmak
  zorundadır; klasör yolu model kimliği sayılmaz.
- Güvenilirlik: model yükleme ve katalog gömme hatası ölümcüldür. Tek bir
  sorgunun gömme ya da yeniden sıralama hatası `INFERENCE_FAILED` koduyla
  kaydedilir (hata iletisi yazılmaz); rapor o vakayı `failed` ıskası sayar,
  tamamlanan ölçümler korunur. Çıktı yolu işe başlamadan silinir ve sonuç
  aynı klasördeki geçici dosyadan atomik olarak yerine konur: başarısız deneme
  eski koşuyu bırakmaz. Özet satırı ASCII'dir ve stdout yazılamayan karakterde
  düşmez (Windows kod sayfası).
- `report` ham koşuyu güvenilmez girdi olarak bir kez doğrular: kapalı şema
  (bilinmeyen alan reddedilir); biçim/sürüm ve parmak izleri; model kökeni;
  önekler ile ön işleme belirtecinin tutarlılığı (önek varsa belirteç onu
  adlandırır, yoksa `none`); belge, sorgu, yeniden sıralama ve skor satırları
  katalog kimlikleri ve kıyas vakalarıyla **birebir** aynı küme (eksik, fazla,
  yabancı ya da yinelenen satır reddedilir); satırdaki metin girdideki metnin
  aynısı (değiştirilmiş metin puanlanmaz); gecikmeler sonlu ve negatif değil;
  ortam künyesi sınırlı. Sonra aynı çıktıyı üretimdeki sözleşme ve koşucudan
  geçirir; bozuk değer ıska sayılır.
- `--limit` (varsayılan 10) en derin ölçü kesiminden (5) sığ, 20'den derin
  olamaz.
- `--json` çıktısındaki `qualification` künyesi sonucu yeniden üretmek için
  gerekeni taşır: koşu biçimi ve sürümü, kıyas kümesi ve katalog parmak izi,
  gömme modeli, sağlayıcı, ön işleme belirteci, etkin sorgu ve belge önekleri,
  çalışma ortamı sürümleri, yeniden sıralayıcı (model, sağlayıcı) ya da `null`,
  aday sınırı (`limit`), kesimler, gecikme iş yükü ve ortam.
- Gecikme iş yükü açıkça yazılır: katalog gömme tek çağrıda bütün belgeler;
  sorgu gömme çağrı başına tek sorgu; yeniden sıralama çağrı başına **bütün
  katalog** (kayıttaki yeniden sıralayıcılar noktasaldır). Kalite ölçüleri ise
  ilk aşamanın ilk `limit` adayının bu skorlarla yeniden dizilmesinden gelir;
  rapor bu farkı gecikmenin yanında yazar. Gecikme nüfusu kıyas kümesinin
  vakalarıdır (başarısızlar dâhil).

---

## 7. Ölçüm sonuçları (Aşama 4A)

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
`qualification` künyesi doğrulandı. Bunlar yalnızca tesisatın sınamasıdır;
anlamsal kalite hakkında hiçbir şey söylemez. Gerçek gömme/yeniden sıralama taban
çizgisi 4B'nin ilk işidir (ağ izni verilen bir ortamda §6.6 komutlarıyla ya da
kurum içinde §8 ile).

**Zayıf model uyumluluk okuması (Claude Haiku 4.5, 17.10.2026).** Haiku 4.5
yalnızca bir **zayıf model / düşük düşünmeli uyumluluk vekilidir**: kurum
içindeki `Qwen3-Next-80B-A3B-Instruct` modelinin taklidi ya da benzetimi
DEĞİLDİR, 4C kabul ölçütü değildir ve hiçbir eşik dondurmaz. Amaç, katalog ve
kıyas kümesinin gizli akıl yürütme olmadan anlaşılıp anlaşılmadığını görmektir.

Kurulum: yalnızca bu modele sabitlenmiş, depo bağlanmamış ayrı bir oturum;
tek tur, araç kullanımı yok (oturum kaydı `claude-haiku-4-5-20251001` ile
sunulduğunu ve hiç araç çağrısı olmadığını gösterir). Genişletilmiş düşünme
istenmedi; ancak oturumun varsayılan ayarı modelin yanıttan önce kısa bir
düşünme bloğu (yaklaşık 5.100 belirteç) üretmesine izin verdi, bu yüzden okuma
tam olarak "düşünmesiz" değildir. Modele yalnızca 19 aracın sunucuya ait
açıklamaları, karar türlerinin tanımı ve karıştırılmış sırada, yalnızca sıra
numarasıyla 117 soru verildi; vaka kimliği, beklenti, ihtiyaç, kaçınma, etiket,
önceki yanıtlar ya da inceleme yorumları verilmedi. Yanıt, düzeltilmiş kıyas
kümesi üzerinde `evaluateSemanticDecisions` ile puanlandı:

| Ölçü | Değer |
| --- | --- |
| Karar doğruluğu | 0.957 (112/117) |
| `answer` geri çağırma | 0.958 (91/95) |
| Açıklama doğruluğu (`recall.clarify`) | 0.857 (6/7) |
| Desteklenmeyen istekte çekimserlik (`recall.abstain`) | 1.000 (15/15) |
| `answer` vakalarında araç kapsaması | 0.874 (83/95) |
| Yasak araç ihlali | 0 |
| Eksik / geçersiz karar | 0 / 0 |

Ayrışmalar (13 vaka) ve sınıfları:

| Vakalar | Model | Sınıf | Not |
| --- | --- | --- | --- |
| tr-001, tr-008, tr-009, tr-011, tr-012, tr-013, tr-014 | Görev listesi sorularında yalnızca `rota_task_analytics` | Belirsiz katalog açıklaması | Analitik yalnızca toplam verir, görev listelemez; ama görev aramasının açıklaması gecikme/termin süzgeçlerini anmazken analitiğinki "gecikmiş" der. Etiket doğru; açıklama metni 4B girdisidir |
| tr-005 | `rota_data_quality` | Belirsiz katalog açıklaması | Veri kalitesi en çok beş örnek verir; görev aramasının açıklaması "sorumlusuz" süzgecini anmaz. Etiket araç davranışına göre doğrulandı |
| tr-037 | Çekimser | Belirsiz katalog açıklaması | Portföy özetinin `source` süzgeci var, açıklaması anmıyor |
| tr-048, tr-050 | Çekimser | Belirsiz katalog açıklaması | Kişi araması birim/unvan döndürür, açıklaması anmıyor (önceki okumayla aynı) |
| tr-060 "Talepleri göster" | Açıklama istedi (aynı iki araç) | Meşru zayıf model ıskası (sınırda) | Ürünün Talepler ekranı iki talep türünü birlikte gösterir; etiket ürün belgesine göre kaldı |
| tr-098 "Takvimi göster" | Tek yorumla yanıt | Meşru zayıf model ıskası | Çalışma takvimi, Outlook gönderimi ve görev takvimi gerçekten ayrı yetenekler |

Kıyas altın etiketi ya da soru kusuru bulunmadı; bu okuma yüzünden hiçbir
etiket değiştirilmedi (§6.4'teki düzeltmeler araçların gerçek davranışına
dayanır ve bu okumadan önce yapıldı). Model istenen düz JSON yerine yanıtı
yine kod çitine sardı (protokol sapması); çit soyularak puanlandı. 4C'de
planlayıcı çıktısı türlü sözleşmeyle doğrulanır. Adı geçen varlık için arama
aracını da seçmesi (ör. `rota_project_search`) §6.4 kuralı gereği
cezalandırılmadı. Bu belgenin önceki sürümündeki Haiku okumaları düzeltilmemiş
kümeye aittir ve geçersizdir. Aşama 4A bu okumaya bağlı değildir; MERGEN
Rota'da Anthropic bağlantısı, kimlik bilgisi ya da bağımlılığı yoktur.

Eşikler (ör. kabul edilebilir Recall@5 ya da çekimserlik oranı) bu adımda
**dondurulmaz**: gerçek model ölçümü olmadan seçilen eşik keyfî olurdu. 4B
gömme/yeniden sıralama eşiklerini, 4C planlayıcı eşiklerini kendi ölçümleriyle
dondurur. §3'teki mutlak koşullar eşik değildir; her zaman sıfırdır.

---

## 8. Kurum içi kabul sözleşmesi (Windows VM / ağdan yalıtılmış ortam)

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

Ön işleme (ör. Qwen3-Embedding için sorgu yönergesi) modele özgüdür ve uzay
belirtecine yazılır; değişirse dizin yeniden kurulur. Kabul kaydı `report
--json` çıktısıdır ve sonucu yeniden üretmek için `qualification` künyesini
(§6.6) taşır. Kabul çıktısı içerik taşımaz: vaka kimliği, ölçüler, sonuç türü sayıları, gecikme ve ortam künyesi.
Soru metni dışında kullanıcı verisi, anahtar ya da adres kaydedilmez.

---

## 9. Aşama 4A'nın bilerek yapmadıkları

- Canlı yolda anlamsal yönlendirme, gömme ile erişim ya da yeniden sıralama;
- planlayıcı davranışı ve yeni yanıt üretimi;
- vektör veritabanı, kalıcılık, önbellek çerçevesi, veritabanı göçü;
- Rota veritabanı satırlarının gömülmesi ya da küresel kayıt dizini;
- yeni yetki mimarisi, yeni sağlayıcı soyutlaması, `aiGateway`, Aşama 3 araç
  ya da kanıt sözleşmesi değişikliği; model kaydı şeması değişikliği;
- genel SQL üretimi; arayüz değişikliği; ses; dış web erişimi;
- uygulama başlangıcında ya da CI'da model indirme.

---

## 10. Otomatik sınamalar

| Dosya | Kapsam |
| --- | --- |
| `test/ai-semantic-contract.test.mjs` | Yapısal sorgu normalleştirme (NFC, temizlikten sonra NFC ve tekrar edilebilirlik, İ/I, görünmez karakter, sınırlar); katalog ve parmak izleri; Aşama 3 kayıt defterinden katalog; model kökeni ve uzay; bozuk gömme yanıtları (Proxy uzunluğu, fırlayan erişimci dâhil); belirlenimci, sınırlı sıralama ve eşitlik; bayat uzay; yeniden sıralama sözleşmesi; enjeksiyon metninin etkisizliği; kimlik/yetki/SQL yüzeyi olmaması ve canlı yola bağlanmama |
| `test/ai-semantic-evaluation.test.mjs` | Kıyas kümesinin yapısı, sentetikliği ve sızıntısızlığı; üretim kodunun kıyas kümesinden bağımsızlığı; kapalı yapı (seyrek dizi, açık `null`, bozuk grup, bilinmeyen alan, okunamayan belge, taklit katalog) tablosu; elle hesaplanan ölçüler ve yeniden sıralama katkısı; kâhin ikizle tam küme; başarısız/geçersiz/süresi dolan çağrıların ıska sayılması; sinyale uymayan modelde koşunun durması; iptal yarışları; yeniden sıralama düşüşü; dizin kurulamaması; iptal; gecikme özeti; koşu kaydı güven sınırı tablosu (bayat sürüm, yabancı/yinelenen satır, sonuç–yük çelişkisi, permütasyon olmayan yeniden sıralama, negatif gecikme, sınırdan derin kesim); planlayıcı karar ölçüleri ve güvenilmez karar tablosu |
| `test/ai-semantic-qualification.test.mjs` | Nitelendirme komutu: parmak izli girdi; kâhin koşu dosyasıyla rapor ve `qualification` künyesi (model, önekler, yeniden sıralayıcı, aday sınırı, gecikme iş yükü); bayat, eksik/fazla/yabancı/yinelenen satırlı, değiştirilmiş metinli, negatif gecikmeli, öneki çelişkili, bilinmeyen alanlı ya da güvensiz hata kodlu koşunun reddi; bozuk değerin ve `INFERENCE_FAILED` satırının ıska sayılması; `--limit` sınırı |
