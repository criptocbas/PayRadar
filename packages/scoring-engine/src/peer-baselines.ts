import type { ProbeRecord } from '@payradar/schema';

// Map of capability tag → median p95 latency from peers, in ms.
// "Peer" = any other endpoint that advertises this capability.
//
// The latency dimension scores like-with-like: a paid LLM endpoint will always
// be slower than a fast geocoder, but within each capability cohort we can
// compare apples to apples.
//
// Future: when we add pgvector capability embeddings, expand peer matching
// from exact-tag to similarity > 0.85. Until then exact-tag is good enough
// because pay-skills authors generally agree on common verbs (geocode, embed,
// transcribe, etc.).

export type PeerBaselines = Map<string, number>;

export const GLOBAL_DEFAULT_P95_MS = 1500;
const MIN_SAMPLES_PER_PEER = 5;
const MIN_PEERS = 2;

function p95(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * 0.95))]!;
}

function median(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.floor(sortedAsc.length / 2)]!;
}

export function computePeerBaselines(
  endpointsByCapability: Map<string, string[]>,
  probesByEndpoint: Map<string, ProbeRecord[]>
): PeerBaselines {
  const out: PeerBaselines = new Map();

  for (const [capability, endpointIds] of endpointsByCapability) {
    const peerP95s: number[] = [];

    for (const id of endpointIds) {
      const probes = probesByEndpoint.get(id) ?? [];
      const latencies = probes
        .filter((p) => p.ok && typeof p.latency_ms === 'number')
        .map((p) => p.latency_ms!)
        .sort((a, b) => a - b);
      if (latencies.length < MIN_SAMPLES_PER_PEER) continue;
      peerP95s.push(p95(latencies));
    }

    if (peerP95s.length < MIN_PEERS) continue;
    peerP95s.sort((a, b) => a - b);
    out.set(capability, median(peerP95s));
  }

  return out;
}

// Resolves a baseline for a single endpoint by walking its capability tags
// in declaration order. Falls back to the global default when no peer cohort
// has enough samples — this is the cold-ecosystem case.
export function lookupPeerBaseline(
  capabilities: readonly string[],
  baselines: PeerBaselines
): number {
  for (const cap of capabilities) {
    const b = baselines.get(cap);
    if (b !== undefined) return b;
  }
  return GLOBAL_DEFAULT_P95_MS;
}
