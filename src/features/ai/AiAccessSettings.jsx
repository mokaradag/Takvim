'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icons } from '../../components/icons';
import { Spinner } from '../../components/Loader';
import { useDataMode } from '../../components/shell/DataModeContext.jsx';
import { DATA_MODES } from '../../data/dataMode.js';
import { AI_CREDENTIAL_VALIDATION, API_KEY_MAX_LENGTH, normalizeApiKeyInput } from '../../domain/ai/aiCredentialPolicy.js';
import {
  loadAiCredentialStatusRequest,
  removeAiCredentialRequest,
  runAiProbeRequest,
  saveAiCredentialRequest,
  validateAiCredentialRequest
} from './aiClient.js';
import {
  aiAccessChip,
  aiFailureMessage,
  ambiguousMutationNotice,
  canRunAiProbe,
  formatAiTimestamp,
  isAmbiguousMutation,
  missingKeyDescription,
  probeSummary,
  probeTimeoutMs,
  probeUnavailableMessage,
  removalConsequence,
  storedKeyNotice,
  validationNotice,
  validationSummary,
  validationTimeoutMs
} from './aiPresentation.js';

/**
 * Ayarlar · Yapay zekâ erişimi.
 *
 * Kullanıcı kişisel API anahtarını ekler, değiştirir, doğrular ya da kaldırır.
 * Kaydedilen anahtar bir daha gösterilmez; ekranda yalnızca son dört karakter
 * ve tarihler görünür. Anahtar taslağı yalnızca bileşen belleğinde durur:
 * tarayıcı deposuna, adrese ya da günlüğe yazılmaz ve kayıttan sonra silinir.
 *
 * Veri kipi değişince (Gerçek Sistem ↔ Demo) ya da kart kapanınca (sayfadan
 * ayrılma) önceki durum okumaları, kayıt, kaldırma, doğrulama ve deneme
 * istekleri İPTAL edilir (sunucu commit'ten önce iptal edilen kaydı geri alır)
 * ve geç gelen her sonuç yok sayılır: Demo Kipinde hiçbir gerçek anahtar işlemi
 * sürmez ya da görünmez.
 *
 * Sonucu bilinmeyen bir kayıt/kaldırmadan sonra güncel durum okunur; bu okuma
 * bitene kadar eylemler kapalı kalır ve okuma yalnızca kendisinden sonra yeni
 * bir işlem başlamadıysa uygulanır. Okuma da başarısızsa kart "yüklendi" demez;
 * durumu çözülmemiş gösterir.
 *
 * Satır içi denetimler (anahtar formu, kaldırma onayı) kapanınca odak onları
 * açan düğmeye döner; klavye kullanıcısı kartın başına düşmez.
 */
