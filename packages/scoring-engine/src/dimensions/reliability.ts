import type { DimensionScore, ProbeRecord } from '@payradar/schema';

export const VERSION = '0.1.0';
export const WEIGHT = 0.667;

const HALF_LIFE_HOURS = 24 * 7; // probes from a week ago count half as much
const Z = 1.96; // 95% Wilson interval

// Different probe types carry different evidential weight.
// Telemetry is the realest signal (real users); paid synthetic is next;
// liveness is cheapest and most game-able.
function probeTypeWeight(type: ProbeRecord['probe_type']): number {
  switch (type) {
    case 'telemetry':
      return 1.0;
    case 'synthetic_paid':
      return 0.9;
    case 'liveness':
      return 0.5;
    case 'security':
      return 0; // doesn't bear on uptime
  }
}

// Wilson lower bound — robust at small sample sizes, where a naive
// success-rate would give wildly overconfident readings.
function wilsonLowerBound(p: number, n: number): number {
  if (n <= 0) return 0;
  const denom = 1 + (Z * Z) / n;
  const center = (p + (Z * Z) / (2 * n)) / denom;
  const margin = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / denom;
  return Math.max(0, center - margin);
}

export function reliabilityScore(probes: ProbeRecord[], now: Date): DimensionScore {
  if (probes.length === 0) {
    return {
      score: 50, // neutral prior — no evidence either way
      confidence: 0,
      weight: WEIGHT,
      evidence_count: 0,
      version: VERSION,
    };
  }

  let weightedSuccesses = 0;
  let weightedTotal = 0;

  for (const probe of probes) {
    const hoursAgo = (now.getTime() - new Date(probe.ts).getTime()) / 3_600_000;
    if (hoursAgo < 0) continue; // future-dated probe, skip
    const decay = Math.pow(0.5, hoursAgo / HALF_LIFE_HOURS);
    const w = probeTypeWeight(probe.probe_type) * decay;
    if (w === 0) continue;

    weightedTotal += w;
    if (probe.ok) weightedSuccesses += w;
  }

  if (weightedTotal === 0) {
    return {
      score: 50,
      confidence: 0,
      weight: WEIGHT,
      evidence_count: probes.length,
      version: VERSION,
    };
  }

  const p = weightedSuccesses / weightedTotal;
  const lower = wilsonLowerBound(p, weightedTotal);

  // Confidence rises with sample size, log-scaled. ~316 probes saturates.
  const confidence = Math.min(1, Math.log10(probes.length + 1) / 2.5);

  return {
    score: Math.round(lower * 1000) / 10,
    confidence: Math.round(confidence * 100) / 100,
    weight: WEIGHT,
    evidence_count: probes.length,
    version: VERSION,
  };
}
