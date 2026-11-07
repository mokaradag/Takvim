import 'server-only';
import { PLANNER_LIMITS } from '../../../domain/ai/plannerOutcome.js';
import { invalidArguments } from './toolErrors.js';
import { parseToolArguments } from './toolArguments.js';
import { TOOL_ERROR_CODES } from './toolErrors.js';
import { addDays } from './rota/taskFacts.js';

/**
 * Aşama 4E — ANALİTİK İSTEK ÖZETİ (`rota_plan.analysis`).
 *
 * "Bu hafta işlerim açısından durumumu değerlendir" ya da "ekibimin iş yükü dengeli mi?" gibi olağan yönetsel
 * sorular tek bir veritabanı sorusu değildir: yanıt birkaç bütünleyici okumadan oluşur. Zayıf model bu okumaları
 * kayıt defterinin ölçü kimlikleri, koleksiyonları ve sıralama kurallarıyla tek tek yazmak zorunda kaldığında
 * bildirim reddedilir (REQUEST_DECLARATION). Özet, aynı anlamsal kararı KÜÇÜK ve KAPALI bir sözlükle taşır:
 *
 *   - `scope`  : analizin öznesi (self, person, team, project, projects, all) ve gerekiyorsa `level`/`names`;
 *   - `focus`  : 1–3 analitik yön (overview, status, priority, deadlines, overdue, upcoming, workload, projects,
 *                schedule, critical);
 *   - `dateFrom`/`dateTo`: yaklaşan termin ufku;
 *   - `visual` : kullanıcı açıkça grafik/görselleştirme istiyor mu (plan düzeyinde de verilebilir).
 *
 * Kararın SAHİBİ modeldir: hangi kapsamın, hangi yönlerin ve hangi ufkun sorulduğunu o seçer. Sunucu kullanıcı
 * cümlesini yorumlamaz (anahtar sözcük, düzenli ifade ya da dil tablosu yoktur); yalnızca türlü özeti, her yön için
 * kayıt defterinin sabit ve sınırlı istek biçimine BELİRLENİMCİ olarak açar. Açılan istekler modelin yazacağı
 * isteklerle AYNI doğrulamadan geçer (şema, güvenilir metin, nüfus, yetenek, çok bölümlü hep-ya-hiç kabul) ve
 * veri okunmadan önce donar. Yetki her okumada araçlardadır: kapsam istemek kapsam vermez.
 */

export const ANALYSIS_SCOPES = Object.freeze(['self', 'person', 'team', 'project', 'projects', 'all', 'previous', 'row']);
export const ANALYSIS_LEVELS = Object.freeze(['unit', 'department', 'directorate']);
export const ANALYSIS_FOCUS = Object.freeze(['overview', 'status', 'priority', 'deadlines', 'overdue', 'upcoming', 'workload', 'projects', 'schedule', 'critical']);
/**
 * Takip sorusunun konuşma eylemi (modelin türlü kararı; sunucu cümleyi yorumlamaz): explain "neden?", expand "biraz daha
 * aç", summarize "en önemli sonuç ne?", prioritize "neye önce odaklanmalıyım?". Eylem okuma kapsamını değil sunumu
 * yönlendirir (expand bu turun ayrıntısını bir düzey artırır; certainty hangi sonucun kesin, hangisinin kanıt sınırıyla
 * temkinli olduğunu öne çıkarır).
 */
export const ANALYSIS_ACTS = Object.freeze(['explain', 'expand', 'summarize', 'prioritize', 'certainty']);
/**
 * Modelin bildirdiği yön sayısı en çok `maxFocus`tur. Sunucunun zorunlu eklediği okumalar (portföyde projelere göre satırlar,
 * ufku taşıyan yön) ve Ayrıntılı yanıtın bütünleyici okuması bu sınırın dışındadır; toplam okuma bölümü `maxParts`'ı aşamaz.
 *
 * Aşama F: model görünür şema 1-3 yön önerir (`maxFocus`; önek önbelleği ve kanonik planlayıcı kapısı değişmez). Geniş
 * yönetici soruları (ör. "durum, gecikme, iş yükü ve yaklaşan teslimatlar için gösterge paneli") gerçekten dört yön ister;
 * fiziksel okumaları mevcut üst sınıra (`maxParts`) sığan dört yön düzeltme turu açılmadan kabul edilir
 * (`maxAcceptedFocus`). Okuma üst sınırı büyümez: bildirilen yönlerin okumaları ile sunucunun zorunlu okumaları birlikte
 * `maxParts`'ı aşarsa plan eskisi gibi reddedilir; isteğe bağlı (grafik türü, Ayrıntılı bütünleyici) okumalar yalnızca yer
 * kaldıysa eklenir.
 *
 * Aşama F: proje portföyü sıralaması bölümler arası bulguların nüfusudur; tam nüfus (bütün satırlar kanıtta) olmadan pay ve
 * "ilk sırada" söylenemez. Tipik birim portföyünün tamamını kapsayabilmesi için portföy sıralaması kayıt defterinin mevcut üst
 * sınırını (10) kullanır; görev ve kişi listeleri 8 satırda kalır. Hiçbir sınır kayıt defterinin sınırını aşmaz.
 */
export const ANALYSIS_LIMITS = Object.freeze({ maxFocus: PLANNER_LIMITS.maxRequests, maxAcceptedFocus: PLANNER_LIMITS.maxRequests + 1, maxNames: 2, rankLimit: 8,
  entityRankLimit: 10, maxParts: PLANNER_LIMITS.maxRequests + 1, maxDetailedParts: PLANNER_LIMITS.maxRequests + 1 });
/** Takipte önceki yön yoksa (ya da yeni öznede anlamı yoksa) genel değerlendirmenin yönleri. */
export const DEFAULT_FOLLOW_UP_FOCUS = Object.freeze(['overview', 'overdue', 'upcoming']);
/** Ayrıntılı yanıtta kapsam başına bütünleyici yön adayları (sırayla; bildirilmemiş ilk uygun olan eklenir). */
const COMPLEMENT = Object.freeze({
  self: ['projects', 'status', 'priority'], team: ['workload', 'status', 'priority'], person: ['projects', 'status', 'priority'],
  project: ['workload', 'status', 'priority'], projects: ['status', 'overdue', 'upcoming'], all: ['projects', 'status', 'priority']
});

// Takvimde gerçekten bulunan gün (şema doğrulayıcısının kanonik `date` biçimi): "2026-02-31" SQL'e ulaşmadan reddedilir.
const DATE = { type: 'string', format: 'date' };
const OPEN = Object.freeze(['todo', 'in_progress']);

/**
 * Modelin gördüğü kapalı özet şeması; açıklamalar yalnızca sözleşmeyi anlatır, dili yorumlamaz. `accepted` doğrulamanın
 * şemasıdır: tek fark, fiziksel okuma sınırına sığan dördüncü yönün kabulüdür (model görünür şema değişmez).
 */
