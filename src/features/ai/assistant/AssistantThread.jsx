'use client';
import { assistantMarkdownText } from './assistantMarkdown.js';
import { useEffect, useRef, useState } from 'react';
import { Icons } from '../../../components/icons';
import { ASSISTANT_MODES, assistantModeLabel } from '../../../domain/ai/assistantContract.js';
import { AssistantMarkdown } from './AssistantMarkdown.jsx';
import { copyTextToClipboard, followState } from './assistantInteraction.js';
import {
  evidenceKindLabel,
  evidenceNotes,
  evidenceSummaryLabel,
  evidenceTimeLabel,
  finishReasonNote,
  generationPhaseLabel,
  isGroundingFailure
} from './assistantPresentation.js';

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
  'refresh-conversation': 'Konuşmayı yenile',
  reload: 'Sayfayı yenile'
});

const UNANSWERED_NOTICE = Object.freeze({
  tone: 'muted',
  title: 'Bu iletiye yanıt kaydedilmedi',
  message: 'Yanıt tamamlanmadan durdurulmuş ya da bağlantı kesilmiş olabilir.',
  retryable: true,
  action: null
});

/**
 * Kopyalanan metin (görünen yanıt) yalnızca tıklanınca çıkarılır: akış
 * sürerken her çizimde önceki bütün yanıtlar yeniden çözümlenmez.
 */
function CopyAnswerButton({ source }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  const copy = async () => {
    const ok = await copyTextToClipboard(assistantMarkdownText(source));
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
  const [now, setNow] = useState(Date.now);
  const remaining = Math.max(0, Math.ceil(((failure.retryAt || 0) - now) / 1000));
  useEffect(() => {
    setNow(Date.now());
    if (!retryable || !(failure.retryAt > Date.now())) return undefined;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= failure.retryAt) clearInterval(timer);
    }, 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [failure.retryAt, retryable]);
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
            <button type="button" className="btn sm" onClick={onRetry} disabled={remaining > 0}>
              <Icons.Refresh size={12} aria-hidden="true" /> {remaining > 0 ? `${remaining} sn sonra yeniden dene` : 'Yeniden dene'}
            </button>
          )}
          {/* Yanıtlanmamış son tur yeni ileti göndermeyi kapatır; kullanıcıya her zaman bir çıkış yolu kalır. */}
          <button type="button" className="btn ghost sm" onClick={() => onAction(failure.action || 'new-conversation')}>
            {FAILURE_ACTION_LABELS[failure.action || 'new-conversation']}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Yanıtın dayandığı Rota kaynakları. Her kaynak yanıttaki atıfla (R1, R2 …)
 * eşleşir; yalnızca güvenli künye gösterilir: tür, etiket, veri zamanı,
 * kapsam/kısaltma notu ve birkaç öne çıkan değer. Kayıt içeriği, sorgu ya da
 * araç adı gösterilmez.
 */
function AnswerEvidence({ evidence }) {
  const latest = evidence.map((item) => item.generatedAt).filter(Boolean).sort().pop();
  return (
    <details className="rota-assistant-evidence">
      <summary>
        <Icons.Database size={12} aria-hidden="true" />
        <span>{evidenceSummaryLabel(evidence)}</span>
        {latest && <small>{evidenceTimeLabel(latest)}</small>}
      </summary>
      <ul className="rota-assistant-evidence-list">
        {evidence.map((item) => {
          const notes = evidenceNotes(item);
          return (
            <li key={item.id} className="rota-assistant-evidence-item">
              <span className="rota-assistant-evidence-id" aria-hidden="true">{item.id}</span>
              <div className="rota-assistant-evidence-body">
                <strong><span className="sr-only">{`Kaynak ${item.id}: `}</span>{item.label}</strong>
                <small>{[evidenceKindLabel(item.kind), evidenceTimeLabel(item.generatedAt)].filter(Boolean).join(' · ')}</small>
                {notes.length > 0 && <small className="rota-assistant-evidence-note">{notes.join(' · ')}</small>}
                {item.highlights?.length > 0 && (
                  <dl className="rota-assistant-evidence-highlights">
                    {item.highlights.map((highlight, index) => (
                      <div key={`${item.id}-${index}`}>
                        <dt>{highlight.label}</dt>
                        <dd>{highlight.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** Tek tur: kullanıcı iletisi ve yanıtın o anki durumu. */
export function AssistantTurn({ turn, phase = null, topic = null, canRetry = false, reconciling = false, onRetry, onAction }) {
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
        <span className="sr-only">Bilgin: </span>
        {status === 'waiting' && (
          <p className="rota-assistant-phase">
            <span className="rota-assistant-pulse" aria-hidden="true" />
            {generationPhaseLabel(phase || 'sending', topic) || 'Yanıt bekleniyor…'}
          </p>
        )}
        {hasText && <AssistantMarkdown text={answer.content} evidence={answer.evidence} />}
        {(reconciling || (hasText && (status === 'stopped' || status === 'interrupted' || status === 'failed'))) && (
          <p className="rota-assistant-partial-note">
            {reconciling
              ? 'Yanıtın sonucu kontrol ediliyor; tamamlanmış yanıt sunucuda kaydedilmiş olabilir.'
              : 'Yanıtın bu bölümü tamamlanmadı.'}
          </p>
        )}
        {status === 'complete' && answer.evidence?.length > 0 && <AnswerEvidence evidence={answer.evidence} />}
        {status === 'complete' && (
          <div className="rota-assistant-answer-meta">
            {!isGroundingFailure(answer.finishReason) && <CopyAnswerButton source={answer.content} />}
            {answer.finishReason === 'general' && <span className="rota-assistant-mode-badge">Genel sohbet · Rota verisi okunmadı</span>}
            {deep && <span className="rota-assistant-mode-badge">{assistantModeLabel(ASSISTANT_MODES.DEEP)}</span>}
            {note && <small className="rota-assistant-finish-note">{note}</small>}
          </div>
        )}
        {failure && !active && !reconciling && (
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
export function AssistantThread({ conversationKey, turns, phase = null, topic = null, retryKey = null, reconciling = false, onRetry, onAction, reducedMotion = false, children = null }) {
  const scrollRef = useRef(null);
  const followingRef = useRef(true);
  const lastTopRef = useRef(0);
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
    const node = event.currentTarget;
    const scrolledUp = node.scrollTop < lastTopRef.current;
    lastTopRef.current = node.scrollTop;
    const near = followState({ following: followingRef.current, reason: 'scroll', metrics: node });
    const next = near || (!scrolledUp && followingRef.current);
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
            topic={turn === last ? topic : null}
            canRetry={retryKey === turn.key}
            reconciling={turn === last && reconciling}
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
