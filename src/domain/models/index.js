/**
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} name
 * @property {string} color
 * @property {string|null} [leadId]
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
 * Canonical dependency shape. The legacy id field is retained by the mock adapter
 * while the UI transition is in progress; predecessorId is the stable relationship key.
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
 * @property {Dependency[]} deps
 * @property {string} task
 * @property {string} status
 * @property {string} baslangicTarihi
 * @property {string} bitisTarihi
 * @property {string} hedefTarih
 * @property {string} [proje] Legacy display field retained for the current UI.
 * @property {string[]} [sorumlu] Legacy display field retained for the current UI.
 */

export const DOMAIN_MODEL_VERSION = 1;
