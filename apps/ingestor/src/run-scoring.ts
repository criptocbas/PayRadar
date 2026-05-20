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

interface ScoringResult {
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

  // Pull the last 30d of probes per endpoint. Single SELECT is fine at v0
  // scale (~834 endpoints × O(1k) probes each); chunk this when probe volume
  // crosses ~1M rows.
  const since = new Date(now.getTime() - PROBE_LOOKBACK_HOURS * 3600 * 1000).toISOString();
  const { data: probes, error: probeErr } = await sb
    .from('probes')
    .select('probe_id, endpoint_id, ts, probe_type, ok, http_status, latency_ms, tls_valid')
    .gte('ts', since);
  if (probeErr) throw probeErr;

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
      // Use the same +00:00 form Postgres echoes back, so a verifier can rebuild
    // the signed payload from the API response bytes-for-bytes.
    const computedAt = now.toISOString().replace('Z', '+00:00');

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
    // Use the same +00:00 form Postgres echoes back, so a verifier can rebuild
    // the signed payload from the API response bytes-for-bytes.
    const computedAt = now.toISOString().replace('Z', '+00:00');

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
