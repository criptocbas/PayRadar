#!/usr/bin/env node
// PayRadar MCP server.
//
// Exposes two tools so any MCP-aware agent (Claude Desktop, Cline, custom
// runtimes) can discover ranked pay.sh endpoints and cryptographically verify
// the scores it gets back — without trusting our server.
//
// Transport: stdio. Run with:
//   npx -y @payradar/mcp
// or via Claude Desktop config:
//   "payradar": { "command": "npx", "args": ["-y", "@payradar/mcp"] }

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { verifySignature } from '@payradar/scoring-engine';

const DEFAULT_BASE = 'https://pay-radar-web.vercel.app';
const PAYRADAR_BASE = process.env.PAYRADAR_BASE_URL ?? DEFAULT_BASE;

interface DiscoverResultRow {
  endpoint: {
    id: string;
    method: string;
    url: string;
    capabilities: string[];
    pricing?: { amount_usd?: number } | null;
  };
  provider: { name: string; slug: string };
  score: unknown;
  last_probe_ts: string | null;
}
interface DiscoverResponse {
  results: DiscoverResultRow[];
  count: number;
  engine_version: string;
  generated_at: string;
  query: unknown;
}
interface ScoreLike {
  score: number;
  confidence: number;
  tier: string;
}

const DiscoverArgs = z
  .object({
    capability: z
      .string()
      .optional()
      .describe(
        'Free-text capability keyword. Matches per-endpoint capability tags (e.g. "email", "geocode", "embed").'
      ),
    category: z
      .string()
      .optional()
      .describe('Provider category, e.g. "messaging", "finance", "ai".'),
    sort_by: z
      .enum(['score', 'price', 'latency', 'confidence'])
      .optional()
      .describe('How to rank results. Default: score (highest first).'),
    max_price_usd: z
      .number()
      .nonnegative()
      .optional()
      .describe('Reject endpoints whose per-call price exceeds this in USD.'),
    min_score: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe('Reject endpoints whose score is below this floor.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('Cap on number of results. Default 5.'),
  })
  .strict();

const VerifyArgs = z
  .object({
    score: z
      .object({
        endpoint_id: z.string(),
        computed_at: z.string(),
        engine_version: z.string(),
        score: z.number(),
        confidence: z.number(),
        tier: z.string(),
        dimensions: z.record(z.string(), z.unknown()),
        signature: z.object({
          alg: z.literal('ed25519'),
          key_id: z.string(),
          sig: z.string(),
        }),
      })
      .describe(
        'A Score object as returned by /v1/discover. Pass the entire `score` field of a discover result.'
      ),
  })
  .strict();

const server = new Server(
  { name: 'payradar', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'discover',
      description:
        'Rank pay.sh endpoints by reliability, latency, and freshness. Returns up to N signed scores. Pass the result of one row to verify_score to cryptographically confirm it was signed by the PayRadar oracle.',
      inputSchema: {
        type: 'object',
        properties: {
          capability: {
            type: 'string',
            description:
              'Free-text capability keyword. Matches per-endpoint capability tags.',
          },
          category: {
            type: 'string',
            description: 'Provider category, e.g. "messaging", "finance".',
          },
          sort_by: {
            type: 'string',
            enum: ['score', 'price', 'latency', 'confidence'],
            description: 'How to rank results. Default: score (highest first).',
          },
          max_price_usd: {
            type: 'number',
            minimum: 0,
            description:
              'Reject endpoints whose per-call price exceeds this in USD.',
          },
          min_score: {
            type: 'number',
            minimum: 0,
            maximum: 100,
            description: 'Reject endpoints whose score is below this floor.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            description: 'Cap on number of results. Default 5.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'verify_score',
      description:
        "Verify a signed score's ed25519 signature against the PayRadar oracle's published public key. Returns {ok: true} on a clean verify, {ok: false, reason} otherwise. Use this whenever you're about to act on a score and want offline assurance it wasn't tampered with.",
      inputSchema: {
        type: 'object',
        properties: {
          score: {
            type: 'object',
            description:
              'A Score object as returned by /v1/discover (pass the entire `score` field of one result).',
          },
        },
        required: ['score'],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === 'discover') return await handleDiscover(args);
    if (name === 'verify_score') return await handleVerify(args);
    throw new Error(`unknown tool: ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `error: ${message}` }],
      isError: true,
    };
  }
});

async function handleDiscover(rawArgs: unknown) {
  const args = DiscoverArgs.parse(rawArgs ?? {});
  const sp = new URLSearchParams();
  if (args.capability) sp.set('capability', args.capability);
  if (args.category) sp.set('category', args.category);
  if (args.sort_by) sp.set('sort_by', args.sort_by);
  if (args.max_price_usd != null) sp.set('max_price_usd', String(args.max_price_usd));
  if (args.min_score != null) sp.set('min_score', String(args.min_score));
  sp.set('limit', String(args.limit ?? 5));

  const url = `${PAYRADAR_BASE}/api/v1/discover?${sp.toString()}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`PayRadar /v1/discover returned ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as DiscoverResponse;

  // Project to a compact agent-friendly summary so the model doesn't burn
  // context on fields it won't act on. Full score is still in `score` for
  // anyone who wants to pass it to verify_score.
  const summary = (data.results ?? []).map((r) => {
    const scoreInfo = r.score as ScoreLike | null;
    return {
      endpoint_id: r.endpoint.id,
      provider: r.provider.name,
      provider_slug: r.provider.slug,
      url: r.endpoint.url,
      method: r.endpoint.method,
      capabilities: r.endpoint.capabilities,
      price_usd: r.endpoint.pricing?.amount_usd ?? null,
      score: scoreInfo?.score ?? null,
      confidence: scoreInfo?.confidence ?? null,
      tier: scoreInfo?.tier ?? null,
      last_probe_ts: r.last_probe_ts,
      score_payload: r.score,
    };
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            query: data.query,
            count: data.count,
            engine_version: data.engine_version,
            generated_at: data.generated_at,
            results: summary,
            note:
              'To cryptographically verify any result before acting on it, call verify_score with the `score_payload` field.',
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleVerify(rawArgs: unknown) {
  const args = VerifyArgs.parse(rawArgs ?? {});
  const s = args.score;

  const keysUrl = `${PAYRADAR_BASE}/.well-known/payradar-keys.json`;
  const res = await fetch(keysUrl, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`/.well-known/payradar-keys.json returned ${res.status}`);
  }
  const { keys } = (await res.json()) as {
    keys: { kid: string; alg: string; public_key_hex: string; active: boolean }[];
  };
  const key = keys.find((k) => k.kid === s.signature.key_id);
  if (!key) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { ok: false, reason: `no published key with kid=${s.signature.key_id}` },
            null,
            2
          ),
        },
      ],
    };
  }

  const payload = {
    endpoint_id: s.endpoint_id,
    computed_at: s.computed_at,
    engine_version: s.engine_version,
    score: s.score,
    confidence: s.confidence,
    tier: s.tier,
    dimensions: s.dimensions,
  };
  const ok = await verifySignature(payload, s.signature, key.public_key_hex);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            ok,
            endpoint_id: s.endpoint_id,
            key_id: s.signature.key_id,
            ...(ok
              ? {}
              : {
                  reason:
                    'signature did not verify against the published key. Reject this score.',
                }),
          },
          null,
          2
        ),
      },
    ],
  };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[payradar-mcp] connected. backend=${PAYRADAR_BASE}. tools: discover, verify_score`
  );
}

main().catch((err) => {
  console.error('[payradar-mcp] fatal:', err);
  process.exit(1);
});
