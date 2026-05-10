import type { DimensionScore, ProbeRecord } from '@payradar/schema';

export const VERSION = '0.1.0';
export const WEIGHT = 0.333;

const HALF_LIFE_HOURS = 24; // recent latency matters far more than week-old latency

// Default global baseline; the ingestor can pass a per-capability baseline
// computed from peer endpoints to score like-with-like.
export const DEFAULT_PEER_P95_MS = 1500;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}

export function latencyScore(
  probes: ProbeRecord[],
  peerBaselineP95Ms: number,
  now: Date
): DimensionScore {
  // Only successful probes with measured latency contribute.
  const samples: { latency: number; weight: number }[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    if (typeof probe.latency_ms !== 'number') continue;
    const hoursAgo = (now.getTime() - new Date(probe.ts).getTime()) / 3_600_000;
    if (hoursAgo < 0) continue;
    const decay = Math.pow(0.5, hoursAgo / HALF_LIFE_HOURS);
    samples.push({ latency: probe.latency_ms, weight: decay });
  }

  if (samples.length === 0) {
    return {
      score: 50,
      confidence: 0,
      weight: WEIGHT,
      evidence_count: 0,
      version: VERSION,
    };
  }

  const sorted = samples.map((s) => s.latency).sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const p99 = percentile(sorted, 0.99);

  const baseline = Math.max(1, peerBaselineP95Ms);

  // 100 if p95 ≤ half of baseline (much faster than peers).
  // 0 if p95 ≥ 2× baseline (much slower than peers).
  const ratio = p95 / baseline;
  const base = Math.max(0, Math.min(100, 100 * (2 - ratio)));

  // Tail tightness bonus: reward predictable latency (low p99/p50 ratio).
  // 0 to +10 points.
  const tailRatio = p50 > 0 ? p99 / p50 : 1;
  const tailBonus = Math.max(0, Math.min(10, 10 - (tailRatio - 1) * 5));

  const score = Math.min(100, base + tailBonus);

  // Confidence saturates around 100 successful samples.
  const confidence = Math.min(1, Math.log10(samples.length + 1) / 2);

  return {
    score: Math.round(score * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    weight: WEIGHT,
    evidence_count: samples.length,
    version: VERSION,
  };
}
