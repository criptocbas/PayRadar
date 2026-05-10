# @payradar/scoring-engine

Open-source, deterministic, replayable scoring engine for [PayRadar](https://payradar.io) — the trust + discovery intelligence layer for the pay.sh catalog.

**MIT licensed. Open from day 1.** The trust layer for autonomous agents must be auditable.

## Design contract

1. **Pure.** Each dimension is `(evidence) -> DimensionScore`. No I/O, no clocks, no randomness. The clock is passed in.
2. **Versioned.** Every dimension exports a `VERSION` constant baked into its output. Old versions stay runnable forever for replay.
3. **Confidence-aware.** Every dimension emits `confidence ∈ [0,1]` alongside its `score`. The aggregator weights by `weight × confidence`, so under-evidenced dimensions naturally fade.
4. **Deterministic.** Same input → same output, byte-for-byte.

## v0 dimensions

| Dimension | Weight | Confidence basis |
|---|---|---|
| `reliability` | 0.667 | log10(n) over weighted+decayed Wilson lower bound |
| `latency` | 0.333 | log10(n) over successful samples vs. peer p95 baseline |

Other v1 dimensions (trust, signal, security, pricing-value, community-adoption, on-chain-reputation, freshness) are stubbed at zero weight in v0.

## Usage

```ts
import {
  reliabilityScore,
  latencyScore,
  aggregate,
  ENGINE_VERSION,
} from '@payradar/scoring-engine';

const now = new Date();
const dims = {
  reliability: reliabilityScore(probes, now),
  latency: latencyScore(probes, peerP95Ms, now),
};
const { score, confidence, tier } = aggregate(dims);
```

## Replay

To reproduce any historical score: pass the same probe set and `now` to the same package version. That's it.
