import { safeErrorResponse } from '../../../../../../server/errors.js';
import { loadSystemAdminContext } from '../../../../../../server/observability/adminRequestContext.js';
import { observabilityConfiguration } from '../../../../../../server/observability/observabilityConfig.js';
import { loadSystemOverview } from '../../../../../../server/observability/systemHealthService.js';
import { withRouteObservability } from '../../../../../../server/observability/observeOperation.js';
import { telemetryWorkerStatus } from '../../../../../../server/observability/telemetryWorker.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Sistem Yönetimi · Genel Durum.
 *
 * YALNIZCA sistem yöneticisi. Yanıt bilinçli olarak hafiftir: birkaç küçük
 * yoklama sorgusu, dizinli bir uyarı okuması ve süreç belleğindeki ölçüm
 * toplamları. Otuz günlük geçmiş bu uçta OKUNMAZ (bkz. performance ucu), çünkü
 * bu uç on saniyede bir yenilenir.
 */
export const GET = withRouteObservability('api.admin.system.overview', async () => {
  try {
    const { pool } = await loadSystemAdminContext();
    const overview = await loadSystemOverview(pool);
    return Response.json({
      ok: true,
      configuration: observabilityConfiguration(),
      worker: telemetryWorkerStatus(),
      ...overview
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
});
