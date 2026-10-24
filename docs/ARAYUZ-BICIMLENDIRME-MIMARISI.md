# MERGEN Rota Arayüz Biçimlendirme Mimarisi

Bu belge, MERGEN Rota sunum kodunun sorumluluk modelini tanımlar. Amaç, mevcut görsel sözleşmenin anlaşılması için onu oluşturan çekme isteği geçmişinin yeniden kurulmasına gerek bırakmamaktır.

## 1. Biçim sorumluluğu modeli

Biçimler zamana göre değil, sorumluluğa göre düzenlenir. Kural, görsel sözleşmesini tanımladığı bileşen veya özellikle birlikte bulunmalıdır. Kök yerleşim, anlamlı sorumluluklara sahip küçük ve kararlı bir biçim sırası yükler; hiçbir biçim dosyası yalnızca en son yüklenip önceki yamayı geçersiz kılmak için bulunmaz.

Mevcut kök yükleme sırası:

1. `src/app/globals.css` — genel tasarım değişkenleri, sıfırlama/temel kurallar ve yerleşik ortak temel bileşenler.
2. `src/app/styles/components.css` — ortak görsel bileşen çerçeveleri, formlar/girdiler, tablo davranışı ve ortak süzgeç açılır pencereleri.
3. `src/app/styles/shell.css` — uygulama kabuğu, kenar çubuğu, üst çubuk, proje kimliği ve dışa aktarma menüsü.
4. `src/app/styles/dashboard.css` — Özet yapısal yerleşimi ve durum halka grafiği sunumu.
5. `src/app/styles/features.css` — Gantt, WBS ve Görev Ayrıntısı özelliklerinin yerleşim sözleşmeleri.
6. `src/app/styles/system-admin.css` — Sistem Yönetimi konsolu: sağlık şeridi, sekmeler, bölüm kartları, ölçüm kutuları, grafikler ve ayrıntı çekmecesi.
7. `src/app/styles/assistant.css` — Rota AI (kullanıcıya “Bilgin” olarak gösterilir): üst çubuk başlatıcısı ve marka işareti, asistan paneli/tam ekran sayfası, konuşma, tek satırlı ileti düzenleyicisi ve güvenli Markdown yanıt sunumu.
8. `src/app/styles/simple-mode.css` — Temel Kip hızlı giriş ve takvim sekmesi sunumu.
9. `src/app/styles/experience.css` — kip seçici, ayarlar kip kartları ve yardım/ilk kullanım yüzeyleri.

## 2. Sorumluluk haritası

| Alan | Yetkili biçim kaynağı |
| --- | --- |
| Genel tasarım değişkenleri/temel/sıfırlama | `src/app/globals.css` |
| Uygulama kabuğu/üst çubuk/kenar çubuğu/dışa aktarma | `src/app/styles/shell.css` |
| Açılış/veri yükleme perdesi (`.app-boot*`) | `src/app/styles/shell.css` |
| Özet | `src/app/styles/dashboard.css` |
| Formlar/girdiler/DateInput | `src/app/styles/components.css` |
| Tablolar/ortak süzgeç açılır pencereleri | `src/app/styles/components.css` |
| Görevler/Kanban araç çubuğu ve kurumsal süzgeç taşması | `src/app/styles/components.css` |
| Kanban sayfa boyutları ve Gantt sorumlu listeleri | `src/app/styles/features.css` |
| Gantt | `src/app/styles/features.css` (`Gantt` bölümü) |
| WBS (araç çubuğu, ağaç denetimleri, ağaç tablosu) | `src/app/styles/features.css` (`Proje Yapısı` bölümü) |
| Ekip dizini (`.team-*`) | `src/app/styles/features.css` (`Ekip` bölümü) |
| Görev Ayrıntısı çekmecesi | `src/app/styles/features.css` (`Task Detail` bölümü) |
| Sistem Yönetimi konsolu (`.sysadmin-*`) | `src/app/styles/system-admin.css` |
| Yapışkan çalışma alanı şeritleri (`.workspace-sticky`) | `src/app/styles/features.css` |
| Temel Kip | `src/app/styles/simple-mode.css` |
| Ortak bileşen çerçeveleri | `src/app/styles/components.css` |
| AI erişim kartı (`.ai-*`) dahil kip seçici/ayarlar/yardım sunumu | `src/app/styles/experience.css` |
| Yükleme göstergeleri (`.app-spinner`, `.saving-overlay`) | `src/app/styles/components.css` |
| Açma/kapatma anahtarı (`.toggle-field`, `.toggle-switch`) | `src/app/styles/components.css` |
| Gantt ağaç denetimleri (`.gantt-outline-*`, `.gantt-level-*`) | `src/app/styles/components.css` |
| Kenar çubuğunun fare/klavye ile genişlemesi, sabitleme ve bölümlü kip seçici (`.sidebar-mode-toggle`) | `src/app/styles/shell.css` |
| Rota AI başlatıcısı, paneli, konuşması, ileti düzenleyicisi ve yanıt Markdown'ı (`.rota-assistant*`, `.assistant-md*`) | `src/app/styles/assistant.css` |

