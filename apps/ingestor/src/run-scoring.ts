import { randomUUID } from 'node:crypto';
import type { ProbeRecord } from '@payradar/schema';
import {
  reliabilityScore,
  latencyScore,
  freshnessScore,
  aggregate,
  ENGINE_VERSION,
  computePeerBaselines,
  lookupPeerBaseline,
} from '@payradar/scoring-engine';
import { supabase } from './supabase.js';
import { loadSigner } from './keys.js';

const PROBE_LOOKBACK_HOURS = 30 * 24;

// Postgres's timestamptz text output strips trailing zeros from the fractional
// second (and drops the decimal entirely when all zeros). JS `toISOString()`
// always emits `.XYZ` (3 digits). To make signed payloads byte-equal to the
// round-tripped API response, normalize to Postgres's exact form before signing.
//   .450+00:00  -> .45+00:00
//   .123+00:00  -> .123+00:00   (unchanged)
//   .100+00:00  -> .1+00:00
//   .000+00:00  -> +00:00       (decimal removed)
function pgTimestampForm(date: Date): string {
  let s = date.toISOString().replace('Z', '+00:00');
  s = s.replace(/\.(\d+?)0+(\+\d{2}:\d{2})$/, '.$1$2');
  s = s.replace(/\.0+(\+\d{2}:\d{2})$/, '$1');
  return s;
}

export interface ScoringResult {
  endpoints_scored: number;
  endpoints_skipped: number;
  scores_signed: number;
  duration_ms: number;
}

export async function runScoring(): Promise<ScoringResult> {
  const startedAt = Date.now();
  const now = new Date();
  const sb = supabase();
  const signer = await loadSigner();

  const { data: endpoints, error } = await sb
    .from('endpoints')
    .select('id, capabilities, last_seen_in_catalog')
    .eq('active', true);
  if (error) throw error;
  if (!endpoints || endpoints.length === 0) {
    return {
      endpoints_scored: 0,
      endpoints_skipped: 0,
      scores_signed: 0,
      duration_ms: Date.now() - startedAt,
    };
  }

  // Pull the last 30d of probes per endpoint, paginated. PostgREST caps a
  // single response at 1000 rows by default — without paging we'd silently
  // drop most probe evidence past row 1000 and every score's evidence_count
  // would max out at ~1000/endpoints (~1.4 at v0 scale). Chunk by stable
  // ordering on probe_id (text PK) so the next page picks up where the prior
  // left off.
  const since = new Date(now.getTime() - PROBE_LOOKBACK_HOURS * 3600 * 1000).toISOString();
  const PAGE = 1000;
  const probes: Array<{
    probe_id: string;
    endpoint_id: string;
    ts: string;
    probe_type: string;
    ok: boolean;
    http_status: number | null;
    latency_ms: number | null;
    tls_valid: boolean | null;
  }> = [];
  let cursor = '';
  while (true) {
    const q = sb
      .from('probes')
      .select('probe_id, endpoint_id, ts, probe_type, ok, http_status, latency_ms, tls_valid')
      .gte('ts', since)
      .order('probe_id', { ascending: true })
      .limit(PAGE);
    const { data: page, error: probeErr } = cursor
      ? await q.gt('probe_id', cursor)
      : await q;
    if (probeErr) throw probeErr;
    if (!page || page.length === 0) break;
    probes.push(...(page as typeof probes));
    if (page.length < PAGE) break;
    cursor = page[page.length - 1]!.probe_id;
  }

  const probesByEndpoint = new Map<string, ProbeRecord[]>();
  for (const p of probes ?? []) {
    const list = probesByEndpoint.get(p.endpoint_id) ?? [];
    list.push(p as ProbeRecord);
    probesByEndpoint.set(p.endpoint_id, list);
  }

  // Build capability → endpoints map (one endpoint can be a peer in multiple
  // cohorts). The peer baseline is computed once per scoring run.
  const endpointsByCapability = new Map<string, string[]>();
  for (const ep of endpoints) {
    for (const cap of (ep.capabilities ?? []) as string[]) {
      const list = endpointsByCapability.get(cap) ?? [];
      list.push(ep.id);
      endpointsByCapability.set(cap, list);
    }
  }
  const baselines = computePeerBaselines(endpointsByCapability, probesByEndpoint);

  const currentRows: Array<Record<string, unknown>> = [];
  const historyRows: Array<Record<string, unknown>> = [];
  let scored = 0;
  let skipped = 0;
  let signedCount = 0;

  for (const ep of endpoints) {
    const epProbes = probesByEndpoint.get(ep.id) ?? [];
    const lastProbeTs = epProbes.length > 0
      ? new Date(
          Math.max(...epProbes.map((p) => new Date(p.ts).getTime()))
        )
      : null;
    const lastSeenInCatalog = new Date(ep.last_seen_in_catalog);

    if (epProbes.length === 0) {
      // Even with zero probes we still emit a freshness-only score, so cold
      // endpoints show up in the dashboard with PROVISIONAL tier instead of
      // disappearing entirely.
      const freshness = freshnessScore(lastProbeTs, lastSeenInCatalog, now);
      const dimensions = { freshness };
      const { score, confidence, tier } = aggregate(dimensions);
      const scoreId = `scr_${randomUUID()}`;
      const computedAt = pgTimestampForm(now);

      const corePayload = {
        endpoint_id: ep.id,
        computed_at: computedAt,
        engine_version: ENGINE_VERSION,
        score,
        confidence,
        tier,
        dimensions,
      };
      const signature = signer ? await signer.sign(corePayload) : null;
      if (signature) signedCount++;

      const row = { score_id: scoreId, ...corePayload, signature };
      currentRows.push(row);
      historyRows.push(row);
      skipped++;
      continue;
    }

    const peerP95 = lookupPeerBaseline((ep.capabilities ?? []) as string[], baselines);

    const reliability = reliabilityScore(epProbes, now);
    const latency = latencyScore(epProbes, peerP95, now);
    const freshness = freshnessScore(lastProbeTs, lastSeenInCatalog, now);
    const dimensions = { reliability, latency, freshness };
    const { score, confidence, tier } = aggregate(dimensions);

    const scoreId = `scr_${randomUUID()}`;
    const computedAt = pgTimestampForm(now);

    // Sign over the canonical form of the score's load-bearing fields. score_id
    // is intentionally excluded so the same evidence produces the same signature
    // (replay-friendly).
    const corePayload = {
      endpoint_id: ep.id,
      computed_at: computedAt,
      engine_version: ENGINE_VERSION,
      score,
      confidence,
      tier,
      dimensions,
    };
    const signature = signer ? await signer.sign(corePayload) : null;
    if (signature) signedCount++;

    const row = { score_id: scoreId, ...corePayload, signature };
    currentRows.push(row);
    historyRows.push(row);
    scored++;
  }

  if (currentRows.length > 0) {
    const { error: upsertErr } = await sb
      .from('scores_current')
      .upsert(currentRows, { onConflict: 'endpoint_id' });
    if (upsertErr) throw upsertErr;
  }
  if (historyRows.length > 0) {
    const { error: histErr } = await sb.from('scores_history').insert(historyRows);
    if (histErr) throw histErr;
  }

  return {
    endpoints_scored: scored,
    endpoints_skipped: skipped,
    scores_signed: signedCount,
    duration_ms: Date.now() - startedAt,
  };
}
