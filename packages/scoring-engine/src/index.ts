export { ENGINE_VERSION } from './version.js';

export {
  reliabilityScore,
  VERSION as RELIABILITY_VERSION,
  WEIGHT as RELIABILITY_WEIGHT,
} from './dimensions/reliability.js';

export {
  latencyScore,
  DEFAULT_PEER_P95_MS,
  VERSION as LATENCY_VERSION,
  WEIGHT as LATENCY_WEIGHT,
} from './dimensions/latency.js';

export {
  freshnessScore,
  VERSION as FRESHNESS_VERSION,
  WEIGHT as FRESHNESS_WEIGHT,
} from './dimensions/freshness.js';

export { aggregate, DEFAULT_WEIGHTS } from './aggregator.js';
export type { AggregateResult } from './aggregator.js';

export {
  computePeerBaselines,
  lookupPeerBaseline,
  GLOBAL_DEFAULT_P95_MS,
} from './peer-baselines.js';
export type { PeerBaselines } from './peer-baselines.js';

export {
  makeSigner,
  generateKeyPair,
  verifySignature,
  hexToBytes,
  bytesToHex,
} from './signer.js';
export type { Signer } from './signer.js';

export { canonicalize } from './canonical-json.js';