export function analysisSchema({ accepted = false } = {}) {
  return {
    type: 'object', additionalProperties: false, required: ['scope'],
    description: 'Geniş/değerlendirme sorusunda request yerine; sunucu yönleri okumalara açar.',
    properties: {
      scope: { type: 'string', enum: [...ANALYSIS_SCOPES], description: 'self kendi işleri; person adlı kişi; team yönetim kapsamı; project adlı proje; projects görünür projeler; all görünür işler; previous önceki özne; row görünür satır.' },
      rows: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 10 }, description: 'scope row: 1 tabanlı satır(lar).' },
      within: { type: 'string', minLength: 2, maxLength: 120, description: 'Tek projeyle kesişim: self/team/all/previous veya person+withSelf.' },
      level: { type: 'string', enum: [...ANALYSIS_LEVELS], description: 'team düzeyi: unit birim, department bölüm, directorate direktörlük.' },
      names: { type: 'array', minItems: 1, maxItems: ANALYSIS_LIMITS.maxNames, items: { type: 'string', minLength: 2, maxLength: 120 }, description: 'person/project: kullanıcının yazdığı ad(lar).' },
      withSelf: { type: 'boolean', description: 'Kişi adı/tek kişi satırı ile kendini karşılaştır.' },
      focus: { type: 'array', minItems: 1, maxItems: accepted ? ANALYSIS_LIMITS.maxAcceptedFocus : ANALYSIS_LIMITS.maxFocus, uniqueItems: true, items: { type: 'string', enum: [...ANALYSIS_FOCUS] },
        description: '1-3 yön: overview sayılar, status durum, priority öncelik, deadlines termin kovaları, overdue gecikme, upcoming yakın termin, workload iş yükü, projects projeler, schedule aylar, critical kritik açık işler.' },
      act: { type: 'string', enum: [...ANALYSIS_ACTS], description: 'Takip eylemi.' },
      dateFrom: { ...DATE, description: 'Termin ufkunun başı.' },
      dateTo: { ...DATE, description: 'Ufkun sonu.' },
      relativeWindow: { type: 'string', enum: ['today', 'next_7_days', 'all_time'], description: 'today/next_7_days: bağıl gün; all_time: dönem yok. Tarihlerle birlikte verilmez.' },
      visual: { type: 'boolean' }
    }
  };
}

/** Özetin biçim denetimi; sorun yolları `$.analysis…` biçimindedir (modelin değeri yansıtılmaz). */
/**
 * Yapısal yazım normalleştirmesi (dil yorumu değil): kapalı yön sözlüğündeki bir değerin tekil/çoğul yazımı ("deadline" →
 * "deadlines") sözlükteki değere çevrilir; sözlük dışı konuşma eylemi yalnızca sunum ipucu olduğundan düşürülür (veri
 * okumasını değiştirmez). Alanların kendisi kapsamı belirlediğinde (ad listesiyle `projects`, satır listesiyle `previous`)
 * kapsam o alanın tek anlamına çevrilir. Başka her değer olduğu gibi doğrulanır.
 */
export function normalizedBrief(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const out = { ...raw };
  if (Array.isArray(out.focus)) {
    out.focus = out.focus.map((item) => (typeof item !== 'string' || ANALYSIS_FOCUS.includes(item) ? item
      : ANALYSIS_FOCUS.find((known) => known === `${item}s` || `${known}s` === item) || item));
    out.focus = out.focus.filter((item, index) => out.focus.indexOf(item) === index);
  }
  if (out.act != null && !ANALYSIS_ACTS.includes(out.act)) delete out.act;
  // Aşama F: takip dışındaki özette `all_time` "dönem yok" demektir (yalnızca takipte devralınan dönemi kaldırır): alanın yokluğuyla
  // eşdeğerdir. Eşdeğer yazımın düşmesi onarımda kapsam değişikliği sayılmaz.
  if (out.relativeWindow === 'all_time' && !['previous', 'row'].includes(out.scope)) delete out.relativeWindow;
  // Kapsam/alan tutarlılığı: adı verilen projeler portföy değil adlı proje kapsamıdır; satır sırası satır göndergesidir.
  if (out.scope === 'projects' && Array.isArray(out.names) && out.names.length) out.scope = 'project';
  if (out.scope === 'previous' && Array.isArray(out.rows) && out.rows.length) out.scope = 'row';
  return out;
}

export function parseAnalysis(raw) {
  let value;
  raw = normalizedBrief(raw);
  try { value = parseToolArguments(analysisSchema({ accepted: true }), JSON.stringify(raw ?? null)); } catch (error) {
    if (error?.code !== TOOL_ERROR_CODES.INVALID_ARGUMENTS) throw error;
    throw invalidArguments((error.details || ['$:invalid']).map((detail) => String(detail).replace(/^\$/, '$.analysis')));
  }
  const problems = [];
  const follow = ['previous', 'row'].includes(value.scope);
  if (!follow && !value.focus?.length) problems.push('$.analysis.focus:required');
  const named = ['person', 'project'].includes(value.scope);
  if (named && !value.names?.length) problems.push('$.analysis.names:required');
  if (!named && value.names?.length) problems.push('$.analysis.names:scope');
  if (value.withSelf && !['person', 'row'].includes(value.scope)) problems.push('$.analysis.withSelf:scope');
  if (value.withSelf && value.scope === 'person' && value.names?.length !== 1) problems.push('$.analysis.names:withSelf');
  if (value.level && value.scope !== 'team') problems.push('$.analysis.level:scope');
  if ((value.scope === 'row') !== (value.rows != null)) problems.push('$.analysis.rows:scope');
  if (value.within != null && !['self', 'team', 'all', 'previous'].includes(value.scope) && !(value.scope === 'person' && value.withSelf)) problems.push('$.analysis.within:scope');
  if (value.relativeWindow && (value.dateFrom || value.dateTo)) problems.push('$.analysis.relativeWindow:conflict');
  if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) problems.push('$.analysis.dateFrom:reversed');
  if (problems.length) throw invalidArguments(problems);
  return Object.freeze({ ...value, ...(value.focus ? { focus: Object.freeze([...value.focus]) } : {}), ...(value.names ? { names: Object.freeze([...value.names]) } : {}) });
}

/** Önceki yönlerden yeni öznede anlamı olanlar (ör. proje satırına "projelere göre" uygulanmaz). */
function inheritableFocus(focus, scope) {
  return (focus || []).filter((item) => !(item === 'projects' && scope === 'project'));
}

