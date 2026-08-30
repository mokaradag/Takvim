import { safeErrorResponse, ServerPersistenceError } from '../../../../../server/errors.js';
import { decideScheduleChange } from '../../../../../server/schedule-change/scheduleChangeStore.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function PATCH(request, { params }) {
  try {
    const requestId = params?.requestId;
    const body = await request.json().catch(() => null);
    if (!requestId || !body || typeof body !== 'object') {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Geçerli bir tarih talebi kararı gönderilmelidir.', { status: 400 });
    }
    return Response.json(await decideScheduleChange(requestId, body), {
      headers: { 'cache-control': 'no-store' }
    });
  } catch (error) {
    return safeErrorResponse(error);
  }
}
