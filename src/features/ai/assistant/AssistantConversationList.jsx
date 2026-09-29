'use client';
import { useEffect, useRef, useState } from 'react';
import { Icons } from '../../../components/icons';
import { Spinner } from '../../../components/Loader';
import { relativeTimeLabel } from './assistantPresentation.js';

/**
 * Son konuşmalar: son etkinliğe göre sıralı, sayfalı liste. Silme açık onay
 * ister; onay satırı açılınca odak "Vazgeç"e gider, kapanınca silme düğmesine
 * döner. Silinen konuşma yalnızca sunucu onayından sonra listeden düşer; odak
 * silinen satırın yerine gelen (ya da bir önceki) satıra, liste boşaldıysa
 * boş liste açıklamasına taşınır.
 */

function ConversationRow({ item, active, generating, deleting, confirming, onOpen, onAskDelete, onCancelDelete, onConfirmDelete, openRef, now }) {
  const cancelRef = useRef(null);
  const deleteRef = useRef(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (wasConfirming.current) deleteRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  if (confirming) {
    return (
      <li className="rota-assistant-history-item is-confirming">
        <p className="rota-assistant-history-confirm" id={`rota-assistant-delete-${item.id}`}>
          <strong>“{item.title}”</strong> silinsin mi? Konuşma ve iletileri kalıcı olarak silinir.
        </p>
        <div className="rota-assistant-history-confirm-actions">
          <button ref={cancelRef} type="button" className="btn ghost sm" onClick={onCancelDelete} disabled={deleting}>Vazgeç</button>
          <button
            type="button"
            className="btn danger sm"
            onClick={onConfirmDelete}
            disabled={deleting}
            aria-busy={deleting || undefined}
            aria-describedby={`rota-assistant-delete-${item.id}`}
          >
            <Icons.Trash size={12} aria-hidden="true" /> {deleting ? 'Siliniyor…' : 'Sil'}
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className={`rota-assistant-history-item${active ? ' is-active' : ''}`}>
      <button ref={openRef} type="button" className="rota-assistant-history-open" onClick={() => onOpen(item.id)} aria-current={active ? 'true' : undefined}>
        <span className="rota-assistant-history-title">{item.title}</span>
        <span className="rota-assistant-history-meta">
          {generating ? <span className="rota-assistant-history-live">Yanıt hazırlanıyor…</span> : relativeTimeLabel(item.updatedAt, now)}
        </span>
      </button>
      <button
        ref={deleteRef}
        type="button"
        className="rota-assistant-icon-action"
        onClick={onAskDelete}
        disabled={deleting}
        aria-label={`“${item.title}” konuşmasını sil`}
        title="Sil"
      >
        <Icons.Trash size={13} aria-hidden="true" />
      </button>
    </li>
  );
}

export function AssistantConversationList({
  list,
  activeId = null,
  running = {},
  deleting = {},
  onOpen,
  onDelete,
  onLoadMore,
  onReload,
  limit = null,
  now: suppliedNow
}) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (suppliedNow != null) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 60000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [suppliedNow]);
  const now = suppliedNow ?? clock;
  const [confirmingId, setConfirmingId] = useState(null);
  const items = limit ? list.items.slice(0, limit) : list.items;
  const openButtons = useRef(new Map());
  const emptyRef = useRef(null);
  const pendingFocus = useRef(null);
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || items.some((item) => item.id === pending.removedId)) return;
    pendingFocus.current = null;
    const target = items[Math.min(pending.index, items.length - 1)];
    (target ? openButtons.current.get(target.id) : emptyRef.current)?.focus?.();
  });

  if (list.loading && !list.items.length) {
    return <p className="rota-assistant-history-state"><Spinner size={13} /> Konuşmalar yükleniyor…</p>;
  }
  if (list.error && !list.items.length) {
    return (
      <div className="rota-assistant-history-state">
        <p>{list.error.title}. {list.error.message}</p>
        <button type="button" className="btn sm" onClick={onReload}><Icons.Refresh size={12} aria-hidden="true" /> Yeniden dene</button>
      </div>
    );
  }
  if (!items.length) {
    return <p ref={emptyRef} tabIndex={-1} className="rota-assistant-history-state">Henüz kaydedilmiş bir konuşma yok.</p>;
  }

  return (
    <>
      <ul className="rota-assistant-history" aria-label="Son konuşmalar">
        {items.map((item, index) => (
          <ConversationRow
            key={item.id}
            item={item}
            openRef={(node) => {
              if (node) openButtons.current.set(item.id, node);
              else openButtons.current.delete(item.id);
            }}
            now={now}
            active={item.id === activeId}
            generating={Boolean(running[item.id])}
            deleting={Boolean(deleting[item.id])}
            confirming={confirmingId === item.id}
            onOpen={onOpen}
            onAskDelete={() => setConfirmingId(item.id)}
            onCancelDelete={() => setConfirmingId(null)}
            onConfirmDelete={async () => {
              const result = await onDelete(item.id);
              if (result?.ok !== false) {
                pendingFocus.current = { removedId: item.id, index };
                setConfirmingId(null);
              }
            }}
          />
        ))}
      </ul>
      {list.error && list.items.length > 0 && (
        <p className="rota-assistant-history-state is-warn" role="status">{list.error.title}. {list.error.message}</p>
      )}
      {!limit && list.nextCursor && (
        <button type="button" className="btn ghost sm rota-assistant-history-more" onClick={onLoadMore} disabled={list.loadingMore} aria-busy={list.loadingMore || undefined}>
          {list.loadingMore ? 'Yükleniyor…' : 'Daha eski konuşmalar'}
        </button>
      )}
    </>
  );
}
