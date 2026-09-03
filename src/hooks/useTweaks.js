'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

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
  const hydrated = useRef(false);

  // Kalıcılık ÇİZİMDEN SONRA uygulanır. Yazma durum güncelleyicisinin içindeydi;
  // React bir güncelleyiciyi birden çok kez çalıştırabildiği için (Strict Mode,
  // yarıda kesilen render) yan etki tekrarlanabiliyor ya da işlenmeyen bir
  // durumu kalıcılaştırabiliyordu. Güncelleyici artık saf, kaydedilen değer de
  // her zaman çizilen değerdir.
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(values)); } catch { /* depolama kapalı olabilir */ }
  }, [values]);

  // Accepts either setTweak('key', value) or setTweak({ key: value, ... }).
  const setTweak = useCallback((keyOrEdits, val) => {
    const edits = typeof keyOrEdits === 'object' && keyOrEdits !== null
      ? keyOrEdits : { [keyOrEdits]: val };
    setValues((prev) => ({ ...prev, ...edits }));
  }, []);

  return [values, setTweak];
}
