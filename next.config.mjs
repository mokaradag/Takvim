import { normalizePublicBasePath } from './src/lib/publicPath.js';

const publicBasePath = normalizePublicBasePath(
  process.env.NEXT_PUBLIC_MERGEN_ROTA_PUBLIC_BASE_PATH || ''
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Nginx exposes the application below /rota and strips the prefix before
  // forwarding. Browser assets must therefore carry the public prefix, while
  // Next.js continues to serve internal routes from /.
  assetPrefix: publicBasePath || undefined,
  async rewrites() {
    // Keeps direct port-8008 testing possible even when a prefixed production
    // build is running without Nginx in front of it.
    //
    // The bare prefix is REWRITTEN, not redirected. A custom redirect from
    // `/rota` to `/rota/` loops: with `trailingSlash` at its default `false`,
    // Next.js normalizes `/rota/` straight back to `/rota` before custom
    // redirects run, so the two rules bounce the request between each other
    // indefinitely. A rewrite resolves the bare prefix in place, with no
    // redirect for the normalizer to undo.
    return publicBasePath
      ? [
        { source: publicBasePath, destination: '/' },
        { source: `${publicBasePath}/:path*`, destination: '/:path*' }
      ]
      : [];
  },
  experimental: {
    serverComponentsExternalPackages: ['mssql', 'msnodesqlv8'],
  },
};

export default nextConfig;
