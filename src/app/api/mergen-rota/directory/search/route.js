import { safeErrorResponse } from '../../../../../server/errors.js';
import { searchCorporateDirectory } from '../../../../../server/directory/directorySearch.js';
import { withRouteObservability } from '../../../../../server/observability/observeOperation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Kurum dışı personel araması.
 *
 * Çağıranın kimliği oturumdan doğrulanır, en az iki karakter istenir, sonuç
 * sayısı sınırlıdır ve yalnızca bu akışın gerektirdiği alanlar döner. Uç bir
 * kimlik dizini değildir (bkz. server/directory/directorySearch.js).
 */
export const GET = withRouteObservability('api.directory.search', async (request) => {
  try {
    const params = new URL(request.url).searchParams;
    const result = await searchCorporateDirectory({ query: params.get('q') ?? params.get('query') });
    return Response.json({ ok: true, ...result }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
});
