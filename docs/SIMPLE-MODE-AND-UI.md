# Basit Mod ve Arayüz Davranışları

Bu belge, MERGEN Rota'daki Basit Mod akışını ve üst çubuk/Özet yerleşimine ilişkin arayüz sözleşmelerini açıklar.

## Basit Mod Takvim akışı

Basit Modda **Takvim** sayfası açıldığında varsayılan görünüm aylık Takvimdir. Hızlı kayıt formu Takvim ile aynı anda gösterilmez.

Takvim sayfasında iki sekme bulunur:

1. **Takvim** — varsayılan görünüm; aylık görev takibini gösterir.
2. **Hızlı Görev Tanımı** — proje, görev, kısa açıklama, sorumlular ve termin tarihi ile hızlı kayıt oluşturur.

Kullanıcı başka bir sayfadan yeniden Takvim'e geçtiğinde Takvim sekmesi yeniden varsayılan görünüm olur. Basit Modda oluşturulan kayıtlar mevcut Project/Task veri altyapısını kullanmaya devam eder ve Gelişmiş Modda ayrıntılandırılabilir.

## Basit Modda Gantt

Basit Mod gezinmesi `takvim`, `gantt`, `yardim` ve `ayarlar` sayfalarını içerir. Gantt, Gelişmiş Moddaki portföy Gantt görünümünün aynısıdır (`WorkspaceGanttView`): Basit Modda çalışma alanı her zaman portföy olduğu için görünüm tüm projeleri birlikte gösterir. Ayrı bir Basit Mod Gantt bileşeni yoktur; hızlı görev tanımı yapan kullanıcı planı aynı zaman çizelgesinde görür.

## Açılış perdesi

İlk veri yüklemesi ve yükleme hatası perdesi (`AppDataBoundary`) uygulama kabuğunun `.app` ızgarasını **kullanmaz**. O ızgaranın ilk sütunu 240 piksellik kenar çubuğuna ayrılmıştır; perde tek çocuk olarak yerleştirildiğinde o dar sütuna düşüyor ve kart ekranın solunda kırpılmış görünüyordu.

Perde artık `.app-boot` sınıfıyla tam ekran, ortalanmış kendi düzenini kurar: marka satırı, başlık, açıklama, belirsiz ilerleme çubuğu ve yükleme adımı rozetleri. Stil sahibi `src/app/styles/shell.css` dosyasıdır.

## Sorumlu seçimi ve büyük kullanıcı listeleri

Sorumlu seçiminin görsel kart tasarımı korunur; ancak tüm kullanıcılar aynı anda gösterilmez. Kullanıcı:

- ad veya personel numarasıyla arama yapabilir;
- en fazla ilk sekiz eşleşmeyi hızlı seçim kartları olarak görür;
- seçtiği kişileri ayrı bir **Seçilenler** bölümünde görmeye devam eder.

Bu yaklaşım, kişi sayısı büyüdüğünde yüzlerce kartın aynı anda render edilmesini önler. Mevcut uygulama kişi listesini istemci tarafında filtreler. Gerçek veritabanı/API entegrasyonunda aynı arayüz korunarak arama sunucu tarafına taşınabilir; bu durumda arama metni sorgu parametresi olarak gönderilmeli, sonuçlar sayfalı veya sınırlı biçimde dönmelidir.

## Üst çubuk proje bağlamı

Proje çalışma alanında proje bağlamı üst çubuğun gerçek yatay ve dikey merkezinde gösterilir:

- proje kodu varsa daha geri planda, gri tonlu ve monospace tipografiyle;
- proje adı vurgu rengi ile ana metin arasında belirgin bir tonla ve daha güçlü ağırlıkta;
- açık ve koyu temalarda `--text-muted` ve `--text` tema değişkenleriyle yeterli ayrım sağlanacak biçimde.

Üst sağ köşedeki dönen MERGEN yedigeni yalnızca `.topbar-emblem-clip` dekoratif katmanı tarafından kırpılır; topbarın kendisi dışa taşan menü ve popoverlar için `overflow: visible` kalır. Bu sözleşmenin sahibi `src/app/styles/shell.css` dosyasıdır.

## Özet yerleşimi

Özet sayfasının grafik ve alt kart satırları aynı üç kolon izini kullanır. Böylece:

- **Tamamlama Trendi** kartının sağ sınırı **Ekip İş Yükü** kartının sağ sınırıyla;
- **Durum Dağılımı** kartının sol sınırı **Yaklaşan Teslimler** kartının sol sınırıyla

hizalanır.

Durum dağılımı halka grafiği ve legend yerleşimi, PR #28 ile kabul edilen boyut ve 1280 px davranışını korur. Dashboard yapısı `dashboard-main-grid`, `dashboard-status-card`, `dashboard-status-body`, `dashboard-status-chart` ve `dashboard-status-legend` gibi semantik sınıflarla tanımlanır; inline stil metni veya kart sırası üzerinden çıkarım yapılmaz. Bu sözleşmenin sahibi `src/app/styles/dashboard.css` dosyasıdır.

