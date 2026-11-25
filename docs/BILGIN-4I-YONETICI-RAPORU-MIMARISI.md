# Bilgin Aşama 4I — Yönetici Raporu Mimarisi ve Sözleşmeleri

Bu belge, Aşama 4I'nin (profesyonel yönetici raporu) **mimarisini, sorumluluk sınırlarını ve sözleşmelerini**
tanımlar. Artımların sırası, kabul kapıları ve ilerleme kaydı
[4I Uygulama Yol Haritası](BILGIN-4I-UYGULAMA-YOL-HARITASI.md)'ndadır; kıyas kümesi, insan puanlama ölçütü ve
önceden tanımlanmış eşikler [4I Kıyas ve Kabul Çerçevesi](BILGIN-4I-KIYAS-VE-KABUL-CERCEVESI.md)'ndedir. Kurumsal
biçimin makinece okunur tek kaynağı [`config/ai/bilgin_rapor_stili.yaml`](../config/ai/bilgin_rapor_stili.yaml) ve
onunla aynı stili anlatan [`config/ai/bilgin_kurumsal_rapor_sablonu.docx`](../config/ai/bilgin_kurumsal_rapor_sablonu.docx)
dosyasıdır.

Güvenlik ve yetki sözleşmeleri değişmez: [Yetkilendirme Modeli](YETKILENDIRME-MODELI.md),
[AI Alan Araçları](YAPAY-ZEKA-ALAN-ARACLARI.md), [Yapay Zekâ Platformu](YAPAY-ZEKA-PLATFORMU.md) ve
[AI Anlamsal Katmanı](YAPAY-ZEKA-ANLAMSAL-KATMAN.md). Bu belge onları yinelemez, üzerlerine kurar.

**Durum (25.11.2026):** 4I-0 (stil belgesi, şablon, model kaydı uzlaştırması, kıyas fikstürü), **4I-A** (yetkili
yönetici kanıt paketi kurucusu `4i-kanit-1`, istek doğrulaması, rapor düzeyi rızalı zengin not okuması ve geliştirici
tanı önizlemesi) uygulanıp belirlenimci sınamalarla doğrulandı. **4I-B** anlatı yazarının mühendislik uygulaması
(`4i-yazim-1`: bölüm planı, yazar istemi, taslak ayrıştırıcısı, sunucu yazarı, rapor profilleri, kıyas paket kümesi ve
nitelendirme araçları) tamamlandı ve belirlenimci sınamalarla doğrulandı; vekil modelle canlı koşu yapıldı (§7.4).
Kurum içi model nitelendirmesi ve kör insan puanlaması **bekliyor**; bu nedenle rapor profilleri hiçbir modele eşli
değildir. Doğrulama/onarım döngüsü (4I-C), DOCX üreticisi (4I-D), Stüdyo arayüzü/HTTP uçları (4I-E), belge yükleme (4I-F)
ve kalıcı saklama (4J) **henüz uygulanmadı**.

---

## 1. Temel ilke

> **Olgusal doğruluk yazımı sınırlar; yazımın yerine geçmez.**

Aşama 4I bir veritabanından Word'e döküm aracı **değildir**. Rapor, yetkin bir yönetici analistinin yazacağı gibi;
dönemde yapılan işi, ulaşılan sonucu, önemli gelişmeleri, engelleri ve belirsizlikleri, bunların birbiriyle
ilişkisini, yönetim dikkati gerektiren konuları ve sonraki dönem önceliklerini **özgün, bağlantılı Türkçe
düzyazıyla** anlatır. Sayılar, tarihler ve olgular cümlelerin doğal parçasıdır; anlatının yerine geçmez.

İki başarısızlık biçimi eşit derecede kabul edilemez:

1. **Mekanik rapor:** olgusal olarak doğru ama durum sayılarını art arda sıralayan, kalıp cümlelerle kurulmuş metin.
2. **Akıcı ama yanlış rapor:** okunaklı olsun diye uydurulmuş etkinlik, başarı, tarih, neden ya da karar.

Mimari ikisini birlikte önler: düzyazıyı dil modeli yazar; doğrulama yazıyı **yerinde ve orantılı** düzeltir, yok
etmez (§8).

---

## 2. Sorumluluk sınırları

| Sunucu (belirlenimci) | Dil modeli (doğrulanan yazar) | Yönetici |
| --- | --- | --- |
| Kimlik (Sicil), yetki, kapsam, rıza | Paragraflar, anlatı düzeni, geçişler | Rapor türü, dönem, kapsam, ayrıntı, odak |
| Kanıt toplama, nüfus, dönem çözümü | Kanıt üzerinden sentez ve ilişkilendirme | Bölüm düzeltme isteği, metin düzenleme |
| Aritmetik, paylar, karşılaştırma, tamlık | Kanıtla desteklenen yorum (önem, risk, koordinasyon) | Sonlandırma ve indirme |
| Tablolar, grafikler, gösterge kartları | Profesyonel dil, belirsizliğin ölçülü anlatımı | Düzenlediği metnin sorumluluğu |
| Belge biçimi, şablon, kapak, logo | Kısa tablo hücresi metni ("Güncel Durum Özeti") | — |
| Doğrulama, onarım döngüsü, kesin kapılar | Onarım isteğinde yerel yeniden yazım | — |

Model **aritmetik otoritesi değildir**, SQL üretmez, araç çağırmaz ve yetki görmez. Yazara yalnızca yetkili kanıt
paketi verilir; yazar başka veri isteyemez.

---

## 3. Uçtan uca akış

```
Yönetici isteği (tür, dönem, kapsam, ayrıntı, odak, notlar, karşılaştırma, belgeler, görseller, model)
   │  güvenilir oturumdan Sicil; yetki ve kapsam çözümü (mevcut F–H sözleşmeleri)
   ▼
4I-A  Kanıt paketi  ── sabit, parametreli SQL ve mevcut salt okunur araç sorguları; rızalı notlar;
   │                   köken, tamlık, çelişki işaretleri; kararlı kanıt kimlikleri (E1, E2 …)
   │  (4I-F) geçici belge kanıtı aynı pakete "belge" türüyle ve kökeniyle katılır
   ▼
      Bölüm planı   ── sunucu: hangi bölüm hangi kanıt kümesini anlatır; sözcük bütçesi; zorunlu açıklamalar
   ▼
4I-B  Yazar         ── nitelikli model, gerçek düzyazı + iddia eki (kanıt göndergeli)
   ▼
4I-C  Doğrulama     ── nesnel olgu denetimi (belirlenimci) · yorum desteği (denetçi/yeniden sıralayıcı)
   │   ve onarım       · yerel yeniden yazım · bütçe · nitele ya da çıkar · inceleme gerekir
   ▼
4I-D  Belge         ── kanonik şablon + sunucu tabloları/grafikleri/kartları + logo politikası → DOCX
   ▼
4I-E  Stüdyo        ── önizleme, bölüm düzeltme, metin düzenleme, sonlandırma, indirme (her içerik çıkışında yetki yeniden denetlenir)
```

Her aşama sınırlıdır: model çağrısı, SQL süresi, kanıt boyutu, onarım denemesi ve uçtan uca süre bütçeleri vardır.
Denetimsiz yeniden deneme ya da daha güçlü modele sessiz geçiş yoktur.

---

## 4. Neden Aşama 4 düzyazı sözleşmesi rapor için kullanılmaz

