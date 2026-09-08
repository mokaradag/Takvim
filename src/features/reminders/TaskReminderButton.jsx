'use client';
import { useEffect, useRef, useState } from 'react';
import { Icons } from '../../components/icons';
import { DATA_MODES } from '../../data/dataMode.js';
import { useDataMode } from '../../components/shell/DataModeContext.jsx';
import { useTaskActions } from '../../state/hooks';
import { sendTaskReminderRequest } from './reminderClient.js';

/**
 * "Hatırlatma e-postası gönder" eylemi.
 *
 * Silme simgesinin YANINDA durur ve hem Temel hem Kapsamlı Kipte aynı biçimde
 * çalışır. Üç davranış bilinçlidir:
 *
 *  - İstek sürerken düğme kapatılır: art arda tıklamak kopya ileti üretmez.
 *  - Başarı yalnızca SUNUCU iletiyi kabul ettiğinde bildirilir; istemci
 *    iyimser bir "gönderildi" göstermez.
 *  - Eylem yalnızca posta gönderir; görevi hiçbir biçimde değiştirmez ya da
 *    silmez (satır tıklamasını da yutar).
 *  - Bekleyen görev düzenlemeleri ÖNCE kalıcılaştırılır: sunucu görevi ve
 *    sorumlularını SQL'den yeniden okur, kuyrukta bekleyen bir termin/sorumlu
 *    değişikliği boşaltılmasaydı ileti eski veriyle ve eski alıcılara giderdi.
 */
export function TaskReminderButton({ task, size = 26, onResult = null, disabledReason = null }) {
  const { dataMode } = useDataMode();
  const { flushTaskEdits } = useTaskActions();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const mountedRef = useRef(true);

  // StrictMode geliştirmede etkileri kur → söküp → yeniden kur biçiminde
  // çalıştırır. Bayrak yalnızca sökümde değiştirilseydi ikinci kurulumdan sonra
  // `false` kalır, yanıt geldiğinde durum hiç güncellenmez ve düğme sonsuza dek
  // "gönderiliyor" görünürdü.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (!result) return undefined;
    const timer = setTimeout(() => { if (mountedRef.current) setResult(null); }, 6000);
    return () => clearTimeout(timer);
  }, [result]);

  const demo = dataMode !== DATA_MODES.ACTUAL;
  const disabled = busy || demo || !task?.id || Boolean(disabledReason);

  const send = async (event) => {
    event.stopPropagation();
    event.preventDefault();
    if (disabled) return;
    setBusy(true);
    setResult(null);
    // `busy` bayrağı HER YOLDA temizlenir: beklenen çağrılardan biri
    // reddedildiğinde (kalıcılık katmanından gelen bir hata gerçekçi bir
    // tetikleyicidir) düğme kalıcı olarak devre dışı kalıyor, kullanıcı ne
    // yeniden deneyebiliyor ne de bir ileti görebiliyordu.
    let next = null;
    try {
      // Kuyruk boşaltılamazsa gönderim YAPILMAZ: eski veriyle posta atmaktansa
      // kullanıcıya kaydedilemeyen düzenleme olduğunu söylemek doğrudur.
      const flushed = await flushTaskEdits?.(task.id);
      if (flushed && flushed.ok === false) {
        next = {
          type: 'error',
          text: 'Görevdeki değişiklikler kaydedilemedi; hatırlatma gönderilmedi.'
        };
      } else {
        const response = await sendTaskReminderRequest(task.id);
        next = response.ok
          ? {
            type: response.warnings?.length ? 'warning' : 'success',
            text: response.warnings?.length
              ? `${response.message} Uyarı: ${response.warnings.join(' ')}`
              : response.message
          }
          : { type: 'error', text: response.message };
      }
    } catch {
      next = { type: 'error', text: 'Hatırlatma gönderilemedi. Lütfen yeniden deneyin.' };
    } finally {
      if (mountedRef.current) setBusy(false);
    }
    if (!mountedRef.current) return;
    setResult(next);
    onResult?.(next);
  };

  const title = disabledReason || (demo
    ? 'Hatırlatma e-postası yalnızca Gerçek Sistem verisiyle gönderilir.'
    : busy
      ? 'Hatırlatma gönderiliyor…'
      : 'Hatırlatma e-postası gönder');

  return (
    <span className="task-reminder-action" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className={`icon-btn task-reminder-button${busy ? ' is-busy' : ''}`}
        style={{ width: size, height: size }}
        disabled={disabled}
        aria-busy={busy}
        aria-label="Hatırlatma e-postası gönder"
        title={title}
        onClick={send}
      >
        {busy ? <Icons.Clock size={13} /> : <Icons.Mail size={13} />}
      </button>
      {result && (
        <span className={`task-reminder-result ${result.type}`} role="status">{result.text}</span>
      )}
    </span>
  );
}
