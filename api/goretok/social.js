/**
 * POST /api/goretok/social — Edge
 *
 * A single action-switch route that consolidates the social + interaction
 * surface (profile avatar, follow/unfollow, comments, DMs, view counts) into
 * one Vercel function so GoreTok stays within the 12-function cap.
 *
 * Every mutating action is session-gated (Bearer token -> verifySessionToken).
 * All input is validated server-side. DMs are scoped to the sorted participant
 * pair key so a user can never read a conversation they are not part of.
 *
 * Returns a Web Response (Edge runtime) like every other goretok route.
 */
export const config = { runtime: 'edge' };

import { json, secHeaders } from './_lib/http.js';
import { verifySessionToken, bearerFrom } from './_lib/crypto.js';
import {
  validatePostId, validateCommentText, validateDmText, validateAvatarUrl,
  normalizeHandle, sortedPair
} from './_lib/validate.js';
import { getKv } from './_lib/kv.js';

const DM_MAX = 200;
const COMMENTS_DEFAULT_LIMIT = 30;
const COMMENTS_MAX_LIMIT = 100;

async function sessionHandle(req) {
  const token = bearerFrom(req);
  if (!token) return null;
  const verified = await verifySessionToken(token);
  return verified ? verified.handle : null;
}

async function loadUser(kv, handle) {
  const raw = await kv.get(`gt:user:${handle}`);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function rand6() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[buf[i] % chars.length];
  return out;
}

// ── actions ────────────────────────────────────────────────────────────────

async function actProfile(kv, caller, body) {
  const a = validateAvatarUrl(body.avatarUrl);
  if (!a.ok) return json({ error: a.error }, 400);
  const user = await loadUser(kv, caller);
  if (!user) return json({ error: 'Account not found.' }, 404);
  user.avatarUrl = a.value;
  await kv.set(`gt:user:${caller}`, JSON.stringify(user));
  return json({ ok: true, avatarUrl: a.value }, 200);
}

async function actProfileGet(kv, caller, body) {
  const target = normalizeHandle(body.handle);
  if (!target) return json({ error: 'Invalid handle.' }, 400);
  const user = await loadUser(kv, target);
  if (!user) return json({ error: 'Account not found.' }, 404);
  const followers = Number((await kv.scard(`gt:user:${target}:followers`)) || 0);
  const following = Number((await kv.scard(`gt:user:${target}:following`)) || 0);
  let isFollowing = false;
  if (caller) {
    isFollowing = !!(await kv.sismember(`gt:user:${target}:followers`, caller));
  }
  return json({
    handle: user.handle,
    role: user.role || 'user',
    avatarUrl: user.avatarUrl || null,
    followers,
    following,
    isFollowing
  }, 200);
}

async function actFollow(kv, caller, body) {
  const target = normalizeHandle(body.target);
  if (!target) return json({ error: 'Invalid handle.' }, 400);
  if (target === caller) return json({ error: 'You cannot follow yourself.' }, 400);
  const targetUser = await loadUser(kv, target);
  if (!targetUser) return json({ error: 'Account not found.' }, 404);

  const follow = body.follow !== false;
  if (follow) {
    await kv.sadd(`gt:user:${target}:followers`, caller);
    await kv.sadd(`gt:user:${caller}:following`, target);
  } else {
    await kv.srem(`gt:user:${target}:followers`, caller);
    await kv.srem(`gt:user:${caller}:following`, target);
  }
  const followers = Number((await kv.scard(`gt:user:${target}:followers`)) || 0);
  return json({ ok: true, following: follow, followers }, 200);
}

async function actCommentAdd(kv, caller, body) {
  const pid = validatePostId(body.postId);
  if (!pid.ok) return json({ error: pid.error }, 400);
  const ct = validateCommentText(body.text);
  if (!ct.ok) return json({ error: ct.error }, 400);

  const praw = await kv.get(`gt:post:${pid.value}`);
  const post = typeof praw === 'string' ? JSON.parse(praw) : praw;
  if (!post) return json({ error: 'Post not found.' }, 404);

  const user = await loadUser(kv, caller);
  const comment = {
    id: `c_${Date.now()}_${rand6()}`,
    author: caller,
    avatarUrl: (user && user.avatarUrl) || null,
    text: ct.value,
    createdAt: Date.now()
  };
  await kv.lpush(`gt:post:${pid.value}:comments`, JSON.stringify(comment));
  post.commentCount = Number(post.commentCount || 0) + 1;
  await kv.set(`gt:post:${pid.value}`, JSON.stringify(post));
  return json({ comment }, 200);
}

