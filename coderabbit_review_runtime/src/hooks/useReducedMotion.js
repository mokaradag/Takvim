'use client';
import { useEffect, useState } from 'react';

/**
 * "Hareketi azalt" tercihi ETKİN mi?
 *
 * İki kaynağın birleşimidir:
 *  - uygulamanın kendi ayarı (`body.reduce-motion`; ilk boyamadan önce
 *    yazılır, bkz. lib/tweaksBootstrap.js),
 *  - işletim sisteminin `prefers-reduced-motion` tercihi.
 *
 * CSS kuralları animasyonu kapatabilir ama JavaScript zamanlayıcılarını
 * durduramaz: yükleme adımlarını 900 ms'de bir değiştiren döngü, tercih açıkken
 * de çalışmaya devam ediyordu.
 */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
    const read = () => setReduced(
      document.body.classList.contains('reduce-motion') || Boolean(media?.matches)
    );

    read();
    media?.addEventListener?.('change', read);
    // Ayar React etkisinde gövde sınıfını değiştirir; gözlemci bunu yakalar.
    const observer = new MutationObserver(read);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => {
      media?.removeEventListener?.('change', read);
      observer.disconnect();
    };
  }, []);

  return reduced;
}
