import 'server-only';
import { METRIC_DEFINITIONS } from '../../../../domain/ai/metricDefinitions.js';
import { canonicalActualId } from '../../../../domain/identity/actualId.js';
import { countWorkingDays } from '../../../../scheduling/calendars/index.js';
import { describeRecurrenceRule } from '../../../../scheduling/recurrence/index.js';
import { TOOL_LIMITS } from '../toolLimits.js';
import { TOOL_ERROR_CODES, ToolError } from '../toolErrors.js';
import { describeTaskScope, projectAccess } from './rotaScope.js';
import { readBaseline, readCalendar, readDependencies, readTaskFacts } from './rotaToolStore.js';
import {
  DATE_PROPERTY,
  dataText,
  fullAccessRequired,
  ID_PROPERTY,
  LIMIT_PROPERTY,
  notFound,
  projectIndex,
  referenceScope,
  requireFullProject,
  requireVisibleProject
} from './rotaToolSupport.js';
import {
  addDays,
  daysBetween,
  isOverdue,
  sqlDay,
  sqlInstant,
  statusLabelOf,
  taskStatus
} from './taskFacts.js';

const factPopulation = (facts) => facts.map((fact) => ({ taskId: fact.id, projectId: fact.projectId }));

/** Görünür tek görevin olgusu; görünmüyorsa "bulunamadı". */
async function visibleTask(call, scope, taskId) {
  const result = await call.sql((executor) => readTaskFacts(executor, scope, { taskIds: [taskId], maxRows: 1 }));
  const fact = result.facts[0];
  if (!fact) throw notFound();
  return { fact, projects: projectIndex(result.projects) };
}

/* ── rota_baseline_compare ────────────────────────────────── */

const baselineCompare = {
  name: 'rota_baseline_compare',
  version: 1,
  topic: 'baseline',
  evidenceKind: 'baseline',
  authorization: 'Baz planlar yalnızca projede FULL erişimi olan kullanıcılara açıktır (anlık görüntüyle aynı).',
  description: 'Projenin baz planı (referans plan) ile güncel planı karşılaştırır: kayan, öne alınan ve değişmeyen görev sayıları, planlanan bitiş sapması (takvim günü) ve en çok kayan görevler. Silinmiş görevlerin baz plan kaydı korunur ve ayrıca sayılır.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['projectId'],
    properties: {
      projectId: ID_PROPERTY('Proje kimliği.'),
      baselineId: ID_PROPERTY('Karşılaştırılacak baz plan (verilmezse birincil, o da yoksa en yeni).'),
      limit: LIMIT_PROPERTY(25, 10)
    }
  },
  async handler(args, call) {
    const limit = args.limit ?? 10;
    const { scope } = await call.authorization();
    await requireFullProject(scope, args.projectId, call);
    const result = await call.sql((executor) => readBaseline(executor, scope, {
      projectId: args.projectId, baselineId: args.baselineId ?? null, maxRows: TOOL_LIMITS.maxAnalyzedTasks
    }));
    if (!result.projectFull) throw fullAccessRequired();
    if (result.truncated) throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
    // Karşılaştırma ve eklenen görev sayıları projenin güncel bütün görevlerine dayanır.
    call.notePopulation?.(result.population);
    const baselines = result.baselines.map((row) => ({
      baselineId: canonicalActualId(row.BaselineId),
      name: dataText(row.Name, 120),
      createdAt: sqlInstant(row.CreatedAt),
      isPrimary: Boolean(row.IsPrimary),
      taskCount: row.SnapshotCount == null ? null : Number(row.SnapshotCount)
    }));
    const selectedId = result.selectedBaselineId ? canonicalActualId(result.selectedBaselineId) : null;
    if (args.baselineId && selectedId !== args.baselineId) throw notFound();
    const selected = baselines.find((baseline) => baseline.baselineId === selectedId) || null;
    const counts = { snapshotTasks: result.snapshots.length, compared: 0, finishSlipped: 0, finishEarlier: 0, finishUnchanged: 0,
      startSlipped: 0, missingDates: 0, removedSinceBaseline: 0, addedSinceBaseline: result.addedSinceBaseline };
    const variances = [];
    for (const row of result.snapshots) {
      if (!row.TaskExists) {
        counts.removedSinceBaseline += 1;
        continue;
      }
      const baselineFinish = sqlDay(row.BaselineFinish);
      const currentFinish = sqlDay(row.PlannedFinish);
      const baselineStart = sqlDay(row.BaselineStart);
      const currentStart = sqlDay(row.PlannedStart);
      if (baselineStart && currentStart && daysBetween(baselineStart, currentStart) > 0) counts.startSlipped += 1;
      if (!baselineFinish || !currentFinish) {
        counts.missingDates += 1;
        continue;
      }
      counts.compared += 1;
      const variance = daysBetween(baselineFinish, currentFinish);
      if (variance > 0) counts.finishSlipped += 1;
      else if (variance < 0) counts.finishEarlier += 1;
      else counts.finishUnchanged += 1;
      variances.push({
        taskId: canonicalActualId(row.TaskId),
        title: dataText(row.Title, 160),
        status: taskStatus(row.Status),
        baselineFinish,
        plannedFinish: currentFinish,
        varianceDays: variance,
        ...(sqlDay(row.TargetFinish) ? { targetFinish: sqlDay(row.TargetFinish) } : {})
      });
    }
    const total = variances.reduce((sum, item) => sum + item.varianceDays, 0);
    const slipped = variances.filter((item) => item.varianceDays > 0)
      .sort((left, right) => right.varianceDays - left.varianceDays || left.title.localeCompare(right.title, 'tr'))
      .slice(0, limit)
      .map((item) => ({ ...item, statusLabel: statusLabelOf(item.status) }));
    const project = projectAccess(scope, args.projectId);
    return {
      data: {
        baseline: selected,
        availableBaselines: baselines,
        availableBaselinesTruncated: result.baselinesTruncated,
        counts,
        finishVariance: variances.length ? {
          averageDays: Math.round((total / variances.length) * 10) / 10,
          maxSlipDays: Math.max(0, ...variances.map((item) => item.varianceDays)),
          maxEarlierDays: Math.max(0, ...variances.map((item) => -item.varianceDays))
        } : null,
        mostSlipped: slipped,
        definitions: METRIC_DEFINITIONS.baseline
      },
      scope: describeTaskScope(project ? [project] : []),
      complete: slipped.length === counts.finishSlipped && !result.baselinesTruncated,
      truncated: slipped.length < counts.finishSlipped || result.baselinesTruncated,
      returnedCount: slipped.length,
      totalCount: counts.finishSlipped,
      nextCursor: null,
      evidence: {
        label: selected ? `Baz plan karşılaştırması · ${selected.name}` : 'Baz plan karşılaştırması · baz plan yok',
        entity: { type: 'project', id: args.projectId, name: null },
        highlights: [`Karşılaştırılan: ${counts.compared}`, `Kayan: ${counts.finishSlipped}`, `Silinen: ${counts.removedSinceBaseline}`]
      }
    };
  }
};

