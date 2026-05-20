# CLAUDE.md — PayRadar handoff

> **Read this before doing anything in this repo.** This is the operational guide for any agent (or human) picking up the project mid-flight. It assumes you have not seen the prior conversation. The product spec lives in `PAYRADAR_SPEC.md`; the deploy runbook in `DEPLOYMENT_CHECKLIST.md`. This file is the *opinionated overlay* on top of those — invariants, conventions, gotchas, and current state.

---

## TL;DR — current state (as of 2026-05-20)

**Shipped. Running in prod.**

- **Live:** https://pay-radar-web.vercel.app
- **Repo:** https://github.com/criptocbas/PayRadar (auto-deploys on push to `main`)
- **DB:** Supabase project `xhdnnlfceuvjzuipibzi`. **Owned by a Supabase account OTHER than `criptocbas`** (the user's `sbarrientos2` account — used because `criptocbas` was already at the free-tier 2-project cap).
- **Cron:** GitHub Actions `.github/workflows/sync.yml` GETs `/api/cron/sync` every 30 min via `PAYRADAR_CRON_SECRET`. Vercel daily cron (`0 0 * * *` in `apps/web/vercel.json`) is the fallback — Hobby tier disallows sub-daily.
- **Oracle key:** kid `pr-oracle-2026-q2`, public key at `/.well-known/payradar-keys.json`. End-to-end signature verify confirmed live against prod (3/3 on launch day).

The v0.1 launch surfaced several deploy-time gotchas — see the new gotcha #s 13-17 below. The code that shipped on 2026-05-20 already accounts for them; the gotchas exist so the next change doesn't regress.

Resume work from "v0.2 priorities" below, or work off whatever the user brings up.

---

## What PayRadar is

A trust + discovery intelligence layer for the [pay.sh](https://pay.sh) catalog (~72 providers, ~834 endpoints — pay-as-you-go APIs for AI agents on Solana). Every endpoint scored on **reliability**, **latency**, and **freshness** with confidence intervals; scores signed with ed25519 so agents can verify offline. Open formula, replayable scores, agent-first REST API. Differentiated from `radar.infopunks.fun` by being auditable, signed, and machine-consumable.

---

## Architecture (60-second mental model)

```
pay.sh/api/catalog  ─┐
                     ├──> [ingestor: sync → probe → score]
                     │         │
                     ▼         ▼
                  Postgres  ed25519 signer
                     │         │
                     ▼         ▼
              [Next.js: REST + dashboard]  ──>  agents (verify offline)
                     ▲                          via /.well-known/payradar-keys.json
                     │
                  CDN cache (30s)
```

- **One Postgres backend** — Supabase (or Neon, TBD).
- **One Next.js app on Vercel** — serves dashboard + REST + cron.
- **One ingestor package** — runs from Vercel Cron (`/api/cron/sync`) or local CLI.
- **Two shared packages** — `@payradar/schema` (Zod) and `@payradar/scoring-engine` (MIT).

---

## Load-bearing invariants — DO NOT break these without a version bump

1. **Every dimension emits `confidence ∈ [0,1]` alongside `score`.** The aggregator weights by `weight × confidence`. Under-evidenced dimensions must not move the score. Skipping confidence is a load-bearing-correctness bug.

2. **Scoring functions are pure.** No I/O, no `Date.now()`, no `Math.random()`. The clock is passed in as `now: Date`. This is what makes scores replayable.

3. **Versions everywhere.** Each dimension exports its own `VERSION`; the engine exports `ENGINE_VERSION`. Both are written into every `Score` record. Changing a dimension formula = bump that dimension's version *and* `ENGINE_VERSION`.

4. **The signed payload is exactly these fields, no more no less:**
   ```ts
   {
     endpoint_id, computed_at, engine_version,
     score, confidence, tier, dimensions
   }
   ```
   `score_id` and `last_probe_ts` are **intentionally excluded** so the same evidence produces the same signature (replay-friendly). If you add a field to `Score`, decide explicitly whether it's in or out of the signature scope and document it.

5. **Migrations are forward-only.** No editing `0001_*.sql` after it's applied anywhere. To undo, write `0003_revert_*.sql`. Never delete an old migration.

6. **`@payradar/scoring-engine` stays MIT.** The trust layer's value depends on being auditable. Don't add proprietary deps. Don't add network calls. The package exports pure math + ed25519.

7. **The pgvector migration template is non-applied.** `supabase/migrations/0003_capability_embeddings.sql.template` has a `.template` suffix specifically to keep it out of `supabase db push`. Renaming to `.sql` triggers semantic-search rollout — don't do that without reading `docs/PGVECTOR_UPGRADE.md`.

8. **Confidence-as-first-class is the v0 differentiator.** Don't let it slip. Every `DimensionScore` carries it; `aggregate()` uses it; the API returns it; the modal renders it.

---

## Codebase map

```
apps/
  web/                           Next.js 15 — dashboard + REST API + Vercel cron
    app/page.tsx                   landing (hero, live stats, agent/human cards)
    app/discover/page.tsx          server: fetches search_endpoints RPC + leaderboards
    app/discover/_components/
      discover-table.tsx             client: sortable table + row click → modal
      score-modal.tsx                client: dimension breakdown + verify button + MCP snippet
      verify-button.tsx              client: ed25519 verify against /.well-known
      copy-button.tsx                client: clipboard helper
    app/providers/[slug]/page.tsx  provider detail
    app/api/v1/discover/route.ts   GET: rate-limited, calls search_endpoints RPC
    app/api/v1/status/route.ts     GET: coverage % + last-run timestamps
    app/api/health/route.ts        GET: cheap liveness
    app/api/cron/sync/route.ts     POST trigger: bearer-auth'd, runs sync→probe→score
    app/api/well-known/keys/route.ts  GET: oracle public keys (rewritten from /.well-known/payradar-keys.json)
    lib/{supabase,format,ratelimit}.ts
    next.config.mjs                transpilePackages + .well-known rewrite
    vercel.json                    cron: */5 * * * *  (NOTE: requires Pro plan)

  ingestor/                      catalog sync + liveness probes + scoring
    src/sync-catalog.ts            two-tier fetch (catalog summaries then per-provider endpoints),
                                   defensive zod parse, pricing normalization, upsert, mark-inactive
    src/run-probes.ts              HEAD/GET liveness, 8s timeout, concurrency 16
    src/run-scoring.ts             reliability + latency + freshness, peer baselines, signs each score
    src/track.ts                   trackRun() wrapper writes to sync_runs
    src/keys.ts / src/keygen.ts    signer loader / one-shot keypair generator
    src/cli.ts                     local: pnpm sync / probe / score / all
    src/index.ts                   wraps exports with trackRun (cron + CLI use these)

packages/
  schema/                        @payradar/schema — Zod source of truth
    src/index.ts                   ALL shared types (Provider, Endpoint, Probe, DimensionScore, Score, DiscoverQuery, ...)
  scoring-engine/                @payradar/scoring-engine — MIT, OSS
    src/dimensions/
      reliability.ts                 Wilson lower bound over weighted-decayed probes
      latency.ts                     p95 vs peer baseline + tail-tightness bonus
      freshness.ts                   half-life decay over last probe + last catalog sighting
    src/peer-baselines.ts          capability-cohort p95 medians (≥5 samples, ≥2 peers)
    src/aggregator.ts              DEFAULT_WEIGHTS = {reliability: 0.6, latency: 0.3, freshness: 0.1}
    src/signer.ts                  makeSigner(), verifySignature(), generateKeyPair()
    src/canonical-json.ts          deterministic stringify (sorted keys, no whitespace)

supabase/migrations/
  0001_initial.sql               base schema, RLS public-read policies, discover_view
  0002_search_freshness.sql      pg_trgm, sync_runs, refreshed view, search_endpoints RPC
  0003_capability_embeddings.sql.template   pgvector upgrade (NOT auto-applied)

.github/workflows/
  sync.yml                       every-30-min cron: GET /api/cron/sync with PAYRADAR_CRON_SECRET.
                                 Needs repo secrets PAYRADAR_DEPLOY_URL + PAYRADAR_CRON_SECRET.

docs/
  PGVECTOR_UPGRADE.md            semantic search upgrade path + tradeoffs

apps/web/public/docs/scoring/v0.1.0.md   public scoring formula (linked from every score)
DEPLOYMENT_CHECKLIST.md          step-by-step launch runbook (RLS smoketest + sig verify)
PAYRADAR_SPEC.md                 original product + architecture spec
README.md                        public pitch + agent quickstart + MCP example
```

---

## Conventions you must follow

### Types
- All shared types come from `@payradar/schema`. Never re-declare a `Provider` or `Score` shape in another package — import it.
- Zod schemas are the source of truth; TypeScript types are inferred via `z.infer`.
- API responses validate against schema before being returned.

### Imports
- Workspace packages use `workspace:*` in package.json.
- Always import from `@payradar/scoring-engine` (root export), not from `@payradar/scoring-engine/dimensions/reliability` unless you need a specific subpath export.
- Server-only modules (signer, service-role supabase client) must NEVER be imported into a client component. The `'use client'` directive at the top is a contract.

### File naming
- Route handlers: `app/api/.../route.ts`
- Client components: in `_components/` directories (Next.js convention to exclude from routing)
- Server utilities: `lib/`

### SQL
- Forward-only migrations.
- Tables/views are queried via either:
  - `supabase.from('table_name').select(...)` for simple reads
  - `supabase.rpc('function_name', {...})` for complex queries (e.g. `search_endpoints`)
- New columns/tables go in a new migration file. Don't edit historical ones.
- All public-readable tables need an explicit `create policy "public read X" on X for select using (true)`.

### Comments
- Default to none. Only write a comment if the *why* would otherwise be invisible (a non-obvious invariant, a workaround, a deliberate trade-off).
- Don't restate what the code says. Don't add `// TODO: ...` without a date.

---

## Build / dev workflow

```bash
# First time after cloning or after schema/scoring changes
pnpm install
pnpm -F @payradar/schema build
pnpm -F @payradar/scoring-engine build

# Iterating on the web app
pnpm -F @payradar/web dev          # http://localhost:3000

# Manually run the ingestion pipeline
pnpm -F @payradar/ingestor sync    # pulls pay.sh/api/catalog
pnpm -F @payradar/ingestor probe   # one liveness sweep
pnpm -F @payradar/ingestor score   # compute + sign
pnpm -F @payradar/ingestor all     # all three sequentially

# Generate the oracle signing keypair (one-shot)
pnpm -F @payradar/ingestor exec tsx src/keygen.ts
```

The schema and scoring-engine are TS source — if you change them, rebuild before the web/ingestor will see the change. Or use `pnpm -F @payradar/schema dev` for watch mode.

---

## Things that will bite you (a.k.a. the gotchas list)

1. **Pay.sh catalog shape is two-tier and fragile.** `/api/catalog` returns provider *summaries* (`fqn`, `title`, `category` singular, `service_url`, `endpoint_count`). Per-provider endpoints live at `/api/providers/{fqn}` and need a separate fan-out fetch. `sync-catalog.ts` runs concurrency ≤3 because pay.sh rate-limits aggressively at higher fanout — retries within ~5s don't help. Bad endpoints have nullable `resource`/`pricing` fields, so Zod schemas use `.nullish()` not `.optional()`. If you change the parser, the field names below are the only ones the rest of the pipeline relies on; everything else flows through `.passthrough()`.

2. **Vercel Hobby cron is daily-only.** `vercel.json` is set to `0 0 * * *` (daily at midnight UTC) — that's the only schedule Vercel will accept on this tier. Sub-daily attempts (`0 * * * *`, `*/30 * * * *`) silently break the deploy (project shell created, no build queued, red error in the deploy modal). For finer freshness, `.github/workflows/sync.yml` runs every 30 min and POSTs the cron endpoint via bearer. If you want to switch to Pro and consolidate, update both `vercel.json` and delete the workflow.

3. **In-memory rate limiter is per-instance.** A determined attacker hitting many warm Vercel functions bypasses the cap. Documented limitation, upgrade path is `@upstash/ratelimit`. Don't add stricter caps without first switching backends.

4. **Buffer is server-only.** `signer.ts` has fallbacks (`atob`/`btoa`/`String.fromCharCode`) so `verifySignature` works in browsers. Don't add new `Buffer.from(...)` calls without similar guards if the code might run client-side.

5. **`transpilePackages` in `next.config.mjs` is load-bearing.** Workspace packages ship as TS source. If you forget to add a new workspace package there, Next.js fails with cryptic errors.

6. **The `.well-known` URL is served via rewrite,** not a real route segment. Next.js doesn't accept dot-prefixed segments. The route lives at `app/api/well-known/keys/route.ts` and `next.config.mjs` rewrites `/.well-known/payradar-keys.json` → `/api/well-known/keys`.

7. **`PAYRADAR_SIGNING_PRIVATE_KEY_HEX` must be server-only.** No `NEXT_PUBLIC_` prefix. If a Vercel deploy ever ships the private key to the browser, rotate immediately and append the old kid to `PAYRADAR_RETIRED_KEYS`.

8. **Client-side signature verification reconstructs the payload from row fields.** See `score-modal.tsx` `signedPayload`. The set of fields must EXACTLY match what `run-scoring.ts` signed. If you add a field to one side, add it to both.

9. **`scores_current` upserts on `endpoint_id` (one row per endpoint).** `scores_history` is append-only (every recomputation lands there). Replay queries hit `scores_history`.

10. **Six of nine spec'd dimensions are stubbed.** `trust`, `signal`, `security`, `pricing-value`, `community-adoption`, `onchain-reputation` exist in `PAYRADAR_SPEC.md` but are not emitted by the engine. They have weights in spec but `dimensions` JSONB only contains what the engine actually computes. Don't add weight without code.

11. **Cold-start cap is 50 evidence points.** Endpoints with fewer total evidence across all dimensions get tier `PROVISIONAL` regardless of score. This is intentional — don't try to "fix" PROVISIONAL endpoints showing high raw scores; that's the design.

12. **Node 25 is current, not LTS.** User is on v25.2.1. If native modules complain (rare, but `sharp` is in there for Next), Node 22 LTS is the fallback. Don't refactor to dodge a Node-version-specific quirk.

13. **Vercel "Sensitive" env vars don't reliably populate at build time.** For routes that use `export const revalidate = <n>`, Next prerenders at build, captures the env value once, and caches it for hours. If a Sensitive var was missing at prerender, the empty/wrong value sticks. The fix is `export const dynamic = 'force-dynamic'` on any route that reads env at runtime — already done for `/api/well-known/keys`. Don't add `revalidate` to routes that touch env vars.

14. **`NEXT_PUBLIC_*` env vars ship to the browser by design.** Marking them Sensitive on Vercel is misleading theater — they end up in the JS bundle either way. Anon key is meant to be public; RLS enforces access. Only mark `SUPABASE_SERVICE_ROLE_KEY` and `PAYRADAR_SIGNING_PRIVATE_KEY_HEX` as Sensitive — those are real secrets. `CRON_SECRET` is borderline (defense-in-depth Sensitive is fine).

15. **`/api/cron/sync` is GET-only**, not POST. Vercel Cron itself sends GET. The GitHub Actions workflow uses GET; don't switch to POST without also adding `export async function POST` to the route.

16. **`apps/ingestor/package.json` MUST declare `main` + `types` + `exports`** pointing to `dist/`. Without them, `tsc` in `apps/web` can't resolve `import {...} from '@payradar/ingestor'`. Next dev/build works either way (via `transpilePackages` bundling raw TS source), so the bug only surfaces when Vercel runs the type-check phase. Same applies if you add another `apps/<thing>` package and have web import from it.

17. **The Postgres timestamp serialization differs between JS and Postgres.** JS `toISOString()` produces `2026-05-20T12:52:07.153Z`; Postgres echoes `timestamptz` as `2026-05-20T12:52:07.153+00:00`. Same instant, different bytes — canonical-JSON treats them as different. `run-scoring.ts` normalizes `computed_at` to `+00:00` form before signing so verifiers can rebuild the payload bytes-for-bytes from the API response. If you add any other signed timestamp field, do the same normalization.

18. **Arch users: the AUR `supabase-bin` package can self-update to a version where the `supabase` shim can't find its `supabase-go` backend.** Symptom: any `supabase` command errors with "Cannot find supabase-go binary." Fix: `curl -sL https://github.com/supabase/cli/releases/download/v<latest>/supabase_<latest>_linux_amd64.tar.gz | tar -xzf - -C $HOME/.local/share/supabase` then prepend that dir to PATH or set `SUPABASE_GO_BINARY`. Not a code issue — only mention because debugging it cost real time on launch day.

---

## What "good" looks like for changes here

- **Adding a new dimension:** new file in `packages/scoring-engine/src/dimensions/`, exports `VERSION` + `WEIGHT` + a pure function returning `DimensionScore`. Add to `aggregate()` `DEFAULT_WEIGHTS`. Add to `run-scoring.ts`. Re-normalize all weights to sum to 1.0. Bump `ENGINE_VERSION`. Add a section to `apps/web/public/docs/scoring/vX.Y.Z.md`. Test: replay an existing score; the score should change *only* due to the new dimension's contribution.

- **Bumping the engine version:** copy `apps/web/public/docs/scoring/v0.1.0.md` → `v0.2.0.md`, edit. Bump `ENGINE_VERSION` in `packages/scoring-engine/src/version.ts`. Old scores keep their old version forever — never rewrite history.

- **Modifying the canonical signed payload:** this is a breaking change. Old signatures stop verifying with new code paths. Bump `ENGINE_VERSION`, write a migration note in `docs/`, plan key rotation. Don't do this lightly.

- **Adding a Supabase RPC:** put it in a new migration. Grant execute to `anon, authenticated`. The function should be `stable` if it doesn't write, `volatile` if it does. Index any columns you sort or filter on inside the function.

---

## Don't

- Don't commit `.env` or `.env.local`. Both are gitignored. The signing private key only ever lives in env vars.
- Don't auto-apply `0003_capability_embeddings.sql.template`. The `.template` suffix is intentional.
- Don't refactor `@payradar/scoring-engine` to add I/O or async-non-signing dependencies. It's pure math + ed25519. Period.
- Don't add a UI feature without checking whether it works server-rendered. The dashboard is RSC-first; client components are scoped to interactivity (filters, modal, copy).
- Don't add new emojis to source files unless asked. Repo style is text-only.
- Don't write CHANGELOG.md, ROADMAP.md, or any other meta-doc unless the user asks. The roadmap lives in README.md.

---

## Operational facts (post-launch)

- The user's email is `sebastianbarrientosa@gmail.com`. Identity in the spec is "CBas". Don't change owner attribution.
- The user is technical (Arch Linux, comfortable with pnpm/git/CLI). Don't over-explain.
- `pnpm-lock.yaml` IS committed. `next` is pinned to `15.5.18`.
- `apps/web/.env.local` is a symlink to the repo-root `.env.local`. Local-only convenience (gitignored). Vercel reads env from its dashboard regardless.
- Secrets live in three places ONLY: the user's `.env.local`, the user's password manager (signing private key in particular), and Vercel env vars. If you rotate anything, update all three.
- Future work is incremental; commits should be focused (one topic per commit) with clear "why" in the message — match the existing `fix(ingestor): ...` / `chore: ...` style.

---

## v0.2 priorities (rough order)

v0.1 is live. Don't pull v0.2 work forward unless the user asks.

1. **Synthetic paid probes.** Real x402 calls from a funded PayRadar wallet. Highest-evidence-weight probe type — currently zero rows. Biggest single quality unlock for scores.
2. **MCP server.** Wraps `/v1/discover` as an MCP tool. The README already promises this.
3. **TypeScript SDK.** `@payradar/sdk` — typed wrapper over the REST API + signature verification helpers. Lives in `packages/sdk-ts/`.
4. **pgvector semantic search.** `docs/PGVECTOR_UPGRADE.md` is the playbook. Trigger condition: queries returning 0 results when the catalog clearly has matches.
5. **Geo-distributed probes.** Single-region probes are gameable via IP allowlist. Add at least 2 more regions.
6. **Trust + security dimensions.** Out of the six stubs, `trust` and `security` are the lowest-effort to ship next.

---

## When the user comes back

1. Greet briefly. Don't recap the whole project — they wrote it.
2. The site is live at https://pay-radar-web.vercel.app. Before assuming anything about prod state, hit `/api/v1/status` — it returns row counts and last-run timestamps. That's the cheapest way to know if the cron is healthy.
3. Ask what they want to work on. The v0.2 priorities below are the natural next steps but the user may have a different ask.
4. For any change that touches the deploy pipeline, scan gotchas #1, #2, #13, #14, #16, #17 above first — they're the silent ones.

---

*Last updated: 2026-05-20 — v0.1 deployed to https://pay-radar-web.vercel.app; GitHub Actions cron running every 30 min; signature verify confirmed live.*
