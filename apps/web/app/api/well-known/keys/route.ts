// Publishes the oracle public key(s) that signed scores in /v1/discover.
// Verifier flow:
//   1. fetch /.well-known/payradar-keys.json   (this route, via rewrite)
//   2. read score.signature.key_id             (returned by /v1/discover)
//   3. find the matching `kid` in the keys array
//   4. ed25519-verify(score.signature.sig, canonicalize(scorePayload), key.public_key_hex)

export const runtime = 'nodejs';
export const revalidate = 3600;

interface KeyEntry {
  kid: string;
  alg: 'ed25519';
  public_key_hex: string;
  active: boolean;
}

export async function GET() {
  const keys: KeyEntry[] = [];

  const pubHex = process.env.PAYRADAR_SIGNING_PUBLIC_KEY_HEX;
  const keyId = process.env.PAYRADAR_SIGNING_KEY_ID ?? 'pr-oracle-2026-q2';
  if (pubHex) {
    keys.push({ kid: keyId, alg: 'ed25519', public_key_hex: pubHex, active: true });
  }

  // Optional: rotated/retired keys, comma-separated:
  //   PAYRADAR_RETIRED_KEYS="oldkid:hex,olderkid:hex"
  const retired = process.env.PAYRADAR_RETIRED_KEYS;
  if (retired) {
    for (const entry of retired.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [kid, hex] = entry.split(':');
      if (kid && hex) keys.push({ kid, alg: 'ed25519', public_key_hex: hex, active: false });
    }
  }

  return Response.json(
    { keys },
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=3600',
      },
    }
  );
}
