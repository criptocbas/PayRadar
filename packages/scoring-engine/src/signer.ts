import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import type { Signature } from '@payradar/schema';
import { canonicalize } from './canonical-json.js';

// Wire sha512 into @noble/ed25519 v2 (required for signAsync/verifyAsync).
ed.etc.sha512Async = (...m) => Promise.resolve(sha512(ed.etc.concatBytes(...m)));
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export interface Signer {
  readonly keyId: string;
  readonly publicKeyHex: string;
  sign(payload: unknown): Promise<Signature>;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase();
  if (clean.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  // Server-only path. The ingestor that calls this runs on Node.
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  // Browser fallback (not currently used; included for completeness).
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export async function generateKeyPair(): Promise<{
  privateKeyHex: string;
  publicKeyHex: string;
}> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKeyHex: bytesToHex(privateKey), publicKeyHex: bytesToHex(publicKey) };
}

export async function makeSigner(privateKeyHex: string, keyId: string): Promise<Signer> {
  const privateKey = hexToBytes(privateKeyHex);
  if (privateKey.length !== 32) throw new Error('ed25519 private key must be 32 bytes');
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const publicKeyHex = bytesToHex(publicKey);

  return {
    keyId,
    publicKeyHex,
    async sign(payload) {
      const message = new TextEncoder().encode(canonicalize(payload));
      const sigBytes = await ed.signAsync(message, privateKey);
      return { alg: 'ed25519', key_id: keyId, sig: bytesToBase64(sigBytes) };
    },
  };
}

export async function verifySignature(
  payload: unknown,
  signature: Signature,
  publicKeyHex: string
): Promise<boolean> {
  const message = new TextEncoder().encode(canonicalize(payload));
  const pub = hexToBytes(publicKeyHex);
  const sig = typeof Buffer !== 'undefined'
    ? new Uint8Array(Buffer.from(signature.sig, 'base64'))
    : Uint8Array.from(atob(signature.sig), (c) => c.charCodeAt(0));
  return ed.verifyAsync(sig, message, pub);
}