`src/domain/ai/groundedProse.js` sohbet yanıtları için **kapalı yuva sözleşmesidir**: model yalnızca sunucu
önermelerinin (`{P#}`) sırasını seçer; yuva dışındaki **her model sözcüğü atılır** ve kullanıcıya ulaşan her sözcük
sunucunundur (`groundedPropositions.js`, `groundedComposition.js`). Bu, kısıtlı sohbet akışı için bilinçli ve
doğru bir güvenlik tasarımıdır ve **değiştirilmez**.

Rapor için aynı sözleşme ürünün temel gereksinimini ihlal ederdi: sunucu cümlelerinden kurulmuş bir rapor,
tanım gereği mekanik bir dökümdür. Bu nedenle 4I **ayrı ve sıkı denetlenen** bir anlatı sözleşmesi (§7) kullanır:

- Sohbetin düzyazı, önerme ve kompozisyon modülleri rapor için yeniden yazılmaz, gevşetilmez ya da paylaşılan
  sınırları büyütülmez. 4I kodu kendi modüllerinde yaşar (öneri: `src/domain/ai/report/*`, `src/server/ai/report/*`).
- Rapor sözleşmesindeki gevşeklik (serbest düzyazı) sohbete sızamaz: sohbet uçları rapor yazarını çağırmaz,
  rapor yazarı sohbet profillerini (`chat.*`) kullanmaz.
- Paylaşılan olan yalnızca güvenlik ve veri katmanıdır: kimlik, yetki, kapsam, rıza, sabit SQL ve dönem çözümü.

---

## 5. Yönetici kanıt paketi sözleşmesi (`4i-kanit-1`)

Kanıt paketi, yazarın ve doğrulayıcının gördüğü **tek veri kaynağıdır**. Sunucuda kurulur ve içeriği günlüğe
yazılmaz. Her sürüm sabittir. Yetki veya rıza değişirse eski sürüm kullanılamaz (§14).
Sicil, FULL/PARTIAL/READ kararları ve yönetim kapsamı ayrı sunucu bağlamında tutulur. Model girdisine yalnızca
yetkili kanıtlar ve anlatı için gerekli kapsam/tamlık açıklamaları aktarılır.

```jsonc
{
  "sema": "4i-kanit-1",
  "istek": { "rapor_turu": "haftalik", "donem": { "baslangic": "2026-11-02", "bitis": "2026-11-08", "ad": "geçen hafta" },
             "kapsam": { "tur": "projeler", "kimlikler": ["…"] }, "ayrinti": "standart", "odak": "dengeli",
             "notlar": "dahil", "karsilastirma": "ozel_donem",
             "karsilastirma_donemi": { "baslangic": "2026-10-26", "bitis": "2026-11-01" } },
  "veri_ani": "2026-11-09T08:30:00+03:00",
  "kanitlar": [
    { "id": "E1", "tur": "olcu",    "kaynak": "rota_task_analytics", "olcu": "tamamlanan", "deger": 18, "kapsam": ["…"],
      "donem": { "baslangic": "2026-11-02", "bitis": "2026-11-08" }, "tamlik": "complete" },
    { "id": "E2", "tur": "gorev",   "kaynak": "rota_task_search", "gorev": "…", "proje": "…", "durum": "…", "hedef_bitis": "…", "gerceklesen_bitis": null },
    { "id": "E3", "tur": "not",     "kaynak": "MR_AuditLog", "gorev": "…", "kayit_zamani": "2026-11-06T16:40:00+03:00", "metin": "…", "kirpildi": false },
    { "id": "E4", "tur": "hareket", "kaynak": "rota_activity_search", "donem": { "baslangic": "2026-11-02", "bitis": "2026-11-08" },
      "donem_ozeti": { "…": "…" }, "kayit_kapsami": "partial" },
    { "id": "E5", "tur": "belge",   "kaynak": "gecici_yukleme", "dosya_turu": "docx", "bolum": "…", "metin": "…",
      "rapor_kapsami": { "tur": "projeler", "kimlikler": ["…"] }, "kayit_zamani": "2026-11-09T08:20:00+03:00" }   // yalnızca 4I-F
  ],
  "turetilmis": [ { "id": "F1", "tur": "karsilastirma", "girdiler": ["E1", "E7"], "deger": "…", "kosul": "eşit ve bitmiş dönem" } ],
  "tamlik": { "notlar": "ilk 40 not; 12 görev notsuz", "hareket": "partial", "tarihsiz_tamamlanan": 1 },
  "celiskiler": [ { "kanitlar": ["E9", "E11"], "tur": "durum_not_uyusmazligi" } ],
  "sinirlar": { "kanit_sayisi_en_fazla": 120, "karakter_en_fazla": 120000 }
}
```

Kurallar:

- **Kararlı kimlikler.** Her kanıt `E#`, her sunucu türetimi `F#` kimliği taşır; onarım turlarında değişmez.
- **Kanonik kapsam temsili.** `istek.kapsam` bütün kapsam türlerinde tek şemayı kullanır:
  `{ "tur": "<kapsam_turu>", "kimlikler": ["…"] }` (tekil kapsam türlerinde — `proje`, `kisi`, `ekip`, `birim`,
  `mudurluk`, `direktorluk` — tek elemanlı, `projeler` türünde en az bir elemanlı benzersiz dizi; paralel
  `proje`/`projeler`/`kisi`/`ekip` alanları kullanılmaz).
- **Köken.** Her kanıt güvenilir kaynak aracı ya da tabloyu (`kaynak`), görev/proje/ekip kimliğini ve zaman bilgisini
  taşır; kanıt türüyle uyuşmayan kaynak kabul edilmez. Bireysel (kişi kapsamlı) veya genel rapora eklenen
  destekleyici belgeler (`tur: belge`, `kaynak: gecici_yukleme`) belirli bir görev, proje ya da ekibe bağlı değilse
  uydurma ilişki kurulmadan `rapor_kapsami` ve yükleme zaman damgasını (`kayit_zamani`) taşır.
  Dönem temelli toplu ölçüler (`tamamlanan`, `hareket` vb.) uygulanan `donem` (`baslangic`, `bitis`) aralığını,
  anlık durum ölçüleri (`acik`, `geciken`, `yaklasan_7_gun`, `history.undatedDone`) ise paket kökündeki kanonik
  `veri_ani` kesitiyle eşleşen `veri_ani` zaman damgasını taşır; karşılaştırma ve dönem cümlesi doğrulaması bu zaman
  kökenine dayanır. Yönetici raporu yalnızca kapanmış bir raporlama dönemi için hazırlanır. `temporalWindow`
  açık (`current`) dönem döndürürse, karşılaştırma isteği olmasa da kanıt paketi oluşturulmadan istek reddedilir.
  Kapanmış dönemde paket kökündeki `veri_ani` son raporlama gününü tam kapsar ve gelecek zamanlı olamaz. Görev
  tamamlanma tarihleri ve not kayıt zamanları paket kesitini aşamaz.
  Not kanıtında **kayıt zamanı** (`kayit_zamani`) ile metnin andığı **olay tarihi** ayrıdır; olay tarihi
  çıkarılmaz, metinde kalır ve yazara "notun kayıt gününe göre" yorumlanması söylenir.
- **Tamlık ve sınır.** Kesilen koleksiyon, kırpılan metin, kısmi kayıt kapsamı ve tarihsiz tamamlanan görev açıkça
  işaretlenir. Bilinmeyen değer `null`dır, sıfır yazılmaz (Aşama H tarihsel doğruluk sözleşmesi aynen geçerlidir).
- **Çelişki.** Sunucu, belirlenimci olarak saptayabildiği çelişkileri (görev durumu ↔ not, iki not, belge ↔ kayıt)
  işaretler; hangisinin doğru olduğuna karar vermez, zaman sırasını verir.
