import { escapedFactText } from './evidenceFacts.js';
import { turkishPossessiveSuffix } from './evidenceNarrative.js';

/**
 * Kanıta dayalı yanıtın SUNUCUYA AİT önermeleri (Aşama 4D anlatımı).
 *
 * Önerme, doğrulanmış olgulardan belirlenimci olarak türetilen tek bir olgusal iddiadır: sayım, en
 * büyük/en küçük değer, dağılımda çoğunluk ya da en büyük grup, toplam ve döküm. Değeri, ilişkisi
 * (ör. "en uzun", "büyük bölümü"), kapsamı ve dili sunucu kurar; model yalnızca önerme KİMLİĞİNİ seçer.
 * İlişki ancak önkoşulu belirlenimci olarak sağlandığında üretilir: en büyük/en küçük değer yalnızca
 * nüfusun bütün satırları kanıttaysa ve satır adı tekilse adla, çoğunluk yalnızca birbirini dışlayan
 * tam bir dağılımda pay %50'yi aştığında, en büyük grup yalnızca tekil en büyük değerde. Önkoşulu
 * sağlanmayan ilişki için önerme yoktur; model onu iddia edemez çünkü yazabileceği bir kimlik yoktur.
 *
 * Her önerme iki biçimde kurulur: `markdown` (yanıtta çizilen, değerleri kaçışlı ve vurgulu) ve
 * `plain` (modelin sayfasında gördüğü düz metin). Doğal dil ANLAMA yoktur: sunucu metni ÜRETİR,
 * model metnini hiçbir zaman okumaz ya da yorumlamaz.
 */

export const PROPOSITION_KINDS = Object.freeze(['count', 'total', 'majority', 'largest', 'breakdown', 'completion', 'maximum', 'minimum', 'average', 'threshold',
  'concentration', 'span']);

/**
 * Önermenin vurgu tonu SUNUCUNUNDUR (modelin seçimi değil): `warning` dikkat isteyen doğrulanmış durum (ör. gecikme),
 * `success` olumlu doğrulanmış durum (ör. bir haftayı aşan gecikme yok, tamamlananlar çoğunlukta), `info` nötr.
 * Ton yalnızca not kutusunun rengini seçer; olgu değildir.
 */
export const PROPOSITION_TONES = Object.freeze(['info', 'warning', 'success']);

const TASK_TOOLS = new Set(['rota_task_search', 'rota_task_analytics']);
/** Dağılım önermesi yalnızca her görevi tek gruba koyan boyutlarda: kişi grupları birbirini dışlamaz. */
export const EXCLUSIVE_GROUP_BY = Object.freeze(['status', 'priority', 'project', 'deadline', 'target_month']);
const MAX_BREAKDOWN_GROUPS = 8;
const MAX_PLAIN_NAME = 120;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const lang = (locale) => (locale === 'en' ? 1 : 0);
const number = (value, locale) => new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'tr-TR').format(value);
const day = (value, locale) => new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'tr-TR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' })
  .format(new Date(`${value}T00:00:00Z`));
const clipName = (text) => (text.length > MAX_PLAIN_NAME ? `${text.slice(0, MAX_PLAIN_NAME - 1)}…` : text);

/** Değer: çizimde vurgulu ve kaçışlı, sayfada düz metin. Sayı ve tarih sunucunun biçimidir. */
const v = (text) => ({ value: String(text), strong: true });
/** Vurgusuz veri metni (ör. grup adı): çizimde yine kaçışlıdır. */
const t = (text) => ({ value: String(text), strong: false });

/**
 * Cümle parçaları (sunucu metni ve veri) → `{ markdown, plain }`. Yalnızca sunucunun kendi metniyle
 * başlayan cümlenin ilk harfi büyütülür; veri (kayıt adı) hiçbir zaman değiştirilmez.
 */
function sentence(parts) {
  const [head, ...rest] = parts;
  const lead = typeof head === 'string' ? [`${head.charAt(0).toLocaleUpperCase('tr-TR')}${head.slice(1)}`, ...rest] : parts;
  const markdown = lead.map((part) => (typeof part === 'string' ? part : part.strong ? `**${escapedFactText(part.value)}**` : escapedFactText(part.value))).join('');
  const plain = lead.map((part) => (typeof part === 'string' ? part : clipName(part.value))).join('');
  return { markdown, plain };
}

const neutral = (value) => value == null || value === '' || value === 'any' || value === false || (Array.isArray(value) && !value.length);

