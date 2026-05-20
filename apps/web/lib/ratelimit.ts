// Rate limiter.
//
// Strategy:
//   - If UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set, use
//     @upstash/ratelimit (Redis-backed, sliding window, cross-instance).
//   - Otherwise fall back to a per-instance in-memory limiter so local dev
//     and unconfigured deploys still work — but every Vercel function
//     instance gets its own cap, so an attacker hitting many warm instances
//     bypasses it. Configure Upstash for real protection.

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 60;

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

// ---------------- Upstash branch (preferred) -------------------------------

let upstashLimiter: Ratelimit | null = null;
function getUpstash(): Ratelimit | null {
  if (upstashLimiter) return upstashLimiter;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const redis = new Redis({ url, token });
  upstashLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(DEFAULT_MAX, `${DEFAULT_WINDOW_MS / 1000} s`),
    analytics: false,
    prefix: 'payradar:rl',
  });
  return upstashLimiter;
}

// ---------------- In-memory fallback ---------------------------------------

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();
let lastSweepAt = Date.now();
const SWEEP_INTERVAL_MS = 60_000;

function maybeSweep() {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

function rateLimitInMemory(key: string): RateLimitResult {
  const now = Date.now();
  maybeSweep();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const fresh: Bucket = { count: 1, resetAt: now + DEFAULT_WINDOW_MS };
    buckets.set(key, fresh);
    return { ok: true, limit: DEFAULT_MAX, remaining: DEFAULT_MAX - 1, resetAt: fresh.resetAt };
  }
  if (existing.count >= DEFAULT_MAX) {
    return { ok: false, limit: DEFAULT_MAX, remaining: 0, resetAt: existing.resetAt };
  }
  existing.count += 1;
  return {
    ok: true,
    limit: DEFAULT_MAX,
    remaining: DEFAULT_MAX - existing.count,
    resetAt: existing.resetAt,
  };
}

// ---------------- Public API -----------------------------------------------

export interface RateLimitResultWithBackend extends RateLimitResult {
  backend: 'upstash' | 'memory';
}

export async function rateLimit(key: string): Promise<RateLimitResultWithBackend> {
  const upstash = getUpstash();
  if (upstash) {
    const { success, limit, remaining, reset } = await upstash.limit(key);
    return { ok: success, limit, remaining, resetAt: reset, backend: 'upstash' };
  }
  return { ...rateLimitInMemory(key), backend: 'memory' };
}

export function clientKey(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip') ?? 'unknown';
}

export function rateLimitHeaders(
  r: RateLimitResult | RateLimitResultWithBackend
): Record<string, string> {
  const retryAfter = Math.max(0, Math.ceil((r.resetAt - Date.now()) / 1000));
  const backend = (r as RateLimitResultWithBackend).backend;
  return {
    'X-RateLimit-Limit': String(r.limit),
    'X-RateLimit-Remaining': String(r.remaining),
    'X-RateLimit-Reset': String(Math.floor(r.resetAt / 1000)),
    ...(backend ? { 'X-RateLimit-Backend': backend } : {}),
    ...(r.ok ? {} : { 'Retry-After': String(retryAfter) }),
  };
}