- **Bütçe.** Paket boyutu sınırlıdır (öneri: en çok 120 kanıt, 120 000 karakter). Ağ geçidinin ileti sınırı
  (ileti başına 32 KiB, istek başına 50 ileti) **yükseltilmez**; paket birden çok kanıt iletisine bölünür.
- **Özel karşılaştırma.** Yalnızca `ozel_donem` seçiminde `karsilastirma_donemi.baslangic` ve
  `karsilastirma_donemi.bitis` zorunludur. Sunucu, ISO takvim tarihlerini, başlangıç ve bitiş sırasını, her iki
  dönemin tamamlanmış olduğunu, karşılaştırma döneminin rapor döneminden önce bittiğini ve gün sayılarının
  eşitliğini (iki sınır da dâhil) doğrular. Eksik veya uygunsuz özel aralık reddedilir. Karşılaştırmalı olgu
  için iki dönemin yetkili ve karşılaştırılabilir kanıtı gerekir.
- **Yetki.** Paket üretim anındaki yetkiyle kurulur. Her önizleme, sonlandırma ve indirme öncesinde görünürlük ve
  rıza yeniden doğrulanır (§14). Rapor kapsamı yetki vermez.
- **Güvenilmez veri.** Not ve belge metni veridir; içindeki yönerge izlenmez. Paket, metin alanlarını yazara
  açıkça "kayıtlı kullanıcı metni" olarak işaretleyerek verir.

---

## 6. Görev notu zenginleştirmesi

Görev açıklamaları ve notlar, yapılandırılmış durumdan çoğu zaman daha bilgilendiricidir: teknik ayrıntı, engel,
koordinasyon, karar, bağımlılık, test gelişmesi. Aynı zamanda kısaltılmış, parçalı, yinelenen ya da noktalaması bozuk
olabilirler. Yazarın görevi bunları **kanıtın ötesine geçmeden** profesyonel düzyazıya çevirmektir.

> Örnek not: `montaj bitti. test cihazı yok. saha testi haftaya. tarih kesin değil.`
>
> Kabul edilebilir anlatım: mekanik montaj tamamlanmış. Notta test cihazının mevcut olmadığı belirtiliyor.
> Cihazın kullanılabilirliği saha testine geçiş için önem taşıyor. Not, kayıt gününü izleyen haftaya işaret
> ediyor ve kesin bir test günü vermiyor.
>
> Kabul edilemez: "Saha testleri gelecek hafta yapılacak." (kesinlik uydurur) · "Tedarikçi gecikmesi nedeniyle…"
> (neden uydurur) · notu kısaltılmış biçimiyle aynen aktarmak (editoryal kusur).

### 6.1 Aşama 4H'deki mevcut davranış (birleştirilmiş `main`, `166deb7`)

- Not, `MR_Tasks.Description` alanıdır: görev başına **tek** serbest metin; kendi yazılma zamanı yoktur
  (`UpdatedAt` görevin her değişikliğinde değişir).
- `notes` analiz yönü (`src/server/ai/tools/analysisPlan.js`, `NOTE_LIMITS.tasks = 10`) kapsamdaki **yalnızca açık**
  ve açıklaması olan görevleri okur; en son güncellenen **10 görev**, `rota_task_search` sayfası üzerinden.
- Not metni ayrı sabit sorguyla (`AI_TOOL_TASK_NOTES_SQL`) ilk boşluk olmayan karakterden itibaren **400 kod
  noktasına** kırpılır (401. karakter kırpılmayı gösterir); tek görev ayrıntısı 1600 karakter okur.
- Dönem bu okumaya **uygulanmaz** (açıklamanın yazıldığı gün kayıtlı değildir).
- Rıza **ileti başınadır** ("Notlar ve iletiler" anahtarı, `includeText`); model veri görmeden `textFields` seçer.
- Hareket kaydındaki değişiklik metni (önce/sonra) not özetine katılmaz; tek görev/proje için `changes` seçimiyle
  okunur. `MR_AuditLog` açıklamanın önce/sonra değerlerini `OccurredAt` zamanıyla tutar.
- Not teması etiketlenmez; notlar alıntıdır, doğrulanmış neden değildir.

### 6.2 Yönetici raporu için sınırlar

1. **Tamamlanan iş görünmez.** Dönemde tamamlanan görevlerin notları ("ne başarıldı") okunmaz; yalnızca açık işler.
2. **Örneklem çok dar.** 10 görev, çok projeli ya da müdürlük raporunda dönemin önemli gelişmelerini kaçırır.
3. **Zaman bilgisi yok.** Notun ne zaman yazıldığı bilinmediği için "haftaya", "dün" gibi göreli ifadeler
   çözülemez ve eskimiş not güncel sanılabilir.
4. **Kırpma.** 400 karakter teknik notun karar ve bağımlılık kısmını kesebilir.
5. **Çelişki ve yineleme ayrımı yok.** Aynı gelişmeyi anlatan notlar ya da birbirini geçersiz kılan notlar ayrılmaz.
6. **Rıza modeli sohbete göredir.** Rapor tek bir uzun işlemdir; ileti başına rıza, rapor isteği başına rızaya
   karşılık gelir ama aynı bayrakla taşınamaz.

### 6.3 4I-A için gerekli değişiklikler (bu artımda UYGULANMADI)

- **Rapor düzeyi rıza:** rapor isteğinde açık `notlar: dahil` seçimi; yalnız o rapor için geçerli; Stüdyo'da
  görünür; rıza yoksa hiçbir not ya da değişiklik metni okunmaz.
- **Kapsam:** dönemde **tamamlanan** görevler + dönemde **hareket gören** açık görevler + yaklaşan/geciken
  kritik görevler. Yalnızca açık görevlere dayanmaz.
- **Kayıt zamanı:** açıklamanın dönem içindeki sürümleri `MR_AuditLog` önce/sonra değerlerinden okunur; denetim
  kaydındaki `OccurredAt` yalnızca o olayla yazılan **yeni (`sonra`)** not sürümünün `kayit_zamani` değeridir.
  Değiştirilen **önceki (`önce`)** metne değiştirme olayının zamanı atanmaz; önceki sürümün zamanı onu oluşturan
  daha eski denetim kaydından alınır, böyle bir kayıt yoksa `"kayıt zamanı bilinmiyor"` olarak işaretlenir. Denetim
  kaydı olmayan eski açıklama da `"kayıt zamanı bilinmiyor"` olarak işaretlenir.
- **Önceliklendirme (belirlenimci):** dönem ilgisi (dönemde yazılmış/güncellenmiş) → yönetim önemi (kritik/yüksek
  öncelik, gecikme, kilometre taşı, bağımlılık) → yenilik. Örneklemin büyüklüğü ve dışarıda kalan sayısı
  tamlık alanında söylenir.
- **Kırpma ve bütçe:** not başına en çok 1600 karakter (mevcut ayrıntı sınırı), toplam not bütçesi kanıt paketi
  sınırı içinde; kırpma işaretlenir.
- **Yineleme ve çelişki:** aynı görevin ardışık sürümleri zaman sırasıyla verilir; çelişkiler işaretlenir.
- **İlişki:** her not görev, proje ve zaman ilişkisini korur; kullanıcının gözlemi bağımsız doğrulanmış neden
  olarak işaretlenmez.
