'use client';
import { useEffect, useRef } from 'react';
import { PRESENCE_HEARTBEAT_INTERVAL_MS } from '../domain/presence/presenceModel.js';
import {
  PRESENCE_LEADER_STORAGE_KEY,
  nextPresenceTickDelay,
  parsePresenceLock,
  serializePresenceLock,
  shouldClaimPresenceLeadership,
  shouldReleasePresenceLock
} from '../domain/presence/presenceLeader.js';
import { sendPresenceHeartbeat } from '../data/api/presenceClient.js';

/**
 * Kimliği doğrulanmış kullanıcı nabzı.
 *
 * Nabız OLAĞAN İSTEKLERE bağlı değildir: yalnızca uygulama açık, sekme görünür
 * ve kullanıcı Gerçek Sistem kipinde oturum açmışken, sabit aralıkla gönderilir.
 * Aynı tarayıcıdaki sekmeler paylaşılan bir kilitle tek önder seçer.
 *
 * Önder gizlendiğinde, kapandığında ya da etki söküldüğünde kilidini BIRAKIR;
 * görünür izleyici kilidi sık yoklar ve boşalan önderliği hemen devralır.
 * Görünür olan sekme beklemeden bir tur başlatır. Donan önderin kilidi ise
 * bayatlayınca devralınır; en kötü durum aktiflik penceresinin içinde kalır
 * (bkz. domain/presence/presenceLeader.js).
 *
 * Tarayıcı kapanışı, ağ kesintisi ve oturum düşmesi ayrıca ele alınmaz: nabız
 * durur ve kullanıcı aktiflik penceresi dolunca listeden kendiliğinden çıkar.
 */
function storage() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function usePresenceHeartbeat(enabled, { intervalMs = PRESENCE_HEARTBEAT_INTERVAL_MS } = {}) {
  const tabIdRef = useRef(null);
  if (!tabIdRef.current) {
    tabIdRef.current = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    let cancelled = false;
    let timer = null;
    let inFlight = false;

    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const leads = () => {
      const store = storage();
      // Paylaşılan depo yoksa (özel kip, engellenmiş çerezler) her sekme kendi
      // nabzını gönderir; Sicil başına tek satır yazıldığı için maliyet sınırlı.
      if (!store) return true;
      try {
        const lock = parsePresenceLock(store.getItem(PRESENCE_LEADER_STORAGE_KEY));
        if (!shouldClaimPresenceLeadership(lock, tabIdRef.current, Date.now())) return false;
        store.setItem(PRESENCE_LEADER_STORAGE_KEY, serializePresenceLock(tabIdRef.current, Date.now()));
        return true;
      } catch {
        return true;
      }
    };
    const release = () => {
      const store = storage();
      if (!store) return;
      try {
        const lock = parsePresenceLock(store.getItem(PRESENCE_LEADER_STORAGE_KEY));
        if (shouldReleasePresenceLock(lock, tabIdRef.current)) store.removeItem(PRESENCE_LEADER_STORAGE_KEY);
      } catch { /* kilit en iyi çabadır */ }
    };

    const schedule = (delay) => {
      clearTimeout(timer);
      timer = setTimeout(tick, delay);
    };
    async function tick() {
      clearTimeout(timer);
      timer = null;
      if (cancelled || inFlight) return;
      const isHidden = hidden();
      const leader = !isHidden && leads();
      if (leader) {
        inFlight = true;
        try { await sendPresenceHeartbeat(); } catch { /* nabız en iyi çabadır */ }
        finally { inFlight = false; }
      }
      if (!cancelled) schedule(nextPresenceTickDelay({ leader, hidden: isHidden, intervalMs }));
    }

    tick();
    const onVisibility = () => {
      if (hidden()) {
        release();
        return;
      }
      if (!inFlight) tick();
    };
    document?.addEventListener?.('visibilitychange', onVisibility);
    window.addEventListener?.('pagehide', release);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      release();
      document?.removeEventListener?.('visibilitychange', onVisibility);
      window.removeEventListener?.('pagehide', release);
    };
  }, [enabled, intervalMs]);
}
