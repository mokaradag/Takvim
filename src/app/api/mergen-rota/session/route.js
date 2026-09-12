import { createSqlAppRepository } from '../../../../server/repository/sqlAppRepository.js';
import { sql, withSqlTransaction } from '../../../../server/db/pool.js';
import { safeErrorResponse } from '../../../../server/errors.js';
import { withRouteObservability } from '../../../../server/observability/observeOperation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

async function handleSession() {
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

// Ölçüm sarmalayıcısı imzayı ve yanıtı DEĞİŞTİRMEZ; yalnızca süreyi, sonucu ve
// ilişkilendirme kimliğini kaydeder (bkz. server/observability).
export const GET = withRouteObservability('api.session', handleSession);
