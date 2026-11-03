import { canonicalGroupLabel, escapedFactText } from './evidenceFacts.js';
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
  'concentration', 'span', 'coverage', 'leader', 'completeness']);

/**
 * Önermenin vurgu tonu SUNUCUNUNDUR (modelin seçimi değil): `warning` dikkat isteyen doğrulanmış durum (ör. gecikme),
 * `success` olumlu doğrulanmış durum (ör. bir haftayı aşan gecikme yok, tamamlananlar çoğunlukta), `info` nötr.
 * Ton yalnızca not kutusunun rengini seçer; olgu değildir.
 */
export const PROPOSITION_TONES = Object.freeze(['info', 'warning', 'success']);

const TASK_TOOLS = new Set(['rota_task_search', 'rota_task_analytics']);
/** Dağılım önermesi yalnızca her görevi tek gruba koyan boyutlarda: kişi grupları birbirini dışlamaz. */
export const EXCLUSIVE_GROUP_BY = Object.freeze(['status', 'priority', 'project', 'deadline', 'target_month']);
const assignmentGroups = (fact) => fact?.semantic?.provenance?.tool === 'rota_task_analytics' && fact.semantic.groupBy === 'assignee';

/** Görevlerin kişi kırılımı kadroyu kanıtlamaz; sayfa tamlığı kişi nüfusunun tamlığı değildir. */
export function rowPopulationComplete(tool, facts) {
  if (facts.some(assignmentGroups)) return false;
  return tool !== 'rota_workload_summary' || facts.some((fact) => fact?.field === 'data.populationComplete' && fact.value === true);
}
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
  // Parçalar da saklanır: akıcı paragraf (§ fluentParagraph) yan cümle biçimini metni ayrıştırmadan yeniden kurar.
  return { markdown, plain, parts: Object.freeze([...parts]) };
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
  'personSicil', 'createdByMe', 'milestone', 'teamLevel']);
/** Ekip kapsamının adı (Türkçe yer/iyelik biçimleri, İngilizce iyelik). Düzey yoksa bütün yönetim kapsamı "ekibiniz"dir. */
const TEAM = Object.freeze({
  null: { at: 'ekibinizde', of: 'ekibinizin', en: 'your team' },
  unit: { at: 'biriminizde', of: 'biriminizin', en: 'your unit' },
  department: { at: 'bölümünüzde', of: 'bölümünüzün', en: 'your department' },
  directorate: { at: 'direktörlüğünüzde', of: 'direktörlüğünüzün', en: 'your directorate' }
});

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
  if (!neutral(f.assignee) && !['me', 'unassigned', 'team'].includes(f.assignee)) return null;
  if (!neutral(f.teamLevel) && (f.assignee !== 'team' || !TEAM[f.teamLevel])) return null;
  if (!neutral(f.dateField) && f.dateField !== 'targetFinish') return null;
  if ([f.dateFrom, f.dateTo].some((value) => !neutral(value) && !DAY.test(String(value)))) return null;
  const statuses = neutral(f.statuses) ? [] : f.statuses;
  const priorities = neutral(f.priorities) ? [] : f.priorities;
  if (!Array.isArray(statuses) || !statuses.every((key) => STATUS[key]) || !Array.isArray(priorities) || !priorities.every((key) => PRIORITY[key])) return null;
  const deadline = neutral(f.deadline) ? null : DEADLINE[f.deadline];
  if (!neutral(f.deadline) && !deadline) return null;
  const or = locale === 'en' ? ' or ' : ' ya da ';
  // Yapılacak + devam eden tam olarak "açık" işlerdir: iki durum adını yinelemek yerine tek doğal sıfat (nüfus aynıdır).
  const openStatuses = statuses.length === 2 && statuses.includes('todo') && statuses.includes('in_progress');
  const open = (deadline && f.deadline !== 'overdue') || openStatuses;
  const adjectives = [
    ...(deadline?.tr && locale !== 'en' ? [deadline.tr] : deadline?.before ? [deadline.before] : []),
    ...(open ? [locale === 'en' ? 'open' : 'açık'] : []),
    ...(priorities.length ? [priorities.map((key) => PRIORITY[key][lang(locale)]).join(or)] : []),
    ...(statuses.length && !openStatuses ? [statuses.map((key) => STATUS[key][lang(locale)]).join(or)] : []),
    ...(f.assignee === 'unassigned' ? [locale === 'en' ? 'unassigned' : 'sorumlusuz'] : [])
  ];
  return {
    me: f.assignee === 'me',
    team: f.assignee === 'team' ? TEAM[neutral(f.teamLevel) ? 'null' : f.teamLevel] : null,
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
  // Tek günlük aralık ("bugün terminli") iki kez aynı tarihle söylenmez.
  if (from && to && from === to) return locale === 'en' ? [' due on ', v(day(from, locale))] : [v(day(from, locale)), ' tarihinde terminli '];
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
  const { me, team, adjectives, project, relative } = population;
  if (locale === 'en') {
    const noun = count === 1 ? 'task' : 'tasks';
    const tail = [...(population.after ? [` ${population.after}`] : []), ...(project ? [' in the ', v(project), ' project'] : []), ...windowParts(population, locale),
      ...(total ? [' in total'] : [])];
    const described = `${adjectives.length ? `${adjectives.join(', ')} ` : ''}${noun}`;
    const now = relative ? 'currently ' : '';
    const owner = team ? `${team.en.charAt(0).toUpperCase()}${team.en.slice(1)} ${now}has` : `You ${now}have`;
    if (count === 0) return sentence([me || team ? `${owner} no ${described}` : `There are ${now}no ${described}`, ...tail, '.']);
    return sentence([me || team ? `${owner} ` : `There ${count === 1 ? 'is' : 'are'} ${now}`, v(number(count, locale)), ` ${described}`, ...tail, '.']);
  }
  const lead = [...(team ? [`${team.at} `] : []), ...(relative && !total ? ['şu anda '] : []), ...(project ? [v(project), ' projesinde '] : []), ...windowParts(population, locale), ...(total ? ['toplam '] : [])];
  const noun = `${adjectives.length ? `${adjectives.join(', ')} ` : ''}${me ? 'göreviniz' : 'görev'}`;
  if (count === 0) return sentence([...lead, `${noun} yok.`]);
  return sentence([...lead, v(number(count, locale)), ` ${noun} var.`]);
}

/** Dağılımın sahibi (tamlayan): "Görevlerinizin", "**X** projesindeki görevlerin"; ifade edilemiyorsa `null`. */
function ownerParts(filters, locale, { open = false } = {}) {
  const population = taskPopulation(filters, locale);
  if (!population || population.from || population.to) return null;
  const { me, team, adjectives: baseAdjectives, project } = population;
  const adjectives = open && !baseAdjectives.includes(locale === 'en' ? 'open' : 'açık') ? [...baseAdjectives, locale === 'en' ? 'open' : 'açık'] : baseAdjectives;
  if (locale === 'en') {
    const described = `${adjectives.length ? `${adjectives.join(', ')} ` : ''}tasks${population.after ? ` ${population.after}` : ''}`;
    return [me ? `your ${described}` : team ? `${team.en}'s ${described}` : `the visible ${described}`, ...(project ? [' in the ', v(project), ' project'] : [])];
  }
  const described = `${adjectives.length ? `${adjectives.join(', ')} ` : ''}${me ? 'görevlerinizin' : team ? 'görevlerinin' : 'görevlerin'}`;
  return [...(team ? [`${team.of} `] : []), ...(project ? [v(project), ' projesindeki '] : me || team ? [] : ['görebildiğiniz ']), described];
}

const GROUP_NOUNS = Object.freeze({ status: ['Durumlara göre', 'By status'], priority: ['Önceliğe göre', 'By priority'], project: ['Projelere göre', 'By project'],
  deadline: ['Termine göre', 'By deadline'], target_month: ['Termin ayına göre', 'By deadline month'] });

