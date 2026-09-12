'use client';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Icons } from '../../components/icons';
import { InfoButton } from '../../components/ui-extras';
import { DATA_MODES } from '../../data/dataMode.js';
import { useDataMode } from '../../components/shell/DataModeContext.jsx';
import {
  DEFAULT_REMINDER_SETTINGS,
  REMINDER_UNITS,
  REMINDER_UNIT_LABELS,
  describeReminderSchedule
} from '../../domain/reminders/reminderPolicy.js';
import {
  DEFAULT_REMINDER_BODY,
  DEFAULT_REMINDER_SUBJECT,
  REMINDER_PLACEHOLDERS,
  renderReminderEmail
} from '../../domain/reminders/reminderTemplate.js';
import { RichTextEditor } from './RichTextEditor.jsx';
import {
  loadReminderSettingsRequest,
  runAutomaticRemindersRequest,
  saveReminderSettingsRequest
} from './reminderClient.js';

/**
 * Yönetici · Hatırlatma e-postası yapılandırması.
 *
 * Sayfa YALNIZCA sistem yöneticilerine gösterilir; ancak asıl sınır sunucudadır:
 * `/api/mergen-rota/admin/reminder-settings` her istekte yetkiyi yeniden
 * denetler ve yetkisiz kullanıcıya FORBIDDEN döner. Gezinme öğesini gizlemek
 * tek başına bir güvenlik önlemi sayılmaz.
 */

const PREVIEW_VALUES = Object.freeze(Object.fromEntries(
  REMINDER_PLACEHOLDERS.map((placeholder) => [placeholder.key, placeholder.example])
));

/**
 * Alan sarmalayıcısı.
 *
 * Sarmalayıcı bilinçli olarak `<label>` DEĞİLDİR: alanların çoğu birden çok
 * denetim taşır (aç/kapa düğmeleri, sayı + birim ikilisi, zengin metin yüzeyi).
 * Örtük `<label>` ilişkilendirmesinde ilk etiketlenebilir öğe (örneğin "Açık"
 * düğmesi) etiketli denetim sayılıyor ve açıklama metnine tıklamak ayarı
 * değiştirebiliyordu. Grup, `aria-labelledby` ile adlandırılır; denetimlerin
 * kendi `aria-label` değerleri korunur.
 */
/**
 * Hatırlatma sayısını kabul edilen aralığa (1–365) çeker.
 *
 * Alan bırakıldığında uygulanır; yazarken ham metin korunur ki son basamağı
 * silmek engellenmesin.
 */
function clampReminderCount(value) {
  const next = Number(String(value ?? '').trim());
  if (!Number.isFinite(next)) return 1;
  return Math.min(365, Math.max(1, Math.trunc(next)));
}

function Field({ label, hint, children }) {
  const labelId = useId();
  return (
    <div className="reminder-field" role="group" aria-labelledby={labelId}>
      <span className="reminder-field-label" id={labelId}>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </div>
  );
}

/** Formu sunucudan gelen KALICI ayarlara eşitler. */
function formFromSettings(settings) {
  return {
    automaticEnabled: Boolean(settings.automaticEnabled),
    windowValue: settings.windowValue,
    windowUnit: settings.windowUnit,
    frequencyValue: settings.frequencyValue,
    frequencyUnit: settings.frequencyUnit,
    subject: settings.subject,
    body: settings.body,
    // Satır sürümü düzenlemeyle birlikte taşınır: kaydederken geri gönderilir ve
    // arada başka bir yöneticinin yaptığı değişiklik sessizce ezilmez.
    rowVersion: settings.rowVersion ?? null
  };
}

