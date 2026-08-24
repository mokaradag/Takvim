'use client';
import { useCallback, useState } from 'react';

import { TWEAKS_STORAGE_KEY } from '../lib/tweaksBootstrap.js';

// Sürümlü depolama anahtarı `mergen_rota_tweaks_v1` tek yerde tanımlıdır: ilk
// boyamadan önce çalışan bootstrap betiği de aynı girdiyi okur.
const STORAGE_KEY = TWEAKS_STORAGE_KEY;

function loadStored(defaults) {
  if (typeof window === 'undefined') return defaults;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch {
    return defaults;
  }
}

// Single source of truth for tweak values (theme, density, accent, font
// scale, ...). Persists to localStorage so preferences survive reloads.
export function useTweaks(defaults) {
  const [values, setValues] = useState(() => loadStored(defaults));

  // Accepts either setTweak('key', value) or setTweak({ key: value, ... }).
  const setTweak = useCallback((keyOrEdits, val) => {
    const edits = typeof keyOrEdits === 'object' && keyOrEdits !== null
      ? keyOrEdits : { [keyOrEdits]: val };
    setValues((prev) => {
      const next = { ...prev, ...edits };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  return [values, setTweak];
}
