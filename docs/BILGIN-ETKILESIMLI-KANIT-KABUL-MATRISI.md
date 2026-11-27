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

## Açık sınırlamalar (ICE-1)

1. Kart yalnızca görev araması (`rota_task_search`) kanıtındaki sayım önermelerine ve uç önermelerinde adı geçen göreve
   bağlanır. Satırsız toplu kanıt (ör. analitik sayım), analitik bulgu cümleleri ve "ilk ele alınabilecek iş" gibi öneri
   cümleleri bağsızdır (eksik kart kabul edilebilir; yanlış kart değildir).
2. "N farklı kullanıcı" cümlesine bağlı ayrı kişi kartı yoktur (mevcut önermelerde böyle bir cümle bulunmaz); kişi
   listesi görev kartının içindedir. ICE-2'ye ertelendi.
3. Model düzeni kapalıyken (`MERGEN_ROTA_AI_ANSWER_COMPOSITION=false`) yalnızca doğrulanmış anlatım gösterilir ve kart
   üretilmez. Düzen açıkken model seçimi olmayan (`NO_CHOICE`) yanıtlarda yalnızca grubun kendi sayım cümlesi bağlanır.
4. Görev açma mevcut `openTask` sözleşmesini kullanır; görev artık görüntülenemiyorsa çekmece açılmaz (mevcut davranış),
   kartta ayrıca bildirim gösterilmez.
5. Tarayıcıdaki 15 dakikalık yaşam süresi gözlemlenemeyen sunucu yetki iptalini algılamaz; yalnızca açıklama penceresini
   sınırlar. Gözlenen oturum hatasında kartlar hemen silinir.
6. Kısmi önizlemenin "Tümünü gör" eylemi yoktur: aynı nüfusu birebir gösteren güvenli bir mevcut görünüm bulunmadığı için
   eklenmedi (ICE-2 kapsamı).
7. Haiku 5.5'in düşünmesi kapatılamadı (yukarıda). Canlı sınama, model kalitesi kıyası değil, kart davranışının temsilî
   doğrulamasıdır.
