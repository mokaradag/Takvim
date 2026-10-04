import { escapedFactText, factLabel, factPresentation } from './evidenceFacts.js';

/**
 * Doğrulanmış olguların SUNUCUYA AİT anlatımı.
 *
 * Model yalnızca kanıttaki olguları seçer; cümleyi, sayıyı, adı ve atfı sunucu
 * yazar. Özet olgular düzyazı paragrafa, satır olguları listeye ya da (tablo
 * istendiğinde veya çok sütunlu karşılaştırmada) tabloya dönüşür. Anlatım
 * yalnızca seçilen olguları içerir; olgular arasında ilişki, neden ya da yorum
 * üretmez. Veri metni Markdown'a kaçışla girer.
 */

const ENVELOPE_FIELDS = new Set(['returnedCount', 'totalCount', 'complete', 'truncated']);

const TOTAL_KEYS = Object.freeze(['open', 'done', 'inProgress', 'todo', 'overdue', 'dueToday', 'dueNext7Days', 'openWithoutTargetFinish', 'doneWithoutActualFinish', 'milestonesOpen']);
const TOTAL_PREDICATES = Object.freeze({
  open: ['açık', 'are open'], done: ['tamamlanmış', 'are completed'], inProgress: ['devam ediyor', 'are in progress'],
  todo: ['yapılacak durumunda', 'are to do'], overdue: ['gecikmiş', 'are overdue'], dueToday: ['bugün terminli', 'are due today'],
  dueNext7Days: ['yedi gün içinde terminli', 'are due within seven days'], openWithoutTargetFinish: ['terminsiz ve açık', 'are open without a deadline'],
  doneWithoutActualFinish: ['gerçekleşen bitişi girilmeden tamamlanmış', 'were completed without an actual finish'],
  milestonesOpen: ['açık kilometre taşı', 'are open milestones']
});
const TOTAL_ADJECTIVES = Object.freeze({
  open: ['açık', 'open'], done: ['tamamlanmış', 'completed'], inProgress: ['devam eden', 'in-progress'], todo: ['yapılacak', 'to-do'],
  overdue: ['gecikmiş', 'overdue'], dueToday: ['bugün terminli', 'due-today'], dueNext7Days: ['yedi gün içinde terminli', 'due-within-seven-days'],
  openWithoutTargetFinish: ['terminsiz açık', 'undated open'], doneWithoutActualFinish: ['gerçekleşen bitişi eksik tamamlanmış', 'completed-without-actual-finish'],
  milestonesOpen: ['açık kilometre taşı', 'open-milestone']
});
const TOTAL_HEADS = new Set(['visibleTasks', 'totals', 'tasks']);
const PROJECT_COUNTS = Object.freeze({ wbsNodeCount: ['WBS düğümü', 'WBS nodes', 'WBS node'], dependencyCount: ['bağımlılık', 'dependencies', 'dependency'], tagCount: ['etiket', 'tags', 'tag'], baselineCount: ['baz plan', 'baselines', 'baseline'] });
const POSSESSIVE = Object.freeze({
  status: ['durumu', 'status'], statusLabel: ['durumu', 'status'], priority: ['önceliği', 'priority'], priorityLabel: ['önceliği', 'priority'],
  targetFinish: ['termini', 'deadline'], plannedStart: ['planlanan başlangıcı', 'planned start'], plannedFinish: ['planlanan bitişi', 'planned finish'],
  actualStart: ['gerçekleşen başlangıcı', 'actual start'], actualFinish: ['gerçekleşen bitişi', 'actual finish'], calendarDate: ['takvim tarihi', 'calendar date'],
  progressPercent: ['ilerlemesi', 'progress'], keyword: ['etiketi', 'label'], plannedDurationDays: ['planlanan süresi', 'planned duration'],
  remainingDurationDays: ['kalan süresi', 'remaining duration'], createdAt: ['oluşturulma zamanı', 'creation time'], updatedAt: ['son güncellenme zamanı', 'last update'],
  lead: ['lideri', 'lead'], sourceType: ['kaynağı', 'source'], source: ['kaynağı', 'source'], type: ['türü', 'type'], calendar: ['takvimi', 'calendar'],
  dataDate: ['veri tarihi', 'data date'], jobTitle: ['unvanı', 'job title']
});
const NOUNS = Object.freeze({
  rota_task_search: ['görev', 'tasks'], rota_task_analytics: ['görev', 'tasks'], rota_project_search: ['proje', 'projects'],
  rota_portfolio_summary: ['proje', 'projects'], rota_person_search: ['kişi', 'people'], rota_workload_summary: ['kişi', 'people'],
  rota_activity_search: ['hareket', 'events'], rota_schedule_requests: ['talep', 'requests'], rota_assignment_requests: ['kayıt', 'records'],
  rota_outlook_status: ['abonelik', 'subscriptions'], rota_wbs_inspect: ['düğüm', 'nodes']
});
const ROW_NOUNS = Object.freeze({ tasks: ['Görev', 'Task'], matches: ['Proje', 'Project'], projects: ['Proje', 'Project'], people: ['Kişi', 'Person'],
  groups: ['Grup', 'Group'], nodes: ['Düğüm', 'Node'], items: ['Kayıt', 'Record'], series: ['Seri', 'Series'], holidays: ['Tatil', 'Holiday'],
  mostSlipped: ['Görev', 'Task'], mostConnected: ['Görev', 'Task'], predecessors: ['Öncül', 'Predecessor'], successors: ['Ardıl', 'Successor'], checks: ['Denetim', 'Check'] });
