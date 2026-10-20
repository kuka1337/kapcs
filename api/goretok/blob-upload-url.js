/**
 * /api/goretok/blob-upload-url — Edge
 *   POST { pathname, contentType, token } -> { clientToken }
 *
 * Mints a short-lived, scoped Vercel Blob client token so the browser can
 * stream a file straight to Blob (client upload: files may exceed the 4.5 MB
 * server-upload cap). This uses generateClientTokenFromReadWriteToken directly
 * — a plain JSON request/response — instead of handleUpload(), which reads the
 * raw request stream and would hang on anything but an exact upload() exchange.
 *
 * AUTH: the GoreTok session token is in the JSON body and re-verified here with
 * the same HMAC scheme every other write route uses. The issued token is
 * restricted to video/* content types and a 100 MB max, enforced server-side.
 *
 * BLOB_READ_WRITE_TOKEN is read from the environment — never hardcoded/logged.
 */
export const config = { runtime: 'edge' };

import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { json, secHeaders } from './_lib/http.js';
import { verifySessionToken } from './_lib/crypto.js';

const ALLOWED_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/ogg',
  'video/x-matroska'
];
const MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const TOKEN_VALID_MS = 60 * 60 * 1000;     // client has 1 hour to finish

function safePathname(raw, handle) {
  // Keep a safe, namespaced path; the SDK validates the final name too.
  let base = typeof raw === 'string' ? raw.split('/').pop() : '';
  base = (base || 'clip').replace(/[^a-zA-Z0-9._-]/g, '').slice(-80) || 'clip';
  if (!/\.[a-z0-9]+$/i.test(base)) base += '.mp4';
  return `goretok/${handle}/${Date.now()}-${base}`;
}

async function handlePost(req) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return json({ error: 'File upload is not configured yet (no Blob store linked). Use a video URL for now.' }, 503);
  }

  let body = {};
  try { body = await req.json(); } catch {}

  const verified = body.token ? await verifySessionToken(body.token) : null;
  if (!verified) return json({ error: 'Unauthorized.' }, 401);

  const contentType = typeof body.contentType === 'string' ? body.contentType : '';
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    return json({ error: 'Only video files are allowed (mp4, webm, mov, ogg, mkv).' }, 400);
  }

  const pathname = safePathname(body.pathname, verified.handle);

  const clientToken = await generateClientTokenFromReadWriteToken({
    token: process.env.BLOB_READ_WRITE_TOKEN,
    pathname,
    allowedContentTypes: ALLOWED_CONTENT_TYPES,
    maximumSizeInBytes: MAX_SIZE_BYTES,
    addRandomSuffix: true,
    validUntil: Date.now() + TOKEN_VALID_MS,
    tokenPayload: JSON.stringify({ handle: verified.handle })
  });

  return json({ clientToken, pathname }, 200);
}

export default async function handler(req) {
  try {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: secHeaders });
    }
    return await handlePost(req);
  } catch (err) {
    return json({ error: (err && err.message) || 'Upload token request failed.' }, 400);
  }
}
