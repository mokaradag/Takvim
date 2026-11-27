# Bilgin — Etkileşimli Sohbet Kanıt Zekâsı (ICE) Yol Haritası

> **Bilgin açıklar. Sunucu kanıtlar. Rota görselleştirir. Kullanıcı inceler.**

Bu belge, Bilgin sohbet yanıtlarındaki sayısal ve adlandırılmış olguların arkasındaki yetkili kayıtların
etkileşimli kanıt kartlarıyla incelenebilmesini sağlayan **Interactive Chat Evidence Intelligence (ICE)**
girişiminin tek yol haritasıdır. Konuşma geçmişine bağımlı olmadan sonraki geliştirme oturumlarının işi
sürdürebilmesi için yazılmıştır. Mimari ayrıntılar [ICE mimarisi](BILGIN-ETKILESIMLI-KANIT-MIMARISI.md),
kabul ölçütleri ve kanıtları [ICE kabul matrisi](BILGIN-ETKILESIMLI-KANIT-KABUL-MATRISI.md) belgesindedir.

## Ürün ilkesi

Bilgin bir yanıtta **kaç** kayıt olduğunu söylediğinde, bu belirlenimci olarak doğrulanabiliyor ve yetkiliyse
kullanıcı **hangileri** olduğunu da görebilmelidir. Eksik kart kabul edilebilir; **yanlış kart kabul edilemez.**

## Durum terimleri

| Durum | Anlamı |
| --- | --- |
| PLANLANDI | Kapsamı tanımlı, uygulama başlamadı. |
| SÜRÜYOR | Uygulama ya da doğrulama devam ediyor. |
| ENGELLİ | Dış bir engel nedeniyle ilerleyemiyor; engel kayıtlıdır. |
| DOĞRULANDI | Kabul matrisindeki zorunlu kapılar gerçek kanıtla karşılandı; birleştirme bekliyor. |
| TAMAMLANDI | Doğrulanmış artım ana dala birleştirildi. |

## Kalıcı sınırlar (bütün artımlar)

- Kartlar yalnızca **bu oturumda yeni üretilmiş, başarıyla tamamlanmış** sohbet yanıtlarında bulunur. Geri
  yüklenen (yenileme, konuşma değişimi, yeniden açma) yanıtlarda kart yoktur.
- Kart içeriği ve bağları **geçicidir**: veritabanına, konuşma kaydına, kalıcı kanıt JSON'una, tarayıcı
  deposuna, URL'ye, günlüğe/telemetriye ve model bağlamına girmez. Veritabanı geçişi yoktur.
- **Ek model iş yükü yoktur**: kart için model çağrısı, model belirteci, model aracı ya da modelin ürettiği
  işaretleme yoktur. Modele giden yönergeler ve görünümler değişmez.
- Yeni HTTP ucu, arka plan işi, zamanlanmış iş, süreç çapı önbellek ya da küresel değişken durum yoktur.
- Yetki ve gizlilik kuralları (FULL/READ/PARTIAL, kimlik görünürlüğü, not rızası, örgüt ve kullanıcı yalıtımı)
  aynen geçerlidir; kart yanıttan daha geniş bilgi açamaz.
- ICE, yönetici raporu girişiminden (Aşama 4I) **tamamen yalıtılmıştır**: yönetici raporu yönergelerine,
  kanıt sözleşmelerine, yazıcılarına, şablonlarına ve Executive Report Studio'ya dokunmaz; o girişime bağımlılık
  eklemez ve ondan bağımlılık almaz.
- Güvenlik ve doğruluk gereksinimleri ICE-1'den itibaren tam geçerlidir; ICE-3'e ertelenmez.

## ICE-1 — Temel Mimari ve Etkileşimli Görev Kartları

**Durum: DOĞRULANDI** (27.11.2026; bütün zorunlu kapılar kabul matrisinde kanıtlı. Birleştirme sonrası TAMAMLANDI olur.)

Kapsam:

- Belirlenimci olgu → kanıt bağlama (önerme parçası düzeyinde, metin araması olmadan).
- Sunucunun ürettiği, sürümlü, sınırlı ve geçici kart tanımlayıcıları (`done` olayıyla).
- Görev koleksiyonu kartları: görev araması (`rota_task_search`) kanıtına dayanan sayım önermeleri
  (toplam, açık, tamamlanan, devam eden, yapılacak, gecikmiş, yaklaşan termin, sorumlusuz ve diğer süzgeçler).
- Tekil görev kartları: uç önermelerinde (ör. "en uzun süredir geciken görev **X**") adı geçen görev.
- Kart içinde kanıt satırlarının **farklı yetkili sorumluları** (görev sayılarıyla), sorumlusuz ve sorumlu
  bilgisi gösterilemeyen görev sayıları.
- Kısmi önizlemenin açıkça bildirilmesi ("47 görevden 20'si gösteriliyor").
- Kaydırılabilir, klavye/dokunmatik erişilebilir kartlar; mevcut `HoverListCard` ve Özet görev satırı biçimi.
- Mevcut görev açma altyapısı (`useTaskActions().openTask`) ile görev ayrıntısının açılması.
- Sohbet içi yaşam döngüsü: süre sınırı, en son yanıtlarla sınırlı bellek, oturum hatasında temizleme.
- Güvenlik, gerileme, başarım ve görsel kabul.

