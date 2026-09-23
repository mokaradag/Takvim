import { safeErrorResponse, ServerPersistenceError } from '../../../../server/errors.js';
import { createAssignmentCoordination } from '../../../../server/assignment/assignmentCoordinationStore.js';
import { queryAssignmentCoordinations } from '../../../../server/assignment/assignmentCoordinationQueries.js';
import { withRouteObservability } from '../../../../server/observability/observeOperation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Atama talebi oluşturur. Yetki sunucuda türetilir; istemci anahtarı yalnızca arayüzdür. */
export const POST = withRouteObservability('api.assignment-coordination.create', async (request) => {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Geçerli bir atama talebi gönderilmelidir.', { status: 400 });
    }
    return Response.json(await createAssignmentCoordination(body), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
});

/** Sunucu tarafında sayfalanmış geçmiş. Tam geçmiş anlık görüntüye girmez. */
export const GET = withRouteObservability('api.assignment-coordination.list', async (request) => {
  try {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    return Response.json(await queryAssignmentCoordinations(query), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
});
