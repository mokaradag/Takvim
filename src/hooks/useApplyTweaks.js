'use client';
import { useEffect } from 'react';
import { setAppDateDisplayFormat } from '../scheduling/dates';

const ACCENT_PRESETS = {
  '#3b82f6': { fg: 'white' },
  '#8b5cf6': { fg: 'white' },
  '#f43f5e': { fg: 'white' },
  '#10b981': { fg: 'white' },
  '#f59e0b': { fg: 'black' },
  '#0ea5e9': { fg: 'white' }
};

export function useApplyTweaks(tweaks) {
  // Tarih biçimi modül düzeyinde tutulur ve ÇİZİM SIRASINDA uygulanır: etki
  // olarak uygulansaydı seçim değiştikten sonraki ilk çizim boyunca eski biçim
  // görünür, tarihler bir kare geriden gelirdi. İşlem etkisizdir (idempotent).
  setAppDateDisplayFormat(tweaks.dateFormat || 'dd/mm/yyyy');

  useEffect(() => {
    const body = document.body;
    body.classList.toggle('theme-light', tweaks.theme === 'light');
    body.classList.toggle('theme-dark', tweaks.theme !== 'light');
  }, [tweaks.theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--accent', tweaks.accent);
    root.style.setProperty('--accent-strong', tweaks.accent);
    root.style.setProperty('--accent-soft', tweaks.accent + '20');
    root.style.setProperty('--accent-fg', (ACCENT_PRESETS[tweaks.accent] || {}).fg || 'white');
  }, [tweaks.accent]);

  useEffect(() => {
    const density = tweaks.density === 'compact' ? 0.85 : tweaks.density === 'spacious' ? 1.15 : 1;
    document.documentElement.style.setProperty('--density', String(density));
  }, [tweaks.density]);

  useEffect(() => {
    const scale = Number(tweaks.fontScale) || 1;
    document.body.style.zoom = String(scale);
    document.documentElement.style.setProperty('--app-viewport-h', `calc(100vh / ${scale})`);
    return () => document.documentElement.style.removeProperty('--app-viewport-h');
  }, [tweaks.fontScale]);

  useEffect(() => {
    document.body.classList.toggle('reduce-motion', !!tweaks.reduceMotion);
  }, [tweaks.reduceMotion]);

  useEffect(() => {
    document.body.classList.toggle('high-contrast', !!tweaks.highContrast);
  }, [tweaks.highContrast]);

  useEffect(() => {
    document.body.classList.toggle('no-emblem', !tweaks.showEmblem);
  }, [tweaks.showEmblem]);

  // Yeni ekranlarda DateInput kullanılıyor. Eski/ikincil bileşenlerde kalan native
  // tarih alanları için de Edge/Chromium tarih sırasını gün-ay-yıl olarak tutar.
  useEffect(() => {
    const applyDateLocale = (root = document) => {
      if (root.matches?.('input[type="date"]')) root.setAttribute('lang', 'en-GB');
      root.querySelectorAll?.('input[type="date"]').forEach((input) => input.setAttribute('lang', 'en-GB'));
    };

    applyDateLocale();
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) applyDateLocale(node);
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
}
