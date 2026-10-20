/**
 * GoreTok — shared HTTP helpers: security headers, JSON responses,
 * and an in-memory per-IP rate limiter (mirrors api/admin-gate.js).
 */

export const secHeaders = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Referrer-Policy': 'no-referrer'
};

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...secHeaders }
  });
}

export function clientIp(req) {
  const xff = (typeof req.headers.get === 'function')
    ? req.headers.get('x-forwarded-for')
    : req.headers['x-forwarded-for'];
  return (xff && String(xff).split(',')[0].trim()) || 'unknown';
}

// ── Rate limiting (same thresholds/style as admin-gate.js) ──────────────────
// NOTE: in-memory per Edge instance; resets on cold start. First-line throttle,
// not a hard security boundary — same caveat as admin-gate.js.

const MAX_TRIES = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 min
const attempts = new Map(); // ip -> { count, lockedUntil }

export function checkRateLimit(ip) {
  const now = Date.now();
  const state = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  if (state.lockedUntil > now) {
    return { blocked: true, remaining: Math.ceil((state.lockedUntil - now) / 60000) };
  }
  return { blocked: false };
}

export function recordFail(ip) {
  const state = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  state.count++;
  if (state.count >= MAX_TRIES) {
    state.lockedUntil = Date.now() + LOCKOUT_MS;
    state.count = 0;
  }
  attempts.set(ip, state);
  return state;
}

export function clearFails(ip) {
  attempts.delete(ip);
}
