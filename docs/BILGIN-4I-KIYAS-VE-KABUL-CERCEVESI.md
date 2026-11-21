# Bilgin Aşama 4I — Kıyas ve Kabul Çerçevesi

Bu belge Aşama 4I yönetici raporlarının **nasıl değerlendirileceğini** tanımlar: kıyas kümesi, değerlendirme
boyutları, insan editoryal kalite ölçütü, deneylerden önce tanımlanmış eşikler, model nitelendirme protokolü ve
artım kabul kapıları. Mimari ve sözleşmeler: [Yönetici Raporu Mimarisi](BILGIN-4I-YONETICI-RAPORU-MIMARISI.md);
sıra ve ilerleme: [4I Uygulama Yol Haritası](BILGIN-4I-UYGULAMA-YOL-HARITASI.md). Makinece okunur fikstür:
[`test/fixtures/bilgin-executive-report-benchmark.json`](../test/fixtures/bilgin-executive-report-benchmark.json)
(eşiklerin makinece okunur kaynağı bu dosyanın `esikler` alanıdır; aşağıdaki tablolar onun okunur biçimidir).

**Durum (21.11.2026):** Çerçeve, sentetik fikstür ve yapısal sınamalar hazırdır. **Hiçbir gerçek model ölçümü
yapılmamıştır**; fikstürün `olcumler` alanı boştur ve belirlenimci sınama bunu korur.

---

## 1. Sınama felsefesi

> **Olgusal doğruluk yazımı sınırlar; yazımın yerine geçmez.**

- **Belirlenimci sınama** nesnel olguları, yapısal sözleşmeleri, yapılandırmayı, güvenlik değişmezlerini ve belge
  bütünlüğünü denetler (sayılar, tarihler, kimlikler, yetki, stil ↔ şablon uyumu, paket güvenliği).
- **İnsan puanlaması** yazı kalitesini değerlendirir; bağımsız bir modelle yapılan değerlendirme yalnızca
  **destekleyici** kanıttır, tek başına kapı değildir.
- Belirli düzyazıyı, bağlaçları ya da cümle kalıplarını bekleyen **kırılgan sınama yazılmaz**. Doğrulaması kolay
  diye mekanik dil ödüllendirilmez: olgusal olarak doğru ama mekanik rapor (K17) editoryal kapıdan **düşer**.
- Eşikler ve puanlama kuralları karşılaştırmalı deney başlamadan önce tanımlanır (§5) ve koşu boyunca sabit kalır.
  Gerekçeli değişiklik karar günlüğüne yazılır ve ancak bütün adayların yeniden koşulduğu yeni deneyde uygulanır.
- Üç kanıt düzeyi karıştırılmaz: **belirlenimci geçiş** (sentetik veri, sahte sağlayıcı), **kurum içi model
  nitelendirmesi** (gerçek on-prem modeller, sentetik kıyas), **kurum içi kabul** (gerçek altyapı, Windows VM, Word).

---

## 2. Kıyas kümesi

48 senaryo (planlanan aralık 40–60), 20 kategori; 8'i tam sentetik kanıtla **temsili vaka** olarak verilmiştir.
Bütün kişi, proje ve birim adları fikstürdeki `sentetik_kadro` listesindendir; gerçek kurum verisi yoktur.

