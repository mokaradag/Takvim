# Bilgin Aşama 4I Uygulama Yol Haritası (4I-0 – 4I-F)

Bu belge **Aşama 4I — Profesyonel Yönetici Raporu** için ayrıntılı, sürüm denetimli ve tek yetkili uygulama yol
haritasıdır. Gelecekteki her Claude Code ya da Codex oturumu, sohbet geçmişine dayanmadan bu belgeden devam
edebilmelidir. Üst program ve F–K aşamaları: [Bilgin Yönetim Analizi Yol Haritası](BILGIN-YONETIM-ANALIZI-YOL-HARITASI.md)
(§8 bu belgeye bağlanır).

| Konu | Yetkili belge / dosya |
| --- | --- |
| Mimari, sorumluluk sınırları, kanıt paketi, not zenginleştirmesi, yazım ve onarım sözleşmeleri, model rolleri, logo, geçici belgeler, Stüdyo | [Yönetici Raporu Mimarisi](BILGIN-4I-YONETICI-RAPORU-MIMARISI.md) |
| Kıyas kümesi, insan editoryal ölçütü, önceden tanımlanmış eşikler, nitelendirme protokolü | [Kıyas ve Kabul Çerçevesi](BILGIN-4I-KIYAS-VE-KABUL-CERCEVESI.md) |
| Kurumsal stil (makinece okunur tek kaynak) | [`config/ai/bilgin_rapor_stili.yaml`](../config/ai/bilgin_rapor_stili.yaml) |
| Kanonik düzenlenebilir Word şablonu | [`config/ai/bilgin_kurumsal_rapor_sablonu.docx`](../config/ai/bilgin_kurumsal_rapor_sablonu.docx) |
| Sentetik kıyas fikstürü | [`test/fixtures/bilgin-executive-report-benchmark.json`](../test/fixtures/bilgin-executive-report-benchmark.json) |
| Model kaydı | [`config/ai-model-registry.onprem.json`](../config/ai-model-registry.onprem.json), [Yapay Zekâ Platformu §5](YAPAY-ZEKA-PLATFORMU.md) |

Oturum kuralları, durum sözlüğü (PLANLANDI · SÜRÜYOR · ENGELLİ · DOĞRULANDI · TAMAMLANDI) ve kanıt düzeylerinin
ayrımı üst yol haritasının §0'ıyla aynıdır. Kabul koşulları gerçekten karşılanmadan hiçbir artım **TAMAMLANDI**
yapılmaz.

---

## 0. Değişmez ürün ilkeleri

> **Olgusal doğruluk yazımı sınırlar; yazımın yerine geçmez.**

1. **Bilgin yetkin bir yönetici analisti gibi yazar.** Rapor; yapılan işi, ulaşılanı, önemli gelişmeleri, engel ve
   belirsizlikleri, aralarındaki ilişkiyi, yönetim dikkati gerektiren konuları ve sonraki dönem önceliklerini
   bağlantılı Türkçe düzyazıyla anlatır. Aşama 4I **veritabanından Word'e mekanik bir döküm aracı değildir.**
2. **Düzyazıyı dil modeli yazar.** Olgular, hesaplar, yetki, tablolar, grafikler ve belge biçimi sunucunundur.
   Sohbetin kapalı yuva sözleşmesi (`groundedProse.js`) rapor için kullanılmaz ve değiştirilmez.
3. **Doğrulama orantılı ve yereldir.** Tek bir desteklenmeyen ifade bütün raporu düşürmez; ifade yerinde onarılır,
   nitelenir ya da çıkarılır. Güvenlik ihlali, yetkisiz açıklama ve çözülemeyen kritik olgu hatası kesin kapıdır.
4. **Görev notları birinci sınıf kanıttır;** kanıtın ötesine geçmeden profesyonel dile çevrilir.
5. **Kurumsal tutarlılık aynı biçimdir, aynı cümleler değil.**
6. **Yetki ve gizlilik pazarlık edilemez;** mevcut F–H güvenlik sözleşmeleri aynen geçerlidir.
7. **Düzyazı kalitesi sınamaları geçirmek için feda edilmez; olgusal doğruluk ve güvenlik akıcılık için feda
   edilmez.**

---

## 1. Başlangıç durumu (21 Kasım 2026)

- PR #120 (Aşama H) `main`'e birleştirildi (21.11.2026 05:34 UTC). Taban: `166deb7bef9eaa24dcd40a87777e61cdcf1f66e7`
  (birleştirme commit'i, `origin/main` ile aynı). Çalışma dalı `claude/bilgin-phase-4i-foundation-ktjgpf`.
- Aşama H **SÜRÜYOR** (Windows VM yeniden oynatması ve Aşama G canlı kapıları bekliyor); 4I-0 bunları yeniden
  açmaz.
- Rapor üretimine ilişkin çalışma zamanı kodu yoktur. Var olan ve 4I'nin yeniden kullanacağı altyapı:
  analitik özet ve bulgu motoru (`analysisPlan.js`, `analyticalFindings.js`, `temporalWindow.js`,
  `temporalFindings.js`), 19 salt okunur Rota aracı ve sabit SQL (`src/server/ai/tools/rota/*`), korunan metin
  rızası, Görev Hareketleri (`MR_AuditLog`), ağ geçidi ve model kaydı (`aiGateway.js`, `aiModelRegistry.js`),
  kurum logosu işleyicisi (`src/server/branding/companyLogo.js`), uygulama yedigeni (`src/components/ui.jsx`).

**Referans girdileri.** İncelenen: kurumsal kapak örnekleri, uygulama yedigeni SVG'si (`Yedigen.txt`; yolları
`ui.jsx` `HEPT_PATHS` ile aynı), üç onaylı kapak tasarımı, kurumsal tipografi kılavuzu, ana lacivert ve yardımcı
turuncu tanımları, iki model kataloğu görüntüsü ve iki referans belge (`Bilgin_4I_Kurumsal_Rapor_Sablonu.docx`,
`Bilgin_4I_Insan_Dili_Rapor_Ornegi.docx`). Bu oturumda **erişilemeyen**: önceki `bilgin_rapor_stili.yaml`,
`Bilgin_4I_Uygulama_Sozlesmesi.md`, `Bilgin_4I_Kurumsal_Rapor_Referanslari_v2.zip`; içerikleri incelenmiş gibi
gösterilmez. Kurumsal kimlik içeren görüntüler depoya konmaz (sürüm denetimi dışında tutulur).

| Referans görüntüsü | Belirlediği |
| --- | --- |
| 59593 | Ana lacivert `#003087` (CMYK/RGB/Pantone/RAL) ve ton adımları |
| 59594 | Yardımcı turuncu `#FF5620` ve ton adımları |
| 59595 | Turuncu lacivertle ve en çok 1/4 oranında; destek renkleri `#077780`, `#FF8022`, `#EBEBEE`; `#002D7A` yazım tutarsızlığı |
| 59596 | Nexa, Calibri, Segoe UI ve Trebuchet kullanım alanları |
| 59597 | Üç onaylı kapak tasarımı (lacivert ya da beyaz zemin, yedigen geometrisi, sınırlı turuncu çizgi) |
| 59598 | Uygulama yedigeni SVG yolları (beş yol: üç camgöbeği, iki turuncu) |
| 59606, 59607 | Kurum içi model kataloğu (üst ve alt bölüm; örtüşen satırlarla) |

---

## 2. Sıra ve kapılar

```
4I-0  Mimari, sözleşmeler, model kaydı, kabul temeli           ← bu artım
  │
4I-A  Yönetici kanıt zekâsı (yetkili kanıt paketi, zengin notlar)
  │
4I-B  İnsan kalitesinde anlatı üretimi        ◆ belirleyici kalite kapısı
  │
4I-C  Orantılı doğrulama ve yerel onarım      ◆ belirleyici kalite kapısı
  │
4I-D  Profesyonel kurumsal DOCX üretimi
  │
4I-E  Yönetici Rapor Stüdyosu
  │
4I-F  İsteğe bağlı geçici belge zenginleştirme
  ┆
4J    Kalıcı arka plan raporlama ve teslim (bu yol haritasının dışında)
```

**4I-B ve 4I-C belirleyici kalite kapılarıdır.** 4I-B'de çıktı hâlâ veritabanı dökümü gibi okunuyorsa artım,
olgusal doğruluktan bağımsız olarak başarısızdır; 4I-C'de hem olgusal bütünlük hem anlatı kalitesi doğrulamadan
sağ çıkmalıdır. Sonraki artım, öncekinin kapıları geçmeden başlamaz (4I-D'nin şablon doldurma iskeleti, sentetik
taslaklarla 4I-C'ye paralel denenebilir ama kabulü 4I-C'ye bağlıdır).

---

## 4I-0 — Mimari, sözleşmeler, model kaydı ve kabul temeli

