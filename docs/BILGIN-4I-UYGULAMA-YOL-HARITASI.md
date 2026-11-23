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

**Durum: PLANLANDI.**

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
   `reportNotes.js` (not sürümleri, öncelik, kırpma), ilgili sabit SQL eklemeleri, `test/ai-executive-report-evidence.test.mjs`,
   sentetik SQL ikizi genişletmesi.
6. **Gözlenebilir çıktılar** — Sentetik veride, görevlerden, notlardan ve hareketlerden seçilmiş anlamlı bilgiyi
   gösteren tanı önizlemeleri (paket JSON'u + okunur özet); R1, R4, R5, R7, R8 vakalarının paketleri.
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
16. **Durum ve doğrulama kanıtı** — Henüz uygulanmadı.

---

## 4I-B — İnsan kalitesinde anlatı üretimi

**Durum: PLANLANDI.**

1. **Amaç ve kullanıcı değeri** — Kanıt paketinden, yetkin bir analistin yazacağı gibi özgün, bağlantılı ve
   bağlamlı Türkçe yönetici raporu taslağı üretmek.
2. **İşlevsel kapsam** — Rapor yazarı (`4i-yazim-1`): sistem yönergesi, bölüm planı, kanıt iletileri, yapılandırılmış
   çıktı (bölüm → paragraf → serbest metin + iddia eki); ayrıntı düzeyi ve odak; on-prem model nitelendirmesi
   (DeepSeek, Qwen ve tabanlar); nitelendirme sonrası model kaydına rapor profilleri.
3. **Yeniden kullanılan altyapı** — Ağ geçidi (`aiGateway.js`: kimlik, kapasite, süre, iptal), model kaydı ve
   profil çözümü, kabul denetimi, içeriksiz telemetri, nitelendirme betik desenleri (`scripts/planner-*`).
4. **Mimari sınırlar** — Sohbet düzyazı sözleşmesi kullanılmaz ve değiştirilmez; yazar araç çağırmaz, SQL görmez;
   sunucu paragrafları yeniden kurmaz; model adı iş kodunda geçmez; denetimsiz yeniden deneme yok.
5. **Beklenen dosya ve bileşenler** — `reportWriterPrompt.js`, `reportDraft.js` (çıktı ayrıştırma/doğrulama),
   `reportSectionPlan.js`, kayıtta `report.writer` / `report.writer.quality` profilleri (nitelendirmeden sonra),
   `scripts/report-writer-qualification.mjs`, `test/ai-executive-report-writer.test.mjs`.
6. **Gözlenebilir çıktılar** — DeepSeek, Qwen ve onaylı tabanlardan tam, gerçekten insan yazısı gibi okunan rapor
   taslakları; kör insan puanları; model başına A/B/D sonuçları.
7. **Gerekli referans görüntüleri ve varlıklar** — Model kataloğu görüntüleri (aday kimlikleri); insan dili örnek
   rapor (editoryal hedef).
8. **İşlevsel ve işlevsel olmayan kabul ölçütleri** — Kabul çerçevesi §5: 4I-B taslak A kapıları (rapor başına
   nesnel olgu doğruluğu ≥ %95), B eşikleri (genel ≥ 4,0; uygulanabilir her ölçüt ≥ 3,5; aday düzeyinde mekanik
   döküm ≤ %5) ve D bütçeleri (`rapor_yazari_otomatik` için standart raporda p95 ≤ 240 sn; rapor başına en çok
   11 çağrı). 4I-B kabulü için `rapor_yazari_otomatik` rolünün dolması zorunludur. **Kritik kapı:** aday
   düzeyinde mekanik döküm oranı %5'i aşıyorsa artım olgusal doğruluktan bağımsız olarak başarısızdır.
9. **Güvenlik ve yetki sınamaları** — Yazara yalnızca yetkili kanıt ve anlatı için gerekli kapsam/tamlık bilgisi gider.
   Not içi yönerge izlenmez ve gerçek risk korunur (R6, K19). Kısmi erişim toplamı görünür görevlerden hesaplanır
   ve kapalı varlık adı kesin kapıdır (R8). İçerik günlüğe girmez.
10. **Doğal dil kalite gereksinimleri** — Stil belgesi `anlati`: bağlantılı paragraflar, sentez, somutluk, kalıp
    tekrarından kaçınma, belirsizliğin ölçülü anlatımı, notların profesyonel dönüşümü, suç atfı yok.
11. **Regresyon gereksinimleri** — Sohbet profilleri, yönergesi ve kıyas kapıları değişmez; ağ geçidi sınırları
    yükseltilmez.
12. **Başarım ve kaynak** — Rapor başına en çok 1 yazım çağrısı (+ 4I-C onarımları); standart raporda p95 eşiği
    `rapor_yazari_otomatik` için ≤ 240 sn, `rapor_yazari_yuksek_kalite` için ≤ 600 sn; çıktı belirteci sınırı
    profil üzerinden.
13. **Bağımlılıklar** — 4I-A; canlı model kataloğu doğrulaması; kurum içi model erişimi.
14. **Riskler ve geri alma** — `rapor_yazari_otomatik` için hiçbir aday A, B ve p95 ≤ 240 sn eşiklerini geçmezse
    `rapor_yazari_yuksek_kalite` dolsa bile 4I-B kabulü **ENGELLİ** olur (eşik gevşetilmez); uzun süre → yüksek
    kalite rolü ayrı (p95 ≤ 600 sn); geri alma: rapor profilleri kayıttan kaldırılır.
15. **Kapsam dışı** — Onarım döngüsü (4I-C), DOCX (4I-D), arayüz (4I-E).
16. **Durum ve doğrulama kanıtı** — Henüz uygulanmadı.

---

## 4I-C — Orantılı doğrulama ve yerel onarım

**Durum: PLANLANDI.**

1. **Amaç ve kullanıcı değeri** — Olgusal hataları, iyi yazılmış düzyazıyı yok etmeden yerinde düzeltmek.
2. **İşlevsel kapsam** — Nesnel olgu doğrulaması (sayı, tarih, kimlik, durum; biçim normalleştirme); desteklenen
   zorunlu anlamsal destek denetimi (bağımsız denetçi veya eşdeğer inceleme, isteğe bağlı yeniden sıralama); paragraf/cümle düzeyinde yerel onarım;
   sınırlı deneme (paragraf başına 2, rapor başına 8); nitele ya da çıkar; kritik hata ve insan incelemesi politikası.
3. **Yeniden kullanılan altyapı** — Kanıt paketi (`E#`/`F#`), sayı ve tarih biçimleme yardımcıları, anlamsal
   katmanın yeniden sıralama profili, ağ geçidi.
4. **Mimari sınırlar** — Birebir cümle eşleşmesi aranmaz; paragraf hazır sunucu metniyle değiştirilmez; bütün rapor
   tek ifade için reddedilmez; kesin kapılar onarılamazsa rapor yayımlanmaz ama taslak korunur.
5. **Beklenen dosya ve bileşenler** — `reportClaims.js` (nesnel çıkarım ve defter eşleşmesi), `reportReview.js`
   (denetçi çıktısı), `reportRepair.js` (döngü ve bütçe), `test/ai-executive-report-repair.test.mjs`.
6. **Gözlenebilir çıktılar** — Önce/sonra raporları: tekil olgusal sorunlar (R2, S41) düzeltilmiş, çevredeki düzyazı
   korunmuş; işaretlenen nitelemeler; inceleme gerektiren kritik vakalar.
7. **Gerekli referans görüntüleri ve varlıklar** — Gerekmez.
8. **İşlevsel ve işlevsel olmayan kabul ölçütleri** — Kabul çerçevesi §5 onarım eşikleri (editoryal düşüş ≤ 0,3;
   tekil sorunların ≥ %90'ı yerel çözülür; hazır metne düşme 0). **Kritik kapı:** hem olgusal bütünlük hem anlatı
   kalitesi doğrulamadan sağ çıkmalıdır.
9. **Güvenlik ve yetki sınamaları** — Kapalı/uydurma varlık kesin kapısı; yetkisiz açıklama sıfır; onarım isteğine
   yalnızca ilgili yetkili kanıt gider; denetçi çıktısı yapılandırılmış ve doğrulanmış.
10. **Doğal dil kalite gereksinimleri** — Onarılan paragraf çevresiyle doğal biçimde bağlanır; nitelemeler ölçülü;
    çıkarma sonrası paragraf bütünlüğü korunur.
11. **Regresyon gereksinimleri** — 4I-B kalite puanları onarımla anlamlı düşmez; sohbet doğrulayıcıları değişmez.
12. **Başarım ve kaynak** — Rapor başına en çok 11 model çağrısı (1 yazım, 8 onarım, denetim ve yeniden sıralama
    için ortak 2 çağrı). Onarım isteği yalnızca ilgili paragrafı ve kanıtı taşır.
13. **Bağımlılıklar** — 4I-B. Model kullanıldığında denetçi ve yeniden sıralayıcı rolleri nitelendirilir.
14. **Riskler ve geri alma** — Denetçinin aşırı katılığı (yorumu reddetmesi) → eşik ve insan kalibrasyonu;
    denetçi kararının yayın kararı sayılmaması. Denetçi geri alınırsa belirlenimci nesnel denetim korunur ve
    maddi iddia desteği eşdeğer incelemeyle doğrulanır. Doğrulanamayan içerik ve kritik sorunlar için mimari §8.2 uygulanır.
15. **Kapsam dışı** — Stüdyo'daki kullanıcı düzenlemeleri (4I-E) ve DOCX (4I-D).
16. **Durum ve doğrulama kanıtı** — Henüz uygulanmadı.

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
