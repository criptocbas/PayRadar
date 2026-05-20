import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="py-20 space-y-6">
      <div className="text-xs uppercase tracking-wider text-sky-400">404</div>
      <h1 className="text-4xl font-bold">Nothing here.</h1>
      <p className="text-white/60 max-w-prose">
        That page isn't in the catalog. Try the discover dashboard or hit the API
        directly.
      </p>
      <div className="flex gap-3 text-sm">
        <Link
          href="/discover"
          className="px-4 py-2 rounded bg-sky-500 text-black font-semibold"
        >
          Browse the catalog
        </Link>
        <Link
          href="/"
          className="px-4 py-2 rounded border border-white/20 hover:border-white/40"
        >
          Home
        </Link>
      </div>
    </div>
  );
}
