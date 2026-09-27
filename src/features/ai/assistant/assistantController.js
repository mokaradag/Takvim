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

/**
 * SQL Server `uniqueidentifier` sıralama anahtarı (SqlGuid karşılaştırması:
 * bellek düzenindeki 10–15, 8–9, 6–7, 4–5, 0–3. baytlar). Liste sunucuda
 * `UpdatedAt DESC, ConversationId DESC` ile sıralanır; eşit zamanlı
 * konuşmalar istemcide de aynı sırada kalır.
 */
function guidSortKey(id) {
  const hex = String(id || '').replace(/-/g, '').toLowerCase();
  if (hex.length !== 32) return hex;
  return [10, 11, 12, 13, 14, 15, 8, 9, 7, 6, 5, 4, 3, 2, 1, 0].map((index) => hex.slice(index * 2, index * 2 + 2)).join('');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortConversations(items) {
  return items.sort((a, b) => compareText(b.updatedAt || '', a.updatedAt || '')
    || (a.updatedAt && b.updatedAt ? compareText(guidSortKey(b.id), guidSortKey(a.id)) : 0));
}

const RETRYABLE_STATUSES = new Set(['failed', 'interrupted', 'stopped', 'unanswered']);

/**
 * Kabulden önce, sunucu kullanıcı iletisini YAZMADAN verdiği kesin retler.
 * Bunların dışındaki kabul öncesi hata (ör. akış kurulamadı, beklenmeyen 5xx)
 * iletinin kaydedilip kaydedilmediğini söylemez: tur aynı kimlikle yeniden
 * denenebilir kalır, atılmaz.
 */
const PRE_PERSISTENCE_REJECTIONS = new Set([
  'UNAUTHORIZED',
  'SESSION_REQUIRED',
  'FORBIDDEN',
  'AI_REQUEST_INVALID',
  'AI_DISABLED',
  'AI_CONFIGURATION_ERROR',
  'AI_KEY_MISSING',
  'CONFLICT',
  'NOT_FOUND'
]);

/** Konuşmanın artık kullanılamadığını söyleyen ret: silinmiş ya da azami uzunlukta. */
function closesConversation(result) {
  return result.code === 'NOT_FOUND' || (result.code === 'CONFLICT' && result.reason === 'CONVERSATION_FULL');
}

/** Anahtar sorunu giderilince (hazırlık yeniden kullanılabilir) tur yeniden denenebilir olur. */
function reviveCredentialFailures(active) {
  if (!active?.turns?.length) return active;
  let changed = false;
  const turns = active.turns.map((turn) => {
    const error = turn.answer?.error;
    if (!error?.credential || error.retryable !== false) return turn;
    changed = true;
    return { ...turn, answer: { ...turn.answer, error: { ...error, retryable: true, action: null } } };
  });
  return changed ? { ...active, turns } : active;
}

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
    refreshing: false,
    failure: null,
    mode: ASSISTANT_MODES.STANDARD,
    view: 'chat',
    list: emptyList(),
    active: null,
    running: {},
    announcement: null,
    deleting: {},
    reconciling: {}
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
  let listLoad = null;
  const loads = new Set();
  const completedVersions = new Map();
  const listMutations = new Map();
  let mutationVersion = 0;

  const draft = () => {
    const key = `draft:${createId()}`;
    return { key, viewKey: key, id: null, title: ASSISTANT_DEFAULT_TITLE, loading: false, failure: null, turns: [] };
  };
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
    return { ...current, items: sortConversations([conversation, ...others]) };
  }

  /** Yalnızca üretimin kendi konuşması açıksa onun turunu günceller. */
  function patchTurn(current, run, recipe) {
    if (current.active?.key !== run.key) return current.active;
    return {
      ...current.active,
      turns: current.active.turns.map((turn) => (turn.key === run.turnKey && turn.answer?.status !== 'complete' ? recipe(turn) : turn))
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
    if (!alive(run) || (run.stopping && event.type !== ASSISTANT_STREAM_EVENTS.ACCEPTED && event.type !== ASSISTANT_STREAM_EVENTS.DELTA)) return;
    if (event.type === ASSISTANT_STREAM_EVENTS.ACCEPTED) {
      const { conversation, userMessage, context } = event.data;
      run.accepted = true;
      run.userMessageId = userMessage.id;
      run.contextTrimmed = Boolean(context?.trimmed);
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
      if (!run.stopping) setPhase(run, 'accepted');
    } else if (event.type === ASSISTANT_STREAM_EVENTS.STATUS) {
      if (run.phase !== 'streaming') setPhase(run, event.data.phase);
    } else if (event.type === ASSISTANT_STREAM_EVENTS.DELTA) {
      run.text += event.data.text;
      if (run.stopping) return;
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
    const text = run.stopping && !result.ok ? run.stoppedText : run.text;
    completedVersions.set(run.key, (completedVersions.get(run.key) || 0) + 1);
    if (run.stopping && !result.ok) result = { ok: false, code: 'REQUEST_CANCELLED', cancelled: true };
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
    const sessionFailure = isSessionFailure(result);
    const unaccepted = result.phase === 'request' && !run.accepted;
    const closed = unaccepted && Boolean(run.conversationId) && closesConversation(result);
    const dropList = (current) => (closed && result.code === 'NOT_FOUND'
      ? { ...current.list, items: current.list.items.filter((item) => item.id !== run.conversationId) }
      : current.list);
    if (unaccepted && !failure.retryable && run.newTurn && PRE_PERSISTENCE_REJECTIONS.has(String(result.code))) {
      // Sunucu iletiyi yazmadan reddetti: yerel tur atılır, metin taslağa döner.
      update((current) => ({
        ...current,
        running: setRunning(current, run.key, null),
        status: sessionFailure ? 'error' : current.status,
        failure: sessionFailure ? failure : current.failure,
        list: dropList(current),
        active: current.active?.key === run.key ? {
          ...current.active,
          turns: current.active.turns.filter((turn) => turn.key !== run.turnKey || turn.user.id),
          recoveredDraft: { token: run.token, text: run.content },
          // Oturum hatası panel düzeyinde bir kez gösterilir.
          notice: sessionFailure ? null : failure,
          closed: closed || current.active.closed
        } : current.active,
        announcement: current.active?.key === run.key ? announce(failure.title) : current.announcement
      }));
      return;
    }
    const status = result.cancelled ? 'stopped' : result.partial ? 'interrupted' : 'failed';
    // Yeniden denemenin yeni metin üretmeden biten sonucu önceki kısmi yanıtı silmez.
    const previous = !text && run.previousAnswer?.content ? run.previousAnswer.content : null;
    // Kabul edilmiş ama `done` almadan biten üretimin yanıtı sunucuda yazılmış olabilir:
    // sonraki tur, konuşma sunucuyla uzlaştırılana kadar başlatılmaz.
    const reconcile = run.accepted && Boolean(run.userMessageId);
    update((current) => ({
      ...current,
      running: setRunning(current, run.key, null),
      reconciling: reconcile ? { ...current.reconciling, [run.key]: run.token } : current.reconciling,
      failure: sessionFailure ? failure : current.failure,
      status: sessionFailure ? 'error' : current.status,
      list: dropList(current),
      active: (() => {
        const active = patchTurn(current, run, (turn) => ({
          ...turn,
          user: { ...turn.user, pending: false },
          answer: {
            ...turn.answer,
            content: previous ?? text,
            status,
            // Kaydı doğrulanmamış tur (kimliksiz kullanıcı iletisi) her zaman aynı kimlikle yeniden denenebilir.
            error: !turn.user.id && !closed && !sessionFailure ? { ...failure, retryable: true } : failure,
            mode: run.mode
          }
        }));
        return closed && current.active?.key === run.key ? { ...active, closed: true } : active;
      })(),
      announcement: current.active?.key === run.key ? announce(failure.title) : current.announcement
    }));
    if (reconcile) reconcileRun(run);
  }

  /**
   * Durdurulan ya da `done` almadan kesilen üretimin sonucunu sunucudan okur:
   * sağlayıcı yanıtı tamamlamış ve sunucu onu kaydetmişse tur tamamlanmış
   * gösterilir. Okuma bitene kadar bu konuşmada yeni tur başlatılmaz.
   */
  async function reconcileRun(run) {
    const ownSession = session;
    const key = run.key;
    const load = trackLoad();
    let result = null;
    try {
      result = await api.loadAssistantConversationRequest(run.conversationId, { signal: load.signal });
    } catch {
      result = null;
    }
    load.done();
    if (ownSession !== session) return;
    const answer = result?.ok
      ? result.messages.find((message) => message.role === 'assistant' && message.replyToId === run.userMessageId)
      : null;
    update((current) => {
      if (current.reconciling[key] !== run.token) return current;
      const reconciling = { ...current.reconciling };
      delete reconciling[key];
      if (!answer || current.active?.key !== key) return { ...current, reconciling };
      return {
        ...current,
        reconciling,
        list: result.conversation ? withListConversation(current.list, result.conversation) : current.list,
        active: {
          ...current.active,
          turns: current.active.turns.map((turn) => (turn.key === run.turnKey && turn.answer?.status !== 'complete' ? {
            ...turn,
            answer: {
              id: answer.id,
              content: answer.content,
              status: 'complete',
              mode: answer.mode || run.mode,
              finishReason: answer.finishReason || null,
              createdAt: answer.createdAt,
              error: null
            }
          } : turn))
        },
        announcement: announce('Yanıt tamamlanmış ve kaydedilmiş.')
      };
    });
  }

  function startRun({ content, turnId }) {
    const active = state.active;
    const existing = active.turns.find((turn) => turn.key === turnId);
    runCounter += 1;
    const run = {
      token: runCounter,
      session,
      key: active.key,
      conversationId: active.id,
      turnId,
      turnKey: turnId,
      newTurn: !existing,
      // Yeniden denemede önceki kısmi yanıt, yeni metin gelene kadar geri alınabilir kalır.
      previousAnswer: existing?.answer?.content ? existing.answer : null,
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
        active: { ...current.active, turns, recoveredDraft: null, notice: null },
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
    return state.status === 'ready' && !state.refreshing && Boolean(state.readiness?.available)
      && !state.active.loading && !state.active.failure && !state.active.closed && !state.running[state.active.key]
      && !state.reconciling[state.active.key] && !state.deleting[state.active.id];
  }

  /** Yeni ileti; boş/yalnızca boşluk ve sınırı aşan ileti gönderilmez, çift gönderim engellenir. */
  function send(rawText) {
    const normalized = normalizeAssistantMessage(rawText);
    if (!normalized.ok) return { ok: false, reason: normalized.reason, message: normalized.message };
    if (!canSend()) return { ok: false, reason: 'NOT_READY', message: null };
    if (state.active.turns.some((turn) => !turn.user.id)) {
      return { ok: false, reason: 'TURN_UNCONFIRMED', message: 'Önce son iletiyi yeniden deneyin veya yeni bir konuşma başlatın.' };
    }
    startRun({ content: normalized.value, turnId: createId() });
    return { ok: true };
  }

  /** Yanıtı tamamlanmamış SON turu aynı tur kimliği ve içerikle yeniden dener; ikinci kullanıcı iletisi oluşmaz. */
  function retry(turnKey) {
    if (!canSend() || retryableTurnKey(state.active.turns) !== turnKey) return { ok: false };
    const turn = state.active.turns.find((item) => item.key === turnKey);
    if (turn.answer?.error?.retryAt > Date.now()) return { ok: false };
    startRun({ content: turn.user.content, turnId: turn.turnId });
    return { ok: true };
  }

  /** Açık konuşmadaki üretimi durdurur; kısmi metin görünür kalır ama kaydedilmez. */
  function stop(key = state.active.key) {
    const entry = state.running[key];
    const run = entry ? runs.get(entry.token) : null;
    if (!run || run.stopping) return false;
    run.stopping = true;
    // Yeni metin gelmeden durdurulan yeniden deneme önceki kısmi yanıtı korur.
    run.stoppedText = run.text || run.previousAnswer?.content || '';
    run.cancelFlush?.();
    run.controller.abort();
    const text = run.stoppedText;
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
    const live = (turn) => ({ ...turn, contextTrimmed: Boolean(run.contextTrimmed), answer: turn.answer?.status === 'complete'
      ? turn.answer : { status, content: run.text, error: null, mode: run.mode } });
    return exists
      ? turns.map((turn) => (turn.key === run.turnKey ? live(turn) : turn))
      : [...turns, live({ key: run.turnKey, turnId: run.turnId, user: { id: null, content: run.content, createdAt: null, pending: false }, contextTrimmed: false })];
  }

  async function openConversation(conversationId) {
    cancelViewLoad();
    const token = viewToken;
    const ownSession = session;
    const viewKey = state.active.id === conversationId ? state.active.viewKey : conversationId;
    const known = state.list.items.find((item) => item.id === conversationId);
    update((current) => ({
      ...current,
      view: 'chat',
      active: { key: conversationId, viewKey, id: conversationId, title: known?.title || ASSISTANT_DEFAULT_TITLE, loading: true, failure: null, turns: [] }
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
        viewKey,
        id: conversationId,
        title: result.conversation.title,
        loading: false,
        failure: null,
        turns: attachLiveRun(conversationId, turnsFromMessages(result.messages))
      }
    }));
  }

  /**
   * Konuşma listesi. Yenileme ilk sayfayı okur. "Daha eski" SABİT sayıda istekle
   * çalışır: güncellenip başa taşınan konuşmalar için baş sayfa yeniden okunur,
   * eski sayfalar ise var olan anahtar kümesi imlecinden sürdürülür (imleç
   * (UpdatedAt, ConversationId) çiftidir; başa taşınan konuşma atlanmaz).
   * Yerini yeni bir okuma alan eski okuma kesilir.
   */
  async function loadList({ more = false } = {}) {
    if (more && (!state.list.nextCursor || state.list.loadingMore)) return;
    listToken += 1;
    const token = listToken;
    const ownSession = session;
    const cursor = more ? state.list.nextCursor : null;
    const startedVersion = mutationVersion;
    listLoad?.abort();
    update((current) => ({ ...current, list: { ...current.list, loading: !more, loadingMore: more, error: null } }));
    const load = trackLoad();
    listLoad = load;
    const current = () => token === listToken && ownSession === session;
    const head = await api.listAssistantConversationsRequest({ cursor: null, signal: load.signal });
    const older = more && head.ok && current()
      ? await api.listAssistantConversationsRequest({ cursor, signal: load.signal })
      : null;
    load.done();
    if (listLoad === load) listLoad = null;
    if (!current()) return;
    const failed = !head.ok ? head : older && !older.ok ? older : null;
    if (failed) {
      update((state_) => ({ ...state_, status: isSessionFailure(failed) ? 'error' : state_.status, failure: isSessionFailure(failed) ? assistantFailureView(failed) : state_.failure, list: { ...state_.list, loading: false, loadingMore: false, error: assistantFailureView(failed) } }));
      return;
    }
    update((state_) => {
      const mutated = (id) => (listMutations.get(id) || 0) > startedVersion;
      const preserved = state_.list.items.filter((item) => mutated(item.id));
      const seen = new Set(preserved.map((item) => item.id));
      const merged = [...preserved];
      const add = (item) => {
        if (seen.has(item.id) || mutated(item.id)) return;
        seen.add(item.id);
        merged.push(item);
      };
      head.conversations.forEach(add);
      if (more) {
        older.conversations.forEach(add);
        state_.list.items.forEach(add);
      }
      return {
        ...state_,
        list: {
          items: sortConversations(merged),
          nextCursor: more ? older.nextCursor : head.nextCursor,
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
    update((current) => ({ ...current, status: firstLoad ? 'loading' : current.status, refreshing: true, failure: null }));
    const load = trackLoad();
    readinessLoad = load;
    const listing = (firstLoad || refresh) ? loadList() : Promise.resolve();
    const readiness = await api.loadAssistantReadinessRequest({ signal: load.signal });
    load.done();
    if (ownSession !== session || token !== readinessToken) return;
    readinessLoad = null;
    if (!readiness.ok) {
      const failure = assistantFailureView(readiness);
      // Çalışan panelin yenilemesi geçici olarak başarısızsa açık konuşma ve
      // süren yanıt görünür kalır; hata bildirim olarak gösterilir. Panel düzeyi
      // hata yalnızca ilk yüklemede ya da oturum hatasında gösterilir.
      update((current) => (firstLoad || isSessionFailure(readiness)
        ? { ...current, status: 'error', refreshing: false, failure }
        : { ...current, refreshing: false, active: { ...current.active, notice: { ...failure, readiness: true } } }));
      return;
    }
    const modes = readiness.assistant.modes;
    update((current) => ({
      ...current,
      status: current.failure?.action === 'reload' ? 'error' : 'ready',
      refreshing: false,
      readiness: readiness.assistant,
      mode: modes.find((item) => item.id === current.mode)?.available ? current.mode : modes.find((item) => item.available)?.id || ASSISTANT_MODES.STANDARD,
      active: (() => {
        const notice = current.active.notice?.readiness ? null : current.active.notice;
        const active = notice === current.active.notice ? current.active : { ...current.active, notice };
        return readiness.assistant.available ? reviveCredentialFailures(active) : active;
      })()
    }));
    await listing;
  }

  async function deleteConversation(conversationId) {
    if (state.deleting[conversationId]) return { ok: false };
    const ownSession = session;
    update((current) => ({ ...current, deleting: { ...current.deleting, [conversationId]: true }, list: { ...current.list, error: null } }));
    const load = trackLoad();
    const result = await api.deleteAssistantConversationRequest(conversationId, { signal: load.signal });
    load.done();
    if (ownSession !== session) return { ok: false };
    const removed = result.ok || result.code === 'NOT_FOUND';
    const failure = removed ? null : assistantFailureView(result);
    if (removed) {
      const entry = state.running[conversationId];
      const run = entry ? runs.get(entry.token) : null;
      if (run) {
        runs.delete(run.token);
        run.cancelFlush?.();
        run.controller.abort();
      }
      listMutations.set(conversationId, ++mutationVersion);
    }
    // Açık konuşma silinince yerine taslak gelir; kullanıcı Geçmiş listesindeyse orada kalır.
    if (removed && state.active.id === conversationId) {
      cancelViewLoad();
      update((current) => ({ ...current, active: draft() }));
    }
    update((current) => {
      const deleting = { ...current.deleting };
      delete deleting[conversationId];
      return {
        ...current,
        deleting,
        status: isSessionFailure(result) ? 'error' : current.status,
        failure: isSessionFailure(result) ? failure : current.failure,
        running: removed ? setRunning(current, conversationId, null) : current.running,
        list: removed ? { ...current.list, items: current.list.items.filter((item) => item.id !== conversationId) } : { ...current.list, error: failure },
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
    listLoad = null;
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
