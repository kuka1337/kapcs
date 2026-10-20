/**
 * POST /api/goretok/admin/role — Edge
 * Assign/change a user's role (including founder). Protected by the EXISTING
 * admin-gate.js HMAC token (KAPCS_ADMIN_SECRET).
 */
export const config = { runtime: 'edge' };

import { json, secHeaders } from '../_lib/http.js';
import { verifyAdminToken, bearerFrom } from '../_lib/crypto.js';
import { validateHandle, validateRole, sortedPair } from '../_lib/validate.js';
import { getKv } from '../_lib/kv.js';

const BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com';

function isBlobUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try { return new URL(url).host.endsWith(BLOB_HOST_SUFFIX); } catch { return false; }
}

/**
 * Permanently delete a GoreTok account and everything it owns. Protected by the
 * SAME admin HMAC gate as role assignment (the already-verified `token` is
 * reused to authorize the server-side blob deletes). Every KV op mirrors the
 * exact ops used by register.js / posts.js / like.js / social.js and is
 * idempotent / safe when a key is already missing.
 *
 * Known limitation: comments this user left on OTHER users' posts are NOT
 * removed — there is no per-user comment index and a full-post scan is too
 * costly. The user's OWN posts' comment lists ARE deleted in the post cascade.
 */
async function deleteUser(req, kv, body, token) {
  const h = validateHandle(body.handle);
  if (!h.ok) return json({ error: h.error }, 400);
  const handle = h.value;

  const raw = await kv.get(`gt:user:${handle}`);
  const user = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!user) return json({ error: 'Account not found.' }, 404);

  const role = user.role || 'user';
  if (role === 'founder') {
    return json({ error: 'Cannot delete a founder account via this tool.' }, 403);
  }

  const blobUrls = [];
  let postsDeleted = 0;

  // 1) Posts: union of the user's post index + a safety scan of the global
  //    index for posts whose author === handle (covers any index drift).
  const ownIds = (await kv.lrange(`gt:user:${handle}:posts`, 0, -1)) || [];
  const allIds = (await kv.lrange('gt:posts:index', 0, -1)) || [];
  const idSet = new Set(ownIds);
  for (const id of allIds) {
    if (idSet.has(id)) continue;
    const praw = await kv.get(`gt:post:${id}`);
    const p = typeof praw === 'string' ? JSON.parse(praw) : praw;
    if (p && p.author === handle) idSet.add(id);
  }

  for (const id of idSet) {
    const praw = await kv.get(`gt:post:${id}`);
    const post = typeof praw === 'string' ? JSON.parse(praw) : praw;
    await kv.del(`gt:post:${id}`);
    await kv.lrem('gt:posts:index', 0, id);
    await kv.decr('gt:posts:count');
    if (post) {
      for (const tag of post.tags || []) {
        const left = Number((await kv.decr(`gt:tag:${tag}:count`)) || 0);
        if (left <= 0) await kv.srem('gt:tags', tag);
      }
      if (isBlobUrl(post.videoUrl)) blobUrls.push(post.videoUrl);
    }
    await kv.del(`gt:post:${id}:comments`);
    await kv.del(`gt:post:${id}:likers`);
    await kv.del(`gt:post:${id}:views`);
    postsDeleted++;
  }

  // 2) Avatar blob.
  if (isBlobUrl(user.avatarUrl)) blobUrls.push(user.avatarUrl);

  // 3) Likes the user gave: pull them out of each post's likers set and
  //    recompute that post's likeCount (mirrors like.js unlike).
  const likedIds = (await kv.smembers(`gt:user:${handle}:likes`)) || [];
  let likesCleared = 0;
  for (const pid of likedIds) {
    await kv.srem(`gt:post:${pid}:likers`, handle);
    const praw = await kv.get(`gt:post:${pid}`);
    const post = typeof praw === 'string' ? JSON.parse(praw) : praw;
    if (post) {
      post.likeCount = Number((await kv.scard(`gt:post:${pid}:likers`)) || 0);
      await kv.set(`gt:post:${pid}`, JSON.stringify(post));
    }
    likesCleared++;
  }
  await kv.del(`gt:user:${handle}:likes`);

  // 4) Social graph: detach both directions, then drop the user's own sets.
  const following = (await kv.smembers(`gt:user:${handle}:following`)) || [];
  for (const other of following) {
    await kv.srem(`gt:user:${other}:followers`, handle);
  }
  const followers = (await kv.smembers(`gt:user:${handle}:followers`)) || [];
  for (const other of followers) {
    await kv.srem(`gt:user:${other}:following`, handle);
  }
  await kv.del(`gt:user:${handle}:following`);
  await kv.del(`gt:user:${handle}:followers`);
  await kv.del(`gt:user:${handle}:posts`);

  // 5) DMs: bounded via the thread index (gt:user:<h>:threads). Delete each
  //    conversation key and remove the handle from the other side's index.
  const threads = (await kv.smembers(`gt:user:${handle}:threads`)) || [];
  for (const other of threads) {
    await kv.del(`gt:dm:${sortedPair(handle, other)}`);
    await kv.srem(`gt:user:${other}:threads`, handle);
  }
  await kv.del(`gt:user:${handle}:threads`);

  // 6) User record + counters.
  await kv.del(`gt:user:${handle}`);
  await kv.srem('gt:users:index', handle);
  await kv.decr('gt:users:count');
  await kv.decr(`gt:role:count:${role}`);

  // 7) Blobs: forward each collected Vercel-Blob URL to the Node blob route,
  //    authorized by the forwarded admin token. Best-effort (mirrors posts.js):
  //    a blob error never fails the account deletion (orphaned blobs tolerable).
  let blobsDeleted = 0;
  for (const url of blobUrls) {
    try {
      const resp = await fetch(new URL('/api/goretok/blob-upload-url', req.url).toString(), {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ url })
      });
      if (resp && resp.ok) blobsDeleted++;
    } catch {}
  }

  return json({
    deletedHandle: handle,
    postsDeleted,
    blobsDeleted,
    blobsAttempted: blobUrls.length,
    likesCleared,
    followersCleared: followers.length,
    followingCleared: following.length,
    dmThreadsCleared: threads.length,
    note: "Comments this user left on OTHER users' posts are not removed (no per-user comment index)."
  }, 200);
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: secHeaders });

  const token = bearerFrom(req);
  const valid = token ? await verifyAdminToken(token) : null;
  if (!valid) return json({ error: 'Forbidden.' }, 403);

  let body = {};
  try { body = await req.json(); } catch {}

  // Account deletion dispatches off an explicit action field; the default path
  // (no/other action) keeps the existing role-assignment behavior untouched.
  if (body && body.action === 'deleteUser') {
    try {
      const kv = await getKv();
      return await deleteUser(req, kv, body, token);
    } catch (err) {
      console.error('admin deleteUser failed:', err && err.name);
      return json({ error: 'Could not delete account.' }, 500);
    }
  }

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