| Kod | Kategori | Senaryolar |
| --- | --- | --- |
| K01 | Haftalık bireysel faaliyet raporu | S01–S03 |
| K02 | Aylık müdürlük raporu | S04–S06 |
| K03 | Çok projeli yönetici özeti | S07–S09 |
| K04 | Az sayıda resmî tamamlanmayla önemli başarılar | S10–S11 |
| K05 | Parçalı teknik görev notları | S12 (R1), S13–S14 |
| K06 | Aynı gelişmeyi anlatan birden çok not | S15–S16 |
| K07 | Eskimiş ya da çelişkili notlar | S17 (R4), S18 |
| K08 | Eksik tarihsel kayıtlar | S19–S20 |
| K09 | İddia edilen gecikme için yetersiz kanıt | S21 (R5), S22 |
| K10 | Yapılandırılmış ve yapılandırılmamış kanıt karışımı | S23–S24 |
| K11 | Farklı kapsam ve yetki düzeyleri | S25 (R8), S26–S27 |
| K12 | Dönemde anlamlı değişiklik olmayan rapor | S28 (R7), S29 |
| K13 | Farklı ayrıntı düzeyleri ve vurgu tercihleri | S30–S33 |
| K14 | Karmaşık örgütsel raporlama | S34–S35 |
| K15 | İsteğe bağlı destekleyici belgeler | S36–S39 |
| K16 | Mükemmel düzyazı içinde tek desteksiz iddia | S40 (R2), S41 |
| K17 | Olgusal olarak doğru ama mekanik rapor | S42 (R3), S43 |
| K18 | Belirsizliğin doğal anlatımını gerektiren rapor | S44–S45 |
| K19 | Not ya da belge içinde gömülü yönerge | S46 (R6), S47 |
| K20 | Üretim sırasında yetki değişimi | S48 |

Her senaryo yönetici özelleştirme sözlüğündeki seçenekleri (dönem, kapsam, ayrıntı, odak, notlar, karşılaştırma,
belgeler, görseller), sentetik durum özetini, neyin sınandığını ve değerlendirme boyutlarını taşır. Temsili
vakalar ayrıca kanıt paketi (`E#`), **desteklenen ifadeler** (sınıf + kanıt göndergesi), **yasak ifadeler**
(neden yasak oldukları) ve gerektiğinde değerlendirilecek **taslak** paragrafları ile beklenen onarımı taşır.

Temsili vakaların sınadığı zor noktalar:

| Vaka | Nokta |
| --- | --- |
| R1 | Parçalı not → profesyonel düzyazı; "haftaya" notun kayıt gününe göredir; kesinlik ve neden uydurulmaz |
| R2 | İyi taslakta tek uydurma kabul imzası → yalnızca o cümle onarılır; 1. ve 3. paragraf korunur; rapor düşmez |
| R3 | Doğru ama mekanik taslak → bütünlük geçer, editoryal kapı düşer |
| R4 | Çelişen iki not → zaman sırası, değişikliğin açıkça söylenmesi, yeni tarih uydurmama |
| R5 | Tarihsiz tamamlanma → gecikme iddiası kurulmaz |
| R6 | Not içi yönerge izlenmez. Görev açık kalır ve bağımsız kanıtla belgelenen risk belirtilir. |
| R7 | Değişiklik yok → kısa, dürüst; uydurma etkinlik yok |
| R8 | PARTIAL projede ekip toplamı yalnızca görünür görevlerden hesaplanır. Kapalı proje ya da görev yayımlanmadan kesin kapıda tutulur. |

---

## 3. Değerlendirme boyutları

**A. Güvenlik ve olgusal bütünlük** — yetkisiz açıklama yok; nesnel olgular doğru; kimlik, dönem ve kapsam doğru;
uydurma başarı, karar, termin ya da neden yok; eksik ve çelişkili kanıt açıkça işlenir.

**B. Editoryal kalite** — doğal ve akıcı Türkçe; bağlantılı, dolu paragraflar; anlamlı sentez ve yorum; profesyonel
yönetici tonu; genel geçer gözlem yerine özgüllük; yinelenen kalıp giriş/kapanış yok; veritabanı dökümü dili yok;
açık yönetim değeri; görev notlarının doğru dönüşümü.

**C. Belge kalitesi** — kurumsal stil; doğru tipografi ve bölüm sırası; okunur grafik ve tablolar; doğru Word
sayfalaması; düzenlenebilir çıktı; yöneticiler arasında kararlı görünüm.

**D. İşletim kalitesi** — sınırlı yürütme; uygun model seçimi; kaynak ve gecikme; güvenli iptal ve temizlik;
gerçekçi yükte güvenilirlik; mevcut Bilgin yeteneklerinde regresyon yok.

