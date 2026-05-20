import type { MetadataRoute } from 'next';
import { supabasePublic } from '@/lib/supabase';

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? 'https://pay-radar-web.vercel.app';

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const base: MetadataRoute.Sitemap = [
    { url: siteUrl, lastModified: now, changeFrequency: 'hourly', priority: 1.0 },
    {
      url: `${siteUrl}/discover`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 0.9,
    },
    {
      url: `${siteUrl}/docs/scoring/v0.1.0.md`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.5,
    },
  ];

  // Best-effort: list every provider page. Falls back to the base set if the
  // DB query errors so the sitemap is always serveable.
  try {
    const sb = supabasePublic();
    const { data } = await sb.from('providers').select('slug').limit(1000);
    if (data) {
      for (const p of data) {
        if (typeof p.slug === 'string' && p.slug.length > 0) {
          base.push({
            url: `${siteUrl}/providers/${p.slug}`,
            lastModified: now,
            changeFrequency: 'daily',
            priority: 0.7,
          });
        }
      }
    }
  } catch {
    // swallow — better to ship a small sitemap than crash the route
  }

  return base;
}
