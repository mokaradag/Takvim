import { createProjectedSqlAppRepository } from '../../../../server/repository/projectedSqlAppRepository.js';
import { safeErrorResponse } from '../../../../server/errors.js';
import { withRouteObservability } from '../../../../server/observability/observeOperation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function loadSnapshotForRequest(request, repository) {
  const refreshMode = request?.headers?.get('x-mergen-rota-refresh-mode');
  const backgroundCatalogRefresh = refreshMode === 'manual' || refreshMode === 'automatic';
  return repository.loadSnapshotWithSession({
    catalogSync: backgroundCatalogRefresh ? 'background-after' : 'blocking-before'
  });
}

/**
 * Anlık görüntü yanıtı oturum bağlamını da taşır.
 *
 * Açılışta istemcinin iki ayrı gidiş-dönüşe (anlık görüntü + oturum) ihtiyacı
 * vardı. İlk uygulama yükü boş katalog kurulumunu gerektiğinde bekler. Manuel
 * ve otomatik yenileme ise önce mevcut yetkili snapshot'ı okur, sonra
 * TTL/tek-uçuş denetimli katalog tazelemesini arka planda başlatır; var olan
 * ekran 38 bin satırlık CN43N turunu beklemez.
 *
 * Oturum, anlık görüntünün YETKİ BAĞLAMINDAN kurulur: ayrı bir
 * `loadSessionContext()` çağrısı aynı kişi/rol/proje erişimi ve görev-atama
 * kapsamı sorgularını bu istekte ikinci kez çalıştırır ve gidiş-dönüşten
 * kazanılan süreyi geri harcardı.
 *
 * Ayrı `/session` ucu olduğu gibi durmaya devam eder (oturum tazeleme ve
 * eski istemciler için).
 */
async function handleSnapshot(request = null) {
  try {
    const repository = createProjectedSqlAppRepository();
    const body = await loadSnapshotForRequest(request, repository);
    return Response.json(body, {
      headers: { 'cache-control': 'no-store' }
    });
  } catch (error) {
    return safeErrorResponse(error);
  }
}

// Ölçüm sarmalayıcısı imzayı ve yanıtı DEĞİŞTİRMEZ; yalnızca süreyi, sonucu ve
// ilişkilendirme kimliğini kaydeder (bkz. server/observability).
export const GET = withRouteObservability('api.snapshot', handleSnapshot);
