'use client';
import { createContext, useContext } from 'react';
import { Avatar } from '../../../components/ui';
import { Icons } from '../../../components/icons';
import { HoverListCard } from '../../../components/ui-extras';
import { evidenceCardsExpired } from '../../../domain/ai/evidenceCards.js';
import { projectColorVar } from '../../../lib/colors';
import { fmt } from '../../../scheduling/dates';
import { evidenceTimeLabel } from './assistantPresentation.js';

/**
 * Bilgin etkileşimli kanıt kartı (ICE-1, ICE-2).
 *
 * ICE-2 kart türleri: tekil kişi/proje/örgüt birimi (doğrulanmış ölçüler ve görev önizlemesi), bunların koleksiyonları (ad ve
 * sütun başına sayı), hesap (pay, payda, işlem ve sonuç) ve karşılaştırma (iki değer ve fark). Bütün metinler ve sayılar
 * sunucunun doğrulanmış tanımlayıcısındandır; tarayıcı hiçbir değeri yeniden hesaplamaz.
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
  return <span className={`status-pill ice-status-pill ${cls}`}><Icon size={10} aria-hidden="true" />{label}</span>;
}

function assigneeLabels(item, preview = false) {
  const names = preview ? item.assignees.slice(0, 2) : item.assignees;
  const omitted = item.assignees.length - names.length;
  const unresolved = item.unresolvedAssignees || Number(item.assignment === 'unresolved');
  return [
    names.join(', '),
    item.assigneesClipped ? 'Diğer görünür adlar listelenmiyor' : omitted > 0 ? `+${omitted}` : null,
    item.hiddenAssignees > 0 ? `${item.hiddenAssignees} sorumlu gösterilemiyor` : null,
    unresolved > 0 ? `${unresolved} sorumlunun dizin kaydı çözülemedi` : null,
    item.assignment === 'unassigned' ? 'Sorumlusuz' : null,
    item.assignment === 'undisclosed' && !item.hiddenAssignees ? 'Sorumlu bilgisi gösterilemiyor' : null
  ].filter(Boolean);
}

/** Satırın ikincil bilgisi: proje ve sorumlular (tarih sağ sütundadır). */
export function evidenceItemMeta(item) {
  return [item.project, ...assigneeLabels(item, true)].filter(Boolean).join(' · ');
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
  const date = evidenceItemDate(item);
  const meta = evidenceItemMeta(item);
  const label = [`${item.title} görevini aç`, meta, tail?.text || evidenceStatus(item).label, date].filter(Boolean).join(' · ');
  const body = (
    <>
      <span className="rli-bar" style={{ background: item.project ? projectColorVar(item.project) : 'var(--border-strong)' }} />
      <span className="rli-main">
        <span className="rli-name" title={item.title}>{item.title}</span>
        <span className="rli-meta" title={meta}>{meta}</span>
      </span>
      <span className="ice-row-side">
        {tail ? <span className={`ice-row-tail is-${tail.tone}`}>{tail.text}</span> : <EvidenceStatusPill item={item} />}
        {date && <span className="ice-row-date">{date}</span>}
      </span>
    </>
  );
  if (!onOpen) return <div className="rt-list-item ice-row is-static">{body}</div>;
  return (
    <button type="button" className="rt-list-item ice-row" onClick={() => { close(); onOpen(item.id); }} aria-label={label}>
      {body}
    </button>
  );
}