---

## 4. İnsan editoryal kalite ölçütü

İki bağımsız puanlayıcı, **model kimliği gizli** ve rastgele sırada, her raporu dokuz ölçütte 1–5 puanlar.
Her rapor ve ölçütte ilk iki puanın farkı en çok 1 ise aritmetik ortalamaları alınır. Fark 1'den büyükse
üçüncü kör puanlayıcı aynı ölçütü puanlar ve üç puanın medyanı kullanılır. Ölçüt ortalaması, o ölçütün
**uygulanabilir** olduğu raporlardaki nihai puanlardan; genel ortalama ise uygulanabilir ölçütlerin
ortalamasından hesaplanır. Notların kapalı olduğu senaryolarda (`notlar: haric`, ör. S02) **E8 Not dönüşümü**
`Uygulanmaz (U/D)` olarak işaretlenir ve hem ilgili raporun hem de E8 ortalamasının paydasından çıkarılır;
notların kanıta dâhil olduğu bütün raporlarda E8 puanlanır. Ayrıca her rapor için ikili **mekanik döküm**
bayrağı verilir; iki kör puanlayıcı ikili bayrakta anlaşamazsa üçüncü kör puanlayıcı aynı raporu değerlendirir
ve raporun nihai bayrağı üç oydan **çoğunlukla (2/3)** belirlenir.

| Ölçüt | 5 (örnek alınacak) | 3 (kabul sınırı altı) | 1 (başarısız) |
| --- | --- | --- | --- |
| E1 Doğallık ve akıcılık | Türkçesi doğal, cümleler çeşitli ve akıcı | Anlaşılır ama yer yer çeviri kokan ya da tekdüze | Bozuk, kopuk ya da robotik |
| E2 Bağlantılı paragraflar | Paragraflar bir düşünceyi geliştirir, geçişler doğal | Paragraflar cümle yığını gibi | Madde madde sayım ya da tek cümlelik parçalar |
| E3 Sentez ve yorum | Gelişmeleri ilişkilendirir, anlamını kanıt ölçüsünde açıklar | Olayları sıralar, ilişki kurmaz | Yalnızca durum sayıları |
| E4 Yönetici tonu | Ölçülü, yetkin, karar destekleyici | Fazla teknik ya da fazla genel | Uygunsuz, abartılı ya da suçlayıcı |
| E5 Özgüllük | Somut iş, proje ve gelişme adlandırılır | Kısmen somut | "Çalışmalar sürmektedir" türü genel geçer |
| E6 Kalıptan kaçınma | Her bölüm kendi içeriğiyle açılır | Bazı tekrar eden kalıplar | Her bölüm aynı kalıpla açılıp kapanır |
| E7 Yönetim değeri | Dikkat gerektiren konular ve öncelikler net | Öncelikler belirsiz | Yönetim için çıkarım yok |
| E8 Not dönüşümü | Kısaltılmış notlar kanıtı aşmadan profesyonel dile çevrilir | Not aynen ya da yarım aktarılır | Not anlamı bozulur ya da üzerine olgu eklenir |
| E9 Belirsizliğin anlatımı | Kesin olmayan bilgi doğal ve ölçülü nitelenir | Belirsizlik ya hiç ya da her cümlede | Belirsiz bilgi kesin olgu gibi |

**Mekanik döküm bayrağı:** metnin ağırlıklı olarak art arda sayı/durum cümlelerinden, kalıp tekrarından ya da
kayıt alanlarının cümleye çevrilmesinden oluşması. Nihai bayrak alan rapor kendi başına editoryal olarak
başarısız sayılır; aday düzeyinde 48 senaryodaki mekanik döküm oranının **%5'i aşması** (48 raporda > 2 rapor)
olgusal doğruluktan bağımsız olarak B kapısını ve 4I-B nitelendirmesini düşürür (§5).

**Ayar örnekleri (sentetik):**

