# PayRadar v0.1 — Deployment Checklist

End-to-end checklist for shipping the public MVP to Vercel + Supabase. Run top-to-bottom on a fresh project.

---

## 0. Prereqs (one-time, local)

```bash
corepack enable
corepack prepare pnpm@9.12.0 --activate
brew install supabase/tap/supabase   # or: npm i -g supabase
brew install vercel-cli              # or: npm i -g vercel
```

---

## 1. Supabase project

- [ ] Create project at https://supabase.com/dashboard → save the project ref.
- [ ] In Project Settings → API, copy:
  - `Project URL` → goes to `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_URL`
  - `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (server-only — never ship to the browser)
- [ ] Apply migrations from the repo root:
  ```bash
  supabase login
  supabase link --project-ref <YOUR-REF>
  supabase db push
  ```
  This applies `0001_initial.sql` and `0002_search_freshness.sql` in order.

### RLS verification (don't skip)

In Supabase SQL editor, run:

```sql
-- Anon-role read should succeed:
set role anon;
select count(*) from providers;
select count(*) from endpoints;
select count(*) from scores_current;
select * from search_endpoints(null, null, 0, 1e9, 'score', 5);
reset role;

-- Anon-role write should fail (this is the ASSERTION — error is success):
set role anon;
insert into providers (id, slug, name, created_at, updated_at)
  values ('hack', 'hack', 'hack', now(), now());
-- Expected: ERROR: new row violates row-level security policy
reset role;
```

Both behaviors are required. If anon writes succeed, RLS is misconfigured — stop and re-apply policies.

---

## 2. Generate the oracle signing key

The signing key lives **only** on the server (Vercel env + your local `.env.local` for the ingestor CLI). It must never be committed.

```bash
pnpm install
pnpm -F @payradar/schema build
pnpm -F @payradar/scoring-engine build
pnpm -F @payradar/ingestor exec tsx src/keygen.ts
```

Copy the three printed env vars into `.env.local`. Stash the private key in a password manager — losing it means losing the ability to verify any pre-rotation score.

Key rotation path: when you generate a new key, set the new one as `PAYRADAR_SIGNING_*` and append the old one to `PAYRADAR_RETIRED_KEYS="<oldkid>:<oldhex>"`. The well-known JSON keeps publishing the retired key (with `active: false`) so historical scores stay verifiable.

---

## 3. Local smoke test

```bash
cp .env.example .env.local
# fill SUPABASE_URL / keys / signing key

pnpm -F @payradar/ingestor sync     # pulls pay.sh/api/catalog
pnpm -F @payradar/ingestor probe    # 1× liveness sweep
pnpm -F @payradar/ingestor score    # computes + signs
pnpm -F @payradar/web dev           # http://localhost:3000/discover
```

Verify:

- [ ] `/discover` shows ranked endpoints with tiers.
- [ ] Clicking a row opens the modal with per-dimension breakdown.
- [ ] `/api/v1/discover?capability=geocode&sort_by=price` returns JSON with signed scores.
- [ ] `/api/v1/discover` returns `X-RateLimit-*` headers; 70 rapid requests get a 429.
- [ ] `/api/health` returns `{ ok: true, ... }`.
- [ ] `/.well-known/payradar-keys.json` returns the public key matching the signing key.
- [ ] `/docs/scoring/v0.1.0.md` loads as text/markdown.
- [ ] `/providers/<some-slug>` shows a provider detail page.

---

## 4. Vercel project

- [ ] `cd apps/web && vercel link` (root directory: `apps/web`).
- [ ] Add env vars in Vercel dashboard → Settings → Environment Variables. **Mark all secrets as "Encrypted" and only the `NEXT_PUBLIC_*` vars as exposed to the browser:**

| Var                                  | Scope               | Production / Preview |
|--------------------------------------|---------------------|----------------------|
| `NEXT_PUBLIC_SUPABASE_URL`           | client + server     | yes                  |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`      | client + server     | yes                  |
| `SUPABASE_URL`                       | server only         | yes                  |
| `SUPABASE_SERVICE_ROLE_KEY`          | **server only**     | yes                  |
| `CRON_SECRET`                        | server only         | yes                  |
| `PAYRADAR_SIGNING_KEY_ID`            | server only         | yes                  |
| `PAYRADAR_SIGNING_PRIVATE_KEY_HEX`   | **server only**     | yes                  |
| `PAYRADAR_SIGNING_PUBLIC_KEY_HEX`    | server only         | yes                  |
| `PAYRADAR_RETIRED_KEYS` (optional)   | server only         | yes after rotation   |
| `PAY_SH_CATALOG_URL` (optional)      | server only         | yes                  |
| `PROBE_REGION`                       | server only         | yes                  |

