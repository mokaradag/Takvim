'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icons } from '../../components/icons';
import { Spinner } from '../../components/Loader';
import { useDataMode } from '../../components/shell/DataModeContext.jsx';
import { DATA_MODES } from '../../data/dataMode.js';
import { API_KEY_MAX_LENGTH, normalizeApiKeyInput } from '../../domain/ai/aiCredentialPolicy.js';
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
  canRunAiProbe,
  formatAiTimestamp,
  missingKeyDescription,
  probeSummary,
  probeTimeoutMs,
  removalConsequence,
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
  const probeRef = useRef({ token: 0, controller: null });
  const mountedRef = useRef(true);
  const inputRef = useRef(null);
  const confirmRef = useRef(null);

  const load = useCallback(async () => {
    if (!actualMode) return;
    setPhase('loading');
    const response = await loadAiCredentialStatusRequest();
    if (!mountedRef.current) return;
    if (!response.ok) {
      setLoadError(aiFailureMessage(response));
      setPhase('error');
      return;
    }
    setStatus(response.ai);
    setLoadError(null);
    setPhase('ready');
  }, [actualMode]);

  useEffect(() => {
    mountedRef.current = true;
    const probeState = probeRef.current;
    return () => {
      mountedRef.current = false;
      probeState.controller?.abort();
    };
  }, []);

  useEffect(() => { load(); }, [load]);

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

  const beginEditing = () => {
    setEditing(true);
    setDraft('');
    setDraftError(null);
    setNotice(null);
    setConfirmingRemoval(false);
  };

  // Anahtar değişince önceki denemenin sonucu artık geçerli anahtarı anlatmaz.
  const clearFinishedProbe = () => setProbe((current) => (current.phase === 'running' ? current : { phase: 'idle' }));

  const cancelEditing = () => {
    setEditing(false);
    setDraft('');
    setDraftError(null);
  };

  const save = async () => {
    const normalized = normalizeApiKeyInput(draft);
    if (!normalized.ok) {
      setDraftError(normalized.message);
      return;
    }
    setBusy('save');
    const response = await saveAiCredentialRequest(normalized.value);
    if (!mountedRef.current) return;
    setBusy(null);
    if (!response.ok) {
      setDraftError(aiFailureMessage(response));
      return;
    }
    setStatus(response.ai);
    setDraft('');
    setEditing(false);
    clearFinishedProbe();
    setNotice({ tone: 'ok', text: 'Kişisel anahtar şifrelenerek kaydedildi. Bundan sonra istekleriniz bu anahtarla yapılır.' });
  };

  const validate = async () => {
    setBusy('validate');
    setNotice(null);
    const response = await validateAiCredentialRequest({ timeoutMs: validationTimeoutMs(status) });
    if (!mountedRef.current) return;
    setBusy(null);
    if (!response.ok) {
      setNotice({ tone: 'fail', text: aiFailureMessage(response) });
      return;
    }
    const { validation } = response;
    if (validation?.credential) {
      setStatus((current) => (current ? { ...current, credential: { configured: true, ...validation.credential } } : current));
    }
    setNotice(validationNotice(validation?.status));
  };

  const remove = async () => {
    setBusy('remove');
    const response = await removeAiCredentialRequest();
    if (!mountedRef.current) return;
    setBusy(null);
    setConfirmingRemoval(false);
    if (!response.ok) {
      setNotice({ tone: 'fail', text: aiFailureMessage(response) });
      return;
    }
    setStatus(response.ai);
    clearFinishedProbe();
    setNotice({ tone: 'neutral', text: `Kişisel anahtar kaldırıldı. ${removalConsequence(response.ai)}` });
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
  const canEdit = Boolean(status?.personalKeysSupported);

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
                </span>
              ) : (
                <span className="ai-key-meta">{missingKeyDescription(status)}</span>
              )}
            </div>
            <div className="ai-key-actions">
              {configured && status.available && (
                <button type="button" className="btn sm" onClick={validate} disabled={busy != null}>
                  {busy === 'validate' ? <Spinner size={12} /> : <Icons.Check size={13} />} Doğrula
                </button>
              )}
              {canEdit && !editing && (
                <button type="button" className={`btn sm${configured ? '' : ' primary'}`} onClick={beginEditing} disabled={busy != null}>
                  {configured ? <Icons.Edit size={13} /> : <Icons.Plus size={13} />} {configured ? 'Değiştir' : 'Anahtar ekle'}
                </button>
              )}
              {configured && !confirmingRemoval && (
                <button type="button" className="btn sm ghost" onClick={() => setConfirmingRemoval(true)} disabled={busy != null}>
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
              <button type="button" className="btn sm" onClick={() => setConfirmingRemoval(false)} disabled={busy != null}>Vazgeç</button>
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
                    cancelEditing();
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
              </div>
              <div className="ai-probe-actions">
                {probe.phase === 'running' ? (
                  <>
                    <span className="ai-probe-running" role="status">
                      <Spinner size={13} /> Yanıt bekleniyor · {Math.max(0, Math.floor((clock - probe.startedAt) / 1000))} sn
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
              {status.defaultKeyConfigured ? ' Kişisel anahtar yoksa kurumsal varsayılan anahtar kullanılır.' : ''}
            </span>
          </p>
        )}
      </>
    );
  }

  return (
    <section className="card ai-access-card" aria-labelledby={titleId}>
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
          <div><dt>Model</dt><dd className="mono">{summary.model}</dd></div>
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