- *5 düzeyine yakın (R1):* "Kuzey projesinde saha prototipinin mekanik montajı tamamlandı. Görev kaydında
  gerçekleşen bitiş tarihi 5 Kasım. 6 Kasım tarihli notta test cihazının mevcut olmadığı belirtiliyor. Saha
  testlerine geçiş için cihazın kullanılabilirliği izlenmeli. Not, testlerin 9 Kasım’da başlayan haftada
  yapılabileceğine işaret ediyor. Kesin gün belirtilmemiş."
- *1 düzeyi (R3):* "Bu dönemde toplam 18 görev tamamlanmıştır. Toplam 52 görev açıktır. Toplam 7 görev
  gecikmiştir. Toplam 14 görev yaklaşan görevdir."

Destekleyici model değerlendirmesi kullanılırsa: değerlendirici yazardan farklı bir modeldir, aynı ölçütü ve
gizli kimliği kullanır, puanları insan puanlarıyla ayrı raporlanır ve insan puanının yerine geçmez.

---

## 5. Önceden tanımlanmış eşikler

| Boyut | Eşik |
| --- | --- |
| **A** (4I-B yazar nitelendirmesi — onarım öncesi taslak) | Yetkisiz açıklama **0**; uydurma kimlik ya da tarih **0**; çelişkili/eksik kanıtın açık işlenmesi **%100**; onarım öncesi taslakta nesnel olgu doğruluğu en az **%95** (payda = taslakta yer alan nesnel olgu sayısı + atlanan zorunlu olgu sayısı; atlanan zorunlu olgular doğruluğu düşürür) |
| **A** (yayımlama — 4I-C onarım sonrası, sonlandırma öncesi) | Yetkisiz açıklama **0**; yayımlanan desteksiz maddi iddia **0**; uydurma kimlik ya da tarih **0**; yayımlanan nesnel olgu doğruluğu **%100**; çelişkili/eksik kanıtın açık işlenmesi **%100** |
| **B** | 1–5 ölçekte genel ortalama en az **4,0**; uygulanabilir hiçbir ölçütün ortalaması **3,5**'in altında değil; aday düzeyinde mekanik döküm oranı en çok **%5** (48 raporda ≤ 2); iki kör puanlayıcı, sayısal fark > 1 veya ikili bayrak uyuşmazlığında üçüncü |
| **C** | Word'ün onarım istemeden açtığı belge oranı **%100**; standart ayrıntıda **2–3** sayfa (kapak ve ekler hariç); bütün sayfalar görsel incelenir; stil sözleşmesi sınaması geçer |
| **D** | Rapor başına en çok **11** model çağrısı (1 yazım + 8 onarım + denetim ve yeniden sıralama için ortak 2 çağrı); standart raporda uçtan uca p95 en çok **240 sn** (ilk eşik, en yakın sıra yöntemiyle); iptal sonrası geçici veri kalmaz; mevcut Bilgin regresyonu **0** |
| **4I-C onarım** | Onarım sonrası editoryal puan düşüşü en çok **0,3**; tekil sorunların en az **%90**'ı yerel onarımla insan incelemesine gerek kalmadan çözülür; bütün raporun hazır metne düşmesi **0** |

**Seçim kuralı (4I-B yazar nitelendirmesi):** **4I-B yazar nitelendirmesi** A eşiklerini geçen adaylar arasında
`rapor_yazari_otomatik`, B eşiklerini geçen ve D süre eşiğini karşılayanların en yüksek B ortalamalısıdır
(eşitlikte aynı en yakın sıra yöntemiyle hesaplanan düşük p95). `rapor_yazari_yuksek_kalite`, 4I-B A ve B
eşiklerini geçenler arasında en yüksek B ortalamalısıdır (p95 ≤ 600 sn). Yayımlama A kapıları (`0` yayımlanan
desteksiz maddi iddia ve `%100` yayımlanan nesnel olgu doğruluğu) 4I-C onarım ve sonlandırma kapısında
uygulanır. Hiçbir aday geçmezse rol boş kalır ve 4I-B kabulü **ENGELLİ** olur; eşikler adayı geçirmek için
gevşetilmez.