function PeopleSection({ card }) {
  const unresolved = card.items.filter((item) => item.unresolvedAssignees || item.assignment === 'unresolved').length;
  const hasChips = Boolean(card.people.length || card.unassigned || card.undisclosed || unresolved);
  const partial = card.peopleClipped || (!card.people.length && card.items.some((item) => item.assigneesClipped));
  if (!hasChips && !partial) return null;
  return (
    <div className="ice-people">
      <div className="ice-section-label">
        <Icons.Users size={11} aria-hidden="true" />
        <span>{card.people.length > 0 ? `${card.people.length} görünür sorumlu listeleniyor` : 'Sorumlu'}</span>
        {card.items.length < card.total && <span className="ice-section-hint">gösterilen görevlerde</span>}
      </div>
      {partial && <p className="ice-section-hint">Kişi listesi kısmi önizlemedir.{card.people.length > 0 ? ' Kişi başına görev sayısı en az değeri gösterir.' : ''}</p>}
      {hasChips && <ul className="ice-chips" tabIndex={0} aria-label="Sorumlular">
        {card.people.map((person, index) => (
          <li key={`${person.name}-${index}`} className="ice-chip" title={`${person.name} · ${partial ? 'en az ' : ''}${person.tasks} görev`}>
            <Avatar name={person.name} size="sm" />
            <span className="ice-chip-name">{person.name}</span>
            <span className="ice-chip-count">{partial ? '≥' : ''}{person.tasks}</span>
          </li>
        ))}
        {card.unassigned > 0 && <li className="ice-chip is-muted"><span className="ice-chip-name">Sorumlusuz</span><span className="ice-chip-count">{card.unassigned}</span></li>}
        {unresolved > 0 && <li className="ice-chip is-muted"><span className="ice-chip-name">Dizin kaydı çözülemeyen sorumlusu olan görev</span><span className="ice-chip-count">{unresolved}</span></li>}
        {card.undisclosed > 0 && <li className="ice-chip is-muted"><span className="ice-chip-name">Sorumlu bilgisi gösterilemiyor</span><span className="ice-chip-count">{card.undisclosed}</span></li>}
      </ul>}
    </div>
  );
}

