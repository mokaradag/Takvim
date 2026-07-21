/**
 * @typedef {Object} AppDataSnapshot
 * @property {import('../../domain/models').SchedulingCalendar[]} calendars
 * @property {import('../../domain/models').Project[]} projects
 * @property {import('../../domain/models').Person[]} people
 * @property {import('../../domain/models').WbsNode[]} wbs
 * @property {import('../../domain/models').Task[]} tasks
 */

/**
 * Current repository contract. The mock implementation is synchronous because it
 * is an in-memory seed adapter. A future API/database adapter can replace this at
 * the state boundary without changing feature components.
 *
 * @typedef {Object} AppRepository
 * @property {() => AppDataSnapshot} getSnapshot
 */

export function assertAppRepository(repository) {
  if (!repository || typeof repository.getSnapshot !== 'function') {
    throw new Error('App repository must implement getSnapshot().');
  }
  return repository;
}