export function AiAccessSettings() {
  const { dataMode } = useDataMode();
  const actualMode = dataMode === DATA_MODES.ACTUAL;
  const titleId = useId();
  const inputId = useId();
  const hintId = useId();
  const [phase, setPhase] = useState(actualMode ? 'loading' : 'demo');
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [notice, setNotice] = useState(null);
  const [probe, setProbe] = useState({ phase: 'idle' });
  const [clock, setClock] = useState(() => Date.now());
  const [focusReturn, setFocusReturn] = useState(null);
  const probeRef = useRef({ token: 0, controller: null });
  // Kip değişiminde artar; eski oturumda başlamış işin sonucu uygulanmaz.
  const sessionRef = useRef(0);
  // Her anahtar işleminde (kayıt, kaldırma, doğrulama) artar; eski bir işlemin
  // ardından yapılan durum okuması daha yeni bir işlemin sonucunu ezemez.
  const mutationRef = useRef(0);
  // Durum okuması, kayıt, kaldırma ve doğrulama isteklerinin iptal denetimleri (denetim → tür).
  const actionsRef = useRef(new Map());
  const mountedRef = useRef(true);
  const sectionRef = useRef(null);
  const inputRef = useRef(null);
  const confirmRef = useRef(null);
  const editButtonRef = useRef(null);
  const removeButtonRef = useRef(null);

  // Süren denemeyi geçersiz kılar: geç gelen sonucu artık hiçbir anahtarı anlatmaz.
  const invalidateProbe = useCallback(() => {
    const probeState = probeRef.current;
    probeState.token += 1;
    probeState.controller?.abort();
    probeState.controller = null;
    setProbe({ phase: 'idle' });
  }, []);

  /**
   * Süren bütün istekleri keser (durum okuması, kayıt, kaldırma, doğrulama).
   * Kip değişiminde ve kart kapanırken çağrılır: sunucu, commit'ten önce iptal
   * edilen kaydı geri alır; terk edilmiş bir sayfanın isteği sonradan
   * uygulanmaz.
   */
  const abortActions = useCallback(() => {
    const actions = actionsRef.current;
    for (const controller of [...actions.keys()]) {
      controller.abort();
      actions.delete(controller);
    }
  }, []);

  /** İptal edilebilir bir eylem isteği başlatır; bitince denetim kümeden çıkar. */
  const trackAction = useCallback(async (kind, request) => {
    const controller = new AbortController();
    const actions = actionsRef.current;
    actions.set(controller, kind);
    try {
      return await request(controller.signal);
    } finally {
      actions.delete(controller);
    }
  }, []);

  const load = useCallback(async () => {
    if (!actualMode) return;
    const session = sessionRef.current;
    setPhase('loading');
    const response = await trackAction('status', (signal) => loadAiCredentialStatusRequest({ signal }));
    if (!mountedRef.current || sessionRef.current !== session) return;
    if (!response.ok) {
      setLoadError(aiFailureMessage(response));
      setPhase('error');
      return;
    }
    setStatus(response.ai);
    setLoadError(null);
    setPhase('ready');
  }, [actualMode, trackAction]);

  /**
   * Kartı yükleme ekranına düşürmeden güncel durumu okur. `true`: okundu ve
   * uygulandı; `false`: okunamadı; `null`: bu arada kip değişti, kart kapandı
   * ya da yeni bir anahtar işlemi başladı (sonuç uygulanmadı).
   */
  const reconcile = useCallback(async (session, mutation) => {
    const response = await trackAction('status', (signal) => loadAiCredentialStatusRequest({ signal }));
    if (!mountedRef.current || sessionRef.current !== session || mutationRef.current !== mutation) return null;
    if (!response.ok) return false;
    setStatus(response.ai);
    return true;
  }, [trackAction]);

  /** Sonucu bilinmeyen işlemden sonra güncel durum okunur; okunamazsa kart çözülmemiş gösterilir. */
  const settleAmbiguous = useCallback(async (action, response, session, mutation) => {
    const reconciled = await reconcile(session, mutation);
    if (reconciled === null) return false;
    setBusy(null);
    const notice = ambiguousMutationNotice(action, response, { reconciled });
    if (reconciled) {
      setNotice(notice);
      return true;
    }
    setNotice(null);
    setLoadError(notice.text);
    setPhase('error');
    return false;
  }, [reconcile]);

  useEffect(() => {
    mountedRef.current = true;
    const probeState = probeRef.current;
    return () => {
      mountedRef.current = false;
      probeState.controller?.abort();
      abortActions();
    };
  }, [abortActions]);

  useEffect(() => {
    sessionRef.current += 1;
    abortActions();
    invalidateProbe();
    setStatus(null);
    setLoadError(null);
    setEditing(false);
    setDraft('');
    setDraftError(null);
    setBusy(null);
    setConfirmingRemoval(false);
    setNotice(null);
    if (actualMode) load();
    else setPhase('demo');
  }, [actualMode, load, invalidateProbe, abortActions]);

  useEffect(() => {
    if (probe.phase !== 'running') return undefined;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [probe.phase]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (confirmingRemoval) confirmRef.current?.focus();
  }, [confirmingRemoval]);

  // Kapanan satır içi denetimin odağı onu açan düğmeye (yoksa karta) döner.
  useEffect(() => {
    if (!focusReturn) return;
    const target = (focusReturn === 'remove' ? removeButtonRef.current : editButtonRef.current) || sectionRef.current;
    target?.focus?.();
    setFocusReturn(null);
  }, [focusReturn]);

  const beginEditing = () => {
    setEditing(true);
    setDraft('');
    setDraftError(null);
    setNotice(null);
    setConfirmingRemoval(false);
  };

  const cancelEditing = () => {
    setEditing(false);
    setDraft('');
    setDraftError(null);
    setFocusReturn('edit');
  };

  const cancelRemoval = () => {
    setConfirmingRemoval(false);
    setFocusReturn('remove');
  };

  // Tamamlanmış bir deneme sonucu artık geçerli anahtar durumunu anlatmıyorsa
  // kaldırılır; süren deneme kendi sonucunu gösterir.
  const clearFinishedProbe = () => setProbe((current) => (current.phase === 'running' ? current : { phase: 'idle' }));

  const save = async () => {
    const normalized = normalizeApiKeyInput(draft);
    if (!normalized.ok) {
      setDraftError(normalized.message);
      return;
    }
    const session = sessionRef.current;
    const mutation = ++mutationRef.current;
    setBusy('save');
    const response = await trackAction('save', (signal) => saveAiCredentialRequest(normalized.value, { signal }));
    if (!mountedRef.current || sessionRef.current !== session) return;
    if (!response.ok && isAmbiguousMutation(response)) {
      // Anahtar kaydedilmiş olabilir: sonuç tahmin edilmez, güncel durum okunur.
      // Okuma bitene kadar eylemler kapalı kalır.
      invalidateProbe();
      await settleAmbiguous('save', response, session, mutation);
      return;
    }
    setBusy(null);
    if (!response.ok) {
      setDraftError(aiFailureMessage(response));
      return;
    }
    setStatus(response.ai);
    setDraft('');
    setEditing(false);
    // Eski anahtar için açılmış kaldırma onayı yeni anahtarı silemez.
    setConfirmingRemoval(false);
    // Anahtar değişince süren ya da biten deneme artık geçerli anahtarı anlatmaz.
    invalidateProbe();
    setNotice({ tone: 'ok', text: 'Kişisel anahtar şifrelenerek kaydedildi. Bundan sonra istekleriniz bu anahtarla yapılır.' });
    setFocusReturn('edit');
  };

  const validate = async () => {
    const session = sessionRef.current;
    const mutation = ++mutationRef.current;
    setBusy('validate');
    setNotice(null);
    const response = await trackAction('validate', (signal) => validateAiCredentialRequest({ signal, timeoutMs: validationTimeoutMs(status) }));
    if (!mountedRef.current || sessionRef.current !== session) return;
    if (!response.ok) {
      setBusy(null);
      setNotice({ tone: 'fail', text: aiFailureMessage(response) });
      return;
    }
    const { validation } = response;
    // Anahtar doğrulama sürerken başka bir oturumda değiştiyse sonuç ona ait
    // değildir; güncel durum kart yükleme ekranına düşmeden yeniden okunur ve
    // bildirim görünür kalır.
    if (validation.stale) {
      invalidateProbe();
      const reconciled = await reconcile(session, mutation);
      if (reconciled === null) return;
      setBusy(null);
      setNotice(reconciled ? validationNotice(validation) : {
        tone: 'fail',
        text: 'Anahtar doğrulama sırasında değiştirildi ve güncel durum okunamadı. Sayfayı yenileyip yeniden deneyin.'
      });
      return;
    }
    setBusy(null);
    setNotice(validationNotice(validation));
    // Güncel anahtarın yeni sonucu, ondan önceki deneme sonucunun yerini alır.
    // Anahtar reddedildiyse ya da yetkisi yetersizse süren (daha eski) deneme de
    // kesilir: sonradan gelen "Yanıt alındı" yeni sonucu çürütemez.
    if (validation.status === AI_CREDENTIAL_VALIDATION.VALID) clearFinishedProbe();
    else invalidateProbe();
    if (validation.credential) {
      setStatus((current) => (current ? { ...current, credential: { configured: true, readable: true, ...validation.credential } } : current));
    }
  };

  const remove = async () => {
    const session = sessionRef.current;
    const mutation = ++mutationRef.current;
    setBusy('remove');
    const response = await trackAction('remove', (signal) => removeAiCredentialRequest({ signal }));
    if (!mountedRef.current || sessionRef.current !== session) return;
    setConfirmingRemoval(false);
    if (!response.ok && isAmbiguousMutation(response)) {
      invalidateProbe();
      if (await settleAmbiguous('remove', response, session, mutation)) setFocusReturn('remove');
      return;
    }
    if (!response.ok && response.code === 'CONFLICT') {
      // Anahtar bu arada başka bir oturumda kaydedildi: güncel durum kart
      // yükleme ekranına düşmeden okunur ve çakışma bildirimi görünür kalır;
      // önceki denemenin sonucu artık geçerli anahtarı anlatmaz.
      invalidateProbe();
      const reconciled = await reconcile(session, mutation);
      if (reconciled === null) return;
      setBusy(null);
      setNotice({
        tone: 'fail',
        text: reconciled ? aiFailureMessage(response) : `${aiFailureMessage(response)} Güncel durum okunamadı; sayfayı yenileyin.`
      });
      setFocusReturn('remove');
      return;
    }
    setBusy(null);
    if (!response.ok) {
      setNotice({ tone: 'fail', text: aiFailureMessage(response) });
      setFocusReturn('remove');
      return;
    }
    setStatus(response.ai);
    invalidateProbe();
    setNotice({ tone: 'neutral', text: `Kişisel anahtar kaldırıldı. ${removalConsequence(response.ai)}` });
    setFocusReturn('edit');
  };

  const runProbe = async () => {
    // Nesne yerinde güncellenir: kapanıştaki temizlik aynı nesneyi tutar.
    const probeState = probeRef.current;
    probeState.controller?.abort();
    const token = probeState.token + 1;
    const controller = new AbortController();
    probeState.token = token;
    probeState.controller = controller;
    setClock(Date.now());
    setProbe({ phase: 'running', startedAt: Date.now() });
    const response = await runAiProbeRequest({ signal: controller.signal, timeoutMs: probeTimeoutMs(status) });
    // İptal edilmiş ya da yenisiyle değiştirilmiş isteğin sonucu uygulanmaz.
    if (!mountedRef.current || probeState.token !== token) return;
    probeState.controller = null;
    if (response.ok) setProbe({ phase: 'done', result: response.result });
    else if (response.code === 'REQUEST_CANCELLED') setProbe({ phase: 'cancelled' });
    else setProbe({ phase: 'failed', message: aiFailureMessage(response) });
  };

  const cancelProbe = () => probeRef.current.controller?.abort();

  const chip = aiAccessChip(status);
  const credential = status?.credential;
  const configured = Boolean(credential?.configured);
  const lastValidation = configured ? validationSummary(credential) : null;
  const keyNotice = storedKeyNotice(status);
  const probeUnavailable = probeUnavailableMessage(status);
  const canEdit = Boolean(status?.personalKeysSupported);
  // Doğrulama yalnızca KAYITLI anahtarı sınar: yeni anahtar taslağı yazılırken
  // sunulmaz, yoksa taslağın doğrulandığı sanılırdı.
  const canValidate = configured && Boolean(status?.available) && canEdit && credential?.readable !== false && !editing;

  let body;
  if (phase === 'demo') {
    body = (
      <p className="ai-access-note">
        Yapay zekâ erişimi yalnızca Gerçek Sistem verisiyle yönetilir. Demo Kipinde anahtar kaydedilmez ve istek gönderilmez.
      </p>
    );
  } else if (phase === 'loading') {
    body = <p className="ai-access-note"><Spinner size={13} /> Yapay zekâ erişimi yükleniyor…</p>;
  } else if (phase === 'error') {
    body = (
      <div className="ai-access-message is-fail" role="alert">
        <Icons.Alert size={13} aria-hidden="true" />
        <span>{loadError || 'Yapay zekâ erişim bilgisi alınamadı.'}</span>
        <button type="button" className="btn sm" onClick={load}>Yeniden dene</button>
      </div>
    );
  } else {
    body = (
      <>
        {!status.enabled && <p className="ai-access-note">Yapay zekâ özellikleri bu kurulumda kapalı.</p>}
        {status.enabled && !status.available && (
          <p className="ai-access-note">Yapay zekâ hizmeti henüz yapılandırılmadı. Sistem yöneticinize başvurun.</p>
        )}

        {(status.available || configured) && (
          <div className="ai-key-panel">
            <span className="ai-key-icon" aria-hidden="true"><Icons.Key size={16} /></span>
            <div className="ai-key-main">
              <strong>Kişisel API anahtarı</strong>
              {configured ? (
                <span className="ai-key-meta">
                  <span className="mono" aria-label={`Son dört karakter ${credential.hint}`}>••••{credential.hint}</span>
                  <span>{formatAiTimestamp(credential.updatedAt)} tarihinde kaydedildi</span>
                  {lastValidation && <span className={`ai-key-validation is-${lastValidation.tone}`}>{lastValidation.text}</span>}
                  {keyNotice && <span className="ai-key-validation is-warn">{keyNotice}</span>}
                </span>
              ) : (
                <span className="ai-key-meta">{missingKeyDescription(status)}</span>
              )}
            </div>
            <div className="ai-key-actions">
              {canValidate && (
                <button type="button" className="btn sm" onClick={validate} disabled={busy != null}>
                  {busy === 'validate' ? <Spinner size={12} /> : <Icons.Check size={13} />} Doğrula
                </button>
              )}
              {canEdit && !editing && (
                <button ref={editButtonRef} type="button" className={`btn sm${configured ? '' : ' primary'}`} onClick={beginEditing} disabled={busy != null}>
                  {configured ? <Icons.Edit size={13} /> : <Icons.Plus size={13} />} {configured ? 'Değiştir' : 'Anahtar ekle'}
                </button>
              )}
              {configured && !confirmingRemoval && !editing && (
                <button ref={removeButtonRef} type="button" className="btn sm ghost" onClick={() => setConfirmingRemoval(true)} disabled={busy != null}>
                  <Icons.Trash size={13} /> Kaldır
                </button>
              )}
            </div>
          </div>
        )}

        {confirmingRemoval && (
          <div className="ai-confirm" role="group" aria-label="Kişisel anahtarı kaldırma onayı">
            <span>{removalConsequence(status)}</span>
            <div className="ai-confirm-actions">
              <button ref={confirmRef} type="button" className="btn sm danger" onClick={remove} disabled={busy != null}>
                {busy === 'remove' ? <Spinner size={12} /> : <Icons.Trash size={13} />} Anahtarı kaldır
              </button>
              <button type="button" className="btn sm" onClick={cancelRemoval} disabled={busy != null}>Vazgeç</button>
            </div>
          </div>
        )}

        {editing && (
          <div className="ai-key-form">
            <label htmlFor={inputId} className="ai-key-label">{configured ? 'Yeni API anahtarı' : 'API anahtarı'}</label>
            <div className="ai-key-form-row">
              <input
                ref={inputRef}
                id={inputId}
                className="input mono"
                type="password"
                value={draft}
                maxLength={API_KEY_MAX_LENGTH + 64}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                data-lpignore="true"
                data-1p-ignore="true"
                aria-describedby={hintId}
                aria-invalid={draftError ? 'true' : 'false'}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setDraftError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (busy == null) save();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    // Kayıt sürerken form kapatılmaz: sonuç (ya da hata) görünür kalmalıdır.
                    if (busy !== 'save') cancelEditing();
                  }
                }}
              />
              <button type="button" className="btn primary sm" onClick={save} disabled={busy != null || !draft.trim()}>
                {busy === 'save' ? <Spinner size={12} /> : <Icons.Save size={13} />} Kaydet
              </button>
              <button type="button" className="btn sm" onClick={cancelEditing} disabled={busy === 'save'}>Vazgeç</button>
            </div>
            <p id={hintId} className={`ai-key-hint${draftError ? ' is-fail' : ''}`} role={draftError ? 'alert' : undefined}>
              {draftError || 'Anahtar sunucuda şifrelenerek saklanır ve kaydedildikten sonra bir daha gösterilmez.'}
            </p>
          </div>
        )}

        {notice && (
          <div className={`ai-access-message is-${notice.tone}`} role="status">
            {notice.tone === 'ok' ? <Icons.Check size={13} aria-hidden="true" /> : <Icons.Info size={13} aria-hidden="true" />}
            <span>{notice.text}</span>
          </div>
        )}

        {status.available && (
          <>
            <div className="set-sep" />
            <div className="ai-probe">
              <div className="ai-probe-copy">
                <div className="set-row-title">Bağlantı denemesi</div>
                <div className="set-row-desc">
                  Kısa ve sabit bir deneme isteğiyle yapay zekâ hizmetine ulaşıldığını doğrular. Görev verisi gönderilmez.
                </div>
                {probeUnavailable && <div className="set-row-desc">{probeUnavailable}</div>}
              </div>
              <div className="ai-probe-actions">
                {probe.phase === 'running' ? (
                  <>
                    {/* Canlı bölge yalnızca sabit metni duyurur; her saniye değişen sayaç okunmaz. */}
                    <span className="ai-probe-running">
                      <Spinner size={13} /> <span role="status">Yanıt bekleniyor</span>
                      <span aria-hidden="true"> · {Math.max(0, Math.floor((clock - probe.startedAt) / 1000))} sn</span>
                    </span>
                    <button type="button" className="btn sm" onClick={cancelProbe}><Icons.Close size={13} /> İptal</button>
                  </>
                ) : (
                  <button type="button" className="btn sm" onClick={runProbe} disabled={!canRunAiProbe(status)}>
                    <Icons.Play size={13} /> Deneme isteği gönder
                  </button>
                )}
              </div>
            </div>
            <ProbeResult probe={probe} />
          </>
        )}

        {status.enabled && (
          <p className="ai-access-footnote">
            <Icons.Info size={12} aria-hidden="true" />
            <span>
              Kişisel anahtar tanımlıysa istekler yalnızca bu anahtarla yapılır; anahtar reddedilirse istek kurumsal anahtara aktarılmaz.
              {status.available && status.defaultKeyConfigured ? ' Kişisel anahtar yoksa kurumsal varsayılan anahtar kullanılır.' : ''}
            </span>
          </p>
        )}
      </>
    );
  }

  return (
    <section ref={sectionRef} tabIndex={-1} className="card ai-access-card" aria-labelledby={titleId}>
      <div className="ai-access-head">
        <div className="ai-access-heading">
          <div className="card-title" id={titleId}><Icons.Sparkles size={14} /><span>Yapay zekâ erişimi</span></div>
          <div className="card-sub">Yapay zekâ isteklerinde kullanılacak API anahtarı ve bağlantı denemesi.</div>
        </div>
        {chip && <span className={`ai-status-chip is-${chip.tone}`}>{chip.label}</span>}
      </div>
      {body}
    </section>
  );
}

