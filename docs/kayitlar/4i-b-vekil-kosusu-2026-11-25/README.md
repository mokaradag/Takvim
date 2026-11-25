# Bilgin 4I-B — vekil model koşu kaydı (25.11.2026)

> **Bu bir kurum içi model nitelendirmesi DEĞİLDİR.** Koşu, geliştirme ortamında küçük ve düşük eforlu bir vekil
> modelle (yalıtılmış komut satırı köprüsü) yapılmıştır. Amacı, gerçek bir dil modelinin uygulamanın ürettiği yazar
> istemini, bölüm planını ve kanıtı aldığında yazar hattının (plan → istem → model → değiştirilmemiş yanıt → ayrıştırıcı →
> değerlendirme) uçtan uca doğru çalıştığını göstermektir. Sonuçlar DeepSeek, Qwen ya da taban modellerin sonucu yerine
> kullanılmaz; `nitelikli_modeller` alanına yazılmaz. Bütün içerik **sentetiktir**.

| Alan | Değer |
| --- | --- |
| Commit tabanı | 4I-B dalı (bu kayıtla aynı commit) |
| Yazım sözleşmesi / istem | `4i-yazim-1` / `yazar-istemi-2` |
| Paket kümesi | `test/fixtures/bilgin-executive-report-writer-packages.json` (48 paket, küme özeti dosyada) |
| Yapılandırma özetleri | `kosu-yapilandirma-ozetleri.sha256` (yazar modülleri, stil belgesi, paket kümesi; `sha256sum -c` ile doğrulanır) |
| Taşıyıcı | `vekil` (`scripts/report-writer-qualification.mjs`): yalıtılmış ev klasörü, araçsız, tek tur, model kimliği ve tek API çağrısı her yanıtta denetlenir; düşünme düşük efor düzeyinin kendi davranışına bırakılmış ve kaydedilmiştir |
| Bilinen sapma | Köprü rol ayrımlı kullanıcı iletilerini etiketli tek kullanıcı iletisine düzleştirir ve CLI kendi ortam notlarını ekler; sistem yönergesi bayt bayt aynen verilir. Örnekleme ayarları CLI varsayılanıdır |
| Eşzamanlılık | 4 |

## Dosyalar

| Dosya | İçerik |
| --- | --- |
| `kosu-kaydi.jsonl` | 48 senaryonun değiştirilmemiş ham model yanıtları, ayrıştırılmış taslaklar, kullanım, süre ve kayıt anındaki nesnel tarama |
| `hakem-kararlari.json` | Defter dışı değerler ve otomatik eşleşmeyen zorunlu olgular için elle verilen kararlar ve gerekçeleri (hakem: geliştirme oturumu; insan değil) |
| `anlati-ornekleri.md` | Haftalık, aylık, başarı ve risk odaklı, dönem karşılaştırmalı, zengin not sentezi ve çelişkili kanıt örnekleri — gerçek yazar çıktısı, düzeltilmemiş |
| `gecici-editoryal-degerlendirme.json` | Yazardan farklı, kör bir model değerlendiricisinin E1–E9 ve mekanik döküm puanları (**insan puanı değildir**, destekleyici kanıttır) |
| `kor-puanlama-paketi.md`, `kor-puanlama-cizelgesi.csv` | İki kör insan puanlayıcı için paket ve çizelge (rastgele kod ve sıra; model ve senaryo kimliği yok) |
| `kor-puanlama-anahtari-PUANLAYICIYA-VERILMEZ.json` | Kod → senaryo anahtarı; yalnızca koordinatör kullanır |

Özet yeniden üretimi:

```bash
node scripts/report-writer-qualification.mjs ozet --girdi docs/kayitlar/4i-b-vekil-kosusu-2026-11-25/kosu-kaydi.jsonl --hakem docs/kayitlar/4i-b-vekil-kosusu-2026-11-25/hakem-kararlari.json --editoryal docs/kayitlar/4i-b-vekil-kosusu-2026-11-25/gecici-editoryal-degerlendirme.json
```

## Sonuç (vekil, sentetik)

Sayısal sonuçlar ve yorumu yol haritasının "Oturum devri — 2026-11-25" girdisindedir. Kapı durumu: A ve B kapıları bu
koşuyla **kapatılmaz** (vekil model; insan puanı ve kurum içi doğrulama yok); D yazar süresi yalnızca vekil için
bilgidir. Formal 4I-B nitelendirmesi ve kabulü **bekliyor**.
