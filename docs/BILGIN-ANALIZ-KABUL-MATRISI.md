# Bilgin Analiz Kabul Matrisi (Aşama F)

Bu belge [Bilgin Yönetim Analizi Yol Haritası](BILGIN-YONETIM-ANALIZI-YOL-HARITASI.md)'nın kabul kanıtıdır: Windows VM'de
sorulan 40 sorunun yetenek matrisi, doğrulanmış kök nedenler, Aşama F çözümleri ve üç kanıt düzeyinin sonuçları. Sorular
ve veriler **sentetiktir** (`test/fixtures/bilgin-analysis-benchmark.json`, `test/helpers/analysisBenchmarkSeed.mjs`); özgün
sıra, gözlenen sonuç ve analitik zorluk korunmuştur (ör. kurumsal sözcük içeren proje adı → "BGS Şube Çalışmaları",
kısaltma + "TOOL" → "KAP TOOL", büyük harfli Türkçe soyadlı adlar → (uydurma) "Deniz Ufuk KARAAĞAÇLI", "Nehir SÜRMELİOĞLU").

## 1. Sınıflar ve ölçüt

**Vaka sınıfı (Aşama F beklentisi):** *tam* — Aşama F yetenekleriyle tam ve doğru yanıt; *kısmi* — gerekçeli sınırlarla doğru
kısmi yanıt (bağımlı aşama yazılır); *sınırlı* — gerçek veri/yetenek sınırı, sonraki aşamaya bağlı.

**Sonuç sınıfı (her koşu):** doğru yanıt · gerekçeli kısmi yanıt · gerçek veri/yetenek sınırı · çözülmemiş kusur.
Gerekçesiz başarısızlık geçiş sayılmaz; tablo döndürmek analitik başarı değildir.

**Yetenek sınıfı:** (A) destekleniyor ve çalışıyor · (B) destekleniyor ama kusurlu · (C) veri var, yeterince birleştirilmiyor ·
(D) ek analitik işleç gerekir · (E) yeni salt okunur araç gerekir · (F) veri yok · (G) ek yetki gerekir · (H) sonraki aşama.

**Değerlendirme boyutları** (doğruluk ve yazım ayrı puanlanır): niyet, kapsam, araç seçimi, analitik tamlık, olgusal
doğruluk, kanıt kökeni, yetki doğruluğu, sayısal doğruluk, istenen görselleştirme, karşılaştırmalı içgörü, akıcı Türkçe,
giriş ve sonuç, yararlı çekinceler, gecikme ve model çağrısı. Otomatik puanlama yapısal boyutları (bitiş, kapsam, okuma,
grafik, bulgu, sonuç paragrafı, çağrı sayısı) ölçer; yazım kalitesi temsilî yanıtlar üzerinde elle değerlendirilir (§5).

## 2. Doğrulanmış kök nedenler (belirlenimci yeniden üretim)