function ProbeResult({ probe }) {
  if (probe.phase === 'done') {
    const summary = probeSummary(probe.result);
    return (
      <div className="ai-probe-result is-ok" role="status">
        <div className="ai-probe-result-head"><Icons.Check size={13} aria-hidden="true" /> Yanıt alındı · {summary.duration}</div>
        <dl className="ai-probe-meta">
          <div><dt>Anahtar</dt><dd>{summary.source}</dd></div>
          <div><dt>Profil</dt><dd>{summary.profile}</dd></div>
          <div><dt>Yanıtlayan model</dt><dd className={summary.modelReported ? 'mono' : undefined}>{summary.model}</dd></div>
          {summary.configuredModel && <div><dt>Yapılandırılan model</dt><dd className="mono">{summary.configuredModel}</dd></div>}
          {summary.queueWait && <div><dt>Sırada bekleme</dt><dd>{summary.queueWait}</dd></div>}
        </dl>
        {probe.result?.text && <blockquote className="ai-probe-text">{probe.result.text}</blockquote>}
      </div>
    );
  }
  if (probe.phase === 'failed') {
    return (
      <div className="ai-probe-result is-fail" role="status">
        <Icons.Alert size={13} aria-hidden="true" /> {probe.message}
      </div>
    );
  }
  if (probe.phase === 'cancelled') {
    return <div className="ai-probe-result is-muted" role="status">İstek iptal edildi.</div>;
  }
  return null;
}