/* ── rota_dependency_inspect ──────────────────────────────── */

const DEPENDENCY_LABELS = Object.freeze({
  FS: 'Bitiş → Başlangıç (FS)',
  SS: 'Başlangıç → Başlangıç (SS)',
  FF: 'Bitiş → Bitiş (FF)',
  SF: 'Başlangıç → Bitiş (SF)'
});
const LAG_UNITS = Object.freeze({ day: 'gün', week: 'hafta', month: 'ay' });

function lagView(row) {
  const value = row.LagValue == null ? Number(row.LagDays || 0) : Number(row.LagValue);
  const unit = row.LagUnit || 'day';
  return { value, unit, label: value === 0 ? 'Gecikme yok' : `${value > 0 ? '+' : '−'}${Math.abs(value)} ${LAG_UNITS[unit] || 'gün'}` };
}

const dependencyInspect = {
  name: 'rota_dependency_inspect',
  version: 1,
  topic: 'dependencies',
  evidenceKind: 'dependencies',
  authorization: 'Bağımlılıklar yalnızca projede FULL erişimi olan kullanıcılara açıktır (anlık görüntüyle aynı).',
  description: 'Kayıtlı bağımlılık ilişkilerini inceler: bir görevin öncülleri ve ardılları (tür FS/SS/FF/SF ve gecikme) ya da bir projenin bağımlılık kapsaması. Kritik yol, bolluk ya da tarih hesabı YAPMAZ.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      taskId: ID_PROPERTY('Öncül ve ardılları incelenecek görev.'),
      projectId: ID_PROPERTY('Bağımlılık kapsaması incelenecek proje (taskId verilmediğinde).')
    }
  },
  async handler(args, call) {
    if (!args.taskId && !args.projectId) throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: ['$.taskId:required'] });
    const { scope } = await call.authorization();
    let focus = null;
    let projectId = args.projectId || null;
    if (args.taskId) {
      focus = (await visibleTask(call, scope, args.taskId)).fact;
      if (projectId && projectId !== focus.projectId) throw notFound();
      projectId = focus.projectId;
    }
    await requireFullProject(scope, projectId, call);
    const result = await call.sql((executor) => readDependencies(executor, scope, {
      projectId, focusTaskId: focus?.id ?? null, maxRows: TOOL_LIMITS.maxAnalyzedTasks
    }));
    if (result.truncated) throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
    if (!focus) call.notePopulation?.(result.population);
    const tasks = new Map(result.tasks.map((row) => [canonicalActualId(row.TaskId), row]));
    const relation = (row, otherId) => {
      const other = tasks.get(otherId);
      return {
        taskId: otherId,
        title: other ? dataText(other.Title, 160) : 'Görev',
        ...(other ? { status: taskStatus(other.Status), statusLabel: statusLabelOf(taskStatus(other.Status)) } : {}),
        type: row.DependencyType,
        typeLabel: DEPENDENCY_LABELS[row.DependencyType] || row.DependencyType,
        lag: lagView(row),
        ...(other && sqlDay(other.PlannedStart) ? { plannedStart: sqlDay(other.PlannedStart) } : {}),
        ...(other && sqlDay(other.PlannedFinish) ? { plannedFinish: sqlDay(other.PlannedFinish) } : {})
      };
    };
    const notes = ['Kritik yol ve bolluk bu araçta hesaplanmaz; yalnızca kayıtlı ilişkiler gösterilir.'];
    if (focus) {
      const predecessors = result.dependencies.filter((row) => canonicalActualId(row.TaskId) === focus.id)
        .map((row) => relation(row, canonicalActualId(row.PredecessorTaskId)));
      const successors = result.dependencies.filter((row) => canonicalActualId(row.PredecessorTaskId) === focus.id)
        .map((row) => relation(row, canonicalActualId(row.TaskId)));
      return {
        data: {
          task: { taskId: focus.id, title: dataText(focus.title, 160), status: focus.status, statusLabel: statusLabelOf(focus.status) },
          predecessors,
          successors,
          notes: ['Öncül: bu görevin bağlı olduğu görev. Ardıl: bu göreve bağlı görev.', ...notes]
        },
        scope: describeTaskScope([projectAccess(scope, projectId)]),
        complete: true,
        truncated: false,
        returnedCount: predecessors.length + successors.length,
        totalCount: predecessors.length + successors.length,
        nextCursor: null,
        evidence: {
          label: `Bağımlılık ilişkileri · ${dataText(focus.title, 60)}`,
          entity: { type: 'task', id: focus.id, name: dataText(focus.title, 120) },
          highlights: [`Öncül: ${predecessors.length}`, `Ardıl: ${successors.length}`]
        }
      };
    }
    const withPredecessor = new Set();
    const withSuccessor = new Set();
    const degree = new Map();
    const byType = { FS: 0, SS: 0, FF: 0, SF: 0 };
    let withLag = 0;
    let withLead = 0;
    for (const row of result.dependencies) {
      const taskId = canonicalActualId(row.TaskId);
      const predecessorId = canonicalActualId(row.PredecessorTaskId);
      withPredecessor.add(taskId);
      withSuccessor.add(predecessorId);
      degree.set(taskId, (degree.get(taskId) || 0) + 1);
      degree.set(predecessorId, (degree.get(predecessorId) || 0) + 1);
      if (Object.hasOwn(byType, row.DependencyType)) byType[row.DependencyType] += 1;
      const lag = lagView(row).value;
      if (lag > 0) withLag += 1;
      if (lag < 0) withLead += 1;
    }
    const connected = new Set([...withPredecessor, ...withSuccessor]);
    const taskCount = Number(result.totals.TaskCount || 0);
    const mostConnected = [...degree.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 5)
      .map(([taskId, count]) => ({ taskId, title: dataText(tasks.get(taskId)?.Title, 160), relationCount: count }));
    return {
      data: {
        coverage: {
          taskCount,
          dependencyCount: result.dependencies.length,
          tasksWithPredecessor: withPredecessor.size,
          tasksWithSuccessor: withSuccessor.size,
          tasksWithoutAnyDependency: Math.max(0, taskCount - connected.size),
          byType,
          withPositiveLag: withLag,
          withNegativeLag: withLead
        },
        mostConnected,
        notes
      },
      scope: describeTaskScope([projectAccess(scope, projectId)]),
      complete: true,
      truncated: false,
      returnedCount: result.dependencies.length,
      totalCount: result.dependencies.length,
      nextCursor: null,
      evidence: {
        label: `Bağımlılık kapsaması · ${result.dependencies.length} ilişki`,
        entity: { type: 'project', id: projectId, name: null },
        highlights: [`Görev: ${taskCount}`, `İlişki: ${result.dependencies.length}`, `Bağımsız görev: ${Math.max(0, taskCount - connected.size)}`]
      }
    };
  }
};