Bir özellik ortak tasarım değişkenlerini ve temel bileşenleri kullanabilir; yapısal yerleşiminden yine özelliğin biçim dosyasındaki bölüm sorumludur.

### 2.1 Yazı boyutu ölçeğinde görünüm yüksekliği

Yazı boyutu tercihi `document.body.style.zoom` olarak uygulanır. Yakınlaştırma, gövdenin ve tüm `position: fixed` alt öğelerinin koordinat sistemini çarpar; ancak `vh` birimleri tarayıcılar arasında tutarlı biçimde yeniden **ölçeklenmez**. Bu nedenle `height: 100vh` gibi bir kural, kullanıcı yazıyı büyüttüğünde ekrandan uzun çizilir ve öğenin altına bağlı her şey (örneğin Görev Ayrıntısı çekmecesindeki Sil/Kaydet çubuğu) görünür alanın dışına itilir.

`useApplyTweaks`, düzeltilmiş yüksekliği özel özellik olarak yayımlar:

```css
--app-viewport-h: calc(100vh / <scale>);
```

**Tam görünüm yüksekliklerinde yalın `vh` yerine `var(--app-viewport-h, 100vh)` kullanılmalıdır.** Bu, `globals.css`, `features.css`, `shell.css` ve `experience.css` içindeki `height`, `max-height` ve görünümle orantılı iç boşluklar için geçerlidir. Kural bir regresyon testiyle (`test/plan-health-and-overlay-bounds.test.mjs`) kapsanır.

Tam yükseklikteki flex kapsayıcılarda kaydırılan alt öğe ayrıca `min-height: 0`, sabit başlık/altlık ise `flex: 0 0 auto` gerektirir; aksi durumda gövde içerik yüksekliğine büyür ve kapsayıcı yüksekliğinden bağımsız olarak altlığı ekran dışına iter.

Ölçek, tema, yüksek karşıtlık ve hareket azaltma tercihleri `src/lib/tweaksBootstrap.js` ile **ilk boyamadan önce** gövdeye uygulanır. `AppShell` kurulmadan gösterilen veri kipi ve oturum ekranları da aynı tercihleri kullanır; uygulama açılınca ölçek veya tema değişiminden kaynaklanan yerleşim sıçraması oluşmaz.

### 2.2 Üst katman yerleşimi saf işlevdir

Açılır pencereler, seçim panelleri ve sütun süzgeci kutuları `document.body` üzerine portal ile taşınır; böylece kenar çubuğunun `overflow: hidden` kuralı ve yığılma bağlamları bunları kesemez. Kesilmeden kurtulmak yetmez: üst katman **görünüm alanıyla sınırlanmalı** ve yakınlaştırılmış koordinat sisteminden dönüşüm yapmalıdır.

Bu hesabı iki saf modül üstlenir; React'ten bağımsız birim testleri vardır:

| Modül | Sorumluluğu |
| --- | --- |
| `src/components/searchableSelectPlacement.js` | `SearchableSelect` panelinin yönü, genişliği, `panelMaxHeight` ve `listMaxHeight` |
| `src/components/overlayPlacement.js` | Sütun süzgeci kutuları: sınırlanmış `left`/`top`, yön değiştirme ve `maxHeight` |