## Uzun listeler için aranabilir seçim bileşeni

Proje, personel, iş dağılım düğümü ve öncül görev gibi binlerce kayda ulaşabilen tüm seçim noktaları `SearchableSelect` bileşenini kullanır. Bileşenin sözleşmesi:

- açılır panel **React portalı ile `document.body` altına** taşınır. Panel `position: fixed` ile tetikleyiciye göre konumlanır ve `computePopoverPlacement` (bkz. `src/components/searchableSelectPlacement.js`) tarafından görünüm alanı içinde tutulur; alt kenara sıkışan liste yukarı açılır, yan kenardan taşan liste içeri çekilir;
- panel gövdeye taşındığı için kenar çubuğunun `overflow: hidden` kırpması ve `.sidebar > *` yığın bağlamı listeyi artık etkilemez. Daha önce liste kenar çubuğunun içinde kalıyor, gezinme bağlantıları listenin üzerine boyanıyor ve liste arka planla karışmış görünüyordu;
- panel `--z-select-popover` katmanını kullanır. Bu katman kip pencerelerinin (`--z-modal`) üzerindedir; böylece bileşen bir kip pencere içinde de kullanılabilir;
- liste her zaman opak `--bg-elev` zeminine sahiptir;
- `allowClear` verildiğinde panelin üstünde bir **temizleme satırı** çıkar. Portföy/proje seçimi bu sayede geri alınabilir;
- klavye ile gezinme (`↑ ↓ Home End Enter Esc`) desteklenir ve etkin satır görünür alanda tutulur.

Yeni bir uzun liste eklenirken ham `<select>` kullanılmamalıdır. Ham `<select>` yalnızca sabit ve kısa numaralandırmalar (ilişki türü, gecikme birimi, ay/yıl) için uygundur.

## Basit Modda serbest proje tanımlama

Kurumsal proje kataloğu binlerce kayıt içerebildiği ve açılır liste yalnızca ilk N sonucu gösterdiği için **Serbest proje tanımla** seçeneği listenin başına sabitlenir (`withManualProjectOption`). Seçenek yalnızca oturumun `canCreateProjects` yetkisi varsa eklenir.

Serbest proje tanımı ekranından kurumsal listeye **Kurumsal proje listesine dön** düğmesiyle geri dönülür.

Basit Modda proje oluşturmak etkin çalışma alanını **değiştirmez** (`addProject(input, { focusWorkspace: false })`). Çalışma alanı değiştiğinde uygulama kabuğu içerik alanını yeniden monte ettiği için hızlı görev formu kayıt tamamlanmadan sıfırlanıyor, kullanıcı ne sonucu ne de hatayı görebiliyordu.

### Görev tanımlamadan yalnızca proje oluşturma

Kullanıcı bir projeyi açıp görevleri **sonra** tanımlamak isteyebilir. Bu nedenle Basit Modda, hızlı görev formundan bağımsız bir **Yeni proje** düğmesi bulunur; düğme Gelişmiş Moddaki `ProjectCreateDialog` penceresini açar ve yalnızca projeyi (ve kök iş dağılım düğümünü) oluşturur. Oluşturulan proje form üzerindeki proje seçiminde etkin hâle gelir, çalışma alanı değişmez ve hiçbir görev kaydı üretilmez. Düğme oturumun `canCreateProjects` yetkisi yoksa devre dışıdır.

Pencere, hızlı görev formunun **dışında** render edilir: iç içe `<form>` öğeleri geçersiz HTML'dir ve tarayıcı iç formu yok sayar.

Etiket kataloğuna yazma, görev kaydından **bağımsız ikincil bir işlemdir**. Proje satırı yazılamıyorsa görev yine oluşturulur ve kullanıcıya uyarı gösterilir; asıl işlem ikincil bir yazma yüzünden engellenmez.

## Geri dönüş yolları

Her seçim yapılabilen yüzeyin geri dönüş yolu bulunmalıdır:

| Yüzey | Geri dönüş |
| --- | --- |
| Kenar çubuğu · Aktif çalışma alanı | Açılır listedeki **Portföye dön (tüm projeler)** satırı ve seçicinin altındaki **Portföye dön** düğmesi |
| Proje Yapısı sayfası | Sekme çubuğundaki **Proje listesi** düğmesi (proje seçili olduğunda görünür) |
| Basit Mod · Serbest proje tanımı | **Kurumsal proje listesine dön** düğmesi |

## Veri modu anahtarı ve kaydetme bildirimi

