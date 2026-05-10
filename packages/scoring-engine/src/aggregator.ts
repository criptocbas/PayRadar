import type { DimensionScore, Tier } from '@payradar/schema';

export interface AggregateResult {
  score: number;
  confidence: number;
  tier: Tier;
}

const COLD_START_EVIDENCE_THRESHOLD = 50;
const COLD_START_SCORE_CAP = 65;

// Default weights for v0.1 (sums to 1.0).
//   reliability: 0.60  — does it work?
//   latency:     0.30  — is it fast?
//   freshness:   0.10  — is our evidence recent?
//
// Stub dimensions (trust, signal, security, pricing_value, community_adoption,
// onchain_reputation) keep their defined weight in @payradar/schema but are
// not yet emitted by the engine — so they don't appear in `dimensions` and
// thus don't affect the aggregate.
export const DEFAULT_WEIGHTS: Record<string, number> = {
  reliability: 0.60,
  latency: 0.30,
  freshness: 0.10,
};

function tierFor(score: number): Exclude<Tier, 'PROVISIONAL'> {
  if (score >= 92) return 'S';
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  if (score >= 30) return 'D';
  return 'F';
}

// Aggregator weights each dimension by `weight × confidence`, so a perfectly-
// scored dimension with no evidence contributes nothing. This is the v0
// safety mechanism in lieu of full Bayesian priors per dimension.
export function aggregate(
  dimensions: Record<string, DimensionScore>,
  weightOverrides?: Record<string, number>
): AggregateResult {
  let weightedScoreNumerator = 0;
  let weightedConfidenceNumerator = 0;
  let totalEffectiveWeight = 0;
  let totalEvidence = 0;
  let totalNominalWeight = 0;

  for (const [name, dim] of Object.entries(dimensions)) {
    const w = weightOverrides?.[name] ?? DEFAULT_WEIGHTS[name] ?? dim.weight;
    if (w <= 0) continue;

    const effective = w * dim.confidence;
    weightedScoreNumerator += dim.score * effective;
    weightedConfidenceNumerator += dim.confidence * w;
    totalEffectiveWeight += effective;
    totalNominalWeight += w;
    totalEvidence += dim.evidence_count;
  }

  const score = totalEffectiveWeight > 0 ? weightedScoreNumerator / totalEffectiveWeight : 50;
  const confidence =
    totalNominalWeight > 0 ? weightedConfidenceNumerator / totalNominalWeight : 0;

  let finalScore = score;
  let tier: Tier;
  if (totalEvidence < COLD_START_EVIDENCE_THRESHOLD) {
    finalScore = Math.min(score, COLD_START_SCORE_CAP);
    tier = 'PROVISIONAL';
  } else {
    tier = tierFor(finalScore);
  }

  return {
    score: Math.round(finalScore * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    tier,
  };
}
