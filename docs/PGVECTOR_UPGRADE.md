# Upgrade: trigram → pgvector semantic capability search

**Status:** stretch goal for v0.2. Not on the v0.1 launch path.

The v0.1 `/v1/discover?capability=…` query uses Postgres trigram similarity, which is *fuzzy* (tolerates typos, partial matches) but not *semantic* (won't unify `forwardGeocode` with `address-to-coordinates`). Real semantic search requires embeddings.

This guide walks the upgrade end-to-end. It is intentionally concrete: copy-paste ready except for choosing an embedding model.

---

## 1. Pick a model (decide once, change rarely)

| Model | Dimension | Where it runs | Cost notes |
|---|---|---|---|
| `text-embedding-3-small` (OpenAI) | 1536 | hosted | $0.02 / 1M tokens — pennies for the whole catalog |
| `bge-small-en-v1.5` | 384 | self-host (CPU OK) | free; small enough to run in a Vercel function |
| `bge-large-en-v1.5` | 1024 | self-host (GPU recommended) | best quality among free options |

**Rule of thumb:** start with `text-embedding-3-small`. ~80 providers × ~10 capabilities = ~800 vectors. The whole index costs about $0.001 to build and is rebuilt only when capability tags change.

The dimension you pick is the dimension you commit to. Mixing dimensions in the same `vector` column is not allowed; switching models means a backfill.

---

## 2. Enable the schema

The migration is shipped as a template so it doesn't auto-apply:

```bash
mv supabase/migrations/0003_capability_embeddings.sql.template \
   supabase/migrations/0003_capability_embeddings.sql

# Adjust the vector dimension if you picked a non-1536 model.
# Search the file for `vector(1536)` and change it.

supabase db push
```

This:
- Enables the `vector` extension.
- Creates `capability_embeddings(capability text pk, embedding vector(N), model text, created_at)`.
- Builds an HNSW index on cosine distance.
- Replaces `search_endpoints()` with a semantic-aware version that *gracefully falls back* to the trigram path when no embedding is supplied or no vectors match.

The fallback matters: if your embedding service is down, the dashboard keeps working.

---

## 3. Build the embedding pipeline

Add a new ingestor command. Skeleton:

```ts
// apps/ingestor/src/embed-capabilities.ts
import { supabase } from './supabase.js';

const MODEL = 'text-embedding-3-small';
const DIM = 1536;

async function embed(texts: string[]): Promise<number[][]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embed failed: ${res.status}`);
  const json = await res.json();
  return json.data.map((d: any) => d.embedding);
}

export async function embedCapabilities() {
  const sb = supabase();
  // 1. Pull all unique capability tags from active endpoints.
  const { data } = await sb.from('endpoints').select('capabilities').eq('active', true);
  const tags = new Set<string>();
  for (const r of data ?? []) for (const c of r.capabilities ?? []) tags.add(c);
  const allTags = Array.from(tags);

  // 2. Skip ones we've already embedded with the current model.
  const { data: existing } = await sb
    .from('capability_embeddings')
    .select('capability')
    .eq('model', MODEL);
  const have = new Set((existing ?? []).map((r: any) => r.capability));
  const todo = allTags.filter((t) => !have.has(t));
  if (todo.length === 0) return { embedded: 0 };

  // 3. Batch (OpenAI accepts up to ~2048 inputs per call; be polite).
  const BATCH = 256;
  let embedded = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const vectors = await embed(batch);
    const rows = batch.map((capability, idx) => ({
      capability,
      embedding: vectors[idx],
      model: MODEL,
    }));
    const { error } = await sb.from('capability_embeddings').upsert(rows);
    if (error) throw error;
    embedded += rows.length;
  }

  return { embedded };
}
```

Wire it into the cron route alongside the existing pipeline (after `syncCatalog`, before `runScoring` — though strictly speaking the order doesn't matter).

---

## 4. Update the API route

`apps/web/app/api/v1/discover/route.ts` needs to embed the user's query at request time and pass the vector to the RPC. Sketch:

```ts
async function embedQuery(q: string): Promise<number[] | null> {
  if (!process.env.OPENAI_API_KEY) return null; // graceful degradation
  const res = await fetch('https://api.openai.com/v1/embeddings', { ... });
  if (!res.ok) return null;
  const json = await res.json();
  return json.data[0].embedding as number[];
}

const q_embedding = capability ? await embedQuery(capability) : null;
const { data } = await sb.rpc('search_endpoints', {
  q: capability ?? null,
  q_embedding,
  category: category ?? null,
  min_score, max_price_usd, sort_by, result_limit: limit,
  semantic_threshold: 0.80,
});
```

Key idea: `q_embedding` is **optional**. If embedding fails or `OPENAI_API_KEY` isn't set, the RPC silently falls back to the trigram path. Latency budget for the embed call is on the critical path of `/v1/discover`, so consider caching: keep a small LRU keyed by query string with 5-minute TTL.

---

## 5. Operational considerations

- **Re-embed on tag changes.** Run `embedCapabilities()` after every catalog sync. It's idempotent — only new tags hit the API.
- **Model rotation.** When you change `MODEL`, every existing row in `capability_embeddings` becomes stale (different vector space). Rotate by: insert new rows with the new model name, swap reads to the new model, delete old rows.
- **Threshold tuning.** Start at `0.80` cosine similarity. Tighter (`0.85`) reduces false positives but misses near-synonyms; looser (`0.75`) increases recall at the cost of relevance.
- **HNSW vs IVFFlat.** HNSW is the right default at our scale (sub-100k vectors). Switch to IVFFlat only if you hit memory pressure.
- **Privacy.** Capability tags are public catalog data — no PII concerns. The user's *query* is sent to the embedding provider; that's the only privacy trade-off.

---

## 6. Tests to add before flipping the feature flag

- [ ] Unit: `embedCapabilities()` skips already-embedded tags.
- [ ] Integration: `/v1/discover?capability=geocoding` returns endpoints tagged `geocode.forward`, `forward-geocode`, `address-to-coords`.
- [ ] Integration: with `OPENAI_API_KEY` unset, the trigram path still serves results.
- [ ] Smoke: HNSW index recall > 95% vs. brute-force at threshold 0.80.

---

## 7. Why we shipped trigram first

Embedding pipelines are not free: API key, cost, additional latency, model-rotation pain, embedding consistency. Trigram is a few SQL lines and gets us 80% of the user-facing benefit (typo tolerance, partial matches) with zero new failure modes. Ship the simple thing; upgrade when the data tells you to.

The signal that says it's time: `/v1/discover?capability=…` queries returning 0 results when the answer obviously exists in the catalog. That's the moment the trigram path is leaving value on the floor.
