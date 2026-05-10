# PayRadar

**The Trust + Discovery Intelligence Layer for the [pay.sh](https://pay.sh) catalog.**

Every pay-as-you-go API in the pay.sh ecosystem, scored on reliability, latency, and freshness — with confidence intervals you can audit and ed25519 signatures your agents can verify offline. Open formula. Open code. Open data.

> 🔗 **Live:** _set after first deploy._ Dev locally with `pnpm -F @payradar/web dev`.

---

## Why this exists

The pay.sh catalog has ~70 providers and ~830 endpoints today and is growing weekly. Autonomous agents pick endpoints from `PAY.md` files with no idea which providers are reliable, fairly priced, or even alive. Humans operating those agents have no single pane of glass.

PayRadar fills the gap with an **opinionated, transparent, agent-first** intelligence layer. Think CoinGecko + DefiLlama, but for paid agent APIs.

What sets it apart from existing surfaces (e.g. radar.infopunks.fun):

- **Open formula.** The scoring engine is MIT-licensed. Every score is replayable from public evidence + a versioned formula. See [`apps/web/public/docs/scoring/v0.1.0.md`](apps/web/public/docs/scoring/v0.1.0.md).
- **Cryptographically signed scores.** Every score is signed with ed25519 over canonical JSON. Public key at `/.well-known/payradar-keys.json`. Verify offline.
- **Confidence-as-first-class.** Each dimension carries `confidence ∈ [0,1]`. The aggregator weights by `weight × confidence` so under-evidenced dimensions can't move the score.
- **Agent-native API.** REST + JSON, CDN-cached, CORS-enabled, sub-50ms p95.

---

## Quickstart for agents

```ts
// One GET. Ranked, filtered, signed.
const res = await fetch(
  'https://payradar.io/api/v1/discover?capability=geocode&min_score=80&sort_by=score'
);
const { results } = await res.json();
const best = results[0];

// best.score.signature is ed25519 over:
//   { endpoint_id, computed_at, engine_version, score, confidence, tier, dimensions }
// Verify against the public key at /.well-known/payradar-keys.json.

console.log(`${best.provider.name} — ${best.score.score} (tier ${best.score.tier})`);
```

### MCP tool registration

Each endpoint comes with a copy-paste MCP-shaped tool snippet (visible in the dashboard score modal):

```ts
{
  name: "forwardGeocode",
  description: "Acme Geocoding — geocode.forward (PayRadar score 87.4 / tier A)",
  inputSchema: { type: "object", properties: {} /* see provider OpenAPI */ },
  handler: async (input) => {
    const res = await fetch("https://api.acme.example.com/v1/geocode/forward", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": await getX402Token(),
      },
      body: JSON.stringify(input),
    });
    return res.json();
  },
}
```

### Verify a signature

```ts
import { verifySignature } from '@payradar/scoring-engine';

const score = best.score; // from /v1/discover
const { keys } = await (await fetch('https://payradar.io/.well-known/payradar-keys.json')).json();
const key = keys.find((k) => k.kid === score.signature.key_id);

const signedPayload = {
  endpoint_id: score.endpoint_id,
  computed_at: score.computed_at,
  engine_version: score.engine_version,
  score: score.score,
  confidence: score.confidence,
  tier: score.tier,
  dimensions: score.dimensions,
};

const valid = await verifySignature(signedPayload, score.signature, key.public_key_hex);
//          ^^^ true if and only if the signed-on-server score wasn't modified.
```

---

## API endpoints (v0.1)

| Path | What |
|---|---|
| `GET /api/v1/discover` | Ranked endpoint search. Params: `capability`, `category`, `min_score`, `max_price_usd`, `sort_by`, `limit`. |
| `GET /api/v1/status` | Coverage, last sync timestamps, engine version. |
| `GET /api/health` | Cheap liveness. |
| `GET /.well-known/payradar-keys.json` | Oracle public keys for signature verification. |
| `GET /docs/scoring/v0.1.0.md` | Full scoring formula. |

CORS open, `Cache-Control: public, s-maxage=30, stale-while-revalidate=60`. Rate-limited per IP at 60/min.

---

## How scoring works (one paragraph)

Each endpoint has a Score that is `aggregate(reliability, latency, freshness)`. Reliability is a Wilson lower bound on weighted-decayed probe success rate. Latency compares p95 to a peer baseline (median p95 across other endpoints sharing the same capability tag). Freshness rewards recent evidence with half-life decay. Each dimension emits both a `score` (0–100) and a `confidence` (0–1); the aggregator weights by `weight × confidence`, so under-evidenced dimensions naturally fade. Cold-start endpoints (< 50 evidence points) are tier-capped at PROVISIONAL. Full math, weights, half-lives in [`/docs/scoring/v0.1.0.md`](apps/web/public/docs/scoring/v0.1.0.md).

---

## Local development

```bash
corepack enable && corepack prepare pnpm@9.12.0 --activate
pnpm install

# Build internal packages
pnpm -F @payradar/schema build
pnpm -F @payradar/scoring-engine build

# Apply Supabase migrations
supabase link --project-ref <YOUR-REF>
supabase db push

# Generate the oracle signing key (paste output into .env.local)
pnpm -F @payradar/ingestor exec tsx src/keygen.ts

# Smoke test
cp .env.example .env.local   # fill in
pnpm -F @payradar/ingestor sync && pnpm -F @payradar/ingestor probe && pnpm -F @payradar/ingestor score
pnpm -F @payradar/web dev    # http://localhost:3000
```

Full deployment instructions including RLS verification and end-to-end signature checking are in [`DEPLOYMENT_CHECKLIST.md`](DEPLOYMENT_CHECKLIST.md).

---

## Repo layout

```
apps/
  web/         Next.js 15 dashboard + REST API + cron routes (Vercel)
  ingestor/    Catalog sync + liveness probes + scoring runner
packages/
  schema/             @payradar/schema      (Zod source of truth)
  scoring-engine/     @payradar/scoring-engine  (MIT, OSS — reuse anywhere)
supabase/
  migrations/  SQL migrations (forward-only)
docs/
  PGVECTOR_UPGRADE.md   semantic capability search upgrade path
DEPLOYMENT_CHECKLIST.md  full launch checklist
PAYRADAR_SPEC.md         the original product + architecture spec
```

---

## Roadmap

- **v0.1 (now)** — reliability + latency + freshness, signed scores, public dashboard, REST API, leaderboards, provider pages.
- **v0.2** — synthetic paid probes (real x402 calls), pgvector semantic capability search, TS SDK, MCP server.
- **v0.3** — geo-distributed probes, on-chain attestations (Switchboard / Solana Attestation Service), provider claim flow.
- **v0.4** — trust + security + pricing-value + community-adoption + on-chain-reputation dimensions live.
- **v0.5** — disputes, governance, public Parquet datasets, Python + Rust SDKs.

---

## Contributing

The scoring engine is MIT and open from day 1. Issues and PRs welcome at:

- **Score correctness / formula bugs:** open an issue with the `score_id` (every score has one) and what you expected. The score is replayable.
- **New dimensions:** propose a pure function `(evidence) -> {score, confidence, weight, evidence_count, version}` and a doc patch to `/docs/scoring/vX.Y.Z.md`. The contract is intentionally narrow.
- **Provider disputes:** until the in-app dispute pipeline ships, open a GitHub issue tagged `dispute`. Include the endpoint ID, the dimension you're disputing, and evidence.

The trust layer for autonomous agents only works if it's auditable. Treat formula changes the way blockchain projects treat consensus changes — versioned, public, replayable, and never silent.

---

## License

- `packages/scoring-engine` — **MIT**
- Everything else — **MIT**

The signing key, ops infra, and the `payradar.io` deployment are operated by the project maintainers and are not part of the open-source license.
