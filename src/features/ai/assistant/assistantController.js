import { createUuidV4 } from '../../../data/clientEntityId.js';
import {
  ASSISTANT_DEFAULT_TITLE,
  ASSISTANT_LIMITS,
  ASSISTANT_MODES,
  ASSISTANT_STREAM_EVENTS,
  normalizeAssistantMessage
} from '../../../domain/ai/assistantContract.js';
import * as assistantApi from './assistantClient.js';
import { assistantFailureView, isSessionFailure } from './assistantPresentation.js';

/**
 * Rota AI'nin durum makinesi — React'ten bağımsız, saf JavaScript.
 *
 * Bayat sonuç koruması açık kimliklerle yapılır:
 * - Her üretimin (`run`) kendi belirteci vardır. Durdurulan, yerine yenisi
 *   başlatılan ya da oturumu kapanan üretimin geç gelen olayı ve sonucu hiçbir
 *   yere uygulanmaz.
 * - Bir üretim yalnızca KENDİ konuşmasının ve kendi turunun görünümünü
 *   günceller; kullanıcı başka konuşmaya geçtiyse metin görünmez ama üretim
 *   sürer (yanıt sunucuda kaydedilir). Konuşmaya geri dönülünce süren metin
 *   yeniden bağlanır.
 * - Konuşma açma ve liste okumaları kendi belirteçleriyle korunur: geç gelen
 *   eski konuşma, sonradan seçilen konuşmanın yerine geçmez.
 * - `dispose()` (veri kipi değişimi, bileşenin kapanması, oturumun bitmesi)
 *   bütün istekleri keser ve oturum belirtecini ilerletir.
 *
 * Akış parçaları küçük aralıklarla birleştirilerek duruma yazılır: ilk parça
 * beklemeden görünür, sonrakiler her karakterde yeniden çizim yaptırmaz.
 */

export const ASSISTANT_FLUSH_INTERVAL_MS = 40;

const RETRYABLE_STATUSES = new Set(['failed', 'interrupted', 'stopped', 'unanswered']);

