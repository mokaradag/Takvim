'use client';
import { useEffect, useRef, useState } from 'react';
import { Icons } from '../../../components/icons';
import { ASSISTANT_MODES, assistantModeLabel } from '../../../domain/ai/assistantContract.js';
import { AssistantMarkdown } from './AssistantMarkdown.jsx';
import { copyTextToClipboard, followState } from './assistantInteraction.js';
import { finishReasonNote, generationPhaseLabel } from './assistantPresentation.js';

/**
 * Konuşma akışı: kullanıcı iletileri ve Rota AI yanıtları.
 *
 * Akan metin canlı bölge DEĞİLDİR (her parça okunmaz); anlamlı durum
 * değişiklikleri panelin tek canlı bölgesinden duyurulur. Kaydırma yalnızca
 * kullanıcı en alttayken yeni metni izler; yukarı kaydıran kullanıcı geri
 * çekilmez, "En yeni" düğmesiyle döner.
 */

export const FAILURE_ACTION_LABELS = Object.freeze({
  settings: 'Ayarlar’ı aç',
  'new-conversation': 'Yeni konuşma başlat',
  reload: 'Sayfayı yenile'
});

const UNANSWERED_NOTICE = Object.freeze({
  tone: 'muted',
  title: 'Bu iletiye yanıt kaydedilmedi',
  message: 'Yanıt tamamlanmadan durdurulmuş ya da bağlantı kesilmiş olabilir.',
  retryable: true,
  action: null
});

function CopyAnswerButton({ text }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  const copy = async () => {
    const ok = await copyTextToClipboard(text);
    setCopied(ok);
    clearTimeout(timerRef.current);
    if (ok) timerRef.current = setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button type="button" className="rota-assistant-icon-action" onClick={copy} aria-label={copied ? 'Yanıt kopyalandı' : 'Yanıtı kopyala'} title={copied ? 'Kopyalandı' : 'Kopyala'}>
      {copied ? <Icons.Check size={13} aria-hidden="true" /> : <Icons.Copy size={13} aria-hidden="true" />}
    </button>
  );
}

function AnswerNotice({ failure, retryable, onRetry, onAction }) {
  return (
    <div className={`rota-assistant-notice is-${failure.tone}`}>
      <Icons.Alert size={14} aria-hidden="true" />
      <div className="rota-assistant-notice-copy">
        <strong>{failure.title}</strong>
        <p>{failure.message}</p>
      </div>
      {(retryable || failure.action) && (
        <div className="rota-assistant-notice-actions">
          {retryable && (
            <button type="button" className="btn sm" onClick={onRetry}>
              <Icons.Refresh size={12} aria-hidden="true" /> Yeniden dene
            </button>
          )}
          {failure.action && (
            <button type="button" className="btn ghost sm" onClick={() => onAction(failure.action)}>
              {FAILURE_ACTION_LABELS[failure.action]}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Tek tur: kullanıcı iletisi ve yanıtın o anki durumu. */
export function AssistantTurn({ turn, phase = null, canRetry = false, onRetry, onAction }) {
  const { user, answer } = turn;
  const status = answer?.status || 'waiting';
  const active = status === 'waiting' || status === 'streaming';
  const hasText = Boolean(answer?.content);
  const failure = status === 'unanswered' ? UNANSWERED_NOTICE : answer?.error;
  const note = status === 'complete' ? finishReasonNote(answer.finishReason) : null;
  const deep = answer?.mode === ASSISTANT_MODES.DEEP;
  return (
    <section className="rota-assistant-turn">
      <div className="rota-assistant-user">
        <span className="sr-only">Siz: </span>
        <p className="rota-assistant-user-text">{user.content}</p>
        {turn.contextTrimmed && (
          <small className="rota-assistant-context-note">Konuşma uzun olduğu için en eski iletiler bu yanıtın bağlamına alınmadı.</small>
        )}
      </div>
      <div className={`rota-assistant-answer is-${status}`} aria-busy={active || undefined}>
        <span className="sr-only">Rota AI: </span>
        {status === 'waiting' && (
          <p className="rota-assistant-phase">
            <span className="rota-assistant-pulse" aria-hidden="true" />
            {generationPhaseLabel(phase || 'sending', answer?.mode) || 'Yanıt bekleniyor…'}
          </p>
        )}
        {hasText && <AssistantMarkdown text={answer.content} />}
        {hasText && (status === 'stopped' || status === 'interrupted' || status === 'failed') && (
          <p className="rota-assistant-partial-note">Yanıtın bu bölümü tamamlanmadı ve kaydedilmedi.</p>
        )}
        {status === 'complete' && (
          <div className="rota-assistant-answer-meta">
            <CopyAnswerButton text={answer.content} />
            {deep && <span className="rota-assistant-mode-badge">{assistantModeLabel(ASSISTANT_MODES.DEEP)}</span>}
            {note && <small className="rota-assistant-finish-note">{note}</small>}
          </div>
        )}
        {failure && !active && (
          <AnswerNotice
            failure={failure}
            retryable={canRetry && failure.retryable !== false}
            onRetry={() => onRetry(turn.key)}
            onAction={onAction}
          />
        )}
      </div>
    </section>
  );
}

function scrollToEnd(node, smooth = false) {
  if (!node) return;
  if (typeof node.scrollTo === 'function') node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  else node.scrollTop = node.scrollHeight;
}

/**
 * Konuşma akışı. `conversationKey` değişince (konuşma değişimi) ve yeni tur
 * eklenince en alta gidilir; akan metin yalnızca izleme sürerken kaydırır.
 */
export function AssistantThread({ conversationKey, turns, phase = null, retryKey = null, onRetry, onAction, reducedMotion = false, children = null }) {
  const scrollRef = useRef(null);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const last = turns[turns.length - 1];
  const growth = `${last?.answer?.status || ''}:${last?.answer?.content?.length || 0}`;

  const setFollow = (next) => {
    followingRef.current = next;
    setFollowing(next);
  };

  useEffect(() => {
    followingRef.current = followState({ following: followingRef.current, reason: 'open' });
    setFollowing(followingRef.current);
    scrollToEnd(scrollRef.current);
  }, [conversationKey, turns.length]);

  useEffect(() => {
    if (followingRef.current) scrollToEnd(scrollRef.current);
  }, [growth]);

  const onScroll = (event) => {
    const next = followState({ following: followingRef.current, reason: 'scroll', metrics: event.currentTarget });
    if (next !== followingRef.current) setFollow(next);
  };

  return (
    <div className="rota-assistant-thread-wrap">
      {/* Kaydırılabilir bölge klavyeyle odaklanabilir: yalnızca metinden oluşan yanıt da ok tuşlarıyla okunur. */}
      <div ref={scrollRef} className="rota-assistant-thread" onScroll={onScroll} tabIndex={0} role="region" aria-label="Konuşma">
        {children}
        {turns.map((turn) => (
          <AssistantTurn
            key={turn.key}
            turn={turn}
            phase={turn === last ? phase : null}
            canRetry={retryKey === turn.key}
            onRetry={onRetry}
            onAction={onAction}
          />
        ))}
      </div>
      {!following && turns.length > 0 && (
        <button
          type="button"
          className="rota-assistant-jump"
          onClick={() => {
            setFollow(followState({ following: false, reason: 'jump' }));
            scrollToEnd(scrollRef.current, !reducedMotion);
          }}
        >
          <Icons.ArrowDown size={13} aria-hidden="true" /> En yeni
        </button>
      )}
    </div>
  );
}
