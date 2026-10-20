# KAPCS — Vercel Telepítési Útmutató

## Admin védelem beállítása

Az `/api/admin-gate.js` Edge Function védi az admin panelt.
Ahhoz hogy működjön, a Vercel Dashboard-on be kell állítani 2 env változót:

### Lépések:
1. Vercel Dashboard → Project → **Settings** → **Environment Variables**
2. Add hozzá:

| Name | Value | Environment |
|------|-------|-------------|
| `KAPCS_ADMIN_PASSWORD` | `az_uj_jelszo_ide` | Production, Preview |
| `KAPCS_ADMIN_SECRET` | `egy_legalabb_32_karakter_random_string` | Production, Preview |

### Példa secret generálás:
```
openssl rand -hex 32
```
Vagy online: https://generate-secret.vercel.app/32

### Fontos:
- Ha **NEM** állítod be az env változókat, az alapértelmezett `admin2026` jelszó
  és gyenge secret lesz érvényes — **mindig add meg a saját értékeidet!**
- Az admin URL: `https://kapcs.vercel.app/admin` (vagy a te domainedet)
- Az admin.html közvetlenül már **NEM érhető el** — csak `/admin` útvonalon keresztül

## PWA ikonok

Helyezd el az `icons/` mappában:
- `icon-192.png` (192×192 px)
- `icon-512.png` (512×512 px)

Generálás: https://realfavicongenerator.net

## Fájl struktúra

```
ometv/
├── index.html          ← Főoldal
├── admin.html          ← Admin panel (védett, csak /admin URL-en át érhető el)
├── manifest.json       ← PWA manifest
├── sw.js               ← Service Worker
├── vercel.json         ← Vercel routing + security headers
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── api/
    ├── admin-gate.js   ← Edge Function — admin hitelesítés
    └── goretok/        ← GoreTok backend (serverless + Vercel KV)
        ├── register.js login.js session.js me.js like.js   (Edge)
        ├── posts.js                                         (Edge — GET list + POST create)
        ├── tags.js                                          (Edge — GET hashtag usage counts)
        ├── blob-upload-url.js                               (Node — Vercel Blob server upload via put())
        ├── admin/stats.js  admin/role.js                    (Edge — existing admin HMAC gate)
        └── _lib/           crypto / validate / kv / http helpers
```

---

# GoreTok backend (accounts + posts + likes + admin)

GoreTok (`/goretok`) is backed by Vercel serverless/edge functions under
`api/goretok/*` and a **Vercel KV** (Upstash Redis) store. Accounts use PBKDF2
password hashing; sessions are HMAC-SHA256 tokens with a 24h TTL (same scheme as
`admin-gate.js`). There is **no AI/NSFW recognition** — the shared MQTT moderation
console handles reports/bans/warnings exactly as before.

## 1. Add the Vercel KV store

1. Vercel Dashboard → Project → **Storage** → **Create** → **KV** (Upstash Redis).
2. **Connect** it to this project. Vercel then injects the KV connection env vars
   automatically in every environment:

| Name | Injected by | Notes |
|------|-------------|-------|
| `KV_REST_API_URL` | Vercel KV link | REST endpoint |
| `KV_REST_API_TOKEN` | Vercel KV link | read/write token |
| `KV_REST_API_READ_ONLY_TOKEN` | Vercel KV link | read-only token |

No local fallback — in production these must be present (fail loudly if missing).

## 1b. Add the Vercel Blob store (for file upload)

1. Vercel Dashboard → Project → **Storage** → **Create** → **Blob**. Choose
   **Public** access (a public video site serves clips by direct URL — a
   private store rejects `access:'public'` uploads and the access mode cannot
   be changed after creation). **Connect** it to this project and enable the
   read-write token env var. Vercel then injects the Blob token:

| Name | Injected by | Notes |
|------|-------------|-------|
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob link | read/write token `@vercel/blob`'s `put()` uses to upload |

File upload (pick/drop a video) **requires** a linked **public** Blob store.
The server-upload route (`put()` on the Node runtime) caps at **~4.4 MB** per
file (Vercel's serverless request-body limit); **bigger clips use the video-URL
field**, which works without a Blob store. Never hardcode the token —
`@vercel/blob` reads it from the environment.

## 2. Add the GoreTok auth secret

| Name | Value | Environment |
|------|-------|-------------|
| `GORETOK_AUTH_SECRET` | `>= 32 character random string` | Production, Preview |

Generate: `openssl rand -hex 32`. A local-dev fallback exists in code but is
flagged just like `admin-gate.js`'s default — **always set your own value**.

`KAPCS_ADMIN_SECRET` (above) is **reused** by `admin/stats` and `admin/role` to
verify the existing admin gate token. No new admin secret is needed.

## 3. Routes

| Method | Route | Runtime | Auth |
|--------|-------|---------|------|
| POST | `/api/goretok/register` | Edge | — (rate-limited) |
| POST | `/api/goretok/login` | Edge | — (rate-limited) |
| GET | `/api/goretok/session` | Edge | Bearer session token |
| GET | `/api/goretok/me` | Edge | Bearer session token |
| GET | `/api/goretok/posts` | Edge | public (feed) |
| POST | `/api/goretok/posts` | Edge | Bearer session token |
| GET | `/api/goretok/tags` | Edge | public (hashtag usage counts) |
| POST | `/api/goretok/blob-upload-url` | Node | Bearer session token (raw file body, server upload via put()) |
| POST | `/api/goretok/like` | Edge | Bearer session token |
| GET | `/api/goretok/admin/stats` | Edge | Admin gate HMAC token |
| POST | `/api/goretok/admin/role` | Edge | Admin gate HMAC token |

With an empty KV the feed shows a tasteful empty state (no demo clips), and
`/api/goretok/tags` returns `[]` (no seeded hashtags). A post can be created from
a **picked/dropped video file** (uploaded to **Vercel Blob**, needs a linked Blob
store) **or** a **direct video URL** (works without a Blob store). The new routes
live under the existing `/api/goretok/(.*)` header rule in `vercel.json`, so **no
rewrite/header changes are needed** there.
