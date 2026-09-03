/**
 * Görünüm tercihlerinin İLK BOYAMADAN önce uygulanması.
 *
 * `useApplyTweaks` gövde sınıflarını bir React etkisinde yazar ve yalnızca
 * `AppShell` monte edildikten sonra çalışır. `ApplicationRoot` ise ondan önce
 * Veri Modu penceresini, kurumsal oturum kapısını ve yükleme ekranını çizer:
 * yüksek karşıtlığı açmış bir kullanıcı, bu uzun ömürlü ekranlar boyunca
 * erişilebilirlik ayarını kaybediyordu. "Hareketi azalt" ise daha da geç
 * uygulandığı için mod seçim penceresinin giriş animasyonu her açılışta bir kez
 * görünüyordu.
 *
 * Yazı ÖLÇEĞİ de aynı nedenle burada uygulanır: yalnızca `useApplyTweaks`
 * içinde yazıldığında, büyütülmüş yazı seçen kullanıcı bu ekranları %100'de
 * görüyor ve `AppShell` monte olduğunda ekran bir kez zıplıyordu.
 *
 * Bu yüzden saklanan tercihler, uygulama paketi çalışmadan ÖNCE gövdeye
 * yazılır. Betik `<body>` etiketinin İLK ÇOCUĞU olarak engelleyici çalışır
 * (bkz. app/layout.js); `document.body` o anda vardır. Tek yaptığı
 * `localStorage` okuyup sınıf/stil yazmaktır.
 */

export const TWEAKS_STORAGE_KEY = 'mergen_rota_tweaks_v1';

/** Gövde sınıflarını saklanan tercihlerden türetir. */
export function bodyClassesForTweaks(tweaks = {}) {
  const classes = [tweaks.theme === 'light' ? 'theme-light' : 'theme-dark'];
  if (tweaks.reduceMotion) classes.push('reduce-motion');
  if (tweaks.highContrast) classes.push('high-contrast');
  if (tweaks.showEmblem === false) classes.push('no-emblem');
  return classes;
}

/** Yazı ölçeğinin gövde/kök değişkenleri (bkz. hooks/useApplyTweaks.js). */
export function fontScaleStyleForTweaks(tweaks = {}) {
  const scale = Number(tweaks.fontScale) || 1;
  return {
    zoom: String(scale),
    // `zoom` genişliği de ölçekler; görünüm alanı değişkenleri bu yüzden aynı
    // oranda geri bölünür.
    viewportHeight: `calc(100vh / ${scale})`,
    viewportWidth: `calc(100vw / ${scale})`
  };
}

/**
 * `<body>` etiketinin ilk çocuğu olarak gömülen engelleyici betik.
 *
 * Kaynak metin olarak tutulur çünkü paket yüklenmeden çalışması gerekir.
 * Depolama okunamıyorsa (gizli sekme, kapalı çerezler) sessizce varsayılanla
 * devam eder: erişilebilirlik ayarı bir hata yüzünden uygulamayı kilitlemez.
 */
export const TWEAKS_BOOTSTRAP_SCRIPT = `(function(){try{
var raw=localStorage.getItem(${JSON.stringify(TWEAKS_STORAGE_KEY)});
var p=raw?JSON.parse(raw):{};
var t=p&&typeof p==='object'&&!Array.isArray(p)?p:{};
var c=document.body.classList;
c.toggle('theme-light',t.theme==='light');
c.toggle('theme-dark',t.theme!=='light');
c.toggle('reduce-motion',!!t.reduceMotion);
c.toggle('high-contrast',!!t.highContrast);
c.toggle('no-emblem',t.showEmblem===false);
var s=Number(t.fontScale)||1;
document.body.style.zoom=String(s);
var r=document.documentElement.style;
r.setProperty('--app-viewport-h','calc(100vh / '+s+')');
r.setProperty('--app-viewport-w','calc(100vw / '+s+')');
}catch(e){}})();`;
