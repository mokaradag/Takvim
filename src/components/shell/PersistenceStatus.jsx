'use client';
import { useEffect, useState } from 'react';
import { Icons } from '../icons';
import { useDataLifecycle } from '../../state/hooks';
import { describeSaveError } from './persistenceStatusMessage.js';

export function PersistenceStatus() {
  const {
    isSaving,
    saveError,
    lastSavedAt,
    clearPersistenceError,
    reloadData
  } = useDataLifecycle();
  const [showSaved, setShowSaved] = useState(false);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (!lastSavedAt) return undefined;
    setShowSaved(true);
    const timer = setTimeout(() => setShowSaved(false), 1800);
    return () => clearTimeout(timer);
  }, [lastSavedAt]);

  const details = describeSaveError(saveError);

  if (!isSaving && !details && !showSaved) return null;

  const reload = async () => {
    setReloading(true);
    try {
      await reloadData();
      clearPersistenceError();
    } finally {
      setReloading(false);
    }
  };

  return (
    <div className={`persistence-status${details && !isSaving ? ' is-error' : ''}`} role="status" aria-live="polite">
      {isSaving && <span className="persistence-status-line"><Icons.Clock size={13} /> Kaydediliyor...</span>}

      {!isSaving && details && (
        <div className="col" style={{ gap: 9 }}>
          <div className="persistence-status-head">
            <Icons.Alert size={14} />
            <strong>Kaydetme hatası</strong>
            <button type="button" className="icon-btn" onClick={clearPersistenceError} aria-label="Bildirimi kapat">
              <Icons.Close size={12} />
            </button>
          </div>
          {/* Kullanıcı hatanın gerçek nedenini görmeden düzeltme yapamaz:
              sunucu iletisi ve varsa alan/kod bilgisi doğrudan gösterilir. */}
          <p className="persistence-status-message">{details.message}</p>
          {(details.code || details.path || details.field) && (
            <div className="persistence-status-meta">
              {details.code && <span className="badge">{details.code}</span>}
              {details.field && <span className="badge">{details.field}</span>}
              {details.path && <span className="badge">{details.path}</span>}
            </div>
          )}
          <div className="row" style={{ gap: 7, justifyContent: 'flex-end' }}>
            {details.canReload && (
              <button type="button" className="btn primary sm" onClick={reload} disabled={reloading}>
                {reloading ? 'Yükleniyor...' : 'Verileri yeniden yükle'}
              </button>
            )}
            <button type="button" className="btn sm" onClick={clearPersistenceError}>Kapat</button>
          </div>
        </div>
      )}

      {!isSaving && !details && showSaved && (
        <span className="persistence-status-line"><Icons.Check size={13} /> Kaydedildi</span>
      )}
    </div>
  );
}