/**
 * Takip özetinin KANONİK biçimi (Aşama 4E kalite yakınsaması). Zayıf model "Neden?", "Bunu grafikle göster" ya da
 * "Peki önümüzdeki 7 gün?" gibi kısa takipte bütün durumu yeniden kurmak zorunda değildir: yalnızca değişeni yazar.
 * Yazılmayan yön ve ufuk, sunucunun sakladığı önceki doğrulanmış analizden gelir (kimlik değil, türlü değer). Satır
 * göndergesinde yön yazılmadıysa önceki yönler yeni öznede anlamlı olanlarıyla sürer; hiçbiri kalmazsa genel
 * değerlendirme yönleri kullanılır. Yetki ve kimlik burada yoktur: açılan her okuma güncel yetkiyle yürür.
 */
export function resolveAnalysisBrief(analysis, { previous = null, today = null } = {}) {
  const follow = ['previous', 'row'].includes(analysis.scope);
  if (!follow) return analysis;
  const rowType = analysis.scope === 'row' && previous ? previous.rows?.[(analysis.rows?.[0] ?? 1) - 1]?.type ?? null : null;
  const target = analysis.scope === 'row' ? rowType : previous?.scope;
  // Satır daraltması, önceki analizde seçilen ve yeni özne için geçerli olan yönleri sırasıyla korur.
  let focus = analysis.focus?.length ? [...analysis.focus] : inheritableFocus(previous?.focus, target);
  if (!focus.length) focus = [...DEFAULT_FOLLOW_UP_FOCUS];
  const relativeWindow = analysis.relativeWindow || (!analysis.dateFrom && !analysis.dateTo ? previous?.relativeWindow : null);
  const inherited = previous?.relativeWindow && previous.relativeWindow !== 'all_time' && today ? { dateFrom: today, dateTo: previous.relativeWindow === 'today' ? today : addDays(today, 6) } : previous;
  const window = relativeWindow ? { relativeWindow } : {
    ...(inherited?.dateFrom ? { dateFrom: inherited.dateFrom } : {}), ...(inherited?.dateTo ? { dateTo: inherited.dateTo } : {}) };
  const withSelf = analysis.scope === 'previous' && previous?.withSelf ? { withSelf: true } : {};
  const merged = { ...window, ...withSelf, ...analysis, focus: Object.freeze(focus) };
  if (merged.dateFrom && merged.dateTo && merged.dateFrom > merged.dateTo) throw invalidArguments(['$.analysis.dateFrom:reversed']);
  return Object.freeze(merged);
}

/** Özetin kapsam ipuçları: yalnızca sözleşmeden. */
export function analysisHints(problems) {
  const hints = [];
  const has = (prefix) => problems.some((problem) => String(problem).startsWith(prefix));
  if (has('$.analysis.names')) hints.push('analysis.names: person/project kapsamında kullanıcının yazdığı ad (zorunlu); diğer kapsamlarda verilmez');
  if (has('$.analysis.level')) hints.push('analysis.level yalnızca scope team ile');
  if (has('$.analysis.focus')) hints.push(`analysis.focus: önem sırasıyla 1-${ANALYSIS_LIMITS.maxFocus} öğe, ${ANALYSIS_FOCUS.join('|')}`);
  if (has('$.analysis.focus:maxItems')) hints.push(`analysis.focus en çok ${ANALYSIS_LIMITS.maxFocus} öğedir: yazdığın yönlerden sorunun açıkça istediklerini sırasıyla koru, kendi eklediğin fazlalığı çıkar (yeni yön ekleme)`);
  if (has('$.analysis.focus:requestBudget') && has('$.analysis.focus:narrowable')) {
    hints.push(`Yönlerin okumaları bütçeye sığmıyor: yazdığın yönlerden sorunun en önemli olanlarını sırasıyla koru (en çok ${ANALYSIS_LIMITS.maxFocus}), fazlalığı çıkar; yeni yön ekleme.`);
  } else if (has('$.analysis.focus:requestBudget')) hints.push('Karşılaştırmanın bütün yönleri istek bütçesine sığmıyor; yönleri sessizce düşürme, kullanıcıdan hangi yönü önce istediğini açıklamasını iste.');
  if (has('$.analysis.scope')) hints.push(`analysis.scope: ${ANALYSIS_SCOPES.join('|')}`);
  if (has('$.analysis.date')) hints.push('analysis.dateFrom/dateTo: YYYY-MM-DD, dateFrom ≤ dateTo');
  if (has('$.analysis.rows')) hints.push('analysis.rows yalnızca scope "row" ile: önceki yanıtın satır sırası ([1] ya da [1,2]); kapsam satırdaki kişi/projedir');
  if (has('$.analysis.within:conflict')) hints.push('Önceki kapsam zaten bir projeyle sınırlı: analysis.within verilmez (aynı projeyse within yazma; başka bir projeyse scope project ve names ile yeni analiz)');
  else if (has('$.analysis.within')) hints.push('analysis.within (tek proje adıyla daraltma) yalnızca scope self|team|all|previous ile');
  if (has('$.analysis.dateTo:past')) hints.push('upcoming için dateTo bugünden önce olamaz; geçmiş terminler overdue yönüdür');
  if (has('$.analysis:request')) hints.push('analysis ile request/additionalRequests/calls birlikte verilmez');
  return hints;
}

/* ── Belirlenimci açılım ───────────────────────────────────────────── */

const peopleScopes = new Set(['team', 'all', 'project', 'projects']);
/** Termin ufkunu (dateFrom/dateTo) okumasına uygulayan yönler. */
const WINDOW_FOCUS = new Set(['upcoming', 'critical', 'schedule', 'status']);

/**
 * Aşama F — gecikme her zaman BUGÜNE göre ölçülür. Başlangıcı bugün ya da sonrası olan (tamamen gelecekteki) bir dönem,
 * tanımı gereği gecikmiş iş içermez: "önümüzdeki 14 günün teslimatları ile mevcut gecikmeler" sorusunda gecikmiş iş okumasına
 * bu dönemi uygulamak her zaman "gecikmiş görev yok" yanıtını üretir ve kullanıcıya yanlış güvence verir. Bu nedenle böyle bir
 * dönem yalnızca gecikme yönünün okumasından çıkarılır; diğer yönler dönemi aynen kullanır. Karar yalnızca türlü tarih
 * değerlerinin bugünle karşılaştırılmasıdır (kullanıcı metni yorumlanmaz) ve okumanın kendi ölçütünde görünür kalır.
 */
export function futureWindow(analysis, today) {
  return Boolean(today && analysis?.dateFrom && analysis.dateFrom >= today);
}

/** Gecikme yönünün nüfusu: gelecekteki dönem çıkarılır, diğer bütün kapsam koşulları (sorumlu, varlıklar) korunur. */
function overdueBase(base, analysis, today) {
  if (!futureWindow(analysis, today)) return base;
  const { dateFrom: _from, dateTo: _to, ...filters } = base.filters;
  return { ...base, filters };
}

/**
 * Önceki analizin öznesi (sunucunun bağladığı kanonik bağlam): kapsam ve kimlikler ondan gelir; model kimlik görmez ve yazmaz.
 * Bağlam yoksa ya da satır yoksa gönderge yoktur (veri okunmadan açıklama istenir).
 */