/** Desteklenmeyen birim birimsiz iddiaya dönüşmez. Etiket/alan adı yorumlanmaz. */
function numericValue(value, semantic, locale) {
  const shown = number(value, locale);
  if (semantic.measure === 'percent' && semantic.unit == null) return locale === 'en' ? `${shown}%` : `%${shown}`;
  if (semantic.measure === 'days' && semantic.unit == null) return `${shown} ${locale === 'en' ? (value === 1 ? 'day' : 'days') : 'gün'}`;
  if (semantic.measure === 'hours' && semantic.unit === 'hours') return `${shown} ${locale === 'en' ? (value === 1 ? 'hour' : 'hours') : 'saat'}`;
  return null;
}

/** Grubun konumu: "**Tamamlandı** durumunda", "have **Orta** priority". */
function groupPlace(groupBy, label, locale) {
  if (locale === 'en') {
    return { status: ['are in the ', v(label), ' status'], priority: ['have ', v(label), ' priority'], project: ['are in the ', v(label), ' project'],
      target_month: ['are due in ', v(label)] }[groupBy] || ['are in the ', v(label), ' group'];
  }
  return { status: [v(label), ' durumunda'], priority: [v(label), ' öncelikte'], project: [v(label), ' projesinde'], target_month: [v(label), ' termin ayında'] }[groupBy]
    || [v(label), ' grubunda'];
}

/** Küçük payın kesri korunur; sıfır ya da tamamı olmayan pay yuvarlamayla 0 ya da 100 görünmez. */
export function sharePercent(value, total) {
  const raw = (value / total) * 100;
  return value > 0 && value < total ? (raw < 1 ? raw : Math.min(99, Math.round(raw))) : Math.round(raw);
}

const percent = (value, locale) => {
  const shown = value > 0 && value < 1
    ? new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'tr-TR', { maximumSignificantDigits: 3 }).format(value) : value;
  return locale === 'en' ? `${shown}%` : `%${shown}`;
};

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
  return realized ? { kind: 'count', tone: countTone(fact.semantic?.filters, fact.value), evidenceId: group.evidenceId, ...realized, fluent: Object.freeze({ count: fact.value }) } : null;
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
  const { me, team, adjectives, project } = population;
  const adjective = adjectives.length ? `${adjectives.join(', ')} ` : '';
  let text;
  if (locale === 'en') {
    const tasks = `${me ? 'your ' : team ? `${team.en}'s ` : ''}${adjective}tasks${population.after ? ` ${population.after}` : ''}${project ? ` in the ${project} project` : ''}`;
    const dimension = groupBy ? GROUP_TITLES[groupBy][1] : null;
    text = dimension ? `${dimension} distribution of ${tasks}` : tasks;
  } else {
    const place = `${team ? `${team.of} ` : ''}${project ? `${project} projesindeki ` : ''}`;
    text = groupBy ? `${place}${adjective}${me ? 'görevlerinizin' : team ? 'görevlerinin' : 'görevlerin'} ${GROUP_TITLES[groupBy][0]} dağılımı`
      : `${place}${adjective}${me ? 'görevleriniz' : team ? 'görevleri' : 'görevler'}`;
  }
  // Termin aralığı nüfusun parçasıdır: tek uçlu ve gruplanmış aralık da başlıkta yazılır (başlık nüfusu genişletemez).
  const { from, to } = population;
  const window = from && to && from === to ? ` (${day(from, locale)})` : from && to ? ` (${day(from, locale)} – ${day(to, locale)})`
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
  return realized ? { kind: 'count', tone: countTone(scoped, size), evidenceId: group.evidenceId, markdown: realized.markdown, plain: realized.plain,
    ...(realized.parts ? { parts: realized.parts } : {}), fluent: Object.freeze({ count: size }) } : null;
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

/**
 * Uç değer cümlesi. `fluent.pair.tail`, aynı sütunun karşı ucundan SONRA gelirse kullanılan ikinci yan cümledir
 * ("…, en kısa süredir geciken ise **Y** (**1 gün**)"); `fluent.names`, adı söylenen en uzun gecikmeli görevdir.
 */