const STATUS = Object.freeze({ todo: ['yapılacak', 'to-do'], in_progress: ['devam eden', 'in-progress'], done: ['tamamlanmış', 'completed'] });
const PRIORITY = Object.freeze({ low: ['düşük öncelikli', 'low-priority'], medium: ['orta öncelikli', 'medium-priority'], high: ['yüksek öncelikli', 'high-priority'],
  critical: ['kritik öncelikli', 'critical-priority'] });
/** Termin süzgeci: Türkçe sıfat; İngilizcede ad öncesi (`before`) ya da sonrası (`after`). */
const DEADLINE = Object.freeze({
  overdue: { tr: 'gecikmiş', before: 'overdue', relative: true },
  due_today: { tr: 'bugün terminli', after: 'due today', relative: true },
  due_next_7_days: { tr: 'bugün dahil yedi gün içinde terminli', after: 'due within seven days including today', relative: true },
  due_next_30_days: { tr: 'bugün dahil otuz gün içinde terminli', after: 'due within thirty days including today', relative: true },
  no_target_finish: { tr: 'terminsiz', after: 'without a deadline', relative: false }
});
const FILTER_KEYS = new Set(['text', 'projectId', 'project', 'wbsId', 'statuses', 'priorities', 'deadline', 'dateField', 'dateFrom', 'dateTo', 'assignee',
  'personSicil', 'createdByMe', 'milestone']);

/**
 * Görev nüfusunun doğal betimi; süzgeçlerin TAMAMI ifade edilemiyorsa `null` (genel cümleye dönülür).
 * Bilinmeyen ya da desteklenmeyen her süzgeç anlamı daraltmak yerine doğal betimi kapatır.
 */
function taskPopulation(filters, locale) {
  const f = filters || {};
  // Bilinmeyen süzgecin `false` değeri de bir kısıt olabilir: yalnızca boş değer nötrdür.
  for (const [key, value] of Object.entries(f)) if (!FILTER_KEYS.has(key) && !(value == null || value === '' || (Array.isArray(value) && !value.length))) return null;
  for (const key of ['text', 'wbsId', 'personSicil', 'createdByMe']) if (!neutral(f[key])) return null;
  // Kilometre taşı süzgecinin iki değeri de nüfusu daraltır (`false` kilometre taşlarını dışlar; taskFacts.matchesTaskFilters).
  if (typeof f.milestone === 'boolean') return null;
  if (!neutral(f.projectId) && (typeof f.project !== 'string' || !f.project.trim())) return null;
  if (!neutral(f.assignee) && !['me', 'unassigned'].includes(f.assignee)) return null;
  if (!neutral(f.dateField) && f.dateField !== 'targetFinish') return null;
  if ([f.dateFrom, f.dateTo].some((value) => !neutral(value) && !DAY.test(String(value)))) return null;
  const statuses = neutral(f.statuses) ? [] : f.statuses;
  const priorities = neutral(f.priorities) ? [] : f.priorities;
  if (!Array.isArray(statuses) || !statuses.every((key) => STATUS[key]) || !Array.isArray(priorities) || !priorities.every((key) => PRIORITY[key])) return null;
  const deadline = neutral(f.deadline) ? null : DEADLINE[f.deadline];
  if (!neutral(f.deadline) && !deadline) return null;
  const or = locale === 'en' ? ' or ' : ' ya da ';
  const adjectives = [
    ...(deadline?.tr && locale !== 'en' ? [deadline.tr] : deadline?.before ? [deadline.before] : []),
    ...(priorities.length ? [priorities.map((key) => PRIORITY[key][lang(locale)]).join(or)] : []),
    ...(statuses.length ? [statuses.map((key) => STATUS[key][lang(locale)]).join(or)] : []),
    ...(f.assignee === 'unassigned' ? [locale === 'en' ? 'unassigned' : 'sorumlusuz'] : [])
  ];
  return {
    me: f.assignee === 'me',
    adjectives,
    after: locale === 'en' && deadline?.after ? deadline.after : null,
    project: neutral(f.projectId) ? null : f.project.trim(),
    from: neutral(f.dateFrom) ? null : f.dateFrom,
    to: neutral(f.dateTo) ? null : f.dateTo,
    relative: Boolean(deadline?.relative)
  };
}