function previousBase(analysis, previous) {
  // Satır-yalnız bağlam (ayrıntılı istekle listelenen görevler) önceki özne değildir: süzgeçleri özetle temsil edilemez.
  if (!previous || (analysis.scope === 'previous' && previous.rowsOnly)) throw invalidArguments(['$.analysis.scope:unavailable']);
  if (analysis.scope === 'row') {
    // Karşılaştırma yanıtının satır tablosu yoktur; görünen öğeler karşılaştırılan öznelerdir (gösterilen sırayla).
    const items = previous.rows;
    const rows = analysis.rows.map((row) => items[row - 1]);
    if (rows.some((row) => !row) || new Set(rows.map((row) => row.type)).size !== 1) throw invalidArguments(['$.analysis.rows:unavailable']);
    // Karşılaştırma yalnızca tek gerçek kişi satırını kabul eder; proje satırının kişi kesişimi yeterli değildir.
    if (analysis.withSelf && (rows.length !== 1 || rows[0].type !== 'person')) throw invalidArguments(['$.analysis.withSelf:scope']);
    const entities = rows.map(({ type, id }) => ({ type, id })).filter((item, index, all) => all.findIndex((other) => other.type === item.type && other.id === item.id) === index);
    if (rows[0].type === 'project') {
      // Görev satırının projesi kendi başına incelenir (önceki görev süzgeci projeye taşınmaz).
      if (previous.rowsOnly) return { scope: 'project', base: { filters: {}, entities } };
      const parent = previous.rowPopulation || (['self', 'team', 'person'].includes(previous.scope) ? previous : null);
      if (parent) {
        // Kişi/ekip/kendi kesişimindeki birden çok proje, karşılaştırma sözleşmesiyle anlamı korunarak temsil edilemez.
        if (entities.length !== 1 || parent.scope === 'person' && parent.subjects.length !== 1) throw invalidArguments(['$.analysis.rows:scope']);
        const base = parent.scope === 'person' ? { filters: {}, entities: parent.subjects } : scopeBase(parent);
        return { scope: parent.scope, base: { filters: base.filters, entities: [...base.entities, ...entities] } };
      }
    }
    const projects = previous.within ? [previous.within] : previous.scope === 'project' ? previous.subjects : [];
    if (rows[0].type === 'person' && projects.length > 1) throw invalidArguments(['$.analysis.rows:scope']);
    if (rows[0].type === 'person' && projects.length) entities.push({ type: 'project', id: projects[0].id });
    return { scope: rows[0].type, base: { filters: {}, entities } };
  }
  const scope = previous.scope;
  // Önceki daraltma (ör. ekip ∩ proje) öznenin parçasıdır: proje kimliği sunucunun bağladığı kimliktir.
  const within = previous.within ? [{ type: 'project', id: previous.within.id }] : [];
  if (['person', 'project'].includes(scope)) return { scope, base: { filters: {}, entities: [...previous.subjects.map(({ type, id }) => ({ type, id })), ...within] } };
  const base = scopeBase({ scope, level: previous.level });
  return { scope, base: { ...base, entities: [...base.entities, ...within] } };
}

/** Kapsamın nüfus koşulları ve varlıkları (modelin yazacağı istek alanları). */
function scopeBase(analysis) {
  switch (analysis.scope) {
    case 'self': return { filters: { assignee: 'me' }, entities: [] };
    case 'team': return { filters: { assignee: 'team', ...(analysis.level ? { teamLevel: analysis.level } : {}) }, entities: [] };
    case 'person': return { filters: {}, entities: analysis.names.map((text) => ({ type: 'person', text })) };
    case 'project': return { filters: {}, entities: analysis.names.map((text) => ({ type: 'project', text })) };
    default: return { filters: {}, entities: [] };
  }
}

const request = (fields) => ({ layout: 'auto', ...fields });

/**
 * Portföy özeti (rota_portfolio_summary) yalnızca bütün portföy için okunur: aracın proje ya da kişi seçicisi yoktur.
 * Kapsam daraltılmışsa (within projesi, ekip, kişi) aynı yön daraltılmış görev nüfusundan okunur; nüfus hiçbir zaman
 * kabul edilen özetten geniş olmaz.
 */
const portfolioWide = (base) => !base.entities.length && !Object.keys(base.filters).length;

/** Görev satırının bağlam sütunları: kişi kapsamında sorumlu, proje dışı kapsamda proje. */
function rowContext(analysis, base) {
  const projectBound = analysis.scope === 'project' || base.entities.some((entity) => entity.type === 'project');
  return [...(peopleScopes.has(analysis.scope) ? ['task.assignees'] : []), ...(!projectBound ? ['task.project'] : [])];
}

/** Birden çok adlı kayıt (karşılaştırma): her ölçü kendi varlığına bağlanır; sıralı liste yerine kayıt başına değer. */
function comparison(base, metrics, filters = {}, subjectType = null) {
  const population = { ...base.filters, ...filters };
  return request({ operation: 'value', metrics, population: { tool: 'rota_task_analytics' }, entities: base.entities,
    bindings: base.entities.flatMap((item, entity) => !subjectType || item.type === subjectType ? metrics.map((metric) => ({ metric, entity })) : []), ...(Object.keys(population).length ? { filters: population } : {}) });
}

/**
 * Karşılaştırmanın yönü: kayıt başına değerle ifade edilen yönler tek karşılaştırma bölümüdür (ufuk uygulanır); dağılım
 * yönleri (öncelik, termin kovası, aylar, projeler) her kayıt için aynı gruplamadır (kayıt başına bir bölüm, hep birlikte).
 */
function comparisonFor(focus, analysis, base, window, today = null) {
  const subjects = base.entities.filter((entity) => entity.type === analysis.scope);
  const common = base.entities.filter((entity) => entity.type !== analysis.scope);
  // Ortak proje, karşılaştırma öznesi değildir. Mevcut birleşik seçici sözleşmesiyle kişi ∩ proje okunur.
  if (common.length && subjects.length > 1) return subjects.flatMap((subject) => comparisonFor(focus, analysis, { ...base, entities: [subject, ...common] }, window, today) || []);
  const values = (metrics, filters) => comparison(base, metrics, filters, analysis.scope);
  switch (focus) {
    case 'overview':
    case 'workload': return values(['tasks.open', 'tasks.overdue', 'tasks.dueNext7Days']);
    case 'overdue': return comparison(overdueBase(base, analysis, today), ['tasks.overdue'], {}, analysis.scope);
    case 'upcoming': return window ? values(['tasks.total'], { status: [...OPEN], ...window }) : values(['tasks.dueNext7Days']);
    case 'critical': return values(['tasks.total'], { status: [...OPEN], priority: ['critical', 'high'], ...(window || {}) });
    case 'status': return values(['tasks.todo', 'tasks.inProgress', 'tasks.done'], window || {});
    case 'projects':
    case 'priority':
    case 'deadlines':
    case 'schedule': {
      // Projeler arası karşılaştırmada "projelere göre" her proje için tek gruptur: bilgi taşımaz.
      if (focus === 'projects' && analysis.scope === 'project') return null;
      const groupBy = { priority: 'priority', deadlines: 'deadline', schedule: 'target_month', projects: 'project' }[focus];
      return subjects.map((entity) => groups({ ...base, entities: [entity, ...common] }, groupBy, { open: focus !== 'projects', split: focus === 'projects', window: focus === 'schedule' ? window : null }));
    }
    default: return null;
  }
}

