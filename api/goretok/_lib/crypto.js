/**
 * GoreTok — shared crypto helpers (Web Crypto, Edge + Node compatible)
 *
 * - HMAC-SHA256 session tokens with TTL + constant-time compare
 *   (token format: "<ts>.<handle>.<sig>", mirrors api/admin-gate.js)
 * - PBKDF2 salted password hashing
 *
 * Secrets come only from env vars; never log or return passwords/secrets.
 */

export const SESSION_TTL = 24 * 60 * 60 * 1000; // 24h (end-user session)
const PBKDF2_ITERATIONS = 150000;
const PBKDF2_HASH = 'SHA-256';
const PBKDF2_KEYLEN = 32; // bytes

// Local-dev fallback ONLY — flagged exactly like api/admin-gate.js does.
// In production GORETOK_AUTH_SECRET must be set (>=32 random chars).
export const GORETOK_SECRET =
  (typeof process !== 'undefined' && process.env && process.env.GORETOK_AUTH_SECRET) ||
  'goretok-default-secret-change-me-32ch';

// ── hex helpers ───────────────────────────────────────────────────────────

function toHex(buf) {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function fromHex(hex) {
  const len = hex.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// ── Base64 URL-safe (matches admin-gate.js signature encoding) ──────────────

function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── HMAC-SHA256 ─────────────────────────────────────────────────────────────

async function getHmacKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

async function signPayload(payload, secret) {
  const key = await getHmacKey(secret);
  const enc = new TextEncoder();
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return b64url(sig);
}

// Constant-time string compare.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint a session token: "<ts>.<handle>.<sig>" where
 * sig = HMAC-SHA256(secret, "<ts>.<handle>").
 */
export async function makeSessionToken(handle, secret = GORETOK_SECRET) {
  const ts = Date.now();
  const payload = `${ts}.${handle}`;
  const sig = await signPayload(payload, secret);
  return `${payload}.${sig}`;
}

/**
 * Verify a session token. Returns { ts, handle } on success, else null.
 * Splits on the LAST dot for the signature (handle may not contain '.').
 */
export async function verifySessionToken(token, secret = GORETOK_SECRET) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const dot = token.lastIndexOf('.');
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const firstDot = payload.indexOf('.');
  if (firstDot < 0) return null;
  const tsStr = payload.slice(0, firstDot);
  const handle = payload.slice(firstDot + 1);
  const ts = parseInt(tsStr, 10);
  if (isNaN(ts) || Date.now() - ts > SESSION_TTL) return null;
  if (!handle) return null;
  const expected = await signPayload(payload, secret);
  if (!safeEqual(expected, sig)) return null;
  return { ts, handle };
}

// ── Admin gate token (same scheme as api/admin-gate.js: "<ts>.<sig>") ───────

const ADMIN_TTL = 2 * 60 * 60 * 1000; // 2h, matches admin-gate.js

export const KAPCS_ADMIN_SECRET =
  (typeof process !== 'undefined' && process.env && process.env.KAPCS_ADMIN_SECRET) ||
  'kapcs-default-secret-change-me-32ch';

/**
 * Verify an admin-gate.js HMAC token ("<ts>.<sig>"). Returns ts or null.
 */
export async function verifyAdminToken(token, secret = KAPCS_ADMIN_SECRET) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const dot = token.lastIndexOf('.');
  const tsStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const ts = parseInt(tsStr, 10);
  if (isNaN(ts) || Date.now() - ts > ADMIN_TTL) return null;
  const expected = await signPayload(String(ts), secret);
  if (!safeEqual(expected, sig)) return null;
  return ts;
}

// ── PBKDF2 password hashing ──────────────────────────────────────────────────

export function randomSaltHex(bytes = 16) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf.buffer);
}

/**
 * Derive a PBKDF2 hash (hex) for a password + hex salt.
 */
export async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
    baseKey,
    PBKDF2_KEYLEN * 8
  );
  return toHex(bits);
}

/**
 * Constant-time verify a password against a stored hash+salt.
 */
export async function verifyPassword(password, saltHex, expectedHashHex) {
  const actual = await hashPassword(password, saltHex);
  return safeEqual(actual, expectedHashHex);
}

// ── Bearer header helper ─────────────────────────────────────────────────────

export function bearerFrom(req) {
  const auth = (typeof req.headers.get === 'function')
    ? req.headers.get('authorization')
    : req.headers.authorization || req.headers.Authorization;
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : null;
}