Sağ alt köşe yalnızca **kaydetme bildirimine** (`.persistence-status`) aittir. Demo/Gerçek Sistem anahtarı **Ayarlar** sayfasındaki *Veri kaynağı* kartında yaşar (`DataModeIndicator variant="settings"`). Kenar çubuğu ve veri sınırı ekranı anahtarı hiç göstermez; kenar çubuğu yalnızca çalışma alanı, gezinme ve kullanıcı bilgisini taşır.

Ayarlar sayfasına yalnızca uygulama kabuğu üzerinden ulaşıldığı için **ilk** veri yüklemesi başarısız olduğunda hata ekranı ayrıca bir **Demo moduna geç** çıkışı sunar (`DemoModeEscape`). Bu tek düğme olmadan Gerçek Sistem erişilemediğinde uygulama tamamen kilitlenirdi.

## Uygulama kabuğu yeniden yüklemede sökülmez

`AppDataBoundary` yükleme/hata perdesini **yalnızca ilk veri yüklemesinde** gösterir (`dataStatus === 'loading' && !hasLoadedOnce`). Daha önce her yeniden yükleme kabuğu söküyordu: proje oluşturduktan veya değişiklik kaydettikten sonra `AppShell` yeniden monte oluyor, açık sayfa ve karşılama ekranı tercihi sıfırlanıyor ve uygulama ilk kez açılmış gibi davranıyordu.

Veri zaten yüklüyken başarısız olan bir tazeleme kabuğu kapatmaz; kullanıcı son başarılı veriyle çalışmayı sürdürür ve kaydetme bildirimi alanında **Veriler yenilenemedi** uyarısı ile yeniden deneme düğmesi gösterilir.

## Proje Yapısı · yalnızca proje listesi kaydırılır

Proje seçici kartında başlık, arama alanı, tamamlananları gösterme kutusu ve proje türü hızlı seçim düğmeleri donuk (`.project-browser-head`) kalır; yalnızca listelenen proje düğmeleri (`.project-browser-list`) dikey olarak kaydırılır. Kurumsal katalog yüzlerce proje içerdiği için süzgeçler daha önce listeyle birlikte görünüm alanının dışına kayıyordu. **Daha fazla göster** düğmesi de kaydırılan bölümün içindedir.

## Ekip sayfası · donuk başlıklar ve tanımsız direktörlük

Ekip sayfası kendi yüksekliğini yönetir: "Kurumsal ekip dizini" kartı sabit kalır ve yalnızca personel tablosu kayar, böylece tablo başlığı ile süzgeçler aşağı kaydırırken de görünür durur.

Kurumsal rehberde herkesin direktörlüğü tanımlı değildir; bir bölüm çalışanın yalnızca yöneticisi bilinir. Bu kişiler önceki sürümde hiçbir grupta görünmüyordu. Artık "Direktörlük tanımsız" hem özet kartı hem de süzgeç seçeneği olarak listelenir; süzgeç mantığı `src/features/team/teamDirectoryPolicy.js` içindeki `matchesDirectorateFilter` işlevindedir.

Tablo sütunları Görevler sayfasıyla aynı süzgeç/sıralama bileşenini kullanır ve
kurumsal düzey süzgeçleri üstteki dizin açılır listeleriyle tek durumu paylaşır.
Ayrıntı: `docs/PROJECT-PORTFOLIO-AND-DIRECTORY.md`.

## Kenar çubuğu kullanıcı bloğu

Kenar çubuğunun altındaki kullanıcı bloğu artık sabit bir örnek kişi değil,
**doğrulanmış oturum kullanıcısıdır** (`session.currentUser`):

- kurumsal fotoğraf, Sicil'den `<TABAN_URL>/<SICIL>.jpg` biçiminde üretilir;
  adres yoksa ya da görsel yüklenemezse baş harflere dönülür;
- ad satırının altında **Keycloak `department` claim'i** gösterilir; uydurma bir
  "rol" metni yoktur. Değer yoksa nötr `Departman bilgisi yok` yazılır;
- departman adları uzun olabildiği için satır tek satıra zorlanmaz: küçük yazı
  tipi, sıkı satır yüksekliği ve çok satıra sarma kullanılır, taşma engellenir.

Eski **Kullanım rehberi** kısayol düğmesi bu satırdan kaldırılmıştır; boşalan
yatay alan kimlik bloğuna verilmiştir. Yardım sayfası ve gezinme öğesi
yerindedir. Tema düğmesi korunur; Gerçek Sistem'de kompakt bir **Oturumu kapat**
düğmesi eklenir.

Avatar boyutları fotoğrafın okunabilir olması için ölçülü biçimde büyütülmüştür:
satır içi (`sm`) 26 px, tablo/kart (varsayılan) 32 px, kenar çubuğu (`lg`) 40 px.
Boyutlar `src/app/globals.css` içindeki `--avatar-size` değişkeniyle tek yerden
yönetilir.