- **Gizlilik:** not metni günlüğe, telemetriye ya da başka kullanıcının bağlamına girmez; rapor kanıt paketi
  kalıcı olarak saklanmaz, tekil rapor isteği tamamlandığında veya iptal edildiğinde bellekten serbest bırakılır.
  Etkileşimli Stüdyo oturumu boyunca yeniden kullanım gerekiyorsa not kanıt paketi de §12'deki geçici belge
  kurallarıyla aynı temizlik tetikleyicilerine (sonlandırma, iptal veya en fazla 60 dakikalık süre aşımı) tabidir
  ve süre dolduğunda bellekten silinir.

**Regresyon riskleri ve korumaları:** Sohbetin `notes` yönü, `NOTE_LIMITS`, ileti başına rıza ve araç şemaları
**değişmez**; rapor not okuması ayrı sabit sorgu ve ayrı sınırlarla yapılır. Riskler: (a) paylaşılan SQL parçalarının
(`visibleTasks`, `DESCRIPTION_PRESENT_SQL`) değişmesiyle sohbet görünürlüğünün kayması → yalnızca yeni sorgu
eklenir, mevcutlar düzenlenmez; (b) denetim kaydı okumasının Görev Hareketleri gizlilik kuralını (silinmiş/taşınmış
görev, gizli proje) atlaması → aynı çapa tabanlı yetki kuralı kullanılır ve sınanır; (c) büyük not hacminin SQL
süresini ve kanıt boyutunu aşması → satır ve karakter sınırı, zaman aşımı; (d) not içi istem enjeksiyonu → veri
işaretleme ve 4I-C doğrulaması.

---

## 7. Anlatı yazım sözleşmesi (`4i-yazim-1`)

### 7.1 Girdi

- Sistem yönergesi: kurumsal ton, anlatı standartları ve yasaklar (stil belgesi `anlati`), dört iddia sınıfı,
  belirsizlik dili, güvenilmez veri kuralı. Kararlı ve önbelleğe alınabilir önek.
- Bölüm planı (sunucu): bölüm kimlikleri, her bölüme ayrılan kanıt kimlikleri, ayrıntı düzeyine göre sözcük
  bütçesi, zorunlu açıklamalar (ör. kısmi kayıt, tarihsiz tamamlanan).
- Yetki bağlamı hariç kanıt paketi (§5), en çok 32 KiB'lık kanıt iletilerine bölünmüş. Aynı sınır onarım,
  yeniden sıralama ve bağımsız denetim girdileri için geçerlidir.

### 7.2 Çıktı

Yazar **gerçek düzyazı** üretir. Çıktı yapılandırılmıştır ama metin serbesttir:

```jsonc
{
  "sozlesme": "4i-yazim-1",
  "bolumler": [
    { "kimlik": "yonetici_degerlendirmesi",
      "paragraflar": [ { "metin": "Kasım ayının ilk tam çalışma haftası …", "kanitlar": ["E1", "E3", "F1"] } ],
      "one_cikan_tespit": { "metin": "…", "kanitlar": ["E9"] } }
  ],
  "iddialar": [
    { "bolum": "yonetici_degerlendirmesi", "paragraf": 1, "alinti": "18 görev tamamlanırken",
      "sinif": "nesnel_olgu", "kanitlar": ["E1"] }
  ]
}
```

- Paragraf metni **sunucu tarafından yeniden kurulmaz**; yalnızca doğrulanır ve gerekirse yerel olarak onarılır.
- `kanitlar` ve `iddialar` doğrulayıcıya yardımcı göndergedir, gerçeğin kanıtı değildir: yazarın beyanı
  doğrulamayı **daraltmaz** (beyan edilmemiş sayı, tarih ve ad da denetlenir).
- Sayı ve tarih Türkçe biçimiyle yazılır ("18 görev", "5 Kasım 2026", "2–8 Kasım 2026"); sunucu karşılaştırmada
  biçim normalleştirir (rakam/yazı, tarih aralığı).
- Tablo, grafik ve kart **çıktıda yoktur**; yazar onlara "Şekil 1'de görüldüğü gibi" diye gönderme yapabilir,
  sayılarını yeniden üretmez.

### 7.3 Dil standartları

Stil belgesindeki `anlati` bölümü bağlayıcıdır: yetkin yönetici analisti tonu; bağlantılı ve dolu paragraflar
(tipik olarak 3–7 cümle); sentez ve kanıta dayalı yorum; somutluk; yinelenen kalıp giriş ve kapanışların, veritabanı
dökümü dilinin, suç atfının ve genel geçer değerlendirmenin yasaklığı. **Kurumsal tutarlılık aynı biçim demektir,
aynı cümleler değil:** bölüm başlıkları sabittir (yalnızca stil belgesinde açıkça ilan edilen kapsam değişkenleri,
ör. bireysel raporda `baslik_kisi`, izinli sayılır); cümleler her raporda kanıta göre özgündür.

### 7.4 Uygulama (4I-B, 25.11.2026)

| Bileşen | Dosya | Sorumluluk |
| --- | --- | --- |
| Bölüm planı | `src/domain/ai/report/reportSectionPlan.js` | Stil belgesinden doğrulanan yazar alt kümesi (`requireWriterStyle`); model bölümleri, başlıklar (`baslik_kisi` dâhil), ayrıntı düzeyine göre sözcük bütçesi (`anlati.bolum_plani`), bölüm başına öncelikli kanıt, kaldırılamaz bütünlük açıklamaları |
| Yazar istemi | `src/domain/ai/report/reportWriterPrompt.js` | Kararlı sistem yönergesi (`yazar-istemi-4`), plan iletisi, ≤ 32 KiB (UTF-8 bayt) kanıt iletileri, plandan türetilen çıktı iskeleti (kapanış iletisi) |
| Taslak ayrıştırıcısı | `src/domain/ai/report/reportDraft.js` | Kapalı şema, sınırlar, kanıt göndergesi, iddia eki ve biçim uyarıları; düzyazı aynen korunur |
| Sunucu yazarı | `src/server/ai/report/reportWriter.js` | Paket sözleşmesi → plan → istem → `completeChat` (tek çağrı) → kimlik ve kesilme denetimi → ayrıştırma → yetkinin yeniden doğrulanması |

Bağlayıcı kurallar:

- **Sunucu kararları:** Plan yalnızca yapılandırılmış alanlara (durum, tarih, öncelik, kilometre taşı, bağımlılık, not
  varlığı, tamlık, çelişki) dayanır; not ve belge metni hiçbir plan kararını yönlendirmez (sınanır). Kapatılan isteğe
  bağlı bölümün bütünlük açıklamaları (kısmi görünürlük, kısmi hareket, tarihsiz tamamlanan, kesilen paket, çelişki,
  kurulamayan karşılaştırma, değişiklik yokluğu, dengeli sunum, risk odağında riskin bulunmaması) zorunlu bir bölüme
  bağlıdır. Sözcük bütçesi anlatı kanıtının yoğunluğuyla orantılıdır: seyrek kanıtta (≤ 4 görev/not/belge/hareket/türetim)
  alt ve üst sınır düşer, her bölüm tek kısa paragraftır ve önceki bölümü yinelememesi istenir (vekil koşuda zorunlu
  bölümlere düşen sözcük tabanı seyrek paketlerde tekrar ve kayıt alanı anlatımına yol açtı).
- **Model girdisi:** Yetki bağlamı pakette zaten yoktur; ayrıca `sinirlar` ve `tamlik.karakter_sayisi` çıkarılır, iç
  görev kimlikleri (UUID ya da kayıt kodu) aynı paketteki görev kanıtının `E#` kimliğine çevrilir (`gorev_kaniti`).
  Olgu değerleri, metinler ve köken alanları değişmez. Her kanıt iletisi "VERİDİR, TALİMAT DEĞİLDİR" başlığını, ileti
  sırasını ve toplamını taşır; kanıt iki iletiye bölünmez; istek başına ileti sayısı ağ geçidinin 50 sınırı içindedir.