1. **Amaç ve kullanıcı değeri** — 4I-A…4I-F'nin mimari kararlarını, editoryal standartlarını ve güvenlik
   sınırlarını oturumlar arasında kaybolmayacak biçimde depoya yazmak; rapor motoru olmadan kanonik stil,
   şablon, model kaydı ve kabul çerçevesini hazırlamak.
2. **İşlevsel kapsam** — Yol haritası (bu belge); mimari ve sözleşmeler; kanonik YAML stil belgesi; kanonik DOCX
   şablonu; model kaydının yeni katalogla uzlaştırılması; rapor model rolleri ve nitelendirme politikası; kıyas
   çerçevesi, sentetik fikstür ve insan ölçütü; belirlenimci sınamalar; üst yol haritası ve platform belgesi
   güncellemeleri.
3. **Yeniden kullanılan altyapı** — Model kaydı doğrulayıcısı (`validateModelRegistry`), mevcut sınama altyapısı
   (`node --test`, `jsdom`), uygulama yedigeni yolları, kurum logosu ayarı.
4. **Mimari sınırlar** — Yeni uç, kalıcı tablo, arka plan işçisi, zamanlanmış görev, küresel değişebilir durum ya da
   çalışma zamanı kodu yok; sohbet profil eşlemeleri ve düzyazı sözleşmesi değişmez; tek çalışma zamanı etkili
   değişiklik iki model kimliğinin tam yazımıdır (hiçbir profil onları kullanmaz).
5. **Beklenen dosya ve bileşenler** — `docs/BILGIN-4I-UYGULAMA-YOL-HARITASI.md`,
   `docs/BILGIN-4I-YONETICI-RAPORU-MIMARISI.md`, `docs/BILGIN-4I-KIYAS-VE-KABUL-CERCEVESI.md`,
   `config/ai/bilgin_rapor_stili.yaml`, `config/ai/bilgin_kurumsal_rapor_sablonu.docx`,
   `test/fixtures/bilgin-executive-report-benchmark.json`, `test/helpers/docxPackage.mjs`,
   `test/helpers/docxXml.mjs`, `test/helpers/coverPng.mjs`,
   `test/ai-executive-report-foundation.test.mjs`, `test/ai-executive-report-benchmark.test.mjs`; güncellenen
   `config/ai-model-registry.onprem.json`, `src/server/ai/defaultModelRegistry.js`, `test/ai-model-registry.test.mjs`,
   `docs/YAPAY-ZEKA-PLATFORMU.md`, `docs/BILGIN-YONETIM-ANALIZI-YOL-HARITASI.md`; `package.json` (`js-yaml`
   geliştirme bağımlılığı olarak açıkça bildirildi; kilit dosyasında zaten aynı sürümle vardı).
6. **Gözlenebilir çıktılar** — Yapılandırma belgeleri, kanonik şablon (kapak + gövde, yer tutucularla), şablonun
   sentetik içerikle doldurulmuş görsel denetimi, uzlaştırılmış model kaydı, kıyas fikstürü, sınama sonuçları ve
   bu yol haritası.
7. **Gerekli referans görüntüleri ve varlıklar** — Bütün kurumsal tasarım görüntüleri (59593–59598) ve iki model
   kataloğu görüntüsü (59606, 59607); uygulama yedigeni.
8. **İşlevsel ve işlevsel olmayan kabul ölçütleri** — YAML ve DOCX aynı stili anlatır (belirlenimci sınama);
   şablon A4, düzenlenebilir, makrosuz, dış bağlantısız, kurum adı içermez; renkler yalnızca paletten; yazı tipi
   tema üzerinden; yer tutucular bölünmez; kapak yedigeni yetkili yollardan; rol adayları kayıtta gerekli
   yetenekle; ölçümsüz nitelendirme yok; tam paket, lint ve üretim derlemesi geçer.
9. **Güvenlik ve yetki sınamaları** — Şablon paket güvenliği; logo ucu yüzeyinin değişmediği; logo politikasının
   ağ kaynağını ve uydurmayı yasakladığı; 4I-0 sınırı (çalışma zamanı kodunda rapor sözleşmesi göndergesi ve yeni
   veritabanı geçişi yok).
10. **Doğal dil kalite gereksinimleri** — Anlatı standartları, yasaklar ve belirsizlik dili stil belgesinde;
    insan editoryal ölçütü ve mekanik döküm tanımı kabul çerçevesinde; K17 (doğru ama mekanik) vakası editoryal
    kapıdan düşecek biçimde fikstürde.
11. **Regresyon gereksinimleri** — Mevcut bütün sınamalar geçer; sohbet profilleri ve düzyazı sözleşmesi değişmez;
    açılış ekranı logo davranışı değişmez.
12. **Başarım ve kaynak** — Çalışma zamanı etkisi yok; yeni sınamalar yalnızca yerel dosya okur.
13. **Bağımlılıklar** — PR #120'nin birleştirilmiş olması (doğrulandı); F–H sözleşmeleri.
14. **Riskler ve geri alma** — Model kimliği düzeltmesi yanlışsa (canlı katalog farklıysa) kayıt JSON'u
    (`config/ai-model-registry.onprem.json`), varsayılan kayıt (`src/server/ai/defaultModelRegistry.js`), stil
    belirtimindeki rol aday listeleri ve `canli_dogrulama_bekleyen` kayıtları (`config/ai/bilgin_rapor_stili.yaml`),
    bu model kimliklerine ve yazar adaylarına başvuran mimari/platform/kabul belgeleri
    (`docs/BILGIN-4I-YONETICI-RAPORU-MIMARISI.md`, `docs/YAPAY-ZEKA-PLATFORMU.md`,
    `docs/BILGIN-4I-KIYAS-VE-KABUL-CERCEVESI.md`) ile `test/ai-model-registry.test.mjs` ve
    `test/ai-executive-report-foundation.test.mjs` içindeki **yalnızca model kimliği beklentileri** geri alınır;
    şablon, logo ve 4I-0 sınır sözleşmelerini doğrulayan `test/ai-executive-report-foundation.test.mjs` ile
    `test/helpers/docxPackage.mjs`, `test/helpers/docxXml.mjs` ve `test/helpers/coverPng.mjs` dosyaları yerinde
    kalır. Hiçbir sohbet profili bu modellere bağlı olmadığından sohbet etkilenmez.
15. **Kapsam dışı** — Rapor motoru, kanıt paketi kurucusu, yazar, doğrulayıcı, DOCX üreticisi, Stüdyo, yükleme,
    kalıcı saklama, model seçici arayüzü, canlı model nitelendirmesi.
16. **Durum ve doğrulama kanıtı** — **Durum: DOĞRULANDI** (belirlenimci kapılar ve şablonun bütün sayfalarının
    LibreOffice çiziminde görsel incelemesi bu dalda geçti; PR incelemesi, şablonun kurum içi Microsoft Word'de
    açılışı ve canlı `GET /models` doğrulaması bekliyor). Koşu sayıları §Oturum devri'ndedir.

---

## 4I-A — Yönetici kanıt zekâsı

**Durum: DOĞRULANDI.**

1. **Amaç ve kullanıcı değeri** — Rapor için dönem ve kapsamdaki anlamlı işi (tamamlanan ve süren görevler,
   hareketler, rızalı notlar) yetkili, kökenli ve tamlığı bilinen tek bir kanıt paketinde toplamak.
2. **İşlevsel kapsam** — Rapor isteği tanımı (tür, dönem, kapsam, ayrıntı, odak, notlar, karşılaştırma);
   dönem ve örgütsel kapsam çözümü; görev/proje/ölçü/hareket kanıtı; rapor düzeyi rızayla zengin not okuması
   (dönemde tamamlanan ve hareket gören görevler dâhil); `MR_AuditLog` açıklama sürümlerinden not kayıt zamanı;
   belirlenimci önceliklendirme; köken, tamlık, kırpma ve çelişki işaretleri; kararlı `E#`/`F#` kimlikleri;
   tanı önizlemesi (geliştirici/test yüzeyi, son kullanıcı arayüzü değil).
3. **Yeniden kullanılan altyapı** — Analitik özet ve bulgu motoru, `temporalWindow.js`, salt okunur araç sorguları
   ve yetki kapsamı (`toolScope.js`, `evidenceAuthorization.js`), Görev Hareketleri gizlilik kuralı, tarihsel
   doğruluk sözleşmesi, korunan metin rızası.
4. **Mimari sınırlar** — Yeni model görünür araç yok; yeni sorgular yalnızca eklenir, sohbetin sorguları ve
   `NOTE_LIMITS` değişmez; rapor kodu kendi modüllerinde (`src/domain/ai/report/*`, `src/server/ai/report/*`);
   kalıcı tablo ve uç yok (tanı önizlemesi sınama/betik düzeyinde).
