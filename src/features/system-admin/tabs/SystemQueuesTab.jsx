'use client';
import { useCallback, useState } from 'react';
import { Icons } from '../../../components/icons';
import { formatDuration, formatRelativeTime } from '../../../domain/observability/metrics.js';
import { outlookFailureMessage } from '../../../domain/outlook/outlookFailures.js';
import { describeReminderSchedule } from '../../../domain/reminders/reminderPolicy.js';
import { runAutomaticRemindersRequest } from '../../reminders/reminderClient.js';
import { deliveryRunMessage } from '../../reminders/deliveryRunPresentation.js';
import { AdminSection } from '../components/AdminSection.jsx';
import { HealthDot } from '../components/HealthDot.jsx';
import { MetricTile } from '../components/MetricTile.jsx';
import { HEALTH_STATES } from '../../../domain/observability/healthModel.js';
import { stalenessNotice } from '../systemAdminPresentation.js';
import { loadSystemQueuesRequest, runQueueActionRequest } from '../systemAdminClient.js';
import { useAdminResource } from '../useAdminResource.js';

/**
 * Kuyruklar ve İşler.
 *
 * Kritik UX kuralı: DOLU kuyruk kendiliğinden sorun değildir; YAŞLANAN ya da
 * tıkanan kuyruk sorundur. Bu yüzden sayımların yanında yaş, deneme sayısı ve
 * çalışan nabzı da öne çıkarılır.
 */
const QUEUES_REFRESH_MS = 15000;

/**
 * Etkisi olan eylemler İKİ ADIMDA çalışır.
 *
 * "Şimdi Çalıştır" gerçekten posta gönderir; tek tıkla tetiklenmemelidir.
 * Onay satır içinde alınır: bilgi çekmecede, onay yerinde — bilgi için kip
 * penceresi açılmaz.
 */
function ActionButton({ label, confirmLabel, description, icon = 'Play', busy, disabled, onRun }) {
  const [armed, setArmed] = useState(false);
  const Icon = Icons[icon] || Icons.Play;
  if (!armed) {
    return (
      <button type="button" className="btn sm" disabled={disabled || busy} onClick={() => setArmed(true)} title={description}>
        <Icon size={13} /> {label}
      </button>
    );
  }
  return (
    <span className="sysadmin-confirm" role="group" aria-label={`${label} onayı`}>
      <span className="sysadmin-confirm-text">{confirmLabel}</span>
      {/* Kurulu onay düğmesi de `disabled` denetimine uyar: başka bir eylem
          sürerken onaylamak, çakışan ikinci bir isteği başlatırdı. */}
      <button
        type="button"
        className="btn primary sm"
        disabled={disabled || busy}
        onClick={async () => { setArmed(false); await onRun(); }}
      >
        {busy ? 'Çalışıyor…' : 'Onayla'}
      </button>
      <button type="button" className="btn ghost sm" disabled={busy} onClick={() => setArmed(false)}>Vazgeç</button>
    </span>
  );
}

function workerState(worker) {
  if (!worker) return HEALTH_STATES.UNKNOWN;
  if (!worker.enabled) return HEALTH_STATES.NOT_CONFIGURED;
  if (!worker.started) return HEALTH_STATES.CRITICAL;
  // Son turu BAŞARISIZ biten çalışan sağlıklı gösterilmez: aynı satırda yeşil
  // gösterge ile hata rozeti (aşağıdaki `lastResult.reason`) yan yana okunurdu.
  if (worker.lastResult?.ok === false || worker.lastResult?.reason) return HEALTH_STATES.WARNING;
  return HEALTH_STATES.HEALTHY;
}

