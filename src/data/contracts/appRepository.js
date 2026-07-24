/**
 * @typedef {Object} AppDataSnapshot
 * @property {import('../../domain/models').SchedulingCalendar[]} calendars
 * @property {import('../../domain/models').Project[]} projects
 * @property {import('../../domain/models').Person[]} people
 * @property {import('../../domain/models').WbsNode[]} wbs
 * @property {import('../../domain/models').Task[]} tasks
 * @property {import('../../domain/models').Baseline[]} baselines
 * @property {import('../../domain/models').TaskBaselineSnapshot[]} taskBaselineSnapshots
 */

/**
 * @typedef {'FULL'|'PARTIAL'} ProjectAccessLevel
 * @typedef {Object} ProjectAccessEntry
 * @property {string} projectId
 * @property {ProjectAccessLevel} accessLevel
 * @property {string[]} [reasons]
 *
 * @typedef {Object} AppSessionContext
 * @property {'demo'|'actual'} dataMode
 * @property {import('../../domain/models').Person|null} currentUser
 * @property {boolean} isSystemAdmin
 * @property {boolean} isExecutive
 * @property {boolean} canCreateProjects
 * @property {ProjectAccessEntry[]} projectAccess
 */

/**
 * Opaque persistence versions are Base64 rowversion values in Actual mode.
 * Demo mode may use local opaque strings while preserving the same contract.
 *
 * @typedef {Object} EntityDelete
 * @property {string} id
 * @property {string|null} [version]
 */

/**
 * Atomic canonical persistence change set.
 * @typedef {Object} AppChangeSet
 * @property {import('../../domain/models').Project[]} [projectUpserts]
 * @property {(string|EntityDelete)[]} [projectDeletes]
 * @property {import('../../domain/models').Task[]} [taskUpserts]
 * @property {(string|EntityDelete)[]} [taskDeletes]
 * @property {import('../../domain/models').WbsNode[]} [wbsUpserts]
 * @property {(string|EntityDelete)[]} [wbsDeletes]
 */

/**
 * `loadSessionContext` is optional for legacy/test repositories. The state loader
 * supplies a conservative default session when it is absent.
 *
 * @typedef {Object} AppRepository
 * @property {() => Promise<AppDataSnapshot>} loadSnapshot
 * @property {() => Promise<AppSessionContext>} [loadSessionContext]
 * @property {(changes: AppChangeSet) => Promise<AppChangeSet>} commitChanges
 * @property {() => Promise<void>} [flush]
 */

export const REPOSITORY_ERROR_CODES = Object.freeze({
  LOAD_FAILED: 'LOAD_FAILED',
  MUTATION_FAILED: 'MUTATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE'
});

export class AppRepositoryError extends Error {
  constructor({ code, message, operation, details = null, cause = null }) {
    super(message);
    this.name = 'AppRepositoryError';
    this.code = code;
    this.operation = operation;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

export function normalizeRepositoryError(error, fallback = {}) {
  if (error instanceof AppRepositoryError) {
    return {
      code: error.code,
      message: error.message,
      operation: error.operation,
      details: error.details || null
    };
  }

  return {
    code: fallback.code || REPOSITORY_ERROR_CODES.MUTATION_FAILED,
    message: fallback.message || 'Değişiklik kaydedilemedi.',
    operation: fallback.operation || 'unknown',
    details: fallback.details || null
  };
}

export function assertAppRepository(repository) {
  if (
    !repository
    || typeof repository.loadSnapshot !== 'function'
    || typeof repository.commitChanges !== 'function'
  ) {
    throw new Error('App repository must implement loadSnapshot() and commitChanges().');
  }
  if (repository.loadSessionContext != null && typeof repository.loadSessionContext !== 'function') {
    throw new Error('App repository loadSessionContext must be a function when provided.');
  }
  return repository;
}