---

## 6. Model nitelendirme protokolü

1. **Adaylar:** `DeepSeek-V4.1-Flash-1017`, `Qwen3.8-Flash-Next-FP8`; taban: `gemma-4-31B-it`,
   `Qwen3-Next-80B-A3B-Instruct`, `openai/gpt-oss-120b` (stil belgesi `model_politikasi`).
2. **Ön koşul:** kimlikler kurum içi `GET /models` yanıtında doğrulanır; doğrulanamayan model koşulmaz.
3. **Aynı koşullar:** Puanlanan küme §2'deki 48 senaryodur. R1–R8 için kaynak, ilgili temsili vakanın fikstürdeki
   kanıtıdır. Diğer senaryolar için (ör. S04) 4I-A'nın sentetik veri ve kanıt kurucusuyla senaryo kimliğine bağlı,
   sürümlü kanıt paketleri hazırlanır. İsteğe bağlı destekleyici belge içeren K15 senaryoları (S36–S39) için 4I-A
   kıyas paketleri, yalnızca kıyasa özgü, önceden çıkarılmış, belge kökenli (`kaynak_belge`, `bolum`) sentetik
   metin parçaları taşır ve bütün adaylara aynı biçimde verilir; gerçek dosya yükleme, ayrıştırma ve geçici temizlik
   denetimleri 4I-F kapsamında kalır. 4I-B başlamadan önce tüm paketler gözden geçirilir ve sabitlenir. Bir paket
   eksikse koşu başlamaz. Her aday aynı paketleri, yönerge sürümünü, sıcaklık/örnekleme ayarlarını ve çıktı
   sınırını kullanır. Düşünme kipi ve nicemleme (ör. FP8) kaydedilir.
4. **Kimlik doğrulaması:** her yanıttaki bildirilen model kimliği kaydedilir; beklenenle uyuşmayan ya da
   doğrulanamayan koşu **GEÇERSİZ/DOĞRULANMAMIŞ** sayılır, geçiş raporlanmaz.
5. **Bütçe:** Çağrı ve belirteç sınırları koşudan önce belirlenir. §5'teki 11 çağrıya yazım, onarım, bağımsız model
   denetimi ve yeniden sıralama dâhildir. Önce gereken denetim çağrılarının payı ayrılır. Yalnızca kalan payla
   toplu yeniden sıralama çağrılabilir. Pay kalmadığında kanıt belirlenimci olarak seçilir ve maddi iddia desteği
   mimari §8.2'ye göre doğrulanır. Kota, kimlik veya altyapı hatasında koşu durur. Başka modele sessiz geçiş yasaktır.
6. **Ölçüm:** A için belirlenimci denetim + insan doğrulaması; B için §4; C için 4I-D'den sonra; D için çağrı,
   belirteç, süre (p50/p95), iptal ve temizlik. Süre p95 hesabı 48 senaryoluk koşudaki bütün tamamlanmış `standart`
   ayrıntı örnekleri üzerinden **en yakın sıra (nearest-rank)** yöntemiyle ($\lceil 0{,}95 \times N \rceil$-inci
   sıralı değer) yapılır; koşudan önce ilan edilen ısınma çağrıları varsa dışarıda bırakılır, başarısız veya süre
   aşımına uğrayan örnekler elenmez (5. adım uyarınca koşuyu durdurur/geçersiz kılar). Aynı p95 hesabı hem süre
   kapısı hem de eşitlik bozma kuralı için kullanılır.
7. **Kayıt:** 4I-B nitelendirme kaydı sentetik fikstürden ayrı ve sürümlü tutulur (model, tarih, ortam, ayarlar,
   kanıt paketi sürümleri, A/B/C/D sonuçları, puanlayıcı sayısı). Fikstürün `olcumler` alanı boş kalır. Sonuç
   kaydı yol haritasının oturum devrine bağlanır ve nitelikli modeller stil belgesindeki role işlenir.

