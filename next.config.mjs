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
  async redirects() {
    return publicBasePath
      ? [{ source: publicBasePath, destination: `${publicBasePath}/`, permanent: false }]
      : [];
  },
  async rewrites() {
    // Keeps direct port-8008 testing possible even when a prefixed production
    // build is running without Nginx in front of it.
    return publicBasePath
      ? [{ source: `${publicBasePath}/:path*`, destination: '/:path*' }]
      : [];
  },
  experimental: {
    serverComponentsExternalPackages: ['mssql', 'msnodesqlv8'],
  },
};

export default nextConfig;
