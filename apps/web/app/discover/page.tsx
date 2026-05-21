import Link from 'next/link';
import { supabasePublic } from '@/lib/supabase';
import { tierColorClass, priceBand, formatRelative } from '@/lib/format';
import { DiscoverTable, type DiscoverRow } from './_components/discover-table';

export const revalidate = 30;

interface SearchParams {
  capability?: string;
  category?: string;
  min_score?: string;
  max_price_usd?: string;
  sort_by?: 'score' | 'price' | 'latency' | 'confidence';
}

const VALID_SORTS = ['score', 'price', 'latency', 'confidence'] as const;
type Sort = (typeof VALID_SORTS)[number];

function parseSort(s: string | undefined): Sort {
  return VALID_SORTS.includes(s as Sort) ? (s as Sort) : 'score';
}

function rowFromView(r: any): DiscoverRow {
  return {
    endpoint_id: r.endpoint_id,
    url: r.url,
    path: r.path ?? safePathname(r.url),
    method: r.method,
    capabilities: r.capabilities ?? [],
    pricing: r.pricing,
    provider_slug: r.provider_slug,
    provider_name: r.provider_name,
    provider_homepage: r.provider_homepage,
    score: r.score != null ? Number(r.score) : null,
    confidence: r.confidence != null ? Number(r.confidence) : null,
    tier: r.tier ?? null,
    dimensions: r.dimensions ?? null,
    signature: r.signature ?? null,
    score_computed_at: r.score_computed_at,
    engine_version: r.engine_version,
    last_probe_ts: r.last_probe_ts ?? null,
    latency_p95_ms: r.latency_p95_ms != null ? Number(r.latency_p95_ms) : null,
  };
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const capability = params.capability?.trim() || undefined;
  const category = params.category?.trim() || undefined;
  const minScore = params.min_score ? Number(params.min_score) : 0;
  const maxPrice = params.max_price_usd ? Number(params.max_price_usd) : 1_000_000_000;
  const sortBy = parseSort(params.sort_by);

  const sb = supabasePublic();

  // Main result set + leaderboards + total active count run in parallel.
  const [resultsRes, leaderboardRes, categoriesRes, totalCountRes] = await Promise.all([
    sb.rpc('search_endpoints', {
      q: capability ?? null,
      category: category ?? null,
      min_score: minScore,
      max_price_usd: maxPrice,
      sort_by: sortBy,
      result_limit: 100,
    }),
    sb.from('discover_view').select('*').order('score', { ascending: false }).limit(60),
    sb.from('providers').select('categories'),
    sb.from('endpoints').select('id', { count: 'exact', head: true }).eq('active', true),
  ]);

  const rows: DiscoverRow[] = (resultsRes.data ?? []).map(rowFromView);
  const totalActive = totalCountRes.count ?? rows.length;
  const hasFilters = Boolean(capability || category || minScore > 0 || maxPrice < 1_000_000_000);

  // Leaderboards: top 5 endpoints per category, derived in JS from the same
  // recent-scored set. Cheap because the dataset is bounded (60 rows).
  const leaderboards = buildLeaderboards(leaderboardRes.data ?? []);

  // Distinct categories for the filter dropdown.
  const allCategories = new Set<string>();
  for (const p of categoriesRes.data ?? []) {
    for (const c of (p.categories ?? []) as string[]) allCategories.add(c);
  }
  const categoryOptions = Array.from(allCategories).sort();

  const filters = {
    capability,
    category,
    min_score: minScore,
    max_price_usd: maxPrice,
  };

  return (
    <div className="space-y-10">
      <div className="flex items-baseline flex-wrap gap-x-4 gap-y-2">
        <h1 className="text-2xl font-bold">Discover</h1>
        <span className="text-sm text-white/60 tabular-nums">
          {hasFilters
            ? `${rows.length} match${rows.length === 1 ? '' : 'es'} of ${totalActive} active`
            : `Showing ${rows.length} of ${totalActive} active endpoints`}
        </span>
      </div>

      {/* Filters: GET-form so SSR rules and URLs stay shareable. */}
      <form className="grid grid-cols-1 md:grid-cols-5 gap-3" method="get">
        <label className="flex flex-col text-xs">
          <span className="text-white/60 mb-1">capability</span>
          <input
            name="capability"
            placeholder="geocode, embed, transcribe…"
            defaultValue={capability ?? ''}
            className="bg-white/5 border border-white/10 rounded px-3 py-2"
          />
        </label>
        <label className="flex flex-col text-xs">
          <span className="text-white/60 mb-1">category</span>
          <select
            name="category"
            defaultValue={category ?? ''}
            className="bg-white/5 border border-white/10 rounded px-3 py-2"
          >
            <option value="">all</option>
            {categoryOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs">
          <span className="text-white/60 mb-1">
            min score: <span className="tabular-nums">{minScore}</span>
          </span>
          <input
            name="min_score"
            type="range"
            min="0"
            max="100"
            step="5"
            defaultValue={minScore}
            className="accent-sky-500"
          />
        </label>
        <label className="flex flex-col text-xs">
          <span className="text-white/60 mb-1">max price USD/call</span>
          <input
            name="max_price_usd"
            type="number"
            step="0.0001"
            min="0"
            placeholder="any"
            defaultValue={
              Number.isFinite(maxPrice) && maxPrice < 1_000_000_000 ? maxPrice : ''
            }
            className="bg-white/5 border border-white/10 rounded px-3 py-2"
          />
        </label>
        <div className="flex items-end gap-2">
          <input type="hidden" name="sort_by" value={sortBy} />
          <button
            type="submit"
            className="px-4 py-2 rounded bg-sky-500 text-black font-semibold w-full"
          >
            Search
          </button>
        </div>
      </form>

      <DiscoverTable rows={rows} currentSort={sortBy} filters={filters} />

      <Leaderboards groups={leaderboards} />
    </div>
  );
}

// ---------------- Leaderboards -----------------

interface LeaderboardEntry {
  endpoint_id: string;
  provider_name: string;
  provider_slug: string;
  url: string;
  method: string;
  score: number;
  tier: string;
  pricing: { amount_usd: number } | null;
  last_probe_ts: string | null;
}

interface LeaderboardGroup {
  category: string;
  entries: LeaderboardEntry[];
}

function buildLeaderboards(rows: any[]): LeaderboardGroup[] {
  const buckets = new Map<string, LeaderboardEntry[]>();
  for (const r of rows) {
    if (r.score == null) continue;
    const cats = (r.provider_categories ?? []) as string[];
    const cat = cats[0] ?? 'uncategorized';
    const list = buckets.get(cat) ?? [];
    list.push({
      endpoint_id: r.endpoint_id,
      provider_name: r.provider_name,
      provider_slug: r.provider_slug,
      url: r.url,
      method: r.method,
      score: Number(r.score),
      tier: r.tier,
      pricing: r.pricing,
      last_probe_ts: r.last_probe_ts ?? null,
    });
    buckets.set(cat, list);
  }
  return Array.from(buckets.entries())
    .map(([category, entries]) => ({
      category,
      entries: entries.sort((a, b) => b.score - a.score).slice(0, 5),
    }))
    .filter((g) => g.entries.length >= 2)
    .sort((a, b) => a.category.localeCompare(b.category))
    .slice(0, 8);
}

function Leaderboards({ groups }: { groups: LeaderboardGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <section className="space-y-4 pt-6 border-t border-white/10">
      <h2 className="text-lg font-bold">Leaderboards</h2>
      <p className="text-sm text-white/50">
        Top 5 endpoints per category, ranked by score.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {groups.map((g) => (
          <div key={g.category} className="border border-white/10 rounded p-4">
            <div className="text-xs uppercase tracking-wider text-white/50 mb-3">
              {g.category}
            </div>
            <ol className="space-y-2">
              {g.entries.map((e, i) => (
                <li
                  key={e.endpoint_id}
                  className="flex items-center gap-3 text-sm"
                >
                  <span className="text-white/30 tabular-nums w-4">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <Link
                      href={`/providers/${e.provider_slug}`}
                      className="hover:text-sky-400"
                    >
                      {e.provider_name}
                    </Link>
                    <div className="text-xs text-white/40 truncate" title={e.url}>
                      {e.method} {e.url}
                    </div>
                  </div>
                  <span className="tabular-nums">{e.score.toFixed(1)}</span>
                  <span
                    className={`text-xs font-bold border rounded px-1.5 ${tierColorClass(
                      e.tier
                    )}`}
                  >
                    {e.tier}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}
