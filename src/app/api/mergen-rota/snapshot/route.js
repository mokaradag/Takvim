import { createProjectedSqlAppRepository } from '../../../../server/repository/projectedSqlAppRepository.js';
import { safeErrorResponse } from '../../../../server/errors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Anlık görüntü yanıtı oturum bağlamını da taşır.
 *
 * Açılışta istemcinin iki ayrı gidiş-dönüşe (anlık görüntü + oturum) ihtiyacı
 * vardı ve bu istekler paralelleştirilemez: oturum bağlamı, anlık görüntünün
 * tetiklediği kurumsal katalog eşitlemesinden SONRA okunmalıdır; aksi hâlde
 * yeni eşitlenen kurumsal projeler erişim listesinde görünmez. Aynı sıra tek
 * bir istek içinde korunur ve açılıştan bir tam tur eksilir.
 *
 * Ayrı `/session` ucu olduğu gibi durmaya devam eder (oturum tazeleme ve
 * eski istemciler için).
 */
export async function GET() {
  try {
    const repository = createProjectedSqlAppRepository();
    const snapshot = await repository.loadSnapshot();
    const session = await repository.loadSessionContext();
    return Response.json({ ...snapshot, session }, {
      headers: { 'cache-control': 'no-store' }
    });
  } catch (error) {
    return safeErrorResponse(error);
  }
}