function groups(base, groupBy, { open = true, window = null, split = false, future = false } = {}) {
  // Projelere göre iş, birbirini dışlayan bölümlerle (açık + tamamlanan = toplam) okunur: yığılmış çubuk adayıdır. Aşama F: aynı grup
  // satırının gecikmiş sayısı da seçilir (ek okuma yok); proje başına gecikme, bölümler arası bulguların tam nüfusudur. Gecikmiş,
  // açığın alt kümesidir; yığılmış seri olarak kullanılmaz (bölüntü yalnızca açık + tamamlanan).
  // Gelecekteki dönemde (ilk gün bugün ya da sonrası) dönemli görevin gecikmiş sayısı yapısal olarak sıfırdır: sütun seçilmez.
  const metrics = split ? ['tasks.open', ...(future ? [] : ['tasks.overdue']), 'tasks.done'] : ['tasks.total'];
  return request({ operation: 'list', metrics, population: { tool: 'rota_task_analytics', collection: 'groups', groupBy },
    ...(base.entities.length ? { entities: base.entities } : {}),
    filters: { ...base.filters, ...(open && !split ? { status: [...OPEN] } : {}), ...(window || {}) } });
}

function ranked(base, analysis, { metrics, rank, filters }) {
  const all = [...metrics, ...rowContext(analysis, base)].slice(0, 8);
  // Satırın proje adı birden çok yolda (ad/kod) taşınır: kayıt defterinin tek yolu açıkça bağlanır.
  const fields = all.includes('task.project') ? [{ metric: 'task.project', tool: 'rota_task_search', path: 'data.tasks.*.project.name' }] : [];
  return request({ operation: 'rank', metrics: all, rank: { ...rank, limit: ANALYSIS_LIMITS.rankLimit }, ...(fields.length ? { fields } : {}),
    population: { tool: 'rota_task_search', collection: 'tasks' }, ...(base.entities.length ? { entities: base.entities } : {}),
    filters: { ...base.filters, ...filters } });
}

/**
 * Tek yönün isteği (ya da karşılaştırmada kayıt başına istekler); kapsamda anlamı yoksa `null` (yön düşer, diğerleri kalır).
 * `today`: yaklaşan işin alt sınırı — yalnızca üst sınırı verilen ufuk geçmiş (gecikmiş) terminleri kapsamaz.
 */
function focusRequest(focus, analysis, base, today = null) {
  const compare = base.entities.filter((entity) => entity.type === (analysis.scope === 'person' ? 'person' : 'project')).length > 1 && ['person', 'project'].includes(analysis.scope);
  const window = analysis.dateFrom || analysis.dateTo ? { ...(analysis.dateFrom ? { dateFrom: analysis.dateFrom } : {}), ...(analysis.dateTo ? { dateTo: analysis.dateTo } : {}) } : null;
  const ahead = window && focus === 'upcoming' ? upcomingFrom(window, today) : window;
  if (compare) return comparisonFor(focus, analysis, base, focus === 'upcoming' ? ahead : window, today);
  switch (focus) {
    case 'overview':
      if (analysis.scope === 'projects' && portfolioWide(base)) {
        return request({ operation: 'value', metrics: ['projects.total', 'tasks.open', 'tasks.overdue', 'tasks.dueNext7Days', 'projects.withOverdue'],
          population: { tool: 'rota_portfolio_summary' } });
      }
      return request({ operation: 'value', metrics: ['tasks.total', 'tasks.open', 'tasks.done', 'tasks.overdue', 'tasks.dueNext7Days', 'tasks.completionRatePercent'],
        population: { tool: 'rota_task_analytics' }, ...(base.entities.length ? { entities: base.entities } : {}), filters: { ...base.filters } });
    // Dönem verilmişse durum dağılımı o dönemde terminli işlerdir (ör. geçen ayın tamamlanma görünümü).
    case 'status': return groups(base, 'status', { open: false, window });
    case 'priority': return groups(base, 'priority');
    case 'deadlines': return groups(base, 'deadline');
    case 'schedule': return groups(base, 'target_month', { window: window ? { ...window } : null });
    case 'overdue':
      return ranked(overdueBase(base, analysis, today), analysis, { metrics: ['tasks.total', 'task.title', 'task.overdueDays', 'task.targetFinish'], rank: { metric: 'task.overdueDays', order: 'desc' }, filters: { deadline: 'overdue' } });
    case 'upcoming':
      return ranked(base, analysis, { metrics: ['tasks.total', 'task.title', 'task.targetFinish', 'task.status'], rank: { metric: 'task.targetFinish', order: 'asc' },
        filters: { status: [...OPEN], ...(ahead ? { ...ahead } : { deadline: 'due_next_7_days' }) } });
    case 'critical':
      return ranked(base, analysis, { metrics: ['tasks.total', 'task.title', 'task.priority', 'task.targetFinish'], rank: { metric: 'task.targetFinish', order: 'asc' },
        filters: { status: [...OPEN], priority: ['critical', 'high'], ...(window || {}) } });
    case 'workload':
      // Kişinin dönemli görevleri ortak sorumluları yeni iş yükü öznelerine dönüştürmez.
      if (window && analysis.scope === 'person') return request({ operation: 'value', metrics: ['tasks.open', 'tasks.overdue', 'tasks.dueNext7Days'],
        population: { tool: 'rota_task_analytics' }, entities: base.entities, filters: { ...base.filters, ...window } });
      if (window && analysis.scope !== 'self') return groups(base, 'assignee', { window });
      if (analysis.scope === 'self') return groups(base, 'project', { split: true, window });
      if (analysis.scope === 'person') {
        return request({ operation: 'list', metrics: ['person.name', 'tasks.open', 'tasks.overdue', 'tasks.dueNext7Days'], population: { tool: 'rota_workload_summary', collection: 'people' },
          entities: base.entities });
      }
      return request({ operation: 'rank', metrics: ['person.name', 'tasks.open', 'tasks.overdue', 'tasks.dueNext7Days'], rank: { metric: 'tasks.open', order: 'desc', limit: ANALYSIS_LIMITS.rankLimit },
        population: { tool: 'rota_workload_summary', collection: 'people' }, ...(base.entities.length ? { entities: base.entities } : {}),
        ...(analysis.scope === 'team' ? { filters: { ...base.filters } } : {}) });
    case 'projects':
      if (analysis.scope === 'project') return null;
      if ((analysis.scope === 'projects' || analysis.scope === 'all') && portfolioWide(base)) {
        return request({ operation: 'rank', metrics: ['project.name', 'tasks.open', 'tasks.overdue', 'tasks.dueNext7Days'], rank: { metric: 'tasks.overdue', order: 'desc', limit: ANALYSIS_LIMITS.entityRankLimit },
          population: { tool: 'rota_portfolio_summary', collection: 'projects' } });
      }
      return groups(base, 'project', { split: true, future: futureWindow(analysis, today) });
    default:
      return null;
  }
}

