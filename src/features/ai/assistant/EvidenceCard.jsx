'use client';
import { createContext, useContext, useState } from 'react';
import { Avatar } from '../../../components/ui';
import { Icons } from '../../../components/icons';
import { HoverListCard } from '../../../components/ui-extras';
import { evidenceCardsExpired } from '../../../domain/ai/evidenceCards.js';
import { projectColorVar } from '../../../lib/colors';
import { fmt } from '../../../scheduling/dates';
import { evidenceTimeLabel } from './assistantPresentation.js';

/**
 * Bilgin etkileşimli kanıt kartı (ICE-1).
 *
 * Kart içeriği sunucunun doğrulanmış, yetkili ve geçici tanımlayıcısıdır; tarayıcı yalnızca çizer. Değerler kanıtın
 * üretildiği andaki değerlerdir (durum, gecikme, termin): canlı görev verisiyle değiştirilmez. Görev ayrıntısı mevcut
 * `openTask(görevKimliği)` sözleşmesiyle açılır; olağan görev erişim kuralları orada uygulanır. Kart Özet'teki etkileşimli
 * kart bileşenini (`HoverListCard`) ve görev satırı biçimini kullanır.
 */

/** Kabuğun görev açma eylemi (AssistantShell sağlar). Sağlanmazsa satırlar yalnızca bilgi gösterir. */
export const EvidenceCardActionsContext = createContext({ openTask: null });

const TONES = Object.freeze({
  overdue: { accent: 'var(--status-overdue)', icon: Icons.Alert },
  done: { accent: 'var(--status-done)', icon: Icons.Check },
  progress: { accent: 'var(--status-progress)', icon: Icons.Clock },
  due: { accent: 'var(--c-amber, var(--status-progress))', icon: Icons.Calendar },
  unassigned: { accent: 'var(--text-muted)', icon: Icons.Users },
  neutral: { accent: 'var(--accent)', icon: Icons.Layers }
});

/** Kanıttaki durumun rozeti (Özet'in `status-pill` sınıflarıyla; bugünün tarihiyle yeniden hesaplanmaz). */
export function evidenceStatus(item) {
  if (item.status === 'done') return { cls: 'status-done', label: 'Tamamlandı', Icon: Icons.Check };
  if (item.overdue) return { cls: 'status-overdue', label: 'Geciken', Icon: Icons.Alert };
  if (item.status === 'in_progress') return { cls: 'status-progress', label: 'Devam ediyor', Icon: Icons.Clock };
  return { cls: 'status-todo', label: 'Yapılacak', Icon: Icons.Circle };
}

function EvidenceStatusPill({ item }) {
  const { cls, label, Icon } = evidenceStatus(item);
  return <span className={`status-pill ${cls}`} style={{ fontSize: 10 }}><Icon size={10} aria-hidden="true" />{label}</span>;
}

/** Satırın ikincil bilgisi: proje ve sorumlular (tarih sağ sütundadır). */
export function evidenceItemMeta(item) {
  const people = item.assignees.length
    ? `${item.assignees.slice(0, 2).join(', ')}${item.assignees.length > 2 ? ` +${item.assignees.length - 2}` : ''}`
    : item.assignment === 'unassigned' ? 'Sorumlusuz' : 'Sorumlu bilgisi gösterilemiyor';
  return [item.project, people].filter(Boolean).join(' · ');
}

/** Satırın sağ ucu: gecikme ya da tamamlanma (yalnızca kanıtta varsa); yoksa durum rozeti çizilir. */
export function evidenceItemTail(item) {
  if (item.overdue && item.overdueDays != null) return { text: `${item.overdueDays} gün gecikmiş`, tone: 'overdue' };
  if (item.status === 'done' && item.finished) return { text: `${fmt(item.finished)} tamamlandı`, tone: 'done' };
  return null;
}

/** Sağ sütunun ikinci satırı: termin (tamamlanmış görevde tamamlanma tarihi zaten ilk satırdadır). */
function evidenceItemDate(item) {
  if (item.status === 'done' && item.finished) return item.due && item.due !== item.finished ? `Termin ${fmt(item.due)}` : null;
  return item.due ? `Termin ${fmt(item.due)}` : 'Terminsiz';
}


function TaskRow({ item, onOpen, close }) {
  const tail = evidenceItemTail(item);
  const body = (
    <>
      <span className="rli-bar" style={{ background: item.project ? projectColorVar(item.project) : 'var(--border-strong)' }} />
      <span className="rli-main">
        <span className="rli-name" title={item.title}>{item.title}</span>
        <span className="rli-meta" title={evidenceItemMeta(item)}>{evidenceItemMeta(item)}</span>
      </span>
      <span className="ice-row-side">
        {tail ? <span className={`ice-row-tail is-${tail.tone}`}>{tail.text}</span> : <EvidenceStatusPill item={item} />}
        {evidenceItemDate(item) && <span className="ice-row-date">{evidenceItemDate(item)}</span>}
      </span>
    </>
  );
  if (!onOpen) return <div className="rt-list-item ice-row is-static">{body}</div>;
  return (
    <button type="button" className="rt-list-item ice-row" onClick={() => { close(); onOpen(item.id); }} aria-label={`${item.title} görevini aç`}>
      {body}
    </button>
  );
}

