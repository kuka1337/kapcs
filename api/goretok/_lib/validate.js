/**
 * GoreTok — server-side input validation (never trust the client).
 * All validators return { ok: true, value } or { ok: false, error }.
 */

export const ROLES = ['founder', 'admin', 'moderator', 'verified', 'vip', 'user'];
export const CATEGORIES = ['Fiction', 'FX', 'Gaming', 'Horror'];

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const TAG_RE = /^[a-z0-9_]{1,24}$/;
const POSTID_RE = /^p_\d+_[a-z0-9]{6}$/;

export function normalizeHandle(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/^@/, '');
}

export function validateHandle(raw) {
  const value = normalizeHandle(raw);
  if (!HANDLE_RE.test(value)) {
    return { ok: false, error: 'Handle must be 3-20 chars: a-z, 0-9, underscore.' };
  }
  return { ok: true, value };
}

export function validatePassword(raw) {
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 200) {
    return { ok: false, error: 'Password must be 8-200 characters.' };
  }
  return { ok: true, value: raw };
}

export function validateTitle(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'Title is required.' };
  const value = raw.trim();
  if (value.length < 1 || value.length > 120) {
    return { ok: false, error: 'Title must be 1-120 characters.' };
  }
  return { ok: true, value };
}

export const MAX_TAGS = 10;
const MAX_TAG_LEN = 24;

// DEPRECATED: categories are no longer used for new posts (replaced by free-text
// hashtags). Kept exported for backward reference; createPost no longer calls it.
export function validateCategory(raw) {
  if (CATEGORIES.includes(raw)) return { ok: true, value: raw };
  return { ok: false, error: 'Category must be one of: ' + CATEGORIES.join(', ') + '.' };
}

/**
 * Normalize a single hashtag: lowercase, strip a leading '#', keep only
 * [a-z0-9_] (drop other chars rather than reject), and cap length.
 * Returns '' when nothing usable remains.
 */
function normalizeTag(raw) {
  if (typeof raw !== 'string') return '';
  let t = raw.trim().toLowerCase();
  if (t.startsWith('#')) t = t.slice(1);
  t = t.replace(/[^a-z0-9_]/g, '');
  if (t.length > MAX_TAG_LEN) t = t.slice(0, MAX_TAG_LEN);
  return t;
}

/**
 * Parse free-text or an array of tags into normalized, deduped hashtags.
 * Accepts a string ("#fx, zombie #fx prosthetic") or an array of strings.
 * Shared by the server and (optionally) the client so both agree on the rules.
 */
export function parseTags(raw) {
  let parts;
  if (raw == null) parts = [];
  else if (Array.isArray(raw)) parts = raw;
  else if (typeof raw === 'string') parts = raw.split(/[\s,]+/);
  else parts = [];

  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const tag = normalizeTag(p);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export function validateTags(raw) {
  if (raw != null && !Array.isArray(raw) && typeof raw !== 'string') {
    return { ok: false, error: 'Tags must be an array or string.' };
  }
  return { ok: true, value: parseTags(raw) };
}

const MAX_DURATION_SEC = 6 * 60 * 60; // 6 hours — a sane ceiling

/**
 * Validate a client-reported video duration (seconds).
 * null/undefined -> { ok:true, value:null }. Otherwise coerce to a finite,
 * non-negative integer clamped to MAX_DURATION_SEC. Never throws.
 */
export function validateDuration(raw) {
  if (raw == null) return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { ok: true, value: null };
  let v = Math.round(n);
  if (v > MAX_DURATION_SEC) v = MAX_DURATION_SEC;
  return { ok: true, value: v };
}

export function validateVideoUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    return { ok: false, error: 'Video URL is required (max 2048 chars).' };
  }
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: 'Video URL is not valid.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'Video URL must use http or https.' };
  }
  return { ok: true, value: raw };
}

export function validateRole(raw) {
  if (raw === 'none') return { ok: true, value: 'user' };
  if (ROLES.includes(raw)) return { ok: true, value: raw };
  return { ok: false, error: 'Invalid role.' };
}

export function validatePostId(raw) {
  if (typeof raw === 'string' && POSTID_RE.test(raw)) return { ok: true, value: raw };
  return { ok: false, error: 'Invalid post id.' };
}

export function makePostId(ts = Date.now()) {
  let rand = '';
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 6; i++) rand += chars[buf[i] % chars.length];
  return `p_${ts}_${rand}`;
}
