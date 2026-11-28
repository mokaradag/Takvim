# Bilgin 4I-B — vekil model koşu kaydı (25.11.2026)

> **Bu bir kurum içi model nitelendirmesi DEĞİLDİR.** Koşu, geliştirme ortamında küçük ve düşük eforlu bir vekil
> modelle (yalıtılmış komut satırı köprüsü) yapılmıştır. Amacı, gerçek bir dil modelinin uygulamanın ürettiği yazar
> istemini, bölüm planını ve kanıtı aldığında yazar hattının (plan → istem → model → değiştirilmemiş yanıt → ayrıştırıcı →
> değerlendirme) uçtan uca doğru çalıştığını göstermektir. Sonuçlar DeepSeek, Qwen ya da taban modellerin sonucu yerine
> kullanılmaz; `nitelikli_modeller` alanına yazılmaz. Bütün içerik **sentetiktir**.

| Alan | Değer |
| --- | --- |
| Commit tabanı (arşiv) | `7d2a13f` (arşivlenen vekil koşusu ve `kosu-yapilandirma-ozetleri.sha256` bu revizyondaki girdileri doğrular; sonraki sertleştirme ve fikstür güncellemeleri için `sha256sum -c` bu revizyona karşı çalıştırılır) |
| Yazım sözleşmesi / istem | `4i-yazim-1` / `yazar-istemi-4` (son yapılandırma; ara sürümler `ara-kosular-ozet.json`) |
| Paket kümesi | `test/fixtures/bilgin-executive-report-writer-packages.json` (`7d2a13f` anlık görüntüsü; 48 paket, küme özeti `kosu-yapilandirma-ozetleri.sha256` içinde) |
| Yapılandırma özetleri | `kosu-yapilandirma-ozetleri.sha256` (`7d2a13f` revizyonundaki yazar modülleri, stil belgesi ve paket kümesi; tarihsel doğrulama için `git archive 7d2a13f` veya ilgili revizyon üstünde `sha256sum -c` ile doğrulanır) |
| Taşıyıcı | `vekil` (`scripts/report-writer-qualification.mjs`): yalıtılmış ev klasörü, araçsız, tek tur, model kimliği ve tek API çağrısı her yanıtta denetlenir; düşünme düşük efor düzeyinin kendi davranışına bırakılmış ve kaydedilmiştir (**karma arşiv notu:** 46 satırda `dusunme: "on"`, S25 ve S29 satırlarında `dusunme: "off"` kaydedilmiştir; `selectHomogeneousRun` istenen `dusunme_kipi` ve gözlemlenen `efor` tutarlılığını zorunlu kılar, gözlemlenen vekil `dusunme` karışımı ise özette `gozlemlenen_vekil_dusunme: "karisik"` olarak raporlanır ve `compareQualificationRuns` aşamasında karşılaştırma uyuşmazlığı sayılır) |
| Bilinen sapma | Köprü rol ayrımlı kullanıcı iletilerini etiketli tek kullanıcı iletisine düzleştirir ve CLI kendi ortam notlarını ekler; sistem yönergesi bayt bayt aynen verilir. Örnekleme ayarları CLI varsayılanıdır |
| Eşzamanlılık | 4 |

## Dosyalar

