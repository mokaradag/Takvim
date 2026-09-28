'use client';
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Icons } from '../../../components/icons';
import { Spinner } from '../../../components/Loader';
import { useDataMode } from '../../../components/shell/DataModeContext.jsx';
import { DATA_MODES } from '../../../data/dataMode.js';
import { AI_CREDENTIAL_CHANGED_EVENT } from '../aiClient.js';
import { ASSISTANT_DEFAULT_TITLE } from '../../../domain/ai/assistantContract.js';
import { useModalFocusTrap } from '../../../hooks/useModalFocusTrap.js';
import { useReducedMotion } from '../../../hooks/useReducedMotion.js';
import { appZoom } from '../../../lib/zoom.js';
import { AssistantComposer } from './AssistantComposer.jsx';
import { AssistantConversationList } from './AssistantConversationList.jsx';
import { AssistantThread, FAILURE_ACTION_LABELS } from './AssistantThread.jsx';
import { createAssistantController, retryableTurnKey } from './assistantController.js';
import { ASSISTANT_SHEET_QUERY } from './assistantInteraction.js';
import { assistantFailureView, DEMO_NOTICE, readinessNotice } from './assistantPresentation.js';

/**
 * Rota AI — uygulama kabuğundaki genel yardımcı.
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
    globalThis.window?.addEventListener?.(AI_CREDENTIAL_CHANGED_EVENT, refresh);
    return () => globalThis.window?.removeEventListener?.(AI_CREDENTIAL_CHANGED_EVENT, refresh);
  }, [open, actual, controller]);

  const openPanel = useCallback(() => {
    setOpen(true);
    setFocusRequest((value) => value + 1);
  }, []);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const close = useCallback(({ restoreFocus = true } = {}) => {
    setOpen(false);
    if (restoreFocus) (globalThis.requestAnimationFrame || setTimeout)(() => launcherRef.current?.focus?.());
  }, []);

  return useMemo(() => ({
    controller, open, actual, focusRequest, launcherRef, openPanel, toggle, close
  }), [controller, open, actual, focusRequest, openPanel, toggle, close]);
}

const hasRunningGeneration = (state) => Object.keys(state.running).length > 0;

/** Denetleyicinin anlık durumu; yalnızca onu kullanan bileşeni yeniden çizdirir. */
export function useAssistantState(controller) {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

/** Üst çubuktaki düğme; panel kapalıyken süren yanıtı küçük bir işaretle gösterir. */
export function RotaAssistantLauncher({ assistant }) {
  const { controller, open, toggle, launcherRef } = assistant;
  // Yalnızca "yanıt sürüyor mu" değiştiğinde yeniden çizilir (her parçada değil).
  const readGenerating = () => hasRunningGeneration(controller.getState());
  const generating = useSyncExternalStore(controller.subscribe, readGenerating, readGenerating);
  return (
    <button
      ref={launcherRef}
      type="button"
      className={`rota-assistant-launcher${open ? ' is-open' : ''}`}
      aria-expanded={open}
      aria-controls={open ? ROTA_ASSISTANT_PANEL_ID : undefined}
      onClick={toggle}
      title="Rota AI"
    >
      <Icons.Sparkles size={15} aria-hidden="true" />
      <span className="rota-assistant-launcher-label">Rota AI</span>
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

function Welcome({ readiness, onSuggest, recent }) {
  const notice = readinessNotice(readiness);
  return (
    <div className="rota-assistant-welcome">
      <div className="rota-assistant-welcome-mark" aria-hidden="true"><Icons.Sparkles size={20} /></div>
      <h3>Size nasıl yardımcı olabilirim?</h3>
      <p>
        Rota AI genel sorularınızda, yazım, özetleme ve açıklama işlerinde yardımcı olur.
        Şu an Rota’daki görev, proje ve ekip verilerinize erişimi yoktur; bu bilgileri sorunuzda siz paylaşabilirsiniz.
      </p>
      {!notice && (
        <div className="rota-assistant-suggestions" role="group" aria-label="Örnek sorular">
          {SUGGESTIONS.map((text) => (
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
      // Kapanmış/dolmuş konuşmanın ya da geri alınmayı bekleyen iletinin metni taşınır.
      const carry = Boolean(active.closed || held || capacityFull);
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
    } else if (action === 'reload') {
      globalThis.location?.reload();
    }
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
        onOpen={(id) => controller.openConversation(id)}
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
    body = <p className="rota-assistant-state"><Spinner size={14} /> Rota AI hazırlanıyor…</p>;
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
          onOpen={(id) => controller.openConversation(id)}
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
          recent={recent}
          onSuggest={(text) => {
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
            <Icons.Sparkles size={15} aria-hidden="true" /> Rota AI
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
          <button type="button" className="icon-btn" aria-label="Rota AI’yi kapat" title="Kapat (Esc)" onClick={() => close()}>
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
          submitDisabled={state.refreshing || Boolean(state.reconciling[active.key])}
          disabled={!canCompose || capacityFull || active.loading || Boolean(active.closed)
            || Boolean(state.deleting[active.id])}
          mode={state.mode}
          modes={readiness?.modes || []}
          onModeChange={(mode) => controller.setMode(mode)}
          maxChars={readiness?.limits?.maxMessageChars || controller.limits.maxMessageChars}
          inputRef={inputRef}
        />
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
    </aside>
  );
}
