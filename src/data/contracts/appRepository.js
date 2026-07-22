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
 * Atomic canonical persistence change set.
 *
 * @typedef {Object} AppChangeSet
 * @property {import('../../domain/models').Project[]} [projectUpserts]
 * @property {string[]} [projectDeletes]
 * @property {import('../../domain/models').Task[]} [taskUpserts]
 * @property {string[]} [taskDeletes]
 * @property {import('../../domain/models').WbsNode[]} [wbsUpserts]
 * @property {string[]} [wbsDeletes]
 */

/**
 * @typedef {Object} AppRepository
 * @property {() => Promise<AppDataSnapshot>} loadSnapshot
 * @property {(changes: AppChangeSet) => Promise<AppChangeSet>} commitChanges
 */

export const REPOSITORY_ERROR_CODES = Object.freeze({
  LOAD_FAILED: 'LOAD_FAILED',
  MUTATION_FAILED: 'MUTATION_FAILED'
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
  if (!repository || typeof repository.loadSnapshot !== 'function' || typeof repository.commitChanges !== 'function') {
    throw new Error('App repository must implement loadSnapshot() and commitChanges().');
  }
  return repository;
}
