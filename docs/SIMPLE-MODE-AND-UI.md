# Basit Mod ve Arayüz Davranışları

Bu belge, MERGEN Rota'daki Basit Mod akışını ve üst çubuk/Özet yerleşimine ilişkin arayüz sözleşmelerini açıklar.

## Basit Mod Takvim akışı

Basit Modda **Takvim** sayfası açıldığında varsayılan görünüm aylık Takvimdir. Hızlı kayıt formu Takvim ile aynı anda gösterilmez.

Takvim sayfasında iki sekme bulunur:

1. **Takvim** — varsayılan görünüm; aylık görev takibini gösterir.
2. **Hızlı Görev Tanımı** — proje, görev, kısa açıklama, sorumlular ve termin tarihi ile hızlı kayıt oluşturur.

Kullanıcı başka bir sayfadan yeniden Takvim'e geçtiğinde Takvim sekmesi yeniden varsayılan görünüm olur. Basit Modda oluşturulan kayıtlar mevcut Project/Task veri altyapısını kullanmaya devam eder ve Gelişmiş Modda ayrıntılandırılabilir.

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
