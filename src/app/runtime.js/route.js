export const dynamic = 'force-dynamic';

export function GET() {
  const enabled = /^(1|true|yes|evet)$/i.test(String(process.env.MERGEN_ROTA_AI_ENABLED || '').trim());
  return new Response(`globalThis.__MERGEN_ROTA_FEATURES__=Object.freeze({assistant:${enabled}});`, {
    headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' }
  });
}