## Proje Yapısı · İş Dağılım Ağacı denetimleri

Dağılım ağacı sekmesinde dikey alan tabloya ayrılır: üst bilgi tek satırlık bir başlık çubuğuna (`.wbs-toolbar`) indirgenir, uyarılar ince notlara dönüşür, görev taşıma paneli varsayılan olarak kapalıdır ve tablo kalan yüksekliğin tamamını alarak kendi kaydırma kabuğunda kayar. Başlık satırı donuktur.

Ağaç denetimleri `Tümünü aç`, `Tümünü kapat` ve `Hiyerarşi` (1–5 arası seviye ya da tüm seviyeler) düğmeleridir. Açılış derinliği ikidir; kurumsal projelerde ağacın tamamını açık başlatmak on binlerce satırın ilk çizimde oluşturulması demekti.

## Vurgu rengi adları

Ayarlar sayfasındaki vurgu rengi kataloğu Türkçedir. `Amber` yerine proje renk kataloğuyla aynı sözcük olan `Kehribar` kullanılır.

## Kurumsal iş dağılım ağacı salt okunurdur

Gerçek Sistem modunda kurumsal projelerin İş Dağılım Ağacı sekmesi düzenleme eylemlerini (Alt ekle / Ad / Taşı / Sil) hiç göstermez ve yapının CN43N kaynağından beslendiğini açıklayan bir bilgi kartı sunar. Satırlarda kaynaktan gelen seviye, PYP kodu, eleman türü ve durum bilgisi gösterilir. Görevleri bu düğümlere atamak ve düğümler arasında taşımak yine mümkündür; görev-WBS bağı MERGEN Rota verisidir. Demo modunda kurumsal kaynak bulunmadığı için örnek projelerin ağacı düzenlenebilir kalır.

Kaydetme bildirimi artık sabit "Kaydetme hatası" metni yerine sunucunun gerçek iletisini, hata kodunu ve varsa alan/yol bilgisini gösterir. Sürüm/eşzamanlılık hatalarında (`CONFLICT`, `UPSERT_CREATE_COLLISION`, `UPSERT_TARGET_MISSING`) **Verileri yeniden yükle** eylemi sunulur.


## Windows VM üzerindeki `npm run build` uyarıları

### React Hook bağımlılık uyarısı

Önceki sürümde `AppShell.jsx` içindeki Basit Mod `useEffect` bağımlılık listesi bütün `workspace` nesnesini dolaylı olarak kullanıyordu. Bu nedenle ESLint şu uyarıyı üretebiliyordu:

```text
React Hook useEffect has a missing dependency: 'workspace'.
```

Bu bir derleme hatası değildi; üretim build'i tamamlanabiliyordu. Bununla birlikte ileride kapanış (closure) kaynaklı beklenmeyen davranışlara yol açmaması için düzeltilmiştir. Effect artık yalnızca kullandığı `workspaceMode` ve `selectWorkspace` değerlerini açık bağımlılık olarak izler.

### `npm warn Unknown user config "distrurl"`

Bu uyarı uygulama kaynak kodundan değil, komutu çalıştıran Windows kullanıcısının npm kullanıcı yapılandırmasından kaynaklanır. Mevcut npm sürümünde build'i engellemez; ancak npm'in sonraki ana sürümünde bu bilinmeyen ayarın desteklenmeyeceği bildirilmektedir.

Yapılandırmayı görmek için:

```bash
npm config get userconfig
npm config list
```

Yanlış yazılmış ayar gerçekten `distrurl` ise kaldırmak için:

```bash
npm config delete distrurl
```

Kurum içi npm registry/proxy yapılandırması kullanılıyorsa ayarı silmeden önce sistem yöneticisinin beklenen ayar adını doğrulaması gerekir.

### `deprecated` paket bildirimleri

`npm install` sırasında görülen `deprecated` satırları da tek başına build hatası değildir. Bunlar doğrudan veya geçişli bağımlılıkların eski sürümlerine ilişkin bildirimlerdir. Uygulamanın çalışan sürümünü bozma riski nedeniyle, paket güncellemeleri bu arayüz düzeltmesinden ayrı bir bakım çalışmasında `npm test` ve `npm run build` ile doğrulanarak yapılmalıdır.


## Stil sahipliği

Basit Mod arayüz stilleri `src/app/styles/simple-mode.css` içinde sahiplenilir. Üst çubuk `shell.css`, Özet/Dashboard `dashboard.css` tarafından yönetilir. Yerel bir görsel sorun için yeni bir global `fixes` veya `polish` katmanı eklenmemelidir; ilgili yetkili stil sahibi düzeltilmelidir. Ayrıntılar için `UI-STYLING-ARCHITECTURE.md` dosyasına bakın.
