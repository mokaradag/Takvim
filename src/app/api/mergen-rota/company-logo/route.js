import { companyLogoResponse } from '../../../../server/branding/companyLogo.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET() {
  return companyLogoResponse();
}