async function actCommentList(kv, body) {
  const pid = validatePostId(body.postId);
  if (!pid.ok) return json({ error: pid.error }, 400);
  let limit = parseInt(body.limit, 10);
  if (isNaN(limit) || limit < 1) limit = COMMENTS_DEFAULT_LIMIT;
  if (limit > COMMENTS_MAX_LIMIT) limit = COMMENTS_MAX_LIMIT;
  let cursor = parseInt(body.cursor, 10);
  if (isNaN(cursor) || cursor < 0) cursor = 0;

  const raws = (await kv.lrange(`gt:post:${pid.value}:comments`, cursor, cursor + limit - 1)) || [];
  const comments = [];
  for (const r of raws) {
    const c = typeof r === 'string' ? JSON.parse(r) : r;
    if (c) comments.push(c);
  }
  const nextCursor = comments.length === limit ? cursor + comments.length : null;
  return json({ comments, nextCursor }, 200);
}

async function actDmSend(kv, caller, body) {
  const to = normalizeHandle(body.to);
  if (!to) return json({ error: 'Invalid handle.' }, 400);
  if (to === caller) return json({ error: 'You cannot message yourself.' }, 400);
  const dt = validateDmText(body.text);
  if (!dt.ok) return json({ error: dt.error }, 400);

  const toUser = await loadUser(kv, to);
  if (!toUser) return json({ error: 'Account not found.' }, 404);

  const key = `gt:dm:${sortedPair(caller, to)}`;
  const msg = { from: caller, to, text: dt.value, ts: Date.now() };
  await kv.lpush(key, JSON.stringify(msg));
  await kv.ltrim(key, 0, DM_MAX - 1);
  await kv.sadd(`gt:user:${caller}:threads`, to);
  await kv.sadd(`gt:user:${to}:threads`, caller);
  return json({ message: msg }, 200);
}

async function actDmList(kv, caller, body) {
  if (body.threads === true) {
    const threads = (await kv.smembers(`gt:user:${caller}:threads`)) || [];
    return json({ threads }, 200);
  }
  const other = normalizeHandle(body.with);
  if (!other) return json({ error: 'Invalid handle.' }, 400);
  // Key derived ONLY from the caller + target pair, so a user can never read a
  // conversation they are not a participant of.
  const key = `gt:dm:${sortedPair(caller, other)}`;
  const raws = (await kv.lrange(key, 0, DM_MAX - 1)) || [];
  const messages = [];
  for (const r of raws) {
    const m = typeof r === 'string' ? JSON.parse(r) : r;
    if (m) messages.push(m);
  }
  return json({ messages }, 200);
}

async function actView(kv, body) {
  const pid = validatePostId(body.postId);
  if (!pid.ok) return json({ error: pid.error }, 400);
  const views = Number((await kv.incr(`gt:post:${pid.value}:views`)) || 0);
  const praw = await kv.get(`gt:post:${pid.value}`);
  const post = typeof praw === 'string' ? JSON.parse(praw) : praw;
  if (post) {
    post.viewCount = views;
    await kv.set(`gt:post:${pid.value}`, JSON.stringify(post));
  }
  return json({ views }, 200);
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: secHeaders });

  let body = {};
  try { body = await req.json(); } catch {}
  const action = body && typeof body.action === 'string' ? body.action : '';

  try {
    const kv = await getKv();
    const caller = await sessionHandle(req);

    switch (action) {
      // public reads
      case 'profile.get':
        return await actProfileGet(kv, caller, body);
      case 'comment.list':
        return await actCommentList(kv, body);

      // view: session optional
      case 'view':
        return await actView(kv, body);

      // session-gated below
      case 'profile':
        if (!caller) return json({ error: 'Unauthorized.' }, 401);
        return await actProfile(kv, caller, body);
      case 'follow':
        if (!caller) return json({ error: 'Unauthorized.' }, 401);
        return await actFollow(kv, caller, body);
      case 'comment.add':
        if (!caller) return json({ error: 'Unauthorized.' }, 401);
        return await actCommentAdd(kv, caller, body);
      case 'dm.send':
        if (!caller) return json({ error: 'Unauthorized.' }, 401);
        return await actDmSend(kv, caller, body);
      case 'dm.list':
        if (!caller) return json({ error: 'Unauthorized.' }, 401);
        return await actDmList(kv, caller, body);

      default:
        return json({ error: 'Unknown action.' }, 400);
    }
  } catch (err) {
    console.error('social route failed:', err && err.name);
    return json({ error: 'Request failed.' }, 500);
  }
}
