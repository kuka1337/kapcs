/**
 * GET /api/goretok/me — Edge
 * Return the current user (handle, role, likes, createdAt) plus the ids of
 * their own posts and liked posts. Warn/ban status stays MQTT-owned.
 */
export const config = { runtime: 'edge' };

import { json, secHeaders } from './_lib/http.js';
import { verifySessionToken, bearerFrom } from './_lib/crypto.js';
import { getKv } from './_lib/kv.js';

export default async function handler(req) {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: secHeaders });

  const token = bearerFrom(req);
  const verified = token ? await verifySessionToken(token) : null;
  if (!verified) return json({ error: 'Unauthorized.' }, 401);

  const handle = verified.handle;

  try {
    const kv = await getKv();
    const raw = await kv.get(`gt:user:${handle}`);
    const user = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!user) return json({ error: 'Account not found.' }, 404);

    const posts = (await kv.lrange(`gt:user:${handle}:posts`, 0, -1)) || [];
    const likedPosts = (await kv.smembers(`gt:user:${handle}:likes`)) || [];
    const followers = Number((await kv.scard(`gt:user:${handle}:followers`)) || 0);
    const following = Number((await kv.scard(`gt:user:${handle}:following`)) || 0);

    return json({
      handle: user.handle,
      role: user.role || 'user',
      likes: user.likes || 0,
      createdAt: user.createdAt || null,
      avatarUrl: user.avatarUrl || null,
      followers,
      following,
      posts,
      likedPosts
    }, 200);
  } catch (err) {
    console.error('me failed:', err && err.name);
    return json({ error: 'Could not load profile.' }, 500);
  }
}