ICE-1 dışı (bilinçli olarak):

- **"N farklı kullanıcı" cümlesine bağlı ayrı kişi kartı.** Mevcut belirlenimci önermelerde farklı sorumlu
  sayısını söyleyen bir cümle yoktur; böyle bir önerme eklemek modele giden önerme görünümünü değiştirir
  (ek model belirteci). Kişi listesi bu nedenle ICE-1'de görev kartının içinde sunulur; bağlı kişi kartı ICE-2'dedir.
- Satırsız toplu kanıtlar (ör. `rota_task_analytics` sayımları): katkıda bulunan satırlar kanıtta olmadığı için
  kart üretilmez; yeni SQL sorgusu açılmaz.
- Tablo hücrelerindeki görev adları (satırlar zaten tabloda görünür).
- Model düzeni yapılandırmayla kapalıyken (`MERGEN_ROTA_AI_ANSWER_COMPOSITION=false`) gösterilen doğrulanmış anlatım: bu
  yolda bağ kurulmaz, yanıt kartsız gösterilir. Düzen açıkken model seçimi olmayan yanıtta yalnızca grubun kendi sayım
  cümlesi bağlanır (bkz. mimari §2.1).

## ICE-2 — Gelişmiş Analitik ve Zamansal Kanıt Kartları

**Durum: PLANLANDI**

Gelecek kapsam:

- Bağlı kişi kartları ve geniş kullanıcı koleksiyonları (iş yükü özeti kişi satırları dahil).
- Proje koleksiyonları; tekil proje ve kullanıcı ayrıntıları.
- İş yükü dağılımları, yüzdeler ve doğrulanmış hesap açıklamaları.
- Karşılaştırmalı analitik olgular ve doğrulanmış risk göstergelerinin dayanakları.
- Yeni üretilen yanıtlarda tarihsel ve zamansal olgular; yetkili tarihsel atama ve görev hareketi kayıtları.
- Büyük koleksiyonların incelenmesi; gerçekten gerekiyorsa sınırlı ve ölçeklenebilir ayrıntı okuması.

Geri yüklenen tarihsel konuşmalarda etkileşimli kartlar ICE-2'de de **kapsam dışıdır**.

## ICE-3 — Endüstriyel Nitelendirme ve Üretim Kabulü

**Durum: PLANLANDI**

Gelecek kapsam: kapsamlı modeller arası uyumluluk, genişletilmiş saldırgan güvenlik nitelendirmesi,
başarım/ölçeklenebilirlik nitelendirmesi, erişilebilirlik nitelendirmesi, cihaz ve tema doğrulaması,
üretime hazırlık, bakım ve işletim sağlamlaştırması, son görsel incelik.

## Karar kaydı

| Tarih | Karar | Gerekçe |
| --- | --- | --- |
| 27.11.2026 | Bağ, önerme parçası (`{ value, strong, bind }`) düzeyinde kurulur; metin içinde sayı/ad araması yapılmaz. | Aynı sayının farklı anlamlarını ayırmanın tek belirlenimci yolu olgunun kendi üretim noktasıdır. |
| 27.11.2026 | Konum, sunucunun yalnızca kendi düzen yolunda eklediği denetim karakteri işaretleriyle (U+001E/U+001F) bulunur ve kalın düğüm sırasına çevrilir; işaretler yanıt metninden önce sökülür. | Veri metni (`escapedFactText`) ve kalıcı ileti normalleştirmesi denetim karakterlerini zaten temizler: işaret veriden taklit edilemez, kalıcı metne sızamaz. Metin ofseti kullanılmaz. |
| 27.11.2026 | Kart içeriği, son yetki yeniden doğrulamasından geçmiş kanıt yükünün dar izdüşümüdür; açıklama/not, Sicil, erişim ve gizli eş sorumlu adları taşınmaz. | Kart yanıttan geniş bilgi açamaz; not rızası ve kimlik görünürlüğü korunur. |
| 27.11.2026 | Kartlar `done` olayında ayrı alan (`evidenceCards`) olarak taşınır; `assistantMessage` ve kalıcı kayıt değişmez. | Kalıcı yanıt ile geçici zenginleştirme ayrı kalır; yeniden oynatma ve uzlaştırma kart taşımaz. |
| 27.11.2026 | İstemci yaşam süresi 15 dakika ve en son 6 yanıtla sınırlıdır; oturum hatasında bütün kartlar silinir. | Gözlemlenemeyen sunucu yetki iptalinin etkisini sınırlar; uzun konuşmada bellek sınırsız büyümez. |
| 27.11.2026 | Kişi listesi ICE-1'de görev kartı içinde sunulur. | Ayrı kişi önermesi model görünümünü değiştirirdi (bkz. ICE-1 dışı). |

## Bilinen sınırlamalar

Güncel sınırlamalar kabul matrisinin "Açık sınırlamalar" bölümünde tutulur.
