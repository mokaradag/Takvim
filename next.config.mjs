/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ['mssql', 'msnodesqlv8'],
  },
};

export default nextConfig;
