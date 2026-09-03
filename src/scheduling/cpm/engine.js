import { fmtISO, parseDate } from '../dates/index.js';
import {
  DEFAULT_CALENDAR,
  MAX_WORKING_DAY_SPAN,
  addWorkingDays,
  countWorkingDays,
  diffWorkingDays,
  moveToWorkingDay,
  resolveTaskCalendar
} from '../calendars/index.js';
import { applyDependencyLag, dependencyLagDays } from '../dependencies/index.js';
import { buildDependencyGraph, CpmValidationError } from './graph.js';

function dateOnly(value) {
  const date = parseDate(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function requireValidDate(value, taskId, field) {
  if (!value) {
    throw new CpmValidationError(
      'MISSING_TASK_DATE',
      `Task ${taskId} is missing ${field}.`,
      { taskId, field }
    );
  }
  const date = dateOnly(value);
  if (Number.isNaN(date.getTime())) {
    throw new CpmValidationError(
      'INVALID_TASK_DATE',
      `Task ${taskId} has invalid ${field}: ${value}`,
      { taskId, field, value }
    );
  }
  return date;
}

function inferProjectStart(tasks) {
  const starts = (tasks || [])
    .filter((task) => task.plannedStart)
    .map((task) => requireValidDate(task.plannedStart, task.id, 'plannedStart'));

  if (!starts.length) {
    throw new CpmValidationError(
      'MISSING_PROJECT_START',
      'CPM requires projectStart or at least one task plannedStart.'
    );
  }

  return starts.reduce((earliest, date) => (date < earliest ? date : earliest));
}

function activityDuration(task, calendar) {
  if (Number.isFinite(task.plannedDurationDays)) return Math.max(0, Math.trunc(task.plannedDurationDays));
  if (task.milestone) return 0;

  const start = requireValidDate(task.plannedStart, task.id, 'plannedStart');
  const end = requireValidDate(task.plannedFinish, task.id, 'plannedFinish');
  if (end < start) {
    throw new CpmValidationError(
      'INVALID_TASK_DATES',
      `Task ${task.id} ends before it starts.`,
      { taskId: task.id, start: fmtISO(start), end: fmtISO(end) }
    );
  }

  return Math.max(1, countWorkingDays(start, end, calendar));
}

/**
 * Ufku aşan bir çalışma günü aramasını AÇIK HATAYA çevirir.
 *
 * `addWorkingDays` sınır dışı bir aralık için `null` döndürür. Eskiden aynı
 * durum sessizce GİRİŞ TARİHİNE düşüyordu: 4000 iş günlük bir gecikme sıfır
 * gecikmeyle, 2600 günlük bir görev de kilometre taşıyla aynı sonucu veriyordu.
 * Plan yanlış — üstelik iyimser yönde yanlış — yayımlanıyordu. Artık proje
 * zamanlaması "geçersiz" olarak işaretlenir ve neden arayüze taşınır.
 */
function requireWithinHorizon(date, taskId, field) {
  if (date != null) return date;
  throw new CpmValidationError(
    'SCHEDULE_HORIZON_EXCEEDED',
    `Task ${taskId} cannot be scheduled: ${field} exceeds the supported planning horizon of ${MAX_WORKING_DAY_SPAN} working days.`,
    { taskId, field, limit: MAX_WORKING_DAY_SPAN }
  );
}

function finishFromStart(start, durationDays, calendar) {
  if (start == null) return null;
  const alignedStart = moveToWorkingDay(start, calendar, 1);
  if (durationDays === 0) return alignedStart;
  return addWorkingDays(alignedStart, durationDays - 1, calendar);
}

function startFromFinish(finish, durationDays, calendar) {
  if (finish == null) return null;
  const alignedFinish = moveToWorkingDay(finish, calendar, -1);
  if (durationDays === 0) return alignedFinish;
  return addWorkingDays(alignedFinish, -(durationDays - 1), calendar);
}

function latestDate(values) {
  return values.reduce((latest, value) => (value > latest ? value : latest));
}

function earliestDate(values) {
  return values.reduce((earliest, value) => (value < earliest ? value : earliest));
}

function forwardConstraint(predecessorSchedule, dependency, successorDuration, successorCalendar) {
  switch (dependency.type) {
    case 'SS': {
      const start = applyDependencyLag(predecessorSchedule.earlyStart, dependency, successorCalendar);
      return start == null ? null : moveToWorkingDay(start, successorCalendar, 1);
    }
    case 'FF': {
      const finish = applyDependencyLag(predecessorSchedule.earlyFinish, dependency, successorCalendar);
      if (finish == null) return null;
      return startFromFinish(moveToWorkingDay(finish, successorCalendar, 1), successorDuration, successorCalendar);
    }
    case 'SF': {
      const finish = applyDependencyLag(predecessorSchedule.earlyStart, dependency, successorCalendar);
      if (finish == null) return null;
      return startFromFinish(moveToWorkingDay(finish, successorCalendar, 1), successorDuration, successorCalendar);
    }
    case 'FS':
    default: {
      const laggedFinish = applyDependencyLag(predecessorSchedule.earlyFinish, dependency, successorCalendar);
      if (laggedFinish == null) return null;
      const nextDay = addWorkingDays(laggedFinish, 1, successorCalendar);
      return nextDay == null ? null : moveToWorkingDay(nextDay, successorCalendar, 1);
    }
  }
}

function backwardStartBound(taskSchedule, successorSchedule, dependency, taskCalendar, successorCalendar) {
  const lagDays = dependencyLagDays(dependency, successorCalendar);

  switch (dependency.type) {
    case 'SS': {
      const bound = addWorkingDays(successorSchedule.lateStart, -lagDays, successorCalendar);
      return bound == null ? null : moveToWorkingDay(bound, taskCalendar, -1);
    }
    case 'FF': {
      const finishBound = addWorkingDays(successorSchedule.lateFinish, -lagDays, successorCalendar);
      if (finishBound == null) return null;
      return startFromFinish(moveToWorkingDay(finishBound, taskCalendar, -1), taskSchedule.durationDays, taskCalendar);
    }
    case 'SF': {
      const bound = addWorkingDays(successorSchedule.lateFinish, -lagDays, successorCalendar);
      return bound == null ? null : moveToWorkingDay(bound, taskCalendar, -1);
    }
    case 'FS':
    default: {
      // Gecikme ve İLİŞKİ KAYMASI ayrı adımlardır; `-(lagDays + 1)` olarak
      // birleştirilemezler. Ufuk denetimi tek çağrının BÜYÜKLÜĞÜNE bakar
      // (`MAX_WORKING_DAY_SPAN`), bu yüzden belgelenen en büyük gecikme
      // (20 000) bir fazlasıyla istenince `null` dönüyor,
      // `requireWithinHorizon` bunu `SCHEDULE_HORIZON_EXCEEDED` yapıyordu:
      // yazma sınırının kabul ettiği sınır değeri yalnızca FS bağlarında ve
      // yalnızca yeniden hesaplama sırasında kullanılamaz hâle geliyordu.
      // İleri geçiş (bkz. forwardConstraint) bu iki adımı zaten ayrı atıyor;
      // geri geçiş de aynı biçimi izler.
      const laggedStart = addWorkingDays(successorSchedule.lateStart, -lagDays, successorCalendar);
      if (laggedStart == null) return null;
      const finishBound = addWorkingDays(laggedStart, -1, successorCalendar);
      if (finishBound == null) return null;
      return startFromFinish(moveToWorkingDay(finishBound, taskCalendar, -1), taskSchedule.durationDays, taskCalendar);
    }
  }
}

function relationshipSlack(edge, schedules, metadata) {
  const predecessor = schedules.get(edge.predecessorId);
  const successor = schedules.get(edge.successorId);
  const successorMeta = metadata.get(edge.successorId);
  const requiredStart = forwardConstraint(
    predecessor,
    edge.dependency,
    successorMeta.durationDays,
    successorMeta.calendar
  );
  // İleri geçiş aynı kısıtı zaten doğruladı; buraya `null` düşerse serbest
  // yüzmeyi sıfır saymak, kırpılmış bir sayı üretmekten iyidir.
  if (requiredStart == null) return 0;
  return Math.max(0, diffWorkingDays(successor.earlyStart, requiredStart, successorMeta.calendar));
}

/**
 * Sayılan KRİTİK YOL üst sınırı.
 *
 * Her kritik kök-yaprak yolu ayrı bir dizi olarak üretilir; art arda gelen
 * elmas desenleri yol sayısını ÜSTEL büyütür (25 katman ≈ 33 milyon yol).
 * `buildPortfolioSchedule` hesabı eşzamanlı çağırdığı için bu, zamanlama
 * ekranını dondurup belleği tüketiyordu. Sınıra ulaşıldığında sayım kesilir ve
 * `criticalPathsTruncated` ile bildirilir; kritik görev kümesi TAM kalır.
 */
const MAX_CRITICAL_PATHS = 500;

function findCriticalPaths(graph, schedules, metadata) {
  const criticalIds = new Set(
    graph.topologicalOrder.filter((id) => schedules.get(id).totalFloatDays <= 0)
  );
  const criticalOutgoing = new Map(graph.topologicalOrder.map((id) => [id, []]));
  const criticalIncomingCount = new Map(graph.topologicalOrder.map((id) => [id, 0]));

  for (const edge of graph.edges) {
    if (!criticalIds.has(edge.predecessorId) || !criticalIds.has(edge.successorId)) continue;
    if (relationshipSlack(edge, schedules, metadata) !== 0) continue;
    criticalOutgoing.get(edge.predecessorId).push(edge.successorId);
    criticalIncomingCount.set(edge.successorId, criticalIncomingCount.get(edge.successorId) + 1);
  }

  const starts = graph.topologicalOrder.filter(
    (id) => criticalIds.has(id) && criticalIncomingCount.get(id) === 0
  );
  const paths = [];
  let truncated = false;

  function visit(taskId, path) {
    if (paths.length >= MAX_CRITICAL_PATHS) {
      truncated = true;
      return;
    }
    const nextPath = [...path, taskId];
    const successors = criticalOutgoing.get(taskId);
    if (!successors.length) {
      paths.push(nextPath);
      return;
    }
    for (const successorId of successors) visit(successorId, nextPath);
  }

  for (const taskId of starts) visit(taskId, []);
  return { paths, truncated };
}

function serializeSchedule(schedule) {
  return {
    id: schedule.id,
    calendarId: schedule.calendarId,
    durationDays: schedule.durationDays,
    earlyStart: fmtISO(schedule.earlyStart),
    earlyFinish: fmtISO(schedule.earlyFinish),
    lateStart: fmtISO(schedule.lateStart),
    lateFinish: fmtISO(schedule.lateFinish),
    totalFloatDays: schedule.totalFloatDays,
    freeFloatDays: schedule.freeFloatDays,
    isCritical: schedule.totalFloatDays <= 0
  };
}

export function calculateCpm(tasks, {
  projects = [],
  calendars = [],
  projectStart = null,
  fallbackCalendar = DEFAULT_CALENDAR
} = {}) {
  if (!tasks?.length) {
    return {
      projectStart: null,
      projectFinish: null,
      orderedTaskIds: [],
      criticalTaskIds: [],
      criticalPaths: [],
      criticalPathsTruncated: false,
      tasks: {}
    };
  }

  const graph = buildDependencyGraph(tasks);
  const startAnchor = projectStart ? dateOnly(projectStart) : inferProjectStart(tasks);
  if (Number.isNaN(startAnchor.getTime())) {
    throw new CpmValidationError('INVALID_PROJECT_START', `Invalid projectStart: ${projectStart}`, { projectStart });
  }

  const metadata = new Map();
  for (const taskId of graph.topologicalOrder) {
    const task = graph.tasksById.get(taskId);
    const calendar = resolveTaskCalendar(task, projects, calendars, fallbackCalendar);
    metadata.set(taskId, {
      task,
      calendar,
      durationDays: activityDuration(task, calendar)
    });
  }

  const schedules = new Map();

  for (const taskId of graph.topologicalOrder) {
    const meta = metadata.get(taskId);
    const startCandidates = [moveToWorkingDay(startAnchor, meta.calendar, 1)];

    for (const edge of graph.incoming.get(taskId)) {
      startCandidates.push(requireWithinHorizon(
        forwardConstraint(
          schedules.get(edge.predecessorId),
          edge.dependency,
          meta.durationDays,
          meta.calendar
        ),
        taskId,
        `dependency lag from ${edge.predecessorId}`
      ));
    }

    const earlyStart = latestDate(startCandidates);
    const earlyFinish = requireWithinHorizon(
      finishFromStart(earlyStart, meta.durationDays, meta.calendar),
      taskId,
      'plannedDurationDays'
    );
    schedules.set(taskId, {
      id: taskId,
      calendarId: meta.calendar.id,
      durationDays: meta.durationDays,
      earlyStart,
      earlyFinish,
      lateStart: null,
      lateFinish: null,
      totalFloatDays: null,
      freeFloatDays: null
    });
  }

  const projectFinish = latestDate([...schedules.values()].map((schedule) => schedule.earlyFinish));

  for (const taskId of [...graph.topologicalOrder].reverse()) {
    const meta = metadata.get(taskId);
    const schedule = schedules.get(taskId);
    const projectFinishBound = moveToWorkingDay(projectFinish, meta.calendar, -1);
    const startBounds = [requireWithinHorizon(
      startFromFinish(projectFinishBound, meta.durationDays, meta.calendar),
      taskId,
      'plannedDurationDays'
    )];

    for (const edge of graph.outgoing.get(taskId)) {
      const successorSchedule = schedules.get(edge.successorId);
      const successorMeta = metadata.get(edge.successorId);
      startBounds.push(requireWithinHorizon(
        backwardStartBound(
          schedule,
          successorSchedule,
          edge.dependency,
          meta.calendar,
          successorMeta.calendar
        ),
        taskId,
        `dependency lag to ${edge.successorId}`
      ));
    }

    schedule.lateStart = earliestDate(startBounds);
    schedule.lateFinish = requireWithinHorizon(
      finishFromStart(schedule.lateStart, meta.durationDays, meta.calendar),
      taskId,
      'plannedDurationDays'
    );
    schedule.totalFloatDays = diffWorkingDays(schedule.lateStart, schedule.earlyStart, meta.calendar);
  }

  for (const taskId of graph.topologicalOrder) {
    const schedule = schedules.get(taskId);
    const meta = metadata.get(taskId);
    const outgoing = graph.outgoing.get(taskId);
    if (!outgoing.length) {
      const finishBound = moveToWorkingDay(projectFinish, meta.calendar, -1);
      schedule.freeFloatDays = Math.max(0, diffWorkingDays(finishBound, schedule.earlyFinish, meta.calendar));
    } else {
      schedule.freeFloatDays = Math.min(...outgoing.map((edge) => relationshipSlack(edge, schedules, metadata)));
    }
  }

  const actualProjectStart = earliestDate([...schedules.values()].map((schedule) => schedule.earlyStart));
  const criticalTaskIds = graph.topologicalOrder.filter((id) => schedules.get(id).totalFloatDays <= 0);
  const { paths: criticalPaths, truncated: criticalPathsTruncated } = findCriticalPaths(graph, schedules, metadata);
  const serializedTasks = Object.fromEntries(
    graph.topologicalOrder.map((id) => [id, serializeSchedule(schedules.get(id))])
  );

  return {
    projectStart: fmtISO(actualProjectStart),
    projectFinish: fmtISO(projectFinish),
    orderedTaskIds: [...graph.topologicalOrder],
    criticalTaskIds,
    criticalPaths,
    // Kritik GÖREV kümesi her zaman tamdır; kesilen yalnızca yol SAYIMIdır.
    criticalPathsTruncated,
    tasks: serializedTasks
  };
}
