/**
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} name
 * @property {string} color
 * @property {string|null} [leadId]
 * @property {string|null} [calendarId]
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
 * @typedef {Object} Task
 * @property {string} id
 * @property {string|null} projectId
 * @property {string[]} assigneeIds
 * @property {string|null} wbsId
 * @property {string|null} [calendarId] Optional task-level override of the project calendar.
 * @property {number} [durationDays] Optional explicit working-day duration used by CPM. If omitted, CPM derives duration from baseline dates.
 * @property {Dependency[]} deps
 * @property {string} task
 * @property {string} status
 * @property {string} baslangicTarihi
 * @property {string} bitisTarihi
 * @property {string} hedefTarih
 * @property {string} [proje] Legacy display field retained for the current UI.
 * @property {string[]} [sorumlu] Legacy display field retained for the current UI.
 */

/**
 * @typedef {Object} CpmTaskResult
 * @property {string} id
 * @property {string} calendarId
 * @property {number} durationDays
 * @property {string} earlyStart
 * @property {string} earlyFinish
 * @property {string} lateStart
 * @property {string} lateFinish
 * @property {number} totalFloatDays
 * @property {number} freeFloatDays
 * @property {boolean} isCritical
 */

export const DOMAIN_MODEL_VERSION = 3;
