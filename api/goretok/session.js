/**
 * GET /api/goretok/session — Edge
 * Lightweight token verification (no KV hit). Used by the front end on load.
 */
export const config = { runtime: 'edge' };

import { json, secHeaders } from './_lib/http.js';
import { verifySessionToken, bearerFrom } from './_lib/crypto.js';

export default async function handler(req) {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: secHeaders });

  const token = bearerFrom(req);
  const verified = token ? await verifySessionToken(token) : null;
  if (!verified) return json({ valid: false }, 401);
  return json({ valid: true, handle: verified.handle }, 200);
}
