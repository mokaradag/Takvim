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
| Sorgu normalleştirme | Asistan iletisiyle aynı denetim karakteri temizliği + Unicode NFC + görünmez karakter (U+00AD, U+200B, U+2060, U+FEFF) silme + boşlukların tekleşmesi; boş sorgu `QUERY_EMPTY`, 2000 karakteri aşan `QUERY_TOO_LONG`. **Büyük/küçük harf katlanmaz** (Türkçe I/ı/İ/i korunur); aksan, ek, sözcük değiştirilmez, eş anlam ya da kök bulma yapılmaz |
| Katalog | Öğe: `id`, `kind` (kapalı küme: `tool`), `version`, `text`, `fingerprint`; en fazla 256 öğe, metin en fazla 4000 karakter, kimlik tekil; her tanım bir kez okunur, seyrek dizinin boşluğu da reddedilir. Bugünkü katalog Aşama 3 araç kayıt defterinin 19 aracıdır; metin aracın sunucuya ait açıklamasıdır (şema, işleyici, yetki belgesi girmez) |
| Model kökeni | Yalnızca model kaydının çözdüğü rotadan: `embedding` profili `embedding`, `rerank` profili `rerank` yeteneğini taşımalıdır. İş kodunda model adı yoktur |
| Gömme uzayı | `profile + model + provider + preprocessing`; ön işleme (ör. E5 `query:`/`passage:` önekleri) adlandırılmış bir belirteçtir |
| Gömme yanıtı | Dizin adresli `[{ index, vector }]`; her giriş tam bir kez, tüm vektörler aynı boyutta (1–8192), değerler sonlu sayı, sıfır vektör yok. Girişler konumla, her değer bir kez okunur (dizinin yineleyicisine güvenilmez; doğrulanan değer kullanılan değerdir); vektörler taşma/alttaşma güvenli ölçeklemeyle birim uzunluğa indirilir |
| Sıralama | Kosinüs benzerliği ([-1, 1]); en fazla 20 aday; eşitlikte katalog sırası; başka uzayda ya da boyutta üretilmiş sorgu `SPACE_MISMATCH`/`DIMENSION_MISMATCH` |
| Yeniden sıralama yanıtı | Dizin adresli `[{ index, score }]`; her aday tam bir sonlu skor almalıdır; eksik/fazla skor, yabancı ya da yinelenen dizin, sayı olmayan skor reddedilir ve ilk aşama sırası geçerli kalır; eşitlikte ilk aşama sırası korunur; sağlayıcının yanıt sırası sonucu değiştirmez |
| Taklide karşı koruma | Katalog, uzay, dizin ve aday listesi yalnızca modülün kendi kurucularından kabul edilir; taklit nesne doğrulamayı atlayamaz |

Model çıktısı güvenilmez dış veridir. Karşılanan durumlar ve kodları:

| Durum | Sonuç |
| --- | --- |
| `null`, nesne, metin; dizi olmayan yanıt; nesne olmayan giriş | `RESPONSE_SHAPE` |
| Eksik/fazla giriş, devasa yanıt (önce uzunluk denetlenir) | `COUNT_MISMATCH` |
| Dizin yok, negatif, kesirli, metin ya da aralık dışı (yabancı aday) | `INDEX_INVALID` |
| Yinelenen dizin | `INDEX_DUPLICATE` |
| Sıfır ya da 8192'den büyük boyut | `DIMENSION_INVALID` |
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
ihlali.

Ölçü sözleşmesinin kuralları:

- Sıralama ölçüleri `answer`, açıklama kapsaması `clarify`, ayrılabilirlik
  `abstain` vakalarından hesaplanır; kesin kayan nokta değerine değil sıralama
  ilişkilerine dayanır.
- Başarısız (`failed`), geçersiz (`invalid`), süresi dolan (`timeout`) ya da
  hiç kaydı olmayan vaka **paydadan düşmez**; ıska sayılır ve sonuç türü ayrıca
  sayılır.