function PeopleSection({ card }) {
  if (!card.people.length && !card.unassigned && !card.undisclosed) return null;
  return (
    <div className="ice-people">
      <div className="ice-section-label">
        <Icons.Users size={11} aria-hidden="true" />
        <span>{card.people.length > 1 ? `${card.people.length} farklı sorumlu` : 'Sorumlu'}</span>
        {card.items.length < card.total && <span className="ice-section-hint">gösterilen görevlerde</span>}
      </div>
      <ul className="ice-chips">
        {card.people.map((person, index) => (
          <li key={`${person.name}-${index}`} className="ice-chip" title={`${person.name} · ${person.tasks} görev`}>
            <Avatar name={person.name} size="sm" />
            <span className="ice-chip-name">{person.name}</span>
            <span className="ice-chip-count">{person.tasks}</span>
          </li>
        ))}
        {card.unassigned > 0 && <li className="ice-chip is-muted"><span className="ice-chip-name">Sorumlusuz</span><span className="ice-chip-count">{card.unassigned}</span></li>}
        {card.undisclosed > 0 && <li className="ice-chip is-muted"><span className="ice-chip-name">Sorumlu bilgisi gösterilemiyor</span><span className="ice-chip-count">{card.undisclosed}</span></li>}
      </ul>
    </div>
  );
}

function Notices({ card }) {
  // Kaynak listesiyle aynı biçim ve saat dilimi (Türkiye saati).
  const time = evidenceTimeLabel(card.generatedAt);
  return (
    <>
      {card.items.length < card.total && (
        <p className="ice-notice"><Icons.Info size={12} aria-hidden="true" /><span>Kanıt sınırı nedeniyle {card.total} görevin tamamı değil, {card.items.length} görev gösteriliyor.</span></p>
      )}
      {card.scopePartial && (
        <p className="ice-notice is-quiet"><Icons.Shield size={12} aria-hidden="true" /><span>Yalnızca görüntüleme yetkiniz bulunan kayıtlar.</span></p>
      )}
      {time && <p className="ice-time">{time} · yanıt anındaki değerler</p>}
    </>
  );
}

function CollectionSummary({ card }) {
  return (
    <>
      <div className="ice-metric">
        <span className="ice-metric-value">{card.total}</span>
        <span className="ice-metric-label">görev{card.items.length < card.total ? ` · ${card.items.length} gösteriliyor` : ''}</span>
      </div>
      <PeopleSection card={card} />
      <Notices card={card} />
    </>
  );
}

function TaskSummary({ card }) {
  const [item] = card.items;
  const tail = evidenceItemTail(item);
  const people = item.assignees.length ? item.assignees.join(', ') : item.assignment === 'unassigned' ? 'Sorumlusuz' : 'Gösterilemiyor';
  return (
    <>
      <dl className="ice-facts">
        {item.project && <div><dt>Proje</dt><dd>{item.project}</dd></div>}
        <div><dt>Durum</dt><dd><EvidenceStatusPill item={item} /></dd></div>
        <div><dt>Sorumlu</dt><dd>{people}{item.hiddenAssignees > 0 ? ` (+${item.hiddenAssignees} gösterilemiyor)` : ''}</dd></div>
        <div><dt>Termin</dt><dd>{item.due ? fmt(item.due, 'dd MMM yyyy') : 'Terminsiz'}</dd></div>
        {tail && <div><dt>{tail.tone === 'overdue' ? 'Gecikme' : 'Tamamlanma'}</dt><dd className={`is-${tail.tone}`}>{tail.tone === 'overdue' ? `${item.overdueDays} gün` : fmt(item.finished, 'dd MMM yyyy')}</dd></div>}
        {item.progress != null && (
          <div><dt>İlerleme</dt><dd className="ice-progress" aria-label={`İlerleme yüzde ${item.progress}`}>
            <span className="rt-bar"><span style={{ width: `${item.progress}%` }} /></span>
            <span>%{item.progress}</span>
          </dd></div>
        )}
      </dl>
      <Notices card={card} />
    </>
  );
}

/**
 * Doğrulanmış olgunun etkileşimli tetikleyicisi. Metin değişmez; yalnızca ince noktalı alt çizgiyle ayırt edilir. Süresi
 * dolan kart açılmaz ve ifade sade metne döner.
 */
export function EvidenceReference({ card, receivedAt, text, children }) {
  const { openTask } = useContext(EvidenceCardActionsContext);
  const [expired, setExpired] = useState(() => evidenceCardsExpired(receivedAt));
  if (expired || !card || evidenceCardsExpired(receivedAt)) return children;
  const tone = TONES[card.tone] || TONES.neutral;
  const ToneIcon = tone.icon;
  const single = card.kind === 'task';
  const label = single ? `${card.title}: görev kanıtı` : `${card.title}: ${card.total} görev`;
  return (
    <HoverListCard
      title={card.title}
      icon={<ToneIcon size={13} aria-hidden="true" />}
      accent={tone.accent}
      items={card.items}
      listLabel="Görevler"
      listHint={openTask ? 'Açmak için tıklayın' : null}
      hideListHead={single}
      summary={single ? <TaskSummary card={card} /> : <CollectionSummary card={card} />}
      renderItem={(item, index, close) => (single
        ? (openTask ? (
          <button key={item.id} type="button" className="rt-list-item ice-open" onClick={() => { close(); openTask(item.id); }}>
            <span>Görev ayrıntısını aç</span><Icons.ChevronRight size={13} aria-hidden="true" />
          </button>
        ) : null)
        : <TaskRow key={item.id} item={item} onOpen={openTask} close={close} />)}
      wrapperClass={`ice-ref is-${card.tone}`}
      wrapperStyle={{ display: 'inline' }}
      cardClass={`ice-card${single ? ' is-single' : ''}`}
      cardLabel={label}
      triggerLabel={`${text} — ${label}. Kayıtları göster`}
      manageFocus
      closeOnScroll
    >
      <span onMouseEnter={() => { if (evidenceCardsExpired(receivedAt)) setExpired(true); }}>{children}</span>
    </HoverListCard>
  );
}
