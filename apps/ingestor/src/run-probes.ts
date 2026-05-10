import { randomUUID } from 'node:crypto';
import type { ProbeRecord } from '@payradar/schema';
import { supabase } from './supabase.js';

const PROBE_TIMEOUT_MS = 8_000;
const CONCURRENCY = 16;

async function probeEndpoint(endpoint: {
  id: string;
  url: string;
  method: string;
}): Promise<ProbeRecord> {
  const ts = new Date().toISOString();
  const probeId = `prb_${randomUUID()}`;
  const startedAt = performance.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    // HEAD first (cheap), fall back to GET if the server doesn't allow HEAD.
    let res: Response;
    try {
      res = await fetch(endpoint.url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: { 'User-Agent': 'PayRadar-Probe/0.1' },
        redirect: 'follow',
      });
      if (res.status === 405 || res.status === 501) {
        res = await fetch(endpoint.url, {
          method: 'GET',
          signal: controller.signal,
          headers: { 'User-Agent': 'PayRadar-Probe/0.1' },
          redirect: 'follow',
        });
      }
    } catch {
      res = await fetch(endpoint.url, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'User-Agent': 'PayRadar-Probe/0.1' },
        redirect: 'follow',
      });
    }

    const latencyMs = Math.round(performance.now() - startedAt);

    // 2xx, 3xx, 401, 402, 403 all imply the endpoint is alive.
    // 402 is x402 payment-required and is an expected response for paid endpoints.
    const aliveCodes = res.status < 400 || [401, 402, 403, 405].includes(res.status);

    return {
      probe_id: probeId,
      endpoint_id: endpoint.id,
      ts,
      probe_type: 'liveness',
      source_region: process.env.PROBE_REGION ?? 'unknown',
      source_class: 'cloud',
      ok: aliveCodes,
      http_status: res.status,
      latency_ms: latencyMs,
      tls_valid: endpoint.url.startsWith('https://'),
    };
  } catch (err) {
    return {
      probe_id: probeId,
      endpoint_id: endpoint.id,
      ts,
      probe_type: 'liveness',
      source_region: process.env.PROBE_REGION ?? 'unknown',
      source_class: 'cloud',
      ok: false,
      http_status: null,
      latency_ms: null,
      tls_valid: endpoint.url.startsWith('https://'),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function inBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const out = await Promise.all(batch.map(fn));
    results.push(...out);
  }
  return results;
}

export async function runProbes(): Promise<{ probed: number; ok: number; failed: number }> {
  const sb = supabase();
  const { data: endpoints, error } = await sb
    .from('endpoints')
    .select('id, url, method')
    .eq('active', true);

  if (error) throw error;
  if (!endpoints || endpoints.length === 0) return { probed: 0, ok: 0, failed: 0 };

  const probes = await inBatches(endpoints, CONCURRENCY, probeEndpoint);
  const { error: insertError } = await sb.from('probes').insert(
    probes.map((p) => ({
      probe_id: p.probe_id,
      endpoint_id: p.endpoint_id,
      ts: p.ts,
      probe_type: p.probe_type,
      source_region: p.source_region,
      source_class: p.source_class,
      ok: p.ok,
      http_status: p.http_status,
      latency_ms: p.latency_ms,
      tls_valid: p.tls_valid,
    }))
  );
  if (insertError) throw insertError;

  return {
    probed: probes.length,
    ok: probes.filter((p) => p.ok).length,
    failed: probes.filter((p) => !p.ok).length,
  };
}