- Yeniden sıralama başarısızsa üretimdeki gibi ilk aşama sırası geçerlidir.
- Hata iletisi kaydedilmez; yalnızca güvenli kod (`[A-Z][A-Z0-9_]*`) ya da
  `MODEL_CALL_FAILED` tutulur. Hata nesnesi de güvenilmezdir: kod bir kez
  okunur; metin olmayan ya da okunamayan kod genel koda iner.
- Koşucu (`collectSemanticRun`) vakaları sırayla yürütür, çağrı başına süre
  sınırı uygular ve koşunun iptalini hemen yayar; sinyale uymayan model işlevi
  de koşuyu askıda bırakamaz. Özet (`summarizeSemanticRun`) başka bir kıyas
  kümesi ya da katalogla üretilmiş koşuyu `SEMANTIC_RUN_STALE` ile reddeder.

### 6.4 Sentetik Türkçe kıyas kümesi — `test/fixtures/ai-semantic-benchmark.json`

117 vaka: 95 `answer` (7'si birden çok yetenekli), 7 `clarify`, 15 `abstain`;
30 vakada 33 kaçınma çifti. 19 aracın her biri en az üç tek ihtiyaçlı vakanın
birincil adayıdır. 24 etiketlik kapalı sözlük: resmî/günlük dil, eş anlam,
çekim ekleri, kısaltma,
yazım hatası, noktalamasız, ASCII Türkçe, büyük harf (İ/I), Türkçe-İngilizce
karışık, göreli zaman, olumsuzluk, karşılaştırma, üstünlük, sayım,
tekil-çoğul, takip, varlık adı, birden çok araç; kapsam dışı için genel
bilgi, yazma isteği, desteklenmeyen hesap, Rota dışı veri ve güvenlik
(kimlik değiştirme, SQL, yönerge enjeksiyonu).

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
- Vaka metinleri kanonik (normalleşmiş) ve tekildir; araç açıklamalarını ve
  belgelerdeki örnek soruları kopyalamaz (sınamayla denetlenir).
- Bütün veriler sentetiktir: gerçek kişi, proje, Sicil, e-posta, adres ya da
  uzun numara yoktur.

Kümeyi değiştirmek bilinçli bir sürüm adımıdır: parmak izi değişir ve eski
koşu dosyaları bayat sayılır. Etiket, bir modelin çıktısına uydurulmak için
değiştirilmez; yalnızca tek tur ilkesine ya da ürün belgesine aykırı olduğu
gösterilen vaka düzeltilir.

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
  `null` olur. Yerel klasördeki model `--embedding-name`/`--reranker-name` ile
  adlandırılmak zorundadır; klasör yolu model kimliği sayılmaz.
- `report` aynı ham çıktıyı üretimdeki sözleşme ve koşucudan geçirir: biçim ya
  da köken geçersizse, girişler yineleniyorsa ya da koşu başka bir kıyas
  kümesi/katalogla üretilmişse reddeder; bozuk değer ıska sayılır.
- Yeniden sıralayıcı her sorgu için katalogdaki bütün belgeleri puanlar
  (kayıttaki yeniden sıralayıcılar noktasaldır); rapor ilk aşamanın ilk 10
  adayını bu skorlarla yeniden dizer.

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
dosyalarının reddi doğrulandı. Bu yalnızca tesisatın sınamasıdır; anlamsal
kalite hakkında hiçbir şey söylemez. Gerçek gömme/yeniden sıralama taban
çizgisi 4B'nin ilk işidir (ağ izni verilen bir ortamda §6.6 komutlarıyla ya da
kurum içinde §8 ile).

**Zayıf model keşif denemesi (Claude Haiku 4.5, 17.10.2026).** Ayrı bir
oturumda yalnızca bu modele sabitlenerek, araç kullanmadan tek turda yapıldı
(çaba ayarı oturumun varsayılanı). Modele yalnızca 19 aracın sunucuya ait
açıklamaları, karar türlerinin tanımı (kapsam dışı türleri dâhil: yazma isteği,
genel bilgi, Rota dışı veri, kritik yol/bolluk hesabı, kimlik/yetki değiştirme,
SQL) ve karıştırılmış sırada 117 soru verildi; vaka kimliği, beklenti, ihtiyaç,
kaçınma ya da etiket verilmedi. Yanıt `evaluateSemanticDecisions` ile
puanlandı:

