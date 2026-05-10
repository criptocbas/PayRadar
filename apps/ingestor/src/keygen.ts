// One-shot helper: generates an ed25519 keypair and prints env-var instructions.
// Run with: pnpm -F @payradar/ingestor exec tsx src/keygen.ts
import { generateKeyPair } from '@payradar/scoring-engine';

async function main() {
  const { privateKeyHex, publicKeyHex } = await generateKeyPair();
  console.log('# PayRadar oracle signing key');
  console.log('# Add to .env.local AND to your Vercel project (server-only).');
  console.log('PAYRADAR_SIGNING_KEY_ID=pr-oracle-2026-q2');
  console.log(`PAYRADAR_SIGNING_PRIVATE_KEY_HEX=${privateKeyHex}`);
  console.log(`PAYRADAR_SIGNING_PUBLIC_KEY_HEX=${publicKeyHex}`);
  console.log('# The public key is also published at /.well-known/payradar-keys.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