İkisi de tetikleyicinin dikdörtgenini, üst katman ve görünüm boyutlarını alır; sonucun sığmasını güvence altına alır. Kullanılabilir alan **gerçek ölçüsüyle** değerlendirilir: üst katmana var olan alandan büyük asgari yükseklik verilmez; liste yüksekliği ayrılmadan önce panel çerçevesi (arama satırı, altlık) çıkarılır. Çağıranlar, ölçülen dikdörtgenleri ve `window.inner*` değerlerini iletmeden önce `appZoom()` ile böler.

### 2.3 Yapışkan başlıklı tam yükseklikli sayfalar

Tablonun ana öğe olduğu sayfalar (Görevler, Ekip, Proje Yapısı → İş Dağılım Ağacı) `.content` öğesini kaydırmaz. Yüksekliğini doldurur ve kaydırmayı tablo kabuğuna devreder:

```text
.content (sabit yükseklik, overflow auto)
└── <feature>-page          height: 100%; min-height: 0; display: flex/column
    ├── başlık kartı/araç çubuğu  flex: 0 0 auto
    └── <feature>-table-card flex: 1 1 0; min-height: 0; overflow: hidden
        └── <feature>-table-scroll  flex: 1 1 0; min-height: 0; overflow: auto
```

`position: sticky`, en yakın kaydırma kapsayıcısına göre çözümlenir; bu nedenle başlık satırı gerçekten kaydırılan öğenin içinde olmalıdır. Yükseklik kısıtı olmayan `overflow-x: auto` sarmalayıcısı yapışkan başlıkları sessizce bozar. Yapışkan başlık hücrelerinin opak arka plana da ihtiyacı vardır; aksi durumda yatay kaydırmada alttaki satırlar görünür.

Özet ve Proje Yapısı → Proje Tanımı ortak `.workspace-sticky` arka perdesini kullanır. Üst ve yan kapsama, `.content` öğesinin `--workspace-padding-top` ve `--workspace-padding-inline` değişkenlerini izler. Hesaplanan üst sınır bilinçli olarak 1px örtüştürülür; böylece tarayıcı yakınlaştırması/alt piksel yuvarlaması üst çubuğun altında ince bir çizgi açmaz. Alt kenar ayrıca 10px kaplar. Şeridin üstünde yalnızca 10px kapatmak, kaydırırken 24px içerik boşluğunun bir kısmını açık bırakır. Raporlar, ölçülen sekme yüksekliği ve 12px aralıkla sekmelerini tarih/kurum şeridinin üstünde tutar. Tarih şeridinin arka perdesi sekmeleri örtmeden bu aralığı kapatır.

Sistem Yönetimi her sekmede dikey kaydırmayı `.sysadmin-panel` öğesine devreder. Sağlık şeridi ve sekme listesi bu kaydırma alanının dışında, küçülmeyen kardeş öğeler olarak kalır. Panel odaklanabilir ve sekme değişiminde yeniden kurulur; önceki sekmenin kaydırma konumu yeni sekmenin başlığını gizlemez.

Görev hatırlatma geri bildirimi, içinde bulunduğu eylem hücresini bitişik gövde hücrelerinin üstüne, tablo başlıklarının altına yükseltir. Temel Kipte hücre yalnızca geri bildirim görünürken göreli konumlandırılır; olağan sütun statik kalır. Yalnızca geri bildirim balonunu yükseltmek, yapışkan hücrenin yığılma bağlamından çıkamaz.

## 3. Biçim ekleme kuralları

Önce sorumluluğu belirleyin: davranışın sahibi bileşeni veya özelliği bulun, sonra o kaynağı düzenleyin. Seçici özgüllüğünü artırmak yerine mevcut anlamsal sınıfı tercih edin. CSS aksi durumda DOM konumu, satır içi biçim metni veya ilgisiz alt öğelerden anlam çıkarmak zorundaysa yeni anlamsal sınıf ekleyin.

**YEREL BİLEŞEN SORUNU İÇİN YENİ BİR GENEL “DÜZELTMELER” BİÇİM DOSYASI OLUŞTURMAYIN.** İlgili bileşen veya özelliğin yetkili biçimini düzeltin.

Kaçınılmaz bir acil geçici yamanın, adı belirlenmiş bir sonraki birleştirme planı olmalıdır; kalıcı mimariye dönüşmemelidir.

## 4. Satır içi biçim ilkesi

