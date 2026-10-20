/**
 * POST /api/goretok/register — Edge
 * Create a username/password account (PBKDF2-hashed), return a session token.
 */
export const config = { runtime: 'edge' };

import { json, secHeaders, clientIp, checkRateLimit, recordFail, clearFails } from './_lib/http.js';
import { validateHandle, validatePassword } from './_lib/validate.js';
import { makeSessionToken, hashPassword, randomSaltHex } from './_lib/crypto.js';
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
  if (!h.ok) return json({ error: h.error }, 400);
  const p = validatePassword(body.password);
  if (!p.ok) return json({ error: p.error }, 400);

  const handle = h.value;

  try {
    const kv = await getKv();
    const exists = await kv.exists(`gt:user:${handle}`);
    if (exists) {
      recordFail(ip);
      return json({ error: 'That handle is already taken.' }, 409);
    }

    const salt = randomSaltHex(16);
    const passwordHash = await hashPassword(p.value, salt);
    const user = {
      handle,
      passwordHash,
      salt,
      role: 'user',
      createdAt: Date.now(),
      likes: 0
    };

    await kv.set(`gt:user:${handle}`, JSON.stringify(user));
    await kv.sadd('gt:users:index', handle);
    await kv.incr('gt:users:count');
    await kv.incr('gt:role:count:user');

    clearFails(ip);
    const token = await makeSessionToken(handle);
    return json({ token, user: { handle, role: 'user', likes: 0 } }, 201);
  } catch (err) {
    // Never log the password; error type only.
    console.error('register failed:', err && err.name);
    return json({ error: 'Could not create account.' }, 500);
  }
}
