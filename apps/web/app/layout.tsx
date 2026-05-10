import type { Metadata } from 'next';
import './globals.css';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'PayRadar — Trust + Discovery for pay.sh',
  description:
    'Trust scores, latency, and reliability for every pay.sh API endpoint. Built for autonomous AI agents.',
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
      </body>
    </html>
  );
}