- [ ] First deploy: `vercel deploy --prod`.

### Cron

`apps/web/vercel.json` declares `*/5 * * * *` → `/api/cron/sync`. **This requires the Pro plan.** Free-tier alternatives:

1. Switch the schedule to `0 * * * *` (hourly) — works on Hobby tier.
2. Run the ingestor on Railway/Fly free-tier instead, hitting the same Supabase project.

Smoke test the cron endpoint after deploy:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://YOUR-DEPLOYMENT.vercel.app/api/cron/sync
```

Expected: `{ ok: true, sync, probes, scoring }`.

---

## 5. Cache + rate limit verification

```bash
# Cache header (should be public, s-maxage=30)
curl -I https://YOUR-DEPLOYMENT.vercel.app/api/v1/discover?limit=5

# Rate limit (should 429 around request 60-70)
for i in $(seq 1 80); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    https://YOUR-DEPLOYMENT.vercel.app/api/v1/discover?limit=1
done
```

Note: rate limiter is per-instance memory. On Vercel that's per-function-instance — adequate for "block dumb abuse" but not strict global enforcement. Upgrade to `@upstash/ratelimit` when you want real cross-instance limits.

---

## 6. Post-deploy

- [ ] Add the deployment URL to your README.
- [ ] Add a UptimeRobot / BetterStack monitor on `/api/health` (60s) and `/api/v1/discover?limit=1` (300s).
- [ ] Sanity-check `/.well-known/payradar-keys.json` is reachable from outside Vercel.
- [ ] Fetch one score and verify the signature locally:
  ```bash
  pnpm -F @payradar/ingestor exec tsx -e '
    import { verifySignature, canonicalize } from "@payradar/scoring-engine";
    const r = await (await fetch("https://YOUR/api/v1/discover?limit=1")).json();
    const s = r.results[0].score;
    const keys = await (await fetch("https://YOUR/.well-known/payradar-keys.json")).json();
    const key = keys.keys.find(k => k.kid === s.signature.key_id);
    const payload = { endpoint_id: s.endpoint_id, computed_at: s.computed_at,
                      engine_version: s.engine_version, score: s.score,
                      confidence: s.confidence, tier: s.tier, dimensions: s.dimensions };
    console.log(await verifySignature(payload, s.signature, key.public_key_hex));
  '
  ```
  Expected: `true`.

---

## 7. Known scope limits (v0.1)

These are documented in `/docs/scoring/v0.1.0.md` but worth flagging here for ops awareness:

- Liveness probes only (no synthetic paid). All evidence is at the lowest weight tier — scores will be conservative.
- Single probe region. Provider-side IP allowlists could fool the limiter; this is by design until v0.3.
- Six of nine dimensions stubbed. Score reflects *operational health* only (reliability, latency, freshness).
- In-memory rate limiter — see step 5 caveat.

---

## 8. Rollback

If a deploy goes bad:

```bash
vercel rollback   # picks the previous good deployment
```

If a *scoring-engine* change goes bad: **don't roll back data**. Bump `ENGINE_VERSION`, fix forward, recompute. Old scores stay valid forever (replay contract).

Database migrations are forward-only by convention. If you need to undo a schema change, write `0003_revert_*.sql` rather than editing or deleting the prior migration — keeps the history honest.
