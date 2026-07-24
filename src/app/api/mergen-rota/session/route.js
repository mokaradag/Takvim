import { createSqlAppRepository } from '../../../../server/repository/sqlAppRepository.js';
import { sql, withSqlTransaction } from '../../../../server/db/pool.js';
import { safeErrorResponse } from '../../../../server/errors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const session = await withSqlTransaction(
      () => createSqlAppRepository().loadSessionContext(),
      { isolationLevel: sql.ISOLATION_LEVEL.SERIALIZABLE }
    );
    return Response.json(session, {
      headers: { 'cache-control': 'no-store' }
    });
  } catch (error) {
    return safeErrorResponse(error);
  }
}
