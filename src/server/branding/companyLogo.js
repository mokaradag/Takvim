import { readFile, stat } from 'node:fs/promises';

export function companyLogoSource(env = process.env) {
  const source = String(env.MERGEN_ROTA_COMPANY_LOGO_PATH || env.NEXT_PUBLIC_MERGEN_ROTA_COMPANY_LOGO_URL || '').trim();
  if (!source) return null;
  if (/^https?:\/\//i.test(source)) return { url: source };
  if (/^(?:\\\\|[a-z]:[\\/]|\/)/i.test(source) && /\.svg$/i.test(source)) return { path: source };
  return null;
}

export async function companyLogoResponse(env = process.env) {
  const source = companyLogoSource(env);
  if (!source) return new Response(null, { status: 404 });
  if (source.url) return Response.redirect(source.url, 307);
  try {
    const info = await stat(source.path);
    if (!info.isFile() || info.size > 1024 * 1024) return new Response(null, { status: 404 });
    const svg = await readFile(source.path);
    return new Response(svg, { headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    } });
  } catch {
    return new Response(null, { status: 404 });
  }
}
