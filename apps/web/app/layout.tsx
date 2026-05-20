import type { Metadata } from 'next';
import './globals.css';
import Link from 'next/link';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? 'https://pay-radar-web.vercel.app';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'PayRadar — Trust + Discovery for pay.sh',
  description:
    'Signed reliability, latency, and freshness scores for every pay-as-you-go API in the pay.sh catalog. Verifiable offline. Open formula. Built for agents.',
  openGraph: {
    title: 'PayRadar — Trust + Discovery for pay.sh',
    description:
      'Signed reliability, latency, and freshness scores for every pay-as-you-go API. Verifiable offline. Open formula. Built for agents.',
    url: siteUrl,
    siteName: 'PayRadar',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PayRadar — Trust + Discovery for pay.sh',
    description:
      'Signed reliability, latency, and freshness scores for every pay-as-you-go API. Built for agents.',
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-mono">
        <header className="border-b border-white/10">
          <nav className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-6">
            <Link href="/" className="text-lg font-bold">
              PayRadar
            </Link>
            <Link href="/discover" className="text-sm hover:text-sky-400">
              Discover
            </Link>
            <a
              href="/api/v1/discover"
              className="text-sm hover:text-sky-400 ml-auto opacity-70"
            >
              API
            </a>
          </nav>
        </header>
        <main className="max-w-6xl mx-auto px-6 py-10">{children}</main>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