function extremeSentence({ kind, metric, type, label, value, owner, locale, semantic }) {
  const en = locale === 'en';
  const named = owner ? [' (', v(owner), ')'] : [];
  const pair = (tail, extra = {}) => ({ pair: { role: kind, tail }, ...extra });
  const high = kind === 'maximum';
  if (metric === 'task.overdueDays') {
    const amount = en ? `${number(value, locale)} ${value === 1 ? 'day' : 'days'}` : `${number(value, locale)} gün`;
    if (owner) {
      return { ...sentence(en ? [`The ${high ? 'longest' : 'shortest'}-overdue task is `, v(owner), ' (', v(amount), ').']
        : [`En ${high ? 'uzun' : 'kısa'} süredir geciken görev `, v(owner), ' (', v(amount), ').']),
      fluent: pair(en ? [`and the ${high ? 'longest' : 'shortest'}-overdue is `, v(owner), ' (', v(amount), ')'] : [`en ${high ? 'uzun' : 'kısa'} süredir geciken ise `, v(owner), ' (', v(amount), ')'],
        high ? { names: owner } : {}) };
    }
    return { ...sentence(en ? [`The ${high ? 'longest' : 'shortest'} delay is `, v(amount), '.'] : [`En ${high ? 'uzun' : 'kısa'} gecikme `, v(amount), '.']),
      fluent: pair(en ? [`and the ${high ? 'longest' : 'shortest'} is `, v(amount)] : [`en ${high ? 'uzun' : 'kısa'} gecikme ise `, v(amount)]) };
  }
  if (metric === 'task.targetFinish') {
    return { ...sentence(en ? [`The ${high ? 'latest' : 'earliest'} deadline is `, v(day(value, locale)), ...named, '.']
      : [`En ${high ? 'geç' : 'erken'} termin `, v(day(value, locale)), ...named, '.']),
    fluent: pair(en ? [`and the ${high ? 'latest' : 'earliest'} is `, v(day(value, locale)), ...named] : [`en ${high ? 'geç' : 'erken'} termin ise `, v(day(value, locale)), ...named]) };
  }
  const shown = type === 'date' ? day(value, locale) : numericValue(value, semantic, locale);
  const word = type === 'date' ? (high ? ['latest', 'en geç'] : ['earliest', 'en erken']) : (high ? ['highest', 'en yüksek'] : ['lowest', 'en düşük']);
  if (en) {
    return { ...sentence([`The ${word[0]} “`, t(label), '” value is ', v(shown), ...named, '.']),
      fluent: pair([`and the ${word[0]} is `, v(shown), ...named]) };
  }
  // Satırı adıyla söylenebilen uçta özne satırdır ("“Gecikmiş görev” değeri en yüksek olan **X** (**2**)").
  if (owner) {
    return { ...sentence(['“', t(label), `” değeri ${word[1]} olan `, v(owner), ' (', v(shown), ').']),
      fluent: pair([`${word[1]} olan ise `, v(owner), ' (', v(shown), ')']) };
  }
  return { ...sentence(['“', t(label), `” sütununda ${word[1]} ${type === 'date' ? 'tarih' : 'değer'} `, v(shown), '.']),
    fluent: pair([`${word[1]} ${type === 'date' ? 'tarih' : 'değer'} ise `, v(shown)]) };
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
  const add = (kind, realized, tone = 'info', fluent = null) => {
    if (realized) out.push({ kind, tone, evidenceId: group.evidenceId, ...(column == null ? {} : { column }), ...realized, ...(fluent ? { fluent: Object.freeze(fluent) } : {}) });
  };
  if (distribution) {
    // Toplam, çoğunluk, en büyük grup, tamamlanma ve döküm yalnızca BÜTÜN görevleri sayan sütundan (tasks.total):
    // açık, gecikmiş ya da tamamlanmış alt kümesi bütün görevlerin paydası değildir. Ölçü kimliği kanıtın türüdür.
    const index = described.columns.findIndex((item, position) => item.numeric && columnValues(described, position, 'number')?.every((fact) => fact.semantic?.metric === 'tasks.total'));
    const facts = index >= 0 ? columnValues(described, index, 'number') : null;
    if (!facts) {
      openPartition(described, group, locale, add);
      return out;
    }
    if (!facts.every((fact) => Number.isSafeInteger(fact.value) && fact.value >= 0)) return [];
    column = index;
    const groupBy = facts[0].semantic?.groupBy;
    if (!EXCLUSIVE_GROUP_BY.includes(groupBy) || !facts.every((fact) => fact.semantic?.groupBy === groupBy)) return [];
    const total = facts.reduce((sum, fact) => sum + fact.value, 0);
    if (total <= 0) return [];
    const filters = facts[0].semantic?.filters;
    const whose = ownerParts(filters, locale);
    add('total', TASK_TOOLS.has(group.tool) ? taskCountSentence(filters, total, locale, { total: true }) : null, 'info', { count: total });
    const max = Math.max(...facts.map((fact) => fact.value));
    const ownerTitle = soleRow(described, facts, max);
    const owner = ownerTitle == null ? null : canonicalGroupLabel(facts.find((fact) => fact.value === max), ownerTitle, locale);
    // Tek dolu grup (bütün görevler aynı grupta) çoğunluk değildir: toplam ve döküm onu söyler.
    if (owner && max < total) {
      const share = sharePercent(max, total);
      const place = groupPlace(groupBy, owner, locale);
      const done = groupBy === 'status' && facts[facts.findIndex((fact) => fact.value === max)].semantic?.group?.key === 'done';
      if (max * 2 > total) {
        // Çoğunluk ("büyük bölümü") yalnızca birbirini dışlayan tam dağılımda pay yarıyı aştığında; gösterilen pay da %50'yi aşar.
        const majority = majorityPercent(max, total, locale);
        // Akıcı biçim: toplam söylendiyse özne yinelenmez ("… göreviniz var ve bunların büyük bölümü …").
        const them = en ? ['most of them (', v(percent(majority, locale)), ') ', ...place] : ['bunların büyük bölümü (', v(percent(majority, locale)), ') ', ...place];
        add('majority', en
          ? sentence([`Most of ${whose ? '' : 'the tasks in this result'}`, ...(whose || []), ' (', v(percent(majority, locale)), ') ', ...place, '.'])
          : sentence([...(whose || ['bu sonuçtaki görevlerin']), ' büyük bölümü (', v(percent(majority, locale)), ') ', ...place, '.']), done ? 'success' : 'info',
        { anaphor: { count: total, join: [en ? ', and ' : ' ve ', ...them], lead: them } });
      } else {
        const largest = en ? ['the largest group is ', v(owner), ' (', v(number(max, locale)), ` ${max === 1 ? 'task' : 'tasks'}, `, v(percent(share, locale)), ')']
          : ['en büyük grup ', v(owner), ' (', v(number(max, locale)), ' görev, ', v(percent(share, locale)), ')'];
        add('largest', en
          ? sentence(['The largest group is ', v(owner), ': ', v(number(max, locale)), ` ${max === 1 ? 'task' : 'tasks'} (`, v(percent(share, locale)), ').'])
          : sentence(['En büyük grup ', v(owner), ': ', v(number(max, locale)), ' görev (', v(percent(share, locale)), ').']), 'info',
        { anaphor: { count: total, join: [en ? ', and ' : '; ', ...largest], lead: largest } });
      }
    }
    // Tamamlanma: durum anahtarları sunucunun kanonik kodlarıdır (etiket metni yorumlanmaz).
    const keys = facts.map((fact) => fact.semantic?.group?.key);
    if (groupBy === 'status' && keys.every((key) => ['todo', 'in_progress', 'done'].includes(key))) {
      const done = facts.reduce((sum, fact, position) => sum + (keys[position] === 'done' ? fact.value : 0), 0);
      const open = total - done;
      if (done > 0 && open > 0) {
        const share = sharePercent(done, total);
        const sofar = en ? ['so far ', v(percent(share, locale)), ' are completed; ', v(number(open, locale)), ` ${open === 1 ? 'task is' : 'tasks are'} still open`]
          : share < 1 ? ['tamamlanma oranı ', v(percent(share, locale)), '; ', v(number(open, locale)), ' görev hâlâ açık']
            : ['şu ana kadar ', v(percent(share, locale)), `${turkishPossessiveSuffix(share)} tamamlandı; `, v(number(open, locale)), ' görev hâlâ açık'];
        add('completion', en
          ? sentence([v(percent(share, locale)), ` of ${whose ? '' : 'the tasks in this result'}`, ...(whose || []), ' are completed; ', v(number(open, locale)), ` ${open === 1 ? 'task is' : 'tasks are'} still open.`])
          : sentence([...(whose || ['bu sonuçtaki görevlerin']), share < 1 ? ' tamamlanma oranı ' : ' ', v(percent(share, locale)),
            share < 1 ? '; ' : `${turkishPossessiveSuffix(share)} tamamlandı; `, v(number(open, locale)), ' görev hâlâ açık.']),
        done * 2 > total ? 'success' : 'info', { anaphor: { count: total, join: [en ? ', and ' : ' ve ', ...sofar], lead: sofar } });
      }
    }
    if (described.rows.length <= MAX_BREAKDOWN_GROUPS) {
      const items = described.rows.flatMap((row, position) => [...(position ? [', '] : []), t(canonicalGroupLabel(facts[position], row.title, locale)), ' ', v(number(facts[position].value, locale))]);
      add('breakdown', sentence([`${GROUP_NOUNS[groupBy][lang(locale)]}: `, ...items, '.']));
    }
    return out;
  }
  // Satır istatistikleri (uç, ortalama, eşik, yayılma, yoğunlaşma) birden çok gözlem ister.
  if (described.rows.length < 2) return out;
  // Proje ve kişi satırları (portföy, iş yükü): sütun sütun istatistik yerine analist özeti (kapsama ve öndeki satır).
  const leaf = String(collection ?? '').split('.').at(-1);
  if ((group.tool === 'rota_portfolio_summary' && leaf === 'projects') || (group.tool === 'rota_workload_summary' && leaf === 'people')) {
    entityLead(described, leaf === 'projects' ? 'project' : 'person', locale, (kind, realized, tone, at) => { column = at; add(kind, realized, tone); }, group.tool !== 'rota_workload_summary' || group.main.entries.some(({ fact }) => fact.field === 'data.populationComplete' && fact.value === true));
    column = null;
    return out;
  }
  // Sayısal sütunlar önce gelir; yalnızca bütünü gecikmiş görevlerde termin aralığı gecikme uçlarını yineler.
  const order = described.columns.map((item, index) => ({ item, index })).sort((left, right) => Number(right.item.numeric) - Number(left.item.numeric));
  for (const { item: header, index } of order) {
    column = index;
    const type = header.numeric ? 'number' : 'date';
    const facts = columnValues(described, index, type);
    if (!facts) continue;
    const values = facts.map((fact) => fact.value);
    const sorted = [...values].sort((left, right) => (type === 'number' ? left - right : left.localeCompare(right)));
    if (type === 'date' && sorted[0] === sorted.at(-1)) continue;
    const metric = facts[0].semantic?.metric || null;
    if (!facts.every((fact) => fact.semantic?.metric === metric && fact.semantic?.unit === facts[0].semantic?.unit && fact.semantic?.measure === facts[0].semantic?.measure)) continue;
    const semantic = facts[0].semantic || {};
    if (type === 'number' && numericValue(values[0], semantic, locale) == null) continue;
    const overdue = metric === 'task.overdueDays';
    if (type === 'date') {
      if (metric === 'task.targetFinish' && out.some((item) => item.kind === 'maximum'
        && described.rows.every((row) => row.cells[item.column]?.[0]?.semantic?.metric === 'task.overdueDays' && row.cells[item.column][0].value > 0))) continue;
      add('minimum', extremeSentence({ kind: 'minimum', metric, type, label: header.label, value: sorted[0], owner: soleRow(described, facts, sorted[0]), locale }));
      const deadline = metric === 'task.targetFinish';
      add('span', deadline
        ? sentence(en ? ['Deadlines range from ', v(day(sorted[0], locale)), ' to ', v(day(sorted.at(-1), locale)), '.'] : ['Terminler ', v(day(sorted[0], locale)), ' ile ', v(day(sorted.at(-1), locale)), ' arasında.'])
        : sentence(en ? ['“', t(header.label), '” values range from ', v(day(sorted[0], locale)), ' to ', v(day(sorted.at(-1), locale)), '.']
          : ['“', t(header.label), '” değerleri ', v(day(sorted[0], locale)), ' ile ', v(day(sorted.at(-1), locale)), ' arasında.']), 'info',
      // En erken uçtan sonra yalnızca öteki uç söylenir (en erken tarih yinelenmez).
      { pair: { role: 'span', tail: en ? [`and the ${deadline ? 'latest deadline' : 'latest'} is `, v(day(sorted.at(-1), locale))] : [deadline ? 'en geç termin ise ' : 'en geç tarih ise ', v(day(sorted.at(-1), locale))] } });
      continue;
    }
    if (sorted[0] !== sorted.at(-1)) for (const kind of ['maximum', 'minimum']) {
      const value = kind === 'maximum' ? sorted.at(-1) : sorted[0];
      add(kind, extremeSentence({ kind, metric, type, label: header.label, value, owner: soleRow(described, facts, value), locale, semantic }), overdue && kind === 'maximum' ? 'warning' : 'info');
    }
    if (values.length >= 3) {
      const value = Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
      const mean = overdue ? number(value, locale) : numericValue(value, semantic, locale);
      add('average', overdue
        ? sentence(en ? ['The average delay is ', v(`${mean} days`), '.'] : ['Gecikmelerin ortalaması ', v(`${mean} gün`), '.'])
        : sentence(en ? ['The average “', t(header.label), '” is ', v(mean), '.'] : ['“', t(header.label), '” ortalaması ', v(mean), '.']), 'info',
      // Sayım cümlesine eklenen yan cümle: "Şu anda **5** gecikmiş görev var ve ortalama gecikme **10,8 gün**."
      overdue ? { stat: en ? [', with an average delay of ', v(`${mean} days`)] : [' ve ortalama gecikme ', v(`${mean} gün`)] } : null);
    }
    if (overdue) {
      // Bir haftayı aşan gecikme: sunucunun sabit eşiği (7 gün), modelin yorumu değil.
      const late = values.filter((value) => value > 7).length;
      const base = values.length;
      const week = en ? ' more than a week overdue' : ' bir haftadan uzun süredir gecikmiş';
      if (!late) {
        add('threshold', sentence(en ? ['None of these tasks is more than a week overdue.'] : ['Hiçbir görevin gecikmesi bir haftayı aşmıyor.']), 'success',
          { share: shareForms(en ? ['none of these tasks is more than a week overdue'] : ['hiçbir görevin gecikmesi bir haftayı aşmıyor'],
            en ? ['none of them is more than a week overdue'] : ['bunların hiçbirinin gecikmesi bir haftayı aşmıyor'], en ? ['none is more than a week overdue'] : ['hiçbirinin gecikmesi bir haftayı aşmıyor'], base) });
      } else if (late === base) {
        add('threshold', sentence(en ? ['All of these tasks are more than a week overdue.'] : ['Bu görevlerin tamamı bir haftadan uzun süredir gecikmiş.']), 'warning',
          { share: shareForms(en ? [`all of these tasks are${week}`] : [`bu görevlerin tamamı${week}`], en ? [`all of them are${week}`] : [`bunların tamamı${week}`],
            en ? [`all are${week}`] : [`tamamı${week}`], base) });
      } else {
        add('threshold', sentence(en ? [v(number(late, locale)), ` of the `, v(number(base, locale)), ' tasks are more than a week overdue.']
          : [v(number(base, locale)), ' görevin ', v(number(late, locale)), `${turkishPossessiveSuffix(late)} bir haftadan uzun süredir gecikmiş.`]), 'warning',
        { share: shareForms(en ? [v(number(late, locale)), ' of the ', v(number(base, locale)), ` tasks are${week}`] : [v(number(base, locale)), ' görevin ', v(number(late, locale)), `${turkishPossessiveSuffix(late)}${week}`],
          en ? ['of these, ', v(number(late, locale)), ` are${week}`] : ['bunların ', v(number(late, locale)), `${turkishPossessiveSuffix(late)}${week}`],
          en ? [v(number(late, locale)), ` are${week}`] : [v(number(late, locale)), `${turkishPossessiveSuffix(late)} de${week}`], base) });
      }
    }
  }
  column = null;
  // "Bu görevler" yalnızca görev koleksiyonunun satırlarıdır.
  if (TASK_TOOLS.has(group.tool) && String(collection ?? '').split('.').at(-1) === 'tasks') add('concentration', projectConcentration(described, locale));
  return out;
}

