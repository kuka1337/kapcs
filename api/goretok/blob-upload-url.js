/**
 * /api/goretok/blob-upload-url — Edge
 *   POST : issue a short-lived Vercel Blob client-upload token.
 *
 * Client-upload flow (files can exceed the 4.5 MB server-upload cap): the
 * browser calls `upload()` from '@vercel/blob/client', which POSTs here; this
 * route mints a scoped token, then the browser streams the file straight to
 * Vercel Blob.
 *
 * AUTH: the GoreTok session token is passed in `clientPayload` (the browser
 * can't set an Authorization header on the upload exchange) and re-verified
 * here with the same HMAC scheme every other write route uses. The token is
 * restricted to video/* content types and a 100 MB max, enforced server-side.
 *
 * BLOB_READ_WRITE_TOKEN is read from the environment by the SDK — never
 * hardcoded or logged.
 *
 * Runs on the Edge runtime like every other goretok route. The request body is
 * NOT read before handleUpload (handleUpload consumes it itself); reading it
 * first would leave handleUpload waiting on an already-drained stream.
 */
export const config = { runtime: 'edge' };

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
  // Fail fast if the Blob store isn't linked yet, instead of letting the SDK
  // hang on an internal call until the request times out.
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return json({ error: 'File upload is not configured yet (no Blob store linked). Use a video URL for now.' }, 503);
  }

  // handleUpload reads the JSON body from `request` itself — do not pre-read it.
  const result = await handleUpload({
    request: req,
    token: process.env.BLOB_READ_WRITE_TOKEN,
    onBeforeGenerateToken: async (_pathname, clientPayload) => {
      let sessionToken = null;
      if (clientPayload) {
        try { sessionToken = JSON.parse(clientPayload).token; } catch { sessionToken = null; }
      }
      const verified = sessionToken ? await verifySessionToken(sessionToken) : null;
      if (!verified) throw new Error('Unauthorized');
      return {
        allowedContentTypes: ALLOWED_CONTENT_TYPES,
        maximumSizeInBytes: MAX_SIZE_BYTES,
        tokenPayload: JSON.stringify({ handle: verified.handle })
      };
    },
    // Fires server-to-server after the client finishes; no-op here. The browser
    // already has the blob URL from upload(). Never log secrets.
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
