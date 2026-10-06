'use client';
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Icons } from '../../../components/icons';
import { Spinner } from '../../../components/Loader';
import { useDataMode } from '../../../components/shell/DataModeContext.jsx';
import { DATA_MODES } from '../../../data/dataMode.js';
import { AI_CREDENTIAL_CHANGED_EVENT } from '../aiClient.js';
import { ASSISTANT_DEFAULT_TITLE } from '../../../domain/ai/assistantContract.js';
import { modalTrapDepth, useModalFocusTrap } from '../../../hooks/useModalFocusTrap.js';
import { useReducedMotion } from '../../../hooks/useReducedMotion.js';
import { appZoom } from '../../../lib/zoom.js';
import { AssistantComposer } from './AssistantComposer.jsx';
import { AssistantConversationList } from './AssistantConversationList.jsx';
import { AssistantThread, FAILURE_ACTION_LABELS } from './AssistantThread.jsx';
import { createAssistantController, retryableTurnKey } from './assistantController.js';
import { ASSISTANT_SHEET_QUERY, assistantEnabledInDocument } from './assistantInteraction.js';
import { assistantFailureView, DEMO_NOTICE, effectiveAssistantSource, readinessNotice, rotaDataAvailability } from './assistantPresentation.js';

/**
 * Bilgin (kod ve yapılandırmada Rota AI) — uygulama kabuğundaki genel yardımcı.
 *
 * Masaüstünde üst çubuğun altında, sağa yaslı ve KİPSİZ bir yardımcı paneldir
 * (`--z-assistant` katmanı): kullanıcı Rota'da çalışmayı sürdürür, odak
 * tuzağı yoktur, Esc paneli kapatır. Dar ekranda tam ekran bir sayfa olur ve
 * yalnızca o zaman kipli iletişim kutusu anlambilimi ve odak tuzağı taşır.
 *
 * Panel kapanınca durum KORUNUR: denetleyici kabukla birlikte yaşar; açık
 * konuşma, taslak ve süren yanıt kapanıp açılınca kaybolmaz. Demo Kipinde
 * hiçbir istek gönderilmez; yalnızca açıklama gösterilir.
 */

export const ROTA_ASSISTANT_PANEL_ID = 'rota-assistant-panel';

const HELD_DRAFT_NOTICE = Object.freeze({
  tone: 'muted',
  title: 'Gönderilemeyen ileti',
  message: 'Önceki iletiniz gönderilemedi. Yazdığınız taslak korunarak iletiyi geri alabilirsiniz.',
  action: null
});

const SUGGESTIONS = Object.freeze([
  'Bir toplantı gündemi taslağı hazırlamama yardım et.',
  'Bu metni daha resmî ve kısa bir dille yeniden yaz: ',
  'Bir Excel formülünün nasıl çalıştığını adım adım açıkla.'
]);
const DATA_SUGGESTIONS = Object.freeze([
  'Kaç gecikmiş görevim var ve hangileri?',
  'Projelerimdeki açık görevleri özetle.',
  'Bugün görevlerimde neler değişti?'
]);

/**
 * Yardımcının kabuk düzeyindeki durumu: denetleyici ve panel açıklığı. Veri
 * kipi değişince kabuk yeniden kurulur; bileşen kaldırılırken bütün istekler
 * kesilir.
 *
 * Kabuk denetleyicinin durumuna ABONE OLMAZ: akan her parça yalnızca paneli
 * (ve düğmenin "sürüyor" işaretini) yeniden çizer, uygulamanın geri kalanını
 * değil.
 */
