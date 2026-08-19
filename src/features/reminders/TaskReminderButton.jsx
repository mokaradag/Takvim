'use client';
import { useEffect, useRef, useState } from 'react';
import { Icons } from '../../components/icons';
import { DATA_MODES } from '../../data/dataMode.js';
import { useDataMode } from '../../components/shell/DataModeContext.jsx';
import { sendTaskReminderRequest } from './reminderClient.js';

/**
 * "Hatırlatma e-postası gönder" eylemi.
 *
 * Silme simgesinin YANINDA durur ve hem Basit hem Gelişmiş Modda aynı biçimde
 * çalışır. Üç davranış bilinçlidir:
 *
 *  - İstek sürerken düğme kapatılır: art arda tıklamak kopya ileti üretmez.
 *  - Başarı yalnızca SUNUCU iletiyi kabul ettiğinde bildirilir; istemci
 *    iyimser bir "gönderildi" göstermez.
 *  - Eylem yalnızca posta gönderir; görevi hiçbir biçimde değiştirmez ya da
 *    silmez (satır tıklamasını da yutar).
 */
export function TaskReminderButton({ task, size = 26, onResult = null }) {
  const { dataMode } = useDataMode();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);
  useEffect(() => {
    if (!result) return undefined;
    const timer = setTimeout(() => { if (mountedRef.current) setResult(null); }, 6000);
    return () => clearTimeout(timer);
  }, [result]);

  const demo = dataMode !== DATA_MODES.ACTUAL;
  const disabled = busy || demo || !task?.id;

  const send = async (event) => {
    event.stopPropagation();
    event.preventDefault();
    if (disabled) return;
    setBusy(true);
    setResult(null);
    const response = await sendTaskReminderRequest(task.id);
    if (!mountedRef.current) return;
    setBusy(false);
    const next = response.ok
      ? {
        type: response.warnings?.length ? 'warning' : 'success',
        text: response.warnings?.length
          ? `${response.message} Uyarı: ${response.warnings.join(' ')}`
          : response.message
      }
      : { type: 'error', text: response.message };
    setResult(next);
    onResult?.(next);
  };

  const title = demo
    ? 'Hatırlatma e-postası yalnızca Gerçek Sistem verisiyle gönderilir.'
    : busy
      ? 'Hatırlatma gönderiliyor…'
      : 'Hatırlatma e-postası gönder';

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
