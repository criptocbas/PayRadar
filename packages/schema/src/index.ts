// Single source of truth for every shape that crosses a service boundary.
// Imported by the ingestor, the scoring engine, the web app, and (later) the SDKs.

import { z } from 'zod';

// ---------- Pricing ----------

export const PricingModelSchema = z.enum(['per_call', 'per_token', 'subscription', 'free']);
export type PricingModel = z.infer<typeof PricingModelSchema>;

export const PricingSchema = z.object({
  model: PricingModelSchema,
  amount_usd: z.number().nonnegative(),
  amount_lamports: z.number().int().nonnegative().optional(),
  currency_token: z.string().default('USDC'),
  minimum_topup_usd: z.number().nonnegative().optional(),
  last_changed_at: z.string().datetime().optional(),
});
export type Pricing = z.infer<typeof PricingSchema>;

// ---------- Provider ----------

export const ProviderSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  homepage: z.string().url().optional(),
  pay_sh_id: z.string().optional(),
  pay_skills_repo_path: z.string().optional(),
  claimed: z.boolean().default(false),
  claimed_by_wallet: z.string().nullable().optional(),
  claimed_at: z.string().datetime().nullable().optional(),
  categories: z.array(z.string()).default([]),
  description: z.string().optional(),
  payment_recipients: z
    .array(z.object({ wallet: z.string(), first_seen: z.string().datetime() }))
    .default([]),
  endpoint_count: z.number().int().nonnegative().default(0),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Provider = z.infer<typeof ProviderSchema>;

// ---------- Endpoint ----------

export const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const EndpointSchema = z.object({
  id: z.string(),
  provider_id: z.string(),
  operation_id: z.string(),
  method: HttpMethodSchema,
  path: z.string(),
  url: z.string().url(),
  capabilities: z.array(z.string()).default([]),
  pricing: PricingSchema,
  documented_sla: z
    .object({
      uptime_pct: z.number().min(0).max(100).optional(),
      latency_p95_ms: z.number().nonnegative().optional(),
    })
    .partial()
    .optional(),
  active: z.boolean().default(true),
  first_seen: z.string().datetime(),
  last_seen_in_catalog: z.string().datetime(),
  openapi_hash: z.string().optional(),
});
export type Endpoint = z.infer<typeof EndpointSchema>;

// ---------- Probe ----------

export const ProbeTypeSchema = z.enum(['liveness', 'synthetic_paid', 'security', 'telemetry']);
export type ProbeType = z.infer<typeof ProbeTypeSchema>;

export const ProbeRecordSchema = z.object({
  probe_id: z.string(),
  endpoint_id: z.string(),
  ts: z.string().datetime(),
  probe_type: ProbeTypeSchema,
  source_region: z.string().optional(),
  source_class: z.enum(['cloud', 'residential', 'sdk-attested']).optional(),
  ok: z.boolean(),
  http_status: z.number().int().nullable().optional(),
  latency_ms: z.number().int().nonnegative().nullable().optional(),
  tls_valid: z.boolean().nullable().optional(),
  tls_expires_at: z.string().datetime().nullable().optional(),
  payment_tx_sig: z.string().nullable().optional(),
  response_hash: z.string().nullable().optional(),
  raw_blob_uri: z.string().nullable().optional(),
});
export type ProbeRecord = z.infer<typeof ProbeRecordSchema>;

// ---------- Scoring ----------

// Every dimension MUST emit confidence ∈ [0,1] alongside its score.
// The aggregator weights by weight × confidence, so under-evidenced
// dimensions naturally fade. This is the single most important
// invariant of the scoring contract.
export const DimensionScoreSchema = z.object({
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  weight: z.number().min(0).max(1),
  evidence_count: z.number().int().nonnegative(),
  version: z.string(),
});
export type DimensionScore = z.infer<typeof DimensionScoreSchema>;

export const TierSchema = z.enum(['S', 'A', 'B', 'C', 'D', 'F', 'PROVISIONAL']);
export type Tier = z.infer<typeof TierSchema>;

export const SignatureSchema = z.object({
  alg: z.literal('ed25519'),
  key_id: z.string(),
  sig: z.string(), // base64
});
export type Signature = z.infer<typeof SignatureSchema>;

export const ScoreSchema = z.object({
  score_id: z.string(),
  endpoint_id: z.string(),
  computed_at: z.string().datetime(),
  engine_version: z.string(),
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  tier: TierSchema,
  dimensions: z.record(z.string(), DimensionScoreSchema),
  signature: SignatureSchema.nullable().optional(),
});
export type Score = z.infer<typeof ScoreSchema>;

// ---------- API: /v1/discover ----------

export const SortBySchema = z.enum(['score', 'price', 'latency', 'confidence']);
export type SortBy = z.infer<typeof SortBySchema>;

export const DiscoverQuerySchema = z.object({
  capability: z.string().optional(),
  category: z.string().optional(),
  min_score: z.coerce.number().min(0).max(100).default(0),
  max_price_usd: z.coerce.number().nonnegative().default(1_000_000_000),
  sort_by: SortBySchema.default('score'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type DiscoverQuery = z.infer<typeof DiscoverQuerySchema>;

export const DiscoverResultSchema = z.object({
  endpoint: EndpointSchema,
  provider: ProviderSchema.pick({ id: true, slug: true, name: true, homepage: true }),
  score: ScoreSchema.nullable(),
  last_probe_ts: z.string().datetime().nullable(),
});
export type DiscoverResult = z.infer<typeof DiscoverResultSchema>;

export const DiscoverResponseSchema = z.object({
  results: z.array(DiscoverResultSchema),
  count: z.number().int().nonnegative(),
  engine_version: z.string(),
  generated_at: z.string().datetime(),
  query: DiscoverQuerySchema,
});
export type DiscoverResponse = z.infer<typeof DiscoverResponseSchema>;
