'use client';
import { useEffect } from 'react';

const ACCENT_PRESETS = {
  '#3b82f6': { fg: 'white' },
  '#8b5cf6': { fg: 'white' },
  '#f43f5e': { fg: 'white' },
  '#10b981': { fg: 'white' },
  '#f59e0b': { fg: 'black' },
  '#0ea5e9': { fg: 'white' }
};

export function useApplyTweaks(tweaks) {
  useEffect(() => {
    document.body.className = tweaks.theme === 'light' ? 'theme-light' : 'theme-dark';
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
    document.body.style.zoom = String(tweaks.fontScale || 1);
  }, [tweaks.fontScale]);

  useEffect(() => {
    document.body.classList.toggle('reduce-motion', !!tweaks.reduceMotion);
  }, [tweaks.reduceMotion]);

  useEffect(() => {
    document.body.classList.toggle('no-emblem', !tweaks.showEmblem);
  }, [tweaks.showEmblem]);
}
