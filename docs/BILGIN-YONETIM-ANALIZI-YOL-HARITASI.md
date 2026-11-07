# Bilgin Yönetim Analizi Yol Haritası (Aşama F–K)

Bu belge, Bilgin'i ağırlıklı olarak veri getiren bir yardımcıdan **kanıta dayalı bir yönetim analistine**
dönüştüren çok oturumlu girişimin **tek yetkili yol haritasıdır**. Gelecekteki her Claude Code ya da Codex
oturumu sohbet geçmişine dayanmadan bu belgeden devam edebilmelidir.

| Konu | Yetkili belge |
| --- | --- |
| Altyapı, anahtarlar, model profilleri, akış (Aşama 1–2) | [Yapay Zekâ Platformu](YAPAY-ZEKA-PLATFORMU.md) |
| 19 salt okunur alan aracı, kanıt, atıf, yetki (Aşama 3) | [AI Alan Araçları](YAPAY-ZEKA-ALAN-ARACLARI.md) |
| Anlamsal katman, planlayıcı, 4A–4E, nitelendirme kapıları | [AI Anlamsal Katmanı](YAPAY-ZEKA-ANLAMSAL-KATMAN.md) |
| Yetki modeli | [Yetkilendirme Modeli](YETKILENDIRME-MODELI.md) |
| Bu girişimin 40 soruluk kabul matrisi ve kıyas kümeleri | [Bilgin Analiz Kabul Matrisi](BILGIN-ANALIZ-KABUL-MATRISI.md) |

Bu belge yukarıdaki belgelerin sözleşmelerini yinelemez; onlara bağlanır. Çelişki varsa güvenlik ve yetki
sözleşmesi o belgelerdedir; bu belge kapsam, sıra, kabul kapıları ve ilerleme kaydının sahibidir.

---

## 0. Oturum kuralları (her oturum için zorunlu)

**Oturum başında:**

1. Bu belgeyi, §2'deki başlangıç durumunu ve §13'teki oturum devrini okuyun.
2. Bağlı mimari belgeleri (yukarıdaki tablo) ve etkin aşamanın "Mevcut yeniden kullanılacak yetenekler"
   bölümündeki dosyaları okuyun.
3. `main` başını ve açık PR'ları yeniden doğrulayın; bu belgedeki karma (SHA) değerleri yazıldığı anın kaydıdır.
4. Eşzamanlı işle çakışma olup olmadığını denetleyin; başkasının çalışmasının üzerine yazmayın.

**Oturum sonunda** bu belgede güncelleyin: ne uygulandı, ne doğrulandı, ne açık kaldı, kapıların **tam**
sonuçları (sayılarla), bilinen sınırlar, önerilen sonraki iş, PR/commit kaynakları. Kabul koşulları gerçekten
karşılanmadan hiçbir aşama **TAMAMLANDI** yapılmaz.

**Durum sözlüğü:** PLANLANDI · SÜRÜYOR · ENGELLİ · DOĞRULANDI (kapılar geçti, kurum içi kabul bekliyor) ·
TAMAMLANDI (kurum içi kabul dâhil bütün kapılar geçti).

**Üç kanıt düzeyi hiçbir zaman karıştırılmaz:**

| Düzey | Anlamı |
| --- | --- |
| Belirlenimci geçiş | Üretim kodu, denetlenen sentetik veriyle (sahte sağlayıcı, SQL ikizi) çalıştı |
| Haiku nitelendirmesi | Gerçek, kimliği doğrulanmış `claude-haiku-4-5-20251001`, düşünme kapalı, en düşük çaba |
| Windows VM kabulü | Kurum içi gerçek `Qwen3-Next-80B-A3B-Instruct -> gemma-4-31B-it` zinciri, gerçek uygulama altyapısı |

Haiku, zayıf model dayanıklılığı için dış bir ölçüttür; üretimdeki Qwen/Gemma dağıtımının çalıştığının kanıtı
**değildir**. Windows VM'nin kendi kabul sonucu ayrıca kaydedilir.

---

## 1. Mevcut numaralı yol haritasıyla ilişki

Numaralı yol haritası **olduğu gibi korunur**:

| Aşama | Kapsam | Bu girişimdeki yeri |
| --- | --- | --- |
| 1–4 (4A–4E dâhil) | Altyapı, akış, kanıta dayalı araçlar, anlamsal katman, kanıta bağlı anlatım, analitik özet | Temel; yeniden kullanılır, genişletilir, yeniden yazılmaz |
| **5** | Yapay zekâ eliyle görev oluşturma, düzenleme, atama ve diğer yetkili **yazma** işlemleri | **Dokunulmaz.** F–K hiçbir yazma işlemi eklemez; Aşama 5'in amacı ve kapsamı değişmez |
| **6** | Çok kipli yetenekler (ses ve görsel) | **Dokunulmaz** |

Bu girişim **harfli** aşamalar kullanır: **F, G, H, I, J, K**. Aşama F, "Aşama 4F" değildir; Aşama 5 yeniden
numaralandırılmaz ya da yeniden amaçlandırılmaz. Harfli program, Aşama 5'ten **önce** bilinçli olarak yürütülen
bir analitik ve raporlama geliştirmesidir. Ek aşama (L, …) ancak ölçülmüş bir gerekçeyle ve bu belge bilinçli
olarak güncellenerek açılır.

```
F  Gelişmiş sohbet analizi ve doğal düzyazı        (sohbet = birincil ürün yüzeyi)
G  Yönetici ve proje zekâsı                          (F'nin bulgu motoru üzerinde)
H  Dönemsel, tarihsel ve not farkındalıklı zekâ      (G'nin kapsamları + geçmiş/metin)
I  Profesyonel yönetim raporu (DOCX)                 (F–H analizini yeniden kullanır)
J  Kalıcı arka plan raporlama ve teslim             (I'nin ürettiği taslaklar)
K  Endüstriyel nitelendirme ve işletim mükemmeliyeti (sistem düzeyi; temel kapılar her aşamada zaten zorunlu)
```

---

## 2. Doğrulanmış başlangıç durumu (7 Kasım 2026)

