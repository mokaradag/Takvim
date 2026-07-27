import { ServerPersistenceError, safeErrorResponse } from '../../../../../server/errors.js';
import { getTrustedSessionIdentity } from '../../../../../server/identity/currentUserProvider.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const NO_STORE_HEADERS = { 'cache-control': 'no-store, max-age=0' };

export async function GET() {
  try {
    await getTrustedSessionIdentity();
    return Response.json({ authenticated: true }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof ServerPersistenceError && error.code === 'SESSION_REQUIRED') {
      return Response.json({ authenticated: false }, { headers: NO_STORE_HEADERS });
    }
    const response = safeErrorResponse(error);
    response.headers.set('cache-control', NO_STORE_HEADERS['cache-control']);
    return response;
  }
}
