/**
 * /api/goretok/tags — Edge
 *   GET : list known hashtags with usage counts (public), sorted by count desc
 *         (tie-break alphabetical). Optional ?tag=<name> returns a single
 *         { tag, count } (count 0 if unknown).
 *
 * There are no seeded/default tags — a fresh store returns [].
 * Runs on the Edge runtime like every other goretok route (returns a Web
 * `Response`).
 */
export const config = { runtime: 'edge' };

import { json, secHeaders } from './_lib/http.js';
import { getKv } from './_lib/kv.js';

function toCount(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function listTags(req) {
  const url = new URL(req.url, 'http://localhost');
  const single = url.searchParams.get('tag');
  const kv = await getKv();

  if (single != null) {
    const tag = String(single).trim().toLowerCase().replace(/^#/, '');
    const count = toCount(await kv.get(`gt:tag:${tag}:count`));
    return json({ tag, count }, 200);
  }

  const members = (await kv.smembers('gt:tags')) || [];
  if (members.length === 0) return json([], 200);

  const keys = members.map((t) => `gt:tag:${t}:count`);
  const counts = await kv.mget(...keys);
  const out = [];
  for (let i = 0; i < members.length; i++) {
    const count = toCount(counts[i]);
    if (count > 0) out.push({ tag: members[i], count });
  }
  out.sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));
  return json(out, 200);
}

export default async function handler(req) {
  try {
    if (req.method === 'GET') return await listTags(req);
    return new Response('Method Not Allowed', { status: 405, headers: secHeaders });
  } catch (err) {
    console.error('tags route failed:', err && err.name);
    return json({ error: 'Could not load tags.' }, 500);
  }
}
