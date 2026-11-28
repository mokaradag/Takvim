# Bilgin — Etkileşimli Kanıt Kartları Kabul Matrisi (ICE)

Bu belge ICE artımlarının zorunlu kabul kapılarını, her kapının kanıtını ve açık sınırlamaları tutar. Kapsam
[yol haritasında](BILGIN-ETKILESIMLI-KANIT-YOL-HARITASI.md), tasarım
[mimaride](BILGIN-ETKILESIMLI-KANIT-MIMARISI.md) bulunur. Bir kapı yalnızca gerçek kanıtla **KARŞILANDI** yazılır.

## ICE-1 kapıları

Doğrulama tarihi: 27.11.2026 · Temel: `main` @ `afd602a` · Ortam: Linux kapsayıcı, Node 22, Chromium (Playwright),
bellek içi SQL Server ikizi ve sentetik veri (`scripts/ui-acceptance/uiSeed.mjs`).

| Kapı | Durum | Kanıt |
| --- | --- | --- |
| A — Olgusal doğruluk | KARŞILANDI | `test/ai-evidence-cards.test.mjs`: aynı sayının farklı nüfusları ayrı kartlara bağlanır; aynı kanıtı paylaşan sayım ve görev olguları ayrı kart türleridir; kısmi önizleme kesin toplamla bildirilir; tutarsız sayı, fazla satır, kesin toplamsız eksik kanıt, boş nüfus ve satırsız araç kart üretmez. Canlı Haiku 5.5 yanıtında aynı yanıttaki analitik "Gecikmiş **8** görevin…" cümlesi bağsız kaldı, yalnızca sayım önermesindeki "**8**" bağlandı. |
| B — Güvenlik | KARŞILANDI | İzdüşüm not/açıklama, anahtar sözcük, erişim düzeyi, Sicil ve gizli eş sorumlu adı taşımaz; farklı sorumlular sunucuda Sicil ile ayrılır (aynı adlı iki kişi ayrı). Veri metni işaret taklit edemez (`escapedFactText` denetim karakterlerini boşluğa çevirir). Bozuk/sahte/yinelenen/kalın dışı işaret bütün bağları düşürür. Tanımlayıcının her bozuk alanı bütün tanımlayıcıyı düşürür (17 bozulma). Atfedilmemiş, defterde geçerli olmayan ya da künyesiz kanıt kart üretmez. Üretim sırasında yetki kalkınca yanıt `unavailable` olur ve kart gönderilmez (`test/ai-evidence-cards-e2e.test.mjs`). Kötü niyetli görev adı metin olarak kalır. |
| C — Model bağımsızlığı | KARŞILANDI | Kart için model çağrısı, araç ya da yönerge yoktur. Uçtan uca testte düzen turu tektir ve model iletilerinde işaret yoktur; önerme `plain` metni ve varsayılan Markdown çizimi bayt bayt aynıdır. Model yönergeleri (`assistantPrompt.js`, `groundedPrompt.js`) değişmedi. |
| D — Görsel kalite | KARŞILANDI | Gerçek uygulamada (profil B, ekip lideri) Özet referans kartları ile karşılaştırmalı inceleme: koyu ve açık tema, 1440 px, 1080 px + %125 yazı ölçeği, 390 px mobil (dokunma). Koleksiyon, tekil görev, kısmi önizleme, farklı sorumlular, kaydırılabilir liste, görev çekmecesinin açılması. İnceleme sonrası düzeltmeler: satırda yinelenen "gecikmiş + Geciken rozeti" kaldırıldı, tarih sağ sütuna taşındı, tekil "1 farklı sorumlu" → "Sorumlu", kart saati kaynak listesiyle aynı biçime (Türkiye saati) getirildi, ilerleme etiketli satır oldu, eylem rengi nötrleşti, tamamlanmış satırda yinelenen termin kaldırıldı. |
| E — Yaşam döngüsü | KARŞILANDI | Tarayıcıda gerçek akış: canlı yanıtta 3 bağ; başka konuşmaya geçip dönünce 0; eski konuşmada yeni soruda yalnızca yeni yanıtta bağ; sayfa yenileme ve geçmişten açmada 0. Birim: kayıtlı iletiden kurulan tur kart taşımaz; en yeni 6 yanıt ve 15 dk sınırı; oturum hatası kartları siler; genel (Rota verisiz) yanıt kart taşımaz; yeniden oynatılan tur kart taşımaz; bozuk tanımlayıcı çözücüde atılır. |
| F — Başarım | KARŞILANDI | Sunucu: 30 satırlı kart, 3 bağ, 1.826 karakterlik yanıt için işaret sökme + kart kurma medyan 0,64 ms, p95 1,19 ms (500 tekrar); aynı ortamdaki betikli tam tur ~400–550 ms, canlı tur saniyeler mertebesinde (ek yük %0,3'ün altında). Tarayıcı: tıklamadan görünür karta medyan 13,5 ms (çizim karesi dahil); üzerine gelmede ~190 ms (bilinçli 90 ms gecikme ve sürücü yükü dahil). Kart açma/kaydırma/satır inceleme sırasında 0 ağ isteği (dolayısıyla SQL yok). Sınırlar: `EVIDENCE_CARD_LIMITS` (kart 8, bağ 16, satır 30/kart ve 120/yanıt, kişi 30, metin 160, 64.000 karakter). |
| G — Gerileme koruması | KARŞILANDI | Tam takım, lint ve üretim derlemesi aşağıdaki sonuçlarla geçer. `HoverListCard` mevcut kullanımı (rol yok, odak taşınmaz, iki bağımsız değişkenli satır çizimi, Esc) ayrı testle korunur. Mevcut `renderComposition`/`presentVerdict` metin sözleşmeleri değişmedi. |
| H — Mimari bütünlük | KARŞILANDI | Yeni HTTP ucu, tablo, geçiş, zamanlanmış/arka plan işi, küresel değişken durum ya da bağımlılık yok. Yönetici raporu modülleri (`src/server/ai/report`, `src/domain/ai/report`) değişen modüllere bağımlı değildir ve değiştirilmedi. |

### Tam takım, lint ve derleme

| Denetim | Sonuç |
| --- | --- |
| `npm test` (değişiklik öncesi) | 6.791 / 6.791 geçti |
| `npm test` (ICE-1 sonrası) | 6.824 / 6.824 geçti (33 yeni ICE testi dahil) |
| `npx next lint` | Uyarı ve hata yok |
| `npx next build` | Başarılı |

### Canlı model kullanımı

| Ölçü | Değer |
| --- | --- |
| Gözlenen model | `claude-haiku-5-5` (her çağrıda CLI kullanım kaydından doğrulandı) |
| Çaba | `low` |
| Köprü üzerinden çağrı | 10 (9 başarılı: 6 plan + 3 düzen; 1 düşünme nedeniyle bağdaştırıcı reddetti) |
| Doğrudan CLI denemesi | 3 (erişim ve düşünme denetimi) |
| Düşünme | **Kapatılamadı.** `MAX_THINKING_TOKENS=0` ve `alwaysThinkingEnabled:false` ile de uyarlamalı düşünme sürdü (çağrı başına ~140–1.300 belirteç). Görsel test için bağdaştırıcıya açık izin (`PLANNER_CLAUDE_THINKING=allow`) eklendi; varsayılan değişmedi ve düşünme her satırda kayda geçer. |
| Veri | Yalnızca sentetik veri; üretim kanıtı dış sağlayıcıya gönderilmedi. |

## ICE-2 kapıları

Doğrulama tarihi: 28.11.2026 · Temel: `main` @ `72a04ca` (PR #126 birleşmiş) · Ortam: Linux kapsayıcı, Node 22, Chromium (Playwright),
bellek içi SQL Server ikizi, yalnızca sentetik veri (kıyas kümelerinin tohumları ve `scripts/ui-acceptance` tohumları).

| Kapı | Durum | Kanıt |
| --- | --- | --- |
| A — Görev sayısı kapsamı (birinci hedef) | KISMEN DOĞRULANDI | Düzeltilmiş belirlenimci koşuda 165/165 senaryo geçti. 666 görev sayısı geçerli çapaya bağlı, 142 bağsız sayı gerekçeli ve başarısız ya da kapsam dışı yanıtlardaki 12 sayı ölçüm dışında. Kimlik üyeliği 50 bağda sentetik veriye karşı ayrıca doğrulandı. |
| B — Olgusal doğruluk | KISMEN DOĞRULANDI | Kapsam koşusunda yanlış bağ veya beklenmedik eksik bağ bulunmadı. Portföyde aynı sayılı üyelik değişimi, etkilenen ve etkilenmeyen projeler, teslimde yetki daralması ve bağımsız nüfus kontrolü hedefli sınamalardan geçti. Bütün birleşik iddiaların üyelikleri bağımsız biçimde ölçülmedi. |
| C — Kişi, proje, hesap, karşılaştırma, dönem ve risk kanıtı | KISMEN DOĞRULANDI | Belirlenimci koşuda 166 yüzde, 219 varlık sayısı ve 614 ad bağı denetlendi. Fark yüzdesi iki dönemin işlenenleriyle doğrulanır. Tarihsel özetin iki ayrı kaynaktan gelen ortak sayısı ve gelecek terminleriyle güncel gecikmeleri birleştiren iddialar tek bir nüfusa bağlanmaz. |
| D — Güvenlik ve yetki | SINAMALAR GEÇTİ | Canlı kayıt model zarfı, kalıcı kanıt ve günlük dışında kalır. Sayısal kanıtın yanında geçici önizleme alanları da teslim anında doğrulanır. Yetkisi daralan kart düşerken yanıt ve etkilenmeyen kart korunur. SQL doğrulaması bellek içi SQL Server ikiziyle yapıldı. |
| E — Model bağımsızlığı | KARŞILANDI | Ek model çağrısı, araç, yönerge ya da önerme yok; `assistantPrompt.js` ve `groundedPrompt.js` değişmedi. Uçtan uca sınamada model düzeni kapalı yapılandırmada sunucu düzeni kart taşır ve düzen çağrısı 0'dır (`test/ai-evidence-cards-e2e.test.mjs`). |
| F — Görsel kalite ve etkileşim | KOLEKSİYON SENARYOSU GEÇTİ | Gerçek uygulamada sentetik veri ve betikli model ucu ile 1440 px, 1080 px + %125 ölçek, 390 px dokunma ve 667 × 300 koyu tema sınandı. 18 uzun adlı satırın bulunduğu koleksiyonun kaydırma alanı klavyeyle sona indi. Escape tetikleyicinin odağını geri verdi. Kart açma ve incelemede ağ isteği gözlenmedi. |
| G — Yaşam döngüsü | KARŞILANDI | ICE-1 kuralları değişmedi: yalnızca yeni, başarılı yanıt; 15 dakika; en yeni 6 yanıt; oturum hatasında temizleme; geri yükleme ve yeniden oynatmada kart yok (mevcut sınamalar geçer). |
| H — Başarım | KARŞILANDI | Aynı sentetik turlarda tam tur (12 tekrar, ilk 2 atılır): g31 214 → 262 ms, g05 185 → 243 ms, g45 değişmedi; ek SQL okuması tur başına 1–4, hepsi kimlikle sınırlı. Tanımlayıcı g31'de 87 KB. Kayıt kurulumu en kötü durumda (20.000 görev, 107 küme) ~112 ms. Tarayıcıda tıklamadan görünür karta medyan 17,0 ms, p95 21,7 ms (45 örnek); kart açma ve incelemede ağ isteği yok (görülen tek istek uygulamanın 60 saniyelik anlık görüntü yenilemesidir; etkileşimsiz ölçümle doğrulandı). |
| I — Canlı model nitelendirmesi | YENİDEN KOŞULMADI | Tarihsel 114/114 ölçümü güncel kabul kanıtı sayılmaz. Nitelendirme şimdi bitişi, soru kapsamını, kullanıcıya görünen çapayı ve koşunun bütünlüğünü denetler. Model düzeni ile sunucu anlatımı ayrı raporlanır. |
| J — Gerileme ve mimari bütünlük | KARŞILANDI | Tam takım, lint ve derleme aşağıda. Yeni HTTP ucu, tablo, geçiş, zamanlanmış/arka plan işi, küresel değişken durum ya da bağımlılık yok. Yönetici raporu modülleri (`src/server/ai/report`, `src/domain/ai/report`) değiştirilmedi ve yeni modüllere bağımlı değildir. |

### Tam takım, lint ve derleme (ICE-2)

| Denetim | Sonuç |
| --- | --- |
| `npm test` (değişiklik öncesi, `72a04ca`) | 6.857 / 6.857 geçti |
| `npm test` (ilk ICE-2 ölçümü) | 7.076 / 7.076 geçti. Bu tarihsel sonuç güncel koşunun yerine geçmez. |
| `npx next lint` | Uyarı ve hata yok |
| `npx next build` | Başarılı |

Gerileme sınamalarında yalnızca davranışı bilinçli olarak değişen dört beklenti güncellendi: sözleşme sürümü (v2), yeni sınırlarda
bütçe kırpması, model düzeni kapalıyken sunucu düzeninin kart taşıması ve kart önizlemesinin kimlikle sınırlı ek okuması (nüfus
okumalarının kapsam denetimleri aynen korunur).

### Tarihsel canlı model kullanımı (ilk ICE-2 koşusu)

Aşağıdaki kullanım kayıtları ilk ICE-2 koşusundandır. Bunlar düzeltilen nitelendirme kapısının sonucu değildir.

| Ölçü | Değer |
| --- | --- |
| Gözlenen model / çaba | `claude-haiku-5-5` / `low` (her çağrıda CLI kullanım kaydından) |
| Düşünme | Uyarlamalı düşünme açık kaldı (ICE-1 bulgusuyla aynı); açık izinle (`PLANNER_CLAUDE_THINKING=allow`) kabul edildi, 24.416 düşünme belirteci kayda geçti |
| Soru / model çağrısı | 16 soru; 32 çağrı (31 bağdaştırıcı + 1 doğrudan erişim denemesi); 3 çağrı CLI'nin iki iç çağrısı nedeniyle reddedildi; yeniden deneme 1 (o19 başarılı, g31 yine reddedildi) |
| Önbelleksiz girdi | 130.256 belirteç (sınır 250.000) |
| Önbellek yazma / okuma | 130.182 / 820.608 |
| Çıktı | 28.992 |
| Veri | Yalnızca sentetik veri; kayıtlar ve yanıtlar depoya eklenmedi |

## Açık sınırlamalar (ICE-1)

1. ~~Kart yalnızca görev araması kanıtına bağlanır~~ — ICE-2'de giderildi (görev özeti, iş yükü, portföy, bulgular).
2. ~~Ayrı kişi kartı yoktur~~ — ICE-2'de giderildi (kişi, proje, birim kartları ve koleksiyonları).
3. Model düzeni kapalıyken sunucu düzeni ICE-2'de bağ kurar; yalnızca sunucu düzeni gerekmeyen yalın doğrulanmış anlatım
   (`verdict` yolu) ICE-1 kuralıyla kartsızdır.
4. Görev açma mevcut `openTask` sözleşmesini kullanır; görev artık görüntülenemiyorsa çekmece açılmaz (mevcut davranış),
   kartta ayrıca bildirim gösterilmez.
5. Tarayıcıdaki 15 dakikalık yaşam süresi gözlemlenemeyen sunucu yetki iptalini algılamaz; yalnızca açıklama penceresini
   sınırlar. Gözlenen oturum hatasında kartlar hemen silinir.
6. Kısmi önizlemenin "Tümünü gör" eylemi yoktur: aynı nüfusu birebir gösteren güvenli bir mevcut görünüm bulunmadığı için
   ICE-2'de de eklenmedi; kartlar kesin toplamı ve gösterilen satır sayısını açıkça yazar.
7. Haiku 5.5'in düşünmesi kapatılamadı (yukarıda). Canlı sınama, model kalitesi kıyası değil, kart davranışının temsilî
   doğrulamasıdır.

## Açık sınırlamalar (ICE-2)

1. **Hareket (denetim) kaydı sayıları** ("**N** görev üzerinde **M** hareket", silinen/yeniden açılan görev) bağsızdır: katkıda
   bulunan kayıtlar silinmiş görevleri de içerir ve bugünkü yetkili görev satırı olarak gösterilemez; yeni tarihsel kayıt okuması
   açılmadı.
2. Eşitlikte birden çok nüfusu temsil eden tek sayı, alt sınır ("en az"), sabit eşik ("en az **3** açık görevi olanlar") ve sıfır
   nüfus bağsızdır. Atama toplamı paydalı paylar (bir görev birden çok kişide sayılır) tek yük alanına karşılık gelmediği için hesap
   kartı almaz.
3. Kapsam öznesi adları (süzgeçle seçilen proje/kişi; satır kanıtı yok) ve görev satırının bağlam proje adı varlık kartına bağlanmaz.
4. Tablo hücreleri vurgusuzdur ve bağlanmaz; aynı sayılar genellikle tablonun yanındaki cümlelerde bağlıdır.
5. Model düzeni kapalı ve sunucu düzeni gerekmeyen yalın doğrulanmış anlatım (`verdict` yolu) ICE-1 kuralıyla kartsızdır.
6. Ek SQL okumaları (kimlikle sınırlı önizleme sorumlu okuması; portföyde olgu okuması) gerçek SQL Server'da ölçülmedi; ICE-3
   başarım nitelendirmesinin konusudur.
7. Bağ bütçesi 96'dır; daha uzun yanıtta sondaki değerler sade metin kalır (kıyas kümesinde en çok 65 bağ gözlendi).
8. Haiku 5.5'in uyarlamalı düşünmesi kapatılamadı; en uzun model düzeninde CLI'nin iki iç çağrısı bağdaştırıcı tarafından
   reddedildi (üretim sunucu düzenine döner).
