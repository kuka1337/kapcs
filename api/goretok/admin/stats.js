/**
 * GET /api/goretok/admin/stats — Edge
 * Total users + posts + per-role breakdown. Protected by the EXISTING
 * admin-gate.js HMAC token (KAPCS_ADMIN_SECRET). Counts only, no PII.
 * Optional ?users=1 returns the full user list (handle, role, createdAt, likes, avatarUrl).
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
    const url = new URL(req.url, 'http://localhost');
    const wantUsers = url.searchParams.get('users') === '1';

    const totalUsers = Number((await kv.get('gt:users:count')) || 0);
    const totalPosts = Number((await kv.get('gt:posts:count')) || 0);

    const roleKeys = ROLES.map((r) => `gt:role:count:${r}`);
    const roleVals = await kv.mget(...roleKeys);
    const roles = {};
    ROLES.forEach((r, i) => { roles[r] = Number(roleVals[i] || 0); });

    if (!wantUsers) return json({ totalUsers, totalPosts, roles }, 200);

    // Return full user list (handle, role, createdAt, likes, avatarUrl).
    // Uses gt:users:index (a list of handles, newest first) if it exists,
    // otherwise falls back to scanning gt:user:* keys via a KV scan.
    let handles = [];
    try {
      // gt:users:index is a set (sadd on register).
      const indexed = await kv.smembers('gt:users:index');
      if (indexed && indexed.length > 0) handles = indexed;
    } catch (_) {}

    if (handles.length === 0) return json({ totalUsers, totalPosts, roles, users: [] }, 200);

    // Fetch user records in batches (mget supports up to 1000 keys).
    const userKeys = handles.map((h) => `gt:user:${h}`);
    const raws = await kv.mget(...userKeys);
    const users = [];
    for (const r of raws) {
      if (!r) continue;
      const u = typeof r === 'string' ? JSON.parse(r) : r;
      users.push({
        handle: u.handle,
        role: u.role || 'user',
        createdAt: u.createdAt || null,
        likes: u.likes || 0,
        avatarUrl: u.avatarUrl || null,
      });
    }

    return json({ totalUsers, totalPosts, roles, users }, 200);
  } catch (err) {
    console.error('admin stats failed:', err && err.name);
    return json({ error: 'Could not load stats.' }, 500);
  }
}
