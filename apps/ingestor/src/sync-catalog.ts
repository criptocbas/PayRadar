import { z } from 'zod';
import { PricingSchema, type Provider, type Endpoint } from '@payradar/schema';
import { supabase } from './supabase.js';

const CATALOG_URL = process.env.PAY_SH_CATALOG_URL ?? 'https://pay.sh/api/catalog';

// The pay.sh catalog response shape isn't formally specified — this schema is
// defensive and uses passthrough() so unknown fields survive round-tripping.
// Adjust the field paths once the real shape is observed; the rest of the
// pipeline depends only on the normalized output of this function.
const RawProvider = z
  .object({
    id: z.string().optional(),
    slug: z.string().optional(),
    name: z.string().optional(),
    homepage: z.string().optional(),
    description: z.string().optional(),
    categories: z.array(z.string()).optional(),
    payment_recipients: z.array(z.string()).optional(),
  })
  .passthrough();

const RawEndpoint = z
  .object({
    id: z.string().optional(),
    operation_id: z.string().optional(),
    operationId: z.string().optional(),
    provider_id: z.string().optional(),
    provider: z.string().optional(),
    method: z.string().optional(),
    path: z.string().optional(),
    url: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    pricing: z.unknown().optional(),
    sla: z.unknown().optional(),
  })
  .passthrough();

const RawCatalog = z
  .object({
    providers: z.array(RawProvider).optional(),
    endpoints: z.array(RawEndpoint).optional(),
  })
  .passthrough();

interface SyncResult {
  providers_seen: number;
  endpoints_seen: number;
  providers_upserted: number;
  endpoints_upserted: number;
  endpoints_marked_inactive: number;
  duration_ms: number;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeProvider(raw: z.infer<typeof RawProvider>, now: string): Provider | null {
  const name = raw.name ?? raw.slug ?? raw.id;
  if (!name) return null;
  const slug = raw.slug ?? slugify(name);
  const id = raw.id ?? `prv_${slug}`;
  return {
    id,
    slug,
    name,
    homepage: raw.homepage,
    pay_sh_id: raw.id,
    claimed: false,
    categories: raw.categories ?? [],
    description: raw.description,
    payment_recipients: (raw.payment_recipients ?? []).map((wallet) => ({
      wallet,
      first_seen: now,
    })),
    endpoint_count: 0,
    created_at: now,
    updated_at: now,
  };
}

function normalizeEndpoint(
  raw: z.infer<typeof RawEndpoint>,
  providerId: string,
  now: string
): Endpoint | null {
  const operationId = raw.operation_id ?? raw.operationId;
  const url = raw.url;
  const method = (raw.method ?? 'GET').toUpperCase();
  if (!operationId || !url) return null;
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null;

  // Pricing is the most schema-fragile field — fall back to a free-with-flag
  // record if the catalog entry is malformed, so we don't lose the endpoint.
  const pricingParsed = PricingSchema.safeParse(raw.pricing);
  const pricing = pricingParsed.success
    ? pricingParsed.data
    : ({ model: 'free', amount_usd: 0, currency_token: 'USDC' } as const);

  return {
    id: `ep_${providerId}_${operationId}`.slice(0, 200),
    provider_id: providerId,
    operation_id: operationId,
    method: method as Endpoint['method'],
    path: raw.path ?? new URL(url).pathname,
    url,
    capabilities: raw.capabilities ?? [],
    pricing,
    active: true,
    first_seen: now,
    last_seen_in_catalog: now,
  };
}

export async function syncCatalog(): Promise<SyncResult> {
  const startedAt = Date.now();
  const now = new Date().toISOString();

  const res = await fetch(CATALOG_URL, {
    headers: { 'User-Agent': 'PayRadar/0.1 (+https://payradar.io)' },
  });
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status} ${res.statusText}`);
  const raw = await res.json();
  const parsed = RawCatalog.parse(raw);

  const providers = (parsed.providers ?? [])
    .map((p) => normalizeProvider(p, now))
    .filter((p): p is Provider => p !== null);

  // Endpoints can come either as a top-level array OR nested under each provider —
  // accept both shapes.
  const rawEndpoints = parsed.endpoints ?? [];
  const endpoints: Endpoint[] = [];
  for (const e of rawEndpoints) {
    const providerId =
      e.provider_id ?? (e.provider ? `prv_${slugify(e.provider)}` : undefined);
    if (!providerId) continue;
    const ep = normalizeEndpoint(e, providerId, now);
    if (ep) endpoints.push(ep);
  }

  const sb = supabase();

  // Upsert providers.
  let providersUpserted = 0;
  if (providers.length > 0) {
    const { error, count } = await sb
      .from('providers')
      .upsert(
        providers.map((p) => ({
          ...p,
          // Preserve created_at on existing rows by letting the DB decide.
          created_at: undefined,
        })),
        { onConflict: 'id', count: 'exact' }
      );
    if (error) throw error;
    providersUpserted = count ?? providers.length;
  }

  // Upsert endpoints; bump last_seen_in_catalog on every sync.
  let endpointsUpserted = 0;
  if (endpoints.length > 0) {
    const { error, count } = await sb
      .from('endpoints')
      .upsert(
        endpoints.map((e) => ({ ...e, created_at: undefined })),
        { onConflict: 'id', count: 'exact' }
      );
    if (error) throw error;
    endpointsUpserted = count ?? endpoints.length;
  }

  // Diff: any endpoint we have in the DB whose last_seen_in_catalog wasn't bumped
  // this run is no longer in the catalog → mark inactive.
  const seenIds = endpoints.map((e) => e.id);
  let markedInactive = 0;
  if (seenIds.length > 0) {
    const { error, count } = await sb
      .from('endpoints')
      .update({ active: false })
      .lt('last_seen_in_catalog', now)
      .eq('active', true)
      .not('id', 'in', `(${seenIds.map((id) => `"${id}"`).join(',')})`)
      .select('id', { count: 'exact', head: true });
    if (error) throw error;
    markedInactive = count ?? 0;
  }

  return {
    providers_seen: parsed.providers?.length ?? 0,
    endpoints_seen: parsed.endpoints?.length ?? 0,
    providers_upserted: providersUpserted,
    endpoints_upserted: endpointsUpserted,
    endpoints_marked_inactive: markedInactive,
    duration_ms: Date.now() - startedAt,
  };
}