| Dosya | İçerik |
| --- | --- |
| `kosu-kaydi.jsonl` | 48 senaryonun değiştirilmemiş ham model yanıtları, ayrıştırılmış taslaklar, kullanım, süre ve kayıt anındaki nesnel tarama (yalnızca arşiv/koordinatör içindir; kör insan puanlayıcılarına **verilmez**) |
| `ara-kosular-ozet.json` | İstem 1–3'ün tam koşularının özeti ve bulguları (son koşuyla birleştirilmez) |
| `ara-kosu-istem2-editoryal-degerlendirme.json` | İstem 2 taslaklarının kör model değerlendirmesi (B kapısı geçilemezdi; istem 3–4 düzeltmelerinin gerekçesi) |
| `hakem-kararlari.json` | Defter dışı değerler ve otomatik eşleşmeyen zorunlu olgular için elle verilen kararlar ve gerekçeleri (hakem: geliştirme oturumu; insan değil) |
| `anlati-ornekleri.md` | Haftalık, aylık, başarı ve risk odaklı, dönem karşılaştırmalı, zengin not sentezi ve çelişkili kanıt örnekleri — gerçek yazar çıktısı, düzeltilmemiş |
| `gecici-editoryal-degerlendirme.json` | İstem 4 taslaklarının, yazardan farklı ve kör bir model değerlendiricisince E1–E9 ve mekanik döküm puanları (**insan puanı değildir**, destekleyici kanıttır). Değerlendirici yönergesine istem 2 değerlendirmesine göre tek açıklama eklendi: durumun gerçekten küçük olduğu raporda yerinde kısalık kusur sayılmaz (ölçütün R7 beklentisiyle uyumlu); iki değerlendirme bu nedenle tam karşılaştırılabilir değildir |
| `kor-puanlama-paketi.md`, `kor-puanlama-cizelgesi.csv` | Arşiv kopyası (§4 E1–E9 ölçüt tanımları ve her E8 kaynak notunda sentetik görev/proje atfıyla kanonik üreticiden yenilenmiştir). **Kör dağıtım kuralı:** Gerçek insan puanlaması için bu depo arşiv dizini puanlayıcılara açılmaz (`kosu-kaydi.jsonl` aynı arşivde durduğundan model/senaryo eşleştirmesi yapılabilir); koordinatör `insan-paketi --dizin <yalitilmis-puanlayici-dizini> --anahtar <dis-yol>` komutuyla yalnızca `kor-puanlama-paketi.md` ve `kor-puanlama-cizelgesi.csv` dosyalarını ayrı bir dağıtım dizinine üretir |

Özet yeniden üretimi (arşivlenmiş 25.11.2026 vekil koşusu güncel kanıt kümesinden önceki paket özetleriyle üretildiği için yalnızca kanıt/taslak özeti uyuşmazlıklarına izin veren `--tarihsel-uyusmazlik-izni evet` bayrağıyla çağrılır):

```bash
node scripts/report-writer-qualification.mjs ozet --girdi docs/kayitlar/4i-b-vekil-kosusu-2026-11-25/kosu-kaydi.jsonl --hakem docs/kayitlar/4i-b-vekil-kosusu-2026-11-25/hakem-kararlari.json --editoryal docs/kayitlar/4i-b-vekil-kosusu-2026-11-25/gecici-editoryal-degerlendirme.json --tarihsel-uyusmazlik-izni evet
```

## Sonuç (vekil, sentetik)

S03 hakem kararı tarihsel kanıt sürümü üzerinden düzeltildi. Dönemdeki iki belge güncellemesi Denge’ye, tek tamamlanan görev Meltem’e aittir. Yanlış proje atfı eklendiğinde S03’ün kayıtlı doğruluk oranı 15/15’ten 15/16’ya (%93,75) düştü. Ham taslak özeti aynı kaldı. Güncel kanıt kümesiyle özet üretildiğinde tarihsel paket uyuşmazlığı nedeniyle S03’ün doğruluk durumu bekliyor olarak raporlanır.

S08’de kaynak notlarının desteklemediği Meltem–Pusula gecikme bağlantısı bir yanlış iddia sayıldı. Tarihsel doğruluk 17/18 (%94,44) oldu. S37’de 19 Kasım test tarihi ile 26 Kasım hedef bitişini çelişkili gösteren iddia bir yanlış olarak sayıldı. Tarihsel doğruluk 8/9 (%88,89) oldu. Koşunun özgün dondurulmuş kümesiyle yeniden hesaplandığında %95 altında kalan rapor sayısı 4’ten 6’ya çıktı. Güncel kümenin özeti koşu kaydıyla uyuşmadığından güncel küme üzerinden üretilen raporda tarihsel doğruluk kararları beklemede kalır. S25’in mevcut hakem notunda açıklanan olay sırası hatası yapılandırılmış sayaçta da kaydedildi.

Sayısal sonuçlar ve yorumu yol haritasının "Oturum devri — 2026-11-25" girdisindedir. Kapı durumu: A ve B kapıları bu
koşuyla **kapatılmaz** (vekil model; insan puanı ve kurum içi doğrulama yok); D yazar süresi yalnızca vekil için
bilgidir. Formal 4I-B nitelendirmesi ve kabulü **bekliyor**.