/* ── rota_recurrence_inspect ──────────────────────────────── */

function seriesSummary(occurrences, today) {
  const ordered = [...occurrences].sort((left, right) => String(left.recurrenceOccurrenceDate || '').localeCompare(String(right.recurrenceOccurrenceDate || '')));
  const upcoming = ordered.filter((fact) => fact.status !== 'done' && (fact.recurrenceOccurrenceDate || '') >= today);
  const completed = occurrences.filter((fact) => fact.status === 'done');
  const completionDatesComplete = completed.every((fact) => Boolean(fact.actualFinish));
  const lastDone = completed.filter((fact) => fact.actualFinish).sort((left, right) => right.actualFinish.localeCompare(left.actualFinish) || right.id.localeCompare(left.id))[0] || null;
  const previewLimit = 3;
  return {
    visibleOccurrences: occurrences.length,
    completionDatesComplete,
    open: occurrences.filter((fact) => fact.status !== 'done').length,
    done: occurrences.filter((fact) => fact.status === 'done').length,
    overdue: occurrences.filter((fact) => isOverdue(fact, today)).length,
    upcomingCount: upcoming.length,
    nextTruncated: upcoming.length > previewLimit,
    next: upcoming.slice(0, previewLimit).map((fact) => ({
      taskId: fact.id, occurrenceDate: fact.recurrenceOccurrenceDate, targetFinish: fact.targetFinish, status: fact.status, statusLabel: statusLabelOf(fact.status)
    })),
    lastCompleted: lastDone ? { taskId: lastDone.id, occurrenceDate: lastDone.recurrenceOccurrenceDate, actualFinish: lastDone.actualFinish } : null
  };
}

