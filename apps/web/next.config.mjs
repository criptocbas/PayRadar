/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship as TS source.
  transpilePackages: ['@payradar/schema', '@payradar/scoring-engine', '@payradar/ingestor'],
  experimental: {
    serverActions: { bodySizeLimit: '1mb' },
  },
  async rewrites() {
    return [
      // RFC 8615 well-known URI for the oracle public keys.
      // Rewriting avoids needing a `.well-known` directory in the app router
      // (Next 15 doesn't accept dot-prefixed segments).
      { source: '/.well-known/payradar-keys.json', destination: '/api/well-known/keys' },
    ];
  },
};

export default nextConfig;
