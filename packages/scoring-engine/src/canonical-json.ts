// Deterministic JSON encoding: keys sorted recursively, no whitespace.
// We sign the canonical form so that any verifier — anywhere, in any language —
// can reproduce the exact bytes that were signed. JSON.stringify alone is not
// canonical because object key order is implementation-defined.
//
// Caveats:
//   - undefined values are dropped (matches JSON spec).
//   - non-finite numbers (NaN, Infinity) are not allowed; we throw.
//   - Date instances are not supported; use ISO 8601 strings upstream.

export function canonicalize(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalize: non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => (v === undefined ? 'null' : canonicalize(v)));
    return '[' + parts.join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k]));
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`canonicalize: unsupported type ${typeof value}`);
}
