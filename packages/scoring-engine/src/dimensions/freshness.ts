import type { DimensionScore } from '@payradar/schema';

export const VERSION = '0.1.0';
export const WEIGHT = 0.10;

const PROBE_HALF_LIFE_HOURS = 6;
const CATALOG_HALF_LIFE_HOURS = 24;

// Freshness rewards endpoints we have *current* evidence about. Cold endpoints
// — even ones that tested fine a week ago — should be downranked because we
// can't credibly claim they're still healthy.
export function freshnessScore(
  lastProbeTs: Date | null,
  lastSeenInCatalog: Date,
  now: Date
): DimensionScore {
  function decayFactor(ts: Date | null, halfLifeHours: number): number {
    if (!ts) return 0;
    const hoursAgo = (now.getTime() - ts.getTime()) / 3_600_000;
    if (hoursAgo <= 0) return 100;
    return 100 * Math.pow(0.5, hoursAgo / halfLifeHours);
  }

  const probeFreshness = decayFactor(lastProbeTs, PROBE_HALF_LIFE_HOURS);
  const catalogFreshness = decayFactor(lastSeenInCatalog, CATALOG_HALF_LIFE_HOURS);
  const score = 0.7 * probeFreshness + 0.3 * catalogFreshness;

  // Confidence is high when we actually have a recent probe;
  // missing probe = we're guessing from catalog presence alone.
  const confidence = lastProbeTs ? 1.0 : 0.5;

  return {
    score: Math.round(score * 10) / 10,
    confidence,
    weight: WEIGHT,
    evidence_count: lastProbeTs ? 1 : 0,
    version: VERSION,
  };
}