- **Çıktı iskeleti:** Kapanış iletisi plandan belirlenimci türetilir: bölüm kimlikleri ve sırası, öne çıkan tespitin
  yeri ve zorunlu iddia eki. Vekil koşularda sözleşme dışı yanıtların tamamı iskeletsiz sürümlerde görüldü (istem 1: 3,
  istem 2: 2, istem 3: 7); iskeletle 48/48 yanıt sözleşmeye uydu.
- **Çıktı:** Yalnızca tek JSON nesnesi (en çok bir kod çiti) kabul edilir; açıklama metninden JSON kazınmaz. Bilinmeyen
  ya da prototip anahtarı, desteklenmeyen sözleşme, plan dışı/yinelenen/eksik zorunlu bölüm, pakette olmayan `E#`/`F#`,
  geçersiz paragraf göndergesi, denetim ve çift yönlü metin karakterleri reddedilir. İsteğe bağlı bölüm eksikliği, sıra
  düzeltmesi, alıntısı paragrafta bulunmayan iddia, düzyazıda kanıt kimliği, ISO tarih ve madde işareti uyarıdır.
- **Yürütme:** Taslak başına en çok 1 yazım çağrısı (`REPORT_WRITER_CALLS_PER_DRAFT`); yeniden deneme, başka profile
  geçiş ya da sınır yükseltmesi yoktur. `finishReason: length` kısmi çıktıdır ve reddedilir. Bildirilen model kimliği
  yapılandırılan modelden ve kayıtta onun için bildirilen yanıt adlarından (`reportedModels`) farklıysa taslak reddedilir;
  kimlik bildirilmemişse taslak doğrulanmamış işaretlenir. Çıktı belirteci isteği akıl yürüten modellerin düşünme payını
  içerir (vekil koşuda düşük efor bile 20–42 bin düşünme belirteci harcadı) ve ağ geçidinde profil sınırıyla daraltılır.
  İçerik ancak çağıranın verdiği `revalidate` denetimi açıkça `true` dönerse döner; yoksa `AUTHORIZATION_CHANGED`.
- **Stil belgesinin çalışma zamanı okuması (§16):** Yazar ayrıştırılmış stil belgesini parametre olarak alır; `src`
  altında stil dosya yolu geçmez (4I-0 sınır sınaması). `js-yaml` geliştirme bağımlılığı olarak kalır; çalışma zamanı
  yükleyicisi 4I-D/4I-E'de uç bağlanırken kararlaştırılır.
- **Kanıtlanmamış iddia eki:** `iddialar` yazarın beyanıdır; 4I-B kıyasında nesnel değerlendirme düzyazının kendisinden
  yapılır, 4I-C doğrulayıcısı da beyanla daralmaz.

---

## 8. Orantılı doğrulama ve yerel onarım

### 8.1 İddia sınıfları

| Sınıf | Örnek | İşlem |
| --- | --- | --- |
| **Nesnel olgu** | sayı, tarih, proje/kişi kimliği, görev durumu, hesaplanan ölçü, kayıtlı olay | Kanıt defterine karşı **belirlenimci** doğrulama zorunlu |
| **Desteklenen yorum** | önem, beliren risk, koordinasyon ihtiyacı, yönetim sonucu | Kanıtla desteklenebiliyorsa izinli; birebir veritabanı ifadesi aranmaz; çıkarım kesin olgu gibi yazılmaz |
| **Editoryal dil** | geçiş, cümle yapısı, sözcük, ritim, paragraf düzeni | Modelindir; tek tek kanıt atfı istenmez |
| **Desteksiz maddi iddia** | uydurma etkinlik, sahte başarı, uydurma tarih, desteksiz neden, hayali karar | Kesin olgu olarak **yayımlanmaz** |

### 8.2 Denetim katmanları

1. **Belirlenimci nesnel denetim (her zaman):** düzyazıdan sayı, yüzde, tarih/aralık, proje ve kişi adları, durum
   sözcükleri çıkarılır; her biri kanıt defterindeki bir değere ya da türetime bağlanmalıdır. "Şekil 1" veya
   "Tablo 1" gibi görsel/tablo göndermelerindeki sıra numaraları kanıt defteri yerine sunucunun belge/şekil planına
   karşı doğrulanır (planda olmayan uydurma şekil/tablo göndermesi yine reddedilir). Kanıt paketinde bulunmayan
   proje/kişi adı **kesin kapıdır** (uydurma ya da yetkisiz varlık).
2. **Anlamsal destek denetimi (zorunlu):** Her maddi ifadenin yetkili kanıtla ilişkisi doğrulanır. Nitelikli
   bağımsız denetçi kullanıldığında model fiilî yazardan farklıdır. Denetçi dört iddia sınıfını ve kanıt
   göndergelerini döndürür. Sunucu bu çıktıyı doğrular ve onarım sinyali olarak kullanır. Kanıt seçimi için
   belirlenimci eşleştirme temel yoldur. İsteğe bağlı toplu yeniden sıralama, doğrulama çağrılarına gerekecek
   pay ayrıldıktan sonra kalan bütçeyi kullanır. İlk denetim ve onarım sonrası denetim dâhil, denetçi ve yeniden
   sıralayıcı toplamda en çok iki çağrı kullanır (en çok 1 ilk taslak denetimi + onarılan bütün paragrafları tek
   seferde kapsayan en çok 1 toplu onarım sonrası denetim).
3. **İnsan incelemesi:** Bağımsız denetçi kullanılamadığında eşdeğer kanıta dayalı denetim veya yetkili insan
   incelemesi gerekir. Bu inceleme tamamlanana kadar dışarı dönen taslakta doğrulanamayan maddi iddianın
   yerine inceleme işareti gösterilir. İddia ancak destek doğrulanınca veya kanıtla uyumlu biçimde nitelenince
   kullanılabilir. Çözülemeyen kritik sorun sonlandırmayı engeller.

Doğrulama **birebir cümle eşleşmesi aramaz**. Editoryal dil için kanıt istenmez; yorum için kanıtın desteği yeterlidir.

### 8.3 Onarım döngüsü

```
her sorun için:  tespit → yerini belirle (bölüm, paragraf, cümle)
                 → yazara YALNIZCA o paragrafı, sorunun açıklamasını ve ilgili yetkili kanıtı ver
                 → yerel yeniden yazım (çevredeki doğrulanmış paragraflar değişmez)
                 → her denemede belirlenimci denetim (0 çağrı); anlamsal sorunlar için toplu 1 onarım sonrası model denetimi
                 → bütçe: paragraf başına en çok 2 (anlamsal model denetimi gerektirenlerde ortak 2 çağrı tavanı içinde en çok 1), rapor başına 8 deneme
bütçe veya 2 çağrılık denetim tavanı tükenirse:
                 yeni yeniden yazım denenmez; ifade kanıta uygun NİTELENİR ya da yalnızca o ifade ÇIKARILIR; paragrafın geri kalanı korunur
kritik sorun çözülemezse: geçerli taslak korunur, sorunlu yer işaretlenir, rapor İNCELEME GEREKTİRİR
```

Asla yapılmayanlar: tek bir ifade için bütün raporun reddedilmesi; paragrafın hazır sunucu metniyle sessizce
değiştirilmesi; akıcılık için uydurma olguya izin verilmesi; bilinen bir yanlışla raporun sonlandırılması.

