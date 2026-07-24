import { createHardenedSqlAppRepository } from '../../../../server/repository/hardenedSqlAppRepository.js';
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
    return Response.json(await createHardenedSqlAppRepository().commitChanges(body.changes), {
      headers: { 'cache-control': 'no-store' }
    });
  } catch (error) {
    return safeErrorResponse(error);
  }
}
