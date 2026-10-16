import { safeErrorResponse } from '../../../../server/errors.js';
import { markNotifications } from '../../../../server/notifications/notificationInboxQueries.js';
import { queryTaskNotifications } from '../../../../server/notifications/taskNotificationQueries.js';
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

/** Alıcının kalıcı görev bildirimleri; geçmiş yalnız sunucuda sayfalanır. */
export const GET = withRouteObservability('api.notifications.list', async (request) => {
  try {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    return Response.json(await queryTaskNotifications(query), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
});
