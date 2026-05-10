import { supabase } from './supabase.js';

export type RunKind = 'catalog' | 'probes' | 'scoring';

// Wraps an ingestor function with sync_runs bookkeeping. Best-effort —
// a failure to write the run record never masks the real error or breaks
// the pipeline. /api/v1/status reads from this table.
export async function trackRun<T>(kind: RunKind, fn: () => Promise<T>): Promise<T> {
  const startedAt = new Date().toISOString();
  let ok = false;
  let result: T | undefined;
  let errMsg: string | null = null;

  try {
    result = await fn();
    ok = true;
    return result;
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    try {
      const sb = supabase();
      await sb.from('sync_runs').insert({
        kind,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        ok,
        details: ok ? (result as unknown) : { error: errMsg },
      });
    } catch {
      // Swallow — the ingestor's primary job is not bookkeeping.
    }
  }
}
