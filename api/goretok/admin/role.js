/**
 * POST /api/goretok/admin/role — Edge
 * Assign/change a user's role (including founder). Protected by the EXISTING
 * admin-gate.js HMAC token (KAPCS_ADMIN_SECRET).
 */
export const config = { runtime: 'edge' };

import { json, secHeaders } from '../_lib/http.js';
import { verifyAdminToken, bearerFrom } from '../_lib/crypto.js';
import { validateHandle, validateRole } from '../_lib/validate.js';
import { getKv } from '../_lib/kv.js';

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: secHeaders });

  const token = bearerFrom(req);
  const valid = token ? await verifyAdminToken(token) : null;
  if (!valid) return json({ error: 'Forbidden.' }, 403);

  let body = {};
  try { body = await req.json(); } catch {}

  const h = validateHandle(body.handle);
  if (!h.ok) return json({ error: h.error }, 400);
  const r = validateRole(body.role);
  if (!r.ok) return json({ error: r.error }, 400);

  const handle = h.value;
  const newRole = r.value;

  try {
    const kv = await getKv();
    const raw = await kv.get(`gt:user:${handle}`);
    const user = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!user) return json({ error: 'Account not found.' }, 404);

    const oldRole = user.role || 'user';
    if (oldRole !== newRole) {
      await kv.decr(`gt:role:count:${oldRole}`);
      await kv.incr(`gt:role:count:${newRole}`);
    }
    user.role = newRole;
    await kv.set(`gt:user:${handle}`, JSON.stringify(user));

    return json({ handle, role: newRole }, 200);
  } catch (err) {
    console.error('admin role failed:', err && err.name);
    return json({ error: 'Could not assign role.' }, 500);
  }
}