/** Türkçe bulunma eki (iyelikten sonra): "3'ü" → "3'ünde", "2'si" → "2'sinde", "6'sı" → "6'sında". */
function locativeOf(value) {
  const possessive = turkishPossessiveSuffix(value);
  return `${possessive}${/[ıu]$/.test(possessive) ? 'nda' : 'nde'}`;
}

const lowerLabel = (label, locale) => String(label).toLocaleLowerCase(locale === 'en' ? 'en-US' : 'tr-TR');

/**
 * Proje ya da kişi satırlarının (bütün nüfus) analist özeti: gecikmiş görevi olan satırların kapsaması ve birden çok
 * sayı sütununda tekil en yüksek değeri taşıyan satır ("**X**, açık görev (**6**) ve gecikmiş görev (**2**) sayısında en üstte").
 */
function entityLead(described, noun, locale, add, allowLead = true) {
  const en = locale === 'en';
  const counts = described.columns.map((header, index) => ({ header, index, facts: header.numeric ? columnValues(described, index, 'number') : null }))
    .filter(({ facts }) => facts && facts.every((fact) => Number.isSafeInteger(fact.value) && fact.value >= 0 && String(fact.semantic?.metric || '').startsWith('tasks.')));
  const total = described.rows.length;
  const overdue = counts.find(({ facts }) => facts.every((fact) => fact.semantic?.metric === 'tasks.overdue'));
  if (overdue && (noun === 'project' || allowLead)) {
    const late = overdue.facts.filter((fact) => fact.value > 0).length;
    const nouns = en ? (noun === 'project' ? ['project', 'projects'] : ['person', 'people']) : (noun === 'project' ? 'proje' : 'kişi');
    const realized = late === total
      ? sentence(en ? [noun === 'project' ? 'All ' : 'All ', v(number(total, locale)), ` ${nouns[1]} have overdue tasks.`]
        : [`listedeki `, v(number(total, locale)), ` ${nouns}nin hepsinde gecikmiş görev var.`])
      : late === 0
        ? sentence(en ? [`None of the ${nouns[1]} has overdue tasks.`] : [`${nouns === 'proje' ? 'Projelerin' : 'Kişilerin'} hiçbirinde gecikmiş görev yok.`])
        : sentence(en ? [v(number(late, locale)), ' of the ', v(number(total, locale)), ` ${nouns[1]} have overdue tasks.`]
          : [v(number(total, locale)), ` ${nouns}nin `, v(number(late, locale)), `${locativeOf(late)} gecikmiş görev var.`]);
    add('coverage', realized, late ? 'warning' : 'success', overdue.index);
  }
  if (!allowLead) return;
  const leads = counts.map((item) => {
    const max = Math.max(...item.facts.map((fact) => fact.value));
    return max > 0 ? { ...item, max, owner: soleRow(described, item.facts, max) } : null;
  }).filter((item) => item?.owner);
  const owners = new Map();
  for (const item of leads) owners.set(item.owner, [...(owners.get(item.owner) || []), item]);
  const ranked = [...owners.entries()].sort((left, right) => right[1].length - left[1].length);
  if (!ranked.length || (ranked[1] && ranked[1][1].length === ranked[0][1].length)) return;
  const [owner, columns] = ranked[0];
  const listed = series(columns.map((item) => [lowerLabel(item.header.label, locale), ' (', v(number(item.max, locale)), ')']), locale);
  add('leader', sentence(en ? [v(owner), ' leads in ', ...listed, '.'] : [v(owner), ', ', ...listed, ' sayısında en üstte.']), 'info', columns[0].index);
}

