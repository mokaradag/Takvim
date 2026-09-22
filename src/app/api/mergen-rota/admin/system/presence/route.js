import { safeErrorResponse } from '../../../../../../server/errors.js';
import { loadActiveUsers } from '../../../../../../server/presence/presenceStore.js';
import { withRouteObservability } from '../../../../../../server/observability/observeOperation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Sistem Yönetimi · Aktif Kullanıcılar — YALNIZCA sistem yöneticisi.
 *
 * Yetki, öteki yönetim uçlarıyla aynı biçimde sunucuda BAĞIMSIZ olarak
 * denetlenir (bkz. server/presence/presenceStore.js · loadActiveUsers).
 */
export const GET = withRouteObservability('api.admin.system.presence', async () => {
  try {
    return Response.json(await loadActiveUsers(), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
});
