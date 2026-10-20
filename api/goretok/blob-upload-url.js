/**
 * /api/goretok/blob-upload-url — Node (server upload via @vercel/blob `put`)
 *   POST (raw video bytes in the body)
 *   headers: Authorization: Bearer <session token>, Content-Type: video/*,
 *            X-Filename: <original name>
 *   -> { url }
 *
 * Server upload is the simplest reliable path: the browser POSTs the file to
 * this route, we verify the session, then `put()` streams it to Vercel Blob and
 * returns the public URL. Note Vercel's ~4.5 MB request-body cap for server
 * uploads — larger clips should use the video-URL field instead (the UI says
 * so). This avoids @vercel/blob/client, which does not run on the Edge runtime.
 *
 * BLOB_READ_WRITE_TOKEN is read from the environment by the SDK — never
 * hardcoded or logged.
 */
export const config = { runtime: 'nodejs' };

import { put, del } from '@vercel/blob';
import { verifySessionToken, verifyAdminToken } from './_lib/crypto.js';

const ALLOWED_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/ogg',
  'video/x-matroska'
];
const ALLOWED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
];
const MAX_SIZE_BYTES = 4.4 * 1024 * 1024; // keep under Vercel's ~4.5 MB server-upload cap
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // ~2 MB cap for avatar/images

const SEC = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Referrer-Policy': 'no-referrer',
  'Content-Type': 'application/json; charset=utf-8'
};

function reply(res, status, obj) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

function bearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) { reject(new Error('TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeName(raw, fallbackExt = 'mp4') {
  let base = typeof raw === 'string' ? raw.split(/[\\/]/).pop() : '';
  base = (base || 'clip').replace(/[^a-zA-Z0-9._-]/g, '').slice(-80) || 'clip';
  if (!/\.[a-z0-9]+$/i.test(base)) base += '.' + fallbackExt;
  return base;
}

function readJsonBody(req, maxBytes) {
  return readBody(req, maxBytes).then((buf) => {
    if (!buf || buf.length === 0) return {};
    try { return JSON.parse(buf.toString('utf8')); } catch { return {}; }
  });
}

async function handleDelete(req, res, verified) {
  let url = null;
  try {
    const u = new URL(req.url, 'http://localhost');
    url = u.searchParams.get('url');
  } catch {}
  if (!url) {
    const body = await readJsonBody(req, 8 * 1024).catch(() => ({}));
    url = body && body.url;
  }
  if (typeof url !== 'string' || !url) return reply(res, 400, { error: 'Blob url is required.' });

  let host;
  try { host = new URL(url).host; } catch { return reply(res, 400, { error: 'Invalid blob url.' }); }
  if (!host.endsWith('.public.blob.vercel-storage.com')) {
    return reply(res, 400, { error: 'Not a Vercel Blob url.' });
  }

  await del(url, { token: process.env.BLOB_READ_WRITE_TOKEN });
  return reply(res, 200, { ok: true });
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      return reply(res, 405, { error: 'Method Not Allowed' });
    }

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return reply(res, 503, { error: 'File upload is not configured yet (no Blob store linked). Use a video URL for now.' });
    }

    const tok = bearer(req);

    // DELETE may be authorized by either a valid GoreTok session token (a user
    // deleting their own post's blob, via posts.js) OR a valid KAPCS admin HMAC
    // token (admin account deletion, forwarded from admin/role.js). Uploads
    // (POST) remain session-only — admin auth never grants upload.
    if (req.method === 'DELETE') {
      const adminOk = await verifyAdminToken(tok);
      const verified = adminOk || await verifySessionToken(tok);
      if (!verified) return reply(res, 401, { error: 'Unauthorized.' });
      return await handleDelete(req, res, verified);
    }

    const verified = await verifySessionToken(tok);
    if (!verified) return reply(res, 401, { error: 'Unauthorized.' });

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
    const isVideo = ALLOWED_CONTENT_TYPES.includes(contentType);
    const isImage = ALLOWED_IMAGE_TYPES.includes(contentType);
    if (!isVideo && !isImage) {
      return reply(res, 400, { error: 'Only video (mp4, webm, mov, ogg, mkv) or image (png, jpeg, webp, gif) files are allowed.' });
    }

    const cap = isImage ? MAX_IMAGE_BYTES : MAX_SIZE_BYTES;
    let buf;
    try {
      buf = await readBody(req, cap);
    } catch (e) {
      if (e && e.message === 'TOO_LARGE') {
        return reply(res, 413, isImage
          ? { error: 'Image too large (max ~2 MB).' }
          : { error: 'File too large for direct upload (max ~4.4 MB). Use a video URL for bigger clips.' });
      }
      throw e;
    }
    if (!buf || buf.length === 0) return reply(res, 400, { error: 'Empty file.' });

    let pathname;
    if (isImage) {
      const ext = contentType.split('/')[1] || 'png';
      const name = safeName(req.headers['x-filename'], ext === 'jpeg' ? 'jpg' : ext);
      pathname = `goretok/${verified.handle}/img/${Date.now()}-${name}`;
    } else {
      const name = safeName(req.headers['x-filename']);
      pathname = `goretok/${verified.handle}/${Date.now()}-${name}`;
    }

    const blob = await put(pathname, buf, {
      access: 'public',
      contentType,
      addRandomSuffix: true,
      token: process.env.BLOB_READ_WRITE_TOKEN
    });

    return reply(res, 200, { url: blob.url });
  } catch (err) {
    return reply(res, 400, { error: (err && err.message) || 'Upload failed.' });
  }
}
