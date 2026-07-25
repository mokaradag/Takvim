# Büyük Portföy ve Personel Dizini

Bu belge, MERGEN Rota'nın yüzlerce proje ve binlerce personel bulunan Gerçek Sistem kullanımındaki seçim, görüntüleme ve kayıt davranışlarını açıklar.

## Proje seçimi

Proje veya personel seçen uzun listeler yerel HTML `select` alanları yerine canlı arama destekli `SearchableSelect` bileşenini kullanır. Arama Türkçe yerel ayarına göre çalışır ve proje kodu, proje adı, proje türü; personelde ise ad, sicil, unvan ve organizasyon alanlarını tarar. Sonuç listesi sınırlı sayıda kayıt oluşturur; daha ayrıntılı arama yapıldıkça liste daralır.

`Aktif çalışma alanı`, Basit Mod proje seçimi, Yeni Proje sorumlusu ve Proje Tanımı içindeki manuel proje sorumlusu bu ortak davranışı kullanır.

## Proje türleri

Kurumsal projeler `ProjectTypeCode` ve `ProjectTypeName` alanlarına göre sınıflandırılır. Tür adları ve simgeleri `src/domain/projectTypes.js` içinde tek bir katalogda tutulur.

Başlangıçta gizlenen tamamlanmış veya kapatılmış türler şunlardır:

- `KF` — Kapatılan Faaliyet
- `KG` — Kapatılan Geliştirme Projesi
- `KP` — Kapatılan Proje
- `KT` — Kapatılan Tohum Projesi
- `TF` — Tamamlanan Faaliyet
- `TG` — Tamamlanan Geliştirme Projesi
- `TP` — Tamamlanan Proje

Kullanıcı gerektiğinde “Tamamlanan ve kapatılanları göster” seçeneğini açabilir. Bu seçim yalnızca arayüz görünürlüğünü değiştirir; verileri silmez veya erişim yetkisini değiştirmez.

## Proje Yapısı / Proje Tanımı

Portföy çalışma alanında tüm projeleri tek tek düğme olarak oluşturmak yerine:

1. Proje türü özet kartları gösterilir.
2. Kullanıcı bir tür seçebilir.
3. Proje kodu, adı veya türüyle canlı arama yapabilir.
4. Sonuçlar sayfalı biçimde artımlı gösterilir.

Bu düzen, sınırlı proje erişimi bulunan ekiplerin yalın deneyimini korurken sistem yöneticileri ve üst yöneticiler için yüzlerce proje içeren görünümü kullanılabilir kılar.

## Kurumsal proje sorumlusu

Kurumsal bir projenin `Proje Sorumlusu`, `MR_V_CorporateProjectAccess` görünümündeki `PROJECT_MANAGER` rolünden alınır. Kurumsal projelerde bu alan salt okunurdur. Manuel projelerde ise yetkili kullanıcı canlı arama ile bir sorumlu seçebilir.

`src/server/repository/corporateQueries.js`, kurumsal proje eşitlemesi sırasında `MR_Projects.LeadSicil` alanını bu rolün siciliyle yeniler.

## PPTS rol düzeltmesi

`HR09_projeSorumlu.pptsSicil` alanından üretilen rol kodu `PPTS` olmalıdır. Var olan kurulumlarda aşağıdaki geçiş betiği çalıştırılır:

```text
database/MR_Migrate_0002_Project_Portfolio_Scaling.sql
```

Betiğin yaptığı işlemler:

- `MR_V_CorporateProjectAccess` görünümünü `PPTS` rol koduyla yeniden oluşturur.
- Kurumsal proje sorumlularını `PROJECT_MANAGER` rolünden yeniden eşitler.
- `MR_SchemaMigrations` tablosuna `0002_project_portfolio_scaling` kaydını ekler.

## Ekip sayfası

Ekip görünümü tüm personel için büyük kartlar oluşturmaz. Başlangıç görünümü direktörlük özetlerinden oluşur. Kullanıcı daha sonra direktörlük, müdürlük ve birim düzeyinde ilerleyebilir veya ad, sicil, unvan ve organizasyon alanlarında canlı arama yapabilir.

Görev sayıları tek geçişte personel kimliğine göre dizinlenir. Böylece eski `personel × görev` taraması yerine yaklaşık `personel + atama` maliyetli hesaplama kullanılır. Personel sonuçları artımlı yüklenir.

## Kayıt güvenilirliği

Gerçek Sistem kayıtları için iki koruma uygulanır:

- Var olan proje, WBS ve görev nesnelerinde arayüzün düşürdüğü `version` alanı, commit öncesinde mevcut durumdan geri yüklenir. Böylece güncelleme işlemi yanlışlıkla oluşturma olarak yorumlanmaz ve “Kayıt kimliği zaten kullanılıyor” çatışması oluşmaz.
- Gerçek Sistem istemcisi proje, WBS, görev, takvim ve bağımlılık kimliklerini API isteğinden önce UUID olarak doğrular. İstemci ön ekli kimliklerin sonundaki UUID güvenli biçimde ayrıştırılır.

Görev oluşturma eylemine yanlışlıkla React tıklama olayı geçirilmesi de eylem kancasında ayıklanır.
