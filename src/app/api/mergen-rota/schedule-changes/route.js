import { safeErrorResponse, ServerPersistenceError } from '../../../../server/errors.js';
import { createScheduleChange } from '../../../../server/schedule-change/scheduleChangeStore.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Geçerli bir tarih talebi gönderilmelidir.', { status: 400 });
    }
    return Response.json(await createScheduleChange(body), {
      headers: { 'cache-control': 'no-store' }
    });
  } catch (error) {
    return safeErrorResponse(error);
  }
}