/** Termin aralığı: Türkçe ad öncesi tümleç, İngilizce ad sonrası. */
function windowParts(population, locale) {
  const { from, to } = population;
  if (!from && !to) return [];
  if (locale === 'en') {
    if (from && to) return [' due between ', v(day(from, locale)), ' and ', v(day(to, locale))];
    return from ? [' due on or after ', v(day(from, locale))] : [' due on or before ', v(day(to, locale))];
  }
  if (from && to) return [v(day(from, locale)), ' ile ', v(day(to, locale)), ' arasında terminli '];
  return from ? [v(day(from, locale)), ' ve sonrasında terminli '] : [v(day(to, locale)), ' ve öncesinde terminli '];
}

/**
 * Görev sayımının doğal cümlesi: "Şu anda **4** gecikmiş göreviniz var." Yalnızca bütün süzgeçler
 * ifade edilebiliyorsa; aksi hâlde `null`.
 */
function taskCountSentence(filters, count, locale, { total = false } = {}) {
  const population = taskPopulation(filters, locale);
  if (!population) return null;
  const { me, adjectives, project, relative } = population;
  if (locale === 'en') {
    const noun = count === 1 ? 'task' : 'tasks';
    const tail = [...(population.after ? [` ${population.after}`] : []), ...(project ? [' in the ', v(project), ' project'] : []), ...windowParts(population, locale),
      ...(total ? [' in total'] : [])];
    const described = `${adjectives.length ? `${adjectives.join(', ')} ` : ''}${noun}`;
    const now = relative ? 'currently ' : '';
    if (count === 0) return sentence([me ? `You ${now}have no ${described}` : `There are ${now}no ${described}`, ...tail, '.']);
    return sentence([me ? `You ${now}have ` : `There ${count === 1 ? 'is' : 'are'} ${now}`, v(number(count, locale)), ` ${described}`, ...tail, '.']);
  }
  const lead = [...(relative && !total ? ['şu anda '] : []), ...(project ? [v(project), ' projesinde '] : []), ...windowParts(population, locale), ...(total ? ['toplam '] : [])];
  const noun = `${adjectives.length ? `${adjectives.join(', ')} ` : ''}${me ? 'göreviniz' : 'görev'}`;
  if (count === 0) return sentence([...lead, `${noun} yok.`]);
  return sentence([...lead, v(number(count, locale)), ` ${noun} var.`]);
}

/** Dağılımın sahibi (tamlayan): "Görevlerinizin", "**X** projesindeki görevlerin"; ifade edilemiyorsa `null`. */
function ownerParts(filters, locale) {
  const population = taskPopulation(filters, locale);
  if (!population || population.from || population.to) return null;
  const { me, adjectives, project } = population;
  if (locale === 'en') {
    const described = `${adjectives.length ? `${adjectives.join(', ')} ` : ''}tasks${population.after ? ` ${population.after}` : ''}`;
    return [me ? `your ${described}` : `the visible ${described}`, ...(project ? [' in the ', v(project), ' project'] : [])];
  }
  const described = `${adjectives.length ? `${adjectives.join(', ')} ` : ''}${me ? 'görevlerinizin' : 'görevlerin'}`;
  return [...(project ? [v(project), ' projesindeki '] : me ? [] : ['görebildiğiniz ']), described];
}

const GROUP_NOUNS = Object.freeze({ status: ['Durumlara göre', 'By status'], priority: ['Önceliğe göre', 'By priority'], project: ['Projelere göre', 'By project'],
  deadline: ['Termine göre', 'By deadline'], target_month: ['Termin ayına göre', 'By deadline month'] });

/** Grubun konumu: "**Tamamlandı** durumunda", "have **Orta** priority". */
function groupPlace(groupBy, label, locale) {
  if (locale === 'en') {
    return { status: ['are in the ', v(label), ' status'], priority: ['have ', v(label), ' priority'], project: ['are in the ', v(label), ' project'],
      target_month: ['are due in ', v(label)] }[groupBy] || ['are in the ', v(label), ' group'];
  }
  return { status: [v(label), ' durumunda'], priority: [v(label), ' öncelikte'], project: [v(label), ' projesinde'], target_month: [v(label), ' termin ayında'] }[groupBy]
    || [v(label), ' grubunda'];
}

/** Payın tam sayı yüzdesi; sıfır ya da tamamı olmayan pay yuvarlamayla 0 ya da 100 görünmez. */
export function sharePercent(value, total) {
  const raw = Math.round((value / total) * 100);
  return value > 0 && value < total ? Math.min(99, Math.max(1, raw)) : raw;
}

const percent = (value, locale) => (locale === 'en' ? `${value}%` : `%${value}`);