| Kod | Kök neden | Etkilenen sorular | Düzeltme |
| --- | --- | --- | --- |
| K1 | Bildirilen yönlerin fiziksel okuması 3 ile sınırlıydı; dört yönlü yönetici soruları ve iki özne × üç yön karşılaştırması altın planla bile reddediliyordu | 2, 5, 11, 17, 20, 40 | Kabul sınırı mevcut fiziksel üst sınır (4); model şeması değişmedi |
| K2 | Gelecekteki dönem gecikmiş iş okumasına da uygulanıyordu (tanımı gereği boş: "gecikmiş görev yok" yanlış güvencesi; mevcut bir sınama bu yanlışı zorunlu ifade olarak kilitlemişti) | 3, 10, 16, 24, 38 | Gecikme bugüne göre ölçülür; gelecek dönem yalnızca gecikme okumasından çıkarılır |
| K3 | Özetten açılan çok bölümlü planın tur bütçesi sabit 4'tü; ad çözümü + okuma bölüm başına iki tur harcadığından üçüncü bölüme tur kalmıyordu (iki kişi karşılaştırması kısmi kalıyordu; `main` üzerinde de yeniden üretildi) | 11, 34 | Yalnızca özetten açılan planda ek bölüm başına bir tur; toplam çağrı/SQL/süre sınırları değişmedi |
| K4 | Tek grafik türü temsil ediliyordu | 39 | En çok iki tür (dizi) kabul edilir, her türün okuması ve aday yeri ayrılır |
| K5 | Bölümler arası sentez yoktu (giriş, karşılaştırmalı bulgu, öncelik, sonuç) | 24 mekanik yanıtın tamamı | Bulgu motoru + sunucu yazımı giriş/sonuç |
| K6 | Kişi öznesi doğal betimlenemiyordu ("Görebildiğiniz görevler arasında … (ölçüt: Sorumlu: Seçilen kişi; Kişi: X)") | 11, 34 ve kişi soruları | "**X** sorumluluğunda …" doğal öznesi |
| K7 | İki öznenin karşılaştırma grafiği yoktu (her öznenin değeri ayrı kanıttaydı) | 34 | İki öznenin doğrulanmış değerlerinden ölçü başına çubuk grafik |
| K8 | Proje portföy sıralaması 8 satırla kesiliyordu; 9+ projeli portföyde hiçbir pay/sıra bulgusu kurulamıyordu | 1, 4, 8, 17, 20 | Portföy sıralaması mevcut kayıt defteri üst sınırı (10) |
| K9 | Kesik "en yakın teslimat" listesinde zaman çizelgesi çizilmiyordu | 24, 38 | Termine göre artan doğrulanmış sıralamanın başı "En yakın N teslimat" başlığıyla çizilir |
| K10 | Onarım sözleşmesi kusurları (Haiku ile bulundu): `all_time` eşdeğer yazımı düşünce onarım "kapsam değişikliği" sayılıyordu; göreli pencere çakışmasında düzeltilecek alan dondurulmuştu; karşılaştırma bütçe aşımı daraltılamıyordu; özetin yanındaki ad arama çağrıları onarım turu açıyordu | 1, 3, 11 ve geniş sorular | Eşdeğerlik normalleştirmesi; çakışan alanlar onarımda serbest; yön daraltma; ad arama çağrıları yürütülmeden atılır |
| K11 | `EMPTY_COMPLETION`: Qwen plan/düzeltme turunda <1 sn boş yanıt; özdeş yeniden deneme de boş | VM'de çok sayıda | Burada yeniden üretilemez; çıktı belirteci sayısı günlüğe eklendi, VM yordamı (yol haritası §11) |

## 3. 40 soruluk matris