5. **Beklenen dosya ve bileşenler** — `reportRequest.js` (istek doğrulama), `reportEvidence.js` (paket kurucusu),
   `reportNotes.js` (not sürümleri, öncelik, kırpma), `reportPreview.js` ve `scripts/yonetici-kanit-onizleme.mjs`
   (geliştirici/sınama tanı önizlemesi), ilgili sabit SQL eklemeleri (`rotaToolQueries.js`, `rotaToolStore.js`),
   `test/ai-executive-report-evidence.test.mjs`, `test/helpers/executiveReportBenchmarkSeed.mjs` ve sentetik SQL
   ikizi genişletmesi (`test/helpers/aiToolSql.mjs`).
6. **Gözlenebilir çıktılar** — Sentetik veride, görevlerden, notlardan ve hareketlerden seçilmiş anlamlı bilgiyi
   gösteren tanı önizlemeleri (paket JSON'u + okunur özet); R1, R4, R5, R6, R7, R8 ve S09 vakalarının paketleri.
7. **Gerekli referans görüntüleri ve varlıklar** — Gerekmez (görsel çıktı yok).
8. **İşlevsel ve işlevsel olmayan kabul ölçütleri** — Dönemde tamamlanan işin notları pakette; not kayıt zamanı
   ile olay tarihi ayrı; tamlık ve kırpma doğru; çelişkiler işaretli; paket sınırları içinde; SQL süresi bütçede.
   Özel karşılaştırma tarihleri ve eşit, tamamlanmış dönem koşulları mimari §5'e göre doğrulanır (S09).
9. **Güvenlik ve yetki sınamaları** — FULL/PARTIAL/READ, yönetim kapsamı, Sicil yalıtımı. Yetki kararları ve Sicil
   sunucuda kalır. Rıza yokken hiçbir not ya da değişiklik metni okunmaz; silinmiş/taşınmış görev ve gizli proje hareketi Görev Hareketleri kuralıyla;
   kullanıcılar arası sızıntı yok; not içi yönerge veri olarak işaretli; içerik günlüğe girmez.
10. **Doğal dil kalite gereksinimleri** — Doğrudan düzyazı yok; ama paket, 4I-B'nin doğal anlatı kurabilmesi için
    ilişkili notları, zaman sırasını ve yönetim önemini taşımalıdır (yalnızca sayılar değil).
11. **Regresyon gereksinimleri** — Aşama H sohbet notları (ileti başına rıza, 10 görev, 400 karakter) ve bütün
    F–H kıyas kümeleri değişmeden geçer.
12. **Başarım ve kaynak** — Paket en çok 120 kanıt / 120 000 karakter (öneri); mevcut SQL zaman aşımı ve satır
    sınırları; ağ geçidi ileti sınırı yükseltilmez.
13. **Bağımlılıklar** — 4I-0; F–H sözleşmeleri.
14. **Riskler ve geri alma** — Paylaşılan SQL parçalarının değişmesi (yalnızca ekleme ile önlenir); denetim kaydı
    okumasının gizlilik kuralını atlaması (aynı çapa kuralı + sınama); not hacmi (sınırlar). Geri alma: rapor
    modülleri çalışma zamanına bağlanmadığından dal geri alınır.
15. **Kapsam dışı** — Düzyazı, doğrulama, DOCX, arayüz, belge yükleme.
16. **Durum ve doğrulama kanıtı** — **Durum: DOĞRULANDI** (tüm belirlenimci istek, kanıt, not kronolojisi,
    güvenlik, yetki, kıyas ve regresyon sınamaları sentetik bellek içi SQL ikiziyle geçti; yeni HTTP ucu, kalıcı
    tablo, model görünür aracı ya da yeni bağımlılık eklenmedi; canlı SQL Server ve Windows sunucusu üzerindeki
    çalışma doğrulaması **bekliyor**). Koşu sayıları §Oturum devri'ndedir.

---

## 4I-B — İnsan kalitesinde anlatı üretimi

**Durum: SÜRÜYOR.** Mühendislik uygulaması ve belirlenimci doğrulama tamamlandı; vekil modelle canlı koşu yapıldı.
Kurum içi aday nitelendirmesi, kör insan puanlaması ve dolayısıyla `rapor_yazari_otomatik` rolünün doldurulması
**bekliyor** (kabul koşulu karşılanmadan TAMAMLANDI yapılmaz).

1. **Amaç ve kullanıcı değeri** — Kanıt paketinden, yetkin bir analistin yazacağı gibi özgün, bağlantılı ve
   bağlamlı Türkçe yönetici raporu taslağı üretmek.
2. **İşlevsel kapsam** — Rapor yazarı (`4i-yazim-1`): stil belgesinden doğrulanan sistem yönergesi (`yazar-istemi-5`),
   belirlenimci bölüm planı (bölümler, ayrıntı ve odak, sözcük bütçesi, kaldırılamaz bütünlük açıklamaları), ≤ 32 KiB
   kanıt iletileri, yapılandırılmış çıktı (bölüm → paragraf → serbest metin + iddia eki) ve kapalı şemalı ayrıştırıcı;
   sunucu yazarı; rapor profilleri (tanımlı, eşlemesiz); 48 senaryonun dondurulmuş kanıt paketi kümesi; nitelendirme,
   vekil koşu, özet, kör puanlama paketi ve anlatı önizleme araçları.
3. **Yeniden kullanılan altyapı** — Ağ geçidi `completeChat` (kimlik, kapasite, süre, iptal, profil çözümü), model
   kaydı doğrulayıcısı, 4I-A kanıt kurucusu ve sözleşmesi (`validateEvidencePackageContract`), sentetik SQL ikizi,
   OpenAI uyumlu sağlayıcı modülü (kurum içi nitelendirme), yalıtılmış komut satırı model köprüsü
   (`scripts/planner-model-adapter.mjs`, iki isteğe bağlı bayrakla).
4. **Mimari sınırlar** — Sohbet düzyazı sözleşmesi kullanılmadı ve değişmedi; yazar araç çağırmaz, SQL görmez,
   yetki kararı vermez; sunucu paragrafları yeniden kurmaz; model adı iş kodunda geçmez (sınanır); taslak başına tek
   yazım çağrısı, yeniden deneme yok; yeni uç, tablo, işçi, zamanlanmış iş, küresel durum ya da bağımlılık yok.
5. **Beklenen dosya ve bileşenler** — `src/domain/ai/report/reportSectionPlan.js`, `reportWriterPrompt.js`,
   `reportDraft.js`; `src/server/ai/report/reportWriter.js`; `src/domain/ai/aiModelRegistry.js` (`AI_REPORT_PROFILES`);
   `aiGateway.js` (`completeChat` yanıtında `reportedModels`); `config/ai/bilgin_rapor_stili.yaml` (`anlati.bolum_plani`);
   `scripts/report-writer-qualification.mjs`, `scripts/yonetici-raporu-kiyas-paketleri.mjs`,
   `scripts/yonetici-anlati-onizleme.mjs`; `test/ai-executive-report-writer.test.mjs`,
   `test/helpers/executiveReportWriterBenchmark.mjs`, `test/helpers/executiveReportWriterScenarios.mjs`,
   `test/fixtures/bilgin-executive-report-writer-packages.json`; kayıtlar `docs/kayitlar/4i-b-vekil-kosusu-2026-11-25/`.
6. **Gözlenebilir çıktılar** — Gerçek yazar hattının ürettiği değiştirilmemiş taslaklar (haftalık, aylık, başarı ve
   risk odaklı, dönem karşılaştırmalı, zengin not sentezi, çelişkili/eksik kanıt) `anlati-ornekleri.md` içinde; 48
   senaryonun ham koşu kaydı; kör puanlama paketi. DeepSeek, Qwen ve taban model taslakları **bekliyor**.
7. **Gerekli referans görüntüleri ve varlıklar** — Model kataloğu görüntüleri (aday kimlikleri); insan dili örnek
   rapor (editoryal hedef; bu oturumda erişilemedi, kabul çerçevesindeki ayar örnekleri kullanıldı).
8. **İşlevsel ve işlevsel olmayan kabul ölçütleri** — Kabul çerçevesi §5: 4I-B taslak A kapıları (rapor başına
   nesnel olgu doğruluğu ≥ %95, zorunlu olgu tamlığı %100), B eşikleri (genel ≥ 4,0; her ölçüt ≥ 3,5; mekanik döküm
   ≤ %5) ve D bütçeleri. 4I-B kabulü için `rapor_yazari_otomatik` rolünün dolması zorunludur. **Kritik kapı:** aday
   düzeyinde mekanik döküm oranı %5'i aşıyorsa artım olgusal doğruluktan bağımsız olarak başarısızdır.
9. **Güvenlik ve yetki sınamaları** — Yazara yalnızca yetkili kanıt; iç görev kimlikleri ve yürütme alanları model
   girdisinden çıkarılır; not ve belge metni plan kararını etkilemez; kapalı şema (prototip anahtarı, denetim ve çift
   yönlü metin karakterleri reddedilir); yanıt sonrası yetki yeniden doğrulanmadan içerik dönmez; iptal ve süre
   aşımında taslak dönmez; rıza ihlalli paket model çağrısından önce reddedilir; vekil koşu yalnızca özeti ve kadrosu
   doğrulanmış sentetik kümeyle çalışır, kabuk yorumlaması yoktur. İçerik günlüğe girmez.
10. **Doğal dil kalite gereksinimleri** — Stil belgesi `anlati` sistem yönergesinin tek kaynağıdır (kurallar
    yinelenmez); bölüm rolleri tekrarı önler; sözcük bütçesi kanıt yoğunluğuyla orantılıdır (seyrek kanıtta tek kısa
    paragraf, dolgu yok); tamlık yalnızca bir sınır varsa anlatılır; not kaynağı bir kez anılır; yöntem dili, sayaç
    dökümü, kayıt alanı anlatımı, kanıttan sayım ve gün aritmetiği yasaktır (gecikme süresi sunucu izdüşümünden gelir).
11. **Regresyon gereksinimleri** — Sohbet profilleri, yönergesi ve kıyas kapıları değişmedi; ağ geçidi sınırları
    yükseltilmedi; planlayıcı köprüsünün varsayılanları (4096 belirteç, düşünme kapalı, tek API çağrısı) aynen geçerli.
12. **Başarım ve kaynak** — Taslak başına 1 yazım çağrısı; çıktı isteği akıl yürütme payı içerir (profil sınırıyla
    daraltılır); ön yazar süre kapısı `rapor_yazari_otomatik` için p95 ≤ 240 sn, `rapor_yazari_yuksek_kalite` için
    ≤ 600 sn (kurum içinde ölçülecek; vekil süresi kurum içi başarımı öngörmez).
13. **Bağımlılıklar** — 4I-A; canlı model kataloğu doğrulaması; kurum içi model erişimi; iki kör insan puanlayıcı.
14. **Riskler ve geri alma** — `rapor_yazari_otomatik` için hiçbir aday A, B ve p95 ≤ 240 sn eşiklerini geçmezse
    4I-B kabulü **ENGELLİ** olur (eşik gevşetilmez). İskeletsiz istem sürümlerinde vekil modelin sözleşme dışı yanıtları
    (%4–15, tamamına yakını düşünmesiz yanıtlar) üretimde tek çağrı bütçesiyle raporun düşmesi demektir; kurum içi
    adaylarda bu oran ayrıca ölçülmeli, 4I-C onarım tasarımı bunu dikkate almalıdır. Geri alma: rapor profilleri
    eşlemesiz olduğundan çalışma zamanına etkisi yoktur; modüller ve araçlar dal geri alınarak kaldırılır.
15. **Kapsam dışı** — Onarım döngüsü ve üretim nesnel doğrulayıcısı (4I-C), DOCX (4I-D), arayüz ve uçlar (4I-E),
    gerçek belge yükleme (4I-F).
16. **Durum ve doğrulama kanıtı** — Ayrı durumlar: (1) mühendislik uygulaması **TAMAMLANDI**; (2) belirlenimci
    doğrulama **DOĞRULANDI**; (3) vekil canlı doğrulama **YAPILDI** (vekil model, nitelendirme değildir); (4) kör insan
    editoryal puanlaması **BEKLİYOR** (paket hazır); (5) kurum içi DeepSeek/Qwen/taban nitelendirmesi **BEKLİYOR**
    (`GET /models` ve kurum içi erişim yok); (6) üretim kabulü **BEKLİYOR**. Sayılar §Oturum devri'ndedir.

---

## 4I-C — Orantılı doğrulama ve yerel onarım

**Durum: SÜRÜYOR.** Mühendislik uygulaması ve belirlenimci doğrulama tamamlandı; 4I-B ve 4I-C için kurum içi aday
model nitelendirmesi, bağımsız denetçi / yeniden sıralayıcı canlı kalibrasyonu ve kör insan editoryal puanlaması
**bekliyor** (kabul koşulları karşılanmadan TAMAMLANDI yapılmaz).

1. **Amaç ve kullanıcı değeri** — Olgusal hataları, iyi yazılmış düzyazıyı yok etmeden yerinde düzeltmek.
2. **İşlevsel kapsam** — Bağlamsal nesnel olgu doğrulaması (sayı, yüzde, oran, süre, tarih/aralık, görev durumu, kesit
   sonrası değişim, tarihsiz tamamlanma gecikme yasağı, kronoloji tersinmesi, bilinmeyen-sıfır ayrımı, planlı
   Şekil/Tablo göndermeleri, zorunlu olgu/bütünlük açıklamaları, yazar iddia eki çapraz denetimi; Türkçe dilbilimsel
   normalleştirme); zorunlu bağımsız anlamsal destek denetimi (`4i-denetim-1`, bağımsız model kimlik doğrulaması veya
   eşdeğer inceleme, bütçe korumalı isteğe bağlı yeniden sıralama); paragraf/cümle düzeyinde yerel onarım
   (`4i-onarim-1`); sınırlı deneme (paragraf başına ≤ 2, anlamsal gerektirenlerde ≤ 1, rapor başına ≤ 8); belirlenimci
   son çare (çıkar/inceleme işareti); kritik hata ve insan incelemesi politikası.
3. **Yeniden kullanılan altyapı** — 4I-A kanıt paketi (`4i-kanit-1`, `E#`/`F#`), 4I-B bölüm planı/yazar izdüşümü ve
   `writeExecutiveReportDraft`, anlamsal katmanın `AI_PROFILES.RERANK` profili, `aiGateway.js`, `aiModelRegistry.js`.
4. **Mimari sınırlar** — Birebir cümle eşleşmesi aranmaz; paragraf hazır sunucu metniyle değiştirilmez; bütün rapor
   tek ifade için reddedilmez; etkilenmeyen paragraflar bayt bayt korunur; kesin kapılar onarılamazsa rapor
   yayımlanmaz ama taslak korunur; model adı iş kodunda geçmez; yeni HTTP ucu, kalıcı tablo, işçi veya bağımlılık yok.
5. **Beklenen dosya ve bileşenler** — `src/domain/ai/report/reportClaims.js` (Türkçe normalleştirme, olgu defteri,
   bağlamsal nesnel doğrulama ve belirlenimci kanıt seçici), `src/domain/ai/report/reportReview.js` (`4i-denetim-1` ve
   `4i-onarim-1` istem/ayrıştırıcı ve belirlenimci son çare), `src/server/ai/report/reportRepair.js` (bütçe, bağımsız
   kimlik denetimi, yaşam döngüsü yetki doğrulaması ve uçtan uca yürütücü), `src/domain/ai/aiModelRegistry.js`
   (`AI_REPORT_PROFILES.REVIEW = 'report.review'`, eşlemesiz), `src/server/ai/aiGateway.js` (`allowRetry` denetimi),
   `scripts/yonetici-dogrulama-onizleme.mjs`, `test/ai-executive-report-repair.test.mjs`.
6. **Gözlenebilir çıktılar** — Önce/sonra yerel onarım doğrulamaları (R2/S40, S04, S25, R8, `one_cikan_tespit`:
   yalnızca sorunlu paragraf düzeltilmiş, çevredeki düzyazı bayt bayt korunmuş); 48 senaryoluk 4I-B arşiv taslakları
   belirlenimci tarama özeti; inceleme gerektiren kritik/yetkisiz vakalar.
7. **Gerekli referans görüntüleri ve varlıklar** — Gerekmez.
8. **İşlevsel ve işlevsel olmayan kabul ölçütleri** — Kabul çerçevesi §5 onarım eşikleri (editoryal düşüş ≤ 0,3;
   tekil sorunların ≥ %90'ı yerel çözülür; hazır metne düşme 0). **Kritik kapı:** hem olgusal bütünlük hem anlatı
   kalitesi doğrulamadan sağ çıkmalıdır.
9. **Güvenlik ve yetki sınamaları** — Kapalı/uydurma varlık ve istem enjeksiyonu kesin kapısı; yetkisiz açıklama sıfır
   (yetkisiz varlık adları hata/bulgu/telemetriye yansıtılmaz); onarım isteğine yalnızca ilgili yetkili kanıt alt
   kümesi gider; denetçi ve onarım çıktıları kapalı şema + `rapor_ozeti_sha256` bağlamasıyla doğrulanır; başlangıç,
   her çağrı öncesi/sonrası ve teslim öncesi güncel `revalidate` zorunludur.
10. **Doğal dil kalite gereksinimleri** — Onarılan paragraf çevresiyle doğal biçimde bağlanır (komşu geçiş cümleleri
    salt okunur bağlam olarak verilir); nitelemeler ölçülü; çıkarma sonrası paragraf bütünlüğü korunur; editoryal dil
    ve desteklenen yorumlar aşırı katı reddedilmez.
11. **Regresyon gereksinimleri** — 4I-A/4I-B belirlenimci sınamaları ve mevcut sohbet doğrulayıcıları değişmeden
    geçer; 4I-B kalite puanlarının onarımla düşmediği canlı kurum içi koşu ve kör insan puanlamasıyla doğrulanacaktır.
12. **Başarım ve kaynak** — Rapor başına kesin tavan 11 model çağrısı (1 yazım, ≤ 8 onarım, denetim ve yeniden sıralama
    için ortak ≤ 2; yeniden sıralama zorunlu denetim payını tüketemez). Onarım isteği yalnızca ilgili paragrafı ve
    seçilen kanıt alt kümesini taşır.
13. **Bağımlılıklar** — 4I-B. Üretimde kullanım için `report.writer`, `report.writer.quality`, `report.review` ve
    yeniden sıralayıcı rolleri kurum içinde nitelendirilir.
14. **Riskler ve geri alma** — Denetçinin aşırı katılığı (yorumu reddetmesi) → eşik ve insan kalibrasyonu;
    denetçi kararının yayın kararı sayılmaması. Denetçi geri alınırsa belirlenimci nesnel denetim korunur ve
    maddi iddia desteği eşdeğer incelemeyle doğrulanır. Doğrulanamayan içerik ve kritik sorunlar için mimari §8.2
    uygulanır. Geri alma: `report.review` eşlemesiz olduğundan ve HTTP ucu bağlanmadığından dal doğrudan geri alınabilir.
15. **Kapsam dışı** — Stüdyo'daki kullanıcı düzenlemeleri ve HTTP uçları (4I-E), DOCX (4I-D), geçici belge yükleme
    (4I-F) ve kalıcı arka plan raporlama/arşiv (4J).
16. **Durum ve doğrulama kanıtı** — Ayrı durumlar: (1) mühendislik uygulaması **TAMAMLANDI**; (2) belirlenimci
    doğrulama ve 48 senaryo arşiv taraması **DOĞRULANDI**; (3) kapsayıcı bütünleştirme doğrulaması **DOĞRULANDI**;
    (4) canlı vekil/kurum içi denetçi ve yerel onarım koşusu **BEKLİYOR** (bu ortamda haricî/kurum içi canlı model
    erişimi yok); (5) kurum içi aday nitelendirmesi ve kör insan editoryal puanlaması **BEKLİYOR**; (6) üretim kabulü
    **BEKLİYOR**. Sayılar §Oturum devri'ndedir.

---

## 4I-D — Profesyonel kurumsal DOCX üretimi

**Durum: PLANLANDI.**

1. **Amaç ve kullanıcı değeri** — Doğrulanmış taslağı kanonik şablonla tamamen düzenlenebilir, kurumsal görünümlü
   bir Word belgesine çevirmek.
2. **İşlevsel kapsam** — Şablon doldurma (yer tutucular, satır şablonu çoğaltma, isteğe bağlı bölümlerin temiz
   kaldırılması); sunucu tabloları, grafikleri ve gösterge kartları; logo politikası (koyu zemin varyantı kapakta;
   beyaz zemin varyantı sağlanınca); belge özellikleri (sürüm, model, veri anı, doğrulama, logo durumu).
3. **Yeniden kullanılan altyapı** — Kanonik şablon ve stil belgesi, grafik dilbilgisi (`answerChart.js`) ilkeleri,
   `companyLogo.js` kaynak çözümü (yalnızca yol biçimi), `test/helpers/docxPackage.mjs`, `test/helpers/docxXml.mjs`,
   `test/helpers/coverPng.mjs`.
4. **Mimari sınırlar** — Ağsız, sunucu tarafı üretim; yeni logo ucu yok; yeni bağımlılık ancak gerekçeyle; model sayı
   ya da çizim üretmez; şablon ve stil belgesi aynı commit'te değişir.
5. **Beklenen dosya ve bileşenler** — `reportDocx.js` (doldurma), `reportCharts.js`, `reportAssets.js` (logo
   doğrulama/SVG temizliği), `test/ai-executive-report-docx.test.mjs`, görsel kabul betiği (LibreOffice/Word çizimi).
6. **Gözlenebilir çıktılar** — Profesyonel biçimli Word raporları; bütün sayfaların görsel doğrulaması.
7. **Gerekli referans görüntüleri ve varlıklar** — Kurumsal kapaklar, tipografi, renkler ve yedigen (59593–59598);
   resmî beyaz zemin logosu (nihai markalı kabul için; sağlanana dek onaylı boş bırakma davranışı).
8. **İşlevsel ve işlevsel olmayan kabul ölçütleri** — Word onarım istemeden açar; A4, stil adları ve özellikleri stil
   belgesiyle aynı; Türkçe karakterler; standart ayrıntıda 2–3 sayfa; okunur grafik; yetim başlık ve taşma yok.
9. **Güvenlik ve yetki sınamaları** — Makro, gömülü nesne, dış bağlantı yok; logo yalnızca izinli mutlak yoldan,
   ≤ 1 MiB, temizlenmiş SVG; yol tarayıcıya gitmez; belge içeriği günlüğe girmez.
10. **Doğal dil kalite gereksinimleri** — Doldurma metni değiştirmez; paragraf bölünmesi ve listeler korunur.
11. **Regresyon gereksinimleri** — Açılış ekranı logosu değişmez; stil ↔ şablon sınaması geçer.
12. **Başarım ve kaynak** — Belge üretimi bellek içinde, saniyeler mertebesinde; boyut sınırı.
13. **Bağımlılıklar** — 4I-C; beyaz zemin logosu (nihai kabul için).
14. **Riskler ve geri alma** — Word/LibreOffice çizim farkları (her ikisinde görsel kabul); yazı tipi ikamesi
   (tema yazı tipi denetimi); geri alma: belge üretimi bağımsız modüldür.
15. **Kapsam dışı** — Kalıcı saklama, e-posta, zamanlama (4J); PDF dışa aktarımı (gerekirse ayrıca değerlendirilir).
16. **Durum ve doğrulama kanıtı** — Henüz uygulanmadı.

---

## 4I-E — Yönetici Rapor Stüdyosu

**Durum: PLANLANDI.**

1. **Amaç ve kullanıcı değeri** — Yöneticinin geliştirici yardımı olmadan rapor oluşturması, düzeltmesi,
   sonlandırması ve indirmesi.
2. **İşlevsel kapsam** — Varsayılan görünüm (tür, dönem, kapsam, ayrıntı, Rapor Oluştur); gelişmiş panel (odak,
   bölümler, notlar, karşılaştırma, görseller, nitelikli model; belge zenginleştirme seçeneği 4I-E'de yer almaz,
   4I-F'te eklenir); ilerleme ve iptal; önizleme; bölüm düzeltme isteği; metin düzenleme; sonlandırma; DOCX indirme.
3. **Yeniden kullanılan altyapı** — Uygulama tasarım değişkenleri ve bileşenleri, kimlik/oturum, mevcut rapor
   modülü gezinmesi, ağ geçidi iptali, yetki yeniden denetimi.
4. **Mimari sınırlar** — Kalıcı saklama yok; taslak durumu bellekte süre sınırlı ya da imzalı/şifreli zarfla
   (4I-E'de gerekçelendirilir); tablo ve grafikler sonlandırmada aynı dondurulmuş sunucu kanıt paketi sürümünden
   (güncel yetki/rıza yeniden denetimiyle) üretilir; paket sürümü veya alttaki yetkili veri özeti değişmişse taslak
   geçersiz kılınıp etkilenen paragraflar 4I-C'den geçirilir; bütünlük açıklamaları kapatılamaz; teknik model ayarı
   gösterilmez.
5. **Beklenen dosya ve bileşenler** — `src/features/reports/executive/*` (arayüz), rapor uçları (`/api/mergen-rota/
   reports/executive/*`; bu artımda gerekçesiyle eklenir), `test/executive-report-studio-*.test.mjs`, arayüz kabul
   betiği.
6. **Gözlenebilir çıktılar** — Bir yöneticinin uçtan uca rapor oluşturup düzelttiği ve indirdiği ekran kayıtları;
   masaüstü/dar, açık/koyu görünümler.
7. **Gerekli referans görüntüleri ve varlıklar** — Kurumsal palet ve tasarım dili; model kataloğu (yalnızca
   nitelikli seçenekler).
8. **İşlevsel ve işlevsel olmayan kabul ölçütleri** — Varsayılan görünüm sade; gelişmiş seçenekler göze batmaz;
   kurumsal biçim seçeneklerden bağımsız; erişilebilirlik ve klavye; dar ekranda okunur; önizleme → veri değişimi →
   sonlandırma akışında metin, tablo, grafik ve kapak `VERI_ANI` tek bir tutarlı kesite bağlı kalır.
9. **Güvenlik ve yetki sınamaları** — Yetkili kapsam seçenekleri, ilk ve sonraki önizlemeler ile sonlandırma ve her
   indirme öncesi güncel yetki/rıza denetimi (K20/S48), oturumlar arası yalıtım, CSRF ve mevcut uç güvenliği;
   önizleme ile sonlandırma arasında veri değişimi sınaması.
   Elle düzenlenen metin de maddi iddia desteği ve yetki koşullarını karşılar.
10. **Doğal dil kalite gereksinimleri** — Bölüm düzeltme isteği yerel yeniden yazımdır (4I-C kurallarıyla);
    arayüz metinleri sade Türkçe.
11. **Regresyon gereksinimleri** — Mevcut Raporlar sekmeleri, sohbet ve gezinme değişmez.
12. **Başarım ve kaynak** — Kullanıcı başına eşzamanlı rapor sınırı; iptalde model ve SQL işi durur.
13. **Bağımlılıklar** — 4I-D.
14. **Riskler ve geri alma** — Taslak durumunun çok örnekli dağıtımda kaybı (tasarım kararı); özellik bayrağıyla
   kapatma.
15. **Kapsam dışı** — Zamanlanmış rapor, e-posta, kalıcı rapor arşivi (4J); belge yükleme (4I-F).
16. **Durum ve doğrulama kanıtı** — Henüz uygulanmadı.

---

## 4I-F — İsteğe bağlı geçici belge zenginleştirme

**Durum: PLANLANDI.**

1. **Amaç ve kullanıcı değeri** — Yöneticinin kayıtlarda olmayan bilgiyi yalnızca o rapor için ekleyerek anlatıyı
   zenginleştirmesi.
2. **İşlevsel kapsam** — Sırasıyla: ek bilgi metin alanı; geçici DOCX; metin tabanlı PDF; gerekçeli olduğunda
   sınırlı XLSX çıkarımı. Köken ve çelişki işleme; güvenli geçici işleme ve silme. Taranmış PDF yalnızca ayrıca
   gerekçelendirilirse.
3. **Yeniden kullanılan altyapı** — Kanıt paketi (`belge` türü), 4I-C doğrulaması, Stüdyo.
4. **Mimari sınırlar** — Kalıcı belge yönetimi, dizinleme ya da gömme saklama yok; dış hizmet yok; ayrıştırma
   yalıtılmış ve sınırlı; içerik günlüğe girmez; süre sınırlı güvenli silme.
5. **Beklenen dosya ve bileşenler** — `reportUploads.js` (tür/boyut/imza denetimi), ayrıştırıcı işçileri, temizlik
   zamanlayıcısı (istek kapsamlı; kalıcı arka plan işi değil), `test/executive-report-uploads.test.mjs`.
6. **Gözlenebilir çıktılar** — Ek belgeyle iyileşen anlatı; yüklenen içeriğin izin verilen süreden sonra kalmadığının
   doğrulanması.
7. **Gerekli referans görüntüleri ve varlıklar** — Gerekmez.
8. **İşlevsel ve işlevsel olmayan kabul ölçütleri** — Belge kanıtı kökenle anılır; çelişki açıkça işlenir; yönetici
   beyanı doğrulanmış kayıt gibi sunulmaz; sınır aşımları açık hatayla reddedilir.
9. **Güvenlik ve yetki sınamaları** — Zip bombası, sahte uzantı, makro, gömülü nesne, dış bağlantı, gizli yönerge
   (K19/S47); oturum yalıtımı; başarısız ve terk edilmiş oturum temizliği.
10. **Doğal dil kalite gereksinimleri** — Belge bilgisi anlatıya doğal katılır; kaynak türü gerektiğinde anılır.
11. **Regresyon gereksinimleri** — Belgesiz raporlar değişmez.
12. **Başarım ve kaynak** — Dosya ve işlem süresi sınırları; ayrıştırma bellek sınırı.
13. **Bağımlılıklar** — Çekirdek rapor motoru ve iş akışı kararlı (4I-E).
14. **Riskler ve geri alma** — Ayrıştırıcı güvenlik açıkları (yalıtım, sınırlar, bağımlılık incelemesi); özellik
   bayrağıyla kapatma.
15. **Kapsam dışı** — Kalıcı belge arşivi, kurum geneli arama, OCR (ayrı gerekçe olmadan).
16. **Durum ve doğrulama kanıtı** — Henüz uygulanmadı.

---

## Aşama 4J sınırı

Aşağıdakiler **Aşama 4J**'ye aittir ve 4I'ye sessizce taşınmaz:

- Kalıcı **arka plan** rapor işleri (kira, iptal, yeniden deneme, yeniden başlatmada kurtarma);
- **Kalıcı rapor saklama** ve rapor arşivi;
- **Zamanlanmış** üretim (ör. Cuma varsayılanları);
- **Otomatik teslim**;
- **Saklama ve silme** altyapısı (saklama süresi, silme işleri);
- **E-posta** teslimi ve ilgili yaşam döngüsü denetimleri (yalnızca kendine e-posta; amire otomatik iletim yasak).

4I çıktısı başlangıçta sunucuda kalıcı arşivleme olmadan indirilir.

---

## Karar günlüğü (4I)

| Tarih | Karar | Gerekçe |
| --- | --- | --- |
| 2026-11-21 | Rapor düzyazısını dil modeli yazar; sohbetin kapalı yuva sözleşmesi rapor için kullanılmaz ve değiştirilmez | Sunucu cümlelerinden kurulan rapor tanım gereği mekanik dökümdür; sohbet güvenliği korunur |
| 2026-11-21 | Doğrulama orantılı ve yereldir; kesin kapılar yalnızca güvenlik, yetkisiz açıklama ve çözülemeyen kritik olgu hatası | Tek ifade yüzünden bütün raporun düşmesi ürün değerini yok eder |
| 2026-11-21 | Stil belgesi tek doğruluk kaynağı; şablon onu yansıtır ve uyum belirlenimci sınanır | İki kaynak birbirinden sessizce ayrışmasın |
| 2026-11-21 | Etkin yazı tipi Calibri; Nexa, tüm hedef istemcilerde kurulum ya da lisanslı gömme ve hedef Word doğrulaması tamamlanınca, tema üzerinden | Denetimsiz ikame sayfa düzenini bozar |
| 2026-11-21 | Ana renk `#003087` (kılavuzdaki `#002D7A` yazımı tutarsız) | CMYK/RGB/Pantone/RAL tanımları `#003087` |
| 2026-11-21 | Kapak yedigeni uygulama `HEPT_PATHS` yollarından aynen; resmî logo taklit edilmez, eksikse alan boş | Yetkili geometri; kurumsal varlık uydurulmaz |
| 2026-11-21 | Model kimlikleri katalogdaki tam yazıma çevrildi; görünmeyen modeller silinmedi, aday sayılmadı | Kanıta dayalı uzlaştırma; profil eşlemeleri değişmez |
| 2026-11-21 | Rapor rolleri yapılandırmada; ölçümsüz nitelikli model yok | Etkin olmak nitelik değildir |
| 2026-11-21 | Eşikler deneylerden önce tanımlandı | Sonuca göre eşik ayarlanmasın |
| 2026-11-21 | `js-yaml` açık geliştirme bağımlılığı (kilit dosyasında zaten aynı sürüm) | Stil belgesinin sınamada güvenli ayrıştırılması; yeni indirme yok |
| 2026-11-25 | Rapor profilleri sohbet profil kümesinden ayrı (`AI_REPORT_PROFILES`) ve eşlemesiz | Nitelendirmesiz model rol alamaz; sohbet regresyonu yok |
| 2026-11-25 | Taslak ayrıştırıcısı kapalı şema; kazıma ve otomatik düzeltme yok | Güvenilmez çıktı; sözleşme dışı yanıt sessizce kabul edilmez |
| 2026-11-25 | Gecikme günü sunucu izdüşümünde (`veri_anina_gore_gecikme_takvim_gunu`) | Vekil koşuda model 31 kez kendi gün aritmetiğini yaptı; aritmetik sunucunundur |
| 2026-11-25 | Yazar ayrıştırılmış stili parametre alır; YAML çalışma zamanı okuması 4I-D/E'ye | Yeni bağımlılık ve uç olmadan; 4I-0 sınırı korunur |
| 2026-11-25 | R3/R5/R7 gün sonu veri anı işareti sarma katmanında eşdeğer kapanış anına eşlenir | Fikstür ve 4I-A sözleşmesi gevşetilmeden tutarlılık |
| 2026-11-28 | Bağımsız denetçi profili (`report.review`) `AI_REPORT_PROFILES` içine eşlemesiz eklendi; bağımsızlık profil adıyla değil yapılandırılan ve bildirilen model kimliğiyle sınanır | Yazarla aynı modele yönlendirilmiş denetçi bağımsız sayılamaz; nitelendirmesiz profil kapalı kalır |
| 2026-11-28 | 4I-C bütçesi sunucuda eşzamanlı ve geri alınamaz sayaçla (`1 + ≤8 + ≤2 = ≤11`) uygulanır; isteğe bağlı yeniden sıralama zorunlu anlamsal denetim payını tüketemez | Başarısız/zaman aşımı çağrıları ve paralel istekler bütçeyi aşamaz; son denetim korunur |
| 2026-11-28 | Nesnel doğrulama değer varlığıyla yetinmez; Türkçe Unicode sözcük sınırlarıyla yerel ölçü, varlık ve dönem bağlamında eşleme yapar; yetkisiz varlık adları bulgu/alıntı/hata çıktısına yansıtılmaz | Doğru sayının yanlış varlığa/döneme yazılmasını engeller; kapalı varlık sızıntısını önler |

---

## Oturum devri

### 2026-11-21 — Aşama 4I-0 temeli

Uygulandı: bu yol haritası; mimari ve sözleşmeler; kıyas ve kabul çerçevesi; kanonik stil belgesi ve şablon;
model kaydı uzlaştırması; sentetik kıyas fikstürü (48 senaryo, 8 temsili vaka); belirlenimci sınamalar.

- **İlk temel doğrulaması (2026-11-21, ilk commit `16ba2e6`, Node 22, Linux):** tam paket `npm test -- --test-concurrency=1` **6642/6642** (başarısız,
  iptal, atlanan 0); yeni sınamalar `ai-executive-report-foundation` **21/21**, `ai-executive-report-benchmark`
  **6/6**, güncellenen `ai-model-registry` **25/25**; lint uyarısız; üretim derlemesi başarılı; `npm install
  --package-lock-only` kilit dosyasını değiştirmiyor; stil belgesi `js-yaml` ve PyYAML ile aynı veriye ayrışıyor.
  Sözleşme sınamalarının etkinliği bozma denemeleriyle doğrulandı (stil boyutu, başıboş metin, palet dışı renk ve
  uydurma ölçüm yakalandı; dosyalar bayt bayt geri yüklendi). Şablon LibreOffice ile PDF'e çizildi; kapak ve bütün
  gövde sayfaları ile sentetik içerikle doldurulmuş kopya görsel olarak incelendi.
- **Güncel doğrulama (2026-11-23, kök neden yakınsama koşusu, Node 22, Linux):** tam paket `npm test -- --test-concurrency=2`
  **6653/6653** (başarısız, iptal, atlanan 0); `ai-executive-report-foundation` **26/26**, `ai-executive-report-benchmark`
  **10/10**, `ai-model-registry` **25/25**; `npm run lint` uyarısız; `npm run build` başarılı; `npm install
  --package-lock-only --ignore-scripts` kilit dosyasını değiştirmiyor; kanonik `.docx` şablonu ECMA-376 alt öğe
  sırası (`checkOoxmlElementOrder`) dâhil tüm yapısal/paket denetimlerinden geçti. Microsoft Word'de açılış ve
  canlı model kataloğu doğrulaması bu ortamda yapılamadı (**bekliyor**).
- **Bekleyen dış ön koşullar:** (1) beyaz zemin için resmî SVG logo; (2) kurum içi `GET /models` ile
  `DeepSeek-V4.1-Flash-1017`, `Qwen3.8-Flash-Next-FP8`, `Qwen3.8-27B`, `Qwen3.6-35B-A3B` kimliklerinin doğrulanması;
  (3) şablonun kurum içi Microsoft Word'de açılışı ve görsel kabulü; (4) canlı model nitelendirmesi (4I-B).
- **Sonraki giriş noktası: 4I-A** — rapor isteği tanımı ve yetkili kanıt paketi kurucusu; önce
  [mimari §5–§6](BILGIN-4I-YONETICI-RAPORU-MIMARISI.md) ve bu belgenin 4I-A bölümü okunur. 4I-A, 4I-0 sınır
  sınamasını (çalışma zamanında rapor sözleşmesi göndergesi yok) bilinçli olarak günceller.

### 2026-11-23 — Aşama 4I-A yönetici kanıt zekâsı

Uygulandı: katı yönetici raporu istek sözleşmesi (`src/domain/ai/report/reportRequest.js`), güvenli geliştirici/sınama
tanı önizlemesi (`src/domain/ai/report/reportPreview.js`, `scripts/yonetici-kanit-onizleme.mjs`), rapor düzeyi açık
rızayla çalışan zengin ve kronolojik görev notu okuyucusu (`src/server/ai/report/reportNotes.js`), yetkili yönetici
kanıt paketi kurucusu (`src/server/ai/report/reportEvidence.js`, şema `4i-kanit-1`), dar kapsamlı salt okunur
parametreli SQL eklemeleri (`src/server/ai/tools/rota/rotaToolQueries.js`, `src/server/ai/tools/rota/rotaToolStore.js`),
sentetik SQL ikizi işleyicileri ve kıyas verisi (`test/helpers/aiToolSql.mjs`,
`test/helpers/executiveReportBenchmarkSeed.mjs`) ile kapsamlı kabul/güvenlik/kronoloji/regresyon sınamaları
(`test/ai-executive-report-evidence.test.mjs`).

- **Doğrulama kanıtı (2026-11-23, Node 22, Linux, sentetik bellek içi SQL ikizi):** tam paket
  `npm test -- --test-concurrency=4` **6743/6743** (başarısız, iptal, atlanan 0); yeni
  `ai-executive-report-evidence` **29/29**, `ai-executive-report-foundation` **26/26**, `ai-executive-report-benchmark`
  **10/10**, `ai-architecture-contract` **26/26**, `ai-model-registry` **25/25**; `npm run lint` uyarısız;
  `npm run build` başarılı (yeni HTTP/API ucu, yeni model görünür aracı, yeni kalıcı tablo/göç ya da yeni bağımlılık yok).
- **Kapsam ve güvenlik özeti:** `Sicil`, `authorizationEpoch` ve proje erişim kararları `serverContext` içinde
  sunucuda kalır; toplama sonunda yetki parmak izi yeniden doğrulanır; `notlar: haric` iken güncel not ve not
  geçmişi denetim sorguları (`readReportTaskNotes`, `readReportNoteAuditHistory`) hiç çalışmaz ve hiçbir açıklama
  metni okunmaz (dönem ölçüsü ve durum geçişi için salt sayım/durum okuyan hareket ve görev-olgu denetim sorguları
  çalışmaya devam eder); `MR_AuditLog.OccurredAt` yalnızca yeni (`after`) sürüme atanır, `before` veya `MR_Tasks.UpdatedAt`
  üzerinden kayıt zamanı uydurulmaz; bilinmeyen ölçüler (`history.undatedDone`, sıfır/kısmi paydalı yüzdeler) `null`
  kalır; Aşama H sohbet not sınırları (`NOTE_LIMITS.tasks = 10`, `TASK_NOTE_CHARS = 400`) değişmeden korundu.
- **Bilinen sınırlar (canlı doğrulama bekliyor):** tüm SQL doğrulaması sentetik bellek içi ikizle yapıldı; canlı
  SQL Server (`MR_AuditLog`, `MR_Tasks`, `MR_V_ExecutiveScope`, `MR_V_PeopleDirectory`) ve Windows sunucusu üzerindeki
  çalışma doğrulaması bu ortamda yapılamadı (**bekliyor**).
- **Sonraki giriş noktası: 4I-B** — insan kalitesinde anlatı üretimi (`4i-yazim-1`), bölüm planı, yazar istemi ve
  kurum içi canlı model nitelendirmesi (canlı `GET /models` ve kurum içi model erişimi ön koşuldur).

### 2026-11-25 — Aşama 4I-B anlatı yazarı

Uygulandı: bölüm planı, yazar istemi, taslak ayrıştırıcısı, sunucu yazarı, rapor profilleri (eşlemesiz), 48 senaryonun
dondurulmuş sentetik kanıt paketi kümesi ve nitelendirme/vekil/önizleme araçları (ayrıntı: mimari §7.4, kabul çerçevesi §10).

- **Belirlenimci doğrulama (Node 22, Linux):** sayılar PR açıklamasında ve aşağıdaki son doğrulama satırındadır.
- **Vekil canlı koşu — son yapılandırma (2026-11-25, `yazar-istemi-4`, düşük eforlu küçük vekil model, yalıtılmış CLI
  köprüsü, 48 senaryo, eşzamanlılık 4):** geçerli taslak **48/48** (sözleşme dışı yanıt 0, altyapı hatası 0); yetkisiz
  açıklama **0**; uydurma kimlik/tarih **0** (tek aday, "denge" sözcüğü, hakemce yanlış pozitif); zorunlu olgu tamlığı
  **48/48** raporda %100 (2'si hakem kararıyla); değer düzeyinde defter dışı yanlış değer 0. Tarihsel hakem düzeltmeleri
  S03’te proje atfını (%93,75), S08’de desteklenmeyen gecikme bağlantısını (%94,44) ve S37’de yanlış tarih çelişkisini
  (%88,89) kayda geçirdi. Cümle düzeyinde insan doğrulaması bekliyor.
  Çelişki senaryolarının 3/4'ü (S25 kronoloji tersinmesi nedeniyle başarısız, bkz. `hakem-kararlari.json`)
  ve iki gömülü yönerge senaryosu doğru işlendi; model gün aritmetiği 0;
  standart ayrıntıda yazar süresi p95 **116 sn** (vekil; kurum içi başarımı öngörmez); ortalama 534 sözcük.
  Kayıt: `docs/kayitlar/4i-b-vekil-kosusu-2026-11-25/` (ham yanıtlar, hakem kararları, yapılandırma özetleri).
- **Ara koşular (birleştirilmedi, `ara-kosular-ozet.json`):** istem 1 → 45/48 geçerli, model 31 kez gün aritmetiği;
  istem 2 → 46/48, kör model değerlendirmesi genel 3,52 / E6 2,74 / mekanik 6/46 (B kapısı geçilemezdi; zayıf
  taslakların tamamı seyrek kanıtlı paketler); istem 3 → seyrek kanıt bütçesi ve tamlık/şerh kuralları, ama vekilin
  düşünmesiz yanıtları arttı ve 41/48; istem 4 → plandan türetilen çıktı iskeleti.
- **Editoryal (`yazar-istemi-4`):** yazardan farklı, kör bir model değerlendiricisi (insan puanı değildir): genel ortalama **3,70**
  (eşik 4,0; uygulanabilir E1–E9 ölçüt ortalamalarının ortalaması: `3,7008`), E1 3,48 · E2 3,71 · E3 3,52 · E4 3,83 · E5 4,08 · **E6 3,00** · E7 3,88 · E8 3,91 · E9 3,90; mekanik döküm
  **1/48** (%2,1; eşik %5 → geçer). Vekil bu sürümle B kapısını genel ortalama ile E1 ve E6'da **geçemezdi**; istem 2'ye
  göre genel ortalama 3,52→3,70, E6 2,74→3,00, mekanik 6/46→1/48 iyileşti. Kalan zayıflık küçük durumlarda zorunlu
  bölümler arası tekrar ve küçük modelin akıcılığıdır. Değerlendirici üç taslağı daha mekaniğe yakın buldu (ikinci bir
  puanlayıcı birini ya da ikisini işaretleyebilir; oran eşiğe yaklaşır). S25'te değer düzeyi taramanın yakalayamadığı
  ilişkisel bir hata (4 Kasım işi 6 Kasım işinden sonra anlatılmış) ve iki dayanaksız yargı saptandı; bu tür hatalar 4I-C
  anlamsal destek denetiminin kapsamıdır. Formal B kapısı kurum içi adaylar ve iki kör insan puanlayıcıyla kapanır.
  İki kör insan puanlayıcı için paket `kor-puanlama-paketi.md` + `kor-puanlama-cizelgesi.csv` hazır (**bekliyor**).
- **Bekleyen dış ön koşullar:** kurum içi `GET /models` ile aday kimliklerinin doğrulanması; DeepSeek, Qwen ve taban
  modellerle 48 senaryonun koşulması (`node scripts/report-writer-qualification.mjs kosu --tasiyici kurum-ici --model <katalog_kimliği> --dagitim-ortami <ortam> --dusunme-kipi <ör. kapali> --nicemleme <ör. fp8> --cikti <kosu.jsonl>`, doğrulanan her aday için ayrı; bu üç üst veri bayrağından herhangi biri verilmezse `ozet` süre kapısını `eksik_ayar_bekliyor` olarak bırakır); iki kör insan
  puanlayıcı; kurum içi p95; nitelikli model çıkarsa `report.writer` eşlemesi ve stil belgesinde rol kaydı.
- **Sonraki giriş noktası:** 4I-B nitelendirmesi (kurum içi). 4I-C, 4I-B kabulünden sonra başlar.

### 2026-11-28 — Aşama 4I-C orantılı doğrulama ve yerel onarım

PR #125 birleştirme tabanı (`206729956d38604071bf67f79b10ba36d21b81e8`) üzerinden depo sahibinin onayıyla 4I-C
mühendislik uygulaması tamamlandı; 4I-B ve 4I-C'nin resmî kurumsal nitelendirme ve üretim kabul kısıtları aynen
korundu.

Uygulandı: bağlamsal belirlenimci nesnel olgu doğrulayıcısı ve Türkçe dilbilimsel normalleştirme + belirlenimci paragraf
kanıt seçicisi (`src/domain/ai/report/reportClaims.js`), bağımsız anlamsal denetim (`4i-denetim-1`) ve yerel paragraf
onarımı (`4i-onarim-1`) sözleşmeleri/istemleri/kapalı ayrıştırıcıları + belirlenimci son çare
(`src/domain/ai/report/reportReview.js`), sunucu bütçe/kimlik/yaşam döngüsü yürütücüsü
(`src/server/ai/report/reportRepair.js`), eşlemesiz `report.review` profili (`src/domain/ai/aiModelRegistry.js`),
yeniden sıralamada `allowRetry` denetimi (`src/server/ai/aiGateway.js`), geliştirici doğrulama/onarım önizleme betiği
(`scripts/yonetici-dogrulama-onizleme.mjs`) ve 32 sınamalık belirlenimci test kümesi
(`test/ai-executive-report-repair.test.mjs`).

- **Belirlenimci doğrulama ve kapsayıcı bütünleştirme (Node 22, Linux + Docker `node:22-slim`):**
  - 4I (`foundation`, `benchmark`, `evidence`, `writer`, `repair`) + `ai-semantic-retrieval` + `ai-model-registry` +
    `ai-architecture-contract` kümesi: **275/275** geçti (yeni `ai-executive-report-repair`: **32/32**); tam paket
    `npm test -- --test-concurrency=4` (**6967/6967**, başarısız/iptal/atlanan 0) ile doğrulandı.
  - `npm run lint` uyarısız; `npm run build` başarılı (yeni HTTP/API ucu, kalıcı tablo/göç ya da bağımlılık yok).
  - İzole Docker `node:22-slim` kapsayıcısında salt okunur bağlama ile 139/139 çekirdek sınama, `scripts/yonetici-dogrulama-onizleme.mjs --ornekler` ve üretim `next start` açılış denetimi (`GET /` 200, `GET /api/mergen-rota/auth/status` 401, geçici rapor ucu yok: 404) hatasız geçti.
- **48 senaryoluk 4I-B arşiv taraması ve kontrollü önce-sonra onarımlar:** `docs/kayitlar/4i-b-vekil-kosusu-2026-11-25/kosu-kaydi.jsonl` üzerindeki 48 gerçek taslakta belirlenimci tarama **30 temiz / 18 kritik bulgulu / 0 kesin kapı ihlali** üretti; arşivdeki S25 kronoloji tersinmesi ve S04 aritmetik/yüzde sapması (`6/%200` → `7/%250`) ile eksik zorunlu olgular belirlenimci olarak yakalandı. Kontrollü sentetik denetçi/onarım yanıtlarıyla S25, S04, R2/S40, R8 ve `one_cikan_tespit` vakalarında yalnızca sorunlu paragraf onarılıp çevredeki paragrafların bayt bayt korunduğu doğrulandı.
- **Canlı model ve kurumsal kabul durumu (bekliyor):** Bu ortamda haricî veya kurum içi canlı dil modeli anahtarı/CLI
  erişimi bulunmadığından canlı vekil/kurum içi denetçi ve onarım koşusu yapılmadı (sahte sonuç üretilmedi).
  `report.writer`, `report.writer.quality` ve `report.review` profilleri üretim kaydında eşlemesiz bırakıldı.
- **Bekleyen dış ön koşullar (4I-B + 4I-C resmî kabulü):** (1) kurum içi `GET /models` katalog doğrulaması; (2) DeepSeek,
  Qwen ve taban adayların 4I-B + 4I-C canlı koşuları ve bağımsız denetçi/yeniden sıralayıcı kalibrasyonu; (3) iki kör
  insan puanlayıcıyla editoryal düşüş (≤ 0,3) ve tekil sorun yerel çözüm oranı (≥ %90) doğrulaması; (4) kurum içi p95
  süre ölçümü.
- **Sonraki giriş noktası:** Kurum içi canlı 4I-B + 4I-C nitelendirmesi; kabul kapıları kapandıktan sonra 4I-D (kurumsal
  DOCX üretimi).