export function useRotaAssistant() {
  const { dataMode } = useDataMode();
  const actual = dataMode === DATA_MODES.ACTUAL;
  const [enabled] = useState(() => assistantEnabledInDocument());
  const [controller] = useState(() => createAssistantController());
  const [open, setOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const launcherRef = useRef(null);

  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    if (open && actual) controller.activate({ refresh: true });
  }, [open, actual, controller]);

  useEffect(() => {
    if (!open || !actual) return undefined;
    const refresh = () => controller.activate({ refresh: true });
    let channel;
    try {
      const Channel = globalThis.window?.BroadcastChannel;
      if (Channel) { channel = new Channel(AI_CREDENTIAL_CHANGED_EVENT); channel.onmessage = () => refresh(); }
    } catch { /* Sekmeler arası bildirim desteklenmeyebilir. */ }
    globalThis.window?.addEventListener?.(AI_CREDENTIAL_CHANGED_EVENT, refresh);
    return () => {
      globalThis.window?.removeEventListener?.(AI_CREDENTIAL_CHANGED_EVENT, refresh);
      channel?.close();
    };
  }, [open, actual, controller]);

  const openPanel = useCallback(() => {
    if (!enabled) return;
    setOpen(true);
    setFocusRequest((value) => value + 1);
  }, [enabled]);
  const toggle = useCallback(() => { if (enabled) setOpen((value) => !value); }, [enabled]);
  const close = useCallback(({ restoreFocus = true } = {}) => {
    setOpen(false);
    if (restoreFocus) (globalThis.requestAnimationFrame || setTimeout)(() => launcherRef.current?.focus?.());
  }, []);

  return useMemo(() => ({
    controller, enabled, open, actual, focusRequest, launcherRef, openPanel, toggle, close
  }), [controller, enabled, open, actual, focusRequest, openPanel, toggle, close]);
}

const hasRunningGeneration = (state) => Object.keys(state.running).length > 0;

/** Denetleyicinin anlık durumu; yalnızca onu kullanan bileşeni yeniden çizdirir. */
export function useAssistantState(controller) {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

/** Bilgin'in imi: degrade yuvarlak içinde parıltı (düğme, panel başlığı). */
function AssistantMark({ size = 13, className = '' }) {
  return <span className={`rota-assistant-mark ${className}`} aria-hidden="true"><Icons.Sparkles size={size} /></span>;
}

/** Üst çubuktaki düğme; panel kapalıyken süren yanıtı küçük bir işaretle gösterir. */
export function RotaAssistantLauncher({ assistant }) {
  const { controller, open, toggle, launcherRef } = assistant;
  // Yalnızca "yanıt sürüyor mu" değiştiğinde yeniden çizilir (her parçada değil).
  const readGenerating = () => hasRunningGeneration(controller.getState());
  const generating = useSyncExternalStore(controller.subscribe, readGenerating, readGenerating);
  if (assistant.enabled === false) return null;
  return (
    <button
      ref={launcherRef}
      type="button"
      className={`rota-assistant-launcher${open ? ' is-open' : ''}`}
      aria-expanded={open}
      aria-controls={open ? ROTA_ASSISTANT_PANEL_ID : undefined}
      onClick={toggle}
      title="Bilgin"
    >
      <AssistantMark />
      <span className="rota-assistant-launcher-label">Bilgin</span>
      {generating && !open && (
        <>
          <span className="rota-assistant-launcher-dot" aria-hidden="true" />
          <span className="sr-only"> (yanıt hazırlanıyor)</span>
        </>
      )}
    </button>
  );
}

function useSheetLayout() {
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    const media = globalThis.window?.matchMedia?.(ASSISTANT_SHEET_QUERY);
    if (!media) return undefined;
    const read = () => setSheet(media.matches);
    read();
    media.addEventListener?.('change', read);
    return () => media.removeEventListener?.('change', read);
  }, []);
  return sheet;
}

/**
 * Dar ekranda ekran klavyesi açılınca görünür alan küçülür; sayfa yüksekliği
 * görünür alana eşitlenir ki yazma alanı klavyenin altında kalmasın.
 */
function useVisualViewportFit(panelRef, enabled) {
  useEffect(() => {
    const viewport = globalThis.window?.visualViewport;
    const node = panelRef.current;
    if (!enabled || !viewport || !node) return undefined;
    const apply = () => {
      const scale = appZoom();
      node.style.setProperty('--assistant-sheet-h', `${viewport.height / scale}px`);
      node.style.setProperty('--assistant-sheet-top', `${viewport.offsetTop / scale}px`);
    };
    apply();
    viewport.addEventListener('resize', apply);
    viewport.addEventListener('scroll', apply);
    return () => {
      viewport.removeEventListener('resize', apply);
      viewport.removeEventListener('scroll', apply);
      node.style.removeProperty('--assistant-sheet-h');
      node.style.removeProperty('--assistant-sheet-top');
    };
  }, [panelRef, enabled]);
}