/**
 * Kesin çoğunluğun (pay > %50) yüzdesi: tam sayı yuvarlaması %50 gösterecekse en az ondalıkla aşağı kesilir
 * (ör. 1001/2000 → %50,05). Gösterilen değer kesin paydan hiçbir zaman büyük değildir ve her zaman %50'yi aşar.
 */
export function majorityPercent(value, total, locale) {
  const whole = sharePercent(value, total);
  if (whole > 50) return number(whole, locale);
  for (let digits = 1; digits <= 6; digits += 1) {
    const scale = 10 ** digits;
    const shown = Math.floor((value * 100 * scale) / total) / scale;
    if (shown > 50) return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'tr-TR', { maximumFractionDigits: digits }).format(shown);
  }
  return null;
}

/**
 * Sayım önermesi: çok satırlı tablosunun yanında tek başına duran zarf sayısı (`totalCount`). Görev
 * araçlarında doğal cümle; diğerlerinde ya da ifade edilemeyen süzgeçte sunucunun belirlenimci cümlesi
 * (`fallback`). Bilinmeyen (null) sayı önerme olmaz.
 */
export function countProposition(group, fact, locale, fallback) {
  if (!fact || !Number.isSafeInteger(fact.value) || fact.value < 0) return null;
  const natural = TASK_TOOLS.has(group.tool) ? taskCountSentence(fact.semantic?.filters, fact.value, locale) : null;
  const realized = natural || (fallback ? { markdown: fallback.markdown, plain: fallback.plain } : null);
  return realized ? { kind: 'count', tone: countTone(fact.semantic?.filters, fact.value), evidenceId: group.evidenceId, ...realized } : null;
}

const countTone = (filters, value) => (filters?.deadline === 'overdue' && value > 0 ? 'warning' : 'info');

const GROUP_TITLES = Object.freeze({ status: ['durum', 'status'], priority: ['öncelik', 'priority'], project: ['proje', 'project'], deadline: ['termin', 'deadline'],
  target_month: ['termin ayı', 'deadline month'] });

/**
 * Bölümün başlık adayı (ör. "Gecikmiş görevleriniz", "Görevlerinizin durum dağılımı"): yalnızca görev nüfusunun
 * süzgeçleri doğal olarak ifade edilebiliyorsa. Başlık olgu taşımaz (sayı ya da ilişki yoktur); yalnızca nüfusu adlandırır.
 */
export function titleCandidate({ tool, filters, groupBy = null, locale }) {
  if (!TASK_TOOLS.has(tool) || (groupBy && !EXCLUSIVE_GROUP_BY.includes(groupBy))) return null;
  const population = taskPopulation(filters, locale);
  if (!population) return null;
  const { me, adjectives, project } = population;
  const adjective = adjectives.length ? `${adjectives.join(', ')} ` : '';
  let text;
  if (locale === 'en') {
    const tasks = `${me ? 'your ' : ''}${adjective}tasks${population.after ? ` ${population.after}` : ''}${project ? ` in the ${project} project` : ''}`;
    const dimension = groupBy ? GROUP_TITLES[groupBy][1] : null;
    text = dimension ? `${dimension} distribution of ${tasks}` : tasks;
  } else {
    const place = project ? `${project} projesindeki ` : '';
    text = groupBy ? `${place}${adjective}${me ? 'görevlerinizin' : 'görevlerin'} ${GROUP_TITLES[groupBy][0]} dağılımı` : `${place}${adjective}${me ? 'görevleriniz' : 'görevler'}`;
  }
  // Termin aralığı nüfusun parçasıdır: tek uçlu ve gruplanmış aralık da başlıkta yazılır (başlık nüfusu genişletemez).
  const { from, to } = population;
  const window = from && to ? ` (${day(from, locale)} – ${day(to, locale)})`
    : from ? (locale === 'en' ? ` (due on or after ${day(from, locale)})` : ` (${day(from, locale)} ve sonrasında terminli)`)
      : to ? (locale === 'en' ? ` (due on or before ${day(to, locale)})` : ` (${day(to, locale)} ve öncesinde terminli)`) : '';
  // Kayıt adıyla başlayan başlıkta veri değiştirilmez; yalnızca sunucu metniyle başlayan başlığın ilk harfi büyür.
  const lead = locale !== 'en' && project ? text : `${text.charAt(0).toLocaleUpperCase(locale === 'en' ? 'en-US' : 'tr-TR')}${text.slice(1)}`;
  return `${lead}${window}`;
}