- Varsayılan dal `main`; gözlenen baş `51d2cb46890576effd0a1841045438246564ed1f` (PR #114 birleştirildi).
  Açık PR yoktu.
- 19 salt okunur Rota aracı (`src/server/ai/tools/toolRegistry.js`); genel SQL aracı yok; model SQL üretmez.
- Aşama 4E: analitik özet (`rota_plan.analysis`, `src/server/ai/tools/analysisPlan.js`), kanıta bağlı önermeler
  (`src/domain/ai/groundedPropositions.js`), kapalı düzen ve sunucu yuvalı düzyazı
  (`src/domain/ai/groundedComposition.js`, `groundedProse.js`), grafik dilbilgisi (`answerChart.js`),
  yanıt ayrıntısı (`answerDetail.js`), kanonik takip bağlamı (`analysisContext.js`).
- Nitelendirme altyapısı: `scripts/planner-model-adapter.mjs` (Claude CLI, model kimliği ve düşünmesizlik her
  çağrıda gözlemden doğrulanır), `planner-evaluation.mjs` + `planner-scoring.mjs` (kanonik **117/117** ve zorunlu
  ek **19/19** kapısı), `analysis-qualification.mjs` (4E katmanları B/C/D/E), `answer-composition-qualification.mjs`,
  `planner-followup-qualification.mjs`, arayüz kabulü `scripts/ui-acceptance/` (gerçek `next build` + SQL ikizi +
  Haiku köprüsü + Playwright).
- Sınama tabanı (bu oturumun başında, `npm test`): 5413 sınamadan 5410 geçti; 3 hata yalnızca çalışma ortamında
  `jsdom` geliştirme bağımlılığının eksikliğiydi (`npm install --no-save jsdom@26.1.0` sonrası geçer). Kod hatası
  değildir.

---

## 3. Gerçek dünya kanıtı: 40 Windows VM sorusu

Aşama 4E dağıtımında 40 soru sırayla soruldu. Gözlenen sonuç: **16 tam başarısızlık** ve sonuç döndüren ama
yeterince doğal ve içgörülü olmayan **24 mekanik yanıt**. Başarısız soru numaraları:
**2, 3, 5, 7, 11, 16, 19, 24, 27, 30, 34, 35, 36, 38, 39, 40**.

Dağıtılan model zinciri: `Qwen3-Next-80B-A3B-Instruct -> gemma-4-31B-it`. Günlük örüntüleri:
`REQUEST_DECLARATION`, `EMPTY_COMPLETION`, `AI_PROVIDER_RESPONSE_INVALID`, `PROSE_UNGROUNDED`,
`WARN unavailable`, `AI FAIL failed`, `tools 0`, `evidence 0`.

**İlke:** Soru ile günlük satırı arasındaki birebir eşleme ekran görüntülerindeki görsel sıradan çıkarılmaz.
Günlük satırları ilişki kimliği (correlation id) taşır; soru metni taşımaz (içeriksiz telemetri, bilinçli tasarım).
Bu nedenle bu belge **örüntü sınıflarını** ve belirlenimci olarak yeniden üretilen kök nedenleri kaydeder; soru
başına eşleme yalnızca VM'de korelasyon kimliğiyle yeniden oynatılarak kurulabilir (§11).

**İki ayrı başarısızlık sınıfı:** 16 tam başarısızlık ile 24 mekanik yanıt farklı kusurlardır. Tablo döndüren
yanıt analitik olarak başarılı sayılmaz; hata yerine genel bir çekince döndüren yanıt da başarılı sayılmaz.
Sorunun tamamı değerlendirilir.

Gizlilik: Soruların bir kısmı gerçek çalışan ve proje adları içerir. Depoya giren her kıyas verisi **sentetiktir**;
analitik yapı ve zorluk korunur (ör. büyük harfli Türkçe soyadı, kurumsal sözcük içeren proje adı). Birebir
özel yazım yalnızca elle yeniden oynatma için ve **sürüm denetimi dışında** tutulur.

Ayrıntılı soru × yetenek matrisi, kök nedenler ve sonuçlar:
[Bilgin Analiz Kabul Matrisi](BILGIN-ANALIZ-KABUL-MATRISI.md).

---

## 4. Bütün aşamalarda ortak (küresel) gereksinimler

Kalite ve güvenlik kapıları her aşamada zorunludur; Aşama K temel güvenceleri ertelemez, sistem düzeyinde
genişletir.

### 4.1 Güvenlik ve doğruluk (pazarlık edilemez)

- Güvenilir Sicil kimliği; her araç kümesinde ve son çizimden önce güncel yetkinin yeniden doğrulanması.
- Kurumsal kapsam sınırları; FULL / PARTIAL / READ ayrımı; yetkisiz proje ya da çalışan bilgisi açıklanmaz.
- Kullanıcılar ve konuşmalar arası kanıt sızıntısı yok; bayat kanıt geçersizleştirilir.
- Model SQL üretmez; açık uçlu veritabanı sorgu aracı yoktur; SQL sabit, parametreli ve sunucuya aittir.
- F–J araçları **salt okunurdur**. Aşama 5 yazma işlemleri bu girişimde uygulanmaz.
- Sınırlı iş yükü ve kaynak tüketimi; sınırlar planlayıcı kusurunu gizlemek için büyütülmez.
- Boş ve eksik değerler güvenle işlenir (NULL ≠ 0); kesik koleksiyondan bütün nüfus sonucu çıkarılmaz.
- İstem enjeksiyonuna direnç; korunan serbest metin (açıklama, ileti, değişiklik metni) yalnızca açık rızayla.
- İptal, yeniden oynatma ve zaman aşımı davranışı korunur; denetimsiz model yeniden denemesi yoktur.
- Desteklenmeyen sonuçlar konusunda kesinlik: sıfır görünür görev boşta olmayı kanıtlamaz; daha çok görev daha
  çok iş demek değildir; yüksek tamamlanma düşük teslim riskini kanıtlamaz; gecikme ile kişi arasındaki ilişki
  suç atfı değildir; notlar bir sorunu bildirir, nedenini kanıtlamaz; eksik tarihsel anlık görüntü model akıl
  yürütmesiyle onarılamaz.

### 4.2 Model ve sunucu sorumlulukları

| Sunucu (belirlenimci) | Model (doğrulanan danışman) |
| --- | --- |
| Kimlik, yetki, SQL, nüfus, aritmetik, paylar, sıralama, tamlık, bulgu önkoşulları, sayıların ve adların yazımı | Niyetin türlü planı (kapsam, yönler, ufuk, görsel), anlatım sırası ve vurgu (kapalı kimliklerle) |

Model **aritmetik otoritesi değildir**. Türkçe ya da İngilizce kullanıcı metni regex, anahtar sözcük ya da
el yazımı eş anlamlı tablolarla yorumlanmaz ([Anlamsal Katman §4](YAPAY-ZEKA-ANLAMSAL-KATMAN.md)); kıyas
cümlelerine göre üretim kodu yamanmaz.

### 4.3 Anlatım kalitesi

Doğruluk anlatımdan önce gelir. Her olgusal iddia (sayı, tarih, varlık, karşılaştırma, sonuç) doğrulanmış
kanıta dayanır ya da doğru biçimde nitelendirilir. Akıcılık, zayıf bir sonradan-regex süzgeciyle değil,
kanıta bağlı anlatım temsiliyle (sunucu cümleleri, kapalı söylem bağları, türlü olgu göndergeleri) sağlanır.
Uzunluk soruya göredir: basit soruya kısa ve doğrudan yanıt; karşılaştırmaya anlamlı anlatım + tablo/grafik;
geniş değerlendirmeye giriş, bölümler ve sonuç.

### 4.4 Görselleştirme

İstenen grafik türleri kanıtla çizilebiliyorsa çizilir; çizilemiyorsa türe özgü not verilir, sessizce başka tür
çizilmez. Grafik ve tablo aynı yetkili veriye dayanır; yanıltıcı payda yoktur; eksik nüfus etiketlenir; Türkçe
karakterler korunur; dar ekranda okunabilirlik zorunludur. Doğru değerli ama okunamayan grafik başarısızdır.

### 4.5 Sınama ve nitelendirme ekonomisi

1. Önce belirlenimci yeniden üretim (sahte sağlayıcı, sentetik veri; model çağrısı yok).
2. Hedefli Haiku duman sınaması (küçük temsilî küme).
3. Yalnızca kanıtlanmış hataların onarımı; her küçük değişiklikte bütün küme koşulmaz.
4. 40 özgün senaryonun tam Haiku nitelendirmesi.
5. Zor ayrık (holdout) kümenin nitelendirmesi.
6. Planlayıcı davranışı değiştiyse kanonik 117/117 + zorunlu ek 19/19; anlatım değiştiyse ilgili düzen kapıları.
7. Uygulama kararlı olduktan sonra yalnızca gerekli tam kabul kapılarının son teyidi.

Kurallar: kararlı sistem yönergesi ve önbelleğe alınabilir önek korunur; araç bildirim sırası sabittir; çağrı ve
belirteç sayısı kaydedilir; koşudan önce açık bütçe (`PLANNER_CLAUDE_MAX_CALLS`, `PLANNER_CLAUDE_MAX_UNCACHED`)
konur; kimlik doğrulama, kota, sağlayıcı uyuşmazlığı ya da altyapı hatasında durulur; daha güçlü modele sessizce
geçilmez; Haiku sınamalarını geçirmek için kurum içi model eşlemeleri değiştirilmez. Model kimliği ya da
düşünmesizlik doğrulanamazsa sonuç **GEÇERSİZ/DOĞRULANMAMIŞ** sayılır, geçiş raporlanmaz.

### 4.6 Görsel kabul

Otomatik sınama tek başına yeterli değildir. Gerçek uygulama arayüzü (ya da doğru bütünleşik ortam, sentetik
veri) açılır, ekran görüntüleri alınır ve **gerçekten incelenir**: masaüstü ve dar/mobil görünüm, açık ve koyu
tema, kaydırma, taşma, tablo ve grafik boyutu, erişilebilirlik, klavye, tipografi, giriş/bölüm/sonuç yerleşimi.
Elle hazırlanmış örnek ekran görüntüsü üretim çizicisinin kanıtı sayılmaz. Altyapı izin vermiyorsa neyin
sınandığı, neyin sınanamadığı ve nedeni kaydedilir.

### 4.7 Mühendislik disiplini

Kök neden düzeltilir; geniş yeniden yazım yapılmaz; model görünür şemalar küçük tutulur; kanıt doğrulaması
zayıflatılmaz; erişim genişletilmez; gereksiz bağımlılık eklenmez; Windows uyumluluğu ve AI dışı uygulama
başarımı korunur. Yeni kod yorumları, sınama adları ve açıklamaları Türkçedir. Yeni betik adları PR numarası,
`pr`, `codex`, `claude` ya da geçici oturum adı içermez (mevcut adlar yeniden adlandırılmaz). Her PR kendi
dalında **tek** commit olarak teslim edilir; `main`'e zorla gönderim yapılmaz; PR birleştirilmez.

---

## 5. AŞAMA F — Gelişmiş sohbet analizi ve doğal düzyazı

**Durum: SÜRÜYOR** (ilk dikey dilim bu oturumda; ayrıntı §13).

### F.1 Amaç ve kullanıcı değeri

Var olan Bilgin sohbetinde karmaşık, çok yönlü yönetim sorularının güvenilir planlanması; birden çok kanıt
bölümünü birleştiren yapılandırılmış ve kanıtlı **bulgular**; soruyu doğrudan yanıtlayan bir giriş, bulgu
odaklı analiz ve gerekçeli bir sonuçtan oluşan doğal Türkçe yanıt. Yönetici, proje yöneticisi ve çalışan aynı
analitik zekâdan yararlanır.

### F.2 Yeniden kullanılacak mevcut yetenekler

- Analitik özet ve belirlenimci açılım: `src/server/ai/tools/analysisPlan.js`, `executionSet.js`.
- İstek bildirimi/nüfus: `requestDeclaration.js`, `requestPopulation.js`, `src/domain/ai/requestContract.js`.
- Kanıt, atıf, son yetki denetimi: `groundedAnswer.js`, `evidenceVerification.js`, `claimableEvidence.js`.
- Önermeler, analist önermeleri, zorunlu çekinceler, akıcı paragraf: `groundedPropositions.js`.
- Kapalı düzen, sunucu düzeni, çizim: `groundedComposition.js`, `answerComposition.js`, `groundedProse.js`.
- Grafikler: `answerChart.js`, `src/features/ai/assistant/AnswerChart.jsx`.

### F.3 Eksik yetenekler ve bağımlılıklar (belirlenimci olarak yeniden üretildi)

| Kod | Eksik/kusur | Kanıt |
| --- | --- | --- |
| F-K1 | Okuma bütçesi: dört yönlü yönetici soruları ve iki kişi × üç yön karşılaştırması, ideal planla bile `requestBudget`/`maxItems` reddi alıyor | Q40, Q11 altın planla `grounding_failed` |
| F-K2 | Gelecek dönem penceresi gecikmiş iş okumasına da uygulanıyor; tanımı gereği boş ("önümüzdeki 14 gün + mevcut gecikmeler") | Q16, Q3: "… arasında terminli gecikmiş görev yok" |
| F-K3 | Bölümler arası sentez yok: giriş, karşılaştırmalı bulgu, öncelik ve sonuç paragrafı üretilmiyor; yanıt "cümle + tablo" dizisi | 24 mekanik yanıt; Q1/Q2 sondası |
| F-K4 | Tek grafik türü: "hem halka hem yığılmış" isteği temsil edilemiyor | Q39 |
| F-K5 | Çoklu ufuk (7/14/30 gün) ve dönemler arası karşılaştırma (son 30 gün ↔ önümüzdeki 30 gün) tek pencereyle temsil edilemiyor | Q7, Q30 → kısmen Aşama H |
| F-K6 | Tamamlanma eğilimi (gerçekleşen bitiş tarihine göre dönem dizisi) için işleç yok | Q27 → Aşama H |
| F-K7 | Üç düzeyli (kendi / ekip / bölüm) tek soruda farklı kapsamlar | Q19 → Aşama G |
| F-K8 | `EMPTY_COMPLETION`: Qwen, plan ya da düzeltme turunda <1 sn'de boş yanıt dönüyor; özdeş yeniden deneme de boş | VM günlüğü; burada yeniden üretilemez (§11) |

### F.4 Kapsam

**Kapsam içi (F):** F-K1, F-K2, F-K3, F-K4 çözümleri; F-K8 tanısının iyileştirilmesi ve VM yeniden oynatma yordamı;
40 soruluk regresyon tanımı, ≥20 zor ayrık soru, kapasite matrisi; F-K5/F-K6/F-K7 için doğru **sınırlı** davranış
ve açık bağımlılık kaydı; belirlenimci sınamalar; Haiku nitelendirmesi; görsel kabul.

**Kapsam dışı (F):** yeni model görünür araç; tarihsel anlık görüntü; not/metin analizi (H); dönem
karşılaştırması işleci (H); kurumsal sektör kapsamı (G); DOCX, arka plan işleri, e-posta (I/J); herhangi bir
yazma işlemi (Aşama 5).

### F.5 Önerilen işleçler

1. **Bulgu motoru** (`src/domain/ai/analyticalFindings.js`, saf): doğrulanmış tam kanıttan bölümler arası
   yapılandırılmış bulgular. Her bulgu: tür, varlık/nüfus, doğrulanmış ölçüler, karşılaştırma bağlamı, kanıt
   kimlikleri, tamlık ve izin verilen yorum (kapalı küme). Bulgular:
   - *Çoklu gösterge önceliği*: tam varlık tablosunda (portföy projeleri, ekip kişileri, proje/sorumlu grupları)
     gecikmiş işte tek başına ilk sıradaki varlığın başka baskı göstergelerinde de (yaklaşan termin, açık iş)
     ilk sırada olması.
   - *Gecikme yoğunlaşması*: tam dağılımda gecikmiş işlerin en az yarısının tek varlıkta toplanması (pay, sunucu
     hesabı).
   - *Eşzamanlı baskı*: aynı tam tabloda hem gecikmiş hem yakın terminli işi olan varlıklar.
   - *Tam görev listesinden dağılım*: eksiksiz gecikmiş/yaklaşan görev listesinin projelere ve görünür
     sorumlulara dağılımı (görev sayısı; atama dağılımıdır, neden ya da suç değildir).
   - *Öncelik sırası*: en uzun gecikmeli görev, dikkat önceliği alan varlık, en yakın teslimat.
2. **Giriş ve sonuç** (sunucu yazımı): bulgulardan soruyu yanıtlayan giriş paragrafı ve gerekçeli öncelik
   paragrafı; her sayı ve ad kanıttan, paylar tam nüfustan; atıflar ilgili kanıtlardır. Model düzeni değişmez.
3. **Gelecek pencere kuralı**: Gecikme her zaman bugüne göre ölçülür. Tamamen gelecekteki (başlangıcı bugün ya
   da sonrası) bir dönem gecikmiş iş okumasını daraltmaz; diğer yönler dönemi kullanır. Kanıtın ölçütü bunu
   görünür kılar ("Şu anda N gecikmiş görev var").
4. **Okuma bütçesi toleransı**: Modelin bildirdiği dört yön, fiziksel okuma sayısı mevcut üst sınıra
   (`ANALYSIS_LIMITS.maxParts` = 4) sığıyorsa düzeltme turu açılmadan kabul edilir. Model görünür şema
   ("1-3 yön") değişmez: önek önbelleği ve kanonik kapı istikrarı korunur. Şema sınırını aşan fazladan yönler onarılabilir; fiziksel bütçeye sığmayan
   karşılaştırmada bildirilen yönler düşürülmez, kullanıcıdan öncelik istenir.
5. **İki grafik türü toleransı**: `charts` alanında en çok iki farklı bilinen tür şemada bildirilir (`chart` dizisi eski yazım olarak korunur); her
   türün gerektirdiği okuma bütçeye sığıyorsa eklenir; çizilemeyen tür için türe özgü not verilir.
6. **Boş tamamlama tanısı**: `AI WARN empty completion` satırı sağlayıcının bildirdiği çıktı belirteci sayısını
   da yazar (içeriksiz). "Model belirteç üretti ama ağ geçidi metin/araç çağrısı teslim etmedi" (ayrıştırıcı
   kaybı) ile "model hemen durdu" ayrımı VM'de yapılabilir.

7. **İnsan dilinde sayım**: Görev listesinin kesin sayısı, süzgeçlerin hepsi doğal cümleyle söylenebiliyorsa
   "Eşleşen N görev bulundu (ölçüt: …)" yerine "Şu anda **1** gecikmiş göreviniz var." biçiminde yazılır (doğrulanmış
   anlatımda da, sunucu/model düzeninde de). Termin penceresi sayıdan önce gelir ("Bugün dahil yedi gün içinde terminli
   **17** açık görev var."). Atama dağılımı tamlığı "Etiket: **Evet**" yerine cümledir.
8. **Yinelemesiz anlatım**: Aynı kanıtın aynı toplu ölçüsü ayrıntılarda bir kez yazılır; kapsama cümlesi ("9 projenin
   8'inde") aynı değeri taşıyan toplamı değer eşitliği doğrulanarak yinelemez; yanıtın bütün kanıtı tek özneye
   aitse analist cümlelerine aynı "**X**:" etiketi yazılmaz; paragraf içinde aynı öznenin cümleleri art arda gelir.
9. **Karşılaştırma sayfası**: Dört bölüm × iki özne sayfaya sığar (ayrıntı sınırı 8); karşılaştırmada tek öznenin
   gösterge kartı sunulmaz; gelecek dönemli proje gruplarında yapısal olarak sıfır olan gecikmiş sütunu okunmaz.
10. **Yapısal plan çözümü**: Modelin JSON metni olarak yazdığı grafik dizisi (`"[\"donut\", \"stacked\"]"`) iç içe
    alanlardaki kuralla çözülür; tür denetimi aynen uygulanır.

11. **Yapılandırılmış yanıt**: Analitik özet *giriş → bölümler → öncelikler* düzenindedir. Üç ya da daha çok bölümlü
    özet Dengeli ayrıntıda da bölüm başlığı alır; model başlık seçmese ya da bölümleri iç içe dizse de sunucu blokları
    bölümlerine toplar (bölüm sırası ilk görünüş, bölüm içi sıra modelin) ve başlığı ekler. Sonuç, "**Öncelikli konular**"
    başlıklı numaralı listedir ("konu — gerekçe"); her madde kendi kaynağını taşır.
12. **Doğal karşılaştırma ve sınır cümleleri**: "(**2** / **3**)" yerine "**A** projesinde **4**, **B** projesinde **6** açık görev
    var"; liderlik "**X**, **12** açık ve **5** gecikmiş görevle projeler arasında ilk sırada"; kesik listenin alt sınırı ayrı bir
    açıklama cümlesidir; sıfır bölümler "hiçbiri … değil" ile söylenir; tarih süzgeci "Termin: X – Y" tek aralıktır; doğal sayım
    cümlesi süzgeci söylediyse tablonun ölçüt satırı ve satırdaki ölçüt parantezi yazılmaz (satırın projesi korunur).

13. **Her analitik yanıtın çerçevesi**: Bölümler arası bulgu girişi kurulamazsa yanıt olgu taşımayan bir çerçeve cümlesiyle
    açılır ("Aşağıda ekibinizin işleri iş yükü, gecikmeler ve yaklaşan teslimatlar açısından özetleniyor."; iki özne adıyla değil
    sayısıyla anılır). Kanıtlı öncelik yoksa yanıt, ele alınan yönlere uygun ve Bilgin'in yanıtlayabileceği bir sonraki adım
    önerisiyle kapanır; tek kanıtlı öncelik "**Öne çıkan konu:**" satırıdır. Kısa ayrıntıda da çerçeve vardır (başlıksız; tek
    öncelik). Tablo kendi bölümünde cümlesiz kalmaz. Kişi karşılaştırmasında "daha fazla" yargısı yazılmaz (ilişki ≠ suçlama).
14. **Metin kalite kapısı**: `test/ai-answer-quality-gate.test.mjs` (ölçüler `test/helpers/answerQuality.mjs`) kıyas kümesinin
    altın planlı her sorusunu Kısa, Dengeli ve Ayrıntılı ayrıntıda ve planlayıcı kıyasının çok istekli türlü örneklerini üretim
    yolundan geçirir, yalnızca metni ölçer. Eşikler: çok bölümlü analitik özette açılış ve kapanış %100, cümlesiz tablo 0; çok
    bölümlü türlü yanıtta açılış %100; her yanıtta mekanik kalıp ve yinelenen cümle 0; etiketli ölçüt satırı ortalaması Kısa
    ≤ 0,5, Dengeli/Ayrıntılı ≤ 0,3. Tablo üstü ölçüt, süzgeçler doğal söylenebiliyorsa "_Ekibinize atanmış açık işler_" biçimindedir.

Bileşik risk puanı **yoktur**: "yönetim dikkati gerekir" yargısı yalnızca adı verilen göstergelerle açıklanır.

### F.6 Veri gereksinimleri ve kısıtları

Mevcut görev olguları (durum, termin, gerçekleşen bitiş, öncelik, proje, sorumlu), portföy, iş yükü ve grup
toplamları yeterlidir. Yeni tablo ya da SQL yoktur. Ekip kadrosu (sıfır işli üyeler) iş yükü okumasından
bilinmez: denge/yoğunlaşma yargısı için tamlık önkoşulu korunur.

### F.7 Yetki ve kanıt gereksinimleri

Bulgular yalnızca aynı turun doğrulanmış, atfı yapılan kanıtından türetilir; kanıt dışı sayı yoktur; son yetki
denetimi değişmez; bulgu cümlelerinin atıfları turun doğrulanmış atıf kümesinin alt kümesidir. Kişi düzeyi
bulgular işlemsel dildedir; kişi hakkında yetkinlik/performans yargısı üretilmez.

### F.8 Model ve sunucu sorumlulukları

Model: niyet planı ve gövde anlatımının sırası. Sunucu: okuma açılımı, bulgu önkoşulları, aritmetik, giriş ve
sonuç cümleleri, atıflar.

### F.9 Arayüz

Yeni bileşen gerekmez; giriş ve sonuç mevcut güvenli Markdown çizicisinde paragraf olarak görünür. Dar ekranda
tablo/grafik taşmaları görsel kabulde denetlenir; kusur bulunursa mevcut stil altyapısıyla düzeltilir.

### F.10 Başarım ve sınırlı iş

Bulgu motoru O(olgu) ve tur başına bir kez çalışır; ek SQL ya da model çağrısı yoktur. Okuma üst sınırı
(4 bölüm, tur başına 5 / toplam 12 çağrı) değişmez.

### F.11 Sınamalar

Belirlenimci: bulgu önkoşulları (tam/kesik/eksik nüfus), uydurma sayı olmaması, gelecek pencere kuralı, dört yön
toleransı, iki grafik türü, sentetik 40 soruluk regresyon tanımının sunucu kabulü, mevcut bütün AI sınamaları.
Gerçek model: Haiku 4.5 ile 40 özgün + ≥20 zor ayrık soru; planlayıcı davranışı değiştiği için kanonik kapı.

### F.12 Görsel kabul

Kısa olgusal yanıt, uzun yönetici analizi, çok projeli karşılaştırma, proje yöneticisi derin analizi, tablo
ağırlıklı ve çok grafikli yanıt, eksik veri, kısmi yetki, güvenli hata, takip sorusu, uzun Türkçe adlar;
masaüstü ve mobil; açık ve koyu tema.

### F.13 Kabul kapıları

1. 40 özgün senaryonun **her biri** değerlendirilir ve şu sınıflardan birine konur: doğru yanıt · gerekçeli
   sınırlarla doğru kısmi yanıt · gerçek veri/yetenek sınırı (aşama bağımlılığıyla) · çözülmemiş kusur.
   Gerekçesiz başarısızlık geçiş sayılmaz.
2. F ile desteklenen sorularda: tam doğru işleme, uygun görselleştirme ve doğal düzyazı (Haiku nitelendirmesi).
3. Mevcut kapılar: `npm test`, `npm run lint`, `npm run build`; kanonik 117/117 ve ek 19/19 (planlayıcı
   davranışı değiştiyse); mevcut düzen kapıları; bütün yetki değişmezleri.
4. Görsel kabul kanıtı (gerçek ekran görüntüleri incelendi).
5. Windows VM kabulü (§11) — ayrı kayıt; F'nin **TAMAMLANDI** olması için gerekir.

### F.14 Önceki aşamalara bağımlılık

Aşama 4E (analitik özet, önermeler, düzen) ve PR #114 (geçmiş konuşma kanıtı).

### F.15 Riskler ve geri alma

- *Risk*: giriş ve sonuç cümlelerinin gövdeyi yinelemesi. *Önlem*: giriş sayı vermez, yalnızca bölümler arası ilişkiyi
  söyler; sonuç, söylem belleğiyle daha önce söylenen sayıyı kısaltır; aynı kanıtın aynı toplu ölçüsü ayrıntılarda bir kez yazılır.
- *Risk*: dört bölümlü özetin okuma süresini ve sayfa boyunu büyütmesi. *Önlem*: fiziksel bölüm sınırı 4, sayfa ayrıntı
  sınırı 8 (4 bölüm × 2 özne); tur bütçesi yalnızca analitik özette bölüm sayısıyla genişler.
- *Risk*: doğal sayım cümlesinin süzgeci eksik söylemesi. *Önlem*: doğal cümle yalnızca nüfusun BÜTÜN süzgeçlerini
  ifade edebildiğinde kurulur; edemezse ölçütlü cümle kalır.
- *Geri alma*: veri, şema, SQL ve yetki değişikliği yoktur; değişiklikler sunum ve plan genişletme katmanındadır. Sorun
  durumunda tek commit geri alınır (`git revert`); ayrı bir işletim anahtarı gerekmez.

### F.16 Çıktılar

Yol haritası (bu belge), kabul matrisi, sentetik kıyas kümeleri, bulgu motoru, giriş/sonuç anlatımı, planlama
düzeltmeleri, sınamalar, Haiku ve görsel kabul kanıtı, VM yeniden oynatma yordamı.

### F.17 Durum

**İLK DİKEY DİLİM UYGULANDI; KABUL SÜRÜYOR.** Belirlenimci kapılar geçti; Haiku ve görsel kabul kanıtı toplandı; Windows
VM yeniden oynatması (§11) ve anlamsal danışmanlıklı kanonik kapı bekliyor. Ayrıntı §13'tedir.

### F.18 Kaynaklar

Bu oturumun PR'ı ve commit'i §13'te kaydedilir.

---

## 6. AŞAMA G — Yönetici ve proje zekâsı

**Durum: PLANLANDI.**

1. **Amaç:** Yetkili kurumsal düzeylerde (birim, bölüm, direktörlük; doğrulanmış yetkiyle daha geniş) yönetici
   özeti; istisna ve dikkat analizi; proje sağlığı ve kilometre taşı değerlendirmesi; projeler arası çok ölçülü
   karşılaştırma ve önceliklendirme; iş yükü yoğunlaşması; doğrulanmış tamamlanma/ilerleme analizi; karar
   gerektiren konular; doğru erişim kısıtlarıyla kurumsal düzey karşılaştırmaları.
2. **Yeniden kullanım:** F bulgu motoru; `rota_portfolio_summary`, `rota_workload_summary`, `rota_task_analytics`,
   `rota_wbs_inspect`, `rota_baseline_compare`, `rota_dependency_inspect`; `MR_V_ExecutiveScope` düzeyleri
   (`teamLevel`).
3. **Eksik ve bağımlılık:** Tek soruda birden çok kapsam (kendi / ekip / bölüm — Q19) için sınırlı **çok kapsamlı
   plan** (her bölüm kendi kapsamı ve yetkisiyle; bölümler arası sentez yalnızca açıkça karşılaştırılabilir
   nüfuslar arasında). Kilometre taşı sağlığı ve baz plan kayması bulguları. Kurumsal düzey kırılımı
   (birim/bölüm başına toplam) için mevcut görünürlük kurallarını kullanan **salt okunur** okuma; gerekirse tek,
   belgeli yeni araç ya da var olan aracın yeni gruplaması.
4. **Kapsam içi:** yukarıdakiler. **Kapsam dışı:** tarihsel karşılaştırma (H), rapor üretimi (I), kapasite
   planlaması (kapasite verisi yok).
5. **İşleçler:** çok kapsamlı plan; düzey kırılımı; kilometre taşı ve baz plan bulguları; çok ölçülü sıralama
   (yalnızca adı verilen göstergelerle, bileşik puan yok).
6. **Veri:** Gerçek kapasite verisi yoktur: kayıtlı iş yükü fiili kullanımdan açıkça ayrılır. Açık görev
   listesinde görünmemek boşta olmanın kanıtı değildir.
7. **Yetki:** Sektör düzeyi destek yalnızca doğrulanmış, yetkili sektör çapında yetkiye dayanır; kimlik alanında
   sektör adı bulunması yetki değildir. Kısmi kapsam kısmi kalır; gizli görev sayısı sızmaz.
8. **Sorumluluklar:** Model kapsamı ister, sunucu yetkilendirir; düzeyler yalnızca sunucu bağlamındandır.
9. **Arayüz:** Bölümlü yönetici yanıtı (düzey başlıkları); karşılaştırmalı grafikler.
10. **Başarım:** Düzey kırılımı sınırlı tek okuma; bölüm sayısı üst sınırı korunur.
11. **Sınamalar:** düzey yetkisi (yönetici olmayan, kısmi yönetici, admin), sektör alanı ≠ yetki, çok kapsamlı
    planda sızıntı yok; Haiku ile G soruları.
12. **Görsel kabul:** yönetici özeti, düzey karşılaştırması, proje sağlığı.
13. **Kabul kapıları:** F kapıları + yetki red ekipleri (sektör/düzey) + G kıyas soruları.
14. **Bağımlılık:** F.
15. **Riskler/geri alma:** yanlış düzey yetkisi en büyük risk → yetki sınamaları kapıdır; PR düzeyinde geri alma.
16. **Çıktılar:** çok kapsamlı plan, düzey kırılımı, proje sağlığı bulguları, belgeler, sınamalar.
17. **Durum:** PLANLANDI. 18. **Kaynaklar:** —

---

## 7. AŞAMA H — Dönemsel, tarihsel ve not farkındalıklı zekâ

**Durum: PLANLANDI.**

1. **Amaç:** Bu hafta/geçen hafta ve seçilen tarih etkinliği; haftalık ve aylık karşılaştırmalar; tamamlanan
   işler ve önemli değişiklikler; gerçekten yeniden kurulabilen tarihsel eğilimler (ör. gerçekleşen bitiş
   tarihine göre tamamlanma dizisi — Q27); yetkili görev notları ve teknik açıklamalarda bildirilen engel,
   karar ve bağımlılıklar; tematik bulgular; metin belirsizliği ve köken.
2. **Yeniden kullanım:** `rota_activity_search` (tek kaynak `MR_AuditLog`), Görev Hareketleri raporu
   (`src/server/reports/taskActivityReport.js`), korunan metin rızası ("Notlar ve iletiler"), `rota_task_detail`
   açıklaması, talep/karar iletileri.
3. **Eksik ve bağımlılık:** dönemler arası karşılaştırma işleci (iki ayrı pencere, aynı nüfus tanımı — Q7);
   çoklu ufuk (7/14/30 — Q30); tamamlanma dizisi işleci; geçmiş verinin tamlık ölçüsü (ör. gerçekleşen bitişi
   olmayan tamamlanmış görev sayısı, denetim kaydının başlangıcı); güncel kurumsal üyelik ile tarihsel üyelik
   ayrımı.
4. **Kapsam içi:** yukarıdakiler. **Kapsam dışı:** tarihsel anlık görüntü **üretmek**; model tahminiyle eksik
   geçmişi doldurmak.
5. **İşleçler:** dönem karşılaştırması; tamamlanma dizisi; etkinlik özeti; not temaları (yalnızca rızayla,
   yalnızca yetkili metin, alıntı kökeniyle).
6. **Veri:** Tarihsel anlık görüntü yoktur. Bir dönemde **gözlenen olay** ile o dönem boyunca **geçerli olan
   durum** ayrılır. Görevin bugünkü durumu geçmiş durumu değildir.
7. **Yetki ve kanıt:** Silinmiş/taşınmış görevlerde Görev Hareketleri gizlilik sınırı; metin kanıtı alıntı ve
   kaynakla; not içeriği istem enjeksiyonuna karşı veridir.
8. **Sorumluluklar:** Model temayı ve vurguyu seçer; sunucu olay sayımını, dönem sınırlarını, tamlığı belirler.
   Notlardan çıkarılan tema bir **bildirim**dir, kanıtlanmış neden değildir.
9. **Arayüz:** dönem karşılaştırma grafikleri (çizgi/yığılmış), "veri yetersiz" açıklamaları.
10. **Başarım:** hareket okuması mevcut 20 000 + 1 sınırı; metin seçimi sınırlı.
11. **Sınamalar:** eksik geçmiş, çelişen notlar, yetkisiz not, enjeksiyonlu not, dönem sınırları (İstanbul günü).
12. **Görsel kabul:** dönem karşılaştırması, eğilim çizgisi, "yetersiz geçmiş" bildirimi.
13. **Kabul kapıları:** F/G kapıları + H kıyas soruları + metin güvenliği red ekibi.
14. **Bağımlılık:** F (bulgu motoru), G (kapsamlar).
15. **Riskler/geri alma:** sahte tarihsel kesinlik en büyük risk → tamlık ölçüsü zorunlu; PR geri alma.
16. **Çıktılar:** dönem/eğilim işleçleri, not temaları, tamlık ölçüleri, belgeler, sınamalar.
17. **Durum:** PLANLANDI. 18. **Kaynaklar:** —

---

## 8. AŞAMA I — Profesyonel yönetim raporu üretimi

**Durum: PLANLANDI.**

1. **Amaç:** "Haftalık Faaliyet Raporu", aylık ve keyfî başlangıç/bitiş tarihli raporlar; kişi, proje, ekip, birim,
   bölüm, direktörlük ve diğer yetkili kapsamlar; düzenlenebilir profesyonel Microsoft Word **DOCX**; yönetici
   özeti, başarılar, proje durumu, risk analizi, sonraki dönem öncelikleri ve sonuç; iyi tasarlanmış grafik ve
   tablolar, uygun ekler; önizleme; kullanıcı düzenlemesi ve sonlandırma.
2. **Yeniden kullanım:** F–H analizi ve bulgu motoru **aynen** kullanılır; ikinci, tutarsız bir analiz sistemi
   kurulmaz. Grafik dilbilgisi ve sunucu cümleleri.
3. **Eksik ve bağımlılık:** DOCX üretimi (bağımlılık seçimi ayrıca gerekçelendirilir; sunucu tarafı, ağ
   erişimsiz); rapor şablonu; önizleme; gerekirse rapor yazımı için yapılandırılmış daha güçlü model profili
   (gerekçeyle, model kaydı üzerinden).
4. **Kapsam:** varsayılan yaklaşık 2–3 okunabilir sayfa + isteğe bağlı ekler. **Kapsam dışı:** arka plan işi ve
   e-posta (J).
5. **İşleçler:** rapor bölümü = bulgu kümesi + anlatım; aynı kanıt ve atıf sözleşmesi.
6. **Veri:** H'nin dönem ve tamlık ölçüleri.
7. **Yetki:** rapor üretim anındaki yetki; indirme anında yeniden doğrulama (J ile).
8. **Sorumluluklar:** model anlatım seçer; sayı, tablo ve grafik sunucunundur.
9. **Arayüz:** rapor isteği, önizleme, düzenleme, sonlandırma.
10. **Başarım:** rapor üretimi sınırlı bölüm ve çağrı bütçesiyle.
11. **Sınamalar:** DOCX yapısı, Türkçe karakter, grafik/tablo tutarlılığı, yetki değişimi.
12. **Görsel kabul:** Word'de açılış, sayfa düzeni, grafik okunabilirliği.
13. **Kabul kapıları:** F–H kapıları + rapor kıyas kümesi.
14. **Bağımlılık:** F, G, H.
15. **Riskler/geri alma:** bağımlılık güvenliği; özellik bayrağı ile kapatma.
16. **Çıktılar:** rapor motoru, şablon, önizleme, belgeler, sınamalar.
17. **Durum:** PLANLANDI. 18. **Kaynaklar:** —

---

## 9. AŞAMA J — Kalıcı arka plan raporlama ve teslim

**Durum: PLANLANDI.**

1. **Amaç:** uzun süren rapor üretim işleri; kalıcı iş durumu ve sınırlı yürütme; çalışan kiraları, iptal,
   yeniden deneme ve yeniden başlatmada kurtarma; kullanıcı başına yalıtım; rapor saklama, saklama süresi ve
   silme; indirme anında yetki yeniden doğrulaması; açık **kendine e-posta** teslimi; mevcut kurumsal SMTP
   (`src/server/mail/*`); güvenli DOCX eki ya da yetkili indirme bağlantısı; Cuma varsayılanları ve isteğe bağlı
   kullanıcı denetimli zamanlamalar.
2. **Yeniden kullanım:** mevcut kira/revizyon desenli çalışanlar (hatırlatma ve Outlook çalışanları), SMTP
   istemcisi, gözlemlenebilirlik.
3. **Eksik:** rapor işi tablosu (yeni geçiş), çalışan, saklama politikası.
4. **Kapsam dışı:** raporun kullanıcının amirine **otomatik iletilmesi** (yasak); kullanıcı incelemeden
   sonlandırma.
5–8. Rapor kullanıcı inceleyip sonlandırana dek **taslaktır**. Sınırsız ya da geçici arka plan süreci eklenmez.
9. **Arayüz:** iş durumu, iptal, indirme, e-posta seçeneği.
10. **Başarım:** eşzamanlılık ve kullanıcı başına kota.
11–13. Sınamalar ve kapılar: yeniden başlatma kurtarması, kira kaybı, yetki kaybından sonra indirme reddi,
   e-posta yalnızca kendine.
14. **Bağımlılık:** I. 15. **Risk:** veri saklama ve e-posta sızıntısı → kapı sınamaları.
16. **Çıktılar:** iş altyapısı, teslim, belgeler. 17. **Durum:** PLANLANDI. 18. **Kaynaklar:** —

---

## 10. AŞAMA K — Endüstriyel nitelendirme ve işletim mükemmeliyeti

**Durum: PLANLANDI.**

1. **Amaç:** genişletilmiş analitik kabul ölçütleri; tutarlı yüksek kaliteli Türkçe düzyazı; gerçek model
   nitelendirmesi (kurum içi Qwen/Gemma dâhil); güvenlik ve kanıt red ekibi değerlendirmesi; başarım,
   eşzamanlılık ve kaynak profilleme; görsel regresyon ve erişilebilirlik; uzun dönem güvenilirlik ölçüleri;
   maliyet ve belirteç verimliliği; işletim tanıları; üretime hazırlık ve geri alma.
2. **Yeniden kullanım:** bütün nitelendirme betikleri, arayüz kabulü, Sistem Yönetimi telemetrisi.
3–16. Her önceki aşamanın kapıları sistem düzeyinde birleştirilir; Aşama K temel güvenceleri ertelemez.
17. **Durum:** PLANLANDI. 18. **Kaynaklar:** —

---

## 11. Windows VM yeniden oynatma yordamı (F-K8 ve F kabulü)

Gerçek Qwen/Gemma kabulü bu geliştirme ortamında yapılamaz. VM'de:

1. Bu PR'ın sürümünü dağıtın (`npm ci`, `npm run build`, `npm run start:prod`); `MERGEN_ROTA_LOG_FORMAT=json`
   açık olsun.
2. Kabul matrisindeki 40 sorunun **özel** (gerçek adlı) yazımını, sürüm denetimi dışındaki listeden **aynı sırayla**
   ve her soruyu **yeni konuşmada** sorun; yanıt gelmeden sonrakini göndermeyin.
3. Her soru için konsoldaki `ai.grounded.turn` satırının ilişki kimliğini (son 8 karakter) soru numarasıyla bir
   tabloya yazın. Böylece soru ↔ günlük eşlemesi görsel sıradan değil kimlikten kurulur.
4. JSON kaydında `code: AI_EMPTY_COMPLETION` arayın; `context.usage.completion` çıktı belirteci sayısıdır.
   `null` sayının bildirilmediğini gösterir, sıfır sayılmaz. `MERGEN_ROTA_LOG_FORMAT=both` kullanılırsa ayrıca
   `AI WARN empty completion` ve `out N tok` özet satırı görülebilir.
   - `completion: 0`: sağlayıcının bildirdiği çıktı belirteci yoktur; şablon, istem ve araç seçimi uyumluluğu incelenir.
   - Pozitif sayı: tek başına ayrıştırıcı kaybını kanıtlamaz. Aynı kaydın gerekçe/metin/araç göstergeleri ve
     bitiş nedeni incelenir; yalnızca boşluk ya da gerekçe çıktısı da bu durumu açıklayabilir. Araç ayrıştırıcısı
     ve akış ayarları olası nedenlerden biridir. Gerekçe içeriği günlüğe alınmaz.
5. Her yanıtı kabul matrisindeki dört sınıftan birine koyun; mekanik/doğal düzyazıyı ayrı puanlayın.
6. Sonuçları bu belgenin §13 bölümüne ve kabul matrisine tarihli kayıt olarak ekleyin. VM kabulü **bekliyor** olarak
   kalır; Haiku sonucu onun yerine geçmez.

---

## 12. Karar günlüğü

| Tarih | Karar | Gerekçe |
| --- | --- | --- |
| 2026-11-07 | Harfli aşamalar (F–K) Aşama 5'ten önce; Aşama 5/6 değişmez | Kullanıcı yönergesi; yazma işlemleri analiz olgunlaşmadan açılmaz |
| 2026-11-07 | Yeni model görünür araç eklenmez (F) | Başarısızlıklar araç eksikliğinden değil plan temsili ve sentez eksikliğinden; şema ve güvenlik yüzeyi küçük kalır |
| 2026-11-07 | Bulgu motoru sunucuda, saf ve belirlenimci | Model aritmetik otoritesi değildir; kanıt sözleşmesi korunur |
| 2026-11-07 | Giriş ve sonuç sunucu yazımıdır, modelin düzen seçimine eklenir | Doğrulayıcı gevşetilmez; model metni olgu sayılmaz |
| 2026-11-07 | Bileşik risk puanı yok | Opak ağırlıklar yerine adı verilen göstergeler |
| 2026-11-07 | Gelecek pencere gecikmiş işi daraltmaz | Tanımı gereği boş okuma kullanıcıya yanlış güvence verir |
| 2026-11-07 | Dört yön toleransı, model şeması değişmeden | Fiziksel sınır (4) korunur; önek önbelleği ve kanonik kapı istikrarı |
| 2026-11-07 | Çoklu ufuk, dönem karşılaştırması, tamamlanma eğilimi → H; üç düzeyli soru → G | Tarihsel tamlık ve çok kapsamlı yetki ayrı tasarım gerektirir |

---

## 13. Oturum devri

Bu bölüm her oturumun sonunda güncellenir. Güncel durum ve sonraki giriş noktası:
**bkz. [Bilgin Analiz Kabul Matrisi §4](BILGIN-ANALIZ-KABUL-MATRISI.md#4-gerçek-model-nitelendirmesi-haiku-45), §4b ve aşağıdaki kayıt.**

### 2026-11-07 — Aşama F ilk dikey dilim

- **Uygulandı:** bölümler arası bulgu motoru (`src/domain/ai/analyticalFindings.js`: karşılaştırma, dikkat önceliği,
  gecikme yoğunlaşması, eşzamanlı baskı, dönem baskısı, en uzun gecikme, en yakın teslim); sunucu yazımı giriş ve
  "Sonuç" paragrafı; gelecek dönemin gecikmiş işi daraltmaması; dört yön toleransı ve dört bölüm × iki özne sayfası;
  iki grafik türü (dizi ve JSON metni dizisi); onarım düzeltmeleri (`all_time` eşdeğerliği, göreli pencere çakışması,
  karşılaştırma bütçesi, özetin yanındaki ad çözümü çağrıları); boş tamamlamada çıktı belirteci tanısı; insan dilinde
  sayım cümlesi (doğrulanmış anlatımda ve düzende), termin penceresinin sayıdan önce yazılması, tek özneli yanıtta etiket
  tekrarının kalkması, paragrafta öznelere göre kararlı sıra, aynı kanıtın ölçüsünün ve eşit değerli kapsama toplamının
  bir kez yazılması, karşılaştırmada tek öznenin gösterge kartının sunulmaması, gelecek dönemde sıfır gecikmiş sütununun
  okunmaması; sentetik kıyas kümesi (40 + 24) ve kabul matrisi; puanlayıcı bütünlük sınırının `ANALYSIS_LIMITS.maxParts`
  ile hizalanması; ayrık küme puanlayıcısında serbest kapsamın puanlanmaması.
- **Doğrulandı:** `npm test` (bütün sınamalar geçti), `npm run lint` (uyarısız), `npm run build`; belirlenimci kıyas 40/40;
  Haiku sonuçları ve belirteç/önbellek kayıtları [Kabul Matrisi §4](BILGIN-ANALIZ-KABUL-MATRISI.md); planlayıcıya giden
  girdinin `main` ile bayt bayt aynı olduğu (136 vaka, sahte model komutuyla); gerçek arayüzde masaüstü/mobil ve
  açık/koyu temada kısa olgusal, yönetici özeti, proje karşılaştırması, proje yöneticisi, çoklu grafik, eksik veri,
  uzun adlar, tablo ağırlıklı ve güvenli ret senaryoları (sayfa yatay kaymıyor; tablolar kendi kabında kayıyor).
- **Açık:** Windows VM yeniden oynatması (§11; Qwen/Gemma kabulü yalnızca orada yapılabilir); anlamsal danışmanlıklı
  kanonik kapı (117/117 + 19/19) şirket içi anlamsal modelle; özet + ek liste birleşik planı (o38, G); Haiku düzen
  modelinin karşılaştırma/halka sayfası reddi (o33/o39); ayrık kümede h03, h18, h23; çok kapsamlı soru (G); dönem
  karşılaştırması, çoklu ufuk ve tarihsel eğilim (H); "14 gün" gibi ufukların modelce `next_7_days`'e indirgenmesi
  (gözlendi; tarih aralığı açıklaması G'de güçlendirilecek); yönetici özetinde farklı kanıtlardan gelen aynı toplamın
  ("**21** gecikmiş") iki kez söylenmesi (nüfus eşitliği kanıtlanmadan birleştirilmez).
- **Sonraki giriş noktası:** §11 yordamıyla VM yeniden oynatması; ardından Aşama G (F.14'teki bağımlılıklar hazır):
  birleşik plan (özet + ek liste), düzey kırılımı ve kadro tamlığı okuması.

### 2026-11-07 — Aşama F inceleme düzeltmeleri

- Kanıtların özne, proje, nüfus ve gün eşleşmesi korunur; geçmiş terminler yaklaşan teslimat sayılmaz.
  Çözülemeyen kişi etiketleri ve gizli atama varlığı hakkında çıkarım yapılmaz.
- Tarih çakışması onarımında kalan gösterim değişemez; açık tarihlerle birlikte gelen `all_time` çakışması reddedilir.
  Fiziksel bütçeye sığmayan istek yön kaybıyla onarılmaz. Aynı nüfusun skaler okumaları, bağlamalarıyla birlikte birleştirilir.
- İki grafik türü plan şeması, onarım, açıklama seçimi, kalıcı bağlam ve takip boyunca korunur. Aynı doğrulanmış aday
  iki uygun biçimde çizilebilir; Kısa ayrıntı açıkça istenen ikinci türü düşürmez. Veri eksikliği ile çizim başarısızlığı ayrıdır.
- Analitik tur hakkı ilk kabul edilen analitik planda bir kez belirlenir: en çok dört bölüm için ad çözümü + okuma; yeniden başlangıç
  harcanan turları geri vermez. Toplam çağrı, SQL, sonuç boyutu ve süre sınırları değişmez.
- Tek bölümlü analitik yanıt da çerçeveyle kapanır; kişi/proje süzgeçleri başlık ve ölçütlerde korunur. Nitelendirme;
  kapsam, kimlik, yön, ufuk, grafik türü, son bloktaki sonuç ve model düzenini ayrı ayrı denetler.
- Önceki Haiku ve görsel ölçümler tarihsel kayıttır; bu düzeltmelere yeniden koşulmuş sayılmaz. Güncel doğrulama
  sonucu (5786/5786 sınama, temiz lint, başarılı derleme) ve ortam sınırları kabul matrisinin §6 kaydındadır. Windows VM ve anlamsal danışmanlıklı kanonik kabul bekliyor.
