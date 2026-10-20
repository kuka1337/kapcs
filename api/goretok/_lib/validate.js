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

export function validateCategory(raw) {
  if (CATEGORIES.includes(raw)) return { ok: true, value: raw };
  return { ok: false, error: 'Category must be one of: ' + CATEGORIES.join(', ') + '.' };
}

export function validateTags(raw) {
  if (raw == null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'Tags must be an array.' };
  const out = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const tag = t.trim().toLowerCase().replace(/^#/, '');
    if (TAG_RE.test(tag)) out.push(tag);
    if (out.length >= 8) break;
  }
  return { ok: true, value: out };
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