/**
 * Tablonun bütün nüfusu kanıtta mı? Bütün satır olguları tam kanıttan gelir, koleksiyonun bütün
 * satırları gösterilir ve (görev listesinde) nüfus sayısı satır sayısına eşittir. Tek satırlı tam nüfus da
 * nüfustur (tek görev, tek grup); birden çok gözlem isteyen önermeler kendi en az satır koşullarını taşır.
 */
export function wholePopulation({ group, described, distribution, population = null }) {
  const rows = described.rows;
  if (rows.length < 1 || !rows.every((row) => row.entries.length && row.entries.every(({ fact }) => fact.semantic?.complete === true
    && fact.semantic?.row?.collectionSize === rows.length))) return false;
  if (distribution) return true;
  const total = group.envelope.find((fact) => fact.field === 'totalCount');
  if (total) return total.value === rows.length && total.semantic?.complete === true;
  return population === rows.length;
}

/** Nüfus betimi satırların doğrulanmış süzgecidir; satır başına proje bağlamı nüfusu daraltmaz. */
export function populationScope(described) {
  const filters = described.rows[0]?.entries[0]?.fact.semantic?.filters || {};
  const { project: _rowProject, ...rest } = filters;
  return rest.projectId ? filters : rest;
}

/**
 * Sayım ölçüsü seçilmemiş görev listesinin sayımı: sunucu, atfedilen kanıtın nüfusun tamamı olduğunu (tam,
 * kesilmemiş, imleçsiz, döndürülen = kesin toplam) doğruladıysa ve tablo o nüfusun bütün satırlarını taşıyorsa.
 * Tek görevlik tam nüfus da sayımdır.
 * `fallback(scoped)`: doğal betim süzgeçlerin tamamını ifade edemezse sunucunun ölçütlü belirlenimci cümlesi
 * (ör. kilometre taşı süzgeci); sayım hiçbir zaman süzgeçleri düşürülmüş daha geniş bir nüfusa yazılmaz.
 */
export function populationProposition({ group, described, size, locale, fallback = null }) {
  if (group.tool !== 'rota_task_search' || !Number.isSafeInteger(size) || size < 1 || described.rows.length !== size) return null;
  const facts = described.rows.flatMap((row) => row.entries.map(({ fact }) => fact));
  if (!facts.every((fact) => fact.semantic?.complete === true)) return null;
  const scoped = populationScope(described);
  const realized = taskCountSentence(scoped, size, locale) || fallback?.(scoped) || null;
  return realized ? { kind: 'count', tone: countTone(scoped, size), evidenceId: group.evidenceId, markdown: realized.markdown, plain: realized.plain } : null;
}

/** Tek değerli sayısal ya da tarih sütunu; değerler satır sırasıyla. */
function columnValues(described, index, type) {
  const values = described.rows.map((row) => row.cells[index]);
  if (!values.every((facts) => facts.length === 1)) return null;
  const facts = values.map(([fact]) => fact);
  if (type === 'number') return facts.every((fact) => Number.isFinite(fact.value)) ? facts : null;
  return facts.every((fact) => fact.semantic?.valueType === 'date' && typeof fact.value === 'string' && DAY.test(fact.value)) ? facts : null;
}

/** Değerin tekil sahibi; adı tabloda tekil değilse yalnızca değer söylenir. */
function soleRow(described, facts, target) {
  const indexes = facts.map((fact, index) => (fact.value === target ? index : -1)).filter((index) => index >= 0);
  if (indexes.length !== 1) return null;
  const title = described.rows[indexes[0]].title;
  return title && described.rows.filter((row) => row.title === title).length === 1 ? title : null;
}

