import { ENGINE_VERSION } from '@payradar/scoring-engine';
import { supabasePublic } from '@/lib/supabase';

export const runtime = 'nodejs';
export const revalidate = 30;

interface RunSummary {
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  duration_ms: number | null;
  details: unknown;
}

async function lastRunByKind(
  sb: ReturnType<typeof supabasePublic>,
  kind: 'catalog' | 'probes' | 'scoring'
): Promise<RunSummary | null> {
  const { data } = await sb
    .from('sync_runs')
    .select('started_at, finished_at, ok, details')
    .eq('kind', kind)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const duration =
    data.finished_at && data.started_at
      ? new Date(data.finished_at).getTime() - new Date(data.started_at).getTime()
      : null;
  return {
    started_at: data.started_at,
    finished_at: data.finished_at,
    ok: data.ok,
    duration_ms: duration,
    details: data.details,
  };
}

export async function GET() {
  const sb = supabasePublic();

  // All counts and last-run lookups run in parallel — the status endpoint
  // is on a hot path for monitoring/dashboards.
  const [endpointsRes, scoresRes, providersRes, catalogRun, probesRun, scoringRun] =
    await Promise.all([
      sb.from('endpoints').select('*', { count: 'exact', head: true }).eq('active', true),
      sb.from('scores_current').select('*', { count: 'exact', head: true }),
      sb.from('providers').select('*', { count: 'exact', head: true }),
      lastRunByKind(sb, 'catalog'),
      lastRunByKind(sb, 'probes'),
      lastRunByKind(sb, 'scoring'),
    ]);

  const endpointsActive = endpointsRes.count ?? 0;
  const scored = scoresRes.count ?? 0;
  const providers = providersRes.count ?? 0;
  const coverage_pct = endpointsActive > 0 ? (scored / endpointsActive) * 100 : 0;

  const body = {
    ok: true,
    service: 'payradar-web',
    engine_version: ENGINE_VERSION,
    ts: new Date().toISOString(),
    catalog: {
      providers,
      endpoints_active: endpointsActive,
      endpoints_scored: scored,
      coverage_pct: Math.round(coverage_pct * 10) / 10,
    },
    last_runs: {
      catalog: catalogRun,
      probes: probesRun,
      scoring: scoringRun,
    },
  };

  return Response.json(body, {
    headers: {
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
