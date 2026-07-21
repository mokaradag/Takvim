/**
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} name
 * @property {string} color
 * @property {string|null} [leadId]
 * @property {string|null} [calendarId]
 * @property {string|null} dataDate Project status/cutoff date. Stored project-control data; not browser today or calculated finish.
 * @property {string} [lead] Legacy display field retained for the current UI.
 */

/**
 * @typedef {Object} Person
 * @property {string} id
 * @property {string} name
 * @property {string} role
 * @property {string} team
 * @property {string} color
 */

/**
 * @typedef {Object} WbsNode
 * @property {string} id
 * @property {string} projectId
 * @property {string|null} parentId
 * @property {string} code
 * @property {string} name
 */

/**
 * Project/task scheduling calendar. JavaScript weekday numbers are used:
 * Sunday=0 through Saturday=6. Holidays are explicit ISO dates so movable
 * holidays do not silently repeat in later years.
 * @typedef {Object} SchedulingCalendar
 * @property {string} id
 * @property {string} name
 * @property {string} timezone
 * @property {number[]} workingDays
 * @property {{date:string,name:string,short?:string}[]} holidays
 */

/**
 * Canonical dependency shape. The legacy id field is retained by the mock adapter
 * while the UI transition is in progress; predecessorId is the stable relationship key.
 * lagDays is interpreted as working days by the scheduling engine.
 * @typedef {Object} Dependency
 * @property {string} predecessorId
 * @property {'FS'|'SS'|'FF'|'SF'} type
 * @property {number} lagDays
 * @property {string} [id]
 */

/**
 * Canonical task/activity record. Current-plan, target, actual and remaining-work
 * values are stored data. CPM early/late dates, float and critical status are not Task fields.
 * @typedef {Object} Task
 * @property {string} id
 * @property {string|null} projectId
 * @property {string[]} assigneeIds
 * @property {string|null} wbsId
 * @property {string|null} [calendarId] Optional task-level override of the project calendar.
 * @property {Dependency[]} deps
 * @property {string} task
 * @property {string} status
 * @property {string|null} plannedStart Mutable current-plan start.
 * @property {string|null} plannedFinish Mutable current-plan finish.
 * @property {number|null} plannedDurationDays Working-day duration normalized from current-plan dates; milestones are zero.
 * @property {string|null} targetFinish Management target/deadline; not automatically a CPM constraint.
 * @property {string|null} actualStart Explicit observed start; never inferred from status or progress.
 * @property {string|null} actualFinish Explicit observed finish; never inferred from status or progress.
 * @property {number|null} remainingDurationDays Independent remaining working duration; not derived from percentage complete.
 * @property {string} [proje] Legacy display field retained for the current UI.
 * @property {string[]} [sorumlu] Legacy display field retained for the current UI.
 */

/**
 * Immutable baseline header. Task snapshots are stored separately so mutable current-plan edits do not rewrite history.
 * @typedef {Object} Baseline
 * @property {string} id
 * @property {string} projectId
 * @property {string} name
 * @property {string} createdAt
 * @property {boolean} isPrimary
 */

/**
 * @typedef {Object} TaskBaselineSnapshot
 * @property {string} baselineId
 * @property {string} taskId
 * @property {string|null} plannedStart
 * @property {string|null} plannedFinish
 * @property {number|null} plannedDurationDays
 * @property {string|null} calendarId
 */

/**
 * Derived CPM result. These values are calculated projections and are never copied into canonical Task records.
 * @typedef {Object} CpmTaskResult
 * @property {string} id
 * @property {string} calendarId
 * @property {number} durationDays Duration used by this CPM calculation, in working days.
 * @property {string} earlyStart
 * @property {string} earlyFinish
 * @property {string} lateStart
 * @property {string} lateFinish
 * @property {number} totalFloatDays
 * @property {number} freeFloatDays
 * @property {boolean} isCritical
 */

export const DOMAIN_MODEL_VERSION = 4;