/**
 * Açık/tamamlanan bölümleriyle (tasks.open + tasks.done) okunan birbirini dışlayan gruplar: açık işlerin çoğunluğu ya da
 * en büyük grubu. Açık iş toplamı açık sütunun toplamıdır; pay yalnızca bu tam bölümden.
 */
function openPartition(described, group, locale, add) {
  const column = (metric) => described.columns.findIndex((item, position) => item.numeric && columnValues(described, position, 'number')?.every((fact) => fact.semantic?.metric === metric));
  const index = column('tasks.open');
  // Yalnızca açık + tamamlanan bölümleri birlikte okunduğunda (tam bölüntü); tek başına açık sütunu bir alt küme ölçüsüdür.
  if (column('tasks.done') < 0) return [];
  const facts = index >= 0 ? columnValues(described, index, 'number') : null;
  if (!facts || !facts.every((fact) => Number.isSafeInteger(fact.value) && fact.value >= 0)) return [];
  const groupBy = facts[0].semantic?.groupBy;
  if (!EXCLUSIVE_GROUP_BY.includes(groupBy) || !facts.every((fact) => fact.semantic?.groupBy === groupBy)) return [];
  const total = facts.reduce((sum, fact) => sum + fact.value, 0);
  const max = Math.max(...facts.map((fact) => fact.value));
  const title = soleRow(described, facts, max);
  const whose = ownerParts(facts[0].semantic?.filters, locale);
  if (!total || !title || !whose || max === total) return [];
  const owner = canonicalGroupLabel(facts.find((fact) => fact.value === max), title, locale);
  const en = locale === 'en';
  const open = ownerParts(facts[0].semantic?.filters, locale, { open: true });
  const push = (kind, realized) => add(kind, realized);
  if (open && max * 2 > total) {
    const share = majorityPercent(max, total, locale);
    push('majority', en ? sentence(['Most of ', ...open, ' (', v(percent(share, locale)), ') ', ...groupPlace(groupBy, owner, locale), '.'])
      : sentence([...open, ' büyük bölümü (', v(percent(share, locale)), ') ', ...groupPlace(groupBy, owner, locale), '.']));
  } else if (open) {
    push('largest', en ? sentence(['The largest share of ', ...open, ' (', v(number(max, locale)), ') ', ...groupPlace(groupBy, owner, locale), '.'])
      : sentence([...open, ' en büyük kısmı (', v(number(max, locale)), ' görev) ', ...groupPlace(groupBy, owner, locale), '.']));
  }
}

/**
 * Görev satırlarının projelere dağılımı (satırın doğrulanmış proje bağlamından): tek projede toplanma, bir
 * projenin çoğunluğu ya da kaç projeye yayıldığı. Gruplama doğrulanmış proje KİMLİĞİYLEdir (aynı adlı iki proje
 * ayrıdır); ad yalnızca gösterimdir. Kimliği olmayan satırda yoğunlaşma iddiası yoktur.
 */
function projectConcentration(described, locale) {
  // Nüfus zaten tek projeyse ("bu projedeki gecikmiş işler") "hepsi bu projede" bilgi taşımaz.
  if (described.rows[0]?.entries[0]?.fact.semantic?.filters?.projectId) return null;
  const projects = described.rows.map((row) => ({ id: row.entries[0]?.fact.semantic?.row?.projectId || null, name: row.context?.project || null }));
  if (projects.length < 2 || projects.some((project) => !project.id || !project.name)) return null;
  const counts = new Map();
  for (const { id, name } of projects) counts.set(id, { name, count: (counts.get(id)?.count || 0) + 1 });
  const en = locale === 'en';
  const total = projects.length;
  const withShare = (realized, share) => ({ ...realized, fluent: { share } });
  if (counts.size === 1) {
    const name = v(projects[0].name);
    return withShare(sentence(en ? ['All of these tasks are in the ', name, ' project.'] : ['Bu görevlerin tamamı ', name, ' projesinde.']),
      shareForms(en ? ['all of these tasks are in the ', name, ' project'] : ['bu görevlerin tamamı ', name, ' projesinde'],
        en ? ['all of them are in the ', name, ' project'] : ['bunların tamamı ', name, ' projesinde'], en ? ['all are in the ', name, ' project'] : ['hepsi ', name, ' projesinde'], total));
  }
  const ranked = [...counts.values()].sort((left, right) => right.count - left.count);
  // Ad, kimliği ayırt etmiyorsa (başka bir proje aynı adı taşıyor) bir projeyi adıyla öne çıkarmak yanıltır.
  if (ranked[0].count * 2 > total && ranked.filter((item) => item.name === ranked[0].name).length === 1) {
    const count = v(number(ranked[0].count, locale));
    const of = `${turkishPossessiveSuffix(ranked[0].count)}`;
    const name = v(ranked[0].name);
    return withShare(sentence(en ? [count, ' of the ', v(number(total, locale)), ' tasks are in the ', name, ' project.']
      : [v(number(total, locale)), ' görevin ', count, `${of} `, name, ' projesinde.']),
    shareForms(en ? [count, ' of the ', v(number(total, locale)), ' tasks are in the ', name, ' project'] : [v(number(total, locale)), ' görevin ', count, `${of} `, name, ' projesinde'],
      en ? ['of these, ', count, ' are in the ', name, ' project'] : ['bunların ', count, `${of} `, name, ' projesinde'],
      en ? [count, ' are in the ', name, ' project'] : [count, `${of} de `, name, ' projesinde'], total));
  }
  const spread = v(number(counts.size, locale));
  return withShare(sentence(en ? ['The tasks are spread across ', spread, ' projects.'] : ['Görevler ', spread, ' projeye dağılmış.']),
    shareForms(en ? ['the tasks are spread across ', spread, ' projects'] : ['görevler ', spread, ' projeye dağılmış'],
      en ? ['they are spread across ', spread, ' projects'] : ['bu görevler ', spread, ' farklı projeye dağılmış'],
      en ? ['they are spread across ', spread, ' projects'] : ['görevler ', spread, ' farklı projeye dağılmış'], total));
}

/**
 * Aynı satır kümesinin payı üzerine kurulan önermenin akıcı biçimleri: `full` tek başına, `intro` küme bu paragrafta
 * sayıyla tanıtıldıysa ("bunların …"), `also` aynı kümenin pay dizisinde ikinci ve sonraki yan cümle ("…, 2'si de …").
 */
function shareForms(full, intro, also, base) {
  return Object.freeze({ base, full: Object.freeze(full), intro: Object.freeze(intro), also: Object.freeze(also) });
}

/** Not kutusunun sunucu etiketi; tonu önermelerin sunucu tonudur. */
export function noteLabel(tone, locale) {
  return { warning: ['Dikkat', 'Attention'], success: ['Olumlu', 'Positive'] }[tone]?.[lang(locale)] || (locale === 'en' ? 'Highlight' : 'Öne çıkan');
}

/** Sonraki bloğa yönlendiren düzen cümlesi: olgu değil, sunucunun çizdiği bloğun varlığıdır. */
export function pointerSentence({ type, style, distribution = false, chartType = null }, locale) {
  const en = locale === 'en';
  if (type === 'chart' && chartType === 'kpi') return en ? 'The key figures are shown below.' : 'Öne çıkan göstergeleri aşağıda görebilirsiniz.';
  // Zaman çizelgesi gecikmiş (geçmiş) terminleri de gösterebilir: cümle tarihleri "yaklaşan" diye nitelemez.
  if (type === 'chart' && chartType === 'timeline') return en ? 'The timeline below shows these dates.' : 'Tarihleri aşağıdaki zaman çizelgesinde görebilirsiniz.';
  if (type === 'chart' && chartType === 'line') return en ? 'The chart below shows the change over time.' : 'Zaman içindeki değişimi aşağıdaki grafikte görebilirsiniz.';
  if (type === 'chart' && chartType === 'stacked') return en ? 'The chart below shows the status breakdown.' : 'Durum kırılımını aşağıdaki grafikte görebilirsiniz.';
  if (type === 'chart') {
    return distribution ? (en ? 'The chart below shows the distribution.' : 'Dağılımı aşağıdaki grafikte görebilirsiniz.')
      : (en ? 'The chart below compares the values.' : 'Değerleri aşağıdaki grafikte karşılaştırabilirsiniz.');
  }
  return style === 'table' ? (en ? 'You can see the details in the table below.' : 'Ayrıntıları aşağıdaki tabloda görebilirsiniz.')
    : (en ? 'The details are listed below.' : 'Ayrıntılar aşağıda listeleniyor.');
}