const TASK_ROWS = new Set(['tasks', 'mostSlipped', 'mostConnected', 'predecessors', 'successors', 'candidates']);

const ONES = ['', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz'];
const TENS = ['', 'on', 'yirmi', 'otuz', 'kırk', 'elli', 'altmış', 'yetmiş', 'seksen', 'doksan'];

/** Sayının okunuşunun son sözcüğü (Türkçe ek uyumu için). */
function lastNumberWord(value) {
  if (value === 0) return 'sıfır';
  if (value % 10) return ONES[value % 10];
  if (value % 100) return TENS[Math.floor(value / 10) % 10];
  if (value % 1000) return 'yüz';
  if (value % 1e6) return 'bin';
  return value % 1e9 ? 'milyon' : 'milyar';
}

/** Sayıya gelen üçüncü tekil iyelik eki: 431'i, 486'sı, 36'sı, 3'ü, 40'ı. */
export function turkishPossessiveSuffix(value) {
  if (!Number.isSafeInteger(value) || value < 0) return '';
  const word = lastNumberWord(value);
  const vowel = [...word].reverse().find((char) => 'aeıioöuü'.includes(char));
  const harmony = { a: 'ı', ı: 'ı', e: 'i', i: 'i', o: 'u', u: 'u', ö: 'ü', ü: 'ü' }[vowel] || 'i';
  return `'${'aeıioöuü'.includes(word.at(-1)) ? 's' : ''}${harmony}`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;

function formatDay(value, locale) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'tr-TR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

function formatInstant(value, locale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'tr-TR', { timeZone: 'Europe/Istanbul', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

const leafOf = (path) => String(path).split('.').filter((part) => !/^\d+$/.test(part)).at(-1);
const language = (locale) => (locale === 'en' ? 1 : 0);
const strong = (text) => `**${text}**`;
const citation = (ids) => [...new Set(ids)].map((id) => `【${id}】`).join('');
const capitalize = (text) => (text ? `${text[0].toLocaleUpperCase('tr-TR')}${text.slice(1)}` : text);
const isCount = (fact) => typeof fact.value === 'number';
const englishTasks = (fact) => (fact.value === 1 ? 'task' : 'tasks');

const dayFact = (value) => (typeof value === 'string' && DAY.test(value) ? { field: 'data.range.from', value, semantic: { valueType: 'date' } } : null);

/** Olgunun Markdown'a güvenli gösterim değeri. Sunucunun biçimlediği sayı ve tarihler kaçış gerektirmez. */
export function narrativeValue(fact, locale = 'tr') {
  const raw = fact.value;
  if (fact.semantic?.valueType === 'date' && typeof raw === 'string' && DAY.test(raw) && fact.semantic?.displayValue == null) return formatDay(raw, locale);
  if (fact.semantic?.valueType === 'instant' && typeof raw === 'string' && INSTANT.test(raw)) return formatInstant(raw, locale);
  const { value } = factPresentation(fact, locale);
  if (typeof raw === 'number' && /Percent$/.test(leafOf(fact.field))) return locale === 'en' ? `${value}%` : `%${value}`;
  return typeof raw === 'number' || typeof raw === 'boolean' || raw === null ? value : escapedFactText(value);
}

function joinList(parts, locale) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} ${locale === 'en' ? 'and' : 've'} ${parts.at(-1)}`;
}

function labelOf(fact, locale) {
  const label = factLabel(fact.field, locale).split(' / ').at(-1);
  return fact.changeField ? `${factLabel(fact.changeField, locale)} / ${label}` : label;
}

/** Sayımın nüfusunu belirleyen ölçütler; özne olarak zaten yazılan seçici tekrar edilmez. */
function qualifierText(entries, locale, { omit = [] } = {}) {
  const owner = entries.find(({ fact }) => fact.semantic?.filters);
  if (!owner) return '';
  const parts = factPresentation(owner.fact, locale).qualifierParts.filter((part) => !omit.includes(part.key));
  const valueText = (value, key) => ['dateFrom', 'dateTo'].includes(key) && DAY.test(value) ? formatDay(value, locale) : escapedFactText(value);
  return parts.length ? ` (${locale === 'en' ? 'criteria' : 'ölçüt'}: ${parts.map((part) => `${part.label}: ${valueText(part.value, part.key)}`).join('; ')})` : '';
}

/* ── Kayıt (özet) paragrafı ───────────────────────────────── */

function totalsSentences(entries, { scope, locale, qualifiers }) {
  const lang = language(locale);
  const byKey = new Map(entries.map((entry) => [entry.key, entry.fact]));
  const total = [byKey.get('total'), byKey.get('tasks')].find((fact) => fact && isCount(fact));
  const parts = TOTAL_KEYS.filter((key) => byKey.has(key) && isCount(byKey.get(key)));
  const rate = byKey.get('completionRatePercent');
  const rateText = rate && isCount(rate) ? strong(narrativeValue(rate, locale)) : null;
  const sentences = [];
  const has = locale === 'en' && scope.startsWith('the ') ? 'has' : 'have';
  if (total) {
    sentences.push(locale === 'en' ? `${capitalize(scope)} ${has} ${strong(narrativeValue(total, locale))} ${englishTasks(total)} in total${qualifiers}.`
      : `${capitalize(scope)} toplam ${strong(narrativeValue(total, locale))} görev bulunuyor${qualifiers}.`);
    if (parts.length) {
      const clauses = parts.map((key) => (locale === 'en' ? `${strong(narrativeValue(byKey.get(key), locale))} ${TOTAL_PREDICATES[key][1]}`
        : `${strong(narrativeValue(byKey.get(key), locale))}${turkishPossessiveSuffix(byKey.get(key).value)} ${TOTAL_PREDICATES[key][0]}`));
      const rateClause = rateText ? (locale === 'en' ? `; the completion rate is ${rateText}` : `; tamamlanma oranı ${rateText}`) : '';
      sentences.push(`${locale === 'en' ? 'Of these, ' : 'Bunların '}${joinList(clauses, locale)}${rateClause}.`);
    } else if (rateText) sentences.push(locale === 'en' ? `The completion rate is ${rateText}.` : `Tamamlanma oranı ${rateText}.`);
  } else if (parts.length) {
    const phrases = parts.map((key) => `${strong(narrativeValue(byKey.get(key), locale))} ${TOTAL_ADJECTIVES[key][lang]}`);
    sentences.push(locale === 'en' ? `${capitalize(scope)} ${has} ${joinList(phrases, locale)} tasks${qualifiers}.`
      : `${capitalize(scope)} ${joinList(phrases, locale)} görev bulunuyor${qualifiers}.`);
    if (rateText) sentences.push(locale === 'en' ? `The completion rate is ${rateText}.` : `Tamamlanma oranı ${rateText}.`);
  } else if (rateText) {
    sentences.push(locale === 'en' ? `The completion rate is ${rateText}${qualifiers}.` : `Tamamlanma oranı ${rateText}${qualifiers}.`);
  }
  // Bilinmeyen (null) sayılar sıfır gibi yazılmaz.
  for (const entry of entries.filter(({ fact }) => !isCount(fact))) sentences.push(`${capitalize(labelOf(entry.fact, locale))}: ${narrativeValue(entry.fact, locale)}.`);
  return sentences;
}

function scopePhrase(record, locale, { named = false, projects = null } = {}) {
  const name = strong(escapedFactText(record.subject));
  if (record.tool === 'rota_portfolio_summary') {
    if (projects) return locale === 'en' ? `your ${strong(narrativeValue(projects, locale))} visible projects` : `görebildiğiniz ${strong(narrativeValue(projects, locale))} projede`;
    return locale === 'en' ? 'your visible projects' : 'görebildiğiniz projelerde';
  }
  if (record.kind === 'project' || record.entries.some(({ fact }) => fact.semantic?.filters?.projectId)) {
    if (named) return locale === 'en' ? 'the project' : 'projede';
    return locale === 'en' ? `the ${name} project` : `${name} projesinde`;
  }
  if (record.kind === 'person') return locale === 'en' ? `${name}` : `${name} için`;
  if (record.kind === 'group') return locale === 'en' ? `the ${name} group` : `${name} grubunda`;
  return locale === 'en' ? 'your visible tasks' : 'görebildiğiniz görevler arasında';
}

/** Bir kaydın (ya da tek satırın) olgularından düzyazı cümleleri. */
function recordSentences(record, locale) {
  const lang = language(locale);
  const used = new Set();
  const take = (predicate) => record.entries.filter((entry) => !used.has(entry) && predicate(entry.rel, entry.fact)).map((entry) => { used.add(entry); return entry; });
  const sentences = [];
  const nameEntry = take((rel) => ['title', 'name'].includes(rel))[0];
  const codeEntry = take((rel) => rel === 'code')[0];
  const subjectText = record.row ? escapedFactText(record.subject) : nameEntry ? narrativeValue(nameEntry.fact, locale) : escapedFactText(record.subject);
  const subject = `${strong(subjectText)}${codeEntry ? ` (${narrativeValue(codeEntry.fact, locale)})` : ''}`;
  const qualifiers = qualifierText(record.entries, locale);
  // Proje adı zaten özne olarak yazıldığında ölçütte yinelenmez.
  const unnamedProjectQualifiers = qualifierText(record.entries, locale, { omit: ['project'] });
  let qualified = false;
  const qualify = (projectNamed = false) => { if (qualified) return ''; qualified = true; return projectNamed ? unnamedProjectQualifiers : qualifiers; };

  const projectEntry = take((rel) => record.kind === 'task' && rel === 'project.name')[0];
  take((rel) => record.kind === 'task' && rel === 'project.code');
  const identity = take((rel) => Object.hasOwn(POSSESSIVE, rel) || (/^dates\./.test(rel) && Object.hasOwn(POSSESSIVE, rel.slice(6))));
  const shownIdentity = identity.filter(({ rel }) => !/Label$/.test(rel) || !identity.some((other) => other.rel === rel.replace(/Label$/, '')));
  if (shownIdentity.length) {
    const pairs = shownIdentity.map(({ fact }) => `${POSSESSIVE[leafOf(fact.field)][lang]} ${strong(narrativeValue(fact, locale))}`);
    const projectName = projectEntry ? strong(narrativeValue(projectEntry.fact, locale)) : null;
    if (locale === 'en') {
      const noun = { task: ' task', project: ' project', person: '' }[record.kind] ?? '';
      sentences.push(`${projectName ? `The ${subject} task in the ${projectName} project` : `The ${subject}${noun}`} has ${joinList(pairs, locale)}${qualify()}.`);
    } else {
      const noun = { task: ' görevinin', project: ' projesinin', person: ' kişisinin' }[record.kind] ?? ' için';
      sentences.push(`${projectName ? `${projectName} projesindeki ${subject} görevinin` : `${subject}${noun}`} ${joinList(pairs, locale)}${qualify()}.`);
    }
  } else if (projectEntry) {
    sentences.push(locale === 'en' ? `The ${subject} task belongs to the ${strong(narrativeValue(projectEntry.fact, locale))} project.`
      : `${subject} görevi ${strong(narrativeValue(projectEntry.fact, locale))} projesindedir.`);
  }

  const overdue = take((rel, fact) => rel === 'overdueDays' && isCount(fact))[0];
  if (overdue) sentences.push(locale === 'en' ? `It is ${strong(narrativeValue(overdue.fact, locale))} days overdue.` : `Görev ${strong(narrativeValue(overdue.fact, locale))} gündür gecikmiş.`);

  const totals = take((rel, fact) => {
    const parts = rel.split('.');
    const key = parts.at(-1);
    const totalKey = TOTAL_KEYS.includes(key) || key === 'total' || key === 'completionRatePercent' || (parts[0] === 'totals' && key === 'tasks');
    return totalKey && (isCount(fact) || fact.value === null) && (parts.length === 1 ? record.kind !== 'person' : parts.length === 2 && TOTAL_HEADS.has(parts[0]));
  }).map(({ rel, fact }) => ({ key: rel.split('.').at(-1), fact }));
  const projectCount = totals.length ? take((rel, fact) => rel === 'totals.projects' && isCount(fact))[0] : null;
  if (totals.length) {
    const projectNamed = record.kind === 'project' || record.entries.some(({ fact }) => fact.semantic?.filters?.projectId);
    sentences.push(...totalsSentences(totals, { scope: scopePhrase(record, locale, { named: sentences.length > 0, projects: projectCount?.fact }), locale, qualifiers: qualify(projectNamed) }));
  }

  for (const { fact } of take((rel) => rel === 'totals.projects' || rel === 'totals.projectsWithOverdue')) {
    sentences.push(leafOf(fact.field) === 'projects'
      ? (locale === 'en' ? `You can see ${strong(narrativeValue(fact, locale))} projects${qualify()}.` : `Görebildiğiniz proje sayısı ${strong(narrativeValue(fact, locale))}${qualify()}.`)
      : (locale === 'en' ? `${strong(narrativeValue(fact, locale))} projects have overdue tasks.` : `Gecikmiş görevi olan proje sayısı ${strong(narrativeValue(fact, locale))}.`));
  }
  const counts = take((rel, fact) => Object.hasOwn(PROJECT_COUNTS, rel) && isCount(fact));
  if (counts.length) {
    const phrases = counts.map(({ fact }) => `${strong(narrativeValue(fact, locale))} ${PROJECT_COUNTS[leafOf(fact.field)][locale === 'en' && fact.value === 1 ? 2 : lang]}`);
    const also = totals.length ? (locale === 'en' ? ' also' : ' ayrıca') : '';
    sentences.push(locale === 'en' ? `The project${also} has ${joinList(phrases, locale)}.` : `Projede${also} ${joinList(phrases, locale)} bulunuyor.`);
  }

  const days = take((rel, fact) => rel === 'workingDayCount' && isCount(fact))[0];
  if (days) {
    // İş günü sayısı her zaman tarih penceresiyle yazılır: pencere seçilmese de kanıttaki seçicidir.
    const from = take((rel) => rel === 'range.from')[0]?.fact || dayFact(days.fact.semantic?.filters?.dateFrom);
    const to = take((rel) => rel === 'range.to')[0]?.fact || dayFact(days.fact.semantic?.filters?.dateTo);
    const window = from && to ? (locale === 'en' ? `Between ${strong(narrativeValue(from, locale))} and ${strong(narrativeValue(to, locale))} there` : `${strong(narrativeValue(from, locale))} – ${strong(narrativeValue(to, locale))} aralığında`) : null;
    if (window) qualified = true;
    sentences.push(window
      ? (locale === 'en' ? `${window} are ${strong(narrativeValue(days.fact, locale))} working days${qualifierText(record.entries, locale, { omit: ['dateFrom', 'dateTo'] })}.` : `${window} ${strong(narrativeValue(days.fact, locale))} çalışma günü bulunuyor${qualifierText(record.entries, locale, { omit: ['dateFrom', 'dateTo'] })}.`)
      : `${capitalize(labelOf(days.fact, locale))}: ${strong(narrativeValue(days.fact, locale))}.`);
  }
  for (const { rel, fact } of take((rel, fact) => ['unreadCount', 'actionRequiredCount'].includes(rel) && isCount(fact))) {
    sentences.push(rel === 'unreadCount'
      ? (locale === 'en' ? `You have ${strong(narrativeValue(fact, locale))} unread notifications.` : `${strong(narrativeValue(fact, locale))} okunmamış bildiriminiz var.`)
      : (locale === 'en' ? `${strong(narrativeValue(fact, locale))} records require your action.` : `İşleminizi bekleyen ${strong(narrativeValue(fact, locale))} kayıt var.`));
  }

  // Sunucuya ait ölçü tanımları ayrı, vurgusuz cümlelerdir.
  for (const { rel, fact } of take((rel) => rel.startsWith('definitions.'))) {
    const label = capitalize(labelOf(fact, locale));
    sentences.push(rel === 'definitions.today' ? `${label}: ${strong(narrativeValue(fact, locale))}.` : `_${label}_: ${narrativeValue(fact, locale)}`);
  }

  const access = take((rel) => rel.startsWith('access.'));
  if (access.length) {
    const level = access.find(({ rel }) => rel === 'access.level');
    const reasons = access.filter(({ rel }) => /^access\.reasons\.\d+$/.test(rel));
    const parts = [];
    if (level) parts.push(locale === 'en' ? `your access level is ${strong(narrativeValue(level.fact, locale))}` : `erişim düzeyiniz ${strong(narrativeValue(level.fact, locale))}`);
    if (reasons.length) parts.push(`${locale === 'en' ? 'access reason' : 'erişim nedeni'}: ${reasons.map(({ fact }) => strong(narrativeValue(fact, locale))).join(', ')}`);
    for (const { fact } of access.filter((entry) => entry !== level && !reasons.includes(entry))) parts.push(`${labelOf(fact, locale)}: ${strong(narrativeValue(fact, locale))}`);
    sentences.push(`${capitalize(parts.join('; '))}.`);
  }

  // Çok değerli alanlar (sorumlular, WBS yolu, etiketler).
  const multi = new Map();
  for (const entry of take((rel) => /\.\d+(\.|$)/.test(rel))) {
    const key = entry.rel.replace(/\.\d+(?=\.|$)/g, '.*');
    if (!multi.has(key)) multi.set(key, []);
    multi.get(key).push(entry.fact);
  }
  for (const [key, facts] of multi) {
    const title = key.startsWith('assignees.') ? (locale === 'en' ? 'Assignees' : 'Sorumlular') : capitalize(labelOf(facts[0], locale));
    sentences.push(`${title}: ${facts.map((fact) => strong(narrativeValue(fact, locale))).join(key === 'wbsPath.*' ? ' › ' : ', ')}.`);
  }

  const rest = record.entries.filter((entry) => !used.has(entry));
  if (rest.length) {
    const pairs = rest.map(({ fact }) => `${labelOf(fact, locale)}: ${strong(narrativeValue(fact, locale))}`);
    // Satır kaydı her zaman satırını adlandırır: komşu satırın ölçüsü onunla karışmaz.
    const lead = sentences.length || (!nameEntry && !record.row && (record.anonymous || record.kind === 'generic')) ? '' : `${subject}${qualify()} — `;
    sentences.push(`${lead}${capitalize(pairs.join('; '))}${qualify()}.`);
  } else if (!sentences.length && nameEntry) {
    sentences.push(`${subject}${qualify()}.`);
  }
  return sentences;
}

/* ── Satır listeleri ve tablolar ──────────────────────────── */

function rowParts(field) {
  const parts = field.split('.');
  const index = parts.findIndex((part, position) => position > 0 && /^\d+$/.test(part));
  if (index < 0 || index === parts.length - 1) return null;
  return { collection: parts.slice(0, index).join('.'), row: parts.slice(0, index + 1).join('.'), rel: parts.slice(index + 1).join('.') };
}

function rowKind(collection, tool) {
  const name = collection.split('.').at(-1);
  if (TASK_ROWS.has(name) && tool !== 'rota_person_search') return 'task';
  if (name === 'matches' || name === 'projects') return 'project';
  if (name === 'people') return 'person';
  if (name === 'groups') return 'group';
  return 'generic';
}

const ROW_TITLES = Object.freeze(['title', 'name', 'task.title', 'person.name', 'label']);

function renderRows(collection, rows, { evidenceId, locale, layout }) {
  const pattern = (rel) => rel.replace(/\.\d+(?=\.|$)/g, '.*');
  const titleKey = ROW_TITLES.find((key) => rows.every((row) => row.entries.some(({ rel }) => rel === key)));
  const columns = [];
  for (const row of rows) for (const { rel } of row.entries) if (rel !== titleKey && !['title', 'name'].includes(rel) && !columns.includes(pattern(rel))) columns.push(pattern(rel));
  const lang = language(locale);
  const valuesOf = (row, key) => row.entries.filter(({ rel }) => pattern(rel) === key).map(({ fact }) => fact);
  const columnLabel = (key) => {
    const sample = rows.flatMap((row) => valuesOf(row, key))[0];
    if (!sample) return key;
    const labels = factLabel(sample.field, locale).split(' / ');
    if (key.startsWith('project.') && labels.length > 1) return `${labels.at(-2)} ${labels.at(-1).toLocaleLowerCase(locale === 'en' ? 'en-US' : 'tr-TR')}`;
    return labelOf(sample, locale);
  };
  const titleOf = (row) => {
    const context = row.entries[0]?.fact.semantic?.row;
    const names = titleKey ? valuesOf(row, titleKey) : [];
    const project = context?.project ? ` · ${escapedFactText([context.projectCode, context.project].filter(Boolean).join(' · '))}` : '';
    const organization = context?.organization ? ` · ${escapedFactText(context.organization)}` : '';
    return `${escapedFactText(context?.name || names[0] && names.map((fact) => fact.value).join(', ') || row.subject)}${project}${organization}${qualifierText(row.entries, locale, { omit: context?.project ? ['project'] : [] })}`;
  };
  const cell = (facts, plain) => facts.map((fact) => (plain ? narrativeValue(fact, locale) : strong(narrativeValue(fact, locale)))).join(facts[0]?.field.includes('wbsPath') ? ' › ' : ', ');
  // Karşılaştırma doğal olduğunda (en az üç satır; üç sütun ya da iki sayısal sütun) tablo; aksi hâlde liste.
  const numericColumns = columns.filter((key) => rows.every((row) => valuesOf(row, key).every(isCount)));
  const table = columns.length >= 1 && (layout === 'table' || (layout !== 'list' && rows.length >= 3 && (columns.length >= 3 || numericColumns.length >= 2)));
  if (table) {
    const head = ROW_NOUNS[collection.split('.').at(-1)]?.[lang] || (locale === 'en' ? 'Record' : 'Kayıt');
    const headers = [head, ...columns.map((key) => columnLabel(key).replace(/\|/g, '/'))];
    // Sayı sütunları sağa yaslanır: değerler basamak hizasında okunur.
    const lines = [`| ${headers.join(' | ')} |`, `| ${['---', ...columns.map((key) => (numericColumns.includes(key) ? '---:' : '---'))].join(' | ')} |`];
    for (const row of rows) lines.push(`| ${[titleOf(row), ...columns.map((key) => { const facts = valuesOf(row, key); return facts.length ? cell(facts, true) : '—'; })].join(' | ')} |`);
    return `${lines.join('\n')}\n\n_${locale === 'en' ? 'Source' : 'Kaynak'}:_ ${citation([evidenceId])}`;
  }
  return rows.map((row) => {
    const pairs = columns.map((key) => { const facts = valuesOf(row, key); return facts.length ? `${columnLabel(key)}: ${cell(facts, false)}` : null; }).filter(Boolean);
    return `- ${strong(titleOf(row))}${pairs.length ? ` — ${pairs.join(' · ')}` : ''} ${citation([evidenceId])}`;
  }).join('\n');
}

/* ── Zarf sayıları ────────────────────────────────────────── */

function envelopeSentences(facts, { tool, locale }) {
  const noun = NOUNS[tool]?.[language(locale)] || (locale === 'en' ? 'records' : 'kayıt');
  const sentences = [];
  for (const fact of facts) {
    // Proje süzgeci sayımın öznesidir: sayı projesinden ayrı yazılmaz.
    const project = fact.semantic?.filters?.projectId && fact.subject && fact.subject !== 'Rota' ? strong(escapedFactText(fact.subject)) : null;
    const qualifiers = qualifierText([{ fact }], locale, { omit: project ? ['project'] : [] });
    if (fact.field === 'totalCount') {
      const where = project ? (locale === 'en' ? ` in the ${project} project` : `${project} projesinde `) : '';
      sentences.push(fact.value === null
        ? (locale === 'en' ? `The exact number of matching ${noun}${where} is unknown${qualifiers}.` : `${capitalize(`${where}eşleşen ${noun} sayısı kesin olarak bilinmiyor`)}${qualifiers}.`)
        : (locale === 'en' ? `${strong(narrativeValue(fact, locale))} matching ${noun} were found${where}${qualifiers}.` : `${capitalize(`${where}eşleşen ${strong(narrativeValue(fact, locale))} ${noun} bulundu`)}${qualifiers}.`));
    } else if (fact.field === 'returnedCount') {
      sentences.push(locale === 'en' ? `${strong(narrativeValue(fact, locale))} of them are shown.` : `Bunlardan ${strong(narrativeValue(fact, locale))}${turkishPossessiveSuffix(fact.value)} gösteriliyor.`);
    } else if (fact.field === 'complete') {
      sentences.push(fact.value ? (locale === 'en' ? 'The result is complete.' : 'Sonuç tamdır.') : (locale === 'en' ? 'The result is incomplete.' : 'Sonuç eksiktir.'));
    } else if (fact.field === 'truncated') {
      sentences.push(fact.value ? (locale === 'en' ? 'The result was shortened.' : 'Sonuç kısaltılmıştır.') : (locale === 'en' ? 'The result was not shortened.' : 'Sonuç kısaltılmamıştır.'));
    }
  }
  return sentences;
}

/* ── Aday açıklaması ──────────────────────────────────────── */

function candidateLine(candidate, locale) {
  const text = (value) => (typeof value === 'string' && value.trim() ? escapedFactText(value.trim()) : null);
  if (candidate.taskId) {
    const project = [text(candidate.project?.name), candidate.project?.code ? `(${text(candidate.project.code)})` : null].filter(Boolean).join(' ');
    const status = text(candidate.statusLabel);
    const due = typeof candidate.targetFinish === 'string' && DAY.test(candidate.targetFinish) ? `${locale === 'en' ? 'deadline' : 'termin'} ${formatDay(candidate.targetFinish, locale)}` : null;
    return [strong(text(candidate.title) || '—'), [project, status, due].filter(Boolean).join(' · ')];
  }
  if (candidate.projectId) {
    const name = `${strong(text(candidate.name) || '—')}${candidate.code ? ` (${text(candidate.code)})` : ''}`;
    return [name, [text(candidate.source), text(candidate.access?.label)].filter(Boolean).join(' · ')];
  }
  const organization = [candidate.organization?.unit, candidate.organization?.department, candidate.organization?.directorate].map(text).filter(Boolean).join(' / ');
  return [strong(text(candidate.name) || '—'), [text(candidate.jobTitle), organization].filter(Boolean).join(' · ')];
}

/**
 * Sunucunun tuttuğu aday kümesinin numaralı açıklaması. Model aday seçemez ya
 * da atamaz: kümenin tamamı (en fazla on) aynı sırayla gösterilir.
 */
export function renderClarification({ evidenceId, candidates, truncated = false, confirmation = false, locale = 'tr' }) {
  const rows = candidates.map((candidate, index) => {
    const [head, detail] = candidateLine(candidate, locale);
    return `${index + 1}. ${head}${detail ? ` — ${detail}` : ''} ${citation([evidenceId])}`;
  });
  const question = confirmation
    ? (locale === 'en' ? 'Did you mean this record? Reply **1** to confirm.' : 'Bunu mu kastettiniz? Onaylamak için **1** yazın.')
    : (locale === 'en' ? 'Which candidate did you mean? Reply with its number (for example **1**).' : 'Hangi adayı kastediyorsunuz? Numarasını yazarak seçebilirsiniz (ör. **1**).');
  const more = truncated ? (locale === 'en'
    ? `\n\n_Only the first ${candidates.length} candidates are shown; if the record you mean is missing, type a more specific name._`
    : `\n\n_Yalnızca ilk ${candidates.length} aday gösteriliyor; aradığınız kayıt listede yoksa adı daha ayrıntılı yazın._`) : '';
  return `${rows.join('\n')}\n\n${question}${more}`;
}

/** Yanıt düzeni: model önerisi ya da kullanıcının açık isteği; yoksa olguların biçimi belirler. */
function layoutFrom(requested, userText) {
  if (['prose', 'list', 'table'].includes(requested)) return requested;
  const text = String(userText || '').toLocaleLowerCase('tr-TR');
  if (/tablo|\btable\b|karşılaştır|\bcompare/u.test(text)) return 'table';
  if (/listele|\bliste|\blist\b|hangileri/u.test(text)) return 'list';
  return 'auto';
}

/** Kaydın varlık kökü: görev ayrıntısında `data.task`, proje künyesinde `data.project` ve eşlikçileri. */
function recordRelative(tool, field) {
  const rel = field.replace(/^data\./, '');
  if (tool === 'rota_task_detail' && rel.startsWith('task.')) return { kind: 'task', rel: rel.slice(5) };
  if (tool === 'rota_project_detail' && rel.startsWith('project.')) return { kind: 'project', rel: rel.slice(8) };
  if (tool === 'rota_project_detail') return { kind: 'project', rel };
  if (/^task\./.test(rel)) return { kind: 'task', rel: rel.slice(5) };
  return { kind: 'generic', rel };
}

/**
 * Doğrulanmış olgu seçimini Markdown anlatıma dönüştürür.
 * @param {{ evidenceId: string, fact: object }[]} items Sunucunun doğruladığı olgular (seçim sırasıyla).
 */
export function renderVerifiedNarrative(items, { locale = 'tr', layout = 'auto', userText = '' } = {}) {
  const chosenLayout = layoutFrom(layout, userText);
  const byEvidence = new Map();
  for (const item of items) {
    if (!byEvidence.has(item.evidenceId)) byEvidence.set(item.evidenceId, []);
    byEvidence.get(item.evidenceId).push(item.fact);
  }
  const blocks = [];
  for (const [evidenceId, facts] of byEvidence) {
    const tool = facts[0]?.semantic?.provenance?.tool || null;
    const envelope = facts.filter((fact) => ENVELOPE_FIELDS.has(fact.field));
    const collections = new Map();
    const main = { tool, kind: 'generic', subject: null, entries: [], anonymous: false };
    for (const fact of facts) {
      if (ENVELOPE_FIELDS.has(fact.field)) continue;
      const parts = rowParts(fact.field);
      // Varlık kaydının içindeki diziler (sorumlular, etiketler) kaydın çok değerli alanıdır.
      if (parts && !/^data\.(task|project)\./.test(parts.collection)) {
        if (!collections.has(parts.collection)) collections.set(parts.collection, new Map());
        const rows = collections.get(parts.collection);
        if (!rows.has(parts.row)) rows.set(parts.row, { subject: fact.semantic?.row?.name || fact.subject, entries: [] });
        rows.get(parts.row).entries.push({ rel: parts.rel, fact });
        continue;
      }
      const { kind, rel } = recordRelative(tool, fact.field);
      if (main.kind === 'generic') main.kind = kind;
      main.subject ??= fact.subject;
      main.entries.push({ rel, fact });
    }
    main.anonymous = !main.subject || main.subject === 'Rota';
    const sentences = [];
    if (main.entries.length) sentences.push(...recordSentences(main, locale));
    // Tek satırlık koleksiyon bir kayıttır; çok satırlı koleksiyon liste ya da tablodur.
    const lists = [];
    for (const [collection, rows] of collections) {
      if (rows.size === 1) {
        const [row] = rows.values();
        sentences.push(...recordSentences({ tool, kind: rowKind(collection, tool), subject: row.subject, entries: row.entries, anonymous: false, row: true }, locale));
      } else {
        lists.push(renderRows(collection, [...rows.values()], { evidenceId, locale, layout: chosenLayout === 'prose' ? 'list' : chosenLayout }));
      }
    }
    sentences.push(...envelopeSentences(envelope, { tool, locale }));
    if (sentences.length) blocks.push(`${sentences.join(' ')} ${citation([evidenceId])}`);
    blocks.push(...lists);
  }
  return blocks.join('\n\n');
}