/** Yalnızca üst sınırı verilen yaklaşan iş ufku bugünden başlar; bugün bilinmiyorsa ya da ufuk geçmişteyse reddedilir. */
function upcomingFrom(window, today) {
  if (today && window.dateTo && window.dateTo < today) throw invalidArguments(['$.analysis.dateTo:past']);
  if (window.dateFrom) return today && window.dateFrom < today && (!window.dateTo || window.dateTo >= today)
    ? { ...window, dateFrom: today } : window;
  if (!today) throw invalidArguments(['$.analysis.dateFrom:required']);
  return { dateFrom: today, ...window };
}

/**
 * Özetin bölümleri: her yön en çok bir istek; eşdeğer istekler tekilleşir; çok bölümlü planın sınırı aşılmaz.
 * Sonuç modelin yazacağı ham istek nesneleridir (`request` + `additionalRequests`), doğrulama sonrasındadır.
 */
export function expandAnalysis(analysis, { previous = null, today = null, detail = null, chart = null, charts = null } = {}) {
  analysis = resolveAnalysisBrief(analysis, { previous, today });
  if (analysis.relativeWindow && analysis.relativeWindow !== 'all_time') {
    if (!today) throw invalidArguments(['$.analysis.relativeWindow:required']);
    analysis = { ...analysis, dateFrom: today, dateTo: analysis.relativeWindow === 'today' ? today : addDays(today, 6) };
  }
  // Takip: önceki öznenin kapsamı; yön, ufuk ve görselleştirme yeni sorunundur (model yeniden bildirir). `within` kapsamı
  // DARALTIR (kesişim): kapsam zaten bir projeyle sınırlıysa ikinci proje onun yerine geçmez, plan reddedilir.
  const narrowed = (base) => {
    if (!analysis.within) return base;
    if (base.entities.some((entity) => entity.type === 'project')) throw invalidArguments(['$.analysis.within:conflict']);
    return { ...base, entities: [...base.entities, { type: 'project', text: analysis.within }] };
  };
  if (['previous', 'row'].includes(analysis.scope)) {
    const resolved = previousBase(analysis, previous);
    analysis = { ...analysis, scope: resolved.scope };
    return expandWith(analysis, narrowed(resolved.base), today, detail, chart, charts);
  }
  return expandWith(analysis, narrowed(scopeBase(analysis)), today, detail, chart, charts);
}

/**
 * Adı verilen grafik türünün gerektirdiği okuma (kapalı eşleme; dil yorumu değil): yığılmış çubuk proje başına açık/tamamlanan
 * kırılımı, zaman çizelgesi tarihli görev satırlarını, çizgi aylık termin dizisini, gösterge kartları genel sayıları, halka
 * birbirini dışlayan dağılımı ister. Bildirilen yönler bunu zaten karşılıyorsa ek okuma yoktur.
 */
const CHART_FOCUS = Object.freeze({ stacked: [['projects'], 'projects'], timeline: [['overdue', 'upcoming', 'critical'], 'upcoming'], line: [['schedule'], 'schedule'],
  kpi: [['overview'], 'overview'], donut: [['status', 'priority', 'deadlines', 'projects'], 'status'] });

export function chartFocus(analysis, focus, chart) {
  const rule = CHART_FOCUS[chart];
  if (!rule || focus.some((item) => rule[0].includes(item))) return null;
  // Tek adlı projede "projelere göre" okuması anlamsızdır; kişi kapsamında proje kırılımı kişinin işleridir.
  if (rule[1] === 'projects' && analysis.scope === 'project') return null;
  return rule[1];
}

/** Ayrıntılı yanıtın bütünleyici yönü: bildirilmemiş, kapsamda anlamı olan ilk aday (yoksa `null`). */
export function complementFocus(analysis, focus, detail) {
  if (detail !== 'detailed') return null;
  return (COMPLEMENT[analysis.scope] || []).find((item) => !focus.includes(item)) || null;
}

/**
 * Okunacak yönler: bildirilen yönler korunur; ufuk ve portföy için gerekli bölümler eklenir. Mantıksal veya fiziksel
 * istek bütçesi aşılırsa kısmi plan kabul edilmez. Geçmiş ufuk aylık termin dağılımıyla, diğer ufuk yaklaşan işle okunur.
 */
export function effectiveFocus(analysis, today = null) {
  // Sunucunun zorunlu eklediği yön modelin yön bütçesinden düşmez (zayıf model "portföy + üç yön" için reddedilmez).
  const limit = ANALYSIS_LIMITS.maxParts;
  let focus = [...analysis.focus];
  const window = (analysis.dateFrom || analysis.dateTo) && !focus.some((item) => WINDOW_FOCUS.has(item));
  const implicit = today && analysis.dateTo && analysis.dateTo < today ? 'schedule' : 'upcoming';
  const required = [...(window ? [analysis.focus.find((item) => WINDOW_FOCUS.has(item)) || implicit] : []),
    ...(analysis.scope === 'projects' && !focus.includes('projects') ? ['projects'] : [])];
  focus = [...new Set([...focus, ...required])];
  if (focus.length > limit) throw invalidArguments(budgetDetails(analysis));
  return focus;
}

/**
 * Kişi ile kullanıcının kendisinin karşılaştırması (`withSelf`): iki özne için aynı ölçüler. Kendi özne güvenilir
 * oturumdur (`assignee: me`); model kimlik yazmaz. Ortak proje daraltması iki okumaya da uygulanır.
 */
function selfComparison(focus, analysis, base, today, chart) {
  const projects = base.entities.filter((entity) => entity.type === 'project');
  const self = { entities: projects, filters: { ...base.filters, assignee: 'me' } };
  const metrics = { overview: ['tasks.total', 'tasks.open', 'tasks.overdue', 'tasks.dueNext7Days', 'tasks.done'],
    workload: ['tasks.open', 'tasks.overdue', 'tasks.dueNext7Days'], overdue: ['tasks.overdue'],
    upcoming: analysis.dateFrom || analysis.dateTo ? null : ['tasks.dueNext7Days'], status: chart === 'donut' ? null : ['tasks.todo', 'tasks.inProgress', 'tasks.done'] }[focus];
  // İki özne de aynı yönün aynı nüfus sözleşmesiyle okunur; kimlik yalnızca sunucunun çözümünden gelir.
  return [base, self].flatMap((side) => {
    const read = focus === 'overdue' ? overdueBase(side, analysis, today) : side;
    return metrics && !(focus === 'overdue' && chart === 'timeline')
      ? request({ operation: 'value', metrics, population: { tool: 'rota_task_analytics' }, ...(read.entities.length ? { entities: read.entities } : {}), filters: read.filters })
      : focusRequest(focus, { ...analysis, scope: 'self', withSelf: false }, side, today) || [];
  });
}