---

## 7. Artım kabul kapıları (özet)

| Artım | Belirleyici kapı |
| --- | --- |
| 4I-0 | Stil ↔ şablon ↔ kayıt ↔ fikstür belirlenimci sınamaları; şablonun bütün sayfalarının görsel incelemesi; tam paket, lint, derleme |
| 4I-A | Kanıt paketi yetki/rıza/köken/tamlık sınamaları; tanı önizlemesinde notlardan anlamlı bilgi; 4H sohbet regresyonu yok |
| **4I-B** | Gerçek on-prem modellerle tam taslaklar; 4I-B taslak A kapıları ve **B eşikleri**; aday düzeyinde mekanik döküm oranı **%5'i aşıyorsa** olgusal doğruluktan bağımsız olarak **başarısız** |
| **4I-C** | Önce/sonra raporları; tekil sorunların yerel onarımı; yayımlama A kapıları (`0` desteksiz iddia, `%100` olgu doğruluğu) ile **hem bütünlük hem anlatı kalitesi** korunur |
| 4I-D | Word'de açılış, bütün sayfaların görsel incelemesi, stil sözleşmesi, Türkçe karakter, sunucu görselleri |
| 4I-E | Yönetici geliştirici yardımı olmadan oluşturur, düzeltir, önizler, sonlandırır ve indirir. Her içerik çıkışında yetki yeniden denetlenir. |
| 4I-F | Ek bilgi raporu iyileştirir; yüklenen içerik izin verilen süreden sonra kalmaz; güvenlik sınamaları |

---

## 8. Belirlenimci sınamalar

4I-0'da eklenen:

- `test/ai-executive-report-foundation.test.mjs` — stil belgesi bütünlüğü ve ilkeleri; ton formülü; yer tutucu
  sözlüğü ve bölüm aidiyeti; kaldırılamaz bütünlük açıklaması; dört iddia sınıfı ve onarım politikası; logo
  politikası ve uç yüzeyi; şablon paket güvenliği; A4/kenar/üst-alt bilgi; stil adı ve özellikleri; tema yazı
  tipleri; renk paleti; yer tutucu kümesi, bölünmezliği ve belge sırası; ilan edilmemiş metin yokluğu; bölüm
  başlıkları ve tablo sütunları; sürüm özellikleri; kapak yedigeninin yetkili yollardan türetilmesi; rapor model
  rolleri ↔ model kaydı; ölçümsüz nitelendirme yasağı; belgelerdeki ilke ve yol haritası biçimi; 4I-0 sınırı.
- `test/ai-executive-report-benchmark.test.mjs` — sentetik kapsam ve kategori bütünlüğü; seçenek sözlüğü;
  temsili vaka ↔ senaryo eşlemesi; kanıt göndergeleri ve iddia sınıfları; yerel onarım ve kesin kapı beklentileri;
  zor nokta vakaları; önceden tanımlanmış eşikler ve ölçüm yokluğu.
- `test/ai-model-registry.test.mjs` — uzlaştırılmış tam kimlikler; eski kimliklerin geri gelmemesi.

Sonraki artımlar kanıt paketi kurucusu, yazar çıktı ayrıştırıcısı, nesnel denetim, onarım döngüsü, DOCX üretimi ve
Stüdyo için kendi belirlenimci sınamalarını ekler; düzyazının kendisi belirlenimci sınamayla puanlanmaz.

---

## 9. Kayıt biçimi

Her nitelendirme ya da kabul koşusu: tarih, commit, ortam (geliştirme / kurum içi VM), model kimlikleri ve
bildirilen kimlikler, ayarlar, senaryo kümesi, A/B/C/D sonuçları **sayılarıyla**, puanlayıcı sayısı ve
anlaşmazlık çözümü, bilinen sınırlar. Koşulmayan kapı **bekliyor** olarak yazılır; yapılmamış doğrulama geçti
olarak raporlanmaz.