| Ölçü | Değer |
| --- | --- |
| Karar doğruluğu | 0.949 (111/117) |
| `answer` geri çağırma | 0.958 (91/95) |
| Açıklama doğruluğu (`recall.clarify`) | 0.714 (5/7) |
| Desteklenmeyen istekte çekimserlik (`recall.abstain`) | 1.000 (15/15) |
| `answer` vakalarında araç kapsaması | 0.937 (89/95) |
| Yasak araç ihlali | 0 |
| Eksik / geçersiz karar | 0 / 0 |

Ayrışmalar (8 vaka): kişinin birimi ve unvanı sorulan iki `answer` vakasında
çekimser kalındı (`rota_person_search` bu alanları döndürür, ancak araç
açıklaması onları anmaz; katalog metninin kapsamı 4B'nin konusudur); iki
`answer` vakasında açıklama istendi ("Talepleri göster", "Entegrasyon işi
neyi bekliyor?"); iki `clarify` vakası tek yorumla yanıtlandı ("Ahmet ne
yapıyor?", "Takvimi göster"); iki `answer` vakasında araç kapsaması eksik
kaldı. Model istenen düz JSON yerine yanıtı kod çitine sardı; çit soyularak
puanlandı (4C'de planlayıcı çıktısı türlü sözleşmeyle doğrulanır).

Bu bir keşif ölçümüdür: zayıf model uyumluluk kapısının ilk okumasıdır;
üretimdeki Qwen modelinin taklidi DEĞİLDİR, 4C kabul ölçütü değildir ve eşik
dondurmaz. Aynı türden ilk deneme farklı bir Haiku sürümüyle yapıldığı için
sonuç olarak kullanılmadı. O deneme tek tur ilkesine aykırı vakaları
(bağlamsız gönderge, proje adı eksik baz plan/WBS soruları) gün yüzüne
çıkardı; bunlar §6.4 kurallarına göre yeniden yazıldı ve "Talepleri göster"
vakasının etiketi ürün belgesine göre (Talepler sayfası atama koordinasyonunu
da içerir) düzeltildi. Yukarıdaki sonuç düzeltilmiş küme üzerindedir; etiketler
model çıktısına uydurulmadı (birim/unvan vakaları, araç bu alanları döndürdüğü
için `answer` kaldı).

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
belirtecine yazılır; değişirse dizin yeniden kurulur. Kabul çıktısı içerik
taşımaz: vaka kimliği, ölçüler, sonuç türü sayıları, gecikme ve ortam künyesi.
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
| `test/ai-semantic-contract.test.mjs` | Yapısal sorgu normalleştirme (NFC, İ/I, görünmez karakter, sınırlar); katalog ve parmak izleri; Aşama 3 kayıt defterinden katalog; model kökeni ve uzay; bozuk gömme yanıtları; belirlenimci, sınırlı sıralama ve eşitlik; bayat uzay; yeniden sıralama sözleşmesi; enjeksiyon metninin etkisizliği; kimlik/yetki/SQL yüzeyi olmaması ve canlı yola bağlanmama |
| `test/ai-semantic-evaluation.test.mjs` | Kıyas kümesinin yapısı, sentetikliği ve sızıntısızlığı; üretim kodunun kıyas kümesinden bağımsızlığı; elle hesaplanan ölçüler ve yeniden sıralama katkısı; kâhin ikizle tam küme; başarısız/geçersiz/süresi dolan çağrıların ıska sayılması; yeniden sıralama düşüşü; dizin kurulamaması; iptal; gecikme özeti; bayat koşu ve parametreler; planlayıcı karar ölçüleri |
| `test/ai-semantic-qualification.test.mjs` | Nitelendirme komutu: parmak izli girdi, kâhin koşu dosyasıyla rapor, bayat/yinelenen/bozuk kökenli koşunun reddi, bozuk değerin ıska sayılması, `--limit` sınırı |