/* ── Aşama 4E: analist önermeleri ─────────────────────────────────── */

/**
 * Denge yargısının önkoşulu: aynı tam kanıtın sorumlusuz açık iş sayısı BİLİNİR ve bir kişinin ortalama yükünü aşmaz.
 * Bilinmiyorsa ya da büyükse "açık işler dengeli dağılmış" denmez (asıl iş atanmamış olabilir).
 */
function unassignedSmall(items, rows, assigned) {
  const fact = items.find(({ fact: item, evidenceId }) => item.field === 'data.unassignedOpenTasks' && evidenceId === rows[0].evidenceId);
  const value = fact?.fact.value;
  return Number.isSafeInteger(value) && value >= 0 && value * rows.length <= assigned;
}

/** Doğrulanmış tam kanıttan sayı (sonlu, negatif olmayan tam sayı); değilse `null`. */
const countOf = (entry) => (entry && Number.isSafeInteger(entry.fact.value) && entry.fact.value >= 0 ? entry.fact.value : null);
const ofCount = (value, locale) => (locale === 'en' ? number(value, locale) : `${number(value, locale)}${turkishPossessiveSuffix(value)}`);

/**
 * Bölümün doğrulanmış olgularından ANALİST önermeleri: karşıtlık (olumlu tamamlanma + gecikme riski), zamanlama baskısı
 * (açık işlerin gecikmiş payı), yakın termin yoğunluğu, kişiler arasında iş yükü yoğunlaşması ya da dengesi, gecikmelerin
 * kişide yoğunlaşması ve kanıta dayalı dikkat önceliği (en uzun gecikme). Her ilişki önkoşuluyla vardır; değerler, adlar ve
 * paylar yalnızca aynı tam kanıtın olgularıdır. Kişi hakkında yetkinlik ya da performans yargısı üretilmez: dil işlemseldir
 * (iş yükü, gecikme, yaklaşan termin).
 */
