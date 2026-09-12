import { safeErrorResponse, ServerPersistenceError } from '../../../../../../server/errors.js';
import {
  loadSystemAdminContext,
  withAdminActionLock
} from '../../../../../../server/observability/adminRequestContext.js';
import { withRouteObservability } from '../../../../../../server/observability/observeOperation.js';
import {
  isTestableIntegration,
  loadIntegrations,
  testIntegration
} from '../../../../../../server/observability/integrationsService.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Sistem Yönetimi · Entegrasyonlar — YALNIZCA sistem yöneticisi.
 *
 * Yanıt hiçbir koşulda parola, jeton, çerez, bağlantı dizesi ya da SMTP kimlik
 * bilgisi taşımaz; yapılandırma yalnızca "yapılandırılmış / yapılandırılmamış"
 * olarak bildirilir.
 */
export const GET = withRouteObservability('api.admin.system.integrations', async () => {
  try {
    const { pool } = await loadSystemAdminContext();
    return Response.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      integrations: await loadIntegrations(pool)
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
});

/**
 * Bağlantı testi.
 *
 * Testlerin tümü YIKICI DEĞİLDİR ve SMTP testi ileti GÖNDERMEZ: yalnızca
 * bağlantı ve el sıkışma denenir.
 */
export const POST = withRouteObservability('api.admin.system.integrations.test', async (request) => {
  try {
    const { pool } = await loadSystemAdminContext();
    const body = await request.json().catch(() => null);
    const id = String(body?.integrationId || '');
    if (!isTestableIntegration(id)) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Bu entegrasyon için bağlantı testi tanımlı değil.', { status: 400 });
    }
    const result = await withAdminActionLock(`integration-test:${id}`, () => testIntegration(pool, id));
    return Response.json({ ok: true, integrationId: id, result }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
});