Proje renkleri, hesaplanan ilerleme genişlikleri, seçili renkler ve görsel temel bileşenlerin hesapladığı koordinatlar gibi çalışma zamanı değerlerinde satır içi biçimler uygundur.

Statik yapı normalde anlamsal CSS sınıfları kullanmalıdır. `display`, ızgara izleri, sabit aralıklar, hizalama, taşma ve ekrana uyumlu davranış buna örnektir. Statik yerleşim önce satır içinde yinelenip sonra genel CSS ile bastırılmamalıdır.

## 5. Dinamik ve statik biçimler

Şu karar kuralını kullanın:

- Dinamik sunum değeri → satır içi biçim uygun olabilir.
- Statik bileşen yapısı → anlamsal sınıf tercih edilir.

Örneğin Özet durum açıklamaları, çalışma zamanında seçilen arka plan/kenarlığı satır içinde tutar; ızgarası, aralıkları, imleci ve geçişi `dashboard.css` sorumluluğundadır.

## 6. Seçici özgüllüğü ilkesi

Sorumluluğu açıkça ifade eden en düşük özgüllüğü kullanın. `nth-child()`, serileştirilmiş `[style*=...]` eşleştirmesi veya derin konumsal zincir yerine anlamsal sınıf tercih edin. `:has()` yasak değildir; ancak uygulama yapısındaki eksik anlamsal sınıfın yerine geçmemelidir.

`.topbar`, `.topbar-emblem-clip` ve `.topbar-project-context` gibi ana kabuk sözleşmelerinin tek olağan yetkili biçim kaynağı olmalıdır.

## 7. `!important` ilkesi

`!important` bir katmanlama mekanizması değildir. Sonraki biçim dosyasının öncekini bastırmasını sağlamak için kullanılmamalıdır.

Kalan kullanımlar yapısal gerekçeye dayanmalıdır: açık hareket azaltma geçersiz kılması veya alt öğe imleç kurallarını bastırması gereken etkileşim durumu gibi. Sorumluluğu veya anlamsal işaretlemeyi düzenlemek ihtiyacı kaldırabiliyorsa bu çözümü tercih edin.

## 8. Ekrana uyum kırılma noktalarının sorumluluğu

Bileşenin ekrana uyum kuralları, temel kurallarının yanında aynı kaynakta bulunur. Dolayısıyla Özet'in 1280, 1080 ve 760 piksel davranışı `dashboard.css`, Temel Kip uyumu `simple-mode.css`, Görev Ayrıntısı ve Gantt/WBS davranışı `features.css` içindedir.

Ortak Görevler araç çubuğu olağan masaüstü genişliklerinde tek satırdır: arama, üç kurumsal seçici, bilgi/temizleme denetimleri, sayaç ve **Yeni Görev** aynı flex satırını paylaşır. Görünüm genişliği 1280 px ve altındayken üç doğrudan seçicinin yerini kompakt **Kurumsal filtre** açılır denetimi alır; araç çubuğu yalnızca gerçekten dar genişliklerde satır kaydırabilir. İki kipin Görevler görünümü de aynı `TaskOrganizationFilterControls` işaretlemesini kullanır; ekrana uyumdan `components.css` sorumludur.

Aynı bileşen için ilgisiz dosyalarda birbiriyle yarışan kırılma noktalarını yinelemeyin.

### 8.1 Yakınlaştırmanın daralttığı alanlar için kapsayıcı sorguları

Yazı boyutu tercihi `body { zoom }` olarak uygulanır. Ortam sorguları görünüm alanına göre değerlendirilir; yakınlaştırma bunu **değiştirmez**. Bu nedenle `@media (max-width: …)`, kullanıcı yazıyı büyüttüğünde tablonun gerçekte kaybettiği alanı göremez. Görevler tablosu bu yüzden `.tasks-table-card` üzerinde `container-type: inline-size` tanımlar ve `@container gorevler-tablosu (…)` ile daralır: sıra sütunu kaldırılır ve hücre iç boşluğu küçülür. Kapsayıcı sorgusu desteklemeyen tarayıcılar geniş yerleşimi korur; yapışkan eylem sütunu satır eylemlerinin erişilebilirliğini zaten güvence altına aldığından bu kural doğruluk bağımlılığı değil, aşamalı iyileştirmedir.

