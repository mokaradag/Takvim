import { safeErrorResponse, ServerPersistenceError } from '../../../../../server/errors.js';
import { decideAssignmentCoordination } from '../../../../../server/assignment/assignmentCoordinationStore.js';
import { withRouteObservability } from '../../../../../server/observability/observeOperation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Onayla / Reddet / Değişiklik İste / Kaldırılmasını İste / Geri Çek. */
export const PATCH = withRouteObservability('api.assignment-coordination.decide', async (request, context) => {
  try {
    const coordinationId = context?.params?.coordinationId;
    const body = await request.json().catch(() => null);
    if (!coordinationId || !body || typeof body !== 'object') {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Geçerli bir koordinasyon kararı gönderilmelidir.', { status: 400 });
    }
    return Response.json(await decideAssignmentCoordination(coordinationId, body), {
      headers: { 'cache-control': 'no-store' }
    });
  } catch (error) {
    return safeErrorResponse(error);
  }
});
