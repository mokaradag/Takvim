# Bilgin Analiz Kabul Matrisi (Aşama F–G)

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
| K1 | Bildirilen yönlerin fiziksel okuması 3 ile sınırlıydı; dört yönlü yönetici soruları ve iki özne × üç yön karşılaştırması altın planla bile reddediliyordu | 2, 5, 11, 17, 20, 40 | Model görünür `focus.maxItems` ve sunucu kabul sınırı 3'ten 4'e çıkarıldı; mevcut fiziksel okuma üst sınırı (4) korundu |
| K2 | Gelecekteki dönem gecikmiş iş okumasına da uygulanıyordu (tanımı gereği boş: "gecikmiş görev yok" yanlış güvencesi; mevcut bir sınama bu yanlışı zorunlu ifade olarak kilitlemişti) | 3, 10, 16, 24, 38 | Gecikme bugüne göre ölçülür; gelecek dönem yalnızca gecikme okumasından çıkarılır |
| K3 | Özetten açılan çok bölümlü planın tur bütçesi sabit 4'tü; ad çözümü + okuma bölüm başına iki tur harcadığından üçüncü bölüme tur kalmıyordu (iki kişi karşılaştırması kısmi kalıyordu; `main` üzerinde de yeniden üretildi) | 11, 34 | İlk kabul edilen analitik planda bölüm başına ad çözümü ve okuma hakkı (en çok 8 tur), yeniden başlangıçta kümülatif sayım; toplam çağrı/SQL/süre sınırları değişmedi |
| K4 | Tek grafik türü temsil ediliyordu | 39 | En çok iki tür (dizi) kabul edilir, her türün okuması ve aday yeri ayrılır |
| K5 | Bölümler arası sentez yoktu (giriş, karşılaştırmalı bulgu, öncelik, sonuç) | 24 mekanik yanıtın tamamı | Bulgu motoru + sunucu yazımı giriş/sonuç |
| K6 | Kişi öznesi doğal betimlenemiyordu ("Görebildiğiniz görevler arasında … (ölçüt: Sorumlu: Seçilen kişi; Kişi: X)") | 11, 34 ve kişi soruları | "**X** sorumluluğunda …" doğal öznesi |
| K7 | İki öznenin karşılaştırma grafiği yoktu (her öznenin değeri ayrı kanıttaydı) | 34 | İki öznenin doğrulanmış değerlerinden ölçü başına çubuk grafik |
| K8 | Proje portföy sıralaması 8 satırla kesiliyordu; 9+ projeli portföyde hiçbir pay/sıra bulgusu kurulamıyordu | 1, 4, 8, 17, 20 | Portföy sıralaması mevcut kayıt defteri üst sınırı (10) |
| K9 | Kesik "en yakın teslimat" listesinde zaman çizelgesi çizilmiyordu | 24, 38 | Termine göre artan doğrulanmış sıralamanın başı "En yakın N teslimat" başlığıyla çizilir |
| K10 | Onarım sözleşmesi kusurları (Haiku ile bulundu): `all_time` eşdeğer yazımı düşünce onarım "kapsam değişikliği" sayılıyordu; göreli pencere çakışmasında düzeltilecek alan dondurulmuştu; karşılaştırma bütçe aşımı daraltılamıyordu; özetin yanındaki ad arama çağrıları onarım turu açıyordu | 1, 3, 11 ve geniş sorular | Dönemsizlik eşdeğerliği; kalan tarih gösterimi sabit; bütçede yön korunur; yalnızca bildirilmiş seçicilere eşit ad aramaları atılır |
| K11 | `EMPTY_COMPLETION`: Qwen plan/düzeltme turunda <1 sn boş yanıt; özdeş yeniden deneme de boş | VM'de çok sayıda | Burada yeniden üretilemez; çıktı belirteci sayısı günlüğe eklendi, VM yordamı (yol haritası §11) |

## 3. 40 soruluk matris