Görevler eylem sütunu opak arka plan ve fareyle üzerine gelme kuralıyla (`tr:hover .tasks-actions-cell`) `position: sticky; right: 0` kullanır. Yapışkan hücre kaydırılan satırın üstüne çizilir; aksi durumda satır vurgusunun içinden sayfa görünürdü.

## 9. z-index/katmanlama sözleşmesi

Genel katman değişkenleri `globals.css` içindedir:

- `--z-base`: olağan içerik.
- `--z-sticky`: yapışkan tablo/başlık içeriği.
- `--z-chrome`: uygulama çerçevesi ve kalıcı yüzen çerçeve öğeleri.
- `--z-assistant`: üst çubuğun altına yerleşen, modal olmayan Rota AI paneli.
- `--z-popover`: açılır seçimler, süzgeçler ve modal olmayan açılır pencereler.
- `--z-drawer-backdrop`: çekmece arka perdesi.
- `--z-drawer`: Görev Ayrıntısı çekmecesi.
- `--z-command`: komut paleti katmanı.
- `--z-modal`: etkileşimi engelleyen modal/ilk kullanım yüzeyleri.
- `--z-tooltip`: en üstteki etkileşimsiz bilgi kutusu katmanı.

Yalıtılmış bileşende iç çizim sırası için küçük yerel z-index değerleri kabul edilir. Yığılma sorununu `10020` veya `10050` gibi açıklanmayan büyük değerlerle çözmeyin.

Üst çubuk `overflow: visible` kalır; yalnızca `.topbar-emblem-clip`, dönen dekoratif amblemi keser. Süzgeç açılır pencereleri ortak açılır pencere katmanını kullanır; Görev Ayrıntısı çekmecesi bunların üstündedir.

Rota AI paneli bilinçli bir anlamsal katmandır (`--z-assistant: 150`). Olağan içerik, yapışkan çalışma alanı şeritleri (`--z-chrome`) ve kenar çubuğunun üstündedir; yerleşik durumdayken üstü örtülmez. Bütün açılır pencerelerin, Görev Ayrıntısı çekmecesinin, komut paletinin ve modal pencerelerin altındadır; bunlardan biri açıldığında öne geçer. Üst çubuk açılır pencereleri üst çubuğun yığılma bağlamında bulunur; dışa aktarma menüsü gibi, açık bildirim penceresi de üst çubuğu `--z-popover` düzeyine yükseltir (`.topbar:has(.schedule-request-popover)`), böylece yerleşik panel onu örtemez. Geçici kayıt durumu panelin üstünde kalır. Dar ekranlarda (≤ 760 px, `ASSISTANT_SHEET_QUERY` ile ortak) panel, çekmece katmanında (`--z-drawer`) odak tuzaklı tam ekran modal sayfaya dönüşür. Panelin üst uzaklığı üst çubuk yüksekliğine eşittir; yüksekliği `var(--app-viewport-h, 100vh)` kullanır. `test/ai-architecture-contract.test.mjs`, katman sırasını ve `assistant.css` içinde sayısal z-index bulunmamasını korur.

## 10. Ortak görsel temel bileşenlerin sorumluluğu

Yeniden kullanılabilir temel bileşenler `src/components/ui.jsx`, `src/components/ui-extras.jsx` ve ilgili ortak bileşenlerde bulunur. Tek bir özelliğin yerleşim sorununu çözmek için genel davranışları değiştirilmemelidir.

Özet'e özgü halka grafiği boyutları ve yerleşimi `.dashboard-status-chart` ile ilgili anlamsal Özet sınıflarına aittir; `Donut` temel bileşeni yalnızca halkanın nasıl çizildiğinden sorumludur.

**Halka dilimleri kesik çizgiler değil, kapalı yollardır.** Önceki uygulama her dilimi `stroke-dasharray` ve negatif `stroke-dashoffset` ile tam çember olarak çiziyordu. Kesik çizgi deseni çevre boyunca **tekrarlandığından**, toplamı az farkla `2πr` üzerine çıkaran yuvarlama artığı deseni başa sarıyor ve bir dilimi halkanın farklı yerlerinde iki parça gibi gösteriyordu. Seçili dilimi öteleme ile dışarı taşımak da halkadan ayırarak aynı “bölünmüş” algısını üretiyordu.