function extremeSentence({ kind, metric, type, label, value, owner, locale }) {
  const en = locale === 'en';
  const named = owner ? [' (', v(owner), ')'] : [];
  if (metric === 'task.overdueDays') {
    const amount = en ? `${number(value, locale)} ${value === 1 ? 'day' : 'days'}` : `${number(value, locale)} gün`;
    if (owner) {
      return sentence(en ? [`The ${kind === 'maximum' ? 'longest' : 'shortest'}-overdue task is `, v(owner), ' (', v(amount), ').']
        : [`En ${kind === 'maximum' ? 'uzun' : 'kısa'} süredir geciken görev `, v(owner), ' (', v(amount), ').']);
    }
    return sentence(en ? [`The ${kind === 'maximum' ? 'longest' : 'shortest'} delay is `, v(amount), '.'] : [`En ${kind === 'maximum' ? 'uzun' : 'kısa'} gecikme `, v(amount), '.']);
  }
  if (metric === 'task.targetFinish') {
    return sentence(en ? [`The ${kind === 'minimum' ? 'earliest' : 'latest'} deadline is `, v(day(value, locale)), ...named, '.']
      : [`En ${kind === 'minimum' ? 'erken' : 'geç'} termin `, v(day(value, locale)), ...named, '.']);
  }
  const shown = type === 'date' ? day(value, locale) : number(value, locale);
  if (en) return sentence([`The ${type === 'date' ? (kind === 'minimum' ? 'earliest' : 'latest') : (kind === 'minimum' ? 'lowest' : 'highest')} “`, t(label), '” value is ', v(shown), ...named, '.']);
  return sentence(['“', t(label), `” sütununda en ${type === 'date' ? (kind === 'minimum' ? 'erken tarih' : 'geç tarih') : (kind === 'minimum' ? 'düşük değer' : 'yüksek değer')} `, v(shown), ...named, '.']);
}

/**
 * Bütün nüfusu taşıyan tablonun türetilmiş önermeleri: dağılımda toplam, çoğunluk ya da en büyük grup
 * ve döküm; satır tablosunda sayısal ve tarih sütunlarının en büyük/en küçük değeri.
 */