/** Aynı öznenin aynı nüfus üzerindeki skaler ölçüleri tek okumada birleşir; hiçbir ölçü ya da koşul düşmez. */
function mergeSelfValues(parts) {
  const merged = [];
  for (const part of parts) {
    const { metrics, ...shape } = part;
    const peer = part.operation === 'value' && merged.find((item) => {
      const { metrics: _metrics, ...other } = item;
      return JSON.stringify(shape) === JSON.stringify(other) && new Set([...item.metrics, ...metrics]).size <= 8;
    });
    if (peer) peer.metrics = [...new Set([...peer.metrics, ...metrics])];
    else merged.push({ ...part, metrics: [...metrics] });
  }
  return merged;
}

/**
 * Bütçe reddinin ayrıntıları: birden çok yön bildirildiyse modelin KENDİ yönlerinin sıralı alt kümesine daraltma onarımı geçerlidir
 * (`narrowable`). Karşılaştırmada da yön daraltılır, özne değil: her özne aynı yönlerle okunur (yarım karşılaştırma okunmaz).
 * Tek yönlü plan daraltılamaz; kullanıcıya sorulur.
 */
function budgetDetails(analysis) {
  return analysis.focus.length < 2 ? ['$.analysis.focus:requestBudget'] : ['$.analysis.focus:requestBudget', '$.analysis.focus:narrowable'];
}

function expandWith(analysis, base, today = null, detail = null, chart = null, charts = null) {
  const window = { ...(analysis.dateFrom ? { dateFrom: analysis.dateFrom } : {}), ...(analysis.dateTo ? { dateTo: analysis.dateTo } : {}) };
  base = { ...base, filters: { ...base.filters, ...window } };
  const produce = (focus) => analysis.withSelf && analysis.scope === 'person' ? selfComparison(focus, analysis, base, today, chart) : focusRequest(focus, analysis, base, today);
  const parts = [];
  const seen = new Set();
  const declared = effectiveFocus(analysis, today);
  for (const focus of declared) {
    const produced = produce(focus);
    if (!produced) throw invalidArguments(['$.analysis.focus:unsupported']);
    // Karşılaştırmanın kayıt başına bölümleri bütün olarak eklenir (yarım karşılaştırma okunmaz); bölüm bütçesi aşılmaz.
    const items = (Array.isArray(produced) ? produced : [produced]).filter(Boolean).filter((item) => !seen.has(JSON.stringify(item)));
    if (!items.length) continue;
    // Aşama F: bildirilen yönlerin ve sunucunun zorunlu eklediği okumaların (portföy satırları, ufuk yönü) toplamı mevcut
    // fiziksel üst sınırdır (`maxParts`). Sığmayan plan kısmen okunmaz; model kendi yönlerini daraltabilir (`narrowable`).
    const next = analysis.withSelf ? mergeSelfValues([...parts, ...items]) : [...parts, ...items];
    if (next.length > ANALYSIS_LIMITS.maxParts) throw invalidArguments(budgetDetails(analysis));
    for (const item of items) seen.add(JSON.stringify(item));
    parts.splice(0, parts.length, ...next);
  }
  // Adı verilen grafik türünün okuması (sunucunun zorunlu eklediği okuma: en çok `maxParts`'a kadar; sığmazsa grafik
  // notu türün neden çizilemediğini söyler). Aşama F: iki tür istendiyse her türün okuması sırayla ve aynı bütçeyle eklenir.
  for (const type of [chart, ...(charts || []).filter((item) => item !== chart)].filter(Boolean)) addChartReads(type);
  // Ayrıntılı yanıt: bildirilen yönlerin yanına sunucu bir bütünleyici okuma ekler (ör. kendi işlerinde projelere göre
  // dağılım, ekipte kişilere göre iş yükü). Sığmayan ya da anlamı olmayan ek okuma sessizce eklenmez; bildirilen yön düşmez.
  const extra = complementFocus(analysis, declared, detail);
  if (extra) {
    let produced = null;
    try { produced = produce(extra); } catch { produced = null; }
    const items = (Array.isArray(produced) ? produced : [produced]).filter(Boolean).filter((item) => !seen.has(JSON.stringify(item)));
    if (items.length && parts.length + items.length <= ANALYSIS_LIMITS.maxDetailedParts) parts.push(...items);
  }
  return parts;

  /** Adı verilen grafik türünün gerektirdiği okuma; yer yoksa eklenmez (grafik notu türün neden çizilemediğini söyler). */
  function addChartReads(chart) {
    // Portföy kapsamında "projelere göre" okuması portföy sıralamasıdır (bölüntü değil): yığılmış çubuk için proje başına
    // açık/tamamlanan bölüntüsü ayrıca okunur.
    const splitMissing = chart === 'stacked' && !parts.some((part) => part.population?.groupBy === 'project' && part.metrics?.includes('tasks.done'))
      && analysis.scope !== 'project';
    if (splitMissing) {
      const people = base.entities.filter((entity) => entity.type === 'person');
      const common = base.entities.filter((entity) => entity.type !== 'person');
      const bases = people.length > 1 ? people.map((person) => ({ ...base, entities: [person, ...common] }))
        : analysis.withSelf ? [base, { filters: { ...base.filters, assignee: 'me' }, entities: common }] : [base];
      const splits = bases.map((side) => groups(side, 'project', { split: true })).filter((split) => !seen.has(JSON.stringify(split)));
      if (parts.length + splits.length <= ANALYSIS_LIMITS.maxParts) {
        for (const split of splits) { seen.add(JSON.stringify(split)); parts.push(split); }
      }
    }
    const needed = chart === 'stacked' ? null : chart === 'donut' && analysis.scope === 'project' && base.entities.length > 1 ? 'status' : chartFocus(analysis, declared, chart);
    if (needed) {
      let produced = null;
      try { produced = needed === 'status' && chart === 'donut' && analysis.scope === 'project'
        ? base.entities.map((entity) => groups({ ...base, entities: [entity] }, 'status', { open: false })) : produce(needed); } catch { produced = null; }
      const items = (Array.isArray(produced) ? produced : [produced]).filter(Boolean).filter((item) => !seen.has(JSON.stringify(item)));
      if (items.length && parts.length + items.length <= ANALYSIS_LIMITS.maxParts) {
        for (const item of items) seen.add(JSON.stringify(item));
        parts.push(...items);
      }
    }
  }
}