const recurrenceInspect = {
  name: 'rota_recurrence_inspect',
  version: 1,
  topic: 'recurrence',
  evidenceKind: 'recurrence',
  authorization: 'Yalnızca görünür görevler; kısmi projede serinin yalnızca yetkili yinelemeleri sayılır.',
  description: 'Tekrarlayan görev serilerini inceler: kural (Türkçe açıklamasıyla), görünür yineleme sayıları, açık/tamamlanan/gecikmiş yinelemeler ve sıradaki yinelemeler. taskId verilirse o görevin serisi, verilmezse (proje ya da bütün kapsamda) seri listesi döner.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      taskId: ID_PROPERTY('Seri şablonu ya da serinin bir yinelemesi.'),
      projectId: ID_PROPERTY('Yalnızca bu projenin serileri.'),
      limit: LIMIT_PROPERTY(25, 10)
    }
  },
  async handler(args, call) {
    const limit = args.limit ?? 10;
    const { scope } = await call.authorization();
    if (args.taskId) {
      const { fact } = await visibleTask(call, scope, args.taskId);
      const seriesId = fact.recurrenceRule ? fact.id : fact.recurrenceParentId;
      if (!seriesId) {
        const access = projectAccess(scope, fact.projectId);
        return {
          data: { task: { taskId: fact.id, title: dataText(fact.title, 160) }, recurring: false },
          scope: describeTaskScope(access ? [access] : []),
          complete: true, truncated: false, returnedCount: 0, totalCount: 0, nextCursor: null,
          evidence: { label: `Tekrar serisi · ${dataText(fact.title, 60)}`, entity: { type: 'task', id: fact.id, name: dataText(fact.title, 120) }, highlights: ['Tekrarlayan görev değil'] }
        };
      }
      const result = await call.sql((executor) => readTaskFacts(executor, scope, {
        projectId: fact.projectId, seriesId, maxRows: TOOL_LIMITS.maxAnalyzedTasks
      }));
      if (result.truncated) throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
      call.notePopulation?.(factPopulation(result.facts));
      const template = result.facts.find((item) => item.id === seriesId && item.recurrenceRule) || null;
      const occurrences = result.facts.filter((item) => item.recurrenceParentId === seriesId);
      const access = projectAccess(scope, fact.projectId);
      const summary = seriesSummary(occurrences, call.today);
      const evidenceTask = template || fact;
      return {
        data: {
          series: {
            ...(template ? { templateTaskId: template.id } : {}),
            title: dataText(template?.title || fact.title, 160),
            ...(template ? { rule: dataText(template.recurrenceRule, 200), ruleDescription: describeRecurrenceRule(template.recurrenceRule) } : {}),
            ...summary
          },
          notes: ['Sayılar yalnızca görünür yinelemeler üzerindedir. Son tamamlanan, gerçek bitişi bilinen kayıtlardan seçilir; tarih yoksa null kalır.']
        },
        scope: describeTaskScope(access ? [access] : []),
        // Eksik gerçek bitiş tarihi satır eksiltmez: sonuç kısaltılmış değildir, yalnızca tamlığı belirtilir.
        complete: !summary.nextTruncated && summary.completionDatesComplete,
        truncated: summary.nextTruncated,
        returnedCount: 1,
        totalCount: 1,
        nextCursor: null,
        evidence: {
          label: `Tekrar serisi · ${dataText(template?.title || fact.title, 60)}`,
          entity: { type: 'task', id: evidenceTask.id, name: dataText(evidenceTask.title, 120) },
          highlights: [template ? describeRecurrenceRule(template.recurrenceRule) : 'Görünür görev', `Görünür yineleme: ${occurrences.length}`]
        }
      };
    }
    if (args.projectId) await requireVisibleProject(scope, args.projectId, call);
    const result = await call.sql((executor) => readTaskFacts(executor, scope, {
      projectId: args.projectId ?? null, recurringOnly: true, maxRows: TOOL_LIMITS.maxAnalyzedTasks
    }));
    if (result.truncated) throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
    call.notePopulation?.(factPopulation(result.facts));
    const projects = projectIndex(result.projects);
    const series = new Map();
    // Yinelemeler yalnızca şablonları GÖRÜNÜRSE bir seri altında toplanır: gizli
    // şablon kimliği görünür kayıt sayısını (ve yinelemelerin aynı gizli seriye
    // ait olup olmadığını) belirleyemez. Şablonu görünmeyen yineleme kendi kaydıdır.
    const visibleTemplates = new Set(result.facts.filter((fact) => fact.recurrenceRule).map((fact) => fact.id));
    for (const fact of result.facts) {
      const seriesId = fact.recurrenceRule ? fact.id
        : (fact.recurrenceParentId && visibleTemplates.has(fact.recurrenceParentId) ? fact.recurrenceParentId : fact.id);
      if (!seriesId) continue;
      if (!series.has(seriesId)) series.set(seriesId, { template: null, occurrences: [], projectId: fact.projectId });
      const entry = series.get(seriesId);
      if (fact.id === seriesId && fact.recurrenceRule) entry.template = fact;
      else entry.occurrences.push(fact);
    }
    const list = [...series.entries()].map(([seriesId, entry]) => {
      const title = entry.template?.title || entry.occurrences[0]?.title || 'Seri';
      return {
        ...(entry.template ? { templateTaskId: entry.template.id } : {}),
        title: dataText(title, 160),
        project: projects.get(entry.projectId)?.name || null,
        ...(entry.template ? { ruleDescription: describeRecurrenceRule(entry.template.recurrenceRule) } : {}),
        ...seriesSummary(entry.occurrences, call.today)
      };
    }).sort((left, right) => right.open - left.open || left.title.localeCompare(right.title, 'tr'));
    const page = list.slice(0, limit);
    const previewTruncated = page.some((item) => item.nextTruncated);
    const datesIncomplete = page.some((item) => !item.completionDatesComplete);
    const descriptor = args.projectId
      ? describeTaskScope([projectAccess(scope, args.projectId)])
      : describeTaskScope(scope.isAdmin ? [] : [...scope.projects.values()]);
    return {
      data: { visibleEntryCount: list.length, series: page, notes: ['Sayılar yalnızca görünür görevler üzerindedir.'] },
      scope: descriptor,
      complete: page.length === list.length && !previewTruncated && !datesIncomplete,
      truncated: page.length < list.length || previewTruncated,
      returnedCount: page.length,
      totalCount: list.length,
      nextCursor: null,
      evidence: {
        label: `Tekrar kayıtları · ${list.length} görünür kayıt`,
        entity: args.projectId ? { type: 'project', id: args.projectId, name: null } : null,
        highlights: page.slice(0, 3).map((item) => item.title)
      }
    };
  }
};

