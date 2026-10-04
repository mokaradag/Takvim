function words(value) {
  return String(value || '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const OPEN_METRIC = /openTaskCount|openTasks|(?:totals|visibleTasks)\.open$/i;
const METRICS = Object.freeze([
  [/\b(gecik\w*|overdue)\b/u, /overdue/i],
  [/\b(tamamlanmis\w*|tamamlandi|tamamlanan\w*|completed|completion|done)\b/u, /done|completed|completion/i],
  [/\bdevam eden\b|\bin progress\b/u, /inProgress|in_progress/i],
  [/\b(acik|tamamlanmamis\w*|open|unfinished)\b/u, OPEN_METRIC],
  [/\b(ilerleme|progress)\b/u, /progress|completionRate/i],
  [/\b(basli\w*|title)\b/u, /title$/i],
  [/\b(sorumlu\w*|assignee\w*)\b/u, /assignee|unassigned/i],
  [/\b(butce\w*|budget)\b/u, /budget/i],
  [/\b(harcama\w*|harcan\w*|spent|spending)\b/u, /spent/i],
  [/\b(saat\w*|hours?)\b/u, /hours/i],
  [/\b(varyans\w*|variance|sapma\w*)\b/u, /variance|delta|slip/i],
  [/\b(bagimlilik\w*|dependencies|dependency)\b/u, /dependency|predecessor|successor|edge|cycle|level/i],
  [/\b(tekrarlan\w*|tekrarli\w*|yinelem\w*|recurrence|recurring)\b|\btekrar eden\b/u, /series|occurrence|recurrence|rule|next|remaining|done/i],
  [/\b(takvim\w*|calendar)\b/u, /calendar|working|workWeek|exception|range|date|timeZone/i],
  [/\b(termin\w*|deadline\w*|target)\b/u, /targetFinish|calendarDate|overdue|due|target/i],
  [/\b(bitis\w*|finish)\b/u, /Finish|finish|delta/i],
  [/\b(baslangic\w*|start)\b/u, /Start|start/i],
  [/\b(aciklama\w*|description|notu|note)\b/u, /description|message|change/i],
  [/\b(oncelik\w*|priority)\b/u, /priority/i]
]);
const COUNT = /\b(kac|sayisi|sayisini|sayilar|sayilari|number|count|many)\b/u;
const SUMMARY = /\b(ozet\w*|summary|summarize|overview|incele\w*|degerlendir\w*)\b/u;
const OVERVIEW = /\b(ozet\w*|incele\w*|degerlendir\w*|goster\w*|liste\w*|gorev\w*|acikla\w*|summary|summarize|overview|show|list|table|tablo|history|gecmis\w*|talep\w*|request\w*|notification\w*|bildirim\w*|is yuk\w*|workload|kalite\w*|quality)\b/u;
const CONTEXT = /(?:^|\.)(?:title|name|label|code|project|person|statusLabel|priorityLabel)$/;
const META = new Set(['complete', 'truncated', 'returnedCount', 'totalCount']);

function matchesMetric(fact, patterns, count, returned = false) {
  const path = fact.field;
  const filters = fact.semantic?.filters || {};
  const statuses = filters.statuses || [];
  const filterMatches = (pattern) => pattern === OPEN_METRIC
    ? statuses.length === 2 && statuses.includes('todo') && statuses.includes('in_progress')
    : pattern.test(filters.deadline || '') || pattern.test(filters.assignee || '')
      || (statuses.length > 0 && statuses.every((status) => pattern.test(status)));
  if (path === 'returnedCount') return count && returned && (!patterns.length || patterns.some(filterMatches));
  const total = /^(totalCount|data\.(totals\.(total|tasks|projects)|visibleTasks\.total))$/.test(path);
  if (count && !patterns.length) return total && (typeof fact.value === 'number' || fact.value === null);
  const counted = (typeof fact.value === 'number' || fact.value === null) && /count|total|tasks|people|projects|occurrences|series|overdue|done|todo|inProgress/i.test(path);
  if (patterns.some((pattern) => pattern.test(path) || pattern.test(fact.changeField || ''))) return !count || counted;
  return count && counted && total && patterns.some(filterMatches);
}

function rowsMatchIntent(facts, text, evidencePayloads, list) {
  const envelopes = new Map(evidencePayloads.map((entry) => {
    try { return [entry.id, JSON.parse(entry.payload)]; } catch { return [entry.id, null]; }
  }));
  const selected = new Map();
  for (const { evidenceId, fact } of facts) {
    const path = fact.semantic?.row?.path;
    if (!path) continue;
    const collection = path.replace(/\.\d+$/, '');
    if (!/^data\.(tasks|matches|people|nodes|items)$/.test(collection)) continue;
    const key = `${evidenceId}:${collection}`;
    if (!selected.has(key)) selected.set(key, { evidenceId, collection, paths: new Set() });
    selected.get(key).paths.add(path);
  }
  for (const { evidenceId, collection, paths } of selected.values()) {
    const rows = collection.slice(5).split('.').reduce((value, key) => value?.[key], envelopes.get(evidenceId)?.data);
    if (!Array.isArray(rows)) return false;
    const matches = rows.map((row, index) => ({ name: words(row.title || row.name || row.task?.title || row.person?.name), index }))
      .filter(({ name }) => name && (` ${text} `).includes(` ${name} `)).map(({ index }) => index);
    const first = /\b(ilk|first)\b/u.test(text);
    const last = /\b(son|last)\b/u.test(text);
    if (first && last) return false;
    const requested = matches.length ? matches : first ? [0] : last ? [rows.length - 1] : null;
    if (requested && [...paths].some((path) => !requested.includes(Number(path.split('.').at(-1))))) return false;
    if (list) {
      const expected = requested || rows.map((_, index) => index);
      if (expected.some((index) => !paths.has(`${collection}.${index}`))) return false;
    }
  }
  if (list && !selected.size) {
    for (const { evidenceId } of facts) {
      const data = envelopes.get(evidenceId)?.data;
      if (data && ['tasks', 'matches', 'people', 'nodes', 'items'].some((key) => Array.isArray(data[key]) && data[key].length)) return false;
    }
  }
  return true;
}

export function factsMatchUserIntent(facts, userText, evidencePayloads = []) {
  if (!userText) return true;
  const text = words(userText);
  const patterns = METRICS.filter(([request]) => request.test(text)).map(([, metric]) => metric);
  const count = COUNT.test(text);
  const returned = count && /\b(dondur\w*|returned|return\w*|shown|gosterilen|listelenen)\b/u.test(text);
  const quantity = /\b(?:kac|how many|number of|count of) (?:(?:gecik\w*|overdue|tamamlan\w*|completed|acik|open|bekleyen|pending|devam eden|in progress) )*(gorev\w*|tasks?|is|kisi\w*|people|persons?|proje\w*|projects?|gun\w*|days?|saat\w*|hours?)\b/u.exec(text)?.[1] || '';
  const requestedUnit = /^(gorev|task|is)/.test(quantity) ? 'tasks' : /^(kisi|person|people)/.test(quantity) ? 'people'
    : /^(proje|project)/.test(quantity) ? 'projects' : /^(gun|day)/.test(quantity) ? 'days' : /^(saat|hour)/.test(quantity) ? 'hours' : null;
  const list = /\b(liste\w*|list|table|tablo)\b/u.test(text);
  if (/\b(status|durumu|durumunu|durumda)\b/u.test(text) && !patterns.length) patterns.push(/status|total|done|inProgress|todo|openTaskCount/i);
  if (/\b(adi|adini|name)\b/u.test(text) && !patterns.length) patterns.push(/name|title/i);
  const identities = String(userText).toLowerCase().match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/g) || [];
  if (!rowsMatchIntent(facts, text, evidencePayloads, list)) return false;
  const overview = SUMMARY.test(text);
  const substantive = facts.filter(({ fact }) => !META.has(fact.field));
  if (!substantive.length && !count && !overview && !OVERVIEW.test(text)) return false;
  for (const { fact } of facts) {
    const selectors = [fact.semantic?.entity?.id, fact.semantic?.filters?.projectId, fact.semantic?.filters?.taskId,
      fact.semantic?.row?.identity].filter((value) => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value));
    if (identities.length && selectors.length && !selectors.some((id) => identities.includes(id.toLowerCase()))) return false;
    if (list && /\b(gecik\w*|overdue)\b/u.test(text) && fact.semantic?.row && fact.semantic?.filters?.deadline !== 'overdue') return false;
    if (['complete', 'truncated'].includes(fact.field)) continue;
    if (count && requestedUnit && (fact.semantic?.countUnit || fact.semantic?.unit) && (fact.semantic.countUnit || fact.semantic.unit) !== requestedUnit && !CONTEXT.test(fact.field)) return false;
    if (fact.field === 'returnedCount' && !returned) continue;
    if (!overview && (patterns.length || count) && !(list && !count) && !CONTEXT.test(fact.field) && !matchesMetric(fact, patterns, count, returned)) return false;
    if (!patterns.length && !count && !OVERVIEW.test(text) && !/outlook/i.test(text)) return false;
  }
  if (!overview && !list && (patterns.length || count) && !facts.some(({ fact }) => matchesMetric(fact, patterns, count, returned))) return false;
  return substantive.length > 0 || ((count || overview || OVERVIEW.test(text)) && facts.some(({ fact }) => ['totalCount', 'returnedCount'].includes(fact.field)));
}
