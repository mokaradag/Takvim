import { safeErrorResponse } from '../../../../../server/errors.js';
import { submitPresenceHeartbeat } from '../../../../../server/presence/presenceStore.js';
import { withRouteObservability } from '../../../../../server/observability/observeOperation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Kullanıcı nabzı.
 *
 * Sicil başına TEK satır güncellenir; istek düzeyinde telemetri yazılmaz.
 * Kimlik oturumdan türetilir, gövdeden okunmaz.
 */
export const POST = withRouteObservability('api.presence.heartbeat', async () => {
  try {
    return Response.json(await submitPresenceHeartbeat(), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
});