/* ── rota_calendar_inspect ────────────────────────────────── */

const WEEKDAY_NAMES = Object.freeze(['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi']);
const MAX_CALENDAR_RANGE_DAYS = 366;

const calendarInspect = {
  name: 'rota_calendar_inspect',
  version: 1,
  topic: 'calendar',
  evidenceKind: 'calendar',
  authorization: 'Proje takvimi için proje görünür olmalıdır; aksi hâlde yalnızca varsayılan takvim kullanılır.',
  description: 'Çalışma takvimini inceler: projenin (ya da varsayılan) takvimi, çalışma günleri, verilen aralıktaki resmi tatiller ve iş günü sayısı (Rota\'nın takvim kuralıyla, iki uç dahil). Aralık en fazla 366 gündür; verilmezse bugünden itibaren 30 gün.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      projectId: ID_PROPERTY('Takvimi incelenecek proje (verilmezse varsayılan takvim).'),
      dateFrom: DATE_PROPERTY('Aralık başlangıcı (YYYY-MM-DD, dahil).'),
      dateTo: DATE_PROPERTY('Aralık bitişi (YYYY-MM-DD, dahil).')
    }
  },
  async handler(args, call) {
    const from = args.dateFrom || call.today;
    const to = args.dateTo || addDays(from, 29);
    if (from > to) throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: ['$.dateFrom:reversed'] });
    if (daysBetween(from, to) + 1 > MAX_CALENDAR_RANGE_DAYS) throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: ['$.dateTo:range'] });
    const { scope } = await call.authorization();
    if (args.projectId) await requireVisibleProject(scope, args.projectId, call);
    const result = await call.sql((executor) => readCalendar(executor, scope, { projectId: args.projectId ?? null, from, to }));
    if (args.projectId && !result.projectVisible) throw notFound();
    if (!result.calendar) throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED, { message: 'Etkin bir çalışma takvimi tanımlı değil.' });
    const holidays = result.holidays.map((row) => ({ date: sqlDay(row.HolidayDate), name: dataText(row.Name, 120), short: dataText(row.ShortName || row.Name, 120) }));
    const workingDays = Array.isArray(result.workingDays) && result.workingDays.length
      ? result.workingDays
      : [1, 2, 3, 4, 5];
    const calendar = {
      id: canonicalActualId(result.calendar.CalendarId),
      name: String(result.calendar.Name || ''),
      timezone: String(result.calendar.TimeZone || 'Europe/Istanbul'),
      workingDays,
      holidays: holidays.map((holiday) => ({ date: holiday.date, name: holiday.name, short: holiday.short }))
    };
    const workingDayCount = countWorkingDays(from, to, calendar);
    return {
      data: {
        calendar: {
          name: dataText(calendar.name, 120),
          timeZone: calendar.timezone,
          source: result.calendar.ProjectCalendarSelected ? 'project' : 'default',
          workingWeekdays: calendar.workingDays.map((day) => WEEKDAY_NAMES[day]).filter(Boolean)
        },
        range: { from, to, calendarDays: daysBetween(from, to) + 1 },
        // İş günü sayısı tarih penceresine bağlıdır: pencere her olgunun niteleyicisidir.
        filters: { dateFrom: from, dateTo: to },
        workingDayCount,
        holidays,
        notes: ['İş günü sayısı iki ucu da içerir; hafta sonu ve takvimdeki tatiller sayılmaz.']
      },
      scope: referenceScope('Takvim bilgisi kurulumun çalışma takvimidir.'),
      complete: true,
      truncated: false,
      returnedCount: holidays.length,
      totalCount: holidays.length,
      nextCursor: null,
      evidence: {
        label: `Çalışma takvimi · ${dataText(calendar.name, 60)}`,
        entity: args.projectId ? { type: 'project', id: args.projectId, name: null } : null,
        highlights: [`${from} – ${to}`, `İş günü: ${workingDayCount}`, `Tatil: ${holidays.length}`]
      }
    };
  }
};

export const PLAN_TOOLS = Object.freeze([baselineCompare, dependencyInspect, recurrenceInspect, calendarInspect]);