/** Açılan isteklerin sorun yolları modelin yazdığı özet alanlarına çevrilir (hangi alanı düzelteceğini görür). */
export function analysisDetails(details = []) {
  return [...new Set(details.map((detail) => {
    const text = String(detail);
    if (/entities\[\d+\](?:\.text)?:untrusted$/.test(text) || /entities(?:\[\d+\])?:dropped$/.test(text)) return '$.analysis.names:untrusted';
    if (/filters\.(?:dateFrom|dateTo|period)/.test(text)) return '$.analysis.dateFrom:invalid';
    if (/filters\.(?:assignee|teamLevel)/.test(text)) return '$.analysis.scope:unsupported';
    // Özetin kendi alanları ve plan düzeyi sorunlar (dil, niyet, görsel bayrağı, bilinmeyen alan, özet + istek) adıyla kalır.
    if (/^\$\.analysis[.:]/.test(text) || /^\$\.(?:language|intent|visual|chart|table|plan|calls|clarify|abstain)(?:[.:[]|$)/.test(text)) return text;
    return '$.analysis:invalid';
  }))];
}

/**
 * Reddedilen ayrıntılı isteğin (request) EŞDEĞER analitik özeti — düzeltme ipucu olarak. Yalnızca isteğin türlü
 * alanlarından türetilir (nüfus aracı, gruplama, termin koşulu, sorumlu koşulu, varlık türleri); kullanıcının cümlesi
 * okunmaz. Not sistem yetkisiyle gittiği için serbest metin (varlık adı) ASLA yankılanmaz: adlı kapsamda adların
 * modelin kendi entities[].text değerleri olduğu yalnızca yapısal olarak söylenir. Eşleme yoksa `null`. Model öneriyi
 * benimsemek zorunda değildir; karar yine onundur.
 */
export function analysisSuggestion(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  if (request.previousResult || (request.filters != null && (typeof request.filters !== 'object' || Array.isArray(request.filters)))) return null;
  if (request.entities != null && (!Array.isArray(request.entities) || request.entities.some((entity) => !entity || typeof entity !== 'object' || Array.isArray(entity)))) return null;
  const tool = request.population?.tool;
  const filters = { ...(request.filters && typeof request.filters === 'object' ? request.filters : {}), ...(tool === 'rota_workload_summary' ? { status: [...OPEN] } : {}) };
  const entities = Array.isArray(request.entities) ? request.entities.filter((entity) => entity && typeof entity === 'object') : [];
  const groupBy = request.population?.groupBy;
  // İş yükünün örtük açık görev nüfusu, eşdeğer analiz isteğinde açıkça belirtilmelidir.
  if (tool === 'rota_task_analytics' && groupBy === 'assignee'
    && !(Array.isArray(filters.status) && filters.status.length === OPEN.length && OPEN.every((status) => filters.status.includes(status)))) return null;
  const focus = tool === 'rota_workload_summary' ? 'workload' : tool === 'rota_portfolio_summary' ? 'projects'
    : tool === 'rota_task_analytics' ? ({ status: 'status', priority: 'priority', deadline: 'deadlines', target_month: 'schedule', project: 'projects', assignee: 'workload' }[groupBy] || 'overview')
      : tool === 'rota_task_search' ? (filters.deadline === 'overdue' ? 'overdue' : (filters.dateFrom || filters.dateTo || String(filters.deadline || '').startsWith('due_')) ? 'upcoming'
        // critical yönü yalnızca kritik/yüksek öncelikli açık işlerdir: başka öncelik istendiyse eşdeğer özet yoktur.
        : Array.isArray(filters.priority) && filters.priority.length && filters.priority.every((item) => ['critical', 'high'].includes(item)) ? 'critical' : null) : null;
  if (!focus) return null;
  const named = (type) => entities.some((entity) => entity.type === type);
  const scope = filters.assignee === 'me' ? 'self' : filters.assignee === 'team' ? 'team' : named('person') ? 'person' : named('project') ? 'project'
    : tool === 'rota_portfolio_summary' ? 'projects' : 'all';
  const level = scope === 'team' && ANALYSIS_LEVELS.includes(filters.teamLevel) ? filters.teamLevel : null;
  const brief = { scope, ...(level ? { level } : {}), focus: [focus] };
  // Özetin ifade edemediği hiçbir nüfus koşulu onarımda düşmez. Eşdeğer olmayan öneri yerine önerisizlik.
  if (filters.teamLevel != null && !level) return null;
  if (entities.some((entity) => entity.type !== scope || typeof entity.text !== 'string') || entities.length > ANALYSIS_LIMITS.maxNames) return null;
  if (['person', 'project'].includes(scope) && !entities.length) return null;
  if (WINDOW_FOCUS.has(focus)) {
    for (const key of ['dateFrom', 'dateTo']) if (filters[key] != null) brief[key] = filters[key];
  }
  if (focus === 'upcoming' && brief.dateTo && !brief.dateFrom) return null;
  const candidate = { ...brief, ...(entities.length ? { names: entities.map((entity) => entity.text) } : {}) };
  try { parseAnalysis(candidate); } catch { return null; }
  const generated = focusRequest(focus, candidate,
    { filters: { ...(scope === 'self' ? { assignee: 'me' } : scope === 'team' ? { assignee: 'team', ...(level ? { teamLevel: level } : {}) } : {}) }, entities }, null);
  const equivalent = (left, right) => JSON.stringify(Array.isArray(left) ? [...left].sort() : left) === JSON.stringify(Array.isArray(right) ? [...right].sort() : right);
  const generatedRequests = (Array.isArray(generated) ? generated : [generated]).filter(Boolean)
    .map((item) => item.population?.tool === 'rota_workload_summary' ? { ...item, filters: { ...item.filters, status: [...OPEN] } } : item);
  if (!generatedRequests.length || generatedRequests.some((item) => Object.entries(filters).some(([key, value]) => value != null
    && !equivalent(value, item.filters?.[key])))) return null;
  // Termin ön ayarları yalnızca açık görevleri seçer; diğer seçiciler açık durum nüfusu anlamına gelmez.
  if (generatedRequests.some((item) => Object.entries(item.filters || {}).some(([key, value]) => value != null
    && !(key === 'status' && filters.deadline != null && equivalent(value, OPEN)) && !equivalent(filters[key], value)))) return null;
  const names = scope === 'person' || scope === 'project' ? ` (ayrıca analysis.names: reddedilen isteğin ${scope} entities[].text değerleri, en çok ${ANALYSIS_LIMITS.maxNames})` : '';
  return `Bu soru analitik özetle de bildirilebilir (sunucu okumaları kendisi kurar): {"intent":"rota","language":"tr","analysis":${JSON.stringify(brief)}}${names}`;
}
