# MERGEN Rota — Otomatik Kurumsal Oturum Önyüklemesi

## Amaç

Gerçek Sistem seçiliyken uygulama veri uçlarını çağırmadan önce kurumsal oturumu denetler. Oturum yoksa kullanıcıdan uygulama içinde yeniden bir düğmeye basması beklenmez; tarayıcı doğrudan seçili Keycloak akışını başlatan `/api/mergen-rota/auth/login` ucuna yönlendirilir.

Bu düzen şu iki sorunu önler:

- ilk açılışta `GET /api/mergen-rota/snapshot` isteğinin oturumsuz çalışması,
- beklenen `SESSION_REQUIRED` durumunun sunucu konsolunda `ServerPersistenceError` yığın dökümü olarak görünmesi.

## Açılış sırası

```text
Gerçek Sistem seçimi
  → GET /api/mergen-rota/auth/status
  → authenticated: true
      → AppStateProvider kurulur
      → session ve snapshot yüklenir
  → authenticated: false
      → /api/mergen-rota/auth/login?returnTo=<uygulama-kökü>
      → Keycloak / implicit köprü
      → HttpOnly MERGEN Rota oturumu
      → uygulamaya dönüş
```

`AppStateProvider`, durum ucu doğrulanmış oturum bildirmeden kurulmaz. Böylece SQL ve proje verisi uçları kimlik doğrulama tamamlanmadan çağrılmaz.

## Oturum durum ucu

`GET /api/mergen-rota/auth/status` yalnızca sunucunun güvendiği oturum sağlayıcısını denetler. SQL sorgusu çalıştırmaz ve kimlik alanlarını yanıta koymaz.

Başarılı yanıtlar:

```json
{ "authenticated": true }
```

```json
{ "authenticated": false }
```

Oturum bulunmaması normal bir açılış durumudur; bu nedenle ikinci yanıt da HTTP 200 döner. Yapılandırma bozukluğu veya doğrulanmış ancak geçersiz kimlik gibi gerçek hatalar güvenli hata yanıtıyla bildirilir.

Tüm yanıtlar `Cache-Control: no-store, max-age=0` taşır.

## Veri modları

- **Gerçek Sistem:** Otomatik kurumsal oturum denetimi zorunludur.
- **Demo Modu:** Keycloak denetimi yapılmaz ve uygulama doğrudan açılır.

Oturum sunucusuna ulaşılamazsa kullanıcıya `Yeniden Dene` ve `Demo moduna geç` seçenekleri gösterilir. Oturumun veri yüklemesi sırasında sona ermesi durumunda `AppDataBoundary` aynı giriş ucuna otomatik yönlendirme yapan yedek sınır olarak çalışır.

## Günlük davranışı

`SESSION_REQUIRED`, oturum açma yönlendirmesini başlatan beklenen durumdur. Bu kod güvenli 401 yanıtına çevrilmeye devam eder ancak `MERGEN ROTA SERVER ERROR` yığın dökümü üretmez. Diğer sunucu hataları konsola yazılmayı sürdürür.

## Doğrulama

```bash
npm test
npm run build
```

Özellikle `test/automatic-auth-bootstrap.test.mjs` şu sözleşmeleri denetler:

- eksik oturumun 200 ve `{ authenticated: false }` dönmesi,
- doğrulanmış kimliğin yanıta sızmaması,
- istemci denetiminin `same-origin` ve `no-store` kullanması,
- Gerçek Sistem sağlayıcısının oturum denetlenmeden kurulmaması,
- elle kullanılan `Kurumsal oturum aç` kutusunun kaldırılması,
- `SESSION_REQUIRED` için hata yığını yazılmaması.