Geometri artık saf `src/components/charts/donutGeometry.js` modülündedir:

- `donutSegments()` değerleri normalleştirir (sonlu olmayan ve negatif → 0), toplam tam 360° olsun diye kalan açıyı son dilime verir ve küçük bir dilimi hiçbir zaman tüketmeyen, eşit ve bilinçli bir aralık uygular.
- `donutSlicePath()` kapalı dış yay → iç yay yolu üretir; böylece dilim geometrik olarak halkanın dışına çıkamaz. Tek yay kendi üzerine kapanamadığı için tam tur iki yarım turla ifade edilir.

Vurgu (fareyle üzerine gelme/seçim) yalnızca **iç** yarıçapı değiştirir; dış çap sabittir. Böylece dilim kesilmez ve komşusuyla örtüşmez.

### 10.1 Grafik eksen etiketleri

Eksen etiketleri SVG `<text>` değil, HTML'dir. Grafik SVG'leri kart genişliğine ölçeklenir (`width: 100%`; CFD ayrıca `preserveAspectRatio="none"` kullanır); bu nedenle SVG içindeki `font-size` da kartla ölçeklenir: geniş Özet ekranında etiketler amaçlanan boyutun yaklaşık iki katına çıkıyor, `none` altında yatay da uzuyordu. `.chart-axis-labels`, gerçek metni çizim alanının üzerine yüzdelik uzaklıklarla yerleştirir ve SVG dönüşümünden etkilenmez. Etiket kapsayıcısı **yalnızca** çizimi sarmalıdır; aksi durumda etiketler altta çizilen açıklamaların üzerine gelir.

## 11. Özelliğe özgü biçim sorumluluğu

Özellik yerleşimi, özellik adından bulunabilmelidir. Özet yerleşimi `dashboard.css`, Gantt/WBS/Görev Ayrıntısı bölümleri `features.css`, Temel Kip `simple-mode.css` içindedir. Yerleşimde anlamlı bölgeler varsa özellik JSX'i anlamsal sınıflar sunmalıdır.

## 12. CSS yamalarının birikmesini önleme

`final-fixes.css`, `latest-overrides.css`, `followup-fixes.css`, `polish.css` veya benzeri zamana dayalı katmanlar eklemeyin. Git geçmişi denemelerin sırasını zaten kaydeder. Kaynak ağacı mevcut sistemi anlatmalıdır.

Eski kuralın yerine yenisi geçerken ikisini de etkin bırakmak yerine geçersiz kalan kuralı kaldırın. Regresyon testi, bir yama dosyasının diğerinden sonra yüklenmesini değil, görünür veya anlamsal sözleşmeyi korumalıdır.

## 13. Görsel regresyonları düzeltme

1. Etkilenen bileşendeki sorunu yeniden üretin ve yetkili biçim kaynağını bulun.
2. Amaçlanan görsel sözleşmeyi ve ekrana uyum durumlarını doğrulayın.
3. Kaynağı düzeltin veya seçici yapısal olarak kırılgansa anlamsal işaretleme ekleyin.
4. Yalnızca artık düzeltilmiş kuralı geri almak için bulunan kuralları kaldırın.
5. Davranış/anlamsal sözleşme için regresyon testi ekleyin veya güncelleyin.
6. Otomatik kalite paketini ve `docs/GORSEL-DUMAN-TESTLERI.md` içindeki ilgili denetimleri çalıştırın.

Üst çubuk amblem konumu ve Özet durum kartı boyutları gibi kabul edilmiş görsel regresyon sözleşmesini bilinçli olarak tanımlayan kesin CSS değerleri test edilebilir.

## 14. Tipografi sözleşmesi

Başlıklar ve etiketler **cümle düzeninde büyük/küçük harfle** yazılır; uygulama biçim dosyalarında ve satır içi biçimlerde hiçbir yerde `text-transform: uppercase` kullanılmaz. Tamamı büyük harfli küçük etiketleri okunabilir kılan geniş harf aralığı aynı anda `0.02em` değerine düşürüldü; en küçük üst etiketler büyütüldü. Çünkü 9.5px küçük harfin 0.13em aralıkla okunması, yerine geçtiği büyük harften daha zordur.

