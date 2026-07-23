import { createSqlAppRepository } from '../../../../server/repository/sqlAppRepository.js';
import { safeErrorResponse } from '../../../../server/errors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    return Response.json(await createSqlAppRepository().loadSessionContext(), {
      headers: { 'cache-control': 'no-store' }
    });
  } catch (error) {
    return safeErrorResponse(error);
  }
}
