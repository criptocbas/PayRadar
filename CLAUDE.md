# CLAUDE.md — PayRadar handoff

> **Read this before doing anything in this repo.** This is the operational guide for any agent (or human) picking up the project mid-flight. It assumes you have not seen the prior conversation. The product spec lives in `PAYRADAR_SPEC.md`; the deploy runbook in `DEPLOYMENT_CHECKLIST.md`. This file is the *opinionated overlay* on top of those — invariants, conventions, gotchas, and current state.

---

## TL;DR — current state (as of 2026-05-09)

**The codebase is built and pushed.** Repo: https://github.com/criptocbas/PayRadar (main, single root commit `8a20490`). Local environment is fully set up.

**We are blocked on one user decision: where to host Postgres.** The user (CBas) already has 2 active Supabase projects (free tier cap) and is choosing between:

1. **Free a Supabase slot** (delete or pause a dormant project) — zero code changes
2. **Switch to Neon** — ~30 min code change: swap `@supabase/supabase-js` → `pg`/`@neondatabase/serverless`, rewrite `apps/web/lib/supabase.ts` and `apps/ingestor/src/supabase.ts`, plus the cron route. RLS policies still work via separate role connection strings.
3. **Supabase Pro $25/mo** — zero code, no auto-pause, daily backups

**When the user comes back, ask which path they took.** Then resume from `DEPLOYMENT_CHECKLIST.md` Phase 2 (Supabase) or write the Neon swap if they picked 2.

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
    src/sync-catalog.ts            defensive zod parse, normalize, upsert, mark-inactive
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

1. **The pay.sh catalog response shape is guessed.** `apps/ingestor/src/sync-catalog.ts` parses with `passthrough()` and falls back gracefully. First time it runs against the live endpoint, the field mappings (especially `pricing` and the providers↔endpoints relationship) probably need adjustment. Check normalized output before assuming the ingest is correct.

2. **Vercel cron `*/5 * * * *` requires Pro.** Hobby tier = daily only. If on Hobby: edit `apps/web/vercel.json` to `0 * * * *` and redeploy, or run the ingestor on Railway/Fly.

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

## Open decisions / handoff items

- **[BLOCKED]** Postgres host: Supabase free / Supabase Pro / Neon. Asked the user, awaiting answer. See TL;DR.
- The user's email is `sebastianbarrientosa@gmail.com`. Identity in the spec is "CBas". Don't change owner attribution.
- The user is technical (Arch Linux, comfortable with pnpm/git/CLI). Don't over-explain.
- The repo has a single commit. Future work is incremental; commits should be focused (one topic per commit) with clear "why" in the message.
- `pnpm-lock.yaml` was generated locally but **may or may not be committed yet** — check `git status` before assuming.
- The user bumped `next` to `15.5.18` (from `15.0.0`) to silence peer-dep warnings. That's the version going forward.

---

## v0.2 priorities (after v0.1 ships)

In rough priority order, when this repo is live and stable:

1. **Real catalog parsing.** Once `sync-catalog.ts` runs against pay.sh in production, tighten the field mappings.
2. **Synthetic paid probes.** Real x402 calls from a funded PayRadar wallet. Highest-evidence-weight probe type — currently zero rows.
3. **MCP server.** Wraps `/v1/discover` as an MCP tool. The README already promises this.
4. **TypeScript SDK.** `@payradar/sdk` — typed wrapper over the REST API + signature verification helpers. Lives in `packages/sdk-ts/`.
5. **pgvector semantic search.** `docs/PGVECTOR_UPGRADE.md` is the playbook. Trigger condition: queries returning 0 results when the catalog clearly has matches.
6. **Geo-distributed probes.** Single-region probes are gameable via IP allowlist. Add at least 2 more regions.
7. **Trust + security dimensions.** Out of the six stubs, `trust` and `security` are the lowest-effort to ship next.

Don't pull v0.2 work forward unless the user asks. v0.1 ships first.

---

## When the user comes back

1. Greet briefly. Don't recap the whole project — they wrote it.
2. Ask: "Which Postgres path did you pick — free a Supabase slot, Pro, or Neon?"
3. Resume `DEPLOYMENT_CHECKLIST.md` Phase 2, OR write the Neon swap. The Neon swap touches:
   - `apps/web/lib/supabase.ts` → swap for `@neondatabase/serverless` Pool
   - `apps/ingestor/src/supabase.ts` → same
   - `apps/web/app/api/v1/discover/route.ts` → `.rpc(...)` becomes a parameterized SQL string
   - `apps/web/app/api/v1/status/route.ts` → same
   - `apps/web/app/discover/page.tsx` and `apps/web/app/providers/[slug]/page.tsx` → small select rewrites
   - Add `DATABASE_URL` env var
   - RLS still works but enforced via separate role connection strings (anon vs admin)
   - Migrations unchanged — same Postgres
4. After Postgres is up, the rest of `DEPLOYMENT_CHECKLIST.md` is mechanical.

---

*Last updated: 2026-05-09 — initial commit pushed, awaiting Postgres host decision.*