export function tablePropositions({ group, described, distribution, locale, population = null, collection = null }) {
  if (!wholePopulation({ group, described, distribution, population })) return [];
  const out = [];
  const en = locale === 'en';
  // `column`: önermenin dayandığı tablo sütunu (sunucunun sütun sırası); grafik yönlendirmesi ancak aynı sütunu gösterir.
  let column = null;
  const add = (kind, realized, tone = 'info') => { if (realized) out.push({ kind, tone, evidenceId: group.evidenceId, ...(column == null ? {} : { column }), ...realized }); };
  if (distribution) {
    // Toplam, çoğunluk, en büyük grup, tamamlanma ve döküm yalnızca BÜTÜN görevleri sayan sütundan (tasks.total):
    // açık, gecikmiş ya da tamamlanmış alt kümesi bütün görevlerin paydası değildir. Ölçü kimliği kanıtın türüdür.
    const index = described.columns.findIndex((item, position) => item.numeric && columnValues(described, position, 'number')?.every((fact) => fact.semantic?.metric === 'tasks.total'));
    const facts = index >= 0 ? columnValues(described, index, 'number') : null;
    if (!facts || !facts.every((fact) => Number.isSafeInteger(fact.value) && fact.value >= 0)) return [];
    column = index;
    const groupBy = facts[0].semantic?.groupBy;
    if (!EXCLUSIVE_GROUP_BY.includes(groupBy) || !facts.every((fact) => fact.semantic?.groupBy === groupBy)) return [];
    const total = facts.reduce((sum, fact) => sum + fact.value, 0);
    if (total <= 0) return [];
    const filters = facts[0].semantic?.filters;
    const whose = ownerParts(filters, locale);
    add('total', TASK_TOOLS.has(group.tool) ? taskCountSentence(filters, total, locale, { total: true }) : null);
    const max = Math.max(...facts.map((fact) => fact.value));
    const owner = soleRow(described, facts, max);
    // Tek dolu grup (bütün görevler aynı grupta) çoğunluk değildir: toplam ve döküm onu söyler.
    if (owner && max < total) {
      const share = sharePercent(max, total);
      const place = groupPlace(groupBy, owner, locale);
      const done = groupBy === 'status' && facts[facts.findIndex((fact) => fact.value === max)].semantic?.group?.key === 'done';
      if (max * 2 > total) {
        // Çoğunluk ("büyük bölümü") yalnızca birbirini dışlayan tam dağılımda pay yarıyı aştığında; gösterilen pay da %50'yi aşar.
        const majority = majorityPercent(max, total, locale);
        add('majority', en
          ? sentence([`Most of ${whose ? '' : 'the tasks in this result'}`, ...(whose || []), ' (', v(percent(majority, locale)), ') ', ...place, '.'])
          : sentence([...(whose || ['bu sonuçtaki görevlerin']), ' büyük bölümü (', v(percent(majority, locale)), ') ', ...place, '.']), done ? 'success' : 'info');
      } else {
        add('largest', en
          ? sentence(['The largest group is ', v(owner), ': ', v(number(max, locale)), ` ${max === 1 ? 'task' : 'tasks'} (`, v(percent(share, locale)), ').'])
          : sentence(['En büyük grup ', v(owner), ': ', v(number(max, locale)), ' görev (', v(percent(share, locale)), ').']));
      }
    }
    // Tamamlanma: durum anahtarları sunucunun kanonik kodlarıdır (etiket metni yorumlanmaz).
    const keys = facts.map((fact) => fact.semantic?.group?.key);
    if (groupBy === 'status' && keys.every((key) => ['todo', 'in_progress', 'done'].includes(key))) {
      const done = facts.reduce((sum, fact, position) => sum + (keys[position] === 'done' ? fact.value : 0), 0);
      const open = total - done;
      if (done > 0 && open > 0) {
        const share = sharePercent(done, total);
        add('completion', en
          ? sentence([v(percent(share, locale)), ` of ${whose ? '' : 'the tasks in this result'}`, ...(whose || []), ' are completed; ', v(number(open, locale)), ` ${open === 1 ? 'task is' : 'tasks are'} still open.`])
          : sentence([...(whose || ['bu sonuçtaki görevlerin']), ' ', v(percent(share, locale)), `${turkishPossessiveSuffix(share)} tamamlandı; `, v(number(open, locale)), ' görev hâlâ açık.']),
        done * 2 > total ? 'success' : 'info');
      }
    }
    if (described.rows.length <= MAX_BREAKDOWN_GROUPS) {
      const items = described.rows.flatMap((row, position) => [...(position ? [', '] : []), t(row.title), ' ', v(number(facts[position].value, locale))]);
      add('breakdown', sentence([`${GROUP_NOUNS[groupBy][lang(locale)]}: `, ...items, '.']));
    }
    return out;
  }
  // Satır istatistikleri (uç, ortalama, eşik, yayılma, yoğunlaşma) birden çok gözlem ister.
  if (described.rows.length < 2) return out;
  // Sayısal sütunlar önce gelir; tarih sütunu yalnızca sayısal önerme yoksa (gecikmede en erken termin en uzun gecikmeyi yineler).
  const order = described.columns.map((item, index) => ({ item, index })).sort((left, right) => Number(right.item.numeric) - Number(left.item.numeric));
  for (const { item: header, index } of order) {
    column = index;
    const type = header.numeric ? 'number' : 'date';
    if (type === 'date' && out.length) continue;
    const facts = columnValues(described, index, type);
    if (!facts) continue;
    const values = facts.map((fact) => fact.value);
    const sorted = [...values].sort((left, right) => (type === 'number' ? left - right : left.localeCompare(right)));
    if (sorted[0] === sorted.at(-1)) continue;
    const metric = facts[0].semantic?.metric || null;
    if (!facts.every((fact) => fact.semantic?.metric === metric && fact.semantic?.unit === facts[0].semantic?.unit)) continue;
    const overdue = metric === 'task.overdueDays';
    if (type === 'date') {
      add('minimum', extremeSentence({ kind: 'minimum', metric, type, label: header.label, value: sorted[0], owner: soleRow(described, facts, sorted[0]), locale }));
      add('span', metric === 'task.targetFinish'
        ? sentence(en ? ['Deadlines range from ', v(day(sorted[0], locale)), ' to ', v(day(sorted.at(-1), locale)), '.'] : ['Terminler ', v(day(sorted[0], locale)), ' ile ', v(day(sorted.at(-1), locale)), ' arasında.'])
        : sentence(en ? ['“', t(header.label), '” values range from ', v(day(sorted[0], locale)), ' to ', v(day(sorted.at(-1), locale)), '.']
          : ['“', t(header.label), '” değerleri ', v(day(sorted[0], locale)), ' ile ', v(day(sorted.at(-1), locale)), ' arasında.']));
      continue;
    }
    for (const kind of ['maximum', 'minimum']) {
      const value = kind === 'maximum' ? sorted.at(-1) : sorted[0];
      add(kind, extremeSentence({ kind, metric, type, label: header.label, value, owner: soleRow(described, facts, value), locale }), overdue && kind === 'maximum' ? 'warning' : 'info');
    }
    if (values.length >= 3) {
      const mean = number(Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10, locale);
      add('average', overdue
        ? sentence(en ? ['The average delay is ', v(`${mean} days`), '.'] : ['Gecikmelerin ortalaması ', v(`${mean} gün`), '.'])
        : sentence(en ? ['The average “', t(header.label), '” is ', v(mean), '.'] : ['“', t(header.label), '” ortalaması ', v(mean), '.']));
    }
    if (overdue) {
      // Bir haftayı aşan gecikme: sunucunun sabit eşiği (7 gün), modelin yorumu değil.
      const late = values.filter((value) => value > 7).length;
      if (!late) add('threshold', sentence(en ? ['None of these tasks is more than a week overdue.'] : ['Hiçbir görevin gecikmesi bir haftayı aşmıyor.']), 'success');
      else if (late === values.length) add('threshold', sentence(en ? ['All of these tasks are more than a week overdue.'] : ['Bu görevlerin tamamı bir haftadan uzun süredir gecikmiş.']), 'warning');
      else add('threshold', sentence(en ? [v(number(late, locale)), ` of the `, v(number(values.length, locale)), ' tasks are more than a week overdue.']
        : [v(number(values.length, locale)), ' görevin ', v(number(late, locale)), `${turkishPossessiveSuffix(late)} bir haftadan uzun süredir gecikmiş.`]), 'warning');
    }
  }
  column = null;
  // "Bu görevler" yalnızca görev koleksiyonunun satırlarıdır.
  if (TASK_TOOLS.has(group.tool) && String(collection ?? '').split('.').at(-1) === 'tasks') add('concentration', projectConcentration(described, locale));
  return out;
}

