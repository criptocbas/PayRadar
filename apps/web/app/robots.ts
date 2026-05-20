import type { MetadataRoute } from 'next';

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? 'https://pay-radar-web.vercel.app';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // Don't index the cron trigger or health probes — not useful in search results.
        disallow: ['/api/cron/', '/api/health'],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
