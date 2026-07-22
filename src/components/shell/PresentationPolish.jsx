'use client';
import { useEffect } from 'react';

const TEXT_REPLACEMENTS = [
  ['Kritik CPM görevi', 'Kritik yol görevi'],
  ['CPM Bitiş', 'Kritik Yol Bitişi'],
  ['CPM Durumu', 'Kritik Yol Durumu'],
  ['CPM uyarısı', 'Zamanlama uyarısı'],
  ['CPM ·', 'Kritik Yol ·']
];

function polishTerminology(root) {
  const content = root.querySelector?.('.content') || (root.classList?.contains('content') ? root : null);
  if (!content) return;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    let value = node.nodeValue;
    for (const [from, to] of TEXT_REPLACEMENTS) value = value.replaceAll(from, to);
    if (value !== node.nodeValue) node.nodeValue = value;
    node = walker.nextNode();
  }
}

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

  polishTerminology(root);
}

export function PresentationPolish() {
  useEffect(() => {
    applyPresentationPolish();
    const observer = new MutationObserver(() => applyPresentationPolish());
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
