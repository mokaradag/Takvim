'use client';
import { useEffect, useState } from 'react';
import { useDataLifecycle } from '../../state/hooks';

export function PersistenceStatus() {
  const {
    isSaving,
    saveError,
    lastSavedAt,
    clearPersistenceError
  } = useDataLifecycle();
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    if (!lastSavedAt) return undefined;
    setShowSaved(true);
    const timer = setTimeout(() => setShowSaved(false), 1800);
    return () => clearTimeout(timer);
  }, [lastSavedAt]);

  if (!isSaving && !saveError && !showSaved) return null;

  return (
    <div
      style={{
        position: 'fixed',
        right: 18,
        bottom: 18,
        zIndex: 130,
        maxWidth: 360,
        padding: '9px 12px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-md)',
        background: 'var(--bg-elev)',
        boxShadow: 'var(--shadow-lg)'
      }}
    >
      {isSaving && <span style={{ fontSize: 12.5, fontWeight: 600 }}>Kaydediliyor...</span>}
      {!isSaving && saveError && (
        <div className="row" style={{ gap: 10 }}>
          <span style={{ color: 'var(--status-overdue)', fontSize: 12.5, fontWeight: 600 }}>Kaydetme hatası</span>
          <button className="btn" onClick={clearPersistenceError}>Kapat</button>
        </div>
      )}
      {!isSaving && !saveError && showSaved && (
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>Kaydedildi</span>
      )}
    </div>
  );
}
