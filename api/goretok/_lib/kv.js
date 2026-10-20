/**
 * GoreTok — KV accessor.
 *
 * Wraps @vercel/kv behind an async-initialized singleton so every route
 * imports the same client. In tests, @vercel/kv is stubbed with an in-memory
 * Map-backed implementation (no credentials needed).
 *
 * KV connection comes from Vercel-injected env vars (KV_REST_API_URL,
 * KV_REST_API_TOKEN, ...) when a Vercel KV / Upstash store is linked.
 */

let _kv = null;

export async function getKv() {
  if (_kv) return _kv;
  const mod = await import('@vercel/kv');
  _kv = mod.kv || mod.default || mod;
  return _kv;
}
