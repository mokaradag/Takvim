import { safeErrorResponse, ServerPersistenceError } from '../../../../../../server/errors.js';
import { isSameOriginRequest } from '../../../../../../server/identity/sameOriginRequest.js';
import {
  loadSystemAdminContext,
  withAdminActionLock,
  withLocalAdminActionLock
} from '../../../../../../server/observability/adminRequestContext.js';
import { withRouteObservability } from '../../../../../../server/observability/observeOperation.js';
import {
  integrationTestNeedsDatabaseLock,
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
 * bağlantı ve el sıkışma denenir. İstek yalnızca aynı kaynaktan kabul edilir:
 * `SameSite=Lax` çerezi aynı sitedeki kardeş bir kaynağın basit (`text/plain`)
 * POST'uyla da gider ve yöneticinin oturumuyla kurumsal anahtarlı bir sağlayıcı
 * çağrısı tetiklenebilirdi. Yöneticinin isteği kesilirse (`request.signal`)
 * yapay zekâ testi de iptal edilir.
 */
export const POST = withRouteObservability('api.admin.system.integrations.test', async (request) => {
  try {
    if (!isSameOriginRequest(request)) {
      throw new ServerPersistenceError('FORBIDDEN', 'Bağlantı testi isteği aynı kaynaktan gelmelidir.');
    }
    const { pool } = await loadSystemAdminContext();
    const body = await request.json().catch(() => null);
    const id = String(body?.integrationId || '');
    if (!isTestableIntegration(id)) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Bu entegrasyon için bağlantı testi tanımlı değil.', { status: 400 });
    }
    const lockId = `integration-test:${id}`;
    const run = () => testIntegration(pool, id, { signal: request.signal });
    // Dış uca giden ve veritabanına dokunmayan test, SQL kilidi tutmadan çalışır.
    const result = integrationTestNeedsDatabaseLock(id)
      ? await withAdminActionLock(lockId, run, pool)
      : await withLocalAdminActionLock(lockId, run);
    return Response.json({ ok: true, integrationId: id, result }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
});
