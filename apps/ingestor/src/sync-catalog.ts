import { z } from 'zod';
import type { Provider, Endpoint, Pricing } from '@payradar/schema';
import { supabase } from './supabase.js';

const CATALOG_URL = process.env.PAY_SH_CATALOG_URL ?? 'https://pay.sh/api/catalog';
const PROVIDER_BASE = process.env.PAY_SH_PROVIDER_BASE ?? 'https://pay.sh/api/providers';
const FETCH_CONCURRENCY = Number(process.env.PAY_SH_FETCH_CONCURRENCY ?? '3');
const FETCH_RETRY_DELAYS_MS = [500, 1500, 4000];

// ---- pay.sh catalog shape (observed 2026-05) -------------------------------
// /api/catalog returns provider summaries; per-provider endpoints live at
// /api/providers/{fqn}. Endpoint pricing is a tiered/dimensional object that
// we collapse to the schema's flat {model, amount_usd, currency_token}.

const PaySummary = z
  .object({
    fqn: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    use_case: z.string().optional(),
    category: z.string().optional(),
    service_url: z.string().optional(),
    endpoint_count: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const PayPricingTier = z.object({ price_usd: z.number().nonnegative() }).passthrough();
const PayPricingDimension = z
  .object({
    unit: z.string().optional(),
    tiers: z.array(PayPricingTier).optional(),
  })
  .passthrough();
const PayPricing = z
  .object({
    mode: z.string().optional(),
    dimensions: z.array(PayPricingDimension).optional(),
  })
  .passthrough();

const PayEndpoint = z
  .object({
    method: z.string(),
    path: z.string(),
    description: z.string().nullish(),
    resource: z.string().nullish(),
    pricing: PayPricing.nullish(),
    protocol: z.array(z.string()).nullish(),
    supported_usd: z.array(z.string()).nullish(),
    probe_status: z.string().nullish(),
  })
  .passthrough();

const PayCatalog = z
  .object({
    providers: z.array(PaySummary).default([]),
  })
  .passthrough();

const PayProviderDetail = z
  .object({
    fqn: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    category: z.string().optional(),
    service_url: z.string().optional(),
    endpoints: z.array(PayEndpoint).default([]),
  })
  .passthrough();

export interface SyncResult {
  providers_seen: number;
  endpoints_seen: number;
  providers_upserted: number;
  endpoints_upserted: number;
  endpoints_marked_inactive: number;
  detail_fetch_failures: number;
  duration_ms: number;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function providerIdFromFqn(fqn: string): string {
  return `prv_${slugify(fqn)}`;
}

function safeUrl(s: string | undefined): string | undefined {
  if (!s) return undefined;
  try {
    return new URL(s).toString();
  } catch {
    return undefined;
  }
}

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedPath = path.replace(/^\/+/, '');
  return `${trimmedBase}/${trimmedPath}`;
}

function normalizePricing(raw: unknown, supportedTokens: string[] | null | undefined): Pricing {
  const parsed = PayPricing.safeParse(raw);
  const fallbackCurrency = supportedTokens?.[0] ?? 'USDC';
  if (!parsed.success) {
    return { model: 'free', amount_usd: 0, currency_token: fallbackCurrency };
  }
  const dims = parsed.data.dimensions ?? [];
  const first = dims[0];
  const firstTier = first?.tiers?.[0];
  const amount = firstTier?.price_usd ?? 0;
  const unit = (first?.unit ?? '').toLowerCase();
  const model: Pricing['model'] =
    amount === 0 ? 'free' : unit.includes('token') ? 'per_token' : 'per_call';
  return {
    model,
    amount_usd: amount,
    currency_token: fallbackCurrency,
  };
}

function normalizeProvider(s: z.infer<typeof PaySummary>, now: string): Provider {
  const id = providerIdFromFqn(s.fqn);
  const slug = slugify(s.fqn);
  return {
    id,
    slug,
    name: s.title ?? s.fqn,
    homepage: safeUrl(s.service_url),
    pay_sh_id: s.fqn,
    claimed: false,
    categories: s.category ? [s.category] : [],
    description: s.description,
    payment_recipients: [],
    endpoint_count: s.endpoint_count ?? 0,
    created_at: now,
    updated_at: now,
  };
}

function normalizeEndpoint(
  raw: z.infer<typeof PayEndpoint>,
  detail: z.infer<typeof PayProviderDetail>,
  now: string
): Endpoint | null {
  const method = raw.method.toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null;

  const base = detail.service_url;
  if (!base) return null;

  const url = safeUrl(joinUrl(base, raw.path));
  if (!url) return null;

  const providerId = providerIdFromFqn(detail.fqn);
  const pathSlug = slugify(raw.path);
  const operationId = `${method.toLowerCase()}-${pathSlug || 'root'}`;
  const id = `ep_${slugify(detail.fqn)}_${method.toLowerCase()}_${pathSlug || 'root'}`.slice(0, 200);

  const capabilities = [raw.resource, detail.category]
    .filter((c): c is string => Boolean(c))
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  return {
    id,
    provider_id: providerId,
    operation_id: operationId,
    method: method as Endpoint['method'],
    path: raw.path.startsWith('/') ? raw.path : `/${raw.path}`,
    url,
    capabilities,
    pricing: normalizePricing(raw.pricing, raw.supported_usd),
    active: true,
    first_seen: now,
    last_seen_in_catalog: now,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const n = Math.min(Math.max(1, concurrency), items.length);
  for (let w = 0; w < n; w += 1) {
    workers.push(
      (async () => {
        while (true) {
          const i = cursor;
          cursor += 1;
          if (i >= items.length) return;
          results[i] = await fn(items[i]!, i);
        }
      })()
    );
  }
  await Promise.all(workers);
  return results;
}

async function fetchProviderDetail(
  fqn: string
): Promise<z.infer<typeof PayProviderDetail> | null> {
  const url = `${PROVIDER_BASE}/${fqn}`;
  const attempts = FETCH_RETRY_DELAYS_MS.length + 1;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'PayRadar/0.1 (+https://payradar.io)' },
      });
      if (res.ok) {
        const raw = await res.json();
        const parsed = PayProviderDetail.safeParse(raw);
        return parsed.success ? parsed.data : null;
      }
      const retriable = res.status === 429 || res.status >= 500;
      if (!retriable) return null;
    } catch {
      // network errors are retriable
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, FETCH_RETRY_DELAYS_MS[i]));
  }
  return null;
}