Sayfa başlıkları düz `var(--text)` dolgusu ve altında kısa vurgu çizgisi kullanır. Geçişli metin dolgusu (`background-clip: text` + `-webkit-text-fill-color: transparent`) kaldırıldı: küçük boyutlarda karşıtlığı düşürüyor, açık temada soluyor ve seçim vurgusunu bozuyordu.

İki sözleşme de `test/module-binding-and-recurrence-editing.test.mjs` ile kapsanır.


## Açılış ekranı ve kurum logosu

Sekme simgesi `src/lib/appFavicon.js` içinde uygulama pusula logosunun sadeleştirilmiş biçimidir: gövde çemberi, ibre açısı ve merkez korunur; 16 ve 32 pikselde okunaklı olması için derece çizgileri ve gölge kullanılmaz. Kendi zemini açık/koyu sekme çubuklarında karşıtlığı korur. `src/app/layout.js`, SVG simgesini ve PNG `alternate icon` / `apple-touch-icon` yedeğini veri URI'si olarak gömer; ek ağ isteği, ayrı simge dosyası veya derleme adımı gerekmez.

Açılış ekranı koyu lacivert zemin, hafif ışık geçişleri, birbirinden bağımsız hareket eden yıldız katmanları ve sade bir marka kartı kullanır. Hareket ilk saniyelerden itibaren görülebilir. İşletim sistemi veya uygulamanın hareket azaltma tercihi yıldızları, arka planı ve ilerleme animasyonunu durdurur.

Kurum logosu `/api/mergen-rota/company-logo` üzerinden alınır. `MERGEN_ROTA_COMPANY_LOGO_PATH` sunucunun erişebildiği UNC, Windows veya mutlak SVG yoludur. Node hizmet hesabının paylaşım ve dosya okuma yetkisi bulunmalıdır; Linux kurulumunda paylaşım bağlanıp yerel bağlama yolu kullanılmalıdır. Eski `NEXT_PUBLIC_MERGEN_ROTA_COMPANY_LOGO_URL` ayarı HTTPS adresi veya UNC SVG yolu içeriyorsa da çalışır. Yeni dosya yolu ayarı sunucuda okunur ve tarayıcıya gönderilmez. Ayar değişince hizmet yeniden başlatılır; değişen görsel beş dakikaya kadar önbellekte kalabilir. Logo 220 × 64 piksel alanda `object-fit: contain` ile gösterilir. Ayar boş veya dosya okunamıyorsa logo gizlenir; açılış engellenmez.

Temel Kipte eylem sütununun başlığı da diğer başlıklarla birlikte yapışkandır ve opak zemin kullanır; kaydırılan zarf/silme simgeleri başlığın üstüne çıkmaz. Tarih talebi rozetleri sabit 24 piksel yüksekliğe sahiptir; ızgara satırlarının yüksekliğine uzamaz. Kilometre taşının gerçekleşen tarihi ortak tarih ızgarasında yer alır.

Daralan kenar çubuğunda kullanıcı metni ve kip etiketlerinin gizli satırları yükseklik tüketmez. Menü kalan yüksekliği alır; fotoğraf ve araçlar altta kalır. Genişlik/padding geçişleri aynı 420 ms yumuşak hız eğrisini kullanır; hareket azaltma tercihi tüm geçişleri kapatır.


## Talepler ve KPI ayrıntı listesi

Yeni liste stilleri `features.css` içindedir; renkler mevcut tasarım değişkenlerini kullanır. KPI penceresi ölçekli görünüm ölçülerini izler ve kendi tablosunu kaydırır. Görev paneli açılınca alttaki KPI penceresi gizlenir ve odak tuzağı askıya alınır; kapanınca durumu korunarak geri gelir. Gerçekleşen tarih işareti nötr `--text-muted` rengindedir. Tarih açıklaması ve gezinme `.task-table-footer` içinde tek esnek satırdır; dar ekranda sarılır.


Raporlar iki küçük sekmeyle aynı modül içinde kalır. Hareket filtreleri ortak SearchableSelect/DateInput ve kurumsal yol denetimlerini, tablo mevcut tema değişkenlerini kullanır. Paylaşılan modal odak kancası yalnızca en üst pencerenin Escape olayını işler; tarih/seçim portalları ait oldukları pencerenin odak kapsamını taşır.
