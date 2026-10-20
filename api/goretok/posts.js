/**
 * /api/goretok/posts — Edge
 *   GET  : list posts (public), newest first, paginated.
 *   POST : create a post (auth required) from a video URL.
 *
 * Runs on the Edge runtime (like every other goretok route) because the
 * handler returns a Web `Response` and uses `req.json()` / Web APIs. Under the
 * classic Node serverless runtime returning a `Response` does not terminate the
 * request, so the function would hang until it times out.
 */
export const config = { runtime: 'edge' };

import { json, secHeaders } from './_lib/http.js';
import { verifySessionToken, bearerFrom } from './_lib/crypto.js';
import {
  validateTitle, validateCategory, validateTags, validateVideoUrl, makePostId
} from './_lib/validate.js';
import { getKv } from './_lib/kv.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

async function listPosts(req) {
  const url = new URL(req.url, 'http://localhost');
  let limit = parseInt(url.searchParams.get('limit'), 10);
  let cursor = parseInt(url.searchParams.get('cursor'), 10);
  if (isNaN(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  if (isNaN(cursor) || cursor < 0) cursor = 0;

  const kv = await getKv();
  const total = Number((await kv.get('gt:posts:count')) || 0);
  const ids = (await kv.lrange('gt:posts:index', cursor, cursor + limit - 1)) || [];

  if (ids.length === 0) {
    return json({ posts: [], nextCursor: null, total }, 200);
  }

  const keys = ids.map((id) => `gt:post:${id}`);
  const raws = await kv.mget(...keys);
  const posts = [];
  for (const r of raws) {
    if (!r) continue;
    const post = typeof r === 'string' ? JSON.parse(r) : r;
    posts.push(post);
  }

  const nextCursor = cursor + ids.length < total ? cursor + ids.length : null;
  return json({ posts, nextCursor, total }, 200);
}

async function createPost(req) {
  const token = bearerFrom(req);
  const verified = token ? await verifySessionToken(token) : null;
  if (!verified) return json({ error: 'Unauthorized.' }, 401);

  let body = {};
  try { body = await req.json(); } catch {}

  const t = validateTitle(body.title);
  if (!t.ok) return json({ error: t.error }, 400);
  const c = validateCategory(body.category);
  if (!c.ok) return json({ error: c.error }, 400);
  const tags = validateTags(body.tags);
  if (!tags.ok) return json({ error: tags.error }, 400);
  const v = validateVideoUrl(body.videoUrl);
  if (!v.ok) return json({ error: v.error }, 400);

  const handle = verified.handle;
  const createdAt = Date.now();
  const id = makePostId(createdAt);
  const post = {
    id,
    author: handle,
    title: t.value,
    tags: tags.value,
    category: c.value,
    videoUrl: v.value,
    createdAt,
    likeCount: 0,
    commentCount: 0
  };

  try {
    const kv = await getKv();
    await kv.set(`gt:post:${id}`, JSON.stringify(post));
    await kv.lpush('gt:posts:index', id);
    await kv.incr('gt:posts:count');
    await kv.lpush(`gt:user:${handle}:posts`, id);
    return json({ post }, 201);
  } catch (err) {
    console.error('create post failed:', err && err.name);
    return json({ error: 'Could not create post.' }, 500);
  }
}

export default async function handler(req) {
  try {
    if (req.method === 'GET') return await listPosts(req);
    if (req.method === 'POST') return await createPost(req);
    return new Response('Method Not Allowed', { status: 405, headers: secHeaders });
  } catch (err) {
    console.error('posts route failed:', err && err.name);
    return json({ error: 'Could not load feed.' }, 500);
  }
}
