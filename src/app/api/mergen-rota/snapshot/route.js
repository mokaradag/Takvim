import { createProjectedSqlAppRepository } from '../../../../server/repository/projectedSqlAppRepository.js';
import { safeErrorResponse } from '../../../../server/errors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function loadSnapshotForRequest(request, repository) {
  const manualRefresh = request?.headers?.get('x-mergen-rota-refresh-mode') === 'manual';
  return repository.loadSnapshotWithSession({
    catalogSync: manualRefresh ? 'background-after' : 'blocking-before'
  });
}

/**
 * Anlık görüntü yanıtı oturum bağlamını da taşır.
 *
 * Açılışta istemcinin iki ayrı gidiş-dönüşe (anlık görüntü + oturum) ihtiyacı
 * vardı. İlk uygulama yükü boş katalog kurulumunu gerektiğinde bekler. Manuel
 * Refresh ise önce mevcut yetkili snapshot'ı okur, sonra TTL/single-flight
 * denetimli katalog tazelemesini arka planda başlatır; var olan ekran 38 bin
 * satırlık CN43N turunu beklemez.
 *
 * Oturum, anlık görüntünün YETKİ BAĞLAMINDAN kurulur: ayrı bir
 * `loadSessionContext()` çağrısı aynı kişi/rol/proje erişimi ve görev-atama
 * kapsamı sorgularını bu istekte ikinci kez çalıştırır ve gidiş-dönüşten
 * kazanılan süreyi geri harcardı.
 *
 * Ayrı `/session` ucu olduğu gibi durmaya devam eder (oturum tazeleme ve
 * eski istemciler için).
 */
export async function GET(request = null) {
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