function Notice({ notice, onAction, children = null }) {
  return (
    <div className={`rota-assistant-notice is-${notice.tone}`}>
      <Icons.Info size={14} aria-hidden="true" />
      <div className="rota-assistant-notice-copy">
        <strong>{notice.title}</strong>
        <p>{notice.message}</p>
      </div>
      {(notice.action || children) && (
        <div className="rota-assistant-notice-actions">
          {notice.action && (
            <button type="button" className="btn sm" onClick={() => onAction(notice.action)}>{FAILURE_ACTION_LABELS[notice.action]}</button>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

function Welcome({ readiness, mode, onSuggest, recent }) {
  const notice = readinessNotice(readiness);
  const dataAvailable = rotaDataAvailability(readiness, mode).available;
  return (
    <div className="rota-assistant-welcome">
      <div className="rota-assistant-welcome-mark" aria-hidden="true"><Icons.Sparkles size={20} /></div>
      <h3>Size nasıl yardımcı olabilirim?</h3>
      <p>
        Bilgin genel sorularınızda, yazım, özetleme ve açıklama işlerinde yardımcı olur.
        {dataAvailable
          ? ' Rota verisi seçeneğiyle görüntüleme yetkiniz olan görev, proje ve ekip verilerini kullanabilir.'
          : ' Şu an Rota’daki görev, proje ve ekip verilerinize erişimi yoktur; bu bilgileri sorunuzda siz paylaşabilirsiniz.'}
      </p>
      {!notice && (
        <div className="rota-assistant-suggestions" role="group" aria-label="Örnek sorular">
          {(dataAvailable ? DATA_SUGGESTIONS : SUGGESTIONS).map((text) => (
            <button key={text} type="button" className="rota-assistant-suggestion" onClick={() => onSuggest(text)}>{text}</button>
          ))}
        </div>
      )}
      {recent}
    </div>
  );
}

/** Panel. Kabukta her zaman monte edilir; kapalıyken hiçbir şey çizmez ama durumunu korur. */
export function RotaAssistantPanel({ assistant, onOpenSettings }) {
  const { controller, open, actual, focusRequest, launcherRef, close } = assistant;
  const state = useAssistantState(controller);
  const sheet = useSheetLayout();
  const reducedMotion = useReducedMotion();
  const titleId = useId();
  const panelRef = useRef(null);
  const headingRef = useRef(null);
  const inputRef = useRef(null);
  const draftKey = state.active.viewKey || state.active.key;
  const [drafts, setDrafts] = useState({});
  const draft = drafts[draftKey] || '';
  const setDraftState = ({ key, text }) => setDrafts((current) => ({ ...current, [key]: text }));
  const setDraft = (text) => setDraftState({ key: draftKey, text });
  const recoveredDraft = state.active.recoveredDraft;
  const draftTextRef = useRef(draft);
  useEffect(() => { draftTextRef.current = draft; }, [draft]);
  // Yazma alanında yeni bir taslak varken reddedilen ileti kaybolmaz: geri alınabilir bildirim olarak tutulur.
  const [heldDrafts, setHeldDrafts] = useState({});
  const setHeldDraft = (value) => setHeldDrafts((current) => ({ ...current, [draftKey]: value }));
  const recoveredTokens = useRef(new Set());
  useEffect(() => {
    if (!recoveredDraft || recoveredTokens.current.has(recoveredDraft.token)) return;
    recoveredTokens.current.add(recoveredDraft.token);
    const current = draftTextRef.current;
    if (!current || current === recoveredDraft.text) setDraftState({ key: draftKey, text: recoveredDraft.text });
    else setHeldDrafts((currentHeld) => ({ ...currentHeld, [draftKey]: { key: draftKey, token: recoveredDraft.token, text: [currentHeld[draftKey]?.text, recoveredDraft.text].filter(Boolean).join('\n\n') } }));
  }, [draftKey, recoveredDraft]);
  const held = heldDrafts[draftKey] || null;
  const restoreFocusEnabledRef = useRef(true);
  useEffect(() => { if (open) restoreFocusEnabledRef.current = sheet; }, [open, sheet]);
  const focusTargetRef = useMemo(() => ({
    get current() {
      return inputRef.current && !inputRef.current.disabled ? inputRef.current : headingRef.current;
    }
  }), []);

  useModalFocusTrap({ containerRef: panelRef, initialFocusRef: focusTargetRef, restoreFocusRef: launcherRef, restoreFocusEnabledRef, onClose: close, enabled: open && sheet });
  useVisualViewportFit(panelRef, open && sheet);

  const composerAvailable = actual && state.status === 'ready' && !state.refreshing && !state.active.loading && state.readiness?.available
    && state.view !== 'history' && !state.active.failure;
  const pendingFocusRef = useRef(false);
  useEffect(() => { pendingFocusRef.current = open; }, [open, focusRequest]);
  useEffect(() => {
    if (!open || !pendingFocusRef.current) return;
    const focused = globalThis.document?.activeElement;
    if (focused && focused !== globalThis.document?.body && focused !== launcherRef.current
      && !panelRef.current?.contains?.(focused)) {
      pendingFocusRef.current = false;
      return;
    }
    focusTargetRef.current?.focus?.();
    if ((composerAvailable && focusTargetRef.current) || state.status === 'error' || (state.status === 'ready' && !state.readiness?.available) || !actual) pendingFocusRef.current = false;
  }, [open, focusRequest, focusTargetRef, composerAvailable, state.status, state.readiness, actual, launcherRef]);

  useEffect(() => {
    if (!open || sheet) return undefined;
    const onKeyDown = (event) => {
      if (modalTrapDepth() > 0) return;
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      // Odak panelin dışındaysa (kullanıcı Rota'da çalışıyorsa) yerinde kalır; başlatıcıya taşınmaz.
      const focused = globalThis.document?.activeElement;
      close({ restoreFocus: Boolean(focused && panelRef.current?.contains?.(focused)) });
    };
    globalThis.window?.addEventListener?.('keydown', onKeyDown);
    return () => globalThis.window?.removeEventListener?.('keydown', onKeyDown);
  }, [open, sheet, close]);

  if (!open) return null;

  const { readiness, active, list } = state;
  const ready = actual && state.status === 'ready';
  const available = ready && !state.refreshing && Boolean(readiness?.available);
  const running = state.running[active.key] || null;
  const generating = Boolean(running);
  const rotaData = rotaDataAvailability(readiness, state.mode);
  const historyView = ready && state.view === 'history';
  const canCompose = ready && Boolean(readiness?.available) && !historyView && !active.failure;
  const retryKey = available && !generating && !active.loading && !active.closed
    && !state.deleting[active.id] ? retryableTurnKey(active.turns) : null;
  const capacityFull = (active.messageCount || 0) > (readiness?.limits?.maxConversationMessages || controller.limits.maxConversationMessages) - 2;
  const capacityNotice = capacityFull ? assistantFailureView({ code: 'CONFLICT', reason: 'CONVERSATION_FULL' }) : null;
  const title = historyView ? 'Geçmiş konuşmalar' : (active.id ? active.title : ASSISTANT_DEFAULT_TITLE);
  const announcement = state.announcement ? `${state.announcement.text}${state.announcement.id % 2 ? '\u200b' : ''}` : '';

  const focusInput = () => (globalThis.requestAnimationFrame || setTimeout)(() => inputRef.current?.focus?.());

  const runAction = (action) => {
    if (action === 'settings') {
      restoreFocusEnabledRef.current = false;
      close({ restoreFocus: false });
      onOpenSettings?.();
    } else if (action === 'new-conversation') {
      // Kapanmış/dolmuş, yanıtsız son turla kilitlenmiş konuşmanın ya da geri alınmayı bekleyen iletinin metni taşınır.
      const carry = Boolean(!active.id || active.closed || held || capacityFull || retryKey);
      const carried = carry ? [held?.text, draft].filter(Boolean).join('\n\n') : '';
      const sourceKey = draftKey;
      if (controller.newConversation() === false) return;
      if (carry) {
        setHeldDrafts((current) => ({ ...current, [sourceKey]: null }));
        setDrafts((current) => ({ ...current, [sourceKey]: '' }));
      }
      if (carried) {
        const next = controller.getState().active;
        setDraftState({ key: next.viewKey || next.key, text: carried });
      }
      focusInput();
    } else if (action === 'refresh-conversation') {
      if (active.id) controller.openConversation(active.id);
    } else if (action === 'reload') {
      globalThis.location?.reload();
    }
  };

  const openConversation = (id) => {
    const carried = !active.id ? [held?.text, draft].filter(Boolean).join('\n\n') : '';
    const pending = controller.openConversation(id);
    const next = controller.getState().active;
    if (carried && next.id === id) {
      const targetKey = next.viewKey || next.key;
      setDrafts((current) => ({ ...current, [draftKey]: '', [targetKey]: [current[targetKey], carried].filter(Boolean).join('\n\n') }));
      setHeldDrafts((current) => ({ ...current, [draftKey]: null }));
    }
    return pending;
  };

  const send = (text) => {
    const result = controller.send(text);
    if (result.ok) setDraft('');
    return result;
  };

  const recent = ready && !active.turns.length ? (
    <div className="rota-assistant-recent">
      <div className="rota-assistant-recent-head">
        <h4>Son konuşmalar</h4>
        <button type="button" className="btn ghost sm" onClick={() => controller.setView('history')}>Tümü</button>
      </div>
      <AssistantConversationList
        list={list}
        limit={4}
        activeId={active.id}
        running={state.running}
        deleting={state.deleting}
        onOpen={openConversation}
        onDelete={(id) => controller.deleteConversation(id)}
        onLoadMore={controller.loadMore}
        onReload={controller.refreshList}
      />
    </div>
  ) : null;

  let body;
  if (!actual) {
    body = <div className="rota-assistant-scroll"><Notice notice={DEMO_NOTICE} onAction={runAction} /></div>;
  } else if (state.status === 'idle' || state.status === 'loading') {
    body = <p className="rota-assistant-state"><Spinner size={14} /> Bilgin hazırlanıyor…</p>;
  } else if (state.status === 'error') {
    body = (
      <div className="rota-assistant-scroll">
        <Notice notice={state.failure} onAction={runAction}>
          {state.failure?.action !== 'reload' && (
            <button type="button" className="btn ghost sm" onClick={() => controller.activate()}>
              <Icons.Refresh size={12} aria-hidden="true" /> Yeniden dene
            </button>
          )}
        </Notice>
      </div>
    );
  } else if (historyView) {
    body = (
      <div className="rota-assistant-scroll">
        <AssistantConversationList
          list={list}
          activeId={active.id}
          running={state.running}
          deleting={state.deleting}
          onOpen={openConversation}
          onDelete={(id) => controller.deleteConversation(id)}
          onLoadMore={controller.loadMore}
          onReload={controller.refreshList}
        />
      </div>
    );
  } else if (active.loading) {
    body = <p className="rota-assistant-state"><Spinner size={14} /> Konuşma yükleniyor…</p>;
  } else if (active.failure) {
    body = (
      <div className="rota-assistant-scroll">
        <Notice notice={active.failure} onAction={runAction}>
          {active.failure.retryable && active.id && (
            <button type="button" className="btn ghost sm" onClick={() => controller.openConversation(active.id)}>
              <Icons.Refresh size={12} aria-hidden="true" /> Yeniden dene
            </button>
          )}
        </Notice>
      </div>
    );
  } else if (!active.turns.length) {
    const notice = readinessNotice(readiness);
    body = (
      <div className="rota-assistant-scroll">
        {notice && <Notice notice={notice} onAction={runAction} />}
        <Welcome
          readiness={readiness}
          mode={state.mode}
          recent={recent}
          onSuggest={(text) => {
            if (state.readiness?.rotaData?.enabled === true && !rotaData.available) {
              controller.setSource('general');
            } else if (rotaData.available && state.source === 'general') {
              controller.setSource('rota');
            }
            setDraft(text);
            focusInput();
          }}
        />
      </div>
    );
  } else {
    body = (
      <AssistantThread
        conversationKey={active.key}
        turns={active.turns}
        phase={running?.phase || null}
        topic={running?.topic || null}
        retryKey={retryKey}
        reconciling={Boolean(state.reconciling[active.key])}
        reducedMotion={reducedMotion}
        onRetry={(key) => {
          controller.retry(key);
          focusInput();
        }}
        onAction={runAction}
      >
        {!available && readinessNotice(readiness) && <Notice notice={readinessNotice(readiness)} onAction={runAction} />}
      </AssistantThread>
    );
  }

  return (
    <aside
      ref={panelRef}
      id={ROTA_ASSISTANT_PANEL_ID}
      className={`rota-assistant${sheet ? ' is-sheet' : ''}`}
      role={sheet ? 'dialog' : 'complementary'}
      aria-modal={sheet ? 'true' : undefined}
      aria-labelledby={titleId}
    >
      <header className="rota-assistant-head">
        <div className="rota-assistant-heading">
          <h2 id={titleId} ref={headingRef} tabIndex={-1}>
            <AssistantMark size={12} className="is-sm" /> Bilgin
          </h2>
          {actual && <p className="rota-assistant-subtitle" title={title}>{title}</p>}
        </div>
        <div className="rota-assistant-head-actions">
          {ready && (
            <button
              type="button"
              className={`icon-btn${historyView ? ' is-active' : ''}`}
              aria-pressed={historyView}
              aria-label="Geçmiş konuşmalar"
              title="Geçmiş konuşmalar"
              onClick={() => controller.setView(historyView ? 'chat' : 'history')}
            >
              <Icons.History size={15} aria-hidden="true" />
            </button>
          )}
          {ready && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Yeni konuşma"
              title="Yeni konuşma"
              onClick={() => runAction('new-conversation')}
            >
              <Icons.MessagePlus size={15} aria-hidden="true" />
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="Bilgin’i kapat" title="Kapat (Esc)" onClick={() => close()}>
            <Icons.Close size={15} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="rota-assistant-body">
        {(active.notice || capacityNotice) && <Notice notice={active.notice || capacityNotice} onAction={runAction} />}
        {held && (
          <Notice notice={HELD_DRAFT_NOTICE} onAction={runAction}>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setDraft(draft ? `${held.text}\n\n${draft}` : held.text);
                setHeldDraft(null);
                focusInput();
              }}
            >
              İletiyi geri al
            </button>
            <button type="button" className="btn ghost sm" onClick={() => setHeldDraft(null)}>Kapat</button>
          </Notice>
        )}
        {body}
      </div>
      {(canCompose || (actual && generating)) && (
        <AssistantComposer
          value={draft}
          onChange={setDraft}
          onSubmit={send}
          onStop={() => {
            controller.stop();
            focusInput();
          }}
          generating={generating}
          submitDisabled={state.refreshing || Boolean(state.reconciling[active.key]) || Boolean(retryableTurnKey(active.turns))}
          disabled={!canCompose || capacityFull || active.loading || Boolean(active.closed)
            || Boolean(state.deleting[active.id])}
          mode={state.mode}
          modes={readiness?.modes || []}
          onModeChange={(mode) => controller.setMode(mode)}
          source={effectiveAssistantSource(readiness, state.mode, state.source) || 'rota'}
          dataEnabled={state.readiness?.rotaData?.enabled === true}
          dataAvailable={rotaData.available}
          dataUnavailableMessage={rotaData.message}
          onSourceChange={(source) => controller.setSource(source)}
          includeText={state.includeText === true}
          onIncludeTextChange={(value) => controller.setIncludeText(value)}
          maxChars={readiness?.limits?.maxMessageChars || controller.limits.maxMessageChars}
          inputRef={inputRef}
        />
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
    </aside>
  );
}
