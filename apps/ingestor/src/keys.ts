import { makeSigner, type Signer } from '@payradar/scoring-engine';

let cached: Signer | null | undefined;

// Lazy: returns null if no signing key is configured. Scores written without
// a signature are still useful (the dashboard works fine), but agents won't
// be able to verify them — so we log loudly when the key is missing.
export async function loadSigner(): Promise<Signer | null> {
  if (cached !== undefined) return cached;

  const sk = process.env.PAYRADAR_SIGNING_PRIVATE_KEY_HEX;
  const keyId = process.env.PAYRADAR_SIGNING_KEY_ID ?? 'pr-oracle-2026-q2';

  if (!sk) {
    console.warn(
      '[scoring] PAYRADAR_SIGNING_PRIVATE_KEY_HEX is not set — emitting unsigned scores. ' +
        'Generate a key with: pnpm -F @payradar/ingestor exec tsx src/keygen.ts'
    );
    cached = null;
    return null;
  }

  cached = await makeSigner(sk, keyId);
  return cached;
}
