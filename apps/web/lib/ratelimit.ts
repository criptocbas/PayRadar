// In-memory sliding-window limiter.
//
// MVP-grade. Each Vercel function instance has its own memory, so a malicious
// caller hitting many warm instances bypasses the cap. Acceptable for v0.1
// where we just want to block dumb abuse. Upgrade path: @upstash/ratelimit
// (Redis-backed, ~5-line drop-in replacement).

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 60;

let lastSweepAt = Date.now();
const SWEEP_INTERVAL_MS = 60_000;

function maybeSweep() {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

export function rateLimit(
  key: string,
  opts?: { max?: number; windowMs?: number }
): RateLimitResult {
  const max = opts?.max ?? DEFAULT_MAX;
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const now = Date.now();
  maybeSweep();

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const fresh: Bucket = { count: 1, resetAt: now + windowMs };
    buckets.set(key, fresh);
    return { ok: true, limit: max, remaining: max - 1, resetAt: fresh.resetAt };
  }

  if (existing.count >= max) {
    return { ok: false, limit: max, remaining: 0, resetAt: existing.resetAt };
  }

  existing.count += 1;
  return {
    ok: true,
    limit: max,
    remaining: max - existing.count,
    resetAt: existing.resetAt,
  };
}

export function clientKey(req: Request): string {
  // Vercel sets x-forwarded-for; the first IP is the real client.
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip') ?? 'unknown';
}

export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  const retryAfter = Math.max(0, Math.ceil((r.resetAt - Date.now()) / 1000));
  return {
    'X-RateLimit-Limit': String(r.limit),
    'X-RateLimit-Remaining': String(r.remaining),
    'X-RateLimit-Reset': String(Math.floor(r.resetAt / 1000)),
    ...(r.ok ? {} : { 'Retry-After': String(retryAfter) }),
  };
}
