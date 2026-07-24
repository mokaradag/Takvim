import { createOrderedSqlAppRepository } from '../../../../server/repository/orderedSqlAppRepository.js';
import {
  canonicalizeCommitChanges,
  findCommitChangeIssue
} from '../../../../server/repository/commitChangeValidation.js';
import { findNestedCommitCollectionIssue } from '../../../../server/repository/commitNestedCollectionValidation.js';
import { safeErrorResponse, ServerPersistenceError } from '../../../../server/errors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || !body.changes || typeof body.changes !== 'object') {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Geçerli bir değişiklik kümesi gönderilmelidir.', { status: 400 });
    }
    const changes = canonicalizeCommitChanges(body.changes);
    const issue = findCommitChangeIssue(changes) || findNestedCommitCollectionIssue(changes);
    if (issue) {
      throw new ServerPersistenceError('MUTATION_FAILED', issue.message, {
        status: 400,
        details: { code: issue.code, path: issue.path, ...(issue.details || {}) }
      });
    }
    return Response.json(await createOrderedSqlAppRepository().commitChanges(changes), {
      headers: { 'cache-control': 'no-store' }
    });
  } catch (error) {
    return safeErrorResponse(error);
  }
}
