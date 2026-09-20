/**
 * KAPCS Admin Gate — Vercel Edge Function
 *
 * Védi az admin.html-t: csak érvényes HMAC session token-nel érhető el.
 * Az admin.html tartalma server-side-on kerül visszaadásra — a böngészőből
 * /admin.html közvetlen URL-en nem elérhető.
 *
 * Env változók (Vercel Dashboard → Settings → Environment Variables):
 *   KAPCS_ADMIN_PASSWORD  — plain text jelszó (pl. "admin2026")
 *   KAPCS_ADMIN_SECRET    — HMAC titkos kulcs (min. 32 karakter random string)
 *
 * Runtime: Vercel Edge (Web Crypto API, no Node.js built-ins)
 */

export const config = { runtime: 'edge' };

const TOKEN_TTL  = 2 * 60 * 60 * 1000; // 2 óra
const MAX_TRIES  = 5;
const LOCKOUT_MS = 15 * 60 * 1000;      // 15 perc

// In-memory rate limit (Edge instance-onként, újrainduláskor törlődik)
const attempts = new Map(); // ip -> { count, lockedUntil }

// ── Web Crypto: HMAC-SHA256 ──────────────────────────────────────────────────

async function getKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

async function signToken(ts, secret) {
  const key = await getKey(secret);
  const enc = new TextEncoder();
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(ts)));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''); // URL-safe base64
}

async function verifyToken(token, secret) {
  if (!token || !token.includes('.')) return null;
  const dot = token.lastIndexOf('.');
  const tsStr = token.slice(0, dot);
  const sig   = token.slice(dot + 1);
  const ts    = parseInt(tsStr, 10);
  if (isNaN(ts) || Date.now() - ts > TOKEN_TTL) return null;
  const expected = await signToken(ts, secret);
  // Constant-time compare
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? ts : null;
}

async function makeToken(secret) {
  const ts = Date.now();
  const sig = await signToken(ts, secret);
  return `${ts}.${sig}`;
}

// ── Rate limiting ────────────────────────────────────────────────────────────

function checkRateLimit(ip) {
  const now   = Date.now();
  const state = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  if (state.lockedUntil > now) {
    return { blocked: true, remaining: Math.ceil((state.lockedUntil - now) / 60000) };
  }
  return { blocked: false };
}

function recordFail(ip) {
  const state = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  state.count++;
  if (state.count >= MAX_TRIES) {
    state.lockedUntil = Date.now() + LOCKOUT_MS;
    state.count = 0;
  }
  attempts.set(ip, state);
  return state;
}

// ── Login oldal HTML ─────────────────────────────────────────────────────────

function loginPage(errorMsg = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>KAPCS — Admin Login</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#090d16;color:#f8fafc;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:20px}
    .box{background:#111726;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:40px;max-width:380px;width:100%;text-align:center}
    h2{font-size:22px;margin-bottom:8px}p{font-size:12px;color:#94a3b8;margin-bottom:22px;line-height:1.5}
    input{width:100%;padding:12px;margin-bottom:10px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.08);border-radius:6px;color:#fff;text-align:center;font-size:14px;outline:none}
    input:focus{border-color:#6366f1}
    button{width:100%;padding:12px;background:#6366f1;border:0;color:#fff;border-radius:6px;font-weight:700;cursor:pointer;font-size:14px;transition:opacity .15s}
    button:disabled{opacity:.5;cursor:not-allowed}
    #err{color:#ef4444;font-size:12px;margin-top:10px;min-height:18px;font-weight:600}
  </style>
</head>
<body>
  <div class="box">
    <div style="font-size:40px;margin-bottom:16px">🔐</div>
    <h2>Admin Console</h2>
    <p>KAPCS Moderation Panel<br>Authorized access only.</p>
    <input type="password" id="pwd" placeholder="Admin password" autocomplete="current-password">
    <button id="btn">Unlock Console</button>
    <div id="err">${errorMsg}</div>
  </div>
  <script>
    const btn=document.getElementById('btn'),pwd=document.getElementById('pwd'),err=document.getElementById('err');
    pwd.addEventListener('keydown',e=>{if(e.key==='Enter')btn.click()});
    btn.addEventListener('click',async()=>{
      btn.disabled=true;btn.textContent='Verifying...';err.textContent='';
      try{
        const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd.value})});
        const d=await r.json();
        if(d.token){
          sessionStorage.setItem('kapcs_gate_token',d.token);
          location.href=location.pathname+'?t='+encodeURIComponent(d.token);
        }else{err.textContent=d.error||'Invalid password.';}
      }catch(e){err.textContent='Network error.';}
      btn.disabled=false;btn.textContent='Unlock Console';
    });
    const saved=sessionStorage.getItem('kapcs_gate_token');
    if(saved)location.href=location.pathname+'?t='+encodeURIComponent(saved);
  </script>
</body>
</html>`;
}

// ── Fő handler ───────────────────────────────────────────────────────────────

export default async function handler(req) {
  const url      = new URL(req.url);
  const method   = req.method.toUpperCase();
  const ip       = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const PASSWORD = process.env.KAPCS_ADMIN_PASSWORD || 'admin2026';
  const SECRET   = process.env.KAPCS_ADMIN_SECRET   || 'kapcs-default-secret-change-me-32ch';

  const secHeaders = {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Referrer-Policy': 'no-referrer'
  };

  // ── POST: jelszó → token ──
  if (method === 'POST') {
    const rl = checkRateLimit(ip);
    if (rl.blocked) {
      return Response.json(
        { error: `Too many attempts. Locked for ${rl.remaining} more minute(s).` },
        { status: 429, headers: secHeaders }
      );
    }

    let body = {};
    try { body = await req.json(); } catch {}

    if (body.password === PASSWORD) {
      attempts.delete(ip);
      const token = await makeToken(SECRET);
      return Response.json({ token }, { status: 200, headers: secHeaders });
    }

    const state = recordFail(ip);
    const left  = state.lockedUntil > Date.now() ? 0 : MAX_TRIES - state.count;
    return Response.json(
      { error: state.lockedUntil > Date.now() ? 'Locked for 15 minutes.' : `Invalid password. ${left} attempt(s) left.` },
      { status: 401, headers: secHeaders }
    );
  }

  // ── GET: token validálás → admin.html visszaadás ──
  if (method === 'GET') {
    const token = url.searchParams.get('t');
    const valid = token ? await verifyToken(token, SECRET) : null;

    if (!valid) {
      return new Response(loginPage(), {
        status: 401,
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...secHeaders }
      });
    }

    // Token valid — lekérjük az admin.html-t a saját origin-ből
    const adminUrl = new URL('/admin.html', url.origin);
    let adminHtml;
    try {
      const r = await fetch(adminUrl.toString());
      adminHtml = await r.text();
    } catch {
      return new Response('Could not load admin.html', { status: 500 });
    }

    // Token injektálás az oldalba
    const injected = adminHtml.replace(
      '</head>',
      `<script>sessionStorage.setItem('kapcs_gate_token',${JSON.stringify(token)});</script>\n</head>`
    );

    return new Response(injected, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...secHeaders }
    });
  }

  return new Response('Method Not Allowed', { status: 405 });
}
