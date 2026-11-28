import 'server-only';
import { cleanEvidenceCardText } from '../../../../domain/ai/evidenceCards.js';
import { readTaskFacts } from './rotaToolStore.js';
import { taskItem } from './rotaToolSupport.js';
import { sortFacts } from './taskFacts.js';

/**
 * Bilgin ICE-2 — canlı kanıt kartı nüfus kaydı (yalnızca sunucu, yalnızca bu tur).
 *
 * Toplu araçlar (görev özeti, iş yükü, portföy) bir sayıyı yetkili görev olgularının bellekteki nüfusundan hesaplar; o
 * sayının katkıda bulunan görevleri de aynı anda ve aynı koşulla bilinir. Bu modül her sayının yük alanı yolu (ör.
 * `data.totals.overdue`, `data.groups.2.open`) için katkıda bulunan nüfusun KESİN büyüklüğünü ve kartta gösterilecek ilk
 * satırlarını tutar. Kayıt model zarfına, kalıcı kanıta, günlüğe ya da tarayıcıya gitmez; yalnızca kart kurucusu okur.
 *
 * Güven kuralları:
 *   - Büyüklük, sayının hesaplandığı döngüde toplanan olgulardan gelir; kart kurulurken yükteki sayı, bağın sayısı ve kayıt
 *     büyüklüğü birbirine eşit değilse kart üretilmez (kapalı ret).
 *   - Önizleme satırları aynı nüfusun alt kümesidir; son yetki yeniden doğrulaması bütün nüfusu zaten kapsar.
 *   - Sorumlu adları gerekiyorsa önizleme satırlarının BİRLEŞİMİ için tek ve sınırlı bir okuma yapılır (görev aramasının
 *     sayfa sorumlu okumasıyla aynı yol); sayı başına sorgu açılmaz.
 */

export const CARD_POPULATION_LIMITS = Object.freeze({
  /** Küme başına önizleme satırı (kart başına satır sınırıyla aynı). */
  previewPerSet: 30,
  /** Araç çağrısı başına önizleme satırlarının birleşimi (sorumlu okumasının üst sınırı). */
  maxPreviewTasks: 400,
  /** Araç çağrısı başına kayıtlı küme. */
  maxSets: 240
});

/** Kümenin gösterim sırası: gecikmişler gecikmeye, tamamlananlar tamamlanmaya, diğerleri termine göre. */
function sortFor(path) {
  if (/(?:^|\.)overdue$/.test(path)) return 'overdue_days_desc';
  if (/(?:^|\.)(?:done|doneWithoutActualFinish)$/.test(path)) return 'actual_finish_desc';
  return 'target_finish_asc';
}

/** Görevin canlı kart sorumlu özeti (görev aramasıyla ortak): gizli, çözülemeyen ve görünür sorumlu sayıları. */
export function cardAssignmentsFor(facts, assignees) {
  return new Map(facts.map((fact) => {
    const unresolved = [];
    let visibleCount = 0;
    let hiddenCount = 0;
    let hasUnusableName = false;
    (assignees.get(fact.id) || []).forEach((person, index) => {
      if (!person.identityVisible) hiddenCount += 1;
      else if (!person.resolved) unresolved.push(index);
      else if (cleanEvidenceCardText(person.name)) visibleCount += 1;
      else {
        unresolved.push(index);
        hasUnusableName = true;
      }
    });
    return [fact.id, { unresolved, visibleCount, hiddenCount, hasUnusableName }];
  }));
}

/**
 * Kart nüfus kaydı. `sets`: `[yükAlanıYolu, olgular[], satırKimliği?]` (olgular sayının hesaplandığı döngüden; satır yolundaki
 * kümede satırın kimliği de saklanır ve kart kurulurken yükteki satırla karşılaştırılır). `assignees`
 * olguların sorumlu izdüşümü zaten okunduysa verilir; verilmezse önizleme birleşimi için tek okuma yapılır.
 * @returns {Promise<{ sets: Map<string, { size: number, ids: string[] }>, rows: Map<string, object>, assignments: Map<string, object> } | null>}
 */
export async function buildCardPopulation(call, scope, { sets, projects, assignees = null, today }) {
  const usable = (sets || []).filter(([path, facts]) => typeof path === 'string' && Array.isArray(facts)).slice(0, CARD_POPULATION_LIMITS.maxSets);
  if (!usable.length) return null;
  const sorted = new Map();
  const ordered = (facts, sort) => {
    // Aynı olgu dizisi için sıralama bir kez yapılır (ör. bütün nüfus birden çok kümede).
    const key = `${sort}`;
    if (!sorted.has(facts)) sorted.set(facts, new Map());
    const cache = sorted.get(facts);
    if (!cache.has(key)) cache.set(key, facts.length > 1 ? sortFacts(facts, sort, today) : facts);
    return cache.get(key);
  };
  const result = new Map();
  const preview = new Map();
  for (const [path, facts, rowKey = null] of usable) {
    const ids = [];
    for (const fact of ordered(facts, sortFor(path))) {
      if (ids.length >= CARD_POPULATION_LIMITS.previewPerSet) break;
      // Önizleme birleşimi sınırı dolduysa yeni görev eklenmez: küme yalnızca zaten seçilmiş satırları kullanabilir.
      if (!preview.has(fact.id) && preview.size >= CARD_POPULATION_LIMITS.maxPreviewTasks) break;
      preview.set(fact.id, fact);
      ids.push(fact.id);
    }
    // Önizleme kesintiye uğradıysa (birleşim sınırı) ve satır sayısı nüfustan azsa kart kısmi önizlemedir; boş önizleme kart değildir.
    result.set(path, Object.freeze({ size: facts.length, ids: Object.freeze(ids), ...(rowKey != null ? { rowKey: String(rowKey) } : {}) }));
  }
  const previewFacts = [...preview.values()];
  let people = assignees;
  if (!people && previewFacts.length) {
    people = (await call.sql((executor) => readTaskFacts(executor, scope, {
      taskIds: previewFacts.map((fact) => fact.id), withAssignees: true, maxRows: previewFacts.length
    }))).assignees;
  }
  people ||= new Map();
  const rows = new Map(previewFacts.map((fact) => [fact.id, taskItem(fact, { projects, assignees: people, today })]));
  return Object.freeze({ sets: result, rows, assignments: cardAssignmentsFor(previewFacts, people) });
}
