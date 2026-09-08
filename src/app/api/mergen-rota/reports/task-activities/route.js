import { queryTaskActivities } from '../../../../../server/reports/taskActivityReport.js';
import { safeErrorResponse } from '../../../../../server/errors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request) {
  try {
    return Response.json(await queryTaskActivities(Object.fromEntries(new URL(request.url).searchParams)), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return safeErrorResponse(error); }
}
