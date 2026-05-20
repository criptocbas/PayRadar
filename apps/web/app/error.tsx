'use client';

import Link from 'next/link';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="py-20 space-y-6">
      <div className="text-xs uppercase tracking-wider text-red-400">Error</div>
      <h1 className="text-4xl font-bold">Something broke.</h1>
      <p className="text-white/60 max-w-prose">
        The page hit an unexpected error. Retrying often works; if it doesn't,
        the catalog dashboard usually does.
      </p>
      {error.digest ? (
        <div className="text-xs text-white/30 font-mono">
          ref: {error.digest}
        </div>
      ) : null}
      <div className="flex gap-3 text-sm">
        <button
          onClick={reset}
          className="px-4 py-2 rounded bg-sky-500 text-black font-semibold"
        >
          Try again
        </button>
        <Link
          href="/discover"
          className="px-4 py-2 rounded border border-white/20 hover:border-white/40"
        >
          Discover dashboard
        </Link>
      </div>
    </div>
  );
}