function defaultSchedule(callback, delayMs) {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

function emptyList() {
  return { items: [], nextCursor: null, loaded: false, loading: false, loadingMore: false, error: null };
}

function initialState() {
  return {
    status: 'idle',
    readiness: null,
    failure: null,
    mode: ASSISTANT_MODES.STANDARD,
    view: 'chat',
    list: emptyList(),
    active: null,
    running: {},
    announcement: null,
    deleting: {}
  };
}

/** Kayıtlı iletileri turlara çevirir; yanıtı olmayan kullanıcı iletisi yanıtsız turdur. */
export function turnsFromMessages(messages = []) {
  const turns = [];
  const byUserMessage = new Map();
  for (const message of [...messages].sort((left, right) => left.sequence - right.sequence)) {
    if (message.role === 'user') {
      const turn = {
        key: message.turnId || message.id,
        turnId: message.turnId || null,
        user: { id: message.id, content: message.content, createdAt: message.createdAt, pending: false },
        answer: null,
        contextTrimmed: false
      };
      turns.push(turn);
      byUserMessage.set(message.id, turn);
    } else {
      const turn = byUserMessage.get(message.replyToId);
      if (turn) {
        turn.answer = {
          id: message.id,
          content: message.content,
          status: 'complete',
          mode: message.mode || null,
          finishReason: message.finishReason || null,
          createdAt: message.createdAt,
          error: null
        };
      }
    }
  }
  return turns.map((turn) => (turn.answer ? turn : { ...turn, answer: { status: 'unanswered', content: '', error: null } }));
}

/** Yeniden denenebilecek tek tur: son tur, yanıtı tamamlanmamışsa. */
export function retryableTurnKey(turns = []) {
  const last = turns[turns.length - 1];
  return last && last.turnId && RETRYABLE_STATUSES.has(last.answer?.status) ? last.key : null;
}

export function createAssistantController({
  api = assistantApi,
  createId = createUuidV4,
  schedule = defaultSchedule,
  flushIntervalMs = ASSISTANT_FLUSH_INTERVAL_MS
} = {}) {
  let state = initialState();
  const listeners = new Set();
  const runs = new Map();
  let session = 0;
  let viewToken = 0;
  let listToken = 0;
  let readinessToken = 0;
  let readinessLoad = null;
  let runCounter = 0;
  let announcementCounter = 0;
  let viewLoad = null;
  const loads = new Set();
  const completedVersions = new Map();
  const listMutations = new Map();
  let mutationVersion = 0;

  const draft = () => ({ key: `draft:${createId()}`, id: null, title: ASSISTANT_DEFAULT_TITLE, loading: false, failure: null, turns: [] });
  state.active = draft();

  function emit() {
    for (const listener of [...listeners]) listener();
  }

  function update(recipe) {
    state = recipe(state);
    emit();
  }

  function announce(text) {
    announcementCounter += 1;
    return { id: announcementCounter, text };
  }

  function trackLoad() {
    const controller = new AbortController();
    loads.add(controller);
    return {
      signal: controller.signal,
      abort: () => controller.abort(),
      done: () => loads.delete(controller)
    };
  }

  const alive = (run) => runs.get(run.token) === run && run.session === session;

  function withListConversation(current, conversation) {
    if (!conversation?.id) return current;
    listMutations.set(conversation.id, ++mutationVersion);
    const others = current.items.filter((item) => item.id !== conversation.id);
    return { ...current, items: [conversation, ...others] };
  }

  /** Yalnızca üretimin kendi konuşması açıksa onun turunu günceller. */
  function patchTurn(current, run, recipe) {
    if (current.active?.key !== run.key) return current.active;
    return {
      ...current.active,
      turns: current.active.turns.map((turn) => (turn.key === run.turnKey ? recipe(turn) : turn))
    };
  }

  function setRunning(current, key, value) {
    const running = { ...current.running };
    if (value) running[key] = value;
    else delete running[key];
    return running;
  }

  function flushText(run) {
    run.cancelFlush?.();
    run.cancelFlush = null;
    const text = run.text;
    update((current) => ({
      ...current,
      active: patchTurn(current, run, (turn) => ({ ...turn, answer: { ...turn.answer, content: text } }))
    }));
  }

  function scheduleFlush(run) {
    if (run.cancelFlush) return;
    run.cancelFlush = schedule(() => {
      run.cancelFlush = null;
      if (alive(run)) flushText(run);
    }, flushIntervalMs);
  }

  function setPhase(run, phase) {
    run.phase = phase;
    update((current) => ({
      ...current,
      running: current.running[run.key]?.token === run.token
        ? { ...current.running, [run.key]: { ...current.running[run.key], phase } }
        : current.running,
      active: patchTurn(current, run, (turn) => ({ ...turn, answer: { ...turn.answer, status: phase === 'streaming' ? 'streaming' : 'waiting' } }))
    }));
  }

  /** Yeni konuşmanın geçici anahtarı, sunucunun verdiği konuşma kimliğiyle değişir. */
  function rekey(run, conversation) {
    const from = run.key;
    run.key = conversation.id;
    run.conversationId = conversation.id;
    update((current) => {
      const running = setRunning(current, from, null);
      running[conversation.id] = { ...current.running[from], token: run.token };
      const active = current.active?.key === from
        ? { ...current.active, key: conversation.id, id: conversation.id, title: conversation.title }
        : current.active;
      return { ...current, running, active };
    });
  }

  function onRunEvent(run, event) {
    if (!alive(run) || run.stopping) return;
    if (event.type === ASSISTANT_STREAM_EVENTS.ACCEPTED) {
      const { conversation, userMessage, context } = event.data;
      if (run.key !== conversation.id) rekey(run, conversation);
      update((current) => ({
        ...current,
        list: withListConversation(current.list, conversation),
        active: patchTurn(current, run, (turn) => ({
          ...turn,
          user: { id: userMessage.id, content: userMessage.content, createdAt: userMessage.createdAt, pending: false },
          contextTrimmed: Boolean(context?.trimmed)
        }))
      }));
      setPhase(run, 'accepted');
    } else if (event.type === ASSISTANT_STREAM_EVENTS.STATUS) {
      if (run.phase !== 'streaming') setPhase(run, event.data.phase);
    } else if (event.type === ASSISTANT_STREAM_EVENTS.DELTA) {
      run.text += event.data.text;
      if (run.phase !== 'streaming') {
        setPhase(run, 'streaming');
        flushText(run);
      } else {
        scheduleFlush(run);
      }
    }
  }

  function finishRun(run, result) {
    if (!alive(run)) return;
    runs.delete(run.token);
    run.cancelFlush?.();
    const text = run.text;
    completedVersions.set(run.key, (completedVersions.get(run.key) || 0) + 1);
    if (run.stopping) result = { ok: false, code: 'REQUEST_CANCELLED', cancelled: true };
    if (result.ok) {
      const { assistantMessage, conversation } = result.done;
      update((current) => ({
        ...current,
        running: setRunning(current, run.key, null),
        list: withListConversation(current.list, conversation),
        active: patchTurn(current, run, (turn) => ({
          ...turn,
          user: { ...turn.user, pending: false },
          answer: {
            id: assistantMessage.id,
            content: text.trim(),
            status: 'complete',
            mode: assistantMessage.mode || run.mode,
            finishReason: assistantMessage.finishReason || null,
            createdAt: assistantMessage.createdAt,
            error: null
          }
        })),
        announcement: current.active?.key === run.key ? announce('Yanıt tamamlandı.') : current.announcement
      }));
      return;
    }
    const failure = assistantFailureView(result);
    const status = result.cancelled ? 'stopped' : result.partial ? 'interrupted' : 'failed';
    update((current) => ({
      ...current,
      running: setRunning(current, run.key, null),
      failure: isSessionFailure(result) ? failure : current.failure,
      status: isSessionFailure(result) ? 'error' : current.status,
      active: patchTurn(current, run, (turn) => ({
        ...turn,
        user: { ...turn.user, pending: false },
        answer: { ...turn.answer, content: text, status, error: failure, mode: run.mode }
      })),
      announcement: current.active?.key === run.key ? announce(failure.title) : current.announcement
    }));
  }

  function startRun({ content, turnId }) {
    const active = state.active;
    runCounter += 1;
    const run = {
      token: runCounter,
      session,
      key: active.key,
      conversationId: active.id,
      turnId,
      turnKey: turnId,
      content,
      mode: state.mode,
      controller: new AbortController(),
      text: '',
      phase: 'sending',
      cancelFlush: null
    };
    runs.set(run.token, run);
    update((current) => {
      const exists = current.active.turns.some((turn) => turn.key === turnId);
      const placeholder = { status: 'waiting', content: '', error: null, mode: run.mode };
      const turns = exists
        ? current.active.turns.map((turn) => (turn.key === turnId
          ? { ...turn, user: { ...turn.user, pending: true }, answer: placeholder }
          : turn))
        : [...current.active.turns, {
          key: turnId,
          turnId,
          user: { id: null, content, createdAt: null, pending: true },
          answer: placeholder,
          contextTrimmed: false
        }];
      return {
        ...current,
        running: setRunning(current, run.key, { token: run.token, turnKey: turnId, phase: 'sending' }),
        active: { ...current.active, turns },
        announcement: announce('İleti gönderildi, yanıt hazırlanıyor.')
      };
    });
    Promise.resolve(api.streamAssistantTurnRequest({
      conversationId: run.conversationId,
      turnId,
      message: content,
      mode: run.mode,
      signal: run.controller.signal,
      onEvent: (event) => onRunEvent(run, event)
    })).catch(() => ({ ok: false, code: 'PROTOCOL_ERROR', partial: Boolean(run.text) }))
      .then((result) => finishRun(run, result));
    return run;
  }

  /* ── Dışa açık işlemler ─────────────────────────────────────── */

  function canSend() {
    return state.status === 'ready' && Boolean(state.readiness?.available)
      && !state.active.loading && !state.active.failure && !state.running[state.active.key]
      && !state.deleting[state.active.id];
  }

  /** Yeni ileti; boş/yalnızca boşluk ve sınırı aşan ileti gönderilmez, çift gönderim engellenir. */
  function send(rawText) {
    const normalized = normalizeAssistantMessage(rawText);
    if (!normalized.ok) return { ok: false, reason: normalized.reason, message: normalized.message };
    if (!canSend()) return { ok: false, reason: 'NOT_READY', message: null };
    if (!state.active.id && state.active.turns.length) {
      update((current) => ({ ...current, active: { ...current.active, turns: [] } }));
    }
    startRun({ content: normalized.value, turnId: createId() });
    return { ok: true };
  }

  /** Yanıtı tamamlanmamış SON turu aynı tur kimliği ve içerikle yeniden dener; ikinci kullanıcı iletisi oluşmaz. */
  function retry(turnKey) {
    if (!canSend() || retryableTurnKey(state.active.turns) !== turnKey) return { ok: false };
    const turn = state.active.turns.find((item) => item.key === turnKey);
    startRun({ content: turn.user.content, turnId: turn.turnId });
    return { ok: true };
  }

  /** Açık konuşmadaki üretimi durdurur; kısmi metin görünür kalır ama kaydedilmez. */
  function stop(key = state.active.key) {
    const entry = state.running[key];
    const run = entry ? runs.get(entry.token) : null;
    if (!run || run.stopping) return false;
    run.stopping = true;
    run.cancelFlush?.();
    run.controller.abort();
    const text = run.text;
    const failure = assistantFailureView({ code: 'REQUEST_CANCELLED' });
    update((current) => ({
      ...current,
      running: setRunning(current, key, { ...current.running[key], phase: 'stopping' }),
      active: patchTurn(current, run, (turn) => ({
        ...turn,
        user: { ...turn.user, pending: false },
        answer: { ...turn.answer, content: text, status: 'stopped', error: failure, mode: run.mode }
      })),
      announcement: current.active?.key === run.key ? announce('Yanıt durduruldu.') : current.announcement
    }));
    return true;
  }

  function setMode(mode) {
    const available = state.readiness?.modes?.find((item) => item.id === mode)?.available;
    if (!available) return false;
    update((current) => ({ ...current, mode }));
    return true;
  }

  function setView(view) {
    update((current) => ({ ...current, view: view === 'history' ? 'history' : 'chat' }));
  }

  function cancelViewLoad() {
    viewToken += 1;
    viewLoad?.abort();
    viewLoad = null;
  }

  function newConversation() {
    cancelViewLoad();
    update((current) => ({ ...current, view: 'chat', active: draft() }));
  }

  /** Süren üretimin metnini yeniden açılan konuşmanın turuna bağlar. */
  function attachLiveRun(key, turns) {
    const entry = state.running[key];
    const run = entry ? runs.get(entry.token) : null;
    if (!run) return turns;
    const status = run.stopping ? 'stopped' : run.phase === 'streaming' ? 'streaming' : 'waiting';
    const exists = turns.some((turn) => turn.key === run.turnKey);
    const live = (turn) => ({ ...turn, answer: { status, content: run.text, error: null, mode: run.mode } });
    return exists
      ? turns.map((turn) => (turn.key === run.turnKey ? live(turn) : turn))
      : [...turns, live({ key: run.turnKey, turnId: run.turnId, user: { id: null, content: run.content, createdAt: null, pending: false }, contextTrimmed: false })];
  }

  async function openConversation(conversationId) {
    if (state.active.id === conversationId && !state.active.failure && !state.active.loading) {
      setView('chat');
      return;
    }
    cancelViewLoad();
    const token = viewToken;
    const ownSession = session;
    const known = state.list.items.find((item) => item.id === conversationId);
    update((current) => ({
      ...current,
      view: 'chat',
      active: { key: conversationId, id: conversationId, title: known?.title || ASSISTANT_DEFAULT_TITLE, loading: true, failure: null, turns: [] }
    }));
    const load = trackLoad();
    viewLoad = load;
    let result;
    let version;
    do {
      version = completedVersions.get(conversationId) || 0;
      result = await api.loadAssistantConversationRequest(conversationId, { signal: load.signal });
      if (token !== viewToken || ownSession !== session) break;
    } while (result.ok && version !== (completedVersions.get(conversationId) || 0));
    load.done();
    if (token !== viewToken || ownSession !== session) return;
    viewLoad = null;
    if (!result.ok) {
      const failure = assistantFailureView(result);
      update((current) => ({
        ...current,
        status: isSessionFailure(result) ? 'error' : current.status,
        failure: isSessionFailure(result) ? failure : current.failure,
        list: result.code === 'NOT_FOUND'
          ? { ...current.list, items: current.list.items.filter((item) => item.id !== conversationId) }
          : current.list,
        active: { ...current.active, loading: false, failure }
      }));
      return;
    }
    update((current) => ({
      ...current,
      active: {
        key: conversationId,
        id: conversationId,
        title: result.conversation.title,
        loading: false,
        failure: null,
        turns: attachLiveRun(conversationId, turnsFromMessages(result.messages))
      }
    }));
  }

  async function loadList({ more = false } = {}) {
    if (more && (!state.list.nextCursor || state.list.loadingMore)) return;
    listToken += 1;
    const token = listToken;
    const ownSession = session;
    const cursor = more ? state.list.nextCursor : null;
    const startedVersion = mutationVersion;
    update((current) => ({ ...current, list: { ...current.list, loading: !more, loadingMore: more, error: null } }));
    const load = trackLoad();
    const result = await api.listAssistantConversationsRequest({ cursor, signal: load.signal });
    load.done();
    if (token !== listToken || ownSession !== session) return;
    if (!result.ok) {
      update((current) => ({ ...current, list: { ...current.list, loading: false, loadingMore: false, error: assistantFailureView(result) } }));
      return;
    }
    update((current) => {
      const preserved = more ? current.list.items : current.list.items.filter((item) => (listMutations.get(item.id) || 0) > startedVersion);
      const seen = new Set(preserved.map((item) => item.id));
      const incoming = result.conversations.filter((item) => !seen.has(item.id)
        && !((listMutations.get(item.id) || 0) > startedVersion));
      return {
        ...current,
        list: {
          items: [...preserved, ...incoming],
          nextCursor: result.nextCursor,
          loaded: true,
          loading: false,
          loadingMore: false,
          error: null
        }
      };
    });
  }

  /**
   * Panel açılırken çağrılır. İlk açılışta hazırlık durumu ve konuşma listesi
   * okunur; Rota AI kullanılamıyorsa her açılışta hazırlık durumu yeniden
   * okunur (ör. kullanıcı Ayarlar'dan anahtar ekledi).
   */
  async function activate({ refresh = false } = {}) {
    if (!refresh && state.status === 'loading') return;
    if (!refresh && state.status === 'ready' && state.readiness?.available) return;
    const ownSession = session;
    const firstLoad = state.status !== 'ready';
    const token = ++readinessToken;
    readinessLoad?.abort();
    update((current) => ({ ...current, status: firstLoad ? 'loading' : current.status, failure: null }));
    const load = trackLoad();
    readinessLoad = load;
    const listing = firstLoad && !state.list.loading ? loadList() : Promise.resolve();
    const readiness = await api.loadAssistantReadinessRequest({ signal: load.signal });
    load.done();
    if (ownSession !== session || token !== readinessToken) return;
    readinessLoad = null;
    if (!readiness.ok) {
      update((current) => ({ ...current, status: 'error', failure: assistantFailureView(readiness) }));
      return;
    }
    const modes = readiness.assistant.modes;
    update((current) => ({
      ...current,
      status: 'ready',
      readiness: readiness.assistant,
      mode: modes.find((item) => item.id === current.mode)?.available ? current.mode : modes.find((item) => item.available)?.id || ASSISTANT_MODES.STANDARD
    }));
    await listing;
  }

  async function deleteConversation(conversationId) {
    if (state.deleting[conversationId]) return { ok: false };
    stop(conversationId);
    const ownSession = session;
    update((current) => ({ ...current, deleting: { ...current.deleting, [conversationId]: true } }));
    const load = trackLoad();
    const result = await api.deleteAssistantConversationRequest(conversationId, { signal: load.signal });
    load.done();
    if (ownSession !== session) return { ok: false };
    const removed = result.ok || result.code === 'NOT_FOUND';
    const failure = removed ? null : assistantFailureView(result);
    if (removed) listMutations.set(conversationId, ++mutationVersion);
    if (removed && state.active.id === conversationId) newConversation();
    update((current) => {
      const deleting = { ...current.deleting };
      delete deleting[conversationId];
      return {
        ...current,
        deleting,
        list: removed ? { ...current.list, items: current.list.items.filter((item) => item.id !== conversationId) } : current.list,
        announcement: removed ? announce('Konuşma silindi.') : announce(failure.title)
      };
    });
    return removed ? { ok: true } : { ok: false, failure };
  }

  /** Bütün istekleri keser ve sonraki geç sonuçları geçersiz kılar. */
  function dispose() {
    session += 1;
    readinessToken += 1;
    readinessLoad = null;
    viewToken += 1;
    listToken += 1;
    for (const run of runs.values()) {
      run.cancelFlush?.();
      run.controller.abort();
    }
    runs.clear();
    completedVersions.clear();
    listMutations.clear();
    for (const controller of loads) controller.abort();
    loads.clear();
    viewLoad = null;
    state = { ...initialState(), active: draft() };
    emit();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    canSend,
    activate,
    send,
    retry,
    stop,
    setMode,
    setView,
    newConversation,
    openConversation,
    loadMore: () => loadList({ more: true }),
    refreshList: () => loadList(),
    deleteConversation,
    dispose,
    limits: ASSISTANT_LIMITS
  };
}