Sütunlar: **No** · **VM** (B başarısız, M mekanik) · **Sınıf** (tam/kısmi/sınırlı → bağımlılık) · **Gerekli yetenek** ·
**Kök neden** · **Belirlenimci** (altın plan, üretim hizmeti; ✓ geçti, — vaka sınırlı) · **Haiku** (gerçek model uçtan uca;
§4'teki son koşu) · **Kalan sınır**. Aşama G sonrasında **Sınıf** ve **Kalan sınır** sütunları güncellendi; **VM** ve **Haiku**
sütunları Aşama F'nin tarihsel ölçümüdür (G'nin Haiku sonuçları §7.4–7.6'dadır).

| No | VM | Sınıf | Gerekli yetenek | Kök neden | Belirlenimci | Haiku | Kalan sınır |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | M | tam | Çok ölçülü proje karşılaştırması, dikkat önceliği (A→C) | K5, K8, K10 | ✓ | ✓ (onarım düzeltmesi sonrası) | Bileşik puan bilinçli olarak yok |
| 2 | B | tam (G) | Ekip iş yükü + proje + gecikme + yaklaşan (B) | K1, K5 | ✓ | ✓ | G: kadro okumasıyla tam nüfus (görünür görevi olmayan üye dahil); kapasite çekincesi zorunlu (§7) |
| 3 | B | tam | Gelecek dönem + mevcut gecikme (B) | K2, K10 | ✓ | ✓ (onarım düzeltmesi sonrası) | Gecikmiş listesi kesikse "en az" alt sınırı |
| 4 | M | kısmi → veri | Gecikme yoğunlaşması (C) | K5, K8 | ✓ | ✓ | Veri sınırı: portföy genelindeki kişilerin kadrosu yoktur; kişi yoğunlaşması gerekçeli kısmi yanıt (§7) |
| 5 | B | tam | İki proje karşılaştırması (B) | K1, K5 | ✓ | ✓ | — |
| 6 | M | tam (G) | Ekip dengesi (C) | K5 | ✓ | ✓ | G: tam kadroda yayılım ve gecikmede ilk sıradakiler (§7) |
| 7 | B | sınırlı → H | İki dönem karşılaştırması (D, F) | Tek pencere temsili | — | sınırlı → H | Dönem karşılaştırma işleci ve geçmiş tamlık ölçüsü (H) |
| 8 | M | tam | Bölüm düzeyi proje değerlendirmesi (A) | K8 | ✓ | ✓ | — |
| 9 | M | tam (G) | Direktörlük iş yükü, örgütsel gruplar (D) | Düzey kırılımı işleci yok | ✓ | ✓ | G: direktörlük → bölüm kırılımı; grup sayıları toplanmaz (§7) |
| 10 | M | tam | Kişisel önceliklendirme (C) | K2, K5 | ✓ | ✓ | — |
| 11 | B | tam | İki kişi × proje/gecikme/yaklaşan (B) | K1, K3, K6, K10 | ✓ | ✓ (ilk koşuda iç hata; 3 yeniden koşuda yok) | — |
| 12 | M | tam | Tek proje sağlığı (C) | K5 | ✓ | ✓ | G: kilometre taşı durumu (§7) |
| 13 | M | tam (G) | "Çok görev = risk mi?" (C) | K5 | ✓ | ✓ | G: görev sayısı ≠ baskı bulgusu (§7) |
| 14 | M | tam (G) | En çok gecikmeli kişi (C) | Kadro tamlığı | ✓ | ✓ | G: tam kadroda gecikmede ilk sıradakiler, işlemsel dil (§7) |
| 15 | M | tam (G) | Tamamlanma + gecikme aynı tabloda (D) | Tablo yoktu | ✓ (gecikme sütunu eklendi) | ✓ | G: tamamlanmaya karşın gecikme bulgusu (§7) |
| 16 | B | tam | 14 gün + mevcut gecikme, eşzamanlı baskı (B, D) | K2, K5 | ✓ | ✓ | Kesik listede alt sınır |
| 17 | M | tam | Dengeli çok ölçülü değerlendirme (C) | K1, K5, K8 | ✓ | ✓ | — |
| 18 | M | tam | Kanıt yeterliliği (C) | K5 | ✓ | ✓ | — |
| 19 | B | tam (G) | Üç düzeyli değerlendirme (D, G) | Tek kapsamlı plan | ✓ (G) | sınırlı → G (yeniden koşuda yanıt) | G: çok kapsamlı plan; kapsamlar arası toplam yok (§7) |
| 20 | M | tam | Kapsamlı yönetici değerlendirmesi (C) | K1, K5, K8 | ✓ | kararsız (3 koşunun 1'i) | — |
| 21 | M | tam | Yığılmış grafik (A) | — | ✓ | ✓ | — |
| 22 | M | tam | Ekip çubuk grafiği + denge (A) | Çekince | ✓ | ✓ | — |
| 23 | M | tam | Halka grafik (A) | — | ✓ | ✓ | — |
| 24 | B | kısmi → H | 30 gün zaman çizelgesi + gecikme riski (B, D) | K2, K9 | ✓ | ✓ (yeniden koşu) | Risk tahmini yapılmaz; yalnızca mevcut gecikme ve yakın termin |
| 25 | M | tam | Gecikme dağılımı grafiği (A) | — | ✓ | ✓ | — |
| 26 | M | tam | KPI özeti (A) | — | ✓ | ✓ | — |
| 27 | B | sınırlı → H | 90 gün tamamlanma eğilimi (D, F) | Eğilim işleci yok | — | sınırlı → H | Gerçekleşen bitişe göre dizi + tamlık (H) |
| 28 | M | tam (G) | Örtüşen serilerin yığılması (C) | Gecikmiş ⊂ açık; yığılamaz | ✓ | ✓ | G: örtüşen seriler yığılmaz; çubuk + açıklayıcı not (§7) |
| 29 | M | tam | Tablo + çubuk (A) | — | ✓ | ✓ | — |
| 30 | B | kısmi → H | 7/14/30 gün yoğunluğu (D) | Çoklu ufuk yok | ✓ (termin aralıkları; birikimli kıyas değil) | ✗ → H | Birikimli dönem kıyası yapılmadığı zorunlu çekinceyle açıklanır; çoklu ufuk H aşamasındadır |
| 31 | M | tam | Bölüm iş yükü proje grafiği (A) | — | ✓ | ✓ | — |
| 32 | M | tam | Direktörlük durum karşılaştırması (A) | — | ✓ | ✓ | — |
| 33 | M | tam | İki proje durum grafiği (A) | — | ✓ | kararsız (doğru yanıt, Haiku düzeni reddedilip Derin anlatım istendi) | — |
| 34 | B | tam | İki kişi çubuk grafiği (B, D) | K3, K6, K7 | ✓ | ✓ | — |
| 35 | B | tam | Gecikmiş / zamanında ayrımı (A) | — | ✓ | ✓ | — |
| 36 | B | tam | Grafik + kişi tablosu (A) | Çekince | ✓ | ✓ | — |
| 37 | M | tam | Kısa yönetici özeti + KPI (A) | — | ✓ | ✓ | — |
| 38 | B | tam | 30 gün iş yükü grafiği + teslimat listesi (B) | K2, K9 | ✓ | ✗ (özet + ek liste birlikte; G) | G: özet + ek liste birleşik planı (§7) |
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
| Özgün küme, ilk kayıtlı koşu (düzeltmelerden önce; 39/40) | 39 | 28 | 81 | 95 223 | 67 692 | 1 881 080 | 20 638 |
| Başarısızların yeniden koşusu (düzeltmelerden sonra) | 11 | 5 | 26 | 21 831 | 15 333 | 728 220 | 7 777 |
| Hedefli tanı koşuları (o33, o38, o39, o20) | 9 | 2 | 19 | 18 166 | 21 483 | 486 367 | 5 449 |
| Ayrık küme (yalnızca planlayıcı) | 24 | 16* | 35 | 105 | 92 256 | 1 277 414 | 9 618 |
| Görsel kabul (gerçek arayüz, 3 koşu, 16 tur) | — | — | 34 | 39 255 | 24 899 | 834 932 | 8 108 |
| Kanonik planlayıcı kapısı, `--semantic none` (aşağıya bkz.) | 136 | 35 | 217 | 651 | 376 465 | 8 070 771 | 50 996 |

İlk kayıtlı koşu 40 vakanın 39'unu içeriyor; eksik vakanın kimliği ve dışlanma nedeni mevcut kayıtta yoktur.
Bu satır tam 40 soruluk koşu ya da 40/40 kabul kanıtı olarak yorumlanamaz.

\* Ayrık kümenin ham sonucu 11/24'tür; 5 vaka yalnızca puanlayıcının, beklentide bilinçli olarak serbest bırakılan
kapsamı yine de karşılaştırmasından düşüyordu (`kapsam X ≠ undefined`). Puanlayıcı düzeltildi (Tier B vakalarının hepsi
kapsam taşır, etkilenmez); altın etiket değiştirilmedi. Kalan 8 başarısızlığın 5'i sonraki aşamaya bağlı sınırlı vakadır
(model `clarify` ya da geçersiz plan üretiyor; beklenen: sınırı söyleyen Rota yanıtı), 3'ü (h03 düzey, h18 kapasite
sorusunda açıklama isteği, h23 karışık kişi/kendi kapsamı) açık kalır.

**Kanonik planlayıcı kapısı (117/117 + 19/19):** bu ortamda tanımlı biçimiyle koşulamaz. Kapı anlamsal danışmanlık
(`--semantic run|live`, şirket içi gömme/yeniden sıralama modeli) ister; burada yalnızca `--semantic none` mümkündü ve
rapor bunu "kapıyı düşürür" diye işaretler. Bu koşulda Haiku 136 vakanın 35'ini (kanonik 27/117) doğru planladı; sonuç
anlamsal danışmanlıksız koşulun ölçüsüdür, gerileme ölçüsü değildir. İlk tur girdisinin eşdeğerliği ayrıca belirlenimci olarak
karşılaştırıldı: sahte model komutuyla 136 vakanın sistem yönergesi, araç kataloğu ve ilk tur mesajları o tarihte
bu dal ile `main` arasında bayt bayt aynıydı (rastgele çağrı kimlikleri dışında). Bu karşılaştırma sonraki onarım,
puanlama ve yürütme davranışlarını doğrulamaz; kanonik davranış kapısının yerine geçmez. Bu inceleme düzeltmeleri
`charts` şema alanını da eklediğinden eski girdi eşdeğerliği güncel sürüm için ileri sürülmez.

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
Mekanik kalıpların ("Eşleşen", "Kayıt sayısı:", eğik çizgili karşılaştırma, "**0**'ı tamamlanmış")
sayısı bütün yanıtlarda sıfırdır; kalan tek etiket satırı, doğal cümleyle söylenemeyen nüfusların tablo üstü "_Ölçüt: …_"
notudur (yanıt başına ortalama: Kısa 0,46; Dengeli 0,25; Ayrıntılı 0,16). Bu güvence eşikleriyle birlikte
`test/ai-answer-quality-gate.test.mjs` içinde kalıcı sınamadır; çok istekli türlü yanıtlar da açılışla başlar.

## 5. Temsilî yanıtlar (aynı sentetik kanıt, önce / sonra)

Bütün sayılar doğrulanmış olgudur ya da tam nüfustan sunucuda hesaplanmış toplam/paydır. "Sonra" metinleri gerçek
arayüzden (Haiku 4.5 planlayıcı ve düzen modeli, sentetik veri) alınmıştır.

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
  > 3. **8 Kasım 2026** — en yakın teslim tarihi (**Kapasite planı** dahil)

Yönetici örneğinin son maddesindeki görev adı, tohumun +1 günlük terminine göre düzeltildi; bu bir yeni canlı koşu değildir.

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

## 6. İnceleme düzeltmelerinin güncel doğrulaması (7 Kasım 2026)

Bu bölümdeki güncel sınamalar, §4 ve §4b'deki tarihsel ölçümlerden ayrıdır. Eski Haiku başarı sayıları yeni
beklentilerle yeniden puanlanmış ya da yeniden koşulmuş sayılmaz. Tam vakalarda model düzeni zorunludur;
kanıtlı sunucu yedeği kullanıcıya yanıt verebilir ama model düzeni kabulünü geçirmez. Kısmi vakalarda genel
`unavailable` yanıtı geçiş sayılmaz; altın planlı örnekler kanıtlı `stop` yanıtı vermelidir.

Metin kapısı göreli tarihleri çözer ve seçilen her çok istekli örneğin bitişini denetler. Bağımlı baz plan
örneği, mevcut dört tur sınırında iki satırın ikisini de okuyan sentetik veriyle ölçülür; daha büyük bağımlı
nüfuslar için bir kabul iddiası değildir. Kısa tekrarlar, vurgusuz sayılar, yanlış tarihler, erken sonuç başlığı,
eksik grafik türü ve yanlış örgütsel düzey için olumsuz kontroller vardır.

Güncel sonuçlar: `npm test -- --test-concurrency=4` **5787/5787**, başarısız/atlanmış sınama **0**;
`npm run lint` ESLint uyarısı/hatası olmadan, `npm run build` başarıyla tamamlandı. Tam küme güvenlik,
yetki, kanıt ve belirlenimci planlayıcı kapılarını da içerir. Yeni değişmez sınamalarının ilk 19'u özgün
`21035f8` üzerinde başarısız, düzeltilmiş kodda başarılıdır; karışık kimlik paragrafının doğrulamada reddi
özgün kodda da geçtiği için bu inceleme iddiası uygulanabilir sayılmadı.

Kurum içi Windows VM ve 117/117 + 19/19 anlamsal danışmanlıklı kapılar bu ortamda çalıştırılmadı.
Tek vakalık sınırlı Haiku denemesi (`PHASE4E_TIER=F`, `PHASE4E_CASES=o39`) altyapıda durdu:
`PLANNER_PROVIDER_ERROR`, `exitCode: -1`, `apiCalls: 0`, doğrulanmış model kimliği yok. Bu ortamda
`claude` yürütülebiliri yoktur. Bu sonuç bir model kalite başarısızlığı ya da canlı kabul geçişi değildir.

## 7. Aşama G — yönetici ve proje zekâsı (9 Kasım 2026)

**Durum: SÜRÜYOR.** Belirlenimci kabul ve betikli görsel kabul geçti; Haiku nitelendirmesi koşuldu ve aşağıda olduğu gibi
kaydedildi (kısmi geçiş); Windows VM yeniden oynatması (§11 yordamı, Qwen/Gemma) **bekliyor**. Aşama G bu nedenle
TAMAMLANDI olarak işaretlenmez. Üç kanıt düzeyi ayrıdır: belirlenimci (altın plan, üretim hizmeti), Haiku (gerçek model,
planlayıcı ve düzen), Windows VM (kurum içi modeller; koşulmadı).

### 7.1 Yetenekler ve yeniden kullanılan bileşenler

| Kod | Yetenek | Uygulama (mevcut mimarinin genişlemesi) |
| --- | --- | --- |
| G1 | Yetkili her düzeyde yönetici özeti | Aynı analitik özet (`analysis`), bulgu motoru ve sunucu düzeni; giriş soruyu yanıtlayan bulguyla açılır, bölümler arası bulgular kapsam başına en çok dört cümlelik paragraflardır |
| G2 | Sınırlı çok kapsamlı plan | `analysis.also` (en çok 2 ek kapsam; dizi yazımı da kabul edilir). Her kapsam kendi nüfusu ve yetkisiyle okunur; özet ölçüleri önce, dağılım yönleri kalan okuma tavanıyla; sığmayan yön adıyla not edilir. Kapsamlar arası toplam yoktur; karşılaştırma yalnızca aynı tanımlı oranlarla (`levelComparison`); iç içe kapsam uyarısının örneği karşılaştırılan kapsamlardan kurulur. Takip yalnızca birincil kapsamı güncel yetkiyle yeniden okur |
| G3 | Örgütsel düzey kırılımı | `rota_task_analytics` gruplaması `department` / `unit` (sorumlunun dizindeki birimi; yalnızca kimliği açık sorumlu). Bir görev farklı birimlerde ayrı sayılabildiğinden grup sayıları toplanmaz (her yanıtta söylenir). `focus: org` düzeyin bir altına açılır (direktörlük → bölüm, bölüm → birim; birimin altı kişilerdir) |
| G4 | İş gücü zekâsı | Ekip iş yükü okuması kadroyu (`MR_V_ExecutiveScope`) aynı toplu işte okur: görünür açık görevi olmayan üye sıfır satırla eklenir; kadro kesik ya da adı çözülemiyorsa tamlık iddiası kurulmaz. Görev adedi emek/kapasite değildir (her yayılım bulgusunda söylenir); sıfır görünür görev boşta olmak değildir; gecikmede ilk sıradakiler işlemsel dille (performans yargısı yok) |
| G5 | Proje sağlığı ve kilometre taşları | `focus: milestones` (açık kilometre taşları, termine göre). Gecikmiş sayısı, en uzun gecikme, sıradaki kilometre taşı; termini olmayan kilometre taşı sıralamanın dışında olduğu söylenir ve yargı kurulmaz; "projenin bitişi kayar" denmez (kritik yol hesaplanmaz). Gecikmemiş satırın gecikme hücresi "Gecikmemiş" yazar |
| G6 | Özet + grafik + ayrıntılı liste (Q38) | `analysis` ile birlikte açık `request`/`additionalRequests`; özetin zaten okuduğu liste ikinci kez okunmaz; açık isteğin sorunu modelin yazdığı istek yoluyla döner (özetin genel "geçersiz" ayrıntısına dönüşmez) |
| G7 | İnce karşılaştırmalar ve ödünleşimler | Bileşik puan yok; adı verilen göstergelerle: tamamlanmaya karşın gecikme, görev sayısı ≠ baskı, oran ile sayının ayrışması, örgütsel yayılım, gecikmede ilk sıradaki proje(ler) (eşitlikte birlikte) |

Yeniden kullanılan bileşenler: analitik özet ve sunucu açılımı, türlü istek sözleşmesi ve doğrulayıcı, salt okunur araçlar
(`rota_task_analytics`, `rota_workload_summary`, `rota_task_search`, `rota_portfolio_summary`), kanıt defteri ve yeniden
doğrulama, bulgu motoru (`analyticalFindings`), sunucu düzeni ve önermeler, nitelendirme betiği ve arayüz kabulü.

**Yeni salt okunur erişim (tek):** görev olguları toplu işine eklenen kadro sonuç kümesi (`TEAM_ROSTER`; yalnızca
`@withRoster = 1` ve ekip süzgeciyle, kullanıcının kendi yönetim kapsamı, satır sınırlı) ve sorumlu satırına dizindeki
birim/bölüm (yalnızca kimliği açık sorumlu). Yeni araç, uç nokta, tablo, göç, arka plan işi ya da genel SQL aracı yoktur.

**Arayüz ve sınır değişiklikleri (kullanıcı yönergesi):** analitik özetin kabul edilen yön sayısı ve fiziksel okuma tavanı
4'ten 6'ya çıkarıldı (okuma bütçesi açıklamasının sık dönmesi). Toplam araç çağrısı (12), SQL süresi, sonuç boyutu ve
tur süresi sınırları değişmedi. Portföy proje tablosu ilk 10 sıralama yerine aracın kendi sınırıyla (25) tam listedir
(on projeden büyük portföyde dikkat ve eşzamanlı baskı bulguları kurulamıyordu); portföy değer okuması aynı okumayı paylaşır
(ek araç çağrısı yok). Model görünür plan şeması 29 368 karakter (sınır 32 000; ek isteklerde yinelenen açıklamalar kaldırıldı).
Aşama 5/6 ve üretim model yönlendirmesi (Qwen3-Next-80B-A3B-Instruct → gemma-4-31B-it) değişmedi.

### 7.2 Kıyas kümesi (sentetik)

`test/fixtures/bilgin-executive-benchmark.json` + `test/helpers/executiveBenchmarkSeed.mjs` (Aşama F verisini değiştirmeden
genişletir: örgütsel birimler, kilometre taşları, görünür görevi olmayan kadro üyesi, adaş iki proje, termini olmayan kilometre
taşı, görev başlığında istem enjeksiyonu). Gerçek kişi ya da kurum kaydı yoktur.

- **49 hedefli vaka** (g01–g52 aralığında; g39, g40 ve g46 kimlikleri kıyas kümesinde kullanılmaz — tur içinde yetki kaybı, yeniden
  açılış ve yeniden oynatma `test/ai-executive-intelligence.test.mjs` içinde adlı sınamalarla doğrulanır):
  yönetici 8, yönetici (birim) 8, proje yöneticisi 7, çalışan 5, karmaşık 7, birleşik 2, sistem yöneticisi 1, saldırgan 11.
  Sınıf: tam 40, kısmi 5, yetkisiz 2, açıklama 1, sınırlı 1 (g23 → H).
- **22 bağımsız ayrık vaka** (x01–x22, yalnızca planlayıcı). Üretim kodu bu cümlelere göre ayarlanmadı; ayrık kümenin
  ortaya çıkardığı iki **yapısal** kusur (özet + açık istek onarım yolu; "kendi + tek adlı kişi" ek kapsamının kendiyle
  karşılaştırmaya çevrilmesi) düzeltildi ve bu iki vakanın sonraki koşusu bağımsız sayılmaz.
- **Güvenlik:** yetkisiz kapsam (çalışan, yalnızca birim kapsamlı yönetici), karışık yetkili/yetkisiz kapsam, takipte kapsam
  genişletme, tur içinde yetki kaybı (son çizimde kanıt kullanılmaz), yeniden açılışta bölüm kapsamı kaybı, adaş proje
  (açıklama), istem enjeksiyonu (başlık veri olarak kalır; okumalar bildirilen kişiyle sınırlı), örtüşen birim nüfusu,
  sıfır değerde uydurma yüzde yok, kimliği kapalı eş sorumlunun birimi açıklanmaz, çözülemeyen kadro kimliği sızmaz.

### 7.3 Belirlenimci kabul

`test/ai-executive-intelligence.test.mjs`: 48 altın planlı vaka (canlı nitelendirmenin beklentisinin aynısıyla:
`executiveExpectation`) + 26 hedefli sınama (çok kapsamlı plan, birleşik plan, kadro tamlığı, örgütsel kırılım, kilometre
taşı, yetki ve enjeksiyon, saf bulgu birimleri, şema boyutu, puanlayıcı). Tam küme: `npm test -- --test-concurrency=4`
**5951/5951** (başarısız/atlanan 0), `npm run lint` uyarısız, `npm run build` başarılı.

### 7.4 Haiku nitelendirmesi (claude-haiku-4-5-20251001, `--effort low`, `MAX_THINKING_TOKENS=0`)

Her çağrıda model kimliği ve sıfır düşünme belirteci kayıttan doğrulandı (bütün koşularda `models = [claude-haiku-4-5-20251001]`,
`thinking = 0`); her koşu kendi bütçesiyle (`PLANNER_CLAUDE_MAX_CALLS`, `PLANNER_CLAUDE_MAX_UNCACHED`) koşuldu. Derin modele
giden her çağrı modele gitmez ve başarısızlık (`DEEP_ESCALATION`) sayılır. Hesabın hız sınırı kullanımı 0,99'a ulaşınca
koşular durduruldu ve pencere açılınca parçalar hâlinde sürdürüldü; altyapı hatası (`ADAPTER_ERROR`, CLI `error_max_turns`)
koşuyu durdurur, o vaka yeniden koşulur (aşağıda belirtildi).

| Koşu | Vaka | Geçen | Çağrı | Girdi | Önbellek yazma | Önbellek okuma | Çıktı |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| G hedefli, koşu 1 (g01–g21; g21 altyapı hatası) | 21 | 7 | 43 | 54 320 | 47 631 | 861 943 | 12 909 |
| G hedefli, koşu 2 (g21–g30) | 10 | 5 | 23 | 22 802 | 33 790 | 570 711 | 6 215 |
| G hedefli, koşu 2 (g31–g38; g38 altyapı hatası) | 8 | 2 | 15 | 10 224 | 18 173 | 435 120 | 4 302 |
| G hedefli, koşu 2 (g38–g52) | 12 | 7 | 23 | 28 648 | 16 988 | 508 796 | 5 396 |
| G ayrık, ilk koşu (yapısal düzeltmelerden önce) | 22 | 14 | 29 | 87 | 16 582 | 1 077 083 | 7 903 |
| G ayrık, son kod (x01–x11; x11 altyapı hatası) | 11 | 7 | 14 | 42 | 17 917 | 508 765 | 3 643 |
| G ayrık, son kod (x11–x22) | 12 | 9 | 19 | 57 | 30 412 | 690 060 | 5 734 |
| F hedefli o33 / o39 / o20 (uçtan uca) | 3 | 1 | 6 | 6 350 | 5 844 | 145 040 | 1 911 |
| F ayrık 24 (dal) | 24 | 14 | 36 | 108 | 57 218 | 1 305 288 | 11 161 |
| F ayrık 24 (`main`, aynı koşul) | 24 | 14 | 39 | 117 | 103 015 | 1 427 964 | 10 940 |
| F özgün 40 (dal; o01–o14, o15–o28, o29–o40) | 40 | 9 | 88 | 116 680 | 72 308 | 1 852 858 | 23 581 |
| F özgün 40 (`main`, aynı koşul, aynı parçalar) | 40 | 8 | 82 | 99 651 | 78 334 | 1 869 791 | 20 442 |

`main` koşularının sayıları defterden toplandı (`main`'deki nitelendirme betiği raporu ilk vakadan sonra yazıyordu; bu dalda
düzeltildi). Dal ve `main` koşuları aynı saat aralığında, aynı model, bütçe ve vaka parçalarıyla yapıldı.

**Özet:** G hedefli kümede her vakanın son koşusuyla **21/49** (planlayıcı + düzen modeli, kanıtlı yanıt ve bütün yapısal
beklentiler); G ayrık kümede son kodla **16/22** (x11 altyapı hatasından sonra yeniden koşuldu). F ayrık kümede dal ile `main`
aynı koşulda **14/24 = 14/24** (başarısız kümeleri farklı; h03 ve h23 dalda geçti, `main`'de geçmedi); F özgün 40 vakada dal
**9/40**, `main` **8/40** (o01–o14 parçasında aynı iki vaka; kalan farklar Derin devri ve plan değişkenliğidir: o26 dalda Derin devri,
o31/o39 `main`'de başarısız). Gerileme göstergesi yoktur. F özgün kümenin düşük mutlak sonucu, kayıtlı 28/39'dan sonra eklenen katı
denetimlerden (en sık `analitik yönler eksik`: altın planın bütün yönleri okunmalı) gelir ve `main`'de de aynıdır.

**Başarısızlık sınıfları (G hedefli):** (1) planlayıcının kapsam/düzey/yön seçimi altın plandan farklı ya da plan geçersiz
(g01, g03, g05, g07, g13–g15, g17, g19, g20, g27, g28, g30–g32, g34, g35, g38, g51); (2) Haiku düzeni reddedilip Derin anlatım
istendi, yanıt sunucu düzeniyle doğru teslim edildi (g04, g25, g29, g33, g41, g43; F'deki o33/o39 ile aynı sınıf; aynı vakaların
yeniden koşusunda düzen kabul edildi — model değişkenliği); (3) beklenti fazlası: g10, g11, g14 düzey adı geçmeyen "ekibim"
sorusunda birim düzeyi bekliyordu ve g15 sorusu kapsam adı taşımıyordu — canlı koşudan SONRA düzeltildi (düzeysiz ekip; soruya
"Birimimin"), koşu sonuçları düzeltmeyle yeniden puanlanmadı; (4) g47 planlayıcı kişi yerine proje kırılımı seçti (yığılmış
grafik ayrık açık/tamamlanan bölümlerinden kurulduğu için doğrudur; puanlayıcı yalnızca birbirini kapsayan serilerin
yığılmasını ihlal sayacak biçimde düzeltildi).

**Kanonik planlayıcı kapısı (117/117 + 19/19):** anlamsal danışmanlık (şirket içi gömme/yeniden sıralama) gerektirdiğinden
bu ortamda koşulamaz; G için ölçülmedi.

### 7.4b Zayıf model güvenilirliği düzeltmeleri ve yeniden ölçüm (10–11 Kasım 2026)

**Durum: YAKINSAMADI.** Aşağıdaki kök nedenler belirlenimci olarak yeniden üretildi, düzeltildi ve regresyon sınamasıyla
korundu; düzeltmelerden SONRAKİ tam Haiku koşusu hesabın haftalık kullanım sınırı (0,99; ardından `429`) nedeniyle
yapılamadı. Bu bölümdeki canlı sayılar düzeltmelerden ÖNCEKİ taban ölçümdür; 49/49 ve 22/22 hedefi ölçülmemiştir.

| Koşu (claude-haiku-4-5-20251001, `--effort low`, düşünme 0) | Vaka | Geçen | Çağrı | Girdi | Önbellek yazma | Önbellek okuma | Çıktı |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| G ayrık (ilk beş inceleme düzeltmesiyle) | 22 | 18 | 33 | 99 | 49 885 | 1 198 878 | 8 886 |
| G hedefli taban (aynı kod) | 49 | 21 | 102 | 112 731 | 138 993 | 2 268 045 | 28 625 |
| Düzeltme sonrası doğrulama (x01, x07, x12, x14; x14 altyapı) | 4 | 1 | 8 | 21 | 23 436 | 250 047 | 1 582 |
| Düzeltme sonrası G hedefli doğrulama | 11 | — | 1 | 0 | 0 | 0 | 0 |

Son satır ilk çağrıda `429` (kullanım sınırı) ile durdu: altyapı hatasıdır, model sonucu değildir. Bütün çağrılarda model
kimliği doğrulandı, düşünme belirteci 0; Derin modele giden çağrı modele gitmez ve başarısızlıktır. F kümeleri bu oturumda
koşulmadı.

**Taban koşusunun başarısızlık sınıfları ve yapılan düzeltme** (her biri altın planla değil, Haiku'nun GERÇEK planının
belirlenimci yeniden oynatılmasıyla doğrulandı):

| Kök neden | Örnek vaka | Düzeltme |
| --- | --- | --- |
| Geçerli onarım "kapsam değişti" diye reddedilip Derin'e devrediliyor (reddedilen alan yüzünden birleşemeyen eşdeğer yazım) | g15 | Onarım karşılaştırması reddedilen yollar çıkarıldıktan sonra yeniden normalleştirilir; ek kapsamda reddedilen dönem özetin dönem alanlarında yeniden yazılabilir. Kapsam, düzey, ad ve yön değişikliği eskisi gibi reddedilir |
| Model düzeninde tek hatalı blok (bölümleri karışık not, yinelenen/bilinmeyen kaynak, paragrafsız bölüm) bütün düzeni reddettirip Derin anlatıma devrediyor | g07, g31, g41 | Düzyazı düzeninde hatalı seçim yalnızca o bloğu düşürür; kapsamı sunucu tamamlar. Bozuk biçimli blok ve kimlik düzeni katı kalır |
| Eşdeğer istek yazımı onarım turu harcıyor: dizi biçimli istek, `null` süzgeç, `assignee: any`, süzgeçte proje adı, bağsız `task.project` | g21, g27, g38, g51, g52, x07 | Yapısal normalleştirme (ad güvenilir metin denetiminden aynen geçer); listede adlandıran sütun ad alanına bağlanır, tek değerde belirsizlik modele kalır |
| Portföy + "önümüzdeki 7 gün" dönemi portföy okumasını düşürüyor | g02 | Bugünden başlayan yedi günlük dönem portföyün kendi ölçüsüdür (`tasks.dueNext7Days`) |
| Özetin yanındaki isteğin düzeysiz ekip koşulu | g52 | Özet tek ekip düzeyi taşıyorsa düzey istekten tamamlanır |
| Planlayıcı yönergesi: özet/istek ayrımı, yön seçimi, örgütsel düzey, dönem ve tarihsel eğilim kuralları dağınık ya da eksik | g01, g03, g11, g14, g17, g19, g20, g28, g43, x12 | "KAPSAM VE ANALİTİK ÖZET" bölümü tek tek adlandırılmış kurallara ayrıldı; eğilim sorusu `abstain outside_data` olarak tanımlandı |
| Bağdaştırıcı: CLI kendi ortam bağlamını (makinenin güncel tarihi dahil) modele ekliyor; sentetik "bugün" ile çelişiyor | g51 | Kullanıcı iletisinin başına ortam notu; sistem yönergesi ve araç kataloğu (önbellek öneki) değişmez |

**Açık kalanlar.** (1) Düzeltme sonrası G hedefli/ayrık ve F hedefli/ayrık tam koşuları yapılmadı. (2) İlk yanıtın düz metin
olması (`forcedText`: CLI zorunlu aracı kısıtlı çözümle uygulayamıyor) onarım hakkını tüketiyor; üretimde adlı araç seçimi
bunu engeller, bağdaştırıcıda engellenmiyor. (3) g05, g07, g32, g35 beklentileri sorunun adlandırmadığı bir yön ya da kapsam
istiyor; beklenti değiştirilmedi. (4) Yanıt düzyazısı: giriş her zaman soruyu doğrudan yanıtlamıyor (ör. "genel görünüm olumlu
mu?" sorusunda yanıt iş yükü yayılımıyla açılıyor) ve bölüm başlıkları ile tablolar anlatımı bölüyor; düzyazı kabulü
sağlanmadı. (5) Betikli arayüz kabulü bu oturumda tarayıcıyla yeniden koşulmadı; kapsam kuralı birim sınamasıyla doğrulandı.

### 7.5 Görsel kabul (gerçek arayüz, betikli planlar)

Gerçek `next build` + SQL ikizi (yönetici sentetik verisi, `UI_SEED=executive`) + yeni betikli uç
(`scripts/ui-acceptance/scriptedBridge.mjs`, `UI_SCRIPTED=1`): planlayıcı turunda altın plan, düzen turunda kapsayan düzen;
model çağrısı yoktur, model kalitesi bu kanıtın kapsamında değildir. 9 G vakası (çok kapsamlı özet, örgütsel kırılım, proje
sağlığı, kadro tamlığı, portföy + ekip + kilometre taşı, özet + grafik + liste, örtüşen seriler, bütçeyi aşan kapsam, iki proje
sağlığı) × 4 görünüm (masaüstü/mobil × açık/koyu) = **36 ekran görüntüsü, 0 başarısızlık**; görüntüler incelendi. İnceleme
bulguları ve düzeltmeleri: dar ekranda tablo hücresi adı sözcük ortasından bölüyordu (hücre artık yalnızca sözcük sınırında
kırılır; tablo kendi kabında kayar); kapsam karşılaştırması sayıları bölümlerle yineliyordu (giriş artık yalnızca oranları
karşılaştırır); yığılmış grafik başlığı grubu adlandırmıyordu ("Projelere göre durum"); dönemli öncelik satırları "kendi
işleriniz · …:" etiketiyle başlıyordu ("Kendi işlerinizde (…):"); boş görev listesi "Gösterilecek görev yok (ölçüt: …)"
diyordu ("Açık göreviniz yok."). Haiku ile canlı arayüz koşusu hesap kotası nedeniyle yapılmadı.

### 7.6 Hedef soruların durumu

| Soru | Önceki sınıf | Aşama G | Belirlenimci | Haiku (son koşu) |
| --- | --- | --- | --- | --- |
| Q2 (o02) | kısmi → G | tam: kadro okumasıyla iş yükü yayılımı + kapasite çekincesi | ✓ | yön seçimi farklı (`main` ile aynı) |
| Q4 (o04) | kısmi → G | kısmi (veri): portföy genelindeki kişilerin kadrosu yoktur; kişi yoğunlaşması gerekçeli kısmi yanıttır | ✓ | yön seçimi farklı (`main` ile aynı) |
| Q6 (o06) | kısmi → G | tam: yayılım + gecikmede ilk sıradakiler | ✓ | yön seçimi farklı (`main` ile aynı) |
| Q9 (o09) | kısmi → G | tam: direktörlük → bölüm kırılımı (örtüşme kuralıyla) | ✓ | `main`'de Derin devri; dalda yön seçimi farklı |
| Q12 (o12) | tam (G sınırı) | kilometre taşı durumu eklendi | ✓ | ✓ |
| Q13 (o13) | kısmi → G | tam: görev sayısı ≠ baskı | ✓ | yön seçimi farklı (`main` ile aynı) |
| Q14 (o14) | kısmi → G | tam: tam kadroda gecikmede ilk sıradakiler | ✓ | yön seçimi farklı |
| Q15, Q19, Q28, Q38 | kısmi/sınırlı → G | tam: tamamlanmaya karşın gecikme; çok kapsamlı plan; örtüşen seri notu; özet + liste | ✓ | o15 yön seçimi; o19 farklı ek kapsam + Derin devri; o28 yön seçimi; o38 ufuk okunmadı (G'de birleşik plan: g51 ✗, g52 ✓) |
| h03, h18, h23 | açık | düzey; kapasite sorusu; kendi + kişi | — | h03 ✓, h18 ✓, h23 ✓ (dal; `main`'de h03/h23 başarısız) |
| o33, o39, o20 | kararsız | — | ✓ | o39 ✓; o33 durum grubu kanıtı ve halka grafik yok; o20 doğrulanmış yanıt yok (`grounding_failed`) |

### 7.7 Sınırlar ve Aşama H bağımlılıkları

Kapasite verisi yoktur (görev adedi emek değildir); tarihsel karşılaştırma, dönem kıyası, tamamlanma eğilimi ve çoklu ufuk H'dir
(g23, o07, o27, o30). Kritik yol hesaplanmaz. Kilometre taşı listesi ilk 8 satırla sınırlıdır (kesik listede gecikmiş sayısı ancak
sıradaki tarih görünürse kesindir). Portföy proje tablosu en çok 25 projedir (fazlasında projeler arası bulgu kurulmaz). Çok kapsamlı
plan en çok üç kapsamdır; farklı dönemli kapsamlar tek planda kabul edilmez. Haiku'da en sık açık davranışlar: kapsam/yön seçimi,
geçersiz plan tekrarı, düzen reddi → Derin isteği (model değişkenliği; aynı vakalar yeniden koşuda geçebiliyor).
