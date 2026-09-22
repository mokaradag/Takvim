import { safeErrorResponse } from '../../../../server/errors.js';
import { markNotifications } from '../../../../server/notifications/notificationInboxQueries.js';
import { withRouteObservability } from '../../../../server/observability/observeOperation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Zil bildirimlerini okundu/temizlendi işaretler.
 *
 * Kayıtlar kaynağına göre kendi tablosuna yazılır; sürüm ve sahiplik kuralları
 * her kaynakta ayrı ayrı uygulanır.
 */
export const PATCH = withRouteObservability('api.notifications.mark', async (request) => {
  try {
    const body = await request.json().catch(() => null);
    return Response.json(await markNotifications(body || {}), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
});