**Kesin kapılar:** güvenlik ihlali, yetkisiz açıklama, çözülemeyen kritik olgu hatası. Bunlar onarılamazsa rapor
yayımlanamaz ama taslak kaybolmaz.

---

## 9. Model rolleri ve nitelendirme politikası

### 9.1 Katalog uzlaştırması (21.11.2026)

Kaynak: platform model ekranının en üstten ve en alttan iki görüntüsü (satırları örtüşüyor). Simge kuralı mevcut
kayıtla aynıdır: beyin = `reasoning`, katman = `tools`, görsel = `vision`; "128K/256K/512K" ikili kuvvetle yazılır.

| Kimlik | Kayıttaki yetenek / bağlam | Kanıt düzeyi | Not |
| --- | --- | --- | --- |
| `DeepSeek-V4.1-Flash-1017` | chat, tools, reasoning, vision / 524288 | Kimlik ve yetenek ekranda **doğrulandı**; bağlam ikili yazımla **çıkarım** | Eski kayıt kimliği `DeepSeek-V4.1-Flash` yerine; canlı `GET /models` doğrulaması **bekliyor** |
| `Qwen3.8-Flash-Next-FP8` | chat, tools, reasoning, vision / 262144 | Aynı | Eski `Qwen3.8-Flash-Next` yerine; FP8 nicemleme kimlikte; canlı doğrulama **bekliyor** |
| `openai/gpt-oss-120b` | chat, tools, reasoning / 131072 | Doğrulandı | Değişmedi |
| `Qwen3-Next-80B-A3B-Instruct` | chat, tools / 262144 | Ekranda kısaltılmış ad; önceki kayıtla tutarlı | `chat.fast/general/tools` profili; değişmedi |
| `gemma-4-31B-it` | chat, tools, reasoning, vision / 131072 | Doğrulandı | `chat.reasoning`, `chat.tools.reasoning`; değişmedi |
| `Qwen3-VL-8B-Instruct` | chat, vision / 32768 | Doğrulandı | `vision`; değişmedi |
| `Qwen3-Embedding-8B`, `intfloat/multilingual-e5-large` | embedding | Doğrulandı (e5 kısaltılmış ad) | Değişmedi |
| `Qwen3-Reranker-8B` (32768), `bge-reranker-v2-m3` (8192) | rerank | Doğrulandı | Değişmedi |
| `FLUX.2-dev`, `whisper-large-v3`, `VoxCPM2`, `tts-1`, `tts-1-hd` | image / stt / tts | Doğrulandı | Değişmedi |
| `Qwen3.8-27B`, `Qwen3.6-35B-A3B` | (önceki kayıt) | **Ekranlarda görünmedi** | Yalnızca görünmedikleri için silinmedi; aday değil; canlı doğrulama bekliyor |
| `laya-multilingual` | — | Ekranda ayrı uç türüyle görüldü | Yeteneği kayıt sözlüğüyle eşleşmediği için **kayda alınmadı** |

Sohbet profil eşlemeleri **değişmedi**. Değişiklik yalnızca iki kimliğin tam yazımıdır
(`config/ai-model-registry.onprem.json`, `src/server/ai/defaultModelRegistry.js`, ilgili kayıt sınamaları ve
[Yapay Zekâ Platformu §5](YAPAY-ZEKA-PLATFORMU.md)). Sistem Yönetimi bağlantı testi yalnızca profillere bağlı
modelleri uç listesinde arar; profilsiz modellerin kimliği kurum içinde `GET /models` yanıtıyla ayrıca
karşılaştırılmalıdır.

### 9.2 Roller

Roller stil belgesinin `model_politikasi.roller` alanında **yapılandırma** olarak tanımlıdır; iş kodunda model adı
geçmez (mevcut mimari sınaması bunu sohbet kodu için zaten zorunlu kılar).

| Rol | Amaç | Gerekli yetenek | En az bağlam |
| --- | --- | --- | --- |
| `rapor_yazari_otomatik` | Varsayılan yazar (kalite ve süre dengesi) | chat | 131072 |
| `rapor_yazari_yuksek_kalite` | En yüksek kaliteli yazar (daha uzun süre kabul edilir) | chat | 131072 |
| `rapor_yazari_kullanici_secimi` | Yöneticinin seçebileceği nitelikli yazarlar | chat | 131072 |
| `kanit_yeniden_siralama` | Doğrulamada cümleye en ilgili kanıtı öne alma | rerank | 8192 |
| `bagimsiz_denetci` | Kullanıldığında fiilî yazardan farklı olan iddia denetçisi | chat | 131072 |

Yazar adayları: `DeepSeek-V4.1-Flash-1017`, `Qwen3.8-Flash-Next-FP8` ve taban olarak bugün üretimde çalışan
`gemma-4-31B-it`, `Qwen3-Next-80B-A3B-Instruct` ile `openai/gpt-oss-120b`. Yeniden sıralayıcı adayları:
`Qwen3-Reranker-8B`, `bge-reranker-v2-m3`.

**Etkin olmak nitelik değildir.** Hiçbir model, kıyas protokolünü önceden tanımlanmış eşiklerle geçmeden
`nitelikli_modeller` listesine ya da `secili` alanına yazılmaz (bugün hepsi boştur; belirlenimci sınama bunu
korur). Hangi modelin "en yetenekli" olduğu ölçülmeden söylenmez.

### 9.3 Seçim kuralı ve gelecekteki model değişiklikleri

- Bütün **A** (güvenlik/olgu) kapılarını geçen adaylar arasında: `rapor_yazari_otomatik` = **B** ortalaması eşiği
  geçen ve **D** süre eşiğini karşılayanların en yüksek B puanlısı; eşitlikte düşük p95 süre.
  `rapor_yazari_yuksek_kalite` = en yüksek B puanlısı (süre üst sınırı içinde). Ayrıntı:
  [Kıyas ve Kabul Çerçevesi §5](BILGIN-4I-KIYAS-VE-KABUL-CERCEVESI.md).
- 4I-B rapor profillerini (`report.writer`, `report.writer.quality`) profil sözlüğüne sohbet profillerinden ayrı
  (`AI_REPORT_PROFILES`) ekledi; **eşlemeleri nitelendirmeden sonra** kayda yazılır (bugün hiçbir kayıtta eşli değil,
  çağrı `AI_CONFIGURATION_ERROR` ile kapalı kalır). `report.review` 4I-C'de eklenecektir. Profil → model eşlemesi veridir. Yeni model geldiğinde: kayda eklenir → kıyas koşulur
  → geçerse role yazılır. İş kodu değişmez.
- Stüdyo'daki model seçici yalnızca `nitelikli_modeller` listesini gösterir. Otomatik, yüksek kalite ve yönetici
  seçimi için denetçinin bağımsızlığı fiilen kullanılan yazar modeline göre değerlendirilir. Aynı model
  eşleşmesinde §8.2'deki güvenli inceleme yolu uygulanır.

---

## 10. Kurumsal belge standardı ve şablon

- **Tek doğruluk kaynağı:** `config/ai/bilgin_rapor_stili.yaml`. Şablon onu yansıtır; uyum
  `test/ai-executive-report-foundation.test.mjs` ile denetlenir (sayfa, kenar, stil adı ve özellikleri, renk, yazı
  tipi, yer tutucu kümesi ve sırası, sabit metinler, bölüm başlıkları, belge özellikleri, kapak varlıkları).
