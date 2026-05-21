'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ScoreModal, type ScoreModalRow } from './score-modal';
import { tierColorClass, formatRelative, priceBand, formatLatency } from '@/lib/format';

export interface DiscoverRow extends ScoreModalRow {
  provider_homepage: string | null;
}

export interface DiscoverFilters {
  capability?: string;
  category?: string;
  min_score?: number;
  max_price_usd?: number;
}

interface Props {
  rows: DiscoverRow[];
  // Current sort, controlled by URL params; the server re-fetches on change.
  // Header clicks navigate via Link rather than re-sorting client-side, which
  // keeps URLs shareable and SSR fast-paths working.
  currentSort: string;
  // The active filters, used to rebuild the sort URL. Passed as data (not a
  // closure) so this component can stay client-only while the server stays RSC.
  filters: DiscoverFilters;
}

const COLUMNS: { key: string; label: string; sortable: boolean; align?: 'right' | 'center' }[] = [
  { key: 'provider', label: 'Provider', sortable: false },
  { key: 'endpoint', label: 'Endpoint', sortable: false },
  { key: 'capabilities', label: 'Capabilities', sortable: false },
  { key: 'price', label: 'Price', sortable: true, align: 'right' },
  { key: 'score', label: 'Score', sortable: true, align: 'right' },
  { key: 'confidence', label: 'Conf.', sortable: true, align: 'right' },
  { key: 'latency', label: 'Latency p95', sortable: true, align: 'right' },
  { key: 'last_probed', label: 'Last probed', sortable: false, align: 'right' },
  { key: 'tier', label: 'Tier', sortable: false, align: 'center' },
];

export function DiscoverTable({ rows, currentSort, filters }: Props) {
  const [selected, setSelected] = useState<DiscoverRow | null>(null);

  const buildSortHref = (sortBy: string) => {
    const sp = new URLSearchParams();
    if (filters.capability) sp.set('capability', filters.capability);
    if (filters.category) sp.set('category', filters.category);
    if ((filters.min_score ?? 0) > 0) sp.set('min_score', String(filters.min_score));
    if (
      filters.max_price_usd != null &&
      Number.isFinite(filters.max_price_usd) &&
      filters.max_price_usd < 1_000_000_000
    ) {
      sp.set('max_price_usd', String(filters.max_price_usd));
    }
    sp.set('sort_by', sortBy);
    return `/discover?${sp.toString()}`;
  };

  if (rows.length === 0) {
    return <div className="text-white/50 text-sm py-8">No endpoints match.</div>;
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-white/50 border-b border-white/10">
            <tr>
              {COLUMNS.map((col) => {
                const isActive = col.key === currentSort;
                const align =
                  col.align === 'right'
                    ? 'text-right'
                    : col.align === 'center'
                    ? 'text-center'
                    : '';
                if (!col.sortable) {
                  return (
                    <th key={col.key} className={`py-2 px-2 ${align}`}>
                      {col.label}
                    </th>
                  );
                }
                return (
                  <th key={col.key} className={`py-2 px-2 ${align}`}>
                    <Link
                      href={buildSortHref(col.key)}
                      className={`hover:text-white ${
                        isActive ? 'text-white font-medium' : ''
                      }`}
                    >
                      {col.label}
                      {isActive ? ' ↓' : ''}
                    </Link>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.endpoint_id}
                className="border-b border-white/5 hover:bg-white/5 cursor-pointer"
                onClick={() => setSelected(r)}
              >
                <td className="py-2 px-2">
                  <Link
                    href={`/providers/${r.provider_slug}`}
                    onClick={(e) => e.stopPropagation()}
                    className="hover:text-sky-400"
                  >
                    {r.provider_name}
                  </Link>
                </td>
                <td className="py-2 px-2 max-w-[280px]" title={r.url}>
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`shrink-0 inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${methodBadgeClass(
                        r.method
                      )}`}
                    >
                      {r.method}
                    </span>
                    <span className="truncate font-mono text-xs text-white/80">
                      {r.path || r.url}
                    </span>
                  </div>
                </td>
                <td className="py-2 px-2">
                  <div className="flex flex-wrap gap-1">
                    {(r.capabilities ?? []).slice(0, 3).map((c) => (
                      <span
                        key={c}
                        className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/70"
                      >
                        {c}
                      </span>
                    ))}
                    {r.capabilities.length > 3 ? (
                      <span className="text-[10px] text-white/40 self-center">
                        +{r.capabilities.length - 3}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="py-2 px-2 text-right tabular-nums text-white/70">
                  {priceBand(r.pricing?.amount_usd)}
                </td>
                <td className="py-2 px-2 text-right tabular-nums">
                  {r.score?.toFixed(1) ?? '—'}
                </td>
                <td className="py-2 px-2 text-right tabular-nums text-white/60">
                  {r.confidence != null ? r.confidence.toFixed(2) : '—'}
                </td>
                <td
                  className="py-2 px-2 text-right tabular-nums text-white/70"
                  title={
                    r.dimensions?.latency
                      ? `latency score ${r.dimensions.latency.score.toFixed(0)} / 100`
                      : undefined
                  }
                >
                  {formatLatency(r.latency_p95_ms)}
                </td>
                <td className="py-2 px-2 text-right text-white/50 text-xs">
                  {formatRelative(r.last_probe_ts)}
                </td>
                <td
                  className={`py-2 px-2 text-center font-bold ${tierColorClass(r.tier)}`}
                >
                  {r.tier ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected ? <ScoreModal row={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}

function methodBadgeClass(method: string): string {
  switch (method.toUpperCase()) {
    case 'GET':
      return 'text-sky-300 border-sky-500/30 bg-sky-500/5';
    case 'POST':
      return 'text-emerald-300 border-emerald-500/30 bg-emerald-500/5';
    case 'PUT':
    case 'PATCH':
      return 'text-amber-300 border-amber-500/30 bg-amber-500/5';
    case 'DELETE':
      return 'text-red-300 border-red-500/30 bg-red-500/5';
    default:
      return 'text-white/60 border-white/10 bg-white/5';
  }
}