export function analystPropositions(parts, locale = 'tr') {
  const en = locale === 'en';
  const out = [];
  // Satır sırası tamlık payda ve dikkat sıralaması tek kanonik kanıt nüfusuna aittir.
  const evidenceParts = parts.flatMap((part) => {
    const evidencePopulations = new Map();
    for (const item of part.presentation?.facts || []) {
      if (item.fact?.semantic?.complete !== true) continue;
      if (!evidencePopulations.has(item.evidenceId)) evidencePopulations.set(item.evidenceId, []);
      evidencePopulations.get(item.evidenceId).push(item);
    }
    return [...evidencePopulations.values()].map((facts) => ({ index: part.index, presentation: { facts } }));
  });
  // Kişi ile kendisinin karşılaştırmasında kullanıcının kendi bölümünün önermeleri de öznesini taşır ("Siz: …").
  const comparingPeople = evidenceParts.some((part) => part.presentation.facts.some((item) => item.fact?.semantic?.filters?.personSicil != null || item.fact?.semantic?.filters?.person));
  for (const part of evidenceParts) {
    const ordinal = part.index + 1;
    const items = part.presentation.facts;
    const add = (evidenceId, kind, realized, tone = 'info', fluent = null) => {
      const sample = items.find((item) => item.evidenceId === evidenceId)?.fact.semantic;
      const filters = sample?.filters;
      const self = comparingPeople && filters?.assignee === 'me' ? (en ? 'You' : 'Siz') : null;
      const subject = [self, filters?.person || (filters?.personSicil != null && sample?.entity?.type === 'person' ? sample.entity.name : null),
        filters?.projectId ? filters.project || (sample?.entity?.type === 'project' ? sample.entity.name : null) : null].filter(Boolean).join(' · ');
      if (filters?.personSicil != null && !subject) return;
      if (realized && subject) {
        realized = sentence([v(subject), ': ', ...realized.parts]);
        // Koşullu açıklama başka öznenin anlatımına eklenirken kendi öznesini kaybetmemelidir.
        fluent = fluent?.states ? { states: fluent.states } : null;
      }
      if (realized) out.push({ part: ordinal, proposition: { kind, tone, evidenceId, ...realized, ...(fluent ? { fluent: Object.freeze(fluent) } : {}) } });
    };
    // Genel görünüm: görev analizinin toplamları (aynı kanıt).
    const populations = new Map();
    for (const item of items) {
      if (item.fact.semantic?.provenance?.tool !== 'rota_task_analytics' || !/^data\.totals\.[A-Za-z0-9]+$/.test(item.fact.field)) continue;
      if (!populations.has(item.evidenceId)) populations.set(item.evidenceId, new Map());
      populations.get(item.evidenceId).set(item.fact.semantic.metric, item);
    }
    const sameEvidence = (entries) => entries.every((entry) => entry && entry.evidenceId === entries[0].evidenceId);
    for (const totals of populations.values()) {
      const open = countOf(totals.get('tasks.open'));
      const overdue = countOf(totals.get('tasks.overdue'));
      const soon = countOf(totals.get('tasks.dueNext7Days'));
      const rateEntry = totals.get('tasks.completionRatePercent');
      const rate = rateEntry && Number.isFinite(rateEntry.fact.value) ? rateEntry.fact.value : null;
      const evidence = totals.get('tasks.open')?.evidenceId;
      if (open != null && overdue != null && sameEvidence([totals.get('tasks.open'), totals.get('tasks.overdue')])) {
        if (rate != null && rate >= 50 && overdue > 0 && sameEvidence([totals.get('tasks.open'), rateEntry])) {
          add(evidence, 'contrast', en
            ? sentence(['The completion picture is positive (', v(percent(rate, locale)), '); however, ', v(number(overdue, locale)), ` overdue ${overdue === 1 ? 'task needs' : 'tasks need'} attention.`])
            : sentence(['Tamamlanma görünümü olumlu (', v(percent(rate, locale)), '); buna karşılık ', v(number(overdue, locale)), ' gecikmiş görev dikkat gerektiriyor.']), 'warning',
          { states: ['tasks.completionRatePercent', 'tasks.overdue'] });
        } else if (open > 0 && overdue > 0) {
          const share = sharePercent(overdue, open);
          add(evidence, 'pressure', en
            ? sentence([v(number(overdue, locale)), ` of the `, v(number(open, locale)), ` open ${open === 1 ? 'task is' : 'tasks are'} overdue (`, v(percent(share, locale)), ').'])
            : sentence(['Açık ', v(number(open, locale)), ' görevin ', v(ofCount(overdue, locale)), ' (', v(percent(share, locale)), ') gecikmiş durumda.']), share >= 25 ? 'warning' : 'info',
          { host: 'totals', states: ['tasks.open', 'tasks.overdue'] });
        } else if (open > 0 && overdue === 0) {
          add(evidence, 'positive', en ? sentence(['There are currently no overdue tasks among the ', v(number(open, locale)), ' open tasks.'])
            : sentence(['Açık ', v(number(open, locale)), ' görev arasında şu anda gecikmiş görev yok.']), 'success', { host: 'totals', states: ['tasks.open', 'tasks.overdue'] });
        }
        if (open > 0 && soon != null && soon > 0 && sameEvidence([totals.get('tasks.open'), totals.get('tasks.dueNext7Days')])) {
          const due = en ? ` open ${soon === 1 ? 'task is' : 'tasks are'}` : ' açık görevin termini var';
          add(evidence, 'urgency', en
            ? sentence([v(number(soon, locale)), ` open ${soon === 1 ? 'task is' : 'tasks are'} due in the seven-day period starting today.`])
            : sentence(['Bugün başlayan yedi günlük dönemde ', v(number(soon, locale)), ' açık görevin termini var.']), soon * 2 >= open ? 'warning' : 'info',
          // Gecikme cümlesinin devamı: "…; bugün başlayan yedi günlük dönemde de **1** açık görevin termini var." Gecikme yoksa ve yakın
          // termin dikkat gerektiriyorsa karşıtlık ("ancak"), değilse yalın ek.
          { states: ['tasks.dueNext7Days'], follow: { key: 'totals',
            also: en ? ['; ', v(number(soon, locale)), `${due} also due in the seven-day period starting today`] : ['; bugün başlayan yedi günlük dönemde de ', v(number(soon, locale)), due],
            plain: en ? ['; ', v(number(soon, locale)), `${due} due in the seven-day period starting today`] : ['; bugün başlayan yedi günlük dönemde ', v(number(soon, locale)), due],
            contrast: en ? ['; however, ', v(number(soon, locale)), `${due} due in the seven-day period starting today`] : ['; ancak bugün başlayan yedi günlük dönemde ', v(number(soon, locale)), due] } });
        }
      }
    }
    // Kişiler arası iş yükü: iş yükü aracının TAM kişi satırları (kesilmemiş sıralama).
    const people = new Map();
    for (const item of items) {
      const match = /^data\.people\.(\d+)\.(name|openTasks|overdue)$/.exec(item.fact.field);
      if (!match || item.fact.semantic?.provenance?.tool !== 'rota_workload_summary') continue;
      if (!people.has(match[1])) people.set(match[1], { evidenceId: item.evidenceId, identity: `person:${item.evidenceId}:data.people.${match[1]}`, size: item.fact.semantic?.row?.collectionSize ?? null });
      people.get(match[1])[match[2]] = item.fact.value;
    }
    const rows = [...people.values()].filter((row) => typeof row.name === 'string' && Number.isSafeInteger(row.openTasks) && row.openTasks >= 0);
    const populationComplete = rows.length && items.some(({ fact, evidenceId }) => evidenceId === rows[0].evidenceId
      && fact.field === 'data.populationComplete' && fact.value === true);
    if (populationComplete && rows.length >= 3 && rows.length === people.size && rows.every((row) => row.size === rows.length) && sameEvidence(rows)) {
      const sum = rows.reduce((total, row) => total + row.openTasks, 0);
      const top = [...rows].sort((left, right) => right.openTasks - left.openTasks);
      const unique = top[0].openTasks > top[1].openTasks;
      const low = top.at(-1).openTasks;
      // Yoğunlaşma: en yüksek kişi ikinciyi en az iki kat aşar ve atamaların en az üçte birini taşır.
      if (sum > 0 && unique && top[0].openTasks >= 2 * top[1].openTasks && top[0].openTasks * 3 >= sum) {
        const share = sharePercent(top[0].openTasks, sum);
        add(rows[0].evidenceId, 'concentration', en
          ? sentence([v(percent(share, locale)), ' of the open task assignments are on ', v(top[0].name), '; the workload is concentrated on this person.'])
          : sentence(['Açık iş atamalarının ', v(`${percent(share, locale)}${turkishPossessiveSuffix(share)}`), ' ', v(top[0].name), ' üzerinde; iş yükü bu kişide yoğunlaşıyor.']), share >= 50 ? 'warning' : 'info',
        { host: top[0].identity });
      } else if (low > 0 && top[0].openTasks * 2 <= low * 3 && unassignedSmall(items, rows, sum)) {
        add(rows[0].evidenceId, 'balance', en
          ? sentence(['Open work is spread fairly evenly across people (highest ', v(number(top[0].openTasks, locale)), ', lowest ', v(number(low, locale)), ').'])
          : sentence(['Açık işler kişiler arasında görece dengeli dağılmış (en yüksek ', v(number(top[0].openTasks, locale)), ', en düşük ', v(number(low, locale)), ').']), 'success');
      }
      const late = rows.filter((row) => Number.isSafeInteger(row.overdue) && row.overdue >= 0);
      const lateSum = late.length === rows.length ? late.reduce((total, row) => total + row.overdue, 0) : 0;
      const worst = [...late].sort((left, right) => right.overdue - left.overdue);
      if (lateSum >= 2 && worst[0].overdue > (worst[1]?.overdue ?? 0) && worst[0].overdue * 2 >= lateSum) {
        const lateShare = sharePercent(worst[0].overdue, lateSum);
        const shown = en ? v(percent(lateShare, locale)) : v(`${percent(lateShare, locale)}${turkishPossessiveSuffix(lateShare)}`);
        add(rows[0].evidenceId, 'overdueConcentration', en
          ? sentence([shown, ' of the overdue task assignments are on ', v(worst[0].name), '.'])
          : sentence(['Gecikmiş iş atamalarının ', shown, ' ', v(worst[0].name), ' üzerinde.']), 'warning',
        // Aynı kişinin açık iş yoğunlaşmasından sonra: "…; iş yükü bu kişide yoğunlaşıyor, gecikmiş iş atamalarının %80'i de onda."
        { follow: { key: worst[0].identity, also: en ? [', and ', shown, ' of the overdue assignments are also on this person'] : [', gecikmiş iş atamalarının ', shown, ' de onda'] } });
      }
    }
    // Dikkat önceliği: gecikmiş görev sıralamasının başı en az bir haftalık gecikmeyse (gerekçe sunucunun kuralıdır).
    const delays = items.filter(({ fact }) => /^data\.tasks\.\d+\.overdueDays$/.test(fact.field) && fact.semantic?.filters?.deadline === 'overdue'
      && Number.isSafeInteger(fact.value) && fact.value >= 7);
    // Tek gecikmiş görevde "ilk ele alınabilecek iş" bilgi taşımaz: öneri en az iki gecikmiş satır arasından seçilir.
    const lateRows = items.filter(({ fact }) => /^data\.tasks\.\d+\.overdueDays$/.test(fact.field) && fact.semantic?.filters?.deadline === 'overdue').length;
    if (delays.length && lateRows >= 2) {
      const head = delays.reduce((best, item) => (item.fact.value > best.fact.value ? item : best));
      const ties = delays.filter((item) => item.fact.value === head.fact.value).length;
      const title = items.find(({ fact, evidenceId }) => evidenceId === head.evidenceId && fact.field === head.fact.field.replace(/overdueDays$/, 'title'))?.fact.value;
      if (ties === 1 && typeof title === 'string') {
        // Öneri gerekçesiyle söylenir (en uzun gecikme); görev bu paragrafta en uzun gecikmeli olarak adlandırıldıysa kısa biçim.
        add(head.evidenceId, 'attention', en
          ? sentence(['A sensible first focus is ', v(title), ': it has been overdue for ', v(number(head.fact.value, locale)), ' days, the longest delay.'])
          : sentence(['İlk ele alınabilecek iş ', v(title), ' görünüyor: ', v(number(head.fact.value, locale)), ' gündür gecikmiş ve en uzun gecikme onda.']), 'warning',
        { refers: { title, short: en ? ['as the longest-overdue task, ', v(title), ' is a sensible first focus'] : ['en uzun süredir beklediği için ilk ele alınabilecek iş ', v(title), ' görünüyor'] } });
      }
    }
  }
  return out;
}

/**
 * Tamlığı kanıtlanmamış nüfusun SUNUCU ÇEKİNCESİ (zorunlu önerme): iş yükü kanıtı bütün atamaları temsil ettiğini
 * kanıtlamadıysa (`data.populationComplete` false: ekip kadrosu bilinmiyor, kişi sayfası kesik, çözümlenemeyen ya da
 * temsil edilemeyen atama) denge, yoğunlaşma ya da "en yoğun kişi" sonucu çıkarılamaz. Çekince nedeni ve sayısı
 * söylenmez (gizli atamanın varlığı ya da sayısı açıklanmaz); yalnızca ne söylenemeyeceği söylenir.
 */
