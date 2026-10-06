import { NextResponse } from 'next/server.js';
import { RUNTIME_FEATURES_COOKIE } from './lib/runtimeFeatures.js';
import { PUBLIC_BASE_PATH } from './lib/publicPath.js';

export function middleware(request) {
  const response = NextResponse.next();
  const pathname = request.nextUrl.pathname;
  if (pathname !== '/' && pathname !== PUBLIC_BASE_PATH && pathname !== `${PUBLIC_BASE_PATH}/`) return response;
  const enabled = /^(1|true|yes|evet)$/i.test(String(process.env.MERGEN_ROTA_AI_ENABLED || '').trim());
  response.cookies.set(RUNTIME_FEATURES_COOKIE, enabled ? 'enabled' : 'disabled', {
    path: '/', sameSite: 'lax', secure: request.nextUrl.protocol === 'https:'
  });
  return response;
}

export const config = { matcher: ['/((?!api|_next|auth|.*\\..*).*)'] };