export async function syncCatalog(): Promise<SyncResult> {
  const startedAt = Date.now();
  const now = new Date().toISOString();

  const res = await fetch(CATALOG_URL, {
    headers: { 'User-Agent': 'PayRadar/0.1 (+https://payradar.io)' },
  });
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status} ${res.statusText}`);
  const rawCatalog = await res.json();
  const catalog = PayCatalog.parse(rawCatalog);

  const providers: Provider[] = catalog.providers.map((s) => normalizeProvider(s, now));

  // Fetch endpoints from each provider that claims to have any. Concurrency-bounded.
  const providersWithEndpoints = catalog.providers.filter((s) => (s.endpoint_count ?? 0) > 0);
  let detailFailures = 0;
  const endpoints: Endpoint[] = [];

  const details = await mapWithConcurrency(providersWithEndpoints, FETCH_CONCURRENCY, async (s) =>
    fetchProviderDetail(s.fqn)
  );

  for (const detail of details) {
    if (!detail) {
      detailFailures += 1;
      continue;
    }
    for (const e of detail.endpoints) {
      const ep = normalizeEndpoint(e, detail, now);
      if (ep) endpoints.push(ep);
    }
  }

  const sb = supabase();

  // Strip DB-managed/preserved columns by actually deleting the keys; setting
  // them to undefined leaves them in the JSON payload as null and trips the
  // NOT NULL constraint.
  const stripFor = <T extends Record<string, unknown>>(obj: T, keys: string[]) => {
    const o = { ...obj } as Record<string, unknown>;
    for (const k of keys) delete o[k];
    return o;
  };

  let providersUpserted = 0;
  if (providers.length > 0) {
    const { error, count } = await sb
      .from('providers')
      .upsert(
        providers.map((p) => stripFor(p, ['created_at'])),
        { onConflict: 'id', count: 'exact' }
      );
    if (error) throw error;
    providersUpserted = count ?? providers.length;
  }

  let endpointsUpserted = 0;
  if (endpoints.length > 0) {
    const { error, count } = await sb
      .from('endpoints')
      .upsert(
        endpoints.map((e) => stripFor(e, ['first_seen'])),
        { onConflict: 'id', count: 'exact' }
      );
    if (error) throw error;
    endpointsUpserted = count ?? endpoints.length;
  }

  // Mark stale endpoints inactive. last_seen_in_catalog was just bumped to `now`
  // for every endpoint we observed this run, so a strict `<` excludes them all
  // without needing a NOT IN clause (which would blow past PostgREST's URL limit
  // with hundreds of IDs).
  let markedInactive = 0;
  {
    const { error, count } = await sb
      .from('endpoints')
      .update({ active: false }, { count: 'exact' })
      .lt('last_seen_in_catalog', now)
      .eq('active', true);
    if (error) throw error;
    markedInactive = count ?? 0;
  }

  return {
    providers_seen: catalog.providers.length,
    endpoints_seen: endpoints.length,
    providers_upserted: providersUpserted,
    endpoints_upserted: endpointsUpserted,
    endpoints_marked_inactive: markedInactive,
    detail_fetch_failures: detailFailures,
    duration_ms: Date.now() - startedAt,
  };
}
