'use client';

import { useState } from 'react';
import { verifySignature } from '@payradar/scoring-engine';

interface Props {
  // Exactly the fields the ingestor signed over. Order doesn't matter (the
  // canonicalizer sorts keys), but the *set* must match — score_id and
  // last_probe_ts are intentionally excluded.
  payload: {
    endpoint_id: string;
    computed_at: string;
    engine_version: string;
    score: number;
    confidence: number;
    tier: string;
    dimensions: Record<string, unknown>;
  };
  signature: { alg: 'ed25519'; key_id: string; sig: string };
}

type State =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  | { kind: 'ok'; verifiedAt: Date; keyId: string }
  | { kind: 'fail'; reason: string };

export function VerifyButton({ payload, signature }: Props) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function verify() {
    setState({ kind: 'verifying' });
    try {
      const res = await fetch('/.well-known/payradar-keys.json');
      if (!res.ok) throw new Error(`well-known fetch failed: ${res.status}`);
      const { keys } = (await res.json()) as {
        keys: { kid: string; public_key_hex: string }[];
      };
      const key = keys.find((k) => k.kid === signature.key_id);
      if (!key) {
        throw new Error(`no public key registered for kid "${signature.key_id}"`);
      }
      const ok = await verifySignature(payload, signature, key.public_key_hex);
      if (!ok) {
        setState({ kind: 'fail', reason: 'signature did not verify against published key' });
        return;
      }
      setState({ kind: 'ok', verifiedAt: new Date(), keyId: signature.key_id });
    } catch (err) {
      setState({
        kind: 'fail',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (state.kind === 'idle') {
    return (
      <button
        onClick={verify}
        className="text-xs px-3 py-1 rounded border border-white/10 hover:border-sky-500/40 hover:text-sky-400"
      >
        Verify signature
      </button>
    );
  }
  if (state.kind === 'verifying') {
    return (
      <span className="text-xs text-white/50 inline-flex items-center gap-1.5">
        <span className="inline-block w-2 h-2 rounded-full bg-white/40 animate-pulse" />
        verifying…
      </span>
    );
  }
  if (state.kind === 'ok') {
    return (
      <span className="text-xs text-green-400 inline-flex items-center gap-1.5">
        ✓ verified locally · {state.keyId} · {state.verifiedAt.toISOString()}
      </span>
    );
  }
  return (
    <span className="text-xs text-red-400 inline-flex items-center gap-1.5">
      ✗ {state.reason}
    </span>
  );
}
