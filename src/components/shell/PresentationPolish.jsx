'use client';
import { useEffect } from 'react';

function applyPresentationPolish(root = document) {
  root.querySelectorAll('svg[preserveAspectRatio="none"]').forEach((svg) => {
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.shapeRendering = 'geometricPrecision';
    svg.style.textRendering = 'geometricPrecision';
    svg.querySelectorAll('line, polyline, path, circle').forEach((shape) => {
      shape.setAttribute('vector-effect', 'non-scaling-stroke');
    });
  });

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
    applyPresentationPolish();
    const observer = new MutationObserver(() => applyPresentationPolish());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
