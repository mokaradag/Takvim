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
 * Bu yüzden saklanan tercihler, uygulama paketi çalışmadan ÖNCE gövdeye
 * yazılır. Betik `<head>` içinde engelleyici olarak çalışır; tek yaptığı
 * `localStorage` okuyup sınıf eklemektir.
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

/**
 * `<head>` içine gömülen engelleyici betik.
 *
 * Kaynak metin olarak tutulur çünkü paket yüklenmeden çalışması gerekir.
 * Depolama okunamıyorsa (gizli sekme, kapalı çerezler) sessizce varsayılanla
 * devam eder: erişilebilirlik ayarı bir hata yüzünden uygulamayı kilitlemez.
 */
export const TWEAKS_BOOTSTRAP_SCRIPT = `(function(){try{
var raw=localStorage.getItem(${JSON.stringify(TWEAKS_STORAGE_KEY)});
var t=raw?JSON.parse(raw):{};
var c=document.body.classList;
c.toggle('theme-light',t.theme==='light');
c.toggle('theme-dark',t.theme!=='light');
c.toggle('reduce-motion',!!t.reduceMotion);
c.toggle('high-contrast',!!t.highContrast);
c.toggle('no-emblem',t.showEmblem===false);
}catch(e){}})();`;