function Notices({ card, preview = true }) {
  // Kaynak listesiyle aynı biçim ve saat dilimi (Türkiye saati).
  const time = evidenceTimeLabel(card.generatedAt);
  const items = card.items || [];
  return (
    <>
      {preview && items.length > 0 && items.length < card.total && (
        <p className="ice-notice"><Icons.Info size={12} aria-hidden="true" /><span>Kanıt sınırı nedeniyle {card.total} görevin tamamı değil, {items.length} görev gösteriliyor.</span></p>
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
  const people = assigneeLabels(item).join(' · ');
  return (
    <>
      <dl className="ice-facts">
        {item.project && <div><dt>Proje</dt><dd>{item.project}</dd></div>}
        <div><dt>Durum</dt><dd><EvidenceStatusPill item={item} /></dd></div>
        <div><dt>Sorumlu</dt><dd>{people}</dd></div>
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

/** Doğrulanmış ölçü satırları (etiket – değer). */
function MetricList({ metrics }) {
  return (
    <dl className="ice-facts">
      {metrics.map((metric) => <div key={metric.label}><dt>{metric.label}</dt><dd className="ice-num">{metric.value}</dd></div>)}
    </dl>
  );
}

const ENTITY_ICONS = Object.freeze({ person: Icons.Users, project: Icons.Briefcase, unit: Icons.Layers, people: Icons.Users, projects: Icons.Briefcase, units: Icons.Layers });
const COLLECTION_NOUNS = Object.freeze({ people: 'kişi', projects: 'proje', units: 'birim' });

/** Tekil kişi/proje/birim: ölçüler; görev önizlemesi aşağıdaki listede. */
function EntitySummary({ card }) {
  return (
    <>
      <MetricList metrics={card.metrics} />
      <Notices card={card} />
    </>
  );
}

/** Varlık koleksiyonu: kaç varlık olduğu ve her birinin doğrulanmış sayıları (kaydırılabilir küçük tablo). */
function CollectionTable({ card }) {
  const noun = COLLECTION_NOUNS[card.kind] || 'kayıt';
  return (
    <>
      <div className="ice-metric">
        <span className="ice-metric-value">{card.total}</span>
        <span className="ice-metric-label">{noun}{card.rows.length < card.total ? ` · ${card.rows.length} gösteriliyor` : ''}</span>
      </div>
      <div className="ice-table-wrap" tabIndex={0} aria-label={`${card.title} tablosu`}>
        <table className="ice-table">
          <thead><tr><th scope="col">{noun === 'kişi' ? 'Kişi' : noun === 'proje' ? 'Proje' : 'Birim'}</th>{card.columns.map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>
            {card.rows.map((row, index) => (
              <tr key={`${row.name}-${index}`}>
                <th scope="row" title={row.name}>{row.name}</th>
                {row.values.map((value, position) => <td key={card.columns[position]}>{value == null ? '—' : value}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {card.rows.length < card.total && <p className="ice-notice"><Icons.Info size={12} aria-hidden="true" /><span>{card.total} {noun} kaydının {card.rows.length} tanesi gösteriliyor.</span></p>}
      <Notices card={card} preview={false} />
    </>
  );
}

/** Hesap ve karşılaştırma: işlenenler, sonuç ve işlem (yeniden hesaplanmaz; sunucunun doğrulanmış metni). */
function FactSummary({ card }) {
  return (
    <>
      <div className="ice-metric"><span className="ice-metric-value">{card.result}</span></div>
      <MetricList metrics={card.metrics} />
      {card.formula && <p className="ice-formula"><span className="ice-section-label">{card.kind === 'calc' ? 'Hesaplama' : 'Değişim'}</span><span>{card.formula}</span></p>}
      {card.note && <p className="ice-section-hint ice-note">{card.note}</p>}
      <Notices card={card} preview={false} />
    </>
  );
}

const CARD_LABELS = Object.freeze({
  task: (card) => `${card.title}: görev kanıtı`, tasks: (card) => `${card.title}: ${card.total} görev`,
  person: (card) => `${card.title}: kişi kanıtı`, project: (card) => `${card.title}: proje kanıtı`, unit: (card) => `${card.title}: birim kanıtı`,
  people: (card) => `${card.title}: ${card.total} kişi`, projects: (card) => `${card.title}: ${card.total} proje`, units: (card) => `${card.title}: ${card.total} birim`,
  calc: (card) => `${card.title}: ${card.result}`, compare: (card) => `${card.title}: ${card.result}`
});

/**
 * Doğrulanmış olgunun etkileşimli tetikleyicisi. Metin değişmez; yalnızca ince noktalı alt çizgiyle ayırt edilir. Süresi
 * dolan kart açılmaz ve ifade sade metne döner.
 */
export function EvidenceReference({ card, receivedAt, expiresAt, focusFallbackRef, text, children }) {
  const { openTask } = useContext(EvidenceCardActionsContext);
  const canOpen = () => !evidenceCardsExpired(receivedAt, Date.now(), expiresAt);
  if (!card || !canOpen()) return children;
  const openFreshTask = openTask ? (id) => { if (canOpen()) openTask(id); } : null;
  const tone = TONES[card.tone] || TONES.neutral;
  const ToneIcon = ENTITY_ICONS[card.kind] || (card.kind === 'calc' || card.kind === 'compare' ? Icons.Chart : tone.icon);
  const single = card.kind === 'task';
  const entity = ['person', 'project', 'unit'].includes(card.kind);
  const collection = ['people', 'projects', 'units'].includes(card.kind);
  const fact = card.kind === 'calc' || card.kind === 'compare';
  const label = (CARD_LABELS[card.kind] || CARD_LABELS.tasks)(card);
  const items = card.items || [];
  const summary = single ? <TaskSummary card={card} /> : entity ? <EntitySummary card={card} /> : collection ? <CollectionTable card={card} />
    : fact ? <FactSummary card={card} /> : <CollectionSummary card={card} />;
  return (
    <HoverListCard
      title={card.title}
      icon={<ToneIcon size={13} aria-hidden="true" />}
      accent={tone.accent}
      items={items}
      listLabel={entity ? card.listLabel || 'Görevler' : 'Görevler'}
      listHint={openTask && items.length ? 'Açmak için tıklayın' : null}
      hideListHead={single}
      hideList={collection || fact || (entity && !items.length)}
      summary={summary}
      renderItem={(item, index, close) => (single
        ? (openTask ? (
          <button key={item.id} type="button" className="rt-list-item ice-open" onClick={() => { close(); openFreshTask(item.id); }}>
            <span>Görev ayrıntısını aç</span><Icons.ChevronRight size={13} aria-hidden="true" />
          </button>
        ) : null)
        : <TaskRow key={item.id} item={item} onOpen={openFreshTask} close={close} />)}
      wrapperClass={`ice-ref is-${card.tone}`}
      wrapperStyle={{ display: 'inline' }}
      cardClass={`ice-card${single || fact ? ' is-single' : ''}${collection ? ' is-table' : ''}`}
      cardLabel={label}
      triggerLabel={`${text} — ${label}. Kayıtları göster`}
      manageFocus
      focusFallbackRef={focusFallbackRef}
      closeOnScroll
      canOpen={canOpen}
    >
      {children}
    </HoverListCard>
  );
}
