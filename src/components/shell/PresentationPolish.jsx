'use client';
import { useEffect } from 'react';

function hideTechnicalGanttWarnings(root = document) {
  root.querySelectorAll('.gantt-wrap').forEach((wrap) => {
    const candidate = wrap.previousElementSibling?.previousElementSibling;
    if (candidate?.textContent?.includes('CPM zamanlama uyarıları')) {
      candidate.style.display = 'none';
      candidate.setAttribute('aria-hidden', 'true');
    }
  });
}

export function PresentationPolish() {
  useEffect(() => {
    hideTechnicalGanttWarnings();
    // Gözlemci `document.body` altındaki HER `childList` değişimini izler ve
    // geri çağrının kendisi belgenin tamamında `querySelectorAll` çalıştırır.
    // Büyük tablolar (görev listesi, Gantt satırları) tek çizimde yüzlerce
    // değişiklik yığını ürettiği için bu tam-belge sorgusu çizim boyunca
    // defalarca tekrarlanıyordu; çağrılar tek bir kareye toplanır.
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        hideTechnicalGanttWarnings();
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <style jsx global>{`
      .chart-line,
      .chart-dot,
      .card svg line,
      .card svg polyline,
      .card svg circle {
        vector-effect: non-scaling-stroke;
        shape-rendering: geometricPrecision;
      }
    `}</style>
  );
}