- **Sayfa:** A4 dikey, 25,4 mm kenar boşlukları; kapakta üst/alt bilgi yok; gövdede üst bilgi (rapor türü, dönem)
  ve alt bilgi ("Kurum İçi Yönetim Raporu", "Sayfa X / Y").
- **Renk:** ana lacivert `#003087`, vurgu turuncu `#FF5620` (lacivertin en çok 1/4'ü), kılavuzdaki yüzde tonlar
  ve destek renkleri (`#077780`, `#FF8022`, `#EBEBEE`); metin için akromatik nötrler. Kılavuzdaki `#002D7A`
  yazımı tanımlı CMYK/RGB/Pantone/RAL değerleriyle çeliştiğinden yetkili değer `#003087` kabul edildi.
- **Yazı tipi:** stiller yazı tipini tema üzerinden (başlık = major, gövde = minor) alır; etkin profil Calibri'dir.
  Nexa, iki aile üyesi bütün hedef istemcilerde kuruluysa ya da lisansa uygun biçimde gerçekten DOCX'e gömülüp
  Nexa kurulu olmayan hedef Word ortamında açılış ve sayfalama doğrulanırsa tema üzerinden seçilebilir.
  Bu koşullardan biri sağlanana kadar Calibri kullanılır.
- **Kapak:** lacivert zemin ve sağ altta kırpılmış yedigen çizgileri. Yedigen, `src/components/ui.jsx`
  içindeki `HEPT_PATHS` yollarından **aynen** üretilmiştir (renk eşlemesi: teal → `#077780`, orange → `#FF5620`);
  şablonda vektör SVG ve aynı görüntünün PNG yedeği bulunur. Resmî logo taklit edilmez (§11).
- **Bölümler (sabit sıra):** 01 Yönetici Değerlendirmesi · 02 Dönemin Öne Çıkan Gelişmeleri · 03 Proje Faaliyetleri
  ve İlerleme · 04 Riskler, Engeller ve Bağımlılıklar · 05 Önümüzdeki Dönem Öncelikleri · 06 Genel Sonuç ve
  Değerlendirme · Kaynak ve Yöntem Notu (kaldırılamaz) · Ekler (isteğe bağlı).
- **Yer tutucular:** `{{AD}}` biçiminde, her biri tek bir Word metin parçasındadır. Sahibi (sunucu/model/kullanıcı)
  ve türü stil belgesindedir. Tablo satırı (`SATIR_*`) sunucu tarafından çoğaltılan satır şablonudur.
- **Görseller:** tablo, grafik ve kartlar sunucunundur ve aynı yetkili olgu kümesinden üretilir. Grafik biçimi
  4I-D'de kesinleşir; tercih önbellekli veriyle Word'ün yerel DrawingML grafiğidir (yeni bağımlılık ve
  rasterleştirme gerektirmez). Görsel kabulde bütün sayfalar gerçekten incelenir.
- **Şablonun değiştirilmesi:** stil belgesi ve şablon **aynı commit'te** güncellenir; sürüm alanları birlikte
  artırılır; uyum sınaması geçmeden değişiklik kabul edilmez.

---

## 11. Logo varlık sözleşmesi

- **Mevcut mekanizma korunur:** `MERGEN_ROTA_COMPANY_LOGO_PATH` ve `src/server/branding/companyLogo.js` açılış
  ekranındaki açık renkli logoyu sunar; davranışı değişmez.
- **İki varyant:** `koyu_zemin` (açık renkli logo; mevcut ayar; lacivert kapakta kullanılabilir) ve `acik_zemin`
  (beyaz zemin logosu; öneri ayar adı `MERGEN_ROTA_COMPANY_LOGO_LIGHT_BACKGROUND_PATH`; **dosya henüz sağlanmadı**).
- **Kaynak kuralları:** yalnızca sunucu okur; mutlak dosya yolu (UNC/Windows/yerel bağlama yolu); yalnızca `.svg`;
  en çok 1 MiB; düzenli dosya. Rapor üreticisi **ağdan logo indirmez** (eski `NEXT_PUBLIC_…_URL` HTTPS biçimi
  belgede kullanılmaz). Yol tarayıcıya gönderilmez; kullanıcı dosya adı seçemez; genel dizin ya da CDN yoktur.
  SVG'de `script`, `foreignObject`, olay öznitelikleri ve dış başvurular reddedilir. Word için PNG yedeği 4I-D'de ya
  aynı adlı onaylı PNG dosyasından ya da ağsız, gerekçeli bir rasterleştirmeden gelir.
- **Yeni uç yok:** logo belgeye sunucuda gömülür; 4I-0 ve 4I-D yeni logo ucu eklemez.
- **Eksik logo:** alan boş bırakılır; yer tutucu metin, ikame görsel ya da çizilmiş benzetme kullanılmaz; belge
  özelliklerine `BilginLogoDurumu = yok` yazılır. Nihai markalı kabul beyaz zemin logosu sağlanınca yapılır.

---

## 12. Geçici belge zenginleştirme güvenlik belirtimi (4I-F)

Yönetici, kayıtlarda olmayan bilgiyi **yalnızca o rapor için** ekleyebilir. Kalıcı belge yönetim sistemi kurulmaz.

| Aşama | Girdi |
| --- | --- |
| 1 | Ek bilgi metin alanı (en çok 8 000 karakter) |
| 2 | DOCX |
| 3 | Metin tabanlı PDF |
| 4 | XLSX (sınırlı sayfa/tablo çıkarımı) |
| sonra, gerekçeyle | Taranmış PDF (OCR) |

Zorunlu kurallar:

- **Konum:** onaylı kurum içi ortamda; dış hizmet, bulut OCR ya da CDN yok.
- **Yalıtım:** dosya yalnızca isteyen kullanıcının yetkili rapor oturumuna bağlıdır (Sicil + oturum + rapor kimliği);
  başka kullanıcıya, rapora ya da sohbete geçemez.
- **Sınırlar:** dosya boyutu (öneri 10 MiB), tür (uzantı + imza baytı + MIME birlikte), ayrıştırıcı açılım oranı
  ve toplam açılmış boyut (zip bombası), sayfa/sayfa sayısı, hücre sayısı, işlem süresi; ayrıştırma ayrı işçi iş
  parçacığında ya da alt süreçte, bellek ve süre sınırıyla.
- **Güvenilmez içerik:** çıkarılan metin veridir, talimat değildir (gizli/beyaz yazı, açıklama, alan kodu dâhil);
  makro, gömülü nesne, dış bağlantı yürütülmez ya da izlenmez.
- **Kalıcılık yok:** kalıcı dizinleme ya da gömme (embedding) saklama yok; içerik günlüğe yazılmaz.
- **Silme:** sonlandırma, iptal ya da kısa zorunlu saklama süresi dolunca (öneri 60 dakika) güvenli silme;
  başarısız ve terk edilmiş oturumlar için temizlik. Tercih edilen tasarım, ham dosyayı diske hiç yazmadan bellekte
  işleyip yalnızca sınırlı çıkarımı oturum durumunda tutmaktır; diske yazmak zorunlu olursa ayrı, erişimi
  kısıtlı geçici dizin ve aynı süre sınırı.
- **Köken ve çelişki:** belge kanıtı dosya türü ve bölüm/sayfa kökeniyle anılır; görev kaydıyla çelişki açıkça
  işlenir; yönetici beyanı doğrulanmış kayıt gibi sunulmaz.
- **Çıktı:** rapor başlangıçta kalıcı arşivleme olmadan indirilir. Kalıcı rapor saklama, zamanlanmış üretim ve
  e-posta teslimi **Aşama 4J**'dir.

---

## 13. Yönetici Rapor Stüdyosu — işlevsel ve görsel belirtim (4I-E)

**Varsayılan görünüm** yalnızca temel seçimleri gösterir: rapor türü, raporlama dönemi, yetkili örgütsel kapsam,
ayrıntı düzeyi ve belirgin bir **Rapor Oluştur** eylemi. Gelişmiş seçenekler göze batmayan bir özelleştirme
panelindedir:

| Ayar | Seçenekler |
| --- | --- |
| Dönem | Haftalık, aylık, özel |
| Kapsam | Kişi, proje, projeler, ekip, birim, müdürlük, direktörlük (yalnızca yetkili olanlar listelenir) |
| Ayrıntı | Kısa, standart, kapsamlı |
| Odak | Dengeli, başarılar, riskler, stratejik öncelikler |
| Bölümler | İsteğe bağlı bölümler: riskler (engeller ve bağımlılıklar), öncelikler, ekler (zorunlu bölümler kapatılamaz) |
| Notlar | Dahil / hariç (açık yetki ve rıza ile) |
| Karşılaştırma | Önceki dönem, özel dönem, yok |
| Destekleyici belgeler | İsteğe bağlı (4I-F) |
| Görseller | Temel, ayrıntılı, düzyazı ağırlıklı |
| Yapay zekâ modeli | Otomatik ya da tek tek nitelendirilmiş model |

- **Akış:** oluştur → ilerleme (iptal edilebilir) → önizleme → bölüm bazında düzeltme isteği ("bu bölümü daha kısa
  yaz", "riskleri öne çıkar") → doğrudan metin düzenleme → sonlandırma → DOCX indirme.
- **Bütünlük açıklamaları kapatılamaz:** Kaynak ve Yöntem Notu, nitelenen/çıkarılan ifadelerin işaretleri,
  yapay zekâ desteği bildirimi ve inceleme gerektiren sorunlar sunum tercihiyle gizlenemez.
- **Kurumsal biçim seçeneklerden bağımsızdır:** hiçbir ayar palet, yazı tipi, sayfa düzeni ya da bölüm sırasını
  değiştirmez.
- **Yetki:** kapsam seçenekleri sunucudan gelir. İlk önizleme, düzeltme sonrası önizlemeler, sonlandırma ve her
  indirme öncesinde §14 uygulanır. Kullanıcıya yetki değişikliği korunan içerik veya kimlik gösterilmeden bildirilir.
- **Düzenleme:** yöneticinin değiştirdiği bölümler belge özelliklerinde (`BilginDuzenlenenBolumler`) kaydedilir;
  değiştirdiği metinden yönetici sorumludur. Önceki doğrulama değiştirilen metne taşınmaz. İçerik çıkarılmadan önce
  yetki denetimi ve yayımlanacak maddi iddia desteği için §14 ve §8.2 uygulanır.
- **Görsel dil:** mevcut uygulama tasarım değişkenleri, açık/koyu tema, kurumsal lacivert ve sınırlı turuncu;
  masaüstü ve dar ekranda okunabilir; klavye ile kullanılabilir; teknik model ayarı gösterilmez.
- **Taslak durumu:** 4I'de sunucuda kalıcı saklama yoktur. Önizleme ile sonlandırma arasındaki taslak ya bellekte,
  süre sınırlı ve kullanıcıya bağlı tutulur ya da sunucu anahtarıyla imzalanmış/şifrelenmiş bir zarfla istemcide
  taşınır; seçim 4I-E'de gerekçelendirilir. Her iki durumda da tablo ve grafikler sonlandırmada istemciden
  güvenilmeden, **taslağın doğrulandığı aynı dondurulmuş sunucu kanıt paketi sürümünden** (TTL içinde, imzalı özet
  eşleşmesi ve §14 güncel yetki/rıza denetimiyle) üretilir. Alttaki yetkili veri yeniden sorgulandığında dondurulmuş
  paket özetiyle ayrışırsa veya yetki/rıza değişirse taslak geçersiz kılınır ve etkilenen paragraflar sonlandırma
  öncesinde 4I-C doğrulamasından yeniden geçirilir; böylece metin, tablo, grafik ve kapak `VERI_ANI` birbiriyle
  çelişemez.

---

## 14. Güvenlik, yetki ve gizlilik değişmezleri

- Sicil yalnızca güvenilir oturumdan; FULL/PARTIAL/READ, proje/görev görünürlüğü ve yönetim kapsamı aynen.
- Kanıt üretim anındaki yetkiyle toplanır. Her içerik çıkışında (ilk ve sonraki önizlemeler, sonlandırma, her
  indirme) güncel görünürlük ve rıza doğrulanır. Yetkisi değişen kanıta dayalı düzyazı, sayılar, tablolar,
  grafikler ve belge yeniden kurulur veya çıkarılır. Önceden hazırlanmış çıktı yeni denetimi atlayamaz.
- Model SQL üretmez; yeni araç ya da açık uçlu sorgu yüzeyi yoktur; sabit, parametreli sorgular.
- Korunan metin (not, ileti, değişiklik metni, belge) yalnızca rapor başına açık rızayla.
- İçerik günlüğe, telemetriye ve başka kullanıcının bağlamına girmez; içeriksiz telemetri (süre, çağrı, belirteç,
  sonuç kodu) tutulur.
- Yetki veya rıza doğrulanamazsa içerik döndürülmez. Kanıt desteği doğrulanamayan maddi iddialar için §8.2 uygulanır.
- 4I-0 yeni uç, kalıcı tablo, arka plan işçisi, zamanlanmış görev ya da küresel değişebilir durum eklemez.

---

## 15. Sürümleme ve köken

Her rapor (4I-D'den itibaren) `docProps/custom.xml` içinde şunları taşır: şablon ve stil sürümü, yazım sözleşmesi
sürümü (`4i-yazim-1`), kanıt paketi şema sürümü (`4i-kanit-1`), uçun yanıtta bildirdiği yazar model kimliği, veri
anı, doğrulama durumu, logo durumu ve yöneticinin düzenlediği bölümler. Böylece bir raporun hangi model, şablon
ve veri anıyla üretildiği belgeden okunabilir; içerik sunucuda saklanmaz.

---

## 16. Açık kararlar (ilgili artımda gerekçelendirilecek)

| Karar | Artım | Ölçüt |
| --- | --- | --- |
| DOCX üretimi: el yazımı OOXML + şablon doldurma mı, kütüphane mi | 4I-D | Ağsız, bakımı yapılan, güvenlik geçmişi temiz; yeni bağımlılık ancak gerekçeyle |
| Grafik biçimi: yerel DrawingML mi, SVG + PNG yedeği mi | 4I-D | Word/LibreOffice uyumu, Türkçe karakter, yeni bağımlılık gerektirmemesi |
| YAML'ın çalışma zamanında okunması | 4I-D/E | 4I-B'de çözülmedi, gerekmedi: yazar ayrıştırılmış stili parametre olarak alır (§7.4). Uç bağlanırken `js-yaml` doğrudan bağımlılık olur ya da derlemede JSON'a çevrilir |
| Taslak durumunun tutulması | 4I-E | Kalıcılık yok, çok örnekli dağıtımda doğru davranış, bellek sınırı |
| Logo PNG yedeği | 4I-D | Onaylı PNG dosyası ya da ağsız rasterleştirme |
| Rapor model profilleri | 4I-B (kısmen) | Profil tanımları eklendi; model eşlemesi kurum içi nitelendirme geçilince (bekliyor) |