/**
 * Görev satırlarının projelere dağılımı (satırın doğrulanmış proje bağlamından): tek projede toplanma, bir
 * projenin çoğunluğu ya da kaç projeye yayıldığı. Gruplama doğrulanmış proje KİMLİĞİYLEdir (aynı adlı iki proje
 * ayrıdır); ad yalnızca gösterimdir. Kimliği olmayan satırda yoğunlaşma iddiası yoktur.
 */
function projectConcentration(described, locale) {
  const projects = described.rows.map((row) => ({ id: row.entries[0]?.fact.semantic?.row?.projectId || null, name: row.context?.project || null }));
  if (projects.length < 2 || projects.some((project) => !project.id || !project.name)) return null;
  const counts = new Map();
  for (const { id, name } of projects) counts.set(id, { name, count: (counts.get(id)?.count || 0) + 1 });
  const en = locale === 'en';
  const total = projects.length;
  if (counts.size === 1) return sentence(en ? ['All of these tasks are in the ', v(projects[0].name), ' project.'] : ['Bu görevlerin tamamı ', v(projects[0].name), ' projesinde.']);
  const ranked = [...counts.values()].sort((left, right) => right.count - left.count);
  // Ad, kimliği ayırt etmiyorsa (başka bir proje aynı adı taşıyor) bir projeyi adıyla öne çıkarmak yanıltır.
  if (ranked[0].count * 2 > total && ranked.filter((item) => item.name === ranked[0].name).length === 1) {
    return sentence(en ? [v(number(ranked[0].count, locale)), ' of the ', v(number(total, locale)), ' tasks are in the ', v(ranked[0].name), ' project.']
      : [v(number(total, locale)), ' görevin ', v(number(ranked[0].count, locale)), `${turkishPossessiveSuffix(ranked[0].count)} `, v(ranked[0].name), ' projesinde.']);
  }
  return sentence(en ? ['The tasks are spread across ', v(number(counts.size, locale)), ' projects.'] : ['Görevler ', v(number(counts.size, locale)), ' projeye dağılmış.']);
}

/** Not kutusunun sunucu etiketi; tonu önermelerin sunucu tonudur. */
export function noteLabel(tone, locale) {
  return { warning: ['Dikkat', 'Attention'], success: ['Olumlu', 'Positive'] }[tone]?.[lang(locale)] || (locale === 'en' ? 'Highlight' : 'Öne çıkan');
}

/** Sonraki bloğa yönlendiren düzen cümlesi: olgu değil, sunucunun çizdiği bloğun varlığıdır. */
export function pointerSentence({ type, style, distribution = false }, locale) {
  const en = locale === 'en';
  if (type === 'chart') {
    return distribution ? (en ? 'The chart below shows the distribution.' : 'Dağılımı aşağıdaki grafikte görebilirsiniz.')
      : (en ? 'The chart below compares the values.' : 'Değerleri aşağıdaki grafikte karşılaştırabilirsiniz.');
  }
  return style === 'table' ? (en ? 'You can see the details in the table below.' : 'Ayrıntıları aşağıdaki tabloda görebilirsiniz.')
    : (en ? 'The details are listed below.' : 'Ayrıntılar aşağıda listeleniyor.');
}
