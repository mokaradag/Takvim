'use client';
import { useEffect, useRef } from 'react';
import { PRESENCE_HEARTBEAT_INTERVAL_MS } from '../domain/presence/presenceModel.js';
import {
  PRESENCE_LEADER_STORAGE_KEY,
  parsePresenceLock,
  serializePresenceLock,
  shouldClaimPresenceLeadership
} from '../domain/presence/presenceLeader.js';
import { sendPresenceHeartbeat } from '../data/api/presenceClient.js';

/**
 * Kimliği doğrulanmış kullanıcı nabzı.
 *
 * Nabız OLAĞAN İSTEKLERE bağlı değildir: yalnızca uygulama açık, sekme görünür
 * ve kullanıcı Gerçek Sistem kipinde oturum açmışken, sabit aralıkla gönderilir.
 * Aynı tarayıcıdaki sekmeler paylaşılan bir kilitle tek önder seçer; kapanan ya
 * da donan önderin kilidi bayatlayınca başka bir sekme devralır.
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

    const tick = async () => {
      timer = null;
      if (cancelled || inFlight) return;
      if (!hidden() && leads()) {
        inFlight = true;
        try { await sendPresenceHeartbeat(); } catch { /* nabız en iyi çabadır */ }
        finally { inFlight = false; }
      }
      if (!cancelled) schedule();
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(tick, intervalMs);
    };

    tick();
    const onVisibility = () => { if (!hidden() && !timer && !inFlight) tick(); };
    document?.addEventListener?.('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document?.removeEventListener?.('visibilitychange', onVisibility);
    };
  }, [enabled, intervalMs]);
}