Sütunlar: **No** · **VM** (B başarısız, M mekanik) · **Sınıf** (tam/kısmi/sınırlı → bağımlılık) · **Gerekli yetenek** ·
**Kök neden** · **Belirlenimci** (altın plan, üretim hizmeti; ✓ geçti, — vaka sınırlı) · **Haiku** (gerçek model uçtan uca;
§4'teki son koşu) · **Kalan sınır**.

| No | VM | Sınıf | Gerekli yetenek | Kök neden | Belirlenimci | Haiku | Kalan sınır |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | M | tam | Çok ölçülü proje karşılaştırması, dikkat önceliği (A→C) | K5, K8 | ✓ | ✓ (onarım düzeltmesi sonrası) | Bileşik puan bilinçli olarak yok |
| 2 | B | kısmi → G | Ekip iş yükü + proje + gecikme + yaklaşan (B) | K1, K5 | ✓ | ✓ | Kadro tamlığı: denge/yoğunlaşma yalnızca tam nüfusta |
| 3 | B | tam | Gelecek dönem + mevcut gecikme (B) | K2 | ✓ | ✓ (onarım düzeltmesi sonrası) | Gecikmiş listesi kesikse "en az" alt sınırı |
| 4 | M | kısmi → G | Gecikme yoğunlaşması (C) | K5, K8 | ✓ | ✓ | Kişi yoğunlaşması kadro tamlığı ister |
| 5 | B | tam | İki proje karşılaştırması (B) | K1, K5 | ✓ | ✓ | — |
| 6 | M | kısmi → G | Ekip dengesi (C) | K5 | ✓ | ✓ | Kadro tamlığı çekincesi zorunlu |
| 7 | B | sınırlı → H | İki dönem karşılaştırması (D, F) | Tek pencere temsili | — | sınırlı → H | Dönem karşılaştırma işleci ve geçmiş tamlık ölçüsü (H) |
| 8 | M | tam | Bölüm düzeyi proje değerlendirmesi (A) | K8 | ✓ | ✓ | — |
| 9 | M | kısmi → G | Direktörlük iş yükü, örgütsel gruplar (D) | Düzey kırılımı işleci yok | ✓ | ✓ | Birim/bölüm başına toplam (G) |
| 10 | M | tam | Kişisel önceliklendirme (C) | K2, K5 | ✓ | ✓ | — |
| 11 | B | tam | İki kişi × proje/gecikme/yaklaşan (B) | K1, K3, K6, K10 | ✓ | ✓ (ilk koşuda iç hata; 3 yeniden koşuda yok) | — |
| 12 | M | tam | Tek proje sağlığı (C) | K5 | ✓ | ✓ | Kilometre taşı sağlığı (G) |
| 13 | M | kısmi → G | "Çok görev = risk mi?" (C) | K5 | ✓ | ✓ | Desteklenmeyen çıkarım reddi metni (G) |
| 14 | M | kısmi → G | En çok gecikmeli kişi (C) | Kadro tamlığı | ✓ | ✓ | Tam kadro okuması (G) |
| 15 | M | kısmi → G | Tamamlanma + gecikme aynı tabloda (D) | Tablo yoktu | ✓ (gecikme sütunu eklendi) | ✓ | Proje başına tamamlanma oranı bulgusu (G) |
| 16 | B | tam | 14 gün + mevcut gecikme, eşzamanlı baskı (B, D) | K2, K5 | ✓ | ✓ | Kesik listede alt sınır |
| 17 | M | tam | Dengeli çok ölçülü değerlendirme (C) | K1, K5, K8 | ✓ | ✓ | — |
| 18 | M | tam | Kanıt yeterliliği (C) | K5 | ✓ | ✓ | — |
| 19 | B | sınırlı → G | Üç düzeyli değerlendirme (D, G) | Tek kapsamlı plan | — | sınırlı → G (yeniden koşuda yanıt) | Çok kapsamlı plan (G) |
| 20 | M | tam | Kapsamlı yönetici değerlendirmesi (C) | K1, K5, K8 | ✓ | kararsız (3 koşunun 1'i) | — |
| 21 | M | tam | Yığılmış grafik (A) | — | ✓ | ✓ | — |
| 22 | M | tam | Ekip çubuk grafiği + denge (A) | Çekince | ✓ | ✓ | — |
| 23 | M | tam | Halka grafik (A) | — | ✓ | ✓ | — |
| 24 | B | kısmi → H | 30 gün zaman çizelgesi + gecikme riski (B, D) | K2, K9 | ✓ | ✓ (yeniden koşu) | Risk tahmini yapılmaz; yalnızca mevcut gecikme ve yakın termin |
| 25 | M | tam | Gecikme dağılımı grafiği (A) | — | ✓ | ✓ | — |
| 26 | M | tam | KPI özeti (A) | — | ✓ | ✓ | — |
| 27 | B | sınırlı → H | 90 gün tamamlanma eğilimi (D, F) | Eğilim işleci yok | — | sınırlı → H | Gerçekleşen bitişe göre dizi + tamlık (H) |
| 28 | M | kısmi → G | Örtüşen serilerin yığılması (C) | Gecikmiş ⊂ açık; yığılamaz | ✓ | ✓ | Doğru grafik biçimi seçimi (G) |
| 29 | M | tam | Tablo + çubuk (A) | — | ✓ | ✓ | — |
| 30 | B | kısmi → H | 7/14/30 gün yoğunluğu (D) | Çoklu ufuk yok | ✓ (7/30 kovaları) | ✗ → H | 14 günlük ufuk (H) |
| 31 | M | tam | Bölüm iş yükü proje grafiği (A) | — | ✓ | ✓ | — |
| 32 | M | tam | Direktörlük durum karşılaştırması (A) | — | ✓ | ✓ | — |
| 33 | M | tam | İki proje durum grafiği (A) | — | ✓ | kararsız (doğru yanıt, Haiku düzeni reddedilip Derin anlatım istendi) | — |
| 34 | B | tam | İki kişi çubuk grafiği (B, D) | K3, K6, K7 | ✓ | ✓ | — |
| 35 | B | tam | Gecikmiş / zamanında ayrımı (A) | — | ✓ | ✓ | — |
| 36 | B | tam | Grafik + kişi tablosu (A) | Çekince | ✓ | ✓ | — |
| 37 | M | tam | Kısa yönetici özeti + KPI (A) | — | ✓ | ✓ | — |
| 38 | B | tam | 30 gün iş yükü grafiği + teslimat listesi (B) | K2, K9 | ✓ | ✗ (özet + ek liste birlikte; G) | Zayıf model özet + ek liste karıştırıyor (§4) |
| 39 | B | tam | İki grafik türü (B) | K4 | ✓ | kısmi (dizi çözümü eklendi; düzen reddi → Derin isteği) | — |
| 40 | B | tam | Yönetim gösterge paneli (B) | K1, K10 | ✓ | ✓ | — |

Belirlenimci kanıt: `test/ai-analysis-benchmark.test.mjs` (37 altın plan vakası + bütünlük; 40/40 geçti),
`test/ai-analytical-findings.test.mjs`, `test/ai-management-analysis-planning.test.mjs`.

## 4. Gerçek model nitelendirmesi (Haiku 4.5)

Koşum: `PLANNER_CLAUDE_LOG=… PHASE4E_TIER=F node --test scripts/analysis-qualification.mjs` (özgün 40, uçtan uca: planlayıcı +
düzen modeli) ve `PHASE4E_SET=holdout` (ayrık 24, yalnızca planlayıcı). Model `claude-haiku-4-5-20251001`, `--effort low`,
`MAX_THINKING_TOKENS=0`; her çağrıda model kimliği ve sıfır düşünme belirteci kayıttan doğrulandı (bütün koşularda
`models = [claude-haiku-4-5-20251001]`, `thinking = 0`). Derin modele giden her çağrı modele GİTMEZ ve başarısızlık sayılır.

| Koşu | Vaka | Geçen | Çağrı | Girdi | Önbellek yazma | Önbellek okuma | Çıktı |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Özgün 40, ilk tam koşu (düzeltmelerden önce) | 39 | 28 | 81 | 95 223 | 67 692 | 1 881 080 | 20 638 |
| Başarısızların yeniden koşusu (düzeltmelerden sonra) | 11 | 5 | 26 | 21 831 | 15 333 | 728 220 | 7 777 |
| Hedefli tanı koşuları (o33, o38, o39, o20) | 9 | 2 | 19 | 18 166 | 21 483 | 486 367 | 5 449 |
| Ayrık küme (yalnızca planlayıcı) | 24 | 16* | 35 | 105 | 92 256 | 1 277 414 | 9 618 |
| Görsel kabul (gerçek arayüz, 3 koşu, 16 tur) | — | — | 34 | 39 255 | 24 899 | 834 932 | 8 108 |
| Kanonik planlayıcı kapısı, `--semantic none` (aşağıya bkz.) | 136 | 35 | 217 | 651 | 376 465 | 8 070 771 | 50 996 |

\* Ayrık kümenin ham sonucu 11/24'tür; 5 vaka yalnızca puanlayıcının, beklentide bilinçli olarak serbest bırakılan
kapsamı yine de karşılaştırmasından düşüyordu (`kapsam X ≠ undefined`). Puanlayıcı düzeltildi (Tier B vakalarının hepsi
kapsam taşır, etkilenmez); altın etiket değiştirilmedi. Kalan 8 başarısızlığın 5'i sonraki aşamaya bağlı sınırlı vakadır
(model `clarify` ya da geçersiz plan üretiyor; beklenen: sınırı söyleyen Rota yanıtı), 3'ü (h03 düzey, h18 kapasite
sorusunda açıklama isteği, h23 karışık kişi/kendi kapsamı) açık kalır.

**Kanonik planlayıcı kapısı (117/117 + 19/19):** bu ortamda tanımlı biçimiyle koşulamaz. Kapı anlamsal danışmanlık
(`--semantic run|live`, şirket içi gömme/yeniden sıralama modeli) ister; burada yalnızca `--semantic none` mümkündü ve
rapor bunu "kapıyı düşürür" diye işaretler. Bu koşulda Haiku 136 vakanın 35'ini (kanonik 27/117) doğru planladı; sonuç
anlamsal danışmanlıksız koşulun ölçüsüdür, gerileme ölçüsü değildir. Gerileme olmadığı ayrıca belirlenimci olarak
doğrulandı: sahte model komutuyla 136 vakanın planlayıcıya giden girdileri bu dalda ve `main`'de karşılaştırıldı;
sistem yönergesi, araç kataloğu ve ilk tur mesajları **bayt bayt aynıdır** (fark yalnızca rastgele çağrı kimlikleri).
Dalın tek davranış farkı, dört yönlü özetin 4 okumaya açılmasıdır; puanlayıcının bütünlük denetimi 3 yerine
`ANALYSIS_LIMITS.maxParts` (4) sınırını izleyecek biçimde güncellendi (önce koşu geçersiz sayılıyordu: tr-035, tr-038).

**Açık kalan model davranışları:** o38 (özet + ek liste aynı planda; G'de birleşik plan), o33/o39 (Haiku'nun düzen
modeli karşılaştırma/halka sayfasında reddediliyor ve Derin anlatım istiyor; yanıt sunucu düzeniyle doğru teslim
ediliyor), o20 kararsız, o11'deki tek seferlik iç hata yeniden üretilemedi (4 belirlenimci varyant + 3 canlı koşu).

## 4b. Yanıt yapısı denetimi (belirlenimci, 37 analitik özet × 3 ayrıntı)

| Ayrıntı | Çok bölümlü | Açılış (önce → sonra) | Kapanış (önce → sonra) | Başlıklı |
| --- | ---: | --- | --- | ---: |
| Kısa | 30 | 19 → 30 | 0 → 30 (25 öncelik + 5 sonraki adım) | 0 (tasarım) |
| Dengeli | 30 | 19 → 30 | 13 → 30 (25 öncelik + 5 sonraki adım) | 15 (3+ bölümlüler) |
| Ayrıntılı | 37 | 24 → 37 | 17 → 37 (30 öncelik + 7 sonraki adım) | 33 |

"Önce" sütunu bu dilimin ilk hâlidir (bulgu motoru yalnızca bölümler arası bulgu kurabildiğinde giriş ve sonuç yazıyordu).
Mekanik kalıpların ("Eşleşen", "Kayıt sayısı:", eğik çizgili karşılaştırma, "**0**'ı tamamlanmış", tekrarlanan toplam cümlesi)
sayısı bütün yanıtlarda sıfırdır; kalan tek etiket satırı, doğal cümleyle söylenemeyen nüfusların tablo üstü "_Ölçüt: …_"
notudur (yanıt başına ortalama: Kısa 0,46; Dengeli 0,25; Ayrıntılı 0,16). Bu güvence eşikleriyle birlikte
`test/ai-answer-quality-gate.test.mjs` içinde kalıcı sınamadır; çok istekli türlü yanıtlar da açılışla başlar.

## 5. Temsilî yanıtlar (aynı sentetik kanıt, önce / sonra)

Bütün sayılar doğrulanmış olgudur ya da tam nüfustan sunucuda hesaplanmış toplam/paydır. "Sonra" metinleri gerçek
arayüzden (zayıf planlayıcı ve düzen modeli, sentetik veri) alınmıştır.

**Kısa olgusal soru**: "Kaç gecikmiş görevim var?"
- Önce: "Eşleşen 1 görev bulundu (ölçüt: Termin: Gecikmiş; Sorumlu: Ben)."
- Sonra: "Şu anda **1** gecikmiş göreviniz var." Liste soruluyorsa satırın projesi korunur: "… görevinin termini **26 Eylül
  2026** (**Siber Güvenlik Denetimi** projesi). Görev **4** gündür gecikmiş."

**Yönetici özeti** (bütün projeler, dört bölüm)
- Önce: başlıksız tek akış; "Gecikmiş görevi olan proje sayısı **8**." ardından "**9** projenin **8**'inde gecikmiş görev var.";
  "**Altyapı Yenileme**, açık görev (**12**), gecikmiş görev (**5**) … sayısında en üstte."; tablo üstünde "_Ölçüt: Termin:
  Gecikmiş_"; sonuç tek bir noktalı virgüllü cümle ("**Sonuç:** Bu kanıta göre ilk ele alınabilecek konular: …; …; son olarak …").
- Sonra:
  > Mevcut göstergelere göre yönetim dikkatini en çok **Altyapı Yenileme** projesi gerektiriyor: gecikmiş, önümüzdeki yedi
  > günde terminli ve açık iş sayılarının üçünde de projeler arasında ilk sırada. …
  >
  > #### Proje karşılaştırması
  > **9** projenin **8**'inde gecikmiş görev var. **Altyapı Yenileme**, **12** açık, **5** gecikmiş ve **6** yedi gün içinde terminli
  > görevle projeler arasında ilk sırada. *(tablo)*
  >
  > #### Gecikmiş görevler
  > Şu anda **21** gecikmiş görev var. *(tablo)*
  >
  > #### Öncelikli konular
  > 1. **Yük testi** — en uzun süredir geciken görev (**21** gün, **Altyapı Yenileme**)
  > 2. **Altyapı Yenileme** projesindeki açık işler — göstergelerin birlikte en yüksek olduğu proje
  > 3. **8 Kasım 2026** — en yakın teslim tarihi (**Ağ yapılandırması** dahil)

**İki proje karşılaştırması**
- Önce: girişsiz sekiz cümle, sayılar iki kez; "Gecikmiş görev (**2** / **3**) … sayıları birbirine yakın."
- Sonra: "İki proje arasındaki en belirgin fark açık görevlerde: **BGS Şube Çalışmaları** projesinde **4**, **KAP TOOL**
  projesinde **6** açık görev var. Gecikmiş (**2** ve **3**) ve önümüzdeki yedi günde terminli (**1** ve **1**) görev sayıları ise
  birbirine yakın." ardından her proje için tek birleşik cümle ve iki projeyi birlikte gösteren çubuk grafik.

**Proje yöneticisi değerlendirmesi** (tek proje)
- Önce: her analist cümlesi aynı "**BGS Şube Çalışmaları**:" etiketiyle başlıyordu; "Atama dağılımı tam: **Evet** (ölçüt: …)";
  "Bunların **0**'ı tamamlanmış ve **0**'ı …; tamamlanma oranı **%0**".
- Sonra: bölüm başlıklı ("Genel görünüm", "… gecikmiş görevler", "Kişilere göre iş yükü"); "Tamamlanma görünümü olumlu (**%60**);
  buna karşılık **2** gecikmiş görev dikkat gerektiriyor."; "Bu dağılım kapsamdaki bütün açık iş atamalarını içeriyor.";
  sıfır bölümler "Bunların hiçbiri tamamlanmış ya da yedi gün içinde terminli değil." biçiminde.

**Gelecek dönem + mevcut gecikme**
- Önce: "… döneminde terminli işi olan **8** projenin en az **5'inde** bugün gecikmiş iş de var: … (gecikmiş listesi ilk **9** görevi
  gösteriyor)."; tabloda her satırı **0** olan gecikmiş sütunu; "_Ölçüt: Tarih alanı: Termin; İlk tarih: …; Son tarih: …_".
- Sonra: "**7 Kasım 2026** ile **20 Kasım 2026** arasında teslimatı olan **8** projenin en az **5'inde** bugün gecikmiş iş de var: ….
  Gecikmiş listesi ilk **9** görevle sınırlı olduğundan gerçek sayı daha yüksek olabilir."; sıfır sütun okunmuyor; bölüm başlığı
  dönemi adlandırıyor.

**Eksik kanıt** (ekip iş yükü, kadro tamlığı kanıtlanmamış)
- "Bu iş yükü görünümü yalnızca görebildiğiniz ve kişilere bağlanabilen açık işleri kapsıyor; bu nedenle iş yükünün dengeli
  olup olmadığı ya da en çok yükün kimde olduğu kesin olarak söylenemez." (zorunlu çekince; sıralama yargısı yok).
