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
    dataStatus,
    hasLoadedOnce,
    clearPersistenceError,
    hasPendingChanges,
    retryFailedChanges,
    reloadData
  } = useDataLifecycle();
  const [showSaved, setShowSaved] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (!lastSavedAt) return undefined;
    setShowSaved(true);
    const timer = setTimeout(() => setShowSaved(false), 1800);
    return () => clearTimeout(timer);
  }, [lastSavedAt]);

  const details = describeSaveError(saveError);
  // Veri zaten yüklüyse başarısız bir tazeleme uygulamayı kapatmaz; kullanıcı
  // mevcut verilerle çalışmayı sürdürür ve yenilemeyi buradan tekrar dener.
  const refreshFailed = dataStatus === 'error' && hasLoadedOnce;

  if (!isSaving && !details && !showSaved && !refreshFailed) return null;

  const reload = async ({ allowDiscard = false } = {}) => {
    setReloading(true);
    try {
      let result = await reloadData();
      if (!result?.ok && allowDiscard && hasPendingChanges()) {
        const discard = confirm('Kaydedilemeyen yerel değişiklikler atılıp sunucudaki veriler yüklensin mi?');
        if (discard) result = await reloadData({ discardFailedTaskUpdates: true });
      }
      if (result?.ok) clearPersistenceError();
    } finally {
      setReloading(false);
    }
  };

  // Reddedilen yama saklandı: kullanıcı düzenlemesini yeniden yazmak zorunda
  // kalmadan gönderebilir. "Verileri yeniden yükle" ise açık bir vazgeçmedir.
  const retry = async () => {
    setRetrying(true);
    try {
      const results = await retryFailedChanges();
      if ((results || []).every((result) => result?.ok)) clearPersistenceError();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className={`persistence-status${(details || refreshFailed) && !isSaving ? ' is-error' : ''}`} role="status" aria-live="polite">
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
            {hasPendingChanges() && (
              <button type="button" className="btn primary sm" onClick={retry} disabled={retrying || reloading}>
                {retrying ? 'Gönderiliyor...' : 'Yeniden dene'}
              </button>
            )}
            {details.canReload && (
              <button type="button" className="btn sm" onClick={() => reload({ allowDiscard: true })} disabled={reloading || retrying}>
                {reloading ? 'Yükleniyor...' : 'Verileri yeniden yükle'}
              </button>
            )}
            <button type="button" className="btn sm" onClick={clearPersistenceError}>Kapat</button>
          </div>
        </div>
      )}

      {!isSaving && !details && refreshFailed && (
        <div className="col" style={{ gap: 9 }}>
          <div className="persistence-status-head">
            <Icons.Alert size={14} />
            <strong>Veriler yenilenemedi</strong>
          </div>
          <p className="persistence-status-message">
            Görüntülenen veriler son başarılı yüklemeden geliyor. Bağlantı kurulduğunda yeniden deneyin.
          </p>
          <div className="row" style={{ gap: 7, justifyContent: 'flex-end' }}>
            <button type="button" className="btn primary sm" onClick={() => reload({ allowDiscard: true })} disabled={reloading}>
              {reloading ? 'Yükleniyor...' : 'Yeniden dene'}
            </button>
          </div>
        </div>
      )}

      {!isSaving && !details && !refreshFailed && showSaved && (
        <span className="persistence-status-line"><Icons.Check size={13} /> Kaydedildi</span>
      )}
    </div>
  );
}
