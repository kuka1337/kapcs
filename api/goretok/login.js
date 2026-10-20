/**
 * POST /api/goretok/login — Edge
 * Verify handle + password (constant-time), return a session token.
 * Generic "invalid credentials" for both unknown handle and wrong password
 * (no user enumeration).
 */
export const config = { runtime: 'edge' };

import { json, secHeaders, clientIp, checkRateLimit, recordFail, clearFails } from './_lib/http.js';
import { validateHandle, validatePassword } from './_lib/validate.js';
import { makeSessionToken, verifyPassword } from './_lib/crypto.js';
import { getKv } from './_lib/kv.js';

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: secHeaders });

  const ip = clientIp(req);
  const rl = checkRateLimit(ip);
  if (rl.blocked) {
    return json({ error: `Too many attempts. Locked for ${rl.remaining} more minute(s).` }, 429);
  }

  let body = {};
  try { body = await req.json(); } catch {}

  const h = validateHandle(body.handle);
  const p = validatePassword(body.password);
  // Even on malformed input, respond with the generic credential error
  // so the shape of valid handles is not revealed.
  if (!h.ok || !p.ok) {
    recordFail(ip);
    return json({ error: 'Invalid credentials.' }, 401);
  }

  const handle = h.value;

  try {
    const kv = await getKv();
    const raw = await kv.get(`gt:user:${handle}`);
    const user = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (!user || !user.salt || !user.passwordHash) {
      recordFail(ip);
      return json({ error: 'Invalid credentials.' }, 401);
    }

    const ok = await verifyPassword(p.value, user.salt, user.passwordHash);
    if (!ok) {
      recordFail(ip);
      return json({ error: 'Invalid credentials.' }, 401);
    }

    clearFails(ip);
    const token = await makeSessionToken(handle);
    return json({ token, user: { handle, role: user.role || 'user', likes: user.likes || 0 } }, 200);
  } catch (err) {
    console.error('login failed:', err && err.name);
    return json({ error: 'Could not sign in.' }, 500);
  }
}
