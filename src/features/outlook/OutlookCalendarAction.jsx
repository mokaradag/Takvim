'use client';
import { useEffect, useRef, useState } from 'react';
import { Icons } from '../../components/icons';
import { Spinner } from '../../components/Loader';
import { outlookActionAvailability } from './outlookPresentation.js';
import {
  addTaskToOutlook,
  isTaskBusy,
  isTaskInOutlook,
  outlookTaskState,
  removeTaskFromOutlook,
  resendOutlookInvitation
} from './outlookSubscriptionStore.js';
import { useOutlookCalendar } from './useOutlookCalendar.js';

// Eylemler ENJEKTE EDİLEBİLİR: testler sunucuya gitmeden gerçek bileşen
// mantığını çalıştırır. Üretimde varsayılanlar kullanılır.
const DEFAULT_ACTIONS = Object.freeze({
  add: addTaskToOutlook,
  resend: resendOutlookInvitation,
  remove: removeTaskFromOutlook
});

/**
 * "Outlook'a Ekle" eylemi.
 *
 * Hem düzenlenebilir hem SALT OKUNUR görev panelinde durur: görevi GÖREBİLEN
 * herkes onu kendi takvimine ekleyebilir, görev düzenleme yetkisi aranmaz.
 * Yetki her istekte sunucuda yeniden denetlenir; buradaki görünürlük yalnızca
 * arayüz kolaylığıdır.
 *
 * Eklendikten sonra eylem sıkışık bir menüye dönüşür (yeniden gönder ·
 * kaldır); ayrı bir kart, rozet ya da onay penceresi açılmaz.
 */
export function OutlookCalendarAction({ task, disabledReason = null, actions = DEFAULT_ACTIONS }) {
  const { state, actualDataMode } = useOutlookCalendar();
  const [result, setResult] = useState(null);
  const [open, setOpen] = useState(false);
  const mountedRef = useRef(true);
  const containerRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (!result) return undefined;
    const timer = setTimeout(() => { if (mountedRef.current) setResult(null); }, 6000);
    return () => clearTimeout(timer);
  }, [result]);
  // Menü dışarı tıklamayla ve Esc ile kapanır; kalıcı bir açık katman bırakmaz.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const close = (event) => {
      if (event.type === 'keydown') {
        if (event.key !== 'Escape') return;
        // Aynı Escape olayı üst görev panelinin focus trap'ine de gider.
        // Varsayılanı önlemek, yalnızca Outlook menüsünü kapatıp paneli açık tutar.
        event.preventDefault();
      }
      if (event.type === 'pointerdown' && containerRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', close, true);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', close, true);
    };
  }, [open]);

  const availability = outlookActionAvailability({ actualDataMode, state, task });
  // Demo Kipte hiçbir görev "eklendi" görünmez: abone kümesi Gerçek Sistem
  // kimliklerinden kurulur ve demo verisiyle karıştırılmamalıdır.
  const subscribed = actualDataMode && isTaskInOutlook(state, task?.id);
  const delivery = outlookTaskState(state, task?.id);
  const deliveryLabel = delivery.failureCode ? "Outlook gönderimi başarısız"
    : delivery.pending ? "Outlook gönderimi bekliyor" : delivery.delivered ? "Outlook'a eklendi" : "Outlook gönderimi bekliyor";
  const busy = isTaskBusy(state, task?.id);
  const blocked = disabledReason || availability.reason;
  const disabled = busy || Boolean(blocked);

  // Kaldırma, eylemin kapalı olduğu durumlarda da çalışır: termini silinmiş ya
  // da düzenlemesi kaydedilmemiş bir görev takvimden ÇIKARILABİLMELİDİR.
  const run = (action, { whenBlocked = false } = {}) => async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy || (!whenBlocked && blocked)) return;
    setOpen(false);
    setResult(null);
    let next;
    try {
      const response = await action(task.id);
      next = response.ok
        ? { tone: 'success', text: response.message || 'İşlem tamamlandı.' }
        : { tone: 'error', text: response.message || 'Outlook takvim işlemi tamamlanamadı.' };
    } catch {
      next = { tone: 'error', text: 'Outlook takvim işlemi tamamlanamadı.' };
    }
    if (!mountedRef.current) return;
    setResult(next);
  };

  const add = run(actions.add);
  const resend = run(actions.resend);
  const remove = run(actions.remove, { whenBlocked: true });

  const title = blocked
    || (busy ? 'Outlook takvimi güncelleniyor…' : (subscribed
      ? deliveryLabel
      : 'Görevi kendi Outlook takviminize ekleyin'));

  return (
    <span className="outlook-action" ref={containerRef} onClick={(event) => event.stopPropagation()}>
      {subscribed ? (
        <span className="outlook-action-menu">
          <button
            type="button"
            className="btn sm outlook-action-button is-added"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-busy={busy}
            disabled={busy || !actualDataMode || state.status !== 'ready' || !state.enabled || !state.schemaReady}
            title={title}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen((value) => !value); }}
          >
            {busy ? <Spinner size={13} /> : delivery.delivered && !delivery.pending ? <Icons.Check size={13} /> : <Icons.Calendar size={13} />}
            <span>{deliveryLabel}</span>
            <Icons.ChevronDown size={11} />
          </button>
          {open && (
            <span className="outlook-action-pop" role="menu">
              <button type="button" role="menuitem" onClick={resend} disabled={disabled}>
                <Icons.Mail size={13} /> Outlook davetini yeniden gönder
              </button>
              <button type="button" role="menuitem" onClick={remove} disabled={busy || !actualDataMode || state.status !== 'ready' || !state.enabled || !state.schemaReady}>
                <Icons.Close size={13} /> Outlook&apos;tan kaldır
              </button>
            </span>
          )}
        </span>
      ) : (
        <button
          type="button"
          className="btn sm outlook-action-button"
          disabled={disabled}
          aria-busy={busy}
          title={title}
          onClick={add}
        >
          {busy ? <Spinner size={13} /> : <Icons.Calendar size={13} />}
          <span>{busy ? 'Ekleniyor…' : "Outlook'a Ekle"}</span>
        </button>
      )}
      {result && <span className={`outlook-action-result ${result.tone}`} role="status">{result.text}</span>}
    </span>
  );
}