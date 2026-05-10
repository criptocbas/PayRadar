import Link from 'next/link';
import { supabasePublic } from '@/lib/supabase';
import { ENGINE_VERSION } from '@payradar/scoring-engine';
import { formatRelative } from '@/lib/format';
import { CopyButton } from './discover/_components/copy-button';

export const revalidate = 30;

interface Stats {
  providers: number;
  endpoints_active: number;
  endpoints_scored: number;
  coverage_pct: number;
  last_score_run: string | null;
}

async function fetchStats(): Promise<Stats> {
  const sb = supabasePublic();
  const [endpointsRes, scoresRes, providersRes, lastRunRes] = await Promise.all([
    sb.from('endpoints').select('*', { count: 'exact', head: true }).eq('active', true),
    sb.from('scores_current').select('*', { count: 'exact', head: true }),
    sb.from('providers').select('*', { count: 'exact', head: true }),
    sb
      .from('sync_runs')
      .select('finished_at')
      .eq('kind', 'scoring')
      .eq('ok', true)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const endpointsActive = endpointsRes.count ?? 0;
  const scored = scoresRes.count ?? 0;
  return {
    providers: providersRes.count ?? 0,
    endpoints_active: endpointsActive,
    endpoints_scored: scored,
    coverage_pct: endpointsActive > 0 ? (scored / endpointsActive) * 100 : 0,
    last_score_run: lastRunRes.data?.finished_at ?? null,
  };
}

const SDK_SNIPPET = `// Discover the best endpoint for a capability — signed, audit-ready.
const res = await fetch(
  'https://payradar.io/api/v1/discover?capability=geocode&min_score=80&sort_by=score'
);
const { results } = await res.json();
const best = results[0];

// best.score.signature is ed25519 over canonical JSON of:
//   { endpoint_id, computed_at, engine_version, score, confidence, tier, dimensions }
// Verify with the public key at /.well-known/payradar-keys.json.

console.log(\`\${best.provider.name} — score \${best.score.score} (tier \${best.score.tier})\`);
`;

export default async function Home() {
  // Best-effort: if Supabase isn't reachable yet (e.g. preview deploys without
  // env vars), the landing page still renders with placeholder stats.
  let stats: Stats | null = null;
  try {
    stats = await fetchStats();
  } catch {
    stats = null;
  }

  return (
    <div className="space-y-16">
      {/* HERO */}
      <section className="space-y-6">
        <div className="inline-flex items-center gap-2 text-xs px-3 py-1 rounded-full border border-sky-500/30 bg-sky-500/5 text-sky-400">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
          engine {ENGINE_VERSION}
        </div>
        <h1 className="text-5xl md:text-6xl font-bold tracking-tight">
          The Trust Layer
          <br />
          <span className="text-white/50">for pay.sh</span>
        </h1>
        <p className="text-lg text-white/70 max-w-2xl">
          Reliability, latency, and freshness scores for every pay-as-you-go API in the pay.sh
          catalog. With confidence intervals, cryptographic signatures, and an open-source
          formula you can audit.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/discover"
            className="px-4 py-2 rounded bg-sky-500 text-black font-semibold"
          >
            Browse the catalog →
          </Link>
          <a
            href="/api/v1/discover?limit=5"
            className="px-4 py-2 rounded border border-white/20 hover:border-white/40"
          >
            REST API
          </a>
          <a
            href="/docs/scoring/v0.1.0.md"
            className="px-4 py-2 rounded border border-white/20 hover:border-white/40"
          >
            Scoring formula
          </a>
        </div>
      </section>

      {/* LIVE STATS */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <BigStat
          label="Endpoints scored"
          value={stats ? stats.endpoints_scored.toLocaleString() : '—'}
        />
        <BigStat
          label="Providers tracked"
          value={stats ? stats.providers.toLocaleString() : '—'}
        />
        <BigStat
          label="Catalog coverage"
          value={stats ? `${stats.coverage_pct.toFixed(1)}%` : '—'}
        />
        <BigStat
          label="Last score run"
          value={stats ? formatRelative(stats.last_score_run) : '—'}
        />
      </section>

      {/* FOR AGENTS / FOR HUMANS */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <AudienceCard
          tag="For agents"
          title="Pick endpoints autonomously."
          bullets={[
            'Single GET returns ranked, filtered results in <50ms.',
            'Every score is signed (ed25519). Verify offline against the published public key.',
            'Confidence per dimension lets your planner gate on evidence quality.',
            'CORS-enabled and CDN-cached — safe to call from anywhere.',
          ]}
          cta={{ label: 'API reference', href: '/api/v1/discover?limit=5' }}
        />
        <AudienceCard
          tag="For humans"
          title="See why your agents picked what they picked."
          bullets={[
            'Sortable table with score, confidence, latency, and price for every endpoint.',
            'Click any row to see the full per-dimension breakdown and signature.',
            'Leaderboards by category. Provider pages with aggregate stats.',
            'Replay any historical score from the open-source engine.',
          ]}
          cta={{ label: 'Open the dashboard', href: '/discover' }}
        />
      </section>

      {/* SDK / SNIPPET */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wider text-sky-400 mb-1">
              Use it from your agent
            </div>
            <h2 className="text-2xl font-bold">No SDK required.</h2>
          </div>
          <CopyButton text={SDK_SNIPPET} label="Copy snippet" />
        </div>
        <pre className="text-sm bg-white/5 border border-white/10 rounded p-4 overflow-x-auto text-white/85 leading-relaxed">
{SDK_SNIPPET}
        </pre>
        <p className="text-sm text-white/50">
          Typed SDKs (TypeScript / Python / Rust) and an MCP server are on the roadmap. Until
          then the REST API is fully self-describing — see{' '}
          <a href="/docs/scoring/v0.1.0.md" className="text-sky-400 hover:text-sky-300">
            the scoring doc
          </a>{' '}
          for the canonical signed-payload schema.
        </p>
      </section>

      {/* THREE PILLARS */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-6 border-t border-white/10">
        <Feature
          title="Reliability"
          body="Wilson lower bound over weighted, decayed liveness probes. Conservative under low evidence."
        />
        <Feature
          title="Latency"
          body="p95 vs. peer baseline within each capability cohort, plus a tail-tightness bonus."
        />
        <Feature
          title="Freshness"
          body="Recent probes weigh more. Cold endpoints fade to PROVISIONAL until evidence catches up."
        />
      </section>
    </div>
  );
}

// ---------- pieces ----------

function BigStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-white/10 rounded p-4">
      <div className="text-xs uppercase tracking-wider text-white/50 mb-1">{label}</div>
      <div className="text-2xl tabular-nums">{value}</div>
    </div>
  );
}

function AudienceCard({
  tag,
  title,
  bullets,
  cta,
}: {
  tag: string;
  title: string;
  bullets: string[];
  cta: { label: string; href: string };
}) {
  return (
    <div className="border border-white/10 rounded-lg p-6 space-y-4 bg-gradient-to-b from-white/5 to-transparent">
      <div className="text-xs uppercase tracking-wider text-sky-400">{tag}</div>
      <h3 className="text-xl font-bold">{title}</h3>
      <ul className="space-y-2 text-sm text-white/80">
        {bullets.map((b) => (
          <li key={b} className="flex gap-2">
            <span className="text-sky-400 select-none">▸</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
      <Link href={cta.href} className="inline-block text-sm text-sky-400 hover:text-sky-300">
        {cta.label} →
      </Link>
    </div>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="border border-white/10 rounded p-4 space-y-1">
      <div className="text-xs uppercase tracking-wider text-sky-400">{title}</div>
      <div className="text-sm text-white/80">{body}</div>
    </div>
  );
}