export function ReminderSettingsView() {
  const { dataMode } = useDataMode();
  const actualMode = dataMode === DATA_MODES.ACTUAL;
  const [status, setStatus] = useState(actualMode ? 'loading' : 'demo');
  const [message, setMessage] = useState(null);
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [schemaReady, setSchemaReady] = useState(true);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(() => ({
    ...DEFAULT_REMINDER_SETTINGS,
    subject: DEFAULT_REMINDER_SUBJECT,
    body: DEFAULT_REMINDER_BODY,
    rowVersion: null
  }));
  // Son KALICI durum: "Turu şimdi çalıştır" kaydedilmemiş düzenlemeyle
  // çalıştırılmasın diye formla karşılaştırılır.
  const [savedForm, setSavedForm] = useState(null);

  const load = useCallback(async () => {
    if (!actualMode) return;
    setStatus('loading');
    const response = await loadReminderSettingsRequest();
    if (!response.ok) {
      setStatus('error');
      setMessage({ type: 'error', text: response.message });
      return;
    }
    const loaded = formFromSettings(response.settings);
    setForm(loaded);
    setSavedForm(loaded);
    setSmtpConfigured(Boolean(response.smtpConfigured));
    setSchemaReady(response.schemaReady !== false);
    setHistory(response.history || []);
    setStatus('ready');
  }, [actualMode]);

  useEffect(() => { load(); }, [load]);

  const preview = useMemo(
    () => renderReminderEmail({ subject: form.subject, body: form.body }, PREVIEW_VALUES),
    [form.subject, form.body]
  );
  const summary = useMemo(() => describeReminderSchedule(form), [form]);

  const setField = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
    setMessage(null);
  };

  const save = async () => {
    setBusy(true);
    // Sayısal alanlar yazarken ham metin taşıyabilir (bkz. clampReminderCount);
    // gönderim öncesinde kabul edilen aralığa çekilir.
    const payload = {
      ...form,
      windowValue: clampReminderCount(form.windowValue),
      frequencyValue: clampReminderCount(form.frequencyValue)
    };
    const response = await saveReminderSettingsRequest(payload);
    setBusy(false);
    if (!response.ok) {
      setMessage({ type: 'error', text: response.message });
      return;
    }
    // Form KAYDEDİLEN değerle değiştirilir. Sunucu konuyu 400 karaktere kırpar
    // ve gövdeyi temizler; ekranda kalan kaydedilmemiş metin önizlemeyi de
    // gönderilecek iletiyle uyumsuz gösteriyordu.
    const persisted = formFromSettings(response.settings);
    setForm(persisted);
    setSavedForm(persisted);
    setHistory(response.history || []);
    setSchemaReady(response.schemaReady !== false);
    setMessage({
      type: 'success',
      text: response.appliedSubject && response.appliedSubject !== form.subject
        ? 'Hatırlatma yapılandırması kaydedildi. Konu satırı sunucuda kısaltıldı.'
        : 'Hatırlatma yapılandırması kaydedildi.'
    });
  };

  const runNow = async () => {
    setBusy(true);
    const response = await runAutomaticRemindersRequest();
    setBusy(false);
    // `code` yalnızca taşıma/uç hatasında bulunur; tur özeti kendi `ok` alanını
    // taşıdığı için ikisi ayrı ayrı değerlendirilir.
    if (response.code) {
      setMessage({ type: 'error', text: response.message });
      return;
    }
    if (response.reason === 'SMTP_NOT_CONFIGURED') {
      setMessage({
        type: 'error',
        text: 'SMTP yapılandırılmadan otomatik tur çalıştırılmaz; hiçbir hatırlatma aralığı tüketilmedi.'
      });
      return;
    }
    setMessage({
      type: response.enabled ? 'success' : 'warning',
      text: response.enabled
        ? `Tur tamamlandı: ${response.sent} gönderildi`
          + `${response.partial ? ` (${response.partial} kısmi alıcı)` : ''}`
          + `, ${response.skipped} atlandı, ${response.failed} başarısız.`
        : 'Otomatik hatırlatma kapalı olduğu için tur hiçbir ileti göndermedi.'
    });
    load();
  };

  // Kaydedilmemiş düzenleme varken tur ÇALIŞTIRILMAZ: uç son kayıtlı
  // yapılandırmayı kullanır ve ekrandaki taslakla gönderim yaptığı sanılırdı.
  const dirty = Boolean(savedForm) && JSON.stringify(form) !== JSON.stringify(savedForm);

  if (!actualMode) {
    return (
      <div className="card muted reminder-settings-page">
        Hatırlatma yapılandırması yalnızca Gerçek Sistem verisiyle çalışır. Demo kipinde e-posta gönderilmez.
      </div>
    );
  }

  return (
    <div className="col reminder-settings-page" style={{ gap: 16 }}>
      {status === 'loading' && <div className="card muted">Yapılandırma yükleniyor…</div>}

      {status === 'error' && (
        // Düzenleyici YÜKLENEMEYEN yapılandırmayla gösterilmez: form hâlâ
        // varsayılanları taşır ve "Kaydet" gerçek yapılandırmayı bu
        // varsayılanlarla ezerdi.
        <div className="card reminder-warning">
          <Icons.Alert size={14} /> Hatırlatma yapılandırması yüklenemedi. Düzenleme, kayıtlı yapılandırma
          okunmadan açılmaz.
          {message?.text && <div className="reminder-message error">{message.text}</div>}
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn primary sm" type="button" onClick={load}>Yeniden dene</button>
          </div>
        </div>
      )}

      {status === 'ready' && (
        <>
          {!smtpConfigured && (
            <div className="card reminder-warning">
              <Icons.Alert size={14} /> SMTP yapılandırılmamış. Sunucudaki <code>.env.local</code> dosyasına
              <code>SMTP_HOST</code>, <code>SMTP_FROM</code> ve gerekiyorsa kimlik bilgileri eklenmeden hiçbir
              ileti gönderilemez.
            </div>
          )}
          {!schemaReady && (
            <div className="card reminder-warning">
              <Icons.Database size={14} /> Hatırlatma tabloları veritabanında bulunamadı.
              <code>database/MR_Upgrade_0005_Task_Reminders.sql</code> betiği çalıştırılmalıdır.
              Şu an varsayılan şablon kullanılıyor ve yapılandırma kaydedilemez.
            </div>
          )}

          <section className="card reminder-section">
            <div className="card-title">
              <Icons.Clock size={14} /> Otomatik hatırlatma planı
              <InfoButton title="Otomatik hatırlatma" icon={<Icons.Clock size={12} />}>
                <p>Zamanlanmış tur, termine kalan süreye bakarak hatırlatma gönderir.</p>
                <div className="rt-sep" />
                <div className="rt-row"><span className="rt-label">Başlangıç</span><span className="rt-val">Termine kalan süre penceresi</span></div>
                <div className="rt-row"><span className="rt-label">Yineleme</span><span className="rt-val">Pencere içinde seçilen sıklık</span></div>
                <div className="rt-row"><span className="rt-label">Durma</span><span className="rt-val">Tamamlanan, iptal edilen, silinen görev ve termin günü</span></div>
                <div className="rt-foot"><Icons.Info size={11} /> Elle gönderim bu ayardan bağımsız çalışır.</div>
              </InfoButton>
            </div>

            <div className="reminder-grid">
              <Field label="Otomatik hatırlatma">
                <div className="seg" role="group" aria-label="Otomatik hatırlatma durumu">
                  <button
                    type="button"
                    className={form.automaticEnabled ? 'active' : ''}
                    aria-pressed={form.automaticEnabled}
                    onClick={() => setField('automaticEnabled', true)}
                  >
                    Açık
                  </button>
                  <button
                    type="button"
                    className={!form.automaticEnabled ? 'active' : ''}
                    aria-pressed={!form.automaticEnabled}
                    onClick={() => setField('automaticEnabled', false)}
                  >
                    Kapalı
                  </button>
                </div>
              </Field>

              <Field label="Hatırlatma penceresi" hint="Termine ne kadar kala hatırlatma başlasın?">
                <div className="row" style={{ gap: 6 }}>
                  <input
                    className="input tabular"
                    type="number"
                    min={1}
                    max={365}
                    value={form.windowValue}
                    aria-label="Hatırlatma penceresi değeri"
                    // Yazarken BOŞ değer korunur. `Number('')` sıfır ürettiği
                    // için son basamağı silmek reddediliyor, alan eski değerine
                    // geri sıçrıyor ve sayıyı düzenlemek imkânsız hâle
                    // geliyordu. Sınırlama alan bırakıldığında uygulanır.
                    onChange={(event) => setField('windowValue', event.target.value)}
                    onBlur={(event) => setField('windowValue', clampReminderCount(event.target.value))}
                    style={{ width: 88 }}
                  />
                  <select
                    className="input"
                    value={form.windowUnit}
                    aria-label="Hatırlatma penceresi birimi"
                    onChange={(event) => setField('windowUnit', event.target.value)}
                  >
                    {REMINDER_UNITS.map((unit) => (
                      <option key={unit} value={unit}>{REMINDER_UNIT_LABELS[unit]}</option>
                    ))}
                  </select>
                </div>
              </Field>

              <Field label="Yineleme sıklığı" hint="Pencere içindeyken hatırlatma ne sıklıkla yinelensin?">
                <div className="row" style={{ gap: 6 }}>
                  <input
                    className="input tabular"
                    type="number"
                    min={1}
                    max={365}
                    value={form.frequencyValue}
                    aria-label="Yineleme sıklığı değeri"
                    // Bkz. pencere değeri: yazarken ham metin korunur, sınır
                    // alan bırakıldığında uygulanır.
                    onChange={(event) => setField('frequencyValue', event.target.value)}
                    onBlur={(event) => setField('frequencyValue', clampReminderCount(event.target.value))}
                    style={{ width: 88 }}
                  />
                  <select
                    className="input"
                    value={form.frequencyUnit}
                    aria-label="Yineleme sıklığı birimi"
                    onChange={(event) => setField('frequencyUnit', event.target.value)}
                  >
                    {REMINDER_UNITS.map((unit) => (
                      <option key={unit} value={unit}>{REMINDER_UNIT_LABELS[unit]}</option>
                    ))}
                  </select>
                </div>
              </Field>
            </div>

            {/* Okunur özet, yapılandırma hatalarını gönderim yapılmadan görünür kılar. */}
            <p className="reminder-summary"><Icons.Info size={12} /> {summary}</p>
          </section>

          <section className="card reminder-section">
            <div className="card-title"><Icons.Mail size={14} /> E-posta şablonu</div>
            <Field label="Konu">
              <input
                className="input"
                value={form.subject}
                aria-label="E-posta konusu"
                onChange={(event) => setField('subject', event.target.value)}
              />
            </Field>
            <Field label="Gövde">
              <RichTextEditor value={form.body} onChange={(html) => setField('body', html)} />
            </Field>

            <div className="reminder-placeholders">
              <span className="reminder-placeholders-title">Kullanılabilir yer tutucular</span>
              <div className="reminder-placeholder-grid">
                {REMINDER_PLACEHOLDERS.map((placeholder) => (
                  <span key={placeholder.key} className="reminder-placeholder">
                    <code>{`{{${placeholder.key}}}`}</code>
                    <small>{placeholder.label}</small>
                  </span>
                ))}
              </div>
              {preview.unknownPlaceholders.length > 0 && (
                <div className="reminder-warning-inline">
                  <Icons.Alert size={12} /> Tanınmayan yer tutucu: {preview.unknownPlaceholders.join(', ')}.
                  Bu metin olduğu gibi gönderilir.
                </div>
              )}
            </div>

            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn primary" type="button" disabled={busy || !schemaReady} onClick={save}>
                <Icons.Check size={13} /> {busy ? 'Kaydediliyor…' : 'Kaydet'}
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => {
                  setForm((current) => ({ ...current, subject: DEFAULT_REMINDER_SUBJECT, body: DEFAULT_REMINDER_BODY }));
                  setMessage({ type: 'warning', text: 'Varsayılan şablon yüklendi. Kaydetmeden geçerli olmaz.' });
                }}
              >
                Varsayılan şablona dön
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy || dirty}
                title={dirty
                  ? 'Tur SON KAYDEDİLEN yapılandırmayı kullanır. Önce değişiklikleri kaydedin.'
                  : 'Tur son kaydedilen yapılandırmayla çalışır.'}
                onClick={runNow}
              >
                <Icons.Clock size={13} /> Turu şimdi çalıştır (kayıtlı ayarlarla)
              </button>
              {dirty && (
                <span className="muted" style={{ fontSize: 11, alignSelf: 'center' }}>
                  Kaydedilmemiş değişiklik var; tur kayıtlı yapılandırmayı kullanır.
                </span>
              )}
            </div>
            {message && <div className={`reminder-message ${message.type}`}>{message.text}</div>}
          </section>

          <section className="card reminder-section">
            <div className="card-title"><Icons.Search size={14} /> Önizleme</div>
            <div className="reminder-preview-subject"><strong>Konu:</strong> {preview.subject}</div>
            {/* Önizleme, gönderilecek gövdenin TEMİZLENMİŞ hâlidir: aynı
                temizleyici sunucuda yazma ve gönderme yolunda da çalışır. */}
            <div className="reminder-preview-body" dangerouslySetInnerHTML={{ __html: preview.bodyHtml }} />
          </section>

          <section className="card reminder-section">
            <div className="card-title"><Icons.Table size={14} /> Son gönderimler</div>
            {history.length === 0 ? (
              <div className="muted">Henüz hatırlatma gönderilmedi.</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr><th>Tür</th><th>Durum</th><th>Alıcı</th><th>Aralık</th><th>Zaman</th></tr>
                </thead>
                <tbody>
                  {history.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.kind === 'AUTOMATIC' ? 'Otomatik' : 'Elle'}</td>
                      <td>{entry.status === 'SENT' ? 'Gönderildi' : entry.status === 'FAILED' ? `Başarısız (${entry.failureCode || '—'})` : 'Sürüyor'}</td>
                      <td className="tabular">{entry.recipientCount}</td>
                      <td className="muted" style={{ fontSize: 11 }}>{entry.slotKey}</td>
                      <td className="muted" style={{ fontSize: 11 }}>{entry.completedAt || entry.createdAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
