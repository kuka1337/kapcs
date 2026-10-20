/**
 * /api/goretok/blob-upload-url — Edge
 *   POST : issue a short-lived Vercel Blob client-upload token.
 *
 * Client-upload flow (files can exceed the 4.5 MB server-upload cap): the
 * browser calls `upload()` from '@vercel/blob/client', which POSTs here to mint
 * a token, then streams the file straight to Vercel Blob.
 *
 * AUTH: the GoreTok session token is passed in `clientPayload` (the browser
 * can't set an Authorization header on the upload exchange) and re-verified
 * here with the same HMAC scheme every other write route uses. The token is
 * restricted to video/* content types and a 100 MB max, enforced server-side.
 *
 * BLOB_READ_WRITE_TOKEN is read from the environment by the SDK — never
 * hardcoded or logged.
 */
// Node runtime: @vercel/blob's handleUpload pulls in Node built-ins (undici,
// node:stream, ...) that the Edge runtime rejects. Keeping only this one route
// on Node (the modern Node runtime still accepts a Web `Request`->`Response`
// handler) avoids "referencing unsupported modules" build failures, while every
// other goretok route stays on Edge.
export const config = { runtime: 'nodejs' };

import { handleUpload } from '@vercel/blob/client';
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

async function createUploadToken(req) {
  // Fail fast if the Blob store isn't linked yet, instead of hanging on an
  // internal call until the request times out.
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return json({ error: 'File upload is not configured yet (no Blob store linked). Use a video URL for now.' }, 503);
  }

  let body = {};
  try { body = await req.json(); } catch {}

  const result = await handleUpload({
    request: req,
    body,
    onBeforeGenerateToken: async (pathname, clientPayload) => {
      let token = null;
      if (clientPayload) {
        try { token = JSON.parse(clientPayload).token; } catch { token = null; }
      }
      const verified = token ? await verifySessionToken(token) : null;
      if (!verified) throw new Error('Unauthorized');
      return {
        allowedContentTypes: ALLOWED_CONTENT_TYPES,
        maximumSizeInBytes: MAX_SIZE_BYTES,
        tokenPayload: JSON.stringify({ handle: verified.handle })
      };
    },
    // Does not fire on localhost; the browser uses the URL `upload()` resolves
    // with. Never log secrets here.
    onUploadCompleted: async () => {}
  });

  return json(result, 200);
}

export default async function handler(req) {
  try {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: secHeaders });
    }
    return await createUploadToken(req);
  } catch (err) {
    const msg = err && err.message ? err.message : 'Upload token request failed.';
    const status = /unauthorized/i.test(msg) ? 401 : 400;
    return json({ error: msg }, status);
  }
}
