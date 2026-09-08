import { queryScheduleChanges, updateScheduleNotifications } from '../../../../server/schedule-change/scheduleRequestQueries.js';
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

export async function GET(request) {
  try {
    return Response.json(await queryScheduleChanges(Object.fromEntries(new URL(request.url).searchParams)), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return safeErrorResponse(error); }
}

export async function PATCH(request) {
  try {
    const body = await request.json().catch(() => null);
    return Response.json(await updateScheduleNotifications(body || {}), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return safeErrorResponse(error); }
}
