import { NextRequest } from 'next/server';
import { DiscoverQuerySchema, type DiscoverResponse } from '@payradar/schema';
import { ENGINE_VERSION } from '@payradar/scoring-engine';
import { supabasePublic } from '@/lib/supabase';
import { rateLimit, clientKey, rateLimitHeaders } from '@/lib/ratelimit';

export const runtime = 'nodejs';
// Edge cache the response for 30s; agents polling at 1Hz hit cache.
export const revalidate = 30;

export async function GET(req: NextRequest) {
  // 1. Rate limit before doing any work.
  const rl = await rateLimit(clientKey(req));
  if (!rl.ok) {
    return Response.json(
      { error: 'rate_limited', detail: 'too many requests; back off and retry' },
      { status: 429, headers: rateLimitHeaders(rl) }
    );
  }

  // 2. Validate query params.
  const url = new URL(req.url);
  const parsed = DiscoverQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_query', issues: parsed.error.issues },
      { status: 400, headers: rateLimitHeaders(rl) }
    );
  }
  const query = parsed.data;
  const { capability, category, min_score, max_price_usd, sort_by, limit } = query;

  // 3. Single-roundtrip RPC. SQL handles search + filter + sort.
  const sb = supabasePublic();
  const { data, error } = await sb.rpc('search_endpoints', {
    q: capability ?? null,
    category: category ?? null,
    min_score,
    max_price_usd,
    sort_by,
    result_limit: limit,
  });
  if (error) {
    return Response.json(
      { error: 'database_error', detail: error.message },
      { status: 500, headers: rateLimitHeaders(rl) }
    );
  }

  const results = (data ?? []).map((r: any) => ({
    endpoint: {
      id: r.endpoint_id,
      provider_id: r.provider_id,
      operation_id: r.operation_id,
      method: r.method,
      path: r.path,
      url: r.url,
      capabilities: r.capabilities ?? [],
      pricing: r.pricing,
      active: r.active,
      first_seen: r.first_seen,
      last_seen_in_catalog: r.last_seen_in_catalog,
    },
    provider: {
      id: r.provider_id,
      slug: r.provider_slug,
      name: r.provider_name,
      homepage: r.provider_homepage,
    },
    score: r.score_id
      ? {
          score_id: r.score_id,
          endpoint_id: r.endpoint_id,
          computed_at: r.score_computed_at,
          engine_version: r.engine_version,
          score: Number(r.score),
          confidence: Number(r.confidence),
          tier: r.tier,
          dimensions: r.dimensions,
          // Signature is stored at score-computation time and surfaced verbatim;
          // verifiers fetch the public key from /.well-known/payradar-keys.json.
          signature: r.signature ?? null,
        }
      : null,
    last_probe_ts: r.last_probe_ts ?? null,
  }));

  const body: DiscoverResponse = {
    results,
    count: results.length,
    engine_version: ENGINE_VERSION,
    generated_at: new Date().toISOString(),
    query,
  };

  return Response.json(body, {
    headers: {
      ...rateLimitHeaders(rl),
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
  });
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
    },
  });
}