export function caveatPropositions(parts, locale = 'tr') {
  const en = locale === 'en';
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    for (const item of part.presentation?.facts || []) {
      const fact = item.fact;
      const assignments = assignmentGroups(fact);
      if (!assignments && (fact?.field !== 'data.populationComplete' || fact.value !== false)) continue;
      if (seen.has(item.evidenceId)) continue;
      seen.add(item.evidenceId);
      out.push({ part: part.index + 1, proposition: { kind: 'completeness', tone: 'info', evidenceId: item.evidenceId, ...sentence(assignments ? (en
        ? ['this task-assignment breakdown does not establish the full roster: members with no matching tasks are unknown, and any unresolved or hidden assignees cannot enter a person ranking. Team balance or an exhaustive workload ranking cannot be established.']
        : ['bu görev-atama kırılımı kadronun tamamını kanıtlamaz: eşleşen işi olmayan üyelerin tamamı bilinmez; çözümlenemeyen veya gizli atamalar varsa kişi sıralamasına katılamaz. Ekip dengesi veya eksiksiz iş yükü sıralaması kesin olarak söylenemez.']) : en
        ? ['this workload view covers only the open work you can see that is attributed to people, so whether the load is balanced or who carries the most cannot be stated with certainty.']
        : ['bu iş yükü görünümü yalnızca görebildiğiniz ve kişilere bağlanabilen açık işleri kapsıyor; bu nedenle iş yükünün dengeli olup olmadığı ya da en çok yükün kimde olduğu kesin olarak söylenemez.']) } });
    }
  }
  return out;
}

/* ── Akıcı paragraf ─────────────────────────────────────────────────── */

/** Cümle parçalarının yan cümle biçimi (son nokta düşer); parça yoksa ya da cümle noktayla bitmiyorsa `null`. */
function clauseOf(parts) {
  if (!Array.isArray(parts) || !parts.length) return null;
  const last = parts.at(-1);
  if (typeof last !== 'string' || !last.endsWith('.')) return null;
  const trimmed = last.slice(0, -1);
  return trimmed ? [...parts.slice(0, -1), trimmed] : parts.slice(0, -1);
}

/** Yan cümle dizisi: "A", "A ve B", "A, B ve C". */
function series(clauses, locale) {
  if (clauses.length === 1) return [...clauses[0]];
  return [...clauses.slice(0, -1).flatMap((clause, index) => [...(index ? [', '] : []), ...clause]), locale === 'en' ? ' and ' : ' ve ', ...clauses.at(-1)];
}

const PAIR_ROLES = new Set(['maximum', 'minimum', 'span']);
const FOLLOW_HOSTS = new Set(['pressure', 'positive', 'concentration']);

/**
 * Bir paragrafın önermelerini birbirine bağlı düzyazıya çevirir. Model yalnızca kimlik ve sırayı seçmiştir; bağlaçlar,
 * zamirler ve birleştirme sunucunun sabit kurallarıdır ve YALNIZCA aynı kanıtın (aynı nüfusun) önermeleri arasında
 * çalışır. Hiçbir kural yeni olgu ya da ilişki eklemez: birleşen yan cümleler, tek başına söylenen önermelerin
 * aynısıdır (ör. "bunların" yalnızca kümeyi aynı sayıyla tanıtan cümleden sonra; karşıtlık yalnızca sunucunun olumlu
 * tonundan sonra gelen dikkat tonunda). Kural tutmazsa önerme kendi cümlesiyle kalır.
 *
 * Kurallar: aynı sütunun iki ucu tek cümle ("…, en kısa süredir geciken ise …"); ortalama gecikme sayım cümlesine
 * ("… var ve ortalama gecikme …"); aynı satır kümesinin payları tek cümle ("Bunların 2'si …, 2'si de …"); toplamdan
 * sonra dağılım ("… var ve bunların büyük bölümü …"); gecikme payından sonra yakın termin ("…; önümüzdeki yedi gün
 * içinde de …"); bir kişinin açık iş yoğunlaşmasından sonra gecikme yoğunlaşması; adı geçen en uzun gecikmeli görev
 * için öneri kısa biçimde.
 * @param {({ proposition: object } | { text: string })[]} entries Paragrafın sırası (yönlendirme ve not cümleleri `text`).
 */
export function fluentParagraph(entries, locale = 'tr') {
  const units = [];
  const introduced = new Map();
  const named = new Set();
  const latest = () => { const last = units.at(-1); return last && last.text == null ? last : null; };
  const start = (proposition, parts = null) => {
    units.push({ subject: proposition.evidenceId, kinds: [proposition.kind], last: proposition, proposition, parts: parts ? [...parts] : clauseOf(proposition.parts), merged: Boolean(parts) });
  };
  const extend = (unit, proposition, parts) => {
    unit.parts = [...unit.parts, ...parts];
    unit.kinds.push(proposition.kind);
    unit.last = proposition;
    unit.merged = true;
  };
  for (const entry of entries) {
    if (entry.text != null) { units.push({ text: entry.text }); continue; }
    const proposition = entry.proposition;
    const fluent = proposition.fluent || {};
    const subject = proposition.evidenceId;
    const prev = latest();
    // Birleştirilebilir önceki cümle: aynı kanıt, yan cümle biçimi var, pay dizisi değil.
    const open = prev && prev.subject === subject && prev.parts && !prev.shares ? prev : null;
    const pairKey = proposition.table != null && Number.isInteger(proposition.column) ? `${proposition.table}:${proposition.column}` : null;
    const prevPair = open?.kinds.length === 1 && open.last.fluent?.pair && open.last.table != null ? `${open.last.table}:${open.last.column}` : null;
    const host = fluent.stat ? units.find((unit) => unit.text == null && unit.subject === subject && unit.parts && !unit.shares && unit.kinds.length === 1
      && unit.last.kind === 'count') : null;
    if (fluent.pair && PAIR_ROLES.has(fluent.pair.role) && pairKey && prevPair === pairKey && open.last.fluent.pair.role !== fluent.pair.role) {
      extend(open, proposition, [', ', ...fluent.pair.tail]);
    } else if (host) {
      extend(host, proposition, fluent.stat);
    } else if (fluent.share && prev?.shares && prev.subject === subject && prev.shares.base === fluent.share.base && prev.shares.clauses.length < 3) {
      prev.shares.clauses.push(fluent.share.also);
      prev.kinds.push(proposition.kind);
      prev.last = proposition;
    } else if (fluent.share) {
      units.push({ subject, kinds: [proposition.kind], last: proposition, proposition, merged: true,
        shares: { base: fluent.share.base, clauses: [introduced.get(subject) === fluent.share.base ? fluent.share.intro : fluent.share.full] } });
    } else if (fluent.anaphor && introduced.get(subject) === fluent.anaphor.count) {
      if (open && open.kinds.length === 1 && ['count', 'total'].includes(open.last.kind)) extend(open, proposition, fluent.anaphor.join);
      else start(proposition, fluent.anaphor.lead);
    } else if (fluent.follow && open && open.kinds.length === 1 && FOLLOW_HOSTS.has(open.last.kind) && open.last.fluent?.host === fluent.follow.key) {
      const form = open.last.tone === 'success' ? (proposition.tone === 'warning' ? fluent.follow.contrast : fluent.follow.plain) : fluent.follow.also;
      if (form) extend(open, proposition, form);
      else start(proposition);
    } else if (fluent.refers && named.has(fluent.refers.title)) {
      start(proposition, fluent.refers.short);
    } else {
      start(proposition);
    }
    if (Number.isSafeInteger(fluent.count)) introduced.set(subject, fluent.count);
    if (fluent.pair && fluent.names) named.add(fluent.names);
  }
  return units.map((unit) => {
    if (unit.text != null) return unit.text;
    if (unit.shares) return sentence([...series(unit.shares.clauses, locale), '.']).markdown;
    return unit.merged && unit.parts ? sentence([...unit.parts, '.']).markdown : unit.proposition.markdown;
  }).join(' ');
}
