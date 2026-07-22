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
    const observer = new MutationObserver(() => hideTechnicalGanttWarnings());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
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
