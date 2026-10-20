/**
 * GET /api/goretok/admin/stats — Edge
 * Total users + posts + per-role breakdown. Protected by the EXISTING
 * admin-gate.js HMAC token (KAPCS_ADMIN_SECRET). Counts only, no PII.
 */
export const config = { runtime: 'edge' };

import { json, secHeaders } from '../_lib/http.js';
import { verifyAdminToken, bearerFrom } from '../_lib/crypto.js';
import { ROLES } from '../_lib/validate.js';
import { getKv } from '../_lib/kv.js';

export default async function handler(req) {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: secHeaders });

  const token = bearerFrom(req);
  const valid = token ? await verifyAdminToken(token) : null;
  if (!valid) return json({ error: 'Forbidden.' }, 403);

  try {
    const kv = await getKv();
    const totalUsers = Number((await kv.get('gt:users:count')) || 0);
    const totalPosts = Number((await kv.get('gt:posts:count')) || 0);

    const roleKeys = ROLES.map((r) => `gt:role:count:${r}`);
    const roleVals = await kv.mget(...roleKeys);
    const roles = {};
    ROLES.forEach((r, i) => { roles[r] = Number(roleVals[i] || 0); });

    return json({ totalUsers, totalPosts, roles }, 200);
  } catch (err) {
    console.error('admin stats failed:', err && err.name);
    return json({ error: 'Could not load stats.' }, 500);
  }
}
