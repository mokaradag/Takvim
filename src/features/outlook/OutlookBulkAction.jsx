'use client';
import { useEffect, useRef, useState } from 'react';
import { Icons } from '../../components/icons';
import { Spinner } from '../../components/Loader';
import {
  outlookActionAvailability,
  selectableOutlookTasks,
  summarizeOutlookBulkResult
} from './outlookPresentation.js';
import { addTasksToOutlook } from './outlookSubscriptionStore.js';
import { useOutlookCalendar } from './useOutlookCalendar.js';

/**
 * "Seçilenleri Outlook'a Ekle" — tek kullanıcı eylemi, bağımsız davetler.
 *
 * Her görev kendi iCalendar davetini alır; görevler tek bir randevuda
 * birleştirilmez, çünkü her biri ayrı ayrı güncellenebilir ve iptal edilebilir
 * kalmalıdır. Sonuç TEK bir cümleyle özetlenir: kalabalık bir seçimde görev
 * başına bildirim üretmek ekranı doldururdu.
 */
// Eylem ENJEKTE EDİLEBİLİR: testler sunucuya gitmeden gerçek bileşen mantığını
// çalıştırır. Üretimde ortak depo eylemi kullanılır.
export function OutlookBulkAction({ tasks = [], onCompleted = null, action = addTasksToOutlook }) {
  const { state, actualDataMode } = useOutlookCalendar();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (!result) return undefined;
    const timer = setTimeout(() => { if (mountedRef.current) setResult(null); }, 8000);
    return () => clearTimeout(timer);
  }, [result]);

  const availability = outlookActionAvailability({ actualDataMode, state });
  const eligible = selectableOutlookTasks(tasks);
  const limit = state.bulkLimit;
  const overLimit = eligible.length > limit;
  const skipped = tasks.length - eligible.length;

  const blocked = availability.reason
    || (!eligible.length ? 'Seçilen görevlerin takvime eklenebilecek bir termini yok.' : null)
    || (overLimit ? `Tek seferde en çok ${limit} görev eklenebilir. Seçimi daraltın.` : null);
  const disabled = busy || Boolean(blocked);

  const submit = async () => {
    if (disabled) return;
    setBusy(true);
    setResult(null);
    let next;
    try {
      const response = await action(eligible.map((task) => task.id));
      next = response.ok
        ? summarizeOutlookBulkResult(response)
        : { tone: 'error', text: response.message || 'Görevler Outlook takvimine eklenemedi.' };
      const results = Array.isArray(response.results) ? response.results : [];
      const allSucceeded = results.length > 0
        && results.every((item) => ['ADDED', 'ALREADY_ADDED', 'QUEUED', 'IN_PROGRESS'].includes(item.status));
      if (response.ok && allSucceeded && !response.summary?.failed && skipped === 0) onCompleted?.(response);
    } catch {
      next = { tone: 'error', text: 'Görevler Outlook takvimine eklenemedi.' };
    } finally {
      if (mountedRef.current) setBusy(false);
    }
    if (!mountedRef.current) return;
    // Termini olmayan görevler sessizce düşürülmez; özetin sonunda söylenir.
    setResult(skipped > 0 && next.tone !== 'error'
      ? { ...next, text: `${next.text} ${skipped} görev termini olmadığı için atlandı.` }
      : next);
  };

  return (
    <span className="outlook-bulk-action">
      <button
        type="button"
        className="btn sm outlook-action-button"
        disabled={disabled}
        aria-busy={busy}
        title={blocked || `Seçili ${eligible.length} görevi kendi Outlook takviminize ekleyin`}
        onClick={submit}
      >
        {busy ? <Spinner size={13} /> : <Icons.Calendar size={13} />}
        <span>{busy ? 'Ekleniyor…' : "Seçilenleri Outlook'a Ekle"}</span>
      </button>
      {result && <span className={`outlook-action-result ${result.tone}`} role="status">{result.text}</span>}
    </span>
  );
}