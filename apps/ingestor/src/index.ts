// Public surface for the ingestor package, consumed by:
//   - apps/web cron route handlers
//   - the local CLI in cli.ts
//
// The exported functions are wrapped in trackRun() so every invocation
// produces a sync_runs row, which feeds /api/v1/status. Internal callers
// that need the raw, untracked versions can import from the underlying
// modules directly.

import { syncCatalog as _syncCatalog } from './sync-catalog.js';
import { runProbes as _runProbes } from './run-probes.js';
import { runScoring as _runScoring } from './run-scoring.js';
import { trackRun } from './track.js';

export const syncCatalog = () => trackRun('catalog', _syncCatalog);
export const runProbes = () => trackRun('probes', _runProbes);
export const runScoring = () => trackRun('scoring', _runScoring);

export { trackRun } from './track.js';
export type { RunKind } from './track.js';