export function SystemQueuesTab({ enabled = true }) {
  const loader = useCallback((options) => loadSystemQueuesRequest(options), []);
  const resource = useAdminResource(loader, { intervalMs: QUEUES_REFRESH_MS, enabled });
  const [busyAction, setBusyAction] = useState(null);
  const [message, setMessage] = useState(null);

  const runAction = useCallback(async (action, request) => {
    setBusyAction(action);
    setMessage(null);
    try {
      const response = await request();
      setMessage(response?.ok
        ? { type: 'success', text: response.message || 'İşlem tamamlandı.' }
        : { type: 'error', text: response?.message || 'İşlem tamamlanamadı.' });
      await resource.refresh();
    } catch (error) {
      // İstek REDDEDİLİRSE de eylem durumu temizlenmelidir: aksi halde düğme
      // kalıcı olarak "çalışıyor" kalır ve kullanıcı hiçbir hata görmez.
      setMessage({
        type: 'error',
        text: `İşlem tamamlanamadı (${String(error?.code || error?.name || 'REQUEST_FAILED')}).`
      });
    } finally {
      setBusyAction(null);
    }
  }, [resource]);

  if (!enabled) {
    return (
      <AdminSection
        title="Kuyruklar ve arka plan işleri"
        icon="Layers"
        empty
        emptyMessage="Demo Kipinde kuyruk durumu okunmaz."
        emptyHint="Gerçek Sistem verisine geçerek Outlook kuyruğunu, hatırlatma turlarını ve CN43N eşitlemesini izleyin."
      />
    );
  }

  const data = resource.data;
  const outlook = data?.outlook;
  const queue = outlook?.queue;
  const age = outlook?.age;
  const reminders = data?.reminders;
  const assignmentMail = data?.assignmentMail;
  const wbs = data?.corporateWbs;
  const notice = stalenessNotice({ stale: resource.stale, lastUpdatedAt: resource.lastUpdatedAt, error: resource.error });
  // Hiç veri alınamadıysa bölümler BOŞ değil, ALINAMADI durumundadır.
  const requestError = !data && resource.error
    ? `Kuyruk durumu alınamadı (${resource.error.code}). ${resource.error.message || ''}`.trim()
    : null;
  // Yaş, SUNUCU anlık görüntü anına göre hesaplanır: tarayıcı saatiyle sunucu
  // arasındaki kayma hem yanlış bir yaş hem de yanlış bir uyarı tonu üretirdi.
  // Bekleyen kayıt yoksa yaş SIFIR değil, ölçülemezdir.
  const generatedAtMs = data?.generatedAt ? new Date(data.generatedAt).getTime() : null;
  const oldestUnattemptedMs = age?.oldestUnattemptedAt ? new Date(age.oldestUnattemptedAt).getTime() : null;
  const oldestMinutes = Number.isFinite(generatedAtMs) && Number.isFinite(oldestUnattemptedMs)
    ? Math.max(0, (generatedAtMs - oldestUnattemptedMs) / 60000)
    : null;
  const actionBusy = busyAction != null;

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="sysadmin-toolbar">
        <span className="sysadmin-toolbar-title">
          {data?.generatedAt
            ? `Durum ${formatRelativeTime(data.generatedAt)} alındı.`
            : requestError || 'Kuyruk durumu yükleniyor…'}
        </span>
        <div className="sysadmin-toolbar-right">
          {notice && <span className="sysadmin-stale-note">{notice}</span>}
          <button type="button" className="btn ghost sm" onClick={resource.refresh} disabled={resource.refreshing}>
            <Icons.Refresh size={13} className={resource.refreshing ? 'sysadmin-spin' : ''} /> Yenile
          </button>
        </div>
      </div>

      {message && (
        <div className={`card sysadmin-action-result sysadmin-action-${message.type}`} role="status">
          {message.type === 'success' ? <Icons.Check size={14} /> : <Icons.Alert size={14} />}
          <span style={{ whiteSpace: 'pre-line' }}>{message.text}</span>
        </div>
      )}

      <AdminSection
        title="Outlook takvim teslimatı"
        icon="Mail"
        description="Davetler SMTP + iCalendar ile gönderilir. Dolu kuyruk sorun değildir; yaşlanan kuyruk sorundur."
        loading={resource.loading}
        error={requestError}
        actions={outlook?.enabled ? (
          <>
            {/* Bir eylem sürerken ÖTEKİLER de kapalıdır: her düğme yalnızca
                kendi adını denetleseydi ikinci istek `busyAction` değerini
                değiştirir ve ilkinin bitişi denetimleri erken açardı. */}
            <ActionButton
              label="Şimdi Çalıştır"
              confirmLabel="Tur bekleyen davetleri GÖNDERİR."
              description="Bekleyen teslimatları hemen işler."
              busy={busyAction === 'outlook-run'}
              disabled={actionBusy && busyAction !== 'outlook-run'}
              onRun={() => runAction('outlook-run', () => runQueueActionRequest('outlook-run'))}
            />
            <ActionButton
              label="Başarısızları Yeniden Dene"
              confirmLabel="Hatalı kayıtlar yeniden sıraya alınır."
              description="Deneme sayacı sıfırlanır; takvim sürümü ve kuyruk kuşağı değişmez."
              icon="Refresh"
              busy={busyAction === 'outlook-retry'}
              disabled={actionBusy && busyAction !== 'outlook-retry'}
              onRun={() => runAction('outlook-retry', () => runQueueActionRequest('outlook-retry'))}
            />
          </>
        ) : null}
      >
        {outlook && (
          <>
            <div className="sysadmin-worker-line">
              <HealthDot state={workerState(outlook.worker)} size={12} />
              <span>
                {!outlook.enabled ? 'Outlook tümleştirmesi kapalı.'
                  : outlook.worker?.started
                    ? `Çalışan etkin · tur aralığı ${Math.round((outlook.pollIntervalMs || 0) / 1000)} sn · son tur ${outlook.worker.lastFinishedAt ? formatRelativeTime(outlook.worker.lastFinishedAt) : 'henüz yok'}`
                    : 'Otomatik çalışan bu sunucuda başlamamış; kuyruk işlenmiyor.'}
              </span>
              {outlook.worker?.running && <span className="sysadmin-chip">tur sürüyor</span>}
              {outlook.worker?.lastResult?.reason && (
                <span className="sysadmin-chip sysadmin-chip-warn">{outlookFailureMessage(outlook.worker.lastResult.reason)}</span>
              )}
            </div>

            <div className="sysadmin-tile-grid">
              <MetricTile label="Bekleyen" value={queue?.pending} unit="count" icon="Clock" />
              <MetricTile label="İşlenmeye hazır" value={queue?.due} unit="count" icon="Play" />
              <MetricTile label="İşleniyor" value={queue?.inFlight} unit="count" icon="Activity" />
              <MetricTile label="Hatalı" value={queue?.failed} unit="count" icon="Alert" tone={queue?.failed ? 'warn' : 'neutral'} />
              <MetricTile label="Deneme eşiğini aşan" value={queue?.exhausted} unit="count" icon="Alert" tone={queue?.exhausted ? 'crit' : 'neutral'} />
              <MetricTile label="En eski bekleyen" value={oldestMinutes} unit="minutes" hint="dakika (hiç denenmemiş)" icon="Clock"
                tone={oldestMinutes != null && oldestMinutes > data?.configuration?.thresholds?.queueAgeMinutes ? 'warn' : 'neutral'} />
              <MetricTile label="En yüksek deneme" value={age?.maxAttemptCount} unit="count" icon="Refresh"
                hint={`eşik ${outlook.maxAttempts}`} />
              <MetricTile label="Son başarılı teslimat" value={age?.lastDeliveredAt ? formatRelativeTime(age.lastDeliveredAt) : '—'} unit="raw" icon="MailCheck" />
            </div>

            {(outlook.items || []).length > 0 && (
              <div className="sysadmin-table-wrap">
                <table className="tbl sysadmin-table">
                  <caption className="sysadmin-table-caption">
                    Bekleyen teslimatlar (en çok {outlook.itemLimit} kayıt). Alıcı adresi ve ileti içeriği gösterilmez.
                  </caption>
                  <thead>
                    <tr>
                      <th>Kayıt</th>
                      <th>Görev</th>
                      <th>İşlem</th>
                      <th style={{ textAlign: 'right' }}>Deneme</th>
                      <th style={{ textAlign: 'right' }}>Son değişiklik</th>
                      <th style={{ textAlign: 'right' }}>Sonraki deneme</th>
                      <th>Son hata</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outlook.items.map((item) => (
                      <tr key={item.id}>
                        <td className="tabular">#{item.id}</td>
                        <td className="tabular sysadmin-ref">{String(item.taskId || '').slice(0, 8)}</td>
                        <td>{item.operation === 'CANCEL' ? 'İPTAL' : 'DAVET'}</td>
                        <td className="tabular" style={{ textAlign: 'right' }}>{item.attemptCount}</td>
                        <td className="muted" style={{ textAlign: 'right' }}>{item.lastChangedAt ? formatRelativeTime(item.lastChangedAt) : '—'}</td>
                        <td className="muted" style={{ textAlign: 'right' }}>{item.nextAttemptAt ? formatRelativeTime(item.nextAttemptAt) : 'hazır'}</td>
                        <td>{item.failureCode ? <span className="sysadmin-chip sysadmin-chip-warn">{item.failureCode}</span> : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </AdminSection>

      <AdminSection
        title="Hatırlatma turları"
        icon="MailCheck"
        description="Şablon ve plan Hatırlatma E-postaları sekmesinde yönetilir."
        loading={resource.loading}
        error={requestError}
        actions={(
          <ActionButton
            label="Turu Şimdi Çalıştır"
            confirmLabel="Tur kayıtlı ayarlarla hatırlatma GÖNDERİR."
            description="Kayıtlı yapılandırmayla otomatik hatırlatma turunu başlatır."
            icon="Clock"
            busy={busyAction === 'reminder-run'}
            disabled={actionBusy && busyAction !== 'reminder-run'}
            onRun={() => runAction('reminder-run', async () => {
              const response = await runAutomaticRemindersRequest();
              const summary = deliveryRunMessage(response);
              return { ok: response.ok, message: summary.text };
            })}
          />
        )}
      >
        {reminders && (
          <>
            <div className="sysadmin-worker-line">
              <HealthDot state={reminders.automaticEnabled ? HEALTH_STATES.HEALTHY : HEALTH_STATES.NOT_CONFIGURED} size={12} />
              <span>
                {reminders.automaticEnabled
                  ? describeReminderSchedule(reminders)
                  : 'Otomatik hatırlatma kapalı. Elle gönderim bundan etkilenmez.'}
              </span>
              {reminders.schemaReady === false && <span className="sysadmin-chip sysadmin-chip-warn">şema eksik</span>}
            </div>
            {reminders.history?.length ? (
              <div className="sysadmin-table-wrap">
                {/* Sayfada birden çok tablo var; ekran okuyucu kullanıcısı bu
                    tabloyu Outlook kuyruğundan ADIYLA ayırabilmelidir. */}
                <table className="tbl sysadmin-table" aria-label="Hatırlatma turu geçmişi">
                  <thead>
                    <tr><th>Tür</th><th>Durum</th><th style={{ textAlign: 'right' }}>Alıcı</th><th>Aralık</th><th style={{ textAlign: 'right' }}>Zaman</th></tr>
                  </thead>
                  <tbody>
                    {reminders.history.map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.kind === 'AUTOMATIC' ? 'Otomatik' : 'Elle'}</td>
                        <td>{entry.status === 'SENT' ? 'Gönderildi' : entry.status === 'FAILED' ? `Başarısız (${entry.failureCode || '—'})` : 'Sürüyor'}</td>
                        <td className="tabular" style={{ textAlign: 'right' }}>{entry.recipientCount}</td>
                        <td className="muted sysadmin-ref">{entry.slotKey}</td>
                        <td className="muted" style={{ textAlign: 'right' }}>{formatRelativeTime(entry.completedAt || entry.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted">Henüz hatırlatma turu kaydı yok.</p>}
          </>
        )}
      </AdminSection>

      <AdminSection
        title="Atama bildirimi postaları"
        icon="Mail"
        description="Yalnızca görev panelindeki e-posta kutusu işaretlenerek kaydedilen işler kuyruğa girer; görev kaydı SMTP'yi beklemez."
        loading={resource.loading}
        error={requestError}
      >
        {assignmentMail && (
          <>
            <div className="sysadmin-worker-line">
              <HealthDot state={workerState(assignmentMail.worker)} size={12} />
              <span>
                {assignmentMail.worker?.enabled
                  ? `Çalışan ${assignmentMail.worker.started ? 'etkin' : 'durdu'} · tur aralığı ${formatDuration(assignmentMail.worker.intervalMs)}`
                  : 'SMTP yapılandırılmamış; niyetler kuyrukta bekler.'}
              </span>
              {assignmentMail.schemaReady === false && <span className="sysadmin-chip sysadmin-chip-warn">şema eksik</span>}
              {assignmentMail.worker?.lastResult?.reason && (
                <span className="sysadmin-chip sysadmin-chip-warn">{assignmentMail.worker.lastResult.reason}</span>
              )}
            </div>
            {assignmentMail.queue ? (
              <div className="sysadmin-tile-grid">
                <MetricTile label="Bekleyen" value={assignmentMail.queue.pending} unit="count" icon="Clock"
                  tone={assignmentMail.queue.pending > 0 ? 'warn' : 'neutral'} />
                {/* BAŞARISIZ kayıt kendiliğinden yeniden denenmez; sayının
                    görünür kalması tek uyarı yoludur. */}
                <MetricTile label="Başarısız" value={assignmentMail.queue.failed} unit="count" icon="Alert"
                  tone={assignmentMail.queue.failed > 0 ? 'crit' : 'neutral'}
                  hint={`${assignmentMail.queue.maxAttempts} denemeden sonra`} />
                <MetricTile label="Gönderilen" value={assignmentMail.queue.sent} unit="count" icon="Mail" />
                <MetricTile label="Sıradaki deneme" value={assignmentMail.queue.nextAttemptAt ? formatRelativeTime(assignmentMail.queue.nextAttemptAt) : '—'} unit="raw" icon="Refresh" />
                <MetricTile label="Son gönderim" value={assignmentMail.queue.lastSentAt ? formatRelativeTime(assignmentMail.queue.lastSentAt) : 'henüz yok'} unit="raw" icon="Activity" />
              </div>
            ) : <p className="muted">Posta kuyruğu okunamadı; göç uygulanmamış olabilir.</p>}
          </>
        )}
      </AdminSection>

      <AdminSection
        title="CN43N / kurumsal WBS eşitlemesi"
        icon="Database"
        description="Başarılı eşitleme turu tazeliği ile gerçek WBS içerik değişikliği ayrı izlenir."
        loading={resource.loading}
        error={requestError}
        actions={wbs?.configured ? (
          <ActionButton
            label="Şimdi Eşitle"
            confirmLabel="Kurumsal kaynak baştan okunur; uzun sürebilir."
            description="CN43N kaynağından iş dağılım ağacını tazeler."
            icon="Refresh"
            busy={busyAction === 'wbs-sync'}
            disabled={actionBusy && busyAction !== 'wbs-sync'}
            onRun={() => runAction('wbs-sync', () => runQueueActionRequest('wbs-sync'))}
          />
        ) : null}
      >
        {wbs && (
          wbs.configured ? (
            <div className="sysadmin-tile-grid">
              <MetricTile label="Son başarılı eşitleme" value={wbs.lastSuccessfulSyncAt ? formatRelativeTime(wbs.lastSuccessfulSyncAt) : 'henüz yok'} unit="raw" icon="Clock" />
              <MetricTile label="Son içerik değişikliği" value={wbs.lastContentChangeAt ? formatRelativeTime(wbs.lastContentChangeAt) : 'henüz yok'} unit="raw" icon="Activity" />
              <MetricTile label="Eşitlenen proje" value={wbs.projectCount} unit="count" icon="Layers" />
              <MetricTile label="Düğüm sayısı" value={wbs.nodeCount} unit="count" icon="Table" />
              <MetricTile label="Tazelik penceresi" value={formatDuration(wbs.ttlMs)} unit="raw" icon="Refresh"
                hint={wbs.fresh ? 'pencere açık' : 'pencere doldu'} />
            </div>
          ) : <p className="muted">CN43N kaynağı yapılandırılmamış; eşitleme çalışmaz.</p>
        )}
      </AdminSection>
    </div>
  );
}
