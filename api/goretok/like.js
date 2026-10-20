/**
 * POST /api/goretok/like — Edge
 * Persist a like/unlike server-side so counts are shared across visitors.
 * The likers Set is the source of truth; likeCount is kept in step via the
 * SADD/SREM return value (idempotent, never drifts upward).
 */
export const config = { runtime: 'edge' };

import { json, secHeaders } from './_lib/http.js';
import { verifySessionToken, bearerFrom } from './_lib/crypto.js';
import { validatePostId } from './_lib/validate.js';
import { getKv } from './_lib/kv.js';

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: secHeaders });

  const token = bearerFrom(req);
  const verified = token ? await verifySessionToken(token) : null;
  if (!verified) return json({ error: 'Unauthorized.' }, 401);

  let body = {};
  try { body = await req.json(); } catch {}

  const pid = validatePostId(body.postId);
  if (!pid.ok) return json({ error: pid.error }, 400);
  const postId = pid.value;
  const like = body.like !== false; // default to like
  const handle = verified.handle;

  try {
    const kv = await getKv();
    const raw = await kv.get(`gt:post:${postId}`);
    const post = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!post) return json({ error: 'Post not found.' }, 404);

    const likersKey = `gt:post:${postId}:likers`;
    const userLikesKey = `gt:user:${handle}:likes`;

    if (like) {
      const added = await kv.sadd(likersKey, handle);
      if (added) {
        await kv.sadd(userLikesKey, postId);
      }
    } else {
      const removed = await kv.srem(likersKey, handle);
      if (removed) {
        await kv.srem(userLikesKey, postId);
      }
    }

    // Derive likeCount from the set (authoritative), persist on the post record.
    const likeCount = Number((await kv.scard(likersKey)) || 0);
    post.likeCount = likeCount;
    await kv.set(`gt:post:${postId}`, JSON.stringify(post));

    // Keep the user's denormalized likes count in step with their likes set.
    const userLikes = Number((await kv.scard(userLikesKey)) || 0);
    const uraw = await kv.get(`gt:user:${handle}`);
    const user = typeof uraw === 'string' ? JSON.parse(uraw) : uraw;
    if (user) {
      user.likes = userLikes;
      await kv.set(`gt:user:${handle}`, JSON.stringify(user));
    }

    return json({ liked: like, likeCount }, 200);
  } catch (err) {
    console.error('like failed:', err && err.name);
    return json({ error: 'Could not update like.' }, 500);
  }
}
